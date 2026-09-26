import net from 'node:net';
import {chmod,unlink,lstat} from 'node:fs/promises';
import path from 'node:path';
import {validateWorkRecoveryRequest} from '../core/work-item-protocol.mjs';

// Hook events from scripts/summon-hook.mjs: one line per event, validated field by field. Anything outside the known
// keys is refused rather than dropped, so a changed reporter cannot smuggle prompt or transcript text in here.
const HOOK_KEYS=new Set(['method','v','app','event','sessionId','cwd','toolName','kind','launch','agentId','agentType']);
const HOOK_EVENTS={
  claude:new Set(['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','PostToolUseFailure','PermissionRequest','PermissionDenied','Notification','Stop','StopFailure','SubagentStart','SubagentStop','PreCompact','PostCompact','SessionEnd']),
  codex:new Set(['agent-turn-complete','SessionStart','UserPromptSubmit','Stop','SessionEnd']),
};
const HOOK_UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HOOK_KIND=/^[A-Za-z0-9_:-]{1,40}$/;
const HOOK_TAG=/^[0-9a-f-]{8,64}$/;
const HOOK_CONTROL=/[\p{Cc}\p{Cf}]/gu;
export function normalizeHook(request,line){
  if(typeof line==='string'&&line.length>4096)throw new Error('Hook event too large.');
  if(!request||typeof request!=='object'||Array.isArray(request))throw new Error('Invalid hook event.');
  if(Object.keys(request).some(key=>!HOOK_KEYS.has(key)))throw new Error('Unexpected hook field.');
  if(request.v!==1)throw new Error('Unsupported hook version.');
  const {app,event}=request;
  if(!Object.hasOwn(HOOK_EVENTS,app))throw new Error('Invalid hook app.');
  if(typeof event!=='string'||!HOOK_EVENTS[app].has(event))throw new Error('Unknown hook event.');
  const sessionId=typeof request.sessionId==='string'?request.sessionId.toLowerCase():'';
  if(!HOOK_UUID.test(sessionId))throw new Error('Invalid hook session id.');
  const cwd=typeof request.cwd==='string'&&request.cwd.length<=1024&&path.isAbsolute(request.cwd)&&!request.cwd.includes('\0')&&path.normalize(request.cwd)===request.cwd?request.cwd:null;
  const toolName=typeof request.toolName==='string'?request.toolName.replace(HOOK_CONTROL,'').slice(0,120)||null:null;
  const kind=typeof request.kind==='string'&&HOOK_KIND.test(request.kind)?request.kind:null;
  const launch=typeof request.launch==='string'&&HOOK_TAG.test(request.launch)?request.launch:null;
  const child={};
  for(const [key,max] of [['agentId',200],['agentType',120]]){
    const value=request[key];
    if(value===undefined||value===null)continue;
    if(app!=='claude'||typeof value!=='string'||value.length>max||!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value))throw new Error(`Invalid hook ${key}.`);
    child[key]=value;
  }
  return {app,event,sessionId,cwd,toolName,kind,launch,...child};
}

export const defaultSocketPath=()=>`/tmp/summon-${process.getuid?.()??'local'}.sock`;
export async function createRpcServer(service,socketPath=defaultSocketPath(),{knowledge,searchKnowledge,workInFlight,agentSessions,workRecords,workRecovery,usage,pickEngine,onChange=()=>{},onHook=()=>{}}={}){
  // Work in flight reads can outlast the 10 s idle limit while repositories are scanned.
  const flight=(request,socket)=>{
    if(!workInFlight)throw new Error('Work in flight is not available in this Summon version.');
    if(request.projectId!==undefined&&request.projectId!==null&&(typeof request.projectId!=='string'||request.projectId.length>200))throw new Error('Invalid project id.');
    for(const key of ['includeFiles','force','privateNames'])if(request[key]!==undefined&&typeof request[key]!=='boolean')throw new Error(`Invalid ${key} option.`);
    if(request.reason!==undefined&&request.reason!=='cli')throw new Error('Invalid reason option.');
    socket.setTimeout(20000);return workInFlight;
  };
  try{
    const info=await lstat(socketPath);if(!info.isSocket()||info.uid!==process.getuid?.())throw new Error('Summon socket path is occupied by another file.');
    const running=await new Promise(resolve=>{const probe=net.connect(socketPath);probe.on('connect',()=>{probe.destroy();resolve(true);});probe.on('error',()=>resolve(false));});
    if(running)throw new Error('Another Summon context service is already running.');await unlink(socketPath);
  }catch(error){if(error.code!=='ENOENT')throw error;}
  const server=net.createServer(socket=>{
    let buffer='';socket.setTimeout(10000,()=>socket.destroy());
    socket.setEncoding('utf8');
    socket.on('error',()=>{});
    socket.on('data',async chunk=>{
      buffer+=chunk;if(Buffer.byteLength(buffer)>1024*1024){socket.destroy();return;}
      if(!buffer.includes('\n'))return;
      const line=buffer.slice(0,buffer.indexOf('\n'));buffer='';
      try{
        const request=JSON.parse(line);
        if(Buffer.byteLength(line)>32768&&!['work-items','work-item-update','work-item-checkpoint'].includes(request?.method))throw new Error('Request too large.');
        const snapshot=service.snapshot();let result;
        switch(request.method){
          case 'memory-search':if(!knowledge)throw new Error('Memory is not available in this Summon version.');result=await (searchKnowledge||knowledge.search)(request.query,{projectId:request.projectId,limit:request.limit});break;
          case 'remember':if(!knowledge)throw new Error('Memory is not available.');await knowledge.remember({text:request.text,projectId:request.projectId,source:'User request through connected agent'});result={saved:true};onChange();break;
          case 'routines':result=knowledge?.snapshot().routines||[];break;
          case 'context':result={currentProject:snapshot.projects.find(p=>p.id===snapshot.currentProjectId)||null,projects:snapshot.projects,activity:snapshot.activity,paused:snapshot.settings.paused,health:snapshot.health};break;
          case 'files':if(typeof request.query!=='string'||request.query.length>1000)throw new Error('Invalid search query.');result=await service.searchFiles(request.query);break;
          case 'activity':result=snapshot.events.slice(0,Math.max(1,Math.min(100,Number(request.limit)||20)));break;
          case 'file-history':if(typeof request.id!=='string')throw new Error('Missing file id.');result={file:snapshot.files.find(f=>f.id===request.id)||null,events:snapshot.events.filter(e=>e.fileId===request.id)};break;
          // Agent-facing reads withhold private file names; only the local terminal CLI asks for them (privateNames).
          case 'work-in-flight':result=await flight(request,socket).read({projectId:request.projectId||null,includeFiles:request.includeFiles,maxAgeMs:20000,maskPrivate:request.privateNames!==true});break;
          case 'work-in-flight-group':result={job:await flight(request,socket).group({repoId:request.projectId||null,force:request.force===true,reason:request.reason==='cli'?'cli':'agent'})};break;
          // Agent sessions over the socket: the redacted agent view only. Sessions are never opened from here.
          case 'agent-sessions':
            if(!agentSessions)throw new Error('Agent sessions are not available in this Summon version.');
            if(request.app!==undefined&&request.app!==null&&!['claude','codex','cursor','hermes'].includes(request.app))throw new Error('Invalid app option.');
            if(request.includeRecent!==undefined&&typeof request.includeRecent!=='boolean')throw new Error('Invalid includeRecent option.');
            result=await agentSessions.read({forAgent:true,maxAgeMs:3000,app:request.app??null,includeRecent:request.includeRecent===true});break;
          // Structured work records only: the agent boundary cannot confirm completion or change repository files.
          case 'work-recovery':{
            const {method,...options}=request;
            validateWorkRecoveryRequest(options);
            if(!workRecovery)throw new Error('Work recovery is not available in this Summon version. Rebuild and reopen Summon.');
            socket.setTimeout(20000);
            result=await workRecovery.read(options);
            break;
          }
          case 'work-items':
          case 'work-item-update':
          case 'work-item-checkpoint':{
            if(!workRecords)throw new Error('Durable work records are not available in this Summon version.');
            const {method,...options}=request;
            socket.setTimeout(20000);
            if(method==='work-item-checkpoint'&&typeof workRecords.checkpointWorkItem!=='function')throw new Error('Work checkpoints are not available in this Summon version. Rebuild and reopen Summon.');
            result=method==='work-items'?await workRecords.readWorkItems(options):method==='work-item-checkpoint'?await workRecords.checkpointWorkItem(options):await workRecords.updateWorkItem(options);
            if(method!=='work-items')onChange();
            break;
          }
          case 'select-project':await service.selectProject(request.id);result=service.snapshot().projects.find(p=>p.id===request.id)||null;break;
          // A session reporting on itself. Accepted events reach the ledger only; nothing is opened, launched or read back.
          case 'hook':{
            const event=normalizeHook(request,line);
            if(typeof agentSessions?.noteHook!=='function')throw new Error('Hooks are not available in this Summon version.');
            await agentSessions.noteHook(event);result={accepted:true};onHook();break;
          }
          // The usage meter over the socket: the last reading, or a fresh one when asked (two bounded CLI reads, about a second).
          case 'usage':{
            if(!usage)throw new Error('The usage meter is not available in this Summon version.');
            if(request.refresh!==undefined&&typeof request.refresh!=='boolean')throw new Error('Invalid refresh option.');
            if(request.provider!==undefined&&request.provider!==null&&!['claude','codex'].includes(request.provider))throw new Error('Invalid provider option.');
            if(request.refresh===true)socket.setTimeout(20000);
            result=request.refresh===true?await usage.refresh(request.provider??undefined):usage.status();break;
          }
          // Which engine a task should use, from the meter's last reading: a fixed rule, no model, and it starts nothing.
          case 'pick-engine':{
            if(typeof pickEngine!=='function')throw new Error('Engine choice is not available in this Summon version.');
            if(request.task!==undefined&&(typeof request.task!=='string'||request.task.length>500))throw new Error('Invalid task option.');
            if(request.engine!==undefined&&request.engine!==null&&!['claude','codex','auto'].includes(request.engine))throw new Error('Invalid engine option.');
            const choice=pickEngine({engine:request.engine??'auto',...(request.task?{text:request.task}:{})});
            result={engine:choice.engine,reason:choice.reason,...(choice.profile?{profile:choice.profile,effort:choice.effort}:{}),usage:usage?usage.status():null};break;
          }
          default:throw new Error('Unsupported operation.');
        }
        socket.end(JSON.stringify({result})+'\n');
      }catch(error){socket.end(JSON.stringify({error:error.message})+'\n');}
    });
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});await chmod(socketPath,0o600);
  return async()=>{await new Promise(resolve=>server.close(resolve));await unlink(socketPath).catch(()=>{});};
}
