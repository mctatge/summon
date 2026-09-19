import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {readClaudeUsage,CLAUDE_USAGE_ARGS,CLAUDE_USAGE_REQUEST} from '../src/main/usage-claude.mjs';
import {spawnLongLived} from '../src/main/process.mjs';

const fake=fileURLToPath(new URL('./fixtures/fake-claude-usage.mjs',import.meta.url));
const KEYS=['ANTHROPIC_API_KEY','OPENAI_API_KEY','CODEX_API_KEY'];
for(const key of KEYS)process.env[key]='test-never-forward';
process.env.CLAUDECODE='1';process.env.NODE_OPTIONS='--no-warnings';
after(()=>{for(const key of [...KEYS,'CLAUDECODE','NODE_OPTIONS'])delete process.env[key];});
const NOW=Date.UTC(2026,8,19,21,0,0);
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}};
async function until(check,label){for(let i=0;i<400;i++){if(check())return;await wait(10);}assert.fail(`${label} timed out.`);}
async function probe(scenario,options={}){
  const dir=await mkdtemp('/private/tmp/summon-usage-claude-'),log=path.join(dir,'log.jsonl'),spawns=[];
  const result=await readClaudeUsage({executable:async name=>{assert.equal(name,'claude');return 'claude-under-test';},now:()=>NOW,...options,spawnChild:(binary,args,spawnOptions)=>{
    assert.equal(binary,'claude-under-test');assert.deepEqual(args,[...CLAUDE_USAGE_ARGS]);
    assert.ok(!args.includes('--setting-sources')&&!args.includes('--bare'),'flags that hide the plan are never passed');
    assert.ok(!args.some(arg=>/[a-z]{6,}\s[a-z]{3,}/.test(arg)),'no prompt text goes to the CLI');
    for(const key of [...KEYS,'NODE_OPTIONS','CLAUDECODE'])assert.equal(spawnOptions.env[key],undefined);
    assert.ok(spawnOptions.env.HOME&&spawnOptions.env.USER,'the allowlist keeps HOME and USER, which the CLI needs to find its login');
    assert.equal(spawnOptions.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,'1','the probe must not make the CLI rewrite ~/.claude.json or rotate its backups');
    assert.equal(args[args.indexOf('--settings')+1],'{"disableAllHooks":true}','hooks are off inside the probe so an installed reporter never sees it as a session');
    const handle=spawnLongLived(process.execPath,[fake,'--scenario',scenario,'--log',log],spawnOptions);spawns.push(handle);return handle;
  }});
  const sent=async()=>(await readFile(log,'utf8').catch(()=>'')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  return {result,sent,spawns,cleanup:()=>rm(dir,{recursive:true,force:true})};
}
const gone=async spawns=>{for(const handle of spawns)await until(()=>!alive(handle.child.pid),'child exit');};

test('one control request, no prompt, no turn: the plan and the four named windows come back, nothing else',async()=>{
  const f=await probe('ok');
  try{
    assert.deepEqual(f.result,{provider:'claude',plan:'max',status:'ok',windows:[
      {id:'five_hour',label:'5h',usedPercent:27.3,resetsAt:'2026-09-19T23:00:00.000Z'},
      {id:'seven_day',label:'7d',usedPercent:18,resetsAt:'2026-09-23T14:00:00.000Z'},
      {id:'seven_day_sonnet',label:'7d Sonnet',usedPercent:2.5,resetsAt:'2026-09-23T14:00:00.000Z'}],fetchedAt:'2026-09-19T21:00:00.000Z'});
    const text=JSON.stringify(f.result);
    for(const dropped of ['internal_pool','overage','session_cost','behaviors','context','seven_day_opus'])assert.ok(!text.includes(dropped),`${dropped} is dropped`);
    assert.deepEqual(await f.sent(),[CLAUDE_USAGE_REQUEST],'exactly one line goes to the CLI, and it is the usage request');
    assert.equal(f.spawns.length,1);
    await gone(f.spawns);
  }finally{await f.cleanup();}
});

test('junk lines around the answer are ignored',async()=>{
  const f=await probe('noisy');
  try{assert.equal(f.result.status,'ok');assert.equal(f.result.windows.length,3);await gone(f.spawns);}finally{await f.cleanup();}
});

test('limits the CLI could not fetch are a read failure, not 0 % and not a routable reading',async()=>{
  const f=await probe('null-limits');
  try{assert.deepEqual(f.result,{provider:'claude',plan:'max',status:'error',windows:[],fetchedAt:'2026-09-19T21:00:00.000Z',error:'Claude could not fetch its limits; its usage endpoint did not answer.'});await gone(f.spawns);}
  finally{await f.cleanup();}
});

test('no subscription or no reportable limits is not applicable, never 0 %',async()=>{
  for(const [scenario,plan] of [['not-signed-in',null],['no-plan',null],['no-limits','max']]){
    const f=await probe(scenario);
    try{assert.deepEqual(f.result,{provider:'claude',plan,status:'not_applicable',windows:[],fetchedAt:'2026-09-19T21:00:00.000Z'},scenario);await gone(f.spawns);}
    finally{await f.cleanup();}
  }
});

test('an explicit sign-in failure is not signed in; any other refusal is an error with the CLI text',async()=>{
  for(const [scenario,status,pattern] of [['auth-refused','not_signed_in',/OAuth session expired/],['auth-result','not_signed_in',/Failed to authenticate/],['exit-auth','not_signed_in',/sign-in problem/],['refused','error',/Unknown control request/],['exit','error',/stopped before answering \(exit code 2\)/]]){
    const f=await probe(scenario);
    try{assert.equal(f.result.status,status,scenario);assert.match(f.result.error,pattern,scenario);assert.deepEqual(f.result.windows,[]);await gone(f.spawns);}
    finally{await f.cleanup();}
  }
});

test('an answer Summon cannot read is an error, and a silent CLI is stopped at the deadline',async()=>{
  for(const scenario of ['malformed','unwrapped']){
    const f=await probe(scenario);
    try{assert.equal(f.result.status,'error');assert.match(f.result.error,/could not read/);await gone(f.spawns);}finally{await f.cleanup();}
  }
  const started=Date.now();
  const f=await probe('hang',{timeoutMs:300});
  try{
    assert.equal(f.result.status,'error');assert.match(f.result.error,/did not answer in time/);
    assert.ok(Date.now()-started<3000,'the deadline bounds the exchange');
    await gone(f.spawns);
  }finally{await f.cleanup();}
});

test('a missing CLI is reported without spawning anything',async()=>{
  const result=await readClaudeUsage({executable:async()=>{throw new Error('claude is not installed. Install it, then restart Summon.');},spawnChild:()=>assert.fail('nothing spawns when the CLI is missing'),now:()=>NOW});
  assert.deepEqual(result,{provider:'claude',plan:null,status:'not_installed',windows:[],fetchedAt:'2026-09-19T21:00:00.000Z',error:'claude is not installed. Install it, then restart Summon.'});
});
