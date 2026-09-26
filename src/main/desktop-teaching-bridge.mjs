import {spawnLongLived, scrubbedEnv} from './process.mjs';

const METHODS=new Set(['permissions','request-permissions','request-screen-recording','apps','status','configure','begin','finish','cancel','snapshot','activate','execute']);

/** Private, lazy JSON-lines connection. Only the native helper can touch AX. */
export function createDesktopTeachingBridge({binary,spawnChild=spawnLongLived,timeoutMs=15_000,maxBytes=1_000_000}={}){
  if(typeof binary!=='string'||!binary)throw new Error('Desktop teaching helper path is required.');
  let process=null,closed=false,sequence=0,lastError=null;
  const pending=new Map();
  function settle(id,error,result){
    const request=pending.get(id);if(!request)return;
    pending.delete(id);clearTimeout(request.timer);request.signal?.removeEventListener('abort',request.abort);
    error?request.reject(error):request.resolve(result);
  }
  function stop(error){
    const previous=process;process=null;
    if(error)lastError=error.message;
    for(const id of [...pending.keys()])settle(id,error||new Error('Desktop teaching stopped.'));
    try{previous?.stop();}catch{}
  }
  function start(){
    if(closed)throw new Error('Desktop teaching bridge is closed.');
    if(process)return process.child;
    const handle=spawnChild(binary,[],{env:scrubbedEnv()});
    if(!handle?.child||typeof handle.stop!=='function')throw new Error('Could not start desktop teaching helper.');
    process=handle;lastError=null;
    const child=handle.child;let buffer='';
    child.stdout.setEncoding?.('utf8');
    child.stdout.on('data',chunk=>{
      if(process!==handle)return;
      buffer+=chunk;
      if(Buffer.byteLength(buffer)>maxBytes){stop(new Error('Desktop teaching helper response exceeded its limit.'));return;}
      while(buffer.includes('\n')){
        const end=buffer.indexOf('\n'),line=buffer.slice(0,end);buffer=buffer.slice(end+1);
        if(!line)continue;
        let message;try{message=JSON.parse(line);}catch{stop(new Error('Desktop teaching helper returned invalid JSON.'));return;}
        if(!message||typeof message!=='object'||!Number.isSafeInteger(message.id)){
          stop(new Error('Desktop teaching helper returned an invalid response.'));return;
        }
        if(message.error){settle(message.id,new Error(typeof message.error==='string'?message.error:message.error.message||'Desktop teaching failed.'));}
        else if(Object.hasOwn(message,'result'))settle(message.id,null,message.result);
        else {stop(new Error('Desktop teaching helper returned an incomplete response.'));return;}
      }
    });
    // Never reflect stderr containing OS data or private captured text into UI.
    child.stderr?.resume?.();
    child.stdin.on('error',()=>{if(process===handle)stop(new Error('Desktop teaching helper input closed.'));});
    child.on('error',()=>{if(process===handle)stop(new Error('Could not start desktop teaching helper. Rebuild Summon’s native helper.'));});
    child.on('close',()=>{if(process===handle)stop(new Error('Desktop teaching helper stopped.'));});
    return child;
  }
  function cancelNative(child){
    try{child.stdin.write(JSON.stringify({id:++sequence,method:'cancel',params:{}})+'\n');}catch{}
  }
  return {
    status:()=>({running:!!process,closed,error:lastError}),
    request(method,params={},options={}){
      if(!METHODS.has(method))return Promise.reject(new Error('Unsupported desktop teaching request.'));
      if(!params||typeof params!=='object'||Array.isArray(params))return Promise.reject(new Error('Invalid desktop teaching parameters.'));
      if(options.signal?.aborted)return Promise.reject(new Error('Desktop teaching cancelled.'));
      if(pending.size>=20)return Promise.reject(new Error('Too many pending desktop teaching requests.'));
      let child,wire,id;
      try{
        id=++sequence;wire=JSON.stringify({id,method,params})+'\n';
        if(Buffer.byteLength(wire)>maxBytes)throw new Error('Desktop teaching request exceeded its limit.');
        child=start();
      }catch(error){return Promise.reject(error);}
      return new Promise((resolve,reject)=>{
        const abort=()=>{settle(id,new Error('Desktop teaching cancelled.'));cancelNative(child);};
        const timer=setTimeout(()=>stop(new Error('Desktop teaching timed out. The helper was stopped.')),timeoutMs);
        timer.unref?.();
        pending.set(id,{resolve,reject,timer,signal:options.signal,abort});
        options.signal?.addEventListener('abort',abort,{once:true});
        // Register the abort listener before writing a command that may act.
        if(options.signal?.aborted){abort();return;}
        try{child.stdin.write(wire);}catch{stop(new Error('Desktop teaching helper input closed.'));}
      });
    },
    close(){closed=true;stop(new Error('Desktop teaching bridge is closed.'));},
  };
}
