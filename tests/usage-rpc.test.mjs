import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRpcServer} from '../src/main/rpc.mjs';
import {createUsage,usageText} from '../src/core/usage.mjs';
import {chooseEngine} from '../src/main/engine-choice.mjs';

const T0=Date.UTC(2026,8,19,21,0,0);
const report=(provider,five,seven)=>({provider,plan:provider==='claude'?'max':'plus',status:'ok',windows:[...(five===null?[]:[{id:'five_hour',label:'5h',usedPercent:five,resetsAt:new Date(T0+3600_000).toISOString()}]),{id:'seven_day',label:'7d',usedPercent:seven,resetsAt:new Date(T0+86400_000).toISOString()}],fetchedAt:new Date(T0).toISOString()});
const ask=(socketPath,request)=>new Promise((resolve,reject)=>{const socket=net.connect(socketPath);let body='';socket.setEncoding('utf8');socket.on('connect',()=>socket.write(JSON.stringify(request)+'\n'));socket.on('data',chunk=>{body+=chunk;});socket.on('error',reject);socket.on('end',()=>{try{resolve(JSON.parse(body));}catch(error){reject(error);}});});
const service={snapshot:()=>({projects:[],events:[],files:[],settings:{},health:{}})};
async function mcp(socketPath,requests){
  const child=spawn(process.execPath,['scripts/mcp-server.mjs'],{env:{...process.env,SUMMON_SOCKET:socketPath},stdio:['pipe','pipe','pipe']});
  let data='';
  const done=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill();reject(new Error('MCP test timeout'));},20000);
    child.stdout.on('data',chunk=>{data+=chunk;const lines=data.trim().split('\n');if(lines.length===requests.length){clearTimeout(timer);child.kill();resolve(new Map(lines.map(line=>JSON.parse(line)).map(message=>[message.id,message])));}});
  });
  for(const request of requests)child.stdin.write(JSON.stringify(request)+'\n');
  return done;
}
const text=message=>JSON.parse(message.result.content[0].text);
// Objects born inside the vm context have another prototype; compare them by value.
const plain=value=>JSON.parse(JSON.stringify(value));

test('the socket serves the meter and the engine choice, read-only, with every option checked',async()=>{
  const dir=await mkdtemp('/private/tmp/summon-usage-rpc-'),socketPath=path.join(dir,'s.sock'),bareSocket=path.join(dir,'bare.sock');
  const calls={claude:0,codex:0};
  const usage=await createUsage({dataDir:dir,now:()=>T0,readers:{claude:async()=>{calls.claude++;return report('claude',27,18);},codex:async()=>{calls.codex++;return report('codex',null,1);}}});
  const pickEngine=task=>chooseEngine({task,usage:usage.status(),settings:usage.settings()});
  const close=await createRpcServer(service,socketPath,{usage,pickEngine});
  const bare=await createRpcServer(service,bareSocket,{});
  try{
    const empty=await ask(socketPath,{method:'usage'});
    assert.deepEqual(empty.result.providers,{claude:null,codex:null});assert.deepEqual(calls,{claude:0,codex:0},'a plain read never runs a CLI');
    const fresh=await ask(socketPath,{method:'usage',refresh:true});
    assert.equal(fresh.result.providers.claude.plan,'max');assert.equal(fresh.result.providers.codex.windows[0].id,'seven_day');assert.deepEqual(calls,{claude:1,codex:1});
    const one=await ask(socketPath,{method:'usage',refresh:true,provider:'codex'});
    assert.deepEqual(calls,{claude:1,codex:2});assert.equal(one.result.providers.codex.status,'ok');
    for(const bad of [{method:'usage',refresh:'yes'},{method:'usage',provider:'gemini'}])assert.match((await ask(socketPath,bad)).error,/Invalid/);
    const pick=await ask(socketPath,{method:'pick-engine',task:'group these changes'});
    assert.deepEqual(Object.keys(pick.result),['engine','reason','usage']);
    assert.equal(pick.result.engine,'codex');assert.match(pick.result.reason,/7-day window/);assert.equal(pick.result.usage.providers.claude.status,'ok');
    assert.equal((await ask(socketPath,{method:'pick-engine',task:'x',engine:'claude'})).result.reason,'pinned');
    assert.equal((await ask(socketPath,{method:'pick-engine'})).result.engine,'codex','task is optional over the socket');
    for(const bad of [{method:'pick-engine',task:42},{method:'pick-engine',task:'x'.repeat(501)},{method:'pick-engine',engine:'gemini'}])assert.match((await ask(socketPath,bad)).error,/Invalid/);
    assert.match((await ask(bareSocket,{method:'usage'})).error,/not available/);
    assert.match((await ask(bareSocket,{method:'pick-engine',task:'x'})).error,/not available/);
    assert.deepEqual(calls,{claude:1,codex:2},'pick-engine reads the last reading and runs nothing');

    // The MCP adapter: two read-only tools over the same two methods.
    const replies=await mcp(socketPath,[
      {jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05'}},
      {jsonrpc:'2.0',id:2,method:'tools/list'},
      {jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'usage',arguments:{}}},
      {jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'usage',arguments:{refresh:true,provider:'claude'}}},
      {jsonrpc:'2.0',id:5,method:'tools/call',params:{name:'pick_engine',arguments:{task:'summarize a diff'}}},
      {jsonrpc:'2.0',id:6,method:'tools/call',params:{name:'pick_engine',arguments:{}}},
      {jsonrpc:'2.0',id:7,method:'tools/call',params:{name:'usage',arguments:{refresh:'x'}}},
      {jsonrpc:'2.0',id:8,method:'tools/call',params:{name:'pick_engine',arguments:{task:'x',engine:'gemini'}}},
      {jsonrpc:'2.0',id:9,method:'tools/call',params:{name:'usage',arguments:{later:true}}},
    ]);
    assert.match(replies.get(1).result.instructions,/subscription windows/);
    const tools=replies.get(2).result.tools;
    assert.equal(tools.some(tool=>/run_routine|execute|shell/.test(tool.name)),false);
    const usageTool=tools.find(tool=>tool.name==='usage'),pickTool=tools.find(tool=>tool.name==='pick_engine');
    assert.deepEqual(usageTool.annotations,{readOnlyHint:true});assert.deepEqual(pickTool.annotations,{readOnlyHint:true});
    assert.deepEqual(usageTool.inputSchema.properties.provider.enum,['claude','codex']);assert.equal(usageTool.inputSchema.additionalProperties,false);
    assert.deepEqual(pickTool.inputSchema.required,['task']);assert.deepEqual(pickTool.inputSchema.properties.engine.enum,['claude','codex','auto']);assert.equal(pickTool.inputSchema.properties.task.maxLength,500);
    assert.match(usageTool.description,/never as 0 %/);assert.match(pickTool.description,/starts nothing/);
    assert.equal(text(replies.get(3)).providers.codex.plan,'plus');
    assert.equal(text(replies.get(4)).providers.claude.status,'ok');assert.deepEqual(calls,{claude:2,codex:2},'refresh with a provider asks that CLI only');
    const picked=text(replies.get(5));
    assert.deepEqual(Object.keys(picked),['engine','reason','usage']);assert.equal(picked.engine,'codex');
    for(const [id,pattern] of [[6,/task must be/],[7,/Invalid refresh/],[8,/Invalid engine/],[9,/Invalid option later/]]){assert.equal(replies.get(id).result.isError,true);assert.match(replies.get(id).result.content[0].text,pattern);}
    const older=await mcp(bareSocket,[{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'usage',arguments:{}}},{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'pick_engine',arguments:{task:'x'}}}]);
    for(const id of [1,2]){assert.equal(older.get(id).result.isError,true);assert.match(older.get(id).result.content[0].text,/not available in this Summon version/);}
  }finally{await close();await bare();await rm(dir,{recursive:true,force:true});}
});

// The meter in the real lifecycle, the way tests/sessions-tray.test.mjs runs main.mjs: injected adapters, no Electron, no CLI.
async function launch(){
  let showWindow;const shown=new Promise(resolve=>{showWindow=resolve;});
  const noop=()=>{};
  const missing=async()=>{throw new Error('Synthetic fixture has no optional files.');};
  const executable=async name=>`/synthetic/bin/${name}`,spawnLongLived=()=>assert.fail('No CLI is spawned in this lifecycle.');
  const ctx={handlers:new Map(),trays:[],power:new Map(),asks:[],choices:[],readerOptions:{},usageOptions:null,rpcOptions:null,core:null,window:null,health:[],executable,spawnLongLived};
  ctx.core={calls:[],stored:{usageCeiling:85,defaultEngine:'claude'},providers:{claude:null,codex:null},started:0,paused:0,resumed:0,stopped:0,closed:0,
    status(){return {version:1,settings:{...this.stored},providers:this.providers,refreshing:[],problem:null};},
    settings(){return {...this.stored};},
    async refresh(provider){this.calls.push(['refresh',provider]);return this.status();},
    async updateSettings(patch){this.calls.push(['settings',patch]);Object.assign(this.stored,patch);return this.settings();},
    start(){this.started++;},pause(){this.paused++;},resume(){this.resumed++;},stop(){this.stopped++;},async close(){this.closed++;}};
  class Window extends EventEmitter{
    constructor(options){super();this.options=options;this.webContents=new EventEmitter();Object.assign(this.webContents,{mainFrame:{},send:noop,setWindowOpenHandler:noop});ctx.window=this;}
    isDestroyed(){return false;}isVisible(){return true;}isMinimized(){return false;}
    loadFile(){return Promise.resolve();}show(){showWindow();}focus(){}
  }
  class Tray extends EventEmitter{constructor(image){super();this.image=image;this.menus=[];ctx.trays.push(this);}setTitle(){}setToolTip(){}setContextMenu(menu){this.menus.push(menu);}popUpContextMenu(){}destroy(){}}
  const app=new EventEmitter();
  Object.assign(app,{isPackaged:true,setName:noop,requestSingleInstanceLock:()=>true,getPath:()=>'/private/tmp/synthetic-summon-data',whenReady:()=>Promise.resolve(),quit:()=>app.emit('before-quit',{preventDefault:noop})});
  const state={settings:{paused:true,activityEnabled:true,whisperModel:'/private/tmp/synthetic-model.bin'},health:{whisper:false},projects:[],files:[],events:[]};
  const service={snapshot:()=>state,setHealth:value=>ctx.health.push(value),start:async()=>{},stop:async()=>{}};
  const sourceURL=new URL('../src/main/main.mjs',import.meta.url);
  const source=(await readFile(sourceURL,'utf8')).replace(/^import .*;\n/gm,'').replaceAll('import.meta.url',JSON.stringify(sourceURL.href));
  vm.runInNewContext(source,{
    app,BrowserWindow:Window,Tray,Menu:{buildFromTemplate:template=>template,setApplicationMenu:noop},screen:{},
    powerMonitor:{on:(event,handler)=>{const list=ctx.power.get(event)?.handlers||[];list.push(handler);ctx.power.set(event,Object.assign(()=>{for(const fn of list)fn();},{handlers:list}));}},
    nativeImage:{createFromBitmap:()=>({setTemplateImage:noop,star:true}),createEmpty:()=>({star:false})},
    ipcMain:{handle:(name,handler)=>ctx.handlers.set(name,handler)},shell:{},dialog:{showErrorBox:(_title,message)=>assert.fail(message)},
    globalShortcut:{register:()=>true,unregisterAll:noop},session:{defaultSession:{setPermissionRequestHandler:noop,setPermissionCheckHandler:noop}},systemPreferences:{},safeStorage:{},clipboard:{},
    spawn:()=>assert.fail('Paused observation must remain paused.'),
    readFile:missing,writeFile:noop,mkdir:noop,stat:missing,access:missing,chmod:noop,lstat:missing,
    createWorkInFlight:async()=>({read:async()=>({}),group:()=>({}),settings:()=>({}),updateSettings:async()=>({}),places:()=>[],placePath:()=>'/tmp',close:async()=>{}}),runGrouping:async()=>({raw:{},model:null}),GIT_ENV:{},
    createAgentSessions:async()=>({read:async()=>({}),openTarget:async()=>assert.fail('No session is opened.'),settings:()=>({}),updateSettings:async()=>({}),close:async()=>{}}),sessionSummaryText:()=>'',
    createDesktopVoice:()=>({publish:noop,updateVoice:noop,start:async()=>{},show:noop,stop:async()=>{},close:async()=>{}}),
    createTranscriber:()=>({status:()=>({ready:false}),warm:async()=>{},transcribe:async()=>({text:''}),release:noop,close:async()=>{}}),
    homedir:()=>'/private/tmp/synthetic-home',path,fileURLToPath,
    createCompanion:async()=>service,classifyCommand:noop,createCommandSession:()=>({}),createKnowledge:async()=>({snapshot:()=>({}),refreshSources:async()=>{},search:async()=>[]}),
    createLocalInterpreter:()=>({status:()=>({}),health:async()=>{},close:async()=>{}}),createWakeDetector:()=>({status:()=>({}),start:async()=>{},stop:async()=>{}}),
    createSpeaker:()=>({status:()=>({}),start:async()=>{},stop:async()=>{},verify:async()=>({verified:true,score:1,elapsedMs:0}),beginEnrollment:async()=>({minSamples:10}),enrollAudio:async()=>({count:1,elapsedMs:0}),finishEnrollment:async()=>({saved:true,samples:0}),cancelEnrollment(){}}),
    createFnKeyMonitor:()=>({status:()=>'off',start(){},poke(){},stop(){}}),FN_KEY_ERROR_MESSAGE:'fn-error',createBenchmark:()=>noop,
    askEngine:async(engine,textValue,snapshot)=>{ctx.asks.push([engine,textValue,Boolean(snapshot.knowledgeContext)]);return {text:`answer from ${engine}`};},
    createRpcServer:async(_service,_socket,options)=>{ctx.rpcOptions=options;return async()=>{};},
    run:missing,scrubbedEnv:()=>({}),executable,stopProcesses:async()=>{},spawnLongLived,
    createUsage:async options=>{ctx.usageOptions=options;return ctx.core;},usageText,
    readClaudeUsage:async options=>{ctx.readerOptions.claude=options;return 'claude-read';},readCodexUsage:async options=>{ctx.readerOptions.codex=options;return 'codex-read';},
    chooseEngine:options=>{ctx.choices.push(options);return {engine:'codex',reason:'synthetic choice'};},
    loadSealedSegments:()=>[],
    createLauncher:()=>({launch:()=>assert.fail('Nothing launches.'),installClaudeHooks:()=>assert.fail('Nothing installs hooks.'),hookStatus:async()=>({claude:{installed:false,current:false}})}),
    setTimeout,clearTimeout,URL,Buffer,console,
    process:{env:{},resourcesPath:'/private/tmp/synthetic-resources',umask:noop},
  },{filename:fileURLToPath(sourceURL)});
  await shown;
  for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));
  ctx.app=app;
  ctx.call=(name,...args)=>ctx.handlers.get(`summon:${name}`)({sender:ctx.window.webContents,senderFrame:ctx.window.webContents.mainFrame},...args);
  return ctx;
}

test('main wires the meter into startup, power events, IPC, Ask Auto, the tray menu, the socket and shutdown',async()=>{
  const ctx=await launch();
  assert.deepEqual(ctx.health.filter(value=>value.errors),[],'no startup problems');
  assert.equal(ctx.usageOptions.dataDir,'/private/tmp/synthetic-summon-data');
  assert.equal(await ctx.usageOptions.readers.claude(),'claude-read');assert.equal(await ctx.usageOptions.readers.codex(),'codex-read');
  for(const provider of ['claude','codex']){assert.equal(ctx.readerOptions[provider].executable,ctx.executable,`${provider} reads through the shared executable lookup`);assert.equal(ctx.readerOptions[provider].spawnChild,ctx.spawnLongLived,`${provider} spawns through the long-lived spawner`);assert.deepEqual(Object.keys(ctx.readerOptions[provider]),['executable','spawnChild']);}
  assert.equal(ctx.core.started,1,'the five-minute loop starts once the app is up');
  assert.deepEqual(ctx.core.calls,[],'nothing is refreshed at startup; the loop does that after its first delay');
  ctx.power.get('suspend')();assert.equal(ctx.core.paused,1);
  ctx.power.get('resume')();ctx.power.get('unlock-screen')();assert.equal(ctx.core.resumed,2);

  assert.equal((await ctx.call('snapshot')).usage.settings.usageCeiling,85,'the snapshot carries the meter');
  assert.deepEqual((await ctx.call('usage')).providers,{claude:null,codex:null});
  await ctx.call('usage',{refresh:true});await ctx.call('usage',{refresh:true,provider:'codex'});
  assert.deepEqual(ctx.core.calls,[['refresh',undefined],['refresh','codex']]);
  await assert.rejects(ctx.call('usage',{provider:'gemini'}),/Invalid provider/);
  await assert.rejects(ctx.call('usage',{refresh:'yes'}),/Invalid request/);
  assert.deepEqual((await ctx.call('usage-settings',{usageCeiling:70})).settings,{usageCeiling:70,defaultEngine:'claude'});
  await assert.rejects(ctx.call('usage-settings',null),/Invalid preferences/);

  // Ask Auto: the choice is asked with the meter's reading and settings, and the chosen engine answers.
  const auto=await ctx.call('ask','auto','What changed?');
  assert.deepEqual(plain(auto),{text:'answer from codex',engine:'codex',reason:'synthetic choice'});
  assert.deepEqual(plain(ctx.choices),[{task:{engine:'auto'},usage:ctx.core.status(),settings:{usageCeiling:70,defaultEngine:'claude'}}]);
  const pinned=await ctx.call('ask','claude','What changed?');
  assert.deepEqual(plain(pinned),{text:'answer from claude',engine:'claude',reason:'pinned'});
  assert.deepEqual(ctx.asks.map(([engine])=>engine),['codex','claude']);assert.equal(ctx.choices.length,1,'a named engine never consults the choice');

  // The socket gets the same meter and the same rule.
  assert.equal(ctx.rpcOptions.usage,ctx.core);
  assert.deepEqual(plain(ctx.rpcOptions.pickEngine({engine:'auto'})),{engine:'codex',reason:'synthetic choice'});
  assert.equal(ctx.choices.length,2);

  // The standard tray menu carries two read-only rows and Refresh usage, rebuilt when the meter changes.
  const tray=ctx.trays.find(item=>item.image?.star===true);
  const labels=menu=>plain(menu.map(item=>item.label??item.type));
  assert.deepEqual(labels(tray.menus.at(-1)),['Open Summon','Show desktop voice button','Stop listening','Voice command','Enroll my voice','separator','Claude · no usage yet','Codex · no usage yet','Refresh usage','separator','Quit Summon']);
  assert.ok(tray.menus.at(-1).filter(item=>/no usage yet/.test(item.label)).every(item=>item.enabled===false),'usage rows are labels, not actions');
  ctx.core.providers={claude:{provider:'claude',plan:'max',status:'ok',windows:[{id:'five_hour',label:'5h',usedPercent:27.3},{id:'seven_day',label:'7d',usedPercent:18},{id:'seven_day_opus',label:'7d Opus',usedPercent:3}],fetchedAt:new Date(T0).toISOString()},codex:{provider:'codex',status:'not_signed_in',windows:[],fetchedAt:new Date(T0).toISOString()}};
  const menusBefore=tray.menus.length;
  ctx.usageOptions.onChange();
  assert.equal(tray.menus.length,menusBefore+1);
  assert.deepEqual(labels(tray.menus.at(-1)).slice(6,9),['Claude 5h 27% · 7d 18%','Codex · not signed in','Refresh usage'],'the tray keeps to the two headline windows');
  const before=ctx.core.calls.length;
  tray.menus.at(-1).find(item=>item.label==='Refresh usage').click();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(ctx.core.calls.slice(before),[['refresh',undefined]]);

  ctx.app.quit();
  for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(ctx.core.stopped,1,'quitting stops the loop');assert.equal(ctx.core.closed,1,'and waits for a read in flight');
});
