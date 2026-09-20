import test from 'node:test';
import assert from 'node:assert/strict';
import { ALL_PROJECTS, getSessionScopes, getVisualSessions, sessionScope } from '../src/renderer/visual-sessions.ts';

const session = (key, patch = {}) => ({ key, repoId: null, project: null, folder: null, activity: 'working', ...patch });
const view = (...groups) => ({ groups: groups.map((sessions, i) => ({ id: `group-${i}`, sessions })) });
const keys = sessions => sessions.map(item => item.key);

test('all projects includes cross-project, non-git, folder-only, and unattributed sessions', () => {
  const sessions = [
    session('alpha', { repoId: 'alpha', project: 'Alpha' }),
    session('beta', { repoId: 'beta', project: 'Beta' }),
    session('research', { project: 'Research notebook', folder: '~/Notes' }),
    session('scratch', { folder: '~/Scratch' }),
    session('unassigned'),
  ];
  const snapshot = view(sessions.slice(0, 2), sessions.slice(2));
  assert.equal(ALL_PROJECTS, 'all');
  assert.deepEqual(keys(getVisualSessions(snapshot)), keys(sessions));
  assert.deepEqual(keys(getVisualSessions(snapshot, ALL_PROJECTS)), keys(sessions));
  assert.deepEqual(getVisualSessions(null), []);
});

test('scope attribution uses exact repo, then project, then folder, without guessing', () => {
  assert.equal(sessionScope(session('repo', { repoId: 'opaque-id', project: 'Alpha', folder: '~/Alpha' })), 'repo:opaque-id');
  assert.equal(sessionScope(session('project', { project: 'Alpha', folder: '~/Alpha' })), 'project:Alpha');
  assert.equal(sessionScope(session('folder', { folder: '~/Alpha' })), 'folder:~/Alpha');
  assert.equal(sessionScope(session('unknown')), 'unassigned');
  assert.equal(sessionScope(session('empty', { repoId: '', project: '', folder: '' })), 'unassigned');
});

test('explicit filters do not merge similarly named repositories, projects, or folders', () => {
  const snapshot = view([
    session('repo', { repoId: 'Alpha', project: 'Alpha', folder: '~/Alpha' }),
    session('project', { project: 'Alpha', folder: '~/Alpha' }),
    session('folder', { folder: '~/Alpha' }),
    session('other-folder', { folder: '~/Alpha/subfolder' }),
    session('unknown'),
  ]);
  assert.deepEqual(keys(getVisualSessions(snapshot, 'repo:Alpha')), ['repo']);
  assert.deepEqual(keys(getVisualSessions(snapshot, 'project:Alpha')), ['project']);
  assert.deepEqual(keys(getVisualSessions(snapshot, 'folder:~/Alpha')), ['folder']);
  assert.deepEqual(keys(getVisualSessions(snapshot, 'unassigned')), ['unknown']);
  assert.deepEqual(getVisualSessions(snapshot, 'repo:missing'), []);
});

test('duplicate session keys keep the first reported row before scope filtering', () => {
  const original = session('same-session', { repoId: 'alpha', activity: 'open' });
  const duplicate = session('same-session', { repoId: 'beta', activity: 'needs-you' });
  const snapshot = view([original], [duplicate, session('another', { repoId: 'alpha' })]);
  assert.deepEqual(keys(getVisualSessions(snapshot)), ['another', 'same-session']);
  assert.equal(getVisualSessions(snapshot).find(item => item.key === 'same-session'), original);
  assert.deepEqual(getVisualSessions(snapshot, 'repo:beta'), []);
  assert.deepEqual(getSessionScopes([], [original, duplicate]).map(scope => scope.value), ['all', 'repo:alpha']);
});

test('attention and working sessions precede history with stable order inside each activity', () => {
  const input = [
    session('quiet', { activity: 'quiet' }), session('working-first'),
    session('open', { activity: 'open' }), session('failed', { activity: 'failed' }),
    session('unknown', { activity: 'unknown' }), session('needs-second', { activity: 'needs-you' }),
    session('working-second'), session('interrupted', { activity: 'interrupted' }),
    session('needs-third', { activity: 'needs-you' }),
  ];
  const snapshot = view([session('needs-first', { activity: 'needs-you' })], Object.freeze(input));
  assert.deepEqual(keys(getVisualSessions(snapshot)), [
    'needs-first', 'needs-second', 'needs-third', 'failed', 'working-first', 'working-second',
    'open', 'interrupted', 'quiet', 'unknown',
  ]);
  assert.equal(input[0].key, 'quiet', 'the source group must not be reordered');
});

test('scope options retain configured empty repositories and session-only contexts', () => {
  const repos = [{ id: 'alpha', name: 'Alpha' }, { id: 'empty', name: 'No sessions yet' }];
  const sessions = [
    session('known', { repoId: 'alpha', project: 'Different source label' }),
    session('non-git', { project: 'Alpha', folder: '~/Alpha' }),
    session('folder', { folder: '~/Scratch' }),
    session('unassigned'),
    session('missing-repo', { repoId: 'missing', project: 'Archived project' }),
    session('same-project', { project: 'Alpha', folder: '~/Elsewhere' }),
  ];
  assert.deepEqual(getSessionScopes(repos, sessions), [
    { value: 'all', label: 'All projects', repoId: null },
    { value: 'repo:alpha', label: 'Alpha', repoId: 'alpha' },
    { value: 'repo:empty', label: 'No sessions yet', repoId: 'empty' },
    { value: 'project:Alpha', label: 'Alpha', repoId: null },
    { value: 'folder:~/Scratch', label: '~/Scratch', repoId: null },
    { value: 'unassigned', label: 'Unassigned sessions', repoId: null },
    { value: 'repo:missing', label: 'Archived project', repoId: 'missing' },
  ]);
});

test('no git repositories are required to expose every session scope', () => {
  const sessions = [
    session('notes', { project: 'Notes' }), session('folder', { folder: '~/Documents' }),
    session('unknown'), session('unlisted', { repoId: 'opaque-repo' }),
  ];
  const scopes = getSessionScopes([], sessions);
  assert.deepEqual(scopes.map(scope => scope.value), ['all', 'project:Notes', 'folder:~/Documents', 'unassigned', 'repo:opaque-repo']);
  for (const item of sessions) assert.ok(scopes.some(scope => scope.value === sessionScope(item)));
  assert.deepEqual(getSessionScopes([], []), [{ value: 'all', label: 'All projects', repoId: null }]);
});
