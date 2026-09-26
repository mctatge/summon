#!/usr/bin/env node
// Exploration only: existing local model, synthetic observations, no actions.
// Keeps production prompts, model selection and desktop behavior unchanged.
import {performance} from 'node:perf_hooks';
import {createLocalInterpreter,DEFAULT_LOCAL_MODEL} from '../src/main/local-model.mjs';
import {reasonAboutDesktopTeaching} from '../src/main/desktop-teaching-engine.mjs';
import {desktopDecisionCases,matchesExpected} from './experiments/desktop-cases.mjs';

const args=process.argv.slice(2);
const value=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1];};
const variants=value('--variants','baseline').split(',');
if(variants.some(v=>!['baseline','choice-full','choice-compact'].includes(v)))throw new Error('Unknown benchmark variant.');
const repeats=Number(value('--repeats','1'));
if(!Number.isInteger(repeats)||repeats<1||repeats>3)throw new Error('Use one to three repeats.');
const requested=value('--cases','').split(',').filter(Boolean);
const cases=desktopDecisionCases.filter(c=>!requested.length||requested.includes(c.name));
if(!cases.length||requested.some(name=>!desktopDecisionCases.some(c=>c.name===name)))throw new Error('Unknown benchmark case.');
const experiment=variants.some(v=>v!=='baseline')?await import('./experiments/desktop-choice.mjs'):null;
let inference=null;
const fetcher=async(url,init)=>{
  const response=await fetch(url,init);
  if(url.endsWith('/api/generate')&&JSON.parse(init.body||'{}').prompt){
    const d=await response.clone().json(),body=JSON.parse(init.body);
    const ms=value=>Number.isFinite(value)&&value>=0?Math.round(value/1e6):null;
    inference={complete:response.ok&&d.done===true&&d.done_reason!=='length',promptTokens:d.prompt_eval_count??null,outputTokens:d.eval_count??null,cachedPromptTokens:d.prompt_eval_cached_count??null,promptBytes:Buffer.byteLength(body.system+body.prompt),schemaBytes:Buffer.byteLength(JSON.stringify(body.format)),loadMs:ms(d.load_duration),promptMs:ms(d.prompt_eval_duration),decodeMs:ms(d.eval_duration),totalMs:ms(d.total_duration)};
  }
  return response;
};
const local=createLocalInterpreter({fetcher,contextTimeoutMs:45000});
const records=[];
const print=entry=>console.log(JSON.stringify(entry));
const median=values=>{const a=[...values].sort((a,b)=>a-b),m=Math.floor(a.length/2);return a.length?(a.length%2?a[m]:(a[m-1]+a[m])/2):null;};
try{
  const health=await local.health();print({phase:'health',...health});
  if(!health.available)throw new Error(health.error);
  for(let round=0;round<repeats;round++)for(let index=0;index<cases.length;index++){
    const fixture=cases[index];
    // Alternate order to reduce the advantage of being first/last in the cache.
    const offset=(round+index)%variants.length;
    for(const variant of [...variants.slice(offset),...variants.slice(0,offset)]){
      inference=null;const started=performance.now();let actual,error;
      try{
        let model=local;
        if(variant!=='baseline'){
          const choice=experiment.buildChoiceExperiment(fixture.input,{compactPrompt:variant==='choice-compact'});
          model={reasonStructured:async()=>{const result=await local.reasonStructured(choice.request);return {...result,raw:choice.decode(result.raw)};}};
        }
        actual=await reasonAboutDesktopTeaching('next',fixture.input,{engine:'local',localModel:model,group:()=>{throw new Error('Cloud calls are forbidden in this benchmark.');}});
      }catch(e){error=e.message;}
      const record={phase:'case',round:round+1,variant,name:fixture.name,passed:!error&&matchesExpected(actual,fixture.expected),wallMs:Math.round(performance.now()-started),inference,expected:fixture.expected,...(actual?{actual}:{}),...(error?{error}:{})};
      records.push(record);print(record);
    }
  }
  for(const variant of variants){
    const rows=records.filter(r=>r.variant===variant),measured=rows.filter(r=>r.inference?.complete&&r.inference.loadMs!==null),lowLoad=measured.filter(r=>r.inference.loadMs<500),successful=rows.filter(r=>r.passed);
    const paired=successful.filter(row=>variants.every(v=>records.some(r=>r.round===row.round&&r.name===row.name&&r.variant===v&&r.passed)));
    print({phase:'summary',variant,model:DEFAULT_LOCAL_MODEL,cases:rows.length,passed:successful.length,allAttemptMedianMs:median(rows.map(r=>r.wallMs)),successfulMedianMs:median(successful.map(r=>r.wallMs)),pairedSuccessfulCases:paired.length,pairedSuccessfulMedianMs:median(paired.map(r=>r.wallMs)),lowLoadCalls:lowLoad.length,lowLoadMedianMs:median(lowLoad.map(r=>r.wallMs)),lowLoadPromptMedianMs:median(lowLoad.map(r=>r.inference.promptMs)),lowLoadDecodeMedianMs:median(lowLoad.map(r=>r.inference.decodeMs)),outputTokensMedian:median(measured.map(r=>r.inference.outputTokens)),note:'Synthetic guarded outcomes; low-load means measured load under 500ms, not verified cache warmth. Includes incorrect decisions in all-attempt timing. No real capture/action, new model, provider call or production change.'});
  }
  if(records.some(r=>!r.passed))process.exitCode=1;
}finally{await local.close();}
