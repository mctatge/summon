import React, { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, LoaderCircle, Pencil, RefreshCw, X } from 'lucide-react';
import type { AgentSession, Project, SummonBridge, VisualGoal, VisualRepository, WorkTreeSnapshot } from './types';
import { WorkTree } from './WorkTree';
import { WorkRecordEditor } from './WorkRecordEditor';
import { WorkRecordInspector } from './WorkRecordInspector';
import { WorkRecoveryPanel } from './WorkRecoveryPanel';
import { goalDraft, goalInput, savePreviewGoal, WORK_STATUS, type GoalDraft } from './work-records';
import { previewAgentSessions, previewVisualRepository, previewWorkInFlight } from './preview';
import { childActivityText } from './visual-sessions';
import './visual-workspace.css';
import './work-tree-panel.css';

type Props = { bridge?: SummonBridge; workingProject?: Project };
export function WorkTreePanel(props: Props) { return <ScopedTree key={props.workingProject?.id ?? 'all'} {...props} />; }
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
function previewTree(repoId: string | null): WorkTreeSnapshot {
  const repos = previewWorkInFlight.repos.filter(repo => !repoId || repo.id === repoId || repo.projectId === repoId);
  return { repos, goals: repos.flatMap(repo => previewVisualRepository(repo.id).goals), sessions: previewAgentSessions.groups.flatMap(group => group.sessions).filter(session => !repoId || repos.some(repo => repo.id === session.repoId)), readAt: new Date().toISOString(), warnings: [], externalGoals: [], externalRepos: [] };
}
function ScopedTree({ bridge, workingProject }: Props) {
  const scope = workingProject?.id ?? null;
  const [data, setData] = useState<WorkTreeSnapshot | null>(() => bridge ? null : previewTree(scope));
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<{ kind: 'goal'; id: string } | { kind: 'session'; id: string } | null>(null);
  const [draft, setDraft] = useState<{ repoId: string; value: GoalDraft } | null>(null);
  const [repository, setRepository] = useState<VisualRepository | null>(null);
  const [external, setExternal] = useState<WorkTreeSnapshot | null>(null);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState('');
  const [notice, setNotice] = useState('');
  const alive = useRef(true);
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const editGeneration = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; editGeneration.current++; }; }, []);
  useEffect(() => {
    if (!bridge) return;
    let active = true, pending = false;
    const pull = async () => {
      if (pending || document.visibilityState !== 'visible') return;
      pending = true;
      try { const next = await bridge.workTree({ repoId: scope }); if (active) { setData(next); setError(''); } }
      catch (err) { if (active) setError(message(err)); }
      finally { pending = false; }
    };
    void pull(); const timer = window.setInterval(pull, 8000);
    document.addEventListener('visibilitychange', pull);
    return () => { active = false; clearInterval(timer); document.removeEventListener('visibilitychange', pull); };
  }, [bridge, scope, refresh]);
  const open = Boolean(selected || draft);
  useEffect(() => {
    if (open) { opener.current = document.activeElement as HTMLElement; dialog.current?.showModal(); }
    return () => { if (dialog.current?.open) dialog.current.close(); if (open) opener.current?.focus(); };
  }, [open]);
  const close = () => { if (saving) return; editGeneration.current++; setSelected(null); setDraft(null); setEditError(''); };
  const selectGoal = (goal: VisualGoal) => { editGeneration.current++; setSelected({ kind: 'goal', id: goal.id }); setDraft(null); setEditError(''); };
  const selectSession = (session: AgentSession) => { editGeneration.current++; setSelected({ kind: 'session', id: session.key }); setDraft(null); setEditError(''); };
  const edit = async (repoId: string, goal?: VisualGoal, parentId = '') => {
    const generation = ++editGeneration.current;
    setDraft({ repoId, value: goalDraft(goal, parentId) }); setRepository(null); setEditError(''); setExternal(null);
    try { const next = bridge ? await bridge.visualRepository(repoId) : previewVisualRepository(repoId); if (alive.current && generation === editGeneration.current) setRepository(next); }
    catch (err) { if (alive.current && generation === editGeneration.current) setEditError(message(err)); }
  };
  const loadExternal = async () => {
    try { const next = bridge ? await bridge.workTree() : previewTree(null); if (alive.current) { setExternal(next); setEditError(''); } }
    catch (err) { if (alive.current) setEditError(message(err)); }
  };
  const save = async () => {
    if (!draft || !data || saving) return;
    const pending = draft; setSaving(true); setEditError('');
    try {
      const input = goalInput(pending.value, pending.repoId);
      const saved = bridge ? await bridge.saveVisualGoal(input) : savePreviewGoal(input, data.goals);
      // Commit the successful save locally even if the following refresh fails.
      // A new work item must not be created again merely because a read failed.
      const combined = [...data.goals.filter(item => item.repoId !== pending.repoId), ...saved.filter(item => item.repoId === pending.repoId)];
      let next = { ...data, goals: combined };
      if (bridge) { try { next = await bridge.workTree({ repoId: scope }); } catch (err) { if (alive.current) setError(`Saved. Refresh could not finish: ${message(err)}`); } }
      if (!alive.current) return;
      setData(next); setDraft(null);
      const goal = saved.find(item => pending.value.id ? item.id === pending.value.id : !data.goals.some(old => old.id === item.id));
      setSelected(goal ? { kind: 'goal', id: goal.id } : null); setNotice(bridge ? 'Work saved on this Mac.' : 'Saved in this preview only.');
    } catch (err) { if (alive.current) setEditError(message(err)); }
    finally { if (alive.current) setSaving(false); }
  };
  const goal = selected?.kind === 'goal' ? data?.goals.find(item => item.id === selected.id) : null;
  const session = selected?.kind === 'session' ? data?.sessions.find(item => item.key === selected.id) : null;
  const repo = data?.repos.find(item => item.id === (draft?.repoId ?? goal?.repoId));
  const recoveryRepos = scope ? data?.repos.filter(item => item.id === scope || item.projectId === scope) ?? [] : [];
  return <section className="work-tree-panel" aria-label="Project work tree">
    <div className="work-tree-panel-tools"><span>{scope ? 'Project work' : 'Work across projects'}</span><button className="text-button" aria-label="Refresh work tree" onClick={() => setRefresh(value => value + 1)}><RefreshCw size={13} />Refresh</button></div>
    {error && <p className="work-tree-error" role="alert">{error}</p>}
    {data ? <WorkTree data={data} selectedRepoId={scope} onSelectGoal={selectGoal} onSelectSession={selectSession} onNewGoal={(repoId, parentId) => { void edit(repoId, undefined, parentId); }} /> : <div className="work-tree-loading"><LoaderCircle className="spinner" size={20} /><p>{error ? 'The work tree is unavailable. Refresh to retry.' : 'Reading saved work and agent activity…'}</p></div>}
    {notice && <p role="status" className="work-tree-notice">{notice}</p>}
    {recoveryRepos.length === 1 && <WorkRecoveryPanel key={recoveryRepos[0].id} bridge={bridge} repoId={recoveryRepos[0].id} scopeCurrent={!error} />}
    {open && <dialog className="work-tree-inspector" ref={dialog} onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === dialog.current) close(); }}><header><span>{draft ? 'Edit work' : goal ? 'Work record' : 'Agent session'}</span><button className="icon-button" aria-label="Close work details" disabled={saving} onClick={close}><X size={18} /></button></header>
      {draft && repo && repository ? <WorkRecordEditor draft={draft.value} goals={data!.goals.filter(item => item.repoId === repo.id)} repo={repo} sessions={data!.sessions.filter(item => item.repoId === repo.id)} repository={repository} saving={saving} error={editError} onChange={value => setDraft({ ...draft, value })} onSave={() => { void save(); }} onCancel={close} externalGoals={external?.goals.filter(item => item.repoId !== repo.id)} externalRepos={external?.repos} onLoadExternalGoals={loadExternal} /> : draft ? <div><p>{editError || 'Loading work details…'}</p>{editError && <button className="button" onClick={() => { void edit(draft.repoId, goal ?? undefined, draft.value.parentId); }}>Retry</button>}</div> : goal ? <><h2>{goal.title}</h2><p className="work-tree-status">{WORK_STATUS[goal.status]}</p><button className="button" onClick={() => { void edit(goal.repoId, goal); }}><Pencil size={14} />Edit work</button><WorkRecordInspector goal={goal} goals={data!.goals.filter(item => item.repoId === goal.repoId)} sessions={data!.sessions.filter(item => item.repoId === goal.repoId)} onSelect={selectGoal} />{Boolean(goal.crossRepoDependsOn?.length) && <section className="vw-inspector-section"><span className="vw-inspector-kicker">Dependencies in other projects</span>{goal.crossRepoDependsOn?.map(ref => { const target = [...data!.goals, ...data!.externalGoals].find(item => item.id === ref.goalId && item.repoId === ref.repoId); const project = [...data!.repos, ...data!.externalRepos].find(item => item.id === ref.repoId); return <p key={`${ref.repoId}:${ref.goalId}`}>{project?.name ?? 'Unavailable project'} · {target?.title ?? 'Unavailable dependency'}{target && ` · ${WORK_STATUS[target.status]}`}</p>; })}</section>}</> : session ? <><h2>{session.title}</h2><p>{session.appLabel} · {session.stateText}</p><p className="vw-footnote">{session.reason}</p><p className="vw-footnote">{session.branch ? `Branch: ${session.branch}` : session.placeLabel}</p><button className="button" disabled={!bridge || session.openable === 'none'} onClick={async () => { try { const opened = await bridge!.openAgentSession(session.key); if (alive.current) setEditError(opened?.copied ? 'Resume command copied.' : opened?.shown ? 'Session folder opened.' : 'Session opened.'); } catch (err) { if (alive.current) setEditError(message(err)); } }}>Open session<ArrowUpRight size={14} /></button>{session.children?.length ? <section className="vw-inspector-section"><span className="vw-inspector-kicker">Delegated agents · {session.children.length}</span>{session.children.map(child => <p key={child.key}>{child.label} · {childActivityText(child)}{child.confidence === 'inferred' ? ' · inferred' : ''}</p>)}</section> : <p className="vw-footnote">{session.helpers ? `${session.helpers} helpers inferred from recent activity; their individual state is unavailable.` : 'No delegated agents observed.'}</p>}<p className="vw-footnote">Session activity does not confirm completion of the work.</p>{editError && <p role="status">{editError}</p>}</> : <p>This record is no longer available.</p>}
    </dialog>}
  </section>;
}
