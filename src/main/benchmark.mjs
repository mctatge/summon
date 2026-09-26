import {readFile,writeFile,rename,stat} from 'node:fs/promises';
import path from 'node:path';

export const BENCHMARK_SOURCE='https://aistupidlevel.info/';
export const PUBLIC_BENCHMARK_URL='https://aistupidlevel.info/dashboard/cached?period=latest&sortBy=combined&analyticsPeriod=latest';
export const BENCHMARK_TTL_MS=3600000;
const MAX_BYTES=1_000_000;
const CATEGORIES=new Set(['combined','coding','reasoning','speed']);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const clean=(value,max=120)=>typeof value==='string'?value.replace(/[\p{Cc}\p{Cf}]/gu,' ').replace(/\s+/g,' ').trim().slice(0,max):'';
const date=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
const score=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=100?value:null;
const synthetic=row=>row?.synthetic===true||row?.isSynthetic===true||/synthetic|simulated|demo/i.test(`${row?.dataSource??''} ${row?.source??''} ${row?.name??''}`);
const unrankable=row=>row?.rankable===false||row?.degraded===true||/synthetic|simulated|demo|estimated|unmeasured|degraded|offline|failed|error|unavailable|critical|warning/i.test(`${row?.dataSource??''} ${row?.status??''}`);
const stale=row=>row?.isStale===true||row?.stale===true;

/** The public dashboard and the keyed API have different envelopes, but keep the same model identities. */
export function normalizeModels(payload){
  const rows=Array.isArray(payload?.data)?payload.data:payload?.data?.modelScores;
  if(payload?.success!==true||!Array.isArray(rows))throw new Error('AI Stupid Level returned an unfamiliar response. Open the source to check it.');
  const models=rows.slice(0,500).filter(row=>object(row)&&clean(row.name)).map(row=>({
    name:clean(row.name),score:score(row.currentScore??row.score),id:clean(String(row.id??''),80),
    provider:clean(row.provider??row.vendor,40).toLowerCase(),lastUpdated:date(row.lastUpdated),
    status:clean(row.status,40).toLowerCase(),isStale:stale(row)||stale(payload)||stale(payload.meta),rankable:[row,payload,payload.meta].some(unrankable)?false:typeof row.rankable==='boolean'?row.rankable:null,
    synthetic:synthetic(row)||synthetic(payload)||synthetic(payload.meta),
  }));
  if(!models.length)throw new Error('The source did not return model rankings.');
  return models;
}

async function readResponse(response){
  const length=Number(response.headers?.get?.('content-length'));
  if(length>MAX_BYTES)throw new Error('Benchmark response was too large.');
  if(!response.body?.getReader){const text=await response.text();if(Buffer.byteLength(text)>MAX_BYTES)throw new Error('Benchmark response was too large.');return text;}
  const reader=response.body.getReader(),chunks=[];let bytes=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>MAX_BYTES)throw new Error('Benchmark response was too large.');chunks.push(Buffer.from(value));}return Buffer.concat(chunks).toString('utf8');}
  finally{await reader.cancel().catch(()=>{});}
}
function validCache(entry,key){
  if(!object(entry)||entry.source!==BENCHMARK_SOURCE||!date(entry.fetchedAt)||!CATEGORIES.has(entry.category)||!Array.isArray(entry.models)||!entry.models.length||entry.models.length>500)return false;
  if(key!==`${entry.sourceKind}:${entry.category}`||!['data-api','public-dashboard'].includes(entry.sourceKind))return false;
  if(entry.sourceKind==='public-dashboard'&&entry.category!=='combined')return false;
  return entry.models.every(row=>object(row)&&typeof row.name==='string'&&clean(row.name)===row.name&&row.name.length>0&&(row.score===null||score(row.score)!==null)&&typeof row.provider==='string'&&typeof row.synthetic==='boolean'&&typeof row.isStale==='boolean'&&(row.rankable===null||typeof row.rankable==='boolean')&&(row.lastUpdated===null||date(row.lastUpdated)===row.lastUpdated));
}

/** Read only on a ranking request or an explicit Claude launch. No timers, model inference or private context. */
export function createBenchmark({dataDir,getKey=async()=>'',onUpdate=()=>{},fetcher=fetch,now=Date.now}){
  const cachePath=path.join(dataDir,'benchmark-cache.json');let cache={};let pendingWrite=Promise.resolve();const inflight=new Map();
  const retryAt=new Map();
  const ready=(async()=>{try{if((await stat(cachePath)).size>MAX_BYTES)return;const parsed=JSON.parse(await readFile(cachePath,'utf8'));if(parsed?.version===2&&object(parsed.entries))cache=Object.fromEntries(Object.entries(parsed.entries).filter(([key,value])=>validCache(value,key)));}catch{}})();
  const present=(entry,requestedCategory)=>{
    const result={...entry,requestedCategory};
    if(entry.category!==requestedCategory)result.notice=[entry.notice,'The public feed supplies combined rankings. Add a data API key in Preferences for category-specific ordering.'].filter(Boolean).join(' ');
    onUpdate(result);return result;
  };
  return async(requestedCategory='combined')=>{
    if(!CATEGORIES.has(requestedCategory))throw new Error('Unknown benchmark category.');
    await ready;
    const key=await getKey();
    const sourceKind=key?'data-api':'public-dashboard';
    const category=key?requestedCategory:'combined',cacheKey=`${sourceKind}:${category}`;
    const cached=cache[cacheKey],age=cached?now()-Date.parse(cached.fetchedAt):Infinity;
    if(age>=0&&age<BENCHMARK_TTL_MS)return present({...cached,stale:false,cached:true},requestedCategory);
    if(inflight.has(cacheKey))return present(await inflight.get(cacheKey),requestedCategory);
    const request=Promise.resolve().then(async()=>{
      try{
        if(now()<(retryAt.get(sourceKind)||0))throw new Error(`The source rate limit was reached. Try again after ${new Date(retryAt.get(sourceKind)).toISOString()}.`);
        const url=key?`https://aistupidlevel.info/api/v1/models?period=latest&sortBy=${category}`:PUBLIC_BENCHMARK_URL;
        const response=await fetcher(url,{headers:{Accept:'application/json',...(key?{Authorization:`Bearer ${key}`}:{})},signal:AbortSignal.timeout(12000),redirect:'error'});
        if(!response.ok){
          if(response.status===429){const retry=response.headers?.get?.('retry-after'),seconds=Number(retry);retryAt.set(sourceKind,now()+Math.max(60000,Math.min(86400000,retry&&Number.isFinite(seconds)?seconds*1000:(Date.parse(retry)-now())||60000)));}
          throw new Error(response.status===401?(key?'The benchmark key was rejected. Update it in Preferences.':'The public benchmark feed requires a data key now. Add one in Preferences.'):response.status===429?'The source rate limit was reached. Try later or open the website.':`AI Stupid Level could not load (${response.status}).`);
        }
        const payload=JSON.parse(await readResponse(response));
        // A changed public envelope must not silently become a different source or category.
        if(!key&&(!object(payload?.data)||payload.meta?.sortBy!=='combined'))throw new Error('The public benchmark feed changed. Open the source or configure its data API.');
        const result={fetchedAt:new Date(now()).toISOString(),source:BENCHMARK_SOURCE,sourceKind,category,actualCategory:'combined',metric:'Combined score',sourceUpdatedAt:date(payload.generated_at??payload.meta?.cachedAt),models:normalizeModels(payload)};
        cache[cacheKey]=result;
        pendingWrite=pendingWrite.catch(()=>{}).then(async()=>{await writeFile(cachePath+'.tmp',JSON.stringify({version:2,entries:cache}),{mode:0o600});await rename(cachePath+'.tmp',cachePath);});
        try{await pendingWrite;}catch{return {...result,stale:false,cached:false,notice:'Rankings loaded, but their local cache could not be saved.'};}
        return {...result,stale:false,cached:false};
      }catch(error){
        const message=error.name==='TimeoutError'||error.name==='AbortError'?'AI Stupid Level did not answer in time.':error instanceof SyntaxError?'AI Stupid Level returned an unreadable response.':String(error.message||'The benchmark source could not be read.');
        return {...(cached||{fetchedAt:'',source:BENCHMARK_SOURCE,sourceKind,category,actualCategory:category,metric:'Combined score',models:[]}),stale:true,cached:Boolean(cached),error:`${message}${cached?' Showing the previous cached result.':''}`};
      }finally{inflight.delete(cacheKey);}
    });inflight.set(cacheKey,request);return present(await request,requestedCategory);
  };
}
