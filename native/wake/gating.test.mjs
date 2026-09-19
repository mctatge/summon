import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const source=ts.transpileModule(await readFile(new URL('../../src/renderer/voice.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const tick=()=>new Promise(resolve=>setImmediate(resolve));

// Exercise the public controller and its audio callback. No private function
// instrumentation: each utterance crosses the same VAD/wake gate as capture.
function fixture(){
  const calls=[],events=[],reports=[],tracks=[],contexts=[];
  let detected=false,text='',modeCallback;
  const bridge={
    detectWake:async()=>{calls.push('wake');return {detected,elapsedMs:1};},
    transcribe:async()=>{calls.push('transcribe');return {text};},
    command:async input=>{calls.push(`command:${input}`);return {kind:'message',message:'Synthetic result'};},
    voiceState:async value=>{reports.push(value);},
    onVoiceToggle:()=>()=>{},onEnrollSpeaker:()=>()=>{},verifySpeaker:async()=>({verified:true,score:1,elapsedMs:0}),beginEnrollment:async()=>({minSamples:10}),enrollSpeaker:async()=>({count:1,elapsedMs:0}),finishEnrollment:async()=>({saved:true,samples:0}),cancelEnrollment:async()=>{},
    onVoiceMode:callback=>{modeCallback=callback;return()=>{modeCallback=undefined;};},
  };
  class Track extends EventTarget {
    readyState='live';enabled=true;
    stop(){this.readyState='ended';}
  }
  class AudioContext {
    sampleRate=16000;state='suspended';destination={};
    constructor(){contexts.push(this);}
    async resume(){this.state='running';}
    async close(){this.state='closed';}
    createMediaStreamSource(){return {connect(){},disconnect(){}};}
    createGain(){return {gain:{value:1},connect(){},disconnect(){}};}
    createScriptProcessor(){return this.processor={connect(){},disconnect(){},onaudioprocess:null};}
  }
  const window=new EventTarget();window.summon=bridge;
  for(const name of ['summon:voice-status','summon:voice-result'])window.addEventListener(name,event=>events.push(event));
  const exports={};
  vm.runInNewContext(source,{
    exports,window,AudioContext,CustomEvent,ArrayBuffer,DataView,Float32Array,Date,Math,Error,
    navigator:{mediaDevices:{getUserMedia:async()=>{
      const track=new Track();tracks.push(track);
      return {getTracks:()=>[track],getAudioTracks:()=>[track]};
    }}},
    setTimeout:()=>1,clearTimeout(){},
  });
  const cancel=exports.installVoiceController();
  const feed=(amplitude,count)=>{
    const processor=contexts.at(-1)?.processor;
    assert.equal(typeof processor?.onaudioprocess,'function','capture is ready');
    for(let i=0;i<count;i++)processor.onaudioprocess?.({inputBuffer:{getChannelData:()=>new Float32Array(4096).fill(amplitude)}});
  };
  return {calls,events,reports,tracks,contexts,bridge,cancel,
    configure:(wake,transcript)=>{detected=wake;text=transcript;},
    start:async(mode='handsfree')=>{
      modeCallback(mode);await tick();
      assert.equal(reports.at(-1).mode,mode);
      assert.equal(reports.at(-1).micActive,true);
    },
    capture:async()=>{feed(.1,3);feed(0,5);await tick();},
  };
}

test('handsfree ignores ordinary speech before Whisper and starts with the microphone off',async t=>{
  const f=fixture();t.after(f.cancel);assert.deepEqual(f.calls,[]);
  assert.equal(f.tracks.length,0);
  assert.equal(f.reports.at(-1).mode,'off');assert.equal(f.reports.at(-1).micActive,false);
  await f.start();
  f.configure(false,'open calendar');await f.capture();assert.deepEqual(f.calls,['wake']);
  assert.equal(f.reports.at(-1).state,'listening');assert.equal(f.reports.at(-1).micActive,true);
});

test('an unconfirmed keyword does not arm the next ambient utterance',async t=>{
  const f=fixture();t.after(f.cancel);await f.start();f.configure(true,'someone left a file');await f.capture();
  f.configure(false,'open calendar');await f.capture();
  assert.deepEqual(f.calls,['wake','transcribe','wake']);
  assert.match(f.events.find(event=>event.detail.text?.includes('unclear')).detail.text,/try/);
});

test('a confirmed standalone wake grants exactly one following command',async t=>{
  const f=fixture();t.after(f.cancel);await f.start();f.configure(true,'Hey, Summon.');await f.capture();
  f.configure(false,'open calendar');await f.capture();await f.capture();
  assert.deepEqual(f.calls,['wake','transcribe','transcribe','command:open calendar','wake']);
});

test('a confirmed combined wake and command executes and returns to listening',async t=>{
  const f=fixture();t.after(f.cancel);await f.start();f.configure(true,'Summon, open calendar');await f.capture();
  assert.deepEqual(f.calls,['wake','transcribe','command:open calendar']);
  assert.equal(f.reports.at(-1).state,'listening');assert.equal(f.reports.at(-1).mode,'handsfree');assert.equal(f.reports.at(-1).micActive,true);
  assert.equal(f.events.filter(event=>event.type==='summon:voice-result').length,1);
});

test('the explicitly pressed microphone bypasses keyword spotting',async t=>{
  const f=fixture();t.after(f.cancel);await f.start('command');f.configure(false,'open calendar');await f.capture();
  assert.deepEqual(f.calls,['transcribe','command:open calendar']);
  assert.equal(f.reports.at(-1).mode,'off');assert.equal(f.reports.at(-1).micActive,false);
  assert.equal(f.tracks[0].readyState,'ended');
});

test('a detector failure stops the mic without attempting Whisper',async t=>{
  const f=fixture();t.after(f.cancel);await f.start();
  f.bridge.detectWake=async()=>{f.calls.push('wake');throw new Error('Synthetic unavailable detector');};await f.capture();
  assert.deepEqual(f.calls,['wake']);assert.equal(f.reports.at(-1).state,'error');
  assert.equal(f.reports.at(-1).micActive,false);assert.equal(f.reports.at(-1).mode,'off');
  assert.equal(f.tracks[0].readyState,'ended');assert.equal(f.contexts[0].state,'closed');
});

test('a late wake result after cancellation cannot reach Whisper or a command',async t=>{
  const f=fixture();t.after(f.cancel);await f.start();let complete;
  f.bridge.detectWake=()=>{f.calls.push('wake');return new Promise(resolve=>{complete=resolve;});};
  // Speaker verification now runs before the wake check, so the wake call lands one turn later.
  const pending=f.capture();await tick();assert.equal(typeof complete,'function');
  f.cancel();complete({detected:true,elapsedMs:1});await pending;
  assert.deepEqual(f.calls,['wake']);assert.equal(f.reports.at(-1).mode,'off');assert.equal(f.reports.at(-1).micActive,false);
  assert.equal(f.tracks[0].readyState,'ended');assert.equal(f.contexts[0].state,'closed');
  assert.equal(f.events.filter(event=>event.type==='summon:voice-result').length,0);
});

test('a separate command captured while the standalone wake is being checked survives the queue',async t=>{
  const f=fixture();t.after(f.cancel);await f.start();let complete,wakeCalls=0;
  f.bridge.detectWake=()=>{
    f.calls.push('wake');wakeCalls++;
    return wakeCalls===1?new Promise(resolve=>{complete=resolve;}):Promise.resolve({detected:false,elapsedMs:1});
  };
  const transcripts=['Summon','open calendar'];
  f.bridge.transcribe=async()=>{f.calls.push('transcribe');return {text:transcripts.shift()||'ambient speech'};};
  await f.capture();assert.equal(typeof complete,'function');
  await f.capture();assert.deepEqual(f.calls,['wake']);
  complete({detected:true,elapsedMs:1});await tick();
  assert.deepEqual(f.calls,['wake','transcribe','transcribe','command:open calendar']);
  await f.capture();assert.deepEqual(f.calls,['wake','transcribe','transcribe','command:open calendar','wake']);
  assert.equal(f.reports.at(-1).mode,'handsfree');assert.equal(f.reports.at(-1).micActive,true);
});
