import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {readCodexUsage} from '../src/main/usage-codex.mjs';
import {spawnLongLived} from '../src/main/process.mjs';

const fake=fileURLToPath(new URL('./fixtures/fake-codex-usage.mjs',import.meta.url));
const KEYS=['ANTHROPIC_API_KEY','OPENAI_API_KEY','CODEX_API_KEY'];
for(const key of KEYS)process.env[key]='test-never-forward';
process.env.NODE_OPTIONS='--no-warnings';
after(()=>{for(const key of [...KEYS,'NODE_OPTIONS'])delete process.env[key];});
const NOW=Date.UTC(2026,8,19,21,0,0);
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}};
async function until(check,label){for(let i=0;i<400;i++){if(check())return;await wait(10);}assert.fail(`${label} timed out.`);}
async function probe(scenario,options={}){
  const dir=await mkdtemp('/private/tmp/summon-usage-codex-'),log=path.join(dir,'log.jsonl'),spawns=[];
  const result=await readCodexUsage({executable:async name=>{assert.equal(name,'codex');return 'codex-under-test';},now:()=>NOW,...options,spawnChild:(binary,args,spawnOptions)=>{
    assert.equal(binary,'codex-under-test');assert.deepEqual(args,['app-server']);
    assert.equal(spawnOptions.env.RUST_LOG,'warn');
    for(const key of [...KEYS,'NODE_OPTIONS'])assert.equal(spawnOptions.env[key],undefined);
    const handle=spawnLongLived(process.execPath,[fake,'--scenario',scenario,'--log',log],spawnOptions);spawns.push(handle);return handle;
  }});
  const sent=async()=>(await readFile(log,'utf8').catch(()=>'')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  return {result,sent,spawns,cleanup:()=>rm(dir,{recursive:true,force:true})};
}
const gone=async spawns=>{for(const handle of spawns)await until(()=>!alive(handle.child.pid),'child exit');};

test('handshake, one rateLimits read and out: windows named by duration, account details dropped, no thread started',async()=>{
  const f=await probe('ok');
  try{
    assert.deepEqual(f.result,{provider:'codex',plan:'plus',status:'ok',windows:[{id:'seven_day',label:'7d',usedPercent:1,resetsAt:'2026-09-24T00:00:00.000Z'}],fetchedAt:'2026-09-19T21:00:00.000Z'});
    const text=JSON.stringify(f.result);
    for(const dropped of ['acc_secret','credits','upsell','rateLimitsByLimitId','spendControl'])assert.ok(!text.includes(dropped),`${dropped} is dropped`);
    const sent=await f.sent();
    assert.deepEqual(sent.map(message=>message.method),['initialize','initialized','account/rateLimits/read']);
    assert.deepEqual(sent[0].params,{clientInfo:{name:'summon',title:'Summon',version:sent[0].params.clientInfo.version},capabilities:{}});assert.match(sent[0].params.clientInfo.version,/^\d+\.\d+\.\d+/);
    assert.deepEqual(sent[2].params,{excludeResetCreditDetails:true});
    await gone(f.spawns);
  }finally{await f.cleanup();}
});

test('a 300-minute window is the 5-hour one whichever slot it sits in, and an unknown duration keeps a plain label',async()=>{
  const both=await probe('both');
  try{
    assert.equal(both.result.plan,'pro');
    assert.deepEqual(both.result.windows,[{id:'five_hour',label:'5h',usedPercent:41.3,resetsAt:'2026-09-19T22:00:00.000Z'},{id:'seven_day',label:'7d',usedPercent:12,resetsAt:'2026-09-24T20:00:00.000Z'}]);
    await gone(both.spawns);
  }finally{await both.cleanup();}
  const odd=await probe('odd');
  try{
    assert.deepEqual(odd.result.windows.map(window=>[window.id,window.label,window.usedPercent]),[['five_hour','5h',10],['1440m','1440m',60]],'the 5-hour window sorts first even when the CLI listed it second');
    await gone(odd.spawns);
  }finally{await odd.cleanup();}
});

test('a sign-in failure in the answer, a notification or the log is not signed in; a retrying stream is not',async()=>{
  for(const [scenario,pattern] of [['unauthorized',/401 Unauthorized/],['unauthorized-info',/Request failed/],['auth-notification',/401 Unauthorized/],['stderr-auth',/sign-in problem/]]){
    const f=await probe(scenario);
    try{assert.equal(f.result.status,'not_signed_in',scenario);assert.match(f.result.error,pattern,scenario);assert.deepEqual(f.result.windows,[]);await gone(f.spawns);}
    finally{await f.cleanup();}
  }
  const retry=await probe('retry-notification');
  try{assert.equal(retry.result.status,'ok');assert.equal(retry.result.windows.length,2);await gone(retry.spawns);}finally{await retry.cleanup();}
});

test('null limits are not applicable; an unreadable answer, a refused handshake or an early exit is an error',async()=>{
  const nul=await probe('null');
  try{assert.deepEqual(nul.result,{provider:'codex',plan:null,status:'not_applicable',windows:[],fetchedAt:'2026-09-19T21:00:00.000Z'});await gone(nul.spawns);}finally{await nul.cleanup();}
  for(const [scenario,pattern] of [['malformed',/could not read/],['missing',/could not read/],['init-error',/bad client/],['exit',/stopped before answering \(exit code 3\)/]]){
    const f=await probe(scenario);
    try{assert.equal(f.result.status,'error',scenario);assert.match(f.result.error,pattern,scenario);await gone(f.spawns);}finally{await f.cleanup();}
  }
});

test('a server request is refused at once and the read still completes; a silent server is stopped at the deadline',async()=>{
  const f=await probe('server-request');
  try{
    assert.equal(f.result.status,'ok');assert.equal(f.result.plan,'plus','the fake answers only once the refusal has reached it');
    const refusal=(await f.sent()).find(message=>message.id==='srv-1');
    assert.deepEqual(refusal,{jsonrpc:'2.0',id:'srv-1',error:{code:-32601,message:'Summon does not answer requests while reading usage.'}});
    await gone(f.spawns);
  }finally{await f.cleanup();}
  const started=Date.now();
  const hang=await probe('hang',{timeoutMs:300});
  try{
    assert.equal(hang.result.status,'error');assert.match(hang.result.error,/did not answer in time/);
    assert.ok(Date.now()-started<3000,'the deadline bounds the exchange');
    assert.ok((await hang.sent()).every(message=>message.method!=='thread/start'));
    await gone(hang.spawns);
  }finally{await hang.cleanup();}
});

test('a missing CLI is reported without spawning anything',async()=>{
  const result=await readCodexUsage({executable:async()=>{throw new Error('codex is not installed. Install it, then restart Summon.');},spawnChild:()=>assert.fail('nothing spawns when the CLI is missing'),now:()=>NOW});
  assert.deepEqual(result,{provider:'codex',plan:null,status:'not_installed',windows:[],fetchedAt:'2026-09-19T21:00:00.000Z',error:'codex is not installed. Install it, then restart Summon.'});
});
