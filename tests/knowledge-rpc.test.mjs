import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createKnowledge } from '../src/core/knowledge.mjs';
import { classifyCommand } from '../src/main/commands.mjs';
import { createRpcServer } from '../src/main/rpc.mjs';

test('MCP memory and routine tools use the running writer, preserve provenance, and expose no routine execution', async t => {
  const dir = await fs.mkdtemp('/private/tmp/summon-knowledge-rpc-');
  let close; let child;
  const pending = new Map();
  t.after(async () => {
    child?.kill();
    for (const request of pending.values()) clearTimeout(request.timer);
    if (close) await close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const socketPath = path.join(dir, 'rpc.sock');
  const projects = [{ id: 'demo', name: 'Demo', path: dir }];
  const knowledge = await createKnowledge({ dataDir: dir, projects, validateCommand: classifyCommand });
  await knowledge.saveRoutine({ name: 'Morning calendar', trigger: 'morning desk', command: 'open my calendar' });
  const state = { projects, currentProjectId: 'demo', activity: null, settings: { paused: false }, events: [], files: [], health: {} };
  let changes = 0;
  close = await createRpcServer({ snapshot: () => state }, socketPath, { knowledge, onChange: () => { changes++; } });
  child = spawn(process.execPath, [path.resolve(import.meta.dirname, '../scripts/mcp-server.mjs')], { env: { ...process.env, SUMMON_SOCKET: socketPath }, stdio: ['pipe', 'pipe', 'pipe'] });
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
  child.on('error', error => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); } pending.clear(); });
  function request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP knowledge request timed out')); }, 4000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  const tools = (await request('tools/list')).result.tools;
  assert.equal(tools.find(tool => tool.name === 'search_memory').inputSchema.properties.query.maxLength, 500);
  assert.equal(tools.find(tool => tool.name === 'search_memory').annotations.readOnlyHint, true);
  assert.equal(tools.find(tool => tool.name === 'remember_fact').annotations.readOnlyHint, false);
  assert.equal(tools.some(tool => /run_routine|execute|shell/.test(tool.name)), false);
  const saved = await request('tools/call', { name: 'remember_fact', arguments: { text: 'Demo uses concise project notes.', projectId: 'demo' } });
  assert.equal(saved.result.isError, undefined);
  assert.equal(changes, 1);
  const searched = await request('tools/call', { name: 'search_memory', arguments: { query: 'concise project', projectId: 'demo', limit: 5 } });
  const memory = JSON.parse(searched.result.content[0].text)[0];
  assert.equal(memory.kind, 'explicit');
  assert.equal(memory.source.label, 'User request through connected agent');
  assert.equal(memory.projectId, 'demo');
  const persisted = JSON.parse(await fs.readFile(path.join(dir, 'knowledge.json'), 'utf8'));
  assert.equal(persisted.memories.length, 1);
  const listed = await request('tools/call', { name: 'list_routines', arguments: {} });
  assert.equal(JSON.parse(listed.result.content[0].text)[0].command, 'open my calendar');
  assert.equal(knowledge.snapshot().routines[0].useCount, 0);
  const invalid = await request('tools/call', { name: 'remember_fact', arguments: { text: 'x'.repeat(2001) } });
  assert.equal(invalid.result.isError, true);
  assert.equal(knowledge.snapshot().memories.length, 1);
});
