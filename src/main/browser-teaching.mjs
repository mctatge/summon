import {createProcedureStore,validateDemonstration,compileProcedure,bindProcedure} from '../core/browser-procedures.mjs';
import {reasonAboutTeaching} from './teaching-engine.mjs';

const copy=value=>structuredClone(value);
const scope=url=>{const u=new URL(url);return `${u.origin}${u.pathname}`;};
const valueText=(value,max=4000)=>{if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error('Enter a short, nonempty teaching request.');return value.trim();};
const scopeMatches=(procedure,url)=>{try{return scope(url)===`${procedure.scope.origin}${procedure.scope.pathname}`;}catch{return false;}};
const exampleValues=p=>Object.fromEntries(p.parameters.map(v=>[v.name,v.example]));

/** One explicit browser session. Raw demonstrations stay in RAM until reviewed. */
export async function createBrowserTeaching({dataDir,bridge,reason=reasonAboutTeaching,onChange=()=>{}}={}){
  const store=await createProcedureStore({dataDir});
  let phase='idle',message='Connect a browser tab, then show Summon a task.',connection=null,proposal=null,activeId=null;
  let generation=0,controller=null,intent='',utterances=[],baseline=null,lastRun=null,closed=false,recordTimer=null;
  const notify=()=>{try{onChange();}catch{}};
  const set=(next,text)=>{phase=next;message=text;notify();};
  const connectionChanged=()=>{if(!bridge.status().connected&&['recording','running'].includes(phase)){invalidate();proposal=null;baseline=null;set('error','The browser disconnected. Reconnect the tab before continuing.');}};
  const brief=()=>({phase,message,browser:bridge.status(),activeId});
  const read=async()=>({...brief(),connection:copy(connection),proposal:copy(proposal),procedures:await store.list(),lastRun:copy(lastRun)});
  const ensure=async()=>{if(closed)throw new Error('Browser teaching has stopped.');if(!connection)connection=await bridge.start();};
  const connected=()=>{if(!bridge.status().connected)throw new Error('Connect this tab from the Summon browser extension first.');};
  // Stop scheduling immediately, then send the bridge's priority cancel. A single
  // already-dispatched DOM action is atomic; aborting its transport would lose
  // the paired tab and prevent the user's immediate corrective demonstration.
  function invalidate(){generation++;controller=null;clearTimeout(recordTimer);recordTimer=null;}
  async function cancel(){invalidate();const ticket=generation;proposal=null;lastRun=null;activeId=null;baseline=null;await bridge.request('cancel',{}).catch(()=>{});if(ticket===generation)set('idle','Teaching stopped. No further browser actions will run.');}
  async function begin(text){
    text=valueText(text);invalidate();
    const ticket=generation;controller=new AbortController();proposal=null;lastRun=null;
    set('reviewing','Connecting the tab for your demonstration.');
    await ensure();if(ticket!==generation)return;connected();
    await bridge.request('cancel',{}).catch(()=>{});
    if(ticket!==generation)return;
    intent=text;utterances=[];
    await bridge.request('begin',{intent},{signal:controller.signal});
    if(ticket!==generation)return;
    set('recording','Watching this tab. Show the task, then say “that’s it” or finish here.');
    recordTimer=setTimeout(()=>{const pending=cancel(),expired=generation;void pending.then(()=>{if(expired===generation)set('idle','Teaching stopped after five minutes. Start again with a shorter demonstration.');});},300_000);recordTimer.unref?.();
  }
  async function finish(){
    if(phase!=='recording')throw new Error('Start a demonstration first.');
    clearTimeout(recordTimer);recordTimer=null;
    const ticket=generation,demonstratedDocument=documentKey();set('reviewing','Codex is identifying the reusable inputs in your demonstration.');
    const raw=await bridge.request('finish',{}, {signal:controller?.signal});
    if(ticket!==generation)return;
    const demo=validateDemonstration({url:raw.url,title:raw.title,events:raw.events,intent,utterances});
    const analysis=await reason('learn',demo);
    if(ticket!==generation)return;
    proposal=compileProcedure(demo,analysis);
    baseline=demonstratedDocument===documentKey()?{document:demonstratedDocument,id:proposal.id,values:exampleValues(proposal)}:null;
    set('proposal','Review the inputs and steps, then save this procedure for reuse.');
  }
  const documentKey=()=>{const b=bridge.status();return JSON.stringify([b.sessionId??b.connectedAt??null,b.tabId??null,b.documentId??null,b.url]);};
  async function save(){
    if(phase!=='proposal'||!proposal)throw new Error('There is no reviewed demonstration to save.');
    const saving=proposal,ticket=generation;
    await store.save(saving);if(ticket!==generation)return;activeId=saving.id;proposal=null;
    set('idle','Procedure saved. Say the next input, or enter it below.');
  }
  async function execute(id,values={}){
    if(['recording','reviewing','proposal','running'].includes(phase))throw new Error('Finish or stop the current teaching session first.');
    const priorBaseline=baseline;baseline=null;
    invalidate();const ticket=generation;controller=new AbortController();lastRun=null;
    set('running','Preparing the saved procedure.');
    await ensure();if(ticket!==generation)return;connected();const p=await store.get(id);if(ticket!==generation)return;if(!p)throw new Error('Choose a saved procedure.');
    if(!scopeMatches(p,bridge.status().url))throw new Error('Connect the page where this procedure was taught.');
    const bound=bindProcedure(p,values);
    activeId=id;intent=p.intent;
    set('running',`Using ${p.name} with the requested inputs.`);
    let start=0;
    // Within the same connected document, retain setup (e.g. the map) when only
    // the repeated input changes. Reconnecting always runs the complete procedure.
    if(priorBaseline?.id===id&&priorBaseline.document===documentKey()){
      const next={...exampleValues(p),...values};
      const changed=p.parameters.filter(v=>next[v.name]!==priorBaseline.values[v.name]).map(v=>`{{${v.name}}}`);
      const index=p.steps.findIndex(step=>changed.some(token=>JSON.stringify(step).includes(token)));
      if(index>=0)start=index;
    }
    let final=null;
    for(const step of bound.steps.slice(start)){
      if(ticket!==generation)return;
      if(!scopeMatches(p,bridge.status().url))throw new Error('The connected page changed. Stopped before the next action.');
      final=await bridge.request('execute',{step},{signal:controller.signal});
      if(ticket!==generation)return;
      if(!scopeMatches(p,bridge.status().url)||!scopeMatches(p,final?.after?.url))throw new Error('The connected page changed during the action. Check it before continuing.');
      if(final?.matched===false)throw new Error('The demonstrated control could not be matched uniquely. Show Summon the corrected step.');
    }
    if(ticket!==generation)return;
    const expected=bound.verification?.text;
    const verified=Boolean(expected&&typeof final?.after?.text==='string'&&typeof final?.before?.text==='string'&&final.after.text.includes(expected)&&!final.before.text.includes(expected));
    lastRun={id,values:{...exampleValues(p),...values},document:documentKey(),verified};
    baseline=verified?copy(lastRun):null;
    set('idle',verified?`Done. The page shows “${expected}”.`:'The recorded steps ran. Check the result; this demonstration did not provide a matching visible success check.');
  }
  async function action(name,input={}){
    let ticket=generation;
    try{
      await ensure();
      if(name==='start'){const pending=begin(input.intent);ticket=generation;await pending;}
      else if(name==='finish')await finish();
      else if(name==='cancel')await cancel();
      else if(name==='save')await save();
      else if(name==='run'){const pending=execute(input.id,input.values);ticket=generation;await pending;}
      else if(name==='select'){
        if(['recording','reviewing','proposal','running'].includes(phase))throw new Error('Finish or stop this session before switching procedures.');
        if(input.id!==null&&!await store.get(input.id))throw new Error('That procedure is no longer saved.');
        activeId=input.id;baseline=null;lastRun=null;const selected=activeId?await store.get(activeId):null;if(selected)intent=selected.intent;set('idle',activeId?(scopeMatches(selected,bridge.status().url)?'Ready for the next input for this procedure.':'Connect the page where this procedure was taught before using it.'):'Voice reuse stopped.');
      }else if(name==='remove'){
        if(['recording','reviewing','proposal','running'].includes(phase))throw new Error('Stop the current session before removing a procedure.');
        await store.remove(input.id);if(activeId===input.id){activeId=null;baseline=null;}set('idle','Procedure removed.');
      }else if(name==='confirm'){
        if(!lastRun)throw new Error('There is no result to confirm.');lastRun.confirmed=true;baseline=copy(lastRun);set('idle','Result confirmed. Ready for the next input.');
      }else if(name!=='connect')throw new Error('Unknown browser teaching action.');
    }catch(error){if(error.name!=='AbortError'&&ticket===generation)set('error',error.message);throw error;}
    return read();
  }
  const reply=()=>({kind:'message',message,failed:phase==='error'});
  const inBackground=(task,ticket=generation)=>{void task.catch(error=>{if(ticket===generation)set('error',error.message);});return reply();};
  async function command(text){
    const clean=valueText(text),normalized=clean.toLowerCase().replace(/[.!?,’']/g,'').replace(/\s+/g,' ');
    const stop=/^(?:summon )?(?:stop|cancel)(?: teaching| learning| drafting| browser| that)?$/.test(normalized);
    if(stop&&(phase!=='idle'||activeId)){await cancel();activeId=null;return reply();}
    if(/^(?:(?:no ){1,4})?(?:like this|let me show you|watch me|ill show you)(?: .*)?$/.test(normalized)){
      await begin(intent||'Learn the task I demonstrate in this browser tab.');return reply();
    }
    const teach=clean.match(/^(?:teach(?: you)?|learn(?: this)?|watch me(?: do)?)\s+(.+)$/i);
    if(teach){await begin(teach[1]);return reply();}
    if(phase==='recording'){
      if(/^(?:thats it|done|finished|finish teaching|stop recording|now you try)$/.test(normalized))return inBackground(finish());
      else{utterances.push(clean.slice(0,1000));utterances=utterances.slice(-12);set('recording','Got it. Continue demonstrating, or say “that’s it”.');}
      return reply();
    }
    if(phase==='proposal'&&/^(?:save|save it|remember this|remember that|yes)$/.test(normalized)){await save();return reply();}
    if(['reviewing','running','proposal'].includes(phase))return {kind:'message',message:'Summon is working on this browser task. Say “stop” or “no, like this” to interrupt.'};
    if(!activeId)return null;
    const p=await store.get(activeId);if(!p||!bridge.status().connected||!scopeMatches(p,bridge.status().url))return null;
    const ticket=generation;set('reviewing','Understanding the next input. Say “stop” or “no, like this” to interrupt.');
    return inBackground((async()=>{
    const result=await reason('bind',{request:clean,procedure:{name:p.name,intent:p.intent,parameters:p.parameters},currentValues:baseline?.values??exampleValues(p)});
    if(ticket!==generation)return reply();
    if(result?.understood!==true){set('idle',typeof result?.question==='string'&&result.question?result.question:'Which input should I use for this procedure?');return;}
    if(!Array.isArray(result.values)||!result.values.length)throw new Error('No input was recognized. Name the value you want to use.');
    const values=Object.create(null);
    for(const entry of result.values){if(!p.parameters.some(v=>v.name===entry?.name)||Object.hasOwn(values,entry.name))throw new Error('The requested inputs were ambiguous. State the field and its value.');values[entry.name]=valueText(entry.value,500);}
    set('idle',message);const running=execute(activeId,{...(baseline?.values??exampleValues(p)),...values});const executionTicket=generation;try{await running;}catch(error){if(executionTicket===generation)set('error',error.message);}
    })());
  }
  const handles=text=>Boolean(activeId&&bridge.status().connected)||phase==='recording'||/^(?:(?:no[ ,]+){1,4})?(?:like this|let me show you|watch me|i['’]?ll show you|teach(?: you)?|learn(?: this)?)(?:[ ,.!?]|$)/i.test(text)||(/^(?:summon )?(?:stop|cancel)(?: teaching| learning| drafting| browser| that)?[.!?]*$/i.test(text)&&(phase!=='idle'||activeId));
  async function close(){closed=true;invalidate();await bridge.close();await store.close?.();}
  return {read,brief,action,command,handles,close,cancel,connectionChanged};
}
