import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createVisualGoals } from '../src/core/visual-goals.mjs';
import { createVisualWorkspace } from '../src/core/visual-workspace.mjs';
import { WORK_ITEM_TOOLS, validateWorkRequest } from '../src/core/work-item-protocol.mjs';

async function fixture(t, extra = {}) {
  const dir = await fs.mkdtemp('/private/tmp/summon-tree-data-');
  const goals = await createVisualGoals({ dataDir: dir });
  const state = { repos: ['a', 'b', 'c'].map(id => ({ id: `repo-${id}`, name: `Project ${id}`, path: path.join(dir, id), places: [{ id: `place-${id}`, kind: 'main', branch: 'main', label: 'Main folder' }], branches: [{ name: 'main' }] })), sessions: [], privacy: {}, scans: 0 };
  const service = await createVisualWorkspace({ goals, getWorkInFlight: async () => ({ repos: state.repos }),
    getAgentSessions: async () => ({ groups: [{ sessions: state.sessions }] }),
    getPrivatePaths: folder => state.privacy[folder] ?? [], scanRepository: async () => { state.scans++; throw new Error('The tree must not scan code or git diagrams.'); }, ...extra });
  t.after(async () => { await service.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const save = async (repoId, patch) => (await service.saveGoal({ repoId, ...patch })).at(-1);
  return { dir, goals, state, service, save };
}

test('explicit cross-project dependencies persist, reject global cycles, and gate work until confirmed done', async t => {
  const f = await fixture(t);
  let shared = await f.save('repo-b', { title: 'Shared API' });
  let consumer = await f.save('repo-a', { title: 'Use API', crossRepoDependsOn: [{ repoId: 'repo-b', goalId: shared.id }] });
  await assert.rejects(f.save('repo-b', { id: shared.id, expectedRevision: shared.revision, crossRepoDependsOn: [{ repoId: 'repo-a', goalId: consumer.id }] }), /cycle/);
  await assert.rejects(f.save('repo-a', { id: consumer.id, expectedRevision: consumer.revision, status: 'working' }), /Finish cross-project dependencies/);
  await assert.rejects(f.goals.save({ repoId: 'repo-a', id: consumer.id, expectedRevision: consumer.revision, status: 'done', completion: { kind: 'confirmed', summary: 'Verified' } }), /Finish dependencies/);
  shared = await f.save('repo-b', { id: shared.id, expectedRevision: shared.revision, status: 'done', completion: { kind: 'confirmed', summary: 'API behavior verified' } });
  consumer = await f.save('repo-a', { id: consumer.id, expectedRevision: consumer.revision, status: 'working' });
  assert.equal(consumer.status, 'working');
  assert.deepEqual(consumer.crossRepoDependsOn, [{ repoId: 'repo-b', goalId: shared.id }]);
  const reopened = await createVisualGoals({ dataDir: f.dir });
  assert.deepEqual(reopened.read('repo-a'), [consumer]);
  await reopened.close();
  const detail = await f.service.readWorkItems({ repoId: 'repo-a', id: consumer.id });
  assert.equal(detail.crossRepoDependencies[0].status, 'done');
  consumer = await f.save('repo-a', { id: consumer.id, expectedRevision: consumer.revision, status: 'done', completion: { kind: 'confirmed', summary: 'Consumer verified' } });
  await f.save('repo-b', { id: shared.id, expectedRevision: shared.revision, status: 'planned', completion: null });
  await assert.rejects(f.save('repo-a', { id: consumer.id, expectedRevision: consumer.revision, completion: { kind: 'confirmed', summary: 'Reconfirm after scope changed' } }), /Finish cross-project dependencies/);
});

test('cross-project reference identity, total bounds, and revisions are enforced', async t => {
  const f = await fixture(t);
  const other = await f.save('repo-b', { title: 'Other' });
  const item = await f.save('repo-a', { title: 'Item' });
  for (const crossRepoDependsOn of [
    [{ repoId: 'repo-missing', goalId: other.id }], [{ repoId: 'repo-b', goalId: 'missing' }],
    [{ repoId: 'repo-c', goalId: other.id }], [{ repoId: 'repo-a', goalId: item.id }],
    [{ repoId: 'repo-b', goalId: other.id, title: 'forged' }], Array(33).fill({ repoId: 'repo-b', goalId: other.id }),
  ]) await assert.rejects(f.save('repo-a', { id: item.id, expectedRevision: item.revision, crossRepoDependsOn }));
  const updated = await f.save('repo-a', { id: item.id, expectedRevision: item.revision, crossRepoDependsOn: [{ repoId: 'repo-b', goalId: other.id }] });
  await assert.rejects(f.save('repo-a', { id: item.id, expectedRevision: item.revision, nextStep: 'Stale edit' }), /revision/);
  assert.equal(updated.revision, item.revision + 1);
});

test('new child associations require the observed parent and child; historical pairs survive disappearance', async t => {
  const f = await fixture(t);
  f.state.sessions = [{ key: 'claude:terminal:parent', repoId: 'repo-a', children: [{ id: 'child-a', key: 'child-key', parentSessionKey: 'claude:terminal:parent', activity: 'working' }] }, { key: 'codex:desktop:other', repoId: 'repo-a', children: [] }];
  for (const links of [{ agentId: 'child-a' }, { sessionKey: 'claude:terminal:parent', agentId: 'forged' }, { sessionKey: 'codex:desktop:other', agentId: 'child-a' }]) await assert.rejects(f.save('repo-a', { title: 'Invalid association', links }), /reported child agent/);
  let item = await f.save('repo-a', { title: 'Legal review', links: { sessionKey: 'claude:terminal:parent', agentId: 'child-a' } });
  f.state.sessions[0].children[0].activity = 'ended';
  assert.equal((await f.service.readTree({ repoId: 'repo-a' })).goals[0].status, 'planned', 'child end is not task completion');
  await assert.rejects(f.save('repo-a', { id: item.id, expectedRevision: item.revision, links: { sessionKey: 'codex:desktop:other' } }), /reported child agent/);
  f.state.sessions = [];
  item = await f.save('repo-a', { id: item.id, expectedRevision: item.revision, links: { agentId: 'child-a', sessionKey: 'claude:terminal:parent' }, nextStep: 'Review returned findings' });
  assert.equal(item.links.agentId, 'child-a');
  assert.equal(item.status, 'planned');
  await assert.rejects(f.save('repo-a', { id: item.id, expectedRevision: item.revision, links: { sessionKey: null } }), /reported child agent|parent session/);
});

test('tree uses saved goals and observed sessions without code scans and scopes external dependencies to minimal stubs', async t => {
  const f = await fixture(t);
  const shared = await f.save('repo-b', { title: 'Shared API', findings: [{ id: 'secret-findings', text: 'Unrelated details must stay outside selected scope' }] });
  const own = await f.save('repo-a', { title: 'Use shared API', crossRepoDependsOn: [{ repoId: 'repo-b', goalId: shared.id }] });
  await f.save('repo-c', { title: 'Unrelated task' });
  f.state.sessions = [{ key: 'a', repoId: 'repo-a', title: 'Selected session', recentContext: { messages: ['Prompt not needed for the tree'] } }, { key: 'b', repoId: 'repo-b', title: 'External session' }, { key: 'unassigned', repoId: null, title: 'Unassigned session' }];
  const scoped = await f.service.readTree({ repoId: 'repo-a' });
  assert.deepEqual(scoped.repos.map(repo => repo.id), ['repo-a']);
  assert.deepEqual(scoped.goals.map(goal => goal.id), [own.id]);
  assert.deepEqual(scoped.sessions.map(session => session.key), ['a']);
  assert.deepEqual(scoped.externalGoals, [{ repoId: 'repo-b', id: shared.id, title: 'Shared API', status: 'planned' }]);
  assert.deepEqual(scoped.externalRepos, [{ id: 'repo-b', name: 'Project b' }]);
  assert.equal(JSON.stringify(scoped).includes('Unrelated'), false);
  assert.equal(JSON.stringify(scoped).includes('Prompt not needed'), false);
  const all = await f.service.readTree();
  assert.equal(all.repos.length, 3); assert.equal(all.goals.length, 3); assert.equal(all.sessions.length, 3);
  assert.ok(all.sessions.some(session => session.key === 'unassigned'));
  assert.deepEqual(all.externalGoals, []);
  assert.equal(f.state.scans, 0);
  for (const options of [{ repoId: 'missing' }, { path: '/arbitrary' }, { repoId: 1 }, null, []]) await assert.rejects(f.service.readTree(options));
  scoped.goals[0].title = 'Caller mutation';
  assert.equal(f.goals.read('repo-a')[0].title, 'Use shared API');
});

test('removed external projects retain references without exposing their goals and block new claims', async t => {
  const f = await fixture(t);
  const target = await f.save('repo-b', { title: 'External private title' });
  let item = await f.save('repo-a', { title: 'Waiting', crossRepoDependsOn: [{ repoId: 'repo-b', goalId: target.id }] });
  f.state.repos = f.state.repos.filter(repo => repo.id !== 'repo-b');
  item = await f.save('repo-a', { id: item.id, expectedRevision: item.revision, nextStep: 'Restore access to dependency' });
  assert.equal(item.crossRepoDependsOn.length, 1);
  const view = await f.service.readTree({ repoId: 'repo-a' });
  assert.equal(view.externalGoals.length, 0); assert.equal(view.externalRepos.length, 0);
  assert.equal(JSON.stringify(view).includes('External private title'), false);
  assert.ok(view.warnings.length);
  const detail = await f.service.readWorkItems({ repoId: 'repo-a', id: item.id });
  assert.equal(detail.crossRepoDependencies[0].availability, 'unavailable');
  await assert.rejects(f.save('repo-a', { id: item.id, expectedRevision: item.revision, status: 'working' }), /no longer available/);
  await assert.rejects(f.save('repo-a', { title: 'New reference', crossRepoDependsOn: item.crossRepoDependsOn }), /no longer available/);
});

test('tree masks private goal and child text and retries a scope change during session reads', async t => {
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  let first = true;
  const f = await fixture(t, { getAgentSessions: async () => {
    if (first) { first = false; entered(); await new Promise(resolve => { release = resolve; }); }
    return { groups: [{ sessions: [{ key: 'session-a', repoId: 'repo-a', title: 'private-area/report.txt', children: [{ id: 'child-a', key: 'child-key', label: 'private-area/report.txt' }] }] }] };
  } });
  await f.goals.save({ repoId: 'repo-a', title: 'private-area/report.txt' });
  const pending = f.service.readTree({ repoId: 'repo-a' });
  await waiting;
  f.state.privacy[f.state.repos[0].path] = ['private-area/'];
  release();
  const result = await pending;
  assert.equal(JSON.stringify(result).includes('private-area'), false);
  assert.equal(result.sessions[0].children[0].id, 'child-a');
  assert.equal(result.sessions[0].children[0].key, 'child-key');
});

test('work item protocol exposes explicit external dependencies and child IDs with complete section reads', async t => {
  const f = await fixture(t);
  const other = await f.save('repo-b', { title: 'Shared dependency' });
  const item = await f.save('repo-a', { title: 'Consumer', crossRepoDependsOn: [{ repoId: 'repo-b', goalId: other.id }] });
  const schema = WORK_ITEM_TOOLS.find(tool => tool.name === 'update_work_item').inputSchema.properties.item.properties;
  assert.equal(schema.links.properties.agentId.maxLength, 200);
  assert.equal(schema.crossRepoDependsOn.maxItems, 32);
  validateWorkRequest({ repoId: 'repo-a', id: item.id, section: 'crossRepoDependsOn' });
  assert.deepEqual((await f.service.readWorkItems({ repoId: 'repo-a', id: item.id, section: 'crossRepoDependsOn' })).items, item.crossRepoDependsOn);
});

test('MCP publishes bounded child metadata suitable for explicit task association, without arbitrary child fields', async t => {
  const dir = await fs.mkdtemp('/private/tmp/summon-tree-mcp-');
  const socket = path.join(dir, 's.sock');
  const children = Array.from({ length: 45 }, (_, index) => ({ key: `child-${index}`, id: `agent-${index}`, parentSessionKey: 'codex:desktop:parent', provider: 'codex', label: 'Research', activity: 'working', confidence: 'reported', transcript: 'Must not be shared' }));
  children.unshift({ ...children[0], key: 'invalid-child', id: 'a'.repeat(201) });
  const server = net.createServer(connection => connection.once('data', () => connection.end(JSON.stringify({ result: { groups: [{ id: 'working', title: 'Working', sessions: [{ key: 'codex:desktop:parent', repoId: 'repo-a', app: 'codex', title: 'Parent', children }] }], sources: [], warnings: [] } }))));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('close', resolve));
      child.kill();
      await exited;
    }
    await new Promise(resolve => server.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  });
  // A denied Unix socket must reject this test, not emit an unhandled error inside the test runner.
  await new Promise((resolve, reject) => {
    const failed = error => { server.off('listening', ready); reject(error); };
    const ready = () => { server.off('error', failed); resolve(); };
    server.once('error', failed); server.once('listening', ready); server.listen(socket);
  });
  child = spawn(process.execPath, [new URL('../scripts/mcp-server.mjs', import.meta.url).pathname], { env: { ...process.env, SUMMON_SOCKET: socket }, stdio: ['pipe', 'pipe', 'pipe'] });
  const response = new Promise((resolve, reject) => {
    let body = '';
    const timeout = setTimeout(() => reject(new Error('MCP timeout')), 5000);
    child.stdout.on('data', chunk => { body += chunk; if (body.includes('\n')) { clearTimeout(timeout); resolve(JSON.parse(body.slice(0, body.indexOf('\n')))); } });
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'agent_sessions', arguments: {} } })}\n`);
  const view = JSON.parse((await response).result.content[0].text);
  const parent = view.groups[0].sessions[0];
  assert.equal(parent.children[0].id, 'agent-0');
  assert.equal(parent.children[0].parentSessionKey, 'codex:desktop:parent');
  assert.equal(parent.childrenTotal, 46); assert.equal(parent.childrenTruncated, true);
  assert.ok(parent.children.length <= 40);
  assert.equal(JSON.stringify(view).includes('Must not be shared'), false);
  assert.ok(Buffer.byteLength(JSON.stringify(view)) <= 48_000);
});
