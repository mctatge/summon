import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createVisualWorkspace } from '../src/core/visual-workspace.mjs';

const owner = 'codex:desktop:owner';
const finding = id => ({ id, text: 'The selected behavior was checked.', evidence: 'tests/work-checkpoints.test.mjs', revisitWhen: 'The behavior changes.' });
const checkpoint = id => ({ id, summary: 'Saved the current finding.', reference: 'tests/work-checkpoints.test.mjs', nextStep: 'Verify the installed application.' });

async function fixture(t) {
  const dataDir = await fs.mkdtemp('/private/tmp/summon-work-checkpoint-');
  const repo = { id: 'repo-a', name: 'Example', path: dataDir, places: [], branches: [] };
  const otherRepo = { id: 'repo-b', name: 'Other', path: `${dataDir}/other`, places: [], branches: [] };
  let privatePaths = [], beforeRepositoryRead = null, sessions = [{ key: owner, repoId: repo.id }, { key: 'claude:terminal:other', repoId: otherRepo.id }];
  const options = { dataDir, getWorkInFlight: async () => { await beforeRepositoryRead?.(); return { repos: [repo, otherRepo] }; },
    getAgentSessions: async () => ({ groups: [{ sessions }] }), getPrivatePaths: () => privatePaths };
  let workspace = await createVisualWorkspace(options);
  t.after(async () => { await workspace.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { repo, otherRepo, get workspace() { return workspace; },
    create: async (fields = {}) => {
      const saved = await workspace.saveGoal({ repoId: repo.id, title: 'Keep work durable', status: 'working', ownerSessionKey: owner,
        nextStep: 'Check the next result.', ...fields });
      return saved.at(-1);
    },
    save: (item, value, options = {}) => workspace.checkpointWorkItem({ repoId: repo.id, id: item.id, expectedRevision: item.revision,
      reportingSessionKey: owner, checkpoint: value, ...options }),
    stored: id => workspace.explicitGoals(repo.id).find(item => item.id === id),
    privatePaths: value => { privatePaths = value; }, hideSessions: () => { sessions = []; },
    onRepositoryRead: callback => { beforeRepositoryRead = callback; },
    reload: async () => { await workspace.close(); workspace = await createVisualWorkspace(options); },
  };
}

test('checkpoints append complete private arrays, preserve work identity, and survive close/reload', async t => {
  const f = await fixture(t);
  const parent = await f.create({ title: 'Parent outcome', status: 'planned', ownerSessionKey: null });
  const before = await f.create({ parentId: parent.id, links: { sessionKey: owner },
    findings: Array.from({ length: 20 }, (_, i) => ({ id: `old-finding-${i}`, text: `pilot-alpha/source.txt ${'界'.repeat(950)}`, evidence: 'pilot-alpha/proof.txt', revisitWhen: 'The result changes.' })),
    evidence: [{ id: 'old-evidence', summary: 'Keep this private proof.', reference: 'pilot-alpha/proof.txt' }],
    checklist: [{ id: 'check-result', text: 'Check the outcome.', done: false }], scopePaths: ['src/work.mjs'],
  });
  f.privatePaths(['pilot-alpha/']);
  const read = await f.workspace.readWorkItems({ repoId: f.repo.id, id: before.id });
  assert.ok(read.omittedFields.includes('findings'));
  assert.ok(read.withheldFields.includes('findings'));
  const value = { ...checkpoint('checkpoint-one'), summary: 'Observed pilot-alpha/new-proof.txt', findings: [finding('new-finding')] };
  const receipt = await f.save(before, value);
  assert.deepEqual(receipt, { saved: true, id: before.id, revision: before.revision + 1, status: 'working', checkpointId: value.id });
  const saved = f.stored(before.id);
  assert.deepEqual(saved.findings, [...before.findings, ...value.findings]);
  assert.deepEqual(saved.evidence, [...before.evidence, { id: value.id, summary: value.summary, reference: value.reference }]);
  for (const field of ['title', 'parentId', 'links', 'ownerSessionKey', 'checklist', 'scopePaths', 'acceptanceCriteria']) assert.deepEqual(saved[field], before[field], field);
  assert.equal(saved.nextStep, value.nextStep);
  assert.equal(saved.history.at(-1).actor, 'agent');
  assert.equal(saved.history.at(-1).sessionKey, owner);
  const visible = await f.workspace.readWorkItems({ repoId: f.repo.id, id: saved.id, section: 'evidence' });
  assert.equal(JSON.stringify(visible).includes('pilot-alpha'), false);
  await f.reload();
  assert.deepEqual(f.stored(before.id), saved);
});

test('checkpoints require an existing record owned by the reporting session in the chosen repository', async t => {
  const f = await fixture(t);
  const unowned = await f.create({ ownerSessionKey: null, status: 'planned' });
  await assert.rejects(f.save(unowned, checkpoint('unowned')), /owning session/);
  const owned = await f.create();
  await assert.rejects(f.save(owned, checkpoint('wrong-owner'), { reportingSessionKey: 'claude:terminal:other' }), /owning session/);
  await assert.rejects(f.save(owned, checkpoint('wrong-repo'), { repoId: f.otherRepo.id }), /no longer exists/);
  await assert.rejects(f.save(owned, checkpoint('missing'), { id: 'unknown-work' }), /no longer exists/);
  assert.equal(f.stored(owned.id).revision, owned.revision);
  // Historical owners retain their existing claim after the provider session vanishes.
  f.hideSessions();
  const receipt = await f.save(owned, checkpoint('after-session-disappeared'));
  assert.equal(receipt.revision, owned.revision + 1);
  assert.equal(f.stored(owned.id).ownerSessionKey, owner);
});

test('closed and deferred records require explicit resumption before accepting a checkpoint', async t => {
  const f = await fixture(t);
  for (const status of ['done', 'dismissed', 'deferred']) {
    const before = await f.create({ status, ...(status === 'done' ? { completion: { kind: 'confirmed', summary: 'The user verified the result.', reference: 'app verification' } } : {}) });
    await assert.rejects(f.save(before, { ...checkpoint(`resume-${status}`), status: 'working' }), /Resume.*update_work_item/);
    assert.deepEqual(f.stored(before.id), before);
  }
  const before = await f.create();
  const deferred = await f.save(before, { ...checkpoint('park-work'), status: 'deferred' });
  assert.equal(deferred.status, 'deferred');
  await assert.rejects(f.save({ ...before, revision: deferred.revision }, checkpoint('after-deferred')), /Resume/);
});

test('duplicate checkpoint or finding IDs never overwrite prior entries', async t => {
  const f = await fixture(t);
  const before = await f.create({ findings: [finding('settled')], evidence: [{ id: 'earlier', summary: 'Original evidence.', reference: 'first check' }] });
  for (const value of [checkpoint('earlier'), { ...checkpoint('new'), findings: [finding('settled')] },
    { ...checkpoint('new'), findings: [finding('twice'), finding('twice')] }]) {
    await assert.rejects(f.save(before, value), /already exists|duplicate/i);
    assert.deepEqual(f.stored(before.id), before);
  }
});

test('stale and concurrent checkpoints cannot lose another saved checkpoint', async t => {
  const f = await fixture(t);
  const before = await f.create();
  const results = await Promise.allSettled(['one', 'two'].map(id => f.save(before, { ...checkpoint(id), findings: [finding(`finding-${id}`)] })));
  const accepted = results.filter(result => result.status === 'fulfilled');
  const rejected = results.filter(result => result.status === 'rejected');
  assert.equal(accepted.length, 1); assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason.message, /revision|changed/i);
  const first = f.stored(before.id);
  assert.deepEqual(first.evidence.map(row => row.id), [accepted[0].value.checkpointId]);
  await assert.rejects(f.save(before, checkpoint('stale')), /revision|changed/i);
  assert.deepEqual(f.stored(before.id), first);
  await f.save(first, checkpoint('after-reread'));
  const final = f.stored(before.id);
  assert.deepEqual(final.evidence.map(row => row.id), [accepted[0].value.checkpointId, 'after-reread']);
  assert.equal(final.findings.length, 1);
  assert.equal(final.revision, before.revision + 2);
});

test('future revisions cannot make stale append arrays valid after a concurrent save', async t => {
  const f = await fixture(t);
  const before = await f.create();
  let reads = 0;
  f.onRepositoryRead(async () => {
    if (++reads !== 2) return;
    f.onRepositoryRead(null);
    // Without the initial revision check, saveGoal would await this update,
    // accept its new revision, then overwrite this evidence with the old array.
    await f.workspace.saveGoal({ id: before.id, repoId: f.repo.id, expectedRevision: before.revision,
      evidence: [{ id: 'concurrent-proof', summary: 'Keep the concurrent result.', reference: 'concurrent check' }] });
  });
  await assert.rejects(f.save(before, checkpoint('future-revision'), { expectedRevision: before.revision + 1 }), /revision|changed/i);
  assert.equal(reads, 1, 'reject the mismatched snapshot before awaiting another repository lookup');
  assert.deepEqual(f.stored(before.id), before);
});

test('reported completion requires an explicit needs-verification checkpoint and cannot confirm done', async t => {
  const f = await fixture(t);
  const before = await f.create();
  const report = { kind: 'reported', summary: 'Source checks passed; the installed app still needs verification.', reference: 'test output' };
  for (const value of [
    { ...checkpoint('missing-report'), status: 'needs-verification' },
    { ...checkpoint('report-without-status'), completion: report },
    { ...checkpoint('report-working'), status: 'working', completion: report },
    { ...checkpoint('confirmed'), status: 'needs-verification', completion: { ...report, kind: 'confirmed' } },
    { ...checkpoint('done'), status: 'done' }, { ...checkpoint('dismissed'), status: 'dismissed' },
  ]) await assert.rejects(f.save(before, value));
  assert.deepEqual(f.stored(before.id), before);
  const receipt = await f.save(before, { ...checkpoint('reported'), status: 'needs-verification', completion: report });
  assert.equal(receipt.status, 'needs-verification');
  const reported = f.stored(before.id);
  assert.deepEqual(reported.completion, report);
  await f.save(reported, checkpoint('more-evidence'));
  assert.deepEqual(f.stored(before.id).completion, report);
  assert.equal(f.stored(before.id).status, 'needs-verification');
});

test('checkpoint shape cannot claim, reparent, retitle, replace evidence, or omit a concrete handoff', async t => {
  const f = await fixture(t);
  const before = await f.create();
  for (const extra of [{ title: 'Changed' }, { parentId: 'another' }, { ownerSessionKey: 'other' }, { evidence: [] }, { links: { sessionKey: 'other' } },
    { nextStep: '' }, { summary: ' ' }, { reference: '' }, { id: '' }, { nextStep: '\u0000' }, { reference: '\u202e' }]) {
    await assert.rejects(f.save(before, { ...checkpoint('invalid'), ...extra }));
  }
  await assert.rejects(f.save(before, checkpoint('actor'), { actor: 'user' }));
  await assert.rejects(f.save(before, checkpoint('no-revision'), { expectedRevision: undefined }));
  assert.deepEqual(f.stored(before.id), before);
});

test('withheld next steps and reports cannot be replaced and receipts never echo secret-shaped row IDs', async t => {
  const f = await fixture(t);
  const privateStep = await f.create({ nextStep: 'Inspect pilot-alpha/private.txt' });
  const privateReport = await f.create({ status: 'needs-verification', completion: { kind: 'reported', summary: 'See pilot-alpha/result.txt', reference: 'local check' } });
  f.privatePaths(['pilot-alpha/']);
  await assert.rejects(f.save(privateStep, checkpoint('replace-step')), /withheld/);
  await assert.rejects(f.save(privateReport, { ...checkpoint('replace-report'), status: 'needs-verification', completion: { kind: 'reported', summary: 'New report', reference: 'new check' } }), /withheld/);
  assert.deepEqual(f.stored(privateStep.id), privateStep);
  assert.deepEqual(f.stored(privateReport.id), privateReport);
  const ordinary = await f.create();
  const syntheticToken = `sk-ant-${'a'.repeat(40)}`;
  const receipt = await f.save(ordinary, checkpoint(syntheticToken));
  assert.equal(JSON.stringify(receipt).includes(syntheticToken), false);
  assert.equal(f.stored(ordinary.id).evidence.at(-1).id, syntheticToken);
});

test('privacy changes between checkpoint validation and save cannot replace newly withheld fields', async t => {
  for (const field of ['nextStep', 'completion']) {
    const f = await fixture(t);
    const before = await f.create(field === 'nextStep' ? { nextStep: 'Inspect pilot-alpha/private.txt' } : {
      status: 'needs-verification', completion: { kind: 'reported', summary: 'Inspect pilot-alpha/result.txt', reference: 'prior check' },
    });
    let reads = 0;
    f.onRepositoryRead(() => { if (++reads === 2) f.privatePaths(['pilot-alpha/']); });
    const value = { ...checkpoint(`privacy-race-${field}`), ...(field === 'completion' ? {
      status: 'needs-verification', completion: { kind: 'reported', summary: 'Replace the earlier report.', reference: 'new check' },
    } : {}) };
    await assert.rejects(f.save(before, value), /scope changed/i);
    assert.equal(reads, 2, 'reject the changed scope at saveGoal entry');
    assert.deepEqual(f.stored(before.id), before, 'reject the entire checkpoint without changing evidence or the withheld field');
  }
});

test('capacity limits reject the whole checkpoint without truncating saved evidence or findings', async t => {
  const f = await fixture(t);
  const fullEvidence = await f.create({ evidence: Array.from({ length: 40 }, (_, i) => ({ id: `evidence-${i}`, summary: 'Keep this result.', reference: 'existing proof' })) });
  await assert.rejects(f.save(fullEvidence, checkpoint('overflow')), /at most 40/);
  assert.deepEqual(f.stored(fullEvidence.id), fullEvidence);
  const fullFindings = await f.create({ findings: Array.from({ length: 40 }, (_, i) => finding(`finding-${i}`)) });
  await assert.rejects(f.save(fullFindings, { ...checkpoint('would-append-evidence'), findings: [finding('overflow')] }), /at most 40/);
  assert.deepEqual(f.stored(fullFindings.id), fullFindings);
});

test('checkpoint status changes retain the existing dependency and conflict checks', async t => {
  const f = await fixture(t);
  const dependency = await f.create({ status: 'planned', ownerSessionKey: null });
  const blocked = await f.create({ status: 'blocked', dependsOn: [dependency.id] });
  await assert.rejects(f.save(blocked, { ...checkpoint('premature-start'), status: 'working' }), /dependencies/);
  assert.deepEqual(f.stored(blocked.id), blocked);
  await f.create({ title: 'Owned interface work', coordinationKeys: ['shared-interface'] });
  const conflicting = await f.create({ status: 'planned', coordinationKeys: ['shared-interface'] });
  await assert.rejects(f.save(conflicting, { ...checkpoint('conflicting-start'), status: 'working' }), /parallel|conflict/);
  assert.deepEqual(f.stored(conflicting.id), conflicting);
});
