import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';

const WIDTH=320,HEIGHT=84,STOP_TIMEOUT=1200;
const STATES=new Set(['off','starting','stopping','recording','listening','hearing','finishing','checking-wake','awake','transcribing','processing','transcribed','error']);
const MODES=new Set(['off','command','handsfree']);

// The desktop control has no file, command, model, or microphone API. Capture
// stays in the workbench renderer; this window controls that one owner.
export function createDesktopVoice({app,BrowserWindow,ipcMain,screen,powerMonitor,mainWindow,root,dataDir,getHealth,onStateChange=()=>{}}){
  let widget=null,closed=false,position=null,startPromise=null,closePromise=null;
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
    // A crashed widget may have lost its main frame while its BrowserWindow
    // still exists. Publishing must never prevent the capture owner's stop.
    if(widget&&!widget.isDestroyed())try{widget.webContents.send('summon:widget-update',value);}catch{}
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
  const clamp=bounds=>{
    const display=bounds?screen.getDisplayMatching({...bounds,width:WIDTH,height:HEIGHT}):screen.getPrimaryDisplay();
    const area=display.workArea;
    return {x:Math.round(Math.max(area.x,Math.min(bounds?.x??area.x+area.width-WIDTH-24,area.x+area.width-WIDTH))),
      y:Math.round(Math.max(area.y,Math.min(bounds?.y??area.y+area.height-HEIGHT-24,area.y+area.height-HEIGHT)))};
  };
  const reposition=()=>{if(widget&&!widget.isDestroyed()){position=clamp(widget.getBounds());widget.setPosition(position.x,position.y);}};
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
  function show(){if(!closed&&widget&&!widget.isDestroyed()){reposition();widget.showInactive();publish();}}
  // Register owner/system cancellation before any asynchronous widget startup.
  for(const event of ['suspend','lock-screen'])on(powerMonitor,event,()=>{void stop();});
  on(mainWindow.webContents,'render-process-gone',ownerGone);
  on(mainWindow.webContents,'did-start-loading',()=>{void stop();});
  on(mainWindow.webContents,'will-navigate',()=>{void stop();});
  on(mainWindow.webContents,'did-finish-load',()=>{if(stopping){sendMode('off');confirmOff();}});
  on(mainWindow,'closed',ownerGone);
  on(mainWindow,'unresponsive',()=>{void stop();forceRelease();});
  for(const event of ['display-removed','display-metrics-changed'])on(screen,event,reposition);
  function start(){
    if(closed)return Promise.resolve();
    if(startPromise)return startPromise;
    startPromise=(async()=>{
      try{const saved=JSON.parse(await readFile(path.join(dataDir,'voice-widget.json'),'utf8'));if(Number.isFinite(saved.x)&&Number.isFinite(saved.y))position={x:saved.x,y:saved.y};}catch{}
      if(closed)return;
      position=clamp(position);
      widget=new BrowserWindow({width:WIDTH,height:HEIGHT,...position,title:'Summon voice',frame:false,transparent:true,resizable:false,maximizable:false,minimizable:false,fullscreenable:false,hasShadow:false,alwaysOnTop:true,skipTaskbar:true,show:false,
        webPreferences:{preload:path.join(root,'src/main/voice-widget-preload.cjs'),partition:'summon-voice-widget',contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
      widget.setAlwaysOnTop(true,'floating');
      widget.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true});
      widget.webContents.setWindowOpenHandler(()=>({action:'deny'}));
      on(widget.webContents,'will-navigate',event=>{event.preventDefault();void stop();});
      widget.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
      widget.webContents.session.setPermissionCheckHandler(()=>false);
      on(widget,'close',event=>{if(!closed){event.preventDefault();void stop();widget.hide();}});
      on(widget,'moved',()=>{position=clamp(widget.getBounds());});
      on(widget.webContents,'render-process-gone',()=>{void stop();});
      on(widget,'unresponsive',()=>{void stop();});
      const register=(name,fn)=>{
        const channel=`summon:widget-${name}`;
        ipcMain.handle(channel,async(event)=>{
          if(closed||!widget||widget.isDestroyed()||event.sender!==widget.webContents||event.senderFrame!==widget.webContents.mainFrame)throw new Error('Untrusted voice control request');
          return fn();
        });
        removers.push(()=>ipcMain.removeHandler(channel));
      };
      register('snapshot',snapshot);register('toggle',toggle);
      register('open',()=>{if(mainWindow.isDestroyed()){app.relaunch();app.quit();return;}if(mainWindow.webContents.isCrashed?.())mainWindow.webContents.reload();mainWindow.show();mainWindow.focus();});
      register('hide',()=>{void stop();widget.hide();});
      if(!app.isPackaged&&process.env.SUMMON_DEV_URL==='http://127.0.0.1:5179')await widget.loadURL(`${process.env.SUMMON_DEV_URL}/voice-widget.html`);
      else await widget.loadFile(path.join(root,'dist/voice-widget.html'));
      if(!closed)show();
    })();
    return startPromise;
  }
  function close(){
    if(closePromise)return closePromise;
    closed=true;
    closePromise=(async()=>{
      await stop();
      for(const remove of removers)remove();
      if(widget&&!widget.isDestroyed()){position=clamp(widget.getBounds());widget.destroy();}
      if(position)await writeFile(path.join(dataDir,'voice-widget.json'),JSON.stringify(position)+'\n',{mode:0o600}).catch(()=>{});
    })();
    return closePromise;
  }
  return {start,show,toggle,stop,updateVoice,snapshot,close,publish};
}
