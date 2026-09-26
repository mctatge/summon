import {createRequire} from 'node:module';
import {mkdtemp,mkdir,symlink,rm} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const require=createRequire(import.meta.url);
const {_electron}=require(process.env.SUMMON_PLAYWRIGHT||'playwright');
if(!process.env.SUMMON_WAKE_ROOT)throw new Error('Provide the installed wake runtime through SUMMON_WAKE_ROOT.');
const dir=await mkdtemp('/private/tmp/summon-menu-voice-test-');
const data=path.join(dir,'data'),home=path.join(dir,'home');
await mkdir(data);for(const folder of ['Downloads','Desktop'])await mkdir(path.join(home,folder),{recursive:true});
await symlink(process.env.SUMMON_WAKE_ROOT,path.join(data,'wake'));
const electron=await _electron.launch({executablePath:require('electron'),args:['.','--autoplay-policy=no-user-gesture-required'],env:{...process.env,SUMMON_DATA_DIR:data,SUMMON_TEST_HOME:home,SUMMON_SOCKET:path.join(dir,'test.sock')},timeout:60000});
try{
  const main=await electron.firstWindow();
  await main.waitForFunction(()=>Boolean(window.summon));
  // Observe real native menu/image updates in this isolated test process. No
  // production testing bridge or second renderer is needed for tray controls.
  await electron.evaluate(({Tray})=>{
    const probe=globalThis.voiceSmoke={menus:new Map(),images:new Map(),tips:new Map()};
    const originalMenu=Tray.prototype.setContextMenu,originalImage=Tray.prototype.setImage,originalTip=Tray.prototype.setToolTip;
    Tray.prototype.setContextMenu=function(menu){probe.menus.set(this,menu);return originalMenu.call(this,menu);};
    Tray.prototype.setImage=function(image){
      const pixels=image.toBitmap();let greenPixels=0;
      for(let offset=0;offset<pixels.length;offset+=4)if(pixels[offset+3]>0&&pixels[offset+1]>pixels[offset]+20&&pixels[offset+1]>pixels[offset+2]+20)greenPixels++;
      probe.images.set(this,{template:image.isTemplateImage(),greenPixels,png:image.toPNG().toString('base64')});
      return originalImage.call(this,image);
    };
    Tray.prototype.setToolTip=function(tip){probe.tips.set(this,tip);return originalTip.call(this,tip);};
  });
  // Silent synthetic input exercises the actual capture owner without opening
  // any physical microphone or transcribing the user's room.
  await main.evaluate(()=>{
    window.testStreams=[];window.testContexts=[];
    window.testVoice={state:'off',mode:'off',micActive:false};
    window.addEventListener('summon:voice-status',event=>{window.testVoice=event.detail;});
    navigator.mediaDevices.getUserMedia=async()=>{
      const context=new AudioContext(),destination=context.createMediaStreamDestination();
      await context.resume();window.testContexts.push(context);window.testStreams.push(destination.stream);return destination.stream;
    };
  });
  let ready=false;
  for(let i=0;i<600;i++){
    const state=await main.evaluate(()=>window.summon.snapshot());
    if(state.health.whisper&&state.wake?.available&&state.wake?.loaded){ready=true;break;}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(ready,true,'Local speech and wake detection must become ready.');
  // Republish the launch state after installing the observers above.
  await main.evaluate(()=>window.summon.voiceState(window.testVoice));
  const traySnapshot=()=>electron.evaluate(()=>{
    const probe=globalThis.voiceSmoke;
    const entry=[...probe.menus].find(([,menu])=>menu.items.some(item=>item.label==='Start hands-free listening'));
    if(!entry)return null;
    const [tray,menu]=entry;
    return {items:menu.items.map(({label,enabled})=>({label,enabled})),image:probe.images.get(tray),tip:probe.tips.get(tray)};
  });
  const clickTray=label=>electron.evaluate((_electron,label)=>{
    const menu=[...globalThis.voiceSmoke.menus.values()].find(menu=>menu.items.some(item=>item.label==='Start hands-free listening'));
    const item=menu?.items.find(item=>item.label===label);
    if(!item?.enabled)throw new Error('Menu control is unavailable: '+label);
    item.click();
  },label);
  const waitVoice=async predicate=>{
    let state;
    for(let i=0;i<300;i++){
      state=await main.evaluate(()=>window.testVoice);
      if(predicate(state))return state;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw new Error('Voice state did not settle: '+JSON.stringify(state));
  };
  const assertReleased=async()=>assert.equal(await main.evaluate(()=>window.testStreams.every(stream=>stream.getTracks().every(track=>track.readyState==='ended'))),true,'All synthetic capture tracks must end.');
  const assertSingleWindow=async()=>assert.equal(await electron.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length),1,'Only the workbench window exists; there is no floating widget.');
  const assertOff=async()=>{
    await waitVoice(state=>!state.micActive&&state.state==='off'&&state.mode==='off');
    await assertReleased();
    const current=await traySnapshot();
    assert.equal(current.image.template,true,'The idle star uses the system template color.');
    assert.equal(current.image.greenPixels,0);
    assert.equal(current.tip,'Summon · microphone off');
    assert.equal(current.items.find(item=>item.label==='Start hands-free listening').enabled,true);
    assert.equal(current.items.find(item=>item.label==='Stop listening').enabled,false);
  };
  await assertSingleWindow();
  await assertOff();
  const idleImage=(await traySnapshot()).image.png;
  const mainWindow=await electron.browserWindow(main);await mainWindow.evaluate(window=>window.hide());
  const start=async()=>{
    await clickTray('Start hands-free listening');
    await waitVoice(state=>state.micActive&&state.state==='listening'&&state.mode==='handsfree');
    assert.equal(await mainWindow.evaluate(window=>window.isVisible()),false,'Menu-bar listening does not reveal the workbench.');
    const current=await traySnapshot();
    assert.equal(current.image.template,false,'The listening star preserves its green color.');
    assert.ok(current.image.greenPixels>0,'The listening star contains visible green pixels.');
    assert.notEqual(current.image.png,idleImage);
    assert.equal(current.tip,'Summon · microphone listening locally');
    assert.equal(current.items.find(item=>item.label==='Start hands-free listening').enabled,false);
    assert.equal(current.items.find(item=>item.label==='Stop listening').enabled,true);
    await assertSingleWindow();
  };
  await start();
  await clickTray('Stop listening');
  await assertOff();
  for(const event of ['lock-screen','suspend']){
    await start();
    await electron.evaluate(({powerMonitor},event)=>powerMonitor.emit(event),event);
    await assertOff();
  }
  assert.equal(await main.evaluate(()=>window.testStreams.length),3,'Each menu start acquired synthetic audio.');
  await clickTray('Open Summon');
  assert.equal(await mainWindow.evaluate(window=>window.isVisible()),true);
  await assertSingleWindow();
  await main.evaluate(async()=>{for(const context of window.testContexts)await context.close();});
  console.log('Desktop voice smoke passed: one workbench and no widget, microphone off on launch, menu-bar start/stop, hidden-workbench capture, green/idle star transitions, and stop/lock/suspend release synthetic tracks.');
}finally{await electron.close();await rm(dir,{recursive:true,force:true});}
