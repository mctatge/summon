import {createRequire} from 'node:module';
import {mkdtemp,mkdir,symlink,rm} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {_electron}=require(process.env.SUMMON_PLAYWRIGHT||'playwright');
if(!process.env.SUMMON_WAKE_ROOT)throw new Error('Provide the installed wake runtime through SUMMON_WAKE_ROOT.');
const dir=await mkdtemp('/private/tmp/summon-widget-test-');
const data=path.join(dir,'data'),home=path.join(dir,'home');
await mkdir(data);for(const folder of ['Downloads','Desktop'])await mkdir(path.join(home,folder),{recursive:true});
await symlink(process.env.SUMMON_WAKE_ROOT,path.join(data,'wake'));
const electron=await _electron.launch({executablePath:require('electron'),args:['.','--autoplay-policy=no-user-gesture-required'],env:{...process.env,SUMMON_DATA_DIR:data,SUMMON_TEST_HOME:home,SUMMON_SOCKET:path.join(dir,'test.sock')},timeout:60000});
try{
  const main=await electron.firstWindow();
  await main.waitForFunction(()=>Boolean(window.summon));
  // Silent synthetic input exercises the actual capture owner without opening
  // any physical microphone or transcribing the user's room.
  await main.evaluate(()=>{
    window.testStreams=[];window.testContexts=[];
    navigator.mediaDevices.getUserMedia=async()=>{
      const context=new AudioContext(),destination=context.createMediaStreamDestination();
      await context.resume();window.testContexts.push(context);window.testStreams.push(destination.stream);return destination.stream;
    };
  });
  let widget=electron.windows().find(page=>page.url().includes('voice-widget'));
  if(!widget)widget=await electron.waitForEvent('window',{predicate:page=>page!==main});
  await widget.waitForFunction(()=>Boolean(window.summonWidget));
  const waitVoice=async predicate=>{let state;for(let i=0;i<300;i++){state=await widget.evaluate(()=>window.summonWidget.snapshot());if(predicate(state))return state;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('Voice state did not settle: '+JSON.stringify(state));};
  await waitVoice(state=>state.available);
  assert.equal(await widget.evaluate(()=>typeof window.summon),'undefined');
  assert.equal((await widget.evaluate(()=>window.summonWidget.snapshot())).micActive,false);
  await widget.screenshot({path:'/private/tmp/summon-voice-button-off.png'});
  const mainWindow=await electron.browserWindow(main);await mainWindow.evaluate(window=>window.hide());
  await widget.getByRole('button',{name:'Start listening',exact:true}).click();
  await waitVoice(state=>state.micActive&&state.state==='listening');
  const active=await widget.evaluate(()=>window.summonWidget.snapshot());assert.equal(active.mode,'handsfree');
  assert.equal(await mainWindow.evaluate(window=>window.isVisible()),false,'Starting from widget does not reveal the workbench.');
  await widget.screenshot({path:'/private/tmp/summon-voice-button-on.png'});
  await widget.getByRole('button',{name:'Stop listening',exact:true}).click();
  await waitVoice(state=>!state.micActive&&state.state==='off');
  assert.equal(await main.evaluate(()=>window.testStreams.every(stream=>stream.getTracks().every(track=>track.readyState==='ended'))),true);
  await widget.evaluate(()=>window.summonWidget.toggleListening());
  await waitVoice(state=>state.micActive&&state.state==='listening');
  await electron.evaluate(({powerMonitor})=>powerMonitor.emit('lock-screen'));
  await waitVoice(state=>!state.micActive&&state.state==='off');
  assert.equal((await widget.evaluate(()=>window.summonWidget.snapshot())).mode,'off');
  await widget.evaluate(()=>window.summonWidget.toggleListening());
  await waitVoice(state=>state.micActive&&state.state==='listening');
  await widget.evaluate(()=>window.summonWidget.hide());
  await waitVoice(state=>!state.micActive&&state.state==='off');
  assert.equal(await main.evaluate(()=>window.testStreams.every(stream=>stream.getTracks().every(track=>track.readyState==='ended'))),true);
  await main.evaluate(()=>window.summon.showVoiceWidget());
  const widgetWindow=await electron.browserWindow(widget);assert.equal(await widgetWindow.evaluate(window=>window.isVisible()),true);
  await widget.evaluate(()=>window.summonWidget.openSummon());
  assert.equal(await mainWindow.evaluate(window=>window.isVisible()),true);
  const bounds=await widgetWindow.evaluate(window=>window.getBounds());assert.equal(bounds.width,320);assert.equal(bounds.height,84);
  await main.evaluate(async()=>{for(const context of window.testContexts)await context.close();});
  console.log('Desktop voice smoke passed: isolated bridge, off on launch, hidden-workbench capture, stop/lock/hide release synthetic tracks, show and open controls.');
}finally{await electron.close();await rm(dir,{recursive:true,force:true});}
