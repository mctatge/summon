import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyCommand,executeCommand} from '../src/main/commands.mjs';
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
