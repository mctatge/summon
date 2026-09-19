import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createWorkInFlight, disclosureFor } from '../src/core/work-in-flight.mjs';
import { setSealedSegments } from '../src/core/workstreams.mjs';

// The sealed-folder guard is empty until configured; these fixtures seal any path segment containing 'sealed-client'.
setSealedSegments(['sealed-client']);

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = value => createHash('sha256').update(value).digest('hex');
const SENT = 'project, folder and branch names, recent commit messages, changed file names with line counts, short excerpts from non-private text files, and a few file names in new folders. Private folders send only their folder name, file types, change and line counts, and edit dates.';
const DISCLOSURE_CODEX = `Grouping sends to Codex (your ChatGPT sign-in): ${SENT} Nothing is sent until you press Group changes.`;
const DISCLOSURE_CLAUDE = `Grouping sends to Claude (your Claude sign-in): ${SENT} Nothing is sent until you press Group changes.`;
const DISCLOSURE_CODEX_OPEN = `Grouping sends to Codex (your ChatGPT sign-in): ${SENT} Group on open is on, so opening this panel sends changed work right away. Agents you ask can send it too.`;
const DISCLOSURE_CODEX_CLICK = `Grouping sends to Codex (your ChatGPT sign-in): ${SENT} Nothing is sent until you press Group changes or ask an agent to group.`;
const NEEDS_CONSENT = /Press Group changes in the Work in flight panel once first/;
const DISCLOSURE_OFF = 'Grouping is off. Changes are grouped by folder on this Mac.';
const NOTE_FALLBACK = 'Grouped by folder. Use Group changes for plain-language workstreams.';

function change(file, extra = {}) {
  return { path: file, origPath: null, status: 'modified', staged: false, unstaged: true, added: 4, removed: 1, binary: false, isDir: false, fileCount: null, extensions: null, size: 20, mtimeMs: 1, ...extra };
}
function place(folder, files = [], extra = {}) {
  const counts = { staged: files.filter(f => f.staged).length, unstaged: files.filter(f => f.unstaged && f.status !== 'untracked').length, untracked: files.filter(f => f.status === 'untracked').length, conflicted: files.filter(f => f.status === 'conflicted').length };
  return {
    path: folder, kind: 'main', isMain: true, missing: false, branch: 'main', detached: false, head: 'aaaa1111', upstream: 'origin/main', ahead: 0, behind: 0, aheadOfBase: 0, behindBase: 0,
    files, filesTruncated: false, counts, added: files.reduce((sum, f) => sum + (f.added || 0), 0), removed: files.reduce((sum, f) => sum + (f.removed || 0), 0),
    lastChangedAt: files.length ? '2026-09-17T09:00:00.000Z' : null, recentSubjects: ['Initial'], fingerprint: `fp-${sha(JSON.stringify(files)).slice(0, 12)}`, error: null, ...extra,
  };
}
function branch(name, extra = {}) {
  return { name, tip: `${name.slice(0, 4)}0000`.slice(0, 8), subject: `Work on ${name}`, lastCommitAt: '2026-09-10T10:00:00.000Z', upstream: `origin/${name}`, upstreamGone: false, ahead: 0, behind: 0, aheadOfBase: 0, behindBase: 0, worktreePath: null, recentSubjects: [`Work on ${name}`], topPaths: ['src/app.ts'], added: 5, removed: 1, ...extra };
}
function rawRepo(folder, places, extra = {}) {
  return { path: folder, commonDir: path.join(folder, '.git'), defaultBranch: 'main', hasRemote: true, lastFetchedAt: '2026-09-16T12:00:00.000Z', places, branches: [branch('main', { tip: 'aaaa1111', worktreePath: folder })], stashes: [], error: null, ...extra };
}
async function makeRepo(folder) { await fs.mkdir(path.join(folder, '.git'), { recursive: true }); return folder; }
async function settle(wif) {
  for (let attempt = 0; attempt < 600; attempt++) {
    const view = await wif.read({ maxAgeMs: 60000 });
    if (view.job && !['queued', 'running'].includes(view.job.status)) return view;
    await delay(5);
  }
  throw new Error('The grouping job did not finish.');
}
// Ids come from the request prompt, exactly as a model would see them.
function answerFor(prompt, title = 'Product: first change') {
  const items = [...new Set(prompt.match(/\b[FUA]\d{3}\b/g) || [])];
  const branches = [...new Set(prompt.match(/\bB\d{3}\b/g) || [])];
  return { workstreams: items.length ? [{ title, summary: 'Adds the first change. Looks finished.', area: 'product', readiness: 'ready', items, shared_items: [], suggested_commit: 'feat: first change' }] : [], branches: branches.map(id => ({ id, summary: 'Adds a governance audit.' })) };
}

async function fixture(t, { names = ['Harbor'], ...overrides } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'summon-wif-')));
  const dataDir = path.join(root, 'Data');
  const repos = {};
  for (const name of names) repos[name] = await makeRepo(path.join(root, 'Projects', name));
  const projects = names.map(name => ({ id: name.toLowerCase(), name, path: repos[name], color: '#aebdab' }));
  const raws = {};
  const scanned = [];
  const changes = [];
  const scan = async (repoPath, deps) => {
    scanned.push(repoPath);
    assert.equal(deps.git, '/usr/bin/git');
    assert.equal(deps.skipPath(path.join(root, 'sealed-client', 'wt')), true, 'Linked worktrees under a sealed folder are skipped inside the scanner.');
    assert.equal(deps.skipPath(repoPath), false);
    const raw = raws[repoPath];
    if (typeof raw === 'function') return raw(repoPath);
    return structuredClone(raw || rawRepo(repoPath, [place(repoPath)]));
  };
  const options = {
    dataDir, homeDir: root, getProjects: async () => projects, run: async () => { throw new Error('Tests never run git.'); }, git: '/usr/bin/git', env: { PATH: '/usr/bin' },
    scan, excerpts: async () => new Map(), untrackedHead: async () => null, same: async () => false,
    group: async () => { throw new Error('Tests never call a model.'); }, onChange: () => { changes.push(Date.now()); }, ...overrides,
  };
  const wif = await createWorkInFlight(options);
  const services = [wif];
  t.after(async () => { for (const service of services) await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, dataDir, repos, projects, raws, scanned, changes, wif, services, options, file: path.join(dataDir, 'work-in-flight.json') };
}

test('settings validate every key, store real folders and persist privately', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.wif.settings(), { engine: 'codex', effort: 'medium', claudeModel: 'opus', groupOnOpen: true, extraRoots: [], excludedRoots: [], privatePaths: {}, consentedAt: null });
  const saved = await f.wif.updateSettings({ engine: 'claude', effort: 'high', claudeModel: 'sonnet', groupOnOpen: false });
  assert.equal(saved.engine, 'claude');
  assert.equal((await fs.stat(f.file)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).settings.claudeModel, 'sonnet');
  const extra = await makeRepo(path.join(f.root, 'Extra', 'Delta'));
  await fs.symlink(extra, path.join(f.root, 'delta-link'));
  const notFolder = path.join(f.root, 'note.txt');
  await fs.writeFile(notFolder, 'x');
  const sealed = await makeRepo(path.join(f.root, 'Archive', 'sealed-client', 'app'));
  for (const [patch, pattern] of [
    [{ engine: 'gpt' }, /codex, claude or off/], [{ effort: 'max' }, /effort/], [{ claudeModel: 'claude-9' }, /Claude model/], [{ groupOnOpen: 'yes' }, /true or false/],
    [{ surprise: true }, /Unknown setting/], [null, /object/], [{ extraRoots: 'Projects' }, /list/], [{ extraRoots: ['Projects/Delta'] }, /full paths/],
    [{ extraRoots: [path.join(f.root, 'nowhere')] }, /not found/], [{ extraRoots: [notFolder] }, /Not a folder/], [{ extraRoots: [sealed] }, /sealed/],
    [{ extraRoots: Array.from({ length: 21 }, () => extra) }, /up to 20/], [{ excludedRoots: [`${extra}/../Delta`] }, /full paths/],
    [{ privatePaths: { [f.repos.Harbor]: ['../secrets/'] } }, /relative/], [{ privatePaths: { [f.repos.Harbor]: ['/pilot/'] } }, /relative/],
    [{ privatePaths: { 'Projects/Harbor': ['pilot/'] } }, /full project path/], [{ privatePaths: { [f.repos.Harbor]: ['x'.repeat(201)] } }, /200/],
    [{ privatePaths: { [f.repos.Harbor]: Array.from({ length: 41 }, (_, i) => `p${i}/`) } }, /40/], [{ privatePaths: { [f.repos.Harbor]: 'pilot/' } }, /40/],
    [{ consentedAt: '2026-09-17T10:00:00.000Z' }, /Consent is recorded when you press Group changes/],
  ]) await assert.rejects(f.wif.updateSettings(patch), pattern, JSON.stringify(patch));
  assert.equal(f.wif.settings().engine, 'claude');
  const next = await f.wif.updateSettings({ extraRoots: [path.join(f.root, 'delta-link'), extra], privatePaths: { [f.repos.Harbor]: ['./pilot/', 'docs/legal/', 'pilot/'] } });
  assert.deepEqual(next.extraRoots, [extra]);
  assert.deepEqual(next.privatePaths, { [f.repos.Harbor]: ['pilot/', 'docs/legal/'] });
  const restarted = await createWorkInFlight(f.options);
  f.services.push(restarted);
  assert.deepEqual(restarted.settings(), { ...next, engine: 'claude', effort: 'high', claudeModel: 'sonnet', groupOnOpen: false });
  const view = await restarted.read();
  assert.equal(view.disclosure, DISCLOSURE_CLAUDE);
  assert.deepEqual(view.settings, restarted.settings());
});

test('state saves atomically, reloads outside edits and turns grouping off when the file is unreadable', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'summon-wif-state-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'Data');
  await fs.mkdir(dataDir);
  const file = path.join(dataDir, 'work-in-flight.json');
  await fs.writeFile(file, '{"version":1,"settings":');
  const wif = await createWorkInFlight({ dataDir, homeDir: root, getProjects: async () => [], scan: async () => { throw new Error('No repositories.'); } });
  t.after(() => wif.close());
  const corrupt = async () => (await fs.readdir(dataDir)).filter(name => name.startsWith('work-in-flight.json.corrupt-')).length;
  assert.equal(await corrupt(), 1);
  // The fail-closed settings are saved at once, so the next start does not fall back to sending with defaults.
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).settings.engine, 'off');
  let view = await wif.read();
  assert.match(view.errors.join('\n'), /Grouping was turned off because work-in-flight\.json could not be read \(kept as work-in-flight\.json\.corrupt-/);
  assert.equal(view.settings.engine, 'off');
  assert.equal(view.disclosure, DISCLOSURE_OFF);
  assert.deepEqual(view.repos, []);
  assert.deepEqual(view.totals, { reposWithWork: 0, unsavedItems: 0, unsharedCommits: 0, setAside: 0, openBranches: 0, staleGroupings: 0 });
  assert.throws(() => wif.group({ reason: 'panel' }), /Grouping is turned off/);
  // Choosing an engine again is the explicit way back; the warning then clears.
  await wif.updateSettings({ engine: 'codex', groupOnOpen: false });
  view = await wif.read();
  assert.equal(view.settings.engine, 'codex');
  assert.equal(view.errors.some(item => item.startsWith('Grouping was turned off')), false);
  const names = await fs.readdir(dataDir);
  assert.equal(names.some(name => name.endsWith('.tmp')), false);
  const stored = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(Object.keys(stored), ['version', 'settings', 'groupings', 'branchSummaries']);
  // A hand edit (the documented way to add private folders) is picked up, not overwritten.
  const handEdit = async value => { await fs.writeFile(`${file}.edit`, typeof value === 'string' ? value : JSON.stringify(value)); await fs.rename(`${file}.edit`, file); };
  await handEdit({ ...stored, settings: { ...stored.settings, engine: 'off' } });
  view = await wif.read();
  assert.equal(view.settings.engine, 'off');
  assert.equal(view.disclosure, DISCLOSURE_OFF);
  assert.equal((await wif.updateSettings({ effort: 'low' })).engine, 'off');
  // One bad value keeps every valid one, including private folders, and turns grouping off.
  await handEdit({ ...stored, settings: { ...stored.settings, engine: 'codex', extraRoots: ['relative/path'], privatePaths: { [root]: ['pilot/'] } } });
  view = await wif.read();
  assert.equal(await corrupt(), 2);
  assert.equal(view.settings.engine, 'off');
  assert.deepEqual(view.settings.privatePaths, { [root]: ['pilot/'] });
  assert.deepEqual(view.settings.extraRoots, []);
  assert.match(view.errors.join('\n'), /full paths/);
  await handEdit('x'.repeat(2097153));
  view = await wif.read();
  assert.equal(await corrupt(), 3);
  assert.match(view.errors.join('\n'), /under 2 MiB/);
  assert.deepEqual(view.settings.privatePaths, { [root]: ['pilot/'] }, 'private folders already known are kept when the file cannot be read at all');
  assert.equal(view.settings.engine, 'off');
});

test('an unreadable settings file never lets grouping fall back to sending, even after a restart', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'summon-wif-closed-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'Data');
  await fs.mkdir(dataDir);
  const file = path.join(dataDir, 'work-in-flight.json');
  const repo = await makeRepo(path.join(root, 'Projects', 'Studio'));
  const groups = [];
  const options = {
    dataDir, homeDir: root, getProjects: async () => [{ id: 'studio', name: 'Studio', path: repo }], env: { PATH: '/usr/bin' },
    scan: async folder => rawRepo(folder, [place(folder, [change('pilot/notes/Dana Whitfield call.md'), change('src/app.ts')])]),
    excerpts: async (folder, paths) => new Map(paths.map(item => [item, ['+ Dana wants a 40% discount']])), untrackedHead: async () => null, same: async () => false,
    group: async (engine, request) => { groups.push(request.prompt); return { raw: answerFor(request.prompt), model: null }; },
  };
  // A trailing comma: nothing parses, so grouping is off and stays off after a restart.
  await fs.writeFile(file, JSON.stringify({ version: 1, settings: { engine: 'codex', privatePaths: { [repo]: ['pilot/'] } }, groupings: {}, branchSummaries: {} }).replace(/}$/, ',}'));
  for (let restart = 0; restart < 2; restart++) {
    const wif = await createWorkInFlight(options);
    const view = await wif.read();
    assert.equal(view.settings.engine, 'off', `restart ${restart}`);
    assert.throws(() => wif.group({ reason: 'panel' }), /turned off/);
    assert.throws(() => wif.group({ reason: 'cli' }), /turned off/);
    await wif.close();
  }
  // A file that said "off" and then broke is never read back as codex.
  await fs.writeFile(file, '{"version":1,"settings":{"engine":"off"');
  const wif = await createWorkInFlight(options);
  t.after(() => wif.close());
  assert.equal(wif.settings().engine, 'off');
  // A typo in a key name means the intended private folders never applied: grouping goes off too.
  await fs.writeFile(`${file}.edit`, JSON.stringify({ version: 1, settings: { engine: 'codex', privatepaths: { [repo]: ['pilot/'] } }, groupings: {}, branchSummaries: {} }));
  await fs.rename(`${file}.edit`, file);
  const view = await wif.read();
  assert.equal(view.settings.engine, 'off');
  assert.match(view.errors.join('\n'), /Unknown setting: privatepaths/);
  assert.deepEqual(groups, []);
});

test('discovery keeps real git folders only, skips sealed folders and excluded roots, and dedupes by real path', async t => {
  const f = await fixture(t, { names: ['Alpha', 'Skipped'] });
  const beta = path.join(f.root, 'Projects', 'Beta');
  await fs.mkdir(beta, { recursive: true });
  await fs.writeFile(path.join(beta, '.git'), 'gitdir: /elsewhere/.git/worktrees/beta\n');
  const plain = path.join(f.root, 'Projects', 'Plain');
  await fs.mkdir(plain);
  const hidden = await makeRepo(path.join(f.root, 'Archive', 'sealed-client', 'Gamma'));
  await fs.symlink(hidden, path.join(f.root, 'Sneaky'));
  await fs.symlink(f.repos.Alpha, path.join(f.root, 'AlphaLink'));
  const fakeGit = path.join(f.root, 'Projects', 'LinkedGit');
  await fs.mkdir(fakeGit);
  await fs.symlink(path.join(f.repos.Alpha, '.git'), path.join(fakeGit, '.git'));
  const delta = await makeRepo(path.join(f.root, 'Extra', 'Delta'));
  f.projects.push(
    { id: 'beta', name: 'Beta', path: beta }, { id: 'plain', name: 'Plain', path: plain }, { id: 'gamma', name: 'Gamma', path: hidden },
    { id: 'sneaky', name: 'Sneaky', path: path.join(f.root, 'Sneaky') }, { id: 'alpha-link', name: 'Alpha link', path: path.join(f.root, 'AlphaLink') },
    { id: 'missing', name: 'Missing', path: path.join(f.root, 'Projects', 'Missing') }, { id: 'relative', name: 'Relative', path: 'Projects/Alpha' },
    { id: 'linked-git', name: 'Linked git', path: fakeGit },
  );
  await f.wif.updateSettings({ extraRoots: [delta, f.repos.Alpha], excludedRoots: [f.repos.Skipped] });
  const view = await f.wif.read();
  assert.deepEqual(f.scanned.sort(), [f.repos.Alpha, delta].sort());
  assert.ok(!f.scanned.some(folder => /sealed-client/i.test(folder)));
  const byName = Object.fromEntries(view.repos.map(repo => [repo.name, repo]));
  assert.deepEqual(Object.keys(byName).sort(), ['Alpha', 'Delta']);
  assert.equal(byName.Alpha.id, 'alpha');
  assert.equal(byName.Alpha.projectId, 'alpha');
  assert.equal(byName.Delta.id, `repo-${sha(delta).slice(0, 16)}`);
  assert.equal(byName.Delta.projectId, null);
  assert.equal(byName.Delta.displayPath, '~/Extra/Delta');
  for (const repo of view.repos) {
    assert.equal(repo.status, 'clean');
    assert.equal(repo.headline, 'All caught up.');
    assert.deepEqual(repo.places[0].stateWords, ['all saved']);
    assert.equal(repo.places[0].grouping, null);
  }
  assert.equal(view.totals.reposWithWork, 0);
  const failing = await fixture(t, { names: [], getProjects: async () => { throw new Error('state unavailable'); } });
  assert.match((await failing.wif.read()).errors.join('\n'), /Could not list workspaces: state unavailable/);
});

test('the view explains places, mirrors, branches and stashes in plain words', async t => {
  const sameCalls = [];
  const f = await fixture(t, { names: ['Harbor', 'Quiet', 'Broken'], same: async (a, b, paths) => { sameCalls.push({ a, b, paths }); return true; } });
  const main = f.repos.Harbor;
  const claudePath = path.join(main, '.claude', 'worktrees', 'vibrant');
  const codexPath = path.join(f.root, '.codex', 'worktrees', '0ced', 'Harbor');
  const gonePath = path.join(f.root, 'gone');
  const files = () => [change('src/app.ts'), change('docs/guide.md', { staged: true, unstaged: false }), change('pilot/people/Jane Doe.md', { status: 'added', staged: true, unstaged: false, added: 9, removed: 0 }), change('notes/', { status: 'untracked', unstaged: false, added: null, removed: null, isDir: true, fileCount: 4, extensions: { '.md': 4 } })];
  await f.wif.updateSettings({ privatePaths: { [main]: ['pilot/'] } });
  f.raws[main] = rawRepo(main, [
    place(main, files(), { ahead: 2, behind: 6, fingerprint: 'fp-main' }),
    place(claudePath, [], { kind: 'claude', isMain: false, branch: 'feature-x', upstream: null, aheadOfBase: 2, head: 'bbbb2222' }),
    place(codexPath, files(), { kind: 'codex', isMain: false, branch: null, detached: true, upstream: null, fingerprint: 'fp-codex' }),
    place(gonePath, [], { kind: 'other', isMain: false, missing: true, branch: 'old', upstream: null, fingerprint: null }),
  ], {
    branches: [
      branch('main', { tip: 'aaaa1111', ahead: 2, behind: 6, worktreePath: main }),
      branch('old-merged', { upstreamGone: true, lastCommitAt: '2026-09-15T10:00:00.000Z' }),
      branch('pushed', { aheadOfBase: 1, ahead: 1, lastCommitAt: '2026-09-11T10:00:00.000Z' }),
      branch('feature-x', { tip: 'bbbb2222', upstream: null, aheadOfBase: 2, lastCommitAt: '2026-09-14T10:00:00.000Z', worktreePath: claudePath }),
    ],
    stashes: [{ index: 0, ref: 'stash@{0}', message: 'WIP on main: tweak', branch: 'main', createdAt: '2026-09-12T10:00:00.000Z', files: 8 }],
  });
  f.raws[f.repos.Quiet] = rawRepo(f.repos.Quiet, [place(f.repos.Quiet, [], { ahead: 2 })], { branches: [branch('main', { tip: 'cccc3333', ahead: 2, worktreePath: f.repos.Quiet })] });
  f.raws[f.repos.Broken] = async () => { throw new Error('fatal: not a git repository'); };
  const view = await f.wif.read();
  assert.equal(view.version, 1);
  assert.ok(Number.isFinite(Date.parse(view.scannedAt)));
  assert.equal(view.disclosure, DISCLOSURE_CODEX);
  assert.equal(view.job, null);
  const repo = view.repos.find(item => item.name === 'Harbor');
  assert.equal(repo.displayPath, '~/Projects/Harbor');
  assert.equal(repo.status, 'attention');
  assert.equal(repo.defaultBranch, 'main');
  assert.equal(repo.lastFetchedAt, '2026-09-16T12:00:00.000Z');
  const [mainPlace, claudePlace, codexPlace, gonePlace] = repo.places;
  assert.deepEqual(repo.places.map(item => item.label), ['Main folder', 'Claude worktree · vibrant', 'Codex worktree · 0ced', 'Extra folder · gone']);
  assert.deepEqual(repo.places.map(item => item.kind), ['main', 'claude', 'codex', 'other']);
  assert.equal(mainPlace.id, `place-${sha(main).slice(0, 16)}`);
  assert.equal(mainPlace.displayPath, '~/Projects/Harbor');
  assert.deepEqual(mainPlace.stateWords, ['not saved yet', '2 saved, not shared', '6 newer on GitHub (as of Sep 16)']);
  assert.deepEqual(mainPlace.counts, { staged: 2, unstaged: 1, untracked: 1, conflicted: 0, items: 4 });
  assert.deepEqual(claudePlace.stateWords, ['only on this Mac']);
  assert.equal(claudePlace.grouping, null);
  assert.equal(codexPlace.mirrorOf, mainPlace.id);
  assert.deepEqual(codexPlace.stateWords, ['not saved yet', 'not on a branch', 'its unsaved changes are all in Main folder too']);
  assert.equal(codexPlace.grouping, null);
  assert.deepEqual(gonePlace.stateWords, ['folder is gone']);
  assert.equal(gonePlace.missing, true);
  assert.equal(gonePlace.grouping, null);
  assert.equal(mainPlace.mirrorOf, null);
  assert.deepEqual(sameCalls, [{ a: main, b: codexPath, paths: ['src/app.ts', 'docs/guide.md', 'pilot/people/Jane Doe.md', 'notes/'] }]);
  const byPath = Object.fromEntries(mainPlace.files.map(file => [file.path, file]));
  assert.equal(byPath['pilot/people/Jane Doe.md'].private, true);
  assert.equal(byPath['src/app.ts'].private, false);
  assert.deepEqual(byPath['notes/'], { path: 'notes/', status: 'untracked', staged: false, added: null, removed: null, binary: false, isDir: true, fileCount: 4, private: false });
  const grouping = mainPlace.grouping;
  assert.equal(grouping.engine, 'paths');
  assert.equal(grouping.model, null);
  assert.equal(grouping.stale, false);
  assert.equal(grouping.note, NOTE_FALLBACK);
  assert.deepEqual(grouping.workstreams.flatMap(ws => ws.files).sort(), ['docs/guide.md', 'notes/', 'pilot/people/Jane Doe.md', 'src/app.ts']);
  assert.equal(grouping.workstreams.find(ws => ws.files.includes('pilot/people/Jane Doe.md')).private, true);
  for (const ws of grouping.workstreams) {
    assert.match(ws.id, /^ws-/);
    assert.ok(!ws.title.includes('—'));
    assert.equal(ws.added, ws.files.reduce((sum, file) => sum + (byPath[file].added || 0), 0));
  }
  const things = grouping.workstreams.length;
  assert.equal(repo.headline, `A worktree folder is gone. ${things} ${things === 1 ? 'thing' : 'things'} in progress`);
  assert.deepEqual(repo.branches.map(item => item.name), ['feature-x', 'pushed', 'old-merged']);
  const [featureX, pushed, oldMerged] = repo.branches;
  assert.deepEqual(featureX.stateWords, ['2 commits not in main', 'only on this Mac', 'open in Claude worktree · vibrant']);
  assert.equal(featureX.placeId, claudePlace.id);
  assert.equal(featureX.merged, false);
  assert.equal(featureX.summary, null);
  assert.equal(featureX.summaryStale, false);
  assert.deepEqual(featureX.topPaths, ['src/app.ts']);
  assert.deepEqual(pushed.stateWords, ['1 commit not in main', '1 not shared']);
  assert.equal(pushed.placeId, null);
  assert.deepEqual(oldMerged.stateWords, ['done, safe to clean up', 'GitHub copy was deleted']);
  assert.equal(oldMerged.merged, true);
  assert.deepEqual(repo.stashes, [{ index: 0, message: 'WIP on main: tweak', branch: 'main', createdAt: '2026-09-12T10:00:00.000Z', files: 8 }]);
  const quiet = view.repos.find(item => item.name === 'Quiet');
  assert.equal(quiet.status, 'work');
  assert.equal(quiet.headline, 'All saved. 2 commits not shared yet.');
  assert.deepEqual(quiet.places[0].stateWords, ['2 saved, not shared']);
  const broken = view.repos.find(item => item.name === 'Broken');
  assert.equal(broken.status, 'error');
  assert.match(broken.headline, /Could not check this project\. fatal: not a git repository/);
  assert.equal(broken.headline, broken.error);
  assert.deepEqual(view.repos.map(item => item.name), ['Harbor', 'Quiet', 'Broken']);
  assert.deepEqual(view.totals, { reposWithWork: 2, unsavedItems: 4, unsharedCommits: 7, setAside: 1, openBranches: 2, staleGroupings: 1 });
  const again = await f.wif.read({ maxAgeMs: 0 });
  assert.equal(sameCalls.length, 1, 'Mirror verdicts are cached by both fingerprints.');
  assert.equal(again.repos[0].places[2].mirrorOf, mainPlace.id);
  const compact = await f.wif.read({ projectId: 'harbor', includeFiles: false });
  assert.deepEqual(compact.repos.map(item => item.id), ['harbor']);
  assert.ok(compact.repos[0].places.every(item => !('files' in item)));
  assert.equal(compact.repos[0].places[0].counts.items, 4);
  assert.equal(compact.totals.reposWithWork, 1);
  // Agent-facing reads never name private files, but keep the counts whole.
  const masked = await f.wif.read({ projectId: 'harbor', includeFiles: true, maskPrivate: true });
  const maskedMain = masked.repos[0].places[0];
  assert.ok(!JSON.stringify(masked).includes('Jane Doe'));
  assert.deepEqual(maskedMain.files.map(file => file.path).sort(), ['docs/guide.md', 'notes/', 'src/app.ts']);
  assert.equal(maskedMain.withheldFiles, 1);
  assert.equal(maskedMain.counts.items, 4);
  const maskedPrivate = maskedMain.grouping.workstreams.find(ws => ws.private);
  assert.deepEqual([maskedPrivate.files, maskedPrivate.withheldFiles], [[], 1]);
  assert.ok(maskedMain.grouping.workstreams.filter(ws => !ws.private).every(ws => !('withheldFiles' in ws)));
  assert.equal((await f.wif.read({ projectId: 'harbor' })).repos[0].places[0].files.length, 4, 'The local panel still lists private files.');
  await assert.rejects(f.wif.read({ maskPrivate: 'yes' }), /maskPrivate/);
  const none = await f.wif.read({ projectId: 'nope' });
  assert.deepEqual(none.repos, []);
  assert.match(none.errors.join('\n'), /No git project matches/);
  await assert.rejects(f.wif.read({ projectId: 42 }), /Project id/);
  await assert.rejects(f.wif.read({ includeFiles: 'yes' }), /includeFiles/);
  assert.equal(f.wif.placePath(mainPlace.id), main);
  assert.throws(() => f.wif.placePath(gonePlace.id), /no longer exists/);
  assert.throws(() => f.wif.placePath(`place-${'0'.repeat(16)}`), /no longer in the scan/);
  assert.throws(() => f.wif.placePath('../etc'), /no longer in the scan/);
});

test('untrusted repository text is cleaned and conflicts or divergence need attention', async t => {
  const f = await fixture(t, { names: ['Odd'] });
  const folder = f.repos.Odd;
  const bell = String.fromCharCode(7), escape = String.fromCharCode(27), override = String.fromCharCode(0x202e);
  f.raws[folder] = rawRepo(folder, [place(folder, [change('src/a.ts', { status: 'conflicted' }), change(`src/b${bell}.ts`)], { ahead: 1, behind: 1, branch: `main${escape}[31m` })], {
    branches: [branch('main', { worktreePath: folder }), branch(`evil${override}name`, { aheadOfBase: 3, upstream: null, subject: `Fix${bell} thing` })],
  });
  const view = await f.wif.read();
  const [repo] = view.repos;
  assert.equal(repo.status, 'attention');
  assert.deepEqual(repo.places[0].stateWords, ['needs a decision on conflicting edits', 'not saved yet', '1 saved, not shared', '1 newer on GitHub (as of Sep 16)']);
  const strings = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
  const all = strings(repo);
  assert.ok(all.includes('src/b .ts'));
  for (const character of [bell, escape, override]) assert.equal(all.some(text => text.includes(character)), false);
  assert.equal(repo.branches[0].name, 'evil name');
  assert.equal(repo.branches[0].subject, 'Fix thing');
});

test('cached groupings go stale, drop saved files and keep newer changes visible', async t => {
  const f = await fixture(t);
  const main = f.repos.Harbor;
  const groupedAt = '2026-09-16T08:00:00.000Z';
  await fs.mkdir(f.dataDir, { recursive: true });
  await fs.writeFile(f.file, JSON.stringify({
    version: 1,
    settings: { engine: 'codex', effort: 'medium', claudeModel: 'opus', groupOnOpen: true, extraRoots: [], excludedRoots: [], privatePaths: {} },
    groupings: { [main]: { fingerprint: 'fp-old', grouping: { engine: 'codex', model: 'gpt-5.5', groupedAt, disclosure: { items: 2 }, workstreams: [
      { id: 'ws-guide', title: 'Docs: setup guide', summary: 'Rewrites the setup guide. Looks finished.', area: 'docs', readiness: 'ready', files: ['docs/guide.md', 'docs/old.md'], sharedFiles: [], added: 99, removed: 99, suggestedCommit: 'docs: rewrite setup guide', private: false },
    ] } } },
    branchSummaries: { [`${main} feature-x`]: { tip: 'oldtip00', summary: 'Adds the export button.', at: groupedAt } },
  }));
  const restarted = await createWorkInFlight(f.options);
  f.services.push(restarted);
  const files = [change('docs/guide.md', { added: 7, removed: 2 }), change('src/app.ts')];
  f.raws[main] = rawRepo(main, [place(main, files, { fingerprint: 'fp-new' })], { branches: [branch('main', { worktreePath: main }), branch('feature-x', { tip: 'newtip00', aheadOfBase: 1 })] });
  let view = await restarted.read();
  let [repo] = view.repos;
  let grouping = repo.places[0].grouping;
  assert.equal(grouping.engine, 'codex');
  assert.equal(grouping.model, 'gpt-5.5');
  assert.equal(grouping.groupedAt, groupedAt);
  assert.equal(grouping.stale, true);
  assert.equal(grouping.note, 'Changed since it was grouped.');
  assert.deepEqual(grouping.workstreams.map(ws => [ws.id, ws.files, ws.added, ws.removed]), [['ws-guide', ['docs/guide.md'], 7, 2], [grouping.workstreams[1].id, ['src/app.ts'], 4, 1]]);
  assert.equal(grouping.workstreams[0].suggestedCommit, 'docs: rewrite setup guide');
  assert.equal(grouping.workstreams[1].title, 'Newer changes, not grouped yet');
  assert.equal(repo.headline, '2 things in progress, 1 looks ready to save');
  assert.equal(repo.branches[0].summary, 'Adds the export button.');
  assert.equal(repo.branches[0].summaryStale, true);
  assert.equal(view.totals.staleGroupings, 1);
  f.raws[main] = rawRepo(main, [place(main, [change('docs/guide.md'), change('docs/old.md')], { fingerprint: 'fp-old' })], { branches: [branch('main', { worktreePath: main }), branch('feature-x', { tip: 'oldtip00', aheadOfBase: 1 })] });
  view = await restarted.read({ maxAgeMs: 0 });
  [repo] = view.repos;
  grouping = repo.places[0].grouping;
  assert.equal(grouping.stale, false);
  assert.equal(grouping.note, null);
  assert.deepEqual(grouping.workstreams.map(ws => ws.files), [['docs/guide.md', 'docs/old.md']]);
  assert.equal(repo.headline, '1 thing in progress, 1 looks ready to save');
  assert.equal(repo.branches[0].summaryStale, false);
  assert.equal(view.totals.staleGroupings, 0);
});

test('grouping runs two targets at a time, records failures, stores results and keeps ids stable', async t => {
  const calls = [];
  let active = 0, peak = 0, gate, release = () => {};
  let failCharlie = true;
  const f = await fixture(t, {
    names: ['Alpha', 'Bravo', 'Charlie', 'Delta'],
    group: async (engine, request) => {
      calls.push({ engine, ...request });
      active += 1; peak = Math.max(peak, active);
      if (active >= 2) release();
      await gate;
      await delay(2);
      active -= 1;
      if (failCharlie && request.prompt.includes('Charlie')) throw new Error('Codex is signed out.');
      return { raw: answerFor(request.prompt), model: 'fake-model' };
    },
  });
  gate = new Promise(resolve => { release = resolve; });
  for (const name of ['Alpha', 'Bravo', 'Charlie']) f.raws[f.repos[name]] = rawRepo(f.repos[name], [place(f.repos[name], [change(`src/${name}.ts`), change(`docs/${name}.md`)])]);
  f.raws[f.repos.Delta] = rawRepo(f.repos.Delta, [place(f.repos.Delta, [change('README.md')])]);
  const before = await f.wif.read();
  assert.equal(before.totals.staleGroupings, 3);
  const job = f.wif.group({ reason: 'panel' });
  assert.equal(job.status, 'queued');
  assert.equal(job.engine, 'codex');
  assert.equal(job.reason, 'panel');
  assert.deepEqual(job.progress, { done: 0, total: 0 });
  assert.equal(job.finishedAt, null);
  assert.match(job.id, /^job-/);
  assert.equal(f.wif.group({ reason: 'agent', force: true }).id, job.id, 'A running job is returned instead of starting another.');
  const view = await settle(f.wif);
  assert.equal(peak, 2);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.engine, 'codex');
    assert.equal(call.effort, 'medium');
    assert.equal(call.claudeModel, 'opus');
    assert.equal(typeof call.schema, 'object');
    assert.ok(!call.prompt.includes('README.md'), 'Single-change folders are grouped locally.');
  }
  assert.equal(view.job.status, 'done');
  assert.deepEqual(view.job.progress, { done: 3, total: 3 });
  assert.equal(view.job.current, null);
  assert.ok(Number.isFinite(Date.parse(view.job.finishedAt)));
  assert.deepEqual(view.job.errors, ['Charlie was not grouped. Codex is signed out.']);
  assert.ok(f.changes.length >= 4);
  const byName = Object.fromEntries(view.repos.map(repo => [repo.name, repo]));
  for (const name of ['Alpha', 'Bravo']) {
    const grouping = byName[name].places[0].grouping;
    assert.equal(grouping.engine, 'codex');
    assert.equal(grouping.model, 'fake-model');
    assert.equal(grouping.stale, false);
    assert.equal(grouping.note, null);
    assert.ok(Number.isFinite(Date.parse(grouping.groupedAt)));
    assert.deepEqual(grouping.workstreams.map(ws => [ws.title, ws.readiness, ws.suggestedCommit, ws.files]), [['Product: first change', 'ready', 'feat: first change', [`docs/${name}.md`, `src/${name}.ts`]]]);
    assert.equal(byName[name].headline, '1 thing in progress, 1 looks ready to save');
  }
  assert.equal(byName.Charlie.places[0].grouping.engine, 'paths');
  assert.equal(byName.Delta.places[0].grouping.engine, 'paths');
  assert.equal(byName.Delta.places[0].grouping.note, null);
  assert.equal(view.totals.staleGroupings, 1);
  const stored = JSON.parse(await fs.readFile(f.file, 'utf8'));
  assert.deepEqual(Object.keys(stored.groupings).sort(), [f.repos.Alpha, f.repos.Bravo].sort());
  const alphaSaved = stored.groupings[f.repos.Alpha];
  assert.equal(alphaSaved.fingerprint, f.raws[f.repos.Alpha].places[0].fingerprint);
  assert.equal(alphaSaved.grouping.engine, 'codex');
  assert.equal(typeof alphaSaved.grouping.disclosure, 'object');
  const firstIds = Object.fromEntries(view.repos.map(repo => [repo.name, repo.places[0].grouping.workstreams.map(ws => ws.id)]));
  // Regrouping without force asks only for what changed or failed.
  failCharlie = false;
  calls.length = 0;
  f.wif.group({ reason: 'cli' });
  let next = await settle(f.wif);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].prompt.includes('Charlie'));
  assert.equal(next.job.status, 'done');
  assert.equal(next.job.reason, 'cli');
  assert.deepEqual(next.job.errors, []);
  assert.equal(next.totals.staleGroupings, 0);
  // A forced regroup with the same answer keeps workstream ids stable.
  calls.length = 0;
  f.wif.group({ force: true, reason: 'agent' });
  next = await settle(f.wif);
  assert.equal(calls.length, 3);
  const byNameNext = Object.fromEntries(next.repos.map(repo => [repo.name, repo]));
  for (const name of ['Alpha', 'Bravo']) assert.deepEqual(byNameNext[name].places[0].grouping.workstreams.map(ws => ws.id), firstIds[name]);
  // One project only.
  calls.length = 0;
  f.wif.group({ repoId: 'alpha', force: true });
  next = await settle(f.wif);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].prompt.includes('Alpha'));
  f.wif.group({ repoId: 'nobody' });
  next = await settle(f.wif);
  assert.equal(next.job.status, 'failed');
  assert.deepEqual(next.job.errors, ['No git project matches that id.']);
  assert.throws(() => f.wif.group({ reason: 'timer' }), /reason/);
  assert.throws(() => f.wif.group({ force: 'yes' }), /force/);
});

test('a job fails only when every target fails', async t => {
  const f = await fixture(t, { names: ['Alpha', 'Bravo'], group: async () => { throw new Error('Claude’s subscription login has expired. Use Reconnect Claude, finish signing in, then try again.'); } });
  for (const name of ['Alpha', 'Bravo']) f.raws[f.repos[name]] = rawRepo(f.repos[name], [place(f.repos[name], [change('a.ts'), change('b.ts')])]);
  await f.wif.updateSettings({ engine: 'claude', claudeModel: 'haiku', effort: 'low' });
  const job = f.wif.group();
  assert.equal(job.engine, 'claude');
  const view = await settle(f.wif);
  assert.equal(view.job.status, 'failed');
  assert.equal(view.job.errors.length, 2);
  assert.match(view.job.errors[0], /was not grouped\. Claude’s subscription login has expired/);
  assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).groupings[f.repos.Alpha], undefined);
  const empty = await fixture(t, { names: ['Clean'] });
  empty.wif.group();
  const idle = await settle(empty.wif);
  assert.equal(idle.job.status, 'done');
  assert.deepEqual(idle.job.progress, { done: 0, total: 0 });
});

test('grouping sends excerpts only for eligible files, hides private names and skips mirrors', async t => {
  const prompts = [];
  const excerptCalls = [];
  const headCalls = [];
  const f = await fixture(t, {
    same: async () => true,
    excerpts: async (folder, paths, deps) => { excerptCalls.push({ folder, paths, git: deps.git }); return new Map(paths.map(file => [file, ['+ const ready = true;']])); },
    untrackedHead: async (folder, file) => { headCalls.push({ folder, file }); return ['# Ideas for the pilot']; },
    group: async (engine, request) => { prompts.push(request.prompt); return { raw: answerFor(request.prompt), model: null }; },
  });
  const main = f.repos.Harbor;
  const codexPath = path.join(f.root, '.codex', 'worktrees', '0ced', 'Harbor');
  const files = () => [
    change('src/app.ts'), change('.env'), change('pilot/people/Jane Doe.md'), change('emails/intro-acme.md'), change('data/users.csv'),
    change('assets/logo.png', { binary: true, added: null, removed: null }), change('package-lock.json'), change('src/removed.ts', { status: 'deleted' }),
    change('notes/ideas.md', { status: 'untracked', unstaged: false }), change('demo/', { status: 'untracked', unstaged: false, isDir: true, fileCount: 3, added: null, removed: null }),
  ];
  await f.wif.updateSettings({ privatePaths: { [main]: ['pilot/'] } });
  f.raws[main] = rawRepo(main, [place(main, files(), { fingerprint: 'fp-a' }), place(codexPath, files(), { kind: 'codex', isMain: false, detached: true, fingerprint: 'fp-b' })]);
  f.wif.group();
  const view = await settle(f.wif);
  assert.equal(view.job.status, 'done');
  assert.equal(prompts.length, 1, 'The mirror worktree is not sent separately.');
  assert.deepEqual(excerptCalls, [{ folder: main, paths: ['src/app.ts'], git: '/usr/bin/git' }]);
  assert.deepEqual(headCalls, [{ folder: main, file: 'notes/ideas.md' }]);
  assert.ok(prompts[0].includes('src/app.ts'));
  assert.ok(!prompts[0].includes('Jane Doe'));
  assert.ok(!prompts[0].includes('intro-acme'));
  const [repo] = view.repos;
  assert.equal(repo.places[1].grouping, null);
  assert.equal(repo.places[0].grouping.workstreams[0].private, true);
  assert.equal(repo.places[0].files.find(file => file.path === '.env').private, true);
});

test('turning grouping off blocks model calls; branch-only requests and close still work', async t => {
  const calls = [];
  let unblock;
  const f = await fixture(t, { group: async (engine, request) => { calls.push(request); if (unblock) await new Promise(resolve => { unblock = resolve; }); return { raw: answerFor(request.prompt), model: 'm' }; } });
  const main = f.repos.Harbor;
  f.raws[main] = rawRepo(main, [place(main, [change('a.ts'), change('b.ts')])], { branches: [branch('main', { worktreePath: main }), branch('fp-audit-governance', { tip: 'dddd4444', aheadOfBase: 3, upstream: null })] });
  await f.wif.updateSettings({ engine: 'off' });
  assert.throws(() => f.wif.group(), /Grouping is turned off\. Choose Codex or Claude in Work in flight settings\./);
  let view = await f.wif.read();
  assert.equal(view.disclosure, DISCLOSURE_OFF);
  assert.equal(view.totals.staleGroupings, 0);
  assert.equal(view.repos[0].places[0].grouping.note, 'Grouped by folder.');
  assert.equal(calls.length, 0);
  await f.wif.updateSettings({ engine: 'codex' });
  f.raws[main] = rawRepo(main, [place(main, [])], { branches: [branch('main', { worktreePath: main }), branch('fp-audit-governance', { tip: 'dddd4444', aheadOfBase: 3, upstream: null })] });
  view = await f.wif.read({ maxAgeMs: 0 });
  assert.equal(view.repos[0].status, 'work');
  assert.equal(view.repos[0].headline, 'All saved. 3 commits not shared yet. 1 open branch.');
  assert.equal(view.totals.staleGroupings, 1);
  f.wif.group();
  view = await settle(f.wif);
  assert.equal(calls.length, 1);
  assert.match(calls[0].prompt, /B001/);
  assert.equal(view.repos[0].branches[0].summary, 'Adds a governance audit.');
  assert.equal(view.repos[0].branches[0].summaryStale, false);
  assert.equal(view.totals.staleGroupings, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(f.file, 'utf8')).groupings, {});
  // close waits for the running job, then refuses new work.
  f.raws[main] = rawRepo(main, [place(main, [change('c.ts'), change('d.ts')])]);
  unblock = () => {};
  f.wif.group();
  for (let attempt = 0; attempt < 200 && calls.length < 2; attempt++) await delay(5);
  assert.equal(calls.length, 2);
  let closed = false;
  const closing = f.wif.close().then(() => { closed = true; });
  await delay(20);
  assert.equal(closed, false);
  assert.throws(() => f.wif.group({ force: true }), /closing/);
  await assert.rejects(f.wif.updateSettings({ effort: 'low' }), /closing/);
  unblock();
  await closing;
  assert.equal(closed, true);
});

test('slow scans answer by the deadline, finish once, and concurrent reads share one scan', async t => {
  let releaseSlow;
  const slowGate = new Promise(resolve => { releaseSlow = resolve; });
  const f = await fixture(t, { names: ['Fast', 'Slow'], limits: { deadlineMs: 40 } });
  f.raws[f.repos.Slow] = async folder => { await slowGate; return rawRepo(folder, [place(folder, [change('late.ts')])]); };
  const [first, second] = await Promise.all([f.wif.read(), f.wif.read()]);
  assert.equal(f.scanned.length, 2, 'Concurrent reads share a scan.');
  assert.equal(first.scannedAt, second.scannedAt);
  const slow = first.repos.find(repo => repo.name === 'Slow');
  assert.equal(slow.status, 'error');
  assert.equal(slow.error, 'Still checking; try again in a moment.');
  assert.equal(slow.headline, 'Still checking; try again in a moment.');
  assert.equal(first.repos.find(repo => repo.name === 'Fast').status, 'clean');
  const again = await f.wif.read({ maxAgeMs: 0 });
  assert.equal(f.scanned.length, 2, 'No second scan starts while the first is finishing.');
  assert.equal(again.repos.find(repo => repo.name === 'Slow').status, 'error');
  const pushes = f.changes.length;
  releaseSlow();
  for (let attempt = 0; attempt < 200 && f.changes.length === pushes; attempt++) await delay(5);
  assert.ok(f.changes.length > pushes, 'The finished scan is pushed to listeners.');
  const done = await f.wif.read({ maxAgeMs: 60000 });
  assert.equal(done.repos.find(repo => repo.name === 'Slow').status, 'work');
  assert.equal(f.scanned.length, 2);
  const cached = await f.wif.read({ maxAgeMs: 60000 });
  assert.equal(cached.scannedAt, done.scannedAt);
  await f.wif.read({ maxAgeMs: 0 });
  assert.equal(f.scanned.length, 4);
});

test('with the real read-only scanner, a fixture repository becomes a plain view and stays untouched', async t => {
  const { execFileSync } = await import('node:child_process');
  const { run, scrubbedEnv } = await import('../src/main/process.mjs');
  const { GIT_ENV } = await import('../src/core/git-scan.mjs');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'summon-wif-git-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'Projects', 'Hackathon — API World');
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' });
  await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  await fs.mkdir(path.join(repo, 'pilot', 'people'), { recursive: true });
  await fs.writeFile(path.join(repo, 'src', 'app.ts'), 'one\n');
  await fs.writeFile(path.join(repo, 'pilot', 'people', 'Jane Doe.md'), 'hello\n');
  git(repo, 'init');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'Initial');
  git(repo, 'branch', 'feature-x');
  const worktree = path.join(repo, '.claude', 'worktrees', 'calm');
  git(repo, 'worktree', 'add', worktree, 'feature-x');
  await fs.writeFile(path.join(worktree, 'src', 'feature.ts'), 'feature\n');
  git(worktree, 'add', '.');
  git(worktree, 'commit', '-m', 'Add feature');
  await fs.writeFile(path.join(repo, 'src', 'app.ts'), 'one\ntwo\n');
  await fs.writeFile(path.join(repo, 'pilot', 'people', 'Jane Doe.md'), 'hello\nagain\n');
  const index = path.join(repo, '.git', 'index');
  const before = await fs.stat(index);
  const prompts = [];
  const wif = await createWorkInFlight({
    dataDir: path.join(root, 'Data'), homeDir: root, getProjects: async () => [{ id: 'hack', name: 'Hackathon', path: repo }], run, git: '/usr/bin/git', env: scrubbedEnv(GIT_ENV),
    group: async (engine, request) => { prompts.push(request.prompt); return { raw: answerFor(request.prompt), model: null }; },
  });
  t.after(() => wif.close());
  await wif.updateSettings({ privatePaths: { [repo]: ['pilot/'] } });
  const view = await wif.read();
  const [item] = view.repos;
  assert.equal(item.displayPath, '~/Projects/Hackathon — API World');
  assert.equal(item.defaultBranch, 'main');
  assert.equal(item.hasRemote, false);
  assert.deepEqual(item.places.map(p => [p.label, p.stateWords]), [['Main folder', ['not saved yet']], ['Claude worktree · calm', ['only on this Mac']]]);
  assert.deepEqual(item.places[0].files.map(file => [file.path, file.status, file.private]), [['pilot/people/Jane Doe.md', 'modified', true], ['src/app.ts', 'modified', false]]);
  assert.deepEqual(item.branches.map(b => [b.name, b.stateWords]), [['feature-x', ['1 commit not in main', 'only on this Mac', 'open in Claude worktree · calm']]]);
  assert.equal(view.totals.staleGroupings, 1);
  wif.group();
  const grouped = await settle(wif);
  assert.equal(grouped.job.status, 'done');
  assert.equal(prompts.length, 1);
  assert.ok(!prompts[0].includes('Jane Doe'));
  assert.ok(prompts[0].includes('feature-x'));
  assert.equal(grouped.repos[0].places[0].grouping.engine, 'codex');
  assert.equal(grouped.repos[0].branches[0].summary, 'Adds a governance audit.');
  const after = await fs.stat(index);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.size, before.size);
  await assert.rejects(fs.access(path.join(repo, '.git', 'index.lock')), { code: 'ENOENT' });
});

test('opening the panel and agents send nothing until the person presses Group changes once', async t => {
  const calls = [];
  const f = await fixture(t, { group: async (engine, request) => { calls.push(request.prompt); return { raw: answerFor(request.prompt), model: null }; } });
  const main = f.repos.Harbor;
  f.raws[main] = rawRepo(main, [place(main, [change('a.ts'), change('b.ts')])]);
  let view = await f.wif.read();
  assert.equal(view.settings.consentedAt, null);
  assert.equal(view.disclosure, DISCLOSURE_CODEX);
  assert.ok(view.totals.staleGroupings > 0);
  assert.deepEqual(view.privateDefaults.slice(0, 3), ['email', 'emails', 'people']);
  assert.throws(() => f.wif.group({ reason: 'open' }), NEEDS_CONSENT);
  assert.throws(() => f.wif.group({ reason: 'agent' }), NEEDS_CONSENT);
  assert.equal(calls.length, 0);
  // The terminal is an explicit request (it prints the disclosure first) but is not the panel consent.
  f.wif.group({ reason: 'cli', force: true });
  view = await settle(f.wif);
  assert.equal(calls.length, 1);
  assert.equal(view.settings.consentedAt, null);
  assert.throws(() => f.wif.group({ reason: 'agent' }), NEEDS_CONSENT);
  // Pressing Group changes records consent before the model is called.
  let consentAtCall = null;
  const consentCheck = await fixture(t, { group: async (engine, request) => { consentAtCall = JSON.parse(await fs.readFile(consentFile, 'utf8')).settings.consentedAt; return { raw: answerFor(request.prompt), model: null }; } });
  const consentFile = consentCheck.file;
  consentCheck.raws[consentCheck.repos.Harbor] = rawRepo(consentCheck.repos.Harbor, [place(consentCheck.repos.Harbor, [change('a.ts'), change('b.ts')])]);
  consentCheck.wif.group({ reason: 'panel' });
  view = await settle(consentCheck.wif);
  assert.ok(Number.isFinite(Date.parse(consentAtCall)), 'consent was saved before the model call');
  assert.equal(view.settings.consentedAt, consentAtCall);
  assert.equal(view.disclosure, DISCLOSURE_CODEX_OPEN);
  consentCheck.wif.group({ reason: 'agent', force: true });
  assert.equal((await settle(consentCheck.wif)).job.status, 'done');
  // Consent survives a restart; with Group on open off the note says so.
  const restarted = await createWorkInFlight(consentCheck.options);
  consentCheck.services.push(restarted);
  assert.equal(restarted.settings().consentedAt, consentAtCall);
  await restarted.updateSettings({ groupOnOpen: false });
  assert.equal((await restarted.read()).disclosure, DISCLOSURE_CODEX_CLICK);
  assert.equal(disclosureFor({ engine: 'off' }), DISCLOSURE_OFF);
  assert.ok(DISCLOSURE_CODEX_OPEN.includes('branch') && DISCLOSURE_CODEX_OPEN.includes('commit') && DISCLOSURE_CODEX_OPEN.includes('file types'));
});

test('private folder keys written by hand apply with a trailing slash or a symlinked path', async t => {
  const prompts = [];
  const f = await fixture(t, { names: ['Studio', 'Alias', 'Skip'], excerpts: async (folder, paths) => new Map(paths.map(item => [item, [item.startsWith('pilot/') ? '+ Dana wants a 40% discount' : '+ ordinary change']])), group: async (engine, request) => { prompts.push(request.prompt); return { raw: answerFor(request.prompt), model: null }; } });
  const { Studio, Alias, Skip } = f.repos;
  await fs.symlink(Alias, path.join(f.root, 'alias-link'));
  for (const folder of [Studio, Alias]) f.raws[folder] = rawRepo(folder, [place(folder, [change('pilot/notes/Dana Whitfield call.md'), change('src/app.ts')])]);
  await fs.writeFile(f.file, JSON.stringify({
    version: 1,
    settings: { engine: 'codex', effort: 'medium', claudeModel: 'opus', groupOnOpen: true, extraRoots: [], excludedRoots: [`${Skip}/`], consentedAt: null,
      privatePaths: { [`${Studio}/`]: ['pilot/'], [path.join(f.root, 'alias-link')]: ['pilot/'], [path.join(f.root, 'Nowhere')]: ['x/'] } },
    groupings: {}, branchSummaries: {},
  }));
  const view = await f.wif.read();
  assert.deepEqual(Object.keys(view.settings.privatePaths).sort(), [Alias, Studio, path.join(f.root, 'Nowhere')].sort());
  assert.deepEqual(view.repos.map(repo => repo.name).sort(), ['Alias', 'Studio'], 'an excluded root with a trailing slash still covers the project');
  for (const repo of view.repos) assert.equal(repo.places[0].files.find(file => file.path.startsWith('pilot/')).private, true, repo.name);
  assert.match(view.errors.join('\n'), /Private folders are listed under ~\/Nowhere, which is not a folder on this Mac/);
  f.wif.group({ reason: 'cli' });
  await settle(f.wif);
  assert.equal(prompts.length, 2);
  for (const prompt of prompts) {
    assert.equal(prompt.includes('Dana'), false);
    assert.equal(prompt.includes('Whitfield'), false);
  }
});

test('a folder that could not be read, or details that could not be listed, never read as caught up', async t => {
  const f = await fixture(t, { names: ['MainFail', 'LinkedFail', 'Partial'] });
  const { MainFail, LinkedFail, Partial } = f.repos;
  const tooMany = 'There are too many changes here to list.';
  f.raws[MainFail] = rawRepo(MainFail, [place(MainFail, [], { error: tooMany, fingerprint: null }), place(path.join(MainFail, '.claude/worktrees/x'), [change('a.ts')], { kind: 'claude', isMain: false, branch: 'x' })], { error: tooMany });
  f.raws[LinkedFail] = rawRepo(LinkedFail, [place(LinkedFail, []), place(path.join(LinkedFail, '.claude/worktrees/y'), [], { kind: 'claude', isMain: false, branch: 'y', error: 'This worktree folder no longer belongs to this repository.' })]);
  f.raws[Partial] = rawRepo(Partial, [place(Partial, [])], { warnings: ['Summon could not list the branches.'] });
  const view = await f.wif.read();
  const byName = Object.fromEntries(view.repos.map(repo => [repo.name, repo]));
  assert.equal(byName.MainFail.status, 'attention');
  assert.match(byName.MainFail.headline, /^1 thing in progress\. Main folder could not be checked\. There are too many changes here to list\.$/);
  assert.deepEqual(byName.MainFail.places[0].stateWords, ['could not be checked']);
  assert.equal(byName.LinkedFail.status, 'attention');
  assert.equal(byName.LinkedFail.headline, 'A folder could not be checked.');
  assert.equal(byName.Partial.status, 'attention');
  assert.equal(byName.Partial.headline, 'Some details could not be checked.');
  assert.ok(view.errors.includes('Partial: Summon could not list the branches.'));
  for (const repo of view.repos) assert.notEqual(repo.headline, 'All caught up.');
  assert.equal(view.totals.reposWithWork, 3);
});

test('attention headlines say why, and a branch in use is never finished', async t => {
  const f = await fixture(t, { names: ['Conflict', 'Diverged', 'Gone', 'Busy'] });
  const { Conflict, Diverged, Gone, Busy } = f.repos;
  f.raws[Conflict] = rawRepo(Conflict, [place(Conflict, [change('a.ts', { status: 'conflicted' }), change('b.ts')])]);
  f.raws[Diverged] = rawRepo(Diverged, [place(Diverged, [], { ahead: 2, behind: 6 })], { branches: [branch('main', { tip: 'aaaa1111', ahead: 2, behind: 6, worktreePath: Diverged })] });
  f.raws[Gone] = rawRepo(Gone, [place(Gone, [])], { branches: [branch('main', { worktreePath: Gone }), branch('old-idea', { aheadOfBase: 2, upstreamGone: true })] });
  const claudePath = path.join(Busy, '.claude', 'worktrees', 'upbeat');
  const quietPath = path.join(Busy, '.claude', 'worktrees', 'quiet');
  const gonePath = path.join(f.root, 'gone-wt');
  f.raws[Busy] = rawRepo(Busy, [
    place(Busy, []),
    place(claudePath, [change('src/new.ts', { status: 'untracked', unstaged: false })], { kind: 'claude', isMain: false, branch: 'upbeat' }),
    place(quietPath, [], { kind: 'claude', isMain: false, branch: 'quiet' }),
    place(gonePath, [], { kind: 'other', isMain: false, missing: true, branch: 'left', fingerprint: null }),
  ], { branches: [
    branch('main', { worktreePath: Busy }),
    branch('upbeat', { worktreePath: claudePath }),
    branch('quiet', { worktreePath: quietPath }),
    branch('left', { worktreePath: gonePath, lastCommitAt: '2026-09-01T10:00:00.000Z' }),
    branch('skipped', { worktreePath: path.join(f.root, 'Archive', 'sealed-client', 'wt'), lastCommitAt: '2026-09-02T10:00:00.000Z' }),
    branch('old-merged', { lastCommitAt: '2026-08-01T10:00:00.000Z' }),
  ] });
  const view = await f.wif.read();
  const byName = Object.fromEntries(view.repos.map(repo => [repo.name, repo]));
  assert.match(byName.Conflict.headline, /^Conflicting edits need a decision\. /);
  assert.equal(byName.Diverged.headline, '2 saved here and 6 newer on GitHub need combining. All saved. 2 commits not shared yet.');
  assert.equal(byName.Gone.headline, 'A branch was deleted on GitHub. All saved. 2 commits not shared yet. 1 open branch.');
  const busy = Object.fromEntries(byName.Busy.branches.map(item => [item.name, item]));
  assert.equal(busy.upbeat.merged, false);
  assert.deepEqual(busy.upbeat.stateWords, ['nothing saved on it yet, work in progress', 'open in Claude worktree · upbeat']);
  assert.equal(busy.quiet.merged, false);
  assert.deepEqual(busy.quiet.stateWords, ['nothing new on it yet', 'open in Claude worktree · quiet']);
  assert.equal(busy.skipped.merged, false, 'a branch checked out in a folder the scanner skipped is still in use');
  assert.equal(busy.left.merged, true, 'a branch whose folder is gone can be cleaned up');
  assert.equal(busy['old-merged'].merged, true);
  assert.deepEqual(busy['old-merged'].stateWords, ['done, safe to clean up']);
  assert.equal(view.totals.openBranches, 1 + 3);
});

test('a worktree whose changes are all in the main folder is a mirror; anything else is not', async t => {
  const sameCalls = [];
  let verdict = true;
  const f = await fixture(t, { names: ['Draft'], same: async (a, b, paths) => { sameCalls.push(paths); return verdict; }, group: async (engine, request) => { prompts.push(request.prompt); return { raw: answerFor(request.prompt), model: null }; } });
  const prompts = [];
  const main = f.repos.Draft;
  const codexPath = path.join(f.root, '.codex', 'worktrees', '0ced', 'Draft');
  const shared = () => [change('api/a.py'), change('api/b.py')];
  const mainFiles = [...shared(), change('web/c.ts'), change('web/d.ts')];
  const scenario = (codexFiles, extra = {}) => { f.raws[main] = rawRepo(main, [place(main, mainFiles, { fingerprint: 'fp-main' }), place(codexPath, codexFiles, { kind: 'codex', isMain: false, detached: true, fingerprint: `fp-${sha(JSON.stringify([codexFiles, extra])).slice(0, 8)}`, ...extra })]); };
  scenario(shared());
  let view = await f.wif.read({ maxAgeMs: 0 });
  let [repo] = view.repos;
  assert.equal(repo.places[1].mirrorOf, repo.places[0].id);
  assert.deepEqual(sameCalls.at(-1), ['api/a.py', 'api/b.py']);
  assert.equal(view.totals.unsavedItems, 4);
  assert.equal(view.totals.staleGroupings, 1);
  f.wif.group({ reason: 'panel' });
  await settle(f.wif);
  assert.equal(prompts.length, 1, 'only the main folder is sent');
  const callsBefore = sameCalls.length;
  scenario([...shared(), change('api/extra.py')]);
  view = await f.wif.read({ maxAgeMs: 0 });
  assert.equal(view.repos[0].places[1].mirrorOf, null, 'a file missing from main');
  scenario([change('api/a.py', { added: 99 }), change('api/b.py')]);
  view = await f.wif.read({ maxAgeMs: 0 });
  assert.equal(view.repos[0].places[1].mirrorOf, null, 'different line counts');
  scenario(shared(), { filesTruncated: true });
  view = await f.wif.read({ maxAgeMs: 0 });
  assert.equal(view.repos[0].places[1].mirrorOf, null, 'a truncated list');
  scenario(shared(), { head: 'bbbb2222' });
  view = await f.wif.read({ maxAgeMs: 0 });
  assert.equal(view.repos[0].places[1].mirrorOf, null, 'a different commit');
  assert.equal(sameCalls.length, callsBefore, 'no content check without matching change lists');
  verdict = false;
  scenario(shared(), { fingerprint: 'fp-other-bytes' });
  view = await f.wif.read({ maxAgeMs: 0 });
  assert.equal(view.repos[0].places[1].mirrorOf, null, 'same list, different bytes');
});

test('skipping a folder while a job waits for a slow scan never groups it and never blames the others', async t => {
  const prompts = [];
  let releaseSlow;
  const f = await fixture(t, { names: ['Slow', 'Excluded'], limits: { deadlineMs: 100 }, group: async (engine, request) => { prompts.push(request.prompt); return { raw: answerFor(request.prompt), model: null }; } });
  const { Slow, Excluded } = f.repos;
  f.raws[Slow] = async folder => { await delay(500); return rawRepo(folder, [place(folder, [change('slow-a.ts'), change('slow-b.ts')])]); };
  f.raws[Excluded] = rawRepo(Excluded, [place(Excluded, [change('excluded-a.ts'), change('excluded-b.ts')])]);
  f.wif.group({ reason: 'panel' });
  await delay(150);
  await f.wif.updateSettings({ excludedRoots: [Excluded] });
  const view = await settle(f.wif);
  releaseSlow?.();
  assert.equal(view.job.status, 'done');
  assert.deepEqual(view.job.errors, []);
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].includes('Slow'));
  assert.equal(prompts.some(prompt => prompt.includes('Excluded') || prompt.includes('excluded-a')), false);
  assert.deepEqual(view.repos.map(repo => repo.name), ['Slow']);
});

test('single-change places always show the folder grouping, even with an old model grouping', async t => {
  const f = await fixture(t, { group: async (engine, request) => ({ raw: answerFor(request.prompt), model: 'm' }) });
  const main = f.repos.Harbor;
  f.raws[main] = rawRepo(main, [place(main, [change('a.ts'), change('b.ts')], { fingerprint: 'fp-two' })]);
  f.wif.group({ reason: 'panel' });
  let view = await settle(f.wif);
  assert.equal(view.repos[0].places[0].grouping.engine, 'codex');
  f.raws[main] = rawRepo(main, [place(main, [change('a.ts')], { fingerprint: 'fp-one' })]);
  view = await f.wif.read({ maxAgeMs: 0 });
  let grouping = view.repos[0].places[0].grouping;
  assert.deepEqual([grouping.engine, grouping.stale, grouping.note, view.totals.staleGroupings], ['paths', false, null, 0]);
  f.raws[main] = rawRepo(main, [place(main, [change('new.ts')], { fingerprint: 'fp-new' })]);
  view = await f.wif.read({ maxAgeMs: 0 });
  grouping = view.repos[0].places[0].grouping;
  assert.equal(grouping.engine, 'paths');
  assert.equal(grouping.workstreams.some(ws => ws.title === 'Newer changes, not grouped yet'), false);
  f.raws[main] = rawRepo(main, [place(main, [change('a.ts'), change('c.ts')], { fingerprint: 'fp-back' })]);
  view = await f.wif.read({ maxAgeMs: 0 });
  assert.equal(view.repos[0].places[0].grouping.stale, true, 'the saved grouping comes back once the place can be regrouped');
  assert.equal(view.totals.staleGroupings, 1);
});

test('agent reads hide private paths in commit subjects, stash messages and folder titles', async t => {
  const f = await fixture(t);
  const main = f.repos.Harbor;
  await f.wif.updateSettings({ privatePaths: { [main]: ['pilot/'] } });
  f.raws[main] = rawRepo(main, [place(main, [change('interviews/Jane Doe transcript/notes.md'), change('src/app.ts')])], {
    branches: [branch('main', { worktreePath: main }), branch('notes', { aheadOfBase: 1, subject: 'notes from pilot/people/Jane Doe.md call' })],
    stashes: [{ index: 0, message: 'WIP on main: abc notes from pilot/people/Jane Doe.md call', branch: 'main', createdAt: null, files: 1 }, { index: 1, message: 'On main: backup of emails/acme-renewal.eml', branch: 'main', createdAt: null, files: 1 }],
  });
  const masked = await f.wif.read({ includeFiles: true, maskPrivate: true });
  const [repo] = masked.repos;
  assert.equal(repo.branches[0].subject, 'notes from [private path] call');
  assert.ok(repo.stashes.every(stash => stash.message.includes('[private path]')));
  const text = JSON.stringify(masked);
  for (const leak of ['Jane Doe', 'acme-renewal']) assert.equal(text.includes(leak), false, leak);
  assert.ok(repo.places[0].grouping.workstreams.some(ws => ws.title === 'Private file in interviews/'));
  const local = (await f.wif.read({ includeFiles: true })).repos[0];
  assert.equal(local.branches[0].subject, 'notes from pilot/people/Jane Doe.md call', 'the local panel keeps the original text');
  assert.match(local.stashes[1].message, /acme-renewal/);
});

test('excerpts are read at twice the shown width and renamed private files are never excerpted', async t => {
  const widths = [];
  const excerptPaths = [];
  const f = await fixture(t, {
    excerpts: async (folder, paths, deps) => { widths.push(deps.width); excerptPaths.push(...paths); return new Map(paths.map(item => [item, ['+ line']])); },
    untrackedHead: async (folder, file, deps) => { widths.push(deps.width); return ['# note']; },
    group: async (engine, request) => ({ raw: answerFor(request.prompt), model: null }),
  });
  const main = f.repos.Harbor;
  await f.wif.updateSettings({ privatePaths: { [main]: ['pilot/'] } });
  f.raws[main] = rawRepo(main, [place(main, [change('src/app.ts'), change('notes/idea.md', { status: 'untracked', unstaged: false }), change('archive/contact-a.md', { status: 'renamed', origPath: 'pilot/people/jane.md', staged: true })])]);
  f.wif.group({ reason: 'panel' });
  const view = await settle(f.wif);
  assert.equal(view.job.status, 'done');
  assert.deepEqual(widths, [320, 320]);
  assert.deepEqual(excerptPaths, ['src/app.ts']);
  assert.equal(view.repos[0].places[0].files.find(file => file.path === 'archive/contact-a.md').private, true);
});
