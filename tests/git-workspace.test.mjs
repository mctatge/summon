import test from 'node:test';
import assert from 'node:assert/strict';
import { getPlaceHistory, getPlaceStatus } from '../src/renderer/git-workspace.mjs';

const repo = { branches: [] };
const place = overrides => ({
  head: 'aaaa111', branch: 'main', detached: false, missing: false, error: null,
  upstream: 'origin/main', ahead: 0, behind: 0, filesTruncated: false,
  counts: { items: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, ...overrides,
});
const commit = (id, parents = []) => ({ id, parents, subject: id, at: null });
const graph = (commits, overrides = {}) => ({ commits, refs: [], truncated: false, error: null, ...overrides });

test('uncommitted item totals do not double-count overlapping staged and unstaged files', () => {
  const status = getPlaceStatus(repo, place({ counts: { items: 3, staged: 2, unstaged: 2, untracked: 1, conflicted: 0 } }));
  assert.equal(status.title, '3 uncommitted items');
  assert.match(status.detail, /^These edits are in this folder but are not included in a saved checkpoint/);
  assert.doesNotMatch(status.detail, /staged|unstaged/);
  assert.equal(status.tone, 'neutral');
});

test('failed and missing checkouts never look clean or synchronized from default zero counts', () => {
  for (const override of [{ error: 'Git timed out.' }, { missing: true }]) {
    const status = getPlaceStatus(repo, place(override));
    assert.equal(status.tone, 'attention');
    assert.equal(status.syncTitle, 'Comparison unavailable');
    assert.doesNotMatch(status.title, /No uncommitted/);
  }
  assert.equal(getPlaceStatus(repo, place({ error: 'Git timed out.' })).detail, 'Git timed out.');
  const repositoryFailure = getPlaceStatus({ ...repo, error: 'Repository scan failed.' }, place());
  assert.equal(repositoryFailure.title, 'Status could not be checked');
  assert.equal(repositoryFailure.detail, 'Repository scan failed.');
  assert.equal(repositoryFailure.tone, 'attention');
  assert.equal(repositoryFailure.syncTitle, 'Comparison unavailable');
});

test('conflicts and incomplete file listings remain explicit even with matching tracking state', () => {
  const conflict = getPlaceStatus(repo, place({ counts: { items: 2, staged: 0, unstaged: 0, untracked: 0, conflicted: 1 } }));
  assert.equal(conflict.title, '1 conflicting item needs attention');
  assert.equal(conflict.tone, 'attention');
  const truncated = getPlaceStatus(repo, place({ filesTruncated: true, counts: { items: 10, staged: 8, unstaged: 7, untracked: 2, conflicted: 0 } }));
  assert.equal(truncated.title, 'At least 10 uncommitted items');
  assert.match(truncated.detail, /lower bound/);
  assert.equal(truncated.tone, 'attention');
  const incompleteEmpty = getPlaceStatus(repo, place({ filesTruncated: true }));
  assert.doesNotMatch(incompleteEmpty.title, /No uncommitted/);
  assert.doesNotMatch(incompleteEmpty.detail, /no changed or new items/);
});

test('no upstream and unknown counts never imply that commits are published or synchronized', () => {
  const noUpstream = getPlaceStatus(repo, place({ upstream: null, ahead: null, behind: null }));
  assert.equal(noUpstream.syncTitle, 'No tracking branch configured');
  assert.match(noUpstream.syncDetail, /does not tell us whether these commits exist elsewhere/);
  assert.equal(noUpstream.tone, 'neutral');
  for (const override of [{ ahead: null }, { behind: null }, { ahead: 2, behind: null }]) {
    const unknown = getPlaceStatus(repo, place(override));
    assert.equal(unknown.syncTitle, 'Comparison unavailable');
    assert.equal(unknown.tone, 'neutral');
  }
});

test('tracking comparisons describe cached upstream counts without assuming GitHub or live updates', () => {
  const cases = [
    [0, 0, 'Committed history matches team/trunk', 'good', /same committed history\. Uncommitted changes are separate/],
    [2, 0, '2 commits ahead of team/trunk', 'neutral', /This folder has 2 commits absent from the locally recorded team\/trunk/],
    [0, 1, '1 commit behind team/trunk', 'attention', /locally recorded team\/trunk has 1 commit absent from this folder/],
    [2, 3, '2 ahead · 3 behind team/trunk', 'attention', /histories have diverged: this folder has 2 commits absent from the locally recorded team\/trunk, which has 3 commits absent from this folder/],
  ];
  for (const [ahead, behind, title, tone, explanation] of cases) {
    const status = getPlaceStatus(repo, place({ ahead, behind, upstream: 'team/trunk' }));
    assert.equal(status.syncTitle, title);
    assert.equal(status.tone, tone);
    assert.match(status.syncDetail, /team\/trunk/);
    assert.match(status.syncDetail, /does not fetch/);
    assert.match(status.syncDetail, explanation);
    assert.doesNotMatch(status.syncDetail, /GitHub/);
  }
});

test('a gone upstream is distinguished from a missing tracking configuration and stale branch metadata', () => {
  const withGone = { branches: [{ name: 'main', upstream: 'origin/main', upstreamGone: true }] };
  const status = getPlaceStatus(withGone, place({ ahead: null, behind: null }));
  assert.equal(status.syncTitle, 'Tracking branch unavailable');
  assert.match(status.syncDetail, /missing from the local snapshot/);
  assert.equal(status.tone, 'attention');
  assert.equal(getPlaceStatus(withGone, place({ upstream: 'other/main' })).syncTitle, 'Committed history matches other/main');
});

test('detached and unborn checkouts have precise descriptions without inventing a branch comparison', () => {
  const detached = getPlaceStatus(repo, place({ branch: null, detached: true, upstream: null, ahead: null, behind: null }));
  assert.equal(detached.syncTitle, 'Not on a branch');
  assert.match(detached.detail, /aaaa111/);
  assert.equal(detached.tone, 'neutral');
  const unborn = getPlaceStatus(repo, place({ head: null, upstream: null, ahead: null, behind: null }));
  assert.match(unborn.detail, /does not have a first commit yet/);
});

test('folder history follows every merge parent while preserving graph order and excluding other branches', () => {
  const commits = [commit('eeee5555', ['aaaa1111']), commit('dddd4444', ['cccc3333', 'bbbb2222']), commit('cccc3333', ['aaaa1111']), commit('bbbb2222', ['aaaa1111']), commit('aaaa1111')];
  const input = graph(commits);
  const before = structuredClone(input);
  const history = getPlaceHistory(input, place({ head: 'dddd444' }));
  assert.deepEqual(history.commits.map(item => item.id), ['dddd4444', 'cccc3333', 'bbbb2222', 'aaaa1111']);
  assert.equal(history.missingHead, false);
  assert.equal(history.partial, false);
  assert.deepEqual(input, before);
});

test('ambiguous or missing HEADs never fall back to unrelated project history', () => {
  const input = graph([commit('aaaa1111'), commit('aaaa2222'), commit('bbbb3333')]);
  for (const head of ['aaaa', 'cccc4444']) {
    assert.deepEqual(getPlaceHistory(input, place({ head })), { commits: [], missingHead: true, partial: true });
  }
  assert.deepEqual(getPlaceHistory(input, place({ head: 'aaaa1111' })).commits.map(item => item.id), ['aaaa1111']);
});

test('unborn checkout history is empty, whereas failed HEAD reads remain unavailable', () => {
  const input = graph([commit('bbbb2222')]);
  assert.deepEqual(getPlaceHistory(input, place({ head: null })), { commits: [], missingHead: false, partial: false });
  for (const override of [{ error: 'Status failed.' }, { missing: true }]) {
    assert.deepEqual(getPlaceHistory(input, place({ head: null, ...override })), { commits: [], missingHead: true, partial: true });
  }
});

test('missing parents, shallow or capped snapshots, and read errors mark history incomplete', () => {
  const commits = [commit('aaaa1111', ['bbbb2222'])];
  const absentParent = getPlaceHistory(graph(commits), place());
  assert.equal(absentParent.partial, true);
  assert.equal(absentParent.missingHead, false);
  assert.equal(absentParent.commits.length, 1);
  for (const override of [{ truncated: true }, { error: 'History read failed.' }]) {
    assert.equal(getPlaceHistory(graph([commit('aaaa1111')], override), place()).partial, true);
  }
  assert.equal(getPlaceHistory(graph([commit('aaaa1111')]), place({ error: 'Status failed.' })).partial, true);
});
