import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseEngine} from '../src/main/engine-choice.mjs';

const usage=(claude,codex)=>({version:1,settings:{},providers:{claude,codex},refreshing:[]});
const ok=(provider,five,seven,extra={})=>({provider,plan:'x',status:'ok',fetchedAt:'2026-09-19T21:00:00.000Z',stale:false,
  windows:[...(five===null?[]:[{id:'five_hour',label:'5h',usedPercent:five,resetsAt:null}]),...(seven===null?[]:[{id:'seven_day',label:'7d',usedPercent:seven,resetsAt:null}])],...extra});
const off=(provider,status)=>({provider,plan:null,status,windows:[],fetchedAt:'2026-09-19T21:00:00.000Z',stale:false});

test('a pinned engine and a running thread win over every reading',()=>{
  const heavy=usage(ok('claude',99,99),ok('codex',99,99));
  assert.deepEqual(chooseEngine({task:{engine:'codex'},usage:heavy}),{engine:'codex',reason:'pinned'});
  assert.deepEqual(chooseEngine({task:{engine:'claude'},usage:heavy}),{engine:'claude',reason:'pinned'});
  assert.deepEqual(chooseEngine({task:{engine:'auto',running:'codex'},usage:usage(ok('claude',0,0),ok('codex',80,80))}),{engine:'codex',reason:'a thread is already running there; a running thread is never switched'});
  assert.throws(()=>chooseEngine({task:{engine:'gemini'}}),/Choose claude, codex or auto/);
});

test('with nothing to go on, the default engine, and the reason says why',()=>{
  assert.deepEqual(chooseEngine({}),{engine:'claude',reason:'no usage yet; your default'});
  assert.deepEqual(chooseEngine({task:{engine:'auto'},usage:null,settings:{defaultEngine:'codex'}}),{engine:'codex',reason:'no usage yet; your default'});
  assert.deepEqual(chooseEngine({usage:usage(off('claude','not_signed_in'),off('codex','error'))}),{engine:'claude',reason:'no usage yet; your default'});
  assert.deepEqual(chooseEngine({usage:usage(ok('claude',5,5,{stale:true}),null)}),{engine:'claude',reason:'usage is stale; your default'});
  const empty={provider:'claude',plan:'max',status:'ok',windows:[],fetchedAt:'2026-09-19T21:00:00.000Z',stale:false};
  assert.equal(chooseEngine({usage:usage(empty,null),settings:{defaultEngine:'codex'}}).engine,'codex','an ok reading with no windows is not a reading; the default wins');
  assert.equal(chooseEngine({usage:usage(empty,ok('codex',5,5))}).engine,'codex','the provider with windows wins over one with none');
  assert.deepEqual(chooseEngine({usage:usage(ok('claude',5,5,{stale:true}),null),settings:{defaultEngine:'codex',usageCeiling:85}}),{engine:'codex',reason:'usage is stale; your default'});
  assert.deepEqual(chooseEngine({usage:{providers:'nope'},settings:{defaultEngine:'gemini',usageCeiling:'x'}}),{engine:'claude',reason:'no usage yet; your default'},'bad settings fall back to their defaults');
});

test('the provider with the most of its 5-hour window left; tie broken on the 7-day window; then the default',()=>{
  assert.deepEqual(chooseEngine({usage:usage(ok('claude',27,18),ok('codex',41,1))}),{engine:'claude',reason:'more of its 5-hour window left (Claude 73% left vs Codex 59%)'});
  assert.deepEqual(chooseEngine({usage:usage(ok('claude',60.5,18),ok('codex',41,1))}),{engine:'codex',reason:'more of its 5-hour window left (Codex 59% left vs Claude 39.5%)'});
  assert.deepEqual(chooseEngine({usage:usage(ok('claude',30,18),ok('codex',30,12))}),{engine:'codex',reason:'5-hour windows tie; more of its 7-day window left (Codex 88% left vs Claude 82%)'});
  assert.deepEqual(chooseEngine({usage:usage(ok('claude',30,18),ok('codex',30,18))}),{engine:'claude',reason:'usage ties; your default'});
  assert.deepEqual(chooseEngine({usage:usage(ok('claude',30,18),ok('codex',30,18)),settings:{defaultEngine:'codex'}}),{engine:'codex',reason:'usage ties; your default'});
  // Codex plans often report only a 7-day window: no 5-hour comparison is possible, so the 7-day one decides.
  assert.deepEqual(chooseEngine({usage:usage(ok('claude',27,18),ok('codex',null,1))}),{engine:'codex',reason:'no 5-hour window on both sides; more of its 7-day window left (Codex 99% left vs Claude 82%)'});
  assert.deepEqual(chooseEngine({usage:usage(ok('claude',27,null),ok('codex',null,1))}),{engine:'claude',reason:'usage ties; your default'});
});

test('a window at or over the ceiling makes that provider unavailable',()=>{
  assert.deepEqual(chooseEngine({usage:usage(ok('claude',85,10),ok('codex',60,50))}),{engine:'codex',reason:'Claude is over the 85% ceiling'});
  assert.deepEqual(chooseEngine({usage:usage(ok('claude',10,90),ok('codex',60,50))}),{engine:'codex',reason:'Claude is over the 85% ceiling'},'any window counts, not only the 5-hour one');
  assert.deepEqual(chooseEngine({usage:usage(ok('claude',84,10),ok('codex',60,50))}),{engine:'codex',reason:'more of its 5-hour window left (Codex 40% left vs Claude 16%)'},'just under the ceiling still counts');
  assert.deepEqual(chooseEngine({usage:usage(ok('claude',90,10),ok('codex',60,50)),settings:{usageCeiling:95}}),{engine:'codex',reason:'more of its 5-hour window left (Codex 40% left vs Claude 10%)'},'a higher ceiling keeps it in play');
  assert.deepEqual(chooseEngine({usage:usage(ok('claude',90,10),ok('codex',86,50))}),{engine:'claude',reason:'both over the 85% ceiling; your default'});
  assert.deepEqual(chooseEngine({usage:usage(ok('claude',90,10),ok('codex',86,50)),settings:{defaultEngine:'codex'}}),{engine:'codex',reason:'both over the 85% ceiling; your default'});
});

test('unknown usage is never 0 %: the known provider is used while it has room, and the default when it has not',()=>{
  assert.deepEqual(chooseEngine({usage:usage(ok('claude',20,10),off('codex','not_signed_in'))}),{engine:'claude',reason:'Codex usage is unknown (not signed in)'});
  assert.deepEqual(chooseEngine({usage:usage(off('claude','not_installed'),ok('codex',20,10))}),{engine:'codex',reason:'Claude usage is unknown (not installed)'});
  assert.deepEqual(chooseEngine({usage:usage(ok('claude',20,10),off('codex','not_applicable'))}),{engine:'claude',reason:'Codex usage is unknown (no plan limits)'});
  assert.deepEqual(chooseEngine({usage:usage(ok('claude',20,10),null)}),{engine:'claude',reason:'Codex usage is unknown'});
  assert.deepEqual(chooseEngine({usage:usage(ok('claude',20,10),ok('codex',3,3,{stale:true}))}),{engine:'claude',reason:'Codex usage is stale'});
  assert.deepEqual(chooseEngine({usage:usage(ok('claude',90,10),off('codex','error')),settings:{defaultEngine:'codex'}}),{engine:'codex',reason:'Claude is over the 85% ceiling and Codex usage is unknown (could not be read); your default'});
  assert.deepEqual(chooseEngine({usage:usage(ok('claude',90,10),off('codex','error'))}),{engine:'claude',reason:'Claude is over the 85% ceiling and Codex usage is unknown (could not be read); your default'});
});

const now=Date.UTC(2026,8,20,22);
const rated=(engine,ratings,extra={})=>ratings.map((rating,index)=>({id:`${engine}-${index}`,at:new Date(now-1000).toISOString(),engine,kind:'coding',complexity:'standard',effort:'medium',model:null,elapsedMs:1000,completed:true,rating,policyVersion:1,...extra}));
const history=[...rated('claude',['useful','useful','useful','useful','not-useful']),...rated('codex',['useful','useful','useful','not-useful','not-useful'])];
const taskOptions={task:{text:'Refactor this function'},usage:usage(ok('claude',60,40),ok('codex',10,10)),now};

test('task profiles affect effort without creating a provider stereotype',()=>{
  const choice=chooseEngine(taskOptions);
  assert.equal(choice.engine,'codex');assert.equal(choice.profile.kind,'coding');assert.equal(choice.effort,'medium');assert.equal(choice.policyVersion,1);
  assert.match(choice.reason,/5-hour.*standard coding task; medium effort/);
  const other=chooseEngine({...taskOptions,usage:usage(ok('claude',10,10),ok('codex',60,40))});
  assert.equal(other.engine,'claude','coding does not inherently favor Codex');
  const writing=chooseEngine({...taskOptions,task:{text:'Draft a brief email'}});
  assert.equal(writing.engine,'codex');assert.equal(writing.effort,'low');
  const complex=chooseEngine({...taskOptions,task:{text:'Debug a complex race condition'}});
  assert.equal(complex.effort,'high');
});

test('explicit pins and running threads remain authoritative with task feedback',()=>{
  for(const pinned of ['claude','codex']){
    const choice=chooseEngine({...taskOptions,task:{text:'Refactor this function',engine:pinned},outcomes:history});
    assert.equal(choice.engine,pinned);assert.match(choice.reason,/^pinned\./);
  }
  const running=chooseEngine({...taskOptions,task:{text:'Refactor this function',running:'codex'},outcomes:history});
  assert.equal(running.engine,'codex');assert.match(running.reason,/running thread is never switched/);
  assert.deepEqual(chooseEngine({...taskOptions,task:{text:' '},outcomes:history}),chooseEngine({...taskOptions,task:{}}),'blank task preserves the old contract');
});

test('manual effort selects the matching feedback cohort without changing task classification',()=>{
  const overridden={...taskOptions,task:{...taskOptions.task,effort:'high'}};
  const normalHistory=chooseEngine({...overridden,outcomes:history});
  assert.equal(normalHistory.engine,'codex','medium effort outcomes do not choose a high effort provider');
  assert.equal(normalHistory.effort,'high');assert.equal(normalHistory.profile.effort,'medium');assert.equal(normalHistory.profile.complexity,'standard');
  assert.match(normalHistory.reason,/high effort \(your override\)/);
  const highHistory=chooseEngine({...overridden,outcomes:history.map(row=>({...row,effort:'high'}))});
  assert.equal(highHistory.engine,'claude');
  assert.equal(chooseEngine({...taskOptions,task:{...taskOptions.task,effort:'invalid'},outcomes:history}).effort,'medium');
});

test('enough explicit quality feedback can override quota preference within the ceiling',()=>{
  const choice=chooseEngine({...taskOptions,outcomes:history});
  assert.equal(choice.engine,'claude');assert.match(choice.reason,/explicit feedback.*4\/5 useful vs Codex 3\/5/);
  assert.equal(chooseEngine({...taskOptions,outcomes:history.map(row=>({...row,at:now-30*86400000}))}).engine,'claude','the 30-day edge is included');
  assert.equal(chooseEngine({...taskOptions,usage:usage(ok('claude',85,10),ok('codex',10,10)),outcomes:history}).engine,'codex','feedback never overrides a quota ceiling');
  assert.equal(chooseEngine({...taskOptions,usage:usage(off('claude','error'),ok('codex',10,10)),outcomes:history}).engine,'codex','feedback never treats unknown usage as available');
});

test('feedback needs three ratings per engine, 80 percent useful, and a 20 point advantage',()=>{
  for(const outcomes of [
    [...rated('claude',['useful','useful']),...rated('codex',['not-useful','not-useful','not-useful'])],
    [...rated('claude',['useful','useful','useful']),...rated('codex',['not-useful','not-useful'])],
    [...rated('claude',['useful','useful','not-useful']),...rated('codex',['not-useful','not-useful','not-useful'])],
    [...rated('claude',['useful','useful','useful','useful','not-useful']),...rated('codex',['useful','useful','useful','useful','useful','useful','useful','not-useful','not-useful','not-useful'])],
    history.map(row=>({...row,rating:null})),
  ])assert.equal(chooseEngine({...taskOptions,outcomes}).engine,'codex');
  const minimum=[...rated('claude',['useful','useful','useful']),...rated('codex',['useful','useful','not-useful'])];
  assert.equal(chooseEngine({...taskOptions,outcomes:minimum}).engine,'claude');
});

test('old, mismatched, duplicate, uncompleted and malformed outcomes cannot inflate quality',()=>{
  for(const extra of [
    {at:new Date(now-30*86400000-1).toISOString()},{at:now+1},{at:'bad'},
    {kind:'writing'},{complexity:'quick'},{effort:'high'},{completed:false},{completed:'yes'},
    {rating:'success'},{policyVersion:2},{policyVersion:undefined},{elapsedMs:-1},{elapsedMs:Infinity},
    {id:''},{id:3},{model:undefined},{model:[]},
  ])assert.equal(chooseEngine({...taskOptions,outcomes:history.map(row=>({...row,...extra}))}).engine,'codex',JSON.stringify(extra));
  const repeated=[...rated('claude',['useful','useful'],{id:'same'}),...rated('codex',['not-useful','not-useful','not-useful'])];
  assert.equal(chooseEngine({...taskOptions,outcomes:[...repeated,...repeated,...repeated,null,[]]}).engine,'codex');
  for(const outcomes of [null,{},'useful'])assert.equal(chooseEngine({...taskOptions,outcomes}).engine,'codex');
});

test('malformed usage cannot supply a zero-cost preference or crash task routing',()=>{
  for(const windows of [undefined,{},[null],[{usedPercent:NaN}],[{usedPercent:-1}],[{usedPercent:101}]]){
    const result=chooseEngine({...taskOptions,usage:usage({status:'ok',windows},ok('codex',10,10)),outcomes:history});
    assert.equal(result.engine,'codex');
  }
});
