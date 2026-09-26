import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {createDesktopTeachingBridge} from '../src/main/desktop-teaching-bridge.mjs';

function fixture(options={}){
  const requests=[];let starts=0,stops=0;
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
  child.stdin=new Writable({write(data,_encoding,done){requests.push(JSON.parse(data));done();}});
  const bridge=createDesktopTeachingBridge({binary:'/fixture/native',spawnChild(_binary,_args,spawnOptions){
    starts++;assert.equal(spawnOptions.env.ANTHROPIC_API_KEY,undefined);return {child,stop(){stops++;}};
  },...options});
  return {bridge,child,requests,get starts(){return starts;},get stops(){return stops;},reply(result,id=requests.at(-1).id){child.stdout.write(JSON.stringify({id,result})+'\n');}};
}
test('desktop bridge starts lazily, correlates responses, and closes pending requests',async()=>{
  const f=fixture();assert.equal(f.starts,0);
  const first=f.bridge.request('permissions'),second=f.bridge.request('apps');
  assert.equal(f.starts,1);f.reply([{bundleId:'fixture'}],f.requests[1].id);f.reply({accessibility:false},f.requests[0].id);
  assert.deepEqual(await first,{accessibility:false});assert.deepEqual(await second,[{bundleId:'fixture'}]);
  const pending=f.bridge.request('snapshot',{bundleId:'fixture'});f.bridge.close();
  await assert.rejects(pending,/closed/);await assert.rejects(f.bridge.request('apps'),/closed/);assert.equal(f.stops,1);
});
test('desktop bridge abort sends priority cancel and ignores late response',async()=>{
  const f=fixture(),controller=new AbortController();
  const result=f.bridge.request('execute',{controlId:'c1'},{signal:controller.signal});
  const executeId=f.requests[0].id;controller.abort();
  await assert.rejects(result,/cancelled/);assert.equal(f.requests[1].method,'cancel');
  f.reply({acted:true},executeId);f.reply({cancelled:true});
  const next=f.bridge.request('permissions');f.reply({accessibility:true});assert.deepEqual(await next,{accessibility:true});f.bridge.close();
});
test('desktop bridge refuses unsupported methods and already aborted work before spawning',async()=>{
  const f=fixture(),controller=new AbortController();controller.abort();
  await assert.rejects(f.bridge.request('shell'),/Unsupported/);
  await assert.rejects(f.bridge.request('apps',{}, {signal:controller.signal}),/cancelled/);
  assert.equal(f.starts,0);f.bridge.close();
});
test('desktop bridge kills malformed or oversized output without exposing stderr',async()=>{
  for(const data of ['not-json\n','x'.repeat(2049)]){
    const f=fixture({maxBytes:2048});const result=f.bridge.request('apps');
    f.child.stderr.write('private document content');f.child.stdout.write(data);
    await assert.rejects(result,/invalid JSON|exceeded/);assert.equal(f.stops,1);f.bridge.close();
  }
});
test('desktop bridge timeout kills helper and permits a fresh later request',async()=>{
  const f=fixture({timeoutMs:15});const result=f.bridge.request('snapshot');
  const rejected=assert.rejects(result,/timed out/);await new Promise(resolve=>setTimeout(resolve,25));await rejected;
  assert.equal(f.stops,1);assert.equal(f.bridge.status().running,false);f.bridge.close();
});
test('desktop bridge error responses are readable and streams preserve split Unicode',async()=>{
  const f=fixture();const result=f.bridge.request('apps');
  const bytes=Buffer.from(JSON.stringify({id:f.requests[0].id,result:[{name:'Éditeur'}]})+'\n');
  const split=bytes.indexOf(0xc3)+1;f.child.stdout.write(bytes.subarray(0,split));f.child.stdout.write(bytes.subarray(split));
  assert.deepEqual(await result,[{name:'Éditeur'}]);
  const denied=f.bridge.request('snapshot');f.child.stdout.write(JSON.stringify({id:f.requests.at(-1).id,error:'Accessibility permission is required.'})+'\n');
  await assert.rejects(denied,/Accessibility/);f.bridge.close();
});
test('desktop bridge forwards bounded recording status without starting a capture',async()=>{
  const f=fixture();const result=f.bridge.request('status');
  const status={recording:true,failure:null,eventCount:0,observationCount:0,activeInScope:false,activeApp:null};
  assert.equal(f.requests[0].method,'status');f.reply(status);
  assert.deepEqual(await result,status);f.bridge.close();
});
