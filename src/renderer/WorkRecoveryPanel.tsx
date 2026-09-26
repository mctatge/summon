import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, RefreshCw, Undo2 } from 'lucide-react';
import type { SummonBridge, WorkRecoverySnapshot } from './types';
import './work-recovery.css';

type Props = { bridge?: SummonBridge; repoId: string; scopeCurrent: boolean };
type Action = { kind: 'enabled'; enabled: boolean } | { kind: 'scan' } | { kind: 'review'; id: string; reviewed: boolean };
const PAGE_SIZE = 20;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const time = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Unknown time';

export function WorkRecoveryPanel({ bridge, repoId, scopeCurrent }: Props) {
  const [data, setData] = useState<WorkRecoverySnapshot | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [includeReviewed, setIncludeReviewed] = useState(false);
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const mounted = useRef(true);
  const pending = useRef(false);
  const generation = useRef(0);
  const current = useRef({ repoId, scopeCurrent });
  current.current = { repoId, scopeCurrent };
  const available = Boolean(bridge?.workRecovery && bridge.setWorkRecoveryEnabled && bridge.scanWorkRecovery && bridge.reviewWorkRecovery);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  useEffect(() => {
    if (!available || !scopeCurrent) return;
    let active = true;
    const pull = async () => {
      if (pending.current || document.visibilityState !== 'visible') return;
      const request = ++generation.current;
      pending.current = true; setBusy(true);
      try {
        const next = await bridge!.workRecovery!({ repoId, offset, limit: PAGE_SIZE, includeReviewed });
        if (next.repoId !== repoId) throw new Error('Recovery returned a different project. Refresh the work tree to retry.');
        if (active && mounted.current && request === generation.current) { setData(next); setError(''); }
      } catch (err) { if (active && mounted.current && request === generation.current) setError(message(err)); }
      finally { pending.current = false; if (mounted.current) setBusy(false); }
    };
    void pull();
    const timer = window.setInterval(pull, 15000);
    document.addEventListener('visibilitychange', pull);
    return () => { active = false; clearInterval(timer); document.removeEventListener('visibilitychange', pull); };
  }, [available, bridge, repoId, scopeCurrent, offset, includeReviewed, refresh]);

  const act = async (action: Action) => {
    if (!available || !scopeCurrent || pending.current || data?.repoId !== repoId) return;
    const request = ++generation.current;
    pending.current = true; setBusy(true); setError('');
    try {
      const next = action.kind === 'enabled' ? await bridge!.setWorkRecoveryEnabled!({ repoId, enabled: action.enabled })
        : action.kind === 'scan' ? await bridge!.scanWorkRecovery!({ repoId })
          : await bridge!.reviewWorkRecovery!({ repoId, id: action.id, reviewed: action.reviewed });
      if (next.repoId !== repoId) throw new Error('Recovery returned a different project. Refresh the work tree to retry.');
      if (mounted.current && request === generation.current && current.current.repoId === repoId && current.current.scopeCurrent) {
        // Mutation snapshots contain the first pending page. Keep the view consistent
        // even when a follow-up read fails, and never repeat a successful write.
        setData(next); setOffset(0); setIncludeReviewed(false);
      }
    } catch (err) { if (mounted.current && request === generation.current && current.current.repoId === repoId) setError(message(err)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  return <WorkRecoveryView data={data?.repoId === repoId ? data : null} available={available} scopeCurrent={scopeCurrent} busy={busy} error={error} includeReviewed={includeReviewed} offset={offset}
    onEnabled={enabled => { void act({ kind: 'enabled', enabled }); }} onScan={() => { void act({ kind: 'scan' }); }}
    onRefresh={() => setRefresh(value => value + 1)} onReview={(id, reviewed) => { void act({ kind: 'review', id, reviewed }); }}
    onIncludeReviewed={value => { setIncludeReviewed(value); setOffset(0); }} onPage={setOffset} />;
}

type ViewProps = {
  data: WorkRecoverySnapshot | null; available: boolean; scopeCurrent: boolean; busy: boolean; error: string;
  includeReviewed: boolean; offset: number; onEnabled: (enabled: boolean) => void; onScan: () => void;
  onRefresh: () => void; onReview: (id: string, reviewed: boolean) => void; onIncludeReviewed: (value: boolean) => void; onPage: (offset: number) => void;
};
export function WorkRecoveryView({ data, available, scopeCurrent, busy, error, includeReviewed, offset, onEnabled, onScan, onRefresh, onReview, onIncludeReviewed, onPage }: ViewProps) {
  const disabled = busy || !available || !scopeCurrent;
  return <section className="work-recovery" aria-label="Conversation recovery" aria-busy={busy}>
    <header className="work-recovery-header"><h2>Conversation recovery</h2>{data && <span className="work-recovery-count">{data.pending} unreviewed</span>}<button className="text-button" disabled={disabled} onClick={onRefresh} aria-label="Refresh conversation recovery"><RefreshCw size={13} className={busy ? 'spinner' : undefined} />Refresh</button></header>
    <p className="work-recovery-help">Keeps new Claude and Codex user messages and final replies on this Mac. Excerpts are unreviewed context, not confirmed tasks.</p>
    <label className="work-recovery-toggle"><input type="checkbox" checked={data?.enabled ?? false} disabled={disabled || !data} onChange={event => onEnabled(event.target.checked)} />Capture new conversation excerpts</label>
    <p className="work-recovery-help">{data?.enabled ? `Enabled for this project${data.enabledAt ? ` since ${time(data.enabledAt)}` : ''}.` : 'Off until enabled for this project. Earlier history is not imported.'} No model is called.</p>
    {!available && <p className="work-recovery-help">Conversation recovery requires the updated desktop app.</p>}
    {!scopeCurrent && <p className="work-recovery-warning" role="status">Project scope could not be refreshed. Refresh the work tree before changing recovery.</p>}
    {error && <p className="work-recovery-warning" role="alert">{error}{data ? ' Previously read excerpts are still shown.' : ''}</p>}
    {data?.error && <p className="work-recovery-warning" role="alert">{data.error}</p>}
    {data?.paused && <p className="work-recovery-warning" role="status">Capture is paused. Saved excerpts remain available.</p>}
    {!!data?.warnings.length && <ul className="work-recovery-warnings" aria-label="Recovery coverage warnings">{data.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
    {data ? <>
      <div className="work-recovery-tools"><span>{data.checkedAt ? `Last checked ${time(data.checkedAt)}` : 'Not checked yet'} · {data.sources} {data.sources === 1 ? 'source' : 'sources'}</span><button className="text-button" disabled={disabled || !data.enabled || data.paused} onClick={onScan}>Check now</button><label><input type="checkbox" checked={includeReviewed} disabled={disabled} onChange={event => onIncludeReviewed(event.target.checked)} />Show reviewed</label></div>
      {data.items.length ? <ol className="work-recovery-items">{data.items.map(item => <li key={item.id}>
        <details><summary><span className="work-recovery-source">{item.provider === 'claude' ? 'Claude' : 'Codex'} · {item.role === 'user' ? 'User message' : 'Final reply'} · {time(item.at ?? item.capturedAt)}{item.reviewedAt ? ' · Reviewed' : ''}</span><span className="work-recovery-preview">{item.text.slice(0, 160)}{item.text.length > 160 ? '…' : ''}</span></summary><div className="work-recovery-body"><p className="work-recovery-text">{item.text}</p>{item.truncated && <p className="work-recovery-help">This excerpt was shortened. It does not contain the full message.</p>}<p className="work-recovery-session">Session: {item.sessionKey}</p><button className="text-button" disabled={disabled} onClick={() => onReview(item.id, !item.reviewedAt)}>{item.reviewedAt ? <Undo2 size={13} /> : <Check size={13} />}{item.reviewedAt ? 'Mark unreviewed' : 'Mark reviewed'}</button></div></details>
      </li>)}</ol> : <p className="work-recovery-empty">{includeReviewed ? 'No saved excerpts.' : data.enabled ? 'No unreviewed excerpts. New supported messages will appear here after capture.' : 'No unreviewed excerpts. Enable capture to retain future messages for this project.'}</p>}
      {(offset > 0 || data.nextOffset !== null) && <nav className="work-recovery-pages" aria-label="Conversation excerpt pages"><button className="text-button" disabled={disabled || offset === 0} onClick={() => onPage(Math.max(0, offset - PAGE_SIZE))}><ChevronLeft size={14} />Previous</button><span>Showing {data.items.length ? offset + 1 : 0}–{offset + data.items.length} of {includeReviewed ? data.total : data.pending}</span><button className="text-button" disabled={disabled || data.nextOffset === null} onClick={() => { if (data.nextOffset !== null) onPage(data.nextOffset); }}>Next<ChevronRight size={14} /></button></nav>}
      {data.hasMore && <p className="work-recovery-warning" role="status">Capture is incomplete. More source material remains to be checked.</p>}
    </> : available && !error && <p className="work-recovery-help">Reading recovery settings…</p>}
  </section>;
}
