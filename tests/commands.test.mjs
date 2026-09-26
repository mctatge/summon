import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyCommand,executeCommand} from '../src/main/commands.mjs';
import {createCommandSession} from '../src/main/command-session.mjs';
const projects=[{id:'m',name:'Harbor',path:'/workspace/Harbor'}];
test('only explicit calendar commands invoke calendar',()=>{
  assert.equal(classifyCommand('pull up my calendar',projects).type,'calendar');
  for(const input of ['do not open my calendar','why should I open my calendar','delete everything; open calendar','https://example.com'])assert.equal(classifyCommand(input,projects).type,'unknown');
});
test('workspace switching resolves existing exact names',()=>{
  assert.deepEqual(classifyCommand("I'm working on Harbor",projects),{type:'project',projectId:'m'});
  assert.equal(classifyCommand('work on unknown',projects).type,'unknown-project');
});
test('benchmark categories use fixed source selectors',()=>{
  assert.deepEqual(classifyCommand('best coding model'),{type:'benchmark',category:'coding'});
  assert.equal(classifyCommand('open AI Stupid Level').type,'benchmark-open');
});
test('bare filenames and named searches use file lookup',()=>{
  assert.equal(classifyCommand('Forecast.xlsx').type,'files');
  assert.equal(classifyCommand('find September forecast').type,'files');
});
test('ambiguous file open returns candidates without opening',async()=>{
  let opened=0;const result=await executeCommand('open my Excel file',{service:{snapshot:()=>({projects}),searchFiles:async()=>[{id:'a'},{id:'b'}]},openFile:async()=>opened++});
  assert.equal(opened,0);assert.deepEqual(result.fileIds,['a','b']);
});
test('single file match opens only its validated ID',async()=>{
  let opened;await executeCommand('open my Excel file',{service:{snapshot:()=>({projects}),searchFiles:async()=>[{id:'a',name:'sheet.xlsx'}]},openFile:async id=>opened=id});assert.equal(opened,'a');
});
test('explicit agent session commands recognize both natural word orders',()=>{
  for(const input of ['start a new session in claude','start a new Claude session','open Claude Code session','please launch new Claude Code session!']){
    assert.deepEqual(classifyCommand(input,projects),{type:'agent-launch',app:'claude'},input);
  }
  for(const input of ['start a new Codex session','launch a session in Codex']){
    assert.deepEqual(classifyCommand(input,projects),{type:'agent-launch',app:'codex'},input);
  }
  for(const input of ['start a new session in Claude for Harbor','launch a Claude Code session in Harbor']){
    assert.deepEqual(classifyCommand(input,projects),{type:'agent-launch',app:'claude',projectId:'m'},input);
  }
});
test('session workspace names resolve exactly and reject ambiguous names',()=>{
  assert.deepEqual(classifyCommand('start a new Claude session for unknown',projects),{type:'unknown-launch-project',name:'unknown'});
  assert.equal(classifyCommand('start a new Claude session for Har',projects).type,'unknown-launch-project');
  assert.deepEqual(classifyCommand('start a new Claude session for Harbor',[...projects,{id:'other',name:'HARBOR'}]),{type:'ambiguous-launch-project',name:'harbor'});
});
test('questions, negation, quoted commands and extra shell or model arguments never launch sessions',()=>{
  for(const input of [
    'do not start a new Claude session',
    'why should I start a new Claude session',
    'if I say start a new Claude session',
    'tell me how to start a new Claude session',
    '"start a new Claude session"',
    'start a new Claude session; rm -rf /tmp/example',
    'start a new Claude session --model external-model',
    'start a new Claude session using the best model',
  ])assert.notEqual(classifyCommand(input,projects).type,'agent-launch',input);
});
test('session launch uses the selected saved workspace and reports the model decision',async()=>{
  const calls=[];
  const result=await executeCommand('start a new session in Claude',{
    service:{snapshot:()=>({projects,currentProjectId:'m'})},
    launchAgent:async args=>{calls.push(args);return {modelSelection:{model:'opus',name:'Claude Opus',reason:'Highest coding benchmark among supported Claude models.'}};},
  });
  assert.deepEqual(calls,[{app:'claude',projectId:'m'}]);
  assert.equal(result.kind,'message');
  assert.match(result.message,/Started a new Claude session in Harbor/);
  assert.match(result.message,/Recommended model: Claude Opus/);
  assert.match(result.message,/Highest coding benchmark/);
});
test('named session workspace overrides selection without forwarding raw text or flags',async()=>{
  let launched;
  const result=await executeCommand('launch a new Codex session for Harbor',{
    service:{snapshot:()=>({projects,currentProjectId:'another'})},
    launchAgent:async args=>{launched=args;return {};},
  });
  assert.deepEqual(launched,{app:'codex',projectId:'m'});
  assert.equal(result.message,'Started a new Codex session in Harbor.');
});
test('unknown, ambiguous, and absent workspace selection never invoke the launcher',async()=>{
  let launches=0;
  const launchAgent=async()=>{launches++;};
  for(const currentProjectId of [null,'deleted']){
    const result=await executeCommand('start a new Claude session',{service:{snapshot:()=>({projects,currentProjectId})},launchAgent});
    assert.match(result.message,/Choose a workspace first/);
  }
  const unknown=await executeCommand('start a new Claude session for missing',{service:{snapshot:()=>({projects,currentProjectId:'m'})},launchAgent});
  assert.match(unknown.message,/not a saved workspace/);
  const ambiguous=await executeCommand('start a new Claude session for Harbor',{service:{snapshot:()=>({projects:[...projects,{id:'other',name:'Harbor'}],currentProjectId:'m'})},launchAgent});
  assert.match(ambiguous.message,/More than one saved workspace/);
  assert.equal(launches,0);
});
test('failed session launch never reports success',async()=>{
  await assert.rejects(()=>executeCommand('start a new Claude session',{
    service:{snapshot:()=>({projects,currentProjectId:'m'})},
    launchAgent:async()=>{throw new Error('That folder no longer exists.');},
  }),/That folder no longer exists/);
});
test('session commands cannot become saved routines or execute from existing routines',async()=>{
  let launches=0;
  const session=createCommandSession({
    service:{snapshot:()=>({projects,currentProjectId:'m'})},
    knowledge:{prepareRoutine:async()=>({command:'start a new Claude session',actionType:'agent-launch'})},
    launchAgent:async()=>{launches++;return {};},
  });
  const result=await session.execute('start a new Claude session');
  assert.equal(result.routineReceiptId,undefined);
  await assert.rejects(()=>session.runRoutine('saved-launch'),/needs to be saved again/);
  assert.equal(launches,1);
});

test('session tasks and Claude family overrides use the bounded suffix grammar and preserve task casing',()=>{
  assert.deepEqual(classifyCommand('start a new session in Claude for Harbor to debug a race condition',projects),{type:'agent-launch',app:'claude',projectId:'m',task:'debug a race condition'});
  assert.deepEqual(classifyCommand('launch a Claude Code session using Opus to investigate API errors',projects),{type:'agent-launch',app:'claude',modelPreference:'opus',task:'investigate API errors'});
  assert.deepEqual(classifyCommand('open a new Claude session for Harbor using haiku to rewrite this briefly',projects),{type:'agent-launch',app:'claude',projectId:'m',modelPreference:'haiku',task:'rewrite this briefly'});
  assert.deepEqual(classifyCommand('start a new Codex session to implement an API endpoint',projects),{type:'agent-launch',app:'codex',task:'implement an API endpoint'});
  assert.deepEqual(classifyCommand('start a new Claude session to explain how to debug using sonnet',projects),{type:'agent-launch',app:'claude',task:'explain how to debug using sonnet'});
  for(const input of ['start a new Codex session using opus','start a new Claude session using external-model','start a new Claude session to','start a new Claude session using opus to',`start a new Claude session to ${'x'.repeat(1001)}`])assert.notEqual(classifyCommand(input,projects).type,'agent-launch',input);
});

test('workspace and task syntax cannot silently choose between two saved names',()=>{
  const overlapping=[...projects,{id:'special',name:'Harbor to debug'}];
  assert.deepEqual(classifyCommand('start a new Claude session for Harbor to debug',overlapping),{type:'ambiguous-launch-options'});
  assert.deepEqual(classifyCommand('start a new Claude session for Harbor to debug',[overlapping[1]]),{type:'agent-launch',app:'claude',projectId:'special'});
  assert.deepEqual(classifyCommand('start a new Claude session for Har using sonnet to debug',projects),{type:'unknown-launch-project',name:'har'});
  assert.equal(classifyCommand('start a new Claude session for Harbor using sonnet to debug',[...projects,{id:'duplicate',name:'Harbor'}]).type,'ambiguous-launch-project');
});

test('task launch forwards context and selected family but never repeats the task in its receipt',async()=>{
  let launched;
  const task='debug SECRET_CONTEXT';
  const result=await executeCommand(`start a new Claude session for Harbor using sonnet to ${task}`,{
    service:{snapshot:()=>({projects,currentProjectId:'another'})},
    launchAgent:async args=>{launched=args;return {modelSelection:{model:'claude-sonnet-5',name:'Sonnet 5',reason:'Your model choice.'},routing:{kind:'coding',complexity:'standard',effort:'medium',reason:'The request includes debugging.',effortSource:'task'}};},
  });
  assert.deepEqual(launched,{app:'claude',projectId:'m',task,modelPreference:'sonnet'});
  assert.match(result.message,/Task routing: coding, standard complexity; medium effort/);
  assert.match(result.message,/Enter it in the new session to begin/);
  assert.doesNotMatch(result.message,/SECRET_CONTEXT/);
  assert.equal(result.benchmarkSource,undefined,'manual catalog choice is not presented as benchmark evidence');
});
