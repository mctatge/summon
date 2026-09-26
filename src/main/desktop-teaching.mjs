import {createDesktopProcedureStore,validateDesktopDemonstration,bindDesktopProcedure,compileDesktopProcedure,validateDesktopObservation} from '../core/desktop-procedures.mjs';
import {reasonAboutDesktopTeaching,desktopControlSupportsAction} from './desktop-teaching-engine.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const clone=value=>structuredClone(value);
const text=(value,max=4000)=>{if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error('Enter a short, nonempty teaching request.');return value.trim();};
const examples=p=>Object.fromEntries(p.parameters.map(item=>[item.name,item.example]));
const busy=phase=>['recording','reviewing','running','proposal'].includes(phase);
const matches=(control,target)=>Boolean(target&&control.role===target.role&&(!target.identifier||control.identifier===target.identifier)&&(!target.name||control.name===target.name));
const capable=(control,kind)=>desktopControlSupportsAction(kind,control);
const engines=new Set(['local','codex','claude']);
const screenKey=observation=>JSON.stringify({surface:observation.surface,text:observation.text,controls:observation.controls.map(({role,name,identifier,value,editable,actions})=>({role,name,identifier,value,editable,actions}))});

/** Explicit multi-app demonstrations. Native observation stays off until Start. */
export async function createDesktopTeaching({dataDir,bridge,reason=reasonAboutDesktopTeaching,localModel,onChange=()=>{},requestPermissions=async()=>{},excludedApps=()=>[],recordingLimitMs=300_000,recordingStatusMs=1000}={}){
  if(!Number.isSafeInteger(recordingStatusMs)||recordingStatusMs<10||recordingStatusMs>60_000)throw new Error('Invalid desktop recording status interval.');
  const store=await createDesktopProcedureStore({dataDir});
  let phase='idle',message='Choose the apps, then show Summon a task.',apps=[],selectedApps=[],permissions={accessibility:false,inputMonitoring:false};
  const engineFile=path.join(dataDir,'desktop-teaching-engine.json');
  let engine='codex',visualReading=false,settingsBusy=false;
  try{
    const saved=JSON.parse(await fs.readFile(engineFile,'utf8'));
    if(!saved||!engines.has(saved.engine))throw new Error('Invalid saved desktop engine.');
    engine=saved.engine;
  }catch(error){
    if(error.code!=='ENOENT'){engine='local';message='The saved reasoning choice could not be read. Local is selected; choose an engine before trying a task.';}
  }
  let reasoningController=null;
  const reasoning=async(kind,input)=>{
    const controller=new AbortController();reasoningController=controller;
    try{return await reason(kind,input,{engine,localModel,signal:controller.signal});}
    finally{if(reasoningController===controller)reasoningController=null;}
  };
  const engineName=()=>engine==='local'?'The local model':engine==='claude'?'Claude':'Codex';
  async function saveEngine(value){
    if(!engines.has(value))throw new Error('Choose Local, Codex or Claude for desktop reasoning.');
    const temporary=engineFile+'.'+randomUUID()+'.tmp';
    try{await fs.writeFile(temporary,JSON.stringify({engine:value})+'\n',{mode:0o600,flag:'wx'});await fs.rename(temporary,engineFile);}
    finally{await fs.rm(temporary,{force:true}).catch(()=>{});}
    engine=value;
  }
  let proposal=null,activeId=null,lastRun=null,intent='',utterances=[],recordingApps=[],generation=0,closed=false,timer=null,statusTimer=null,statusPoll=null;
  const notify=()=>{try{onChange();}catch{}};
  const set=(next,info)=>{phase=next;message=info;notify();};
  const brief=()=>({phase,message,activeId,mode:'desktop',browser:{connected:false}});
  const refreshRecordingStatus=()=>{
    if(phase!=='recording'||closed)return Promise.resolve();
    const ticket=generation;
    if(statusPoll?.ticket===ticket)return statusPoll.promise;
    const poll={ticket,promise:null};statusPoll=poll;
    poll.promise=(async()=>{
      try{
        const state=await bridge.request('status');
        if(current(ticket)&&phase==='recording'){
          if(state.recording===false){invalidate();set('error',state.failure||'The demonstration stopped. Start again when the selected app is ready.');}
          else if(typeof state.activeInScope==='boolean'){
            const count=Number.isSafeInteger(state.eventCount)?state.eventCount:0;
            const info=state.activeInScope?`Watching your selected app · ${count} recorded events. Finish when the task is complete.`:`Bring a selected app to the front to demonstrate · ${count} recorded events.`;
            if(info!==message)set('recording',info);
          }
        }
      }
      catch(error){if(current(ticket)&&phase==='recording'){invalidate();set('error',error.message);}}
      finally{if(statusPoll===poll)statusPoll=null;}
    })();
    return poll.promise;
  };
  const stopStatusPolling=()=>{clearTimeout(statusTimer);statusTimer=null;};
  const scheduleRecordingStatus=()=>{
    stopStatusPolling();
    const ticket=generation;
    statusTimer=setTimeout(async()=>{
      statusTimer=null;
      await refreshRecordingStatus();
      if(current(ticket)&&phase==='recording')scheduleRecordingStatus();
    },recordingStatusMs);
    statusTimer.unref?.();
  };
  const read=async()=>{
    await refreshRecordingStatus();
    let visualStatus='off',visualMessage='';
    if(visualReading){
      // Status reads report the last explicit capture; they never capture a screen.
      const status=await bridge.request('status').catch(()=>null);
      if(['off','ready','paused-recording','skipped-sensitive','skipped-incomplete','error'].includes(status?.visualStatus)){
        visualStatus=status.visualStatus;
        if(typeof status.visualMessage==='string')visualMessage=status.visualMessage.slice(0,400);
      }
    }
    return {...brief(),desktop:{permissions:clone(permissions),apps:clone(apps),selectedApps:[...selectedApps],engine,visualReading,visualStatus,visualMessage},connection:null,proposal:clone(proposal),procedures:await store.list(),lastRun:clone(lastRun)};
  };
  const invalidate=()=>{generation++;reasoningController?.abort();clearTimeout(timer);timer=null;stopStatusPolling();};
  const current=ticket=>!closed&&ticket===generation;
  const permitted=bundles=>{const excluded=new Set(excludedApps());if(!Array.isArray(bundles)||!bundles.length||bundles.length>12||bundles.some(id=>typeof id!=='string'||!id||id.length>200||excluded.has(id)))throw new Error('Choose up to 12 apps that are not excluded in Summon’s privacy settings.');return [...new Set(bundles)];};
  async function refresh(){
    if(closed)throw new Error('Desktop teaching has stopped.');
    permissions=await bridge.request('permissions');
    apps=(await bridge.request('apps')).filter(item=>!excludedApps().includes(item.bundleId));
    if(!busy(phase))selectedApps=selectedApps.filter(id=>apps.some(item=>item.bundleId===id));
    notify();
  }
  async function cancel(){
    invalidate();const ticket=generation;proposal=null;lastRun=null;activeId=null;
    await bridge.request('cancel').catch(()=>{});
    if(current(ticket))set('idle','Teaching stopped. No further desktop actions will run.');
  }
  async function begin(task){
    task=text(task);invalidate();const ticket=generation;proposal=null;lastRun=null;
    set('reviewing','Preparing the selected apps for your demonstration.');
    await bridge.request('cancel').catch(()=>{});if(!current(ticket))return;
    await refresh();if(!current(ticket))return;
    if(!permissions.accessibility||!permissions.inputMonitoring)throw new Error('Enable Accessibility and Input Monitoring for Summon, then refresh permissions.');
    const allowedApps=permitted(selectedApps);
    intent=task;utterances=[];recordingApps=[...allowedApps];
    await bridge.request('begin',{allowedApps,excludedApps:excludedApps()});
    if(!current(ticket))return;
    set('recording','Watching the selected apps. Show the task, then say “that’s it” or finish here.');
    timer=setTimeout(()=>{const pending=cancel(),expired=generation;void pending.then(()=>{if(current(expired))set('idle','The five-minute demonstration limit was reached. Show a shorter task.');});},recordingLimitMs);timer.unref?.();
    scheduleRecordingStatus();
  }
  async function finish(){
    if(phase!=='recording')throw new Error('Start a demonstration first.');
    clearTimeout(timer);timer=null;stopStatusPolling();const ticket=generation;
    set('reviewing',`${engineName()} is learning the task from your instructions and demonstrated interactions.`);
    const recorded=await bridge.request('finish');if(!current(ticket))return;
    if(!Array.isArray(recorded.events)||!recorded.events.some(event=>event.kind!=='activate'))throw new Error('No demonstration actions were captured. Bring a selected app to the front and show the task before finishing.');
    const demo=validateDesktopDemonstration({intent,utterances,allowedApps:permitted(recordingApps),events:recorded.events});
    const analysis=await reasoning('learn',demo);if(!current(ticket))return;
    proposal=compileDesktopProcedure(demo,analysis);
    set('proposal','Review what Summon learned, then save it for future tasks.');
  }
  async function save(){
    if(phase!=='proposal'||!proposal)throw new Error('Finish a demonstration before saving it.');
    const ticket=generation,saving=proposal;await store.save(saving);if(!current(ticket))return;
    activeId=saving.id;proposal=null;set('idle','Procedure saved. Say or enter the inputs to use next.');
  }
  const checkedObservation=(raw,bundleId)=>validateDesktopObservation(raw,[bundleId]);
  const observe=async bundleId=>checkedObservation(await bridge.request('snapshot',{bundleId}),bundleId);
  async function attempt(task){
    if(busy(phase))throw new Error('Finish or stop the current teaching session first.');
    task=text(task);invalidate();const ticket=generation;lastRun=null;activeId=null;intent=task;
    set('running','Understanding the task and the selected apps.');
    await refresh();if(!current(ticket))return;
    if(!permissions.accessibility)throw new Error('Enable Accessibility for Summon before trying a desktop task.');
    const allowedApps=permitted(selectedApps),availableApps=apps.filter(item=>allowedApps.includes(item.bundleId));
    if(visualReading&&!permissions.screenRecording)throw new Error('Allow Screen Recording for local screen reading, or turn off Read screen text.');
    await bridge.request('configure',{allowedApps,excludedApps:excludedApps(),visualReading});if(!current(ticket))return;
    // Retrieve small, relevant demonstrated lessons locally. They are guidance,
    // never authority to expand the selected app scope or execute stored code.
    const terms=new Set(task.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu)||[]);
    const lessons=(await store.list()).filter(p=>p.apps.every(item=>allowedApps.includes(item.bundleId))).map(p=>({p,score:(`${p.name} ${p.intent} ${p.summary}`.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu)||[]).filter(term=>terms.has(term)).length})).sort((a,b)=>b.score-a.score).slice(0,5).map(({p})=>({id:p.id,name:p.name,summary:p.summary,intent:p.intent,parameters:p.parameters,steps:p.steps.map(({kind,surface,target,value})=>({kind,surface,...(target?{target}:{}),...(value!==undefined?{value}:{})}))}));
    let observation=null,executed=0,unchanged=0,lastUnchangedAction=null;const history=[],initial=new Map();
    const stalled=(before,after,action)=>{
      if(!before||screenKey(before)!==screenKey(after)){unchanged=0;lastUnchangedAction=null;return false;}
      unchanged=lastUnchangedAction===action?unchanged+1:1;lastUnchangedAction=action;
      return unchanged>=2;
    };
    for(let turn=0;turn<24;turn++){
      if(!current(ticket))return;
      permitted(allowedApps);
      if(observation){observation=await observe(observation.surface.bundleId);if(!current(ticket))return;}
      set('running',`Reasoning about the next step${observation?` in ${observation.surface.app}`:''}. Say “no, like this” to show a correction.`);
      const next=await reasoning('next',{task,allowedApps:availableApps,observation,lessons,history:history.slice(-12),stepLimit:24,remaining:24-turn});if(!current(ticket))return;
      if(next.status==='clarify'){set('idle',next.reason||'Show Summon how to do this task.');return;}
      if(next.status==='done'){
        const evidence=typeof next.evidence==='string'?next.evidence:'';
        if(!observation||!evidence.trim()||!observation.text.includes(evidence))throw new Error('The proposed outcome is not visible in the current app.');
        const verified=executed>0&&!initial.get(observation.surface.bundleId)?.includes(evidence);
        lastRun={id:'attempt',values:{},verified,evidence:verified?evidence:'',task};
        set('idle',verified?`Done. The app shows “${evidence}”.`:`The app shows “${evidence}”. Check that this completes your request.`);return;
      }
      if(next.status!=='act'||!allowedApps.includes(next.bundleId))throw new Error('The proposed step is outside the selected apps.');
      permitted(allowedApps);
      set('running',next.reason||'Following the next step.');
      if(next.kind==='activate'){
        const previous=observation;
        observation=checkedObservation(await bridge.request('activate',{bundleId:next.bundleId}),next.bundleId);if(!current(ticket))return;
        if(!initial.has(next.bundleId))initial.set(next.bundleId,observation.text);
        history.push({kind:'activate',app:observation.surface.app});
        if(stalled(previous,observation,`activate:${next.bundleId}`)){set('idle','Stopped because the same step left the app unchanged twice. Show Summon the next step or adjust the task.');return;}
        continue;
      }
      if(!observation||observation.surface.bundleId!==next.bundleId||!['fill','click','press'].includes(next.kind))throw new Error('Inspect the selected app before choosing an action.');
      const control=observation.controls.find(item=>item.id===next.controlId);
      if(!control||!capable(control,next.kind))throw new Error('The proposed action does not match a current app control.');
      if(next.kind==='fill'&&(typeof next.value!=='string'||next.value.length>1200))throw new Error('The proposed field value is too long.');
      if(next.kind==='press'&&!['Enter','Tab','Escape'].includes(next.value))throw new Error('The requested key is not supported.');
      const result=await bridge.request('execute',{bundleId:next.bundleId,revision:observation.revision,controlId:next.controlId,kind:next.kind,...(next.kind!=='click'?{value:next.value}:{})});if(!current(ticket))return;
      const before=checkedObservation(result.before,next.bundleId);observation=checkedObservation(result.after,next.bundleId);executed++;
      history.push({kind:next.kind,app:observation.surface.app,target:{role:control.role,name:control.name},...(next.kind!=='click'?{value:next.value}:{}),before:before.text.slice(0,2000),after:observation.text.slice(0,2000)});
      if(stalled(before,observation,JSON.stringify([next.bundleId,next.kind,control.role,control.name,control.identifier??control.id,next.value??'']))){set('idle','Stopped because the same step left the app unchanged twice. Show Summon the next step or adjust the task.');return;}
    }
    if(current(ticket))set('idle','Stopped at the 24-step limit. Check the current result or show Summon the remaining steps.');
  }
  async function execute(id,values={}){
    if(busy(phase))throw new Error('Finish or stop the current teaching session first.');
    invalidate();const ticket=generation;lastRun=null;set('running','Preparing the learned task.');
    const procedure=await store.get(id);if(!current(ticket))return;if(!procedure)throw new Error('Choose a saved procedure.');
    const bound=bindDesktopProcedure(procedure,values),allowedApps=permitted(procedure.apps.map(item=>item.bundleId));
    permissions=await bridge.request('permissions');if(!current(ticket))return;
    if(!permissions.accessibility)throw new Error('Enable Accessibility for Summon before running a desktop procedure.');
    if(visualReading&&!permissions.screenRecording)throw new Error('Allow Screen Recording for local screen reading, or turn off Read screen text.');
    await bridge.request('configure',{allowedApps,excludedApps:excludedApps(),visualReading});if(!current(ticket))return;
    activeId=id;intent=procedure.intent;
    let final=null;const history=[];
    for(let index=0;index<bound.steps.length;index++){
      if(!current(ticket))return;
      const step=bound.steps[index],bundleId=step.surface.bundleId;
      permitted(allowedApps);
      set('running',`Step ${index+1} of ${bound.steps.length} · ${step.surface.app || bundleId}`);
      if(step.kind==='activate'){
        const after=checkedObservation(await bridge.request('activate',{bundleId}),bundleId);if(!current(ticket))return;
        history.push({kind:'activate',surface:after.surface});continue;
      }
      // Activating only a demonstrated app is part of following a cross-app task.
      // Activation already returns a fresh observation; execution independently
      // checks that revision and its controls again immediately before acting.
      const observation=checkedObservation(await bridge.request('activate',{bundleId}),bundleId);if(!current(ticket))return;
      const candidates=observation.controls.filter(control=>matches(control,step.target)&&capable(control,step.kind));
      let controlId=candidates.length===1?candidates[0].id:null;
      if(!controlId){
        set('running',`Finding the current control in ${step.surface.app || bundleId}.`);
        const resolution=await reasoning('resolve',{step,observation,allowedApps,goal:procedure.intent,history:history.slice(-8)});if(!current(ticket))return;
        if(resolution.status!=='act')throw new Error(resolution.reason||'The interface changed. Show Summon the corrected step.');
        const chosen=observation.controls.find(control=>control.id===resolution.controlId);
        if(!chosen||!capable(chosen,step.kind))throw new Error('The suggested control is not available for this action. Show Summon the corrected step.');
        controlId=chosen.id;
      }
      // The helper rejects stale revisions, wrong apps, and unavailable controls.
      // Inference never supplies native code, coordinates, or a new action kind.
      permitted(allowedApps);
      final=await bridge.request('execute',{bundleId,revision:observation.revision,controlId,kind:step.kind,...(step.value!==undefined?{value:step.value}:{})});
      if(!current(ticket))return;
      final={before:validateDesktopObservation(final.before),after:validateDesktopObservation(final.after)};
      if(final.before.surface.bundleId!==bundleId||final.after.surface.bundleId!==bundleId)throw new Error('The target app changed during the task. Check the result before continuing.');
      history.push({kind:step.kind,app:step.surface.app,target:step.target,value:step.value,result:final.after.text.slice(0,2000)});
    }
    if(!current(ticket))return;
    if(!final)throw new Error('This procedure has no action with a visible result.');
    const expected=bound.verification?.text;
    let verified=Boolean(expected&&final.after.text.includes(expected)&&!final.before.text.includes(expected)),evidence=verified?expected:'';
    if(!verified){
      set('running','Checking whether the current screen shows the requested result.');
      const primary=procedure.parameters.find(item=>item.primary),bindings={...examples(procedure),...values};
      const check=await reasoning('verify',{before:final.before,after:final.after,primaryValue:primary?bindings[primary.name]:undefined,goal:procedure.intent,history:history.slice(-8)});if(!current(ticket))return;
      // Validate evidence here too so a replaced model adapter cannot certify prose.
      const quote=typeof check.evidence==='string'?check.evidence:'';
      verified=check.verified===true&&quote.trim().length>0&&final.after.text.includes(quote)&&!final.before.text.includes(quote)&&(!primary||quote.toLowerCase().includes(bindings[primary.name].toLowerCase()));
      evidence=verified?quote:'';
    }
    lastRun={id,values:{...examples(procedure),...values},verified,evidence};
    set('idle',verified?`Done. The app shows “${evidence}”.`:'The steps ran. Check the result, then choose “Looks right” if the task is complete.');
  }
  async function action(name,input={}){
    if(closed)throw new Error('Desktop teaching has stopped.');
    if(settingsBusy&&name!=='cancel')throw new Error('Summon is saving your reasoning choice. Try again in a moment.');
    // Reject unrelated requests outside the task error handler: a rejected
    // settings change must never unlock a still-running task or switch its engine.
    if(busy(phase)&&!(['cancel','connect','refresh-apps'].includes(name)||(name==='finish'&&phase==='recording')||(name==='save'&&phase==='proposal')))throw new Error('Stop teaching before starting another task or changing settings.');
    const readDuringTask=busy(phase)&&['connect','refresh-apps'].includes(name);
    let ticket=generation;
    try{
      if(name==='cancel')await cancel();
      else if(name==='connect'||name==='refresh-apps')await refresh();
      else if(name==='permissions'){if(busy(phase))throw new Error('Stop teaching before changing permissions.');await requestPermissions();await refresh();}
      else if(name==='screen-permission'){if(busy(phase))throw new Error('Stop teaching before changing permissions.');await bridge.request('request-screen-recording');await refresh();}
      else if(name==='engine'){
        if(busy(phase))throw new Error('Stop teaching before changing the reasoning engine.');
        settingsBusy=true;
        try{await saveEngine(input.engine);if(current(ticket))set('idle',engine==='local'?'Desktop reasoning stays on this Mac. If the local model is unavailable, the task stops.':`${engineName()} will use your existing CLI sign-in. No API key is needed.`);}
        finally{settingsBusy=false;}
      }else if(name==='visual-reading'){
        if(busy(phase))throw new Error('Stop teaching before changing screen reading.');
        if(typeof input.enabled!=='boolean')throw new Error('Choose whether to read screen text.');
        settingsBusy=true;
        try{
          // Stop clears native capture/cache state without requesting permission.
          await bridge.request('cancel');if(!current(ticket))return read();
          visualReading=input.enabled;
          set('idle',visualReading?'Local screen reading is enabled for task attempts and reuse this session.':'Screen reading is off. Summon will use accessible text and controls.');
        }finally{settingsBusy=false;}
      }
      else if(name==='apps'){
        if(busy(phase))throw new Error('Stop teaching before changing the selected apps.');
        const ids=input.bundleIds;if(!Array.isArray(ids)||ids.length>12||ids.some(id=>!apps.some(item=>item.bundleId===id)))throw new Error('Choose apps from the current list.');
        selectedApps=[...new Set(ids)];notify();
      }else if(name==='start'){const pending=begin(input.intent);ticket=generation;await pending;}
      else if(name==='finish')await finish();
      else if(name==='save')await save();
      else if(name==='attempt'){const pending=attempt(input.intent);ticket=generation;await pending;}
      else if(name==='run'){const pending=execute(input.id,input.values);ticket=generation;await pending;}
      else if(name==='select'){
        if(busy(phase))throw new Error('Stop teaching before switching procedures.');
        const p=input.id===null?null:await store.get(input.id);if(input.id!==null&&!p)throw new Error('That procedure is no longer saved.');
        activeId=input.id;lastRun=null;if(p){intent=p.intent;selectedApps=p.apps.map(item=>item.bundleId);}set('idle',p?'Ready for the next input for this task.':'Voice reuse stopped.');
      }else if(name==='remove'){
        if(busy(phase))throw new Error('Stop teaching before removing a procedure.');
        await store.remove(input.id);if(activeId===input.id)activeId=null;set('idle','Procedure removed.');
      }else if(name==='confirm'){
        if(!lastRun)throw new Error('There is no result to confirm.');lastRun.confirmed=true;set('idle','Result confirmed. Ready for the next input.');
      }else throw new Error('Unknown desktop teaching action.');
    }catch(error){if(current(ticket)&&!readDuringTask)set('error',error.message);throw error;}
    return read();
  }
  const reply=()=>({kind:'message',message,failed:phase==='error'});
  const background=(pending,ticket=generation)=>{void pending.catch(error=>{if(current(ticket))set('error',error.message);});return reply();};
  async function command(raw){
    if(settingsBusy)return {kind:'message',message:'Summon is saving your reasoning choice. Try again in a moment.'};
    const clean=text(raw),normalized=clean.toLowerCase().replace(/[.!?,’']/g,'').replace(/\s+/g,' ');
    if(/^(?:summon )?(?:stop|cancel)(?: teaching| learning| task| that)?$/.test(normalized)&&(phase!=='idle'||activeId)){await cancel();return reply();}
    if(/^(?:(?:no ){1,4})?(?:like this|let me show you|watch me|ill show you)(?: .*)?$/.test(normalized)){await begin(intent||'Learn the task I demonstrate in the selected apps.');return reply();}
    const teach=clean.match(/^(?:teach(?: you)?|learn(?: this)?|watch me(?: do)?)\s+(.+)$/i);
    if(teach){await begin(teach[1]);return reply();}
    const requestedTask=clean.match(/^(?:try(?: this task)?|do this task)\s*[:,-]?\s+(.+)$/i);
    if(requestedTask){
      if(busy(phase))return {kind:'message',message:'Summon is working on this task. Say “stop” or “no, like this” to interrupt.'};
      const pending=attempt(requestedTask[1]);return background(pending,generation);
    }
    if(phase==='recording'){
      if(/^(?:thats it|done|finished|finish teaching|stop recording|now you try)$/.test(normalized))return background(finish());
      utterances.push(clean.slice(0,1000));utterances=utterances.slice(-12);set('recording','Got it. Keep demonstrating, or say “that’s it”.');return reply();
    }
    if(phase==='proposal'&&/^(?:save|save it|remember this|remember that|yes)$/.test(normalized)){await save();return reply();}
    if(busy(phase))return {kind:'message',message:'Summon is working on this task. Say “stop” or “no, like this” to interrupt.'};
    if(!activeId)return null;
    const p=await store.get(activeId);if(!p)return null;
    const ticket=generation;set('reviewing','Understanding the next request. Say “stop” to cancel.');
    return background((async()=>{
      const result=await reasoning('bind',{request:clean,procedure:p,currentValues:lastRun?.values??examples(p)});if(!current(ticket))return;
      if(result.understood!==true){set('idle',result.question||'Which inputs should I use for this task?');return;}
      const values=Object.create(null);if(!Array.isArray(result.values)||!result.values.length)throw new Error('No reusable input was recognized.');
      for(const item of result.values){if(!p.parameters.some(param=>param.name===item.name)||Object.hasOwn(values,item.name))throw new Error('The requested inputs were ambiguous.');values[item.name]=text(item.value,500);}
      const supplied={...(lastRun?.values??examples(p)),...values};set('idle',message);
      const pending=execute(p.id,supplied),executionTicket=generation;try{await pending;}catch(error){if(current(executionTicket))set('error',error.message);}
    })(),ticket);
  }
  const handles=raw=>Boolean(activeId)||phase==='recording'||/^(?:(?:no[ ,]+){1,4})?(?:like this|let me show you|watch me|i['’]?ll show you|teach(?: you)?|learn(?: this)?|try(?: this task)?|do this task)(?:[ ,.!?]|$)/i.test(raw)||(/^(?:summon )?(?:stop|cancel)(?: teaching| learning| task| that)?[.!?]*$/i.test(raw)&&(phase!=='idle'||activeId));
  async function close(){closed=true;invalidate();await bridge.close();await store.close?.();}
  return {read,brief,action,command,handles,cancel,close};
}
