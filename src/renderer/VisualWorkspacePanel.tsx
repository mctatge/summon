import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, ChefHat, CircleAlert, Flag, Folder, GitBranch, GitCommitHorizontal, LoaderCircle, Network, Pencil, Plus, RefreshCw, Route, X } from 'lucide-react';
import type { AgentSession, AgentSessionsView, SummonBridge, VisualGoal, VisualGoalInput, VisualRepository, VisualTrace, WifRepo, WorkInFlight } from './types';
import { previewAgentSessions, previewVisualRepository, previewWorkInFlight } from './preview';
import { ALL_PROJECTS, getVisualSessions, getSessionScopes } from './visual-sessions';
import './visual-workspace.css';

const KitchenScene = lazy(() => import('./KitchenScene'));

/* Intent: a founder following one piece of work from intent to code to the agent
   working on it. The diagram is the focal point; an inspector keeps its evidence
   and actions nearby. Domain: branches, worktrees, milestones, cooks, tickets,
   and reported events. Paper, pencil, petrol ink, receipt rules, and amber lamps
   carry that workshop into the existing palette. Native controls, restrained
   borders, raised paper over inset fields, system type (11/13/16/24), and a 4px
   grid keep it a working tool. The signature is a persistent connection across
   five views, not five unrelated dashboards or invented progress meters. */

type Props = { bridge?: SummonBridge | null; preview: boolean; onClose: () => void };
type View = 'goals' | 'codebase' | 'git' | 'kitchen' | 'trace';
type Selection = { goalId: string | null; placeId: string | null; branch: string | null; sessionKey: string | null; component: string | null; commitId: string | null };
type GoalDraft = { id?: string; title: string; status: VisualGoal['status']; parentId: string; dependsOn: string[]; placeId: string; branch: string; sessionKey: string; component: string };
type Point = { x: number; y: number };
const EMPTY_SELECTION: Selection = { goalId: null, placeId: null, branch: null, sessionKey: null, component: null, commitId: null };
const VIEWS = [
  { id: 'goals', label: 'Goals', icon: Flag }, { id: 'codebase', label: 'Codebase', icon: Network },
  { id: 'git', label: 'Git', icon: GitBranch }, { id: 'kitchen', label: 'Kitchen', icon: ChefHat },
  { id: 'trace', label: 'Live trace', icon: Route },
] as const;
const STATUS: Record<VisualGoal['status'], string> = { planned: 'Planned', working: 'Working', blocked: 'Blocked', done: 'Done' };
const POLL_MS = 15_000;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
const stamp = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Time unavailable';
const clock = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : 'Unknown time';
const short = (value: string, limit = 32) => value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
// Work in flight stores abbreviated object ids; the graph reads full ids. Only a
// unique prefix is a match, so ambiguous abbreviations never attach wrong work.
const resolveCommitId = (id: string | null, commits: VisualRepository['git']['commits']) => {
  if (!id) return null;
  if (commits.some(commit => commit.id === id)) return id;
  const matches = commits.filter(commit => commit.id.startsWith(id));
  return matches.length === 1 ? matches[0].id : null;
};
const goalDraft = (goal?: VisualGoal, parentId = ''): GoalDraft => ({ id: goal?.id, title: goal?.title ?? '', status: goal?.status ?? 'planned', parentId: goal?.parentId ?? parentId, dependsOn: goal?.dependsOn ?? [], placeId: goal?.links.placeId ?? '', branch: goal?.links.branch ?? '', sessionKey: goal?.links.sessionKey ?? '', component: goal?.links.component ?? '' });
const eventTitle = (event: string) => ({ SessionStart: 'Session opened', UserPromptSubmit: 'Task received', PreToolUse: 'Tool started', PostToolUse: 'Tool finished', PostToolUseFailure: 'Tool failed', PermissionRequest: 'Waiting for your OK', PermissionDenied: 'Permission declined', SubagentStart: 'Helper started', SubagentStop: 'Helper finished', Stop: 'Turn finished', StopFailure: 'Turn failed', SessionEnd: 'Session ended', Notification: 'Notification', PreCompact: 'Compacting context', PostCompact: 'Context compacted', 'agent-turn-complete': 'Turn finished' }[event] || event);

/** Lanes only position nodes. Every drawn line below comes from an actual parent
 * id; unknown parents terminate in a dashed boundary instead of a invented base. */
function commitLayout(commits: VisualRepository['git']['commits']) {
  const lanes: (string | null)[] = [];
  const points = new Map<string, Point>();
  let maxLane = 0;
  commits.forEach((commit, row) => {
    let lane = lanes.indexOf(commit.id);
    if (lane === -1) { lane = lanes.indexOf(null); if (lane === -1) lane = lanes.length; lanes[lane] = commit.id; }
    points.set(commit.id, { x: 24 + lane * 28, y: row * 80 + 40 });
    maxLane = Math.max(maxLane, lane);
    lanes[lane] = null;
    commit.parents.forEach((parent, index) => {
      if (lanes.includes(parent)) return;
      let target = index === 0 ? lane : lanes.indexOf(null);
      if (target === -1) target = lanes.length;
      lanes[target] = parent;
    });
  });
  return { points, width: Math.max(84, 56 + maxLane * 28), height: commits.length * 80 + 24 };
}

function goalLayout(goals: VisualGoal[]) {
  const ids = new Set(goals.map(goal => goal.id));
  const children = new Map<string, VisualGoal[]>();
  for (const goal of goals) { const key = goal.parentId && ids.has(goal.parentId) ? goal.parentId : ''; children.set(key, [...(children.get(key) ?? []), goal]); }
  const points = new Map<string, Point>();
  const visited = new Set<string>();
  let row = 0;
  let maxDepth = 0;
  const place = (goal: VisualGoal, depth: number): number => {
    if (visited.has(goal.id)) return row * 132;
    visited.add(goal.id); maxDepth = Math.max(maxDepth, depth);
    const ys = (children.get(goal.id) ?? []).filter(child => !visited.has(child.id)).map(child => place(child, depth + 1));
    const y = ys.length ? (ys[0] + ys[ys.length - 1]) / 2 : row++ * 132;
    points.set(goal.id, { x: 24 + depth * 256, y: 24 + y }); return y;
  };
  for (const goal of children.get('') ?? []) { place(goal, 0); row += .25; }
  // A corrupt imported cycle must not make the panel crash or hide its goals.
  for (const goal of goals) if (!visited.has(goal.id)) place(goal, 0);
  return { points, width: 264 + maxDepth * 256, height: Math.max(340, row * 132 + 24) };
}

function Empty({ icon: Icon = Network, title, children }: { icon?: typeof Network; title: string; children: React.ReactNode }) {
  return <div className="vw-empty"><Icon size={36} strokeWidth={1.25} aria-hidden="true" /><h3>{title}</h3><div>{children}</div></div>;
}

function State({ status }: { status: VisualGoal['status'] }) {
  return <span className={`vw-state ${status}`}><span aria-hidden="true">{status === 'done' ? <Check size={10} /> : null}</span>{STATUS[status]}</span>;
}

function GoalGraph({ goals, selected, onSelect }: { goals: VisualGoal[]; selected: string | null; onSelect: (goal: VisualGoal) => void }) {
  const layout = useMemo(() => goalLayout(goals), [goals]);
  return <div className="vw-diagram-scroll" tabIndex={0} role="region" aria-label="Goal diagram; solid lines join milestones, dashed arrows show dependencies">
    <div className="vw-goal-graph" style={{ width: layout.width, height: layout.height }}>
      <svg width={layout.width} height={layout.height} aria-hidden="true"><defs><marker id="vw-goal-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0 10 5 0 10" /></marker></defs>
        {goals.flatMap(goal => {
          const p = layout.points.get(goal.id)!;
          const parent = goal.parentId ? layout.points.get(goal.parentId) : null;
          const hierarchy = parent ? <path className="vw-tree-line" key={`${goal.id}-parent`} d={`M${parent.x + 208} ${parent.y + 48} C${parent.x + 232} ${parent.y + 48},${p.x - 24} ${p.y + 48},${p.x} ${p.y + 48}`} /> : null;
          return [hierarchy, ...goal.dependsOn.map(id => { const dependency = layout.points.get(id); return dependency ? <path key={`${goal.id}-${id}`} className="vw-dependency-line" markerEnd="url(#vw-goal-arrow)" d={`M${dependency.x + 104} ${dependency.y + 96} C${dependency.x + 104} ${dependency.y + 116},${p.x + 104} ${p.y - 20},${p.x + 104} ${p.y}`} /> : null; })];
        })}
      </svg>
      {goals.map(goal => { const p = layout.points.get(goal.id)!; return <button type="button" key={goal.id} className="vw-goal-node" style={{ left: p.x, top: p.y }} aria-pressed={selected === goal.id} onClick={() => onSelect(goal)}><State status={goal.status} /><strong title={goal.title}>{goal.title}</strong><small>{goal.parentId ? 'Milestone' : 'Goal'}{goal.dependsOn.length > 0 ? ` · ${goal.dependsOn.length} ${goal.dependsOn.length === 1 ? 'dependency' : 'dependencies'}` : ''}</small></button>; })}
    </div>
  </div>;
}

function GitGraph({ repository, selection, onSelect }: { repository: VisualRepository; selection: Selection; onSelect: (id: string, branch: string | null) => void }) {
  const { commits, refs } = repository.git;
  const layout = useMemo(() => commitLayout(commits), [commits]);
  const missing = commits.reduce((n, commit) => n + commit.parents.filter(parent => !layout.points.has(parent)).length, 0);
  if (!commits.length) return <Empty icon={GitBranch} title={repository.git.error ? 'Git history could not be read' : 'No commits here yet'}><p>{repository.git.error || 'This project’s first saved commit will appear here.'}</p></Empty>;
  return <><div className="vw-diagram-scroll vw-git-scroll" tabIndex={0} role="region" aria-label="Commit ancestry, newest first">
    <div className="vw-git-graph" style={{ minWidth: layout.width + 340, height: layout.height, paddingLeft: layout.width }}>
      <svg className="vw-git-rails" width={layout.width} height={layout.height} aria-hidden="true">
        {commits.flatMap(commit => { const p = layout.points.get(commit.id)!; return commit.parents.map((parent, i) => { const q = layout.points.get(parent); return <path key={`${commit.id}-${parent}`} className={`${q ? 'vw-tree-line' : 'vw-boundary-line'} ${selection.commitId === commit.id ? 'selected' : ''}`} d={q ? `M${p.x} ${p.y} C${p.x} ${p.y + 28},${q.x} ${q.y - 28},${q.x} ${q.y}` : `M${p.x} ${p.y} l${i * 6} 28`}><title>{q ? `${commit.id.slice(0, 7)} → parent ${parent.slice(0, 7)}` : `Parent ${parent.slice(0, 7)} is outside this snapshot`}</title></path>; }); })}
        {commits.map(commit => { const p = layout.points.get(commit.id)!; return <circle key={commit.id} cx={p.x} cy={p.y} r={selection.commitId === commit.id ? 6 : 4} className={selection.commitId === commit.id ? 'selected' : ''} />; })}
      </svg>
      {commits.map(commit => { const names = refs.filter(ref => ref.commitId === commit.id); const branch = names.find(ref => ref.kind === 'branch')?.name ?? null; return <button type="button" key={commit.id} className="vw-commit" aria-pressed={selection.commitId === commit.id} onClick={() => onSelect(commit.id, branch)}><span className="vw-commit-line"><strong>{commit.subject || 'Untitled commit'}</strong>{names.slice(0, 3).map(ref => <span title={`${ref.kind}: ${ref.name}`} className={`vw-ref ${selection.branch === ref.name ? 'linked' : ''}`} key={`${ref.kind}:${ref.name}`}>{short(ref.name, 26)}</span>)}{names.length > 3 && <small title={names.slice(3).map(ref => ref.name).join(', ')}>+{names.length - 3}</small>}</span><small><code>{commit.id.slice(0, 7)}</code> · {stamp(commit.at)}{commit.parents.length > 1 && ` · ${commit.parents.length} parents`}</small></button>; })}
    </div>
  </div><p className="vw-footnote">Solid lines are recorded commit parents.{missing > 0 ? ` ${count(missing, 'parent')} outside this snapshot end in dashed lines.` : ''}{repository.git.truncated ? ' History is capped; older commits are omitted.' : ''}</p></>;
}

function CodebaseGraph({ repository, selected, onSelect }: { repository: VisualRepository; selected: string | null; onSelect: (id: string) => void }) {
  const { nodes, edges } = repository.codebase;
  const columns = nodes.length < 4 ? 2 : 3;
  const points = new Map(nodes.map((node, i) => [node.id, { x: 32 + (i % columns) * 236, y: 32 + Math.floor(i / columns) * 164 }]));
  const width = columns * 236 + 24;
  const height = Math.max(360, Math.ceil(nodes.length / columns) * 164 + 24);
  if (!nodes.length) return <Empty icon={Network} title={repository.codebase.error ? 'The codebase could not be read' : 'No supported source files found'}><p>{repository.codebase.error || repository.codebase.note || 'The map reads local JS and TS imports in this project. Other languages are not mapped yet.'}</p></Empty>;
  return <><div className="vw-diagram-scroll" tabIndex={0} role="region" aria-label="Codebase components and observed imports">
    <div className="vw-code-graph" style={{ width, height }}>
      <svg width={width} height={height} aria-hidden="true"><defs><marker id="vw-import-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 10 5 0 10" /></marker></defs>
        {edges.map(edge => {
          const source = points.get(edge.source); const target = points.get(edge.target);
          if (!source || !target) return null;
          const sameRow = source.y === target.y;
          const overRow = sameRow && Math.abs(source.x - target.x) > 236;
          const direction = source.x < target.x ? 1 : -1;
          const a = overRow ? { x: source.x + 90, y: source.y } : sameRow ? { x: source.x + (direction === 1 ? 180 : 0), y: source.y + 52 } : { x: source.x + 90, y: source.y + (source.y < target.y ? 104 : 0) };
          const b = overRow ? { x: target.x + 90, y: target.y } : sameRow ? { x: target.x + (direction === 1 ? 0 : 180), y: target.y + 52 } : { x: target.x + 90, y: target.y + (source.y < target.y ? 0 : 104) };
          // Skip over intervening components via the open margin above the row.
          const path = overRow ? `M${a.x} ${a.y} C${a.x} ${a.y - 32},${b.x} ${b.y - 32},${b.x} ${b.y}` : sameRow ? `M${a.x} ${a.y} C${a.x + 24 * direction} ${a.y - 24},${b.x - 24 * direction} ${b.y - 24},${b.x} ${b.y}` : `M${a.x} ${a.y} C${a.x} ${(a.y + b.y) / 2},${b.x} ${(a.y + b.y) / 2},${b.x} ${b.y}`;
          return <path className={`vw-import-line ${edge.source === selected || edge.target === selected ? 'selected' : ''}`} key={`${edge.source}-${edge.target}`} markerEnd="url(#vw-import-arrow)" d={path}><title>{edge.count} observed imports: {edge.source} → {edge.target}</title></path>;
        })}
      </svg>
      {nodes.map(node => { const p = points.get(node.id)!; return <button type="button" key={node.id} style={{ left: p.x, top: p.y }} className="vw-code-node" aria-pressed={selected === node.id} onClick={() => onSelect(node.id)}><span className="vw-node-kicker"><Folder size={13} aria-hidden="true" />Component</span><strong title={node.path}>{node.label}</strong><small>{count(node.files, 'file')}{node.changed > 0 && <span className="vw-changed"> · {node.changed} changed</span>}</small></button>; })}
    </div>
  </div><p className="vw-footnote">Arrows point from a component to the local JS/TS code it imports.{!edges.length ? ' No imports between these components were observed.' : ''}{repository.codebase.truncated ? ' This map is capped; some files or links are omitted.' : ''}</p></>;
}

function GoalEditor({ draft, goals, repo, sessions, repository, saving, error, onChange, onSave, onCancel }: { draft: GoalDraft; goals: VisualGoal[]; repo: WifRepo; sessions: AgentSession[]; repository: VisualRepository; saving: boolean; error: string; onChange: (draft: GoalDraft) => void; onSave: () => void; onCancel: () => void }) {
  const patch = (update: Partial<GoalDraft>) => onChange({ ...draft, ...update });
  const descendants = new Set(draft.id ? [draft.id] : []);
  for (let i = 0; i < goals.length; i++) for (const goal of goals) if (goal.parentId && descendants.has(goal.parentId)) descendants.add(goal.id);
  const branches = [...new Set([...repo.branches.map(branch => branch.name), ...repo.places.map(place => place.branch).filter((branch): branch is string => Boolean(branch)), ...(draft.branch ? [draft.branch] : [])])].sort();
  return <form className="vw-goal-editor" onSubmit={event => { event.preventDefault(); onSave(); }}><fieldset disabled={saving}><div className="vw-inspector-kicker">{draft.id ? 'Edit goal' : draft.parentId ? 'New milestone' : 'New goal'}</div><label>What should happen?<input autoFocus required maxLength={240} value={draft.title} onChange={event => patch({ title: event.target.value })} placeholder="A concrete outcome…" /></label><label>Status<select value={draft.status} onChange={event => patch({ status: event.target.value as VisualGoal['status'] })}>{Object.entries(STATUS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Part of<select value={draft.parentId} onChange={event => patch({ parentId: event.target.value })}><option value="">A goal of its own</option>{goals.filter(goal => !descendants.has(goal.id)).map(goal => <option key={goal.id} value={goal.id}>{goal.title}</option>)}</select></label>
    <details open={draft.dependsOn.length > 0}><summary>Dependencies <span>{draft.dependsOn.length || ''}</span></summary><div className="vw-dependency-options">{goals.filter(goal => goal.id !== draft.id).map(goal => <label key={goal.id}><input type="checkbox" checked={draft.dependsOn.includes(goal.id)} onChange={event => patch({ dependsOn: event.target.checked ? [...draft.dependsOn, goal.id] : draft.dependsOn.filter(id => id !== goal.id) })} /><span>{goal.title}</span></label>)}{goals.filter(goal => goal.id !== draft.id).length === 0 && <p>No other goals to depend on yet.</p>}</div></details>
    <details className="vw-link-fields" open><summary>Connect to work <span>optional</span></summary><p>Links are chosen by you.</p><label>Folder<select value={draft.placeId} onChange={event => patch({ placeId: event.target.value })}><option value="">No folder linked</option>{repo.places.map(place => <option key={place.id} value={place.id}>{place.label}</option>)}{draft.placeId && !repo.places.some(place => place.id === draft.placeId) && <option value={draft.placeId}>Previously linked folder (unavailable)</option>}</select></label><label>Branch<select value={draft.branch} onChange={event => patch({ branch: event.target.value })}><option value="">No branch linked</option>{branches.map(branch => <option key={branch}>{branch}</option>)}</select></label><label>Session<select value={draft.sessionKey} onChange={event => patch({ sessionKey: event.target.value })}><option value="">No session linked</option>{sessions.map(session => <option key={session.key} value={session.key}>{session.appLabel} · {session.title}</option>)}{draft.sessionKey && !sessions.some(session => session.key === draft.sessionKey) && <option value={draft.sessionKey}>Previously linked session (unavailable)</option>}</select></label><label>Component<select value={draft.component} onChange={event => patch({ component: event.target.value })}><option value="">No component linked</option>{repository.codebase.nodes.map(node => <option key={node.id} value={node.id}>{node.label}</option>)}{draft.component && !repository.codebase.nodes.some(node => node.id === draft.component) && <option value={draft.component}>{draft.component} (not in this map)</option>}</select></label></details>
    {error && <p role="alert" className="vw-inline-error">{error}</p>}<div className="vw-form-actions"><button className="vw-button primary" type="submit" disabled={saving || !draft.title.trim()}>{saving ? <LoaderCircle className="vw-spin" size={14} /> : <Check size={14} />}Save {draft.parentId ? 'milestone' : 'goal'}</button><button className="vw-button" type="button" onClick={onCancel} disabled={saving}>Cancel</button></div><p className="vw-footnote">Status is explicit. Session activity never marks a goal done.</p></fieldset></form>;
}

export function VisualWorkspacePanel({ bridge, preview, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const stage = useRef<HTMLElement>(null);
  const opener = useRef(document.activeElement as HTMLElement | null);
  const alive = useRef(true);
  const goalsRevision = useRef(0);
  const draftRevision = useRef(0);
  const previewGoals = useRef(new Map<string, VisualGoal[]>());
  const [flight, setFlight] = useState<WorkInFlight | null>(!bridge && preview ? previewWorkInFlight : null);
  const [sessionView, setSessionView] = useState<AgentSessionsView | null>(!bridge && preview ? previewAgentSessions : null);
  const [scope, setScope] = useState(ALL_PROJECTS);
  const [repository, setRepository] = useState<VisualRepository | null>(null);
  const [view, setView] = useState<View>('kitchen');
  const [kitchenPaused, setKitchenPaused] = useState(false);
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const pendingScopeSelection = useRef<{ scope: string; selection: Selection } | null>(null);
  const [draft, setDraftState] = useState<GoalDraft | null>(null);
  const setDraft = (next: GoalDraft | null) => { draftRevision.current++; setDraftState(next); };
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [resourceError, setResourceError] = useState('');
  const [repositoryError, setRepositoryError] = useState('');
  const [resourceLoading, setResourceLoading] = useState(Boolean(bridge));
  const [repositoryLoading, setRepositoryLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [opening, setOpening] = useState(false);
  const [notice, setNotice] = useState('');
  const [stepId, setStepId] = useState<string | null>(null);
  const [followLatest, setFollowLatest] = useState(true);
  const allSessions = useMemo(() => getVisualSessions(sessionView), [sessionView]);
  const scopes = useMemo(() => getSessionScopes(flight?.repos ?? [], allSessions), [flight, allSessions]);
  const currentScope = scopes.find(item => item.value === scope);
  const repoId = currentScope?.repoId ?? '';
  const repo = flight?.repos.find(item => item.id === repoId) ?? null;
  const isSessionView = view === 'kitchen' || view === 'trace';
  const repoAvailable = Boolean(repo);
  const [sessionTrace, setSessionTrace] = useState<VisualTrace | null>(null);
  const [traceError, setTraceError] = useState('');
  const [traceLoading, setTraceLoading] = useState(false);
  const currentRepository = repository?.repoId === repoId ? repository : null;
  const currentRepo = useRef(repoId); currentRepo.current = repoId;
  const sessions = useMemo(() => getVisualSessions(sessionView, scope), [sessionView, scope]);
  const goals = currentRepository?.goals ?? [];
  const selectedGoal = goals.find(goal => goal.id === selection.goalId) ?? null;
  const selectedSession = sessions.find(session => session.key === selection.sessionKey) ?? null;
  const selectedProject = repo ?? flight?.repos.find(item => item.id === selectedSession?.repoId);
  const selectedPlace = selectedProject?.places.find(place => place.id === selection.placeId) ?? null;
  const selectedComponent = currentRepository?.codebase.nodes.find(node => node.id === selection.component) ?? null;
  const selectedCommit = currentRepository?.git.commits.find(commit => commit.id === selection.commitId) ?? null;
  const inScope = (key: string) => !allSessions.some(item => item.key === key) || sessions.some(item => item.key === key);
  const selectedOutsideScope = Boolean(selection.sessionKey && !inScope(selection.sessionKey));
  const traces = (currentRepository?.traces ?? []).filter(trace => inScope(trace.sessionKey));
  const traceKey = (!selectedOutsideScope ? selection.sessionKey : null) ?? traces[0]?.sessionKey ?? sessions[0]?.key ?? '';
  const selectedTrace = sessionTrace?.sessionKey === traceKey ? sessionTrace : traces.find(trace => trace.sessionKey === traceKey);
  const events = selectedTrace?.events ?? [];
  const stepIndex = followLatest ? events.length - 1 : Math.max(0, events.findIndex(event => event.id === stepId));
  const selectedEvent = events[stepIndex] ?? null;

  useEffect(() => {
    alive.current = true;
    if (!dialog.current?.open) dialog.current?.showModal();
    return () => { alive.current = false; opener.current?.focus(); };
  }, []);

  // Timers stop altogether while the document is hidden. Every request is scoped
  // to this effect, so closing/reopening or switching projects drops late replies.
  useEffect(() => {
    if (!bridge) { if (!preview) setResourceError('This window is not connected to Summon. Reopen it from the desktop app.'); return; }
    let active = true;
    let loading = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (force = false) => {
      if (!active || loading || document.hidden) return;
      loading = true; setResourceLoading(true);
      const [work, agents] = await Promise.allSettled([
        bridge.workInFlight(force ? { refresh: true } : undefined).then(value => { if (active) setFlight(value); return value; }),
        bridge.agentSessions(force ? { refresh: true } : undefined).then(value => { if (active) setSessionView(value); return value; }),
      ]);
      if (active) {
        setResourceError([work.status === 'rejected' ? `Projects: ${message(work.reason)}` : '', agents.status === 'rejected' ? `Sessions: ${message(agents.reason)}` : ''].filter(Boolean).join(' · '));
        setResourceLoading(false);
      }
      loading = false;
      if (active && !document.hidden) timer = setTimeout(() => { void load(); }, POLL_MS);
    };
    const visibility = () => { clearTimeout(timer); if (!document.hidden) void load(); };
    void load(refresh > 0);
    document.addEventListener('visibilitychange', visibility);
    return () => { active = false; clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [bridge, preview, refresh]);

  useEffect(() => {
    if (!resourceLoading && !scopes.some(item => item.value === scope)) setScope(ALL_PROJECTS);
  }, [scopes, scope, resourceLoading]);

  useEffect(() => {
    const pending = pendingScopeSelection.current; pendingScopeSelection.current = null;
    setSelection(pending?.scope === scope ? pending.selection : EMPTY_SELECTION); setDraft(null); setSaveError(''); setNotice(''); setStepId(null); setFollowLatest(true);
  }, [scope]);

  useEffect(() => {
    if (selectedOutsideScope) { setSelection(EMPTY_SELECTION); setDraft(null); }
  }, [selectedOutsideScope]);

  useEffect(() => {
    if (!repoId || !repoAvailable || isSessionView) { setRepositoryLoading(false); setRepositoryError(''); return; }
    if (!bridge) {
      if (preview) { const next = previewVisualRepository(repoId); setRepository({ ...next, goals: previewGoals.current.get(repoId) ?? next.goals }); }
      return;
    }
    if (typeof bridge.visualRepository !== 'function') { setRepositoryError('This window is older than its app. Quit and reopen Summon to use the visual workspace.'); return; }
    let active = true;
    let loading = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (force = false) => {
      if (!active || loading || document.hidden) return;
      loading = true; setRepositoryLoading(true);
      const revision = goalsRevision.current;
      try {
        const next = await bridge.visualRepository(repoId, force ? { refresh: true } : undefined);
        if (active) { setRepository(current => revision === goalsRevision.current || current?.repoId !== repoId ? next : { ...next, goals: current.goals }); setRepositoryError(''); }
      } catch (error) { if (active) setRepositoryError(message(error)); }
      finally { loading = false; if (active) { setRepositoryLoading(false); if (!document.hidden) timer = setTimeout(() => { void load(); }, POLL_MS); } }
    };
    const visibility = () => { clearTimeout(timer); if (!document.hidden) void load(); };
    void load(refresh > 0);
    document.addEventListener('visibilitychange', visibility);
    return () => { active = false; clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [repoId, repoAvailable, isSessionView, bridge, preview, refresh]);

  // A session trace does not depend on a repository or a successful Git scan.
  useEffect(() => {
    setSessionTrace(null); setTraceError(''); setTraceLoading(false);
    if (view !== 'trace' || !traceKey) return;
    if (!bridge) {
      if (preview) {
        const session = sessions.find(item => item.key === traceKey);
        const trace = previewVisualRepository(session?.repoId ?? '').traces.find(item => item.sessionKey === traceKey);
        setSessionTrace(trace ?? { sessionKey: traceKey, events: [], truncated: false });
      }
      return;
    }
    if (typeof bridge.agentSessionTrace !== 'function') { setTraceError('Quit and reopen Summon to load session traces.'); return; }
    let active = true;
    let loading = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (!active || loading || document.hidden) return;
      loading = true; setTraceLoading(true);
      try { const trace = await bridge.agentSessionTrace(traceKey); if (active) { setSessionTrace(trace); setTraceError(''); } }
      catch (error) { if (active) setTraceError(message(error)); }
      finally { loading = false; if (active) { setTraceLoading(false); if (!document.hidden) timer = setTimeout(() => { void load(); }, POLL_MS); } }
    };
    const visibility = () => { clearTimeout(timer); if (!document.hidden) void load(); };
    void load(); document.addEventListener('visibilitychange', visibility);
    return () => { active = false; clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [bridge, preview, view, traceKey, refresh]);

  useEffect(() => { setStepId(null); setFollowLatest(true); }, [traceKey]);

  useEffect(() => {
    if (!stage.current) return;
    stage.current.scrollTop = 0;
    // Narrow layouts scroll the stage and inspector together in their parent.
    if (stage.current.parentElement) stage.current.parentElement.scrollTop = 0;
  }, [view, scope]);

  const chooseGoal = (goal: VisualGoal) => {
    const session = sessions.find(item => item.key === goal.links.sessionKey);
    const place = repo?.places.find(item => item.id === goal.links.placeId);
    setSelection({ goalId: goal.id, ...goal.links, branch: goal.links.branch || session?.branch || place?.branch || null, commitId: null }); setDraft(null); setSaveError('');
  };
  const chooseSession = (session: AgentSession) => {
    const goal = goals.find(item => item.links.sessionKey === session.key);
    setSelection({ goalId: goal?.id ?? null, placeId: session.placeId, branch: session.branch, sessionKey: session.key, component: goal?.links.component ?? null, commitId: null }); setDraft(null);
  };
  const chooseTrace = (key: string) => {
    const session = sessions.find(item => item.key === key);
    if (session) chooseSession(session); else { setSelection({ ...EMPTY_SELECTION, sessionKey: key }); setDraft(null); }
  };
  const chooseCommit = (id: string, branch: string | null) => {
    const place = repo?.places.find(item => resolveCommitId(item.head, currentRepository?.git.commits ?? []) === id || (branch && item.branch === branch));
    const matchedBranch = branch || place?.branch || null;
    const session = sessions.find(item => place ? item.placeId === place.id : matchedBranch && item.branch === matchedBranch);
    const goal = matchedBranch ? goals.find(item => item.links.branch === matchedBranch) : null;
    setSelection({ ...EMPTY_SELECTION, commitId: id, branch: matchedBranch, placeId: place?.id ?? null, sessionKey: session?.key ?? null, goalId: goal?.id ?? null, component: goal?.links.component ?? null }); setDraft(null);
  };
  const chooseComponent = (id: string) => {
    const goal = goals.find(item => item.links.component === id);
    if (goal) chooseGoal(goal);
    else { setSelection({ ...EMPTY_SELECTION, component: id }); setDraft(null); }
  };
  const saveGoal = async () => {
    if (!draft || !repo || !currentRepository || saving || !draft.title.trim()) return;
    const target = repo.id;
    const savedDraftRevision = draftRevision.current;
    const input: VisualGoalInput = { ...(draft.id ? { id: draft.id } : {}), repoId: target, title: draft.title.trim(), status: draft.status, parentId: draft.parentId || null, dependsOn: draft.dependsOn, links: { placeId: draft.placeId || null, branch: draft.branch || null, sessionKey: draft.sessionKey || null, component: draft.component || null } };
    setSaving(true); setSaveError('');
    try {
      let next: VisualGoal[];
      if (bridge) next = await bridge.saveVisualGoal(input);
      else {
        const now = new Date().toISOString();
        const goal: VisualGoal = { id: draft.id || `preview-${crypto.randomUUID()}`, repoId: target, title: draft.title.trim(), status: draft.status, parentId: draft.parentId || null, dependsOn: [...draft.dependsOn], links: { placeId: draft.placeId || null, branch: draft.branch || null, sessionKey: draft.sessionKey || null, component: draft.component || null }, createdAt: goals.find(item => item.id === draft.id)?.createdAt ?? now, updatedAt: now };
        next = [...goals.filter(item => item.id !== goal.id), goal];
        const byId = new Map(next.map(item => [item.id, item]));
        const visited = new Set<string>();
        const visiting = new Set<string>();
        const visit = (id: string) => {
          if (visiting.has(id)) throw new Error('Goal relationships cannot contain a cycle.');
          if (visited.has(id)) return;
          const item = byId.get(id);
          if (!item) throw new Error('A linked goal no longer exists.');
          visiting.add(id);
          for (const linked of [item.parentId, ...item.dependsOn]) if (linked) visit(linked);
          visiting.delete(id); visited.add(id);
        };
        next.forEach(item => visit(item.id));
        previewGoals.current.set(target, next);
      }
      if (alive.current && currentRepo.current === target) {
        goalsRevision.current++; setRepository(current => current?.repoId === target ? { ...current, goals: next.filter(goal => goal.repoId === target) } : current);
        const saved = next.find(goal => draft.id ? goal.id === draft.id : !goals.some(previous => previous.id === goal.id));
        // A save may finish after the user starts editing or selects another
        // item. Update the stored graph without replacing their newer context.
        if (draftRevision.current === savedDraftRevision) {
          if (saved) chooseGoal(saved); else setDraft(null);
        }
        setNotice(preview && !bridge ? 'Saved in this preview only.' : 'Goal saved on this Mac.');
      }
    } catch (error) { if (alive.current && currentRepo.current === target) { if (draftRevision.current === savedDraftRevision) setSaveError(message(error)); else setNotice(`Goal was not saved: ${message(error)}`); } }
    finally { if (alive.current) setSaving(false); }
  };
  const openSession = async (session: AgentSession) => {
    if (!bridge || opening) return;
    setOpening(true); setNotice('');
    try { const result = await bridge.openAgentSession(session.key); if (alive.current) setNotice(result?.copied ? 'Resume command copied. Paste it into Terminal.' : result?.shown ? 'Session folder opened in Finder.' : 'Session opened.'); }
    catch (error) { if (alive.current) setNotice(`Could not open session: ${message(error)}`); }
    finally { if (alive.current) setOpening(false); }
  };
  const addGoal = (parentId = '') => { setView('goals'); setDraft(goalDraft(undefined, parentId)); setSaveError(''); };
  const chooseView = (next: View) => { setView(next); };
  const exploreSelectedProject = () => {
    if (selectedProject) {
      const nextScope = `repo:${selectedProject.id}`;
      if (nextScope !== scope) pendingScopeSelection.current = { scope: nextScope, selection };
      setScope(nextScope);
    }
    setView('git');
  };
  const tabKeys = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const index = VIEWS.findIndex(item => item.id === view);
    const next = event.key === 'ArrowRight' ? (index + 1) % VIEWS.length : event.key === 'ArrowLeft' ? (index + VIEWS.length - 1) % VIEWS.length : event.key === 'Home' ? 0 : event.key === 'End' ? VIEWS.length - 1 : -1;
    if (next < 0) return; event.preventDefault(); chooseView(VIEWS[next].id); dialog.current?.querySelector<HTMLButtonElement>(`#vw-tab-${VIEWS[next].id}`)?.focus();
  };
  const stepTo = (index: number) => { if (!events[index]) return; setStepId(events[index].id); setFollowLatest(false); };
  const toggleFollowing = () => { if (followLatest && selectedEvent) setStepId(selectedEvent.id); setFollowLatest(value => !value); };
  const linkedGoals = goals.filter(goal => goal.id !== selection.goalId && ((selection.sessionKey && goal.links.sessionKey === selection.sessionKey) || (selection.branch && goal.links.branch === selection.branch) || (selection.placeId && goal.links.placeId === selection.placeId) || (selection.component && goal.links.component === selection.component)));
  const isLoading = resourceLoading || (!isSessionView && repositoryLoading) || (view === 'trace' && traceLoading);
  const visibleErrors = [resourceError, !isSessionView ? repositoryError : '', view === 'trace' ? traceError : ''].filter(Boolean);
  const title = { goals: 'A map of what you want to finish.', codebase: 'Where the pieces connect.', git: 'Work taking separate paths.', kitchen: 'Who’s cooking, who needs you.', trace: 'Follow the reported actions.' }[view];
  const subtitle = { goals: 'Goals and milestones you explicitly record', codebase: 'Observed local JS/TS imports · main project folder', git: 'Local commits, branches, and worktrees', kitchen: scope === ALL_PROJECTS ? 'Your agents across projects, together in one kitchen' : scope === 'unassigned' ? 'Sessions without a project or folder' : `Sessions in ${currentScope?.label || 'this project'}`, trace: 'Recorded hook events · no prompts or tool contents' }[view];

  return <dialog ref={dialog} className="preferences-dialog vw-dialog" aria-labelledby="vw-title" onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === dialog.current) { const rect = dialog.current.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose(); } }}><div className="vw-content">
    <header className="vw-header"><div className="vw-heading"><span className="vw-eyebrow">SUMMON / VISUAL WORKSPACE</span><h2 id="vw-title">Your agents, across projects.</h2></div><div className="vw-header-actions">{preview && !bridge && <span className="preview-badge">Sample data</span>}<button type="button" className="icon-button" title="Refresh visual workspace" aria-label="Refresh visual workspace" disabled={isLoading || saving || (!bridge && !preview)} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={16} className={isLoading ? 'vw-spin' : ''} /></button><button type="button" className="icon-button" onClick={onClose} aria-label="Close visual workspace"><X size={18} /></button></div></header>
    <div className="vw-context"><label className="vw-project"><Folder size={14} aria-hidden="true" /><select aria-label="Visual workspace project" value={scope} disabled={saving} onChange={event => setScope(event.target.value)}>{scopes.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label><span className="vw-context-path" title={repo?.displayPath}>{scope === ALL_PROJECTS ? 'Across your connected agent apps' : repo?.displayPath || currentScope?.label}</span><button type="button" className="vw-context-sessions" onClick={() => setView('kitchen')}><span className="vw-session-dot working" aria-hidden="true" />{count(sessions.length, 'session')}</button></div>
    <div role="tablist" aria-label="Visual workspace views" className="vw-tabs" onKeyDown={tabKeys}>{VIEWS.map(({ id, label, icon: Icon }) => <button type="button" role="tab" id={`vw-tab-${id}`} aria-controls="vw-stage" aria-selected={view === id} tabIndex={view === id ? 0 : -1} className="vw-tab" key={id} onClick={() => chooseView(id)}><Icon size={16} aria-hidden="true" />{label}{id === 'goals' && goals.length > 0 && <span>{goals.length}</span>}</button>)}</div>
    {visibleErrors.length > 0 && <div className="vw-error" role="alert"><CircleAlert size={15} /><span>{visibleErrors.join(' · ')}{(!isSessionView && currentRepository) && ' Showing the last successful snapshot.'}</span></div>}
    <div className={`vw-main${view === 'kitchen' ? ' vw-main-kitchen' : ''}`}><section ref={stage} id="vw-stage" role="tabpanel" aria-labelledby={`vw-tab-${view}`} className="vw-stage"><div className="vw-stage-heading"><div><h3>{title}</h3><p>{subtitle}</p></div>{view === 'goals' && repo && currentRepository && <button type="button" className="vw-button" onClick={() => addGoal()} disabled={saving}><Plus size={14} />New goal</button>}</div>
      {selection.goalId || selection.placeId || selection.branch || selection.sessionKey || selection.component ? <div className="vw-focus-strip"><span>Following</span><strong>{selectedGoal?.title || selectedSession?.title || selectedComponent?.label || selection.branch || selectedPlace?.label || 'Linked work'}</strong><button type="button" aria-label="Clear selected work" title="Clear selected work" onClick={() => { setSelection(EMPTY_SELECTION); setDraft(null); }}><X size={12} /></button></div> : null}
      {isSessionView ? (resourceLoading && !sessionView ? <Empty icon={ChefHat} title="Finding your sessions…"><p>Reading your connected agent apps across projects.</p></Empty> : <>
        {view === 'kitchen' && <Suspense fallback={<Empty icon={ChefHat} title="Opening the kitchen…"><p>Preparing the local 3D scene.</p></Empty>}><KitchenScene key={scope} scopeLabel={currentScope?.label || 'All projects'} sessions={sessions} selected={selection.sessionKey} paused={kitchenPaused} onPausedChange={setKitchenPaused} onSelect={chooseSession} onTrace={session => { chooseSession(session); setView('trace'); }} /></Suspense>}
        {view === 'trace' && <><label className="vw-trace-picker">Session<select value={traceKey} aria-label="Trace session" onChange={event => chooseTrace(event.target.value)}>{!sessions.length && !traces.length && <option value="">No linked sessions</option>}{sessions.map(session => <option key={session.key} value={session.key}>{session.project || session.folder || 'Unassigned'} · {session.appLabel} · {session.title}</option>)}{traces.filter(trace => !sessions.some(session => session.key === trace.sessionKey)).map(trace => <option key={trace.sessionKey} value={trace.sessionKey}>Recorded session · {short(trace.sessionKey, 44)}</option>)}{traceKey && !sessions.some(session => session.key === traceKey) && !traces.some(trace => trace.sessionKey === traceKey) && <option value={traceKey}>Linked session unavailable · {short(traceKey, 36)}</option>}</select></label>{events.length ? <><div className="vw-trace-controls"><span>{followLatest ? 'Following newest event' : `Event ${stepIndex + 1} of ${events.length}`}</span><div><button type="button" className="icon-button" aria-label="Previous event" disabled={stepIndex <= 0} onClick={() => stepTo(stepIndex - 1)}><ArrowLeft size={16} /></button><button type="button" className="icon-button" aria-label="Next event" disabled={stepIndex >= events.length - 1} onClick={() => stepTo(stepIndex + 1)}><ArrowRight size={16} /></button><button type="button" className="vw-button" aria-pressed={followLatest} onClick={toggleFollowing}>{followLatest ? 'Pause following' : 'Follow latest'}</button></div></div><div className="vw-trace-feature" aria-live="polite"><span className="vw-eyebrow">{clock(selectedEvent!.at)} · REPORTED</span><Route size={28} strokeWidth={1.4} aria-hidden="true" /><h4>{eventTitle(selectedEvent!.event)}</h4><p>{selectedEvent!.toolName || selectedEvent!.event}</p>{selectedEvent!.state && <span>{selectedEvent!.state}</span>}</div><ol className="vw-trace-list">{events.map((event, index) => <li key={event.id}><button type="button" className="vw-trace-step" aria-current={selectedEvent?.id === event.id ? 'step' : undefined} onClick={() => stepTo(index)}><span className="vw-trace-node" aria-hidden="true" /><time dateTime={event.at}>{clock(event.at)}</time><strong>{eventTitle(event.event)}</strong><span>{event.toolName || event.state || 'Reported'}</span></button></li>)}</ol>{selectedTrace?.truncated && <p className="vw-footnote">Only retained recent events are shown. Earlier events are outside this history.</p>}</> : <Empty icon={Route} title={traceLoading ? 'Loading reported events…' : traceError ? 'Reported events are unavailable.' : 'No recorded events for this session yet.'}><p>History starts when hooks report to this version of Summon. Earlier activity cannot be replayed.</p><p>Claude hooks report tool and lifecycle events. Codex coverage depends on installed hooks; some sessions only report completed turns. Cursor and Hermes have no hook trace yet.</p></Empty>}<p className="vw-footnote">Events contain times, event names, tool names, and reported states. They do not include prompts, arguments, results, or inferred steps.</p></>}
      </>) : !repo ? <Empty icon={Folder} title={scope === ALL_PROJECTS ? 'Choose a project to explore its work.' : 'This session has no available Git project.'}><p>{scope === ALL_PROJECTS ? 'Git history, codebase maps and goals belong to individual projects. Your kitchen and session traces work across all of them.' : 'You can still follow its activity in Kitchen and Live trace.'}</p><div className="vw-project-choices">{flight?.repos.map(item => <button type="button" className="vw-button" key={item.id} onClick={() => setScope(`repo:${item.id}`)}><Folder size={13} />{item.name}</button>)}</div></Empty> : !currentRepository ? <Empty icon={repositoryLoading ? LoaderCircle : Network} title={repositoryLoading ? 'Drawing this project…' : 'This project could not be drawn'}><p>{repositoryLoading ? 'Reading local commits, imports, and session events.' : repositoryError || 'Refresh to try reading this project again.'}</p></Empty> : <>
        {view === 'goals' && (goals.length ? <><GoalGraph goals={goals} selected={selection.goalId} onSelect={chooseGoal} /><div className="vw-legend"><span><i className="solid" />Goal → milestone</span><span><i className="dashed" />Dependency → dependent goal</span><span>{goals.filter(goal => goal.status === 'done').length} of {goals.length} explicitly done</span></div></> : <Empty icon={Flag} title="Start with an outcome."><p>Add a goal, break it into milestones, and connect it to the branch or session doing the work.</p><button type="button" className="vw-button primary" onClick={() => addGoal()}><Plus size={14} />Create your first goal</button></Empty>)}
        {view === 'git' && <><div className="vw-places" aria-label="Project folders">{repo.places.map(place => <button type="button" className="vw-place" key={place.id} aria-pressed={selection.placeId === place.id} title={place.displayPath} onClick={() => { const session = sessions.find(item => item.placeId === place.id); setSelection({ ...EMPTY_SELECTION, placeId: place.id, branch: place.branch, commitId: resolveCommitId(place.head, currentRepository.git.commits), sessionKey: session?.key ?? null }); setDraft(null); }}><GitBranch size={13} /><span><strong>{place.branch || (place.detached ? 'Detached checkout' : place.label)}</strong><small>{place.label} · {place.missing ? 'folder missing' : `${place.counts.items} unsaved`}</small></span></button>)}</div><GitGraph repository={currentRepository} selection={selection} onSelect={chooseCommit} /></>}
        {view === 'codebase' && <CodebaseGraph repository={currentRepository} selected={selection.component} onSelect={chooseComponent} />}

      </>}
    </section><aside className="vw-inspector" aria-label="Selected work details">
      {draft && repo && currentRepository ? <GoalEditor draft={draft} goals={goals} repo={repo} sessions={sessions} repository={currentRepository} saving={saving} error={saveError} onChange={setDraft} onSave={() => { void saveGoal(); }} onCancel={() => { setDraft(null); setSaveError(''); }} /> : <><div className="vw-inspector-kicker">{selectedGoal ? 'Linked goal' : selectedSession ? 'Selected session' : selectedComponent ? 'Selected component' : selectedCommit ? 'Selected commit' : selectedPlace ? 'Selected folder' : 'A thread through the work'}</div><h3>{selectedGoal?.title || selectedSession?.title || selectedComponent?.label || selectedCommit?.subject || selectedPlace?.label || 'Pick a piece. Follow it.'}</h3>{selectedGoal ? <><State status={selectedGoal.status} /><div className="vw-inspector-actions"><button type="button" className="vw-button" onClick={() => { setDraft(goalDraft(selectedGoal)); setSaveError(''); }}><Pencil size={13} />Edit goal</button><button type="button" className="vw-button" onClick={() => addGoal(selectedGoal.id)}><Plus size={13} />Milestone</button></div></> : !selectedSession && !selectedComponent && !selectedCommit && !selectedPlace && <p className="vw-inspector-intro">Select a commit, cook, or component. Its linked goal and session stay with you as you switch views.</p>}
        {(selection.branch || selection.placeId || selection.sessionKey || selection.component || selectedCommit) && <dl className="vw-details">
          {selectedSession && <div><dt>Project</dt><dd>{selectedSession.project || selectedSession.folder || 'Unassigned session'}</dd>{scope === ALL_PROJECTS && selectedProject && <dd><button type="button" className="vw-inline-link" onClick={exploreSelectedProject}>Explore project<ArrowRight size={12} /></button></dd>}</div>}
          {selectedCommit && <div><dt>Commit</dt><dd><code>{selectedCommit.id.slice(0, 12)}</code> · {stamp(selectedCommit.at)}</dd></div>}
          {selection.branch && <div><dt>Branch</dt><dd><button type="button" className="vw-inline-link" onClick={exploreSelectedProject}><GitBranch size={12} />{selection.branch}</button></dd></div>}
          {selection.placeId && <div><dt>Folder</dt><dd>{selectedPlace?.label || 'Linked folder is no longer available'}</dd>{selectedPlace && <dd className="vw-secondary">{selectedPlace.displayPath}</dd>}{selectedPlace && selectedPlace.counts.items > 0 && <dd className="vw-secondary">{count(selectedPlace.counts.items, 'unsaved change')}</dd>}</div>}
          {selection.component && <div><dt>Component</dt><dd><button type="button" className="vw-inline-link" onClick={() => setView('codebase')}><Network size={12} />{selectedComponent?.label || selection.component}</button></dd>{selectedComponent && <dd className="vw-secondary">{count(selectedComponent.files, 'file')} · {selectedComponent.changed} changed</dd>}</div>}
          {selection.sessionKey && <div><dt>Session</dt><dd>{selectedSession?.appLabel || 'Previously recorded session'}</dd><dd>{selectedSession?.title || short(selection.sessionKey, 56)}</dd>{selectedSession && <><dd className="vw-session-status"><span className={`vw-session-dot ${selectedSession.activity}`} />{selectedSession.stateText}</dd><dd className="vw-secondary">{selectedSession.confidence === 'reported' ? 'Reported state' : 'Inferred state'} · {stamp(selectedSession.updatedAt)}</dd></>}</div>}
        </dl>}
        {selectedSession && <div className="vw-inspector-actions"><button type="button" className="vw-button" onClick={() => setView('trace')}><Route size={13} />View trace</button>{selectedSession.openable !== 'none' && <button type="button" className="vw-button primary" title={selectedSession.openHint} disabled={!bridge || opening} onClick={() => { void openSession(selectedSession); }}><ArrowUpRight size={13} />{opening ? 'Opening…' : selectedSession.openable === 'copy' ? 'Copy resume command' : selectedSession.openable === 'folder' ? 'Show folder' : 'Open session'}</button>}</div>}
        {selectedComponent && <div className="vw-inspector-section"><span className="vw-inspector-kicker">Observed connections</span><ul className="vw-connections">{currentRepository!.codebase.edges.filter(edge => edge.source === selectedComponent.id || edge.target === selectedComponent.id).map(edge => { const imports = edge.source === selectedComponent.id; const other = currentRepository!.codebase.nodes.find(node => node.id === (imports ? edge.target : edge.source)); return <li key={`${edge.source}-${edge.target}`}><span>{imports ? 'Imports' : 'Imported by'}</span><button type="button" className="vw-inline-link" onClick={() => chooseComponent(imports ? edge.target : edge.source)}>{other?.label || (imports ? edge.target : edge.source)} <small>({edge.count})</small></button></li>; })}</ul><p className="vw-footnote">Observed relative imports between source components. Aliases, dynamic paths, and other languages may be absent.</p></div>}
        {selectedGoal && <div className="vw-inspector-section"><span className="vw-inspector-kicker">Recorded intent</span><p>{selectedGoal.parentId ? <>Milestone of <button type="button" className="vw-inline-link" onClick={() => { const parent = goals.find(goal => goal.id === selectedGoal.parentId); if (parent) chooseGoal(parent); }}>{goals.find(goal => goal.id === selectedGoal.parentId)?.title || 'an unavailable goal'}</button>.</> : 'An outcome you explicitly recorded.'}</p>{selectedGoal.dependsOn.length > 0 && <ul className="vw-goal-dependencies">{selectedGoal.dependsOn.map(id => { const dependency = goals.find(goal => goal.id === id); return <li key={id}><span>Depends on</span><button type="button" className="vw-inline-link" disabled={!dependency} onClick={() => { if (dependency) chooseGoal(dependency); }}>{dependency?.title || 'Unavailable goal'}</button>{dependency && <State status={dependency.status} />}</li>; })}</ul>}<p className="vw-footnote">Updated {stamp(selectedGoal.updatedAt)}. Completion is explicitly recorded, never inferred from activity.</p></div>}
        {linkedGoals.length > 0 && <div className="vw-inspector-section"><span className="vw-inspector-kicker">Linked goals</span>{linkedGoals.map(goal => <button type="button" className="vw-related-goal" key={goal.id} onClick={() => chooseGoal(goal)}><Flag size={13} /><span>{goal.title}</span><ArrowRight size={13} /></button>)}</div>}
        {!selectedGoal && !selectedComponent && !selectedSession && <div className="vw-inspector-section vw-how-to"><span className="vw-inspector-kicker">Across projects, into the details</span><p><Flag size={13} />Goals record the outcome.</p><p><Network size={13} />Codebase shows imports.</p><p><GitCommitHorizontal size={13} />Git preserves ancestry.</p><p><ChefHat size={13} />Kitchen brings your sessions together.</p><p><Route size={13} />Trace follows reported events.</p></div>}
      </>}
    </aside></div>
    <footer className="vw-footer"><span className="vw-footer-status" role="status">{notice || (isLoading ? 'Checking local state…' : isSessionView && sessionView ? `${preview && !bridge ? 'Sample snapshot' : 'Checked'} ${stamp(sessionView.checkedAt)}` : currentRepository ? `${preview && !bridge ? 'Sample snapshot' : 'Checked'} ${stamp(currentRepository.scannedAt)}` : 'Local project views')}</span>{!isSessionView && currentRepository?.warnings.length ? <details className="vw-warnings"><summary><CircleAlert size={12} />{count(currentRepository.warnings.length, 'scan note')}</summary><ul>{currentRepository.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details> : <span>{preview && !bridge ? 'Preview edits last until this panel closes' : 'On this Mac · refreshes while visible'}</span>}</footer>
  </div></dialog>;
}
