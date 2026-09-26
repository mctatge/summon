import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createDesktopTeaching} from '../src/main/desktop-teaching.mjs';
const id='com.example.catalog';
const surface={kind:'desktop',bundleId:id,app:'Catalog',title:'Items'};
const controls=[{id:'input',role:'AXTextField',name:'Item',editable:true,actions:['fill']},{id:'choose',role:'AXButton',name:'Choose',editable:false,actions:['click']}];
const observation=(text,revision='r1')=>({surface,revision,text,controls});
async function setup(t,reason){
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'summon-attempt-')),calls=[],reasonCalls=[];let value='',screen='Ready',revision=1;
  const bridge={close:async()=>{},request:async(method,params={})=>{
    calls.push({method,params});
    if(method==='permissions')return {accessibility:true,inputMonitoring:true};
    if(method==='apps')return [{bundleId:id,name:'Catalog'}];
    if(method==='snapshot'||method==='activate')return observation(screen,`r${revision}`);
    if(method==='finish')return {events:[{kind:'fill',surface,target:{role:'AXTextField',name:'Item'},value:'Orion',before:observation('Ready'),after:observation('Orion','r2')},{kind:'click',surface,target:{role:'AXButton',name:'Choose'},before:observation('Orion','r2'),after:observation('Selected Orion','r3')}]};
    if(method==='execute'){const before=observation(screen,`r${revision}`);if(params.kind==='fill'){value=params.value;screen=`Search ${value}`;}else screen=`Selected ${value}`;return {before,after:observation(screen,`r${++revision}`)};}
    return {};
  }};
  const service=await createDesktopTeaching({dataDir,bridge,reason:async(kind,input)=>{reasonCalls.push({kind,input});return reason(kind,input);}});
  t.after(async()=>{await service.close();await fs.rm(dataDir,{recursive:true,force:true});});
  await service.action('connect');await service.action('apps',{bundleIds:[id]});return {service,calls,reasonCalls};
}
const action=(kind,controlId='',value='')=>({status:'act',kind,bundleId:id,controlId,value,evidence:'',reason:`Use ${kind}`});
test('general task reasoning uses current screens, saved lessons and a grounded completed result',async t=>{
  let step=0;
  const f=await setup(t,(kind,input)=>{
    if(kind==='learn')return {name:'Choose an item',summary:'Search and choose the named item.',parameters:[{name:'item',label:'Item',example:'Orion',primary:true}],verificationText:'Selected Orion'};
    assert.equal(kind,'next');assert.equal(input.lessons[0].name,'Choose an item');assert.ok(!JSON.stringify(input.lessons).includes('before'),'Historical raw screen text is not needed for recall');
    return [action('activate'),action('fill','input','Vega'),action('click','choose'),{status:'done',kind:'click',bundleId:id,controlId:'',value:'',evidence:'Selected Vega',reason:'The requested item is selected.'}][step++];
  });
  await f.service.action('start',{intent:'Choose the item I name'});await f.service.action('finish');await f.service.action('save');
  const result=await f.service.action('attempt',{intent:'Choose Vega'});
  assert.equal(result.lastRun.verified,true);assert.match(result.message,/Selected Vega/);
  assert.equal(f.reasonCalls.filter(call=>call.kind==='next').length,4);
  assert.equal(f.reasonCalls.at(-1).input.observation.text,'Selected Vega');
  assert.deepEqual(f.calls.filter(call=>call.method==='execute').map(call=>call.params.kind),['fill','click']);
});
test('an invented app or control from next-step reasoning cannot reach native execution',async t=>{
  const f=await setup(t,()=>({...action('activate'),bundleId:'com.unselected.app'}));
  await assert.rejects(f.service.action('attempt',{intent:'Choose Vega'}),/outside the selected/);
  assert.equal(f.calls.some(call=>call.method==='activate'||call.method==='execute'),false);
});
test('correction cancels a general attempt while its next-step reasoning is pending',async t=>{
  let release;const pending=new Promise(resolve=>{release=resolve;});
  const f=await setup(t,()=>pending);
  const attempt=f.service.action('attempt',{intent:'Choose Vega'});
  for(let i=0;i<20&&!f.reasonCalls.length;i++)await new Promise(resolve=>setImmediate(resolve));
  await f.service.command('no, like this');release(action('activate'));await attempt;
  assert.equal((await f.service.read()).phase,'recording');assert.equal(f.calls.some(call=>call.method==='activate'||call.method==='execute'),false);
});
test('repeated activation stops after two unchanged steps even with fresh revision IDs',async t=>{
  const f=await setup(t,()=>action('activate'));const result=await f.service.action('attempt',{intent:'Choose Vega'});
  assert.equal(f.reasonCalls.length,3);assert.match(result.message,/same step left the app unchanged twice/);assert.equal(result.lastRun,null);
});
test('changing screens still stop at the action budget when the planner never finishes',async t=>{
  let step=0;
  const f=await setup(t,()=>step++===0?action('activate'):action('fill','input',`item ${step}`));
  const result=await f.service.action('attempt',{intent:'Choose Vega'});
  assert.equal(f.reasonCalls.length,24);assert.match(result.message,/24-step limit/);assert.equal(result.lastRun,null);
});
test('idempotent repeated fills stop without exhausting the task budget',async t=>{
  let step=0;
  const f=await setup(t,()=>step++===0?action('activate'):action('fill','input','Vega'));
  const result=await f.service.action('attempt',{intent:'Choose Vega'});
  assert.equal(f.calls.filter(call=>call.method==='execute').length,3);
  assert.match(result.message,/same step left the app unchanged twice/);
});
