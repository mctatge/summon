import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRpcServer } from '../src/main/rpc.mjs';
import { WORK_ITEM_TOOLS, validateWorkRecoveryRequest } from '../src/core/work-item-protocol.mjs';

function rpc(socketPath, request) {
  return new Promise((resolve, reject) => {
    let body = '';
    const socket = net.createConnection(socketPath);
    socket.setEncoding('utf8');
    socket.setTimeout(3000, () => socket.destroy(new Error('RPC timed out')));
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', chunk => { body += chunk; });
    socket.on('error', reject);
    socket.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
  });
}

async function fixture(t, { available = true } = {}) {
  const dir = await fs.mkdtemp('/private/tmp/summon-recovery-rpc-');
  const socketPath = path.join(dir, 'rpc.sock');
  const calls = [], mutations = [];
  const view = { repoId: 'repo-a', enabled: true, enabledAt: '2026-09-22T01:00:00Z', paused: false,
    checkedAt: '2026-09-22T01:01:00Z', pending: 1, total: 1, sources: 1, hasMore: false, warnings: [], error: null,
    items: [{ id: 'event-one', provider: 'codex', role: 'assistant', text: 'The remaining app check was not performed.', reviewedAt: null }], nextOffset: null };
  const recovery = { read: async options => { calls.push(options); return view; },
    setEnabled: async () => mutations.push('enabled'), scan: async () => mutations.push('scan'), review: async () => mutations.push('review') };
  const close = await createRpcServer({ snapshot: () => ({}) }, socketPath, {
    workRecovery: available ? recovery : undefined, onChange: () => mutations.push('change'),
  });
  const child = spawn(process.execPath, ['scripts/mcp-server.mjs'], {
    env: { ...process.env, SUMMON_SOCKET: socketPath }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let next = 0, buffer = '', stderr = '';
  const pending = new Map();
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const boundary = buffer.indexOf('\n'), response = JSON.parse(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 1);
      const request = pending.get(response.id);
      if (request) { pending.delete(response.id); clearTimeout(request.timer); request.resolve(response); }
    }
  });
  t.after(async () => {
    child.kill();
    for (const value of pending.values()) clearTimeout(value.timer);
    await close(); await fs.rm(dir, { recursive: true, force: true });
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${stderr}`)); }, 5000);
    pending.set(id, { resolve, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const call = async (name, options) => {
    const response = await request('tools/call', { name, arguments: options });
    if (response.error) throw new Error(response.error.message);
    if (response.result.isError) throw new Error(response.result.content[0].text);
    return JSON.parse(response.result.content[0].text);
  };
  return { view, calls, mutations, request, call, raw: request => rpc(socketPath, request) };
}

test('work recovery exposes only bounded read options in the canonical agent schema', () => {
  const tool = WORK_ITEM_TOOLS.find(item => item.name === 'work_recovery');
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.openWorldHint, false);
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ['repoId', 'offset', 'limit', 'includeReviewed']);
  assert.deepEqual(tool.inputSchema.required, ['repoId']);
  assert.equal(tool.inputSchema.properties.limit.maximum, 20);
  for (const options of [{}, { repoId: '' }, { repoId: 'repo-a', offset: -1 }, { repoId: 'repo-a', offset: 0.5 },
    { repoId: 'repo-a', limit: 21 }, { repoId: 'repo-a', offset: 2001 }, { repoId: 'repo-a', includeReviewed: 'true' }, { repoId: 'repo-a', enabled: true }]) {
    assert.throws(() => validateWorkRecoveryRequest(options));
  }
});

test('MCP recovery reads use exact project and pagination without capture or review actions', async t => {
  const f = await fixture(t);
  const initialized = await f.request('initialize', {});
  assert.match(initialized.result.instructions, /unreviewed source excerpts/);
  const tools = (await f.request('tools/list')).result.tools;
  assert.deepEqual(tools.filter(tool => /recovery/.test(tool.name)).map(tool => tool.name), ['work_recovery']);
  const options = { repoId: 'repo-a', offset: 4, limit: 2, includeReviewed: true };
  assert.deepEqual(await f.call('work_recovery', options), f.view);
  assert.deepEqual(f.calls, [options]);
  assert.deepEqual(f.mutations, []);
  for (const extra of [{ enabled: true }, { scan: true }, { reviewed: true }, { actor: 'user' }]) {
    await assert.rejects(f.call('work_recovery', { repoId: 'repo-a', ...extra }), /Invalid/);
    assert.match((await f.raw({ method: 'work-recovery', repoId: 'repo-a', ...extra })).error, /Invalid/);
  }
  assert.equal(f.calls.length, 1, 'invalid options are rejected before the store is called');
});

test('recovery enable, scan and review are unavailable over MCP and the raw socket', async t => {
  const f = await fixture(t);
  for (const action of ['enabled', 'scan', 'review']) {
    await assert.rejects(f.call(`work_recovery_${action}`, { repoId: 'repo-a' }), /Unknown tool/);
    assert.match((await f.raw({ method: `work-recovery-${action}`, repoId: 'repo-a' })).error, /Unsupported operation/);
  }
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.mutations, []);
});

test('MCP recovery reports an unavailable service without silently scanning another source', async t => {
  const f = await fixture(t, { available: false });
  await assert.rejects(f.call('work_recovery', { repoId: 'repo-a' }), /Work recovery is not available/);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.mutations, []);
});
