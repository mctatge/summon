import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { buildContextEvidence, contextPrompt, localContextEvidence, CONTEXT_SCHEMA, LOCAL_CONTEXT_SCHEMA, validateContextResult, createContextReasoning } from '../src/core/context-reasoning.mjs';

const at = Date.parse('2026-09-20T12:00:00Z');
const session = (text = 'Fix the pause detection and keep listening') => ({ key: 'codex:desktop:1', title: 'Hello', titleIsAuto: true, repoId: 'r1', project: 'Project', updatedAt: new Date(at).toISOString(), recentContext: { messages: [{ role: 'user', text, at }] } });
const input = () => ({ flight: { repos: [{ id: 'r1', name: 'Project', path: '/project', places: [] }] }, sessions: { groups: [{ sessions: [session()] }] }, snapshot: { projects: [{ id: 'p1', path: '/project' }], currentProjectId: 'p1', settings: { activityEnabled: true, accessibilityEnabled: true, excludedApps: ['Passwords'] }, activity: { app: 'Editor', title: 'voice.ts', at: new Date(at).toISOString(), suggestedProjectId: 'p1' } } });
const answer = (evidence = ['E1']) => ({ summary: 'Improving voice conversation.', goals: [{ repoId: 'r1', title: 'Keep voice listening through pauses', status: 'working', summary: 'The latest request asks for continuous listening.', confidence: 'high', evidence }] });

test('prompt uses recent user direction, current app evidence and selected project without treating app selection as proof', () => {
  const packet = buildContextEvidence(input(), at);
  assert.equal(packet.selectedRepoId, 'r1');
  assert.equal(packet.evidence[0].role, 'user');
  assert.equal(packet.evidence[1].kind, 'active-app');
  assert.match(contextPrompt(packet), /latest user direction/);
  assert.match(contextPrompt(packet), /Keep|keep listening/);
  assert.match(contextPrompt(packet), /untrusted evidence/);
});

test('assistant progress messages cannot crowd the latest user direction out of the model packet', () => {
  const value = input();
  const messages = value.sessions.groups[0].sessions[0].recentContext.messages;
  messages.push(...Array.from({ length: 5 }, (_, index) => ({ role: 'assistant', text: `Progress update ${index}`, at })));
  const packet = buildContextEvidence(value, at);
  assert.equal(packet.evidence.filter(item => item.kind === 'conversation').length, 4);
  assert.ok(packet.evidence.some(item => item.role === 'user' && item.text.includes('keep listening')));
});

test('inferences require known evidence and same-project user intent', () => {
  const value = input();
  value.sessions.groups[0].sessions.push({ ...session('Build a calendar'), key: 'other', repoId: 'r2' });
  const packet = buildContextEvidence(value, at);
  const valid = validateContextResult(answer(), packet, { engine: 'local', updatedAt: new Date(at).toISOString() });
  assert.equal(valid.goals.length, 1);
  assert.equal(valid.goals[0].links.sessionKey, 'codex:desktop:1');
  for (const evidence of [['unknown'], ['E2'], ['E3']]) assert.equal(validateContextResult(answer(evidence), packet, { engine: 'local' }).goals.length, 0);
});

test('secrets and private paths are masked before generation', () => {
  const value = input();
  value.privatePaths = { '/project': ['private/'] };
  value.sessions.groups[0].sessions[0] = session('Work on private/payroll.csv with api_key=sk-abcdefghijklmnopqrstuvwxy123456');
  assert.doesNotMatch(contextPrompt(buildContextEvidence(value, at)), /payroll|sk-abcdefghijkl/);
});

test('goal reasoning no longer names sessions; session-names.mjs owns names', async t => {
  const packet = buildContextEvidence(input(), at);
  assert.doesNotMatch(contextPrompt(packet), /sessionTitles|title each session|canRename/);
  assert.equal(packet.sessions[0].canRename, undefined);
  assert.deepEqual(Object.keys(CONTEXT_SCHEMA.properties), ['summary', 'goals']);
  assert.deepEqual(Object.keys(validateContextResult({ ...answer(), sessionTitles: [{ sessionKey: 'codex:desktop:1', title: 'Old style name' }] }, packet)), ['summary', 'goals']);
  const f = await fixture(t); await f.service.refresh();
  assert.equal(f.service.read().sessionTitles, undefined);
  assert.equal(f.service.decorateSessions, undefined);
});

test('private path filtering covers every repository beyond the per-helper 40-prefix limit', () => {
  const value = input();
  value.flight.repos.push({ id: 'r2', name: 'Beta', path: '/tmp/Beta', places: [] });
  value.privatePaths = { '/project': Array.from({ length: 40 }, (_, i) => `folder${i}/`), '/tmp/Beta': ['restricted/'] };
  value.utterances = [{ text: 'Work on /tmp/Beta/restricted/launch-plan.md', at, projectId: 'p1' }];
  assert.doesNotMatch(contextPrompt(buildContextEvidence(value, at)), /launch-plan/);
});

test('total evidence packet remains below the model prompt limit with many projects and non-ASCII text', () => {
  const value = input();
  value.flight.repos = Array.from({ length: 30 }, (_, i) => ({ id: `r${i}`, name: `Project ${i}`, path: `/p${i}`, places: [{ grouping: { workstreams: [{ title: '漢'.repeat(500) }, { title: '語'.repeat(500) }] } }, { grouping: { workstreams: [{ title: '漢'.repeat(500) }, { title: '語'.repeat(500) }] } }] }));
  value.sessions.groups[0].sessions = Array.from({ length: 8 }, (_, i) => ({ ...session(), key: `s${i}`, recentContext: { messages: Array.from({ length: 4 }, () => ({ role: 'user', text: '漢'.repeat(1000), at })) } }));
  value.explicitGoals = Array.from({ length: 24 }, () => ({ repoId: 'r1', title: '語'.repeat(500), status: 'working' }));
  assert.ok(Buffer.byteLength(contextPrompt(buildContextEvidence(value, at))) < 48000);
});

test('local reasoning bounds the workload while retaining the latest user direction for each included session', () => {
  const value = input();
  value.sessions.groups[0].sessions = Array.from({ length: 8 }, (_, index) => ({ ...session(), key: `s${index}`, recentContext: { messages: [
    { role: 'user', text: `Latest request ${index}: ${'漢'.repeat(1000)}`, at },
    { role: 'assistant', text: '語'.repeat(1000), at },
  ] } }));
  const packet = localContextEvidence(buildContextEvidence(value, at));
  assert.equal(packet.sessions.length, 3);
  assert.ok(packet.evidence.reduce((bytes, item) => bytes + Buffer.byteLength(JSON.stringify(item)), 0) <= 6000);
  for (const session of packet.sessions) assert.ok(packet.evidence.some(item => item.sessionKey === session.key && item.role === 'user'));
  assert.ok(packet.evidence.every(item => !item.sessionKey || packet.sessions.some(session => session.key === item.sessionKey)));
  assert.equal(LOCAL_CONTEXT_SCHEMA.properties.goals.maxItems, 2);
  assert.equal(LOCAL_CONTEXT_SCHEMA.properties.goals.items.properties.evidence.maxItems, 2);
  assert.match(contextPrompt(packet), /up to 2 current goals,/);
});

test('excluded apps, private documents, paused collection and disabled window context cannot enter app evidence', () => {
  for (const modify of [
    value => { value.snapshot.activity.app = 'Passwords'; },
    value => { value.snapshot.settings.paused = true; },
    value => { value.snapshot.settings.activityEnabled = false; },
    value => { value.privatePaths = { '/project': ['private/'] }; value.snapshot.activity.documentPath = '/project/private/payroll.csv'; },
  ]) {
    const value = input(); modify(value);
    assert.equal(buildContextEvidence(value, at).evidence.some(item => item.kind === 'active-app'), false);
  }
  const value = input(); value.snapshot.settings.accessibilityEnabled = false;
  assert.doesNotMatch(contextPrompt(buildContextEvidence(value, at)), /voice.ts/);
});

async function fixture(t, extra = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'summon-context-test-'));
  let current = input(), time = at, scope = 'one'; const calls = [];
  const service = await createContextReasoning({ dataDir, getInput: async () => current, getScope: () => scope, now: () => time, selectEngine: async () => 'codex', infer: async (engine, request) => { calls.push({ engine, request }); return { raw: answer(), model: 'test-model' }; }, ...extra });
  t.after(async () => { await service.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { service, calls, dataDir, setInput: value => { current = value; }, advance: amount => { time += amount; }, setScope: value => { scope = value; } };
}

test('changed evidence refreshes goals, unchanged polling is free, failures retain visible stale state', async t => {
  const f = await fixture(t);
  await f.service.refresh();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].engine, 'codex');
  assert.equal(f.service.read().status, 'ready');
  f.advance(130_000); await f.service.refresh(); assert.equal(f.calls.length, 1);
  const changed = input(); changed.sessions.groups[0].sessions[0] = session('Now improve the calendar');
  f.setInput(changed);
  await f.service.refresh(); assert.equal(f.calls.length, 2);
  await f.service.updateSettings({ engine: 'local' });
  assert.equal(f.service.read().goals.length, 0);
  await f.service.refresh(); assert.equal(f.calls.at(-1).engine, 'local');
  const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'context-reasoning.json'), 'utf8'));
  assert.deepEqual(saved, { enabled: true, engine: 'local', claudeModel: 'sonnet', codexModel: 'gpt-6-luna' });
});

test('background reasoning models: defaults, strict values, and a file from before them loads untouched', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'summon-context-models-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const file = path.join(dataDir, 'context-reasoning.json'), older = JSON.stringify({ enabled: false, engine: 'codex' });
  await fs.writeFile(file, older);
  const service = await createContextReasoning({ dataDir, getInput: async () => input() });
  t.after(() => service.close());
  assert.deepEqual(service.settings(), { enabled: false, engine: 'codex', claudeModel: 'sonnet', codexModel: 'gpt-6-luna' });
  assert.deepEqual(service.read().settings, service.settings());
  assert.equal(await fs.readFile(file, 'utf8'), older, 'loading never rewrites the file');
  service.settings().codexModel = 'gpt-6-sol';
  assert.equal(service.settings().codexModel, 'gpt-6-luna', 'callers get a copy');
  for (const patch of [{ codexModel: 'gpt-5' }, { codexModel: 'GPT-6-Luna' }, { codexModel: '--model' }, { codexModel: null }, { codexModel: undefined }, { claudeModel: 'claude-opus-4-1' }, { claudeModel: 'sonnet ' }, { claudeModel: 1 }, { model: 'gpt-6-luna' }, { codexModel: 'gpt-6-luna', extra: true }, ['gpt-6-luna'], null]) {
    await assert.rejects(service.updateSettings(patch), /Invalid reasoning settings/, JSON.stringify(patch));
  }
  assert.equal(await fs.readFile(file, 'utf8'), older, 'a refused patch writes nothing');
  await service.updateSettings({ codexModel: 'default' });
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { enabled: false, engine: 'codex', claudeModel: 'sonnet', codexModel: 'default' }, 'the next change writes the whole object');
  await service.updateSettings({ claudeModel: 'haiku', codexModel: 'gpt-6-astra' });
  const reopened = await createContextReasoning({ dataDir, getInput: async () => input() });
  t.after(() => reopened.close());
  assert.deepEqual(reopened.settings(), { enabled: false, engine: 'codex', claudeModel: 'haiku', codexModel: 'gpt-6-astra' });
  // A saved model this version does not offer (a list that dropped it, a file a newer build wrote) falls back to its
  // default in memory and is reported; it is never passed on, and the file is left as it is.
  const unknown = JSON.stringify({ enabled: true, engine: 'claude', claudeModel: 'opus-9', codexModel: 'gpt-4o' });
  await fs.writeFile(file, unknown);
  const warnings = [];
  const lenient = await createContextReasoning({ dataDir, getInput: async () => input(), warn: message => warnings.push(message) });
  t.after(() => lenient.close());
  assert.deepEqual(lenient.settings(), { enabled: true, engine: 'claude', claudeModel: 'sonnet', codexModel: 'gpt-6-luna' });
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /saved Claude model is not one this version offers.*sonnet/);
  assert.match(warnings[1], /saved Codex model is not one this version offers.*gpt-6-luna/);
  assert.ok(warnings.every(message => !/opus-9|gpt-4o/.test(message)), 'the unknown value is not repeated');
  assert.equal(await fs.readFile(file, 'utf8'), unknown, 'loading never rewrites the file');
  for (const value of [{ codexModel: 7 }, { claudeModel: null }]) {
    await fs.writeFile(file, JSON.stringify({ enabled: true, engine: 'auto', ...value }));
    const service = await createContextReasoning({ dataDir, getInput: async () => input() });
    t.after(() => service.close());
    assert.deepEqual(service.settings(), { enabled: true, engine: 'auto', claudeModel: 'sonnet', codexModel: 'gpt-6-luna' }, JSON.stringify(value));
  }
  // Everything else in the file is still checked strictly.
  for (const bad of [{ enabled: true, engine: 'gpt-6-luna' }, { enabled: 'yes' }, { enabled: true, model: 'gpt-6-luna' }]) {
    await fs.writeFile(file, JSON.stringify(bad));
    await assert.rejects(createContextReasoning({ dataDir }), /left untouched/, JSON.stringify(bad));
  }
});

test('a model change clears only a reading made with that model, and the status line never names the old one', async t => {
  // The reading came from Codex: changing the Claude model leaves it, and the engine and model it names, as they are.
  const f = await fixture(t);
  await f.service.refresh();
  assert.deepEqual([f.service.read().engine, f.service.read().model, f.service.read().goals.length], ['codex', 'test-model', 1]);
  let view = await f.service.updateSettings({ claudeModel: 'haiku' });
  assert.deepEqual([view.engine, view.model, view.status, view.goals.length], ['codex', 'test-model', 'ready', 1]);
  // Changing the Codex model clears the reading together with the engine and model its status line showed.
  view = await f.service.updateSettings({ codexModel: 'gpt-6-sol' });
  assert.deepEqual([view.engine, view.model, view.status, view.updatedAt, view.goals.length], [null, null, 'idle', null, 0]);
  // A failed pass with the new model is not shown beside the previous model's name.
  const failing = await fixture(t, { infer: async () => { throw new Error('This account cannot use that model.'); } });
  await failing.service.updateSettings({ engine: 'claude' });
  await failing.service.refresh({ force: true });
  assert.deepEqual([failing.service.read().status, failing.service.read().engine, failing.service.read().model], ['error', 'claude', null]);
  view = await failing.service.updateSettings({ claudeModel: 'opus' });
  assert.deepEqual([view.status, view.error, view.engine, view.model], ['idle', null, null, null], 'a change to the model that failed starts over');
  // An engine change still clears everything, whatever the reading came from.
  await f.service.refresh({ force: true });
  view = await f.service.updateSettings({ engine: 'local' });
  assert.deepEqual([view.engine, view.model, view.goals.length], [null, null, 0]);
});

test('overlapping refreshes share one request; privacy changes and late results cannot resurrect old text', async t => {
  let release, count = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { infer: async () => { count++; await gate; return { raw: answer() }; } });
  const one = f.service.refresh(), two = f.service.refresh();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(count, 1);
  f.setScope('private'); assert.equal(f.service.read().goals.length, 0);
  release(); await Promise.all([one, two]);
  assert.equal(f.service.read().goals.length, 0);
  assert.notEqual(f.service.read().status, 'running');
});

test('privacy changes while selecting a provider prevent the model call itself', async t => {
  let release, count = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { selectEngine: async () => { await gate; return 'codex'; }, infer: async () => { count++; return { raw: answer() }; } });
  const pending = f.service.refresh(); await new Promise(resolve => setImmediate(resolve));
  f.setScope('changed-private-paths'); release(); await pending;
  assert.equal(count, 0);
});

test('changed conversation inside the interval waits for the next pass', async t => {
  const f = await fixture(t); await f.service.refresh();
  const changed = input(); changed.sessions.groups[0].sessions[0] = session('Now implement a calendar'); f.setInput(changed);
  await f.service.refresh();
  assert.equal(f.calls.length, 1);
  assert.equal(f.service.read().stale, true);
});

test('new conversation arriving while reasoning runs discards the obsolete result', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { infer: async () => { await gate; return { raw: answer() }; } });
  const pending = f.service.refresh(); await new Promise(resolve => setImmediate(resolve));
  const changed = input(); changed.sessions.groups[0].sessions[0] = session('Stop voice work; build a calendar'); f.setInput(changed);
  release(); await pending;
  assert.equal(f.service.read().goals.length, 0);
  assert.equal(f.service.read().stale, true);
});

test('app switches and assistant progress during generation keep useful results until user direction changes', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { infer: async () => { await gate; return { raw: answer() }; } });
  const initial = input();
  initial.sessions.groups[0].sessions[0].recentContext.messages.unshift({ role: 'user', text: 'Earlier direction', at: at - 1000 }, { role: 'assistant', text: 'Earlier reply', at: at - 500 });
  initial.sessions.groups[0].sessions[0].recentContext.messages.push({ role: 'assistant', text: 'Starting the fix.', at });
  f.setInput(initial);
  const pending = f.service.refresh(); await new Promise(resolve => setImmediate(resolve));
  const changed = structuredClone(initial);
  changed.snapshot.activity.app = 'Browser';
  const running = changed.sessions.groups[0].sessions[0];
  running.updatedAt = new Date(at + 1000).toISOString();
  running.activity = 'Working';
  running.recentContext.messages.push({ role: 'assistant', text: 'Checking the fix.', at: at + 1000 });
  f.setInput(changed); release(); await pending;
  assert.equal(f.service.read().status, 'ready');
  assert.equal(f.service.read().goals.length, 1);
  assert.equal(f.service.read().stale, true);
});

test('local failures explain the retry without exposing raw provider details', async t => {
  const f = await fixture(t, { infer: async () => { throw Object.assign(new Error('private prompt contents'), { code: 'LOCAL_TIMEOUT' }); } });
  await f.service.updateSettings({ engine: 'local' });
  await f.service.refresh();
  assert.equal(f.service.read().status, 'error');
  assert.match(f.service.read().error, /local model took too long/);
  assert.doesNotMatch(f.service.read().error, /private prompt/);
});

test('disable persists, drops inferred data and prevents model calls; unreadable preferences survive', async t => {
  const f = await fixture(t); await f.service.refresh();
  await f.service.updateSettings({ enabled: false }); await f.service.refresh({ force: true });
  assert.equal(f.calls.length, 1); assert.equal(f.service.read().status, 'disabled'); assert.equal(f.service.read().goals.length, 0);
  await fs.writeFile(path.join(f.dataDir, 'context-reasoning.json'), '{broken');
  await assert.rejects(createContextReasoning({ dataDir: f.dataDir }), /left untouched/);
  assert.equal(await fs.readFile(path.join(f.dataDir, 'context-reasoning.json'), 'utf8'), '{broken');
});

test('invalid model output does not overwrite a previous usable result or leak provider errors', async t => {
  let bad = false;
  const f = await fixture(t, { infer: async () => { if (bad) throw new Error('secret provider token'); return { raw: answer() }; } });
  await f.service.refresh(); bad = true; await f.service.refresh({ force: true });
  assert.equal(f.service.read().goals.length, 1); assert.equal(f.service.read().stale, true); assert.equal(f.service.read().status, 'error');
  assert.doesNotMatch(f.service.read().error, /secret/);
});

test('a refused context answer is asked for once more, and only while the refresh is still current', async t => {
  const bad = { summary: 'no lists' };
  const run = async (outcomes, extra = {}) => {
    let calls = 0; const f = await fixture(t, { infer: async () => { const next = outcomes[Math.min(calls++, outcomes.length - 1)]; if (typeof next === 'function') return next(f); if (next instanceof Error) throw next; return { raw: next }; }, ...extra });
    if (extra.engine) await f.service.updateSettings({ engine: extra.engine });
    await f.service.refresh();
    return { f, calls, view: f.service.read() };
  };
  let result = await run([bad, answer()]);
  assert.equal(result.calls, 2); assert.equal(result.view.status, 'ready'); assert.equal(result.view.goals.length, 1);
  result = await run([bad, bad, answer()]);
  assert.equal(result.calls, 2); assert.equal(result.view.status, 'error'); assert.match(result.view.error, /answer Summon could not use/);
  // The local model decodes deterministically, so its refused answers are never asked for twice.
  for (const first of [Object.assign(new Error('bad json'), { code: 'LOCAL_INVALID_RESPONSE' }), bad]) {
    result = await run([first, answer()], { engine: 'local' });
    assert.equal(result.calls, 1); assert.equal(result.view.status, 'error');
  }
  for (const failure of [new Error('OAuth token has expired (401)'), Object.assign(new Error('slow'), { code: 'LOCAL_TIMEOUT' }), Object.assign(new Error('cut'), { code: 'LOCAL_TRUNCATED' })]) {
    result = await run([failure, answer()]);
    assert.equal(result.calls, 1); assert.equal(result.view.status, 'error');
  }
  result = await run([f => { f.setScope('another'); return { raw: bad }; }, answer()]);
  assert.equal(result.calls, 1); assert.equal(result.view.status, 'idle'); assert.equal(result.view.error, null);
});

test('after repeated failures the automatic poll waits longer; a success or a forced refresh resets it', async t => {
  let failing = true, calls = 0;
  const f = await fixture(t, { infer: async () => { calls++; if (failing) throw new Error('secret provider token'); return { raw: answer() }; } });
  await f.service.refresh();
  assert.equal(calls, 1);
  // With the two-minute interval: 2, 4, 8, 16, then a 30-minute cap.
  for (const wait of [120, 240, 480, 960, 1800, 1800]) {
    const before = calls;
    f.advance(wait * 1000 - 1000); await f.service.refresh(); assert.equal(calls, before, `nothing is sent before ${wait} s`);
    f.advance(1000); await f.service.refresh(); assert.equal(calls, before + 1, `a new attempt at ${wait} s`);
    assert.equal(f.service.read().status, 'error');
  }
  await f.service.refresh({ force: true });
  assert.equal(calls, 8, 'a forced refresh is never held back');
  f.advance(120_000); await f.service.refresh();
  assert.equal(calls, 9, 'after a forced refresh the wait starts again at two minutes');
  failing = false;
  f.advance(240_000); await f.service.refresh();
  assert.equal(calls, 10); assert.equal(f.service.read().status, 'ready');
  const changed = input(); changed.sessions.groups[0].sessions[0] = session('Now improve the calendar'); f.setInput(changed);
  f.advance(120_000); await f.service.refresh();
  assert.equal(calls, 11, 'a success returns to the normal interval');
});

test('only passes that reached a model count toward the wait, and it runs from the end of the failed attempt', async t => {
  let inputFails = false, calls = 0;
  const f = await fixture(t, { getInput: async () => { if (inputFails) throw new Error('Choose a known repository for goal reasoning.'); return input(); }, infer: async () => { calls++; f.advance(300_000); throw new Error('The operation timed out. Please try again.'); } });
  await f.service.refresh();
  assert.equal(calls, 1);
  f.advance(119_000); await f.service.refresh();
  assert.equal(calls, 1, 'a five-minute failure does not use up the two-minute wait');
  inputFails = true;
  for (let i = 0; i < 20; i++) { f.advance(50); await f.service.refresh(); }
  assert.equal(f.service.read().status, 'error');
  inputFails = false;
  f.advance(1_000); await f.service.refresh();
  assert.equal(calls, 2, 'failed input reads never lengthened the wait');
});

test('a change of workspace or reasoning settings starts the wait again at two minutes', async t => {
  let calls = 0;
  const f = await fixture(t, { infer: async () => { calls++; throw new Error('down'); } });
  const fail = async times => { for (let i = 0; i < times; i++) { f.advance(1_800_000); await f.service.refresh(); } };
  await fail(5);
  assert.equal(calls, 5);
  await f.service.updateSettings({ engine: 'claude' });
  await f.service.refresh(); assert.equal(calls, 6);
  f.advance(120_000); await f.service.refresh(); assert.equal(calls, 7, 'two minutes after a settings change');
  await fail(3);
  f.setScope('two');
  await f.service.refresh(); assert.equal(calls, 11);
  f.advance(120_000); await f.service.refresh(); assert.equal(calls, 12, 'two minutes after a workspace change');
});

test('a refusal cut short by a workspace change is not counted in the new workspace', async t => {
  let calls = 0, f;
  f = await fixture(t, { infer: async () => { calls++; if (calls === 1) { f.setScope('another'); return { raw: { summary: 'no lists' } }; } if (calls === 2) throw new Error('down'); return { raw: answer() }; } });
  await f.service.refresh();
  assert.equal(calls, 1);
  await f.service.refresh();
  assert.equal(calls, 2);
  f.advance(120_000); await f.service.refresh();
  assert.equal(calls, 3); assert.equal(f.service.read().status, 'ready');
});

test('Reason now during an automatic pass runs right after it; a second click during a forced pass does not', async t => {
  let hold = null, calls = 0;
  const f = await fixture(t, { getInput: async () => { if (hold) await hold; return input(); }, infer: async () => { calls++; return { raw: answer() }; } });
  await f.service.refresh();
  assert.equal(calls, 1);
  let release; hold = new Promise(resolve => { release = resolve; });
  const automatic = f.service.refresh();
  const click = f.service.refresh({ force: true });
  hold = null; release();
  await automatic; await click;
  await new Promise(resolve => setImmediate(resolve)); await f.service.refresh();
  assert.equal(calls, 2, 'the click ran after the unchanged automatic pass');
  hold = new Promise(resolve => { release = resolve; });
  const forced = f.service.refresh({ force: true });
  const again = f.service.refresh({ force: true });
  hold = null; release();
  await forced; await again;
  await new Promise(resolve => setImmediate(resolve)); await f.service.refresh();
  assert.equal(calls, 3, 'one forced pass, not two');
});
