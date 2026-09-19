import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,stat,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createUsage,sanitizeReport,normalizeUsageSettings,usageText,USAGE_DEFAULTS,STALE_MS} from '../src/core/usage.mjs';

const T0=Date.UTC(2026,8,19,21,0,0);
const at=ms=>new Date(T0+ms).toISOString();
const report=(provider,extra={})=>({provider,plan:provider==='claude'?'max':'plus',status:'ok',
  windows:provider==='claude'?[{id:'five_hour',label:'5h',usedPercent:27.3,resetsAt:at(3600_000)},{id:'seven_day',label:'7d',usedPercent:18,resetsAt:at(86400_000)}]:[{id:'seven_day',label:'7d',usedPercent:1,resetsAt:at(86400_000)}],
  fetchedAt:at(0),...extra});
const settle=async(turns=8)=>{for(let i=0;i<turns;i++)await new Promise(resolve=>setImmediate(resolve));};
function fakeTimers(){
  const timers=[];
  return {timers,setTimeout:(fn,ms)=>{const timer={fn,ms,unref(){}};timers.push(timer);return timer;},clearTimeout:timer=>{const index=timers.indexOf(timer);if(index>=0)timers.splice(index,1);},
    run:async()=>{const timer=timers.shift();assert.ok(timer,'a timer was expected');timer.fn();await settle();return timer.ms;},next:()=>timers.at(-1)?.ms??null};
}
async function fixture(options={}){
  const dir=await mkdtemp('/private/tmp/summon-usage-core-');let clock=T0;
  const calls={claude:0,codex:0},changes=[];
  const readers={claude:async()=>{calls.claude++;return report('claude');},codex:async()=>{calls.codex++;return report('codex');}};
  const timers=fakeTimers();
  const usage=await createUsage({dataDir:dir,readers,now:()=>clock,timers,onChange:()=>changes.push(1),...options});
  // Real file writes outlast a few event-loop turns: wait until no refresh is in flight, then let the tick reschedule.
  const idle=async()=>{for(let i=0;i<500&&usage.status().refreshing.length;i++)await new Promise(resolve=>setTimeout(resolve,2));await settle();};
  const run=async()=>{const timer=timers.timers.shift();assert.ok(timer,'a timer was expected');timer.fn();await idle();return timer.ms;};
  return {dir,usage,calls,changes,timers,readers,idle,run,advance:ms=>{clock+=ms;},cleanup:()=>rm(dir,{recursive:true,force:true})};
}

test('refresh asks each reader once, keeps the checked shape and persists usage.json at 0600',async()=>{
  const f=await fixture();
  try{
    assert.deepEqual(f.usage.status(),{version:1,settings:{...USAGE_DEFAULTS},providers:{claude:null,codex:null},refreshing:[],problem:null});
    const view=await f.usage.refresh();
    assert.deepEqual(view.providers.claude,{...report('claude'),stale:false});
    assert.deepEqual(view.providers.codex,{...report('codex'),stale:false});
    assert.deepEqual(view.refreshing,[]);assert.deepEqual(f.calls,{claude:1,codex:1});assert.equal(f.changes.length,2,'one change per provider that answered');
    const file=path.join(f.dir,'usage.json');
    assert.equal((await stat(file)).mode&0o777,0o600);
    const saved=JSON.parse(await readFile(file,'utf8'));
    assert.deepEqual(saved,{version:1,settings:{...USAGE_DEFAULTS},providers:{claude:report('claude'),codex:report('codex')}});
    assert.deepEqual(await readdir(f.dir),['usage.json'],'no temporary file is left behind');
    // A new meter over the same folder starts from the file; a reading older than the stale limit is shown as stale.
    const later=await createUsage({dataDir:f.dir,now:()=>T0+STALE_MS+1});
    assert.equal(later.status().providers.claude.stale,true);
    assert.equal(later.status().providers.codex.usedPercent,undefined);
    assert.deepEqual(later.status().providers.codex.windows,report('codex').windows);
    assert.equal(usageText(later.status().providers.claude),'Claude 5h 27% · 7d 18%');
    assert.equal(usageText(later.status().providers.codex),'Codex 7d 1%');
    // No readers at all: a refresh records the gap as an error, never a number.
    const missing=await later.refresh('claude');
    assert.equal(missing.providers.claude.status,'error');assert.match(missing.providers.claude.error,/not available/);
    assert.equal(missing.providers.claude.plan,'max','the last known plan is kept for the label');
  }finally{await f.cleanup();}
});

test('one refresh per provider at a time, and the other provider is never held up',async()=>{
  const f=await fixture();
  try{
    let release;const pending=new Promise(resolve=>{release=resolve;});
    f.readers.claude=async()=>{f.calls.claude++;await pending;return report('claude');};
    const first=f.usage.refresh('claude'),second=f.usage.refresh('claude'),codex=f.usage.refresh('codex');
    await settle();
    assert.deepEqual(f.calls,{claude:1,codex:1},'a second caller joins the exchange already running');
    assert.equal((await codex).providers.codex.status,'ok');
    assert.deepEqual(f.usage.status().refreshing,['claude'],'the held provider is the only one still refreshing');
    assert.equal(f.usage.status().providers.claude,null,'nothing is written until the reader answers');
    release();
    const [a,b]=await Promise.all([first,second]);
    assert.equal(a.providers.claude.status,'ok');assert.equal(b.providers.claude.status,'ok');
    assert.deepEqual(f.usage.status().refreshing,[]);
    await f.usage.refresh('claude');
    assert.equal(f.calls.claude,2,'once settled, the next refresh asks again');
    await assert.rejects(f.usage.refresh('gemini'),/Choose claude or codex/);
    await assert.rejects(f.usage.refresh(42),/Choose claude or codex/);
  }finally{await f.cleanup();}
});

test('a reader that throws or answers nonsense becomes an error report; stray fields never get in',async()=>{
  const f=await fixture();
  try{
    f.readers.claude=async()=>{throw new Error('Synthetic failure');};
    f.readers.codex=async()=>({provider:'claude',status:'ok',windows:[],fetchedAt:at(0)});
    const view=await f.usage.refresh();
    assert.deepEqual(view.providers.claude,{provider:'claude',plan:null,status:'error',windows:[],fetchedAt:at(0),error:'Synthetic failure',stale:false});
    assert.equal(view.providers.codex.status,'error');assert.match(view.providers.codex.error,/could not read/);
    f.readers.codex=async()=>({provider:'codex',plan:'plus',status:'ok',secret:'never',fetchedAt:at(0),
      windows:[{id:'five_hour',usedPercent:'55'},{id:'BAD ID',usedPercent:1},{id:'seven_day',label:'7d',usedPercent:250,resetsAt:'nonsense',token:'x'},{id:'seven_day',usedPercent:1},{id:'odd_9',usedPercent:12.345}]});
    const next=await f.usage.refresh('codex');
    assert.deepEqual(next.providers.codex,{provider:'codex',plan:'plus',status:'ok',windows:[{id:'seven_day',label:'7d',usedPercent:100,resetsAt:null},{id:'odd_9',label:'odd_9',usedPercent:12.3,resetsAt:null}],fetchedAt:at(0),stale:false});
    assert.equal(sanitizeReport('claude',{provider:'claude',status:'not_signed_in',windows:[{id:'five_hour',usedPercent:5}],fetchedAt:at(0),error:'x'}).windows.length,0,'windows only mean something on an ok report');
    assert.equal(sanitizeReport('claude',{provider:'claude',status:'ok',windows:[]}),null,'a report without a time is refused');
    assert.equal(sanitizeReport('claude',{provider:'claude',status:'great',windows:[],fetchedAt:at(0)}),null);
  }finally{await f.cleanup();}
});

test('settings are checked, kept in the same file and survive a restart',async()=>{
  const f=await fixture();
  try{
    assert.deepEqual(await f.usage.updateSettings({usageCeiling:70}),{usageCeiling:70,defaultEngine:'claude'});
    assert.deepEqual(await f.usage.updateSettings({defaultEngine:'codex'}),{usageCeiling:70,defaultEngine:'codex'});
    for(const bad of [{usageCeiling:49},{usageCeiling:101},{usageCeiling:70.5},{usageCeiling:'70'},{defaultEngine:'gemini'},{other:1},null,[]])await assert.rejects(f.usage.updateSettings(bad));
    assert.deepEqual(f.usage.settings(),{usageCeiling:70,defaultEngine:'codex'},'a refused patch changes nothing');
    assert.equal(f.changes.length,2);
    const again=await createUsage({dataDir:f.dir});
    assert.deepEqual(again.settings(),{usageCeiling:70,defaultEngine:'codex'});
    assert.deepEqual(normalizeUsageSettings({usageCeiling:100},{usageCeiling:60,defaultEngine:'codex'}),{usageCeiling:100,defaultEngine:'codex'});
    // A file with one bad setting keeps the good one and puts the bad one back to its default.
    await writeFile(path.join(f.dir,'usage.json'),JSON.stringify({version:1,settings:{usageCeiling:9,defaultEngine:'codex'},providers:{claude:report('claude'),codex:'nope'}}));
    const salvaged=await createUsage({dataDir:f.dir,now:()=>T0});
    assert.deepEqual(salvaged.settings(),{usageCeiling:85,defaultEngine:'codex'});
    assert.equal(salvaged.status().providers.claude.status,'ok');assert.equal(salvaged.status().providers.codex,null);
  }finally{await f.cleanup();}
});

test('the loop: a first read shortly after start, then every five minutes; asleep with the machine; gone on stop',async()=>{
  const f=await fixture({firstDelayMs:5000,intervalMs:300000});
  try{
    assert.equal(f.timers.next(),null,'nothing is scheduled before start');
    f.usage.start();f.usage.start();
    assert.equal(f.timers.timers.length,1);assert.equal(f.timers.next(),5000);
    assert.equal(await f.run(),5000);
    assert.deepEqual(f.calls,{claude:1,codex:1});
    assert.equal(f.timers.next(),300000,'then the regular interval');
    f.usage.pause();
    assert.equal(f.timers.next(),null,'a sleeping machine is not polled');
    f.usage.resume();
    assert.equal(f.timers.next(),5000,'waking up reads again shortly after');
    f.usage.resume();
    assert.equal(f.timers.timers.length,1,'an unlock with a poll already waiting adds nothing');
    await f.run();
    assert.deepEqual(f.calls,{claude:2,codex:2});
    // A refresh in flight when the machine sleeps finishes, then schedules nothing until resume.
    let release;const pending=new Promise(resolve=>{release=resolve;});
    f.readers.claude=async()=>{f.calls.claude++;await pending;return report('claude');};
    f.timers.timers.shift().fn();await settle();
    f.usage.pause();release();await f.idle();
    assert.equal(f.calls.claude,3);assert.equal(f.timers.next(),null);
    f.usage.resume();
    assert.equal(f.timers.next(),5000);
    f.usage.stop();
    assert.equal(f.timers.next(),null,'quitting leaves no timer behind');
    f.usage.resume();
    assert.equal(f.timers.next(),null,'a stopped meter stays stopped');
    await f.usage.close();
  }finally{await f.cleanup();}
});

test('a corrupt file is set aside and the meter starts clean',async()=>{
  const dir=await mkdtemp('/private/tmp/summon-usage-core-');
  try{
    await writeFile(path.join(dir,'usage.json'),'{not json');
    const usage=await createUsage({dataDir:dir,readers:{claude:async()=>report('claude'),codex:async()=>report('codex')},now:()=>T0});
    assert.match(usage.status().problem,/could not be read/);
    assert.deepEqual(usage.status().providers,{claude:null,codex:null});
    assert.ok((await readdir(dir)).some(name=>name.startsWith('usage.json.corrupt-')));
    await usage.refresh();
    assert.equal(usage.status().problem,null);
    assert.equal(JSON.parse(await readFile(path.join(dir,'usage.json'),'utf8')).providers.claude.status,'ok');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('usageText says it in one line',()=>{
  const claude={provider:'claude',status:'ok',plan:'max',fetchedAt:at(0),windows:[{id:'five_hour',label:'5h',usedPercent:27.3},{id:'seven_day',label:'7d',usedPercent:18},{id:'seven_day_opus',label:'7d Opus',usedPercent:3},{id:'seven_day_sonnet',label:'7d Sonnet',usedPercent:0.4}]};
  assert.equal(usageText(claude),'Claude 5h 27% · 7d 18% · 7d Opus 3% · 7d Sonnet 0%');
  assert.equal(usageText(claude,{ids:['five_hour','seven_day']}),'Claude 5h 27% · 7d 18%');
  assert.equal(usageText({...claude,windows:[claude.windows[2]]},{ids:['five_hour','seven_day']}),'Claude 7d Opus 3%','with none of the preferred windows, whatever there is');
  assert.equal(usageText({...claude,windows:[]}),'Claude · no limits reported');
  assert.equal(usageText(null,{name:'Codex'}),'Codex · no usage yet');
  for(const [status,words] of [['not_signed_in','not signed in'],['not_installed','not installed'],['not_applicable','no plan limits'],['error','could not read usage']])assert.equal(usageText({provider:'codex',status,windows:[]}),`Codex · ${words}`);
});
