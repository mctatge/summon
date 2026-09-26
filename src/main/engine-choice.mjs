import {classifyTask} from './task-routing.mjs';

// Which CLI answers when the user says "Auto": local task classification, explicit feedback and the usage meter.
// A pinned engine wins; a thread already running somewhere is never switched; otherwise the provider with the most of
// its 5-hour window left, tie broken on the 7-day window, with any window at or over the ceiling counting as
// unavailable; and with nothing to go on, the user's default. Unknown usage (not signed in, not installed, no plan
// limits, an error, or a reading older than the stale limit) is never treated as 0 % used.
const ENGINES=['claude','codex'];
const NAMES={claude:'Claude',codex:'Codex'};
const other=engine=>ENGINES.find(item=>item!==engine);
const known=report=>!!report&&report.status==='ok'&&report.stale!==true&&Array.isArray(report.windows)&&report.windows.length>0&&report.windows.every(window=>window&&Number.isFinite(window.usedPercent)&&window.usedPercent>=0&&window.usedPercent<=100);
const remaining=(report,id)=>{const window=report.windows.find(item=>item.id===id);return window?Math.round((100-window.usedPercent)*10)/10:null;};
const unknownWords=report=>!report?'unknown':report.stale?'stale':report.status==='ok'?'unknown (no windows reported)':({not_signed_in:'unknown (not signed in)',not_installed:'unknown (not installed)',not_applicable:report.provider==='claude'?'unknown (not signed in, or no plan limits)':'unknown (no plan limits)',error:'unknown (could not be read)'})[report.status]||'unknown';

const FEEDBACK_MAX_AGE=30*24*60*60*1000;
function feedbackChoice(outcomes,profile,now){
  if(!profile||!Array.isArray(outcomes)||!Number.isFinite(now))return null;
  const counts={claude:{rated:0,useful:0},codex:{rated:0,useful:0}},seen=new Set();
  for(const row of outcomes.slice(-1000)){
    if(!row||typeof row!=='object'||Array.isArray(row)||typeof row.id!=='string'||!row.id.trim()||row.id.length>200||seen.has(row.id))continue;
    seen.add(row.id);
    if(!ENGINES.includes(row.engine)||row.kind!==profile.kind||row.complexity!==profile.complexity||!['useful','not-useful'].includes(row.rating))continue;
    if(row.effort!==profile.effort||row.completed!==true||!Number.isFinite(row.elapsedMs)||row.elapsedMs<0)continue;
    if(row.model!==null&&(typeof row.model!=='string'||!row.model.trim()||row.model.length>200))continue;
    if(row.policyVersion!==1)continue;
    const at=typeof row.at==='number'?row.at:typeof row.at==='string'?Date.parse(row.at):NaN;
    if(!Number.isFinite(at)||at>now||now-at>FEEDBACK_MAX_AGE)continue;
    counts[row.engine].rated++;if(row.rating==='useful')counts[row.engine].useful++;
  }
  if(ENGINES.some(engine=>counts[engine].rated<3))return null;
  const [winner,loser]=counts.claude.useful*counts.codex.rated>=counts.codex.useful*counts.claude.rated?ENGINES:[...ENGINES].reverse();
  const good=counts[winner],bad=counts[loser];
  if(good.useful*5<good.rated*4||(good.useful*bad.rated-bad.useful*good.rated)*5<good.rated*bad.rated)return null;
  return {engine:winner,reason:`your explicit feedback on ${profile.complexity} ${profile.kind} tasks favors ${NAMES[winner]} (${good.useful}/${good.rated} useful vs ${NAMES[loser]} ${bad.useful}/${bad.rated} in the last 30 days); both are below the usage ceiling`};
}

function chooseByUsage({task={},usage=null,settings={},outcomes=[],now=Date.now(),profile=null}={}){
  const ceiling=Number.isInteger(settings?.usageCeiling)&&settings.usageCeiling>=50&&settings.usageCeiling<=100?settings.usageCeiling:85;
  const fallback=ENGINES.includes(settings?.defaultEngine)?settings.defaultEngine:'claude';
  const pinned=task?.engine;
  if(ENGINES.includes(pinned))return {engine:pinned,reason:'pinned'};
  if(pinned!==undefined&&pinned!==null&&pinned!=='auto')throw new Error('Choose claude, codex or auto.');
  if(ENGINES.includes(task?.running))return {engine:task.running,reason:'a thread is already running there; a running thread is never switched'};
  const providers=usage?.providers&&typeof usage.providers==='object'?usage.providers:{};
  const usable=ENGINES.filter(engine=>known(providers[engine]));
  if(!usable.length){
    const stale=ENGINES.some(engine=>providers[engine]?.status==='ok'&&providers[engine].stale===true);
    return {engine:fallback,reason:stale?'usage is stale; your default':'no usage yet; your default'};
  }
  const over=engine=>providers[engine].windows.some(window=>window.usedPercent>=ceiling);
  const open=usable.filter(engine=>!over(engine));
  if(!open.length){
    if(usable.length===2)return {engine:fallback,reason:`both over the ${ceiling}% ceiling; your default`};
    return {engine:fallback,reason:`${NAMES[usable[0]]} is over the ${ceiling}% ceiling and ${NAMES[other(usable[0])]} usage is ${unknownWords(providers[other(usable[0])])}; your default`};
  }
  if(open.length===1){
    const engine=open[0],rest=other(engine);
    return {engine,reason:usable.includes(rest)?`${NAMES[rest]} is over the ${ceiling}% ceiling`:`${NAMES[rest]} usage is ${unknownWords(providers[rest])}`};
  }
  const learned=feedbackChoice(outcomes,profile,now);
  if(learned)return learned;
  const compare=id=>{
    const [a,b]=open,x=remaining(providers[a],id),y=remaining(providers[b],id);
    if(x===null||y===null)return {comparable:false,winner:null};
    if(x===y)return {comparable:true,winner:null};
    const [win,lose]=x>y?[a,b]:[b,a];
    return {comparable:true,winner:win,words:`${NAMES[win]} ${Math.max(x,y)}% left vs ${NAMES[lose]} ${Math.min(x,y)}%`};
  };
  const five=compare('five_hour');
  if(five.winner)return {engine:five.winner,reason:`more of its 5-hour window left (${five.words})`};
  const seven=compare('seven_day');
  if(seven.winner)return {engine:seven.winner,reason:`${five.comparable?'5-hour windows tie':'no 5-hour window on both sides'}; more of its 7-day window left (${seven.words})`};
  return {engine:open.includes(fallback)?fallback:open[0],reason:'usage ties; your default'};
}

export function chooseEngine(options={}){
  const profile=typeof options.task?.text==='string'&&options.task.text.trim()?classifyTask(options.task.text):null;
  const effortOverride=['low','medium','high'].includes(options.task?.effort)?options.task.effort:null;
  const effort=effortOverride??profile?.effort;
  const choice=chooseByUsage({...options,profile:profile?{...profile,effort}:null});
  // Calls without a task preserve the original usage-meter contract and wording exactly.
  return profile?{...choice,profile,effort,policyVersion:1,reason:`${choice.reason}. ${profile.complexity} ${profile.kind} task; ${effort} effort${effortOverride?' (your override)':''}. ${profile.reason}`} : choice;
}
