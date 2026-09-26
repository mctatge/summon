import {app,BrowserWindow,ipcMain,Tray,Menu,nativeImage,nativeTheme,shell,dialog,globalShortcut,session,systemPreferences,safeStorage,powerMonitor} from 'electron';
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir,stat,access,chmod} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCompanion} from '../core/companion.mjs';
import {classifyCommand} from './commands.mjs';
import {createCommandSession} from './command-session.mjs';
import {createKnowledge} from '../core/knowledge.mjs';
import {createWorkInFlight} from '../core/work-in-flight.mjs';
import {lstat} from 'node:fs/promises';
import {GIT_ENV} from '../core/git-scan.mjs';
import {createAgentSessions,sessionSummaryText} from '../core/agent-sessions.mjs';
import {createVisualWorkspace} from '../core/visual-workspace.mjs';
import {createWorkRecovery} from '../core/work-recovery.mjs';
import {createWorkRecoverySources} from '../core/sessions/work-recovery-sources.mjs';
import {createCompletionReconciler} from '../core/goal-completion.mjs';
import {createContextReasoning} from '../core/context-reasoning.mjs';
import {runContextReasoning} from './context-engine.mjs';
import {createBrowserTeaching} from './browser-teaching.mjs';
import {createBrowserTeachingBridge} from './browser-teaching-bridge.mjs';
import {createDesktopTeaching} from './desktop-teaching.mjs';
import {createDesktopTeachingBridge} from './desktop-teaching-bridge.mjs';
import {createTeaching} from './teaching.mjs';
import {clipboard} from 'electron';
import {createLocalInterpreter} from './local-model.mjs';
import {createDesktopVoice} from './desktop-voice.mjs';
import {createWakeDetector} from './wake.mjs';
import {createSpeaker} from './speaker.mjs';
import {createFnKeyMonitor,FN_KEY_ERROR_MESSAGE} from './fn-key.mjs';
import {createBenchmark} from './benchmark.mjs';
import {askEngine} from './engines.mjs';
import {runGrouping} from './workstream-engine.mjs';
import {createTranscriber} from './transcription.mjs';
import {createRpcServer} from './rpc.mjs';
import {createLauncher} from './launcher.mjs';
import {loadSealedSegments,sealedPath} from '../core/workstreams.mjs';
import {createUsage,usageText} from '../core/usage.mjs';
import {readClaudeUsage} from './usage-claude.mjs';
import {readCodexUsage} from './usage-codex.mjs';
import {chooseEngine} from './engine-choice.mjs';
import {createTaskRouter} from './task-router.mjs';
import {run,scrubbedEnv,executable,stopProcesses,spawnLongLived} from './process.mjs';

process.umask(0o077);app.setName('Summon');
if(process.env.SUMMON_DATA_DIR)app.setPath('userData',process.env.SUMMON_DATA_DIR);
const single=app.requestSingleInstanceLock();if(!single){app.quit();}else{
  let window,tray,trayIcons,voiceControl,service,native,closeRpc,knowledge,commands,localModel,wake,speaker,fnKey,transcriber,quitting=false,benchmarkData,benchmark,voiceBusy=false,engineBusy=false,keyConfigured=false;
  let transcriptionEngaged=false;
  let nativeGeneration=0,nativeSignature='',nativeBuffer='',shutdownComplete=false;
  let workInFlight;
  let agentSessions;
  let visualWorkspace;
  let workRecovery,recoverySources,recoveryTimer,recoveryAsleep=false;
  let contextReasoning,reasoningTimer,reasoningAsleep=false;
  let teaching;
  const recentInputs=[];
  const noteInput=text=>{if(typeof text==='string'&&text.trim()&&!service.snapshot().settings.paused&&contextReasoning?.read().settings.enabled){recentInputs.push({text:text.slice(0,2000),projectId:service.snapshot().currentProjectId,at:Date.now()});while(recentInputs.length>6)recentInputs.shift();}};
  // Starts claude or codex in Terminal on a click; see launcher.mjs and docs/decisions.md 2026-09-19.
  let launcher;
  // The usage meter: what each CLI says about its own subscription windows; see src/core/usage.mjs and docs/decisions.md 2026-09-19.
  let usage,taskRouter,refreshTrayMenu=()=>{};
  // Set once the menu-bar count is running; quitting stops its timer and takes the item out of the menu bar.
  let stopStatus;
  const pendingRequests=new Set();
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
  const nativePath=app.isPackaged?path.join(process.resourcesPath,'summon-context'):path.join(root,'native/summon-context');
  const transcriptionPath=app.isPackaged?path.join(process.resourcesPath,'summon-transcribe'):path.join(root,'native/summon-transcribe');
  const dataDir=app.getPath('userData');
  // Sealed folders: path segments Summon never reads, opens or launches into, from <dataDir>/sealed.json ({"segments":[...]}) on this machine; nothing is shipped and the applied list is never shown.
  loadSealedSegments(dataDir,{warn:message=>console.error(message)});
  const snapshot=()=>({...service.snapshot(),teaching:teaching?.brief?.(),benchmark:benchmarkData,knowledge:knowledge?.snapshot(),localModel:localModel?.status(),wake:wake?.status(),speaker:speaker?.status(),fnKey:fnKey?{status:fnKey.status()}:undefined,usage:usage?.status(),settings:{...service.snapshot().settings,benchmarkKeyConfigured:keyConfigured},dataDir});
  const push=()=>{if(service&&window&&!window.isDestroyed())window.webContents.send('summon:update',snapshot());voiceControl?.publish();};
  const revealWindow=()=>{if(window&&!window.isDestroyed()){if(window.webContents.isCrashed?.())window.webContents.reload();window.show();window.focus();}else if(window){app.relaunch();app.quit();}};
  const trusted=event=>Boolean(window&&event.sender===window.webContents&&event.senderFrame===window.webContents.mainFrame);
  const handle=(name,fn)=>ipcMain.handle(`summon:${name}`,async(event,...args)=>{
    if(!trusted(event))throw new Error('Untrusted request');
    if(quitting&&name!=='voice-state')throw new Error('Summon is shutting down.');
    const request=Promise.resolve().then(()=>{if(quitting&&name!=='voice-state')throw new Error('Summon is shutting down.');return fn(...args);});
    pendingRequests.add(request);try{return await request;}finally{pendingRequests.delete(request);}
  });
  const validId=id=>{if(typeof id!=='string'||id.length>200)throw new Error('Invalid item');return id;};
  async function refreshKnowledge(){
    const projects=service.snapshot().projects;
    const vault=projects.find(project=>project.name.toLowerCase()==='second brain');
    await knowledge.refreshSources({vaultPath:vault?.path??null,projects});
  }
  async function searchKnowledge(query,options={}){await refreshKnowledge();return knowledge.search(query,options);}
  async function sourceMetadata(file){try{const {stdout}=await run(nativePath,['metadata',file],{timeout:3000,maxBytes:8000});return JSON.parse(stdout);}catch{return {};}}
  async function openFile(id){const file=await service.getFile(validId(id));if(!file)throw new Error('This file is no longer available.');const error=await shell.openPath(file.path);if(error)throw new Error(error);}
  async function openCalendar(){const url=service.snapshot().settings.calendarUrl;if(url){const parsed=new URL(url);if(parsed.protocol!=='https:')throw new Error('Calendar URL must start with https://');await shell.openExternal(parsed.href);}else await run('/usr/bin/open',['-a','Calendar']);}
  async function openLink(name){
    const links={'file-access':'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders',benchmark:'https://aistupidlevel.info/',accessibility:'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',microphone:'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone','input-monitoring':'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent'};
    if(name==='calendar')return openCalendar();
    if(name==='claude-login')return run('/usr/bin/open',['-a','Terminal',app.isPackaged?path.join(process.resourcesPath,'claude-login.command'):path.join(root,'scripts/claude-login.command')]);
    if(name==='codex-login')return run('/usr/bin/open',['-a','Terminal',app.isPackaged?path.join(process.resourcesPath,'codex-login.command'):path.join(root,'scripts/codex-login.command')]);
    if(name==='data-folder'){const error=await shell.openPath(dataDir);if(error)throw new Error(error);return;}
    if(!Object.hasOwn(links,name))throw new Error('Unknown shortcut');return shell.openExternal(links[name]);
  }
  async function getKey(){try{const raw=await readFile(path.join(dataDir,'benchmark-key.bin'));return safeStorage.decryptString(raw);}catch{return '';}}
  async function restartNative(){
    if(quitting)return;
    const settings=service.snapshot().settings;
    const sig=JSON.stringify([settings.paused,settings.activityEnabled,settings.accessibilityEnabled,settings.excludedApps]);
    if(sig===nativeSignature)return;nativeSignature=sig;const generation=++nativeGeneration;native?.kill();native=null;nativeBuffer='';
    if(settings.paused||!settings.activityEnabled){await service.setHealth({native:false});return;}
    const args=['watch'];if(settings.accessibilityEnabled)args.push('--accessibility');if(settings.excludedApps?.length)args.push('--exclude',settings.excludedApps.join(','));
    native=spawn(nativePath,args,{env:scrubbedEnv(),stdio:['ignore','pipe','pipe']});
    native.on('error',async()=>{if(generation===nativeGeneration)await service.setHealth({native:false});});
    native.on('spawn',()=>service.setHealth({native:true}));
    native.stdout.on('data',chunk=>{
      if(generation!==nativeGeneration)return;nativeBuffer+=chunk;
      if(nativeBuffer.length>100000){nativeBuffer='';return;}
      const lines=nativeBuffer.split('\n');nativeBuffer=lines.pop();
      for(const line of lines){try{const event=JSON.parse(line);if(event.type==='activity')Promise.resolve(service.ingestActivity(event)).catch(error=>console.error('Activity update failed:',error.message));else if(event.type==='activity-hidden')Promise.resolve(service.clearActivity()).catch(error=>console.error(error.message));else if(event.type==='permissions')Promise.resolve(service.setHealth({accessibility:event.accessibility===true})).catch(error=>console.error(error.message));}catch{}}
    });
    native.stderr.on('data',()=>{});
    native.on('exit',()=>{if(generation===nativeGeneration){service.setHealth({native:false});nativeSignature='';}});
  }
  app.on('second-instance',revealWindow);
  app.on('activate',()=>{if(window)revealWindow();});
  app.whenReady().then(async()=>{
    await mkdir(dataDir,{recursive:true,mode:0o700});await chmod(dataDir,0o700);
    service=await createCompanion({dataDir,homeDir:!app.isPackaged&&process.env.SUMMON_TEST_HOME?path.resolve(process.env.SUMMON_TEST_HOME):homedir(),emit:()=>push(),metadata:sourceMetadata});
    // Personal bootstrap is external to the application bundle and is never distributed.
    try{const bootstrap=JSON.parse(await readFile(path.join(dataDir,'bootstrap.json'),'utf8'));for(const project of (bootstrap.projects||[]).slice(0,30)){if(typeof project.path==='string'&&path.isAbsolute(project.path)&&!service.snapshot().projects.some(p=>p.path===project.path))await service.addProject(project);}}catch{}
    knowledge=await createKnowledge({dataDir,projects:service.snapshot().projects,validateCommand:classifyCommand});
    localModel=createLocalInterpreter();
    const desktopTeachingBridge=createDesktopTeachingBridge({binary:app.isPackaged?path.join(process.resourcesPath,'summon-teaching'):path.join(root,'native/summon-teaching')});
    teaching=createTeaching({
      desktop:await createDesktopTeaching({dataDir,bridge:desktopTeachingBridge,localModel,onChange:push,excludedApps:()=>service.snapshot().settings.excludedApps??[],requestPermissions:()=>desktopTeachingBridge.request('request-permissions')}),
      browser:await createBrowserTeaching({dataDir,bridge:createBrowserTeachingBridge({onChange:()=>teaching?.connectionChanged()}),onChange:push}),onChange:push,
    });
    transcriber=createTranscriber({workerPath:transcriptionPath});
    wake=createWakeDetector({dataDir,workerPath:app.isPackaged?path.join(process.resourcesPath,'wake/wake-worker.py'):path.join(root,'native/wake/wake-worker.py')});
    speaker=createSpeaker({dataDir,workerPath:app.isPackaged?path.join(process.resourcesPath,'speaker/speaker-worker.py'):path.join(root,'native/speaker/speaker-worker.py')});
    const settings=service.snapshot().settings;
    if(!settings.whisperModel){const model=path.join(homedir(),'.cache/whisper-cpp/models/ggml-small.en.bin');try{await access(model);await service.updateSettings({whisperModel:model});}catch{}}
    try{await access(transcriptionPath);await access(service.snapshot().settings.whisperModel);await service.setHealth({whisper:true});}catch{await service.setHealth({whisper:false});}
    keyConfigured=Boolean(await getKey());
    benchmark=createBenchmark({dataDir,getKey,onUpdate:value=>{benchmarkData=value;push();}});
    // Native chrome and CSS prefers-color-scheme both follow macOS. Match the
    // renderer canvas before its first paint and whenever the system changes.
    nativeTheme.themeSource='system';
    const windowBackground=()=>nativeTheme.shouldUseDarkColors?'#191b1a':'#eaeae8';
    window=new BrowserWindow({width:1120,height:790,minWidth:760,minHeight:600,title:'Summon',titleBarStyle:'hiddenInset',trafficLightPosition:{x:18,y:18},backgroundColor:windowBackground(),show:false,webPreferences:{preload:path.join(root,'src/main/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
    const updateWindowBackground=()=>{if(!window.isDestroyed())window.setBackgroundColor(windowBackground());};
    nativeTheme.on('updated',updateWindowBackground);
    window.on('closed',()=>nativeTheme.removeListener('updated',updateWindowBackground));
    window.on('close',event=>{if(!quitting){event.preventDefault();window.hide();}});
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    window.webContents.on('will-navigate',event=>event.preventDefault());
    session.defaultSession.setPermissionRequestHandler((contents,permission,callback,details)=>callback(contents===window.webContents&&details.isMainFrame===true&&(permission==='fullscreen'||permission==='media'&&details.mediaTypes?.length===1&&details.mediaTypes[0]==='audio')));
    session.defaultSession.setPermissionCheckHandler((contents,permission,_origin,details)=>contents===window.webContents&&details.isMainFrame===true&&(permission==='fullscreen'||permission==='media'&&details.mediaType==='audio'));
    voiceControl=createDesktopVoice({powerMonitor,mainWindow:window,onStateChange:value=>{
      const active=value.micActive===true;
      if(tray){tray.setImage(active?trayIcons.listening:trayIcons.off);tray.setToolTip(active?'Summon · microphone listening locally':'Summon · microphone off');refreshTrayMenu();}
      // Load in parallel with microphone startup, then reuse the same model for
      // the listening session. A dormant app does not reserve Whisper memory.
      const engaged=value.mode!=='off';
      if(engaged!==transcriptionEngaged){
        transcriptionEngaged=engaged;
        if(engaged&&!quitting)void transcriber.warm(service.snapshot().settings.whisperModel).catch(error=>console.error('Speech preparation:',error.message));
        else if(!engaged)transcriber.release();
      }
    },getHealth:()=>({wake:wake.status().available&&wake.status().loaded,whisper:service.snapshot().health.whisper})});
    handle('snapshot',snapshot);
    handle('show-window',revealWindow);
    commands=createCommandSession({service,knowledge,openCalendar,openBenchmark:()=>openLink('benchmark'),fetchBenchmark:benchmark,openFile,launchAgent:options=>launcher.launch(options)});
    // Work in flight: read-only git status; grouping runs only on an explicit request (panel, CLI or agent tool).
    const sendWorkInFlight=()=>{if(!quitting&&workInFlight)workInFlight.read({maxAgeMs:60000}).then(view=>{if(!quitting&&window&&!window.isDestroyed())window.webContents.send('summon:work-in-flight',view);}).catch(()=>{});};
    try{workInFlight=await createWorkInFlight({dataDir,homeDir:homedir(),getProjects:async()=>service.snapshot().projects,run,git:await executable('git').catch(()=>'/usr/bin/git'),env:scrubbedEnv(GIT_ENV),group:(engine,request)=>runGrouping(engine,request,{executable,run,scrubbedEnv}),onChange:sendWorkInFlight,
      // Where this stands asks once per read which folders have an agent working in them. Cache only: it reads the
      // last session check and never starts one, so a Work in flight read never pulls a session pass onto its path.
      agentPlaces:async()=>agentSessions?.placeCounts?.()??{}});}catch(error){service.setHealth({errors:[`Work in flight: ${error.message}`]});}
    const flight=()=>{if(!workInFlight)throw new Error('Work in flight is not available right now.');return workInFlight;};
    const flightOptions=(value,types)=>{const options=value??{};if(typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>!Object.hasOwn(types,key)||(options[key]!==undefined&&typeof options[key]!==types[key])))throw new Error('Invalid request');return options;};
    handle('work-in-flight',async options=>flight().read({maxAgeMs:flightOptions(options,{refresh:'boolean'}).refresh===true?0:20000}));
    handle('work-in-flight-group',async(repoId=null,options)=>{const {force,reason='panel'}=flightOptions(options,{force:'boolean',reason:'string'});if(!['panel','open'].includes(reason))throw new Error('Invalid request');return flight().group({repoId:repoId===null?null:validId(repoId),force:force===true,reason});});
    handle('work-in-flight-settings',async patch=>{if(!patch||typeof patch!=='object'||Array.isArray(patch))throw new Error('Invalid preferences');await flight().updateSettings(patch);return workInFlight.read({maxAgeMs:60000});});
    // Reveal only: shell.openPath would hand a bundle-shaped folder (Tool.app) or a file to LaunchServices and run it.
    handle('work-in-flight-reveal',async placeId=>{const target=flight().placePath(validId(placeId));const info=await lstat(target).catch(()=>null);if(!info||!info.isDirectory())throw new Error('That folder no longer exists.');shell.showItemInFolder(target);});
    // Where this stands: the watermark the panel advances only after a project section has been looked at, or on an explicit Mark as read. null means every project.
    handle('work-in-flight-mark',async(repoId=null)=>{const service=flight();if(typeof service.markStanding!=='function')throw new Error('Marking what you have seen is not available in this Summon version.');await service.markStanding(repoId===null||repoId===undefined?null:validId(repoId));});
    // Agent sessions: read-only metadata about Claude, Codex, Cursor and Hermes sessions. The window polls only while it shows them.
    try{agentSessions=await createAgentSessions({dataDir,homeDir:homedir(),run,getPlaces:async()=>workInFlight?.places?.()??[],getProjects:async()=>service.snapshot().projects,privatePathsFor:p=>workInFlight?.settings?.().privatePaths?.[p]||[]});}catch(error){service.setHealth({errors:[`Agent sessions: ${error.message}`]});}
    const sessions=()=>{if(!agentSessions)throw new Error('Agent sessions are not available right now.');return agentSessions;};
    // Starting a session: trusted-window IPC only. No RPC, MCP or CLI path reaches these three handlers.
    launcher=createLauncher({dataDir,homeDir:homedir(),root,resourcesPath:process.resourcesPath,isPackaged:app.isPackaged,run,executable,getProjects:async()=>service.snapshot().projects,agentSessions,benchmark});
    handle('agent-launch',options=>{const {app:engine,projectId,task,modelPreference,effort}=flightOptions(options,{app:'string',projectId:'string',task:'string',modelPreference:'string',effort:'string'});return launcher.launch({app:engine,projectId,...(task!==undefined?{task}:{}),...(modelPreference!==undefined?{modelPreference}:{}),...(effort!==undefined?{effort}:{})});});
    handle('claude-hooks-install',()=>launcher.installClaudeHooks());
    handle('claude-hooks-status',()=>launcher.hookStatus());
    // Opening builds the target in core from the last read; main re-checks the scheme and the app that handles it.
    const SESSION_APPS={'claude:':['Claude'],'codex:':['ChatGPT','Codex'],'cursor:':['Cursor'],'hermes:':['Hermes']};
    // The window keeps its timers running while hidden (backgroundThrottling is off), so polls from a hidden window get the last check.
    const sessionsShown=()=>Boolean(window&&!window.isDestroyed()&&window.isVisible()&&!window.isMinimized());
    try{visualWorkspace=await createVisualWorkspace({dataDir,run,git:await executable('git').catch(()=>'/usr/bin/git'),env:scrubbedEnv(GIT_ENV),
      getWorkInFlight:()=>flight().read({maxAgeMs:20000}),getAgentSessions:async()=>{const view=await sessions().read({maxAgeMs:sessionsShown()?3000:Infinity,includeContext:contextReasoning?.read().settings.enabled===true});return contextReasoning?.decorateSessions(view)??view;},getReasoning:()=>contextReasoning?.read()??null,
      traceSession:key=>sessions().trace(key),getPrivatePaths:repoPath=>workInFlight?.settings?.().privatePaths?.[repoPath]||[]});
    }catch(error){service.setHealth({errors:[`Visual workspace: ${error.message}`]});}
    const visuals=()=>{if(!visualWorkspace)throw new Error('Visual workspace is not available right now.');return visualWorkspace;};
    handle('visual-repository',(repoId,options)=>visuals().read(validId(repoId),options));
    handle('visual-goal-save',input=>visuals().saveGoal(input));
    handle('work-tree',(options={})=>visuals().readTree(options));
    // Opt-in per-project recovery reads local conversation records without a model,
    // independently of the visible panel. Enabling/scanning/reviewing stays window-only.
    try{
      recoverySources=await createWorkRecoverySources({homeDir:!app.isPackaged&&process.env.SUMMON_TEST_HOME?path.resolve(process.env.SUMMON_TEST_HOME):homedir(),run});
      workRecovery=await createWorkRecovery({dataDir,getRepositories:async()=>(await flight().read({maxAgeMs:20000})).repos,
        sourceReader:recoverySources,privatePathsFor:repoPath=>workInFlight?.settings?.().privatePaths?.[repoPath]||[],
        isPaused:()=>quitting||recoveryAsleep||service.snapshot().settings.paused});
    }catch(error){await Promise.resolve().then(()=>recoverySources?.close?.()).catch(()=>{});recoverySources=undefined;service.setHealth({errors:[`Work recovery: ${error.message}`]});}
    const recovery=()=>{if(!workRecovery)throw new Error('Work recovery is not available right now.');return workRecovery;};
    // The user's own recovered words may report an open goal as needs-verification, never done; see docs/decisions.md 2026-09-23.
    let completions=null;
    try{if(workRecovery&&visualWorkspace)completions=createCompletionReconciler({
      listMessages:async()=>{const open=new Set(((await flight().read({maxAgeMs:20000})).repos??[]).filter(repo=>!sealedPath(repo.path)).map(repo=>repo.id));return (await workRecovery.userMessages()).filter(entry=>open.has(entry.repoId));},
      readGoals:repoId=>visualWorkspace.explicitGoals(repoId),saveGoal:patch=>visualWorkspace.saveGoal(patch,{actor:'agent'}),
      isPaused:()=>quitting||recoveryAsleep||service.snapshot().settings.paused});}catch(error){service.setHealth({errors:[`Goal completion: ${error.message}`]});}
    const completionErrors=new Set();
    async function reconcileCompletions(){
      if(!completions||quitting||recoveryAsleep||service.snapshot().settings.paused)return;
      let errors=[];
      try{const result=await completions.run();errors=result.errors.map(error=>`Goal completion: ${error}`);if(result.reported.length)push();}
      catch(error){errors=[`Goal completion: ${error.message}`];}
      // A later clean pass clears this path's earlier errors; each pass retries on its own.
      if(errors.length){for(const error of errors)completionErrors.add(error);service.setHealth({errors});}
      else if(completionErrors.size){service.setHealth({resolved:[...completionErrors]});completionErrors.clear();}
    }
    handle('work-recovery',options=>recovery().read(options));
    handle('work-recovery-enabled',async options=>{const result=await recovery().setEnabled(options);push();return result;});
    handle('work-recovery-scan',async options=>{const result=await recovery().scan(options);await reconcileCompletions();push();return result;});
    handle('work-recovery-review',async options=>{const result=await recovery().review(options);push();return result;});
    function scheduleRecovery(delay=60000){
      clearTimeout(recoveryTimer);recoveryTimer=undefined;
      if(quitting||recoveryAsleep||!workRecovery)return;
      recoveryTimer=setTimeout(async()=>{
        recoveryTimer=undefined;
        try{if(!service.snapshot().settings.paused){await recovery().scan({});await reconcileCompletions();}}
        catch(error){service.setHealth({errors:[`Work recovery: ${error.message}`]});}
        finally{scheduleRecovery();}
      },delay);
      recoveryTimer.unref?.();
    }
    powerMonitor.on('suspend',()=>{recoveryAsleep=true;clearTimeout(recoveryTimer);recoveryTimer=undefined;});
    powerMonitor.on('resume',()=>{recoveryAsleep=false;scheduleRecovery(5000);});
    const reasoningScope=()=>JSON.stringify([service.snapshot().projects,service.snapshot().settings.paused,service.snapshot().settings.activityEnabled,service.snapshot().settings.accessibilityEnabled,service.snapshot().settings.excludedApps,workInFlight?.settings?.(),agentSessions?.settings?.()]);
    try{contextReasoning=await createContextReasoning({dataDir,getScope:reasoningScope,getSelectedRepoId:()=>service.snapshot().currentProjectId??null,
      getInput:async({repoId=null}={})=>{
        const [flightView,sessionView]=await Promise.all([flight().read({maxAgeMs:60000}),sessions().read({maxAgeMs:3000,forAgent:true,includeRecent:true,includeContext:true})]);
        const state=service.snapshot(),repos=(flightView.repos??[]).filter(repo=>repoId===null||repo.id===repoId);
        if(repoId!==null&&!repos.length)throw new Error('Choose a known repository for goal reasoning.');
        let projectNotes=[];
        if(!state.settings.paused){
          await refreshKnowledge();
          // Exact registered mappings only; the global view reads a bounded
          // selection of hubs, with Working in first. Never discover new paths.
          const projectIds=repos.map(repo=>state.projects.find(project=>project.path===repo.path)?.id).filter(Boolean).sort((a,b)=>Number(b===state.currentProjectId)-Number(a===state.currentProjectId)).slice(0,repoId===null?4:1);
          for(const projectId of projectIds)projectNotes.push(...await knowledge.projectContext(projectId,{limit:repoId===null?4:8}));
        }
        return {flight:flightView,sessions:sessionView,snapshot:state,projectNotes,explicitGoals:repos.flatMap(repo=>visualWorkspace?.explicitGoals(repo.id)??[]),utterances:recentInputs,privatePaths:workInFlight?.settings?.().privatePaths??{}};
      },
      infer:(engine,request)=>runContextReasoning(engine,request,{localModel,executable,run,scrubbedEnv}),
      selectEngine:async()=>{const local=await localModel.health();return local.available?'local':chooseEngine({usage:usage?.status(),settings:usage?.settings?.()}).engine;}});
    }catch(error){service.setHealth({errors:[`Context reasoning: ${error.message}`]});}
    const reasoning=()=>{if(!contextReasoning)throw new Error('Context reasoning is not available right now.');return contextReasoning;};
    handle('context-reasoning',options=>{
      const value=options??{};
      if(typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['refresh','repoId','release'].includes(key))||(value.refresh!==undefined&&typeof value.refresh!=='boolean')||(value.release!==undefined&&typeof value.release!=='boolean')||(value.repoId!==undefined&&value.repoId!==null&&(typeof value.repoId!=='string'||!value.repoId||value.repoId.length>200)))throw new Error('Invalid request');
      if(value.release===true)return reasoning().releaseFocus();
      return reasoning().request({force:value.refresh===true,...(value.repoId!==undefined?{repoId:value.repoId}:{})});
    });
    handle('context-reasoning-settings',async patch=>{const view=await reasoning().updateSettings(patch);if(!view.settings.enabled)recentInputs.length=0;else reasoning().poll();return view;});
    function scheduleReasoning(delay=60000){clearTimeout(reasoningTimer);if(quitting||reasoningAsleep||!contextReasoning)return;reasoningTimer=setTimeout(()=>{reasoningTimer=undefined;if(!service.snapshot().settings.paused)contextReasoning.poll();scheduleReasoning();},delay);reasoningTimer.unref?.();}
    powerMonitor.on('suspend',()=>{reasoningAsleep=true;clearTimeout(reasoningTimer);reasoningTimer=undefined;});
    powerMonitor.on('resume',()=>{reasoningAsleep=false;scheduleReasoning(5000);});
    handle('agent-sessions',async options=>{const refresh=flightOptions(options,{refresh:'boolean'}).refresh===true;const view=await sessions().read({maxAgeMs:refresh?0:sessionsShown()?3000:Infinity,includeContext:contextReasoning?.read().settings.enabled===true});
      // This read has just re-read the settings file, so a count turned back on by hand starts counting again here.
      // Nothing else would: once it is off there is no timer left to notice the edit.
      if(!statusTimer&&trayCount()!=='off')scheduleStatus(TRAY_FIRST);
      if(sessionsShown()&&!service.snapshot().settings.paused)contextReasoning?.poll();
      return contextReasoning?.decorateSessions(view)??view;});
    // Hook metadata belongs to a known session even when it has no repository. Core resolves the identity from
    // its last session read; this window-only bridge never reads a transcript or initiates a repository scan.
    handle('agent-session-trace',key=>{if(typeof key!=='string'||!key||key.length>300)throw new Error('Invalid session');return sessions().trace(key);});
    // One open path for the window and the menu bar: the id is checked here and the link is built in core from the
    // last read, so neither caller ever hands over a link of its own.
    async function openAgentSession(key){
      if(typeof key!=='string'||!key||key.length>300)throw new Error('Invalid session');
      const target=await sessions().openTarget(key);
      if(target?.kind==='url'){
        let url=null;try{if(typeof target.url==='string'&&target.url.length<=600)url=new URL(target.url);}catch{}
        const names=url&&!url.username&&!url.password&&Object.hasOwn(SESSION_APPS,url.protocol)?SESSION_APPS[url.protocol]:null;
        if(!names)throw new Error('This session cannot be opened from Summon.');
        const handler=String(app.getApplicationNameForProtocol(url.href)||'');
        if(!names.some(name=>handler.includes(name)))throw new Error('The app for this session is not installed.');
        await shell.openExternal(url.href);return {opened:true};
      }
      if(target?.kind==='copy'&&typeof target.text==='string'&&target.text.length<=2000){clipboard.writeText(target.text);return {copied:true};}
      if(target?.kind==='folder'&&typeof target.path==='string'&&path.isAbsolute(target.path)){const info=await lstat(target.path).catch(()=>null);if(!info||!info.isDirectory())throw new Error('That folder no longer exists.');shell.showItemInFolder(target.path);return {shown:true};}
      throw new Error('This session cannot be opened from Summon.');
    }
    handle('agent-session-open',openAgentSession);
    // The usage meter: each CLI reports its own subscription windows through one bounded, tool-less invocation
    // (src/main/usage-claude.mjs, usage-codex.mjs). Read every five minutes, on request, and by the engine choice below.
    try{usage=await createUsage({dataDir,readers:{claude:()=>readClaudeUsage({executable,spawnChild:spawnLongLived}),codex:()=>readCodexUsage({executable,spawnChild:spawnLongLived})},onChange:()=>{push();refreshTrayMenu();}});}catch(error){service.setHealth({errors:[`Usage meter: ${error.message}`]});}
    const meter=()=>{if(!usage)throw new Error('The usage meter is not available right now.');return usage;};
    taskRouter=await createTaskRouter({dataDir,getUsage:()=>usage?.status()??null,getSettings:()=>usage?.settings()??{},benchmark,ask:askEngine,selectEngine:chooseEngine});
    // Task rules and user-rated outcomes run locally; quota remains the fallback until quality evidence is sufficient.
    const pickEngine=task=>taskRouter.choose(task);
    handle('route-preview',(engine,text,options)=>taskRouter.preview(engine,text,options));
    handle('route-feedback',(id,rating)=>taskRouter.feedback(id,rating));
    handle('route-history-clear',()=>taskRouter.clear());
    handle('usage',async options=>{const {refresh,provider}=flightOptions(options,{refresh:'boolean',provider:'string'});if(provider!==undefined&&!['claude','codex'].includes(provider))throw new Error('Invalid provider');return refresh===true?meter().refresh(provider):meter().status();});
    handle('usage-settings',async patch=>{if(!patch||typeof patch!=='object'||Array.isArray(patch))throw new Error('Invalid preferences');await meter().updateSettings(patch);return usage.status();});
    // The menu bar count: on a timer it re-reads the same local session metadata the
    // panel reads, and nothing else: no model, no network, no writes. It keeps a status item only while something
    // needs you or is working, sleeps with the machine, and does not run at all when the setting is off.
    const TRAY_FAST=20000,TRAY_SLOW=60000,TRAY_FIRST=5000,TRAY_ROWS=5,TRAY_TITLE=40;
    let statusTray,statusTimer,statusRows=[],statusAsleep=false;
    const trayCount=()=>{try{const value=agentSessions?.settings().trayCount;return value==='working'||value==='off'?value:'needs';}catch{return 'needs';}};
    // Takes the item out of the menu bar and stops the timer with it, so turning the count off really does stop all reading.
    const clearStatus=()=>{clearTimeout(statusTimer);statusTimer=undefined;statusRows=[];statusTray?.destroy();statusTray=undefined;};
    const openSessionsPanel=()=>{revealWindow();if(window&&!window.isDestroyed())window.webContents.send('summon:open-panel','agent-sessions');};
    const statusMenu=()=>Menu.buildFromTemplate([
      ...statusRows.map(row=>({label:row.label,click:()=>{openAgentSession(row.key).catch(error=>dialog.showErrorBox('That session could not be opened',error.message));}})),
      ...(statusRows.length?[{type:'separator'}]:[]),
      {label:'Open the board',click:openSessionsPanel},
      {label:'Stop counting',click:()=>{Promise.resolve().then(()=>sessions().updateSettings({trayCount:'off'})).then(clearStatus).catch(error=>dialog.showErrorBox('The menu-bar count could not be turned off',error.message));}},
    ]);
    // Untrusted app text: core has already cleaned it, so this only has to fit a menu row without splitting a pair of surrogates.
    const statusLabel=session=>[String(session.title??'').slice(0,TRAY_TITLE).replace(/[\ud800-\udbff]$/,'').trim(),session.appLabel,session.project].filter(Boolean).join(' · ');
    const showStatus=(view,mode)=>{
      const needsYou=view?.summary?.needsYou??0;
      const working=(view?.summary?.working??0)+(mode==='working'?view?.summary?.backgroundWorking??0:0);
      if(!needsYou&&!working){clearStatus();return false;}
      statusRows=(view.groups?.find(group=>group.id==='needs-you')?.sessions??[]).slice(0,TRAY_ROWS).map(session=>({key:session.key,label:statusLabel(session)}));
      // Plain text rather than a second icon: it takes the menu bar's own colour on either theme, and a digit beside a
      // half-filled circle can never be mistaken for Summon's own star icon.
      if(!statusTray){statusTray=new Tray(nativeImage.createEmpty());statusTray.on('click',openSessionsPanel);statusTray.on('right-click',()=>statusTray.popUpContextMenu(statusMenu()));}
      statusTray.setTitle(needsYou?`◐ ${needsYou}`:'◉',{fontType:'monospacedDigit'});
      statusTray.setToolTip(sessionSummaryText({needsYou,working}));
      return true;
    };
    const scheduleStatus=delay=>{clearTimeout(statusTimer);statusTimer=undefined;if(quitting||statusAsleep)return;statusTimer=setTimeout(()=>{void checkStatus();},delay);statusTimer.unref?.();};
    async function checkStatus(){
      statusTimer=undefined;
      if(quitting||statusAsleep||!agentSessions||trayCount()==='off')return;
      let view=null;try{view=await agentSessions.read({maxAgeMs:0});}catch{}
      const mode=trayCount();
      if(quitting||statusAsleep)return;
      if(mode==='off'){clearStatus();return;}
      scheduleStatus(showStatus(view,mode)?TRAY_FAST:TRAY_SLOW);
    }
    stopStatus=clearStatus;
    powerMonitor.on('suspend',()=>{statusAsleep=true;clearTimeout(statusTimer);statusTimer=undefined;});
    powerMonitor.on('resume',()=>{statusAsleep=false;scheduleStatus(TRAY_FIRST);});
    powerMonitor.on('suspend',()=>usage?.pause());
    for(const event of ['resume','unlock-screen'])powerMonitor.on(event,()=>usage?.resume());
    handle('agent-sessions-settings',async patch=>{
      if(!patch||typeof patch!=='object'||Array.isArray(patch))throw new Error('Invalid preferences');
      await sessions().updateSettings(patch);
      if(trayCount()==='off')clearStatus();else if(!statusTimer)scheduleStatus(0);
      return agentSessions.read({maxAgeMs:0});
    });
    handle('teaching-read',()=>teaching.read());
    handle('teaching-action',(action,input)=>teaching.action(action,input));
    handle('teaching-extension',async()=>{const folder=app.isPackaged?path.join(process.resourcesPath,'browser-teaching'):path.join(root,'integrations/browser-teaching');const error=await shell.openPath(folder);if(error)throw new Error(error);});
    for(const event of ['suspend','lock-screen'])powerMonitor.on(event,()=>{void teaching.cancel().catch(()=>{});});
    handle('command',async text=>{noteInput(text);let result=teaching.handles(text)?await teaching.command(text):await commands.execute(text);if(result?.kind==='unknown')result=await teaching.command(text)??result;await restartNative();push();return result;});
    handle('knowledge-search',async(query,options)=>{const result=await searchKnowledge(query,options);push();return result;});
    handle('remember',async value=>{await knowledge.remember({...value,source:'Saved by you in Summon'});push();return snapshot();});
    handle('forget',async id=>{await knowledge.forget(validId(id));push();return snapshot();});
    handle('save-routine',async value=>{await commands.save(value);push();return snapshot();});
    handle('remove-routine',async id=>{await knowledge.removeRoutine(validId(id));push();return snapshot();});
    handle('run-routine',async id=>{const result=await commands.runRoutine(validId(id));await restartNative();push();return result;});
    handle('interpret',async text=>{const state=service.snapshot();try{return await localModel.suggestCommand(text,{projects:state.projects,currentProjectId:state.currentProjectId});}finally{push();}});
    handle('local-model-status',async()=>{await localModel.health();push();return snapshot();});
    handle('detect-wake',audio=>wake.detect(audio));
    handle('verify-speaker',audio=>speaker.verify(audio));
    handle('begin-enrollment',()=>speaker.beginEnrollment());
    handle('enroll-speaker',audio=>speaker.enrollAudio(audio));
    handle('finish-enrollment',async()=>{const result=await speaker.finishEnrollment();push();return result;});
    handle('cancel-enrollment',()=>{speaker.cancelEnrollment();});
    handle('select-project',async id=>{await service.selectProject(id);return snapshot();});
    handle('correct-file',async(id,projectId)=>{await service.correctFile(validId(id),projectId);return snapshot();});
    handle('open-file',openFile);
    handle('reveal-file',async id=>{const file=await service.getFile(validId(id));if(!file)throw new Error('This file is no longer available.');shell.showItemInFolder(file.path);});
    handle('open-link',openLink);
    handle('settings',async patch=>{
      if(!patch||typeof patch!=='object'||Array.isArray(patch))throw new Error('Invalid preferences');
      const updated={...patch};
      if(Object.hasOwn(updated,'benchmarkApiKey')){
        if(typeof updated.benchmarkApiKey!=='string'||updated.benchmarkApiKey.length>500)throw new Error('Invalid benchmark key');
        if(!safeStorage.isEncryptionAvailable())throw new Error('macOS secure storage is not available.');
        await writeFile(path.join(dataDir,'benchmark-key.bin'),safeStorage.encryptString(updated.benchmarkApiKey.trim()),{mode:0o600});delete updated.benchmarkApiKey;keyConfigured=Boolean(await getKey());
      }
      if(updated.calendarUrl){const url=new URL(updated.calendarUrl);if(url.protocol!=='https:'||url.username||url.password)throw new Error('Use an https calendar URL.');}
      if(updated.accessibilityEnabled===true&&!service.snapshot().settings.accessibilityEnabled)systemPreferences.isTrustedAccessibilityClient(true);
      const wasPaused=service.snapshot().settings.paused;
      await service.updateSettings(updated);await restartNative();
      if(wasPaused&&!service.snapshot().settings.paused)scheduleRecovery(0);
      push();return snapshot();
    });
    handle('add-project',async()=>{const result=await dialog.showOpenDialog(window,{title:'Choose a workspace folder',properties:['openDirectory']});if(!result.canceled&&result.filePaths[0]){const folder=result.filePaths[0];await service.addProject({name:path.basename(folder),path:folder});await refreshKnowledge();}return snapshot();});
    handle('choose-model',async()=>{const result=await dialog.showOpenDialog(window,{title:'Choose a local Whisper model',filters:[{name:'Whisper model',extensions:['bin']}],properties:['openFile']});if(!result.canceled&&result.filePaths[0]){const file=result.filePaths[0];if((await stat(file)).size<1000000)throw new Error('This does not look like a Whisper model.');await voiceControl.stop();await service.updateSettings({whisperModel:file});await service.setHealth({whisper:true});}return snapshot();});
    handle('transcribe',async audio=>{if(voiceBusy)throw new Error('Still transcribing the previous phrase.');voiceBusy=true;try{return await transcriber.transcribe(audio,service.snapshot().settings.whisperModel);}finally{voiceBusy=false;}});
    handle('voice-state',value=>voiceControl.updateVoice(value));
    handle('ask',async(engine,text,options)=>{if(engineBusy)throw new Error('An answer is already running.');if(typeof text!=='string'||!text.trim()||text.length>4000)throw new Error('Enter a question under 4,000 characters.');noteInput(text);engineBusy=true;try{const knowledgeContext=await searchKnowledge(text.slice(0,500),{projectId:service.snapshot().currentProjectId,limit:5});return await taskRouter.answer(engine,text,{...snapshot(),knowledgeContext},options);}finally{engineBusy=false;}});
    const pixels=Buffer.alloc(22*22*4);for(let y=0;y<22;y++)for(let x=0;x<22;x++){const dx=Math.abs(x-10.5),dy=Math.abs(y-10.5);if((dx+dy*0.4<4.5||dy+dx*0.4<4.5)&&dx*dx+dy*dy>5&&dx+dy<11)pixels[(y*22+x)*4+3]=255;}
    const icon=nativeImage.createFromBitmap(pixels,{width:22,height:22});icon.setTemplateImage(true);
    // A non-template green star stays lit in either macOS appearance while the
    // capture owner reports an active microphone. Idle uses the system tint.
    const listeningPixels=Buffer.from(pixels);
    for(let i=0;i<listeningPixels.length;i+=4)if(listeningPixels[i+3]){listeningPixels[i]=110;listeningPixels[i+1]=184;listeningPixels[i+2]=52;}
    const listeningIcon=nativeImage.createFromBitmap(listeningPixels,{width:22,height:22});listeningIcon.setTemplateImage(false);
    trayIcons={off:icon,listening:listeningIcon};tray=new Tray(icon);tray.setToolTip('Summon · microphone off');tray.on('click',revealWindow);
    // Usage rows are read-only labels from the meter's last reading ('Claude 5h 27% · 7d 18%'); Refresh usage asks both CLIs again.
    const usageRows=()=>{const view=usage?.status();if(!view)return [];return [...['claude','codex'].map(provider=>({label:usageText(view.providers[provider],{name:provider==='claude'?'Claude':'Codex',ids:['five_hour','seven_day']}),enabled:false})),{label:'Refresh usage',click:()=>{usage.refresh().catch(()=>{});}},{type:'separator'}];};
    refreshTrayMenu=()=>{if(quitting||!tray)return;tray.setContextMenu(Menu.buildFromTemplate([{label:'Open Summon',click:revealWindow},{label:'Start hands-free listening',enabled:voiceControl.snapshot().mode==='off'&&!voiceControl.snapshot().micActive,click:()=>{if(voiceControl.snapshot().available)voiceControl.toggle();else{revealWindow();window.webContents.send('summon:voice-mode','handsfree');}}},{label:'Stop listening',enabled:voiceControl.snapshot().mode!=='off'||voiceControl.snapshot().micActive,click:()=>voiceControl.stop()},{label:'Voice command',click:()=>{revealWindow();window.webContents.send('summon:voice-toggle');}},{label:'Enroll my voice',click:()=>{revealWindow();window.webContents.send('summon:enroll-speaker');}},{type:'separator'},...usageRows(),{label:'Quit Summon',click:()=>app.quit()}]));};
    refreshTrayMenu();
    Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'Summon',submenu:[{role:'about'},{role:'hide'},{type:'separator'},{role:'quit'}]},{label:'Edit',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},{label:'Voice',submenu:[{label:'Voice command',click:()=>{revealWindow();window.webContents.send('summon:voice-toggle');}},{label:'Start hands-free listening',click:()=>{revealWindow();window.webContents.send('summon:voice-mode','handsfree');}},{type:'separator'},{label:'Enroll my voice',click:()=>{revealWindow();window.webContents.send('summon:enroll-speaker');}}]},{label:'Window',submenu:[{role:'minimize'},{role:'zoom'},{label:'Show Summon',click:revealWindow}]}]));
    if(!globalShortcut.register('CommandOrControl+Shift+Space',()=>{revealWindow();window.webContents.send('summon:voice-toggle');}))service.setHealth({errors:['The voice shortcut is in use by another app. Use Summon’s microphone button.']});
    globalShortcut.register('CommandOrControl+Shift+J',revealWindow);
    // A hook event has just changed a session's state: re-arm the menu-bar count once, a second after the first of a burst.
    // The panel's own 4 s poll picks the change up by itself, so there is no new push channel.
    let hookTimer;
    const onHook=()=>{if(hookTimer||quitting)return;hookTimer=setTimeout(()=>{hookTimer=undefined;if(!quitting&&trayCount()!=='off')scheduleStatus(0);},1000);hookTimer.unref?.();};
    const workRecords=visualWorkspace?{readWorkItems:options=>visualWorkspace.readWorkItems(options),updateWorkItem:options=>visualWorkspace.updateWorkItem(options),checkpointWorkItem:options=>visualWorkspace.checkpointWorkItem(options)}:undefined;
    try{closeRpc=await createRpcServer(service,!app.isPackaged?process.env.SUMMON_SOCKET:undefined,{knowledge,searchKnowledge,onChange:push,workInFlight,agentSessions,workRecords,workRecovery,onHook,usage,pickEngine});}catch(error){service.setHealth({errors:[`Shared context connection: ${error.message}`]});}
    if(!app.isPackaged&&process.env.SUMMON_DEV_URL==='http://127.0.0.1:5179')await window.loadURL(process.env.SUMMON_DEV_URL);else await window.loadFile(path.join(root,'dist/index.html'));
    window.show();
    refreshKnowledge().then(push).catch(error=>console.error('Memory sources:',error.message));
    wake.start().then(push).catch(error=>{console.error('Wake detector:',error.message);push();});
    speaker.start().then(push).catch(error=>{console.error('Speaker verification:',error.message);push();});
    // A plain Fn tap toggles the voice command like ⌘⇧Space.
    const fnKeyBin=app.isPackaged?path.join(process.resourcesPath,'summon-fn-key'):path.join(root,'native/summon-fn-key');
    fnKey=createFnKeyMonitor({executable:fnKeyBin,onTap:()=>{if(quitting)return;revealWindow();window.webContents.send('summon:voice-toggle');},onStatus:status=>{
      // A missing grant is shown in Preferences → Voice with a settings link; only a helper failure is a health error.
      if(status==='ready')service.setHealth({resolved:[FN_KEY_ERROR_MESSAGE]});
      else if(status==='error')service.setHealth({errors:[FN_KEY_ERROR_MESSAGE]});
      push();
    }});
    access(fnKeyBin).then(()=>fnKey.start()).catch(()=>{});
    window.on('focus',()=>fnKey.poke());
    for(const event of ['resume','unlock-screen'])powerMonitor.on(event,()=>fnKey.poke());
    Promise.resolve(localModel.health()).then(push).catch(()=>{});
    service.start().catch(error=>service.setHealth({errors:[error.message]}));
    restartNative().catch(error=>service.setHealth({errors:[`Activity monitor: ${error.message}`]}));
    scheduleStatus(TRAY_FIRST);
    usage?.start();
    scheduleReasoning(5000);
    scheduleRecovery(5000);
  }).catch(error=>{console.error(error);dialog.showErrorBox('Summon could not start',error.message);app.quit();});
  app.on('before-quit',event=>{
    if(shutdownComplete)return;event.preventDefault();if(quitting)return;
    quitting=true;nativeGeneration++;native?.kill();globalShortcut.unregisterAll();stopStatus?.();usage?.stop();clearTimeout(reasoningTimer);clearTimeout(recoveryTimer);
    const processes=stopProcesses();
    const recoveryClose=Promise.resolve().then(()=>workRecovery?workRecovery.close():recoverySources?.close?.());
    pendingRequests.add(recoveryClose);
    if(workInFlight)pendingRequests.add(recoveryClose.catch(()=>{}).then(()=>workInFlight.close()));
    if(agentSessions)pendingRequests.add(Promise.resolve().then(()=>agentSessions.close()));
    if(visualWorkspace)pendingRequests.add(Promise.resolve().then(()=>visualWorkspace.close()));
    if(contextReasoning)pendingRequests.add(Promise.resolve().then(()=>contextReasoning.close()));
    if(teaching)pendingRequests.add(Promise.resolve().then(()=>teaching.close()));
    if(usage)pendingRequests.add(Promise.resolve().then(()=>usage.close()));
    if(taskRouter)pendingRequests.add(Promise.resolve().then(()=>taskRouter.close()));
    // Request promises include engine/transcription finally blocks, which remove
    // temporary audio and prompt directories after their child process stops.
    fnKey?.stop();
    const cleanup=Promise.allSettled([processes,voiceControl?.close(),transcriber?.close(),wake?.stop(),speaker?.stop(),localModel?.close(),...pendingRequests,service?.stop(),closeRpc?.()]);
    let deadline;
    const bounded=new Promise(resolve=>{deadline=setTimeout(resolve,8000);});
    Promise.race([cleanup,bounded]).then(()=>{clearTimeout(deadline);shutdownComplete=true;app.quit();});
  });
  app.on('window-all-closed',()=>{});
}
