import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,writeFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {normalizeModels,createBenchmark,BENCHMARK_SOURCE,PUBLIC_BENCHMARK_URL,BENCHMARK_TTL_MS} from '../src/main/benchmark.mjs';
import {selectClaudeModel} from '../src/main/model-selection.mjs';

const START=Date.parse('2026-09-20T12:00:00Z');
const row={id:'claude-opus',name:'Claude Opus',provider:'Anthropic',currentScore:90,lastUpdated:'2026-09-20T11:00:00Z',status:'active',rankable:true};
const publicPayload=(rows=[row],extra={})=>({success:true,data:{modelScores:rows},meta:{sortBy:'combined',cachedAt:'2026-09-20T11:30:00Z'},...extra});
const apiPayload=(rows=[row])=>({success:true,data:rows,generated_at:'2026-09-20T11:30:00Z'});
const response=(payload,{status=200,headers={}}={})=>({ok:status>=200&&status<300,status,headers:{get:name=>headers[name]??null},text:async()=>typeof payload==='string'?payload:JSON.stringify(payload)});
async function fixture(t){
  const dir=await mkdtemp(path.join(tmpdir(),'summon-bench-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  return {dir,file:path.join(dir,'benchmark-cache.json')};
}
const normalizedRow={name:'Claude Opus',score:90,id:'claude-opus',provider:'anthropic',lastUpdated:'2026-09-20T11:00:00.000Z',status:'active',isStale:false,rankable:true,synthetic:false};
const cacheEntry=()=>({fetchedAt:new Date(START).toISOString(),source:BENCHMARK_SOURCE,sourceKind:'public-dashboard',category:'combined',actualCategory:'combined',metric:'Combined score',sourceUpdatedAt:'2026-09-20T11:30:00.000Z',models:[normalizedRow]});

test('rankings require successful public or API envelopes and normalize source metadata',()=>{
  for(const payload of [null,{models:[{name:'fake'}]},{success:false,data:[row]},{success:true,data:{}},{success:true,data:[]}])assert.throws(()=>normalizeModels(payload));
  assert.deepEqual(normalizeModels(apiPayload()),[normalizedRow]);
  assert.deepEqual(normalizeModels(publicPayload()),[normalizedRow]);
});
test('normalization drops malformed rows, bounds scores, cleans strings and marks synthetic data',()=>{
  const result=normalizeModels(publicPayload([null,[],false,'model',{},
    {...row,name:'  Claude\u0000  Opus  ',currentScore:null,score:89,provider:' ANTHROPIC ',lastUpdated:'bad date'},
    {name:'Missing score'},
    {name:'Over range',currentScore:101},
    {name:'Negative',currentScore:-1},
    {name:'String score',currentScore:'98'},
    {name:'Demo model',currentScore:100},
  ]));
  assert.equal(result.length,6);
  assert.equal(result[0].name,'Claude Opus');assert.equal(result[0].provider,'anthropic');
  assert.equal(result[0].score,89);assert.equal(result[0].lastUpdated,null);
  assert.deepEqual(result.slice(1,5).map(item=>item.score),[null,null,null,null]);
  assert.equal(result[5].synthetic,true);
  assert.equal(normalizeModels(publicPayload([row],{synthetic:true}))[0].synthetic,true);
  assert.equal(normalizeModels(publicPayload([row],{meta:{sortBy:'combined',dataSource:'simulated'}}))[0].synthetic,true);
  assert.equal(normalizeModels(apiPayload(Array.from({length:510},()=>row))).length,500);
});
test('keyless lookup uses the fixed public URL without auth and persists only normalized data',async t=>{
  const {dir,file}=await fixture(t);let count=0;const updates=[];
  const lookup=createBenchmark({dataDir:dir,now:()=>START,onUpdate:value=>updates.push(value),fetcher:async(url,options)=>{
    count++;assert.equal(url,PUBLIC_BENCHMARK_URL);assert.deepEqual(options.headers,{Accept:'application/json'});
    assert.equal(options.redirect,'error');assert.ok(options.signal instanceof AbortSignal);
    return response(publicPayload([{...row,apiKey:'payload-secret',arbitrary:{private:'raw-data'}}],{raw:'private-payload'}));
  }});
  const result=await lookup();
  assert.equal(count,1);assert.equal(updates.length,1);assert.deepEqual(updates[0],result);
  assert.equal(result.source,BENCHMARK_SOURCE);assert.equal(result.sourceKind,'public-dashboard');
  assert.equal(result.category,'combined');assert.equal(result.actualCategory,'combined');assert.equal(result.requestedCategory,'combined');
  assert.equal(result.sourceUpdatedAt,'2026-09-20T11:30:00.000Z');assert.equal(result.fetchedAt,new Date(START).toISOString());
  assert.equal(result.stale,false);assert.equal(result.cached,false);assert.deepEqual(result.models,[normalizedRow]);
  const raw=await readFile(file,'utf8'),cache=JSON.parse(raw);
  assert.equal(cache.version,2);assert.deepEqual(Object.keys(cache.entries),['public-dashboard:combined']);
  assert.deepEqual(cache.entries['public-dashboard:combined'].models,[normalizedRow]);
  assert.doesNotMatch(raw,/payload-secret|raw-data|private-payload|apiKey/);
  assert.equal((await stat(file)).mode&0o777,0o600);
});
test('fresh public cache survives restart and avoids network for every requested category',async t=>{
  const {dir}=await fixture(t);let count=0;
  const options={dataDir:dir,now:()=>START,fetcher:async()=>{count++;return response(publicPayload());}};
  const lookup=createBenchmark(options);await lookup();
  for(const category of ['combined','coding','reasoning','speed']){
    const result=await createBenchmark(options)(category);
    assert.equal(result.cached,true);assert.equal(result.stale,false);assert.equal(result.requestedCategory,category);assert.equal(result.category,'combined');
    if(category!=='combined')assert.match(result.notice,/combined rankings/);
  }
  assert.equal(count,1);
});
test('simultaneous public categories share one request and one combined cache entry',async t=>{
  const {dir,file}=await fixture(t);let count=0,release,entered;
  const ready=new Promise(resolve=>{entered=resolve;}),blocked=new Promise(resolve=>{release=resolve;});
  const lookup=createBenchmark({dataDir:dir,now:()=>START,fetcher:async()=>{count++;entered();await blocked;return response(publicPayload());}});
  const pending=['coding','reasoning','speed'].map(category=>lookup(category));
  await ready;release();const results=await Promise.all(pending);
  assert.equal(count,1);assert.deepEqual(results.map(result=>result.requestedCategory),['coding','reasoning','speed']);
  assert.ok(results.every(result=>result.category==='combined'&&/combined rankings/.test(result.notice)));
  assert.deepEqual(Object.keys(JSON.parse(await readFile(file,'utf8')).entries),['public-dashboard:combined']);
});
test('keyed lookup uses official category endpoints, caches separately and never persists credentials',async t=>{
  const {dir,file}=await fixture(t);const urls=[];
  const options={dataDir:dir,now:()=>START,getKey:async()=>'fixture-private-key',fetcher:async(url,options)=>{
    urls.push(url);assert.equal(options.headers.Authorization,'Bearer fixture-private-key');return response(apiPayload());
  }};
  const lookup=createBenchmark(options);
  const results=await Promise.all([lookup('coding'),lookup('reasoning')]);
  assert.ok(results.every(result=>!result.error&&result.sourceKind==='data-api'));
  assert.ok(results.every(result=>result.actualCategory==='combined'),'category ordering must not relabel currentScore as a coding or reasoning score');
  assert.deepEqual(urls.sort(),['https://aistupidlevel.info/api/v1/models?period=latest&sortBy=coding','https://aistupidlevel.info/api/v1/models?period=latest&sortBy=reasoning']);
  await createBenchmark(options)('coding');assert.equal(urls.length,2);
  const raw=await readFile(file,'utf8'),cache=JSON.parse(raw);
  assert.deepEqual(Object.keys(cache.entries).sort(),['data-api:coding','data-api:reasoning']);
  assert.doesNotMatch(raw,/fixture-private-key|Authorization|Bearer/);
});
test('rejected API key does not fall back to the public endpoint or public cache',async t=>{
  const {dir}=await fixture(t);await createBenchmark({dataDir:dir,now:()=>START,fetcher:async()=>response(publicPayload())})();
  const urls=[];const lookup=createBenchmark({dataDir:dir,now:()=>START,getKey:async()=>'rejected-key',fetcher:async url=>{urls.push(url);return response('',{status:401});}});
  const result=await lookup('coding');
  assert.equal(urls.length,1);assert.match(urls[0],/\/api\/v1\/models/);assert.match(result.error,/key was rejected/);
  assert.deepEqual(result.models,[]);assert.equal(result.cached,false);
});
test('expired cache is retained with its original timestamp and an explicit stale error',async t=>{
  const {dir,file}=await fixture(t);let current=START,count=0;
  const lookup=createBenchmark({dataDir:dir,now:()=>current,fetcher:async()=>{count++;if(count===1)return response(publicPayload());throw new Error('Network unavailable');}});
  await lookup();const saved=await readFile(file,'utf8');current+=BENCHMARK_TTL_MS;
  const result=await lookup('coding');
  assert.equal(count,2);assert.equal(result.cached,true);assert.equal(result.stale,true);assert.equal(result.fetchedAt,new Date(START).toISOString());
  assert.deepEqual(result.models,[normalizedRow]);assert.match(result.error,/Network unavailable.*previous cached result/);
  assert.equal(await readFile(file,'utf8'),saved);
});
test('cache from the future is refreshed instead of treated as fresh',async t=>{
  const {dir,file}=await fixture(t);const entry=cacheEntry();entry.fetchedAt=new Date(START+BENCHMARK_TTL_MS).toISOString();
  await writeFile(file,JSON.stringify({version:2,entries:{'public-dashboard:combined':entry}}));
  let count=0;const result=await createBenchmark({dataDir:dir,now:()=>START,fetcher:async()=>{count++;return response(publicPayload());}})();
  assert.equal(count,1);assert.equal(result.cached,false);assert.equal(result.fetchedAt,new Date(START).toISOString());
});
test('invalid or legacy caches cannot supply rankings when the source fails',async t=>{
  const cases=[
    'not JSON',JSON.stringify({combined:cacheEntry()}),
    JSON.stringify({version:2,entries:{'public-dashboard:combined':{...cacheEntry(),source:'https://untrusted.example/'}}}),
    JSON.stringify({version:2,entries:{'public-dashboard:coding':{...cacheEntry(),category:'coding'}}}),
    JSON.stringify({version:2,entries:{'public-dashboard:combined':{...cacheEntry(),models:[{name:'Bad',score:99}]}}}),
    JSON.stringify({version:2,entries:{'public-dashboard:combined':{...cacheEntry(),models:[{...normalizedRow,score:101}]}}}),
    JSON.stringify({version:2,entries:{'public-dashboard:combined':{...cacheEntry(),fetchedAt:'invalid'}}}),
    ' '.repeat(1_000_001),
  ];
  for(const raw of cases){
    const {dir,file}=await fixture(t);await writeFile(file,raw);let count=0;
    const result=await createBenchmark({dataDir:dir,now:()=>START,fetcher:async()=>{count++;throw new Error('Offline');}})();
    assert.equal(count,1);assert.equal(result.cached,false);assert.deepEqual(result.models,[]);assert.match(result.error,/Offline/);
  }
});
test('changed public envelope, malformed JSON and empty rankings are errors without cache writes',async t=>{
  for(const payload of [apiPayload(),publicPayload([row],{meta:{sortBy:'coding'}}),publicPayload([null,{},'bad']),'not JSON']){
    const {dir,file}=await fixture(t);
    const result=await createBenchmark({dataDir:dir,now:()=>START,fetcher:async()=>response(payload)})();
    assert.equal(result.stale,true);assert.ok(result.error);assert.deepEqual(result.models,[]);
    await assert.rejects(()=>stat(file),{code:'ENOENT'});
  }
});
test('response size cap permits its byte boundary and rejects oversized headers, text and streams',async t=>{
  const serialized=JSON.stringify(publicPayload()),boundary=serialized+' '.repeat(1_000_000-Buffer.byteLength(serialized));
  const {dir}=await fixture(t);const allowed=await createBenchmark({dataDir:dir,now:()=>START,fetcher:async()=>response(boundary)})();
  assert.equal(allowed.error,undefined);
  const variants=[
    ()=>response(serialized,{headers:{'content-length':'1000001'}}),
    ()=>response(boundary+' '),
    ()=>response(serialized+'é'.repeat(500_000)),
    ()=>new Response(boundary+' ',{headers:{'content-type':'application/json'}}),
  ];
  for(const makeResponse of variants){
    const {dir,file}=await fixture(t);const result=await createBenchmark({dataDir:dir,now:()=>START,fetcher:async()=>makeResponse()})();
    assert.match(result.error,/too large/);assert.deepEqual(result.models,[]);await assert.rejects(()=>stat(file),{code:'ENOENT'});
  }
});
test('keyed 429 cooldown honors Retry-After across categories and recovers after the delay',async t=>{
  const {dir}=await fixture(t);let current=START,count=0;
  const lookup=createBenchmark({dataDir:dir,now:()=>current,getKey:async()=>'fixture-key',fetcher:async()=>{
    count++;return count===1?response('',{status:429,headers:{'retry-after':'120'}}):response(apiPayload());
  }});
  assert.match((await lookup('coding')).error,/rate limit/);
  current+=119_999;assert.match((await lookup('reasoning')).error,/rate limit/);assert.equal(count,1);
  current++;assert.equal((await lookup('reasoning')).error,undefined);assert.equal(count,2);
});
test('public 429 cooldown prevents repeated requests without blocking a later keyed source',async t=>{
  const {dir}=await fixture(t);let current=START,key='',count=0;
  const lookup=createBenchmark({dataDir:dir,now:()=>current,getKey:async()=>key,fetcher:async()=>{
    count++;return count===1?response('',{status:429,headers:{'retry-after':'120'}}):response(apiPayload());
  }});
  assert.match((await lookup()).error,/rate limit/);
  current+=1000;assert.match((await lookup('coding')).error,/rate limit/);assert.equal(count,1);
  key='fixture-key';assert.equal((await lookup('coding')).error,undefined);assert.equal(count,2);
});
test('invalid categories fail before any network access',async t=>{
  const {dir}=await fixture(t);let count=0;
  const lookup=createBenchmark({dataDir:dir,fetcher:async()=>{count++;return response(publicPayload());}});
  await assert.rejects(()=>lookup('coding&key=secret'),/Unknown benchmark category/);assert.equal(count,0);
});
test('source and row health flags survive ingestion so unhealthy rankings cannot select a launch model',async t=>{
  const measured={...row,name:'claude-opus-4-8'};
  const supportedModels=[{id:measured.name,model:measured.name}];
  for(const flags of [{degraded:true},{stale:true},{isStale:true},{rankable:false},{dataSource:'estimated'},{status:'degraded'}]){
    for(const scope of ['row','payload','meta']){
      const {dir}=await fixture(t);
      const payload=publicPayload([{...measured,...(scope==='row'?flags:{})}]);
      if(scope==='payload')Object.assign(payload,flags);
      if(scope==='meta')Object.assign(payload.meta,flags);
      const rankings=await createBenchmark({dataDir:dir,now:()=>START,fetcher:async()=>response(payload)})();
      assert.equal(rankings.error,undefined);
      assert.equal(selectClaudeModel(rankings,{supportedModels,now:START}).model,null,`${scope}: ${JSON.stringify(flags)}`);
    }
  }
});
test('cache write failure and combined-feed notice both remain visible',async t=>{
  const {dir,file}=await fixture(t);await mkdir(file+'.tmp');
  const result=await createBenchmark({dataDir:dir,now:()=>START,fetcher:async()=>response(publicPayload())})('coding');
  assert.equal(result.error,undefined);assert.equal(result.stale,false);assert.equal(result.cached,false);
  assert.match(result.notice,/cache could not be saved/);assert.match(result.notice,/combined rankings/);
  await assert.rejects(()=>stat(file),{code:'ENOENT'});
});
