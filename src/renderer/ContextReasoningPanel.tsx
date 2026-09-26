import React from 'react';
import { CircleAlert, RefreshCw, Sparkles } from 'lucide-react';
import type { ContextInference, ContextReasoningSettings, ContextReasoningView, VisualGoal } from './types';

const ENGINE_NAMES: Record<string, string> = { auto: 'Auto', local: 'Local model', claude: 'Claude', codex: 'Codex' };
const stamp = (at: string) => Number.isFinite(Date.parse(at)) ? new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'earlier';

export function ReasoningEvidence({ inference }: { inference: ContextInference }) {
  return <div className="vw-reasoning-evidence"><p>{inference.summary}</p>
    {inference.evidence.length > 0 && <ul aria-label="Evidence for this inference">{inference.evidence.map((item, index) => <li key={index}>{item}</li>)}</ul>}
    <p className="vw-footnote">{inference.confidence} confidence · {ENGINE_NAMES[inference.engine] || inference.engine}{inference.model ? ` · ${inference.model}` : ''} · {stamp(inference.updatedAt)}</p>
  </div>;
}

export function ContextReasoningPanel({ value, scope, savedGoals = [], busy, error, available, onRefresh, onSettings }: {
  value: ContextReasoningView | null; busy: boolean; error: string; available: boolean;
  scope: { repoId: string | null; label: string } | null;
  savedGoals?: VisualGoal[];
  onRefresh: () => void; onSettings: (patch: Partial<ContextReasoningSettings>) => void;
}) {
  // Older responses have no scope marker; their goals can still be filtered,
  // but their free-form summary must never stand in for a project reading.
  const reading = value && (value.repoId === undefined || value.repoId === (scope?.repoId ?? null)) ? value : null;
  const supportedScope = !scope || Boolean(scope.repoId);
  const running = supportedScope && (reading?.status === 'running' || busy);
  const settings = reading?.settings ?? { enabled: true, engine: 'auto' };
  const problem = supportedScope ? error || reading?.error : null;
  const status = !supportedScope ? 'Choose a Git project to reason about its goals.' : running ? 'Reading the current work…' : !available ? 'Reasoning unavailable' : !settings.enabled ? 'Automatic reasoning is off' : reading?.stale ? 'Context changed since the last reading' : reading?.updatedAt ? `Updated ${stamp(reading.updatedAt)}` : 'Ready to read the current work';
  const openGoals = savedGoals.filter(goal => ['planned', 'working', 'blocked', 'needs-verification'].includes(goal.status) && (!scope || Boolean(scope.repoId && goal.repoId === scope.repoId)));
  const nextGoal = openGoals.find(goal => goal.nextStep?.trim());
  const scopedGoals = scope?.repoId ? (reading?.goals ?? []).filter(goal => goal.repoId === scope.repoId && !['done', 'dismissed', 'deferred'].includes(goal.status)) : [];
  const inferredSummary = scope
    ? scopedGoals.map(goal => goal.title).join(' · ')
    : reading?.summary || '';
  const summary = openGoals.length ? openGoals.map(goal => goal.title).join(' · ') : inferredSummary || (scope
    ? `No inferred goals for ${scope.label} yet.`
    : 'Summon connects recent conversations, app context and project activity to understand your goals as the work develops.');
  return <section className="vw-reasoning" aria-label="Reasoning about your work">
    <div className="vw-reasoning-kicker"><Sparkles size={14} aria-hidden="true" /><span>What you’re working toward{scope ? ` · ${scope.label}` : ' · All projects'}</span></div>
    <p className="vw-reasoning-summary">{summary}</p>
    {openGoals.length > 0 && <><p className="vw-footnote">Open saved goals · Kept until you update their status.</p>{nextGoal && <p><strong>Next step{openGoals.length > 1 ? ` · ${nextGoal.title}` : ''}:</strong> {nextGoal.nextStep}</p>}{inferredSummary && <p className="vw-footnote">Inferred direction: {inferredSummary}</p>}</>}
    <div className="vw-reasoning-controls">
      <label>Reason with<select aria-label="Goal reasoning engine" value={settings.engine} disabled={!available || busy || !supportedScope} onChange={event => onSettings({ engine: event.target.value as ContextReasoningSettings['engine'] })}>{Object.entries(ENGINE_NAMES).map(([id, name]) => <option value={id} key={id}>{name}</option>)}</select></label>
      <label className="vw-reasoning-toggle"><input type="checkbox" checked={settings.enabled} disabled={!available || busy || !supportedScope} onChange={event => onSettings({ enabled: event.target.checked })} />Enable automatic reasoning</label>
      <button type="button" className="vw-button" disabled={!available || busy || running || !settings.enabled || !supportedScope} onClick={onRefresh}><RefreshCw size={13} className={running ? 'vw-spin' : ''} aria-hidden="true" />{running ? 'Reasoning…' : 'Reason now'}</button>
    </div>
    <div className="vw-reasoning-status" role="status"><span>{status}</span>{supportedScope && reading?.engine && <span>{ENGINE_NAMES[reading.engine] || reading.engine}{reading.model ? ` · ${reading.model}` : ''}</span>}</div>
    <p className="vw-footnote">Auto prefers an available local model, then chooses Claude or Codex based on usage limits. Local reasoning stays on this Mac; Claude and Codex receive filtered context excerpts.</p>
    {problem && <p className="vw-reasoning-error" role="alert"><CircleAlert size={14} aria-hidden="true" /><span>{problem}{openGoals.length ? ' Your saved goals are still shown.' : reading?.updatedAt && inferredSummary ? ' The previous reading is still shown.' : ''}</span></p>}
    {!available && <p className="vw-footnote">Quit and reopen Summon to connect this window to goal reasoning.</p>}
  </section>;
}
