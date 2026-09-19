#!/usr/bin/env node
// `npm run flight`: Work in flight in the terminal. Talks only to the running Summon app over its private
// socket; this script never opens or changes a repository. Repository and model text is printed as plain text.
import net from 'node:net';
import { lstatSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const RPC_TIMEOUT_MS = 18000;
export const POLL_MS = 3000;
export const POLL_LIMIT_MS = 6 * 60 * 1000;
export const NOT_RUNNING = 'Open Summon first (⌘⇧J), then run this again.';
const OLD_APP = 'This Summon app does not include Work in flight yet. Rebuild and reopen Summon, then run this again.';
const USAGE = `Usage: npm run flight -- [options]

Shows unfinished work across your git projects, as Summon sees it. Read-only.

  --project <name or id>  Only this project (name match ignores case)
  --group                 Ask Summon to sort unsaved changes into plain-language workstreams, then wait for it
  --force                 With --group: regroup even when nothing changed since the last grouping
  --files                 List the files under each workstream
  --all                   Show every project, folder and finished branch in full
  --json                  Print the raw view as JSON (run as: npm run -s flight -- --json, so npm's header stays out)
  -h, --help              Show this help`;

export const socketPath = (env = process.env) => env.SUMMON_SOCKET || `/tmp/summon-${process.getuid?.() ?? 'local'}.sock`;

/**
 * One request per connection, newline-delimited JSON, matching src/main/rpc.mjs. Same client rules as
 * scripts/mcp-server.mjs rpc(): only a socket this user owns, an idle limit plus an overall deadline that
 * incoming bytes do not reset (a little longer than the idle limit, since Summon sends nothing until its answer is ready).
 */
export function rpc(request, { path = socketPath(), timeoutMs = RPC_TIMEOUT_MS, maxBytes = 32_000_000, deadlineMs = timeoutMs + Math.min(5000, timeoutMs) } = {}) {
  return new Promise((resolve, reject) => {
    const notRunning = () => Object.assign(new Error(NOT_RUNNING), { code: 'NOT_RUNNING' });
    try {
      // The socket lives in shared /tmp: a path another user created is not Summon.
      const info = lstatSync(path);
      if (!info.isSocket() || (process.getuid && info.uid !== process.getuid())) throw new Error('foreign');
    } catch { reject(notRunning()); return; }
    const socket = net.connect(path); const chunks = []; let size = 0; let settled = false;
    const fail = error => { if (settled) return; settled = true; clearTimeout(deadline); socket.destroy(); reject(error); };
    const deadline = setTimeout(() => fail(new Error('Summon did not answer in time. Try again in a moment.')), deadlineMs);
    socket.setTimeout(timeoutMs, () => fail(new Error('Summon did not answer in time. Try again in a moment.')));
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', chunk => { size += chunk.length; if (size > maxBytes) fail(new Error('Summon sent more than this view can show. Try --project.')); else chunks.push(chunk); });
    socket.on('error', error => fail(['ENOENT', 'ECONNREFUSED', 'ENOTSOCK', 'EACCES', 'EPERM'].includes(error.code) ? notRunning() : error));
    socket.on('close', () => { if (!settled) fail(new Error('Summon closed the connection.')); });
    socket.on('end', () => {
      if (settled) return; settled = true; clearTimeout(deadline);
      let data;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reject(new Error('Summon sent an answer this script cannot read.')); return; }
      if (data?.error) reject(Object.assign(new Error(data.error === 'Unsupported operation.' ? OLD_APP : String(data.error)), { code: 'SUMMON_ERROR' }));
      else resolve(data?.result);
    });
  });
}

// Control characters, bidi overrides and zero-width marks could rewrite the terminal; they never reach it.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;
export function clean(value, max = 300) {
  const text = String(value ?? '').replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : text;
}

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const number = value => (Number.isFinite(value) ? value : 0);
const READINESS = { ready: 'looks ready to save', 'in-progress': 'still in progress', scratch: 'scratch, probably keep local', generated: 'made by a script' };
const FILE_WORDS = { modified: 'changed', added: 'new', untracked: 'new', deleted: 'deleted', renamed: 'renamed', typechange: 'changed type', conflicted: 'conflict' };
const ENGINE_NAMES = { codex: 'Codex', claude: 'Claude' };
const STYLE = { bold: ['\x1b[1m', '\x1b[22m'], dim: ['\x1b[2m', '\x1b[22m'] };

function when(iso, { now, timeZone }) {
  const date = new Date(iso ?? NaN);
  if (Number.isNaN(date.getTime())) return '';
  const day = value => new Date(value).toLocaleDateString('en-US', { timeZone, year: 'numeric', month: 'short', day: 'numeric' });
  if (day(date) === day(now)) return `today ${date.toLocaleTimeString('en-US', { timeZone, hour: 'numeric', minute: '2-digit' })}`;
  if (day(date) === day(now - 86400000)) return 'yesterday';
  const days = Math.floor((now - date.getTime()) / 86400000);
  if (days > 1 && days < 7) return `${days} days ago`;
  const year = value => new Date(value).toLocaleDateString('en-US', { timeZone, year: 'numeric' });
  return date.toLocaleDateString('en-US', { timeZone, month: 'short', day: 'numeric', ...(year(date) !== year(now) ? { year: 'numeric' } : {}) });
}

// A line is a list of [text, style] parts; paint() cuts it to the width (with …) before adding any styling.
function paint(parts, { width, color }) {
  const total = parts.reduce((sum, [text]) => sum + Array.from(text).length, 0);
  let room = Number.isFinite(width) && width > 0 && total > width ? width - 1 : Infinity;
  let out = '';
  for (const [text, style] of parts) {
    if (room <= 0) break;
    const chars = Array.from(text); const piece = chars.slice(0, room).join(''); room -= chars.length;
    out += color && style && STYLE[style] && piece ? `${STYLE[style][0]}${piece}${STYLE[style][1]}` : piece;
  }
  if (room !== Infinity && room <= 0) out = `${out.replace(/ +$/, '')}…`;
  return out;
}

function drawTree(nodes, prefix, lines) {
  nodes.forEach((node, index) => {
    const last = index === nodes.length - 1;
    lines.push([[`${prefix}${last ? '└─ ' : '├─ '}`, 'dim'], ...node.parts]);
    const inner = prefix + (last ? '   ' : '│  ');
    const children = node.children || [];
    for (const detail of node.details || []) lines.push([[inner + (children.length ? '│  ' : ''), 'dim'], ...detail]);
    drawTree(children, inner, lines);
  });
}

function workstreamNode(stream, place, { files, engine }) {
  const byPath = new Map((place.files || []).map(file => [file.path, file]));
  const size = path => { const file = byPath.get(path); return file?.isDir && Number.isSafeInteger(file.fileCount) && file.fileCount > 0 ? file.fileCount : 1; };
  const count = (stream.files || []).reduce((sum, path) => sum + size(path), 0) + (Number.isSafeInteger(stream.withheldFiles) ? stream.withheldFiles : 0);
  const meta = stream.private ? ['private', plural(count, 'file')] : [READINESS[stream.readiness] || 'still in progress', plural(count, 'file')];
  if (!stream.private && (stream.added || stream.removed)) meta.push(`+${number(stream.added)} −${number(stream.removed)}`);
  const node = { parts: [[clean(stream.title, 90) || 'Untitled changes'], [`  (${meta.join(' · ')})`, 'dim']], details: [], children: [] };
  if (stream.summary) node.details.push([[clean(stream.summary, 280)]]);
  if (!files) return node;
  if (stream.suggestedCommit) node.details.push([[`Commit message ${engine ? `suggested by ${engine}` : 'idea'}: `, 'dim'], [clean(stream.suggestedCommit, 100)]]);
  const listed = [...(stream.files || []).map(path => [path, false]), ...(stream.sharedFiles || []).map(path => [path, true])];
  for (const [path, shared] of listed.slice(0, 40)) {
    const file = byPath.get(path);
    const words = [file?.isDir ? 'new folder' : FILE_WORDS[file?.status] || 'changed'];
    if (shared) words.push('shared');
    const tail = [];
    if (file?.isDir && file.fileCount) tail.push(plural(file.fileCount, 'file'));
    if (file?.binary) tail.push('binary');
    else if (file && (file.added || file.removed)) tail.push(`+${number(file.added)} −${number(file.removed)}`);
    node.children.push({ parts: [[`${words.join(', ')}  `, 'dim'], [clean(path, 240)], [tail.length ? `  ${tail.join(' · ')}` : '', 'dim']] });
  }
  if (listed.length > 40) node.children.push({ parts: [[`${listed.length - 40} more files`, 'dim']] });
  return node;
}

const MIRROR_WORD = /^(?:its unsaved changes are all in|same unsaved changes as)/i;

function placeNode(place, repo, options) {
  const mirror = place.mirrorOf ? clean((repo.places || []).find(item => item.id === place.mirrorOf)?.label, 120) || 'Main folder' : null;
  const words = [...(place.stateWords || [])].filter(word => !(mirror && MIRROR_WORD.test(word))).map(word => clean(word, 120));
  if (place.aheadOfBase > 0 && repo.defaultBranch && place.branch !== repo.defaultBranch && !words.some(word => word.includes(' not in ')))
    words.push(`${plural(place.aheadOfBase, 'commit')} not in ${clean(repo.defaultBranch, 80)}`);
  const label = clean(place.label, 120) || 'Folder';
  const branch = place.branch ? clean(place.branch, 120) : '';
  // The state is the answer, so it comes before the branch; paint() cuts from the end.
  const parts = [[label, 'bold']];
  if (words.length) parts.push([` · ${words.join(' · ')}`]);
  if (branch && !label.endsWith(` · ${branch}`)) parts.push([` · on ${branch}`, 'dim']);
  const node = { parts, details: [], children: [] };
  if (mirror) node.details.push([[`Its unsaved changes are all in ${mirror} too, so they are listed there.`, 'dim']]);
  if (place.error) node.details.push([['Could not read this folder: ', 'dim'], [clean(place.error, 240)]]);
  if (place.mirrorOf || place.missing) return node;
  const grouping = place.grouping;
  const engine = ENGINE_NAMES[grouping?.engine] || null;
  if (grouping?.workstreams?.length) {
    if (engine) node.details.push([[`Workstreams suggested by ${engine}${grouping.groupedAt ? ` ${when(grouping.groupedAt, options)}` : ''}${grouping.stale ? ` · ${clean(grouping.note, 120) || 'Changed since it was grouped.'}` : ''}`, 'dim']]);
    else node.details.push([['Grouped by folder on this Mac', 'dim']]);
    node.children = grouping.workstreams.map(stream => workstreamNode(stream, place, { ...options, engine }));
  } else if (place.counts?.items > 0) node.details.push([[`${plural(place.counts.items, 'unsaved change')}`, 'dim']]);
  return node;
}

function branchText(branch, options) {
  const parts = [[clean(branch.name, 120), 'bold']];
  if (branch.stateWords?.length) parts.push([` (${branch.stateWords.map(word => clean(word, 120)).join(', ')})`]);
  if (branch.summary) parts.push([` ${clean(branch.summary, 200)}`], [branch.summaryStale ? ' (summary may be out of date)' : '', 'dim']);
  else if (branch.subject) parts.push([' last saved: ', 'dim'], [`"${clean(branch.subject, 160)}"`]);
  const age = when(branch.lastCommitAt, options);
  if (age) parts.push([` · ${age}`, 'dim']);
  return parts;
}

function repoChildren(repo, options) {
  const nodes = [];
  const places = repo.places || [];
  const quiet = place => place.kind !== 'main' && !place.error && !place.missing && !(place.counts?.items > 0) && !(place.ahead > 0) && !(place.aheadOfBase > 0);
  const shown = options.all ? places : places.filter(place => !quiet(place));
  for (const place of shown) nodes.push(placeNode(place, repo, options));
  const hidden = places.length - shown.length;
  if (hidden) nodes.push({ parts: [[`${plural(hidden, 'more worktree')}, all saved`, 'dim']] });
  const branches = repo.branches || [];
  const open = branches.filter(branch => !branch.merged);
  const merged = branches.filter(branch => branch.merged);
  if (open.length === 1 && !merged.length) nodes.push({ parts: [['Branches: ', 'dim'], ...branchText(open[0], options)] });
  else if (branches.length) {
    const children = open.map(branch => ({ parts: branchText(branch, options) }));
    if (options.all) children.push(...merged.map(branch => ({ parts: branchText(branch, options) })));
    else if (merged.length) {
      const names = merged.slice(0, 6).map(branch => clean(branch.name, 60)).join(', ');
      children.push({ parts: [[`${merged.length} done, safe to clean up: ${names}${merged.length > 6 ? `, and ${merged.length - 6} more` : ''}`, 'dim']] });
    }
    nodes.push({ parts: [['Branches', 'bold'], [open.length ? ` · ${plural(open.length, 'not merged yet', 'not merged yet')}` : '', 'dim']], children });
  }
  const stashes = repo.stashes || [];
  const from = stash => (stash.branch ? ` from ${clean(stash.branch, 80)}` : '');
  if (stashes.length === 1) nodes.push({ parts: [['Set aside: ', 'dim'], [`1 stash${from(stashes[0])} (${plural(number(stashes[0].files), 'file')})`]] });
  else if (stashes.length) {
    nodes.push({
      parts: [['Set aside: ', 'dim'], [plural(stashes.length, 'stash', 'stashes')]],
      children: stashes.map(stash => ({ parts: [[`${plural(number(stash.files), 'file')}${from(stash)}`], [when(stash.createdAt, options) ? ` · ${when(stash.createdAt, options)}` : '', 'dim'], [stash.message ? ` · ${clean(stash.message, 160)}` : '', 'dim']] })),
    });
  }
  return nodes;
}

/** Pure renderer: WorkInFlight view → terminal text. `color` adds bold/dim only; `width` truncates each line with …. */
export function renderTree(view, { width = Infinity, color = false, files = false, all = false, now = Date.now(), timeZone, grouping = false } = {}) {
  const options = { files, all, now, timeZone };
  const lines = [];
  const totals = view?.totals || {};
  const repos = view?.repos || [];
  const header = [['Work in flight', 'bold']];
  const withWork = number(totals.reposWithWork);
  const unchecked = repos.filter(repo => repo.status === 'error').length;
  header.push([withWork ? ` · ${plural(withWork, 'project has', 'projects have')} unfinished work` : unchecked ? ` · Could not finish checking ${plural(unchecked, 'project')}` : ' · All caught up']);
  if (withWork && unchecked) header.push([` · ${plural(unchecked, 'project')} not checked`]);
  if (totals.staleGroupings > 0) header.push([` · ${plural(totals.staleGroupings, 'grouping')} out of date`, 'dim']);
  lines.push(header);
  if (!repos.length) lines.push([['No git projects found. Add a workspace folder in Summon.']]);
  const caughtUp = [];
  for (const repo of repos) {
    if (repo.status === 'clean' && !all) { caughtUp.push(clean(repo.name, 60)); continue; }
    lines.push([]);
    lines.push([[clean(repo.name, 80), 'bold'], [`  ${clean(repo.displayPath, 160)}`, 'dim'], [`  ${clean(repo.headline || repo.error, 200)}`]]);
    drawTree(repoChildren(repo, options), '', lines);
  }
  if (caughtUp.length) { lines.push([]); lines.push([['All caught up: ', 'dim'], [caughtUp.join(', ')]]); }
  const job = view?.job;
  if (!grouping && job && (job.status === 'queued' || job.status === 'running')) { lines.push([]); lines.push([[progressText(job), 'dim']]); }
  for (const error of view?.errors || []) lines.push([['Problem: ', 'bold'], [clean(error, 300)]]);
  const engine = ENGINE_NAMES[view?.settings?.engine];
  const needsGrouping = repos.some(repo => (repo.places || []).some(place => !place.mirrorOf && !place.missing && (place.counts?.items || 0) >= 2 && place.grouping && (place.grouping.engine === 'paths' || place.grouping.stale)));
  if (!grouping && engine && needsGrouping) { lines.push([]); lines.push([[`Tip: add --group to have ${engine} sort unsaved changes into plain-language workstreams.`, 'dim']]); }
  return lines.map(parts => paint(parts, { width, color })).join('\n');
}

export function progressText(job) {
  const total = number(job?.progress?.total); const done = number(job?.progress?.done);
  if (job?.status === 'queued' || (!total && job?.status === 'running')) return 'Getting ready to group…';
  if (job?.status === 'running') return `Grouping ${job.current ? `${clean(job.current, 60)} ` : ''}(${Math.min(done + 1, total)} of ${total})…`;
  if (job?.status === 'failed') return 'Grouping did not work.';
  return total ? `Grouping finished (${done} of ${total}).` : 'Nothing new to group.';
}

export function findRepo(repos, query) {
  const wanted = String(query).trim().toLowerCase();
  if (!wanted) return null;
  const exact = repos.find(repo => repo.id === query || repo.projectId === query) || repos.find(repo => String(repo.name).toLowerCase() === wanted);
  if (exact) return exact;
  const partial = repos.filter(repo => String(repo.name).toLowerCase().includes(wanted));
  return partial.length === 1 ? partial[0] : null;
}

/** CLI entry with injectable I/O for tests. Resolves to the exit code. */
export async function runCli(argv = process.argv.slice(2), { call = rpc, stdout = process.stdout, stderr = process.stderr, env = process.env, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => Date.now() } = {}) {
  let flags;
  try {
    flags = parseArgs({ args: argv, allowPositionals: false, options: { project: { type: 'string' }, group: { type: 'boolean' }, force: { type: 'boolean' }, files: { type: 'boolean' }, json: { type: 'boolean' }, all: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } }).values;
  } catch (error) { stderr.write(`${clean(error.message)}\n\n${USAGE}\n`); return 2; }
  if (flags.help) { stdout.write(`${USAGE}\n`); return 0; }
  if (flags.force && !flags.group) { stderr.write('--force only works together with --group.\n'); return 2; }
  // npm prints its own header lines to stdout before the script runs; -s (silent) leaves them out.
  if (flags.json && env.npm_lifecycle_event && env.npm_config_loglevel !== 'silent') stderr.write('Note: npm printed its header above the JSON. For clean JSON use npm run -s flight -- --json.\n');
  const tty = Boolean(stdout.isTTY);
  const say = text => (flags.json ? stderr : stdout).write(`${text}\n`);
  // This terminal is local, so it asks for private file names; the MCP tool never does. File lists are always
  // fetched so a new folder counts as the files inside it; --files decides whether they are printed.
  const read = projectId => call({ method: 'work-in-flight', projectId, includeFiles: true, privateNames: true });
  try {
    let projectId = null; let overview = null; let groupFailed = false;
    if (flags.project !== undefined) {
      overview = await call({ method: 'work-in-flight', projectId: null, includeFiles: false, privateNames: true });
      const repo = findRepo(overview?.repos || [], flags.project);
      if (!repo) {
        const names = (overview?.repos || []).map(item => clean(item.name, 60)).join(', ');
        stderr.write(`No project matches "${clean(flags.project, 80)}".${names ? ` Projects: ${names}.` : ''}\n`);
        return 1;
      }
      projectId = repo.id;
    }
    if (flags.group) {
      const before = overview || await call({ method: 'work-in-flight', projectId, includeFiles: false, privateNames: true });
      if (before?.disclosure) say(clean(before.disclosure, 600));
      const started = (await call({ method: 'work-in-flight-group', projectId, force: Boolean(flags.force), reason: 'cli' }))?.job;
      let job = started; let last = '';
      const deadline = now() + POLL_LIMIT_MS;
      while (job && (job.status === 'queued' || job.status === 'running')) {
        const text = progressText(job);
        if (text !== last) { say(text); last = text; }
        if (now() >= deadline) { say('Still grouping after 6 minutes. Summon keeps working; run npm run flight again later.'); break; }
        await sleep(POLL_MS);
        try {
          const view = await call({ method: 'work-in-flight', projectId, includeFiles: false, privateNames: true });
          job = view?.job && view.job.id === started.id ? view.job : { ...job, status: 'done' };
        } catch (error) { if (error.code === 'NOT_RUNNING') throw error; }
      }
      if (job && job.status !== 'queued' && job.status !== 'running') {
        say(progressText(job)); groupFailed = job.status === 'failed';
        for (const problem of job.errors || []) say(`  ${clean(problem, 300)}`);
      }
    }
    const view = await read(projectId);
    if (flags.json) { stdout.write(`${JSON.stringify(view, null, 2)}\n`); return 0; }
    const color = tty && !env.NO_COLOR;
    const width = tty ? stdout.columns || 100 : Infinity;
    stdout.write(`${renderTree(view, { width, color, files: Boolean(flags.files), all: Boolean(flags.all), now: now(), grouping: Boolean(flags.group) })}\n`);
    return groupFailed ? 1 : 0;
  } catch (error) {
    stderr.write(`${error.code === 'NOT_RUNNING' ? NOT_RUNNING : clean(error.message, 400)}\n`);
    return 1;
  }
}

const invokedDirectly = () => {
  if (typeof import.meta.main === 'boolean') return import.meta.main;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
};
if (invokedDirectly()) {
  process.stdout.on('error', error => { if (error.code === 'EPIPE') process.exit(0); throw error; });
  runCli().then(code => { process.exitCode = code; });
}
