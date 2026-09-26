import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sealedPath } from './workstreams.mjs';

// Hook events: what a Claude or Codex session reports about itself through scripts/summon-hook.mjs, kept per session
// as a latest-state entry plus a bounded metadata-only event history for visual traces.
// Nothing here has a field for prompt text, transcript paths, tool input or message text, so none can be stored.
// Readers (sessions/claude.mjs, sessions/codex.mjs) take a hook state over the app's own record when that record is
// inferred or older; the ledger itself decides nothing about rows.

const VERSION = 1;
const APPS = Object.freeze(['claude', 'codex']);
const STATES = Object.freeze(['open', 'working', 'needs-you', 'failed', 'ended']);
const LIMITS = Object.freeze({
  sessionMs: 7 * 864e5, sessions: 500, launches: 100, launchUnboundMs: 24 * 3600e3, launchBoundMs: 7 * 864e5,
  fileBytes: 262144, debounceMs: 500, eventChars: 40, toolChars: 120, kindChars: 40, pathChars: 1024, idChars: 200,
  historyPerSession: 100, historyTotal: 2000, childrenPerSession: 100,
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TAG = /^[0-9a-f-]{8,64}$/;
const KIND = /^[A-Za-z0-9_:-]{1,40}$/;
const OK = 'Waiting for your OK';
const QUESTION = 'Asked you a question';
const PROBLEM = 'Stopped with a problem';
const WORKING_EVENTS = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionDenied', 'PreCompact', 'PostCompact']);
const OK_KINDS = new Set(['permission_prompt', 'worker_permission_prompt']);
const QUESTION_KINDS = new Set(['agent_needs_input', 'elicitation_dialog', 'elicitation_url_dialog']);

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const absolute = value => typeof value === 'string' && value.length > 0 && value.length <= LIMITS.pathChars && path.isAbsolute(value) && !value.includes('\0') && path.normalize(value) === value;
const cleanText = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, max) : '';
const ms = value => Number.isFinite(value) && value > 0 && value < 1e14 ? Math.round(value) : null;
const uuidOf = value => typeof value === 'string' && UUID.test(value.toLowerCase()) ? value.toLowerCase() : null;
const tagOf = value => typeof value === 'string' && TAG.test(value) ? value : null;
// Tool/event identifiers only: free-form messages or tool arguments never become trace labels.
const traceName = (value, max) => {
  const name = cleanText(value, max);
  return /^[A-Za-z][A-Za-z0-9_.:-]*$/.test(name) ? name : null;
};
const childId = value => typeof value === 'string' && value.length <= LIMITS.idChars && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value) ? value : null;
const childType = value => childId(value) && value.length <= LIMITS.toolChars ? value : null;
function pickChild(raw) {
  if (!isObject(raw) || !childId(raw.id) || !ms(raw.updatedAt)) return null;
  return { id: raw.id, type: childType(raw.type), cwd: absolute(raw.cwd) ? raw.cwd : null,
    state: STATES.includes(raw.state) ? raw.state : null, stateAt: ms(raw.stateAt),
    startedAt: ms(raw.startedAt), updatedAt: ms(raw.updatedAt), endedAt: ms(raw.endedAt) };
}
function pickTraceEvent(raw) {
  if (!isObject(raw)) return null;
  const id = uuidOf(raw.id), at = ms(raw.at), event = traceName(raw.event, LIMITS.eventChars);
  if (!id || !at || !event) return null;
  return { id, at, event, toolName: traceName(raw.toolName, LIMITS.toolChars), state: STATES.includes(raw.state) ? raw.state : null,
    ...(childId(raw.agentId) ? { agentId: raw.agentId, agentType: childType(raw.agentType) } : {}) };
}

/** The state a hook event stands for, or null when the event says nothing about the session's state. */
export function hookActivity(app, event, kind = null) {
  if (app === 'claude') {
    // A compaction restart says nothing about busy or idle: auto-compact fires mid-turn, /compact fires idle. Keep the prior state.
    if (event === 'SessionStart') return kind === 'compact' ? null : { state: 'open', reason: null };
    if (event === 'Stop') return { state: 'open', reason: null };
    if (WORKING_EVENTS.has(event)) return { state: 'working', reason: null };
    if (event === 'PermissionRequest') return { state: 'needs-you', reason: OK };
    if (event === 'Notification') {
      if (OK_KINDS.has(kind)) return { state: 'needs-you', reason: OK };
      if (QUESTION_KINDS.has(kind)) return { state: 'needs-you', reason: QUESTION };
      if (kind === 'idle_prompt') return { state: 'open', reason: null };
      return null;
    }
    if (event === 'StopFailure') return { state: 'failed', reason: PROBLEM };
    if (event === 'SessionEnd') return { state: 'ended', reason: null };
    return null;
  }
  if (app === 'codex') {
    if (event === 'agent-turn-complete' || event === 'Stop') return { state: 'open', reason: null };
    if (event === 'UserPromptSubmit') return { state: 'working', reason: null };
    if (event === 'SessionEnd') return { state: 'ended', reason: null };
    return null;
  }
  return null;
}

function emptyEntry(app, sessionId, at) {
  return { app, sessionId, launch: null, cwd: null, state: null, reason: null, stateAt: null, event: null, kind: null, toolName: null, eventAt: at, firstAt: at, events: 0 };
}

/** One stored entry, or null when the shape is wrong. Only the known fields survive. */
function pickEntry(raw) {
  if (!isObject(raw) || !APPS.includes(raw.app)) return null;
  const sessionId = uuidOf(raw.sessionId);
  if (!sessionId) return null;
  const firstAt = ms(raw.firstAt);
  const eventAt = ms(raw.eventAt) ?? firstAt;
  if (!eventAt) return null;
  return {
    app: raw.app, sessionId, launch: tagOf(raw.launch), cwd: absolute(raw.cwd) ? raw.cwd : null,
    state: STATES.includes(raw.state) ? raw.state : null, reason: cleanText(raw.reason, 120) || null, stateAt: ms(raw.stateAt),
    event: cleanText(raw.event, LIMITS.eventChars) || null, kind: typeof raw.kind === 'string' && KIND.test(raw.kind) ? raw.kind : null, toolName: cleanText(raw.toolName, LIMITS.toolChars) || null,
    eventAt, firstAt: firstAt ?? eventAt, events: Number.isSafeInteger(raw.events) && raw.events >= 0 ? raw.events : 0,
    ...(Array.isArray(raw.children) ? { children: raw.children.map(pickChild).filter(Boolean).slice(-LIMITS.childrenPerSession) } : {}),
  };
}
function pickLaunch(raw) {
  if (!isObject(raw) || !APPS.includes(raw.app)) return null;
  const at = ms(raw.at);
  if (!at) return null;
  return { app: raw.app, cwd: absolute(raw.cwd) ? raw.cwd : null, projectId: typeof raw.projectId === 'string' && raw.projectId.length <= LIMITS.idChars ? raw.projectId : null, at, sessionId: uuidOf(raw.sessionId) };
}

/**
 * The ledger behind "sessions report through hooks". record() updates the latest state and a bounded event history,
 * noteLaunch() remembers a session Summon started, forApp() hands a reader the per-session states, and the file under
 * dataDir keeps them across restarts with bounded retention.
 */
export async function createHookLedger({ dataDir, now = Date.now, limits = {} } = {}) {
  if (!absolute(dataDir)) throw new Error('Hook events need a full data folder path.');
  const limit = { ...LIMITS, ...limits };
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const filename = path.join(dataDir, 'hook-events.json');
  let sessions = new Map();
  let launches = new Map();
  const history = new Map();
  let dirty = false;
  let timer = null;
  let writing = Promise.resolve();
  let closed = false;
  let problem = null;

  async function load() {
    let text;
    try { text = await fs.readFile(filename, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    let parsed = null;
    try {
      if (Buffer.byteLength(text) > limit.fileBytes * 4) throw new Error('too large');
      parsed = JSON.parse(text);
      if (!isObject(parsed) || parsed.version !== VERSION || !isObject(parsed.sessions) || !isObject(parsed.launches)) throw new Error('unrecognized');
    } catch {
      // Keep the unreadable file for a look, and start empty: a hook state is a convenience, never a record to recover.
      const quarantine = `${filename}.corrupt-${Date.now()}-${randomUUID().slice(0, 6)}`;
      await fs.rename(filename, quarantine).catch(() => {});
      problem = `Hook events could not be read (kept as ${path.basename(quarantine)}).`;
      return;
    }
    for (const value of Object.values(parsed.sessions)) { const entry = pickEntry(value); if (entry) sessions.set(`${entry.app}:${entry.sessionId}`, entry); }
    for (const [tag, value] of Object.entries(parsed.launches)) { const launch = tagOf(tag) ? pickLaunch(value) : null; if (launch) launches.set(tag, launch); }
    for (const [key, entry] of sessions) {
      const raw = isObject(parsed.history) ? parsed.history[key] : null;
      const seen = new Set();
      const events = (Array.isArray(raw?.events) ? raw.events : []).map(pickTraceEvent).filter(event => {
        if (!event || seen.has(event.id)) return false;
        seen.add(event.id); return true;
      }).sort((a, b) => a.at - b.at);
      history.set(key, { events, truncated: raw?.truncated === true || entry.events > events.length });
    }
    prune();
  }

  function serialize() {
    return `${JSON.stringify({ version: VERSION, sessions: Object.fromEntries(sessions), launches: Object.fromEntries(launches), history: Object.fromEntries(history) }, null, 1)}\n`;
  }

  /** State and trace retention share the 7-day / 256 KiB bounds. Drop trace history before latest states. */
  function prune() {
    const at = now();
    for (const [key, entry] of sessions) {
      if (at - entry.eventAt > limit.sessionMs) sessions.delete(key);
      else if (entry.children) entry.children = entry.children.filter(child => at - child.updatedAt <= limit.sessionMs)
        .sort((a, b) => a.updatedAt - b.updatedAt).slice(-limit.childrenPerSession);
    }
    const oldestFirst = () => [...sessions.entries()].sort((a, b) => a[1].eventAt - b[1].eventAt);
    if (sessions.size > limit.sessions) for (const [key] of oldestFirst().slice(0, sessions.size - limit.sessions)) sessions.delete(key);
    for (const [tag, launch] of launches) if (at - launch.at > (launch.sessionId ? limit.launchBoundMs : limit.launchUnboundMs)) launches.delete(tag);
    if (launches.size > limit.launches) for (const [tag] of [...launches.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, launches.size - limit.launches)) launches.delete(tag);
    for (const [key, trace] of history) {
      if (!sessions.has(key)) { history.delete(key); continue; }
      const before = trace.events.length;
      trace.events = trace.events.filter(event => at - event.at <= limit.sessionMs).slice(-limit.historyPerSession);
      if (trace.events.length < before) trace.truncated = true;
    }
    const ordered = () => [...history.values()].flatMap(trace => trace.events.map(event => ({ trace, event }))).sort((a, b) => a.event.at - b.event.at);
    function dropOldest(count) {
      for (const { trace, event } of ordered().slice(0, count)) {
        trace.events = trace.events.filter(value => value !== event); trace.truncated = true;
      }
    }
    const count = [...history.values()].reduce((sum, trace) => sum + trace.events.length, 0);
    if (count > limit.historyTotal) dropOldest(count - limit.historyTotal);
    let bytes = Buffer.byteLength(serialize());
    while (bytes > limit.fileBytes && [...history.values()].some(trace => trace.events.length)) {
      dropOldest(Math.max(1, Math.ceil((bytes - limit.fileBytes) / 180)));
      bytes = Buffer.byteLength(serialize());
    }
    while (sessions.size && Buffer.byteLength(serialize()) > limit.fileBytes) {
      const key = oldestFirst()[0][0]; sessions.delete(key); history.delete(key);
    }
  }

  async function writeNow() {
    if (!dirty) return;
    dirty = false;
    const contents = serialize();
    const tmp = path.join(dataDir, `.hook-events-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(tmp, 'wx', 0o600);
      await handle.writeFile(contents); await handle.sync(); await handle.close(); handle = null;
      await fs.rename(tmp, filename);
      await fs.chmod(filename, 0o600).catch(() => {});
      const dir = await fs.open(dataDir, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    } catch (error) {
      dirty = true;
      problem = `Hook events could not be saved. ${error.message}`;
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(tmp).catch(() => {});
    }
  }
  function schedule() {
    dirty = true;
    if (closed || timer) return;
    timer = setTimeout(() => { timer = null; writing = writing.then(writeNow); }, limit.debounceMs);
    timer.unref?.();
  }
  async function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    writing = writing.then(writeNow);
    await writing;
  }

  /** Stores one hook event. Fields beyond the known ones are never read, so nothing else can land in the file. */
  function record(event) {
    if (closed) throw new Error('Summon is closing.');
    if (!isObject(event) || !APPS.includes(event.app)) throw new Error('Invalid hook app.');
    const sessionId = uuidOf(event.sessionId);
    if (!sessionId) throw new Error('Invalid hook session id.');
    const name = cleanText(event.event, limit.eventChars);
    if (!name) throw new Error('Unknown hook event.');
    const agentId = childId(event.agentId);
    if (event.agentId != null && (!agentId || event.app !== 'claude')) throw new Error('Invalid hook agentId.');
    if (event.agentType != null && (event.app !== 'claude' || !childType(event.agentType))) throw new Error('Invalid hook agentType.');
    const at = now();
    const key = `${event.app}:${sessionId}`;
    const entry = sessions.get(key) ?? emptyEntry(event.app, sessionId, at);
    const tag = tagOf(event.launch);
    if (tag) {
      const launch = launches.get(tag);
      // The first event that carries a known tag binds that launch to this session; an unknown tag names nothing.
      if (launch && launch.app === event.app && (launch.sessionId === null || launch.sessionId === sessionId)) { launch.sessionId = sessionId; entry.launch = tag; }
    }
    // Child execution may happen in a different checkout. It must not move the parent session or change its state.
    if (!agentId && absolute(event.cwd)) entry.cwd = event.cwd;
    entry.event = name;
    entry.kind = typeof event.kind === 'string' && KIND.test(event.kind) ? event.kind : null;
    entry.toolName = cleanText(event.toolName, limit.toolChars) || null;
    entry.eventAt = at;
    entry.events += 1;
    const childLifecycle = name === 'SubagentStart' || name === 'SubagentStop';
    const mapped = agentId || childLifecycle ? null : hookActivity(event.app, name, entry.kind);
    let childState = null;
    if (agentId) {
      const child = entry.children?.find(child => child.id === agentId) ?? { id: agentId, type: null, cwd: null, state: null, stateAt: null, startedAt: null, updatedAt: at, endedAt: null };
      child.type = childType(event.agentType) ?? child.type;
      if (absolute(event.cwd)) child.cwd = event.cwd;
      child.updatedAt = at;
      const state = name === 'SubagentStart' ? { state: 'working' } : name === 'SubagentStop' ? { state: 'ended' } : hookActivity(event.app, name, entry.kind);
      if (state) {
        child.state = state.state; child.stateAt = at; childState = state.state;
        if (state.state === 'ended') child.endedAt = at;
        else if (name === 'SubagentStart' || name === 'SessionStart' || state.state === 'working') { child.endedAt = null; child.startedAt ??= at; }
      }
      entry.children = [...(entry.children ?? []).filter(value => value.id !== agentId), child];
    }
    if (mapped) { entry.state = mapped.state; entry.reason = mapped.reason; entry.stateAt = at; }
    sessions.set(key, entry);
    const trace = history.get(key) ?? { events: [], truncated: entry.events > 1 };
    const reported = pickTraceEvent({ id: randomUUID(), at, event: name, toolName: entry.toolName, state: childState ?? mapped?.state ?? null, agentId, agentType: event.agentType });
    if (reported) trace.events.push(reported); else trace.truncated = true;
    history.set(key, trace);
    prune();
    schedule();
    return clone(entry);
  }

  /** Remembers a session Summon started. Claude's id is known up front; Codex binds on the first reported turn. */
  function noteLaunch({ app, tag, cwd = null, projectId = null, sessionId = null } = {}) {
    if (closed) throw new Error('Summon is closing.');
    if (!APPS.includes(app)) throw new Error('Invalid launch app.');
    if (!tagOf(tag)) throw new Error('Invalid launch tag.');
    const id = sessionId === null ? null : uuidOf(sessionId);
    if (sessionId !== null && !id) throw new Error('Invalid launch session id.');
    const at = now();
    launches.set(tag, { app, cwd: absolute(cwd) ? cwd : null, projectId: typeof projectId === 'string' && projectId.length <= limit.idChars ? projectId : null, at, sessionId: id });
    if (id) {
      const key = `${app}:${id}`;
      const entry = sessions.get(key) ?? emptyEntry(app, id, at);
      entry.launch = tag;
      if (absolute(cwd)) entry.cwd = cwd;
      sessions.set(key, entry);
    }
    prune();
    schedule();
    return clone(launches.get(tag));
  }

  function forApp(app) {
    prune();
    const out = new Map();
    for (const entry of sessions.values()) if (entry.app === app) out.set(entry.sessionId, clone(entry));
    return out;
  }
  const launch = tag => (tagOf(tag) && launches.has(tag) ? clone(launches.get(tag)) : null);
  const snapshot = () => ({ version: VERSION, sessions: clone(Object.fromEntries(sessions)), launches: clone(Object.fromEntries(launches)), problem, file: filename });
  function trace(app, sessionId) {
    prune();
    const id = uuidOf(sessionId), key = `${app}:${id}`;
    const kept = id && APPS.includes(app) ? history.get(key) : null;
    const hidden = new Set((sessions.get(key)?.children ?? []).filter(child => sealedPath(child.cwd)).map(child => child.id));
    return { events: (kept?.events ?? []).filter(event => !event.agentId || !hidden.has(event.agentId))
      .map(event => ({ ...event, at: new Date(event.at).toISOString(), confidence: 'reported' })), truncated: kept?.truncated === true };
  }

  async function close() {
    if (closed) return;
    await flush();
    closed = true;
  }

  await load();
  return { record, noteLaunch, forApp, launch, trace, flush, close, snapshot };
}
