import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {restrictedCodexArgs,claudeFailure} from './engines.mjs';
import {executable as defaultExecutable,run as defaultRun,scrubbedEnv as defaultScrubbedEnv} from './process.mjs';

const ENGINES=['codex','claude'],EFFORTS=['low','medium','high'],CLAUDE_MODELS=['opus','sonnet','haiku'],PROMPT_BYTES=400_000;
const SYSTEM_PROMPT='You sort code changes into plain-language workstreams. No tools or actions.';
// Models sometimes wrap JSON in a Markdown fence even when a schema is enforced.
const parseAnswer=(text,who)=>{
  if(typeof text!=='string'||!text.trim())throw new Error(`${who} returned no grouping. Try again.`);
  const body=text.trim().replace(/^```(?:json)?\s*\n?/i,'').replace(/\n?```\s*$/,'');
  try{return JSON.parse(body);}catch{throw new Error(`${who} returned a grouping Summon could not read. Try again.`);}
};
const checked=(engine,effort,claudeModel)=>{
  if(!ENGINES.includes(engine))throw new Error('Choose Codex or Claude for grouping.');
  if(!EFFORTS.includes(effort))throw new Error('Grouping effort must be low, medium or high.');
  if(!CLAUDE_MODELS.includes(claudeModel))throw new Error('Claude model must be opus, sonnet or haiku.');
};

/** Restricted, tool-less CLI arguments for one structured grouping answer. */
export function groupingArgs(engine,{schemaPath,schemaJson,effort='medium',claudeModel='opus'}={}){
  checked(engine,effort,claudeModel);
  if(engine==='codex'){
    if(typeof schemaPath!=='string'||!path.isAbsolute(schemaPath))throw new Error('The grouping answer format is missing.');
    const args=restrictedCodexArgs(),stdin=args.lastIndexOf('-');
    args.splice(stdin<0?args.length:stdin,0,'--output-schema',schemaPath,'-c',`model_reasoning_effort="${effort}"`);
    return args;
  }
  if(typeof schemaJson!=='string'||!schemaJson)throw new Error('The grouping answer format is missing.');
  return ['-p','--safe-mode','--model',claudeModel,'--effort',effort,'--max-turns','1','--output-format','json','--json-schema',schemaJson,'--tools','','--permission-mode','dontAsk','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--setting-sources','','--no-session-persistence','--disable-slash-commands','--system-prompt',SYSTEM_PROMPT];
}

/** Runs one grouping request through the installed CLI in an empty temporary folder. Never passes API keys or repository access. */
export async function runGrouping(engine,{prompt,schema,effort='medium',claudeModel='opus'}={},{executable=defaultExecutable,run=defaultRun,scrubbedEnv=defaultScrubbedEnv,tmp=tmpdir()}={}){
  checked(engine,effort,claudeModel);
  if(typeof prompt!=='string'||!prompt.trim())throw new Error('The grouping request is empty.');
  if(Buffer.byteLength(prompt)>PROMPT_BYTES)throw new Error('The grouping request is too large. Try one project at a time.');
  if(!schema||typeof schema!=='object'||Array.isArray(schema))throw new Error('The grouping answer format is missing.');
  const schemaJson=JSON.stringify(schema),cwd=await mkdtemp(path.join(tmp,'summon-group-')),schemaPath=path.join(cwd,'grouping-schema.json');
  try{
    const binary=await executable(engine);
    if(engine==='codex')await writeFile(schemaPath,schemaJson,{mode:0o600,flag:'wx'});
    const args=groupingArgs(engine,{schemaPath,schemaJson,effort,claudeModel});
    const result=await run(binary,args,{cwd,input:prompt,timeout:300000,maxBytes:4_000_000,env:scrubbedEnv()}).catch(error=>{throw engine==='claude'?claudeFailure(error):error;});
    if(engine==='claude'){
      let parsed;try{parsed=JSON.parse(result.stdout);}catch{throw new Error('Claude returned a grouping Summon could not read. Try again.');}
      if(!parsed||typeof parsed!=='object')throw new Error('Claude returned a grouping Summon could not read. Try again.');
      if(parsed.is_error)throw claudeFailure(Object.assign(new Error('Claude could not group the changes. Check your CLI login.'),{stdout:result.stdout}));
      const raw=parsed.structured_output&&typeof parsed.structured_output==='object'?parsed.structured_output:parseAnswer(parsed.result,'Claude');
      if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Claude returned a grouping Summon could not read. Try again.');
      return {raw,model:claudeModel};
    }
    const events=String(result.stdout||'').split('\n').flatMap(line=>{try{const value=JSON.parse(line);return value&&typeof value==='object'?[value]:[];}catch{return [];}});
    const messages=events.filter(e=>e.type==='item.completed'&&e.item?.type==='agent_message'&&typeof e.item.text==='string'&&e.item.text.trim()).map(e=>e.item.text);
    if(!messages.length){const failure=events.findLast(e=>e.type==='error'||e.type==='turn.failed');throw new Error(String(failure?.message||failure?.error?.message||'Codex returned no grouping. Check your CLI login.').slice(0,600));}
    const raw=parseAnswer(messages.at(-1),'Codex');
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Codex returned a grouping Summon could not read. Try again.');
    const model=events.map(e=>e.model??e.session?.model??e.config?.model).find(value=>typeof value==='string'&&value.length<=100)??null;
    return {raw,model};
  }finally{await rm(cwd,{recursive:true,force:true});}
}
