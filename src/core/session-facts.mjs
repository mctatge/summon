/** Session facts: what each listed agent session did, read without a model and joined with its repository
 * (decisions 2026-09-27, "Session cards"). The inputs are a session's own work log (sessions/work-log.mjs: git
 * annotations, quiet commit windows, test counts, an open question, the files it edited in a wider window), the files
 * the reader says it edited with their last-edited times, and Work in flight's uncommitted files per folder. The join answers, per session:
 * - which commits it made, whether each still exists, whether a remote-tracking ref already contains it ("pushed",
 *   as far as this Mac last knew: nothing is fetched) and, when it is not pushed, whether any branch still holds it;
 *   a commit found only by its call's time window is marked inferred, and one whose window could not be read (its
 *   folder is not one of Work in flight's, or git could not answer) is counted as not identified;
 * - how many of the files it edited are still uncommitted (and not committed by anyone since its last edit of them),
 *   which other listed sessions edited the same uncommitted files, and who wrote each one last where both sides have
 *   times;
 * - the newest test counts in its folder, marked stale when its own edits there are newer, and the run there that
 *   counted the most tests when that is a different, larger one;
 * - whether it is waiting on an answer to a question.
 * Every git call goes through the injected read-only runner (git-scan.mjs gitRunner: gitArgs, GIT_ENV, no fetch, no
 * hooks, no writes), is capped per compute and cached: a commit found pushed stays pushed, a quiet commit's window
 * that matched a commit keeps its answer, anything else is asked again after a minute (an empty window after ten), a
 * question git failed to answer after a minute too, and a folder whose git failed only after slowMs (a timeout) is not
 * asked anything for that minute. Nothing here is written to disk. */
import path from 'node:path';
import { sealedPath } from './workstreams.mjs';

export const FACT_LIMITS = Object.freeze({
  // Git processes per compute, and the time the whole join may take; what is left over stays unknown until next time.
  gitCalls: 40, budgetMs: 1500,
  // How long an answer other than "pushed" is trusted (a failed question too), how long an empty quiet-commit window
  // is, and how many answers are kept at most.
  recheckMs: 60000, windowRecheckMs: 600000, cacheEntries: 4000,
  // A git call that failed after this long is taken for a timeout: that folder is left alone until recheckMs has passed,
  // so a slow repository costs one timeout a minute rather than one per question per read.
  slowMs: 2000,
  // Commits read per folder when checking whether a held file was committed since the session last edited it.
  sinceCommits: 200,
  // Per session: commits listed, commits one quiet window may match, uncommitted files named, sessions and files shared.
  commits: 10, quietMatches: 5, files: 200, sharedWith: 10, sharedFiles: 50,
  // Two seconds either side of a quiet commit's call, for the clock and git's whole-second committer times.
  quietSlackMs: 2000,
  // How far up a touched path is followed to find the untracked folder it sits in.
  pathDepth: 24,
});
// The agent-facing view: at most this many uncommitted names.
export const AGENT_FILES = 5;

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const SHA = /^[0-9a-f]{7,64}$/;
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const listOf = value => (Array.isArray(value) ? value : []);
const iso = ms => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const inside = (candidate, root) => candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0');

/** The folder among `places` whose root holds `folder`, the deepest one winning, or null. */
function placeFor(folder, places) {
  if (!absolute(folder)) return null;
  let best = null;
  let length = -1;
  for (const place of places) for (const root of place.roots) if (root.length > length && inside(folder, root)) { best = place; length = root.length; }
  return best;
}

/** Every file a session edited, as full path to its newest known time (null when no source had one): the reader's own
 *  list, with the times aligned to it, and the work log's wider window. */
function editedFiles(session) {
  const out = new Map();
  const add = (full, at) => {
    if (!absolute(full)) return;
    const ms = Number.isFinite(at) ? at : null;
    if (!out.has(full) || (ms ?? 0) > (out.get(full) ?? 0)) out.set(full, ms);
  };
  const times = listOf(session.touchedTimes);
  listOf(session.touchedPaths).forEach((full, at) => add(full, times[at]));
  for (const item of listOf(session.workLog?.edited)) if (isObject(item)) add(item.path, item.at);
  return out;
}

/** Work in flight's uncommitted files, indexed by every spelling of their full path. An untracked folder ('new/') is
 *  indexed as a folder, so a file a session wrote inside it counts under its own name. */
function indexUncommitted(places) {
  const files = new Map();
  const dirs = new Map();
  for (const place of places) {
    for (const rel of place.uncommitted) {
      for (const root of place.roots) {
        if (rel.endsWith('/')) dirs.set(path.join(root, rel.slice(0, -1)), { place, root });
        else files.set(path.join(root, rel), { place, rel });
      }
    }
  }
  return { files, dirs };
}
/** The uncommitted entry a file is, in the one folder that owns it: the deepest place whose root holds it. A linked
 *  worktree nested inside the main folder (.claude/worktrees/<name>) owns its own files, so a file there is never
 *  matched to the main folder's untracked '.claude/' entry, and the walk up stops at the owner's root. */
function uncommittedEntry(full, index, places, depth) {
  const owner = placeFor(full, places);
  if (!owner) return null;
  const exact = index.files.get(full);
  if (exact) return exact.place === owner ? exact : null;
  let dir = path.dirname(full);
  for (let step = 0; step < depth && dir !== path.dirname(dir); step++, dir = path.dirname(dir)) {
    if (owner.roots.includes(dir)) break;
    const hit = index.dirs.get(dir);
    if (hit) return hit.place === owner ? { place: hit.place, rel: path.relative(hit.root, full).split(path.sep).join('/') } : null;
  }
  return null;
}

/** The facts, said in one plain line: "Committed 1a2b3c4, pushed · 12 uncommitted files, 9 shared with another
 *  session · tests 1082 of 1082, before its last edits · asked you a question". Unknown parts are left out. With
 *  names:false the commits are counted, not named, for a session whose folder is private. */
export function factsText(facts, { names = true } = {}) {
  if (!isObject(facts)) return '';
  const parts = [];
  const commits = listOf(facts.commits);
  const total = Number.isSafeInteger(facts.commitCount) ? Math.max(facts.commitCount, commits.length) : commits.length;
  if (total) {
    const newest = commits[0];
    const lead = names && newest ? `${newest.inferred ? 'Probably committed' : 'Committed'} ${newest.sha}${total > 1 ? ` and ${total - 1} more` : ''}` : plural(total, 'commit');
    const known = commits.filter(item => item.exists !== false);
    const missing = commits.length - known.length;
    const pushed = known.filter(item => item.pushed === true).length;
    const unpushed = known.filter(item => item.pushed === false).length;
    const loose = known.filter(item => item.pushed === false && item.onBranch === false).length;
    const status = [];
    if (commits.length === 1 && total === 1) {
      if (missing) status.push('no longer in the repository');
      else if (pushed) status.push('pushed');
      else if (unpushed) status.push(loose ? 'not pushed, on no branch' : 'not pushed');
    } else {
      if (missing) status.push(`${missing} no longer in the repository`);
      if (known.length && pushed === known.length && total === commits.length) status.push('all pushed');
      else if (unpushed) status.push(`${unpushed} not pushed`);
      // Some pushed and the rest unknown (a repository with no remote, or a check left for the next read).
      else if (pushed) status.push(`${pushed} pushed`);
      if (loose) status.push(`${loose} on no branch`);
    }
    const unknown = Number.isSafeInteger(facts.unidentified) && facts.unidentified > 0 ? Math.min(facts.unidentified, total) : 0;
    if (unknown) status.push(unknown === total ? 'not identified' : `${unknown} not identified`);
    parts.push([lead, ...status].join(', '));
  }
  const held = facts.uncommitted;
  if (isObject(held) && held.count > 0) {
    const others = listOf(facts.sharedWith).length;
    const shared = held.shared > 0 ? `, ${held.shared} shared with ${others > 1 ? `${others} other sessions` : 'another session'}` : '';
    parts.push(`${plural(held.count, 'uncommitted file')}${shared}`);
  }
  const test = facts.lastTest;
  const counts = run => Number.isSafeInteger(run.passed) && Number.isSafeInteger(run.failed);
  const stale = run => (run.stale === true ? ', before its last edits' : '');
  // Counts are null together when the run printed its failures but no summary could be found: it failed, how badly is
  // unknown. A larger earlier run in the same folder follows the newest, so a one-file run is not read as the suite.
  if (isObject(test)) {
    const big = isObject(facts.largestTest) && counts(facts.largestTest) ? facts.largestTest : null;
    parts.push(`${counts(test) ? `tests ${test.passed} of ${test.passed + test.failed}` : 'tests failing'}${stale(test)}${big ? `; largest run ${big.passed} of ${big.passed + big.failed}${stale(big)}` : ''}`);
  }
  if (isObject(facts.asked)) parts.push('asked you a question');
  const line = parts.join(' · ');
  return line ? line[0].toUpperCase() + line.slice(1) : '';
}

/** What an agent-facing read may carry: short SHAs, branch, pushed and inferred, counts, up to five repository-relative
 *  names that pass `keepName` (the private-path, secret-name and sealed filters Work in flight uses), the sessions
 *  sharing them by key and shown title, the latest test counts, and the open question. A session in a private folder
 *  (`hidden`) carries counts only. `titleOf(key)` is the title that view shows for another session. */
export function factsForAgent(facts, { hidden = false, keepName = () => false, titleOf = () => null } = {}) {
  if (!isObject(facts)) return null;
  const commits = hidden ? [] : listOf(facts.commits).map(item => ({ sha: item.sha, branch: item.branch, pushed: item.pushed, onBranch: item.onBranch, exists: item.exists, inferred: item.inferred, at: item.at }));
  let uncommitted = null;
  if (isObject(facts.uncommitted)) {
    const shared = new Set(listOf(facts.sharedFiles).map(item => item.path));
    const names = [];
    if (!hidden) {
      // Shared files first: they are the ones another session may be about to overwrite.
      const ordered = [...listOf(facts.uncommitted.files).filter(file => shared.has(file)), ...listOf(facts.uncommitted.files).filter(file => !shared.has(file))];
      for (const file of ordered) {
        if (names.length >= AGENT_FILES) break;
        let ok = false;
        try { ok = keepName(file) === true; } catch { ok = false; }
        if (ok) names.push(file);
      }
    }
    uncommitted = { count: facts.uncommitted.count, shared: facts.uncommitted.shared, files: names };
  }
  const sharedWith = hidden ? [] : listOf(facts.sharedWith).map(item => ({ key: item.key, title: titleOf(item.key) ?? null, files: item.files, thisWroteLast: item.thisWroteLast, otherWroteLast: item.otherWroteLast }));
  return {
    commits, commitCount: facts.commitCount, unidentified: Number.isSafeInteger(facts.unidentified) ? facts.unidentified : 0, uncommitted, sharedWith,
    lastTest: facts.lastTest ? { ...facts.lastTest } : null, largestTest: facts.largestTest ? { ...facts.largestTest } : null, asked: facts.asked ? { ...facts.asked } : null,
  };
}

/** The join, with a cache that outlives one compute. `git(cwd, args, { input, maxBytes })` resolves to stdout and
 *  throws on failure; the caller hands in a read-only runner. */
export function createSessionFacts({ git, now = () => Date.now(), limits = {} } = {}) {
  const lim = { ...FACT_LIMITS, ...limits };
  const cache = new Map();

  // An answer kept with its own ttl (a failure) is trusted that long, whatever the caller would allow a real answer.
  function cached(key, recheckMs = lim.recheckMs) {
    const hit = cache.get(key);
    if (!hit) return undefined;
    if (hit.forever || (now() - hit.at >= 0 && now() - hit.at < (hit.ttl ?? recheckMs))) return hit.value;
    cache.delete(key);
    return undefined;
  }
  function remember(key, value, forever = false, ttl = null) {
    if (cache.size >= lim.cacheEntries) cache.clear();
    cache.set(key, { at: now(), value, forever, ttl });
    return value;
  }
  // A question that failed keeps its "unknown" answer for recheckMs, so a folder git cannot answer is not asked again on
  // every read. A refusal from this compute's own budget, or from a folder already known to be slow, is not an answer.
  const failed = (error, key, value) => {
    if (!error?.budget && !error?.slow) remember(key, value, false, lim.recheckMs);
    return value;
  };

  /** Map of session key to facts. `sessions` are in priority order (the git budget goes to the first ones); each is
   *  { key, placeId, roots, touchedPaths, touchedTimes, workLog }. `places` are Work in flight folders:
   *  { id, roots, cwd, uncommitted }. */
  async function compute({ sessions = [], places = [] } = {}) {
    const started = now();
    let calls = 0;
    const budgetLeft = () => calls < lim.gitCalls && now() - started < lim.budgetMs && typeof git === 'function';
    const call = async (cwd, args, options = {}) => {
      if (cached(`slow\u0000${cwd}`) !== undefined) throw Object.assign(new Error('This folder\'s git answered too slowly a moment ago.'), { slow: true });
      if (!budgetLeft()) throw Object.assign(new Error('Over this read\'s git budget.'), { budget: true });
      calls++;
      const began = now();
      try { return String(await git(cwd, args, options) ?? ''); } catch (error) {
        if (now() - began >= lim.slowMs) remember(`slow\u0000${cwd}`, true, false, lim.recheckMs);
        throw error;
      }
    };
    const usable = listOf(places).filter(place => isObject(place) && typeof place.id === 'string' && absolute(place.cwd) && !sealedPath(place.cwd))
      .map(place => ({ id: place.id, cwd: place.cwd, roots: [...new Set(listOf(place.roots).filter(absolute))], uncommitted: listOf(place.uncommitted).filter(rel => typeof rel === 'string' && rel && !rel.startsWith('/') && !rel.split('/').includes('..')) }));
    const byId = new Map(usable.map(place => [place.id, place]));
    const index = indexUncommitted(usable);

    // Per folder: each file a commit on HEAD touched since `from`, with the newest such commit's time. HEAD only, since
    // that is the history this folder's uncommitted changes sit on; bounded by count and bytes.
    const committedSince = async (cwd, from) => {
      const low = Math.floor(from / 1000) - 1;
      const key = `since\u0000${cwd}`;
      const hit = cached(key);
      if (hit !== undefined && hit.low <= low) return hit.files;
      try {
        const text = await call(cwd, ['log', 'HEAD', '--no-color', '--no-renames', '--format=%x1e%ct', '--name-only', `--since=@${low}`, `-n${lim.sinceCommits}`], { maxBytes: 512 * 1024 });
        const files = new Map();
        for (const record of text.split('\u001e')) {
          const [stamp, ...names] = record.split('\n');
          const seconds = Number(stamp);
          if (!Number.isSafeInteger(seconds) || seconds <= 0) continue;
          for (const name of names) if (name && name.length <= 1024) files.set(name, Math.max(files.get(name) ?? 0, seconds * 1000));
        }
        return remember(key, { low, files }).files;
      } catch (error) { return failed(error, key, { low: -Infinity, files: null }).files; }
    };

    // 1. Which uncommitted files each session holds, in the one folder its edits there belong to: its own folder when
    //    it holds any there, otherwise the folder holding the most of them.
    const holdings = new Map();
    const editsOf = new Map(sessions.map(session => [session.key, editedFiles(session)]));
    for (const session of sessions) {
      const perPlace = new Map();
      for (const [full, at] of editsOf.get(session.key)) {
        if (sealedPath(full)) continue;
        const entry = uncommittedEntry(full, index, usable, lim.pathDepth);
        if (!entry) continue;
        let files = perPlace.get(entry.place.id);
        if (!files) perPlace.set(entry.place.id, files = new Map());
        if (!files.has(entry.rel) || (at ?? 0) > (files.get(entry.rel) ?? 0)) files.set(entry.rel, at);
      }
      let chosen = perPlace.has(session.placeId) ? session.placeId : null;
      if (!chosen) for (const [id, files] of perPlace) if (!chosen || files.size > perPlace.get(chosen).size) chosen = id;
      if (chosen) holdings.set(session.key, { placeId: chosen, files: perPlace.get(chosen) });
    }
    // A held file that a commit touched after the session last edited it is no longer this session's change: what is
    // uncommitted there now was written since, by someone else. One bounded log per folder, back to the oldest held
    // edit with a time; a file with no edit time stays held, since nothing says when this session last wrote it.
    const oldest = new Map();
    for (const held of holdings.values()) for (const at of held.files.values()) if (Number.isFinite(at)) oldest.set(held.placeId, Math.min(oldest.get(held.placeId) ?? Infinity, at));
    const since = new Map();
    for (const [id, from] of oldest) since.set(id, await committedSince(byId.get(id).cwd, from));
    for (const [key, held] of holdings) {
      const touched = since.get(held.placeId);
      if (touched) for (const [rel, at] of [...held.files]) if (Number.isFinite(at) && (touched.get(rel) ?? 0) > at) held.files.delete(rel);
      if (!held.files.size) holdings.delete(key);
    }
    const holders = new Map();
    for (const [key, held] of holdings) {
      for (const [rel, at] of held.files) {
        const id = `${held.placeId}\u0000${rel}`;
        const list = holders.get(id);
        if (list) list.push({ key, at }); else holders.set(id, [{ key, at }]);
      }
    }

    // 2. Commits: which repository folder each one is asked about, then one existence check per folder.
    const wanted = new Map();
    const commitsOf = new Map();
    for (const session of sessions) {
      const own = session.placeId ? byId.get(session.placeId) : null;
      const list = [];
      for (const action of listOf(session.workLog?.git)) {
        if (!isObject(action) || action.kind !== 'commit') continue;
        // A commit made in a folder that is not one of Work in flight's folders is asked about nowhere: the session's
        // own repository would only answer "missing" for it. Only a commit whose folder is unknown falls back to it.
        // A quiet one there has no SHA to list, so it is counted as not identified rather than left out.
        const place = action.folder ? placeFor(action.folder, usable) : own;
        if (action.quiet) { if (Number.isFinite(action.from) && Number.isFinite(action.at)) list.push({ quiet: true, place, from: action.from, to: action.at }); continue; }
        if (typeof action.sha !== 'string' || !SHA.test(action.sha)) continue;
        list.push({ quiet: false, place, sha: action.sha, branch: action.branch ?? null, at: action.at ?? null });
        if (place) { const shas = wanted.get(place.cwd) ?? new Set(); shas.add(action.sha); wanted.set(place.cwd, shas); }
      }
      commitsOf.set(session.key, list);
    }
    const objects = new Map();
    for (const [cwd, shas] of wanted) {
      const ask = [];
      for (const sha of shas) { const hit = cached(`object\u0000${cwd}\u0000${sha}`); if (hit !== undefined) objects.set(`${cwd}\u0000${sha}`, hit); else ask.push(sha); }
      if (!ask.length) continue;
      try {
        // One process answers for every commit in this folder; `missing` and `ambiguous` come back as words.
        const text = await call(cwd, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], { input: `${ask.join('\n')}\n`, maxBytes: 64 * 1024 });
        const lines = text.split('\n');
        ask.forEach((sha, at) => {
          const [oid, type] = (lines[at] ?? '').trim().split(' ');
          const value = type === 'commit' && OID.test(oid) ? oid : type === 'missing' ? false : null;
          objects.set(`${cwd}\u0000${sha}`, value);
          if (value !== null) remember(`object\u0000${cwd}\u0000${sha}`, value);
        });
      } catch (error) { for (const sha of ask) failed(error, `object\u0000${cwd}\u0000${sha}`, null); /* unknown for now */ }
    }
    // Whether this repository tracks any remote at all, asked once per folder however many commits are checked at once.
    const asking = new Map();
    const remotes = cwd => {
      const hit = cached(`remotes\u0000${cwd}`);
      if (hit !== undefined) return Promise.resolve(hit);
      if (!asking.has(cwd)) {
        asking.set(cwd, call(cwd, ['for-each-ref', '--count=1', '--format=%(refname)', 'refs/remotes'], { maxBytes: 4096 })
          .then(text => remember(`remotes\u0000${cwd}`, Boolean(text.trim())), error => failed(error, `remotes\u0000${cwd}`, null)));
      }
      return asking.get(cwd);
    };
    // Where a commit is now: pushed when a remote-tracking ref contains it (null when this repository tracks no remote),
    // and, when it is not pushed, whether any local branch still does. Local refs only; nothing is fetched.
    const whereIs = async (cwd, oid) => {
      const key = `refs\u0000${cwd}\u0000${oid}`;
      const hit = cached(key);
      if (hit !== undefined) return hit;
      const tracked = await remotes(cwd);
      try {
        const refs = (await call(cwd, ['for-each-ref', '--contains', oid, '--format=%(refname)', 'refs/heads', 'refs/remotes'], { maxBytes: 512 * 1024 })).split('\n');
        const pushed = refs.some(ref => ref.startsWith('refs/remotes/')) ? true : tracked === true ? false : null;
        const value = { pushed, onBranch: refs.some(ref => ref.startsWith('refs/heads/')) };
        return remember(key, value, pushed === true);
      } catch (error) { return failed(error, key, { pushed: null, onBranch: null }); }
    };
    // A quiet commit: the commits this folder's HEAD has pointed at whose committer time falls inside the call's window.
    // HEAD's reflog (local .git/logs only; nothing is written or fetched) still lists a commit that was later reset,
    // rebased or replayed away, which is the one most worth flagging, and in a worktree it is that worktree's own HEAD,
    // so another worktree's branch cannot lend its commits to this window. A window that matched keeps its answer.
    const windowCommits = async (cwd, from, to) => {
      const key = `window\u0000${cwd}\u0000${from}\u0000${to}`;
      const hit = cached(key, lim.windowRecheckMs);
      if (hit !== undefined) return hit;
      const low = Math.floor((from - lim.quietSlackMs) / 1000), high = Math.ceil((to + lim.quietSlackMs) / 1000);
      try {
        const text = await call(cwd, ['log', '--walk-reflogs', 'HEAD', '--no-color', '--format=%H%x1f%ct', `--since=@${low}`, `--until=@${high}`, `-n${lim.quietMatches * 4}`], { maxBytes: 64 * 1024 });
        const found = [];
        for (const line of text.split('\n')) {
          const [oid, stamp] = line.split('\u001f');
          const seconds = Number(stamp);
          if (OID.test(oid) && Number.isSafeInteger(seconds) && seconds >= low && seconds <= high && !found.includes(oid)) found.push(oid);
          if (found.length >= lim.quietMatches) break;
        }
        return remember(key, found, found.length > 0);
      } catch (error) { return failed(error, key, null); }
    };

    // 3. The facts, session by session, in the order the git budget should be spent.
    const out = new Map();
    for (const session of sessions) {
      const commits = [];
      // One commit can be named twice, by its annotation and by a quiet window, or by a short and a full SHA.
      const seen = [];
      const already = id => seen.some(other => other.startsWith(id) || id.startsWith(other));
      // Quiet commits whose SHA is not known: made outside Work in flight's folders, or in one whose HEAD reflog could
      // not be read this time. Each still counts, so the total is the number of commits the session made. A window that
      // was read and holds nothing made no commit there as far as the repository says, and counts for nothing.
      let unidentified = 0;
      // A session's questions go out together (the runner's own gate keeps four at a time); the answers are then read
      // in the work log's order, so the newest naming of a commit is the one kept.
      const items = commitsOf.get(session.key) ?? [];
      const windows = await Promise.all(items.map(item => (item.quiet && item.place ? windowCommits(item.place.cwd, item.from, item.to) : null)));
      for (const [index, item] of items.entries()) {
        if (item.quiet) {
          if (!Array.isArray(windows[index])) { unidentified++; continue; }
          for (const oid of windows[index]) {
            if (already(oid)) continue;
            seen.push(oid);
            commits.push({ sha: oid.slice(0, 7), oid, branch: null, at: item.to, inferred: true, exists: true, cwd: item.place.cwd });
          }
          continue;
        }
        const oid = item.place ? objects.get(`${item.place.cwd}\u0000${item.sha}`) : undefined;
        const id = typeof oid === 'string' ? oid : item.sha;
        if (already(id)) continue;
        seen.push(id);
        commits.push({ sha: item.sha.slice(0, 7), oid: typeof oid === 'string' ? oid : null, branch: item.branch, at: item.at, inferred: false, exists: oid === false ? false : typeof oid === 'string' ? true : null, cwd: item.place?.cwd ?? null });
      }
      commits.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
      const listed = commits.slice(0, lim.commits);
      await Promise.all(listed.map(async item => {
        const where = item.oid && item.cwd ? await whereIs(item.cwd, item.oid) : { pushed: null, onBranch: null };
        item.pushed = where.pushed;
        item.onBranch = where.pushed === true ? null : where.onBranch;
      }));

      const held = holdings.get(session.key) ?? null;
      let uncommitted = null;
      const sharedWith = new Map();
      const sharedFiles = [];
      if (held && held.files.size) {
        let shared = 0;
        for (const [rel, at] of held.files) {
          const others = (holders.get(`${held.placeId}\u0000${rel}`) ?? []).filter(item => item.key !== session.key);
          if (!others.length) continue;
          shared++;
          // Who wrote this file last, where both sides know when they did.
          const all = [{ key: session.key, at }, ...others].filter(item => Number.isFinite(item.at));
          const lastBy = all.length === others.length + 1 ? all.reduce((best, item) => (item.at > best.at ? item : best)).key : null;
          if (sharedFiles.length < lim.sharedFiles) sharedFiles.push({ path: rel, with: others.map(item => item.key), lastBy });
          for (const other of others) {
            const entry = sharedWith.get(other.key) ?? { key: other.key, files: 0, thisWroteLast: 0, otherWroteLast: 0 };
            entry.files++;
            if (Number.isFinite(at) && Number.isFinite(other.at)) { if (at >= other.at) entry.thisWroteLast++; else entry.otherWroteLast++; }
            sharedWith.set(other.key, entry);
          }
        }
        // Newest edit first; a file without a time goes last.
        const files = [...held.files].sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0)).map(([rel]) => rel).slice(0, lim.files);
        uncommitted = { count: held.files.size, shared, files, placeId: held.placeId };
      }

      // The newest test run in this session's folder, and whether its own edits there came after it. A folder counts
      // when this place is the deepest one holding it: a worktree nested in the main folder has its own runs and edits.
      const place = held ? byId.get(held.placeId) : session.placeId ? byId.get(session.placeId) : null;
      const roots = place ? place.roots : listOf(session.roots).filter(absolute);
      const within = folder => {
        if (!absolute(folder)) return false;
        const owner = placeFor(folder, usable);
        if (place) return owner === place;
        return roots.some(root => inside(folder, root) && !(owner && owner.roots.some(other => other !== root && inside(other, root))));
      };
      const runs = listOf(session.workLog?.tests).filter(item => isObject(item) && within(item.folder));
      const run = runs[0];
      let lastTest = null;
      let largestTest = null;
      if (run) {
        let lastEdit = null;
        for (const [full, ms] of editsOf.get(session.key)) if (Number.isFinite(ms) && within(full)) lastEdit = Math.max(lastEdit ?? 0, ms);
        const testOf = item => ({ runner: item.runner, passed: item.passed, failed: item.failed, at: iso(item.at), stale: lastEdit === null ? null : lastEdit > item.at });
        lastTest = testOf(run);
        // The newest run is often one test file or a reviewer's targeted run, whose counts would read as the suite's
        // size. So the run in this folder that counted the most tests (the newest of those) is kept beside it when it
        // counted more than the newest one; nothing is judged about which command was the whole suite.
        const counted = item => Number.isSafeInteger(item.passed) && Number.isSafeInteger(item.failed);
        const total = item => item.passed + item.failed;
        let largest = null;
        if (counted(run)) for (const item of runs) if (counted(item) && total(item) > total(run) && (!largest || total(item) > total(largest))) largest = item;
        if (largest) largestTest = testOf(largest);
      }
      const log = session.workLog;
      const asked = isObject(log?.asked) && Number.isFinite(log.asked.at) && !(Number.isFinite(log.lastUserAt) && log.lastUserAt >= log.asked.at) ? { at: iso(log.asked.at) } : null;

      const facts = {
        commits: listed.map(({ cwd, ...item }) => ({ ...item, at: iso(item.at) })),
        commitCount: commits.length + unidentified,
        unidentified,
        uncommitted,
        sharedWith: [...sharedWith.values()].sort((a, b) => b.files - a.files || a.key.localeCompare(b.key)).slice(0, lim.sharedWith),
        sharedFiles,
        lastTest,
        largestTest,
        asked,
      };
      if (facts.commitCount || uncommitted || lastTest || asked) out.set(session.key, facts);
    }
    return out;
  }

  return { compute, clear: () => cache.clear() };
}
