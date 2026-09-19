import { isMainThread, parentPort, workerData } from 'node:worker_threads';

/**
 * Runs read-only SELECTs against a throwaway SQLite clone. Used inside a worker thread by sqlite-snapshot.mjs
 * (so the Electron main process does not block) and in-thread when a worker cannot start.
 * It is only ever handed a path inside Summon's own temporary folder, never another app's database.
 */

export const WORKER_ROLE = 'summon-sqlite-snapshot';
const LIMITS = { statements: 20, sqlChars: 20000, params: 999, textParam: 100000, rows: 10000, name: 64 };
const FIRST_WORD = new Set(['SELECT', 'WITH']);
const DENIED_FUNCTIONS = new Set(['load_extension', 'readfile', 'writefile', 'edit', 'fts3_tokenizer']);

// Walks the SQL skipping strings, identifiers and comments. Returns the first keyword and whether
// anything other than whitespace/comments follows a top-level semicolon.
function scanSql(sql) {
  let i = 0;
  const n = sql.length;
  let first = null;
  let ended = false;
  while (i < n) {
    const c = sql[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') { i++; continue; }
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i + 2);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      if (close === -1) return { ok: false };
      i = close + 2;
      continue;
    }
    if (ended) return { ok: false };
    if (c === ';') { ended = true; i++; continue; }
    if (c === '\'' || c === '"' || c === '`' || c === '[') {
      const closer = c === '[' ? ']' : c;
      let j = i + 1;
      for (;;) {
        const k = sql.indexOf(closer, j);
        if (k === -1) return { ok: false };
        // A doubled quote is an escaped quote inside the same literal.
        if (closer !== ']' && sql[k + 1] === closer) { j = k + 2; continue; }
        i = k + 1;
        break;
      }
      if (first === null) return { ok: false };
      continue;
    }
    if (first === null) {
      const match = /^[A-Za-z]+/.exec(sql.slice(i, i + 16));
      if (!match) return { ok: false };
      first = match[0].toUpperCase();
      i += match[0].length;
      continue;
    }
    i++;
  }
  return { ok: first !== null, first };
}

/** True for a single SELECT or WITH … SELECT statement (comments allowed, one trailing semicolon allowed). */
export function isReadOnlySql(sql) {
  if (typeof sql !== 'string' || !sql || sql.length > LIMITS.sqlChars || sql.includes('\0')) return false;
  const { ok, first } = scanSql(sql);
  return ok && FIRST_WORD.has(first);
}

function checkValue(value) {
  if (value === null || typeof value === 'bigint' || typeof value === 'string' || value instanceof Uint8Array) {
    if (typeof value === 'string' && value.length > LIMITS.textParam) throw new TypeError('A query parameter is too long.');
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  throw new TypeError('Query parameters must be text, numbers, null or bytes.');
}

/** Validates [{ name, sql, params?, maxRows? }] and returns normalized copies. Throws TypeError with a plain message. */
export function checkStatements(statements) {
  if (!Array.isArray(statements) || statements.length === 0 || statements.length > LIMITS.statements) throw new TypeError(`Pass between 1 and ${LIMITS.statements} statements.`);
  const names = new Set();
  return statements.map(statement => {
    const { name, sql, params = [], maxRows = LIMITS.rows } = statement ?? {};
    if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name.length > LIMITS.name || name === '__proto__') throw new TypeError('Each statement needs a simple name.');
    if (names.has(name)) throw new TypeError(`The statement name ${name} is used twice.`);
    names.add(name);
    if (!isReadOnlySql(sql)) throw new TypeError(`Only single read-only SELECT statements are allowed (${name}).`);
    let checked;
    if (Array.isArray(params)) {
      if (params.length > LIMITS.params) throw new TypeError('Too many query parameters.');
      checked = params.map(checkValue);
    } else if (params && typeof params === 'object' && Object.getPrototypeOf(params) === Object.prototype) {
      const entries = Object.entries(params);
      if (entries.length > LIMITS.params) throw new TypeError('Too many query parameters.');
      checked = Object.fromEntries(entries.map(([key, value]) => {
        if (!/^[:@$]?[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new TypeError('Named parameters need simple names.');
        return [key, checkValue(value)];
      }));
    } else throw new TypeError('Query parameters must be a list.');
    if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > LIMITS.rows) throw new TypeError(`maxRows must be between 1 and ${LIMITS.rows}.`);
    return { name, sql, params: checked, maxRows };
  });
}

function plainRow(row) {
  const out = {};
  for (const key of Object.keys(row)) {
    const value = row[key];
    out[key] = typeof value === 'bigint' ? (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString()) : value;
  }
  return out;
}

async function openClone(file) {
  const { DatabaseSync } = await import('node:sqlite');
  const probe = db => db.prepare('SELECT count(*) AS n FROM sqlite_schema').get();
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
    probe(db);
    return db;
  } catch {
    try { db?.close(); } catch {}
  }
  // A WAL clone without usable -shm, or a hot journal, needs a writable open to recover. It is Summon's own throwaway copy.
  db = new DatabaseSync(file, { readOnly: false, allowExtension: false });
  try {
    db.exec('PRAGMA query_only = ON');
    probe(db);
    return db;
  } catch (error) {
    try { db.close(); } catch {}
    throw error;
  }
}

function lockDown(db, constants) {
  if (typeof db.enableDefensive === 'function') db.enableDefensive(true);
  if (typeof db.setAuthorizer !== 'function') return;
  const allowed = new Set([constants.SQLITE_SELECT, constants.SQLITE_READ, constants.SQLITE_FUNCTION, constants.SQLITE_RECURSIVE]);
  db.setAuthorizer((action, first, second) => {
    if (!allowed.has(action)) return constants.SQLITE_DENY;
    if (action === constants.SQLITE_FUNCTION && DENIED_FUNCTIONS.has(String(second ?? first ?? '').toLowerCase())) return constants.SQLITE_DENY;
    return constants.SQLITE_OK;
  });
}

function runOne(db, { name, sql, params, maxRows }) {
  const statement = db.prepare(sql);
  // A WITH … DELETE compiles too; a statement without result columns is not a read.
  if (typeof statement.columns === 'function' && statement.columns().length === 0) throw new TypeError(`Only single read-only SELECT statements are allowed (${name}).`);
  const args = Array.isArray(params) ? params : [params];
  const collect = () => {
    const rows = [];
    for (const row of statement.iterate(...args)) {
      if (rows.length >= maxRows) throw Object.assign(new Error('A session query returned more rows than Summon reads.'), { code: 'TOO_MANY_ROWS' });
      rows.push(plainRow(row));
    }
    return rows;
  };
  try {
    return collect();
  } catch (error) {
    if (error?.code !== 'ERR_OUT_OF_RANGE' || typeof statement.setReadBigInts !== 'function') throw error;
    statement.setReadBigInts(true);
    return collect();
  }
}

/** Opens `file` (a clone), runs the checked statements, closes it. Returns { [name]: plainRows[] }. */
export async function runStatements(file, statements) {
  if (typeof file !== 'string' || !file.startsWith('/') || file.includes('\0')) throw new TypeError('The snapshot path must be absolute.');
  const checked = checkStatements(statements);
  const { constants } = await import('node:sqlite');
  const db = await openClone(file);
  try {
    lockDown(db, constants);
    const out = {};
    for (const statement of checked) out[statement.name] = runOne(db, statement);
    return out;
  } finally {
    try { db.close(); } catch {}
  }
}

const plainError = error => ({ message: String(error?.message ?? error ?? 'The query failed.'), code: typeof error?.code === 'string' ? error.code : null, type: error instanceof TypeError ? 'TypeError' : 'Error' });

if (!isMainThread && parentPort && workerData?.role === WORKER_ROLE) {
  parentPort.on('message', async message => {
    const id = message?.id;
    try {
      const result = await runStatements(message?.file, message?.statements);
      parentPort.postMessage({ id, ok: true, result });
    } catch (error) {
      parentPort.postMessage({ id, ok: false, error: plainError(error) });
    }
  });
  parentPort.postMessage({ ready: true });
}
