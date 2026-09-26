import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,readFile,rm} from 'node:fs/promises';
import {runContextReasoning,CONTEXT_REASONING_LIMITS,CONTEXT_REASONING_SYSTEM_PROMPT} from '../src/main/context-engine.mjs';

const schema={type:'object',additionalProperties:false,required:['goals','sessions'],properties:{goals:{type:'array'},sessions:{type:'array'}}};
const raw={goals:[{title:'Finish workspace reasoning'}],sessions:[{id:'s1',title:'Connect current intent'}]};

test('local context reasoning uses the configured interpreter and never falls back',async()=>{
  const calls=[];
  const localModel={reasonContext:async request=>{calls.push(request);return {raw,model:'configured-local:latest'};}};
  const result=await runContextReasoning('local',{prompt:'recent evidence',schema},{localModel,runGrouping:()=>assert.fail('must stay local')});
  assert.deepEqual(result,{raw,model:'configured-local:latest'});
  assert.deepEqual(calls,[{prompt:'recent evidence',schema}]);
  await assert.rejects(runContextReasoning('local',{prompt:'x',schema}),/No cloud fallback/);
  await assert.rejects(runContextReasoning('local',{prompt:'x',schema},{localModel:{reasonContext:()=>{throw new Error('Ollama unavailable');}},runGrouping:()=>assert.fail('must stay local')}),/Ollama unavailable/);
});

test('context adapter forwards only the selected cloud engine and reasoning instructions',async()=>{
  for(const engine of ['claude','codex']){
    let received;
    const result=await runContextReasoning(engine,{prompt:'recent evidence',schema},{runGrouping:async(...args)=>{received=args;return {raw,model:'model'};},tmp:'/tmp/reasoning'});
    assert.deepEqual(result,{raw,model:'model'});
    assert.deepEqual(received,[engine,{prompt:'recent evidence',schema,effort:'medium',claudeModel:'sonnet',systemPrompt:CONTEXT_REASONING_SYSTEM_PROMPT},{tmp:'/tmp/reasoning'}]);
  }
});

test('context reasoning rejects invalid requests before invoking any model',async()=>{
  const deps={runGrouping:()=>assert.fail('invalid request invoked a CLI'),localModel:{reasonContext:()=>assert.fail('invalid request invoked local model')}};
  await assert.rejects(runContextReasoning('auto',{prompt:'x',schema},deps),/Choose/);
  for(const engine of ['local','claude','codex']){
    await assert.rejects(runContextReasoning(engine,{prompt:'',schema},deps),/empty/);
    await assert.rejects(runContextReasoning(engine,{prompt:'x'.repeat(CONTEXT_REASONING_LIMITS.promptBytes+1),schema},deps),/too large/);
    await assert.rejects(runContextReasoning(engine,{prompt:'x',schema:[]},deps),/format/);
    await assert.rejects(runContextReasoning(engine,{prompt:'x',schema:{description:'x'.repeat(CONTEXT_REASONING_LIMITS.schemaBytes)}},deps),/too large/);
    const circular={};circular.self=circular;
    await assert.rejects(runContextReasoning(engine,{prompt:'x',schema:circular},deps),/invalid/);
  }
});

test('real CLI adapter keeps restricted invocation, uses reasoning instructions and cleans its empty working folder',async t=>{
  const tmp=await mkdtemp('/private/tmp/summon-context-engine-test-');
  t.after(()=>rm(tmp,{recursive:true,force:true}));
  for(const engine of ['claude','codex']){
    let call;
    const result=await runContextReasoning(engine,{prompt:'recent evidence',schema,effort:'low'},{
      tmp,executable:async name=>`/fake/${name}`,
      run:async(binary,args,options)=>{
        call={binary,args,options};
        if(engine==='codex'){
          assert.deepEqual(JSON.parse(await readFile(args[args.indexOf('--output-schema')+1],'utf8')),schema);
          return {stdout:JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(raw)}})};
        }
        return {stdout:JSON.stringify({is_error:false,structured_output:raw})};
      },
    });
    assert.deepEqual(result.raw,raw);
    assert.equal(call.binary,`/fake/${engine}`);
    assert.equal(call.options.env.ANTHROPIC_API_KEY,undefined);
    assert.equal(call.options.env.OPENAI_API_KEY,undefined);
    const value=flag=>call.args[call.args.indexOf(flag)+1];
    if(engine==='claude'){
      assert.equal(value('--system-prompt'),CONTEXT_REASONING_SYSTEM_PROMPT);
      assert.equal(value('--tools'),'');
      assert.equal(value('--mcp-config'),'{"mcpServers":{}}');
      assert.equal(value('--setting-sources'),'');
      assert.equal(value('--permission-mode'),'dontAsk');
      assert.equal(call.options.input,'recent evidence');
      assert.equal(value('--model'),'sonnet');
    }else{
      assert.equal(value('--sandbox'),'read-only');
      assert.ok(call.args.includes('--ignore-user-config'));
      assert.ok(call.args.includes('--ignore-rules'));
      assert.ok(call.args.includes('mcp_servers={}'));
      assert.ok(call.args.includes('approval_policy="never"'));
      assert.ok(call.args.includes('web_search="disabled"'));
      const disabled=call.args.flatMap((arg,i)=>arg==='--disable'?[call.args[i+1]]:[]);
      for(const capability of ['shell_tool','apps','plugins','hooks','browser_use','computer_use','multi_agent'])assert.ok(disabled.includes(capability));
      assert.equal(call.options.input,`${CONTEXT_REASONING_SYSTEM_PROMPT}\n\nrecent evidence`);
    }
    assert.deepEqual(await readdir(tmp),[]);
  }
});
