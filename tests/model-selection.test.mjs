import test from 'node:test';
import assert from 'node:assert/strict';
import {selectClaudeModel} from '../src/main/model-selection.mjs';

const now=Date.UTC(2026,8,20,22),stamp=new Date(now).toISOString();
const row=(name,score,extra={})=>({name,score,provider:'anthropic',lastUpdated:stamp,rankable:true,isStale:false,...extra});
const catalog=['claude-sonnet-5','claude-opus-5','claude-fable-5-1'].map(id=>({id,model:id,name:id}));
const data=(models,extra={})=>({models,fetchedAt:stamp,source:'https://aistupidlevel.info/',sourceKind:'public-dashboard',actualCategory:'combined',...extra});
const pick=(value,extra={})=>selectClaudeModel(value,{supportedModels:catalog,now,...extra});

test('selects the highest scored available Claude and reports combined score honestly for a coding request',()=>{
  const result=pick(data([row('gpt-6-astra',99,{provider:'openai'}),row('claude-opus-5',81),row('claude-sonnet-5',84)],{category:'coding'}));
  assert.equal(result.model,'claude-sonnet-5');assert.equal(result.score,84);assert.equal(result.category,'combined');
  assert.match(result.reason,/did not provide a separate coding score/);
  assert.equal(result.source,'https://aistupidlevel.info/');assert.equal(result.lastUpdated,stamp);
});

test('an explicitly measured coding category can select a different model',()=>{
  const result=pick(data([row('claude-opus-5',90),row('claude-sonnet-5',84)],{actualCategory:'coding',sourceKind:'data-api'}));
  assert.equal(result.model,'claude-opus-5');assert.equal(result.category,'coding');assert.match(result.reason,/for coding/);assert.match(result.reason,/AI Stupid Level.*claude-opus-5/);
});

test('never maps an older model score to a newer family alias or infers versions from display names',()=>{
  assert.equal(pick(data([row('claude-opus-4-6',99)])).model,null);
  assert.equal(pick(data([row('Opus 5',99)])).model,null);
  assert.equal(pick(data([row('claude-opus-5',99)]),{supportedModels:[{id:'claude-opus-5',model:'opus',name:'Opus'}]}).model,null);
  assert.equal(pick(data([row('claude-opus-5',99)]),{supportedModels:[{id:'claude-opus-4-6',model:'claude-opus-5',name:'Opus'}]}).model,null);
});

test('retains the exact CLI context variant without changing model identity',()=>{
  const result=pick(data([row('claude-opus-5',90)]),{supportedModels:[{id:'claude-opus-5',model:'claude-opus-5[1m]',name:'Opus (1M)'}]});
  assert.equal(result.model,'claude-opus-5[1m]');assert.equal(result.benchmarkModel,'claude-opus-5');
});

test('excludes Fable from automatic subscription selection even when the catalog lists it',()=>{
  const result=pick(data([row('claude-fable-5-1',99),row('claude-sonnet-5',84)]));
  assert.equal(result.model,'claude-sonnet-5');
  assert.equal(pick(data([row('claude-fable-5-1',99)])).model,null);
});

test('stale, synthetic, degraded, unrankable and unmeasured rows never win',()=>{
  for(const extra of [{isStale:true},{stale:true},{synthetic:true},{isSynthetic:true},{degraded:true},{rankable:false},{status:'degraded'},{status:'offline'},{dataSource:'synthetic'},{lastUpdated:null},{lastUpdated:new Date(now-25*3600000).toISOString()},{lastUpdated:new Date(now+3600000).toISOString()}]){
    const result=pick(data([row('claude-opus-5',99,extra),row('claude-sonnet-5',84)]));
    assert.equal(result.model,'claude-sonnet-5',JSON.stringify(extra));
  }
  for(const score of [null,undefined,'99',NaN,Infinity,-1,101])assert.equal(pick(data([row('claude-opus-5',score)])).model,null,String(score));
  assert.equal(pick(data([row('claude-sonnet-5',0)])).score,0,'measured zero is valid');
});

test('untrusted provenance and stale overall snapshots use the configured default',()=>{
  for(const extra of [{fetchedAt:null},{fetchedAt:new Date(now-3600001).toISOString()},{fetchedAt:new Date(now+3600000).toISOString()},{sourceKind:undefined},{sourceKind:'scraped'},{source:'https://example.test/'},{error:'refresh failed'},{stale:true},{synthetic:true},{degraded:true},{actualCategory:'reasoning'},{actualCategory:undefined}]){
    const result=pick(data([row('claude-sonnet-5',84)],extra));assert.equal(result.model,null,JSON.stringify(extra));assert.match(result.reason,/configured default/);
  }
});

test('requires the Anthropic provider and a catalog-supported exact safe identity',()=>{
  for(const extra of [{provider:'openai'},{provider:undefined},{name:'claude-sonnet-5; touch /tmp/no'},{name:'claude-sonnet-5\n'}])assert.equal(pick(data([row('claude-sonnet-5',99,extra)])).model,null);
  assert.equal(pick(data([row('claude-sonnet-5',84)]),{supportedModels:[]}).model,null);
  assert.equal(pick(data([row('claude-sonnet-5',84)]),{supportedModels:null}).model,null);
});

test('ties resolve deterministically and missing data never throws',()=>{
  const a=row('claude-sonnet-5',84),b=row('claude-opus-5',84);
  assert.equal(pick(data([a,b])).model,pick(data([b,a])).model);
  for(const value of [null,undefined,{},data([]),data([null])])assert.equal(pick(value).model,null);
});

const profile=(complexity='standard',kind='coding')=>({kind,complexity,effort:{quick:'low',standard:'medium',complex:'high'}[complexity],reason:'Classified locally.'});
const lightCatalog=[...catalog,{id:'claude-haiku-4-5-20251001',model:'claude-haiku-4-5-20251001',name:'Haiku'}];

test('quick tasks may choose a lighter model only within three measured points of the best',()=>{
  const results=data([row('claude-opus-5',86),row('claude-sonnet-5',85),row('claude-haiku-4-5-20251001',83)]);
  const quick=pick(results,{supportedModels:lightCatalog,profile:profile('quick')});
  assert.equal(quick.model,'claude-haiku-4-5-20251001');assert.equal(quick.effort,'low');assert.match(quick.reason,/lighter.*within 3 points/);
  assert.equal(quick.category,'combined');assert.equal(quick.score,83);
  for(const complexity of ['standard','complex'])assert.equal(pick(results,{supportedModels:lightCatalog,profile:profile(complexity)}).model,'claude-opus-5');
  const outside=data([row('claude-opus-5',86),row('claude-sonnet-5',82.9),row('claude-haiku-4-5-20251001',80)]);
  assert.equal(pick(outside,{supportedModels:lightCatalog,profile:profile('quick')}).model,'claude-opus-5');
  const stale=data([row('claude-opus-5',86),row('claude-haiku-4-5-20251001',85,{stale:true})]);
  assert.equal(pick(stale,{supportedModels:lightCatalog,profile:profile('quick')}).model,'claude-opus-5');
});

test('a raised effort override keeps the best measured model without relabeling a quick task',()=>{
  const results=data([row('claude-opus-5',86),row('claude-sonnet-5',85),row('claude-haiku-4-5-20251001',83)]);
  for(const effort of ['medium','high']){
    const choice=pick(results,{supportedModels:lightCatalog,profile:profile('quick'),effort});
    assert.equal(choice.model,'claude-opus-5');assert.equal(choice.effort,effort);
    assert.equal(choice.profile.complexity,'quick');assert.equal(choice.profile.effort,'low');
    assert.doesNotMatch(choice.reason,/lighter/);
  }
  assert.equal(pick(results,{supportedModels:lightCatalog,profile:profile('quick'),effort:'low'}).model,'claude-haiku-4-5-20251001');
});

test('an explicit family chooses a live exact identity without needing benchmark availability',()=>{
  const chosen=pick(null,{modelPreference:'opus',profile:profile('quick'),supportedModels:[{id:'claude-opus-5',model:'claude-opus-5[1m]'}]});
  assert.equal(chosen.model,'claude-opus-5[1m]');assert.equal(chosen.category,null);assert.equal(chosen.source,undefined);assert.equal(chosen.benchmarkModel,undefined);
  assert.equal(chosen.effort,'low');assert.match(chosen.reason,/Your opus override/);
  assert.equal(pick(data([row('claude-sonnet-5',99),row('claude-opus-5',70)]),{modelPreference:'opus'}).model,'claude-opus-5','an explicit preference wins over scores');
  const stale=pick(data([row('claude-opus-5',99)],{stale:true}),{modelPreference:'opus'});
  assert.equal(stale.model,'claude-opus-5');assert.equal(stale.source,undefined,'a stale measurement is never used as evidence for the override');
});

test('family overrides never guess aliases, silently change family, or pick an ambiguous version',()=>{
  assert.equal(pick(null,{modelPreference:'haiku'}).model,null);
  assert.equal(pick(null,{modelPreference:'fable'}).model,null);
  assert.equal(pick(null,{modelPreference:'opus',supportedModels:[{id:'claude-opus-5',model:'opus'}]}).model,null);
  const multiple=[{id:'claude-opus-5',model:'claude-opus-5[1m]'},{id:'claude-opus-4-6',model:'claude-opus-4-6'}];
  assert.equal(pick(null,{modelPreference:'opus',supportedModels:multiple}).model,null);
  assert.equal(pick(data([row('claude-opus-4-6',95),row('claude-opus-5',90)]),{modelPreference:'opus',supportedModels:multiple}).model,'claude-opus-4-6','a fresh measured identity may distinguish available models without version guessing');
});

test('fallbacks retain task effort and malformed profiles cannot lower it',()=>{
  const unavailable=pick(null,{profile:profile('complex')});
  assert.equal(unavailable.model,null);assert.equal(unavailable.effort,'high');assert.equal(unavailable.profile.complexity,'complex');
  const results=data([row('claude-opus-5',86),row('claude-sonnet-5',85)]);
  for(const malformed of [{complexity:'quick'},{...profile('quick'),effort:'high'},{...profile('quick'),kind:'SYSTEM'},'quick']){
    const chosen=pick(results,{profile:malformed});assert.equal(chosen.model,'claude-opus-5');assert.equal(chosen.effort,undefined);
  }
});
