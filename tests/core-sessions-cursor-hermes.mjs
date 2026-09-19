import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { createCursorReader, readCursorSessions, cursorStatements } from '../src/core/sessions/cursor.mjs';
import { createHermesReader, readHermesSessions, hermesStatements, liveActiveSessions, columnsFromCreate } from '../src/core/sessions/hermes.mjs';
import { setSealedSegments } from '../src/core/workstreams.mjs';

// The sealed-folder guard is empty until configured; these fixtures seal any path segment containing 'sealed-client'.
setSealedSegments(['sealed-client']);

const NOW = Date.UTC(2026, 8, 17, 12, 0, 0);
const MIN = 60000;
const DAY = 864e5;
const SECRET = 'SECRET-CONVERSATION-TEXT';
const CURSOR_BIN = '/Applications/Cursor.app/Contents/MacOS/Cursor';
const HERMES_BIN = '/Users/someone/Applications/Hermes.app/Contents/MacOS/Hermes';
const uuid = n => `${String(n).padStart(8, '0')}-1111-4222-8333-444455556666`;

async function tempHome(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'summon-test-ch-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function listing(dir) { return (await fs.readdir(dir)).sort(); }
function procs(...entries) { return new Map(entries.map(entry => [entry.pid, { ppid: 1, lstart: 'Thu Sep 17 11:00:00 2026', ...entry }])); }

// Stand-in for the infra snapshot service (A): copies the files into a private temp dir and runs only SELECT/WITH on the copy.
function fakeSnapshots({ fail = null } = {}) {
  const calls = [];
  return {
    calls,
    async query(dbPath, statements, options = {}) {
      calls.push({ dbPath, names: statements.map(s => s.name), options, statements });
      if (fail) throw fail;
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'summon-fake-snap-'));
      try {
        for (const suffix of ['-wal', '-shm', '']) await fs.copyFile(dbPath + suffix, path.join(dir, `db${suffix}`)).catch(error => { if (error.code !== 'ENOENT') throw error; });
        const db = new DatabaseSync(path.join(dir, 'db'));
        try {
          const out = {};
          for (const s of statements) {
            assert.match(s.sql, /^\s*(SELECT|WITH)\b/i, 'Only read-only statements are sent.');
            out[s.name] = db.prepare(s.sql).all(...(s.params || [])).map(row => ({ ...row }));
          }
          return out;
        } finally { db.close(); }
      } finally { await fs.rm(dir, { recursive: true, force: true }); }
    },
    close() {},
  };
}

// ---------- Cursor fixture ----------
function header(id, extra = {}) {
  const { name = `Agent ${id.slice(0, 4)}`, createdAt = NOW - 2 * DAY, lastUpdatedAt = NOW - 5 * MIN, isArchived = 0, isSubagent = 0, json = {} } = extra;
  const value = {
    type: 'head', composerId: id, createdAt, unifiedMode: 'agent', forceMode: 'edit', hasUnreadMessages: false, isWorktree: false, isDraft: false,
    isSpec: false, isProject: false, isBestOfNSubcomposer: false, numSubComposers: 0, subtitle: `${SECRET} subtitle`,
    workspaceIdentifier: { id: 'a'.repeat(32), uri: { $mid: 1, external: 'file:///Users/someone/Projects/Alpha', fsPath: '/Users/someone/Projects/Alpha', path: '/Users/someone/Projects/Alpha', scheme: 'file' } },
    ...(name === null ? {} : { name }), ...(lastUpdatedAt === null ? {} : { lastUpdatedAt }), ...json,
  };
  return { id, workspaceId: 'a'.repeat(32), createdAt, lastUpdatedAt, isArchived, isSubagent, recency: lastUpdatedAt ?? createdAt, value: typeof extra.raw === 'string' ? extra.raw : JSON.stringify(value) };
}
function composerData(id, extra = {}) {
  return {
    _v: 18, composerId: id, status: 'completed', generatingBubbleIds: [], text: SECRET, richText: SECRET, conversationState: SECRET,
    conversationMap: { a: SECRET }, fullConversationHeadersOnly: [{ bubbleId: 'b1', type: 1 }, { bubbleId: 'b2', type: 2 }], modelConfig: { modelName: 'composer-2' }, ...extra,
  };
}

async function cursorFixture(t, { skip = [] } = {}) {
  const home = await tempHome(t);
  const dir = path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage');
  await fs.mkdir(dir, { recursive: true });
  const dbPath = path.join(dir, 'state.vscdb');
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
    CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
    CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER, checkpointAt INTEGER, value TEXT, subagentTypeName TEXT);`);
  const ids = {
    unread: uuid(1), blocking: uuid(2), plan: uuid(3), generating: uuid(4), unfinished: uuid(5), emptyUnnamed: uuid(6), unnamed: uuid(7),
    draft: uuid(8), bestOf: uuid(9), archived: uuid(10), sub1: uuid(11), sub2: uuid(12), old: uuid(13), sealed: uuid(14), worktree: uuid(15),
    invalid: uuid(16), noData: uuid(17), quiet: uuid(18), cloud: `bc-${uuid(19)}`, oldSub: uuid(20),
  };
  const headers = [
    header(ids.unread, { lastUpdatedAt: NOW - 20 * DAY, json: { hasUnreadMessages: true } }),
    header(ids.blocking, { lastUpdatedAt: NOW - 30 * DAY, json: { hasBlockingPendingActions: true } }),
    header(ids.plan, { lastUpdatedAt: NOW - 2 * 60 * MIN, json: { hasPendingPlan: true, totalLinesAdded: 8, totalLinesRemoved: 0, filesChangedCount: 'lots' } }),
    header(ids.generating, { lastUpdatedAt: NOW - 1 * MIN, json: { activeBranch: { branchName: 'feat/gen', lastInteractionAt: NOW }, totalLinesAdded: 340, totalLinesRemoved: 20, filesChangedCount: 12 } }),
    header(ids.unfinished, { lastUpdatedAt: NOW - 30 * MIN, json: { unfinishedRunAt: NOW - 30 * MIN } }),
    header(ids.emptyUnnamed, { name: null, lastUpdatedAt: null, createdAt: NOW - 60 * MIN }),
    header(ids.unnamed, { name: null, lastUpdatedAt: NOW - 3 * 60 * MIN }),
    header(ids.draft, { json: { isDraft: true } }),
    header(ids.bestOf, { json: { isBestOfNSubcomposer: true } }),
    header(ids.archived, { isArchived: 1, json: { hasUnreadMessages: true } }),
    header(ids.sub1, { isSubagent: 1, lastUpdatedAt: NOW - 2 * MIN, json: { unfinishedRunAt: NOW - 2 * MIN, subagentInfo: { parentComposerId: ids.generating, subagentTypeName: 'explore' } } }),
    header(ids.sub2, { isSubagent: 1, lastUpdatedAt: NOW - 3 * MIN, json: { unfinishedRunAt: NOW - 3 * MIN, subagentInfo: { parentComposerId: ids.generating, subagentTypeName: 'explore' } } }),
    header(ids.oldSub, { isSubagent: 1, lastUpdatedAt: NOW - 3 * DAY, json: { unfinishedRunAt: NOW - 3 * DAY, subagentInfo: { parentComposerId: ids.generating } } }),
    header(ids.old, { lastUpdatedAt: NOW - 40 * DAY }),
    header(ids.sealed, { json: { workspaceIdentifier: { id: 'b'.repeat(32), uri: { fsPath: '/Users/someone/Archive/sealed-client/app', scheme: 'file' } } } }),
    header(ids.worktree, { lastUpdatedAt: NOW - 6 * 60 * MIN, json: { isWorktree: true } }),
    header(ids.invalid, { raw: `{"name": "${SECRET}` }),
    header(ids.noData, { name: null, lastUpdatedAt: NOW - 4 * 60 * MIN }),
    header(ids.quiet, { lastUpdatedAt: NOW - 10 * MIN, json: { workspaceIdentifier: { id: '1789516319943' }, agentLocation: { type: 'local', environment: { uri: { fsPath: '/Users/someone/Projects/Beta' } } }, name: `Fix\u0007 the\u202e   thing ${'x'.repeat(200)}` } }),
    header(ids.cloud, { lastUpdatedAt: NOW - 70 * MIN }),
    header('claude-code:{"cwd":"/x","sessionId":"y"}'),
  ].filter(row => !skip.includes(row.id));
  const insert = db.prepare('INSERT INTO composerHeaders (composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, checkpointAt, value, subagentTypeName) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)');
  for (const row of headers) insert.run(row.id, row.workspaceId, row.createdAt, row.lastUpdatedAt, row.isArchived, row.isSubagent, row.recency, row.value);
  const kv = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');
  kv.run(`composerData:${ids.generating}`, Buffer.from(JSON.stringify(composerData(ids.generating, { status: 'generating', generatingBubbleIds: ['g1'] }))));
  kv.run(`composerData:${ids.unfinished}`, JSON.stringify(composerData(ids.unfinished, { status: 'generating' })));
  kv.run(`composerData:${ids.emptyUnnamed}`, JSON.stringify(composerData(ids.emptyUnnamed, { fullConversationHeadersOnly: [] })));
  kv.run(`composerData:${ids.unnamed}`, JSON.stringify(composerData(ids.unnamed)));
  kv.run(`composerData:${ids.plan}`, JSON.stringify(composerData(ids.plan)));
  kv.run(`composerData:${ids.quiet}`, JSON.stringify(composerData(ids.quiet, { gitWorktree: { worktreePath: '/Users/someone/.cursor/worktrees/beta/q1', branchName: 'cursor/q1' } })));
  kv.run(`composerData:${ids.cloud}`, null);
  kv.run(`bubbleId:${ids.generating}:b1`, JSON.stringify({ text: SECRET }));
  const item = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
  item.run('worktree.metadata', JSON.stringify([
    { id: 'w1', path: '/Users/someone/.cursor/worktrees/alpha/glf', composerId: ids.worktree, branchName: 'cursor/glf', status: 'active', ownership: 'cursor-managed' },
    'not an object', 42,
    { id: 'w2', path: 'relative/path', composerId: ids.unread, branchName: 'x' },
  ]));
  item.run('glass.localAgentProjects.v1', JSON.stringify([{ name: SECRET }]));
  db.close();
  return { home, dir, dbPath, ids };
}
const byId = sessions => new Map(sessions.map(session => [session.id, session]));
const cursorRunning = (startedAt = NOW - 5 * 60 * MIN) => procs({ pid: 4100, startedAt, comm: CURSOR_BIN }, { pid: 829, startedAt: NOW - DAY, comm: '/System/Library/PrivateFrameworks/TextInputUIMacHelper.framework/Versions/A/XPCServices/CursorUIViewService.xpc/Contents/MacOS/CursorUIViewService' });

test('Cursor: states, titles, folders and filters from composer headers', async t => {
  const { home, dir, dbPath, ids } = await cursorFixture(t);
  const before = await listing(dir);
  const snapshots = fakeSnapshots();
  const result = await readCursorSessions({ homeDir: home, now: NOW, processes: cursorRunning(), snapshots });
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.sources, [{ app: 'cursor', label: 'Cursor', available: true, running: true, detail: null }]);
  assert.equal(snapshots.calls.length, 1);
  assert.equal(snapshots.calls[0].dbPath, dbPath);
  assert.equal(snapshots.calls[0].options.maxFullCopyBytes, 0, 'Cursor is never full-copied.');
  const s = byId(result.sessions);
  assert.deepEqual([...s.keys()].sort(), [ids.unread, ids.blocking, ids.plan, ids.generating, ids.unfinished, ids.unnamed, ids.worktree, ids.quiet, ids.cloud].sort());

  const gen = s.get(ids.generating);
  assert.deepEqual(gen, {
    app: 'cursor', surface: 'ide', id: ids.generating, title: `Agent ${ids.generating.slice(0, 4)}`,
    cwd: '/Users/someone/Projects/Alpha', worktreePath: null, branch: 'feat/gen', startedAt: NOW - 2 * DAY, updatedAt: NOW - MIN,
    activity: 'working', activitySince: NOW - MIN, reason: null, unread: false, archived: false, pinned: false, live: true,
    confidence: 'reported', helpers: 2, model: 'composer-2',
    work: { added: 340, removed: 20, files: 12, area: null, scope: 'session', workstream: null, workstreamState: null },
  });
  // Counts come from the header Cursor already keeps: a count in a shape we do not know is left out, and a header without them says nothing.
  assert.deepEqual(s.get(ids.plan).work, { added: 8, removed: 0, files: null, area: null, scope: 'session', workstream: null, workstreamState: null });
  assert.equal(s.get(ids.unread).work, null);
  assert.equal(s.get(ids.unfinished).activity, 'working');
  assert.equal(s.get(ids.unfinished).activitySince, NOW - 30 * MIN);
  assert.equal(s.get(ids.unfinished).helpers, 0);

  assert.equal(s.get(ids.blocking).activity, 'needs-you');
  assert.equal(s.get(ids.blocking).reason, 'Waiting for your OK');
  assert.equal(s.get(ids.blocking).live, true);
  assert.equal(s.get(ids.plan).activity, 'needs-you');
  assert.equal(s.get(ids.plan).reason, 'Plan ready for review');

  const unread = s.get(ids.unread);
  assert.equal(unread.unread, true);
  assert.equal(unread.activity, 'quiet');
  assert.equal(unread.live, false);
  assert.equal(unread.cwd, '/Users/someone/Projects/Alpha', 'A relative worktree path is ignored.');

  assert.equal(s.get(ids.unnamed).title, 'New agent');
  assert.equal(s.get(ids.worktree).worktreePath, '/Users/someone/.cursor/worktrees/alpha/glf');
  assert.equal(s.get(ids.worktree).cwd, '/Users/someone/.cursor/worktrees/alpha/glf');
  assert.equal(s.get(ids.worktree).branch, 'cursor/glf');
  assert.equal(s.get(ids.worktree).activity, 'quiet');

  const quiet = s.get(ids.quiet);
  assert.equal(quiet.worktreePath, '/Users/someone/.cursor/worktrees/beta/q1');
  assert.equal(quiet.branch, 'cursor/q1');
  assert.equal(quiet.title.length, 120);
  assert.match(quiet.title, /^Fix the thing x+$/);
  assert.equal(s.get(ids.cloud).model, null);

  const text = JSON.stringify(result);
  assert.ok(!text.includes(SECRET), 'No conversation text or subtitle reaches the output.');
  assert.deepEqual(await listing(dir), before, 'Nothing is written beside the Cursor database.');
});

test('Cursor: SQL never selects whole values, subtitles or conversation text', async t => {
  const { home } = await cursorFixture(t);
  const statements = cursorStatements({ since: 1, hotSince: 2, helperSince: 3 });
  for (const { sql } of statements) {
    assert.doesNotMatch(sql, /subtitle|richText|'\$\.text'|conversationState|conversationMap|agentKv|bubbleId/);
    assert.doesNotMatch(sql, /SELECT\s+(\w+\.)?value\b/i);
    assert.doesNotMatch(sql, /,\s*(\w+\.)?value\s*(,|FROM)/i);
    assert.doesNotMatch(sql, /SELECT\s+\*|\.\*/);
  }
  const snapshots = fakeSnapshots();
  await readCursorSessions({ homeDir: home, now: NOW, processes: cursorRunning(), snapshots });
  // Inspect what the snapshot returned (everything the reader ever sees).
  const raw = await fakeSnapshots().query(snapshots.calls[0].dbPath, snapshots.calls[0].statements);
  assert.ok(!JSON.stringify(raw).includes(SECRET));
  assert.deepEqual(Object.keys(raw.details[0]).sort(), ['generating', 'id', 'model', 'status', 'turns', 'worktreeBranch', 'worktreePath']);
});

test('Cursor closed: runs read as interrupted, needs-you stays, nothing is live', async t => {
  const { home, ids } = await cursorFixture(t);
  const result = await readCursorSessions({ homeDir: home, now: NOW, processes: procs({ pid: 829, startedAt: NOW - DAY, comm: '/System/Library/CursorUIViewService' }), snapshots: fakeSnapshots() });
  assert.deepEqual(result.sources, [{ app: 'cursor', label: 'Cursor', available: true, running: false, detail: 'Cursor is closed, so nothing there is running.' }]);
  const s = byId(result.sessions);
  for (const id of [ids.generating, ids.unfinished]) {
    assert.equal(s.get(id).activity, 'interrupted');
    assert.equal(s.get(id).reason, 'Interrupted when the app closed');
    assert.equal(s.get(id).helpers, 0);
  }
  assert.equal(s.get(ids.blocking).activity, 'needs-you');
  assert.ok(result.sessions.every(session => session.live === false));
});

test('Cursor reopened after a quit: runs marked before the launch are interrupted', async t => {
  const { home, ids } = await cursorFixture(t);
  const result = await readCursorSessions({ homeDir: home, now: NOW, processes: cursorRunning(NOW - 10 * MIN), snapshots: fakeSnapshots() });
  const s = byId(result.sessions);
  assert.equal(s.get(ids.unfinished).activity, 'interrupted');
  assert.equal(s.get(ids.generating).activity, 'working');
});

test('Cursor reader is change-gated on the database files; process changes still re-derive states', async t => {
  const { home, dbPath, ids } = await cursorFixture(t);
  const snapshots = fakeSnapshots();
  const reader = createCursorReader({ homeDir: home, snapshots });
  const first = await reader.read({ now: NOW, processes: new Map() });
  assert.equal(byId(first.sessions).get(ids.generating).activity, 'interrupted');
  const second = await reader.read({ now: NOW + 1000, processes: cursorRunning() });
  assert.equal(snapshots.calls.length, 1, 'Unchanged files are not snapshotted again.');
  assert.equal(byId(second.sessions).get(ids.generating).activity, 'working');
  assert.equal(second.sources[0].running, true);

  const db = new DatabaseSync(dbPath);
  db.prepare('UPDATE composerHeaders SET value = json_set(value, \'$.hasUnreadMessages\', json(\'true\')) WHERE composerId = ?').run(ids.worktree);
  db.close();
  const third = await reader.read({ now: NOW + 2000, processes: cursorRunning() });
  assert.equal(snapshots.calls.length, 2);
  assert.equal(byId(third.sessions).get(ids.worktree).unread, true);

  await reader.read({ now: NOW + 2000 + 6 * MIN, processes: cursorRunning() });
  assert.equal(snapshots.calls.length, 3, 'The cache expires after a few minutes as a safety net.');
  await reader.read({ now: NOW + 2000 + 6 * MIN, processes: cursorRunning(), recentMs: DAY });
  assert.equal(snapshots.calls.length, 4, 'A different window re-queries.');
});

test('Cursor: a plan waiting for review never ages out of the list', async t => {
  const { home, dbPath, ids } = await cursorFixture(t);
  // Two days since anyone touched it: well outside the recent window, and nothing else marks it.
  const old = NOW - 48 * 60 * MIN;
  const db = new DatabaseSync(dbPath);
  db.prepare('UPDATE composerHeaders SET recency = ?, lastUpdatedAt = ? WHERE composerId = ?').run(old, old, ids.plan);
  db.close();
  const result = await readCursorSessions({ homeDir: home, now: NOW, recentMs: 24 * 60 * MIN, processes: cursorRunning(), snapshots: fakeSnapshots() });
  const plan = byId(result.sessions).get(ids.plan);
  assert.ok(plan, 'a plan waiting on you is still listed');
  assert.equal(plan.activity, 'needs-you');
  assert.equal(plan.reason, 'Plan ready for review');
});

test('Cursor: missing database, failed snapshot and malformed rows never throw', async t => {
  const empty = await tempHome(t);
  const missing = await readCursorSessions({ homeDir: empty, now: NOW, processes: new Map(), snapshots: fakeSnapshots() });
  assert.deepEqual(missing, { sessions: [], sources: [{ app: 'cursor', label: 'Cursor', available: false, running: false, detail: 'Cursor is not set up on this Mac.' }], warnings: [] });

  const { home } = await cursorFixture(t);
  const failed = await readCursorSessions({ homeDir: home, now: NOW, processes: cursorRunning(), snapshots: fakeSnapshots({ fail: new Error('Could not take a safe snapshot of state.vscdb.') }) });
  assert.deepEqual(failed.sessions, []);
  assert.equal(failed.sources[0].available, true);
  assert.equal(failed.sources[0].detail, "Cursor's agent list could not be read.");
  assert.deepEqual(failed.warnings, ["Cursor's agent list could not be read. Could not take a safe snapshot of state.vscdb."]);

  const noSnapshots = await readCursorSessions({ homeDir: home, now: NOW, processes: new Map(), snapshots: { query: async () => ({}) } });
  assert.deepEqual(noSnapshots.sessions, []);
  assert.deepEqual(noSnapshots.warnings, []);
});

test('Cursor: cap and limits', async t => {
  const { home } = await cursorFixture(t);
  const result = await readCursorSessions({ homeDir: home, now: NOW, processes: cursorRunning(), snapshots: fakeSnapshots(), limits: { sessions: 3 } });
  assert.equal(result.sessions.length, 3);
});

// ---------- Hermes fixture ----------
const HERMES_SCHEMA = `CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, user_id TEXT, model TEXT, model_config TEXT, system_prompt TEXT, parent_session_id TEXT,
  started_at REAL NOT NULL, ended_at REAL, end_reason TEXT, message_count INTEGER DEFAULT 0, cwd TEXT, git_branch TEXT, git_repo_root TEXT, title TEXT, title_source TEXT,
  last_activity_at REAL, last_activity_description TEXT, origin_json TEXT, archived INTEGER DEFAULT 0, pinned INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0, last_read_at REAL, tool_names TEXT);
  CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL);
  CREATE TABLE session_turn_leases (conversation_id TEXT PRIMARY KEY, holder TEXT NOT NULL, acquired_at REAL NOT NULL, expires_at REAL NOT NULL);
  CREATE TABLE gateway_heartbeats (backend_id TEXT PRIMARY KEY, pid INTEGER, started_at REAL, last_heartbeat REAL, profile TEXT, host TEXT);`;
const LEGACY_SCHEMA = `CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, model TEXT, parent_session_id TEXT, started_at REAL NOT NULL, ended_at REAL, end_reason TEXT,
  cwd TEXT, title TEXT, last_activity_at REAL, archived INTEGER DEFAULT 0, system_prompt TEXT);`;
const sec = value => value / 1000;

async function hermesFixture(t, { legacy = false } = {}) {
  const home = await tempHome(t);
  const dir = path.join(home, '.hermes');
  await fs.mkdir(path.join(dir, 'runtime'), { recursive: true });
  const dbPath = path.join(dir, 'state.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL; ${legacy ? LEGACY_SCHEMA : HERMES_SCHEMA}`);
  const ids = {
    root: '20260917_090000_aaaaa1', tip: '20260917_100000_aaaaa2', open: '20260917_100500_bbbbb1', unread: '20260916_080000_ccccc1', oldRead: '20260901_080000_ddddd1',
    hidden: '20260917_110000_eeeee1', archived: '20260917_110100_eeeee2', sealed: '20260917_110200_eeeee3', tool: '20260917_110300_eeeee4', dead: '20260917_110400_fffff1',
    expired: '20260917_110500_fffff2', forkParent: '20260917_080000_99999a', fork: '20260917_111000_99999b', cli: '20260917_111100_12345a', cron: '20260917_111200_12345b',
    oldOpen: '20260901_111300_12345c', wrongStart: '20260917_111400_12345d', archivedOpen: '20260917_111500_12345e', markedUnread: '20260917_111600_12345f',
  };
  const secretConfig = JSON.stringify({ secret: SECRET });
  if (legacy) {
    const ins = db.prepare('INSERT INTO sessions (id, source, model, parent_session_id, started_at, end_reason, cwd, title, last_activity_at, archived, system_prompt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    ins.run(ids.root, 'desktop', 'm1', null, sec(NOW - 3 * 60 * MIN), 'compression', '/Users/someone/Projects/Alpha', 'Root title', sec(NOW - 2 * 60 * MIN), 0, SECRET);
    ins.run(ids.tip, 'desktop', 'm1', ids.root, sec(NOW - 2 * 60 * MIN), null, null, null, sec(NOW - 10 * MIN), 0, SECRET);
    ins.run(ids.cli, 'cli', null, null, sec(NOW - 60 * MIN), null, null, 'Legacy cli', null, 0, SECRET);
    db.close();
    return { home, dir, dbPath, ids };
  }
  const ins = db.prepare(`INSERT INTO sessions (id, source, model, model_config, system_prompt, parent_session_id, started_at, end_reason, cwd, git_branch, git_repo_root, title,
    last_activity_at, last_activity_description, origin_json, archived, pinned, hidden, last_read_at, tool_names) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const add = (id, o = {}) => ins.run(id, o.source ?? 'desktop', o.model ?? 'claude-opus', o.modelConfig ?? secretConfig, SECRET, o.parent ?? null, sec(o.startedAt ?? NOW - 60 * MIN), o.endReason ?? null,
    o.cwd ?? null, o.branch ?? null, o.repo ?? null, o.title ?? null, o.activity === null ? null : sec(o.activity ?? NOW - 20 * MIN), SECRET, SECRET, o.archived ?? 0, o.pinned ?? 0, o.hidden ?? 0,
    o.lastRead === undefined ? null : o.lastRead === 0 ? 0 : sec(o.lastRead), SECRET);
  add(ids.root, { startedAt: NOW - 5 * 60 * MIN, endReason: 'compression', title: 'Root title', activity: NOW - 3 * 60 * MIN, cwd: '/Users/someone/Projects/Alpha' });
  add(ids.tip, { parent: ids.root, startedAt: NOW - 3 * 60 * MIN, activity: NOW - 2 * MIN, cwd: '/Users/someone/Projects/Alpha/sub', branch: 'main', repo: '/Users/someone/Projects/Alpha', pinned: 1 });
  add(ids.open, { title: 'Open chat', activity: NOW - 40 * MIN, repo: '/Users/someone/Projects/Beta' });
  add(ids.unread, { title: 'Finished work', startedAt: NOW - DAY, activity: NOW - 20 * 60 * MIN, lastRead: NOW - 21 * 60 * MIN });
  add(ids.oldRead, { title: 'Old', startedAt: NOW - 16 * DAY, activity: NOW - 15 * DAY, lastRead: NOW - 14 * DAY });
  add(ids.hidden, { title: 'Bot chat', hidden: 1, lastRead: 0 });
  add(ids.archived, { title: 'Archived', archived: 1 });
  add(ids.sealed, { title: 'Private', cwd: '/Users/someone/Archive/sealed-client/repo' });
  add(ids.tool, { source: 'tool', title: 'Tool child' });
  add(ids.dead, { title: 'Dead turn' });
  add(ids.expired, { title: 'Expired turn' });
  add(ids.forkParent, { startedAt: NOW - 8 * 60 * MIN, endReason: 'compression', title: 'Fork parent', activity: NOW - 7 * 60 * MIN });
  add(ids.fork, { parent: ids.forkParent, modelConfig: JSON.stringify({ _branched_from: ids.forkParent, secret: SECRET }), title: null });
  add(ids.cli, { source: 'cli', title: 'Terminal chat' });
  add(ids.cron, { source: 'cron', title: 'Nightly job' });
  add(ids.oldOpen, { title: 'Idle window', startedAt: NOW - 20 * DAY, activity: NOW - 19 * DAY });
  add(ids.wrongStart, { title: 'Recycled pid', startedAt: NOW - 20 * DAY, activity: NOW - 19 * DAY });
  add(ids.archivedOpen, { title: 'Archived but open', archived: 1 });
  add(ids.markedUnread, { title: 'Marked unread', lastRead: 0, modelConfig: 'not json' });
  add('not-a-hermes-id', { title: 'Bad id' });
  db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run(ids.tip, 'user', SECRET, sec(NOW));
  const lease = db.prepare('INSERT INTO session_turn_leases VALUES (?, ?, ?, ?)');
  lease.run(ids.root, 'host=mac:pid=500:thread=1', sec(NOW - 4 * MIN), sec(NOW + 4 * MIN));
  lease.run(ids.forkParent, 'pid=500', sec(NOW - 4 * MIN), sec(NOW + 4 * MIN));
  lease.run(ids.dead, 'pid=999', sec(NOW - 30 * MIN), sec(NOW + 1 * MIN));
  lease.run(ids.expired, 'pid=500', sec(NOW - 30 * MIN), sec(NOW - 25 * MIN));
  db.prepare('INSERT INTO gateway_heartbeats VALUES (?, ?, ?, ?, ?, ?)').run('b1', 500, sec(NOW - DAY), sec(NOW - MIN), 'default', 'mac');
  db.close();
  const active = { entries: [
    { lease_id: 'a'.repeat(32), session_id: ids.open, surface: 'desktop', pid: 500, process_start_time: sec(NOW - 5 * 60 * MIN) + 0.73, started_at: 1, updated_at: 1, track_liveness: true, metadata: {} },
    { lease_id: 'b'.repeat(32), session_id: ids.oldOpen, surface: 'desktop', pid: 500, process_start_time: null },
    { lease_id: 'c'.repeat(32), session_id: ids.wrongStart, surface: 'desktop', pid: 500, process_start_time: sec(NOW - 9 * 60 * MIN) },
    { lease_id: 'd'.repeat(32), session_id: ids.archivedOpen, surface: 'desktop', pid: 500 },
    { lease_id: 'e'.repeat(32), session_id: ids.dead, surface: 'cli', pid: 999 },
    { lease_id: 'f'.repeat(32), session_id: '../../etc', surface: 'desktop', pid: 500 },
  ] };
  await fs.writeFile(path.join(dir, 'runtime', 'active_sessions.json'), JSON.stringify(active));
  return { home, dir, dbPath, ids };
}
const hermesProcs = (extra = []) => procs({ pid: 500, startedAt: NOW - 5 * 60 * MIN, comm: '/opt/homebrew/bin/python3.12' }, ...extra);

test('Hermes: tips only, root titles, working, open, unread and interrupted', async t => {
  const { home, dir, dbPath, ids } = await hermesFixture(t);
  const before = await listing(dir);
  const snapshots = fakeSnapshots();
  const result = await readHermesSessions({ homeDir: home, now: NOW, processes: hermesProcs(), snapshots });
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.sources, [{ app: 'hermes', label: 'Hermes', available: true, running: true, detail: null }]);
  assert.equal(snapshots.calls[0].dbPath, dbPath);
  const s = byId(result.sessions);
  assert.deepEqual([...s.keys()].sort(), [ids.tip, ids.open, ids.unread, ids.dead, ids.expired, ids.fork, ids.cli, ids.cron, ids.oldOpen, ids.archivedOpen, ids.markedUnread].sort());

  assert.deepEqual(s.get(ids.tip), {
    app: 'hermes', surface: 'desktop', id: ids.tip, title: 'Root title', cwd: '/Users/someone/Projects/Alpha/sub', worktreePath: null, branch: 'main',
    startedAt: NOW - 5 * 60 * MIN, updatedAt: NOW - 2 * MIN, activity: 'working', activitySince: NOW - 4 * MIN, reason: null,
    unread: false, archived: false, pinned: true, live: true, confidence: 'reported', helpers: 0, model: 'claude-opus',
  });
  const open = s.get(ids.open);
  assert.equal(open.activity, 'open');
  assert.equal(open.live, true);
  assert.equal(open.cwd, '/Users/someone/Projects/Beta', 'cwd falls back to the git root.');
  assert.equal(s.get(ids.oldOpen).activity, 'open', 'An open chat is listed however old its last activity.');
  assert.equal(s.get(ids.archivedOpen).archived, true);
  assert.equal(s.get(ids.archivedOpen).live, true);

  assert.equal(s.get(ids.unread).unread, true);
  assert.equal(s.get(ids.unread).activity, 'quiet');
  assert.equal(s.get(ids.markedUnread).unread, true, 'last_read_at 0 means marked unread.');
  assert.equal(s.get(ids.open).unread, false, 'NULL last_read_at means read.');

  for (const id of [ids.dead, ids.expired]) {
    assert.equal(s.get(id).activity, 'interrupted');
    assert.equal(s.get(id).reason, 'Interrupted when the app closed');
    assert.equal(s.get(id).confidence, 'inferred');
    assert.equal(s.get(id).live, false);
  }
  const fork = s.get(ids.fork);
  assert.equal(fork.activity, 'quiet', "A branch does not inherit its parent's turn.");
  assert.equal(fork.title, null, "A branch does not borrow its parent's title.");
  assert.equal(s.get(ids.cli).surface, 'cli');
  assert.equal(s.get(ids.cron).surface, 'background');

  const text = JSON.stringify(result);
  assert.ok(!text.includes(SECRET));
  assert.deepEqual(await listing(dir), before);
});

test('Hermes: SQL never selects conversation text and rows carry only listed fields', async t => {
  const { home } = await hermesFixture(t);
  for (const { sql } of hermesStatements({ since: 0, activeIds: [] })) {
    assert.doesNotMatch(sql, /messages|system_prompt|last_activity_description|origin_json|tool_names|SELECT\s+\*|\.\*/);
    assert.doesNotMatch(sql, /(SELECT|,)\s*(\w+\.)?model_config\s*(AS|,|FROM)/i);
  }
  const snapshots = fakeSnapshots();
  await readHermesSessions({ homeDir: home, now: NOW, processes: hermesProcs(), snapshots });
  const raw = await fakeSnapshots().query(snapshots.calls[0].dbPath, snapshots.calls[0].statements);
  assert.ok(!JSON.stringify(raw).includes(SECRET));
  assert.deepEqual(Object.keys(raw.sessions[0]).sort(), ['archived', 'chain_ids', 'cwd', 'git_branch', 'git_repo_root', 'id', 'last_read_at', 'model', 'pinned', 'root_id', 'root_started_at', 'root_title', 'source', 'started_at', 'title', 'updated_at'].sort());
  assert.deepEqual(Object.keys(raw.leases[0]).sort(), ['acquired_at', 'conversation_id', 'expires_at', 'holder']);
});

test('Hermes: live chat list needs a live pid and a matching start time', () => {
  const json = { entries: [
    { session_id: '20260917_100000_aaaaa2', pid: 7, process_start_time: 1000.5 },
    { session_id: '20260917_100000_aaaaa3', pid: 7, process_start_time: 1003.5 },
    { session_id: '20260917_100000_aaaaa4', pid: 8, process_start_time: null },
    { session_id: '20260917_100000_aaaaa5', pid: 9 },
    { session_id: 'bad', pid: 7 },
    'junk', null,
  ] };
  const live = liveActiveSessions(json, procs({ pid: 7, startedAt: 1000000, comm: '/x' }, { pid: 8, startedAt: 5, comm: '/y' }));
  assert.deepEqual(live.map(entry => entry.sessionId), ['20260917_100000_aaaaa2', '20260917_100000_aaaaa4']);
  assert.deepEqual(liveActiveSessions(null, new Map()), []);
});

test('Hermes: closed app, cache gating and the open-chat file', async t => {
  const { home, dir, ids } = await hermesFixture(t);
  const snapshots = fakeSnapshots();
  const reader = createHermesReader({ homeDir: home, snapshots });
  const closed = await reader.read({ now: NOW, processes: new Map() });
  assert.deepEqual(closed.sources, [{ app: 'hermes', label: 'Hermes', available: true, running: false, detail: 'Hermes is closed, so nothing there is running.' }]);
  const s = byId(closed.sessions);
  assert.equal(s.get(ids.tip).activity, 'interrupted', 'A lease whose process is gone reads as cut off.');
  assert.equal(s.has(ids.oldOpen), false);
  assert.ok(closed.sessions.every(session => !session.live));

  const appOnly = await reader.read({ now: NOW + 1000, processes: procs({ pid: 22, startedAt: NOW - MIN, comm: HERMES_BIN }) });
  assert.equal(snapshots.calls.length, 1, 'Unchanged files are not snapshotted again.');
  assert.equal(appOnly.sources[0].running, true);

  await fs.writeFile(path.join(dir, 'runtime', 'active_sessions.json'), JSON.stringify({ entries: [] }));
  const after = await reader.read({ now: NOW + 2000, processes: hermesProcs() });
  assert.equal(snapshots.calls.length, 2, 'A changed open-chat file re-queries.');
  assert.equal(byId(after.sessions).get(ids.open).activity, 'quiet');
  assert.equal(byId(after.sessions).get(ids.tip).activity, 'working');

  await fs.writeFile(path.join(dir, 'runtime', 'active_sessions.json'), '{not json');
  const broken = await reader.read({ now: NOW + 3000, processes: hermesProcs() });
  assert.deepEqual(broken.warnings, ["Hermes's open-chat list could not be read."]);
  assert.ok(broken.sessions.length > 0);
});

test('Hermes: a pipe left where the open-chat file belongs does not wedge the read', { skip: process.platform === 'win32' }, async t => {
  const { home, dir } = await hermesFixture(t);
  const file = path.join(dir, 'runtime', 'active_sessions.json');
  await fs.rm(file);
  // Anything running as this user can put a named pipe here; opening one for reading waits for a writer that never comes.
  execFileSync('/usr/bin/mkfifo', [file]);
  const snapshots = fakeSnapshots();
  const reader = createHermesReader({ homeDir: home, snapshots });
  const late = Symbol('late');
  let timer;
  const result = await Promise.race([
    reader.read({ now: NOW, processes: hermesProcs() }),
    new Promise(resolve => { timer = setTimeout(resolve, 3000, late); }),
  ]);
  clearTimeout(timer);
  assert.notEqual(result, late, 'the read returns instead of waiting on the pipe');
  assert.deepEqual(result.warnings, ["Hermes's open-chat list could not be read."]);
  assert.ok(result.sessions.length > 0, 'the rest of Hermes still reads');
});

test('Hermes: an older schema falls back to the columns it has', async t => {
  const { home, dbPath, ids } = await hermesFixture(t, { legacy: true });
  const snapshots = fakeSnapshots();
  const reader = createHermesReader({ homeDir: home, snapshots });
  const result = await reader.read({ now: NOW, processes: new Map() });
  assert.deepEqual(result.warnings, ['Some Hermes details are missing in this Hermes version.']);
  assert.deepEqual(snapshots.calls.map(call => call.names), [['sessions', 'leases', 'heartbeats'], ['tables'], ['sessions', 'tables']]);
  const s = byId(result.sessions);
  assert.deepEqual([...s.keys()].sort(), [ids.tip, ids.cli].sort());
  assert.equal(s.get(ids.tip).title, 'Root title');
  assert.equal(s.get(ids.tip).startedAt, NOW - 3 * 60 * MIN);
  assert.equal(s.get(ids.cli).surface, 'cli');
  assert.equal(s.get(ids.cli).updatedAt, NOW - 60 * MIN);
  assert.ok(!JSON.stringify(result).includes(SECRET));
  const cached = await reader.read({ now: NOW + 1000, processes: new Map() });
  assert.equal(snapshots.calls.length, 3);
  assert.deepEqual(cached.warnings, ['Some Hermes details are missing in this Hermes version.']);

  // Hermes upgrades in place: the next changed read notices the full schema, and the one after uses the full query.
  const db = new DatabaseSync(dbPath);
  for (const column of ['git_branch TEXT', 'git_repo_root TEXT', 'model_config TEXT', 'pinned INTEGER DEFAULT 0', 'hidden INTEGER DEFAULT 0', 'last_read_at REAL']) db.exec(`ALTER TABLE sessions ADD COLUMN ${column}`);
  db.exec(HERMES_SCHEMA.split(';').filter(sql => /session_turn_leases|gateway_heartbeats/.test(sql)).join(';'));
  db.prepare('INSERT INTO session_turn_leases VALUES (?, ?, ?, ?)').run(ids.root, 'pid=500', sec(NOW - MIN), sec(NOW + 4 * MIN));
  db.close();
  const noticed = await reader.read({ now: NOW + 2000, processes: hermesProcs() });
  assert.deepEqual(noticed.warnings, ['Some Hermes details are missing in this Hermes version.']);
  const upgraded = await reader.read({ now: NOW + 3000, processes: hermesProcs() });
  assert.deepEqual(upgraded.warnings, []);
  assert.deepEqual(snapshots.calls.slice(3).map(call => call.names), [['sessions', 'tables'], ['sessions', 'leases', 'heartbeats']]);
  assert.equal(byId(upgraded.sessions).get(ids.tip).activity, 'working');
});

test('Hermes: column names from CREATE TABLE text', () => {
  const sql = 'CREATE TABLE sessions (id TEXT PRIMARY KEY, "source" TEXT NOT NULL, [model] TEXT, `title` TEXT DEFAULT \'a,b\', started_at REAL CHECK (started_at > 0), cost NUMERIC(10, 2), last_read_at REAL, UNIQUE (id, source), FOREIGN KEY (id) REFERENCES x(id))';
  assert.deepEqual([...columnsFromCreate(sql)], ['id', 'source', 'model', 'title', 'started_at', 'cost', 'last_read_at']);
  assert.deepEqual([...columnsFromCreate(null)], []);
  assert.deepEqual([...columnsFromCreate('garbage')], []);
});

test('Hermes: missing store and failed snapshot never throw', async t => {
  const empty = await tempHome(t);
  const missing = await readHermesSessions({ homeDir: empty, now: NOW, processes: new Map(), snapshots: fakeSnapshots() });
  assert.deepEqual(missing, { sessions: [], sources: [{ app: 'hermes', label: 'Hermes', available: false, running: false, detail: 'Hermes is not set up on this Mac.' }], warnings: [] });
  const { home } = await hermesFixture(t);
  const failed = await readHermesSessions({ homeDir: home, now: NOW, processes: hermesProcs(), snapshots: fakeSnapshots({ fail: new Error('disk full') }) });
  assert.deepEqual(failed.sessions, []);
  assert.deepEqual(failed.warnings, ["Hermes's session list could not be read. disk full"]);
  const badSchema = await readHermesSessions({ homeDir: home, now: NOW, processes: new Map(), snapshots: { query: async (db, statements) => { if (statements[0].name === 'tables') return { tables: [{ name: 'other', sql: null }] }; throw new Error('no such table: sessions'); } } });
  assert.deepEqual(badSchema.warnings, ["Hermes's session list could not be read. This Hermes version stores sessions in a format Summon does not know."]);
});

test('Both readers work through the real snapshot service (clone only, temp folder removed)', async t => {
  let createSqliteSnapshots;
  try { ({ createSqliteSnapshots } = await import('../src/core/sessions/sqlite-snapshot.mjs')); } catch { t.skip('The snapshot service is not built yet.'); return; }
  const cursor = await cursorFixture(t);
  const hermes = await hermesFixture(t);
  const tmpRoot = await tempHome(t);
  const snapshots = createSqliteSnapshots({ tmpRoot });
  t.after(() => snapshots.close());
  const cursorBefore = await listing(cursor.dir);
  const c = await readCursorSessions({ homeDir: cursor.home, now: NOW, processes: cursorRunning(), snapshots });
  assert.deepEqual(c.warnings, []);
  assert.equal(c.sessions.length, 9);
  assert.equal(byId(c.sessions).get(cursor.ids.generating).helpers, 2);
  assert.equal(byId(c.sessions).get(cursor.ids.worktree).worktreePath, '/Users/someone/.cursor/worktrees/alpha/glf');
  const h = await readHermesSessions({ homeDir: hermes.home, now: NOW, processes: hermesProcs(), snapshots });
  assert.deepEqual(h.warnings, []);
  assert.equal(h.sessions.length, 11);
  assert.equal(byId(h.sessions).get(hermes.ids.tip).activity, 'working');
  const legacy = await hermesFixture(t, { legacy: true });
  const l = await readHermesSessions({ homeDir: legacy.home, now: NOW, processes: new Map(), snapshots });
  assert.deepEqual(l.warnings, ['Some Hermes details are missing in this Hermes version.']);
  assert.equal(l.sessions.length, 2);
  assert.ok(!JSON.stringify([c, h, l]).includes(SECRET));
  assert.deepEqual(await listing(cursor.dir), cursorBefore);
  assert.deepEqual(await listing(tmpRoot), [], 'Snapshot folders are removed.');
});
