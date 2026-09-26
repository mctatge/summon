import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createTaskRouter} from '../src/main/task-router.mjs';
import {createBenchmark,PUBLIC_BENCHMARK_URL} from '../src/main/benchmark.mjs';

const START=Date.parse('2020-01-02T12:00:00Z'),DAY=86400_000;
const usage=(claude=10,codex=40)=>({providers:Object.fromEntries(Object.entries({claude,codex}).map(([provider,usedPercent])=>[provider,{provider,status:'ok',stale:false,windows:[{id:'five_hour',usedPercent}]}]))});
const catalog={status:'ok',models:['claude-sonnet-5','claude-opus-5','claude-haiku-4-5'].map(id=>({id,model:id}))};
const ranked=(at=START)=>({source:'https://aistupidlevel.info/',sourceKind:'public-dashboard',actualCategory:'combined',fetchedAt:new Date(at).toISOString(),models:catalog.models.map(({id},i)=>({name:id,provider:'anthropic',score:[84,86,75][i],lastUpdated:new Date(at).toISOString()}))});
const record=(extra={})=>({id:randomUUID(),at:new Date(START).toISOString(),policyVersion:1,engine:'codex',kind:'coding',complexity:'standard',effort:'medium',model:null,elapsedMs:150,completed:true,rating:null,...extra});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function fixture(t){
  const dataDir=await mkdtemp(path.join(tmpdir(),'summon-router-test-')),file=path.join(dataDir,'routing-outcomes.json');
  t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const make=async(options={})=>{
    const router=await createTaskRouter({dataDir,getUsage:()=>usage(),getSettings:()=>({defaultEngine:'claude'}),benchmark:async()=>ranked(),readModels:async()=>catalog,ask:async()=>({text:'fixture answer'}),now:()=>START,...options});
    t.after(()=>router.close());return router;
  };
  return {dataDir,file,make};
}

test('preview routes both providers and honors pinned engines without executing or storing an answer',async t=>{
  const {file,make}=await fixture(t);let liveUsage=usage(),reads=0,benchmarks=0;
  const router=await make({getUsage:()=>liveUsage,ask:()=>assert.fail('Preview cannot run an answer'),readModels:async()=>{reads++;return catalog;},benchmark:async()=>{benchmarks++;return ranked();}});
  const quick=await router.preview('auto','Give a brief answer about this function.');
  assert.equal(quick.engine,'claude');assert.equal(quick.effort,'low');assert.equal(quick.model,'claude-sonnet-5');
  assert.match(quick.reason,/quick coding task/);
  liveUsage=usage(60,10);
  const codex=await router.preview('auto','Investigate this complex migration.');
  assert.equal(codex.engine,'codex');assert.equal(codex.effort,'high');assert.equal(codex.model,null);
  assert.equal(reads,1);assert.equal(benchmarks,1,'Codex preview does not fetch Claude benchmark data');
  assert.equal((await router.preview('claude','Question')).engine,'claude');
  assert.equal((await router.preview('codex','Question')).engine,'codex');
  assert.deepEqual(router.summary(),{count:0,rated:0,problem:null});
  await assert.rejects(stat(file),{code:'ENOENT'});
});

test('preview shares in-flight catalogs, respects cache expiry/clock rollback and uses the public benchmark cache',async t=>{
  const {dataDir,make}=await fixture(t);let clock=START,reads=0,fetches=0;
  const entered=deferred(),release=deferred();
  const benchmark=createBenchmark({dataDir,now:()=>clock,fetcher:async(url,options)=>{
    fetches++;assert.equal(url,PUBLIC_BENCHMARK_URL);assert.deepEqual(options.headers,{Accept:'application/json'});
    return new Response(JSON.stringify({success:true,data:{modelScores:ranked(clock).models.map(row=>({...row,currentScore:row.score}))},meta:{sortBy:'combined'}}));
  }});
  const router=await make({now:()=>clock,benchmark,readModels:async()=>{reads++;entered.resolve();await release.promise;return catalog;},ask:()=>assert.fail('Preview cannot invoke an execution provider')});
  const first=router.preview('claude','Question'),second=router.preview('claude','Another question');
  await entered.promise;release.resolve();
  const choices=await Promise.all([first,second]);
  assert.ok(choices.every(choice=>choice.model==='claude-opus-5'),'selection uses the router clock, not wall clock');
  assert.equal(reads,1);assert.equal(fetches,1);
  clock+=299_999;await router.preview('claude','Question');assert.equal(reads,1);assert.equal(fetches,1);
  clock++;await router.preview('claude','Question');assert.equal(reads,2);assert.equal(fetches,1);
  clock-=1_000;await router.preview('claude','Question');assert.equal(reads,3,'future catalog timestamps are not fresh');
});

test('benchmark and catalog failures fall back visibly and do not prevent a restricted answer',async t=>{
  const {make}=await fixture(t);const calls=[];
  const router=await make({benchmark:async()=>{throw new Error('offline');},readModels:async()=>({status:'error',models:[]}),ask:async(...args)=>{calls.push(args);return {text:'answer'};}});
  const choice=await router.preview('claude','Question');assert.equal(choice.model,null);assert.match(choice.reason,/Sonnet answer default/);
  const answer=await router.answer('claude','Question',{privateContext:'only for executor'});
  assert.equal(answer.text,'answer');assert.deepEqual(calls[0][3],{effort:'medium'});
  assert.equal(router.outcomes()[0].completed,true);
});

test('manual effort reaches both routing policy and execution while Auto retains task-derived effort',async t=>{
  const {make}=await fixture(t);const tasks=[],calls=[];
  const router=await make({selectEngine:({task})=>{tasks.push(task);return {engine:task.engine==='auto'?'codex':task.engine,reason:'fixture policy'};},ask:async(...args)=>{calls.push(args);return {text:'answer'};}});
  const answer=await router.answer('auto','Briefly explain this function.',{}, {effort:'high'});
  assert.equal(tasks[0].effort,'high');assert.equal(answer.effort,'high');assert.match(answer.reason,/effort set by you: high/);
  assert.deepEqual(calls[0][3],{effort:'high'});assert.equal(router.outcomes()[0].effort,'high');
  const automatic=await router.preview('codex','Briefly explain this function.',{effort:'auto'});
  assert.equal(automatic.effort,'low');assert.equal(tasks[1].effort,undefined);
});

test('persisted feedback changes a provider choice only within the actual effort cohort',async t=>{
  const {file,make}=await fixture(t);
  const rows=['claude','codex'].flatMap(engine=>Array.from({length:3},(_,i)=>record({engine,effort:'high',rating:engine==='codex'||i===0?'useful':'not-useful'})));
  await writeFile(file,JSON.stringify({version:1,outcomes:rows}));const router=await make();
  assert.equal((await router.preview('auto','Explain this function')).engine,'claude','medium-effort requests retain the quota choice');
  assert.equal((await router.preview('auto','Explain this function',{effort:'high'})).engine,'codex','the high-effort override uses the rated high-effort cohort');
  await router.feedback(rows[3].id,'not-useful');
  assert.equal((await router.preview('auto','Explain this function',{effort:'high'})).engine,'claude','an overwritten rating reduces measured quality without adding a sample');
  await router.feedback(rows[3].id,'useful');
  assert.equal((await router.preview('claude','Explain this function',{effort:'high'})).engine,'claude','an explicit provider pin still wins');
  assert.equal(router.summary().rated,6);
});

test('answer records bounded metadata privately, excludes prompts/answers/context and returns detached history',async t=>{
  const {file,make}=await fixture(t);let clock=START;
  const prompt='private-question-marker',answerText='private-answer-marker',privatePath='/private/workspace-marker';
  const router=await make({now:()=>clock,ask:async()=>{clock+=75;return {text:answerText};}});
  const result=await router.answer('claude',prompt,{path:privatePath,credential:'private-key-marker'},{effort:'high'});
  assert.equal(result.text,answerText);assert.equal(result.model,'claude-opus-5');
  const raw=await readFile(file,'utf8'),disk=JSON.parse(raw),[outcome]=router.outcomes();
  for(const marker of [prompt,answerText,privatePath,'private-key-marker'])assert.ok(!raw.includes(marker));
  assert.deepEqual(Object.keys(outcome).sort(),['id','at','policyVersion','engine','kind','complexity','effort','model','elapsedMs','completed','rating'].sort());
  assert.equal(outcome.id,result.routeId);assert.equal(outcome.elapsedMs,75);assert.equal(outcome.completed,true);assert.equal(outcome.rating,null);
  assert.equal((await stat(file)).mode&0o777,0o600);assert.deepEqual(disk.outcomes,[outcome]);
  outcome.rating='useful';assert.equal(router.summary().rated,0,'callers cannot mutate internal history');
});

test('only completed existing answers can be rated, and changing feedback updates one observation',async t=>{
  const {file,make}=await fixture(t);let fail=false;
  const router=await make({ask:async()=>{if(fail)throw new Error('provider unavailable');return {text:'answer'};}});
  const result=await router.answer('codex','Explain this function',{});
  await router.feedback(result.routeId,'useful');await router.feedback(result.routeId,'not-useful');
  assert.equal(router.summary().count,1);assert.equal(router.summary().rated,1);assert.equal(router.outcomes()[0].rating,'not-useful');
  await assert.rejects(router.feedback(randomUUID(),'useful'),/no longer/);
  await assert.rejects(router.feedback(result.routeId,'excellent'),/Choose useful/);
  fail=true;await assert.rejects(router.answer('codex','Another function',{}),/provider unavailable/);
  const failed=router.outcomes().find(row=>!row.completed);assert.ok(failed);assert.equal(failed.rating,null);
  await assert.rejects(router.feedback(failed.id,'useful'),/no longer/);
  const stored=JSON.parse(await readFile(file,'utf8'));assert.equal(stored.outcomes.length,2);assert.equal(router.summary().rated,1);
});

test('history is capped at 200 records and 30 days, including after restart and time advances',async t=>{
  const {file,make}=await fixture(t);let clock=START;
  const seed=Array.from({length:205},(_,i)=>record({at:new Date(START-205+i).toISOString()}));
  await writeFile(file,JSON.stringify({version:1,outcomes:[record({at:new Date(START-31*DAY).toISOString()}),...seed]}));
  const router=await make({now:()=>clock});assert.equal(router.outcomes().length,200);assert.equal(router.outcomes()[0].id,seed[5].id);
  const result=await router.answer('codex','Question',{});assert.equal(router.outcomes().length,200);assert.equal(router.outcomes()[0].id,seed[6].id);
  const reloaded=await make({now:()=>clock});assert.deepEqual(reloaded.outcomes(),router.outcomes());
  clock+=30*DAY+1;assert.deepEqual(router.outcomes(),[]);await assert.rejects(router.feedback(result.routeId,'useful'),/no longer/);
  await router.answer('codex','New question',{});assert.equal(JSON.parse(await readFile(file,'utf8')).outcomes.length,1);
});

test('loaded records reject corruption, future dates and invalid identity/model data and strip foreign fields',async t=>{
  const {file,make}=await fixture(t);let clock=START;
  const valid=record({at:'2 Jan 2020 12:00:00 GMT (private-loaded-date)',prompt:'private-loaded-prompt',answer:'private-loaded-answer',path:'/private/loaded-path'}),failed=record({completed:false,rating:'useful'});
  const corrupt=[null,[],record({at:new Date(START+1).toISOString()}),record({at:{toString:'invalid'}}),record({id:'-'.repeat(36)}),record({model:'claude-opus--'}),record({model:'claude-fable-5'}),record({policyVersion:2}),record({elapsedMs:-1}),record({rating:'great'})];
  await writeFile(file,JSON.stringify({version:1,outcomes:[...corrupt,valid,{...valid,rating:'useful'},failed]}));
  const router=await make({now:()=>clock});assert.equal(router.summary().count,2);assert.equal(router.summary().rated,0);
  assert.equal(router.outcomes()[1].rating,null);assert.equal(router.outcomes()[0].prompt,undefined);
  await router.feedback(valid.id,'useful');const raw=await readFile(file,'utf8');assert.doesNotMatch(raw,/private-loaded|loaded-path/);
  clock--;assert.deepEqual(router.outcomes(),[],'history timestamps in the future after a clock correction are excluded');
  await assert.rejects(router.feedback(valid.id,'not-useful'),/no longer/);
});

test('unreadable and oversized stores expose a bounded warning and recover on the next saved answer',async t=>{
  for(const raw of ['not JSON',JSON.stringify({version:2,outcomes:[]}),JSON.stringify({version:1,outcomes:{}}),' '.repeat(128*1024+1)]){
    const {file,make}=await fixture(t);await writeFile(file,raw);
    const router=await make();assert.equal(router.summary().count,0);assert.match(router.summary().problem,/could not be read/);
    await router.answer('codex','Question',{});assert.equal(router.summary().problem,null);assert.equal(JSON.parse(await readFile(file,'utf8')).outcomes.length,1);
  }
});

test('concurrent writes preserve every result and feedback; clear persists through reload',async t=>{
  const {file,make}=await fixture(t);const router=await make();
  const answers=await Promise.all(Array.from({length:12},(_,i)=>router.answer('codex',`Question ${i}`,{})));
  await Promise.all(answers.map((answer,i)=>router.feedback(answer.routeId,i%2?'useful':'not-useful')));
  await router.close();
  assert.equal(router.summary().count,12);assert.equal(router.summary().rated,12);
  const disk=JSON.parse(await readFile(file,'utf8'));assert.equal(new Set(disk.outcomes.map(row=>row.id)).size,12);
  const reload=await make();assert.deepEqual(reload.outcomes(),router.outcomes());
  const pending=router.feedback(answers[0].routeId,'useful'),cleared=router.clear();await Promise.all([pending,cleared]);await router.close();
  assert.deepEqual(JSON.parse(await readFile(file,'utf8')).outcomes,[]);assert.deepEqual((await make()).outcomes(),[]);
});

test('clear does not let an answer already in flight repopulate erased history',async t=>{
  const {file,make}=await fixture(t),entered=deferred(),release=deferred();
  const router=await make({ask:async()=>{entered.resolve();await release.promise;return {text:'answer'};}});
  const pending=router.answer('codex','Question',{});await entered.promise;await router.clear();release.resolve();
  const result=await pending;assert.equal(result.text,'answer');assert.deepEqual(router.outcomes(),[]);
  await assert.rejects(router.feedback(result.routeId,'useful'),/no longer/);
  assert.deepEqual(JSON.parse(await readFile(file,'utf8')).outcomes,[]);
});

test('save failures retain the answer with a visible history warning and later saves recover',async t=>{
  const {file,make}=await fixture(t);await mkdir(file+'.tmp');const router=await make();
  const result=await router.answer('codex','Question',{});assert.equal(result.text,'fixture answer');assert.match(router.summary().problem,/could not be saved/);
  await router.close();await rm(file+'.tmp',{recursive:true});await router.feedback(result.routeId,'useful');
  assert.equal(router.summary().problem,null);assert.equal(JSON.parse(await readFile(file,'utf8')).outcomes[0].rating,'useful');
});

test('invalid preview arguments cannot trigger benchmark, catalog, execution or feedback writes',async t=>{
  const {file,make}=await fixture(t);const fail=()=>assert.fail('Invalid requests must have no side effects');
  const router=await make({benchmark:fail,readModels:fail,ask:fail,selectEngine:fail});
  for(const [engine,text,options] of [['other','Question',{}],['auto','',{}],['auto','x'.repeat(4001),{}],['auto','Question',{effort:'max'}],['auto','Question',{tools:'Bash'}],['auto','Question',{[Symbol('flag')]:'x'}],['auto','Question',new Date()],['auto','Question',null]])await assert.rejects(router.preview(engine,text,options));
  assert.deepEqual(router.outcomes(),[]);await assert.rejects(stat(file),{code:'ENOENT'});
});
