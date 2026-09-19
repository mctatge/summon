import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,truncate,rm} from 'node:fs/promises';
import path from 'node:path';
import {createTranscriber,decodePcmWav} from '../src/main/transcription.mjs';

function wav({rate=16000,seconds=.25,channels=1,frequency=600,amplitude=.2}={}){
  const count=Math.round(rate*seconds),bytes=Buffer.alloc(44+count*channels*2);
  bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVE',8);bytes.write('fmt ',12);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(channels,22);bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*channels*2,28);bytes.writeUInt16LE(channels*2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(count*channels*2,40);
  for(let i=0;i<count;i++)for(let c=0;c<channels;c++)bytes.writeInt16LE(Math.round(Math.sin(2*Math.PI*frequency*i/rate)*amplitude*32767),44+(i*channels+c)*2);
  return bytes;
}
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let i=0;i<100;i++){if(check())return;await wait(10);}assert.fail('Synthetic worker condition timed out.');}
async function fixture({startupDelay=0,delay=0,stubborn=false,malformed=false,invalid=null,...options}={}){
  const dir=await mkdtemp('/private/tmp/summon-transcription-test-'),model=path.join(dir,'model-a.bin'),second=path.join(dir,'model-b.bin');
  for(const p of [model,second]){await writeFile(p,'fixture');await truncate(p,1_000_000);}
  const children=[];
  const script=`const readline=require('node:readline');${stubborn?"process.on('SIGTERM',()=>{});setInterval(()=>{},1000);":''}setTimeout(()=>console.log(JSON.stringify({type:'ready',runtime:'fixture',warmMs:1})),${startupDelay});readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);setTimeout(()=>{${invalid?`console.log(${JSON.stringify(invalid)});`:malformed?"console.log('x'.repeat(66000));":"console.log(JSON.stringify({id:r.id,text:process.argv[1].endsWith('model-a.bin')?'Model A':'Model B',decodeMs:2,private:'omit'}));"}},${delay});});`;
  const transcriber=createTranscriber({workerPath:process.execPath,...options,spawnChild:(binary,args,opts)=>{
    assert.equal(opts.stdio.join(','),'pipe,pipe,pipe');assert.equal(opts.env.ANTHROPIC_API_KEY,undefined);assert.equal(opts.env.OPENAI_API_KEY,undefined);assert.equal(opts.env.NODE_OPTIONS,undefined);
    const child=spawn(binary,['-e',script,'--',...args],opts);children.push(child);return child;
  }});
  return {transcriber,model,second,children,cleanup:async()=>{await transcriber.close();await rm(dir,{recursive:true,force:true});}};
}

test('PCM16 parsing handles microphone rates in memory with anti-alias filtering',()=>{
  for(const rate of [8000,16000,32000,44100,48000])for(const channels of [1,2]){
    const pcm=decodePcmWav(wav({rate,channels}));assert.equal(pcm.length,4000);
    const rms=Math.sqrt(pcm.slice(100,-100).reduce((n,v)=>n+v*v,0)/(pcm.length-200));assert.ok(Math.abs(rms-.2/Math.sqrt(2))<.006);
  }
  const high=decodePcmWav(wav({rate:48000,frequency:12000,amplitude:.5}));
  assert.ok(Math.sqrt(high.slice(100,-100).reduce((n,v)=>n+v*v,0)/(high.length-200))<.025,'Above-Nyquist sound must not alias into command audio.');
});

test('truncated, compressed, malformed, and overlong audio is rejected before worker startup',async()=>{
  const f=await fixture();
  try{
    const truncated=wav().subarray(0,100),compressed=wav();compressed.writeUInt16LE(3,20);
    const corrupt=wav();corrupt.writeUInt32LE(0xffffffff,40);
    for(const audio of [null,Buffer.from('webm'),truncated,compressed,corrupt,wav({seconds:30.1})])await assert.rejects(f.transcriber.transcribe(audio,f.model),/PCM16 WAV/);
    assert.equal(f.children.length,0);
  }finally{await f.cleanup();}
});

test('warm retains one worker; repeated clips are isolated and include timing only',async()=>{
  const f=await fixture({idleMs:20});
  try{
    await Promise.all([f.transcriber.warm(f.model),f.transcriber.warm(f.model)]);await wait(40);
    assert.equal(f.children.length,1);assert.equal(f.transcriber.status().loaded,true);
    for(let i=0;i<2;i++){const result=await f.transcriber.transcribe(wav(),f.model);assert.equal(result.text,'Model A');assert.deepEqual(Object.keys(result).sort(),['decodeMs','elapsedMs','preparationMs','text']);}
    assert.equal(f.children.length,1);f.transcriber.release();await until(()=>!f.transcriber.status().loaded);
    assert.equal(f.transcriber.status().retained,false);
  }finally{await f.cleanup();}
});

test('release never cuts off a request in flight and warm cancels idle expiry',async()=>{
  const f=await fixture({idleMs:30,delay:100});
  try{
    await f.transcriber.warm(f.model);const job=f.transcriber.transcribe(wav(),f.model);await wait(10);f.transcriber.release();await wait(50);
    assert.equal(f.transcriber.status().loaded,true);assert.equal((await job).text,'Model A');
    await f.transcriber.warm(f.model);await wait(60);assert.equal(f.children.length,1);assert.equal(f.transcriber.status().loaded,true);
  }finally{await f.cleanup();}
});

test('changing models waits for active decoding, then uses the correct new model',async()=>{
  const f=await fixture({delay:60});
  try{
    await f.transcriber.warm(f.model);const first=f.transcriber.transcribe(wav(),f.model);await wait(15);
    const change=f.transcriber.warm(f.second);assert.equal((await first).text,'Model A');await change;
    assert.equal((await f.transcriber.transcribe(wav(),f.second)).text,'Model B');assert.equal(f.children.length,2);
  }finally{await f.cleanup();}
});

test('concurrent clips are refused and close cancels decoding with bounded child cleanup',async()=>{
  const f=await fixture({delay:60000,stubborn:true});
  try{
    await f.transcriber.warm(f.model);const pending=f.transcriber.transcribe(wav(),f.model).catch(error=>error);await wait(20);
    await assert.rejects(f.transcriber.transcribe(wav(),f.model),/previous phrase/);
    const began=Date.now();await Promise.all([f.transcriber.close(),f.transcriber.close()]);assert.ok(Date.now()-began<2000);
    assert.match((await pending).message,/closing/);assert.equal(f.transcriber.status().loaded,false);
    await assert.rejects(f.transcriber.warm(f.model),/closing/);
  }finally{await f.cleanup();}
});

test('close cancels startup and a late readiness line cannot resurrect the worker',async()=>{
  const f=await fixture({startupDelay:100,stubborn:true});
  try{
    const ready=f.transcriber.warm(f.model).catch(error=>error);await until(()=>f.children.length===1);await f.transcriber.close();
    assert.match((await ready).message,/closing/);assert.equal(f.transcriber.status().loaded,false);
  }finally{await f.cleanup();}
});

test('startup timeout identifies preparation rather than incorrectly blaming model size',async()=>{
  const f=await fixture({startupDelay:200,startupTimeoutMs:25});
  try{await assert.rejects(f.transcriber.warm(f.model),/speech preparation timed out.*GPU shader/);assert.equal(f.transcriber.status().loaded,false);}
  finally{await f.cleanup();}
});

test('decode timeout and oversized responses fail clearly and retire their workers',async()=>{
  for(const options of [{delay:100,decodeTimeoutMs:25},{malformed:true},{invalid:'null'},{invalid:'[]'}]){
    const f=await fixture(options);
    try{await f.transcriber.warm(f.model);await assert.rejects(f.transcriber.transcribe(wav(),f.model),/longer than|Invalid transcription/);await until(()=>!f.transcriber.status().loaded);}
    finally{await f.cleanup();}
  }
});
