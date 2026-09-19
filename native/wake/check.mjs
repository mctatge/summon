import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {createWakeDetector} from '../../src/main/wake.mjs';

const execute=promisify(execFile);
const temporary=await mkdtemp('/private/tmp/summon-wake-check-');
const detector=createWakeDetector({dataDir:process.env.SUMMON_DATA_DIR||path.join(homedir(),'Library/Application Support/Summon')});
const cases=[
  ['Summon.',true],['Hey Summon.',true],['Summon, open my calendar.',true],
  ['Summon, where did my Excel file go?',true],['Summon, switch to Harbor.',true],
  ['Open my calendar.',false],['Where did my Excel file go?',false],
  ['Someone left a file on my desktop.',false],['Summer starts in June.',false],
  ['The salmon is in the oven.',false],['Summarize these notes.',false],
  ['This is a common mistake.',false],['I am working on a workbook.',false],
];
const results=[];
try{
  const started=Date.now();await detector.start();
  console.log(JSON.stringify({startupMs:Date.now()-started,status:detector.status()}));
  for(const voice of (process.env.SUMMON_TEST_VOICES||'Samantha,Daniel').split(',')){
    for(let index=0;index<cases.length;index++){
      const [text,expected]=cases[index],aiff=path.join(temporary,`${voice}-${index}.aiff`),wav=path.join(temporary,`${voice}-${index}.wav`);
      await execute('/usr/bin/say',['-v',voice,'-r','175','-o',aiff,text],{timeout:15000});
      await execute('/opt/homebrew/bin/ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-i',aiff,'-ar','16000','-ac','1',wav],{timeout:15000});
      const result=await detector.detect(await readFile(wav));
      const record={voice,text,expected,...result};results.push(record);console.log(JSON.stringify(record));
    }
  }
  const failed=results.filter(row=>row.expected!==row.detected);
  const times=results.map(row=>row.elapsedMs).sort((a,b)=>a-b);
  console.log(JSON.stringify({cases:results.length,passed:results.length-failed.length,failed:failed.length,medianMs:times[Math.floor(times.length/2)],p95Ms:times[Math.floor(times.length*0.95)]}));
  assert.equal(failed.length,0,'Synthetic keyword checks failed; inspect the reported phrases.');
}finally{await detector.stop();await rm(temporary,{recursive:true,force:true});}
