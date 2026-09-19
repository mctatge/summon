import {tmpdir} from 'node:os';
import {spawnLongLived} from './process.mjs';

// One bounded, read-only exchange with an installed CLI over stdio: JSON lines out, JSON lines in, one deadline for
// the whole thing, and the process group stopped on the way out. Sign-in stays with the CLI: nothing here reads,
// holds or forwards a token, and every line the CLI prints is untrusted data that is parsed as JSON or dropped.
export const PROVIDERS=['claude','codex'];
export const STATUSES=['ok','not_signed_in','not_installed','not_applicable','error'];
// Window ids are named by what they measure, never by their position in a CLI's answer.
export const WINDOWS={five_hour:{label:'5h',rank:0},seven_day:{label:'7d',rank:1},seven_day_opus:{label:'7d Opus',rank:2},seven_day_sonnet:{label:'7d Sonnet',rank:3}};
export const AUTH_FAILURE=/invalid_grant|refresh token|\b401\b|unauthori[sz]ed|please log ?in|log ?in again|not logged in|could not be refreshed|sign in again|failed to authenticate|oauth[^.\n]{0,40}expired|no api key|not signed in/i;
export const authText=value=>typeof value==='string'&&AUTH_FAILURE.test(value);
export const cleanText=(value,max=300)=>String(value??'').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g,'').replace(/[\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
export const percent=value=>{const n=typeof value==='string'&&value.trim()!==''?Number(value):value;return typeof n==='number'&&Number.isFinite(n)?Math.min(100,Math.max(0,Math.round(n*10)/10)):null;};
// Epoch seconds, epoch milliseconds or an ISO string, to ISO; anything else is null rather than a guess.
export const isoAt=value=>{const ms=typeof value==='number'&&Number.isFinite(value)?(value>1e11?value:value*1000):typeof value==='string'?Date.parse(value):NaN;return Number.isFinite(ms)&&ms>0?new Date(ms).toISOString():null;};
export const windowLabel=id=>WINDOWS[id]?.label??id;
export const sortWindows=list=>[...list].sort((a,b)=>(WINDOWS[a.id]?.rank??9)-(WINDOWS[b.id]?.rank??9)||a.id.localeCompare(b.id));
export const plainPlan=value=>typeof value==='string'&&value.trim()?cleanText(value,40).toLowerCase():null;
export const errorText=error=>error?(typeof error==='string'?error:typeof error.message==='string'?error.message:JSON.stringify(error)):'';
/** The one shape every reader returns; extra fields from a CLI never get in. */
export function report(provider,fetchedAt,status,{plan=null,windows=[],error}={}){
  const value={provider,plan,status,windows:sortWindows(windows),fetchedAt};
  if(error)value.error=cleanText(error instanceof Error?error.message:error,300)||'Unknown error';
  return value;
}
/** Words a status turns into when the reader's exchange ended without an answer. */
export function unanswered(name,outcome){
  if(outcome.kind==='timeout')return {status:'error',error:`${name} did not answer in time.`};
  if(outcome.kind==='exited')return outcome.authSeen?{status:'not_signed_in',error:`${name} stopped before answering and its log mentions a sign-in problem.`}:{status:'error',error:`${name} stopped before answering${outcome.code===null?` (${outcome.signal})`:` (exit code ${outcome.code})`}.`};
  return {status:'error',error:outcome.message||`${name} could not be read.`};
}
/**
 * Spawns the CLI and feeds each parsed stdout line to onMessage(message, send). The first value onMessage returns
 * settles the exchange; the child is then told to stop and the result carries kind 'answered'. Other kinds:
 * 'timeout', 'exited' (with authSeen when stderr named a sign-in failure) and 'failed'.
 */
export function exchange({binary,args,env,cwd=tmpdir(),spawnChild=spawnLongLived,timeoutMs=15_000,open,onMessage}){
  return new Promise(resolve=>{
    let handle;
    try{handle=spawnChild(binary,args,{cwd,env});}catch(error){return resolve({kind:'failed',message:error.message,authSeen:false,ignored:0});}
    const {child}=handle;
    let out='',err='',done=false,authSeen=false,exitTimer=null,ignored=0;
    const finish=result=>{
      if(done)return;done=true;clearTimeout(deadline);clearTimeout(exitTimer);
      try{child.stdin.end();}catch{}
      const stopped=Promise.resolve().then(()=>handle.stop()).catch(()=>{});
      // Give the group a moment to leave so a refresh never piles children up; the app's shutdown sweep covers the rest.
      Promise.race([stopped,new Promise(wake=>setTimeout(wake,2000).unref?.())]).then(()=>resolve({...result,authSeen,ignored}));
    };
    const deadline=setTimeout(()=>finish({kind:'timeout'}),timeoutMs);deadline.unref?.();
    const send=message=>{if(done||!child.stdin||child.stdin.destroyed||!child.stdin.writable)return false;try{child.stdin.write(JSON.stringify(message)+'\n');return true;}catch{return false;}};
    child.stdin?.on('error',()=>{});
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',chunk=>{
      if(done)return;
      out+=chunk;
      if(out.length>2_000_000)return finish({kind:'failed',message:'The CLI printed more than Summon will read.'});
      const lines=out.split('\n');out=lines.pop();
      for(const line of lines){
        if(done)return;
        if(!line.trim())continue;
        let message;try{message=JSON.parse(line);}catch{ignored++;continue;}
        if(!message||typeof message!=='object'||Array.isArray(message)){ignored++;continue;}
        let answer;try{answer=onMessage(message,send);}catch(error){return finish({kind:'failed',message:error.message});}
        if(answer!==undefined)return finish({kind:'answered',value:answer});
      }
    });
    child.stderr.on('data',chunk=>{err=(err+chunk).slice(-4096);if(!authSeen&&authText(cleanText(err,4096)))authSeen=true;});
    child.on('error',error=>finish({kind:'failed',message:error.message}));
    // 'close' waits for stdout to drain; the exit fallback covers a grandchild that keeps the pipe open after the CLI is gone.
    child.on('close',(code,signal)=>finish({kind:'exited',code,signal}));
    child.on('exit',(code,signal)=>{exitTimer=setTimeout(()=>finish({kind:'exited',code,signal}),1500);exitTimer.unref?.();});
    try{open?.(send);}catch(error){finish({kind:'failed',message:error.message});}
  });
}
