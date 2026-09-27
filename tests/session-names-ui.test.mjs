import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';

// Summon's own session names in the views beyond the sessions board, rendered from source with synthetic sessions only.
const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
async function load(file, imports = {}) {
  const source = await readFile(new URL(`../src/renderer/${file}`, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { fileName: file, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } });
  const module = { exports: {} };
  vm.runInThisContext(`(function(require, exports, module) {${outputText}\n})`, { filename: file })(name => name.endsWith('.css') ? {} : Object.hasOwn(imports, name) ? imports[name] : require(name), module.exports, module);
  return module.exports;
}
// The bigger panels import a tree of renderer modules; this follows their relative imports, one shared copy each.
function loadTree(file, overrides, cache = new Map()) {
  if (cache.has(file)) return cache.get(file);
  const source = readFileSync(new URL(`../src/renderer/${file}`, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { fileName: file, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } });
  const module = { exports: {} };
  cache.set(file, module.exports);
  const local = name => [name, `${name}.ts`, `${name}.tsx`].find(candidate => existsSync(new URL(`../src/renderer/${candidate}`, import.meta.url)));
  vm.runInThisContext(`(function(require, exports, module) {${outputText}\n})`, { filename: file })(name => name.endsWith('.css') ? {} : Object.hasOwn(overrides, name) ? overrides[name]
    : name.startsWith('./') ? (name.endsWith('.mjs') ? require(new URL(`../src/renderer/${name.slice(2)}`, import.meta.url).pathname) : loadTree(local(name.slice(2)), overrides, cache)) : require(name), module.exports, module);
  cache.set(file, module.exports);
  return module.exports;
}
// Opens the one piece of state a static render cannot click: the matching first useState call gets the chosen value.
const opening = (pick, value) => { let done = false; return { ...React, useState: initial => React.useState(!done && pick(initial) ? (done = true, value) : initial) }; };
const withBrowser = fn => {
  const saved = ['window', 'document', 'localStorage'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  const storage = { getItem: () => null, setItem() {} };
  for (const [name, value] of [['window', { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {}, localStorage: storage }], ['document', { activeElement: null, querySelector: () => null, addEventListener() {}, removeEventListener() {} }], ['localStorage', storage]]) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  try { return fn(); } finally { for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } }
};
const names = await load('session-names.ts', { './work-records': await load('work-records.ts') });
const { appTitle, goalWords, nameDetail, nameOrigin, nameSource, rowAppTitle } = names;
const words = html => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

const base = { key: 'claude:desktop:local_harbor', app: 'claude', surface: 'desktop', appLabel: 'Claude app', title: 'Chart export question', titleIsFallback: false, project: 'Harbor', placeId: null, repoId: 'harbor', placeLabel: 'Main folder',
  folder: '~/Projects/Harbor', branch: 'main', group: 'working', activity: 'working', reason: null, stateText: 'Working · 4 min', sinceText: '4 min', sinceAt: null, updatedAt: null, unread: false, pinned: false, live: true,
  confidence: 'reported', helpers: 0, work: null, workText: '', openable: 'link', openHint: 'Open in Claude', startedFrom: null, headline: 'Harbor · main folder', titleIsAuto: true };
const named = { ...base, title: 'Email draft', titleDetail: 'Update on chart labels for Professor Rivera', originalTitle: 'Chart export question', titleSource: 'summon', headline: 'Harbor · Email draft',
  servesGoal: { id: 'rivera', title: 'Follow up with Professor Rivera', status: 'working' } };
const DETAIL = 'Update on chart labels for Professor Rivera';

test('names are read defensively: no source means the app title, and only a differing real app title is quoted', () => {
  assert.equal(nameSource(base), 'native');
  assert.equal(nameSource({ ...base, titleSource: 'something-new' }), 'native');
  assert.equal(nameSource(named), 'summon');
  assert.equal(appTitle(base), null, 'a native row has no second title');
  assert.equal(appTitle({ ...base, originalTitle: 'Other' }), null, 'nor does a stray originalTitle without a Summon source');
  assert.equal(appTitle(named), 'Chart export question');
  assert.equal(appTitle({ ...named, originalTitle: named.title }), null);
  assert.equal(appTitle({ ...named, originalTitle: '  ' }), null);
  assert.equal(appTitle({ ...named, originalTitle: 'Untitled Claude session', titleIsFallback: true }), null, 'an invented title is not worth quoting');
  assert.equal(nameOrigin(base), null);
  assert.match(nameOrigin({ ...named, titleSource: 'goal' }), /saved goal/);
  // A row shows the app title only under a goal's name; a Summon name has its own detail line there instead.
  assert.equal(rowAppTitle(named), null);
  assert.equal(rowAppTitle({ ...named, titleSource: 'goal', title: 'Follow up with Professor Rivera' }), 'Chart export question');
  assert.equal(rowAppTitle(base), null);
});

test('the detail line is a Summon name’s own specifics, and nothing for any other title', () => {
  assert.equal(nameDetail(named), DETAIL);
  assert.equal(nameDetail({ ...named, titleDetail: `  ${DETAIL}  ` }), DETAIL, 'trimmed');
  assert.equal(nameDetail({ ...base, titleDetail: DETAIL }), null, 'a native title has no detail');
  assert.equal(nameDetail({ ...named, titleSource: 'goal' }), null, 'nor does a goal name');
  assert.equal(nameDetail({ ...named, titleSource: 'something-new' }), null);
  for (const titleDetail of [undefined, null, '', '   ', 42, 'Email draft', 'EMAIL DRAFT ']) assert.equal(nameDetail({ ...named, titleDetail }), null, String(titleDetail));
});

test('the goal a session serves is short when the name already says it, and absent when unusable', () => {
  assert.equal(goalWords(named).text, 'Follow up with Professor Rivera · Working', 'a plain name does not say the goal, so the chip does');
  assert.deepEqual(goalWords({ ...named, titleSource: 'goal', title: 'Follow up with Professor Rivera' }), { title: 'Follow up with Professor Rivera', status: 'Working', text: 'Saved goal · Working', tip: 'Serves your saved goal “Follow up with Professor Rivera” · Working' });
  assert.equal(goalWords({ ...base, servesGoal: { id: 'import', title: 'Check the importer result', status: 'needs-verification' } }).text, 'Check the importer result · Needs verification');
  assert.equal(goalWords({ ...base, servesGoal: { id: 'x', title: 'Odd status', status: 'later' } }).status, 'Saved');
  for (const servesGoal of [undefined, null, { id: 'x', title: '', status: 'working' }, { id: 7, title: 'No id', status: 'working' }, { title: 'No id', status: 'working' }]) assert.equal(goalWords({ ...base, servesGoal }), null);
});

test('kitchen tickets lead with the name and its detail; the app title waits in the tooltip and the selected panel', async () => {
  const KitchenScene = (await load('KitchenScene.tsx', { './kitchen-scene': { createKitchenScene() {} }, './FullscreenButton': { FullscreenButton: () => null }, './session-names': names })).default;
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: { matchMedia: () => ({ matches: false }) }, configurable: true, writable: true });
  try {
    const unsafe = { ...named, key: 'codex:desktop:unsafe', app: 'codex', appLabel: 'Codex', titleOutdated: true, titleDetail: '<script>alert(1)</script>', originalTitle: '<img src=x onerror=alert(1)>', servesGoal: { id: 'other', title: '<b>Ship the importer</b>', status: 'blocked' } };
    const goalNamed = { ...named, key: 'claude:desktop:goal', title: 'Follow up with Professor Rivera', titleSource: 'goal', originalTitle: 'Onboarding checklist copy' };
    const html = renderToStaticMarkup(React.createElement(KitchenScene, { sessions: [named, unsafe, goalNamed, base], selected: named.key, paused: false, onPausedChange() {}, onSelect() {}, onTrace() {} }));
    const tickets = html.split('<button').filter(chunk => chunk.includes('class="ks-session ')).map(chunk => `<button${chunk.slice(0, chunk.indexOf('</button>'))}`);
    const ticket = title => tickets.find(chunk => chunk.includes(`<strong>${title}`));
    assert.ok(words(ticket('Email draft')).includes(`Email draft ${DETAIL} Follow up with Professor Rivera · Working Cooking`), words(ticket('Email draft')));
    assert.match(ticket('Email draft'), new RegExp(`</strong><span class="ks-session-name-detail">${DETAIL}</span>`), 'the detail sits directly under the name');
    // The app title leaves the ticket and stays one hover away.
    assert.ok(!ticket('Email draft').includes('ks-session-original') && !words(ticket('Email draft')).includes('Chart export question'));
    assert.match(ticket('Email draft'), /title="App title: “Chart export question”"/);
    assert.match(html, /class="ks-session-updating"[^>]*> · updating<\/span>/);
    assert.equal(html.match(/ks-session-updating/g)?.length, 1, 'only the outdated name says so');
    assert.ok(html.includes('<span class="ks-session-name-detail">&lt;script&gt;alert(1)&lt;/script&gt;</span>') && html.includes('title="App title: “&lt;img src=x onerror=alert(1)&gt;”"') && html.includes('&lt;b&gt;Ship the importer&lt;/b&gt; · Blocked'));
    assert.ok(!html.includes('<script>') && !html.includes('<img') && !html.includes('<b>'));
    // A goal's name has no detail of its own, so its ticket keeps the app title under it; a native ticket keeps its own title alone.
    assert.ok(words(ticket('Follow up with Professor Rivera')).includes('Follow up with Professor Rivera “Onboarding checklist copy” Saved goal · Working'));
    assert.ok(!ticket('Follow up with Professor Rivera').includes('ks-session-name-detail'));
    assert.ok(words(ticket('Chart export question')).includes('Chart export question Cooking') && !/ks-session-name-detail|ks-session-original|title="App title/.test(ticket('Chart export question')));
    const panel = words(html.slice(html.indexOf('ks-selected-detail')));
    assert.ok(panel.includes(`Email draft ${DETAIL} `) && panel.includes('Serves Follow up with Professor Rivera · Working') && panel.includes('App title “Chart export question”'), 'the selected session spells out all three');
  } finally { if (saved) Object.defineProperty(globalThis, 'window', saved); else delete globalThis.window; }
});

test('overview rows show the name with its detail on the small line, and native rows read as before', async () => {
  const view = { version: 1, checkedAt: new Date().toISOString(), totals: { needsYou: 0, newReplies: 0, working: 2, open: 0 }, summary: { needsYou: 0, working: 2, backgroundWorking: 0, text: '' },
    groups: [{ id: 'working', title: 'Working', sessions: [{ ...named, titleOutdated: true }, { ...base, key: 'codex:desktop:plain', appLabel: 'Codex' }] }], sources: [], byPlace: {}, settings: {}, warnings: [] };
  const { SessionsOverviewCard } = await load('WorkspaceOverview.tsx', { './preview': { previewAgentSessions: view, previewWorkInFlight: { repos: [] } }, './session-names': names });
  const html = renderToStaticMarkup(React.createElement(SessionsOverviewCard, { preview: true, onOpen() {} }));
  const text = words(html);
  assert.ok(text.includes(`Email draft · updating ${DETAIL} · Claude app · Harbor Follow up with Professor Rivera · Working Working · 4 min`), text);
  assert.ok(!text.includes('“Chart export question”'), 'the app title is not on the row');
  assert.match(html, /title="App title: “Chart export question”" aria-label="View session options: Email draft, Update on chart labels for Professor Rivera"/);
  assert.equal(html.match(/workspace-row-goal/g)?.length, 1);
  assert.ok(text.includes('Chart export question Codex · Harbor Working · 4 min'), 'a native row reads as before');
  assert.equal(html.match(/title="App title/g)?.length, 1, 'and carries no app-title tooltip');
});

test('the work tree puts the detail under the name in its session list, and both in the agent tooltip', () => {
  const layout = require(new URL('../src/renderer/work-tree-layout.mjs', import.meta.url).pathname);
  const other = { ...named, key: 'claude:desktop:other', title: 'Snapshot cleanup', titleDetail: 'Old nightly snapshots', originalTitle: 'Nightly snapshot cleanup', servesGoal: null };
  const plain = { ...base, key: 'codex:desktop:plain', appLabel: 'Codex' };
  const goal = { id: 'rivera', repoId: 'harbor', title: 'Follow up with Professor Rivera', status: 'working', parentId: null, dependsOn: [], links: { placeId: null, branch: null, sessionKey: named.key, component: null }, createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z' };
  const data = { repos: [{ id: 'harbor', projectId: null, name: 'Harbor', path: '/tmp/harbor', displayPath: '~/Projects/Harbor', status: 'work', places: [], branches: [] }], goals: [goal], sessions: [named, other, plain], readAt: '2026-09-26T00:00:00Z', warnings: [], externalGoals: [], externalRepos: [] };
  // The list of sessions without a task link starts closed; the first closed switch in WorkTree is that one.
  const { WorkTree } = loadTree('WorkTree.tsx', { react: opening(initial => initial === false, true), './session-names': names, './work-tree-layout.mjs': layout, './FullscreenButton': { FullscreenButton: () => null } });
  const html = withBrowser(() => renderToStaticMarkup(React.createElement(WorkTree, { data, selectedRepoId: 'harbor', onSelectGoal() {}, onSelectSession() {}, onNewGoal() {} })));
  assert.match(html, new RegExp(`class="wt-agent" aria-label="Claude app: Email draft, ${DETAIL}. Working · 4 min" title="Email draft\n${DETAIL}\n“Chart export question”\nWorking · 4 min · reported"`));
  assert.match(html, /title="App title: “Nightly snapshot cleanup”"[^>]*>[\s\S]*?<strong>Snapshot cleanup<\/strong><small class="wt-session-detail">Old nightly snapshots<\/small><small>Claude app · Working · 4 min<\/small>/);
  assert.ok(!html.includes('wt-session-original'), 'the app title is not on the row');
  assert.match(html, /<strong>Chart export question<\/strong><small>Codex · Working · 4 min<\/small>/, 'a native row reads as before');
});

test('the session inspectors show the detail under the name and keep the app title as a footnote', () => {
  const workRecords = loadTree('work-records.ts', {});
  const { WorkTreePanel } = loadTree('WorkTreePanel.tsx', { react: opening(initial => initial === null, { kind: 'session', id: named.key }), './session-names': names, './work-records': workRecords,
    './WorkTree': { WorkTree: () => null }, './WorkRecordEditor': { WorkRecordEditor: () => null }, './WorkRecordInspector': { WorkRecordInspector: () => null }, './WorkRecoveryPanel': { WorkRecoveryPanel: () => null }, './visual-sessions': { childActivityText: () => '' },
    './preview': { previewWorkInFlight: { repos: [{ id: 'harbor', name: 'Harbor', places: [], branches: [] }] }, previewAgentSessions: { groups: [{ id: 'working', sessions: [named] }] }, previewVisualRepository: () => ({ goals: [] }) } });
  const tree = withBrowser(() => renderToStaticMarkup(React.createElement(WorkTreePanel, {})));
  assert.ok(tree.includes(`<h2>Email draft</h2><p class="work-tree-name-detail">${DETAIL}</p>`), tree);
  assert.ok(tree.includes('App title: “Chart export question”'));

  // The workspace inspector, on the preview's own Summon-named sample.
  const pick = { goalId: null, placeId: null, branch: null, sessionKey: 'claude:desktop:local_preview-templates-drawer', component: null, commitId: null };
  const { VisualWorkspacePanel } = loadTree('VisualWorkspacePanel.tsx', { react: opening(initial => Boolean(initial) && typeof initial === 'object' && 'commitId' in initial, pick), './session-names': names, './KitchenScene': { default: () => null } });
  const html = withBrowser(() => renderToStaticMarkup(React.createElement(VisualWorkspacePanel, { preview: true, onClose() {} })));
  const inspector = html.slice(html.indexOf('class="vw-inspector"'));
  assert.ok(inspector.includes('<h3>Preview drawer build</h3><p class="vw-inspector-intro">Templates tab formatting compare</p>'), inspector.slice(0, 400));
  // The name is already the heading, so the Session row gives the app and the state without saying it again.
  const start = inspector.indexOf('<dt>Session</dt>');
  const row = inspector.slice(start, inspector.indexOf('</div>', start));
  assert.ok(row.startsWith('<dt>Session</dt><dd>Claude app</dd><dd class="vw-session-status">') && !row.includes('Preview drawer build') && !row.includes('Templates tab formatting compare'), row);
  const section = inspector.slice(inspector.indexOf('What this session is for'));
  assert.ok(section.startsWith('What this session is for</span><p><span title="Serves your saved goal “Make the preview useful” · Needs verification">Serves Make the preview useful</span>'), section.slice(0, 200));
  assert.ok(!section.includes('Templates tab formatting compare'), 'the detail is said once, under the heading');
  assert.ok(section.includes('App title: “Templates tab preview drawer”'));
  // With a goal selected too, the heading is the goal's, so the Session row names the session with its detail right under it.
  const withGoal = { ...pick, goalId: 'inferred-preview-harbor' };
  const { VisualWorkspacePanel: GoalPanel } = loadTree('VisualWorkspacePanel.tsx', { react: opening(initial => Boolean(initial) && typeof initial === 'object' && 'commitId' in initial, withGoal), './session-names': names, './KitchenScene': { default: () => null } });
  const goalHtml = withBrowser(() => renderToStaticMarkup(React.createElement(GoalPanel, { preview: true, onClose() {} })));
  assert.ok(goalHtml.includes('<dt>Session</dt><dd>Claude app</dd><dd>Preview drawer build</dd><dd class="vw-secondary">Templates tab formatting compare</dd>'), goalHtml.slice(goalHtml.indexOf('<dt>Session</dt>'), goalHtml.indexOf('<dt>Session</dt>') + 300));
  assert.ok(!goalHtml.includes('<h3>Preview drawer build</h3>'));
});
