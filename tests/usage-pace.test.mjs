import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';

// The weekly pace notch on the overview's usage bars, from the card source with synthetic readings only.
const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const file = 'WorkspaceOverview.tsx';
const source = await readFile(new URL(`../src/renderer/${file}`, import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { fileName: file, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } });
const module = { exports: {} };
const stubs = { './preview': { previewAgentSessions: {}, previewWorkInFlight: { repos: [] } }, './session-names': {} };
vm.runInThisContext(`(function (require, exports, module) {${outputText}\n})`, { filename: file })(name => Object.hasOwn(stubs, name) ? stubs[name] : require(name), module.exports, module);
const { UsageOverviewCard, weeklyPace } = module.exports;

const DAY = 86_400_000, NOW = Date.parse('2026-09-26T20:28:00-04:00');
const inDays = days => new Date(NOW + days * DAY).toISOString();

test('the pace steps by whole days of the weekly window, from 1/7 on day one to all of it on day seven', () => {
  const reset = days => NOW + days * DAY;
  assert.deepEqual(weeklyPace('seven_day', reset(6.9), NOW), { day: 1, remaining: 100 - 1 / 7 * 100 });
  assert.equal(weeklyPace('seven_day', reset(7), NOW).day, 1, 'the first instant of the window is day one');
  assert.equal(weeklyPace('seven_day', reset(6), NOW).day, 1, 'exactly one day in is still the end of day one');
  assert.equal(weeklyPace('seven_day', reset(5.9), NOW).day, 2);
  assert.equal(weeklyPace('seven_day', reset(0.1), NOW).day, 7);
  assert.equal(weeklyPace('seven_day', reset(0.1), NOW).remaining, 0);
  assert.equal(weeklyPace('seven_day', reset(9), NOW).day, 1, 'a reset further out than a week clamps to day one');
  assert.equal(weeklyPace('seven_day_opus', reset(3.5), NOW).day, 4, 'model-specific weekly windows pace too');
  assert.equal(weeklyPace('five_hour', reset(0.1), NOW), null, 'only weekly windows have a pace');
  assert.equal(weeklyPace('seven_day', reset(-0.1), NOW), null, 'a passed reset has no pace');
  assert.equal(weeklyPace('seven_day', NaN, NOW), null, 'an unknown reset has no pace');
});

test('only the weekly bar carries the notch, placed where an even pace leaves the bar', () => {
  const usage = { refreshing: [], providers: {
    claude: { provider: 'claude', plan: 'max', status: 'ok', fetchedAt: inDays(0), windows: [{ id: 'five_hour', label: '5h', usedPercent: 26, resetsAt: inDays(0.1) }, { id: 'seven_day', label: '7d', usedPercent: 17, resetsAt: inDays(5.9) }] },
    codex: { provider: 'codex', plan: 'plus', status: 'ok', fetchedAt: inDays(0), windows: [{ id: 'seven_day', label: '7d', usedPercent: 4, resetsAt: inDays(-0.1) }] } } };
  const saved = [Date.now, Object.getOwnPropertyDescriptor(globalThis, 'document')];
  Date.now = () => NOW;
  Object.defineProperty(globalThis, 'document', { value: { visibilityState: 'visible' }, configurable: true, writable: true });
  let html;
  try { html = renderToStaticMarkup(React.createElement(UsageOverviewCard, { usage, onOpen() {} })); }
  finally { Date.now = saved[0]; if (saved[1]) Object.defineProperty(globalThis, 'document', saved[1]); else delete globalThis.document; }
  const notches = html.match(/<i class="workspace-usage-pace" style="left:([\d.]+)%" aria-hidden="true"><\/i>/g) ?? [];
  assert.equal(notches.length, 1, 'no notch on the 5h bar or on a weekly bar whose reset has passed');
  assert.match(notches[0], /left:71\.428/, 'day two of seven leaves about 71% remaining');
  assert.match(html, /title="The notch: even pace keeps about 71% by the end of day 2 of 7\."/);
  assert.match(html, /aria-label="Claude 7d allowance remaining; even pace keeps about 71% by the end of day 2 of 7"/);
  assert.match(html, /aria-label="Claude 5h allowance remaining"/);
});
