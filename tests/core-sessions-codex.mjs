import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createCodexReader, readCodexSessions } from '../src/core/sessions/codex.mjs';
import { setSealedSegments } from '../src/core/workstreams.mjs';

// The sealed-folder guard is empty until configured; these fixtures seal any path segment containing 'sealed-client'.
setSealedSegments(['sealed-client']);

// Everything here is fabricated. SECRET marks text that must never come back from the reader.
const SECRET = 'SECRET-PROMPT-TEXT';
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const APP_CODEX = '/Applications/ChatGPT.app/Contents/Resources/codex';
const APP_MAIN = '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT';
const FORBIDDEN_SQL = /\b(title|preview|first_user_message)\b/i;

let serial = 0;
function uuid7(ms = Date.now()) {
  const n = ++serial;
  const h = Math.floor(ms).toString(16).padStart(12, '0');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7${n.toString(16).padStart(3, '0')}-8${(n * 7 % 4096).toString(16).padStart(3, '0')}-${n.toString(16).padStart(12, '0')}`;
}

function processes(...comms) {
  return new Map(comms.map((comm, index) => [200 + index, { pid: 200 + index, ppid: 1, startedAt: Date.now() - HOUR, lstart: 'Thu Sep 17 10:00:00 2026', comm }]));
}

function fakeSnapshots() {
  const calls = [];
  return {
    calls,
    fail: null,
    async query(dbPath, statements) {
      calls.push({ dbPath, statements: structuredClone(statements) });
      if (this.fail) throw this.fail;
      for (const statement of statements) assert.match(statement.sql, /^\s*(SELECT|WITH)\b/i, 'Only read-only statements are sent.');
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-snap-'));
      try {
        for (const suffix of ['-wal', '-shm', '']) {
          try { await fs.copyFile(`${dbPath}${suffix}`, path.join(dir, `clone.sqlite${suffix}`)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        const db = new DatabaseSync(path.join(dir, 'clone.sqlite'));
        try {
          const out = {};
          for (const statement of statements) out[statement.name] = db.prepare(statement.sql).all(...(statement.params || []));
          return out;
        } finally { db.close(); }
      } finally { await fs.rm(dir, { recursive: true, force: true }); }
    },
    close() {},
  };
}

// ---- rollout lines ----
let ordinal = 0;
const line = (at, type, payload) => `${JSON.stringify({ timestamp: new Date(at).toISOString(), ordinal: ordinal++, type, payload })}\n`;
const meta = (at, id) => line(at, 'session_meta', { id, session_id: id, timestamp: new Date(at).toISOString(), cwd: '/tmp', originator: 'Codex Desktop', base_instructions: SECRET });
const context = (at, reviewer = 'auto_review') => line(at, 'turn_context', { cwd: '/tmp', approval_policy: 'on-request', approvals_reviewer: reviewer, sandbox_policy: { type: 'read-only' }, model: 'gpt-test', effort: 'low', turn_id: 'turn', user_instructions: `${SECRET} "approvals_reviewer":"user"` });
const started = at => line(at, 'event_msg', { type: 'task_started', turn_id: 'turn', started_at: Math.floor(at / 1000), model_context_window: 1000, collaboration_mode_kind: 'default' });
const complete = at => line(at, 'event_msg', { type: 'task_complete', turn_id: 'turn', started_at: Math.floor(at / 1000) - 5, completed_at: Math.floor(at / 1000), duration_ms: 5000, time_to_first_token_ms: 10, last_agent_message: SECRET });
const aborted = at => line(at, 'event_msg', { type: 'turn_aborted', turn_id: 'turn', reason: 'interrupted', started_at: Math.floor(at / 1000) - 5, completed_at: Math.floor(at / 1000), duration_ms: 5000 });
const user = at => line(at, 'event_msg', { type: 'user_message', message: `Please fix the session list {"timestamp":"x","type":"event_msg","payload":{"type":"task_complete"}}\n{"timestamp":"y","type":"event_msg","payload":{"type":"task_complete"}}` });
const message = (at, text = 'The session list is updated') => line(at, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
const call = at => line(at, 'response_item', { type: 'function_call', name: 'exec_command', arguments: SECRET, call_id: 'call_1' });
const output = at => line(at, 'response_item', { type: 'function_call_output', call_id: 'call_1', output: SECRET });
const filler = (at, bytes) => line(at, 'response_item', { type: 'function_call_output', call_id: 'filler', output: `${SECRET} `.repeat(Math.ceil(bytes / (SECRET.length + 1))) });

const THREAD_SQL = `CREATE TABLE threads (
  id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, source TEXT NOT NULL,
  model_provider TEXT, cwd TEXT, title TEXT, sandbox_policy TEXT, approval_mode TEXT, tokens_used INTEGER DEFAULT 0, has_user_event INTEGER DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0, archived_at INTEGER, git_sha TEXT, git_branch TEXT, git_origin_url TEXT, cli_version TEXT, first_user_message TEXT,
  agent_nickname TEXT, agent_role TEXT, memory_mode TEXT, model TEXT, reasoning_effort TEXT, agent_path TEXT, created_at_ms INTEGER, updated_at_ms INTEGER,
  thread_source TEXT, preview TEXT, name TEXT, is_pinned INTEGER NOT NULL DEFAULT 0, recency_at INTEGER, recency_at_ms INTEGER, history_mode TEXT, project_id TEXT
)`;
const EDGES_SQL = 'CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL PRIMARY KEY, status TEXT NOT NULL)';

async function fixture(t, { schema = 'full' } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'summon-codex-')));
  const home = path.join(root, 'home');
  const codex = path.join(home, '.codex');
  const now = Date.now();
  const day = path.join(codex, 'sessions', '2026', '09', '17');
  await fs.mkdir(day, { recursive: true });
  await fs.mkdir(path.join(codex, 'archived_sessions'), { recursive: true });
  await fs.mkdir(path.join(codex, 'thread-writer-locks'), { recursive: true });
  await fs.writeFile(path.join(codex, 'thread-writer-locks', '.coordination.lock'), '');
  await fs.writeFile(path.join(codex, 'state_4.sqlite'), 'an older database that must be ignored');

  const db = new DatabaseSync(path.join(codex, 'state_5.sqlite'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
  if (schema === 'full') { db.exec(THREAD_SQL); db.exec(EDGES_SQL); }
  else db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, source TEXT NOT NULL, cwd TEXT, title TEXT, preview TEXT, first_user_message TEXT, archived INTEGER NOT NULL DEFAULT 0, model TEXT, git_branch TEXT)');
  const ids = {};
  const files = {};
  const rolloutFor = id => path.join(day, `rollout-2026-09-17T10-00-00-${id}.jsonl`);
  async function add(key, { updated = now - 5 * MIN, source = 'vscode', threadSource = 'user', model = 'gpt-test', name = `Thread ${key}`, cwd = '/work/project', archived = 0, rollout = [], lock = false, branch = 'main', rolloutPath, mtime } = {}) {
    const id = uuid7(updated - HOUR);
    ids[key] = id;
    const file = rolloutPath ?? rolloutFor(id);
    files[key] = file;
    if (!rolloutPath) await fs.writeFile(file, [meta(updated - HOUR, id), ...rollout].join(''));
    if (mtime) await fs.utimes(file, mtime / 1000, mtime / 1000);
    if (lock) await fs.writeFile(path.join(codex, 'thread-writer-locks', `${id}.lock`), '');
    const createdMs = updated - HOUR;
    if (schema === 'full') {
      db.prepare(`INSERT INTO threads (id, rollout_path, created_at, updated_at, source, cwd, title, preview, first_user_message, archived, model, git_branch,
        created_at_ms, updated_at_ms, recency_at_ms, thread_source, name, is_pinned) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`)
        .run(id, file, Math.floor(createdMs / 1000), Math.floor(updated / 1000), source, cwd, SECRET, SECRET, SECRET, archived, model, branch, createdMs, updated, updated, threadSource, name);
    } else {
      db.prepare('INSERT INTO threads (id, rollout_path, created_at, updated_at, source, cwd, title, preview, first_user_message, archived, model, git_branch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, file, Math.floor(createdMs / 1000), Math.floor(updated / 1000), source, cwd, SECRET, SECRET, SECRET, archived, model, branch);
    }
    return id;
  }
  const edge = (parent, child) => db.prepare("INSERT INTO thread_spawn_edges VALUES (?, ?, 'open')").run(ids[parent], ids[child]);
  const subagent = parent => JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: ids[parent], depth: 1, agent_path: '/root/x' } } });

  const worktreeRoot = path.join(codex, 'worktrees', 'abcd', 'Repo');
  const gitdir = path.join(root, 'repos', 'Repo', '.git', 'worktrees', 'abcd');
  const writer = {
    db, ids, files, add, edge, subagent, now, root, home, codex, worktreeRoot, gitdir,
    async writeGlobalState(state, { bak = state } = {}) {
      const text = value => typeof value === 'string' ? value : JSON.stringify(value);
      await fs.writeFile(path.join(codex, '.codex-global-state.json'), text(state));
      if (bak !== null) await fs.writeFile(path.join(codex, '.codex-global-state.json.bak'), text(bak));
    },
  };
  t.after(async () => { try { db.close(); } catch {} await fs.rm(root, { recursive: true, force: true }); });
  return writer;
}

// The standard set of threads, one per rule.
async function standard(t) {
  const fx = await fixture(t);
  const { add, edge, subagent, now, codex } = fx;
  const longTurn = [context(now - 13 * MIN), started(now - 12 * MIN), user(now - 12 * MIN)];
  for (let i = 0; i < 5; i++) longTurn.push(filler(now - 11 * MIN, 50 * 1024));
  longTurn.push(filler(now - 10 * MIN, 300 * 1024), message(now - MIN));
  await add('working', { name: 'Fix share links', lock: true, rollout: longTurn, updated: now - 2 * MIN });
  await add('childWorking', { source: subagent('working'), threadSource: 'subagent', name: null, lock: true, rollout: [started(now - 5 * MIN)] });
  await add('childDone', { source: subagent('working'), threadSource: 'subagent', name: null, lock: true, rollout: [started(now - 9 * MIN), complete(now - 8 * MIN)] });
  await add('grandchild', { source: subagent('childWorking'), threadSource: 'subagent', name: null, lock: true, rollout: [started(now - 4 * MIN)] });
  await add('childUnlocked', { source: subagent('working'), threadSource: 'subagent', name: null, rollout: [started(now - 4 * MIN)] });
  edge('working', 'childWorking'); edge('working', 'childDone'); edge('childWorking', 'grandchild'); edge('working', 'childUnlocked');
  await add('guardian', { source: JSON.stringify({ subagent: { other: 'guardian' } }), threadSource: 'guardian_review', lock: true, rollout: [started(now - MIN)] });
  await add('guardianPlain', { threadSource: 'guardian_review', rollout: [started(now - MIN)] });
  await add('unreadRenamed', { name: null, rollout: [started(now - 3 * HOUR), complete(now - 2 * HOUR)], updated: now - 2 * HOUR });
  await add('imported', { model: null, threadSource: null, name: null, rollout: [started(now - MIN), complete(now - MIN)], updated: now - MIN });
  await add('importedContinued', { model: 'gpt-test', threadSource: null, name: 'Continued import', rollout: [complete(now - 30 * MIN)], updated: now - 30 * MIN });
  await add('hermesNative', { threadSource: null, name: 'Started by Hermes', rollout: [complete(now - 40 * MIN)], updated: now - 40 * MIN });
  // Hermes runs its own codex app-server; its own workspace threads are listed as Hermes sessions, not twice.
  await add('hermesWorkspace', { threadSource: null, name: null, cwd: path.join(fx.home, '.hermes', 'workspaces', 'assistant'), rollout: [complete(now - 20 * MIN)], updated: now - 20 * MIN });
  await add('archivedIdle', { archived: 1, rollout: [complete(now - MIN)], updated: now - MIN });
  await add('archivedLive', { archived: 1, lock: true, rollout: [complete(now - MIN)], updated: now - MIN });
  await add('archivedLiveUnread', { archived: 1, lock: true, rollout: [complete(now - MIN)], updated: now - MIN });
  await add('interrupted', { rollout: [context(now - HOUR), started(now - HOUR), message(now - 59 * MIN)], updated: now - 59 * MIN });
  await add('abortedOpen', { lock: true, rollout: [started(now - 20 * MIN), aborted(now - 19 * MIN)], updated: now - 19 * MIN });
  await add('old', { rollout: [complete(now - 30 * DAY)], updated: now - 30 * DAY });
  await add('oldUnread', { rollout: [complete(now - 30 * DAY)], updated: now - 30 * DAY });
  await add('oldStarted', { rollout: [started(now - 30 * DAY)], updated: now - 30 * DAY });
  await add('sealed', { cwd: '/Users/someone/Archive/sealed-client/app', lock: true, rollout: [started(now - MIN)] });
  await add('waiting', { source: 'cli', lock: true, rollout: [context(now - 10 * MIN, 'user'), started(now - 10 * MIN), message(now - 9 * MIN), call(now - 3 * MIN)], mtime: now - 2 * MIN, updated: now - 3 * MIN });
  await add('waitingFresh', { source: 'exec', lock: true, rollout: [context(now - 10 * MIN, 'user'), started(now - 10 * MIN), call(now - 5 * MIN)] });
  await add('answeredCall', { lock: true, rollout: [context(now - 10 * MIN, 'user'), started(now - 10 * MIN), call(now - 5 * MIN), output(now - 5 * MIN)], mtime: now - 4 * MIN });
  await add('worktreeOwner', { cwd: '/work/elsewhere', name: 'Codex worktree job', rollout: [complete(now - 50 * MIN)], updated: now - 50 * MIN, branch: null });
  await add('worktreeCwd', { cwd: path.join(fx.worktreeRoot, 'src'), rollout: [complete(now - 50 * MIN)], updated: now - 50 * MIN });
  await add('pinned', { rollout: [complete(now - 3 * DAY)], updated: now - 3 * DAY });
  await add('outsideRollout', { lock: true, rolloutPath: path.join(fx.root, 'outside.jsonl'), updated: now - 7 * MIN });
  await fs.writeFile(path.join(fx.root, 'outside.jsonl'), started(now - MIN));
  await add('messyTitle', { name: `\u202eEvil\u0007 ${'x'.repeat(200)}`, rollout: [complete(now - 6 * MIN)], updated: now - 6 * MIN });

  await fs.writeFile(path.join(codex, 'session_index.jsonl'), [
    { id: fx.ids.unreadRenamed, thread_name: 'Old name', updated_at: '2026-09-16T10:00:00Z' },
    'not json',
    { id: fx.ids.working, thread_name: 'Index name that loses to the name column', updated_at: '2026-09-16T10:00:00Z' },
    { id: fx.ids.unreadRenamed, thread_name: 'Renamed\tthread', updated_at: '2026-09-17T10:00:00Z' },
  ].map(item => typeof item === 'string' ? item : JSON.stringify(item)).join('\n') + '\n');
  await fs.writeFile(path.join(codex, 'external_agent_session_imports.json'), JSON.stringify({
    records: [fx.ids.imported, fx.ids.importedContinued].map(id => ({ source_path: '/Users/someone/.claude/projects/x/y.jsonl', content_sha256: 'ab', imported_thread_id: id, imported_at: 1, source_modified_at: 1, connector_names: [], title: SECRET })),
    detected_connector_records: [{ source_path: '/x', connector_names: [] }],
  }));
  await fx.writeGlobalState({
    'prompt-history': [SECRET, 'quote \\" brace } bracket ] "'],
    'composer-prompt-drafts-v2': { draft: `${SECRET} \\ {"pinned-thread-ids":["${fx.ids.old}"]}` },
    'electron-thread-read-state-v1': {
      version: 1,
      unreadByIdentity: {
        first: { 'local:aaaa': [fx.ids.unreadRenamed, fx.ids.archivedLiveUnread, fx.ids.childWorking] },
        second: { 'local:bbbb': [fx.ids.oldUnread.toUpperCase(), 'not-a-uuid', 7] },
      },
      legacyMigration: { identityKey: 'first', unreadThreadIdsByHostId: { local: [fx.ids.abortedOpen] } },
    },
    'pinned-thread-ids': [fx.ids.pinned],
    'thread-descriptions-v1': { [fx.ids.working]: SECRET },
    count: -1.5e3,
    flag: true,
    nothing: null,
  });
  await fs.mkdir(fx.worktreeRoot, { recursive: true });
  await fs.mkdir(fx.gitdir, { recursive: true });
  await fs.writeFile(path.join(fx.worktreeRoot, '.git'), `gitdir: ${fx.gitdir}\n`);
  await fs.writeFile(path.join(fx.gitdir, 'codex-thread.json'), JSON.stringify({ version: 1, ownerThreadId: fx.ids.worktreeOwner }));
  return fx;
}

const byKey = (fx, result) => Object.fromEntries(Object.entries(fx.ids).map(([key, id]) => [key, result.sessions.find(session => session.id === id)]));
const liveProcesses = () => processes(APP_MAIN, APP_CODEX, '/Applications/ChatGPT.app/Contents/Resources/codex-code-mode-host', '/bin/zsh');

test('lists top-level Codex threads with states, titles, flags and worktrees, and nothing private', async t => {
  const fx = await standard(t);
  const snapshots = fakeSnapshots();
  const reader = createCodexReader({ homeDir: fx.home, snapshots });
  const result = await reader.read({ now: () => fx.now, processes: liveProcesses() });
  const s = byKey(fx, result);

  assert.deepEqual(result.warnings, []);
  const shown = Object.keys(s).filter(key => s[key]).sort();
  assert.deepEqual(shown, ['abortedOpen', 'answeredCall', 'archivedLive', 'hermesNative', 'importedContinued', 'interrupted', 'messyTitle', 'oldUnread', 'outsideRollout', 'pinned', 'unreadRenamed', 'waiting', 'waitingFresh', 'working', 'worktreeCwd', 'worktreeOwner'].sort());
  assert.equal(s.hermesWorkspace, undefined, "Hermes's own workspace threads are listed once, by the Hermes reader.");
  assert.ok(s.hermesNative, 'a thread with no thread_source and an ordinary folder is still a Codex thread');

  assert.equal(s.working.activity, 'working');
  assert.equal(s.working.activitySince, Math.floor((fx.now - 12 * MIN) / 1000) * 1000);
  assert.equal(s.working.title, 'Fix share links');
  assert.equal(s.working.helpers, 2, 'Locked descendants that are mid-turn count; finished or unlocked ones do not.');
  assert.equal(s.working.live, true);
  assert.equal(s.working.surface, 'desktop');
  assert.equal(s.working.confidence, 'reported');
  assert.equal(s.working.cwd, '/work/project');
  assert.equal(s.working.branch, 'main');
  assert.equal(s.working.model, 'gpt-test');
  assert.equal(s.working.updatedAt, fx.now - MIN, 'The last rollout line is newer than the database time.');
  assert.equal(s.working.startedAt, fx.now - 2 * MIN - HOUR);

  assert.equal(s.unreadRenamed.title, 'Renamed thread', 'The last session_index name wins when the name column is empty.');
  assert.equal(s.unreadRenamed.unread, true);
  assert.equal(s.unreadRenamed.activity, 'quiet');
  assert.equal(s.unreadRenamed.live, false);

  assert.equal(s.importedContinued.title, 'Continued import');
  assert.equal(s.hermesNative.activity, 'quiet');
  assert.equal(s.archivedLive.archived, true);
  assert.equal(s.archivedLive.activity, 'open');

  assert.equal(s.interrupted.activity, 'interrupted');
  assert.equal(s.interrupted.reason, 'Interrupted when the app closed');
  assert.equal(s.interrupted.activitySince, Math.floor((fx.now - HOUR) / 1000) * 1000);
  assert.equal(s.abortedOpen.activity, 'open');
  assert.equal(s.abortedOpen.unread, false, 'legacyMigration lists are ignored.');
  assert.equal(s.oldUnread.unread, true);
  assert.equal(s.oldUnread.activity, 'quiet', 'Old threads are not tailed.');

  assert.equal(s.waiting.activity, 'needs-you');
  assert.equal(s.waiting.reason, 'Probably waiting for your OK');
  assert.equal(s.waiting.confidence, 'inferred');
  assert.equal(s.waiting.surface, 'cli');
  assert.equal(s.waiting.activitySince, fx.now - 2 * MIN);
  assert.equal(s.waitingFresh.activity, 'working', 'A tool call less than 30 seconds old is still working.');
  assert.equal(s.waitingFresh.surface, 'background');
  assert.equal(s.answeredCall.activity, 'working', 'A tool call with its output is not a wait.');

  assert.equal(s.worktreeOwner.worktreePath, fx.worktreeRoot);
  assert.equal(s.worktreeOwner.cwd, '/work/elsewhere');
  assert.equal(s.worktreeOwner.branch, null);
  assert.equal(s.worktreeCwd.worktreePath, fx.worktreeRoot);
  assert.equal(s.working.worktreePath, null);
  assert.equal(s.pinned.pinned, true);
  assert.equal(s.working.pinned, false);
  assert.equal(s.outsideRollout.activity, 'open', 'Rollouts outside ~/.codex are never read.');
  assert.equal(s.messyTitle.title.length, 120);
  assert.match(s.messyTitle.title, /^Evil x+…$/);

  assert.equal(result.sessions[0].id, fx.ids.waiting, 'needs-you sorts first');
  assert.deepEqual(result.sources, [{ app: 'codex', label: 'Codex', available: true, running: true, detail: '7 threads open.' }]);
  for (const session of result.sessions) {
    assert.deepEqual(Object.keys(session).filter(key => key !== 'recentContext').sort(), ['activity', 'activitySince', 'app', 'archived', 'branch', 'children', 'confidence', 'cwd', 'helpers', 'id', 'live', 'model', 'origin', 'pinned', 'reason', 'startedAt', 'surface', 'title', 'titleSource', 'touchedPaths', 'unread', 'updatedAt', 'worktreePath'].sort());
    assert.equal(session.app, 'codex');
  }
  const text = JSON.stringify(result);
  assert.ok(!text.includes(SECRET), 'No instructions, draft, metadata or tool output leaves the reader.');
  assert.ok(!text.includes('Old name'));
  assert.ok(!text.includes('\u202e'));
  for (const { statements } of snapshots.calls) for (const statement of statements) assert.doesNotMatch(statement.sql, FORBIDDEN_SQL);
  assert.ok(snapshots.calls.every(entry => entry.dbPath === path.join(fx.codex, 'state_5.sqlite')), 'The highest-numbered state database is used.');
});

test('repeat reads reuse the snapshot until the database changes, and rollout growth is read incrementally', async t => {
  const fx = await standard(t);
  const snapshots = fakeSnapshots();
  const reader = createCodexReader({ homeDir: fx.home, snapshots });
  const options = { now: () => fx.now, processes: liveProcesses() };
  const first = await reader.read(options);
  assert.equal(snapshots.calls.length, 2, 'Layout, then threads.');
  const began = performance.now();
  const second = await reader.read(options);
  const elapsed = performance.now() - began;
  assert.equal(snapshots.calls.length, 2, 'Nothing changed, so no new snapshot.');
  assert.deepEqual(second, first);
  assert.ok(elapsed < 1000, `A repeat read should be cheap (took ${elapsed.toFixed(1)} ms).`);

  await fs.appendFile(fx.files.working, complete(fx.now));
  const third = await reader.read(options);
  assert.equal(snapshots.calls.length, 2);
  assert.equal(byKey(fx, third).working.activity, 'open', 'The finished turn is picked up from the appended lines.');
  assert.equal(byKey(fx, third).working.helpers, 0);

  await fs.appendFile(fx.files.working, context(fx.now, 'auto_review') + started(fx.now + 1000));
  assert.equal(byKey(fx, await reader.read(options)).working.activity, 'working');

  // A line still being written is ignored until its newline lands.
  const partial = complete(fx.now + 2000);
  await fs.appendFile(fx.files.working, partial.slice(0, 40));
  assert.equal(byKey(fx, await reader.read(options)).working.activity, 'working');
  await fs.appendFile(fx.files.working, partial.slice(40));
  assert.equal(byKey(fx, await reader.read(options)).working.activity, 'open');

  // A rewritten file (new inode) is scanned from scratch.
  const replacement = `${fx.files.working}.tmp`;
  await fs.writeFile(replacement, [started(fx.now + 3000)].join(''));
  await fs.rename(replacement, fx.files.working);
  assert.equal(byKey(fx, await reader.read(options)).working.activity, 'working');

  await fx.add('fresh', { name: 'Brand new', rollout: [complete(fx.now)], updated: fx.now });
  const fourth = await reader.read(options);
  assert.equal(snapshots.calls.length, 3, 'A write to the WAL takes a new snapshot.');
  assert.equal(byKey(fx, fourth).fresh.title, 'Brand new');

  await fs.rm(path.join(fx.codex, 'thread-writer-locks', `${fx.ids.abortedOpen}.lock`));
  const fifth = await reader.read(options);
  assert.equal(byKey(fx, fifth).abortedOpen.live, false);
  assert.equal(byKey(fx, fifth).abortedOpen.activity, 'quiet');
  await reader.close();
});

test('Codex children retain explicit nested relationships and ended turns without claiming work completion', async t => {
  const fx = await standard(t);
  const reader = createCodexReader({ homeDir: fx.home, snapshots: fakeSnapshots() });
  const options = { now: fx.now, processes: liveProcesses() };
  let parent = byKey(fx, await reader.read(options)).working;
  const children = Object.fromEntries(parent.children.map(child => [child.id, child]));
  assert.equal(parent.children.length, 4, 'Recent unlocked and ended children remain visible, as well as live helpers.');
  assert.deepEqual(children[fx.ids.childWorking], {
    key: `codex:desktop:${fx.ids.childWorking}`, id: fx.ids.childWorking,
    parentSessionKey: `codex:desktop:${fx.ids.working}`, provider: 'codex', label: 'x',
    cwd: '/work/project', worktreePath: null,
    activity: 'working', confidence: 'reported', startedAt: new Date(fx.now - 5 * MIN - HOUR).toISOString(),
    updatedAt: children[fx.ids.childWorking].updatedAt, endedAt: null,
  });
  assert.equal(children[fx.ids.grandchild].parentSessionKey, children[fx.ids.childWorking].key);
  assert.equal(children[fx.ids.childDone].endedAt, new Date(fx.now - 8 * MIN).toISOString());
  assert.equal(children[fx.ids.childDone].activity, 'open');
  assert.equal(children[fx.ids.childUnlocked].activity, 'unknown', 'A stopped writer is not proof of failure or completion.');
  assert.equal(children[fx.ids.childUnlocked].endedAt, null);
  assert.ok(parent.children.every(child => Number.isFinite(Date.parse(child.updatedAt))));
  assert.doesNotMatch(JSON.stringify(parent.children), /SECRET|rollout_path|recentContext|task_done/);

  await fs.appendFile(fx.files.childDone, started(fx.now));
  parent = byKey(fx, await reader.read(options)).working;
  assert.equal(parent.children.find(child => child.id === fx.ids.childDone).endedAt, null, 'A new turn clears the previous observed turn end.');
  assert.equal(parent.children.find(child => child.id === fx.ids.childDone).activity, 'working');

  await fs.appendFile(fx.files.childDone, aborted(fx.now + 1000));
  parent = byKey(fx, await reader.read({ ...options, now: fx.now + 1000 })).working;
  assert.equal(parent.children.find(child => child.id === fx.ids.childDone).activity, 'interrupted');
  assert.equal(parent.children.find(child => child.id === fx.ids.childDone).endedAt, new Date(fx.now + 1000).toISOString());

  await fs.appendFile(fx.files.working, complete(fx.now + 2000));
  parent = byKey(fx, await reader.read({ ...options, now: fx.now + 2000 })).working;
  assert.equal(parent.children.length, 4, 'The parent ending its turn does not erase its delegation history.');
  assert.equal(parent.helpers, 0);
});

test('Codex source metadata supplies parentage without an edge table and never matches by title or folder', async t => {
  const fx = await fixture(t, { schema: 'old' });
  await fx.add('parent', { source: 'cli', lock: true, rollout: [started(fx.now - MIN)] });
  const source = JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: fx.ids.parent, agent_path: '/root/check\u202enames\u0007', depth: 1 } } });
  await fx.add('child', { source, lock: true, rollout: [started(fx.now - MIN)] });
  await fx.add('sameFolderAndTitle', { name: 'Thread child', cwd: '/work/project', lock: true, rollout: [started(fx.now - MIN)] });
  await fx.add('noParent', { source: JSON.stringify({ subagent: { thread_spawn: { agent_path: '/root/check' } } }), lock: true, rollout: [started(fx.now - MIN)] });
  const result = await readCodexSessions({ homeDir: fx.home, snapshots: fakeSnapshots(), now: fx.now, processes: liveProcesses() });
  const parent = byKey(fx, result).parent;
  assert.deepEqual(parent.children.map(child => child.id), [fx.ids.child]);
  assert.equal(parent.children[0].parentSessionKey, `codex:cli:${fx.ids.parent}`);
  assert.equal(parent.children[0].label, 'check names');
  assert.deepEqual(byKey(fx, result).sameFolderAndTitle.children, []);
  assert.ok(!result.sessions.some(session => session.id === fx.ids.child), 'Children remain nested instead of duplicating top-level sessions.');
});

test('Codex child lifecycle becomes unknown when stale, missing or unreadable, and accepts fresh explicit reports', async t => {
  const fx = await fixture(t);
  await fx.add('parent', { lock: true, rollout: [started(fx.now - MIN)] });
  await fx.add('stale', { source: fx.subagent('parent'), threadSource: 'subagent', lock: true, updated: fx.now - HOUR, rollout: [started(fx.now - HOUR)], mtime: fx.now - HOUR });
  await fx.add('missing', { source: fx.subagent('parent'), threadSource: 'subagent', lock: true, rolloutPath: path.join(fx.codex, 'sessions', 'missing.jsonl') });
  await fx.add('waiting', { source: fx.subagent('parent'), threadSource: 'subagent', lock: true, rollout: [context(fx.now - 5 * MIN, 'user'), started(fx.now - 5 * MIN), call(fx.now - MIN)], mtime: fx.now - MIN });
  const reader = createCodexReader({ homeDir: fx.home, snapshots: fakeSnapshots() });
  const options = { now: fx.now, processes: liveProcesses() };
  const get = result => Object.fromEntries(byKey(fx, result).parent.children.map(child => [child.id, child]));
  let child = get(await reader.read(options));
  assert.deepEqual([child[fx.ids.stale].activity, child[fx.ids.stale].confidence, child[fx.ids.stale].endedAt], ['unknown', 'inferred', null]);
  assert.equal(child[fx.ids.missing].activity, 'unknown');
  assert.deepEqual([child[fx.ids.waiting].activity, child[fx.ids.waiting].confidence], ['needs-you', 'inferred']);

  child = get(await reader.read({ ...options, hookStates: new Map([[fx.ids.stale, { state: 'working', stateAt: fx.now }]]) }));
  assert.deepEqual([child[fx.ids.stale].activity, child[fx.ids.stale].confidence, child[fx.ids.stale].endedAt], ['working', 'reported', null]);
  child = get(await reader.read({ ...options, hookStates: new Map([[fx.ids.stale, { state: 'ended', stateAt: fx.now }]]) }));
  assert.deepEqual([child[fx.ids.stale].activity, child[fx.ids.stale].endedAt], ['quiet', new Date(fx.now).toISOString()]);
  child = get(await reader.read({ ...options, hookStates: new Map([[fx.ids.stale, { state: 'open', event: 'agent-turn-complete', stateAt: fx.now }]]) }));
  assert.deepEqual([child[fx.ids.stale].activity, child[fx.ids.stale].endedAt], ['open', new Date(fx.now).toISOString()]);
});

test('Codex children suppress private paths, conflicted parents and descendants behind private children', async t => {
  const fx = await fixture(t);
  await fx.add('parent', { rollout: [complete(fx.now - MIN)] });
  await fx.add('otherParent', { rollout: [complete(fx.now - MIN)] });
  await fx.add('cwdPrivate', { source: fx.subagent('parent'), threadSource: 'subagent', cwd: '/work/sealed-client/project', lock: true, rollout: [started(fx.now - MIN)] });
  await fx.add('belowPrivate', { source: fx.subagent('cwdPrivate'), threadSource: 'subagent', lock: true, rollout: [started(fx.now - MIN)] });
  await fx.add('rolloutPrivate', { source: fx.subagent('parent'), threadSource: 'subagent', rolloutPath: path.join(fx.codex, 'sessions', 'sealed-client', 'private.jsonl') });
  await fx.add('conflict', { source: fx.subagent('parent'), threadSource: 'subagent', lock: true, rollout: [started(fx.now - MIN)] });
  fx.edge('otherParent', 'conflict');
  await fx.add('okay', { source: fx.subagent('parent'), threadSource: 'subagent', lock: true, rollout: [started(fx.now - MIN)] });
  const result = await readCodexSessions({ homeDir: fx.home, snapshots: fakeSnapshots(), now: fx.now, processes: liveProcesses() });
  assert.deepEqual(byKey(fx, result).parent.children.map(child => child.id), [fx.ids.okay]);
  assert.deepEqual(byKey(fx, result).otherParent.children, []);
  for (const key of ['cwdPrivate', 'belowPrivate', 'rolloutPrivate', 'conflict']) assert.ok(!JSON.stringify(result).includes(fx.ids[key]));
});

test('Codex child traversal and tail checks are bounded without removing observed relationships', async t => {
  const fx = await standard(t);
  const reader = createCodexReader({ homeDir: fx.home, snapshots: fakeSnapshots() });
  const options = { now: fx.now, processes: liveProcesses() };
  let parent = byKey(fx, await reader.read({ ...options, limits: { helperDepth: 1, helperChildren: 2 } })).working;
  assert.equal(parent.children.length, 2);
  assert.ok(parent.children.every(child => child.parentSessionKey === `codex:desktop:${fx.ids.working}`));
  parent = byKey(fx, await reader.read({ ...options, limits: { tails: 0 } })).working;
  assert.equal(parent.children.length, 4);
  assert.ok(parent.children.every(child => child.activity === 'unknown' && child.endedAt === null));
});

test('Codex child tails skip conversation parsing and backfill while parent context remains available', async t => {
  const fx = await fixture(t);
  const childText = 'PRIVATE-CHILD-CONVERSATION-MARKER';
  await fx.add('parent', { rollout: [user(fx.now - MIN), message(fx.now - MIN), complete(fx.now - MIN)] });
  await fx.add('child', { source: fx.subagent('parent'), threadSource: 'subagent', lock: true, rollout: [
    line(fx.now - 5 * MIN, 'event_msg', { type: 'user_message', message: childText.repeat(10000) }),
    filler(fx.now - 4 * MIN, 520 * 1024), message(fx.now - MIN, childText), complete(fx.now - MIN),
  ] });
  let childBytes = 0;
  let childConversationsParsed = 0;
  const open = fs.open;
  const parse = JSON.parse;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args);
    if (args[0] === fx.files.child) {
      const read = handle.read.bind(handle);
      t.mock.method(handle, 'read', async (...readArgs) => {
        const result = await read(...readArgs);
        childBytes += result.bytesRead;
        return result;
      });
    }
    return handle;
  });
  t.mock.method(JSON, 'parse', (text, ...args) => {
    if (typeof text === 'string' && text.includes(childText)) childConversationsParsed++;
    return parse(text, ...args);
  });
  const reader = createCodexReader({ homeDir: fx.home, snapshots: fakeSnapshots(), now: fx.now, processes: liveProcesses() });
  const cold = byKey(fx, await reader.read()).parent;
  assert.equal(cold.children[0].activity, 'open');
  assert.equal(cold.children[0].endedAt, new Date(fx.now - MIN).toISOString());
  assert.equal(childBytes, 64 * 1024, 'A settled child lifecycle needs only the tail, even with a huge earlier prompt.');
  assert.equal(childConversationsParsed, 0, 'Child assistant messages are never decoded into retained context.');
  assert.ok(cold.recentContext.messages.some(row => row.role === 'user'), 'Parent context parsing is unchanged.');
  assert.doesNotMatch(JSON.stringify(cold.children), /PRIVATE-CHILD|recentContext/);
  await reader.read();
  assert.equal(childBytes, 64 * 1024, 'The metadata-only cache does not retry missing conversational evidence.');

  const appended = context(fx.now) + started(fx.now)
    + line(fx.now, 'event_msg', { type: 'user_message', message: childText }) + message(fx.now, childText);
  await fs.appendFile(fx.files.child, appended);
  const warm = byKey(fx, await reader.read()).parent;
  assert.equal(warm.children[0].activity, 'working');
  assert.equal(warm.children[0].endedAt, null);
  assert.equal(childConversationsParsed, 0, 'Incremental child user and assistant events are also never decoded.');
  assert.equal(childBytes, 64 * 1024 + Buffer.byteLength(appended));
  assert.deepEqual(warm.recentContext, cold.recentContext);
});

test('without a live codex process, locks do not count and started turns read as interrupted', async t => {
  const fx = await standard(t);
  const result = await createCodexReader({ homeDir: fx.home, snapshots: fakeSnapshots() }).read({ now: () => fx.now, processes: processes('/Applications/ChatGPT.app/Contents/Resources/codex-code-mode-host', '/usr/local/bin/codexx') });
  const s = byKey(fx, result);
  assert.equal(s.working.activity, 'interrupted');
  assert.equal(s.working.live, false);
  assert.equal(s.working.helpers, 0);
  assert.equal(s.abortedOpen.activity, 'quiet');
  assert.equal(s.waiting.activity, 'interrupted');
  assert.equal(s.archivedLive, undefined, 'Archived threads need a live app to show.');
  assert.deepEqual(result.sources[0], { app: 'codex', label: 'Codex', available: true, running: false, detail: 'Codex is closed, so nothing there is running.' });
  assert.ok(result.sessions.every(session => !session.live));
});

test('a codex CLI binary counts as running; without any process list the lock files are trusted', async t => {
  const fx = await standard(t);
  const cli = await createCodexReader({ homeDir: fx.home, snapshots: fakeSnapshots() }).read({ now: () => fx.now, processes: processes('/opt/homebrew/bin/codex') });
  assert.equal(byKey(fx, cli).working.activity, 'working');
  assert.equal(cli.sources[0].running, true);
  const unknown = await createCodexReader({ homeDir: fx.home, snapshots: fakeSnapshots() }).read({ now: () => fx.now });
  assert.equal(byKey(fx, unknown).working.activity, 'working');
  assert.deepEqual(unknown.warnings, ['Summon could not check which apps are running, so open Codex threads may be out of date.']);
  assert.equal(unknown.sources[0].running, true);
});

test('missing Codex home or database is reported without reading anything', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'summon-codex-empty-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const snapshots = fakeSnapshots();
  const none = await readCodexSessions({ homeDir: root, snapshots, processes: processes() });
  assert.deepEqual(none, { sessions: [], sources: [{ app: 'codex', label: 'Codex', available: false, running: false, detail: 'Codex is not set up on this Mac.' }], warnings: [] });
  await fs.mkdir(path.join(root, '.codex'));
  const empty = await readCodexSessions({ homeDir: root, snapshots, processes: processes(APP_MAIN) });
  assert.deepEqual(empty.sources[0], { app: 'codex', label: 'Codex', available: false, running: true, detail: 'Codex has no threads on this Mac yet.' });
  assert.equal(snapshots.calls.length, 0);
});

test('a failing snapshot becomes a warning, never an exception', async t => {
  const fx = await standard(t);
  const snapshots = fakeSnapshots();
  snapshots.fail = new Error('Could not take a safe snapshot of state_5.sqlite.');
  const result = await createCodexReader({ homeDir: fx.home, snapshots }).read({ now: () => fx.now, processes: liveProcesses() });
  assert.deepEqual(result.sessions, []);
  assert.deepEqual(result.warnings, ["Codex's thread list could not be read."]);
  assert.equal(result.sources[0].available, true);
  assert.equal(result.sources[0].detail, 'Codex is running.');

  const broken = await createCodexReader({ homeDir: fx.home, snapshots: { query: async () => { throw new TypeError('boom'); } } }).read({ now: 'not a time', processes: 'not a map', limits: { sessions: 'x' } });
  assert.deepEqual(broken.sessions, []);
  assert.ok(broken.warnings.includes("Codex's thread list could not be read."));
});

test('a damaged global state falls back to the .bak copy, then to no unread marks with a warning', async t => {
  const fx = await standard(t);
  const good = await fs.readFile(path.join(fx.codex, '.codex-global-state.json'), 'utf8');
  await fx.writeGlobalState('{"electron-thread-read-state-v1": {"unreadByIdentity": ', { bak: good });
  const reader = createCodexReader({ homeDir: fx.home, snapshots: fakeSnapshots() });
  const fromBak = await reader.read({ now: () => fx.now, processes: liveProcesses() });
  assert.deepEqual(fromBak.warnings, []);
  assert.equal(byKey(fx, fromBak).unreadRenamed.unread, true);
  assert.equal(byKey(fx, fromBak).pinned.pinned, true);

  await fx.writeGlobalState('{"a": 1} trailing', { bak: '[]' });
  const neither = await reader.read({ now: () => fx.now, processes: liveProcesses() });
  assert.deepEqual(neither.warnings, ["Codex's unread marks could not be read."]);
  assert.ok(neither.sessions.every(session => !session.unread && !session.pinned));
  assert.equal(byKey(fx, neither).unreadRenamed.unread, false, 'Without its unread mark an idle 2-hour-old thread is still recent.');
});

test('an unreadable imports list hides model-less threads instead of showing Claude sessions twice', async t => {
  const fx = await standard(t);
  const result = await createCodexReader({ homeDir: fx.home, snapshots: fakeSnapshots() }).read({ now: () => fx.now, processes: liveProcesses(), limits: { importsBytes: 10 } });
  assert.deepEqual(result.warnings, ["Codex's list of imported Claude sessions could not be read, so threads without a model are hidden."]);
  const s = byKey(fx, result);
  assert.equal(s.imported, undefined);
  assert.ok(s.importedContinued);
  assert.ok(s.hermesNative);

  await fs.rm(path.join(fx.codex, 'external_agent_session_imports.json'));
  const missing = await createCodexReader({ homeDir: fx.home, snapshots: fakeSnapshots() }).read({ now: () => fx.now, processes: liveProcesses() });
  assert.deepEqual(missing.warnings, []);
  assert.ok(byKey(fx, missing).imported, 'With no registry at all there is nothing to hide.');
  assert.equal(byKey(fx, missing).imported.model, null);
});

test('small read windows still find a turn start far back, and a tiny budget gives up safely', async t => {
  const fx = await standard(t);
  const small = await createCodexReader({ homeDir: fx.home, snapshots: fakeSnapshots() }).read({ now: () => fx.now, processes: liveProcesses(), limits: { tailBytes: 512, chunkBytes: 2048 } });
  const s = byKey(fx, small);
  assert.equal(s.working.activity, 'working');
  assert.equal(s.working.activitySince, Math.floor((fx.now - 12 * MIN) / 1000) * 1000);
  assert.equal(s.waiting.activity, 'needs-you');
  assert.equal(s.interrupted.activity, 'interrupted');

  const tiny = await createCodexReader({ homeDir: fx.home, snapshots: fakeSnapshots() }).read({ now: () => fx.now, processes: liveProcesses(), limits: { tailBytes: 512, chunkBytes: 1024, backBytesLive: 4096 } });
  assert.equal(byKey(fx, tiny).working.activity, 'open', 'An unknown turn state is shown as open, not working.');
});

test('the session list is capped with the most urgent first, and recency follows recentMs', async t => {
  const fx = await standard(t);
  const reader = createCodexReader({ homeDir: fx.home, snapshots: fakeSnapshots() });
  const capped = await reader.read({ now: () => fx.now, processes: liveProcesses(), limits: { sessions: 3 } });
  assert.equal(capped.sessions.length, 3);
  assert.equal(capped.sessions[0].activity, 'needs-you');
  assert.ok(capped.sessions.slice(1).every(session => session.activity === 'working'));

  const wide = await reader.read({ now: () => fx.now, processes: liveProcesses(), recentMs: 60 * DAY });
  assert.ok(byKey(fx, wide).old);
  assert.equal(byKey(fx, wide).oldStarted.activity, 'quiet', 'Turns older than the tail window are not inspected.');
  const narrow = await reader.read({ now: () => fx.now, processes: liveProcesses(), recentMs: 10 * MIN });
  const n = byKey(fx, narrow);
  assert.equal(n.hermesNative, undefined);
  assert.equal(n.interrupted, undefined, 'An interrupted turn outside the recent window is dropped.');
  assert.ok(n.unreadRenamed && n.abortedOpen && n.working);
});

test('an older database layout without the newer columns still reads', async t => {
  const fx = await fixture(t, { schema: 'old' });
  const { add, now, codex } = fx;
  await add('plain', { rollout: [complete(now - MIN)], updated: now - MIN, lock: true });
  await add('child', { source: JSON.stringify({ subagent: { other: 'guardian' } }), rollout: [started(now - MIN)] });
  await add('stale', { rollout: [started(now - MIN)], updated: now - MIN });
  const snapshots = fakeSnapshots();
  const result = await createCodexReader({ homeDir: fx.home, snapshots }).read({ now: () => now, processes: liveProcesses() });
  assert.deepEqual(result.warnings, []);
  const s = byKey(fx, result);
  assert.equal(s.child, undefined);
  assert.equal(s.plain.title, null);
  assert.equal(s.plain.activity, 'open');
  assert.equal(s.plain.startedAt, Math.floor((now - MIN - HOUR) / 1000) * 1000);
  assert.equal(s.plain.updatedAt, now - MIN, 'The rollout line time refines the seconds column.');
  assert.equal(s.stale.activity, 'interrupted');
  assert.ok(snapshots.calls.every(({ statements }) => statements.every(statement => !FORBIDDEN_SQL.test(statement.sql))));
  assert.equal(path.dirname(snapshots.calls[0].dbPath), codex);
});

test('a database without the required columns gives a plain warning', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'summon-codex-odd-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.codex'));
  const db = new DatabaseSync(path.join(root, '.codex', 'state_9.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT)');
  db.close();
  const result = await readCodexSessions({ homeDir: root, snapshots: fakeSnapshots(), processes: processes() });
  assert.deepEqual(result.warnings, ["Codex's thread list has a layout Summon does not know yet."]);
  assert.deepEqual(result.sessions, []);
});

test('table layouts are read from CREATE text with comments, quoted names, constraints and added columns', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'summon-codex-layout-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const codex = path.join(root, '.codex');
  const day = path.join(codex, 'sessions', '2026', '09', '17');
  await fs.mkdir(day, { recursive: true });
  const now = Date.now();
  const id = uuid7(now);
  const rollout = path.join(day, `rollout-${id}.jsonl`);
  await fs.writeFile(rollout, complete(now - MIN));
  const db = new DatabaseSync(path.join(codex, 'state_5.sqlite'));
  db.exec(`CREATE TABLE "threads" ( -- thread list (with, commas)
    "id" TEXT PRIMARY KEY, /* rollout, path ( */ \`rollout_path\` TEXT NOT NULL DEFAULT 'a,b(', [source] TEXT CHECK (source <> 'x,''y'),
    created_at INTEGER, updated_at INTEGER, title TEXT, PRIMARY_note TEXT,
    CONSTRAINT one UNIQUE (id, source), UNIQUE (rollout_path), CHECK (created_at > 0)
  )`);
  db.exec('ALTER TABLE threads ADD COLUMN "name" TEXT');
  db.exec('CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT PRIMARY KEY, status TEXT)');
  db.prepare('INSERT INTO threads (id, rollout_path, source, created_at, updated_at, title, name) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, rollout, 'vscode', Math.floor(now / 1000) - 60, Math.floor(now / 1000) - 60, SECRET, 'Named later');
  db.close();
  const snapshots = fakeSnapshots();
  const result = await readCodexSessions({ homeDir: root, snapshots, processes: processes(), now });
  assert.deepEqual(result.warnings, []);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].title, 'Named later');
  const sql = snapshots.calls[1].statements[0].sql;
  assert.match(sql, /^SELECT id, rollout_path, source, name, created_at, updated_at FROM threads /);
  assert.doesNotMatch(sql, /PRIMARY_note|CONSTRAINT|UNIQUE/);
  assert.match(snapshots.calls[1].statements[1].sql, /FROM thread_spawn_edges/);
});

test('works with the shared snapshot module when it is available', async t => {
  let createSqliteSnapshots;
  try { ({ createSqliteSnapshots } = await import('../src/core/sessions/sqlite-snapshot.mjs')); } catch { t.skip('sqlite-snapshot.mjs is not written yet.'); return; }
  const fx = await standard(t);
  const { run } = await import('../src/main/process.mjs');
  const snapshots = createSqliteSnapshots({ run });
  t.after(() => snapshots.close?.());
  const before = await fs.readdir(fx.codex);
  const result = await createCodexReader({ homeDir: fx.home, snapshots }).read({ now: () => fx.now, processes: liveProcesses() });
  assert.deepEqual(result.warnings, []);
  assert.equal(byKey(fx, result).working.activity, 'working');
  assert.equal(byKey(fx, result).unreadRenamed.title, 'Renamed thread');
  assert.deepEqual(await fs.readdir(fx.codex), before, 'Nothing is created beside the original database.');
});

// ---- which files a thread edited ----
// A completed FileChange item, shaped as the rollout writes it: the paths are the keys of `changes`, and the patch
// body, stdout and stderr sit on the same line.
const fileChange = (at, paths, { status = 'completed' } = {}) => line(at, 'event_msg', {
  type: 'item_completed',
  item: {
    type: 'FileChange', id: `item_${ordinal}`,
    changes: Object.fromEntries(paths.map(file => [file, { update: { unified_diff: `--- a\n+++ b\n+${SECRET}\n` } }])),
    status, stdout: SECRET, stderr: '',
  },
});
const otherItem = at => line(at, 'event_msg', { type: 'item_completed', item: { type: 'CommandExecution', id: 'x', command: SECRET, aggregated_output: SECRET, status: 'completed' } });

test('Codex reader: a thread says which files it wrote, newest first, and never the patch beside them', async t => {
  const fx = await fixture(t);
  const { add, now } = fx;
  await add('edits', {
    name: 'Rank export', updated: now - 2 * MIN, rollout: [
      fileChange(now - 9 * MIN, ['/work/project/src/old.ts', '/work/project/README.md']),
      otherItem(now - 8 * MIN),
      fileChange(now - 7 * MIN, ['/work/project/src/engine.ts']),
      // Never travels: a secret by name, a sealed folder, and anything that is not an absolute path.
      fileChange(now - 6 * MIN, ['/work/project/.env.local', '/work/project/keys.pem', '/Users/someone/Archive/sealed-client/repo/notes.md', 'src/relative.ts']),
      // The same file again takes the newest place rather than appearing twice.
      fileChange(now - 5 * MIN, ['/work/project/src/old.ts']),
      complete(now - 2 * MIN),
    ],
  });
  await add('noEdits', { name: 'Just talking', updated: now - 3 * MIN, rollout: [message(now - 3 * MIN), complete(now - 3 * MIN)] });
  const result = await createCodexReader({ homeDir: fx.home, snapshots: fakeSnapshots() }).read({ now: () => fx.now, processes: liveProcesses() });
  const s = byKey(fx, result);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(s.edits.touchedPaths, ['/work/project/src/old.ts', '/work/project/src/engine.ts', '/work/project/README.md']);
  assert.equal(s.noEdits.touchedPaths, null, 'a thread that wrote nothing says nothing');
  assert.equal(JSON.stringify(result).includes(SECRET), false, 'the diff, stdout and stderr never leave the reader');
});

test('Codex reader: edited files survive a tail that grows and a walk back through older lines', async t => {
  const fx = await fixture(t);
  const { add, files, now } = fx;
  // The first edit sits behind more than one tail's worth of output, so only a walk back can reach it.
  await add('deep', {
    name: 'Long turn', lock: true, updated: now - MIN, rollout: [
      context(now - 30 * MIN), started(now - 29 * MIN), fileChange(now - 28 * MIN, ['/work/project/src/early.ts']),
      filler(now - 20 * MIN, 200 * 1024), fileChange(now - 10 * MIN, ['/work/project/src/late.ts']), message(now - MIN),
    ],
  });
  const reader = createCodexReader({ homeDir: fx.home, snapshots: fakeSnapshots() });
  const first = byKey(fx, await reader.read({ now: () => fx.now, processes: liveProcesses() })).deep;
  assert.deepEqual(first.touchedPaths, ['/work/project/src/late.ts', '/work/project/src/early.ts']);

  // New bytes only: the answer spans the remembered list and the fresh lines.
  await fs.appendFile(files.deep, fileChange(now, ['/work/project/src/newest.ts']));
  const grown = byKey(fx, await reader.read({ now: () => fx.now + MIN, processes: liveProcesses() })).deep;
  assert.deepEqual(grown.touchedPaths, ['/work/project/src/newest.ts', '/work/project/src/late.ts', '/work/project/src/early.ts']);
});

test('Codex reader: a file-change item with a broken changes map is skipped, not guessed at', async t => {
  const fx = await fixture(t);
  const { add, now } = fx;
  // The line stops a few characters into the changes map, so that map never closes.
  const whole = fileChange(now - 5 * MIN, ['/work/project/src/a.ts']).trimEnd();
  const truncated = `${whole.slice(0, whole.indexOf('"changes":{') + 40)}\n`;
  await add('broken', {
    name: 'Half a line', updated: now - 2 * MIN,
    rollout: [truncated, fileChange(now - 4 * MIN, ['/work/project/src/good.ts']), complete(now - 2 * MIN)],
  });
  const result = await createCodexReader({ homeDir: fx.home, snapshots: fakeSnapshots() }).read({ now: () => fx.now, processes: liveProcesses() });
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(byKey(fx, result).broken.touchedPaths, ['/work/project/src/good.ts']);
});

test('Codex reader: a turn-ended report newer than the rollout turns a started turn open, and a launch-bound thread says it came from Summon', async t => {
  const fx = await standard(t);
  const reader = createCodexReader({ homeDir: fx.home, snapshots: fakeSnapshots() });
  const hook = (state, stateAt, launch = null) => ({ app: 'codex', state, reason: null, stateAt, launch, event: 'agent-turn-complete', kind: null, toolName: null, cwd: null, eventAt: stateAt, firstAt: stateAt, events: 1 });
  const tag = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  let s = byKey(fx, await reader.read({ now: () => fx.now, processes: liveProcesses(), hookStates: new Map([[fx.ids.working, hook('open', fx.now - 30 * 1000, tag)], [fx.ids.waiting, hook('open', fx.now - MIN)]]) }));
  assert.deepEqual([s.working.activity, s.working.confidence, s.working.live, s.working.origin, s.working.activitySince, s.working.helpers], ['open', 'reported', true, 'summon', fx.now - 30 * 1000, 0]);
  assert.deepEqual([s.waiting.activity, s.waiting.reason, s.waiting.confidence, s.waiting.origin, s.waiting.surface], ['open', null, 'reported', null, 'cli'], 'a guessed wait gives way to the report; a TUI thread keeps the cli surface');
  // A report older than the rollout's last line says nothing; the rollout moved on.
  s = byKey(fx, await reader.read({ now: () => fx.now, processes: liveProcesses(), hookStates: new Map([[fx.ids.working, hook('open', fx.now - 5 * MIN)]]) }));
  assert.deepEqual([s.working.activity, s.working.origin], ['working', null]);
  // An ended report closes a live thread; a report cannot make a closed thread live.
  s = byKey(fx, await reader.read({ now: () => fx.now, processes: liveProcesses(), hookStates: new Map([[fx.ids.working, hook('ended', fx.now)], [fx.ids.interrupted, hook('working', fx.now)]]) }));
  assert.deepEqual([s.working.live, s.working.activity], [false, 'interrupted']);
  assert.deepEqual([s.interrupted.live, s.interrupted.activity], [false, 'interrupted']);
  // Without hook states nothing changes.
  s = byKey(fx, await reader.read({ now: () => fx.now, processes: liveProcesses() }));
  assert.deepEqual([s.working.activity, s.working.origin, s.waiting.activity, s.waiting.confidence], ['working', null, 'needs-you', 'inferred']);
});

test('Codex recent evidence follows subsequent prompts and excludes instructions, analysis and tool output', async t => {
  const fx = await fixture(t);
  const request = (at, text) => line(at, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
  await fx.add('evolving', { name: 'First request', lock: true, rollout: [request(fx.now - MIN, 'Start with the old task'), message(fx.now - MIN + 1)] });
  const reader = createCodexReader({ homeDir: fx.home, snapshots: fakeSnapshots(), now: fx.now, processes: processes(APP_CODEX) });
  assert.equal(byKey(fx, await reader.read()).evolving.recentContext.messages[0].text, 'Start with the old task');
  await fs.appendFile(fx.files.evolving, [
    ...Array.from({ length: 8 }, (_, i) => request(fx.now - 9000 + i * 100, `Work on evolving goals ${i}`)),
    request(fx.now - 1000, '<environment_context>SECRET injected context</environment_context>'),
    line(fx.now - 900, 'response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: SECRET }] }),
    line(fx.now - 800, 'response_item', { type: 'message', role: 'assistant', channel: 'analysis', content: [{ type: 'output_text', text: SECRET }] }),
    output(fx.now - 700), message(fx.now - 600, 'The current goal is clear'), complete(fx.now - 500),
  ].join(''));
  const recent = byKey(fx, await reader.read()).evolving;
  assert.equal(recent.title, 'First request');
  assert.equal(recent.recentContext.messages.length, 6);
  assert.equal(recent.recentContext.messages.at(-2).text, 'Work on evolving goals 7');
  assert.equal(recent.recentContext.updatedAt, fx.now - 600);
  assert.doesNotMatch(JSON.stringify(recent.recentContext), /SECRET|Start with the old task/);
});

test('completed Codex turns recover recent user intent behind large tool output on cold and warm reads', async t => {
  const fx = await fixture(t);
  const request = (at, text) => line(at, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
  const framing = 'Explain the limits of the import checks';
  const followup = 'Follow up with the professor about chart labels, the route importer, and fixed share links';
  await fx.add('completed', { name: 'Project follow-up', updated: fx.now - MIN, rollout: [
    request(fx.now - 20 * MIN, framing), message(fx.now - 19 * MIN, 'The checks establish row counts'),
    context(fx.now - 10 * MIN), started(fx.now - 10 * MIN), request(fx.now - 9 * MIN, followup),
    fileChange(fx.now - 8 * MIN, ['/work/project/src/old-edit.ts']),
    filler(fx.now - 5 * MIN, 320 * 1024),
    request(fx.now - 2 * MIN, '<environment_context>SECRET instructions</environment_context>'),
    line(fx.now - 2 * MIN, 'response_item', { type: 'message', role: 'assistant', channel: 'analysis', content: [{ type: 'output_text', text: SECRET }] }),
    message(fx.now - MIN, 'The share link fix is ready'), complete(fx.now - MIN),
  ] });
  const options = { homeDir: fx.home, snapshots: fakeSnapshots(), now: fx.now, processes: processes() };
  const reader = createCodexReader(options);
  const cold = byKey(fx, await reader.read()).completed;
  assert.deepEqual(cold.recentContext.messages.filter(row => row.role === 'user').map(row => row.text), [framing, followup]);
  assert.equal(cold.activity, 'quiet', 'A deeper conversational read cannot reopen the completed turn.');
  assert.equal(cold.touchedPaths, null, 'Conversation backfill does not broaden the metadata-only edited-file scan.');
  assert.doesNotMatch(JSON.stringify(cold), /SECRET/);
  assert.deepEqual(byKey(fx, await reader.read()).completed.recentContext, cold.recentContext, 'An unchanged cached read keeps recovered intent.');

  await fs.appendFile(fx.files.completed, message(fx.now - 500, 'The follow-up is still a draft') + complete(fx.now - 400));
  const warm = byKey(fx, await reader.read()).completed;
  assert.deepEqual(warm.recentContext.messages.filter(row => row.role === 'user').map(row => row.text), [framing, followup]);
  assert.equal(warm.recentContext.messages.at(-1).text, 'The follow-up is still a draft');
  const restarted = byKey(fx, await createCodexReader(options).read()).completed;
  assert.deepEqual(restarted.recentContext, warm.recentContext, 'Restarting the app recovers the same bounded evidence.');
});

test('Codex intent backfill respects its byte cap and retries when the allowed budget grows', async t => {
  const fx = await fixture(t);
  await fx.add('bounded', { updated: fx.now - MIN, rollout: [
    user(fx.now - 5 * MIN), filler(fx.now - 3 * MIN, 200 * 1024), message(fx.now - MIN), complete(fx.now - MIN),
  ] });
  const reader = createCodexReader({ homeDir: fx.home, snapshots: fakeSnapshots(), now: fx.now, processes: processes() });
  // The chunk is deliberately bigger than the remaining budget. It must not read past that budget to find the request.
  const limited = { limits: { backBytesIdle: 100 * 1024 } };
  const first = byKey(fx, await reader.read(limited)).bounded;
  assert.ok(first.recentContext.messages.every(row => row.role === 'assistant'));
  assert.equal(first.activity, 'quiet');
  assert.deepEqual(byKey(fx, await reader.read(limited)).bounded.recentContext, first.recentContext);
  const recovered = byKey(fx, await reader.read()).bounded;
  assert.ok(recovered.recentContext.messages.some(row => row.role === 'user'), 'A cached lifecycle event does not prevent a larger bounded intent search.');
  assert.doesNotMatch(JSON.stringify(recovered), /SECRET/);
});
