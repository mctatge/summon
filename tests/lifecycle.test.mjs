import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

test('native startup survives a failed file scan and quit waits for request cleanup',async()=>{
  let failScan,showWindow,failAnswer,finishCleanup,windowInstance,finishTranscriberClose,finishWarm;
  const scan=new Promise((_resolve,reject)=>{failScan=reject;});
  const shown=new Promise(resolve=>{showWindow=resolve;});
  const answer=new Promise((_resolve,reject)=>{failAnswer=reject;});
  const cleanup=new Promise(resolve=>{finishCleanup=resolve;});
  const transcriberCleanup=new Promise(resolve=>{finishTranscriberClose=resolve;});
  const warming=new Promise(resolve=>{finishWarm=resolve;});
  const handlers=new Map(),shortcuts=new Map(),sent=[];const fnMonitors=[];let fnStarts=0,fnStops=0;
  let trayCreations=0,trayMenu,wakeStarts=0,permissionRequest,permissionCheck;
  const launches=[];
  const warmCalls=[],transcriptionCalls=[],trayImages=[],backgroundColors=[];
  const nativeTheme=Object.assign(new EventEmitter(),{themeSource:'light',shouldUseDarkColors:true});
  let currentVoiceStatus={state:'off',mode:'off',micActive:false};
  let trayDestroys=0,stopCalls=0,finalQuits=0,cleanupStarted=false,cleanupFinished=false,bundledLoads=0,nativeKills=0,voiceCloses=0,voiceAcknowledgments=0,transcriberCloses=0;
  const app=new EventEmitter();
  Object.assign(app,{isPackaged:true,dock:{hide(){assert.fail('Summon keeps its Dock icon; there is no hidden mode.');}},setName(){},requestSingleInstanceLock:()=>true,getPath:()=>'/private/tmp/synthetic-summon-data',whenReady:()=>Promise.resolve(),quit(){const event={cancelled:false,preventDefault(){this.cancelled=true;}};app.emit('before-quit',event);if(!event.cancelled)finalQuits++;}});
  class Window extends EventEmitter{
    constructor(options){super();assert.equal(nativeTheme.themeSource,'system','System appearance is selected before creating the native window.');this.options=options;windowInstance=this;this.webContents=new EventEmitter();Object.assign(this.webContents,{mainFrame:{},send(channel){sent.push(channel);},setWindowOpenHandler(){}});}
    isDestroyed(){return this.destroyed===true;}
    setBackgroundColor(color){backgroundColors.push(color);}
    loadFile(){bundledLoads++;return Promise.resolve();}
    loadURL(){assert.fail('A packaged app must never load SUMMON_DEV_URL.');}
    show(){showWindow();}
    focus(){}
  }
  class Tray extends EventEmitter{constructor(){super();trayCreations++;}setToolTip(){}setContextMenu(menu){trayMenu=menu;}setTitle(){}setImage(image){trayImages.push(image);}popUpContextMenu(){}destroy(){trayDestroys++;}}
  const state={settings:{paused:false,activityEnabled:true,accessibilityEnabled:false,excludedApps:[],whisperModel:'/private/tmp/synthetic-model.bin'},health:{whisper:false},projects:[],files:[],events:[]};
  const service={snapshot:()=>state,setHealth(){},start:()=>scan,stop:async()=>{stopCalls++;}};
  const noop=()=>{};
  const missing=async()=>{throw new Error('Synthetic fixture has no optional files.');};
  const sealedDirs=[];
  const sourceURL=new URL('../src/main/main.mjs',import.meta.url);
  // Execute the real lifecycle with injected OS adapters; no Electron window,
  // filesystem watcher, microphone, or native child is launched by this test.
  const source=(await readFile(sourceURL,'utf8')).replace(/^import .*;\n/gm,'').replaceAll('import.meta.url',JSON.stringify(sourceURL.href));
  vm.runInNewContext(source,{
    app,BrowserWindow:Window,Tray,Menu:{buildFromTemplate:x=>x,setApplicationMenu:noop},screen:{},powerMonitor:{on:noop},nativeTheme,
    createDesktopTeachingBridge:()=>({}),createDesktopTeaching:async()=>({}),createTeaching:({browser})=>browser,
    createBrowserTeachingBridge:()=>({}),createBrowserTeaching:async()=>({read:async()=>({phase:'idle'}),action:async()=>({phase:'idle'}),handles:()=>false,command:async()=>null,cancel:async()=>{},close:async()=>{}}),
    createContextReasoning:async()=>({read:()=>({settings:{enabled:false,engine:'auto'}}),request:()=>({settings:{enabled:false,engine:'auto'}}),decorateSessions:view=>view,close:async()=>{}}),runContextReasoning:()=>assert.fail('No reasoning model runs in this fixture.'),
    createVisualWorkspace:async()=>({read:async()=>assert.fail('No visual read expected.'),saveGoal:async()=>assert.fail('No goal save expected.'),close:async()=>{}}),
    createDesktopVoice:options=>{assert.equal(options.mainWindow,windowInstance);assert.equal(typeof options.onStateChange,'function');return {publish:noop,updateVoice:value=>{voiceAcknowledgments++;currentVoiceStatus=value;options.onStateChange(value);},snapshot:()=>currentVoiceStatus,toggle:noop,stop:async()=>{},close:async()=>{voiceCloses++;}};},
    createTranscriber:options=>{assert.equal(options.workerPath,'/private/tmp/synthetic-resources/summon-transcribe');return {status:()=>({ready:false}),warm:model=>{warmCalls.push(model);return warming;},transcribe:async(audio,model)=>{transcriptionCalls.push({audio,model});return {text:'Synthetic phrase'};},release:async()=>{},close:async()=>{transcriberCloses++;finishWarm();await transcriberCleanup;}};},
    nativeImage:{createFromBitmap:pixels=>({pixels,setTemplateImage(value){this.template=value;}}),createEmpty:()=>({})},
    ipcMain:{handle:(name,handler)=>handlers.set(name,handler)},shell:{},dialog:{showErrorBox:(_title,message)=>assert.fail(message)},
    globalShortcut:{register:(key,callback)=>{shortcuts.set(key,callback);return true;},unregisterAll:()=>shortcuts.clear()},
    session:{defaultSession:{setPermissionRequestHandler(fn){permissionRequest=fn;},setPermissionCheckHandler(fn){permissionCheck=fn;}}},
    systemPreferences:{},safeStorage:{},
    spawn:(...args)=>{launches.push(args);const child=new EventEmitter();Object.assign(child,{stdout:new EventEmitter(),stderr:new EventEmitter(),kill(){nativeKills++;}});return child;},
    readFile:async file=>{if(String(file).endsWith('assistant-entry.json'))return '{"enabled":true,"menuOwner":"hermes"}';throw new Error('Synthetic fixture has no optional files.');},writeFile:noop,mkdir:noop,stat:missing,access:missing,chmod:noop,
    createWorkInFlight:async()=>({read:async()=>({}),group:()=>({}),settings:()=>({}),updateSettings:async()=>({}),placePath:()=>'/tmp',close:async()=>{}}),runGrouping:async()=>({raw:{},model:null}),GIT_ENV:{},
    createAgentSessions:async()=>({read:async()=>({}),openTarget:async()=>assert.fail('No session is opened at startup.'),settings:()=>({}),updateSettings:async()=>({}),close:async()=>{}}),sessionSummaryText:()=>'',clipboard:{writeText:()=>assert.fail('Nothing is copied at startup.')},
    homedir:()=>'/private/tmp/synthetic-home',path,fileURLToPath,
    createCompanion:async()=>service,classifyCommand:noop,createCommandSession:()=>({}),createKnowledge:async()=>({snapshot:()=>({}),refreshSources:async()=>{},search:async()=>[]}),createLocalInterpreter:()=>({status:()=>({}),health:async()=>{},close:async()=>{}}),createWakeDetector:()=>({status:()=>({}),start:async()=>{wakeStarts++;},stop:async()=>{}}),createSpeaker:()=>({status:()=>({}),start:async()=>{},stop:async()=>{},verify:async()=>({verified:true,score:1,elapsedMs:0}),beginEnrollment:async()=>({minSamples:10}),enrollAudio:async()=>({count:1,elapsedMs:0}),finishEnrollment:async()=>({saved:true,samples:0}),cancelEnrollment(){}}),createFnKeyMonitor:options=>{fnMonitors.push(options);return {status:()=>'off',start(){fnStarts++;},poke(){},stop(){fnStops++;}};},FN_KEY_ERROR_MESSAGE:'fn-error',createBenchmark:()=>noop,
    askEngine:()=>answer.finally(async()=>{cleanupStarted=true;await cleanup;cleanupFinished=true;}),
    createRpcServer:async()=>async()=>{},run:missing,scrubbedEnv:()=>({}),executable:missing,stopProcesses:async()=>{failAnswer(new Error('Synthetic shutdown cancellation'));},
    // The usage meter and engine choice: stubbed so no timer or CLI of theirs runs in this lifecycle.
    createTaskRouter:async ({ask,selectEngine,getUsage,getSettings})=>({choose:task=>selectEngine({task,usage:getUsage(),settings:getSettings()}),answer:(engine,text,snapshot,options)=>ask(engine,text,snapshot,options),close:async()=>{}}),
    createUsage:async()=>({status:()=>({version:1,settings:{usageCeiling:85,defaultEngine:'claude'},providers:{claude:null,codex:null},refreshing:[],problem:null}),settings:()=>({usageCeiling:85,defaultEngine:'claude'}),refresh:async()=>({}),updateSettings:async()=>({}),start:noop,pause:noop,resume:noop,stop:noop,close:async()=>{}}),usageText:()=>'',readClaudeUsage:missing,readCodexUsage:missing,chooseEngine:()=>({engine:'claude',reason:'stub'}),spawnLongLived:missing,
    loadSealedSegments:dir=>{sealedDirs.push(dir);return [];},
    createLauncher:()=>({launch:()=>assert.fail('Nothing launches at startup.'),installClaudeHooks:()=>assert.fail('Nothing installs hooks at startup.'),hookStatus:async()=>({claude:{installed:false,current:false}})}),
    process:{env:{SUMMON_DEV_URL:'http://127.0.0.1:5179'},resourcesPath:'/private/tmp/synthetic-resources',umask:noop},Buffer,console,setTimeout,clearTimeout,
  },{filename:fileURLToPath(sourceURL)});
  await shown;
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(windowInstance.options.backgroundColor,'#191b1a','Dark startup paints a dark canvas before the renderer loads.');
  nativeTheme.shouldUseDarkColors=false;nativeTheme.emit('updated');
  nativeTheme.shouldUseDarkColors=true;nativeTheme.emit('updated');
  assert.deepEqual(backgroundColors,['#eaeae8','#191b1a'],'An open window follows appearance changes in both directions.');
  assert.deepEqual(sealedDirs,[app.getPath('userData')],'sealed.json is applied once, from the data folder, before any reader starts.');
  assert.equal(launches.length,1,'Activity monitoring starts while the independent file scan is pending.');
  assert.equal(fnMonitors.length,1,'The Fn shortcut helper is always supervised.');assert.equal(typeof fnMonitors[0].onTap,'function');assert.equal(fnMonitors[0].executable,'/private/tmp/synthetic-resources/summon-fn-key');
  // Everything a leftover assistant-entry.json once gated now runs unconditionally: window, tray, shortcuts, wake, voice.
  assert.equal(wakeStarts,1,'The wake detector starts at launch.');
  assert.equal(trayCreations,1,'Summon owns its one menu-bar icon.');
  assert.deepEqual(Array.from(trayMenu,item=>item.label).filter(Boolean),['Open Summon','Start hands-free listening','Stop listening','Voice command','Enroll my voice','Refresh usage','Quit Summon']);
  assert.deepEqual([...shortcuts.keys()].sort(),['CommandOrControl+Shift+J','CommandOrControl+Shift+Space']);
  shortcuts.get('CommandOrControl+Shift+Space')();assert.deepEqual(sent.filter(channel=>channel==='summon:voice-toggle'),['summon:voice-toggle'],'⌘⇧Space toggles Summon’s own voice command.');
  // Microphone permission: the main window’s main frame, audio only; every other frame, window, kind or mix is refused.
  const grant=(contents,details)=>{let value;permissionRequest(contents,'media',decision=>{value=decision;},details);return value;};
  assert.equal(grant(windowInstance.webContents,{isMainFrame:true,mediaTypes:['audio']}),true);
  assert.equal(grant(windowInstance.webContents,{isMainFrame:false,mediaTypes:['audio']}),false);
  assert.equal(grant(windowInstance.webContents,{isMainFrame:true,mediaTypes:['video']}),false);
  assert.equal(grant(windowInstance.webContents,{isMainFrame:true,mediaTypes:['audio','video']}),false);
  assert.equal(grant({},{isMainFrame:true,mediaTypes:['audio']}),false);
  let other;permissionRequest(windowInstance.webContents,'geolocation',decision=>{other=decision;},{isMainFrame:true});assert.equal(other,false);
  assert.equal(permissionCheck(windowInstance.webContents,'media','',{isMainFrame:true,mediaType:'audio'}),true);
  assert.equal(permissionCheck(windowInstance.webContents,'media','',{isMainFrame:false,mediaType:'audio'}),false);
  assert.equal(permissionCheck(windowInstance.webContents,'media','',{isMainFrame:true,mediaType:'video'}),false);
  assert.equal(permissionCheck({},'media','',{isMainFrame:true,mediaType:'audio'}),false);
  // Fullscreen belongs only to the trusted main frame. Other windows, subframes,
  // missing frame identity, and unrelated permission kinds remain denied.
  const fullScreenGrant=(contents,details)=>{let value;permissionRequest(contents,'fullscreen',decision=>{value=decision;},details);return value;};
  assert.equal(fullScreenGrant(windowInstance.webContents,{isMainFrame:true}),true);
  assert.equal(fullScreenGrant(windowInstance.webContents,{isMainFrame:false}),false);
  assert.equal(fullScreenGrant(windowInstance.webContents,{}),false);
  assert.equal(fullScreenGrant({},{isMainFrame:true}),false);
  assert.equal(permissionCheck(windowInstance.webContents,'fullscreen','',{isMainFrame:true}),true);
  assert.equal(permissionCheck(windowInstance.webContents,'fullscreen','',{isMainFrame:false}),false);
  assert.equal(permissionCheck(windowInstance.webContents,'fullscreen','',{}),false);
  assert.equal(permissionCheck({},'fullscreen','',{isMainFrame:true}),false);
  assert.equal(permissionCheck(windowInstance.webContents,'geolocation','',{isMainFrame:true}),false);
  failScan(new Error('Synthetic initial scan save failure: ENOSPC'));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(nativeKills,0,'File scan failures do not stop the activity monitor.');
  const requestEvent={sender:windowInstance.webContents,senderFrame:windowInstance.webContents.mainFrame};
  let voiceStatusCompleted=false;
  const voiceStatus=handlers.get('summon:voice-state')(requestEvent,{state:'starting',mode:'handsfree',micActive:false}).then(()=>{voiceStatusCompleted=true;});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(voiceStatusCompleted,true,'Loading Whisper must not block microphone status acknowledgments.');
  await voiceStatus;
  assert.deepEqual(warmCalls,[state.settings.whisperModel]);
  assert.equal(trayImages.at(-1).template,true,'Starting alone does not light the star before capture is active.');
  await handlers.get('summon:voice-state')(requestEvent,{state:'listening',mode:'handsfree',micActive:true});
  assert.equal(trayImages.at(-1).template,false,'Active capture lights the star with its own color.');
  assert.ok(trayImages.at(-1).pixels.some((value,index)=>index%4!==3&&value>0));
  assert.equal(trayMenu.find(item=>item.label==='Start hands-free listening').enabled,false);
  assert.equal(trayMenu.find(item=>item.label==='Stop listening').enabled,true);
  const audio=new Uint8Array([1,2,3]);
  const transcript=await handlers.get('summon:transcribe')(requestEvent,audio);
  assert.equal(transcript.text,'Synthetic phrase');assert.equal(transcriptionCalls.length,1);
  assert.equal(transcriptionCalls[0].audio,audio);assert.equal(transcriptionCalls[0].model,state.settings.whisperModel);
  const request=handlers.get('summon:ask')(requestEvent,'codex','Synthetic question').catch(error=>error);
  await new Promise(resolve=>setImmediate(resolve));
  app.quit();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(cleanupStarted,true);
  assert.equal(cleanupFinished,false);
  assert.equal(finalQuits,0,'The app must await the request’s temporary-file cleanup.');
  await assert.rejects(handlers.get('summon:ask')(requestEvent,'codex','Another request'),/shutting down/);
  await handlers.get('summon:voice-state')(requestEvent,{state:'off',mode:'off',micActive:false});
  assert.equal(voiceAcknowledgments,3,'A trusted capture owner can acknowledge microphone release during shutdown.');
  await handlers.get('summon:voice-state')(requestEvent,{state:'starting',mode:'handsfree',micActive:false});
  assert.equal(warmCalls.length,1,'A late renderer status must not launch a transcription worker during shutdown.');
  await assert.rejects(handlers.get('summon:voice-state')({sender:{},senderFrame:{}},{state:'off',mode:'off',micActive:false}),/Untrusted/);
  assert.equal(trayImages.at(-1).template,true,'Released capture restores the monochrome star.');
  finishCleanup();
  await request;
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(cleanupFinished,true);
  assert.equal(finalQuits,0,'The app must also await the persistent transcription worker’s close.');
  finishTranscriberClose();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(finalQuits,1);
  assert.equal(bundledLoads,1);
  assert.equal(windowInstance.options.webPreferences.backgroundThrottling,false,'The capture owner keeps processing while the workbench is hidden.');
  assert.equal(handlers.has('summon:show-voice-widget'),false);
  assert.equal(voiceCloses,1,'Shutdown closes the voice controller once.');
  assert.equal(fnStops,1,'Shutdown stops the Fn shortcut helper.');
  assert.equal(stopCalls,1);
  assert.equal(launches.length,1,'No extra activity monitor starts during shutdown.');
  assert.equal(nativeKills,1);
  assert.equal(transcriberCloses,1);
  assert.equal(trayDestroys,0,'A quiet menu bar never had a count item to take away.');
  assert.equal(shortcuts.size,0,'Quitting unregisters both global shortcuts.');
  windowInstance.destroyed=true;nativeTheme.emit('updated');
  assert.equal(backgroundColors.length,2,'A theme change cannot address a destroyed native window.');
  windowInstance.emit('closed');
  assert.equal(nativeTheme.listenerCount('updated'),0,'Closing the native window releases its appearance listener.');
});
