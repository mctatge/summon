import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserTeachingBridge} from '../src/main/browser-teaching-bridge.mjs';

const ORIGIN = 'chrome-extension://' + 'a'.repeat(32);
async function fixture(t, options = {}) {
  const changes = [], bridge = createBrowserTeachingBridge({pollTimeoutMs: 20, requestTimeoutMs: 1000, leaseMs: 2000, onChange: state => changes.push(state), ...options});
  const {port, token} = await bridge.start();
  t.after(() => bridge.close());
  const call = async (path, value, extraHeaders = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {method: value === undefined ? 'GET' : 'POST', headers: {Origin: ORIGIN, Authorization: `Bearer ${token}`, ...(value === undefined ? {} : {'Content-Type': 'application/json'}), ...extraHeaders}, ...(value === undefined ? {} : {body: JSON.stringify(value)})});
    return {status: response.status, value: await response.json()};
  };
  const connect = async (overrides = {}) => {
    const response = await call('/connect', {tabId: 7, documentId: 'doc-1', url: 'https://example.com/draft?private=not-kept#pick', title: 'Draft', ...overrides});
    assert.equal(response.status, 200); return response.value.sessionId;
  };
  return {bridge, call, connect, changes, token, port};
}

test('browser transport requires bearer auth, extension origin, and a single ordinary web tab', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/connect', {}, {Authorization: 'Bearer wrong'})).status, 401);
  assert.equal((await f.call('/connect', {}, {Origin: 'https://example.com'})).status, 403);
  assert.equal((await f.call('/connect', {}, {Origin: 'null'})).status, 403);
  assert.equal((await f.call('/connect', {tabId: 7, documentId: 'x', url: 'file:///private/example'})).status, 400);
  assert.equal((await f.call('/connect', {tabId: 7, documentId: 'x', url: 'https://user:pass@example.com/'})).status, 400);
  await f.connect();
  assert.equal(f.bridge.status().url, 'https://example.com/draft');
  assert.equal(f.bridge.status().connected, true);
  assert.equal((await f.call('/connect', {}, {Origin: 'chrome-extension://' + 'b'.repeat(32)})).status, 403);
  assert.ok(!JSON.stringify(f.changes).includes(f.token), 'state updates must not expose the pairing secret');
});

test('polling delivers one command once and accepts its matching reply', async t => {
  const f = await fixture(t), sessionId = await f.connect();
  const completion = f.bridge.request('snapshot');
  const first = await f.call('/poll', {sessionId});
  assert.equal(first.value.command.method, 'snapshot');
  assert.equal((await f.call(`/poll?sessionId=${sessionId}`)).value.command, null);
  const result = {url: 'https://example.com/draft', text: 'Jessie selected', controls: []};
  assert.equal((await f.call('/reply', {sessionId, id: first.value.command.id, result})).status, 200);
  assert.deepEqual(await completion, result);
  assert.equal((await f.call('/reply', {sessionId, id: first.value.command.id, result})).status, 409);
});

test('reconnecting rejects work and stale replies cannot affect the new document', async t => {
  const f = await fixture(t), oldSession = await f.connect();
  const pending = f.bridge.request('execute', {step: {kind: 'click', target: {name: 'Najia'}}});
  const rejected = assert.rejects(pending, /new browser tab/);
  const delivered = (await f.call(`/poll?sessionId=${oldSession}`)).value.command;
  const newSession = await f.connect({documentId: 'doc-2'});
  await rejected;
  assert.notEqual(oldSession, newSession);
  assert.equal((await f.call('/reply', {sessionId: oldSession, id: delivered.id, result: {ok: true}})).status, 409);
  assert.equal((await f.call('/reply', {sessionId: newSession, id: delivered.id, result: {ok: true}})).status, 409);
});

test('correction cancels queued actions, allows in-flight verification, then stays connected for teaching', async t => {
  const f = await fixture(t), sessionId = await f.connect();
  const first = f.bridge.request('execute', {step: {kind: 'fill', value: 'Najia'}});
  const delivered = (await f.call(`/poll?sessionId=${sessionId}`)).value.command;
  const queued = f.bridge.request('execute', {step: {kind: 'click'}}), rejected = assert.rejects(queued, /cancelled/);
  const cancellation = f.bridge.request('cancel'); await rejected;
  await f.call('/reply', {sessionId, id: delivered.id, result: {changed: true}}); await first;
  const next = (await f.call(`/poll?sessionId=${sessionId}`)).value.command;
  assert.equal(next.method, 'cancel');
  await f.call('/reply', {sessionId, id: next.id, result: {cancelled: true}}); await cancellation;
  assert.equal(f.bridge.status().connected, true);
  const begin = f.bridge.request('begin', {intent: 'Like this'}), recording = (await f.call(`/poll?sessionId=${sessionId}`)).value.command;
  assert.equal(recording.method, 'begin');
  await f.call('/reply', {sessionId, id: recording.id, result: {recording: true}}); assert.equal((await begin).recording, true);
});

test('abort removes queued work and retires delivered work without permitting a late reply', async t => {
  const f = await fixture(t), sessionId = await f.connect();
  const controller = new AbortController(), pending = f.bridge.request('execute', {}, {signal: controller.signal});
  const rejected = assert.rejects(pending, /cancelled/); controller.abort(); await rejected;
  assert.equal((await f.call(`/poll?sessionId=${sessionId}`)).value.command, null);
  assert.equal(f.bridge.status().connected, true);
  const second = new AbortController(), running = f.bridge.request('execute', {}, {signal: second.signal}), stopped = assert.rejects(running, /cancelled/);
  const job = (await f.call(`/poll?sessionId=${sessionId}`)).value.command; second.abort(); await stopped;
  assert.equal(f.bridge.status().connected, false);
  assert.equal((await f.call('/reply', {sessionId, id: job.id, result: {ok: true}})).status, 409);
});

test('navigation evidence and expired heartbeat fail closed', async t => {
  const f = await fixture(t, {leaseMs: 80}), sessionId = await f.connect();
  const request = f.bridge.request('execute'), rejected = assert.rejects(request, /page changed/);
  const job = (await f.call(`/poll?sessionId=${sessionId}`)).value.command;
  assert.equal((await f.call('/reply', {sessionId, id: job.id, result: {after: {url: 'https://elsewhere.example/'}}})).status, 409); await rejected;
  await f.connect();
  await new Promise(resolve => setTimeout(resolve, 110));
  assert.equal(f.bridge.status().connected, false);
  await assert.rejects(f.bridge.request('snapshot'), /Connect this tab/);
});

test('unknown methods, oversized payloads, and timed-out requests are rejected', async t => {
  const f = await fixture(t, {requestTimeoutMs: 30}), sessionId = await f.connect();
  await assert.rejects(f.bridge.request('evaluate', {script: 'alert(1)'}), /Unsupported/);
  await assert.rejects(f.bridge.request('execute', {text: 'a'.repeat(64_001)}), /Invalid/);
  await assert.rejects(f.bridge.request('snapshot'), /timed out/);
  assert.equal((await f.call(`/poll?sessionId=${sessionId}`)).value.command, null);
});
