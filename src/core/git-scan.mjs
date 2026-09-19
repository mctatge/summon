import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** Read-only git inspection. Never writes to a repository, fetches, runs hooks, filters or external diff drivers. */
export const GIT_ENV = Object.freeze({ GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_PAGER: 'cat', GIT_CONFIG_NOSYSTEM: '1', GIT_LITERAL_PATHSPECS: '1', GIT_NO_REPLACE_OBJECTS: '1', LC_ALL: 'C' });

const LIMITS = { places: 30, files: 1000, lstat: 400, dirs: 200, dirFiles: 2000, dirLstat: 600, branches: 300, branchDetails: 25, stashes: 20, concurrency: 4, timeout: 8000, maxBytes: 8 * 1024 * 1024 };
const SMALL = 1024 * 1024;
const PATHSPEC_BYTES = 200_000;
const EXCERPT_FILES = 400;
const SAME_FILES = 2000;
const HEAD_BYTES = 8192;
const SAMPLE_NAMES = 50;
// Blanking more filter drivers than this would bloat every git call's environment; such a folder is not read.
const MAX_FILTERS = 500;
const NOT_OURS = 'This worktree folder no longer belongs to this repository.';
const BORROWED = 'This folder borrows another repository. Add that repository folder instead.';
const UNGUARDED = 'Summon could not check the filter settings here, so it did not read this folder.';
const UNTRACKED_MAX = 1024 * 1024;
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
// C0/C1 controls plus bidi overrides and zero-width marks: repository text is displayed and sent to models.
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;
const NEEDS_QUOTE = /[\u0000-\u001f"\\\u007f]/;
const ESCAPES = { 7: 'a', 8: 'b', 9: 't', 10: 'n', 11: 'v', 12: 'f', 13: 'r', 34: '"', 92: '\\' };
// One record per ref; the free-text subject goes last so a stray separator in it cannot shift other fields.
const REF_FIELDS = ['%(refname)', '%(objectname)', '%(upstream:short)', '%(upstream:track)', '%(committerdate:iso-strict)', '%(worktreepath)', '%(contents:subject)'];
const REF_FORMAT = `${REF_FIELDS.join('%1f')}%00`;
const NUMSTAT = ['--numstat', '-z', '--no-ext-diff', '--no-textconv'];

const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const isOid = value => typeof value === 'string' && OID.test(value) && !/^0+$/.test(value);
const short = oid => (isOid(oid) ? oid.slice(0, 8) : null);
const sha256 = text => createHash('sha256').update(text).digest('hex');
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0');
const within = (candidate, root) => candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
const relativePath = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0') && !value.startsWith('/') && !value.split('/').some(part => part === '..' || part === '.');
const oneLine = text => String(text ?? '').replace(/\r?\n$/, '');
const cleanText = (text, max = 300) => String(text ?? '').replace(UNSAFE_TEXT, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const zsplit = text => String(text ?? '').split('\0').filter(Boolean);
// for-each-ref ends every record with the %00 we asked for plus its own newline.
const records = text => String(text ?? '').split('\0').map(record => record.replace(/^\n/, '')).filter(Boolean);
const subjects = (text, max) => zsplit(text).slice(0, max).map(subject => cleanText(subject)).filter(Boolean);

function cut(text, width) {
  const chars = [...text];
  return chars.length <= width ? text : `${chars.slice(0, Math.max(1, width - 1)).join('')}…`;
}

// Same escaping as git's quote_c_style with core.quotePath=false (bytes >= 0x80 stay literal).
function cquote(name, force = false) {
  if (!force && !NEEDS_QUOTE.test(name)) return name;
  let out = '"';
  for (const char of name) {
    const code = char.codePointAt(0);
    if (ESCAPES[code]) out += `\\${ESCAPES[code]}`;
    else if (code < 0x20 || code === 0x7f) out += `\\${code.toString(8).padStart(3, '0')}`;
    else out += char;
  }
  return `${out}"`;
}

function limiter(max) {
  let active = 0;
  const waiting = [];
  const release = () => { const next = waiting.shift(); if (next) next(); else active--; };
  return async task => {
    if (active < max) active++;
    else await new Promise(resolve => waiting.push(resolve));
    try { return await task(); } finally { release(); }
  };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const index = next++; out[index] = await fn(items[index], index); } };
  await Promise.all(Array.from({ length: Math.max(0, Math.min(limit, items.length)) }, worker));
  return out;
}

function plainError(error, fallback) {
  const text = `${error?.message ?? ''}\n${error?.stderr ?? ''}`;
  if (/timed out/i.test(text)) return 'Git took too long to answer. Try again in a moment.';
  if (/exceeded the allowed size/i.test(text)) return 'There are too many changes here to list.';
  if (/shutting down/i.test(text)) return 'Summon is shutting down.';
  if (/dubious ownership|safe\.directory/i.test(text)) return 'Git does not trust this folder because another user owns it.';
  if (/not a git repository|gitdir file points|invalid gitfile/i.test(text)) return 'This folder is no longer connected to its git repository.';
  return fallback;
}

// Callers pass scrubbedEnv(GIT_ENV); the safety variables are re-applied here anyway and any
// inherited GIT_* variable (GIT_DIR from a hook, GIT_EXTERNAL_DIFF, ...) is dropped.
function childEnv(env) {
  const source = env && typeof env === 'object' ? env : { HOME: process.env.HOME, USER: process.env.USER, TMPDIR: process.env.TMPDIR, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
  const out = {};
  for (const [key, value] of Object.entries(source)) if (typeof value === 'string' && !key.startsWith('GIT_')) out[key] = value;
  return { ...out, ...GIT_ENV };
}

/** Global options that keep every git call read-only: no optional locks, index refreshes, fsmonitor, hooks, external diff or colour. */
export function gitArgs(cwd, args) {
  if (!absolute(cwd)) throw new TypeError('Git needs an absolute folder path.');
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new TypeError('Git arguments must be a list of strings.');
  // diff.autoRefreshIndex=false: `git diff` otherwise rewrites .git/index for stat-only changes even with --no-optional-locks.
  return ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external=', '-c', 'diff.autoRefreshIndex=false', '-c', 'core.quotePath=false', '-c', 'color.ui=false', '-c', 'log.showSignature=false', '-C', cwd, ...args];
}

function gitRunner({ run, git, env }, { timeout = LIMITS.timeout, maxBytes = LIMITS.maxBytes, concurrency = LIMITS.concurrency } = {}) {
  if (typeof run !== 'function') throw new TypeError('A process runner is required.');
  if (!absolute(git)) throw new TypeError('The git executable must be an absolute path.');
  const gate = limiter(Math.max(1, concurrency));
  const base = childEnv(env);
  let variables = base;
  // One set of filter names for the whole runner. Blanking a name that a folder does not define has no effect,
  // and rebuilding from the whole set means two lookups that finish together cannot drop each other's names.
  const blanked = new Set();
  const call = (cwd, args, options = {}) => gate(async () => (await run(git, gitArgs(cwd, args), { cwd, env: variables, timeout, maxBytes: options.maxBytes ?? maxBytes, input: options.input })).stdout);
  // Status and worktree diffs read file contents through clean filters (git-lfs is configured globally).
  // Configured filter drivers are blanked through command-line-scope config, which git treats as "no filter".
  // Each folder is looked up in its own context: a linked worktree's config.worktree and onbranch includes
  // only apply there. Resolves false when the lookup failed, so the caller does not read that folder (fail closed).
  call.disableFilters = async cwd => {
    let text;
    try { text = await call(cwd, ['config', '-z', '--get-regexp', '^filter\\.'], { maxBytes: SMALL }); }
    catch (error) { return error?.exitCode === 1 && !String(error?.stdout ?? '').trim(); }
    let added = false;
    for (const record of text.split('\0')) {
      const match = /^filter\.([\s\S]+)\.(?:clean|smudge|process|required)$/.exec(record.split('\n', 1)[0]);
      if (match && !blanked.has(match[1])) { blanked.add(match[1]); added = true; }
    }
    if (blanked.size > MAX_FILTERS) return false;
    if (added) {
      const next = { ...base };
      let count = 0;
      for (const name of blanked) for (const key of ['clean', 'smudge', 'process']) { next[`GIT_CONFIG_KEY_${count}`] = `filter.${name}.${key}`; next[`GIT_CONFIG_VALUE_${count}`] = ''; count++; }
      next.GIT_CONFIG_COUNT = String(count);
      variables = next;
    }
    return true;
  };
  return call;
}

/** 'main' for the repository's own folder, otherwise which tool made the worktree, judged by where it lives. */
export function placeKind(worktreePath, mainPath) {
  const place = String(worktreePath ?? '').replace(/\/+$/, '');
  if (mainPath != null && place === String(mainPath).replace(/\/+$/, '')) return 'main';
  const probe = `${place}/`;
  if (probe.includes('/.claude/worktrees/') || probe.includes('/.claude-worktrees/')) return 'claude';
  if (probe.includes('/.codex/worktrees/')) return 'codex';
  if (probe.includes('/.cursor/worktrees/')) return 'cursor';
  return 'other';
}

function statusFields(token, count) {
  const out = [];
  let start = 2;
  for (let index = 0; index < count; index++) {
    const end = token.indexOf(' ', start);
    if (end === -1) return null;
    out.push(token.slice(start, end));
    start = end + 1;
  }
  out.push(token.slice(start));
  return out;
}

/** Parses `git status --porcelain=v2 --branch --show-stash -z`. Collapsed untracked folders keep their trailing '/'. */
export function parseStatusV2(text) {
  const result = { oid: null, head: null, detached: false, upstream: null, ahead: null, behind: null, stashCount: 0, entries: [] };
  const tokens = String(text ?? '').split('\0');
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token) continue;
    if (token.startsWith('# ')) {
      const space = token.indexOf(' ', 2);
      const key = space === -1 ? token.slice(2) : token.slice(2, space);
      const value = space === -1 ? '' : token.slice(space + 1);
      if (key === 'branch.oid') result.oid = isOid(value) ? value : null;
      else if (key === 'branch.head') { result.detached = value === '(detached)'; result.head = result.detached || !value ? null : value; }
      else if (key === 'branch.upstream') result.upstream = value || null;
      else if (key === 'branch.ab') { const match = /^\+(\d+) -(\d+)$/.exec(value); if (match) { result.ahead = Number(match[1]); result.behind = Number(match[2]); } }
      else if (key === 'stash') result.stashCount = Number.parseInt(value, 10) || 0;
      continue;
    }
    const type = token[0];
    if (token[1] !== ' ') continue;
    if (type === '1') {
      const f = statusFields(token, 7);
      if (f && f[7]) result.entries.push({ path: f[7], origPath: null, xy: f[0], kind: 'ordinary', sub: f[1], modeHead: f[2], modeWorktree: f[4] });
    } else if (type === '2') {
      const f = statusFields(token, 8);
      const origPath = tokens[++index] ?? null;
      if (f && f[8]) result.entries.push({ path: f[8], origPath: origPath || null, xy: f[0], kind: 'renamed', sub: f[1], modeHead: f[2], modeWorktree: f[4] });
    } else if (type === 'u') {
      const f = statusFields(token, 9);
      if (f && f[9]) result.entries.push({ path: f[9], origPath: null, xy: f[0], kind: 'unmerged', sub: f[1], modeHead: f[3], modeWorktree: f[5] });
    } else if (type === '?') {
      const entryPath = token.slice(2);
      if (entryPath) result.entries.push({ path: entryPath, origPath: null, xy: '??', kind: 'untracked', modeHead: null, modeWorktree: null });
    }
  }
  return result;
}

/** Parses `git diff --numstat -z`, including the rename form (empty path, then old and new path). */
export function parseNumstatZ(text) {
  const tokens = String(text ?? '').split('\0');
  const out = [];
  for (let index = 0; index < tokens.length; index++) {
    const match = /^\n?(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(tokens[index]);
    if (!match) continue;
    let filePath = match[3];
    let origPath = null;
    if (filePath === '') { origPath = tokens[++index] || null; filePath = tokens[++index] ?? ''; }
    if (!filePath) continue;
    out.push({ path: filePath, origPath, added: match[1] === '-' ? null : Number(match[1]), removed: match[2] === '-' ? null : Number(match[2]), binary: match[1] === '-' && match[2] === '-' });
  }
  return out;
}

/** Parses `git worktree list --porcelain -z`. The first record is the main worktree (or the bare repository). */
export function parseWorktreesZ(text) {
  const out = [];
  let current = null;
  for (const token of String(text ?? '').split('\0')) {
    if (!token) { current = null; continue; }
    if (token.startsWith('worktree ')) {
      current = { path: token.slice(9), head: null, branch: null, detached: false, bare: false, locked: false, prunable: false };
      out.push(current);
      continue;
    }
    if (!current) continue;
    if (token.startsWith('HEAD ')) current.head = isOid(token.slice(5)) ? token.slice(5) : null;
    else if (token.startsWith('branch ')) current.branch = token.slice(7).replace(/^refs\/heads\//, '') || null;
    else if (token === 'detached') current.detached = true;
    else if (token === 'bare') current.bare = true;
    else if (token === 'locked' || token.startsWith('locked ')) current.locked = true;
    else if (token === 'prunable' || token.startsWith('prunable ')) current.prunable = true;
  }
  return out;
}

function parseTrack(track, hasUpstream) {
  if (!hasUpstream) return { gone: false, ahead: null, behind: null };
  if (/\bgone\b/.test(track)) return { gone: true, ahead: null, behind: null };
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  return { gone: false, ahead: ahead ? Number(ahead[1]) : 0, behind: behind ? Number(behind[1]) : 0 };
}

function parseRefs(text, max) {
  const out = [];
  for (const record of records(text)) {
    const parts = record.split('\x1f');
    if (parts.length < REF_FIELDS.length || !parts[0].startsWith('refs/heads/')) continue;
    const [refname, oid, upstream, track, date, worktreePath] = parts;
    const name = refname.slice('refs/heads/'.length);
    if (!name || !isOid(oid)) continue;
    const tracking = parseTrack(track, Boolean(upstream));
    const time = Date.parse(date);
    out.push({ name, tip: short(oid), oid, subject: cleanText(parts.slice(6).join(' ')), lastCommitAt: Number.isFinite(time) ? iso(time) : null, upstream: upstream || null, upstreamGone: tracking.gone, ahead: tracking.ahead, behind: tracking.behind, aheadOfBase: null, behindBase: null, isDefault: false, worktreePath: worktreePath || null, recentSubjects: [], topPaths: [], added: null, removed: null });
    if (out.length >= max) break;
  }
  return out;
}

function fileFromEntry(entry) {
  const [x, y] = entry.xy;
  let status;
  let staged = false;
  let unstaged = false;
  if (entry.kind === 'untracked') status = 'untracked';
  else if (entry.kind === 'unmerged') { status = 'conflicted'; unstaged = true; }
  else {
    staged = x !== '.';
    unstaged = y !== '.';
    if (x === 'T' || y === 'T') status = 'typechange';
    else if (entry.kind === 'renamed') status = x === 'C' || y === 'C' ? 'added' : 'renamed';
    else if (x === 'A') status = 'added';
    else if (x === 'D' || y === 'D') status = 'deleted';
    else status = 'modified';
  }
  const isDir = status === 'untracked' && entry.path.endsWith('/');
  // A submodule (gitlink) is a nested repository: its contents are never excerpted.
  const submodule = entry.sub?.[0] === 'S' || entry.modeHead === '160000' || entry.modeWorktree === '160000';
  return { path: entry.path, origPath: entry.origPath, status, staged, unstaged, added: null, removed: null, binary: false, isDir, fileCount: null, extensions: null, size: null, mtimeMs: null, submodule };
}

function pathspecBatch(paths) {
  const out = [];
  let bytes = 0;
  for (const item of paths) {
    bytes += Buffer.byteLength(item) + 1;
    if (bytes > PATHSPEC_BYTES) break;
    out.push(item);
  }
  return out;
}

// Counts files inside collapsed untracked folders and drops folders that only hold this repository's own worktrees.
async function describeUntrackedDirs(g, place, files, worktreePaths, lim) {
  const dirs = pathspecBatch(files.filter(file => file.isDir).slice(0, lim.dirs).map(file => file.path));
  if (!dirs.length) return { files, samples: new Map() };
  let listing;
  try { listing = zsplit(await g(place.path, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...dirs])); } catch { return { files, samples: new Map() }; }
  const wanted = new Set(dirs);
  const info = new Map(dirs.map(dir => [dir, { count: 0, worktrees: 0, histogram: new Map(), seen: 0, samples: [] }]));
  let sampleBudget = lim.dirLstat;
  for (const entry of listing) {
    let owner = wanted.has(entry) ? entry : null;
    for (let slash = entry.indexOf('/'); !owner && slash !== -1 && slash < entry.length - 1; slash = entry.indexOf('/', slash + 1)) {
      const prefix = entry.slice(0, slash + 1);
      if (wanted.has(prefix)) owner = prefix;
    }
    if (!owner) continue;
    const bucket = info.get(owner);
    if (entry.endsWith('/') && worktreePaths.has(path.join(place.path, entry).replace(/\/+$/, ''))) { bucket.worktrees++; continue; }
    bucket.count++;
    if (bucket.seen < lim.dirFiles) {
      bucket.seen++;
      const extension = entry.endsWith('/') ? '' : path.extname(entry).toLowerCase();
      if (extension && extension.length <= 16) bucket.histogram.set(extension, (bucket.histogram.get(extension) ?? 0) + 1);
    }
    if (sampleBudget > 0 && !entry.endsWith('/')) { bucket.samples.push(entry); sampleBudget--; }
  }
  const samples = new Map();
  const kept = files.filter(file => {
    const bucket = file.isDir ? info.get(file.path) : null;
    if (!bucket) return !(file.isDir && worktreePaths.has(path.join(place.path, file.path).replace(/\/+$/, '')));
    if (bucket.count === 0 && bucket.worktrees > 0) return false;
    file.fileCount = bucket.count;
    file.extensions = Object.fromEntries([...bucket.histogram].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 6));
    samples.set(file.path, bucket.samples);
    // A few names inside the new folder help pair moves (deleted notes that reappear here); workstreams.mjs filters private ones.
    file.samples = bucket.samples.slice(0, SAMPLE_NAMES);
    return true;
  });
  return { files: kept, samples };
}

async function statFiles(placePath, files, samples, lim) {
  const targets = files.slice(0, lim.lstat);
  await mapLimit(targets, 16, async file => {
    try {
      const stat = await fs.lstat(path.join(placePath, file.path));
      file.mtimeMs = stat.mtimeMs;
      if (!file.isDir) { file.size = stat.size; return; }
    } catch { return; }
    let size = 0;
    let measured = false;
    for (const entry of samples.get(file.path) ?? []) {
      try {
        const stat = await fs.lstat(path.join(placePath, entry));
        size += stat.size;
        measured = true;
        if (stat.mtimeMs > file.mtimeMs) file.mtimeMs = stat.mtimeMs;
      } catch { /* A file can vanish between listing and stat. */ }
    }
    file.size = measured ? size : null;
  });
}

function fingerprintOf(oid, files) {
  const rows = [...files].sort(byPath).map(file => [file.path, file.status, file.staged, file.added, file.removed, file.size, file.mtimeMs, file.fileCount]);
  return sha256(JSON.stringify([oid ?? null, rows]));
}

// A linked worktree's `.git` file must point into this repository's own worktrees folder. Checked before any git
// call there, so a redirected `.git` file never makes git read another repository's metadata.
async function ownGitFile(placePath, realCommonDir) {
  let handle;
  try {
    const dotGit = path.join(placePath, '.git');
    const info = await fs.lstat(dotGit);
    if (!info.isFile() || info.size > 4096) return false;
    handle = await fs.open(dotGit, constants.O_RDONLY | constants.O_NOFOLLOW);
    const line = (await handle.readFile('utf8')).split('\n', 1)[0].replace(/\r$/, '');
    if (!line.startsWith('gitdir: ') || line.length <= 8 || line.includes('\0')) return false;
    const target = await fs.realpath(path.resolve(placePath, line.slice(8)));
    return path.dirname(target) === path.join(realCommonDir, 'worktrees');
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

// Same check as the main folder's: git must see this folder as the top of a checkout of this repository.
// A per-worktree core.worktree redirect shows up here as a different top level.
async function ownCheckout(g, placePath, realCommonDir, skipped) {
  try {
    const [common, top] = oneLine(await g(placePath, ['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'], { maxBytes: SMALL })).split('\n');
    if (!common || !top || top !== placePath || skipped({ path: top })) return false;
    return (await fs.realpath(common)) === realCommonDir;
  } catch {
    return false;
  }
}

// Everything a place needs before git reads its files: does the folder exist, is it this repository's checkout,
// and are the filter drivers it can see blanked. Runs for every place before any of them is scanned.
async function preparePlace(g, worktree, { isMain, realCommonDir, skipped }) {
  try { if (!(await fs.stat(worktree.path)).isDirectory()) return { missing: true }; } catch { return { missing: true }; }
  if (!isMain) {
    if (!(await ownGitFile(worktree.path, realCommonDir)) || !(await ownCheckout(g, worktree.path, realCommonDir, skipped))) return { error: NOT_OURS };
    if (!(await g.disableFilters(worktree.path))) return { error: UNGUARDED };
  }
  return {};
}

async function scanPlace(g, worktree, { isMain, mainPath, worktreePaths, lim, check = {} }) {
  const place = { path: worktree.path, kind: isMain ? 'main' : placeKind(worktree.path, mainPath), isMain, missing: false, branch: worktree.branch, detached: worktree.detached, head: short(worktree.head), oid: worktree.head, upstream: null, ahead: null, behind: null, aheadOfBase: null, behindBase: null, files: [], filesTruncated: false, counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, added: 0, removed: 0, lastChangedAt: null, recentSubjects: [], fingerprint: null, locked: worktree.locked, error: null };
  let stashCount = 0;
  if (check.missing) { place.missing = true; return { place, stashCount }; }
  if (check.error) { place.error = check.error; return { place, stashCount }; }
  let status;
  // --ignore-submodules=dirty: otherwise git starts a status inside each submodule, which runs that submodule's own filters.
  try { status = parseStatusV2(await g(place.path, ['status', '--porcelain=v2', '--branch', '--show-stash', '-z', '--untracked-files=normal', '--ignore-submodules=dirty'])); }
  catch (error) { place.error = plainError(error, 'Summon could not read the changes in this folder.'); return { place, stashCount }; }
  stashCount = status.stashCount;
  Object.assign(place, { oid: status.oid, head: short(status.oid), branch: status.head, detached: status.detached, upstream: status.upstream, ahead: status.ahead, behind: status.behind });
  const described = await describeUntrackedDirs(g, place, status.entries.map(fileFromEntry), worktreePaths, lim);
  const all = described.files.sort(byPath);
  if (all.some(file => file.status !== 'untracked')) {
    const base = place.oid ? [place.oid] : ['--cached'];
    try {
      const totals = new Map();
      for (const row of parseNumstatZ(await g(place.path, ['diff', ...NUMSTAT, '--no-renames', '--ignore-submodules=dirty', ...base, '--']))) {
        const sum = totals.get(row.path) ?? { added: 0, removed: 0, binary: false };
        if (row.binary) sum.binary = true;
        sum.added += row.added ?? 0;
        sum.removed += row.removed ?? 0;
        totals.set(row.path, sum);
      }
      for (const file of all) {
        const sum = totals.get(file.path);
        const old = file.origPath ? totals.get(file.origPath) : null;
        if (!sum && !old) continue;
        file.binary = Boolean(sum?.binary || old?.binary);
        file.added = file.binary ? null : (sum?.added ?? 0) + (old?.added ?? 0);
        file.removed = file.binary ? null : (sum?.removed ?? 0) + (old?.removed ?? 0);
      }
    } catch { /* Unborn or unreadable HEAD: counts stay unknown. */ }
  }
  for (const file of all) {
    if (file.status === 'conflicted') place.counts.conflicted++;
    else if (file.status === 'untracked') place.counts.untracked++;
    else { if (file.staged) place.counts.staged++; if (file.unstaged) place.counts.unstaged++; }
    place.added += file.added ?? 0;
    place.removed += file.removed ?? 0;
  }
  place.files = all.slice(0, lim.files);
  place.filesTruncated = all.length > place.files.length;
  await statFiles(place.path, place.files, described.samples, lim);
  const newest = Math.max(-Infinity, ...place.files.map(file => file.mtimeMs ?? -Infinity));
  place.lastChangedAt = iso(newest);
  if (place.oid) place.recentSubjects = await g(place.path, ['log', '-z', '--format=%s', '--max-count=5', place.oid, '--'], { maxBytes: SMALL }).then(text => subjects(text, 5), () => []);
  place.fingerprint = fingerprintOf(place.oid, place.files);
  return { place, stashCount };
}

async function leftRight(g, cwd, baseOid, oid) {
  if (baseOid === oid) return { ahead: 0, behind: 0 };
  try {
    const match = /^(\d+)\s+(\d+)/.exec(await g(cwd, ['rev-list', '--left-right', '--count', `${baseOid}...${oid}`, '--'], { maxBytes: SMALL }));
    return match ? { behind: Number(match[1]), ahead: Number(match[2]) } : null;
  } catch { return null; }
}

async function aheadBehind(g, repoPath, branches, baseOid, lim) {
  let found = 0;
  try {
    const text = await g(repoPath, ['for-each-ref', `--format=%(refname)%1f%(ahead-behind:${baseOid})%00`, 'refs/heads']);
    const counts = new Map();
    for (const record of records(text)) {
      const [ref, pair] = record.split('\x1f');
      const match = /^(\d+) (\d+)$/.exec(pair ?? '');
      if (match && ref.startsWith('refs/heads/')) counts.set(ref.slice('refs/heads/'.length), [Number(match[1]), Number(match[2])]);
    }
    for (const branch of branches) {
      const pair = counts.get(branch.name);
      if (pair) { [branch.aheadOfBase, branch.behindBase] = pair; found++; }
    }
  } catch { /* %(ahead-behind) needs git 2.41; fall back to rev-list below. */ }
  if (found || !branches.length) return;
  await mapLimit(branches.slice(0, lim.branches), lim.concurrency, async branch => {
    const counts = await leftRight(g, repoPath, baseOid, branch.oid);
    if (counts) { branch.aheadOfBase = counts.ahead; branch.behindBase = counts.behind; }
  });
}

async function branchDetails(g, repoPath, branch, baseOid) {
  const [log, numstat] = await Promise.all([
    g(repoPath, ['log', '-z', '--format=%s', '--max-count=6', `${baseOid}..${branch.oid}`, '--'], { maxBytes: SMALL }).catch(() => null),
    g(repoPath, ['diff', ...NUMSTAT, `${baseOid}...${branch.oid}`, '--']).catch(() => null)
  ]);
  if (log != null) branch.recentSubjects = subjects(log, 6);
  if (numstat == null) return;
  const rows = parseNumstatZ(numstat);
  const weight = row => (row.added ?? 0) + (row.removed ?? 0);
  branch.topPaths = [...rows].sort((a, b) => weight(b) - weight(a) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).slice(0, 12).map(row => row.path);
  branch.added = rows.reduce((sum, row) => sum + (row.added ?? 0), 0);
  branch.removed = rows.reduce((sum, row) => sum + (row.removed ?? 0), 0);
}

async function readStashes(g, repoPath, lim) {
  const text = await g(repoPath, ['stash', 'list', '-z', `--max-count=${lim.stashes}`, '--format=%gd%x1f%ct%x1f%gs'], { maxBytes: SMALL });
  const stashes = [];
  for (const record of zsplit(text).slice(0, lim.stashes)) {
    const [ref, seconds, ...rest] = record.split('\x1f');
    const index = /@\{(\d+)\}$/.exec(ref ?? '')?.[1];
    if (index === undefined) continue;
    const subject = rest.join(' ');
    const match = /^(WIP on|On) ([^:]*): ([\s\S]*)$/.exec(subject);
    const wip = match?.[1] === 'WIP on';
    const branch = match && match[2] !== '(no branch)' ? match[2] : null;
    const message = match ? (wip ? match[3].replace(/^[0-9a-f]{7,64} /, '') : match[3]) : subject;
    const time = Number(seconds) * 1000;
    stashes.push({ index: Number(index), ref: `stash@{${index}}`, message: cleanText(message), wip, branch, createdAt: Number.isFinite(time) && time > 0 ? iso(time) : null, files: null });
  }
  await mapLimit(stashes, 2, async stash => {
    try {
      const rows = parseNumstatZ(await g(repoPath, ['stash', 'show', '--include-untracked', ...NUMSTAT, stash.ref]));
      stash.files = new Set(rows.map(row => row.path)).size;
    } catch { /* Leave the count unknown. */ }
  });
  return stashes;
}

/**
 * Scans one repository (all worktrees, branches, stashes) without changing it. Never throws; failures land in `error`/`warnings`.
 * `skipPath(worktreePath)` returning true leaves that linked worktree out entirely: its folder is never stat'ed or read.
 */
export async function scanRepo(repoPath, { run, git, env, now = () => Date.now(), limits = {}, skipPath = () => false } = {}) {
  const lim = { ...LIMITS, ...limits };
  const startedAt = now();
  const repo = { path: repoPath, commonDir: null, defaultBranch: null, hasRemote: false, lastFetchedAt: null, places: [], branches: [], stashes: [], scannedAt: iso(startedAt), durationMs: null, error: null, warnings: [] };
  const warn = message => { if (!repo.warnings.includes(message) && repo.warnings.length < 12) repo.warnings.push(message); };
  try {
    if (!absolute(repoPath)) { repo.error = 'This folder path is not valid.'; return repo; }
    const g = gitRunner({ run, git, env }, lim);
    try { if (!(await fs.stat(repoPath)).isDirectory()) throw new Error('Not a folder.'); }
    catch { repo.error = 'This folder no longer exists.'; return repo; }
    const skipped = item => { try { return skipPath(item.path) === true; } catch { return true; } };
    // A `.git` folder with a `commondir` file uses another repository's refs, objects and main folder. Git never
    // writes one at the top level, so refuse it before git reads anything from that other repository.
    try { await fs.lstat(path.join(repoPath, '.git', 'commondir')); repo.error = BORROWED; return repo; }
    catch (error) { if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') { repo.error = 'Summon could not read this folder as a git repository.'; return repo; } }
    let realRepo;
    let realCommonDir;
    try {
      const [commonDir, topLevel] = oneLine(await g(repoPath, ['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'], { maxBytes: SMALL })).split('\n');
      realRepo = await fs.realpath(repoPath);
      // A folder nested inside a larger repository (a dotfiles repo in ~, say) must not be scanned as that repository.
      if (!topLevel || topLevel !== realRepo) { repo.error = 'This folder is inside a larger git repository. Add the repository folder itself.'; return repo; }
      // Backstop for the check above: the repository must be this folder's own `.git`, outside every skipped path.
      realCommonDir = commonDir ? await fs.realpath(commonDir).catch(() => null) : null;
      if (!realCommonDir || realCommonDir !== path.join(realRepo, '.git') || skipped({ path: commonDir }) || skipped({ path: realCommonDir })) { repo.error = BORROWED; return repo; }
      repo.commonDir = commonDir;
    } catch (error) {
      const text = `${error?.message ?? ''}\n${error?.stderr ?? ''}`;
      repo.error = /not a git repository \(or any/i.test(text) ? 'This folder is not a git repository.' : plainError(error, 'Summon could not read this folder as a git repository.');
      return repo;
    }
    if (!(await g.disableFilters(repoPath))) { repo.error = 'Summon could not check this repository\'s filter settings, so it did not read it.'; return repo; }
    const [worktreeText, remoteText, refsText, originHead, fetchedAt] = await Promise.all([
      g(repoPath, ['worktree', 'list', '--porcelain', '-z'], { maxBytes: SMALL }).catch(() => { warn('Summon could not list the extra worktrees.'); return null; }),
      g(repoPath, ['remote'], { maxBytes: SMALL }).catch(() => ''),
      g(repoPath, ['for-each-ref', `--format=${REF_FORMAT}`, 'refs/heads']).catch(() => { warn('Summon could not list the branches.'); return ''; }),
      g(repoPath, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], { maxBytes: SMALL }).then(oneLine, () => null),
      repo.commonDir ? fs.stat(path.join(repo.commonDir, 'FETCH_HEAD')).then(stat => iso(stat.mtimeMs), () => null) : null
    ]);
    repo.hasRemote = remoteText.split('\n').some(Boolean);
    repo.lastFetchedAt = fetchedAt;
    const listed = worktreeText == null ? [{ path: realRepo, head: null, branch: null, detached: false, bare: false, locked: false, prunable: false }] : parseWorktreesZ(worktreeText);
    // The main worktree is exempt from the skip guard only when it is the scanned folder itself.
    const mainItem = listed[0] && !listed[0].bare && listed[0].path === realRepo ? listed[0] : null;
    const mainPath = mainItem ? mainItem.path : null;
    const linked = listed.filter(item => !item.bare && absolute(item.path) && item !== listed[0]);
    // Guard linked worktrees by both the path git printed and the real folder behind it (a symlink can point anywhere).
    const resolved = (await mapLimit(linked.filter(item => !skipped(item)), 8, async item => {
      let real;
      try { real = await fs.realpath(item.path); }
      catch (error) { return error?.code === 'ENOENT' ? { listedPath: item.path, item } : null; }
      return skipped({ path: real }) ? null : { listedPath: item.path, item: { ...item, path: real } };
    })).filter(Boolean);
    const worktrees = [...(mainItem ? [mainItem] : []), ...resolved.map(entry => entry.item)];
    if (worktrees.length > lim.places) warn(`Only the first ${lim.places} worktrees are shown.`);
    const shown = worktrees.slice(0, lim.places);
    const worktreePaths = new Set([...linked, ...worktrees].map(item => item.path.replace(/\/+$/, '')));
    // Branches name the folder they are checked out in by the path git printed; point them at the real folder.
    const realOf = new Map(resolved.map(entry => [entry.listedPath, entry.item.path]));

    const branches = parseRefs(refsText, lim.branches);
    for (const branch of branches) if (branch.worktreePath && realOf.has(branch.worktreePath)) branch.worktreePath = realOf.get(branch.worktreePath);
    const byName = new Map(branches.map(branch => [branch.name, branch]));
    const main = mainPath ? shown[0] : null;
    const origin = originHead?.startsWith('origin/') ? originHead.slice('origin/'.length) : null;
    repo.defaultBranch = [origin, main && !main.detached ? main.branch : null, 'main', 'master'].find(name => name && byName.has(name)) ?? null;
    const base = repo.defaultBranch ? byName.get(repo.defaultBranch) : null;
    if (base) { base.isDefault = true; base.aheadOfBase = 0; base.behindBase = 0; }
    repo.branches = branches;

    const details = (async () => {
      if (!base) return;
      await aheadBehind(g, repoPath, branches.filter(branch => !branch.isDefault), base.oid, lim);
      const candidates = branches.filter(branch => !branch.isDefault && branch.aheadOfBase > 0).sort((a, b) => (b.lastCommitAt ?? '').localeCompare(a.lastCommitAt ?? '')).slice(0, lim.branchDetails);
      await mapLimit(candidates, lim.concurrency, branch => branchDetails(g, repoPath, branch, base.oid));
    })().catch(() => warn('Summon could not compare every branch with the main line.'));
    // Every place is checked (and its filters blanked) before any place's files are read.
    const checks = await mapLimit(shown, lim.concurrency, (worktree, index) => preparePlace(g, worktree, { isMain: index === 0 && Boolean(mainPath), realCommonDir, skipped }));
    const scanned = await mapLimit(shown, lim.concurrency, (worktree, index) => scanPlace(g, worktree, { isMain: index === 0 && Boolean(mainPath), mainPath, worktreePaths, lim, check: checks[index] }));
    await details;
    repo.places = scanned.map(item => item.place);
    const mainScan = mainPath ? scanned[0] : null;
    if (mainScan?.place.error) repo.error = mainScan.place.error;

    if (base) {
      await mapLimit(repo.places.filter(place => !place.missing && place.oid), lim.concurrency, async place => {
        const branch = !place.detached && place.branch ? byName.get(place.branch) : null;
        if (branch && branch.oid === place.oid) { place.aheadOfBase = branch.aheadOfBase; place.behindBase = branch.behindBase; return; }
        const counts = await leftRight(g, repoPath, base.oid, place.oid);
        if (counts) { place.aheadOfBase = counts.ahead; place.behindBase = counts.behind; }
      });
    }
    if (!mainScan || mainScan.place.error || mainScan.stashCount > 0) {
      try { repo.stashes = await readStashes(g, repoPath, lim); }
      catch { warn('Summon could not list the set-aside changes.'); }
    }
    return repo;
  } catch (error) {
    repo.error ??= plainError(error, 'Summon could not finish reading this repository.');
    return repo;
  } finally {
    repo.durationMs = Math.max(0, now() - startedAt);
  }
}

function excerptLines(text, headers, maxLines, width, out) {
  let current = null;
  let inHunk = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = headers.get(line) ?? null;
      inHunk = false;
      if (current && !out.has(current)) out.set(current, []);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('@@')) { inHunk = true; continue; }
    const sign = line[0];
    if (!inHunk || (sign !== '+' && sign !== '-')) continue;
    const lines = out.get(current);
    if (lines.length >= maxLines) continue;
    const body = cleanText(line.slice(1), width * 4);
    if (body) lines.push(cut(`${sign} ${body}`, width));
  }
  return out;
}

/** Changed lines of tracked files versus HEAD ('+ added', '- removed'), capped per file. Missing entries mean no text lines. */
export async function diffExcerpts(placePath, paths, { run, git, env, maxLines = 8, width = 160 } = {}) {
  const out = new Map();
  try {
    if (!absolute(placePath) || !Array.isArray(paths)) return out;
    const wanted = pathspecBatch([...new Set(paths.filter(item => relativePath(item) && !item.endsWith('/')))].slice(0, EXCERPT_FILES));
    if (!wanted.length) return out;
    const lines = Math.max(1, Math.min(200, Math.trunc(maxLines) || 8));
    const cols = Math.max(20, Math.min(1000, Math.trunc(width) || 160));
    const g = gitRunner({ run, git, env });
    if (!(await g.disableFilters(placePath))) return out;
    let base = ['HEAD'];
    try { await g(placePath, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { maxBytes: SMALL }); } catch { base = ['--cached']; }
    const args = ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=dirty', '--src-prefix=a/', '--dst-prefix=b/', ...base, '--'];
    const headersFor = list => new Map(list.map(item => [`diff --git ${cquote(`a/${item}`)} ${cquote(`b/${item}`)}`, item]));
    try {
      excerptLines(await g(placePath, [...args, ...wanted]), headersFor(wanted), lines, cols, out);
    } catch {
      // One oversized file can overflow the batch; retry file by file so the rest still get excerpts.
      out.clear();
      await mapLimit(wanted, 4, async item => {
        try { excerptLines(await g(placePath, [...args, item], { maxBytes: SMALL }), headersFor([item]), lines, cols, out); } catch { /* Skip this file. */ }
      });
    }
  } catch { /* Excerpts are optional context. */ }
  return out;
}

/** First lines of an untracked text file, or null for anything that is not a small regular text file inside the folder. */
export async function readUntrackedHead(placePath, relPath, { maxLines = 8, width = 160 } = {}) {
  if (!absolute(placePath) || !relativePath(relPath) || relPath.endsWith('/')) return null;
  let handle;
  try {
    const root = await fs.realpath(placePath);
    const full = path.join(placePath, relPath);
    const stat = await fs.lstat(full);
    if (!stat.isFile() || stat.size > UNTRACKED_MAX) return null;
    if (!within(await fs.realpath(full), root)) return null;
    handle = await fs.open(full, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size > UNTRACKED_MAX) return null;
    const buffer = Buffer.alloc(Math.min(HEAD_BYTES, opened.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const chunk = buffer.subarray(0, bytesRead);
    if (chunk.includes(0)) return null;
    const lines = Math.max(1, Math.min(200, Math.trunc(maxLines) || 8));
    const cols = Math.max(20, Math.min(1000, Math.trunc(width) || 160));
    return chunk.toString('utf8').replace(/^﻿/, '').split(/\r?\n/).map(line => cleanText(line, cols * 4)).filter(Boolean).slice(0, lines).map(line => cut(line, cols));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function entryKind(root, rel) {
  try {
    const stat = await fs.lstat(path.join(root, rel));
    if (stat.isSymbolicLink()) return { type: 'link', target: await fs.readlink(path.join(root, rel)) };
    if (stat.isFile()) return { type: 'file', size: stat.size, exec: (stat.mode & 0o111) !== 0 };
    return { type: 'other' };
  } catch (error) {
    return error.code === 'ENOENT' ? { type: 'missing' } : { type: 'error' };
  }
}

/** True when both folders hold byte-identical versions of these changed paths. Hashes without writing objects; false on any doubt. */
export async function sameChanges(placeA, placeB, paths, { run, git, env } = {}) {
  try {
    if (!absolute(placeA) || !absolute(placeB) || !Array.isArray(paths) || !paths.length || paths.length > SAME_FILES) return false;
    if (!paths.every(relativePath)) return false;
    const g = gitRunner({ run, git, env });
    const files = [];
    for (const item of new Set(paths)) {
      if (!item.endsWith('/')) { files.push(item); continue; }
      const list = async root => zsplit(await g(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', item], { maxBytes: SMALL })).sort();
      const [left, right] = await Promise.all([list(placeA), list(placeB)]);
      if (left.length !== right.length || left.some((entry, index) => entry !== right[index])) return false;
      files.push(...left);
      if (files.length > SAME_FILES) return false;
    }
    const hashed = [];
    for (const item of files) {
      if (item.endsWith('/')) return false;
      const [a, b] = await Promise.all([entryKind(placeA, item), entryKind(placeB, item)]);
      if (a.type !== b.type || a.type === 'other' || a.type === 'error') return false;
      if (a.type === 'link' && a.target !== b.target) return false;
      if (a.type === 'file') { if (a.size !== b.size || a.exec !== b.exec) return false; hashed.push(item); }
    }
    if (!hashed.length) return true;
    const input = `${hashed.map(item => (item.startsWith('"') || /[\r\n]/.test(item) ? cquote(item, true) : item)).join('\n')}\n`;
    const hashes = async root => oneLine(await g(root, ['hash-object', '--no-filters', '--stdin-paths'], { input, maxBytes: SMALL })).split('\n');
    const [left, right] = await Promise.all([hashes(placeA), hashes(placeB)]);
    return left.length === hashed.length && right.length === hashed.length && left.every((hash, index) => isOid(hash) && hash === right[index]);
  } catch {
    return false;
  }
}
