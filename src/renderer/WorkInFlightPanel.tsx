import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Archive, ArrowUpRight, Bot, Check, ChevronDown, ChevronRight, CircleAlert, CircleHelp, Copy, Folder, FolderGit2, FolderX, GitBranch, LoaderCircle, Lock, RefreshCw, ShieldCheck, Sparkles, X } from 'lucide-react';
import type { SummonBridge, WifArea, WifBranch, WifFile, WifGrouping, WifJob, WifPlace, WifReadiness, WifRepo, WifSettings, WifStash, WifWorkstream, WorkInFlight } from './types';
import type { WifStanding, WifStandingNote, WorkInFlightStanding } from './types';
import { previewWorkInFlight } from './preview';
import type { AgentSessionsView } from './types';
import { previewAgentSessions } from './preview';

/* Design brief: a ledger of loose ends for a founder between tasks. Each project
   reads as one sentence, then a tree drawn with receipt rails: folder, then the
   plain-language pieces of unfinished work, then branches and set-aside changes.
   Ink dots carry readiness (full ready, half in progress, open scratch, square
   made by a script). Machine names sit in mono pencil; human words lead. */

type Props = { bridge?: SummonBridge | null; preview: boolean; onClose: () => void; onOpenSessions?: () => void };

const ALL = '__all__';
const STORAGE_KEY = 'summon.work-in-flight.selected';
const STATUS_RANK: Record<WifRepo['status'], number> = { attention: 0, work: 1, error: 2, clean: 3 };
const STATUS_WORD: Record<WifRepo['status'], string> = { attention: 'needs a look', work: 'unfinished work', error: 'could not check', clean: 'all caught up' };
const READINESS: Record<WifReadiness, string> = { ready: 'Looks ready to save', 'in-progress': 'Still in progress', scratch: 'Scratch, probably keep local', generated: 'Made by a script' };
const AREA_TONE: Partial<Record<WifArea, string>> = { product: 'build', backend: 'build', frontend: 'build', outreach: 'people', business: 'people' };
const LETTER: Record<WifFile['status'], [string, string]> = { modified: ['M', 'edited'], added: ['A', 'added'], deleted: ['D', 'deleted'], renamed: ['R', 'renamed'], typechange: ['T', 'type changed'], untracked: ['N', 'new, not tracked yet'], conflicted: ['C', 'conflicting edits'] };
const ENGINE: Record<WifGrouping['engine'], string> = { codex: 'Codex', claude: 'Claude', paths: 'folder' };
const MIRROR_WORD = /^(?:its unsaved changes are all in|same unsaved changes as)/i;
const PRIVATE_TIP = 'Private: names and contents are never sent when grouping';
const GUESS_TIP = 'A guess from what changed on disk. It goes away as soon as that folder changes.';
const GLOSSARY: [string, string][] = [
  ['Saved (commit)', 'A checkpoint recorded on this Mac.'],
  ['Shared (push)', 'Copied to GitHub.'],
  ['Branch', 'A separate line of work.'],
  ['Worktree', 'An extra copy of the project folder an agent works in.'],
  ['Set aside (stash)', 'Changes put on a shelf.'],
  ['Merged', 'Folded into the main line.'],
  ['Main line (main)', 'The project’s main line of work, usually a branch called main (some projects say master). “2 commits not in main” means two saves that are not folded into it yet.'],
  ['Not on a branch', 'The folder is sitting on one checkpoint instead of a line of work. Codex worktrees usually look like this. New saves made there need a branch name to be kept.'],
  ['Private', 'Looks personal or secret, like emails, people, contracts, private folders you listed, or password files. When grouping, the AI never gets these file names or contents, only the folder, a count and the file types.'],
  ['File letters', 'M edited, A added, N new, D deleted, R renamed, T type changed, C conflicting edits.'],
  ['Moved', 'A file changed in that project since the last time you looked at it here.'],
  ['Landed', 'Saves made since then, so that work has left this list.'],
  ['Not moving', 'Work that has stopped, for one of four reasons: no file has changed for a week or more, an agent is working without changing a file, conflicting edits are waiting, or a line of work is falling further behind the main line. The reason for saying so sits beside each row.'],
  ['Spinning', 'An agent is working in that folder, but no file there has changed for a while. A guess from what is on disk, so it goes away as soon as a file changes.'],
];
// How long a project section has to sit expanded and on screen before Summon counts it as looked at.
const DWELL_MS = 3000;
const NOTE_CAP = 4;
const RAIL_CAP = 5;
// The "Not moving" rail says these further down the same scroll, so a project's own block does not repeat them.
const RAIL_KINDS = new Set(['still', 'spinning', 'blocked', 'rot']);

const readStored = () => { try { return localStorage.getItem(STORAGE_KEY); } catch { return null; } };
const writeStored = (value: string) => { try { localStorage.setItem(STORAGE_KEY, value); } catch { /* A remembered selection is only a convenience. */ } };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const isToday = (value: string) => new Date(value).toDateString() === new Date().toDateString();
const clock = (value: string) => new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
// Dates from another year carry the year, so an old date never reads as an upcoming one.
const day = (value: string) => {
  const date = new Date(value);
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', ...(date.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
};
const stamp = (value: string) => isToday(value) ? clock(value) : `${day(value)}, ${clock(value)}`;
const relative = (value: string | null) => {
  const ms = value ? Date.now() - Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) return '';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${plural(hours, 'hour')} ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : days < 14 ? `${days} days ago` : day(value!);
};
// DOM ids for aria-labelledby. Every character outside [A-Za-z0-9] is escaped, so distinct keys stay distinct.
const domId = (key: string) => 'wif-' + key.replace(/[^A-Za-z0-9]/g, char => `_${char.charCodeAt(0).toString(16)}_`);
// domId never puts '-' after its prefix, so these cannot collide with another node's id.
const descId = (key: string, n: number) => `${domId(key)}-d${n}`;
const split = (path: string) => { const trimmed = path.endsWith('/') ? path.slice(0, -1) : path; const cut = trimmed.lastIndexOf('/') + 1; return [path.slice(0, cut), path.slice(cut)]; };
const stashText = (value: string) => value.replace(/^(?:WIP on|On) [^:]*:\s*(?:[0-9a-f]{7,40}\s+)?/, '') || value;
const tone = (word: string) => /conflict|folder is gone|was deleted/i.test(word) ? 'warn' : /^all saved$|safe to clean up/i.test(word) ? 'good' : /^not saved yet$/i.test(word) ? 'strong' : '';

const liveStreams = (repo: WifRepo) => repo.places.reduce((sum, place) => sum + (place.mirrorOf || place.missing ? 0 : place.grouping?.workstreams.length || 0), 0);
const openCount = (repo: WifRepo) => liveStreams(repo) + repo.branches.filter(branch => !branch.merged).length + repo.stashes.length;
const openParts = (repo: WifRepo) => {
  const streams = liveStreams(repo);
  const branches = repo.branches.filter(branch => !branch.merged).length;
  return [streams && plural(streams, 'piece of work', 'pieces of work'), branches && plural(branches, 'open branch', 'open branches'), repo.stashes.length && `${repo.stashes.length} set aside`].filter(Boolean).join(' · ');
};
const latest = (repo: WifRepo) => Math.max(0, ...repo.places.map(place => place.lastChangedAt ? Date.parse(place.lastChangedAt) : 0), ...repo.branches.map(branch => branch.lastCommitAt ? Date.parse(branch.lastCommitAt) : 0));
const sortRepos = (repos: WifRepo[]) => [...repos].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || latest(b) - latest(a) || a.name.localeCompare(b.name));
const needsGrouping = (repo: WifRepo) => repo.places.some(place => !place.mirrorOf && !place.missing && place.counts.items > 1 && (!place.grouping || place.grouping.stale || place.grouping.engine === 'paths'));
const fileTotal = (paths: string[], files: Map<string, WifFile>) => paths.reduce((sum, path) => { const item = files.get(path); return sum + (item?.isDir ? item.fileCount || 1 : 1); }, 0);

function totalsLine(totals: WorkInFlight['totals'], repos: WifRepo[]) {
  const unchecked = repos.filter(repo => repo.status === 'error').length;
  if (!totals.reposWithWork) return unchecked ? `Could not finish checking ${plural(unchecked, 'project')}. Nothing unsaved found in the rest.` : 'Everything is saved and shared.';
  const parts = [`${plural(totals.reposWithWork, 'project')} ${totals.reposWithWork === 1 ? 'has' : 'have'} unfinished work`];
  if (totals.unsavedItems) parts.push(plural(totals.unsavedItems, 'unsaved change'));
  if (totals.unsharedCommits) parts.push(`${plural(totals.unsharedCommits, 'commit')} not shared`);
  if (totals.setAside) parts.push(`${totals.setAside} set aside`);
  if (unchecked) parts.push(`${plural(unchecked, 'project')} not checked`);
  return parts.join(' · ');
}

function jobLine(job: WifJob) {
  const { done, total } = job.progress;
  if (job.status === 'queued') return 'Getting ready to group your changes…';
  if (job.status === 'running') { const step = `${Math.min(done + 1, Math.max(total, 1))} of ${Math.max(total, 1)}`; return job.current ? `Grouping ${job.current} (${step})…` : `Grouping your changes (${step})…`; }
  if (job.status === 'failed') return `Grouping with ${ENGINE[job.engine]} did not finish.`;
  if (!total) return 'Everything was already grouped.';
  return `Grouped with ${ENGINE[job.engine]}${job.finishedAt ? ` at ${stamp(job.finishedAt)}` : ''}.${job.errors.length ? ` ${plural(job.errors.length, 'project')} could not be grouped:` : ''}`;
}

/* A line is only as good as the folder it was read from. Every note and rail row carries that folder's
   fingerprint, so when a later check says the folder has moved, the line goes rather than standing there
   saying something that was true a minute ago. A counted fact about a moment that did happen stays; a fact
   written in the present tense, such as "no file here has changed", is a claim about now and goes when now
   disagrees with it. */
/* `now` is the live scan's fingerprint per folder, and both callers below are already scoped to a project that
   scan listed, so a folder missing from it is a folder that is gone, not one that went unread: its guess goes too.
   A counted line is dropped only where this scan positively contradicts it, never merely because its folder is
   absent. An older core that sends no fingerprints at all sends no `now`, and then nothing is suppressed. */
const PRESENT = new Set(['still', 'spinning', 'blocked', 'rot']);
const fresh = (now: Record<string, string> | undefined, item: { inferred?: boolean; kind?: string; placeId?: string; fingerprint?: string }) => {
  if (!item.placeId || !item.fingerprint || !now) return true;
  if (item.inferred) return now[item.placeId] === item.fingerprint;
  return !PRESENT.has(item.kind ?? '') || !(item.placeId in now) || now[item.placeId] === item.fingerprint;
};
/* Whether a newer paragraph says more than the one being read. Marking a project as read only ever shrinks these,
   so a smaller one is his own looking and is ignored; a bigger one is work that landed while the panel sat open. */
const grew = (next: WifStanding, kept: WifStanding) =>
  next.moved.some(name => !kept.moved.includes(name)) || next.landed > kept.landed || next.streamsReady > kept.streamsReady || next.streamsSaved > kept.streamsSaved;
/** What changed in one project since the watermark, in the core's own sentences. */
const standingNotes = (repo: WifRepo, standing: WifStanding | null, now?: Record<string, string>): WifStandingNote[] =>
  (standing?.byRepo?.[repo.id]?.notes ?? []).filter(note => fresh(now, note));
/** The rail at the bottom: work that has stopped, already sorted and one row per folder by the core. */
const stillRows = (standing: WifStanding | null, ids: Set<string>, now?: Record<string, string>) =>
  (standing?.notMoving ?? []).filter(entry => ids.has(entry.repoId) && fresh(now, entry));

function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; label: string }) {
  return <button type="button" className="toggle" role="switch" aria-label={label} aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}><span /></button>;
}

function Words({ list }: { list: string[] }) {
  return <>{list.map((word, index) => <React.Fragment key={`${index}-${word}`}>{index > 0 && <span className="wif-sep" aria-hidden="true"> · </span>}{index > 0 && <span className="sr-only">, </span>}<span className={`wif-word ${tone(word)}`}>{word}</span></React.Fragment>)}</>;
}

export function WorkInFlightPanel({ bridge, preview, onClose, onOpenSessions }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const tree = useRef<HTMLUListElement>(null);
  const glossary = useRef<HTMLDetailsElement>(null);
  const alive = useRef(true);
  // Captured on first render, before the dialog takes focus, so focus returns to the opener.
  const opener = useRef(document.activeElement as HTMLElement | null);
  const autoGrouped = useRef(false);
  const [view, setView] = useState<WorkInFlightStanding | null>(bridge ? null : previewWorkInFlight);
  const [scanning, setScanning] = useState(Boolean(bridge));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(() => readStored() || ALL);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [active, setActive] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [dismissedJob, setDismissedJob] = useState<string | null>(null);
  const [cleanOpen, setCleanOpen] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const privacyShown = useRef(false);
  // Projects this window has already counted as looked at, so a section that stays on screen is marked once.
  const marked = useRef(new Set<string>());
  // The first paragraph this window was given. What it says is true of the moment the panel was opened.
  const held = useRef<WifStanding | null>(null);
  const [markedAll, setMarkedAll] = useState(false);
  const [privateRepo, setPrivateRepo] = useState('');
  const [privateDraft, setPrivateDraft] = useState('');
  const offline = !bridge;
  // Agent sessions per folder, for the "Claude working here" chips. Checked on open and every 10 s while open.
  const [agentPlaces, setAgentPlaces] = useState<AgentSessionsView['byPlace']>(() => bridge ? {} : previewAgentSessions.byPlace);

  useEffect(() => {
    alive.current = true;
    if (!dialog.current?.open) dialog.current?.showModal();
    return () => { alive.current = false; opener.current?.focus(); };
  }, []);

  const load = useCallback(async (refresh = false) => {
    if (!bridge) return;
    setScanning(true);
    setError('');
    try { const next = await bridge.workInFlight(refresh ? { refresh: true } : undefined); if (alive.current) setView(next); }
    catch (err) { if (alive.current) setError(message(err)); }
    finally { if (alive.current) setScanning(false); }
  }, [bridge]);

  useEffect(() => {
    if (!bridge) return;
    void load();
    return bridge.onWorkInFlight(next => { if (alive.current) setView(next); });
  }, [bridge, load]);

  const job = view?.job ?? null;
  const running = job?.status === 'queued' || job?.status === 'running';

  const group = useCallback(async (repoId: string | null, options: { force?: boolean; reason?: 'panel' | 'open' } = {}) => {
    if (!bridge) return;
    setPending(true);
    setError('');
    try {
      const next = await bridge.groupWork(repoId, { force: Boolean(options.force), reason: options.reason || 'panel' });
      if (alive.current) { setView(current => current ? { ...current, job: next } : current); setDismissedJob(null); }
    } catch (err) { if (alive.current) setError(message(err)); }
    finally { if (alive.current) setPending(false); }
  }, [bridge]);

  /* The watermark only moves when he has actually looked: a project section expanded and on screen for three
     seconds, or a press of Mark as read. Never on open, or the line at the top would always be empty. The new
     mark is not read back into this window on purpose, so the sentence he is reading does not rewrite itself. */
  const mark = useCallback(async (repoId: string | null, explicit = false) => {
    if (!bridge || typeof bridge.markStanding !== 'function') return;
    if (repoId && marked.current.has(repoId)) return;
    try { await bridge.markStanding(repoId); }
    catch (err) { if (alive.current && explicit) setError(message(err)); return; }
    if (repoId) marked.current.add(repoId);
    // Marking everything ends this look, so the button keeps saying so instead of offering itself again.
    if (alive.current && explicit) { for (const id of Object.keys(held.current?.byRepo ?? {})) marked.current.add(id); setMarkedAll(true); }
  }, [bridge]);

  // Group once per open when the person chose that, only for work that changed since it was grouped.
  useEffect(() => {
    if (!bridge || !view || autoGrouped.current) return;
    autoGrouped.current = true;
    // Never on the first open: the first send is always a click on Group changes, after the note below is shown.
    if (view.settings.groupOnOpen && view.settings.consentedAt && view.settings.engine !== 'off' && view.totals.staleGroupings > 0 && !running) void group(null, { reason: 'open' });
  }, [bridge, view, running, group]);

  // Before anything has been sent, the privacy details start open so they are read first.
  useEffect(() => {
    if (!view || privacyShown.current) return;
    privacyShown.current = true;
    if (!view.settings.consentedAt && view.settings.engine !== 'off') setPrivacyOpen(true);
  }, [view]);

  // While a grouping job runs, check for results every 4 seconds. Only while this panel is open.
  useEffect(() => {
    if (!bridge || !running) return;
    const timer = window.setInterval(() => { bridge.workInFlight().then(next => { if (alive.current) setView(next); }).catch(() => { /* The next tick or push update retries. */ }); }, 4000);
    return () => window.clearInterval(timer);
  }, [bridge, running]);

  // The glossary is a small popover: a click anywhere else closes it.
  useEffect(() => {
    const close = (event: PointerEvent) => { if (glossary.current?.open && !glossary.current.contains(event.target as Node)) glossary.current.open = false; };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);

  useEffect(() => {
    if (!bridge || typeof bridge.agentSessions !== 'function') return;
    let busy = false;
    const pull = () => {
      if (busy || document.visibilityState !== 'visible') return;
      busy = true;
      bridge.agentSessions().then(next => { if (alive.current) setAgentPlaces(next.byPlace || {}); }).catch(() => { /* Chips are optional; the next check retries. */ }).finally(() => { busy = false; });
    };
    pull();
    const timer = window.setInterval(pull, 10_000);
    // Showing this window again checks right away; pull ignores the event while hidden.
    document.addEventListener('visibilitychange', pull);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', pull); };
  }, [bridge]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(null), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const saveSettings = async (patch: Partial<WifSettings>) => {
    if (!bridge) return;
    setPending(true);
    setError('');
    try { const next = await bridge.workInFlightSettings(patch); if (alive.current) setView(next); }
    catch (err) { if (alive.current) setError(message(err)); }
    finally { if (alive.current) setPending(false); }
  };
  const reveal = async (placeId: string) => {
    if (!bridge) return;
    setError('');
    try { await bridge.revealPlace(placeId); } catch (err) { setError(message(err)); }
  };
  const copy = async (key: string, text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(key); } catch { setError('Could not copy to the clipboard. Select the text and copy it instead.'); }
  };

  const repos = useMemo(() => sortRepos(view?.repos ?? []), [view]);
  const unfinished = repos.filter(repo => repo.status !== 'clean');
  const caughtUp = repos.filter(repo => repo.status === 'clean');
  const focus = selected === ALL ? undefined : repos.find(repo => repo.id === selected);
  const choice = focus ? focus.id : ALL;
  const shown = focus ? [focus] : unfinished;
  const choose = (id: string) => { setSelected(id); writeStored(id); setActive(null); };
  const withWork = unfinished.filter(repo => repo.status !== 'error').length; // same rule as core totals.reposWithWork
  const unchecked = unfinished.length - withWork;
  const privateTarget = repos.find(repo => repo.id === privateRepo) ?? focus ?? repos[0];
  const savedPrivate = (view?.settings.privatePaths[privateTarget?.path ?? ''] ?? []).join(', ');
  useEffect(() => { setPrivateDraft(savedPrivate); }, [privateTarget?.path, savedPrivate]);
  const savePrivate = () => {
    if (!view || !privateTarget) return;
    const list = privateDraft.split(',').map(item => item.trim()).filter(Boolean);
    const next = { ...view.settings.privatePaths };
    if (list.length) next[privateTarget.path] = list; else delete next[privateTarget.path];
    void saveSettings({ privatePaths: next });
  };
  useEffect(() => { if (focus?.status === 'clean') setCleanOpen(true); }, [focus?.status]);

  // Tree: one roving tab stop, arrow keys move between visible rows, Left/Right collapse and expand.
  const expanded = (id: string, fallback: boolean) => open[id] ?? fallback;
  const setNode = (id: string, value: boolean) => setOpen(current => ({ ...current, [id]: value }));
  const firstId = shown[0] ? `r:${shown[0].id}` : null;
  const stop = active ?? firstId;
  useEffect(() => {
    const root = tree.current;
    if (root && !root.querySelector('[role="treeitem"][tabindex="0"]')) setActive(root.querySelector<HTMLElement>('[role="treeitem"]')?.dataset.node ?? null);
  });
  /* Marking a project as read never rewrites the sentence under your eyes: it moves the watermark for next time.
     Work landing while the panel sits open is the opposite, and the rows below already show it, so a paragraph that
     has grown replaces the one being read rather than leaving the top line an hour behind the list under it. */
  const live = view?.standing ?? null;
  if (live && (!held.current || grew(live, held.current))) held.current = live;
  const standing = held.current ?? live;
  const evidence = live?.fingerprints;
  const shownIds = new Set(shown.map(repo => repo.id));
  /* The rail is present state, not a delta against the watermark, and the core dates each row from the earlier of
     the watermark and the run, so marking a project as read never erases a row. It comes from the live scan, beside
     the live fingerprints, so a row can no longer contradict the evidence that is meant to withdraw it. */
  const railRows = stillRows(live, shownIds, evidence);
  // A row past the cap renders only as "(N more)", so its folder keeps its note in the project's own block.
  const railPlaces = new Set(railRows.slice(0, RAIL_CAP).map(row => row.placeId));
  // Re-observing on every check would restart the three seconds; this only changes when a section opens or closes.
  const dwellKey = shown.map(repo => `${repo.id}:${expanded(`r:${repo.id}`, true) ? 1 : 0}`).join('|');

  /* Looking is the gesture. A project section counts as looked at once it is expanded and a real part of it has
     been on screen for three seconds, in a visible window. Anything less leaves the watermark where it was. */
  useEffect(() => {
    const root = tree.current;
    if (!root || !bridge || typeof bridge.markStanding !== 'function' || typeof IntersectionObserver !== 'function') return;
    const timers = new Map<Element, number>();
    const clear = (target: Element) => { const timer = timers.get(target); if (timer) { window.clearTimeout(timer); timers.delete(target); } };
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const element = entry.target as HTMLElement;
        const repoId = (element.dataset.node || '').replace(/^r:/, '');
        // A tall project never reaches half of itself, so enough of it counts as enough.
        const enough = entry.isIntersecting && entry.intersectionRect.height >= Math.min(140, entry.boundingClientRect.height);
        if (!enough || element.getAttribute('aria-expanded') !== 'true' || marked.current.has(repoId)) { clear(element); continue; }
        if (timers.has(element)) continue;
        timers.set(element, window.setTimeout(() => {
          timers.delete(element);
          if (document.visibilityState === 'visible') void mark(repoId);
        }, DWELL_MS));
      }
    }, { root: root.parentElement, threshold: [0, 0.25, 0.5, 1] });
    for (const element of root.querySelectorAll<HTMLElement>('.wif-repo[data-node]')) observer.observe(element);
    const hidden = () => { if (document.visibilityState !== 'visible') for (const target of [...timers.keys()]) clear(target); };
    document.addEventListener('visibilitychange', hidden);
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', hidden); for (const timer of timers.values()) window.clearTimeout(timer); };
  }, [bridge, mark, dwellKey]);

  const onTreeKey = (event: React.KeyboardEvent<HTMLUListElement>) => {
    const item = event.target as HTMLElement;
    if (item.getAttribute('role') !== 'treeitem' || !tree.current) return;
    const items = Array.from(tree.current.querySelectorAll<HTMLElement>('[role="treeitem"]'));
    const index = items.indexOf(item);
    const id = item.dataset.node || '';
    const state = item.getAttribute('aria-expanded');
    const move = (target?: HTMLElement | null) => { if (!target) return; event.preventDefault(); target.focus(); };
    if (event.key === 'ArrowDown') move(items[index + 1]);
    else if (event.key === 'ArrowUp') move(items[index - 1]);
    else if (event.key === 'Home') move(items[0]);
    else if (event.key === 'End') move(items[items.length - 1]);
    else if (event.key === 'ArrowRight') { if (state === 'false') { event.preventDefault(); setNode(id, true); } else if (state === 'true') move(item.querySelector<HTMLElement>('[role="treeitem"]')); }
    else if (event.key === 'ArrowLeft') { if (state === 'true') { event.preventDefault(); setNode(id, false); } else move(item.parentElement?.closest<HTMLElement>('[role="treeitem"]')); }
    else if ((event.key === 'Enter' || event.key === ' ') && state !== null) { event.preventDefault(); setNode(id, state !== 'true'); }
  };

  // Names stay short (label plus state); longer prose is attached as a description, only for elements that exist.
  const node = (id: string, level: number, isOpen: boolean | undefined, className: string, row: React.ReactNode, children?: React.ReactNode[], describedBy?: string[]) =>
    <li key={id} role="treeitem" className={`wif-node ${className}`} data-node={id} aria-level={level} aria-expanded={isOpen} aria-labelledby={domId(id)} aria-describedby={describedBy?.length ? describedBy.join(' ') : undefined} tabIndex={stop === id ? 0 : -1} onFocus={event => { if (event.target === event.currentTarget) setActive(id); }}>
      {row}
      {isOpen && children && children.length > 0 && <ul role="group" className="wif-children">{children}</ul>}
    </li>;
  const twisty = (id: string, isOpen: boolean) => <span className="wif-twisty" aria-hidden="true" onClick={() => setNode(id, !isOpen)}>{isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>;

  const provenance = (grouping: WifGrouping, id?: string) => grouping.engine === 'paths'
    ? <p className="wif-provenance paths" id={id}><Folder size={12} />{grouping.note || 'Grouped by folder.'}</p>
    : <p className={`wif-provenance ${grouping.stale ? 'stale' : ''}`} id={id}><span className="wif-evidence"><Sparkles size={12} />Suggested by {ENGINE[grouping.engine]}</span>{grouping.groupedAt && <span>grouped {stamp(grouping.groupedAt)}</span>}{grouping.stale ? <span className="wif-stale-note"><CircleAlert size={12} />{grouping.note || 'Changed since it was grouped.'}</span> : grouping.note && <span>{grouping.note}</span>}</p>;

  const fileNode = (parent: string, path: string, item: WifFile | undefined, shared: boolean) => {
    const id = `f:${parent}:${shared ? 's' : 'o'}:${path}`;
    const [letter, word] = LETTER[item?.status || 'modified'];
    const [dir, base] = split(path);
    const lines = item && !item.binary && !item.isDir && (item.added || item.removed) ? <span className="wif-lines"><span className="plus">+{item.added ?? 0}</span> <span className="minus">−{item.removed ?? 0}</span></span> : null;
    return node(id, 4, undefined, 'wif-file', <div className="wif-row wif-file-row">
      <span className="wif-glyph">{item ? <span className={`wif-letter ${item.status}`} title={word} aria-hidden="true">{letter}</span> : <span className="wif-letter" aria-hidden="true">·</span>}</span>
      <div className="wif-row-main"><div className="wif-row-title">
        <span className="wif-file-path" id={domId(id)} title={path}><span className="dir">{dir}</span>{base}{item && <span className="sr-only">, {word}</span>}</span>
        {item?.isDir && item.fileCount !== null && <span className="wif-file-note">{plural(item.fileCount, 'file')}</span>}
        {shared && <span className="wif-file-note">shared with another piece of work</span>}
        {item?.private && <span className="wif-private" title={PRIVATE_TIP}><Lock size={11} />private</span>}
        {lines && <span className="wif-row-aside">{lines}</span>}
      </div></div>
    </div>);
  };

  const streamNode = (place: WifPlace, grouping: WifGrouping, stream: WifWorkstream, files: Map<string, WifFile>) => {
    const id = `w:${place.id}:${stream.id}`;
    const isOpen = expanded(id, false);
    const count = fileTotal(stream.files, files);
    const areaTone = AREA_TONE[stream.area] || '';
    const children = [...stream.files.map(path => fileNode(id, path, files.get(path), false)), ...stream.sharedFiles.map(path => fileNode(id, path, files.get(path), true))];
    const facts = [plural(count, 'file'), (stream.added > 0 || stream.removed > 0) ? `${plural(stream.added, 'line')} added, ${stream.removed} removed` : null, stream.private ? 'private' : null, grouping.stale ? 'changed since grouped' : null].filter(Boolean).join(', ');
    return node(id, 3, children.length ? isOpen : undefined, `wif-stream ${stream.readiness}`, <div className="wif-row wif-stream-row">
      <span className="wif-glyph"><span className={`wif-ready-dot ${stream.readiness}`} aria-hidden="true" /></span>
      <div className="wif-row-main">
        <div className="wif-row-title">
          {grouping.engine !== 'paths' && <span className={`wif-area ${areaTone}`}>{stream.area.replace('-', ' ').toUpperCase()}</span>}
          <span className={`wif-stream-title ${grouping.engine === 'paths' ? 'folder' : ''}`} id={domId(id)}>{stream.title}<span className="sr-only">. {READINESS[stream.readiness]}.</span></span>
          <span className="wif-row-aside"><span className={`wif-readiness ${stream.readiness}`} aria-hidden="true">{stream.readiness === 'ready' && <Check size={11} strokeWidth={2.4} />}{READINESS[stream.readiness]}</span></span>
        </div>
        {stream.summary && <p className="wif-summary" id={descId(id, 1)}>{stream.summary}</p>}
        <span className="sr-only" id={descId(id, 2)}>{facts}</span>
        <div className="wif-meta">
          {children.length > 0 && <button type="button" className="wif-files-toggle" tabIndex={-1} aria-hidden="true" onClick={() => setNode(id, !isOpen)}>{plural(count, 'file')}{isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</button>}
          {(stream.added > 0 || stream.removed > 0) && <span className="wif-lines" title="Lines added and removed"><span className="plus">+{stream.added}</span> <span className="minus">−{stream.removed}</span></span>}
          {stream.private && <span className="wif-private" title={PRIVATE_TIP}><Lock size={11} />private</span>}
          {grouping.stale && <span className="wif-stale">changed since grouped</span>}
          {stream.suggestedCommit && <button type="button" className="text-button wif-copy" title={stream.suggestedCommit} onClick={() => void copy(id, stream.suggestedCommit!)}>{copied === id ? <><Check size={12} />Copied</> : <><Copy size={12} />Copy commit message</>}</button>}
        </div>
      </div>
    </div>, children, [...(stream.summary ? [descId(id, 1)] : []), descId(id, 2)]);
  };

  const agentChip = (placeId: string) => {
    const entry = agentPlaces[placeId];
    if (!entry || !entry.text) return null;
    const tone = entry.needsYou ? 'needs' : entry.working ? 'working' : entry.newReplies ? 'new' : 'open';
    const content = <>{tone === 'working' ? <span className="wif-agent-pulse" aria-hidden="true" /> : <Bot size={11} aria-hidden="true" />}<span className="wif-chip-text">{entry.text}</span></>;
    return onOpenSessions
      ? <button type="button" className={`wif-chip wif-agent-chip ${tone}`} title="Show in Agent sessions (⌘E)" onClick={onOpenSessions}>{content}</button>
      : <span className={`wif-chip wif-agent-chip ${tone}`}>{content}</span>;
  };

  const placeNode = (repo: WifRepo, place: WifPlace) => {
    const id = `p:${place.id}`;
    const grouping = place.mirrorOf || place.missing ? null : place.grouping;
    const streams = grouping?.workstreams ?? [];
    const isOpen = streams.length ? expanded(id, true) : undefined;
    const Icon = place.missing ? FolderX : place.kind === 'main' || place.kind === 'other' ? Folder : Bot;
    const mirror = place.mirrorOf ? repo.places.find(item => item.id === place.mirrorOf)?.label || 'Main folder' : null;
    const words = mirror ? place.stateWords.filter(word => !MIRROR_WORD.test(word)) : place.stateWords;
    const files = new Map((place.files ?? []).map(item => [item.path, item]));
    const described = [mirror ? descId(id, 1) : null, place.error ? descId(id, 2) : null, grouping ? descId(id, 3) : null].filter((item): item is string => Boolean(item));
    const spoken = [...words, ...(place.missing && !words.some(word => /folder is gone/i.test(word)) ? ['folder is gone'] : [])];
    return node(id, 2, isOpen, `wif-place ${place.kind} ${place.missing ? 'missing' : ''} ${mirror ? 'mirror' : ''}`, <div className="wif-row wif-place-row">
      <span className="wif-glyph"><Icon size={15} strokeWidth={1.7} /></span>
      <div className="wif-row-main">
        <div className="wif-row-title">
          <span className="wif-place-label" id={domId(id)} title={place.displayPath}>{place.label}<span className="sr-only">{spoken.length ? `, ${spoken.join(', ')}` : ''}</span></span>
          {place.branch && !place.detached && <span className="wif-chip" title={`Branch ${place.branch}`}><GitBranch size={11} /><span className="wif-chip-text">{place.branch}</span></span>}
          {!place.missing && agentChip(place.id)}
          {isOpen !== undefined && twisty(id, isOpen)}
          {!place.missing && <span className="wif-row-aside"><button type="button" className="text-button wif-reveal" disabled={offline} aria-label={`Show ${place.label} in Finder`} onClick={() => void reveal(place.id)}>Show in Finder<ArrowUpRight size={12} /></button></span>}
        </div>
        {words.length > 0 && <p className="wif-state" aria-hidden="true"><Words list={words} /></p>}
        {mirror && <p className="wif-mirror" id={descId(id, 1)}>Its unsaved changes are all in {mirror} too, so they are listed there.</p>}
        {place.error && <p className="wif-row-error" id={descId(id, 2)}><CircleAlert size={12} />{place.error}</p>}
        {grouping && provenance(grouping, descId(id, 3))}
      </div>
    </div>, streams.map(stream => streamNode(place, grouping!, stream, files)), described);
  };

  const branchNode = (repo: WifRepo, branch: WifBranch) => {
    const id = `bn:${repo.id}:${branch.name}`;
    return node(id, branch.merged ? 4 : 3, undefined, `wif-branch ${branch.merged ? 'merged' : ''}`, <div className="wif-row wif-branch-row">
      <span className="wif-glyph">{branch.merged ? <Check size={12} strokeWidth={2.2} className="wif-merged-mark" /> : <span className="wif-branch-dot" aria-hidden="true" />}</span>
      <div className="wif-row-main">
        <div className="wif-row-title"><span className="wif-branch-name" id={domId(id)}>{branch.name}<span className="sr-only">{branch.stateWords.length ? `, ${branch.stateWords.join(', ')}` : ''}{branch.lastCommitAt ? `, last saved ${relative(branch.lastCommitAt)}` : ''}</span></span>{branch.lastCommitAt && <span className="wif-row-aside wif-when" title={stamp(branch.lastCommitAt)} aria-hidden="true">{relative(branch.lastCommitAt)}</span>}</div>
        {branch.stateWords.length > 0 && <p className="wif-state" aria-hidden="true"><Words list={branch.stateWords} /></p>}
        {branch.summary
          ? <p className="wif-summary" id={descId(id, 1)}>{branch.summary} <span className="wif-evidence inline"><Sparkles size={11} />Suggested{branch.summaryStale ? ', may be out of date' : ''}</span></p>
          : !branch.merged && branch.subject && <p className="wif-summary wif-subject" id={descId(id, 1)}>Latest checkpoint: “{branch.subject}”</p>}
      </div>
    </div>, undefined, branch.summary || (!branch.merged && branch.subject) ? [descId(id, 1)] : undefined);
  };

  const branchesNode = (repo: WifRepo) => {
    const id = `b:${repo.id}`;
    const live = repo.branches.filter(branch => !branch.merged);
    const merged = repo.branches.filter(branch => branch.merged);
    const isOpen = expanded(id, live.length > 0);
    const doneId = `m:${repo.id}`;
    const doneOpen = expanded(doneId, false);
    const done = merged.length ? node(doneId, 3, doneOpen, 'wif-group wif-done', <div className="wif-row wif-group-row">
      <span className="wif-glyph"><Check size={13} /></span>
      <div className="wif-row-main"><div className="wif-row-title"><span className="wif-done-label wif-toggle" id={domId(doneId)} onClick={() => setNode(doneId, !doneOpen)}>{plural(merged.length, 'finished branch', 'finished branches')}, safe to clean up</span>{twisty(doneId, doneOpen)}</div></div>
    </div>, merged.map(branch => branchNode(repo, branch))) : null;
    return node(id, 2, isOpen, 'wif-group', <div className="wif-row wif-group-row">
      <span className="wif-glyph"><GitBranch size={14} /></span>
      <div className="wif-row-main"><div className="wif-row-title"><span className="wif-group-label wif-toggle" id={domId(id)} onClick={() => setNode(id, !isOpen)}>Branches<span className="sr-only">, {live.length ? `${live.length} open` : 'none open'}{merged.length ? `, ${merged.length} finished` : ''}</span></span><span className="wif-group-count" aria-hidden="true">{live.length ? `${live.length} open` : 'none open'}{merged.length ? ` · ${merged.length} finished` : ''}</span>{twisty(id, isOpen)}</div></div>
    </div>, [...live.map(branch => branchNode(repo, branch)), ...(done ? [done] : [])]);
  };

  const stashNode = (repo: WifRepo, stash: WifStash) => {
    const id = `sn:${repo.id}:${stash.index}`;
    return node(id, 3, undefined, 'wif-stash', <div className="wif-row wif-branch-row">
      <span className="wif-glyph"><span className="wif-branch-dot shelf" aria-hidden="true" /></span>
      <div className="wif-row-main">
        <div className="wif-row-title"><span className="wif-stash-text" id={domId(id)}>“{stashText(stash.message)}”<span className="sr-only">, {[stash.branch ? `from ${stash.branch}` : null, plural(stash.files, 'file'), stash.createdAt ? relative(stash.createdAt) : null].filter(Boolean).join(', ')}</span></span>{stash.createdAt && <span className="wif-row-aside wif-when" title={stamp(stash.createdAt)} aria-hidden="true">{relative(stash.createdAt)}</span>}</div>
        <p className="wif-state" aria-hidden="true">{[stash.branch ? `from ${stash.branch}` : null, plural(stash.files, 'file')].filter(Boolean).join(' · ')}</p>
      </div>
    </div>);
  };

  const stashesNode = (repo: WifRepo) => {
    const id = `s:${repo.id}`;
    const isOpen = expanded(id, true);
    return node(id, 2, isOpen, 'wif-group', <div className="wif-row wif-group-row">
      <span className="wif-glyph"><Archive size={14} /></span>
      <div className="wif-row-main"><div className="wif-row-title"><span className="wif-group-label wif-toggle" id={domId(id)} onClick={() => setNode(id, !isOpen)}>Set aside<span className="sr-only">, {plural(repo.stashes.length, 'change', 'changes')}</span></span><span className="wif-group-count" aria-hidden="true">{repo.stashes.length}</span>{twisty(id, isOpen)}</div></div>
    </div>, repo.stashes.map(stash => stashNode(repo, stash)));
  };

  const repoNode = (repo: WifRepo) => {
    const id = `r:${repo.id}`;
    const children = [...repo.places.map(place => placeNode(repo, place)), ...(repo.branches.length ? [branchesNode(repo)] : []), ...(repo.stashes.length ? [stashesNode(repo)] : [])];
    const isOpen = children.length ? expanded(id, true) : undefined;
    const stale = needsGrouping(repo);
    // A project that could not be checked has an unknown remote; say nothing rather than "Not on GitHub".
    const remote = repo.status === 'error' ? null : repo.hasRemote ? repo.lastFetchedAt ? `GitHub checked ${day(repo.lastFetchedAt)}` : 'GitHub not checked yet' : 'Not on GitHub';
    const canGroup = !offline && !running && !pending && view?.settings.engine !== 'off' && repo.status !== 'error' && repo.places.some(place => !place.mirrorOf && !place.missing && place.counts.items > 1);
    const notes = standingNotes(repo, standing, evidence).filter(note => !(RAIL_KINDS.has(note.kind) && railPlaces.has(note.placeId)));
    return node(id, 1, isOpen, `wif-repo ${repo.status}`, <div className="wif-row wif-repo-row">
      <span className={`wif-glyph wif-repo-glyph ${repo.status}`}><FolderGit2 size={17} strokeWidth={1.6} /></span>
      <div className="wif-row-main">
        <div className="wif-row-title">
          <span className="wif-repo-name wif-toggle" id={domId(id)} onClick={() => isOpen !== undefined && setNode(id, !isOpen)}>{repo.name}<span className="sr-only">, {STATUS_WORD[repo.status]}</span></span>
          {isOpen !== undefined && twisty(id, isOpen)}
          <span className="wif-path" title={repo.path}>{repo.displayPath}</span>
          <span className="wif-row-aside">
            {remote && <span className="wif-remote">{remote}</span>}
            {repo.places.some(place => !place.mirrorOf && !place.missing && place.counts.items > 1) && <button type="button" className="text-button" disabled={!canGroup} onClick={() => void group(repo.id, { force: !stale })}>{stale ? <Sparkles size={12} /> : <RefreshCw size={12} />}{stale ? 'Group this project' : 'Group again'}</button>}
          </span>
        </div>
        <p className={`wif-headline ${repo.status}`} id={descId(id, 1)}>{repo.status === 'error' && <CircleAlert size={14} />}{repo.error && repo.status === 'error' ? repo.error : repo.headline}</p>
        {isOpen && notes.length > 0 && <div className="wif-standing-block" id={descId(id, 2)}>
          <p className="wif-standing-head">Since you last looked</p>
          <ul className="wif-standing-notes">{notes.slice(0, NOTE_CAP).map(note => <li key={note.id} className={note.inferred ? 'guess' : ''} title={note.inferred ? GUESS_TIP : undefined}>
            <span className="wif-standing-dot" aria-hidden="true" />{note.text}{note.inferred && <span className="sr-only"> A guess from what changed on disk.</span>}
          </li>)}</ul>
          {notes.length > NOTE_CAP && <p className="wif-standing-more">({notes.length - NOTE_CAP} more)</p>}
        </div>}
      </div>
    </div>, children, isOpen && notes.length > 0 ? [descId(id, 1), descId(id, 2)] : [descId(id, 1)]);
  };

  const railRow = (repo: WifRepo) => {
    const count = openCount(repo);
    return <button key={repo.id} type="button" className={`wif-rail-row ${choice === repo.id ? 'selected' : ''}`} aria-pressed={choice === repo.id} onClick={() => choose(repo.id)}>
      <span className={`wif-status-dot ${repo.status}`} aria-hidden="true" />
      <span className="wif-rail-name">{repo.name}<span className="sr-only">, {STATUS_WORD[repo.status]}</span></span>
      {count > 0 ? <span className="wif-rail-count" title={openParts(repo)}><span aria-hidden="true">{count}</span><span className="sr-only">, {plural(count, 'open item')}</span></span> : <span />}
      {repo.status !== 'clean' && <span className="wif-rail-line" title={repo.status === 'error' ? repo.error || repo.headline : repo.headline}>{repo.status === 'error' ? repo.error || repo.headline : repo.headline}</span>}
    </button>;
  };

  const settings = view?.settings;
  // The button only appears when something is waiting to be read; without the app behind it, it stays greyed.
  const canMark = Boolean(standing?.text && Object.keys(standing.byRepo ?? {}).length > 0);
  // With a bridge, no view and no scan in progress can only mean the first load failed.
  const failedLoad = !view && !scanning && !offline;
  const groupDisabled = offline || !view || running || pending || settings?.engine === 'off';
  const shownJob = job && job.id !== dismissedJob ? job : null;

  return <dialog ref={dialog} className="preferences-dialog wif-dialog" aria-labelledby="wif-title" onCancel={event => { event.preventDefault(); onClose(); }} onClose={() => onClose()} onClick={event => { if (event.target === dialog.current) onClose(); }}>
    <div className={`preferences-content wif-content ${privacyOpen ? 'wif-scroll-all' : ''}`}>
      <header className="preferences-heading wif-heading">
        <div>
          <span className="eyebrow">WORK IN FLIGHT</span>{preview && <span className="preview-badge wif-preview-badge">Preview · sample projects</span>}
          <h2 id="wif-title">What is unfinished</h2>
          <p className="wif-totals">{!view ? failedLoad ? 'Could not check your projects.' : 'Checking your projects…' : view.repos.length ? totalsLine(view.totals, view.repos) : 'No git projects to check yet.'}</p>
          {standing?.text && <p className="wif-standing">{standing.text}{canMark && <button type="button" className="text-button wif-mark" disabled={offline || markedAll || typeof bridge?.markStanding !== 'function'} onClick={() => void mark(null, true)}>{markedAll ? <><Check size={12} />Marked as read</> : 'Mark as read'}</button>}</p>}
        </div>
        <button className="icon-button" aria-label="Close work in flight" onClick={onClose}><X size={20} /></button>
      </header>

      <div className="wif-toolbar" role="group" aria-label="Work in flight actions">
        <button type="button" className={`button small-button wif-refresh ${scanning ? 'spinning' : ''}`} disabled={offline || scanning} onClick={() => void load(true)}><RefreshCw size={13} />{scanning ? 'Checking…' : 'Refresh'}</button>
        <button type="button" className="button primary small-button" disabled={groupDisabled} title={settings?.engine === 'off' ? 'Choose Codex or Claude to group changes' : undefined} onClick={() => void group(null)}>{running || pending ? <LoaderCircle size={13} className="spinner" /> : <Sparkles size={13} />}Group changes{view && view.totals.staleGroupings > 0 && <span className="wif-button-count" title={`${plural(view.totals.staleGroupings, 'folder')} to group`}><span aria-hidden="true">{view.totals.staleGroupings}</span><span className="sr-only">, {plural(view.totals.staleGroupings, 'folder')} to group</span></span>}</button>
        <span className="wif-toolbar-divider" aria-hidden="true" />
        <label className="wif-engine"><span>Group with</span><select value={settings?.engine ?? 'codex'} disabled={offline || pending || !view} onChange={event => void saveSettings({ engine: event.target.value as WifSettings['engine'] })}><option value="codex">Codex</option><option value="claude">Claude</option><option value="off">Folders only</option></select><ChevronDown size={12} /></label>
        <label className="wif-switch" title={settings && !settings.consentedAt ? 'Starts after you press Group changes once' : undefined}><Toggle label={settings && !settings.consentedAt ? 'Group on open, after your first Group changes' : 'Group on open'} checked={Boolean(settings?.groupOnOpen)} disabled={offline || pending || !view || settings?.engine === 'off'} onChange={value => void saveSettings({ groupOnOpen: value })} /><span aria-hidden="true">Group on open{settings && !settings.consentedAt ? ' (after your first Group changes)' : ''}</span></label>
        <div className="wif-toolbar-end">
          {view && <span className="wif-checked" title={stamp(view.scannedAt)}>Checked {relative(view.scannedAt)}</span>}
          <details className="wif-glossary" ref={glossary}><summary><CircleHelp size={13} />What do these words mean?</summary><dl>{GLOSSARY.map(([term, meaning]) => <div key={term}><dt>{term}</dt><dd>{meaning}</dd></div>)}</dl></details>
        </div>
      </div>
      {view?.disclosure && <p className="wif-disclosure"><ShieldCheck size={12} />{view.disclosure}</p>}
      {view && <details className="wif-privacy" open={privacyOpen} onToggle={event => setPrivacyOpen(event.currentTarget.open)}>
        <summary><Lock size={12} />What stays private</summary>
        <div className="wif-privacy-body">
          <p>Always private: folders named {(view.privateDefaults ?? []).join(', ')}; files that look like transcripts, résumés, invoices, passports or ID numbers; saved emails and contact cards; and secret files such as .env files and keys. Grouping never sends their names or contents.</p>
          {repos.length > 0 && privateTarget && <form className="wif-privacy-form" onSubmit={event => { event.preventDefault(); savePrivate(); }}>
            <label className="wif-privacy-project"><span>Also private in</span><select value={privateTarget.id} disabled={offline || pending} onChange={event => setPrivateRepo(event.target.value)}>{repos.map(repo => <option key={repo.id} value={repo.id}>{repo.name}</option>)}</select></label>
            <label className="wif-privacy-input"><span className="sr-only">Private folders in {privateTarget.name}</span><input type="text" value={privateDraft} placeholder="pilot/, docs/legal/" spellCheck={false} disabled={offline || pending} onChange={event => setPrivateDraft(event.target.value)} /></label>
            <button type="submit" className="button small-button" disabled={offline || pending || privateDraft.trim() === savedPrivate}>Save</button>
          </form>}
          <p className="wif-privacy-hint">Folders or files inside the project, separated by commas. The same list is saved under privatePaths in work-in-flight.json in Summon's data folder.</p>
        </div>
      </details>}

      <div className={`wif-job ${shownJob ? shownJob.status : ''} ${shownJob?.errors.length ? 'has-errors' : ''}`} role="status" aria-live="polite">{shownJob && <>
        {running ? <LoaderCircle size={14} className="spinner" /> : shownJob.status === 'failed' ? <CircleAlert size={14} /> : <Check size={14} />}
        <div className="wif-job-text"><span>{jobLine(shownJob)}</span>{shownJob.errors.length > 0 && <ul>{shownJob.errors.map((item, index) => <li key={index}>{item}</li>)}</ul>}</div>
        {!running && <button type="button" className="text-button" onClick={() => setDismissedJob(shownJob.id)}>Dismiss</button>}
      </>}</div>
      {error && !failedLoad && <div className="preferences-error wif-banner wif-error" role="alert"><span>{error}</span><button type="button" className="text-button" onClick={() => setError('')}>Dismiss</button></div>}
      {view?.errors.map((item, index) => <p key={index} className="wif-banner wif-warning"><CircleAlert size={13} />{item}</p>)}

      <div className="wif-body">
        {failedLoad ? <div className="wif-main wif-full"><div className="empty-state" role="alert"><CircleAlert size={32} strokeWidth={1.2} /><h3>Could not check your projects.</h3><p>{error || 'Summon could not read your git projects.'}</p><button type="button" className="button" onClick={() => void load(true)}>Try again</button></div></div>
        : !view ? <>
          <div className="wif-rail" aria-hidden="true">{[70, 54, 62, 48, 58].map((width, index) => <span key={index} className="wif-skeleton rail" style={{ width: `${width}%` }} />)}</div>
          <div className="wif-main" aria-busy="true"><p className="sr-only">Checking your projects…</p>{[0, 1].map(block => <div className="wif-skeleton-block" key={block} aria-hidden="true"><span className="wif-skeleton title" /><span className="wif-skeleton" style={{ width: '58%' }} /><span className="wif-skeleton indent" style={{ width: '72%' }} /><span className="wif-skeleton indent" style={{ width: '64%' }} /><span className="wif-skeleton indent" style={{ width: '46%' }} /></div>)}</div>
        </> : repos.length === 0 ? <div className="wif-main wif-full"><div className="empty-state"><FolderGit2 size={32} strokeWidth={1.2} /><h3>No git projects found.</h3><p>Add a workspace folder in Summon. Work in flight lists the projects in your workspaces that use git.</p></div></div> : <>
          <nav className="wif-rail" aria-label="Projects">
            <button type="button" className={`wif-rail-row all ${choice === ALL ? 'selected' : ''}`} aria-pressed={choice === ALL} onClick={() => choose(ALL)}><span className="wif-status-dot all" aria-hidden="true" /><span className="wif-rail-name">All projects</span><span className="wif-rail-count" title={`${plural(withWork, 'project')} with unfinished work${unchecked ? ` · ${unchecked} could not be checked` : ''}`}><span aria-hidden="true">{withWork}</span><span className="sr-only">, {plural(withWork, 'project')} with unfinished work{unchecked ? `, ${unchecked} not checked` : ''}</span></span></button>
            {unfinished.length > 0 && <div className="wif-rail-rule" />}
            {unfinished.map(railRow)}
            {caughtUp.length > 0 && <details className="wif-rail-clean" open={cleanOpen} onToggle={event => setCleanOpen(event.currentTarget.open)}><summary><ChevronRight size={12} className="wif-summary-chevron" />All caught up ({caughtUp.length})</summary>{caughtUp.map(railRow)}</details>}
          </nav>
          <label className="wif-rail-select"><span className="sr-only">Project</span><select value={choice} onChange={event => choose(event.target.value)}><option value={ALL}>All projects ({withWork} unfinished{unchecked ? `, ${unchecked} not checked` : ''})</option>{unfinished.map(repo => <option key={repo.id} value={repo.id}>{repo.name}{openCount(repo) ? ` (${openCount(repo)} open)` : ''}</option>)}{caughtUp.length > 0 && <optgroup label="All caught up">{caughtUp.map(repo => <option key={repo.id} value={repo.id}>{repo.name}</option>)}</optgroup>}</select><ChevronDown size={13} /></label>
          <section className="wif-main" aria-label={focus ? focus.name : 'All unfinished projects'}>
            {shown.length === 0 ? <div className="empty-state"><Check size={32} strokeWidth={1.2} /><h3>Nothing unfinished.</h3><p>Every project is saved and shared. New changes show up here the next time you open this.</p></div>
              : <ul className="wif-tree" role="tree" aria-label="Unfinished work" ref={tree} onKeyDown={onTreeKey}>{shown.map(repoNode)}</ul>}
            {railRows.length > 0 && <section className="wif-still" aria-labelledby="wif-still-title">
              {/* The core writes one reason per row and the reason carries its own how long, so nothing is said twice. */}
              <div className="wif-still-head"><h3 id="wif-still-title">Not moving</h3><span className="wif-still-rule" aria-hidden="true" /></div>
              <ul>{railRows.slice(0, RAIL_CAP).map(item => <li key={`${item.kind}:${item.placeId}`} className={item.inferred ? 'guess' : ''} title={item.inferred ? GUESS_TIP : undefined}>
                <span className="wif-still-name">{item.repoName}{item.placeLabel && item.placeLabel !== 'Main folder' && <span className="wif-still-place"> · {item.placeLabel}</span>}</span>
                <span className="wif-still-why" title={item.why}>{item.why}{item.inferred && <span className="sr-only"> A guess from what changed on disk.</span>}</span>
              </li>)}</ul>
              {railRows.length > RAIL_CAP && <p className="wif-standing-more">({railRows.length - RAIL_CAP} more)</p>}
            </section>}
            {!focus && caughtUp.length > 0 && <p className="wif-caught-up"><Check size={13} /><span><strong>All caught up:</strong> {caughtUp.map(repo => repo.name).join(', ')}</span></p>}
          </section>
        </>}
      </div>
    </div>
  </dialog>;
}
