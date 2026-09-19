import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Read-only lookup of Chromium localStorage values stored in LevelDB (for example the Claude desktop app's unread marks).
 * Reads only the numbered *.log / *.ldb / *.sst files with plain reads. Never opens LOCK, CURRENT or MANIFEST, never writes,
 * and never keeps anything but the values of the keys the caller asked for.
 */

const BLOCK_SIZE = 32768;
const LOG_HEADER = 7;
const FOOTER_BYTES = 48;
const MAGIC_LOW = 0x8b80fb57;
const MAGIC_HIGH = 0xdb477524;
const TYPE_DELETION = 0;
const TYPE_VALUE = 1;
const RECORD_FULL = 1;
const RECORD_FIRST = 2;
const RECORD_MIDDLE = 3;
const RECORD_LAST = 4;
const MAX_BLOCK_BYTES = 64 * 1024 * 1024;
const MAX_KEYS = 200;
const FILE_CONCURRENCY = 4;
const CACHE_ENTRIES = 128;
// Only the numbered data files; LOG/LOG.old are text diagnostics and LOCK must never be touched.
const DATA_FILE = /^\d{1,20}\.(log|ldb|sst)$/;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** CRC-32C (Castagnoli). Pass a previous result as `crc` to extend it. */
export function crc32c(buffer, start = 0, end = buffer.length, crc = 0) {
  let c = ~crc;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
// LevelDB stores checksums masked so that a CRC of data that embeds CRCs stays well distributed.
const maskCrc = crc => ((((crc >>> 15) | (crc << 17)) >>> 0) + 0xa282ead8) >>> 0;

const corrupt = message => Object.assign(new Error(message), { code: 'LEVELDB_CORRUPT' });

function toBuffer(value, encoding = 'utf8') {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === 'string') return Buffer.from(value, encoding);
  throw new TypeError('Expected a Buffer, Uint8Array or string.');
}

// Returns the decoded value and moves state.pos, or null when the varint is truncated or too long.
function readVarint(buffer, state, end, maxBytes) {
  let result = 0;
  let scale = 1;
  let pos = state.pos;
  for (let i = 0; i < maxBytes; i++) {
    if (pos >= end) return null;
    const byte = buffer[pos++];
    result += (byte & 0x7f) * scale;
    if (byte < 0x80) {
      state.pos = pos;
      return result;
    }
    scale *= 128;
  }
  return null;
}

function varintBytes(value) {
  const out = [];
  let n = value;
  while (n >= 0x80) {
    out.push((n % 128) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return Buffer.from(out);
}

/**
 * Decompress raw Snappy data (no framing): literals plus 1-, 2- and 4-byte-offset copies.
 * Every length and offset is bounds-checked; malformed input throws instead of reading or writing out of range.
 */
export function snappyDecompress(input, { maxLength = MAX_BLOCK_BYTES } = {}) {
  const src = toBuffer(input);
  const state = { pos: 0 };
  const length = readVarint(src, state, src.length, 5);
  if (length === null || length > 0xffffffff) throw corrupt('Snappy data has a bad length header.');
  if (length > maxLength) throw corrupt('Snappy data is larger than allowed.');
  // The densest element (a 3-byte copy) expands to 64 bytes, so a longer claim cannot be honest.
  if (length > Math.ceil((src.length - state.pos) / 3) * 64) throw corrupt('Snappy data claims more output than it can hold.');
  const out = Buffer.allocUnsafe(length);
  const end = src.length;
  let i = state.pos;
  let o = 0;
  while (i < end) {
    const tag = src[i++];
    const kind = tag & 3;
    if (kind === 0) {
      let len = tag >>> 2;
      if (len >= 60) {
        const bytes = len - 59;
        if (i + bytes > end) throw corrupt('Snappy literal length is cut off.');
        len = src.readUIntLE(i, bytes);
        i += bytes;
      }
      len += 1;
      if (len > end - i) throw corrupt('Snappy literal runs past the input.');
      if (len > length - o) throw corrupt('Snappy literal runs past the output.');
      src.copy(out, o, i, i + len);
      i += len;
      o += len;
      continue;
    }
    let len;
    let offset;
    if (kind === 1) {
      if (i >= end) throw corrupt('Snappy copy is cut off.');
      len = 4 + ((tag >>> 2) & 7);
      offset = ((tag >>> 5) << 8) | src[i++];
    } else if (kind === 2) {
      if (i + 2 > end) throw corrupt('Snappy copy is cut off.');
      len = (tag >>> 2) + 1;
      offset = src.readUInt16LE(i);
      i += 2;
    } else {
      if (i + 4 > end) throw corrupt('Snappy copy is cut off.');
      len = (tag >>> 2) + 1;
      offset = src.readUInt32LE(i);
      i += 4;
    }
    if (offset === 0 || offset > o) throw corrupt('Snappy copy points outside the output.');
    if (len > length - o) throw corrupt('Snappy copy runs past the output.');
    if (offset >= len) out.copyWithin(o, o - offset, o - offset + len);
    else for (let j = 0; j < len; j++) out[o + j] = out[o - offset + j];
    o += len;
  }
  if (o !== length) throw corrupt('Snappy data ended early.');
  return out;
}

// Iterates one table block: shared-prefix keys, restart array at the end. visit(key, keyLength, block, valueStart, valueEnd).
function scanBlock(block, visit) {
  const len = block.length;
  if (len < 4) throw corrupt('Table block is too short.');
  const restarts = block.readUInt32LE(len - 4);
  if (restarts > Math.floor((len - 4) / 4)) throw corrupt('Table block has a bad restart count.');
  const limit = len - 4 - restarts * 4;
  const state = { pos: 0 };
  let key = Buffer.allocUnsafe(128);
  let keyLength = 0;
  while (state.pos < limit) {
    const shared = readVarint(block, state, limit, 5);
    const unshared = shared === null ? null : readVarint(block, state, limit, 5);
    const valueLength = unshared === null ? null : readVarint(block, state, limit, 5);
    if (valueLength === null) throw corrupt('Table entry header is cut off.');
    if (shared > keyLength) throw corrupt('Table entry shares more key than exists.');
    if (unshared + valueLength > limit - state.pos) throw corrupt('Table entry runs past its block.');
    const nextLength = shared + unshared;
    if (nextLength > key.length) {
      const grown = Buffer.allocUnsafe(Math.max(nextLength, key.length * 2));
      key.copy(grown, 0, 0, shared);
      key = grown;
    }
    block.copy(key, shared, state.pos, state.pos + unshared);
    keyLength = nextLength;
    state.pos += unshared;
    visit(key, keyLength, block, state.pos, state.pos + valueLength);
    state.pos += valueLength;
  }
}

function readTableBlock(file, offset, size) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size + 5 > file.length) throw corrupt('Table block points outside the file.');
  const type = file[offset + size];
  const stored = file.readUInt32LE(offset + size + 1);
  if (maskCrc(crc32c(file, offset, offset + size + 1)) !== stored) throw corrupt('Table block checksum does not match.');
  const data = file.subarray(offset, offset + size);
  if (type === 0) return data;
  if (type === 1) return snappyDecompress(data);
  throw corrupt('Table block uses an unsupported compression.');
}

function readHandle(buffer, state, end) {
  const offset = readVarint(buffer, state, end, 10);
  const size = offset === null ? null : readVarint(buffer, state, end, 10);
  if (size === null) throw corrupt('Block handle is cut off.');
  return { offset, size };
}

// visit(key, userKeyLength, type, valueBuffer, valueStart, valueEnd, seqOf) for every entry of an immutable table file.
function scanTable(file, visit, stats) {
  const len = file.length;
  if (len < FOOTER_BYTES) throw corrupt('Table file is too short.');
  if (file.readUInt32LE(len - 8) !== MAGIC_LOW || file.readUInt32LE(len - 4) !== MAGIC_HIGH) throw corrupt('Table file has no footer.');
  const footer = { pos: len - FOOTER_BYTES };
  readHandle(file, footer, len - 8); // metaindex: not needed
  const indexHandle = readHandle(file, footer, len - 8);
  const index = readTableBlock(file, indexHandle.offset, indexHandle.size);
  const handles = [];
  // A table appends its data blocks in order before the index, so handles must not overlap, run backwards or reach
  // past the index. Without this a crafted index can aim thousands of handles at one huge block; the index itself may
  // be compressed, so the handle count is not bounded by the file size either.
  const maxHandles = 1 + Math.floor(len / 64);
  let expectedNext = 0;
  scanBlock(index, (_key, _keyLength, block, start, end) => {
    if (handles.length >= maxHandles) throw corrupt('Table index lists more blocks than the file can hold.');
    const handle = readHandle(block, { pos: start }, end);
    if (!Number.isSafeInteger(handle.offset) || !Number.isSafeInteger(handle.size) || handle.size < 0
      || handle.offset < expectedNext || handle.offset + handle.size + 5 > indexHandle.offset) {
      throw corrupt('Table index has an out-of-order or overlapping block handle.');
    }
    expectedNext = handle.offset + handle.size + 5;
    handles.push(handle);
  });
  const current = { key: null, userLength: 0 };
  const seqOf = () => current.key.readBigUInt64LE(current.userLength) >> 8n;
  for (const handle of handles) {
    try {
      scanBlock(readTableBlock(file, handle.offset, handle.size), (key, keyLength, block, start, end) => {
        if (keyLength < 8) throw corrupt('Table key is too short.');
        const userLength = keyLength - 8;
        const type = key[userLength];
        if (type !== TYPE_VALUE && type !== TYPE_DELETION) { stats.problems++; return; }
        current.key = key;
        current.userLength = userLength;
        visit(key, userLength, type, block, start, end, seqOf);
      });
    } catch (error) {
      if (error?.code !== 'LEVELDB_CORRUPT') throw error;
      stats.problems++;
    }
  }
}

// Parses one WriteBatch: seq (u64), count (u32), then {type, key, [value]} records. Applied only if the whole batch parses.
function scanBatch(batch, visit, stats) {
  if (batch.length < 12) { stats.problems++; return; }
  const base = batch.readBigUInt64LE(0);
  const count = batch.readUInt32LE(8);
  const state = { pos: 12 };
  const end = batch.length;
  const records = [];
  for (let n = 0; n < count; n++) {
    if (state.pos >= end) { stats.problems++; return; }
    const type = batch[state.pos++];
    if (type !== TYPE_VALUE && type !== TYPE_DELETION) { stats.problems++; return; }
    const keyLength = readVarint(batch, state, end, 5);
    if (keyLength === null || keyLength > end - state.pos) { stats.problems++; return; }
    const keyStart = state.pos;
    state.pos += keyLength;
    let valueStart = 0;
    let valueEnd = 0;
    if (type === TYPE_VALUE) {
      const valueLength = readVarint(batch, state, end, 5);
      if (valueLength === null || valueLength > end - state.pos) { stats.problems++; return; }
      valueStart = state.pos;
      valueEnd = state.pos + valueLength;
      state.pos = valueEnd;
    }
    records.push([keyStart, keyLength, type, valueStart, valueEnd, n]);
  }
  if (state.pos !== end) { stats.problems++; return; }
  const current = { index: 0 };
  const seqOf = () => base + BigInt(current.index);
  for (const [keyStart, keyLength, type, valueStart, valueEnd, index] of records) {
    current.index = index;
    visit(batch.subarray(keyStart, keyStart + keyLength), keyLength, type, batch, valueStart, valueEnd, seqOf);
  }
}

// Write-ahead log: 32 KiB blocks of {masked crc32c u32, length u16, type u8} records; FIRST/MIDDLE/LAST reassemble one batch.
// A truncated tail (the app is mid-write or compacting) ends the scan; a bad checksum skips the rest of that block.
function scanLog(file, visit, stats) {
  let pos = 0;
  let parts = null;
  while (pos < file.length) {
    const blockEnd = Math.min(file.length, (Math.floor(pos / BLOCK_SIZE) + 1) * BLOCK_SIZE);
    if (blockEnd - pos < LOG_HEADER) {
      if (blockEnd === file.length) break;
      pos = blockEnd;
      continue;
    }
    const length = file.readUInt16LE(pos + 4);
    const type = file[pos + 6];
    const dataStart = pos + LOG_HEADER;
    const dataEnd = dataStart + length;
    if (dataEnd > blockEnd) {
      if (blockEnd === file.length) break; // written only partly
      stats.problems++;
      parts = null;
      pos = blockEnd;
      continue;
    }
    if (type === 0 && length === 0) { pos = blockEnd; continue; } // preallocated zeros
    if (maskCrc(crc32c(file, pos + 6, dataEnd)) !== file.readUInt32LE(pos)) {
      stats.problems++;
      parts = null;
      pos = blockEnd;
      continue;
    }
    const fragment = file.subarray(dataStart, dataEnd);
    pos = dataEnd;
    if (type === RECORD_FULL) {
      if (parts) stats.problems++;
      parts = null;
      scanBatch(fragment, visit, stats);
    } else if (type === RECORD_FIRST) {
      if (parts) stats.problems++;
      parts = [fragment];
    } else if (type === RECORD_MIDDLE) {
      if (parts) parts.push(fragment);
      else stats.problems++;
    } else if (type === RECORD_LAST) {
      if (parts) {
        parts.push(fragment);
        scanBatch(Buffer.concat(parts), visit, stats);
      } else stats.problems++;
      parts = null;
    } else {
      stats.problems++;
      parts = null;
    }
  }
}

function decodeValue(buffer, start, end) {
  if (end <= start) return null;
  const marker = buffer[start];
  if (marker === 1) return buffer.toString('latin1', start + 1, end);
  if (marker === 0) return buffer.toString('utf16le', start + 1, end);
  return null;
}

// Chromium encodes a script key as 0x01 + Latin-1 when every character fits, else 0x00 + UTF-16LE.
function encodedKey(key) {
  let latin = true;
  for (let i = 0; i < key.length; i++) if (key.charCodeAt(i) > 0xff) { latin = false; break; }
  return latin ? Buffer.concat([Buffer.from([1]), Buffer.from(key, 'latin1')]) : Buffer.concat([Buffer.from([0]), Buffer.from(key, 'utf16le')]);
}

const originPrefix = origin => Buffer.from(`_${origin}\u0000`, 'latin1');

function checkOptions(leveldbDir, options) {
  if (typeof leveldbDir !== 'string' || !path.isAbsolute(leveldbDir) || leveldbDir.includes('\0')) throw new TypeError('The local storage folder must be an absolute path.');
  const { origin, keys, maxFileBytes = 64 * 1024 * 1024 } = options ?? {};
  if (typeof origin !== 'string' || !origin || origin.length > 512 || /[\u0000-\u001f\u007f-\uffff]/.test(origin)) throw new TypeError('The origin must be a plain web origin.');
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_KEYS || keys.some(key => typeof key !== 'string' || !key || key.length > 1024)) throw new TypeError(`Ask for between 1 and ${MAX_KEYS} non-empty keys.`);
  if (!Number.isFinite(maxFileBytes) || maxFileBytes < 0) throw new TypeError('maxFileBytes must be a non-negative number.');
  return { origin, keys: [...new Set(keys)], maxFileBytes };
}

const cache = new Map();
function remember(cacheKey, entry) {
  cache.delete(cacheKey);
  cache.set(cacheKey, entry);
  while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value);
}

// Matches for one file: [{ name, seq, deleted, value }], newest per name. Table files never change, so hits are common.
async function fileMatches(file, stat, origin, wanted, signature, stats) {
  const cacheKey = `${file}\u0000${origin}\u0000${signature}`;
  const statKey = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.statKey === statKey) {
    remember(cacheKey, hit);
    stats.problems += hit.problems;
    return hit.matches;
  }
  const data = await fs.readFile(file);
  const prefix = originPrefix(origin);
  const local = { problems: 0 };
  const best = new Map();
  const visit = (key, keyLength, type, valueBuffer, valueStart, valueEnd, seqOf) => {
    if (keyLength <= prefix.length || key[0] !== 0x5f) return;
    if (key.compare(prefix, 0, prefix.length, 0, prefix.length) !== 0) return;
    const name = wanted.get(key.toString('latin1', prefix.length, keyLength));
    if (name === undefined) return;
    const seq = seqOf();
    const previous = best.get(name);
    if (previous && previous.seq >= seq) return;
    const deleted = type === TYPE_DELETION;
    const value = deleted ? null : decodeValue(valueBuffer, valueStart, valueEnd);
    if (!deleted && value === null) local.problems++;
    best.set(name, { name, seq, deleted, value });
  };
  if (file.endsWith('.log')) scanLog(data, visit, local);
  else scanTable(data, visit, local);
  const matches = [...best.values()];
  remember(cacheKey, { statKey, matches, problems: local.problems });
  stats.problems += local.problems;
  return matches;
}

async function scanOnce(leveldbDir, { origin, keys, maxFileBytes }) {
  let names;
  try {
    names = await fs.readdir(leveldbDir);
  } catch (error) {
    throw Object.assign(new Error('Could not open the app\'s local storage folder.'), { code: error?.code ?? 'EIO', cause: error });
  }
  const wanted = new Map(keys.map(key => [encodedKey(key).toString('latin1'), key]));
  const signature = keys.slice().sort().join('\u0000');
  const files = names.filter(name => DATA_FILE.test(name)).sort();
  const stats = { files: files.length, filesRead: 0, filesSkipped: 0, filesMissing: 0, filesFailed: 0, problems: 0 };
  const newest = new Map();
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const file = path.join(leveldbDir, files[next++]);
      try {
        const stat = await fs.lstat(file, { bigint: true });
        if (!stat.isFile() || stat.size > BigInt(Math.floor(maxFileBytes))) { stats.filesSkipped++; continue; }
        for (const match of await fileMatches(file, stat, origin, wanted, signature, stats)) {
          const previous = newest.get(match.name);
          if (!previous || previous.seq < match.seq) newest.set(match.name, match);
        }
        stats.filesRead++;
      } catch (error) {
        if (error?.code === 'ENOENT') stats.filesMissing++;
        else if (error?.code === 'LEVELDB_CORRUPT' || error instanceof RangeError) stats.filesFailed++;
        else throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(FILE_CONCURRENCY, files.length) }, worker));
  const values = new Map();
  for (const key of keys) {
    const match = newest.get(key);
    if (match && !match.deleted && match.value !== null) values.set(key, match.value);
  }
  return { values, stats };
}

/**
 * Like readLocalStorageKeys, plus counts: { values, stats: { files, filesRead, filesSkipped, filesMissing, filesFailed, problems } }.
 * A file that vanished mid-read (the app compacted) triggers one fresh listing.
 */
export async function readLocalStorageDetails(leveldbDir, options) {
  const checked = checkOptions(leveldbDir, options);
  let result = await scanOnce(leveldbDir, checked);
  if (result.stats.filesMissing > 0) result = await scanOnce(leveldbDir, checked);
  const { stats } = result;
  if (stats.files > 0 && stats.filesRead === 0) {
    throw Object.assign(new Error('Could not read any of the app\'s local storage files.'), { code: 'LEVELDB_UNREADABLE' });
  }
  return result;
}

/**
 * Read-only Chromium localStorage (LevelDB) value lookup. Never takes LOCK, never writes.
 * The newest sequence number wins across all files; a newer deletion removes the key. Returns Map<key, string> of the keys found.
 * Throws a plain error when the folder cannot be listed or no data file could be read at all.
 */
export async function readLocalStorageKeys(leveldbDir, options) {
  return (await readLocalStorageDetails(leveldbDir, options)).values;
}

/** Every record of a log file as { key, seq, deleted, value } (Buffers are copies). For tests and diagnostics. */
export function logRecords(buffer) {
  const out = [];
  const stats = { problems: 0 };
  scanLog(toBuffer(buffer), (key, keyLength, type, value, start, end, seqOf) => {
    out.push({ key: Buffer.from(key.subarray(0, keyLength)), seq: seqOf(), deleted: type === TYPE_DELETION, value: type === TYPE_DELETION ? null : Buffer.from(value.subarray(start, end)) });
  }, stats);
  return { records: out, problems: stats.problems };
}

/** Every entry of a table file as { key, seq, deleted, value }. Throws on a file without a valid footer or index. */
export function tableRecords(buffer) {
  const out = [];
  const stats = { problems: 0 };
  scanTable(toBuffer(buffer), (key, userLength, type, value, start, end, seqOf) => {
    out.push({ key: Buffer.from(key.subarray(0, userLength)), seq: seqOf(), deleted: type === TYPE_DELETION, value: type === TYPE_DELETION ? null : Buffer.from(value.subarray(start, end)) });
  }, stats);
  return { records: out, problems: stats.problems };
}

// ---------------------------------------------------------------------------------------------
// Fixture writers for tests. They produce byte-exact LevelDB files so readers can be tested
// against fabricated data; production code never writes LevelDB files.
// ---------------------------------------------------------------------------------------------

/** The raw LevelDB key Chromium uses for `key` under `origin`. */
export function localStorageKeyForTests(origin, key) {
  return Buffer.concat([originPrefix(origin), encodedKey(key)]);
}

/** The raw LevelDB value Chromium stores for a string: 0x01 + Latin-1, or 0x00 + UTF-16LE. */
export function localStorageValueForTests(value, encoding = 'auto') {
  const text = String(value);
  const latin = encoding === 'latin1' || (encoding === 'auto' && ![...text].some(char => char.codePointAt(0) > 0xff));
  return latin ? Buffer.concat([Buffer.from([1]), Buffer.from(text, 'latin1')]) : Buffer.concat([Buffer.from([0]), Buffer.from(text, 'utf16le')]);
}

/** Snappy compressor for fixtures: greedy matches (or literals only), copies of 1-, 2- or 4-byte offsets. */
export function snappyCompressForTests(input, { literalOnly = false, useCopy4 = false, maxLiteral = 1 << 20 } = {}) {
  const src = toBuffer(input);
  const parts = [varintBytes(src.length)];
  const literal = (start, end) => {
    while (start < end) {
      const n = Math.min(end - start, maxLiteral);
      const m = n - 1;
      if (m < 60) parts.push(Buffer.from([m << 2]));
      else if (m < 0x100) parts.push(Buffer.from([60 << 2, m]));
      else if (m < 0x10000) parts.push(Buffer.from([61 << 2, m & 0xff, m >>> 8]));
      else if (m < 0x1000000) parts.push(Buffer.from([62 << 2, m & 0xff, (m >>> 8) & 0xff, m >>> 16]));
      else { const b = Buffer.alloc(5); b[0] = 63 << 2; b.writeUInt32LE(m, 1); parts.push(b); }
      parts.push(src.subarray(start, start + n));
      start += n;
    }
  };
  const copy = (offset, length) => {
    while (length > 0) {
      const n = Math.min(length, 64);
      if (!useCopy4 && n >= 4 && n <= 11 && offset < 2048) parts.push(Buffer.from([1 | ((n - 4) << 2) | ((offset >>> 8) << 5), offset & 0xff]));
      else if (!useCopy4 && offset < 0x10000) { const b = Buffer.alloc(3); b[0] = 2 | ((n - 1) << 2); b.writeUInt16LE(offset, 1); parts.push(b); }
      else { const b = Buffer.alloc(5); b[0] = 3 | ((n - 1) << 2); b.writeUInt32LE(offset, 1); parts.push(b); }
      length -= n;
    }
  };
  if (literalOnly) {
    literal(0, src.length);
    return Buffer.concat(parts);
  }
  const seen = new Map();
  let literalStart = 0;
  let i = 0;
  while (i + 4 <= src.length) {
    const word = src.readUInt32LE(i);
    const candidate = seen.get(word);
    seen.set(word, i);
    if (candidate !== undefined && (useCopy4 || i - candidate < 0x10000)) {
      let m = 0;
      while (i + m < src.length && src[candidate + m] === src[i + m]) m++;
      if (m >= 4) {
        literal(literalStart, i);
        copy(i - candidate, m);
        i += m;
        literalStart = i;
        continue;
      }
    }
    i++;
  }
  literal(literalStart, src.length);
  return Buffer.concat(parts);
}

function fixtureEntries(records, origin) {
  let nextSeq = 1;
  return records.map(record => {
    const seq = record.seq ?? nextSeq;
    nextSeq = Number(seq) + 1;
    const key = origin !== undefined ? localStorageKeyForTests(origin, record.key) : toBuffer(record.key);
    const deleted = Boolean(record.deleted);
    const value = deleted ? Buffer.alloc(0) : origin !== undefined && !Buffer.isBuffer(record.value) ? localStorageValueForTests(record.value, record.encoding) : toBuffer(record.value ?? '');
    return { key, seq: BigInt(seq), deleted, value };
  });
}

/**
 * A LevelDB write-ahead log (.log) holding `records` = [{ key, value, seq?, deleted?, encoding? }].
 * With `origin`, keys and string values are wrapped the way Chromium localStorage stores them; otherwise they are raw bytes.
 * `batchSize` records share one WriteBatch (the batch takes the first record's seq). Values over one block span FIRST/MIDDLE/LAST.
 */
export function encodeLogFileForTests(records, { origin, batchSize = 1, blockSize = BLOCK_SIZE } = {}) {
  const entries = fixtureEntries(records, origin);
  const payloads = [];
  for (let i = 0; i < entries.length; i += batchSize) {
    const group = entries.slice(i, i + batchSize);
    const header = Buffer.alloc(12);
    header.writeBigUInt64LE(group[0].seq, 0);
    header.writeUInt32LE(group.length, 8);
    const body = [header];
    for (const entry of group) {
      body.push(Buffer.from([entry.deleted ? TYPE_DELETION : TYPE_VALUE]), varintBytes(entry.key.length), entry.key);
      if (!entry.deleted) body.push(varintBytes(entry.value.length), entry.value);
    }
    payloads.push(Buffer.concat(body));
  }
  const out = [];
  let offset = 0;
  for (const payload of payloads) {
    let pointer = 0;
    let begin = true;
    do {
      const leftover = blockSize - offset;
      if (leftover < LOG_HEADER) {
        if (leftover > 0) out.push(Buffer.alloc(leftover));
        offset = 0;
      }
      const available = blockSize - offset - LOG_HEADER;
      const size = Math.min(payload.length - pointer, available);
      const end = pointer + size === payload.length;
      const type = begin && end ? RECORD_FULL : begin ? RECORD_FIRST : end ? RECORD_LAST : RECORD_MIDDLE;
      const fragment = payload.subarray(pointer, pointer + size);
      const header = Buffer.alloc(LOG_HEADER);
      header.writeUInt16LE(size, 4);
      header[6] = type;
      header.writeUInt32LE(maskCrc(crc32c(fragment, 0, fragment.length, crc32c(Buffer.from([type])))), 0);
      out.push(header, fragment);
      offset += LOG_HEADER + size;
      pointer += size;
      begin = false;
    } while (pointer < payload.length);
  }
  return Buffer.concat(out);
}

function buildBlock(entries, restartInterval) {
  const parts = [];
  const restarts = [];
  let previous = Buffer.alloc(0);
  let size = 0;
  entries.forEach(([key, value], index) => {
    let shared = 0;
    if (index % restartInterval === 0) restarts.push(size);
    else while (shared < previous.length && shared < key.length && previous[shared] === key[shared]) shared++;
    const chunk = Buffer.concat([varintBytes(shared), varintBytes(key.length - shared), varintBytes(value.length), key.subarray(shared), value]);
    parts.push(chunk);
    size += chunk.length;
    previous = key;
  });
  if (restarts.length === 0) restarts.push(0);
  const tail = Buffer.alloc(4 * restarts.length + 4);
  restarts.forEach((offset, i) => tail.writeUInt32LE(offset, 4 * i));
  tail.writeUInt32LE(restarts.length, 4 * restarts.length);
  return Buffer.concat([...parts, tail]);
}

/**
 * A LevelDB table (.ldb/.sst) holding `records` (same shape as encodeLogFileForTests), sorted the LevelDB way.
 * compression: 'none' | 'snappy' | 'snappy-literal'. Small `blockSize`/`restartInterval` force many blocks and prefix-shared keys.
 * `corruptBlock` (index) flips a byte in that data block so its checksum fails.
 */
export function encodeTableFileForTests(records, { origin, compression = 'snappy', blockSize = 4096, restartInterval = 16, corruptBlock = -1 } = {}) {
  const entries = fixtureEntries(records, origin).map(entry => {
    const tag = Buffer.alloc(8);
    tag.writeBigUInt64LE((entry.seq << 8n) | BigInt(entry.deleted ? TYPE_DELETION : TYPE_VALUE));
    return { user: entry.key, seq: entry.seq, internal: Buffer.concat([entry.key, tag]), value: entry.value };
  }).sort((a, b) => Buffer.compare(a.user, b.user) || (a.seq > b.seq ? -1 : a.seq < b.seq ? 1 : 0));
  const out = [];
  let offset = 0;
  const writeBlock = (contents, compress, corrupt = false) => {
    let data = contents;
    let type = 0;
    if (compress === 'snappy' || compress === 'snappy-literal') {
      data = snappyCompressForTests(contents, { literalOnly: compress === 'snappy-literal' });
      type = 1;
    }
    const trailer = Buffer.alloc(5);
    trailer[0] = type;
    trailer.writeUInt32LE(maskCrc(crc32c(trailer, 0, 1, crc32c(data))), 1);
    if (corrupt && data.length > 0) { data = Buffer.from(data); data[0] ^= 0xff; }
    const handle = { offset, size: data.length };
    out.push(data, trailer);
    offset += data.length + 5;
    return handle;
  };
  const index = [];
  let pending = [];
  let pendingBytes = 0;
  let blockNumber = 0;
  const flush = () => {
    if (pending.length === 0) return;
    const handle = writeBlock(buildBlock(pending, restartInterval), compression, blockNumber === corruptBlock);
    blockNumber++;
    index.push([pending[pending.length - 1][0], Buffer.concat([varintBytes(handle.offset), varintBytes(handle.size)])]);
    pending = [];
    pendingBytes = 0;
  };
  for (const entry of entries) {
    pending.push([entry.internal, entry.value]);
    pendingBytes += entry.internal.length + entry.value.length + 8;
    if (pendingBytes >= blockSize) flush();
  }
  flush();
  const meta = writeBlock(buildBlock([], 1), 'none');
  const indexHandle = writeBlock(buildBlock(index, 1), 'none');
  const footer = Buffer.alloc(FOOTER_BYTES);
  Buffer.concat([varintBytes(meta.offset), varintBytes(meta.size), varintBytes(indexHandle.offset), varintBytes(indexHandle.size)]).copy(footer, 0);
  footer.writeUInt32LE(MAGIC_LOW, 40);
  footer.writeUInt32LE(MAGIC_HIGH, 44);
  out.push(footer);
  return Buffer.concat(out);
}
