/** Cursor agent sessions: read-only metadata from Cursor's global state.vscdb (APFS clone only, never the original, never a full copy).
 * Reads only header flags, names, times, folders and run status. Recent evidence reads at most twelve text bubbles for forty visible sessions; never richText, thinking or tool payloads. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { sealedPath } from '../workstreams.mjs';
import { recentContext } from './recent-context.mjs';

const LABEL = 'Cursor';
const DB_PARTS = ['Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb'];
const CURSOR_APP = /\/Cursor\.app\/Contents\/MacOS\/Cursor$/;
const DEFAULT_LIMITS = { sessions: 300, rows: 600, hot: 40, turns: 120, worktrees: 500, hotMs: 15 * 60000, helperMs: 15 * 60000, cacheMs: 5 * 60000, startSlackMs: 5000 };
const CLOSED = 'Cursor is closed, so nothing there is running.';
const UNKNOWN_RUNNING = 'Summon could not check whether Cursor is running.';
const UNREADABLE = "Cursor's agent list could not be read.";
const INTERRUPTED = 'Interrupted when the app closed';

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
// Titles are untrusted: drop control and bidirectional-override characters, collapse spaces, cap.
const clean = (value, max = 120) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max) : '';
const time = value => { const n = typeof value === 'bigint' ? Number(value) : value; return Number.isFinite(n) && n > 0 ? Math.round(n) : null; };
const flag = value => value === 1 || value === true || value === 1n;
const count = value => { const n = typeof value === 'bigint' ? Number(value) : value; return Number.isSafeInteger(n) && n > 0 ? n : 0; };
const whole = value => { const n = typeof value === 'bigint' ? Number(value) : value; return Number.isSafeInteger(n) && n >= 0 ? n : null; };
const absPath = value => typeof value === 'string' && value.length <= 4096 && path.isAbsolute(value) && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
const validId = value => typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value);
const nowOf = now => typeof now === 'function' ? now() : Number.isFinite(now) ? now : Date.now();
const processList = processes => processes instanceof Map ? [...processes.values()] : Array.isArray(processes) ? processes : [];
const plain = error => clean(error?.message || String(error), 200);
async function signature(file) {
  try { const s = await fs.stat(file, { bigint: true }); return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}`; }
  catch (error) { if (error?.code === 'ENOENT') return 'none'; throw error; }
}
// Fallbacks for standalone use; the aggregator normally injects both.
async function defaultProcesses(run) {
  if (typeof run !== 'function') return new Map();
  try { const { listProcesses } = await import('./processes.mjs'); return await listProcesses({ run }); } catch { return new Map(); }
}
async function defaultSnapshots(run) {
  const { createSqliteSnapshots } = await import('./sqlite-snapshot.mjs');
  return createSqliteSnapshots({ run });
}

// Every JSON read is guarded: malformed JSON makes json_extract throw, and CASE is the only guaranteed short-circuit in SQLite.
const guard = (column, expr) => `CASE WHEN json_valid(${column}) THEN ${expr} END`;
const hx = (field, col = 'value') => guard(col, `json_extract(${col}, '$.${field}')`);
const CANDIDATE = `COALESCE(isArchived, 0) = 0 AND COALESCE(isSubagent, 0) = 0 AND COALESCE(${hx('isDraft')}, 0) = 0 AND COALESCE(${hx('isBestOfNSubcomposer')}, 0) = 0
  AND (recency >= ? OR ${hx('hasUnreadMessages')} = 1 OR ${hx('hasBlockingPendingActions')} = 1 OR ${hx('hasPendingPlan')} = 1)`;
const HEADER_FIELDS = {
  name: 'name', unread: 'hasUnreadMessages', blocking: 'hasBlockingPendingActions', pendingPlan: 'hasPendingPlan', isDraft: 'isDraft',
  isBestOfN: 'isBestOfNSubcomposer', isWorktree: 'isWorktree', unfinishedRunAt: 'unfinishedRunAt', workspacePath: 'workspaceIdentifier.uri.fsPath',
  agentPath: 'agentLocation.environment.uri.fsPath', repoPath: 'trackedGitRepos[0].repoPath', activeBranch: 'activeBranch.branchName',
  createdOnBranch: 'createdOnBranch', subComposers: 'numSubComposers',
  // What this agent changed: counts Cursor keeps in the header itself. Numbers only, never file names.
  filesChanged: 'filesChangedCount', linesAdded: 'totalLinesAdded', linesRemoved: 'totalLinesRemoved',
};
const kx = expr => guard('k.value', expr);

/** SQL for one snapshot. Never selects header `value` whole, `subtitle`, or any composerData text; only the listed fields. */
export function cursorStatements({ since, hotSince, helperSince, limits = DEFAULT_LIMITS }) {
  return [
    {
      name: 'headers',
      sql: `SELECT composerId AS id, workspaceId, createdAt, lastUpdatedAt, recency, ${Object.entries(HEADER_FIELDS).map(([alias, field]) => `${hx(field)} AS ${alias}`).join(', ')}
FROM composerHeaders WHERE ${CANDIDATE} ORDER BY recency DESC LIMIT ${limits.rows}`,
      params: [since],
    },
    {
      // Run status for the few rows touched in the last 15 minutes (or marked as mid-run). One indexed key lookup per row.
      name: 'details',
      sql: `SELECT h.composerId AS id, ${kx(`json_extract(k.value, '$.status')`)} AS status, ${kx(`json_array_length(k.value, '$.generatingBubbleIds')`)} AS generating,
${kx(`json_extract(k.value, '$.gitWorktree.worktreePath')`)} AS worktreePath, ${kx(`json_extract(k.value, '$.gitWorktree.branchName')`)} AS worktreeBranch,
${kx(`json_array_length(k.value, '$.fullConversationHeadersOnly')`)} AS turns, ${kx(`json_extract(k.value, '$.modelConfig.modelName')`)} AS model
FROM (SELECT composerId FROM composerHeaders WHERE ${CANDIDATE} AND (recency >= ? OR ${hx('unfinishedRunAt')} IS NOT NULL) ORDER BY recency DESC LIMIT ${limits.hot}) h
LEFT JOIN cursorDiskKV k ON k.key = 'composerData:' || h.composerId`,
      params: [since, hotSince],
    },
    {
      // Unnamed rows are mostly empty composers: count their turns (array length only) so empty ones can be skipped.
      name: 'turns',
      sql: `SELECT h.composerId AS id, ${kx(`json_array_length(k.value, '$.fullConversationHeadersOnly')`)} AS turns
FROM (SELECT composerId FROM composerHeaders WHERE ${CANDIDATE} AND ${hx('name')} IS NULL AND recency < ? ORDER BY recency DESC LIMIT ${limits.turns}) h
LEFT JOIN cursorDiskKV k ON k.key = 'composerData:' || h.composerId`,
      params: [since, hotSince],
    },
    {
      // Live sub-agents (helpers): recent subagent headers still mid-run, counted per parent.
      name: 'helpers',
      sql: `SELECT parent, count(*) AS n FROM (SELECT ${hx('subagentInfo.parentComposerId')} AS parent, ${hx('unfinishedRunAt')} AS unfinished
FROM composerHeaders WHERE COALESCE(isSubagent, 0) = 1 AND COALESCE(isArchived, 0) = 0 AND recency >= ?) WHERE parent IS NOT NULL AND unfinished IS NOT NULL GROUP BY parent LIMIT 500`,
      params: [helperSince],
    },
    {
      name: 'worktrees',
      sql: `SELECT json_extract(e.value, '$.composerId') AS id, json_extract(e.value, '$.path') AS path, json_extract(e.value, '$.branchName') AS branch
FROM ItemTable t, json_each(CASE WHEN json_valid(t.value) THEN CASE WHEN json_type(t.value) = 'array' THEN t.value END END) e
WHERE t.key = 'worktree.metadata' AND e.type = 'object' LIMIT ${limits.worktrees}`,
      params: [],
    },
  ];
}

/** Lines and files this agent changed, as Cursor counted them; null when the header carries no counts. */
function workOf(row) {
  const added = whole(row.linesAdded), removed = whole(row.linesRemoved), files = whole(row.filesChanged);
  if (added === null && removed === null && files === null) return null;
  return { added, removed, files, area: null, scope: 'session', workstream: null, workstreamState: null };
}

function cursorProcess(processes) {
  let startedAt = null;
  let pid = null;
  for (const entry of processList(processes)) {
    if (!entry || typeof entry.comm !== 'string' || !CURSOR_APP.test(entry.comm)) continue;
    const started = time(entry.startedAt);
    if (pid === null || (started && (!startedAt || started < startedAt))) { pid = entry.pid; startedAt = started; }
  }
  // known is false when there is no process list at all: "not running" and "we could not look" are different answers.
  return { known: processes instanceof Map || Array.isArray(processes), running: pid !== null, pid, startedAt };
}

function activityFor(row, detail, { running, known = true, startedAt, hotSince, limits }) {
  const recency = time(row.recency);
  if (flag(row.blocking)) return { activity: 'needs-you', reason: 'Waiting for your OK', since: recency };
  if (flag(row.pendingPlan)) return { activity: 'needs-you', reason: 'Plan ready for review', since: recency };
  const hot = recency !== null && recency >= hotSince;
  const generating = Boolean(detail) && hot && (detail.status === 'generating' || count(detail.generating) > 0);
  const unfinished = time(row.unfinishedRunAt);
  if (unfinished === null && !generating) return { activity: 'quiet', reason: null, since: null };
  const runAt = unfinished ?? recency;
  // A run marked before this Cursor launch was cut off by the quit, even though Cursor is open again.
  const beforeLaunch = startedAt !== null && runAt !== null && runAt < startedAt - limits.startSlackMs;
  // Without a process list, the store's own mid-run mark is the best evidence: do not invent a quit that was never seen.
  if ((running || !known) && !beforeLaunch) return { activity: 'working', reason: null, since: runAt };
  return { activity: 'interrupted', reason: INTERRUPTED, since: runAt };
}

/** Pure: raw snapshot rows + process state → RawSession[]. */
export function cursorSessionsFrom(result, { now, recentMs, processes, limits = DEFAULT_LIMITS }) {
  const proc = cursorProcess(processes);
  const since = now - recentMs;
  const hotSince = now - limits.hotMs;
  const details = new Map((result?.details || []).map(row => [row.id, row]));
  const turns = new Map((result?.turns || []).map(row => [row.id, count(row.turns)]));
  for (const [id, row] of details) if (!turns.has(id)) turns.set(id, count(row.turns));
  const helpers = new Map((result?.helpers || []).map(row => [row.parent, count(row.n)]));
  const worktrees = new Map();
  for (const row of result?.worktrees || []) if (validId(row.id) && absPath(row.path) && !worktrees.has(row.id)) worktrees.set(row.id, row);
  const sessions = [];
  const seen = new Set();
  for (const row of result?.headers || []) {
    const id = row.id;
    if (!validId(id) || id.startsWith('claude-code') || seen.has(id)) continue;
    if (flag(row.isDraft) || flag(row.isBestOfN)) continue;
    const name = clean(row.name);
    const detail = details.get(id) || null;
    const state = activityFor(row, detail, { ...proc, hotSince, limits });
    const unread = flag(row.unread);
    // Unnamed composers with no turns are empty "new agent" tabs; unknown turn counts only survive with a real signal.
    if (!name) {
      const known = turns.has(id);
      if (known && turns.get(id) === 0) continue;
      if (!known && !unread && state.activity === 'quiet') continue;
    }
    const worktree = worktrees.get(id);
    const worktreePath = absPath(detail?.worktreePath) || absPath(worktree?.path);
    const cwd = worktreePath || absPath(row.workspacePath) || absPath(row.agentPath) || absPath(row.repoPath);
    if ([worktreePath, cwd, row.workspacePath, row.agentPath, row.repoPath, worktree?.path].some(sealedPath)) continue;
    const updatedAt = time(row.recency) ?? time(row.lastUpdatedAt) ?? time(row.createdAt);
    const live = proc.running && (state.activity === 'working' || state.activity === 'needs-you');
    if (!(live || unread || state.activity === 'needs-you' || (updatedAt !== null && updatedAt >= since))) continue;
    seen.add(id);
    sessions.push({
      app: 'cursor', surface: 'ide', id,
      title: name || 'New agent',
      cwd, worktreePath, branch: clean(row.activeBranch, 200) || clean(detail?.worktreeBranch, 200) || clean(worktree?.branch, 200) || clean(row.createdOnBranch, 200) || null,
      startedAt: time(row.createdAt), updatedAt,
      activity: state.activity, activitySince: state.since, reason: state.reason,
      unread, archived: false, pinned: false, live,
      confidence: 'reported',
      helpers: state.activity === 'working' ? helpers.get(id) || 0 : 0,
      model: clean(detail?.model, 80) || null,
      work: workOf(row),
      ...(result.contexts?.[id] ? { recentContext: result.contexts[id] } : {}),
    });
    if (sessions.length >= limits.sessions) break;
  }
  return sessions;
}

// Only the visible, non-sealed session ids reach this query. Indexed bubble keys and fixed offsets bound the output.
async function readRecentContexts(snapshots, dbPath, sessions) {
  const ids = sessions.slice(0, 40).map(item => item.id);
  if (!ids.length) return {};
  const bubble = field => guard('b.value', `json_extract(b.value, '$.${field}')`);
  const result = await snapshots.query(dbPath, [{ name: 'messages', sql: `WITH offsets(n) AS (VALUES ${Array.from({ length: 12 }, (_, i) => `(${i + 1})`).join(',')}),
recent AS (SELECT t.value AS id, o.n, ${guard('k.value', "json_extract(k.value, '$.fullConversationHeadersOnly[#-' || o.n || '].bubbleId')")} AS bubbleId
 FROM json_each(?) t JOIN cursorDiskKV k ON k.key = 'composerData:' || t.value CROSS JOIN offsets o)
SELECT r.id, CASE ${bubble('type')} WHEN 1 THEN 'user' WHEN 2 THEN 'assistant' END AS role,
 substr(${bubble('text')}, 1, 4000) AS text, ${bubble('createdAt')} AS at
FROM recent r JOIN cursorDiskKV b ON b.key = 'bubbleId:' || r.id || ':' || r.bubbleId
WHERE ${bubble('type')} IN (1, 2) ORDER BY r.id, r.n DESC LIMIT 480`, params: [JSON.stringify(ids)] }], { maxFullCopyBytes: 0 });
  const grouped = new Map();
  for (const item of result.messages ?? []) {
    if (!ids.includes(item.id)) continue;
    if (!grouped.has(item.id)) grouped.set(item.id, []);
    grouped.get(item.id).push(item);
  }
  return Object.fromEntries([...grouped].map(([id, messages]) => [id, recentContext(messages)]));
}

function source({ available, running, known = true, detail = null }) {
  return { app: 'cursor', label: LABEL, available, running, detail: detail ?? (!known ? UNKNOWN_RUNNING : available && !running ? CLOSED : null) };
}

/** Change-gated Cursor reader: re-queries only when state.vscdb or its -wal changed (or after cacheMs). Deriving states is cheap and runs every call. */
export function createCursorReader(deps = {}) {
  let cache = null;
  return {
    async read(options = {}) {
      const o = { ...deps, ...options };
      const homeDir = o.homeDir || os.homedir();
      const now = nowOf(o.now);
      const recentMs = Number.isFinite(o.recentMs) && o.recentMs > 0 ? o.recentMs : 7 * 864e5;
      const limits = { ...DEFAULT_LIMITS, ...(isObject(o.limits) ? o.limits : {}) };
      const warnings = [];
      let processes;
      try { processes = o.processes !== undefined ? await o.processes : await defaultProcesses(o.run); } catch { processes = new Map(); }
      const proc = cursorProcess(processes);
      const dbPath = path.join(homeDir, ...DB_PARTS);
      let sig;
      try {
        const [db, wal] = await Promise.all([signature(dbPath), signature(`${dbPath}-wal`)]);
        if (db === 'none') { cache = null; return { sessions: [], sources: [source({ available: false, running: proc.running, detail: proc.running ? null : 'Cursor is not set up on this Mac.' })], warnings }; }
        sig = `${db}|${wal}|${recentMs}|${JSON.stringify(limits)}`;
      } catch (error) {
        return { sessions: [], sources: [source({ available: false, running: proc.running, detail: UNREADABLE })], warnings: [`${UNREADABLE} ${plain(error)}`] };
      }
      if (!cache || cache.sig !== sig || now - cache.at > limits.cacheMs || now < cache.at) {
        let snapshots = o.snapshots;
        let owned = false;
        try {
          if (!snapshots) { snapshots = await defaultSnapshots(o.run); owned = true; }
          const statements = cursorStatements({ since: now - recentMs, hotSince: now - limits.hotMs, helperSince: now - limits.helperMs, limits });
          const result = await snapshots.query(dbPath, statements, { maxFullCopyBytes: 0 });
          const visible = cursorSessionsFrom(result, { now, recentMs, processes, limits });
          try { result.contexts = await readRecentContexts(snapshots, dbPath, visible); }
          catch { result.contexts = {}; /* An unfamiliar bubble layout cannot hide the session list. */ }
          cache = { sig, at: now, result };
        } catch (error) {
          cache = null;
          // failed: the aggregator keeps the last list that worked rather than emptying Cursor's rows for one bad poll.
          return { sessions: [], failed: true, sources: [source({ available: true, running: proc.running, detail: UNREADABLE })], warnings: [`${UNREADABLE} ${plain(error)}`] };
        } finally {
          if (owned) await Promise.resolve(snapshots?.close?.()).catch(() => {});
        }
      }
      const sessions = cursorSessionsFrom(cache.result, { now, recentMs, processes, limits });
      return { sessions, sources: [source({ available: true, running: proc.running, known: proc.known })], warnings };
    },
  };
}

/** One-off read without a persistent cache. Never throws. */
export async function readCursorSessions(options = {}) {
  try { return await createCursorReader().read(options); }
  catch (error) { return { sessions: [], sources: [source({ available: false, running: false, detail: UNREADABLE })], warnings: [`${UNREADABLE} ${plain(error)}`] }; }
}
