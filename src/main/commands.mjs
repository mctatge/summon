// Launch grammar is deliberately bounded: [for/in <saved workspace>] [using <Claude family>] [to <task>].
// Resolve whole workspace names as well as suffix parses, and refuse when those interpretations disagree.
function sessionOptions(suffix,app,projects){
  const invalid=()=>({type:'invalid-launch-options'});
  const parseOptions=text=>{
    if(!text)return {};
    const task=text.match(/^to\s+(.+)$/i);
    if(task)return {task:task[1].trim()};
    const model=text.match(/^using\s+(haiku|sonnet|opus)(?:\s+to\s+(.+))?$/i);
    return model?{modelPreference:model[1].toLowerCase(),...(model[2]?{task:model[2].trim()}:{})}:null;
  };
  const valid=options=>options&&(options.task===undefined||(options.task.length>0&&options.task.length<=1000&&!/[\p{Cc}]/u.test(options.task)))&&!(app==='codex'&&options.modelPreference);
  const workspace=suffix.match(/^(?:in|for)\s+(.+)$/i);
  if(!workspace){
    const options=parseOptions(suffix);
    return valid(options)?{type:'agent-launch',app,...options}:invalid();
  }
  const rest=workspace[1].trim();
  const parses=[{name:rest,options:{}}];
  for(const match of rest.matchAll(/\s+(?=using\s|to\s)/gi)){
    const options=parseOptions(rest.slice(match.index).trim());
    if(options)parses.push({name:rest.slice(0,match.index).trim(),options});
  }
  const candidates=parses.map(parse=>({...parse,matches:projects.filter(project=>typeof project.name==='string'&&project.name.toLowerCase().trim()===parse.name.toLowerCase())})).filter(parse=>parse.matches.length);
  if(candidates.length>1)return {type:'ambiguous-launch-options'};
  if(candidates.length===0)return {type:'unknown-launch-project',name:(parses[1]??parses[0]).name.toLowerCase()};
  const chosen=candidates[0];
  if(chosen.matches.length>1)return {type:'ambiguous-launch-project',name:chosen.name.toLowerCase()};
  if(!valid(chosen.options))return invalid();
  return {type:'agent-launch',app,projectId:chosen.matches[0].id,...chosen.options};
}

export function classifyCommand(raw,projects=[]) {
  if(typeof raw!=='string'||raw.length>4000)throw new Error('Use a command under 4,000 characters.');
  const text=raw.trim();
  const normalized=text.toLowerCase().replace(/[?!.,]+$/g,'').trim();
  if(!normalized)return {type:'empty'};
  const launchMatch=text.replace(/[?!.,]+$/g,'').trim().match(/^(?:please\s+)?(?:start|open|launch)\s+(?:(?:a\s+)?(?:new\s+)?(claude(?:\s+code)?|codex)\s+session|(?:a\s+)?(?:new\s+)?session\s+in\s+(claude(?:\s+code)?|codex))(?:\s+(.+))?$/i);
  if(launchMatch){
    const app=(launchMatch[1]||launchMatch[2]).toLowerCase().startsWith('claude')?'claude':'codex';
    return sessionOptions(launchMatch[3]?.trim()??'',app,projects);
  }
  if(/^(?:please\s+)?(?:open|show|pull up|bring up|launch)(?: me)?(?: my| the)? calendar$/.test(normalized))return {type:'calendar'};
  if(/^(?:what(?:'s| is) (?:on )?my calendar|calendar|my schedule|show my schedule)$/.test(normalized))return {type:'calendar'};
  if(/^(?:open|show|pull up|launch) (?:ai stupid level|stupid meter|the benchmark(?: site)?)$/.test(normalized))return {type:'benchmark-open'};
  if(/\b(best|top|rankings?|leaderboard|check)\b/.test(normalized)&&/\b(model|models|benchmark|ai stupid level|stupid meter)\b/.test(normalized))return {type:'benchmark',category:/\bcoding|code\b/.test(normalized)?'coding':/\breasoning\b/.test(normalized)?'reasoning':/\bspeed|fastest\b/.test(normalized)?'speed':'combined'};
  const projectMatch=normalized.match(/^(?:i(?:'m| am) working on|working on|switch to|set project to|work on)\s+(.+)$/);
  if(projectMatch){const name=projectMatch[1].trim();const project=projects.find(p=>p.name.toLowerCase()===name||p.name.toLowerCase().replace(/\s/g,'')===name.replace(/\s/g,''));return project?{type:'project',projectId:project.id}:{type:'unknown-project',name};}
  if(/^(?:what am i working on|current (?:project|context)|show (?:my )?context)$/.test(normalized))return {type:'context'};
  if(/^(?:pause|stop) (?:watching|activity|observation|tracking)$/.test(normalized))return {type:'pause'};
  if(/^(?:resume|start) (?:watching|activity|observation|tracking)$/.test(normalized))return {type:'resume'};
  if(/\b(file|files|workbook|workbooks|excel|download|downloads|spreadsheet|spreadsheets|pdf|screenshot)\b/.test(normalized)||/\.(xlsx?|csv|pdf|docx?|pptx?|png|jpe?g|zip|md)\b/i.test(normalized)||/^(?:find|search for|where is|where did)\b/.test(normalized))return {type:'files',query:text,open:/^(?:open|pull up|bring up)\b/.test(normalized)};
  return {type:'unknown',text};
}

export async function executeCommand(raw,{service,openCalendar,openBenchmark,fetchBenchmark,openFile,launchAgent}) {
  const snapshot=service.snapshot();
  const action=classifyCommand(raw,snapshot.projects);
  switch(action.type){
    case 'empty':return {kind:'message',message:'Try “find my Excel file” or “open my calendar”.'};
    case 'agent-launch':{
      const projectId=action.projectId??snapshot.currentProjectId;
      const project=snapshot.projects.find(item=>item.id===projectId);
      if(!project)return {kind:'message',message:'Choose a workspace first, or name a saved workspace in the session command.'};
      if(typeof launchAgent!=='function')throw new Error('Starting agent sessions is unavailable.');
      const receipt=await launchAgent({app:action.app,projectId:project.id,...(action.task?{task:action.task}:{}),...(action.modelPreference?{modelPreference:action.modelPreference}:{})});
      const selection=receipt?.modelSelection;
      const model=selection?.name||selection?.model;
      const modelMessage=[model?`Recommended model: ${model}.`:'',selection?.reason||''].filter(Boolean).join(' ');
      const routing=receipt?.routing;
      const routingMessage=routing?`Task routing: ${routing.kind}, ${routing.complexity} complexity; ${routing.effort} effort${routing.effortSource==='override'?' (your override)':''}. ${routing.reason}`:'';
      return {kind:'message',...(selection?.source?{benchmarkSource:true}:{}),message:[`Started a new ${action.app==='claude'?'Claude':'Codex'} session in ${project.name}.`,modelMessage,routingMessage,action.task?'The task was used only to choose model and effort. Enter it in the new session to begin.':''].filter(Boolean).join(' ')};
    }
    case 'invalid-launch-options':return {kind:'message',message:'Use “start a new Claude session for Workspace using sonnet to describe the task”. The model choice is optional and Claude-only; keep the task to one line and at most 1,000 characters.'};
    case 'ambiguous-launch-options':return {kind:'message',message:'That workspace name overlaps the session options. Select the workspace first, then ask to start a session without naming it.'};
    case 'unknown-launch-project':return {kind:'message',message:`“${action.name}” is not a saved workspace yet. Use Add workspace to choose its folder.`};
    case 'ambiguous-launch-project':return {kind:'message',message:`More than one saved workspace is named “${action.name}”. Select the workspace first, then ask to start a session.`};
    case 'calendar':await openCalendar();return {kind:'message',message:'Opened your calendar.'};
    case 'benchmark-open':await openBenchmark();return {kind:'message',message:'Opened AI Stupid Level.'};
    case 'benchmark':{const data=await fetchBenchmark(action.category);return {kind:'benchmark',failed:Boolean(data.error),message:data.error||`AI Stupid Level · ${data.category||action.category} ranking · checked ${new Date(data.fetchedAt).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}`,...(data.notice?{warning:data.notice}:{})};}
    case 'project':{await service.selectProject(action.projectId);return {kind:'context',projectId:action.projectId,message:`Working on ${service.snapshot().projects.find(p=>p.id===action.projectId)?.name}.`};}
    case 'unknown-project':return {kind:'message',message:`“${action.name}” is not a saved workspace yet. Use Add workspace to choose its folder.`};
    case 'context':{const snapshot=service.snapshot();const p=snapshot.projects.find(p=>p.id===snapshot.currentProjectId);return {kind:'context',message:p?`Selected project: ${p.name}. ${snapshot.activity?`Last observed app: ${snapshot.activity.app}.`:''}`:'No project selected. Choose one above; observed activity is only a clue.'};}
    case 'pause':await service.updateSettings({paused:true});return {kind:'message',message:'Activity collection paused. Your existing file history remains searchable.'};
    case 'resume':await service.updateSettings({paused:false});return {kind:'message',message:'Activity collection resumed.'};
    case 'files':{const files=await service.searchFiles(action.query);if(action.open&&files.length===1){await openFile(files[0].id);return {kind:'files',fileIds:[files[0].id],message:`Opened ${files[0].name}.`};}return {kind:'files',fileIds:files.map(f=>f.id),message:files.length?`Found ${files.length} matching ${files.length===1?'file':'files'}. ${action.open?'Choose the one to open.':'Most recent first.'}`:'No matching files in the watched folders or filing history.'};}
    default:return {kind:'unknown',message:'This needs interpretation. Interpret it locally, ask Claude or Codex, or try a saved routine.'};
  }
}
