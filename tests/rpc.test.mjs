import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,lstat} from 'node:fs/promises';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRpcServer} from '../src/main/rpc.mjs';

test('MCP reads shared context over private socket and rejects unknown operations',async()=>{
  const dir=await mkdtemp('/tmp/summon-rpc-'),socketPath=dir+'/s.sock';
  const state={projects:[{id:'m',name:'Harbor'}],currentProjectId:'m',activity:null,settings:{paused:false},events:[],files:[],health:{}};
  const close=await createRpcServer({snapshot:()=>state,searchFiles:async()=>[],selectProject:async id=>{if(!state.projects.some(p=>p.id===id))throw new Error('Unknown project');state.currentProjectId=id;}},socketPath);
  try{
    assert.equal((await lstat(socketPath)).mode&0o777,0o600);
    const child=spawn(process.execPath,['scripts/mcp-server.mjs'],{env:{...process.env,SUMMON_SOCKET:socketPath},stdio:['pipe','pipe','pipe']});let data='';
    const result=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(new Error('MCP test timeout'));},5000);child.stdout.on('data',chunk=>{data+=chunk;const lines=data.trim().split('\n');if(lines.length===2){clearTimeout(timer);child.kill();resolve(lines.map(JSON.parse));}});});
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05'}})+'\n');
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'get_working_context',arguments:{}}})+'\n');
    const messages=await result;assert.equal(messages.find(m=>m.id===1).result.serverInfo.name,'summon');assert.equal(JSON.parse(messages.find(m=>m.id===2).result.content[0].text).currentProject.name,'Harbor');
    const response=await new Promise(resolve=>{const socket=net.connect(socketPath);let body='';socket.on('connect',()=>socket.write('{"method":"delete-file"}\n'));socket.on('data',chunk=>body+=chunk);socket.on('end',()=>resolve(JSON.parse(body)));});assert.match(response.error,/Unsupported/);
  }finally{await close();await rm(dir,{recursive:true,force:true});}
});
