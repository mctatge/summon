/** Claude sessions: read-only metadata about Claude desktop app Code sessions and terminal `claude` sessions.
 * Sources: the live registry (~/.claude/sessions/<pid>.json), the app's claude-code-sessions/<acct>/<org>/local_*.json files,
 * the app's localStorage unread marks, git-worktrees.json, and the last 64 KB of terminal transcripts.
 * Which files a session edited comes from the transcript's own file-history metadata lines, paths only, and from the
 * names of the entries in that session's ~/.claude/file-history folder, which are hashes of the paths.
 * Recent evidence keeps user/assistant text only, dropping tool output and thinking blocks.
 * Never reads peer-token .key files, config.json, last-prompt lines or the file-history backup files
 * under ~/.claude/file-history/; never writes, locks or connects to anything. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { sealedPath } from '../workstreams.mjs';
import { recentContext, CONTEXT_LINE_BYTES } from './recent-context.mjs';

const DAY = 864e5;
const ORIGIN = 'https://claude.ai';
const UNREAD_KEY = 'epitaxy-unread-v1';
const DIFF_KEY = 'session-diff-stats-store';
const DIFF_ENTRIES = 5000;
const APP_LABEL = 'Claude app';
const TERMINAL_LABEL = 'Claude in Terminal';
const DEFAULT_LIMITS = {
  sessions: 300, registryFiles: 500, registryBytes: 64 * 1024, desktopFiles: 20000, prefixBytes: 1024, desktopBytes: 1024 * 1024, fullParses: 200,
  indexBytes: 1024 * 1024, worktreesBytes: 4 * 1024 * 1024, transcriptDirs: 1000, tailBytes: 64 * 1024, tailReads: 80, terminalRecentMs: DAY,
  fullScanMs: 30000, helperWindowMs: 60000, helperEntries: 400, promptWaitMs: 30000, staleWorkingMs: 10 * 60000, concurrency: 8,
  editBytes: 96 * 1024, editReads: 80, editPaths: 200, editLineBytes: 512 * 1024,
  historyDirs: 120, historyEntries: 1000, historyHashes: 400, historyWindowMs: 6 * 3600000,
};
const UNREAD_FAILED = "Claude's unread marks could not be read.";
const PROCESSES_FAILED = 'Could not check which Claude sessions are running.';
const READ_FAILED = 'Claude sessions could not be checked right now.';
const PROBLEM = 'Stopped with a problem';

const REGISTRY_FILE = /^(\d{1,10})\.json$/;
const DESKTOP_FILE = /^(local_[A-Za-z0-9-]{1,64})\.json$/;
const TOMBSTONE = /^deleted_([A-Za-z0-9-]{1,64})$/;
const LOCAL_ID = /^local_[A-Za-z0-9-]{1,64}$/;
const CLI_ID = /^[A-Za-z0-9-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRANSCRIPT = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const RELEASED = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.desktop-released\.json$/i;
const DIFF_STAT_KEY = /^(local_[A-Za-z0-9-]{1,64}):/;
const HELPER_FILE = /^agent-.{1,200}\.jsonl$/;
// A file-history entry is named after the file it backs up: the first 16 hex characters of sha256 of that file's
// absolute path, then '@v' and the version. Only the name is ever read.
const HISTORY_ENTRY = /^([0-9a-f]{16})@v\d{1,9}$/;
// Transcript lines whose type comes first and is not one of these are skipped before parsing (last-prompt, file-history, …).
const LEADING_TYPE = /^\{\s*"type"\s*:\s*"([^"]{1,64})"/;
const TAIL_TYPES = new Set(['user', 'assistant', 'system', 'custom-title', 'ai-title']);
// The two metadata lines that name a file the session edited. Nothing else on them is read, and the backup files they
// point at (under ~/.claude/file-history/) hold the file contents and are never opened.
const EDIT_TYPES = new Set(['file-history-snapshot', 'file-history-delta']);
// Names that never travel, whatever folder they sit in. The full check, which also knows the repo's own private
// folders, runs in the aggregator; this one keeps a key or a .env out of the reader's answer in the first place.
const SECRET_BASE = /^(?:\.env(?:\..*)?|\.envrc|\.netrc|\.npmrc|\.pgpass|\.pypirc|\.git-credentials|\.dev\.vars|id_rsa|id_dsa|id_ecdsa|id_ed25519)$/i;
const SECRET_EXT = /\.(?:pem|key|p12|pfx|keychain|keystore|jks|kdbx|env|tfvars|p8|ppk)$/i;
const OK_WAITS = new Set(['permission prompt', 'sandbox request', 'worker request']);
const QUESTION_WAITS = new Set(['input needed', 'dialog open', 'goal proposal']);
const PREFIX = {
  cliSessionId: /"cliSessionId"\s*:\s*"([A-Za-z0-9-]{1,64})"/,
  lastActivityAt: /"lastActivityAt"\s*:\s*(\d{1,16})\b/,
  isArchived: /"isArchived"\s*:\s*(true|false)\b/,
  cwd: /"cwd"\s*:\s*"((?:[^"\\]|\\.){1,4096})"/,
};

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
// Titles are untrusted: drop control, line-separator and bidirectional-override characters, collapse spaces, cap by code point.
const clean = (value, max) => typeof value === 'string'
  ? [...value.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s{2,}/g, ' ').trim()].slice(0, max).join('').trim()
  : '';
const title = value => clean(value, 120) || null;
const shortText = (value, max) => { const text = clean(value, max); return text || null; };
const time = value => Number.isFinite(value) && value > 0 && value < 1e14 ? Math.round(value) : null;
const whole = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const isoTime = value => typeof value === 'string' ? time(Date.parse(value)) : null;
const absPath = value => typeof value === 'string' && value.length <= 4096 && path.isAbsolute(value) && !/[\u0000-\u001f]/.test(value) ? path.normalize(value) : null;
const secretName = base => SECRET_BASE.test(base) || SECRET_EXT.test(base) || /secret|credential/i.test(base);
const cliId = value => typeof value === 'string' && CLI_ID.test(value) ? value : null;
const nowOf = now => typeof now === 'function' ? now() : Number.isFinite(now) ? now : Date.now();
const signature = stat => stat ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}` : 'none';
const isDesktopEntry = entrypoint => typeof entrypoint === 'string' && entrypoint.startsWith('claude-desktop');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

async function pool(items, size, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const index = next++; await fn(items[index], index); }
  }));
}
async function statOf(file) {
  try { return await fs.stat(file, { bigint: true }); } catch { return null; }
}
// For entries whose time is wanted but whose contents are not: a symlink is described, never followed.
async function lstatOf(file) {
  try { return await fs.lstat(file, { bigint: true }); } catch { return null; }
}
// Opens a regular file only: O_NOFOLLOW so a symlink planted under a session file name cannot aim this at config.json
// or a .key file, O_NONBLOCK so a pipe returns an fd instead of waiting for a writer. The size comes from the fd, so
// nothing can be swapped between the stat and the read. Callers already treat a throw as "skip this file".
// statOf() stays on fs.stat: it is also used on directories, and ~/.claude may legitimately be a symlink.
async function openRead(file) {
  const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw Object.assign(new Error('Not a regular file.'), { code: 'EFTYPE' });
    return { handle, stat };
  } catch (error) { await handle.close().catch(() => {}); throw error; }
}
async function readHead(file, bytes) {
  const { handle } = await openRead(file);
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}
// Whole-file read with a hard cap; null when the file is larger than the cap.
async function readCapped(file, max) {
  const { handle, stat } = await openRead(file);
  try {
    const { size } = stat;
    if (size > max) return null;
    const buffer = Buffer.alloc(Math.min(max + 1, size + 4096));
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    return total > max ? null : buffer.subarray(0, total).toString('utf8');
  } finally { await handle.close(); }
}
async function readTail(file, bytes) {
  const { handle, stat } = await openRead(file);
  try {
    const { size } = stat;
    const length = Math.min(bytes, size);
    const start = size - length;
    const buffer = Buffer.alloc(length);
    let total = 0;
    while (total < length) {
      const { bytesRead } = await handle.read(buffer, total, length - total, start + total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    return { text: buffer.subarray(0, total).toString('utf8'), truncated: start > 0 };
  } finally { await handle.close(); }
}
async function readRange(handle, start, length) {
  const buffer = Buffer.alloc(length);
  let total = 0;
  while (total < length) {
    const { bytesRead } = await handle.read(buffer, total, length - total, start + total);
    if (!bytesRead) break;
    total += bytesRead;
  }
  return buffer.subarray(0, total);
}
async function subdirs(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name).sort();
}

// Fallbacks for standalone use; the aggregator normally injects processes and the LevelDB reader.
let infraModules;
function importInfra() {
  infraModules ||= Promise.all([import('./leveldb.mjs').catch(() => null), import('./processes.mjs').catch(() => null)]);
  return infraModules;
}
function localIsAlive(processes, pid, { lstart } = {}) {
  const found = processes instanceof Map ? processes.get(pid) : null;
  if (!found) return false;
  return !lstart || String(found.lstart ?? '').trim() === String(lstart).trim();
}
async function loadInfra(options) {
  const injected = { readLocalStorageKeys: options.readLocalStorageKeys, listProcesses: options.listProcesses, isAlive: options.isAlive };
  const complete = typeof injected.readLocalStorageKeys === 'function' && typeof injected.isAlive === 'function' && (options.processes || typeof injected.listProcesses === 'function');
  const [leveldb, processes] = complete ? [null, null] : await importInfra();
  return {
    readLocalStorageKeys: typeof injected.readLocalStorageKeys === 'function' ? injected.readLocalStorageKeys : leveldb?.readLocalStorageKeys,
    listProcesses: typeof injected.listProcesses === 'function' ? injected.listProcesses : processes?.listProcesses,
    isAlive: typeof injected.isAlive === 'function' ? injected.isAlive : typeof processes?.isAlive === 'function' ? processes.isAlive : localIsAlive,
  };
}

function limitsOf(value) {
  const limits = { ...DEFAULT_LIMITS };
  if (isObject(value)) for (const [key, n] of Object.entries(value)) if (key in DEFAULT_LIMITS && Number.isFinite(n) && n >= 0) limits[key] = n;
  limits.concurrency = Math.max(1, Math.floor(limits.concurrency));
  return limits;
}
function pathsFor(home) {
  const support = path.join(home, 'Library', 'Application Support', 'Claude');
  return {
    claudeHome: path.join(home, '.claude'),
    registry: path.join(home, '.claude', 'sessions'),
    projects: path.join(home, '.claude', 'projects'),
    desktopRoot: path.join(support, 'claude-code-sessions'),
    leveldb: path.join(support, 'Local Storage', 'leveldb'),
    worktrees: path.join(support, 'git-worktrees.json'),
  };
}
function newCache(homeDir) {
  return {
    homeDir,
    registry: new Map(),
    unread: { sig: null, ids: new Set(), diffs: new Map() },
    worktrees: { sig: null, byLease: new Map() },
    desktop: { rootSig: null, accounts: new Map(), dirs: new Map() },
    transcripts: { rootSig: null, slugs: new Map(), index: new Map(), tails: new Map(), edits: new Map(), lastFull: 0 },
    history: new Map(),
    helpers: new Map(),
  };
}
const emptyStats = () => ({ registryReads: 0, prefixReads: 0, fullParses: 0, tailReads: 0, editChecks: 0, editReads: 0, historyChecks: 0, historyLists: 0, transcriptStats: 0, helperStats: 0, unreadReads: 0, ms: 0, phases: {} });

// ---- registry ----
function waitingReason(value) {
  const wait = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return OK_WAITS.has(wait) ? 'Waiting for your OK' : QUESTION_WAITS.has(wait) ? 'Asked you a question' : 'Needs input';
}
function pickRegistry(json, filePid) {
  if (!isObject(json)) return null;
  const pid = json.pid === undefined ? filePid : json.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid !== filePid) return null;
  const sessionId = cliId(json.sessionId);
  if (!sessionId) return null;
  const status = typeof json.status === 'string' ? json.status : null;
  return {
    pid, sessionId,
    cwd: absPath(json.cwd),
    startedAt: time(json.startedAt),
    procStart: typeof json.procStart === 'string' && json.procStart.trim().length <= 64 ? json.procStart.trim() : null,
    kind: typeof json.kind === 'string' ? json.kind : null,
    entrypoint: typeof json.entrypoint === 'string' ? json.entrypoint : null,
    // Only a name the person set is a title; derived names look like "harbor-49".
    name: json.nameSource === 'user' ? title(json.name) : null,
    status: ['busy', 'shell', 'waiting', 'idle'].includes(status) ? status : null,
    reason: status === 'waiting' ? waitingReason(json.waitingFor) : null,
    updatedAt: time(json.updatedAt),
    statusUpdatedAt: time(json.statusUpdatedAt),
  };
}
async function scanRegistry(cache, dir, limits, stats) {
  let names;
  try { names = await fs.readdir(dir); } catch { cache.registry.clear(); return { exists: false, entries: [] }; }
  // Only <pid>.json: never touch <pid>.<hash>.key peer-token files.
  const wanted = names.filter(name => REGISTRY_FILE.test(name)).slice(0, limits.registryFiles);
  const keep = new Set(wanted);
  for (const name of cache.registry.keys()) if (!keep.has(name)) cache.registry.delete(name);
  await pool(wanted, limits.concurrency, async name => {
    const file = path.join(dir, name);
    const stat = await statOf(file);
    if (!stat?.isFile() || Number(stat.size) > limits.registryBytes) { cache.registry.delete(name); return; }
    const sig = signature(stat);
    if (cache.registry.get(name)?.sig === sig) return;
    stats.registryReads++;
    let entry = null;
    try {
      const text = await readCapped(file, limits.registryBytes);
      if (text != null) entry = pickRegistry(JSON.parse(text), Number(REGISTRY_FILE.exec(name)[1]));
    } catch { entry = null; }
    // The file's last write bounds how late its process can have started (used when a record has no procStart).
    if (entry) entry.fileMs = time(stat.mtimeMs);
    cache.registry.set(name, { sig, entry });
  });
  return { exists: true, entries: [...cache.registry.values()].map(item => item.entry).filter(Boolean) };
}
function registryActivity(entry) {
  if (entry.status === 'busy' || entry.status === 'shell') return { activity: 'working', reason: null };
  if (entry.status === 'waiting') return { activity: 'needs-you', reason: entry.reason || 'Needs input' };
  if (entry.status === 'idle') return { activity: 'open', reason: null };
  return null;
}
const statusRank = entry => ({ waiting: 0, busy: 1, shell: 1, idle: 2 })[entry.status] ?? 3;

// ---- unread marks and worktree leases ----
// The app's own count of what a session changed, keyed 'local_<id>:owner/repo:branch'. Numbers only, never file names or text.
function parseDiffStats(raw) {
  const diffs = new Map();
  const stats = JSON.parse(String(raw))?.state?.stats;
  if (!isObject(stats)) return diffs;
  for (const [key, value] of Object.entries(stats).slice(0, DIFF_ENTRIES)) {
    const id = DIFF_STAT_KEY.exec(key)?.[1];
    if (!id || !isObject(value)) continue;
    const added = whole(value.additions), removed = whole(value.deletions), files = whole(value.fileCount);
    if (added === null && removed === null && files === null) continue;
    // A session can have a line per repository and branch; the one it touched last is the one it is working in.
    const at = time(value.updatedAt) ?? 0;
    if ((diffs.get(id)?.at ?? -1) >= at) continue;
    diffs.set(id, { at, work: { added, removed, files, area: null, scope: 'session', workstream: null, workstreamState: null } });
  }
  return diffs;
}
async function scanUnread(cache, dir, readKeys, stats) {
  const empty = { ok: false, ids: new Set(), diffs: new Map() };
  let names;
  try { names = (await fs.readdir(dir)).filter(name => /\.(log|ldb|sst)$/.test(name) || name === 'CURRENT').sort(); }
  catch { return empty; }
  const sigs = await Promise.all(names.map(async name => `${name}:${signature(await statOf(path.join(dir, name)))}`));
  const sig = sigs.join('|');
  if (cache.unread.sig === sig) return { ok: true, ids: cache.unread.ids, diffs: cache.unread.diffs };
  if (typeof readKeys !== 'function') return empty;
  let diffs = new Map();
  try {
    stats.unreadReads++;
    const values = await readKeys(dir, { origin: ORIGIN, keys: [UNREAD_KEY, DIFF_KEY] });
    const valueOf = key => values instanceof Map ? values.get(key) : isObject(values) ? values[key] : undefined;
    // Diff counts are a bonus: a store the app has not written yet, or wrote in a shape we do not know, costs nothing.
    const diffRaw = valueOf(DIFF_KEY);
    if (diffRaw != null) { try { diffs = parseDiffStats(diffRaw); } catch { diffs = new Map(); } }
    const raw = valueOf(UNREAD_KEY);
    const ids = new Set();
    if (raw != null) {
      const parsed = JSON.parse(String(raw));
      const list = parsed?.state?.unreadIds;
      if (!Array.isArray(list)) throw new Error('Unexpected unread shape.');
      for (const id of list.slice(0, 5000)) if (typeof id === 'string' && LOCAL_ID.test(id)) ids.add(id);
    }
    cache.unread = { sig, ids, diffs };
    return { ok: true, ids, diffs };
  } catch {
    cache.unread = { sig: null, ids: new Set(), diffs: new Map() };
    return { ...empty, diffs };
  }
}
async function scanWorktrees(cache, file, limits) {
  const stat = await statOf(file);
  const sig = signature(stat);
  if (cache.worktrees.sig === sig) return cache.worktrees.byLease;
  const byLease = new Map();
  if (stat?.isFile()) {
    try {
      const text = await readCapped(file, limits.worktreesBytes);
      const worktrees = text == null ? null : JSON.parse(text)?.worktrees;
      if (isObject(worktrees)) {
        for (const item of Object.values(worktrees)) {
          if (!isObject(item) || typeof item.leasedBy !== 'string' || !LOCAL_ID.test(item.leasedBy)) continue;
          const where = absPath(item.path);
          if (!where || sealedPath(where)) continue;
          byLease.set(item.leasedBy, { path: where, branch: shortText(item.branch, 200) });
        }
      }
    } catch { /* A half-written file is retried on the next change. */ }
  }
  cache.worktrees = { sig, byLease };
  return byLease;
}

// ---- desktop session files ----
function jsonString(match) {
  if (!match) return null;
  try { return JSON.parse(`"${match[1]}"`); } catch { return null; }
}
function parsePrefix(head) {
  const activity = PREFIX.lastActivityAt.exec(head);
  const archived = PREFIX.isArchived.exec(head);
  return {
    cliSessionId: PREFIX.cliSessionId.exec(head)?.[1] ?? null,
    lastActivityAt: activity ? time(Number(activity[1])) : null,
    isArchived: archived ? archived[1] === 'true' : null,
    cwd: absPath(jsonString(PREFIX.cwd.exec(head))),
  };
}
function pickDesktop(json) {
  if (!isObject(json)) return null;
  const hasError = json.error !== undefined && json.error !== null && json.error !== false && json.error !== '';
  const priors = Array.isArray(json.priorCliSessionIds) ? json.priorCliSessionIds.slice(0, 100).map(cliId).filter(Boolean) : [];
  return {
    cliSessionId: cliId(json.cliSessionId),
    title: title(json.title),
    // The app writes 'auto' or 'user', and leaves the field off older sessions; only 'user' means the person named it.
    titleSource: json.titleSource === 'user' ? 'user' : 'auto',
    cwd: absPath(json.cwd),
    originCwd: absPath(json.originCwd),
    worktreePath: absPath(json.worktreePath),
    branch: shortText(json.branch, 200),
    createdAt: time(json.createdAt),
    lastActivityAt: time(json.lastActivityAt),
    isArchived: json.isArchived === true,
    pinned: json.isStarred === true,
    // Only the fact and time of an error are kept, never its text.
    errorAt: hasError ? time(json.errorAt) : null,
    model: shortText(json.model, 80),
    priorCliSessionIds: priors,
  };
}
async function desktopDirs(cache, root, limits) {
  const state = cache.desktop;
  const rootStat = await statOf(root);
  if (!rootStat?.isDirectory()) { state.rootSig = null; state.accounts.clear(); state.dirs.clear(); return null; }
  const rootSig = signature(rootStat);
  if (state.rootSig !== rootSig) {
    const names = await subdirs(root).catch(() => []);
    const next = new Map();
    for (const name of names.slice(0, 50)) next.set(name, state.accounts.get(name) || { sig: null, orgs: [] });
    state.accounts = next;
    state.rootSig = rootSig;
  }
  const dirs = [];
  for (const [name, account] of state.accounts) {
    const accountDir = path.join(root, name);
    const sig = signature(await statOf(accountDir));
    if (account.sig !== sig) {
      account.orgs = sig === 'none' ? [] : (await subdirs(accountDir).catch(() => [])).slice(0, 50);
      account.sig = sig;
    }
    for (const org of account.orgs) dirs.push(path.join(accountDir, org));
  }
  const keep = new Set(dirs);
  for (const dir of state.dirs.keys()) if (!keep.has(dir)) state.dirs.delete(dir);
  return dirs.slice(0, 200);
}
async function scanDesktopDir(cache, dir, ctx) {
  const { limits, nowMs, stats } = ctx;
  let state = cache.desktop.dirs.get(dir);
  if (!state) { state = { sig: null, scannedAt: 0, files: new Map(), deleted: new Set(), archived: new Set(), archivedSig: null }; cache.desktop.dirs.set(dir, state); }
  const stat = await statOf(dir);
  if (!stat?.isDirectory()) { cache.desktop.dirs.delete(dir); return null; }
  const sig = signature(stat);
  // Atomic saves rename into the folder and change its signature; a periodic full pass covers in-place writes.
  const full = state.sig !== sig || nowMs - state.scannedAt >= limits.fullScanMs;
  let names;
  if (full) {
    let listing;
    try { listing = await fs.readdir(dir); } catch { cache.desktop.dirs.delete(dir); return null; }
    state.deleted = new Set();
    names = [];
    for (const name of listing) {
      const tomb = TOMBSTONE.exec(name);
      if (tomb) state.deleted.add(`local_${tomb[1]}`);
      else if (DESKTOP_FILE.test(name) && names.length < limits.desktopFiles) names.push(name);
    }
    const keep = new Set(names);
    for (const name of state.files.keys()) if (!keep.has(name)) state.files.delete(name);
    state.sig = sig;
    state.scannedAt = nowMs;
  } else {
    names = [...state.files.values()].filter(entry => entry.hot).map(entry => entry.name);
  }
  const indexFile = path.join(dir, 'archived-sessions.idx');
  const indexStat = await statOf(indexFile);
  const indexSig = signature(indexStat);
  if (state.archivedSig !== indexSig) {
    const archived = new Set();
    if (indexStat?.isFile()) {
      try {
        const list = JSON.parse(await readCapped(indexFile, limits.indexBytes) ?? 'null')?.archived;
        if (Array.isArray(list)) for (const id of list) if (typeof id === 'string' && LOCAL_ID.test(id)) archived.add(id);
      } catch { /* retried on the next change */ }
    }
    state.archived = archived;
    state.archivedSig = indexSig;
  }
  await pool(names, limits.concurrency, async name => {
    const file = path.join(dir, name);
    const fileStat = await statOf(file);
    if (!fileStat?.isFile()) { state.files.delete(name); return; }
    const fileSig = signature(fileStat);
    const known = state.files.get(name);
    if (known?.sig === fileSig) return;
    let prefix;
    try { stats.prefixReads++; prefix = parsePrefix((await readHead(file, limits.prefixBytes)).toString('utf8')); }
    catch { state.files.delete(name); return; }
    state.files.set(name, {
      name, file, id: DESKTOP_FILE.exec(name)[1], sig: fileSig, mtimeMs: Number(fileStat.mtimeMs), prefix,
      // A rewritten file keeps its old picked fields until re-parsed, so a capped pass still shows a title.
      full: known?.full ?? null, fullSig: null, hot: known?.hot ?? false,
    });
  });
  return state;
}

// ---- transcripts ----
function parseTail(text, truncated) {
  const lines = text.split('\n');
  if (truncated) lines.shift();
  const info = { entrypoint: null, cwd: null, branch: null, model: null, customTitle: null, aiTitle: null, updatedAt: null, turn: 'unknown', lastEventAt: null };
  let last = null;
  let messages = [];
  for (const line of lines) {
    if (line.charCodeAt(0) !== 123) continue;
    const leading = LEADING_TYPE.exec(line.slice(0, 80));
    if (leading && !TAIL_TYPES.has(leading[1])) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!isObject(row)) continue;
    const type = row.type;
    if (type === 'custom-title') { info.customTitle = title(row.customTitle) ?? info.customTitle; continue; }
    if (type === 'ai-title') { info.aiTitle = title(row.aiTitle) ?? info.aiTitle; continue; }
    const at = isoTime(row.timestamp);
    if (type === 'system') {
      if (row.isSidechain === true) continue;
      if (row.subtype === 'stop_hook_summary') last = { kind: 'end', at };
      else if (row.subtype === 'api_error') last = { kind: 'error', at };
      continue;
    }
    if (type !== 'user' && type !== 'assistant') continue;
    if (typeof row.entrypoint === 'string') info.entrypoint = row.entrypoint.slice(0, 64);
    info.cwd = absPath(row.cwd) ?? info.cwd;
    info.branch = shortText(row.gitBranch, 200) ?? info.branch;
    if (at) info.updatedAt = Math.max(info.updatedAt ?? 0, at);
    if (row.isSidechain === true || row.isMeta === true) continue;
    if (line.length <= CONTEXT_LINE_BYTES && !row.isCompactSummary && !row.isApiErrorMessage) {
      const context = recentContext([{ role: type, content: row.message?.content, at }]);
      if (context) messages = recentContext([...messages, ...context.messages]).messages;
    }
    if (type === 'assistant') {
      const model = row.message?.model;
      if (typeof model === 'string' && !model.startsWith('<')) info.model = shortText(model, 80);
      const stop = row.message?.stop_reason;
      if (row.isApiErrorMessage === true) last = { kind: 'error', at };
      else if (stop === 'tool_use') last = { kind: 'tool', at };
      else if (stop === 'end_turn' || stop === 'stop_sequence') last = { kind: 'end', at };
      else last = { kind: 'working', at };
    } else {
      last = { kind: 'working', at };
    }
  }
  info.recentContext = recentContext(messages);
  info.turn = { end: 'finished', error: 'failed', tool: 'tool', working: 'working' }[last?.kind] ?? 'unknown';
  info.lastEventAt = last?.at ?? null;
  info.title = info.customTitle ?? info.aiTitle ?? null;
  // A custom title is one the person typed; an ai-title is the app's own wording.
  info.titleSource = info.customTitle ? 'user' : info.aiTitle ? 'auto' : null;
  delete info.customTitle;
  delete info.aiTitle;
  return info;
}
async function scanTranscripts(cache, root, ctx, { needIds, windowMs }) {
  const { limits, nowMs, stats } = ctx;
  const state = cache.transcripts;
  const rootStat = await statOf(root);
  if (!rootStat?.isDirectory()) { state.rootSig = null; state.slugs.clear(); state.index.clear(); state.tails.clear(); state.edits.clear(); return { exists: false }; }
  const rootSig = signature(rootStat);
  if (state.rootSig !== rootSig) {
    // Sealed folders are never listed, let alone read.
    const names = (await subdirs(root).catch(() => [])).filter(name => !sealedPath(name)).slice(0, limits.transcriptDirs);
    const next = new Map();
    for (const name of names) next.set(name, state.slugs.get(name) || { sig: null, files: new Map(), released: new Set() });
    state.slugs = next;
    state.rootSig = rootSig;
  }
  const changed = new Set();
  await pool([...state.slugs.keys()], limits.concurrency, async name => {
    const slug = state.slugs.get(name);
    const dir = path.join(root, name);
    const sig = signature(await statOf(dir));
    if (slug.sig === sig) return;
    slug.sig = sig;
    slug.files = new Map();
    slug.released = new Set();
    let listing = [];
    try { listing = await fs.readdir(dir); } catch { /* vanished; cleared below */ }
    for (const file of listing) {
      const transcript = TRANSCRIPT.exec(file);
      if (transcript) { slug.files.set(transcript[1], path.join(dir, file)); continue; }
      const released = RELEASED.exec(file);
      if (released) slug.released.add(released[1]);
    }
    changed.add(name);
  });
  const full = nowMs - state.lastFull >= limits.fullScanMs;
  if (full) state.lastFull = nowMs;
  const known = new Map();
  for (const [name, slug] of state.slugs) for (const [id, file] of slug.files) known.set(id, { id, file, slug: name, dir: path.join(root, name), released: slug.released.has(id) });
  for (const id of state.index.keys()) if (!known.has(id)) state.index.delete(id);
  const hotSince = nowMs - windowMs - limits.fullScanMs;
  const toStat = [];
  for (const item of known.values()) {
    const prior = state.index.get(item.id);
    if (full || !prior || changed.has(item.slug) || needIds.has(item.id) || prior.mtimeMs >= hotSince) toStat.push(item);
  }
  await pool(toStat, limits.concurrency, async item => {
    stats.transcriptStats++;
    const stat = await statOf(item.file);
    if (!stat?.isFile()) { state.index.delete(item.id); return; }
    state.index.set(item.id, { ...item, sig: signature(stat), mtimeMs: Number(stat.mtimeMs), birthtimeMs: Number(stat.birthtimeMs) });
  });
  const files = new Set([...state.index.values()].map(entry => entry.file));
  for (const file of state.tails.keys()) if (!files.has(file)) state.tails.delete(file);
  for (const file of state.edits.keys()) if (!files.has(file)) state.edits.delete(file);
  return { exists: true };
}
async function tailsFor(cache, entries, ctx) {
  const { limits, stats } = ctx;
  const out = new Map();
  const pending = [];
  for (const entry of entries) {
    const hit = cache.transcripts.tails.get(entry.file);
    if (hit && hit.sig === entry.sig) out.set(entry.id, hit.info);
    else pending.push(entry);
  }
  const batch = pending.slice(0, limits.tailReads);
  await pool(batch, limits.concurrency, async entry => {
    try {
      stats.tailReads++;
      const { text, truncated } = await readTail(entry.file, limits.tailBytes);
      const info = parseTail(text, truncated);
      cache.transcripts.tails.set(entry.file, { sig: entry.sig, info });
      out.set(entry.id, info);
    } catch { /* vanished or unreadable; retried on the next change */ }
  });
  return out;
}

// ---- which files a session edited (paths only) ----
// A file-history line names the file twice: `trackingPath`, which is sometimes relative to the folder the session
// started in, and `backup.realParentDir`, which is always the real parent folder. Joining the parent with the name
// gives one absolute path for both shapes and needs no working folder. Checked against this Mac's transcripts:
// 21 of 21 paths built this way pointed at a file that is really there.
function editPath(named, parent) {
  if (typeof named !== 'string' || !named || named.length > 4096 || /[\u0000-\u001f]/.test(named)) return null;
  const base = path.basename(named.split('\\').join('/'));
  if (!base || base === '.' || base === '..' || secretName(base)) return null;
  const dir = absPath(parent);
  const full = dir ? path.join(dir, base) : absPath(named);
  return full && !sealedPath(full) ? full : null;
}
/** The file names on the two file-history line types, oldest first. No other line is parsed and no other field is read. */
function collectEdits(text, truncated, limits) {
  const lines = text.split('\n');
  if (truncated) lines.shift();
  const out = [];
  for (const line of lines) {
    if (line.charCodeAt(0) !== 123 || line.length > limits.editLineBytes) continue;
    const leading = LEADING_TYPE.exec(line.slice(0, 80));
    if (!leading || !EDIT_TYPES.has(leading[1])) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!isObject(row)) continue;
    if (row.type === 'file-history-delta') {
      const found = editPath(row.trackingPath, row.backup?.realParentDir);
      if (found) out.push(found);
      continue;
    }
    const tracked = row.snapshot?.trackedFileBackups;
    if (!isObject(tracked)) continue;
    for (const [name, backup] of Object.entries(tracked).slice(0, limits.editPaths)) {
      const found = editPath(name, backup?.realParentDir);
      if (found) out.push(found);
    }
  }
  return out;
}
// Newest wins its place in the list, so a file edited again moves to the end and the cap drops the oldest.
function addEdits(entry, found, max) {
  for (const item of found) {
    const at = entry.paths.indexOf(item);
    if (at >= 0) entry.paths.splice(at, 1);
    entry.paths.push(item);
  }
  if (entry.paths.length > max) entry.paths.splice(0, entry.paths.length - max);
}
// Reads only the bytes that arrived since the last pass: the offset and size are remembered per file, a file that has
// not grown costs one open and one stat, and a growth larger than one read's worth starts again from the last
// editBytes. Never more than editBytes is read at a time.
async function readEdits(file, previous, limits) {
  const { handle, stat } = await openRead(file);
  try {
    const size = Number(stat.size);
    const mtimeMs = Number(stat.mtimeMs);
    const same = Boolean(previous) && previous.dev === Number(stat.dev) && previous.ino === Number(stat.ino);
    if (same && previous.size === size && previous.mtimeMs === mtimeMs) return previous;
    const grew = same && size >= previous.consumed && size - previous.consumed <= limits.editBytes;
    const start = grew ? previous.consumed : Math.max(0, size - Math.min(limits.editBytes, size));
    const buffer = await readRange(handle, start, size - start);
    const entry = grew
      ? { ...previous, size, mtimeMs, paths: previous.paths }
      : { dev: Number(stat.dev), ino: Number(stat.ino), size, mtimeMs, consumed: start, aligned: start === 0, paths: [] };
    // A read that starts mid-line drops that line; the next pass starts at the newline this one ended on.
    const partial = grew ? !previous.aligned : start > 0;
    const end = buffer.lastIndexOf(10) + 1;
    if (end > 0) {
      const text = buffer.subarray(0, end).toString('utf8');
      addEdits(entry, collectEdits(text, partial, limits), limits.editPaths);
      entry.consumed = start + end;
      entry.aligned = true;
    }
    return entry;
  } finally { await handle.close().catch(() => {}); }
}
/** Session id to the files it edited, newest first. Each transcript is read forward from where the last pass stopped. */
async function editsFor(cache, entries, ctx) {
  const { limits, stats } = ctx;
  const out = new Map();
  const state = cache.transcripts.edits;
  const batch = entries.slice(0, limits.editReads);
  await pool(batch, limits.concurrency, async entry => {
    try {
      const previous = state.get(entry.file);
      const next = await readEdits(entry.file, previous, limits);
      stats.editChecks++;
      if (next !== previous) stats.editReads++;
      state.set(entry.file, next);
      if (next.paths.length) out.set(entry.id, [...next.paths].reverse());
    } catch { /* vanished or unreadable; retried on the next change */ }
  });
  return out;
}
// ---- which files a session has backed up (entry names only) ----
// Claude keeps one folder of backups per session at ~/.claude/file-history/<cliSessionId>, and names every entry after
// the file it holds: the first 16 hex characters of sha256 of that file's absolute path, then '@v' and the version.
// The listing therefore says how many distinct files the session wrote and when it last wrote one, and the same hash
// of a path we already have answers "did this session touch that file?" without ever discovering a path.
// Checked against this Mac on 2026-09-17: 3 of 3 known files of a live session hashed to an entry that was there.
// The entries themselves hold the file contents and are never opened; a symlink in that folder is skipped, not followed.
// The count and the time are the whole folder. The hashes that travel are the entries of this session's most recent
// stretch of work, because a session open for days backed up whatever it touched on its first day.
async function readHistory(dir, previous, limits) {
  const stat = await statOf(dir);
  if (!stat?.isDirectory()) return null;
  const sig = signature(stat);
  if (previous && previous.sig === sig) return previous;
  const listing = await fs.readdir(dir, { withFileTypes: true });
  const times = new Map();
  const entries = [];
  let capped = false;
  for (const item of listing) {
    // isFile() is false for a symlink, so a planted link is listed and then left alone.
    if (!item.isFile()) continue;
    const found = HISTORY_ENTRY.exec(item.name);
    if (!found) continue;
    if (!times.has(found[1])) times.set(found[1], 0);
    // The whole listing is already in hand, so the count is the folder's own. Only the entries whose time is read
    // are capped.
    if (entries.length >= limits.historyEntries) { capped = true; continue; }
    entries.push([item.name, found[1]]);
  }
  // The newest entry is when this session last wrote a file. The folder's own time stands in when the listing was cut
  // short at the cap, because then the newest entry may not be among the ones that were looked at.
  let newest = capped ? Number(stat.mtimeMs) : 0;
  await pool(entries, limits.concurrency, async ([name, hash]) => {
    const entry = await lstatOf(path.join(dir, name));
    const ms = entry?.isFile() ? Number(entry.mtimeMs) : 0;
    if (ms > newest) newest = ms;
    if (ms > times.get(hash)) times.set(hash, ms);
  });
  // Only the files of this session's latest stretch of work say what it is on. The window runs back from this
  // session's own newest entry, not from the clock, so an idle session keeps its answer and the result stays a pure
  // function of the folder. Newest first, so the cap below drops the oldest rather than whatever readdir returned
  // last. An entry past the cap above has no time of its own, so it counts in the folder's total but does not travel,
  // and the fallback covers the one case that leaves nothing: a cut-short listing where every time read is older
  // than the window.
  const recent = [...times].filter(([, ms]) => ms >= newest - limits.historyWindowMs).sort((a, b) => b[1] - a[1]);
  const kept = (recent.length ? recent : [...times]).map(([hash]) => hash);
  return { sig, hashes: kept.slice(0, limits.historyHashes), files: times.size, at: time(newest) };
}
/** Session id to the hashed names of the files it has backed up. The folder is listed again only when it has changed. */
async function historyFor(cache, ids, root, ctx) {
  const { limits, stats } = ctx;
  const out = new Map();
  const take = ids.slice(0, limits.historyDirs);
  await pool(take, limits.concurrency, async id => {
    if (!cliId(id)) return;
    try {
      stats.historyChecks++;
      const previous = cache.history.get(id);
      const next = await readHistory(path.join(root, id), previous, limits);
      if (!next) { cache.history.delete(id); return; }
      if (next !== previous) stats.historyLists++;
      cache.history.set(id, next);
      if (next.files) out.set(id, next);
    } catch { /* vanished or unreadable; retried on the next change */ }
  });
  const wanted = new Set(take);
  for (const id of cache.history.keys()) if (!wanted.has(id)) cache.history.delete(id);
  return out;
}
// Live helpers = sub-agent transcripts written in the last minute. Folder listings are kept until the folder changes, and between
// full passes only new or recently active files are re-checked, so a repeat read costs a handful of stat calls.
async function countHelpers(cache, entry, cliSessionId, ctx, budget) {
  if (!entry || !cliSessionId) return 0;
  const { nowMs, limits, stats } = ctx;
  let state = cache.helpers.get(cliSessionId);
  if (!state) { state = { dirs: new Map(), mtimes: new Map(), lastFull: 0, seenAt: 0 }; cache.helpers.set(cliSessionId, state); }
  state.seenAt = nowMs;
  const full = nowMs - state.lastFull >= limits.fullScanMs;
  if (full) state.lastFull = nowMs;
  const cutoff = nowMs - limits.helperWindowMs;
  const files = [];
  const visited = new Set();
  const walk = async (dir, depth) => {
    visited.add(dir);
    const sig = signature(await statOf(dir));
    let known = state.dirs.get(dir);
    if (!known || known.sig !== sig) {
      known = { sig, subdirs: [], files: [] };
      if (sig !== 'none') {
        try {
          for (const item of await fs.readdir(dir, { withFileTypes: true })) {
            if (item.isDirectory() && !item.name.startsWith('.')) known.subdirs.push(item.name);
            else if (item.isFile() && HELPER_FILE.test(item.name)) known.files.push(item.name);
          }
        } catch { /* vanished */ }
      }
      state.dirs.set(dir, known);
    }
    for (const name of known.files) files.push(path.join(dir, name));
    if (depth < 2) for (const sub of known.subdirs) await walk(path.join(dir, sub), depth + 1);
  };
  await walk(path.join(entry.dir, cliSessionId, 'subagents'), 0);
  for (const dir of state.dirs.keys()) if (!visited.has(dir)) state.dirs.delete(dir);
  const listed = new Set(files);
  for (const file of state.mtimes.keys()) if (!listed.has(file)) state.mtimes.delete(file);
  const recheck = files.filter(file => full || !state.mtimes.has(file) || state.mtimes.get(file) >= cutoff - limits.fullScanMs);
  const take = recheck.slice(0, Math.max(0, budget.left));
  budget.left -= take.length;
  stats.helperStats += take.length;
  await pool(take, limits.concurrency, async file => {
    try { state.mtimes.set(file, (await fs.stat(file)).mtimeMs); } catch { state.mtimes.delete(file); }
  });
  return files.filter(file => (state.mtimes.get(file) ?? 0) >= cutoff).length;
}
// Transcript-tail state for registry records without a status (older CLIs). Always inferred.
function tailActivity(tail, mtimeMs, helpers, ctx) {
  if (helpers > 0) return { activity: 'working', reason: null, since: tail?.lastEventAt ?? null };
  const since = tail?.lastEventAt ?? null;
  const age = Number.isFinite(mtimeMs) ? ctx.nowMs - mtimeMs : Infinity;
  switch (tail?.turn) {
    case 'finished': return { activity: 'open', reason: null, since };
    case 'failed': return { activity: 'failed', reason: PROBLEM, since };
    case 'tool': return age >= ctx.limits.promptWaitMs ? { activity: 'needs-you', reason: 'Waiting for your OK', since } : { activity: 'working', reason: null, since };
    case 'working': return age <= ctx.limits.staleWorkingMs ? { activity: 'working', reason: null, since } : { activity: 'unknown', reason: null, since };
    default: return { activity: 'unknown', reason: null, since };
  }
}

// A state the session itself reported through Summon's hooks (core/hook-events.mjs). It beats the app's own record
// when that record is inferred or older than the report; a working report older than staleWorkingMs is ignored, and
// an ended report newer than the record closes the live row. Without hooks nothing here applies.
function hookOverride(hook, own, inferred, ctx) {
  if (!hook || !hook.state || !Number.isFinite(hook.stateAt)) return null;
  if (hook.state === 'ended') return hook.stateAt >= own ? { ended: true } : null;
  if (!inferred && hook.stateAt < own) return null;
  if (hook.state === 'working' && ctx.nowMs - hook.stateAt > ctx.limits.staleWorkingMs) return null;
  return { activity: hook.state, reason: hook.reason ?? null, since: hook.stateAt };
}

function session(fields) {
  return {
    app: 'claude', surface: fields.surface, id: fields.id, title: fields.title ?? null,
    ...(fields.recentContext ? { recentContext: fields.recentContext } : {}),
    ...(fields.hookSessionId ? { hookSessionId: fields.hookSessionId } : {}),
    // 'summon' only when Summon started this session itself (the hook ledger holds its launch tag).
    origin: fields.origin === 'summon' ? 'summon' : null,
    // 'user' only when the person named the session; a missing source counts as the app's own wording.
    titleSource: fields.titleSource === 'user' ? 'user' : fields.title ? 'auto' : null,
    cwd: fields.cwd ?? null, worktreePath: fields.worktreePath ?? null, branch: fields.branch ?? null,
    startedAt: fields.startedAt ?? null, updatedAt: fields.updatedAt ?? null,
    activity: fields.activity, activitySince: fields.activitySince ?? null, reason: fields.reason ?? null,
    unread: Boolean(fields.unread), archived: Boolean(fields.archived), pinned: Boolean(fields.pinned), live: Boolean(fields.live),
    confidence: fields.confidence || 'reported', helpers: fields.helpers || 0, model: fields.model ?? null, work: fields.work ?? null,
    // Files this session edited, newest first, from transcript metadata only.
    touchedPaths: Array.isArray(fields.touchedPaths) && fields.touchedPaths.length ? fields.touchedPaths : null,
    // The same question asked the other way round: the hashed names of the files this session has backed up, how many
    // distinct files that is, and when the newest was written. Hashes only, so no path is discovered here.
    touchedHashes: Array.isArray(fields.touchedHashes) && fields.touchedHashes.length ? fields.touchedHashes : null,
    touchedFiles: whole(fields.touchedFiles) || null,
    touchedAt: time(fields.touchedAt),
  };
}
const privateSession = item => [item.cwd, item.worktreePath].some(sealedPath);
const rank = item => item.activity === 'needs-you' || item.activity === 'failed' ? 0 : item.unread ? 1 : item.activity === 'working' ? 2 : item.live ? 3 : 4;

async function scan(cache, options, stats) {
  const started = performance.now();
  let mark = started;
  const lap = name => { const at = performance.now(); stats.phases[name] = Math.round((at - mark) * 10) / 10; mark = at; };
  const nowMs = nowOf(options.now);
  const limits = limitsOf(options.limits);
  const recentMs = Number.isFinite(options.recentMs) && options.recentMs >= 0 ? options.recentMs : 7 * DAY;
  const horizon = nowMs - recentMs;
  const ctx = { nowMs, limits, stats };
  const warnings = new Set();
  const where = pathsFor(cache.homeDir);
  // Per CLI session id: what that session reported about itself through hooks (empty when hooks are off).
  const hookStates = options.hookStates instanceof Map ? options.hookStates : new Map();
  const hookFor = id => (typeof id === 'string' ? hookStates.get(id.toLowerCase()) ?? hookStates.get(id) ?? null : null);
  // 1. Which processes are alive (pid + start time only; never command lines).
  let processes = null;
  try { processes = await options.processes; } catch { processes = null; }
  const infra = await loadInfra(options);
  // An explicit list (even a failed one, passed as null) is the caller's answer; only a missing one is looked up here,
  // so the aggregator's already-failed check is not repeated per poll.
  if (options.processes === undefined && !(processes instanceof Map) && typeof infra.listProcesses === 'function') {
    try { processes = await infra.listProcesses({ run: options.run }); } catch { processes = null; }
  }
  // "We could not look" is not "nothing is running": keep the distinction for the source lines below.
  const processesKnown = processes instanceof Map;
  if (!processesKnown) { processes = new Map(); warnings.add(PROCESSES_FAILED); }
  // Records with procStart are matched exactly. Older CLIs write none, so a reused pid is caught by the record's own
  // times: a live session's process cannot have started after the file describing it was last written (60 s for clock skew).
  const writtenAt = entry => Math.max(entry.fileMs ?? 0, entry.statusUpdatedAt ?? 0, entry.updatedAt ?? 0, entry.startedAt ?? 0);
  const alive = entry => {
    try {
      if (entry.procStart) return Boolean(infra.isAlive(processes, entry.pid, { lstart: entry.procStart }));
      if (!infra.isAlive(processes, entry.pid, {})) return false;
      const started = processes.get(entry.pid)?.startedAt;
      const bound = writtenAt(entry);
      return !(Number.isFinite(started) && bound > 0 && started > bound + 60000);
    } catch { return false; }
  };
  const comms = [...processes.values()].map(item => typeof item?.comm === 'string' ? item.comm : '');
  const appRunning = comms.some(comm => comm.includes('/Claude/claude-code/') || comm.includes('/Applications/Claude.app/'));
  lap('processes');

  // 2. Live registry.
  const registry = await scanRegistry(cache, where.registry, limits, stats);
  const liveEntries = registry.entries.filter(entry => {
    if (entry.cwd && sealedPath(entry.cwd)) return false;
    const kind = entry.kind ?? 'interactive';
    if (kind !== 'interactive' && !(kind === 'bg' && entry.entrypoint === 'cli')) return false;
    return alive(entry);
  });
  const best = (list, entry) => {
    const current = list.get(entry.sessionId);
    if (!current || statusRank(entry) < statusRank(current) || (statusRank(entry) === statusRank(current) && (entry.statusUpdatedAt ?? 0) > (current.statusUpdatedAt ?? 0))) list.set(entry.sessionId, entry);
  };
  lap('registry');
  const desktopLive = new Map(); // cli session id -> registry entry held by a desktop-app process (or an old CLI without entrypoint)
  const terminalLive = new Map();
  for (const entry of liveEntries) {
    if (entry.entrypoint === 'cli') best(terminalLive, entry);
    else if (isDesktopEntry(entry.entrypoint) || entry.entrypoint === null) best(desktopLive, entry);
  }

  // 3. Desktop app files, unread marks and worktree leases.
  const dirs = await desktopDirs(cache, where.desktopRoot, limits).catch(() => null);
  const desktopAvailable = Boolean(dirs);
  let unread = { ok: true, ids: new Set(), diffs: new Map() };
  let byLease = new Map();
  const entries = [];
  if (dirs) {
    unread = await scanUnread(cache, where.leveldb, infra.readLocalStorageKeys, stats);
    if (!unread.ok) { warnings.add(UNREAD_FAILED); unread = { ok: false, ids: new Set(), diffs: unread.diffs }; }
    byLease = await scanWorktrees(cache, where.worktrees, limits);
    for (const dir of dirs) {
      const state = await scanDesktopDir(cache, dir, ctx).catch(() => null);
      if (!state) continue;
      for (const entry of state.files.values()) {
        if (state.deleted.has(entry.id)) continue;
        entries.push({ entry, archivedIndex: state.archived.has(entry.id) });
      }
    }
  }
  // The prefix is re-read on every change; parsed fields can lag a capped pass, so the prefix wins when it has the value.
  lap('desktop');
  const cliOf = entry => entry.prefix.cliSessionId ?? entry.full?.cliSessionId ?? null;
  const liveFor = entry => {
    const own = cliOf(entry);
    if (own && desktopLive.has(own)) return desktopLive.get(own);
    for (const prior of entry.full?.priorCliSessionIds ?? []) if (desktopLive.has(prior)) return desktopLive.get(prior);
    return null;
  };
  const lastActivity = entry => entry.prefix.lastActivityAt ?? entry.full?.lastActivityAt ?? null;
  const interesting = [];
  for (const item of entries) {
    const { entry } = item;
    const reg = liveFor(entry);
    const activityAt = lastActivity(entry) ?? entry.mtimeMs; // mtime is an upper bound when the prefix missed the time
    const hot = !sealedPath(entry.prefix.cwd) && (Boolean(reg) || unread.ids.has(entry.id) || activityAt >= horizon);
    entry.hot = hot;
    if (hot) interesting.push({ ...item, reg });
  }
  const toParse = interesting
    .filter(({ entry }) => entry.fullSig !== entry.sig)
    .sort((a, b) => Number(Boolean(b.reg)) - Number(Boolean(a.reg)) || Number(unread.ids.has(b.entry.id)) - Number(unread.ids.has(a.entry.id)) || (lastActivity(b.entry) ?? 0) - (lastActivity(a.entry) ?? 0))
    .slice(0, limits.fullParses);
  await pool(toParse, limits.concurrency, async ({ entry }) => {
    stats.fullParses++;
    try {
      const text = await readCapped(entry.file, limits.desktopBytes);
      entry.full = text == null ? null : pickDesktop(JSON.parse(text));
    } catch { entry.full = null; }
    entry.fullSig = entry.sig;
  });
  // A fresh parse can reveal earlier cli ids that a live process still holds.
  for (const item of interesting) item.reg ||= liveFor(item.entry);
  lap('parse');
  // cli session id -> desktop id, from every file (prefix) and every parsed file's earlier cli ids.
  const cliToLocal = new Map();
  for (const { entry } of entries) {
    const own = cliOf(entry);
    if (own) cliToLocal.set(own, entry.id);
    for (const prior of entry.full?.priorCliSessionIds ?? []) if (!cliToLocal.has(prior)) cliToLocal.set(prior, entry.id);
  }
  // Older CLIs write no entrypoint: a record that matches no desktop session is a terminal session.
  for (const [id, entry] of [...desktopLive]) {
    if (entry.entrypoint === null && !cliToLocal.has(id)) { desktopLive.delete(id); best(terminalLive, entry); }
  }

  // 4. Transcripts: terminal sessions, fallback state and helpers.
  const needIds = new Set([...terminalLive.keys(), ...desktopLive.keys()]);
  const windowMs = Math.min(recentMs, limits.terminalRecentMs);
  const transcripts = await scanTranscripts(cache, where.projects, ctx, { needIds, windowMs }).catch(() => ({ exists: false }));
  const index = cache.transcripts.index;
  const terminalCandidates = [];
  for (const item of index.values()) {
    if (terminalLive.has(item.id)) { terminalCandidates.push(item); continue; }
    if (item.released || cliToLocal.has(item.id) || desktopLive.has(item.id)) continue;
    if (item.mtimeMs >= nowMs - windowMs) terminalCandidates.push(item);
  }
  // Desktop sessions need their recent conversation too, even when their registry already reports a state.
  const fallbackIds = new Set();
  for (const { reg, entry } of interesting) {
    const cli = reg?.sessionId ?? cliOf(entry);
    if (cli && index.has(cli)) fallbackIds.add(cli);
  }
  const tailEntries = [...terminalCandidates, ...[...fallbackIds].map(id => index.get(id))]
    .sort((a, b) => Number(needIds.has(b.id)) - Number(needIds.has(a.id)) || b.mtimeMs - a.mtimeMs);
  const tails = await tailsFor(cache, tailEntries, ctx);
  // Which files each session it is about to show has edited. Live sessions first, then the most recently written
  // transcripts, so a busy Mac spends the read budget where the answer changes.
  const editIds = new Set([...terminalCandidates.map(item => item.id), ...terminalLive.keys()]);
  for (const { reg, entry } of interesting) { const cli = reg?.sessionId ?? cliOf(entry); if (cli) editIds.add(cli); }
  const editEntries = [...editIds].map(id => index.get(id)).filter(Boolean)
    .sort((a, b) => Number(needIds.has(b.id)) - Number(needIds.has(a.id)) || b.mtimeMs - a.mtimeMs);
  const edits = await editsFor(cache, editEntries, ctx);
  // How many files each of those sessions has backed up, and when it last did, from the names in its own file-history
  // folder. A session with no folder there says nothing rather than reporting zero.
  const historyIds = [...editEntries.map(item => item.id), ...[...editIds].filter(id => !index.has(id))];
  const history = await historyFor(cache, historyIds, path.join(where.claudeHome, 'file-history'), ctx);
  lap('transcripts');
  const budget = { left: limits.helperEntries };

  const sessions = [];
  // Desktop app sessions.
  let appLive = 0, appWorking = 0, appNeeds = 0;
  for (const { entry, archivedIndex, reg } of interesting) {
    const full = entry.full;
    const archived = Boolean((entry.prefix.isArchived ?? full?.isArchived) || archivedIndex);
    let live = Boolean(reg);
    if (archived && !live) continue;
    const lastActivityAt = lastActivity(entry);
    let state = reg ? registryActivity(reg) : { activity: 'quiet', reason: null };
    let confidence = 'reported';
    let since = reg?.statusUpdatedAt ?? reg?.updatedAt ?? null;
    let helpers = 0;
    const cli = reg?.sessionId ?? cliOf(entry);
    // The local_/uuid join only this reader can make: the desktop row's hook events arrive under its CLI session id.
    const hook = hookFor(cli);
    const reported = reg ? hookOverride(hook, reg.statusUpdatedAt ?? reg.updatedAt ?? 0, !state, ctx) : null;
    if (reported?.ended) {
      live = false;
      state = { activity: 'quiet', reason: null };
      since = lastActivityAt;
    } else if (reported) {
      state = { activity: reported.activity, reason: reported.reason };
      since = reported.since;
      if (state.activity === 'working') helpers = await countHelpers(cache, index.get(cli), cli, ctx, budget);
    } else if (reg && !state) {
      const indexed = index.get(cli);
      helpers = await countHelpers(cache, indexed, cli, ctx, budget);
      const fallback = tailActivity(tails.get(cli), indexed?.mtimeMs, helpers, ctx);
      state = fallback;
      since = fallback.since;
      confidence = 'inferred';
    } else if (state.activity === 'working') {
      helpers = await countHelpers(cache, index.get(cli), cli, ctx, budget);
    } else if (state.activity === 'quiet') {
      since = lastActivityAt;
    }
    if (state.activity !== 'working' && state.activity !== 'needs-you' && full?.errorAt && full.errorAt >= (lastActivityAt ?? 0)) {
      state = { activity: 'failed', reason: PROBLEM };
      since = full.errorAt;
      confidence = 'reported';
    }
    const isUnread = !archived && unread.ids.has(entry.id);
    if (!(live || isUnread || state.activity === 'needs-you' || (lastActivityAt ?? 0) >= horizon)) continue;
    const lease = byLease.get(entry.id);
    const item = session({
      surface: 'desktop', id: entry.id, hookSessionId: cli, title: full?.title, recentContext: tails.get(cli)?.recentContext,
      cwd: full?.cwd ?? entry.prefix.cwd ?? reg?.cwd, worktreePath: full?.worktreePath ?? lease?.path, branch: full?.branch ?? lease?.branch,
      startedAt: full?.createdAt, updatedAt: lastActivityAt,
      activity: state.activity, activitySince: since, reason: state.reason,
      unread: isUnread, archived, pinned: full?.pinned, live, confidence, helpers, model: full?.model, work: unread.diffs.get(entry.id)?.work ?? null,
      origin: hook?.launch ? 'summon' : null,
      titleSource: full?.titleSource, touchedPaths: cli ? edits.get(cli) : null,
      touchedHashes: cli ? history.get(cli)?.hashes : null, touchedFiles: cli ? history.get(cli)?.files : null, touchedAt: cli ? history.get(cli)?.at : null,
    });
    if (privateSession(item) || sealedPath(full?.originCwd)) continue;
    if (live) { appLive++; if (item.activity === 'working') appWorking++; else if (item.activity === 'needs-you' || item.activity === 'failed') appNeeds++; }
    sessions.push(item);
  }
  // Terminal sessions (live registry records first, then recent transcripts nobody holds).
  let terminalRunning = 0;
  const seenTerminal = new Set();
  for (const [id, reg] of terminalLive) {
    if (!UUID.test(id)) continue;
    const indexed = index.get(id);
    const tail = tails.get(id);
    let state = registryActivity(reg);
    let confidence = 'reported';
    let since = reg.statusUpdatedAt ?? reg.updatedAt ?? reg.startedAt;
    let helpers = 0;
    const hook = hookFor(id);
    const reported = hookOverride(hook, reg.statusUpdatedAt ?? reg.updatedAt ?? 0, !state, ctx);
    // A session that reported its own end is no longer live: it falls through to the finished-transcript rows below.
    if (reported?.ended) { terminalLive.delete(id); continue; }
    if (reported) {
      state = { activity: reported.activity, reason: reported.reason };
      since = reported.since;
      if (state.activity === 'working') helpers = await countHelpers(cache, indexed, id, ctx, budget);
    } else if (!state) {
      helpers = await countHelpers(cache, indexed, id, ctx, budget);
      state = tailActivity(tail, indexed?.mtimeMs, helpers, ctx);
      since = state.since;
      confidence = 'inferred';
    } else if (state.activity === 'working') {
      helpers = await countHelpers(cache, indexed, id, ctx, budget);
    }
    const item = session({
      surface: reg.kind === 'bg' ? 'background' : 'terminal', id, title: tail?.title ?? reg.name, recentContext: tail?.recentContext, origin: hook?.launch ? 'summon' : null,
      // A registry name is only kept when the person set it, so it is a user title either way.
      titleSource: tail?.title ? tail.titleSource : reg.name ? 'user' : null,
      cwd: reg.cwd ?? tail?.cwd, branch: tail?.branch, startedAt: reg.startedAt ?? (indexed ? time(indexed.birthtimeMs) : null),
      updatedAt: tail?.updatedAt ?? reg.statusUpdatedAt ?? reg.updatedAt ?? reg.startedAt,
      activity: state.activity, activitySince: since, reason: state.reason, live: true, confidence, helpers, model: tail?.model,
      touchedPaths: edits.get(id),
      touchedHashes: history.get(id)?.hashes, touchedFiles: history.get(id)?.files, touchedAt: history.get(id)?.at,
    });
    if (privateSession(item)) continue;
    seenTerminal.add(id);
    terminalRunning++;
    sessions.push(item);
  }
  for (const item of terminalCandidates) {
    if (seenTerminal.has(item.id) || terminalLive.has(item.id)) continue;
    const tail = tails.get(item.id);
    if (!tail || tail.entrypoint !== 'cli' || !UUID.test(item.id)) continue;
    if (!tail.updatedAt || tail.updatedAt < nowMs - windowMs) continue;
    const row = session({
      surface: 'terminal', id: item.id, title: tail.title, recentContext: tail.recentContext, titleSource: tail.titleSource, cwd: tail.cwd, branch: tail.branch, origin: hookFor(item.id)?.launch ? 'summon' : null,
      startedAt: time(item.birthtimeMs), updatedAt: tail.updatedAt,
      activity: 'quiet', activitySince: tail.updatedAt, live: false, confidence: 'reported', model: tail.model,
      touchedPaths: edits.get(item.id),
      touchedHashes: history.get(item.id)?.hashes, touchedFiles: history.get(item.id)?.files, touchedAt: history.get(item.id)?.at,
    });
    if (privateSession(row)) continue;
    sessions.push(row);
  }

  // A retained provider child is its own lifecycle, not a task outcome and not the parent's activity.
  // Transcript mtimes still supply only an inferred count; they never create invented child identities.
  for (const item of sessions) {
    const parentSessionKey = `claude:${item.surface}:${item.id}`;
    const hookId = item.hookSessionId ?? item.id;
    const hook = hookFor(hookId);
    const children = (hook?.children ?? []).filter(child => !sealedPath(child.cwd)).slice(-100).map(child => {
      const ended = Number.isFinite(child.endedAt);
      const stale = !ended && (!item.live || nowMs - child.updatedAt > limits.staleWorkingMs || hook.state === 'ended');
      return { key: `claude:child:${hookId}:${child.id}`, id: child.id, parentSessionKey, provider: 'claude',
        cwd: child.cwd ?? null, worktreePath: null,
        label: child.type || `Helper ${child.id}`, activity: ended ? 'quiet' : stale ? 'unknown' : child.state ?? 'unknown',
        confidence: stale || !child.state ? 'inferred' : 'reported',
        startedAt: child.startedAt ? new Date(child.startedAt).toISOString() : null,
        updatedAt: new Date(child.updatedAt).toISOString(), endedAt: ended ? new Date(child.endedAt).toISOString() : null };
    });
    if (children.length) item.children = children;
  }
  for (const [id, state] of cache.helpers) if (state.seenAt !== nowMs) cache.helpers.delete(id);
  sessions.sort((a, b) => rank(a) - rank(b) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.id.localeCompare(b.id));
  const capped = sessions.slice(0, limits.sessions);

  // Counts nest inside the total (a working session is also open in the app), so they never read as group sizes.
  const appParts = [];
  if (appWorking) appParts.push(`${appWorking} working`);
  if (appNeeds) appParts.push(`${appNeeds} waiting on you`);
  const sources = [
    {
      app: 'claude', label: APP_LABEL, available: desktopAvailable || appRunning, running: appRunning,
      detail: !desktopAvailable && !appRunning ? 'No Claude app sessions on this Mac.'
        : !processesKnown ? 'Summon could not check whether the Claude app is running.'
          : !appRunning ? 'The Claude app is closed, so nothing there is running.'
            : appLive ? `${plural(appLive, 'session')} open in the app${appParts.length ? `, ${appParts.join(', ')}` : ''}.` : 'Open, with nothing running.',
    },
    {
      app: 'claude', label: TERMINAL_LABEL, available: registry.exists || Boolean(transcripts.exists), running: terminalRunning > 0,
      detail: !(registry.exists || transcripts.exists) ? 'Claude is not set up in Terminal on this Mac.'
        : terminalRunning ? `${plural(terminalRunning, 'session')} running in Terminal.`
          : !processesKnown ? 'Summon could not check whether Claude is running in Terminal.' : 'No Claude session is running in Terminal.',
    },
  ];
  lap('merge');
  stats.ms = Math.round(performance.now() - started);
  return { sessions: capped, sources, warnings: [...warnings] };
}

/** A reader that keeps a change-gated cache (file signatures), so a repeat read with nothing changed costs a few stat calls. */
export function createClaudeReader(deps = {}) {
  let cache = null;
  let queue = Promise.resolve();
  let stats = emptyStats();
  const readOnce = async options => {
    stats = emptyStats();
    try {
      // An explicit home must be a full path; only a missing one means this Mac's home folder.
      const homeDir = options.homeDir == null ? os.homedir() : options.homeDir;
      if (typeof homeDir !== 'string' || !path.isAbsolute(homeDir) || homeDir.includes('\0')) throw new Error('Home folder must be a full path.');
      if (!cache || cache.homeDir !== homeDir) cache = newCache(homeDir);
      return await scan(cache, options, stats);
    } catch {
      cache = null;
      return {
        sessions: [],
        // failed: the aggregator keeps the last list that worked rather than emptying Claude's rows for one bad poll.
        failed: true,
        sources: [
          { app: 'claude', label: APP_LABEL, available: false, running: false, detail: READ_FAILED },
          { app: 'claude', label: TERMINAL_LABEL, available: false, running: false, detail: READ_FAILED },
        ],
        warnings: [READ_FAILED],
      };
    }
  };
  return {
    // Reads run one at a time so they never race on the shared cache.
    read(options = {}) {
      const next = queue.then(() => readOnce({ ...deps, ...(isObject(options) ? options : {}) }));
      queue = next.catch(() => {});
      return next;
    },
    stats: () => ({ ...stats }),
  };
}

/** One-shot read without a persistent cache. Never throws. */
export async function readClaudeSessions(options = {}) {
  return createClaudeReader().read(options);
}
