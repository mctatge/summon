import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Bot, Check, ChevronRight, CircleAlert, CircleHelp, Copy, Folder, FolderGit2, FolderOpen, GitBranch, LoaderCircle, Pin, RefreshCw, ShieldCheck, SkipForward, Sparkles, X } from 'lucide-react';
import type { AgentApp, AgentSession, AgentSessionGroup, AgentSessionGroupId, AgentSessionSource, AgentSessionWork, AgentSessionsView, LocatedAgentSession, SummonBridge } from './types';
import { previewAgentSessions } from './preview';

/* Design brief: a switchboard for a founder between tasks. Three seconds to know
   what needs him, what answered, what is still going. The needs-you band is the
   one warm surface; everything else is a quiet ledger on paper. Each row is one
   line of human words (the title) over one line of place (project, branch), with
   the state in its own column so the eye can run down it. Ink dots carry the
   state (full working, half needs you, open ring, dashed interrupted, dotted a
   guess); a petrol dot in the margin means a reply you have not read. */

type Props = { bridge?: SummonBridge | null; preview: boolean; onClose: () => void; onView?: (view: AgentSessionsView) => void };
type Filter = 'all' | AgentApp;
type Toast = { id: number; text: string; tone: 'done' | 'problem' };
type StateParts = { head: string; time: string | null; joiner: string; alone: string | null };

const FILTER_KEY = 'summon.agent-sessions.filter';
const QUIET_KEY = 'summon.agent-sessions.show-quiet';
const POLL_MS = 4000;
const TICK_MS = 30_000;
// State words longer than this put their time on the second line, so the state column never breaks mid-phrase.
const LONG_STATE = 24;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const APP_NAME: Record<AgentApp, string> = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor', hermes: 'Hermes' };
const APPS = Object.keys(APP_NAME) as AgentApp[];
const GROUP_NOTE: Partial<Record<AgentSessionGroupId, string>> = { 'needs-you': 'Longest waiting first', working: 'Longest running first' };
const GLOSSARY: [string, string][] = [
  ['Needs you', 'Waiting on you for an OK, an answer or a plan review. Sessions that stopped with a problem show here too.'],
  ['New reply', 'Finished, and you have not read the reply yet.'],
  ['Working', 'Busy on a task right now.'],
  ['Open, your move', 'Open in its app, nothing running, and you have seen the latest reply.'],
  ['Interrupted', 'A task was cut off, usually when the app closed. Open it to pick up where it left off.'],
  ['Helpers', 'Smaller agents a session started to split up the work. Only the running ones are counted.'],
  ['Worktree', 'An extra copy of the project folder an agent works in, so its changes stay apart from yours.'],
  ['Probably', 'The app does not say this directly, so Summon is guessing from the files it keeps on this Mac. Shown with a dotted mark.'],
  ['Quiet', 'Used recently, but not open or running. Show quiet lists these at the end.'],
  ['The line under a title', 'What the session is touching, since titles from these apps are often vague. A spark on that line means Work in flight already described this work and Summon is borrowing its words.'],
  ['The name in front', 'The project and, where there is one, the folder or the piece of work the session is touching. A piece of work is named in the words Work in flight used, marked with a spark. Summon does not rename anything: the app\u2019s own title stays underneath in quotes.'],
];
// Only a reader that says 'user' is a claim about authorship, and Claude is the one reader that says it, so the
// other branch means "nobody told Summon who wrote this", which is not the same as "the app wrote it".
const APP_TIP = 'The title this session carries in its app. Summon never changes it.';
const OWN_TIP = 'The title you gave this session.';

const readStored = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const writeStored = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* A remembered choice is only a convenience. */ } };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
// DOM ids for aria references. Every character outside [A-Za-z0-9] is escaped, so distinct keys stay distinct.
const domId = (key: string) => 'as-' + key.replace(/[^A-Za-z0-9]/g, char => `_${char.charCodeAt(0).toString(16)}_`);

// Same wording as the core view, so a row can keep its time fresh between checks.
const startOfDay = (ms: number) => { const date = new Date(ms); return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime(); };
const dayWords = (at: number, now: number) => {
  if (at < startOfDay(now) && at >= startOfDay(startOfDay(now) - 1)) return 'yesterday';
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  return new Date(at).toLocaleDateString('en-US', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
};
const agoText = (at: number, now: number) => {
  const ms = Math.max(0, now - at);
  if (ms < MINUTE) return 'just now';
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} min ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)} h ago`;
  return dayWords(at, now);
};
const forText = (at: number, now: number) => {
  const ms = Math.max(0, now - at);
  if (ms < MINUTE) return 'just now';
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} min`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)} h`;
  return `since ${dayWords(at, now)}`;
};
const time = (value: string | null) => { const ms = value ? Date.parse(value) : NaN; return Number.isFinite(ms) ? ms : null; };

/** Splits the state words into the state itself and its time, with the time recomputed for now. */
function stateParts(session: AgentSession, now: number): StateParts {
  const at = time(session.sinceAt);
  const since = session.sinceText ?? null;
  if (at === null || !since) return { head: session.stateText, time: null, joiner: '', alone: null };
  const working = session.group === 'working';
  const lasting = working || (session.group === 'needs-you' && session.activity !== 'failed');
  let fresh = lasting ? forText(at, now) : agoText(at, now);
  if (working && fresh === 'just now') fresh = 'just started';
  const shown = working && since === 'just now' ? 'just started' : since;
  for (const joiner of [' · ', ' ']) {
    const tail = `${joiner}${shown}`;
    if (!session.stateText.endsWith(tail) || session.stateText.length <= tail.length) continue;
    // The same time as a phrase of its own, for when the state words are too long to share a line with it.
    const phrase = !lasting || /^(since|just)/.test(fresh) ? fresh : `for ${fresh}`;
    return { head: session.stateText.slice(0, -tail.length), time: fresh, joiner, alone: phrase[0].toUpperCase() + phrase.slice(1) };
  }
  return { head: session.stateText, time: null, joiner: '', alone: null };
}

/** A second, smaller time for states whose words carry none (open, interrupted, stopped). */
function lastActive(session: AgentSession, now: number) {
  if (!(session.group === 'open' || session.group === 'interrupted' || session.activity === 'failed')) return null;
  const at = time(session.updatedAt) ?? time(session.sinceAt);
  return at === null ? null : `Last active ${agoText(at, now)}`;
}

const glyphFor = (session: AgentSession) => {
  const shape = session.activity === 'failed' ? 'failed'
    : session.group === 'needs-you' ? 'needs'
    : session.group === 'working' ? 'working'
    : session.group === 'interrupted' ? 'interrupted'
    : session.group === 'new' ? 'new'
    : session.group === 'open' || session.live ? 'open' : 'quiet';
  return `${shape} ${session.confidence === 'inferred' ? 'inferred' : ''}`;
};
const glyphWord: Record<string, string> = { failed: 'stopped with a problem', needs: 'needs you', working: 'working', interrupted: 'interrupted', open: 'open', new: 'new reply', quiet: 'quiet' };

const noteFor = (session: AgentSession) => {
  if (session.reason && !session.stateText.includes(session.reason)) return session.reason;
  if (session.confidence === 'inferred' && !/\bprobably\b/i.test(session.stateText)) return 'A guess from the app’s files';
  return null;
};
const isTerminal = (session: AgentSession) => session.surface === 'terminal' || session.surface === 'cli';
/* Where the session is, in Summon's own words: project plus the piece of work it is touching, or project plus
   folder. The app's machine title never goes away, it moves underneath. Both fields are read defensively,
   because a window can outlive the app version that started sending them. */
const headlineOf = (session: AgentSession) => words((session as LocatedAgentSession).headline);
const machineWritten = (session: AgentSession) => (session as LocatedAgentSession).titleIsAuto !== false;

/* What a session is changing. The counts come from files only; the wording, when there is any, is the
   line Work in flight already wrote for that folder. Read defensively: a window can outlive the app
   version that started sending them. */
const words = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null;
const countWords = (work: AgentSessionWork) => {
  if (work.files) return plural(work.files, 'file');
  if (work.added || work.removed) return `+${work.added ?? 0} −${work.removed ?? 0}`;
  return null;
};
/** The quiet line under a title: borrowed wording leads, and the counts trail it, dimmer. */
function workWords(session: AgentSession, lead: string | null) {
  const line = words(session.workText);
  const work = session.work ?? null;
  const name = work ? words(work.workstream) : null;
  // A piece of work found by hashing file names is a guess, and it says so in the word the rest of the panel uses.
  const stream = name && work?.workstreamInferred ? `Probably ${name}` : name;
  // The row keeps the words short; how far along the work is stays in the tooltip with the counts.
  if (!stream || !work) return line ? { text: line, tail: null, borrowed: false, tip: line } : null;
  const tip = `${line || stream}\nIn the words Work in flight used`;
  // The name in front already carries those words, so down here only the counts are left to say.
  if (lead && lead.includes(stream)) { const counts = countWords(work); return counts ? { text: counts, tail: null, borrowed: false, tip } : null; }
  return { text: stream, tail: countWords(work), borrowed: true, tip };
}
const placeKind = (label: string | null) => label && label !== 'Main folder' ? label.split(' · ')[0] : null;

function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; label: string }) {
  return <button type="button" className="toggle" role="switch" aria-label={label} aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}><span /></button>;
}

function sourceLine(source: AgentSessionSource, sessions: AgentSession[]) {
  const name = APP_NAME[source.app] || source.label;
  if (source.detail) return { lead: source.detail.includes(name) ? null : source.label, text: source.detail };
  if (!source.available) return { lead: source.label, text: 'not found on this Mac' };
  const mine = sessions.filter(session => session.app === source.app && (source.app !== 'claude' || (source.label === 'Claude app') === (session.surface === 'desktop')));
  const live = mine.filter(session => session.live).length;
  if (live) return { lead: source.label, text: `${live} open` };
  return { lead: source.label, text: source.running ? 'running' : 'closed' };
}
const sourceTone = (source: AgentSessionSource) => source.detail && /could not|couldn.t|still checking|problem/i.test(source.detail) ? 'problem' : source.running ? 'running' : source.available ? 'idle' : 'absent';

export function SessionsPanel({ bridge, preview, onClose, onView }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const glossary = useRef<HTMLDetailsElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const loading = useRef(false);
  const queuedRefresh = useRef(false);
  const visited = useRef(new Set<string>());
  const lastNeeds = useRef<number | null>(null);
  const toastId = useRef(0);
  // Captured on first render, before the dialog takes focus, so focus returns to the opener.
  const opener = useRef(document.activeElement as HTMLElement | null);
  const readable = Boolean(bridge && typeof bridge.agentSessions === 'function');
  const [view, setView] = useState<AgentSessionsView | null>(bridge ? null : previewAgentSessions);
  const [checking, setChecking] = useState(readable);
  const [error, setError] = useState(bridge && !readable ? 'This Summon window is older than its app. Quit and reopen Summon to see agent sessions.' : '');
  const [pollProblem, setPollProblem] = useState(false);
  const [filter, setFilter] = useState<Filter>(() => { const stored = readStored(FILTER_KEY); return stored === 'all' || APPS.includes(stored as AgentApp) ? stored as Filter : 'all'; });
  const [quietChoice, setQuietChoice] = useState<boolean | null>(() => { const stored = readStored(QUIET_KEY); return stored === 'true' ? true : stored === 'false' ? false : null; });
  const [recentOpen, setRecentOpen] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [announce, setAnnounce] = useState('');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    alive.current = true;
    if (!dialog.current?.open) dialog.current?.showModal();
    return () => {
      alive.current = false;
      // When another panel opened this one, its opener is gone; fall back to the quick-access button.
      const target = opener.current?.isConnected ? opener.current : document.querySelector<HTMLElement>('[data-sessions-opener]');
      target?.focus();
    };
  }, []);

  const load = useCallback(async ({ refresh = false, quiet = false } = {}): Promise<void> => {
    if (!bridge || !readable) return;
    // A Check again press during a background check runs right after it.
    if (loading.current) { if (refresh) queuedRefresh.current = true; return; }
    loading.current = true;
    if (!quiet) setChecking(true);
    try {
      const next = await bridge.agentSessions(refresh ? { refresh: true } : undefined);
      if (!alive.current) return;
      setView(next); setNow(Date.now()); setError(''); setPollProblem(false);
    } catch (err) {
      if (!alive.current) return;
      if (quiet) setPollProblem(true); else setError(message(err));
    } finally {
      loading.current = false;
      if (alive.current && !quiet) setChecking(false);
      if (alive.current && queuedRefresh.current) { queuedRefresh.current = false; void load({ refresh: true }); }
    }
  }, [bridge, readable]);

  // Check on open, then every 4 seconds while this panel is open and the window is visible.
  useEffect(() => {
    if (!readable) return;
    void load();
    const tick = () => { if (document.visibilityState === 'visible') void load({ quiet: true }); };
    const timer = window.setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [readable, load]);

  // Times like "12 min" stay fresh between checks (and in preview, where nothing is checked).
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  // Reports each new view (the quick-access count uses it) without re-running when the callback identity changes.
  const reportView = useRef(onView);
  reportView.current = onView;
  useEffect(() => { if (view) reportView.current?.(view); }, [view]);

  // Screen readers hear when the number of sessions waiting on you changes (not on the first check).
  useEffect(() => {
    if (!view) return;
    const count = view.totals.needsYou;
    if (lastNeeds.current !== null && lastNeeds.current !== count) setAnnounce(count ? `${plural(count, 'agent session')} ${count === 1 ? 'needs' : 'need'} you.` : 'Nothing needs you now.');
    lastNeeds.current = count;
  }, [view]);

  // The glossary is a small popover: a click anywhere else closes it.
  useEffect(() => {
    const close = (event: PointerEvent) => { if (glossary.current?.open && !glossary.current.contains(event.target as Node)) glossary.current.open = false; };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(current => current?.id === toast.id ? null : current), toast.tone === 'problem' ? 5200 : 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const flash = (text: string, tone: Toast['tone'] = 'done') => setToast({ id: ++toastId.current, text, tone });

  const openSession = async (session: AgentSession) => {
    visited.current.add(session.key);
    if (session.openable === 'none') { flash(`${session.openHint || 'Summon cannot open this session'}.`, 'problem'); return; }
    if (!bridge || typeof bridge.openAgentSession !== 'function') { flash('Preview only. Opening sessions works in the installed app.', 'problem'); return; }
    if (opening) return;
    setOpening(session.key);
    try {
      const result = await bridge.openAgentSession(session.key);
      if (!alive.current) return;
      if (result && result.copied) flash('Resume command copied. Paste it in Terminal.');
      else if (session.openable === 'folder' || (result && result.shown)) flash('Showing the folder in Finder');
      else flash(`Opened in ${APP_NAME[session.app] || 'its app'}`);
    } catch (err) {
      if (alive.current) flash(message(err), 'problem');
    } finally {
      if (alive.current) setOpening(null);
    }
  };

  const showQuiet = quietChoice ?? view?.settings.showQuiet ?? true;
  const setShowQuiet = (value: boolean) => { setQuietChoice(value); writeStored(QUIET_KEY, String(value)); if (value) setRecentOpen(true); };
  const allSessions = useMemo(() => (view?.groups ?? []).flatMap(group => group.sessions), [view]);
  const shownGroups = useMemo(() => (view?.groups ?? []).filter(group => showQuiet || group.id !== 'recent'), [view, showQuiet]);
  const counts = useMemo(() => {
    const out: Record<Filter, number> = { all: 0, claude: 0, codex: 0, cursor: 0, hermes: 0 };
    for (const group of shownGroups) for (const session of group.sessions) { out.all += 1; if (session.app in out) out[session.app] += 1; }
    return out;
  }, [shownGroups]);
  const segments = APPS.filter(app => counts[app] > 0 || (view?.sources ?? []).some(source => source.app === app && source.available));
  const choice: Filter = filter === 'all' || segments.includes(filter) ? filter : 'all';
  const choose = (value: Filter) => { setFilter(value); writeStored(FILTER_KEY, value); };
  const groups: AgentSessionGroup[] = useMemo(() => shownGroups
    .map(group => ({ ...group, sessions: choice === 'all' ? group.sessions : group.sessions.filter(session => session.app === choice) }))
    .filter(group => group.sessions.length > 0), [shownGroups, choice]);
  const active = groups.filter(group => group.id !== 'recent');
  const recent = groups.find(group => group.id === 'recent');
  const hiddenRecent = !showQuiet ? (view?.groups.find(group => group.id === 'recent')?.sessions ?? []).filter(session => choice === 'all' || session.app === choice).length : 0;
  const waiting = (groups.find(group => group.id === 'needs-you')?.sessions ?? []).filter(session => session.openable !== 'none');
  const next = waiting.find(session => !visited.current.has(session.key)) ?? waiting[0] ?? null;
  const openNext = () => {
    if (!next) return;
    // Each press moves on to the next waiting session; after the last one it starts over.
    if (waiting.every(session => visited.current.has(session.key))) for (const session of waiting) visited.current.delete(session.key);
    const target = waiting.find(session => !visited.current.has(session.key)) ?? waiting[0];
    void openSession(target);
    document.getElementById(`${domId(target.key)}-title`)?.scrollIntoView({ block: 'nearest' });
  };

  // Rows: ↑/↓ move between sessions, Home/End jump; Enter or Space opens (native button).
  const onListKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (!target.classList.contains('as-open') || !body.current) return;
    const rows = Array.from(body.current.querySelectorAll<HTMLElement>('.as-open'));
    const index = rows.indexOf(target);
    const move = (item?: HTMLElement) => { if (!item) return; event.preventDefault(); item.focus(); item.closest('.as-row')?.scrollIntoView({ block: 'nearest' }); };
    if (event.key === 'ArrowDown') move(rows[index + 1]);
    else if (event.key === 'ArrowUp') move(rows[index - 1]);
    else if (event.key === 'Home') move(rows[0]);
    else if (event.key === 'End') move(rows[rows.length - 1]);
  };

  const checkedText = view ? (() => { const at = time(view.checkedAt); return at === null ? '' : `checked ${agoText(at, Math.max(now, at))}`; })() : '';
  const totals = view?.totals;
  const tally = totals ? [
    totals.needsYou ? { n: totals.needsYou, word: totals.needsYou === 1 ? 'needs you' : 'need you', tone: 'needs' } : null,
    totals.newReplies ? { n: totals.newReplies, word: totals.newReplies === 1 ? 'new reply' : 'new replies', tone: 'new' } : null,
    totals.working ? { n: totals.working, word: 'working', tone: 'working' } : null,
  ].filter((item): item is { n: number; word: string; tone: string } => Boolean(item)) : [];
  const failedLoad = !view && !checking && Boolean(bridge);

  const row = (session: AgentSession) => {
    const id = domId(session.key);
    const state = stateParts(session, now);
    const since = lastActive(session, now);
    const note = noteFor(session);
    const kind = placeKind(session.placeLabel);
    const terminal = isTerminal(session);
    const glyph = glyphFor(session);
    const Icon = session.openable === 'copy' ? Copy : session.openable === 'folder' ? FolderOpen : ArrowUpRight;
    const inline = Boolean(state.time) && state.head.length <= LONG_STATE;
    const meta = [inline ? null : state.alone, since, session.helpers ? plural(session.helpers, 'helper') : null].filter((item): item is string => Boolean(item));
    const busy = opening === session.key;
    // The name in front is an address. Without a project there is nothing to address, so the title leads as before,
    // and so does it when the address would only repeat the project: fifteen rows reading 'Harbor \u00b7 main folder'
    // tell two sessions apart no better than nothing, and the app's own title is what separates them.
    const lead = session.project && (session.work?.workstream || kind || session.titleIsFallback) ? headlineOf(session) : null;
    // A fallback title says nothing worth quoting, and a title the same as the name in front would only repeat it.
    const quoted = lead && !session.titleIsFallback && session.title && session.title !== lead ? session.title : null;
    const auto = machineWritten(session);
    const work = workWords(session, lead);
    // The words in front are Work in flight's, not Summon's, so the spark travels with them.
    const leadStream = words(session.work?.workstream);
    const borrowedLead = Boolean(lead && leadStream && lead.includes(leadStream));
    // The name in front already says the project, and for a folder session the folder too; the chip adds only what it left out.
    const spot = lead ? (kind && !lead.includes(kind) ? kind : null) : null;
    const where = Boolean(quoted || spot || (!lead && (session.project || session.folder)) || session.branch || note || work || (terminal && session.folder) || session.startedFrom === 'summon');
    // Narrow rows leave the worktree label and branch out, so the tooltip keeps them.
    const tip = [lead, lead && session.title !== lead ? `“${session.title}”` : null, !lead ? session.title : null, session.project && `${session.project}${session.placeLabel && session.placeLabel !== 'Main folder' ? ` · ${session.placeLabel}` : ''}`, session.branch, session.folder, words(session.workText)].filter(Boolean).join('\n');
    return <li key={session.key} className="as-item">
      <div className={`as-row ${session.group} ${session.unread ? 'unread' : ''} ${session.openable === 'none' ? 'inert' : ''}`}>
        {/* Every row in New replies is unread, so the dot only says something outside that group. */}
        {session.unread && session.group !== 'new' && <span className="as-unread" aria-hidden="true" />}
        <span className="as-glyph-cell" aria-hidden="true">{glyph.startsWith('failed') ? <CircleAlert size={13} strokeWidth={2} className="as-glyph-alert" /> : <span className={`as-glyph ${glyph}`} />}</span>
        <div className="as-main">
          <div className="as-line">
            <button type="button" id={`${id}-title`} className={`as-open ${!lead && session.titleIsFallback ? 'fallback' : ''}`} title={tip} aria-disabled={session.openable === 'none' || undefined} aria-describedby={`${where ? `${id}-where ` : ''}${id}-state ${id}-hint`} onClick={() => void openSession(session)}>
              {borrowedLead && <><Sparkles size={10} className="as-lead-spark" aria-hidden="true" /><span className="sr-only">in the words Work in flight used, </span></>}{lead || session.title}
              <span className="sr-only">{`, ${session.appLabel}${session.unread && session.group !== 'new' ? ', new reply' : ''}${session.pinned ? ', pinned' : ''}, ${glyphWord[glyph.split(' ')[0]] || session.group}`}</span>
            </button>
            {session.pinned && <Pin size={11} className="as-pin" aria-hidden="true" />}
            <span className="as-app" aria-hidden="true">{session.appLabel}</span>
          </div>
          {where && <div className={`as-where ${work ? 'with-work' : ''}`} id={`${id}-where`}>
            {/* The title belongs to the session's own app, so it is quoted rather than spoken as Summon's own words.
                Only Claude says who wrote one, so the brighter variant means "you named this", not "the app did not". */}
            {quoted && <span className={`as-title-quote ${auto ? 'auto' : 'own'}`} title={auto ? APP_TIP : OWN_TIP}><span className="sr-only">{auto ? 'titled ' : 'you named it '}</span>“{quoted}”</span>}
            {lead
              ? spot && <span className="as-chip as-place"><FolderGit2 size={11} aria-hidden="true" /><span className="as-chip-text">{spot}</span></span>
              : session.project
                ? <span className="as-chip as-project"><FolderGit2 size={11} aria-hidden="true" /><span className="as-chip-text">{session.project}{kind && <span className="as-chip-soft"> · {kind}</span>}</span></span>
                : session.folder && !terminal && <span className="as-chip as-folder"><Folder size={11} aria-hidden="true" /><span className="as-chip-text">{session.folder}</span></span>}
            {session.branch && <span className="as-chip as-branch"><GitBranch size={11} aria-hidden="true" /><span className="sr-only">branch </span><span className="as-chip-text">{session.branch}</span></span>}
            {/* Summon's own fact, not the app's: this session was started with the button in the workbench. */}
            {session.startedFrom === 'summon' && <span className="as-chip as-origin" title="Started with the Start button in Summon"><Bot size={11} aria-hidden="true" /><span className="as-chip-text">Started from Summon</span></span>}
            {note && <span className={`as-note ${session.confidence === 'inferred' ? 'guess' : ''}`}>{note}</span>}
            {work && <span className={`as-work ${work.borrowed ? 'borrowed' : ''}`} title={work.tip}>
              {work.borrowed && <><Sparkles size={10} aria-hidden="true" /><span className="sr-only">in the words Work in flight used, </span></>}
              <span className="as-work-text">{work.text}</span>
              {work.tail && <span className="as-work-tail">{' · '}{work.tail}</span>}
            </span>}
            {/* The folder is already in the tip, so it gives way to the more useful line. */}
            {terminal && session.folder && !work && <span className="as-path">{session.folder}</span>}
          </div>}
        </div>
        <div className="as-state" id={`${id}-state`}>
          <span className="as-state-line"><span className="as-state-head">{state.head}</span>{inline && <span className="as-time">{state.joiner}<span className="as-nowrap">{state.time}</span></span>}</span>
          {meta.length > 0 && <span className="as-state-meta">{meta.join(' · ')}</span>}
        </div>
        <div className="as-act">
          {session.openable === 'none'
            ? <span className="as-cannot" aria-hidden="true" title={session.openHint}>Cannot open from here</span>
            : <button type="button" className="as-action" tabIndex={-1} aria-hidden="true" disabled={busy} onClick={() => void openSession(session)}>{session.openHint}{busy ? <LoaderCircle size={12} className="spinner" /> : <Icon size={12} />}</button>}
          <span className="sr-only" id={`${id}-hint`}>{session.openHint}</span>
        </div>
      </div>
    </li>;
  };

  const section = (group: AgentSessionGroup) => {
    const headingId = `as-group-${group.id}`;
    const collapsible = group.id === 'recent';
    const expanded = !collapsible || recentOpen;
    const count = <span className="as-group-count"><span aria-hidden="true">{group.sessions.length}</span><span className="sr-only">, {plural(group.sessions.length, 'session')}</span></span>;
    return <section key={group.id} className={`as-group ${group.id}`} aria-labelledby={headingId}>
      <div className="as-group-head">
        <h3 id={headingId} className="as-group-title">
          {collapsible
            ? <button type="button" className="as-group-toggle" aria-expanded={expanded} aria-controls={`${headingId}-list`} onClick={() => setRecentOpen(value => !value)}><ChevronRight size={13} className="as-chevron" aria-hidden="true" />{group.title}{count}</button>
            : <>{group.title}{count}</>}
        </h3>
        <span className="as-group-rule" aria-hidden="true" />
        {GROUP_NOTE[group.id] && group.sessions.length > 1 && <span className="as-group-note">{GROUP_NOTE[group.id]}</span>}
      </div>
      {expanded && <ul role="list" className="as-list" id={`${headingId}-list`}>{group.sessions.map(row)}</ul>}
    </section>;
  };

  const calm = <div className={`as-calm ${active.length === 0 && recent ? 'compact' : ''}`}>
    <Bot size={active.length === 0 && recent ? 22 : 34} strokeWidth={1.2} aria-hidden="true" />
    <div>
      <h3>{choice === 'all' ? 'Nothing needs you. No agent is working right now.' : `Nothing from ${APP_NAME[choice]} needs you or is working.`}</h3>
      <p>{choice !== 'all' ? 'Other apps may still have sessions.' : 'New replies, waiting sessions and running work show up here while this panel is open.'}</p>
      <div className="as-calm-actions">
        {choice !== 'all' && <button type="button" className="button small-button" onClick={() => choose('all')}>Show all apps</button>}
        {hiddenRecent > 0 && <button type="button" className="text-button" onClick={() => setShowQuiet(true)}>Show {plural(hiddenRecent, 'earlier session')}</button>}
      </div>
    </div>
  </div>;

  const sources = view?.sources ?? [];
  const warnings = view?.warnings ?? [];

  return <dialog ref={dialog} className="preferences-dialog as-dialog" aria-labelledby="as-title" aria-describedby="as-totals" onCancel={event => { event.preventDefault(); onClose(); }} onClose={() => onClose()} onClick={event => { if (event.target === dialog.current) onClose(); }}>
    <div className="preferences-content as-content">
      <header className="preferences-heading as-heading">
        <div>
          <span className="eyebrow">AGENT SESSIONS</span>{preview && <span className="preview-badge as-preview-badge">Preview · sample sessions</span>}
          <h2 id="as-title">What your agents are doing</h2>
          <p className="as-totals" id="as-totals">
            {!view ? failedLoad ? 'Could not check your agent sessions.' : 'Checking your agent sessions…'
              : <>
                {tally.length === 0 && <span>Nothing needs you and nothing is running</span>}
                {tally.map((item, index) => <React.Fragment key={item.tone}>{index > 0 && <span className="as-dot" aria-hidden="true"> · </span>}{index > 0 && <span className="sr-only">, </span>}<span className={`as-tally ${item.tone}`}><strong>{item.n}</strong> {item.word}</span></React.Fragment>)}
                {checkedText && <><span className="as-dot" aria-hidden="true"> · </span><span className="sr-only">, </span><span className="as-checked" title={view.checkedAt}>{checkedText}</span></>}
              </>}
          </p>
        </div>
        <button className="icon-button" aria-label="Close agent sessions" onClick={onClose}><X size={20} /></button>
      </header>

      <div className="as-toolbar">
        {view && <div className="as-filter" role="group" aria-label="Show sessions from">
          {(['all', ...segments] as Filter[]).map(value => <button key={value} type="button" className="as-segment" aria-pressed={choice === value} onClick={() => choose(value)}>
            {value === 'all' ? 'All' : APP_NAME[value]}<span className="as-segment-count"><span aria-hidden="true">{counts[value]}</span><span className="sr-only">, {plural(counts[value], 'session')}</span></span>
          </button>)}
        </div>}
        <button type="button" className="button primary small-button as-next" disabled={!next} title={next ? `Opens “${next.title}”` : 'Nothing is waiting on you'} onClick={openNext}>
          <SkipForward size={13} aria-hidden="true" />Next that needs you{waiting.length > 0 && <span className="wif-button-count"><span aria-hidden="true">{waiting.length}</span><span className="sr-only">, {waiting.length} waiting</span></span>}
        </button>
        <label className="as-switch"><Toggle label="Show quiet sessions" checked={showQuiet} disabled={!view} onChange={setShowQuiet} /><span aria-hidden="true">Show quiet</span></label>
        <div className="as-toolbar-end">
          <button type="button" className={`icon-button as-refresh ${checking ? 'spinning' : ''}`} aria-label={checking ? 'Checking agent sessions' : 'Check again'} title="Check again" disabled={!readable || checking} onClick={() => void load({ refresh: true })}><RefreshCw size={14} /></button>
          <details className="wif-glossary as-glossary" ref={glossary}><summary title="What do these words mean?"><CircleHelp size={13} aria-hidden="true" /><span className="as-glossary-text">What do these words mean?</span></summary><dl>{GLOSSARY.map(([term, meaning]) => <div key={term}><dt>{term}</dt><dd>{meaning}</dd></div>)}</dl></details>
        </div>
      </div>

      <p className="sr-only" role="status" aria-live="polite">{announce}</p>
      {error && view && <div className="wif-banner wif-warning as-banner" role="alert"><CircleAlert size={13} /><span>{error}</span></div>}

      <div className="as-body" ref={body} onKeyDown={onListKey} aria-busy={checking && !view}>
        {failedLoad ? <div className="empty-state" role="alert"><CircleAlert size={32} strokeWidth={1.2} /><h3>Could not check your agent sessions.</h3><p>{error || 'Summon could not read session details from your apps.'}</p>{readable && <button type="button" className="button" onClick={() => void load({ refresh: true })}>Try again</button>}</div>
          : !view ? <div className="as-skeleton" aria-hidden="true">{[64, 48, 56, 40, 52].map((width, index) => <div className="as-skeleton-row" key={index}><span className="as-skeleton-dot" /><div><span className="wif-skeleton" style={{ width: `${width}%` }} /><span className="wif-skeleton short" style={{ width: `${width - 22}%` }} /></div><span className="wif-skeleton state" /></div>)}</div>
          : <>
            {active.length === 0 && calm}
            {active.map(section)}
            {recent && section(recent)}
          </>}
      </div>

      {view && <footer className="as-footer">
        <div className="as-footer-row">
        <ul className="as-sources" aria-label="Where sessions come from">
          {sources.map(source => { const line = sourceLine(source, allSessions); return <li key={`${source.app}-${source.label}`} className={`as-source ${sourceTone(source)}`}><span className="as-source-dot" aria-hidden="true" />{line.lead && <span className="as-source-label">{line.lead}</span>}{line.lead && <span className="as-dot" aria-hidden="true"> · </span>}<span className="as-source-text">{line.text}</span></li>; })}
          {sources.length === 0 && <li className="as-source absent"><span className="as-source-dot" aria-hidden="true" /><span className="as-source-text">No agent apps found on this Mac.</span></li>}
        </ul>
        <p className="as-privacy"><ShieldCheck size={11} aria-hidden="true" />Read from each app’s own files on this Mac. Never the conversations.</p>
        </div>
        {(warnings.length > 0 || pollProblem) && <ul className="as-warnings">
          {pollProblem && <li><CircleAlert size={12} aria-hidden="true" />Could not check just now. Showing the last check.</li>}
          {warnings.map((item, index) => <li key={index}><CircleAlert size={12} aria-hidden="true" />{item}</li>)}
        </ul>}
        <div className={`as-toast ${toast ? `shown ${toast.tone}` : ''}`} role="status" aria-live="polite">{toast && <>{toast.tone === 'done' ? <Check size={13} aria-hidden="true" /> : <CircleAlert size={13} aria-hidden="true" />}<span>{toast.text}</span></>}</div>
      </footer>}
    </div>
  </dialog>;
}
