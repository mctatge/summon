// A scripted stand-in for `codex app-server` (0.155.0-alpha.9.2). Message shapes
// copy a live probe from 2026-09-19; argv picks the scenario a turn plays out.
import {appendFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import readline from 'node:readline';

const arg=(name,fallback)=>{const i=process.argv.indexOf(`--${name}`);return i>=0?process.argv[i+1]:fallback;};
const flag=name=>process.argv.includes(`--${name}`);
const scenario=arg('scenario','complete'),idShape=arg('id-shape','thread.id'),log=arg('log'),pidsFile=arg('pids'),approvalKind=arg('approval-kind','commandExecution'),slowMs=Number(arg('slow-ms',0));
const THREAD='01a0ba8e-6bf8-72d2-a446-094c9d1eda32',OTHER='ffffffff-0000-4000-8000-000000000000';
const send=m=>process.stdout.write(JSON.stringify(m)+'\n');
const notify=(method,params)=>send({jsonrpc:'2.0',method,params});
const record=m=>{if(log)appendFileSync(log,JSON.stringify(m)+'\n');};
const pendingServer=new Map();let serverId=0,turnCount=0,interrupted=false,wake=null;
const ask=(method,params)=>new Promise(resolve=>{const id=`srv-${++serverId}`;pendingServer.set(id,resolve);send({jsonrpc:'2.0',id,method,params});});
const sleep=ms=>new Promise(resolve=>{wake=resolve;setTimeout(resolve,ms);});
if(pidsFile){const kid=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(pidsFile,JSON.stringify({pid:process.pid,kid:kid.pid}));}
process.stdout.write('fake codex app-server banner, not JSON\n');

const threadResult=()=>{
  const thread={id:THREAD,sessionId:THREAD,ephemeral:false,cwd:process.cwd(),status:{type:'idle'},cliVersion:'0.155.0-alpha.9.2'};
  if(idShape==='thread.id')return {thread};
  if(idShape==='thread.sessionId'){const {id,...rest}=thread;return {thread:rest};}
  if(idShape==='threadId')return {threadId:THREAD};
  if(idShape==='sessionId')return {sessionId:THREAD};
  return {thread:{}};
};
async function runTurn(id,params){
  const turnId=`turn-${++turnCount}`;interrupted=false;
  const scoped=extra=>({threadId:THREAD,turnId,...extra});
  send({jsonrpc:'2.0',id,result:{turn:{id:turnId,items:[],itemsView:'notLoaded',status:'inProgress',error:null}}});
  notify('thread/status/changed',{threadId:THREAD,status:{type:'active',activeFlags:[]}});
  notify('turn/started',{threadId:THREAD,turn:{id:turnId,items:[],status:'inProgress',error:null}});
  const userText=params.input?.[0]?.text??'';
  const user={type:'userMessage',id:'um-1',clientId:null,content:[{type:'text',text:userText,text_elements:[]}]};
  notify('item/started',scoped({item:user,startedAtMs:Date.now()}));notify('item/completed',scoped({item:user,completedAtMs:Date.now()}));
  if(flag('foreign')){
    notify('item/agentMessage/delta',{threadId:OTHER,turnId:'turn-x',itemId:'msg-x',delta:'FOREIGN-THREAD '});
    notify('item/agentMessage/delta',{threadId:THREAD,turnId:'turn-x',itemId:'msg-y',delta:'FOREIGN-TURN '});
    notify('item/completed',{threadId:OTHER,turnId:'turn-x',item:{type:'agentMessage',id:'msg-x',text:'FOREIGN',phase:'final_answer'}});
    notify('turn/completed',{threadId:OTHER,turn:{id:'turn-x',items:[],status:'failed',error:{message:'foreign failure'}}});
  }
  const complete=(status,items=[])=>{notify('thread/status/changed',{threadId:THREAD,status:{type:'idle'}});notify('turn/completed',{threadId:THREAD,turn:{id:turnId,items,status,error:null,startedAt:1,completedAt:2,durationMs:1}});};
  const say=text=>{
    const item={type:'agentMessage',id:`msg-${turnCount}`,text:'',phase:'final_answer',memoryCitation:null,delivery:null,questions:null};
    notify('item/started',scoped({item,startedAtMs:Date.now()}));
    for(const piece of [text.slice(0,3),text.slice(3)].filter(Boolean))notify('item/agentMessage/delta',scoped({itemId:item.id,delta:piece}));
    notify('item/completed',scoped({item:{...item,text},completedAtMs:Date.now()}));
    notify('thread/tokenUsage/updated',scoped({tokenUsage:{total:{totalTokens:10,inputTokens:9,outputTokens:1},last:{totalTokens:10,inputTokens:9,outputTokens:1},modelContextWindow:258400}}));
    complete('completed',[{...item,text}]);
  };
  const tool=async(type,id,body,work)=>{
    notify('item/started',scoped({item:{type,id,status:'inProgress',...body},startedAtMs:Date.now()}));
    const outcome=await work?.();
    notify('item/completed',scoped({item:{type,id,status:'completed',...body},completedAtMs:Date.now()}));
    return outcome;
  };
  switch(scenario){
    case 'complete':return say(`ready ${turnCount}`);
    case 'partial':notify('item/started',scoped({item:{type:'agentMessage',id:'msg-p',text:'',phase:'final_answer'}}));notify('item/agentMessage/delta',scoped({itemId:'msg-p',delta:'partial'}));await sleep(slowMs||1e9);return complete('interrupted');
    case 'approval':{
      const kind=approvalKind;
      const reply=await tool(kind,`${kind}-1`,kind==='fileChange'?{changes:[{path:'README.md',kind:'modify'}]}:{command:'ls -la',cwd:process.cwd()},()=>ask(`item/${kind}/requestApproval`,{itemId:`${kind}-1`,threadId:THREAD,turnId,startedAtMs:Date.now(),reason:'Look around',...(kind==='fileChange'?{grantRoot:null}:{command:'ls -la',cwd:process.cwd(),approvalId:null,kind:'command'})}));
      return say(`decision ${JSON.stringify(reply.result??reply.error)}`);
    }
    case 'requests':{
      const answers={};
      for(const [method,params] of [['fake/unknown',{}],['item/permissions/requestApproval',{itemId:'perm-1',cwd:process.cwd(),permissions:{network:{enabled:true}},reason:null,threadId:THREAD,turnId,startedAtMs:Date.now()}],['mcpServer/elicitation/request',{threadId:THREAD,turnId,serverName:'summon',requestedSchema:{type:'object'},message:'Allow?'}],['item/tool/requestUserInput',{isBlocking:true,itemId:'tool-1',questions:[{id:'q1',header:'Which',question:'Which one?'}],threadId:THREAD,turnId}]])answers[method]=await ask(method,params);
      return say(`answers ${JSON.stringify(answers)}`);
    }
    case 'silent':await tool('commandExecution','cmd-1',{command:'sleep 1',cwd:process.cwd()});await sleep(1e9);return complete('interrupted');
    // A genuine login failure: Codex logs it and dies. The client names it only because the process stopped.
    case 'stderr':return process.stderr.write('\x1b[2m2026-09-19T16:44:51.086443Z\x1b[0m \x1b[31mERROR\x1b[0m \x1b[2mcodex_core::auth\x1b[0m\x1b[2m:\x1b[0m failed to refresh access token: invalid_grant\n',()=>process.exit(1));
    // MCP-server OAuth chatter at WARN, exactly as the installed binary prints for codex_apps: not a sign-in failure.
    case 'stderr-noise':process.stderr.write('2026-09-19T16:44:51.776233Z  WARN codex_rmcp_client: OAuth token refresh failed for MCP server codex_apps; continuing without it\n');await sleep(20);return say('ready noise');
    // A retryable stream error: Codex reconnects on its own and the turn still completes.
    case 'error-retry':notify('error',{threadId:THREAD,turnId,error:{message:'stream disconnected before completion: 401 Unauthorized'},willRetry:true});await sleep(20);return say('ready after retry');
    case 'exit':notify('item/agentMessage/delta',scoped({itemId:'msg-e',delta:'half'}));return process.stdout.write('',()=>process.exit(3));
    default:return say(`unknown scenario ${scenario}`);
  }
}
readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on('line',line=>{
  let m;try{m=JSON.parse(line);}catch{return;}
  record(m);
  if(m.id!==undefined&&m.method===undefined){const resolve=pendingServer.get(m.id);if(resolve){pendingServer.delete(m.id);resolve(m);}return;}
  switch(m.method){
    case 'initialize':send({jsonrpc:'2.0',id:m.id,result:{userAgent:'summon/0.155.0-alpha.9.2 (fake)',codexHome:'/nonexistent/.codex',platformFamily:'unix',platformOs:'macos'}});notify('remoteControl/status/changed',{status:'disabled',serverName:'fake',installationId:'0',environmentId:null});return;
    case 'initialized':return;
    case 'thread/start':send({jsonrpc:'2.0',id:m.id,result:threadResult()});notify('thread/started',{thread:{id:THREAD,sessionId:THREAD}});notify('mcpServer/startupStatus/updated',{threadId:THREAD,name:'summon',status:'ready',error:null,failureReason:null});return;
    case 'turn/start':if(scenario==='rpc-auth'){send({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:'Failed to refresh ChatGPT credentials: 401 Unauthorized. Please login again.'}});return;}void runTurn(m.id,m.params||{});return;
    case 'turn/interrupt':send({jsonrpc:'2.0',id:m.id,result:{}});interrupted=true;wake?.();return;
    default:send({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:`Method not found: ${m.method}`}});
  }
}).on('close',()=>process.exit(0));
