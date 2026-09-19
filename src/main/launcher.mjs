import {realpath,lstat,stat,mkdir,writeFile,chmod,readdir,unlink,readFile,rename,open,access} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {sealedPath} from '../core/workstreams.mjs';

// Starts `claude` or `codex` in Terminal for a workspace, on a click and nothing else. Each launch writes one small
// 0700 .command file under the data folder and opens it with `open -a Terminal`, the same shape as claude-login.
// Terminal inherits launchd's environment rather than scrubbedEnv(), so the script unsets provider keys itself and
// every path it needs is hard-coded, quoted, into the file. Sign-in stays with the CLIs; no key or token is passed.
// Per-session flags only: `--session-id` + `--settings <data>/claude-hooks.json` for Claude, `-c notify=[...]` for
// Codex. Summon never edits ~/.claude/settings.json, ~/.claude.json or ~/.codex/config.toml from here; the one
// explicit button, installClaudeHooks(), merges into settings.json after a byte-identical backup.

const APPS=new Set(['claude','codex']);
const HOOK_EVENTS=['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','PermissionRequest','Notification','Stop','StopFailure','SessionEnd'];
const NOTIFICATION_KINDS='permission_prompt|worker_permission_prompt|idle_prompt|agent_needs_input|elicitation_dialog|elicitation_url_dialog';
const UNSET='unset ANTHROPIC_API_KEY OPENAI_API_KEY CODEX_API_KEY CLAUDECODE NODE_OPTIONS';
const HEADER='#!/bin/zsh\n# Written by Summon for one launch; safe to delete.\nset -eu\n'+UNSET+'\n';
const MAX_CONFIG_BYTES=1024*1024;
const LAUNCH_TTL_MS=24*3600*1000;
const LAUNCH_PRUNE_MAX=100;
const isObject=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const listOf=value=>Array.isArray(value)?value:[];
// Single quotes for zsh: every embedded quote becomes '\'' and nothing else is special inside.
const sh=s=>"'"+s.replace(/'/g,"'\\''")+"'";
// TOML basic strings escape " and \ exactly as JSON does; control characters are refused before this is reached.
const toml=s=>JSON.stringify(s);
const CONTROL=/[\p{Cc}]/u;
const inside=(candidate,root)=>{const base=root.length>1?root.replace(/\/+$/,''):root;return candidate===base||candidate.startsWith(base.endsWith(path.sep)?base:`${base}${path.sep}`);};
const stamp=date=>`${date.getFullYear()}${String(date.getMonth()+1).padStart(2,'0')}${String(date.getDate()).padStart(2,'0')}-${String(date.getHours()).padStart(2,'0')}${String(date.getMinutes()).padStart(2,'0')}${String(date.getSeconds()).padStart(2,'0')}`;

async function readSmall(file){
  const info=await stat(file);
  if(!info.isFile()||info.size>MAX_CONFIG_BYTES)throw new Error('too large');
  return readFile(file,'utf8');
}
async function writePrivate(file,text,mode){
  await writeFile(file,text,{mode});
  await chmod(file,mode);
}
async function writeAtomic(file,text,mode){
  const tmp=`${file}.tmp-${process.pid}`;
  let handle;
  try{
    handle=await open(tmp,'w',mode);
    await handle.writeFile(text);await handle.sync();await handle.close();handle=null;
    await chmod(tmp,mode);
    await rename(tmp,file);
  }catch(error){
    if(handle)await handle.close().catch(()=>{});
    await unlink(tmp).catch(()=>{});
    throw error;
  }
}

/** Summon's hook entries for one `claude` session: the same reporter on every event Summon reads. */
export function claudeHooksSettings(nodeBin,reporterPath){
  // The reporter is silent and exits 0 on its own; the shell fallback keeps a moved app or a missing node from ever costing Claude anything.
  const command=`${sh(nodeBin)} ${sh(reporterPath)} claude 2>/dev/null || true`;
  const entry=timeout=>({hooks:[{type:'command',command,timeout}]});
  const hooks={};
  for(const event of HOOK_EVENTS){
    if(event==='Notification')hooks[event]=[{matcher:NOTIFICATION_KINDS,...entry(3)}];
    else hooks[event]=[entry(event==='SessionEnd'?1:3)];
  }
  return {hooks};
}
const ownEntry=entry=>isObject(entry)&&Array.isArray(entry.hooks)&&entry.hooks.length>0&&entry.hooks.every(hook=>isObject(hook)&&typeof hook.command==='string'&&hook.command.includes('/summon-hook.mjs'));

export function createLauncher({dataDir,homeDir,root,resourcesPath,isPackaged,run,executable,getProjects,agentSessions}){
  const resource=name=>isPackaged?path.join(resourcesPath,name):path.join(root,'scripts',name);
  const reporterPath=()=>resource('summon-hook.mjs');
  const mcpServerPath=()=>resource('mcp-server.mjs');
  const claudeSettingsFile=()=>path.join(homeDir,'.claude','settings.json');
  const hooksFile=path.join(dataDir,'claude-hooks.json');
  const mcpFile=path.join(dataDir,'claude-mcp.json');
  const launchDir=path.join(dataDir,'launch');

  /** Why a folder cannot have an agent started in it, or null. The vault is matched by workspace name and by path. */
  async function refusal(folderReal,projects){
    if(sealedPath(folderReal))return 'Summon does not start agents in sealed folders.';
    if(path.basename(folderReal).toLowerCase()==='second brain')return 'Summon does not start agents in the vault.';
    for(const project of listOf(projects)){
      if(!isObject(project)||typeof project.name!=='string'||project.name.toLowerCase()!=='second brain'||typeof project.path!=='string')continue;
      const vault=await realpath(project.path).catch(()=>project.path);
      if(inside(folderReal,vault)||inside(folderReal,project.path))return 'Summon does not start agents in the vault.';
    }
    return null;
  }
  // Read-only looks at the user's own config, keys only: is Summon's MCP server already there?
  async function claudeHasSummonMcp(){
    try{const json=JSON.parse(await readSmall(path.join(homeDir,'.claude.json')));return isObject(json)&&isObject(json.mcpServers)&&Object.hasOwn(json.mcpServers,'summon');}catch{return false;}
  }
  async function codexHasSummonMcp(){
    try{return /^\[mcp_servers\.summon\]\s*$/m.test(await readSmall(path.join(homeDir,'.codex','config.toml')));}catch{return false;}
  }
  async function prune(){
    let names=[];
    try{names=(await readdir(launchDir)).filter(name=>name.endsWith('.command')).slice(0,LAUNCH_PRUNE_MAX);}catch{return;}
    const cutoff=Date.now()-LAUNCH_TTL_MS;
    for(const name of names){
      const file=path.join(launchDir,name);
      try{const info=await lstat(file);if(info.isFile()&&info.mtimeMs<cutoff)await unlink(file);}catch{}
    }
  }

  async function launch({app,projectId}={}){
    if(!APPS.has(app))throw new Error('Choose Claude or Codex.');
    if(typeof projectId!=='string'||!projectId||projectId.length>200)throw new Error('Choose a workspace first.');
    const projects=listOf(await getProjects());
    const project=projects.find(item=>isObject(item)&&item.id===projectId);
    if(!project||typeof project.path!=='string')throw new Error('Choose a workspace first.');
    let real;
    try{real=await realpath(project.path);if(!(await lstat(real)).isDirectory())throw new Error('gone');}catch{throw new Error('That folder no longer exists.');}
    const why=await refusal(real,projects);
    if(why)throw new Error(why);
    if(CONTROL.test(real)||real.length>1024)throw new Error('That folder path cannot be used in a launch script.');
    const bin=await executable(app);
    const node=await executable('node').catch(()=>null);
    if(node!==null&&(CONTROL.test(node)||CONTROL.test(bin)||CONTROL.test(reporterPath())||CONTROL.test(mcpServerPath())||CONTROL.test(dataDir)))throw new Error('A program path cannot be used in a launch script.');
    const hooks=Boolean(node);
    const tag=randomUUID();
    const sessionId=app==='claude'?tag:null;
    // The row for this session says "Started from Summon" once the ledger knows the tag; a ledger problem never stops the launch.
    try{await agentSessions?.noteLaunch?.({app,tag,cwd:real,projectId:project.id,sessionId});}catch{}
    await mkdir(dataDir,{recursive:true,mode:0o700});
    let mcp='none';
    let exec;
    if(app==='claude'){
      const args=[sh(bin),'--session-id',sh(tag)];
      if(hooks){
        await writePrivate(hooksFile,`${JSON.stringify(claudeHooksSettings(node,reporterPath()),null,2)}\n`,0o600);
        args.push('--settings',sh(hooksFile));
      }
      if(await claudeHasSummonMcp())mcp='global';
      else if(hooks){
        await writePrivate(mcpFile,`${JSON.stringify({mcpServers:{summon:{type:'stdio',command:node,args:[mcpServerPath()]}}},null,2)}\n`,0o600);
        args.push('--mcp-config',sh(mcpFile));
        mcp='attached';
      }
      exec=`exec ${args.join(' ')}`;
    }else{
      const args=[sh(bin),'-C',sh(real)];
      if(hooks)args.push('-c',sh(`notify=[${[node,reporterPath(),'codex','--launch',tag].map(toml).join(',')}]`));
      if(await codexHasSummonMcp())mcp='global';
      else if(hooks){
        args.push('-c',sh(`mcp_servers.summon.command=${toml(node)}`),'-c',sh(`mcp_servers.summon.args=[${toml(mcpServerPath())}]`));
        mcp='attached';
      }
      exec=`exec ${args.join(' ')}`;
    }
    const script=`${HEADER}cd ${sh(real)}\n${exec}\n`;
    await mkdir(launchDir,{recursive:true,mode:0o700});
    await chmod(launchDir,0o700);
    // Terminal titles the window after the file, so the workspace name goes in it (ASCII only; an em dash becomes a dash).
    const safeName=String(project.name??path.basename(real)).replace(/[^\w .-]/g,'-').slice(0,40).trim()||app;
    const file=path.join(launchDir,`${app}-${safeName}-${tag.slice(0,8)}.command`);
    await writePrivate(file,script,0o700);
    await prune();
    await run('/usr/bin/open',['-a','Terminal',file]);
    return {app,tag,sessionId,folder:real,hooks,mcp};
  }

  async function readSettings(){
    const file=claudeSettingsFile();
    let raw=null;
    try{raw=await readSmall(file);}catch(error){if(error.code!=='ENOENT')throw new Error('settings.json could not be read; nothing was changed');}
    if(raw===null)return {file,raw:null,json:{}};
    let json;
    try{json=JSON.parse(raw);}catch{throw new Error('settings.json could not be read; nothing was changed');}
    if(!isObject(json))throw new Error('settings.json could not be read; nothing was changed');
    return {file,raw,json};
  }
  async function currentHooks(){
    const node=await executable('node');
    const reporter=reporterPath();
    await access(reporter);
    return claudeHooksSettings(node,reporter).hooks;
  }

  /** The Preferences button: merge Summon's hooks into ~/.claude/settings.json after a byte-identical backup. Click only. */
  async function installClaudeHooks(){
    const {file,raw,json}=await readSettings();
    const fresh=await currentHooks();
    const hooks=isObject(json.hooks)?{...json.hooks}:{};
    for(const event of Object.keys(fresh)){
      // Summon's own older entries go; everything else in the list, and every other key in the file, stays as it was.
      hooks[event]=[...listOf(hooks[event]).filter(entry=>!ownEntry(entry)),...fresh[event]];
    }
    const text=`${JSON.stringify({...json,hooks},null,2)}\n`;
    if(raw===text)return {installed:true,backup:null,events:Object.keys(fresh)};
    let backup=null;
    if(raw!==null){
      backup=`${file}.summon-backup-${stamp(new Date())}`;
      await writePrivate(backup,raw,0o600);
    }
    await mkdir(path.dirname(file),{recursive:true,mode:0o700});
    await writeAtomic(file,text,0o600);
    return {installed:true,backup,events:Object.keys(fresh)};
  }

  /** Whether settings.json carries Summon's hooks, and whether they still point at the node and reporter Summon would write now. */
  async function hookStatus(){
    let json;
    try{json=(await readSettings()).json;}catch{return {claude:{installed:false,current:false}};}
    const hooks=isObject(json.hooks)?json.hooks:{};
    const installed=Object.values(hooks).some(list=>listOf(list).some(ownEntry));
    let current=false;
    if(installed){
      try{
        const fresh=await currentHooks();
        current=Object.entries(fresh).every(([event,[want]])=>listOf(hooks[event]).some(entry=>ownEntry(entry)&&entry.hooks[0].command===want.hooks[0].command&&(want.matcher===undefined||entry.matcher===want.matcher)));
      }catch{current=false;}
    }
    return {claude:{installed,current}};
  }

  return {launch,refusal,installClaudeHooks,hookStatus,claudeHooksSettings};
}
