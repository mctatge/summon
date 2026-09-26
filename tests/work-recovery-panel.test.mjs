import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
async function load(file, imports = {}) {
  const source = await readFile(new URL(`../src/renderer/${file}`, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } });
  const module = { exports: {} };
  vm.runInThisContext(`(function(require, exports, module) {${outputText}\n})`)(name => name.endsWith('.css') ? {} : imports[name] ?? require(name), module.exports, module);
  return module.exports;
}
const { WorkRecoveryView } = await load('WorkRecoveryPanel.tsx');
const base = { repoId: 'repo-a', enabled: false, enabledAt: null, paused: false, checkedAt: null, pending: 0, total: 0, sources: 0, hasMore: false, warnings: [], error: null, items: [], nextOffset: null };
const render = (data = base, props = {}) => renderToStaticMarkup(React.createElement(WorkRecoveryView, { data, available: true, scopeCurrent: true, busy: false, error: '', includeReviewed: false, offset: 0, onEnabled() {}, onScan() {}, onRefresh() {}, onReview() {}, onIncludeReviewed() {}, onPage() {}, ...props }));
const event = { id: 'one', provider: 'codex', sessionKey: 'codex:session-a', role: 'user', text: 'Follow up on the installation result.', at: '2026-09-22T12:00:00Z', capturedAt: '2026-09-22T12:00:10Z', truncated: false, reviewedAt: null };

test('recovery starts with an explicit future-only local capture opt-in', () => {
  const html = render();
  assert.match(html, /Capture new conversation excerpts/);
  assert.match(html, /Off until enabled for this project. Earlier history is not imported./);
  assert.match(html, /Excerpts are unreviewed context, not confirmed tasks./);
  assert.match(html, /No model is called./);
  assert.doesNotMatch(html, /checked=""/);
  assert.match(render(null, { available: false }), /requires the updated desktop app/);
});

test('conversation excerpts are escaped and carry evidence limitations and explicit review controls', () => {
  const html = render({ ...base, enabled: true, pending: 1, total: 1, items: [{ ...event, text: '<script>unsafe()</script>', truncated: true }] });
  assert.match(html, /&lt;script&gt;unsafe\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /Session: codex:session-a/);
  assert.match(html, /does not contain the full message/);
  assert.match(html, /Mark reviewed/);
  assert.doesNotMatch(html, /Open session|Create task|Mark complete/);
  const reviewed = render({ ...base, total: 1, items: [{ ...event, reviewedAt: '2026-09-22T12:10:00Z' }] }, { includeReviewed: true });
  assert.match(reviewed, /Mark unreviewed/);
});

test('pending operations and stale project scope disable every mutation without hiding saved evidence', () => {
  for (const props of [{ busy: true }, { scopeCurrent: false }]) {
    const html = render({ ...base, enabled: true, pending: 1, total: 1, items: [event] }, props);
    assert.match(html, /Follow up on the installation result./);
    const controls = html.match(/<(?:button|input)\b[^>]*>/g);
    assert.ok(controls.length >= 5);
    for (const control of controls) assert.match(control, /disabled=""/);
  }
});

test('partial capture and read errors remain visible beside the last saved evidence', () => {
  const html = render({ ...base, enabled: true, pending: 1, total: 1, hasMore: true, warnings: ['One source cannot be read.'], items: [event] }, { error: 'Read failed.' });
  assert.match(html, /Capture is incomplete/);
  assert.match(html, /One source cannot be read/);
  assert.match(html, /Previously read excerpts are still shown/);
  assert.match(html, /Follow up on the installation result/);
});

const repos = [{ id: 'repo-a', projectId: 'project-a' }, { id: 'repo-b', projectId: 'ambiguous' }, { id: 'repo-c', projectId: 'ambiguous' }];
const { WorkTreePanel } = await load('WorkTreePanel.tsx', {
  './WorkTree': { WorkTree: () => null }, './WorkRecordEditor': { WorkRecordEditor: () => null }, './WorkRecordInspector': { WorkRecordInspector: () => null },
  './WorkRecoveryPanel': { WorkRecoveryPanel: ({ repoId }) => React.createElement('div', { 'data-recovery-repo': repoId }) },
  './work-records': {}, './visual-sessions': {},
  './preview': { previewWorkInFlight: { repos }, previewAgentSessions: { groups: [] }, previewVisualRepository: () => ({ goals: [] }) },
});
test('recovery uses the uniquely resolved repository identity and is absent across projects or ambiguous scopes', () => {
  const tree = projectId => renderToStaticMarkup(React.createElement(WorkTreePanel, { workingProject: projectId ? { id: projectId } : undefined }));
  assert.match(tree('project-a'), /data-recovery-repo="repo-a"/);
  assert.match(tree('repo-a'), /data-recovery-repo="repo-a"/);
  for (const scope of [undefined, 'ambiguous', 'unknown']) assert.doesNotMatch(tree(scope), /data-recovery-repo/);
});
