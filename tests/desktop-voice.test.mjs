import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import vm from 'node:vm';
import path from 'node:path';

const source=(await readFile(new URL('../src/main/desktop-voice.mjs',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace('export function createDesktopVoice','function createDesktopVoice');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const plain=value=>JSON.parse(JSON.stringify(value));
const off={state:'off',mode:'off',micActive:false};
const listening={state:'listening',mode:'handsfree',micActive:true};

function fixture({read=async()=>'{"x":100,"y":200}',load=async()=>{},health={wake:true,whisper:true}}={}){
  const handlers=new Map(),windows=[],writes=[],updates=[],timers=new Map();
  let nextTimer=1;
  class Contents extends EventEmitter{
    constructor(){super();this.mainFrame={};this.sent=[];this.crashes=0;this.reloads=0;this.session={setPermissionRequestHandler:fn=>{this.permissionRequest=fn;},setPermissionCheckHandler:fn=>{this.permissionCheck=fn;}};}
    send(...args){this.sent.push(args);}
    setWindowOpenHandler(fn){this.openWindow=fn;}
    isDestroyed(){return false;}
    forcefullyCrashRenderer(){this.crashes++;this.emit('render-process-gone',{}, {reason:'crashed'});}
    reload(){this.reloads++;this.emit('did-start-loading');}
  }
  class Window extends EventEmitter{
    constructor(options={}){super();this.options=options;this.destroyed=false;this.shows=0;this.hides=0;this.focuses=0;this.webContents=new Contents();this.bounds={x:options.x??0,y:options.y??0,width:options.width??1000,height:options.height??800};windows.push(this);}
    isDestroyed(){return this.destroyed;}
    setAlwaysOnTop(...args){this.onTop=args;}
    setVisibleOnAllWorkspaces(...args){this.workspaces=args;}
    setPosition(x,y){Object.assign(this.bounds,{x,y});}
    getBounds(){return {...this.bounds};}
    showInactive(){this.shows++;}
    show(){this.shows++;}
    hide(){this.hides++;}
    focus(){this.focuses++;}
    loadFile(file){this.loaded=file;return load();}
    loadURL(url){assert.fail(`Unexpected development navigation: ${url}`);}
    destroy(){this.destroyed=true;this.emit('closed');}
  }
  const mainWindow=new Window();windows.length=0;
  const screen=new EventEmitter();Object.assign(screen,{getPrimaryDisplay:()=>({workArea:{x:0,y:0,width:1440,height:900}}),getDisplayMatching:()=>({workArea:{x:0,y:0,width:1440,height:900}})});
  const powerMonitor=new EventEmitter();
  const create=vm.runInNewContext(`${source}\ncreateDesktopVoice`,{
    readFile:read,writeFile:async(...args)=>{writes.push(args);},path,process:{env:{SUMMON_DEV_URL:'http://127.0.0.1:5179'}},
    setTimeout:(callback,delay)=>{const id=nextTimer++;timers.set(id,{callback,delay});return id;},clearTimeout:id=>timers.delete(id),
  });
  const control=create({app:{isPackaged:true},BrowserWindow:Window,ipcMain:{handle:(channel,handler)=>{assert.equal(handlers.has(channel),false,'IPC registered once');handlers.set(channel,handler);},removeHandler:channel=>handlers.delete(channel)},screen,powerMonitor,mainWindow,root:'/private/tmp/fixture-summon',dataDir:'/private/tmp/fixture-data',getHealth:()=>health,onStateChange:value=>updates.push(plain(value))});
  return {control,mainWindow,windows,handlers,powerMonitor,screen,writes,updates,timers,health,
    invoke:(name,event)=>handlers.get(`summon:widget-${name}`)(event??{sender:windows[0].webContents,senderFrame:windows[0].webContents.mainFrame}),
    timeout(){assert.equal(timers.size,1);const [id,timer]=[...timers][0];assert.equal(timer.delay,1200);timers.delete(id);timer.callback();},
  };
}

test('widget IPC is narrow, main-frame-only, and cannot grant device permissions',async()=>{
  const f=fixture();await f.control.start();const widget=f.windows[0];
  assert.deepEqual([...f.handlers.keys()].sort(),['hide','open','snapshot','toggle'].map(name=>`summon:widget-${name}`).sort());
  for(const event of [{sender:f.mainWindow.webContents,senderFrame:f.mainWindow.webContents.mainFrame},{sender:widget.webContents,senderFrame:{}},{sender:{},senderFrame:widget.webContents.mainFrame}]){
    for(const name of ['snapshot','toggle','open','hide'])await assert.rejects(f.invoke(name,event),/Untrusted/);
  }
  assert.equal(f.mainWindow.webContents.sent.length,0,'Startup must not enable capture.');
  assert.deepEqual(plain(await f.invoke('snapshot')),{...off,available:true});
  assert.deepEqual(plain(widget.webContents.openWindow({url:'https://example.com'})),{action:'deny'});
  let permission;widget.webContents.permissionRequest(widget.webContents,'media',value=>{permission=value;});
  assert.equal(permission,false);assert.equal(widget.webContents.permissionCheck(widget.webContents,'media'),false);
  assert.equal(widget.options.webPreferences.partition,'summon-voice-widget');
  assert.equal(widget.options.webPreferences.sandbox,true);assert.equal(widget.options.webPreferences.contextIsolation,true);assert.equal(widget.options.webPreferences.nodeIntegration,false);
  assert.equal(widget.options.webPreferences.backgroundThrottling,false);
  assert.deepEqual(plain(widget.workspaces),[true,{visibleOnFullScreen:true}]);
  assert.equal(widget.loaded,'/private/tmp/fixture-summon/dist/voice-widget.html');
  await f.invoke('open');assert.equal(f.mainWindow.shows,1);assert.equal(f.mainWindow.focuses,1);
  await f.control.close();assert.equal(f.handlers.size,0);
});

test('concurrent startup creates one widget; closing during position read cannot create a late window',async()=>{
  const read=deferred();const f=fixture({read:()=>read.promise});
  const first=f.control.start(),second=f.control.start();assert.equal(first,second);
  await f.control.close();read.resolve('{"x":300,"y":400}');await first;
  assert.equal(f.windows.length,0);assert.equal(f.handlers.size,0);assert.equal(f.powerMonitor.listenerCount('suspend'),0);
  await f.control.start();assert.equal(f.windows.length,0);
  const g=fixture();const a=g.control.start(),b=g.control.start();await Promise.all([a,b]);assert.equal(g.windows.length,1);await g.control.close();
});

test('closing during widget load never shows a window afterward and writes position only',async()=>{
  const load=deferred();const f=fixture({load:()=>load.promise,read:async()=>'{"x":99999,"y":-400,"micActive":true}'});
  const start=f.control.start();await new Promise(resolve=>setImmediate(resolve));const widget=f.windows[0];assert.ok(widget);
  await f.control.close();load.resolve();await start;
  assert.equal(widget.destroyed,true);assert.equal(widget.shows,0);assert.equal(f.handlers.size,0);
  assert.deepEqual(JSON.parse(f.writes[0][1]),{x:1120,y:0});assert.equal(f.writes[0][2].mode,0o600);
});

test('stop retains actual microphone status until capture owner acknowledges, even across late startup reports',async()=>{
  const f=fixture();await f.control.start();f.control.toggle();
  assert.deepEqual(plain(f.control.snapshot()),{state:'starting',mode:'handsfree',micActive:false,available:true});
  // Starting capture first reports its cleanup of the previous generation.
  f.control.updateVoice(off);f.control.updateVoice({state:'starting',mode:'handsfree',micActive:false});f.control.updateVoice(listening);
  let complete=false;const stop=f.control.stop().then(()=>{complete=true;});
  assert.deepEqual(plain(f.control.snapshot()),{state:'stopping',mode:'off',micActive:true,available:true});
  assert.equal(f.updates.at(-1).micActive,true,'The tray remains honest until release.');
  f.control.toggle();f.control.updateVoice(listening);await Promise.resolve();assert.equal(complete,false);
  assert.equal(f.control.snapshot().state,'stopping');assert.equal(f.timers.size,1);
  f.control.updateVoice(off);await stop;assert.equal(complete,true);assert.equal(f.timers.size,0);
  assert.deepEqual(plain(f.control.snapshot()),{...off,available:true});
  assert.equal(f.mainWindow.webContents.sent.filter(([,mode])=>mode==='handsfree').length,1,'Late state must not restart capture.');
  await f.control.close();
});

test('cancelling pending permission stays stopping until acknowledgment or watchdog release',async()=>{
  const f=fixture();await f.control.start();f.control.toggle();
  const stop=f.control.stop();assert.equal(f.control.snapshot().micActive,false);assert.equal(f.control.snapshot().state,'stopping');
  f.control.updateVoice({...listening,state:'starting'});assert.equal(f.control.snapshot().micActive,true);
  f.timeout();await stop;assert.equal(f.mainWindow.webContents.crashes,1);assert.equal(f.mainWindow.webContents.reloads,1);
  assert.deepEqual(plain(f.control.snapshot()),{...off,available:true});
  assert.equal(f.mainWindow.webContents.sent.at(-1)[1],'off');await f.control.close();
});

test('system, widget crash, widget navigation, and hiding cancel the capture owner without resuming it',async()=>{
  const f=fixture();await f.control.start();const widget=f.windows[0];
  const triggers=[()=>f.powerMonitor.emit('suspend'),()=>f.powerMonitor.emit('lock-screen'),()=>widget.webContents.emit('render-process-gone'),()=>widget.emit('unresponsive'),()=>{let prevented=false;widget.webContents.emit('will-navigate',{preventDefault(){prevented=true;}});assert.equal(prevented,true);},()=>f.invoke('hide'),()=>{let prevented=false;widget.emit('close',{preventDefault(){prevented=true;}});assert.equal(prevented,true);}];
  for(const trigger of triggers){f.control.updateVoice(listening);await trigger();assert.equal(f.control.snapshot().state,'stopping');assert.equal(f.mainWindow.webContents.sent.at(-1)[1],'off');f.control.updateVoice(off);}
  f.powerMonitor.emit('resume');f.powerMonitor.emit('unlock-screen');assert.equal(f.control.snapshot().mode,'off');
  assert.equal(f.mainWindow.webContents.sent.some(([,mode])=>mode==='handsfree'),false);
  await f.control.close();
});

test('an unresponsive owner is forcibly released immediately and recovered with capture off',async()=>{
  const f=fixture();await f.control.start();f.control.updateVoice(listening);f.mainWindow.emit('unresponsive');
  assert.equal(f.mainWindow.webContents.crashes,1);assert.equal(f.mainWindow.webContents.reloads,1);assert.equal(f.timers.size,0);
  assert.deepEqual(plain(f.control.snapshot()),{...off,available:true});
  f.mainWindow.webContents.emit('did-finish-load');assert.equal(f.control.snapshot().mode,'off');await f.control.close();
});

test('shutdown waits for stop and forcibly releases a stuck owner without reload or restart',async()=>{
  const f=fixture();await f.control.start();f.control.updateVoice(listening);let finished=false;
  const first=f.control.close(),second=f.control.close();assert.equal(first,second);first.then(()=>{finished=true;});
  await Promise.resolve();assert.equal(finished,false);assert.equal(f.control.snapshot().micActive,true);
  f.control.toggle();f.timeout();await first;
  assert.equal(f.mainWindow.webContents.crashes,1);assert.equal(f.mainWindow.webContents.reloads,0);assert.equal(f.windows[0].destroyed,true);
  assert.equal(f.handlers.size,0);assert.equal(f.powerMonitor.listenerCount('lock-screen'),0);assert.equal(f.mainWindow.listenerCount('unresponsive'),0);assert.equal(f.mainWindow.webContents.listenerCount('render-process-gone'),0);
  await f.control.start();assert.equal(f.windows.length,1);assert.equal(f.control.snapshot().mode,'off');
});

test('a crashed widget frame cannot block cancellation and owner send failure still triggers release',async()=>{
  const f=fixture();await f.control.start();f.control.updateVoice(listening);
  f.windows[0].webContents.send=()=>{throw new Error('Render frame was disposed');};
  f.windows[0].webContents.emit('render-process-gone');
  assert.equal(f.mainWindow.webContents.sent.at(-1)[1],'off');assert.equal(f.control.snapshot().state,'stopping');
  f.mainWindow.webContents.send=()=>{throw new Error('Capture frame unavailable');};
  const stop=f.control.stop();f.timeout();await stop;
  assert.equal(f.mainWindow.webContents.crashes,1);assert.equal(f.control.snapshot().micActive,false);await f.control.close();
});

test('if Chromium cannot crash a stuck owner, destroying its window releases capture',async()=>{
  const f=fixture();await f.control.start();f.control.updateVoice(listening);
  f.mainWindow.webContents.forcefullyCrashRenderer=()=>{throw new Error('Crash unavailable');};
  const stop=f.control.stop();f.timeout();await stop;
  assert.equal(f.mainWindow.destroyed,true);assert.equal(f.control.snapshot().micActive,false);assert.equal(f.mainWindow.webContents.reloads,0);
  await f.control.close();
});

test('owner navigation and crashes reset actual capture state without automatic enablement',async()=>{
  const f=fixture();await f.control.start();f.control.updateVoice(listening);f.mainWindow.webContents.emit('will-navigate');
  assert.equal(f.control.snapshot().state,'stopping');f.mainWindow.webContents.emit('did-finish-load');assert.equal(f.control.snapshot().micActive,false);
  f.control.updateVoice(listening);f.mainWindow.webContents.emit('render-process-gone');assert.equal(f.control.snapshot().micActive,false);assert.equal(f.mainWindow.webContents.reloads,0);
  await f.control.close();
});

test('voice payload validation excludes transcript data from widget state and setup gates capture',async()=>{
  const f=fixture({health:{wake:false,whisper:true}});await f.control.start();f.control.toggle();
  assert.equal(f.control.snapshot().available,false);assert.equal(f.control.snapshot().state,'error');assert.equal(f.mainWindow.webContents.sent.length,0);
  for(const value of [null,{},listening.state,{...listening,micActive:1},{...listening,mode:'shell'},{...listening,state:'invented'}])assert.throws(()=>f.control.updateVoice(value),/Invalid voice status/);
  f.control.updateVoice({...off,state:'transcribed',text:'Private command transcript',path:'/private/file'});assert.equal('text' in f.control.snapshot(),false);assert.equal('path' in f.control.snapshot(),false);
  f.control.updateVoice({...off,state:'error',text:'Failed\n'+ 'x'.repeat(300)});assert.equal(f.control.snapshot().error.length,220);assert.equal(f.control.snapshot().error.includes('\n'),false);
  await f.control.close();
});
