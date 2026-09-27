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
const names = (await load('session-names.ts', { './work-records': (await load('work-records.ts', {})).exports })).exports;
const panel = await load('SessionsPanel.tsx', { './preview': preview, './session-names': names });
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

test('a Summon name leads the row with its detail directly under it, and the app title moves to the tooltip', () => {
  const session = { ...original.groups[0].sessions[0], title: 'Email draft', titleDetail: 'Update on chart labels for Professor Rivera', originalTitle: 'Can you look at this?', titleSource: 'summon',
    headline: 'Harbor · Email draft', servesGoal: { id: 'rivera', title: 'Follow up with Professor Rivera', status: 'working' } };
  withGroups([{ ...original.groups[0], sessions: [session] }], () => {
    const html = board();
    const text = words(html);
    assert.match(html, /class="as-open "[^>]*><svg[^>]*as-lead-spark[^>]*>[\s\S]*?<\/svg><span class="sr-only">named by Summon, <\/span>Email draft/);
    // The specifics are the first words on the line under the name, ahead of the project.
    assert.match(html, /<div class="as-where[^"]*" id="[^"]*-where"><span class="as-name-detail">Update on chart labels for Professor Rivera<\/span><span class="as-chip as-project">/);
    assert.ok(!text.includes('Can you look at this?') && !html.includes('as-title-quote'), 'the app title is not on the row');
    assert.match(html, /class="as-open "[^>]*title="Named by Summon from the recent conversation\nEmail draft\nUpdate on chart labels for Professor Rivera\nApp title: “Can you look at this\?”\n/, 'the tooltip has the name, its detail and the app title');
    // A plain name does not say the goal, so the chip says it, with where it stands.
    assert.ok(text.includes('Follow up with Professor Rivera · Working'));
    assert.match(html, /title="Serves your saved goal “Follow up with Professor Rivera” · Working"/);
    assert.ok(!html.includes('as-updating') && !text.includes('From recent context'));
  });
  // Model-written words are text only, in the row and in the tooltip.
  withGroups([{ ...original.groups[0], sessions: [{ ...session, titleDetail: '<script>alert(1)</script>', originalTitle: '<img src=x onerror=alert(1)>' }] }], () => {
    const html = board();
    assert.ok(html.includes('<span class="as-name-detail">&lt;script&gt;alert(1)&lt;/script&gt;</span>') && html.includes('App title: “&lt;img src=x onerror=alert(1)&gt;”'));
    assert.ok(!html.includes('<script>') && !html.includes('<img'));
  });
  // Without a detail the line under the name is the place alone, and a detail that repeats the name is dropped.
  for (const titleDetail of ['', 'email draft']) withGroups([{ ...original.groups[0], sessions: [{ ...session, titleDetail }] }], () => {
    const html = board();
    assert.ok(!html.includes('as-name-detail') && !html.includes('as-title-quote'));
    assert.match(html, /<div class="as-where[^"]*" id="[^"]*-where"><span class="as-chip as-project">/);
  });
  // A bare name, with nothing to say under it, gets no line at all rather than an empty one.
  const bare = { ...session, titleDetail: '', project: null, folder: null, branch: null, servesGoal: null, work: null, workText: '' };
  withGroups([{ ...original.groups[0], sessions: [bare] }], () => {
    const html = board();
    assert.ok(!html.includes('as-where'), 'no place line');
    assert.match(html, /class="as-open "[^>]*aria-describedby="as-[^" ]*-state as-[^" ]*-hint"/, 'and nothing points at one');
  });
  // A name the conversation has moved past keeps showing, with one quiet word beside it.
  withGroups([{ ...original.groups[0], sessions: [{ ...session, titleOutdated: true }] }], () => {
    const html = board();
    assert.match(html, /class="as-updating" aria-hidden="true" title="The conversation has moved on[^"]*">updating<\/span>/);
    assert.match(html, /<span class="sr-only">, name updating, Claude app/);
  });
});

test('a session linked to a saved goal is named after it, and a title the person gave is never replaced', () => {
  const linked = { ...original.groups[0].sessions[0], title: 'Follow up with Professor Rivera', originalTitle: 'Onboarding checklist copy', titleSource: 'goal', servesGoal: { id: 'rivera', title: 'Follow up with Professor Rivera', status: 'planned' } };
  const own = { ...original.groups[1].sessions[1], titleSource: 'native', servesGoal: { id: 'importer', title: '<img src=x onerror=alert(1)> Check the importer', status: 'needs-verification' } };
  withGroups([{ ...original.groups[0], sessions: [linked] }, { ...original.groups[1], sessions: [own] }], () => {
    const html = board();
    const text = words(html);
    assert.match(html, /<span class="sr-only">named after your saved goal, <\/span>Follow up with Professor Rivera/);
    assert.ok(text.includes('“Onboarding checklist copy”') && text.includes('Saved goal · Planned'));
    // The person's own title keeps the row it always had; the goal it serves is spelled out, as text only.
    assert.match(html, /class="as-title-quote own"/);
    assert.ok(text.includes('Harbor · Pricing page: clearer plan table and copy'));
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt; Check the importer · Needs verification') && !html.includes('<img'));
  });
  // An older core sends no name fields at all, and the row keeps the app title it always led with.
  const older = { ...original.groups[2].sessions[2] };
  withGroups([{ ...original.groups[2], sessions: [older] }], () => assert.match(board(), /class="as-open "[^>]*>Morning desk summary/));
});

test('rows carry the title, place, state words, unread marks and the open action', () => {
  const html = board();
  const text = words(html);
  for (const expected of ['Onboarding copy edit', 'Checklist for new teams', 'Claude app', 'Harbor · Claude worktree', 'quiet-harbor-ff8777', 'Waiting for your OK · 4 min', 'Open in Claude',
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
  // The glossary describes today's plain names, and no longer an app title kept underneath in quotes.
  const glossary = words(board());
  assert.ok(glossary.includes('The name in front A short name for the work, written by Summon from the recent conversation') && glossary.includes('it starts with the specifics'));
  assert.ok(!/what it is doing about it now|stays underneath in quotes|leads with that goal/.test(glossary));
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
  // The privacy line says where the list is read and who writes the names, without claiming no message is ever read.
  const privacy = words(footer.slice(footer.indexOf('as-privacy')));
  assert.ok(privacy.includes('Read from each app’s own files on this Mac. Summon’s names are written from recent messages by the model set for context reasoning, which may be a local model or Claude or Codex in the cloud.'), privacy);
  assert.ok(!footer.includes('Never the conversations'));

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
  // Under Summon's own name the colon-style workstream title would read as a second name: the line keeps the counts,
  // and Work in flight's words wait in the tooltip.
  assert.match(html, /Preview drawer build<span class="sr-only">[\s\S]*?class="as-name-detail">Templates tab formatting compare<\/span>[\s\S]*?<span class="as-work " title="Templates tab: new preview and formatting compare \(still in progress\)\nIn the words Work in flight used"><span class="as-work-text">7 files<\/span><\/span>/);
  assert.ok(!text.includes('Templates tab: new preview and formatting compare'), 'the workstream title is not on the named row');
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
