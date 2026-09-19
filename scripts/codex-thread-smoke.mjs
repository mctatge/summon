// Drives the real Codex app-server through src/main/codex-thread.mjs in an empty
// directory: read-only sandbox, ephemeral thread, one turn, exits non-zero when
// the reply is not the single word "ready" or the whole run passes 90 s.
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createCodexThread} from '../src/main/codex-thread.mjs';
import {executable,stopProcesses} from '../src/main/process.mjs';

const started=Date.now(),stamp=()=>`[${((Date.now()-started)/1000).toFixed(1)}s]`;
const brief=event=>{
  if(event.type==='delta')return JSON.stringify(event.text);
  if(event.type==='item')return `${event.phase} ${event.item?.type}${event.item?.type==='mcpToolCall'?` ${event.item.server}/${event.item.tool}`:''}`;
  if(event.type==='approval')return `${event.kind} -> ${event.decision}`;
  if(event.type==='status')return `${event.state}${event.activity?` (${event.activity})`:''}${event.reason?` ${event.reason}`:''}`;
  return `${event.status}${event.error?` ${event.error}`:''}`;
};
const cwd=await mkdtemp(path.join(tmpdir(),'summon-codex-smoke-'));
const deadline=setTimeout(()=>{console.error(`${stamp()} FAIL: no answer within 90 s`);process.exit(2);},90_000);
let code=1;
try{
  const thread=createCodexThread({cwd,sandbox:'read-only',ephemeral:true,executable:await executable('codex'),developerInstructions:'You are a smoke test. Answer in one word.',onEvent:event=>console.log(stamp(),event.type,brief(event))});
  const {threadId}=await thread.start();console.log(stamp(),'thread',threadId);
  const result=await thread.turn('Reply with exactly the single word: ready');
  console.log(stamp(),'result',JSON.stringify(result));
  console.log(stamp(),'stderr tail',JSON.stringify(thread.status().stderr.slice(-3)));
  await thread.close();
  code=result.status==='completed'&&result.text.trim()==='ready'?0:1;
  console.log(stamp(),code?'FAIL: reply was not "ready"':'PASS');
}catch(error){console.error(stamp(),'FAIL',error.message);}
finally{clearTimeout(deadline);await stopProcesses();await rm(cwd,{recursive:true,force:true});process.exit(code);}
