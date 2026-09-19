import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';

// Renders "Where this stands" from the panel sources, with the synthetic preview data only.
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
const flight = await load('WorkInFlightPanel.tsx', { './preview': preview });
const { WorkInFlightPanel } = flight.exports;
const sessions = await load('SessionsPanel.tsx', { './preview': preview });
const { SessionsPanel } = sessions.exports;
const view = preview.previewWorkInFlight;
const original = structuredClone(view.standing);

function render(element) {
  const saved = ['document', 'localStorage'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  Object.defineProperty(globalThis, 'document', { value: { activeElement: null, querySelector: () => null }, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => null, setItem() {} }, configurable: true, writable: true });
  try { return renderToStaticMarkup(element); }
  finally { for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } }
}
const words = html => html.replace(/<span class="sr-only">[^<]*<\/span>/g, '').replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const panel = (props = {}) => render(React.createElement(WorkInFlightPanel, { preview: true, onClose() {}, ...props }));
const board = (props = {}) => render(React.createElement(SessionsPanel, { preview: true, onClose() {}, ...props }));
const withStanding = (patch, fn) => { view.standing = { ...structuredClone(original), ...patch }; try { return fn(); } finally { view.standing = structuredClone(original); } };
// Draft Board needs a look, so it sorts above Harbor; each block is found by the project it belongs to.
const sample = preview.previewAgentSessions;
const groups = structuredClone(sample.groups);
const withGroups = (next, fn) => { const saved = sample.groups; sample.groups = next; try { return fn(); } finally { sample.groups = saved; } };
const block = (html, repoId) => { const at = html.indexOf(`id="wif-r_3a_${repoId}-d2"`); return at < 0 ? '' : html.slice(at, html.indexOf('</div>', at)); };

test('the top line is one sentence about what changed, with a quiet way to mark it read', () => {
  const html = panel();
  const text = words(html);
  assert.ok(text.includes('Since yesterday at 4pm, Harbor moved. 6 saves landed and 1 piece of work is now ready to save. Draft Board has not changed in 8 days.'), text.slice(0, 400));
  // The rail's top row is a guess, and the paragraph has no way to mark one, so the paragraph never speaks it.
  assert.ok(!text.includes('has an agent working without changing a file'), text.slice(0, 400));
  // It is a line of the page, not a card of its own, and it follows the totals.
  assert.ok(html.indexOf('class="wif-totals"') < html.indexOf('class="wif-standing"'), 'the sentence follows the totals');
  assert.match(html, /<p class="wif-standing">Since yesterday at 4pm/);
  assert.match(html, /class="text-button wif-mark" disabled=""/, 'nothing to mark without the app behind it');
  assert.ok(text.includes('Mark as read'));
  // Nothing counted yet means no line at all, rather than an empty one.
  withStanding({ text: '' }, () => assert.ok(!panel().includes('class="wif-standing"')));
});

test('an opened project lists what changed in it, four at a time', () => {
  const html = panel();
  const shown = block(html, 'harbor');
  assert.ok(words(shown).includes('Since you last looked'), shown);
  for (const line of ['6 saves landed in Main folder.', 'Saved “Add preview drawer to the templates tab”.', '2 pieces of work finished and left Main folder.', '1 piece of work is now ready to save in Main folder.']) assert.ok(words(shown).includes(line), line);
  // Four bullets, then the count of the rest. The sixth note is a guess, so it never crowds out a fact.
  assert.equal(shown.match(/<li class="[^"]*"[^>]*><span class="wif-standing-dot"/g)?.length, 4);
  assert.ok(words(shown).includes('(2 more)'), shown);
  assert.ok(!words(html).includes('without being saved'), 'the fifth and sixth notes wait behind the count');
  // The block is part of what a screen reader reads for that project.
  assert.match(html, /aria-describedby="wif-r_3a_harbor-d1 wif-r_3a_harbor-d2"/);
});

test('a guess disappears the moment the folder it was read from changes', () => {
  const before = words(panel());
  assert.ok(before.includes('An agent is working here and no file has changed in 44 minutes.'), 'the guess is on the rail');
  assert.ok(before.includes('2 pieces of work finished and left Main folder.'), 'and a project block carries its own');
  const after = withStanding({ fingerprints: { ...original.fingerprints, 'place-draft-codex': 'moved-on' } }, () => words(panel()));
  assert.ok(!after.includes('An agent is working here'), 'it goes the moment that folder changes');
  // The facts beside it are untouched.
  assert.ok(after.includes('6 saves landed in Main folder.'));
  assert.ok(after.includes('2 pieces of work finished and left Main folder.'));

  // The same rule inside a project's own block: the guess goes, and what was counted about that folder stays.
  const harborMoved = withStanding({ fingerprints: { ...original.fingerprints, 'place-harbor-main': 'moved-on' } }, () => words(panel()));
  assert.ok(!harborMoved.includes('2 pieces of work finished and left Main folder.'));
  assert.ok(harborMoved.includes('6 saves landed in Main folder.'), 'a save that happened stays a save that happened');

  // A folder that is gone from the scan is a folder whose evidence is gone, so its guess goes with it.
  const { 'place-draft-codex': _dropped, ...without } = original.fingerprints;
  const vanished = withStanding({ fingerprints: without }, () => words(panel()));
  assert.ok(!vanished.includes('An agent is working here'), 'a guess about a folder that is no longer there is not shown');
  assert.ok(vanished.includes('6 saves landed in Main folder.'), 'but a folder merely absent never withdraws a count');

  /* A counted line written in the present tense is a claim about now, not about a moment that happened, so this
     scan saying that folder has moved withdraws it too. This one is not on the rail, so nothing else hides it. */
  const claim = { id: 'still:place-harbor-claude:9', kind: 'still', text: 'Claude worktree: No file here has changed in 9 days.', inferred: false, placeId: 'place-harbor-claude', fingerprint: original.fingerprints['place-harbor-claude'] };
  const withClaim = patch => withStanding({ ...patch, byRepo: { ...original.byRepo, harbor: { ...original.byRepo.harbor, notes: [claim, ...original.byRepo.harbor.notes] } } }, () => words(panel()));
  assert.ok(withClaim({}).includes('No file here has changed in 9 days.'));
  assert.ok(!withClaim({ fingerprints: { ...original.fingerprints, 'place-harbor-claude': 'moved-on' } }).includes('No file here has changed in 9 days.'), 'a fact in the present tense goes when this scan disagrees with it');

  // An older core sends no fingerprints at all. Nothing is suppressed then, because nothing is known.
  const older = withStanding({ fingerprints: undefined }, () => words(panel()));
  assert.ok(older.includes('An agent is working here and no file has changed in 44 minutes.'));
});

test('the Not moving rail is said once, and a project block does not repeat it', () => {
  const html = panel();
  const main = words(html.slice(html.indexOf('class="wif-main"')));
  assert.equal(main.split('No file here has changed in 8 days.').length - 1, 1, 'the rail says it, and the project block above does not');
  assert.equal(main.split('An agent is working here and no file has changed in 44 minutes.').length - 1, 1);
  // Draft Board's only standing news was that it stopped, which is what the rail is for, so it has no block.
  assert.equal(block(html, 'draft_2d_board'), '', 'no "Since you last looked" heading over bullets about nothing happening');
  // Harbor's own bullets, which are not rail rows, are untouched.
  assert.ok(words(block(html, 'harbor')).includes('6 saves landed in Main folder.'));
});

test('the Not moving rail sits at the bottom, quiet, with the evidence beside each row', () => {
  const html = panel();
  const rail = html.slice(html.indexOf('class="wif-still"'));
  const text = words(rail);
  assert.ok(html.indexOf('class="wif-tree"') < html.indexOf('class="wif-still"'), 'it comes after the projects');
  assert.ok(text.includes('Not moving'), text);
  assert.ok(text.includes('Draft Board No file here has changed in 8 days.'), text);
  assert.ok(text.includes('Draft Board · Codex worktree · 0ced An agent is working here and no file has changed in 44 minutes'), text);
  // The reason carries its own how long, so the row never says it twice.
  assert.equal(text.match(/8 days/g)?.length, 1, text);
  // A guess is marked as one, both on screen and to a screen reader.
  assert.match(rail, /<li class="guess" title="A guess from what changed on disk\./);
  assert.ok(rail.includes('A guess from what changed on disk.</span>'));
  // Five rows at most, then the count of the rest.
  const many = Array.from({ length: 6 }, (_, index) => ({ ...original.notMoving[1], placeId: `place-${index}`, placeLabel: `Folder ${index}`, repoId: 'harbor', repoName: 'Harbor' }));
  const capped = withStanding({ notMoving: many }, () => panel());
  assert.equal(capped.match(/class="wif-still-name"/g)?.length, 5);
  assert.ok(words(capped).includes('(1 more)'));
  // Nothing has stopped, so there is no rail.
  withStanding({ notMoving: [] }, () => assert.ok(!panel().includes('class="wif-still"')));
});

test('the watermark waits for a look: never on open, three seconds on an expanded project', () => {
  const marks = [];
  const bridge = { workInFlight: () => new Promise(() => {}), markStanding: async repoId => { marks.push(repoId); } };
  render(React.createElement(WorkInFlightPanel, { preview: false, onClose() {}, bridge }));
  assert.deepEqual(marks, [], 'opening the panel marks nothing');
  const source = flight.source;
  assert.match(source, /const DWELL_MS = 3000;/);
  assert.match(source, /new IntersectionObserver/);
  // The three gates: expanded, enough of it on screen, and a window that is actually in front.
  assert.match(source, /element\.getAttribute\('aria-expanded'\) !== 'true'/);
  assert.match(source, /entry\.intersectionRect\.height >= Math\.min\(140, entry\.boundingClientRect\.height\)/);
  assert.match(source, /document\.visibilityState === 'visible'\) void mark\(repoId\)/);
  // Marking never rewrites the sentence being read: the panel keeps its view.
  assert.ok(!/markStanding\([^)]*\)\.then\(|setView\(await bridge\.markStanding/.test(source));
});

test('a session row leads with where it is and keeps the app’s own title underneath', () => {
  const html = board();
  const text = words(html);
  assert.ok(text.includes('Draft Board · Draft picks: faster counter-pick scoring'), 'the piece of work leads');
  assert.ok(text.includes('the app calls it “Counter-pick scoring tests”') || text.includes('“Counter-pick scoring tests”'), text.slice(0, 300));
  // Two lines: the name in front on one, the quoted title with its place and counts on the other.
  // The words in front are Work in flight's, so the spark that marks them travels with them.
  assert.match(html, /class="as-open "[^>]*><svg[^>]*as-lead-spark[^>]*>[\s\S]*?<\/svg><span class="sr-only">in the words Work in flight used, <\/span>Draft Board · Draft picks: faster counter-pick scoring/);
  // Summon says the title belongs to the session's app, which is all any reader but Claude tells it.
  assert.match(html, /class="as-title-quote auto" title="The title this session carries in its app\./);
  assert.ok(!html.includes('The title the app wrote for this session'), 'authorship is never claimed for a reader that reports none');
  assert.match(html, /class="as-title-quote own" title="The title you gave this session\./, 'a title he named himself reads differently');
  assert.ok(html.includes('<span class="sr-only">titled </span>') && html.includes('<span class="sr-only">you named it </span>'), 'and a screen reader hears the same two claims');
  // An address that would only repeat the project is no address, so that row keeps its own title in front.
  assert.match(html, /class="as-open "[^>]*>Pocket Meter release notes/);
  assert.ok(!text.includes('Pocket Meter · main folder'), 'the address that tells two rows apart no better than nothing is not printed');
  assert.equal(html.match(/as-chip as-project/g)?.length, 1, 'and it is the only row that needs the project chip back');
  assert.match(html, /class="as-chip as-place"[\s\S]*?Claude worktree<\/span>/, 'the folder kind the name in front left out is still shown');
  // A worktree the name in front left out does get its chip, since that is where the files are.
  const named = { ...groups[1].sessions[0], headline: 'Draft Board · Codex worktree', placeLabel: 'Codex worktree · 0ced' };
  withGroups([{ id: 'new', title: 'New replies', sessions: [named] }], () => {
    assert.ok(!board().includes('as-chip as-place'), 'and never when the name in front already carries it');
  });
  // A machine title Summon had to invent is not worth quoting.
  assert.ok(!text.includes('“Untitled Claude session”'));
  // With no project there is no address to lead with, so the app's own title keeps the front of the row.
  assert.match(html, /class="as-open "[^>]*>Morning desk summary/);
  assert.ok(!text.includes('Somewhere else'), 'and the core placeholder never reaches the screen');
});

test('the new words are plain, sentence case and free of em dashes', () => {
  for (const source of [flight.source, sessions.source]) assert.ok(!source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '').includes('—'));
  const html = panel();
  assert.ok(!words(html).includes('—'));
  for (const term of ['Moved', 'Landed', 'Not moving', 'Spinning']) assert.ok(flight.source.includes(`['${term}',`), term);
  assert.ok(sessions.source.includes("['The name in front',"));
});
