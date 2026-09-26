import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {sessionSummaryText} from '../src/core/agent-sessions.mjs';

const sourceURL=new URL('../src/main/main.mjs',import.meta.url);
const noop=()=>{};
const settle=async(turns=6)=>{for(let index=0;index<turns;index++)await new Promise(resolve=>setImmediate(resolve));};

const session=(key,extra={})=>({key,app:'claude',appLabel:'Claude app',title:'Excel recorder',project:'Harbor',group:'needs-you',stateText:'Needs input',openable:'link',openHint:'Opens in Claude',...extra});
const view=({needsYou=0,working=0,backgroundWorking=0,sessions=[]}={})=>({
  version:1,checkedAt:new Date(1_700_000_000_000).toISOString(),
  totals:{needsYou,newReplies:0,working,open:0},
  summary:{needsYou,working,backgroundWorking,text:sessionSummaryText({needsYou,working})},
  groups:sessions.length?[{id:'needs-you',title:'Needs you',sessions}]:[],
  sources:[],byPlace:{},settings:{},warnings:[],
});

// The menu-bar count lives in the real lifecycle, so it is exercised the way tests/lifecycle.test.mjs does:
// main.mjs runs in a context of injected adapters. No Electron window, tray, timer or child process is real.
async function launch({stored={trayCount:'needs'},handlerFor=()=>'Claude'}={}){
  let showWindow;
  const shown=new Promise(resolve=>{showWindow=resolve;});
  const fnMonitors=[];let fnStarts=0,fnStops=0;const handlers=new Map(),trays=[],timers=[],power=new Map(),dialogs=[],sent=[],opened=[],shownWindows=[];
  const core={view:view(),stored:{...stored},targets:new Map(),reads:[],patches:[],readError:null,
    read:async options=>{core.reads.push(options);if(core.readError)throw new Error(core.readError);return core.view;},
    settings:()=>({...core.stored}),
    updateSettings:async patch=>{core.patches.push(patch);Object.assign(core.stored,patch);return {...core.stored};},
    openTarget:key=>{if(!core.targets.has(key))throw new Error('That session is no longer in the list.');return core.targets.get(key);},
    close:async()=>{}};
  class Window extends EventEmitter{
    constructor(options){super();this.options=options;this.webContents=new EventEmitter();Object.assign(this.webContents,{mainFrame:{},send:(channel,value)=>sent.push([channel,value]),setWindowOpenHandler:noop});}
    isDestroyed(){return false;}
    isVisible(){return shownWindows.includes(this);}
    isMinimized(){return false;}
    loadFile(){return Promise.resolve();}
    loadURL(){return Promise.resolve();}
    show(){shownWindows.push(this);showWindow();}
    focus(){}
  }
  class Tray extends EventEmitter{
    constructor(image){super();this.image=image;this.titles=[];this.tooltips=[];this.menus=[];this.destroyed=false;trays.push(this);}
    setTitle(title){this.titles.push(title);}
    setToolTip(text){this.tooltips.push(text);}
    setContextMenu(menu){this.menu=menu;}
    popUpContextMenu(menu){this.menus.push(menu);}
    destroy(){this.destroyed=true;}
  }
  const app=new EventEmitter();
  Object.assign(app,{isPackaged:true,setName:noop,requestSingleInstanceLock:()=>true,getPath:()=>'/private/tmp/synthetic-summon-data',whenReady:()=>Promise.resolve(),quit:()=>app.emit('before-quit',{preventDefault:noop}),getApplicationNameForProtocol:url=>handlerFor(url)});
  const state={settings:{paused:false,activityEnabled:false,accessibilityEnabled:false,excludedApps:[],whisperModel:'/private/tmp/synthetic-model.bin'},health:{whisper:false},projects:[],files:[],events:[]};
  const service={snapshot:()=>state,setHealth:noop,start:async()=>{},stop:async()=>{},updateSettings:async()=>{}};
  const missing=async()=>{throw new Error('Synthetic fixture has no optional files.');};
  const source=(await readFile(sourceURL,'utf8')).replace(/^import .*;\n/gm,'').replaceAll('import.meta.url',JSON.stringify(sourceURL.href));
  vm.runInNewContext(source,{
    app,BrowserWindow:Window,Tray,Menu:{buildFromTemplate:template=>template,setApplicationMenu:noop},screen:{},nativeTheme:{shouldUseDarkColors:false,on:noop,removeListener:noop},
    // Several owners listen to the same power events (the count, the Fn helper); the fake calls them all.
    powerMonitor:{on:(event,handler)=>{const list=power.get(event)?.handlers||[];list.push(handler);power.set(event,Object.assign(()=>{for(const fn of list)fn();},{handlers:list}));}},
    nativeImage:{createFromBitmap:()=>({setTemplateImage:noop,star:true}),createEmpty:()=>({star:false})},
    ipcMain:{handle:(name,handler)=>handlers.set(name,handler)},
    shell:{openExternal:async url=>{opened.push(url);},openPath:async()=>'',showItemInFolder:target=>opened.push(target)},
    dialog:{showErrorBox:(title,message)=>dialogs.push([title,message])},
    globalShortcut:{register:()=>true,unregisterAll:noop},
    session:{defaultSession:{setPermissionRequestHandler:noop,setPermissionCheckHandler:noop}},
    systemPreferences:{},safeStorage:{},clipboard:{writeText:text=>opened.push(text)},
    spawn:()=>{const child=new EventEmitter();Object.assign(child,{stdout:new EventEmitter(),stderr:new EventEmitter(),kill:noop});return child;},
    readFile:missing,writeFile:noop,mkdir:noop,stat:missing,access:missing,chmod:noop,lstat:async()=>({isDirectory:()=>true}),
    createWorkInFlight:async()=>({read:async()=>({}),group:()=>({}),settings:()=>({}),updateSettings:async()=>({}),places:()=>[],placePath:()=>'/tmp',close:async()=>{}}),runGrouping:async()=>({raw:{},model:null}),GIT_ENV:{},
    createAgentSessions:async()=>core,sessionSummaryText,
    // This harness isolates the metadata count; context reasoning is unavailable here and exercised by usage-rpc.
    createDesktopTeachingBridge:()=>({}),createDesktopTeaching:async()=>({}),createTeaching:({browser})=>browser,
    createBrowserTeachingBridge:()=>({}),createBrowserTeaching:async()=>({read:async()=>({phase:'idle'}),action:async()=>({phase:'idle'}),handles:()=>false,command:async()=>null,cancel:async()=>{},close:async()=>{}}),
    createContextReasoning:async()=>null,runContextReasoning:()=>assert.fail('The tray never runs a reasoning model.'),
    createVisualWorkspace:async()=>({read:async()=>assert.fail('No visual read expected.'),saveGoal:async()=>assert.fail('No goal save expected.'),close:async()=>{}}),
    createDesktopVoice:()=>({publish:noop,updateVoice:noop,snapshot:()=>({state:'off',mode:'off',micActive:false}),toggle:noop,stop:async()=>{},close:async()=>{}}),
    createTranscriber:()=>({status:()=>({ready:false}),warm:async()=>{},transcribe:async()=>({text:''}),release:noop,close:async()=>{}}),
    homedir:()=>'/private/tmp/synthetic-home',path,fileURLToPath,
    createCompanion:async()=>service,classifyCommand:noop,createCommandSession:()=>({}),
    createKnowledge:async()=>({snapshot:()=>({}),refreshSources:async()=>{},search:async()=>[]}),
    createLocalInterpreter:()=>({status:()=>({}),health:async()=>{},close:async()=>{}}),
    createWakeDetector:()=>({status:()=>({}),start:async()=>{},stop:async()=>{}}),createSpeaker:()=>({status:()=>({}),start:async()=>{},stop:async()=>{},verify:async()=>({verified:true,score:1,elapsedMs:0}),beginEnrollment:async()=>({minSamples:10}),enrollAudio:async()=>({count:1,elapsedMs:0}),finishEnrollment:async()=>({saved:true,samples:0}),cancelEnrollment(){}}),createFnKeyMonitor:options=>{fnMonitors.push(options);return {status:()=>'off',start(){fnStarts++;},poke(){},stop(){fnStops++;}};},FN_KEY_ERROR_MESSAGE:'fn-error',createBenchmark:()=>noop,
    askEngine:async()=>({text:''}),createRpcServer:async()=>async()=>{},run:missing,scrubbedEnv:()=>({}),executable:missing,stopProcesses:async()=>{},
    // The usage meter and engine choice: stubbed so no timer or CLI of theirs runs in this lifecycle.
    createTaskRouter:async ({ask,selectEngine,getUsage,getSettings})=>({choose:task=>selectEngine({task,usage:getUsage(),settings:getSettings()}),answer:(engine,text,snapshot,options)=>ask(engine,text,snapshot,options),close:async()=>{}}),
    createUsage:async()=>({status:()=>({version:1,settings:{usageCeiling:85,defaultEngine:'claude'},providers:{claude:null,codex:null},refreshing:[],problem:null}),settings:()=>({usageCeiling:85,defaultEngine:'claude'}),refresh:async()=>({}),updateSettings:async()=>({}),start:noop,pause:noop,resume:noop,stop:noop,close:async()=>{}}),usageText:()=>'',readClaudeUsage:missing,readCodexUsage:missing,chooseEngine:()=>({engine:'claude',reason:'stub'}),spawnLongLived:missing,
    loadSealedSegments:()=>[],
    createLauncher:()=>({launch:()=>assert.fail('Nothing launches at startup.'),installClaudeHooks:()=>assert.fail('Nothing installs hooks at startup.'),hookStatus:async()=>({claude:{installed:false,current:false}})}),
    setTimeout:(fn,ms)=>{const timer={fn,ms,unref:noop};timers.push(timer);return timer;},
    clearTimeout:timer=>{const index=timers.indexOf(timer);if(index>=0)timers.splice(index,1);},
    URL,Buffer,console,
    process:{env:{},resourcesPath:'/private/tmp/synthetic-resources',umask:noop},
  },{filename:fileURLToPath(sourceURL)});
  await shown;
  await settle();
  // Runs the poll that is waiting and returns how long it had been asked to wait.
  const poll=async()=>{const timer=timers.shift();assert.ok(timer,'The menu-bar count scheduled no poll.');timer.fn();await settle();return timer.ms;};
  const next=()=>timers.at(-1)?.ms??null;
  const call=(name,...args)=>handlers.get(`summon:${name}`)({sender:shownWindows[0]?.webContents,senderFrame:shownWindows[0]?.webContents.mainFrame},...args);
  const counts=()=>trays.filter(item=>item.image?.star===false);
  return {app,core,trays,timers,power,dialogs,sent,opened,poll,next,call,counts,tray:()=>counts().findLast(item=>!item.destroyed)??null};
}

test('the count appears only while something needs you, and polls faster while it does',async()=>{
  const ctx=await launch();
  assert.equal(ctx.next(),5000,'The first count waits until the app has settled.');
  assert.equal(await ctx.poll(),5000);
  assert.deepEqual(ctx.core.reads.map(read=>read.maxAgeMs),[0],'The count reads the sessions afresh, nothing else.');
  assert.equal(ctx.tray(),null,'A quiet menu bar keeps no empty slot.');
  assert.equal(ctx.next(),60000,'Quiet means the slow poll.');

  ctx.core.view=view({needsYou:2,working:1,sessions:[session('claude:desktop:a'),session('claude:desktop:b')]});
  await ctx.poll();
  const tray=ctx.tray();
  assert.ok(tray,'Sessions that need you put a count in the menu bar.');
  assert.deepEqual(tray.titles,['◐ 2']);
  assert.deepEqual(tray.tooltips,['2 sessions are waiting on you. 1 working.']);
  assert.equal(ctx.next(),20000,'Something waiting on you means the fast poll.');

  ctx.core.view=view({working:1});
  await ctx.poll();
  assert.equal(ctx.tray(),tray,'The same item is kept while it still has something to say.');
  assert.deepEqual(tray.titles,['◐ 2','◉']);
  assert.deepEqual(tray.tooltips.at(-1),'1 session is working.');
  assert.equal(ctx.next(),20000);

  ctx.core.view=view();
  await ctx.poll();
  assert.equal(tray.destroyed,true,'Nothing to report takes the item out of the menu bar.');
  assert.equal(ctx.tray(),null);
  assert.equal(ctx.next(),60000);

  ctx.core.readError='Synthetic read failure';
  await ctx.poll();
  assert.deepEqual(ctx.dialogs,[],'A failed background read is never reported to you.');
  assert.equal(ctx.next(),60000,'A failed read backs off to the slow poll.');
});

test('background runs are counted only when the setting asks for them',async()=>{
  const ctx=await launch();
  ctx.core.view=view({backgroundWorking:2});
  await ctx.poll();
  await ctx.poll();
  assert.equal(ctx.tray(),null,'By default a background run does not put anything in the menu bar.');
  assert.equal(ctx.next(),60000);

  await ctx.call('agent-sessions-settings',{trayCount:'working'});
  await settle();
  assert.deepEqual(ctx.core.patches.map(patch=>patch.trayCount),['working']);
  await ctx.poll();
  assert.deepEqual(ctx.tray()?.titles,['◉']);
  assert.deepEqual(ctx.tray()?.tooltips,['2 sessions are working.']);
  assert.equal(ctx.next(),20000);
});

test('off means no item and no background reading at all',async()=>{
  const ctx=await launch({stored:{trayCount:'off'}});
  ctx.core.view=view({needsYou:3,sessions:[session('claude:desktop:a')]});
  await ctx.poll();
  assert.deepEqual(ctx.core.reads.map(read=>read.maxAgeMs),[],'Off reads nothing in the background.');
  assert.equal(ctx.tray(),null);
  assert.equal(ctx.next(),null,'Off schedules no further poll.');

  await ctx.call('agent-sessions-settings',{trayCount:'needs'});
  await settle();
  assert.equal(ctx.next(),0,'Turning the count back on starts the poll again.');
  await ctx.poll();
  assert.deepEqual(ctx.tray()?.titles,['◐ 3']);

  await ctx.call('agent-sessions-settings',{trayCount:'off'});
  await settle();
  assert.equal(ctx.tray(),null,'Turning it off takes the item away at once.');
  assert.equal(ctx.next(),null,'Turning it off drops the poll that was already waiting.');

  // The settings file can also be edited by hand, and once the count is off no timer is left to notice.
  // The panel's own read re-reads that file, so it is what starts the count again.
  ctx.core.stored.trayCount='needs';
  await ctx.call('agent-sessions');
  await settle();
  assert.equal(ctx.next(),5000,'A count turned back on in the file starts counting on the next panel read.');
  await ctx.poll();
  assert.deepEqual(ctx.tray()?.titles,['◐ 3']);
  const waiting=ctx.timers.length;
  await ctx.call('agent-sessions');
  await settle();
  assert.equal(ctx.timers.length,waiting,'A read while the count is already running schedules nothing extra.');
});

test('the item opens the panel, and its rows open sessions only through the checked path',async()=>{
  const ctx=await launch();
  const long=`claude:desktop:${'a'.repeat(300)}`;
  const rows=[session('claude:desktop:a'),session('claude:desktop:b',{title:'A title that runs on well past the room a menu row has',project:null}),
    session('cursor:ide:c',{app:'cursor',appLabel:'Cursor'}),session('codex:terminal:d',{app:'codex',appLabel:'Codex in Terminal'}),
    session('hermes:desktop:e',{app:'hermes',appLabel:'Hermes'}),session(long),session('claude:desktop:gone')];
  ctx.core.view=view({needsYou:7,sessions:rows});
  ctx.core.targets.set('claude:desktop:a',{kind:'url',url:'claude://session/a'});
  ctx.core.targets.set('claude:desktop:b',{kind:'url',url:'https://example.invalid/session'});
  ctx.core.targets.set(long,{kind:'url',url:'claude://session/long'});
  await ctx.poll();
  const tray=ctx.tray();
  assert.ok(tray);

  tray.emit('click');
  await settle();
  assert.deepEqual(ctx.sent.filter(([channel])=>channel==='summon:open-panel'),[['summon:open-panel','agent-sessions']]);

  tray.emit('right-click');
  const menu=tray.menus.at(-1);
  assert.deepEqual(Array.from(menu,item=>item.label??item.type),
    ['Excel recorder · Claude app · Harbor','A title that runs on well past the room · Claude app','Excel recorder · Cursor · Harbor','Excel recorder · Codex in Terminal · Harbor','Excel recorder · Hermes · Harbor','separator','Open the board','Stop counting'],
    'At most five sessions are named, each with its app and project.');

  menu[0].click();
  await settle();
  assert.deepEqual(ctx.opened,['claude://session/a']);
  menu[1].click();
  await settle();
  assert.deepEqual(ctx.opened,['claude://session/a'],'A link outside the allowed schemes is never opened.');
  assert.equal(ctx.dialogs.at(-1)?.[0],'That session could not be opened');

  // The rows are built from the last read, so an id that could not have come from one never reaches the core.
  ctx.core.view=view({needsYou:2,sessions:[session(long),session('claude:desktop:gone')]});
  await ctx.poll();
  const second=ctx.tray();
  second.emit('right-click');
  const later=second.menus.at(-1);
  const before=ctx.core.reads.length;
  later[0].click();
  await settle();
  assert.deepEqual(ctx.opened,['claude://session/a'],'An over-long id is refused before the core is asked.');
  assert.equal(ctx.dialogs.at(-1)?.[1],'Invalid session');
  later[1].click();
  await settle();
  assert.equal(ctx.dialogs.at(-1)?.[1],'That session is no longer in the list.');
  assert.equal(ctx.core.reads.length,before,'Opening a session never starts another read.');

  later.at(-2).click();
  await settle();
  assert.equal(ctx.sent.filter(([channel])=>channel==='summon:open-panel').length,2,'Open the board opens the same panel.');
  later.at(-1).click();
  await settle();
  assert.deepEqual(ctx.core.patches.map(patch=>patch.trayCount),['off'],'Stop counting turns the setting off.');
  assert.equal(ctx.tray(),null,'Stop counting takes the item away at once.');
});

test('the poll sleeps with the machine and stops when Summon quits',async()=>{
  const ctx=await launch();
  ctx.core.view=view({working:1});
  await ctx.poll();
  assert.ok(ctx.tray());
  ctx.power.get('suspend')();
  assert.equal(ctx.next(),null,'A sleeping machine is not polled.');
  ctx.power.get('resume')();
  assert.equal(ctx.next(),5000,'Waking up checks again shortly after.');
  const reads=ctx.core.reads.length;
  ctx.app.emit('before-quit',{preventDefault:noop});
  await settle();
  assert.equal(ctx.timers.length,0,'Quitting stops the poll and leaves no timer of its own behind.');
  assert.equal(ctx.counts()[0].destroyed,true,'Quitting takes the count out of the menu bar.');
  assert.equal(ctx.core.reads.length,reads);
});
