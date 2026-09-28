import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createSessionFacts, factsForAgent, factsText, FACT_LIMITS } from '../src/core/session-facts.mjs';
import { createAgentSessions } from '../src/core/agent-sessions.mjs';
import { setSealedSegments } from '../src/core/workstreams.mjs';

setSealedSegments(['sealed-client']);

// Synthetic repositories only: a fake git answers the four read-only questions session-facts asks.
const HARBOR = '/Users/someone/Projects/Harbor';
const WT = '/Users/someone/Projects/Harbor/.claude/worktrees/calm-otter';
const T0 = Date.parse('2026-09-20T10:00:00.000Z');
const SEC = 1000;
const MIN = 60000;
const HOUR = 60 * MIN;
const iso = ms => new Date(ms).toISOString();
const oid = n => String(n).repeat(40).slice(0, 40);

/** A fake read-only git over repositories { cwd: { remotes: bool, commits: [{ oid, ct, heads, remotes, reflog, files }] } }.
 *  A commit is in HEAD's reflog when it is on a branch, or when `reflog` says so (one reset away). Every call is
 *  recorded, and anything it does not know throws, like git would. */
function fakeGit(repos) {
  const calls = [];
  const git = async (cwd, args, options = {}) => {
    calls.push([cwd, ...args]);
    const repo = repos[cwd];
    if (!repo) throw Object.assign(new Error('not a git repository'), { exitCode: 128 });
    const [command, ...rest] = args;
    if (command === 'cat-file') {
      return String(options.input).trim().split('\n').map(sha => {
        const found = repo.commits.filter(item => item.oid.startsWith(sha));
        return found.length === 1 ? `${found[0].oid} commit` : found.length ? `${sha} ambiguous` : `${sha} missing`;
      }).join('\n') + '\n';
    }
    if (command === 'for-each-ref' && rest.includes('--count=1')) return repo.remotes ? 'refs/remotes/origin/main\n' : '';
    if (command === 'for-each-ref' && rest[0] === '--contains') {
      const item = repo.commits.find(entry => entry.oid === rest[1]);
      if (!item) throw Object.assign(new Error('malformed object name'), { exitCode: 129 });
      return [...(item.heads ?? []).map(ref => `refs/heads/${ref}`), ...(item.remotes ?? []).map(ref => `refs/remotes/${ref}`)].join('\n') + '\n';
    }
    if (command === 'log') {
      const since = Number(rest.find(arg => arg.startsWith('--since=@')).slice(9));
      // Files touched on HEAD since then, newest first, the way `--format=%x1e%ct --name-only` prints them.
      if (rest.includes('--name-only')) {
        return repo.commits.filter(item => item.heads?.length && item.ct >= since).sort((a, b) => b.ct - a.ct).map(item => `\u001e${item.ct}\n\n${(item.files ?? []).join('\n')}\n`).join('');
      }
      assert.ok(rest.includes('--walk-reflogs') && rest.includes('HEAD'), 'a quiet commit is looked for in HEAD\'s reflog');
      const until = Number(rest.find(arg => arg.startsWith('--until=@')).slice(9));
      // Like git, the date limits are applied loosely; session-facts checks the window itself.
      return repo.commits.filter(item => (item.reflog ?? Boolean(item.heads?.length)) && item.ct >= since - 1 && item.ct <= until + 1).map(item => `${item.oid}\u001f${item.ct}`).join('\n') + '\n';
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  return { git, calls };
}
const place = (id, cwd, uncommitted = []) => ({ id, cwd, roots: [cwd], uncommitted });
const commitAction = (at, sha, folder = HARBOR, branch = 'main') => ({ kind: 'commit', at, folder, sha, branch, action: 'committed', number: null, quiet: false, from: null });
const quietAction = (from, at, folder = HARBOR) => ({ kind: 'commit', at, folder, sha: null, branch: null, action: null, number: null, quiet: true, from });
const log = (extra = {}) => ({ git: [], tests: [], asked: null, lastUserAt: null, ...extra });
const session = (key, extra = {}) => ({ key, placeId: 'p-main', roots: [HARBOR], touchedPaths: [], touchedTimes: [], workLog: null, ...extra });

test('facts: commits resolved in the repository, pushed as far as local refs know', async () => {
  const { git, calls } = fakeGit({
    [HARBOR]: { remotes: true, commits: [
      { oid: oid('a'), ct: T0 / 1000, heads: ['main'], remotes: ['origin/main'] },
      { oid: oid('b'), ct: T0 / 1000 + 60, heads: ['feature/x'], remotes: [] },
      // Amended away: git still has the object, but no branch holds it.
      { oid: oid('c'), ct: T0 / 1000 + 120, heads: [], remotes: [] },
    ] },
    '/Users/someone/Projects/Tide': { remotes: false, commits: [{ oid: oid('d'), ct: T0 / 1000, heads: ['main'], remotes: [] }] },
  });
  const facts = createSessionFacts({ git, now: () => T0 });
  const out = await facts.compute({
    places: [place('p-main', HARBOR), place('p-tide', '/Users/someone/Projects/Tide')],
    sessions: [
      session('pushed', { workLog: log({ git: [commitAction(T0, 'aaaaaaa')] }) }),
      session('unpushed', { workLog: log({ git: [commitAction(T0 + MIN, 'bbbbbbb', `${HARBOR}/sub`, 'feature/x')] }) }),
      session('dangling', { workLog: log({ git: [commitAction(T0 + 2 * MIN, 'ccccccc')] }) }),
      session('missing', { workLog: log({ git: [commitAction(T0 + 3 * MIN, 'eeeeeee')] }) }),
      session('no-remote', { placeId: 'p-tide', workLog: log({ git: [commitAction(T0, 'ddddddd', '/Users/someone/Projects/Tide')] }) }),
    ],
  });
  const commit = key => out.get(key).commits[0];
  assert.deepEqual(commit('pushed'), { sha: 'aaaaaaa', oid: oid('a'), branch: 'main', at: iso(T0), inferred: false, exists: true, pushed: true, onBranch: null });
  assert.deepEqual([commit('unpushed').pushed, commit('unpushed').onBranch, commit('unpushed').branch], [false, true, 'feature/x'], 'a subfolder is asked in its repository');
  assert.deepEqual([commit('dangling').pushed, commit('dangling').onBranch], [false, false]);
  assert.deepEqual([commit('missing').exists, commit('missing').oid, commit('missing').pushed], [false, null, null]);
  assert.deepEqual([commit('no-remote').pushed, commit('no-remote').onBranch], [null, true], 'no remote-tracking refs: pushed is unknown, not false');
  assert.equal(factsText(out.get('pushed')), 'Committed aaaaaaa, pushed');
  assert.equal(factsText(out.get('unpushed')), 'Committed bbbbbbb, not pushed');
  assert.equal(factsText(out.get('dangling')), 'Committed ccccccc, not pushed, on no branch');
  assert.equal(factsText(out.get('missing')), 'Committed eeeeeee, no longer in the repository');
  assert.equal(factsText(out.get('no-remote')), 'Committed ddddddd');
  // One existence check per repository, whatever the number of commits in it.
  assert.equal(calls.filter(call => call[1] === 'cat-file' && call[0] === HARBOR).length, 1);
  // Every call is one of the read-only questions: no fetch, no write.
  assert.ok(calls.every(call => ['cat-file', 'for-each-ref', 'log'].includes(call[1])), JSON.stringify(calls));
});

test('facts: a quiet commit is matched by its window, two seconds either side, and marked inferred', async () => {
  const { git } = fakeGit({ [HARBOR]: { remotes: true, commits: [
    { oid: oid('1'), ct: T0 / 1000 + 5, heads: ['main'], remotes: [] },
    // Two seconds after the result still counts; three does not.
    { oid: oid('2'), ct: T0 / 1000 + 12, heads: ['main'], remotes: [] },
    { oid: oid('3'), ct: T0 / 1000 + 13, heads: ['main'], remotes: [] },
    { oid: oid('4'), ct: T0 / 1000 - 3, heads: ['main'], remotes: [] },
  ] } });
  const out = await createSessionFacts({ git, now: () => T0 }).compute({
    places: [place('p-main', HARBOR)],
    sessions: [
      session('quiet', { workLog: log({ git: [quietAction(T0, T0 + 10 * SEC)] }) }),
      // The same commit named by an annotation too is listed once.
      session('both', { workLog: log({ git: [commitAction(T0 + 5 * SEC, '1111111'), quietAction(T0 + 4 * SEC, T0 + 6 * SEC)] }) }),
    ],
  });
  const quiet = out.get('quiet');
  assert.deepEqual(quiet.commits.map(item => [item.oid, item.inferred, item.pushed]), [[oid('1'), true, false], [oid('2'), true, false]]);
  assert.equal(quiet.commitCount, 2);
  assert.equal(factsText(quiet), 'Probably committed 1111111 and 1 more, 2 not pushed');
  assert.deepEqual(out.get('both').commits.map(item => [item.sha, item.inferred]), [['1111111', false]]);
});

test('facts: uncommitted files, who shares them and who wrote each one last', async () => {
  const at = rel => `${HARBOR}/${rel}`;
  const out = await createSessionFacts({ git: null }).compute({
    places: [place('p-main', HARBOR, ['src/a.ts', 'src/b.ts', 'src/c.ts', 'notes.md', 'new/']), place('p-wt', WT, ['src/a.ts'])],
    sessions: [
      session('claude:desktop:local_a', { touchedPaths: [at('src/a.ts'), at('src/b.ts'), at('new/deep/file.ts'), at('src/committed.ts')], touchedTimes: [T0 + 5 * MIN, T0 + MIN, T0 + 2 * MIN, T0] }),
      session('claude:terminal:t-c', { touchedPaths: [at('src/a.ts'), at('src/b.ts')], touchedTimes: [T0 + 3 * MIN, T0 + 4 * MIN] }),
      // Codex reports paths without times, so who wrote last is unknown on its side.
      session('codex:desktop:x', { touchedPaths: [at('src/b.ts'), at('notes.md')], touchedTimes: [null, null] }),
      // A worktree's files are its own: the same name there is a different file.
      session('claude:desktop:local_wt', { placeId: 'p-wt', roots: [WT], touchedPaths: [`${WT}/src/a.ts`], touchedTimes: [T0] }),
      // A session whose own folder holds none of its files still counts the folder that does.
      session('claude:desktop:local_away', { placeId: null, roots: ['/Users/someone'], touchedPaths: [at('src/c.ts')], touchedTimes: [T0] }),
      // The work log's wider window names files the reader's own list missed, with their times.
      session('claude:terminal:t-log', { touchedPaths: [], workLog: log({ edited: [{ path: at('notes.md'), at: T0 + 9 * MIN }, { path: at('src/gone.ts'), at: T0 }] }) }),
    ],
  });
  assert.deepEqual(out.get('claude:terminal:t-log').uncommitted, { count: 1, shared: 1, files: ['notes.md'], placeId: 'p-main' });
  assert.deepEqual(out.get('claude:terminal:t-log').sharedWith, [{ key: 'codex:desktop:x', files: 1, thisWroteLast: 0, otherWroteLast: 0 }]);
  const a = out.get('claude:desktop:local_a');
  // Three of its four files are still uncommitted, one of them inside a new, untracked folder; newest edit first.
  assert.deepEqual(a.uncommitted, { count: 3, shared: 2, files: ['src/a.ts', 'new/deep/file.ts', 'src/b.ts'], placeId: 'p-main' });
  assert.deepEqual(a.sharedWith, [
    { key: 'claude:terminal:t-c', files: 2, thisWroteLast: 1, otherWroteLast: 1 },
    { key: 'codex:desktop:x', files: 1, thisWroteLast: 0, otherWroteLast: 0 },
  ]);
  assert.deepEqual(a.sharedFiles, [
    { path: 'src/a.ts', with: ['claude:terminal:t-c'], lastBy: 'claude:desktop:local_a' },
    { path: 'src/b.ts', with: ['claude:terminal:t-c', 'codex:desktop:x'], lastBy: null },
  ]);
  assert.equal(factsText(a), '3 uncommitted files, 2 shared with 2 other sessions');
  assert.equal(factsText(out.get('claude:terminal:t-c')), '2 uncommitted files, 2 shared with 2 other sessions');
  assert.deepEqual(out.get('codex:desktop:x').uncommitted, { count: 2, shared: 2, files: ['src/b.ts', 'notes.md'], placeId: 'p-main' });
  assert.deepEqual(out.get('claude:desktop:local_wt').uncommitted, { count: 1, shared: 0, files: ['src/a.ts'], placeId: 'p-wt' });
  assert.equal(factsText(out.get('claude:desktop:local_wt')), '1 uncommitted file');
  assert.equal(out.get('claude:desktop:local_away').uncommitted.placeId, 'p-main');
});

test('facts: a worktree nested in the main folder owns its files, runs and edits', async () => {
  // The main folder's untracked '.claude/' holds the worktrees; a clean worktree's files are not the main folder's.
  const edited = [`${WT}/src/a.mjs`, `${WT}/src/b.mjs`];
  const test = (at, passed, folder) => ({ runner: 'node', passed, failed: 0, at, folder });
  const out = await createSessionFacts({ git: null }).compute({
    places: [place('p-main', HARBOR, ['.claude/', 'README.md']), place('p-wt', WT, [])],
    sessions: [
      session('claude:desktop:local_wt', { placeId: 'p-wt', roots: [WT], touchedPaths: edited, touchedTimes: [T0, T0] }),
      session('claude:desktop:local_other', { placeId: 'p-wt', roots: [WT], touchedPaths: [edited[0]], touchedTimes: [T0 + MIN] }),
      // A main-folder session: its own launch.json in '.claude/' counts; a worktree's run and edits say nothing about it.
      session('claude:desktop:local_main', { touchedPaths: [`${HARBOR}/.claude/launch.json`, `${WT}/src/a.mjs`], touchedTimes: [T0, T0 + 9 * MIN],
        workLog: log({ tests: [test(T0 + 8 * MIN, 5, WT), test(T0 + 2 * MIN, 1082, HARBOR)] }) }),
    ],
  });
  assert.equal(out.has('claude:desktop:local_wt'), false, 'a worktree that committed everything holds nothing');
  assert.equal(out.has('claude:desktop:local_other'), false, 'and shares nothing');
  const main = out.get('claude:desktop:local_main');
  assert.deepEqual(main.uncommitted, { count: 1, shared: 0, files: ['.claude/launch.json'], placeId: 'p-main' });
  assert.deepEqual(main.lastTest, { runner: 'node', passed: 1082, failed: 0, at: iso(T0 + 2 * MIN), stale: false });
});

test('facts: a commit in a folder that is not a Work in flight folder is asked about nowhere', async () => {
  const { git, calls } = fakeGit({ [HARBOR]: { remotes: true, commits: [] } });
  const out = await createSessionFacts({ git, now: () => T0 }).compute({
    places: [place('p-main', HARBOR)],
    sessions: [session('s', { workLog: log({ git: [commitAction(T0, 'abcdef1', '/Users/someone/scratch/other-repo'), quietAction(T0 + MIN, T0 + MIN + SEC, '/Users/someone/scratch/other-repo')] }) })],
  });
  assert.deepEqual(out.get('s').commits.map(item => [item.sha, item.exists, item.pushed, item.onBranch]), [['abcdef1', null, null, null]]);
  // The quiet one has no SHA to list and no folder to ask, but it was made: it counts, as not identified.
  assert.deepEqual([out.get('s').commitCount, out.get('s').unidentified], [2, 1]);
  assert.equal(factsText(out.get('s')), 'Committed abcdef1 and 1 more, 1 not identified', 'never "no longer in the repository" from asking the wrong one');
  assert.deepEqual(calls, [], 'no git call for a folder Summon does not know');
  const only = await createSessionFacts({ git, now: () => T0 }).compute({ places: [place('p-main', HARBOR)], sessions: [session('q', { workLog: log({ git: [quietAction(T0, T0 + SEC, '/Users/someone/scratch/other-repo')] }) })] });
  assert.equal(factsText(only.get('q')), '1 commit, not identified');
  assert.equal(factsText(only.get('q'), { names: false }), '1 commit, not identified');
});

test('facts: a quiet commit whose reflog could not be read counts as not identified; an empty window counts for nothing', async () => {
  const { git } = fakeGit({ [HARBOR]: { remotes: true, commits: [{ oid: oid('1'), ct: T0 / 1000 + 1, heads: ['main'], remotes: [] }] } });
  const broken = async (cwd, args, options) => { if (args.includes('--walk-reflogs')) throw new Error('fatal: bad reflog'); return git(cwd, args, options); };
  const input = { places: [place('p-main', HARBOR)], sessions: [session('s', { workLog: log({ git: [quietAction(T0, T0 + 2 * SEC), quietAction(T0 + HOUR, T0 + HOUR + SEC)] }) })] };
  const unreadable = (await createSessionFacts({ git: broken, now: () => T0 }).compute(input)).get('s');
  assert.deepEqual([unreadable.commits.length, unreadable.commitCount, unreadable.unidentified], [0, 2, 2]);
  assert.equal(factsText(unreadable), '2 commits, not identified');
  // Read: the first window holds one commit, the second none, so the session made one commit there.
  const read = (await createSessionFacts({ git, now: () => T0 }).compute(input)).get('s');
  assert.deepEqual([read.commits.map(item => item.oid), read.commitCount, read.unidentified], [[oid('1')], 1, 0]);
  assert.equal(factsText(read), 'Probably committed 1111111, not pushed');
});

test('facts: a quiet commit that was reset away is still found, not pushed and on no branch', async () => {
  const { git } = fakeGit({ [HARBOR]: { remotes: true, commits: [
    { oid: oid('7'), ct: T0 / 1000 + 1, heads: [], remotes: [], reflog: true },
    // Another worktree's branch commit in the same seconds, which HEAD never pointed at.
    { oid: oid('8'), ct: T0 / 1000 + 1, heads: ['other'], remotes: [], reflog: false },
  ] } });
  const out = await createSessionFacts({ git, now: () => T0 }).compute({ places: [place('p-main', HARBOR)], sessions: [session('s', { workLog: log({ git: [quietAction(T0, T0 + 2 * SEC)] }) })] });
  assert.deepEqual(out.get('s').commits.map(item => [item.oid, item.inferred, item.pushed, item.onBranch]), [[oid('7'), true, false, false]]);
  assert.equal(factsText(out.get('s')), 'Probably committed 7777777, not pushed, on no branch');
});

test('facts: a file committed after the session last edited it is no longer held by that session', async () => {
  const { git, calls } = fakeGit({ [HARBOR]: { remotes: true, commits: [
    { oid: oid('a'), ct: T0 / 1000 + 300, heads: ['main'], remotes: ['origin/main'], files: ['docs/decisions.md', 'src/b.ts'] },
  ] } });
  const at = rel => `${HARBOR}/${rel}`;
  const out = await createSessionFacts({ git, now: () => T0 + 10 * MIN }).compute({
    places: [place('p-main', HARBOR, ['docs/decisions.md', 'src/b.ts', 'src/c.ts', 'src/d.ts'])],
    sessions: [
      // decisions.md: edited, then committed by someone at +5 min, then changed again by another session.
      session('old', { touchedPaths: [at('docs/decisions.md'), at('src/b.ts'), at('src/c.ts'), at('src/d.ts')], touchedTimes: [T0, T0 + 6 * MIN, null, T0] }),
      session('new', { touchedPaths: [at('docs/decisions.md')], touchedTimes: [T0 + 8 * MIN] }),
    ],
  });
  // decisions.md was committed after 'old' last wrote it; b.ts was edited again after the commit; c.ts has no edit
  // time, so nothing says it was committed since; d.ts was not touched by the commit.
  assert.deepEqual(out.get('old').uncommitted, { count: 3, shared: 0, files: ['src/b.ts', 'src/d.ts', 'src/c.ts'], placeId: 'p-main' });
  assert.deepEqual(out.get('new').uncommitted, { count: 1, shared: 0, files: ['docs/decisions.md'], placeId: 'p-main' });
  assert.equal(calls.filter(call => call[1] === 'log').length, 1, 'one log per folder');
  assert.ok(calls.filter(call => call[1] === 'log').every(call => call.includes('HEAD') && !call.some(arg => arg.includes('fetch'))));
});

test('facts: a quiet window that matched keeps its answer; an empty one is asked again after ten minutes', async () => {
  let clock = T0;
  const { git, calls } = fakeGit({ [HARBOR]: { remotes: true, commits: [{ oid: oid('1'), ct: T0 / 1000 + 1, heads: ['main'], remotes: ['origin/main'] }] } });
  const facts = createSessionFacts({ git, now: () => clock });
  const input = { places: [place('p-main', HARBOR)], sessions: [session('s', { workLog: log({ git: [quietAction(T0, T0 + 2 * SEC), quietAction(T0 + HOUR, T0 + HOUR + SEC)] }) })] };
  await facts.compute(input);
  const windows = () => calls.filter(call => call[1] === 'log').length;
  assert.equal(windows(), 2);
  clock += FACT_LIMITS.recheckMs + 1;
  await facts.compute(input);
  assert.equal(windows(), 2, 'neither window is asked again after a minute');
  clock += FACT_LIMITS.windowRecheckMs;
  await facts.compute(input);
  assert.equal(windows(), 3, 'only the empty one is asked again');
});

test('facts: the latest test counts in the folder, and whether its own edits came after them', async () => {
  const test = (at, passed, failed, folder = HARBOR) => ({ runner: 'node', passed, failed, at, folder });
  const out = await createSessionFacts({ git: null }).compute({
    places: [place('p-main', HARBOR, ['src/a.ts', 'src/b.ts', 'src/c.ts'])],
    sessions: [
      session('stale', { touchedPaths: [`${HARBOR}/src/a.ts`], touchedTimes: [T0 + 10 * MIN], workLog: log({ tests: [test(T0 + 5 * MIN, 1082, 0), test(T0, 1000, 2)] }) }),
      session('fresh', { touchedPaths: [`${HARBOR}/src/b.ts`], touchedTimes: [T0], workLog: log({ tests: [test(T0 + 5 * MIN, 40, 2)] }) }),
      session('unknown', { touchedPaths: [`${HARBOR}/src/c.ts`], touchedTimes: [null], workLog: log({ tests: [test(T0, 3, 0)] }) }),
      // A run in another repository says nothing about this one.
      session('elsewhere', { workLog: log({ tests: [test(T0 + 9 * MIN, 9, 0, '/Users/someone/Projects/Tide'), test(T0, 5, 0, `${HARBOR}/packages/core`)] }) }),
    ],
  });
  assert.deepEqual(out.get('stale').lastTest, { runner: 'node', passed: 1082, failed: 0, at: iso(T0 + 5 * MIN), stale: true });
  assert.equal(factsText(out.get('stale')), '1 uncommitted file · tests 1082 of 1082, before its last edits');
  assert.equal(out.get('fresh').lastTest.stale, false);
  assert.equal(factsText(out.get('fresh')), '1 uncommitted file · tests 40 of 42');
  assert.equal(out.get('unknown').lastTest.stale, null);
  assert.deepEqual([out.get('elsewhere').lastTest.passed, out.get('elsewhere').lastTest.stale], [5, null]);
  assert.equal(factsText(out.get('elsewhere')), 'Tests 5 of 5');
  assert.equal(out.get('stale').largestTest, null, 'the newest run is also the largest');
});

test('facts: a smaller newest run keeps the largest run in the folder beside it', async () => {
  const test = (at, passed, failed, folder = HARBOR) => ({ runner: 'node', passed, failed, at, folder });
  const out = await createSessionFacts({ git: null }).compute({
    places: [place('p-main', HARBOR, ['src/a.ts'])],
    sessions: [
      // One test file after the full suite, the full suite once more before that, and a larger run in another repository.
      session('subset', { touchedPaths: [`${HARBOR}/src/a.ts`], touchedTimes: [T0 + 3 * MIN], workLog: log({ tests: [test(T0 + 4 * MIN, 10, 0), test(T0 + 2 * MIN, 1117, 0), test(T0 + MIN, 1116, 1), test(T0, 1000, 0), test(T0 + 5 * MIN, 5000, 0, '/Users/someone/Projects/Tide')] }) }),
      session('unknown-newest', { workLog: log({ tests: [test(T0 + MIN, null, null), test(T0, 1117, 0)] }) }),
    ],
  });
  const subset = out.get('subset');
  assert.deepEqual(subset.lastTest, { runner: 'node', passed: 10, failed: 0, at: iso(T0 + 4 * MIN), stale: false });
  assert.deepEqual(subset.largestTest, { runner: 'node', passed: 1117, failed: 0, at: iso(T0 + 2 * MIN), stale: true }, 'the newest of the largest, stale since the edit came after it');
  assert.equal(factsText(subset), '1 uncommitted file · tests 10 of 10; largest run 1117 of 1117, before its last edits');
  assert.deepEqual(factsForAgent(subset).largestTest, subset.largestTest);
  // A newest run with unknown counts may have been the whole suite: nothing is set beside it.
  assert.equal(out.get('unknown-newest').largestTest, null);
  assert.equal(factsText(out.get('unknown-newest')), 'Tests failing');
});

test('facts: an open question counts only while the person has not written since', async () => {
  const out = await createSessionFacts({ git: null }).compute({
    places: [],
    sessions: [
      session('asked', { placeId: null, workLog: log({ asked: { at: T0 }, lastUserAt: T0 - MIN }) }),
      session('answered', { placeId: null, workLog: log({ asked: { at: T0 }, lastUserAt: T0 + MIN }) }),
      session('quiet', { placeId: null, workLog: log({ lastUserAt: T0 }) }),
    ],
  });
  assert.deepEqual(out.get('asked').asked, { at: iso(T0) });
  assert.equal(factsText(out.get('asked')), 'Asked you a question');
  assert.equal(out.has('answered'), false);
  assert.equal(out.has('quiet'), false, 'nothing known is no facts at all');
});

test('facts: the plain line reads like the spec, and a private folder gives counts only', () => {
  const shared = Array.from({ length: 9 }, (_, i) => ({ path: `src/s${i}.ts`, with: ['codex:desktop:x'], lastBy: null }));
  const facts = {
    commits: [{ sha: '1a2b3c4', oid: oid('1'), branch: 'main', at: iso(T0), inferred: false, exists: true, pushed: true, onBranch: null }], commitCount: 1,
    uncommitted: { count: 12, shared: 9, files: ['.env', 'pilot/list.md', 'src/s0.ts', 'src/free.ts', 'customers/acme.csv', ...shared.slice(1).map(item => item.path), 'src/last.ts'], placeId: 'p-main' },
    sharedWith: [{ key: 'codex:desktop:x', files: 9, thisWroteLast: 0, otherWroteLast: 0 }], sharedFiles: shared,
    lastTest: { runner: 'node', passed: 1082, failed: 0, at: iso(T0), stale: true }, asked: { at: iso(T0) },
  };
  assert.equal(factsText(facts), 'Committed 1a2b3c4, pushed · 12 uncommitted files, 9 shared with another session · tests 1082 of 1082, before its last edits · asked you a question');
  const keepName = rel => !['.env', 'pilot/list.md', 'customers/acme.csv'].includes(rel);
  const agent = factsForAgent(facts, { keepName, titleOf: key => (key === 'codex:desktop:x' ? 'Pilot import' : null) });
  assert.deepEqual(agent.commits, [{ sha: '1a2b3c4', branch: 'main', pushed: true, onBranch: null, exists: true, inferred: false, at: iso(T0) }]);
  assert.equal('oid' in agent.commits[0], false, 'agents get short SHAs only');
  // At most five names, shared ones first, and only names that pass the filters.
  assert.deepEqual(agent.uncommitted, { count: 12, shared: 9, files: ['src/s0.ts', 'src/s1.ts', 'src/s2.ts', 'src/s3.ts', 'src/s4.ts'] });
  assert.deepEqual(agent.sharedWith, [{ key: 'codex:desktop:x', title: 'Pilot import', files: 9, thisWroteLast: 0, otherWroteLast: 0 }]);
  assert.equal('sharedFiles' in agent, false);
  const hidden = factsForAgent(facts, { hidden: true, keepName: () => true, titleOf: () => 'Pilot import' });
  assert.deepEqual(hidden, { commits: [], commitCount: 1, unidentified: 0, uncommitted: { count: 12, shared: 9, files: [] }, sharedWith: [], lastTest: facts.lastTest, largestTest: null, asked: facts.asked });
  assert.equal(factsText(facts, { names: false }), '1 commit, pushed · 12 uncommitted files, 9 shared with another session · tests 1082 of 1082, before its last edits · asked you a question');
  assert.equal(factsText({ ...facts, commits: [], commitCount: 0, uncommitted: null, asked: null, lastTest: { runner: 'node', passed: null, failed: null, at: iso(T0), stale: null } }), 'Tests failing');
  assert.equal(factsText(null), '');
  assert.equal(factsText({ commits: [], commitCount: 0, uncommitted: null, sharedWith: [], lastTest: null, asked: null }), '');
});

test('facts: git answers are cached, "pushed" for good, and the per-read budget leaves the rest unknown', async () => {
  let clock = T0;
  const { git, calls } = fakeGit({ [HARBOR]: { remotes: true, commits: [
    { oid: oid('a'), ct: T0 / 1000, heads: ['main'], remotes: ['origin/main'] },
    { oid: oid('b'), ct: T0 / 1000, heads: ['main'], remotes: [] },
  ] } });
  const facts = createSessionFacts({ git, now: () => clock });
  const input = { places: [place('p-main', HARBOR)], sessions: [session('s', { workLog: log({ git: [commitAction(T0, 'aaaaaaa'), commitAction(T0 + SEC, 'bbbbbbb')] }) })] };
  await facts.compute(input);
  const cold = calls.length;
  assert.ok(cold >= 4, String(cold));
  await facts.compute(input);
  assert.equal(calls.length, cold, 'inside a minute nothing is asked again');
  clock += FACT_LIMITS.recheckMs + 1;
  calls.length = 0;
  const later = await facts.compute(input);
  // The pushed commit is not asked about again; the unpushed one, its existence and the remote check are.
  assert.equal(calls.filter(call => call.includes(oid('a'))).length, 0);
  assert.equal(calls.filter(call => call.includes(oid('b'))).length, 1);
  assert.deepEqual(later.get('s').commits.map(item => item.pushed), [false, true]);

  // Two calls per compute: the existence check and one more; the rest stays unknown without an error.
  const tight = createSessionFacts({ git: fakeGit({ [HARBOR]: { remotes: true, commits: [{ oid: oid('a'), ct: T0 / 1000, heads: ['main'], remotes: ['origin/main'] }, { oid: oid('b'), ct: T0 / 1000, heads: ['main'], remotes: [] }] } }).git, now: () => T0, limits: { gitCalls: 2 } });
  const partial = (await tight.compute(input)).get('s');
  assert.deepEqual(partial.commits.map(item => item.exists), [true, true]);
  assert.ok(partial.commits.some(item => item.pushed === null));
  // With no git at all, a reported commit is still listed, with nothing claimed about it.
  const none = (await createSessionFacts({ git: null }).compute(input)).get('s');
  assert.deepEqual(none.commits.map(item => [item.sha, item.exists, item.pushed]), [['bbbbbbb', null, null], ['aaaaaaa', null, null]]);
  assert.equal(factsText(none), 'Committed bbbbbbb and 1 more');
});

test('facts: a question git failed to answer waits a minute, and a folder that timed out is left alone for that minute', async () => {
  let clock = T0;
  const { git: real } = fakeGit({ [HARBOR]: { remotes: true, commits: [{ oid: oid('a'), ct: T0 / 1000, heads: ['main'], remotes: [] }] }, '/Users/someone/Projects/Tide': { remotes: true, commits: [] } });
  const calls = [];
  let failing = true;
  const git = async (cwd, args, options) => {
    calls.push([cwd, args[0]]);
    // Tide's git hangs until the runner's timeout; Harbor's existence check fails at once.
    if (cwd === '/Users/someone/Projects/Tide') { clock += 3000; throw new Error('The operation timed out. Please try again.'); }
    if (failing && args[0] === 'cat-file') throw new Error('fatal: not a git repository');
    return real(cwd, args, options);
  };
  const facts = createSessionFacts({ git, now: () => clock });
  const input = { places: [place('p-main', HARBOR), place('p-tide', '/Users/someone/Projects/Tide')], sessions: [
    session('harbor', { workLog: log({ git: [commitAction(T0, 'aaaaaaa')] }) }),
    session('tide', { placeId: 'p-tide', workLog: log({ git: [commitAction(T0, 'bbbbbbb', '/Users/someone/Projects/Tide')] }) }),
  ] };
  const first = await facts.compute(input);
  assert.equal(first.get('harbor').commits[0].exists, null);
  const asked = () => calls.filter(([cwd]) => cwd === '/Users/someone/Projects/Tide').length;
  const existence = () => calls.filter(([cwd, command]) => cwd === HARBOR && command === 'cat-file').length;
  assert.deepEqual([asked(), existence()], [1, 1]);
  failing = false;
  clock += 10 * SEC;
  const second = await facts.compute(input);
  assert.deepEqual([asked(), existence()], [1, 1], 'neither is asked again inside the minute');
  assert.deepEqual([second.get('harbor').commits[0].exists, second.get('tide').commits[0].exists], [null, null]);
  clock += FACT_LIMITS.recheckMs;
  const third = await facts.compute(input);
  assert.equal(existence(), 2, 'after a minute the question is asked again');
  assert.equal(third.get('harbor').commits[0].exists, true);
  assert.equal(asked(), 2, 'and so is the slow folder');
  // A refusal from the compute's own budget is not an answer: nothing is kept for it.
  const tight = createSessionFacts({ git: real, now: () => T0, limits: { gitCalls: 0 } });
  await tight.compute(input);
  const roomy = createSessionFacts({ git: real, now: () => T0 });
  assert.equal((await roomy.compute(input)).get('harbor').commits[0].exists, true);
});

test('agent sessions: facts reach the window in full and agents in short, with private folders masked', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'summon-facts-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'Projects', 'Harbor');
  await fs.mkdir(path.join(repo, 'private', 'tool'), { recursive: true });
  const at = rel => path.join(repo, rel);
  const now = T0 + 10 * MIN;
  const base = { surface: 'desktop', title: null, worktreePath: null, branch: 'main', startedAt: T0, updatedAt: now - MIN, activity: 'working', activitySince: now - MIN, reason: null, unread: false, archived: false, pinned: false, live: true, confidence: 'reported', helpers: 0, model: null };
  const claude = [
    { ...base, app: 'claude', id: 'local_one', title: 'Fix the importer', cwd: repo,
      touchedPaths: [at('src/a.ts'), at('pilot/list.md'), at('customers/acme.csv'), at('notes/renamed.md'), at('new/readme.md')], touchedTimes: [now - 2 * MIN, now - 3 * MIN, now - 4 * MIN, now - 5 * MIN, now - 6 * MIN],
      // A reader that let a sealed folder's commit and test run through: the aggregator drops them whole.
      workLog: { git: [commitAction(now - 5 * MIN, 'aaaaaaa', repo), commitAction(now - 3 * MIN, 'abcdef1', '/Users/someone/sealed-client/repo', 'sealed-branch-name')],
        tests: [{ runner: 'node', passed: 99, failed: 0, at: now - 2 * MIN, folder: '/Users/someone/sealed-client/repo' }, { runner: 'node', passed: 10, failed: 0, at: now - 6 * MIN, folder: repo }], asked: { at: now - MIN }, lastUserAt: now - 8 * MIN } },
    { ...base, app: 'claude', id: 'local_private', title: 'SECRET-TITLE', cwd: path.join(repo, 'private', 'tool'), touchedPaths: [at('src/a.ts')], touchedTimes: [now - MIN],
      workLog: { git: [commitAction(now - 4 * MIN, 'aaaaaaa', repo)], tests: [], asked: null, lastUserAt: null } },
    // Sanitizing drops a malformed log field by field rather than trusting the reader.
    { ...base, app: 'claude', id: 'local_bad', cwd: repo, workLog: { git: [{ kind: 'commit', at: now, sha: 'SECRET-NOT-A-SHA' }, { kind: 'rm -rf', at: now }], tests: [{ runner: 'SECRET', passed: 1, failed: 0, at: now }], asked: 'yes', lastUserAt: 'soon' },
      // The reader has not read this transcript to its end yet, so the empty line is not an answer.
      workLogPending: true },
  ];
  const codex = [{ ...base, app: 'codex', id: '0199aaaa-aaaa-4bbb-8ccc-000000000001', title: 'Pilot import', cwd: repo, touchedPaths: [at('src/a.ts')] }];
  const answer = (app, sessions) => ({ sessions: structuredClone(sessions), sources: [{ app, label: app, available: true, running: true, detail: null }], warnings: [] });
  const { git } = fakeGit({ [repo]: { remotes: true, commits: [{ oid: oid('a'), ct: T0 / 1000, heads: ['main'], remotes: [] }] } });
  const svc = await createAgentSessions({
    dataDir: path.join(root, 'Data'), homeDir: root, now: () => now, gitCall: git,
    run: async () => { throw new Error('Tests never run commands.'); },
    readers: { claude: { read: async () => answer('claude', claude) }, codex: { read: async () => answer('codex', codex) } },
    listProcesses: async () => new Map([[1, { pid: 1, ppid: 0, startedAt: T0, lstart: 'x', comm: '/sbin/launchd' }]]),
    snapshots: { query: async () => { throw new Error('no'); }, close() {} }, readLocalStorageKeys: async () => new Map(),
    getPlaces: async () => [{ id: 'place-main', repoId: 'harbor', repoName: 'Harbor', path: repo, kind: 'main', label: 'Main folder', missing: false, workstreams: [],
      // notes/renamed.md was renamed out of a private folder and new/ is an untracked folder of mail files: Work in flight
      // withholds both from agents with what only its scan knows, and so must the facts.
      uncommitted: ['src/a.ts', 'pilot/list.md', 'customers/acme.csv', 'README.md', 'notes/renamed.md', 'new/'], withheld: ['notes/renamed.md', 'new/'] }],
    getProjects: async () => [{ id: 'harbor', name: 'Harbor', path: repo }],
    privatePathsFor: value => (value === repo ? ['pilot/list.md'] : []),
  });
  t.after(() => svc.close());
  const find = (view, key) => view.groups.flatMap(group => group.sessions).find(item => item.key === key);

  const local = await svc.read({ maxAgeMs: 0 });
  const one = find(local, 'claude:desktop:local_one');
  assert.equal(one.facts.commits[0].oid, oid('a'), 'the window gets the full id');
  assert.deepEqual(one.facts.uncommitted, { count: 5, shared: 1, files: ['src/a.ts', 'pilot/list.md', 'customers/acme.csv', 'notes/renamed.md', 'new/readme.md'], placeId: 'place-main' });
  assert.deepEqual(one.facts.commits.map(item => item.sha), ['aaaaaaa'], "a sealed folder's commit is dropped, never credited to this repository");
  assert.deepEqual(one.facts.sharedWith.map(item => [item.key, item.title]).sort(), [['claude:desktop:local_private', 'SECRET-TITLE'], ['codex:desktop:0199aaaa-aaaa-4bbb-8ccc-000000000001', 'Pilot import']]);
  assert.equal(one.factsText, 'Committed aaaaaaa, not pushed · 5 uncommitted files, 1 shared with 2 other sessions · tests 10 of 10, before its last edits · asked you a question');
  assert.deepEqual(find(local, 'claude:desktop:local_bad').facts, null, 'a malformed work log says nothing');
  assert.equal(find(local, 'claude:desktop:local_bad').factsText, '');
  assert.equal(find(local, 'claude:desktop:local_bad').factsPending, true);
  assert.equal('factsPending' in one, false);
  assert.ok(local.warnings.includes('Session facts are still being read for 1 session.'), JSON.stringify(local.warnings));

  const agent = await svc.read({ maxAgeMs: 0, forAgent: true });
  const shown = find(agent, 'claude:desktop:local_one');
  assert.deepEqual(shown.facts.commits, [{ sha: 'aaaaaaa', branch: 'main', pushed: false, onBranch: true, exists: true, inferred: false, at: iso(now - 5 * MIN) }]);
  // A private folder of the repository and a built-in private name never travel; counts still do.
  assert.deepEqual(shown.facts.uncommitted, { count: 5, shared: 1, files: ['src/a.ts'] });
  assert.deepEqual(shown.facts.sharedWith.map(item => item.title).sort(), ['Pilot import', 'Title hidden (private folder)']);
  assert.equal(shown.factsText, one.factsText);
  assert.equal(find(agent, 'claude:desktop:local_bad').factsPending, true, 'agents are told too');
  const hidden = find(agent, 'claude:desktop:local_private');
  assert.deepEqual(hidden.facts, { commits: [], commitCount: 1, unidentified: 0, uncommitted: { count: 1, shared: 1, files: [] }, sharedWith: [], lastTest: null, largestTest: null, asked: null });
  assert.equal(hidden.factsText, '1 commit, not pushed · 1 uncommitted file, 1 shared with 2 other sessions');
  assert.equal(find(agent, 'codex:desktop:0199aaaa-aaaa-4bbb-8ccc-000000000001').factsText, '1 uncommitted file, 1 shared with 2 other sessions');
  assert.ok(!JSON.stringify(agent).includes('SECRET'), 'no private title, bad field or full path reaches an agent');
  for (const view of [local, agent]) assert.ok(!/abcdef1|sealed-branch-name/.test(JSON.stringify(view)), 'nothing of the sealed commit reaches either view');
  assert.ok(!JSON.stringify(agent.groups.map(group => group.sessions.map(item => item.facts))).includes(root), 'facts carry no full paths');
});

test('Work in flight tells Agent sessions which names it withholds, from what only its scan knows', async t => {
  const { createWorkInFlight } = await import('../src/core/work-in-flight.mjs');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'summon-withheld-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'Projects', 'Harbor');
  await fs.mkdir(path.join(repo, '.git'), { recursive: true });
  const base = { branch: 'main', detached: false, head: 'aaaa1111', upstream: null, ahead: 0, behind: 0, aheadOfBase: 0, behindBase: 0, filesTruncated: false, counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, added: 0, removed: 0, lastChangedAt: null, fingerprint: 'fp', error: null };
  const file = (filePath, extra = {}) => ({ path: filePath, status: 'modified', staged: false, added: 1, removed: 0, binary: false, isDir: false, ...extra });
  const files = [
    file('src/a.ts'),
    // Renamed out of a private folder: the bare new name looks harmless, but the contents came from 'pilot/'.
    file('notes.md', { status: 'renamed', origPath: 'pilot/notes.md' }),
    // A new folder whose files are mail: private for what is inside it, though its name is not.
    { path: 'new/', status: 'untracked', staged: false, added: 0, removed: 0, binary: false, isDir: true, extensions: { '.eml': 3, '.md': 1 } },
    file('.env'),
  ];
  const wif = await createWorkInFlight({
    dataDir: path.join(root, 'Data'), homeDir: root, getProjects: async () => [{ id: 'harbor', name: 'Harbor', path: repo }],
    run: async () => { throw new Error('Tests never run git.'); }, git: '/usr/bin/git', env: { PATH: '/usr/bin' },
    scan: async repoPath => ({ path: repoPath, defaultBranch: 'main', hasRemote: false, branches: [], stashes: [], error: null, places: [{ ...base, path: repoPath, kind: 'main', isMain: true, missing: false, files }] }),
    group: async () => { throw new Error('Tests never call a model.'); },
  });
  t.after(() => wif.close());
  await wif.updateSettings({ privatePaths: { [repo]: ['pilot/'] } });
  await wif.read({ includeFiles: false });
  const [main] = wif.places();
  assert.deepEqual(main.uncommitted, ['src/a.ts', 'notes.md', 'new/', '.env']);
  assert.deepEqual(main.withheld.sort(), ['.env', 'new/', 'notes.md'].sort());
  // And the agent view of Work in flight withholds the same names.
  const shown = JSON.stringify(await wif.read({ maxAgeMs: 0, includeFiles: true, maskPrivate: true, projectId: 'harbor' }));
  assert.ok(shown.includes('"src/a.ts"'));
  for (const name of main.withheld) assert.equal(shown.includes(`"${name}"`), false, name);
});

test('agent sessions: a slow git never holds up a read; the facts of the last join that finished stand in', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'summon-facts-slow-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'Projects', 'Harbor');
  await fs.mkdir(repo, { recursive: true });
  const now = T0 + 10 * MIN;
  const base = { app: 'claude', surface: 'desktop', id: 'local_one', title: 'Fix the importer', cwd: repo, worktreePath: null, branch: 'main', startedAt: T0, updatedAt: now - MIN, activity: 'working', activitySince: now - MIN, reason: null, unread: false, archived: false, pinned: false, live: true, confidence: 'reported', helpers: 0, model: null };
  let sessions = [{ ...base, workLog: { git: [commitAction(now - 5 * MIN, 'aaaaaaa', repo)], tests: [], asked: null, lastUserAt: null } }];
  const { git: real } = fakeGit({ [repo]: { remotes: true, commits: [{ oid: oid('a'), ct: T0 / 1000, heads: ['main'], remotes: ['origin/main'] }, { oid: oid('b'), ct: T0 / 1000 + 60, heads: ['main'], remotes: [] }] } });
  // Once held, every git call waits until the test lets it go, the way a hung repository would.
  let hold = null;
  const git = async (...args) => { if (hold) await hold.promise; return real(...args); };
  const svc = await createAgentSessions({
    dataDir: path.join(root, 'Data'), homeDir: root, now: () => now, gitCall: git, limits: { factsMs: 100, factsMinMs: 20 },
    run: async () => { throw new Error('Tests never run commands.'); },
    readers: { claude: { read: async () => ({ sessions: structuredClone(sessions), sources: [{ app: 'claude', label: 'claude', available: true, running: true, detail: null }], warnings: [] }) } },
    listProcesses: async () => new Map(), snapshots: { query: async () => { throw new Error('no'); }, close() {} }, readLocalStorageKeys: async () => new Map(),
    getPlaces: async () => [{ id: 'place-main', repoId: 'harbor', repoName: 'Harbor', path: repo, kind: 'main', label: 'Main folder', missing: false, workstreams: [], uncommitted: [] }],
    getProjects: async () => [{ id: 'harbor', name: 'Harbor', path: repo }],
  });
  t.after(async () => { hold?.resolve(); await svc.close(); });
  const text = view => view.groups.flatMap(group => group.sessions).find(item => item.key === 'claude:desktop:local_one')?.factsText;
  assert.equal(text(await svc.read({ maxAgeMs: 0 })), 'Committed aaaaaaa, pushed');
  // A new commit needs git, and git now hangs: the read answers within its share of the budget, with the last facts.
  hold = Promise.withResolvers();
  sessions = [{ ...base, workLog: { git: [commitAction(now - MIN, 'bbbbbbb', repo), commitAction(now - 5 * MIN, 'aaaaaaa', repo)], tests: [], asked: null, lastUserAt: null } }];
  const started = performance.now();
  assert.equal(text(await svc.read({ maxAgeMs: 0 })), 'Committed aaaaaaa, pushed');
  assert.ok(performance.now() - started < 2000, `${Math.round(performance.now() - started)} ms`);
  // A read while that join is still running starts no second one.
  assert.equal(text(await svc.read({ maxAgeMs: 0 })), 'Committed aaaaaaa, pushed');
  hold.resolve();
  hold = null;
  let latest = '';
  for (let i = 0; i < 20 && latest !== 'Committed bbbbbbb and 1 more, 1 not pushed'; i++) latest = text(await svc.read({ maxAgeMs: 0 }));
  assert.equal(latest, 'Committed bbbbbbb and 1 more, 1 not pushed', 'the join that finished in the background is used from then on');
});
