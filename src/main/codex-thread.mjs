import {createRequire} from 'node:module';
import {spawnLongLived,scrubbedEnv,executable as findExecutable} from './process.mjs';

// A persistent `codex app-server` thread over newline JSON-RPC 2.0 on stdio.
// Sign-in belongs to the Codex CLI: this module never sees or forwards a token.
// Every string from the server (deltas, items, errors, stderr) is untrusted
// data that is passed through unchanged and never interpreted.
const {version:SUMMON_VERSION}=createRequire(import.meta.url)('../../package.json');
export const SIGN_IN_MESSAGE='Sign in to Codex in Terminal, then try again.';
// Sign-in failures are classified where the protocol reports them; stderr only corroborates an opaque stop,
// because Codex logs MCP-server OAuth chatter at WARN that has nothing to do with the ChatGPT login.
const AUTH_FAILURE=/invalid_grant|refresh token|\b401\b|unauthorized|please login|could not be refreshed|sign in again/i;
const TOOL_ITEMS=new Set(['commandExecution','fileChange','mcpToolCall','dynamicToolCall']);
const SANDBOXES=new Set(['read-only','workspace-write']);
const authFailure=text=>typeof text==='string'&&AUTH_FAILURE.test(text);
const authError=error=>!!error&&typeof error==='object'&&(error.codexErrorInfo==='unauthorized'||authFailure(error.message));
const redact=line=>line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g,'').replace(/[\x00-\x1f\x7f]/g,'').slice(0,300);
const errorText=error=>error?(typeof error==='string'?error:typeof error.message==='string'?error.message:JSON.stringify(error)):undefined;
// A notification is foreign only when it names a different thread or turn; unscoped ones are accepted.
const scopeIds=params=>({thread:params.threadId??params.thread_id??params.turn?.threadId??params.item?.threadId,turn:params.turnId??params.turn_id??params.turn?.id??params.item?.turnId});

export function createCodexThread({cwd,sandbox='read-only',developerInstructions,effort,ephemeral=false,executable,spawnChild=spawnLongLived,onEvent,onApproval=null,turnTimeoutMs=600_000,silenceTimeoutMs=90_000,approvalTimeoutMs=300_000,requestTimeoutMs=30_000,timers=globalThis}={}){
  if(typeof cwd!=='string'||!cwd)throw new Error('A Codex thread needs a working directory.');
  if(!SANDBOXES.has(sandbox))throw new Error('Codex sandbox must be read-only or workspace-write.');
  let state='new',reason=null,threadId=null,handle=null,child=null,startPromise=null,active=null,nextId=0,ignoredLines=0;
  const pending=new Map(),queued=[],stderrTail=[];
  const emit=event=>{try{onEvent?.(event);}catch{}};
  const after=(ms,fn)=>{const timer=timers.setTimeout(fn,ms);timer?.unref?.();return timer;};
  const cancel=timer=>{if(timer!==undefined&&timer!==null)timers.clearTimeout(timer);};
  const unavailable=()=>new Error(reason||(state==='closed'?'This Codex thread is closed.':state==='new'||state==='starting'?'Codex is still starting.':'Codex is not available.'));

  const write=message=>{
    if(!child||child.stdin.destroyed||!child.stdin.writable)return false;
    try{child.stdin.write(JSON.stringify(message)+'\n');return true;}catch{return false;}
  };
  const notify=(method,params)=>write({jsonrpc:'2.0',method,params});
  const respond=(id,result)=>write({jsonrpc:'2.0',id,result});
  const respondError=(id,code,message)=>write({jsonrpc:'2.0',id,error:{code,message}});
  const request=(method,params,timeoutMs=requestTimeoutMs)=>new Promise((resolve,reject)=>{
    if(state==='retired'||state==='closed')return reject(unavailable());
    const id=++nextId;
    const timer=after(timeoutMs,()=>{pending.delete(id);reject(new Error(`Codex did not answer ${method} in time.`));});
    pending.set(id,{resolve,reject,timer});
    if(!write({jsonrpc:'2.0',id,method,params})){pending.delete(id);cancel(timer);reject(unavailable());}
  });

  // `settle` is an interrupt round-trip already in flight: the child is stopped once it answers or times out.
  function retire(why,next='retired',settle=null){
    if(state==='retired'||state==='closed')return;
    state=next;reason=why;
    if(active)finish(active,{status:'retired',error:why});
    emit({type:'status',state,reason:why});
    const stop=()=>{for(const entry of pending.values()){cancel(entry.timer);entry.reject(new Error(why));}pending.clear();handle?.stop();};
    settle?settle.then(stop,stop):stop();
  }
  const tailAuth=()=>stderrTail.slice(-40).some(authFailure);
  // The 100 ms delay lets the last stderr chunk land, so an opaque exit can still be named a sign-in failure.
  const stopped=why=>{if(state==='retired'||state==='closed')return;after(100,()=>retire(tailAuth()?SIGN_IN_MESSAGE:why));};

  function finish(record,{status,error}){
    if(record.done)return;record.done=true;
    cancel(record.deadline);cancel(record.silence);record.signal?.removeEventListener('abort',record.onAbort);
    if(active===record)active=null;
    const result={text:record.final??record.deltas.join(''),status,turnId:record.turnId,interrupted:record.interrupted,...(error?{error}:{})};
    emit({type:'completed',...result});record.settle?.();record.resolve(result);
  }
  const interruptTurn=record=>{
    record.interrupted=true;
    if(!record.turnId||record.interruptSent)return Promise.resolve();
    record.interruptSent=true;
    // Bounded so retire-with-interrupt plus the group SIGTERM/SIGKILL ladder stays inside the app's 8 s quit budget.
    return request('turn/interrupt',{threadId,turnId:record.turnId},2000).catch(()=>{});
  };
  // Post-tool silence: armed when a tool item completes, refreshed by other item activity,
  // cleared by assistant text or an approval round-trip. Tripping means Codex wedged.
  const disarm=record=>{cancel(record.silence);record.silence=null;};
  const arm=record=>{disarm(record);record.silence=after(silenceTimeoutMs,()=>retire(`Codex went silent for ${Math.round(silenceTimeoutMs/1000)} s after a tool result. Start a new thread.`,'retired',interruptTurn(record)));};
  const refresh=record=>{if(record.silence)arm(record);};

  function onNotification(method,params){
    if(method==='thread/status/changed'&&(scopeIds(params).thread??threadId)===threadId)emit({type:'status',state,activity:params.status?.type});
    if(method==='error'){
      const {thread}=scopeIds(params);if(thread!==undefined&&thread!==null&&String(thread)!==threadId)return;
      // Codex owns login: a retryable error is Codex refreshing or reconnecting, not a verdict.
      if(params.willRetry===true){if(active)refresh(active);return emit({type:'status',state,activity:'retrying'});}
      if(authError(params.error))return retire(SIGN_IN_MESSAGE);
    }
    const record=active;if(!record)return;
    const {thread,turn}=scopeIds(params);
    if((thread!==undefined&&thread!==null&&String(thread)!==threadId)||(turn!==undefined&&turn!==null&&record.turnId&&String(turn)!==record.turnId))return;
    // turn/started arrives in the same chunk as the turn/start response, before its promise settles.
    if(method==='turn/started'&&!record.turnId&&typeof params.turn?.id==='string')record.turnId=params.turn.id;
    switch(method){
      case 'item/agentMessage/delta':{const text=typeof params.delta==='string'?params.delta:'';record.deltas.push(text);disarm(record);emit({type:'delta',turnId:record.turnId,itemId:params.itemId,text});return;}
      case 'item/started':{refresh(record);emit({type:'item',phase:'started',turnId:record.turnId,item:params.item});return;}
      case 'item/completed':{
        const item=params.item&&typeof params.item==='object'?params.item:{};
        if(item.type==='agentMessage'){record.final=typeof item.text==='string'?item.text:record.deltas.join('');disarm(record);}
        else if(TOOL_ITEMS.has(item.type))arm(record);else refresh(record);
        emit({type:'item',phase:'completed',turnId:record.turnId,item});return;
      }
      case 'turn/completed':{
        const turn=params.turn&&typeof params.turn==='object'?params.turn:{},error=errorText(turn.error);
        if(authFailure(error))return retire(SIGN_IN_MESSAGE);
        if(turn.status==='interrupted')record.interrupted=true;
        return finish(record,{status:typeof turn.status==='string'?turn.status:'completed',error});
      }
      default:if(method.startsWith('item/'))refresh(record);
    }
  }
  const drain=(limit=Infinity)=>{for(let n=0;queued.length&&n<limit;n++){const message=queued.shift();try{onNotification(message.method,message.params&&typeof message.params==='object'?message.params:{});}catch{}}};

  async function approval(kind,params){
    const record=active;
    if(typeof onApproval!=='function'||!record||record.done||(params.threadId&&params.threadId!==threadId))return 'decline';
    disarm(record);
    let timer;const settled=new Promise(resolve=>{record.settle=resolve;});
    try{
      const choice=await Promise.race([Promise.resolve().then(()=>onApproval(kind,params)),settled,new Promise(resolve=>{timer=after(approvalTimeoutMs,()=>resolve('timeout'));})]);
      return choice==='once'?'accept':choice==='session'?'acceptForSession':'decline';
    }catch{return 'decline';}finally{cancel(timer);record.settle=null;}
  }
  const decide=kind=>async params=>{
    const decision=await approval(kind,params);
    emit({type:'approval',kind,itemId:params.itemId,command:params.command,cwd:params.cwd,reason:params.reason,decision});
    return {decision};
  };
  const answers={
    'item/commandExecution/requestApproval':decide('commandExecution'),
    'item/fileChange/requestApproval':decide('fileChange'),
    // Permission escalation is never granted: an empty grant for this turn is the schema's decline.
    'item/permissions/requestApproval':()=>({permissions:{},scope:'turn'}),
    'mcpServer/elicitation/request':()=>({action:'decline'}),
    'item/tool/requestUserInput':()=>({answers:{}}),
  };
  function onServerRequest({id,method,params}){
    drain(8);
    const answer=answers[method];
    if(!answer)return respondError(id,-32601,`Summon does not support ${method}.`);
    Promise.resolve().then(()=>answer(params&&typeof params==='object'?params:{})).then(result=>respond(id,result),()=>respondError(id,-32603,'Summon could not answer this request.'));
  }
  function onResponse(message){
    const entry=pending.get(message.id);
    if(!entry)return;
    pending.delete(message.id);cancel(entry.timer);
    if(message.error){
      const text=errorText(message.error)||'Codex returned an error.';
      if(authError(message.error)||authFailure(text)||tailAuth())retire(SIGN_IN_MESSAGE);
      const error=new Error(text);error.code=message.error.code;entry.reject(error);
    }else entry.resolve(message.result);
  }
  function onLine(line){
    let message;
    try{message=JSON.parse(line);}catch{ignoredLines++;return;}
    if(!message||typeof message!=='object'||Array.isArray(message)){ignoredLines++;return;}
    if(message.id!==undefined&&message.id!==null&&typeof message.method==='string')return onServerRequest(message);
    if(message.id!==undefined&&message.id!==null)return onResponse(message);
    if(typeof message.method==='string')queued.push(message);else ignoredLines++;
  }

  function wire(){
    let out='',err='';
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',chunk=>{
      out+=chunk;
      if(out.length>16_000_000){out='';ignoredLines++;return;}
      const lines=out.split('\n');out=lines.pop();
      for(const line of lines)if(line.trim())onLine(line);
      drain();
    });
    child.stderr.on('data',chunk=>{
      err+=chunk;
      if(err.length>4096)err=err.slice(-300);
      const lines=err.split('\n');err=lines.pop();
      for(const raw of lines){
        const line=redact(raw);if(!line)continue;
        stderrTail.push(line);if(stderrTail.length>500)stderrTail.shift();
      }
    });
    child.stdout.on('end',()=>stopped('Codex stopped responding.'));
    child.on('exit',(code,signal)=>stopped(code===0?'Codex stopped.':code===null?`Codex stopped (${signal}).`:`Codex stopped with exit code ${code}.`));
    child.on('error',error=>stopped(`Codex could not start: ${error.message}`));
    handle.closed.then(()=>stopped('Codex stopped.'));
  }

  function start(){
    if(state==='closed'||state==='retired')return Promise.reject(unavailable());
    if(startPromise)return startPromise;
    return startPromise=(async()=>{
      state='starting';
      const binary=executable||await findExecutable('codex');
      if(state!=='starting')throw unavailable(); // close() during the lookup must not leave a running app-server behind
      handle=spawnChild(binary,['app-server'],{cwd,env:scrubbedEnv({RUST_LOG:'warn'})});child=handle.child;
      wire();
      await request('initialize',{clientInfo:{name:'summon',title:'Summon',version:SUMMON_VERSION},capabilities:{}},15_000);
      notify('initialized',{});
      const started=await request('thread/start',{cwd,sandbox,approvalPolicy:'on-request',ephemeral,developerInstructions},20_000);
      const id=started?.thread?.id||started?.thread?.sessionId||started?.threadId||started?.sessionId;
      if(typeof id!=='string'||!id)throw new Error('Codex started without a thread id. Update Codex, then try again.');
      threadId=id;
      if(state!=='starting')throw unavailable();
      state='ready';emit({type:'status',state});
      return {threadId};
    })().catch(error=>{retire(error.message);throw error;});
  }
  function turn(text,{signal}={}){
    if(typeof text!=='string'||!text.trim())return Promise.reject(new Error('Say or type what Codex should do.'));
    if(state!=='ready')return Promise.reject(unavailable());
    if(active)return Promise.reject(new Error('Codex is still working on the previous request. Interrupt it or wait for it to finish.'));
    if(signal?.aborted)return Promise.reject(new Error('The request was cancelled.'));
    return new Promise(resolve=>{
      const record=active={turnId:null,deltas:[],final:null,done:false,interrupted:false,interruptSent:false,resolve,signal,onAbort:null,deadline:null,silence:null,settle:null};
      record.onAbort=()=>interruptTurn(record);signal?.addEventListener('abort',record.onAbort,{once:true});
      record.deadline=after(turnTimeoutMs,()=>{
        // A completed answer without turn/completed is still an answer; the wedged process goes either way.
        if(record.final!==null)finish(record,{status:'completed'});
        retire(`Codex did not finish within ${Math.round(turnTimeoutMs/60000)} minutes. Start a new thread.`,'retired',interruptTurn(record));
      });
      request('turn/start',{threadId,input:[{type:'text',text}],...(effort?{effort}:{})}).then(started=>{
        if(record.done)return;
        record.turnId=typeof started?.turn?.id==='string'?started.turn.id:null;
        if(record.interrupted)interruptTurn(record);
      },error=>{if(!record.done)finish(record,{status:'failed',error:error.message});});
    });
  }
  async function interrupt(){if(active)interruptTurn(active);}
  async function close(){retire('This Codex thread is closed.','closed',active?interruptTurn(active):null);await handle?.closed;}
  const status=()=>({state,ready:state==='ready',threadId,turnId:active?.turnId??null,busy:!!active,reason,ignoredLines,stderr:[...stderrTail]});
  return {start,turn,interrupt,close,status};
}
