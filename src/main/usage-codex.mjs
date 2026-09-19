import {createRequire} from 'node:module';
import {scrubbedEnv,spawnLongLived,executable as findExecutable} from './process.mjs';
import {authText,errorText,exchange,isoAt,percent,plainPlan,report,unanswered,windowLabel} from './usage-probe.mjs';

// How much of the ChatGPT/Codex plan is used, as the Codex CLI itself reports it: one `codex app-server`, the
// JSON-RPC handshake, one account/rateLimits/read, then stdin ends and the group is stopped. No thread is started
// and no turn is run. Sign-in belongs to the CLI; Summon never sees a token. Credits, account ids and upsell text
// in the answer are dropped, and windows are named by their duration, never by their position.
const {version:SUMMON_VERSION}=createRequire(import.meta.url)('../../package.json');
const UNREADABLE='Codex returned an answer Summon could not read.';
const isObject=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const authError=error=>!!error&&typeof error==='object'&&(error.codexErrorInfo==='unauthorized'||error.data?.codexErrorInfo==='unauthorized'||authText(errorText(error)));
const windowId=minutes=>minutes===300?'five_hour':minutes===10080?'seven_day':`${Math.round(minutes)}m`;

export async function readCodexUsage({executable=findExecutable,spawnChild=spawnLongLived,timeoutMs=15_000,now=()=>Date.now()}={}){
  const fetchedAt=new Date(now()).toISOString(),done=(status,extra)=>report('codex',fetchedAt,status,extra);
  let binary;
  try{binary=typeof executable==='string'?executable:await executable('codex');}catch(error){return done('not_installed',{error:error.message});}
  const outcome=await exchange({binary,args:['app-server'],env:scrubbedEnv({RUST_LOG:'warn'}),spawnChild,timeoutMs,
    open:send=>send({jsonrpc:'2.0',id:1,method:'initialize',params:{clientInfo:{name:'summon',title:'Summon',version:SUMMON_VERSION},capabilities:{}}}),
    onMessage:(message,send)=>{
      // A server request gets a refusal at once so the exchange cannot hang on it; nothing is approved while reading usage.
      if(message.id!==undefined&&message.id!==null&&typeof message.method==='string'){send({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Summon does not answer requests while reading usage.'}});return undefined;}
      if(typeof message.method==='string'){
        if(message.method==='error'&&message.params?.willRetry!==true&&authError(message.params?.error))return {error:message.params.error};
        return undefined;
      }
      if(message.id===1){
        if(message.error)return {error:message.error};
        send({jsonrpc:'2.0',method:'initialized',params:{}});
        send({jsonrpc:'2.0',id:2,method:'account/rateLimits/read',params:{excludeResetCreditDetails:true}});
        return undefined;
      }
      if(message.id===2)return message.error?{error:message.error}:{result:message.result};
      return undefined;
    }});
  if(outcome.kind!=='answered'){const {status,error}=unanswered('Codex',outcome);return done(status,{error});}
  const {error,result}=outcome.value;
  if(error){const text=errorText(error)||'Codex returned an error.';return done(authError(error)||outcome.authSeen?'not_signed_in':'error',{error:text});}
  if(!isObject(result)||!Object.hasOwn(result,'rateLimits'))return done('error',{error:UNREADABLE});
  const limits=result.rateLimits;
  if(limits===null)return done('not_applicable');
  if(!isObject(limits))return done('error',{error:UNREADABLE});
  const plan=plainPlan(limits.planType),windows=[],seen=new Set();
  for(const key of ['primary','secondary']){
    const window=limits[key];if(!isObject(window))continue;
    const usedPercent=percent(window.usedPercent),minutes=Number(window.windowDurationMins);
    if(usedPercent===null||!Number.isFinite(minutes)||minutes<=0)continue;
    const id=windowId(minutes);if(seen.has(id))continue;seen.add(id);
    windows.push({id,label:windowLabel(id),usedPercent,resetsAt:isoAt(window.resetsAt)});
  }
  return done('ok',{plan,windows});
}
