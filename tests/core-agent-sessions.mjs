import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createAgentSessions } from '../src/core/agent-sessions.mjs';
import { createWorkInFlight } from '../src/core/work-in-flight.mjs';
import { createHash } from 'node:crypto';
import { setSealedSegments } from '../src/core/workstreams.mjs';

// The sealed-folder guard is empty until configured; these fixtures seal any path segment containing 'sealed-client'.
setSealedSegments(['sealed-client']);

const MIN = 60000;
const HOUR = 3600000;
// Local time, so day words ("yesterday", "Sep 12") do not depend on the machine's time zone.
const NOW = new Date(2026, 8, 17, 15, 0, 0).getTime();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const uuid = n => `0199${String(n).padStart(4, '0')}-aaaa-4bbb-8ccc-${String(n).padStart(12, '0')}`;
const SURFACE = { claude: 'desktop', codex: 'desktop', cursor: 'ide', hermes: 'desktop' };
const LABEL = { claude: 'Claude app', codex: 'Codex', cursor: 'Cursor', hermes: 'Hermes' };
const SESSION_KEYS = ['key', 'app', 'surface', 'appLabel', 'title', 'titleIsFallback', 'headline', 'titleIsAuto', 'project', 'placeId', 'repoId', 'placeLabel', 'folder', 'branch', 'group', 'activity', 'reason', 'stateText', 'sinceText', 'sinceAt', 'updatedAt', 'unread', 'pinned', 'live', 'confidence', 'helpers', 'work', 'workText', 'startedFrom', 'openable', 'openHint'].sort();
const WORK_KEYS = ['added', 'removed', 'files', 'area', 'scope', 'workstream', 'workstreamState', 'workstreamInferred', 'touchedFiles', 'touchedAt'].sort();

function raw(app, id, extra = {}) {
  return { app, surface: SURFACE[app], id, title: `Session ${id.slice(0, 12)}`, cwd: null, worktreePath: null, branch: null, startedAt: NOW - 3 * HOUR, updatedAt: NOW - 5 * MIN, activity: 'quiet', activitySince: null, reason: null, unread: false, archived: false, pinned: false, live: false, confidence: 'reported', helpers: 0, model: null, ...extra };
}
const answer = (app, sessions, extra = {}) => ({ sessions, sources: [{ app, label: LABEL[app], available: true, running: true, detail: null }], warnings: [], ...extra });

/** Readers backed by editable lists; calls are counted per app. */
function fakeReaders(lists = {}, { wrap = {} } = {}) {
  const calls = { claude: 0, codex: 0, cursor: 0, hermes: 0 };
  const seen = [];
  const readers = {};
  for (const app of Object.keys(calls)) {
    readers[app] = {
      read: async options => {
        calls[app] += 1;
        seen.push(options);
        if (wrap[app]) return wrap[app](calls[app], options);
        return answer(app, structuredClone(lists[app] || []));
      },
    };
  }
  return { readers, calls, seen, lists };
}

async function fixture(t, { lists, wrap, places = [], projects = [], privatePaths = {}, limits, dirs = [], listProcesses } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'summon-agent-sessions-')));
  for (const dir of dirs) await fs.mkdir(path.join(root, dir), { recursive: true });
  const dataDir = path.join(root, 'Data');
  let current = NOW;
  const fakes = fakeReaders(lists, { wrap });
  const privateCalls = [];
  const options = {
    dataDir, homeDir: root, run: async () => { throw new Error('Tests never run commands.'); }, now: () => current,
    getPlaces: async () => (typeof places === 'function' ? places(root) : places), getProjects: async () => (typeof projects === 'function' ? projects(root) : projects),
    readers: fakes.readers, privatePathsFor: repoPath => { privateCalls.push(repoPath); return (typeof privatePaths === 'function' ? privatePaths(root) : privatePaths)[repoPath] || []; },
    listProcesses: listProcesses ?? (async () => new Map([[1, { pid: 1, ppid: 0, startedAt: NOW - HOUR, lstart: 'Thu Sep 17 14:00:00 2026', comm: '/sbin/launchd' }]])),
    snapshots: { query: async () => { throw new Error('Tests never open databases.'); }, close() {} },
    readLocalStorageKeys: async () => new Map(),
    limits,
  };
  const svc = await createAgentSessions(options);
  t.after(async () => { await svc.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, dataDir, svc, fakes, privateCalls, file: path.join(dataDir, 'agent-sessions.json'), setNow: value => { current = value; } };
}
const byKey = view => Object.fromEntries(view.groups.flatMap(group => group.sessions.map(item => [item.key, item])));

test('sessions are grouped in order with plain words and sorted by what matters', async t => {
  const lists = {
    claude: [
      raw('claude', 'local_aaa-1', { title: 'Fix share links', activity: 'needs-you', reason: 'Waiting for your OK', activitySince: NOW - 3 * MIN, live: true }),
      raw('claude', 'local_aaa-2', { activity: 'needs-you', reason: 'Asked you a question', activitySince: NOW - 10 * MIN, live: true }),
      raw('claude', 'local_aaa-3', { title: 'Collector memory', activity: 'working', activitySince: NOW - 12 * MIN, live: true, helpers: 2, pinned: true, branch: 'fix/memory' }),
      raw('claude', uuid(6), { surface: 'terminal', activity: 'open', live: true }),
      raw('claude', 'local_aaa-4', { updatedAt: new Date(2026, 8, 16, 20, 0).getTime() }),
      raw('claude', 'local_aaa-5', { archived: true, unread: true }),
    ],
    codex: [
      raw('codex', uuid(1), { activity: 'failed', reason: null, updatedAt: NOW - MIN }),
      raw('codex', uuid(2), { activity: 'needs-you', reason: 'Probably waiting for your OK', confidence: 'inferred', activitySince: NOW - 30000 }),
      raw('codex', uuid(5), { title: null, activity: 'working', updatedAt: NOW - 20000, live: true }),
      raw('codex', uuid(8), { surface: 'cli', updatedAt: NOW - 2 * HOUR }),
      raw('codex', uuid(10), { surface: 'background', activity: 'working', live: true }),
    ],
    cursor: [
      raw('cursor', uuid(3), { unread: true, updatedAt: NOW - 5 * MIN }),
      raw('cursor', uuid(4), { unread: true, updatedAt: NOW - 2 * MIN }),
      raw('cursor', uuid(7), { activity: 'interrupted', reason: 'Interrupted when the app closed', updatedAt: NOW - 30 * MIN }),
      raw('cursor', uuid(9), { updatedAt: NOW - 25 * HOUR }),
    ],
    hermes: [
      raw('hermes', '20260917_140000_abcdef', { activity: 'working', unread: true, live: true, activitySince: NOW - 40 * MIN }),
      raw('hermes', '20260917_141000_abcdef', { activity: 'quiet', live: true }),
      raw('hermes', '20260916_090000_abcdef', { updatedAt: NOW - 30 * HOUR }),
    ],
  };
  const f = await fixture(t, { lists });
  const view = await f.svc.read();
  assert.equal(view.version, 1);
  assert.equal(view.checkedAt, new Date(NOW).toISOString());
  assert.deepEqual(view.groups.map(group => [group.id, group.title]), [['needs-you', 'Needs you'], ['new', 'New replies'], ['working', 'Working'], ['open', 'Open, your move'], ['interrupted', 'Interrupted'], ['recent', 'Last 24 hours']]);
  const keys = Object.fromEntries(view.groups.map(group => [group.id, group.sessions.map(item => item.key)]));
  assert.deepEqual(keys['needs-you'], ['claude:desktop:local_aaa-2', 'claude:desktop:local_aaa-1', `codex:desktop:${uuid(1)}`, `codex:desktop:${uuid(2)}`], 'The session waiting longest comes first.');
  assert.deepEqual(keys.new, [`cursor:ide:${uuid(4)}`, `cursor:ide:${uuid(3)}`], 'The newest reply comes first.');
  assert.deepEqual(keys.working, ['hermes:desktop:20260917_140000_abcdef', 'claude:desktop:local_aaa-3', `codex:desktop:${uuid(5)}`], 'The longest-running session comes first; background jobs are hidden.');
  assert.deepEqual(keys.open, [`claude:terminal:${uuid(6)}`, 'hermes:desktop:20260917_141000_abcdef']);
  assert.deepEqual(keys.interrupted, [`cursor:ide:${uuid(7)}`]);
  assert.deepEqual(keys.recent, [`codex:cli:${uuid(8)}`, 'claude:desktop:local_aaa-4']);
  assert.deepEqual(view.totals, { needsYou: 4, newReplies: 2, working: 3, open: 2 });

  const s = byKey(view);
  assert.deepEqual(Object.keys(s['claude:desktop:local_aaa-1']).sort(), SESSION_KEYS);
  assert.equal(s['claude:desktop:local_aaa-1'].stateText, 'Waiting for your OK · 3 min');
  assert.equal(s['claude:desktop:local_aaa-1'].reason, 'Waiting for your OK');
  assert.equal(s['claude:desktop:local_aaa-1'].sinceText, '3 min');
  assert.equal(s['claude:desktop:local_aaa-1'].sinceAt, new Date(NOW - 3 * MIN).toISOString());
  assert.equal(s['claude:desktop:local_aaa-1'].appLabel, 'Claude app');
  assert.equal(s['claude:desktop:local_aaa-1'].title, 'Fix share links');
  assert.equal(s['claude:desktop:local_aaa-1'].titleIsFallback, false);
  assert.equal(s['claude:desktop:local_aaa-2'].stateText, 'Asked you a question · 10 min');
  assert.equal(s[`codex:desktop:${uuid(1)}`].stateText, 'Stopped with a problem');
  assert.equal(s[`codex:desktop:${uuid(1)}`].reason, 'Stopped with a problem');
  assert.equal(s[`codex:desktop:${uuid(1)}`].activity, 'failed');
  assert.equal(s[`codex:desktop:${uuid(2)}`].stateText, 'Probably waiting for your OK · just now');
  assert.equal(s[`codex:desktop:${uuid(2)}`].confidence, 'inferred');
  assert.equal(s[`cursor:ide:${uuid(3)}`].stateText, 'New reply · 5 min ago');
  assert.equal(s[`cursor:ide:${uuid(3)}`].unread, true);
  assert.equal(s[`cursor:ide:${uuid(3)}`].appLabel, 'Cursor');
  assert.equal(s['claude:desktop:local_aaa-3'].stateText, 'Working · 12 min');
  assert.equal(s['claude:desktop:local_aaa-3'].helpers, 2);
  assert.equal(s['claude:desktop:local_aaa-3'].pinned, true);
  assert.equal(s['claude:desktop:local_aaa-3'].branch, 'fix/memory');
  assert.equal(s['hermes:desktop:20260917_140000_abcdef'].stateText, 'Working · 40 min');
  assert.equal(s['hermes:desktop:20260917_140000_abcdef'].unread, true, 'A working session with a new reply stays in Working, marked unread.');
  assert.equal(s['hermes:desktop:20260917_140000_abcdef'].appLabel, 'Hermes');
  assert.equal(s[`codex:desktop:${uuid(5)}`].stateText, 'Working · just started');
  assert.equal(s[`codex:desktop:${uuid(5)}`].title, 'Untitled Codex session');
  assert.equal(s[`codex:desktop:${uuid(5)}`].titleIsFallback, true);
  assert.equal(s[`claude:terminal:${uuid(6)}`].stateText, 'Open, your move');
  assert.equal(s[`claude:terminal:${uuid(6)}`].appLabel, 'Claude in Terminal');
  assert.equal(s[`cursor:ide:${uuid(7)}`].stateText, 'Interrupted when the app closed');
  assert.equal(s[`codex:cli:${uuid(8)}`].stateText, 'Last active 2 h ago');
  assert.equal(s[`codex:cli:${uuid(8)}`].appLabel, 'Codex in Terminal');
  assert.equal(s['claude:desktop:local_aaa-4'].stateText, 'Last active 19 h ago');
  assert.equal(s['claude:desktop:local_aaa-5'], undefined, 'Archived sessions that are not running are left out.');
  assert.equal(s[`cursor:ide:${uuid(9)}`], undefined, 'Sessions older than the recent window are left out.');
  assert.deepEqual(view.sources.map(source => source.label), ['Claude app', 'Codex', 'Cursor', 'Hermes']);
  assert.deepEqual(view.settings, { recentHours: 24, newReplyHours: 72, showQuiet: true, showBackground: false, trayCount: 'needs', pathAliases: {} });
  assert.deepEqual(view.warnings, []);
  for (const item of Object.values(s)) assert.ok(!item.stateText.includes(String.fromCharCode(0x2014)), 'No em dashes in shown words.');

  // Readers get the shared tools and the recent window.
  const options = f.fakes.seen[0];
  assert.equal(options.homeDir, f.root);
  assert.equal(typeof options.now, 'function');
  assert.equal(options.recentMs, 24 * HOUR);
  assert.ok(options.processes instanceof Map);
  assert.equal(typeof options.snapshots.query, 'function');
  assert.equal(typeof options.readLocalStorageKeys, 'function');

  // Background jobs appear when asked for.
  await f.svc.updateSettings({ showBackground: true });
  const withJobs = await f.svc.read({ maxAgeMs: 0 });
  assert.equal(byKey(withJobs)[`codex:background:${uuid(10)}`].appLabel, 'Codex in the background');
});

test('longer windows use day words and a matching group title', async t => {
  const lists = {
    claude: [
      raw('claude', 'local_old-1', { activity: 'working', live: true, activitySince: new Date(2026, 8, 12, 10, 0).getTime() }),
      raw('claude', 'local_old-2', { updatedAt: new Date(2026, 8, 16, 10, 0).getTime() }),
      raw('claude', 'local_old-3', { updatedAt: new Date(2026, 8, 12, 10, 0).getTime() }),
      raw('claude', 'local_old-4', { unread: true, updatedAt: new Date(2026, 8, 16, 9, 0).getTime() }),
    ],
  };
  const f = await fixture(t, { lists });
  await f.svc.updateSettings({ recentHours: 168 });
  const view = await f.svc.read();
  const s = byKey(view);
  assert.equal(s['claude:desktop:local_old-1'].stateText, 'Working · since Sep 12');
  assert.equal(s['claude:desktop:local_old-2'].stateText, 'Last active yesterday');
  assert.equal(s['claude:desktop:local_old-3'].stateText, 'Last active Sep 12');
  assert.equal(s['claude:desktop:local_old-4'].stateText, 'New reply · yesterday');
  assert.equal(view.groups.find(group => group.id === 'recent').title, 'Last 7 days');
  assert.equal(f.fakes.seen.at(-1).recentMs, 168 * HOUR);

  f.fakes.lists.claude = [raw('claude', 'local_new-1', { updatedAt: NOW - 2 * HOUR })];
  await f.svc.updateSettings({ recentHours: 5 });
  const today = await f.svc.read({ maxAgeMs: 0 });
  assert.deepEqual(today.groups.map(group => group.title), ['Earlier today']);
  f.fakes.lists.claude = [raw('claude', 'local_new-1', { updatedAt: NOW - 2 * HOUR }), raw('claude', 'local_new-2', { updatedAt: new Date(2026, 8, 16, 23, 0).getTime() })];
  await f.svc.updateSettings({ recentHours: 20 });
  assert.deepEqual((await f.svc.read({ maxAgeMs: 0 })).groups.map(group => group.title), ['Last 20 hours']);
});

test('folders join Work in flight places by longest prefix, moved folders and workspace names; sealed folders are dropped', async t => {
  const dirs = ['Projects/Harbor/web', 'Projects/Harbor/.claude/worktrees/upbeat-raman/src', 'Projects/Brawl Draft/server', 'Projects/Docs', 'Notes/sub', 'Scratch', 'sealed-client/real'];
  const places = root => [
    { id: 'place-main', repoId: 'harbor', repoName: 'Harbor', path: path.join(root, 'Projects/Harbor'), kind: 'main', label: 'Main folder', missing: false },
    { id: 'place-wt', repoId: 'harbor', repoName: 'Harbor', path: path.join(root, 'Projects/Harbor/.claude/worktrees/upbeat-raman'), kind: 'claude', label: 'Claude worktree · upbeat-raman', missing: false },
    { id: 'place-brawl', repoId: 'brawl', repoName: 'Brawl Draft', path: path.join(root, 'Projects/Brawl Draft'), kind: 'main', label: 'Main folder', missing: false },
    { id: 'place-docs', repoId: 'docs', repoName: 'Docs', path: path.join(root, 'Projects/Docs'), kind: 'main', label: 'Main folder', missing: false },
    { id: 'place-secret', repoId: 'p', repoName: 'P', path: path.join(root, 'sealed-client/real'), kind: 'main', label: 'Main folder', missing: false },
  ];
  const projects = root => [
    { id: 'harbor', name: 'Harbor', path: path.join(root, 'Projects/Harbor') },
    { id: 'brawl', name: 'Brawl Draft', path: path.join(root, 'Projects/Brawl Draft') },
    { id: 'notes', name: 'Notes', path: path.join(root, 'Notes') },
  ];
  const f = await fixture(t, { places, projects, dirs });
  const at = (...parts) => path.join(f.root, ...parts);
  await fs.symlink(at('Projects/Harbor'), at('link-harbor'));
  await fs.symlink(at('sealed-client/real'), at('sneaky'));
  f.fakes.lists.claude = [
    raw('claude', 'local_wt', { activity: 'working', live: true, cwd: at('Projects/Harbor'), worktreePath: at('Projects/Harbor/.claude/worktrees/upbeat-raman/src') }),
    raw('claude', 'local_main', { activity: 'working', live: true, cwd: at('Projects/Harbor') }),
    raw('claude', uuid(20), { surface: 'terminal', unread: true, cwd: null }),
    raw('claude', 'local_sealed', { activity: 'working', live: true, cwd: at('sealed-client/x') }),
    raw('claude', 'local_sneaky', { activity: 'working', live: true, cwd: at('sneaky') }),
    raw('claude', 'local_worktree_sealed', { activity: 'working', live: true, cwd: at('Projects/Harbor'), worktreePath: '/Volumes/Work/SEALED-CLIENT/wt' }),
  ];
  // Any folder whose name contains a sealed segment is sealed, not only a folder named exactly after it.
  f.fakes.lists.codex = [
    raw('codex', 'c-sealed-name', { activity: 'quiet', unread: true, cwd: '/Users/someone/Code/My SEALED-CLIENT app/web' }),
    raw('codex', uuid(21), { activity: 'working', live: true, cwd: at('link-harbor/web') }),
    raw('codex', uuid(22), { activity: 'working', live: true, cwd: '/Users/old/Brawlstars-Draft-Tool/server' }),
    raw('codex', uuid(23), { cwd: at('Projects/Harbor'), updatedAt: NOW - HOUR }),
  ];
  f.fakes.lists.cursor = [
    raw('cursor', uuid(24), { unread: true, cwd: at('Notes/sub') }),
    raw('cursor', uuid(25), { unread: true, cwd: at('Scratch') }),
    raw('cursor', uuid(26), { unread: true, cwd: at('Projects/Docs') }),
    raw('cursor', 'c-sealed-repo', { activity: 'quiet', unread: true, cwd: '/Users/someone/Desktop/sealed-client-frontandbackend' }),
  ];
  f.fakes.lists.hermes = [
    raw('hermes', '20260917_140000_abcdef', { activity: 'needs-you', reason: 'Needs input', cwd: at('Gone/brawl_draft') }),
    raw('hermes', '20260917_141000_abcdef', { live: true, cwd: at('Projects/Docs') }),
  ];
  await assert.rejects(f.svc.updateSettings({ pathAliases: { '/Users/old/x': at('sealed-client') } }), /never checks sealed/);
  await f.svc.updateSettings({ pathAliases: { '/Users/old/Brawlstars-Draft-Tool/': at('Projects/Brawl Draft') } });
  const view = await f.svc.read();
  const s = byKey(view);
  const wt = s['claude:desktop:local_wt'];
  assert.deepEqual([wt.placeId, wt.repoId, wt.project, wt.placeLabel, wt.folder], ['place-wt', 'harbor', 'Harbor', 'Claude worktree · upbeat-raman', '~/Projects/Harbor/.claude/worktrees/upbeat-raman/src'], 'A worktree inside the repository wins over the main folder.');
  assert.deepEqual([s['claude:desktop:local_main'].placeId, s['claude:desktop:local_main'].placeLabel], ['place-main', 'Main folder']);
  assert.deepEqual([s[`codex:desktop:${uuid(21)}`].placeId, s[`codex:desktop:${uuid(21)}`].folder], ['place-main', '~/Projects/Harbor/web'], 'Symlinked folders match by real path.');
  assert.deepEqual([s[`codex:desktop:${uuid(22)}`].placeId, s[`codex:desktop:${uuid(22)}`].project, s[`codex:desktop:${uuid(22)}`].folder], ['place-brawl', 'Brawl Draft', '~/Projects/Brawl Draft/server'], 'Moved folders follow the alias.');
  assert.deepEqual([s['hermes:desktop:20260917_140000_abcdef'].placeId, s['hermes:desktop:20260917_140000_abcdef'].folder], ['place-brawl', '~/Projects/Brawl Draft'], 'A missing folder matches a workspace by name.');
  assert.deepEqual([s[`cursor:ide:${uuid(24)}`].placeId, s[`cursor:ide:${uuid(24)}`].project], [null, 'Notes'], 'Without a place, the workspace name is used.');
  assert.deepEqual([s[`cursor:ide:${uuid(25)}`].placeId, s[`cursor:ide:${uuid(25)}`].project], [null, 'Scratch'], 'Otherwise the folder name is used.');
  assert.deepEqual([s[`claude:terminal:${uuid(20)}`].project, s[`claude:terminal:${uuid(20)}`].folder], [null, null]);
  for (const key of ['claude:desktop:local_sealed', 'claude:desktop:local_sneaky', 'claude:desktop:local_worktree_sealed', 'cursor:ide:c-sealed-repo', 'codex:desktop:c-sealed-name']) assert.equal(s[key], undefined, `${key} is dropped.`);
  assert.equal(JSON.stringify(view).toLowerCase().includes('sealed-client'), false);
  assert.deepEqual(view.byPlace, {
    'place-wt': { working: 1, needsYou: 0, newReplies: 0, open: 0, apps: ['claude'], text: 'Claude working here' },
    'place-main': { working: 2, needsYou: 0, newReplies: 0, open: 0, apps: ['claude', 'codex'], text: '2 agents working here' },
    'place-brawl': { working: 1, needsYou: 1, newReplies: 0, open: 0, apps: ['codex', 'hermes'], text: 'Hermes needs you here' },
    'place-docs': { working: 0, needsYou: 0, newReplies: 1, open: 1, apps: ['cursor', 'hermes'], text: 'New reply from Cursor here' },
  }, 'Recent sessions are not counted on places.');
  assert.equal(s[`codex:desktop:${uuid(23)}`].group, 'recent');
});

test('agent reads mask the words about the work and say nothing at all from a private folder', async t => {
  const dirs = ['Projects/Harbor/clients/acme', 'Projects/Harbor/src'];
  const places = root => [
    { id: 'place-main', repoId: 'harbor', repoName: 'Harbor', path: path.join(root, 'Projects/Harbor'), kind: 'main', label: 'Main folder', missing: false, added: 0, removed: 0, files: 0, area: null, workstream: null, readiness: null },
    { id: 'place-acme', repoId: 'harbor', repoName: 'Harbor', path: path.join(root, 'Projects/Harbor/clients/acme'), kind: 'claude', label: 'Claude worktree · acme', missing: false,
      added: 12, removed: 2, files: 3, area: 'clients/acme', workstream: 'Acme pricing', readiness: 'ready' },
    { id: 'place-src', repoId: 'harbor', repoName: 'Harbor', path: path.join(root, 'Projects/Harbor/src'), kind: 'claude', label: 'Claude worktree · src', missing: false,
      added: 30, removed: 4, files: 5, area: 'src', workstream: 'Email bob@example.com about customers/list.csv', readiness: 'in-progress' },
  ];
  const g = await fixture(t, { places, dirs, privatePaths: root => ({ [path.join(root, 'Projects/Harbor')]: ['clients/'] }) });
  const repo = path.join(g.root, 'Projects/Harbor');
  g.fakes.lists.claude = [
    raw('claude', 'local_client', { activity: 'needs-you', title: 'Draft for Acme', cwd: path.join(repo, 'clients/acme'), work: { added: 9, removed: 1, files: 2 } }),
    raw('claude', 'local_src', { activity: 'needs-you', title: 'Share links', cwd: path.join(repo, 'src') }),
  ];
  const mine = byKey(await g.svc.read());
  assert.equal(mine['claude:desktop:local_client'].workText, 'Acme pricing (looks ready to save) · +9 −1 in 2 files', 'The owner sees their own folders as they are.');
  assert.equal(mine['claude:desktop:local_src'].work.scope, 'folder');

  const agent = byKey(await g.svc.read({ forAgent: true }));
  assert.equal(agent['claude:desktop:local_client'].work, null, 'a session in a private folder says nothing about its work');
  assert.equal(agent['claude:desktop:local_client'].workText, '');
  const src = agent['claude:desktop:local_src'];
  assert.match(src.work.workstream, /\[redacted\]/);
  assert.match(src.work.workstream, /\[private path\]/);
  assert.ok(!src.workText.includes('bob@example.com') && !src.workText.includes('customers/list'), src.workText);
  assert.ok(src.workText.length <= 90, src.workText);
  assert.deepEqual([src.work.added, src.work.removed, src.work.files, src.work.scope], [30, 4, 5, 'folder'], 'counts themselves are plain numbers');
});

test('agent reads mask secrets and private paths in titles, hide private folders, cap the list and skip recent', async t => {
  const dirs = ['Projects/Harbor/clients/acme', 'Projects/Harbor/src'];
  const places = root => [{ id: 'place-main', repoId: 'harbor', repoName: 'Harbor', path: path.join(root, 'Projects/Harbor'), kind: 'main', label: 'Main folder', missing: false }];
  const g = await fixture(t, { places, dirs, privatePaths: root => ({ [path.join(root, 'Projects/Harbor')]: ['clients/'] }) });
  const repo = path.join(g.root, 'Projects/Harbor');
  g.fakes.lists.claude = [
    raw('claude', 'local_mail', { activity: 'needs-you', title: 'Email bob@example.com about customers/list.csv', cwd: repo }),
    raw('claude', 'local_client', { activity: 'needs-you', title: 'Draft for Acme', cwd: path.join(repo, 'clients/acme') }),
    raw('claude', 'local_key', { activity: 'needs-you', title: 'Rotate sk-abcdefghijklmnopqrstuvwxyz123456', cwd: path.join(repo, 'src') }),
    raw('claude', 'local_recent', { cwd: repo, updatedAt: NOW - HOUR }),
    ...Array.from({ length: 70 }, (_, index) => raw('claude', `local_bulk-${index}`, { activity: 'working', live: true, activitySince: NOW - index * MIN, cwd: repo })),
  ];
  await g.svc.updateSettings({ pathAliases: { [path.join(g.root, 'old')]: path.join(g.root, 'new') } });
  const full = await g.svc.read();
  assert.equal(byKey(full)['claude:desktop:local_mail'].title, 'Email bob@example.com about customers/list.csv', 'The app itself shows the title as is.');
  assert.ok(full.groups.some(group => group.id === 'recent'));
  const agent = await g.svc.read({ forAgent: true });
  const s = byKey(agent);
  const mail = s['claude:desktop:local_mail'].title;
  assert.ok(!mail.includes('bob@example.com') && !mail.includes('customers/list'), mail);
  assert.match(mail, /\[redacted\]/);
  assert.match(mail, /\[private path\]/);
  assert.equal(s['claude:desktop:local_client'].title, 'Title hidden (private folder)');
  assert.equal(s['claude:desktop:local_client'].titleIsFallback, true);
  assert.ok(!s['claude:desktop:local_key'].title.includes('sk-abc'), s['claude:desktop:local_key'].title);
  assert.ok(g.privateCalls.includes(repo), 'Private folders are looked up by the repository path.');
  const sessions = agent.groups.flatMap(group => group.sessions);
  assert.equal(sessions.length, 60);
  assert.ok(sessions.every(item => item.folder === null && item.project === 'Harbor' && item.placeLabel === 'Main folder'));
  assert.deepEqual(agent.groups.map(group => group.id), ['needs-you', 'working']);
  assert.deepEqual(agent.totals, full.totals);
  // The recent session is left out on purpose; the note counts only what the cap cut.
  assert.ok(agent.warnings.includes('Showing 60 of 73 sessions.'), agent.warnings.join(' | '));
  assert.deepEqual(agent.settings.pathAliases, { '~/old': '~/new' });
  assert.ok(!JSON.stringify(agent).includes(g.root), 'No absolute home paths reach agents.');
  assert.ok(Buffer.byteLength(JSON.stringify(agent)) < 64 * 1024);

  // When only recent sessions exist, agents still see them.
  g.fakes.lists.claude = [raw('claude', 'local_recent', { cwd: repo, updatedAt: NOW - HOUR })];
  const quiet = await g.svc.read({ forAgent: true, maxAgeMs: 0 });
  assert.deepEqual(quiet.groups.map(group => group.id), ['recent']);

  // includeRecent keeps the recent group next to active ones; app narrows sessions, sources and totals before the cap.
  g.fakes.lists.claude = [raw('claude', 'local_recent', { cwd: repo, updatedAt: NOW - HOUR }), raw('claude', 'local_open', { activity: 'open', live: true, cwd: repo })];
  g.fakes.lists.codex = [raw('codex', uuid(40), { activity: 'working', live: true, cwd: repo })];
  const both = await g.svc.read({ forAgent: true, maxAgeMs: 0, includeRecent: true });
  assert.deepEqual(both.groups.map(group => group.id), ['working', 'open', 'recent']);
  assert.equal(both.warnings.some(item => item.startsWith('Showing')), false);
  const skipped = await g.svc.read({ forAgent: true });
  assert.deepEqual(skipped.groups.map(group => group.id), ['working', 'open']);
  assert.equal(skipped.warnings.some(item => item.startsWith('Showing')), false, 'leaving out recent sessions is not a cut');
  const codex = await g.svc.read({ forAgent: true, app: 'codex', includeRecent: true });
  assert.deepEqual(codex.groups.map(group => [group.id, group.sessions.map(item => item.app)]), [['working', ['codex']]]);
  assert.deepEqual(codex.totals, { needsYou: 0, newReplies: 0, working: 1, open: 0 });
  assert.deepEqual(codex.sources.map(source => source.app), ['codex']);
  const claude = await g.svc.read({ app: 'claude' });
  assert.deepEqual(claude.totals, { needsYou: 0, newReplies: 0, working: 0, open: 1 });
  for (const bad of [{ app: 'vscode' }, { app: '' }, { includeRecent: 'yes' }]) await assert.rejects(g.svc.read(bad), /must be/, JSON.stringify(bad));
});

test('a new Work in flight scan refreshes the folder join before the cached view expires', async t => {
  let list = [];
  const f = await fixture(t, { dirs: ['Projects/Demo'], places: root => list.map(place => ({ ...place, path: path.join(root, place.path) })), lists: { claude: [raw('claude', 'local_w', { activity: 'working', live: true })] } });
  f.fakes.lists.claude[0].cwd = path.join(f.root, 'Projects/Demo');
  const before = await f.svc.read();
  assert.deepEqual(before.byPlace, {});
  assert.equal(f.fakes.calls.claude, 1);
  await f.svc.read();
  assert.equal(f.fakes.calls.claude, 1, 'same folders: the young view is reused');
  list = [{ id: 'place-demo', repoId: 'demo', repoName: 'Demo', path: 'Projects/Demo', kind: 'main', label: 'Main folder', missing: false }];
  const after = await f.svc.read();
  assert.equal(f.fakes.calls.claude, 2, 'new folders: checked again');
  assert.equal(after.byPlace['place-demo'].text, 'Claude working here');
  await f.svc.read();
  assert.equal(f.fakes.calls.claude, 2);
  await f.svc.read({ maxAgeMs: Infinity });
  assert.equal(f.fakes.calls.claude, 2);
});

test('the per-folder counts go quiet once the last check is too old to speak for now', async t => {
  const places = root => [{ id: 'place-demo', repoId: 'demo', repoName: 'Demo', path: path.join(root, 'Projects/Demo'), kind: 'main', label: 'Main folder', missing: false }];
  const f = await fixture(t, { dirs: ['Projects/Demo'], places, lists: { claude: [raw('claude', 'local_w', { activity: 'working', live: true })] } });
  f.fakes.lists.claude[0].cwd = path.join(f.root, 'Projects/Demo');
  const view = await f.svc.read();
  assert.equal(view.byPlace['place-demo'].working, 1);
  assert.deepEqual(f.svc.placeCounts(), { 'place-demo': { working: 1, needsYou: 0, newReplies: 0, open: 0, apps: ['claude'], text: 'Claude working here' } });

  // Nothing polls while the menu-bar count is off, the window is hidden or the Mac is asleep. An agent that was
  // in that folder three minutes ago is no evidence that one is in it now, so the answer goes back to saying nothing.
  f.setNow(NOW + 4 * MIN);
  assert.deepEqual(f.svc.placeCounts(), {}, 'a check this old cannot speak for what is happening now');
  assert.equal(f.fakes.calls.claude, 1, 'and it still never starts a check of its own');
  const kept = await f.svc.read({ maxAgeMs: Infinity });
  assert.equal(kept.byPlace['place-demo'].working, 1, 'the cache itself is untouched: only the claim about now is withdrawn');
  assert.equal(f.fakes.calls.claude, 1);

  // A fresh check answers again.
  await f.svc.read({ maxAgeMs: 0 });
  assert.equal(f.svc.placeCounts()['place-demo'].working, 1);
});

test('maxAgeMs Infinity answers from the last check, even a partial one, and checks only when there is none', async t => {
  let slow = false;
  const f = await fixture(t, { lists: { claude: [raw('claude', 'local_one', { activity: 'open', live: true })] }, limits: { budgetMs: 30 }, wrap: { codex: async () => { if (slow) await delay(200); return answer('codex', []); } } });
  const first = await f.svc.read({ maxAgeMs: Infinity });
  assert.equal(f.fakes.calls.claude, 1, 'no earlier check: one is made');
  f.setNow(NOW + 10 * HOUR);
  await f.svc.read({ maxAgeMs: Infinity });
  assert.equal(f.fakes.calls.claude, 1, 'answered from the last check, however old');
  slow = true;
  const partial = await f.svc.read({ maxAgeMs: 0 });
  assert.equal(partial.sources.find(source => source.app === 'codex').detail, 'Still checking.');
  const calls = f.fakes.calls.claude;
  await f.svc.read({ maxAgeMs: Infinity });
  assert.equal(f.fakes.calls.claude, calls, 'a partial check is reused too');
  await delay(250);
  assert.equal(first.totals.open, 1);
});

test('opening builds only allowlisted links from strictly checked ids, from the last read only', async t => {
  const f = await fixture(t, { dirs: ['Projects/Harbor'] });
  const repo = path.join(f.root, 'Projects/Harbor');
  f.fakes.lists.claude = [
    raw('claude', 'local_abc-123', { unread: true }),
    raw('claude', 'local_x/../', { unread: true }),
    raw('claude', 'local_x?y=1', { unread: true }),
    raw('claude', uuid(3), { surface: 'terminal', activity: 'working', live: true, cwd: repo }),
    raw('claude', uuid(4), { surface: 'terminal', unread: true, cwd: "/Users/me/Someone's Stuff/app" }),
    raw('claude', uuid(5), { surface: 'terminal', unread: true, cwd: '/Users/me/app' }),
    raw('claude', uuid(6), { surface: 'terminal', unread: true }),
    raw('claude', 'not-a-uuid;rm', { surface: 'terminal', unread: true, cwd: '/Users/me/app' }),
    raw('claude', 'has space', { surface: 'terminal', unread: true }),
    raw('claude', uuid(7), { surface: 'terminal', activity: 'working', live: true, cwd: path.join(f.root, 'gone') }),
  ];
  f.fakes.lists.codex = [raw('codex', uuid(1), { unread: true }), raw('codex', 'javascript:alert(1)', { unread: true }), raw('codex', `${uuid(1)}x`, { unread: true })];
  f.fakes.lists.cursor = [raw('cursor', `bc-${uuid(2)}`, { unread: true }), raw('cursor', uuid(8), { unread: true }), raw('cursor', '../../etc', { unread: true }), raw('cursor', uuid(9), { surface: 'cli', unread: true, cwd: repo })];
  f.fakes.lists.hermes = [raw('hermes', '20260917_140000_abcdef', { unread: true }), raw('hermes', '20260917_140000_ABCDEF', { unread: true }), raw('hermes', 'hermes://open/x', { unread: true })];
  const view = await f.svc.read();
  const s = byKey(view);
  const open = key => f.svc.openTarget(key);
  assert.deepEqual(open('claude:desktop:local_abc-123'), { kind: 'url', url: 'claude://claude.ai/epitaxy/local_abc-123', appName: 'Claude' });
  assert.deepEqual([s['claude:desktop:local_abc-123'].openable, s['claude:desktop:local_abc-123'].openHint], ['link', 'Open in Claude']);
  assert.deepEqual(open(`codex:desktop:${uuid(1)}`), { kind: 'url', url: `codex://threads/${uuid(1)}`, appName: 'ChatGPT', appNames: ['ChatGPT', 'Codex'] });
  assert.equal(s[`codex:desktop:${uuid(1)}`].openHint, 'Open in Codex');
  assert.deepEqual(open(`cursor:ide:bc-${uuid(2)}`), { kind: 'url', url: `cursor://anysphere.cursor-deeplink/agent?id=bc-${uuid(2)}`, appName: 'Cursor' });
  assert.deepEqual(open(`cursor:ide:${uuid(8)}`), { kind: 'url', url: `cursor://anysphere.cursor-deeplink/agent?id=${uuid(8)}`, appName: 'Cursor' });
  assert.deepEqual(open('hermes:desktop:20260917_140000_abcdef'), { kind: 'url', url: 'hermes://open/20260917_140000_abcdef', appName: 'Hermes' });
  assert.deepEqual(open(`claude:terminal:${uuid(3)}`), { kind: 'folder', path: repo });
  assert.deepEqual([s[`claude:terminal:${uuid(3)}`].openable, s[`claude:terminal:${uuid(3)}`].openHint], ['folder', 'Show folder']);
  assert.deepEqual(open(`claude:terminal:${uuid(4)}`), { kind: 'copy', text: `cd '/Users/me/Someone'\\''s Stuff/app' && claude --resume ${uuid(4)}` });
  assert.deepEqual([s[`claude:terminal:${uuid(4)}`].openable, s[`claude:terminal:${uuid(4)}`].openHint], ['copy', 'Copy resume command']);
  assert.deepEqual(open(`claude:terminal:${uuid(5)}`), { kind: 'copy', text: `cd /Users/me/app && claude --resume ${uuid(5)}` });
  assert.deepEqual(open(`claude:terminal:${uuid(6)}`), { kind: 'copy', text: `claude --resume ${uuid(6)}` });
  assert.deepEqual(open(`cursor:cli:${uuid(9)}`), { kind: 'folder', path: repo });
  for (const key of ['claude:desktop:local_x/../', 'claude:desktop:local_x?y=1', 'codex:desktop:javascript:alert(1)', `codex:desktop:${uuid(1)}x`, 'cursor:ide:../../etc', 'hermes:desktop:20260917_140000_ABCDEF', 'hermes:desktop:hermes://open/x', 'claude:terminal:not-a-uuid;rm', `claude:terminal:${uuid(7)}`]) {
    assert.equal(s[key].openable, 'none', key);
    assert.equal(s[key].openHint, 'Cannot be opened from Summon');
    assert.throws(() => open(key), /Summon cannot open this session/, key);
  }
  assert.equal(s['claude:terminal:has space'], undefined, 'Ids with spaces or control characters are not sessions.');
  for (const key of ['claude:desktop:local_zzz', '', null, 42, 'x'.repeat(301), 'javascript:alert(1)']) assert.throws(() => open(key), /That session is no longer in the list/);

  // Only the last read counts.
  f.fakes.lists.claude = [];
  await f.svc.read({ maxAgeMs: 0 });
  assert.throws(() => open('claude:desktop:local_abc-123'), /That session is no longer in the list/);
  assert.deepEqual(open(`codex:desktop:${uuid(1)}`).kind, 'url');
});

test('a read after a settings change never answers from a check that started before it', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let first = true;
  const f = await fixture(t, {
    lists: { claude: [raw('claude', 'local_slow-1', { updatedAt: NOW - 30 * HOUR })] },
    // The first claude read is held open, standing in for a poll that is already in flight when settings change.
    wrap: { claude: async (_calls, options) => { if (first) { first = false; await held; } return answer('claude', [raw('claude', 'local_slow-1', { updatedAt: NOW - 30 * HOUR })], { recentMs: options.recentMs }); } },
  });
  // This is main.mjs's 'agent-sessions-settings' handler: a poll is running, then the settings change and the view is read.
  const background = f.svc.read({ maxAgeMs: 0 });
  await delay(10);
  await f.svc.updateSettings({ recentHours: 48 });
  const after = f.svc.read({ maxAgeMs: 0 });
  await delay(10);
  release();
  const view = await after;
  assert.equal(view.settings.recentHours, 48, 'the answer is built with the new setting');
  assert.deepEqual(Object.keys(byKey(view)), ['claude:desktop:local_slow-1'], 'a session 30 h old is inside the new 48 h window');
  assert.equal((await background).settings.recentHours, 24, 'the read that started first still gets its own answer');
});

test('settings validate, save privately and atomically, reload outside edits and quarantine a bad file', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.svc.settings(), { recentHours: 24, newReplyHours: 72, showQuiet: true, showBackground: false, trayCount: 'needs', pathAliases: {} });
  await assert.rejects(fs.access(f.file), 'Nothing is written until a setting changes.');
  const bad = [
    [{ recentHours: 0 }, /whole number from 1 to 168/], [{ recentHours: 169 }, /1 to 168/], [{ recentHours: 1.5 }, /1 to 168/], [{ recentHours: '24' }, /1 to 168/],
    [{ showQuiet: 'yes' }, /showQuiet must be true or false/], [{ showBackground: 1 }, /showBackground must be true or false/],
    [{ colour: 'red' }, /Unknown setting: colour/], [null, /Settings must be an object/], [[], /Settings must be an object/],
    [{ pathAliases: { 'relative/old': '/new' } }, /full paths/], [{ pathAliases: { '/old': 'new' } }, /full paths/], [{ pathAliases: { '/old/../x': '/new' } }, /full paths/],
    [{ pathAliases: { '/old': '/Users/me/sealed-client' } }, /sealed/], [{ pathAliases: { '/': '/new' } }, /whole disk/], [{ pathAliases: { '/same': '/same/' } }, /different/],
    [{ pathAliases: ['/old'] }, /Moved folders must be an object/],
    [{ pathAliases: Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`/old/${index}`, '/new'])) }, /up to 50/],
    [{ pathAliases: { [`/old/${String.fromCharCode(10)}x`]: '/new' } }, /full paths/],
  ];
  for (const [patch, pattern] of bad) await assert.rejects(f.svc.updateSettings(patch), pattern, JSON.stringify(patch));
  assert.deepEqual(f.svc.settings().recentHours, 24);
  const saved = await f.svc.updateSettings({ recentHours: 48, showQuiet: false, pathAliases: { '/Users/old/': '/Users/new' } });
  assert.deepEqual(saved, { recentHours: 48, newReplyHours: 72, showQuiet: false, showBackground: false, trayCount: 'needs', pathAliases: { '/Users/old': '/Users/new' } });
  const stat = await fs.stat(f.file);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await fs.readFile(f.file, 'utf8')), { version: 1, settings: saved });
  assert.deepEqual((await fs.readdir(f.dataDir)).sort(), ['agent-sessions.json'], 'No temporary files are left behind.');

  // An outside edit is picked up on the next read.
  await fs.writeFile(f.file, JSON.stringify({ version: 1, settings: { recentHours: 72, showQuiet: true, showBackground: true, pathAliases: {} } }));
  assert.equal((await f.svc.read()).settings.recentHours, 72);
  assert.equal(f.svc.settings().showBackground, true);

  // A partly invalid file keeps what is valid and is set aside.
  await fs.writeFile(f.file, JSON.stringify({ version: 1, settings: { recentHours: 500, showQuiet: false, pathAliases: { '/a': '/b', 'bad': '/c' } } }));
  const partly = await f.svc.read();
  assert.deepEqual(partly.settings, { recentHours: 24, newReplyHours: 72, showQuiet: false, showBackground: false, trayCount: 'needs', pathAliases: { '/a': '/b' } });
  assert.ok(partly.warnings.some(item => /^Agent sessions settings could not be read \(kept as agent-sessions\.json\.corrupt-/.test(item)), partly.warnings.join(' | '));
  assert.deepEqual(JSON.parse(await fs.readFile(f.file, 'utf8')).settings, partly.settings);

  // Broken JSON falls back to defaults, keeps the file, and a later save clears the warning.
  await fs.writeFile(f.file, '{broken');
  const broken = await f.svc.read();
  assert.deepEqual(broken.settings, { recentHours: 24, newReplyHours: 72, showQuiet: true, showBackground: false, trayCount: 'needs', pathAliases: {} });
  const names = await fs.readdir(f.dataDir);
  assert.equal(names.filter(name => name.startsWith('agent-sessions.json.corrupt-')).length, 2);
  assert.equal(names.filter(name => name.endsWith('.tmp')).length, 0);
  await f.svc.updateSettings({ recentHours: 12 });
  assert.equal((await f.svc.read()).settings.recentHours, 12);

  // A restart reads the saved file.
  const again = await createAgentSessions({ dataDir: f.dataDir, homeDir: f.root, readers: {}, now: () => NOW });
  assert.equal(again.settings().recentHours, 12);
  await again.close();
  await assert.rejects(createAgentSessions({ dataDir: 'relative/dir', readers: {} }), /full data folder path/);
});

test('slow readers answer by the budget, finish once, and their result is used next time; reads are shared and cached', async t => {
  let releaseCursor;
  const cursorGate = new Promise(resolve => { releaseCursor = resolve; });
  const wrap = {
    cursor: async call => {
      if (call === 1) await cursorGate;
      return answer('cursor', [raw('cursor', uuid(call), { unread: true })]);
    },
  };
  const f = await fixture(t, { wrap, limits: { budgetMs: 40 }, lists: { claude: [raw('claude', 'local_fast', { unread: true })] } });
  const started = Date.now();
  const first = await f.svc.read();
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(first.sources.find(source => source.app === 'cursor'), { app: 'cursor', label: 'Cursor', available: false, running: false, detail: 'Still checking.' });
  assert.equal(first.sources.find(source => source.app === 'claude').detail, null);
  assert.deepEqual(first.groups.flatMap(group => group.sessions.map(item => item.key)), ['claude:desktop:local_fast']);
  // A second read while the first reader call is still running waits on the same call.
  const second = await f.svc.read({ maxAgeMs: 60000 });
  assert.equal(second.sources.find(source => source.app === 'cursor').detail, 'Still checking.', 'A partial view is never served from the cache.');
  assert.equal(f.fakes.calls.cursor, 1);
  releaseCursor();
  await delay(20);
  const third = await f.svc.read({ maxAgeMs: 0 });
  assert.equal(f.fakes.calls.cursor, 1, 'The finished late result is used instead of reading again.');
  assert.deepEqual(byKey(third)[`cursor:ide:${uuid(1)}`].stateText, 'New reply · 5 min ago');
  assert.deepEqual(third.sources.find(source => source.app === 'cursor'), { app: 'cursor', label: 'Cursor', available: true, running: true, detail: null });
  const fourth = await f.svc.read({ maxAgeMs: 0 });
  assert.equal(f.fakes.calls.cursor, 2);
  assert.ok(byKey(fourth)[`cursor:ide:${uuid(2)}`]);

  // Concurrent reads share one pass; fresh reads come from the cache until they are older than maxAgeMs.
  const before = f.fakes.calls.claude;
  await Promise.all([f.svc.read({ maxAgeMs: 0 }), f.svc.read({ maxAgeMs: 0 }), f.svc.read({ maxAgeMs: 0, forAgent: true })]);
  assert.equal(f.fakes.calls.claude, before + 1);
  await f.svc.read({ maxAgeMs: 3000 });
  assert.equal(f.fakes.calls.claude, before + 1);
  f.setNow(NOW + 3000);
  await f.svc.read({ maxAgeMs: 3000 });
  assert.equal(f.fakes.calls.claude, before + 2);
  await assert.rejects(f.svc.read({ maxAgeMs: -1 }), /maxAgeMs must be zero or more/);
  await assert.rejects(f.svc.read({ forAgent: 'yes' }), /forAgent must be true or false/);
});

test('the default budget is four seconds', async t => {
  const f = await fixture(t, { wrap: { codex: async () => { await delay(4300); return answer('codex', []); } } });
  const started = Date.now();
  const view = await f.svc.read();
  const took = Date.now() - started;
  assert.ok(took >= 3900 && took < 4250, `took ${took} ms`);
  assert.equal(view.sources.find(source => source.app === 'codex').detail, 'Still checking.');
  await delay(350);
});

test('reader problems become plain warnings and untrusted reader output is cleaned', async t => {
  const control = String.fromCharCode(7);
  const rtl = String.fromCharCode(0x202e);
  const wrap = {
    codex: async (call, options) => { throw new Error(`boom in ${options.homeDir}/.codex`); },
    cursor: async () => 'nonsense',
    hermes: async () => ({
      sessions: [
        null, { app: 'hermes' }, raw('claude', 'local_wrong-app'), raw('hermes', 'x', { surface: 'phone' }), raw('hermes', 'y'.repeat(201)),
        raw('hermes', '20260917_140000_abcdef', { unread: true, title: `Bad${control}title${rtl} ${'z'.repeat(200)}`, activity: 'dancing', helpers: -3, confidence: 'sure', branch: `main${control}` }),
        raw('hermes', '20260917_150000_abcdef', { unread: false, title: 'Less informative' }),
        raw('hermes', '20260917_150000_abcdef', { unread: true, title: 'More informative' }),
      ],
      sources: [{ app: 'nope', label: `Hermes${control}`, available: true, running: false, detail: 'Hermes is closed.' }],
      warnings: ['Hermes state could not be read.', 42, ''],
    }),
  };
  const f = await fixture(t, { wrap, lists: { claude: [] }, places: async () => { throw new Error('no scan'); } });
  const view = await f.svc.read();
  assert.deepEqual(view.sources.map(source => [source.app, source.label, source.available, source.running, source.detail]), [
    ['claude', 'Claude app', true, true, null],
    ['codex', 'Codex', false, false, 'Could not be checked.'],
    ['cursor', 'Cursor', false, false, 'Could not be checked.'],
    ['hermes', 'Hermes', true, false, 'Hermes is closed.'],
  ]);
  assert.ok(view.warnings.includes(`Could not check Codex. boom in ${f.root}/.codex`), JSON.stringify(view.warnings));
  const agent = await f.svc.read({ forAgent: true });
  assert.ok(agent.warnings.includes('Could not check Codex. boom in ~/.codex'), 'Agents never see the home folder path.');
  assert.ok(view.warnings.includes('Could not check Cursor. The reader returned nothing.'));
  assert.ok(view.warnings.includes('Hermes state could not be read.'));
  assert.ok(view.warnings.includes('Could not match sessions to Work in flight folders. no scan'));
  const sessions = view.groups.flatMap(group => group.sessions);
  assert.deepEqual(sessions.map(item => item.key).sort(), ['hermes:desktop:20260917_140000_abcdef', 'hermes:desktop:20260917_150000_abcdef']);
  const cleaned = byKey(view)['hermes:desktop:20260917_140000_abcdef'];
  assert.equal(cleaned.title.length, 120);
  assert.ok(cleaned.title.startsWith('Bad title '));
  assert.equal(cleaned.activity, 'unknown');
  assert.equal(cleaned.helpers, 0);
  assert.equal(cleaned.confidence, 'reported');
  assert.equal(cleaned.branch, 'main');
  assert.equal(byKey(view)['hermes:desktop:20260917_150000_abcdef'].title, 'More informative', 'Duplicates keep the more informative copy.');
});

test('every row says what the session is changing, from files only', async t => {
  const dirs = ['Projects/Harbor/.claude/worktrees/upbeat-raman', 'Projects/Harbor/.codex/worktrees/0ced', 'Projects/Harbor/src'];
  const places = root => [
    // A main folder is shared: several sessions and the owner change the same files, so it never describes one session.
    { id: 'place-main', repoId: 'harbor', repoName: 'Harbor', path: path.join(root, 'Projects/Harbor'), kind: 'main', label: 'Main folder', missing: false,
      added: 900, removed: 400, files: 30, area: 'src', workstream: 'Everything at once', readiness: 'in-progress' },
    { id: 'place-wt', repoId: 'harbor', repoName: 'Harbor', path: path.join(root, 'Projects/Harbor/.claude/worktrees/upbeat-raman'), kind: 'claude', label: 'Claude worktree · upbeat-raman', missing: false,
      added: 700, removed: 90, files: 25, area: 'src/engine', workstream: null, readiness: null },
    { id: 'place-codex', repoId: 'harbor', repoName: 'Harbor', path: path.join(root, 'Projects/Harbor/.codex/worktrees/0ced'), kind: 'codex', label: 'Codex worktree · 0ced', missing: false,
      added: 120, removed: 6, files: 4, area: 'pilot', workstream: 'Detection engine: XLSX evidence', readiness: 'in-progress' },
  ];
  const projects = root => [{ id: 'harbor', name: 'Harbor', path: path.join(root, 'Projects/Harbor') }];
  const f = await fixture(t, { places, projects, dirs });
  const at = (...parts) => path.join(f.root, ...parts);
  const work = (added, removed, files) => ({ added, removed, files });
  f.fakes.lists.claude = [
    raw('claude', 'local_own', { activity: 'working', live: true, worktreePath: at('Projects/Harbor/.claude/worktrees/upbeat-raman'), work: work(340, 20, 12) }),
    raw('claude', 'local_shared', { activity: 'working', live: true, cwd: at('Projects/Harbor'), work: work(51, 3, 2) }),
    raw('claude', 'local_quiet', { activity: 'working', live: true, cwd: at('Projects/Harbor/src'), work: work(0, 0, 0) }),
    // Cursor writes a zero into every header it keeps, so a session in its own worktree must still be described by the folder.
    raw('claude', 'local_zeros', { activity: 'working', live: true, worktreePath: at('Projects/Harbor/.codex/worktrees/0ced'), work: work(0, 0, 0) }),
  ];
  f.fakes.lists.codex = [
    raw('codex', uuid(1), { activity: 'working', live: true, worktreePath: at('Projects/Harbor/.codex/worktrees/0ced') }),
    raw('codex', uuid(2), { activity: 'working', live: true, cwd: at('Projects/Harbor') }),
  ];
  const s = byKey(await f.svc.read());

  // Its own counts, in the worktree it runs in: the folder only fills in where the session says nothing.
  const own = s['claude:desktop:local_own'];
  assert.deepEqual(Object.keys(own.work).sort(), WORK_KEYS);
  assert.deepEqual(own.work, { added: 340, removed: 20, files: 12, area: 'src/engine', scope: 'session', workstream: null, workstreamState: null, workstreamInferred: false, touchedFiles: null, touchedAt: null });
  assert.equal(own.workText, '+340 −20 in 12 files · mostly src/engine');

  // No counts of its own, so its worktree answers for it, in the words Work in flight already wrote.
  const codex = s[`codex:desktop:${uuid(1)}`];
  assert.deepEqual(codex.work, { added: 120, removed: 6, files: 4, area: 'pilot', scope: 'folder', workstream: 'Detection engine: XLSX evidence', workstreamState: 'still in progress', workstreamInferred: false, touchedFiles: null, touchedAt: null });
  assert.equal(codex.workText, 'Detection engine: XLSX evidence (still in progress) · +120 −6 in 4 files');

  // A main folder is nobody's worktree: its counts and grouping never become one session's work.
  assert.equal(s[`codex:desktop:${uuid(2)}`].work, null);
  assert.equal(s[`codex:desktop:${uuid(2)}`].workText, '');
  assert.deepEqual(s['claude:desktop:local_shared'].work, { added: 51, removed: 3, files: 2, area: null, scope: 'session', workstream: null, workstreamState: null, workstreamInferred: false, touchedFiles: null, touchedAt: null });
  assert.equal(s['claude:desktop:local_shared'].workText, '+51 −3 in 2 files');
  // All zeros is not a measurement, so a main-folder session that reports them is described no further.
  assert.equal(s['claude:desktop:local_quiet'].workText, '');
  assert.equal(s['claude:desktop:local_quiet'].work, null);
  // The same zeros inside its own worktree yield to the folder's real numbers rather than reading '+0 −0'.
  assert.deepEqual(s['claude:desktop:local_zeros'].work, { added: 120, removed: 6, files: 4, area: 'pilot', scope: 'folder', workstream: 'Detection engine: XLSX evidence', workstreamState: 'still in progress', workstreamInferred: false, touchedFiles: null, touchedAt: null });
  for (const item of Object.values(s)) assert.ok(item.workText.length <= 90 && !item.workText.includes('—'), item.workText);
});

test('work counts survive odd readers and folder lists that carry nothing', async t => {
  // An older Work in flight that lists no counts at all: the folder simply adds nothing.
  const bare = root => [{ id: 'place-wt', repoId: 'harbor', repoName: 'Harbor', path: path.join(root, 'Projects/Harbor/.claude/worktrees/upbeat-raman'), kind: 'claude', label: 'Claude worktree · upbeat-raman', missing: false }];
  const f = await fixture(t, { places: bare, dirs: ['Projects/Harbor/.claude/worktrees/upbeat-raman'] });
  const at = (...parts) => path.join(f.root, ...parts);
  const wt = at('Projects/Harbor/.claude/worktrees/upbeat-raman');
  f.fakes.lists.claude = [
    raw('claude', 'local_plain', { activity: 'working', live: true, worktreePath: wt }),
    raw('claude', 'local_junk', { activity: 'working', live: true, worktreePath: wt, work: { added: 'lots', removed: -4, files: 1.5, area: '/Users/someone/secret', scope: 'folder', workstream: 'made up' } }),
    raw('claude', 'local_lines', { activity: 'working', live: true, worktreePath: wt, work: { added: 12, removed: 0, area: '../escape' } }),
    raw('claude', 'local_files', { activity: 'working', live: true, worktreePath: wt, work: { files: 1 } }),
    raw('claude', 'local_bad', { activity: 'working', live: true, worktreePath: wt, work: 'a lot' }),
    raw('claude', 'local_text', { activity: 'working', live: true, worktreePath: wt, work: { added: 1, removed: 1, files: 1, workstream: 'SECRET-CONVERSATION-TEXT', workstreamState: 'about a customer' } }),
  ];
  const s = byKey(await f.svc.read());
  assert.equal(s['claude:desktop:local_plain'].work, null);
  assert.equal(s['claude:desktop:local_bad'].work, null);
  assert.equal(s['claude:desktop:local_junk'].work, null, 'counts that are not whole numbers are not counts');
  assert.deepEqual(s['claude:desktop:local_lines'].work, { added: 12, removed: 0, files: null, area: null, scope: 'session', workstream: null, workstreamState: null, workstreamInferred: false, touchedFiles: null, touchedAt: null });
  assert.equal(s['claude:desktop:local_lines'].workText, '+12 −0', 'a folder that is not inside the project is never shown');
  assert.deepEqual(s['claude:desktop:local_files'].work, { added: null, removed: null, files: 1, area: null, scope: 'session', workstream: null, workstreamState: null, workstreamInferred: false, touchedFiles: null, touchedAt: null });
  assert.equal(s['claude:desktop:local_files'].workText, '1 file');
  // Readers never name a workstream or claim folder scope; only a real Work in flight folder can.
  assert.ok(Object.values(s).every(item => item.work === null || (item.work.scope === 'session' && item.work.workstream === null)));
  assert.deepEqual(s['claude:desktop:local_text'].work, { added: 1, removed: 1, files: 1, area: null, scope: 'session', workstream: null, workstreamState: null, workstreamInferred: false, touchedFiles: null, touchedAt: null });
  assert.equal(JSON.stringify(s).includes('SECRET-CONVERSATION-TEXT'), false, 'nothing a reader writes into work reaches a row but numbers');
});

test('Work in flight lists places from its last scan without scanning', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'summon-wif-places-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'Projects', 'Harbor');
  await fs.mkdir(path.join(repo, '.git'), { recursive: true });
  const worktree = path.join(repo, '.claude', 'worktrees', 'vibrant');
  const codex = path.join(root, '.codex', 'worktrees', '0ced', 'Harbor');
  const base = { branch: 'main', detached: false, head: 'aaaa1111', upstream: null, ahead: 0, behind: 0, aheadOfBase: 0, behindBase: 0, files: [], filesTruncated: false, counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, added: 0, removed: 0, lastChangedAt: null, fingerprint: 'fp', error: null };
  const file = (filePath, added = 10, removed = 1) => ({ path: filePath, status: 'modified', staged: false, added, removed, binary: false, isDir: false });
  // Four of six changed files sit in src/engine, so that is where this worktree's work is. The main folder is spread wide.
  const worktreeFiles = [file('src/engine/detect.ts'), file('src/engine/score.ts'), file('src/engine/rules/xlsx.ts'), file('src/engine/rules/csv.ts'), file('src/main/main.mjs'), file('README.md')];
  const mainFiles = [file('src/app.ts'), file('docs/decisions.md'), file('scripts/build.mjs'), file('README.md')];
  // Exactly half is enough to name the place; the two loose files are not.
  const cursorFiles = [file('pilot/run.py'), file('pilot/notes/plan.md'), file('docs/readme.md'), file('Makefile')];
  // A grouping a job already wrote for the worktree, saved as Work in flight saves it. No model runs in these tests.
  const ws = (id, title, files, readiness = 'in-progress') => ({ id, title, summary: `About ${title}.`, area: 'product', readiness, files, sharedFiles: [], suggestedCommit: null });
  await fs.mkdir(path.join(root, 'Data'), { recursive: true });
  await fs.writeFile(path.join(root, 'Data', 'work-in-flight.json'), JSON.stringify({
    version: 1, settings: {}, branchSummaries: {},
    groupings: { [worktree]: { fingerprint: 'wt-1', grouping: { engine: 'codex', model: null, groupedAt: new Date(NOW - HOUR).toISOString(), disclosure: {}, workstreams: [
      ws('ws-1', 'Detection engine: XLSX evidence', ['src/engine/detect.ts', 'src/engine/rules/xlsx.ts', 'src/engine/score.ts']),
      ws('ws-2', 'Menu bar count', ['src/main/main.mjs']),
      ws('ws-3', 'Work that was already saved', ['src/gone.ts', 'src/also-gone.ts']),
    ] } } },
  }));
  let scans = 0;
  const wif = await createWorkInFlight({
    dataDir: path.join(root, 'Data'), homeDir: root, getProjects: async () => [{ id: 'harbor', name: 'Harbor', path: repo }],
    run: async () => { throw new Error('Tests never run git.'); }, git: '/usr/bin/git', env: { PATH: '/usr/bin' },
    scan: async repoPath => { scans += 1; return { path: repoPath, defaultBranch: 'main', hasRemote: false, branches: [], stashes: [], error: null, places: [
      { ...base, path: repoPath, kind: 'main', isMain: true, missing: false, files: mainFiles, added: 900, removed: 400 },
      { ...base, path: worktree, kind: 'claude', isMain: false, missing: false, files: worktreeFiles, added: 340, removed: 20, fingerprint: 'wt-1' },
      { ...base, path: codex, kind: 'codex', isMain: false, missing: true },
      { ...base, path: path.join(root, '.cursor', 'worktrees', 'Harbor', 'q1'), kind: 'cursor', isMain: false, missing: false, files: cursorFiles, added: 40, removed: 0 },
      { ...base, path: path.join(root, 'sealed-client', 'wt'), kind: 'other', isMain: false, missing: false },
    ] }; },
    group: async () => { throw new Error('Tests never call a model.'); },
  });
  t.after(() => wif.close());
  assert.deepEqual(wif.places(), []);
  assert.equal(scans, 0);
  const view = await wif.read({ includeFiles: false });
  const listed = wif.places();
  assert.equal(scans, 1);
  const shown = view.repos[0].places;
  assert.deepEqual(listed.map(place => [place.id, place.label, place.kind, place.path, place.missing]), shown.map(place => [place.id, place.label, place.kind, place.path, place.missing]));
  assert.deepEqual(listed.map(place => place.label), ['Main folder', 'Claude worktree · vibrant', 'Codex worktree · 0ced', 'Cursor worktree · q1']);
  assert.ok(listed.every(place => place.repoId === 'harbor' && place.repoName === 'Harbor'));
  assert.equal(scans, 1, 'Listing places never starts a scan.');

  // Counts, the folder the work sits in, and the biggest workstream travel with each folder, so no caller scans again.
  const [main, claude, gone, cursor] = listed;
  assert.deepEqual([claude.added, claude.removed, claude.files], [340, 20, 6]);
  assert.equal(claude.area, 'src/engine', 'four of six changed files are there');
  assert.equal(claude.workstream, 'Detection engine: XLSX evidence', 'the workstream with the most files that are still changed');
  assert.equal(claude.readiness, 'in-progress');
  assert.deepEqual([main.added, main.removed, main.files], [900, 400, 4]);
  assert.equal(main.area, null, 'changes spread across four folders name none of them');
  assert.equal(main.workstream, null, 'no grouping was saved for the main folder');
  assert.deepEqual([gone.added, gone.removed, gone.files, gone.area, gone.workstream], [0, 0, 0, null, null], 'a folder that is gone counts nothing');
  assert.equal(cursor.area, 'pilot', 'exactly half of the changed files is enough');
  assert.equal(cursor.files, 4);
  assert.deepEqual(listed.map(place => Object.keys(place).sort()), listed.map(() => ['added', 'area', 'files', 'id', 'kind', 'label', 'missing', 'path', 'readiness', 'removed', 'repoId', 'repoName', 'workstream', 'workstreams']));

  // Every piece of work the folder has been grouped into travels too, so a session in it can be matched to one of
  // them by the files it edited. The biggest one is what `workstream` names; the list is all of them.
  assert.deepEqual(claude.workstreams, [
    { id: 'ws-1', title: 'Detection engine: XLSX evidence', files: ['src/engine/detect.ts', 'src/engine/rules/xlsx.ts', 'src/engine/score.ts'], readiness: 'in-progress' },
    { id: 'ws-2', title: 'Menu bar count', files: ['src/main/main.mjs'], readiness: 'in-progress' },
    // Its files are not changed any more, so it never wins `workstream`, but a session that edited them before they
    // were saved still has somewhere to match, which is the whole point of sending the list.
    { id: 'ws-3', title: 'Work that was already saved', files: ['src/gone.ts', 'src/also-gone.ts'], readiness: 'in-progress' },
  ]);
  assert.ok(claude.workstreams.every(stream => stream.files.every(file => !file.startsWith('/'))), 'files stay folder-relative');
  assert.deepEqual(main.workstreams, [], 'a folder with no grouping has nothing to match against, which is not the same as no work');
  assert.deepEqual(gone.workstreams, [], 'a folder that is gone is never matched against');
});

test('one failed app check never turns a running app into a closed one', async t => {
  let fail = false;
  const list = () => new Map([[1, { pid: 1, ppid: 0, startedAt: NOW - HOUR, lstart: 'Thu Sep 17 14:00:00 2026', comm: '/sbin/launchd' }]]);
  const f = await fixture(t, {
    lists: { claude: [raw('claude', 'local_live', { activity: 'working', live: true })] },
    listProcesses: async () => { if (fail) throw new Error('ps failed'); return list(); },
  });
  const good = await f.svc.read({ maxAgeMs: 0 });
  assert.ok(f.fakes.seen.at(-1).processes instanceof Map);
  fail = true;
  const again = await f.svc.read({ maxAgeMs: 0 });
  assert.ok(f.fakes.seen.at(-1).processes instanceof Map, 'the last list that worked is reused for a moment');
  assert.deepEqual(again.totals, good.totals, 'the board does not blink');
  assert.equal(again.warnings.includes('Summon could not check which apps are running.'), false);

  // Once that list is too old to trust, the readers are told the answer is unknown rather than "nothing is running".
  f.setNow(NOW + 60000);
  const unknown = await f.svc.read({ maxAgeMs: 0 });
  assert.equal(f.fakes.seen.at(-1).processes, null, 'null is unknown; an empty list would read as every app being closed');
  assert.ok(unknown.warnings.includes('Summon could not check which apps are running.'));
});

test('an app check that never answers costs its own slice of the budget, not the readers', async t => {
  const f = await fixture(t, {
    lists: { claude: [raw('claude', 'local_one', { activity: 'working', live: true })] },
    limits: { budgetMs: 400, processesMs: 80 },
    listProcesses: () => new Promise(() => {}),
  });
  const started = Date.now();
  const view = await f.svc.read({ maxAgeMs: 0 });
  const took = Date.now() - started;
  assert.ok(took < 300, `the read answered in ${took} ms rather than spending the whole budget on the app check`);
  assert.equal(view.totals.working, 1, 'the sessions are still listed, only without live marks');
  assert.equal(view.sources.some(source => source.detail === 'Still checking.'), false);
});

test('a reader that could not read its app keeps the last list that worked', async t => {
  let fail = false;
  const rows = () => [raw('claude', 'local_keep', { unread: true })];
  const broken = { sessions: [], failed: true, sources: [{ app: 'claude', label: 'Claude app', available: true, running: true, detail: "Claude's list could not be read." }], warnings: ["Claude's list could not be read."] };
  const f = await fixture(t, { wrap: { claude: () => (fail ? structuredClone(broken) : answer('claude', rows())) } });
  const first = await f.svc.read({ maxAgeMs: 0 });
  assert.ok(byKey(first)['claude:desktop:local_keep']);
  fail = true;
  const kept = await f.svc.read({ maxAgeMs: 0 });
  assert.ok(byKey(kept)['claude:desktop:local_keep'], 'one bad check does not empty the list');
  assert.deepEqual(f.svc.openTarget('claude:desktop:local_keep'), { kind: 'url', url: 'claude://claude.ai/epitaxy/local_keep', appName: 'Claude' });
  assert.equal(kept.sources.find(source => source.label === 'Claude app').detail, 'Could not be read just now; showing the last list Summon read.');
  assert.ok(kept.warnings.includes("Claude's list could not be read."), kept.warnings.join(' | '));

  // After a run of failures, the honest empty list comes back rather than an old one shown forever.
  f.setNow(NOW + 3 * MIN);
  const empty = await f.svc.read({ maxAgeMs: 0 });
  assert.equal(byKey(empty)['claude:desktop:local_keep'], undefined);
  assert.equal(empty.sources.find(source => source.label === 'Claude app').detail, "Claude's list could not be read.");
});

test('closing does not wait out a reader that is still running', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { limits: { budgetMs: 30, closeWaitMs: 60 }, wrap: { codex: async () => { await held; return answer('codex', []); } } });
  await f.svc.read({ maxAgeMs: 0 });
  const started = Date.now();
  await f.svc.close();
  const took = Date.now() - started;
  release();
  await delay(10);
  assert.ok(took < 400, `close returned in ${took} ms rather than waiting for the reader`);
});

test('a folder that vanished inside a folder Summon knows keeps that folder, not the repository root', async t => {
  const dirs = ['Projects/Harbor/.claude/worktrees/upbeat-raman/src'];
  const places = root => [
    { id: 'place-main', repoId: 'harbor', repoName: 'Harbor', path: path.join(root, 'Projects/Harbor'), kind: 'main', label: 'Main folder', missing: false },
    { id: 'place-wt', repoId: 'harbor', repoName: 'Harbor', path: path.join(root, 'Projects/Harbor/.claude/worktrees/upbeat-raman'), kind: 'claude', label: 'Claude worktree · upbeat-raman', missing: false },
  ];
  const projects = root => [{ id: 'harbor', name: 'Harbor', path: path.join(root, 'Projects/Harbor') }];
  const f = await fixture(t, { places, projects, dirs });
  const at = (...parts) => path.join(f.root, ...parts);
  f.fakes.lists.claude = [
    raw('claude', 'local_gone', { activity: 'working', live: true, worktreePath: at('Projects/Harbor/.claude/worktrees/upbeat-raman/gone-sub') }),
    raw('claude', 'local_moved', { activity: 'working', live: true, cwd: '/Users/old/Harbor/web' }),
  ];
  const s = byKey(await f.svc.read());
  assert.equal(s['claude:desktop:local_gone'].placeId, 'place-wt', 'the worktree it ran in, not the repository main folder');
  assert.equal(s['claude:desktop:local_gone'].placeLabel, 'Claude worktree · upbeat-raman');
  assert.equal(s['claude:desktop:local_moved'].placeId, 'place-main', 'a folder that is inside nothing Summon knows still follows its name');
});

test('an unread mark older than newReplyHours sits under Earlier and still says it is unread', async t => {
  const f = await fixture(t, {
    lists: { claude: [
      raw('claude', 'local_fresh', { unread: true, updatedAt: NOW - 2 * HOUR }),
      raw('claude', 'local_edge', { unread: true, updatedAt: NOW - 72 * HOUR }),
      raw('claude', 'local_old', { unread: true, updatedAt: NOW - 200 * HOUR }),
    ] },
  });
  const view = await f.svc.read();
  const s = byKey(view);
  assert.equal(s['claude:desktop:local_fresh'].group, 'new');
  assert.equal(s['claude:desktop:local_edge'].group, 'new', 'exactly at the limit still counts as a new reply');
  assert.equal(s['claude:desktop:local_old'].group, 'recent', 'older than the limit, and still listed');
  assert.equal(s['claude:desktop:local_old'].unread, true, 'and still marked unread');
  assert.equal(view.totals.newReplies, 2, 'the badge counts only the fresh ones');
  assert.equal(view.groups.find(group => group.id === 'recent').title, 'Earlier (1 unread)');

  await f.svc.updateSettings({ newReplyHours: 1 });
  const tight = await f.svc.read({ maxAgeMs: 0 });
  assert.equal(tight.totals.newReplies, 0);
  assert.equal(tight.groups.find(group => group.id === 'recent').title, 'Earlier (3 unread)');
  assert.equal(tight.settings.newReplyHours, 1);
  for (const bad of [0, 721, 1.5, '72']) await assert.rejects(f.svc.updateSettings({ newReplyHours: bad }), /whole number from 1 to 720|1 to 720/, String(bad));
});

// ---- sessions say which piece of work they are on ----
const stream = (title, files, readiness = 'in-progress') => ({ title, files, readiness });

test('a session is placed in the piece of work its own files are in, and the row leads with it', async t => {
  const dirs = ['Projects/Harbor/src/engine', 'Projects/Harbor/pilot', 'Projects/Harbor/.claude/worktrees/upbeat-raman'];
  const places = root => [
    { id: 'place-main', repoId: 'harbor', repoName: 'Harbor', path: path.join(root, 'Projects/Harbor'), kind: 'main', label: 'Main folder', missing: false,
      added: 900, removed: 400, files: 30, area: 'src', workstream: 'Everything at once', readiness: 'in-progress',
      workstreams: [
        stream('Detection engine: XLSX evidence', ['src/engine/xlsx.ts', 'src/engine/read.ts', 'docs/evidence.md'], 'ready'),
        stream('Pilot outreach notes', ['pilot/acme.md', 'pilot/list.md']),
        stream('Everything at once', ['src/engine/xlsx.ts', 'pilot/acme.md', 'README.md', 'package.json', 'src/app.ts']),
      ] },
    { id: 'place-wt', repoId: 'harbor', repoName: 'Harbor', path: path.join(root, 'Projects/Harbor/.claude/worktrees/upbeat-raman'), kind: 'claude', label: 'Claude worktree · upbeat-raman', missing: false,
      added: 700, removed: 90, files: 25, area: 'src/engine', workstream: 'Share links', readiness: 'in-progress',
      workstreams: [stream('Share links', ['src/share.ts', 'src/link.ts'])] },
  ];
  const projects = root => [{ id: 'harbor', name: 'Harbor', path: path.join(root, 'Projects/Harbor') }];
  const f = await fixture(t, { places, projects, dirs, privatePaths: root => ({ [path.join(root, 'Projects/Harbor')]: ['pilot/list.md'] }) });
  const at = (...parts) => path.join(f.root, ...parts);
  const main = at('Projects/Harbor');
  f.fakes.lists.claude = [
    // Two files in one workstream is a match, even in a main folder several sessions share.
    raw('claude', 'local_engine', { title: 'Excel file review', activity: 'working', live: true, cwd: main,
      touchedPaths: [at('Projects/Harbor/src/engine/xlsx.ts'), at('Projects/Harbor/src/engine/read.ts')] }),
    // One file out of two is half of what this session touched, which clears the share test.
    raw('claude', 'local_pilot', { title: 'Excel file review', titleSource: 'user', activity: 'working', live: true, cwd: main,
      touchedPaths: [at('Projects/Harbor/pilot/acme.md'), at('Projects/Harbor/notes.md')] }),
    // Nothing in common with any workstream: the row says where the files sit instead of naming a piece of work.
    raw('claude', 'local_elsewhere', { activity: 'working', live: true, cwd: main,
      touchedPaths: [at('Projects/Harbor/src/engine/new-a.ts'), at('Projects/Harbor/src/engine/new-b.ts'), at('Projects/Harbor/src/engine/new-c.ts')] }),
    // Secrets, the repo's own private folders and files outside this folder never reach the match.
    raw('claude', 'local_private', { activity: 'working', live: true, cwd: main,
      touchedPaths: [at('Projects/Harbor/pilot/list.md'), at('Projects/Harbor/.env'), at('Projects/Other/pilot/acme.md')] }),
    // A worktree still borrows its folder's piece of work when the session itself names no files.
    raw('claude', 'local_borrow', { activity: 'working', live: true, worktreePath: at('Projects/Harbor/.claude/worktrees/upbeat-raman') }),
  ];
  const s = byKey(await f.svc.read());

  const engine = s['claude:desktop:local_engine'];
  assert.equal(engine.work.workstream, 'Detection engine: XLSX evidence');
  assert.equal(engine.work.workstreamState, 'looks ready to save');
  assert.equal(engine.work.scope, 'session', 'the match is about this session, not the shared folder');
  assert.equal(engine.headline, 'Harbor · Detection engine: XLSX evidence');
  assert.equal(engine.title, 'Excel file review', "the app's own title is kept, not replaced");
  assert.equal(engine.titleIsAuto, true);

  const pilot = s['claude:desktop:local_pilot'];
  assert.equal(pilot.work.workstream, 'Pilot outreach notes');
  assert.equal(pilot.headline, 'Harbor · Pilot outreach notes');
  assert.equal(pilot.titleIsAuto, false, 'a title the user typed is not the machine wording');
  assert.notEqual(engine.headline, pilot.headline, 'two rows with the same machine title can never look interchangeable');

  const elsewhere = s['claude:desktop:local_elsewhere'];
  assert.equal(elsewhere.work.workstream, null, 'no piece of work is named when the files are in none of them');
  assert.equal(elsewhere.work.area, 'src/engine', 'the row falls back to where its own files sit');
  assert.equal(elsewhere.headline, 'Harbor · main folder');

  const priv = s['claude:desktop:local_private'];
  assert.equal(priv.work, null, 'a private, secret or outside path is dropped before anything is matched');
  assert.equal(priv.headline, 'Harbor · main folder');

  const borrow = s['claude:desktop:local_borrow'];
  assert.equal(borrow.work.workstream, 'Share links');
  assert.equal(borrow.work.scope, 'folder', 'a borrowed workstream is still the folder speaking');
  assert.equal(borrow.headline, 'Harbor · Share links');
  for (const item of Object.values(s)) assert.ok(item.headline && !item.headline.includes('—'), item.headline);
});

test('a folder that has not been grouped, or a session that names no files, is never guessed at', async t => {
  const dirs = ['Projects/Harbor/src'];
  const places = root => [{ id: 'place-main', repoId: 'harbor', repoName: 'Harbor', path: path.join(root, 'Projects/Harbor'), kind: 'main', label: 'Main folder', missing: false,
    added: 4, removed: 1, files: 2, area: null, workstream: null, readiness: null }];
  const f = await fixture(t, { places, projects: root => [{ id: 'harbor', name: 'Harbor', path: path.join(root, 'Projects/Harbor') }], dirs });
  const at = (...parts) => path.join(f.root, ...parts);
  f.fakes.lists.claude = [
    raw('claude', 'local_nostreams', { activity: 'working', live: true, cwd: at('Projects/Harbor'), touchedPaths: [at('Projects/Harbor/src/a.ts')] }),
    raw('claude', 'local_nopaths', { activity: 'working', live: true, cwd: at('Projects/Harbor') }),
    raw('claude', 'local_nowhere', { title: 'Loose work', activity: 'working', live: true, cwd: at('Projects/Elsewhere'), touchedPaths: [at('Projects/Elsewhere/a.ts')] }),
  ];
  const s = byKey(await f.svc.read());
  assert.equal(s['claude:desktop:local_nostreams'].work.workstream, null);
  assert.equal(s['claude:desktop:local_nostreams'].headline, 'Harbor · main folder');
  assert.equal(s['claude:desktop:local_nopaths'].work, null);
  assert.equal(s['claude:desktop:local_nopaths'].headline, 'Harbor · main folder');
  // Outside every Work in flight folder there is no project name to lead with, so the folder's own name does.
  assert.equal(s['claude:desktop:local_nowhere'].headline, 'Elsewhere');
});

test('a session in a private folder tells an agent nothing about the work it is on', async t => {
  const dirs = ['Projects/Harbor/clients/acme'];
  const places = root => [
    { id: 'place-main', repoId: 'harbor', repoName: 'Harbor', path: path.join(root, 'Projects/Harbor'), kind: 'main', label: 'Main folder', missing: false,
      added: 4, removed: 1, files: 2, area: null, workstream: null, readiness: null, workstreams: [] },
    // A worktree inside a private folder: the piece of work it is on is the owner's to see and nobody else's.
    { id: 'place-acme', repoId: 'harbor', repoName: 'Harbor', path: path.join(root, 'Projects/Harbor/clients/acme'), kind: 'claude', label: 'Claude worktree · acme', missing: false,
      added: 12, removed: 2, files: 3, area: 'clients/acme', workstream: 'Acme pricing SECRET-abc', readiness: 'ready', workstreams: [] },
  ];
  const f = await fixture(t, { places, projects: root => [{ id: 'harbor', name: 'Harbor', path: path.join(root, 'Projects/Harbor') }], dirs });
  const at = (...parts) => path.join(f.root, ...parts);
  f.fakes.lists.claude = [
    raw('claude', 'local_private', { title: 'Pricing', activity: 'working', live: true, worktreePath: at('Projects/Harbor/clients/acme'), touchedFiles: 7, touchedAt: NOW - 3 * MIN }),
  ];
  const mine = byKey(await f.svc.read())['claude:desktop:local_private'];
  assert.equal(mine.work.workstream, 'Acme pricing SECRET-abc', 'the panel shows it; only agents are held back');
  assert.equal(mine.headline, 'Harbor · Acme pricing SECRET-abc');
  const theirs = byKey(await f.svc.read({ forAgent: true }))['claude:desktop:local_private'];
  assert.equal(theirs.headline, 'Work in a private folder');
  assert.equal(theirs.work, null);
  assert.equal(theirs.workText, '', 'not even how many files it has touched');
  assert.equal(JSON.stringify(theirs).includes('SECRET-abc'), false);
});

// ---- sessions that named no files at all ----
// Claude names every file-history entry after the file it holds: the first 16 hex characters of sha256 of that file's
// absolute path. A session that named no path can still be matched by hashing the paths we already have and looking
// for its entries among them. The rule is written out again here, so the aggregator has to agree with it.
const hashOf = file => createHash('sha256').update(file).digest('hex').slice(0, 16);

test('a session that named no files is placed by the hashed names of the ones it backed up', async t => {
  const dirs = ['Projects/Harbor/src/engine', 'Projects/Harbor/pilot'];
  const places = root => [{ id: 'place-main', repoId: 'harbor', repoName: 'Harbor', path: path.join(root, 'Projects/Harbor'), kind: 'main', label: 'Main folder', missing: false,
    added: 900, removed: 400, files: 30, area: 'src', workstream: null, readiness: null,
    workstreams: [
      stream('Detection engine: XLSX evidence', ['src/engine/xlsx.ts', 'src/engine/read.ts', 'docs/evidence.md'], 'ready'),
      stream('Pilot outreach notes', ['pilot/acme.md', 'pilot/list.md', 'pilot/notes.md']),
      stream('Client pricing', ['clients/acme/price.md']),
    ] }];
  const f = await fixture(t, { places, projects: root => [{ id: 'harbor', name: 'Harbor', path: path.join(root, 'Projects/Harbor') }], dirs,
    privatePaths: root => ({ [path.join(root, 'Projects/Harbor')]: ['clients'] }) });
  const at = (...parts) => path.join(f.root, ...parts);
  const main = at('Projects/Harbor');
  const hashes = (...files) => files.map(file => hashOf(path.join(main, file)));
  f.fakes.lists.claude = [
    // Two files of one piece of work, and no path of its own: the row can still say what it is on.
    raw('claude', 'local_hashed', { title: 'Excel file review', activity: 'working', live: true, cwd: main,
      touchedHashes: hashes('src/engine/xlsx.ts', 'src/engine/read.ts'), touchedFiles: 12, touchedAt: NOW - 4 * MIN }),
    // One file in common out of eight it touched is not enough to name a piece of work.
    raw('claude', 'local_weak', { activity: 'working', live: true, cwd: main,
      touchedHashes: [...hashes('pilot/acme.md'), ...Array.from({ length: 7 }, (_, i) => hashOf(path.join(main, `src/other-${i}.ts`)))],
      touchedFiles: 8, touchedAt: NOW - 30 * MIN }),
    // One file in each of two pieces of work: a tie says nothing rather than picking one of them.
    raw('claude', 'local_tie', { activity: 'working', live: true, cwd: main,
      touchedHashes: hashes('src/engine/xlsx.ts', 'pilot/acme.md'), touchedFiles: 2, touchedAt: NOW - HOUR }),
    // Paths the session named itself win: they are exact, and what they find is not marked as inferred.
    raw('claude', 'local_both', { activity: 'working', live: true, cwd: main,
      touchedPaths: [at('Projects/Harbor/pilot/acme.md'), at('Projects/Harbor/pilot/list.md')],
      touchedHashes: hashes('src/engine/xlsx.ts', 'src/engine/read.ts'), touchedFiles: 4, touchedAt: NOW - 2 * MIN }),
    // The repo's own private folders are left out before anything is hashed, so they can never produce a match.
    raw('claude', 'local_private', { activity: 'working', live: true, cwd: main,
      touchedHashes: hashes('clients/acme/price.md'), touchedFiles: 1, touchedAt: NOW - 9 * MIN }),
    // Everything this one backed up sits in another project: the count is still its own, and the words say so.
    raw('claude', 'local_outside', { activity: 'working', live: true, cwd: main,
      touchedHashes: ['src/a.ts', 'src/b.ts'].map(file => hashOf(path.join(f.root, 'Projects/Other', file))), touchedFiles: 5, touchedAt: NOW - 7 * MIN }),
  ];
  const s = byKey(await f.svc.read());

  const hashed = s['claude:desktop:local_hashed'];
  assert.equal(hashed.work.workstream, 'Detection engine: XLSX evidence');
  assert.equal(hashed.work.workstreamState, 'looks ready to save');
  assert.equal(hashed.work.workstreamInferred, true, 'matched by hashed names, so the row says it is inferred');
  assert.equal(hashed.headline, 'Harbor · Detection engine: XLSX evidence (probably)', 'a match from hashed names reads as a guess, in the word the rest of the panel uses');
  assert.equal(hashed.title, 'Excel file review', "the app's own title is kept, not replaced");

  const weak = s['claude:desktop:local_weak'];
  assert.equal(weak.work.workstream, null, 'one file out of eight names nothing');
  assert.equal(weak.headline, 'Harbor · main folder');
  assert.equal(weak.work.touchedFiles, 8, 'how much it has touched is still a real count');
  assert.equal(weak.workText, 'touched 8 files in all, most recently 30 min ago');

  const tie = s['claude:desktop:local_tie'];
  assert.equal(tie.work.workstream, null, 'a tie is not a winner');
  assert.equal(tie.workText, 'touched 2 files in all, most recently 1 h ago');

  const both = s['claude:desktop:local_both'];
  assert.equal(both.work.workstream, 'Pilot outreach notes', 'the paths it named itself decide');
  assert.equal(both.work.workstreamInferred, false);
  assert.equal(both.work.touchedFiles, 4);
  assert.equal(both.workText, 'Pilot outreach notes (still in progress)', 'how much it has touched never follows a named piece of work');

  const priv = s['claude:desktop:local_private'];
  assert.equal(priv.work.workstream, null, 'a private file is never hashed, so it can never match');
  assert.equal(priv.headline, 'Harbor · main folder');

  const outside = s['claude:desktop:local_outside'];
  assert.equal(outside.work.workstream, null, 'a file in another project can never name a piece of work here');
  assert.equal(outside.work.touchedFiles, 5, 'the count is still what this session has written');
  assert.equal(outside.workText, 'touched 5 files in all, most recently 7 min ago', 'and the words never claim this folder');
  for (const item of Object.values(s)) assert.equal(item.headline.includes('—'), false, item.headline);
});

test('the hashed file lists follow the folder: a regrouped folder is matched again, an unchanged one keeps its answer', async t => {
  const dirs = ['Projects/Harbor/src'];
  let files = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
  let readiness = 'in-progress';
  const places = root => [{ id: 'place-main', repoId: 'harbor', repoName: 'Harbor', path: path.join(root, 'Projects/Harbor'), kind: 'main', label: 'Main folder', missing: false,
    added: 10, removed: 2, files: 3, area: 'src', workstream: null, readiness: null,
    workstreams: [stream('First shape', files, readiness), stream('Untouched work', ['docs/readme.md'])] }];
  const f = await fixture(t, { places, projects: root => [{ id: 'harbor', name: 'Harbor', path: path.join(root, 'Projects/Harbor') }], dirs });
  const main = path.join(f.root, 'Projects/Harbor');
  f.fakes.lists.claude = [
    raw('claude', 'local_hashed', { activity: 'working', live: true, cwd: main,
      touchedHashes: ['src/a.ts', 'src/b.ts'].map(file => hashOf(path.join(main, file))), touchedFiles: 2, touchedAt: NOW - MIN }),
  ];
  assert.equal(byKey(await f.svc.read())['claude:desktop:local_hashed'].work.workstream, 'First shape');
  // Read again with nothing changed: the same answer, from the lists that were already hashed.
  assert.equal(byKey(await f.svc.read({ maxAgeMs: 0 }))['claude:desktop:local_hashed'].work.workstream, 'First shape');
  // The same files, grouped again with the work now ready to save: the row follows that too, and the hashed lists
  // it was matched against are the ones this read passed in, not the ones an earlier read hashed.
  readiness = 'ready';
  const flipped = byKey(await f.svc.read({ maxAgeMs: 0 }))['claude:desktop:local_hashed'];
  assert.equal(flipped.work.workstream, 'First shape');
  assert.equal(flipped.work.workstreamState, 'looks ready to save', 'a piece of work that became ready never reads as still in progress');
  // The folder is grouped again and those files are now somewhere else, so the row follows them.
  files = ['src/z.ts'];
  const moved = byKey(await f.svc.read({ maxAgeMs: 0 }))['claude:desktop:local_hashed'];
  assert.equal(moved.work.workstream, null, "the old hashes are dropped the moment the folder's lists change");
  assert.equal(moved.work.touchedFiles, 2);
});

test('sessions on the same piece of work stay apart, each row saying which one it is', async t => {
  const dirs = ['Projects/Harbor/src/engine', 'Projects/Harbor/.claude/worktrees/upbeat-raman/src/engine'];
  const engine = ['src/engine/xlsx.ts', 'src/engine/read.ts'];
  const places = root => [
    { id: 'place-main', repoId: 'harbor', repoName: 'Harbor', path: path.join(root, 'Projects/Harbor'), kind: 'main', label: 'Main folder', missing: false,
      added: 10, removed: 2, files: 2, area: 'src', workstream: null, readiness: null, workstreams: [stream('Detection engine', engine)] },
    { id: 'place-wt', repoId: 'harbor', repoName: 'Harbor', path: path.join(root, 'Projects/Harbor/.claude/worktrees/upbeat-raman'), kind: 'claude', label: 'Claude worktree · upbeat-raman', missing: false,
      added: 8, removed: 1, files: 2, area: 'src', workstream: null, readiness: null, workstreams: [stream('Detection engine', engine)] },
  ];
  const f = await fixture(t, { places, projects: root => [{ id: 'harbor', name: 'Harbor', path: path.join(root, 'Projects/Harbor') }], dirs });
  const main = path.join(f.root, 'Projects/Harbor');
  const worktree = path.join(main, '.claude/worktrees/upbeat-raman');
  const hashesIn = root => engine.map(file => hashOf(path.join(root, file)));
  f.fakes.lists.claude = [
    // Same machine title, same piece of work, different folders: the worktree says which is which.
    raw('claude', 'local_main', { title: 'Excel file review', activity: 'working', live: true, cwd: main, touchedHashes: hashesIn(main), touchedFiles: 6, touchedAt: NOW - MIN }),
    raw('claude', 'local_wt', { title: 'Excel file review', activity: 'working', live: true, worktreePath: worktree, branch: 'claude/upbeat-raman', touchedHashes: hashesIn(worktree), touchedFiles: 9, touchedAt: NOW - 2 * MIN }),
    // A third session in the same main folder: the folder cannot tell it apart, so the file count does.
    raw('claude', 'local_main2', { title: 'Excel file review', activity: 'working', live: true, cwd: main, touchedHashes: hashesIn(main), touchedFiles: 3, touchedAt: NOW - 3 * MIN }),
  ];
  const s = byKey(await f.svc.read());
  const rows = ['claude:desktop:local_main', 'claude:desktop:local_wt', 'claude:desktop:local_main2'].map(key => s[key]);
  for (const row of rows) assert.equal(row.work.workstream, 'Detection engine', 'they really are on the same piece of work');
  assert.equal(new Set(rows.map(row => row.headline)).size, 3, 'and no two rows read the same');
  assert.equal(rows[1].headline, 'Harbor · Detection engine (probably) · claude/upbeat-raman');
  assert.equal(rows[0].headline, 'Harbor · Detection engine (probably) · 6 files in all');
  assert.equal(rows[2].headline, 'Harbor · Detection engine (probably) · 3 files in all');
  for (const row of rows) assert.equal(row.title, 'Excel file review', 'the machine title stays under the row either way');
});

test('one file both pieces of work hold, or two files every session writes, name nothing', async t => {
  const dirs = ['Projects/Harbor/small', 'Projects/Harbor/big'];
  const big = ['shared.md', 'package.json', 'CLAUDE.md', ...Array.from({ length: 28 }, (_, i) => `big/f-${String(i).padStart(2, '0')}.ts`)];
  const places = root => [{ id: 'place-main', repoId: 'harbor', repoName: 'Harbor', path: path.join(root, 'Projects/Harbor'), kind: 'main', label: 'Main folder', missing: false,
    added: 900, removed: 400, files: 60, area: 'src', workstream: null, readiness: null,
    workstreams: [stream('Small piece', ['shared.md', 'small/a.md', 'small/b.md']), stream('Big piece', big)] }];
  const f = await fixture(t, { places, projects: root => [{ id: 'harbor', name: 'Harbor', path: path.join(root, 'Projects/Harbor') }], dirs });
  const main = path.join(f.root, 'Projects/Harbor');
  const hashes = (...files) => files.map(file => hashOf(path.join(main, file)));
  const filler = n => Array.from({ length: n }, (_, i) => hashOf(path.join(main, `other/f-${i}.ts`)));
  f.fakes.lists.claude = [
    // One file that both pieces of work hold: the bigger one is too big for a single file to stand for, but it is
    // still the other side of the split, so nothing is named.
    raw('claude', 'local_shared', { activity: 'working', live: true, cwd: main,
      touchedHashes: [...hashes('shared.md'), ...filler(2)], touchedFiles: 3, touchedAt: NOW - MIN }),
    // Two files of the small piece and nothing of the big one: a real share of what this session wrote, so it counts.
    raw('claude', 'local_pair', { activity: 'working', live: true, cwd: main,
      touchedHashes: [...hashes('small/a.md', 'small/b.md'), ...filler(1)], touchedFiles: 3, touchedAt: NOW - 2 * MIN }),
    // A version bump and a memory note, inside a session that has written two hundred files: not evidence of anything.
    raw('claude', 'local_config', { activity: 'working', live: true, cwd: main,
      touchedHashes: [...hashes('package.json', 'CLAUDE.md'), ...filler(200)], touchedFiles: 202, touchedAt: NOW - MIN }),
  ];
  const s = byKey(await f.svc.read());

  const shared = s['claude:desktop:local_shared'];
  assert.equal(shared.work.workstream, null, 'one file two pieces of work both hold cannot choose between them');
  assert.equal(shared.headline, 'Harbor · main folder');

  const pair = s['claude:desktop:local_pair'];
  assert.equal(pair.work.workstream, 'Small piece', 'two files that are most of what it wrote still name the work');
  assert.equal(pair.headline, 'Harbor · Small piece (probably)');

  const config = s['claude:desktop:local_config'];
  assert.equal(config.work.workstream, null, 'two files out of two hundred are not a share of anything');
  assert.equal(config.work.touchedFiles, 202, 'the count is still real');
  assert.equal(config.workText, 'touched 202 files in all, most recently 1 min ago');
});

test('rows with nothing true to tell them apart say nothing rather than a number that implies a difference', async t => {
  const dirs = ['Projects/Harbor/src/engine', 'Projects/Harbor/pilot'];
  const engine = ['src/engine/xlsx.ts', 'src/engine/read.ts'];
  const pilot = ['pilot/acme.md', 'pilot/list.md'];
  const places = root => [{ id: 'place-main', repoId: 'harbor', repoName: 'Harbor', path: path.join(root, 'Projects/Harbor'), kind: 'main', label: 'Main folder', missing: false,
    added: 10, removed: 2, files: 2, area: 'src', workstream: null, readiness: null,
    workstreams: [stream('Detection engine', engine), stream('Pilot outreach notes', pilot)] }];
  const f = await fixture(t, { places, projects: root => [{ id: 'harbor', name: 'Harbor', path: path.join(root, 'Projects/Harbor') }], dirs });
  const at = (...parts) => path.join(f.root, ...parts);
  const main = at('Projects/Harbor');
  f.fakes.lists.claude = [
    // Two sessions on the same piece of work in the same folder, neither of which counted anything: there is nothing
    // true to add, so the rows read the same and the app's own title is what separates them.
    raw('claude', 'local_bare1', { title: 'Excel file review', activity: 'working', live: true, cwd: main, touchedPaths: engine.map(file => path.join(main, file)) }),
    raw('claude', 'local_bare2', { title: 'Excel file review', activity: 'working', live: true, cwd: main, touchedPaths: engine.map(file => path.join(main, file)) }),
    // Two more on another piece of work, counting different things: one its whole backup folder, one its own diff.
    raw('claude', 'local_backed', { activity: 'working', live: true, cwd: main, touchedPaths: pilot.map(file => path.join(main, file)), touchedFiles: 6, touchedAt: NOW - MIN }),
    raw('claude', 'local_diff', { activity: 'working', live: true, cwd: main, touchedPaths: pilot.map(file => path.join(main, file)), work: { added: 5, removed: 1, files: 6 } }),
  ];
  const s = byKey(await f.svc.read());

  const bare = ['claude:desktop:local_bare1', 'claude:desktop:local_bare2'].map(key => s[key]);
  for (const row of bare) assert.equal(row.work.workstream, 'Detection engine');
  assert.equal(bare[0].headline, 'Harbor · Detection engine');
  assert.equal(bare[1].headline, bare[0].headline, 'a row with no count of its own adds nothing to the headline');
  for (const row of bare) assert.equal(row.title, 'Excel file review', 'the machine title is still underneath');

  const mixed = ['claude:desktop:local_backed', 'claude:desktop:local_diff'].map(key => s[key]);
  for (const row of mixed) assert.equal(row.headline, 'Harbor · Pilot outreach notes', "'6 files' means two different things in these two rows, so neither headline says it");
  assert.equal(mixed[0].work.touchedFiles, 6, 'both numbers are still on the row itself');
  assert.equal(mixed[1].work.files, 6);
});

test('readers get each app\'s hook states, a hook or a launch makes the next read fresh, and rows Summon started say so', async t => {
  const lists = { claude: [raw('claude', uuid(6), { surface: 'terminal', activity: 'open', live: true, origin: 'summon' }), raw('claude', 'local_aaa-1', { activity: 'working', live: true, origin: 'elsewhere' })] };
  const f = await fixture(t, { lists });
  const view = await f.svc.read();
  const s = byKey(view);
  assert.equal(s[`claude:terminal:${uuid(6)}`].startedFrom, 'summon');
  assert.equal(s['claude:desktop:local_aaa-1'].startedFrom, null, 'only Summon\'s own word counts');
  assert.deepEqual(Object.keys(s[`claude:terminal:${uuid(6)}`]).sort(), SESSION_KEYS);
  assert.equal(byKey(await f.svc.read({ forAgent: true }))[`claude:terminal:${uuid(6)}`].startedFrom, 'summon', 'agents see the same fact');
  for (const options of f.fakes.seen) { assert.ok(options.hookStates instanceof Map); assert.equal(options.hookStates.size, 0); }
  const before = f.fakes.calls.claude;
  await f.svc.read();
  assert.equal(f.fakes.calls.claude, before, 'a read within 3 s answers from the cache');
  assert.deepEqual(f.svc.noteHook({ app: 'claude', event: 'Stop', sessionId: uuid(6), cwd: null, toolName: null, kind: null, launch: null }), { accepted: true });
  await f.svc.read();
  assert.equal(f.fakes.calls.claude, before + 1, 'a hook event drops the cached view');
  const recent = f.fakes.seen.slice(-4);
  const claude = recent.find(options => options.hookStates.has(uuid(6)));
  assert.ok(claude, 'the Claude reader got the Claude state');
  assert.deepEqual([claude.hookStates.get(uuid(6)).state, claude.hookStates.get(uuid(6)).event], ['open', 'Stop']);
  assert.equal(recent.filter(options => options.hookStates.size === 0).length, 3, 'the other readers got nothing');
  const tag = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  f.svc.noteLaunch({ app: 'codex', tag, cwd: f.root, projectId: 'p', sessionId: null });
  await f.svc.read();
  assert.equal(f.fakes.calls.claude, before + 2, 'a launch drops it too');
  assert.throws(() => f.svc.noteHook({ app: 'claude', event: 'Stop', sessionId: 'served:x' }), /Invalid hook session id/);
  await f.svc.close();
  const file = path.join(f.dataDir, 'hook-events.json');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(saved.sessions[`claude:${uuid(6)}`].state, 'open');
  assert.equal(saved.launches[tag].app, 'codex');
  assert.ok(!JSON.stringify(saved).includes('Session '), 'no title ever lands in the hook file');
});
