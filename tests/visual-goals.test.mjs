import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createVisualGoals } from '../src/core/visual-goals.mjs';

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
  assert.deepEqual(first.links, { placeId: null, branch: 'codex/visuals', sessionKey: null, component: 'src/renderer' });
  first.links.branch = 'tampered'; first.dependsOn.push('fake');
  assert.equal(f.goals.read('repo-one')[0].links.branch, 'codex/visuals');
  assert.deepEqual(f.goals.read('repo-one')[0].dependsOn, []);
  f.clock.at += 1000;
  const [updated] = await f.goals.save({ id: first.id, repoId: 'repo-one', status: 'done', links: { placeId: 'place-one' } });
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
  await assert.rejects(goals.save({ id: parent.id, repoId: 'one', parentId: child.id }), /cycle/);
  await assert.rejects(goals.save({ id: parent.id, repoId: 'one', dependsOn: [child.id] }), /cycle/);
  await assert.rejects(goals.save({ id: child.id, repoId: 'one', dependsOn: [child.id] }), /cycle/);
  await assert.rejects(goals.save({ id: child.id, repoId: 'one', dependsOn: [other.id] }), /same repository/);
  await assert.rejects(goals.save({ id: child.id, repoId: 'one', parentId: other.id }), /same repository/);
  await assert.rejects(goals.save({ id: child.id, repoId: 'one', dependsOn: ['missing'] }), /no longer exists/);
  await assert.rejects(goals.save({ id: child.id, repoId: 'two' }), /another repository/);
  await assert.rejects(goals.save({ id: 'unknown', repoId: 'one', title: 'No upsert' }), /no longer exists/);
  assert.equal(goals.read('one')[0].parentId, null);
  assert.deepEqual(goals.read('one')[0].dependsOn, []);
});

test('strict shapes and bounds reject unsupported content without changing the saved goals', async t => {
  const { goals } = await fixture(t, { perRepo: 2, goals: 3, dependencies: 1, titleChars: 20 });
  const [a] = await goals.save({ repoId: 'one', title: 'A' });
  for (const patch of [{ title: 'x'.repeat(21) }, { title: '\n\u202e' }, { status: 'complete' }, { secret: 'do not keep' }, { links: { prompt: 'do not keep' } }, { links: [] }, { dependsOn: [a.id, a.id] }, { parentId: 42 }]) {
    await assert.rejects(goals.save({ id: a.id, repoId: 'one', ...patch }));
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
  await assert.rejects(f.goals.save({ id: goal.id, repoId: 'one', title: 'After' }), /could not be saved/);
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
