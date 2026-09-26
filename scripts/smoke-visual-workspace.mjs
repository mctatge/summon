import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';

// Exercise the real React panel with delayed data sources; no model or personal
// app data is read. SUMMON_PLAYWRIGHT may point to an existing Playwright install.
const require = createRequire(import.meta.url);
const { _electron } = require(process.env.SUMMON_PLAYWRIGHT || 'playwright');
const harness = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { VisualWorkspacePanel } from '/src/renderer/VisualWorkspacePanel.tsx';
import { previewWorkInFlight, previewAgentSessions, previewVisualRepository, previewContextReasoning } from '/src/renderer/preview.ts';
import '/src/renderer/styles.css';
const root = createRoot(document.getElementById('root'));
let releaseWork, releaseSessions, releaseSettings;
let pendingReasoning = [], reasoningCalls = [], releaseCalls = 0, autoReasoning = false, readySuffix = "";
const work = new Promise(resolve => { releaseWork = resolve; });
const sessions = new Promise(resolve => { releaseSessions = resolve; });
const syntheticReasoning = (repoId, suffix = "") => {
  const value = previewContextReasoning();
  return { ...value, repoId, summary: repoId === null ? 'GLOBAL WORKSTATION SUMMARY' + suffix : '', goals: [
    { ...value.goals[0], title: 'Harbor outcome one' + suffix },
    { ...value.goals[1], title: 'Draft Board outcome' + suffix },
    { ...value.goals[0], id: 'inferred-harbor-two', title: 'Harbor outcome two' + suffix },
  ].filter(goal => repoId === null || goal.repoId === repoId) };
};
const bridge = {
  workInFlight: () => work,
  agentSessions: () => sessions,
  contextReasoning: options => {
    if (options.release) { releaseCalls++; return Promise.resolve(syntheticReasoning(null)); }
    reasoningCalls.push(options);
    return autoReasoning ? Promise.resolve(syntheticReasoning(options.repoId, readySuffix)) : new Promise(resolve => pendingReasoning.push({ options, resolve }));
  },
  setContextReasoningSettings: () => new Promise(resolve => { releaseSettings = resolve; }),
  visualRepository: async id => {
    const repository = previewVisualRepository(id);
    return { ...repository, goals: id === 'pocket-meter' ? [{ ...repository.goals[0], title: 'Follow up with Professor Rivera', status: 'planned', nextStep: 'Update him on chart labels, the route importer, and share links.' }] : [] };
  },
};
const project = id => id === null ? null : { id, name: id === 'notes' ? 'Research notes' : previewWorkInFlight.repos.find(repo => repo.id === id).name, path: '/synthetic/' + id, color: '#356962' };
const render = id => root.render(React.createElement(VisualWorkspacePanel, { bridge, preview: false, workingProject: project(id), onClose() { root.render(null); } }));
window.visualSmoke = {
  render, releaseWork: () => releaseWork(previewWorkInFlight), releaseSessions: () => releaseSessions(previewAgentSessions),
  releaseReasoning: (suffix = '', repoId = undefined) => {
    if (repoId === undefined) { autoReasoning = true; readySuffix = suffix; }
    pendingReasoning = pendingReasoning.filter(pending => {
      if (repoId !== undefined && pending.options.repoId !== repoId) return true;
      pending.resolve(syntheticReasoning(pending.options.repoId, suffix)); return false;
    });
  },
  deferReasoning: () => { autoReasoning = false; },
  reasoningCalls: () => reasoningCalls,
  releaseCalls: () => releaseCalls,
  releaseSettings: () => releaseSettings({ ...syntheticReasoning('harbor'), summary: 'LATE SETTINGS SUMMARY', settings: { enabled: true, engine: 'codex' } }),
};
render('harbor');
`;
const harnessFile = path.resolve(`.visual-selection-smoke-${process.pid}.tsx`);
await writeFile(harnessFile, harness);
const dir = await mkdtemp('/private/tmp/summon-visual-selection-');
const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false }, plugins: [{ name: 'visual-selection-smoke', configureServer(server) {
  server.middlewares.use(async (req, res, next) => {
    if (req.url === '/visual-smoke.html') { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml(req.url, `<div id="root"></div><script type="module" src="/${path.basename(harnessFile)}"></script>`)); }
    else next();
  });
} }] });
let electron;
try {
  await server.listen();
  const url = `http://127.0.0.1:${server.httpServer.address().port}/visual-smoke.html`;
  const entry = path.join(dir, 'main.cjs');
  await writeFile(entry, `const { app, BrowserWindow } = require('electron');\napp.setPath('userData', ${JSON.stringify(path.join(dir, 'data'))});\napp.whenReady().then(() => { const win = new BrowserWindow({ width: 1280, height: 900 }); win.loadURL(${JSON.stringify(url)}); });`);
  electron = await _electron.launch({ executablePath: require('electron'), args: [entry], timeout: 30000 });
  const page = await electron.firstWindow();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const scope = page.getByLabel('Visual workspace project');
  await scope.waitFor();
  assert.equal(await scope.inputValue(), 'repo:harbor', 'Working in must select the project before any async reply');
  await page.getByRole('tab', { name: 'Goals', exact: true }).click();
  await page.getByRole('heading', { name: 'Loading Harbor…' }).waitFor();
  assert.equal(await page.getByText('Choose a project to add or edit saved goals.').count(), 0);
  await page.evaluate(() => window.visualSmoke.render('draft-board'));
  await page.waitForFunction(() => document.querySelector('[aria-label="Visual workspace project"]').value === 'repo:draft-board');
  await page.evaluate(() => { window.visualSmoke.releaseWork(); window.visualSmoke.releaseSessions(); });
  await page.getByRole('button', { name: 'New goal', exact: true }).waitFor();
  assert.equal(await scope.inputValue(), 'repo:draft-board', 'late discovery must retain the new Working in selection');
  await page.getByRole('button', { name: 'New goal', exact: true }).click();
  await page.getByRole('textbox', { name: 'What should happen?' }).waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('tab', { name: 'Git', exact: true }).click();
  await page.getByRole('region', { name: 'Interactive Git map' }).waitFor();
  await scope.selectOption('all');
  await page.evaluate(() => window.visualSmoke.render('draft-board'));
  assert.equal(await scope.inputValue(), 'all', 'same-project updates must preserve a manual filter');
  await page.evaluate(() => window.visualSmoke.render('harbor'));
  await page.waitForFunction(() => document.querySelector('[aria-label="Visual workspace project"]').value === 'repo:harbor');
  await page.getByRole('region', { name: 'Interactive Git map' }).waitFor();
  await page.evaluate(() => window.visualSmoke.render('notes'));
  await page.waitForFunction(() => document.querySelector('[aria-label="Visual workspace project"]').value === 'project:Research notes');
  await page.evaluate(() => window.visualSmoke.render(null));
  await page.waitForFunction(() => document.querySelector('[aria-label="Visual workspace project"]').value === 'all');
  await page.getByRole('tab', { name: 'Goals', exact: true }).click();
  const summary = page.locator('.vw-reasoning-summary');
  const waitForSummary = async text => {
    await page.waitForFunction(expected => document.querySelector('.vw-reasoning-summary')?.textContent === expected, text);
    assert.equal(await summary.textContent(), text);
  };
  const assertNoGlobalSummary = async () => assert.doesNotMatch(await summary.textContent(), /GLOBAL WORKSTATION SUMMARY/);
  await scope.selectOption('repo:draft-board');
  await page.evaluate(() => window.visualSmoke.releaseReasoning());
  await waitForSummary('Draft Board outcome');
  await assertNoGlobalSummary();
  await scope.selectOption('repo:harbor');
  await waitForSummary('Harbor outcome one · Harbor outcome two');
  assert.doesNotMatch(await summary.textContent(), /Draft Board outcome/);
  await assertNoGlobalSummary();
  await scope.selectOption('all');
  await waitForSummary('GLOBAL WORKSTATION SUMMARY');
  await scope.selectOption('repo:pocket-meter');
  await waitForSummary('Follow up with Professor Rivera');
  assert.match(await page.getByRole('region', { name: 'Reasoning about your work' }).textContent(), /chart labels, the route importer, and share links/);
  assert.match(await page.getByRole('region', { name: 'Reasoning about your work' }).textContent(), /Open saved goals/);
  await assertNoGlobalSummary();
  const callsBeforeNonRepo = await page.evaluate(() => window.visualSmoke.reasoningCalls().length);
  const releasesBeforeNonRepo = await page.evaluate(() => window.visualSmoke.releaseCalls());
  await scope.selectOption('unassigned');
  await waitForSummary('No inferred goals for Unassigned sessions yet.');
  assert.equal(await page.evaluate(() => window.visualSmoke.releaseCalls()), releasesBeforeNonRepo + 1, 'leaving a reasoning scope releases its focus');
  await assertNoGlobalSummary();
  await page.evaluate(() => window.visualSmoke.render('notes'));
  await page.waitForFunction(() => document.querySelector('[aria-label="Visual workspace project"]').value === 'project:Research notes');
  await waitForSummary('No inferred goals for Research notes yet.');
  await assertNoGlobalSummary();
  assert.equal(await page.evaluate(() => window.visualSmoke.reasoningCalls().length), callsBeforeNonRepo, 'non-repository views must not reason against Working in');
  assert.equal(await page.evaluate(() => window.visualSmoke.releaseCalls()), releasesBeforeNonRepo + 1, 'moving between non-repository views must not release again');
  await page.evaluate(() => window.visualSmoke.render('harbor'));
  await page.waitForFunction(() => document.querySelector('[aria-label="Visual workspace project"]').value === 'repo:harbor');
  await page.evaluate(() => window.visualSmoke.deferReasoning());
  await page.getByRole('button', { name: 'Reason now', exact: true }).click();
  await page.getByRole('button', { name: 'Reasoning…', exact: true }).waitFor();
  await page.evaluate(() => window.visualSmoke.render('draft-board'));
  await page.waitForFunction(() => document.querySelector('[aria-label="Visual workspace project"]').value === 'repo:draft-board');
  await page.evaluate(() => window.visualSmoke.releaseReasoning(' stale harbor', 'harbor'));
  await waitForSummary('No inferred goals for Draft Board yet.');
  await assertNoGlobalSummary();
  await page.evaluate(() => window.visualSmoke.releaseReasoning(' refreshed'));
  await waitForSummary('Draft Board outcome refreshed');
  assert.equal(await page.evaluate(() => window.visualSmoke.releaseCalls()), releasesBeforeNonRepo + 1, 'resuming and changing repositories must retain focus ownership');
  await assertNoGlobalSummary();
  await scope.selectOption('all');
  await waitForSummary('GLOBAL WORKSTATION SUMMARY refreshed');
  await scope.selectOption('repo:harbor');
  await waitForSummary('Harbor outcome one refreshed · Harbor outcome two refreshed');
  await page.getByLabel('Goal reasoning engine').selectOption('codex');
  await page.getByRole('button', { name: 'Reasoning…', exact: true }).waitFor();
  await scope.selectOption('repo:draft-board');
  await waitForSummary('Draft Board outcome refreshed');
  await page.evaluate(() => window.visualSmoke.releaseSettings());
  await page.waitForFunction(() => document.querySelector('[aria-label="Goal reasoning engine"]').value === 'auto');
  await waitForSummary('Draft Board outcome refreshed');
  assert.doesNotMatch(await page.getByRole('region', { name: 'Reasoning about your work' }).textContent(), /LATE SETTINGS SUMMARY/);
  await scope.selectOption('repo:pocket-meter');
  await waitForSummary('Follow up with Professor Rivera');
  await page.evaluate(() => window.visualSmoke.deferReasoning());
  await page.getByRole('button', { name: 'Reason now', exact: true }).click();
  await page.getByRole('button', { name: 'Reasoning…', exact: true }).waitFor();
  await waitForSummary('Follow up with Professor Rivera');
  await page.evaluate(() => window.visualSmoke.releaseReasoning());
  await waitForSummary('Follow up with Professor Rivera');
  const requests = await page.evaluate(() => window.visualSmoke.reasoningCalls());
  assert.ok(requests.every(request => Object.hasOwn(request, 'repoId')), 'every reasoning read must explicitly name its scope');
  assert.ok(requests.some(request => request.repoId === null), 'All projects requests the global view explicitly');
  assert.ok(requests.some(request => request.repoId === 'harbor' && request.refresh), 'Reason now keeps the selected project');
  await page.evaluate(() => window.visualSmoke.deferReasoning());
  await page.getByRole('button', { name: 'Reason now', exact: true }).click();
  await page.getByRole('button', { name: 'Reasoning…', exact: true }).waitFor();
  const releasesBeforeClose = await page.evaluate(() => window.visualSmoke.releaseCalls());
  await page.getByRole('button', { name: 'Close visual workspace', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Visual workspace project"]') === null);
  assert.equal(await page.evaluate(() => window.visualSmoke.releaseCalls()), releasesBeforeClose + 1, 'closing the panel releases focus even with a pending model request');
  await page.evaluate(() => window.visualSmoke.render('harbor'));
  await page.getByRole('tab', { name: 'Goals', exact: true }).click();
  await page.evaluate(() => window.visualSmoke.releaseReasoning(' reopened'));
  await waitForSummary('Harbor outcome one reopened · Harbor outcome two reopened');
  assert.equal(await page.evaluate(() => window.visualSmoke.releaseCalls()), releasesBeforeClose + 1, 'a late reply after close cannot release the reopened panel focus');
  assert.equal((await page.evaluate(() => window.visualSmoke.reasoningCalls())).at(-1).repoId, 'harbor', 'reopening resumes requests for its current workspace');
  assert.deepEqual(errors, []);
  console.log('Visual workspace UI passed: immediate project selection, pending discovery switch, saved-goal editing and Git with reasoning unresolved, manual filter persistence, scoped goal summaries, empty and non-Git scopes, All projects summary, late reasoning/settings after workspace switches, explicit request scope, focus release on close/nonrepo and reacquisition on reopen, and durable follow-up surfacing without model output.');
} finally {
  await electron?.close();
  await server.close();
  await rm(harnessFile, { force: true });
  await rm(dir, { recursive: true, force: true });
}
