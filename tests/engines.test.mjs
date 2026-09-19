import test from 'node:test';
import assert from 'node:assert/strict';
import {restrictedCodexArgs,claudeFailure} from '../src/main/engines.mjs';
import {run} from '../src/main/process.mjs';
test('Codex answers disable action surfaces and user configuration while preserving sandbox',()=>{
  const args=restrictedCodexArgs();assert.ok(args.includes('--ignore-user-config'));assert.ok(args.includes('--ephemeral'));assert.equal(args[args.indexOf('--sandbox')+1],'read-only');
  const disabled=args.flatMap((x,i)=>x==='--disable'?[args[i+1]]:[]);
  for(const name of ['shell_tool','apps','plugins','hooks','browser_use','computer_use','multi_agent','image_generation','in_app_local_automation'])assert.ok(disabled.includes(name));
  assert.ok(args.includes('mcp_servers={}'));assert.ok(args.includes('approval_policy="never"'));assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
});
test('Claude JSON authentication failures survive nonzero process exits',async()=>{
  const response={is_error:true,result:'Failed to authenticate. API Error: 401 OAuth access token has expired.'};
  const program=`process.stdout.write(${JSON.stringify(JSON.stringify(response))});process.exitCode=1;`;
  let failure;
  try{await run(process.execPath,['-e',program]);}catch(error){failure=error;}
  assert.equal(failure.exitCode,1);
  assert.match(claudeFailure(failure).message,/Reconnect Claude/);
  assert.equal(JSON.stringify(failure),'{}');
});
test('Claude failures preserve non-auth errors and do not mask process timeouts',()=>{
  const timeout=new Error('The operation timed out.');
  assert.equal(claudeFailure(timeout),timeout);
  const quota=Object.assign(new Error('Exited 1'),{stdout:JSON.stringify({is_error:true,result:'Usage limit reached.'})});
  assert.equal(claudeFailure(quota).message,'Usage limit reached.');
  const malformed=Object.assign(new Error('Invalid response'),{stdout:'not json'});
  assert.equal(claudeFailure(malformed),malformed);
});
