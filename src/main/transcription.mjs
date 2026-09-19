import {spawn} from 'node:child_process';
import {access,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {scrubbedEnv} from './process.mjs';

const stoppedError=()=>new Error('Local transcription was cancelled because Summon is closing.');
const audioError=()=>new Error('Use a short mono or stereo PCM16 WAV recording (0.1–30 seconds, 8–48 kHz).');

/** Parse the renderer’s WAV in RAM. Unsupported input never reaches a decoder. */
export function decodePcmWav(audio){
  if(!(audio instanceof ArrayBuffer)&&!ArrayBuffer.isView(audio))throw audioError();
  const bytes=audio instanceof ArrayBuffer?Buffer.from(audio):Buffer.from(audio.buffer,audio.byteOffset,audio.byteLength);
  if(bytes.length<44||bytes.length>8_000_000||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE')throw audioError();
  const end=bytes.readUInt32LE(4)+8;if(end>bytes.length||end<44)throw audioError();
  let format,data;
  for(let offset=12;offset+8<=end;){
    const name=bytes.toString('ascii',offset,offset+4),length=bytes.readUInt32LE(offset+4),start=offset+8;
    if(start+length>end)throw audioError();
    if(name==='fmt '){if(format||length<16)throw audioError();format={code:bytes.readUInt16LE(start),channels:bytes.readUInt16LE(start+2),rate:bytes.readUInt32LE(start+4),block:bytes.readUInt16LE(start+12),bits:bytes.readUInt16LE(start+14)};}
    if(name==='data'){if(data)throw audioError();data=bytes.subarray(start,start+length);}
    offset=start+length+(length%2);
  }
  if(!format||!data||format.code!==1||format.bits!==16||![1,2].includes(format.channels)||format.block!==format.channels*2||format.rate<8000||format.rate>48000||data.length%format.block)throw audioError();
  const count=data.length/format.block,duration=count/format.rate;
  if(duration<0.1||duration>30)throw audioError();
  const mono=new Float32Array(count);
  for(let i=0;i<count;i++){let value=0;for(let c=0;c<format.channels;c++)value+=data.readInt16LE(i*format.block+c*2)/32768;mono[i]=value/format.channels;}
  if(format.rate===16000)return mono;
  // A windowed-sinc low-pass prevents aliasing when reducing 44.1/48 kHz PCM.
  // Its phase table keeps trigonometry out of the per-sample loop.
  const taps=32,phases=256,cutoff=Math.min(1,16000/format.rate)*0.94,bank=[];
  for(let phase=0;phase<phases;phase++){
    const weights=new Float64Array(taps);let sum=0;
    for(let t=0;t<taps;t++){const x=t-15-phase/phases,z=Math.PI*x*cutoff;const sinc=Math.abs(z)<1e-8?1:Math.sin(z)/z;const window=0.42-0.5*Math.cos(2*Math.PI*t/(taps-1))+0.08*Math.cos(4*Math.PI*t/(taps-1));weights[t]=sinc*cutoff*window;sum+=weights[t];}
    for(let t=0;t<taps;t++)weights[t]/=sum;bank.push(weights);
  }
  const result=new Float32Array(Math.round(count*16000/format.rate));
  for(let i=0;i<result.length;i++){
    const position=i*format.rate/16000,base=Math.floor(position),weights=bank[Math.min(255,Math.floor((position-base)*phases))];let value=0;
    for(let t=0;t<taps;t++){const index=base+t-15;if(index>=0&&index<count)value+=mono[index]*weights[t];}
    result[i]=Math.max(-1,Math.min(1,value));
  }
  return result;
}

/** One selected model, one private stdio worker, no microphone/socket/temp audio. */
export function createTranscriber({workerPath=fileURLToPath(new URL('../../native/summon-transcribe',import.meta.url)),spawnChild=spawn,idleMs=60000,startupTimeoutMs=20000,decodeTimeoutMs=15000}={}){
  let current=null,queue=Promise.resolve(),closed=false,closePromise,busy=false,retained=false,retainedModel=null,idleTimer,operations=0;
  let state={available:false,loaded:false,warming:false,retained:false,model:null};
  const status=()=>({...state,retained});
  const clearIdle=()=>{clearTimeout(idleTimer);idleTimer=null;};
  const idle=()=>{clearIdle();if(!closed&&!retained&&!operations&&current){const old=current;idleTimer=setTimeout(()=>{if(!retained&&!operations&&current===old)void retire(old);},idleMs);idleTimer.unref?.();}};
  const serialize=fn=>{
    operations++;clearIdle();
    const operation=queue.then(()=>{if(closed)throw stoppedError();return fn();});
    queue=operation.catch(()=>{});
    return operation.finally(()=>{operations--;idle();});
  };
  async function retire(session){
    await session.stop();
    if(current===session){current=null;state={...state,loaded:false,warming:false,error:undefined};}
  }
  function launch(model){
    const child=spawnChild(workerPath,[model],{env:scrubbedEnv(),stdio:['pipe','pipe','pipe']});
    let buffer='',stderr='',readyResolve,readyReject,request,readyTimer,resolveClosed,stopPromise,expectedStop=false,readyDone=false,terminal=false;
    const ended=new Promise(resolve=>{resolveClosed=resolve;});
    const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
    const session={child,model,ready,loaded:false,stop,request:submit};
    const fail=error=>{
      if(terminal)return;terminal=true;
      clearTimeout(readyTimer);session.loaded=false;
      if(current===session)state={...state,loaded:false,warming:false,...(!expectedStop?{error:error.message}:{})};
      readyReject?.(error);readyResolve=null;readyReject=null;
      if(request){clearTimeout(request.timer);request.reject(error);request=null;}
    };
    const fatal=error=>{fail(error);child.kill('SIGKILL');};
    readyTimer=setTimeout(()=>fatal(new Error('Local speech preparation timed out. GPU shader setup or model loading did not finish. Restart Summon after setup, then try again.')),startupTimeoutMs);
    child.stdout.on('data',chunk=>{
      if(terminal||expectedStop||closed)return;
      buffer+=chunk;
      if(Buffer.byteLength(buffer)>65536){fatal(new Error('Invalid transcription worker response.'));return;}
      const lines=buffer.split('\n');buffer=lines.pop();
      for(const line of lines){
        if(!line.trim())continue;
        let result;try{result=JSON.parse(line);}catch{fatal(new Error('Invalid transcription worker response.'));return;}
        if(!result||typeof result!=='object'||Array.isArray(result)){fatal(new Error('Invalid transcription worker response.'));return;}
        if(result.type==='ready'){
          if(readyDone){fatal(new Error('Duplicate transcription readiness response.'));return;}
          readyDone=true;clearTimeout(readyTimer);session.loaded=true;
          if(current===session)state={...state,loaded:true,warming:false,error:undefined,runtime:typeof result.runtime==='string'?result.runtime.slice(0,50):undefined,warmMs:Number.isFinite(result.warmMs)?result.warmMs:undefined};
          readyResolve?.(status());readyResolve=null;readyReject=null;continue;
        }
        if(!request||result.id!==request.id)continue;
        const pending=request;request=null;clearTimeout(pending.timer);
        if(result.error){pending.reject(new Error(String(result.error).slice(0,300)));continue;}
        if(typeof result.text!=='string'||result.text.length>16000||!Number.isFinite(result.decodeMs)||result.decodeMs<0){pending.reject(new Error('Invalid transcription result.'));continue;}
        pending.resolve({text:result.text.trim().replace(/\[[^\]]*\]/g,'').trim(),decodeMs:Math.round(result.decodeMs)});
      }
    });
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-2000);});
    child.stdin.on('error',()=>fatal(new Error('The local transcription worker connection closed.')));
    child.on('error',error=>fail(new Error(`Could not start local transcription: ${error.message}`)));
    child.on('close',()=>{fail(new Error(expectedStop?'Local transcription stopped.':stderr.trim().slice(-500)||'The local transcription worker stopped unexpectedly.'));if(current===session){current=null;state={...state,loaded:false,warming:false};}resolveClosed();});
    function submit(pcm){
      if(terminal||!session.loaded||expectedStop)return Promise.reject(new Error('The local transcription worker is unavailable.'));
      const id=randomUUID();
      return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>fatal(new Error(`Transcription took longer than ${Math.ceil(decodeTimeoutMs/1000)} seconds and was stopped. Try a shorter phrase.`)),decodeTimeoutMs);
        request={id,resolve,reject,timer};
        child.stdin.write(JSON.stringify({id,pcm:Buffer.from(pcm.buffer,pcm.byteOffset,pcm.byteLength).toString('base64')})+'\n');
      });
    }
    function stop(){
      if(stopPromise)return stopPromise;
      expectedStop=true;fail(closed?stoppedError():new Error('The local transcription model was released.'));
      child.stdin.end();child.kill('SIGTERM');
      const force=setTimeout(()=>child.kill('SIGKILL'),300);let deadline;
      const bounded=new Promise(resolve=>{deadline=setTimeout(()=>{child.kill('SIGKILL');child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();child.unref();resolve();},1500);});
      return stopPromise=Promise.race([ended,bounded]).finally(()=>{clearTimeout(force);clearTimeout(deadline);});
    }
    return session;
  }
  async function ensure(model){
    if(!model||!path.isAbsolute(model))throw new Error('Choose a local Whisper model in Settings.');
    if(current?.model===model&&current.loaded)return current;
    const info=await stat(model);if(!info.isFile()||info.size<1_000_000)throw new Error('The selected Whisper model is not available.');
    await access(workerPath);if(closed)throw stoppedError();
    if(current)await retire(current);if(closed)throw stoppedError();
    state={available:true,loaded:false,warming:true,model};
    const session=launch(model);current=session;
    try{await session.ready;if(closed)throw stoppedError();return session;}
    catch(error){await retire(session);state={...state,error:error.message};throw error;}
  }
  function warm(model){
    if(closed)return Promise.reject(stoppedError());
    retained=true;retainedModel=model;clearIdle();
    return serialize(async()=>{if(!retained||retainedModel!==model)return status();await ensure(model);return status();});
  }
  function release(){retained=false;retainedModel=null;idle();}
  async function transcribe(audio,model){
    if(closed)throw stoppedError();
    if(busy)throw new Error('Still transcribing the previous phrase.');
    busy=true;const began=performance.now();
    try{
      const pcm=decodePcmWav(audio),preparationMs=Math.round(performance.now()-began);
      return await serialize(async()=>{
        if(retained&&retainedModel!==model)throw new Error('The selected transcription model changed. Try speaking again.');
        const session=await ensure(model),result=await session.request(pcm);
        return {...result,preparationMs,elapsedMs:Math.round(performance.now()-began)};
      });
    }finally{busy=false;}
  }
  function close(){
    if(closePromise)return closePromise;
    closed=true;retained=false;clearIdle();
    closePromise=Promise.allSettled([current?.stop(),queue]).then(()=>{current=null;state={...state,loaded:false,warming:false};});
    return closePromise;
  }
  return {warm,release,transcribe,status,close};
}
