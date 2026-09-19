import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,truncate,rm} from 'node:fs/promises';
import path from 'node:path';
import {createWakeDetector} from '../../src/main/wake.mjs';

async function fixture(script){
  const dataDir=await mkdtemp('/private/tmp/summon-wake-fixture-');
  await mkdir(path.join(dataDir,'wake/venv/bin'),{recursive:true});
  await mkdir(path.join(dataDir,'wake/model'),{recursive:true});
  await symlink('/usr/bin/python3',path.join(dataDir,'wake/venv/bin/python3'));
  for(const name of ['encoder.onnx','decoder.onnx','joiner.onnx','tokens.txt','keywords.txt'])await writeFile(path.join(dataDir,'wake/model',name),'fixture');
  await truncate(path.join(dataDir,'wake/model/encoder.onnx'),1_000_000);
  const workerPath=path.join(dataDir,'worker.py');await writeFile(workerPath,script);
  const detector=createWakeDetector({dataDir,workerPath});
  return {detector,cleanup:async()=>{await detector.stop();await rm(dataDir,{recursive:true,force:true});}};
}
const wav=Buffer.alloc(44);wav.write('RIFF',0);wav.write('WAVE',8);

test('wake readiness is explicit when the optional runtime is missing',async()=>{
  const dataDir=await mkdtemp('/private/tmp/summon-wake-missing-');
  const detector=createWakeDetector({dataDir});
  try{assert.equal(detector.status().available,false);await assert.rejects(detector.start(),/not installed/);assert.equal(detector.status().loaded,false);}
  finally{await detector.stop();await rm(dataDir,{recursive:true,force:true});}
});

test('a persistent worker handles repeated requests and releases resources on stop',async()=>{
  const f=await fixture(`import sys,json\nprint('{"type":"ready"}',flush=True)\nfor line in sys.stdin:\n r=json.loads(line)\n print(json.dumps({'id':r['id'],'result':{'detected':True,'elapsedMs':2,'keyword':'untrusted','timestamp':0.1,'extra':'omit'}}),flush=True)\n`);
  try{
    await f.detector.start();assert.equal(f.detector.status().loaded,true);
    for(let i=0;i<2;i++)assert.deepEqual(await f.detector.detect(wav),{detected:true,elapsedMs:2,keyword:'Summon',timestamp:0.1});
    await assert.rejects(f.detector.detect(Buffer.from('invalid')),/PCM WAV/);
    await Promise.all([f.detector.stop(),f.detector.stop()]);assert.equal(f.detector.status().loaded,false);
    await assert.rejects(f.detector.detect(wav),/shutting down/);
  }finally{await f.cleanup();}
});

test('stop cancels an active request and kills a worker that ignores termination',async()=>{
  const f=await fixture(`import sys,time,signal\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nprint('{"type":"ready"}',flush=True)\nfor line in sys.stdin:\n time.sleep(60)\n`);
  try{
    await f.detector.start();const request=f.detector.detect(wav).catch(error=>error);
    await new Promise(resolve=>setTimeout(resolve,50));const started=Date.now();
    await Promise.all([f.detector.stop(),f.detector.stop()]);
    assert.match((await request).message,/shutting down/);assert.ok(Date.now()-started<2000);
  }finally{await f.cleanup();}
});
