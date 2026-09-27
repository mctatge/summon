import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSessionNames, linkedGoal, validateNames, buildNamesPacket, namesPrompt, conversationOf } from '../src/core/session-names.mjs';
import { evidenceMask } from '../src/core/context-reasoning.mjs';
import { CONTEXT_REASONING_LIMITS } from '../src/main/context-engine.mjs';
import { setSealedSegments } from '../src/core/workstreams.mjs';

const T0 = Date.parse('2026-09-26T12:00:00Z'), MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const iso = at => new Date(at).toISOString();
const say = (role, text, at = T0 - HOUR) => ({ role, text, at });
const session = (key, { repoId = 'harbor', project = 'Harbor', group = 'recent', activity = 'quiet', live = false, updatedAt = T0 - HOUR, title = 'Untraceable Excel file', titleIsAuto = true, titleIsFallback = false, folder = '/work/harbor', messages = [say('user', `Please check the spreadsheet import rule set and chart labels for ${key}`), say('assistant', 'Looking into it.')] } = {}) =>
  ({ key, title, titleIsFallback, titleIsAuto, headline: `${project} · ${title}`, project, repoId, folder, group, activity, live, updatedAt: iso(updatedAt), recentContext: { messages } });
const vocabulary = () => ({ privatePaths: { '/work/harbor': ['notes/people/'] }, repos: [
  { id: 'harbor', name: 'Harbor', path: '/work/harbor', workstreams: ['Import pipeline: spreadsheet checks', 'Grading export: rubric columns'] },
  { id: 'lighthouse', name: 'Lighthouse', path: '/work/lighthouse', workstreams: ['Nightly sweep: automated reports'] },
] });
const goal = (id, repoId, title, extra = {}) => ({ id, repoId, title, status: 'planned', ownerSessionKey: null, sessionKeys: [], links: { placeId: null, branch: null, sessionKey: null, component: null }, updatedAt: iso(T0 - DAY), ...extra });
const goals = () => [
  goal('g-rivera', 'harbor', 'Follow up with Professor Rivera', { status: 'working', ownerSessionKey: 'claude:h1', sessionKeys: ['claude:h1'] }),
  goal('g-import', 'harbor', 'Validate spreadsheet imports'),
  goal('g-report', 'lighthouse', 'Ship the nightly report'),
  goal('g-old', 'harbor', 'An earlier finished outcome', { status: 'done', sessionKeys: ['codex:h2'] }),
];
const defaultAnswer = packet => ({ names: packet.sessions.map((entry, index) => ({ sessionKey: entry.sessionKey, name: entry.servesGoal ? 'Professor follow-up' : 'Spreadsheet import checks', detail: `Rule set ${index + 1}`, goalId: entry.servesGoal?.id ?? null })) });
const turn = () => new Promise(resolve => setImmediate(resolve));
const byKey = view => new Map(view.groups.flatMap(group => group.sessions).map(item => [item.key, item]));

async function fixture(t, { sessions, extra = {} } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'summon-names-'));
  const state = { time: T0, sessions: sessions ?? [session('claude:h1'), session('codex:l1', { repoId: 'lighthouse', project: 'Lighthouse', folder: '/work/lighthouse' })], goals: goals(), enabled: true, paused: false, engine: 'codex', calls: [], answer: defaultAnswer };
  const services = [];
  const make = async (more = {}) => {
    const service = await createSessionNames({ dataDir, now: () => state.time, getSessions: async () => ({ groups: [{ id: 'all', sessions: structuredClone(state.sessions) }] }),
      getGoals: repoIds => state.goals.filter(item => repoIds.includes(item.repoId)), getVocabulary: async () => vocabulary(),
      infer: async (engine, request) => { const packet = JSON.parse(request.prompt.split('SESSIONS_JSON:\n')[1]); state.calls.push({ engine, request, packet }); return { raw: await state.answer(packet, engine), model: 'synthetic' }; },
      selectEngine: async () => state.engine, isEnabled: () => state.enabled, isPaused: () => state.paused, ...extra, ...more });
    services.push(service); return service;
  };
  const service = await make();
  t.after(async () => { for (const item of services) await item.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, state, service, make, file: path.join(dataDir, 'session-names.json'), advance: ms => { state.time += ms; } };
}

test('candidates span every project, skip user-named, sealed, stale and wordless sessions, and put needs-you and working first', async t => {
  setSealedSegments(['sealed-client']); t.after(() => setSealedSegments([]));
  const f = await fixture(t, { sessions: [
    session('codex:quiet-new', { updatedAt: T0 - 10 * MINUTE }),
    session('codex:quiet-old', { updatedAt: T0 - 2 * DAY }),
    session('claude:working', { repoId: 'lighthouse', project: 'Lighthouse', group: 'working', activity: 'working', updatedAt: T0 - 3 * HOUR }),
    session('claude:needs', { group: 'needs-you', activity: 'needs-you', updatedAt: T0 - 5 * HOUR }),
    session('cursor:live', { repoId: null, project: null, group: 'open', live: true, updatedAt: T0 - 6 * DAY }),
    session('claude:named-by-you', { titleIsAuto: false }),
    session('codex:sealed', { folder: '/work/sealed-client/app' }),
    session('codex:week-old', { updatedAt: T0 - 8 * DAY }),
    session('codex:live-old', { live: true, updatedAt: T0 - 9 * DAY }),
    session('codex:no-user', { messages: [say('assistant', 'Only a greeting.')] }),
  ] });
  await f.service.refresh();
  assert.equal(f.state.calls.length, 1);
  const { packet, request, engine } = f.state.calls[0];
  assert.equal(engine, 'codex');
  assert.deepEqual(packet.sessions.map(item => item.sessionKey), ['claude:needs', 'claude:working', 'cursor:live', 'codex:live-old', 'codex:quiet-new', 'codex:quiet-old']);
  assert.deepEqual(packet.repos.map(repo => repo.id).sort(), ['harbor', 'lighthouse'], 'every project is named, not only the selected one');
  assert.equal(packet.sessions.find(item => item.sessionKey === 'cursor:live').repoId, null);
  assert.equal(request.schema.properties.names.maxItems, 6);
  assert.deepEqual(request.schema.properties.names.items.required, ['sessionKey', 'name', 'detail', 'goalId']);
  assert.equal(f.service.read().candidates, 0);
  assert.deepEqual(Object.keys(f.service.read().names).sort(), packet.sessions.map(item => item.sessionKey).sort());
});

test('the local model gets a batch of three; the rest wait for the next pass', async t => {
  const f = await fixture(t, { sessions: Array.from({ length: 5 }, (_, index) => session(`codex:s${index}`, { updatedAt: T0 - index * MINUTE })) });
  f.state.engine = 'local';
  await f.service.refresh();
  assert.deepEqual(f.state.calls[0].packet.sessions.map(item => item.sessionKey), ['codex:s0', 'codex:s1', 'codex:s2']);
  assert.equal(f.state.calls[0].request.schema.properties.names.maxItems, 3);
  assert.equal(f.service.read().candidates, 2);
  f.advance(2 * MINUTE); await f.service.refresh();
  assert.deepEqual(f.state.calls[1].packet.sessions.map(item => item.sessionKey), ['codex:s3', 'codex:s4']);
});

test('an unchanged conversation is never named twice; a new turn makes it a candidate again', async t => {
  const f = await fixture(t);
  await f.service.refresh();
  f.advance(10 * MINUTE); await f.service.refresh({ force: true });
  assert.equal(f.state.calls.length, 1, 'nothing changed, so even a forced pass sends nothing');
  f.state.sessions[1].recentContext.messages.push(say('assistant', 'The report now runs nightly.', T0));
  f.advance(2 * MINUTE); await f.service.refresh();
  assert.equal(f.state.calls.length, 1, 'assistant progress alone is not a new direction');
  f.state.sessions[1].recentContext.messages.push(say('user', 'Now run the report every night', T0));
  await f.service.refresh();
  assert.equal(f.state.calls.length, 2);
  assert.deepEqual(f.state.calls[1].packet.sessions.map(item => item.sessionKey), ['codex:l1']);
});

test('the served goal comes from the work records: its owner first, then the newest link, open goals of the same repository only', () => {
  const key = 'claude:h9';
  const at = hours => iso(T0 - hours * HOUR);
  const list = [
    goal('newest-link', 'harbor', 'Newest link', { sessionKeys: [key], updatedAt: at(1) }),
    goal('owned', 'harbor', 'Owned', { ownerSessionKey: key, status: 'blocked', updatedAt: at(10) }),
    goal('other-repo', 'lighthouse', 'Other project', { ownerSessionKey: key, updatedAt: at(0) }),
    goal('finished', 'harbor', 'Finished', { ownerSessionKey: key, status: 'done', updatedAt: at(0) }),
  ];
  assert.equal(linkedGoal({ key, repoId: 'harbor' }, list).id, 'owned');
  const withoutOwner = list.filter(item => item.id !== 'owned').concat(goal('older-link', 'harbor', 'Older link', { links: { sessionKey: key }, status: 'needs-verification', updatedAt: at(5) }));
  assert.equal(linkedGoal({ key, repoId: 'harbor' }, withoutOwner).id, 'newest-link');
  assert.equal(linkedGoal({ key, repoId: 'harbor' }, withoutOwner.filter(item => item.id !== 'newest-link')).id, 'older-link');
  assert.equal(linkedGoal({ key, repoId: null }, list), null);
  assert.equal(linkedGoal({ key: 'claude:unlinked', repoId: 'harbor' }, list), null);
});

test('the prompt carries the served goal, the saved goals and workstream wording, and masked conversation text only', async t => {
  const f = await fixture(t, { sessions: [session('claude:h1', { messages: [
    say('user', 'Draft a reply to rivera@example.edu using notes/people/rivera-meeting.md, key sk-abcdefghijklmnopqrstuvwxy123456'),
    say('assistant', 'Drafted it from /Users/someone/Desktop/grades.csv.'),
    say('user', 'Now shorten the reply and mention the rubric'),
  ] })] });
  await f.service.refresh();
  const { request, packet } = f.state.calls[0];
  assert.match(request.prompt, /untrusted evidence/);
  assert.match(request.prompt, /latest direction/);
  assert.deepEqual(packet.sessions[0].servesGoal, { id: 'g-rivera', title: 'Follow up with Professor Rivera', status: 'working' });
  assert.deepEqual(packet.repos[0].goals.map(item => item.id), ['g-rivera', 'g-import'], 'open goals of the same repository, the served one first');
  assert.deepEqual(packet.repos[0].workstreams, ['Import pipeline: spreadsheet checks', 'Grading export: rubric columns']);
  assert.equal(packet.repos[0].name, 'Harbor');
  assert.deepEqual(packet.sessions[0].conversation.map(item => item.role), ['user', 'assistant', 'user'], 'chronological, latest direction included');
  assert.match(request.prompt, /shorten the reply/);
  assert.doesNotMatch(request.prompt, /rivera@example|rivera-meeting|sk-abcdefghijkl|\/Users\/someone|g-report|Lighthouse/);
});

test('validation keeps one name per supplied session and drops unknown keys, other repositories\' goals and empty names', () => {
  const safe = evidenceMask({});
  const packet = { repos: [{ id: 'harbor', name: 'Harbor', goals: [{ id: 'g-import' }] }, { id: 'lighthouse', name: 'Lighthouse', goals: [{ id: 'g-report' }] }], sessions: [
    { sessionKey: 'a', repoId: 'harbor', servesGoal: { id: 'g-rivera' }, conversation: [{ role: 'user', text: 'Update the chart labels for the professor' }] }, { sessionKey: 'b', repoId: 'harbor', servesGoal: null },
    { sessionKey: 'c', repoId: 'harbor', servesGoal: null }, { sessionKey: 'd', repoId: null, project: 'Scratch', servesGoal: null }, { sessionKey: 'e', repoId: 'lighthouse', servesGoal: null, conversation: [{ role: 'user', text: 'Rerun the failed Tuesday report' }] },
  ] };
  const name = (sessionKey, text, detail, goalId = null) => ({ sessionKey, name: text, detail, goalId });
  const names = validateNames({ names: [
    name('a', 'Professor follow-up', 'Chart label update', 'g-rivera'),
    name('a', 'A second name', 'Ignored'),
    name('b', 'Spreadsheet import checks', 'New rules', 'g-report'),
    name('c', '   ', 'An empty name'),
    name('d', 'Setup', '   '),
    name('e', 'Nightly report rerun', 'The failed Tuesday report', 'g-report'),
    name('zzz', 'Unknown', 'Session'),
  ] }, packet, safe);
  assert.deepEqual([...names.keys()], ['a', 'd', 'e'], 'b linked another repository\'s goal, c had no name');
  assert.deepEqual(names.get('a'), { name: 'Professor follow-up', detail: 'Chart label update', goalId: 'g-rivera' }, 'the served goal counts even when it is not listed');
  assert.deepEqual(names.get('d'), { name: 'Setup', detail: '', goalId: null }, 'an empty detail is fine');
  assert.deepEqual(names.get('e'), { name: 'Nightly report rerun', detail: 'The failed Tuesday report', goalId: 'g-report' });
  assert.throws(() => validateNames({ names: 'nope' }, packet, safe), /invalid session names/);
});

// One answer validated against Harbor ('h') or a session outside any repository whose project is Scratch ('x').
const nameOne = (name, detail = '', { sessionKey = 'h', goalId = null } = {}) => validateNames({ names: [{ sessionKey, name, detail, goalId }] }, {
  repos: [{ id: 'harbor', name: 'Harbor', goals: [{ id: 'g-import' }] }, { id: 'lighthouse', name: 'Lighthouse', goals: [{ id: 'g-report' }] }],
  sessions: [{ sessionKey: 'h', repoId: 'harbor', servesGoal: null, conversation: [{ role: 'user', text: 'Login is broken: password reset emails are not arriving for new accounts on the phone' }] },
    { sessionKey: 'x', repoId: null, project: 'Scratch', servesGoal: null, conversation: [{ role: 'user', text: 'Sort the scratch notes' }] }] }, evidenceMask({})).get(sessionKey);

test('validation cuts a leading "Project:", capitalizes the first letter, strips quotes and turns dashes into commas', () => {
  assert.deepEqual(nameOne('Harbor: Login bug fix'), { name: 'Login bug fix', detail: '', goalId: null });
  assert.equal(nameOne('harbor: login bug fix').name, 'Login bug fix');
  assert.equal(nameOne('login bug fix').name, 'Login bug fix');
  assert.deepEqual(nameOne('"Login bug fix"', '“Password reset emails”'), { name: 'Login bug fix', detail: 'Password reset emails', goalId: null });
  assert.equal(nameOne("'trip planning'").name, 'Trip planning');
  assert.equal(nameOne('Login bug fix.').name, 'Login bug fix', 'trailing punctuation goes');
  assert.equal(nameOne('Login bug fix', 'Reset emails — not arriving').detail, 'Reset emails, not arriving');
  assert.equal(nameOne('Login bug fix', 'Reset emails–not arriving.').detail, 'Reset emails, not arriving');
});

test('validation drops names over five words or 32 characters and names that are only the project', () => {
  assert.equal(nameOne('Fix the login bug now').name, 'Fix the login bug now', 'five words are kept');
  assert.equal(nameOne('Fix the login bug right now'), undefined, 'six words are dropped');
  assert.equal('Spreadsheet import rules checkup'.length, 32);
  assert.equal(nameOne('Spreadsheet import rules checkup').name, 'Spreadsheet import rules checkup', '32 characters are kept');
  assert.equal(nameOne('Spreadsheet import rules checkups'), undefined, '33 characters are dropped');
  for (const name of ['Harbor', 'HARBOR', 'harbor', 'Harbor:', '"Harbor"']) assert.equal(nameOne(name, 'Login bug'), undefined, `${name} is only the project`);
  assert.equal(nameOne('scratch', '', { sessionKey: 'x' }), undefined, 'a session outside a repository is checked against its own project');
});

test('validation blanks a detail that repeats the name or the project or runs over 60 characters, and keeps the name', () => {
  assert.deepEqual(nameOne('Login bug fix', 'login bug fix'), { name: 'Login bug fix', detail: '', goalId: null });
  assert.equal(nameOne('Login bug fix', 'Harbor').detail, '');
  assert.equal(nameOne('Login bug fix', 'harbor.').detail, '');
  assert.equal(nameOne('Trip planning', 'SCRATCH', { sessionKey: 'x' }).detail, '');
  const sixty = 'Password reset emails not arriving for new accounts on phone';
  assert.equal(sixty.length, 60);
  assert.deepEqual(nameOne('Login bug fix', sixty), { name: 'Login bug fix', detail: sixty, goalId: null });
  assert.deepEqual(nameOne('Login bug fix', `${sixty}s`), { name: 'Login bug fix', detail: '', goalId: null }, 'a 61-character detail is left out, the name stays');
});

test('validation cuts any leading label without digits and turns Title Case into sentence case', () => {
  assert.equal(nameOne('Templates: login fix').name, 'Login fix');
  assert.equal(nameOne('10:30 login reminder').name, '10:30 login reminder', 'a colon with digits stays');
  assert.equal(nameOne('Login bug fix', 'Mail: password reset emails').detail, 'Password reset emails');
  assert.equal(nameOne('Login Bug Fix').name, 'Login bug fix');
  assert.equal(nameOne('MacBook Login Fix').name, 'MacBook login fix', 'mixed-case words keep their capitals');
  assert.equal(nameOne('Login API Fix').name, 'Login API fix', 'all-capital words stay');
  assert.equal(nameOne('Login bug fix', 'Password Reset Emails').detail, 'Password Reset Emails', 'a detail keeps its capitals');
});

test('validation drops the assistant\'s voice, filler words and copied examples, and blanks details that report progress', () => {
  assert.equal(nameOne('Let me fix login'), undefined);
  assert.equal(nameOne('Robust login handling'), undefined);
  assert.equal(nameOne('Login bug fix', 'Comprehensive password reset overhaul').detail, '');
  assert.equal(nameOne('Refund question'), undefined, 'an example with nothing from this conversation was copied');
  assert.equal(nameOne('Login bug fix').name, 'Login bug fix', 'an example the conversation supports is fine');
  for (const detail of ['Restart the reset mailer', 'Checking reset emails', 'Fix the reset emails', 'Running reset emails again']) assert.equal(nameOne('Login bug fix', detail).detail, '', detail);
  for (const detail of ['Test failures in password reset', 'Fix for reset emails', 'Draft of the reset email', 'Finding lost reset emails']) assert.equal(nameOne('Login bug fix', detail).detail, detail, `${detail} names a thing`);
});

test('a name masked away entirely is not kept, so no row turns blank', t => {
  setSealedSegments(['sealed-client']); t.after(() => setSealedSegments([]));
  assert.equal(nameOne('Sealed-client login fix'), undefined);
});

test('a goal id of another repository, or any goal for a session outside one, drops the whole entry', () => {
  assert.equal(nameOne('Nightly report rerun', 'The Tuesday report', { goalId: 'g-report' }), undefined);
  assert.equal(nameOne('Import checks', '', { goalId: 'g-unknown' }), undefined);
  assert.equal(nameOne('Scratch notes', '', { sessionKey: 'x', goalId: 'g-import' }), undefined);
  assert.equal(nameOne('Import checks', '', { goalId: 'g-import' }).goalId, 'g-import');
});

test('names persist privately across a restart; the file holds names and a hash, never conversation text', async t => {
  const f = await fixture(t);
  await f.service.refresh();
  await f.service.close();
  const stat = await fs.stat(f.file);
  assert.equal(stat.mode & 0o777, 0o600);
  const raw = await fs.readFile(f.file, 'utf8');
  assert.doesNotMatch(raw, /Please check|Looking into it/);
  const saved = JSON.parse(raw);
  assert.equal(saved.version, 1);
  assert.deepEqual(Object.keys(saved.sessions['claude:h1']).sort(), ['detail', 'engine', 'fingerprint', 'goalId', 'intent', 'name', 'namedAt', 'seenAt']);
  const again = await f.make();
  assert.deepEqual(again.read().names['claude:h1'], { name: 'Professor follow-up', detail: 'Rule set 1', goalId: 'g-rivera', namedAt: iso(T0), engine: 'codex' });
  const shown = byKey(again.decorate({ groups: [{ id: 'all', sessions: f.state.sessions }] }));
  assert.equal(shown.get('claude:h1').title, 'Professor follow-up'); assert.equal(shown.get('claude:h1').titleDetail, 'Rule set 1');
  assert.equal(shown.get('codex:l1').title, 'Spreadsheet import checks'); assert.equal(shown.get('codex:l1').titleDetail, 'Rule set 2');
  await again.refresh({ force: true });
  assert.equal(f.state.calls.length, 1, 'a restart does not rename unchanged sessions');
});

test('a stored name in the old shape is ignored on load and the session is named again', async t => {
  const f = await fixture(t);
  await f.service.refresh();
  await f.service.close();
  const saved = JSON.parse(await fs.readFile(f.file, 'utf8'));
  // Same fingerprint as the current conversation, so only the shape can send it back for naming.
  const { goalId, fingerprint, namedAt, seenAt, engine } = saved.sessions['claude:h1'];
  saved.sessions['claude:h1'] = { title: 'Follow up with Professor Rivera: Check the new rules 1', forWhat: 'Follow up with Professor Rivera', doing: 'Check the new rules 1', goalId, fingerprint, namedAt, seenAt, engine };
  await fs.writeFile(f.file, JSON.stringify(saved));
  const again = await f.make();
  assert.deepEqual(Object.keys(again.read().names), ['codex:l1']);
  const shown = byKey(again.decorate({ groups: [{ id: 'all', sessions: f.state.sessions }] })).get('claude:h1');
  assert.equal(shown.titleSource, 'goal', 'until it is named again the served goal shows'); assert.equal(shown.title, 'Follow up with Professor Rivera');
  await again.refresh();
  assert.deepEqual(f.state.calls[1].packet.sessions.map(item => item.sessionKey), ['claude:h1']);
  assert.equal('previousName' in f.state.calls[1].packet.sessions[0], false, 'an old entry is not offered as a previous name');
  await again.close();
  const rewritten = JSON.parse(await fs.readFile(f.file, 'utf8')).sessions['claude:h1'];
  assert.deepEqual(Object.keys(rewritten).sort(), ['detail', 'engine', 'fingerprint', 'goalId', 'intent', 'name', 'namedAt', 'seenAt']);
  assert.equal(rewritten.name, 'Professor follow-up');
});

test('the store is bounded, prunes names not seen for 30 days, and keeps names that are still seen', async t => {
  const f = await fixture(t);
  const entry = seenDaysAgo => ({ name: 'Spreadsheet import checks', detail: 'Rule set', goalId: null, fingerprint: 'a'.repeat(32), namedAt: iso(T0 - 40 * DAY), seenAt: iso(T0 - seenDaysAgo * DAY), engine: 'claude' });
  await fs.writeFile(f.file, JSON.stringify({ version: 1, sessions: { 'codex:gone': entry(31), 'codex:recent': entry(2), 'codex:older': entry(10), 'codex:oldest': entry(20), 'codex:bad': { name: 'x', detail: '', engine: 'gemini' } } }));
  const bounded = await f.make({ limits: { sessions: 2 } });
  assert.deepEqual(Object.keys(bounded.read().names).sort(), ['codex:older', 'codex:recent']);
  const seen = await f.make();
  assert.deepEqual(Object.keys(seen.read().names).sort(), ['codex:older', 'codex:oldest', 'codex:recent']);
  f.state.sessions = [session('codex:oldest', { messages: [say('user', 'Earlier request')] })];
  f.state.enabled = true;
  await seen.poll(); await turn(); await seen.close();
  f.advance(21 * DAY);
  const later = await f.make();
  assert.deepEqual(Object.keys(later.read().names).sort(), ['codex:oldest', 'codex:recent'], 'a listed session keeps its name; unseen ones age out');
});

test('an unreadable names file is left untouched; names then live in memory and the problem is reported', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file, '{broken');
  const service = await f.make();
  assert.match(service.read().problem, /left untouched/);
  await service.refresh();
  assert.equal(await fs.readFile(f.file, 'utf8'), '{broken');
  assert.equal(byKey(service.decorate({ groups: [{ id: 'all', sessions: f.state.sessions }] })).get('codex:l1').titleSource, 'summon');
});

test('at most one call per interval, backoff after failures, no calls while disabled or paused, and a forced pass once', async t => {
  let failing = true;
  const f = await fixture(t);
  f.state.answer = packet => { if (failing) throw new Error('secret provider token'); return defaultAnswer(packet); };
  await f.service.refresh();
  assert.equal(f.state.calls.length, 1);
  assert.equal(f.service.read().status, 'error');
  assert.match(f.service.read().error, /Check the selected model or CLI login/);
  assert.doesNotMatch(f.service.read().error, /secret/);
  for (const wait of [120, 240, 480, 960, 1800, 1800]) {
    const before = f.state.calls.length;
    f.advance(wait * 1000 - 1000); await f.service.refresh(); assert.equal(f.state.calls.length, before, `nothing is sent before ${wait} s`);
    f.advance(1000); await f.service.refresh(); assert.equal(f.state.calls.length, before + 1, `a new attempt at ${wait} s`);
  }
  await f.service.refresh({ force: true });
  assert.equal(f.state.calls.length, 8, 'a forced pass is never held back');
  f.advance(119_000); await f.service.refresh(); assert.equal(f.state.calls.length, 8);
  failing = false;
  f.advance(1000); await f.service.refresh();
  assert.equal(f.state.calls.length, 9, 'after a forced pass the wait starts again at two minutes');
  assert.equal(f.service.read().status, 'ready'); assert.equal(f.service.read().error, null);
  f.state.sessions.push(session('codex:h3', { updatedAt: T0 }));
  f.advance(60_000); await f.service.refresh();
  assert.equal(f.state.calls.length, 9, 'a new session waits for the interval');
  f.state.enabled = false;
  f.advance(10 * MINUTE); await f.service.refresh({ force: true });
  assert.equal(f.state.calls.length, 9); assert.equal(f.service.read().status, 'disabled');
  f.state.enabled = true; f.state.paused = true;
  await f.service.refresh({ force: true }); f.service.poll(); await turn();
  assert.equal(f.state.calls.length, 9, 'paused observation sends nothing');
  f.state.paused = false;
  f.service.poll(); await turn(); await turn();
  assert.equal(f.state.calls.length, 10);
});

test('a failed session read is reported, does not count as a model failure and never blocks the next pass', async t => {
  const f = await fixture(t);
  let broken = true;
  const service = await f.make({ getSessions: () => { if (broken) throw new Error('Agent sessions are not available right now.'); return { groups: [{ sessions: structuredClone(f.state.sessions) }] }; } });
  await service.refresh();
  assert.equal(service.read().status, 'error'); assert.match(service.read().error, /could not be read for naming/);
  assert.equal(f.state.calls.length, 0);
  broken = false;
  await service.refresh();
  assert.equal(f.state.calls.length, 1, 'no model wait was started by the failed read');
  assert.equal(service.read().status, 'ready'); assert.equal(service.read().error, null);
});

test('a refused cloud answer is asked for once more; the local model is asked once', async t => {
  const f = await fixture(t);
  let refusals = 1;
  f.state.answer = packet => refusals-- > 0 ? { names: 'not a list' } : defaultAnswer(packet);
  await f.service.refresh();
  assert.equal(f.state.calls.length, 2); assert.equal(f.service.read().status, 'ready');
  const g = await fixture(t);
  g.state.engine = 'local'; g.state.answer = () => ({ names: 'not a list' });
  await g.service.refresh();
  assert.equal(g.state.calls.length, 1); assert.match(g.service.read().error, /could not use/);
});

test('a conversation that moves on during generation keeps its old name; the others are stored', async t => {
  let release;
  const f = await fixture(t);
  f.state.answer = async packet => { await new Promise(resolve => { release = resolve; }); return defaultAnswer(packet); };
  const pending = f.service.refresh(); await turn(); await turn();
  f.state.sessions[0].recentContext.messages.push(say('user', 'Actually, schedule a call instead', T0));
  release(); await pending;
  assert.deepEqual(Object.keys(f.service.read().names), ['codex:l1']);
  f.state.answer = defaultAnswer;
  f.advance(2 * MINUTE); await f.service.refresh();
  assert.deepEqual(f.state.calls[1].packet.sessions.map(item => item.sessionKey), ['claude:h1']);
  f.state.answer = async packet => { await new Promise(resolve => { release = resolve; }); return defaultAnswer(packet); };
  f.state.sessions[1].recentContext.messages.push(say('user', 'Rerun it tonight', T0));
  f.advance(2 * MINUTE);
  const disabled = f.service.refresh(); await turn(); await turn();
  f.state.enabled = false; release(); await disabled;
  assert.equal(f.service.read().names['codex:l1'].detail, 'Rule set 2', 'turning reasoning off discards a pass in flight');
});

test('a forced pass asked for during an automatic one runs right after it', async t => {
  const f = await fixture(t);
  let hold;
  const getSessions = async () => { if (hold) await hold; return { groups: [{ sessions: structuredClone(f.state.sessions) }] }; };
  const service = await f.make({ getSessions });
  await service.refresh();
  assert.equal(f.state.calls.length, 1);
  f.state.sessions.push(session('codex:h4', { updatedAt: T0 }));
  let release; hold = new Promise(resolve => { release = resolve; });
  const automatic = service.refresh(), click = service.refresh({ force: true });
  hold = null; release(); await automatic; await click;
  for (let i = 0; i < 4; i++) await turn();
  assert.equal(f.state.calls.length, 2, 'the click ran after the held-back automatic pass');
});

test('decorate shows Summon names, then the served goal, then the app title; user-named titles always stay', async t => {
  const f = await fixture(t, { sessions: [
    session('claude:h1'),
    session('codex:l1', { repoId: 'lighthouse', project: 'Lighthouse', folder: '/work/lighthouse' }),
    session('codex:h2', { title: 'Untitled Codex session', titleIsFallback: true }),
    session('claude:mine', { title: 'My rubric session', titleIsAuto: false }),
  ] });
  f.state.goals.push(goal('g-mine', 'harbor', 'Publish the rubric', { links: { sessionKey: 'claude:mine' } }));
  const views = () => ({ groups: [{ id: 'all', sessions: structuredClone(f.state.sessions) }] });
  let shown = byKey(f.service.decorate(views()));
  assert.deepEqual({ ...shown.get('claude:h1'), recentContext: undefined }, { ...f.state.sessions[0], recentContext: undefined, title: 'Follow up with Professor Rivera', titleIsFallback: false, originalTitle: 'Untraceable Excel file', titleSource: 'goal', headline: 'Harbor · Follow up with Professor Rivera', servesGoal: { id: 'g-rivera', title: 'Follow up with Professor Rivera', status: 'working' } });
  assert.equal(shown.get('codex:l1').titleSource, 'native'); assert.equal(shown.get('codex:l1').title, 'Untraceable Excel file'); assert.equal(shown.get('codex:l1').servesGoal, undefined);
  assert.equal(shown.get('claude:mine').title, 'My rubric session'); assert.equal(shown.get('claude:mine').titleSource, 'native');
  assert.deepEqual(shown.get('claude:mine').servesGoal, { id: 'g-mine', title: 'Publish the rubric', status: 'planned' });

  f.state.answer = packet => ({ names: packet.sessions.map(entry => ({ sessionKey: entry.sessionKey, name: entry.servesGoal ? 'Professor follow-up' : entry.repoId === 'lighthouse' ? 'Nightly report rerun' : 'Spreadsheet import checks', detail: entry.servesGoal ? 'Chart label update' : '', goalId: entry.servesGoal?.id ?? (entry.repoId === 'harbor' ? 'g-import' : null) })) });
  await f.service.refresh();
  assert.deepEqual(f.state.calls[0].packet.sessions.map(item => item.sessionKey).sort(), ['claude:h1', 'codex:h2', 'codex:l1'], 'user-named sessions are never sent for naming');
  shown = byKey(f.service.decorate(views()));
  assert.deepEqual({ ...shown.get('claude:h1'), recentContext: undefined }, { ...f.state.sessions[0], recentContext: undefined, title: 'Professor follow-up', titleIsFallback: false, originalTitle: 'Untraceable Excel file', titleSource: 'summon', titleDetail: 'Chart label update', headline: 'Harbor · Professor follow-up', servesGoal: { id: 'g-rivera', title: 'Follow up with Professor Rivera', status: 'working' } }, 'the name alone is the title; the detail rides beside it; not outdated');
  assert.deepEqual(shown.get('codex:h2').servesGoal, { id: 'g-import', title: 'Validate spreadsheet imports', status: 'planned' }, 'a stored goal id resolves to the current goal');
  assert.equal(shown.get('codex:h2').originalTitle, undefined, 'a placeholder app title is not kept as the original');
  assert.equal(shown.get('codex:h2').title, 'Spreadsheet import checks'); assert.equal('titleDetail' in shown.get('codex:h2'), false, 'an empty detail adds no line');
  assert.equal(shown.get('codex:l1').title, 'Nightly report rerun'); assert.equal(shown.get('codex:l1').headline, 'Lighthouse · Nightly report rerun');

  f.state.sessions[0].recentContext.messages.push(say('user', 'Now book the meeting room', T0));
  f.state.sessions[3].titleIsAuto = false;
  f.advance(MINUTE); await f.service.refresh();
  assert.equal(f.state.calls.length, 1, 'still inside the interval');
  shown = byKey(f.service.decorate(views()));
  assert.equal(shown.get('claude:h1').title, 'Professor follow-up', 'the name stays while the conversation moves on');
  assert.equal(shown.get('claude:h1').titleDetail, 'Chart label update');
  assert.equal(shown.get('claude:h1').titleOutdated, true);
  f.state.sessions[1].titleIsAuto = false;
  shown = byKey(f.service.decorate(views()));
  assert.equal(shown.get('codex:l1').title, 'Untraceable Excel file', 'a session renamed by its owner keeps that name');
  assert.equal(shown.get('codex:l1').titleSource, 'native');
  assert.equal(f.service.decorate(null), null);
});

test('a stored name rides along when its conversation moves on, so a name that still fits can be kept', async t => {
  const f = await fixture(t);
  f.state.answer = packet => ({ names: packet.sessions.map(entry => ({ sessionKey: entry.sessionKey, name: entry.previousName?.name ?? (entry.servesGoal ? 'Professor follow-up' : 'Nightly report rerun'), detail: entry.servesGoal ? 'Chart labels' : '', goalId: null })) });
  await f.service.refresh();
  assert.equal(f.state.calls[0].packet.sessions.some(item => 'previousName' in item), false, 'a first naming has no previous name');
  f.state.sessions[0].recentContext.messages.push(say('user', 'Also mention the legend colors', T0));
  f.state.sessions[1].recentContext.messages.push(say('user', 'Rerun it tonight', T0));
  f.advance(2 * MINUTE); await f.service.refresh();
  assert.deepEqual(f.state.calls[1].packet.sessions.map(item => [item.sessionKey, item.previousName]), [['claude:h1', { name: 'Professor follow-up', detail: 'Chart labels' }], ['codex:l1', { name: 'Nightly report rerun', detail: '' }]]);
  const shown = byKey(f.service.decorate({ groups: [{ id: 'all', sessions: f.state.sessions }] })).get('claude:h1');
  assert.equal(shown.title, 'Professor follow-up'); assert.equal(shown.titleOutdated, undefined, 'the kept name is current again');
});

test('the packet stays inside the model prompt limit with many projects, goals and long non-ASCII turns', () => {
  const safe = evidenceMask({});
  const long = char => char.repeat(1000);
  const batch = Array.from({ length: 8 }, (_, index) => ({ session: session(`codex:s${index}`, { repoId: `r${index}`, messages: [...Array.from({ length: 5 }, () => say('user', long('漢'))), say('assistant', long('語'))] }), serves: goal(`g${index}`, `r${index}`, '語'.repeat(240), { status: 'working' }), previous: { name: '名'.repeat(40), detail: '細'.repeat(80) } }));
  const list = batch.flatMap(({ session: item }) => Array.from({ length: 30 }, (_, index) => goal(`${item.repoId}-g${index}`, item.repoId, '漢'.repeat(240))));
  const vocab = { repos: batch.map(({ session: item }) => ({ id: item.repoId, name: '港'.repeat(200), workstreams: Array.from({ length: 6 }, () => '語'.repeat(200)) })) };
  for (const local of [false, true]) {
    const chosen = local ? batch.slice(0, 3) : batch;
    const packet = buildNamesPacket(chosen, { vocabulary: vocab, goals: list, safe, local });
    const prompt = namesPrompt(packet);
    assert.ok(Buffer.byteLength(prompt) < (local ? 16_000 : CONTEXT_REASONING_LIMITS.promptBytes), `${local ? 'local' : 'cloud'} prompt is ${Buffer.byteLength(prompt)} bytes`);
    for (const entry of packet.sessions) assert.ok(entry.conversation.some(item => item.role === 'user'), 'every session keeps its latest direction');
    for (const entry of packet.sessions) assert.ok(entry.previousName.name.length <= 32 && entry.previousName.detail.length <= 60, 'a previous name is bounded like a new one');
  }
  assert.deepEqual(conversationOf({ recentContext: { messages: [say('user', 'a'), say('assistant', 'b'), say('user', 'c'), say('assistant', 'd')] } }, safe), { users: ['a', 'c'], assistant: 'd' });
});

test('the naming prompt forbids expanding abbreviations the evidence does not spell out', () => {
  const prompt = namesPrompt(buildNamesPacket([], { safe: text => text }));
  assert.match(prompt, /Never expand an abbreviation or acronym \(a place, school, company or product\) unless the evidence spells it out/);
});
