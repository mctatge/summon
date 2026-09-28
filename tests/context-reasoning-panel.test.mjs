import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import { REASONING_CLAUDE_MODELS, REASONING_CODEX_MODELS } from '../src/core/context-reasoning.mjs';

const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const source = await readFile(new URL('../src/renderer/ContextReasoningPanel.tsx', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } });
const module = { exports: {} };
vm.runInThisContext(`(function(require, exports, module) {${outputText}\n})`)(require, module.exports, module);
const { ContextReasoningPanel, ReasoningEvidence, BackgroundReasoningPreferences, modelName } = module.exports;
const view = { settings: { enabled: true, engine: 'auto' }, status: 'ready', updatedAt: '2026-09-20T10:00:00Z', engine: 'local', model: 'current-model', error: null, summary: 'Finish the accessible preview.', goals: [], stale: false };
const render = (value, props = {}) => renderToStaticMarkup(React.createElement(ContextReasoningPanel, { value, scope: null, busy: false, error: '', available: true, onRefresh() {}, onSettings() {}, ...props }));

test('workspace reading uses only goals attributed to the selected repository', () => {
  const mixed = { ...view, goals: [
    { repoId: 'summon', title: 'Reuse OCR regions' },
    { repoId: 'harbor', title: 'Improve import validation' },
    { repoId: 'harbor-copy', title: 'Another repository with a similar name' },
  ] };
  const html = render(mixed, { scope: { repoId: 'harbor', label: 'Harbor' } });
  assert.match(html, /Improve import validation/);
  assert.match(html, /What you’re working toward · Harbor/);
  assert.doesNotMatch(html, /Reuse OCR regions|Another repository|Finish the accessible preview/);
  assert.match(render(mixed), /Finish the accessible preview/);
  assert.match(render(mixed), /What you’re working toward · All projects/);
});

test('empty, loading and non-repository scopes never fall back to the global reading', () => {
  const mixed = { ...view, goals: [{ repoId: 'summon', title: 'Reuse OCR regions' }, { repoId: null, title: 'Unattributed work' }] };
  for (const scope of [{ repoId: 'harbor', label: 'Harbor' }, { repoId: null, label: 'Research notes' }, { repoId: null, label: 'Unassigned sessions' }]) {
    for (const value of [null, mixed, { ...mixed, status: 'running' }, { ...mixed, status: 'error', stale: true, error: 'Failed to refresh.' }]) {
      const html = render(value, { scope });
      assert.ok(html.includes(`No inferred goals for ${scope.label} yet.`));
      assert.doesNotMatch(html, /Reuse OCR regions|Unattributed work|Finish the accessible preview|The previous reading is still shown/);
    }
  }
});

test('a failed or running reasoning refresh preserves the last useful reading and its engine', () => {
  const error = render({ ...view, status: 'error', error: 'Local model is unavailable.', stale: true });
  assert.match(error, /Finish the accessible preview/);
  assert.match(error, /Local model is unavailable/);
  assert.match(error, /The previous reading is still shown/);
  assert.match(error, /Context changed since the last reading/);
  assert.match(error, /current-model/);
  const running = render({ ...view, status: 'running' });
  assert.match(running, /Finish the accessible preview/);
  assert.match(running, /disabled=""[^>]*>.*Reasoning…/);
  assert.match(running, /Enable automatic reasoning/);
});

test('untrusted reasoning and its evidence are rendered as text, with uncertainty visible', () => {
  const html = renderToStaticMarkup(React.createElement(ReasoningEvidence, { inference: { summary: '<script>unsafe()</script>', evidence: ['<img src=x onerror=unsafe()>'], confidence: 'low', engine: 'codex', model: null, updatedAt: view.updatedAt } }));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /low confidence/);
  assert.match(html, /Evidence for this inference/);
});

test('older app windows explain unavailable reasoning while leaving the panel usable', () => {
  const html = render(null, { available: false });
  assert.match(html, /Reasoning unavailable/);
  assert.match(html, /Quit and reopen Summon/);
  assert.match(html, /Goal reasoning engine[^>]*disabled/);
});

test('an open saved follow-up survives missing, empty, running, disabled and failed reasoning', () => {
  const goal = { id: 'rivera', repoId: 'harbor', title: 'Follow up with Professor Rivera', status: 'planned', nextStep: 'Prepare the update on chart labels, the route importer, and the fixed share link.' };
  for (const value of [null, { ...view, repoId: 'harbor', summary: '' }, { ...view, status: 'running' }, { ...view, status: 'disabled', settings: { ...view.settings, enabled: false } }, { ...view, status: 'error', error: 'Model unavailable' }]) {
    const html = render(value, { scope: { repoId: 'harbor', label: 'Harbor' }, savedGoals: [goal] });
    assert.match(html, /Follow up with Professor Rivera/);
    assert.match(html, /Open saved goals/);
    assert.match(html, /Next step/);
    assert.match(html, /chart labels, the route importer, and the fixed share link/);
    assert.doesNotMatch(html, /No inferred goals|Finish the accessible preview/);
  }
  assert.match(render({ ...view, status: 'error', error: 'Model unavailable' }, { scope: { repoId: 'harbor', label: 'Harbor' }, savedGoals: [goal] }), /Your saved goals are still shown/);
});

test('saved work summary excludes other projects and closed or deferred commitments', () => {
  const savedGoals = [
    { repoId: 'summon', title: 'Summon teaching work', status: 'working', nextStep: 'Other next step' },
    ...['done', 'deferred', 'dismissed'].map(status => ({ repoId: 'harbor', title: `${status} obligation`, status, nextStep: `${status} next step` })),
    { repoId: 'harbor', title: 'Check the importer result', status: 'needs-verification', nextStep: 'Verify a live import.' },
  ];
  const html = render(null, { scope: { repoId: 'harbor', label: 'Harbor' }, savedGoals });
  assert.match(html, /Check the importer result/);
  assert.match(html, /Verify a live import/);
  assert.doesNotMatch(html, /Summon teaching|Other next step|done obligation|deferred obligation|dismissed obligation/);
  assert.doesNotMatch(render(null, { scope: { repoId: null, label: 'Research notes' }, savedGoals }), /Check the importer result|Summon teaching/);
});

test('scope-tagged replies cannot leak a prior project reading, status or error', () => {
  const old = { ...view, repoId: 'summon', status: 'running', summary: 'Summon direction', error: 'Summon error', goals: [{ repoId: 'harbor', title: 'Wrong-scope response content' }] };
  const html = render(old, { scope: { repoId: 'harbor', label: 'Harbor' } });
  assert.match(html, /No inferred goals for Harbor yet/);
  assert.doesNotMatch(html, /Summon direction|Summon error|Wrong-scope|Reasoning…|current-model/);
  assert.doesNotMatch(render(old), /Summon direction|Summon error|current-model/);
  const scoped = render({ ...view, repoId: 'harbor', summary: 'Reliable import validation' }, { scope: { repoId: 'harbor', label: 'Harbor' } });
  assert.doesNotMatch(scoped, /Reliable import validation/, 'a scoped free-form summary still lacks validated goal evidence');
});

test('a free-form model summary cannot contradict a saved pending follow-up', () => {
  const html = render({ ...view, repoId: 'harbor', summary: 'The draft was sent but not confirmed.', goals: [] }, {
    scope: { repoId: 'harbor', label: 'Harbor' },
    savedGoals: [{ repoId: 'harbor', title: 'Follow up with Professor Rivera', status: 'planned', nextStep: 'Review the unsent draft.' }],
  });
  assert.match(html, /Follow up with Professor Rivera/);
  assert.match(html, /Review the unsent draft/);
  assert.doesNotMatch(html, /draft was sent|Inferred direction/);
});

test('Preferences lists the background reasoning models and marks the saved ones', () => {
  const changes = [];
  const renderPreferences = props => renderToStaticMarkup(React.createElement(BackgroundReasoningPreferences, { settings: { enabled: true, engine: 'auto', claudeModel: 'haiku', codexModel: 'gpt-6-sol' }, disabled: false, onChange: patch => changes.push(patch), ...props }));
  const html = renderPreferences();
  assert.match(html, /Background reasoning/);
  assert.match(html, /aria-label="Claude model for background reasoning"/);
  assert.match(html, /aria-label="Codex model for background reasoning"/);
  const options = name => [...html.split(`aria-label="${name} model for background reasoning"`)[1].split('</select>')[0].matchAll(/<option value="([^"]+)"( selected="")?>([^<]+)<\/option>/g)].map(([, value, selected, label]) => ({ value, label, selected: Boolean(selected) }));
  assert.deepEqual(options('Claude'), [{ value: 'sonnet', label: 'Sonnet', selected: false }, { value: 'haiku', label: 'Haiku', selected: true }, { value: 'opus', label: 'Opus', selected: false }]);
  assert.deepEqual(options('Codex'), [{ value: 'gpt-6-luna', label: 'GPT-6-Luna — fast and affordable', selected: false }, { value: 'gpt-6-sol', label: 'GPT-6-Sol', selected: true }, { value: 'gpt-6-astra', label: 'GPT-6-Astra', selected: false }, { value: 'default', label: 'Codex’s own default', selected: false }]);
  assert.match(html, /goals and session names whenever Reason with, in the Goals panel, picks Claude or Codex, including through Auto/);
  assert.doesNotMatch(html, /disabled=""/);
  assert.equal((renderPreferences({ disabled: true }).match(/disabled=""/g) || []).length, 2);
  const missing = renderPreferences({ settings: undefined });
  assert.equal((missing.match(/disabled=""/g) || []).length, 2, 'no preferences to change without goal reasoning');
  assert.match(missing, /<option value="sonnet" selected="">/);
  assert.match(missing, /<option value="gpt-6-luna" selected="">/);
  assert.match(missing, /not available right now/);
  assert.deepEqual(changes, [], 'rendering changes nothing');
});

test('Preferences offers exactly the models core accepts, and the preview shows the section as it is', async () => {
  const html = renderToStaticMarkup(React.createElement(BackgroundReasoningPreferences, { settings: { enabled: true, engine: 'auto', claudeModel: 'sonnet', codexModel: 'gpt-6-luna' }, disabled: false, onChange() {} }));
  const values = name => [...html.split(`aria-label="${name} model for background reasoning"`)[1].split('</select>')[0].matchAll(/<option value="([^"]+)"/g)].map(match => match[1]).sort();
  assert.deepEqual(values('Claude'), [...REASONING_CLAUDE_MODELS].sort());
  assert.deepEqual(values('Codex'), [...REASONING_CODEX_MODELS].sort());
  // The browser preview carries the preferences too, so the section is shown with its selects disabled, not as missing.
  const previewSource = await readFile(new URL('../src/renderer/preview.ts', import.meta.url), 'utf8');
  const previewModule = { exports: {} };
  vm.runInThisContext(`(function(require, exports, module) {${ts.transpileModule(previewSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText}\n})`)(require, previewModule.exports, previewModule);
  const saved = previewModule.exports.previewSnapshot.reasoning;
  assert.ok(REASONING_CLAUDE_MODELS.includes(saved?.claudeModel) && REASONING_CODEX_MODELS.includes(saved?.codexModel), JSON.stringify(saved));
  const shown = renderToStaticMarkup(React.createElement(BackgroundReasoningPreferences, { settings: saved, disabled: true, onChange() {} }));
  assert.doesNotMatch(shown, /not available right now/);
  assert.equal((shown.match(/disabled=""/g) || []).length, 2);
});

test('the status line names the model a reading reports, in short form', () => {
  assert.equal(modelName('gpt-6-luna'), 'GPT-6-Luna');
  assert.equal(modelName('sonnet'), 'Sonnet');
  assert.equal(modelName('current-model'), 'current-model');
  assert.equal(modelName('constructor'), 'constructor');
  assert.match(render({ ...view, engine: 'codex', model: 'gpt-6-luna' }), /Codex · GPT-6-Luna/);
  assert.match(render({ ...view, engine: 'claude', model: 'sonnet' }), /Claude · Sonnet/);
  assert.match(render({ ...view, engine: 'codex', model: null }), />Codex<\/span>/);
  const evidence = renderToStaticMarkup(React.createElement(ReasoningEvidence, { inference: { summary: 'Why', evidence: [], confidence: 'medium', engine: 'codex', model: 'gpt-6-astra', updatedAt: '2026-09-20T10:00:00Z' } }));
  assert.match(evidence, /medium confidence · Codex · GPT-6-Astra/);
});
