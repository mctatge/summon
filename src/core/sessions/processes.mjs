import { execFile } from 'node:child_process';

/**
 * One `ps` call listing pid, parent pid, start time and executable name of every process.
 * Command-line arguments are never requested: `claude -p "<prompt>"` would put a prompt in them.
 * `comm` is the process's own name (usually its executable path); it is untrusted and never displayed.
 */

export const PS_ARGS = Object.freeze(['-axo', 'pid=,ppid=,lstart=,comm=']);
const PS_ENV = Object.freeze({ LC_ALL: 'C', TZ: 'UTC', PATH: '/usr/bin:/bin' });
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
// lstart is strftime("%a %b %e %H:%M:%S %Y"): fixed 24 characters, day space-padded ("Thu Sep  7 09:05:01 2026").
const LINE = /^\s*(\d{1,10})\s+(\d{1,10})\s+((?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([ \d]\d) (\d\d):(\d\d):(\d\d) (\d{4}))\s+(\S.*)$/;
const CONTROL = /[\u0000-\u001f\u007f]/g;
const MAX_COMM = 1024;

const normalizeLstart = value => String(value ?? '').trim().replace(/\s+/g, ' ');

function fallbackRun(binary, args, { env, timeout, maxBytes } = {}) {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { env, timeout, maxBuffer: maxBytes, encoding: 'utf8' }, (error, stdout, stderr) => (error ? reject(error) : resolve({ stdout, stderr })));
  });
}

/** "Thu Sep 17 15:37:27 2026" (UTC) → epoch ms, or null. */
export function parseLstart(text) {
  const match = /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +(\d{1,2}) (\d\d):(\d\d):(\d\d) (\d{4})$/.exec(normalizeLstart(text));
  if (!match) return null;
  const [, month, day, hour, minute, second, year] = match;
  const ms = Date.UTC(Number(year), MONTHS[month], Number(day), Number(hour), Number(minute), Number(second));
  const check = new Date(ms);
  if (check.getUTCDate() !== Number(day) || check.getUTCMonth() !== MONTHS[month] || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  return ms;
}

/** Parses `ps -axo pid=,ppid=,lstart=,comm=` output (LC_ALL=C, TZ=UTC). Unparseable lines are skipped. */
export function parseProcessList(text) {
  const processes = new Map();
  for (const line of String(text ?? '').split('\n')) {
    const match = LINE.exec(line.replace(/\r$/, ''));
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const startedAt = parseLstart(match[3]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || startedAt === null) continue;
    const comm = match[10].replace(CONTROL, ' ').trimEnd().slice(0, MAX_COMM);
    processes.set(pid, { pid, ppid, startedAt, lstart: match[3], comm });
  }
  return processes;
}

/** Map<pid, { pid, ppid, startedAt, lstart, comm }> for every process visible to this user. Throws a plain error if ps fails. */
export async function listProcesses({ run } = {}) {
  const runner = typeof run === 'function' ? run : fallbackRun;
  let stdout;
  try {
    ({ stdout } = await runner('/bin/ps', [...PS_ARGS], { env: { ...PS_ENV }, timeout: 3000, maxBytes: 4_000_000 }));
  } catch (error) {
    throw Object.assign(new Error('Summon could not check which apps are running.'), { code: 'PS_FAILED', cause: error });
  }
  return parseProcessList(stdout);
}

/**
 * True when `pid` is running and, if given, its start matches: `lstart` exactly (whitespace-insensitive),
 * or `startedAt` (epoch ms) within `toleranceMs` (ps reports whole seconds). Guards against pid reuse.
 */
export function isAlive(processes, pid, { lstart, startedAt, toleranceMs = 2000 } = {}) {
  if (!processes || typeof processes.get !== 'function') return false;
  const id = typeof pid === 'string' && /^\d{1,10}$/.test(pid) ? Number(pid) : pid;
  if (!Number.isSafeInteger(id) || id <= 0) return false;
  const found = processes.get(id);
  if (!found) return false;
  if (lstart !== undefined && lstart !== null && normalizeLstart(lstart) !== normalizeLstart(found.lstart)) return false;
  if (startedAt !== undefined && startedAt !== null) {
    if (!Number.isFinite(startedAt) || Math.abs(found.startedAt - startedAt) > toleranceMs) return false;
  }
  return true;
}

/** Processes whose `comm` matches `test` (a RegExp, or a function of the process entry). */
export function findProcesses(processes, test) {
  if (!processes || typeof processes.values !== 'function') return [];
  const matches = typeof test === 'function' ? test : entry => (test instanceof RegExp ? (test.lastIndex = 0, test.test(entry.comm)) : false);
  return [...processes.values()].filter(entry => matches(entry));
}
