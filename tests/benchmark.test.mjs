import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {normalizeModels,createBenchmark} from '../src/main/benchmark.mjs';
test('rankings require the documented successful envelope',()=>{
  assert.throws(()=>normalizeModels({models:[{name:'fake'}]}));
  assert.deepEqual(normalizeModels({success:true,data:[{name:'Example',currentScore:84}]}),[{name:'Example',score:84}]);
});
test('no data key causes no network request',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'summon-bench-'));let count=0;
  try{const lookup=createBenchmark({dataDir:dir,getKey:async()=>'',onUpdate:()=>{},fetcher:async()=>count++});const result=await lookup();assert.equal(count,0);assert.match(result.error,/key/);assert.deepEqual(result.models,[]);}finally{await rm(dir,{recursive:true,force:true});}
});
test('successful lookup persists cache and repeated requests avoid network',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'summon-bench-'));let count=0;
  try{
    const fetcher=async(url,options)=>{count++;assert.match(url,/sortBy=coding/);assert.equal(options.redirect,'error');return {ok:true,text:async()=>JSON.stringify({success:true,data:[{name:'Sample',currentScore:90}]})};};
    const options={dataDir:dir,getKey:async()=>'fixture-key',onUpdate:()=>{},fetcher};const lookup=createBenchmark(options);await lookup('coding');await lookup('coding');assert.equal(count,1);
    await createBenchmark(options)('coding');assert.equal(count,1);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('simultaneous categories retain both cache results',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'summon-bench-'));
  try{
    const lookup=createBenchmark({dataDir:dir,getKey:async()=>'fixture-key',onUpdate:()=>{},fetcher:async()=>({ok:true,text:async()=>JSON.stringify({success:true,data:[{name:'Sample',currentScore:90}]})})});
    const results=await Promise.all([lookup('coding'),lookup('reasoning')]);
    assert.ok(results.every(result=>!result.error));
    const cache=JSON.parse(await readFile(path.join(dir,'benchmark-cache.json'),'utf8'));
    assert.equal(cache.coding.models[0].name,'Sample');assert.equal(cache.reasoning.models[0].name,'Sample');
  }finally{await rm(dir,{recursive:true,force:true});}
});
