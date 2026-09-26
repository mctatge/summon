import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';

// Renders the Agent sessions panel and the Work in flight chips from their sources, with the synthetic preview data only.
const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

async function load(file, modules) {
  const source = await readFile(new URL(`../src/renderer/${file}`, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { fileName: file, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } });
  const module = { exports: {} };
  vm.runInThisContext(`(function (require, exports, module) {${outputText}\n})`, { filename: file })(name => Object.hasOwn(modules, name) ? modules[name] : require(name), module.exports, module);
  return { exports: module.exports, source };
}

const preview = (await load('preview.ts', {})).exports;
const panel = await load('SessionsPanel.tsx', { './preview': preview });
const { SessionsPanel } = panel.exports;
const { WorkInFlightPanel } = (await load('WorkInFlightPanel.tsx', { './preview': preview })).exports;
const sample = preview.previewAgentSessions;
const original = structuredClone(sample);

// A browser-like document and an empty localStorage, only while rendering.
function render(element) {
  const saved = ['document', 'localStorage'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  Object.defineProperty(globalThis, 'document', { value: { activeElement: null, querySelector: () => null }, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => null, setItem() {} }, configurable: true, writable: true });
  try { return renderToStaticMarkup(element); }
  finally { for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } }
}
const words = html => html.replace(/<span class="sr-only">[^<]*<\/span>/g, '').replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const board = (props = {}) => render(React.createElement(SessionsPanel, { preview: true, onClose() {}, ...props }));
const withGroups = (groups, fn) => {
  const saved = { groups: sample.groups, totals: sample.totals };
  sample.groups = groups;
  sample.totals = { needsYou: 0, newReplies: 0, working: 0, open: 0, ...Object.fromEntries(groups.map(group => [{ 'needs-you': 'needsYou', new: 'newReplies', working: 'working', open: 'open' }[group.id], group.sessions.length]).filter(([key]) => key)) };
  try { return fn(); } finally { Object.assign(sample, saved); }
};

test('the board leads with what needs you, then new replies, then working', () => {
  const html = board();
  const order = [...html.matchAll(/<h3 id="as-group-([a-z-]+)"/g)].map(match => match[1]);
  assert.deepEqual(order, ['needs-you', 'new', 'working', 'open', 'interrupted', 'recent']);
  assert.match(html, /class="as-group needs-you"/);
  const text = words(html);
  assert.match(text, /1 needs you · 2 new replies · 3 working · checked just now/);
  for (const title of ['Needs you', 'New replies', 'Working', 'Open, your move', 'Interrupted', 'Earlier today']) assert.ok(text.includes(title), title);
  // Earlier today starts collapsed.
  assert.match(html, /aria-expanded="false"/);
  assert.ok(!text.includes('Weekly review prep'));
});

test('reasoned session names follow recent work while keeping the original name and explanation', () => {
  const session = { ...original.groups[0].sessions[0], title: 'Finish keyboard navigation in the preview', originalTitle: 'Can you look at this?', headline: 'Harbor · old workstream',
    titleReasoning: { summary: 'Later messages focus on keyboard access.', evidence: ['The latest request asks for arrow-key navigation.'], confidence: 'high', engine: 'local', model: 'local-model', updatedAt: new Date().toISOString() } };
  withGroups([{ ...original.groups[0], sessions: [session] }], () => {
    const html = board();
    assert.match(html, /class="as-open [^"]*"[^>]*>[\s\S]*?Finish keyboard navigation in the preview/);
    assert.ok(words(html).includes('“Can you look at this?”'), 'the original app title remains available');
    assert.ok(words(html).includes('From recent context'), 'the user can distinguish an inferred name');
    assert.match(html, /Later messages focus on keyboard access/);
    assert.match(html, /The latest request asks for arrow-key navigation/);
    assert.ok(!words(html).includes('old workstream'), 'a stale project address does not displace the new name');
    assert.match(html, /as-chip as-project/, 'project context remains visible beside a generated title');
  });
});

test('rows carry the title, place, state words, unread marks and the open action', () => {
  const html = board();
  const text = words(html);
  for (const expected of ['Onboarding checklist copy', 'Claude app', 'Harbor · calm-lighthouse-8611fb', 'Claude worktree', 'quiet-harbor-ff8777', 'Waiting for your OK · 4 min', 'Open in Claude',
    'New reply · 12 min ago', 'Working · 18 min', '2 helpers', 'Working · just started', 'Open, your move', 'Show folder', '~/Projects/Pocket Meter',
    'Interrupted when the app closed', 'Last active 2 h ago', 'Cursor is closed, so nothing there is running.', 'Claude app · 2 open', 'Hermes · 1 open']) assert.ok(text.includes(expected), expected);
  // Only outside New replies, where the heading already says every row is unread.
  assert.equal(html.match(/class="as-unread"/g)?.length, 1);
  assert.equal(html.match(/class="as-glyph working /g)?.length, 3);
  assert.match(html, /class="as-glyph needs /);
  assert.match(html, /class="as-glyph interrupted /);
  // One keyboard stop per row; the visible action button is a mouse shortcut for the same thing.
  assert.equal(html.match(/class="as-open/g)?.length, 8);
  assert.equal(html.match(/class="as-action" tabindex="-1" aria-hidden="true"/g)?.length, 8);
  assert.match(html, /Preview · sample sessions/);
  assert.match(html, /role="status" aria-live="polite"/);
});

test('long or guessed states keep the time on its own line and say how sure they are', () => {
  const guess = { ...original.groups[0].sessions[0], key: 'codex:desktop:11111111-2222-4333-8444-555555555555', app: 'codex', appLabel: 'Codex', title: 'Ranking model backfill',
    reason: 'Probably waiting for your OK', confidence: 'inferred', stateText: 'Probably waiting for your OK · 12 min', sinceText: '12 min', sinceAt: new Date(Date.now() - 12.2 * 60_000).toISOString(), openHint: 'Open in Codex' };
  const failed = { ...original.groups[0].sessions[0], key: 'claude:desktop:local_failed', activity: 'failed', reason: 'Stopped with a problem', stateText: 'Stopped with a problem', sinceText: '25 min ago',
    sinceAt: new Date(Date.now() - 25.2 * 60_000).toISOString(), updatedAt: new Date(Date.now() - 25.2 * 60_000).toISOString() };
  const html = withGroups([{ id: 'needs-you', title: 'Needs you', sessions: [guess, failed] }], () => board());
  const text = words(html);
  assert.ok(text.includes('Probably waiting for your OK For 12 min'), text);
  assert.ok(!text.includes('OK · 12 min'));
  assert.match(html, /class="as-glyph needs inferred"/);
  assert.match(html, /as-glyph-alert/);
  assert.ok(text.includes('Stopped with a problem Last active 25 min ago'));
  assert.ok(text.includes('2 need you'));
});

test('a calm board says nothing needs you, and keeps earlier sessions one click away', () => {
  const empty = words(withGroups([], () => board()));
  assert.ok(empty.includes('Nothing needs you. No agent is working right now.'));
  assert.ok(empty.includes('Nothing needs you and nothing is running'));
  const onlyRecent = withGroups([original.groups.find(group => group.id === 'recent')], () => board());
  assert.match(onlyRecent, /class="as-calm compact"/);
  assert.ok(words(onlyRecent).includes('Earlier today'));
  assert.ok(!/class="button primary small-button as-next" (?!disabled)/.test(onlyRecent), 'Next that needs you is disabled');
});

test('with the app bridge the board checks first, and an older window explains itself', () => {
  const checking = render(React.createElement(SessionsPanel, { preview: false, onClose() {}, bridge: { agentSessions: () => new Promise(() => {}), openAgentSession: async () => ({}) } }));
  assert.ok(words(checking).includes('Checking your agent sessions…'));
  assert.match(checking, /class="as-skeleton"/);
  assert.ok(!checking.includes('as-filter'));
  assert.ok(!checking.includes('Preview · sample sessions'));
  const older = words(render(React.createElement(SessionsPanel, { preview: false, onClose() {}, bridge: {} })));
  assert.ok(older.includes('Could not check your agent sessions.'));
  assert.ok(older.includes('Quit and reopen Summon'));
});

test('UI copy uses plain words without em dashes', () => {
  assert.ok(!words(board()).includes('—'));
  const strings = panel.source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.ok(!strings.includes('—'));
  for (const term of ['Needs you', 'New reply', 'Working', 'Open, your move', 'Interrupted', 'Helpers', 'Worktree', 'Probably']) assert.ok(panel.source.includes(`['${term}',`), term);
});

test('Work in flight folder rows show which agents are there', () => {
  const opened = render(React.createElement(WorkInFlightPanel, { preview: true, onClose() {}, onOpenSessions() {} }));
  assert.match(opened, /<button type="button" class="wif-chip wif-agent-chip needs"[^>]*>.*?Claude needs you here/);
  assert.match(opened, /class="wif-chip wif-agent-chip working"[^>]*><span class="wif-agent-pulse"/);
  assert.ok(words(opened).includes('New reply from Codex here'));
  const plain = render(React.createElement(WorkInFlightPanel, { preview: true, onClose() {} }));
  assert.match(plain, /<span class="wif-chip wif-agent-chip needs">/);
  assert.ok(!plain.includes('<button type="button" class="wif-chip wif-agent-chip'));
});

test('the toast sits above the footer, and a session that cannot be opened says so in full', () => {
  const html = board();
  const footer = html.slice(html.indexOf('<footer'), html.indexOf('</footer>') + 9);
  // Anchored to the footer, so a wrapped source strip or a warning row cannot land on top of it.
  assert.ok(footer.includes('class="as-toast "'), 'the toast is the footer\'s own child');
  assert.equal(html.indexOf('as-toast'), footer.indexOf('as-toast') + html.indexOf('<footer'), 'and it is nowhere else');
  assert.match(panel.source, /bottom: calc\(100% \+ 12px\)|as-toast/);

  const group = structuredClone(original.groups.find(item => item.id === 'open'));
  group.sessions[0] = { ...group.sessions[0], openable: 'none', openHint: 'Cannot be opened from Summon' };
  const inert = withGroups([group], () => board());
  assert.ok(words(inert).includes('Cannot open from here'), words(inert));
  assert.ok(!words(inert).includes('Not from here'));
  assert.match(inert, /class="as-cannot"[^>]*title="Cannot be opened from Summon"/, 'the core\'s own sentence is one hover away');
});

test('the work line says what a session is touching, and borrowed words wear a spark', () => {
  const html = board();
  const text = words(html);
  // Counts only: a plain line, no spark, and the row's dot in front of it.
  assert.ok(text.includes('+40 −6 in 2 files · mostly docs'), 'plain counts line');
  assert.match(html, /class="as-work "/);
  // The name in front carries the borrowed wording now, so the line under it is left with the counts alone.
  assert.ok(text.includes('Draft Board · Draft picks: faster counter-pick scoring'), 'borrowed wording leads the row');
  assert.ok(!html.includes('class="as-work borrowed"'), 'and is not said twice');
  // A session from an app version that sends no name in front keeps the spark line it always had.
  const older = { ...original.groups[1].sessions[0], headline: null };
  withGroups([{ id: 'new', title: 'New replies', sessions: [older] }], () => {
    const plain = board();
    assert.match(plain, /class="as-work borrowed" title="[^"]*In the words Work in flight used"/);
    assert.match(plain, /class="as-work-tail">[^<]*· 3 files/);
  });
  // A piece of work found by hashing file names is a guess, and the line that carries it says so.
  const guessed = { ...older, work: { ...older.work, workstreamInferred: true } };
  withGroups([{ id: 'new', title: 'New replies', sessions: [guessed] }], () => {
    assert.ok(words(board()).includes('Probably Draft picks: faster counter-pick scoring'), 'an inferred piece of work is hedged');
  });
  // Six of the eight sample rows with a work line are on screen; the other two sit in the collapsed Earlier today group.
  assert.equal(html.match(/class="as-where with-work"/g)?.length, 6);
  // A session the apps say nothing about keeps the row it always had.
  const bare = { ...original.groups[0].sessions[0], key: 'claude:desktop:local_nowork', work: null, workText: '' };
  withGroups([{ id: 'needs-you', title: 'Needs you', sessions: [bare] }], () => {
    const plain = board();
    assert.ok(!plain.includes('as-work'), 'no work line without counts');
    assert.match(plain, /class="as-where "/);
  });
});

test('a row Summon started wears a chip saying so, and no other row does', () => {
  const html = board();
  assert.equal(html.match(/class="as-chip as-origin"/g)?.length, 1);
  assert.ok(words(html).includes('Started from Summon'));
  const plain = { ...original.groups.find(group => group.id === 'open').sessions[0], key: 'claude:terminal:plain', startedFrom: null };
  const none = withGroups([{ id: 'open', title: 'Open, your move', sessions: [plain] }], () => board());
  assert.ok(!none.includes('as-origin'));
  const older = { ...plain, key: 'claude:terminal:older' };
  delete older.startedFrom;
  assert.ok(!withGroups([{ id: 'open', title: 'Open, your move', sessions: [older] }], () => board()).includes('as-origin'), 'a core that sends no field shows no chip');
});
