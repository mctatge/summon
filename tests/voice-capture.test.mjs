import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const source=ts.transpileModule(await readFile(new URL('../src/renderer/voice.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function harness({input,resume,transcription,wakeDetected=false,sampleRate=16000}={}){
  const reports=[],calls=[],contexts=[],tracks=[],clips=[];
  const window=new EventTarget();
  let modeCallback;
  window.summon={voiceState:async state=>reports.push(state),onVoiceToggle:()=>()=>{},onEnrollSpeaker:()=>()=>{},verifySpeaker:async()=>({verified:true,score:1,elapsedMs:0}),beginEnrollment:async()=>({minSamples:10}),enrollSpeaker:async()=>({count:1,elapsedMs:0}),finishEnrollment:async()=>({saved:true,samples:0}),cancelEnrollment:async()=>{},onVoiceMode:callback=>{modeCallback=callback;return()=>{};},
    detectWake:async()=>({detected:wakeDetected}),transcribe:async audio=>{calls.push('transcribe');clips.push(audio);return transcription?transcription.promise:{text:'find my Excel files'};},command:async text=>{calls.push(text);return {kind:'files',fileIds:[]};}};
  class Track extends EventTarget {readyState='live';enabled=true;stop(){this.readyState='ended';}}
  const stream=()=>{const track=new Track();tracks.push(track);return {getTracks:()=>[track],getAudioTracks:()=>[track]};};
  class AudioContext{
    sampleRate=sampleRate;state='suspended';destination={};
    constructor(options){this.requestedSampleRate=options?.sampleRate;contexts.push(this);}
    async resume(){if(resume)await resume.promise;if(this.state!=='closed')this.state='running';}
    async close(){this.state='closed';}
    createMediaStreamSource(){return {connect(){},disconnect(){}};}
    createGain(){return {gain:{value:1},connect(){},disconnect(){}};}
    createScriptProcessor(){return this.processor={connect(){},disconnect(){},onaudioprocess:null};}
  }
  const exports={};
  vm.runInNewContext(source,{exports,window,navigator:{mediaDevices:{getUserMedia:async()=>input?input.promise:stream()}},AudioContext,CustomEvent,ArrayBuffer,DataView,Float32Array,Date,Math,Error,setTimeout:()=>1,clearTimeout(){}});
  const close=exports.installVoiceController();
  const mode=value=>modeCallback(value);
  const feed=(value,count)=>{for(let i=0;i<count;i++)contexts.at(-1).processor?.onaudioprocess?.({inputBuffer:{getChannelData:()=>new Float32Array(4096).fill(value)}});};
  return {reports,calls,contexts,tracks,clips,stream,mode,feed,close};
}

test('stop during microphone acquisition releases the late stream without activating capture',async()=>{
  const input=deferred(),h=harness({input});h.mode('handsfree');h.mode('off');input.resolve(h.stream());await tick();
  assert.equal(h.tracks[0].readyState,'ended');assert.equal(h.contexts.length,0);assert.equal(h.reports.at(-1).micActive,false);assert.deepEqual(h.calls,[]);h.close();
});
test('stop during AudioContext resume cannot reconnect the microphone',async()=>{
  const resume=deferred(),h=harness({resume});h.mode('handsfree');await tick();h.mode('off');resume.resolve();await tick();
  assert.equal(h.tracks[0].readyState,'ended');assert.equal(h.contexts[0].state,'closed');assert.equal(h.contexts[0].processor,undefined);assert.equal(h.reports.at(-1).mode,'off');h.close();
});
test('explicit stop discards a partly spoken one-shot command',async()=>{
  const h=harness();h.mode('command');await tick();h.feed(.1,3);h.mode('off');await tick();assert.deepEqual(h.calls,[]);assert.equal(h.tracks[0].readyState,'ended');h.close();
});
test('stop while Whisper is in flight discards its late command result',async()=>{
  const transcription=deferred(),h=harness({transcription});h.mode('command');await tick();h.feed(.1,3);h.feed(0,5);await tick();
  assert.deepEqual(h.calls,['transcribe']);h.mode('off');transcription.resolve({text:'open my calendar'});await tick();assert.deepEqual(h.calls,['transcribe']);assert.equal(h.reports.at(-1).mode,'off');h.close();
});
test('ordinary speech in hands-free mode never reaches Whisper without a wake match',async()=>{
  const h=harness();h.mode('handsfree');await tick();h.feed(.1,3);h.feed(0,5);await tick();assert.deepEqual(h.calls,[]);assert.equal(h.reports.at(-1).state,'listening');h.close();assert.equal(h.tracks[0].readyState,'ended');
});
test('a disconnected audio track stops the controller and clears its microphone state',async()=>{
  const h=harness();h.mode('handsfree');await tick();h.tracks[0].dispatchEvent(new Event('ended'));assert.equal(h.reports.at(-1).state,'error');assert.equal(h.reports.at(-1).micActive,false);assert.equal(h.tracks[0].readyState,'ended');h.close();
});

test('capture explicitly requests a backend-supported sample rate regardless of device defaults',async t=>{
  const h=harness({sampleRate:48000});t.after(h.close);h.mode('command');await tick();
  assert.equal(h.contexts[0].requestedSampleRate,48000);
  h.feed(.1,12);h.feed(0,10);await tick();
  assert.equal(new DataView(h.clips[0]).getUint32(24,true),48000,'WAV header uses the capture context sample rate');
});

test('steady low background noise after speech does not hold a command until the 18 second cap',async t=>{
  const h=harness({sampleRate:48000});t.after(h.close);h.mode('command');await tick();
  h.feed(.1,12);h.feed(.018,10);await tick();
  assert.deepEqual(h.calls,['transcribe','find my Excel files']);
  const clip=h.clips[0],seconds=(clip.byteLength-44)/(48000*2);
  assert.ok(seconds<2.1,`short command clip was ${seconds}s`);
  assert.equal(h.tracks[0].readyState,'ended');
});

test('a natural half-second pause stays inside one command and endpoints after the final pause',async t=>{
  const h=harness({sampleRate:48000});t.after(h.close);h.mode('command');await tick();
  h.feed(.07,12);h.feed(0,6);await tick();
  assert.deepEqual(h.calls,[]);assert.equal(h.reports.at(-1).micActive,true);
  h.feed(.05,12);h.feed(0,10);await tick();
  assert.deepEqual(h.calls,['transcribe','find my Excel files']);assert.equal(h.clips.length,1);
  assert.ok((h.clips[0].byteLength-44)/(48000*2)>3,'both spoken parts stay in the same clip');
});

test('gradually quieter speech remains captured instead of being learned as background noise',async t=>{
  const h=harness({sampleRate:48000});t.after(h.close);h.mode('command');await tick();
  for(const amplitude of [.1,.07,.045,.028,.018,.014]){h.feed(amplitude,12);await tick();assert.deepEqual(h.calls,[]);}
  h.feed(0,10);await tick();
  assert.deepEqual(h.calls,['transcribe','find my Excel files']);
  assert.ok((h.clips[0].byteLength-44)/(48000*2)>6,'quiet phrase ending was preserved');
});

test('capture feedback distinguishes hearing speech, waiting for a pause, and transcription',async t=>{
  const transcription=deferred(),h=harness({sampleRate:48000,transcription});t.after(h.close);
  h.mode('command');await tick();h.feed(.1,12);
  assert.equal(h.reports.at(-1).state,'hearing');assert.equal(h.reports.at(-1).micActive,true);
  h.feed(0,4);assert.equal(h.reports.at(-1).state,'finishing');assert.deepEqual(h.calls,[]);
  h.feed(.06,3);assert.equal(h.reports.at(-1).state,'hearing');
  h.feed(0,10);await tick();
  assert.equal(h.reports.at(-1).state,'transcribing');assert.equal(h.reports.at(-1).micActive,false);
  h.mode('off');transcription.resolve({text:'open calendar'});await tick();assert.deepEqual(h.calls,['transcribe']);
});
