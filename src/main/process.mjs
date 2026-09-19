import {spawn} from 'node:child_process';
import {access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';

const activeProcesses=new Set();
let shuttingDown=false,shutdownPromise;
const shutdownError=()=>new Error('Summon is shutting down. The operation was cancelled.');

export function stopProcesses(){
  shuttingDown=true;
  if(!shutdownPromise){
    const pending=[...activeProcesses];
    for(const operation of pending)operation.stop(shutdownError());
    shutdownPromise=Promise.allSettled(pending.map(operation=>operation.closed));
  }
  return shutdownPromise;
}

export function scrubbedEnv(extra={}) {
  const out={};
  for(const key of ['HOME','USER','LOGNAME','LANG','LC_ALL','TMPDIR','SHELL','PATH','CODEX_HOME']) if(process.env[key]) out[key]=process.env[key];
  out.PATH=`/opt/homebrew/bin:/usr/local/bin:${path.join(homedir(),'.local/bin')}:/usr/bin:/bin:/usr/sbin:/sbin`;
  return {...out,...extra};
}
export async function executable(name) {
  const candidates=name==='codex' ? ['/Applications/ChatGPT.app/Contents/Resources/codex','/Applications/Codex.app/Contents/Resources/codex'] : name==='claude'?[path.join(homedir(),'.local/bin/claude')]:[];
  candidates.push(...scrubbedEnv().PATH.split(':').map(dir=>path.join(dir,name)));
  for(const file of candidates) {try{await access(file,constants.X_OK);return file;}catch{}}
  throw new Error(`${name} is not installed. Install it, then restart Summon.`);
}
export function run(binary,args,{input,cwd,timeout=20000,maxBytes=2_000_000,env=scrubbedEnv()}={}) {
  if(shuttingDown)return Promise.reject(shutdownError());
  return new Promise((resolve,reject)=>{
    // A separate process group lets shutdown stop CLI children too, including
    // a child that keeps an inherited stdout pipe open after its parent exits.
    const grouped=process.platform!=='win32';
    const child=spawn(binary,args,{cwd,env,detached:grouped,stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='',stdoutBytes=0,settled=false,closed=false,cancelled,killTimer,closeTimer,resolveClosed;
    // Decode as a stream so a multi-byte character split across chunks (an em dash in a path) stays intact.
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    const closedPromise=new Promise(done=>{resolveClosed=done;});
    const signal=kind=>{
      if(!child.pid)return;
      try{if(grouped)process.kill(-child.pid,kind);else child.kill(kind);}catch{try{child.kill(kind);}catch{}}
    };
    const details=(error,code)=>{
      Object.defineProperties(error,{stdout:{value:stdout},stderr:{value:stderr},exitCode:{value:code}});
      return error;
    };
    const finish=error=>{
      if(settled)return;settled=true;clearTimeout(timer);
      error?reject(error):resolve({stdout,stderr});
    };
    const finishClosed=()=>{
      if(closed)return;closed=true;clearTimeout(killTimer);clearTimeout(closeTimer);
      activeProcesses.delete(operation);resolveClosed();
    };
    const stop=error=>{
      if(closed||cancelled)return;
      cancelled=error;clearTimeout(timer);signal('SIGTERM');
      killTimer=setTimeout(()=>signal('SIGKILL'),250);
      closeTimer=setTimeout(()=>{
        signal('SIGKILL');child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();child.unref();
        finish(details(cancelled,child.exitCode));finishClosed();
      },1500);
    };
    const operation={stop,closed:closedPromise};activeProcesses.add(operation);
    const timer=setTimeout(()=>stop(new Error('The operation timed out. Please try again.')),timeout);
    child.on('error',error=>{if(closed)return;finish(details(error,child.exitCode));finishClosed();});
    child.stdout.on('data',chunk=>{
      if(cancelled)return;
      stdout+=chunk;stdoutBytes+=Buffer.byteLength(chunk);
      if(stdoutBytes>maxBytes)stop(new Error('The response exceeded the allowed size.'));
    });
    child.stderr.on('data',chunk=>{if(!cancelled)stderr=(stderr+chunk).slice(-12000);});
    child.on('close',code=>{
      if(closed)return;
      if(cancelled){signal('SIGKILL');finish(details(cancelled,code));finishClosed();return;}
      if(code===0){finish();finishClosed();return;}
      const error=new Error(stderr.trim().slice(-800)||`The operation exited with code ${code}.`);
      // Some CLIs report their useful failure as JSON on stdout, then exit 1.
      // Preserve it for the caller to decode without displaying it by default.
      finish(details(error,code));finishClosed();
    });
    child.stdin.on('error',()=>{});
    child.stdin.end(input);
  });
}
/** A bidirectional child (an app-server) that lives until stopped; quit ends its whole process group. */
export function spawnLongLived(binary,args,{cwd,env=scrubbedEnv()}={}){
  if(shuttingDown)throw shutdownError();
  const grouped=process.platform!=='win32';
  const child=spawn(binary,args,{cwd,env,detached:grouped,stdio:['pipe','pipe','pipe']});
  let closed=false,stopping=false,killTimer,closeTimer,resolveClosed;
  const closedPromise=new Promise(done=>{resolveClosed=done;});
  const signal=kind=>{
    if(!child.pid)return;
    try{if(grouped)process.kill(-child.pid,kind);else child.kill(kind);}catch{try{child.kill(kind);}catch{}}
  };
  const finishClosed=()=>{
    if(closed)return;closed=true;clearTimeout(killTimer);clearTimeout(closeTimer);
    activeProcesses.delete(operation);resolveClosed();
  };
  const stop=()=>{
    if(closed||stopping)return closedPromise;
    stopping=true;
    try{child.stdin.end();}catch{}
    signal('SIGTERM');
    killTimer=setTimeout(()=>signal('SIGKILL'),3000);
    // A descendant that inherited a pipe can hold 'close' open after the group is gone.
    closeTimer=setTimeout(()=>{child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();child.unref();finishClosed();},4000);
    return closedPromise;
  };
  const operation={stop,closed:closedPromise};activeProcesses.add(operation);
  child.stdin.on('error',()=>{});
  child.on('error',()=>finishClosed());
  child.on('close',()=>finishClosed());
  return {child,stop,closed:closedPromise};
}
