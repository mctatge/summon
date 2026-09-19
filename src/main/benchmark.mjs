import {readFile,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';

export function normalizeModels(payload){
  if(payload?.success!==true||!Array.isArray(payload.data))throw new Error('AI Stupid Level returned an unfamiliar response. Open the source to check it.');
  const models=payload.data.slice(0,100).filter(row=>typeof row.name==='string').map(row=>({name:row.name.slice(0,120),score:typeof row.currentScore==='number'&&Number.isFinite(row.currentScore)?row.currentScore:null}));
  if(!models.length)throw new Error('The source did not return model rankings.');
  return models;
}
export function createBenchmark({dataDir,getKey,onUpdate,fetcher=fetch}){
  const cachePath=path.join(dataDir,'benchmark-cache.json');let cache={};let pendingWrite=Promise.resolve();const inflight=new Map();
  const ready=readFile(cachePath,'utf8').then(x=>{const parsed=JSON.parse(x);if(parsed&&typeof parsed==='object')cache=parsed;}).catch(()=>{});
  return async(category='combined')=>{
    await ready;
    if(!['combined','coding','reasoning','speed'].includes(category))throw new Error('Unknown benchmark category.');
    const cached=cache[category];
    if(cached&&Date.now()-Date.parse(cached.fetchedAt)<3600000){onUpdate(cached);return cached;}
    const key=await getKey();
    if(!key){const result={fetchedAt:'',source:'https://aistupidlevel.info/',models:[],error:'Add your AI Stupid Level data key in Settings for direct rankings, or open the website.'};onUpdate(result);return result;}
    if(inflight.has(category))return inflight.get(category);
    const request=(async()=>{
      try{
        const url=`https://aistupidlevel.info/api/v1/models?period=latest&sortBy=${category}`;
        const response=await fetcher(url,{headers:{Authorization:`Bearer ${key}`,Accept:'application/json'},signal:AbortSignal.timeout(12000),redirect:'error'});
        if(!response.ok)throw new Error(response.status===401?'The benchmark key was rejected. Update it in Settings.':response.status===429?'The source rate limit was reached. Try later or open the website.':`AI Stupid Level could not load (${response.status}).`);
        const body=await response.text();if(body.length>1000000)throw new Error('Benchmark response was too large.');
        const result={fetchedAt:new Date().toISOString(),source:'https://aistupidlevel.info/',category,models:normalizeModels(JSON.parse(body))};
        cache[category]=result;
        pendingWrite=pendingWrite.catch(()=>{}).then(async()=>{await writeFile(cachePath+'.tmp',JSON.stringify(cache),{mode:0o600});await rename(cachePath+'.tmp',cachePath);});
        await pendingWrite;onUpdate(result);return result;
      }catch(error){const result={...(cached||{fetchedAt:'',source:'https://aistupidlevel.info/',models:[]}),error:`${error.message}${cached?' Showing the previous cached result.':''}`};onUpdate(result);return result;}
      finally{inflight.delete(category);}
    })();inflight.set(category,request);return request;
  };
}
