import {spawn} from 'node:child_process';
import {homedir,tmpdir} from 'node:os';

export const FN_KEY_ERROR_MESSAGE='Fn shortcut: macOS could not start the Fn shortcut monitor. Use ⌘⇧Space or the microphone button.';

const READY_TIMEOUT=10_000,OUTPUT_LIMIT=8192;

/**
 * Supervises the passive native Fn helper. Only the helper sees key events;
 * Summon receives a bare tap signal and a status. A missing Input Monitoring
 * grant asks macOS once, then polls quietly so a grant made in System Settings
 * takes effect without relaunching. `poke()` restarts polling after it stops.
 */
export function createFnKeyMonitor({executable,onTap,onStatus=()=>{},spawnChild=spawn,retryMs=10_000,maxRetries=60,setTimer=setTimeout,clearTimer=clearTimeout}){
  if(typeof executable!=='string'||!executable)throw new Error('Fn helper path is required.');
  let child=null,status='off',deadline=null,retry=null,retries=0,stopped=false,requested=false;
  const publish=next=>{const changed=status!==next;status=next;if(changed)onStatus(next);};
  const clearDeadline=()=>{if(deadline)clearTimer(deadline);deadline=null;};
  const clearRetry=()=>{if(retry)clearTimer(retry);retry=null;};
  const env=()=>({HOME:homedir(),TMPDIR:tmpdir(),PATH:'/usr/bin:/bin:/usr/sbin:/sbin'});

  function releaseChild(){
    clearDeadline();const previous=child;child=null;
    if(previous){try{previous.stdin.end();}catch{}previous.kill();}
  }
  function scheduleRetry(){
    if(stopped||retry||retries>=maxRetries)return;
    retries++;retry=setTimer(()=>{retry=null;launch();},retryMs);retry.unref?.();
  }

  function launch(requestPermission=false){
    if(stopped||child)return;
    // A quiet re-check after a permission wait keeps that status instead of flickering.
    if(!requestPermission&&status!=='permission-required')publish('starting');
    let process;
    try{process=spawnChild(executable,requestPermission?['--request-permission']:[],{stdio:['pipe','pipe','pipe'],env:env()});}
    catch{publish('error');return;}
    child=process;
    let buffer='',granted=false;
    process.stdin.on('error',()=>{});
    process.stderr?.resume?.();
    deadline=setTimer(()=>{if(child!==process)return;releaseChild();if(requestPermission)scheduleRetry();else publish('error');},READY_TIMEOUT);
    deadline.unref?.();
    process.stdout.on('data',data=>{
      if(child!==process)return;
      buffer+=data.toString('utf8');
      if(buffer.length>OUTPUT_LIMIT){releaseChild();publish('error');return;}
      const lines=buffer.split('\n');buffer=lines.pop()||'';
      for(const line of lines){
        let value;try{value=JSON.parse(line);}catch{continue;}
        if(child!==process||!value||typeof value!=='object')return;
        if(value.type==='ready'&&!requestPermission){clearDeadline();retries=0;publish('ready');}
        else if(value.type==='fn-tap'&&!requestPermission&&status==='ready')onTap();
        else if(value.type==='permission-required'){clearDeadline();publish('permission-required');}
        else if(value.type==='permission-granted'&&requestPermission){clearDeadline();granted=true;}
        else if(value.type==='error'){releaseChild();publish('error');return;}
      }
    });
    process.on('error',()=>{if(child!==process)return;releaseChild();publish('error');});
    process.on('exit',()=>{
      if(child!==process)return;
      child=null;clearDeadline();
      if(stopped)return;
      if(granted){retries=0;launch();return;}
      if(status==='permission-required'){
        // Ask macOS once per run; afterwards the plain helper re-checks quietly.
        if(!requested){requested=true;launch(true);}
        else scheduleRetry();
      }else if(status==='ready'){
        // The tap was disabled (for example by the system) and the helper stopped.
        publish('starting');scheduleRetry();
      }else publish('error');
    });
  }

  return {
    status:()=>status,
    start(){if(!stopped)launch();},
    /** Called on focus, wake or unlock: retries a permission wait and resets the detector after sleep. */
    poke(){
      if(stopped)return;
      if(child){try{child.stdin.write('reset\n');}catch{}return;}
      if(retry||status==='error'||status==='off')return;
      clearRetry();retries=0;launch();
    },
    stop(){stopped=true;clearRetry();releaseChild();publish('off');},
  };
}
