import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createClaudeReader, readClaudeSessions } from '../src/core/sessions/claude.mjs';
import { setSealedSegments } from '../src/core/workstreams.mjs';

// The sealed-folder guard is empty until configured; these fixtures seal any path segment containing 'sealed-client'.
setSealedSegments(['sealed-client']);

// Infra from section A. Tests fall back to tiny contract-equivalent fakes if a module is missing.
const leveldb = await import('../src/core/sessions/leveldb.mjs').catch(() => null);
const procs = await import('../src/core/sessions/processes.mjs').catch(() => null);
const isAlive = procs?.isAlive ?? ((processes, pid, { lstart } = {}) => {
  const found = processes.get(pid);
  return Boolean(found) && (!lstart || found.lstart.trim() === String(lstart).trim());
});

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.now();
const LSTART = 'Thu Sep 17 15:37:27 2026';
const OTHER_LSTART = 'Wed Sep 16 01:00:00 2026';
const ORIGIN = 'https://claude.ai';
const U = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LOCAL = n => `local_${U(n)}`;
const SECRETS = ['SECRET-USER-TEXT', 'SECRET-LAST-PROMPT', 'SECRET-PEER-TOKEN', 'SECRET-OAUTH', 'SECRET-ERROR', 'SECRET-OLD-TEXT', 'SECRET-WAITING', 'SECRET-QUEUE'];
const APP_CLI = '/Users/someone/Library/Application Support/Claude/claude-code/2.1.271/claude.app/Contents/MacOS/claude';

// Ids used by the main fixture.
const CLI = { A: U(1), B: U(2), C: U(3), D: U(4), E: U(5), F: U(6), G: U(7), H: U(8), I: U(9), J: U(10), K: U(11), PRIOR_K: U(12), L: U(13), N: U(14), P: U(15), Z: U(16), Q: U(17), R: U(18), O: U(19), SDK: U(20) };
const T = { T1: U(31), T2: U(32), T3: U(33), T4: U(34), T5: U(35), T6: U(36), T7: U(37), T8: U(38), T9: U(39) };
const D = { A: LOCAL(101), B: LOCAL(102), C: LOCAL(103), D: LOCAL(104), F: LOCAL(106), G: LOCAL(107), H: LOCAL(108), I: LOCAL(109), J: LOCAL(110), K: LOCAL(111), L: LOCAL(113), N: LOCAL(114), P: LOCAL(115), Z: LOCAL(116), Q: LOCAL(117), R: LOCAL(118), O: LOCAL(119), M: LOCAL(120) };

const write = async (file, content, mtimeMs) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  if (mtimeMs) await fs.utimes(file, new Date(mtimeMs), new Date(mtimeMs));
};
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const iso = ms => new Date(ms).toISOString();
const proc = (pid, comm, lstart = LSTART) => [pid, { pid, ppid: 1, startedAt: Date.parse(`${lstart} UTC`), lstart, comm }];

async function tempHome(t) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'summon-claude-')));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const support = path.join(home, 'Library', 'Application Support', 'Claude');
  return {
    home,
    support,
    registry: path.join(home, '.claude', 'sessions'),
    projects: path.join(home, '.claude', 'projects'),
    org: path.join(support, 'claude-code-sessions', 'acct-1', 'org-1'),
    org2: path.join(support, 'claude-code-sessions', 'acct-2', 'org-2'),
    leveldb: path.join(support, 'Local Storage', 'leveldb'),
  };
}

function registryRecord(pid, sessionId, extra = {}) {
  return {
    pid, sessionId, cwd: '/Users/someone/Projects/Harbor', startedAt: NOW - 2 * HOUR, procStart: LSTART, version: '2.1.271', peerProtocol: 1,
    kind: 'interactive', entrypoint: 'claude-desktop', pidDomain: 'x', messagingSocketPath: `/tmp/cc-socks/${pid}.sock`, name: `harbor-${pid}`,
    nameSource: 'derived', status: 'idle', updatedAt: NOW - MIN, statusUpdatedAt: NOW - 30 * MIN, ...extra,
  };
}
// Key order mirrors the app: the fields the reader needs sit in the first few hundred bytes, then a large config blob.
function desktopRecord(id, cli, extra = {}, { tail = {}, padFirst = false } = {}) {
  const head = { sessionId: id, cliSessionId: cli, cwd: '/Users/someone/Projects/Harbor', originCwd: '/Users/someone/Projects/Harbor', lastFocusedAt: NOW - DAY, createdAt: NOW - 3 * HOUR, lastActivityAt: NOW - HOUR, isArchived: false, title: 'A session', titleSource: 'auto', model: 'claude-opus-5', permissionMode: 'bypassPermissions', ...extra };
  const blob = { remoteMcpServersConfig: { servers: 'x'.repeat(4000), headers: { authorization: 'Bearer SECRET-OAUTH' } }, enabledMcpTools: {} };
  const body = padFirst ? { sessionId: id, ...blob, ...head, ...tail } : { ...head, ...blob, ...tail };
  if (cli === null) delete body.cliSessionId;
  return JSON.stringify(body);
}
function userLine(ts, extra = {}) {
  return { parentUuid: null, isSidechain: false, userType: 'external', cwd: '/Users/someone/Projects/Summon', sessionId: 'x', version: '2.1.218', gitBranch: 'feature/x', entrypoint: 'cli', type: 'user', message: { role: 'user', content: 'Please fix the session list' }, uuid: `u-${ts}`, timestamp: iso(ts), ...extra };
}
function assistantLine(ts, stop, extra = {}) {
  return { parentUuid: null, isSidechain: false, userType: 'external', cwd: '/Users/someone/Projects/Summon', sessionId: 'x', version: '2.1.218', gitBranch: 'feature/x', entrypoint: 'cli', type: 'assistant', message: { id: 'm', model: 'claude-opus-5', role: 'assistant', content: [{ type: stop === 'tool_use' ? 'tool_use' : 'text', text: 'The session list is updated' }], stop_reason: stop }, uuid: `a-${ts}`, timestamp: iso(ts), ...extra };
}

// The app's own diff counts, keyed '<local id>:owner/repo:branch'. Only numbers are ever stored here.
const diffStatsValue = (entries = {}) => JSON.stringify({ version: 1, state: { stats: entries } });
const DIFF_STATS = {
  [`${LOCAL(101)}:me/harbor:claude/upbeat-raman`]: { additions: 340, deletions: 20, fileCount: 12, hasChanges: true, updatedAt: NOW - 2 * MIN },
  [`${LOCAL(101)}:me/harbor:main`]: { additions: 4, deletions: 1, fileCount: 1, hasChanges: true, updatedAt: NOW - 3 * DAY },
  [`${LOCAL(102)}:me/harbor:main`]: { additions: 0, deletions: 0, fileCount: 0, hasChanges: false, updatedAt: NOW - MIN },
  'not-a-session-key': { additions: 9, deletions: 9, fileCount: 9, updatedAt: NOW },
  [`${LOCAL(103)}:me/harbor:main`]: { additions: 'many', deletions: null, fileCount: -3, updatedAt: NOW },
};
async function unreadStore(dir, ids, { seq = 5, name = '000003.log', older = null, diffs = DIFF_STATS } = {}) {
  const value = JSON.stringify({ version: 1, state: { unreadIds: ids, explicitUnreadIds: ids.slice(0, 1) } });
  if (leveldb?.encodeLogFileForTests) {
    const records = [];
    if (older) records.push({ key: 'epitaxy-unread-v1', value: JSON.stringify({ version: 1, state: { unreadIds: older, explicitUnreadIds: [] } }), seq: seq - 3 });
    records.push({ key: 'LSS-persisted.starred-local-code-sessions', value: JSON.stringify({ value: [], timestamp: 1 }), seq: seq - 1 });
    if (diffs) records.push({ key: 'session-diff-stats-store', value: diffStatsValue(diffs), seq: seq - 1 });
    records.push({ key: 'epitaxy-unread-v1', value, seq });
    await write(path.join(dir, name), leveldb.encodeLogFileForTests(records, { origin: ORIGIN }));
  } else {
    await write(path.join(dir, name), value);
    if (diffs) await write(path.join(dir, `diffs-${name}`), diffStatsValue(diffs));
  }
  await write(path.join(dir, 'LOCK'), '');
  await write(path.join(dir, 'CURRENT'), 'MANIFEST-000001\n');
}
// Without section A's reader, a fake that only answers for our fixture format.
async function fakeReadKeys(dir, { origin, keys }) {
  assert.equal(origin, ORIGIN);
  const out = new Map();
  for (const name of (await fs.readdir(dir)).filter(n => n.endsWith('.log')).sort()) {
    const text = await fs.readFile(path.join(dir, name), 'utf8');
    for (const key of keys) {
      if (key === 'epitaxy-unread-v1' && !name.startsWith('diffs-')) out.set(key, text);
      if (key === 'session-diff-stats-store' && name.startsWith('diffs-')) out.set(key, text);
    }
  }
  return out;
}
const readKeys = leveldb?.readLocalStorageKeys ?? fakeReadKeys;

async function mainFixture(t) {
  const f = await tempHome(t);
  const repo = '/Users/someone/Projects/Harbor';
  const worktree = `${repo}/.claude/worktrees/upbeat-raman`;
  // Live registry.
  const reg = (pid, sessionId, extra) => write(path.join(f.registry, `${pid}.json`), JSON.stringify(registryRecord(pid, sessionId, extra)));
  await reg(101, CLI.A, { cwd: worktree, status: 'busy', statusUpdatedAt: NOW - 12 * MIN });
  await reg(102, CLI.B, { status: 'waiting', waitingFor: 'permission prompt SECRET-WAITING'.slice(0, 17), statusUpdatedAt: NOW - 4 * MIN });
  await reg(103, CLI.C, { status: 'idle', statusUpdatedAt: NOW - 30 * MIN });
  await reg(104, CLI.D, { status: 'busy' }); // stale: pid 104 is gone
  await reg(105, CLI.E, { entrypoint: 'cli', status: 'busy', cwd: '/Users/someone/Projects/Summon' }); // pid reused by another process
  await reg(106, T.T1, { entrypoint: 'cli', status: 'busy', statusUpdatedAt: NOW - 3 * MIN, cwd: '/Users/someone/Projects/Summon', name: 'My rename', nameSource: 'user' });
  await write(path.join(f.registry, '107.json'), JSON.stringify({ pid: 107, sessionId: T.T2, cwd: '/Users/someone/Projects/Summon', startedAt: NOW - HOUR })); // old CLI
  await reg(108, CLI.SDK, { entrypoint: 'sdk-cli', status: 'busy' });
  await reg(109, CLI.Z, { kind: 'daemon', status: 'busy' });
  await write(path.join(f.registry, '110.json'), '{ not json');
  await write(path.join(f.registry, '110.3f2a9c.key'), 'SECRET-PEER-TOKEN');
  await write(path.join(f.registry, 'README.json'), '{"note":"not a registry file"}');
  await reg(111, T.T8, { kind: 'bg', entrypoint: 'cli', status: 'busy', cwd: '/Users/someone/Projects/Summon' });
  await reg(112, CLI.PRIOR_K, { status: 'idle' });
  await reg(113, U(99), { entrypoint: 'cli', status: 'busy', cwd: '/Users/someone/Archive/sealed-client/repo' });
  const processes = new Map([
    proc(1, '/Applications/Claude.app/Contents/MacOS/Claude'),
    proc(101, APP_CLI), proc(102, APP_CLI), proc(103, APP_CLI), proc(105, '/usr/bin/other', OTHER_LSTART),
    proc(106, '/Users/someone/.local/share/claude/versions/2.1.218'), proc(107, '/opt/homebrew/bin/claude'), proc(108, APP_CLI), proc(109, APP_CLI),
    proc(111, '/Users/someone/.local/share/claude/versions/2.1.218'), proc(112, APP_CLI), proc(113, '/Users/someone/.local/share/claude/versions/2.1.218'),
  ]);

  // Desktop session files.
  const desk = (id, cli, extra, options, dir = f.org, mtimeMs) => write(path.join(dir, `${id}.json`), desktopRecord(id, cli, extra, options), mtimeMs);
  const cleanTitle = `Fix\u0007 share\u202e links ${'x'.repeat(200)}`;
  await desk(D.A, CLI.A, { cwd: worktree, title: 'Fix share links', lastActivityAt: NOW - 2 * MIN, createdAt: NOW - HOUR }, { tail: { isStarred: true } });
  await desk(D.B, CLI.B, { title: cleanTitle, lastActivityAt: NOW - 5 * MIN });
  await desk(D.C, CLI.C, { title: 'Old warm session', lastActivityAt: NOW - 10 * DAY });
  await desk(D.D, CLI.D, { title: 'Stale registry', lastActivityAt: NOW - HOUR });
  await desk(D.F, CLI.F, { title: 'Unread old reply', lastActivityAt: NOW - 20 * DAY });
  await desk(D.G, CLI.G, { title: 'Archived unread', isArchived: true, lastActivityAt: NOW - HOUR });
  await desk(D.H, CLI.H, { title: 'Archived by index', lastActivityAt: NOW - HOUR });
  await write(path.join(f.org, `${D.I}.json`), `${desktopRecord(D.I, CLI.I, { lastActivityAt: NOW - 30 * DAY }).slice(0, 1500)} <<broken tail>>`);
  await desk(D.J, CLI.J, { title: 'Crashed', lastActivityAt: NOW - 6 * MIN }, { tail: { error: 'SECRET-ERROR happened', errorAt: NOW - 5 * MIN } });
  await desk(D.K, CLI.K, { title: 'Resumed session', lastActivityAt: NOW - 3 * HOUR }, { tail: { priorCliSessionIds: [CLI.PRIOR_K] } });
  await desk(D.L, CLI.L, { title: 'Deleted', lastActivityAt: NOW - HOUR });
  await write(path.join(f.org, `deleted_${U(113)}`), String(NOW));
  await write(path.join(f.org, `${D.M}.json.tmp`), desktopRecord(D.M, U(98), { title: 'Temp', lastActivityAt: NOW }));
  await desk(D.N, CLI.N, { title: 'Private', cwd: '/Users/someone/Archive/sealed-client/repo', lastActivityAt: NOW - HOUR });
  await desk(D.P, CLI.P, { title: '   ', lastActivityAt: NOW - 2 * HOUR });
  await desk(D.Z, CLI.Z, { title: 'Daemon held', lastActivityAt: NOW - 30 * DAY });
  // Q and R keep lastActivityAt past the 1 KB prefix: Q's file time rules it out, R needs the full parse.
  await desk(D.Q, CLI.Q, { title: 'Old without prefix time', lastActivityAt: NOW - 30 * DAY }, { padFirst: true }, f.org, NOW - 30 * DAY);
  await desk(D.R, CLI.R, { title: 'Recent without prefix time', lastActivityAt: NOW - HOUR }, { padFirst: true });
  await write(path.join(f.org, 'archived-sessions.idx'), JSON.stringify({ v: 1, archived: [D.H] }));
  await write(path.join(f.org, 'scheduled-tasks.json'), JSON.stringify({ scheduledTasks: [] }));
  await desk(D.O, CLI.O, { title: 'Other account', lastActivityAt: NOW - DAY }, {}, f.org2);
  await write(path.join(f.support, 'config.json'), JSON.stringify({ oauth: 'SECRET-OAUTH' }));
  await write(path.join(f.support, 'git-worktrees.json'), JSON.stringify({ worktrees: { 'upbeat-raman': { path: worktree, baseRepo: repo, branch: 'claude/upbeat-raman', name: 'upbeat-raman', leasedBy: D.A, autoTrusted: true } } }));
  await unreadStore(f.leveldb, [D.A, D.F, D.G, 'not-an-id'], { older: [D.B] });

  // Transcripts.
  const harbor = path.join(f.projects, '-Users-someone-Projects-Harbor');
  const summon = path.join(f.projects, '-Users-someone-Projects-Summon');
  const desktopLines = ts => jsonl([userLine(ts, { entrypoint: 'claude-desktop' }), assistantLine(ts + 1000, 'end_turn', { entrypoint: 'claude-desktop' })]);
  await write(path.join(harbor, `${CLI.A}.jsonl`), desktopLines(NOW - 3 * MIN));
  await write(path.join(harbor, CLI.A, 'subagents', 'agent-a1.jsonl'), '{}\n');
  await write(path.join(harbor, CLI.A, 'subagents', 'agent-a1.meta.json'), '{}');
  await write(path.join(harbor, CLI.A, 'subagents', 'agent-a2.jsonl'), '{}\n', NOW - 10 * MIN);
  await write(path.join(harbor, CLI.A, 'subagents', 'workflows', 'wf_1', 'agent-w1.jsonl'), '{}\n');
  await write(path.join(harbor, CLI.A, 'subagents', 'workflows', 'wf_1', 'journal.jsonl'), '{}\n');
  await write(path.join(harbor, `${CLI.D}.jsonl`), jsonl([userLine(NOW - 10 * MIN), assistantLine(NOW - 9 * MIN, 'end_turn')])); // imported into the app: not a terminal row
  await write(path.join(summon, `${T.T1}.jsonl`), jsonl([
    { type: 'custom-title', customTitle: 'Rename wins', sessionId: T.T1 },
    { type: 'ai-title', aiTitle: 'AI title', sessionId: T.T1 },
    userLine(NOW - 4 * MIN),
    { type: 'last-prompt', lastPrompt: 'SECRET-LAST-PROMPT', sessionId: T.T1 },
    { type: 'queue-operation', operation: 'enqueue', content: 'SECRET-QUEUE', timestamp: iso(NOW) },
    assistantLine(NOW - 3 * MIN, 'tool_use'),
  ]));
  await write(path.join(summon, `${T.T2}.jsonl`), jsonl([userLine(NOW - 2 * MIN), assistantLine(NOW - 90000, 'tool_use'), userLine(NOW - 5000, { toolUseResult: { stdout: 'SECRET-USER-TEXT' } })]));
  const filler = jsonl(Array.from({ length: 400 }, (_, i) => userLine(NOW - 5 * HOUR + i, { message: { role: 'user', content: [{ type: 'tool_result', content: `SECRET-OLD-TEXT ${'y'.repeat(150)}` }] } })));
  await write(path.join(summon, `${T.T3}.jsonl`), filler + jsonl([
    { type: 'ai-title', aiTitle: 'Tail title', sessionId: T.T3 },
    userLine(NOW - 2 * HOUR - MIN),
    assistantLine(NOW - 2 * HOUR, 'end_turn'),
    { type: 'last-prompt', lastPrompt: 'SECRET-LAST-PROMPT', sessionId: T.T3 },
  ]));
  await write(path.join(summon, `${T.T4}.jsonl`), jsonl([userLine(NOW - 10 * MIN, { entrypoint: 'sdk-cli' }), assistantLine(NOW - 9 * MIN, 'end_turn', { entrypoint: 'sdk-cli' })]));
  await write(path.join(summon, `${T.T5}.jsonl`), jsonl([userLine(NOW - 10 * MIN), assistantLine(NOW - 9 * MIN, 'end_turn')]));
  await write(path.join(summon, `${T.T5}.desktop-released.json`), JSON.stringify({ v: 1, releasedAt: NOW, reason: 'delete' }));
  await write(path.join(summon, `${T.T6}.jsonl`), jsonl([userLine(NOW - 3 * DAY), assistantLine(NOW - 3 * DAY + 1000, 'end_turn'), { type: 'custom-title', customTitle: 'Metadata only', sessionId: T.T6 }]));
  await write(path.join(summon, `${T.T7}.jsonl`), jsonl([userLine(NOW - 3 * DAY), assistantLine(NOW - 3 * DAY, 'end_turn')]), NOW - 3 * DAY);
  await write(path.join(summon, `${CLI.E}.jsonl`), jsonl([userLine(NOW - 31 * MIN), assistantLine(NOW - 30 * MIN, 'end_turn')]));
  await write(path.join(summon, `${T.T8}.jsonl`), jsonl([userLine(NOW - MIN), assistantLine(NOW - 50000, 'tool_use')]));
  await write(path.join(summon, 'notes.txt'), 'not a transcript');
  await write(path.join(f.projects, '-Users-someone-Archive-sealed-client-repo', `${T.T9}.jsonl`), jsonl([userLine(NOW - MIN)]));
  return { ...f, processes, repo, worktree, harbor, summon };
}

async function snapshotTree(root) {
  const out = new Map();
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { out.set(`${file}/`, 'dir'); await walk(file); continue; }
      const stat = await fs.stat(file);
      out.set(file, `${stat.size}:${stat.mtimeMs}:${(await fs.readFile(file)).toString('base64')}`);
    }
  }
  await walk(root);
  return out;
}

// Records every path the reader touches and fails on any write-shaped call while installed.
function spyFs(t) {
  const opened = [];
  const listed = [];
  const writes = [];
  const originals = {};
  const wrap = (name, fn) => { originals[name] = fs[name]; fs[name] = fn(originals[name]); };
  // A read is plain 'r' or the numeric read-only set the readers use (O_RDONLY | O_NOFOLLOW | O_NONBLOCK).
  const readOnlyFlags = flags => flags === 'r' || (typeof flags === 'number'
    && !(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND | fs.constants.O_EXCL)));
  wrap('open', original => async (file, flags = 'r', ...rest) => {
    if (!readOnlyFlags(flags)) writes.push(['open', String(file), flags]);
    opened.push(String(file));
    return original(file, flags, ...rest);
  });
  wrap('readFile', original => async (file, ...rest) => { opened.push(String(file)); return original(file, ...rest); });
  wrap('readdir', original => async (dir, ...rest) => { listed.push(String(dir)); return original(dir, ...rest); });
  for (const name of ['writeFile', 'appendFile', 'rename', 'rm', 'rmdir', 'unlink', 'mkdir', 'mkdtemp', 'copyFile', 'cp', 'truncate', 'utimes', 'chmod', 'chown', 'symlink', 'link', 'lchown', 'lutimes']) {
    if (typeof fs[name] !== 'function') continue;
    wrap(name, () => async (...args) => { writes.push([name, String(args[0])]); throw new Error(`write call ${name} is not allowed`); });
  }
  const restore = () => { for (const [name, fn] of Object.entries(originals)) fs[name] = fn; };
  t.after(restore);
  return { opened, listed, writes, restore };
}

const byId = result => new Map(result.sessions.map(item => [item.id, item]));
const deps = processes => ({ processes, isAlive, readLocalStorageKeys: readKeys });

test('Claude provider children retain lifecycle separately from parent and unknown is not completion', async t => {
  const f = await mainFixture(t);
  const reader = createClaudeReader({ homeDir: f.home, ...deps(f.processes) });
  const child = (id, extra = {}) => ({ id, type: 'Explore', cwd: f.worktree, state: 'working', stateAt: NOW - MIN,
    startedAt: NOW - 2 * MIN, updatedAt: NOW - MIN, endedAt: null, ...extra });
  const hook = { state: 'working', stateAt: NOW - 1000, children: [child('live'), child('ended', { state: 'ended', endedAt: NOW - 1000 }),
    child('stale', { updatedAt: NOW - HOUR }), child('private', { cwd: '/Users/x/sealed-client/project' })] };
  const result = byId(await reader.read({ hookStates: new Map([[CLI.A, hook]]) }));
  const parent = result.get(D.A);
  assert.equal(parent.activity, 'working');
  assert.equal(parent.helpers, 2, 'desktop hook overrides still retain the separately inferred transcript count');
  assert.deepEqual(parent.children.map(row => [row.id, row.activity, row.confidence]), [
    ['live', 'working', 'reported'], ['ended', 'quiet', 'reported'], ['stale', 'unknown', 'inferred'],
  ]);
  assert.equal(parent.children[0].parentSessionKey, `claude:desktop:${D.A}`);
  assert.equal(parent.children[0].key, `claude:child:${CLI.A}:live`);
  assert.equal(parent.children[1].endedAt, iso(NOW - 1000));
  assert.equal(parent.children[2].endedAt, null, 'silence never invents a stop or task completion');
  assert.ok(!JSON.stringify(parent.children).includes('sealed-client'));
  const after = byId(await reader.read({ hookStates: new Map([[CLI.A, { ...hook, state: 'ended', stateAt: NOW + 1 }]]) }));
  assert.equal(after.get(D.A).children[0].activity, 'unknown', 'a stopped parent is not evidence its child completed');
});

test('Claude reader: desktop, registry, unread, worktree and terminal sessions', async t => {
  const f = await mainFixture(t);
  const reader = createClaudeReader({ homeDir: f.home, ...deps(f.processes) });
  const result = await reader.read({ recentMs: 7 * DAY });
  assert.deepEqual(result.warnings, []);
  const s = byId(result);

  // A: live, busy, unread, pinned, worktree from git-worktrees.json, two live helpers.
  assert.deepEqual(Object.fromEntries(Object.entries(s.get(D.A)).filter(([key]) => key !== 'recentContext')), {
    app: 'claude', surface: 'desktop', id: D.A, title: 'Fix share links', hookSessionId: U(1), origin: null, titleSource: 'auto', cwd: f.worktree, worktreePath: f.worktree, branch: 'claude/upbeat-raman',
    startedAt: NOW - HOUR, updatedAt: NOW - 2 * MIN, activity: 'working', activitySince: NOW - 12 * MIN, reason: null,
    unread: true, archived: false, pinned: true, live: true, confidence: 'reported', helpers: 2, model: 'claude-opus-5',
    work: { added: 340, removed: 20, files: 12, area: null, scope: 'session', workstream: null, workstreamState: null },
    touchedPaths: null, touchedHashes: null, touchedFiles: null, touchedAt: null,
  });
  // B: waiting for a permission prompt; title cleaned and capped (older unread value lost to the newer one).
  const b = s.get(D.B);
  assert.equal(b.activity, 'needs-you');
  assert.equal(b.reason, 'Waiting for your OK');
  assert.equal(b.activitySince, NOW - 4 * MIN);
  assert.equal(b.unread, false);
  assert.equal([...b.title].length, 120);
  assert.match(b.title, /^Fix share links x+$/);
  // C: warm idle process on an old session.
  assert.equal(s.get(D.C).activity, 'open');
  assert.equal(s.get(D.C).live, true);
  assert.equal(s.get(D.C).activitySince, NOW - 30 * MIN);
  // D: stale registry record (pid gone) → quiet, not live.
  assert.equal(s.get(D.D).activity, 'quiet');
  assert.equal(s.get(D.D).live, false);
  assert.equal(s.get(D.D).activitySince, NOW - HOUR);
  // F: unread but old → still listed.
  assert.equal(s.get(D.F).unread, true);
  assert.equal(s.get(D.F).activity, 'quiet');
  // J: error after the last activity → failed, error text never kept.
  assert.equal(s.get(D.J).activity, 'failed');
  assert.equal(s.get(D.J).reason, 'Stopped with a problem');
  assert.equal(s.get(D.J).activitySince, NOW - 5 * MIN);
  // K: joined through priorCliSessionIds.
  assert.equal(s.get(D.K).live, true);
  assert.equal(s.get(D.K).activity, 'open');
  // P: blank title → null. R: time found by the full parse. O: second account folder.
  assert.equal(s.get(D.P).title, null);
  assert.equal(s.get(D.R).title, 'Recent without prefix time');
  assert.equal(s.get(D.R).updatedAt, NOW - HOUR);
  assert.equal(s.get(D.O).title, 'Other account');
  // Excluded: archived (flag and index), old, deleted tombstone, temp file, sealed folder, daemon-held, old without prefix time.
  for (const id of [D.G, D.H, D.I, D.L, D.M, D.N, D.Z, D.Q]) assert.equal(s.has(id), false, id);

  // Terminal: live busy session with custom title, branch and model from the tail.
  assert.deepEqual(Object.fromEntries(Object.entries(s.get(T.T1)).filter(([key]) => key !== 'recentContext')), {
    app: 'claude', surface: 'terminal', id: T.T1, title: 'Rename wins', origin: null, titleSource: 'user', cwd: '/Users/someone/Projects/Summon', worktreePath: null, branch: 'feature/x',
    startedAt: NOW - 2 * HOUR, updatedAt: NOW - 3 * MIN, activity: 'working', activitySince: NOW - 3 * MIN, reason: null,
    unread: false, archived: false, pinned: false, live: true, confidence: 'reported', helpers: 0, model: 'claude-opus-5',
    work: null, // the app counts diffs for its own sessions only, and never invents them for a terminal one
    touchedPaths: null, touchedHashes: null, touchedFiles: null, touchedAt: null,
  });
  // Old CLI without status or entrypoint: tail says the model is working → inferred.
  const t2 = s.get(T.T2);
  assert.equal(t2.surface, 'terminal');
  assert.equal(t2.activity, 'working');
  assert.equal(t2.confidence, 'inferred');
  assert.equal(t2.live, true);
  assert.equal(t2.activitySince, NOW - 5000);
  assert.equal(t2.title, null);
  // Recent terminal transcript nobody holds: quiet, title from ai-title in the last 64 KB.
  const t3 = s.get(T.T3);
  assert.equal(t3.activity, 'quiet');
  assert.equal(t3.live, false);
  assert.equal(t3.title, 'Tail title');
  assert.equal(t3.updatedAt, NOW - 2 * HOUR);
  assert.equal(t3.branch, 'feature/x');
  // pid reuse: the process start time does not match, so the session is not live and shows as a quiet transcript.
  assert.equal(s.get(CLI.E).live, false);
  assert.equal(s.get(CLI.E).activity, 'quiet');
  assert.equal(s.get(CLI.E).surface, 'terminal');
  // Background job.
  assert.equal(s.get(T.T8).surface, 'background');
  assert.equal(s.get(T.T8).activity, 'working');
  // Skipped transcripts: sdk-cli, desktop-released, metadata-only append, old, desktop-owned, sealed folder, sdk registry.
  for (const id of [T.T4, T.T5, T.T6, T.T7, T.T9, CLI.A, CLI.D, CLI.SDK, U(99)]) assert.equal(s.has(id), false, id);

  assert.equal(result.sessions.length, 15);
  // Ordering: needs-you/failed first, then unread, working, live, rest by time.
  assert.deepEqual(result.sessions.slice(0, 2).map(x => x.id).sort(), [D.B, D.J].sort());
  assert.deepEqual(result.sources, [
    { app: 'claude', label: 'Claude app', available: true, running: true, detail: '4 sessions open in the app, 1 working, 1 waiting on you.' },
    { app: 'claude', label: 'Claude in Terminal', available: true, running: true, detail: '3 sessions running in Terminal.' },
  ]);
});

test('Claude reader: never exposes secrets, private folders or tool output, and never writes', async t => {
  const f = await mainFixture(t);
  // A file-history line names a file and points at the backup that holds its contents. The name may be used; the
  // backup under ~/.claude/file-history/ never is.
  const historyDir = path.join(f.home, '.claude', 'file-history', 'backup-1');
  await write(path.join(historyDir, 'engine.ts'), 'SECRET-FILE-CONTENTS');
  await fs.appendFile(path.join(f.harbor, `${CLI.A}.jsonl`), jsonl([{
    type: 'file-history-delta', messageId: 'm1', snapshotMessageId: 's1', trackingPath: 'src/engine.ts',
    backup: { backupFileName: path.join(historyDir, 'engine.ts'), version: 1, backupTime: NOW, realParentDir: `${f.repo}/src` }, timestamp: iso(NOW - MIN),
  }]));
  const before = await snapshotTree(f.home);
  const spy = spyFs(t);
  const result = await readClaudeSessions({ homeDir: f.home, ...deps(f.processes) });
  spy.restore();
  const text = JSON.stringify(result);
  for (const secret of [...SECRETS, 'SECRET-FILE-CONTENTS']) assert.equal(text.includes(secret), false, secret);
  assert.equal(spy.opened.some(file => file.includes('file-history')), false, 'file-history backups hold file contents');
  assert.equal(text.includes('harbor-10'), false, 'derived registry names are not titles');
  assert.deepEqual(spy.writes, []);
  assert.equal(spy.opened.some(file => file.endsWith('.key')), false);
  assert.equal(spy.opened.some(file => file.endsWith('config.json') || file.endsWith('scheduled-tasks.json') || file.endsWith('README.json')), false);
  assert.equal([...spy.opened, ...spy.listed].some(file => /sealed-client/i.test(file)), false);
  assert.equal(spy.opened.some(file => file.endsWith('LOCK') || file.endsWith('.tmp') || file.endsWith('.meta.json') || file.includes('journal')), false);
  assert.equal(spy.opened.some(file => file.includes(T.T7)), false, 'old transcripts are only stat-ed');
  // The old session file is read once (1 KB prefix), the busy one twice (prefix + full parse).
  assert.equal(spy.opened.filter(file => file.endsWith(`${D.I}.json`)).length, 1);
  assert.equal(spy.opened.filter(file => file.endsWith(`${D.Q}.json`)).length, 1);
  assert.equal(spy.opened.filter(file => file.endsWith(`${D.A}.json`)).length, 2);
  const allowed = [f.registry, f.org, f.org2, f.leveldb, path.join(f.support, 'git-worktrees.json'), f.projects];
  for (const file of spy.opened) assert.ok(allowed.some(root => file === root || file.startsWith(`${root}/`)), file);
  assert.deepEqual(await snapshotTree(f.home), before, 'fixture files are byte-identical and nothing was added');
});

test('Claude reader: repeat reads are change-gated', async t => {
  const f = await mainFixture(t);
  const reader = createClaudeReader({ homeDir: f.home, ...deps(f.processes) });
  const first = await reader.read();
  const cold = reader.stats();
  assert.ok(cold.prefixReads >= 17 && cold.fullParses >= 12 && cold.tailReads >= 5 && cold.registryReads >= 10, JSON.stringify(cold));

  const second = await reader.read();
  const warm = reader.stats();
  assert.deepEqual(second, first);
  // editReads counts transcripts whose new bytes were read; editChecks counts the stat that decides that, which is the
  // whole cost of a warm pass.
  assert.deepEqual({ registryReads: warm.registryReads, prefixReads: warm.prefixReads, fullParses: warm.fullParses, tailReads: warm.tailReads, unreadReads: warm.unreadReads, editReads: warm.editReads }, { registryReads: 0, prefixReads: 0, fullParses: 0, tailReads: 0, unreadReads: 0, editReads: 0 });
  assert.ok(warm.editChecks > 0, JSON.stringify(warm));

  // The app saves atomically: write a temp file and rename it over the session file.
  const target = path.join(f.org, `${D.D}.json`);
  await fs.writeFile(`${target}.tmp`, desktopRecord(D.D, CLI.D, { title: 'Renamed later', lastActivityAt: NOW - MIN }));
  await fs.rename(`${target}.tmp`, target);
  const third = await reader.read();
  assert.equal(byId(third).get(D.D).title, 'Renamed later');
  assert.equal(reader.stats().prefixReads, 1);
  assert.equal(reader.stats().fullParses, 1);

  // A status change in the registry is picked up with one registry read.
  await fs.writeFile(path.join(f.registry, '103.json'), JSON.stringify(registryRecord(103, CLI.C, { status: 'waiting', waitingFor: 'input needed', statusUpdatedAt: NOW - MIN })));
  const fourth = await reader.read();
  assert.equal(byId(fourth).get(D.C).activity, 'needs-you');
  assert.equal(byId(fourth).get(D.C).reason, 'Asked you a question');
  assert.equal(reader.stats().registryReads, 1);
  assert.equal(reader.stats().prefixReads, 0);

  // Newer unread marks replace older ones; F (old and now read) drops out.
  await unreadStore(f.leveldb, [D.A], { seq: 50, name: '000005.log' });
  const fifth = await reader.read();
  assert.equal(reader.stats().unreadReads, 1);
  if (leveldb) assert.equal(byId(fifth).has(D.F), false);

  // A terminal transcript that grows is re-read.
  await fs.appendFile(path.join(f.summon, `${T.T3}.jsonl`), jsonl([{ type: 'custom-title', customTitle: 'Renamed in Terminal', sessionId: T.T3 }, userLine(NOW - MIN)]));
  const sixth = await reader.read();
  assert.equal(byId(sixth).get(T.T3).title, 'Renamed in Terminal');
  assert.equal(byId(sixth).get(T.T3).updatedAt, NOW - MIN);
  assert.equal(reader.stats().tailReads, 1);

  // Concurrent reads are serialized and agree.
  const [x, y] = await Promise.all([reader.read(), reader.read()]);
  assert.deepEqual(x, y);
});

test('Claude reader: unread marks that cannot be read give a warning and no unread flags', async t => {
  const f = await mainFixture(t);
  const failing = async () => { throw new Error('boom'); };
  const result = await readClaudeSessions({ homeDir: f.home, processes: f.processes, isAlive, readLocalStorageKeys: failing });
  assert.deepEqual(result.warnings, ["Claude's unread marks could not be read."]);
  assert.equal(result.sessions.some(item => item.unread), false);
  const s = byId(result);
  assert.equal(s.has(D.F), false, 'old sessions only listed for being unread drop out');
  assert.equal(s.get(D.A).activity, 'working');

  // Malformed values are a failure; no key at all just means nothing is unread.
  const odd = await readClaudeSessions({ homeDir: f.home, processes: f.processes, isAlive, readLocalStorageKeys: async () => new Map([['epitaxy-unread-v1', '{"state":7}']]) });
  assert.deepEqual(odd.warnings, ["Claude's unread marks could not be read."]);
  const none = await readClaudeSessions({ homeDir: f.home, processes: f.processes, isAlive, readLocalStorageKeys: async () => new Map() });
  assert.deepEqual(none.warnings, []);
  assert.equal(none.sessions.some(item => item.unread), false);
  // A missing store is a failure too.
  await fs.rm(f.leveldb, { recursive: true });
  const missing = await readClaudeSessions({ homeDir: f.home, processes: f.processes, isAlive, readLocalStorageKeys: readKeys });
  assert.deepEqual(missing.warnings, ["Claude's unread marks could not be read."]);
});

test('Claude reader: waiting reasons, old-CLI tail states and limits', async t => {
  const f = await tempHome(t);
  const cases = [
    ['permission prompt', 'Waiting for your OK'], ['sandbox request', 'Waiting for your OK'], ['worker request', 'Waiting for your OK'],
    ['input needed', 'Asked you a question'], ['dialog open', 'Asked you a question'], ['goal proposal', 'Asked you a question'],
    ['something new', 'Needs input'], [undefined, 'Needs input'],
  ];
  const processes = new Map();
  let pid = 200;
  for (const [waitingFor] of cases) {
    pid++;
    processes.set(...proc(pid, '/opt/homebrew/bin/claude'));
    await write(path.join(f.registry, `${pid}.json`), JSON.stringify(registryRecord(pid, U(pid), { entrypoint: 'cli', status: 'waiting', waitingFor })));
  }
  // Old CLI records (no status, no procStart) fall back to the transcript tail.
  const tails = {
    301: [jsonl([userLine(NOW - 5 * MIN), assistantLine(NOW - 4 * MIN, 'end_turn')]), 0, 'open', null],
    302: [jsonl([userLine(NOW - 5 * MIN), assistantLine(NOW - 4 * MIN, 'tool_use')]), NOW - 2 * MIN, 'needs-you', 'Waiting for your OK'],
    303: [jsonl([userLine(NOW - 5 * MIN), assistantLine(NOW - 4 * MIN, 'tool_use')]), 0, 'working', null],
    304: [jsonl([userLine(NOW - 5 * MIN), { type: 'system', subtype: 'api_error', timestamp: iso(NOW - 4 * MIN) }]), 0, 'failed', 'Stopped with a problem'],
    305: [jsonl([userLine(NOW - 5 * MIN), assistantLine(NOW - 4 * MIN, 'end_turn', { isApiErrorMessage: true })]), 0, 'failed', 'Stopped with a problem'],
    306: [jsonl([userLine(NOW - 40 * MIN)]), NOW - 40 * MIN, 'unknown', null],
    307: [jsonl([userLine(NOW - 5 * MIN), assistantLine(NOW - 4 * MIN, 'end_turn'), { type: 'system', subtype: 'stop_hook_summary', timestamp: iso(NOW - 4 * MIN) }]), 0, 'open', null],
  };
  const project = path.join(f.projects, '-Users-someone-Projects-Summon');
  for (const [id, [content, mtime]] of Object.entries(tails)) {
    processes.set(...proc(Number(id), '/opt/homebrew/bin/claude'));
    await write(path.join(f.registry, `${id}.json`), JSON.stringify({ pid: Number(id), sessionId: U(id), cwd: '/Users/someone/Projects/Summon', startedAt: NOW - HOUR }));
    await write(path.join(project, `${U(id)}.jsonl`), content, mtime || undefined);
  }
  // 308: sidechain lines never decide the state; a live helper keeps an ended turn working.
  processes.set(...proc(308, '/opt/homebrew/bin/claude'));
  await write(path.join(f.registry, '308.json'), JSON.stringify({ pid: 308, sessionId: U(308), startedAt: NOW - HOUR }));
  await write(path.join(project, `${U(308)}.jsonl`), jsonl([assistantLine(NOW - 4 * MIN, 'end_turn'), userLine(NOW - 3 * MIN, { isSidechain: true })]));
  await write(path.join(project, U(308), 'subagents', 'agent-x.jsonl'), '{}\n');

  const reader = createClaudeReader({ homeDir: f.home, processes, isAlive, readLocalStorageKeys: readKeys });
  const result = await reader.read();
  const s = byId(result);
  pid = 200;
  for (const [, reason] of cases) {
    pid++;
    assert.equal(s.get(U(pid)).activity, 'needs-you');
    assert.equal(s.get(U(pid)).reason, reason, String(pid));
    assert.equal(s.get(U(pid)).confidence, 'reported');
  }
  for (const [id, [, , activity, reason]] of Object.entries(tails)) {
    assert.equal(s.get(U(id)).activity, activity, id);
    assert.equal(s.get(U(id)).reason, reason, id);
    assert.equal(s.get(U(id)).confidence, 'inferred', id);
    assert.equal(s.get(U(id)).surface, 'terminal', id);
  }
  assert.equal(s.get(U(308)).activity, 'working');
  assert.equal(s.get(U(308)).helpers, 1);
  // No desktop folder: no warning about unread marks, and the app source says so.
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.sources[0], { app: 'claude', label: 'Claude app', available: false, running: false, detail: 'No Claude app sessions on this Mac.' });
  assert.equal(result.sources[1].detail, '16 sessions running in Terminal.');

  const capped = await reader.read({ limits: { sessions: 3 } });
  assert.equal(capped.sessions.length, 3);
  assert.ok(capped.sessions.every(item => item.activity === 'needs-you' || item.activity === 'failed'));
});

test('Claude reader: empty home, missing processes and failing helpers never throw', async t => {
  const f = await tempHome(t);
  const empty = await readClaudeSessions({ homeDir: f.home, processes: new Map(), isAlive, readLocalStorageKeys: readKeys });
  assert.deepEqual(empty, {
    sessions: [],
    sources: [
      { app: 'claude', label: 'Claude app', available: false, running: false, detail: 'No Claude app sessions on this Mac.' },
      { app: 'claude', label: 'Claude in Terminal', available: false, running: false, detail: 'Claude is not set up in Terminal on this Mac.' },
    ],
    warnings: [],
  });

  const full = await mainFixture(t);
  const rejected = Promise.reject(new Error('ps failed'));
  rejected.catch(() => {});
  const noProcesses = await readClaudeSessions({ homeDir: full.home, processes: rejected, isAlive, readLocalStorageKeys: readKeys });
  assert.deepEqual(noProcesses.warnings, ['Could not check which Claude sessions are running.']);
  assert.equal(noProcesses.sessions.some(item => item.live), false);
  // No process list at all is "we could not look", which is not the same answer as "the app is closed".
  assert.equal(noProcesses.sources[0].detail, 'Summon could not check whether the Claude app is running.');
  assert.equal(noProcesses.sources[1].detail, 'Summon could not check whether Claude is running in Terminal.');

  const throwing = await readClaudeSessions({ homeDir: full.home, processes: full.processes, isAlive: () => { throw new Error('bad'); }, readLocalStorageKeys: () => { throw new Error('bad'); } });
  assert.equal(throwing.sessions.some(item => item.live), false);
  assert.deepEqual(throwing.warnings, ["Claude's unread marks could not be read."]);

  // listProcesses is used when no process list is given; run is passed through untouched.
  const calls = [];
  const run = async () => ({ stdout: '', stderr: '' });
  const viaRun = await readClaudeSessions({ homeDir: full.home, run, listProcesses: async options => { calls.push(options.run); return full.processes; }, isAlive, readLocalStorageKeys: readKeys });
  assert.deepEqual(calls, [run]);
  assert.equal(byId(viaRun).get(D.A).activity, 'working');

  // Bad options are ignored rather than thrown; a relative home is refused instead of falling back to this Mac's home.
  const odd = await readClaudeSessions({ homeDir: full.home, now: 'soon', recentMs: -5, limits: { sessions: 'many', tailBytes: -1 }, processes: full.processes, isAlive, readLocalStorageKeys: readKeys });
  assert.equal(byId(odd).get(D.A).activity, 'working');
  const spy = spyFs(t);
  const relative = await readClaudeSessions({ homeDir: 'relative/home', processes: new Map(), isAlive, readLocalStorageKeys: readKeys });
  spy.restore();
  assert.deepEqual(relative.sessions, []);
  assert.deepEqual(relative.warnings, ['Claude sessions could not be checked right now.']);
  assert.deepEqual(spy.opened, []);
  assert.deepEqual(spy.listed, []);
});

test('Claude reader: a symlink planted under a session file name is not followed', async t => {
  const f = await tempHome(t);
  // Anything running as this user can drop a link here; the name alone must not decide what gets opened.
  // Shaped like a registry file, so following the link would put a session on the board (it does without O_NOFOLLOW).
  await write(path.join(f.support, 'config.json'), JSON.stringify({ ...registryRecord(4242, U(77), { entrypoint: 'cli', status: 'busy' }), oauth: 'SECRET-OAUTH' }));
  await fs.mkdir(f.registry, { recursive: true });
  await fs.symlink(path.join(f.support, 'config.json'), path.join(f.registry, '4242.json'));
  // A real registry file beside it proves the reader still works and only the link was refused.
  await write(path.join(f.registry, '4343.json'), JSON.stringify(registryRecord(4343, U(78), { entrypoint: 'cli', status: 'busy' })));
  const processes = new Map([proc(4242, APP_CLI), proc(4343, APP_CLI)]);
  const spy = spyFs(t);
  const result = await readClaudeSessions({ homeDir: f.home, ...deps(processes) });
  spy.restore();
  assert.equal(JSON.stringify(result).includes('SECRET-OAUTH'), false);
  assert.equal(byId(result).has(U(77)), false, 'the linked file is skipped');
  assert.equal(byId(result).get(U(78))?.activity, 'working', 'the real registry file still reads');
  assert.equal(spy.opened.some(file => file.endsWith('config.json')), false);
});

test("Claude reader: the app's own diff counts say what a session changed, and a broken store costs nothing", async t => {
  const f = await mainFixture(t);
  const result = await readClaudeSessions({ homeDir: f.home, ...deps(f.processes) });
  assert.deepEqual(result.warnings, []);
  const s = byId(result);
  assert.deepEqual(s.get(D.A).work, { added: 340, removed: 20, files: 12, area: null, scope: 'session', workstream: null, workstreamState: null },
    'the line the session touched last wins over the one it left on another branch');
  assert.deepEqual(s.get(D.B).work, { added: 0, removed: 0, files: 0, area: null, scope: 'session', workstream: null, workstreamState: null },
    'a session that has changed nothing yet still says so');
  assert.equal(s.get(D.C).work, null, 'counts that are not whole numbers are left out');
  assert.equal(s.get(T.T1).work, null, 'terminal sessions have no counts of their own');

  // A store that is missing, empty or in a shape we do not know is not a failure: counts go quiet, unread marks stay.
  const only = async (dir, { keys }) => { assert.deepEqual(keys, ['epitaxy-unread-v1', 'session-diff-stats-store']); return readKeys(dir, { origin: ORIGIN, keys: ['epitaxy-unread-v1'] }); };
  for (const store of [only, async () => new Map([['epitaxy-unread-v1', JSON.stringify({ state: { unreadIds: [D.A] } })], ['session-diff-stats-store', '{"state":{"stats":42}}']]),
    async () => new Map([['epitaxy-unread-v1', JSON.stringify({ state: { unreadIds: [D.A] } })], ['session-diff-stats-store', 'not json']])]) {
    const quiet = await readClaudeSessions({ homeDir: f.home, processes: f.processes, isAlive, readLocalStorageKeys: store });
    assert.deepEqual(quiet.warnings, []);
    assert.equal(byId(quiet).get(D.A).work, null);
    assert.equal(byId(quiet).get(D.A).unread, true, 'unread marks are read from the same call and still work');
  }

  // Nothing the store holds can carry text: only the four numbers ever reach a session.
  const shapes = new Set(result.sessions.map(item => item.work && Object.keys(item.work).sort().join(',')).filter(Boolean));
  assert.deepEqual([...shapes], ['added,area,files,removed,scope,workstream,workstreamState']);
});

test('Claude reader: a reused pid does not revive a record written long before that process started', async t => {
  const f = await tempHome(t);
  const stale = U(4242);
  const live = U(4243);
  // Old CLI records: no status and no procStart, so the pid on its own is all that identifies the process.
  const record = (pid, sessionId) => JSON.stringify({ pid, sessionId, cwd: '/Users/someone/Projects/Summon', startedAt: NOW - 3 * HOUR, entrypoint: 'cli' });
  await write(path.join(f.registry, '4242.json'), record(4242, stale), NOW - 3 * HOUR);
  await write(path.join(f.registry, '4243.json'), record(4243, live), NOW - 3 * HOUR);
  const processes = new Map([
    // 4242 went to something else minutes ago, hours after the record describing it was last written.
    [4242, { pid: 4242, ppid: 1, startedAt: NOW - MIN, lstart: LSTART, comm: '/opt/homebrew/bin/claude' }],
    [4243, { pid: 4243, ppid: 1, startedAt: NOW - 4 * HOUR, lstart: OTHER_LSTART, comm: '/opt/homebrew/bin/claude' }],
  ]);
  const result = await createClaudeReader({ homeDir: f.home, processes, isAlive, readLocalStorageKeys: readKeys }).read();
  const s = byId(result);
  assert.equal(s.get(stale), undefined, 'a reused pid does not put a dead session back on the board');
  assert.equal(s.get(live)?.live, true, 'a process already running when the record was written still counts');
  assert.equal(result.sources[1].detail, '1 session running in Terminal.');
});

test('Claude reader: recentMs window and archived live sessions', async t => {
  const f = await mainFixture(t);
  // Archive the live idle session C: still listed because a process holds it, never unread.
  await write(path.join(f.org, `${D.C}.json`), desktopRecord(D.C, CLI.C, { title: 'Old warm session', isArchived: true, lastActivityAt: NOW - 10 * DAY }));
  await unreadStore(f.leveldb, [D.C, D.F], { seq: 60, name: '000007.log' });
  const reader = createClaudeReader({ homeDir: f.home, ...deps(f.processes) });
  const narrow = await reader.read({ recentMs: 30 * MIN });
  const s = byId(narrow);
  assert.equal(s.get(D.C).archived, true);
  assert.equal(s.get(D.C).unread, false);
  assert.equal(s.get(D.C).live, true);
  // Quiet sessions older than the window drop out; live, unread and needs-you stay.
  assert.equal(s.has(D.D), false);
  assert.equal(s.has(D.R), false);
  assert.equal(s.has(T.T3), false, 'terminal transcripts use the smaller of recentMs and 24 h');
  assert.equal(s.has(D.B), true);
  assert.equal(s.has(D.J), true);
  if (leveldb) assert.equal(s.get(D.F).unread, true);
});

// ---- which files a session edited ----
// The two metadata line shapes, exactly as this Mac's transcripts write them.
const deltaLine = (ts, trackingPath, realParentDir) => ({
  type: 'file-history-delta', messageId: `m-${ts}`, snapshotMessageId: `s-${ts}`, trackingPath,
  backup: { backupFileName: `backup-${ts}.txt`, version: 3, backupTime: ts, realParentDir }, timestamp: iso(ts),
});
const snapshotLine = (ts, tracked) => ({
  type: 'file-history-snapshot', messageId: `m-${ts}`, isSnapshotUpdate: false,
  snapshot: { messageId: `m-${ts}`, timestamp: iso(ts), trackedFileBackups: Object.fromEntries(Object.entries(tracked).map(([name, dir]) => [name, { backupFileName: `b-${ts}`, version: 1, backupTime: ts, realParentDir: dir }])) },
});

test('Claude reader: touched paths come from file-history metadata only, newest first', async t => {
  const f = await mainFixture(t);
  const repoSrc = `${f.repo}/src`;
  // A relative trackingPath plus the real parent folder is the common shape; an absolute one appears too.
  await fs.appendFile(path.join(f.harbor, `${CLI.A}.jsonl`), jsonl([
    snapshotLine(NOW - 9 * MIN, { 'src/old.ts': repoSrc, [`${f.repo}/README.md`]: f.repo }),
    deltaLine(NOW - 8 * MIN, 'src/engine.ts', repoSrc),
    deltaLine(NOW - 7 * MIN, `${f.repo}/src/panel.tsx`, repoSrc),
    // Never travels: a secret by name, and anything under a sealed folder.
    deltaLine(NOW - 6 * MIN, '.env.local', repoSrc),
    deltaLine(NOW - 6 * MIN, 'keys.pem', repoSrc),
    deltaLine(NOW - 6 * MIN, 'notes.md', '/Users/someone/Archive/sealed-client/repo'),
    // The same file again: it moves to the front rather than appearing twice.
    deltaLine(NOW - 5 * MIN, 'old.ts', repoSrc),
  ]));
  const reader = createClaudeReader({ homeDir: f.home, ...deps(f.processes) });
  const s = byId(await reader.read({ recentMs: 7 * DAY }));
  assert.deepEqual(s.get(D.A).touchedPaths, [
    `${repoSrc}/old.ts`, `${repoSrc}/panel.tsx`, `${repoSrc}/engine.ts`, `${f.repo}/README.md`,
  ]);
  // A session with no file-history lines says nothing rather than guessing.
  assert.equal(s.get(T.T1).touchedPaths, null);
});

test('Claude reader: a growing transcript is read forward from where the last pass stopped', async t => {
  const f = await mainFixture(t);
  const file = path.join(f.harbor, `${CLI.A}.jsonl`);
  const src = `${f.repo}/src`;
  await fs.appendFile(file, jsonl([deltaLine(NOW - 9 * MIN, 'first.ts', src)]));
  const reader = createClaudeReader({ homeDir: f.home, ...deps(f.processes) });
  assert.deepEqual(byId(await reader.read()).get(D.A).touchedPaths, [`${src}/first.ts`]);
  const cold = reader.stats().editReads;
  assert.ok(cold >= 1, String(cold));

  // Nothing changed: the pass stats the file and reads no bytes at all.
  await reader.read();
  assert.equal(reader.stats().editReads, 0);
  assert.ok(reader.stats().editChecks > 0);

  // New bytes only: the earlier path is still known, so the answer spans more than one read.
  await fs.appendFile(file, jsonl([deltaLine(NOW - 4 * MIN, 'second.ts', src)]));
  const grown = byId(await reader.read()).get(D.A);
  assert.equal(reader.stats().editReads, 1);
  assert.deepEqual(grown.touchedPaths, [`${src}/second.ts`, `${src}/first.ts`]);

  // A rewritten file starts again from its tail; a half-written last line is picked up on the next pass.
  await fs.writeFile(file, jsonl([deltaLine(NOW - 3 * MIN, 'rewritten.ts', src)]).trimEnd());
  assert.deepEqual(byId(await reader.read()).get(D.A).touchedPaths, null);
  await fs.appendFile(file, '\n');
  assert.deepEqual(byId(await reader.read()).get(D.A).touchedPaths, [`${src}/rewritten.ts`]);
});

test('Claude reader: a rotated or half-written transcript never reads the middle of a line', async t => {
  const f = await mainFixture(t);
  const file = path.join(f.harbor, `${CLI.A}.jsonl`);
  const src = `${f.repo}/src`;
  const reader = createClaudeReader({ homeDir: f.home, ...deps(f.processes) });
  const paths = async () => byId(await reader.read()).get(D.A).touchedPaths;

  // Enough lines that any offset kept from the old file would land inside a line of the new one.
  await fs.appendFile(file, jsonl(Array.from({ length: 40 }, (_, i) => deltaLine(NOW - 9 * MIN + i, `old-${i}.ts`, src))));
  assert.equal((await paths()).length, 40);

  // Rotated: the name now points at a different file, longer than what the last pass had consumed. A remembered
  // offset would be read as new bytes and cut a line in half, so the new file is read from its own tail instead.
  const replacement = `${file}.new`;
  await fs.writeFile(replacement, jsonl(Array.from({ length: 60 }, (_, i) => deltaLine(NOW - 4 * MIN + i, `fresh-${i}.ts`, src))));
  await fs.rename(replacement, file);
  const rotated = await paths();
  assert.equal(rotated.length, 60, 'every line of the new file, and nothing carried over from the old one');
  assert.equal(rotated.some(item => item.includes('/old-')), false, 'nothing from the file that was replaced');
  assert.equal(rotated[0], `${src}/fresh-59.ts`, 'newest first');

  // Rotated to something shorter than the old offset: the same rule, read from the start of the new file.
  await fs.writeFile(replacement, jsonl([deltaLine(NOW - MIN, 'tiny.ts', src)]));
  await fs.rename(replacement, file);
  assert.deepEqual(await paths(), [`${src}/tiny.ts`]);

  // Grown by bytes that hold no newline at all: nothing is parsed and nothing is skipped, and the line arrives whole
  // on the pass after it is finished.
  const half = JSON.stringify(deltaLine(NOW, 'half-written.ts', src));
  await fs.appendFile(file, half.slice(0, half.length - 12));
  assert.deepEqual(await paths(), [`${src}/tiny.ts`], 'half a line is not a path');
  await fs.appendFile(file, `${half.slice(half.length - 12)}\n`);
  assert.deepEqual(await paths(), [`${src}/half-written.ts`, `${src}/tiny.ts`]);
});

test('Claude reader: the path list is capped and a cold read covers only the last editBytes', async t => {
  const f = await mainFixture(t);
  const file = path.join(f.harbor, `${CLI.A}.jsonl`);
  const src = `${f.repo}/src`;
  const many = Array.from({ length: 260 }, (_, i) => deltaLine(NOW - 300000 + i, `file-${String(i).padStart(4, '0')}.ts`, src));
  await fs.appendFile(file, jsonl(many));

  const reader = createClaudeReader({ homeDir: f.home, ...deps(f.processes) });
  const capped = byId(await reader.read()).get(D.A).touchedPaths;
  assert.equal(capped.length, 200, 'the list is capped at 200 paths');
  assert.equal(capped[0], `${src}/file-0259.ts`, 'newest first');
  assert.equal(capped.at(-1), `${src}/file-0060.ts`, 'the cap drops the oldest');

  // A smaller read window shows the same shape from the other end: only the tail of the file is ever read.
  const narrow = createClaudeReader({ homeDir: f.home, ...deps(f.processes), limits: { editBytes: 8 * 1024 } });
  const tail = byId(await narrow.read()).get(D.A).touchedPaths;
  assert.ok(tail.length > 0 && tail.length < 200, String(tail.length));
  assert.equal(tail[0], `${src}/file-0259.ts`);
  assert.equal(tail.includes(`${src}/file-0000.ts`), false);
});

// ---- what a session has backed up ----
// Claude names every file-history entry after the file it holds: the first 16 hex characters of sha256 of that file's
// absolute path, then '@v' and the version. The rule is written out again here, so the reader has to agree with it.
const entryName = (file, version) => `${createHash('sha256').update(file).digest('hex').slice(0, 16)}@v${version}`;
const entryHash = file => entryName(file, 1).slice(0, 16);
// File times survive a round trip through utimes to the nearest millisecond, which is all this asks of them.
const nearly = (actual, expected, message) => assert.ok(Math.abs(actual - expected) <= 1, `${message}: ${actual} is not ${expected}`);

test('Claude reader: files backed up are counted from the entry names, and the entries are never opened', async t => {
  const f = await mainFixture(t);
  const dir = path.join(f.home, '.claude', 'file-history', CLI.A);
  const files = [`${f.repo}/src/engine.ts`, `${f.repo}/src/panel.tsx`, `${f.repo}/README.md`];
  // One file with two versions, two with one each: three distinct files, four entries.
  await write(path.join(dir, entryName(files[0], 1)), 'SECRET-BACKUP-CONTENTS', NOW - 20 * MIN);
  await write(path.join(dir, entryName(files[0], 2)), 'SECRET-BACKUP-CONTENTS', NOW - 9 * MIN);
  await write(path.join(dir, entryName(files[1], 1)), 'SECRET-BACKUP-CONTENTS', NOW - 12 * MIN);
  await write(path.join(dir, entryName(files[2], 7)), 'SECRET-BACKUP-CONTENTS', NOW - 6 * MIN);
  // Anything that is not an entry is ignored, and a symlink wearing an entry's name is listed but never followed.
  await write(path.join(dir, 'notes.txt'), 'x', NOW - MIN);
  await write(path.join(dir, 'ZZZZZZZZZZZZZZZZ@v1'), 'x', NOW - MIN);
  await write(path.join(dir, `${entryHash('/Users/someone/skipped.ts')}@vx`), 'x', NOW - MIN);
  await fs.symlink(path.join(f.home, '.claude', 'sessions'), path.join(dir, entryName('/Users/someone/linked.ts', 1)));

  const spy = spyFs(t);
  const result = await readClaudeSessions({ homeDir: f.home, ...deps(f.processes) });
  spy.restore();
  const s = byId(result);
  const a = s.get(D.A);
  assert.deepEqual([...a.touchedHashes].sort(), files.map(entryHash).sort(), 'one hash per distinct file, and nothing else in the folder');
  assert.equal(a.touchedFiles, 3, 'three files, however many versions of them there are');
  nearly(a.touchedAt, NOW - 6 * MIN, 'the newest entry is when this session last wrote a file');
  // A session with no folder of its own says nothing rather than reporting zero.
  assert.equal(s.get(T.T1).touchedHashes, null);
  assert.equal(s.get(T.T1).touchedFiles, null);
  assert.equal(s.get(T.T1).touchedAt, null);
  // The folder is listed by name; not one entry in it is opened, and nothing they hold reaches the answer.
  assert.equal(spy.listed.includes(dir), true, 'the folder itself is listed');
  assert.equal(spy.opened.some(file => file.includes('file-history')), false, 'the entries hold the file contents');
  assert.equal(JSON.stringify(result).includes('SECRET-BACKUP-CONTENTS'), false);
  assert.deepEqual(spy.writes, []);
});

test('Claude reader: the backup index is capped, and a folder that has not changed is not listed again', async t => {
  const f = await mainFixture(t);
  const dir = path.join(f.home, '.claude', 'file-history', CLI.A);
  const many = Array.from({ length: 30 }, (_, i) => `${f.repo}/src/file-${String(i).padStart(3, '0')}.ts`);
  for (const [i, file] of many.entries()) await write(path.join(dir, entryName(file, 1)), 'x', NOW - (30 - i) * MIN);

  const reader = createClaudeReader({ homeDir: f.home, ...deps(f.processes) });
  const first = byId(await reader.read()).get(D.A);
  assert.equal(first.touchedFiles, 30);
  assert.equal(first.touchedHashes.length, 30);
  nearly(first.touchedAt, NOW - MIN, 'the newest entry');
  assert.equal(reader.stats().historyLists, 1);

  // Nothing changed: the folder is stat-ed and not listed, and the answer is the one already held.
  const again = byId(await reader.read()).get(D.A);
  assert.equal(reader.stats().historyLists, 0, 'an unchanged folder costs one stat');
  assert.ok(reader.stats().historyChecks > 0);
  assert.deepEqual(again.touchedHashes, first.touchedHashes);

  // A new entry changes the folder, so it is listed again and the count grows.
  await write(path.join(dir, entryName(`${f.repo}/src/new.ts`, 1)), 'x', NOW);
  const grown = byId(await reader.read()).get(D.A);
  assert.equal(reader.stats().historyLists, 1);
  assert.equal(grown.touchedFiles, 31);
  nearly(grown.touchedAt, NOW, 'the entry just written');

  // Caps: how many hashes travel, and how many entries are looked at at all.
  const fewer = createClaudeReader({ homeDir: f.home, ...deps(f.processes), limits: { historyHashes: 5 } });
  const capped = byId(await fewer.read()).get(D.A);
  assert.equal(capped.touchedHashes.length, 5, 'the list of hashes is capped');
  assert.equal(capped.touchedFiles, 31, 'the count is still the whole folder');
  const narrow = createClaudeReader({ homeDir: f.home, ...deps(f.processes), limits: { historyEntries: 4 } });
  const cut = byId(await narrow.read()).get(D.A);
  assert.equal(cut.touchedFiles, 31, 'the count is the whole folder however few entries are looked at');
  assert.equal(cut.touchedHashes.length, 4, 'and only the entries whose time was read can say what it is working on');
  nearly(cut.touchedAt, (await fs.stat(dir)).mtimeMs, "a listing cut short falls back to the folder's own time");
});

test('Claude reader: the files of the latest stretch of work are the ones that travel', async t => {
  const f = await mainFixture(t);
  const dir = path.join(f.home, '.claude', 'file-history', CLI.A);
  // Three files from the session's first day, two from the hour it is in now.
  const early = [`${f.repo}/src/old-a.ts`, `${f.repo}/src/old-b.ts`, `${f.repo}/src/old-c.ts`];
  const late = [`${f.repo}/src/new-a.ts`, `${f.repo}/src/new-b.ts`];
  for (const file of early) await write(path.join(dir, entryName(file, 1)), 'x', NOW - 3 * DAY);
  await write(path.join(dir, entryName(late[0], 1)), 'x', NOW - 25 * MIN);
  await write(path.join(dir, entryName(late[1], 1)), 'x', NOW - 4 * MIN);

  const reader = createClaudeReader({ homeDir: f.home, ...deps(f.processes) });
  const a = byId(await reader.read()).get(D.A);
  assert.deepEqual([...a.touchedHashes].sort(), late.map(entryHash).sort(), 'what it wrote three days ago does not say what it is on now');
  assert.equal(a.touchedFiles, 5, 'the count is still every file it has backed up');
  nearly(a.touchedAt, NOW - 4 * MIN, 'and the time is still the newest entry of all');

  // The window runs back from this session's own newest entry, not from the clock, so a wider one keeps them all.
  const wide = createClaudeReader({ homeDir: f.home, ...deps(f.processes), limits: { historyWindowMs: 7 * DAY } });
  const all = byId(await wide.read()).get(D.A);
  assert.equal(all.touchedHashes.length, 5);
  assert.equal(all.touchedFiles, 5);
  // Newest first, so the cap keeps the file it wrote last rather than whatever the listing returned first.
  const one = createClaudeReader({ homeDir: f.home, ...deps(f.processes), limits: { historyWindowMs: 7 * DAY, historyHashes: 1 } });
  assert.deepEqual(byId(await one.read()).get(D.A).touchedHashes, [entryHash(late[1])], 'the cap drops the oldest');
});

test('Claude reader: no backup folder, an unreadable one, or a file in its place all say nothing', async t => {
  const f = await mainFixture(t);
  const root = path.join(f.home, '.claude', 'file-history');
  // A file where the folder should be, and a folder holding nothing that is an entry.
  await write(path.join(root, CLI.A), 'not a folder');
  await write(path.join(root, T.T1, 'README.md'), 'x');
  const reader = createClaudeReader({ homeDir: f.home, ...deps(f.processes) });
  const s = byId(await reader.read());
  for (const id of [D.A, T.T1, T.T2]) {
    const item = s.get(id);
    assert.equal(item.touchedHashes, null, id);
    assert.equal(item.touchedFiles, null, id);
    assert.equal(item.touchedAt, null, id);
  }
  assert.deepEqual((await reader.read()).warnings, [], 'a missing folder is not a problem worth saying out loud');
});

test('Claude reader: hook states win over older or inferred records, an ended report closes the row, and Summon-launched rows say so', async t => {
  const f = await tempHome(t);
  const processes = new Map();
  const cli = (pid, sessionId, extra) => { processes.set(...proc(pid, '/opt/homebrew/bin/claude')); return write(path.join(f.registry, `${pid}.json`), JSON.stringify(registryRecord(pid, sessionId, { entrypoint: 'cli', cwd: '/Users/someone/Projects/Summon', ...extra }))); };
  await cli(401, U(401), { status: 'busy', statusUpdatedAt: NOW - 5 * MIN }); // a newer Stop report: open
  await cli(402, U(402), { status: 'busy', statusUpdatedAt: NOW - MIN }); // an older PermissionRequest report: the registry wins
  await cli(404, U(404), { status: 'idle', statusUpdatedAt: NOW - 20 * MIN }); // a working report 15 min old: ignored
  await cli(405, U(405), { status: 'busy', statusUpdatedAt: NOW - 5 * MIN }); // a newer SessionEnd report: no longer live
  await cli(406, U(406), { status: 'busy', statusUpdatedAt: NOW - 3 * MIN }); // a newer PermissionRequest report, from a Summon launch
  await cli(408, U(408), { status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: NOW - 4 * MIN }); // a newer PostToolUse report: working again
  // An old CLI without a status: the transcript tail guesses needs-you, the session itself reported open.
  processes.set(...proc(403, '/opt/homebrew/bin/claude'));
  await write(path.join(f.registry, '403.json'), JSON.stringify({ pid: 403, sessionId: U(403), cwd: '/Users/someone/Projects/Summon', startedAt: NOW - HOUR }));
  const project = path.join(f.projects, '-Users-someone-Projects-Summon');
  await write(path.join(project, `${U(403)}.jsonl`), jsonl([userLine(NOW - 5 * MIN), assistantLine(NOW - 4 * MIN, 'tool_use')]), NOW - 2 * MIN);
  await write(path.join(project, `${U(405)}.jsonl`), jsonl([userLine(NOW - 5 * MIN), assistantLine(NOW - 4 * MIN, 'end_turn')]), NOW - 4 * MIN);
  // A desktop row is joined through its CLI session id, which is what the hooks carry.
  processes.set(...proc(407, APP_CLI));
  await write(path.join(f.registry, '407.json'), JSON.stringify(registryRecord(407, U(407), { status: 'busy', statusUpdatedAt: NOW - 5 * MIN })));
  await write(path.join(f.org, `${LOCAL(407)}.json`), desktopRecord(LOCAL(407), U(407), { title: 'Desktop row' }));
  await unreadStore(f.leveldb, []);
  const hook = (state, reason, stateAt, launch = null) => ({ app: 'claude', state, reason, stateAt, launch, event: 'x', kind: null, toolName: null, cwd: null, eventAt: stateAt, firstAt: stateAt, events: 1 });
  const hookStates = new Map([
    [U(401), hook('open', null, NOW - MIN)],
    [U(402), hook('needs-you', 'Waiting for your OK', NOW - 2 * MIN)],
    [U(403), hook('open', null, NOW - 3 * MIN)],
    [U(404), hook('working', null, NOW - 15 * MIN)],
    [U(405), hook('ended', null, NOW - 10 * 1000)],
    [U(406), hook('needs-you', 'Waiting for your OK', NOW - MIN, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')],
    [U(407), hook('open', null, NOW - MIN)],
    [U(408), hook('working', null, NOW - MIN)],
  ]);
  const read = async states => byId(await createClaudeReader({ homeDir: f.home, processes, isAlive, readLocalStorageKeys: readKeys }).read({ hookStates: states }));
  const s = await read(hookStates);
  assert.equal(s.get(LOCAL(407)).hookSessionId, U(407), 'the internal desktop trace identity comes from the verified CLI join');
  const state = id => [s.get(id).activity, s.get(id).reason, s.get(id).confidence, s.get(id).live, s.get(id).origin];
  assert.deepEqual(state(U(401)), ['open', null, 'reported', true, null]);
  assert.equal(s.get(U(401)).activitySince, NOW - MIN, 'the row is timed from the report');
  assert.deepEqual(state(U(402)), ['working', null, 'reported', true, null], 'the registry moved after the report');
  assert.deepEqual(state(U(403)), ['open', null, 'reported', true, null], 'a report beats a guess from the transcript');
  assert.deepEqual(state(U(404)), ['open', null, 'reported', true, null], 'a stale working report says nothing');
  assert.deepEqual(state(U(405)), ['quiet', null, 'reported', false, null], 'an ended session is listed as finished, not running');
  assert.deepEqual(state(U(406)), ['needs-you', 'Waiting for your OK', 'reported', true, 'summon']);
  assert.ok(!/^probably/i.test(s.get(U(406)).reason));
  assert.deepEqual(state(LOCAL(407)), ['open', null, 'reported', true, null], 'a desktop row takes the report filed under its CLI id');
  assert.deepEqual(state(U(408)), ['working', null, 'reported', true, null], 'a tool ran after the approval');
  // Without hook states every row reads exactly as before.
  const plain = await read(undefined);
  const before = id => [plain.get(id).activity, plain.get(id).reason, plain.get(id).confidence, plain.get(id).live, plain.get(id).origin];
  assert.deepEqual(before(U(401)), ['working', null, 'reported', true, null]);
  assert.deepEqual(before(U(402)), ['working', null, 'reported', true, null]);
  assert.deepEqual(before(U(403)), ['needs-you', 'Waiting for your OK', 'inferred', true, null]);
  assert.deepEqual(before(U(404)), ['open', null, 'reported', true, null]);
  assert.deepEqual(before(U(405)), ['working', null, 'reported', true, null]);
  assert.deepEqual(before(U(406)), ['working', null, 'reported', true, null]);
  assert.deepEqual(before(LOCAL(407)), ['working', null, 'reported', true, null]);
  assert.deepEqual(before(U(408)), ['needs-you', 'Waiting for your OK', 'reported', true, null]);
});

test('Claude recent context follows later desktop turns and excludes metadata, summaries, tools and thinking', async t => {
  const f = await mainFixture(t);
  const reader = createClaudeReader({ homeDir: f.home, ...deps(f.processes) });
  const file = path.join(f.harbor, `${CLI.A}.jsonl`);
  const first = byId(await reader.read()).get(D.A);
  assert.equal(first.recentContext.messages[0].text, 'Please fix the session list');
  await fs.appendFile(file, jsonl([
    ...Array.from({ length: 8 }, (_, i) => userLine(NOW - 8000 + i * 100, { entrypoint: 'claude-desktop', message: { role: 'user', content: `Current goal step ${i}` } })),
    userLine(NOW - 1000, { isMeta: true, message: { content: 'SECRET metadata' } }),
    userLine(NOW - 900, { isCompactSummary: true, message: { content: 'SECRET compaction' } }),
    userLine(NOW - 800, { message: { content: '# AGENTS.md instructions for /repo\nSECRET instructions' } }),
    userLine(NOW - 700, { message: { content: [{ type: 'tool_result', content: 'SECRET output' }] } }),
    assistantLine(NOW - 600, 'end_turn', { message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'SECRET reasoning' }, { type: 'text', text: 'Now implementing evolving goals' }], stop_reason: 'end_turn' } }),
  ]));
  const changed = byId(await reader.read()).get(D.A);
  assert.equal(changed.title, first.title, 'reader preserves native names for the reasoning overlay');
  assert.equal(changed.recentContext.messages.length, 6);
  assert.equal(changed.recentContext.messages.at(-2).text, 'Current goal step 7');
  assert.equal(changed.recentContext.messages.at(-1).text, 'Now implementing evolving goals');
  assert.equal(changed.recentContext.updatedAt, NOW - 600);
  assert.doesNotMatch(JSON.stringify(changed.recentContext), /SECRET|Please fix the session list/);
  await fs.appendFile(file, jsonl(Array.from({ length: 8 }, (_, i) => assistantLine(NOW + i, 'end_turn', {
    message: { role: 'assistant', content: [{ type: 'text', text: `Progress update ${i}` }], stop_reason: 'end_turn' },
  }))));
  const busy = byId(await reader.read()).get(D.A).recentContext;
  assert.equal(busy.messages.length, 6);
  assert.deepEqual(busy.messages.map(item => item.text), ['Current goal step 7', 'Progress update 3', 'Progress update 4', 'Progress update 5', 'Progress update 6', 'Progress update 7']);
  assert.equal(busy.updatedAt, NOW + 7);
});
