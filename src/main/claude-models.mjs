import {scrubbedEnv,spawnLongLived,executable as findExecutable} from './process.mjs';
import {authText,cleanText,exchange,unanswered} from './usage-probe.mjs';
import {CLAUDE_USAGE_ARGS,CLAUDE_USAGE_ENV} from './usage-claude.mjs';

// The CLI's own initialization catalog resolves aliases for this installation/account. Like the usage probe,
// this exchange sends no user message, takes no model turn, attaches no MCP servers and disables hooks.
// A second read-only usage request confirms subscription access; initialization alone can also describe API-key
// accounts and gateways. Only resolved model identities leave this reader; unrelated account data is discarded.
export const CLAUDE_MODELS_REQUEST=Object.freeze({type:'control_request',request_id:'models-1',request:{subtype:'initialize'}});
export const CLAUDE_MODELS_USAGE_REQUEST=Object.freeze({type:'control_request',request_id:'models-usage-1',request:{subtype:'get_usage',skip_behaviors:true}});
const isObject=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const MODEL=/^claude-(?:opus|sonnet|haiku|fable)-\d+(?:-\d+)*(?:\[1m\])?$/;

export function normalizeClaudeModels(rows){
  if(!Array.isArray(rows))return [];
  const models=new Map();
  for(const row of rows.slice(0,100)){
    if(!isObject(row)||typeof row.resolvedModel!=='string'||!MODEL.test(row.resolvedModel)||row.resolvedModel.length>100)continue;
    const model=row.resolvedModel,id=model.replace(/\[1m\]$/,'');
    // Prefer the specific picker row's display name to the generic Default row.
    if(models.has(id)&&row.value==='default')continue;
    models.set(id,{id,model,name:cleanText(row.displayName,100)||id});
  }
  return [...models.values()];
}

export async function readClaudeModels({executable=findExecutable,spawnChild=spawnLongLived,cwd,timeoutMs=12_000,now=()=>Date.now()}={}){
  const fetchedAt=new Date(now()).toISOString();
  const done=(status,extra={})=>({status,fetchedAt,models:[],...extra});
  let binary;
  try{binary=typeof executable==='string'?executable:await executable('claude');}
  catch{return done('not_installed',{error:'Claude is not installed; using its configured default.'});}
  let catalog,usage;
  const outcome=await exchange({binary,args:[...CLAUDE_USAGE_ARGS],cwd,env:scrubbedEnv(CLAUDE_USAGE_ENV),spawnChild,timeoutMs,
    open:send=>{send(CLAUDE_MODELS_REQUEST);send(CLAUDE_MODELS_USAGE_REQUEST);},
    onMessage:message=>{
      if(message.type==='control_response'){
        const response=message.response;
        if(!isObject(response))return {malformed:true};
        if(![CLAUDE_MODELS_REQUEST.request_id,CLAUDE_MODELS_USAGE_REQUEST.request_id].includes(response.request_id))return undefined;
        if(response.subtype!=='success'||!isObject(response.response))return {malformed:true};
        if(response.request_id===CLAUDE_MODELS_REQUEST.request_id)catalog=response.response;
        else usage=response.response;
        return catalog&&usage?{catalog,usage}:undefined;
      }
      if(message.type==='result'&&message.is_error===true)return {failure:typeof message.result==='string'?message.result:'Claude could not initialize.'};
      return undefined;
    }});
  if(outcome.kind!=='answered')return done(unanswered('Claude',outcome).status,{error:'Claude could not report available models; using its configured default.'});
  const {failure,malformed}=outcome.value;
  if(failure)return done(authText(failure)?'not_signed_in':'error',{error:'Claude could not report available models; using its configured default.'});
  if(malformed||!catalog||!usage)return done('error',{error:'Claude returned an unfamiliar model catalog; using its configured default.'});
  if(catalog.account?.apiProvider!=='firstParty')return done('not_applicable',{error:'Benchmark selection is available for the first-party Claude provider; using its configured default.'});
  if(usage.rate_limits_available!==true||typeof usage.subscription_type!=='string'||!usage.subscription_type.trim())return done('not_applicable',{error:'Claude did not report subscription access; using its configured default.'});
  const models=normalizeClaudeModels(catalog.models);
  if(!models.length)return done('error',{error:'Claude did not report exact available model identities; using its configured default.'});
  return done('ok',{models});
}
