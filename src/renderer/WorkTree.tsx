import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Bot, Check, ChevronDown, ChevronRight, CircleAlert, Focus, FolderGit2, GitBranch, Info, Minus, Pause, Play, Plus, X } from 'lucide-react';
import type { AgentSession, VisualGoal, WorkTreeSnapshot } from './types';
import { buildWorkTreeLayout, goalNodeId, rootNodeId, pointOnConnector, type TreeAgent, type TreeNode } from './work-tree-layout.mjs';
import { fitWorkTree, initialWorkTreeView, resizeWorkTreeView, revealWorkTreeBranch } from './work-tree-camera.mjs';
import { childActivityText } from './visual-sessions';
import { FullscreenButton } from './FullscreenButton';
import { applyMapWheel } from './map-wheel.mjs';
import './work-tree.css';

export type WorkTreeProps = {
  data: WorkTreeSnapshot;
  selectedRepoId: string | null;
  onSelectGoal: (goal: VisualGoal) => void;
  onSelectSession: (session: AgentSession) => void;
  onNewGoal: (repoId: string, parentId?: string) => void;
};
type Viewport = { x: number; y: number; zoom: number };
type Point = { x: number; y: number };
type Child = NonNullable<AgentSession['children']>[number];
type Gesture = { view: Viewport; origin: Point; distance: number; count: number };
const MIN_ZOOM = .005;
const MAX_ZOOM = 2.4;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const STATUS: Record<VisualGoal['status'], string> = { planned: 'Planned', working: 'Working', blocked: 'Blocked', 'needs-verification': 'Needs verification', done: 'Done', deferred: 'Deferred', dismissed: 'Dismissed' };

function ChildBranch({ child, children, selectedId, ancestors = new Set<string>() }: { child: Child; children: Child[]; selectedId: string | null; ancestors?: Set<string> }) {
  const [open, setOpen] = useState(false);
  const nextAncestors = new Set([...ancestors, child.key]);
  const descendants = children.filter(item => item.parentSessionKey === child.key && !nextAncestors.has(item.key));
  return <li className="wt-child" data-active={child.activity === 'working' && !child.endedAt} data-linked={selectedId === child.id}>
    <div className="wt-child-row"><Bot size={15} aria-hidden="true" /><div><strong>{child.label || 'Subagent'}</strong><span>{childActivityText(child)} · {child.confidence}</span></div>{descendants.length > 0 && <button type="button" className="wt-team-toggle" aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${child.label || 'subagent'} team`} onClick={() => setOpen(value => !value)}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<span>{descendants.length}</span></button>}</div>
    {selectedId === child.id && <span className="wt-child-link">Linked to this task</span>}
    {open && <ul className="wt-child-list">{descendants.map(item => <ChildBranch key={item.key} child={item} children={children} selectedId={selectedId} ancestors={nextAncestors} />)}</ul>}
  </li>;
}

function AgentMarker({ agent, open, onToggle, onOpen, onFocus }: { agent: TreeAgent; open: boolean; onToggle: () => void; onOpen: () => void; onFocus: (event: React.FocusEvent) => void }) {
  const direct = agent.children.filter(child => child.parentSessionKey === agent.session.key);
  const linked = agent.children.find(child => child.id === agent.linkedChildId);
  return <div className="wt-agent-anchor" style={{ left: agent.x, top: agent.y }} data-expanded={open} data-active={agent.active} onFocus={onFocus}>
    <button type="button" className="wt-agent" onClick={direct.length ? onToggle : onOpen} aria-expanded={direct.length ? open : undefined} aria-label={direct.length ? `${open ? 'Collapse' : 'Expand'} ${agent.session.appLabel} team for ${agent.session.title}` : `${agent.session.appLabel}: ${agent.session.title}. ${agent.session.stateText}`} title={`${agent.session.title}\n${agent.session.stateText} · ${agent.session.confidence}`}><Bot size={20} aria-hidden="true" /></button>
    <div className="wt-agent-caption"><span>{agent.session.appLabel}</span>{direct.length > 0 ? <button type="button" className="wt-team-toggle" aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${agent.session.appLabel} team, ${agent.children.length} subagents`} onClick={onToggle}>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<span>{agent.children.length}</span></button> : agent.session.helpers > 0 && <span className="wt-helper-count" title="A helper count is available; individual identities are unavailable">+{agent.session.helpers} {agent.session.helpersInferred ? 'inferred' : 'reported'}</span>}</div>
    {linked && !open && <span className="wt-linked-child">{linked.label || 'Subagent'} · linked</span>}
    {open && <section className="wt-team" aria-label={`${agent.session.appLabel} team`}><header><span>Lead · {agent.session.appLabel}</span><button type="button" className="wt-team-toggle" aria-label="Collapse team" onClick={onToggle}><X size={13} /></button></header><ul className="wt-child-list">{direct.map(child => <ChildBranch key={child.key} child={child} children={agent.children} selectedId={agent.linkedChildId} />)}</ul><button type="button" className="wt-team-details" onClick={onOpen}>Session details<ArrowUpRight size={13} /></button></section>}
  </div>;
}

/** One unfolding hierarchy: projects, goals, tasks, and observed agents on their routes. */
export function WorkTree({ data, selectedRepoId, onSelectGoal, onSelectSession, onNewGoal }: WorkTreeProps) {
  const id = useId();
  const canvas = useRef<HTMLElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const zoomOutput = useRef<HTMLOutputElement>(null);
  const transform = useRef<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [paused, setPaused] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [expandedTeams, setExpandedTeams] = useState<Set<string>>(() => new Set());
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(() => new Set(selectedRepoId ? [rootNodeId(selectedRepoId)] : []));
  const pendingBranch = useRef<TreeNode | 'overview' | null>(null);
  const [unlinkedOpen, setUnlinkedOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const layout = useMemo(() => buildWorkTreeLayout(data, { selectedRepoId, expandedNodes, selectedNodeId: selectedNode }), [data, selectedRepoId, expandedNodes, selectedNode]);
  const nodes = useMemo(() => new Map(layout.nodes.map(node => [node.id, node])), [layout]);
  const initialScope = useRef<string | null | undefined>(undefined);
  const previousSize = useRef<{ width: number; height: number } | null>(null);
  const latestLayout = useRef(layout); latestLayout.current = layout;
  const selected = selectedNode ? nodes.get(selectedNode) : null;
  const selectedPath: TreeNode[] = [];
  for (let node = selected; node && !selectedPath.some(item => item.id === node!.id); node = node.parentNodeId ? nodes.get(node.parentNodeId) : undefined) selectedPath.unshift(node);
  const selectedRepo = data.repos.find(repo => repo.id === selectedRepoId);
  const displayRepos = data.repos.filter(repo => !selectedRepoId || repo.id === selectedRepoId);
  const goalCount = layout.totalGoalCount;
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  const dragged = useRef(false);

  const applyTransform = useCallback((value: Viewport) => {
    transform.current = value;
    if (world.current) {
      world.current.style.transform = `translate(${value.x}px, ${value.y}px) scale(${value.zoom})`;
      world.current.style.setProperty('--wt-agent-scale', String(Math.min(1.7, Math.max(1, .72 / value.zoom))));
      world.current.dataset.level = value.zoom < .36 ? 'distant' : value.zoom < .66 ? 'overview' : 'detail';
    }
    if (zoomOutput.current) zoomOutput.current.textContent = `${Math.round(value.zoom * 100)}%`;
  }, []);
  const fit = useCallback(() => {
    const element = viewport.current; if (!element) return;
    applyTransform(fitWorkTree(latestLayout.current, { width: element.clientWidth, height: element.clientHeight }));
  }, [applyTransform]);
  const zoom = useCallback((factor: number, center?: Point) => {
    const element = viewport.current; if (!element) return;
    const previous = transform.current, next = clamp(previous.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const point = center ?? { x: element.clientWidth / 2, y: element.clientHeight / 2 };
    const ratio = next / previous.zoom;
    applyTransform({ zoom: next, x: point.x - (point.x - previous.x) * ratio, y: point.y - (point.y - previous.y) * ratio });
  }, [applyTransform]);
  const focusNode = useCallback((node: TreeNode) => {
    const element = viewport.current; if (!element) return;
    const value = transform.current.zoom;
    applyTransform({ zoom: value, x: element.clientWidth / 2 - (node.x + node.width / 2) * value, y: element.clientHeight / 2 - (node.y + node.height / 2) * value });
  }, [applyTransform]);
  useEffect(() => {
    const element = viewport.current;
    if (!element || initialScope.current === selectedRepoId) return;
    initialScope.current = selectedRepoId;
    const size = { width: element.clientWidth, height: element.clientHeight };
    previousSize.current = size;
    applyTransform(initialWorkTreeView(latestLayout.current, size));
  }, [selectedRepoId, applyTransform]);
  useEffect(() => { setSelectedNode(null); setExpandedTeams(new Set()); setExpandedNodes(new Set(selectedRepoId ? [rootNodeId(selectedRepoId)] : [])); }, [selectedRepoId]);
  useLayoutEffect(() => {
    const previous = pendingBranch.current, element = viewport.current;
    if (!previous || !element) return;
    pendingBranch.current = null;
    const size = { width: element.clientWidth, height: element.clientHeight };
    applyTransform(previous === 'overview' ? initialWorkTreeView(layout, size) : revealWorkTreeBranch(layout, size, transform.current, previous.id, previous));
  }, [layout, applyTransform]);
  useEffect(() => {
    const element = viewport.current; if (!element) return;
    const observer = new ResizeObserver(() => {
      const size = { width: element.clientWidth, height: element.clientHeight };
      if (previousSize.current) applyTransform(resizeWorkTreeView(transform.current, previousSize.current, size));
      previousSize.current = size;
    }); observer.observe(element);
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const bounds = element.getBoundingClientRect();
      applyTransform(applyMapWheel(transform.current, event, { width: element.clientWidth, height: element.clientHeight }, { x: event.clientX - bounds.left, y: event.clientY - bounds.top }));
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => { observer.disconnect(); element.removeEventListener('wheel', wheel); };
  }, [applyTransform]);

  const local = (event: React.PointerEvent): Point => { const rect = viewport.current!.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; };
  const beginGesture = () => {
    const points = [...pointers.current.values()];
    gesture.current = points.length ? { view: { ...transform.current }, count: points.length,
      origin: points.length > 1 ? { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 } : points[0],
      distance: points.length > 1 ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) : 0 } : null;
  };
  const pointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('.wt-team')) return;
    dragged.current = false; pointers.current.set(event.pointerId, local(event)); beginGesture();
    // Capture only the canvas initially: buttons retain ordinary click/focus behavior.
    if (!(event.target as HTMLElement).closest('button')) { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.focus({ preventScroll: true }); }
  };
  const pointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId) || !gesture.current) return;
    pointers.current.set(event.pointerId, local(event));
    const points = [...pointers.current.values()], start = gesture.current;
    if (points.length > 1 && start.count > 1) {
      const middle = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
      const next = clamp(start.view.zoom * Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) / Math.max(1, start.distance), MIN_ZOOM, MAX_ZOOM);
      const ratio = next / start.view.zoom;
      dragged.current = true;
      applyTransform({ zoom: next, x: middle.x - (start.origin.x - start.view.x) * ratio, y: middle.y - (start.origin.y - start.view.y) * ratio });
    } else {
      const dx = points[0].x - start.origin.x, dy = points[0].y - start.origin.y;
      if (Math.hypot(dx, dy) > 5) dragged.current = true;
      if (dragged.current) applyTransform({ ...start.view, x: start.view.x + dx, y: start.view.y + dy });
    }
    if (dragged.current) { event.currentTarget.setPointerCapture(event.pointerId); setDragging(true); }
  };
  const pointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId); beginGesture();
    if (!pointers.current.size) setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const keyboard = (event: React.KeyboardEvent) => {
    if ((event.target as HTMLElement).closest('input,select,textarea')) return;
    const movement: Record<string, Point> = { ArrowLeft: { x: 64, y: 0 }, ArrowRight: { x: -64, y: 0 }, ArrowUp: { x: 0, y: 64 }, ArrowDown: { x: 0, y: -64 } };
    if (movement[event.key]) { event.preventDefault(); const delta = movement[event.key]; applyTransform({ ...transform.current, x: transform.current.x + delta.x, y: transform.current.y + delta.y }); }
    else if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(1.25); }
    else if (event.key === '-') { event.preventDefault(); zoom(.8); }
    else if (event.key === '0' || event.key === 'Home') { event.preventDefault(); fit(); }
    else if (event.key === 'Escape') { setExpandedTeams(new Set()); setSelectedNode(null); }
  };
  const revealFocused = (event: React.FocusEvent, node: TreeNode) => {
    if (pointers.current.size || (event.target as HTMLElement).closest('.wt-team')) return;
    const target = event.currentTarget.getBoundingClientRect(), bounds = viewport.current?.getBoundingClientRect();
    if (bounds && (target.left < bounds.left || target.right > bounds.right || target.top < bounds.top || target.bottom > bounds.bottom)) focusNode(node);
  };
  const selectGoal = (node: TreeNode) => { setSelectedNode(node.id); if (node.goal) onSelectGoal(node.goal); };
  const toggleBranch = (node: TreeNode) => {
    const next = new Set(expandedNodes);
    const parentOf = new Map(data.goals.map(goal => [goalNodeId(goal.repoId, goal.id), goal.parentId ? goalNodeId(goal.repoId, goal.parentId) : rootNodeId(goal.repoId)]));
    const removeBranch = (branchId: string) => {
      const removed = new Set([branchId]);
      for (let changed = true; changed;) {
        changed = false;
        for (const [child, parent] of parentOf) if (removed.has(parent) && !removed.has(child)) { removed.add(child); changed = true; }
      }
      for (const key of removed) next.delete(key);
    };
    if (node.expanded) removeBranch(node.id);
    else {
      // Open one sibling branch at a time, retaining the path above it.
      for (const sibling of layout.nodes) if (sibling.id !== node.id && sibling.parentNodeId === node.parentNodeId) removeBranch(sibling.id);
      next.add(node.id);
    }
    pendingBranch.current = node;
    setSelectedNode(node.id); setExpandedNodes(next); setExpandedTeams(new Set());
  };
  const collapseBranches = () => {
    pendingBranch.current = 'overview';
    setExpandedNodes(new Set(selectedRepoId ? [rootNodeId(selectedRepoId)] : [])); setSelectedNode(null); setExpandedTeams(new Set());
  };
  const revealBranch = (node: TreeNode) => {
    pendingBranch.current = node; setSelectedNode(node.id); setExpandedNodes(new Set(expandedNodes));
  };
  const badge = (goal: VisualGoal) => {
    const repo = data.repos.find(item => item.id === goal.repoId), place = repo?.places.find(item => item.id === goal.links?.placeId);
    return goal.links?.branch || place?.branch || (place && place.kind !== 'main' ? place.label || 'Worktree' : null);
  };

  return <section ref={canvas} className="work-tree" aria-labelledby={`${id}-title`} data-paused={paused}>
    <header className="wt-heading"><div><h2 id={`${id}-title`}>{selectedRepo?.name ? `${selectedRepo.name} work tree` : selectedRepoId ? 'Project work tree' : 'Work tree'}</h2><p>Open a branch to follow the work.</p></div><nav className="wt-levels" aria-label="Work hierarchy">{selectedPath.length ? selectedPath.map((node, index) => <React.Fragment key={node.id}>{index > 0 && <ChevronRight size={12} />}<button type="button" className="wt-crumb" onClick={() => revealBranch(node)} title={node.label} aria-label={`Show branch ${node.label}`}>{node.label}</button></React.Fragment>) : <>Projects<ChevronRight size={12} />Goals<ChevronRight size={12} />Tasks</>}</nav><span className="wt-count">{goalCount} {goalCount === 1 ? 'item' : 'items'}{layout.collapsedCount > 0 && ` · ${layout.collapsedCount} collapsed`}</span></header>
    <div className="wt-toolbar" onKeyDown={keyboard}><div className="wt-tools"><FullscreenButton target={canvas} label="Work map" /><button type="button" className="wt-control" onClick={() => zoom(.8)} aria-label="Zoom out"><Minus size={15} /></button><output ref={zoomOutput} className="wt-zoom" aria-label="Zoom level">100%</output><button type="button" className="wt-control" onClick={() => zoom(1.25)} aria-label="Zoom in"><Plus size={15} /></button><button type="button" className="wt-control" onClick={fit}><Focus size={14} />Fit view</button>{expandedNodes.size > 0 && <button type="button" className="wt-control" onClick={collapseBranches}>Collapse branches</button>}{selected?.goal && <button type="button" className="wt-control" onClick={() => selectGoal(selected)}><Info size={14} />Task details</button>}</div><button type="button" className="wt-control" aria-pressed={paused} onClick={() => setPaused(value => !value)} aria-label={paused ? 'Play activity animation' : 'Pause activity animation'}>{paused ? <Play size={13} /> : <Pause size={13} />}{paused ? 'Play' : 'Pause'}</button></div>
    {layout.warnings.length > 0 && <details className="wt-warnings"><summary><CircleAlert size={13} />{layout.warnings.length === 1 ? layout.warnings[0] : `${layout.warnings.length} readings need attention`}</summary>{layout.warnings.length > 1 && <ul>{layout.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}</details>}
    <div ref={viewport} className={`wt-viewport${dragging ? ' is-dragging' : ''}`} tabIndex={0} role="region" aria-label="Interactive work map" aria-describedby={`${id}-help`} onKeyDown={keyboard} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={pointerEnd} onLostPointerCapture={event => { if (pointers.current.has(event.pointerId)) { pointers.current.delete(event.pointerId); beginGesture(); setDragging(false); } }} onClickCapture={event => { if (dragged.current) { event.preventDefault(); event.stopPropagation(); dragged.current = false; } }}>
      <div ref={world} className="wt-world" style={{ width: layout.width, height: layout.height }}>
        <svg className="wt-edges" width={layout.width} height={layout.height} aria-hidden="true">
          {layout.edges.map(edge => <path key={edge.id} className={`wt-edge wt-edge-${edge.kind}${edge.cycle ? ' wt-edge-cycle' : ''}`} d={edge.path} />)}
          {layout.agents.filter(agent => agent.active).map(agent => <g key={agent.id}><path className="wt-activity-wash" d={agent.path} /><path className="wt-activity-flow" d={agent.path} /></g>)}
        </svg>
        {layout.edges.filter(edge => !['root', 'hierarchy'].includes(edge.kind)).map(edge => {
          const point = pointOnConnector(edge, .5);
          return <span key={edge.id} className={`wt-edge-label${edge.cycle ? ' is-warning' : ''}`} style={{ left: point.x, top: point.y }} title={edge.cycle ? 'Circular connection; review task dependencies' : edge.label}>{edge.cycle ? 'Review cycle' : edge.label}</span>;
        })}
        {layout.nodes.map(node => node.kind === 'root' ? <article key={node.id} className="wt-project" data-expanded={node.expanded} style={{ left: node.x, top: node.y, width: node.width, height: node.height }}>
          <button type="button" className="wt-project-main" aria-expanded={node.childCount ? node.expanded : undefined} aria-label={node.childCount ? `${node.expanded ? 'Collapse' : 'Expand'} project ${node.label}` : `Add first task to ${node.label}`} onClick={() => node.childCount ? toggleBranch(node) : onNewGoal(node.repoId)} onFocus={event => revealFocused(event, node)}><span className="wt-project-name"><FolderGit2 size={18} /><strong>{node.label}</strong>{node.childCount > 0 && <ChevronRight size={16} className="wt-disclosure" />}</span><span className="wt-project-summary">{node.totalCount ? `${node.totalCount} work ${node.totalCount === 1 ? 'item' : 'items'}` : 'No work yet'}{node.activeCount > 0 && <span className="wt-active-count"> · {node.activeCount} active</span>}</span></button>
          <button type="button" className="wt-root-add" onClick={() => onNewGoal(node.repoId)} aria-label={`Add a task to ${node.label}`}><Plus size={16} /></button>
        </article>
          : node.kind === 'external' ? <div key={node.id} className="wt-task wt-external" style={{ left: node.x, top: node.y, width: node.width, height: node.height }} title={`${node.label} · ${node.projectName}`}><span className="wt-status">{node.detail} · {node.projectName}</span><strong>{node.label}</strong></div>
            : <article key={node.id} className="wt-task wt-hierarchy-task" data-status={node.goal!.status} data-selected={selectedNode === node.id} data-expanded={node.expanded} style={{ left: node.x, top: node.y, width: node.width, height: node.height }}>
              <button type="button" className="wt-task-main" aria-expanded={node.childCount ? node.expanded : undefined} aria-pressed={node.childCount ? undefined : selectedNode === node.id} aria-label={node.childCount ? `${node.expanded ? 'Collapse' : 'Expand'} ${node.label}, ${node.childCount} tasks` : `${node.label}. ${STATUS[node.goal!.status]}`} onClick={() => node.childCount ? toggleBranch(node) : setSelectedNode(node.id)} onFocus={event => revealFocused(event, node)} title={node.label}><span className="wt-status">{node.goal!.status === 'working' ? <span className="wt-status-dot" /> : node.goal!.status === 'done' ? <Check size={12} /> : null}{STATUS[node.goal!.status]}{node.childCount > 0 && <ChevronRight size={14} className="wt-disclosure" />}</span><strong>{node.label}</strong>{badge(node.goal!) && <span className="wt-worktree"><GitBranch size={11} aria-hidden="true" />{badge(node.goal!)}</span>}</button>
              <footer className="wt-task-footer"><span>{node.childCount ? `${node.childCount} tasks` : node.dependencyCount ? `${node.dependencyCount} ${node.dependencyCount === 1 ? 'dependency' : 'dependencies'}` : node.activeCount ? 'Agent working' : 'Task'}</span><button type="button" className="wt-add-child" onClick={() => onNewGoal(node.repoId, node.goal!.id)} aria-label={`Add task under ${node.label}`} title="Add a child task"><Plus size={13} /></button><button type="button" onClick={() => selectGoal(node)} aria-label={`Details for ${node.label}`}>Details<ArrowUpRight size={12} /></button></footer>
            </article>)}
        {layout.agents.map(agent => <AgentMarker key={agent.id} agent={agent} open={expandedTeams.has(agent.id)} onToggle={() => setExpandedTeams(value => { const next = new Set(value); if (next.has(agent.id)) next.delete(agent.id); else next.add(agent.id); return next; })} onOpen={() => onSelectSession(agent.session)} onFocus={event => revealFocused(event, { ...nodes.get(agent.nodeId)!, x: agent.x - 20, y: agent.y - 20, width: 40, height: 40 })} />)}
      </div>
      {goalCount === 0 && <div className="wt-empty"><FolderGit2 size={28} /><strong>{displayRepos.length ? 'Give the work a place to start.' : 'Choose a connected project to begin.'}</strong><p>Add a goal, then group its tasks underneath it.</p>{displayRepos.length === 1 && <button type="button" className="wt-control" onClick={() => onNewGoal(displayRepos[0].id)}><Plus size={14} />Add first task</button>}</div>}
    </div>
    <footer className="wt-footer"><span id={`${id}-help`}>Drag or two-finger scroll to pan · pinch to zoom · arrows to move · 0 to fit</span><span className="wt-legend"><i />Live activity · not % complete</span></footer>
    {layout.hiddenCount > 0 && <p className="wt-limit">{layout.hiddenCount} more tasks are outside this map’s 180-task limit. Select a project to narrow the view.</p>}
    {layout.unlinkedSessions.length > 0 && <section className="wt-unlinked"><button type="button" className="wt-unlinked-heading" aria-expanded={unlinkedOpen} onClick={() => setUnlinkedOpen(value => !value)}>{unlinkedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<span>{layout.unlinkedSessions.length} {layout.unlinkedSessions.length === 1 ? 'session' : 'sessions'} without a task link</span></button>{unlinkedOpen && <><p>Link a session from a task’s details to place its agent on the tree.</p><div className="wt-session-list">{layout.unlinkedSessions.map(session => <button type="button" key={session.key} className="wt-session" onClick={() => onSelectSession(session)}><Bot size={17} /><span><strong>{session.title}</strong><small>{session.appLabel}{!selectedRepoId && session.project ? ` · ${session.project}` : ''} · {session.stateText}</small></span></button>)}</div></>}</section>}
  </section>;
}

export default WorkTree;
