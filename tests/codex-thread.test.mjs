import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createCodexThread,SIGN_IN_MESSAGE} from '../src/main/codex-thread.mjs';
import {spawnLongLived} from '../src/main/process.mjs';

const fake=fileURLToPath(new URL('./fixtures/fake-codex-app-server.mjs',import.meta.url));
const KEYS=['ANTHROPIC_API_KEY','OPENAI_API_KEY','CODEX_API_KEY'];
for(const key of KEYS)process.env[key]='test-never-forward';
after(()=>{for(const key of KEYS)delete process.env[key];});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}};
async function until(check,label){for(let i=0;i<300;i++){if(check())return;await wait(10);}assert.fail(`${label} timed out.`);}
async function fixture({scenario='complete',args=[],...options}={}){
  const dir=await mkdtemp('/private/tmp/summon-codex-thread-'),log=path.join(dir,'log.jsonl'),pids=path.join(dir,'pids.json'),events=[];
  const thread=createCodexThread({cwd:dir,executable:'codex-under-test',developerInstructions:'Be brief.',effort:'low',onEvent:event=>events.push(event),...options,spawnChild:(binary,spawnArgs,spawnOptions)=>{
    assert.equal(binary,'codex-under-test');assert.deepEqual(spawnArgs,['app-server']);assert.equal(spawnOptions.cwd,dir);
    for(const key of [...KEYS,'NODE_OPTIONS'])assert.equal(spawnOptions.env[key],undefined);assert.equal(spawnOptions.env.RUST_LOG,'warn');
    return spawnLongLived(process.execPath,[fake,'--scenario',scenario,'--log',log,'--pids',pids,...args],spawnOptions);
  }});
  const messages=async()=>(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  const sent=async method=>{for(let i=0;i<300;i++){if((await messages().catch(()=>[])).some(m=>m.method===method))return true;await wait(10);}return false;};
  const processIds=async()=>{for(let i=0;i<300;i++){try{return JSON.parse(await readFile(pids,'utf8'));}catch{await wait(10);}}assert.fail('The fake server never reported its pids.');};
  return {thread,events,messages,sent,processIds,dir,cleanup:async()=>{await thread.close();await rm(dir,{recursive:true,force:true});}};
}

test('handshake order, thread/start and turn/start params, streamed text and a persistent thread',async()=>{
  const f=await fixture({args:['--foreign']});
  try{
    const {threadId}=await f.thread.start();
    assert.equal(threadId,'01a0ba8e-6bf8-72d2-a446-094c9d1eda32');assert.equal(f.thread.status().state,'ready');
    const first=await f.thread.turn('Reply with exactly the single word: ready');
    assert.deepEqual(first,{text:'ready 1',status:'completed',turnId:'turn-1',interrupted:false});
    const second=await f.thread.turn('again');
    assert.equal(second.text,'ready 2');assert.equal(second.turnId,'turn-2');assert.equal(f.thread.status().threadId,threadId);
    const sent=await f.messages();
    assert.deepEqual(sent.slice(0,3).map(m=>m.method),['initialize','initialized','thread/start']);
    assert.deepEqual(sent[0].params,{clientInfo:{name:'summon',title:'Summon',version:sent[0].params.clientInfo.version},capabilities:{}});assert.match(sent[0].params.clientInfo.version,/^\d+\.\d+\.\d+/);
    assert.deepEqual(sent[2].params,{cwd:f.dir,sandbox:'read-only',approvalPolicy:'on-request',ephemeral:false,developerInstructions:'Be brief.'});
    assert.deepEqual(sent[3],{jsonrpc:'2.0',id:sent[3].id,method:'turn/start',params:{threadId,input:[{type:'text',text:'Reply with exactly the single word: ready'}],effort:'low'}});
    assert.deepEqual(f.events.filter(e=>e.type==='delta'&&e.turnId==='turn-1').map(e=>e.text),['rea','dy 1']);
    assert.ok(!JSON.stringify(f.events).includes('FOREIGN'),'Notifications for another thread or turn must be ignored.');
    assert.equal(f.events.filter(e=>e.type==='completed').length,2);assert.equal(f.thread.status().ignoredLines,1);
  }finally{await f.cleanup();}
});

test('thread id is read from every known location and a missing id fails visibly',async()=>{
  for(const shape of ['thread.id','thread.sessionId','threadId','sessionId']){
    const f=await fixture({args:['--id-shape',shape]});
    try{assert.equal((await f.thread.start()).threadId,'01a0ba8e-6bf8-72d2-a446-094c9d1eda32');}finally{await f.cleanup();}
  }
  const f=await fixture({args:['--id-shape','none']});
  try{await assert.rejects(f.thread.start(),/thread id/);assert.equal(f.thread.status().state,'retired');await assert.rejects(f.thread.turn('x'),/thread id/);}
  finally{await f.cleanup();}
});

test('one turn at a time, interrupt and AbortSignal end a running turn',async()=>{
  const f=await fixture({scenario:'partial'});
  try{
    await f.thread.start();
    const running=f.thread.turn('take your time');await wait(50);
    await assert.rejects(f.thread.turn('another'),/still working/);
    await f.thread.interrupt();
    const result=await running;
    assert.equal(result.status,'interrupted');assert.equal(result.interrupted,true);assert.equal(result.text,'partial');
    assert.ok((await f.messages()).some(m=>m.method==='turn/interrupt'&&m.params.turnId==='turn-1'));
    const controller=new AbortController();const aborted=f.thread.turn('again',{signal:controller.signal});await wait(50);controller.abort();
    assert.equal((await aborted).status,'interrupted');assert.equal(f.thread.status().state,'ready');
  }finally{await f.cleanup();}
});

test('approval requests decline without a callback and map once/session with one',async()=>{
  const cases=[
    {onApproval:null,expect:'decline',event:'decline'},
    {onApproval:()=>'once',expect:'accept'},
    {onApproval:async()=>'session',expect:'acceptForSession'},
    {onApproval:()=>'always',expect:'decline'},
    {onApproval:()=>{throw new Error('ui gone');},expect:'decline'},
    {onApproval:()=>new Promise(()=>{}),expect:'decline',approvalTimeoutMs:60},
  ];
  for(const {onApproval,expect,approvalTimeoutMs=300_000} of cases){
    const f=await fixture({scenario:'approval',onApproval,approvalTimeoutMs});
    try{
      await f.thread.start();
      const result=await f.thread.turn('list files');
      assert.equal(result.text,`decision {"decision":"${expect}"}`);
      const answer=(await f.messages()).find(m=>m.id==='srv-1');assert.deepEqual(answer,{jsonrpc:'2.0',id:'srv-1',result:{decision:expect}});
      const approval=f.events.find(e=>e.type==='approval');assert.equal(approval.kind,'commandExecution');assert.equal(approval.command,'ls -la');assert.equal(approval.decision,expect);
    }finally{await f.cleanup();}
  }
  const seen=[];const f=await fixture({scenario:'approval',args:['--approval-kind','fileChange'],onApproval:(kind,params)=>{seen.push([kind,params.itemId]);return 'once';}});
  try{await f.thread.start();assert.equal((await f.thread.turn('edit')).text,'decision {"decision":"accept"}');assert.deepEqual(seen,[['fileChange','fileChange-1']]);}
  finally{await f.cleanup();}
});

test('unknown server requests get -32601; permissions, elicitation and user input are declined by shape',async()=>{
  const f=await fixture({scenario:'requests',onApproval:()=>'once'});
  try{
    await f.thread.start();
    const result=await f.thread.turn('poke');
    const answers=JSON.parse(result.text.replace(/^answers /,''));
    assert.equal(answers['fake/unknown'].error.code,-32601);
    assert.deepEqual(answers['item/permissions/requestApproval'].result,{permissions:{},scope:'turn'});
    assert.deepEqual(answers['mcpServer/elicitation/request'].result,{action:'decline'});
    assert.deepEqual(answers['item/tool/requestUserInput'].result,{answers:{}});
  }finally{await f.cleanup();}
});

test('silence after a tool result interrupts and retires the thread',async()=>{
  const f=await fixture({scenario:'silent',silenceTimeoutMs:80});
  try{
    await f.thread.start();
    const result=await f.thread.turn('run something');
    assert.equal(result.status,'retired');assert.equal(result.interrupted,true);assert.match(result.error,/silent/);
    assert.equal(f.thread.status().state,'retired');assert.match(f.thread.status().reason,/silent/);
    assert.ok(await f.sent('turn/interrupt'),'The wedged turn is interrupted before the child is stopped.');
    await assert.rejects(f.thread.turn('again'),/silent/);
  }finally{await f.cleanup();}
});

test('a turn that never finishes hits the deadline, interrupts and retires',async()=>{
  const f=await fixture({scenario:'partial',turnTimeoutMs:100});
  try{
    await f.thread.start();
    const result=await f.thread.turn('hang');
    assert.equal(result.status,'retired');assert.equal(result.text,'partial');assert.match(result.error,/did not finish/);
    assert.ok(await f.sent('turn/interrupt'));
  }finally{await f.cleanup();}
});

test('sign-in failures are named from the protocol or a stop, never from stderr chatter alone',async()=>{
  const n=await fixture({scenario:'stderr-noise'});
  try{
    await n.thread.start();
    const result=await n.thread.turn('hello');
    assert.equal(result.status,'completed');assert.equal(result.text,'ready noise');assert.equal(n.thread.status().state,'ready');
    assert.ok(n.thread.status().stderr.some(line=>/codex_rmcp_client/.test(line)),'the warning is kept as diagnostics');
  }finally{await n.cleanup();}
  const r=await fixture({scenario:'error-retry'});
  try{
    await r.thread.start();
    const result=await r.thread.turn('hello');
    assert.equal(result.status,'completed');assert.equal(result.text,'ready after retry');assert.equal(r.thread.status().state,'ready');
    assert.ok(r.events.some(event=>event.type==='status'&&event.activity==='retrying'));
  }finally{await r.cleanup();}
  const f=await fixture({scenario:'stderr'});
  try{
    await f.thread.start();
    const result=await f.thread.turn('hello');
    assert.equal(result.status,'retired');assert.equal(result.error,SIGN_IN_MESSAGE);
    const tail=f.thread.status().stderr;assert.equal(tail.length,1);
    assert.equal(tail[0],'2026-09-19T16:44:51.086443Z ERROR codex_core::auth: failed to refresh access token: invalid_grant');
  }finally{await f.cleanup();}
  const g=await fixture({scenario:'rpc-auth'});
  try{await g.thread.start();const result=await g.thread.turn('hello');assert.equal(result.status,'retired');assert.equal(result.error,SIGN_IN_MESSAGE);await assert.rejects(g.thread.turn('again'),new RegExp(SIGN_IN_MESSAGE.slice(0,20)));}
  finally{await g.cleanup();}
});

test('the child exiting mid-turn retires the thread and keeps the partial text',async()=>{
  const f=await fixture({scenario:'exit'});
  try{
    await f.thread.start();
    const result=await f.thread.turn('hello');
    assert.equal(result.status,'retired');assert.equal(result.text,'half');assert.match(result.error,/exit code 3|stopped/);
    assert.equal(f.thread.status().state,'retired');
  }finally{await f.cleanup();}
});

test('close ends the app-server and its process group and refuses further turns',async()=>{
  const f=await fixture();
  try{
    await f.thread.start();const {pid,kid}=await f.processIds();
    assert.ok(alive(pid)&&alive(kid));
    const began=Date.now();await Promise.all([f.thread.close(),f.thread.close()]);
    assert.ok(Date.now()-began<3000,'A cooperative app-server closes without waiting for SIGKILL.');
    await until(()=>!alive(pid)&&!alive(kid),'Group teardown');
    assert.equal(f.thread.status().state,'closed');await assert.rejects(f.thread.turn('x'),/closed/);await assert.rejects(f.thread.start(),/closed/);
  }finally{await f.cleanup();}
});

test('invalid options fail before anything is spawned',()=>{
  assert.throws(()=>createCodexThread({}),/working directory/);
  assert.throws(()=>createCodexThread({cwd:'/tmp',sandbox:'danger-full-access'}),/sandbox/);
});

test('closing during the executable lookup never spawns an app-server',async()=>{
  const dir=await mkdtemp('/private/tmp/summon-codex-thread-');
  try{
    const thread=createCodexThread({cwd:dir,spawnChild:()=>assert.fail('spawned after close')});
    const starting=thread.start();
    await thread.close();
    await assert.rejects(starting);
    assert.equal(thread.status().state,'closed');
  }finally{await rm(dir,{recursive:true,force:true});}
});
