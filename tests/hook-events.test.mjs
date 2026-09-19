import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHookLedger, hookActivity } from '../src/core/hook-events.mjs';

// The ledger behind "sessions report through hooks". Everything here is fabricated; SECRET marks text that must never land in the file.
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const START = 1_800_000_000_000;
const U = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ENTRY_KEYS = ['app', 'sessionId', 'launch', 'cwd', 'state', 'reason', 'stateAt', 'event', 'kind', 'toolName', 'eventAt', 'firstAt', 'events'].sort();
const SECRET = 'SECRET-PROMPT-TEXT';

async function ledger(t, extra = {}) {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'summon-hooks-')));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const clock = { at: START };
  const led = await createHookLedger({ dataDir, now: () => clock.at, ...extra });
  return { dataDir, led, clock, file: path.join(dataDir, 'hook-events.json') };
}
const claude = (sessionId, event, extra = {}) => ({ app: 'claude', event, sessionId, cwd: '/Users/someone/Projects/Demo', toolName: null, kind: null, launch: null, ...extra });

test('hookActivity maps every subscribed event to a state word, and unknown kinds to nothing', () => {
  const cases = [
    ['claude', 'SessionStart', null, 'open', null], ['claude', 'SessionStart', 'startup', 'open', null], ['claude', 'SessionStart', 'resume', 'open', null], ['claude', 'SessionStart', 'clear', 'open', null], ['claude', 'UserPromptSubmit', null, 'working', null], ['claude', 'PreToolUse', null, 'working', null],
    ['claude', 'PostToolUse', null, 'working', null], ['claude', 'PostToolUseFailure', null, 'working', null], ['claude', 'PermissionDenied', null, 'working', null],
    ['claude', 'SubagentStart', null, 'working', null], ['claude', 'SubagentStop', null, 'working', null], ['claude', 'PreCompact', null, 'working', null], ['claude', 'PostCompact', null, 'working', null],
    ['claude', 'PermissionRequest', null, 'needs-you', 'Waiting for your OK'],
    ['claude', 'Notification', 'permission_prompt', 'needs-you', 'Waiting for your OK'], ['claude', 'Notification', 'worker_permission_prompt', 'needs-you', 'Waiting for your OK'],
    ['claude', 'Notification', 'agent_needs_input', 'needs-you', 'Asked you a question'], ['claude', 'Notification', 'elicitation_dialog', 'needs-you', 'Asked you a question'],
    ['claude', 'Notification', 'elicitation_url_dialog', 'needs-you', 'Asked you a question'], ['claude', 'Notification', 'idle_prompt', 'open', null],
    ['claude', 'Stop', null, 'open', null], ['claude', 'StopFailure', null, 'failed', 'Stopped with a problem'], ['claude', 'SessionEnd', null, 'ended', null],
    ['codex', 'agent-turn-complete', null, 'open', null], ['codex', 'UserPromptSubmit', null, 'working', null], ['codex', 'Stop', null, 'open', null], ['codex', 'SessionEnd', null, 'ended', null],
  ];
  for (const [app, event, kind, state, reason] of cases) assert.deepEqual(hookActivity(app, event, kind), { state, reason }, `${app} ${event} ${kind}`);
  for (const [app, event, kind] of [['claude', 'SessionStart', 'compact'], ['claude', 'Notification', 'auth_success'], ['claude', 'Notification', 'agent_completed'], ['claude', 'MessageDisplay', null], ['codex', 'PreToolUse', null], ['cursor', 'Stop', null]]) {
    assert.equal(hookActivity(app, event, kind), null, `${app} ${event} ${kind}`);
  }
});

test('record keeps exactly the entry fields, and nothing from a payload that carries prompt or transcript text', async t => {
  const { led, clock, file } = await ledger(t);
  const entry = led.record(claude(U(1), 'PreToolUse', { toolName: 'Edit', prompt: SECRET, tool_input: { file_path: SECRET }, transcript_path: `/x/${SECRET}.jsonl`, last_assistant_message: SECRET }));
  assert.deepEqual(Object.keys(entry).sort(), ENTRY_KEYS);
  assert.deepEqual(entry, { app: 'claude', sessionId: U(1), launch: null, cwd: '/Users/someone/Projects/Demo', state: 'working', reason: null, stateAt: START, event: 'PreToolUse', kind: null, toolName: 'Edit', eventAt: START, firstAt: START, events: 1 });
  clock.at += MIN;
  // A Notification of a kind that says nothing about the state updates the event fields only.
  const later = led.record(claude(U(1), 'Notification', { kind: 'auth_success' }));
  assert.equal(later.state, 'working');
  assert.equal(later.stateAt, START);
  assert.equal(later.event, 'Notification');
  assert.equal(later.kind, 'auth_success');
  assert.equal(later.toolName, null);
  assert.equal(later.eventAt, START + MIN);
  assert.equal(later.events, 2);
  clock.at += MIN;
  const asked = led.record(claude(U(1), 'Notification', { kind: 'agent_needs_input' }));
  assert.deepEqual([asked.state, asked.reason, asked.stateAt], ['needs-you', 'Asked you a question', START + 2 * MIN]);
  const ended = led.record(claude(U(1), 'SessionEnd', { kind: 'other' }));
  assert.equal(ended.state, 'ended');
  await led.flush();
  const text = await fs.readFile(file, 'utf8');
  assert.ok(!text.includes('SECRET'), 'nothing from the payload beyond the known fields reaches the file');
  const parsed = JSON.parse(text);
  assert.deepEqual(Object.keys(parsed).sort(), ['launches', 'sessions', 'version']);
  assert.deepEqual(Object.keys(parsed.sessions[`claude:${U(1)}`]).sort(), ENTRY_KEYS);
  // Untrusted fields are checked, not trusted: a relative cwd, an odd kind and a long tool name are cut or dropped.
  const odd = led.record(claude(U(2), 'PostToolUse', { cwd: 'relative/dir', kind: 'has space', toolName: 'x'.repeat(500) }));
  assert.equal(odd.cwd, null);
  assert.equal(odd.kind, null);
  assert.equal(odd.toolName.length, 120);
  for (const bad of [{ app: 'cursor' }, { sessionId: 'served:x' }, { event: '' }]) assert.throws(() => led.record(claude(U(3), 'Stop', bad)), /Invalid hook|Unknown hook/, JSON.stringify(bad));
  assert.equal(led.forApp('claude').size, 2);
  assert.equal(led.forApp('codex').size, 0);
});

test('a Claude launch has its entry up front; a Codex launch binds to the first reported turn', async t => {
  const { led, clock } = await ledger(t);
  const tag = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const launch = led.noteLaunch({ app: 'claude', tag, cwd: '/Users/someone/Projects/Demo', projectId: 'project-1', sessionId: U(10) });
  assert.deepEqual(launch, { app: 'claude', cwd: '/Users/someone/Projects/Demo', projectId: 'project-1', at: START, sessionId: U(10) });
  const early = led.forApp('claude').get(U(10));
  assert.deepEqual([early.state, early.launch, early.cwd, early.events], [null, tag, '/Users/someone/Projects/Demo', 0]);
  clock.at += MIN;
  led.record(claude(U(10), 'SessionStart', { kind: 'startup' }));
  assert.deepEqual([led.forApp('claude').get(U(10)).state, led.forApp('claude').get(U(10)).launch], ['open', tag]);

  const codexTag = '01234567-89ab-4cde-8f01-23456789abcd';
  led.noteLaunch({ app: 'codex', tag: codexTag, cwd: '/Users/someone/Projects/Demo', projectId: 'project-1', sessionId: null });
  assert.equal(led.forApp('codex').size, 0, 'Codex cannot pre-assign a thread id, so nothing is listed yet.');
  assert.equal(led.launch(codexTag).sessionId, null);
  led.record({ app: 'codex', event: 'agent-turn-complete', sessionId: U(20), cwd: '/Users/someone/Projects/Demo', toolName: null, kind: null, launch: codexTag });
  assert.equal(led.launch(codexTag).sessionId, U(20));
  assert.deepEqual([led.forApp('codex').get(U(20)).state, led.forApp('codex').get(U(20)).launch], ['open', codexTag]);
  // A second thread naming the same tag does not steal it, and an unknown tag names nothing.
  led.record({ app: 'codex', event: 'agent-turn-complete', sessionId: U(21), cwd: null, toolName: null, kind: null, launch: codexTag });
  assert.equal(led.forApp('codex').get(U(21)).launch, null);
  led.record({ app: 'codex', event: 'agent-turn-complete', sessionId: U(22), cwd: null, toolName: null, kind: null, launch: 'ffffffff-0000-4000-8000-000000000000' });
  assert.equal(led.forApp('codex').get(U(22)).launch, null);
  assert.equal(led.launch('not a tag'), null);
  assert.throws(() => led.noteLaunch({ app: 'claude', tag: 'x', sessionId: U(1) }), /Invalid launch tag/);
  assert.throws(() => led.noteLaunch({ app: 'hermes', tag }), /Invalid launch app/);
});

test('retention: seven days, a session cap, a launch cap, unbound launches for a day, and the file size', async t => {
  const { led, clock } = await ledger(t, { limits: { sessions: 3, launches: 2 } });
  led.record(claude(U(1), 'Stop'));
  clock.at += 8 * DAY;
  led.record(claude(U(2), 'Stop'));
  assert.deepEqual([...led.forApp('claude').keys()], [U(2)], 'sessions older than seven days are dropped on the next write');
  led.record(claude(U(3), 'Stop'));
  clock.at += MIN;
  led.record(claude(U(4), 'Stop'));
  clock.at += MIN;
  led.record(claude(U(5), 'Stop'));
  assert.deepEqual([...led.forApp('claude').keys()].sort(), [U(3), U(4), U(5)], 'the oldest session goes first when the cap is hit');
  const tags = ['aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000003'];
  led.noteLaunch({ app: 'codex', tag: tags[0], sessionId: null });
  clock.at += MIN;
  led.noteLaunch({ app: 'codex', tag: tags[1], sessionId: null });
  clock.at += MIN;
  led.noteLaunch({ app: 'codex', tag: tags[2], sessionId: null });
  assert.deepEqual([led.launch(tags[0]), Boolean(led.launch(tags[1])), Boolean(led.launch(tags[2]))], [null, true, true], 'at most two launches');
  clock.at += 25 * HOUR;
  led.record(claude(U(6), 'Stop'));
  assert.deepEqual([led.launch(tags[1]), led.launch(tags[2])], [null, null], 'an unbound launch is forgotten after a day');
  const bound = 'bbbbbbbb-0000-4000-8000-000000000001';
  led.noteLaunch({ app: 'claude', tag: bound, sessionId: U(7) });
  clock.at += 2 * DAY;
  led.record(claude(U(7), 'Stop'));
  assert.ok(led.launch(bound), 'a bound launch stays for seven days');
  clock.at += 6 * DAY;
  led.record(claude(U(8), 'Stop'));
  assert.equal(led.launch(bound), null);

  const small = await ledger(t, { limits: { fileBytes: 1400 } });
  for (let i = 1; i <= 12; i++) { small.clock.at += MIN; small.led.record(claude(U(100 + i), 'PreToolUse', { toolName: 'Bash' })); }
  await small.led.flush();
  const size = (await fs.stat(small.file)).size;
  assert.ok(size <= 1400, `file stays under the cap (${size})`);
  const kept = [...small.led.forApp('claude').keys()];
  assert.ok(kept.length >= 1 && kept.length < 12);
  assert.ok(kept.includes(U(112)), 'the newest session survives');
  assert.ok(!kept.includes(U(101)), 'the oldest goes first');
});

test('the file is private, written atomically after a short debounce, flushed on close, and reloaded', async t => {
  const { led, dataDir, file, clock } = await ledger(t, { limits: { debounceMs: 50 } });
  led.record(claude(U(1), 'PermissionRequest', { toolName: 'Bash' }));
  await assert.rejects(fs.stat(file), /ENOENT/, 'nothing is written on the event itself');
  await new Promise(resolve => setTimeout(resolve, 150));
  const info = await fs.stat(file);
  assert.equal(info.mode & 0o777, 0o600);
  assert.deepEqual((await fs.readdir(dataDir)).filter(name => name.includes('tmp')), [], 'no temp file is left behind');
  clock.at += MIN;
  led.record(claude(U(1), 'PostToolUse', { toolName: 'Bash' }));
  await led.close();
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(saved.sessions[`claude:${U(1)}`].state, 'working');
  assert.equal(saved.sessions[`claude:${U(1)}`].events, 2);
  assert.throws(() => led.record(claude(U(1), 'Stop')), /closing/);

  const again = await createHookLedger({ dataDir, now: () => clock.at });
  assert.deepEqual(again.forApp('claude').get(U(1)).state, 'working');
  assert.equal(again.snapshot().problem, null);
  await again.close();
});

test('an unreadable file is kept as .corrupt-* and the ledger starts empty', async t => {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'summon-hooks-')));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dataDir, 'hook-events.json'), '{ not json');
  const led = await createHookLedger({ dataDir });
  assert.equal(led.forApp('claude').size, 0);
  assert.match(led.snapshot().problem, /could not be read \(kept as hook-events\.json\.corrupt-/);
  const names = await fs.readdir(dataDir);
  assert.equal(names.filter(name => name.startsWith('hook-events.json.corrupt-')).length, 1);
  assert.ok(!names.includes('hook-events.json'));
  // Entries of the wrong shape inside a readable file are dropped one by one, not the whole file.
  await led.close();
  await fs.writeFile(path.join(dataDir, 'hook-events.json'), JSON.stringify({ version: 1, sessions: { good: { app: 'claude', sessionId: U(1), eventAt: START, state: 'open' }, bad: { app: 'claude', sessionId: 'served:x', eventAt: START }, worse: 'text' }, launches: { 'not a tag': { app: 'claude', at: START } } }));
  const mixed = await createHookLedger({ dataDir, now: () => START + MIN });
  assert.deepEqual([...mixed.forApp('claude').keys()], [U(1)]);
  assert.equal(mixed.snapshot().problem, null);
  await assert.rejects(createHookLedger({ dataDir: 'relative' }), /full data folder path/);
  await mixed.close();
});
