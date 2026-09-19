import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

// The usage meter: what each CLI last said about its own subscription windows, kept in usage.json (0600) beside the
// other Summon records, refreshed on a timer and on request, and read by the tray, the Preferences pane, the socket
// and the engine choice. This module never runs a CLI itself; the readers it is given do (src/main/usage-*.mjs),
// and every report they return is checked field by field before it is kept.
const VERSION=1;
export const PROVIDERS=['claude','codex'];
export const ENGINES=['claude','codex'];
export const STATUSES=['ok','not_signed_in','not_installed','not_applicable','error'];
export const NAMES={claude:'Claude',codex:'Codex'};
export const USAGE_DEFAULTS=Object.freeze({usageCeiling:85,defaultEngine:'claude'});
// A reading older than this is shown but never routed on: the machine may have slept through several refreshes.
export const STALE_MS=20*60_000;
const FIRST_DELAY_MS=5000,INTERVAL_MS=5*60_000,FILE='usage.json',STATE_BYTES=64*1024;
const isObject=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const validDate=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const clean=(value,max=300)=>typeof value==='string'?value.replace(/[\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max):'';
const WINDOW_ID=/^[a-z0-9_]{1,32}$/;

/** Keeps only the fields the contract names, each checked; anything else a reader sends is dropped rather than stored. */
export function sanitizeReport(provider,value){
  if(!PROVIDERS.includes(provider)||!isObject(value)||value.provider!==provider||!STATUSES.includes(value.status)||!validDate(value.fetchedAt))return null;
  const windows=[],seen=new Set();
  if(Array.isArray(value.windows))for(const window of value.windows.slice(0,8)){
    if(!isObject(window)||typeof window.id!=='string'||!WINDOW_ID.test(window.id)||seen.has(window.id)||typeof window.usedPercent!=='number'||!Number.isFinite(window.usedPercent))continue;
    seen.add(window.id);
    windows.push({id:window.id,label:clean(window.label,20)||window.id,usedPercent:Math.min(100,Math.max(0,Math.round(window.usedPercent*10)/10)),resetsAt:validDate(window.resetsAt)?new Date(Date.parse(window.resetsAt)).toISOString():null});
  }
  const report={provider,plan:clean(value.plan,40)||null,status:value.status,windows:value.status==='ok'?windows:[],fetchedAt:new Date(Date.parse(value.fetchedAt)).toISOString()};
  const error=clean(value.error,300);
  if(error)report.error=error;
  return report;
}
export function normalizeUsageSettings(patch,current=USAGE_DEFAULTS){
  if(!isObject(patch))throw new Error('Usage settings must be an object.');
  const next={...USAGE_DEFAULTS,...current};
  for(const [key,value] of Object.entries(patch)){
    if(key==='usageCeiling'){if(!Number.isInteger(value)||value<50||value>100)throw new Error('The usage ceiling must be a whole number from 50 to 100.');next.usageCeiling=value;}
    else if(key==='defaultEngine'){if(!ENGINES.includes(value))throw new Error('The default engine must be claude or codex.');next.defaultEngine=value;}
    else throw new Error(`Unknown usage setting: ${key}`);
  }
  return next;
}
/** One plain line for a menu row or a terminal: 'Claude 5h 27% · 7d 18%', 'Codex · not signed in'. */
export function usageText(report,{name,ids=null}={}){
  const who=name??NAMES[report?.provider]??'Usage';
  if(!report)return `${who} · no usage yet`;
  if(report.status==='ok'){
    const chosen=ids?report.windows.filter(window=>ids.includes(window.id)):report.windows;
    const windows=chosen.length?chosen:report.windows;
    return windows.length?`${who} ${windows.map(window=>`${window.label} ${Math.round(window.usedPercent)}%`).join(' · ')}`:`${who} · no limits reported`;
  }
  // The Claude CLI answers a signed-out account and a plan without limits the same way, so the words say both.
  const words={not_signed_in:'not signed in',not_installed:'not installed',not_applicable:report.provider==='claude'?'not signed in, or no plan limits':'no plan limits',error:'could not read usage'};
  return `${who} · ${words[report.status]||report.status}`;
}

export async function createUsage({dataDir,readers={},now=()=>Date.now(),timers=globalThis,firstDelayMs=FIRST_DELAY_MS,intervalMs=INTERVAL_MS,onChange=()=>{}}={}){
  if(typeof dataDir!=='string'||!dataDir)throw new Error('The usage meter needs a data folder.');
  const filename=path.join(dataDir,FILE);
  let state={version:VERSION,settings:{...USAGE_DEFAULTS},providers:{claude:null,codex:null}};
  const inFlight=new Map();
  let timer=null,paused=false,started=false,stopped=false,running=false,problem=null;
  const iso=()=>new Date(now()).toISOString();
  const notify=()=>{try{onChange();}catch{}};

  async function load(){
    let raw;
    try{raw=await fs.readFile(filename,'utf8');}catch(error){if(error.code==='ENOENT')return;problem=`Could not read usage.json: ${error.message}`;return;}
    let parsed=null,failure=null;
    try{parsed=JSON.parse(raw);if(!isObject(parsed)||parsed.version!==VERSION)throw new Error('Unrecognized usage file.');}catch(error){failure=error;}
    if(failure){
      // Keep the unreadable file for a look, then start clean: this is a cache plus two settings, not a record.
      const quarantine=`${filename}.corrupt-${Date.now()}-${randomUUID().slice(0,6)}`;
      const kept=await fs.rename(filename,quarantine).then(()=>true,()=>false);
      problem=`usage.json could not be read${kept?` (kept as ${path.basename(quarantine)})`:''}: ${failure.message}`;
      return;
    }
    let settings={...USAGE_DEFAULTS};
    if(isObject(parsed.settings))for(const [key,value] of Object.entries(parsed.settings)){try{settings=normalizeUsageSettings({[key]:value},settings);}catch{/* an invalid setting goes back to its default */}}
    const providers={claude:null,codex:null};
    if(isObject(parsed.providers))for(const provider of PROVIDERS)providers[provider]=sanitizeReport(provider,parsed.providers[provider]);
    state={version:VERSION,settings,providers};
  }
  // Writes go one at a time and each serializes the state as it is then, so two providers finishing together
  // cannot leave the earlier snapshot on disk.
  let saving=Promise.resolve();
  function save(){const job=saving.then(write);saving=job.catch(()=>{});return job;}
  async function write(){
    const contents=`${JSON.stringify(state,null,2)}\n`;
    if(Buffer.byteLength(contents)>STATE_BYTES)throw new Error('The usage file is larger than expected.');
    const tmp=path.join(dataDir,`.usage-${randomUUID()}.tmp`);
    let handle;
    try{
      handle=await fs.open(tmp,'wx',0o600);
      await handle.writeFile(contents);await handle.sync();await handle.close();handle=null;
      await fs.rename(tmp,filename);
      problem=null;
    }catch(error){
      problem=`Could not save usage.json: ${error.message}`;
      if(handle)await handle.close().catch(()=>{});
      await fs.unlink(tmp).catch(()=>{});
      throw error;
    }
  }
  const view=report=>report?{...report,windows:report.windows.map(window=>({...window})),stale:now()-Date.parse(report.fetchedAt)>STALE_MS}:null;
  const status=()=>({version:VERSION,settings:{...state.settings},providers:{claude:view(state.providers.claude),codex:view(state.providers.codex)},refreshing:PROVIDERS.filter(provider=>inFlight.has(provider)),problem});
  const settings=()=>({...state.settings});

  function one(provider){
    if(inFlight.has(provider))return inFlight.get(provider);
    const job=(async()=>{
      let report;
      try{
        const reader=readers[provider];
        if(typeof reader!=='function')throw new Error(`${NAMES[provider]} usage is not available in this Summon version.`);
        report=sanitizeReport(provider,await reader());
        if(!report)throw new Error(`${NAMES[provider]} returned usage Summon could not read.`);
      }catch(error){report={provider,plan:state.providers[provider]?.plan??null,status:'error',windows:[],fetchedAt:iso(),error:clean(error?.message,300)||'Unknown error'};}
      state.providers[provider]=report;
      await save().catch(()=>{});
      // Leave the in-flight set before telling listeners, so a snapshot taken inside onChange already shows this provider settled.
      inFlight.delete(provider);
      notify();
    })().finally(()=>{inFlight.delete(provider);});
    inFlight.set(provider,job);
    return job;
  }
  // One refresh per provider at a time: a second caller waits on the exchange already running rather than starting another.
  async function refresh(provider){
    const list=provider===undefined||provider===null?PROVIDERS:[provider];
    for(const item of list)if(!PROVIDERS.includes(item))throw new Error('Choose claude or codex.');
    await Promise.all(list.map(one));
    return status();
  }
  async function updateSettings(patch){
    state.settings=normalizeUsageSettings(patch,state.settings);
    await save();
    notify();
    return settings();
  }

  // The loop, modeled on the menu-bar count: a first read shortly after start, then every five minutes; asleep with
  // the machine, gone when Summon quits. A tick that finds the loop paused or stopped does nothing and schedules nothing.
  const clear=()=>{if(timer!==null){timers.clearTimeout(timer);timer=null;}};
  const schedule=delay=>{clear();if(!started||stopped||paused)return;timer=timers.setTimeout(()=>{timer=null;void tick();},delay);timer?.unref?.();};
  async function tick(){
    if(!started||stopped||paused||running)return;
    running=true;
    try{await refresh();}catch{}finally{running=false;}
    schedule(intervalMs);
  }
  const start=()=>{if(started)return;started=true;stopped=false;schedule(firstDelayMs);};
  const pause=()=>{paused=true;clear();};
  const resume=()=>{const was=paused;paused=false;if(started&&!stopped&&(was||timer===null)&&!running)schedule(firstDelayMs);};
  const stop=()=>{stopped=true;clear();};

  await load();
  return {refresh,status,settings,updateSettings,start,pause,resume,stop,close:async()=>{stop();await Promise.allSettled([...inFlight.values()]);}};
}
