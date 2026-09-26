import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {readClaudeModels,normalizeClaudeModels,CLAUDE_MODELS_REQUEST,CLAUDE_MODELS_USAGE_REQUEST} from '../src/main/claude-models.mjs';
import {CLAUDE_USAGE_ARGS} from '../src/main/usage-claude.mjs';

const NOW=Date.UTC(2026,8,20,22);
const rows=[
  {value:'default',resolvedModel:'claude-opus-5[1m]',displayName:'Default (recommended)'},
  {value:'opus[1m]',resolvedModel:'claude-opus-5[1m]',displayName:'Opus (1M context)'},
  {value:'sonnet',resolvedModel:'claude-sonnet-5',displayName:'Sonnet'},
  {value:'haiku',resolvedModel:'claude-haiku-4-5-20251001',displayName:'Haiku'},
];
const success=body=>({type:'control_response',response:{request_id:'models-1',subtype:'success',response:body}});
const subscription=body=>({type:'control_response',response:{request_id:'models-usage-1',subtype:'success',response:body}});
async function probe(messages,{timeoutMs=100,cwd='/private/tmp',usage={subscription_type:'max',rate_limits_available:true},...options}={}){
  const sent=[];let stopped=0,spawnOptions;
  const result=await readClaudeModels({executable:async name=>{assert.equal(name,'claude');return '/fixture/claude';},now:()=>NOW,cwd,timeoutMs,...options,spawnChild:(binary,args,extra)=>{
    assert.equal(binary,'/fixture/claude');assert.deepEqual(args,[...CLAUDE_USAGE_ARGS]);spawnOptions=extra;
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.stdin=new Writable({write(chunk,encoding,done){sent.push(JSON.parse(chunk.toString()));done();}});
    const keepAlive=setInterval(()=>{},1000);
    queueMicrotask(()=>{for(const message of [...messages,...(usage?[subscription(usage)]:[])])child.stdout.write(`${JSON.stringify(message)}\n`);});
    return {child,stop:async()=>{stopped++;clearInterval(keepAlive);child.stdout.destroy();child.stderr.destroy();}};
  }});
  return {result,sent,stopped,spawnOptions};
}

test('initialization reads exact resolved identities with no user turn and discards all unrelated account data',async t=>{
  const inheritedTrafficFlag=process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1';
  t.after(()=>{
    if(inheritedTrafficFlag===undefined)delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
    else process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=inheritedTrafficFlag;
  });
  const f=await probe([success({models:rows,account:{apiProvider:'firstParty',email:'private@example.test'},commands:['private-command'],session_state:'private'})]);
  assert.equal(f.result.status,'ok');assert.equal(f.result.fetchedAt,new Date(NOW).toISOString());
  assert.deepEqual(f.result.models,[{id:'claude-opus-5',model:'claude-opus-5[1m]',name:'Opus (1M context)'},{id:'claude-sonnet-5',model:'claude-sonnet-5',name:'Sonnet'},{id:'claude-haiku-4-5-20251001',model:'claude-haiku-4-5-20251001',name:'Haiku'}]);
  assert.deepEqual(f.sent,[CLAUDE_MODELS_REQUEST,CLAUDE_MODELS_USAGE_REQUEST]);assert.equal(f.stopped,1);assert.equal(f.spawnOptions.cwd,'/private/tmp');
  for(const key of ['ANTHROPIC_API_KEY','OPENAI_API_KEY','CODEX_API_KEY','CLAUDECODE','NODE_OPTIONS'])assert.equal(f.spawnOptions.env[key],undefined);
  assert.equal(f.spawnOptions.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,undefined,'subscription verification must not inherit the flag that blocks its usage endpoint');
  for(const key of ['DISABLE_TELEMETRY','DISABLE_ERROR_REPORTING','DISABLE_AUTOUPDATER','DISABLE_FEEDBACK_COMMAND'])assert.equal(f.spawnOptions.env[key],'1');
  assert.ok(!JSON.stringify(f.result).includes('private'));
});

test('catalog normalization never guesses identity from an alias, description or unsafe resolved model',()=>{
  assert.deepEqual(normalizeClaudeModels([{value:'sonnet',displayName:'Sonnet 5',description:'claude-sonnet-5'},{resolvedModel:'sonnet'},{resolvedModel:'claude-opus-5; echo bad'},{resolvedModel:'claude-sonnet-5\n'},{resolvedModel:'openai/gpt-5.5'},null]),[]);
  assert.deepEqual(normalizeClaudeModels(null),[]);
});

test('a response for a different control request is ignored',async()=>{
  const other=success({models:[{resolvedModel:'claude-opus-4-6'}],account:{apiProvider:'firstParty'}});other.response.request_id='other';
  const f=await probe([other,success({models:rows,account:{apiProvider:'firstParty'}})]);
  assert.equal(f.result.status,'ok');assert.ok(!f.result.models.some(row=>row.id==='claude-opus-4-6'));assert.equal(f.stopped,1);
});

test('custom provider catalogs and responses with unknown providers cannot change the launch model',async()=>{
  for(const apiProvider of ['bedrock','vertex','foundry',undefined]){
    const f=await probe([success({models:rows,account:{apiProvider}})]);assert.equal(f.result.status,'not_applicable');assert.deepEqual(f.result.models,[]);
  }
});

test('first-party initialization alone cannot opt API-key or unknown accounts into benchmark selection',async()=>{
  for(const usage of [{subscription_type:null,rate_limits_available:true},{subscription_type:'',rate_limits_available:true},{subscription_type:'max',rate_limits_available:false},{}]){
    const f=await probe([success({models:rows,account:{apiProvider:'firstParty'}})],{usage});
    assert.equal(f.result.status,'not_applicable');assert.deepEqual(f.result.models,[]);
  }
});

test('subscription verification can arrive first and does not require spare quota',async()=>{
  const f=await probe([subscription({subscription_type:'max',rate_limits_available:true,rate_limits:{five_hour:{utilization:100}}}),success({models:rows,account:{apiProvider:'firstParty'}})],{usage:null});
  assert.equal(f.result.status,'ok');assert.equal(f.result.models.length,3);assert.equal(f.stopped,1);
});

test('malformed and failed responses produce a default-model fallback without reflecting raw CLI errors',async()=>{
  for(const message of [success({models:[],account:{apiProvider:'firstParty'}}),{type:'control_response',response:null},{type:'control_response',response:{request_id:'models-1',subtype:'error',error:'private error text'}},{type:'result',is_error:true,result:'private error text'}]){
    const f=await probe([message]);assert.equal(f.result.status,'error');assert.deepEqual(f.result.models,[]);assert.ok(!JSON.stringify(f.result).includes('private error text'));assert.equal(f.stopped,1);
  }
});

test('a silent CLI is stopped at the bounded deadline',async()=>{
  const f=await probe([],{timeoutMs:20});assert.equal(f.result.status,'error');assert.deepEqual(f.result.models,[]);assert.equal(f.stopped,1);
});

test('a missing CLI does not spawn',async()=>{
  const result=await readClaudeModels({executable:async()=>{throw new Error('missing');},now:()=>NOW,spawnChild:()=>assert.fail('must not spawn')});
  assert.equal(result.status,'not_installed');assert.deepEqual(result.models,[]);
});
