import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSessionNames, validateNames, namesSchema, namesPrompt, buildNamesPacket } from '../src/core/session-names.mjs';
import { evidenceMask } from '../src/core/context-reasoning.mjs';

// When a name is made again, what a busy session costs, and what the board shows when naming is off or privacy changes.
const T0 = Date.parse('2026-09-26T12:00:00Z'), MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const iso = at => new Date(at).toISOString();
const say = (role, text, at = T0 - HOUR) => ({ role, text, at });
const session = (key, { repoId = 'harbor', project = 'Harbor', group = 'recent', activity = 'quiet', live = false, updatedAt = T0 - HOUR, title = 'Chart export question', titleIsFallback = false, request = `Plan the ${key.split(':')[1]} newsletter` } = {}) =>
  ({ key, title, titleIsFallback, titleIsAuto: true, project, repoId, folder: '/work/harbor', group, activity, live, updatedAt: iso(updatedAt), recentContext: { messages: [say('user', request), say('assistant', 'Starting on it.')] } });
const working = key => session(key, { group: 'working', activity: 'working', live: true, updatedAt: T0 });
// Names that use words from each session's own request, so they pass the grounding check.
const answer = packet => ({ names: packet.sessions.map(entry => ({ sessionKey: entry.sessionKey, name: 'Newsletter planning', detail: `The ${entry.sessionKey.split(':')[1]} newsletter`, goalId: entry.servesGoal?.id ?? null })) });
const turn = () => new Promise(resolve => setImmediate(resolve));
const byKey = view => new Map(view.groups.flatMap(group => group.sessions).map(item => [item.key, item]));

async function fixture(t, sessions) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'summon-names-pacing-'));
  const state = { time: T0, sessions, goals: [], enabled: true, engine: 'local', scope: 'a', calls: [], reads: 0, onRead: () => {}, answer };
  const make = () => createSessionNames({ dataDir, now: () => state.time,
    getSessions: async () => { state.reads++; state.onRead(state); return { groups: [{ id: 'all', sessions: structuredClone(state.sessions) }] }; },
    getGoals: repoIds => state.goals.filter(item => repoIds.includes(item.repoId)), getVocabulary: async () => ({ repos: [{ id: 'harbor', name: 'Harbor', path: '/work/harbor', workstreams: [] }] }),
    infer: async (engine, request) => { const packet = JSON.parse(request.prompt.split('SESSIONS_JSON:\n')[1]); state.calls.push({ engine, request, packet }); return { raw: await state.answer(packet), model: 'synthetic' }; },
    selectEngine: async () => state.engine, isEnabled: () => state.enabled, isPaused: () => false, getScope: () => state.scope });
  const service = await make();
  t.after(async () => { await service.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, state, service, make, advance: ms => { state.time += ms; }, keys: call => call.packet.sessions.map(item => item.sessionKey) };
}
const progress = (state, keys) => { for (const item of state.sessions) if (keys.includes(item.key)) item.recentContext.messages.push(say('assistant', `Progress ${state.reads}`, state.time)); };

test('assistant progress during generation never sets a name aside, so busy sessions cannot starve the rest', async t => {
  const busy = ['claude:alpha', 'claude:beta', 'claude:gamma'];
  const f = await fixture(t, [...busy.map(working), session('codex:delta'), session('codex:epsilon')]);
  // Every read finds the three working sessions one progress line further on.
  f.state.onRead = state => progress(state, busy);
  for (let pass = 0; pass < 4; pass++) { await f.service.refresh(); f.advance(2 * MINUTE); }
  assert.deepEqual(f.state.calls.map(f.keys), [busy, ['codex:delta', 'codex:epsilon']], 'two local calls name all five; the working three are kept');
  assert.equal(f.service.read().candidates, 0);
  for (let pass = 0; pass < 6; pass++) { await f.service.refresh(); f.advance(2 * MINUTE); }
  assert.equal(f.state.calls.length, 2, 'progress alone never renames a session that is still working');
});

test('a new request during generation sets that name aside behind the sessions not yet tried', async t => {
  const f = await fixture(t, ['alpha', 'beta', 'gamma', 'delta'].map(name => session(`codex:${name}`, { updatedAt: T0 - MINUTE })));
  f.state.onRead = state => { if (state.reads === 2) state.sessions[0].recentContext.messages.push(say('user', 'Make the alpha newsletter shorter', state.time)); };
  await f.service.refresh();
  assert.deepEqual(f.keys(f.state.calls[0]), ['codex:alpha', 'codex:beta', 'codex:gamma']);
  assert.deepEqual(Object.keys(f.service.read().names).sort(), ['codex:beta', 'codex:gamma']);
  f.advance(2 * MINUTE); await f.service.refresh();
  assert.deepEqual(f.keys(f.state.calls[1]), ['codex:delta', 'codex:alpha'], 'the untried session goes first');
  assert.deepEqual(Object.keys(f.service.read().names).sort(), ['codex:alpha', 'codex:beta', 'codex:delta', 'codex:gamma']);
});

test('assistant-only drift renames a quiet session once its name has stood for half an hour; a new request is marked at once', async t => {
  const f = await fixture(t, [session('codex:alpha'), working('claude:beta')]);
  await f.service.refresh();
  assert.equal(f.state.calls.length, 1);
  progress(f.state, ['codex:alpha', 'claude:beta']);
  f.advance(10 * MINUTE); await f.service.refresh();
  assert.equal(f.state.calls.length, 1, 'too soon for drift');
  let shown = byKey(f.service.decorate({ groups: [{ id: 'all', sessions: f.state.sessions }] }));
  assert.equal(shown.get('codex:alpha').titleOutdated, undefined, 'assistant progress alone is not shown as updating');
  f.advance(25 * MINUTE); await f.service.refresh();
  assert.deepEqual(f.keys(f.state.calls[1]), ['codex:alpha'], 'the quiet session is looked at again; the working one is not');
  assert.equal(f.state.calls[1].packet.sessions[0].previousName.name, 'Newsletter planning', 'so a name that still fits can be kept');
  f.state.sessions[1].recentContext.messages.push(say('user', 'Also plan the beta newsletter footer', f.state.time));
  f.state.answer = () => { throw new Error('offline'); };
  f.advance(2 * MINUTE); await f.service.refresh();
  shown = byKey(f.service.decorate({ groups: [{ id: 'all', sessions: f.state.sessions }] }));
  assert.equal(shown.get('claude:beta').titleOutdated, true, 'a new request from the owner shows the quiet updating mark');
  assert.equal(shown.get('claude:beta').title, 'Newsletter planning', 'the old name stays until a new one is made');
});

test('turning reasoning off takes model names off the board but keeps names from saved goals, and never shows a closed goal', async t => {
  const f = await fixture(t, [session('codex:alpha'), session('codex:beta')]);
  f.state.goals = [{ id: 'g-rivera', repoId: 'harbor', title: 'Follow up with Professor Rivera', status: 'working', ownerSessionKey: 'codex:beta', sessionKeys: [], links: {} },
    { id: 'g-done', repoId: 'harbor', title: 'Send the spring newsletter', status: 'working', ownerSessionKey: null, sessionKeys: [], links: {} }];
  f.state.answer = packet => ({ names: packet.sessions.map(entry => ({ sessionKey: entry.sessionKey, name: 'Newsletter planning', detail: '', goalId: entry.sessionKey === 'codex:alpha' ? 'g-done' : entry.servesGoal?.id ?? null })) });
  await f.service.refresh();
  const view = () => byKey(f.service.decorate({ groups: [{ id: 'all', sessions: f.state.sessions }] }));
  assert.equal(view().get('codex:alpha').servesGoal.id, 'g-done');
  f.state.goals[1].status = 'dismissed';
  assert.equal(view().get('codex:alpha').servesGoal, undefined, 'a closed goal is never shown as served');
  f.state.enabled = false;
  const off = view();
  assert.equal(off.get('codex:alpha').titleSource, 'native'); assert.equal(off.get('codex:alpha').title, 'Chart export question');
  assert.equal(off.get('codex:beta').titleSource, 'goal'); assert.equal(off.get('codex:beta').title, 'Follow up with Professor Rivera');
  f.state.enabled = true;
  assert.equal(view().get('codex:alpha').titleSource, 'summon', 'turning it back on shows the saved names again');
});

test('a change to the private paths drops every saved name and discards a pass in flight', async t => {
  const f = await fixture(t, [session('codex:alpha'), session('codex:beta')]);
  await f.service.refresh();
  assert.equal(Object.keys(f.service.read().names).length, 2);
  f.state.scope = 'b';
  assert.equal(byKey(f.service.decorate({ groups: [{ id: 'all', sessions: f.state.sessions }] })).get('codex:alpha').titleSource, 'native');
  assert.deepEqual(f.service.read().names, {});
  let release; f.state.answer = async packet => { await new Promise(resolve => { release = resolve; }); return answer(packet); };
  const pending = f.service.refresh({ force: true }); for (let i = 0; i < 4; i++) await turn();
  f.state.scope = 'c'; release(); await pending;
  assert.deepEqual(f.service.read().names, {}, 'names made under the old settings are not kept');
});

test('a reader that returns no sessions at all is not a list with nothing to name', async t => {
  const f = await fixture(t, [session('codex:alpha')]);
  f.state.engine = 'codex';
  await f.service.refresh();
  f.state.sessions[0].recentContext.messages.push(say('user', 'Now plan the alpha newsletter for May', T0));
  f.state.answer = () => { throw new Error('offline'); };
  f.advance(2 * MINUTE); await f.service.refresh();
  assert.equal(f.service.read().candidates, 1);
  const saved = f.state.sessions; f.state.sessions = [];
  f.advance(10 * MINUTE); await f.service.refresh();
  assert.equal(f.service.read().candidates, 1, 'the last known state stands');
  assert.equal(byKey(f.service.decorate({ groups: [{ id: 'all', sessions: saved }] })).get('codex:alpha').titleOutdated, true);
  assert.equal(f.state.calls.length, 2, 'nothing is sent for an empty read');
  f.state.sessions = saved; f.state.answer = answer; await f.service.refresh();
  assert.equal(f.state.calls.length, 3);
  assert.equal(byKey(f.service.decorate({ groups: [{ id: 'all', sessions: saved }] })).get('codex:alpha').titleOutdated, undefined);
});

test('the answer format has no confidence field, and names are checked without one', () => {
  assert.deepEqual(namesSchema(3).properties.names.items.required, ['sessionKey', 'name', 'detail', 'goalId']);
  const packet = { repos: [{ id: 'harbor', name: 'Harbor', goals: [], workstreams: [] }], sessions: [{ sessionKey: 'a', repoId: 'harbor', servesGoal: null, conversation: [{ role: 'user', text: 'Remind me about the 10:30 standup and the login bug' }] }] };
  const one = (name, detail = '') => validateNames({ names: [{ sessionKey: 'a', name, detail, goalId: null }] }, packet, evidenceMask({})).get('a');
  assert.equal(one('10:30 standup reminder').name, '10:30 standup reminder', 'a colon inside a time is not a label');
  assert.equal(one('Harbor: login bug fix').name, 'Login bug fix');
});

test('the packet offers the app title as a hint of the original purpose, masked, and never an invented one', () => {
  const safe = evidenceMask({ privatePaths: { '/work/harbor': ['notes/people/'] }, repos: [{ id: 'harbor', name: 'Harbor', path: '/work/harbor' }] });
  const item = (key, extra) => ({ session: { ...session(key, extra), recentContext: { messages: [say('user', 'yes'), say('assistant', 'Pushed to main.')] } }, serves: null, previous: null });
  const packet = buildNamesPacket([item('codex:alpha', { title: 'Restore saved filters on the search page for sam@example.org' }), item('codex:beta', { title: 'Untitled Codex session', titleIsFallback: true })], { safe });
  assert.equal(packet.sessions[0].appTitle, 'Restore saved filters on the search page for [redacted]');
  assert.equal('appTitle' in packet.sessions[1], false);
  const prompt = namesPrompt(packet);
  assert.match(prompt, /bare go-ahead or confirmation/);
  assert.match(prompt, /never the mechanical step/);
  assert.match(prompt, /appTitle/);
  assert.doesNotMatch(prompt, /confidence/);
  // After a bare "yes", the app title is what ties a name to the session.
  const named = validateNames({ names: [{ sessionKey: 'codex:alpha', name: 'Search filter fix', detail: 'Saved filters on the search page', goalId: null }] }, packet, safe).get('codex:alpha');
  assert.deepEqual(named, { name: 'Search filter fix', detail: 'Saved filters on the search page', goalId: null });
});

test('a name saved without the owner\'s latest request is made again, keeping the saved one as the previous name', async t => {
  const f = await fixture(t, [session('codex:alpha')]);
  const entry = { name: 'Newsletter planning', detail: 'The alpha newsletter', goalId: null, fingerprint: 'a'.repeat(32), namedAt: iso(T0 - DAY), seenAt: iso(T0 - DAY), engine: 'codex' };
  await fs.writeFile(path.join(f.dataDir, 'session-names.json'), JSON.stringify({ version: 1, sessions: { 'codex:alpha': entry } }));
  const service = await f.make();
  t.after(() => service.close());
  assert.equal(byKey(service.decorate({ groups: [{ id: 'all', sessions: f.state.sessions }] })).get('codex:alpha').title, 'Newsletter planning');
  await service.refresh();
  assert.equal(f.state.calls.length, 1);
  assert.deepEqual(f.state.calls[0].packet.sessions[0].previousName, { name: 'Newsletter planning', detail: 'The alpha newsletter' });
  await service.close();
  const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'session-names.json'), 'utf8')).sessions['codex:alpha'];
  assert.match(saved.intent, /^[0-9a-f]{32}$/);
  assert.deepEqual(Object.keys(saved).sort(), ['detail', 'engine', 'fingerprint', 'goalId', 'intent', 'name', 'namedAt', 'seenAt'], 'hashes and names only, never conversation text');
});
