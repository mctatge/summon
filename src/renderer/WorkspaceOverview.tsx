import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ArrowUpRight, Bot, CircleAlert, GitBranch, LoaderCircle } from 'lucide-react';
import { previewAgentSessions, previewWorkInFlight } from './preview';
import type { AgentSession, AgentSessionGroupId, AgentSessionsView, SummonBridge, UsageReport, UsageView, WifRepo, WorkInFlight } from './types';

type OverviewProps = { bridge: SummonBridge | undefined; preview: boolean; onOpen: () => void };
const POLL_MS = 25_000;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const date = (value: string | null | undefined) => value ? Date.parse(value) : NaN;
const stamp = (value: string) => Number.isFinite(date(value)) ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'time unavailable';

/** The overview only reads local views. It never starts grouping or changes a read watermark. */
function useOverviewRead<T>(reader: (() => Promise<T>) | undefined, sample: T, preview: boolean) {
  const [view, setView] = useState<T | null>(preview ? sample : null);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(!preview && Boolean(reader));
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let active = true;
    let pending = false;
    setView(preview ? sample : null);
    setError('');
    setChecking(!preview && Boolean(reader));
    const read = async () => {
      if (!active || pending || document.visibilityState !== 'visible') return;
      setNow(Date.now());
      if (preview || !reader) return;
      pending = true;
      try {
        const next = await reader();
        if (active) { setView(next); setError(''); setNow(Date.now()); }
      } catch (problem) {
        if (active) setError(message(problem));
      } finally {
        pending = false;
        if (active) setChecking(false);
      }
    };
    void read();
    const timer = window.setInterval(() => void read(), POLL_MS);
    document.addEventListener('visibilitychange', read);
    return () => { active = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', read); };
  }, [reader, sample, preview]);
  return { view, error, checking, now };
}

function CardHeading({ title, subtitle, onOpen, action = 'View all', id }: { title: string; subtitle: string; onOpen: () => void; action?: string; id: string }) {
  return <div className="workspace-card-heading"><div><h2 id={id}>{title}</h2><p>{subtitle}</p></div><button type="button" className="workspace-card-link" onClick={onOpen} aria-label={`${action}: ${title}`}>{action}<ArrowUpRight size={13} aria-hidden="true" /></button></div>;
}

function ReadState({ error, checking, hasView, unavailable }: { error: string; checking: boolean; hasView: boolean; unavailable: boolean }) {
  if (error) return <p className="workspace-card-note" data-tone="warning" role="status"><CircleAlert size={14} aria-hidden="true" />{hasView ? 'Refresh failed; showing the last reading. ' : 'Could not check. '}{error}</p>;
  if (checking && !hasView) return <p className="workspace-card-empty" role="status"><LoaderCircle size={16} className="spinner" aria-hidden="true" />Checking on this Mac…</p>;
  if (unavailable) return <p className="workspace-card-empty">Open the installed app to read your working context.</p>;
  return null;
}

const repoRank: Record<WifRepo['status'], number> = { attention: 0, error: 1, work: 2, clean: 3 };
function repoCounts(repo: WifRepo) {
  const changes = repo.places.reduce((sum, place) => sum + (place.mirrorOf || place.missing || place.error ? 0 : place.counts.items), 0);
  const branches = repo.branches.filter(branch => !branch.merged).length;
  return [changes ? plural(changes, 'unsaved change') : '', branches ? plural(branches, 'open branch', 'open branches') : '', repo.stashes.length ? `${repo.stashes.length} set aside` : ''].filter(Boolean).join(' · ');
}

export function WorkOverviewCard({ bridge, preview, onOpen }: OverviewProps) {
  const id = useId();
  const canRead = !preview && typeof bridge?.workInFlight === 'function';
  const reader = useCallback(() => bridge!.workInFlight(), [bridge]);
  const { view, error, checking, now } = useOverviewRead<WorkInFlight>(canRead ? reader : undefined, previewWorkInFlight, preview);
  const repos = view ? [...view.repos].filter(repo => repo.status !== 'clean').sort((a, b) => repoRank[a.status] - repoRank[b.status] || a.name.localeCompare(b.name)) : [];
  const stale = !preview && Boolean(view && (!Number.isFinite(date(view.scannedAt)) || now - date(view.scannedAt) > 90_000));
  const warning = view?.errors[0];
  return <section className="workspace-card workspace-work-card" aria-labelledby={id}>
    <CardHeading id={id} title="Work in flight" subtitle={view ? `${plural(view.totals.reposWithWork, 'project')} with unfinished work` : 'Unfinished work across your projects'} onOpen={onOpen} />
    <ReadState error={error} checking={checking} hasView={Boolean(view)} unavailable={!preview && !canRead} />
    {view && <>
      {stale && !error && <p className="workspace-card-note" data-tone="warning">Last scan is out of date. Checking again while this window is visible.</p>}
      {warning && <p className="workspace-card-note" data-tone="warning">{warning}</p>}
      {repos.length ? <div className="workspace-summary-list">{repos.slice(0, 3).map(repo => <button type="button" className="workspace-summary-row" key={repo.id} onClick={onOpen} aria-label={`View work in flight: ${repo.name}`}>
        <span className="workspace-row-icon"><GitBranch size={17} aria-hidden="true" /></span>
        <span className="workspace-row-copy"><strong>{repo.name}</strong><small>{repo.error || repo.headline}</small>{!repo.error && <span className="workspace-row-status" data-state={repo.status}>{repoCounts(repo) || (repo.status === 'attention' ? 'Needs a look' : 'Unfinished work')}{repo.places.some(place => place.grouping?.stale) ? ' · Grouping needs refresh' : ''}</span>}</span>
        <ArrowUpRight size={14} className="workspace-row-arrow" aria-hidden="true" />
      </button>)}</div> : <p className="workspace-card-empty">{warning ? 'No unfinished work in the projects that could be checked.' : view.repos.length ? 'Everything checked is saved and shared.' : 'No repositories found yet. Add a workspace to get started.'}</p>}
      <p className="workspace-card-footer">{preview ? 'Sample projects' : `Scanned ${stamp(view.scannedAt)}`}{repos.length > 3 ? ` · ${repos.length - 3} more in the full view` : ''}</p>
    </>}
  </section>;
}

const groupRank: Record<AgentSessionGroupId, number> = { 'needs-you': 0, new: 1, working: 2, open: 3, interrupted: 4, recent: 5 };

export function SessionsOverviewCard({ bridge, preview, onOpen, onView }: OverviewProps & { onView?: (view: AgentSessionsView) => void }) {
  const id = useId();
  const canRead = !preview && typeof bridge?.agentSessions === 'function';
  const reader = useCallback(() => bridge!.agentSessions(), [bridge]);
  const { view, error, checking, now } = useOverviewRead<AgentSessionsView>(canRead ? reader : undefined, previewAgentSessions, preview);
  const [opening, setOpening] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const alive = useRef(true);
  const reportView = useRef(onView);
  reportView.current = onView;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (view) reportView.current?.(view); }, [view]);
  const sessions = view ? [...view.groups].sort((a, b) => groupRank[a.id] - groupRank[b.id]).filter(group => group.id !== 'recent').flatMap(group => group.sessions) : [];
  const stale = !preview && Boolean(view && (!Number.isFinite(date(view.checkedAt)) || now - date(view.checkedAt) > 90_000));
  const openSession = async (session: AgentSession) => {
    // Folder/copy-only targets need their explicitly labelled action in the full board.
    if (preview || session.openable !== 'link' || typeof bridge?.openAgentSession !== 'function') { onOpen(); return; }
    if (opening) return;
    setOpening(session.key); setNotice('');
    try {
      const result = await bridge.openAgentSession(session.key);
      if (alive.current) setNotice(result?.opened ? `Opened ${session.appLabel}.` : result?.shown ? 'Showing the session folder in Finder.' : result?.copied ? 'Resume command copied. Paste it in Terminal.' : 'Open request sent.');
    } catch (problem) { if (alive.current) setNotice(message(problem)); }
    finally { if (alive.current) setOpening(null); }
  };
  return <section className="workspace-card workspace-sessions-card" aria-labelledby={id}>
    <CardHeading id={id} title="Agent sessions" subtitle={view ? `${view.totals.needsYou} need${view.totals.needsYou === 1 ? 's' : ''} you · ${view.totals.working} working` : 'The sessions that need your attention'} onOpen={onOpen} />
    <ReadState error={error} checking={checking} hasView={Boolean(view)} unavailable={!preview && !canRead} />
    {view && <>
      {stale && !error && <p className="workspace-card-note" data-tone="warning">Session states may be out of date.</p>}
      {view.warnings[0] && <p className="workspace-card-note" data-tone="warning">{view.warnings[0]}</p>}
      {sessions.length ? <div className="workspace-summary-list">{sessions.slice(0, 3).map(session => {
        const direct = !preview && session.openable === 'link' && typeof bridge?.openAgentSession === 'function';
        return <button type="button" className="workspace-summary-row" key={session.key} onClick={() => void openSession(session)} disabled={Boolean(opening)} aria-label={`${direct ? session.openHint : 'View session options'}: ${session.title}`}>
          <span className="workspace-row-icon">{opening === session.key ? <LoaderCircle size={17} className="spinner" aria-hidden="true" /> : <Bot size={17} aria-hidden="true" />}</span>
          <span className="workspace-row-copy"><strong>{session.title}</strong><small>{[session.appLabel, session.project].filter(Boolean).join(' · ')}</small><span className="workspace-row-status" data-state={session.group}>{session.stateText}{session.helpers ? ` · ${plural(session.helpers, 'helper')}` : ''}</span></span>
          <ArrowUpRight size={14} className="workspace-row-arrow" aria-hidden="true" />
        </button>;
      })}</div> : <p className="workspace-card-empty">{view.sources.some(source => source.available) ? 'No sessions need attention right now.' : 'No agent sources are available yet.'}</p>}
      <p className="workspace-card-footer">{preview ? 'Sample sessions' : `Checked ${stamp(view.checkedAt)}`}{sessions.length > 3 ? ` · ${sessions.length - 3} more in the full view` : ''}</p>
    </>}
    {notice && <p className="workspace-card-note" role="status">{notice}</p>}
  </section>;
}

const unavailableUsage = (report: UsageReport | null) => !report ? 'No reading yet.' : ({ not_signed_in: 'Not signed in. Open Usage for sign-in details.', not_installed: 'CLI not installed.', not_applicable: 'No subscription limits reported.', error: report.error || 'Usage could not be read.', ok: 'No usage windows reported.' })[report.status];

export function UsageOverviewCard({ usage, onOpen }: { usage?: UsageView; onOpen: () => void }) {
  const id = useId();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible') setNow(Date.now()); };
    const timer = window.setInterval(tick, 30_000);
    document.addEventListener('visibilitychange', tick);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, []);
  return <section className="workspace-card workspace-usage-card" aria-labelledby={id}>
    <CardHeading id={id} title="Room to keep going" subtitle="Subscription usage" onOpen={onOpen} action="Details" />
    {(['claude', 'codex'] as const).map(provider => {
      const report = usage?.providers[provider] ?? null;
      const name = provider === 'claude' ? 'Claude' : 'Codex';
      const stale = Boolean(report && (report.stale || !Number.isFinite(date(report.fetchedAt)) || now - date(report.fetchedAt) > 20 * 60_000));
      return <div className="workspace-provider" key={provider}>
        <div className="workspace-provider-heading"><strong>{name}</strong><span>{usage?.refreshing.includes(provider) ? 'Refreshing…' : stale ? 'Stale reading' : report?.status === 'ok' ? 'Current' : ''}</span></div>
        {report?.status === 'ok' && report.windows.length ? report.windows.map(window => {
          const known = typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent);
          const remaining = known ? Math.max(0, Math.min(100, 100 - window.usedPercent)) : null;
          const reset = date(window.resetsAt);
          const elapsed = Number.isFinite(reset) && reset <= now;
          return <div className="workspace-usage-window" key={window.id}>
            <div className="workspace-usage-label"><span>{window.label}</span><strong>{remaining === null ? 'Unknown' : `${Math.round(remaining)}% remaining`}</strong></div>
            {remaining !== null && <div className="workspace-usage-track" data-stale={stale || elapsed} role="meter" aria-label={`${name} ${window.label} allowance remaining${stale || elapsed ? ', last reading' : ''}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(remaining)}><span style={{ width: `${remaining}%` }} /></div>}
            <small className="workspace-usage-reset">{elapsed ? 'Reset time passed; awaiting the next reading.' : Number.isFinite(reset) ? `Resets ${stamp(window.resetsAt!)}` : 'Reset time unavailable.'}</small>
          </div>;
        }) : <p className="workspace-card-note">{unavailableUsage(report)}</p>}
      </div>;
    })}
    {usage?.problem && <p className="workspace-card-note" data-tone="warning">{usage.problem}</p>}
    <p className="workspace-card-footer">Reported by your CLIs. Unknown usage stays unknown.</p>
  </section>;
}
