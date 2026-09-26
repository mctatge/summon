import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const source = await readFile(new URL('../src/renderer/ContextReasoningPanel.tsx', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } });
const module = { exports: {} };
vm.runInThisContext(`(function(require, exports, module) {${outputText}\n})`)(require, module.exports, module);
const { ContextReasoningPanel, ReasoningEvidence } = module.exports;
const view = { settings: { enabled: true, engine: 'auto' }, status: 'ready', updatedAt: '2026-09-20T10:00:00Z', engine: 'local', model: 'current-model', error: null, summary: 'Finish the accessible preview.', goals: [], sessionTitles: [], stale: false };
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
