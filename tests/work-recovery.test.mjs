import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createWorkRecovery } from '../src/core/work-recovery.mjs';

const DAY = 24 * 60 * 60 * 1000, iso = at => new Date(at).toISOString();
const CAP = 'Older conversation excerpts were removed to stay within recovery limits.', AGE = 'Excerpts older than 30 days were removed.';

async function fixture(t, overrides = {}) {
  const dataDir = await fs.mkdtemp('/private/tmp/summon-recovery-store-');
  const repo = { id: 'repo-a', path: path.join(dataDir, 'project'), name: 'Project', places: [] };
  const other = { id: 'repo-b', path: path.join(dataDir, 'other'), name: 'Other', places: [] };
  await fs.mkdir(repo.path); await fs.mkdir(other.path);
  let now = Date.parse('2026-09-26T12:00:00.000Z'), paused = false, prefixes = [], repos = [repo, other], unavailable = false, failRead = false, failDiscovery = false;
  let onRead = null, onPersist = null, batchSize = 100, closed = 0;
  const sources = [{ provider: 'claude', sessionId: 'session-a', sessionKey: 'claude:terminal:session-a', file: path.join(dataDir, 'source.jsonl'), cwd: repo.path, events: [] }], reads = [], passes = [];
  const sourceReader = {
    discover: async ({ repo: selected, pass }) => {
      if (failDiscovery) throw new Error('Source discovery unavailable');
      passes.push(pass);
      // Like the real reader, a descriptor carries its file's size and modification time (by default its newest message).
      return { sources: unavailable ? [] : sources.filter(s => s.cwd.startsWith(selected.path)).map(({ events, mtime, ...s }) =>
        ({ ...s, size: events.length, modifiedAt: mtime ?? Math.max(0, ...events.map(e => e.at)) })), warnings: [], truncated: false };
    },
    readBatch: async (descriptor, previous, { baseline = false, baselineBefore } = {}) => {
      if (failRead) throw new Error('Source unreadable');
      const source = sources.find(s => s.sessionId === descriptor.sessionId);
      // The file's modification time is its newest message unless a test sets one.
      const atEnd = baseline || (!previous && (source.mtime ?? Math.max(0, ...source.events.map(e => e.at))) < baselineBefore);
      const offset = atEnd ? source.events.length : previous?.offset ?? 0;
      const events = atEnd ? [] : source.events.slice(offset, offset + batchSize);
      reads.push({ sessionId: source.sessionId, baseline: atEnd });
      await onRead?.({ baseline: atEnd });
      return { cursor: { offset: offset + events.length }, events, eof: offset + events.length >= source.events.length, warnings: [] };
    },
    close: async () => { closed++; },
  };
  const options = { dataDir, getRepositories: async () => repos, sourceReader, now: () => now, isPaused: () => paused,
    privatePathsFor: () => prefixes, persist: async (file, text) => { await onPersist?.(); await fs.writeFile(file, text, { mode: 0o600 }); }, ...overrides };
  let service = await createWorkRecovery(options);
  t.after(async () => { await service.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, repo, other, sources, reads, passes, get service() { return service; }, now: () => now,
    add: (text = 'Remember to follow up on the unresolved parser behavior.', fields = {}, source = sources[0]) => {
      const event = { id: `event-${source.sessionId}-${source.events.length}`, text, role: 'user', at: ++now, cwd: source.cwd, ...fields }; source.events.push(event); return event;
    },
    source: (sessionId, cwd = repo.path) => {
      const source = { provider: 'claude', sessionId, sessionKey: `claude:terminal:${sessionId}`, file: path.join(dataDir, `${sessionId}.jsonl`), cwd, events: [] };
      sources.push(source); return source;
    },
    enable: () => service.setEnabled({ repoId: repo.id, enabled: true }), scan: () => service.scan({ repoId: repo.id }), auto: () => service.scan(),
    read: (fields = {}) => service.read({ repoId: repo.id, ...fields }),
    stored: async () => JSON.parse(await fs.readFile(path.join(dataDir, 'work-recovery.json'), 'utf8')),
    reload: async () => { await service.close(); service = await createWorkRecovery(options); },
    pause: v => { paused = v; }, privacy: v => { prefixes = v; }, repositories: v => { repos = v; },
    unavailable: v => { unavailable = v; }, failRead: v => { failRead = v; }, failDiscovery: v => { failDiscovery = v; },
    onRead: v => { onRead = v; }, onPersist: v => { onPersist = v; }, batchSize: v => { batchSize = v; }, clock: v => { now = v; },
  };
}

test('a first explicit enable looks back 14 days; new excerpts and cursors survive restart exactly once without checkpoints', async t => {
  const f = await fixture(t);
  f.add('History older than the look-back must not be imported.', { at: f.now() - 15 * DAY });
  const recent = f.add('Recent history inside the look-back.', { at: f.now() - 2 * DAY });
  assert.deepEqual([(await f.read()).enabled, (await f.read()).choice], [false, null]);
  assert.equal((await f.scan()).total, 0);
  const on = await f.enable();
  assert.deepEqual([on.choice, on.lookbackFrom], ['user', iso(f.now() - 14 * DAY)]);
  const user = f.add(), reply = f.add('The parser behavior remains unresolved.', { role: 'assistant' });
  let view = await f.scan();
  assert.equal(view.pending, 3); assert.deepEqual(new Set(view.items.map(e => e.id)), new Set([recent.id, user.id, reply.id]));
  assert.equal(JSON.stringify(view).includes('source.jsonl'), false); assert.equal(JSON.stringify(view).includes('cwd'), false);
  await f.reload();
  const offline = f.add('Also check startup recovery next time.');
  view = await f.scan(); assert.equal(view.pending, 4); assert.ok(view.items.some(e => e.id === offline.id));
  assert.equal((await f.scan()).total, 4);
  assert.deepEqual((await fs.readdir(f.dataDir)).filter(file => file.endsWith('.json')), ['work-recovery.json']);
});

test('disabled interval and old history in newly discovered sources are not backfilled', async t => {
  const f = await fixture(t); await f.enable(); f.add('Keep this.'); await f.scan();
  await f.service.setEnabled({ repoId: f.repo.id, enabled: false }); f.add('Disabled message.');
  assert.equal((await f.scan()).total, 0);
  await f.enable(); f.add('After re-enable.');
  const source = { ...f.sources[0], sessionId: 'new-session', sessionKey: 'claude:terminal:new-session', events: [] };
  f.sources.push(source); f.add('Newly discovered old history.', { at: 1 }, source); f.add('Newly discovered new message.', {}, source);
  const view = await f.scan(); assert.equal(view.total, 2); assert.equal(view.items.some(e => /Disabled|old history|Keep this/.test(e.text)), false);
});

test('read and persistence failures never consume source positions or lose pending excerpts', async t => {
  const f = await fixture(t); await f.enable(); const first = f.add();
  f.failRead(true);
  let view = await f.scan(); assert.equal(view.pending, 0); assert.equal(view.hasMore, true);
  assert.deepEqual((await f.stored()).projects[0].sources.map(s => [s.cursor, s.eof]), [[null, false]]);
  f.failRead(false); f.onPersist(() => { throw new Error('Disk unavailable'); });
  await assert.rejects(f.scan(), /Disk unavailable/); assert.equal((await f.read()).pending, 0); assert.ok((await f.read()).error);
  f.onPersist(null); await f.reload(); view = await f.scan(); assert.deepEqual(view.items.map(e => e.id), [first.id]);
  f.unavailable(true); view = await f.scan(); assert.equal(view.total, 1); assert.equal(view.hasMore, true);
  f.unavailable(false); f.add('Retry preserved the unread source.'); assert.equal((await f.scan()).total, 2);
});

test('the per-project cap evicts the oldest excerpts by message time and cursors keep advancing', async t => {
  const f = await fixture(t, { limits: { events: 3 } }); await f.enable();
  f.batchSize(2); const said = ['One.', 'Two.', 'Three.', 'Four.', 'Five.'].map(text => f.add(text));
  let view;
  for (let pass = 0; pass < 5 && view?.hasMore !== false; pass++) view = await f.scan();
  const ids = async () => new Set((await f.read({ includeReviewed: true })).items.map(e => e.id));
  assert.equal(view.hasMore, false); assert.deepEqual(await ids(), new Set(said.slice(2).map(e => e.id)));
  assert.equal((await f.stored()).projects[0].sources[0].cursor.offset, 5);
  // An older catch-up message is the one dropped; a batch larger than the cap keeps its newest.
  const catchUp = f.source('catch-up'); f.add('Older catch-up message.', { at: f.now() - DAY }, catchUp);
  const burst = f.source('burst'); f.batchSize(100); const many = [1, 2, 3, 4, 5].map(i => f.add(`Burst ${i}.`, {}, burst));
  view = await f.scan();
  assert.deepEqual(await ids(), new Set(many.slice(2).map(e => e.id)));
  assert.deepEqual((await f.stored()).projects[0].sources.map(s => [s.descriptor.sessionId, s.cursor.offset, s.eof]), [['session-a', 5, true], ['catch-up', 1, true], ['burst', 5, true]]);
  assert.equal(view.hasMore, false);
  assert.equal((await f.stored()).projects[0].notices.filter(n => n === CAP).length, 1);
});

test('review is scoped, reversible, durable, and does not alter conversation evidence', async t => {
  const f = await fixture(t); await f.enable(); const event = f.add(); await f.scan();
  await assert.rejects(f.service.review({ repoId: f.other.id, id: event.id, reviewed: true }), /not in this repository/);
  const reviewed = await f.service.review({ repoId: f.repo.id, id: event.id, reviewed: true });
  assert.equal(reviewed.pending, 0); assert.equal(reviewed.total, 1); assert.deepEqual(reviewed.items, []);
  await f.reload(); const page = await f.read({ includeReviewed: true }); assert.equal(page.items[0].text, event.text); assert.ok(page.items[0].reviewedAt);
  await f.service.review({ repoId: f.repo.id, id: event.id, reviewed: false }); assert.equal((await f.read()).pending, 1);
});

test('credentials and private references are masked before persistence; new privacy restrictions scrub saved excerpts', async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.repo.path, 'pilot')); await f.enable();
  const secret = 'sk-' + 'Ab12cd34EF56gh78IJ90kl12';
  f.add(`Use ${secret} for testing and contact example@example.com. pilot/proof.txt remains open.`);
  const privateCwd = path.join(f.repo.path, 'pilot'); f.add('Keep folder-specific words.', { cwd: privateCwd });
  await f.scan(); let text = await fs.readFile(path.join(f.dataDir, 'work-recovery.json'), 'utf8');
  assert.equal(text.includes(secret), false); assert.equal(text.includes('example@example.com'), false);
  f.privacy(['pilot']); let view = await f.read();
  assert.equal(view.items.some(e => e.text.includes('pilot')), false); assert.ok(view.items.some(e => e.text === '[withheld]'));
  text = await fs.readFile(path.join(f.dataDir, 'work-recovery.json'), 'utf8'); assert.equal(text.includes('Keep folder-specific words'), false);
  // A symlink into a private folder cannot bypass the same restriction.
  await fs.symlink(privateCwd, path.join(f.repo.path, 'alias')); f.add('Private alias evidence.', { cwd: path.join(f.repo.path, 'alias') });
  view = await f.scan(); assert.equal(view.total, 2);
});

test('privacy and repository changes during reads reject the entire cursor commit', async t => {
  const f = await fixture(t); await f.enable(); f.add('Pending private scope check.');
  const before = await f.stored(); f.onRead(() => { f.privacy(['new-private']); });
  await assert.rejects(f.scan(), /privacy settings changed/);
  assert.deepEqual(await f.stored(), before);
  f.onRead(null); assert.equal((await f.scan()).total, 1);
  f.repositories([{ ...f.repo, path: f.other.path }]); await assert.rejects(f.read(), /folder changed/);
});

test('removing an old folder or worktree keeps its evidence while later privacy restrictions still apply', async t => {
  const f = await fixture(t); const folder = path.join(f.repo.path, 'temporary'); await fs.mkdir(folder); await f.enable();
  f.add('Keep the unresolved result after this folder is removed.', { cwd: folder }); await f.scan(); await fs.rmdir(folder);
  assert.match((await f.read()).items[0].text, /Keep the unresolved result/);
  await f.reload(); assert.match((await f.read()).items[0].text, /Keep the unresolved result/);
  f.privacy(['temporary']); assert.equal((await f.read()).items[0].text, '[withheld]');
});

test('pausing observation prevents reads and preserves material for resumption; one scope cannot expose another', async t => {
  const f = await fixture(t); await f.enable(); f.add(); f.pause(true);
  f.onRead(() => { throw new Error('Must not read when paused'); });
  assert.equal((await f.scan()).paused, true); assert.equal((await f.read()).total, 0);
  f.pause(false); f.onRead(null); assert.equal((await f.scan()).total, 1);
  assert.equal((await f.service.read({ repoId: f.other.id })).total, 0);
  await assert.rejects(f.service.read({ repoId: 'unknown' }), /registered repository/);
  await assert.rejects(f.read({ limit: 21 }), /page/);
});

test('concurrent scan and review calls serialize without duplicating or dropping excerpts', async t => {
  const f = await fixture(t); await f.enable(); const e = f.add();
  await Promise.all([f.scan(), f.scan(), f.service.review({ repoId: f.repo.id, id: e.id, reviewed: true }), f.scan()]);
  assert.equal((await f.read()).pending, 0); assert.equal((await f.read()).total, 1);
});

test('userMessages returns only re-masked user excerpts of enabled projects, without local paths, and nothing while paused', async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.repo.path, 'pilot'));
  assert.deepEqual(await f.service.userMessages(), []);
  await f.enable();
  const said = f.add('We just sent Professor Rivera the follow-up email.');
  f.add('Here is a draft reply for Professor Rivera.', { role: 'assistant' });
  const hidden = f.add('Folder-specific note.', { cwd: path.join(f.repo.path, 'pilot') });
  await f.scan();
  let list = await f.service.userMessages();
  assert.deepEqual(list.map(entry => entry.repoId), [f.repo.id]);
  assert.deepEqual(list[0].messages.map(m => m.id), [said.id, hidden.id]);
  assert.deepEqual(Object.keys(list[0].messages[0]).sort(), ['at', 'id', 'provider', 'sessionKey', 'text', 'truncated']);
  assert.deepEqual({ ...list[0].messages[0] }, { id: said.id, provider: 'claude', sessionKey: 'claude:terminal:session-a', text: said.text, at: new Date(said.at).toISOString(), truncated: false });
  f.privacy(['pilot']); list = await f.service.userMessages();
  assert.deepEqual(list[0].messages.map(m => m.id), [said.id]);
  assert.equal((await fs.readFile(path.join(f.dataDir, 'work-recovery.json'), 'utf8')).includes('Folder-specific note'), false);
  f.pause(true); assert.deepEqual(await f.service.userMessages(), []); f.pause(false);
  f.repositories([f.other]); assert.deepEqual(await f.service.userMessages(), []); f.repositories([f.repo, f.other]);
  await f.service.setEnabled({ repoId: f.repo.id, enabled: false });
  assert.deepEqual(await f.service.userMessages(), []);
});

test('an excerpt that masking lengthens past the bound is marked shortened', async t => {
  const f = await fixture(t); await f.enable();
  const tail = ` CC list: ${Array.from({ length: 10 }, (_, i) => `q${i}@x.io`).join(' ')}. I sent Rivera the follow up draft but she has not replied.`;
  const said = f.add('Notes on the retreat seating plan.'.padEnd(990 - tail.length, ' Notes on the retreat seating plan.') + tail);
  const short = f.add('A short note.');
  await f.scan();
  const [project] = await f.service.userMessages();
  const [cut, kept] = project.messages;
  assert.deepEqual([cut.id, cut.text.length > 990 && cut.text.length <= 1000, cut.truncated, cut.text.includes('has not replied')], [said.id, true, true, false]);
  assert.deepEqual([kept.id, kept.truncated], [short.id, false]);
});

test('the real atomic journal is private and corrupt input is never silently replaced', async t => {
  const f = await fixture(t, { persist: undefined }); await f.enable(); f.add(); await f.scan();
  const file = path.join(f.dataDir, 'work-recovery.json'); assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await fs.readdir(f.dataDir)).some(name => name.endsWith('.tmp')), false);
  await fs.writeFile(file, '{corrupt');
  await assert.rejects(createWorkRecovery({ dataDir: f.dataDir, getRepositories: async () => [f.repo], sourceReader: { discover() {}, readBatch() {} } }), /JSON/);
  assert.equal(await fs.readFile(file, 'utf8'), '{corrupt');
});

test('automatic checks turn on every in-scope project without a record, looking back 14 days; explicit checks and pauses never do', async t => {
  const f = await fixture(t);
  const missing = { id: 'repo-missing', path: path.join(f.dataDir, 'missing'), name: 'Missing', places: [] };
  f.repositories([f.repo, missing, f.other]);
  f.add('Older than the look-back.', { at: f.now() - 15 * DAY }); const recent = f.add('Inside the look-back.', { at: f.now() - 3 * DAY });
  assert.equal((await f.scan()).choice, null);
  f.pause(true); assert.equal(await f.auto(), null); f.pause(false);
  await assert.rejects(f.stored(), /ENOENT/);
  assert.deepEqual([(await f.read()).enabled, (await f.read()).choice], [false, null]);
  await f.auto();
  const view = await f.read();
  assert.deepEqual([view.enabled, view.choice, view.lookbackFrom, view.items.map(e => e.id)], [true, 'default', iso(f.now() - 14 * DAY), [recent.id]]);
  assert.deepEqual((await f.stored()).projects.map(p => [p.repoId, p.enabled, p.choice, p.lookbackFrom]),
    [[f.repo.id, true, 'default', iso(f.now() - 14 * DAY)], [f.other.id, true, 'default', iso(f.now() - 14 * DAY)]]);
});

test('an explicit off is never overridden by default capture, including one saved before the first automatic check', async t => {
  const f = await fixture(t); f.add();
  const off = await f.service.setEnabled({ repoId: f.repo.id, enabled: false });
  assert.deepEqual([off.enabled, off.choice], [false, 'user']);
  assert.deepEqual((await f.stored()).projects.map(p => [p.repoId, p.enabled, p.choice, p.disabledAt]), [[f.repo.id, false, 'user', iso(f.now())]]);
  await f.auto(); await f.auto();
  assert.deepEqual([(await f.read()).enabled, (await f.read()).total], [false, 0]);
  assert.equal((await f.service.read({ repoId: f.other.id })).choice, 'default');
  await f.service.setEnabled({ repoId: f.other.id, enabled: false }); await f.auto();
  assert.deepEqual((await f.stored()).projects.map(p => [p.enabled, p.choice]), [[false, 'user'], [false, 'user']]);
});

test('sources last modified before the look-back are not tracked; recent ones are read from the start and filtered', async t => {
  const f = await fixture(t);
  f.add('Stale history.', { at: f.now() - 20 * DAY });
  const active = f.source('active'); f.add('Too old to keep.', { at: f.now() - 20 * DAY }, active);
  const kept = f.add('Recent enough.', { at: f.now() - DAY }, active);
  await f.auto();
  assert.deepEqual(f.reads.map(r => [r.sessionId, r.baseline]), [['active', false]]);
  assert.deepEqual([(await f.read()).items.map(e => e.id), (await f.stored()).projects[0].sources.map(s => s.descriptor.sessionId)], [[kept.id], ['active']]);
  // Appending makes the file recent: it is then read from the start, and its old message is still filtered out.
  const later = f.add('Appended after the look-back start.');
  await f.auto();
  assert.deepEqual(f.reads.slice(1).map(r => [r.sessionId, r.baseline]), [['session-a', false]]);
  assert.deepEqual(new Set((await f.read()).items.map(e => e.id)), new Set([kept.id, later.id]));
});

test('turning a project off deletes its saved excerpts and positions but remembers the off choice', async t => {
  const f = await fixture(t); await f.enable(); const said = f.add('We sent the draft to Rivera.'); await f.scan();
  assert.equal((await f.service.userMessages())[0].messages.some(m => m.id === said.id), true);
  const off = await f.service.setEnabled({ repoId: f.repo.id, enabled: false });
  assert.deepEqual([off.enabled, off.choice, off.total, off.sources], [false, 'user', 0, 0]);
  const [stored] = (await f.stored()).projects;
  assert.deepEqual([stored.events, stored.sources, stored.enabled, stored.choice, typeof stored.disabledAt], [[], [], false, 'user', 'string']);
  assert.equal((await fs.readFile(path.join(f.dataDir, 'work-recovery.json'), 'utf8')).includes('Rivera'), false);
  await f.auto(); assert.equal((await f.stored()).projects[0].enabled, false);
});

test('turning a project back on starts at that moment and never imports its off period', async t => {
  const f = await fixture(t); await f.enable(); const before = f.add('Captured while on.'); await f.scan();
  await f.service.setEnabled({ repoId: f.repo.id, enabled: false });
  f.clock(f.now() + DAY); f.add('Said while recovery was off.');
  const offAt = f.now(); f.clock(f.now() + DAY);
  const on = await f.enable();
  assert.deepEqual([on.enabled, on.choice, on.lookbackFrom], [true, 'user', iso(f.now())]);
  // A session found only after turning it back on still cannot bring in the off period.
  const late = f.source('late'); f.add('Also said while off.', { at: offAt }, late);
  const after = f.add('Said after turning it back on.'), lateAfter = f.add('Later reply in the new session.', {}, late);
  let view;
  for (let pass = 0; pass < 5 && view?.hasMore !== false; pass++) view = await f.auto();
  assert.deepEqual(new Set((await f.read({ includeReviewed: true })).items.map(e => e.id)), new Set([after.id, lateAfter.id]));
  assert.equal(before.id !== after.id, true);
});

test('retention removes excerpts older than 30 days, reviewed or not, with one notice, also while off', async t => {
  const f = await fixture(t); await f.enable(); const first = f.add('First.'); f.add('Second.'); await f.scan();
  await f.service.review({ repoId: f.repo.id, id: first.id, reviewed: true });
  f.clock(f.now() + 31 * DAY); const current = f.add('Current.');
  let view = await f.scan();
  assert.deepEqual([view.total, view.items.map(e => e.id)], [1, [current.id]]);
  f.clock(f.now() + 31 * DAY); const newest = f.add('Newest.');
  view = await f.scan();
  assert.deepEqual(view.items.map(e => e.id), [newest.id]);
  assert.equal((await f.stored()).projects[0].notices.filter(n => n === AGE).length, 1);
  await f.service.setEnabled({ repoId: f.repo.id, enabled: false }); f.clock(f.now() + 31 * DAY); await f.auto();
  assert.deepEqual([(await f.read({ includeReviewed: true })).total, (await f.stored()).projects[0].enabled], [0, false]);
});

test('the journal byte cap evicts the globally oldest excerpts across projects and cursors still advance', async t => {
  const limit = 8000, f = await fixture(t, { limits: { journalBytes: limit } });
  const long = label => `${label} ${'follow-up detail '.repeat(55)}`;
  const elsewhere = f.source('elsewhere', f.other.path);
  await f.enable(); await f.service.setEnabled({ repoId: f.other.id, enabled: true });
  const old = [1, 2, 3].map(i => f.add(long(`Other ${i}.`), {}, elsewhere)); await f.service.scan({ repoId: f.other.id });
  const fresh = [1, 2, 3].map(i => f.add(long(`Project ${i}.`)));
  // A failed write must not have evicted anything from the other project's saved record.
  f.onPersist(() => { throw new Error('Disk unavailable'); }); await assert.rejects(f.scan(), /Disk unavailable/); f.onPersist(null);
  assert.equal((await f.service.read({ repoId: f.other.id, includeReviewed: true })).total, 3);
  const view = await f.scan();
  const journal = path.join(f.dataDir, 'work-recovery.json'), stored = await f.stored();
  const other = await f.service.read({ repoId: f.other.id, includeReviewed: true });
  assert.ok((await fs.stat(journal)).size <= limit);
  assert.deepEqual(new Set(view.items.map(e => e.id)), new Set(fresh.map(e => e.id)));
  assert.deepEqual(new Set(other.items.map(e => e.id)), new Set(old.slice(1).map(e => e.id)));
  assert.deepEqual(stored.projects.map(p => p.notices.filter(n => n === CAP).length), [0, 1]);
  assert.deepEqual(stored.projects.map(p => p.sources[0].cursor.offset), [3, 3]);
});

test('when every project slot is taken, default capture follows repository order and reports what was left out', async t => {
  const f = await fixture(t, { limits: { projects: 1 } });
  f.repositories([f.other, f.repo]);
  const view = await f.auto();
  assert.equal(view.repoId, f.other.id); assert.ok(view.warnings.includes('Conversation recovery project limit reached. 1 more repository is not captured.'));
  const left = await f.read();
  assert.deepEqual([left.enabled, left.choice], [false, 'default']); assert.ok(left.warnings.includes('Conversation recovery project limit reached. This project is not captured.'));
  assert.deepEqual((await f.stored()).projects.map(p => p.repoId), [f.other.id]);
});

test('an old-format journal loads with its choices and boundaries unchanged, and new fields are type-checked', async t => {
  const f = await fixture(t); const journal = path.join(f.dataDir, 'work-recovery.json'), enabledAt = iso(f.now() - 5 * DAY);
  const legacy = (repo, enabled, events = []) => ({ repoId: repo.id, repoPath: repo.path, enabled, enabledAt, checkedAt: enabledAt,
    sources: [], events, warnings: [], notices: [], hasMore: false, nextSource: 0, createdAt: enabledAt });
  const saved = { id: 'legacy-1', provider: 'claude', sessionKey: 'claude:terminal:session-a', role: 'user', text: 'Saved before the update.',
    at: enabledAt, capturedAt: enabledAt, truncated: false, reviewedAt: null, cwd: f.repo.path, root: f.repo.path };
  await fs.writeFile(journal, JSON.stringify({ version: 1, projects: [legacy(f.repo, true, [saved]), legacy(f.other, false)] }));
  await f.reload();
  f.add('Inside 14 days but before enabling: not backfilled.', { at: f.now() - 6 * DAY }); const kept = f.add('After enabling.', { at: f.now() - 4 * DAY });
  await f.auto();
  const view = await f.read(), other = await f.service.read({ repoId: f.other.id });
  assert.deepEqual([view.enabled, view.choice, view.lookbackFrom, new Set(view.items.map(e => e.id))], [true, 'user', enabledAt, new Set([saved.id, kept.id])]);
  assert.deepEqual([other.enabled, other.choice, other.lookbackFrom, other.total], [false, 'user', enabledAt, 0]);
  const reader = { discover() {}, readBatch() {} };
  for (const field of [{ choice: 'maybe' }, { lookbackFrom: 5 }, { disabledAt: 'not a time' }]) {
    await fs.writeFile(journal, JSON.stringify({ version: 1, projects: [{ ...legacy(f.repo, true), ...field }] }));
    await assert.rejects(createWorkRecovery({ dataDir: f.dataDir, getRepositories: async () => [f.repo], sourceReader: reader }), /unsupported or damaged/);
  }
});

test('a restart in the middle of a look-back catch-up resumes from saved cursors without duplicates', async t => {
  const f = await fixture(t, { limits: { sourcesPerScan: 1 } }); f.batchSize(1);
  const second = f.source('second');
  const expected = [f.add('A1.', { at: f.now() - 3 * DAY }), f.add('A2.', { at: f.now() - 2 * DAY }), f.add('B1.', { at: f.now() - DAY }, second), f.add('B2.', {}, second), f.add('A3.')];
  let view, passes = 0;
  for (; passes < 20 && view?.hasMore !== false; passes++) { await f.auto(); await f.reload(); view = await f.read({ includeReviewed: true }); }
  assert.ok(passes > 2);
  assert.deepEqual(view.items.map(e => e.id).sort(), expected.map(e => e.id).sort());
  assert.deepEqual((await f.stored()).projects[0].sources.map(s => s.cursor.offset), [3, 2]);
});

test('one automatic check shares one source inventory, and an unchanged check neither reopens finished sources nor rewrites the journal', async t => {
  const f = await fixture(t); let writes = 0; f.onPersist(() => { writes++; });
  const elsewhere = f.source('elsewhere', f.other.path);
  f.add('First project message.'); f.add('Second project message.', {}, elsewhere);
  await f.auto(); await f.auto();
  assert.equal(f.passes.length, 4); assert.ok(f.passes[0] && f.passes[0] === f.passes[1] && f.passes[2] === f.passes[3] && f.passes[0] !== f.passes[2]);
  assert.equal((await f.read()).total, 1);
  const reads = f.reads.length; writes = 0;
  for (let i = 0; i < 3; i++) await f.auto();
  assert.deepEqual([f.reads.length - reads, writes], [0, 0]);
  const said = f.add('Appended to one source only.', {}, elsewhere);
  await f.auto();
  assert.deepEqual(f.reads.slice(reads).map(r => r.sessionId), ['elsewhere']);
  assert.ok((await f.service.read({ repoId: f.other.id })).items.some(e => e.id === said.id));
});

test('a project turned off or no longer registered frees its slot for a project the user turns on', async t => {
  const f = await fixture(t, { limits: { projects: 2 } });
  const third = { id: 'repo-c', path: path.join(f.dataDir, 'third'), name: 'Third', places: [] }; await fs.mkdir(third.path);
  const stored = async () => (await f.stored()).projects.map(p => [p.repoId, p.enabled, p.choice]);
  f.repositories([f.repo, f.other, third]); f.add('Said in the first project.');
  await f.auto();
  assert.deepEqual((await f.service.read({ repoId: third.id })).choice, 'default');
  await assert.rejects(f.service.setEnabled({ repoId: third.id, enabled: true }), /limit reached. Turn another project off first/);
  await f.service.setEnabled({ repoId: f.other.id, enabled: false });
  const on = await f.service.setEnabled({ repoId: third.id, enabled: true });
  assert.deepEqual([on.enabled, on.choice, on.lookbackFrom], [true, 'user', iso(f.now() - 14 * DAY)]);
  // An unregistered project keeps its record and excerpts but no slot, so the next repository is turned on by default.
  const fourth = { id: 'repo-d', path: path.join(f.dataDir, 'fourth'), name: 'Fourth', places: [] }; await fs.mkdir(fourth.path);
  f.repositories([f.other, third, fourth]); await f.auto();
  assert.deepEqual(await stored(), [[f.repo.id, true, 'default'], [f.other.id, false, 'user'], [third.id, true, 'user'], [fourth.id, true, 'default']]);
  // Registered again, it waits for a slot instead of exceeding the bound.
  f.repositories([f.repo, f.other, third, fourth]); await f.auto();
  assert.match((await f.service.read({ repoId: fourth.id })).error, /waits until another project is turned off/);
  assert.equal((await f.read()).total, 1);
});

test('retention removes old excerpts of a project that is no longer registered', async t => {
  const f = await fixture(t); f.add('Said before the project was removed.'); await f.auto();
  assert.equal((await f.read()).total, 1);
  f.repositories([f.other]); f.clock(f.now() + 31 * DAY); await f.auto();
  const [project] = (await f.stored()).projects.filter(p => p.repoId === f.repo.id);
  assert.deepEqual([project.events, project.sources, project.notices.includes(AGE)], [[], [], true]);
});

test('old and deleted sources never keep a new session from being tracked', async t => {
  const f = await fixture(t, { limits: { sources: 3 } });
  const tracked = async () => (await f.stored()).projects[0].sources.map(s => s.descriptor.sessionId);
  for (const id of ['old-1', 'old-2', 'old-3']) f.add(`Old ${id}.`, { at: f.now() - 60 * DAY }, f.source(id));
  await f.auto();
  const fresh = f.source('fresh'), said = f.add('We just sent the vendor the follow-up email.', {}, fresh);
  await f.auto();
  assert.deepEqual([await tracked(), (await f.read()).items.map(e => e.id)], [['fresh'], [said.id]]);
  // At the limit the most recently changed sources are tracked, so a deleted transcript gives way to a new session.
  const first = f.source('r-1'), second = f.source('r-2'); f.add('Recent one.', {}, first); f.add('Recent two.', {}, second);
  await f.auto(); f.sources.splice(f.sources.indexOf(fresh), 1);
  const later = f.add('A later session.', {}, f.source('later'));
  await f.auto();
  assert.deepEqual([(await tracked()).sort(), (await f.read()).items.some(e => e.id === later.id)], [['later', 'r-1', 'r-2'], true]);
  // A deleted transcript stays tracked, and reported, until 30 days after it last changed.
  f.sources.splice(f.sources.indexOf(first), 1); f.clock(f.now() + DAY); await f.auto();
  assert.deepEqual([(await tracked()).includes('r-1'), (await f.read()).hasMore], [true, true]);
  f.clock(f.now() + 30 * DAY); await f.auto();
  assert.deepEqual([(await f.read()).hasMore, await tracked()], [false, []]);
});

test('excerpts are listed by message time even when a catch-up captures older messages later', async t => {
  const f = await fixture(t, { limits: { sourcesPerScan: 1 } });
  const yesterday = f.add('Yesterday.', { at: f.now() - DAY });
  const older = f.source('older'), early = [13, 12].map(days => f.add(`${days} days ago.`, { at: f.now() - days * DAY }, older));
  for (let i = 0; i < 4; i++) { f.clock(f.now() + 60000); await f.auto(); }
  assert.deepEqual((await f.read()).items.map(e => e.id), [yesterday.id, early[1].id, early[0].id]);
});

test('unread sources are visited first, so a restart between checks cannot starve a pending source', async t => {
  const f = await fixture(t, { limits: { sourcesPerScan: 1 } }); f.batchSize(1);
  f.add('Only message in the first session.');
  const pending = f.source('pending'); ['One.', 'Two.', 'Three.'].forEach(text => f.add(text, {}, pending));
  await f.enable(); await f.scan(); await f.scan();
  for (let i = 0; i < 4; i++) { await f.reload(); await f.scan(); }
  assert.equal((await f.read()).total, 4);
  assert.deepEqual((await f.stored()).projects[0].sources.map(s => [s.descriptor.sessionId, s.cursor.offset, s.eof]), [['session-a', 1, true], ['pending', 3, true]]);
});

