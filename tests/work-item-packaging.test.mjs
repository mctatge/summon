import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { WORK_ITEM_TOOLS, WORK_CHECKPOINT_INSTRUCTIONS } from '../src/core/work-item-protocol.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const requests = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
];
function runAdapter(script, cwd) {
  return spawnSync(process.execPath, [script], {
    cwd,
    input: requests.map(request => JSON.stringify(request)).join('\n') + '\n',
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, SUMMON_SOCKET: path.join(cwd, 'no-live-server.sock') },
  });
}

test('packaged standalone MCP resource exposes the canonical work tools without source tree or live server', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'summon-mcp-package-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const resources = path.join(temp, 'Summon.app', 'Contents', 'Resources');
  await fs.mkdir(resources, { recursive: true });
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const adapter = manifest.build.extraResources.find(entry => entry.to === 'mcp-server.mjs');
  assert.ok(adapter, 'The standalone adapter must be declared in extraResources');
  await fs.copyFile(path.join(root, adapter.from), path.join(resources, adapter.to));
  assert.ok(manifest.build.files.includes('src/core/**'), 'The canonical protocol must be included in app.asar');
  assert.equal(manifest.build.extraResources.some(entry => entry.from === 'src/core/work-item-protocol.mjs'), false,
    'An extraResources source would be excluded from app.asar and break the main process import');
  assert.equal(manifest.build.afterPack, 'scripts/after-pack.mjs');
  const { default: afterPack } = await import(pathToFileURL(path.join(root, manifest.build.afterPack)).href);
  await afterPack({ electronPlatformName: 'darwin', appOutDir: temp, packager: { projectDir: root, appInfo: { productFilename: 'Summon' } } });
  assert.equal(await fs.readFile(path.join(resources, 'work-item-protocol.mjs'), 'utf8'),
    await fs.readFile(path.join(root, 'src', 'core', 'work-item-protocol.mjs'), 'utf8'), 'The hook copies the canonical source before signing');
  await assert.rejects(fs.access(path.join(resources, '..', 'src')), { code: 'ENOENT' });
  const child = runAdapter(path.join(resources, 'mcp-server.mjs'), temp);
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');
  const responses = child.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(responses.find(response => response.id === 1)?.result.serverInfo.name, 'summon');
  assert.ok(responses.find(response => response.id === 1)?.result.instructions.endsWith(WORK_CHECKPOINT_INSTRUCTIONS));
  const tools = responses.find(response => response.id === 2)?.result.tools;
  assert.ok(Array.isArray(tools));
  assert.deepEqual(tools.filter(tool => WORK_ITEM_TOOLS.some(work => work.name === tool.name)), WORK_ITEM_TOOLS);
  assert.equal(tools.find(tool => tool.name === 'work_recovery')?.annotations.readOnlyHint, true);
  assert.equal(tools.some(tool => /^work_recovery_(enabled|scan|review)$/.test(tool.name)), false);
});

test('MCP bootstrap does not hide a missing dependency inside the source protocol with its packaged fallback', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'summon-mcp-source-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const scripts = path.join(temp, 'scripts');
  const core = path.join(temp, 'src', 'core');
  await fs.mkdir(scripts, { recursive: true });
  await fs.mkdir(core, { recursive: true });
  await fs.copyFile(path.join(root, 'scripts', 'mcp-server.mjs'), path.join(scripts, 'mcp-server.mjs'));
  await fs.copyFile(path.join(root, 'src', 'core', 'work-item-protocol.mjs'), path.join(scripts, 'work-item-protocol.mjs'));
  await fs.writeFile(path.join(core, 'work-item-protocol.mjs'), "export * from './missing-dependency.mjs';\n");
  const child = runAdapter(path.join(scripts, 'mcp-server.mjs'), temp);
  assert.equal(child.error, undefined);
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /ERR_MODULE_NOT_FOUND/);
  assert.match(child.stderr, /missing-dependency\.mjs/);
  assert.equal(child.stdout, '');
});
