import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { GIT_ENV, gitArgs, scanRepo, diffExcerpts, readUntrackedHead, sameChanges } from './git-scan.mjs';
import { AREAS, READINESS, DEFAULT_PRIVATE_SEGMENTS, EXCERPT_SOURCE_WIDTH, classifyPath, classifyFile, excerptEligible, hidePrivateText, redact, sealedPath, buildGroupingRequest, validateGrouping, fallbackGrouping, stabilize } from './workstreams.mjs';
import { createStanding } from './standing.mjs';

const VERSION = 1;
const LIMITS = { stateBytes: 2097152, roots: 20, privateRepos: 200, privatePrefixes: 40, prefixChars: 200, groupings: 300, branchSummaries: 1000, workstreams: 100, scanConcurrency: 4, deadlineMs: 12000, jobConcurrency: 2, untrackedHeads: 20, excerptFiles: 250, branchesPerRequest: 25, viewBranches: 100, viewStashes: 20, errors: 12, mirrorCache: 500, landedCache: 500, landedSubjects: 5, landedScan: 51, landedChars: 80, landedBytes: 65536, landedTimeout: 4000 };
const ENGINES = ['codex', 'claude', 'off'];
const EFFORTS = ['low', 'medium', 'high'];
const CLAUDE_MODELS = ['opus', 'sonnet', 'haiku'];
const REASONS = ['panel', 'open', 'agent', 'cli'];
const KINDS = ['main', 'claude', 'codex', 'cursor', 'other'];
const STATUSES = ['modified', 'added', 'deleted', 'renamed', 'typechange', 'untracked', 'conflicted'];
// consentedAt: when the person first pressed Group changes. Until then, only an explicit click or the CLI sends anything.
const DEFAULT_SETTINGS = { engine: 'codex', effort: 'medium', claudeModel: 'opus', groupOnOpen: true, extraRoots: [], excludedRoots: [], privatePaths: {}, consentedAt: null };
const NOTE_FALLBACK = 'Grouped by folder. Use Group changes for plain-language workstreams.';
const NOTE_FOLDERS = 'Grouped by folder.';
const NOTE_STALE = 'Changed since it was grouped.';
const STILL_CHECKING = 'Still checking; try again in a moment.';
const NEEDS_CONSENT = 'Press Group changes in the Work in flight panel once first, after reading what is sent.';
const SETTINGS_OFF = 'Grouping was turned off because work-in-flight.json could not be read';

/** What grouping sends, and when, for the current settings. Shown before anything is sent. */
export function disclosureFor(settings) {
  if (settings?.engine !== 'codex' && settings?.engine !== 'claude') return 'Grouping is off. Changes are grouped by folder on this Mac.';
  const who = settings.engine === 'claude' ? 'Claude (your Claude sign-in)' : 'Codex (your ChatGPT sign-in)';
  const what = `Grouping sends to ${who}: project, folder and branch names, recent commit messages, changed file names with line counts, short excerpts from non-private text files, and a few file names in new folders. Private folders send only their folder name, file types, change and line counts, and edit dates.`;
  const when = !settings.consentedAt
    ? 'Nothing is sent until you press Group changes.'
    : settings.groupOnOpen
      ? 'Group on open is on, so opening this panel sends changed work right away. Agents you ask can send it too.'
      : 'Nothing is sent until you press Group changes or ask an agent to group.';
  return `${what} ${when}`;
}

const iso = ms => new Date(ms).toISOString();
const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0') && path.normalize(value) === value;
// A root written with a trailing slash still covers the folder itself.
const inside = (candidate, root) => { const base = root.length > 1 ? root.replace(/\/+$/, '') : root; return candidate === base || candidate.startsWith(base.endsWith(path.sep) ? base : `${base}${path.sep}`); };
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
// Repository text is untrusted: drop control and bidirectional-override characters before it reaches any surface.
const clean = (value, max = 300) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max) : '';
const count = value => Number.isSafeInteger(value) && value > 0 ? value : 0;
const numberOrNull = value => Number.isFinite(value) ? value : null;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const signature = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
const placeIdFor = placePath => `place-${hash(placePath).slice(0, 16)}`;
const summaryKey = (repoPath, branch) => `${repoPath} ${branch}`;
const fetchDay = value => validDate(value) ? new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null;
const listOf = value => Array.isArray(value) ? value : [];
const placeFiles = place => listOf(place?.files).filter(file => file && typeof file.path === 'string' && file.path);
const placeCounts = place => ({ staged: count(place?.counts?.staged), unstaged: count(place?.counts?.unstaged), untracked: count(place?.counts?.untracked), conflicted: count(place?.counts?.conflicted) });
// Folders that only hold other folders, so 'src/engine' says more than 'src' (the nested area key in workstreams.mjs).
const NESTED_ROOTS = new Set(['src', 'apps', 'packages', 'services', 'libs', 'crates', 'backend', 'frontend']);
/** Where a folder's changed files sit, when at least half of them sit in the same place: 'src/engine', 'pilot', else null. */
function areaOf(files) {
  const tally = new Map();
  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean);
    const dirs = file.isDir ? parts : parts.slice(0, -1);
    if (!dirs.length) continue;
    const key = dirs.length > 1 && NESTED_ROOTS.has(dirs[0].toLowerCase()) ? `${dirs[0]}/${dirs[1]}` : dirs[0];
    tally.set(key, (tally.get(key) || 0) + 1);
  }
  let best = null;
  for (const [key, n] of tally) if (!best || n > best.n) best = { key, n };
  return best && best.n * 2 >= files.length ? clean(best.key, 120) || null : null;
}
function itemCount(place) {
  const files = placeFiles(place);
  if (!place?.filesTruncated) return files.length;
  const c = placeCounts(place);
  return Math.max(files.length, c.untracked + c.conflicted + Math.max(c.staged, c.unstaged));
}
async function pool(items, size, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const index = next++; await fn(items[index], index); }
  }));
}

function privatePrefix(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Private folders must be plain relative paths.');
  const prefix = value.trim().replace(/^(\.\/)+/, '');
  if (!prefix || prefix.length > LIMITS.prefixChars) throw new Error(`Private folders must contain between 1 and ${LIMITS.prefixChars} characters.`);
  if (prefix.startsWith('/') || prefix.startsWith('~') || prefix.includes('\\') || prefix.split('/').some(segment => segment === '..' || segment === '.')) throw new Error('Private folders must be relative to the project, without "..".');
  return prefix;
}

async function normalizeSettings(patch, current, resolveRoot) {
  if (!isObject(patch)) throw new Error('Settings must be an object.');
  const next = clone(current);
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'engine') {
      if (!ENGINES.includes(value)) throw new Error('Grouping must use codex, claude or off.');
      next.engine = value;
    } else if (key === 'effort') {
      if (!EFFORTS.includes(value)) throw new Error('Grouping effort must be low, medium or high.');
      next.effort = value;
    } else if (key === 'claudeModel') {
      if (!CLAUDE_MODELS.includes(value)) throw new Error('Claude model must be opus, sonnet or haiku.');
      next.claudeModel = value;
    } else if (key === 'groupOnOpen') {
      if (typeof value !== 'boolean') throw new Error('groupOnOpen must be true or false.');
      next.groupOnOpen = value;
    } else if (key === 'consentedAt') {
      if (value !== null && !validDate(value)) throw new Error('consentedAt must be a date or null.');
      next.consentedAt = value;
    } else if (key === 'extraRoots' || key === 'excludedRoots') {
      if (!Array.isArray(value) || value.length > LIMITS.roots) throw new Error(`${key === 'extraRoots' ? 'Extra folders' : 'Skipped folders'} must be a list of up to ${LIMITS.roots} folders.`);
      const roots = [];
      for (const item of value) {
        if (!absolute(item)) throw new Error('Folders must be full paths that start with /.');
        const real = resolveRoot ? await resolveRoot(item) : path.resolve(item);
        if (key === 'extraRoots' && sealedPath(real)) throw new Error('Summon never checks sealed folders.');
        if (!roots.includes(real)) roots.push(real);
      }
      next[key] = roots;
    } else if (key === 'privatePaths') {
      if (!isObject(value) || Object.keys(value).length > LIMITS.privateRepos) throw new Error(`Private folders must be an object with up to ${LIMITS.privateRepos} projects.`);
      const out = {};
      for (const [repo, prefixes] of Object.entries(value)) {
        if (!absolute(repo)) throw new Error('Private folders must be listed under a full project path.');
        if (!Array.isArray(prefixes) || prefixes.length > LIMITS.privatePrefixes) throw new Error(`Use up to ${LIMITS.privatePrefixes} private folders per project.`);
        // Keys are canonical (no trailing slash, symlinks resolved) on every path, so a hand-edited key still applies.
        // Sealed paths are never touched, not even to resolve them.
        const lexical = path.resolve(repo);
        const key = sealedPath(lexical) ? lexical : await fs.realpath(lexical).catch(() => lexical);
        const merged = [...new Set([...(out[key] || []), ...prefixes.map(privatePrefix)])];
        if (merged.length > LIMITS.privatePrefixes) throw new Error(`Use up to ${LIMITS.privatePrefixes} private folders per project.`);
        if (merged.length) out[key] = merged;
      }
      next.privatePaths = out;
    } else throw new Error(`Unknown setting: ${clean(key, 60)}`);
  }
  return next;
}

const mergePrivate = (...sources) => {
  const out = {};
  for (const source of sources) for (const [key, list] of Object.entries(isObject(source) ? source : {})) {
    const merged = [...new Set([...(out[key] || []), ...listOf(list)])].slice(0, LIMITS.privatePrefixes);
    if (merged.length) out[key] = merged;
  }
  return Object.fromEntries(Object.entries(out).slice(0, LIMITS.privateRepos));
};

/** Validates settings one key (and one private-folder project) at a time, keeping every valid value. */
async function salvageSettings(raw, issues) {
  let next = clone(DEFAULT_SETTINGS);
  if (!isObject(raw)) { issues.push('Settings must be an object.'); return next; }
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'privatePaths' && isObject(value)) {
      let kept = {};
      for (const [repo, prefixes] of Object.entries(value)) {
        try { kept = mergePrivate(kept, (await normalizeSettings({ privatePaths: { [repo]: prefixes } }, next, null)).privatePaths); }
        catch (error) { issues.push(`Private folders for ${clean(repo, 200)}: ${error.message}`); }
      }
      next.privatePaths = kept;
      continue;
    }
    try { next = await normalizeSettings({ [key]: value }, next, null); }
    catch (error) { issues.push(error.message); }
  }
  return next;
}

async function resolveDirectory(value) {
  let real;
  try { real = await fs.realpath(value); } catch { throw new Error(`Folder not found: ${clean(value, 200)}`); }
  if (!(await fs.stat(real)).isDirectory()) throw new Error(`Not a folder: ${clean(value, 200)}`);
  return real;
}

function validWorkstream(ws) {
  const strings = list => Array.isArray(list) && list.length <= 5000 && list.every(item => typeof item === 'string' && item.length <= 4096);
  return isObject(ws) && typeof ws.id === 'string' && ws.id.length <= 120 && typeof ws.title === 'string' && ws.title.length <= 400 && typeof ws.summary === 'string' && ws.summary.length <= 2000
    && typeof ws.area === 'string' && typeof ws.readiness === 'string' && strings(ws.files) && strings(ws.sharedFiles)
    && (ws.suggestedCommit === null || typeof ws.suggestedCommit === 'string');
}

async function validState(value, issues) {
  if (!isObject(value) || value.version !== VERSION) throw new Error('Unrecognized work in flight schema.');
  const settings = await salvageSettings(value.settings ?? {}, issues);
  const groupings = value.groupings ?? {};
  if (!isObject(groupings) || Object.keys(groupings).length > 5000) throw new Error('Invalid saved groupings.');
  for (const [place, entry] of Object.entries(groupings)) {
    const grouping = entry?.grouping;
    if (!absolute(place) || !isObject(entry) || typeof entry.fingerprint !== 'string' || entry.fingerprint.length > 200 || !isObject(grouping)
      || !['codex', 'claude'].includes(grouping.engine) || !(grouping.model === null || typeof grouping.model === 'string') || !validDate(grouping.groupedAt)
      || !Array.isArray(grouping.workstreams) || grouping.workstreams.length > LIMITS.workstreams || !grouping.workstreams.every(validWorkstream)
      || !(grouping.disclosure === undefined || isObject(grouping.disclosure))) throw new Error('Invalid saved grouping.');
  }
  const branchSummaries = value.branchSummaries ?? {};
  if (!isObject(branchSummaries) || Object.keys(branchSummaries).length > 20000) throw new Error('Invalid saved branch summaries.');
  for (const entry of Object.values(branchSummaries)) {
    if (!isObject(entry) || typeof entry.tip !== 'string' || entry.tip.length > 100 || typeof entry.summary !== 'string' || entry.summary.length > 1000 || !validDate(entry.at)) throw new Error('Invalid saved branch summary.');
  }
  return { version: VERSION, settings, groupings, branchSummaries };
}

function headlineFor({ status, error, things, ready, unshared, openBranches, stashes, missing, unreadable = 0, mainError = null, incomplete = false, reason = null }) {
  if (status === 'error') return error || 'Could not check this project.';
  // Why the project needs a look comes first; a folder that could not be read is never "all caught up".
  const prefix = reason && status === 'attention' ? `${reason}. ` : '';
  const problem = unreadable
    ? mainError ? `Main folder could not be checked. ${mainError}` : `${unreadable === 1 ? 'A folder' : `${unreadable} folders`} could not be checked.`
    : incomplete ? `Some details could not be checked.${error ? ` ${error}` : ''}` : '';
  if (things > 0) return `${prefix}${plural(things, 'thing')} in progress${ready ? `, ${ready} ${ready === 1 ? 'looks' : 'look'} ready to save` : ''}${problem ? `. ${problem}` : ''}`;
  const extra = [];
  if (unshared) extra.push(`${plural(unshared, 'commit')} not shared yet.`);
  if (openBranches) extra.push(`${plural(openBranches, 'open branch', 'open branches')}.`);
  if (stashes) extra.push(`${stashes} set aside.`);
  if (missing && !reason) extra.push(missing === 1 ? 'A worktree folder is gone.' : `${missing} worktree folders are gone.`);
  if (problem) return `${prefix}${[problem, ...extra].join(' ')}`;
  if (extra.length || prefix) return `${prefix}All saved.${extra.length ? ` ${extra.join(' ')}` : ''}`;
  return 'All caught up.';
}

/** Work in flight: read-only git status across workspaces plus user-requested workstream grouping. Never writes to repositories. */
export async function createWorkInFlight({ dataDir, getProjects = async () => [], run, git = '/usr/bin/git', env, scan = scanRepo, excerpts = diffExcerpts, untrackedHead = readUntrackedHead, same = sameChanges, group, onChange = () => {}, now = () => Date.now(), homeDir = os.homedir(), limits = {}, standing = createStanding, agentPlaces = async () => ({}) } = {}) {
  if (!absolute(dataDir)) throw new Error('Work in flight needs a full data folder path.');
  const limit = { ...LIMITS, ...limits };
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  dataDir = await fs.realpath(dataDir);
  const homes = [...new Set([homeDir, await fs.realpath(homeDir).catch(() => homeDir)].filter(absolute))];
  const filename = path.join(dataDir, 'work-in-flight.json');
  const gitEnv = env || { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: homes[0] || os.homedir(), ...GIT_ENV };
  // The standing log is the one git call this module makes itself, so it re-applies what gitRunner would:
  // every inherited GIT_* variable dropped, then GIT_ENV put back.
  const logEnv = { ...Object.fromEntries(Object.entries(gitEnv).filter(([key, value]) => typeof value === 'string' && !key.startsWith('GIT_'))), ...GIT_ENV };
  let state = { version: VERSION, settings: clone(DEFAULT_SETTINGS), groupings: {}, branchSummaries: {} };
  let fileSignature = null;
  let problems = [];
  let queue = Promise.resolve();
  let lastScan = null;
  let scanning = null;
  let finishing = null;
  // Each change of roots starts a new scan generation; a scan from an older generation is never used or stored.
  let generation = 0;
  const pendingScans = new Set();
  let settingsProblem = false;
  let unresolvedPrivate = [];
  let job = null;
  let running = null;
  let closing = false;
  const mirrorVerdicts = new Map();
  // Where work stands: its own small ledger file, because validState() here drops any key it does not whitelist.
  const ledger = typeof standing === 'function' ? await standing({ dataDir, now }).catch(error => { problems = [...problems, clean(`Could not open where work stands: ${error?.message}`, 400)]; return null; }) : null;
  const landedCache = new Map();
  const problem = message => { const text = clean(message, 600); if (text && !problems.includes(text)) problems = [...problems.slice(-(limit.errors - 1)), text]; };
  const resolveProblems = prefix => { problems = problems.filter(message => !message.startsWith(prefix)); };
  const enqueue = fn => { const result = queue.then(fn); queue = result.catch(() => {}); return result; };
  const notify = () => { try { const result = onChange(); if (result && typeof result.catch === 'function') result.catch(() => {}); } catch { /* A UI listener must not break scans or saved groupings. */ } };
  const displayPath = value => { const home = homes.find(root => inside(value, root)); return home ? `~${value.slice(home.length)}` : value; };
  const privateFor = repoPath => state.settings.privatePaths[repoPath] || [];
  const invalidateScan = () => { generation += 1; lastScan = null; };
  const rootsKey = settings => JSON.stringify([settings.extraRoots, settings.excludedRoots]);
  // A private-folder key that is not a folder on this Mac never applies; say so instead of failing silently.
  const checkPrivateKeys = async () => {
    const missing = [];
    for (const key of Object.keys(state.settings.privatePaths)) {
      if (sealedPath(key)) continue;
      const ok = await fs.stat(key).then(info => info.isDirectory(), () => false);
      if (!ok) missing.push(key);
    }
    unresolvedPrivate = missing;
  };
  const clearSettingsProblem = () => { settingsProblem = false; resolveProblems(SETTINGS_OFF); };

  async function readState() {
    let stat;
    try { stat = await fs.lstat(filename, { bigint: true }); } catch (error) {
      if (error.code === 'ENOENT') { fileSignature = null; return; }
      // The settings (and their private folders) are unknown, so nothing may be sent until the file is readable.
      state = { ...state, settings: { ...state.settings, engine: 'off' } };
      settingsProblem = true;
      problem(`${SETTINGS_OFF}. Fix the file, then choose Codex or Claude again. ${error.message}`);
      return;
    }
    if (signature(stat) === fileSignature) return;
    const before = state.settings;
    const issues = [];
    let parsed;
    let loaded = null;
    let failure = null;
    try {
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > BigInt(limit.stateBytes)) throw new Error('It must be a regular file under 2 MiB.');
      parsed = JSON.parse(await fs.readFile(filename, 'utf8'));
      loaded = await validState(parsed, issues);
      if (issues.length) failure = new Error(issues.slice(0, 4).join(' '));
    } catch (error) { failure = error; }
    if (!failure) {
      state = loaded;
      fileSignature = signature(stat);
      clearSettingsProblem();
    } else {
      // Fail closed: keep the file for recovery, keep every valid setting and every private folder already known,
      // turn grouping off, and save that at once so the next start does not fall back to sending defaults.
      const quarantine = `${filename}.corrupt-${Date.now()}-${randomUUID().slice(0, 6)}`;
      const kept = await fs.rename(filename, quarantine).then(() => true, () => false);
      const salvaged = loaded?.settings ?? await salvageSettings(isObject(parsed) ? parsed.settings ?? {} : undefined, []);
      state = {
        version: VERSION,
        settings: { ...salvaged, privatePaths: mergePrivate(before.privatePaths, salvaged.privatePaths), engine: 'off' },
        groupings: loaded?.groupings ?? state.groupings,
        branchSummaries: loaded?.branchSummaries ?? state.branchSummaries,
      };
      fileSignature = null;
      settingsProblem = true;
      problem(`${SETTINGS_OFF}${kept ? ` (kept as ${path.basename(quarantine)})` : ''}. Fix the file, then choose Codex or Claude again. ${failure.message}`);
      // Only a preserved file is replaced; otherwise the unreadable file stays and the next start fails closed again.
      if (kept) await save().catch(() => { /* The save problem is shown too; grouping stays off in memory. */ });
    }
    if (rootsKey(before) !== rootsKey(state.settings)) invalidateScan();
    await checkPrivateKeys();
  }

  function prune() {
    const newest = (entries, at, max) => Object.fromEntries(entries.sort((a, b) => String(at(b[1])).localeCompare(String(at(a[1])))).slice(0, max));
    state.groupings = newest(Object.entries(state.groupings), entry => entry.grouping.groupedAt, limit.groupings);
    state.branchSummaries = newest(Object.entries(state.branchSummaries), entry => entry.at, limit.branchSummaries);
  }
  function dropOldest() {
    const oldest = entries => entries.sort((a, b) => a[1].localeCompare(b[1]))[0]?.[0];
    const grouping = oldest(Object.entries(state.groupings).map(([key, entry]) => [key, entry.grouping.groupedAt]));
    if (grouping !== undefined) { delete state.groupings[grouping]; return true; }
    const summary = oldest(Object.entries(state.branchSummaries).map(([key, entry]) => [key, entry.at]));
    if (summary !== undefined) { delete state.branchSummaries[summary]; return true; }
    return false;
  }
  async function save() {
    prune();
    let contents = `${JSON.stringify(state, null, 2)}\n`;
    while (Buffer.byteLength(contents) > limit.stateBytes && dropOldest()) contents = `${JSON.stringify(state, null, 2)}\n`;
    const tmp = path.join(dataDir, `.work-in-flight-${randomUUID()}.tmp`);
    let handle;
    try {
      if (Buffer.byteLength(contents) > limit.stateBytes) throw new Error('Work in flight storage limit reached. Remove some private folder or root settings.');
      handle = await fs.open(tmp, 'wx', 0o600);
      await handle.writeFile(contents); await handle.sync(); await handle.close(); handle = null;
      await fs.rename(tmp, filename);
      const dir = await fs.open(dataDir, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
      fileSignature = signature(await fs.lstat(filename, { bigint: true }));
      resolveProblems('Could not save work in flight:');
    } catch (error) {
      problem(`Could not save work in flight: ${error.message}`);
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(tmp).catch(() => {});
      throw error;
    }
  }

  async function discover(errors) {
    let projects = [];
    try {
      projects = await getProjects();
      if (!Array.isArray(projects)) throw new Error('The workspace list is unavailable.');
    } catch (error) {
      errors.push(clean(`Could not list workspaces: ${error?.message}`, 300));
      projects = [];
    }
    const candidates = [
      ...projects.slice(0, 2000).filter(project => project && typeof project.path === 'string').map(project => ({ projectId: typeof project.id === 'string' && project.id ? project.id : null, name: typeof project.name === 'string' ? project.name : '', path: project.path })),
      ...state.settings.extraRoots.map(root => ({ projectId: null, name: path.basename(root), path: root })),
    ];
    const excluded = state.settings.excludedRoots;
    const found = new Map();
    for (const candidate of candidates) {
      // Hard guard: never stat, open or scan anything below a sealed folder.
      if (!absolute(candidate.path) || sealedPath(candidate.path) || excluded.some(root => inside(candidate.path, root))) continue;
      let real;
      try { real = await fs.realpath(candidate.path); } catch { continue; }
      if (sealedPath(real) || excluded.some(root => inside(real, root)) || found.has(real)) continue;
      try { if (!(await fs.lstat(path.join(real, '.git'))).isDirectory()) continue; } catch { continue; }
      found.set(real, { id: candidate.projectId || `repo-${hash(real).slice(0, 16)}`, projectId: candidate.projectId, name: clean(candidate.name, 120) || clean(path.basename(real), 120), path: real });
    }
    return [...found.values()];
  }

  async function scanOne(repo) {
    try {
      // Linked worktrees can live anywhere; the sealed-folder and skipped-folder guards apply to them before any read.
      const skipPath = place => sealedPath(place) || state.settings.excludedRoots.some(root => inside(place, root));
      const raw = await scan(repo.path, { run, git, env: gitEnv, now, skipPath });
      if (!isObject(raw)) throw new Error('The scan returned nothing.');
      return raw;
    } catch (error) {
      return { path: repo.path, places: [], branches: [], stashes: [], error: clean(`Could not check this project. ${error?.message || ''}`, 300) };
    }
  }

  function scanAll(maxAgeMs) {
    if (scanning && scanning.gen === generation) return scanning;
    const current = lastScan && lastScan.gen === generation ? lastScan : null;
    if (current && ((finishing && finishing.gen === generation) || now() - current.at < maxAgeMs)) return Promise.resolve(current);
    const gen = generation;
    const task = (async () => {
      const errors = [];
      const repos = await discover(errors);
      const entries = repos.map(repo => ({ repo, raw: null }));
      const all = pool(entries, limit.scanConcurrency, async entry => { entry.raw = await scanOne(entry.repo); });
      let timer;
      const late = await Promise.race([all.then(() => false), new Promise(resolve => { timer = setTimeout(resolve, limit.deadlineMs, true); })]);
      clearTimeout(timer);
      const at = now();
      const result = { at, scannedAt: iso(at), entries: late ? entries.map(entry => ({ ...entry })) : entries, partial: late, errors, gen };
      if (late) {
        // The user asked for this scan; finish it and push the complete view, but do not start another meanwhile.
        const rest = all.then(() => {
          if (lastScan === result && gen === generation) { const done = now(); lastScan = { at: done, scannedAt: iso(done), entries, partial: false, errors, gen }; }
        }).finally(() => { if (finishing === rest) finishing = null; pendingScans.delete(rest); notify(); });
        rest.gen = gen;
        finishing = rest;
        pendingScans.add(rest);
      }
      if (gen === generation) lastScan = result;
      return result;
    })();
    task.gen = gen;
    scanning = task;
    pendingScans.add(task);
    task.finally(() => { if (scanning === task) scanning = null; pendingScans.delete(task); }).catch(() => {});
    return task;
  }
  // A scan that started before the roots changed is never used: scan again for the current roots.
  async function currentScan(maxAgeMs) {
    let scanned = await scanAll(maxAgeMs);
    while (scanned.gen !== generation) scanned = await scanAll(maxAgeMs);
    return scanned;
  }
  async function completeScan() {
    for (;;) {
      const scanned = await scanAll(0);
      if (scanned.gen !== generation) continue;
      if (!scanned.partial) return scanned;
      const wait = finishing;
      if (!wait || wait.gen !== generation) return scanned;
      await wait;
      if (scanned.gen !== generation) continue;
      if (lastScan && lastScan.gen === generation && !lastScan.partial) return lastScan;
      if (lastScan === scanned || !finishing) return scanned;
    }
  }
  // Checked again right before a target is sent or stored: a folder skipped mid-job is never grouped.
  async function skippedNow(target) {
    const excluded = state.settings.excludedRoots;
    const { repo, place } = target;
    if (sealedPath(repo.path) || sealedPath(place.path) || excluded.some(root => inside(repo.path, root) || inside(place.path, root))) return true;
    const real = await fs.realpath(place.path).catch(() => place.path);
    return sealedPath(real) || excluded.some(root => inside(real, root));
  }

  const livePlaces = raw => listOf(raw?.places).filter(place => place && absolute(place.path) && !sealedPath(place.path));
  const unmergedBranches = raw => listOf(raw?.branches).filter(branch => branch && typeof branch.name === 'string' && branch.name !== raw.defaultBranch && count(branch.aheadOfBase) > 0)
    .sort((a, b) => String(b.lastCommitAt || '').localeCompare(String(a.lastCommitAt || '')));
  const fileKey = file => JSON.stringify([file.path, file.status, file.added ?? null, file.removed ?? null, file.fileCount ?? null]);

  async function mirrorsFor(raw) {
    const mirrors = new Map();
    const places = livePlaces(raw);
    const main = places.find(place => place.isMain);
    if (!main || main.missing || main.error || !placeFiles(main).length) return mirrors;
    const mainKeys = new Set(placeFiles(main).map(fileKey));
    for (const place of places) {
      const files = placeFiles(place);
      // A linked folder on the same commit whose every unsaved change is also in the main folder, byte for byte, is shown there instead.
      if (place === main || place.isMain || place.missing || place.error || place.filesTruncated || !files.length
        || place.head !== main.head || !files.every(file => mainKeys.has(fileKey(file)))) continue;
      const cacheable = typeof main.fingerprint === 'string' && typeof place.fingerprint === 'string';
      const cacheKey = `${main.path}\0${main.fingerprint}\0${place.path}\0${place.fingerprint}`;
      let verdict = cacheable ? mirrorVerdicts.get(cacheKey) : undefined;
      if (verdict === undefined) {
        const paths = files.map(file => file.isDir && !file.path.endsWith('/') ? `${file.path}/` : file.path);
        verdict = await Promise.resolve().then(() => same(main.path, place.path, paths, { run, git, env: gitEnv })).then(value => value === true, () => false);
        if (cacheable) { if (mirrorVerdicts.size >= limit.mirrorCache) mirrorVerdicts.clear(); mirrorVerdicts.set(cacheKey, verdict); }
      }
      if (verdict) mirrors.set(place.path, main.path);
    }
    return mirrors;
  }

  const OID = /^[0-9a-f]{7,64}$/;
  // A symmetric difference reports a watermark it cannot resolve in its own words, so that wording is listed too.
  const REWRITTEN_GIT = /invalid revision range|invalid symmetric difference|unknown revision|bad revision|ambiguous argument|not a valid object name|no such commit/i;
  const UNIT = '\u001f';
  // Which filter made a record. Bump it when redact() or hidePrivateText() change, so records already on disk are
  // remade under the new rules rather than replayed under the old ones.
  const FILTER_VERSION = 1;
  /**
   * What landed in one folder between the watermark and now: the commit subjects and how many there were.
   * One read-only `log` through gitArgs()/GIT_ENV, and only for a folder whose fingerprint and commit both moved,
   * so the ordinary scan never pays for it. Subjects are untrusted text and are filtered like a diff excerpt.
   */
  async function landedFor({ repoPath, repoName, placePath, from, to, stored = null }) {
    if (!absolute(placePath) || !OID.test(String(from)) || !OID.test(String(to)) || from === to) return null;
    if (sealedPath(placePath) || state.settings.excludedRoots.some(root => inside(placePath, root))) return null;
    const privatePaths = privateFor(repoPath);
    const homes = [repoName, path.basename(repoPath), path.basename(placePath)].filter(Boolean);
    // A record stamped with any other filter was made by rules that no longer apply, so it is never reused and
    // never kept: a private folder added since must take effect at once, wherever that text is already written.
    const filter = hash(JSON.stringify([FILTER_VERSION, privatePaths, homes])).slice(0, 12);
    if (stored && stored.filter === filter) return stored;
    const cacheKey = `${placePath}\0${from}\0${to}\0${filter}`;
    if (landedCache.has(cacheKey)) return landedCache.get(cacheKey);
    let result = null;
    try {
      // The symmetric difference with side marks, so the ordinary case still costs exactly one git process and a
      // watermark the new tip cannot reach shows up as a left-side record instead of passing as new work.
      const args = ['log', `--format=%m${UNIT}%H${UNIT}%s`, '-z', '--no-color', '--left-right', `-n${limit.landedScan}`, `${from}...${to}`];
      const { stdout } = await run(git, gitArgs(placePath, args), { cwd: placePath, env: logEnv, timeout: limit.landedTimeout, maxBytes: limit.landedBytes });
      const records = String(stdout ?? '').split('\0').filter(Boolean).map(record => {
        const parts = record.split(UNIT);
        return { mark: parts[0] ?? '', oid: parts[1] ?? '', subject: parts.slice(2).join(UNIT) };
      });
      // A watermark the new tip cannot reach (rebase, amend, reset, another branch) is history that moved under him.
      let diverged = records.some(record => record.mark === '<');
      if (!diverged && records.length >= limit.landedScan) {
        // A full page can hide the left side, so a capped read is only trusted once git confirms the watermark is still an ancestor.
        const ancestor = await run(git, gitArgs(placePath, ['merge-base', '--is-ancestor', from, to]), { cwd: placePath, env: logEnv, timeout: limit.landedTimeout, maxBytes: 4096 })
          .then(() => true, error => error?.exitCode === 1 ? false : null);
        if (ancestor === null) throw new Error('Could not confirm the watermark commit is still in this history.');
        diverged = !ancestor;
      }
      const rows = diverged ? [] : records.filter(record => record.mark === '>');
      const subjects = [];
      for (const row of rows.slice(0, limit.landedSubjects)) {
        const filtered = clean(hidePrivateText(clean(redact(clean(row.subject, limit.landedChars * 3)), limit.landedChars * 2), privatePaths, homes), limit.landedChars);
        // A subject that names a private folder is dropped whole, not masked: the count still says work landed.
        if (filtered && !filtered.includes('[private path]')) subjects.push(filtered);
      }
      const landedCount = Math.min(rows.length, limit.landedScan - 1);
      // Short hashes so one folder's list stays small on disk, and so a repository total can count a commit two
      // folders both reach exactly once.
      result = diverged
        ? { from, to, filter, count: 0, more: false, subjects: [], oids: [], rewritten: true }
        : { from, to, filter, count: landedCount, more: rows.length >= limit.landedScan, subjects, oids: rows.slice(0, landedCount).map(row => row.oid.slice(0, 12)).filter(Boolean), rewritten: false };
    } catch (error) {
      // A watermark commit that git no longer has means the history was rewritten here. Never guess a count.
      const text = `${error?.message ?? ''} ${error?.stderr ?? ''}`;
      result = REWRITTEN_GIT.test(text) ? { from, to, filter, count: 0, more: false, subjects: [], oids: [], rewritten: true } : null;
    }
    if (result) { if (landedCache.size >= limit.landedCache) landedCache.clear(); landedCache.set(cacheKey, result); }
    return result;
  }

  function targetsFor(repo, raw, mirrors, force) {
    if (!raw || sealedPath(repo.path)) return [];
    const places = livePlaces(raw);
    const targets = places
      .filter(place => !place.missing && !place.error && !mirrors.has(place.path) && typeof place.fingerprint === 'string' && itemCount(place) >= 2 && (force || state.groupings[place.path]?.fingerprint !== place.fingerprint))
      .sort((a, b) => Number(Boolean(b.isMain)) - Number(Boolean(a.isMain)))
      .map(place => ({ repo, raw, place, branches: [], branchOnly: false }));
    const branches = unmergedBranches(raw).filter(branch => typeof branch.tip === 'string' && (force || state.branchSummaries[summaryKey(repo.path, branch.name)]?.tip !== branch.tip)).slice(0, limit.branchesPerRequest);
    if (branches.length) {
      if (targets.length) targets[0].branches = branches;
      else {
        const home = places.find(place => place.isMain && !place.missing) || places.find(place => !place.missing);
        if (home) targets.push({ repo, raw, place: home, branches, branchOnly: true });
      }
    }
    return targets;
  }

  // maskPrivate (agent-facing reads): private and secret file names are left out of every list; counts stay whole.
  // collect (optional): the standing ledger's observation of each live folder, filled while the view is assembled.
  // agentPlace: how many agents are working in a folder right now, from the last agent-sessions read; never a new check.
  function assembleRepo(repo, raw, mirrors, includeFiles, partial, maskPrivate = false, collect = null, agentPlace = () => null) {
    const base = { id: repo.id, projectId: repo.projectId, name: repo.name, path: repo.path, displayPath: displayPath(repo.path) };
    if (!raw) return { ...base, status: 'error', headline: STILL_CHECKING, defaultBranch: null, hasRemote: false, lastFetchedAt: null, places: [], branches: [], stashes: [], error: partial ? STILL_CHECKING : 'Could not check this project.' };
    const privatePaths = privateFor(repo.path);
    const places = livePlaces(raw);
    const privacy = new Map();
    const scanned = new Map(places.flatMap(place => placeFiles(place).map(file => [file.path, file])));
    const isPrivate = file => {
      if (!privacy.has(file)) {
        let result = false;
        try { const entry = scanned.get(file); const cls = entry ? classifyFile(entry, { privatePaths }) : classifyPath(file, { privatePaths }); result = Boolean(cls?.private || cls?.secret || cls?.fromPrivate); } catch { /* Unknown means not marked. */ }
        privacy.set(file, result);
      }
      return privacy.get(file);
    };
    const defaultBranch = typeof raw.defaultBranch === 'string' ? clean(raw.defaultBranch, 200) : null;
    // Agent-facing reads also hide private paths quoted in commit subjects, stash messages and errors. Masking runs
    // before the final cut so a truncated path cannot escape it.
    const homes = [repo.name, path.basename(repo.path), ...places.map(place => path.basename(place.path))];
    const text = (value, max) => maskPrivate ? clean(hidePrivateText(clean(value, max * 2), privatePaths, homes), max) : clean(value, max);
    const day = fetchDay(raw.lastFetchedAt);
    const labels = new Map();
    // sink collects each workstream's unmasked file list for the standing ledger, so a masked read and a panel read
    // give a stream the same identity.
    const viewWorkstream = (ws, byPath, sink = null) => {
      const files = [...new Set(listOf(ws.files).filter(file => typeof file === 'string'))].sort();
      const sharedFiles = [...new Set(listOf(ws.sharedFiles).filter(file => typeof file === 'string' && !files.includes(file)))].sort();
      let added = 0, removed = 0;
      for (const file of files) { added += count(byPath.get(file)?.added); removed += count(byPath.get(file)?.removed); }
      const commit = typeof ws.suggestedCommit === 'string' ? clean(ws.suggestedCommit, 100) : '';
      const shownFiles = maskPrivate ? files.filter(file => !isPrivate(file)) : files;
      const view = { id: clean(ws.id, 120) || `ws-${hash(files.join('\n')).slice(0, 10)}`, title: clean(ws.title, 80) || 'Changes', summary: clean(ws.summary, 280), area: AREAS.includes(ws.area) ? ws.area : 'other', readiness: READINESS.includes(ws.readiness) ? ws.readiness : 'in-progress', files: shownFiles.map(file => clean(file, 1024)), sharedFiles: (maskPrivate ? sharedFiles.filter(file => !isPrivate(file)) : sharedFiles).map(file => clean(file, 1024)), added, removed, suggestedCommit: commit || null, private: files.some(isPrivate) };
      if (shownFiles.length < files.length) view.withheldFiles = files.length - shownFiles.length;
      if (sink) sink.push({ files, readiness: view.readiness });
      return view;
    };
    const groupingFor = (place, items, sink = null) => {
      const current = placeFiles(place);
      const byPath = new Map(current.map(file => [file.path, file]));
      // Only places the job can regroup (2 or more items) show a model grouping; see targetsFor.
      const cached = items >= 2 ? state.groupings[place.path] : undefined;
      if (cached) {
        const stale = cached.fingerprint !== place.fingerprint;
        const covered = new Set();
        const workstreams = [];
        // Saved work drops out and newer changes stay visible, even before the next grouping.
        for (const ws of cached.grouping.workstreams) {
          const files = ws.files.filter(file => byPath.has(file));
          if (!files.length) continue;
          for (const file of files) covered.add(file);
          workstreams.push(viewWorkstream({ ...ws, files, sharedFiles: ws.sharedFiles.filter(file => byPath.has(file)) }, byPath, sink));
        }
        const loose = current.map(file => file.path).filter(file => !covered.has(file));
        if (loose.length) workstreams.push(viewWorkstream({ id: `ws-new-${hash(loose.join('\n')).slice(0, 10)}`, title: 'Newer changes, not grouped yet', summary: 'These changed after the last grouping. Use Group changes to sort them.', area: 'other', readiness: 'in-progress', files: loose, sharedFiles: [], suggestedCommit: null }, byPath, sink));
        return { engine: cached.grouping.engine, model: cached.grouping.model === null ? null : clean(cached.grouping.model, 100) || null, groupedAt: cached.grouping.groupedAt, stale, note: stale ? NOTE_STALE : null, workstreams };
      }
      let workstreams = [];
      try { workstreams = listOf(fallbackGrouping(place, { privatePaths })).filter(isObject).map(ws => viewWorkstream(ws, byPath, sink)); } catch { /* Folder grouping is best effort. */ }
      return { engine: 'paths', model: null, groupedAt: null, stale: false, note: items < 2 ? null : state.settings.engine === 'off' ? NOTE_FOLDERS : NOTE_FALLBACK, workstreams };
    };
    const viewPlaces = places.map(place => {
      const streamSink = [];
      const kind = KINDS.includes(place.kind) ? place.kind : place.isMain ? 'main' : 'other';
      const folder = clean(path.basename(place.path), 80);
      const label = kind === 'main' ? 'Main folder' : kind === 'claude' ? `Claude worktree · ${folder}` : kind === 'codex' ? `Codex worktree · ${clean(path.basename(path.dirname(place.path)), 80)}` : kind === 'cursor' ? `Cursor worktree · ${folder}` : `Extra folder · ${folder}`;
      labels.set(place.path, label);
      const counts = { ...placeCounts(place), items: place.missing ? 0 : itemCount(place) };
      const ahead = numberOrNull(place.ahead), behind = numberOrNull(place.behind), aheadOfBase = numberOrNull(place.aheadOfBase), behindBase = numberOrNull(place.behindBase);
      const mirrorOf = mirrors.has(place.path) ? placeIdFor(mirrors.get(place.path)) : null;
      const error = place.error ? text(String(place.error), 300) : null;
      const words = [];
      if (error && !place.missing) words.push('could not be checked');
      if (counts.conflicted > 0) words.push('needs a decision on conflicting edits');
      if (counts.items > 0) words.push('not saved yet');
      if (ahead > 0) words.push(`${ahead} saved, not shared`);
      if (!place.upstream && aheadOfBase > 0 && kind !== 'main') words.push('only on this Mac');
      if (behind > 0) words.push(day ? `${behind} newer on GitHub (as of ${day})` : `${behind} newer on GitHub`);
      if (place.detached) words.push('not on a branch');
      if (mirrorOf) words.push('its unsaved changes are all in Main folder too');
      if (place.missing) words.push('folder is gone');
      if (!words.length) words.push('all saved');
      const view = {
        id: placeIdFor(place.path), kind, label, path: place.path, displayPath: displayPath(place.path), missing: Boolean(place.missing),
        branch: typeof place.branch === 'string' ? clean(place.branch, 200) : null, detached: Boolean(place.detached), head: typeof place.head === 'string' ? clean(place.head, 40) : null,
        upstream: typeof place.upstream === 'string' ? clean(place.upstream, 200) : null, ahead, behind, aheadOfBase, behindBase,
        stateWords: words, counts, added: count(place.added), removed: count(place.removed), lastChangedAt: validDate(place.lastChangedAt) ? place.lastChangedAt : null,
        mirrorOf, filesTruncated: Boolean(place.filesTruncated), grouping: mirrorOf || place.missing || !counts.items ? null : groupingFor(place, counts.items, streamSink), error,
      };
      // What the standing ledger records about this folder: counts and file-set hashes, never file names or text.
      if (collect && !mirrorOf && !place.missing && typeof place.fingerprint === 'string') {
        collect.push({
          placeId: view.id, label, path: place.path, fingerprint: place.fingerprint, oid: typeof place.oid === 'string' ? place.oid : null,
          items: counts.items, conflicted: counts.conflicted, added: view.added, removed: view.removed, aheadOfBase, behindBase,
          paths: placeFiles(place).length, working: count(agentPlace(view.id)?.working), lastCommitAt: null, streams: streamSink,
          // Readiness in streamSink is the grouping model's word about the files it was shown. Say when those are
          // no longer the files here, so nothing is claimed from a verdict about work that has since moved on.
          staleGrouping: Boolean(view.grouping?.stale),
        });
      }
      if (includeFiles) {
        const listed = placeFiles(place).filter(file => !maskPrivate || !isPrivate(file.path));
        if (listed.length < placeFiles(place).length) view.withheldFiles = placeFiles(place).length - listed.length;
        view.files = listed.map(file => ({
          path: clean(file.path, 1024), status: STATUSES.includes(file.status) ? file.status : 'modified', staged: Boolean(file.staged),
          added: numberOrNull(file.added), removed: numberOrNull(file.removed), binary: Boolean(file.binary), isDir: Boolean(file.isDir),
          fileCount: file.isDir ? numberOrNull(file.fileCount) : null, private: isPrivate(file.path),
        }));
      }
      return view;
    });
    const placeIds = new Map(places.map(place => [place.path, placeIdFor(place.path)]));
    const observed = collect ? new Map(collect.map(entry => [entry.placeId, entry])) : null;
    const placeByPath = new Map(viewPlaces.map(place => [place.path, place]));
    const branches = listOf(raw.branches).filter(branch => branch && typeof branch.name === 'string' && branch.name !== raw.defaultBranch).map(branch => {
      const where = typeof branch.worktreePath === 'string' && branch.worktreePath ? branch.worktreePath : null;
      const checkedOut = where ? placeByPath.get(where) : null;
      // A branch checked out anywhere is in use, unless Summon knows that folder is gone. This also covers
      // folders the scanner skipped, which are not in placeByPath.
      const inUse = Boolean(where) && !(checkedOut && checkedOut.missing);
      const unsaved = Boolean(checkedOut && !checkedOut.missing && checkedOut.counts.items > 0);
      const aheadOfBase = count(branch.aheadOfBase), merged = branch.aheadOfBase === 0 && !inUse, ahead = numberOrNull(branch.ahead);
      const upstream = typeof branch.upstream === 'string' && branch.upstream ? clean(branch.upstream, 200) : null;
      const placeId = typeof branch.worktreePath === 'string' && placeIds.has(branch.worktreePath) ? placeIds.get(branch.worktreePath) : null;
      const words = [];
      if (merged) words.push('done, safe to clean up');
      else if (branch.aheadOfBase === 0 && inUse) words.push(unsaved ? 'nothing saved on it yet, work in progress' : 'nothing new on it yet');
      if (aheadOfBase > 0) words.push(`${plural(aheadOfBase, 'commit')} not in ${defaultBranch || 'the main line'}`);
      if (branch.upstreamGone) words.push('GitHub copy was deleted');
      if (!upstream && aheadOfBase > 0) words.push('only on this Mac');
      if (ahead > 0) words.push(`${ahead} not shared`);
      if (placeId) words.push(`open in ${labels.get(branch.worktreePath)}`);
      const saved = state.branchSummaries[summaryKey(repo.path, branch.name)];
      return {
        name: clean(branch.name, 200), tip: clean(String(branch.tip ?? ''), 40), subject: text(branch.subject, 200), lastCommitAt: validDate(branch.lastCommitAt) ? branch.lastCommitAt : null,
        upstream, upstreamGone: Boolean(branch.upstreamGone), ahead, behind: numberOrNull(branch.behind), aheadOfBase, behindBase: count(branch.behindBase),
        placeId, merged, stateWords: words, summary: saved?.summary ? clean(saved.summary, 160) : null, summaryStale: Boolean(saved?.summary) && saved.tip !== branch.tip,
        topPaths: listOf(branch.topPaths).map(item => typeof item === 'string' ? item : item?.path).filter(item => typeof item === 'string' && item && !(maskPrivate && isPrivate(item))).map(item => clean(item, 1024)).filter(Boolean).slice(0, 12),
      };
    }).sort((a, b) => Number(a.merged) - Number(b.merged) || String(b.lastCommitAt || '').localeCompare(String(a.lastCommitAt || ''))).slice(0, limit.viewBranches);
    // The newest commit in a folder comes from the branch checked out there; a folder has no date of its own.
    if (observed) for (const branch of branches) { const entry = branch.placeId ? observed.get(branch.placeId) : null; if (entry && !entry.lastCommitAt) entry.lastCommitAt = branch.lastCommitAt; }
    const stashes = listOf(raw.stashes).filter(isObject).slice(0, limit.viewStashes).map((stash, index) => ({
      index: Number.isSafeInteger(stash.index) ? stash.index : index, message: text(stash.message, 200), branch: typeof stash.branch === 'string' && stash.branch ? clean(stash.branch, 200) : null,
      createdAt: validDate(stash.createdAt) ? stash.createdAt : null, files: count(stash.files),
    }));
    const unshared = listOf(raw.branches).filter(branch => branch && typeof branch.name === 'string').reduce((sum, branch) => sum + (branch.upstream && !branch.upstreamGone ? count(branch.ahead) : branch.name === raw.defaultBranch ? 0 : count(branch.aheadOfBase)), 0);
    const openBranches = branches.filter(branch => !branch.merged).length;
    const work = viewPlaces.filter(place => !place.mirrorOf && !place.missing);
    const workstreams = work.flatMap(place => place.grouping?.workstreams || []);
    const things = work.reduce((sum, place) => sum + (place.grouping?.workstreams.length || (place.counts.items > 0 ? 1 : 0)), 0);
    const ready = workstreams.filter(ws => ws.readiness === 'ready').length;
    const missing = viewPlaces.filter(place => place.missing).length;
    const error = raw.error ? text(String(raw.error), 300) : null;
    // A folder that could not be read, or details that could not be listed, never count as caught up. Such a repository
    // needs a look ('attention', not 'error'), so its other folders stay listed and groupable.
    const unreadable = viewPlaces.filter(place => place.error && !place.missing).length;
    const mainPlace = viewPlaces.find(place => place.kind === 'main');
    const mainError = mainPlace && mainPlace.error && !mainPlace.missing ? mainPlace.error : null;
    const incomplete = listOf(raw.warnings).some(item => typeof item === 'string' && item) || (Boolean(error) && viewPlaces.length > 0 && !unreadable);
    const conflicted = viewPlaces.some(place => place.counts.conflicted > 0);
    const diverged = viewPlaces.find(place => place.ahead > 0 && place.behind > 0);
    const gone = branches.some(branch => branch.upstreamGone && !branch.merged);
    const attention = unreadable > 0 || conflicted || missing > 0 || Boolean(diverged) || gone;
    const busy = viewPlaces.some(place => place.counts.items > 0 || place.ahead > 0) || openBranches > 0 || stashes.length > 0 || unshared > 0;
    const status = error && !viewPlaces.length ? 'error' : attention ? 'attention' : busy ? 'work' : incomplete ? 'attention' : 'clean';
    const reason = status !== 'attention' ? null
      : conflicted ? 'Conflicting edits need a decision'
      : missing ? (missing === 1 ? 'A worktree folder is gone' : `${missing} worktree folders are gone`)
      : diverged ? `${diverged.ahead} saved here and ${diverged.behind} newer on GitHub need combining`
      : gone ? 'A branch was deleted on GitHub'
      : null;
    return {
      ...base, status, headline: headlineFor({ status, error, things, ready, unshared, openBranches, stashes: stashes.length, missing, unreadable, mainError, incomplete, reason }), defaultBranch, hasRemote: Boolean(raw.hasRemote),
      lastFetchedAt: validDate(raw.lastFetchedAt) ? raw.lastFetchedAt : null, places: viewPlaces, branches, stashes, error,
      totals: { items: work.reduce((sum, place) => sum + place.counts.items, 0), unshared, openBranches },
    };
  }

  async function assemble(scanned, { projectId, includeFiles, maskPrivate }) {
    const errors = [...scanned.errors];
    let entries = scanned.entries;
    if (projectId !== null) {
      const wanted = projectId.toLocaleLowerCase();
      entries = entries.filter(entry => entry.repo.id === projectId || entry.repo.name.toLocaleLowerCase() === wanted);
      if (!entries.length) errors.push('No git project matches that id.');
    }
    const repos = [];
    const observations = [];
    let staleGroupings = 0;
    // Agents working right now, from the last agent-sessions read. One cheap lookup per view, never per folder.
    let working = {};
    if (ledger) { try { const found = await agentPlaces(); if (isObject(found)) working = found; } catch { /* Spinning is optional; the next read tries again. */ } }
    const agentPlace = placeId => (isObject(working[placeId]) ? working[placeId] : null);
    for (const entry of entries) {
      for (const item of listOf(entry.raw?.warnings)) if (typeof item === 'string' && item) errors.push(clean(`${entry.repo.name}: ${item}`, 300));
      const mirrors = entry.raw ? await mirrorsFor(entry.raw) : new Map();
      const collect = ledger && entry.raw ? [] : null;
      const repo = assembleRepo(entry.repo, entry.raw, mirrors, includeFiles, scanned.partial, maskPrivate, collect, agentPlace);
      if (collect) {
        observations.push({
          repoId: entry.repo.id, repoName: entry.repo.name, hasWork: repo.status === 'work' || repo.status === 'attention', repoPath: entry.repo.path,
          branchTips: Object.fromEntries(repo.branches.slice(0, 25).map(branch => [branch.name, branch.tip]).filter(([name, tip]) => name && tip)), places: collect,
        });
      }
      if (state.settings.engine !== 'off') staleGroupings += targetsFor(entry.repo, entry.raw, mirrors, false).length;
      repos.push(repo);
    }
    const rank = repo => repo.status === 'clean' ? 1 : 0;
    repos.sort((a, b) => rank(a) - rank(b));
    const totals = {
      reposWithWork: repos.filter(repo => repo.status === 'work' || repo.status === 'attention').length,
      unsavedItems: repos.reduce((sum, repo) => sum + (repo.totals?.items || 0), 0),
      unsharedCommits: repos.reduce((sum, repo) => sum + (repo.totals?.unshared || 0), 0),
      setAside: repos.reduce((sum, repo) => sum + repo.stashes.length, 0),
      openBranches: repos.reduce((sum, repo) => sum + (repo.totals?.openBranches || 0), 0),
      staleGroupings,
    };
    for (const repo of repos) delete repo.totals;
    // Where this stands. A filtered read never records a sample: the ledger must describe whole scans only.
    let standingView = null;
    if (ledger) {
      const byId = new Map(observations.map(observation => [observation.repoId, observation]));
      try {
        standingView = await ledger.sample(observations, {
          record: projectId === null,
          landedFor: ({ repoId, placeId, placePath, from, to, stored }) => landedFor({ repoPath: byId.get(repoId)?.repoPath ?? placePath, repoName: byId.get(repoId)?.repoName ?? '', placePath, from, to, stored }),
        });
      } catch (error) { errors.push(clean(`Could not work out what changed since you last looked. ${error?.message}`, 300)); }
    }
    const keyErrors = unresolvedPrivate.map(key => clean(`Private folders are listed under ${displayPath(key)}, which is not a folder on this Mac. Use the project's full path.`, 400));
    for (const item of listOf(standingView?.problems)) errors.push(clean(item, 400));
    if (standingView) delete standingView.problems;
    // An agent-facing read drops the per-project bullets: they have no size budget. The MCP adapter forwards no
    // standing at all today (scripts/mcp-server.mjs overview()), so this is the core's boundary, not the shape an agent sees.
    if (standingView && maskPrivate) standingView.byRepo = {};
    return { version: VERSION, scannedAt: scanned.scannedAt, repos, totals, standing: standingView, job: job ? clone(job) : null, settings: clone(state.settings), disclosure: disclosureFor(state.settings), privateDefaults: [...DEFAULT_PRIVATE_SEGMENTS], errors: [...new Set([...problems, ...keyErrors, ...errors])].slice(0, limit.errors) };
  }

  async function read({ maxAgeMs = 20000, projectId = null, includeFiles = true, maskPrivate = false } = {}) {
    if (typeof maxAgeMs !== 'number' || !(maxAgeMs >= 0)) throw new Error('maxAgeMs must be zero or more.');
    if (projectId !== null && (typeof projectId !== 'string' || !projectId || projectId.length > 200)) throw new Error('Project id must be a short text value.');
    if (typeof includeFiles !== 'boolean') throw new Error('includeFiles must be true or false.');
    if (typeof maskPrivate !== 'boolean') throw new Error('maskPrivate must be true or false.');
    await enqueue(readState);
    return assemble(await currentScan(maxAgeMs), { projectId, includeFiles, maskPrivate });
  }

  async function groupTarget(activeJob, target, settings) {
    const { repo, place, branches, branchOnly } = target;
    const privatePaths = privateFor(repo.path);
    const files = branchOnly ? [] : placeFiles(place);
    const requestPlace = { ...place, files };
    const eligible = file => { try { return excerptEligible(file, classifyFile(file, { privatePaths })) === true; } catch { return false; } };
    const tracked = files.filter(file => file.status !== 'untracked' && eligible(file)).slice(0, limit.excerptFiles).map(file => file.path);
    let excerptMap = new Map();
    if (tracked.length) {
      try { const found = await excerpts(place.path, tracked, { run, git, env: gitEnv, width: EXCERPT_SOURCE_WIDTH }); if (found instanceof Map) excerptMap = found; } catch { /* Names and counts are still useful without excerpts. */ }
    }
    const untrackedHeads = new Map();
    for (const file of files.filter(item => item.status === 'untracked' && !item.isDir && eligible(item)).slice(0, limit.untrackedHeads)) {
      try { const lines = await untrackedHead(place.path, file.path, { width: EXCERPT_SOURCE_WIDTH }); if (Array.isArray(lines) && lines.length) untrackedHeads.set(file.path, lines); } catch { /* Skip unreadable files. */ }
    }
    if (await skippedNow(target)) return;
    const request = buildGroupingRequest({ repoName: repo.name, place: requestPlace, branches, excerpts: excerptMap, untrackedHeads, privatePaths, defaultBranch: typeof target.raw.defaultBranch === 'string' ? target.raw.defaultBranch : null });
    const answer = await group(activeJob.engine, { prompt: request.prompt, schema: request.schema, effort: settings.effort, claudeModel: settings.claudeModel });
    if (!isObject(answer) || !isObject(answer.raw)) throw new Error('The model returned no grouping.');
    const result = validateGrouping(answer.raw, request, requestPlace);
    const at = iso(now());
    await enqueue(async () => {
      await readState();
      if (await skippedNow(target)) return;
      if (!branchOnly) {
        const previous = state.groupings[place.path]?.grouping?.workstreams || [];
        const workstreams = stabilize(listOf(result.workstreams), previous).slice(0, limit.workstreams);
        state.groupings[place.path] = { fingerprint: place.fingerprint, grouping: { engine: activeJob.engine, model: typeof answer.model === 'string' ? clean(answer.model, 100) || null : null, groupedAt: at, disclosure: isObject(request.disclosure) ? request.disclosure : {}, workstreams } };
      }
      const summaries = isObject(result.branchSummaries) ? result.branchSummaries : {};
      // Record every requested tip, even without a summary, so opening the panel does not re-ask for it.
      for (const branch of branches) state.branchSummaries[summaryKey(repo.path, branch.name)] = { tip: String(branch.tip), summary: clean(typeof summaries[branch.name] === 'string' ? summaries[branch.name] : '', 160), at };
      await save().catch(() => { /* Kept in memory; the save problem is shown in the view. */ });
    });
  }

  async function runJob(activeJob, { repoId, force }) {
    const settings = clone(state.settings);
    let failures = 0;
    try {
      await enqueue(async () => {
        await readState();
        // Pressing Group changes is the first consent; it is recorded before anything is sent.
        if (activeJob.reason === 'panel' && !state.settings.consentedAt) {
          state.settings = { ...state.settings, consentedAt: iso(now()) };
          await save().catch(() => { /* Kept in memory; the save problem is shown in the view. */ });
        }
      });
      activeJob.status = 'running';
      notify();
      const scanned = await completeScan();
      const entries = repoId === null ? scanned.entries : scanned.entries.filter(entry => entry.repo.id === repoId || entry.repo.name.toLocaleLowerCase() === repoId.toLocaleLowerCase());
      if (repoId !== null && !entries.length) throw new Error('No git project matches that id.');
      const targets = [];
      for (const entry of entries) {
        if (!entry.raw) { activeJob.errors.push(`${entry.repo.name} was not checked in time. Try again in a moment.`); continue; }
        targets.push(...targetsFor(entry.repo, entry.raw, await mirrorsFor(entry.raw), force));
      }
      activeJob.progress.total = targets.length;
      notify();
      await pool(targets, limit.jobConcurrency, async target => {
        if (closing) { failures += 1; activeJob.progress.done += 1; return; }
        if (await skippedNow(target)) { activeJob.progress.done += 1; notify(); return; }
        activeJob.current = target.repo.name;
        notify();
        try { await groupTarget(activeJob, target, settings); } catch (error) {
          failures += 1;
          const message = clean(error?.message || 'Unknown problem.', 300);
          activeJob.errors.push(clean(`${target.repo.name} was not grouped. ${message}`, 400));
        } finally {
          activeJob.progress.done += 1;
          notify();
        }
      });
      if (closing && targets.length) activeJob.errors.push('Grouping stopped because Summon is closing.');
      activeJob.status = targets.length && failures === targets.length ? 'failed' : 'done';
    } catch (error) {
      activeJob.errors.push(clean(error?.message || 'Grouping failed.', 400));
      activeJob.status = 'failed';
    } finally {
      activeJob.errors = [...new Set(activeJob.errors)].slice(0, limit.errors);
      activeJob.current = null;
      activeJob.finishedAt = iso(now());
      notify();
    }
  }

  function requestGrouping({ repoId = null, force = false, reason = 'panel' } = {}) {
    if (closing) throw new Error('Summon is closing. Try again after it restarts.');
    if (repoId !== null && (typeof repoId !== 'string' || !repoId || repoId.length > 200)) throw new Error('Project id must be a short text value.');
    if (typeof force !== 'boolean') throw new Error('force must be true or false.');
    if (!REASONS.includes(reason)) throw new Error('Unknown grouping reason.');
    if (job && (job.status === 'queued' || job.status === 'running')) return clone(job);
    if (state.settings.engine === 'off') throw new Error('Grouping is turned off. Choose Codex or Claude in Work in flight settings.');
    // Opening the panel and agents may send only after the person pressed Group changes once. The CLI is an explicit
    // request and prints the disclosure first, but does not count as that consent.
    if ((reason === 'open' || reason === 'agent') && !state.settings.consentedAt) throw new Error(NEEDS_CONSENT);
    if (reason === 'open' && settingsProblem) throw new Error(`${SETTINGS_OFF}. Choose Codex or Claude again first.`);
    if (typeof group !== 'function') throw new Error('Grouping is not available in this Summon version.');
    const activeJob = { id: `job-${randomUUID().slice(0, 8)}`, status: 'queued', reason, engine: state.settings.engine, startedAt: iso(now()), finishedAt: null, progress: { done: 0, total: 0 }, current: null, errors: [] };
    job = activeJob;
    running = runJob(activeJob, { repoId, force }).finally(() => { running = null; });
    return clone(activeJob);
  }

  async function updateSettings(patch) {
    if (closing) throw new Error('Summon is closing. No settings were changed.');
    if (isObject(patch) && Object.hasOwn(patch, 'consentedAt')) throw new Error('Consent is recorded when you press Group changes; it cannot be set here.');
    return enqueue(async () => {
      await readState();
      const before = state.settings;
      const next = await normalizeSettings(patch, before, resolveDirectory);
      state.settings = next;
      try { await save(); } catch (error) { state.settings = before; throw error; }
      if (rootsKey(before) !== rootsKey(next)) invalidateScan();
      if (Object.hasOwn(patch, 'engine')) clearSettingsProblem();
      await checkPrivateKeys();
      notify();
      return clone(next);
    });
  }

  function placePath(placeId) {
    if (typeof placeId !== 'string' || !/^place-[0-9a-f]{16}$/.test(placeId)) throw new Error('That folder is no longer in the scan.');
    for (const entry of lastScan?.entries || []) {
      const place = livePlaces(entry.raw).find(item => placeIdFor(item.path) === placeId);
      if (place) {
        if (place.missing) throw new Error('That folder no longer exists.');
        return place.path;
      }
    }
    throw new Error('That folder is no longer in the scan.');
  }

  // The biggest workstream a grouping already wrote for this folder, in the words it wrote, counting only files that are still changed.
  function placeWorkstream(place) {
    const saved = state.groupings[place.path]?.grouping;
    if (!saved) return null;
    const present = new Set(placeFiles(place).map(file => file.path));
    let best = null;
    for (const ws of listOf(saved.workstreams)) {
      const files = listOf(ws.files).filter(file => present.has(file)).length;
      if (!files || (best && files <= best.files)) continue;
      best = { files, title: clean(ws.title, 80), readiness: READINESS.includes(ws.readiness) ? ws.readiness : 'in-progress' };
    }
    return best?.title ? best : null;
  }

  // Folders from the last scan, with the same ids and labels the view shows, for matching other paths to them. Never scans.
  // Counts, area and workstream travel with each folder so a caller can describe the work without scanning again.
  function places() {
    const out = [];
    for (const entry of lastScan?.entries || []) {
      for (const place of livePlaces(entry.raw)) {
        const kind = KINDS.includes(place.kind) ? place.kind : place.isMain ? 'main' : 'other';
        const folder = clean(path.basename(place.path), 80);
        const label = kind === 'main' ? 'Main folder' : kind === 'claude' ? `Claude worktree · ${folder}` : kind === 'codex' ? `Codex worktree · ${clean(path.basename(path.dirname(place.path)), 80)}` : kind === 'cursor' ? `Cursor worktree · ${folder}` : `Extra folder · ${folder}`;
        const missing = Boolean(place.missing);
        const stream = missing ? null : placeWorkstream(place);
        out.push({
          id: placeIdFor(place.path), repoId: entry.repo.id, repoName: entry.repo.name, path: place.path, kind, label, missing,
          added: missing ? 0 : count(place.added), removed: missing ? 0 : count(place.removed), files: missing ? 0 : itemCount(place),
          area: missing ? null : areaOf(placeFiles(place)), workstream: stream?.title ?? null, readiness: stream?.readiness ?? null,
          // Every piece of work this folder has been grouped into, with the folder-relative files each one covers, so a
          // session in the main folder can be matched to one of them. Not grouped yet is an empty list, which a caller
          // must read as "nothing to match against", never as "no work here".
          workstreams: missing ? [] : listOf(state.groupings[place.path]?.grouping?.workstreams).map(ws => ({
            id: clean(ws?.id, 120) || null, title: clean(ws?.title, 80), files: listOf(ws?.files).filter(file => typeof file === 'string' && file).map(file => clean(file, 1024)),
            readiness: READINESS.includes(ws?.readiness) ? ws.readiness : 'in-progress',
          })).filter(ws => ws.title),
        });
      }
    }
    return out;
  }

  /**
   * Moves a project's "since you last looked" watermark to what the last scan saw.
   * Only an expanded, visible project section or an explicit Mark as read may call this, never opening the panel.
   */
  async function markStanding(request = null) {
    if (!ledger) throw new Error('Where work stands is not available right now.');
    if (closing) throw new Error('Summon is closing. Try again after it restarts.');
    // The panel sends a project id, or null for everything it has shown as read; tests and the core send an object.
    const marked = await ledger.mark(isObject(request) ? { repoId: request.repoId ?? null, placeId: request.placeId ?? null } : request ?? null);
    notify();
    return marked;
  }

  async function forgetStanding(repoId) {
    if (!ledger) return false;
    return ledger.forget(repoId);
  }

  async function close() {
    closing = true;
    await Promise.allSettled([running, ...pendingScans].filter(Boolean));
    await queue;
    if (ledger) await ledger.close().catch(() => { /* Closing must not fail on the ledger. */ });
  }

  await enqueue(readState);
  return { read, group: requestGrouping, settings: () => clone(state.settings), updateSettings, placePath, places, markStanding, forgetStanding, close };
}
