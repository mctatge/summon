import {createRequire} from 'node:module';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// Renderer smoke only: IPC fixtures cannot request OS permissions or act in apps.
const require=createRequire(import.meta.url),{_electron}=require(process.env.SUMMON_PLAYWRIGHT||'playwright');
const dir=await mkdtemp('/private/tmp/summon-teaching-ui-'),data=path.join(dir,'data'),home=path.join(dir,'home');
await mkdir(home,{recursive:true});await mkdir(path.join(home,'Downloads'));await mkdir(path.join(home,'Desktop'));
const apps=[{bundleId:'com.example.catalog',name:'Catalog'},{bundleId:'com.example.notes',name:'Notes'}];
const desktopProcedure={kind:'desktop',id:'desktop-fixture',name:'Find an item and open its details',summary:'Search Catalog for the requested item, then open its details in Notes.',intent:'Search for the item I name and open its details.',apps,parameters:[{name:'item',label:'Item',example:'Orion',primary:true}],steps:[{kind:'activate',surface:{kind:'desktop',bundleId:apps[0].bundleId,app:'Catalog',title:'Items'}},{kind:'fill',surface:{kind:'desktop',bundleId:apps[0].bundleId,app:'Catalog'},target:{role:'AXTextField',name:'Search'},value:'{{item}}'},{kind:'click',surface:{kind:'desktop',bundleId:apps[1].bundleId,app:'Notes'},target:{role:'AXButton',name:'Open {{item}}'}}],verification:{text:'Details: {{item}}'}};
const browserProcedure={id:'browser-fixture',name:'Open a catalog item',summary:'Search the connected catalog and click the requested item.',scope:{origin:'https://example.test',pathname:'/catalog'},parameters:[{name:'item',label:'Item',example:'Orion',primary:true}],steps:[{kind:'fill',target:{tag:'input',name:'Search'},value:'{{item}}'},{kind:'click',target:{tag:'button',name:'{{item}}'}}],verification:{text:'Details: {{item}}'}};
let electron,page;
try{
  electron=await _electron.launch({executablePath:require('electron'),args:['.'],env:{...process.env,SUMMON_DATA_DIR:data,SUMMON_TEST_HOME:home,SUMMON_SOCKET:path.join(dir,'test.sock')},timeout:60000});
  page=await electron.firstWindow();const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.waitForFunction(()=>Boolean(window.summon));
  await electron.evaluate(({ipcMain},{apps,desktopProcedure,browserProcedure})=>{
    const fixture={calls:[],pendingRun:null,desktopSaved:[],browserSaved:[browserProcedure],state:{mode:'desktop',phase:'idle',message:'Choose the apps for your demonstration.',desktop:{permissions:{accessibility:false,inputMonitoring:false,screenRecording:false},apps,selectedApps:[],engine:'codex',visualReading:false},browser:{connected:false},connection:{port:12345,token:'isolated-ui-fixture-token-never-paired'},proposal:null,procedures:[],activeId:null,lastRun:null}};
    globalThis.__teachingUISmoke=fixture;
    const read=()=>structuredClone(fixture.state);
    ipcMain.removeHandler('summon:teaching-read');ipcMain.handle('summon:teaching-read',read);
    ipcMain.removeHandler('summon:teaching-action');ipcMain.handle('summon:teaching-action',(_event,action,input={})=>{
      fixture.calls.push({action,input});const state=fixture.state;
      if(action==='mode'){state.mode=input.mode;state.procedures=input.mode==='desktop'?fixture.desktopSaved:fixture.browserSaved;state.activeId=null;state.lastRun=null;state.message='Ready to teach.';}
      else if(action==='apps')state.desktop.selectedApps=input.bundleIds;
      else if(action==='permissions'){state.desktop.permissions.accessibility=true;state.message='Enable Input Monitoring in macOS.';}
      else if(action==='refresh-apps')state.desktop.permissions.inputMonitoring=true;
      else if(action==='engine')state.desktop.engine=input.engine;
      else if(action==='visual-reading')state.desktop.visualReading=input.enabled;
      else if(action==='screen-permission')state.desktop.permissions.screenRecording=true;
      else if(action==='start'){state.phase='recording';state.message='Recording only your selected apps.';}
      else if(action==='finish'){state.phase='proposal';state.proposal=desktopProcedure;state.message='Review the learned procedure.';}
      else if(action==='save'){fixture.desktopSaved=[desktopProcedure];state.procedures=fixture.desktopSaved;state.activeId=desktopProcedure.id;state.proposal=null;state.phase='idle';state.message='Procedure saved.';}
      else if(action==='select'){state.activeId=input.id;state.lastRun=null;}
      else if(action==='run'||action==='attempt'){state.phase='running';state.message='Following the saved procedure with fresh app context.';return new Promise(resolve=>{fixture.pendingRun=resolve;});}
      else if(action==='cancel'){state.phase='idle';state.proposal=null;state.message='Teaching stopped.';fixture.pendingRun?.({...read(),phase:'running',message:'This cancelled response must stay hidden.'});fixture.pendingRun=null;}
      else if(action==='remove'){state.procedures=state.procedures.filter(p=>p.id!==input.id);state.activeId=null;}
      else if(action==='confirm'){state.lastRun.confirmed=true;}
      else if(action!=='connect')throw new Error(`Unsupported fixture action ${action}`);
      return read();
    });
  },{apps,desktopProcedure,browserProcedure});

  await page.getByRole('button',{name:'Teach a task',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Teach Summon'});await dialog.waitFor();
  const macMode=page.getByRole('button',{name:'Mac apps',exact:true}),browserMode=page.getByRole('button',{name:'Browser tab',exact:true});
  assert.equal(await macMode.getAttribute('aria-pressed'),'true');
  await page.getByText('Accessibility and Input Monitoring needed',{exact:true}).waitFor();
  assert.equal((await electron.evaluate(()=>globalThis.__teachingUISmoke.calls)).some(call=>call.action==='permissions'),false,'Opening teaching does not request OS permissions');
  const start=page.getByRole('button',{name:'Start demonstration',exact:true});
  await page.getByRole('textbox',{name:'What should Summon do?',exact:true}).fill('Search for the item I name and open its details.');
  assert.equal(await start.isEnabled(),false);
  await page.screenshot({path:'/private/tmp/summon-teaching-desktop-permissions.png',fullPage:true});
  await page.getByRole('button',{name:'Enable desktop teaching',exact:true}).click();
  await page.getByText('Input Monitoring needed',{exact:true}).waitFor();
  assert.equal(await start.isEnabled(),false);
  const attempt=page.getByRole('button',{name:'Try task',exact:true});
  assert.equal(await attempt.isEnabled(),false,'An explicit app scope is required to attempt a task');
  await page.getByRole('checkbox',{name:'Catalog',exact:true}).check();
  await page.getByRole('checkbox',{name:'Notes',exact:true}).check();
  assert.deepEqual(await electron.evaluate(()=>globalThis.__teachingUISmoke.state.desktop.selectedApps),apps.map(app=>app.bundleId));
  assert.equal(await start.isEnabled(),false,'Recording still requires Input Monitoring');
  assert.equal(await attempt.isEnabled(),true,'Attempting a scoped task only needs Accessibility');
  const reasoning=page.getByRole('combobox',{name:'Desktop reasoning',exact:true});
  await reasoning.selectOption('local');
  await page.getByText(/Stops if unavailable; never switches to a cloud model/).waitFor();
  // This controlled checkbox commits only after its IPC response. check() tests
  // the state immediately after clicking, before React can receive that response.
  const visualReading=page.getByRole('checkbox',{name:'Read screen text locally',exact:true});
  await visualReading.click();
  await page.getByText('Screen Recording needed',{exact:true}).waitFor();
  assert.equal(await visualReading.isChecked(),true,'OCR consent is checked after the saved view arrives');
  assert.equal(await electron.evaluate(()=>globalThis.__teachingUISmoke.state.desktop.visualReading),true,'OCR consent reached the teaching service');
  assert.equal(await attempt.isEnabled(),false,'Opted-in OCR requires a separate screen permission');
  assert.equal((await electron.evaluate(()=>globalThis.__teachingUISmoke.calls)).some(call=>call.action==='screen-permission'),false,'Choosing OCR does not prompt for permission');
  await page.getByRole('button',{name:'Allow screen reading',exact:true}).click();
  assert.equal(await attempt.isEnabled(),true);
  await page.screenshot({path:'/private/tmp/summon-teaching-local-screen-reading.png',fullPage:true});
  await attempt.click();
  await page.getByRole('heading',{name:'Working on your task',exact:true}).waitFor();
  assert.equal(await reasoning.isEnabled(),false,'Provider stays pinned while a task runs');
  assert.equal(await page.getByRole('checkbox',{name:'Read screen text locally',exact:true}).isEnabled(),false,'Capture consent stays pinned while a task runs');
  await page.getByRole('button',{name:'Stop',exact:true}).click();
  await page.getByText('Teaching stopped.',{exact:true}).waitFor();
  assert.deepEqual((await electron.evaluate(()=>globalThis.__teachingUISmoke.calls)).find(call=>call.action==='attempt').input,{intent:'Search for the item I name and open its details.'});
  await page.getByRole('button',{name:'Refresh apps and permissions',exact:true}).click();
  await page.getByText('Desktop permissions ready',{exact:true}).waitFor();
  assert.equal(await start.isEnabled(),true);
  await start.click();
  await page.getByText('Go to your selected apps and do the task once.',{exact:true}).waitFor();
  assert.equal(await macMode.isEnabled(),false);assert.equal(await browserMode.isEnabled(),false);
  await page.getByRole('button',{name:'Finish demonstration',exact:true}).click();
  await page.getByText('LEARNED PROCEDURE',{exact:true}).waitFor();
  await page.getByRole('list',{name:'Procedure steps'}).getByText('Open Catalog',{exact:true}).waitFor();
  assert.equal(await page.getByRole('list',{name:'Procedure steps'}).getByText('Notes',{exact:true}).count(),1);
  assert.equal(await browserMode.isEnabled(),false,'Mode stays locked while reviewing the proposal');
  await page.screenshot({path:'/private/tmp/summon-teaching-desktop-proposal.png',fullPage:true});
  await page.getByRole('button',{name:'Save procedure',exact:true}).click();
  await page.getByRole('textbox',{name:'Item',exact:true}).fill('Vega');
  const runDesktop=page.getByRole('button',{name:'Run in saved apps',exact:true});
  assert.equal(await runDesktop.isEnabled(),true);
  await runDesktop.click();
  await page.getByRole('heading',{name:'Working on your task',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Stop',exact:true}).isEnabled(),true,'Stop remains enabled while run IPC is pending');
  await page.getByRole('button',{name:'Stop',exact:true}).click();
  await page.getByText('Teaching stopped.',{exact:true}).waitFor();
  assert.equal(await page.getByText('This cancelled response must stay hidden.',{exact:true}).count(),0);
  assert.deepEqual((await electron.evaluate(()=>globalThis.__teachingUISmoke.calls)).find(call=>call.action==='run').input.values,{item:'Vega'});
  const win=await electron.browserWindow(page);await win.evaluate(window=>window.setSize(780,660));
  await page.locator('.teaching-scroll').evaluate(element=>{element.scrollTop=0;});
  await page.screenshot({path:'/private/tmp/summon-teaching-desktop-compact.png',fullPage:true});
  assert.equal(await dialog.evaluate(element=>element.scrollWidth<=element.clientWidth),true,'Compact dialog does not overflow horizontally');

  await browserMode.click();
  await page.getByText('Connect a Chrome tab',{exact:true}).waitFor();
  assert.equal(await start.isEnabled(),false);
  await page.getByText('Set up the browser extension',{exact:true}).click();
  const connection=JSON.parse(await page.getByRole('textbox',{name:'Connection text',exact:true}).inputValue());
  assert.ok(connection.port>0);assert.ok(connection.token.length>=24);
  await page.getByText('Set up the browser extension',{exact:true}).click();
  await page.getByLabel('Active procedure',{exact:true}).selectOption(browserProcedure.id);
  await page.getByRole('textbox',{name:'Item',exact:true}).fill('Vega');
  const runBrowser=page.getByRole('button',{name:'Run on connected tab',exact:true});
  assert.equal(await runBrowser.isEnabled(),false,'Browser reuse needs the paired page');
  await electron.evaluate(()=>{globalThis.__teachingUISmoke.state.browser={connected:true,url:'https://example.test/elsewhere',title:'Wrong page'};});
  await page.getByText('Connect the page where this procedure was taught to run it again.',{exact:true}).waitFor();
  assert.equal(await runBrowser.isEnabled(),false);
  await electron.evaluate(()=>{globalThis.__teachingUISmoke.state.browser={connected:true,url:'https://example.test/catalog',title:'Catalog'};});
  await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(button=>button.textContent.trim()==='Run on connected tab'&&!button.disabled));
  await page.screenshot({path:'/private/tmp/summon-teaching-browser-panel.png',fullPage:true});
  await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog').count(),0);
  assert.deepEqual(errors,[]);
  console.log('PASS: actual Electron renderer; desktop default; explicit permission buttons; local reasoning and OCR consent; pinned options during tasks; multi-app scope; explicit task attempt; recording/proposal mode locking; learned app steps; saved inputs; pending-run cancellation; browser pairing and exact-page gating; compact layout; Escape; no renderer errors.');
}catch(error){if(page){await page.screenshot({path:'/private/tmp/summon-teaching-ui-error.png'}).catch(()=>{});console.error('UI errors:',await page.locator('[role=alert]').allTextContents().catch(()=>[]));}throw error;}
finally{await electron?.close();await rm(dir,{recursive:true,force:true});}
