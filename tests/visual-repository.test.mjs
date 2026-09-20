import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { scanVisualRepository } from '../src/core/visual-repository.mjs';
import { run } from '../src/main/process.mjs';
import { setSealedSegments } from '../src/core/workstreams.mjs';

const GIT = '/usr/bin/git';
const write = async (file, value) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, value); };

async function fixture(t, name = 'repo') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'summon-visual-repo-')));
  const home = path.join(root, 'home');
  const folder = path.join(root, name);
  await fs.mkdir(home);
  await fs.mkdir(folder);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { HOME: home, PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => execFileSync(GIT, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: folder, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '.');
  const repo = { id: 'repo-test', path: folder, places: [{ path: folder, files: [] }], branches: [] };
  const scan = extra => scanVisualRepository({ repo, run, env, ...extra });
  const commit = subject => { git('add', '-A'); git('commit', '-qm', subject); return git('rev-parse', 'HEAD').trim(); };
  return { root, home, folder, env, git, repo, scan, commit };
}

test('local history preserves actual merge parents, annotated tags and remote-tracking refs without mutating git', async t => {
  const f = await fixture(t);
  await write(path.join(f.folder, 'src/core/root.mjs'), 'export const root = true;');
  const first = f.commit('First');
  f.git('checkout', '-qb', 'feature');
  await write(path.join(f.folder, 'feature.txt'), 'feature');
  const feature = f.commit('Feature');
  f.git('checkout', '-q', 'main');
  await write(path.join(f.folder, 'main.txt'), 'main');
  const main = f.commit('Main');
  f.git('merge', '--no-ff', '-qm', 'Merge feature', 'feature');
  const merge = f.git('rev-parse', 'HEAD').trim();
  f.git('tag', '-a', 'v1', '-m', 'Release');
  f.git('update-ref', 'refs/remotes/origin/main', first);
  const index = await fs.stat(path.join(f.folder, '.git/index'), { bigint: true });
  const result = await f.scan();
  assert.equal(result.repoId, f.repo.id);
  assert.equal(result.git.error, null);
  assert.equal(result.git.truncated, false);
  assert.equal(result.git.commits[0].id, merge);
  assert.deepEqual(result.git.commits[0].parents, [main, feature]);
  assert.equal(result.git.commits.at(-1).id, first);
  assert.ok(result.git.commits.every(commit => commit.at && Number.isFinite(Date.parse(commit.at))));
  assert.ok(result.git.refs.some(ref => ref.name === 'v1' && ref.kind === 'tag' && ref.commitId === merge));
  assert.ok(result.git.refs.some(ref => ref.name === 'origin/main' && ref.kind === 'remote' && ref.commitId === first));
  assert.ok(result.git.refs.some(ref => ref.kind === 'head' && ref.commitId === merge));
  const after = await fs.stat(path.join(f.folder, '.git/index'), { bigint: true });
  assert.equal(after.mtimeNs, index.mtimeNs);
  assert.equal(after.ctimeNs, index.ctimeNs);
  const bounded = await f.scan({ limits: { commits: 1 } });
  assert.equal(bounded.git.commits.length, 1);
  assert.equal(bounded.git.truncated, true);
  assert.deepEqual(bounded.git.commits[0].parents, [main, feature], 'boundary parent OIDs remain truthful');
});

test('directory map derives relative imports, re-exports, require and literal dynamic imports without interpreting text as code', async t => {
  const f = await fixture(t);
  await write(path.join(f.folder, 'src/core/core.ts'), 'export const core = 1;');
  await write(path.join(f.folder, 'src/main/main.mjs'), [
    'import { core } from "../core/core.js";',
    'export { core } from "../core/core.js";',
    'const coreAgain = require("../core/core.js");',
    'const lazy = import("../core/core.js");',
    'import "node:fs";',
    '// import "../../fake/comment.js";',
    '/* require("../../fake/comment.js") */',
    'const text = \'import "../../fake/comment.js"\';',
    'const template = `import "../../fake/comment.js"`;',
    'const pattern = /import "..\\/..\\/fake\\/comment.js"/;',
    'const unknown = import(variable);',
    'import alias from "@core/core";'
  ].join('\n'));
  await write(path.join(f.folder, 'src/renderer/index.tsx'), 'export { core } from "../core/core.js";');
  await write(path.join(f.folder, 'fake/comment.js'), 'export default true;');
  await write(path.join(f.folder, 'docs/guide.md'), '# Guide');
  await write(path.join(f.folder, 'README.md'), '# Repository');
  f.commit('Files');
  f.repo.places[0].files = [{ path: 'src/main/main.mjs', private: false, isDir: false }, { path: 'src/core/core.ts', private: false, isDir: false }];
  const result = await f.scan();
  assert.equal(result.codebase.error, null);
  assert.equal(result.codebase.note, null);
  assert.equal(result.codebase.mode, 'imports');
  assert.deepEqual(result.codebase.edges, [{ source: 'src/main', target: 'src/core', count: 1 }, { source: 'src/renderer', target: 'src/core', count: 1 }]);
  assert.equal(result.codebase.nodes.find(node => node.id === 'src/main').changed, 1);
  assert.equal(result.codebase.nodes.find(node => node.id === 'docs').files, 1);
  assert.ok(result.codebase.nodes.some(node => node.id === '.'));
  assert.equal(result.codebase.truncated, false);
});

test('private, generated, vendor and symlinked paths never enter the file map or import graph', async t => {
  const f = await fixture(t);
  for (const file of ['src/main/main.js', 'src/core/core.js', 'pilot/hidden.js', 'secrets/key.js', '.env', 'vendor/library.js', 'node_modules/pkg/index.js', 'dist/generated.js', 'docs/people/contact.js', 'src/moved/a.js']) await write(path.join(f.folder, file), 'export default true;');
  await write(path.join(f.folder, 'src/main/main.js'), 'import "../../pilot/hidden.js"; import "../core/core.js"; import "../moved/a.js"; import "../../outside.js";');
  const outside = path.join(f.root, 'outside');
  await write(path.join(outside, 'a.js'), 'import "../../src/core/core.js";');
  await fs.symlink(path.join(outside, 'a.js'), path.join(f.folder, 'outside.js'));
  f.commit('Files');
  await fs.rm(path.join(f.folder, 'src/moved'), { recursive: true });
  await fs.symlink(outside, path.join(f.folder, 'src/moved'));
  const result = await f.scan({ privatePaths: ['pilot/'] });
  assert.deepEqual(result.codebase.nodes.map(node => node.id), ['src/core', 'src/main']);
  assert.deepEqual(result.codebase.edges, [{ source: 'src/main', target: 'src/core', count: 1 }]);
  assert.equal(result.codebase.error, null);
  f.repo.places[0].files = [{ path: 'src/core/core.js', private: true, isDir: false }];
  const withheld = await f.scan({ privatePaths: ['pilot/'] });
  assert.deepEqual(withheld.codebase.nodes.map(node => node.id), ['src/main'], 'Wif privacy metadata also withholds renamed private content');
});

test('empty repositories and unsupported languages retain a usable map with a note, not an error', async t => {
  const f = await fixture(t);
  const empty = await f.scan();
  assert.deepEqual(empty.git, { commits: [], refs: [], truncated: false, error: null });
  assert.equal(empty.codebase.error, null);
  assert.match(empty.codebase.note, /No readable tracked JS\/TS/);
  await write(path.join(f.folder, 'native/main.swift'), 'print("hello")');
  f.commit('Native app');
  const native = await f.scan();
  assert.equal(native.codebase.error, null);
  assert.equal(native.codebase.nodes[0].id, 'native');
  assert.equal(native.codebase.nodes[0].files, 1);
  assert.match(native.codebase.note, /without import connections/);
});

test('file, source and ref bounds explicitly mark partial output; deleted tracked files still count', async t => {
  const f = await fixture(t);
  await write(path.join(f.folder, 'src/core/core.js'), 'export default true;');
  await write(path.join(f.folder, 'src/main/main.js'), 'import "../core/core.js";');
  await write(path.join(f.folder, 'src/main/deleted.js'), 'export default true;');
  f.commit('Source');
  f.git('branch', 'other');
  await fs.rm(path.join(f.folder, 'src/main/deleted.js'));
  f.repo.places[0].files = [{ path: 'src/main/deleted.js', private: false, isDir: false }];
  const full = await f.scan();
  assert.deepEqual(full.codebase.nodes.find(node => node.id === 'src/main'), { id: 'src/main', label: 'src/main', path: 'src/main', files: 2, changed: 1 });
  const bounded = await f.scan({ limits: { files: 1, refs: 1 } });
  assert.equal(bounded.codebase.truncated, true);
  assert.equal(bounded.git.truncated, true);
  assert.equal(bounded.codebase.nodes.length, 1);
  const large = await f.scan({ limits: { fileBytes: 1 } });
  assert.equal(large.codebase.truncated, true);
  assert.equal(large.codebase.error, null);
  assert.deepEqual(large.codebase.edges, []);
});

test('repository names, refs and text cannot inject commands; inherited git settings and credentials are stripped', async t => {
  const f = await fixture(t, 'repo; touch injected');
  const marker = path.join(f.root, 'executed');
  await write(path.join(f.folder, 'src/main.js'), 'export default true;');
  f.commit('subject\x1fwith separators $(touch executed)');
  f.git('branch', 'evil;touch');
  await write(path.join(f.folder, '.git/hooks/post-checkout'), `#!/bin/sh\ntouch '${marker}'\n`);
  await fs.chmod(path.join(f.folder, '.git/hooks/post-checkout'), 0o755);
  f.git('config', 'core.fsmonitor', `touch '${marker}'`);
  f.git('config', 'diff.external', `touch '${marker}'`);
  const calls = [];
  const captured = async (binary, args, options) => { calls.push({ binary, args, options }); return run(binary, args, options); };
  const result = await f.scan({ run: captured, env: { ...f.env, GIT_DIR: '/outside', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'bad', ANTHROPIC_API_KEY: 'must-not-pass', OPENAI_API_KEY: 'must-not-pass' } });
  assert.equal(result.git.error, null);
  assert.ok(result.git.commits[0].subject.includes('with separators'));
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  for (const call of calls) {
    assert.equal(call.binary, GIT);
    assert.ok(call.args.includes('core.fsmonitor=false'));
    assert.ok(call.args.includes('core.hooksPath=/dev/null'));
    assert.equal(call.options.env.GIT_NO_LAZY_FETCH, '1');
    assert.equal(call.options.env.GIT_DIR, undefined);
    assert.equal(call.options.env.GIT_CONFIG_COUNT, undefined);
    assert.equal(call.options.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(call.options.env.OPENAI_API_KEY, undefined);
    assert.ok(call.options.timeout > 0 && call.options.timeout <= 5000);
    assert.ok(call.options.maxBytes <= 2 * 1024 * 1024);
    assert.ok(!call.args.includes('fetch') && !call.args.includes('diff') && !call.args.includes('status'));
  }
});

test('nested, borrowed and sealed repositories fail before invoking git', async t => {
  const f = await fixture(t);
  const nested = path.join(f.folder, 'src');
  await fs.mkdir(nested);
  let calls = 0;
  const noRun = async () => { calls++; throw new Error('must not run'); };
  const inside = await f.scan({ repo: { ...f.repo, path: nested }, run: noRun });
  assert.match(inside.git.error, /owning repository/);
  await write(path.join(f.folder, '.git/objects/info/alternates'), '/outside/objects');
  const borrowed = await f.scan({ run: noRun });
  assert.match(borrowed.git.error, /owning repository/);
  await fs.rm(path.join(f.folder, '.git/objects/info/alternates'));
  setSealedSegments(['summon-visual-repo']);
  t.after(() => setSealedSegments([]));
  const sealed = await f.scan({ run: noRun });
  assert.match(sealed.git.error, /owning repository/);
  assert.equal(calls, 0);
  setSealedSegments([]);
});

test('read failures are sanitized and one failed view does not discard the other', async t => {
  const f = await fixture(t);
  await write(path.join(f.folder, 'src/main.js'), 'export default true;');
  f.commit('Source');
  const partial = await f.scan({ run: async (binary, args, options) => {
    if (args.includes('log')) throw new Error('The operation timed out. secret/path');
    return run(binary, args, options);
  } });
  assert.match(partial.git.error, /took too long/);
  assert.ok(!partial.git.error.includes('secret/path'));
  assert.equal(partial.git.truncated, true);
  assert.equal(partial.codebase.error, null);
  assert.equal(partial.codebase.nodes.length, 1);
});

test('shallow history is explicitly incomplete even when fewer than the commit limit are present', async t => {
  const f = await fixture(t);
  await write(path.join(f.folder, 'README.md'), '# First');
  f.commit('First');
  await write(path.join(f.folder, 'README.md'), '# Second');
  const tip = f.commit('Second');
  await fs.writeFile(path.join(f.folder, '.git/shallow'), `${tip}\n`);
  const result = await f.scan();
  assert.equal(result.git.error, null);
  assert.equal(result.git.commits.length, 1);
  assert.equal(result.git.truncated, true);
});
