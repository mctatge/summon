// A launch recommendation is an intersection of fresh benchmark observations and the CLI's live model catalog.
// Never promote an old model's score to a newer alias, infer a coding score from a combined score, or select a
// model on account of a model name in source prose. All auth, availability enforcement and execution stay with Claude.
const FETCH_MAX_AGE=60*60*1000;
const MEASUREMENT_MAX_AGE=24*60*60*1000;
const CLOCK_SKEW=5*60*1000;
const isObject=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const exactId=/^claude-(?:opus|sonnet|haiku)-\d+(?:-\d+)*$/;
const badStatus=/\b(?:stale|synthetic|degraded|offline|failed|error|unavailable|unmeasured|estimated)\b/i;
const fallback=reason=>({model:null,name:null,category:null,reason:`${reason} Using Claude's configured default.`});
const fresh=(value,now,maxAge)=>{const stamp=typeof value==='string'?Date.parse(value):NaN;return Number.isFinite(stamp)&&stamp<=now+CLOCK_SKEW&&now-stamp<=maxAge;};
const unhealthy=value=>value?.isStale===true||value?.stale===true||value?.synthetic===true||value?.isSynthetic===true||value?.degraded===true||value?.rankable===false||badStatus.test(String(value?.status??''))||badStatus.test(String(value?.dataSource??''));
const FAMILIES=['haiku','sonnet','opus'];
const family=name=>FAMILIES.find(value=>name.startsWith(`claude-${value}-`));
const validProfile=value=>isObject(value)&&['coding','writing','research','reasoning','general'].includes(value.kind)&&['quick','standard','complex'].includes(value.complexity)&&value.effort===({quick:'low',standard:'medium',complex:'high'})[value.complexity];

function benchmarkProblem(benchmark,now){
  if(!isObject(benchmark)||benchmark.error||!Array.isArray(benchmark.models)||!benchmark.models.length)return 'Benchmark rankings are unavailable.';
  if(!['public-dashboard','data-api'].includes(benchmark.sourceKind)||benchmark.source!=='https://aistupidlevel.info/')return 'Benchmark provenance could not be verified.';
  if(unhealthy(benchmark)||!fresh(benchmark.fetchedAt,now,FETCH_MAX_AGE))return 'Benchmark rankings are stale or unsuitable for selection.';
  if(!['coding','combined'].includes(benchmark.actualCategory))return 'The source did not provide a comparable coding or combined score.';
  return null;
}

export function selectClaudeModel(benchmark,{supportedModels=[],now=Date.now(),profile=null,modelPreference='auto',effort}={}){
  const task=validProfile(profile)?{kind:profile.kind,complexity:profile.complexity,effort:profile.effort,reason:typeof profile.reason==='string'?profile.reason.slice(0,400):''}:null;
  const actualEffort=['low','medium','high'].includes(effort)?effort:task?.effort;
  const finish=result=>task?{...result,profile:task,effort:actualEffort,reason:`${result.reason} Task: ${task.complexity} ${task.kind}.`}:result;
  const defaultResult=reason=>finish(fallback(reason));
  if(!['auto',...FAMILIES].includes(modelPreference))return defaultResult('The model preference was not recognized.');
  const problem=benchmarkProblem(benchmark,now);
  if(modelPreference==='auto'&&problem)return defaultResult(problem);
  if(!Array.isArray(supportedModels)||!supportedModels.length)return defaultResult('Claude did not report exact available model identities.');
  const available=new Map();
  for(const model of supportedModels){
    // Fable may bill usage credits separately. Automatic launch selection stays with Opus/Sonnet/Haiku.
    if(!isObject(model)||typeof model.id!=='string'||!exactId.test(model.id)||typeof model.model!=='string')continue;
    if(model.model!==model.id&&model.model!==`${model.id}[1m]`)continue;
    available.set(model.id,model);
  }
  const candidates=[];
  for(const row of problem?[]:benchmark.models){
    if(!isObject(row)||row.provider!=='anthropic'||!available.has(row.name)||unhealthy(row))continue;
    if(typeof row.score!=='number'||!Number.isFinite(row.score)||row.score<0||row.score>100||!fresh(row.lastUpdated,now,MEASUREMENT_MAX_AGE))continue;
    candidates.push(row);
  }
  candidates.sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name));
  if(modelPreference!=='auto'){
    const choices=[...available.values()].filter(model=>family(model.id)===modelPreference);
    if(!choices.length)return defaultResult(`Claude did not report an exact available ${modelPreference} model for your override.`);
    const measured=candidates.find(row=>family(row.name)===modelPreference);
    if(!measured&&choices.length!==1)return defaultResult(`Claude reported multiple ${modelPreference} identities without a fresh benchmark to distinguish them.`);
    const chosen=measured?available.get(measured.name):choices[0];
    return finish({model:chosen.model,name:chosen.id,category:measured?benchmark.actualCategory:null,
      ...(measured?{benchmarkModel:measured.name,score:measured.score,source:benchmark.source,lastUpdated:measured.lastUpdated}:{}),
      reason:`Your ${modelPreference} override selects ${chosen.id} from Claude's live available catalog.${measured?` AI Stupid Level measured its ${benchmark.actualCategory} score at ${measured.score}.`:' A benchmark ranking was not required for this explicit choice.'}`});
  }
  if(!candidates.length)return defaultResult('No fresh measured Claude model matched the available catalog.');
  const best=candidates[0];
  // Only a measured near tie may trade a little benchmark score for a lighter family on an explicitly quick task.
  const winner=task?.complexity==='quick'&&actualEffort==='low'?[...candidates].filter(row=>best.score-row.score<=3)
    .sort((a,b)=>FAMILIES.indexOf(family(a.name))-FAMILIES.indexOf(family(b.name))||b.score-a.score||a.name.localeCompare(b.name))[0]:best;
  const model=available.get(winner.name),category=benchmark.actualCategory;
  const reason=winner!==best?`For a quick task, ${winner.name} is a lighter available Claude family within 3 points of the best fresh AI Stupid Level ${category} score (${winner.score} vs ${best.score}).`:
    category==='coding'?`AI Stupid Level ranks ${winner.name} highest among available Claude models for coding (${winner.score}).`:`AI Stupid Level ranks ${winner.name} highest among available Claude models by combined score (${winner.score}); the source did not provide a separate coding score.`;
  return finish({model:model.model,name:winner.name,benchmarkModel:winner.name,category,score:winner.score,source:benchmark.source,lastUpdated:winner.lastUpdated,reason});
}
