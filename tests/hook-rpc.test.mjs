import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { createRpcServer, normalizeHook } from '../src/main/rpc.mjs';

// The socket's `hook` method: what scripts/summon-hook.mjs sends, validated field by field before it reaches the ledger.
const SESSION = '0d31ac07-8c02-44b4-ac34-e2591a5d55cc';
const plain = value => JSON.parse(JSON.stringify(value));
const raw = (socketPath, line) => new Promise((resolve, reject) => {
  const socket = net.connect(socketPath); const chunks = [];
  socket.on('connect', () => socket.write(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`));
  socket.on('data', chunk => chunks.push(chunk)); socket.on('error', reject);
  socket.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
});
const service = { snapshot: () => ({ projects: [], events: [], files: [], settings: {}, health: {}, currentProjectId: null, activity: null }) };
const event = (extra = {}) => ({ method: 'hook', v: 1, app: 'claude', event: 'PreToolUse', sessionId: SESSION, cwd: '/Users/x/Projects/Y', toolName: 'Edit', kind: null, launch: null, ...extra });

test('accepted hook events reach noteHook with exactly the normalized fields and re-arm the count once', async t => {
  const dir = await mkdtemp('/tmp/summon-hook-rpc-');
  const socketPath = path.join(dir, 's.sock');
  const calls = []; let hooks = 0;
  const agentSessions = { noteHook: async value => { calls.push(plain(value)); return { accepted: true }; }, read: () => assert.fail('A hook never reads.'), openTarget: () => assert.fail('A hook never opens.') };
  const close = await createRpcServer(service, socketPath, { agentSessions, onHook: () => { hooks++; }, onChange: () => assert.fail('A hook is not a memory change.') });
  t.after(async () => { await close(); await rm(dir, { recursive: true, force: true }); });

  assert.deepEqual(await raw(socketPath, event()), { result: { accepted: true } });
  assert.deepEqual(calls, [{ app: 'claude', event: 'PreToolUse', sessionId: SESSION, cwd: '/Users/x/Projects/Y', toolName: 'Edit', kind: null, launch: null }]);
  assert.equal(hooks, 1);
  // Normalization: an upper-case id is lowered, a relative or odd cwd becomes null, a long tool name is cut, control characters go.
  await raw(socketPath, event({ sessionId: SESSION.toUpperCase(), cwd: 'Projects/Y', toolName: `${'t'.repeat(200)}${String.fromCharCode(0x202e)}x`, kind: 'permission_prompt', launch: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', event: 'Notification' }));
  assert.equal(calls[1].sessionId, SESSION);
  assert.equal(calls[1].cwd, null);
  assert.equal(calls[1].toolName.length, 120);
  assert.ok(!calls[1].toolName.includes(String.fromCharCode(0x202e)));
  assert.deepEqual([calls[1].kind, calls[1].launch, calls[1].event], ['permission_prompt', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'Notification']);
  await raw(socketPath, event({ cwd: '/Users/x/../y', kind: 'has space', launch: 'nope', toolName: 5 }));
  assert.deepEqual([calls[2].cwd, calls[2].kind, calls[2].launch, calls[2].toolName], [null, null, null, null]);
  await raw(socketPath, event({ app: 'codex', event: 'agent-turn-complete', toolName: null, sessionId: '01a0baed-cacd-7980-9cda-e7184a61ca67' }));
  assert.equal(calls[3].app, 'codex');
  assert.equal(hooks, 4);
});

test('malformed hook events are refused before anything is stored', async t => {
  const dir = await mkdtemp('/tmp/summon-hook-rpc-');
  const socketPath = path.join(dir, 's.sock');
  const calls = []; let hooks = 0;
  const agentSessions = { noteHook: async value => { calls.push(value); return { accepted: true }; } };
  const close = await createRpcServer(service, socketPath, { agentSessions, onHook: () => { hooks++; } });
  const bare = await createRpcServer(service, path.join(dir, 'bare.sock'), { agentSessions: { read: async () => ({}) } });
  t.after(async () => { await close(); await bare(); await rm(dir, { recursive: true, force: true }); });
  const cases = [
    [event({ event: 'MessageDisplay' }), 'Unknown hook event.'],
    [event({ app: 'codex', event: 'PreToolUse' }), 'Unknown hook event.'],
    [event({ event: 5 }), 'Unknown hook event.'],
    [event({ app: 'cursor' }), 'Invalid hook app.'],
    [event({ sessionId: 'served:abc' }), 'Invalid hook session id.'],
    [event({ sessionId: null }), 'Invalid hook session id.'],
    [event({ prompt: 'anything' }), 'Unexpected hook field.'],
    [event({ transcript_path: '/x' }), 'Unexpected hook field.'],
    [event({ v: 2 }), 'Unsupported hook version.'],
    [event({ v: '1' }), 'Unsupported hook version.'],
    [event({ toolName: 'x'.repeat(5000) }), 'Hook event too large.'],
    [{ method: 'hook' }, 'Unsupported hook version.'],
  ];
  for (const [bad, message] of cases) assert.equal((await raw(socketPath, bad)).error, message, JSON.stringify(bad).slice(0, 80));
  assert.deepEqual(calls, []);
  assert.equal(hooks, 0);
  // A line that is not an object at all.
  assert.equal(typeof (await raw(socketPath, '"hook"')).error, 'string');
  // Without noteHook the reply says so; other methods are unchanged, and launching never exists over the socket.
  assert.equal((await raw(path.join(dir, 'bare.sock'), event())).error, 'Hooks are not available in this Summon version.');
  for (const method of ['agent-launch', 'launch', 'claude-hooks-install', 'delete-file']) {
    assert.equal((await raw(socketPath, { method, app: 'claude', projectId: 'demo' })).error, 'Unsupported operation.', method);
  }
  assert.deepEqual(calls, []);
});

test('normalizeHook is the same check the socket runs', () => {
  assert.deepEqual(normalizeHook(event(), JSON.stringify(event())), { app: 'claude', event: 'PreToolUse', sessionId: SESSION, cwd: '/Users/x/Projects/Y', toolName: 'Edit', kind: null, launch: null });
  assert.throws(() => normalizeHook(event(), 'x'.repeat(4097)), /too large/);
  assert.throws(() => normalizeHook(null), /Invalid hook event/);
  assert.throws(() => normalizeHook([event()]), /Invalid hook event/);
  assert.equal(normalizeHook(event({ cwd: `/Users/x${String.fromCharCode(0)}` })).cwd, null);
  assert.equal(normalizeHook(event({ cwd: `/${'a'.repeat(1100)}` })).cwd, null);
});
