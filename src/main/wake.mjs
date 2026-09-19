import {spawn} from 'node:child_process';
import {access,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {scrubbedEnv} from './process.mjs';

const MODEL='sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01';

/** Persistent keyword-only worker. It never opens a microphone or writes audio. */
export function createWakeDetector({dataDir,workerPath=fileURLToPath(new URL('../../native/wake/wake-worker.py',import.meta.url))}){
  if(typeof dataDir!=='string'||!path.isAbsolute(dataDir))throw new Error('Wake data directory must be absolute.');
  const root=path.join(dataDir,'wake'),python=path.join(root,'venv/bin/python3'),modelDir=path.join(root,'model');
  let worker=null,startPromise=null,stopped=false,buffer='',stderr='',state={available:false,loaded:false,keyword:'Summon',model:MODEL};
  let readyResolve,readyReject,readyTimer,closePromise=Promise.resolve(),stopPromise;
  const requests=new Map();
  const status=()=>({...state});
  const failRequests=error=>{for(const request of requests.values()){clearTimeout(request.timer);request.reject(error);}requests.clear();};
  const unavailable=()=>new Error('Local wake detection is not installed. Run Summon’s wake setup, or use the microphone button.');

  async function start(){
    if(stopped)throw new Error('The wake detector is shutting down.');
    if(state.loaded)return status();
    if(startPromise)return startPromise;
    startPromise=(async()=>{
      try{
        await Promise.all([access(python),access(workerPath),...['encoder.onnx','decoder.onnx','joiner.onnx','tokens.txt','keywords.txt'].map(name=>access(path.join(modelDir,name)))]);
        if((await stat(path.join(modelDir,'encoder.onnx'))).size<1_000_000)throw unavailable();
      }catch{state={...state,available:false,loaded:false,error:unavailable().message};throw unavailable();}
      if(stopped)throw new Error('The wake detector is shutting down.');
      state={...state,available:true,loaded:false,error:undefined};buffer='';stderr='';
      const child=spawn(python,['-u',workerPath,'--model-dir',modelDir],{env:scrubbedEnv({PYTHONNOUSERSITE:'1',OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1'}),stdio:['pipe','pipe','pipe']});
      worker=child;
      let resolveThisClose;
      closePromise=new Promise(resolve=>{resolveThisClose=resolve;});
      const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
      const fail=error=>{
        if(worker!==child)return;
        clearTimeout(readyTimer);state={...state,loaded:false,error:error.message};
        readyReject?.(error);readyReject=null;readyResolve=null;failRequests(error);
      };
      readyTimer=setTimeout(()=>{fail(new Error('The local wake detector did not become ready.'));child.kill('SIGKILL');},12000);
      child.stdout.on('data',chunk=>{
        if(worker!==child)return;
        buffer+=chunk;
        if(buffer.length>65536){fail(new Error('Invalid wake worker response.'));child.kill('SIGKILL');return;}
        const lines=buffer.split('\n');buffer=lines.pop();
        for(const line of lines){
          if(!line.trim())continue;
          let message;try{message=JSON.parse(line);}catch{fail(new Error('Invalid wake worker response.'));child.kill('SIGKILL');return;}
          if(message.type==='ready'){
            clearTimeout(readyTimer);state={...state,loaded:true,error:undefined};readyResolve?.(status());readyResolve=null;readyReject=null;continue;
          }
          const request=requests.get(message.id);if(!request)continue;
          requests.delete(message.id);clearTimeout(request.timer);
          if(message.error){request.reject(new Error(String(message.error).slice(0,300)));continue;}
          const result=message.result;
          if(!result||typeof result.detected!=='boolean'||!Number.isFinite(result.elapsedMs)){request.reject(new Error('Invalid wake detection result.'));continue;}
          const answer={detected:result.detected,elapsedMs:result.elapsedMs};
          if(result.detected){answer.keyword='Summon';for(const key of ['timestamp','endTimestamp'])if(Number.isFinite(result[key])&&result[key]>=0)answer[key]=result[key];}
          request.resolve(answer);
        }
      });
      child.stderr.on('data',chunk=>{if(worker===child)stderr=(stderr+chunk).slice(-2000);});
      child.stdin.on('error',error=>fail(new Error(`Wake worker connection failed: ${error.code||'pipe closed'}`)));
      child.on('error',error=>fail(new Error(`Could not start local wake detection: ${error.message}`)));
      child.on('close',()=>{
        if(worker===child){fail(new Error(stopped?'The wake detector stopped.':stderr.trim().slice(-500)||'The local wake detector stopped unexpectedly.'));worker=null;startPromise=null;}
        resolveThisClose();
      });
      return ready;
    })();
    try{return await startPromise;}catch(error){startPromise=null;throw error;}
  }

  async function detect(audio){
    if(stopped)throw new Error('The wake detector is shutting down.');
    if(!(audio instanceof ArrayBuffer)&&!ArrayBuffer.isView(audio))throw new Error('Wake detection requires WAV audio bytes.');
    const bytes=audio instanceof ArrayBuffer?Buffer.from(audio):Buffer.from(audio.buffer,audio.byteOffset,audio.byteLength);
    if(bytes.length<44||bytes.length>3_000_000||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE')throw new Error('Wake audio must be a short PCM WAV recording.');
    await start();
    if(requests.size)throw new Error('The previous wake check is still running.');
    if(!worker||stopped)throw new Error('The wake detector is unavailable.');
    const id=randomUUID();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{requests.delete(id);reject(new Error('Local wake detection timed out.'));worker?.kill('SIGKILL');},6000);
      requests.set(id,{resolve,reject,timer});
      worker.stdin.write(JSON.stringify({id,audio:bytes.toString('base64')})+'\n');
    });
  }

  function stop(){
    if(stopPromise)return stopPromise;
    stopped=true;clearTimeout(readyTimer);const error=new Error('The wake detector is shutting down.');
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
  return {start,status,detect,stop};
}
