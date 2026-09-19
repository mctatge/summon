import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {groupingArgs,runGrouping} from '../src/main/workstream-engine.mjs';
import {restrictedCodexArgs} from '../src/main/engines.mjs';
import {scrubbedEnv} from '../src/main/process.mjs';

const schema={type:'object',additionalProperties:false,required:['workstreams','branches'],properties:{workstreams:{type:'array'},branches:{type:'array'}}};
const answer={workstreams:[{title:'Docs: setup notes',summary:'Adds setup notes.',area:'docs',readiness:'ready',items:['F001'],shared_items:[],suggested_commit:'docs: add setup notes'}],branches:[]};
async function sandbox(t){const tmp=await mkdtemp('/private/tmp/summon-group-test-');t.after(()=>rm(tmp,{recursive:true,force:true}));return tmp;}
function fakes(tmp,respond){
  const calls=[];
  return {calls,deps:{tmp,executable:async name=>`/fake/bin/${name}`,scrubbedEnv,run:async(binary,args,options)=>{const call={binary,args,options,schemaFile:null};calls.push(call);const at=args.indexOf('--output-schema');if(at>=0)call.schemaFile=await readFile(args[at+1],'utf8');return respond(call);}}};
}

test('Codex grouping keeps every restricted flag and adds only the schema and effort before stdin',()=>{
  const args=groupingArgs('codex',{schemaPath:'/private/tmp/x/schema.json',effort:'high'});
  const base=restrictedCodexArgs();
  assert.equal(base.at(-1),'-');
  assert.deepEqual(args,[...base.slice(0,-1),'--output-schema','/private/tmp/x/schema.json','-c','model_reasoning_effort="high"','-']);
  assert.equal(args[args.indexOf('model_reasoning_effort="high"')-1],'-c');
  assert.ok(args.indexOf('--output-schema')>args.indexOf('mcp_servers={}'));
  assert.equal(args[args.indexOf('--sandbox')+1],'read-only');
  for(const flag of ['--ignore-user-config','--ephemeral','--ignore-rules','--skip-git-repo-check'])assert.ok(args.includes(flag));
  const disabled=args.flatMap((x,i)=>x==='--disable'?[args[i+1]]:[]);
  for(const name of ['shell_tool','apps','plugins','hooks','browser_use','computer_use','multi_agent','image_generation'])assert.ok(disabled.includes(name));
  assert.ok(!args.some(x=>/bypass|full-auto|danger/.test(x)));
  assert.equal(groupingArgs('codex',{schemaPath:'/s.json'}).find(x=>x.startsWith('model_reasoning_effort')),'model_reasoning_effort="medium"');
});
test('Claude grouping is tool-less, schema-bound and never names an API key',()=>{
  const args=groupingArgs('claude',{schemaJson:JSON.stringify(schema),effort:'low',claudeModel:'sonnet'});
  const value=flag=>args[args.indexOf(flag)+1];
  assert.equal(args[0],'-p');assert.ok(args.includes('--safe-mode'));
  assert.equal(value('--model'),'sonnet');assert.equal(value('--effort'),'low');assert.equal(value('--max-turns'),'1');
  assert.equal(value('--output-format'),'json');assert.equal(value('--json-schema'),JSON.stringify(schema));
  assert.equal(value('--tools'),'');assert.equal(value('--permission-mode'),'dontAsk');assert.equal(value('--mcp-config'),'{"mcpServers":{}}');
  assert.equal(value('--setting-sources'),'');
  for(const flag of ['--strict-mcp-config','--no-session-persistence','--disable-slash-commands'])assert.ok(args.includes(flag));
  assert.match(value('--system-prompt'),/No tools or actions/);
  assert.ok(!args.some(x=>/api[-_]?key|dangerously/i.test(x)));
  assert.deepEqual(groupingArgs('claude',{schemaJson:'{}'}).slice(0,6),['-p','--safe-mode','--model','opus','--effort','medium']);
});
test('grouping arguments reject unknown engines, efforts and models',()=>{
  assert.throws(()=>groupingArgs('gemini',{schemaJson:'{}'}),/Codex or Claude/);
  assert.throws(()=>groupingArgs('codex',{schemaPath:'/s.json',effort:'max"; rm'}),/effort/);
  assert.throws(()=>groupingArgs('claude',{schemaJson:'{}',claudeModel:'gpt'}),/Claude model/);
  assert.throws(()=>groupingArgs('codex',{}),/format/);
});
test('Codex grouping writes the schema privately, parses the last agent message and cleans up',async t=>{
  const tmp=await sandbox(t);
  const lines=[{type:'thread.started',thread_id:'t'},{type:'item.completed',item:{type:'agent_message',text:'thinking out loud'}},{type:'item.completed',item:{type:'agent_message',text:'```json\n'+JSON.stringify(answer)+'\n```'}},{type:'turn.completed'}];
  const {calls,deps}=fakes(tmp,()=>({stdout:lines.map(x=>JSON.stringify(x)).join('\n')+'\nnot json\n',stderr:''}));
  const process_=globalThis.process;process_.env.OPENAI_API_KEY='test-never-forward';process_.env.ANTHROPIC_API_KEY='test-never-forward';
  let result;
  try{result=await runGrouping('codex',{prompt:'F001 modified a.md',schema,effort:'low'},deps);}
  finally{delete process_.env.OPENAI_API_KEY;delete process_.env.ANTHROPIC_API_KEY;}
  assert.deepEqual(result,{raw:answer,model:null});
  const [call]=calls;
  assert.equal(call.binary,'/fake/bin/codex');
  assert.equal(call.options.input,'F001 modified a.md');assert.equal(call.options.timeout,300000);assert.equal(call.options.maxBytes,4_000_000);
  assert.equal(call.options.env.OPENAI_API_KEY,undefined);assert.equal(call.options.env.ANTHROPIC_API_KEY,undefined);
  assert.ok(call.options.cwd.startsWith(path.join(tmp,'summon-group-')));
  assert.deepEqual(JSON.parse(call.schemaFile),schema);
  assert.ok(call.args.includes('model_reasoning_effort="low"'));
  assert.deepEqual(await readdir(tmp),[]);
});
test('Codex grouping surfaces turn failures and unreadable answers',async t=>{
  const tmp=await sandbox(t);
  const failing=fakes(tmp,()=>({stdout:JSON.stringify({type:'turn.failed',error:{message:'Usage limit reached.'}})+'\n'}));
  await assert.rejects(runGrouping('codex',{prompt:'x',schema},failing.deps),/Usage limit reached/);
  const garbled=fakes(tmp,()=>({stdout:JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Sure! Here are your groups.'}})}));
  await assert.rejects(runGrouping('codex',{prompt:'x',schema},garbled.deps),/could not read/);
  const empty=fakes(tmp,()=>({stdout:''}));
  await assert.rejects(runGrouping('codex',{prompt:'x',schema},empty.deps),/no grouping/);
  const crashed=fakes(tmp,()=>{throw new Error('The operation timed out. Please try again.');});
  await assert.rejects(runGrouping('codex',{prompt:'x',schema},crashed.deps),/timed out/);
  assert.deepEqual(await readdir(tmp),[]);
});
test('Claude grouping prefers structured output, falls back to result text, and names the chosen model',async t=>{
  const tmp=await sandbox(t);
  const structured=fakes(tmp,()=>({stdout:JSON.stringify({type:'result',is_error:false,result:'',structured_output:answer})}));
  assert.deepEqual(await runGrouping('claude',{prompt:'x',schema,claudeModel:'haiku'},structured.deps),{raw:answer,model:'haiku'});
  const [call]=structured.calls;
  assert.equal(call.binary,'/fake/bin/claude');assert.equal(call.schemaFile,null);
  assert.equal(call.args[call.args.indexOf('--json-schema')+1],JSON.stringify(schema));
  assert.equal(call.options.env.ANTHROPIC_API_KEY,undefined);
  const text=fakes(tmp,()=>({stdout:JSON.stringify({is_error:false,result:JSON.stringify(answer)})}));
  assert.deepEqual((await runGrouping('claude',{prompt:'x',schema},text.deps)).raw,answer);
  assert.deepEqual(await readdir(tmp),[]);
});
test('Claude grouping explains expired logins whether the CLI exits cleanly or not',async t=>{
  const tmp=await sandbox(t);
  const expired={is_error:true,result:'Failed to authenticate. API Error: 401 OAuth access token has expired.'};
  const clean=fakes(tmp,()=>({stdout:JSON.stringify(expired)}));
  await assert.rejects(runGrouping('claude',{prompt:'x',schema},clean.deps),/Reconnect Claude/);
  const exited=fakes(tmp,()=>{throw Object.assign(new Error('exit 1'),{stdout:JSON.stringify(expired),exitCode:1});});
  await assert.rejects(runGrouping('claude',{prompt:'x',schema},exited.deps),/Reconnect Claude/);
  const other=fakes(tmp,()=>({stdout:JSON.stringify({is_error:true,subtype:'error_max_turns'})}));
  await assert.rejects(runGrouping('claude',{prompt:'x',schema},other.deps),/could not group/);
  const junk=fakes(tmp,()=>({stdout:'<html>'}));
  await assert.rejects(runGrouping('claude',{prompt:'x',schema},junk.deps),/could not read/);
});
test('grouping requests are validated before any process starts',async t=>{
  const tmp=await sandbox(t);
  const {calls,deps}=fakes(tmp,()=>({stdout:''}));
  await assert.rejects(runGrouping('ollama',{prompt:'x',schema},deps),/Codex or Claude/);
  await assert.rejects(runGrouping('codex',{prompt:'x',schema,effort:'ultra'},deps),/effort/);
  await assert.rejects(runGrouping('codex',{prompt:'',schema},deps),/empty/);
  await assert.rejects(runGrouping('codex',{prompt:'x'.repeat(400_001),schema},deps),/too large/);
  await assert.rejects(runGrouping('codex',{prompt:'x',schema:null},deps),/format/);
  const missing={...deps,executable:async()=>{throw new Error('codex is not installed. Install it, then restart Summon.');}};
  await assert.rejects(runGrouping('codex',{prompt:'x',schema},missing),/not installed/);
  assert.equal(calls.length,0);
  assert.deepEqual(await readdir(tmp),[]);
});
