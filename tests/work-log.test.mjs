import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { asksQuestion, classifyCommand, emptyWorkState, mergeWorkLogs, parseWorkText, readWorkLog, testRun, testSummary, workLogOf, WORK_LIMITS } from '../src/core/sessions/work-log.mjs';
import { createClaudeReader } from '../src/core/sessions/claude.mjs';
import { setSealedSegments } from '../src/core/workstreams.mjs';

// The sealed-folder guard is empty until configured; these fixtures seal any path segment containing 'sealed-client'.
setSealedSegments(['sealed-client']);

// Synthetic transcripts only: neutral names, /Users/someone paths, and SECRET-* markers for text that must never be kept.
const HOME = '/Users/someone';
const HARBOR = '/Users/someone/Projects/Harbor';
const T0 = Date.parse('2026-09-20T10:00:00.000Z');
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const iso = ms => new Date(ms).toISOString();
let seq = 0;
const nextId = () => `toolu_${String(++seq).padStart(6, '0')}`;

const bash = (at, command, { id = nextId(), cwd = HARBOR, sidechain = false, session = 's' } = {}) => ({
  id,
  row: { parentUuid: null, isSidechain: sidechain, userType: 'external', cwd, sessionId: session, type: 'assistant', timestamp: iso(at),
    message: { id: `msg_${id}`, model: 'claude-opus-5', role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command, description: 'SECRET-DESCRIPTION' } }], stop_reason: 'tool_use', stop_sequence: null } },
});
const result = (at, id, { stdout = '', stderr = '', git = null, cwd = HARBOR, sidechain = false, extra = {}, error = false, session = 's' } = {}) => ({
  parentUuid: null, isSidechain: sidechain, userType: 'external', cwd, sessionId: session, type: 'user', timestamp: iso(at),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: stdout, is_error: error }] },
  toolUseResult: { stdout, stderr, interrupted: false, isImage: false, noOutputExpected: false, ...(git ? { gitOperation: git } : {}) }, ...extra,
});
const say = (at, text, { id = `msg_say${++seq}`, stop = 'end_turn', sidechain = false, blocks = null, session = 's' } = {}) => ({
  parentUuid: null, isSidechain: sidechain, cwd: HARBOR, sessionId: session, type: 'assistant', timestamp: iso(at),
  message: { id, model: 'claude-opus-5', role: 'assistant', content: blocks ?? [{ type: 'text', text }], stop_reason: stop, stop_sequence: null },
});
const person = (at, content, extra = {}) => ({ parentUuid: null, isSidechain: false, cwd: HARBOR, sessionId: 's', type: 'user', timestamp: iso(at), message: { role: 'user', content }, ...extra });
// An edit tool call and its result: only input.file_path is ever read, and only once the result says it worked.
const edit = (at, file, { tool = 'Edit', id = nextId(), error = false, session = 's', sidechain = false } = {}) => [
  { parentUuid: null, isSidechain: sidechain, cwd: HARBOR, sessionId: session, type: 'assistant', timestamp: iso(at),
    message: { id: `msg_${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name: tool, input: { [tool === 'NotebookEdit' ? 'notebook_path' : 'file_path']: file, old_string: 'SECRET-OLD', new_string: 'SECRET-NEW', content: 'SECRET-CONTENT' } }], stop_reason: 'tool_use' } },
  { parentUuid: null, isSidechain: sidechain, cwd: HARBOR, sessionId: session, type: 'user', timestamp: iso(at + 200),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: error ? 'SECRET-ERROR' : 'SECRET-DONE', is_error: error }] }, toolUseResult: error ? 'Error: SECRET' : { filePath: file } },
];
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const parse = (rows, state = emptyWorkState(), limits = {}) => parseWorkText(jsonl(rows), state, { homeDir: HOME, limits });
const noSecrets = (value, label) => assert.ok(!JSON.stringify(value).includes('SECRET'), `${label}: ${JSON.stringify(value).slice(0, 400)}`);

test('work log: git annotations are kept with the folder each call ran in', () => {
  const commit = bash(T0, 'cd "/Users/someone/Projects/Harbor Two" && git add -A && git commit -m "SECRET-COMMIT-MESSAGE"');
  const push = bash(T0 + 10 * SEC, 'cd /Users/someone/Projects/Harbor\\ Two/sub && git push origin feature/x');
  const rebase = bash(T0 + 20 * SEC, "git -C '/Users/someone/Projects/Other Repo' rebase main");
  const pr = bash(T0 + 30 * SEC, 'gh pr close 12 --comment "SECRET-PR-COMMENT"');
  const state = parse([
    commit.row, result(T0 + 2 * SEC, commit.id, { stdout: '[main 1a2b3c4] SECRET-COMMIT-MESSAGE', git: { commit: { sha: '1A2B3C4', kind: 'committed', branch: 'main' }, push: { branch: 'main' } } }),
    push.row, result(T0 + 12 * SEC, push.id, { stdout: 'SECRET-PUSH-OUTPUT', git: { push: { branch: 'feature/x' } } }),
    rebase.row, result(T0 + 22 * SEC, rebase.id, { git: { branch: { ref: 'feature/x', action: 'rebased' } } }),
    pr.row, result(T0 + 32 * SEC, pr.id, { git: { pr: { number: 12, action: 'closed' } } }),
    // An annotation whose call came before this pass: the row's own working folder stands in.
    result(T0 + 40 * SEC, 'toolu_elsewhere', { cwd: '/Users/someone/Projects/Harbor/sub', git: { commit: { sha: 'aaaaaaa', kind: 'cherry-picked' } } }),
  ]);
  const base = { number: null, quiet: false, from: null };
  assert.deepEqual(workLogOf(state).git, [
    { ...base, kind: 'commit', at: T0 + 40 * SEC, folder: '/Users/someone/Projects/Harbor/sub', sha: 'aaaaaaa', branch: null, action: 'cherry-picked' },
    { ...base, kind: 'pr', at: T0 + 32 * SEC, folder: HARBOR, sha: null, branch: null, action: 'closed', number: 12 },
    { ...base, kind: 'branch', at: T0 + 22 * SEC, folder: '/Users/someone/Projects/Other Repo', sha: null, branch: 'feature/x', action: 'rebased' },
    { ...base, kind: 'push', at: T0 + 12 * SEC, folder: '/Users/someone/Projects/Harbor Two/sub', sha: null, branch: 'feature/x', action: null },
    // One annotation, two facts: the push came with the commit, and the SHA is kept in lower case.
    { ...base, kind: 'push', at: T0 + 2 * SEC, folder: '/Users/someone/Projects/Harbor Two', sha: null, branch: 'main', action: null },
    { ...base, kind: 'commit', at: T0 + 2 * SEC, folder: '/Users/someone/Projects/Harbor Two', sha: '1a2b3c4', branch: 'main', action: 'committed' },
  ]);
  assert.equal(state.pending.size, 0, 'every call got its result');
  noSecrets(workLogOf(state), 'work log');
  noSecrets([...state.pending.values()], 'pending calls');
});

test('work log: where a command ran, from cd, git -C or the working folder', () => {
  const at = (command, cwd = HARBOR) => classifyCommand(command, cwd, { homeDir: HOME })?.folder ?? null;
  assert.equal(at('git commit -m x'), HARBOR);
  assert.equal(at('cd "/Users/someone/Projects/Harbor Two" && git commit -m x'), '/Users/someone/Projects/Harbor Two');
  assert.equal(at("cd '/Users/someone/Projects/Harbor Two'; npm test"), '/Users/someone/Projects/Harbor Two');
  assert.equal(at('cd /Users/someone/Projects/Harbor\\ Two && git commit -q -m x'), '/Users/someone/Projects/Harbor Two');
  assert.equal(at('cd sub && npm test'), `${HARBOR}/sub`, 'a relative folder is taken from where the shell was');
  assert.equal(at('cd ~/Projects/Tide && git commit -m x'), '/Users/someone/Projects/Tide');
  assert.equal(at('git -C "/Users/someone/Projects/Harbor Two" commit -m x'), '/Users/someone/Projects/Harbor Two');
  assert.equal(at('cd /Users/someone/Projects/Tide && git -C ../Harbor commit -m x'), HARBOR, 'git -C is relative to the cd before it');
  // The cd that counts is the last one before the commit, not one after it.
  assert.equal(at('cd /Users/someone/Projects/Tide && git commit -m x && cd /tmp'), '/Users/someone/Projects/Tide');
  // Anything that expands cannot be named, and the working folder does not stand in for it: the folder is unknown.
  assert.equal(at('cd "$REPO" && git commit -m x'), null);
  assert.equal(at('D=/tmp/x; cd "$D/wt" && python -m pytest -q'), null);
  assert.equal(at('git -C "$REPO" commit -q'), null);
  assert.equal(at('git -C $REPO commit -q'), null);
  assert.equal(at('cd - && git commit -m x'), null);
  assert.equal(at('popd && git commit -m x'), null);
  // …except the repository's own top folder, which is where the shell already is as far as a repository is concerned.
  assert.equal(at('cd $(git rev-parse --show-toplevel) && npm test'), HARBOR);
  assert.equal(at('cd "$(git rev-parse --show-toplevel)" && npm test'), HARBOR);
  // Every way a folder is entered: a subshell (which puts it back when it closes), pushd, braces, ||, a redirection.
  const TIDE = '/Users/someone/Projects/Tide';
  assert.equal(at(`(cd ${TIDE} && git commit -m x)`), TIDE);
  assert.equal(at(`pushd ${TIDE} && git commit -q`), TIDE);
  assert.equal(at(`{ cd ${TIDE}; git commit -q; }`), TIDE);
  assert.equal(at(`cd ${TIDE} || exit 1; git commit -q`), TIDE);
  assert.equal(at(`cd ${TIDE} 2>/dev/null && git commit -q`), TIDE);
  assert.equal(at(`cd ${TIDE} > /dev/null 2>&1; git commit -q`), TIDE);
  assert.equal(at(`git --git-dir=${TIDE}/.git --work-tree=${TIDE} commit -q`), TIDE);
  assert.equal(at(`git --git-dir=${TIDE}/.git commit -q`), TIDE);
  assert.equal(at(`git --git-dir=${TIDE}/.git/worktrees/x commit -q`), null, 'a git folder that is not <checkout>/.git names no checkout');
  // Clause keywords before a cd: it still moves the shell for what follows.
  assert.equal(at(`if cd ${TIDE}; then git commit -q; fi`), TIDE);
  assert.equal(at(`while ! cd ${TIDE}; do sleep 1; done; git commit -q`), TIDE);
  assert.equal(at(`until cd ${TIDE}; do sleep 1; done\ngit commit -q`), TIDE);
  assert.equal(at(`if true\nthen\n  cd ${TIDE}\nfi\ngit commit -q`), TIDE);
  // A cd in a pipeline stage runs in a subshell of its own, and one in a function body only when the function is called.
  assert.equal(at(`cd ${TIDE} | cat; git commit -q`), HARBOR);
  assert.equal(at(`cd ${TIDE} 2>&1 | cat; git commit -q`), HARBOR);
  assert.equal(at(`echo x | cd ${TIDE} && git commit -q`), HARBOR);
  assert.equal(at(`cd ${TIDE} && git log | head -1 && git commit -q`), TIDE, 'a pipe after a later command is not the cd\'s');
  assert.equal(at(`cd ${TIDE} && f() { cd /tmp; } && git commit -q`), TIDE);
  assert.equal(at(`function f { cd /tmp; }; git commit -q`), HARBOR);
  // GIT_DIR or GIT_WORK_TREE set before git moves it where this cannot follow: the folder is unknown, not the shell's.
  assert.equal(at(`GIT_DIR=${TIDE}/.git git commit -q`), null);
  assert.equal(at(`export GIT_WORK_TREE=${TIDE}; git commit -q`), null);
  assert.equal(at(`env GIT_DIR=${TIDE}/.git git commit -q`), null);
  assert.equal(at(`echo "GIT_DIR=${TIDE}/.git"; git commit -q`), HARBOR, 'quoted text sets nothing');
  assert.equal(classifyCommand(`GIT_DIR=${TIDE}/.git git commit -q; npm test`, HARBOR).testFolder, HARBOR, 'a test run does not read GIT_DIR');
  // Text that never runs: a heredoc body, a quoted string, a comment, a commit message.
  assert.equal(at(`cat > notes.sh <<EOF\ncd ${TIDE}\nEOF\ngit commit -q`), HARBOR);
  assert.equal(at(`echo "done; cd ${TIDE}" && git commit -q`), HARBOR);
  assert.equal(at(`git commit -m "$(cat <<'EOF'\nSECRET; cd ${TIDE}\nEOF\n)"`), HARBOR);
  assert.equal(classifyCommand('# git commit later\nls', HARBOR), null);
  assert.equal(classifyCommand('echo "npm test"', HARBOR), null);
  // A test run and a commit in one call each keep their own folder.
  assert.deepEqual(classifyCommand(`cd ${TIDE} && npm test; cd ${HARBOR} && git commit -q`, HARBOR), { commit: true, test: true, git: true, folder: HARBOR, testFolder: TIDE, sealed: false });
  assert.deepEqual(classifyCommand(`(cd ${TIDE} && npm test) && git commit -q`, HARBOR), { commit: true, test: true, git: true, folder: HARBOR, testFolder: TIDE, sealed: false });
  // Classes: only commits, test runs and git or gh commands are remembered at all.
  assert.equal(classifyCommand('ls -la', HARBOR), null);
  assert.deepEqual(classifyCommand('npm test && git commit -am x', HARBOR), { commit: true, test: true, git: true, folder: HARBOR, testFolder: HARBOR, sealed: false });
  assert.equal(classifyCommand('git status --short', HARBOR).commit, false);
  assert.equal(classifyCommand('git log --grep commit', HARBOR).commit, false);
  assert.equal(classifyCommand('echo digit commit', HARBOR), null);
  for (const command of ['npm test', 'npm run test:unit', 'pnpm test', 'node --test tests/a.test.mjs', 'pytest -q', 'python3 -m pytest tests', 'npx vitest run', 'npx jest', 'cargo test', 'go test ./...']) {
    assert.equal(classifyCommand(command, HARBOR)?.test, true, command);
  }
  assert.equal(classifyCommand('npm run lint', HARBOR), null);
  const SEALED = { commit: false, test: false, git: false, folder: null, testFolder: null, sealed: true };
  // A sealed folder named anywhere in the command seals the whole call, however the shell gets there.
  for (const command of [
    'cd /Users/someone/sealed-client/repo && git commit -m x', '(cd /Users/someone/sealed-client/repo && git commit -m x)',
    'pushd /Users/someone/sealed-client/repo; git commit -q', 'git --git-dir=/Users/someone/sealed-client/repo/.git --work-tree=/Users/someone/sealed-client/repo commit',
    'D=/Users/someone/sealed-client/repo; cd "$D" && git commit -q', './release.sh /Users/someone/sealed-client/repo',
  ]) assert.deepEqual(classifyCommand(command, HARBOR), SEALED, command);
  assert.deepEqual(classifyCommand('git commit -q', '/Users/someone/sealed-client/repo'), SEALED);
  // Long commands stay cheap: no pattern backtracks across a line that repeats `node`, and folders cannot grow forever.
  for (const command of ['echo ' + 'node x '.repeat(9000), 'echo --test ' + 'node x '.repeat(9000), 'git' + ' -C x'.repeat(10000) + ' status', 'cd a; '.repeat(10000) + 'git commit']) {
    const started = performance.now();
    classifyCommand(command, HARBOR);
    assert.ok(performance.now() - started < 500, `${command.slice(0, 30)}: ${Math.round(performance.now() - started)} ms`);
  }
  assert.equal(at('cd a; '.repeat(40) + 'git commit -q'), null, 'more folder changes than folderHops name no folder');
});

test('work log: a crafted 64 KB command is classified in linear time', () => {
  // Each of these once made a pattern rescan the rest of the command from every start (seconds on the main thread).
  for (const unit of ['a=do ', 'x=then ', ';a=b ', 'if ', '! ', 'f(){ ', 'cd a >& ', 'cd a|', '{ ', '$(', 'cd ']) {
    const command = unit.repeat(Math.floor((WORK_LIMITS.commandChars - 20) / unit.length)) + ' git status';
    const started = performance.now();
    classifyCommand(command, HARBOR, { homeDir: HOME });
    const ms = performance.now() - started;
    assert.ok(ms < 250, `${JSON.stringify(unit)}: ${Math.round(ms)} ms`);
  }
});

test('work log: in a sub-agent transcript, where no result carries toolUseResult, a commit that did not fail is a window', () => {
  const side = { sidechain: true };
  const bare = { extra: { toolUseResult: undefined } };
  const TIDE = '/Users/someone/Projects/Tide';
  const quiet = bash(T0, `cd ${TIDE} && git commit -q -m "SECRET-QUIET"`, side);
  const loud = bash(T0 + 10 * SEC, 'git commit -m "SECRET-LOUD"', side);
  const refused = bash(T0 + 20 * SEC, 'git commit -q -m x', side);
  const erred = bash(T0 + 30 * SEC, 'git commit -q -m x', side);
  const rows = [
    quiet.row, result(T0 + 700, quiet.id, { ...side, ...bare }),
    loud.row, result(T0 + 11 * SEC, loud.id, { ...side, ...bare, stdout: '[main 1234567] SECRET-LOUD' }),
    // A failed call made no commit: is_error, or the error string a few sub-agent results carry.
    refused.row, result(T0 + 21 * SEC, refused.id, { ...side, ...bare, error: true }),
    erred.row, result(T0 + 31 * SEC, erred.id, { ...side, extra: { toolUseResult: 'Error: nothing to commit' } }),
  ];
  const log = workLogOf(parseWorkText(jsonl(rows), emptyWorkState(), { homeDir: HOME, sidechain: true }));
  assert.deepEqual(log.git.map(item => [item.kind, item.sha, item.quiet, item.folder, item.from, item.at]), [
    ['commit', null, true, HARBOR, T0 + 10 * SEC, T0 + 11 * SEC], ['commit', null, true, TIDE, T0, T0 + 700],
  ]);
  noSecrets(log, 'sub-agent commits');
  // The session's own transcript always has the harness's result object; a bare result there is not taken as settled.
  const own = bash(T0, 'git commit -q -m x');
  assert.equal(workLogOf(parse([own.row, result(T0 + SEC, own.id, bare)])), null);
});

test('work log: a commit with no annotation keeps its folder and the time from the call to its result', () => {
  const quiet = bash(T0, 'cd "/Users/someone/Projects/Harbor Two" && git commit -q -m "SECRET-QUIET"');
  const other = bash(T0 + 5 * SEC, 'git status');
  const state = parse([quiet.row, result(T0 + 1500, quiet.id), other.row, result(T0 + 6 * SEC, other.id, { stdout: 'SECRET-STATUS' })]);
  assert.deepEqual(workLogOf(state).git, [
    { kind: 'commit', at: T0 + 1500, folder: '/Users/someone/Projects/Harbor Two', sha: null, branch: null, action: null, number: null, quiet: true, from: T0 },
  ]);
  noSecrets(workLogOf(state), 'quiet commit');
});

test('work log: test counts for each runner, from the end of the output only', () => {
  const cases = [
    ['node', '✔ reads (1.2ms)\nℹ tests 1082\nℹ suites 0\nℹ pass 1082\nℹ fail 0\nℹ cancelled 0\nℹ duration_ms 41000\n', 1082, 0],
    ['node', '\u001b[32mℹ pass 40\u001b[39m\n\u001b[31mℹ fail 2\u001b[39m\n', 40, 2],
    ['tap', 'ok 1 - a\n# tests 12\n# suites 0\n# pass 11\n# fail 1\n', 11, 1],
    ['pytest', '...\n===== 1 failed, 12 passed, 2 skipped in 0.52s =====\n', 12, 1],
    ['pytest', '...\n3 passed in 0.10s\n', 3, 0],
    ['pytest', '1 passed, 2 errors in 1.00s\n', 1, 2],
    ['jest', 'Tests:       1 failed, 1 skipped, 12 passed, 14 total\nSnapshots:   0 total\nTime:        1.2 s\n', 12, 1],
    ['vitest', ' Test Files  2 passed (2)\n      Tests  1 failed | 11 passed (12)\n   Start at  10:00:00\n', 11, 1],
    ['cargo', 'test result: ok. 10 passed; 0 failed; 1 ignored; 0 measured\n\ntest result: FAILED. 3 passed; 2 failed; 0 ignored; 0 measured\n', 13, 2],
    // `go test -v` counts its unindented tests when the whole output is in view (subtests are indented)…
    ['go', '=== RUN   TestA\n--- PASS: TestA (0.00s)\n=== RUN   TestB\n    --- PASS: TestB/sub (0.00s)\n--- FAIL: TestB (0.00s)\nFAIL\nFAIL\texample.com/p\t0.01s\n', 1, 1, true],
    // …and its packages otherwise, which is also all a run without -v says.
    ['go', '--- PASS: TestY (0.00s)\n--- PASS: TestZ (0.00s)\nok  \texample.com/p\t0.01s\n', 1, 0],
    ['go', 'ok  \texample.com/a\t0.01s\nFAIL\texample.com/b\t0.02s\nok  \texample.com/c\t(cached)\n', 2, 1],
  ];
  for (const [runner, output, passed, failed, complete = false] of cases) assert.deepEqual(testSummary(output, { complete }), { runner, passed, failed }, output);
  // A large -v run seen through its 8 KB tail counts packages, never the tests that happened to fit in the window.
  const verbose = Array.from({ length: 400 }, (_, i) => `=== RUN   Test${i}\n=== RUN   Test${i}/sub\n    --- PASS: Test${i}/sub (0.00s)\n--- PASS: Test${i} (0.00s)\n`).join('') + 'PASS\nok  \texample.com/big\t0.30s\n';
  assert.deepEqual(testRun([verbose]), { runner: 'go', passed: 1, failed: 0 });
  const short = Array.from({ length: 5 }, (_, i) => `=== RUN   Test${i}\n    --- PASS: Test${i}/sub (0.00s)\n--- ${i === 4 ? 'FAIL' : 'PASS'}: Test${i} (0.00s)\n`).join('') + 'FAIL\nFAIL\texample.com/small\t0.01s\n';
  assert.deepEqual(testRun([short]), { runner: 'go', passed: 4, failed: 1 }, 'a whole short run counts its tests, not its subtests');
  // Node prints the summary and then every failure's details: past 8 KB of details, the counts come from just above
  // the "failing tests" heading, so a failing run is never lost and an older passing run never stands in for it.
  const details = Array.from({ length: 120 }, (_, i) => `test at tests/x.test.mjs:${i}:1\n✖ case ${i} (1ms)\n  AssertionError [ERR_ASSERTION]: SECRET-DETAIL ${'z'.repeat(200)}\n`).join('\n');
  const failing = `✔ ok (1ms)\n✖ case 0 (1ms)\nℹ tests 1089\nℹ suites 0\nℹ pass 1082\nℹ fail 7\nℹ cancelled 0\nℹ duration_ms 41000\n\n\u001b[31m✖ failing tests:\u001b[39m\n\n${details}`;
  assert.ok(failing.length > 3 * WORK_LIMITS.outputBytes);
  assert.equal(testSummary(failing.slice(-WORK_LIMITS.outputBytes)), null);
  assert.deepEqual(testRun([failing, '']), { runner: 'node', passed: 1082, failed: 7 });
  assert.deepEqual(testRun([`✖ failing tests:\n\n${details}`]), { runner: 'node', passed: null, failed: null }, 'failed, with the counts unknown');
  // Two tools in one command: the summary printed last is the one that counts.
  assert.deepEqual(testSummary('Tests:       5 passed, 5 total\n...\nℹ pass 7\nℹ fail 0\n'), { runner: 'node', passed: 7, failed: 0 });
  assert.equal(testSummary('No tests found, exiting with code 1\n'), null);
  assert.equal(testSummary('ℹ pass 3\n'), null, 'a block with no fail line is not a summary');

  // Only a call classified as a test run is looked at, and only the last 8 KB of what it printed.
  const tests = bash(T0, 'cd "/Users/someone/Projects/Harbor Two" && npm test');
  const cat = bash(T0 + 10 * SEC, 'cat SECRET-NOTES.txt');
  const early = bash(T0 + 20 * SEC, 'npm test');
  const state = parse([
    tests.row, result(T0 + 40 * SEC, tests.id, { stdout: `SECRET-TEST-OUTPUT\n${'x'.repeat(100)}\nℹ tests 5\nℹ pass 4\nℹ fail 1\n`, stderr: 'SECRET-STDERR' }),
    cat.row, result(T0 + 11 * SEC, cat.id, { stdout: 'ℹ pass 3\nℹ fail 0\n' }),
    early.row, result(T0 + 50 * SEC, early.id, { stdout: `ℹ pass 9\nℹ fail 0\n${'y'.repeat(WORK_LIMITS.outputBytes + 10)}` }),
  ]);
  assert.deepEqual(workLogOf(state).tests, [{ runner: 'node', passed: 4, failed: 1, at: T0 + 40 * SEC, folder: '/Users/someone/Projects/Harbor Two' }]);
  noSecrets(workLogOf(state), 'test runs');
});

test('work log: a finished reply that ends on a question, until the person answers', () => {
  assert.equal(asksQuestion('Done. All 12 tests pass.\n\nWant me to commit and push?'), true);
  assert.equal(asksQuestion('Should I push? I can also open a pull request.'), true, 'a question anywhere in the last paragraph');
  assert.equal(asksQuestion('(does that match what you expected?)'), true);
  assert.equal(asksQuestion('Is this right? I checked twice.\n\nEverything is committed.'), false, 'a question in an earlier paragraph');
  assert.equal(asksQuestion('Here it is:\n```js\nconst x = a ? b : c;\n```'), false);
  assert.equal(asksQuestion('Use `a?.b` there, and see https://example.test/?q=1 for details.'), false);
  assert.equal(asksQuestion(`${'x'.repeat(600)}\n\`\`\`\n\nShould I keep going?`.slice(-400)), true, 'a window that starts inside a code block');
  assert.equal(asksQuestion(''), false);

  const question = say(T0, 'All green.\n\nWant me to commit this?');
  let state = parse([question]);
  assert.deepEqual(workLogOf(state).asked, { at: T0 });
  // The person writes: the question is answered, and only the time is kept.
  state = parse([person(T0 + 60 * SEC, 'SECRET-ANSWER yes please')], state);
  assert.deepEqual(workLogOf(state), { git: [], tests: [], edited: [], asked: null, lastUserAt: T0 + 60 * SEC });
  noSecrets(workLogOf(state), 'asked');

  // A harness notice, a meta row and a compaction summary are not the person.
  state = parse([say(T0, 'Ready. Shall I merge it?'), person(T0 + SEC, '<system-reminder>SECRET-REMINDER</system-reminder>'), person(T0 + 2 * SEC, 'SECRET-META', { isMeta: true }), person(T0 + 3 * SEC, 'SECRET-SUMMARY', { isCompactSummary: true })]);
  assert.deepEqual(workLogOf(state).asked, { at: T0 });
  assert.equal(workLogOf(state).lastUserAt, null);
  // The session going on without an answer settles it too.
  const later = bash(T0 + 5 * SEC, 'git status');
  state = parse([later.row], state);
  assert.equal(workLogOf(state), null, 'nothing left to say');

  // The rows of one final message share its id: a thinking row, then the text that asks.
  state = parse([say(T0, '', { id: 'msg_final', blocks: [{ type: 'thinking', thinking: 'SECRET-THINKING' }] }), say(T0 + 1, 'Merge now?', { id: 'msg_final' })]);
  assert.deepEqual(workLogOf(state).asked, { at: T0 + 1 });
  // A question in a turn that has not finished is not one yet, and a plain reply is no question.
  assert.equal(workLogOf(parse([say(T0, 'Checking, ok?', { stop: 'tool_use' })])), null);
  assert.equal(workLogOf(parse([say(T0, 'Committed and pushed.')])), null);
  // A newer finished reply replaces the older question.
  assert.equal(workLogOf(parse([say(T0, 'Push?'), say(T0 + SEC, 'Pushed.')])), null);
});

test('work log: sub-agent rows, sealed folders and caps', () => {
  const side = bash(T0, 'git commit -m x', { sidechain: true });
  let state = parse([
    side.row, result(T0 + SEC, side.id, { sidechain: true, git: { commit: { sha: 'bbbbbbb', kind: 'committed' } } }),
    say(T0 + 2 * SEC, 'Want more?', { sidechain: true }),
  ]);
  assert.equal(workLogOf(state), null, 'rows a sub-agent wrote are skipped');

  const sealed = bash(T0, 'cd /Users/someone/sealed-client/repo && git commit -m x');
  state = parse([sealed.row, result(T0 + SEC, sealed.id, { git: { commit: { sha: 'ccccccc', kind: 'committed' } } }),
    result(T0 + 2 * SEC, 'toolu_sealedrow', { cwd: '/Users/someone/sealed-client/repo', git: { commit: { sha: 'ddddddd', kind: 'committed' } } })]);
  assert.equal(workLogOf(state), null, 'a sealed folder keeps nothing, and is never credited to the working folder');
  // However the call reaches the sealed folder, its annotation (SHA and branch) and its test counts are dropped whole.
  for (const command of [
    '(cd /Users/someone/sealed-client/repo && git commit -m x && git push && npm test)', 'pushd /Users/someone/sealed-client/repo && git commit -m x && npm test',
    'git --git-dir=/Users/someone/sealed-client/repo/.git --work-tree=/Users/someone/sealed-client/repo commit -m x', 'D=/Users/someone/sealed-client/repo; cd "$D" && git commit -m x && npm test',
  ]) {
    const call = bash(T0, command);
    const log = workLogOf(parse([call.row, result(T0 + SEC, call.id, { stdout: 'ℹ pass 3\nℹ fail 0\n', git: { commit: { sha: 'abcdef1', kind: 'committed', branch: 'sealed-branch-name' }, push: { branch: 'sealed-branch-name' } } })]));
    assert.equal(log, null, command);
  }
  // A folder that cannot be named keeps nothing either: not the annotation, not a quiet window, not the test counts.
  for (const command of ['cd "$REPO" && git commit -m x && npm test', 'git -C "$REPO" commit -q']) {
    const call = bash(T0, command);
    assert.equal(workLogOf(parse([call.row, result(T0 + SEC, call.id, { stdout: 'ℹ pass 3\nℹ fail 0\n', git: { commit: { sha: 'abcdef1', kind: 'committed', branch: 'main' } } })])), null, command);
  }
  // A commit call that failed (nothing to commit, a hook that refused) made no commit, so it leaves no window.
  const refused = bash(T0, 'git commit -q -m x');
  assert.equal(workLogOf(parse([refused.row, result(T0 + SEC, refused.id, { error: true, extra: { toolUseResult: 'Error: Exit code 1' } })])), null);
  const nothing = bash(T0, 'git commit -q -m x');
  assert.equal(workLogOf(parse([nothing.row, { ...result(T0 + SEC, nothing.id), toolUseResult: 'Error: nothing to commit' }])), null);

  const rows = [];
  for (let i = 0; i < 60; i++) {
    const call = bash(T0 + i * SEC, 'git commit -m x');
    rows.push(call.row, result(T0 + i * SEC + 500, call.id, { git: { commit: { sha: i.toString(16).padStart(7, '0'), kind: 'committed' } } }));
  }
  for (let i = 0; i < 25; i++) {
    const call = bash(T0 + 100 * SEC + i * SEC, 'npm test');
    rows.push(call.row, result(T0 + 100 * SEC + i * SEC + 500, call.id, { stdout: `ℹ pass ${i}\nℹ fail 0\n` }));
  }
  const log = workLogOf(parse(rows));
  assert.equal(log.git.length, WORK_LIMITS.git);
  assert.equal(log.git[0].sha, (59).toString(16).padStart(7, '0'), 'newest first');
  assert.equal(log.git.at(-1).sha, (10).toString(16).padStart(7, '0'));
  assert.equal(log.tests.length, WORK_LIMITS.tests);
  assert.deepEqual([log.tests[0].passed, log.tests.at(-1).passed], [24, 5]);

  // Calls still waiting for their result are bounded; the oldest goes first.
  state = emptyWorkState();
  parse(Array.from({ length: 10 }, (_, i) => bash(T0 + i, 'npm test', { id: `toolu_wait${i}` }).row), state, { pending: 4 });
  assert.deepEqual([...state.pending.keys()], ['toolu_wait6', 'toolu_wait7', 'toolu_wait8', 'toolu_wait9']);
});

test('work log: edit calls and delta lines give edit times; a snapshot names files but never says when', () => {
  const src = `${HARBOR}/src`;
  const snapshot = (at, files) => ({ type: 'file-history-snapshot', messageId: `m-${at}`, isSnapshotUpdate: false,
    snapshot: { messageId: `m-${at}`, timestamp: iso(at), trackedFileBackups: Object.fromEntries(files.map(([name, when]) => [name, { backupFileName: 'SECRET-BACKUP-NAME', version: 2, backupTime: iso(when), realParentDir: src }])) } });
  const delta = (at, name, parent = src) => ({ type: 'file-history-delta', messageId: `m-${at}`, trackingPath: name, backup: { backupFileName: 'SECRET-BACKUP-NAME', version: 1, backupTime: iso(at), realParentDir: parent }, timestamp: iso(at) });
  const state = parse([
    snapshot(T0, [['src/a.ts', T0 - MIN], ['src/b.ts', T0 - 2 * MIN]]),
    delta(T0 + MIN, 'a.ts'),
    // A snapshot stamps a changed file's backup when the person next writes, hours after the edit and whoever made
    // it, so its time is never taken as an edit time: b.ts is named with no time.
    snapshot(T0 + 4 * 60 * MIN, [['src/a.ts', T0 + 4 * 60 * MIN], ['src/b.ts', T0 + 4 * 60 * MIN]]),
    delta(T0 + 3 * MIN, '.env.local'),
    delta(T0 + 3 * MIN, 'notes.md', '/Users/someone/sealed-client/repo'),
  ]);
  assert.deepEqual(workLogOf(state).edited, [{ path: `${src}/b.ts`, at: null }, { path: `${src}/a.ts`, at: T0 + MIN }]);
  noSecrets(workLogOf(state), 'edited files');
  // An edit tool call that worked gives the exact time; a failed one, a secret name and a sealed folder give nothing.
  const edits = parse([
    ...edit(T0, `${src}/a.ts`), ...edit(T0 + 5 * MIN, `${src}/c.ts`, { tool: 'Write' }), ...edit(T0 + 6 * MIN, `${src}/d.ipynb`, { tool: 'NotebookEdit' }),
    ...edit(T0 + 7 * MIN, `${src}/a.ts`, { tool: 'MultiEdit' }), ...edit(T0 + 8 * MIN, `${src}/c.ts`, { error: true }),
    ...edit(T0 + 9 * MIN, `${src}/.env`), ...edit(T0 + 9 * MIN, '/Users/someone/sealed-client/repo/x.ts'), ...edit(T0 + 9 * MIN, 'relative/x.ts'),
  ]);
  assert.deepEqual(workLogOf(edits).edited, [{ path: `${src}/a.ts`, at: T0 + 7 * MIN + 200 }, { path: `${src}/d.ipynb`, at: T0 + 6 * MIN + 200 }, { path: `${src}/c.ts`, at: T0 + 5 * MIN + 200 }]);
  noSecrets(workLogOf(edits), 'edit calls');
  assert.equal(edits.pending.size, 0);
  const capped = parse(Array.from({ length: 5 }, (_, i) => delta(T0 + i, `f${i}.ts`)), emptyWorkState(), { edited: 3 });
  assert.deepEqual(workLogOf(capped).edited.map(item => path.basename(item.path)), ['f4.ts', 'f3.ts', 'f2.ts']);
});
async function tempDir(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'summon-work-log-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const commitRows = (at, sha) => { const call = bash(at, 'git commit -m x'); return [call.row, result(at + 500, call.id, { git: { commit: { sha, kind: 'committed' } } })]; };
const shas = entry => workLogOf(entry.state)?.git.filter(item => item.kind === 'commit').map(item => item.sha) ?? [];

test('work log reader: grows forward, starts mid-line, notices a new file and skips oversize lines', async t => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'session.jsonl');
  await fs.writeFile(file, jsonl(commitRows(T0, 'aaaaaaa')));
  const first = await readWorkLog(file, null, { homeDir: HOME });
  assert.deepEqual(shas(first), ['aaaaaaa']);
  // Nothing appended: the same entry back, no bytes read.
  assert.equal(await readWorkLog(file, first, { homeDir: HOME }), first);
  // Appended: only the new bytes are read, so nothing is counted twice.
  await fs.appendFile(file, jsonl(commitRows(T0 + 10 * SEC, 'bbbbbbb')));
  const grown = await readWorkLog(file, first, { homeDir: HOME });
  assert.deepEqual(shas(grown), ['bbbbbbb', 'aaaaaaa']);
  // A half-written last line waits for its newline.
  const [call, done] = commitRows(T0 + 20 * SEC, 'ccccccc');
  const half = JSON.stringify(call);
  await fs.appendFile(file, half.slice(0, 40));
  const waiting = await readWorkLog(file, grown, { homeDir: HOME });
  assert.equal(waiting.consumed, grown.consumed);
  await fs.appendFile(file, `${half.slice(40)}\n${JSON.stringify(done)}\n`);
  assert.deepEqual(shas(await readWorkLog(file, waiting, { homeDir: HOME })), ['ccccccc', 'bbbbbbb', 'aaaaaaa']);

  // The first look starts at most firstBytes before the end, and drops the line it starts inside.
  const tail = path.join(dir, 'tail.jsonl');
  const last = jsonl(commitRows(T0 + 30 * SEC, 'eeeeeee'));
  await fs.writeFile(tail, jsonl(commitRows(T0, 'ddddddd')) + last);
  assert.deepEqual(shas(await readWorkLog(tail, null, { limits: { firstBytes: Buffer.byteLength(last) + 20 } })), ['eeeeeee']);

  // A new file under the same name (an atomic rewrite) starts over.
  await fs.writeFile(`${file}.tmp`, jsonl(commitRows(T0, 'fffffff')));
  await fs.rename(`${file}.tmp`, file);
  const fresh = await readWorkLog(file, grown, { homeDir: HOME });
  assert.deepEqual(shas(fresh), ['fffffff']);
  // A file that shrank starts over too.
  await fs.writeFile(file, '');
  assert.equal(workLogOf((await readWorkLog(file, fresh)).state), null);

  // A line over lineBytes is never parsed; a line longer than a whole pass is skipped over, pass by pass.
  const big = path.join(dir, 'big.jsonl');
  const [bigCall, bigResult] = commitRows(T0, '1111111');
  await fs.writeFile(big, jsonl([bigCall, { ...bigResult, padding: 'z'.repeat(3000) }]));
  assert.deepEqual(shas(await readWorkLog(big, null, { limits: { lineBytes: 2000 } })), []);
  const long = path.join(dir, 'long.jsonl');
  await fs.writeFile(long, '');
  let entry = await readWorkLog(long, null, { limits: { passBytes: 512 } });
  await fs.appendFile(long, `${JSON.stringify({ type: 'user', padding: 'z'.repeat(2000) })}\n${jsonl(commitRows(T0, '2222222'))}`);
  for (let i = 0; i < 10 && entry.consumed < (await fs.stat(long)).size; i++) entry = await readWorkLog(long, entry, { limits: { passBytes: 512 } });
  assert.deepEqual(shas(entry), ['2222222']);

  // A symlink under a transcript's name is never followed.
  await fs.symlink(tail, path.join(dir, 'link.jsonl'));
  await assert.rejects(readWorkLog(path.join(dir, 'link.jsonl'), null));
});

test('work log reader: a call and its result can arrive in different passes', async t => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'session.jsonl');
  const tests = bash(T0, 'cd "/Users/someone/Projects/Harbor Two" && npm test');
  const quiet = bash(T0 + SEC, 'git commit -q -m "SECRET-QUIET"');
  await fs.writeFile(file, jsonl([tests.row, quiet.row]));
  const first = await readWorkLog(file, null);
  assert.equal(first.state.pending.size, 2);
  assert.equal(workLogOf(first.state), null);
  await fs.appendFile(file, jsonl([result(T0 + 30 * SEC, tests.id, { stdout: 'ℹ tests 3\nℹ pass 3\nℹ fail 0\n' }), result(T0 + 31 * SEC, quiet.id)]));
  const second = await readWorkLog(file, first);
  const log = workLogOf(second.state);
  assert.deepEqual(log.tests, [{ runner: 'node', passed: 3, failed: 0, at: T0 + 30 * SEC, folder: '/Users/someone/Projects/Harbor Two' }]);
  assert.deepEqual(log.git.map(item => [item.kind, item.quiet, item.from, item.at, item.folder]), [['commit', true, T0 + SEC, T0 + 31 * SEC, HARBOR]]);
  assert.equal(second.state.pending.size, 0);
  noSecrets(log, 'across passes');
});

test('Claude reader: a terminal session carries its work log and when it last edited each file', async t => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'summon-work-home-')));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const now = Date.now();
  const id = '00000000-0000-4000-8000-000000000777';
  const repo = path.join(home, 'Projects', 'Harbor');
  const line = (row, at) => ({ ...row, entrypoint: 'cli', cwd: repo, sessionId: id, timestamp: iso(at) });
  const commit = bash(now - 9 * 60000, `cd ${repo} && git commit -q -m "SECRET-QUIET"`, { cwd: repo });
  const tests = bash(now - 5 * 60000, 'npm test', { cwd: repo });
  const delta = (at, name) => ({ type: 'file-history-delta', messageId: `m-${at}`, trackingPath: name, backup: { backupFileName: `b-${at}`, version: 1, backupTime: iso(at), realParentDir: path.join(repo, 'src') }, timestamp: iso(at) });
  const file = path.join(home, '.claude', 'projects', '-Users-someone-Projects-Harbor', `${id}.jsonl`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, jsonl([
    line(person(0, 'SECRET-REQUEST fix the list'), now - 10 * 60000),
    line(commit.row, now - 9 * 60000), line(result(0, commit.id), now - 9 * 60000 + 800),
    delta(now - 8 * 60000, 'list.ts'), delta(now - 7 * 60000, 'panel.ts'),
    line(tests.row, now - 5 * 60000), line(result(0, tests.id, { stdout: 'ℹ pass 12\nℹ fail 0\n' }), now - 4 * 60000),
    delta(now - 3 * 60000, 'list.ts'),
    line(say(0, 'Fixed.\n\nShould I push it?'), now - 2 * 60000),
  ]));
  const reader = createClaudeReader({ homeDir: home, processes: new Map(), isAlive: () => false, readLocalStorageKeys: async () => new Map() });
  const found = (await reader.read({ recentMs: 86400000 })).sessions.find(item => item.id === id);
  assert.ok(found, 'the terminal session is listed');
  assert.deepEqual(found.touchedPaths, [path.join(repo, 'src', 'list.ts'), path.join(repo, 'src', 'panel.ts')]);
  // A file edited again keeps its newest time.
  assert.deepEqual(found.touchedTimes, [now - 3 * 60000, now - 7 * 60000]);
  assert.deepEqual(found.workLog.git.map(item => [item.kind, item.quiet, item.folder]), [['commit', true, repo]]);
  assert.deepEqual(found.workLog.tests.map(item => [item.runner, item.passed, item.failed, item.folder]), [['node', 12, 0, repo]]);
  assert.deepEqual(found.workLog.asked, { at: now - 2 * 60000 });
  assert.equal(found.workLog.lastUserAt, now - 10 * 60000);
  noSecrets({ touchedPaths: found.touchedPaths, workLog: found.workLog }, 'reader output');
});

test('Claude reader: at most workReads transcripts are read per pass, and the rest keep the log they had', async t => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'summon-work-budget-')));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const now = Date.now();
  const repo = path.join(home, 'Projects', 'Harbor');
  const dir = path.join(home, '.claude', 'projects', '-Users-someone-Projects-Harbor');
  await fs.mkdir(dir, { recursive: true });
  const ids = [1, 2, 3].map(n => `00000000-0000-4000-8000-00000000080${n}`);
  for (const [index, id] of ids.entries()) {
    await fs.writeFile(path.join(dir, `${id}.jsonl`), jsonl([{ ...person(0, 'SECRET-REQUEST'), entrypoint: 'cli', cwd: repo, sessionId: id, timestamp: iso(now - (index + 1) * 60000) }]));
  }
  const reader = createClaudeReader({ homeDir: home, processes: new Map(), isAlive: () => false, readLocalStorageKeys: async () => new Map(), limits: { workReads: 1 } });
  const logged = async () => (await reader.read({ recentMs: 86400000 })).sessions.filter(item => item.workLog).length;
  assert.equal(await logged(), 1);
  assert.equal(reader.stats().workReads, 1);
  assert.equal(await logged(), 2, 'the one read before keeps its log without being opened again');
  assert.equal(await logged(), 3);
  assert.equal(await logged(), 3);
  assert.equal(reader.stats().workChecks, 0, 'nothing grew, so nothing was opened');
});

test('work log: a turn that ends by offering options asks the person to pick, even without a question mark', () => {
  assert.equal(asksQuestion('Both work.\n\nYour call:\n- **Local model:** slower, private.\n- **Claude:** faster, uses the subscription.'), true);
  assert.equal(asksQuestion('Two options:\n\n1. Merge now.\n2. Wait for the review.'), true, 'the lead-in may close the paragraph before the list');
  assert.equal(asksQuestion('Which one should I keep:\n- the short name\n  (fits the row)\n- the long name'), true, 'items may run over two lines');
  // A lead-in that offers no choice introduces a list of what was done.
  assert.equal(asksQuestion('Changes:\n- Renamed the panel.\n- Chose the shorter label.'), false);
  assert.equal(asksQuestion('Pick one:\n- a\n\nDone with the rest.'), false, 'the list must end the message');
  assert.equal(asksQuestion('- a\n- b'), false, 'a list with no lead-in');
  const state = parse([say(T0, 'Ready.\n\nPick an engine:\n- Local\n- Claude')]);
  assert.deepEqual(workLogOf(state).asked, { at: T0 });
});

test('work log: a forked transcript keeps only its own rows, and no file backed up before the fork point', () => {
  const src = `${HARBOR}/src`;
  const snapshot = (at, files) => ({ type: 'file-history-snapshot', messageId: `m-${at}`, isSnapshotUpdate: false,
    snapshot: { messageId: `m-${at}`, timestamp: iso(at), trackedFileBackups: Object.fromEntries(files.map(([name, when]) => [name, { backupFileName: 'SECRET-BACKUP-NAME', version: 2, backupTime: iso(when), realParentDir: src }])) } });
  const delta = (at, name) => ({ type: 'file-history-delta', messageId: `m-${at}`, trackingPath: name, backup: { backupFileName: 'SECRET-BACKUP-NAME', version: 1, backupTime: iso(at), realParentDir: src }, timestamp: iso(at) });
  const parentCommit = bash(T0, 'git commit -m x', { session: 'parent' });
  const parentTest = bash(T0 + MIN, 'npm test', { session: 'parent' });
  const ownTest = bash(T0 + 30 * MIN, 'npm test', { session: 'own' });
  const rows = [
    // Copied from the parent, ids and all: its first snapshot, commit, test run, edits and question.
    snapshot(T0 - MIN, [['src/early.ts', T0 - 2 * MIN]]),
    parentCommit.row, result(T0 + SEC, parentCommit.id, { session: 'parent', git: { commit: { sha: 'aaaaaaa', kind: 'committed', branch: 'main' } } }),
    parentTest.row, result(T0 + MIN + SEC, parentTest.id, { session: 'parent', stdout: 'ℹ pass 1031\nℹ fail 0\n' }),
    delta(T0 + 2 * MIN, 'parent.ts'), ...edit(T0 + 3 * MIN, `${src}/parent.ts`, { session: 'parent' }),
    say(T0 + 4 * MIN, 'Push it?', { session: 'parent' }),
    // The fork's own part: a snapshot that re-lists the parent's file (backed up before the fork) and one changed since.
    person(T0 + 20 * MIN, 'SECRET-OWN-REQUEST', { sessionId: 'own' }),
    snapshot(T0 + 20 * MIN, [['src/parent.ts', T0 + 3 * MIN], ['src/changed.ts', T0 + 20 * MIN]]),
    ...edit(T0 + 25 * MIN, `${src}/own.ts`, { session: 'own' }),
    ownTest.row, result(T0 + 31 * MIN, ownTest.id, { session: 'own', stdout: 'ℹ pass 12\nℹ fail 0\n' }),
  ];
  const state = parse(rows, emptyWorkState(), {});
  // Without ids everything counts (the old behaviour, and a sub-agent's transcript).
  assert.equal(workLogOf(state).git.length, 1);
  const own = parseWorkText(jsonl(rows), emptyWorkState(), { homeDir: HOME, ownIds: new Set(['own']) });
  const log = workLogOf(own);
  assert.deepEqual(log.git, [], "the parent's commit is not the fork's");
  assert.deepEqual(log.tests.map(item => item.passed), [12]);
  // Its snapshot re-lists the parent's files, including one changed since the fork (by anyone): only its own edit counts.
  assert.deepEqual(log.edited.map(item => path.basename(item.path)).sort(), ['own.ts']);
  assert.equal(log.asked, null);
  assert.equal(log.lastUserAt, T0 + 20 * MIN);
  assert.equal(own.owner.forkedAt, T0 + 20 * MIN);
  noSecrets(log, 'fork');
  // A transcript that is its own from the first row keeps file-history lines that come before any row names it.
  const plain = parseWorkText(jsonl([delta(T0, 'first.ts'), person(T0 + SEC, 'hi', { sessionId: 'own' }), delta(T0 + 2 * SEC, 'second.ts')]), emptyWorkState(), { ownIds: new Set(['own']) });
  assert.deepEqual(workLogOf(plain).edited.map(item => path.basename(item.path)), ['second.ts', 'first.ts']);
  // And one whose rows name no session at all (an old transcript) keeps them at the end of the pass.
  const bare = parseWorkText(jsonl([delta(T0, 'only.ts')]), emptyWorkState(), { ownIds: new Set(['own']) });
  assert.deepEqual(workLogOf(bare).edited.map(item => path.basename(item.path)), ['only.ts']);
});

test('work log: a session and its sub-agents merge into one log, the question from the session only', () => {
  const main = { git: [{ kind: 'push', at: T0 + 5 }], tests: [{ runner: 'node', passed: 1, failed: 0, at: T0 }], edited: [{ path: '/a', at: T0 }, { path: '/b', at: null }], asked: { at: T0 + 9 }, lastUserAt: T0 };
  const helper = { git: [{ kind: 'commit', at: T0 + 7 }], tests: [{ runner: 'node', passed: 2, failed: 0, at: T0 + 8 }], edited: [{ path: '/b', at: T0 + 3 }, { path: '/c', at: T0 + 1 }], asked: { at: T0 + 10 }, lastUserAt: T0 + 10 };
  assert.deepEqual(mergeWorkLogs(main, [helper, null]), {
    git: [{ kind: 'commit', at: T0 + 7 }, { kind: 'push', at: T0 + 5 }], tests: [helper.tests[0], main.tests[0]],
    edited: [{ path: '/b', at: T0 + 3 }, { path: '/c', at: T0 + 1 }, { path: '/a', at: T0 }], asked: { at: T0 + 9 }, lastUserAt: T0,
  });
  assert.deepEqual(mergeWorkLogs(null, [helper]), { ...helper, asked: null, lastUserAt: null });
  assert.equal(mergeWorkLogs(null, []), null);
  assert.equal(mergeWorkLogs(main, []), main);
  assert.equal(mergeWorkLogs(main, [helper], { git: 1 }).git.length, 1);
});

async function claudeHome(t) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'summon-work-reader-')));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const repo = path.join(home, 'Projects', 'Harbor');
  const dir = path.join(home, '.claude', 'projects', '-Users-someone-Projects-Harbor');
  await fs.mkdir(dir, { recursive: true });
  const reader = limits => createClaudeReader({ homeDir: home, processes: new Map(), isAlive: () => false, readLocalStorageKeys: async () => new Map(), limits });
  return { home, repo, dir, reader };
}
const find = async (reader, id) => (await reader.read({ recentMs: 86400000 })).sessions.find(item => item.id === id);

test('Claude reader: a pass that stopped short of the end is picked up again even when the file does not change', async t => {
  const { repo, dir, reader } = await claudeHome(t);
  const now = Date.now();
  const id = '00000000-0000-4000-8000-000000000901';
  const file = path.join(dir, `${id}.jsonl`);
  const line = (row, at) => ({ ...row, entrypoint: 'cli', cwd: repo, sessionId: id, timestamp: iso(at) });
  await fs.writeFile(file, jsonl([line(person(0, 'SECRET-REQUEST'), now - 20 * MIN)]));
  const small = reader({ workBytes: 1024 });
  assert.equal((await find(small, id)).workLog.asked, null);
  // About 10 KB arrive at once, ending in a finished reply that asks something, and then the session goes quiet.
  const padding = Array.from({ length: 40 }, (_, i) => line({ ...say(0, `SECRET-${'p'.repeat(200)}`, { stop: 'tool_use' }), n: i }, now - 15 * MIN + i));
  await fs.appendFile(file, jsonl([...padding, line(say(0, 'Done.\n\nShould I push it?'), now - 10 * MIN)]));
  let found = null;
  for (let i = 0; i < 100 && !found?.workLog?.asked; i++) found = await find(small, id);
  assert.deepEqual(found.workLog.asked, { at: now - 10 * MIN }, 'the rest of the file is read on later reads, though its size never changed again');
  // Once it has read to the end, an unchanged file is not opened at all.
  await find(small, id);
  assert.equal(small.stats().workChecks, 0);
});

test('Claude reader: what a session did through its sub-agents joins its own log', async t => {
  const { repo, dir, reader } = await claudeHome(t);
  const now = Date.now();
  const id = '00000000-0000-4000-8000-000000000902';
  const line = (row, at) => ({ ...row, entrypoint: 'cli', cwd: repo, sessionId: id, timestamp: iso(at) });
  await fs.writeFile(path.join(dir, `${id}.jsonl`), jsonl([line(person(0, 'SECRET-REQUEST'), now - 20 * MIN), line(say(0, 'Started the workflow.'), now - 19 * MIN)]));
  // A workflow's agent, two folders down: its rows are all sub-agent rows, and its "user" is the session.
  const helperDir = path.join(dir, id, 'subagents', 'workflows', 'wf_1');
  await fs.mkdir(helperDir, { recursive: true });
  // Real sub-agent results carry no toolUseResult at all (no stdout field, no git annotation): only the tool_result block.
  const side = { sidechain: true, session: id };
  const bare = { extra: { toolUseResult: undefined } };
  const commit = bash(now - 15 * MIN, `cd ${repo} && git commit -m "SECRET-MESSAGE"`, { ...side, cwd: repo });
  const tests = bash(now - 14 * MIN, 'npm test', { ...side, cwd: repo });
  await fs.writeFile(path.join(helperDir, 'agent-a1.jsonl'), jsonl([
    { ...person(now - 16 * MIN, 'SECRET-AGENT-PROMPT'), isSidechain: true, sessionId: id },
    ...edit(now - 15.5 * MIN, path.join(repo, 'src', 'made-by-agent.ts'), side),
    commit.row, result(now - 15 * MIN + 500, commit.id, { ...side, ...bare, cwd: repo, stdout: '[main abcdef1] SECRET-MESSAGE' }),
    tests.row, result(now - 14 * MIN + 500, tests.id, { ...side, ...bare, cwd: repo, stdout: 'ℹ pass 40\nℹ fail 0\n' }),
    say(now - 13 * MIN, 'Should the session merge this?', side),
  ]));
  // A symlinked sub-agent folder is never followed.
  const elsewhere = path.join(dir, 'elsewhere');
  await fs.mkdir(elsewhere);
  const other = bash(now - 12 * MIN, 'git commit -m x', side);
  await fs.writeFile(path.join(elsewhere, 'agent-x.jsonl'), jsonl([other.row, result(now - 12 * MIN, other.id, { ...side, git: { commit: { sha: 'fffffff', kind: 'committed' } } })]));
  await fs.symlink(elsewhere, path.join(dir, id, 'subagents', 'linked'));
  const found = await find(reader(), id);
  // The commit left no annotation, so it is kept as its folder and the window from the call to its result.
  assert.deepEqual(found.workLog.git.map(item => [item.kind, item.sha, item.quiet, item.folder, item.from, item.at]), [['commit', null, true, repo, now - 15 * MIN, now - 15 * MIN + 500]]);
  assert.deepEqual(found.workLog.tests.map(item => [item.passed, item.folder]), [[40, repo]]);
  assert.deepEqual(found.workLog.edited.map(item => item.path), [path.join(repo, 'src', 'made-by-agent.ts')]);
  assert.equal(found.workLog.asked, null, "a sub-agent's question is put to the session, not the person");
  assert.equal(found.workLog.lastUserAt, now - 20 * MIN);
  noSecrets(found.workLog, 'sub-agent log');
});

test('Claude reader: a forked transcript is credited only with its own part', async t => {
  const { repo, dir, reader } = await claudeHome(t);
  const now = Date.now();
  const id = '00000000-0000-4000-8000-000000000903';
  const parent = '00000000-0000-4000-8000-0000000009ff';
  const src = path.join(repo, 'src');
  const as = (row, session, at) => ({ ...row, entrypoint: 'cli', cwd: repo, sessionId: session, timestamp: iso(at) });
  const delta = (at, name) => ({ type: 'file-history-delta', messageId: `m-${at}`, trackingPath: name, backup: { backupFileName: `b-${at}`, version: 1, backupTime: iso(at), realParentDir: src }, timestamp: iso(at) });
  const snapshot = (at, names) => ({ type: 'file-history-snapshot', messageId: `m-${at}`, isSnapshotUpdate: false,
    snapshot: { messageId: `m-${at}`, timestamp: iso(at), trackedFileBackups: Object.fromEntries(names.map(([name, when]) => [name, { backupFileName: `b-${when}`, version: 2, backupTime: iso(when), realParentDir: src }])) } });
  const commit = bash(now - 50 * MIN, 'git commit -m x', { cwd: repo, session: parent });
  await fs.writeFile(path.join(dir, `${id}.jsonl`), jsonl([
    as(person(0, 'SECRET-PARENT-REQUEST'), parent, now - 60 * MIN),
    delta(now - 55 * MIN, 'parent.ts'),
    as(commit.row, parent, now - 50 * MIN), as(result(0, commit.id, { cwd: repo, git: { commit: { sha: 'aaaaaaa', kind: 'committed', branch: 'main' } } }), parent, now - 50 * MIN + 500),
    as(person(0, 'SECRET-OWN-REQUEST'), id, now - 10 * MIN),
    // The fork's snapshot re-lists the parent's file with its old backup.
    snapshot(now - 10 * MIN, [['src/parent.ts', now - 55 * MIN]]),
    delta(now - 5 * MIN, 'own.ts'),
  ]));
  const found = await find(reader(), id);
  assert.deepEqual(found.workLog.git, []);
  assert.deepEqual(found.touchedPaths, [path.join(src, 'own.ts')]);
  assert.deepEqual(found.workLog.edited.map(item => item.path), [path.join(src, 'own.ts')]);
});

test('Claude reader: the work pass stops starting new transcripts when the read runs out of time', async t => {
  const { repo, dir, reader } = await claudeHome(t);
  const now = Date.now();
  const id = '00000000-0000-4000-8000-000000000904';
  await fs.writeFile(path.join(dir, `${id}.jsonl`), jsonl([{ ...person(0, 'SECRET-REQUEST'), entrypoint: 'cli', cwd: repo, sessionId: id, timestamp: iso(now - MIN) }]));
  const out = reader({ workDeadlineMs: 0 });
  const first = await find(out, id);
  assert.ok(first, 'the session is still listed');
  assert.equal(first.workLog, undefined, 'its log waits for a read with time left');
  assert.equal(first.workLogPending, true, 'and says it is still to be read');
  assert.equal(out.stats().workChecks, 0);
  assert.equal((await find(reader(), id)).workLog.lastUserAt, now - MIN);
});

test('work log reader: a first look that starts past the fork point still knows the file is a fork', async t => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'fork.jsonl');
  const src = `${HARBOR}/src`;
  const snapshot = (at, names) => ({ type: 'file-history-snapshot', messageId: `m-${at}`, isSnapshotUpdate: false,
    snapshot: { messageId: `m-${at}`, timestamp: iso(at), trackedFileBackups: Object.fromEntries(names.map(name => [name, { backupFileName: 'b', version: 3, backupTime: iso(at), realParentDir: src }])) } });
  const delta = (at, name) => ({ type: 'file-history-delta', messageId: `m-${at}`, trackingPath: name, backup: { backupFileName: 'b', version: 1, backupTime: iso(at), realParentDir: src }, timestamp: iso(at) });
  const parentRows = Array.from({ length: 30 }, (_, i) => say(T0 + i, `SECRET-${'p'.repeat(300)}`, { session: 'parent', stop: 'tool_use' }));
  // The fork's own part opens with a title row, which names the session but carries no time.
  const ownRows = [{ type: 'custom-title', customTitle: 'SECRET-TITLE', sessionId: 'own' }, person(T0 + HOUR, 'SECRET-REQUEST', { sessionId: 'own' }),
    snapshot(T0 + HOUR + MIN, ['src/inherited.ts']), delta(T0 + HOUR + 2 * MIN, 'own.ts')];
  const own = jsonl(ownRows);
  await fs.writeFile(file, jsonl(parentRows) + own);
  // Read from the start: the switch from the parent's rows to its own is seen, and the fork point is its first timed row.
  const whole = await readWorkLog(file, null, { ownIds: new Set(['own']) });
  assert.equal(whole.state.owner.forked, true);
  assert.equal(whole.state.owner.forkedAt, T0 + HOUR);
  assert.deepEqual(workLogOf(whole.state).edited.map(item => path.basename(item.path)), ['own.ts']);
  // Read from partway, past every copied row: the file's first rows still say it is a fork.
  const partial = await readWorkLog(file, null, { ownIds: new Set(['own']), limits: { firstBytes: Buffer.byteLength(own) + 10 } });
  assert.equal(partial.state.owner.forked, true);
  assert.deepEqual(workLogOf(partial.state).edited.map(item => path.basename(item.path)), ['own.ts']);
  // A transcript that is its own from its first row is not a fork, however far in a look starts.
  const plainFile = path.join(dir, 'plain.jsonl');
  await fs.writeFile(plainFile, jsonl(parentRows.map(row => ({ ...row, sessionId: 'own' }))) + own);
  const plain = await readWorkLog(plainFile, null, { ownIds: new Set(['own']), limits: { firstBytes: Buffer.byteLength(own) + 10 } });
  assert.equal(plain.state.owner.forked, false);
  assert.deepEqual(workLogOf(plain.state).edited.map(item => path.basename(item.path)).sort(), ['inherited.ts', 'own.ts']);
});

test('work log reader: a first look that starts at a snapshot past the fork point drops what the fork inherited', async t => {
  const dir = await tempDir(t);
  const src = `${HARBOR}/src`;
  const snapshot = (at, names) => ({ type: 'file-history-snapshot', messageId: `m-${at}`, isSnapshotUpdate: false,
    snapshot: { messageId: `m-${at}`, timestamp: iso(at), trackedFileBackups: Object.fromEntries(names.map(name => [name, { backupFileName: 'b', version: 3, backupTime: iso(at), realParentDir: src }])) } });
  const delta = (at, name) => ({ type: 'file-history-delta', messageId: `m-${at}`, trackingPath: name, backup: { backupFileName: 'b', version: 1, backupTime: iso(at), realParentDir: src }, timestamp: iso(at) });
  const parentRows = Array.from({ length: 30 }, (_, i) => say(T0 + i, `SECRET-${'p'.repeat(300)}`, { session: 'parent', stop: 'tool_use' }));
  const ownRows = [person(T0 + HOUR, 'SECRET-REQUEST', { sessionId: 'own' }), delta(T0 + HOUR + MIN, 'own.ts')];
  // The snapshot re-lists a file the fork inherited from its parent; the look starts exactly at it, so no row in the
  // window has said whose transcript this is when its entries arrive.
  const inherited = snapshot(T0 + 2 * HOUR, ['src/parent-file.js', 'src/own.ts']);
  for (const [name, tail, expected] of [
    ['then-own-row', jsonl([inherited, person(T0 + 2 * HOUR + MIN, 'SECRET-NEXT', { sessionId: 'own' })]), []],
    // Nothing after it names the session either: the entries held to the end of the pass are filtered all the same.
    ['snapshot-only', jsonl([inherited]), []],
  ]) {
    const file = path.join(dir, `${name}.jsonl`);
    await fs.writeFile(file, jsonl(parentRows) + jsonl(ownRows) + tail);
    const partial = await readWorkLog(file, null, { ownIds: new Set(['own']), limits: { firstBytes: Buffer.byteLength(tail) + 5 } });
    assert.equal(partial.state.owner.forked, true, name);
    assert.deepEqual(workLogOf(partial.state)?.edited ?? [], expected, name);
    // Read whole, the same file keeps only the fork's own delta.
    const whole = await readWorkLog(file, null, { ownIds: new Set(['own']) });
    assert.deepEqual(workLogOf(whole.state).edited.map(item => path.basename(item.path)), ['own.ts'], name);
  }
});

test('Claude reader: the newest sub-agent transcripts are read, whatever order the folder lists them in', async t => {
  const { repo, dir, reader } = await claudeHome(t);
  const now = Date.now();
  const id = '00000000-0000-4000-8000-000000000905';
  const line = (row, at) => ({ ...row, entrypoint: 'cli', cwd: repo, sessionId: id, timestamp: iso(at) });
  await fs.writeFile(path.join(dir, `${id}.jsonl`), jsonl([line(person(0, 'SECRET-REQUEST'), now - 40 * MIN)]));
  const helperDir = path.join(dir, id, 'subagents');
  await fs.mkdir(helperDir, { recursive: true });
  // Thirty sub-agents, each editing its own file, with their times shuffled against their names.
  const rank = i => ((i * 7) % 30) + 1;
  for (let i = 0; i < 30; i++) {
    const file = path.join(helperDir, `agent-h${String(i).padStart(2, '0')}.jsonl`);
    await fs.writeFile(file, jsonl(edit(now - 30 * MIN + i, path.join(repo, 'src', `f${i}.ts`), { sidechain: true, session: id })));
    const at = new Date(now - rank(i) * MIN);
    await fs.utimes(file, at, at);
  }
  const found = await find(reader({ workHelpers: 2 }), id);
  const newest = [...Array(30).keys()].filter(i => rank(i) <= 2).map(i => path.join(repo, 'src', `f${i}.ts`)).sort();
  assert.deepEqual(found.workLog.edited.map(item => item.path).sort(), newest);
});

test('Claude reader: a working session\'s sub-agents are read again while its own transcript stays the same', async t => {
  const { home, repo, dir } = await claudeHome(t);
  const now = Date.now();
  const id = '00000000-0000-4000-8000-000000000906';
  const pid = 4242;
  const lstart = 'Thu Sep 17 15:37:27 2026';
  // A live terminal session its registry reports as busy: it sits in one long Agent call.
  await fs.mkdir(path.join(home, '.claude', 'sessions'), { recursive: true });
  await fs.writeFile(path.join(home, '.claude', 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId: id, cwd: repo, startedAt: now - HOUR, procStart: lstart, kind: 'interactive', entrypoint: 'cli', status: 'busy', updatedAt: now - MIN, statusUpdatedAt: now - MIN }));
  const processes = new Map([[pid, { pid, ppid: 1, startedAt: Date.parse(`${lstart} UTC`), lstart, comm: '/opt/homebrew/bin/claude' }]]);
  const isAlive = (map, which, { lstart: started } = {}) => Boolean(map.get(which)) && (!started || map.get(which).lstart === started);
  const reader = createClaudeReader({ homeDir: home, processes, isAlive, readLocalStorageKeys: async () => new Map() });
  const line = (row, at) => ({ ...row, entrypoint: 'cli', cwd: repo, sessionId: id, timestamp: iso(at) });
  await fs.writeFile(path.join(dir, `${id}.jsonl`), jsonl([line(person(0, 'SECRET-REQUEST'), now - 20 * MIN), line(say(0, 'Starting the agent.', { stop: 'tool_use' }), now - 19 * MIN)]));
  const helper = path.join(dir, id, 'subagents', 'agent-a1.jsonl');
  await fs.mkdir(path.dirname(helper), { recursive: true });
  const side = { sidechain: true, session: id, cwd: repo };
  const bare = { extra: { toolUseResult: undefined } };
  const first = bash(now - 10 * MIN, 'git commit -q -m "SECRET-ONE"', side);
  await fs.writeFile(helper, jsonl([first.row, result(now - 10 * MIN + 400, first.id, { ...side, ...bare })]));
  const commits = found => found.workLog?.git.filter(item => item.kind === 'commit').length ?? 0;
  assert.equal(commits(await find(reader, id)), 1);
  // The sub-agent commits again; the session's own transcript does not change.
  const second = bash(Date.now(), 'git commit -q -m "SECRET-TWO"', side);
  await fs.appendFile(helper, jsonl([second.row, result(Date.now() + 400, second.id, { ...side, ...bare })]));
  let found = null;
  for (let i = 0; i < 4 && commits(found ?? {}) < 2; i++) found = await find(reader, id);
  assert.equal(commits(found), 2, 'the helper count\'s stats sent the session back for its sub-agents');
  assert.equal(reader.stats().workReads, 0, 'its own transcript was not read again');
  // Once read, nothing moves: the session is not opened again.
  await find(reader, id);
  await find(reader, id);
  assert.equal(reader.stats().workChecks, 0);
});

test('Claude reader: a session whose log is not read yet says so', async t => {
  const { repo, dir, reader } = await claudeHome(t);
  const now = Date.now();
  const ids = [1, 2].map(n => `00000000-0000-4000-8000-00000000091${n}`);
  for (const [index, id] of ids.entries()) {
    await fs.writeFile(path.join(dir, `${id}.jsonl`), jsonl([{ ...person(0, 'SECRET-REQUEST'), entrypoint: 'cli', cwd: repo, sessionId: id, timestamp: iso(now - (index + 1) * MIN) }]));
  }
  const one = reader({ workReads: 1 });
  let sessions = (await one.read({ recentMs: 86400000 })).sessions.filter(item => ids.includes(item.id));
  assert.deepEqual(sessions.map(item => [Boolean(item.workLog), item.workLogPending === true]).sort(), [[false, true], [true, false]]);
  sessions = (await one.read({ recentMs: 86400000 })).sessions.filter(item => ids.includes(item.id));
  assert.deepEqual(sessions.map(item => [Boolean(item.workLog), item.workLogPending === true]), [[true, false], [true, false]]);
  // Out of time before any transcript was opened: pending, not "nothing to say".
  const late = await find(reader({ workDeadlineMs: 0 }), ids[0]);
  assert.equal(late.workLog, undefined);
  assert.equal(late.workLogPending, true);
});
