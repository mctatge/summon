import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

// scripts/summon-hook.mjs against a tiny fake of Summon's socket. Every payload here is fabricated; SECRET marks text
// that must never leave the reporter.
const SCRIPT = new URL('../scripts/summon-hook.mjs', import.meta.url).pathname;
const SECRET = 'SECRET-PROMPT-TEXT';
const SESSION = '0d31ac07-8c02-44b4-ac34-e2591a5d55cc';
const THREAD = '01a0baed-cacd-7980-9cda-e7184a61ca67';
const KEYS = ['method', 'v', 'app', 'event', 'sessionId', 'cwd', 'toolName', 'kind', 'launch'];

function run(args, { stdin = '', env = {} } = {}) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('close', code => resolve({ code, out, err, ms: Date.now() - started }));
    // The reporter closes its stdin once it has read enough, so a large write can see EPIPE.
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}
async function server(dir, { answer = true } = {}) {
  const lines = [];
  const socketPath = path.join(dir, 's.sock');
  const srv = net.createServer(socket => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      lines.push(buffer.slice(0, buffer.indexOf('\n')));
      if (answer) socket.end('{"result":{"accepted":true}}\n');
    });
    socket.on('error', () => {});
  });
  await new Promise(resolve => srv.listen(socketPath, resolve));
  return { socketPath, lines, close: () => new Promise(resolve => srv.close(resolve)) };
}
const claudeInput = (event, extra = {}) => JSON.stringify({
  session_id: SESSION, transcript_path: `/Users/x/.claude/projects/y/${SESSION}.jsonl`, cwd: '/Users/x/Projects/Y', hook_event_name: event, permission_mode: 'default',
  prompt: SECRET, tool_input: { command: SECRET }, tool_response: { output: SECRET }, last_assistant_message: SECRET, message: SECRET, title: SECRET, session_title: SECRET, ...extra,
});

test('Claude child start, tools and stop forward identity but never child transcript or response', async t => {
  const dir = await mkdtemp('/tmp/summon-hook-child-');
  const fake = await server(dir);
  t.after(async () => { await fake.close(); await rm(dir, { recursive: true, force: true }); });
  const env = { SUMMON_SOCKET: fake.socketPath };
  for (const event of ['SubagentStart', 'PreToolUse', 'SubagentStop']) {
    await run(['claude'], { env, stdin: claudeInput(event, { agent_id: 'a12-helper', agent_type: 'Explore', tool_name: 'Read', agent_transcript_path: `/private/${SECRET}.jsonl` }) });
  }
  assert.equal(fake.lines.length, 3);
  for (const line of fake.lines) {
    const row = JSON.parse(line);
    assert.equal(row.agentId, 'a12-helper'); assert.equal(row.agentType, 'Explore');
    assert.ok(!line.includes(SECRET)); assert.ok(!line.includes('agent_transcript_path'));
  }
  await run(['claude'], { env, stdin: claudeInput('SubagentStart', { agent_id: '../secret' }) });
  assert.equal(fake.lines.length, 3);
  await run(['claude'], { env, stdin: claudeInput('SubagentStart', { agent_id: 'valid-custom', agent_type: 'SECRET custom instructions' }) });
  assert.equal(JSON.parse(fake.lines[3]).agentId, 'valid-custom');
  assert.equal(JSON.parse(fake.lines[3]).agentType, undefined);
});

test('Claude events cross as one line with only the known fields, and never the prompt, tool input or transcript path', async t => {
  const dir = await mkdtemp('/tmp/summon-hook-');
  const fake = await server(dir);
  t.after(async () => { await fake.close(); await rm(dir, { recursive: true, force: true }); });
  const env = { SUMMON_SOCKET: fake.socketPath };
  const pre = await run(['claude'], { stdin: claudeInput('PreToolUse', { tool_name: 'Edit', tool_use_id: 'toolu_1' }), env });
  assert.deepEqual([pre.code, pre.out, pre.err], [0, '', '']);
  assert.equal(fake.lines.length, 1);
  const sent = JSON.parse(fake.lines[0]);
  assert.deepEqual(Object.keys(sent), KEYS);
  assert.deepEqual(sent, { method: 'hook', v: 1, app: 'claude', event: 'PreToolUse', sessionId: SESSION, cwd: '/Users/x/Projects/Y', toolName: 'Edit', kind: null, launch: null });
  assert.ok(!fake.lines[0].includes('SECRET'));
  assert.ok(!fake.lines[0].includes('.jsonl'));

  await run(['claude'], { stdin: claudeInput('Notification', { notification_type: 'permission_prompt' }), env });
  await run(['claude'], { stdin: claudeInput('SessionStart', { source: 'startup', tool_name: 'ignored' }), env });
  await run(['claude'], { stdin: claudeInput('SessionEnd', { reason: 'other' }), env });
  await run(['claude'], { stdin: claudeInput('Stop', { stop_hook_active: false }), env });
  const kinds = fake.lines.slice(1).map(line => JSON.parse(line));
  assert.deepEqual(kinds.map(item => [item.event, item.kind, item.toolName]), [['Notification', 'permission_prompt', null], ['SessionStart', 'startup', null], ['SessionEnd', 'other', null], ['Stop', null, null]]);
  for (const line of fake.lines) { assert.ok(line.length < 4096); assert.ok(!line.includes('SECRET')); }
});

test('Codex notify payloads cross with the launch tag, and only agent-turn-complete is forwarded', async t => {
  const dir = await mkdtemp('/tmp/summon-hook-');
  const fake = await server(dir);
  t.after(async () => { await fake.close(); await rm(dir, { recursive: true, force: true }); });
  const env = { SUMMON_SOCKET: fake.socketPath };
  const payload = JSON.stringify({ type: 'agent-turn-complete', 'thread-id': THREAD, 'turn-id': '01a0baed-0000-7000-8000-000000000001', cwd: '/Users/x/Projects/Y', client: 'codex_exec', 'input-messages': [SECRET], 'last-assistant-message': SECRET });
  const done = await run(['codex', '--launch', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', payload], { env });
  assert.deepEqual([done.code, done.out, done.err], [0, '', '']);
  assert.equal(fake.lines.length, 1);
  assert.deepEqual(JSON.parse(fake.lines[0]), { method: 'hook', v: 1, app: 'codex', event: 'agent-turn-complete', sessionId: THREAD, cwd: '/Users/x/Projects/Y', toolName: null, kind: null, launch: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
  assert.ok(!fake.lines[0].includes('SECRET'));
  assert.ok(!fake.lines[0].includes('turn-id'));
  const other = await run(['codex', JSON.stringify({ type: 'something-else', 'thread-id': THREAD })], { env });
  assert.deepEqual([other.code, other.out, other.err], [0, '', '']);
  const noTag = await run(['codex', payload], { env });
  assert.equal(noTag.code, 0);
  assert.equal(fake.lines.length, 2);
  assert.equal(JSON.parse(fake.lines[1]).launch, null);
});

test('a served session id, a malformed payload or an unknown app send nothing and exit 0 quietly', async t => {
  const dir = await mkdtemp('/tmp/summon-hook-');
  const fake = await server(dir);
  t.after(async () => { await fake.close(); await rm(dir, { recursive: true, force: true }); });
  const env = { SUMMON_SOCKET: fake.socketPath };
  for (const [args, stdin] of [
    [['claude'], claudeInput('Stop', { session_id: 'served:abc' })],
    [['claude'], claudeInput('Stop', { session_id: '../../etc/passwd' })],
    [['claude'], '{ not json'],
    [['claude'], ''],
    [['claude'], '[1,2,3]'],
    [['codex', 'not json'], ''],
    [['codex'], ''],
    [['cursor'], claudeInput('Stop')],
    [[], claudeInput('Stop')],
  ]) {
    const result = await run(args, { stdin, env });
    assert.deepEqual([result.code, result.out, result.err], [0, '', ''], JSON.stringify(args));
  }
  assert.equal(fake.lines.length, 0);
  // A large payload (PostToolUse carries whole tool outputs) is still forwarded, with only the allowed keys.
  const large = await run(['claude'], { stdin: claudeInput('Stop', { prompt: 'x'.repeat(400_000) }), env });
  assert.deepEqual([large.code, large.out, large.err], [0, '', '']);
  assert.equal(fake.lines.length, 1);
  assert.ok(!fake.lines[0].includes('xxxx'), 'prompt text never reaches the socket');
  assert.ok(fake.lines[0].length < 2000, 'the forwarded line stays small');
  // Stdin over the 8 MiB cap is dropped outright, never parsed from a cut buffer.
  const huge = await run(['claude'], { stdin: claudeInput('Stop', { prompt: 'x'.repeat(9 * 1024 * 1024) }), env });
  assert.deepEqual([huge.code, huge.out, huge.err], [0, '', '']);
  assert.equal(fake.lines.length, 1);
});

test('no socket, a file where the socket should be, or a server that never answers all exit 0 within 1.5 s', async t => {
  const dir = await mkdtemp('/tmp/summon-hook-');
  const silent = await server(dir, { answer: false });
  t.after(async () => { await silent.close(); await rm(dir, { recursive: true, force: true }); });
  const stdin = claudeInput('Stop');
  const missing = await run(['claude'], { stdin, env: { SUMMON_SOCKET: path.join(dir, 'nowhere.sock') } });
  assert.deepEqual([missing.code, missing.out, missing.err], [0, '', '']);
  assert.ok(missing.ms < 1500, `missing socket: ${missing.ms} ms`);
  await writeFile(path.join(dir, 'file.sock'), 'not a socket');
  const file = await run(['claude'], { stdin, env: { SUMMON_SOCKET: path.join(dir, 'file.sock') } });
  assert.deepEqual([file.code, file.out, file.err], [0, '', '']);
  assert.ok(file.ms < 1500, `plain file: ${file.ms} ms`);
  const quiet = await run(['claude'], { stdin, env: { SUMMON_SOCKET: silent.socketPath } });
  assert.deepEqual([quiet.code, quiet.out, quiet.err], [0, '', '']);
  assert.ok(quiet.ms < 1500, `silent server: ${quiet.ms} ms`);
  assert.equal(silent.lines.length, 1, 'the line was still written before the wait gave up');
});
