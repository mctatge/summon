import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ChefHat, CircleAlert, Folder, Pause, Play, RotateCcw, Route } from 'lucide-react';
import type { AgentSession } from './types';
import { createKitchenScene } from './kitchen-scene';
import './kitchen-scene.css';

type Props = {
  sessions: AgentSession[];
  selected: string | null;
  paused: boolean;
  scopeLabel?: string;
  onPausedChange: (paused: boolean) => void;
  onSelect: (session: AgentSession) => void;
  onTrace: (session: AgentSession) => void;
};
const PAGE_SIZE = 6;
const COLORS = ['#df5949', '#489bcc', '#64a14b', '#eab73f', '#a079bf', '#e58e36'];
const activityLabel: Record<AgentSession['activity'], string> = {
  working: 'Cooking', 'needs-you': 'Needs you', failed: 'Stopped with a problem',
  open: 'Your move', quiet: 'Resting', interrupted: 'Interrupted', unknown: 'State unavailable',
};

/** The room illustrates existing session state. It neither observes agents nor infers completed work. */
export default function KitchenScene({ sessions, selected, paused, scopeLabel = 'all projects', onPausedChange, onSelect, onTrace }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const room = useRef<ReturnType<typeof createKitchenScene> | null>(null);
  const current = useRef({ sessions, onSelect });
  current.current = { sessions, onSelect };
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [problem, setProblem] = useState('');
  const [retry, setRetry] = useState(0);
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(sessions.length / PAGE_SIZE));
  const activePage = Math.min(page, pageCount - 1);
  const visible = useMemo(() => sessions.slice(activePage * PAGE_SIZE, (activePage + 1) * PAGE_SIZE), [sessions, activePage]);
  const selectedSession = sessions.find(session => session.key === selected);
  const selectedIndex = sessions.findIndex(session => session.key === selected);
  const selectedPage = selectedIndex < 0 ? -1 : Math.floor(selectedIndex / PAGE_SIZE);
  const working = sessions.filter(session => session.activity === 'working').length;
  const waiting = sessions.filter(session => session.activity === 'needs-you').length;

  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setReduced(preference.matches);
    preference.addEventListener('change', change);
    return () => preference.removeEventListener('change', change);
  }, []);

  useEffect(() => {
    if (!host.current) return;
    let active = true;
    try {
      room.current = createKitchenScene(host.current, {
        onSelect(key) {
          const session = current.current.sessions.find(item => item.key === key);
          if (session) current.current.onSelect(session);
        },
        onError(message) { if (active) setProblem(message); },
      });
    } catch {
      setProblem('The 3D renderer could not start. Your session list is still available below.');
    }
    return () => { active = false; room.current?.dispose(); room.current = null; };
  }, [retry]);

  useEffect(() => { room.current?.update(visible, selected); }, [visible, selected, retry]);
  useEffect(() => { room.current?.setPaused(paused); }, [paused, retry]);
  useEffect(() => { room.current?.setReducedMotion(reduced); }, [reduced, retry]);

  // A selection arriving from another view reveals its cook. Paging itself never changes the selected session.
  useEffect(() => {
    if (selectedPage >= 0) setPage(selectedPage);
  }, [selected, selectedPage]);

  return <div className="ks-kitchen">
    <div className="ks-toolbar">
      <div className="ks-room-state"><ChefHat size={16} aria-hidden="true" /><strong>{working} cooking</strong><span>{waiting ? `${waiting} need${waiting === 1 ? 's' : ''} you` : `${sessions.length} session${sessions.length === 1 ? '' : 's'}`}</span></div>
      <div className="ks-controls">
        <button type="button" className="vw-button" disabled={Boolean(problem) || reduced} aria-pressed={paused || reduced} onClick={() => onPausedChange(!paused)} title={reduced ? 'Your macOS reduced-motion preference is enabled' : 'Pause the illustration; session states keep updating'}>{paused || reduced ? <Play size={13} /> : <Pause size={13} />}{reduced ? 'Reduced motion' : paused ? 'Resume animation' : 'Pause animation'}</button>
        <button type="button" className="vw-button" disabled={Boolean(problem)} onClick={() => room.current?.resetCamera()} aria-label="Reset kitchen camera" title="Reset kitchen camera"><RotateCcw size={14} /></button>
      </div>
    </div>
    <div className={`ks-stage ${problem ? 'ks-failed' : ''}`}>
      <div className="ks-canvas-host" ref={host} role="img" aria-label="Interactive 3D kitchen showing the sessions listed below. Drag to orbit, scroll to zoom, or select a chef. Keyboard users can select the same session from its ticket below." />
      {problem && <div className="ks-fallback" role="status"><CircleAlert size={24} /><strong>The 3D kitchen is unavailable</strong><p>{problem}</p><button type="button" className="vw-button" onClick={() => { setProblem(''); setRetry(value => value + 1); }}>Try 3D again</button></div>}
      {!problem && <div className="ks-camera-hint" aria-hidden="true">Drag to orbit <span>·</span> Scroll to zoom <span>·</span> Pick a chef</div>}
      {!problem && (paused || reduced) && <div className="ks-motion-badge">{reduced ? 'Reduced motion' : 'Animation paused'} · states still update</div>}
      {!sessions.length && !problem && <div className="ks-empty-note"><strong>The kitchen is quiet.</strong><span>{scopeLabel.toLowerCase() === 'all projects' ? 'Sessions across all projects and folders appear here when Summon detects them.' : `Sessions in ${scopeLabel} appear here when Summon detects them.`}</span></div>}
    </div>
    {pageCount > 1 && <div className="ks-pages"><span>Showing {activePage * PAGE_SIZE + 1}–{Math.min((activePage + 1) * PAGE_SIZE, sessions.length)} of {sessions.length} sessions</span><div><button type="button" className="vw-button" aria-label="Previous kitchen sessions" disabled={activePage === 0} onClick={() => setPage(activePage - 1)}><ArrowLeft size={14} /></button><span>Room {activePage + 1} / {pageCount}</span><button type="button" className="vw-button" aria-label="Next kitchen sessions" disabled={activePage + 1 === pageCount} onClick={() => setPage(activePage + 1)}><ArrowRight size={14} /></button></div></div>}
    <div className="ks-tickets" aria-label="Kitchen sessions">
      {visible.map((session, index) => <button key={session.key} type="button" className={`ks-session ${session.activity}`} aria-pressed={selected === session.key} onClick={() => onSelect(session)} style={{ '--chef-color': COLORS[index % COLORS.length] } as React.CSSProperties}>
        <span className="ks-ticket-header"><span className="ks-chef-number">{index + 1}</span><span>{session.appLabel}</span><span className={`vw-session-dot ${session.activity}`} aria-hidden="true" /></span>
        <span className="ks-session-project" title={session.project?.trim() || session.folder?.trim() || 'Unassigned'}><Folder size={11} aria-hidden="true" /><span>{session.project?.trim() || session.folder?.trim() || 'Unassigned'}</span></span>
        <strong>{session.title}</strong><span className="ks-session-state">{session.confidence === 'inferred' ? 'Probably · ' : ''}{activityLabel[session.activity]}</span><span className="ks-session-detail">{session.stateText}</span>{(session.branch || session.placeLabel) && <span className="ks-session-branch">{session.branch || session.placeLabel}</span>}
      </button>)}
    </div>
    {selectedSession && <div className="ks-selected-detail"><div><span className="vw-inspector-kicker">{selectedSession.confidence === 'reported' ? 'Reported session state' : 'Inferred from local activity'}</span><strong>{selectedSession.title}</strong><p>{selectedSession.reason || selectedSession.stateText}</p><dl className="ks-selected-location"><div><dt>Project</dt><dd>{selectedSession.project?.trim() || 'Unassigned'}</dd></div>{selectedSession.folder?.trim() && <div><dt>Folder</dt><dd>{selectedSession.folder}</dd></div>}</dl></div><button type="button" className="vw-button" onClick={() => onTrace(selectedSession)}><Route size={14} />Inspect session & trace</button></div>}
    <p className="ks-caption">One chef per session. Movement illustrates activity; it does not measure progress or mark goals complete. <span>Chef models and animation adapted from Agenttrail.</span></p>
  </div>;
}
