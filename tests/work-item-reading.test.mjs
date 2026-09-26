import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createVisualGoals } from '../src/core/visual-goals.mjs';
import { createVisualWorkspace } from '../src/core/visual-workspace.mjs';
import { validateWorkRequest, WORK_ITEM_TOOLS } from '../src/core/work-item-protocol.mjs';

const bytes = value => Buffer.byteLength(JSON.stringify(value));
async function fixture(t) {
  const dataDir = await fs.mkdtemp('/private/tmp/summon-work-read-');
  const goals = await createVisualGoals({ dataDir });
  const repo = { id: 'repo-a', name: 'Example', path: dataDir, places: [], branches: [] };
  let privatePaths = [];
  const workspace = await createVisualWorkspace({ goals, getWorkInFlight: async () => ({ repos: [repo] }),
    getAgentSessions: async () => ({ groups: [] }), getPrivatePaths: () => privatePaths });
  t.after(async () => { await workspace.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const read = args => workspace.readWorkItems({ repoId: repo.id, ...args });
  return { goals, workspace, repo, read, privatePaths: paths => { privatePaths = paths; } };
}

async function fullSection(read, id, section, revision) {
  const entries = [];
  let offset = 0, pages = 0;
  do {
    const result = await read({ id, section, offset, limit: 50 });
    assert.equal(result.revision, revision);
    assert.equal(result.section, section);
    assert.ok(bytes(result) <= 36_000, `${section} response is ${bytes(result)} bytes`);
    assert.ok(bytes(result.items) <= 24_000);
    entries.push(...result.items); offset = result.nextOffset; pages++;
    assert.ok(pages < 100, 'pagination must make progress');
  } while (offset !== null);
  return { entries, pages };
}

test('small handoffs retain complete fields and expose stable revision without section calls', async t => {
  const f = await fixture(t);
  const [goal] = await f.goals.save({ repoId: f.repo.id, title: 'Small handoff', acceptanceCriteria: 'The UI result matches the request',
    checklist: [{ id: 'check', text: 'Verify in app', done: false }], findings: [{ id: 'fact', text: 'Existing behavior is known', evidence: 'test result', revisitWhen: 'Behavior changes' }] });
  const detail = await f.read({ id: goal.id });
  assert.deepEqual(detail.item, goal);
  assert.equal(detail.omittedFields, undefined);
  assert.equal(detail.item.revision, goal.revision);
  assert.deepEqual(detail.withheldFields, []);
  assert.equal(detail.conflictsTotal, 0);
});

test('large Unicode handoffs omit whole fields and section pagination recovers every complete entry', async t => {
  const f = await fixture(t);
  const content = '界'.repeat(1000);
  let [goal] = await f.goals.save({ repoId: f.repo.id, title: 'Large handoff', acceptanceCriteria: '界'.repeat(4000), nextStep: '界'.repeat(2000),
    checklist: Array.from({ length: 50 }, (_, i) => ({ id: `check-${i}`, text: '界'.repeat(500), done: false })),
    findings: Array.from({ length: 40 }, (_, i) => ({ id: `finding-${i}`, text: content, evidence: content, revisitWhen: '界'.repeat(500) })),
    evidence: Array.from({ length: 40 }, (_, i) => ({ id: `proof-${i}`, summary: content, reference: content })),
    origin: { summary: '界'.repeat(2000), capturedAt: '2026-09-20T10:00:00Z', evidence: Array.from({ length: 20 }, () => content) },
  });
  for (let i = 0; i < 5; i++) [goal] = await f.goals.save({ id: goal.id, repoId: goal.repoId, expectedRevision: goal.revision, nextStep: '界'.repeat(2000) });
  const detail = await f.read({ id: goal.id });
  assert.ok(bytes(detail) <= 36_000, `detail is ${bytes(detail)} bytes`);
  assert.ok(bytes(detail.item) <= 18_000);
  assert.equal(detail.item.id, goal.id); assert.equal(detail.item.status, goal.status); assert.equal(detail.item.revision, goal.revision);
  for (const field of detail.omittedFields) assert.equal(Object.hasOwn(detail.item, field), false, `${field} is omitted entirely`);
  for (const section of ['checklist', 'findings', 'evidence', 'history']) {
    const { entries, pages } = await fullSection(f.read, goal.id, section, goal.revision);
    assert.deepEqual(entries, goal[section]);
    assert.ok(pages >= 2);
  }
  const origin = await f.read({ id: goal.id, section: 'origin', limit: 50 });
  assert.equal(origin.summary, goal.origin.summary); assert.equal(origin.capturedAt, goal.origin.capturedAt);
  assert.deepEqual((await fullSection(f.read, goal.id, 'origin', goal.revision)).entries, goal.origin.evidence);
  const criteria = await f.read({ id: goal.id, section: 'acceptanceCriteria' });
  assert.equal(criteria.value, goal.acceptanceCriteria); assert.ok(bytes(criteria) < 16_000);
  assert.deepEqual(f.goals.read(f.repo.id)[0], goal, 'bounded reads never trim stored records');
});

test('private content stays masked in omitted fields and all section pages', async t => {
  const f = await fixture(t);
  const [goal] = await f.goals.save({ repoId: f.repo.id, title: 'Private handoff',
    findings: Array.from({ length: 40 }, (_, i) => ({ id: `row-${i}`, text: `pilot-alpha/source.txt ${'界'.repeat(970)}`, evidence: 'pilot-alpha/proof.txt', revisitWhen: 'pilot-alpha/proof.txt changes' })),
    origin: { summary: 'pilot-alpha/source.txt', capturedAt: '2026-09-20T10:00:00Z', evidence: ['pilot-alpha/evidence.txt'] },
    scopePaths: ['pilot-alpha/module.mjs'],
  });
  f.privatePaths(['pilot-alpha/']);
  const detail = await f.read({ id: goal.id });
  assert.ok(detail.omittedFields.includes('findings'));
  assert.ok(detail.withheldFields.includes('findings'));
  assert.ok(detail.withheldFields.includes('origin'));
  assert.equal(JSON.stringify(detail).includes('pilot-alpha'), false);
  const findings = await fullSection(f.read, goal.id, 'findings', goal.revision);
  assert.equal(findings.entries.length, 40);
  assert.equal(JSON.stringify(findings).includes('pilot-alpha'), false);
  const origin = await f.read({ id: goal.id, section: 'origin' });
  assert.equal(JSON.stringify(origin).includes('pilot-alpha'), false);
  assert.ok(origin.withheldFields.includes('origin'));
  assert.equal(f.goals.read(f.repo.id)[0].findings[0].text.includes('pilot-alpha'), true);
});

test('section reads advertise revision changes and validate pagination combinations', async t => {
  const f = await fixture(t);
  const [goal] = await f.goals.save({ repoId: f.repo.id, title: 'Changing handoff', evidence: [{ id: 'a', summary: 'First result', reference: '' }, { id: 'b', summary: 'Second result', reference: '' }] });
  const first = await f.read({ id: goal.id, section: 'evidence', limit: 1 });
  await f.goals.save({ id: goal.id, repoId: goal.repoId, expectedRevision: goal.revision, nextStep: 'New checkpoint' });
  const next = await f.read({ id: goal.id, section: 'evidence', offset: first.nextOffset, limit: 1 });
  assert.equal(next.revision, first.revision + 1);
  assert.match(next.note, /revision changes/);
  const exhausted = await f.read({ id: goal.id, section: 'evidence', offset: 99 });
  assert.deepEqual(exhausted.items, []); assert.equal(exhausted.total, 2); assert.equal(exhausted.nextOffset, null);
  for (const args of [{ section: 'findings' }, { id: goal.id, section: 'title' }, { id: goal.id, offset: 0 }, { id: goal.id, section: 'history', offset: -1 }, { id: goal.id, section: 'history', limit: 51 }]) await assert.rejects(f.read(args));
  await assert.rejects(f.read({ id: goal.id, section: 'nextStep', offset: 0 }), /single value/);
  assert.doesNotThrow(() => validateWorkRequest({ repoId: f.repo.id, id: goal.id, section: 'origin', limit: 10 }));
  assert.ok(WORK_ITEM_TOOLS[0].inputSchema.properties.section.enum.includes('history'));
});

test('many long dependency and conflict summaries stay bounded and disclose omitted conflicts', async t => {
  const f = await fixture(t);
  const dependencies = [];
  for (let i = 0; i < 32; i++) {
    const goal = (await f.goals.save({ repoId: f.repo.id, title: `${i}${'界'.repeat(230)}`, status: 'working', ownerSessionKey: `owner-${i}`, scopePaths: [`src/component-${i}/${'界'.repeat(450)}`] })).at(-1);
    dependencies.push(goal.id);
  }
  const goal = (await f.goals.save({ repoId: f.repo.id, title: 'Shared integration', dependsOn: dependencies, scopePaths: ['src'],
    acceptanceCriteria: '界'.repeat(4000), nextStep: '界'.repeat(2000) })).at(-1);
  const detail = await f.read({ id: goal.id });
  assert.ok(bytes(detail) <= 36_000, `detail is ${bytes(detail)} bytes`);
  assert.equal(detail.dependencies.length, 32);
  assert.deepEqual(Object.keys(detail.dependencies[0]).sort(), ['id', 'status', 'title']);
  assert.equal(detail.conflicts.length, 10); assert.equal(detail.conflictsTotal, 32);
  assert.match(detail.conflictsNote, /not exhaustive/);
  assert.ok(detail.dependencies.every(item => Buffer.byteLength(item.title) <= 160));
  assert.ok(detail.conflicts.every(item => item.reasons.every(reason => Buffer.byteLength(reason) <= 220)));
});
