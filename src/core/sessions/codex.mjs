import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { sealedPath } from '../workstreams.mjs';

/**
 * Codex sessions: read-only metadata about ChatGPT.app Codex threads and `codex` CLI runs.
 * The thread list comes from a clone of ~/.codex/state_<n>.sqlite; unread and pinned marks from .codex-global-state.json;
 * "loaded" from thread-writer-locks; "working" from turn lifecycle events near the end of each rollout.
 * Which files a thread edited comes from the same tail: the keys of a completed FileChange item's `changes` map,
 * read as bytes so the patch text beside them is never turned into a string.
 * Never selects or keeps title, preview or first_user_message, never parses message lines, never reads prompt, draft or
 * description keys, never writes to ~/.codex, never talks to a Codex process.
 */

const LIMITS = {
  sessions: 300, rows: 5000, edges: 20000, globalStateBytes: 8 * 1024 * 1024, importsBytes: 16 * 1024 * 1024, sessionIndexBytes: 4 * 1024 * 1024,
  sessionIndexNames: 5000, smallFileBytes: 64 * 1024, tailBytes: 64 * 1024, chunkBytes: 256 * 1024, backBytesLive: 16 * 1024 * 1024,
  backBytesIdle: 1024 * 1024, growBytes: 16 * 1024 * 1024, tailWindowMs: 24 * 3600 * 1000, tails: 150, tailConcurrency: 8,
  helperChildren: 40, helperDepth: 4, worktrees: 100, waitQuietMs: 30 * 1000, staleWorkingMs: 10 * 60 * 1000, titleChars: 120,
  editPaths: 200, itemHeadBytes: 4096,
};
const LABEL = 'Codex';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCK_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.lock$/i;
const STATE_DB = /^state_(\d{1,6})\.sqlite$/;
const IMPORTED_ID = /"imported_thread_id"\s*:\s*"([0-9a-fA-F-]{36})"/g;
const CODEX_BINARY = /(?:^|\/)codex$/;
const CODEX_APP = /\/(?:ChatGPT|Codex)\.app\/Contents\/(?:MacOS\/(?:ChatGPT|Codex)|Resources\/codex)$/;
// Rollout lines start {"timestamp":…,"ordinal":…,"type":…,"payload":{"type":…. Only these enum tokens are ever taken from a line.
const LINE_HEAD = /^\{"timestamp":"([^"\\]{1,64})",(?:"ordinal":\d{1,12},)?"type":"([a-z_]{1,40})"(?:,"payload":\{"type":"([a-z_]{1,48})")?/;
const STARTED_AT = /"started_at":(\d{1,12}(?:\.\d{1,9})?)/;
const REVIEWER = /"approvals_reviewer":"([a-z_]{1,40})"/;
const LIFECYCLE = new Set(['task_started', 'task_complete', 'turn_aborted']);
const TOOL_CALLS = new Set(['function_call', 'custom_tool_call', 'local_shell_call', 'mcp_tool_call']);
// A completed file change: `changes` is keyed by the full path of each file it wrote. Both markers sit in the item's
// head, well before the patch text and the command output that follow on the same line.
const FILE_CHANGE_ITEM = Buffer.from('"type":"FileChange"');
const CHANGES_MAP = Buffer.from('"changes":{');
// Names that never travel, whatever folder they sit in. The aggregator runs the full check, which also knows the
// repo's own private folders.
const SECRET_BASE = /^(?:\.env(?:\..*)?|\.envrc|\.netrc|\.npmrc|\.pgpass|\.pypirc|\.git-credentials|\.dev\.vars|id_rsa|id_dsa|id_ecdsa|id_ed25519)$/i;
const SECRET_EXT = /\.(?:pem|key|p12|pfx|keychain|keystore|jks|kdbx|env|tfvars|p8|ppk)$/i;
// Never selected: title, preview, first_user_message (they hold the first prompt).
const THREAD_COLUMNS = ['id', 'rollout_path', 'source', 'cwd', 'name', 'created_at_ms', 'created_at', 'updated_at_ms', 'updated_at', 'recency_at_ms', 'archived', 'is_pinned', 'thread_source', 'model', 'git_branch'];
const REQUIRED_COLUMNS = ['id', 'rollout_path', 'source'];
const HIDDEN_SOURCES = ['subagent', 'guardian_review'];
// Table layouts come from the stored CREATE text (pragma functions are not allowed on snapshots).
const SCHEMA_SQL = "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('threads', 'thread_spawn_edges')";
const CONSTRAINT_WORD = /^(?:CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN)$/i;
const REASON_WAITING = 'Probably waiting for your OK';
const REASON_INTERRUPTED = 'Interrupted when the app closed';
const WARN = {
  list: "Codex's thread list could not be read.",
  layout: "Codex's thread list has a layout Summon does not know yet.",
  unread: "Codex's unread marks could not be read.",
  imports: "Codex's list of imported Claude sessions could not be read, so threads without a model are hidden.",
  processes: 'Summon could not check which apps are running, so open Codex threads may be out of date.',
  tails: 'Some Codex threads could not be checked for activity.',
  failed: 'Codex sessions could not be read.',
};

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const listOf = value => Array.isArray(value) ? value : [];
const absolute = value => typeof value === 'string' && value.length <= 4096 && path.isAbsolute(value) && !value.includes('\0');
const inside = (candidate, root) => candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
const secretName = base => SECRET_BASE.test(base) || SECRET_EXT.test(base) || /secret|credential/i.test(base);
const signature = stat => stat ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}` : '-';
const finiteOrNull = value => (typeof value === 'number' || typeof value === 'bigint') && Number.isFinite(Number(value)) ? Number(value) : null;
const positiveMs = value => { const n = finiteOrNull(value); return n !== null && n > 0 ? n : null; };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// Titles are untrusted: drop control and bidirectional-override characters, collapse space, cap the length.
const cleanTitle = (value, max = LIMITS.titleChars) => {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
};
// UUIDv7 ids carry their creation time in the first 48 bits.
const uuidTime = id => {
  if (!UUID.test(id) || id[14] !== '7') return null;
  const ms = parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
};
const resolveNow = now => {
  const value = typeof now === 'function' ? now() : now;
  if (value instanceof Date) return value.getTime();
  return Number.isFinite(value) ? value : Date.now();
};

async function statOrNull(file) {
  try { return await fs.stat(file); } catch { return null; }
}
async function lstatOrNull(file) {
  try { return await fs.lstat(file); } catch { return null; }
}
async function dirEntries(dir) {
  try { return await fs.readdir(dir, { withFileTypes: true }); } catch (error) { if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return []; throw error; }
}
async function pool(items, size, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(0, Math.min(size, items.length)) }, async () => {
    while (next < items.length) { const index = next++; await fn(items[index], index); }
  }));
}

async function openRead(file) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw Object.assign(new Error('Not a regular file.'), { code: 'EFTYPE' });
    return { handle, stat };
  } catch (error) { await handle.close().catch(() => {}); throw error; }
}
async function readRange(handle, position, length) {
  const buffer = Buffer.allocUnsafe(Math.max(0, length));
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (!bytesRead) break;
    filled += bytesRead;
  }
  return filled === length ? buffer : buffer.subarray(0, filled);
}
/** Whole small file (regular files only, no symlinks), or null when missing. Throws "too large" past the cap. */
async function readSmallFile(file, maxBytes) {
  let opened;
  try { opened = await openRead(file); } catch (error) { if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null; throw error; }
  try {
    if (opened.stat.size > maxBytes) throw Object.assign(new Error('The file is too large.'), { code: 'EFBIG' });
    return { text: (await readRange(opened.handle, 0, opened.stat.size)).toString('utf8'), stat: opened.stat };
  } finally { await opened.handle.close().catch(() => {}); }
}

// ---- Top-level JSON key picker: values of unwanted keys are skipped over, never parsed. ----
const WS = new Set([32, 9, 10, 13]);
function skipWs(s, i) { while (i < s.length && WS.has(s.charCodeAt(i))) i++; return i; }
function skipString(s, i) {
  for (let from = i + 1; ;) {
    const quote = s.indexOf('"', from);
    if (quote < 0) throw new SyntaxError('Unterminated string.');
    let slashes = 0;
    for (let b = quote - 1; s.charCodeAt(b) === 92; b--) slashes++;
    if (slashes % 2 === 0) return quote + 1;
    from = quote + 1;
  }
}
function skipValue(s, i) {
  const first = s[i];
  if (first === '"') return skipString(s, i);
  if (first === '{' || first === '[') {
    let depth = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '"') { i = skipString(s, i); continue; }
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') { depth--; if (depth === 0) return i + 1; }
      i++;
    }
    throw new SyntaxError('Unterminated value.');
  }
  const literal = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(s.slice(i, i + 64));
  if (!literal) throw new SyntaxError('Unexpected value.');
  return i + literal[0].length;
}
function pickTopLevel(text, keys) {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let i = skipWs(s, 0);
  if (s[i] !== '{') throw new SyntaxError('Expected an object.');
  i = skipWs(s, i + 1);
  const out = {};
  if (s[i] === '}') i++;
  else for (;;) {
    if (s[i] !== '"') throw new SyntaxError('Expected a key.');
    const keyEnd = skipString(s, i);
    const key = keyEnd - i <= 256 ? JSON.parse(s.slice(i, keyEnd)) : null;
    i = skipWs(s, keyEnd);
    if (s[i] !== ':') throw new SyntaxError('Expected a colon.');
    const valueStart = skipWs(s, i + 1);
    const valueEnd = skipValue(s, valueStart);
    if (key !== null && keys.includes(key)) out[key] = JSON.parse(s.slice(valueStart, valueEnd));
    i = skipWs(s, valueEnd);
    if (s[i] === ',') { i = skipWs(s, i + 1); continue; }
    if (s[i] === '}') { i++; break; }
    throw new SyntaxError('Expected a comma.');
  }
  if (skipWs(s, i) !== s.length) throw new SyntaxError('Unexpected trailing text.');
  return out;
}

// ---- Reading an object's keys straight out of the buffer. ----
// Values are stepped over as bytes and never decoded, so a patch body or a command's output sitting next to the file
// names on the same line is never turned into text. Only the keys become strings.
function skipBytesString(bytes, i, end) {
  for (i++; i < end;) {
    const code = bytes[i];
    if (code === 0x5c) i += 2;
    else if (code === 0x22) return i + 1;
    else i++;
  }
  return -1;
}
function skipBytesValue(bytes, i, end) {
  const code = bytes[i];
  if (code === 0x22) return skipBytesString(bytes, i, end);
  if (code === 0x7b || code === 0x5b) {
    let depth = 0;
    while (i < end) {
      const at = bytes[i];
      if (at === 0x22) { const next = skipBytesString(bytes, i, end); if (next < 0) return -1; i = next; continue; }
      if (at === 0x7b || at === 0x5b) depth++;
      else if (at === 0x7d || at === 0x5d) { depth--; if (depth === 0) return i + 1; }
      i++;
    }
    return -1;
  }
  while (i < end && bytes[i] !== 0x2c && bytes[i] !== 0x7d && bytes[i] !== 0x5d && bytes[i] > 0x20) i++;
  return i;
}
const skipBytesWs = (bytes, i, end) => { while (i < end && bytes[i] <= 0x20) i++; return i; };
/** The top-level keys of the JSON object that starts at `start`, or null when it does not end inside the line. */
function objectKeys(bytes, start, end, max) {
  let i = start;
  if (bytes[i] !== 0x7b) return null;
  i = skipBytesWs(bytes, i + 1, end);
  const keys = [];
  if (bytes[i] === 0x7d) return keys;
  for (;;) {
    if (bytes[i] !== 0x22) return null;
    const keyEnd = skipBytesString(bytes, i, end);
    if (keyEnd < 0) return null;
    if (keys.length < max && keyEnd - i <= 4100) {
      try { keys.push(JSON.parse(bytes.toString('utf8', i, keyEnd))); } catch { /* not a key this reader can use */ }
    }
    i = skipBytesWs(bytes, keyEnd, end);
    if (bytes[i] !== 0x3a) return null;
    const valueEnd = skipBytesValue(bytes, skipBytesWs(bytes, i + 1, end), end);
    if (valueEnd < 0) return null;
    i = skipBytesWs(bytes, valueEnd, end);
    if (bytes[i] === 0x2c) { i = skipBytesWs(bytes, i + 1, end); continue; }
    if (bytes[i] === 0x7d) return keys;
    return null;
  }
}
/** The files a completed FileChange item wrote, or an empty list for any other item. */
function changedPaths(buffer, from, to, limits) {
  const head = Math.min(to, from + limits.itemHeadBytes);
  const marker = buffer.indexOf(FILE_CHANGE_ITEM, from);
  if (marker < 0 || marker >= head) return [];
  const at = buffer.indexOf(CHANGES_MAP, from);
  if (at < 0 || at >= head) return [];
  const keys = objectKeys(buffer, at + CHANGES_MAP.length - 1, to, limits.editPaths);
  const out = [];
  for (const key of keys ?? []) {
    if (!absolute(key) || sealedPath(key) || secretName(path.basename(key))) continue;
    out.push(path.normalize(key));
  }
  return out;
}

// ---- Rollout tails: only lifecycle, approval-reviewer, response-item type tokens and changed file names are taken. ----
function scanLines(buffer, from, to, limits) {
  const found = { lifecycle: null, lifecycleAt: null, startedAt: null, reviewer: null, lastItem: null, lastAt: null, paths: [] };
  for (let i = from; i < to;) {
    const nl = buffer.indexOf(10, i);
    if (nl < 0 || nl >= to) break;
    if (nl > i && buffer[i] === 123) {
      const head = LINE_HEAD.exec(buffer.toString('latin1', i, Math.min(nl, i + 240)));
      if (head) {
        const at = Date.parse(head[1]);
        if (Number.isFinite(at)) found.lastAt = at;
        if (head[2] === 'event_msg' && LIFECYCLE.has(head[3])) {
          found.lifecycle = head[3];
          found.lifecycleAt = Number.isFinite(at) ? at : null;
          const started = head[3] === 'task_started' ? STARTED_AT.exec(buffer.toString('latin1', i, Math.min(nl, i + 2048))) : null;
          found.startedAt = started ? Math.round(Number(started[1]) * 1000) : null;
        } else if (head[2] === 'event_msg' && head[3] === 'item_completed') {
          for (const item of changedPaths(buffer, i, nl, limits)) found.paths.push(item);
        } else if (head[2] === 'response_item' && head[3]) {
          found.lastItem = TOOL_CALLS.has(head[3]) ? 'call' : 'other';
        } else if (head[2] === 'turn_context') {
          const reviewer = REVIEWER.exec(buffer.toString('latin1', i, Math.min(nl, i + 65536)));
          if (reviewer) found.reviewer = reviewer[1];
        }
      }
    }
    i = nl + 1;
  }
  return found;
}
// The list runs oldest to newest. A file written again takes the newest place, and the cap always drops from the old
// end, so a walk back through older lines can only fill a list that is not full yet.
function addPaths(entry, paths, max, older) {
  if (!paths.length) return;
  if (older) {
    for (let index = paths.length - 1; index >= 0; index--) if (!entry.paths.includes(paths[index])) entry.paths.unshift(paths[index]);
  } else {
    for (const item of paths) {
      const at = entry.paths.indexOf(item);
      if (at >= 0) entry.paths.splice(at, 1);
      entry.paths.push(item);
    }
  }
  if (entry.paths.length > max) entry.paths.splice(0, entry.paths.length - max);
}
function mergeForward(entry, found, max) {
  if (found.lifecycle) Object.assign(entry, { lifecycle: found.lifecycle, lifecycleAt: found.lifecycleAt, startedAt: found.startedAt });
  if (found.reviewer) entry.reviewer = found.reviewer;
  if (found.lastItem) entry.lastItem = found.lastItem;
  if (found.lastAt !== null) entry.lastAt = found.lastAt;
  addPaths(entry, found.paths, max, false);
}
function fillBackward(entry, found, max) {
  if (!entry.lifecycle && found.lifecycle) Object.assign(entry, { lifecycle: found.lifecycle, lifecycleAt: found.lifecycleAt, startedAt: found.startedAt });
  entry.reviewer ??= found.reviewer;
  entry.lastItem ??= found.lastItem;
  entry.lastAt ??= found.lastAt;
  addPaths(entry, found.paths, max, true);
}
// Walks back from `limit` in chunks, processing only lines whose start and end are both inside a chunk. A line longer than a
// chunk is skipped (lifecycle and turn-context lines are small). A long running turn can put its task_started far back.
async function scanBack(handle, entry, limit, budget, chunkBytes, chunkLimits) {
  let spent = 0;
  // Once a turn start is known, look at most one more chunk for its approval setting.
  let afterLifecycle = entry.lifecycle ? 0 : null;
  while (limit > 0 && spent < budget) {
    const start = Math.max(0, limit - chunkBytes);
    const buffer = await readRange(handle, start, limit - start);
    spent += buffer.length;
    let from = 0;
    if (start > 0) { const first = buffer.indexOf(10); from = first < 0 ? buffer.length : first + 1; }
    const to = buffer.lastIndexOf(10) + 1;
    const had = Boolean(entry.lifecycle);
    if (from < to) fillBackward(entry, scanLines(buffer, from, to, chunkLimits), chunkLimits.editPaths);
    if (start === 0) { limit = 0; break; }
    limit = from < buffer.length ? start + from : start;
    if (entry.lifecycle && (entry.lifecycle !== 'task_started' || entry.reviewer)) break;
    if (entry.lifecycle && !had) afterLifecycle = spent;
    if (afterLifecycle !== null && spent - afterLifecycle >= chunkBytes) break;
  }
  return limit === 0;
}
async function tailRollout(file, previous, backBudget, limits) {
  const { handle, stat } = await openRead(file);
  try {
    const same = previous && previous.dev === stat.dev && previous.ino === stat.ino;
    const deepEnough = previous && (previous.lifecycle || previous.reachedStart || previous.backBudget >= backBudget);
    if (same && deepEnough && stat.size === previous.size && stat.mtimeMs === previous.mtimeMs) return previous;
    if (same && deepEnough && stat.size >= previous.consumed && stat.size - previous.consumed <= limits.growBytes) {
      const entry = { ...previous, size: stat.size, mtimeMs: stat.mtimeMs, paths: previous.paths };
      const buffer = await readRange(handle, previous.consumed, stat.size - previous.consumed);
      let from = 0;
      if (!previous.aligned) { const first = buffer.indexOf(10); from = first < 0 ? buffer.length : first + 1; }
      const to = buffer.lastIndexOf(10) + 1;
      if (from < to) { mergeForward(entry, scanLines(buffer, from, to, limits), limits.editPaths); entry.consumed = previous.consumed + to; entry.aligned = true; }
      else if (to > 0) { entry.consumed = previous.consumed + to; entry.aligned = true; }
      return entry;
    }
    const start = Math.max(0, stat.size - limits.tailBytes);
    const buffer = await readRange(handle, start, stat.size - start);
    let from = 0;
    if (start > 0) { const first = buffer.indexOf(10); from = first < 0 ? buffer.length : first + 1; }
    const to = buffer.lastIndexOf(10) + 1;
    const entry = {
      dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, consumed: to > 0 ? start + to : start, aligned: to > 0 || start === 0,
      lifecycle: null, lifecycleAt: null, startedAt: null, reviewer: null, lastItem: null, lastAt: null, backBudget, reachedStart: start === 0, paths: [],
    };
    if (from < to) mergeForward(entry, scanLines(buffer, from, to, limits), limits.editPaths);
    if (start > 0 && (!entry.lifecycle || (entry.lifecycle === 'task_started' && !entry.reviewer))) {
      const limit = from < buffer.length ? start + from : start;
      entry.reachedStart = await scanBack(handle, entry, limit, backBudget, limits.chunkBytes, limits);
    }
    return entry;
  } finally { await handle.close().catch(() => {}); }
}

// ---- Processes (pid, ppid, lstart and comm only; never arguments). ----
function processList(processes) {
  if (processes instanceof Map) return [...processes.values()];
  if (Array.isArray(processes)) return processes;
  return null;
}
function codexProcesses(processes) {
  const list = processList(processes);
  if (!list) return { known: false, codexAlive: false, appRunning: false };
  let codexAlive = false;
  let appRunning = false;
  for (const proc of list) {
    const comm = typeof proc?.comm === 'string' ? proc.comm.trim() : '';
    if (CODEX_BINARY.test(comm)) codexAlive = true;
    if (CODEX_APP.test(comm)) appRunning = true;
  }
  return { known: true, codexAlive, appRunning };
}
async function loadProcesses(options, warnings) {
  // An explicit null is the caller saying its own check failed; repeating it here would spawn a second `ps` per poll.
  if (options.processes !== undefined) return options.processes;
  if (typeof options.run !== 'function') { warnings.push(WARN.processes); return null; }
  try {
    const { listProcesses } = await import('./processes.mjs');
    return await listProcesses({ run: options.run });
  } catch { warnings.push(WARN.processes); return null; }
}
async function withSnapshots(options, fn) {
  if (options.snapshots && typeof options.snapshots.query === 'function') return fn(options.snapshots);
  const { createSqliteSnapshots } = await import('./sqlite-snapshot.mjs');
  const snapshots = createSqliteSnapshots({ run: options.run });
  try { return await fn(snapshots); } finally { await Promise.resolve(snapshots.close?.()).catch(() => {}); }
}

async function findStateDb(codexDir) {
  let best = null;
  for (const entry of await dirEntries(codexDir)) {
    const match = STATE_DB.exec(entry.name);
    if (!match || !(entry.isFile() || entry.isSymbolicLink())) continue;
    const n = Number(match[1]);
    if (!best || n > best.n) best = { n, file: path.join(codexDir, entry.name) };
  }
  return best?.file ?? null;
}

/** Returns a reader that keeps change-gated caches, so a repeat read with nothing changed costs a few milliseconds. */
export function createCodexReader(deps = {}) {
  const cache = { schema: null, rows: null, files: new Map(), tails: new Map(), worktrees: new Map() };
  return {
    read: (options = {}) => readCodex(cache, { ...deps, ...options }),
    close: async () => { cache.rows = null; cache.schema = null; cache.files.clear(); cache.tails.clear(); cache.worktrees.clear(); },
  };
}

const sharedReaders = new Map();
/** One-shot read with a shared per-home cache. Never throws; problems are plain sentences in `warnings`. */
export async function readCodexSessions(options = {}) {
  const key = options.codexHome || path.join(options.homeDir || os.homedir(), '.codex');
  let reader = sharedReaders.get(key);
  if (!reader) {
    if (sharedReaders.size >= 4) sharedReaders.delete(sharedReaders.keys().next().value);
    reader = createCodexReader();
    sharedReaders.set(key, reader);
  }
  return reader.read(options);
}

// Cached by file signature; `parse` sees the text only inside this call.
async function cachedFile(cache, file, maxBytes, parse) {
  const stat = await statOrNull(file);
  if (!stat) { cache.files.delete(file); return { missing: true, value: null }; }
  const key = signature(stat);
  const hit = cache.files.get(file);
  if (hit && hit.key === key) return hit.result;
  if (stat.size > maxBytes) throw Object.assign(new Error('The file is too large.'), { code: 'EFBIG' });
  const read = await readSmallFile(file, maxBytes);
  if (!read) { cache.files.delete(file); return { missing: true, value: null }; }
  const result = { missing: false, value: parse(read.text) };
  cache.files.set(file, { key: signature(read.stat), result });
  return result;
}

function parseGlobalState(text) {
  const picked = pickTopLevel(text, ['electron-thread-read-state-v1', 'pinned-thread-ids']);
  const unread = new Set();
  const byIdentity = picked['electron-thread-read-state-v1']?.unreadByIdentity;
  if (isObject(byIdentity)) {
    for (const hosts of Object.values(byIdentity)) {
      if (!isObject(hosts)) continue;
      for (const ids of Object.values(hosts)) for (const id of listOf(ids)) if (typeof id === 'string' && UUID.test(id)) unread.add(id.toLowerCase());
    }
  }
  const pinned = new Set(listOf(picked['pinned-thread-ids']).filter(id => typeof id === 'string' && UUID.test(id)).map(id => id.toLowerCase()));
  return { unread, pinned };
}
async function readGlobalState(cache, codexDir, limits) {
  const main = path.join(codexDir, '.codex-global-state.json');
  try {
    const result = await cachedFile(cache, main, limits.globalStateBytes, parseGlobalState);
    if (result.missing) {
      const backup = await cachedFile(cache, `${main}.bak`, limits.globalStateBytes, parseGlobalState).catch(() => ({ missing: true }));
      return backup.missing ? { unread: new Set(), pinned: new Set(), ok: true } : { ...backup.value, ok: true };
    }
    return { ...result.value, ok: true };
  } catch {
    // The app replaces the file by rename; a damaged file falls back to the copy it keeps beside it.
    try {
      const backup = await cachedFile(cache, `${main}.bak`, limits.globalStateBytes, parseGlobalState);
      if (!backup.missing) return { ...backup.value, ok: true };
    } catch {}
    return { unread: new Set(), pinned: new Set(), ok: false };
  }
}
// Only the imported thread ids are taken (matched in the raw text), so titles and source paths are never decoded.
const parseImports = text => new Set([...text.matchAll(IMPORTED_ID)].map(match => match[1].toLowerCase()).filter(id => UUID.test(id)));
async function readImports(cache, codexDir, limits) {
  try {
    const result = await cachedFile(cache, path.join(codexDir, 'external_agent_session_imports.json'), limits.importsBytes, parseImports);
    return { ids: result.value ?? new Set(), ok: true };
  } catch { return { ids: new Set(), ok: false }; }
}
async function readSessionIndex(cache, codexDir, limits) {
  const file = path.join(codexDir, 'session_index.jsonl');
  const stat = await statOrNull(file);
  if (!stat) { cache.files.delete(file); return new Map(); }
  const key = signature(stat);
  const hit = cache.files.get(file);
  if (hit && hit.key === key) return hit.result;
  const names = new Map();
  let opened;
  try { opened = await openRead(file); } catch { return names; }
  try {
    const size = opened.stat.size;
    const start = Math.max(0, size - limits.sessionIndexBytes);
    let text = (await readRange(opened.handle, start, size - start)).toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    // Later lines win: the file is an append-only rename log.
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (!isObject(record) || typeof record.id !== 'string' || !UUID.test(record.id)) continue;
      const title = cleanTitle(record.thread_name);
      const id = record.id.toLowerCase();
      names.delete(id);
      if (title) names.set(id, title);
      if (names.size > limits.sessionIndexNames) names.delete(names.keys().next().value);
    }
  } finally { await opened.handle.close().catch(() => {}); }
  cache.files.set(file, { key: signature(opened.stat), result: names });
  return names;
}
async function readLocks(codexDir) {
  const locks = new Set();
  for (const entry of await dirEntries(path.join(codexDir, 'thread-writer-locks'))) {
    const match = LOCK_FILE.exec(entry.name);
    if (match && !entry.isDirectory()) locks.add(match[1].toLowerCase());
  }
  return locks;
}
// ~/.codex/worktrees/<hex>/<repo>/.git → gitdir → codex-thread.json { ownerThreadId }.
async function readWorktrees(cache, codexDir, limits) {
  const root = path.join(codexDir, 'worktrees');
  const roots = [];
  for (const group of await dirEntries(root)) {
    if (!group.isDirectory()) continue;
    for (const repo of await dirEntries(path.join(root, group.name))) {
      if (repo.isDirectory() && roots.length < limits.worktrees) roots.push(path.join(root, group.name, repo.name));
    }
  }
  const owners = new Map();
  const seen = new Set();
  await pool(roots, 4, async worktree => {
    seen.add(worktree);
    if (sealedPath(worktree)) return;
    const dotGit = path.join(worktree, '.git');
    const gitStat = await lstatOrNull(dotGit);
    if (!gitStat?.isFile()) { cache.worktrees.delete(worktree); return; }
    let hit = cache.worktrees.get(worktree);
    if (!hit || hit.gitKey !== signature(gitStat)) {
      hit = { gitKey: signature(gitStat), gitdir: null, ownerKey: null, owner: null };
      try {
        const read = await readSmallFile(dotGit, limits.smallFileBytes);
        const match = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(read?.text ?? '');
        if (match) hit.gitdir = path.resolve(worktree, match[1]);
      } catch {}
      cache.worktrees.set(worktree, hit);
    }
    if (!hit.gitdir || sealedPath(hit.gitdir)) return;
    const ownerFile = path.join(hit.gitdir, 'codex-thread.json');
    const ownerStat = await lstatOrNull(ownerFile);
    if (!ownerStat?.isFile()) { hit.owner = null; hit.ownerKey = null; return; }
    if (hit.ownerKey !== signature(ownerStat)) {
      hit.ownerKey = signature(ownerStat);
      hit.owner = null;
      try {
        const read = await readSmallFile(ownerFile, limits.smallFileBytes);
        const owner = read ? JSON.parse(read.text)?.ownerThreadId : null;
        if (typeof owner === 'string' && UUID.test(owner)) hit.owner = owner.toLowerCase();
      } catch {}
    }
    if (hit.owner && !owners.has(hit.owner)) owners.set(hit.owner, worktree);
  });
  for (const key of cache.worktrees.keys()) if (!seen.has(key)) cache.worktrees.delete(key);
  return { root, owners };
}

// ---- Thread list from a clone of the state database. ----
/** Column names from a CREATE TABLE statement: comments dropped, top-level commas split, table constraints skipped. */
function columnsFromCreate(sql) {
  const columns = new Set();
  if (typeof sql !== 'string') return columns;
  const parts = [];
  let depth = -1;
  let current = '';
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') { const nl = sql.indexOf('\n', i); i = nl < 0 ? sql.length : nl; current += ' '; continue; }
    if (c === '/' && sql[i + 1] === '*') { const close = sql.indexOf('*/', i + 2); i = close < 0 ? sql.length : close + 1; current += ' '; continue; }
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const closer = c === '[' ? ']' : c;
      let end = i + 1;
      for (;;) {
        const k = sql.indexOf(closer, end);
        if (k < 0) { end = sql.length; break; }
        if (closer !== ']' && sql[k + 1] === closer) { end = k + 2; continue; }
        end = k + 1;
        break;
      }
      if (depth >= 0) current += sql.slice(i, end);
      i = end - 1;
      continue;
    }
    if (c === '(') { depth++; if (depth === 0) continue; }
    else if (c === ')') { if (depth === 0) { parts.push(current); break; } depth--; }
    else if (c === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    if (depth >= 0) current += c;
  }
  for (const part of parts) {
    const match = /^\s*(?:"((?:[^"]|"")+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_$]*))/.exec(part);
    if (!match) continue;
    if (match[4] && CONSTRAINT_WORD.test(match[4])) continue;
    columns.add(match[1]?.replace(/""/g, '"') ?? match[2] ?? match[3] ?? match[4]);
  }
  return columns;
}
async function readSchema(snapshots, dbPath) {
  const result = await snapshots.query(dbPath, [{ name: 'schema', sql: SCHEMA_SQL }]);
  const schema = { threads: new Set(), edges: new Set() };
  for (const row of listOf(result?.schema)) {
    if (row?.name === 'threads') schema.threads = columnsFromCreate(row.sql);
    else if (row?.name === 'thread_spawn_edges') schema.edges = columnsFromCreate(row.sql);
  }
  return schema;
}
function buildStatements(schema, limits) {
  const columns = THREAD_COLUMNS.filter(column => schema.threads.has(column));
  const ms = column => schema.threads.has(column) ? column : null;
  const seconds = column => schema.threads.has(column) ? `${column} * 1000` : null;
  const order = [ms('recency_at_ms'), ms('updated_at_ms'), seconds('updated_at')].filter(Boolean);
  const where = ["COALESCE(source, '') NOT LIKE '{%'"];
  if (schema.threads.has('thread_source')) where.push(`COALESCE(thread_source, '') NOT IN (${HIDDEN_SOURCES.map(() => '?').join(', ')})`);
  const statements = [{
    name: 'threads',
    sql: `SELECT ${columns.join(', ')} FROM threads WHERE ${where.join(' AND ')} ORDER BY ${order.length ? `COALESCE(${[...order, '0'].join(', ')})` : 'rowid'} DESC LIMIT ?`,
    params: [...(schema.threads.has('thread_source') ? HIDDEN_SOURCES : []), limits.rows],
  }];
  if (schema.edges.has('parent_thread_id') && schema.edges.has('child_thread_id')) {
    statements.push({
      name: 'edges',
      sql: 'SELECT e.parent_thread_id AS parent, e.child_thread_id AS child, t.rollout_path AS rolloutPath FROM thread_spawn_edges AS e LEFT JOIN threads AS t ON t.id = e.child_thread_id LIMIT ?',
      params: [limits.edges],
    });
  }
  return statements;
}
async function readThreads(cache, options, dbPath, limits, warnings) {
  const stats = await Promise.all([dbPath, `${dbPath}-wal`].map(statOrNull));
  const key = `${dbPath}|${stats.map(signature).join('|')}`;
  if (cache.rows && cache.rows.key === key) return cache.rows.value;
  const value = await withSnapshots(options, async snapshots => {
    const schemaKey = `${dbPath}|${stats[0]?.ino ?? ''}`;
    for (;;) {
      const fresh = !cache.schema || cache.schema.key !== schemaKey;
      if (fresh) cache.schema = { key: schemaKey, value: await readSchema(snapshots, dbPath) };
      const schema = cache.schema.value;
      if (!REQUIRED_COLUMNS.every(column => schema.threads.has(column))) { cache.schema = null; warnings.push(WARN.layout); return null; }
      try {
        const result = await snapshots.query(dbPath, buildStatements(schema, limits));
        return { threads: listOf(result?.threads), edges: listOf(result?.edges) };
      } catch (error) {
        // A migration may have changed the table since the layout was cached; read the layout again once.
        cache.schema = null;
        if (fresh) throw error;
      }
    }
  });
  if (value) cache.rows = { key, value };
  return value;
}

function surfaceFor(source) {
  if (source === 'cli') return 'cli';
  if (source === 'exec') return 'background';
  return 'desktop';
}
function rolloutAllowed(file, codexDir) {
  if (!absolute(file) || !file.endsWith('.jsonl')) return false;
  const normal = path.normalize(file);
  return normal === file && (inside(normal, path.join(codexDir, 'sessions')) || inside(normal, path.join(codexDir, 'archived_sessions')));
}
function worktreeRootFor(cwd, worktreesRoot) {
  if (!absolute(cwd) || !inside(path.normalize(cwd), worktreesRoot)) return null;
  const parts = path.relative(worktreesRoot, path.normalize(cwd)).split(path.sep);
  return parts.length >= 2 && parts[0] && parts[1] && parts[0] !== '..' ? path.join(worktreesRoot, parts[0], parts[1]) : null;
}
function rank(session) {
  if (session.activity === 'needs-you' || session.activity === 'failed') return 0;
  if (session.activity === 'working') return 1;
  if (session.unread) return 2;
  if (session.activity === 'interrupted') return 3;
  if (session.live) return 4;
  return 5;
}

async function readCodex(cache, options) {
  const warnings = [];
  const homeDir = typeof options.homeDir === 'string' && options.homeDir ? options.homeDir : os.homedir();
  const codexDir = absolute(options.codexHome) ? options.codexHome : path.join(homeDir, '.codex');
  const hermesDir = path.join(homeDir, '.hermes');
  const nowMs = resolveNow(options.now);
  const recentMs = positiveMs(options.recentMs) ?? 7 * 864e5;
  const limits = { ...LIMITS };
  for (const [name, value] of Object.entries(isObject(options.limits) ? options.limits : {})) if (name in LIMITS && Number.isFinite(value) && value >= 0) limits[name] = value;
  const source = { app: 'codex', label: LABEL, available: false, running: false, detail: null };
  const done = sessions => ({ sessions, sources: [source], warnings: [...new Set(warnings)] });
  // Per thread id: what a session started from Summon reported through `notify` (core/hook-events.mjs); empty otherwise.
  const hookStates = options.hookStates instanceof Map ? options.hookStates : new Map();
  try {
    const processes = await loadProcesses(options, warnings);
    const procs = codexProcesses(processes);
    source.running = procs.codexAlive || procs.appRunning;
    const dirStat = await statOrNull(codexDir);
    if (!dirStat?.isDirectory()) {
      source.detail = 'Codex is not set up on this Mac.';
      return done([]);
    }
    const dbPath = await findStateDb(codexDir);
    if (!dbPath) {
      source.detail = 'Codex has no threads on this Mac yet.';
      return done([]);
    }
    source.available = true;

    const [threadData, globalState, imports, names, locks, worktrees] = await Promise.all([
      readThreads(cache, options, dbPath, limits, warnings).catch(() => { warnings.push(WARN.list); return null; }),
      readGlobalState(cache, codexDir, limits),
      readImports(cache, codexDir, limits),
      readSessionIndex(cache, codexDir, limits).catch(() => new Map()),
      readLocks(codexDir).catch(() => new Set()),
      readWorktrees(cache, codexDir, limits).catch(() => ({ root: path.join(codexDir, 'worktrees'), owners: new Map() })),
    ]);
    if (!globalState.ok) warnings.push(WARN.unread);
    if (!imports.ok) warnings.push(WARN.imports);
    // Without a process list a lock file is trusted as is; with one, a lock only counts while some codex process is alive.
    const loaded = id => locks.has(id) && (!procs.known || procs.codexAlive);
    if (!threadData) {
      source.detail = source.running ? 'Codex is running.'
        : !procs.known ? 'Summon could not check whether Codex is running.' : 'Codex is closed, so nothing there is running.';
      // failed: the aggregator keeps the last list that worked rather than emptying Codex's rows for one bad poll.
      return { ...done([]), failed: true };
    }

    const since = nowMs - recentMs;
    const tailSince = nowMs - Math.min(recentMs, limits.tailWindowMs);
    const candidates = [];
    for (const row of threadData.threads) {
      const id = typeof row?.id === 'string' && UUID.test(row.id) ? row.id.toLowerCase() : null;
      if (!id) continue;
      const sourceKind = typeof row.source === 'string' ? row.source : '';
      if (sourceKind.startsWith('{') || HIDDEN_SOURCES.includes(row.thread_source)) continue;
      const hasModel = typeof row.model === 'string' && row.model !== '';
      // Imported Claude sessions become Codex threads; they belong to Claude unless they were continued in Codex.
      if (!hasModel && (imports.ids.has(id) || (!imports.ok && (row.thread_source === null || row.thread_source === undefined)))) continue;
      const cwd = absolute(row.cwd) ? row.cwd : null;
      // Hermes runs its own codex app-server against the same store; its threads are already listed as Hermes sessions.
      if (cwd && row.thread_source == null && inside(path.normalize(cwd), hermesDir)) continue;
      const worktreePath = worktrees.owners.get(id) ?? worktreeRootFor(cwd, worktrees.root);
      if (sealedPath(cwd) || sealedPath(worktreePath) || sealedPath(row.rollout_path)) continue;
      const startedAt = positiveMs(row.created_at_ms) ?? (positiveMs(row.created_at) !== null ? positiveMs(row.created_at) * 1000 : null) ?? uuidTime(id);
      const dbUpdated = positiveMs(row.recency_at_ms) ?? positiveMs(row.updated_at_ms) ?? (positiveMs(row.updated_at) !== null ? positiveMs(row.updated_at) * 1000 : null);
      const live = loaded(id);
      candidates.push({
        id, row, cwd, worktreePath, startedAt, dbUpdated, live,
        surface: surfaceFor(sourceKind), unread: globalState.unread.has(id), archived: Number(row.archived) === 1,
        pinned: globalState.pinned.has(id) || Number(row.is_pinned) === 1, hasModel,
        rollout: rolloutAllowed(row.rollout_path, codexDir) ? row.rollout_path : null,
        wantsTail: live || (dbUpdated ?? startedAt ?? 0) >= tailSince,
      });
    }

    // Rollout tails: loaded threads first, then the most recently active, within the per-read cap.
    const tailTargets = candidates.filter(item => item.rollout && item.wantsTail && !(item.archived && !item.live))
      .sort((a, b) => Number(b.live) - Number(a.live) || (b.dbUpdated ?? 0) - (a.dbUpdated ?? 0)).slice(0, limits.tails);
    const tails = new Map();
    const usedTails = new Set();
    let tailErrors = 0;
    const tailOf = async (file, budget) => {
      usedTails.add(file);
      try {
        const entry = await tailRollout(file, cache.tails.get(file), budget, limits);
        cache.tails.set(file, entry);
        return entry;
      } catch (error) {
        cache.tails.delete(file);
        if (error?.code !== 'ENOENT') tailErrors++;
        return null;
      }
    };
    await pool(tailTargets, limits.tailConcurrency, async item => {
      tails.set(item.id, await tailOf(item.rollout, item.live ? limits.backBytesLive : limits.backBytesIdle));
    });

    // Helpers: locked descendants whose own current turn is still running.
    const children = new Map();
    for (const edge of threadData.edges) {
      const parent = typeof edge?.parent === 'string' ? edge.parent.toLowerCase() : null;
      const child = typeof edge?.child === 'string' && UUID.test(edge.child) ? edge.child.toLowerCase() : null;
      if (!parent || !child) continue;
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push({ id: child, rollout: rolloutAllowed(edge.rolloutPath, codexDir) ? edge.rolloutPath : null });
    }
    const helpersFor = async parentId => {
      const found = [];
      const visited = new Set([parentId]);
      let frontier = [parentId];
      for (let depth = 0; depth < limits.helperDepth && frontier.length && found.length < limits.helperChildren; depth++) {
        const next = [];
        for (const id of frontier) for (const child of children.get(id) ?? []) {
          if (visited.has(child.id)) continue;
          visited.add(child.id);
          next.push(child.id);
          if (child.rollout && loaded(child.id) && found.length < limits.helperChildren) found.push(child);
        }
        frontier = next;
      }
      let count = 0;
      await pool(found, limits.tailConcurrency, async child => {
        const entry = await tailOf(child.rollout, limits.backBytesLive);
        if (entry?.lifecycle === 'task_started') count++;
      });
      return count;
    };

    const sessions = [];
    for (const item of candidates) {
      const tail = tails.get(item.id) ?? null;
      const hook = hookStates.get(item.id) ?? null;
      // The rollout's own last moment; a report newer than it speaks for the thread until the rollout moves again.
      const own = tail?.lastAt ?? tail?.mtimeMs ?? 0;
      const reportedAt = Number.isFinite(hook?.stateAt) ? hook.stateAt : null;
      let live = item.live;
      if (hook?.state === 'ended' && reportedAt !== null && reportedAt >= own) live = false;
      let activity = live ? 'open' : 'quiet';
      let activitySince = null;
      let reason = null;
      let confidence = 'reported';
      let helpers = 0;
      if (tail?.lifecycle === 'task_started') {
        if (live) {
          activity = 'working';
          activitySince = tail.startedAt ?? tail.lifecycleAt;
          // Approval waits live only inside the app-server, so this is a guess from the rollout going quiet on a tool call.
          if (tail.reviewer === 'user' && tail.lastItem === 'call' && nowMs - tail.mtimeMs > limits.waitQuietMs) {
            activity = 'needs-you';
            reason = REASON_WAITING;
            confidence = 'inferred';
            activitySince = Math.round(tail.mtimeMs);
          }
          helpers = await helpersFor(item.id);
        } else {
          activity = 'interrupted';
          reason = REASON_INTERRUPTED;
          activitySince = tail.startedAt ?? tail.lifecycleAt;
        }
      }
      // A turn-ended report newer than the rollout tail turns a lingering started turn into open; a working report
      // older than staleWorkingMs says nothing. Codex reports only turn ends, so a report older than the rollout's
      // last line belongs to an earlier turn and cannot outvote even a guessed approval wait (Claude's hooks report
      // every transition, which is why claude.mjs may let a report win over an inferred state). Nothing reported can
      // make a thread live that its lock file does not.
      if (live && hook?.state && hook.state !== 'ended' && reportedAt !== null && reportedAt >= own
        && !(hook.state === 'working' && nowMs - reportedAt > limits.staleWorkingMs)) {
        activity = hook.state;
        reason = hook.reason ?? null;
        confidence = 'reported';
        activitySince = reportedAt;
        if (activity !== 'working') helpers = 0;
      }
      const updatedAt = Math.max(item.dbUpdated ?? 0, tail?.lastAt ?? 0, reportedAt ?? 0) || item.dbUpdated || item.startedAt || null;
      const keep = live || item.unread || activity === 'needs-you' || activity === 'working' || (updatedAt !== null && updatedAt >= since);
      if (!keep) continue;
      // Archived threads stay hidden unless a live app holds them and nothing is unread.
      if (item.archived && !(live && !item.unread)) continue;
      sessions.push({
        app: 'codex',
        surface: item.surface,
        id: item.id,
        title: cleanTitle(item.row.name, limits.titleChars) ?? names.get(item.id) ?? null,
        cwd: item.cwd,
        worktreePath: item.worktreePath,
        branch: cleanTitle(item.row.git_branch, 255),
        startedAt: item.startedAt,
        updatedAt,
        activity,
        activitySince: Number.isFinite(activitySince) ? activitySince : null,
        reason,
        unread: item.unread,
        archived: item.archived,
        pinned: item.pinned,
        live,
        confidence,
        // Summon's own fact: this thread was bound to a launch Summon started.
        origin: hook?.launch ? 'summon' : null,
        helpers,
        model: item.hasModel ? cleanTitle(item.row.model, 80) : null,
        // Files this thread wrote, newest first. Codex records no title source, so a name is left to count as the
        // app's own wording.
        titleSource: null,
        touchedPaths: tail?.paths?.length ? [...tail.paths].reverse() : null,
      });
    }
    for (const key of cache.tails.keys()) if (!usedTails.has(key)) cache.tails.delete(key);
    if (tailErrors) warnings.push(WARN.tails);

    sessions.sort((a, b) => rank(a) - rank(b) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const open = sessions.filter(session => session.live).length;
    source.detail = open ? `${plural(open, 'thread')} open.` : source.running ? 'Codex is running.'
      : !procs.known ? 'Summon could not check whether Codex is running.' : 'Codex is closed, so nothing there is running.';
    if (!procs.known && open) source.running = true;
    return done(sessions.slice(0, limits.sessions));
  } catch {
    warnings.push(WARN.failed);
    return done([]);
  }
}
