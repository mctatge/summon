import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createDesktopTeaching} from '../src/main/desktop-teaching.mjs';

const bundleId='com.example.catalog';
const done={status:'clarify',kind:'activate',bundleId:'',controlId:'',value:'',evidence:'',reason:'Show the next step.'};
async function fixture(t,{screenRecording=false,reason,existingDir,request}={}){
  const dataDir=existingDir??await fs.mkdtemp(path.join(os.tmpdir(),'summon-teaching-options-'));
  const calls=[],reasons=[],localModel={reasonStructured:async()=>({raw:done})};
  const bridge={close:async()=>{},request:async(method,input={})=>{
    calls.push({method,input});
    const override=request?.(method,input);if(override!==undefined)return override;
    if(method==='permissions')return {accessibility:true,inputMonitoring:true,screenRecording};
    if(method==='apps')return [{bundleId,name:'Catalog'}];
    return {};
  }};
  const service=await createDesktopTeaching({dataDir,bridge,localModel,reason:async(kind,input,options)=>{
    reasons.push({kind,input,options});return reason?reason(kind,input,options):done;
  }});
  t.after(async()=>{await service.close();if(!existingDir)await fs.rm(dataDir,{recursive:true,force:true});});
  await service.action('connect');await service.action('apps',{bundleIds:[bundleId]});
  return {service,calls,reasons,localModel,dataDir};
}
test('engine selection is explicit, reaches reasoning and persists without enabling visual capture',async t=>{
  const f=await fixture(t);
  assert.equal((await f.service.read()).desktop.engine,'codex');
  await f.service.action('engine',{engine:'local'});
  await f.service.action('attempt',{intent:'Choose an item'});
  assert.equal(f.reasons[0].options.engine,'local');assert.equal(f.reasons[0].options.localModel,f.localModel);
  const stored=JSON.parse(await fs.readFile(path.join(f.dataDir,'desktop-teaching-engine.json'),'utf8'));
  assert.deepEqual(stored,{engine:'local'});
  const reloaded=await fixture(t,{existingDir:f.dataDir});
  assert.equal((await reloaded.service.read()).desktop.engine,'local');
  assert.equal((await reloaded.service.read()).desktop.visualReading,false);
  assert.equal(f.calls.some(call=>call.method==='request-screen-recording'),false);
});
test('a saved engine that cannot be parsed cannot silently choose a cloud engine',async t=>{
  const f=await fixture(t);
  await fs.writeFile(path.join(f.dataDir,'desktop-teaching-engine.json'),'broken JSON');
  const reloaded=await fixture(t,{existingDir:f.dataDir});
  assert.equal((await reloaded.service.read()).desktop.engine,'local');
  await reloaded.service.action('attempt',{intent:'Choose an item'});
  assert.equal(reloaded.reasons[0].options.engine,'local');
});
test('missing local reasoning stops the attempt without switching providers or acting',async t=>{
  const f=await fixture(t,{reason:(_kind,_input,options)=>{assert.equal(options.engine,'local');throw new Error('Local unavailable; no cloud fallback.');}});
  await f.service.action('engine',{engine:'local'});
  await assert.rejects(f.service.action('attempt',{intent:'Choose an item'}),/Local unavailable/);
  assert.equal(f.reasons.length,1);assert.equal(f.calls.some(call=>['activate','execute'].includes(call.method)),false);
  assert.equal((await f.service.read()).desktop.engine,'local');
});
test('visual opt-in never prompts and absent permission stops before capture or reasoning',async t=>{
  const f=await fixture(t);
  await f.service.action('visual-reading',{enabled:true});
  assert.equal((await f.service.read()).desktop.visualReading,true);
  assert.equal(f.calls.some(call=>call.method==='request-screen-recording'),false);
  await assert.rejects(f.service.action('attempt',{intent:'Choose an item'}),/Screen Recording/);
  assert.equal(f.reasons.length,0);assert.equal(f.calls.some(call=>['configure','snapshot','activate','execute'].includes(call.method)),false);
  await f.service.action('screen-permission');
  assert.equal(f.calls.filter(call=>call.method==='request-screen-recording').length,1);
});
test('visual reading only reaches explicitly configured task scope and resets on restart',async t=>{
  const f=await fixture(t,{screenRecording:true});
  await f.service.action('visual-reading',{enabled:true});await f.service.action('attempt',{intent:'Choose an item'});
  assert.deepEqual(f.calls.find(call=>call.method==='configure').input,{allowedApps:[bundleId],excludedApps:[],visualReading:true});
  const reloaded=await fixture(t,{existingDir:f.dataDir,screenRecording:true});
  assert.equal((await reloaded.service.read()).desktop.visualReading,false,'A saved OS grant never re-enables capture at startup');
  await f.service.action('visual-reading',{enabled:false});
  assert.equal((await f.service.read()).desktop.visualReading,false);
  await f.service.action('attempt',{intent:'Choose another item'});
  assert.equal(f.calls.filter(call=>call.method==='configure').at(-1).input.visualReading,false);
});
test('engine and capture settings cannot change while next-step reasoning is pending',async t=>{
  let release;
  const f=await fixture(t,{reason:()=>new Promise(resolve=>{release=resolve;})});
  const pending=f.service.action('attempt',{intent:'Choose an item'});
  while(!release)await new Promise(resolve=>setImmediate(resolve));
  await assert.rejects(f.service.action('engine',{engine:'claude'}),/Stop teaching/);
  // A rejected preference action must not make an in-flight task look idle.
  assert.equal((await f.service.read()).phase,'running');
  await assert.rejects(f.service.action('visual-reading',{enabled:true}),/Stop teaching/);
  await assert.rejects(f.service.action('engine',{engine:'claude'}),/Stop teaching/);
  await f.service.action('cancel');release(done);await pending;
  assert.equal((await f.service.read()).desktop.engine,'codex');
});
test('a new voice task cannot unlock the active task or change its selected provider',async t=>{
  let release;
  const f=await fixture(t,{reason:()=>new Promise(resolve=>{release=resolve;})});
  await f.service.action('engine',{engine:'local'});
  const pending=f.service.action('attempt',{intent:'Choose an item'});
  while(!release)await new Promise(resolve=>setImmediate(resolve));
  try{
    for(const request of ['try this task choose another item','do this task open another item']){
      const reply=await f.service.command(request);
      assert.match(reply.message,/working on this task/);
      await new Promise(resolve=>setImmediate(resolve));
      assert.equal((await f.service.read()).phase,'running');
      await assert.rejects(f.service.action('engine',{engine:'claude'}),/Stop teaching/);
      assert.equal((await f.service.read()).desktop.engine,'local');
    }
    assert.equal(f.reasons.length,1);
    assert.equal(f.reasons[0].options.signal.aborted,false);
  }finally{release(done);await pending;}
});
test('changing OCR consent serializes voice and button requests until native state is cleared',async t=>{
  let release,hold=false;
  const f=await fixture(t,{screenRecording:true,request:method=>method==='cancel'&&hold?new Promise(resolve=>{release=resolve;}):undefined});
  hold=true;const changing=f.service.action('visual-reading',{enabled:true});
  while(!release)await new Promise(resolve=>setImmediate(resolve));
  const reply=await f.service.command('try this task choose an item');
  assert.match(reply.message,/saving your reasoning choice/);
  await assert.rejects(f.service.action('attempt',{intent:'Choose an item'}),/saving/);
  assert.equal(f.reasons.length,0);
  release({});await changing;hold=false;
  await f.service.action('attempt',{intent:'Choose an item'});
  assert.equal(f.calls.find(call=>call.method==='configure').input.visualReading,true);
});
test('Stop aborts only the active reasoning request and a retry receives a fresh signal',async t=>{
  let firstSignal;
  const f=await fixture(t,{reason:(_kind,_input,{signal})=>{
    if(firstSignal){assert.notEqual(signal,firstSignal);assert.equal(signal.aborted,false);return done;}
    firstSignal=signal;
    return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('Local task cancelled.')),{once:true}));
  }});
  await f.service.action('engine',{engine:'local'});
  const first=f.service.action('attempt',{intent:'Choose an item'});
  const rejected=assert.rejects(first,/cancelled/);
  while(!firstSignal)await new Promise(resolve=>setImmediate(resolve));
  await f.service.action('cancel');await rejected;
  assert.equal(firstSignal.aborted,true);
  await f.service.action('attempt',{intent:'Choose another item'});
  assert.equal(f.reasons.length,2);
});
test('different controls with unchanged text are not mistaken for a repeated stalled action',async t=>{
  const surface={kind:'desktop',bundleId,app:'Catalog',title:'Options'};
  const observation={surface,revision:'fresh',text:'Choose options',controls:['First option','Second option'].map((name,index)=>({id:`c${index}`,role:'AXCheckBox',name,editable:false,actions:['click']}))};
  let step=0;
  const f=await fixture(t,{request:method=>['activate','snapshot'].includes(method)?observation:method==='execute'?{before:observation,after:observation}:undefined,reason:()=>[
    {status:'act',kind:'activate',bundleId,controlId:'',value:'',evidence:'',reason:'Open options.'},
    {status:'act',kind:'click',bundleId,controlId:'c0',value:'',evidence:'',reason:'Choose the first option.'},
    {status:'act',kind:'click',bundleId,controlId:'c1',value:'',evidence:'',reason:'Choose the second option.'},
    done,
  ][step++]});
  const result=await f.service.action('attempt',{intent:'Choose both options'});
  assert.equal(f.reasons.length,4);assert.equal(result.message,done.reason);
});
