// Real extension + trusted DOM events + main service. Set SUMMON_TEACHING_LIVE=1
// to use the signed-in Codex CLI for inference instead of the deterministic fixture.
import {createRequire} from 'node:module';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createBrowserTeachingBridge} from '../src/main/browser-teaching-bridge.mjs';
import {createBrowserTeaching} from '../src/main/browser-teaching.mjs';

const require=createRequire(import.meta.url),{chromium}=require(process.env.SUMMON_PLAYWRIGHT||'playwright');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),dir=await mkdtemp('/private/tmp/summon-teach-smoke-');
const fixture=await readFile(path.join(root,'tests/fixtures/browser-draft.html'));
const server=createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.end(fixture);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}/draft-tool`;
const bridge=createBrowserTeachingBridge();
const reason=async(kind)=>kind==='learn'?{name:'Pick a brawler',summary:'Set the map, search for the named brawler, and select it.',parameters:[{name:'map',label:'Map',example:'Hard Rock Mine',primary:false},{name:'brawler',label:'Brawler',example:'Najia',primary:true}],verificationText:'Picked: Najia'}:{understood:true,values:[{name:'brawler',value:'Jessie'}],question:''};
const teaching=await createBrowserTeaching({dataDir:path.join(dir,'data'),bridge,...(process.env.SUMMON_TEACHING_LIVE?{}:{reason})});
let browser,worker;
try{
  const connection=(await teaching.action('connect')).connection;
  const extension=path.join(root,'integrations/browser-teaching');
  browser=await chromium.launchPersistentContext(path.join(dir,'profile'),{headless:false,...(process.env.SUMMON_CHROMIUM?{executablePath:process.env.SUMMON_CHROMIUM}:{}),args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  const page=await browser.newPage();await page.goto(url);await page.bringToFront();
  worker=browser.serviceWorkers()[0]||await browser.waitForEvent('serviceworker');
  await worker.evaluate(async({connection,url})=>{const tabs=await chrome.tabs.query({});const tab=tabs.find(tab=>tab.url===url);return connectTab({...connection,tabId:tab.id});},{connection,url});
  assert.equal(bridge.status().connected,true);
  await teaching.action('start',{intent:'Set the map once, then select each brawler I name. I am showing Najia; next I will say Jessie.'});
  await page.getByLabel('Map',{exact:true}).fill('Hard Rock Mine');
  await page.getByRole('button',{name:'Use map',exact:true}).click();
  await page.getByLabel('Brawler',{exact:true}).fill('Najia');
  await page.getByRole('button',{name:'Najia',exact:true}).click();
  await page.getByText('Picked: Najia',{exact:true}).waitFor();
  const proposal=await teaching.action('finish');
  assert.equal(proposal.phase,'proposal');assert.ok(proposal.proposal.parameters.some(p=>p.example==='Najia'));
  assert.equal(proposal.procedures.length,0,'Unapproved proposal is not saved');
  const saved=await teaching.action('save');assert.equal(saved.procedures.length,1);
  const response=await teaching.command('Jessie');assert.equal(response.kind,'message');
  const deadline=Date.now()+150_000;
  while(['running','reviewing'].includes(teaching.brief().phase)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));
  const view=await teaching.read();assert.equal(view.phase,'idle',view.message);
  await page.getByText('Picked: Jessie',{exact:true}).waitFor({timeout:1000});
  assert.equal(await page.locator('body').getAttribute('data-map-changes'),'1','Changing brawler must preserve the map setup');
  assert.equal(view.lastRun.verified,true,view.message);
  await page.screenshot({path:'/private/tmp/summon-teaching-replay.png'});
  await teaching.command('no no no, like this');assert.equal(teaching.brief().phase,'recording');
  await teaching.command('stop');assert.equal(teaching.brief().phase,'idle');
  assert.equal(bridge.status().connected,true,'Correction and stop preserve pairing');
  await teaching.close();
  const restored=await createBrowserTeaching({dataDir:path.join(dir,'data'),bridge:createBrowserTeachingBridge(),reason});
  assert.equal((await restored.read()).procedures.length,1);await restored.close();
  console.log(`PASS: trusted map/Najia demonstration → ${process.env.SUMMON_TEACHING_LIVE?'live Codex':'fixture'} inference → explicit save → spoken-text Jessie binding → visible Jessie pick; map preserved; correction/cancel; persistent recall.`);
}catch(error){if(worker)console.error('Extension status:',await worker.evaluate(()=>chrome.storage.session.get('lastError')).catch(()=>({})));throw error;}
finally{await teaching.close().catch(()=>{});await browser?.close();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
