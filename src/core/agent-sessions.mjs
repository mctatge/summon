import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { classifyPath, hidePrivateText, sealedPath, redact } from './workstreams.mjs';
import { createHookLedger } from './hook-events.mjs';
import { recentContext, CONTEXT_CHARS } from './sessions/recent-context.mjs';

const VERSION = 1;
const APPS = Object.freeze(['claude', 'codex', 'cursor', 'hermes']);
const SURFACES = Object.freeze(['desktop', 'terminal', 'ide', 'cli', 'background']);
const ACTIVITIES = Object.freeze(['working', 'needs-you', 'failed', 'open', 'quiet', 'interrupted', 'unknown']);
const GROUP_ORDER = Object.freeze(['needs-you', 'new', 'working', 'open', 'interrupted', 'recent']);
const GROUP_TITLES = Object.freeze({ 'needs-you': 'Needs you', new: 'New replies', working: 'Working', open: 'Open, your move', interrupted: 'Interrupted' });
const PLACE_GROUPS = new Set(['needs-you', 'new', 'working', 'open']);
// A worktree belongs to one session, so its changes describe that session. A main folder is shared with everyone else working there.
const OWN_FOLDER_KINDS = new Set(['claude', 'codex', 'cursor']);
const READINESS_WORDS = Object.freeze({ ready: 'looks ready to save', 'in-progress': 'still in progress', scratch: 'scratch work', generated: 'made by a script' });
const WORK_TEXT_CHARS = 90;
const LIMITS = { touchedPaths: 200, touchedHashes: 400, hashFiles: 4000, hashPlaces: 200, headlineChars: 120, workstreams: 16, streamFiles: 4000, budgetMs: 4000, processesMs: 1000, processesTtlMs: 30000, lateResultMs: 10000, staleResultMs: 120000, closeWaitMs: 1500, stateBytes: 262144, aliases: 50, pathChars: 1024, perApp: 300, idChars: 200, titleChars: 120, agentSessions: 60, pathTtlMs: 60000, realpathMs: 1000, pathCache: 4000, places: 2000, projects: 2000, warnings: 12, resolveConcurrency: 16, placeCountsMaxAgeMs: 180000 };
const DEFAULT_SETTINGS = { recentHours: 24, newReplyHours: 72, showQuiet: true, showBackground: false, trayCount: 'needs', pathAliases: {} };
// What the menu bar counts: 'needs' shows an item while sessions need you or something is working, 'working' also
// counts background runs the list leaves out, 'off' means no item and no background check at all.
const TRAY_COUNTS = Object.freeze(['needs', 'working', 'off']);
const MINUTE = 60000;
const HOUR = 3600000;
const DAY = 86400000;
const APP_NAMES = Object.freeze({ claude: 'Claude', codex: 'Codex', cursor: 'Cursor', hermes: 'Hermes' });
const SOURCE_LABELS = Object.freeze({ claude: 'Claude app', codex: 'Codex', cursor: 'Cursor', hermes: 'Hermes' });
const SURFACE_WORDS = Object.freeze({ terminal: 'in Terminal', cli: 'in Terminal', background: 'in the background' });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLAUDE_LOCAL = /^local_[A-Za-z0-9-]{1,64}$/;
const HERMES_ID = /^\d{8}_\d{6}_[0-9a-f]{6}$/;
// How Claude names a file-history entry, and how a path we already have is turned into the same name. The hash is one
// way: it can be compared with a path we already know, and it can never be turned back into a path we do not.
const HASH16 = /^[0-9a-f]{16}$/;
const GONE = 'That session is no longer in the list.';
const CANNOT_OPEN = 'Summon cannot open this session.';
const STILL_CHECKING = 'Still checking.';
const LAST_GOOD = 'Could not be read just now; showing the last list Summon read.';
const HIDDEN_TITLE = 'Title hidden (private folder)';
const HIDDEN_HEADLINE = 'Work in a private folder';
// Folders that only hold other folders, so 'src/engine' says more than 'src' (the same list Work in flight uses).
const NESTED_ROOTS = new Set(['src', 'apps', 'packages', 'services', 'libs', 'crates', 'backend', 'frontend']);
const SETTINGS_PROBLEM = 'Agent sessions settings could not be read';
// Reader modules load on first use, so a missing or broken reader becomes a plain warning instead of stopping Summon.
const READER_MODULES = Object.freeze({
  claude: { load: () => import('./sessions/claude.mjs'), create: 'createClaudeReader', read: 'readClaudeSessions' },
  codex: { load: () => import('./sessions/codex.mjs'), create: 'createCodexReader', read: 'readCodexSessions' },
  cursor: { load: () => import('./sessions/cursor.mjs'), create: 'createCursorReader', read: 'readCursorSessions' },
  hermes: { load: () => import('./sessions/hermes.mjs'), create: 'createHermesReader', read: 'readHermesSessions' },
});

const iso = ms => new Date(ms).toISOString();
const clone = value => structuredClone(value);
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const listOf = value => Array.isArray(value) ? value : [];
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0') && path.normalize(value) === value;
const inside = (candidate, root) => { const base = root.length > 1 ? root.replace(/\/+$/, '') : root; return candidate === base || candidate.startsWith(base.endsWith(path.sep) ? base : `${base}${path.sep}`); };
// Titles, labels and reader messages are untrusted: drop control and bidirectional-override characters.
// The cut never splits a surrogate pair (an emoji at the limit is dropped whole).
const cut = (text, max) => { const out = text.slice(0, max); return /[\ud800-\udbff]$/.test(out) ? out.slice(0, -1) : out; };
const clean = (value, max = 300) => typeof value === 'string' ? cut(value.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/ {2,}/g, ' ').trim(), max) : '';
const signature = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
const count = value => Number.isSafeInteger(value) && value > 0 ? value : 0;
const whole = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
// Where changed files sit, as a folder inside the project ('src/engine'), never a full path.
const areaText = value => { const text = clean(value, 80); return text && !text.startsWith('/') && !text.includes('..') ? text : null; };
const epoch = value => Number.isFinite(value) && value > 0 ? value : null;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pathHash = value => createHash('sha256').update(value).digest('hex').slice(0, 16);
const nameKey = value => typeof value === 'string' ? value.normalize('NFC').toLowerCase().replace(/[-_\s]+/g, '') : '';
const lowerFirst = text => text ? text[0].toLowerCase() + text.slice(1) : text;
// Which Work in flight folders, and which pieces of work inside them, a check was matched against. A new scan makes
// the cached view stale, and so does a regroup, which renames the pieces of work.
const placesKeyOf = list => Array.isArray(list) ? JSON.stringify(list.slice(0, LIMITS.places).map(place => isObject(place)
  ? [place.id, place.path, place.label, listOf(place.workstreams).slice(0, LIMITS.workstreams).map(stream => isObject(stream) ? stream.id ?? stream.title : null)]
  : null)) : '';
const shellQuote = value => /^[A-Za-z0-9_/.,:@%+=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;

/** A full folder path without a trailing slash, or null. */
function folderPath(value) {
  if (typeof value !== 'string' || !value || value.length > LIMITS.pathChars || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const trimmed = value.length > 1 ? value.replace(/\/+$/, '') || '/' : value;
  return absolute(trimmed) ? trimmed : null;
}

function startOfDay(ms) { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
function dayWords(at, nowMs) {
  if (at < startOfDay(nowMs) && at >= startOfDay(startOfDay(nowMs) - 1)) return 'yesterday';
  const sameYear = new Date(at).getFullYear() === new Date(nowMs).getFullYear();
  return new Date(at).toLocaleDateString('en-US', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}
/** How long ago: 'just now', '5 min ago', '2 h ago', 'yesterday', 'Sep 12'. */
function agoText(at, nowMs) {
  const ms = Math.max(0, nowMs - at);
  if (ms < MINUTE) return 'just now';
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} min ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)} h ago`;
  return dayWords(at, nowMs);
}
/** How long something has lasted: 'just now', '12 min', '2 h', 'since yesterday', 'since Sep 12'. */
function forText(at, nowMs) {
  const ms = Math.max(0, nowMs - at);
  if (ms < MINUTE) return 'just now';
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} min`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)} h`;
  return `since ${dayWords(at, nowMs)}`;
}

function appLabel(app, surface) {
  if (app === 'claude' && surface === 'desktop') return 'Claude app';
  const words = SURFACE_WORDS[surface];
  return words ? `${APP_NAMES[app]} ${words}` : APP_NAMES[app];
}

/** The menu bar sentence: "2 sessions are waiting on you. 1 working." Sessions that are merely open are not counted. */
export function sessionSummaryText({ needsYou = 0, working = 0 } = {}) {
  const parts = [];
  if (needsYou > 0) parts.push(`${plural(needsYou, 'session')} ${needsYou === 1 ? 'is' : 'are'} waiting on you.`);
  if (working > 0) parts.push(needsYou > 0 ? `${working} working.` : `${plural(working, 'session')} ${working === 1 ? 'is' : 'are'} working.`);
  return parts.join(' ') || 'Nothing is waiting on you.';
}

function normalizeSettings(patch, current) {
  if (!isObject(patch)) throw new Error('Settings must be an object.');
  const next = clone(current);
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'recentHours') {
      if (!Number.isInteger(value) || value < 1 || value > 168) throw new Error('Recent hours must be a whole number from 1 to 168.');
      next.recentHours = value;
    } else if (key === 'newReplyHours') {
      if (!Number.isInteger(value) || value < 1 || value > 720) throw new Error('New reply hours must be a whole number from 1 to 720.');
      next.newReplyHours = value;
    } else if (key === 'showQuiet' || key === 'showBackground') {
      if (typeof value !== 'boolean') throw new Error(`${key} must be true or false.`);
      next[key] = value;
    } else if (key === 'trayCount') {
      if (!TRAY_COUNTS.includes(value)) throw new Error('The menu bar count must be needs, working or off.');
      next.trayCount = value;
    } else if (key === 'pathAliases') {
      if (!isObject(value) || Object.keys(value).length > LIMITS.aliases) throw new Error(`Moved folders must be an object with up to ${LIMITS.aliases} entries.`);
      const aliases = {};
      for (const [from, to] of Object.entries(value)) {
        const oldPath = folderPath(from);
        const newPath = folderPath(to);
        if (!oldPath || !newPath) throw new Error('Each moved folder needs its old and new full paths, starting with /.');
        if (sealedPath(oldPath) || sealedPath(newPath)) throw new Error('Summon never checks sealed folders.');
        if (oldPath === '/') throw new Error('The old folder cannot be the whole disk.');
        if (oldPath === newPath) throw new Error('A moved folder needs a new path that is different from the old one.');
        aliases[oldPath] = newPath;
      }
      next.pathAliases = aliases;
    } else throw new Error(`Unknown setting: ${clean(key, 60)}`);
  }
  return next;
}

/** Keeps every valid setting (and every valid moved folder) from a file that failed validation. */
function salvageSettings(raw, issues) {
  let next = clone(DEFAULT_SETTINGS);
  if (!isObject(raw)) { issues.push('Settings must be an object.'); return next; }
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'pathAliases' && isObject(value)) {
      const kept = {};
      for (const [from, to] of Object.entries(value).slice(0, LIMITS.aliases)) {
        try { Object.assign(kept, normalizeSettings({ pathAliases: { [from]: to } }, next).pathAliases); } catch (error) { issues.push(error.message); }
      }
      next.pathAliases = kept;
      continue;
    }
    try { next = normalizeSettings({ [key]: value }, next); } catch (error) { issues.push(error.message); }
  }
  return next;
}

function applyAliases(value, aliases) {
  let best = null;
  for (const from of Object.keys(aliases)) if (inside(value, from) && (best === null || from.length > best.length)) best = from;
  return best === null ? value : path.join(aliases[best], value.slice(best.length));
}

/** What a reader counted for this session itself: lines and files, never file names or anything a person wrote. */
function sessionWork(raw) {
  if (!isObject(raw)) return null;
  const added = whole(raw.added), removed = whole(raw.removed), files = whole(raw.files);
  if (added === null && removed === null && files === null) return null;
  return { added, removed, files, area: areaText(raw.area), scope: 'session', workstream: null, workstreamState: null };
}

/** Checks one reader session against the contract and keeps only known fields. */
function sessionChildren(raw, app, parentSessionKey) {
  if (!['claude', 'codex'].includes(app) || !Array.isArray(raw)) return [];
  const childTime = value => epoch(typeof value === 'string' ? Date.parse(value) : value);
  const identifier = value => typeof value === 'string' && value.length <= 450 && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value);
  const rows = raw.slice(0, 100).filter(child => isObject(child) && child.provider === app && identifier(child.id)
    && identifier(child.key) && child.key.startsWith(`${app}:`) && child.key !== parentSessionKey
    && identifier(child.parentSessionKey) && childTime(child.updatedAt) !== null);
  const byKey = new Map(rows.map(child => [child.key, child]));
  const reachesParent = child => {
    const seen = new Set([child.key]);
    let parent = child.parentSessionKey;
    while (parent !== parentSessionKey) {
      if (seen.has(parent) || !byKey.has(parent)) return false;
      seen.add(parent); parent = byKey.get(parent).parentSessionKey;
    }
    return true;
  };
  return [...byKey.values()].filter(reachesParent).map(child => ({
    key: child.key, id: child.id, parentSessionKey: child.parentSessionKey, provider: app,
    // Internal only: each child's own folder determines its privacy policy, even across repositories.
    cwd: folderPath(child.cwd), worktreePath: folderPath(child.worktreePath),
    label: clean(child.label, LIMITS.titleChars) || 'Helper',
    activity: ACTIVITIES.includes(child.activity) ? child.activity : 'unknown',
    confidence: child.confidence === 'reported' ? 'reported' : 'inferred',
    startedAt: childTime(child.startedAt) === null ? null : iso(childTime(child.startedAt)), updatedAt: iso(childTime(child.updatedAt)),
    endedAt: childTime(child.endedAt) === null ? null : iso(childTime(child.endedAt)),
  }));
}
function sanitizeSession(raw, app) {
  if (!isObject(raw) || raw.app !== app || !SURFACES.includes(raw.surface)) return null;
  if (typeof raw.id !== 'string' || !raw.id || raw.id.length > LIMITS.idChars || /[\u0000-\u0020\u007f-\u009f]/.test(raw.id)) return null;
  const pathOrNull = value => folderPath(value);
  const reason = clean(raw.reason, 120) || null;
  return {
    app, surface: raw.surface, id: raw.id, title: clean(raw.title, LIMITS.titleChars) || null,
    // Only the Claude reader can join a desktop local_ id to its CLI hook id. Never derive it from a display key.
    hookSessionId: app === 'claude' && typeof raw.hookSessionId === 'string' && UUID.test(raw.hookSessionId) ? raw.hookSessionId.toLowerCase() : UUID.test(raw.id) ? raw.id.toLowerCase() : null,
    cwd: pathOrNull(raw.cwd), worktreePath: pathOrNull(raw.worktreePath), branch: clean(raw.branch, 200) || null,
    startedAt: epoch(raw.startedAt), updatedAt: epoch(raw.updatedAt),
    activity: ACTIVITIES.includes(raw.activity) ? raw.activity : 'unknown', activitySince: epoch(raw.activitySince), reason,
    unread: raw.unread === true, archived: raw.archived === true, pinned: raw.pinned === true, live: raw.live === true,
    confidence: raw.confidence === 'inferred' ? 'inferred' : 'reported', helpers: count(raw.helpers), helpersInferred: raw.helpersInferred === undefined ? app === 'claude' : raw.helpersInferred === true, model: clean(raw.model, 80) || null,
    children: sessionChildren(raw.children, app, `${app}:${raw.surface}:${raw.id}`),
    work: sessionWork(raw.work),
    recentContext: recentContext(raw.recentContext?.messages),
    // Only 'user' is a claim; everything else, including a reader that says nothing, counts as the app's own wording.
    titleSource: raw.titleSource === 'user' ? 'user' : 'auto',
    // Full paths of the files this session edited, newest first. Names only: no reader ever sends their contents.
    touchedPaths: listOf(raw.touchedPaths).filter(absolute).slice(0, LIMITS.touchedPaths),
    // The same files as hashes of their paths, plus how many distinct ones there are and when the newest was written.
    // A hash only ever answers "is this one of the files we already have?"; it names nothing on its own.
    touchedHashes: listOf(raw.touchedHashes).filter(value => typeof value === 'string' && HASH16.test(value)).slice(0, LIMITS.touchedHashes),
    touchedFiles: whole(raw.touchedFiles),
    touchedAt: epoch(raw.touchedAt),
    // Summon's own fact, not app text: the reader saw the launch tag Summon wrote when it started this session.
    origin: raw.origin === 'summon' ? 'summon' : null,
  };
}

/** Where a session's own edits sit, as a folder inside the project, when at least half of them sit in the same place. */
function areaFromPaths(relPaths) {
  const tally = new Map();
  for (const rel of relPaths) {
    const dirs = rel.split('/').filter(Boolean).slice(0, -1);
    if (!dirs.length) continue;
    const key = dirs.length > 1 && NESTED_ROOTS.has(dirs[0].toLowerCase()) ? `${dirs[0]}/${dirs[1]}` : dirs[0];
    tally.set(key, (tally.get(key) || 0) + 1);
  }
  let best = null;
  for (const [key, n] of tally) if (!best || n > best.n) best = { key, n };
  return best && best.n * 2 >= relPaths.length ? areaText(best.key) : null;
}

/** Which piece of work in this folder a session's own edits fall in, or null when they do not clearly fall in one.
 *  Reported, not guessed: the files the session wrote are in that workstream's own file list, and it takes either two
 *  files in common or a third of everything the session touched. A tie goes to the smaller, more specific workstream. */
function streamFor(relPaths, streams) {
  if (!relPaths.length || !streams?.length) return null;
  let best = null;
  for (const stream of streams) {
    if (!stream.files.size) continue;
    let hits = 0;
    for (const rel of relPaths) if (stream.files.has(rel)) hits++;
    if (!hits || (hits < 2 && hits / relPaths.length < 0.3)) continue;
    if (!best || hits > best.hits || (hits === best.hits && stream.files.size < best.stream.files.size)) best = { stream, hits };
  }
  return best?.stream ?? null;
}

/** The same question for a session that named no paths at all: the hashed names of the files it has backed up against
 *  the same hashes of the files each piece of work covers. Two files in common that are a twentieth of what the
 *  session has written, or a single one that is a third of both sides, and a clear win over the runner-up. A tie or a
 *  weak overlap names nothing, because a wrong answer about what a session is doing is worse than no answer, and what
 *  this returns is marked inferred wherever it is shown. The answer is a position in `streams`, so a piece of work
 *  read here is always the one this scan passed in, however long the hashed lists have been kept. */
function streamByHashes(hashes, indexed, streams) {
  if (!hashes.length || !indexed.length) return null;
  const seen = new Set(hashes);
  let best = null;
  let runnerUp = 0;
  for (const entry of indexed) {
    if (!entry.files.length) continue;
    let hits = 0;
    // One file can be hashed under more than one spelling of its folder, so it is counted once however it matched.
    for (const variants of entry.files) if (variants.some(hash => seen.has(hash))) hits++;
    if (!hits) continue;
    // Two files in common are only evidence when they are a real share of what this session has written: without that
    // floor a version bump and a memo, which one piece of work happens to own, would name work it is not on. A piece
    // of work too big for one file to stand for is never the answer, but it is still the other side of a split and
    // counts as the runner-up, so a single file cannot hand the session to the smaller list on its own.
    const enough = hits / seen.size >= (hits < 2 ? 0.3 : 0.05) && (hits >= 2 || hits / entry.files.length >= 0.3);
    if (enough && (!best || hits > best.hits)) { runnerUp = best ? best.hits : runnerUp; best = { index: entry.index, hits }; }
    else if (hits > runnerUp) runnerUp = hits;
  }
  return best && best.hits > runnerUp ? streams[best.index] ?? null : null;
}

/** How much a session has touched, when nothing else is known about it: a real count of files and a real time, both
 *  from the reader. Nothing here is estimated, so a session the reader could not count says nothing.
 *  The reader counts every file that session backed up, wherever it lives, so this is the session's own writing and
 *  never a count of work in this folder. 'in all' is what says so on the row. */
function touchedTextFor(session, nowMs) {
  const files = session.touchedFiles;
  if (!files) return '';
  // agoText already ends in 'ago' or says 'just now', so the sentence reads as one line either way.
  const when = session.touchedAt === null ? null : agoText(session.touchedAt, nowMs);
  return when ? `touched ${plural(files, 'file')} in all, most recently ${when}` : `touched ${plural(files, 'file')} in all`;
}

function informative(session) {
  const activity = session.activity === 'needs-you' || session.activity === 'failed' ? 5 : session.activity === 'working' ? 4 : 0;
  return activity + (session.unread ? 3 : 0) + (session.live ? 2 : 0) + (session.title ? 1 : 0);
}

function groupFor(session, nowMs, recentMs, newReplyMs) {
  if (session.activity === 'needs-you' || session.activity === 'failed') return 'needs-you';
  // A working session with a new reply stays in Working and keeps its unread mark.
  if (session.activity === 'working') return 'working';
  const last = session.updatedAt ?? session.startedAt;
  // The apps never clear their own unread marks, so only a fresh one is a new reply. An older one keeps its
  // unread dot but sits in the recent group, where the heading says how many are waiting there.
  if (session.unread) return last !== null && nowMs - last > newReplyMs ? 'recent' : 'new';
  if (session.live || session.activity === 'open') return 'open';
  if (session.activity === 'interrupted') return 'interrupted';
  if (last !== null && nowMs - last <= recentMs) return 'recent';
  return null;
}

function reasonFor(session) {
  let reason = null;
  if (session.activity === 'failed') reason = session.reason || 'Stopped with a problem';
  else if (session.activity === 'needs-you') reason = session.reason || 'Needs input';
  else if (session.activity === 'interrupted') reason = session.reason || 'Interrupted when the app closed';
  if (reason && session.confidence === 'inferred' && !/^probably\b/i.test(reason)) reason = `Probably ${lowerFirst(reason)}`;
  return reason;
}

/** What this session is changing: its own counts when the app keeps them, otherwise its own worktree's, and the piece
 *  of work its own edited files fall in. Never from conversation text, only from counts and file names. */
function workFor(own, place, kind, matched, ownArea, edits = null) {
  const folder = place && OWN_FOLDER_KINDS.has(kind) ? place : null;
  // All zeros is not a measurement: Cursor writes zeros into every header, and a folder that is gone reports zeros too.
  // Either way the other side may still know what changed, so zeros never win and never stand in for a count.
  const folderCounts = folder && (folder.added || folder.removed || folder.files) ? folder : null;
  const ownCounts = own && (own.added || own.removed || own.files) ? own : null;
  const source = ownCounts ?? folderCounts;
  const workstream = matched?.title ?? folder?.workstream ?? null;
  const area = ownCounts?.area ?? folder?.area ?? ownArea ?? null;
  const touchedFiles = edits?.files ?? null;
  const touchedAt = edits?.at ?? null;
  if (!source && !workstream && !area && !touchedFiles) return null;
  return {
    added: source?.added ?? null, removed: source?.removed ?? null, files: source?.files ?? null,
    // 'session' means this line is about this session alone: its own counts, or the piece of work its own files are in.
    area, scope: ownCounts || matched ? 'session' : 'folder',
    workstream, workstreamState: workstream ? READINESS_WORDS[matched ? matched.readiness : folder?.readiness] ?? null : null,
    // True when the piece of work was matched by the hashed file names rather than by paths the session itself named.
    workstreamInferred: Boolean(workstream && edits?.inferred),
    // How many distinct files this session has backed up and when it last did, wherever it wrote them, so this is
    // never a count of work in this folder. Counts, never names.
    touchedFiles, touchedAt: touchedAt === null ? null : iso(touchedAt),
  };
}

/** Which folder a session is in, said the short way: the piece of work it is on beats the folder it sits in. */
function spotFor(record) {
  if (record.placeKind === 'main') return 'main folder';
  if (record.session.branch) return clean(record.session.branch, 80);
  const real = record.folder?.real;
  return real ? clean(path.basename(real), 80) : clean(record.placeLabel, 80) || null;
}
/** The line a row leads with: the project and the piece of work, so a row says where it is rather than what a machine
 *  called it. When several sessions really are on the same piece of work, `extra` says which one this row is. */
function headlineFor(record, workstream, project, extra = null) {
  const spot = workstream || spotFor(record);
  // The differentiator only ever follows a shared piece of work; without one the spot already says where the row is.
  const tail = [spot, workstream && extra ? extra : null].filter(Boolean);
  const name = clean(project, 80);
  if (!name) return cut(tail.join(' · ') || 'Somewhere else', LIMITS.headlineChars);
  return cut([name, ...tail.filter(part => part !== name)].join(' · '), LIMITS.headlineChars);
}

/** Rows that landed on the same piece of work in the same project: each one adds where it is working, or how much it
 *  has touched, so no two of them read the same. A fact only says which row this is when no other row carries it too,
 *  and a list with nothing to tell its rows apart says nothing rather than a number that implies a difference.
 *  Nothing is invented, and the app's own title stays beneath. */
function differentiate(records) {
  // One meaning of 'N files' per list: how much each session has backed up when every row knows that, otherwise what
  // each row's own diff holds when every row knows that. The two count different things and never share a list.
  const backed = records.every(record => record.work?.touchedFiles);
  const counts = backed ? records.map(record => record.work.touchedFiles)
    : records.every(record => record.work?.files) ? records.map(record => record.work.files) : null;
  // What a session backed up is everything it has written, wherever it wrote it, so that count says 'in all' and a
  // headline never reads as that many files in this project.
  const countWords = n => (backed ? `${plural(n, 'file')} in all` : plural(n, 'file'));
  const facts = records.map((record, at) => [spotFor(record), counts ? countWords(counts[at]) : null]);
  const seen = new Map();
  for (const list of facts) for (const fact of list) if (fact) seen.set(fact, (seen.get(fact) || 0) + 1);
  records.forEach((record, at) => { record.headlineExtra = facts[at].find(fact => fact && seen.get(fact) === 1) ?? null; });
}

/** The piece of work as a row says it: a hashed match is a guess, and says so in the word the rest of the panel uses. */
const streamWords = work => (!work?.workstream ? null : work.workstreamInferred ? `Probably ${work.workstream}` : work.workstream);
// In a headline the hedge trails the name, so the row reads "Harbor · Detection engine (probably)" instead of "Harbor · Probably Detection engine".
const streamHeadline = work => (!work?.workstream ? null : work.workstreamInferred ? `${work.workstream} (probably)` : work.workstream);

/** One short line about the work: '+340 −20 in 12 files · mostly src/engine'. Empty when nothing is known.
 *  `touched` is how much this session has written, which stands in when nothing else about the work is known. It
 *  never follows a named piece of work, because after that separator a count reads as that piece of work's own. */
function workTextFor(work, touched = '') {
  if (!work) return touched ? cut(touched, WORK_TEXT_CHARS) : '';
  const { added, removed, files } = work;
  const lines = added === null && removed === null ? '' : `+${added ?? 0} −${removed ?? 0}`;
  const fileWords = files ? plural(files, 'file') : '';
  // Zero lines in zero files is a folder nobody has changed yet, which is not worth a line of its own.
  const counts = added || removed ? (fileWords ? `${lines} in ${fileWords}` : lines) : fileWords;
  const name = streamWords(work);
  const stream = name ? (work.workstreamState ? `${name} (${work.workstreamState})` : name) : '';
  const lead = stream || counts || touched;
  if (!lead) return '';
  const area = work.area ? `mostly ${work.area}` : '';
  const tail = stream ? counts : lead === counts ? area || touched : area;
  const both = tail ? `${lead} · ${tail}` : lead;
  return cut(both.length <= WORK_TEXT_CHARS ? both : lead, WORK_TEXT_CHARS).trim();
}

/** The words a row shows, plus the moment its time is measured from. */
function wordsFor(session, group, nowMs) {
  const since = session.activitySince ?? session.updatedAt ?? session.startedAt;
  const last = session.updatedAt ?? session.startedAt;
  const reason = reasonFor(session);
  if (group === 'needs-you') {
    if (session.activity === 'failed') return { reason, stateText: reason, sinceAt: since, sinceText: since === null ? null : agoText(since, nowMs) };
    const span = since === null ? null : forText(since, nowMs);
    return { reason, stateText: span ? `${reason} · ${span}` : reason, sinceAt: since, sinceText: span };
  }
  if (group === 'working') {
    const span = since === null ? null : forText(since, nowMs);
    return { reason: null, stateText: span ? `Working · ${span === 'just now' ? 'just started' : span}` : 'Working', sinceAt: since, sinceText: span };
  }
  if (group === 'new') {
    const ago = last === null ? null : agoText(last, nowMs);
    return { reason: null, stateText: ago ? `New reply · ${ago}` : 'New reply', sinceAt: last, sinceText: ago };
  }
  if (group === 'open') return { reason: null, stateText: 'Open, your move', sinceAt: last, sinceText: last === null ? null : agoText(last, nowMs) };
  if (group === 'interrupted') return { reason, stateText: reason, sinceAt: since, sinceText: since === null ? null : agoText(since, nowMs) };
  const ago = last === null ? null : agoText(last, nowMs);
  return { reason: null, stateText: ago ? `Last active ${ago}` : 'Active recently', sinceAt: last, sinceText: ago };
}

function sortGroup(id, sessions) {
  const since = record => record.session.activitySince ?? record.session.updatedAt ?? record.session.startedAt ?? Infinity;
  const updated = record => record.session.updatedAt ?? record.session.startedAt ?? -Infinity;
  const byKey = (a, b) => a.key.localeCompare(b.key);
  const oldestFirst = (a, b) => since(a) - since(b) || byKey(a, b);
  const newestFirst = (a, b) => updated(b) - updated(a) || byKey(a, b);
  return sessions.sort(id === 'needs-you' || id === 'working' ? oldestFirst : newestFirst);
}

function recentTitle(records, hours, nowMs) {
  const today = startOfDay(nowMs);
  const at = record => record.session.updatedAt ?? record.session.startedAt ?? nowMs;
  // Older unread replies are kept here too, so the count says how many of these rows are still unread.
  // The row count lives in the panel's own pill, which follows the app filter; only the unread share is added here.
  const unread = records.filter(record => record.session.unread).length;
  const tail = unread ? ` (${unread} unread)` : '';
  // Those older rows sit outside the window, so naming the window in the heading would be wrong.
  if (records.some(record => nowMs - at(record) > hours * HOUR)) return `Earlier${tail}`;
  if (records.every(record => at(record) >= today)) return `Earlier today${tail}`;
  if (hours % 24 === 0) return `${hours === 24 ? 'Last 24 hours' : `Last ${hours / 24} days`}${tail}`;
  return `${hours === 1 ? 'Last hour' : `Last ${plural(hours, 'hour')}`}${tail}`;
}

/** Only allowlisted link shapes, built here from a strictly checked id. The window never supplies a link. */
function targetFor(session, folder) {
  const { app, surface, id } = session;
  const showFolder = () => folder.exists && folder.real ? { kind: 'folder', path: folder.real, hint: 'Show folder' } : null;
  if (app === 'claude' && surface === 'desktop') return CLAUDE_LOCAL.test(id) ? { kind: 'url', url: `claude://claude.ai/epitaxy/${id}`, appName: 'Claude', hint: 'Open in Claude' } : null;
  if (app === 'codex') return UUID.test(id) ? { kind: 'url', url: `codex://threads/${id}`, appName: 'ChatGPT', appNames: ['ChatGPT', 'Codex'], hint: 'Open in Codex' } : null;
  if (app === 'cursor' && surface === 'ide') {
    const ok = UUID.test(id) || (id.startsWith('bc-') && UUID.test(id.slice(3)));
    return ok ? { kind: 'url', url: `cursor://anysphere.cursor-deeplink/agent?id=${encodeURIComponent(id)}`, appName: 'Cursor', hint: 'Open in Cursor' } : null;
  }
  if (app === 'hermes') return HERMES_ID.test(id) ? { kind: 'url', url: `hermes://open/${id}`, appName: 'Hermes', hint: 'Open in Hermes' } : null;
  if (app === 'claude' && (surface === 'terminal' || surface === 'cli')) {
    // A terminal cannot be focused from here. While it runs, show its folder; afterwards, offer the resume command.
    if (session.live) return showFolder();
    if (!UUID.test(id)) return null;
    const cwd = session.cwd && !sealedPath(session.cwd) ? session.cwd : null;
    return { kind: 'copy', text: cwd ? `cd ${shellQuote(cwd)} && claude --resume ${id}` : `claude --resume ${id}`, hint: 'Copy resume command' };
  }
  return showFolder();
}

function placeText(entry) {
  const name = app => APP_NAMES[app] || 'An agent';
  if (entry.needsYou) return entry.needsYou === 1 ? `${name(entry.needsApps[0])} needs you here` : `${entry.needsYou} agents need you here`;
  if (entry.working) return entry.working === 1 ? `${name(entry.workingApps[0])} working here` : `${entry.working} agents working here`;
  if (entry.newReplies) return entry.newReplies === 1 ? `New reply from ${name(entry.newApps[0])} here` : `${entry.newReplies} new replies here`;
  return entry.open === 1 ? `${name(entry.openApps[0])} open here` : `${entry.open} agents open here`;
}

async function pool(items, size, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const index = next++; await fn(items[index], index); }
  }));
}

/** Agent sessions: read-only metadata about Claude, Codex, Cursor and Hermes sessions. Never reads conversation content, never writes to those apps. */
export async function createAgentSessions({
  dataDir, homeDir = os.homedir(), run, now = () => Date.now(), getPlaces = async () => [], getProjects = async () => [],
  readers, privatePathsFor = () => [], listProcesses, snapshots, readLocalStorageKeys, limits = {},
} = {}) {
  if (!absolute(dataDir)) throw new Error('Agent sessions need a full data folder path.');
  const limit = { ...LIMITS, ...limits };
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  dataDir = await fs.realpath(dataDir);
  // Hook events: what sessions report about themselves (see hook-events.mjs). Without the ledger everything else still reads.
  let hooks = null;
  let hooksProblem = null;
  try { hooks = await createHookLedger({ dataDir, now }); } catch (error) { hooksProblem = clean(`Hook events could not be read. ${error?.message || ''}`, 300); }
  const homes = [...new Set([homeDir, await fs.realpath(homeDir).catch(() => homeDir)].filter(absolute))];
  const filename = path.join(dataDir, 'agent-sessions.json');
  let state = { version: VERSION, settings: clone(DEFAULT_SETTINGS) };
  let fileSignature = null;
  let problems = [];
  let queue = Promise.resolve();
  let cache = null;
  // The last process list that was read; one slow or failed `ps` reuses it instead of reading as "everything is closed".
  let lastProcesses = null;
  let collecting = null;
  // Each read gets a number; a pass that started after a read was asked for answers it. Settings changes start a new generation.
  let requests = 0;
  let generation = 0;
  let lastTargets = new Map();
  let lastTraceTargets = new Map();
  let closing = false;
  let infra = null;
  let ownSnapshots = null;
  const pathCache = new Map();
  // The hashed file names of each folder's pieces of work. Hashing a folder's whole file list is the only costly part
  // of matching and the part that almost never changes, so the answer is kept until that folder's own lists change.
  const streamHashes = new Map();
  // Within one scan the same folder is asked about once per session in it. The list of pieces of work is rebuilt by
  // every scan, so its identity is the scan's own key and the entry goes with it.
  const scanHashes = new WeakMap();
  // One in-flight fs.realpath per path, so a path on a dead mount parks one thread rather than one per refresh.
  const resolving = new Map();
  // Per app: the reader, its running call, its last result, and a result that finished after a read stopped waiting for it.
  const slots = Object.fromEntries(APPS.map(app => [app, { reader: undefined, loading: null, pending: null, last: null, abandoned: false, late: null }]));
  const enqueue = fn => { const result = queue.then(fn); queue = result.catch(() => {}); return result; };
  const problem = message => { const text = clean(message, 600); if (text && !problems.includes(text)) problems = [...problems.slice(-(limit.warnings - 1)), text]; };
  const resolveProblems = prefix => { problems = problems.filter(message => !message.startsWith(prefix)); };
  const displayPath = value => { const home = homes.find(root => inside(value, root)); return home ? `~${value.slice(home.length)}` : value; };

  async function readState() {
    let stat;
    try { stat = await fs.lstat(filename, { bigint: true }); } catch (error) {
      if (error.code === 'ENOENT') { fileSignature = null; return; }
      problem(`${SETTINGS_PROBLEM}. ${error.message}`);
      return;
    }
    if (signature(stat) === fileSignature) return;
    const before = JSON.stringify(state.settings);
    const issues = [];
    let parsed;
    let failure = null;
    try {
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > BigInt(limit.stateBytes)) throw new Error('It must be a regular file under 256 KiB.');
      parsed = JSON.parse(await fs.readFile(filename, 'utf8'));
      if (!isObject(parsed) || parsed.version !== VERSION) throw new Error('Unrecognized agent sessions schema.');
      const salvaged = salvageSettings(parsed.settings ?? {}, issues);
      if (issues.length) throw new Error(issues.slice(0, 4).join(' '));
      state = { version: VERSION, settings: salvaged };
    } catch (error) { failure = error; }
    if (!failure) {
      fileSignature = signature(stat);
      resolveProblems(SETTINGS_PROBLEM);
    } else {
      // Keep the unreadable file for recovery, keep every valid setting, and save the result so the next start is clean.
      const quarantine = `${filename}.corrupt-${Date.now()}-${randomUUID().slice(0, 6)}`;
      const kept = await fs.rename(filename, quarantine).then(() => true, () => false);
      state = { version: VERSION, settings: salvageSettings(isObject(parsed) ? parsed.settings ?? {} : {}, []) };
      fileSignature = null;
      problem(`${SETTINGS_PROBLEM}${kept ? ` (kept as ${path.basename(quarantine)})` : ''}. Valid settings were kept. ${failure.message}`);
      if (kept) await save().catch(() => { /* The save problem is shown too. */ });
    }
    if (JSON.stringify(state.settings) !== before) { cache = null; generation += 1; }
  }

  async function save() {
    const contents = `${JSON.stringify(state, null, 2)}\n`;
    const tmp = path.join(dataDir, `.agent-sessions-${randomUUID()}.tmp`);
    let handle;
    try {
      if (Buffer.byteLength(contents) > limit.stateBytes) throw new Error('Agent sessions storage limit reached. Remove some moved folders.');
      handle = await fs.open(tmp, 'wx', 0o600);
      await handle.writeFile(contents); await handle.sync(); await handle.close(); handle = null;
      await fs.rename(tmp, filename);
      const dir = await fs.open(dataDir, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
      fileSignature = signature(await fs.lstat(filename, { bigint: true }));
      resolveProblems('Could not save agent sessions settings:');
    } catch (error) {
      problem(`Could not save agent sessions settings: ${error.message}`);
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(tmp).catch(() => {});
      throw error;
    }
  }

  async function loadInfra() {
    if (infra) return infra;
    infra = (async () => {
      const out = { listProcesses, snapshots, readLocalStorageKeys, problems: [] };
      const load = async (label, fn) => { try { return await fn(); } catch (error) { out.problems.push(clean(`Could not load ${label}. ${error?.message || ''}`, 300)); return undefined; } };
      if (out.listProcesses === undefined) out.listProcesses = await load('the app check', async () => (await import('./sessions/processes.mjs')).listProcesses);
      if (out.readLocalStorageKeys === undefined) out.readLocalStorageKeys = await load('the unread reader', async () => (await import('./sessions/leveldb.mjs')).readLocalStorageKeys);
      if (out.snapshots === undefined) {
        out.snapshots = await load('the database reader', async () => (await import('./sessions/sqlite-snapshot.mjs')).createSqliteSnapshots({ run }));
        ownSnapshots = out.snapshots || null;
      }
      return out;
    })();
    return infra;
  }

  async function readerFor(app) {
    const slot = slots[app];
    if (slot.reader !== undefined) return slot.reader;
    if (readers !== undefined) {
      // Injected readers (tests): only the apps given are read.
      const given = isObject(readers) ? readers[app] : undefined;
      slot.reader = typeof given === 'function' ? { read: given } : given && typeof given.read === 'function' ? given : null;
      return slot.reader;
    }
    slot.loading ||= (async () => {
      const spec = READER_MODULES[app];
      const mod = await spec.load();
      const { problems: _problems, ...tools } = await loadInfra();
      const deps = { homeDir, run, now, ...tools };
      if (typeof mod[spec.create] === 'function') return mod[spec.create](deps);
      if (typeof mod[spec.read] === 'function') return { read: options => mod[spec.read](options) };
      throw new Error('The reader is missing.');
    })().then(reader => { slot.reader = reader; return reader; }, error => {
      slot.reader = { failed: clean(`Could not load the ${APP_NAMES[app]} reader. ${error?.message || ''}`, 300) };
      return slot.reader;
    });
    return slot.loading;
  }

  function readApp(app, options) {
    const slot = slots[app];
    if (slot.pending) return slot.pending;
    // A call that finished after the previous read stopped waiting is used once, while it is fresh.
    const waiting = slot.late;
    slot.late = null;
    if (waiting && now() - waiting.at >= 0 && now() - waiting.at < limit.lateResultMs) return Promise.resolve(waiting.result);
    const task = (async () => {
      const reader = await readerFor(app);
      if (!reader) return null;
      if (reader.failed) return { sessions: [], failed: true, sources: [{ app, label: SOURCE_LABELS[app], available: false, running: false, detail: 'Could not be checked.' }], warnings: [reader.failed] };
      try {
        const result = await reader.read(options);
        if (!isObject(result)) throw new Error('The reader returned nothing.');
        return result;
      } catch (error) {
        return { sessions: [], failed: true, sources: [{ app, label: SOURCE_LABELS[app], available: false, running: false, detail: 'Could not be checked.' }], warnings: [clean(`Could not check ${APP_NAMES[app]}. ${error?.message || ''}`, 300)] };
      }
    })().then(result => {
      // A reader that could not read its app keeps the last answer that worked, so one bad check does not empty the list.
      if (result?.failed) {
        const good = slot.last;
        if (good && now() - good.at >= 0 && now() - good.at < limit.staleResultMs) {
          result = { sessions: good.result.sessions, sources: listOf(result.sources).map(source => ({ ...source, detail: LAST_GOOD })), warnings: listOf(result.warnings) };
        }
      } else if (result) slot.last = { at: now(), result };
      if (slot.abandoned && result) slot.late = { at: now(), result };
      slot.abandoned = false;
      return result;
    }).finally(() => { if (slot.pending === task) slot.pending = null; });
    slot.pending = task;
    return task;
  }

  // A path on a mount that stopped answering blocks fs.realpath for that mount's own timeout, which no
  // caller's budget covers. After realpathMs the path answers "not there" while the call is left running,
  // so one unreachable mount cannot hold up a check or park a second thread on the next one.
  function realPathOf(value) {
    const running = resolving.get(value);
    if (running) return running;
    let timer;
    const call = fs.realpath(value);
    const answer = Promise.race([call, new Promise(resolve => { timer = setTimeout(resolve, limit.realpathMs, null); timer.unref?.(); })])
      .then(real => (typeof real === 'string' ? { real, exists: true } : { real: value, exists: false }), () => ({ real: value, exists: false }))
      .finally(() => clearTimeout(timer));
    // The entry goes once the call itself is done, so a mount that comes back is resolved again.
    call.then(() => {}, () => {}).then(() => { resolving.delete(value); });
    if (resolving.size < limit.pathCache) resolving.set(value, answer);
    return answer;
  }

  async function realInfo(value) {
    const at = now();
    const hit = pathCache.get(value);
    if (hit && at - hit.at >= 0 && at - hit.at < limit.pathTtlMs) return hit;
    const info = { at, ...(await realPathOf(value)) };
    if (pathCache.size >= limit.pathCache) pathCache.clear();
    pathCache.set(value, info);
    return info;
  }

  async function loadPlaces(warnings, seen) {
    let list = [];
    try { list = await getPlaces(); if (!Array.isArray(list)) throw new Error('The folder list is unavailable.'); seen.key = placesKeyOf(list); } catch (error) {
      warnings.push(clean(`Could not match sessions to Work in flight folders. ${error?.message || ''}`, 300));
      list = [];
    }
    const places = list.slice(0, limit.places).filter(place => isObject(place) && typeof place.id === 'string' && place.id && place.id.length <= 100 && folderPath(place.path) && !sealedPath(place.path))
      .map(place => ({ id: place.id, repoId: typeof place.repoId === 'string' ? clean(place.repoId, 200) || null : null, repoName: clean(place.repoName, 120) || null, path: folderPath(place.path), kind: typeof place.kind === 'string' ? place.kind : 'other', label: clean(place.label, 160) || null, missing: place.missing === true,
        // What Work in flight already counted for this folder, so a session in it can be described without scanning again.
        work: { added: whole(place.added), removed: whole(place.removed), files: whole(place.files), area: areaText(place.area), workstream: clean(place.workstream, 80) || null, readiness: typeof place.readiness === 'string' ? place.readiness : null },
        // The pieces of work Work in flight has grouped this folder into, with the files each one covers. Absent until
        // the folder has been grouped, and empty is a real answer: nothing here is guessed from a missing list.
        workstreams: listOf(place.workstreams).slice(0, LIMITS.workstreams)
          .filter(stream => isObject(stream) && clean(stream.title, 80))
          .map(stream => ({
            title: clean(stream.title, 80),
            readiness: typeof stream.readiness === 'string' ? stream.readiness : null,
            files: new Set(listOf(stream.files).filter(file => typeof file === 'string' && file && !file.startsWith('/')).slice(0, LIMITS.streamFiles)),
          })) }));
    await pool(places, limit.resolveConcurrency, async place => { place.real = (await realInfo(place.path)).real; });
    return places.filter(place => !sealedPath(place.real));
  }

  async function loadProjects(warnings) {
    let list = [];
    try { list = await getProjects(); if (!Array.isArray(list)) throw new Error('The workspace list is unavailable.'); } catch (error) {
      warnings.push(clean(`Could not list workspaces. ${error?.message || ''}`, 300));
      list = [];
    }
    const projects = list.slice(0, limit.projects).filter(project => isObject(project) && folderPath(project.path) && !sealedPath(project.path))
      .map(project => ({ path: folderPath(project.path), name: clean(project.name, 120) || clean(path.basename(project.path), 120) }));
    await pool(projects, limit.resolveConcurrency, async project => { project.real = (await realInfo(project.path)).real; });
    return projects.filter(project => !sealedPath(project.real));
  }

  // A folder that no longer exists may have moved into a known workspace with the same name (ignoring case, -, _ and spaces).
  async function byProjectName(value, projects) {
    const parts = value.split('/').filter(Boolean);
    for (let index = parts.length - 1; index >= 0; index--) {
      const key = nameKey(parts[index]);
      if (!key) continue;
      const project = projects.find(item => nameKey(item.name) === key || nameKey(path.basename(item.path)) === key);
      if (!project) continue;
      const rest = parts.slice(index + 1);
      if (rest.length) {
        const deeper = path.join(project.path, ...rest);
        if (!sealedPath(deeper) && (await realInfo(deeper)).exists) return deeper;
      }
      return project.path;
    }
    return null;
  }

  // Is this path already inside a folder or workspace we know? Then it did not move away.
  const covers = (value, item) => [item.real, item.path].some(candidate => candidate && inside(value, candidate));
  const known = (value, places, projects) => Boolean(value) && (places.some(place => covers(value, place)) || projects.some(item => covers(value, item)));

  async function resolveFolder(session, settings, places, projects) {
    const original = session.worktreePath || session.cwd;
    if (!original) return { lexical: null, real: null, exists: false };
    let lexical = applyAliases(original, settings.pathAliases);
    if (sealedPath(lexical)) return { drop: true };
    let info = await realInfo(lexical);
    // The name guess is for a folder whose old home is gone; a subfolder that vanished from a
    // folder we still know stays where it was, so it keeps that folder's worktree.
    if (!info.exists && !known(lexical, places, projects)) {
      const moved = await byProjectName(lexical, projects);
      if (moved) { lexical = moved; info = await realInfo(moved); }
    }
    if (sealedPath(info.real)) return { drop: true };
    return { lexical, real: info.real, exists: info.exists };
  }

  // The repo's own private folders, as the prefixes classifyPath() checks against. A repo that cannot answer gives an
  // empty list, which leaves the built-in private and secret names to do the filtering on their own.
  function prefixesFor(repoPath) {
    try { return repoPath ? listOf(privatePathsFor(repoPath)).filter(item => typeof item === 'string') : []; } catch { return []; }
  }

  // The files of each piece of work in a folder, hashed the way Claude names its file-history entries, so a session
  // that named no path can still be matched to one of them. A file is hashed under each spelling of the folder it is
  // in, and private or secret files are left out before anything is hashed, so they can never produce a match.
  function hashedStreams(placeId, streams, roots, prefixes) {
    if (!placeId || !streams?.length || !roots.length) return [];
    const thisScan = scanHashes.get(streams);
    if (thisScan) return thisScan;
    const fingerprint = pathHash([placeId, ...roots, ...prefixes, ...streams.map(stream => `${stream.title}\u0000${[...stream.files].join('\n')}`)].join('\u0001'));
    const hit = streamHashes.get(placeId);
    if (hit && hit.fingerprint === fingerprint) { scanHashes.set(streams, hit.indexed); return hit.indexed; }
    let budget = limit.hashFiles;
    const indexed = [];
    // A position, never the piece of work itself: the lists are kept across scans, and a workstream object from an
    // earlier scan would still be carrying that scan's readiness long after the folder was grouped again.
    for (const [index, stream] of streams.entries()) {
      const files = [];
      for (const file of stream.files) {
        if (budget <= 0) break;
        let cls;
        try { cls = classifyPath(file, { privatePaths: prefixes }); } catch { continue; }
        if (cls.private || cls.secret) continue;
        budget--;
        files.push([...new Set(roots.map(root => pathHash(path.join(root, file))))]);
      }
      indexed.push({ index, files });
    }
    if (streamHashes.size >= limit.hashPlaces) streamHashes.clear();
    streamHashes.set(placeId, { fingerprint, indexed });
    scanHashes.set(streams, indexed);
    return indexed;
  }

  // The files a session edited, as paths inside its Work in flight folder. Secrets, the repo's own private folders and
  // anything outside that folder are dropped before the paths are used for anything at all.
  function touchedFor(record, settings, prefixes) {
    const raw = listOf(record.session.touchedPaths);
    const roots = record.placeRoots;
    if (!raw.length || !roots.length) return [];
    const out = [];
    const seen = new Set();
    for (const value of raw) {
      if (out.length >= LIMITS.touchedPaths) break;
      const full = applyAliases(value, settings.pathAliases);
      if (sealedPath(full)) continue;
      let rel = null;
      for (const root of roots) {
        if (!inside(full, root)) continue;
        const candidate = path.relative(root, full).split(path.sep).join('/');
        if (candidate && !candidate.startsWith('..')) { rel = candidate; break; }
      }
      if (!rel || seen.has(rel)) continue;
      let cls;
      try { cls = classifyPath(rel, { privatePaths: prefixes }); } catch { continue; }
      if (cls.private || cls.secret) continue;
      seen.add(rel);
      out.push(rel);
    }
    return out;
  }

  function joinPlace(folder, places, projects) {
    const out = { placeId: null, repoId: null, project: null, placeLabel: null, repoPath: null, placeKind: null, placeWork: null, placeRoots: [], placeStreams: [] };
    if (!folder.real) return out;
    let best = null;
    let bestLength = -1;
    for (const place of places) {
      for (const candidate of [place.real, place.path]) {
        if (candidate && candidate.length > bestLength && (inside(folder.real, candidate) || inside(folder.lexical, candidate))) { best = place; bestLength = candidate.length; }
      }
    }
    let project = null;
    let projectLength = -1;
    for (const item of projects) {
      for (const candidate of [item.real, item.path]) {
        if (candidate && candidate.length > projectLength && (inside(folder.real, candidate) || inside(folder.lexical, candidate))) { project = item; projectLength = candidate.length; }
      }
    }
    if (best) {
      const main = places.find(place => place.repoId && place.repoId === best.repoId && place.kind === 'main');
      return { placeId: best.id, repoId: best.repoId, project: best.repoName || project?.name || null, placeLabel: best.label, repoPath: main?.real || project?.real || best.real, placeKind: best.kind, placeWork: best.work,
        placeRoots: [best.real, best.path].filter(Boolean), placeStreams: best.workstreams };
    }
    if (project) return { ...out, project: project.name, repoPath: project.real };
    return { ...out, project: clean(path.basename(folder.real), 120) || null };
  }

  async function collect() {
    if (collecting) return collecting;
    const ticket = requests;
    const gen = generation;
    const task = (async () => {
      const settings = clone(state.settings);
      const warnings = [];
      let timer;
      const late = Symbol('late');
      const deadline = new Promise(resolve => { timer = setTimeout(resolve, limit.budgetMs, late); });
      try {
        // Injected readers (tests) get only the injected tools; nothing else is loaded.
        const tools = readers !== undefined ? { listProcesses, snapshots, readLocalStorageKeys, problems: [] } : await loadInfra();
        warnings.push(...tools.problems);
        // null = unknown; an empty Map would read to every reader as "nothing is running".
        let processes = null;
        if (typeof tools.listProcesses === 'function') {
          // The app check only decides which sessions are live, so it gets a slice of the budget:
          // a slow `ps` costs that, never the readers' whole time, which would leave the board empty.
          let psTimer;
          const psMs = Math.max(1, Math.min(limit.processesMs, Math.floor(limit.budgetMs / 4)));
          const psLate = new Promise(resolve => { psTimer = setTimeout(resolve, psMs, null); });
          try {
            const found = await Promise.race([Promise.resolve().then(() => tools.listProcesses({ run })).catch(() => null), psLate]);
            if (found instanceof Map) { processes = found; lastProcesses = { at: now(), map: found }; }
            // One slow or failed ps must not turn every running app into a closed one.
            else if (lastProcesses && now() - lastProcesses.at >= 0 && now() - lastProcesses.at < limit.processesTtlMs) processes = lastProcesses.map;
            else warnings.push('Summon could not check which apps are running.');
          } finally { clearTimeout(psTimer); }
        }
        const options = { homeDir, now, run, processes, snapshots: tools.snapshots, readLocalStorageKeys: tools.readLocalStorageKeys, recentMs: settings.recentHours * HOUR };
        const outcomes = await Promise.all(APPS.map(async app => {
          // What this app's sessions reported about themselves through hooks; an empty map when none did.
          const result = await Promise.race([readApp(app, hooks ? { ...options, hookStates: hooks.forApp(app) } : options), deadline]);
          if (result !== late) {
            // This read saw the result in time, so it is not kept for the next one.
            if (slots[app].late?.result === result) slots[app].late = null;
            return { app, late: false, result };
          }
          if (slots[app].pending) slots[app].abandoned = true;
          return { app, late: true, result: slots[app].last?.result ?? null };
        }));
        const seen = { key: null };
        const [places, projects] = await Promise.all([loadPlaces(warnings, seen), loadProjects(warnings)]);
        const snapshot = await assemble({ outcomes, settings, places, projects, warnings });
        snapshot.ticket = ticket;
        snapshot.gen = gen;
        snapshot.placesKey = seen.key;
        if (gen === generation) cache = snapshot;
        return snapshot;
      } finally { clearTimeout(timer); }
    })();
    collecting = task;
    try { return await task; } finally { if (collecting === task) collecting = null; }
  }

  async function assemble({ outcomes, settings, places, projects, warnings }) {
    const nowMs = now();
    const recentMs = settings.recentHours * HOUR;
    // How fresh an unread mark has to be to count as a new reply; the apps never clear their own.
    const newReplyMs = (settings.newReplyHours ?? DEFAULT_SETTINGS.newReplyHours) * HOUR;
    const sources = [];
    const byKey = new Map();
    let partial = false;
    for (const { app, late, result } of outcomes) {
      if (late) partial = true;
      if (!result && !late) continue;
      const reported = listOf(result?.sources).filter(isObject).slice(0, 4).map(source => ({
        app, label: clean(source.label, 60) || SOURCE_LABELS[app], available: source.available === true, running: source.running === true, detail: clean(source.detail, 200) || null,
      }));
      if (!reported.length) reported.push({ app, label: SOURCE_LABELS[app], available: Boolean(result), running: false, detail: null });
      for (const source of reported) {
        if (late) source.detail = STILL_CHECKING;
        if (!sources.some(item => item.label === source.label)) sources.push(source);
      }
      if (!late) for (const item of listOf(result?.warnings)) { const text = clean(item, 300); if (text) warnings.push(text); }
      const sessions = listOf(result?.sessions).map(item => sanitizeSession(item, app)).filter(Boolean).slice(0, limit.perApp);
      for (const session of sessions) {
        if (session.archived && !session.live) continue;
        // Hard guard: a session in a sealed folder is dropped before any folder is checked.
        if (sealedPath(session.cwd) || sealedPath(session.worktreePath)) continue;
        const key = `${session.app}:${session.surface}:${session.id}`;
        const existing = byKey.get(key);
        if (!existing || informative(session) > informative(existing) || (informative(session) === informative(existing) && (session.updatedAt ?? 0) > (existing.updatedAt ?? 0))) byKey.set(key, session);
      }
    }
    const records = [];
    // A background run the list is not showing still counts for the menu bar. It is checked with the rest, so one in a
    // private folder is dropped the same way, and then left out of the groups below.
    const hidden = [];
    for (const [key, session] of byKey) {
      const group = groupFor(session, nowMs, recentMs, newReplyMs);
      if (!group) continue;
      if (session.surface === 'background' && !settings.showBackground && group !== 'needs-you') {
        if (group === 'working') hidden.push({ key, session, group });
        continue;
      }
      records.push({ key, session, group });
    }
    await pool([...records, ...hidden], limit.resolveConcurrency, async record => {
      record.folder = await resolveFolder(record.session, settings, places, projects);
    });
    const kept = records.filter(record => !record.folder.drop);
    const childPrivacy = new Map();
    // One bounded shared scope check per child, even when a nested child appears under several ancestors.
    const scopedChildren = [...new Map(kept.flatMap(record => record.session.children.map(child => [child.key, child]))).values()].slice(0, 200);
    await pool(scopedChildren, limit.resolveConcurrency, async child => {
      const original = child.worktreePath || child.cwd;
      if (!original) { childPrivacy.set(child.key, null); return; }
      const lexical = applyAliases(original, settings.pathAliases);
      if (sealedPath(lexical)) { childPrivacy.set(child.key, { hidden: true }); return; }
      const folder = { lexical, ...(await realInfo(lexical)) };
      if (sealedPath(folder.real)) { childPrivacy.set(child.key, { hidden: true }); return; }
      childPrivacy.set(child.key, maskingFor({ folder, ...joinPlace(folder, places, projects) }));
    });
    for (const record of kept) {
      Object.assign(record, joinPlace(record.folder, places, projects));
      record.childPrivacy = childPrivacy;
      const prefixes = prefixesFor(record.repoPath);
      const touched = touchedFor(record, settings, prefixes);
      const matched = streamFor(touched, record.placeStreams);
      // Paths the session named itself come first, because they are exact. The hashed names are the second source:
      // they answer for the sessions that named no path at all, which is most of them, and what they find is inferred.
      const guessed = matched ? null : streamByHashes(record.session.touchedHashes, hashedStreams(record.placeId, record.placeStreams, record.placeRoots, prefixes), record.placeStreams);
      record.work = workFor(record.session.work, record.placeWork, record.placeKind, matched ?? guessed, matched || guessed ? null : areaFromPaths(touched),
        { files: record.session.touchedFiles, at: record.session.touchedAt, inferred: Boolean(guessed) });
      record.touchedText = touchedTextFor(record.session, nowMs);
      record.target = targetFor(record.session, record.folder);
      record.words = wordsFor(record.session, record.group, nowMs);
    }
    // Sessions in one project that landed on the same piece of work keep that piece of work and say which is which.
    const sharing = new Map();
    for (const record of kept) {
      const stream = record.work?.workstream;
      if (!stream) continue;
      const key = `${record.project ?? ''}\u0000${stream}`;
      const list = sharing.get(key);
      if (list) list.push(record); else sharing.set(key, [record]);
    }
    for (const list of sharing.values()) if (list.length > 1) differentiate(list);
    const groups = GROUP_ORDER.map(id => {
      const members = sortGroup(id, kept.filter(record => record.group === id));
      return { id, title: id === 'recent' ? recentTitle(members, settings.recentHours, nowMs) : GROUP_TITLES[id], records: members };
    }).filter(group => group.records.length);
    const byPlace = {};
    for (const record of kept) {
      if (!record.placeId || !PLACE_GROUPS.has(record.group)) continue;
      const entry = byPlace[record.placeId] ||= { working: 0, needsYou: 0, newReplies: 0, open: 0, apps: [], needsApps: [], workingApps: [], newApps: [], openApps: [] };
      const app = record.session.app;
      if (record.group === 'needs-you') { entry.needsYou += 1; entry.needsApps.push(app); }
      else if (record.group === 'working') { entry.working += 1; entry.workingApps.push(app); }
      else if (record.group === 'new') { entry.newReplies += 1; entry.newApps.push(app); }
      else { entry.open += 1; entry.openApps.push(app); }
      if (!entry.apps.includes(app)) entry.apps.push(app);
    }
    const placeSummary = {};
    for (const [id, entry] of Object.entries(byPlace)) {
      placeSummary[id] = { working: entry.working, needsYou: entry.needsYou, newReplies: entry.newReplies, open: entry.open, apps: APPS.filter(app => entry.apps.includes(app)), text: placeText(entry) };
    }
    const size = id => groups.find(group => group.id === id)?.records.length || 0;
    sources.sort((a, b) => APPS.indexOf(a.app) - APPS.indexOf(b.app));
    return {
      at: nowMs, partial, settings, groups, sources, byPlace: placeSummary, warnings,
      hiddenWorking: hidden.filter(record => !record.folder.drop).length,
      totals: { needsYou: size('needs-you'), newReplies: size('new'), working: size('working'), open: size('open') },
      targets: new Map(kept.map(record => [record.key, record.target])),
      traceTargets: new Map(kept.map(record => [record.key, { app: record.session.app, id: record.session.hookSessionId }])),
    };
  }

  function publicSession(record, group, forAgent, includeContext) {
    const { session, words, target } = record;
    const masking = forAgent || includeContext ? maskingFor(record) : null;
    let title = session.title;
    let fallback = false;
    if (forAgent) title = agentTitle(record, masking);
    if (forAgent && title === HIDDEN_TITLE) fallback = true;
    else if (!title) { title = `Untitled ${APP_NAMES[session.app]} session`; fallback = true; }
    const work = forAgent ? agentWork(record, masking) : record.work;
    // The row leads with where the session is, not with the app's own title: a machine title can be swapped between
    // two sessions, a project and a piece of work cannot. A private folder says neither.
    const headline = forAgent && masking.hidden ? HIDDEN_HEADLINE : headlineFor(record, streamHeadline(work), record.project, record.headlineExtra);
    const visibleChildKeys = new Set(session.children.filter(child => record.childPrivacy.has(child.key)
      && !record.childPrivacy.get(child.key)?.hidden).map(child => child.key));
    const children = sessionChildren(session.children.filter(child => visibleChildKeys.has(child.key)), session.app, record.key)
      .map(({ cwd, worktreePath, ...child }) => {
        const ownPrivacy = record.childPrivacy.get(child.key);
        const label = ownPrivacy ? ownPrivacy.mask(child.label, LIMITS.titleChars)
          : masking ? masking.mask(child.label, LIMITS.titleChars) : clean(redact(child.label), LIMITS.titleChars);
        return { ...child, label: label || 'Helper' };
      });
    return {
      key: record.key, app: session.app, surface: session.surface, appLabel: appLabel(session.app, session.surface), title, titleIsFallback: fallback,
      headline, titleIsAuto: session.titleSource !== 'user',
      // Internal reasoning opts in; ordinary UI, CLI and MCP reads retain their metadata-only contract.
      // Excerpts are always masked, including local reads, so no later consumer can bypass this boundary.
      ...(includeContext ? { recentContext: masking.hidden ? null : recentContext(session.recentContext?.messages.map(item => ({ ...item, text: masking.mask(item.text, CONTEXT_CHARS) }))) } : {}),
      project: record.project, placeId: record.placeId, repoId: record.repoId, placeLabel: record.placeLabel,
      folder: forAgent || !record.folder.real ? null : displayPath(record.folder.real), branch: session.branch,
      group, activity: session.activity, reason: words.reason, stateText: words.stateText, sinceText: words.sinceText,
      sinceAt: words.sinceAt === null ? null : iso(words.sinceAt), updatedAt: session.updatedAt === null ? null : iso(session.updatedAt),
      unread: session.unread, pinned: session.pinned, live: session.live, confidence: session.confidence, helpers: session.helpers,
      ...(session.helpers > 0 ? { helpersInferred: session.helpersInferred } : {}),
      ...(children.length && !(forAgent && masking.hidden) ? { children } : {}),
      startedFrom: session.origin,
      // A session in a private folder says nothing about its work to an agent, counts included.
      work: work ? { ...work } : null, workText: workTextFor(work, forAgent && masking.hidden ? '' : record.touchedText),
      openable: target ? target.kind === 'url' ? 'link' : target.kind : 'none', openHint: target ? target.hint : 'Cannot be opened from Summon',
    };
  }

  // What an agent-facing read may say about one session: private folders hide the row's words, and secrets and
  // private path references are masked out of the rest.
  function maskingFor(record) {
    const repoPath = record.repoPath;
    const prefixes = prefixesFor(repoPath);
    const real = record.folder.real;
    let hidden = false;
    if (repoPath && real && real !== repoPath && inside(real, repoPath)) {
      try {
        const cls = classifyPath(path.relative(repoPath, real).split(path.sep).join('/'), { privatePaths: prefixes });
        hidden = Boolean(cls.private || cls.secret);
      } catch { hidden = true; }
    }
    const names = [record.project, repoPath && path.basename(repoPath), real && path.basename(real)].filter(Boolean);
    const mask = (value, max) => { try { return clean(hidePrivateText(redact(value), prefixes, names), max) || null; } catch { return null; } };
    return { hidden, mask };
  }

  // Agent-facing titles: secrets and private path references are masked, and sessions in a private folder show no title.
  function agentTitle(record, masking) {
    const { hidden, mask } = masking ?? maskingFor(record);
    if (hidden) return HIDDEN_TITLE;
    if (!record.session.title) return null;
    return mask(record.session.title, LIMITS.titleChars);
  }

  // Counts travel to agents as they are; the folder and workstream words go through the same mask as titles.
  function agentWork(record, masking) {
    const work = record.work;
    if (!work) return null;
    const { hidden, mask } = masking ?? maskingFor(record);
    if (hidden) return null;
    const workstream = work.workstream === null ? null : mask(work.workstream, 80);
    return { ...work, area: work.area === null ? null : mask(work.area, 80), workstream, workstreamState: workstream ? work.workstreamState : null };
  }

  function viewFor(snapshot, forAgent, { app = null, includeRecent = false, includeContext = false } = {}) {
    let groups = snapshot.groups;
    let totals = { ...snapshot.totals };
    let sources = snapshot.sources;
    // One app: its sessions, sources and totals only (before the agent cap, so totals stay whole).
    if (app) {
      groups = groups.map(group => ({ ...group, records: group.records.filter(record => record.session.app === app) })).filter(group => group.records.length);
      const size = id => groups.find(group => group.id === id)?.records.length || 0;
      totals = { needsYou: size('needs-you'), newReplies: size('new'), working: size('working'), open: size('open') };
      sources = sources.filter(source => source.app === app);
    }
    if (forAgent) {
      const active = groups.filter(group => group.id !== 'recent');
      if (active.length && !includeRecent) groups = active;
    }
    // Counted after the recent group is left out, so the note below only reports the agent cap.
    const total = groups.reduce((sum, group) => sum + group.records.length, 0);
    if (forAgent) {
      let left = limit.agentSessions;
      groups = groups.map(group => { const records = group.records.slice(0, Math.max(0, left)); left -= records.length; return { ...group, records }; }).filter(group => group.records.length);
    }
    const shown = groups.reduce((sum, group) => sum + group.records.length, 0);
    // Agent-facing messages never carry the home folder path.
    const text = value => forAgent ? clean(redact(homes.reduce((out, home) => out.split(home).join('~'), String(value))), 300) : value;
    const warnings = [...new Set([...problems, ...snapshot.warnings].map(text).filter(Boolean))].slice(0, limit.warnings);
    if (forAgent && shown < total) warnings.push(`Showing ${shown} of ${total} sessions.`);
    const settings = clone(snapshot.settings);
    if (forAgent) settings.pathAliases = Object.fromEntries(Object.entries(settings.pathAliases).map(([from, to]) => [displayPath(from), displayPath(to)]));
    // What the menu bar reads. New replies are left out on purpose: the apps never clear their own unread marks, so
    // counting them would light the menu bar up and keep it lit.
    const backgroundWorking = app ? 0 : snapshot.hiddenWorking;
    const summary = { needsYou: totals.needsYou, working: totals.working, backgroundWorking, text: sessionSummaryText(totals) };
    return {
      version: VERSION, checkedAt: iso(snapshot.at), totals, summary,
      groups: groups.map(group => ({ id: group.id, title: group.title, sessions: group.records.map(record => publicSession(record, group.id, forAgent, includeContext)) })),
      sources: sources.map(source => ({ ...source, label: text(source.label), detail: source.detail === null ? null : text(source.detail) })),
      byPlace: clone(snapshot.byPlace), settings, warnings,
    };
  }

  // maxAgeMs: Infinity answers from the last check whenever there is one (main uses it while no window shows the data).
  // app and includeRecent narrow the view; includeRecent keeps the recent group in agent-facing reads.
  async function read({ maxAgeMs = 3000, forAgent = false, app = null, includeRecent = false, includeContext = false } = {}) {
    if (typeof maxAgeMs !== 'number' || !(maxAgeMs >= 0)) throw new Error('maxAgeMs must be zero or more.');
    if (typeof forAgent !== 'boolean') throw new Error('forAgent must be true or false.');
    if (app !== null && !APPS.includes(app)) throw new Error('app must be claude, codex, cursor or hermes.');
    if (typeof includeRecent !== 'boolean') throw new Error('includeRecent must be true or false.');
    if (typeof includeContext !== 'boolean') throw new Error('includeContext must be true or false.');
    if (closing) throw new Error('Summon is closing. Try again after it restarts.');
    const ticket = ++requests;
    await enqueue(readState);
    // Settings changes queue behind readState, so this is the generation the answer has to be built with.
    const wanted = generation;
    let snapshot;
    if (collecting) {
      snapshot = await collecting;
      // A check that started before a settings change answers with the old settings, so ask again.
      // Compared against `wanted`, not the live generation: a later check has gen >= wanted, so one retry is enough.
      if (snapshot.gen < wanted) snapshot = await collect();
    } else {
      const age = cache ? now() - cache.at : Infinity;
      // A new Work in flight scan (different folders) makes a young view stale, so folder chips appear right away.
      let samePlaces = true;
      if (cache && cache.placesKey !== null && maxAgeMs !== Infinity) {
        try { samePlaces = placesKeyOf(await getPlaces()) === cache.placesKey; } catch { samePlaces = true; }
      }
      // A partial view is only reused by reads that were waiting for that same pass.
      const fresh = cache && (cache.ticket >= ticket || maxAgeMs === Infinity || (!cache.partial && samePlaces && age >= 0 && age < maxAgeMs));
      snapshot = fresh ? cache : await collect();
    }
    lastTargets = snapshot.targets;
    lastTraceTargets = snapshot.traceTargets;
    return viewFor(snapshot, forAgent, { app, includeRecent, includeContext });
  }

  // The last check's per-folder counts, and nothing else: this never starts a check, never touches a file and never
  // waits. Work in flight calls it once per read to say an agent has been working in a folder without changing a
  // file, so it must not pull a whole session pass onto that path. Empty until something has read the sessions, and
  // empty reads as "no agent seen here", never as a guess. Nothing polls while the menu-bar count is off, the
  // window is hidden or the machine is asleep, so a check older than placeCountsMaxAgeMs is no evidence that an
  // agent is in that folder now: it falls back to the same "no agent seen here" answer.
  function placeCounts() {
    return cache && now() - cache.at <= limit.placeCountsMaxAgeMs ? clone(cache.byPlace) : {};
  }

  function openTarget(key) {
    if (typeof key !== 'string' || !key || key.length > 300 || !lastTargets.has(key)) throw new Error(GONE);
    const target = lastTargets.get(key);
    if (!target) throw new Error(CANNOT_OPEN);
    if (target.kind === 'url') return target.appNames ? { kind: 'url', url: target.url, appName: target.appName, appNames: [...target.appNames] } : { kind: 'url', url: target.url, appName: target.appName };
    if (target.kind === 'copy') return { kind: 'copy', text: target.text };
    return { kind: 'folder', path: target.path };
  }

  function trace(key) {
    if (closing) throw new Error('Summon is closing.');
    if (typeof key !== 'string' || !key || key.length > 300 || !lastTraceTargets.has(key)) throw new Error(GONE);
    if (!hooks) throw new Error(hooksProblem || 'Hook events are not available.');
    const target = lastTraceTargets.get(key);
    return { sessionKey: key, ...hooks.trace(target.app, target.id) };
  }

  async function updateSettings(patch) {
    if (closing) throw new Error('Summon is closing. No settings were changed.');
    return enqueue(async () => {
      await readState();
      const before = state.settings;
      const next = normalizeSettings(patch, before);
      state = { ...state, settings: next };
      try { await save(); } catch (error) { state = { ...state, settings: before }; throw error; }
      cache = null;
      generation += 1;
      return clone(next);
    });
  }

  // A hook event or a launch changes what the next read should say, so the cached view is dropped the same way a
  // settings change drops it. Nothing is read here; the next poll does that.
  function noteHook(event) {
    if (closing) throw new Error('Summon is closing.');
    if (!hooks) throw new Error(hooksProblem || 'Hook events are not available.');
    hooks.record(event);
    cache = null;
    generation += 1;
    return { accepted: true };
  }
  function noteLaunch(value) {
    if (closing) throw new Error('Summon is closing.');
    if (!hooks) throw new Error(hooksProblem || 'Hook events are not available.');
    const launch = hooks.noteLaunch(value);
    cache = null;
    generation += 1;
    return launch;
  }

  async function close() {
    if (closing) return;
    closing = true;
    if (hooks) await Promise.resolve().then(() => hooks.close()).catch(() => {});
    // The database reader closes first: it rejects the queries the app readers are waiting on, so they return at once
    // instead of sitting out the snapshot timeout. Waiting for them is then bounded, because nothing cancels a reader.
    if (ownSnapshots && typeof ownSnapshots.close === 'function') await Promise.resolve().then(() => ownSnapshots.close()).catch(() => {});
    const running = [collecting, ...APPS.map(app => slots[app].pending)].filter(Boolean);
    if (running.length) await Promise.race([Promise.allSettled(running), new Promise(resolve => { setTimeout(resolve, limit.closeWaitMs).unref?.(); })]);
    for (const app of APPS) {
      const reader = slots[app].reader;
      if (readers === undefined && reader && typeof reader.close === 'function') await Promise.resolve().then(() => reader.close()).catch(() => {});
    }
    await queue;
  }

  await enqueue(readState);
  return { read, openTarget, trace, placeCounts, settings: () => clone(state.settings), updateSettings, noteHook, noteLaunch, close };
}
