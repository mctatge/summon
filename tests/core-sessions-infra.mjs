import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  crc32c, snappyDecompress, snappyCompressForTests, readLocalStorageKeys, readLocalStorageDetails, logRecords, tableRecords,
  encodeLogFileForTests, encodeTableFileForTests, localStorageKeyForTests, localStorageValueForTests,
} from '../src/core/sessions/leveldb.mjs';
import { createSqliteSnapshots } from '../src/core/sessions/sqlite-snapshot.mjs';
import { isReadOnlySql, checkStatements, runStatements } from '../src/core/sessions/sqlite-worker.mjs';
import { PS_ARGS, listProcesses, parseProcessList, parseLstart, isAlive, findProcesses } from '../src/core/sessions/processes.mjs';
import { run } from '../src/main/process.mjs';

const ORIGIN = 'https://claude.ai';

async function tempRoot(t, prefix = 'summon-test-infra-') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

// Every entry under `dir` with identity, size, times and mode; used to prove nothing was written or created.
async function treeSnapshot(dir) {
  const out = new Map();
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const stat = await fs.lstat(full, { bigint: true });
    const bytes = entry.isFile() ? (await fs.readFile(full)).toString('base64') : '';
    out.set(entry.name, `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}:${bytes}`);
  }
  return out;
}

const bytes = (...parts) => Buffer.concat(parts.map(part => (typeof part === 'string' ? Buffer.from(part, 'latin1') : Buffer.from(part))));

// ---------------------------------------------------------------------------------------------
// Snappy + CRC
// ---------------------------------------------------------------------------------------------

test('crc32c matches the Castagnoli check value', () => {
  assert.equal(crc32c(Buffer.from('123456789')), 0xe3069283);
  assert.equal(crc32c(Buffer.from('456789'), 0, 6, crc32c(Buffer.from('123'))), 0xe3069283);
});

test('snappy decodes hand-built literals of every length form', () => {
  assert.equal(snappyDecompress(bytes([3, 2 << 2], 'abc')).toString(), 'abc');
  const x61 = 'x'.repeat(61);
  assert.equal(snappyDecompress(bytes([61, 60 << 2, 60], x61)).toString(), x61);
  const y300 = 'y'.repeat(300);
  assert.equal(snappyDecompress(bytes([0xac, 0x02, 61 << 2, 0x2b, 0x01], y300)).toString(), y300);
  // Non-minimal 3- and 4-byte length forms are valid too.
  assert.equal(snappyDecompress(bytes([5, 62 << 2, 4, 0, 0], 'hello')).toString(), 'hello');
  assert.equal(snappyDecompress(bytes([5, 63 << 2, 4, 0, 0, 0], 'world')).toString(), 'world');
  assert.equal(snappyDecompress(Buffer.from([0])).length, 0);
});

test('snappy decodes 1-, 2- and 4-byte offset copies, including overlapping runs', () => {
  // "abcd" then copy1 length 8 offset 4.
  assert.equal(snappyDecompress(bytes([12, 3 << 2], 'abcd', [1 | (4 << 2), 4])).toString(), 'abcdabcdabcd');
  // copy1 whose offset uses the high three bits in the tag: offset 261.
  const head = 'q'.repeat(260) + 'Z';
  const stream = bytes([0x89, 0x02], [61 << 2, 260 & 0xff, 260 >> 8], head, [1 | (0 << 2) | (1 << 5), 5]);
  assert.equal(snappyDecompress(stream).toString(), head + 'qqqq');
  // copy2 length 6 offset 2 overlaps its own output.
  assert.equal(snappyDecompress(bytes([8, 1 << 2], 'ab', [2 | (5 << 2), 2, 0])).toString(), 'abababab');
  // copy4 length 3 offset 3.
  assert.equal(snappyDecompress(bytes([6, 2 << 2], 'xyz', [3 | (2 << 2), 3, 0, 0, 0])).toString(), 'xyzxyz');
});

test('snappy rejects malformed streams without reading or writing out of bounds', () => {
  const bad = [
    bytes([4, 0 << 2], 'a', [1, 0]), // copy offset 0
    bytes([6, 0 << 2], 'a', [1 | (1 << 2), 2]), // offset beyond output
    bytes([3, 3 << 2], 'abcd'), // literal longer than declared output
    bytes([10, 9 << 2], 'abc'), // literal runs past input
    bytes([10, 2 << 2], 'abc'), // output shorter than declared
    bytes([0xff, 0xff, 0xff, 0xff, 0xff, 0x01]), // varint too long
    bytes([0xff, 0xff, 0xff, 0x7f, 0], 'a'), // claims far more output than the input can make
    bytes([4, 0 << 2], 'a', [2]), // copy2 cut off
    bytes([4, 60 << 2]), // literal length byte missing
  ];
  for (const stream of bad) assert.throws(() => snappyDecompress(stream), /Snappy/);
  assert.throws(() => snappyDecompress(bytes([5, 4 << 2], 'hello'), { maxLength: 4 }), /larger than allowed/);
});

test('snappy round-trips fixture streams with literals and every copy form', () => {
  const inputs = [
    Buffer.alloc(0),
    randomBytes(100_000),
    Buffer.from('{"state":{"unreadIds":["local_1","local_2","local_1","local_2"]}}'.repeat(400)),
    Buffer.alloc(70_000, 7),
    Buffer.from(Array.from({ length: 5000 }, (_, i) => `epitaxy-session-result:local_${i}`).join('')),
  ];
  for (const input of inputs) {
    for (const options of [{}, { useCopy4: true }, { literalOnly: true }, { literalOnly: true, maxLiteral: 50 }]) {
      const packed = snappyCompressForTests(input, options);
      assert.deepEqual(snappyDecompress(packed, { maxLength: 1 << 24 }), input);
    }
  }
  const repetitive = inputs[2];
  assert.ok(snappyCompressForTests(repetitive).length < repetitive.length / 10);
});

// ---------------------------------------------------------------------------------------------
// LevelDB localStorage
// ---------------------------------------------------------------------------------------------

const unread = ids => JSON.stringify({ version: 1, state: { unreadIds: ids, explicitUnreadIds: [] } });

test('log file: Latin-1 and UTF-16 values, deletions, newer sequence wins, other origins ignored', async t => {
  const dir = await tempRoot(t);
  const log = Buffer.concat([
    encodeLogFileForTests([
      { key: 'epitaxy-unread-v1', value: unread(['local_old']), seq: 5 },
      { key: 'epitaxy-unread-v1', value: unread(['local_a', 'local_b']), seq: 9 },
      { key: 'wide', value: 'Grüße ✓ 日本', seq: 10 },
      { key: 'gone', value: 'soon deleted', seq: 11 },
      { key: 'gone', deleted: true, seq: 12 },
      { key: 'ключ', value: 'non-Latin-1 key', seq: 13 },
      { key: 'latin', value: 'café', seq: 14, encoding: 'utf16' },
    ], { origin: ORIGIN }),
  ]);
  // A second writer origin with the same key name must not leak in, even with a higher sequence.
  const other = encodeLogFileForTests([{ key: 'epitaxy-unread-v1', value: unread(['local_evil']), seq: 99 }], { origin: 'https://claude.ai.evil.example' });
  await fs.writeFile(path.join(dir, '000003.log'), log);
  await fs.writeFile(path.join(dir, '000004.log'), other);
  const values = await readLocalStorageKeys(dir, { origin: ORIGIN, keys: ['epitaxy-unread-v1', 'wide', 'gone', 'ключ', 'latin', 'missing'] });
  assert.deepEqual(JSON.parse(values.get('epitaxy-unread-v1')).state.unreadIds, ['local_a', 'local_b']);
  assert.equal(values.get('wide'), 'Grüße ✓ 日本');
  assert.equal(values.get('ключ'), 'non-Latin-1 key');
  assert.equal(values.get('latin'), 'café');
  assert.equal(values.has('gone'), false);
  assert.equal(values.has('missing'), false);
  assert.equal(values.size, 4);
});

test('log file: one WriteBatch with several records and a value spanning several 32 KiB blocks', async t => {
  const dir = await tempRoot(t);
  const big = 'z'.repeat(100_000) + '✓';
  const log = encodeLogFileForTests([
    { key: 'first', value: 'one', seq: 20 },
    { key: 'second', value: 'two' },
    { key: 'first', deleted: true },
    { key: 'big', value: big, seq: 40 },
  ], { origin: ORIGIN, batchSize: 3 });
  const parsed = logRecords(log);
  assert.equal(parsed.problems, 0);
  assert.deepEqual(parsed.records.map(record => [record.seq, record.deleted]), [[20n, false], [21n, false], [22n, true], [40n, false]]);
  assert.ok(log.length > 3 * 32768);
  await fs.writeFile(path.join(dir, '000010.log'), log);
  const values = await readLocalStorageKeys(dir, { origin: ORIGIN, keys: ['first', 'second', 'big'] });
  assert.equal(values.has('first'), false);
  assert.equal(values.get('second'), 'two');
  assert.equal(values.get('big'), big);
});

test('table files: snappy and raw blocks, prefix-shared keys, and the newest sequence across tables and logs', async t => {
  const dir = await tempRoot(t);
  const many = Array.from({ length: 120 }, (_, i) => ({ key: `epitaxy-session-result:local_${String(i).padStart(4, '0')}`, value: `{"costUSD":${i}}`, seq: 1000 + i }));
  const tableRecordsIn = [
    ...many,
    { key: 'epitaxy-unread-v1', value: unread(['local_table']), seq: 10 },
    { key: 'deleted-later', value: 'present in table', seq: 11 },
    { key: 'table-deletes', deleted: true, seq: 30 },
    { key: 'table-newer', value: 'from table', seq: 40 },
    { key: 'only-table', value: 'Ünïcödé ✓', seq: 41 },
  ];
  const snappyTable = encodeTableFileForTests(tableRecordsIn, { origin: ORIGIN, compression: 'snappy', blockSize: 512, restartInterval: 3 });
  const decoded = tableRecords(snappyTable);
  assert.equal(decoded.problems, 0);
  assert.equal(decoded.records.length, tableRecordsIn.length);
  const keys = decoded.records.map(record => record.key);
  assert.deepEqual(keys, [...keys].sort(Buffer.compare));
  assert.ok(keys.some(key => key.equals(localStorageKeyForTests(ORIGIN, 'epitaxy-session-result:local_0119'))));
  const one = decoded.records.find(record => record.key.equals(localStorageKeyForTests(ORIGIN, 'only-table')));
  assert.deepEqual(one.value, localStorageValueForTests('Ünïcödé ✓'));
  assert.equal(one.seq, 41n);

  await fs.writeFile(path.join(dir, '000005.ldb'), snappyTable);
  await fs.writeFile(path.join(dir, '000006.sst'), encodeTableFileForTests([{ key: 'raw-table', value: 'raw', seq: 50 }], { origin: ORIGIN, compression: 'none' }));
  await fs.writeFile(path.join(dir, '000008.ldb'), encodeTableFileForTests([{ key: 'literal-table', value: 'literal '.repeat(40), seq: 51 }], { origin: ORIGIN, compression: 'snappy-literal' }));
  await fs.writeFile(path.join(dir, '000007.log'), encodeLogFileForTests([
    { key: 'epitaxy-unread-v1', value: unread(['local_log']), seq: 100 },
    { key: 'deleted-later', deleted: true, seq: 101 },
    { key: 'table-deletes', value: 'older put in log', seq: 20 },
    { key: 'table-newer', value: 'older put in log', seq: 25 },
  ], { origin: ORIGIN }));
  const wanted = ['epitaxy-unread-v1', 'deleted-later', 'table-deletes', 'table-newer', 'only-table', 'raw-table', 'literal-table', 'epitaxy-session-result:local_0042'];
  const { values, stats } = await readLocalStorageDetails(dir, { origin: ORIGIN, keys: wanted });
  assert.deepEqual(JSON.parse(values.get('epitaxy-unread-v1')).state.unreadIds, ['local_log']);
  assert.equal(values.has('deleted-later'), false);
  assert.equal(values.has('table-deletes'), false);
  assert.equal(values.get('table-newer'), 'from table');
  assert.equal(values.get('only-table'), 'Ünïcödé ✓');
  assert.equal(values.get('raw-table'), 'raw');
  assert.equal(values.get('literal-table'), 'literal '.repeat(40));
  assert.equal(values.get('epitaxy-session-result:local_0042'), '{"costUSD":42}');
  assert.deepEqual({ files: stats.files, filesRead: stats.filesRead, problems: stats.problems }, { files: 4, filesRead: 4, problems: 0 });
});

test('a truncated log keeps the complete records before the cut', async t => {
  const dir = await tempRoot(t);
  const full = encodeLogFileForTests([
    { key: 'kept', value: 'complete', seq: 1 },
    { key: 'cut', value: 'x'.repeat(5000), seq: 2 },
  ], { origin: ORIGIN });
  await fs.writeFile(path.join(dir, '000011.log'), full.subarray(0, full.length - 1200));
  const { values, stats } = await readLocalStorageDetails(dir, { origin: ORIGIN, keys: ['kept', 'cut'] });
  assert.equal(values.get('kept'), 'complete');
  assert.equal(values.has('cut'), false);
  assert.equal(stats.problems, 0);
  // A value split across blocks whose LAST fragment never arrived is dropped too.
  const spanning = encodeLogFileForTests([{ key: 'kept', value: 'v', seq: 1 }, { key: 'cut', value: 'y'.repeat(70_000), seq: 2 }], { origin: ORIGIN });
  await fs.writeFile(path.join(dir, '000011.log'), spanning.subarray(0, 40_000));
  const again = await readLocalStorageKeys(dir, { origin: ORIGIN, keys: ['kept', 'cut'] });
  assert.equal(again.get('kept'), 'v');
  assert.equal(again.has('cut'), false);
});

test('a log record with a bad checksum is skipped with the rest of its block; later blocks still count', async t => {
  const dir = await tempRoot(t);
  const log = encodeLogFileForTests([
    { key: 'a', value: 'first', seq: 1 },
    { key: 'b', value: 'corrupted', seq: 2 },
    { key: 'c', value: 'c'.repeat(40_000), seq: 3 },
    { key: 'd', value: 'after', seq: 4 },
  ], { origin: ORIGIN });
  const corrupted = Buffer.from(log);
  corrupted[corrupted.indexOf(Buffer.from('corrupted', 'latin1'))] ^= 0x20;
  await fs.writeFile(path.join(dir, '000012.log'), corrupted);
  const { values, stats } = await readLocalStorageDetails(dir, { origin: ORIGIN, keys: ['a', 'b', 'c', 'd'] });
  assert.equal(values.get('a'), 'first');
  assert.equal(values.has('b'), false);
  assert.equal(values.has('c'), false);
  assert.equal(values.get('d'), 'after');
  assert.ok(stats.problems >= 2);
});

test('damaged tables are skipped per block or per file; unreadable folders throw plain errors', async t => {
  const dir = await tempRoot(t);
  const records = Array.from({ length: 60 }, (_, i) => ({ key: `k${String(i).padStart(2, '0')}`, value: `value ${i}`, seq: i + 1 }));
  await fs.writeFile(path.join(dir, '000020.ldb'), encodeTableFileForTests(records, { origin: ORIGIN, blockSize: 256, corruptBlock: 0 }));
  const noFooter = encodeTableFileForTests([{ key: 'lost', value: 'lost', seq: 70 }], { origin: ORIGIN });
  await fs.writeFile(path.join(dir, '000021.ldb'), noFooter.subarray(0, noFooter.length - 10));
  await fs.writeFile(path.join(dir, '000022.log'), encodeLogFileForTests([{ key: 'from-log', value: 'ok', seq: 80 }], { origin: ORIGIN }));
  for (const name of ['LOG', 'LOG.old', 'MANIFEST-000001', 'CURRENT', 'LOCK', '000023.log.bak']) await fs.writeFile(path.join(dir, name), 'not leveldb data');
  await fs.symlink(path.join(dir, 'nowhere.log'), path.join(dir, '000024.log'));
  const keys = ['k00', 'k59', 'lost', 'from-log'];
  const { values, stats } = await readLocalStorageDetails(dir, { origin: ORIGIN, keys });
  assert.equal(values.has('k00'), false, 'the first block was corrupted');
  assert.equal(values.get('k59'), 'value 59');
  assert.equal(values.has('lost'), false);
  assert.equal(values.get('from-log'), 'ok');
  assert.equal(stats.files, 4);
  assert.equal(stats.filesFailed, 1);
  assert.equal(stats.filesSkipped, 1);
  assert.ok(stats.problems >= 1);

  const broken = await tempRoot(t);
  await fs.writeFile(path.join(broken, '000001.ldb'), Buffer.alloc(100));
  await assert.rejects(readLocalStorageKeys(broken, { origin: ORIGIN, keys: ['x'] }), /Could not read any of the app's local storage files/);
  await assert.rejects(readLocalStorageKeys(path.join(broken, 'missing'), { origin: ORIGIN, keys: ['x'] }), error => error.code === 'ENOENT' && /local storage folder/.test(error.message));
  const empty = await tempRoot(t);
  assert.equal((await readLocalStorageKeys(empty, { origin: ORIGIN, keys: ['x'] })).size, 0);

  const big = await tempRoot(t);
  await fs.writeFile(path.join(big, '000001.log'), encodeLogFileForTests([{ key: 'x', value: 'y'.repeat(4000) }], { origin: ORIGIN }));
  await assert.rejects(readLocalStorageKeys(big, { origin: ORIGIN, keys: ['x'], maxFileBytes: 1000 }), /Could not read any/);
  assert.equal((await readLocalStorageKeys(big, { origin: ORIGIN, keys: ['x'] })).get('x'), 'y'.repeat(4000));
});

// Minimal table writer for hostile fixtures: the repo's encodeTableFileForTests only writes well-formed indexes.
function craftedTable({ entries, handles }) {
  const varint = value => { const out = []; let n = value; while (n >= 0x80) { out.push((n % 128) | 0x80); n = Math.floor(n / 128); } out.push(n); return Buffer.from(out); };
  const mask = crc => ((((crc >>> 15) | (crc << 17)) >>> 0) + 0xa282ead8) >>> 0;
  const out = [];
  let offset = 0;
  const writeRaw = data => {
    const trailer = Buffer.alloc(5);
    trailer.writeUInt32LE(mask(crc32c(trailer, 0, 1, crc32c(data))), 1);
    const handle = { offset, size: data.length };
    out.push(data, trailer);
    offset += data.length + 5;
    return handle;
  };
  const block = entries => {
    const parts = [];
    let size = 0;
    const restarts = [];
    entries.forEach(([key, value], index) => {
      restarts.push(size);
      const chunk = Buffer.concat([varint(0), varint(key.length), varint(value.length), key, value]);
      parts.push(chunk);
      size += chunk.length;
    });
    if (!restarts.length) restarts.push(0);
    const tail = Buffer.alloc(4 * restarts.length + 4);
    restarts.forEach((at, i) => tail.writeUInt32LE(at, 4 * i));
    tail.writeUInt32LE(restarts.length, 4 * restarts.length);
    return Buffer.concat([...parts, tail]);
  };
  const data = writeRaw(block(entries));
  const meta = writeRaw(block([]));
  const key = Buffer.from('z');
  const index = writeRaw(block(handles(data).map(handle => [key, Buffer.concat([varint(handle.offset), varint(handle.size)])])));
  const footer = Buffer.alloc(48);
  Buffer.concat([varint(meta.offset), varint(meta.size), varint(index.offset), varint(index.size)]).copy(footer, 0);
  footer.writeUInt32LE(0x8b80fb57, 40);
  footer.writeUInt32LE(0xdb477524, 44);
  out.push(footer);
  return Buffer.concat(out);
}

test('a table index that repeats or reorders block handles is rejected instead of read again and again', async t => {
  const dir = await tempRoot(t);
  // One big data block aimed at thousands of times over: without the handle check each repeat costs a full CRC and copy.
  const tag = Buffer.alloc(8);
  tag.writeBigUInt64LE((1n << 8n) | 1n);
  const entries = [[Buffer.concat([localStorageKeyForTests(ORIGIN, 'bomb'), tag]), localStorageValueForTests('x'.repeat(200000))]];
  await fs.writeFile(path.join(dir, '000001.ldb'), craftedTable({ entries, handles: data => Array.from({ length: 4000 }, () => data) }));
  // A second file proves one hostile table does not stop the rest of the folder.
  await fs.writeFile(path.join(dir, '000002.log'), encodeLogFileForTests([{ key: 'fine', value: 'ok', seq: 9 }], { origin: ORIGIN }));
  const started = Date.now();
  const { values, stats } = await readLocalStorageDetails(dir, { origin: ORIGIN, keys: ['bomb', 'fine'] });
  assert.ok(Date.now() - started < 2000, 'the crafted index is refused without reading its block thousands of times');
  assert.equal(stats.filesFailed, 1);
  assert.equal(values.has('bomb'), false);
  assert.equal(values.get('fine'), 'ok');

  // A handle pointing into the index block itself (or past it) is refused the same way.
  const past = await tempRoot(t);
  await fs.writeFile(path.join(past, '000001.ldb'), craftedTable({ entries, handles: data => [{ offset: data.offset, size: data.size + 4096 }] }));
  await assert.rejects(readLocalStorageKeys(past, { origin: ORIGIN, keys: ['bomb'] }), /Could not read any of the app's local storage files/);

  // The same file with one well-formed handle still reads, so the check does not reject honest tables.
  const good = await tempRoot(t);
  await fs.writeFile(path.join(good, '000001.ldb'), craftedTable({ entries, handles: data => [data] }));
  assert.equal((await readLocalStorageKeys(good, { origin: ORIGIN, keys: ['bomb'] })).get('bomb'), 'x'.repeat(200000));
});

test('local storage reads never write, lock or create files, and see appended records', async t => {
  const dir = await tempRoot(t);
  await fs.writeFile(path.join(dir, 'LOCK'), '');
  await fs.writeFile(path.join(dir, 'CURRENT'), 'MANIFEST-000001\n');
  await fs.writeFile(path.join(dir, '000005.ldb'), encodeTableFileForTests([{ key: 'epitaxy-unread-v1', value: unread(['local_1']), seq: 1 }], { origin: ORIGIN }));
  const first = encodeLogFileForTests([{ key: 'pinned', value: '["local_1"]', seq: 2 }], { origin: ORIGIN });
  await fs.writeFile(path.join(dir, '000006.log'), first);
  const before = await treeSnapshot(dir);
  const options = { origin: ORIGIN, keys: ['epitaxy-unread-v1', 'pinned'] };
  const one = await readLocalStorageKeys(dir, options);
  const two = await readLocalStorageKeys(dir, options);
  assert.deepEqual([...one], [...two]);
  assert.deepEqual(await treeSnapshot(dir), before);
  // The app appends to its log; the next read notices even though the table is served from cache.
  const appended = encodeLogFileForTests([
    { key: 'pinned', value: '["local_1"]', seq: 2 },
    { key: 'epitaxy-unread-v1', value: unread([]), seq: 3 },
  ], { origin: ORIGIN });
  await fs.writeFile(path.join(dir, '000006.log'), appended);
  const three = await readLocalStorageKeys(dir, options);
  assert.deepEqual(JSON.parse(three.get('epitaxy-unread-v1')).state.unreadIds, []);
});

test('local storage options are validated', async () => {
  await assert.rejects(readLocalStorageKeys('relative/dir', { origin: ORIGIN, keys: ['x'] }), TypeError);
  await assert.rejects(readLocalStorageKeys('/tmp', { origin: ORIGIN, keys: [] }), TypeError);
  await assert.rejects(readLocalStorageKeys('/tmp', { origin: 'https://a\u0000b', keys: ['x'] }), TypeError);
  await assert.rejects(readLocalStorageKeys('/tmp', { origin: ORIGIN, keys: ['x'], maxFileBytes: -1 }), TypeError);
});

// ---------------------------------------------------------------------------------------------
// SQLite snapshots
// ---------------------------------------------------------------------------------------------

// A WAL-mode database whose rows exist only in the -wal (no checkpoint); the writer stays open like a running app.
async function walFixture(t, root) {
  const dir = path.join(root, 'app');
  await fs.mkdir(dir);
  const file = path.join(dir, 'state.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, updated_at INTEGER, big INTEGER, data BLOB)');
  const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?)');
  for (let i = 0; i < 25; i++) insert.run(`t${i}`, `Thread ${i}`, 1000 + i, i === 3 ? 9007199254740993n : i, Buffer.from([i]));
  t.after(() => { try { db.close(); } catch {} });
  const wal = await fs.stat(`${file}-wal`);
  assert.ok(wal.size > 0, 'fixture rows live in the WAL');
  return { dir, file, db };
}

function trackingRun(calls, wrap) {
  return async (binary, args, options) => {
    calls.push({ binary, args, options });
    if (wrap) return wrap(binary, args, options);
    return run(binary, args, options);
  };
}

test('a WAL database is read through a clone: uncheckpointed rows visible, originals byte-identical, temp folder removed', async t => {
  const root = await tempRoot(t);
  const tmpRoot = path.join(root, 'tmp');
  await fs.mkdir(tmpRoot);
  const { dir, file } = await walFixture(t, root);
  const before = await treeSnapshot(dir);
  const calls = [];
  const snapshots = createSqliteSnapshots({ run: trackingRun(calls), tmpRoot });
  t.after(() => snapshots.close());
  const result = await snapshots.query(file, [
    { name: 'recent', sql: 'SELECT id, name, updated_at FROM threads WHERE updated_at >= ? ORDER BY updated_at DESC LIMIT ?', params: [1020, 3] },
    { name: 'count', sql: '-- how many\nSELECT count(*) AS n FROM threads;' },
    { name: 'odd', sql: 'SELECT big, data, json_extract(\'{"a":{"b":7}}\', \'$.a.b\') AS b FROM threads WHERE id = :id', params: { id: 't3' } },
  ]);
  assert.deepEqual(result.recent, [{ id: 't24', name: 'Thread 24', updated_at: 1024 }, { id: 't23', name: 'Thread 23', updated_at: 1023 }, { id: 't22', name: 'Thread 22', updated_at: 1022 }]);
  assert.equal(Object.getPrototypeOf(result.recent[0]), Object.prototype);
  assert.deepEqual(result.count, [{ n: 25 }]);
  assert.equal(result.odd[0].big, '9007199254740993');
  assert.deepEqual([...result.odd[0].data], [3]);
  assert.equal(result.odd[0].b, 7);
  assert.equal(snapshots.status().mode, 'worker');
  assert.deepEqual(await treeSnapshot(dir), before, 'originals unchanged and nothing created beside them');
  assert.deepEqual(await fs.readdir(tmpRoot), [], 'temporary clone folder removed');
  const cps = calls.filter(call => call.binary === '/bin/cp');
  assert.deepEqual(cps.map(call => call.args), [['-c', `${file}-wal`, cps[0].args[2]], ['-c', `${file}-shm`, cps[1].args[2]], ['-c', file, cps[2].args[2]]]);
  assert.ok(cps.every(call => call.args[2].startsWith(tmpRoot + path.sep)));
  assert.ok(cps[2].args[2].endsWith(`${path.sep}snapshot.db`));
});

test('only single read-only SELECT statements are accepted', async t => {
  const root = await tempRoot(t);
  const tmpRoot = path.join(root, 'tmp');
  await fs.mkdir(tmpRoot);
  const { file } = await walFixture(t, root);
  const calls = [];
  const snapshots = createSqliteSnapshots({ run: trackingRun(calls), tmpRoot });
  t.after(() => snapshots.close());
  const rejectedEarly = [
    'DELETE FROM threads',
    'UPDATE threads SET name = 1',
    'PRAGMA journal_mode = DELETE',
    'ATTACH DATABASE \'/tmp/x.db\' AS x',
    'SELECT 1; DELETE FROM threads',
    'SELECT 1; -- ok\n; SELECT 2',
    '/* SELECT */ VACUUM',
    'SELECT \'unterminated',
    '   ',
    '(SELECT 1)',
  ];
  for (const sql of rejectedEarly) {
    assert.equal(isReadOnlySql(sql), false, sql);
    await assert.rejects(snapshots.query(file, [{ name: 'q', sql }]), TypeError, sql);
  }
  assert.equal(calls.length, 0, 'nothing is cloned for a rejected statement');
  assert.equal(isReadOnlySql('SELECT \';DELETE\' AS x; -- trailing comment'), true);
  assert.equal(isReadOnlySql('with t as (select 1) select * from t'), true);
  assert.throws(() => checkStatements([{ name: 'a', sql: 'SELECT 1' }, { name: 'a', sql: 'SELECT 2' }]), /used twice/);
  assert.throws(() => checkStatements([{ name: 'bad name', sql: 'SELECT 1' }]), /simple name/);
  assert.throws(() => checkStatements([{ name: 'a', sql: 'SELECT ?', params: [{}] }]), /parameters/);
  assert.throws(() => checkStatements([{ name: 'a', sql: 'SELECT ?', params: 'x' }]), /list/);
  // These start with WITH/SELECT but still must not write or reach outside the clone.
  await assert.rejects(snapshots.query(file, [{ name: 'q', sql: 'WITH doomed AS (SELECT id FROM threads) DELETE FROM threads WHERE id IN (SELECT id FROM doomed)' }]), /read-only|not authorized|prohibited/i);
  await assert.rejects(snapshots.query(file, [{ name: 'q', sql: 'SELECT load_extension(\'/tmp/nothing\')' }]), /not authorized|unauthorized|prohibited/i);
  const after = await snapshots.query(file, [{ name: 'n', sql: 'SELECT count(*) AS n FROM threads' }]);
  assert.deepEqual(after.n, [{ n: 25 }]);
  assert.deepEqual(await fs.readdir(tmpRoot), []);
});

test('queries still run in-thread when the worker cannot start', async t => {
  const root = await tempRoot(t);
  const tmpRoot = path.join(root, 'tmp');
  await fs.mkdir(tmpRoot);
  const { file } = await walFixture(t, root);
  const snapshots = createSqliteSnapshots({ run, tmpRoot, workerUrl: new URL('./does-not-exist-worker.mjs', import.meta.url) });
  t.after(() => snapshots.close());
  const [one, two] = await Promise.all([
    snapshots.query(file, [{ name: 'n', sql: 'SELECT count(*) AS n FROM threads' }]),
    snapshots.query(file, [{ name: 'first', sql: 'SELECT id FROM threads ORDER BY updated_at LIMIT 1' }]),
  ]);
  assert.deepEqual(one.n, [{ n: 25 }]);
  assert.deepEqual(two.first, [{ id: 't0' }]);
  assert.equal(snapshots.status().mode, 'in-thread');
  assert.deepEqual(await fs.readdir(tmpRoot), []);
});

test('a database that changes while it is cloned is snapshotted again, then given up on', async t => {
  const root = await tempRoot(t);
  const tmpRoot = path.join(root, 'tmp');
  await fs.mkdir(tmpRoot);
  const { file } = await walFixture(t, root);
  let bumps = 0;
  let bumpLimit = 1;
  const calls = [];
  // Simulates the app committing right after the database file was cloned.
  const touching = trackingRun(calls, async (binary, args, options) => {
    const result = await run(binary, args, options);
    if (args[1] === file && bumps < bumpLimit) {
      bumps++;
      const when = new Date(Date.now() + bumps * 1000);
      await fs.utimes(`${file}-wal`, when, when);
    }
    return result;
  });
  const snapshots = createSqliteSnapshots({ run: touching, tmpRoot });
  t.after(() => snapshots.close());
  const result = await snapshots.query(file, [{ name: 'n', sql: 'SELECT count(*) AS n FROM threads' }]);
  assert.deepEqual(result.n, [{ n: 25 }]);
  assert.equal(calls.filter(call => call.args[1] === file).length, 2);

  bumps = 0;
  bumpLimit = Infinity;
  await assert.rejects(snapshots.query(file, [{ name: 'n', sql: 'SELECT 1 AS n' }], { retries: 1 }), error => error.code === 'SNAPSHOT_BUSY' && /state\.db kept changing/.test(error.message));
  assert.equal(bumps, 2);
  assert.deepEqual(await fs.readdir(tmpRoot), []);
});

test('when cloning fails, small files fall back to a copy and clone-only callers get a plain error', async t => {
  const root = await tempRoot(t);
  const tmpRoot = path.join(root, 'tmp');
  await fs.mkdir(tmpRoot);
  const { dir, file } = await walFixture(t, root);
  const before = await treeSnapshot(dir);
  const failing = async () => { throw new Error('clonefile failed'); };
  const snapshots = createSqliteSnapshots({ run: failing, tmpRoot });
  t.after(() => snapshots.close());
  const copied = await snapshots.query(file, [{ name: 'n', sql: 'SELECT count(*) AS n FROM threads' }]);
  assert.deepEqual(copied.n, [{ n: 25 }]);
  await assert.rejects(snapshots.query(file, [{ name: 'n', sql: 'SELECT 1' }], { maxFullCopyBytes: 0 }), error => error.code === 'SNAPSHOT_FAILED' && error.message === 'Could not take a safe snapshot of state.db.');
  await assert.rejects(snapshots.query(file, [{ name: 'n', sql: 'SELECT 1' }], { maxFullCopyBytes: 10, companions: [] }), error => error.code === 'SNAPSHOT_FAILED' && error.message === 'Could not take a safe snapshot of state.db.');
  assert.deepEqual(await treeSnapshot(dir), before);
  assert.deepEqual(await fs.readdir(tmpRoot), []);
});

test('rollback-journal databases without companions, missing databases, and bad arguments', async t => {
  const root = await tempRoot(t);
  const tmpRoot = path.join(root, 'tmp');
  await fs.mkdir(tmpRoot);
  const file = path.join(root, 'plain.sqlite');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE sessions (id TEXT, title TEXT); INSERT INTO sessions VALUES (\'20260917_101010_abcdef\', \'x\');');
  db.close();
  const snapshots = createSqliteSnapshots({ run, tmpRoot });
  t.after(() => snapshots.close());
  const rows = await snapshots.query(file, [{ name: 'ids', sql: 'SELECT id FROM sessions' }], { companions: ['-wal', '-shm', '-journal'] });
  assert.deepEqual(rows.ids, [{ id: '20260917_101010_abcdef' }]);
  assert.deepEqual((await fs.readdir(root)).sort(), ['plain.sqlite', 'tmp']);
  await assert.rejects(snapshots.query(path.join(root, 'missing.sqlite'), [{ name: 'q', sql: 'SELECT 1' }]), error => error.code === 'ENOENT' && error.message === 'Could not find missing.sqlite.');
  await assert.rejects(snapshots.query('relative.db', [{ name: 'q', sql: 'SELECT 1' }]), TypeError);
  await assert.rejects(snapshots.query(file, [{ name: 'q', sql: 'SELECT 1' }], { companions: ['/../../x'] }), TypeError);
  await fs.writeFile(path.join(root, 'junk.db'), 'this is not a database file at all, just text '.repeat(200));
  await assert.rejects(snapshots.query(path.join(root, 'junk.db'), [{ name: 'q', sql: 'SELECT 1' }]), /not a database|file is not|malformed/i);
  assert.deepEqual(await fs.readdir(tmpRoot), []);
});

test('a slow query times out without blocking later queries, and close() stops everything', async t => {
  const root = await tempRoot(t);
  const tmpRoot = path.join(root, 'tmp');
  await fs.mkdir(tmpRoot);
  const { file } = await walFixture(t, root);
  const snapshots = createSqliteSnapshots({ run, tmpRoot });
  const slow = 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 5000000) SELECT count(*) AS n FROM c';
  const started = Date.now();
  const [timedOut, fine] = await Promise.allSettled([
    snapshots.query(file, [{ name: 'slow', sql: slow }], { timeoutMs: 150 }),
    snapshots.query(file, [{ name: 'n', sql: 'SELECT count(*) AS n FROM threads' }]),
  ]);
  assert.equal(timedOut.status, 'rejected');
  assert.equal(timedOut.reason.code, 'SNAPSHOT_TIMEOUT');
  assert.equal(fine.status, 'fulfilled');
  assert.deepEqual(fine.value.n, [{ n: 25 }]);
  assert.ok(Date.now() - started < 5000);
  const later = await snapshots.query(file, [{ name: 'n', sql: 'SELECT count(*) AS n FROM threads' }]);
  assert.deepEqual(later.n, [{ n: 25 }]);
  await snapshots.close();
  assert.equal(snapshots.status().closed, true);
  await assert.rejects(snapshots.query(file, [{ name: 'n', sql: 'SELECT 1' }]), error => error.code === 'SNAPSHOT_CLOSED');
  assert.deepEqual(await fs.readdir(tmpRoot), []);
});

test('a snapshot timeout is the whole wait, not a fresh one per replaced worker', async t => {
  const root = await tempRoot(t);
  const tmpRoot = path.join(root, 'tmp');
  await fs.mkdir(tmpRoot);
  const { file } = await walFixture(t, root);
  // A worker that answers only the warm-up and then never again: every later request times out and replaces it.
  const stub = path.join(root, 'silent-worker.mjs');
  await fs.writeFile(stub, [
    "import { parentPort } from 'node:worker_threads';",
    "parentPort.postMessage({ ready: true });",
    "parentPort.on('message', message => { if (message?.statements?.[0]?.name === 'warm') parentPort.postMessage({ id: message.id, ok: true, result: { warm: [] } }); });",
    '',
  ].join('\n'));
  // Cloning runs as an in-process copy here instead of a /bin/cp spawn. The spawn is the one step in this test whose
  // cost swings with machine load, and it lands inside the measured wait; the real clone path is covered by the
  // cloning tests above. Arguments are ['-c', source, target].
  const copying = async (binary, args) => { await fs.copyFile(args[1], args[2]); return { stdout: '', stderr: '' }; };
  const snapshots = createSqliteSnapshots({ run: copying, tmpRoot, workerUrl: new URL(`file://${stub}`) });
  t.after(() => snapshots.close());
  await snapshots.query(file, [{ name: 'warm', sql: 'SELECT 1 AS n' }], { timeoutMs: 10000 });
  assert.equal(snapshots.status().mode, 'worker', 'the stub worker is up before anything is timed');

  const TIMEOUT = 1000;
  // The three requests start a clear distance apart so that their deadlines cannot change places, and so that each
  // deadline falls well after the replacement worker the previous timeout started has reported ready (about 20 ms
  // idle, 40 ms on a loaded machine). Started closer together, a replacement that has not reported ready yet counts
  // as broken, the pool falls back to running queries in this thread, and a request still inside its deadline is
  // answered locally instead of timing out. That is what used to fail this test only when the machine was busy.
  const APART = 250;
  const one = async delay => {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    const started = Date.now();
    try { await snapshots.query(file, [{ name: 'q', sql: 'SELECT 1 AS n' }], { timeoutMs: TIMEOUT }); return { code: 'none', waited: Date.now() - started }; }
    catch (error) { return { code: error.code, waited: Date.now() - started }; }
  };
  // All three are posted to the same stuck worker: the first replaces it when it times out, the other two are queued
  // behind it and are re-dispatched by that replacement.
  const results = await Promise.all([one(0), one(APART), one(APART * 2)]);
  const waits = results.map(result => `${result.code}/${result.waited}ms`).join(', ');
  for (const result of results) assert.equal(result.code, 'SNAPSHOT_TIMEOUT', waits);
  // Each request keeps the deadline it started with, so three queued behind one stuck worker do not stack their
  // timeouts. Measured from each request's own start: about 1000 ms each. With a fresh timeout per replaced worker
  // the second waits the rest of the first one's timeout and then all of its own (1750 ms), and the third waits
  // through both replacements (2500 ms).
  for (const result of results) {
    assert.ok(result.waited >= TIMEOUT - 50, `a request gave up before its own deadline: ${waits}`);
    assert.ok(result.waited < TIMEOUT + 400, `a ${TIMEOUT} ms timeout took: ${waits}`);
  }
});

test('leftover clone folders from a crash are swept; fresh ones are left alone', async t => {
  const root = await tempRoot(t);
  const tmpRoot = path.join(root, 'tmp');
  await fs.mkdir(tmpRoot);
  const old = path.join(tmpRoot, 'summon-sessions-oldone');
  const fresh = path.join(tmpRoot, 'summon-sessions-fresh1');
  const unrelated = path.join(tmpRoot, 'someone-else');
  for (const folder of [old, fresh, unrelated]) await fs.mkdir(folder);
  await fs.writeFile(path.join(old, 'snapshot.db'), 'x');
  const long = new Date(Date.now() - 60 * 60 * 1000);
  await fs.utimes(old, long, long);
  await fs.utimes(unrelated, long, long);
  const { file } = await walFixture(t, root);
  const snapshots = createSqliteSnapshots({ run, tmpRoot });
  t.after(() => snapshots.close());
  await snapshots.query(file, [{ name: 'n', sql: 'SELECT 1 AS n' }]);
  assert.deepEqual((await fs.readdir(tmpRoot)).sort(), ['someone-else', 'summon-sessions-fresh1']);
});

test('a later query sweeps a clone that a crash left behind after the first sweep ran', async t => {
  const root = await tempRoot(t);
  const tmpRoot = path.join(root, 'tmp');
  await fs.mkdir(tmpRoot);
  const { file } = await walFixture(t, root);
  // sweepEveryMs 0: the second query sweeps again, the way a running Summon does five minutes later.
  const snapshots = createSqliteSnapshots({ run, tmpRoot, sweepEveryMs: 0 });
  t.after(() => snapshots.close());
  await snapshots.query(file, [{ name: 'n', sql: 'SELECT 1 AS n' }]);
  assert.deepEqual(await fs.readdir(tmpRoot), [], 'the first query cleans up after itself');
  // A Ctrl-C or a force quit during a query leaves the clone folder behind; no finally and no exit handler runs.
  const orphan = path.join(tmpRoot, 'summon-sessions-crashed');
  await fs.mkdir(orphan);
  await fs.writeFile(path.join(orphan, 'snapshot.db'), 'clone');
  const long = new Date(Date.now() - 60 * 60 * 1000);
  await fs.utimes(orphan, long, long);
  await snapshots.query(file, [{ name: 'n', sql: 'SELECT 1 AS n' }]);
  // The sweep is not awaited after the first one, so give it a turn to finish.
  for (let i = 0; i < 100 && (await fs.readdir(tmpRoot)).length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(await fs.readdir(tmpRoot), [], 'the second query swept the leftover clone');

  // The same instance with a long gap still holds off, which is what made the once-per-process sweep miss this.
  const patient = createSqliteSnapshots({ run, tmpRoot, sweepEveryMs: 10 * 60 * 1000 });
  t.after(() => patient.close());
  await patient.query(file, [{ name: 'n', sql: 'SELECT 1 AS n' }]);
  await fs.mkdir(orphan);
  await fs.utimes(orphan, long, long);
  await patient.query(file, [{ name: 'n', sql: 'SELECT 1 AS n' }]);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(await fs.readdir(tmpRoot), ['summon-sessions-crashed'], 'sweeping stays cheap between passes');
});

test('runStatements refuses paths that are not absolute', async () => {
  await assert.rejects(runStatements('snapshot.db', [{ name: 'q', sql: 'SELECT 1' }]), TypeError);
});

// ---------------------------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------------------------

const PS_SAMPLE = [
  '    1     0 Thu Sep 17 15:37:27 2026     /sbin/launchd',
  '  612     1 Mon Sep  7 09:05:01 2026     /Applications/Claude.app/Contents/MacOS/Claude',
  ' 7001   612 Wed Sep 16 23:39:24 2026     /Users/someone/Library/Application Support/Claude/claude-code/2.1.271/claude.app/Contents/MacOS/claude',
  ' 7002     1 Thu Sep 17 15:37:27 2026     /Applications/ChatGPT.app/Contents/Resources/codex',
  ' 7005     1 Thu Sep 17 15:37:27 2026     odd\u0007name ',
  'garbage line',
  ' 7003     1 Xyz Sep 17 15:37:27 2026     bad-weekday',
  ' 7004     1 Mon Feb 30 15:37:27 2026     impossible-date',
  ' 7006     1 Thu Sep 17 25:37:27 2026     impossible-hour',
  '',
].join('\n');

test('ps output is parsed into pid, parent, UTC start and executable', () => {
  const processes = parseProcessList(PS_SAMPLE);
  assert.deepEqual([...processes.keys()], [1, 612, 7001, 7002, 7005]);
  assert.deepEqual(processes.get(612), { pid: 612, ppid: 1, startedAt: Date.UTC(2026, 8, 7, 9, 5, 1), lstart: 'Mon Sep  7 09:05:01 2026', comm: '/Applications/Claude.app/Contents/MacOS/Claude' });
  assert.equal(processes.get(612).lstart.length, 24);
  assert.equal(processes.get(7001).comm, '/Users/someone/Library/Application Support/Claude/claude-code/2.1.271/claude.app/Contents/MacOS/claude');
  assert.equal(processes.get(7001).ppid, 612);
  assert.equal(processes.get(7005).comm, 'odd name');
  assert.equal(parseLstart('Thu Sep 17 15:37:27 2026'), Date.UTC(2026, 8, 17, 15, 37, 27));
  assert.equal(parseLstart('  Mon Sep 7 09:05:01 2026 '), Date.UTC(2026, 8, 7, 9, 5, 1));
  assert.equal(parseLstart('Thu Sep 31 15:37:27 2026'), null);
  assert.equal(parseLstart(''), null);
  assert.deepEqual(findProcesses(processes, /\/codex$/).map(entry => entry.pid), [7002]);
  assert.deepEqual(findProcesses(processes, entry => entry.comm.includes('/Claude/claude-code/')).map(entry => entry.pid), [7001]);
  assert.deepEqual(findProcesses(null, /x/), []);
});

test('isAlive checks the pid and, when given, the start time against pid reuse', () => {
  const processes = parseProcessList(PS_SAMPLE);
  assert.equal(isAlive(processes, 612), true);
  assert.equal(isAlive(processes, '612'), true);
  assert.equal(isAlive(processes, 612, { lstart: 'Mon Sep  7 09:05:01 2026' }), true);
  assert.equal(isAlive(processes, 612, { lstart: ' Mon Sep 7 09:05:01 2026\n' }), true);
  assert.equal(isAlive(processes, 612, { lstart: 'Mon Sep  7 09:05:02 2026' }), false);
  assert.equal(isAlive(processes, 612, { startedAt: Date.UTC(2026, 8, 7, 9, 5, 1) + 1500 }), true);
  assert.equal(isAlive(processes, 612, { startedAt: Date.UTC(2026, 8, 7, 9, 5, 1) + 5000 }), false);
  assert.equal(isAlive(processes, 612, { startedAt: Date.UTC(2026, 8, 7, 9, 5, 1) + 5000, toleranceMs: 6000 }), true);
  assert.equal(isAlive(processes, 999), false);
  assert.equal(isAlive(processes, -1), false);
  assert.equal(isAlive(processes, '612abc'), false);
  assert.equal(isAlive(processes, 1.5), false);
  assert.equal(isAlive(null, 612), false);
  assert.equal(isAlive(processes, 612, { lstart: null }), true);
});

test('listProcesses makes one ps call for pid, ppid, lstart and comm only', async () => {
  const calls = [];
  const fake = async (binary, args, options) => { calls.push({ binary, args, options }); return { stdout: PS_SAMPLE, stderr: '' }; };
  const processes = await listProcesses({ run: fake });
  assert.equal(processes.size, 5);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].binary, '/bin/ps');
  assert.deepEqual(calls[0].args, ['-axo', 'pid=,ppid=,lstart=,comm=']);
  assert.deepEqual(calls[0].args, [...PS_ARGS]);
  assert.ok(!calls[0].args.join(' ').match(/\b(args|command|cmd)\b/));
  assert.deepEqual(calls[0].options, { env: { LC_ALL: 'C', TZ: 'UTC', PATH: '/usr/bin:/bin' }, timeout: 3000, maxBytes: 4_000_000 });
  await assert.rejects(listProcesses({ run: async () => { throw new Error('ps: boom'); } }), error => error.code === 'PS_FAILED' && error.message === 'Summon could not check which apps are running.');
});

test('listProcesses finds this test process with the real ps', async () => {
  const processes = await listProcesses({ run });
  const self = processes.get(process.pid);
  assert.ok(self, 'own pid listed');
  assert.equal(self.ppid, process.ppid);
  assert.ok(self.startedAt <= Date.now() && Date.now() - self.startedAt < 60 * 60 * 1000);
  assert.equal(isAlive(processes, process.pid, { lstart: self.lstart }), true);
  const fallback = await listProcesses();
  assert.ok(fallback.has(process.pid));
});
