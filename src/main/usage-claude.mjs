import {scrubbedEnv,spawnLongLived,executable as findExecutable} from './process.mjs';
import {WINDOWS,authText,exchange,isoAt,percent,plainPlan,report,unanswered,windowLabel} from './usage-probe.mjs';

// How much of the Claude subscription is used, as the Claude CLI itself reports it: one `claude -p` process with no
// tools, no MCP servers, no session file and no turn, answering a single get_usage control request over stream-json.
// No prompt is sent and no quota is spent. Sign-in belongs to the CLI (its own `auth status` is unreliable, so it is
// not consulted); Summon never sees a token. Not passed on purpose: --setting-sources '' and --bare hide the plan.
// Hooks are off for this process (--settings disableAllHooks) so an installed Summon reporter never sees the probe as
// a session. Disable optional background clients individually: CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC also blocks
// the usage endpoint in Claude 2.1.278. The CLI can still maintain its own configuration during startup.
export const CLAUDE_USAGE_ARGS=Object.freeze(['-p','--input-format','stream-json','--output-format','stream-json','--verbose','--max-turns','1','--tools','','--permission-mode','dontAsk','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--no-session-persistence','--disable-slash-commands','--settings','{"disableAllHooks":true}']);
export const CLAUDE_USAGE_ENV=Object.freeze({DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',DISABLE_AUTOUPDATER:'1',DISABLE_FEEDBACK_COMMAND:'1'});
const REQUEST_ID='usage-1';
export const CLAUDE_USAGE_REQUEST=Object.freeze({type:'control_request',request_id:REQUEST_ID,request:{subtype:'get_usage',skip_behaviors:true}});
const UNREADABLE='Claude returned an answer Summon could not read.';
const isObject=value=>!!value&&typeof value==='object'&&!Array.isArray(value);

export async function readClaudeUsage({executable=findExecutable,spawnChild=spawnLongLived,timeoutMs=15_000,now=()=>Date.now()}={}){
  const fetchedAt=new Date(now()).toISOString(),done=(status,extra)=>report('claude',fetchedAt,status,extra);
  let binary;
  try{binary=typeof executable==='string'?executable:await executable('claude');}catch(error){return done('not_installed',{error:error.message});}
  const outcome=await exchange({binary,args:[...CLAUDE_USAGE_ARGS],env:scrubbedEnv(CLAUDE_USAGE_ENV),spawnChild,timeoutMs,
    open:send=>send(CLAUDE_USAGE_REQUEST),
    onMessage:message=>{
      if(message.type==='control_response'){
        const response=message.response;
        if(!isObject(response))return {malformed:true};
        if(response.request_id!==undefined&&response.request_id!==REQUEST_ID)return undefined;
        return {response};
      }
      // A turn was never asked for, so a result line can only be the CLI reporting that it could not start one.
      if(message.type==='result'&&message.is_error===true)return {failure:typeof message.result==='string'?message.result:'Claude could not answer.'};
      return undefined;
    }});
  if(outcome.kind!=='answered'){const {status,error}=unanswered('Claude',outcome);return done(status,{error});}
  const {response,failure,malformed}=outcome.value;
  if(malformed)return done('error',{error:UNREADABLE});
  if(failure)return done(authText(failure)?'not_signed_in':'error',{error:failure});
  if(response.subtype==='error'){const text=typeof response.error==='string'?response.error:'Claude refused the usage request.';return done(authText(text)?'not_signed_in':'error',{error:text});}
  if(response.subtype!=='success'||!isObject(response.response))return done('error',{error:UNREADABLE});
  const body=response.response,plan=plainPlan(body.subscription_type);
  // No subscription, or limits the CLI will not report: nothing to meter, which is not the same as 0 % used.
  if(body.rate_limits_available!==true||!plan)return done('not_applicable',{plan});
  // rate_limits:null with the flag true means the CLI returned no limits, without identifying why: unknown, not 0 %.
  if(!isObject(body.rate_limits))return done('error',{plan,error:'Claude reported its plan but returned no usage limits.'});
  const limits=body.rate_limits,windows=[];
  for(const id of Object.keys(WINDOWS)){
    const window=limits[id];if(!isObject(window))continue;
    const usedPercent=percent(window.utilization);if(usedPercent===null)continue;
    windows.push({id,label:windowLabel(id),usedPercent,resetsAt:isoAt(window.resets_at)});
  }
  return done('ok',{plan,windows});
}
