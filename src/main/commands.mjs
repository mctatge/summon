export function classifyCommand(raw,projects=[]) {
  if(typeof raw!=='string'||raw.length>4000)throw new Error('Use a command under 4,000 characters.');
  const text=raw.trim();
  const normalized=text.toLowerCase().replace(/[?!.,]+$/g,'').trim();
  if(!normalized)return {type:'empty'};
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

export async function executeCommand(raw,{service,openCalendar,openBenchmark,fetchBenchmark,openFile}) {
  const action=classifyCommand(raw,service.snapshot().projects);
  switch(action.type){
    case 'empty':return {kind:'message',message:'Try “find my Excel file” or “open my calendar”.'};
    case 'calendar':await openCalendar();return {kind:'message',message:'Opened your calendar.'};
    case 'benchmark-open':await openBenchmark();return {kind:'message',message:'Opened AI Stupid Level.'};
    case 'benchmark':{const data=await fetchBenchmark(action.category);return {kind:'benchmark',failed:Boolean(data.error),message:data.error||`AI Stupid Level · ${action.category} · checked ${new Date(data.fetchedAt).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}`};}
    case 'project':{await service.selectProject(action.projectId);return {kind:'context',projectId:action.projectId,message:`Working on ${service.snapshot().projects.find(p=>p.id===action.projectId)?.name}.`};}
    case 'unknown-project':return {kind:'message',message:`“${action.name}” is not a saved workspace yet. Use Add workspace to choose its folder.`};
    case 'context':{const snapshot=service.snapshot();const p=snapshot.projects.find(p=>p.id===snapshot.currentProjectId);return {kind:'context',message:p?`Selected project: ${p.name}. ${snapshot.activity?`Last observed app: ${snapshot.activity.app}.`:''}`:'No project selected. Choose one above; observed activity is only a clue.'};}
    case 'pause':await service.updateSettings({paused:true});return {kind:'message',message:'Activity collection paused. Your existing file history remains searchable.'};
    case 'resume':await service.updateSettings({paused:false});return {kind:'message',message:'Activity collection resumed.'};
    case 'files':{const files=await service.searchFiles(action.query);if(action.open&&files.length===1){await openFile(files[0].id);return {kind:'files',fileIds:[files[0].id],message:`Opened ${files[0].name}.`};}return {kind:'files',fileIds:files.map(f=>f.id),message:files.length?`Found ${files.length} matching ${files.length===1?'file':'files'}. ${action.open?'Choose the one to open.':'Most recent first.'}`:'No matching files in the watched folders or filing history.'};}
    default:return {kind:'unknown',message:'This needs interpretation. Interpret it locally, ask Claude or Codex, or try a saved routine.'};
  }
}
