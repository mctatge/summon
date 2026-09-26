import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {askAtMostTwice,unreadableAnswer,worthRetrying,UNREADABLE_ANSWER} from '../src/core/answer-retry.mjs';
import {validateGrouping} from '../src/core/workstreams.mjs';
import {checkContextShape} from '../src/core/context-reasoning.mjs';
import {runGrouping} from '../src/main/workstream-engine.mjs';
import {scrubbedEnv} from '../src/main/process.mjs';

const schema={type:'object',properties:{workstreams:{type:'array'}}};
const coded=code=>Object.assign(new Error(code),{code});
function counted(outcomes){
  let calls=0;
  const ask=async()=>{const next=outcomes[Math.min(calls++,outcomes.length-1)];if(next instanceof Error)throw next;return next;};
  return {ask,calls:()=>calls};
}
async function cli(t,stdout){
  const tmp=await mkdtemp('/private/tmp/summon-retry-test-');t.after(()=>rm(tmp,{recursive:true,force:true}));
  return {tmp,scrubbedEnv,executable:async name=>`/fake/bin/${name}`,run:async()=>{if(stdout instanceof Error)throw stdout;return {stdout};}};
}

test('only an answer Summon itself refused is worth a second request',()=>{
  assert.equal(worthRetrying(unreadableAnswer('x')),true);
  assert.equal(unreadableAnswer('Claude returned a grouping Summon could not read.').code,UNREADABLE_ANSWER);
  for(const error of [coded('LOCAL_INVALID_RESPONSE'),new Error('Claude’s subscription login has expired.'),new Error('Usage limit reached.'),new Error('The operation timed out. Please try again.'),new Error('codex is not installed.'),coded('LOCAL_TIMEOUT'),coded('LOCAL_TRUNCATED'),coded('LOCAL_UNAVAILABLE'),coded('LOCAL_BUSY'),coded('ENOENT'),null,undefined,'UNREADABLE_ANSWER'])assert.equal(worthRetrying(error),false);
});

test('a refused answer is asked for once more and a good second answer is kept',async()=>{
  const f=counted([unreadableAnswer('first'),'good']);
  assert.equal(await askAtMostTwice(f.ask),'good');
  assert.equal(f.calls(),2);
});

test('a second refusal stands; there is never a third request',async()=>{
  const f=counted([unreadableAnswer('first'),unreadableAnswer('second'),'never']);
  await assert.rejects(askAtMostTwice(f.ask),/second/);
  assert.equal(f.calls(),2);
});

test('logins, quota, timeouts and other failures are never re-sent',async()=>{
  for(const error of [new Error('Claude’s subscription login has expired.'),new Error('Usage limit reached.'),new Error('The operation timed out. Please try again.'),coded('LOCAL_TIMEOUT')]){
    let ready=0;
    const f=counted([error,'never']);
    await assert.rejects(askAtMostTwice(f.ask,{ready:async()=>{ready++;return true;}}),error);
    assert.equal(f.calls(),1);assert.equal(ready,0);
  }
});

test('a send-time guard that no longer passes keeps the first failure and sends nothing more',async()=>{
  const first=unreadableAnswer('first');
  const f=counted([first,'never']);
  await assert.rejects(askAtMostTwice(f.ask,{ready:async()=>false}),first);
  assert.equal(f.calls(),1);
});

test('grouping tags unreadable model answers, but not CLI failures or unreadable CLI output',async t=>{
  const message=text=>JSON.stringify({type:'item.completed',item:{type:'agent_message',text}});
  for(const [engine,stdout] of [['codex',message('Sure! Here are your groups.')],['codex',message('[1,2]')],['claude',JSON.stringify({is_error:false,result:'not json'})],['claude',JSON.stringify({is_error:false,result:''})],['claude',JSON.stringify({is_error:false,result:'[]'})]]){
    await assert.rejects(runGrouping(engine,{prompt:'x',schema},await cli(t,stdout)),error=>error.code===UNREADABLE_ANSWER,`${engine}: ${stdout}`);
  }
  for(const [engine,stdout] of [['codex',JSON.stringify({type:'turn.failed',error:{message:'Usage limit reached.'}})],['codex',''],['claude','not json at all'],['claude','null'],['claude','5'],['claude','"text"'],['claude',JSON.stringify({is_error:true,result:'OAuth token has expired (401)'})],['codex',Object.assign(new Error('The operation timed out. Please try again.'),{stdout:''})]]){
    await assert.rejects(runGrouping(engine,{prompt:'x',schema},await cli(t,stdout)),error=>error.code===undefined,`${engine}: ${stdout}`);
  }
});

test('the grouping and context checks tag the answers they refuse',()=>{
  const request={items:new Map([['F001',{path:'a.ts'}]]),branchIds:new Map(),privatePaths:[]};
  for(const raw of ['not json',[],null])assert.throws(()=>validateGrouping(raw,request,{files:[]}),error=>error.code===UNREADABLE_ANSWER);
  assert.throws(()=>validateGrouping({workstreams:[{title:'x',items:['F999']}]},request,{files:[]}),error=>error.code===UNREADABLE_ANSWER&&/did not place any/.test(error.message));
  for(const raw of [null,[],{summary:1,goals:[],sessionTitles:[]},{summary:'',goals:{},sessionTitles:[]},{summary:'',goals:Array(7).fill({}),sessionTitles:[]},{summary:'',goals:[]},{summary:'',goals:[],sessionTitles:{}},{summary:'',goals:[],sessionTitles:Array(9).fill({})}])assert.throws(()=>checkContextShape(raw),error=>error.code===UNREADABLE_ANSWER);
  assert.doesNotThrow(()=>checkContextShape({summary:'',goals:[],sessionTitles:[]}));
});
