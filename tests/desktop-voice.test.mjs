import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import vm from 'node:vm';

const source=(await readFile(new URL('../src/main/desktop-voice.mjs',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace('export function createDesktopVoice','function createDesktopVoice');
const plain=value=>JSON.parse(JSON.stringify(value));
const off={state:'off',mode:'off',micActive:false};
const listening={state:'listening',mode:'handsfree',micActive:true};

function fixture({health={wake:true,whisper:true}}={}){
  const updates=[],timers=new Map();
  let nextTimer=1;
  class Contents extends EventEmitter{
    constructor(){super();this.sent=[];this.crashes=0;this.reloads=0;}
    send(...args){this.sent.push(args);}
    isDestroyed(){return false;}
    forcefullyCrashRenderer(){this.crashes++;this.emit('render-process-gone',{}, {reason:'crashed'});}
    reload(){this.reloads++;this.emit('did-start-loading');}
  }
  class Window extends EventEmitter{
    constructor(){super();this.destroyed=false;this.webContents=new Contents();}
    isDestroyed(){return this.destroyed;}
    destroy(){this.destroyed=true;this.emit('closed');}
  }
  const mainWindow=new Window();
  const powerMonitor=new EventEmitter();
  const create=vm.runInNewContext(`${source}\ncreateDesktopVoice`,{
    setTimeout:(callback,delay)=>{const id=nextTimer++;timers.set(id,{callback,delay});return id;},clearTimeout:id=>timers.delete(id),
  });
  const control=create({powerMonitor,mainWindow,getHealth:()=>health,onStateChange:value=>updates.push(plain(value))});
  return {control,mainWindow,powerMonitor,updates,timers,health,
    timeout(){assert.equal(timers.size,1);const [id,timer]=[...timers][0];assert.equal(timer.delay,1200);timers.delete(id);timer.callback();},
  };
}

test('voice status starts with capture off and publishes without enabling capture',async()=>{
  const f=fixture();
  assert.equal(f.mainWindow.webContents.sent.length,0,'Startup must not enable capture.');
  assert.deepEqual(plain(f.control.snapshot()),{...off,available:true});
  f.control.publish();assert.deepEqual(f.updates.at(-1),{...off,available:true});
  assert.equal(f.mainWindow.webContents.sent.length,0);
  await f.control.close();
});

test('stop retains actual microphone status until capture owner acknowledges, even across late startup reports',async()=>{
  const f=fixture();f.control.toggle();
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
  const f=fixture();f.control.toggle();
  const stop=f.control.stop();assert.equal(f.control.snapshot().micActive,false);assert.equal(f.control.snapshot().state,'stopping');
  f.control.updateVoice({...listening,state:'starting'});assert.equal(f.control.snapshot().micActive,true);
  f.timeout();await stop;assert.equal(f.mainWindow.webContents.crashes,1);assert.equal(f.mainWindow.webContents.reloads,1);
  assert.deepEqual(plain(f.control.snapshot()),{...off,available:true});
  assert.equal(f.mainWindow.webContents.sent.at(-1)[1],'off');await f.control.close();
});

test('sleep and screen lock cancel the capture owner without resuming it',async()=>{
  const f=fixture();
  const triggers=[()=>f.powerMonitor.emit('suspend'),()=>f.powerMonitor.emit('lock-screen')];
  for(const trigger of triggers){f.control.updateVoice(listening);await trigger();assert.equal(f.control.snapshot().state,'stopping');assert.equal(f.mainWindow.webContents.sent.at(-1)[1],'off');f.control.updateVoice(off);}
  f.powerMonitor.emit('resume');f.powerMonitor.emit('unlock-screen');assert.equal(f.control.snapshot().mode,'off');
  assert.equal(f.mainWindow.webContents.sent.some(([,mode])=>mode==='handsfree'),false);
  await f.control.close();
});

test('an unresponsive owner is forcibly released immediately and recovered with capture off',async()=>{
  const f=fixture();f.control.updateVoice(listening);f.mainWindow.emit('unresponsive');
  assert.equal(f.mainWindow.webContents.crashes,1);assert.equal(f.mainWindow.webContents.reloads,1);assert.equal(f.timers.size,0);
  assert.deepEqual(plain(f.control.snapshot()),{...off,available:true});
  f.mainWindow.webContents.emit('did-finish-load');assert.equal(f.control.snapshot().mode,'off');await f.control.close();
});

test('shutdown waits for stop and forcibly releases a stuck owner without reload or restart',async()=>{
  const f=fixture();f.control.updateVoice(listening);let finished=false;
  const first=f.control.close(),second=f.control.close();assert.equal(first,second);first.then(()=>{finished=true;});
  await Promise.resolve();assert.equal(finished,false);assert.equal(f.control.snapshot().micActive,true);
  f.control.toggle();f.timeout();await first;
  assert.equal(f.mainWindow.webContents.crashes,1);assert.equal(f.mainWindow.webContents.reloads,0);
  assert.equal(f.powerMonitor.listenerCount('lock-screen'),0);assert.equal(f.powerMonitor.listenerCount('suspend'),0);assert.equal(f.mainWindow.listenerCount('unresponsive'),0);assert.equal(f.mainWindow.webContents.listenerCount('render-process-gone'),0);
  f.control.toggle();f.control.updateVoice(listening);assert.equal(f.control.snapshot().mode,'off');
  assert.equal(f.mainWindow.webContents.sent.some(([,mode])=>mode==='handsfree'),false);
});

test('owner send failure still triggers release',async()=>{
  const f=fixture();f.control.updateVoice(listening);
  f.mainWindow.webContents.send=()=>{throw new Error('Capture frame unavailable');};
  const stop=f.control.stop();assert.equal(f.control.snapshot().state,'stopping');f.timeout();await stop;
  assert.equal(f.mainWindow.webContents.crashes,1);assert.equal(f.control.snapshot().micActive,false);await f.control.close();
});

test('if Chromium cannot crash a stuck owner, destroying its window releases capture',async()=>{
  const f=fixture();f.control.updateVoice(listening);
  f.mainWindow.webContents.forcefullyCrashRenderer=()=>{throw new Error('Crash unavailable');};
  const stop=f.control.stop();f.timeout();await stop;
  assert.equal(f.mainWindow.destroyed,true);assert.equal(f.control.snapshot().micActive,false);assert.equal(f.mainWindow.webContents.reloads,0);
  await f.control.close();
});

test('owner navigation and crashes reset actual capture state without automatic enablement',async()=>{
  const f=fixture();f.control.updateVoice(listening);f.mainWindow.webContents.emit('will-navigate');
  assert.equal(f.control.snapshot().state,'stopping');f.mainWindow.webContents.emit('did-finish-load');assert.equal(f.control.snapshot().micActive,false);
  f.control.updateVoice(listening);f.mainWindow.webContents.emit('render-process-gone');assert.equal(f.control.snapshot().micActive,false);assert.equal(f.mainWindow.webContents.reloads,0);
  await f.control.close();
});

test('voice payload validation excludes transcript data from status and setup gates capture',async()=>{
  const f=fixture({health:{wake:false,whisper:true}});f.control.toggle();
  assert.equal(f.control.snapshot().available,false);assert.equal(f.control.snapshot().state,'error');assert.equal(f.mainWindow.webContents.sent.length,0);
  for(const value of [null,{},listening.state,{...listening,micActive:1},{...listening,mode:'shell'},{...listening,state:'invented'}])assert.throws(()=>f.control.updateVoice(value),/Invalid voice status/);
  f.control.updateVoice({...off,state:'transcribed',text:'Private command transcript',path:'/private/file'});assert.equal('text' in f.control.snapshot(),false);assert.equal('path' in f.control.snapshot(),false);
  f.control.updateVoice({...off,state:'error',text:'Failed\n'+ 'x'.repeat(300)});assert.equal(f.control.snapshot().error.length,220);assert.equal(f.control.snapshot().error.includes('\n'),false);
  await f.control.close();
});
