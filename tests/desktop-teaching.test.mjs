import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createDesktopTeaching} from '../src/main/desktop-teaching.mjs';
import {createTeaching} from '../src/main/teaching.mjs';
import {reasonAboutDesktopTeaching} from '../src/main/desktop-teaching-engine.mjs';

const A='com.example.catalog',B='com.example.details';
const surface=id=>({kind:'desktop',bundleId:id,app:id===A?'Catalog':'Details',title:'Demo'});
const obs=(id,content='Ready',controls=[])=>({surface:surface(id),revision:'r1',text:content,controls});
const search={id:'query',role:'AXTextField',name:'Find item',identifier:'query',editable:true,actions:['fill']};
const open={id:'open',role:'AXButton',name:'Open item',identifier:'open',editable:false,actions:['click']};
const analysis=()=>({name:'Find and inspect an item',summary:'Search the catalog, then open the item in Details.',parameters:[{name:'item',label:'Item',example:'Red chair',primary:true}],verificationText:'Opened Red chair'});
const demo=()=>({events:[
  {kind:'fill',surface:surface(A),target:{role:search.role,name:search.name,identifier:search.identifier},value:'Red chair',before:obs(A,'Ready'),after:obs(A,'Results for Red chair')},
  {kind:'activate',surface:surface(B),before:obs(A,'Results for Red chair'),after:obs(B,'Ready')},
  {kind:'fill',surface:surface(B),target:{role:search.role,name:search.name,identifier:search.identifier},value:'Red chair',before:obs(B,'Ready'),after:obs(B,'Red chair')},
  {kind:'click',surface:surface(B),target:{role:open.role,name:open.name,identifier:open.identifier},before:obs(B,'Red chair'),after:obs(B,'Opened Red chair')},
]});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {resolve,reject,promise};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(t,options={}){
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'summon-desktop-teaching-')),calls=[],reasons=[];
  let value='Red chair';const permissionState={accessibility:true,inputMonitoring:true};
  const bridge={close:async()=>{},request:async(method,input={})=>{
    calls.push({method,input:structuredClone(input)});
    if(options.request){const overridden=options.request(method,input);if(overridden!==undefined)return overridden;}
    if(method==='permissions')return {...permissionState};
    if(method==='apps')return [{bundleId:A,name:'Catalog'},{bundleId:B,name:'Details'}];
    if(method==='finish')return demo();
    if(method==='snapshot'||method==='activate')return obs(input.bundleId,'Ready',[search,open]);
    if(method==='execute'){
      const before=obs(input.bundleId,'Ready');
      if(input.kind==='fill')value=input.value;
      return {before,after:obs(input.bundleId,input.kind==='click'?`Opened ${value}`:`Results for ${value}`)};
    }
    return {ok:true};
  }};
  const reason=async(kind,input)=>{
    reasons.push({kind,input});if(options.reason){const overridden=options.reason(kind,input);if(overridden!==undefined)return overridden;}
    if(kind==='learn')return analysis();
    if(kind==='bind')return {understood:true,question:'',values:[{name:'item',value:input.request}]};
    if(kind==='resolve')return {status:'act',controlId:input.observation.controls[0].id,reason:'The search field has a new label.'};
    return {verified:false,evidence:'',reason:'No proof'};
  };
  const service=await createDesktopTeaching({dataDir,bridge,reason,excludedApps:options.excludedApps,recordingStatusMs:options.recordingStatusMs});
  t.after(async()=>{await service.close();await fs.rm(dataDir,{recursive:true,force:true});});
  await service.action('connect');await service.action('apps',{bundleIds:[A,B]});
  return {service,calls,reasons,permissionState};
}
async function teach(service){await service.action('start',{intent:'Find the item I name and open it in Details.'});await service.action('finish');assert.equal((await service.read()).procedures.length,0);const saved=await service.action('save');return saved.activeId;}
async function settle(service){for(let i=0;i<100;i++){const view=await service.read();if(!['running','reviewing'].includes(view.phase))return view;await tick();}assert.fail('Did not settle');}

test('a demonstration spans two apps and reuses a new item with fresh controls',async t=>{
  const f=await fixture(t),id=await teach(f.service);await f.service.command('Blue desk');const result=await settle(f.service);
  assert.equal(result.lastRun.id,id);assert.equal(result.lastRun.verified,true);
  const actions=f.calls.filter(call=>call.method==='execute');assert.equal(actions.length,3);
  assert.deepEqual(actions.filter(call=>call.input.kind==='fill').map(call=>call.input.value),['Blue desk','Blue desk']);
  assert.deepEqual(actions.map(call=>call.input.bundleId),[A,B,B]);
  assert.equal(f.reasons.some(item=>item.kind==='resolve'),false,'Stable semantic targets need no extra model request');
});

test('saved replay uses each activation observation without a duplicate snapshot',async t=>{
  let sequence=0;const latest=new Map();
  const f=await fixture(t,{request:(method,input)=>{
    if(method==='activate'){
      const revision=`activation-${++sequence}`;
      const observation={...obs(input.bundleId,'Ready',[{...search,id:`query-${sequence}`},{...open,id:`open-${sequence}`}]),revision};
      latest.set(input.bundleId,observation);return observation;
    }
    if(method==='snapshot')throw new Error('Saved replay requested a duplicate observation.');
    if(method==='execute'){
      const observed=latest.get(input.bundleId);
      assert.equal(input.revision,observed.revision);
      assert.ok(observed.controls.some(control=>control.id===input.controlId));
    }
  }});
  const id=await teach(f.service),result=await f.service.action('run',{id,values:{item:'Blue desk'}});
  assert.equal(result.lastRun.verified,true);
  assert.equal(f.calls.filter(call=>call.method==='activate').length,4);
  assert.equal(f.calls.filter(call=>call.method==='execute').length,3);
  assert.equal(f.calls.filter(call=>call.method==='snapshot').length,0);
  assert.deepEqual(f.reasons.map(call=>call.kind),['learn']);
});

test('cancelling a pending replay activation discards its observation before any action',async t=>{
  const pending=deferred();
  const f=await fixture(t,{request:method=>method==='activate'?pending.promise:undefined});
  const id=await teach(f.service),running=f.service.action('run',{id,values:{item:'Blue desk'}});
  for(let count=0;count<20&&!f.calls.some(call=>call.method==='activate');count++)await tick();
  assert.ok(f.calls.some(call=>call.method==='activate'));
  await f.service.action('cancel');
  pending.resolve(obs(A,'Ready',[search,open]));await running;
  assert.equal(f.calls.some(call=>call.method==='execute'||call.method==='snapshot'),false);
  assert.deepEqual(f.reasons.map(call=>call.kind),['learn']);
  const state=await f.service.read();assert.equal(state.phase,'idle');assert.equal(state.lastRun,null);
});

test('recording feedback distinguishes waiting for a selected app and a stopped native capture',async t=>{
  let state={recording:true,activeInScope:false,eventCount:0};
  const f=await fixture(t,{request:method=>method==='status'?state:undefined});
  await f.service.action('start',{intent:'Find the item'});
  assert.match((await f.service.read()).message,/Bring a selected app to the front/);
  state={recording:true,activeInScope:true,eventCount:3};
  assert.match((await f.service.read()).message,/3 recorded events/);
  state={recording:false,failure:'The selected app could not be inspected.',eventCount:3};
  const stopped=await f.service.read();assert.equal(stopped.phase,'error');assert.match(stopped.message,/could not be inspected/);
});

test('recording status updates the offscreen banner without panel reads and stops polling after failure',async t=>{
  let state={recording:true,activeInScope:true,eventCount:1},queries=0;
  const f=await fixture(t,{recordingStatusMs:10,request:method=>{
    if(method==='status'){queries++;return state;}
  }});
  await f.service.action('start',{intent:'Find the item'});
  state={recording:false,failure:'Capture lost permission.',eventCount:1};
  for(let count=0;count<40&&f.service.brief().phase==='recording';count++)await delay(5);
  assert.equal(f.service.brief().phase,'error');
  assert.match(f.service.brief().message,/lost permission/);
  const stoppedAt=queries;await delay(35);
  assert.equal(queries,stoppedAt,'A failed capture must not keep polling');
});

test('status polling coalesces slow reads and a cancelled poll cannot revive recording',async t=>{
  const pending=deferred();let queries=0;
  const f=await fixture(t,{recordingStatusMs:10,request:method=>{
    if(method==='status'){queries++;return pending.promise;}
  }});
  await f.service.command('teach find the item');
  for(let count=0;count<40&&!queries;count++)await delay(5);
  assert.equal(queries,1);
  const reads=[f.service.read(),f.service.read()];await delay(35);
  assert.equal(queries,1,'Timer and panel reads share one pending native request');
  await f.service.action('cancel');
  pending.resolve({recording:true,activeInScope:true,eventCount:20});await Promise.all(reads);
  await delay(35);
  assert.equal(f.service.brief().phase,'idle');assert.match(f.service.brief().message,/Teaching stopped/);
  assert.equal(queries,1,'Cancellation clears the timer and prevents late rescheduling');
});

test('finishing or closing a demonstration clears its independent status timer',async t=>{
  for(const operation of ['finish','close']){
    let queries=0;const f=await fixture(t,{recordingStatusMs:10,request:method=>{
      if(method==='status'){queries++;return {recording:true,activeInScope:true,eventCount:2};}
    }});
    await f.service.action('start',{intent:'Find the item'});
    if(operation==='close')await f.service.close();else await f.service.action('finish');
    const stoppedAt=queries;await delay(35);
    assert.equal(queries,stoppedAt,`${operation} must clear independent status polling`);
  }
});

test('an empty or activation-only recording never reaches model learning',async t=>{
  const f=await fixture(t,{request:method=>method==='finish'?{events:[]}:undefined});
  await f.service.action('start',{intent:'Find the item'});
  await assert.rejects(f.service.action('finish'),/No demonstration actions were captured/);
  assert.equal(f.reasons.length,0);
});

test('changed interface labels resolve against current observed IDs rather than replaying coordinates',async t=>{
  const f=await fixture(t,{request:(method,input)=>method==='activate'?obs(input.bundleId,'Ready',[{...search,id:'new-query',name:'Search catalog',identifier:'new-id'},open]):undefined});
  const id=await teach(f.service);await f.service.action('run',{id,values:{item:'Blue desk'}});
  assert.equal(f.reasons.filter(item=>item.kind==='resolve').length,2);
  assert.equal(f.calls.find(call=>call.method==='execute').input.controlId,'new-query');
});

test('invented control IDs stop before any native action',async t=>{
  const f=await fixture(t,{request:(method,input)=>method==='activate'?obs(input.bundleId,'Ready',[]):undefined,reason:kind=>kind==='resolve'?{status:'act',controlId:'invented',reason:'guess'}:undefined});
  const id=await teach(f.service);await assert.rejects(f.service.action('run',{id,values:{item:'Blue desk'}}),/control is not available/);
  assert.equal(f.calls.filter(call=>call.method==='execute').length,0);
});

test('stop while reasoning discards the result and prevents execution',async t=>{
  const pending=deferred();const f=await fixture(t,{reason:kind=>kind==='bind'?pending.promise:undefined});await teach(f.service);
  await f.service.command('Blue desk');await f.service.command('stop');pending.resolve({understood:true,question:'',values:[{name:'item',value:'Blue desk'}]});await tick();await tick();
  assert.equal(f.calls.filter(call=>call.method==='execute').length,0);assert.equal((await f.service.read()).activeId,null);
});

test('correction interrupts execution and arms a new demonstration without continuing old steps',async t=>{
  const pending=deferred();let delay=true;
  const f=await fixture(t,{request:method=>method==='execute'&&delay?pending.promise:undefined}),id=await teach(f.service);
  const running=f.service.action('run',{id,values:{item:'Blue desk'}});
  for(let i=0;i<20&&!f.calls.some(call=>call.method==='execute');i++)await tick();
  await f.service.command('no no no, like this');delay=false;
  pending.resolve({before:obs(A),after:obs(A,'Results for Blue desk')});await running;
  assert.equal((await f.service.read()).phase,'recording');assert.equal(f.calls.filter(call=>call.method==='execute').length,1);
});

test('permissions and privacy exclusions are enforced at recording and reuse',async t=>{
  let excluded=[];const f=await fixture(t,{excludedApps:()=>excluded});
  f.permissionState.inputMonitoring=false;await assert.rejects(f.service.action('start',{intent:'Search an item'}),/Input Monitoring/);
  assert.equal(f.calls.some(call=>call.method==='begin'),false);f.permissionState.inputMonitoring=true;
  const id=await teach(f.service);excluded=[A];await assert.rejects(f.service.action('run',{id,values:{item:'Blue desk'}}),/excluded/);
  assert.equal(f.calls.some(call=>call.method==='execute'),false);
});

test('ungrounded model verification stays unverified',async t=>{
  const f=await fixture(t,{reason:kind=>kind==='learn'?{...analysis(),verificationText:''}:kind==='verify'?{verified:true,evidence:'Imaginary result Blue desk',reason:'looks good'}:undefined});
  const id=await teach(f.service),result=await f.service.action('run',{id,values:{item:'Blue desk'}});assert.equal(result.lastRun.verified,false);
  assert.equal((await f.service.action('confirm')).lastRun.confirmed,true);
});

test('facade routes one active teaching mode and refuses mode switches during capture',async()=>{
  const calls=[];let desktopPhase='idle';const adapter=mode=>({brief:()=>({phase:mode==='desktop'?desktopPhase:'idle'}),read:async()=>({phase:'idle',procedures:[]}),action:async name=>calls.push(`${mode}:${name}`),cancel:async()=>calls.push(`${mode}:cancel`),close:async()=>{},handles:()=>true,command:async()=>mode,connectionChanged:()=>{}});
  const service=createTeaching({desktop:adapter('desktop'),browser:adapter('browser')});
  assert.equal((await service.read()).mode,'desktop');desktopPhase='recording';await assert.rejects(service.action('mode',{mode:'browser'}),/Stop/);
  desktopPhase='idle';await service.action('mode',{mode:'browser'});assert.equal(await service.command('teach'),'browser');assert.deepEqual(calls,['desktop:cancel','browser:connect']);
});

test('refreshing the app list during capture preserves the explicit recording scope',async t=>{
  let appClosed=false;
  const f=await fixture(t,{request:method=>method==='apps'&&appClosed?[{bundleId:A,name:'Catalog'}]:undefined});
  await f.service.action('start',{intent:'Find the item across Catalog and Details.'});
  appClosed=true;
  const refreshed=await f.service.action('refresh-apps');
  assert.deepEqual(refreshed.desktop.apps.map(app=>app.bundleId),[A]);
  assert.deepEqual(refreshed.desktop.selectedApps,[A,B],'A closed app remains part of this in-flight recording scope');
  const reviewed=await f.service.action('finish');
  assert.equal(reviewed.phase,'proposal');
  assert.deepEqual(reviewed.proposal.apps.map(app=>app.bundleId),[A,B]);
  assert.deepEqual(f.reasons.find(call=>call.kind==='learn').input.allowedApps,[A,B]);
});

test('cancelled learning cannot publish a late proposal or replace the stopped state with a late error',async t=>{
  for(const reject of [false,true]){
    const pending=deferred(),f=await fixture(t,{reason:kind=>kind==='learn'?pending.promise:undefined});
    await f.service.action('start',{intent:'Find the requested item'});
    await f.service.command("that's it");
    for(let count=0;count<20&&!f.reasons.some(call=>call.kind==='learn');count++)await tick();
    assert.equal((await f.service.read()).phase,'reviewing');
    await f.service.command('stop');
    if(reject)pending.reject(new Error('Late model failure'));else pending.resolve(analysis());
    await tick();await tick();
    const state=await f.service.read();
    assert.equal(state.phase,'idle');assert.equal(state.proposal,null);assert.deepEqual(state.procedures,[]);
    assert.doesNotMatch(state.message,/Late model/);
  }
});

test('cancelled control resolution cannot dispatch a native action or change the stopped state',async t=>{
  for(const reject of [false,true]){
    const pending=deferred(),f=await fixture(t,{request:(method,input)=>method==='activate'?obs(input.bundleId,'Ready',[{...search,name:'Changed search label'}]):undefined,reason:kind=>kind==='resolve'?pending.promise:undefined});
    const id=await teach(f.service),running=f.service.action('run',{id,values:{item:'Blue desk'}});
    for(let count=0;count<20&&!f.reasons.some(call=>call.kind==='resolve');count++)await tick();
    assert.ok(f.reasons.some(call=>call.kind==='resolve'));
    await f.service.command('stop');
    if(reject){pending.reject(new Error('Late resolver failure'));await assert.rejects(running,/Late resolver/);}
    else {pending.resolve({status:'act',controlId:search.id,reason:'Found it'});await running;}
    assert.equal(f.calls.some(call=>call.method==='execute'),false);
    assert.equal((await f.service.read()).phase,'idle');
  }
});

test('a reused row identifier never overrides the requested item name',async t=>{
  const original=demo();original.events.at(-1).target={role:'AXButton',name:'Red chair',identifier:'reused-row'};
  const wrong={...open,id:'old-row',name:'Red chair',identifier:'reused-row'},correct={...open,id:'new-row',name:'Blue desk',identifier:'new-row'};
  const f=await fixture(t,{request:(method,input)=>method==='finish'?original:method==='activate'?obs(input.bundleId,'Ready',[search,wrong,correct]):undefined,reason:kind=>kind==='resolve'?{status:'act',controlId:'new-row',reason:'The requested item is Blue desk.'}:undefined});
  const id=await teach(f.service);await f.service.action('run',{id,values:{item:'Blue desk'}});
  const clicks=f.calls.filter(call=>call.method==='execute'&&call.input.kind==='click');
  assert.equal(clicks.length,1);assert.equal(clicks[0].input.controlId,'new-row');
  const resolved=f.reasons.filter(call=>call.kind==='resolve');assert.equal(resolved.length,1);
  assert.equal(resolved[0].input.step.target.name,'Blue desk');
});

test('privacy exclusions added while a resolver is pending stop the next native action',async t=>{
  let excluded=[];const pending=deferred();
  const f=await fixture(t,{excludedApps:()=>excluded,request:(method,input)=>method==='activate'?obs(input.bundleId,'Ready',[{...search,name:'Changed search label'}]):undefined,reason:kind=>kind==='resolve'?pending.promise:undefined});
  const id=await teach(f.service),running=f.service.action('run',{id,values:{item:'Blue desk'}});
  for(let count=0;count<20&&!f.reasons.some(call=>call.kind==='resolve');count++)await tick();
  excluded=[A];pending.resolve({status:'act',controlId:search.id,reason:'Found it'});
  await assert.rejects(running,/excluded/);
  assert.equal(f.calls.some(call=>call.method==='execute'),false);
});

test('an activation observation from another app is rejected before reasoning about it',async t=>{
  const f=await fixture(t,{request:method=>method==='activate'?obs('com.example.private','Private content',[{...search,name:'Other field'}]):undefined});
  const id=await teach(f.service);await assert.rejects(f.service.action('run',{id,values:{item:'Blue desk'}}),/app|scope|allowed/i);
  assert.equal(f.reasons.some(call=>call.kind==='resolve'),false);
  assert.equal(f.calls.some(call=>call.method==='execute'),false);
});

test('facade reserves a mode switch so new work cannot start in a hidden adapter',async()=>{
  const cancelling=deferred(),calls=[];
  const adapter=mode=>({brief:()=>({phase:'idle'}),read:async()=>({phase:'idle',procedures:[],source:mode}),action:async name=>calls.push(`${mode}:${name}`),cancel:async()=>{calls.push(`${mode}:cancel`);if(mode==='desktop')await cancelling.promise;},close:async()=>{},handles:()=>true,command:async()=>{calls.push(`${mode}:command`);return mode;},connectionChanged:()=>{}});
  const service=createTeaching({desktop:adapter('desktop'),browser:adapter('browser')});
  const switching=service.action('mode',{mode:'browser'});
  await tick();
  await assert.rejects(service.action('start',{intent:'Do not start in the hidden app'}),/switch|changing|mode/i);
  assert.equal(calls.includes('desktop:start'),false);
  cancelling.resolve();await switching;
  assert.equal((await service.read()).mode,'browser');
});

test('facade read never labels a delayed desktop snapshot as browser state',async()=>{
  const reading=deferred();let delay=true;
  const adapter=mode=>({brief:()=>({phase:'idle'}),read:async()=>mode==='desktop'&&delay?reading.promise:{phase:'idle',procedures:[],source:mode},action:async()=>{},cancel:async()=>{},close:async()=>{},handles:()=>false,command:async()=>null,connectionChanged:()=>{}});
  const service=createTeaching({desktop:adapter('desktop'),browser:adapter('browser')});
  const pending=service.read();await service.action('mode',{mode:'browser'});delay=false;
  reading.resolve({phase:'idle',procedures:[],source:'desktop'});
  const result=await pending;
  assert.equal(result.mode,result.source,'Mode and adapter data must come from the same read');
});

test('an active desktop procedure receives ordinary requests instead of letting built-in find commands steal them',async t=>{
  const f=await fixture(t);await teach(f.service);
  assert.equal(f.service.handles('find the Blue desk'),true);
  await f.service.command('stop');
  assert.equal(f.service.handles('find the Blue desk'),false);
});

test('cancelling a pending mode transition prevents its delayed completion from connecting the other adapter',async()=>{
  const cancelling=deferred(),calls=[];
  const adapter=mode=>({brief:()=>({phase:'idle'}),read:async()=>({phase:'idle',procedures:[]}),action:async name=>calls.push(`${mode}:${name}`),cancel:async()=>{calls.push(`${mode}:cancel`);if(mode==='desktop')await cancelling.promise;},close:async()=>{},handles:()=>false,command:async()=>{calls.push(`${mode}:command`);return null;},connectionChanged:()=>{}});
  const service=createTeaching({desktop:adapter('desktop'),browser:adapter('browser')});
  const changing=service.action('mode',{mode:'browser'});await tick();
  const response=await service.command('find an item');
  assert.match(response.message,/changing teaching modes/);assert.equal(calls.some(call=>call.endsWith(':command')),false);
  const stopped=service.cancel();cancelling.resolve();await Promise.all([changing,stopped]);
  assert.equal((await service.read()).mode,'desktop');
  assert.equal(calls.includes('browser:connect'),false);
});

test('task attempts use the real reasoning contract and recall demonstrated lessons with Accessibility alone',async t=>{
  let screen='Ready',value='';
  const decisions=[
    {status:'act',kind:'activate',bundleId:A,controlId:'',value:'',evidence:'',reason:'Inspect the selected catalog.'},
    {status:'act',kind:'fill',bundleId:A,controlId:search.id,value:'Blue desk',evidence:'',reason:'Search for the requested item.'},
    {status:'act',kind:'click',bundleId:A,controlId:open.id,value:'',evidence:'',reason:'Open the matching item.'},
    {status:'done',kind:'activate',bundleId:'',controlId:'',value:'',evidence:'Opened Blue desk',reason:'The requested details are visible.'},
  ];
  const f=await fixture(t,{
    request:(method,input)=>{
      if(method==='activate'||method==='snapshot')return obs(input.bundleId,screen,[search,open]);
      if(method==='execute'){
        const before=obs(input.bundleId,screen,[search,open]);
        if(input.kind==='fill'){value=input.value;screen=`Results for ${value}`;}else screen=`Opened ${value}`;
        return {before,after:obs(input.bundleId,screen,[search,open])};
      }
    },
    reason:(kind,input)=>kind==='next'?reasonAboutDesktopTeaching(kind,input,{group:async()=>({raw:decisions.shift()})}):undefined,
  });
  await teach(f.service);
  f.permissionState.inputMonitoring=false;
  const result=await f.service.action('attempt',{intent:'Find and inspect Blue desk in Catalog'});
  assert.equal(result.lastRun.verified,true);
  assert.equal(result.activeId,null,'A free task attempt must not leave an unrelated saved procedure active');
  assert.equal(decisions.length,0);
  const plans=f.reasons.filter(call=>call.kind==='next');
  assert.equal(plans.length,4);assert.equal(plans[0].input.stepLimit,24);
  assert.equal(plans[0].input.lessons.length,1);
  assert.equal(plans[0].input.lessons[0].name,'Find and inspect an item');
  assert.deepEqual(f.calls.filter(call=>call.method==='execute').map(call=>call.input.kind),['fill','click']);
});
