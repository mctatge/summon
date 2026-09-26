const STOP_TIMEOUT=1200;
const STATES=new Set(['off','starting','stopping','recording','listening','hearing','finishing','checking-wake','awake','transcribing','processing','transcribed','error']);
const MODES=new Set(['off','command','handsfree']);

// Capture stays in the workbench renderer. This controller keeps menu-bar
// status and system cancellation synchronized with that one owner.
export function createDesktopVoice({powerMonitor,mainWindow,getHealth,onStateChange=()=>{}}){
  let closed=false,closePromise=null;
  let voice={state:'off',mode:'off',micActive:false};
  let stopping=false,stopPromise=null,finishStop=null,stopTimer=null,recoveryRequested=false;
  const removers=[];
  const snapshot=()=>{
    const health=getHealth();
    if(mainWindow.isDestroyed()||mainWindow.webContents.isDestroyed?.()||mainWindow.webContents.isCrashed?.())return {...voice,available:false,error:'Open Summon to restart the voice interface.'};
    return {...voice,available:Boolean(health.wake&&health.whisper),
      ...(voice.error?{}:!health.whisper?{error:'Set up local speech in Summon Preferences.'}:!health.wake?{error:'Set up wake-word detection in Summon Preferences.'}:{})};
  };
  const publish=()=>{
    const value=snapshot();
    try{onStateChange(value);}catch{}
  };
  const on=(target,event,callback)=>{target.on(event,callback);removers.push(()=>target.removeListener(event,callback));};
  const ownerAlive=()=>!mainWindow.isDestroyed()&&!mainWindow.webContents.isDestroyed?.();
  const sendMode=mode=>{if(ownerAlive())try{mainWindow.webContents.send('summon:voice-mode',mode);}catch{}}
  function confirmOff(){
    clearTimeout(stopTimer);stopTimer=null;stopping=false;
    voice={state:'off',mode:'off',micActive:false};
    const resolve=finishStop;finishStop=null;stopPromise=null;
    publish();resolve?.();
  }
  function ownerGone(){
    const reload=recoveryRequested&&!closed;
    recoveryRequested=false;confirmOff();
    // A new renderer starts with capture off; recovery never re-enables it.
    if(reload&&ownerAlive())mainWindow.webContents.reload();
  }
  function forceRelease(){
    if(!stopping)return;
    if(!ownerAlive()){ownerGone();return;}
    recoveryRequested=!closed;
    try{mainWindow.webContents.forcefullyCrashRenderer();}
    catch{
      // If Chromium cannot stop an unresponsive capture process, destroying its
      // window is the final release path. Never claim an unacknowledged mic is off.
      recoveryRequested=false;
      if(!mainWindow.isDestroyed())mainWindow.destroy();
      ownerGone();
    }
  }
  function stop(){
    if(stopping){sendMode('off');return stopPromise;}
    const pending=voice.micActive||voice.mode!=='off'||['starting','recording','checking-wake','awake','transcribing','processing'].includes(voice.state);
    if(!pending||!ownerAlive()){sendMode('off');confirmOff();return Promise.resolve();}
    stopping=true;voice={state:'stopping',mode:'off',micActive:voice.micActive};
    stopPromise=new Promise(resolve=>{finishStop=resolve;});
    const result=stopPromise;
    stopTimer=setTimeout(forceRelease,STOP_TIMEOUT);stopTimer.unref?.();
    publish();sendMode('off');
    return result;
  }
  function updateVoice(value){
    if(!value||typeof value!=='object'||!STATES.has(value.state)||!MODES.has(value.mode)||typeof value.micActive!=='boolean')throw new Error('Invalid voice status');
    if(stopping||closed){
      if(value.state==='off'&&value.mode==='off'&&!value.micActive)confirmOff();
      else if(stopping){voice.micActive=voice.micActive||value.micActive;publish();sendMode('off');}
      return;
    }
    voice={state:value.state,mode:value.mode,micActive:value.micActive};
    if(value.state==='error'&&typeof value.text==='string')voice.error=value.text.replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,220);
    publish();
  }
  function toggle(){
    if(closed||stopping)return;
    if(voice.mode!=='off'||voice.micActive){void stop();return;}
    if(!snapshot().available){voice={state:'error',mode:'off',micActive:false,error:snapshot().error};publish();return;}
    voice={state:'starting',mode:'handsfree',micActive:false};publish();sendMode('handsfree');
  }
  // Register cancellation as soon as the capture owner exists.
  for(const event of ['suspend','lock-screen'])on(powerMonitor,event,()=>{void stop();});
  on(mainWindow.webContents,'render-process-gone',ownerGone);
  on(mainWindow.webContents,'did-start-loading',()=>{void stop();});
  on(mainWindow.webContents,'will-navigate',()=>{void stop();});
  on(mainWindow.webContents,'did-finish-load',()=>{if(stopping){sendMode('off');confirmOff();}});
  on(mainWindow,'closed',ownerGone);
  on(mainWindow,'unresponsive',()=>{void stop();forceRelease();});
  function close(){
    if(closePromise)return closePromise;
    closed=true;
    closePromise=(async()=>{
      await stop();
      for(const remove of removers)remove();
    })();
    return closePromise;
  }
  return {toggle,stop,updateVoice,snapshot,close,publish};
}
