import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createStanding, streamSignature, sketchOf, jaccard, matchStreams, listText, whenText, spanText } from '../src/core/standing.mjs';
import { createWorkInFlight } from '../src/core/work-in-flight.mjs';

const NUL = String.fromCharCode(0);
const UNIT = String.fromCharCode(31);
// One `git log --left-right` record: which side it is on, its commit, its subject.
const logRecord = (subject, mark = '>') => `${mark}${UNIT}${sha(subject).slice(0, 40)}${UNIT}${subject}`;
const sha = value => createHash('sha256').update(value).digest('hex');
const DAY = 86400000;
const MINUTE = 60000;

async function tempDir(t, prefix = 'summon-standing-') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function clockFrom(start) {
  let value = start;
  return { now: () => value, set: next => { value = next; }, advance: ms => { value += ms; return value; } };
}

// One folder as the Work in flight view projects it for the ledger: counts and file lists, never file contents.
function spot(id, extra = {}) {
  return {
    placeId: `place-${id}`, label: 'Main folder', path: `/tmp/projects/${id}`, fingerprint: 'fp-one', oid: 'a'.repeat(40),
    items: 3, conflicted: 0, added: 9, removed: 2, aheadOfBase: 0, behindBase: 0, paths: 3, working: 0, lastCommitAt: null, streams: [], ...extra,
  };
}
function obs(repoId, repoName, places, extra = {}) {
  return { repoId, repoName, repoPath: `/tmp/projects/${repoName}`, hasWork: true, branchTips: { main: 'aaaa1111' }, places, ...extra };
}
const stream = (files, readiness = 'in-progress') => ({ files, readiness });

test('stream identity survives a regroup where the titles change but the files do not', async t => {
  // A grouping rewrites every id and title each time it runs, so identity has to come from the file set.
  const before = [stream(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts']), stream(['docs/g.md', 'docs/h.md', 'docs/i.md', 'docs/j.md'])];
  const after = [stream(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts']), stream(['src/f.ts', 'docs/g.md', 'docs/h.md', 'docs/i.md', 'docs/j.md'])];
  assert.notEqual(streamSignature(before[0].files), streamSignature(after[0].files), 'the regroup really does change both signatures');
  assert.notEqual(streamSignature(before[1].files), streamSignature(after[1].files));

  const dataDir = await tempDir(t);
  const clock = clockFrom(Date.parse('2026-09-10T09:00:00.000Z'));
  const ledger = await createStanding({ dataDir, now: clock.now });
  t.after(() => ledger.close());

  await ledger.sample([obs('harbor', 'Harbor', [spot('m', { streams: before })])]);
  const first = await ledger.read();
  const keysBefore = first.repos.harbor.places['place-m'].streams.map(item => item.key);
  assert.equal(new Set(keysBefore).size, 2);

  clock.advance(5 * MINUTE);
  await ledger.sample([obs('harbor', 'Harbor', [spot('m', { fingerprint: 'fp-two', streams: after })])]);
  const second = await ledger.read();
  const keysAfter = second.repos.harbor.places['place-m'].streams.map(item => item.key);
  assert.deepEqual(keysAfter, keysBefore, 'a regroup keeps each stream identity instead of reading as all new');
  assert.deepEqual(Object.keys(second.repos.harbor.firstSeenAt).sort(), [...keysBefore].sort(), 'no new first-seen entries were invented');
  assert.deepEqual(Object.values(second.repos.harbor.firstSeenAt), Object.values(first.repos.harbor.firstSeenAt));

  // The control: a grouping that shares no file at all is genuinely new work, and must read as new.
  clock.advance(5 * MINUTE);
  await ledger.sample([obs('harbor', 'Harbor', [spot('m', { fingerprint: 'fp-three', streams: [stream(['other/x.ts', 'other/y.ts'])] })])]);
  const third = await ledger.read();
  assert.equal(third.repos.harbor.places['place-m'].streams.length, 1);
  assert.equal(keysBefore.includes(third.repos.harbor.places['place-m'].streams[0].key), false);
});

test('every folder in a project keeps its own streams, and none of them loses its first-seen date', async t => {
  const dataDir = await tempDir(t);
  const clock = clockFrom(Date.parse('2026-09-10T09:00:00.000Z'));
  const ledger = await createStanding({ dataDir, now: clock.now });
  t.after(() => ledger.close());
  const places = [
    spot('main', { streams: [stream(['src/a.ts', 'src/b.ts'])] }),
    spot('calm', { placeId: 'place-calm', label: 'Claude worktree · calm', fingerprint: 'fp-calm', streams: [stream(['docs/c.md', 'docs/d.md'])] }),
    spot('bold', { placeId: 'place-bold', label: 'Codex worktree · bold', fingerprint: 'fp-bold', streams: [stream(['pilot/e.csv'])] }),
  ];
  await ledger.sample([obs('harbor', 'Harbor', places)]);
  const state = await ledger.read();
  const keys = Object.values(state.repos.harbor.places).flatMap(place => place.streams.map(item => item.key));
  assert.equal(keys.length, 3);
  assert.deepEqual(Object.keys(state.repos.harbor.firstSeenAt).sort(), [...keys].sort(), 'no folder loses its streams to the folder written after it');
  assert.equal(new Set(Object.values(state.repos.harbor.firstSeenAt)).size, 1);
});

test('matching is greedy, one to one, and refuses pairs below the threshold', () => {
  const sketch = files => ({ key: streamSignature(files), sig: streamSignature(files), sketch: sketchOf(files) });
  const previous = [sketch(['a', 'b', 'c', 'd']), sketch(['e', 'f'])];
  const current = [{ sig: 's1', sketch: sketchOf(['a', 'b', 'c']) }, { sig: 's2', sketch: sketchOf(['a', 'b', 'd']) }, { sig: 's3', sketch: sketchOf(['z']) }];
  const { keys, gone } = matchStreams(previous, current);
  assert.equal(keys[0], previous[0].key, 'the best pair wins');
  assert.equal(keys[1], null, 'the second best cannot take a previous stream that is already claimed');
  assert.equal(keys[2], null, 'an unrelated stream is left unmatched');
  assert.deepEqual(gone.map(item => item.key), [previous[1].key]);
  assert.equal(jaccard(sketchOf(['a', 'b']), sketchOf(['a', 'b'])), 1);
  assert.equal(jaccard(sketchOf(['a', 'b']), sketchOf(['c', 'd'])), 0);
  assert.equal(jaccard(sketchOf([]), sketchOf(['a'])), 0);
  // Above the sketch size the estimate still separates a near-copy from unrelated work.
  const many = Array.from({ length: 300 }, (_, index) => `src/file${index}.ts`);
  assert.ok(jaccard(sketchOf(many), sketchOf(many.slice(0, 290))) >= 0.5);
  assert.ok(jaccard(sketchOf(many), sketchOf(many.map(item => `${item}x`))) < 0.5);
});

test('with no history yet, Summon says it starts counting from now and never guesses', async t => {
  const dataDir = await tempDir(t);
  const clock = clockFrom(Date.parse('2026-09-10T09:00:00.000Z'));
  const ledger = await createStanding({ dataDir, now: clock.now });
  t.after(() => ledger.close());
  const view = await ledger.sample([obs('harbor', 'Harbor', [spot('m')])], { landedFor: () => assert.fail('nothing may be asked of git without a watermark') });
  assert.equal(view.text, 'Summon starts counting from now.');
  assert.equal(view.since, null);
  assert.equal(view.sinceText, null);
  assert.deepEqual(view.moved, []);
  assert.equal(view.landed, 0);
  assert.deepEqual(view.unreadRepos, ['Harbor']);
  assert.deepEqual(view.notMoving, []);
});

test('the watermark only moves when it is marked, and then the line goes quiet again', async t => {
  const dataDir = await tempDir(t);
  const clock = clockFrom(Date.parse('2026-09-15T16:00:00.000Z'));
  const ledger = await createStanding({ dataDir, now: clock.now });
  t.after(() => ledger.close());
  const asked = [];
  const landedFor = request => { asked.push(request); return { from: request.from, to: request.to, count: 6, more: false, subjects: ['Add the templates tab'], rewritten: false }; };

  await ledger.sample([obs('harbor', 'Harbor', [spot('m', { streams: [stream(['src/a.ts'])] })])]);
  const marked = await ledger.mark({ repoId: 'harbor' });
  assert.equal(marked.markedPlaces, 1);

  clock.advance(2 * 60 * MINUTE);
  const quiet = await ledger.sample([obs('harbor', 'Harbor', [spot('m', { streams: [stream(['src/a.ts'])] })])], { landedFor });
  assert.deepEqual(quiet.moved, []);
  assert.equal(asked.length, 0, 'an unchanged folder never reaches git');
  assert.match(quiet.text, /^Nothing has moved since /);
  assert.equal(quiet.sinceText, whenText(Date.parse(quiet.since), clock.now()));

  clock.advance(60 * MINUTE);
  const movedView = await ledger.sample([obs('harbor', 'Harbor', [spot('m', { fingerprint: 'fp-two', oid: 'b'.repeat(40), streams: [stream(['src/a.ts'], 'ready')] })])], { landedFor });
  assert.deepEqual(movedView.moved, ['Harbor']);
  assert.equal(movedView.landed, 6);
  assert.deepEqual(movedView.landedSubjects, ['Add the templates tab']);
  assert.equal(movedView.streamsReady, 1);
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0], { repoId: 'harbor', placeId: 'place-m', placePath: '/tmp/projects/m', from: 'a'.repeat(40), to: 'b'.repeat(40), stored: null });
  assert.match(movedView.text, /^Since .*, Harbor moved\. 6 saves landed and 1 piece of work is now ready to save\.$/);
  assert.deepEqual(movedView.byRepo.harbor.notes.slice(0, 2).map(note => [note.kind, note.text, note.inferred]), [['landed', '6 saves landed in Main folder.', false], ['landed', 'Saved \u201cAdd the templates tab\u201d.', false]]);
  assert.equal(movedView.byRepo.harbor.notes.every(note => note.placeId === 'place-m' && note.fingerprint === movedView.fingerprints['place-m']), true);
  assert.equal(movedView.byRepo.harbor.repoId, 'harbor');

  await ledger.mark({ repoId: 'harbor' });
  clock.advance(60 * MINUTE);
  const after = await ledger.sample([obs('harbor', 'Harbor', [spot('m', { fingerprint: 'fp-two', oid: 'b'.repeat(40), streams: [stream(['src/a.ts'], 'ready')] })])], { landedFor });
  assert.deepEqual(after.moved, []);
  assert.equal(after.landed, 0);
  assert.equal(after.streamsReady, 0, 'a stream that was already ready at the watermark is not reported again');
});

test('a stream that goes away with commits was saved, and without them it was dropped', async t => {
  const dataDir = await tempDir(t);
  const clock = clockFrom(Date.parse('2026-09-15T16:00:00.000Z'));
  const ledger = await createStanding({ dataDir, now: clock.now });
  t.after(() => ledger.close());
  const both = [stream(['src/a.ts', 'src/b.ts']), stream(['docs/c.md', 'docs/d.md'])];
  await ledger.sample([obs('harbor', 'Harbor', [spot('m', { streams: both })])]);
  await ledger.mark({ repoId: 'harbor' });

  clock.advance(30 * MINUTE);
  const saved = await ledger.sample([obs('harbor', 'Harbor', [spot('m', { fingerprint: 'fp-two', oid: 'b'.repeat(40), streams: [both[1]] })])], {
    landedFor: request => ({ from: request.from, to: request.to, count: 2, more: false, subjects: [], rewritten: false }),
  });
  assert.equal(saved.streamsSaved, 1);
  assert.equal(saved.streamsDropped, 0);

  await ledger.mark({ repoId: 'harbor' });
  clock.advance(30 * MINUTE);
  // The files moved and the commit did not, so nothing landed here and there is nothing to ask git about.
  const dropped = await ledger.sample([obs('harbor', 'Harbor', [spot('m', { fingerprint: 'fp-three', oid: 'b'.repeat(40), streams: [] })])], { landedFor: () => null });
  assert.equal(dropped.streamsSaved, 0);
  assert.equal(dropped.streamsDropped, 1);
  const note = dropped.byRepo.harbor.notes.find(item => item.kind === 'dropped');
  assert.equal(note.text, '1 piece of work left Main folder without being saved.');
  assert.equal(note.inferred, true, 'saved against dropped is read from whether commits landed, so it is marked a guess');
});

test('work is only called saved or dropped when the folder moved and the count is known', async t => {
  const dataDir = await tempDir(t);
  const clock = clockFrom(Date.parse('2026-09-15T16:00:00.000Z'));
  const ledger = await createStanding({ dataDir, now: clock.now });
  t.after(() => ledger.close());
  const two = [stream(['src/a.ts', 'src/b.ts']), stream(['docs/c.md', 'docs/d.md'])];
  const start = () => ledger.sample([obs('harbor', 'Harbor', [spot('m', { streams: two })])]);
  const claim = view => [view.streamsSaved, view.streamsDropped];

  // A pure regroup: the same files, grouped differently, so every key changes while nothing left the folder.
  await start();
  await ledger.mark({ repoId: 'harbor' });
  clock.advance(30 * MINUTE);
  const regroup = await ledger.sample([obs('harbor', 'Harbor', [spot('m', { streams: [stream(['src/a.ts', 'docs/c.md']), stream(['src/b.ts', 'docs/d.md'])] })])], { landedFor: () => null });
  assert.deepEqual(claim(regroup), [0, 0], 'a folder that never moved is no evidence that work was thrown away');
  assert.equal(regroup.byRepo.harbor.notes.some(item => item.kind === 'dropped'), false);

  // The log read failed, so how much landed is unknown. Unknown is not zero.
  await ledger.mark({ repoId: 'harbor' });
  clock.advance(30 * MINUTE);
  const unknown = await ledger.sample([obs('harbor', 'Harbor', [spot('m', { fingerprint: 'fp-two', oid: 'b'.repeat(40), streams: [] })])], { landedFor: () => null });
  assert.deepEqual(claim(unknown), [0, 0], 'a count Summon could not read is not evidence of a loss');
  assert.equal(unknown.byRepo.harbor.notes.some(item => item.kind === 'dropped'), false);

  // The history was rewritten, so the core has already said it is not counting. It may not then count.
  await ledger.mark({ repoId: 'harbor' });
  clock.advance(30 * MINUTE);
  const rewritten = await ledger.sample([obs('harbor', 'Harbor', [spot('m', { fingerprint: 'fp-three', oid: 'c'.repeat(40), streams: [] })])], {
    landedFor: request => ({ from: request.from, to: request.to, count: 0, more: false, subjects: [], rewritten: true }),
  });
  assert.deepEqual(claim(rewritten), [0, 0], 'the core does not admit it cannot count and then count');
  assert.equal(rewritten.byRepo.harbor.notes.some(item => item.kind === 'dropped'), false);
  assert.equal(rewritten.byRepo.harbor.notes.some(item => item.kind === 'rewritten'), true);
});

test('a rewritten history is said plainly and never counted', async t => {
  const dataDir = await tempDir(t);
  const clock = clockFrom(Date.parse('2026-09-15T16:00:00.000Z'));
  const ledger = await createStanding({ dataDir, now: clock.now });
  t.after(() => ledger.close());
  await ledger.sample([obs('harbor', 'Harbor', [spot('m')])]);
  await ledger.mark({ repoId: 'harbor' });
  clock.advance(60 * MINUTE);
  const view = await ledger.sample([obs('harbor', 'Harbor', [spot('m', { fingerprint: 'fp-two', oid: 'c'.repeat(40) })])], {
    landedFor: request => ({ from: request.from, to: request.to, count: 0, more: false, subjects: [], rewritten: true }),
  });
  assert.deepEqual(view.rewritten, ['Harbor']);
  assert.equal(view.landed, 0);
  assert.deepEqual(view.landedSubjects, []);
  assert.match(view.text, /History was rewritten in Harbor, so Summon is not counting saves there\./);
  assert.equal(view.byRepo.harbor.notes.some(item => item.kind === 'rewritten' && item.text === 'History was rewritten here, so Summon is not counting what landed.'), true);
});

test('not moving, spinning, blocked and rot each come from evidence and carry the fingerprint that proves them', async t => {
  const dataDir = await tempDir(t);
  const clock = clockFrom(Date.parse('2026-09-01T09:00:00.000Z'));
  const ledger = await createStanding({ dataDir, now: clock.now });
  t.after(() => ledger.close());
  const still = (extra = {}) => spot('still', { label: 'Main folder', fingerprint: 'fp-still', ...extra });
  const spin = () => spot('spin', { label: 'Claude worktree · calm', fingerprint: 'fp-spin', working: 2 });
  const block = () => spot('block', { label: 'Codex worktree · bold', fingerprint: 'fp-block', conflicted: 3 });
  const rot = extra => spot('rot', { label: 'Extra folder · old', fingerprint: 'fp-rot', aheadOfBase: 2, lastCommitAt: '2026-08-01T09:00:00.000Z', ...extra });

  await ledger.sample([obs('brawl', 'Brawl Draft', [still(), spin(), block(), rot({ behindBase: 1 })])]);
  await ledger.mark({ repoId: 'brawl' });
  clock.advance(60 * MINUTE);
  const second = await ledger.sample([obs('brawl', 'Brawl Draft', [still(), spin(), block(), rot({ behindBase: 4 })])]);
  assert.deepEqual(second.spinning, [], 'two identical scans are not yet a loop');
  assert.equal(second.blocked.length, 1);
  assert.equal(second.blocked[0].confidence, 'reported');
  assert.equal(second.rot.length, 1);
  assert.equal(second.rot[0].confidence, 'inferred');
  assert.match(second.rot[0].why, /^The main line moved ahead while this stayed put, and the last save here was \d+ days ago\.$/);
  assert.deepEqual(second.still, [], 'an hour is not a week');

  clock.advance(40 * MINUTE);
  const third = await ledger.sample([obs('brawl', 'Brawl Draft', [still(), spin(), block(), rot({ behindBase: 4 })])]);
  assert.equal(third.spinning.length, 1);
  assert.equal(third.spinning[0].confidence, 'inferred');
  assert.equal(third.spinning[0].placeLabel, 'Claude worktree · calm');
  assert.match(third.spinning[0].why, /^An agent is working here and no file has changed in 100 minutes\.$/);
  assert.equal(third.spinning[0].fingerprint, 'fp-spin', 'the rail carries the evidence, so the panel can drop it the moment it changes');
  assert.equal(third.rot.length, 1, 'behindBase stopped climbing but is still above where the run started');

  clock.advance(9 * DAY);
  const later = await ledger.sample([obs('brawl', 'Brawl Draft', [still(), spin(), block(), rot({ behindBase: 4 })])]);
  assert.equal(later.still.length, 4);
  assert.equal(later.still.every(entry => entry.confidence === 'reported' && entry.inferred === false), true);
  assert.equal(later.spinning.every(entry => entry.inferred === true && entry.placeId && entry.fingerprint), true);
  assert.equal(later.still[0].days >= 9, true);
  // A folder can sit unchanged for weeks with an agent opened in it, and minutes stop meaning anything long before
  // that. The sentence also never says how long the agent has been at it, which this ledger has no way to know.
  assert.match(later.spinning[0].why, /^An agent is working here and no file has changed in 9 days\.$/);
  assert.equal(/minute/.test(later.spinning[0].why), false, 'nine days is never said in minutes');
  // The paragraph has no room for a marker, so it closes on a counted row, never on the spinning guess above it.
  assert.match(later.text, /Brawl Draft is waiting on a decision about conflicting edits\.$/);
  assert.equal(/agent working without changing a file|main line moved ahead/.test(later.text), false, 'no guess is stated as plain fact in the paragraph');
  // One row per folder, spinning first, and never more than the rail holds.
  assert.deepEqual(later.notMoving.map(entry => entry.kind), ['spinning', 'blocked', 'rot', 'still']);
  assert.equal(new Set(later.notMoving.map(entry => entry.placeId)).size, later.notMoving.length);

  // A folder with nothing unsaved is finished, not stuck.
  clock.advance(DAY);
  const clean = await ledger.sample([obs('brawl', 'Brawl Draft', [still({ items: 0 })])]);
  assert.deepEqual(clean.still, []);
});

test('the ledger writes privately, survives a corrupt file and stays inside its size limit', async t => {
  const dataDir = await tempDir(t);
  const clock = clockFrom(Date.parse('2026-09-15T16:00:00.000Z'));
  let ledger = await createStanding({ dataDir, now: clock.now });
  await ledger.sample([obs('harbor', 'Harbor', [spot('m', { streams: [stream(['src/a.ts'])] })])]);
  await ledger.mark({ repoId: 'harbor' });
  const file = path.join(dataDir, 'standing.json');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.deepEqual((await fs.readdir(dataDir)).filter(name => name.endsWith('.tmp')), []);
  await ledger.close();

  ledger = await createStanding({ dataDir, now: clock.now });
  assert.equal((await ledger.read()).repos.harbor.seen.branchTips.main, 'aaaa1111');
  await ledger.close();

  await fs.writeFile(file, '{ this is not json');
  ledger = await createStanding({ dataDir, now: clock.now });
  t.after(() => ledger.close());
  const view = await ledger.sample([obs('harbor', 'Harbor', [spot('m')])]);
  assert.equal(view.text, 'Summon starts counting from now.', 'a ledger that cannot be read fails closed to no history');
  assert.equal((await fs.readdir(dataDir)).some(name => name.startsWith('standing.json.corrupt-')), true);

  // Many projects with long histories still fit: the oldest samples go first, the newest watermarks stay.
  const many = Array.from({ length: 30 }, (_, index) => obs(`repo-${index}`, `Project ${index}`, [
    spot(`a${index}`, { streams: [stream(Array.from({ length: 40 }, (_, file) => `src/area/${index}/file${file}.ts`))] }),
    spot(`b${index}`, { placeId: `place-b${index}`, fingerprint: 'fp-b', streams: [stream(Array.from({ length: 40 }, (_, file) => `docs/${index}/page${file}.md`))] }),
  ]));
  for (let round = 0; round < 14; round++) { clock.advance(10 * MINUTE); await ledger.sample(many); }
  assert.ok((await fs.stat(file)).size <= 524288, 'the ledger never grows past its limit');
  assert.ok(Object.keys((await ledger.read()).repos).length >= 1);
});

test('a filtered read reports without recording, and forgetting a project removes it', async t => {
  const dataDir = await tempDir(t);
  const clock = clockFrom(Date.parse('2026-09-15T16:00:00.000Z'));
  const ledger = await createStanding({ dataDir, now: clock.now });
  t.after(() => ledger.close());
  await ledger.sample([obs('harbor', 'Harbor', [spot('m')])]);
  await ledger.mark({ repoId: 'harbor' });
  const before = await fs.readFile(path.join(dataDir, 'standing.json'), 'utf8');
  clock.advance(30 * MINUTE);
  const view = await ledger.sample([obs('harbor', 'Harbor', [spot('m', { fingerprint: 'fp-two' })])], { record: false });
  assert.deepEqual(view.moved, ['Harbor']);
  assert.equal(await fs.readFile(path.join(dataDir, 'standing.json'), 'utf8'), before, 'a filtered read leaves the ledger alone');

  // Reading the panel is not an event: an unchanged folder asked for again writes nothing at all.
  await ledger.sample([obs('harbor', 'Harbor', [spot('m', { fingerprint: 'fp-two' })])]);
  const stat = await fs.stat(path.join(dataDir, 'standing.json'), { bigint: true });
  for (let round = 0; round < 8; round++) { clock.advance(1000); await ledger.sample([obs('harbor', 'Harbor', [spot('m', { fingerprint: 'fp-two' })])]); }
  const after = await fs.stat(path.join(dataDir, 'standing.json'), { bigint: true });
  assert.equal(after.mtimeNs === stat.mtimeNs && after.ino === stat.ino, true, 'repeated reads never rewrite the ledger');
  // Once the folder really moves, the next scan is recorded.
  clock.advance(1000);
  await ledger.sample([obs('harbor', 'Harbor', [spot('m', { fingerprint: 'fp-three' })])]);
  assert.notEqual((await fs.stat(path.join(dataDir, 'standing.json'), { bigint: true })).mtimeNs, stat.mtimeNs);

  assert.equal(await ledger.forget('harbor'), true);
  assert.equal(await ledger.forget('harbor'), false);
  await assert.rejects(ledger.mark({ repoId: 'harbor' }), /has not been checked yet/);
  await assert.rejects(ledger.mark({ repoId: '' }), /short text value/);
  await assert.rejects(ledger.mark({ placeId: 'place-m' }), /only be marked inside its project/);
});

test('one project, one folder, or everything the panel has shown as read can be marked', async t => {
  const dataDir = await tempDir(t);
  const clock = clockFrom(Date.parse('2026-09-15T16:00:00.000Z'));
  const ledger = await createStanding({ dataDir, now: clock.now });
  t.after(() => ledger.close());
  const both = () => [obs('harbor', 'Harbor', [spot('m'), spot('calm', { placeId: 'place-calm', fingerprint: 'fp-calm' })]), obs('brawl', 'Brawl Draft', [spot('b', { placeId: 'place-b' })])];
  await ledger.sample(both());

  // One folder only: the other folder in the same project is still unread.
  const one = await ledger.mark({ repoId: 'harbor', placeId: 'place-calm' });
  assert.equal(one.markedPlaces, 1);
  assert.deepEqual(Object.keys((await ledger.read()).repos.harbor.seen.perPlace), ['place-calm']);

  // A plain id is the panel's own call shape.
  assert.equal((await ledger.mark('harbor')).markedPlaces, 2);
  assert.equal((await ledger.read()).repos.brawl.seen, null);

  // Null marks every project the ledger knows.
  const all = await ledger.mark(null);
  assert.equal(all.markedRepos, 2);
  clock.advance(30 * MINUTE);
  const view = await ledger.sample(both());
  assert.deepEqual(view.moved, []);
  assert.deepEqual(view.unreadRepos, []);
});

test('a stretch of time is said in the largest unit that still reads as a length', () => {
  const minutes = n => spanText(n * 60000);
  assert.equal(minutes(0), '1 minute', 'a stretch is never said as zero');
  assert.equal(minutes(1), '1 minute');
  assert.equal(minutes(44), '44 minutes');
  assert.equal(minutes(119), '119 minutes');
  assert.equal(minutes(120), '2 hours');
  assert.equal(minutes(47 * 60), '47 hours');
  // The step from hours to days never skips backwards: 47.9 hours is 2 days, not 1.
  assert.equal(minutes(2879), '2 days');
  assert.equal(minutes(9 * 24 * 60), '9 days');
  assert.equal(spanText(-1), null);
  assert.equal(spanText(NaN), null);
});

test('plain wording puts names, dates and counts in words a person reads once', () => {
  assert.equal(listText(['Harbor']), 'Harbor');
  assert.equal(listText(['Harbor', 'AutoCine']), 'Harbor and AutoCine');
  assert.equal(listText(['Harbor', 'AutoCine', 'Brawl Draft']), 'Harbor, AutoCine and Brawl Draft');
  assert.equal(listText(['a', 'b', 'c', 'd', 'e']), 'a, b, c and 2 others');
  assert.equal(listText(['a', 'b', 'c', 'd']), 'a, b, c and 1 other');
  // Built from local parts so the wording is checked in whatever zone the tests run in.
  const anchor = new Date(2026, 8, 17, 16, 0, 0).getTime();
  assert.equal(whenText(anchor, anchor), 'today at 4pm');
  assert.equal(whenText(new Date(2026, 8, 17, 16, 5, 0).getTime(), anchor), 'today at 4:05pm');
  assert.equal(whenText(new Date(2026, 8, 16, 9, 0, 0).getTime(), anchor), 'yesterday at 9am');
  assert.equal(whenText(new Date(2026, 8, 15, 16, 0, 0).getTime(), anchor), 'Tuesday at 4pm');
  assert.equal(whenText(new Date(2026, 8, 5, 16, 0, 0).getTime(), anchor), 'September 5');
  assert.equal(whenText(null, anchor), null);
  for (const value of [listText(['a', 'b']), whenText(anchor, anchor)]) assert.equal(value.includes('—'), false, 'no em dashes in anything a person reads');
});

// Work in flight fixtures, in the shape the scanner returns, so the delta wiring is exercised end to end.
function change(file, extra = {}) {
  return { path: file, origPath: null, status: 'modified', staged: false, unstaged: true, added: 4, removed: 1, binary: false, isDir: false, fileCount: null, extensions: null, size: 20, mtimeMs: 1, ...extra };
}
function wifPlace(folder, files = [], extra = {}) {
  const counts = { staged: 0, unstaged: files.length, untracked: 0, conflicted: files.filter(file => file.status === 'conflicted').length };
  return {
    path: folder, kind: 'main', isMain: true, missing: false, branch: 'main', detached: false, head: 'aaaa1111', oid: 'a'.repeat(40), upstream: 'origin/main',
    ahead: 0, behind: 0, aheadOfBase: 0, behindBase: 0, files, filesTruncated: false, counts, added: 4, removed: 1,
    lastChangedAt: '2026-09-17T09:00:00.000Z', recentSubjects: ['Initial'], fingerprint: `fp-${sha(JSON.stringify(files)).slice(0, 12)}`, error: null, ...extra,
  };
}
function wifRepo(folder, places, extra = {}) {
  return {
    path: folder, commonDir: path.join(folder, '.git'), defaultBranch: 'main', hasRemote: true, lastFetchedAt: null, places,
    branches: [{ name: 'main', tip: 'aaaa1111', subject: 'Initial', lastCommitAt: '2026-09-16T10:00:00.000Z', upstream: 'origin/main', upstreamGone: false, ahead: 0, behind: 0, aheadOfBase: 0, behindBase: 0, worktreePath: folder, recentSubjects: [], topPaths: [], added: 1, removed: 0 }],
    stashes: [], error: null, ...extra,
  };
}

test('Work in flight puts standing on the view, asks git only for folders that moved, and filters commit subjects', async t => {
  const root = await tempDir(t, 'summon-standing-wif-');
  const repo = path.join(root, 'Projects', 'Harbor');
  await fs.mkdir(path.join(repo, '.git'), { recursive: true });
  const clock = clockFrom(Date.parse('2026-09-15T16:00:00.000Z'));
  const calls = [];
  let raw = wifRepo(repo, [wifPlace(repo, [change('src/a.ts'), change('pilot/people/Jane Doe.md')])]);
  const subjects = ['Reach out to jane@example.com about the pilot', 'Update pilot/people/Jane Doe.md with the new notes', `Add ${'the templates tab '.repeat(9)}`, 'Fix the exporter', 'Tidy the grid', 'Sixth commit'];
  const wif = await createWorkInFlight({
    dataDir: path.join(root, 'Data'), homeDir: root, getProjects: async () => [{ id: 'harbor', name: 'Harbor', path: repo }], git: '/usr/bin/git', env: { PATH: '/usr/bin' }, now: clock.now,
    run: async (bin, args, options) => {
      calls.push({ bin, args, options });
      assert.equal(args.includes('--no-optional-locks'), true, 'the log call inherits the read-only global options');
      assert.equal(args[args.indexOf('diff.autoRefreshIndex=false') - 1], '-c');
      assert.equal(args.includes('log'), true);
      return { stdout: subjects.map(subject => logRecord(subject)).join(NUL) + NUL };
    },
    scan: async () => structuredClone(raw),
    excerpts: async () => new Map(), untrackedHead: async () => null, same: async () => false,
    group: async () => { throw new Error('Tests never call a model.'); },
    agentPlaces: async () => ({}),
  });
  t.after(() => wif.close());
  await wif.updateSettings({ engine: 'off', privatePaths: { [repo]: ['pilot/'] } });

  const first = await wif.read({ maxAgeMs: 0 });
  assert.equal(first.standing.text, 'Summon starts counting from now.');
  assert.deepEqual(first.standing.unreadRepos, ['Harbor']);
  assert.equal(calls.length, 0, 'the ordinary scan path never runs the log');

  // Main hands the panel's own call shape straight through: a project id, or null for everything shown as read.
  // Every shape the IPC handler can produce has to land, or the watermark never moves and the line stays empty.
  assert.equal((await wif.markStanding('harbor')).markedPlaces, 1);
  assert.equal((await wif.markStanding(null)).markedRepos, 1);
  assert.equal((await wif.markStanding()).markedRepos, 1);
  assert.equal((await wif.markStanding({ repoId: 'harbor' })).markedPlaces, 1);
  await assert.rejects(wif.markStanding(''), /short text value/);
  await assert.rejects(wif.markStanding('nope'), /has not been checked yet/);
  clock.advance(60 * MINUTE);
  raw = wifRepo(repo, [wifPlace(repo, [change('src/a.ts'), change('src/b.ts')], { oid: 'b'.repeat(40), head: 'bbbb2222' })]);
  const second = await wif.read({ maxAgeMs: 0 });
  assert.deepEqual(second.standing.moved, ['Harbor']);
  assert.equal(second.standing.landed, 6);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(-6), [`--format=%m${UNIT}%H${UNIT}%s`, '-z', '--no-color', '--left-right', '-n51', `${'a'.repeat(40)}...${'b'.repeat(40)}`]);
  assert.equal(calls[0].options.cwd, repo);
  assert.equal(calls[0].options.env.GIT_OPTIONAL_LOCKS, '0');
  const shown = second.standing.landedSubjects;
  assert.equal(shown.includes('Update pilot/people/Jane Doe.md with the new notes'), false, 'a subject that names a private folder is never shown');
  assert.equal(shown.some(item => item.includes('[private path]')), false);
  assert.equal(shown.some(item => item.includes('jane@example.com')), false, 'commit subjects are redacted like diff excerpts');
  assert.equal(shown.some(item => item.includes('[redacted]')), true);
  assert.equal(shown.every(item => item.length <= 80), true);
  assert.equal(shown.length <= 5, true);

  // A second read of the same pair answers from the cache, so a busy panel never repeats the call.
  await wif.read({ maxAgeMs: 0 });
  assert.equal(calls.length, 1);

  // A folder that changed without a new commit has nothing new to ask git about.
  clock.advance(10 * MINUTE);
  raw = wifRepo(repo, [wifPlace(repo, [change('src/a.ts'), change('src/b.ts'), change('src/c.ts')], { oid: 'b'.repeat(40), head: 'bbbb2222' })]);
  const third = await wif.read({ maxAgeMs: 0 });
  assert.deepEqual(third.standing.moved, ['Harbor']);
  assert.equal(third.standing.byRepo.harbor.moved, true);
  assert.equal(calls.length, 1, 'more files changed but the commit did not, so nothing is asked of git again');

  // A new commit is a new range, and that is asked for exactly once.
  clock.advance(10 * MINUTE);
  raw = wifRepo(repo, [wifPlace(repo, [change('src/a.ts')], { oid: 'c'.repeat(40), head: 'cccc3333' })]);
  await wif.read({ maxAgeMs: 0 });
  await wif.read({ maxAgeMs: 0 });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].args.at(-1), `${'a'.repeat(40)}...${'c'.repeat(40)}`);

  // A read for one project reports but records nothing, so the ledger only ever holds whole scans.
  const ledgerBefore = await fs.readFile(path.join(root, 'Data', 'standing.json'), 'utf8');
  await wif.read({ maxAgeMs: 0, projectId: 'harbor' });
  assert.equal(await fs.readFile(path.join(root, 'Data', 'standing.json'), 'utf8'), ledgerBefore);

  // An agent-facing core read keeps the paragraph and the rail but not the per-project bullets, which have no
  // size budget. What an agent actually receives is narrower still: the MCP adapter forwards no standing at all.
  const forAgent = await wif.read({ maxAgeMs: 0, maskPrivate: true });
  assert.deepEqual(forAgent.standing.byRepo, {});
  assert.equal(typeof forAgent.standing.text, 'string');
  assert.deepEqual(forAgent.standing.landedSubjects, third.standing.landedSubjects);

  // Adding standing never added a key to the Work in flight state file, whose whitelist would drop it.
  const saved = JSON.parse(await fs.readFile(path.join(root, 'Data', 'work-in-flight.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved).sort(), ['branchSummaries', 'groupings', 'settings', 'version']);
});

test('a delta pass over a real repository leaves the git index and every other file untouched', async t => {
  const { execFileSync } = await import('node:child_process');
  const { run, scrubbedEnv } = await import('../src/main/process.mjs');
  const { GIT_ENV } = await import('../src/core/git-scan.mjs');
  const root = await tempDir(t, 'summon-standing-git-');
  const repo = path.join(root, 'Projects', 'Harbor');
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' });
  await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  await fs.writeFile(path.join(repo, 'src', 'app.ts'), 'one\n');
  git(repo, 'init');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'Initial');
  await fs.writeFile(path.join(repo, 'src', 'app.ts'), 'one\ntwo\n');

  const wif = await createWorkInFlight({
    dataDir: path.join(root, 'Data'), homeDir: root, getProjects: async () => [{ id: 'harbor', name: 'Harbor', path: repo }],
    run, git: '/usr/bin/git', env: scrubbedEnv(GIT_ENV), group: async () => { throw new Error('Tests never call a model.'); },
  });
  t.after(() => wif.close());
  await wif.updateSettings({ engine: 'off' });
  await wif.read({ maxAgeMs: 0 });
  await wif.markStanding(null);

  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'Add a second line, see notes@example.com');
  await fs.writeFile(path.join(repo, 'src', 'later.ts'), 'later\n');

  const snapshot = async dir => {
    const out = new Map();
    const walk = async current => {
      for (const entry of await fs.readdir(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        const stat = await fs.lstat(full, { bigint: true });
        out.set(path.relative(dir, full), `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}`);
        if (entry.isDirectory()) await walk(full);
      }
    };
    await walk(dir);
    return out;
  };
  const before = await snapshot(repo);
  const view = await wif.read({ maxAgeMs: 0 });
  const after = await snapshot(repo);
  assert.deepEqual([...after].filter(([key, value]) => before.get(key) !== value), [], 'the delta pass must not change any file, including .git/index');
  assert.deepEqual([...before.keys()].filter(key => !after.has(key)), []);
  assert.equal([...after.keys()].some(key => key.endsWith('index.lock')), false);
  assert.deepEqual(view.standing.moved, ['Harbor']);
  assert.equal(view.standing.landed, 1);
  assert.deepEqual(view.standing.landedSubjects, ['Add a second line, see [redacted]']);
});

test('a watermark commit git no longer has reads as a rewritten history, never as a count', async t => {
  const { execFileSync } = await import('node:child_process');
  const { run, scrubbedEnv } = await import('../src/main/process.mjs');
  const { GIT_ENV } = await import('../src/core/git-scan.mjs');
  const root = await tempDir(t, 'summon-standing-rewrite-');
  const repo = path.join(root, 'Projects', 'Harbor');
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' });
  await fs.mkdir(repo, { recursive: true });
  await fs.writeFile(path.join(repo, 'a.txt'), 'one\n');
  git(repo, 'init');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'Initial');
  await fs.writeFile(path.join(repo, 'b.txt'), 'two\n');

  const wif = await createWorkInFlight({
    dataDir: path.join(root, 'Data'), homeDir: root, getProjects: async () => [{ id: 'harbor', name: 'Harbor', path: repo }],
    run, git: '/usr/bin/git', env: scrubbedEnv(GIT_ENV), group: async () => { throw new Error('Tests never call a model.'); },
  });
  t.after(() => wif.close());
  await wif.updateSettings({ engine: 'off' });
  await wif.read({ maxAgeMs: 0 });

  // Rewrite the watermark by hand: the recorded commit is one this repository has never heard of.
  const file = path.join(root, 'Data', 'standing.json');
  await wif.markStanding({ repoId: 'harbor' });
  const state = JSON.parse(await fs.readFile(file, 'utf8'));
  const placeId = Object.keys(state.repos.harbor.seen.perPlace)[0];
  state.repos.harbor.seen.perPlace[placeId].oid = 'd'.repeat(40);
  state.repos.harbor.seen.perPlace[placeId].fingerprint = 'gone';
  await fs.writeFile(file, JSON.stringify(state, null, 2));

  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'Add b');
  const view = await wif.read({ maxAgeMs: 0 });
  assert.deepEqual(view.standing.rewritten, ['Harbor']);
  assert.equal(view.standing.landed, 0);
  assert.deepEqual(view.standing.landedSubjects, []);
  assert.match(view.standing.text, /History was rewritten in Harbor/);
});

/** One Work in flight over a fake git, for the cases that are about what the log call says back. */
async function stubWif(t, reply) {
  const root = await tempDir(t, 'summon-standing-stub-');
  const repo = path.join(root, 'Projects', 'Harbor');
  await fs.mkdir(path.join(repo, '.git'), { recursive: true });
  const clock = clockFrom(Date.parse('2026-09-15T16:00:00.000Z'));
  const calls = [];
  const state = { raw: wifRepo(repo, [wifPlace(repo, [change('src/a.ts')])]) };
  const wif = await createWorkInFlight({
    dataDir: path.join(root, 'Data'), homeDir: root, getProjects: async () => [{ id: 'harbor', name: 'Harbor', path: repo }],
    git: '/usr/bin/git', env: { PATH: '/usr/bin' }, now: clock.now,
    run: async (bin, args, options) => { calls.push({ bin, args, options }); return reply(args); },
    scan: async () => structuredClone(state.raw),
    excerpts: async () => new Map(), untrackedHead: async () => null, same: async () => false,
    group: async () => { throw new Error('Tests never call a model.'); },
    agentPlaces: async () => ({}),
  });
  t.after(() => wif.close());
  await wif.updateSettings({ engine: 'off' });
  await wif.read({ maxAgeMs: 0 });
  await wif.markStanding(null);
  clock.advance(60 * MINUTE);
  // The folder moves on, with a new commit, so the watermark range is read exactly once.
  const moveOn = () => { state.raw = wifRepo(repo, [wifPlace(repo, [change('src/a.ts'), change('src/b.ts')], { oid: 'b'.repeat(40), head: 'bbbb2222' })]); };
  const logs = () => calls.filter(call => call.args.includes('log')).length;
  const guards = () => calls.filter(call => call.args.includes('merge-base')).length;
  return { wif, repo, root, clock, calls, state, moveOn, logs, guards };
}

test('a watermark the new tip cannot reach is a rewritten history, never a page of new saves', async t => {
  // The rebase shape: his own three commits sit on the left of the symmetric difference, the new base on the right.
  const records = [logRecord('main 40'), logRecord('my work 3', '<'), logRecord('main 39'), logRecord('my work 2', '<'), logRecord('my work 1', '<')];
  const { wif, moveOn, guards } = await stubWif(t, () => ({ stdout: records.join(NUL) + NUL }));
  moveOn();
  const view = await wif.read({ maxAgeMs: 0 });
  assert.equal(view.standing.landed, 0, 'work he made before he marked it read is not work that landed since');
  assert.deepEqual(view.standing.landedSubjects, []);
  assert.deepEqual(view.standing.rewritten, ['Harbor']);
  assert.match(view.standing.text, /History was rewritten in Harbor/);
  assert.equal(guards(), 0, 'a short page shows the divergence by itself, at no extra cost');
});

test('a full page of saves is only trusted once git says the watermark is still in this history', async t => {
  const page = Array.from({ length: 51 }, (_, index) => logRecord(`Commit number ${index}`));
  let ancestor = true;
  const { wif, moveOn, guards } = await stubWif(t, args => {
    if (!args.includes('merge-base')) return { stdout: page.join(NUL) + NUL };
    assert.equal(args.includes('--is-ancestor'), true);
    if (ancestor) return { stdout: '' };
    const error = new Error('not an ancestor');
    Object.defineProperty(error, 'exitCode', { value: 1 });
    throw error;
  });
  moveOn();
  const kept = await wif.read({ maxAgeMs: 0 });
  assert.equal(guards(), 1, 'a capped read cannot see its own left side, so it asks');
  assert.equal(kept.standing.landed, 50);
  // The count is a floor, and the paragraph says so in the same words the folder's own bullet uses.
  assert.match(kept.standing.text, /50 saves or more landed/);
  assert.equal(kept.standing.byRepo.harbor.notes.some(note => note.text === '50 saves or more landed in Main folder.'), true);

  ancestor = false;
  await wif.markStanding(null);
  await wif.updateSettings({ privatePaths: {} });
  const moved = await wif.read({ maxAgeMs: 0 });
  assert.equal(moved.standing.landed, 0, 'a watermark the tip cannot reach is never counted, however full the page');
});

test('a commit two folders both reach is counted once for the project', async t => {
  const dataDir = await tempDir(t);
  const clock = clockFrom(Date.parse('2026-09-15T16:00:00.000Z'));
  const ledger = await createStanding({ dataDir, now: clock.now });
  t.after(() => ledger.close());
  const tree = extra => spot('tree', { label: 'Claude worktree · calm', fingerprint: 'fp-tree', ...extra });
  const both = (main = {}, worktree = {}) => [obs('harbor', 'Harbor', [spot('main', main), tree(worktree)])];
  await ledger.sample(both());
  await ledger.mark({ repoId: 'harbor' });

  // The normal Summon shape: work is committed in the worktree, then merged into the folder beside it.
  clock.advance(30 * MINUTE);
  const subjects = ['Add the picker', 'Fix the picker', 'Tidy the picker'];
  const shared = { count: 3, more: false, subjects, oids: ['c0ffee01', 'c0ffee02', 'c0ffee03'], rewritten: false };
  const view = await ledger.sample(both({ fingerprint: 'fp-main-2', oid: 'b'.repeat(40) }, { fingerprint: 'fp-tree-2', oid: 'b'.repeat(40) }), {
    landedFor: request => ({ from: request.from, to: request.to, ...shared }),
  });
  assert.equal(view.landed, 3, 'three commits stay three, not one per folder that can reach them');
  assert.equal(view.byRepo.harbor.landed, 3);
  assert.deepEqual(view.landedSubjects, subjects, 'and each subject is one line, not two');
  assert.equal(view.byRepo.harbor.places['place-main'].landed, 3, 'a folder still says what its own range held');

  // A record written before commits were kept has only its own number, so an older ledger reads exactly as before.
  await ledger.mark({ repoId: 'harbor' });
  clock.advance(30 * MINUTE);
  const older = await ledger.sample(both({ fingerprint: 'fp-main-3', oid: 'c'.repeat(40) }, { fingerprint: 'fp-tree-3', oid: 'c'.repeat(40) }), {
    landedFor: request => ({ from: request.from, to: request.to, count: 2, more: false, subjects: [], rewritten: false }),
  });
  assert.equal(older.landed, 4, 'without commit ids there is nothing to match on, so the old sum stands until the next mark');
});

test('a readiness verdict is only claimed while the grouping it came from still matches the folder', async t => {
  const dataDir = await tempDir(t);
  const clock = clockFrom(Date.parse('2026-09-15T16:00:00.000Z'));
  const ledger = await createStanding({ dataDir, now: clock.now });
  t.after(() => ledger.close());
  await ledger.sample([obs('harbor', 'Harbor', [spot('m', { streams: [stream(['src/a.ts'])] })])]);
  await ledger.mark({ repoId: 'harbor' });

  clock.advance(30 * MINUTE);
  const stale = await ledger.sample([obs('harbor', 'Harbor', [spot('m', { fingerprint: 'fp-two', streams: [stream(['src/b.ts', 'src/c.ts'], 'ready')], staleGrouping: true })])]);
  assert.equal(stale.streamsReady, 0, 'the model last looked before those edits existed');
  assert.equal(/ready to save/.test(stale.text), false);
  assert.equal(stale.byRepo.harbor.notes.some(note => note.kind === 'ready'), false);

  // A grouping that has looked at what is there now still says so, and says it as the judgement it is.
  await ledger.mark({ repoId: 'harbor' });
  clock.advance(30 * MINUTE);
  const fresh = await ledger.sample([obs('harbor', 'Harbor', [spot('m', { fingerprint: 'fp-three', streams: [stream(['docs/x.md', 'docs/y.md'], 'ready')] })])]);
  assert.equal(fresh.streamsReady, 1);
  const note = fresh.byRepo.harbor.notes.find(item => item.kind === 'ready');
  assert.equal(note.inferred, true, 'ready is a model judgement, so it is marked and goes when its folder moves');
});

test('the date on the first sentence only covers the projects that sentence speaks for', async t => {
  const dataDir = await tempDir(t);
  const clock = clockFrom(Date.parse('2026-09-01T09:00:00.000Z'));
  const ledger = await createStanding({ dataDir, now: clock.now });
  t.after(() => ledger.close());
  const both = (alpha = {}) => [obs('alpha', 'Alpha', [spot('a', alpha)]), obs('bravo', 'Bravo', [spot('b')])];
  await ledger.sample(both());
  await ledger.mark(null);

  // Both were read at the same look, so one date covers them.
  clock.advance(9 * DAY);
  const together = await ledger.sample(both({ fingerprint: 'fp-two' }));
  assert.deepEqual(together.moved, ['Alpha']);
  assert.match(together.text, /^Since September 1, Alpha moved\./);

  // A three second dwell on Alpha moves only its watermark, and the counts below are measured from that one.
  await ledger.mark('alpha');
  clock.advance(30 * MINUTE);
  const apart = await ledger.sample(both({ fingerprint: 'fp-three' }));
  assert.deepEqual(apart.moved, ['Alpha']);
  assert.match(apart.text, /^Since today at [^,]+, Alpha moved\./, 'dated by the project it names, not by the oldest watermark on the Mac');
  assert.equal(apart.text.includes('September 1'), false);

  // The quiet sentence speaks for every project read, and those no longer share a date.
  await ledger.mark('alpha');
  clock.advance(30 * MINUTE);
  const quiet = await ledger.sample(both({ fingerprint: 'fp-three' }));
  assert.deepEqual(quiet.moved, []);
  assert.match(quiet.text, /^Nothing has moved since you last looked\./);

  // Marking everything puts them back on one look, and the date comes back with it.
  await ledger.mark(null);
  clock.advance(30 * MINUTE);
  const synced = await ledger.sample(both({ fingerprint: 'fp-three' }));
  assert.match(synced.text, /^Nothing has moved since today at /);
});

test('a project named as moved is never then said to have not changed', async t => {
  const dataDir = await tempDir(t);
  const clock = clockFrom(Date.parse('2026-09-01T09:00:00.000Z'));
  const ledger = await createStanding({ dataDir, now: clock.now });
  t.after(() => ledger.close());
  const main = extra => spot('main', { label: 'Main folder', fingerprint: 'fp-main', ...extra });
  const tree = () => spot('tree', { label: 'Claude worktree · calm-lighthouse', fingerprint: 'fp-tree' });
  await ledger.sample([obs('brawl', 'Brawl Draft', [main(), tree()])]);
  await ledger.mark({ repoId: 'brawl' });

  // The common shape on this Mac: the main folder is busy while a worktree has sat untouched for a fortnight.
  clock.advance(10 * DAY);
  const view = await ledger.sample([obs('brawl', 'Brawl Draft', [main({ fingerprint: 'fp-main-2' }), tree()])]);
  assert.deepEqual(view.moved, ['Brawl Draft']);
  assert.equal(/Brawl Draft has not changed/.test(view.text), false, 'one paragraph may not say a project moved and then that it did not');
  assert.match(view.text, /Brawl Draft's Claude worktree has not changed in \d+ days\./);
  assert.equal(view.notMoving.some(entry => entry.placeLabel === 'Claude worktree · calm-lighthouse'), true, 'and the rail still names the folder in full');
});

test('an ordinary set of projects keeps every folder its full ring of samples', async t => {
  const dataDir = await tempDir(t);
  const clock = clockFrom(Date.parse('2026-09-01T09:00:00.000Z'));
  const ledger = await createStanding({ dataDir, now: clock.now });
  t.after(() => ledger.close());
  // Twelve projects with three live folders each, in the id shapes the real scanner produces. Three of the four
  // "Not moving" rules need two or three samples of history, so a trimmed ring silently turns the rail into one kind.
  const many = round => Array.from({ length: 12 }, (_, project) => obs(`repo-${project}`, `Project ${project}`, Array.from({ length: 3 }, (_, folder) => spot(`p${project}f${folder}`, {
    placeId: `place-${sha(`${project}:${folder}`).slice(0, 24)}`,
    fingerprint: sha(`${project}:${folder}:${round}`), oid: sha(`${project}:${folder}:${round}`).slice(0, 40),
    streams: Array.from({ length: 4 }, (_, ws) => stream(Array.from({ length: 12 }, (_, file) => `src/area${ws}/project${project}/folder${folder}/file${file}.ts`))),
  }))));
  for (let round = 0; round < 14; round++) { clock.advance(10 * MINUTE); await ledger.sample(many(round)); }
  const state = await ledger.read();
  const counts = Object.values(state.repos).flatMap(repo => Object.values(repo.places).map(place => place.samples.length));
  assert.equal(counts.length, 36);
  assert.ok(counts.every(n => n === 12), `every folder keeps its full ring of samples, got ${[...new Set(counts)].sort().join(', ')}`);
  assert.equal(Object.keys(state.repos).length, 12, 'no project is dropped, so no watermark is lost');
});

test('a commit subject already recorded is dropped once its folder is made private', async t => {
  // A folder name Summon does not already treat as private, so this really is about the setting he just changed.
  const records = [logRecord('Move acme-pilot/onboarding docs'), logRecord('Fix login')];
  const { wif, repo, root, moveOn, logs } = await stubWif(t, () => ({ stdout: records.join(NUL) + NUL }));
  moveOn();
  const before = await wif.read({ maxAgeMs: 0 });
  assert.equal(before.standing.landedSubjects.includes('Move acme-pilot/onboarding docs'), true);
  const asked = logs();
  await wif.read({ maxAgeMs: 0 });
  assert.equal(logs(), asked, 'an unchanged filter reuses the record it already made');

  await wif.updateSettings({ privatePaths: { [repo]: ['acme-pilot/'] } });
  const after = await wif.read({ maxAgeMs: 0 });
  assert.equal(logs(), asked + 1, 'a record made under rules that no longer apply is remade, not replayed');
  assert.deepEqual(after.standing.landedSubjects, ['Fix login']);
  const saved = await fs.readFile(path.join(root, 'Data', 'standing.json'), 'utf8');
  assert.equal(saved.includes('acme-pilot'), false, 'and the text it dropped is gone from the file too');
});
