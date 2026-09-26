import {readFile,writeFile,mkdir,rename,chmod,stat} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {classifyTask} from './task-routing.mjs';
import {chooseEngine} from './engine-choice.mjs';
import {selectClaudeModel} from './model-selection.mjs';
import {readClaudeModels} from './claude-models.mjs';
import {askEngine} from './engines.mjs';

const MAX_ROWS=200,RETENTION=30*86400_000,MAX_BYTES=128*1024;
const KINDS=['coding','writing','research','reasoning','general'];
const COMPLEXITIES=['quick','standard','complex'];
const EFFORTS=['low','medium','high'];
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const safeModel=value=>value===null||(typeof value==='string'&&value.length<=100&&/^(?:claude-(?:opus|sonnet|haiku)-\d+(?:-\d+)*(?:\[1m\])?|sonnet)$/.test(value));
function normalized(row,now){
  if(!object(row)||typeof row.id!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(row.id)||row.policyVersion!==1||typeof row.at!=='string')return null;
  const stamp=Date.parse(row.at);
  if(!Number.isFinite(stamp)||stamp>now||now-stamp>RETENTION||!['claude','codex'].includes(row.engine)||!KINDS.includes(row.kind)||!COMPLEXITIES.includes(row.complexity)||!EFFORTS.includes(row.effort)||!safeModel(row.model)||typeof row.completed!=='boolean'||!Number.isFinite(row.elapsedMs)||row.elapsedMs<0||row.elapsedMs>600_000||![null,'useful','not-useful'].includes(row.rating))return null;
  const result=Object.fromEntries(['id','at','policyVersion','engine','kind','complexity','effort','model','elapsedMs','completed','rating'].map(key=>[key,row[key]]));
  result.at=new Date(stamp).toISOString();
  if(!result.completed)result.rating=null;
  return result;
}

// Routing runs in process. Only normalized outcome metadata survives; prompts, answers, workspace paths,
// account fields and model responses are deliberately absent from this file and its read-only summaries.
export async function createTaskRouter({dataDir,getUsage=()=>null,getSettings=()=>({}),benchmark,readModels=readClaudeModels,ask=askEngine,selectEngine=chooseEngine,now=Date.now}={}){
  const file=path.join(dataDir,'routing-outcomes.json');
  let rows=[],writes=Promise.resolve(),catalog=null,catalogPending=null,problem=null,generation=0;
  try{
    if((await stat(file)).size>MAX_BYTES)throw new Error('Routing history is too large.');
    const stored=JSON.parse(await readFile(file,'utf8'));
    if(stored.version!==1||!Array.isArray(stored.outcomes))throw new Error('Unfamiliar routing history.');
    const seen=new Set();
    rows=stored.outcomes.map(row=>normalized(row,now())).filter(row=>row&&!seen.has(row.id)&&seen.add(row.id)).slice(-MAX_ROWS);
  }catch(error){if(error.code!=='ENOENT')problem='Routing history could not be read; starting with quota and local task rules.';}
  const outcomes=()=>rows.filter(row=>{const age=now()-Date.parse(row.at);return age>=0&&age<=RETENTION;}).map(row=>({...row}));
  const summary=()=>({count:outcomes().length,rated:outcomes().filter(row=>row.rating).length,problem});
  const save=()=>{
    const body=JSON.stringify({version:1,outcomes:outcomes().slice(-MAX_ROWS)});
    const write=writes.catch(()=>{}).then(async()=>{
      await mkdir(dataDir,{recursive:true,mode:0o700});
      await writeFile(`${file}.tmp`,body,{mode:0o600});await chmod(`${file}.tmp`,0o600);await rename(`${file}.tmp`,file);problem=null;
    });
    writes=write;
    return write.catch(()=>{problem='Routing feedback could not be saved on this Mac.';});
  };
  const choose=task=>selectEngine({task,usage:getUsage(),settings:getSettings(),outcomes:outcomes(),now:now()});
  function request(engine,text,options={}){
    if(!['auto','claude','codex'].includes(engine))throw new Error('Choose Auto, Claude or Codex.');
    if(typeof text!=='string'||!text.trim()||text.length>4000)throw new Error('Enter a question under 4,000 characters.');
    if(!object(options)||![Object.prototype,null].includes(Object.getPrototypeOf(options))||Reflect.ownKeys(options).some(key=>key!=='effort')||(options.effort!==undefined&&options.effort!=='auto'&&!EFFORTS.includes(options.effort)))throw new Error('Choose Auto, low, medium or high effort.');
    const choice=choose({engine,text,...(options.effort&&options.effort!=='auto'?{effort:options.effort}:{})}),profile=choice.profile||classifyTask(text);
    const effort=options.effort&&options.effort!=='auto'?options.effort:profile.effort;
    return {...choice,profile,effort,reason:`${choice.reason}${options.effort&&options.effort!=='auto'?`; effort set by you: ${effort}`:''}`};
  }
  async function models(){
    if(catalog&&now()>=catalog.checkedAt&&now()-catalog.checkedAt<300_000)return catalog.value;
    if(!catalogPending)catalogPending=Promise.resolve().then(()=>readModels()).then(value=>{if(value?.status==='ok')catalog={value,checkedAt:now()};return value;}).finally(()=>{catalogPending=null;});
    return catalogPending;
  }
  async function preview(engine,text,options={}){
    const choice=request(engine,text,options);
    if(choice.engine==='claude'){
      try{
        const [rankings,available]=await Promise.all([typeof benchmark==='function'?benchmark('combined'):null,models()]);
        const selection=selectClaudeModel(rankings,{supportedModels:available?.status==='ok'?available.models:[],profile:choice.profile,effort:choice.effort,now:now()});
        choice.model=selection.model||null;
        choice.reason+=`; ${selection.model?selection.reason:'benchmark model selection unavailable; using the existing Sonnet answer default'}`;
      }catch{choice.model=null;choice.reason+='; benchmark model selection unavailable; using the existing Sonnet answer default';}
    }else choice.model=null;
    return {...choice,history:summary()};
  }
  async function answer(engine,text,snapshot,options={}){
    const startedGeneration=generation;
    const choice=await preview(engine,text,options),start=now();
    let completed=false;
    const id=randomUUID();
    try{
      const result=await ask(choice.engine,text,snapshot,{effort:choice.effort,...(choice.engine==='claude'&&choice.model?{claudeModel:choice.model}:{})});
      completed=true;
      return {...result,engine:choice.engine,reason:choice.reason,effort:choice.effort,model:choice.model,profile:choice.profile,routeId:id};
    }finally{
      // Clearing history also discards metadata from answers that were already in flight at that point.
      if(startedGeneration===generation){
        rows=outcomes().concat({id,at:new Date(now()).toISOString(),policyVersion:1,engine:choice.engine,kind:choice.profile.kind,complexity:choice.profile.complexity,effort:choice.effort,model:choice.model,elapsedMs:Math.max(0,Math.min(600_000,now()-start)),completed,rating:null}).slice(-MAX_ROWS);
        await save();
      }
    }
  }
  async function feedback(id,rating){
    if(typeof id!=='string'||!['useful','not-useful'].includes(rating))throw new Error('Choose useful or not useful for this answer.');
    const row=rows.find(item=>item.id===id&&item.completed&&now()>=Date.parse(item.at)&&now()-Date.parse(item.at)<=RETENTION);
    if(!row)throw new Error('That answer is no longer in routing history.');
    row.rating=rating;await save();return summary();
  }
  async function clear(){generation++;rows=[];await save();return summary();}
  return {choose,preview,answer,feedback,clear,summary,outcomes,close:()=>writes.catch(()=>{})};
}
