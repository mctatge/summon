/** Hermes sessions: read-only metadata from ~/.hermes/state.db (snapshot clone only) and ~/.hermes/runtime/active_sessions.json.
 * Reads bounded recent user/assistant excerpts for visible sessions; never system_prompt, last_activity_description, thinking or tool payloads. Never talks to the Hermes backend. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { sealedPath } from '../workstreams.mjs';
import { recentContext } from './recent-context.mjs';

const LABEL = 'Hermes';
const SESSION_ID = /^\d{8}_\d{6}_[0-9a-f]{6}$/;
const HERMES_APP = /\/Hermes\.app\/Contents\/MacOS\/[^/]+$/;
const DEFAULT_LIMITS = { sessions: 300, chainDepth: 50, activeBytes: 1048576, activeEntries: 200, leases: 500, startSlackMs: 2000, heartbeatMs: 3 * 60000, cacheMs: 5 * 60000 };
const CLOSED = 'Hermes is closed, so nothing there is running.';
const UNKNOWN_RUNNING = 'Summon could not check whether Hermes is running.';
const UNREADABLE = "Hermes's session list could not be read.";
const INTERRUPTED = 'Interrupted when the app closed';
const SURFACES = { desktop: 'desktop', gui: 'desktop', chat: 'desktop', cli: 'cli', tui: 'cli' };

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const clean = (value, max = 120) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max) : '';
const seconds = value => { const n = typeof value === 'bigint' ? Number(value) : value; return Number.isFinite(n) && n >= 0 ? n : null; };
const ms = value => { const n = seconds(value); return n !== null && n > 0 ? Math.round(n * 1000) : null; };
const flag = value => value === 1 || value === true || value === 1n;
const absPath = value => typeof value === 'string' && value.length <= 4096 && path.isAbsolute(value) && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
const nowOf = now => typeof now === 'function' ? now() : Number.isFinite(now) ? now : Date.now();
const processList = processes => processes instanceof Map ? [...processes.values()] : Array.isArray(processes) ? processes : [];
const plain = error => clean(error?.message || String(error), 200);
const holderPid = holder => { const match = typeof holder === 'string' ? /(?:^|:)pid=(\d{1,10})(?::|$)/.exec(holder) : null; const pid = match ? Number(match[1]) : 0; return pid > 0 ? pid : null; };
async function signature(file) {
  try { const s = await fs.stat(file, { bigint: true }); return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}`; }
  catch (error) { if (error?.code === 'ENOENT') return 'none'; throw error; }
}
async function defaultProcesses(run) {
  if (typeof run !== 'function') return new Map();
  try { const { listProcesses } = await import('./processes.mjs'); return await listProcesses({ run }); } catch { return new Map(); }
}
async function defaultSnapshots(run) {
  const { createSqliteSnapshots } = await import('./sqlite-snapshot.mjs');
  return createSqliteSnapshots({ run });
}
function processIndex(processes) {
  const byPid = new Map();
  for (const entry of processList(processes)) if (entry && Number.isSafeInteger(entry.pid)) byPid.set(entry.pid, entry);
  return byPid;
}

/** Live entries of active_sessions.json: pid alive and (no recorded start time, or it matches ps within 2 s). */
export function liveActiveSessions(json, processes, limits = DEFAULT_LIMITS) {
  const byPid = processIndex(processes);
  const entries = Array.isArray(json?.entries) ? json.entries.slice(0, limits.activeEntries) : [];
  const live = [];
  for (const entry of entries) {
    if (!isObject(entry) || typeof entry.session_id !== 'string' || !SESSION_ID.test(entry.session_id)) continue;
    const proc = Number.isSafeInteger(entry.pid) && entry.pid > 0 ? byPid.get(entry.pid) : null;
    if (!proc) continue;
    const expected = seconds(entry.process_start_time);
    if (expected !== null && Number.isFinite(proc.startedAt) && Math.abs(proc.startedAt - expected * 1000) > limits.startSlackMs) continue;
    live.push({ sessionId: entry.session_id, surface: typeof entry.surface === 'string' ? entry.surface : null, pid: entry.pid });
  }
  return live;
}

/** SQL for one snapshot. `columns` is the set of known `sessions` columns (null = assume the current Hermes schema). */
export function hermesStatements({ since, activeIds = [], columns = null, tables = null, limits = DEFAULT_LIMITS }) {
  const has = name => !columns || columns.has(name);
  const c = (alias, name, fallback = 'NULL') => has(name) ? `${alias}.${name}` : fallback;
  // Branch, delegate and tool children are not continuations (mirrors Hermes's fork check). Only a boolean leaves SQLite.
  const fork = alias => {
    const markers = has('model_config') && has('parent_session_id')
      ? `CASE WHEN json_valid(${alias}.model_config) THEN (COALESCE(json_extract(${alias}.model_config, '$._branched_from'), '') = ${alias}.parent_session_id OR COALESCE(json_extract(${alias}.model_config, '$._delegate_from'), '') = ${alias}.parent_session_id) ELSE 0 END`
      : '0';
    return `(COALESCE(${c(alias, 'source')}, '') = 'tool' OR COALESCE(${markers}, 0))`;
  };
  const updated = alias => `MAX(COALESCE(${c(alias, 'last_activity_at')}, ${alias}.started_at), ${alias}.started_at)`;
  const lastRead = c('s', 'last_read_at');
  const chainable = has('parent_session_id') && has('end_reason');
  const notContinued = chainable ? `AND NOT (s.end_reason = 'compression' AND EXISTS (SELECT 1 FROM sessions x WHERE x.parent_session_id = s.id))` : '';
  const statements = [{
    name: 'sessions',
    sql: `WITH RECURSIVE
tips AS (
  SELECT s.id, ${c('s', 'source')} AS source, ${c('s', 'title')} AS title, ${c('s', 'cwd')} AS cwd, ${c('s', 'git_repo_root')} AS git_repo_root,
    ${c('s', 'git_branch')} AS git_branch, ${c('s', 'model')} AS model, s.started_at, ${updated('s')} AS updated_at,
    ${c('s', 'archived', '0')} AS archived, ${c('s', 'pinned', '0')} AS pinned, ${lastRead} AS last_read_at, ${c('s', 'parent_session_id')} AS parent_session_id,
    ${fork('s')} AS is_fork
  FROM sessions s
  WHERE COALESCE(${c('s', 'hidden', '0')}, 0) = 0 ${notContinued}
    AND (${updated('s')} >= ?
      OR (${lastRead} IS NOT NULL AND MAX(COALESCE(${c('s', 'last_activity_at')}, 0), COALESCE(s.started_at, 0)) > ${lastRead})
      OR s.id IN (SELECT value FROM json_each(?)))
  ORDER BY updated_at DESC LIMIT ${limits.sessions}
),
chain(tip_id, id, parent_id, is_fork, depth) AS (
  SELECT id, id, parent_session_id, is_fork, 0 FROM tips
  ${chainable ? `UNION ALL
  SELECT ch.tip_id, p.id, p.parent_session_id, ${fork('p')}, ch.depth + 1
  FROM chain ch JOIN sessions p ON p.id = ch.parent_id
  WHERE ch.is_fork = 0 AND p.end_reason = 'compression' AND ch.depth < ${limits.chainDepth}` : ''}
),
roots AS (SELECT tip_id, id AS root_id, MAX(depth) AS depth FROM chain GROUP BY tip_id)
SELECT t.id, t.source, t.title, t.cwd, t.git_repo_root, t.git_branch, t.model, t.started_at, t.updated_at, t.archived, t.pinned, t.last_read_at,
  roots.root_id, ${c('r', 'title')} AS root_title, r.started_at AS root_started_at,
  (SELECT group_concat(ch.id, ',') FROM chain ch WHERE ch.tip_id = t.id) AS chain_ids
FROM tips t JOIN roots ON roots.tip_id = t.id LEFT JOIN sessions r ON r.id = roots.root_id
ORDER BY t.updated_at DESC`,
    params: [since, JSON.stringify(activeIds)],
  }];
  if (!tables || tables.has('session_turn_leases')) statements.push({ name: 'leases', sql: `SELECT conversation_id, holder, acquired_at, expires_at FROM session_turn_leases LIMIT ${limits.leases}`, params: [] });
  if (!tables || tables.has('gateway_heartbeats')) statements.push({ name: 'heartbeats', sql: 'SELECT pid, last_heartbeat FROM gateway_heartbeats ORDER BY last_heartbeat DESC LIMIT 5', params: [] });
  return statements;
}

// Schema only (never rows). pragma_table_info is not allowed by the snapshot service, so the column list comes from the CREATE TABLE text.
const SCHEMA_STATEMENT = { name: 'tables', sql: "SELECT name, CASE WHEN name = 'sessions' THEN sql END AS sql FROM sqlite_master WHERE type = 'table' LIMIT 500", params: [] };
// Everything the full query uses; with all of these present the reduced (schema-aware) query is not needed.
const FULL_COLUMNS = ['id', 'source', 'title', 'cwd', 'git_repo_root', 'git_branch', 'model', 'started_at', 'last_activity_at', 'archived', 'pinned', 'hidden', 'last_read_at', 'parent_session_id', 'end_reason', 'model_config'];
const FULL_TABLES = ['sessions', 'session_turn_leases', 'gateway_heartbeats'];
const MISSING_DETAILS = 'Some Hermes details are missing in this Hermes version.';
const UNKNOWN_FORMAT = 'This Hermes version stores sessions in a format Summon does not know.';
const CONSTRAINT = /^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN)\b/i;

/** Column names from a CREATE TABLE statement (handles quoted names and nested parentheses). */
export function columnsFromCreate(sql) {
  const columns = new Set();
  if (typeof sql !== 'string') return columns;
  const open = sql.indexOf('(');
  const close = sql.lastIndexOf(')');
  if (open < 0 || close <= open) return columns;
  const body = sql.slice(open + 1, close);
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '[') quote = ']';
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) { parts.push(body.slice(start, i)); start = i + 1; }
  }
  parts.push(body.slice(start));
  for (const part of parts) {
    const text = part.trim();
    if (!text || CONSTRAINT.test(text)) continue;
    const match = /^(?:"((?:[^"]|"")+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_$]*))/.exec(text);
    const name = match && (match[1]?.replace(/""/g, '"') ?? match[2] ?? match[3] ?? match[4]);
    if (name) columns.add(name.toLowerCase());
  }
  return columns;
}

function schemaFrom(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const tables = new Set(list.map(row => row?.name).filter(name => typeof name === 'string'));
  const columns = columnsFromCreate(list.find(row => row?.name === 'sessions')?.sql);
  if (!tables.has('sessions') || !columns.has('id') || !columns.has('started_at')) throw new Error(UNKNOWN_FORMAT);
  const complete = FULL_TABLES.every(name => tables.has(name)) && FULL_COLUMNS.every(name => columns.has(name));
  return { tables, columns, complete, key: `${[...tables].sort().join(',')}|${[...columns].sort().join(',')}` };
}

/** Pure: raw rows + live state → { sessions, running }. */
export function hermesSessionsFrom(result, { now, recentMs, processes, active = [], limits = DEFAULT_LIMITS }) {
  const byPid = processIndex(processes);
  const since = now - recentMs;
  const activeIds = new Set(active.map(entry => entry.sessionId));
  const leases = new Map();
  for (const row of result?.leases || []) {
    if (typeof row.conversation_id !== 'string') continue;
    const pid = holderPid(row.holder);
    const expired = !(seconds(row.expires_at) * 1000 > now);
    const alive = pid === null ? !expired : byPid.has(pid) && !expired;
    leases.set(row.conversation_id, { alive, acquiredAt: ms(row.acquired_at), dead: expired || (pid !== null && !byPid.has(pid)) });
  }
  const appRunning = processList(processes).some(entry => typeof entry?.comm === 'string' && HERMES_APP.test(entry.comm));
  const backendRunning = (result?.heartbeats || []).some(row => Number.isSafeInteger(row.pid) && byPid.has(row.pid) && now - (ms(row.last_heartbeat) ?? 0) <= limits.heartbeatMs);
  const running = appRunning || backendRunning || active.length > 0;
  const sessions = [];
  for (const row of result?.sessions || []) {
    const id = row.id;
    if (typeof id !== 'string' || !SESSION_ID.test(id)) continue;
    if (row.source === 'tool') continue;
    const cwd = absPath(row.cwd) || absPath(row.git_repo_root);
    if ([row.cwd, row.git_repo_root].some(sealedPath)) continue;
    const chain = typeof row.chain_ids === 'string' ? row.chain_ids.split(',').filter(member => SESSION_ID.test(member)) : [id];
    const rootId = typeof row.root_id === 'string' ? row.root_id : id;
    const lease = leases.get(rootId);
    const open = chain.some(member => activeIds.has(member));
    const updatedAt = ms(row.updated_at);
    const lastRead = seconds(row.last_read_at);
    const unread = lastRead !== null && Math.max(seconds(row.updated_at) ?? 0, seconds(row.started_at) ?? 0) > lastRead;
    let activity = 'quiet';
    let reason = null;
    let activitySince = null;
    let confidence = 'reported';
    if (lease?.alive) { activity = 'working'; activitySince = lease.acquiredAt; }
    else if (open) { activity = 'open'; }
    else if (lease?.dead) {
      // A turn lease is deleted when the turn ends and replaced by the next turn, so one left behind (expired or its process gone) means the last turn was cut off.
      activity = 'interrupted'; reason = INTERRUPTED; activitySince = lease.acquiredAt; confidence = 'inferred';
    }
    const live = activity === 'working' || open;
    const archived = flag(row.archived);
    if (archived && !(live && !unread)) continue;
    if (!(live || unread || (updatedAt !== null && updatedAt >= since))) continue;
    const surface = SURFACES[row.source] || (row.source == null ? 'desktop' : 'background');
    sessions.push({
      app: 'hermes', surface, id,
      title: clean(row.title) || clean(row.root_title) || null,
      cwd, worktreePath: null, branch: clean(row.git_branch, 200) || null,
      startedAt: ms(row.root_started_at) ?? ms(row.started_at), updatedAt,
      activity, activitySince, reason,
      unread, archived, pinned: flag(row.pinned), live,
      confidence, helpers: 0, model: clean(row.model, 80) || null,
      ...(result.contexts?.[id] ? { recentContext: result.contexts[id] } : {}),
    });
    if (sessions.length >= limits.sessions) break;
  }
  return { sessions, running };
}

async function readActive(file, limits) {
  let handle;
  try {
    // O_NONBLOCK so a pipe planted under this name returns an fd instead of waiting forever for a writer,
    // O_NOFOLLOW so a symlink cannot point this read at a file Summon must never open. The stat below is on the fd.
    handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile()) return { json: null, warning: "Hermes's open-chat list could not be read." };
    if (stat.size > limits.activeBytes) return { json: null, warning: "Hermes's open-chat list was too large to read." };
    const text = await handle.readFile('utf8');
    return { json: JSON.parse(text), warning: null };
  } catch (error) {
    if (error?.code === 'ENOENT') return { json: null, warning: null };
    return { json: null, warning: "Hermes's open-chat list could not be read." };
  } finally { await handle?.close().catch(() => {}); }
}

async function readRecentContexts(snapshots, dbPath, sessions, rows) {
  const visible = new Set(sessions.slice(0, 40).map(item => item.id));
  const targets = rows.filter(item => visible.has(item.id)).map(item => ({ id: item.id,
    chain: String(item.chain_ids ?? item.id).split(',').filter(id => SESSION_ID.test(id)).slice(0, 50) }));
  if (!targets.length) return {};
  // Each chain is queried newest-first with a hard row and character cap. Compacted continuations retain recent parent turns.
  const result = await snapshots.query(dbPath, [{ name: 'contexts', sql: `SELECT json_extract(t.value, '$.id') AS id,
 (SELECT json_group_array(json_object('role', role, 'text', text, 'at', at)) FROM
   (SELECT role, substr(content, 1, 4000) AS text, timestamp * 1000 AS at FROM messages
    WHERE session_id IN (SELECT value FROM json_each(t.value, '$.chain')) AND role IN ('user', 'assistant')
    ORDER BY timestamp DESC, id DESC LIMIT 12)) AS messages
FROM json_each(?) t LIMIT 40`, params: [JSON.stringify(targets)] }]);
  const contexts = {};
  for (const item of result.contexts ?? []) {
    if (!visible.has(item.id)) continue;
    let messages;
    try { messages = JSON.parse(item.messages).reverse(); } catch { continue; }
    for (const message of messages) {
      // Some Hermes versions store text blocks as JSON, others use a plain string.
      if (/^\s*\[/.test(message.text)) { try { message.content = JSON.parse(message.text); delete message.text; } catch { message.text = null; } }
    }
    contexts[item.id] = recentContext(messages);
  }
  return contexts;
}

function source({ available, running, known = true, detail = null }) {
  return { app: 'hermes', label: LABEL, available, running, detail: detail ?? (!known ? UNKNOWN_RUNNING : available && !running ? CLOSED : null) };
}

/** Change-gated Hermes reader: re-queries only when state.db, its -wal or active_sessions.json changed (or after cacheMs). */
export function createHermesReader(deps = {}) {
  let cache = null;
  let schema = null; // set only while this Hermes lacks something the full query uses
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
      const dbPath = path.join(homeDir, '.hermes', 'state.db');
      const activePath = path.join(homeDir, '.hermes', 'runtime', 'active_sessions.json');
      // No process list at all is "we could not look", which is not the same answer as "Hermes is closed".
      const processesKnown = processes instanceof Map || Array.isArray(processes);
      const appRunning = processList(processes).some(entry => typeof entry?.comm === 'string' && HERMES_APP.test(entry.comm));
      let sig;
      try {
        const [db, wal, act] = await Promise.all([signature(dbPath), signature(`${dbPath}-wal`), signature(activePath)]);
        if (db === 'none') { cache = null; return { sessions: [], sources: [source({ available: false, running: appRunning, detail: appRunning ? null : 'Hermes is not set up on this Mac.' })], warnings }; }
        sig = `${db}|${wal}|${act}|${recentMs}|${JSON.stringify(limits)}`;
      } catch (error) {
        return { sessions: [], sources: [source({ available: false, running: appRunning, detail: UNREADABLE })], warnings: [`${UNREADABLE} ${plain(error)}`] };
      }
      if (!cache || cache.stale || cache.sig !== sig || now - cache.at > limits.cacheMs || now < cache.at) {
        const { json, warning } = await readActive(activePath, limits);
        if (warning) warnings.push(warning);
        const activeIds = [...new Set((Array.isArray(json?.entries) ? json.entries.slice(0, limits.activeEntries) : []).map(entry => entry?.session_id).filter(id => typeof id === 'string' && SESSION_ID.test(id)))];
        let snapshots = o.snapshots;
        let owned = false;
        try {
          if (!snapshots) { snapshots = await defaultSnapshots(o.run); owned = true; }
          const since = (now - recentMs) / 1000;
          // A reduced query also re-reads the schema in the same snapshot, so a Hermes upgrade switches back to the full query.
          const runQuery = () => {
            const statements = hermesStatements({ since, activeIds, columns: schema?.columns, tables: schema?.tables, limits });
            return snapshots.query(dbPath, schema ? [...statements, SCHEMA_STATEMENT] : statements);
          };
          let result;
          try {
            result = await runQuery();
          } catch (error) {
            if (!/no such (table|column)/i.test(error?.message || '')) throw error;
            const info = await snapshots.query(dbPath, [SCHEMA_STATEMENT]);
            const next = schemaFrom(info.tables);
            if (next.complete) throw error;
            schema = next;
            result = await runQuery();
          }
          let stale = false;
          if (schema) {
            warnings.push(MISSING_DETAILS);
            const next = schemaFrom(result.tables);
            if (next.complete) { schema = null; stale = true; }
            else if (next.key !== schema.key) { schema = next; stale = true; }
          }
          const active = liveActiveSessions(json, processes, limits);
          const visible = hermesSessionsFrom(result, { now, recentMs, processes, active, limits }).sessions;
          try { result.contexts = await readRecentContexts(snapshots, dbPath, visible, result.sessions ?? []); }
          catch { result.contexts = {}; /* Older message layouts still provide the normal session list. */ }
          cache = { sig, at: now, result, json, stale, warnings: [...warnings] };
        } catch (error) {
          cache = null;
          // failed: the aggregator keeps the last list that worked rather than emptying Hermes's rows for one bad poll.
          return { sessions: [], failed: true, sources: [source({ available: true, running: appRunning, detail: UNREADABLE })], warnings: [...warnings, `${UNREADABLE} ${plain(error)}`] };
        } finally {
          if (owned) await Promise.resolve(snapshots?.close?.()).catch(() => {});
        }
      }
      const active = liveActiveSessions(cache.json, processes, limits);
      const { sessions, running } = hermesSessionsFrom(cache.result, { now, recentMs, processes, active, limits });
      return { sessions, sources: [source({ available: true, running, known: processesKnown || running })], warnings: [...new Set([...warnings, ...cache.warnings])] };
    },
  };
}

/** One-off read without a persistent cache. Never throws. */
export async function readHermesSessions(options = {}) {
  try { return await createHermesReader().read(options); }
  catch (error) { return { sessions: [], sources: [source({ available: false, running: false, detail: UNREADABLE })], warnings: [`${UNREADABLE} ${plain(error)}`] }; }
}
