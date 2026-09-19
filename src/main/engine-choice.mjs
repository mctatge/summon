// Which CLI answers when the user says "Auto": a deterministic rule over the usage meter, no model in the loop.
// A pinned engine wins; a thread already running somewhere is never switched; otherwise the provider with the most of
// its 5-hour window left, tie broken on the 7-day window, with any window at or over the ceiling counting as
// unavailable; and with nothing to go on, the user's default. Unknown usage (not signed in, not installed, no plan
// limits, an error, or a reading older than the stale limit) is never treated as 0 % used.
const ENGINES=['claude','codex'];
const NAMES={claude:'Claude',codex:'Codex'};
const other=engine=>ENGINES.find(item=>item!==engine);
const known=report=>!!report&&report.status==='ok'&&report.stale!==true&&report.windows.length>0;
const remaining=(report,id)=>{const window=report.windows.find(item=>item.id===id);return window?Math.round((100-window.usedPercent)*10)/10:null;};
const unknownWords=report=>!report?'unknown':report.stale?'stale':report.status==='ok'?'unknown (no windows reported)':({not_signed_in:'unknown (not signed in)',not_installed:'unknown (not installed)',not_applicable:report.provider==='claude'?'unknown (not signed in, or no plan limits)':'unknown (no plan limits)',error:'unknown (could not be read)'})[report.status]||'unknown';

export function chooseEngine({task={},usage=null,settings={}}={}){
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
