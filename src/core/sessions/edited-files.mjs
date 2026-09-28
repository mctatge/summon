/** Which files a Claude session edited, and when, from the two file-history metadata line types of its transcript. Only
 * the file name, its real parent folder and backupTime are read; the backup files those lines point at (under
 * ~/.claude/file-history/) hold the contents of the person's files and are never opened. Also which lines of a
 * transcript belong to its own session at all, since a forked transcript starts with another session's rows.
 * Shared by the edit pass in claude.mjs and the work-log pass in work-log.mjs. */
import path from 'node:path';
import { sealedPath } from '../workstreams.mjs';

// The two metadata lines that name a file the session edited.
export const EDIT_TYPES = new Set(['file-history-snapshot', 'file-history-delta']);
// Names that never travel, whatever folder they sit in. The full check, which also knows the repo's own private
// folders, runs in the aggregator; this one keeps a key or a .env out of the reader's answer in the first place.
const SECRET_BASE = /^(?:\.env(?:\..*)?|\.envrc|\.netrc|\.npmrc|\.pgpass|\.pypirc|\.git-credentials|\.dev\.vars|id_rsa|id_dsa|id_ecdsa|id_ed25519)$/i;
const SECRET_EXT = /\.(?:pem|key|p12|pfx|keychain|keystore|jks|kdbx|env|tfvars|p8|ppk)$/i;
const secretName = base => SECRET_BASE.test(base) || SECRET_EXT.test(base) || /secret|credential/i.test(base);
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const time = value => Number.isFinite(value) && value > 0 && value < 1e14 ? Math.round(value) : null;
const absPath = value => typeof value === 'string' && value.length <= 4096 && path.isAbsolute(value) && !/[\u0000-\u001f]/.test(value) ? path.normalize(value) : null;
// backupTime is an ISO string on this Mac's transcripts; a number is taken as epoch milliseconds.
const backupTime = value => typeof value === 'number' ? time(value) : typeof value === 'string' ? time(Date.parse(value)) : null;

// A file-history line names the file twice: `trackingPath`, which is sometimes relative to the folder the session
// started in, and `backup.realParentDir`, which is always the real parent folder. Joining the parent with the name
// gives one absolute path for both shapes and needs no working folder. Checked against this Mac's transcripts:
// 21 of 21 paths built this way pointed at a file that is really there. With no parent, the name must be absolute
// (an edit tool call's file_path).
export function editPath(named, parent) {
  if (typeof named !== 'string' || !named || named.length > 4096 || /[\u0000-\u001f]/.test(named)) return null;
  const base = path.basename(named.split('\\').join('/'));
  if (!base || base === '.' || base === '..' || secretName(base)) return null;
  const dir = absPath(parent);
  const full = dir ? path.join(dir, base) : absPath(named);
  return full && !sealedPath(full) ? full : null;
}

/** The files a parsed file-history row names, in the order the row lists them: { path, at, backedUp, snapshot }. backedUp is the
 *  backupTime written next to the file. `at` is an edit time and comes from a delta row only: Claude Code writes a
 *  delta when the session first edits a file, stamped within seconds of the edit, while a snapshot re-lists every
 *  tracked file when the person next writes, and a changed file's new backup there is stamped at that snapshot, often
 *  hours after the edit and whoever made the change (measured on this Mac: 201 of 201 deltas within 5 s of their edit
 *  call; per file, the newest snapshot backup trailed the session's last edit by a median 5 minutes and a p90 of 22
 *  hours). So a snapshot says which files, never when. Any other row names nothing. */
export function historyEdits(row, max = 200) {
  if (!isObject(row)) return [];
  if (row.type === 'file-history-delta') {
    const found = editPath(row.trackingPath, row.backup?.realParentDir);
    const at = backupTime(row.backup?.backupTime);
    return found ? [{ path: found, at, backedUp: at, snapshot: false }] : [];
  }
  const tracked = row.type === 'file-history-snapshot' ? row.snapshot?.trackedFileBackups : null;
  if (!isObject(tracked)) return [];
  const out = [];
  for (const [name, backup] of Object.entries(tracked).slice(0, max)) {
    const found = editPath(name, backup?.realParentDir);
    if (found) out.push({ path: found, at: null, backedUp: backupTime(backup?.backupTime), snapshot: true });
  }
  return out;
}

// ---- whose line is this ----
// A forked transcript (and one continued from an older session) starts with the other session's rows copied verbatim,
// each still carrying that session's id: on this Mac 37 of 793 transcripts start that way. Those rows, and the
// file-history lines among them, are that session's work, not this one's. Every conversation row names its session
// near its start, before any nested object, so the first `"sessionId":"` in a line is the row's own; inside string
// content the quotes are escaped and never match.
const SESSION_KEY = '"sessionId":"';
const SESSION_BYTES = Buffer.from(SESSION_KEY);
const SESSION_SCAN = 8192;
/** The session id a raw line names, or null when it names none. Works on a Buffer or a string. */
export function lineSession(line) {
  const head = line.length > SESSION_SCAN ? (typeof line === 'string' ? line.slice(0, SESSION_SCAN) : line.subarray(0, SESSION_SCAN)) : line;
  const at = head.indexOf(typeof line === 'string' ? SESSION_KEY : SESSION_BYTES);
  if (at < 0) return null;
  const from = at + SESSION_KEY.length;
  const to = line.indexOf(typeof line === 'string' ? '"' : 34, from);
  if (to <= from || to - from > 100) return null;
  return typeof line === 'string' ? line.slice(from, to) : line.toString('latin1', from, to);
}
// When the first own row after another session's was written: parsed once per transcript, for its own timestamp.
function rowTime(line) {
  try { const row = JSON.parse(typeof line === 'string' ? line : line.toString('utf8')); return isObject(row) ? backupTime(row.timestamp) : null; } catch { return null; }
}

/** Per transcript pass: whether its own rows have started, and when, if another session's rows came first. `forked`:
 *  the file's first rows are another session's, found from its head when a pass starts past the fork point. */
export function ownerState() {
  return { seen: 'none', forkedAt: null, forked: false, pointTries: 0, held: [] };
}
/** Whether a transcript's head (its first bytes, a Buffer) begins with another session's rows: the first line that
 *  names a session decides. Used when a pass starts partway into the file, past where copied rows would end. */
export function headForked(head, ownIds) {
  if (!ownIds || !ownIds.size) return false;
  for (let pos = 0; pos < head.length;) {
    let end = head.indexOf(10, pos);
    if (end < 0) break;
    const id = lineSession(head.subarray(pos, end));
    if (id !== null) return !ownIds.has(id);
    pos = end + 1;
  }
  return false;
}
/** For every complete line of a pass, before anything is parsed. False: the line is another session's row, skip it.
 *  `ownIds` is the transcript's own session id, plus the ids the same desktop session had before (its earlier rows
 *  are its own work). With no ids, every line is taken as the session's own. */
export function ownLine(line, owner, ownIds) {
  if (!ownIds || !ownIds.size) return true;
  const id = lineSession(line);
  if (id === null) return true;
  if (ownIds.has(id)) {
    if (owner.seen !== 'own') {
      // The first own row after another session's: everything backed up before it was copied in with that history.
      if (owner.seen === 'foreign') { owner.forked = true; owner.pointTries = 8; }
      owner.seen = 'own';
    }
    // The fork point is the first own row with a time (a title row, say, has none), looked for in the next few rows only.
    if (owner.pointTries > 0) { owner.pointTries--; owner.forkedAt = rowTime(line); if (owner.forkedAt !== null) owner.pointTries = 0; }
    return true;
  }
  if (owner.seen === 'none') { owner.seen = 'foreign'; owner.held = []; }
  return false;
}
/** A file-history row's entries that belong to this session: none while another session's copied rows are being read,
 *  none backed up before the fork point, and, until any row has said whose transcript this is, held back rather than
 *  guessed (releaseHeld hands them over). After a fork, snapshot entries are dropped too: a snapshot re-lists every file
 *  the session tracks, and a fork inherits the parent's tracked files, re-backed up whenever anyone changes them, so
 *  a file this session edited itself is known from its own delta line or edit call instead. That filter runs before
 *  anything is held, so a pass that starts past the fork point (forked known from the file's head, no row seen yet)
 *  never hands a held snapshot over unfiltered. */
export function ownEdits(found, owner, ownIds) {
  if (!ownIds || !ownIds.size) return found;
  if (owner.seen === 'foreign') return [];
  const kept = owner.forkedAt || owner.forked ? found.filter(item => !item.snapshot && !(owner.forkedAt && item.backedUp && item.backedUp < owner.forkedAt)) : found;
  if (owner.seen === 'none') {
    owner.held.push(...kept);
    if (owner.held.length > 1000) owner.held.splice(0, owner.held.length - 1000);
    return [];
  }
  return kept;
}
/** Entries held back, once they can be judged: as soon as the transcript's own rows have started, or at the end of a
 *  pass in which no row said whose it is at all (an old transcript without ids). Callers run it after ownLine() and at
 *  the end of each pass; held entries are older than anything that follows, so they are added first. */
export function releaseHeld(owner, { endOfPass = false } = {}) {
  if (!owner.held.length || owner.seen === 'foreign' || (owner.seen === 'none' && !endOfPass)) return [];
  const out = owner.held;
  owner.held = [];
  return out;
}
