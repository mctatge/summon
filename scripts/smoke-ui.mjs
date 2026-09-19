import {createRequire} from 'node:module';
import {mkdir,writeFile,mkdtemp,rm,readFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {_electron}=require(process.env.SUMMON_PLAYWRIGHT||'playwright');
const dir=await mkdtemp('/private/tmp/summon-ui-'),home=path.join(dir,'home'),data=path.join(dir,'data');
for(const folder of ['Downloads','Desktop','Harbor','summon'])await mkdir(path.join(home,folder),{recursive:true});
await mkdir(data,{recursive:true});
await writeFile(path.join(home,'Downloads','Course model.xlsx'),'Synthetic integration fixture');
await writeFile(path.join(home,'Downloads','Harbor notes.pdf'),'Synthetic integration fixture');
await writeFile(path.join(data,'bootstrap.json'),JSON.stringify({projects:[{name:'Harbor',path:path.join(home,'Harbor')},{name:'Summon',path:path.join(home,'summon')}]}));
const electron=await _electron.launch({executablePath:require('electron'),args:['.'],env:{...process.env,SUMMON_DATA_DIR:data,SUMMON_TEST_HOME:home,SUMMON_SOCKET:path.join(dir,'test.sock')},timeout:60000});
try{
  const page=await electron.firstWindow();const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.waitForFunction(()=>Boolean(window.summon),{timeout:30000});
  await page.getByText('Course model.xlsx',{exact:true}).first().waitFor({timeout:30000});
  await page.getByRole('button',{name:'Observing locally',exact:false}).waitFor({timeout:30000});
  const initial=await page.evaluate(()=>window.summon.snapshot());assert.equal(initial.files.length,2,JSON.stringify({files:initial.files.map(f=>f.name),health:initial.health}));assert.equal(initial.projects.length,2);
  const result=await page.evaluate(()=>window.summon.command('find my Excel file'));assert.equal(result.kind,'files');assert.equal(result.fileIds.length,1);
  const selected=await page.evaluate(async()=>{const s=await window.summon.snapshot();return window.summon.selectProject(s.projects.find(p=>p.name==='Harbor').id);});assert.equal(selected.currentProjectId,selected.projects.find(p=>p.name==='Harbor').id);
  const commandBox=page.getByPlaceholder('Where did my Excel file go?');await commandBox.fill('find my Excel file');await commandBox.press('Enter');
  await page.getByText('Found 1 matching file.',{exact:false}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Open file',exact:true}).isEnabled(),true);
  await page.screenshot({path:'/private/tmp/summon-desktop.png',fullPage:true});
  await page.getByRole('button',{name:'Save as routine',exact:true}).click();
  await page.getByRole('dialog').waitFor();
  await page.getByLabel('Routine name',{exact:true}).fill('Morning desk');
  await page.getByLabel('The phrase you’ll use',{exact:false}).fill('morning desk');
  await page.getByRole('button',{name:'Save routine',exact:true}).click();
  await page.getByText('Routine saved.',{exact:false}).waitFor();
  await page.screenshot({path:'/private/tmp/summon-routines.png',fullPage:true});
  await page.keyboard.press('Escape');
  await commandBox.fill('morning desk');await commandBox.press('Enter');
  await page.getByText('Found 1 matching file.',{exact:false}).waitFor();
  assert.equal((await page.evaluate(()=>window.summon.snapshot())).knowledge.routines[0].useCount,1);
  await page.getByRole('button',{name:'Memory & routines',exact:true}).click();
  await page.getByLabel('A fact you want to keep',{exact:true}).fill('The course workbook is our reference for the learning sprint.');
  await page.getByRole('button',{name:'Remember this',exact:true}).click();
  await page.getByText('Fact saved.',{exact:false}).waitFor();
  await page.getByLabel('Search saved memory and project notes',{exact:true}).fill('course workbook');
  await page.getByRole('button',{name:'Search',exact:true}).click();
  await page.getByText('Saved fact',{exact:true}).waitFor();
  await page.screenshot({path:'/private/tmp/summon-memory.png',fullPage:true});
  const memoryState=await page.evaluate(()=>window.summon.snapshot());assert.equal(memoryState.knowledge.memories.length,1);
  await page.getByRole('button',{name:/Forget fact:/}).click();
  await page.getByText('Fact removed.',{exact:true}).waitFor();
  await page.keyboard.press('Escape');
  await commandBox.fill('Can you bring up my appointments?');await commandBox.press('Enter');
  await page.getByRole('button',{name:'Interpret locally',exact:true}).waitFor();
  if(process.env.SUMMON_LOCAL_SMOKE){
    const before=await page.evaluate(()=>window.summon.snapshot());
    await page.getByRole('button',{name:'Interpret locally',exact:true}).click();
    await page.getByRole('button',{name:'Run this command',exact:true}).waitFor({timeout:45000});
    assert.equal(await page.getByText('open my calendar',{exact:true}).count(),1);
    const after=await page.evaluate(()=>window.summon.snapshot());assert.equal(after.currentProjectId,before.currentProjectId);
    await page.screenshot({path:'/private/tmp/summon-local-proposal.png',fullPage:true});
    console.log('Real local interpreter proposal shown; no execution occurs before confirmation.');
  }
  assert.equal((await page.evaluate(()=>window.summon.snapshot())).knowledge.memories.length,0);

  await page.getByRole('button',{name:'Preferences',exact:true}).last().click();
  await page.getByRole('dialog').waitFor();await page.screenshot({path:'/private/tmp/summon-preferences.png',fullPage:true});
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').count(),0);
  const benchmark=await page.evaluate(()=>window.summon.command('best coding model'));assert.equal(benchmark.kind,'benchmark');assert.match(benchmark.message,/key/);
  if(process.env.SUMMON_VOICE_FIXTURE){
    // Isolate the UI regression from file-routing speed: provide only the
    // recognized-text phase, never a voice-result that could fill the input.
    await commandBox.fill('');
    const interimTranscript='find my Excel file';
    const interim=await page.evaluate(async text=>{
      let resultEvents=0;const onResult=()=>{resultEvents++;};
      window.addEventListener('summon:voice-result',onResult);
      const startedAt=performance.now();
      try{
        window.dispatchEvent(new CustomEvent('summon:voice-status',{detail:{state:'processing',mode:'command',micActive:false,text}}));
        const input=document.querySelector('input[aria-label="Ask Summon or find a file"]');
        while(input?.value!==text&&performance.now()-startedAt<1000)await new Promise(resolve=>setTimeout(resolve,20));
        return {text:input?.value,resultEvents,visibleAfterMs:performance.now()-startedAt};
      }finally{
        window.removeEventListener('summon:voice-result',onResult);
        window.dispatchEvent(new CustomEvent('summon:voice-status',{detail:{state:'off',mode:'off',micActive:false}}));
      }
    },interimTranscript);
    assert.equal(interim.text,interimTranscript,'Recognized words must appear during processing, without waiting for voice-result.');
    assert.equal(interim.resultEvents,0,'The interim input assertion must precede every completed voice result.');
    const audio=[...await readFile(process.env.SUMMON_VOICE_FIXTURE)];
    const voice=await page.evaluate(async bytes=>{
      const ctx=new AudioContext();const buffer=await ctx.decodeAudioData(new Uint8Array(bytes).buffer);const source=ctx.createBufferSource();source.buffer=buffer;const destination=ctx.createMediaStreamDestination();source.connect(destination);
      const previousGetUserMedia=navigator.mediaDevices.getUserMedia;
      navigator.mediaDevices.getUserMedia=async()=>{await ctx.resume();source.start(ctx.currentTime+0.3);return destination.stream;};
      try{return await new Promise((resolve,reject)=>{
        const marks={requested:performance.now(),hearing:null,transcribing:null,processing:null};
        const cleanup=()=>{clearTimeout(timer);window.removeEventListener('summon:voice-status',onStatus);window.removeEventListener('summon:voice-result',onResult);};
        const onStatus=event=>{
          const {state}=event.detail;
          if(['hearing','transcribing','processing'].includes(state)&&marks[state]===null)marks[state]=performance.now();
          if(state==='error'){cleanup();reject(new Error(event.detail.text||'Synthetic voice capture failed'));}
        };
        const onResult=event=>{
          const endedAt=performance.now();cleanup();
          if([marks.hearing,marks.transcribing,marks.processing].some(value=>!Number.isFinite(value))){reject(new Error('Voice result arrived without all capture/transcription/command phase timestamps'));return;}
          resolve({...event.detail,timings:{startupMs:marks.hearing-marks.requested,captureMs:marks.transcribing-marks.hearing,whisperMs:marks.processing-marks.transcribing,commandMs:endedAt-marks.processing,totalMs:endedAt-marks.requested}});
        };
        const timer=setTimeout(()=>{cleanup();reject(new Error('Voice test timed out'));},60000);
        window.addEventListener('summon:voice-status',onStatus);window.addEventListener('summon:voice-result',onResult);
        window.dispatchEvent(new CustomEvent('summon:voice-mode',{detail:'command'}));
      });}finally{
        navigator.mediaDevices.getUserMedia=previousGetUserMedia;
        window.dispatchEvent(new CustomEvent('summon:voice-mode',{detail:'off'}));
        destination.stream.getTracks().forEach(track=>track.stop());await ctx.close();
      }
    },audio);assert.equal(voice.result.kind,'files');assert.equal(voice.result.fileIds.length,1);
    for(const [phase,duration] of Object.entries(voice.timings))assert.ok(Number.isFinite(duration)&&duration>=0,`${phase} must be a nonnegative numeric duration`);
    console.log('Synthetic voice phase timings (ms):',JSON.stringify({...Object.fromEntries(Object.entries(voice.timings).map(([phase,duration])=>[phase,Math.round(duration)])),recognizedTextVisibleMs:Math.round(interim.visibleAfterMs)}));
    console.log('Synthetic microphone → local Whisper → file command passed.');
  }
  await page.evaluate(()=>window.summon.settings({paused:true}));
  assert.equal((await page.evaluate(()=>window.summon.snapshot())).settings.paused,true);
  await assert.rejects(page.evaluate(()=>window.summon.openFile('../../etc/passwd')));
  const appWindow=await electron.browserWindow(page);await appWindow.evaluate(window=>window.setSize(780,660));await page.screenshot({path:'/private/tmp/summon-compact.png',fullPage:true});
  assert.deepEqual(errors,[]);console.log('Electron UI smoke passed: bridge, files, routine save/alias, memory save/search/forget, preferences, pause, invalid IDs, compact layout.');
}finally{await electron.close();await rm(dir,{recursive:true,force:true});}
