import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRpcServer } from '../src/main/rpc.mjs';
import { renderTree, runCli, findRepo, clean, progressText, rpc as cliRpc, NOT_RUNNING, POLL_MS } from '../scripts/work-in-flight.mjs';

const root = path.resolve(import.meta.dirname, '..');
const ESC = String.fromCharCode(27);
const NOW = Date.parse('2026-09-17T15:00:00Z');
const plain = value => JSON.parse(JSON.stringify(value));

// Synthetic view shaped like the WorkInFlight contract. No real project, person or path.
function fakeView() {
  const home = '/private/tmp/synthetic-home/Projects';
  const settings = { engine: 'codex', effort: 'medium', claudeModel: 'opus', groupOnOpen: true, extraRoots: [], excludedRoots: [], privatePaths: {}, consentedAt: null };
  const counts = items => ({ staged: 0, unstaged: items, untracked: 0, conflicted: 0, items });
  const place = extra => ({ id: 'place-x', kind: 'main', label: 'Main folder', path: `${home}/x`, displayPath: '~/Projects/x', missing: false, branch: 'main', detached: false, head: 'abcdef12', upstream: 'origin/main', ahead: 0, behind: 0, aheadOfBase: 0, behindBase: 0, stateWords: ['all saved'], counts: counts(0), added: 0, removed: 0, lastChangedAt: null, mirrorOf: null, filesTruncated: false, grouping: null, error: null, ...extra });
  const stream = (id, title, extra) => ({ id, title, summary: `${title} summary.`, area: 'product', readiness: 'in-progress', files: [], sharedFiles: [], added: 0, removed: 0, suggestedCommit: null, private: false, ...extra });
  const repo = extra => ({ id: 'repo-x', projectId: null, name: 'X', path: `${home}/x`, displayPath: '~/Projects/x', status: 'clean', headline: 'All caught up.', defaultBranch: 'main', hasRemote: true, lastFetchedAt: null, places: [place({})], branches: [], stashes: [], error: null, ...extra });
  return {
    version: 1, scannedAt: new Date(NOW).toISOString(), job: null, settings, errors: [],
    disclosure: 'Grouping sends to Codex (your ChatGPT sign-in): project, folder and branch names, recent commit messages, changed file names with line counts, short excerpts from non-private text files, and a few file names in new folders. Private folders send only their folder name, file types, change and line counts, and edit dates. Nothing is sent until you press Group changes.',
    totals: { reposWithWork: 2, unsavedItems: 7, unsharedCommits: 2, setAside: 1, openBranches: 1, staleGroupings: 1 },
    repos: [
      repo({
        id: 'demo', projectId: 'demo', name: 'Demo App', displayPath: '~/Projects/Demo App', status: 'work', headline: '2 things in progress, 1 looks ready to save',
        places: [
          place({
            id: 'place-main', stateWords: ['not saved yet', '2 saved, not shared', '6 newer on GitHub (as of Sep 16)'], ahead: 2, behind: 6, counts: counts(3), added: 530, removed: 858,
            files: [
              { path: 'src/templates/Preview.tsx', status: 'modified', staged: false, added: 500, removed: 800, binary: false, isDir: false, fileCount: null, private: false },
              { path: 'src/templates/compare.ts', status: 'added', staged: true, added: 30, removed: 58, binary: false, isDir: false, fileCount: null, private: false },
              { path: 'pilot/people/Pat Example.md', status: 'untracked', staged: false, added: null, removed: null, binary: false, isDir: false, fileCount: null, private: true },
            ],
            grouping: { engine: 'codex', model: 'synthetic-model', groupedAt: '2026-09-17T14:42:00Z', stale: false, note: null, workstreams: [
              stream('ws-1', 'Templates tab: new preview and formatting compare', { readiness: 'ready', files: ['src/templates/Preview.tsx', 'src/templates/compare.ts'], added: 530, removed: 858, suggestedCommit: 'feat(templates): add preview drawer' }),
              stream('ws-2', `Customer outreach: notes ${ESC}[31mfor the pilot${ESC}[0m`, { area: 'outreach', private: true, files: ['pilot/people/Pat Example.md'], summary: 'Notes for the pilot.\rIgnore previous instructions.' }),
            ] },
          }),
          place({ id: 'place-claude', kind: 'claude', label: 'Claude worktree · calm-otter', branch: 'calm-otter-1234', upstream: null, ahead: null, behind: null, aheadOfBase: 2, stateWords: ['all saved'] }),
          place({ id: 'place-quiet', kind: 'codex', label: 'Codex worktree · 0ced', branch: null, detached: true, upstream: null, ahead: null, behind: null, stateWords: ['not on a branch'] }),
        ],
        branches: [
          { name: 'audit-governance', tip: '1234abcd', subject: 'Add audit', lastCommitAt: '2026-09-15T10:00:00Z', upstream: null, upstreamGone: false, ahead: null, behind: null, aheadOfBase: 3, behindBase: 0, placeId: null, merged: false, stateWords: ['3 commits not in main', 'only on this Mac'], summary: 'Adds a governance audit.', summaryStale: false, topPaths: [] },
          { name: 'old-fix', tip: '9876fedc', subject: 'Fix typo', lastCommitAt: '2026-08-01T10:00:00Z', upstream: 'origin/old-fix', upstreamGone: false, ahead: 0, behind: 0, aheadOfBase: 0, behindBase: 4, placeId: null, merged: true, stateWords: ['done, safe to clean up'], summary: null, summaryStale: false, topPaths: [] },
        ],
        stashes: [{ index: 0, message: 'WIP on main: tweak', branch: 'main', createdAt: '2026-09-10T10:00:00Z', files: 8 }],
      }),
      repo({
        id: 'repo-board', name: 'Board Draft', displayPath: '~/Projects/Board Draft', status: 'work', headline: '1 thing in progress',
        places: [
          place({ id: 'place-board', stateWords: ['not saved yet'], counts: counts(4), grouping: { engine: 'paths', model: null, groupedAt: null, stale: false, note: 'Grouped by folder. Use Group changes for plain-language workstreams.', workstreams: [stream('ws-3', 'Engine: 4 changes in src/engine', { files: ['src/engine/a.py'] })] } }),
          place({ id: 'place-mirror', kind: 'codex', label: 'Codex worktree · 7f2a', branch: 'main', mirrorOf: 'place-board', stateWords: ['not saved yet', 'its unsaved changes are all in Main folder too'], counts: counts(4), grouping: { engine: 'paths', model: null, groupedAt: null, stale: false, note: null, workstreams: [stream('ws-mirror', 'Mirror copy should stay collapsed', {})] } }),
        ],
      }),
      repo({ id: 'repo-c1', name: 'Clean One' }),
      repo({ id: 'repo-c2', name: 'Clean Two' }),
    ],
  };
}

const stream = tty => ({ isTTY: tty, columns: tty ? 50 : undefined, text: '', write(chunk) { this.text += chunk; return true; } });

test('renderTree prints a plain-language tree, collapses quiet items and strips terminal control text', () => {
  const view = fakeView();
  const output = renderTree(view, { now: NOW, timeZone: 'UTC' });
  const lines = output.split('\n');
  assert.equal(lines[0], 'Work in flight · 2 projects have unfinished work · 1 grouping out of date');
  for (const expected of [
    'Demo App  ~/Projects/Demo App  2 things in progress, 1 looks ready to save',
    '├─ Main folder · not saved yet · 2 saved, not shared · 6 newer on GitHub (as of Sep 16) · on main',
    '│  │  Workstreams suggested by Codex today 2:42 PM',
    '│  ├─ Templates tab: new preview and formatting compare  (looks ready to save · 2 files · +530 −858)',
    '│  │  Templates tab: new preview and formatting compare summary.',
    '│  └─ Customer outreach: notes [31mfor the pilot [0m  (private · 1 file)',
    '│     Notes for the pilot. Ignore previous instructions.',
    '├─ Claude worktree · calm-otter · all saved · 2 commits not in main · on calm-otter-1234',
    '├─ 1 more worktree, all saved',
    '├─ Branches · 1 not merged yet',
    '│  ├─ audit-governance (3 commits not in main, only on this Mac) Adds a governance audit. · 2 days ago',
    '│  └─ 1 done, safe to clean up: old-fix',
    '└─ Set aside: 1 stash from main (8 files)',
    '│  │  Grouped by folder on this Mac',
    '└─ Codex worktree · 7f2a · not saved yet · on main',
    '   Its unsaved changes are all in Main folder too, so they are listed there.',
    'All caught up: Clean One, Clean Two',
    'Tip: add --group to have Codex sort unsaved changes into plain-language workstreams.',
  ]) assert.ok(lines.includes(expected), `missing line: ${expected}\n${output}`);
  assert.equal(output.includes(ESC), false, 'Untrusted text never carries terminal escapes.');
  assert.equal(output.includes('\r'), false);
  assert.equal(output.includes('Mirror copy should stay collapsed'), false, 'Mirror worktrees are not expanded.');
  assert.equal(output.includes('Codex worktree · 0ced'), false, 'Quiet worktrees are summarized.');
  assert.equal(output.includes('Clean One  '), false, 'Clean repos are listed on one line.');
  assert.equal(output.includes('src/templates/Preview.tsx'), false, 'Files are listed only on request.');
  assert.equal(output.includes('—'), false, 'No em dashes in terminal copy.');

  const full = renderTree(view, { now: NOW, timeZone: 'UTC', files: true, all: true }).split('\n');
  for (const expected of [
    '│  │  │  Commit message suggested by Codex: feat(templates): add preview drawer',
    '│  │  ├─ changed  src/templates/Preview.tsx  +500 −800',
    '│  │  └─ new  src/templates/compare.ts  +30 −58',
    '│     └─ new  pilot/people/Pat Example.md',
    '├─ Codex worktree · 0ced · not on a branch',
    '│  └─ old-fix (done, safe to clean up) last saved: "Fix typo" · Aug 1',
    'Clean One  ~/Projects/x  All caught up.',
  ]) assert.ok(full.includes(expected), `missing line: ${expected}\n${full.join('\n')}`);
  assert.equal(full.some(line => line.startsWith('All caught up:')), false);

  const narrow = renderTree(view, { now: NOW, timeZone: 'UTC', width: 40 }).split('\n');
  assert.ok(narrow.every(line => Array.from(line).length <= 40), 'Lines fit the terminal.');
  assert.ok(narrow.some(line => line.endsWith('…')));
  const colored = renderTree(view, { now: NOW, timeZone: 'UTC', color: true, width: 40 });
  assert.ok(colored.includes(`${ESC}[1mWork in flight${ESC}[22m`));
  assert.equal(colored.includes(`${ESC}[31m`), false, 'Only this script adds styling.');
  assert.ok(colored.split('\n').every(line => Array.from(line.replaceAll(/\x1b\[\d+m/g, '')).length <= 40));

  const empty = renderTree({ totals: { reposWithWork: 0, staleGroupings: 0 }, repos: [], errors: ['Still checking; try again in a moment.'], job: { id: 'j', status: 'running', progress: { done: 1, total: 3 }, current: 'Demo App', errors: [] } });
  assert.deepEqual(empty.split('\n').filter(Boolean), ['Work in flight · All caught up', 'No git projects found. Add a workspace folder in Summon.', 'Grouping Demo App (2 of 3)…', 'Problem: Still checking; try again in a moment.']);
  assert.equal(clean(`a${ESC}]0;title${String.fromCharCode(7)}b`, 50), 'a ]0;title b');
  assert.equal(clean('x'.repeat(20), 5), 'xxxx…');
  assert.equal(progressText({ status: 'done', progress: { done: 0, total: 0 } }), 'Nothing new to group.');
  assert.equal(findRepo(fakeView().repos, 'board').id, 'repo-board');
  assert.equal(findRepo(fakeView().repos, 'clean'), null, 'Ambiguous partial names do not guess.');
});

test('CLI resolves projects, groups on request with polling, and explains a closed Summon', async () => {
  const view = fakeView();
  const calls = [];
  const call = async request => { calls.push(request); return view; };
  let out = stream(false); let err = stream(false);
  assert.equal(await runCli(['--project', 'DEMO APP', '--files'], { call, stdout: out, stderr: err, now: () => NOW }), 0);
  assert.deepEqual(calls, [{ method: 'work-in-flight', projectId: null, includeFiles: false, privateNames: true }, { method: 'work-in-flight', projectId: 'demo', includeFiles: true, privateNames: true }]);
  assert.ok(out.text.includes('├─ changed  src/templates/Preview.tsx  +500 −800'));
  assert.equal(err.text, '');

  out = stream(false); err = stream(false);
  assert.equal(await runCli(['--project', 'nope'], { call, stdout: out, stderr: err }), 1);
  assert.equal(err.text, 'No project matches "nope". Projects: Demo App, Board Draft, Clean One, Clean Two.\n');

  out = stream(false); err = stream(false);
  assert.equal(await runCli(['--force'], { call, stdout: out, stderr: err }), 2);
  assert.equal(await runCli(['extra'], { call, stdout: out, stderr: err }), 2);
  assert.equal(await runCli(['--help'], { call, stdout: out, stderr: err }), 0);
  assert.match(out.text, /Usage: npm run flight/);

  out = stream(false); err = stream(false);
  const closed = async () => { throw Object.assign(new Error('socket gone'), { code: 'NOT_RUNNING' }); };
  assert.equal(await runCli([], { call: closed, stdout: out, stderr: err }), 1);
  assert.equal(err.text, `${NOT_RUNNING}\n`);
  assert.equal(NOT_RUNNING, 'Open Summon first (⌘⇧J), then run this again.');

  out = stream(false); err = stream(false);
  assert.equal(await runCli(['--json'], { call: async () => view, stdout: out, stderr: err }), 0);
  assert.deepEqual(JSON.parse(out.text), view);

  out = stream(true); err = stream(false);
  assert.equal(await runCli([], { call: async () => view, stdout: out, stderr: err, env: {} }), 0);
  assert.ok(out.text.includes(ESC) && out.text.split('\n').every(line => Array.from(line.replaceAll(/\x1b\[\d+m/g, '')).length <= 50));
  out = stream(true);
  assert.equal(await runCli([], { call: async () => view, stdout: out, stderr: err, env: { NO_COLOR: '1' } }), 0);
  assert.equal(out.text.includes(ESC), false, 'NO_COLOR is respected.');

  // Grouping: the job moves through two targets, then finishes with one problem.
  const job = { id: 'job-1', status: 'running', reason: 'cli', engine: 'codex', startedAt: new Date(NOW).toISOString(), finishedAt: null, progress: { done: 0, total: 2 }, current: 'Demo App', errors: [] };
  const states = [{ ...job, progress: { done: 1, total: 2 }, current: 'Board Draft' }, { ...job, status: 'done', progress: { done: 2, total: 2 }, current: null, errors: ['Board Draft: Codex could not finish.'] }];
  const groupCalls = []; const sleeps = []; let polls = 0;
  const grouping = async request => {
    groupCalls.push(request);
    if (request.method === 'work-in-flight-group') return { job };
    const current = groupCalls.filter(item => item.method === 'work-in-flight-group').length ? states[Math.min(polls++, states.length - 1)] : null;
    return { ...view, job: current };
  };
  out = stream(false); err = stream(false);
  assert.equal(await runCli(['--group', '--force'], { call: grouping, stdout: out, stderr: err, sleep: async ms => { sleeps.push(ms); }, now: () => NOW }), 0);
  assert.deepEqual(groupCalls.map(item => item.method), ['work-in-flight', 'work-in-flight-group', 'work-in-flight', 'work-in-flight', 'work-in-flight']);
  assert.deepEqual(groupCalls[1], { method: 'work-in-flight-group', projectId: null, force: true, reason: 'cli' });
  assert.deepEqual(sleeps, [POLL_MS, POLL_MS]);
  const printed = out.text.split('\n');
  assert.deepEqual(printed.slice(0, 5), [view.disclosure, 'Grouping Demo App (1 of 2)…', 'Grouping Board Draft (2 of 2)…', 'Grouping finished (2 of 2).', '  Board Draft: Codex could not finish.']);
  assert.equal(out.text.includes('Tip: add --group'), false);

  // A job that never finishes stops waiting after six minutes; Summon keeps working.
  let clock = 0; let waits = 0;
  const stuck = async request => (request.method === 'work-in-flight-group' ? { job } : { ...view, job });
  out = stream(false);
  assert.equal(await runCli(['--group', '--json'], { call: stuck, stdout: out, stderr: err, sleep: async ms => { waits++; clock += ms; }, now: () => clock }), 0);
  assert.equal(waits, 120);
  assert.match(err.text, /Still grouping after 6 minutes/);
  assert.equal(JSON.parse(out.text).job.status, 'running');

  const failing = async request => { if (request.method === 'work-in-flight-group') throw new Error('Grouping is turned off. Choose Codex or Claude in Work in flight settings.'); return view; };
  out = stream(false); err = stream(false);
  assert.equal(await runCli(['--group'], { call: failing, stdout: out, stderr: err }), 1);
  assert.equal(err.text, 'Grouping is turned off. Choose Codex or Claude in Work in flight settings.\n');
});

test('MCP work-in-flight tools map to the Summon socket and stay read-only by default', async t => {
  const dir = await mkdtemp('/tmp/summon-wif-');
  const socketPath = path.join(dir, 's.sock');
  const reads = []; const groups = [];
  let groupError = null;
  const view = fakeView();
  const workInFlight = {
    read: async options => { reads.push(options); await new Promise(resolve => setTimeout(resolve, 30)); return options.projectId ? { ...view, repos: view.repos.filter(repo => repo.id === options.projectId) } : view; },
    group: options => { groups.push(options); if (groupError) throw groupError; return { id: 'job-1', status: 'queued', reason: options.reason, engine: 'codex', startedAt: new Date(NOW).toISOString(), finishedAt: null, progress: { done: 0, total: 0 }, current: null, errors: [] }; },
  };
  const state = { projects: [{ id: 'demo', name: 'Demo App' }], currentProjectId: 'demo', activity: null, settings: { paused: false }, events: [], files: [], health: {} };
  const timeouts = [];
  const originalSetTimeout = net.Socket.prototype.setTimeout;
  net.Socket.prototype.setTimeout = function (...args) { timeouts.push(args[0]); return originalSetTimeout.apply(this, args); };
  const close = await createRpcServer({ snapshot: () => state }, socketPath, { workInFlight });
  const bare = await createRpcServer({ snapshot: () => state }, path.join(dir, 'bare.sock'));
  let child;
  const pending = new Map();
  t.after(async () => {
    net.Socket.prototype.setTimeout = originalSetTimeout;
    child?.kill();
    for (const request of pending.values()) clearTimeout(request.timer);
    await close(); await bare();
    await rm(dir, { recursive: true, force: true });
  });
  child = spawn(process.execPath, [path.join(root, 'scripts/mcp-server.mjs')], { env: { ...process.env, SUMMON_SOCKET: socketPath }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = ''; let next = 0;
  child.stdout.on('data', chunk => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const newline = buffer.indexOf('\n');
      const message = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
      const request = pending.get(message.id);
      if (request) { pending.delete(message.id); clearTimeout(request.timer); request.resolve(message); }
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP work-in-flight request timed out')); }, 5000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const toolCall = async (name, args) => (await request('tools/call', { name, arguments: args })).result;

  const init = (await request('initialize', { protocolVersion: '2024-11-05' })).result;
  assert.equal(init.serverInfo.version, '0.4.0');
  assert.match(init.instructions, /read-only git status/);
  const tools = (await request('tools/list')).result.tools;
  assert.equal(tools.some(tool => /run_routine|execute|shell/.test(tool.name)), false);
  const read = tools.find(tool => tool.name === 'work_in_flight');
  assert.deepEqual(read.inputSchema, { type: 'object', properties: { projectId: { type: ['string', 'null'], maxLength: 200 }, includeFiles: { type: 'boolean' } }, additionalProperties: false });
  assert.deepEqual(read.annotations, { readOnlyHint: true });
  assert.match(read.description, /Read-only; never changes a repository/);
  const group = tools.find(tool => tool.name === 'group_work_in_flight');
  assert.deepEqual(group.inputSchema, { type: 'object', properties: { projectId: { type: ['string', 'null'], maxLength: 200 }, force: { type: 'boolean' } }, additionalProperties: false });
  assert.deepEqual(group.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
  assert.match(group.description, /Use only when the user asks/);

  const before = timeouts.length;
  const overview = await toolCall('work_in_flight', {});
  assert.equal(overview.isError, undefined);
  assert.equal(JSON.parse(overview.content[0].text).repos.length, 4);
  assert.deepEqual(reads.at(-1), { projectId: null, includeFiles: false, maxAgeMs: 20000, maskPrivate: true });
  assert.ok(timeouts.slice(before).includes(20000), 'Work in flight requests get a longer socket idle limit.');
  const scoped = await toolCall('work_in_flight', { projectId: 'demo', includeFiles: true });
  assert.deepEqual(JSON.parse(scoped.content[0].text).repos.map(repo => repo.id), ['demo']);
  assert.deepEqual(reads.at(-1), { projectId: 'demo', includeFiles: true, maxAgeMs: 20000, maskPrivate: true });

  const started = await toolCall('group_work_in_flight', { projectId: 'demo', force: true });
  assert.deepEqual(JSON.parse(started.content[0].text).job.status, 'queued');
  assert.deepEqual(groups, [{ repoId: 'demo', force: true, reason: 'agent' }]);
  await toolCall('group_work_in_flight', {});
  assert.deepEqual(groups.at(-1), { repoId: null, force: false, reason: 'agent' });
  groupError = new Error('Grouping is turned off. Choose Codex or Claude in Work in flight settings.');
  const off = await toolCall('group_work_in_flight', {});
  assert.equal(off.isError, true);
  assert.match(off.content[0].text, /Grouping is turned off/);

  const readCount = reads.length; const groupCount = groups.length;
  for (const [name, args] of [['work_in_flight', { projectId: 'x'.repeat(201) }], ['work_in_flight', { projectId: 7 }], ['work_in_flight', { includeFiles: 'yes' }], ['group_work_in_flight', { projectId: { id: 'demo' } }], ['group_work_in_flight', { force: 'true' }]]) {
    const result = await toolCall(name, args);
    assert.equal(result.isError, true, `${name} ${JSON.stringify(args)} is rejected`);
    assert.match(result.content[0].text, /Invalid/);
  }
  assert.equal(reads.length, readCount); assert.equal(groups.length, groupCount);

  const plainBefore = timeouts.length;
  const context = await toolCall('get_working_context', {});
  assert.equal(JSON.parse(context.content[0].text).currentProject.name, 'Demo App');
  assert.equal(timeouts.slice(plainBefore).includes(20000), false, 'Other methods keep the default idle limit.');

  const missing = await new Promise(resolve => { const socket = net.connect(path.join(dir, 'bare.sock')); let body = ''; socket.on('connect', () => socket.write('{"method":"work-in-flight"}\n')); socket.on('data', chunk => { body += chunk; }); socket.on('end', () => resolve(JSON.parse(body))); });
  assert.equal(missing.error, 'Work in flight is not available in this Summon version.');
  const raw = line => new Promise(resolve => { const socket = net.connect(socketPath); let body = ''; socket.on('connect', () => socket.write(`${JSON.stringify(line)}\n`)); socket.on('data', chunk => { body += chunk; }); socket.on('end', () => resolve(JSON.parse(body))); });
  groupError = null;
  assert.equal((await raw({ method: 'work-in-flight-group', reason: 'cli' })).result.job.reason, 'cli');
  assert.match((await raw({ method: 'work-in-flight-group', reason: 'panel' })).error, /Invalid reason/);
  assert.match((await raw({ method: 'work-in-flight', privateNames: 'yes' })).error, /Invalid privateNames/);
  await raw({ method: 'work-in-flight', privateNames: true });
  assert.equal(reads.at(-1).maskPrivate, false, 'Only an explicit local request gets private file names.');

  // The CLI speaks the same socket protocol.
  const cli = (args, env) => new Promise(resolve => {
    const run = spawn(process.execPath, [path.join(root, 'scripts/work-in-flight.mjs'), ...args], { env: { ...process.env, NO_COLOR: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    run.stdout.on('data', chunk => { stdout += chunk; }); run.stderr.on('data', chunk => { stderr += chunk; });
    run.on('close', code => resolve({ code, stdout, stderr }));
  });
  const shown = await cli(['--project', 'demo app'], { SUMMON_SOCKET: socketPath });
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /^Work in flight · 2 projects have unfinished work/);
  assert.match(shown.stdout, /\nDemo App {2}~\/Projects\/Demo App {2}2 things in progress/);
  assert.equal(shown.stdout.includes(ESC), false);
  assert.deepEqual(reads.slice(-2), [{ projectId: null, includeFiles: false, maxAgeMs: 20000, maskPrivate: false }, { projectId: 'demo', includeFiles: true, maxAgeMs: 20000, maskPrivate: false }]);
  const closedApp = await cli([], { SUMMON_SOCKET: path.join(dir, 'missing.sock') });
  assert.equal(closedApp.code, 1);
  assert.equal(closedApp.stderr, 'Open Summon first (⌘⇧J), then run this again.\n');
  const package_ = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(package_.scripts.flight, 'node scripts/work-in-flight.mjs');
});

// Runs the real main.mjs lifecycle with injected adapters (same approach as lifecycle.test.mjs).
async function startMain({ createWorkInFlight }) {
  const handlers = new Map(); const fnMonitors = []; let fnStarts = 0, fnStops = 0; const sent = []; const opened = []; const shown = []; const health = [];
  const ctx = { handlers, sent, opened, shown, health, finalQuits: 0, rpcOptions: null, groupingCall: null, window: null, entries: new Map(), sessionReads: 0, placeCountCalls: 0, placeCounts: { 'place-1': { working: 2 } } };
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const noop = () => {};
  const missing = async () => { throw new Error('No optional fixture files.'); };
  const app = new EventEmitter();
  Object.assign(app, { isPackaged: true, dock: { hide: noop }, setName: noop, requestSingleInstanceLock: () => true, getPath: () => '/private/tmp/synthetic-summon-data', whenReady: () => Promise.resolve(), quit() { const event = { cancelled: false, preventDefault() { this.cancelled = true; } }; app.emit('before-quit', event); if (!event.cancelled) ctx.finalQuits++; } });
  class Window extends EventEmitter {
    constructor() { super(); this.webContents = new EventEmitter(); Object.assign(this.webContents, { mainFrame: {}, send: (channel, value) => sent.push([channel, value]), setWindowOpenHandler: noop }); ctx.window = this; }
    isDestroyed() { return false; }
    loadFile() { return Promise.resolve(); }
    show() {} hide() {} focus() {}
  }
  class Tray extends EventEmitter { setToolTip() {} setTitle() {} setContextMenu() {} popUpContextMenu() {} destroy() {} }
  const state = { settings: { paused: true, activityEnabled: true, whisperModel: '/private/tmp/synthetic-model.bin' }, health: { whisper: false }, projects: [{ id: 'demo', name: 'Demo', path: '/private/tmp/synthetic-home/Demo' }], files: [], events: [] };
  const service = { snapshot: () => state, setHealth: value => { health.push(value); }, start: async () => { started(); }, stop: async () => {} };
  ctx.state = state; ctx.missing = missing;
  ctx.scrubbedEnv = extra => ({ PATH: '/usr/bin', ...extra });
  const sourceURL = new URL('../src/main/main.mjs', import.meta.url);
  const source = (await readFile(sourceURL, 'utf8')).replace(/^import .*;\n/gm, '').replaceAll('import.meta.url', JSON.stringify(sourceURL.href));
  vm.runInNewContext(source, {
    app, BrowserWindow: Window, Tray, Menu: { buildFromTemplate: x => x, setApplicationMenu: noop }, screen: {}, powerMonitor: { on: noop },
    createWorkInFlight, runGrouping: async (...args) => { ctx.groupingCall = args; return { raw: {}, model: null }; }, GIT_ENV: { GIT_OPTIONAL_LOCKS: '0' },
    createAgentSessions: async () => ({ read: async () => { ctx.sessionReads++; return {}; }, placeCounts: () => { ctx.placeCountCalls++; return ctx.placeCounts; }, openTarget: () => assert.fail('No session is opened by Work in flight.'), settings: () => ({}), updateSettings: async () => ({}), close: async () => {} }), clipboard: { writeText: () => assert.fail('Nothing is copied by Work in flight.') },
    createDesktopVoice: () => ({ publish: noop, updateVoice: noop, snapshot: () => ({state:'off',mode:'off',micActive:false}), toggle: noop, stop: async () => {}, close: async () => {} }),
    createTranscriber: () => ({ warm: async () => {}, release: noop, close: async () => {} }),
    nativeImage: { createFromBitmap: () => ({ setTemplateImage: noop }), createEmpty: () => ({}) }, sessionSummaryText: () => '', ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    shell: { openPath: async file => { opened.push(file); return ''; }, showItemInFolder: file => { shown.push(file); } },
    lstat: async file => { const kind = ctx.entries.get(file) ?? 'directory'; if (kind === 'missing') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return { isDirectory: () => kind === 'directory' }; }, dialog: { showErrorBox: (_title, message) => assert.fail(message) },
    globalShortcut: { register: () => true, unregisterAll: noop }, session: { defaultSession: { setPermissionRequestHandler: noop, setPermissionCheckHandler: noop } }, systemPreferences: {}, safeStorage: {},
    spawn: () => assert.fail('Paused observation must remain paused.'),
    readFile: missing, writeFile: noop, mkdir: noop, stat: missing, access: missing, chmod: noop, homedir: () => '/private/tmp/synthetic-home', path, fileURLToPath,
    createCompanion: async () => service, classifyCommand: noop, createCommandSession: () => ({}), createKnowledge: async () => ({ snapshot: () => ({}), refreshSources: async () => {}, search: async () => [] }),
    createLocalInterpreter: () => ({ status: () => ({}), health: async () => {}, close: async () => {} }), createWakeDetector: () => ({ status: () => ({}), start: async () => {}, stop: async () => {} }), createSpeaker:()=>({status:()=>({}),start:async()=>{},stop:async()=>{},verify:async()=>({verified:true,score:1,elapsedMs:0}),beginEnrollment:async()=>({minSamples:10}),enrollAudio:async()=>({count:1,elapsedMs:0}),finishEnrollment:async()=>({saved:true,samples:0}),cancelEnrollment(){}}),createFnKeyMonitor:options=>{fnMonitors.push(options);return {status:()=>'off',start(){fnStarts++;},poke(){},stop(){fnStops++;}};},FN_KEY_ERROR_MESSAGE:'fn-error', createBenchmark: () => noop,
    askEngine: () => assert.fail('No prompt is sent.'), createRpcServer: async (_service, _socket, options) => { ctx.rpcOptions = options; return async () => {}; },
    run: missing, scrubbedEnv: ctx.scrubbedEnv, executable: missing, stopProcesses: async () => {},
    // The usage meter and engine choice: stubbed so no timer or CLI of theirs runs in this lifecycle.
    createUsage:async()=>({status:()=>({version:1,settings:{usageCeiling:85,defaultEngine:'claude'},providers:{claude:null,codex:null},refreshing:[],problem:null}),settings:()=>({usageCeiling:85,defaultEngine:'claude'}),refresh:async()=>({}),updateSettings:async()=>({}),start:noop,pause:noop,resume:noop,stop:noop,close:async()=>{}}),usageText:()=>'',readClaudeUsage:missing,readCodexUsage:missing,chooseEngine:()=>({engine:'claude',reason:'stub'}),spawnLongLived:missing,
    loadSealedSegments: () => [],
    createLauncher: () => ({ launch: () => assert.fail('Work in flight never launches an agent.'), installClaudeHooks: () => assert.fail('Nothing installs hooks here.'), hookStatus: async () => ({ claude: { installed: false, current: false } }) }),
    process: { env: {}, resourcesPath: '/private/tmp/synthetic-resources', umask: noop }, Buffer, console, setTimeout, clearTimeout,
  }, { filename: fileURLToPath(sourceURL) });
  await ready; await new Promise(resolve => setImmediate(resolve));
  ctx.app = app;
  ctx.call = (name, ...args) => handlers.get(`summon:${name}`)({ sender: ctx.window.webContents, senderFrame: ctx.window.webContents.mainFrame }, ...args);
  return ctx;
}

test('main wires Work in flight into IPC, the socket service and shutdown', async () => {
  const calls = []; let options; let closes = 0;
  const view = { version: 1, marker: 'synthetic view' };
  const flight = {
    read: async value => { calls.push(['read', plain(value)]); return view; },
    group: value => { calls.push(['group', plain(value)]); return { id: 'job-1', status: 'queued' }; },
    updateSettings: async patch => { calls.push(['settings', plain(patch)]); },
    placePath: id => { calls.push(['placePath', id]); if (id !== 'place-1') throw new Error('That folder is no longer in the scan.'); return '/private/tmp/synthetic-home/Demo'; },
    markStanding: async value => { calls.push(['mark', plain(value)]); },
    close: async () => { closes++; },
  };
  const ctx = await startMain({ createWorkInFlight: async value => { options = value; return flight; } });
  assert.equal(options.dataDir, '/private/tmp/synthetic-summon-data');
  assert.equal(options.homeDir, '/private/tmp/synthetic-home');
  assert.equal(options.git, '/usr/bin/git', 'Falls back to the system git when no other git is found.');
  assert.deepEqual(plain(options.env), { PATH: '/usr/bin', GIT_OPTIONAL_LOCKS: '0' });
  assert.equal(options.run, ctx.missing);
  assert.deepEqual(plain(await options.getProjects()), plain(ctx.state.projects));
  await options.group('codex', { prompt: 'synthetic', schema: {} });
  assert.equal(ctx.groupingCall[0], 'codex');
  assert.deepEqual(plain(ctx.groupingCall[1]), { prompt: 'synthetic', schema: {} });
  assert.equal(ctx.groupingCall[2].run, ctx.missing);
  assert.equal(ctx.groupingCall[2].executable, ctx.missing);
  assert.equal(ctx.groupingCall[2].scrubbedEnv, ctx.scrubbedEnv);
  assert.equal(ctx.rpcOptions.workInFlight, flight);
  assert.equal(calls.length, 0, 'Nothing is scanned or grouped at startup.');

  assert.equal(await ctx.call('work-in-flight'), view);
  assert.deepEqual(calls.pop(), ['read', { maxAgeMs: 20000 }]);
  await ctx.call('work-in-flight', { refresh: true });
  assert.deepEqual(calls.pop(), ['read', { maxAgeMs: 0 }]);
  for (const bad of [{ refresh: 'yes' }, { force: true }, [], 'refresh']) await assert.rejects(ctx.call('work-in-flight', bad), /Invalid request/);

  assert.equal((await ctx.call('work-in-flight-group')).id, 'job-1');
  assert.deepEqual(calls.pop(), ['group', { repoId: null, force: false, reason: 'panel' }]);
  await ctx.call('work-in-flight-group', 'demo', { force: true, reason: 'open' });
  assert.deepEqual(calls.pop(), ['group', { repoId: 'demo', force: true, reason: 'open' }]);
  for (const [repoId, value] of [[null, { reason: 'agent' }], [null, { force: 'yes' }], [7, {}], ['x'.repeat(201), {}], [null, { repoId: 'demo' }]]) await assert.rejects(ctx.call('work-in-flight-group', repoId, value), /Invalid/);

  assert.equal(await ctx.call('work-in-flight-settings', { engine: 'claude' }), view);
  assert.deepEqual(calls.splice(-2), [['settings', { engine: 'claude' }], ['read', { maxAgeMs: 60000 }]]);
  for (const bad of [null, [], 'engine']) await assert.rejects(ctx.call('work-in-flight-settings', bad), /Invalid preferences/);

  await ctx.call('work-in-flight-reveal', 'place-1');
  assert.deepEqual(ctx.shown, ['/private/tmp/synthetic-home/Demo'], 'the folder is shown in Finder, never opened');
  assert.deepEqual(ctx.opened, []);
  for (const kind of ['missing', 'file', 'link']) {
    ctx.entries.set('/private/tmp/synthetic-home/Demo', kind);
    await assert.rejects(ctx.call('work-in-flight-reveal', 'place-1'), /no longer exists/, kind);
  }
  assert.deepEqual(ctx.shown, ['/private/tmp/synthetic-home/Demo']);
  assert.deepEqual(ctx.opened, []);
  await assert.rejects(ctx.call('work-in-flight-reveal', 'place-9'), /no longer in the scan/);
  await assert.rejects(ctx.call('work-in-flight-reveal', 5), /Invalid item/);

  // Where this stands: the shape the panel sends has to be the shape the core takes, and nothing but the panel sends it.
  await ctx.call('work-in-flight-mark', 'demo');
  assert.deepEqual(calls.pop(), ['mark', 'demo'], 'one project is marked by its id');
  await ctx.call('work-in-flight-mark');
  assert.deepEqual(calls.pop(), ['mark', null], 'no id means every project the panel has shown as read');
  await ctx.call('work-in-flight-mark', null);
  assert.deepEqual(calls.pop(), ['mark', null]);
  for (const bad of [5, 'x'.repeat(201), {}, ['demo']]) await assert.rejects(ctx.call('work-in-flight-mark', bad), /Invalid/, String(bad));
  assert.deepEqual(calls.filter(([name]) => name === 'mark'), [], 'a rejected id never reaches the core');
  // An empty string passes the same check Group changes uses; the core is where it is turned down, and the test
  // below proves the real core does turn it down.
  await ctx.call('work-in-flight-mark', '');
  assert.deepEqual(calls.pop(), ['mark', '']);
  await assert.rejects(ctx.handlers.get('summon:work-in-flight-mark')({ sender: {}, senderFrame: {} }), /Untrusted/);

  // Spinning asks which folders have an agent in them. It reads the last session check and never starts one, because
  // it is awaited inside every Work in flight read.
  assert.equal(ctx.sessionReads, 0);
  assert.deepEqual(plain(await options.agentPlaces()), { 'place-1': { working: 2 } });
  assert.equal(ctx.placeCountCalls, 1);
  assert.equal(ctx.sessionReads, 0, 'asking which folders have an agent never starts a session check');
  await assert.rejects(ctx.handlers.get('summon:work-in-flight')({ sender: {}, senderFrame: {} }), /Untrusted/);

  calls.length = 0;
  options.onChange();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [['read', { maxAgeMs: 60000 }]]);
  assert.deepEqual(ctx.sent.filter(([channel]) => channel === 'summon:work-in-flight'), [['summon:work-in-flight', view]]);

  ctx.app.quit();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closes, 1);
  assert.equal(ctx.finalQuits, 1);
  calls.length = 0;
  options.onChange();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [], 'No reads after shutdown starts.');
});

test('Summon still starts when Work in flight cannot load', async () => {
  const ctx = await startMain({ createWorkInFlight: async () => { throw new Error('Synthetic state failure'); } });
  assert.deepEqual(plain(ctx.health.find(value => value.errors?.[0]?.startsWith('Work in flight'))), { errors: ['Work in flight: Synthetic state failure'] });
  assert.equal(ctx.rpcOptions.workInFlight, undefined);
  await assert.rejects(ctx.call('work-in-flight'), /not available/);
  await assert.rejects(ctx.call('work-in-flight-group', null, {}), /not available/);
  ctx.app.quit();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ctx.finalQuits, 1);
});

test('renderTree counts the files inside a new folder and withheld private files', () => {
  const view = fakeView();
  const board = view.repos[1].places[0];
  board.files = [{ path: 'demo/film/', status: 'untracked', staged: false, added: null, removed: null, binary: false, isDir: true, fileCount: 48, private: false }];
  board.grouping.workstreams = [{ ...board.grouping.workstreams[0], title: 'Demo film', files: ['demo/film/'] }, { ...board.grouping.workstreams[0], id: 'ws-4', title: 'Private notes', private: true, files: [], withheldFiles: 2 }];
  const lines = renderTree(view, { now: NOW, timeZone: 'UTC' }).split('\n');
  assert.ok(lines.includes('│  ├─ Demo film  (still in progress · 48 files)'), lines.join('\n'));
  assert.ok(lines.includes('│  └─ Private notes  (private · 2 files)'), lines.join('\n'));
});

test('the CLI header, grouping tip, dates and narrow lines stay truthful', () => {
  const view = fakeView();
  view.totals.reposWithWork = 0;
  view.totals.staleGroupings = 0;
  view.repos = [{ ...view.repos[2], id: 'repo-err', name: 'Broken', status: 'error', headline: 'Could not check this project. boom', error: 'Could not check this project. boom', places: [] }];
  let lines = renderTree(view, { now: NOW, timeZone: 'UTC' }).split('\n');
  assert.equal(lines[0], 'Work in flight · Could not finish checking 1 project');
  assert.equal(lines.some(line => line.includes('All caught up')), false);
  const mixed = fakeView();
  mixed.repos.push({ ...mixed.repos[2], id: 'repo-err', name: 'Broken', status: 'error', headline: 'boom', error: 'boom', places: [] });
  assert.equal(renderTree(mixed, { now: NOW, timeZone: 'UTC' }).split('\n')[0], 'Work in flight · 2 projects have unfinished work · 1 project not checked · 1 grouping out of date');

  // A single-change place cannot be regrouped, so there is no tip for it.
  const single = fakeView();
  single.repos = [single.repos[1]];
  single.repos[0].places = [{ ...single.repos[0].places[0], counts: { staged: 0, unstaged: 1, untracked: 0, conflicted: 0, items: 1 } }];
  assert.equal(renderTree(single, { now: NOW, timeZone: 'UTC' }).includes('Tip: add --group'), false);

  // Dates from another year carry the year, even when they are recent.
  const old = fakeView();
  old.repos[0].branches[1].lastCommitAt = '2025-12-01T10:00:00Z';
  const full = renderTree(old, { now: NOW, timeZone: 'UTC', all: true });
  assert.ok(full.includes('· Dec 1, 2025'), full);

  // At 80 columns the state words stay visible; long branch names are what gets cut.
  const narrow = fakeView();
  narrow.repos[0].places.push({ ...narrow.repos[0].places[1], id: 'place-long', label: 'Claude worktree · upbeat-raman-d96198', branch: 'claude/upbeat-raman-d96198-with-a-much-longer-name', stateWords: ['not saved yet'], counts: { staged: 0, unstaged: 3, untracked: 0, conflicted: 0, items: 3 } });
  lines = renderTree(narrow, { now: NOW, timeZone: 'UTC', width: 80 }).split('\n');
  assert.ok(lines.some(line => line.startsWith('├─ Claude worktree · upbeat-raman-d96198 · not saved yet')), lines.join('\n'));
  assert.ok(lines.some(line => line === '└─ Codex worktree · 7f2a · not saved yet · on main'));
  assert.ok(lines.includes('   Its unsaved changes are all in Main folder too, so they are listed there.'));
  assert.ok(lines.every(line => Array.from(line).length <= 80));
});

test('--json under plain npm run points at npm run -s, and stays valid JSON', async () => {
  const view = fakeView();
  const run = async env => { const out = stream(false); const err = stream(false); assert.equal(await runCli(['--json'], { call: async () => view, stdout: out, stderr: err, env }), 0); return { out, err }; };
  const plainNpm = await run({ npm_lifecycle_event: 'flight' });
  assert.deepEqual(JSON.parse(plainNpm.out.text), view);
  assert.match(plainNpm.err.text, /npm run -s flight -- --json/);
  assert.equal((await run({ npm_lifecycle_event: 'flight', npm_config_loglevel: 'silent' })).err.text, '');
  assert.equal((await run({})).err.text, '');
  const out = stream(false);
  await runCli(['--help'], { call: async () => view, stdout: out, stderr: stream(false) });
  assert.match(out.text, /npm run -s flight -- --json/);
});

// A child process imports the MCP adapter with stdin closed, so its stdio loop ends at once.
function mcpChild(script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
    child.on('close', code => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err || `exit ${code}`))));
  });
}
const MCP_URL = new URL('../scripts/mcp-server.mjs', import.meta.url).href;

test('socket clients refuse foreign paths and stop a slow-drip server at their deadline', async t => {
  const dir = await mkdtemp('/tmp/summon-wif-drip-');
  const socketPath = path.join(dir, 'drip.sock');
  const timers = new Set();
  const server = net.createServer(socket => { const timer = setInterval(() => socket.write(' '), 50); timers.add(timer); socket.on('error', () => {}); socket.on('close', () => clearInterval(timer)); });
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(async () => { for (const timer of timers) clearInterval(timer); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  let started = Date.now();
  await assert.rejects(cliRpc({ method: 'work-in-flight' }, { path: socketPath, timeoutMs: 300 }), /did not answer in time/);
  const cliElapsed = Date.now() - started;
  assert.ok(cliElapsed >= 550 && cliElapsed < 2500, `CLI stopped after ${cliElapsed} ms`);
  const script = `import { rpc } from ${JSON.stringify(MCP_URL)}; const started = Date.now(); let message = ''; try { await rpc({ method: 'context' }, 300); } catch (error) { message = error.message; } console.log(JSON.stringify({ message, elapsed: Date.now() - started }));`;
  const mcp = await mcpChild(script, { SUMMON_SOCKET: socketPath });
  assert.match(mcp.message, /did not answer in time/);
  assert.ok(mcp.elapsed >= 550 && mcp.elapsed < 2500, `MCP stopped after ${mcp.elapsed} ms`);
  // A regular file at the socket path is not Summon.
  const fake = path.join(dir, 'not-a-socket.sock');
  await writeFile(fake, '');
  started = Date.now();
  await assert.rejects(cliRpc({ method: 'work-in-flight' }, { path: fake, timeoutMs: 300 }), error => error.code === 'NOT_RUNNING');
  const offline = await mcpChild(`import { rpc } from ${JSON.stringify(MCP_URL)}; let message = ''; try { await rpc({ method: 'context' }, 300); } catch (error) { message = error.message; } console.log(JSON.stringify({ message }));`, { SUMMON_SOCKET: fake });
  assert.equal(offline.message, 'Open the Summon app to access your shared computer context.');
});

test('the MCP adapter decodes answers split inside a multi-byte character', async t => {
  const dir = await mkdtemp('/tmp/summon-wif-utf8-');
  const socketPath = path.join(dir, 's.sock');
  const result = { currentProject: { name: 'Hackathon — API World 2026', path: '~/Projects/Hackathon — API World 2026' }, projects: [], note: 'Résumé — ·'.repeat(50) };
  const payload = Buffer.from(`${JSON.stringify({ result })}\n`);
  const cut = payload.indexOf(Buffer.from('—')) + 1;
  const server = net.createServer(socket => { socket.on('data', () => { socket.write(payload.subarray(0, cut)); setTimeout(() => socket.end(payload.subarray(cut)), 30); }); socket.on('error', () => {}); });
  await new Promise(resolve => server.listen(socketPath, resolve));
  const child = spawn(process.execPath, [path.join(root, 'scripts/mcp-server.mjs')], { env: { ...process.env, SUMMON_SOCKET: socketPath }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(async () => { child.kill(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const answer = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('no MCP answer')), 5000);
    child.stdout.on('data', chunk => { buffer += chunk; if (buffer.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(buffer.slice(0, buffer.indexOf('\n')))); } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_working_context', arguments: {} } })}\n`);
  });
  const text = answer.result.content[0].text;
  assert.equal(text.includes('�'), false);
  assert.equal(text, JSON.stringify(result));
});

function bigView(repoCount = 13, { fileCount = 200, branchCount = 30 } = {}) {
  const base = fakeView();
  const repos = Array.from({ length: repoCount }, (_, n) => {
    const repo = structuredClone(base.repos[0]);
    repo.id = `repo-${n}`; repo.name = `Project ${n}`; repo.path = `/private/tmp/synthetic-home/Projects/Project ${n}`;
    const files = Array.from({ length: fileCount }, (_, i) => `src/module-${n}/file-${String(i).padStart(3, '0')}.ts`);
    repo.places[0].files = files.map(file => ({ path: file, status: 'modified', staged: false, added: 1, removed: 1, binary: false, isDir: false, fileCount: null, private: false }));
    repo.places[0].grouping.workstreams = Array.from({ length: 4 }, (_, w) => ({ id: `ws-${n}-${w}`, title: `Workstream ${w} for project ${n}`, summary: 'A synthetic summary that says what the work does and whether it looks finished.', area: 'product', readiness: 'in-progress', files, sharedFiles: files.slice(0, 20), added: 200, removed: 200, suggestedCommit: 'feat: synthetic', private: false }));
    repo.branches = Array.from({ length: branchCount }, (_, b) => ({ name: `feature/branch-${n}-${b}`, tip: 'abcdef12', subject: `Synthetic commit subject number ${b}`, lastCommitAt: '2026-09-15T10:00:00Z', upstream: null, upstreamGone: false, ahead: null, behind: null, aheadOfBase: b % 3, behindBase: 0, placeId: null, merged: b % 3 === 0, stateWords: ['1 commit not in main'], summary: null, summaryStale: false, topPaths: ['src/a.ts', 'src/b.ts'] }));
    return repo;
  });
  return { ...base, repos };
}

test('the work_in_flight tool answers within agent limits and only one project gets file lists', async t => {
  const dir = await mkdtemp('/tmp/summon-wif-size-');
  const socketPath = path.join(dir, 's.sock');
  let view = bigView();
  const reads = [];
  const workInFlight = { read: async options => { reads.push(options); return options.projectId ? { ...view, repos: view.repos.filter(repo => repo.id === options.projectId) } : view; }, group: () => ({}) };
  const close = await createRpcServer({ snapshot: () => ({ projects: [], events: [], files: [], settings: {}, health: {} }) }, socketPath, { workInFlight });
  const child = spawn(process.execPath, [path.join(root, 'scripts/mcp-server.mjs')], { env: { ...process.env, SUMMON_SOCKET: socketPath }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(async () => { child.kill(); await close(); await rm(dir, { recursive: true, force: true }); });
  let buffer = ''; let next = 0; const pending = new Map();
  child.stdout.on('data', chunk => { buffer += chunk; while (buffer.includes('\n')) { const line = buffer.slice(0, buffer.indexOf('\n')); buffer = buffer.slice(buffer.indexOf('\n') + 1); const message = JSON.parse(line); pending.get(message.id)?.(message); } });
  const call = args => new Promise(resolve => { const id = ++next; pending.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'work_in_flight', arguments: args } })}\n`); }).then(message => message.result);

  const raw = JSON.stringify(view);
  assert.ok(Buffer.byteLength(raw) > 400_000, 'the synthetic view is far over budget');
  let result = await call({});
  let text = result.content[0].text;
  assert.ok(Buffer.byteLength(text) <= 36_000, `default answer is ${Buffer.byteLength(text)} bytes`);
  let parsed = JSON.parse(text);
  assert.deepEqual(parsed.repos.map(repo => repo.id), view.repos.map(repo => repo.id));
  for (const key of ['"topPaths"', '"files"', '"sharedFiles"', '"path"']) assert.equal(text.includes(key), false, key);
  if (!parsed.truncated) assert.ok(parsed.repos.every(repo => repo.status === 'clean' || repo.mergedBranches > 0));
  // Far too many projects: just ids and headlines, with a pointer to projectId.
  view = bigView(150, { fileCount: 2, branchCount: 6 });
  result = await call({});
  parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.truncated, true);
  assert.match(parsed.note, /projectId/);
  assert.deepEqual(parsed.repos.map(repo => repo.id), view.repos.map(repo => repo.id));
  assert.ok(Buffer.byteLength(result.content[0].text) <= 36_000);
  assert.ok(parsed.repos.every(repo => Object.keys(repo).length <= 4));
  // A moderate view keeps workstreams and open branches with merged counts.
  view = bigView(2);
  parsed = JSON.parse((await call({})).content[0].text);
  assert.equal(parsed.truncated, undefined);
  assert.equal(parsed.repos[0].mergedBranches, 10);
  assert.equal(parsed.repos[0].branches.length, 20);
  assert.equal(parsed.repos[0].places[0].grouping.workstreams[0].fileCount, 200);
  assert.equal(parsed.repos[0].places[2].mirrorOf, undefined);
  // includeFiles needs a projectId; with one, the file list is capped to fit.
  const before = reads.length;
  result = await call({ includeFiles: true });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /includeFiles needs a projectId/);
  assert.equal(reads.length, before);
  view = bigView();
  result = await call({ projectId: 'repo-3', includeFiles: true });
  text = result.content[0].text;
  assert.ok(Buffer.byteLength(text) <= 36_000, `detail answer is ${Buffer.byteLength(text)} bytes`);
  parsed = JSON.parse(text);
  assert.deepEqual(parsed.repos.map(repo => repo.id), ['repo-3']);
  assert.equal(parsed.repos[0].places[0].filesTruncated, true);
  assert.ok(parsed.repos[0].places[0].files.length > 0);
  // The local CLI (privateNames) still receives the full, unchanged view.
  const full = await new Promise(resolve => { const socket = net.connect(socketPath); const chunks = []; socket.on('connect', () => socket.write(`${JSON.stringify({ method: 'work-in-flight', privateNames: true, includeFiles: true })}\n`)); socket.on('data', chunk => chunks.push(chunk)); socket.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))); });
  assert.deepEqual(full.result, plain(view));
});
