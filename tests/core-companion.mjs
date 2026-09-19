import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { createCompanion } from '../src/core/companion.mjs';

async function fixture(t, options = {}) {
  const homeDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'summon-core-')));
  const dataDir = path.join(homeDir, 'Data');
  const downloads = path.join(homeDir, 'Downloads');
  const desktop = path.join(homeDir, 'Desktop');
  const destination = path.join(homeDir, 'Filed');
  const filing = path.join(homeDir, 'Library', 'Application Support', 'Automatic Filing');
  for (const dir of [downloads, desktop, destination, path.join(filing, 'state')]) await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(filing, 'config.json'), JSON.stringify({ destinations: { workspace: destination }, finder_tags: { destinations: { workspace: ['Projects', 'Demo'] } } }));
  const journal = path.join(filing, 'state', 'moves.jsonl');
  const service = await createCompanion({ dataDir, homeDir, ...options });
  const services = [service];
  t.after(async () => { for (const current of services) await current.stop(); await fs.rm(homeDir, { recursive: true, force: true }); });
  return { service, services, homeDir, dataDir, downloads, desktop, destination, journal };
}

async function receipt(source, destination, { event = 'moved', id = 'move-1', undo_of, time = Date.now() / 1000 } = {}) {
  const st = await fs.stat(source, { bigint: true });
  const row = { event, id, time, source, destination, before: { inode: Number(st.ino), device: Number(st.dev), size: Number(st.size), mtime_ns: st.mtimeNs.toString(), birthtime_ns: st.birthtimeNs.toString() }, reason: 'test', ...(undo_of ? { undo_of } : {}) };
  // Actual Python filer emits nanosecond integers, not strings.
  return JSON.stringify(row).replace(/"((?:mtime|birthtime)_ns)":"(\d+)"/g, '"$1":$2');
}

test('tracks intake metadata, hides temporary files, and does not traverse repositories', async t => {
  const f = await fixture(t, { metadata: async () => ({ sourceUrl: 'https://example.com/course' }) });
  await fs.writeFile(path.join(f.downloads, 'lesson.xlsx'), 'sheet');
  await fs.writeFile(path.join(f.downloads, 'incomplete.crdownload'), 'partial');
  await fs.writeFile(path.join(f.desktop, '~$lesson.xlsx'), 'lock');
  await fs.mkdir(path.join(f.downloads, 'repo'));
  await fs.writeFile(path.join(f.downloads, 'repo', 'hidden.xlsx'), 'private');
  await fs.symlink(path.join(f.downloads, 'lesson.xlsx'), path.join(f.desktop, 'linked.xlsx'));
  await f.service.scan();
  const files = f.service.snapshot().files;
  assert.equal(files.length, 1);
  assert.equal(files[0].name, 'lesson.xlsx');
  assert.equal(files[0].sourceUrl, 'https://example.com/course');
  assert.equal(files[0].status, 'waiting');
  assert.equal(f.service.searchFiles('where did my Excel file go')[0].id, files[0].id);
  assert.equal(f.service.searchFiles('spreadsheet lesson')[0].id, files[0].id);
  assert.deepEqual(f.service.searchFiles('nonexistent.pdf'), []);
  assert.equal('_identity' in files[0], false);
});

test('project corrections survive filing, manual rename, restart, and undo receipts', async t => {
  const f = await fixture(t);
  const other = path.join(f.homeDir, 'Other');
  await fs.mkdir(other);
  await f.service.addProject({ name: 'Other', path: other });
  const otherId = f.service.snapshot().projects.find(p => p.name === 'Other').id;
  const source = path.join(f.downloads, 'Demo workbook.xlsx');
  const filed = path.join(f.destination, 'Demo workbook.xlsx');
  const renamed = path.join(f.destination, 'renamed.xlsx');
  await fs.writeFile(source, 'initial data');
  await f.service.scan();
  const id = f.service.snapshot().files[0].id;
  await f.service.correctFile(id, otherId);
  const moved = await receipt(source, filed);
  await fs.rename(source, filed);
  await fs.writeFile(f.journal, `${moved}\n`);
  await f.service.scan();
  assert.equal(f.service.snapshot().files.length, 1);
  assert.equal((await f.service.getFile(id)).path, filed);
  assert.equal((await f.service.getFile(id)).projectId, otherId);
  await fs.rename(filed, renamed);
  await f.service.scan();
  assert.equal((await f.service.getFile(id)).path, renamed);
  assert.equal((await f.service.getFile(id)).projectSource, 'corrected');
  await f.service.stop();
  const second = await createCompanion({ homeDir: f.homeDir, dataDir: f.dataDir });
  f.services.push(second);
  await second.scan();
  assert.equal(second.snapshot().files.length, 1);
  assert.equal((await second.getFile(id)).path, renamed);
  // Filer undo only works if file is back at its recorded destination.
  await fs.rename(renamed, filed);
  const undone = await receipt(filed, source, { event: 'undo_completed', id: 'undo-1', undo_of: 'move-1' });
  await fs.rename(filed, source);
  await fs.appendFile(f.journal, `${undone}\n`);
  await second.scan();
  const result = await second.getFile(id);
  assert.equal(result.path, source);
  assert.equal(result.projectId, otherId);
  assert.equal(result.projectSource, 'corrected');
  assert.equal(second.snapshot().files.length, 1);
  assert.equal(second.snapshot().events.filter(e => e.type === 'file-filed').length, 1);
  assert.equal(second.snapshot().events.filter(e => e.type === 'filing-undone').length, 1);
});

test('imports complete filing history and undo as one identity on first launch', async t => {
  const f = await fixture(t);
  const source = path.join(f.downloads, 'exercise.xlsx');
  const filed = path.join(f.destination, 'exercise.xlsx');
  await fs.writeFile(source, 'data');
  const moved = await receipt(source, filed);
  await fs.rename(source, filed);
  const undone = await receipt(filed, source, { event: 'undo_completed', id: 'undo-2', undo_of: 'move-1' });
  await fs.rename(filed, source);
  await fs.writeFile(f.journal, `${moved}\n${undone}\n`);
  await f.service.scan();
  assert.equal(f.service.snapshot().files.length, 1);
  assert.equal(f.service.snapshot().files[0].path, source);
  assert.equal(f.service.snapshot().files[0].status, 'present');
  assert.equal(f.service.snapshot().events.filter(e => ['file-filed', 'filing-undone'].includes(e.type)).length, 2);
  await f.service.scan();
  assert.equal(f.service.snapshot().events.filter(e => ['file-filed', 'filing-undone'].includes(e.type)).length, 2);
  assert.equal(f.service.snapshot().files[0].status, 'present');
});

test('conflicting filenames and replacement paths never steal another file identity', async t => {
  const f = await fixture(t);
  const first = path.join(f.downloads, 'same.xlsx');
  const second = path.join(f.desktop, 'same.xlsx');
  await fs.writeFile(first, 'first');
  await fs.writeFile(second, 'second');
  await f.service.scan();
  const firstId = f.service.snapshot().files.find(file => file.path === first).id;
  const secondId = f.service.snapshot().files.find(file => file.path === second).id;
  assert.notEqual(firstId, secondId);
  await fs.rename(first, path.join(f.homeDir, 'outside.xlsx'));
  await fs.writeFile(first, 'replacement');
  await f.service.scan();
  assert.equal(f.service.snapshot().files.length, 3);
  assert.equal(f.service.snapshot().files.find(file => file.id === firstId).status, 'missing');
  await assert.rejects(() => f.service.getFile(firstId), /no longer/);
  assert.equal((await f.service.getFile(secondId)).path, second);
  assert.notEqual(f.service.snapshot().files.find(file => file.path === first && file.status !== 'missing').id, firstId);
});

test('a replaced filed destination cannot be opened using the historical receipt identity', async t => {
  const f = await fixture(t);
  const source = path.join(f.downloads, 'report.pdf');
  const destination = path.join(f.destination, 'report.pdf');
  await fs.writeFile(source, 'original');
  const moved = await receipt(source, destination);
  await fs.rename(source, path.join(f.homeDir, 'outside.pdf'));
  await fs.writeFile(destination, 'replacement');
  await fs.writeFile(f.journal, `${moved}\n`);
  await f.service.scan();
  assert.equal(f.service.snapshot().files.length, 2);
  const historical = f.service.snapshot().files.find(file => file.status === 'missing');
  assert.ok(historical);
  await assert.rejects(() => f.service.getFile(historical.id), /no longer/);
});

test('an undo receipt links to the correct identity even when the old destination is occupied', async t => {
  const f = await fixture(t);
  const source = path.join(f.downloads, 'report.pdf');
  const destination = path.join(f.destination, 'report.pdf');
  await fs.writeFile(source, 'original');
  const moved = await receipt(source, destination);
  await fs.rename(source, destination);
  const undone = await receipt(destination, source, { event: 'undo_completed', id: 'undo-3', undo_of: 'move-1' });
  await fs.rename(destination, source);
  await fs.writeFile(destination, 'replacement');
  await fs.writeFile(f.journal, `${moved}\n${undone}\n`);
  await f.service.scan();
  const original = f.service.snapshot().files.find(file => file.path === source);
  const replacement = f.service.snapshot().files.find(file => file.path === destination);
  assert.notEqual(original.id, replacement.id);
  const history = f.service.snapshot().events.filter(e => ['file-filed', 'filing-undone'].includes(e.type));
  assert.equal(history.length, 2);
  assert.ok(history.every(e => e.fileId === original.id));
});

test('handles a partial journal append, malformed rows, and journal truncation without duplicate receipts', async t => {
  const f = await fixture(t);
  const source = path.join(f.downloads, 'test.pdf');
  const destination = path.join(f.destination, 'test.pdf');
  await fs.writeFile(source, 'data');
  const row = await receipt(source, destination);
  await fs.rename(source, destination);
  await fs.writeFile(f.journal, `bad json\n${row.slice(0, 50)}`);
  await f.service.scan();
  assert.equal(f.service.snapshot().events.filter(e => e.type === 'file-filed').length, 0);
  await fs.appendFile(f.journal, `${row.slice(50)}\n`);
  await f.service.scan();
  assert.equal(f.service.snapshot().events.filter(e => e.type === 'file-filed').length, 1);
  await fs.writeFile(f.journal, `${row}\n`);
  await f.service.scan();
  assert.equal(f.service.snapshot().events.filter(e => e.type === 'file-filed').length, 1);
  assert.ok(f.service.snapshot().health.errors.some(error => error.includes('malformed')));
});

test('selected context remains explicit and activity inference does not switch it', async t => {
  const f = await fixture(t);
  const selectedId = f.service.snapshot().projects[0].id;
  const other = path.join(f.homeDir, 'Other');
  await fs.mkdir(other);
  await f.service.addProject({ name: 'Other', path: other });
  await f.service.scan();
  await f.service.selectProject(selectedId);
  await fs.writeFile(path.join(f.downloads, 'ambiguous.xlsx'), 'x');
  await f.service.scan();
  const file = f.service.snapshot().files[0];
  assert.equal(file.projectId, selectedId);
  assert.equal(file.projectSource, 'selected');
  await f.service.updateSettings({ accessibilityEnabled: true });
  await f.service.ingestActivity({ app: 'Editor', bundleId: 'test.editor', documentPath: path.join(other, 'main.js') });
  const state = f.service.snapshot();
  assert.equal(state.currentProjectId, selectedId);
  assert.equal(state.activity.suggestedProjectId, state.projects.find(p => p.name === 'Other').id);
  await f.service.correctFile(file.id, null);
  await fs.rename(path.join(f.downloads, 'ambiguous.xlsx'), path.join(f.desktop, 'Demo data.xlsx'));
  await f.service.scan();
  assert.equal(f.service.snapshot().files[0].projectSource, 'corrected');
  assert.equal(f.service.snapshot().files[0].projectId, null);
});

test('first baseline does not attribute existing files to the selected workspace and recency survives scans', async t => {
  const f = await fixture(t);
  const newer = path.join(f.downloads, 'a-newer.xlsx');
  const older = path.join(f.downloads, 'z-older.xlsx');
  await fs.writeFile(older, 'old');
  await new Promise(resolve => setTimeout(resolve, 20));
  await fs.writeFile(newer, 'new');
  await f.service.selectProject(f.service.snapshot().projects[0].id);
  await f.service.scan();
  assert.ok(f.service.snapshot().files.every(file => file.projectSource !== 'selected'));
  assert.equal(f.service.searchFiles('Excel')[0].name, 'a-newer.xlsx');
  await f.service.scan();
  assert.equal(f.service.searchFiles('Excel')[0].name, 'a-newer.xlsx');
  const newest = path.join(f.downloads, 'new-arrival.xlsx');
  await fs.writeFile(newest, 'latest');
  await f.service.scan();
  assert.equal(f.service.searchFiles('Excel')[0].name, 'new-arrival.xlsx');
  assert.equal(f.service.snapshot().files.find(file => file.path === newest).projectSource, 'selected');
});

test('connecting a repo upgrades a filing project while preserving destination inference and file IDs', async t => {
  const f = await fixture(t);
  const existingId = f.service.snapshot().projects[0].id;
  const repo = path.join(f.homeDir, 'Demo');
  await fs.mkdir(repo);
  await f.service.addProject({ name: 'Demo', path: repo });
  assert.equal(f.service.snapshot().projects.length, 1);
  assert.equal(f.service.snapshot().projects[0].id, existingId);
  assert.equal(f.service.snapshot().projects[0].path, repo);
  assert.equal('_origin' in f.service.snapshot().projects[0], false);
  await fs.writeFile(path.join(f.destination, 'untitled.xlsx'), 'data');
  await f.service.scan();
  assert.equal(f.service.snapshot().files[0].projectId, existingId);
  assert.equal(f.service.snapshot().files[0].projectSource, 'inferred');
});

test('paused collection and exclusions keep private activity out of stored records', async t => {
  const f = await fixture(t);
  await f.service.updateSettings({ excludedApps: ['Private App'], accessibilityEnabled: true });
  await f.service.ingestActivity({ app: 'Public App', bundleId: 'public', title: 'A public document' });
  await f.service.ingestActivity({ app: 'Private App', bundleId: 'private', title: 'SECRET TEXT' });
  assert.equal(f.service.snapshot().activity, null);
  assert.equal(JSON.stringify(f.service.snapshot()).includes('SECRET TEXT'), false);
  await f.service.updateSettings({ paused: true });
  await fs.writeFile(path.join(f.downloads, 'paused.xlsx'), 'x');
  await f.service.ingestActivity({ app: 'Public App', bundleId: 'public', title: 'PAUSED SECRET' });
  await f.service.scan();
  assert.equal(f.service.snapshot().files.length, 0);
  assert.equal(JSON.stringify(f.service.snapshot()).includes('PAUSED SECRET'), false);
  await f.service.updateSettings({ paused: false, accessibilityEnabled: false });
  assert.equal(f.service.snapshot().files.length, 1);
  await f.service.ingestActivity({ app: 'Public App', bundleId: 'public', title: 'NO PERMISSION', documentPath: '/private/document' });
  assert.equal(f.service.snapshot().activity.title, undefined);
  assert.equal(f.service.snapshot().activity.documentPath, undefined);
  await f.service.clearActivity();
  assert.equal(f.service.snapshot().activity, null);
});

test('rejects symlink traversal and files moved outside the known scope', async t => {
  const f = await fixture(t);
  const source = path.join(f.downloads, 'source.pdf');
  const outside = path.join(f.homeDir, 'outside');
  await fs.mkdir(outside);
  const actual = path.join(outside, 'source.pdf');
  await fs.writeFile(source, 'x');
  await f.service.scan();
  const id = f.service.snapshot().files[0].id;
  await fs.rename(source, actual);
  await fs.symlink(outside, path.join(f.destination, 'linked-folder'));
  await fs.symlink(actual, source);
  await f.service.scan();
  await assert.rejects(() => f.service.getFile(id), /no longer/);
  assert.equal(f.service.snapshot().files.length, 1);
});

test('quarantines malformed state and serializes concurrent updates atomically', async t => {
  const f = await fixture(t);
  await f.service.stop();
  await fs.writeFile(path.join(f.dataDir, 'state.json'), '{broken JSON');
  const fresh = await createCompanion({ dataDir: f.dataDir, homeDir: f.homeDir });
  f.services.push(fresh);
  assert.ok(fresh.snapshot().health.errors.some(message => message.includes('preserved')));
  await Promise.all(Array.from({ length: 40 }, (_, index) => fresh.addEvent({ type: 'test', title: `Event ${index}` })));
  const state = JSON.parse(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'));
  assert.equal(state.events.length, 40);
  const names = await fs.readdir(f.dataDir);
  assert.equal(names.filter(name => name.startsWith('state.json.corrupt-')).length, 1);
  assert.equal(names.filter(name => name.endsWith('.tmp')).length, 0);
  assert.equal((await fs.stat(path.join(f.dataDir, 'state.json'))).mode & 0o777, 0o600);
});

test('retention deletes old history and invalid settings cannot rewrite state', async t => {
  const f = await fixture(t);
  await f.service.addEvent({ type: 'old', title: 'Old title', at: '2020-01-01T00:00:00.000Z' });
  await f.service.updateSettings({ retentionDays: 1 });
  assert.equal(f.service.snapshot().events.some(e => e.type === 'old'), false);
  await assert.rejects(() => f.service.updateSettings({ retentionDays: 0 }), /Retention/);
  await assert.rejects(() => f.service.updateSettings({ calendarUrl: 'javascript:alert(1)' }), /HTTP/);
  await assert.rejects(() => f.service.updateSettings({ unexpected: true }), /Unknown/);
  assert.equal(f.service.snapshot().settings.retentionDays, 1);
});

test('native metadata source URL cannot inject a local-file or credential-bearing link', async t => {
  const f = await fixture(t, { metadata: async () => ({ sourceUrl: 'file:///etc/passwd' }) });
  await fs.writeFile(path.join(f.downloads, 'sheet.xlsx'), 'x');
  await f.service.scan();
  assert.equal(f.service.snapshot().files[0].sourceUrl, undefined);
});

test('dictation punctuation preserves file-type searches and exact filename extensions', async t => {
  const f = await fixture(t);
  for (const filename of ['Forecast.xlsx', 'Budget.xlsx', 'Forecast.pdf']) await fs.writeFile(path.join(f.downloads, filename), 'data');
  await f.service.scan();
  assert.deepEqual(f.service.searchFiles('Find my Excel file.').map(file => file.name).sort(), ['Budget.xlsx', 'Forecast.xlsx']);
  assert.deepEqual(f.service.searchFiles('Forecast.xlsx.').map(file => file.name), ['Forecast.xlsx']);
  assert.deepEqual(f.service.searchFiles('Find my workbooks.').map(file => file.name).sort(), ['Budget.xlsx', 'Forecast.xlsx']);
  assert.deepEqual(f.service.searchFiles('Open Forecast.xlsx, please!').map(file => file.name), ['Forecast.xlsx']);
});

test('source metadata drops query and fragment secrets while calendar addresses retain their routing', async t => {
  const f = await fixture(t, { metadata: async () => ({ sourceUrl: 'https://example.com/course?access_token=secret#private' }) });
  await fs.writeFile(path.join(f.downloads, 'sheet.xlsx'), 'x');
  await f.service.scan();
  assert.equal(f.service.snapshot().files[0].sourceUrl, 'https://example.com/course');
  await f.service.updateSettings({ calendarUrl: 'https://calendar.example.com/view?calendar=work#week' });
  assert.equal(f.service.snapshot().settings.calendarUrl, 'https://calendar.example.com/view?calendar=work#week');
  const persisted = JSON.parse(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'));
  assert.equal(persisted.files[0].sourceUrl, 'https://example.com/course');
  // Previously persisted metadata is also sanitized when the app upgrades.
  persisted.files[0].sourceUrl = 'https://example.com/old?token=older-secret#private';
  await fs.writeFile(path.join(f.dataDir, 'state.json'), JSON.stringify(persisted));
  const restarted = await createCompanion({ dataDir: f.dataDir, homeDir: f.homeDir });
  f.services.push(restarted);
  assert.equal(restarted.snapshot().files[0].sourceUrl, 'https://example.com/old');
});

test('watcher reacts to file events without polling a repository', async t => {
  const f = await fixture(t);
  await f.service.start();
  assert.equal(f.service.snapshot().health.watching, true);
  await fs.writeFile(path.join(f.downloads, 'watched.txt'), 'x');
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && !f.service.snapshot().files.some(file => file.name === 'watched.txt')) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(f.service.snapshot().files.some(file => file.name === 'watched.txt'));
  await f.service.updateSettings({ paused: true });
  assert.equal(f.service.snapshot().health.watching, false);
});

test('readable folders use polling after event permission errors and recover to native events', async t => {
  let eventAccess = false;
  const f = await fixture(t, { watchEvents: () => {
    if (!eventAccess) throw Object.assign(new Error('Event access unavailable'), { code: 'EPERM' });
    return Object.assign(new EventEmitter(), { close() {} });
  } });
  await f.service.start();
  assert.equal(f.service.snapshot().health.watching, true);
  assert.ok(f.service.snapshot().health.errors.some(message => message.includes('EPERM') && message.includes('checking metadata')));
  assert.equal(f.service.snapshot().health.errors.some(message => message.includes('Folder access needed')), false);
  eventAccess = true;
  await f.service.updateSettings({ paused: true });
  await f.service.updateSettings({ paused: false });
  assert.equal(f.service.snapshot().health.watching, true);
  assert.equal(f.service.snapshot().health.errors.some(message => message.includes('checking metadata')), false);
});

test('denied folder reads are unconfirmed, preserve project corrections, and recover only after access works', async t => {
  const f = await fixture(t);
  const filename = path.join(f.downloads, 'private.xlsx');
  await fs.writeFile(filename, 'data');
  await f.service.scan();
  const original = f.service.snapshot().files[0];
  await f.service.correctFile(original.id, f.service.snapshot().projects[0].id);
  const correction = f.service.snapshot().files[0].reason;
  const read = fs.readdir.bind(fs);
  const lstat = fs.lstat.bind(fs);
  let denied = true;
  t.mock.method(fs, 'readdir', async (dir, ...args) => {
    if (denied && dir === f.downloads) throw Object.assign(new Error('Read denied'), { code: 'EPERM' });
    return read(dir, ...args);
  });
  t.mock.method(fs, 'lstat', async (target, ...args) => {
    if (denied && target === filename) throw Object.assign(new Error('Metadata denied'), { code: 'EACCES' });
    return lstat(target, ...args);
  });
  await f.service.scan();
  let file = f.service.snapshot().files.find(record => record.id === original.id);
  assert.equal(file.status, 'unconfirmed');
  assert.match(file.accessIssue, /Folder access needed:/);
  assert.equal(file.reason, correction);
  assert.equal(file.projectSource, 'corrected');
  assert.equal(f.service.snapshot().events.some(event => event.type === 'file-missing'), false);
  await assert.rejects(() => f.service.getFile(original.id), /Folder access needed:/);
  await f.service.addEvent({ type: 'test', title: 'Unrelated successful write' });
  assert.ok(f.service.snapshot().health.errors.some(message => message.includes('Folder access needed:')));
  denied = false;
  await f.service.scan();
  file = f.service.snapshot().files.find(record => record.id === original.id);
  assert.equal(file.status, 'waiting');
  assert.equal(file.accessIssue, undefined);
  assert.equal(file.reason, correction);
  assert.equal(f.service.snapshot().health.errors.some(message => message.includes('Folder access needed:')), false);
});

test('unreadable intake folders cannot claim a working polling fallback', async t => {
  const f = await fixture(t, { watchEvents: () => { throw Object.assign(new Error('Event permission denied'), { code: 'EACCES' }); } });
  const read = fs.readdir.bind(fs);
  t.mock.method(fs, 'readdir', async (dir, ...args) => {
    if ([f.downloads, f.desktop].includes(dir)) throw Object.assign(new Error('Folder permission denied'), { code: 'EPERM' });
    return read(dir, ...args);
  });
  await f.service.start();
  assert.equal(f.service.snapshot().health.watching, false);
  assert.ok(f.service.snapshot().health.errors.some(message => message.includes(`Folder access needed: ${f.downloads}`)));
  assert.ok(f.service.snapshot().health.errors.some(message => message.includes(`Folder access needed: ${f.desktop}`)));
});

test('successful persistence clears recovered save errors without hiding unrelated ongoing errors', async t => {
  const f = await fixture(t);
  const open = fs.open.bind(fs);
  let full = true;
  const spaceError = 'ENOSPC: simulated state write failure';
  t.mock.method(fs, 'open', async (filename, ...args) => {
    if (full && typeof filename === 'string' && filename.startsWith(path.join(f.dataDir, '.state-'))) throw Object.assign(new Error(spaceError), { code: 'ENOSPC' });
    return open(filename, ...args);
  });
  await assert.rejects(() => f.service.addEvent({ type: 'test', title: 'State write failed' }), /ENOSPC/);
  f.service.setHealth({ errors: [spaceError, 'Microphone permission is still denied.'] });
  assert.ok(f.service.snapshot().health.errors.some(message => message.startsWith('Could not save local history:')));
  full = false;
  await f.service.addEvent({ type: 'test', title: 'State write recovered' });
  assert.equal(f.service.snapshot().health.errors.some(message => message.includes(spaceError)), false);
  assert.ok(f.service.snapshot().health.errors.includes('Microphone permission is still denied.'));
  const state = JSON.parse(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'));
  assert.ok(state.events.some(event => event.title === 'State write recovered'));
});
