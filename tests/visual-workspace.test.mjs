import test from 'node:test';
import assert from 'node:assert/strict';
import { createVisualWorkspace } from '../src/core/visual-workspace.mjs';

const repo = { id: 'repo-a', path: '/project/a', places: [{ id: 'place-a', branch: 'main' }], branches: [{ name: 'main' }] };
const session = { key: 'claude:desktop:a', repoId: 'repo-a', appLabel: 'Claude' };
const graph = { repoId: repo.id, scannedAt: '2026-09-20T10:00:00Z', git: { commits: [], refs: [], truncated: false, error: null }, codebase: { nodes: [{ id: 'src/core' }], edges: [], truncated: false, error: null, mode: 'imports' } };
async function fixture(overrides = {}) {
  const calls = [];
  const saved = [];
  const store = {
    read: () => structuredClone(saved),
    save: async value => { saved.push(structuredClone(value)); return structuredClone(saved); },
    close: async () => {},
  };
  const service = await createVisualWorkspace({
    getWorkInFlight: async () => ({ repos: [structuredClone(repo)] }),
    getAgentSessions: async () => ({ groups: [{ sessions: [session, { ...session, key: 'other', repoId: 'repo-b' }] }] }),
    traceSession: async key => ({ sessionKey: key, events: [], truncated: false }),
    scanRepository: async options => { calls.push(options); return structuredClone(graph); },
    goals: store, ...overrides,
  });
  return { service, calls, saved, store };
}

test('visual reads resolve only registered repositories and exclude sessions in another repository', async () => {
  const { service, calls } = await fixture();
  await assert.rejects(service.read('/private/arbitrary'), /no longer available/);
  await assert.rejects(service.read(repo.id, { cwd: '/outside' }), /Invalid/);
  assert.equal(calls.length, 0);
  const view = await service.read(repo.id);
  assert.equal(calls[0].repo.path, '/project/a');
  assert.deepEqual(view.traces.map(trace => trace.sessionKey), [session.key]);
  await service.close();
});

test('a cached graph cannot keep a removed repository accessible', async () => {
  let registered = true;
  const { service } = await fixture({ getWorkInFlight: async () => ({ repos: registered ? [repo] : [] }) });
  await service.read(repo.id);
  registered = false;
  await assert.rejects(service.read(repo.id), /no longer available/);
  await service.close();
});

test('graph cache is isolated from caller mutation and invalidates when privacy scope changes', async () => {
  let paths = [];
  const { service, calls } = await fixture({ getPrivatePaths: () => paths });
  const first = await service.read(repo.id);
  first.codebase.nodes[0].id = 'corrupted';
  assert.equal((await service.read(repo.id)).codebase.nodes[0].id, 'src/core');
  assert.equal(calls.length, 1);
  paths = ['src/private/'];
  await service.read(repo.id);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].privatePaths, paths);
  await service.close();
});

test('overlapping reads share the expensive scan but return independent snapshots', async () => {
  let release;
  let count = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const { service } = await fixture({ scanRepository: async () => { count++; await gate; return structuredClone(graph); } });
  const first = service.read(repo.id);
  const second = service.read(repo.id, { refresh: true });
  await new Promise(resolve => setImmediate(resolve));
  release();
  const views = await Promise.all([first, second]);
  assert.equal(count, 1);
  views[0].codebase.nodes[0].id = 'changed';
  assert.equal(views[1].codebase.nodes[0].id, 'src/core');
  await service.close();
});

test('unavailable sessions do not prevent reading git, components and goals', async () => {
  const { service } = await fixture({ getAgentSessions: async () => { throw new Error('offline'); } });
  const view = await service.read(repo.id);
  assert.deepEqual(view.traces, []);
  assert.equal(view.codebase.nodes[0].id, 'src/core');
  assert.match(view.warnings.join(' '), /could not be refreshed/);
  await service.close();
});

test('a privacy change during a pending scan discards the old result before publication', async () => {
  let release;
  let paths = [];
  let scans = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const { service } = await fixture({
    getPrivatePaths: () => paths,
    scanRepository: async ({ privatePaths }) => {
      scans++;
      const nodes = privatePaths.length ? [] : [{ id: 'pilot' }];
      if (scans === 1) await gate;
      return { ...structuredClone(graph), codebase: { ...graph.codebase, nodes } };
    },
  });
  const view = service.read(repo.id);
  await new Promise(resolve => setImmediate(resolve));
  paths = ['pilot/']; release();
  assert.deepEqual((await view).codebase.nodes, []);
  assert.equal(scans, 2);
  await service.close();
});

test('a repository removed during a scan never publishes the pending graph', async () => {
  let registered = true;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { service } = await fixture({ getWorkInFlight: async () => ({ repos: registered ? [repo] : [] }), scanRepository: async () => { await gate; return graph; } });
  const view = service.read(repo.id);
  await new Promise(resolve => setImmediate(resolve));
  registered = false; release();
  await assert.rejects(view, /no longer available/);
  await service.close();
});

test('new goal associations must belong to the chosen repository', async () => {
  const { service, saved } = await fixture();
  for (const links of [{ placeId: 'place-b' }, { branch: 'elsewhere' }, { sessionKey: 'other' }, { component: 'unknown' }]) {
    await assert.rejects(service.saveGoal({ repoId: repo.id, title: 'Ship', links }), /this repository/);
  }
  assert.equal(saved.length, 0);
  await service.saveGoal({ repoId: repo.id, title: 'Ship', links: { placeId: 'place-a', branch: 'main', sessionKey: session.key, component: 'src/core' } });
  assert.equal(saved.length, 1);
  await service.close();
});

test('editing a goal preserves its old explicit link after the session disappears', async () => {
  const { service, saved } = await fixture();
  saved.push({ id: 'goal', repoId: repo.id, title: 'Ship', links: { sessionKey: 'old-session' } });
  await service.saveGoal({ id: 'goal', repoId: repo.id, title: 'Ship the review', links: { sessionKey: 'old-session' } });
  assert.equal(saved[1].links.sessionKey, 'old-session');
  await service.close();
  await assert.rejects(service.read(repo.id), /closing/);
});
