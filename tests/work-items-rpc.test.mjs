import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createVisualWorkspace } from '../src/core/visual-workspace.mjs';
import { createRpcServer } from '../src/main/rpc.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp('/private/tmp/summon-work-records-');
  const repo = { id: 'repo-a', name: 'Example', path: dir, places: [], branches: [] };
  let sessions = [{ key: 'codex:desktop:one', repoId: repo.id, activity: { state: 'working' } }, { key: 'claude:terminal:two', repoId: repo.id }];
  let privatePaths = [], available = true;
  const workspace = await createVisualWorkspace({ dataDir: dir,
    getWorkInFlight: async () => ({ repos: available ? [repo] : [] }),
    getAgentSessions: async () => ({ groups: [{ sessions }] }), getPrivatePaths: () => privatePaths,
    traceSession: async () => ({}), scanRepository: async () => ({ codebase: { nodes: [] } }),
  });
  const socket = path.join(dir, 'rpc.sock');
  const close = await createRpcServer({ snapshot: () => ({}) }, socket, { workRecords: workspace });
  const child = spawn(process.execPath, ['scripts/mcp-server.mjs'], { env: { ...process.env, SUMMON_SOCKET: socket }, stdio: ['pipe', 'pipe', 'pipe'] });
  let next = 0, buffer = '', stderr = '';
  const pending = new Map();
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n'), value = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
      const request = pending.get(value.id);
      if (request) { clearTimeout(request.timer); pending.delete(value.id); request.resolve(value); }
    }
  });
  t.after(async () => {
    child.kill();
    for (const value of pending.values()) clearTimeout(value.timer);
    await close(); await workspace.close(); await fs.rm(dir, { recursive: true, force: true });
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${stderr}`)); }, 5000);
    pending.set(id, { resolve, timer }); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const call = async (name, args) => {
    const response = await request('tools/call', { name, arguments: args });
    if (response.error) throw new Error(response.error.message);
    if (response.result.isError) throw new Error(response.result.content[0].text);
    return JSON.parse(response.result.content[0].text);
  };
  return { workspace, call, request, repo, dir, hideSessions: () => { sessions = []; }, removeRepo: () => { available = false; }, privatePaths: value => { privatePaths = value; } };
}

test('agents checkpoint durable work, discover settled findings and resume after session disappearance', async t => {
  const f = await fixture(t);
  const tools = (await f.request('tools/list')).result.tools;
  assert.equal(tools.find(tool => tool.name === 'work_items').annotations.readOnlyHint, true);
  assert.equal(tools.find(tool => tool.name === 'update_work_item').annotations.readOnlyHint, false);
  const saved = await f.call('update_work_item', { repoId: f.repo.id, reportingSessionKey: 'codex:desktop:one', item: {
    title: 'Route using healthy versions', status: 'working', ownerSessionKey: 'codex:desktop:one',
    acceptanceCriteria: 'Reject unhealthy versions while preserving a supported fallback.',
    checklist: [{ id: 'health', text: 'Integrate health readings', done: false }],
    findings: [{ id: 'catalog', text: 'Catalog chooses available versions.', evidence: 'catalog.test.mjs passed', revisitWhen: 'Catalog contract changes' }],
    nextStep: 'Implement the health adapter.', scopePaths: ['src/main/model-selection.mjs'], coordinationKeys: ['route contract'],
  } });
  assert.equal(saved.revision, 1);
  const detail = await f.call('work_items', { repoId: f.repo.id, id: saved.id });
  assert.equal(detail.item.findings[0].text, 'Catalog chooses available versions.');
  assert.equal(detail.owner.availability, 'visible');
  f.hideSessions();
  const stale = await f.call('work_items', { repoId: f.repo.id, id: saved.id });
  assert.equal(stale.owner.availability, 'unavailable');
  assert.equal(stale.item.status, 'working');
  assert.equal(stale.item.ownerSessionKey, 'codex:desktop:one');
  const receipt = await f.call('update_work_item', { repoId: f.repo.id, reportingSessionKey: 'codex:desktop:one', item: {
    id: saved.id, expectedRevision: saved.revision, status: 'needs-verification', nextStep: 'Exercise the fallback in the app.',
    checklist: [{ id: 'health', text: 'Integrate health readings', done: true }],
    completion: { kind: 'reported', summary: 'Adapter and unit tests complete.', reference: 'health.test.mjs' },
  } });
  assert.equal(receipt.status, 'needs-verification');
  const final = (await f.call('work_items', { repoId: f.repo.id, id: saved.id })).item;
  assert.equal(final.findings.length, 1);
  assert.equal(final.history.length, 2);
  assert.deepEqual(final.sessionKeys, ['codex:desktop:one']);
  const stored = JSON.parse(await fs.readFile(path.join(f.dir, 'visual-goals.json'), 'utf8'));
  assert.equal(stored.version, 2);
  assert.equal(stored.goals[0].nextStep, final.nextStep);
  const [released] = await f.workspace.saveGoal({ repoId: f.repo.id, id: final.id, expectedRevision: final.revision, ownerSessionKey: null });
  await assert.rejects(f.call('update_work_item', { repoId: f.repo.id, reportingSessionKey: 'codex:desktop:one', item: { id: final.id, expectedRevision: released.revision, ownerSessionKey: 'codex:desktop:one' } }), /session in this repository/);
});

test('RPC cannot impersonate user confirmation, replace an owner, bypass revisions or write unknown fields', async t => {
  const f = await fixture(t);
  const first = await f.call('update_work_item', { repoId: f.repo.id, reportingSessionKey: 'codex:desktop:one', item: { title: 'Original', ownerSessionKey: 'codex:desktop:one', status: 'working' } });
  const update = (item, reportingSessionKey = 'codex:desktop:one') => f.call('update_work_item', { repoId: f.repo.id, reportingSessionKey, item: { id: first.id, expectedRevision: first.revision, ...item } });
  await assert.rejects(update({ title: 'Lost update' }, 'claude:terminal:two'), /owning session/);
  await assert.rejects(update({ ownerSessionKey: 'claude:terminal:two' }), /owner|reassign/i);
  await assert.rejects(update({ status: 'done', completion: { kind: 'confirmed', summary: 'Trust me', reference: '' } }), /confirm|verification|done/i);
  await assert.rejects(update({ actor: 'user' }), /Unexpected work item field/);
  await assert.rejects(update({ repoId: 'other' }), /Unexpected work item field/);
  await assert.rejects(f.call('update_work_item', { repoId: f.repo.id, item: { title: 'Unknown session', ownerSessionKey: 'unknown' }, reportingSessionKey: 'unknown' }), /session in this repository/);
  await update({ nextStep: 'New checkpoint' });
  await assert.rejects(update({ nextStep: 'Stale checkpoint' }), /revision|changed|stale/i);
  assert.equal((await f.call('work_items', { repoId: f.repo.id, id: first.id })).item.nextStep, 'New checkpoint');
});

test('MCP checkpoints append evidence and preserve task identity through the public RPC boundary', async t => {
  const f = await fixture(t);
  const saved = await f.call('update_work_item', { repoId: f.repo.id, reportingSessionKey: 'codex:desktop:one', item: {
    title: 'Ship verified capture', ownerSessionKey: 'codex:desktop:one', status: 'working',
    findings: [{ id: 'existing-finding', text: 'Earlier capture behavior is understood.', evidence: 'capture.test.mjs', revisitWhen: 'The capture protocol changes.' }],
    evidence: [{ id: 'existing-proof', summary: 'Earlier behavior was checked.', reference: 'capture.test.mjs' }],
  } });
  const request = { repoId: f.repo.id, id: saved.id, expectedRevision: saved.revision, reportingSessionKey: 'codex:desktop:one', checkpoint: {
    id: 'capture-milestone', summary: 'The reader now retains the capture timestamp.', reference: 'reader.test.mjs',
    nextStep: 'Verify physical capture in the installed app.', status: 'needs-verification',
    findings: [{ id: 'timestamp-retained', text: 'Capture timestamps survive reload.', evidence: 'reader.test.mjs', revisitWhen: 'The record schema changes.' }],
    completion: { kind: 'reported', summary: 'Reader implementation and reload checks passed; physical input remains unverified.', reference: 'reader.test.mjs' },
  } };
  await assert.rejects(f.call('checkpoint_work_item', { ...request, actor: 'user' }), /Invalid checkpoint request/);
  await assert.rejects(f.call('checkpoint_work_item', { ...request, checkpoint: { ...request.checkpoint, status: 'done' } }), /confirm done/);
  await assert.rejects(f.call('checkpoint_work_item', { ...request, reportingSessionKey: 'claude:terminal:two' }), /owning session|owner/i);
  const receipt = await f.call('checkpoint_work_item', request);
  assert.equal(receipt.saved, true);
  assert.equal(receipt.id, saved.id);
  assert.equal(receipt.checkpointId, 'capture-milestone');
  assert.equal(receipt.revision, saved.revision + 1);
  const detail = (await f.call('work_items', { repoId: f.repo.id, id: saved.id })).item;
  assert.equal(detail.title, 'Ship verified capture');
  assert.equal(detail.status, 'needs-verification');
  assert.equal(detail.nextStep, request.checkpoint.nextStep);
  assert.deepEqual(detail.findings.map(row => row.id), ['existing-finding', 'timestamp-retained']);
  assert.deepEqual(detail.evidence.map(row => row.id), ['existing-proof', 'capture-milestone']);
  await assert.rejects(f.call('checkpoint_work_item', request), /changed|revision|already|duplicate/i);
  const after = (await f.call('work_items', { repoId: f.repo.id, id: saved.id })).item;
  assert.equal(after.revision, receipt.revision);
});

test('work overview is paginated, includes closed work and masks newly private text in every detail field', async t => {
  const f = await fixture(t);
  const [done] = await f.workspace.saveGoal({ repoId: f.repo.id, title: 'Completed investigation', status: 'done',
    completion: { kind: 'confirmed', summary: 'Checked the result.', reference: 'pilot-alpha/proof.txt' },
    findings: [{ id: 'settled', text: 'Result is settled', evidence: 'pilot-alpha/proof.txt', revisitWhen: 'pilot-alpha/proof.txt changes' }],
  });
  await f.workspace.saveGoal({ repoId: f.repo.id, title: 'Deferred follow-up', status: 'deferred' });
  const page = await f.call('work_items', { repoId: f.repo.id, limit: 1 });
  assert.equal(page.total, 2); assert.equal(page.items.length, 1); assert.equal(page.nextOffset, 1);
  const next = await f.call('work_items', { repoId: f.repo.id, offset: page.nextOffset, limit: 1 });
  assert.equal(next.nextOffset, null);
  assert.deepEqual([page.items[0].status, next.items[0].status].sort(), ['deferred', 'done']);
  f.privatePaths(['pilot-alpha/']);
  const detail = await f.call('work_items', { repoId: f.repo.id, id: done.id });
  assert.equal(JSON.stringify(detail).includes('pilot-alpha'), false);
  assert.ok(detail.withheldFields.includes('findings'));
  await assert.rejects(f.call('update_work_item', { repoId: f.repo.id, item: { id: done.id, expectedRevision: detail.item.revision, findings: detail.item.findings } }), /withheld/);
  f.removeRepo();
  await assert.rejects(f.call('work_items', { repoId: f.repo.id, id: done.id }), /no longer available/);
});

test('agent claims serialize across explicit serial constraints and shared interfaces', async t => {
  const f = await fixture(t);
  const first = await f.call('update_work_item', { repoId: f.repo.id, reportingSessionKey: 'codex:desktop:one', item: {
    title: 'Routing policy', status: 'working', ownerSessionKey: 'codex:desktop:one', coordinationKeys: ['routing contract'],
  } });
  await assert.rejects(f.call('update_work_item', { repoId: f.repo.id, reportingSessionKey: 'claude:terminal:two', item: {
    title: 'Effort implementation', status: 'working', ownerSessionKey: 'claude:terminal:two', coordinationKeys: ['routing contract'],
  } }), /conflict|routing contract|Routing policy/i);
  const second = await f.call('update_work_item', { repoId: f.repo.id, item: { title: 'Deferred parallel task', serialWith: [first.id] } });
  const detail = await f.call('work_items', { repoId: f.repo.id, id: second.id });
  assert.equal(detail.conflicts[0].id, first.id);
  assert.equal(detail.item.status, 'planned');
});

test('opaque task identities survive redaction while authored row IDs remain filtered', async t => {
  const f = await fixture(t);
  const syntheticToken = `sk-ant-${'a'.repeat(40)}`;
  const [record] = await f.workspace.saveGoal({ repoId: f.repo.id, title: 'Check provenance', evidence: [{ id: syntheticToken, summary: 'A synthetic credential-shaped row id.', reference: '' }] });
  const detail = await f.call('work_items', { repoId: f.repo.id, id: record.id });
  assert.equal(detail.item.id, record.id);
  assert.equal(JSON.stringify(detail).includes(syntheticToken), false);
  assert.ok(detail.withheldFields.includes('evidence'));
});

test('concurrent create receipts identify their own work and large valid array checkpoints survive transport', async t => {
  const f = await fixture(t);
  const results = await Promise.all(['First', 'Second'].map(title => f.call('update_work_item', { repoId: f.repo.id, item: { title } })));
  assert.notEqual(results[0].id, results[1].id);
  for (const [index, receipt] of results.entries()) assert.equal((await f.call('work_items', { repoId: f.repo.id, id: receipt.id })).item.title, ['First', 'Second'][index]);
  const findings = Array.from({ length: 25 }, (_, index) => ({ id: `finding-${index}`, text: 'A finding. '.repeat(80), evidence: 'A test result. '.repeat(60), revisitWhen: 'When the contract changes.' }));
  const receipt = await f.call('update_work_item', { repoId: f.repo.id, item: { id: results[0].id, expectedRevision: results[0].revision, findings } });
  assert.equal(receipt.revision, 2);
  const handoff = await f.call('work_items', { repoId: f.repo.id, id: receipt.id });
  assert.ok(handoff.omittedFields.includes('findings'));
  const readFindings = [];
  let offset = 0;
  do {
    const section = await f.call('work_items', { repoId: f.repo.id, id: receipt.id, section: 'findings', offset });
    assert.equal(section.revision, receipt.revision);
    readFindings.push(...section.items); offset = section.nextOffset;
  } while (offset !== null);
  assert.deepEqual(readFindings, findings.map(item => ({ ...item, text: item.text.trim(), evidence: item.evidence.trim() })));
});
