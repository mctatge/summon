import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createWorkRecovery } from '../src/core/work-recovery.mjs';

async function fixture(t, overrides = {}) {
  const dataDir = await fs.mkdtemp('/private/tmp/summon-recovery-store-');
  const repo = { id: 'repo-a', path: path.join(dataDir, 'project'), name: 'Project', places: [] };
  const other = { id: 'repo-b', path: path.join(dataDir, 'other'), name: 'Other', places: [] };
  await fs.mkdir(repo.path); await fs.mkdir(other.path);
  let now = 100000, paused = false, prefixes = [], repos = [repo, other], unavailable = false, failRead = false, failDiscovery = false;
  let onRead = null, onPersist = null, batchSize = 100, closed = 0;
  const sources = [{ provider: 'claude', sessionId: 'session-a', sessionKey: 'claude:terminal:session-a', file: path.join(dataDir, 'source.jsonl'), cwd: repo.path, events: [] }];
  const sourceReader = {
    discover: async ({ repo: selected }) => {
      if (failDiscovery) throw new Error('Source discovery unavailable');
      return { sources: unavailable ? [] : sources.filter(s => s.cwd.startsWith(selected.path)).map(({ events, ...s }) => s), warnings: [], truncated: false };
    },
    readBatch: async (descriptor, previous, { baseline = false } = {}) => {
      if (failRead) throw new Error('Source unreadable');
      const source = sources.find(s => s.sessionId === descriptor.sessionId);
      const offset = baseline ? source.events.length : previous?.offset ?? 0;
      const events = baseline ? [] : source.events.slice(offset, offset + batchSize);
      await onRead?.({ baseline });
      return { cursor: { offset: offset + events.length }, events, eof: offset + events.length >= source.events.length, warnings: [] };
    },
    close: async () => { closed++; },
  };
  const options = { dataDir, getRepositories: async () => repos, sourceReader, now: () => now, isPaused: () => paused,
    privatePathsFor: () => prefixes, persist: async (file, text) => { await onPersist?.(); await fs.writeFile(file, text, { mode: 0o600 }); }, ...overrides };
  let service = await createWorkRecovery(options);
  t.after(async () => { await service.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, repo, other, sources, get service() { return service; },
    add: (text = 'Remember to follow up on the unresolved parser behavior.', fields = {}, source = sources[0]) => {
      const event = { id: `event-${source.sessionId}-${source.events.length}`, text, role: 'user', at: ++now, cwd: source.cwd, ...fields }; source.events.push(event); return event;
    },
    enable: () => service.setEnabled({ repoId: repo.id, enabled: true }), scan: () => service.scan({ repoId: repo.id }),
    read: (fields = {}) => service.read({ repoId: repo.id, ...fields }),
    stored: async () => JSON.parse(await fs.readFile(path.join(dataDir, 'work-recovery.json'), 'utf8')),
    reload: async () => { await service.close(); service = await createWorkRecovery(options); },
    pause: v => { paused = v; }, privacy: v => { prefixes = v; }, repositories: v => { repos = v; },
    unavailable: v => { unavailable = v; }, failRead: v => { failRead = v; }, failDiscovery: v => { failDiscovery = v; },
    onRead: v => { onRead = v; }, onPersist: v => { onPersist = v; }, batchSize: v => { batchSize = v; }, clock: v => { now = v; },
  };
}

test('opt-in starts at the current boundary; new excerpts and cursors survive restart exactly once without checkpoints', async t => {
  const f = await fixture(t);
  f.add('Old history must not be imported.');
  assert.equal((await f.read()).enabled, false);
  assert.equal((await f.scan()).total, 0);
  await f.enable();
  const user = f.add(), reply = f.add('The parser behavior remains unresolved.', { role: 'assistant' });
  let view = await f.scan();
  assert.equal(view.pending, 2); assert.deepEqual(new Set(view.items.map(e => e.id)), new Set([user.id, reply.id]));
  assert.equal(JSON.stringify(view).includes('source.jsonl'), false); assert.equal(JSON.stringify(view).includes('cwd'), false);
  await f.reload();
  const offline = f.add('Also check startup recovery next time.');
  view = await f.scan(); assert.equal(view.pending, 3); assert.ok(view.items.some(e => e.id === offline.id));
  assert.equal((await f.scan()).total, 3);
  assert.deepEqual((await fs.readdir(f.dataDir)).filter(file => file.endsWith('.json')), ['work-recovery.json']);
});

test('disabled interval and old history in newly discovered sources are not backfilled', async t => {
  const f = await fixture(t); await f.enable(); f.add('Keep this.'); await f.scan();
  await f.service.setEnabled({ repoId: f.repo.id, enabled: false }); f.add('Disabled message.');
  assert.equal((await f.scan()).total, 1);
  await f.enable(); f.add('After re-enable.');
  const source = { ...f.sources[0], sessionId: 'new-session', sessionKey: 'claude:terminal:new-session', events: [] };
  f.sources.push(source); f.add('Newly discovered old history.', { at: 1 }, source); f.add('Newly discovered new message.', {}, source);
  const view = await f.scan(); assert.equal(view.total, 3); assert.equal(view.items.some(e => /Disabled|old history/.test(e.text)), false);
});

test('read and persistence failures never consume source positions or lose pending excerpts', async t => {
  const f = await fixture(t); await f.enable(); const first = f.add();
  const before = await f.stored(); f.failRead(true);
  let view = await f.scan(); assert.equal(view.pending, 0); assert.equal(view.hasMore, true);
  assert.deepEqual((await f.stored()).projects[0].sources[0].cursor, before.projects[0].sources[0].cursor);
  f.failRead(false); f.onPersist(() => { throw new Error('Disk unavailable'); });
  await assert.rejects(f.scan(), /Disk unavailable/); assert.equal((await f.read()).pending, 0); assert.ok((await f.read()).error);
  f.onPersist(null); await f.reload(); view = await f.scan(); assert.deepEqual(view.items.map(e => e.id), [first.id]);
  f.unavailable(true); view = await f.scan(); assert.equal(view.total, 1); assert.equal(view.hasMore, true);
  f.unavailable(false); f.add('Retry preserved the unread source.'); assert.equal((await f.scan()).total, 2);
});

test('capacity and bounded batches retain unread work rather than acknowledging it', async t => {
  const f = await fixture(t, { limits: { events: 2, sourcesPerScan: 1 } }); await f.enable();
  f.batchSize(1); f.add('One.'); f.add('Two.'); f.add('Three.');
  assert.equal((await f.scan()).hasMore, true); assert.equal((await f.scan()).total, 2);
  const before = await f.stored(); const view = await f.scan();
  assert.equal(view.hasMore, true); assert.match(view.warnings.join(' '), /capacity reached/);
  assert.deepEqual((await f.stored()).projects[0].sources[0].cursor, before.projects[0].sources[0].cursor);
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
