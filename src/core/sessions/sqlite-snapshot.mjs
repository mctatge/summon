import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { WORKER_ROLE, checkStatements, runStatements } from './sqlite-worker.mjs';

/**
 * Read-only SQLite snapshots of other apps' databases. The database and its -wal/-shm are cloned (APFS clone via /bin/cp -c)
 * into a fresh 0700 temporary folder; only the clone is ever opened, and the folder is removed afterwards.
 * The original files are stat'ed before and after cloning; if they changed, the snapshot is retaken.
 */

const TEMP_PREFIX = 'summon-sessions-';
const CLONE_NAME = 'snapshot.db';
const COMPANION = /^-[A-Za-z0-9_]{1,16}$/;
const CP_ENV = Object.freeze({ PATH: '/usr/bin:/bin', LC_ALL: 'C' });
const DEFAULTS = { maxFullCopyBytes: 64 * 1024 * 1024, retries: 2, timeoutMs: 10000 };
const STALE_TEMP_MS = 15 * 60 * 1000;
// A crash, a force quit or a Ctrl-C leaves a clone behind, and no exit handler can cover SIGKILL, so the sweep repeats.
const SWEEP_EVERY_MS = 5 * 60 * 1000;
const RM_RETRY = { recursive: true, force: true, maxRetries: 3, retryDelay: 50 };
const MAX_WORKER_FAILURES = 3;

const absolute = value => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0') && path.normalize(value) === value;
const plain = (message, code, cause) => Object.assign(new Error(message), { code, ...(cause ? { cause } : {}) });

// Used only when no runner is injected (scripts, tests). Summon passes its tracked `run` from src/main/process.mjs.
function fallbackRun(binary, args, { env, timeout = 5000, maxBytes = 64000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { env, timeout, maxBuffer: maxBytes, encoding: 'utf8' }, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr })));
  });
}

async function statOrNull(file) {
  try {
    return await fs.stat(file, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
}

// -shm is excluded: SQLite rebuilds the shared-memory index on the first open of the clone, and the owning app
// touches it on every read, which would make every snapshot look torn.
async function signature(dbPath, companions) {
  const parts = [];
  for (const suffix of ['', ...companions]) {
    if (suffix === '-shm') continue;
    const stat = await statOrNull(dbPath + suffix);
    parts.push(stat ? `${suffix}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` : `${suffix}:none`);
  }
  return parts.join('|');
}

/**
 * createSqliteSnapshots({ run, tmpRoot, workerUrl }) → { query(dbPath, statements, options), close(), status() }.
 * query options: companions (['-wal','-shm']), maxFullCopyBytes (64 MiB; 0 = clone only), retries (2), timeoutMs (10 s).
 * sweepEveryMs (5 min) is how often a query also clears clone folders a crash left behind.
 */
export function createSqliteSnapshots({ run, tmpRoot = os.tmpdir(), workerUrl = new URL('./sqlite-worker.mjs', import.meta.url), sweepEveryMs = SWEEP_EVERY_MS } = {}) {
  const runner = typeof run === 'function' ? run : fallbackRun;
  const sweepEvery = Number.isFinite(sweepEveryMs) && sweepEveryMs >= 0 ? sweepEveryMs : SWEEP_EVERY_MS;
  if (typeof tmpRoot !== 'string' || !path.isAbsolute(tmpRoot)) throw new TypeError('The temporary folder must be an absolute path.');
  let closed = false;
  let worker = null;
  let workerReady = false;
  let workerFailures = 0;
  let inThread = false;
  let nextId = 1;
  let sweeping = null;
  let sweptAt = 0;
  const pending = new Map();
  const active = new Set();

  const sweep = async () => {
    // Clones left behind by a crash would slowly diverge from their sources and use disk; remove only our own old ones.
    try {
      const uid = typeof process.getuid === 'function' ? process.getuid() : null;
      for (const name of await fs.readdir(tmpRoot)) {
        if (!name.startsWith(TEMP_PREFIX)) continue;
        const full = path.join(tmpRoot, name);
        const stat = await fs.lstat(full).catch(() => null);
        if (!stat?.isDirectory() || (uid !== null && stat.uid !== uid) || Date.now() - stat.mtimeMs < STALE_TEMP_MS) continue;
        await fs.rm(full, RM_RETRY).catch(() => {});
      }
    } catch {}
  };

  // Once per process is not enough: a query that never reached its finally (Ctrl-C, crash, force quit) leaves a clone
  // that keeps growing against its source. Only the first sweep is awaited, so the 4 s poll never waits on a readdir.
  const maybeSweep = () => {
    if (sweeping && Date.now() - sweptAt < sweepEvery) return sweeping;
    sweptAt = Date.now();
    sweeping = sweep().catch(() => {});
    return sweeping;
  };

  const refCount = () => {
    if (!worker) return;
    if (pending.size > 0) worker.ref();
    else worker.unref();
  };

  const settle = (id, fn) => {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    clearTimeout(request.timer);
    refCount();
    fn(request);
  };

  const runLocally = request => {
    runStatements(request.file, request.statements).then(request.resolve, request.reject);
  };

  const dropWorker = (error, { broken = false } = {}) => {
    const dead = worker;
    const wasReady = workerReady;
    worker = null;
    workerReady = false;
    if (dead) dead.terminate().catch(() => {});
    if (broken || !wasReady) inThread = true;
    else if (++workerFailures >= MAX_WORKER_FAILURES) inThread = true;
    for (const [id, request] of [...pending]) {
      pending.delete(id);
      clearTimeout(request.timer);
      if (request.timedOut) continue;
      // Requests that were only queued behind a failure get one more try.
      if (!wasReady || request.attempts < 1) {
        request.attempts++;
        dispatch(request);
      } else request.reject(plain('Summon could not finish reading an app\'s session list. It will try again shortly.', 'SNAPSHOT_WORKER', error));
    }
  };

  const startWorker = () => {
    let created;
    try {
      created = new Worker(workerUrl, { workerData: { role: WORKER_ROLE }, name: 'summon-sqlite' });
    } catch {
      inThread = true;
      return null;
    }
    worker = created;
    workerReady = false;
    created.unref();
    created.on('message', message => {
      if (created !== worker) return;
      if (message?.ready) { workerReady = true; return; }
      settle(message?.id, request => {
        if (message.ok) {
          workerFailures = 0;
          request.resolve(message.result);
        } else {
          const error = message.error?.type === 'TypeError' ? new TypeError(message.error.message) : new Error(message.error?.message ?? 'The query failed.');
          if (message.error?.code) error.code = message.error.code;
          request.reject(error);
        }
      });
    });
    created.on('error', error => { if (created === worker) dropWorker(error, { broken: !workerReady }); });
    created.on('exit', () => { if (created === worker) dropWorker(plain('The query helper stopped.', 'SNAPSHOT_WORKER')); });
    return created;
  };

  function dispatch(request) {
    if (closed) { request.reject(plain('Summon is shutting down.', 'SNAPSHOT_CLOSED')); return; }
    // timeoutMs is the whole wait, not one attempt: a request re-queued behind a replaced worker keeps the deadline it started with.
    request.deadlineAt ??= Date.now() + request.timeoutMs;
    const left = request.deadlineAt - Date.now();
    if (left <= 0) { request.reject(plain('Reading an app\'s session list took too long.', 'SNAPSHOT_TIMEOUT')); return; }
    if (inThread || (!worker && !startWorker())) { runLocally(request); return; }
    const id = nextId++;
    pending.set(id, request);
    request.timer = setTimeout(() => {
      request.timedOut = true;
      settle(id, () => request.reject(plain('Reading an app\'s session list took too long.', 'SNAPSHOT_TIMEOUT')));
      // The worker is stuck in a synchronous query; replace it. Other queued requests are retried.
      if (worker) {
        const stuck = worker;
        const wasReady = workerReady;
        worker = null;
        workerReady = false;
        // A thread inside SQLite only stops once that call returns; don't let it hold the process open meanwhile.
        stuck.unref();
        stuck.terminate().catch(() => {});
        if (!wasReady) inThread = true;
        for (const [otherId, other] of [...pending]) {
          pending.delete(otherId);
          clearTimeout(other.timer);
          other.attempts++;
          dispatch(other);
        }
      }
    }, left);
    request.timer.unref?.();
    refCount();
    try {
      worker.postMessage({ id, file: request.file, statements: request.statements });
    } catch (error) {
      settle(id, () => {});
      inThread = true;
      runLocally(request);
    }
  }

  const execute = (file, statements, timeoutMs) => new Promise((resolve, reject) => dispatch({ file, statements, timeoutMs, deadlineAt: Date.now() + timeoutMs, resolve, reject, attempts: 0, timer: null, timedOut: false }));

  async function cloneInto(source, target, { optional, tmpDev, maxFullCopyBytes, label }) {
    const stat = await statOrNull(source);
    if (!stat) {
      if (optional) return false;
      throw plain(`Could not find ${label}.`, 'ENOENT');
    }
    if (!stat.isFile()) throw plain(`${label} is not a regular file.`, 'SNAPSHOT_NOT_FILE');
    const size = Number(stat.size);
    const fullCopyOk = maxFullCopyBytes > 0 && size <= maxFullCopyBytes;
    // cp -c silently falls back to a full copy across volumes; only allow that for small files.
    if (stat.dev !== tmpDev && !fullCopyOk) throw plain(`Could not take a safe snapshot of ${label}.`, 'SNAPSHOT_FAILED');
    try {
      await runner('/bin/cp', ['-c', source, target], { env: CP_ENV, timeout: 10000, maxBytes: 64000 });
    } catch (error) {
      await fs.rm(target, { force: true }).catch(() => {});
      if (optional && !(await statOrNull(source))) return false;
      if (!fullCopyOk) throw plain(`Could not take a safe snapshot of ${label}.`, 'SNAPSHOT_FAILED', error);
      try {
        await fs.copyFile(source, target, fsConstants.COPYFILE_EXCL);
      } catch (copyError) {
        await fs.rm(target, { force: true }).catch(() => {});
        if (optional && copyError?.code === 'ENOENT') return false;
        throw plain(`Could not take a safe snapshot of ${label}.`, 'SNAPSHOT_FAILED', copyError);
      }
    }
    await fs.chmod(target, 0o600);
    return true;
  }

  async function query(dbPath, statements, { companions = ['-wal', '-shm'], maxFullCopyBytes = DEFAULTS.maxFullCopyBytes, retries = DEFAULTS.retries, timeoutMs = DEFAULTS.timeoutMs } = {}) {
    if (closed) throw plain('Summon is shutting down.', 'SNAPSHOT_CLOSED');
    if (!absolute(dbPath)) throw new TypeError('The database path must be absolute.');
    if (!Array.isArray(companions) || companions.length > 4 || companions.some(suffix => typeof suffix !== 'string' || !COMPANION.test(suffix))) throw new TypeError('Companion files must be suffixes like -wal.');
    if (!Number.isFinite(maxFullCopyBytes) || maxFullCopyBytes < 0) throw new TypeError('maxFullCopyBytes must be a non-negative number.');
    if (!Number.isSafeInteger(retries) || retries < 0 || retries > 10) throw new TypeError('retries must be between 0 and 10.');
    if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) throw new TypeError('timeoutMs must be between 100 and 120000.');
    const checked = checkStatements(statements);
    const suffixes = [...new Set(companions)];
    const label = path.basename(dbPath);
    const firstSweep = !sweeping;
    const pass = maybeSweep();
    if (firstSweep) await pass;
    const tmpDev = (await fs.stat(tmpRoot, { bigint: true })).dev;
    const task = (async () => {
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (closed) throw plain('Summon is shutting down.', 'SNAPSHOT_CLOSED');
        const dir = await fs.mkdtemp(path.join(tmpRoot, TEMP_PREFIX));
        try {
          await fs.chmod(dir, 0o700);
          const clone = path.join(dir, CLONE_NAME);
          const before = await signature(dbPath, suffixes);
          if (before.startsWith(':none')) throw plain(`Could not find ${label}.`, 'ENOENT');
          // Companions first, then the database (a checkpoint in between is caught by the signature check).
          for (const suffix of suffixes) await cloneInto(dbPath + suffix, clone + suffix, { optional: true, tmpDev, maxFullCopyBytes, label });
          await cloneInto(dbPath, clone, { optional: false, tmpDev, maxFullCopyBytes, label });
          const after = await signature(dbPath, suffixes);
          if (before !== after) continue;
          return await execute(clone, checked, timeoutMs);
        } finally {
          // A timed-out worker can still be writing snapshot.db-wal/-shm inside the folder, which fails the rmdir once.
          await fs.rm(dir, RM_RETRY).catch(() => {});
        }
      }
      throw plain(`${label} kept changing while Summon read it. It will try again shortly.`, 'SNAPSHOT_BUSY');
    })();
    active.add(task);
    try {
      return await task;
    } finally {
      active.delete(task);
    }
  }

  async function close() {
    if (closed) return;
    closed = true;
    const dead = worker;
    worker = null;
    for (const [id, request] of [...pending]) {
      pending.delete(id);
      clearTimeout(request.timer);
      request.reject(plain('Summon is shutting down.', 'SNAPSHOT_CLOSED'));
    }
    if (dead) await dead.terminate().catch(() => {});
    await Promise.allSettled([...active]);
  }

  /** Diagnostics: where queries run ('worker' | 'in-thread' | 'idle' before the first query) and how many are queued. */
  const status = () => ({ mode: inThread ? 'in-thread' : worker ? 'worker' : 'idle', pending: pending.size, closed });

  return { query, close, status };
}
