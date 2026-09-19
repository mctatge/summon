import {spawn} from 'node:child_process';
import {access,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {scrubbedEnv} from './process.mjs';

const MODEL='wespeaker_en_voxceleb_resnet34.onnx';
const MIN_ENROLL_SAMPLES=5;

export function createSpeaker({dataDir,workerPath=fileURLToPath(new URL('../../native/speaker/speaker-worker.py',import.meta.url))}){
  if(typeof dataDir!=='string'||!path.isAbsolute(dataDir))throw new Error('Speaker data directory must be absolute.');
  const speakerDir=path.join(dataDir,'speaker');
  const python=path.join(dataDir,'wake/venv/bin/python3');
  const modelPath=path.join(speakerDir,'model',MODEL);
  let worker=null,startPromise=null,stopped=false,buffer='',stderr='',closePromise=Promise.resolve(),stopPromise;
  let readyResolve,readyReject,readyTimer;
  let state={available:false,loaded:false,enrolled:false};
  const requests=new Map();
  const status=()=>({...state,enrolling:requests.size>0&&[...requests.values()].some(r=>r.type==='enroll')});
  const failRequests=error=>{for(const request of requests.values()){clearTimeout(request.timer);request.reject(error);}requests.clear();};
  const unavailable=()=>new Error('Speaker verification is not set up. Run: python3 native/speaker/setup.py');

  async function start(){
    if(stopped)throw new Error('Speaker verification is shutting down.');
    if(state.loaded)return status();
    if(startPromise)return startPromise;
    startPromise=(async()=>{
      try{
        await Promise.all([access(python),access(workerPath),access(modelPath)]);
        if((await stat(modelPath)).size<1_000_000)throw unavailable();
      }catch{state={...state,available:false,loaded:false,error:unavailable().message};throw unavailable();}
      if(stopped)throw new Error('Speaker verification is shutting down.');
      state={...state,available:true,loaded:false,error:undefined};buffer='';stderr='';
      const child=spawn(python,['-u',workerPath,'--model',modelPath,'--profile-dir',speakerDir],{env:scrubbedEnv({PYTHONNOUSERSITE:'1',OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1'}),stdio:['pipe','pipe','pipe']});
      worker=child;
      let resolveThisClose;
      closePromise=new Promise(resolve=>{resolveThisClose=resolve;});
      const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
      const fail=error=>{
        if(worker!==child)return;
        clearTimeout(readyTimer);state={...state,loaded:false,error:error.message};
        readyReject?.(error);readyReject=null;readyResolve=null;failRequests(error);
      };
      readyTimer=setTimeout(()=>{fail(new Error('The speaker verification worker did not become ready.'));child.kill('SIGKILL');},15000);
      child.stdout.on('data',chunk=>{
        if(worker!==child)return;
        buffer+=chunk;
        if(buffer.length>65536){fail(new Error('Invalid speaker worker response.'));child.kill('SIGKILL');return;}
        const lines=buffer.split('\n');buffer=lines.pop();
        for(const line of lines){
          if(!line.trim())continue;
          let message;try{message=JSON.parse(line);}catch{fail(new Error('Invalid speaker worker response.'));child.kill('SIGKILL');return;}
          if(message.type==='ready'){
            clearTimeout(readyTimer);state={...state,loaded:true,enrolled:Boolean(message.enrolled),error:undefined};
            readyResolve?.(status());readyResolve=null;readyReject=null;continue;
          }
          const request=requests.get(message.id);if(!request)continue;
          requests.delete(message.id);clearTimeout(request.timer);
          if(message.error){request.reject(new Error(String(message.error).slice(0,300)));continue;}
          request.resolve(message.result);
        }
      });
      child.stderr.on('data',chunk=>{if(worker===child)stderr=(stderr+chunk).slice(-2000);});
      child.stdin.on('error',error=>fail(new Error(`Speaker worker connection failed: ${error.code||'pipe closed'}`)));
      child.on('error',error=>fail(new Error(`Could not start speaker verification: ${error.message}`)));
      child.on('close',()=>{
        if(worker===child){fail(new Error(stopped?'Speaker verification stopped.':stderr.trim().slice(-500)||'The speaker worker stopped unexpectedly.'));worker=null;startPromise=null;}
        resolveThisClose();
      });
      return ready;
    })();
    try{return await startPromise;}catch(error){startPromise=null;throw error;}
  }

  function send(type,payload={},timeout=6000){
    if(!worker||stopped)throw new Error('Speaker verification is unavailable.');
    const id=randomUUID();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{requests.delete(id);reject(new Error('Speaker verification timed out.'));},timeout);
      requests.set(id,{resolve,reject,timer,type});
      worker.stdin.write(JSON.stringify({id,type,...payload})+'\n');
    });
  }

  async function verify(audio){
    if(stopped||!state.loaded||!state.enrolled)return {verified:true,score:1,elapsedMs:0,reason:'inactive'};
    if(!(audio instanceof ArrayBuffer)&&!ArrayBuffer.isView(audio))throw new Error('Speaker verification requires WAV audio bytes.');
    const bytes=audio instanceof ArrayBuffer?Buffer.from(audio):Buffer.from(audio.buffer,audio.byteOffset,audio.byteLength);
    if(bytes.length<44||bytes.length>3_000_000)return {verified:true,score:1,elapsedMs:0,reason:'invalid'};
    try{return await send('verify',{audio:bytes.toString('base64')});}
    catch{return {verified:true,score:1,elapsedMs:0,reason:'error'};}
  }

  async function beginEnrollment(){
    await start();
    await send('cancel');
    return {minSamples:MIN_ENROLL_SAMPLES};
  }

  async function enrollAudio(audio){
    if(!(audio instanceof ArrayBuffer)&&!ArrayBuffer.isView(audio))throw new Error('Enrollment requires WAV audio bytes.');
    const bytes=audio instanceof ArrayBuffer?Buffer.from(audio):Buffer.from(audio.buffer,audio.byteOffset,audio.byteLength);
    return send('enroll',{audio:bytes.toString('base64')});
  }

  async function finishEnrollment(){
    const result=await send('save',{},10000);
    state={...state,enrolled:true};
    return result;
  }

  function cancelEnrollment(){if(worker&&!stopped)send('cancel').catch(()=>{});}

  function stop(){
    if(stopPromise)return stopPromise;
    stopped=true;clearTimeout(readyTimer);const error=new Error('Speaker verification is shutting down.');
    readyReject?.(error);readyReject=null;failRequests(error);
    const child=worker;state={...state,loaded:false};
    if(!child)return stopPromise=Promise.resolve();
    child.stdin.end();child.kill('SIGTERM');
    let force,deadline;
    force=setTimeout(()=>child.kill('SIGKILL'),300);
    const bounded=new Promise(resolve=>{deadline=setTimeout(()=>{child.kill('SIGKILL');child.stdout.destroy();child.stderr.destroy();child.unref();resolve();},1500);});
    stopPromise=Promise.race([closePromise,bounded]).finally(()=>{clearTimeout(force);clearTimeout(deadline);});
    return stopPromise;
  }

  return {start,status,verify,beginEnrollment,enrollAudio,finishEnrollment,cancelEnrollment,stop};
}
