import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createVisualGoals, goalConflicts } from '../src/core/visual-goals.mjs';

const START = 1_800_000_000_000;
async function fixture(t, limits) {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'summon-goals-')));
  const clock = { at: START };
  const goals = await createVisualGoals({ dataDir, now: () => clock.at, limits });
  t.after(async () => { await goals.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, goals, clock, file: path.join(dataDir, 'visual-goals.json') };
}

test('explicit goals persist privately, update without losing links, and return detached copies', async t => {
  const f = await fixture(t);
  const [first] = await f.goals.save({ repoId: 'repo-one', title: '  Ship\nvisual\u202eworkspace  ', links: { branch: 'codex/visuals', component: 'src/renderer' } });
  assert.match(first.id, /^[a-f0-9-]{36}$/);
  assert.equal(first.title, 'Ship visual workspace');
  assert.equal(first.status, 'planned');
  assert.equal(first.createdAt, new Date(START).toISOString());
  assert.deepEqual(first.links, { placeId: null, branch: 'codex/visuals', sessionKey: null, agentId: null, component: 'src/renderer' });
  first.links.branch = 'tampered'; first.dependsOn.push('fake');
  assert.equal(f.goals.read('repo-one')[0].links.branch, 'codex/visuals');
  assert.deepEqual(f.goals.read('repo-one')[0].dependsOn, []);
  f.clock.at += 1000;
  const [updated] = await f.goals.save({ id: first.id, expectedRevision: first.revision, repoId: 'repo-one', status: 'done', completion: { kind: 'confirmed', summary: 'Verified in the installed application', reference: 'manual UI check' }, links: { placeId: 'place-one' } });
  assert.equal(updated.createdAt, first.createdAt);
  assert.equal(updated.updatedAt, new Date(f.clock.at).toISOString());
  assert.equal(updated.links.branch, 'codex/visuals');
  assert.equal(updated.links.placeId, 'place-one');
  assert.equal((await fs.stat(f.file)).mode & 0o777, 0o600);
  assert.deepEqual((await fs.readdir(f.dataDir)).filter(name => name.endsWith('.tmp')), []);
  const reopened = await createVisualGoals({ dataDir: f.dataDir });
  assert.deepEqual(reopened.read('repo-one'), [updated]);
  await reopened.close();
});

test('rejects cycles, missing references, cross-repository edges and moving a goal between repositories', async t => {
  const { goals } = await fixture(t);
  const [parent] = await goals.save({ repoId: 'one', title: 'Parent' });
  const [, child] = await goals.save({ repoId: 'one', title: 'Child', parentId: parent.id });
  const [other] = await goals.save({ repoId: 'two', title: 'Other repository' });
  await assert.rejects(goals.save({ id: parent.id, expectedRevision: parent.revision, repoId: 'one', parentId: child.id }), /cycle/);
  await assert.rejects(goals.save({ id: parent.id, expectedRevision: parent.revision, repoId: 'one', dependsOn: [child.id] }), /cycle/);
  await assert.rejects(goals.save({ id: child.id, expectedRevision: child.revision, repoId: 'one', dependsOn: [child.id] }), /cycle/);
  await assert.rejects(goals.save({ id: child.id, expectedRevision: child.revision, repoId: 'one', dependsOn: [other.id] }), /same repository/);
  await assert.rejects(goals.save({ id: child.id, expectedRevision: child.revision, repoId: 'one', parentId: other.id }), /same repository/);
  await assert.rejects(goals.save({ id: child.id, expectedRevision: child.revision, repoId: 'one', dependsOn: ['missing'] }), /no longer exists/);
  await assert.rejects(goals.save({ id: child.id, expectedRevision: child.revision, repoId: 'two' }), /another repository/);
  await assert.rejects(goals.save({ id: 'unknown', repoId: 'one', title: 'No upsert' }), /no longer exists/);
  assert.equal(goals.read('one')[0].parentId, null);
  assert.deepEqual(goals.read('one')[0].dependsOn, []);
});

test('strict shapes and bounds reject unsupported content without changing the saved goals', async t => {
  const { goals } = await fixture(t, { perRepo: 2, goals: 3, dependencies: 1, titleChars: 20 });
  const [a] = await goals.save({ repoId: 'one', title: 'A' });
  for (const patch of [{ title: 'x'.repeat(21) }, { title: '\n\u202e' }, { status: 'complete' }, { secret: 'do not keep' }, { links: { prompt: 'do not keep' } }, { links: [] }, { dependsOn: [a.id, a.id] }, { parentId: 42 }]) {
    await assert.rejects(goals.save({ id: a.id, expectedRevision: a.revision, repoId: 'one', ...patch }));
  }
  await goals.save({ repoId: 'one', title: 'B' });
  await assert.rejects(goals.save({ repoId: 'one', title: 'C' }), /too many goals/);
  await goals.save({ repoId: 'two', title: 'D' });
  await assert.rejects(goals.save({ repoId: 'three', title: 'E' }), /too many saved goals/);
  assert.equal(goals.read('one')[0].title, 'A');
});

test('concurrent saves serialize, detach their inputs, and close drains accepted writes', async t => {
  const { goals } = await fixture(t);
  const mutable = { repoId: 'one', title: 'First', links: { branch: 'codex/first' } };
  const first = goals.save(mutable);
  mutable.title = 'Mutated'; mutable.links.branch = 'changed';
  const second = goals.save({ repoId: 'one', title: 'Second' });
  await goals.close();
  await Promise.all([first, second]);
  assert.deepEqual(goals.read('one').map(goal => goal.title), ['First', 'Second']);
  assert.equal(goals.read('one')[0].links.branch, 'codex/first');
  await assert.rejects(goals.save({ repoId: 'one', title: 'After close' }), /closing/);
});

test('failed persistence preserves in-memory state and leaves no temporary file', async t => {
  const f = await fixture(t);
  const [goal] = await f.goals.save({ repoId: 'one', title: 'Before' });
  await fs.rename(f.file, `${f.file}.saved`);
  await fs.mkdir(f.file);
  await assert.rejects(f.goals.save({ id: goal.id, expectedRevision: goal.revision, repoId: 'one', title: 'After' }), /could not be saved/);
  assert.equal(f.goals.read('one')[0].title, 'Before');
  assert.deepEqual((await fs.readdir(f.dataDir)).filter(name => name.endsWith('.tmp')), []);
});

test('unreadable goal records are left untouched, including invalid persisted relationships', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file, '{ broken');
  await assert.rejects(createVisualGoals({ dataDir: f.dataDir }), /original file was left untouched/);
  assert.equal(await fs.readFile(f.file, 'utf8'), '{ broken');
  const goal = { id: 'a', repoId: 'one', title: 'Bad graph', status: 'planned', parentId: 'a', dependsOn: [], links: {}, createdAt: new Date(START).toISOString(), updatedAt: new Date(START).toISOString() };
  const content = JSON.stringify({ version: 1, goals: [goal] });
  await fs.writeFile(f.file, content);
  await assert.rejects(createVisualGoals({ dataDir: f.dataDir }), /cycle/);
  assert.equal(await fs.readFile(f.file, 'utf8'), content);
});


const patch = (goal, values = {}) => ({ id: goal.id, repoId: goal.repoId, expectedRevision: goal.revision, ...values });
const confirmed = { kind: 'confirmed', summary: 'User verified the expected behavior in the installed app.', reference: 'UI check' };

test('version one migration retains historical done without inventing proof and upgrades on the next save', async t => {
  const f = await fixture(t);
  const historical = { id: 'legacy', repoId: 'one', title: 'Earlier work', status: 'done', parentId: null, dependsOn: [], links: { sessionKey: 'codex:old' }, createdAt: new Date(START).toISOString(), updatedAt: new Date(START).toISOString() };
  const old = JSON.stringify({ version: 1, goals: [historical] });
  await fs.writeFile(f.file, old);
  const migrated = await createVisualGoals({ dataDir: f.dataDir, now: () => START + 1000 });
  t.after(() => migrated.close());
  const [goal] = migrated.read('one');
  assert.equal(goal.revision, 1);
  assert.equal(goal.completion.kind, 'legacy');
  assert.match(goal.completion.summary, /not verified proof/);
  assert.deepEqual(goal.sessionKeys, ['codex:old']);
  assert.deepEqual(goal.history, []);
  assert.deepEqual(goal.findings, []);
  assert.equal(goal.nextStep, '');
  assert.equal(await fs.readFile(f.file, 'utf8'), old, 'reading never rewrites the legacy file');
  const [updated] = await migrated.save(patch(goal, { title: 'Earlier verified scope unknown' }));
  assert.equal(updated.completion.kind, 'legacy');
  assert.equal(updated.revision, 2);
  assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).version, 2);
  const reopened = await createVisualGoals({ dataDir: f.dataDir });
  t.after(() => reopened.close());
  assert.deepEqual(reopened.read('one'), [updated]);
});

test('updates require the current revision and concurrent stale patches cannot overwrite a checkpoint', async t => {
  const f = await fixture(t);
  const [goal] = await f.goals.save({ repoId: 'one', title: 'Scoped work' });
  await assert.rejects(f.goals.save({ id: goal.id, repoId: 'one', nextStep: 'Missing revision' }), /expectedRevision/);
  const attempts = await Promise.allSettled([
    f.goals.save(patch(goal, { nextStep: 'First checkpoint' })),
    f.goals.save(patch(goal, { nextStep: 'Stale overwrite' })),
  ]);
  assert.equal(attempts[0].status, 'fulfilled');
  assert.equal(attempts[1].status, 'rejected');
  assert.match(attempts[1].reason.message, /Refresh.*expectedRevision/);
  const [current] = f.goals.read('one');
  assert.equal(current.nextStep, 'First checkpoint');
  assert.equal(current.revision, 2);
  assert.equal(current.history.length, 2);
  assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).goals[0].nextStep, current.nextStep);
  for (const field of ['revision', 'history', 'sessionKeys', 'createdAt']) await assert.rejects(f.goals.save(patch(current, { [field]: current[field] })), /read-only/);
  await assert.rejects(f.goals.save({ repoId: 'one', title: 'New', expectedRevision: 0 }), /new goal/);
});

test('completion requires confirmed evidence, finished checklist and dependencies; agents report verification pending', async t => {
  const { goals } = await fixture(t);
  const [dependency] = await goals.save({ repoId: 'one', title: 'Define API' });
  let child = (await goals.save({ repoId: 'one', title: 'Implement API', dependsOn: [dependency.id], checklist: [{ id: 'check', text: 'Run end-to-end behavior check', done: false }] })).at(-1);
  await assert.rejects(goals.save(patch(child, { status: 'working' })), /Define API/);
  await assert.rejects(goals.save(patch(child, { status: 'done' })), /confirmed completion evidence/);
  await assert.rejects(goals.save(patch(child, { status: 'done', completion: confirmed })), /checklist/);
  await assert.rejects(goals.save(patch(child, { status: 'done', completion: confirmed, checklist: [{ ...child.checklist[0], done: true }] })), /dependencies/);
  await assert.rejects(goals.save(patch(child, { status: 'done', completion: confirmed }), { actor: 'agent' }), /needs-verification/);
  await assert.rejects(goals.save(patch(child, { completion: confirmed }), { actor: 'agent' }), /needs-verification/);
  await assert.rejects(goals.save(patch(child, { completion: { kind: 'legacy', summary: 'Forged previous success', reference: '' } })), /reserved/);
  await goals.save(patch(dependency, { status: 'done', completion: confirmed }));
  child = (await goals.save(patch(child, { status: 'working', ownerSessionKey: 'codex:one' }), { actor: 'agent' })).at(-1);
  child = (await goals.save(patch(child, { status: 'needs-verification', checklist: [{ ...child.checklist[0], done: true }], completion: { kind: 'reported', summary: 'Tests passed', reference: 'run:42' }, reportingSessionKey: 'codex:one' }), { actor: 'agent' })).at(-1);
  assert.equal(child.status, 'needs-verification');
  child = (await goals.save(patch(child, { status: 'done', completion: confirmed }))).at(-1);
  assert.equal(child.status, 'done');
  child = (await goals.save(patch(child, { nextStep: 'No further investigation without a regression' }))).at(-1);
  assert.equal(child.completion.kind, 'confirmed');
  assert.equal(child.history.at(-2).status, 'done');
  await assert.rejects(goals.save(patch(child, { checklist: [{ ...child.checklist[0], done: false }] })), /checklist/);
});

test('claim checks serialize competing sessions and directory overlap respects path boundaries', async t => {
  const { goals } = await fixture(t);
  const [a] = await goals.save({ repoId: 'one', title: 'Health reader', scopePaths: ['src/main'] });
  const b = (await goals.save({ repoId: 'one', title: 'Router', scopePaths: ['src/main/task-router.mjs'] })).at(-1);
  const results = await Promise.allSettled([
    goals.save(patch(a, { status: 'working', ownerSessionKey: 'codex:a' }), { actor: 'agent' }),
    goals.save(patch(b, { status: 'working', ownerSessionKey: 'claude:b' }), { actor: 'agent' }),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.match(results[1].reason.message, /Cannot work in parallel.*Health reader.*Overlapping scope/);
  const current = goals.read('one')[0];
  assert.equal(goalConflicts(b, goals.read('one')).length, 1);
  await goals.save({ repoId: 'one', title: 'Separate directory', scopePaths: ['src/mainly/file.mjs'], status: 'working', ownerSessionKey: 'claude:c' });
  await goals.save({ repoId: 'two', title: 'Other repository', scopePaths: ['src/main'], status: 'working', ownerSessionKey: 'claude:d' });
  await assert.rejects(goals.save(patch(current, { ownerSessionKey: 'claude:b' }), { actor: 'agent' }), /Only the user/);
  await assert.rejects(goals.save(patch(current, { ownerSessionKey: null }), { actor: 'agent' }), /Only the user/);
  await goals.save(patch(current, { ownerSessionKey: null, status: 'blocked' }));
  await goals.save(patch(b, { status: 'working', ownerSessionKey: 'claude:b' }), { actor: 'agent' });
});

test('serial exclusions are symmetric without becoming dependency cycles, and coordination keys exclude shared contracts', async t => {
  const { goals } = await fixture(t);
  const [a] = await goals.save({ repoId: 'one', title: 'Producer', coordinationKeys: ['routing-result'] });
  const b = (await goals.save({ repoId: 'one', title: 'Consumer', serialWith: [a.id] })).at(-1);
  let currentA = (await goals.save(patch(a, { serialWith: [b.id], status: 'working', ownerSessionKey: 'codex:a' })))[0];
  await assert.rejects(goals.save(patch(b, { serialWith: [], status: 'working', ownerSessionKey: 'codex:b' })), /Explicitly marked to run serially/);
  await assert.rejects(goals.save({ repoId: 'one', title: 'Different files, same API', coordinationKeys: ['routing-result'], status: 'working', ownerSessionKey: 'claude:c' }), /Shared coordination/);
  await assert.rejects(goals.save(patch(currentA, { serialWith: [a.id] })), /itself/);
  await assert.rejects(goals.save(patch(currentA, { serialWith: ['missing'] })), /no longer exists/);
  const [other] = await goals.save({ repoId: 'two', title: 'Other project' });
  await assert.rejects(goals.save(patch(currentA, { serialWith: [other.id] })), /same repository/);
});

test('findings, original evidence, session attempts and bounded checkpoints persist across restart', async t => {
  const f = await fixture(t, { history: 3 });
  const origin = { summary: 'Routing follow-up from the original session', evidence: ['user: use fresh health to choose eligible versions'], capturedAt: new Date(START).toISOString() };
  let [goal] = await f.goals.save({ repoId: 'one', title: 'Routing follow-up', acceptanceCriteria: 'Eligible healthy version is chosen deterministically.', nextStep: 'Check adapter input', origin, findings: [{ id: 'finding1', text: 'Family and version selection are distinct.', evidence: 'src/main/model-selection.mjs', revisitWhen: 'Selection API changes' }], evidence: [{ id: 'e1', summary: 'Previous analysis located the selection entrypoint.', reference: 'session:original#turn3' }], links: { sessionKey: 'codex:original' }, ownerSessionKey: 'claude:replacement' });
  for (let i = 0; i < 4; i++) {
    f.clock.at += 1000;
    [goal] = await f.goals.save(patch(goal, { nextStep: `Checkpoint ${i}`, reportingSessionKey: `codex:attempt-${i}` }), { actor: 'agent' });
  }
  assert.equal(goal.history.length, 3);
  assert.equal(goal.history[0].nextStep, 'Checkpoint 1');
  assert.equal(goal.history.at(-1).actor, 'agent');
  assert.equal(goal.history.at(-1).at, new Date(f.clock.at).toISOString());
  assert.deepEqual(goal.sessionKeys, ['codex:original', 'claude:replacement', 'codex:attempt-0', 'codex:attempt-1', 'codex:attempt-2', 'codex:attempt-3']);
  assert.deepEqual(goal.origin, origin);
  const reopened = await createVisualGoals({ dataDir: f.dataDir });
  t.after(() => reopened.close());
  assert.deepEqual(reopened.read('one'), [goal]);
  const stored = JSON.parse(await fs.readFile(f.file, 'utf8')).goals[0];
  assert.equal('reportingSessionKey' in stored, false);
  assert.equal('expectedRevision' in stored, false);
});

test('extended shapes reject unsafe paths, forged provenance and duplicate records without losing saved content', async t => {
  const { goals } = await fixture(t);
  const [goal] = await goals.save({ repoId: 'one', title: 'Preserve me' });
  for (const scope of ['/src/core', '../core', 'src/../core', 'src/./core', 'src//core', 'src\\core', 'C:/src', '~/.ssh', 'src/\u0000core']) await assert.rejects(goals.save(patch(goal, { scopePaths: [scope] })), /repository-relative/);
  for (const invalid of [
    { checklist: [{ id: 'x', text: 'Do it', done: 'yes' }] },
    { checklist: [{ id: 'x', text: 'One', done: false }, { id: 'x', text: 'Two', done: false }] },
    { findings: [{ id: 'f', text: 'Claim', evidence: '', revisitWhen: '', injected: true }] },
    { origin: { summary: 'Origin', evidence: ['source'], capturedAt: 'not a date' } },
    { completion: { kind: 'confirmed', summary: '  ', reference: '' } },
    { acceptanceCriteria: 'x'.repeat(4001) },
    { evidence: Array.from({ length: 41 }, (_, i) => ({ id: `e${i}`, summary: 'Repeated', reference: '' })) },
  ]) await assert.rejects(goals.save(patch(goal, invalid)));
  const [current] = goals.read('one');
  assert.equal(current.revision, 1);
  assert.deepEqual(current.scopePaths, []);
  const [normalized] = await goals.save(patch(goal, { scopePaths: ['src/core/'] }));
  assert.deepEqual(normalized.scopePaths, ['src/core']);
});


test('corrupt version two completion evidence is not rewritten or silently trusted', async t => {
  const f = await fixture(t);
  await f.goals.save({ repoId: 'one', title: 'Verified', status: 'done', completion: confirmed });
  const content = JSON.parse(await fs.readFile(f.file, 'utf8'));
  content.goals[0].completion = null;
  const broken = JSON.stringify(content);
  await fs.writeFile(f.file, broken);
  await assert.rejects(createVisualGoals({ dataDir: f.dataDir }), /original file was left untouched.*completion evidence/);
  assert.equal(await fs.readFile(f.file, 'utf8'), broken);
});


test('done acceptance cannot silently expand while old confirmation remains attached', async t => {
  const { goals } = await fixture(t);
  const [dependency] = await goals.save({ repoId: 'one', title: 'Ready dependency', status: 'done', completion: confirmed });
  let done = (await goals.save({ repoId: 'one', title: 'Verified local scope', status: 'done', completion: confirmed,
    acceptanceCriteria: 'One provider handles the fallback', checklist: [{ id: 'local', text: 'Check one provider', done: true }], scopePaths: ['src/local'],
  })).at(-1);
  const changes = [
    { acceptanceCriteria: 'All providers handle every fallback' },
    { checklist: [{ id: 'all', text: 'Every provider verified', done: true }] },
    { checklist: [] },
    { dependsOn: [dependency.id] },
    { scopePaths: ['src'] },
  ];
  for (const change of changes) {
    await assert.rejects(goals.save(patch(done, change)), /Reopen.*explicitly reconfirm/);
    await assert.rejects(goals.save(patch(done, change), { actor: 'agent' }), /Reopen.*explicitly reconfirm/);
  }
  done = (await goals.save(patch(done, { nextStep: 'Revisit only if the fallback regresses', findings: [{ id: 'settled', text: 'One provider is verified', evidence: 'UI check', revisitWhen: 'Regression' }] }), { actor: 'agent' })).at(-1);
  assert.equal(done.status, 'done');
  assert.equal(done.completion.kind, 'confirmed');
  done = (await goals.save(patch(done, { acceptanceCriteria: 'All providers handle every fallback', scopePaths: ['src'], completion: confirmed }))).at(-1);
  assert.equal(done.status, 'done');
  assert.equal(done.acceptanceCriteria, 'All providers handle every fallback');
  const reopened = (await goals.save(patch(done, { status: 'needs-verification', acceptanceCriteria: 'A new provider also needs a check', checklist: [{ id: 'new', text: 'Verify new provider', done: false }], completion: { kind: 'reported', summary: 'New behavior remains to be checked', reference: '' } }), { actor: 'agent' })).at(-1);
  assert.equal(reopened.status, 'needs-verification');
  assert.equal(reopened.checklist[0].done, false);
});
