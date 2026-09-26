import React, {useState} from 'react';
import type {SummonBridge, RoutedAnswer, RoutePreview, RoutingOptions, UsageProvider} from './types';

export function AskRoutingControls({bridge,text,busy,run,onAnswer,onPending}:{bridge:SummonBridge;text:string;busy:boolean;run:(task:()=>Promise<unknown>,lock?:boolean)=>Promise<boolean>;onAnswer:(reply:RoutedAnswer)=>void;onPending:(engine:string)=>void}){
  const [effort,setEffort]=useState<RoutingOptions['effort']>('auto');
  const [route,setRoute]=useState<RoutePreview|null>(null);
  const [historyNote,setHistoryNote]=useState('');
  const ask=(engine:UsageProvider|'auto')=>run(async()=>{onPending(engine);onAnswer(await bridge.ask(engine,text,{effort}));},true);
  return <div className="routing-controls">
    <div className="agent-actions">
      <label>Reasoning effort <select aria-label="Reasoning effort" disabled={busy} value={effort} onChange={event=>{setEffort(event.target.value as RoutingOptions['effort']);setRoute(null);}}><option value="auto">Auto · based on task</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
      <button className="text-button" disabled={busy} onClick={()=>void run(async()=>setRoute(await bridge.routePreview('auto',text,{effort})),true)}>Check Auto route</button>
    </div>
    {route&&<p className="agent-explainer" role="status"><strong>{route.engine==='claude'?'Claude':'Codex'} · {route.effort} effort{route.model?` · ${route.model}`:''}</strong><br/>{route.reason}<br/>{route.history.rated} rated answers in local routing history.{route.history.problem?` ${route.history.problem}`:''}</p>}
    <div className="agent-actions">
      <button className="button small-button" disabled={busy} onClick={()=>void ask('auto')}>Ask Auto</button>
      <button className="button small-button" disabled={busy} onClick={()=>void ask('claude')}>Ask Claude</button>
      <button className="button small-button" disabled={busy} onClick={()=>void ask('codex')}>Ask Codex</button>
      <span>Uses your CLI login</span>
    </div>
    <p className="preference-note">Routing runs on this Mac. It learns from your ratings; the routing history keeps categories and timing for 30 days, without questions or answers. Checking a route may refresh public model rankings and CLI availability; it runs no model turn.</p>
    <button className="text-button" disabled={busy} onClick={()=>void run(async()=>{const result=await bridge.clearRoutingHistory();setRoute(null);setHistoryNote(result.problem||'Routing history cleared. Auto will use task rules and quota.');},true)}>Clear routing history</button>
    {historyNote&&<p className="preference-note" role="status">{historyNote}</p>}
  </div>;
}

export function RoutingFeedback({bridge,id}:{bridge:SummonBridge;id:string}){
  const [rating,setRating]=useState(''),[error,setError]=useState(''),[saving,setSaving]=useState(false);
  const rate=async(value:'useful'|'not-useful')=>{setSaving(true);setError('');try{const result=await bridge.routeFeedback(id,value);if(result.problem)setError(result.problem);else setRating(value);}catch(error){setError(error instanceof Error?error.message:String(error));}finally{setSaving(false);}};
  return <div className="agent-actions" aria-label="Rate this answer for routing"><span>Did this route work?</span><button className="text-button" aria-pressed={rating==='useful'} disabled={saving} onClick={()=>void rate('useful')}>Useful</button><button className="text-button" aria-pressed={rating==='not-useful'} disabled={saving} onClick={()=>void rate('not-useful')}>Not useful</button>{rating&&<span role="status">Rating saved locally</span>}{error&&<span role="alert">{error}</span>}</div>;
}
