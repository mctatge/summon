import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Build dist first. Exercise real renderer -> preload -> main -> private store
// and the local agent RPC with a synthetic repository and isolated app data.
// SUMMON_PLAYWRIGHT can point to an existing Playwright installation.
const require = createRequire(import.meta.url);
const { _electron } = require(process.env.SUMMON_PLAYWRIGHT || 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp('/private/tmp/summon-work-records-');
const fixtureHome = path.join(temp, 'home');
const data = path.join(temp, 'data');
const repoPath = path.join(fixtureHome, 'Work records fixture');
const socketPath = path.join(temp, 'test.sock');
const title = 'Resume the routing loose end';
const nextStep = 'Verify the saved checklist after reopening Summon.';
const criteria = 'The next session can recover the checklist and settled finding.';
const evidence = 'The synthetic repository fixture and restart smoke establish persistence.';
let electron;
let page;
const errors = [];

function rpc(request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let body = '', settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Smoke RPC timed out')), 25_000);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', chunk => { body += chunk; });
    socket.on('error', error => finish(error));
    socket.on('end', () => {
      try { const value = JSON.parse(body); finish(value.error ? new Error(value.error) : null, value.result); }
      catch (error) { finish(error); }
    });
  });
}

async function launch() {
  electron = await _electron.launch({
    executablePath: require('electron'), args: [path.join(temp, 'main.cjs')], cwd: root,
    env: { ...process.env, SUMMON_DATA_DIR: data, SUMMON_TEST_HOME: fixtureHome, SUMMON_SOCKET: socketPath }, timeout: 30_000,
  });
  page = await electron.firstWindow();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.summon));
  await (await electron.browserWindow(page)).evaluate(window => window.setSize(1440, 1000));
  const state = await page.evaluate(() => window.summon.snapshot());
  assert.equal(state.projects.length, 1);
  assert.equal(state.settings.paused, true);
  assert.equal(state.settings.activityEnabled, false);
  await page.evaluate(id => window.summon.selectProject(id), state.projects[0].id);
  const flight = await page.evaluate(() => window.summon.workInFlight({ refresh: true }));
  assert.equal(flight.repos.length, 1, JSON.stringify(flight.errors));
  await page.getByRole('button', { name: 'Visual workspace', exact: true }).click();
  await page.getByRole('tab', { name: /^Goals(?:\d+)?$/ }).click();
  await page.getByRole('button', { name: 'New goal', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Visual workspace project').inputValue(), `repo:${flight.repos[0].id}`);
  return flight.repos[0].id;
}

async function savedRecord(repoId) {
  const result = await rpc({ method: 'work-items', repoId });
  const summary = result.items.find(item => item.title === title);
  assert.ok(summary, 'Created record must appear through the shared RPC');
  return (await rpc({ method: 'work-items', repoId, id: summary.id })).item;
}

async function pickRecord() {
  await page.locator('.vw-work-row').filter({ hasText: title }).click();
  await page.getByRole('button', { name: 'Edit goal', exact: true }).waitFor();
}

async function saveGoal() {
  await page.getByRole('button', { name: 'Save goal', exact: true }).click();
  await page.locator('.vw-goal-editor').waitFor({ state: 'detached' });
  await page.getByRole('status').filter({ hasText: 'Goal saved on this Mac.' }).waitFor();
}

async function closeApp() {
  const running = electron;
  electron = undefined;
  if (!running) return;
  const child = running.process();
  try { await running.close(); }
  finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
}

try {
  for (const folder of [data, repoPath, path.join(fixtureHome, 'Downloads'), path.join(fixtureHome, 'Desktop')]) await mkdir(folder, { recursive: true });
  await writeFile(path.join(repoPath, 'index.mjs'), 'export const fixture = true;\n');
  execFileSync('/usr/bin/git', ['init', '-q', repoPath]);
  execFileSync('/usr/bin/git', ['-C', repoPath, 'add', 'index.mjs']);
  execFileSync('/usr/bin/git', ['-C', repoPath, '-c', 'user.name=Summon smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '-qm', 'Synthetic work-record fixture']);
  await writeFile(path.join(data, 'bootstrap.json'), JSON.stringify({ projects: [{ name: 'Work records fixture', path: repoPath }] }));
  await writeFile(path.join(data, 'state.json'), JSON.stringify({ version: 1, projects: [], currentProjectId: null, activity: null, files: [], events: [], receipts: [], journal: null, baselineAt: null, settings: { paused: true, activityEnabled: false } }));
  await writeFile(path.join(data, 'context-reasoning.json'), JSON.stringify({ enabled: false, engine: 'auto' }));
  await writeFile(path.join(data, 'agent-sessions.json'), JSON.stringify({ version: 1, settings: { trayCount: 'off' } }));
  // Keep unrelated services away from personal sessions, provider CLIs and Fn
  // capture. The app, preload, goal store, renderer and RPC are unmodified.
  await writeFile(path.join(temp, 'main.cjs'), `
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
os.homedir = () => ${JSON.stringify(fixtureHome)};
const originalAccess = fs.promises.access;
fs.promises.access = async (file, ...args) => {
  if (['claude', 'codex', 'summon-fn-key'].includes(path.basename(String(file)))) {
    const error = new Error('Unavailable in isolated work-record smoke'); error.code = 'ENOENT'; throw error;
  }
  return originalAccess.call(fs.promises, file, ...args);
};
require('node:module').syncBuiltinESMExports();
import(${JSON.stringify(pathToFileURL(path.join(root, 'src/main/main.mjs')).href)});
`);

  const repoId = await launch();
  await page.getByRole('button', { name: 'New goal', exact: true }).click();
  await page.getByLabel('What should happen?', { exact: true }).fill(title);
  await page.getByRole('textbox', { name: 'Next action', exact: true }).fill(nextStep);
  await page.getByRole('button', { name: 'Add check', exact: true }).click();
  await page.getByLabel('Checklist item 1', { exact: true }).fill('Restore the exact record after a restart.');
  await page.locator('summary').filter({ hasText: 'Acceptance and verification' }).click();
  await page.getByLabel('Acceptance criteria', { exact: true }).fill(criteria);
  await page.locator('summary').filter({ hasText: 'Settled findings' }).click();
  await page.getByRole('button', { name: 'Add finding', exact: true }).click();
  await page.getByLabel('Finding 1', { exact: true }).fill('Session termination does not prove the work is finished.');
  await page.getByLabel('Evidence', { exact: true }).fill(evidence);
  await page.getByLabel('Revisit only when', { exact: true }).fill('The completion contract changes.');
  await page.screenshot({ path: '/private/tmp/summon-work-records-editor.png', fullPage: true });
  await saveGoal();
  let record = await savedRecord(repoId);
  assert.equal(record.nextStep, nextStep);
  assert.equal(record.acceptanceCriteria, criteria);
  assert.equal(record.findings[0].evidence, evidence);
  assert.equal(record.checklist[0].done, false);
  assert.equal(record.revision, 1);
  const persisted = JSON.parse(await readFile(path.join(data, 'visual-goals.json'), 'utf8'));
  assert.equal(persisted.version, 2);
  assert.equal(persisted.goals[0].id, record.id);
  console.log('Created durable record through the UI and verified the private v2 store.');

  // A full process restart establishes storage recovery, beyond a React rerender.
  await closeApp();
  assert.equal(await launch(), repoId);
  await pickRecord();
  await page.locator('.vw-record-next').getByText(nextStep, { exact: true }).waitFor();
  await page.getByText(criteria, { exact: true }).waitFor();
  await page.getByText(evidence, { exact: true }).waitFor();
  await page.screenshot({ path: '/private/tmp/summon-work-records-restored.png', fullPage: true });
  console.log('Full app restart recovered the next action, criteria, checklist and finding.');

  // Another agent checkpoints while the editor is open. The stale draft must
  // fail visibly and must never overwrite that newer next action.
  await page.getByRole('button', { name: 'Edit goal', exact: true }).click();
  await page.getByRole('textbox', { name: 'Next action', exact: true }).fill('This stale draft must not overwrite the new checkpoint.');
  const newerStep = 'Verify the completion report from the resumed session.';
  const receipt = await rpc({ method: 'work-item-update', repoId, item: { id: record.id, expectedRevision: record.revision, nextStep: newerStep } });
  assert.equal(receipt.revision, 2);
  await page.getByRole('button', { name: 'Save goal', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: /changed|revision|again/i }).waitFor();
  assert.equal((await savedRecord(repoId)).nextStep, newerStep);
  await page.screenshot({ path: '/private/tmp/summon-work-records-conflict.png', fullPage: true });
  console.log('Concurrent RPC checkpoint preserved; stale UI save rejected visibly.');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();

  record = await savedRecord(repoId);
  const reported = await rpc({ method: 'work-item-update', repoId, item: {
    id: record.id, expectedRevision: record.revision, status: 'needs-verification',
    completion: { kind: 'reported', summary: 'Persistence and stale-write checks passed; awaiting review.', reference: 'scripts/smoke-work-records.mjs' },
  } });
  assert.equal(reported.status, 'needs-verification');
  await page.getByRole('button', { name: 'Refresh visual workspace', exact: true }).click();
  await page.locator('.vw-work-row').filter({ hasText: title }).getByText('Needs verification', { exact: true }).waitFor();
  await pickRecord();
  await page.getByText('Reported complete. Verify the acceptance criteria before marking done.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Edit goal', exact: true }).click();
  await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('done');
  assert.equal(await page.getByRole('button', { name: 'Save goal', exact: true }).isEnabled(), false, 'A report cannot be saved as done');
  await page.locator('summary').filter({ hasText: 'Acceptance and verification' }).click();
  await page.getByRole('combobox', { name: 'Completion evidence', exact: true }).selectOption('confirmed');
  await page.getByRole('textbox', { name: 'What was verified?', exact: true }).fill('Reviewed restored criteria and findings; the stale edit was rejected.');
  assert.equal(await page.getByRole('button', { name: 'Save goal', exact: true }).isEnabled(), false, 'Unfinished checks still prevent confirmation');
  await page.getByLabel('Complete checklist item 1', { exact: true }).check();
  await page.getByRole('textbox', { name: 'Next action', exact: true }).fill('');
  await saveGoal();
  record = await savedRecord(repoId);
  assert.equal(record.status, 'done');
  assert.equal(record.completion.kind, 'confirmed');
  assert.equal(record.revision, 4);
  assert.equal(record.history.at(-1).actor, 'user');
  assert.ok(record.history.some(entry => entry.actor === 'agent'));
  assert.equal(record.findings[0].evidence, evidence);
  await page.getByText('Confirmed outcome', { exact: true }).waitFor();
  await page.screenshot({ path: '/private/tmp/summon-work-records-confirmed.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('Work records UI smoke passed: UI create, checklist/criteria/findings, full app restart, shared RPC reads, stale edit rejection, agent completion report, checklist gating and user confirmation.');
  console.log('Screenshots: /private/tmp/summon-work-records-{editor,restored,conflict,confirmed}.png');
} catch (error) {
  await page?.screenshot({ path: '/private/tmp/summon-work-records-failure.png', fullPage: true }).catch(() => {});
  throw error;
} finally {
  try { await closeApp(); }
  finally { await rm(temp, { recursive: true, force: true }); }
}
