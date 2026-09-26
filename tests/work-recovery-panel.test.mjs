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
const base = { repoId: 'repo-a', enabled: false, enabledAt: null, choice: null, lookbackFrom: null, paused: false, checkedAt: null, pending: 0, total: 0, sources: 0, hasMore: false, warnings: [], error: null, items: [], nextOffset: null };
const render = (data = base, props = {}) => renderToStaticMarkup(React.createElement(WorkRecoveryView, { data, available: true, scopeCurrent: true, busy: false, error: '', includeReviewed: false, offset: 0, onEnabled() {}, onScan() {}, onRefresh() {}, onReview() {}, onIncludeReviewed() {}, onPage() {}, ...props }));
const event = { id: 'one', provider: 'codex', sessionKey: 'codex:session-a', role: 'user', text: 'Follow up on the installation result.', at: '2026-09-22T12:00:00Z', capturedAt: '2026-09-22T12:00:10Z', truncated: false, reviewedAt: null };

const find = (node, match) => Array.isArray(node) ? node.reduce((hit, child) => hit ?? find(child, match), null)
  : node && typeof node === 'object' ? (match(node) ? node : find(node.props?.children, match)) : null;
const toggle = (data, checked) => {
  const calls = [];
  const view = WorkRecoveryView({ data, available: true, scopeCurrent: true, busy: false, error: '', includeReviewed: false, offset: 0, onEnabled: value => calls.push(value), onScan() {}, onRefresh() {}, onReview() {}, onIncludeReviewed() {}, onPage() {} });
  const input = find(find(view, node => node.props?.className === 'work-recovery-toggle'), node => node.type === 'input');
  assert.equal(input.props.disabled, false);
  input.props.onChange({ target: { checked } });
  return calls;
};

test('a project without a saved choice is on by default and explains the 14-day look-back before its first check', () => {
  const html = render();
  assert.match(html, /Capture conversation excerpts/);
  assert.match(html, /On by default; starts at the next check. The first check imports this project&#x27;s previous 14 days./);
  assert.match(html, /Excerpts are unreviewed context, not confirmed tasks./);
  assert.match(html, /kept for 30 days; the oldest are removed first to stay within storage limits/);
  assert.match(html, /No model is called./);
  assert.match(html, /<input type="checkbox" checked=""/);
  assert.match(html, /<button class="text-button" disabled="">Check now/);
  assert.match(html, /No excerpts yet. They appear here after the first check./);
  assert.doesNotMatch(html, /Off for this project/);
  assert.deepEqual(toggle(base, false), [false]);
  assert.match(render(null, { available: false }), /requires the updated desktop app/);
  // A runtime snapshot carries choice null; an older one may omit it.
  const { choice, lookbackFrom, ...older } = base;
  assert.match(render(older), /On by default; starts at the next check/);
});

test('a project the project limit keeps off says it is not captured and can be turned on explicitly', () => {
  const full = { ...base, choice: 'default', warnings: ['Conversation recovery project limit reached. This project is not captured.'] };
  const html = render(full);
  assert.match(html, /Not captured: the recovery project limit is reached. Turn another project off, then turn this one on to import its previous 14 days./);
  assert.doesNotMatch(html, /On by default|checked=""|Off for this project/);
  assert.match(html, /No excerpts. This project is not captured./);
  assert.match(html, /<button class="text-button" disabled="">Check now/);
  assert.deepEqual(toggle(full, true), [true]);
});

test('an explicit off stays off, promises no import of the off period or earlier, and can be turned back on', () => {
  const off = { ...base, choice: 'user', enabledAt: '2026-09-20T09:00:00Z', lookbackFrom: '2026-09-06T09:00:00Z' };
  const html = render(off);
  assert.match(html, /Off for this project; automatic checks leave it off. Its saved excerpts were deleted when it was turned off. Turning it back on captures from that moment, never anything said while it was off or before./);
  assert.match(html, /Its saved excerpts were deleted when it was turned off./);
  assert.doesNotMatch(html, /previous 14 days/);
  assert.doesNotMatch(html, /On by default|checked=""/);
  assert.match(html, /Capture is off for this project./);
  assert.deepEqual(toggle(off, true), [true]);
  const legacy = { ...base, choice: undefined, enabledAt: '2026-09-20T09:00:00Z' };
  assert.match(render(legacy), /Off for this project/);
});

test('an enabled project says whether it was on by default and how far back the capture reaches', () => {
  const on = { ...base, enabled: true, choice: 'default', enabledAt: '2026-09-26T12:00:00Z', lookbackFrom: '2026-09-12T12:00:00Z', checkedAt: '2026-09-26T12:01:00Z' };
  const html = render(on);
  assert.match(html, /On by default since [^.<]+\. Includes messages from [^.<]+\./);
  assert.match(html, /<input type="checkbox" checked=""/);
  assert.doesNotMatch(html, /disabled="">Check now/);
  assert.deepEqual(toggle(on, false), [false]);
  const chosen = render({ ...on, choice: 'user', lookbackFrom: '2026-09-26T12:00:00Z' });
  assert.match(chosen, /On for this project since/);
  assert.doesNotMatch(chosen, /Includes messages from/);
  assert.match(render({ ...on, choice: undefined, lookbackFrom: undefined }), /On for this project since/);
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
