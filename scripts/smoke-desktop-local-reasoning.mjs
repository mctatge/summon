// Real local inference over synthetic controls only. No native capture, app
// action, provider CLI, model download, or saved procedure is involved.
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {createLocalInterpreter} from '../src/main/local-model.mjs';
import {reasonAboutDesktopTeaching} from '../src/main/desktop-teaching-engine.mjs';

const localModel=createLocalInterpreter();
const surface={kind:'desktop',bundleId:'com.summon.fixture.Catalog',app:'Synthetic Catalog',title:'Reports'};
const input={task:'Open the Vega report in Synthetic Catalog.',allowedApps:[{bundleId:surface.bundleId,name:surface.app}],lessons:[],history:[],stepLimit:24,remaining:23,
  observation:{surface,revision:'synthetic-before',text:'Vega report is closed. Open Vega is available.',controls:[{id:'open-vega',role:'AXButton',name:'Open Vega',editable:false,actions:['click']}]}};
const options={engine:'local',localModel,group:async()=>{throw new Error('This smoke check must never call a provider CLI.');}};
try{
  const health=await localModel.health();
  assert.equal(health.available,true,health.error);
  let started=performance.now();
  const next=await reasonAboutDesktopTeaching('next',input,options);
  assert.equal(next.status,'act');assert.equal(next.kind,'click');assert.equal(next.controlId,'open-vega');
  console.log(`Validated local control choice in ${((performance.now()-started)/1000).toFixed(1)}s`);
  const after={surface,revision:'synthetic-after',text:'Vega report opened. You are viewing the Vega report.',controls:[]};
  started=performance.now();
  const result=await reasonAboutDesktopTeaching('next',{...input,observation:after,history:[{kind:'click',target:'Open Vega',result:after.text}],remaining:22},options);
  assert.equal(result.status,'done');assert.ok(after.text.includes(result.evidence));assert.ok(result.evidence.includes('Vega'));
  console.log(`Validated local outcome quote in ${((performance.now()-started)/1000).toFixed(1)}s`);
  console.log('PASS: existing local model selected a current control and quoted the supplied outcome. Synthetic observations only; no cloud request, screen capture or app action.');
}finally{await localModel.close();}
