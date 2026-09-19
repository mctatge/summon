#!/usr/bin/env node
// `npm run sessions`: Agent sessions in the terminal. By default it asks the running Summon app over its private
// socket and gets the same redacted view agents get. --direct reads session metadata here, without Summon.
// Read-only either way: it never opens, messages or changes a session and never reads conversation text.
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { lstatSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { clean, socketPath } from './work-in-flight.mjs';

export const RPC_TIMEOUT_MS = 8000;
export const NOT_RUNNING = 'Open Summon first (⌘⇧J), then run this again. Or add --direct to read sessions without Summon.';
export const DIRECT_NOTE = 'Read directly, without Summon, so folders are not matched to your Work in flight projects.';
const OLD_APP = 'This Summon app does not include Agent sessions yet. Rebuild and reopen Summon, or add --direct.';
export const APPS = Object.freeze(['claude', 'codex', 'cursor', 'hermes']);
const APP_NAMES = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor', hermes: 'Hermes' };
const USAGE = `Usage: npm run sessions -- [options]

Shows which AI agent sessions (Claude, Codex, Cursor, Hermes) need you, have a new reply or are still working. Read-only.

  --app <name>   Only sessions from claude, codex, cursor or hermes
  --recent       Also show sessions that were active recently but are not running now
  --direct       Read session files here, without Summon (folders are not matched to your projects)
  --json         Print the view as JSON (run as: npm run -s sessions -- --json, so npm's header stays out)
  -h, --help     Show this help`;

/**
 * One request per connection, newline-delimited JSON, matching src/main/rpc.mjs and the rules of
 * scripts/work-in-flight.mjs rpc(): only a socket this user owns, an idle limit plus an overall deadline.
 */
export function rpc(request, { path: file = socketPath(), timeoutMs = RPC_TIMEOUT_MS, maxBytes = 4_000_000, deadlineMs = timeoutMs + Math.min(5000, timeoutMs) } = {}) {
  return new Promise((resolve, reject) => {
    const notRunning = () => Object.assign(new Error(NOT_RUNNING), { code: 'NOT_RUNNING' });
    try {
      const info = lstatSync(file);
      if (!info.isSocket() || (process.getuid && info.uid !== process.getuid())) throw new Error('foreign');
    } catch { reject(notRunning()); return; }
    const socket = net.connect(file); const chunks = []; let size = 0; let settled = false;
    const fail = error => { if (settled) return; settled = true; clearTimeout(deadline); socket.destroy(); reject(error); };
    const deadline = setTimeout(() => fail(new Error('Summon did not answer in time. Try again in a moment.')), deadlineMs);
    socket.setTimeout(timeoutMs, () => fail(new Error('Summon did not answer in time. Try again in a moment.')));
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', chunk => { size += chunk.length; if (size > maxBytes) fail(new Error('Summon sent more than this view can show.')); else chunks.push(chunk); });
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

/**
 * Reads sessions in this process with the core module. Summon's data folder is never written: the saved
 * Agent sessions preferences (path aliases, recent hours) are copied into a private temp folder that is removed afterwards,
 * and its sealed.json is applied so the same folders stay out of the view.
 */
export async function readDirect({ homeDir = os.homedir(), env = process.env, tmpRoot = os.tmpdir(), importCore = () => import('../src/core/agent-sessions.mjs'), importRun = () => import('../src/main/process.mjs'), importGuard = () => import('../src/core/workstreams.mjs') } = {}) {
  const [{ createAgentSessions }, { run }, { loadSealedSegments }] = await Promise.all([importCore(), importRun(), importGuard()]);
  const summonData = env.SUMMON_DATA_DIR ? path.resolve(env.SUMMON_DATA_DIR) : path.join(homeDir, 'Library/Application Support/Summon');
  // The same sealed folders the app applies: <data folder>/sealed.json. Missing or malformed, nothing is sealed and the read still runs.
  loadSealedSegments(summonData);
  // Must not start with sqlite-snapshot.mjs's TEMP_PREFIX ('summon-sessions-'), or that sweeper deletes this folder.
  const dataDir = await mkdtemp(path.join(tmpRoot, 'summon-cli-sessions-'));
  let sessions;
  try {
    await chmod(dataDir, 0o700);
    try {
      const saved = path.join(summonData, 'agent-sessions.json');
      const info = await lstat(saved);
      if (info.isFile() && info.size <= 1_000_000) await writeFile(path.join(dataDir, 'agent-sessions.json'), await readFile(saved), { mode: 0o600 });
    } catch { /* No saved preferences: defaults apply. */ }
    sessions = await createAgentSessions({ dataDir, homeDir, run });
    return await sessions.read({ maxAgeMs: 0 });
  } finally {
    try { await sessions?.close?.(); } finally { await rm(dataDir, { recursive: true, force: true }); }
  }
}

const listOf = value => (Array.isArray(value) ? value : []);
const count = (groups, id) => groups.find(group => group.id === id)?.sessions.length || 0;

/** Keeps one app's sessions and, with recent:false, drops the recent group. Totals are recounted unless Summon already filtered by app (it counts before its 60-session cap). */
export function filterBoard(view, { app = null, recent = true } = {}) {
  if (!view || typeof view !== 'object' || !Array.isArray(view.groups)) return view;
  // Same check as sessionsForAgent in scripts/mcp-server.mjs: every session sent already belongs to this app.
  const serverFiltered = Boolean(app) && view.groups.every(group => listOf(group?.sessions).every(item => item?.app === app));
  let groups = view.groups.filter(group => group && typeof group === 'object').map(group => ({ ...group, sessions: listOf(group.sessions).filter(item => item && typeof item === 'object' && (!app || item.app === app)) }));
  if (!recent) groups = groups.filter(group => group.id !== 'recent');
  if (!app) return { ...view, groups };
  // --direct and older Summon builds send every app, so their totals still have to be recounted here.
  const totals = serverFiltered && view.totals && typeof view.totals === 'object'
    ? view.totals
    : { needsYou: count(groups, 'needs-you'), newReplies: count(groups, 'new'), working: count(groups, 'working'), open: count(groups, 'open') };
  const sources = listOf(view.sources).filter(source => source?.app === app);
  // Folder chips count every app, so they are left out of a one-app view.
  return { ...view, groups, totals, sources, byPlace: undefined };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// Titles come from other apps, so they hold CJK and emoji. A terminal gives those two cells, and a joined emoji
// sequence is several code points in one cell pair, so widths are counted per grapheme rather than per code point.
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });
// East Asian Wide and Fullwidth blocks, written as code points so no invisible character sits in this file.
const WIDE = [[0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x20000, 0x3fffd]];
const VS16 = String.fromCodePoint(0xfe0f); // makes the character before it emoji, and so two cells wide
const isWide = code => WIDE.some(([low, high]) => code >= low && code <= high);
const cellWidth = g => (/\p{Emoji_Presentation}/u.test(g) || (g.includes(VS16) && /\p{Extended_Pictographic}/u.test(g)) || isWide(g.codePointAt(0)) ? 2 : /^\p{M}+$/u.test(g) ? 0 : 1);
const cells = text => Array.from(graphemes.segment(text), ({ segment }) => [segment, cellWidth(segment)]);
const cols = text => cells(text).reduce((n, [, width]) => n + width, 0);
// The longest prefix of `text` that fits in `room` cells; `room` may be Infinity.
const take = (text, room) => { let out = ''; let used = 0; for (const [g, width] of cells(text)) { if (used + width > room) break; out += g; used += width; } return out; };
const STYLE = { bold: ['\x1b[1m', '\x1b[22m'], dim: ['\x1b[2m', '\x1b[22m'] };
const GROUP_TITLES = { 'needs-you': 'Needs you', new: 'New replies', working: 'Working', open: 'Open', interrupted: 'Interrupted', recent: 'Earlier' };
const GLYPHS = { 'needs-you': '◐', new: '●', working: '◉', open: '○', interrupted: '◌', recent: '·' };
const GAP = '   ';
// A cut landing just after a bullet separator would leave it hanging, so a trailing bullet goes with the spaces.
const cutEnd = text => text.replace(/[\s\u00b7]+$/u, '');

// A line is a list of [text, style] parts; paint() cuts it to the width (with …) before adding any styling.
function paint(parts, { width, color }) {
  const total = parts.reduce((sum, [text]) => sum + cols(text), 0);
  let room = Number.isFinite(width) && width > 0 && total > width ? width - 1 : Infinity;
  let out = '';
  for (const [text, style] of parts) {
    if (room <= 0) break;
    const piece = take(text, room); room -= cols(text);
    out += color && style && STYLE[style] && piece ? `${STYLE[style][0]}${piece}${STYLE[style][1]}` : piece;
  }
  if (room !== Infinity && room <= 0) out = `${cutEnd(out)}…`;
  return out.replace(/ +$/, '');
}

// Pads or cuts text to exactly `size` columns.
function fit(text, size) {
  const used = cols(text);
  if (used <= size) return text + ' '.repeat(size - used);
  if (size <= 1) return '…'.slice(0, size);
  // A wide character that no longer fits leaves one cell over, which the padding below fills.
  const cut = `${cutEnd(take(text, size - 1))}…`;
  return cut + ' '.repeat(size - cols(cut));
}

// "Claude worktree · calm-otter" → "calm-otter"; the main folder adds nothing next to the project name.
function placeWord(label, project) {
  const text = clean(label, 120);
  if (!text || /^main folder$/i.test(text)) return '';
  const word = text.includes(' · ') ? text.split(' · ').pop() : text;
  return word === project ? '' : word;
}

function row(session, group) {
  const appLabel = clean(session.appLabel, 40) || APP_NAMES[session.app] || 'Agent';
  const fallback = session.titleIsFallback === true || !clean(session.title, 120);
  const title = clean(session.title, 120) || `Untitled ${APP_NAMES[session.app] || 'agent'} session`;
  const project = clean(session.project, 60);
  const where = project || clean(session.folder, 80);
  // Summon's own fact, so it is not cleaned as app text: the row was started with the button in the workbench.
  const mid = [appLabel, where, placeWord(session.placeLabel, project), session.startedFrom === 'summon' ? 'from Summon' : ''].filter(Boolean).join(' · ');
  const helpers = Number.isSafeInteger(session.helpers) && session.helpers > 0 ? plural(session.helpers, 'helper') : '';
  const state = [clean(session.stateText, 80), helpers, session.unread === true && group !== 'new' ? 'new reply' : ''].filter(Boolean).join(' · ');
  const glyph = session.activity === 'failed' ? '✕' : GLYPHS[group] || '·';
  return { glyph, title, fallback, mid, state };
}

/** Pure renderer: AgentSessions view → terminal text. `color` adds bold/dim only; `width` cuts each line with …. */
export function renderBoard(view, { width = Infinity, color = false, recent = true, note = null, app = null } = {}) {
  const lines = [];
  const groups = listOf(view?.groups).filter(group => group && typeof group === 'object' && listOf(group.sessions).length);
  const shown = recent ? groups : groups.filter(group => group.id !== 'recent');
  const hidden = recent ? 0 : groups.filter(group => group.id === 'recent').reduce((sum, group) => sum + group.sessions.length, 0);
  const totals = view?.totals || {};
  const n = key => (Number.isSafeInteger(totals[key]) && totals[key] > 0 ? totals[key] : 0);
  const words = [];
  if (n('needsYou')) words.push(plural(n('needsYou'), 'needs you', 'need you'));
  if (n('newReplies')) words.push(plural(n('newReplies'), 'new reply', 'new replies'));
  if (n('working')) words.push(`${n('working')} working`);
  if (!words.length && n('open')) words.push('nothing needs you', `${n('open')} open`);
  const header = [[APP_NAMES[app] ? `${APP_NAMES[app]} sessions` : 'Agent sessions', 'bold']];
  if (words.length) header.push([` · ${words.join(' · ')}`]);
  lines.push(header);

  const rows = shown.map(group => ({ group, items: group.sessions.map(session => row(session, group.id)) }));
  const all = rows.flatMap(entry => entry.items);
  if (!all.length) lines.push([['Nothing needs you. No agent is working right now.']]);
  const longest = key => all.reduce((max, item) => Math.max(max, cols(item[key])), 0);
  let titleSize = Math.min(longest('title'), 40);
  let midSize = Math.min(longest('mid'), 44);
  const stateSize = longest('state');
  // Narrow terminals: the state is the answer, so the middle column and then the title give way first.
  if (Number.isFinite(width) && width > 0) {
    let over = 2 + titleSize + GAP.length + midSize + GAP.length + stateSize - width;
    for (const [column, floor] of [['mid', 14], ['title', 16], ['mid', 10], ['title', 12]]) {
      const size = column === 'mid' ? midSize : titleSize;
      const cut = Math.max(0, Math.min(over, size - floor));
      if (column === 'mid') midSize -= cut; else titleSize -= cut;
      over -= cut;
    }
  }
  for (const { group, items } of rows) {
    lines.push([[GROUP_TITLES[group.id] || clean(group.title, 60) || 'Other', 'bold']]);
    for (const item of items) {
      const parts = [[`${item.glyph} `], [fit(item.title, titleSize), item.fallback ? 'dim' : null]];
      if (midSize > 0) parts.push([GAP], [fit(item.mid, midSize), 'dim']);
      parts.push([GAP], [item.state]);
      lines.push(parts);
    }
  }
  if (hidden) lines.push([[`${plural(hidden, 'more session was', 'more sessions were')} active recently. Add --recent to see ${hidden === 1 ? 'it' : 'them'}.`, 'dim']]);
  const sources = listOf(view?.sources).filter(source => source && typeof source === 'object');
  if (sources.length) {
    const named = sources.map(source => {
      const label = clean(source.label, 40) || APP_NAMES[source.app] || 'Unknown';
      return source.available === false ? `${label} (not found)` : source.running === true ? label : `${label} (not running)`;
    });
    lines.push([]);
    lines.push([[`Sources: ${named.join(', ')}`, 'dim']]);
  }
  for (const warning of listOf(view?.warnings).slice(0, 10)) lines.push([['Note: ', 'dim'], [clean(warning, 300), 'dim']]);
  if (note) lines.push([[clean(note, 300), 'dim']]);
  return lines.map(parts => paint(parts, { width, color })).join('\n');
}

/** CLI entry with injectable I/O for tests. Resolves to the exit code. */
export async function runCli(argv = process.argv.slice(2), { call = rpc, direct = readDirect, stdout = process.stdout, stderr = process.stderr, env = process.env } = {}) {
  let flags;
  try {
    flags = parseArgs({ args: argv, allowPositionals: false, options: { app: { type: 'string' }, recent: { type: 'boolean' }, direct: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } }).values;
  } catch (error) { stderr.write(`${clean(error.message)}\n\n${USAGE}\n`); return 2; }
  if (flags.help) { stdout.write(`${USAGE}\n`); return 0; }
  const app = flags.app === undefined ? null : flags.app.trim().toLowerCase();
  if (app !== null && !APPS.includes(app)) { stderr.write('--app must be claude, codex, cursor or hermes.\n'); return 2; }
  // npm prints its own header lines to stdout before the script runs; -s (silent) leaves them out.
  if (flags.json && env.npm_lifecycle_event && env.npm_config_loglevel !== 'silent') stderr.write('Note: npm printed its header above the JSON. For clean JSON use npm run -s sessions -- --json.\n');
  try {
    // Recent sessions always come along, so --recent works and the hint below can count them; Summon filters by app before its cap.
    const view = flags.direct ? await direct({ env }) : await call({ method: 'agent-sessions', ...(app ? { app } : {}), includeRecent: true });
    if (!view || typeof view !== 'object' || !Array.isArray(view.groups)) throw new Error('Summon sent an answer this script cannot read.');
    const note = flags.direct ? DIRECT_NOTE : null;
    if (flags.json) {
      stdout.write(`${JSON.stringify(filterBoard(view, { app, recent: Boolean(flags.recent) }), null, 2)}\n`);
      if (note) stderr.write(`${note}\n`);
      return 0;
    }
    const tty = Boolean(stdout.isTTY);
    const color = tty && !env.NO_COLOR;
    const width = tty ? stdout.columns || 100 : Infinity;
    stdout.write(`${renderBoard(filterBoard(view, { app }), { width, color, recent: Boolean(flags.recent), note, app })}\n`);
    return 0;
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
