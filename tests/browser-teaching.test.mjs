import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBrowserTeaching } from '../src/main/browser-teaching.mjs';

const URL = 'https://metapick-ai.com/draft-tool';
const demonstration = () => ({ url: URL, title: 'Draft tool', events: [
  { kind: 'fill', target: { name: 'Map search', selector: '#map' }, value: 'Bridge Too Far' },
  { kind: 'click', target: { name: 'Bridge Too Far', selector: '[data-map="Bridge Too Far"]' } },
  { kind: 'fill', target: { name: 'Brawler search', selector: '#brawler' }, value: 'Najia' },
  { kind: 'click', target: { name: 'Select Najia', selector: '[data-brawler="Najia"]' }, before: { url: URL, text: 'Available brawler: Najia' }, after: { url: URL, text: 'Selected brawler: Najia' } },
] });
const interpretation = () => ({ name: 'Draft a brawler', summary: 'Choose a map and select the requested brawler.', parameters: [
  { name: 'map', label: 'Map', example: 'Bridge Too Far', primary: false },
  { name: 'brawler', label: 'Brawler', example: 'Najia', primary: true },
], verificationText: 'Selected brawler: Najia' });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function settled(service) {
  for (let count = 0; count < 100; count++) {
    const state = await service.read();
    if (!['running', 'reviewing'].includes(state.phase)) return state;
    await tick();
  }
  assert.fail('Teaching did not settle.');
}
async function fixture(t, options = {}) {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'summon-teaching-')));
  const status = { connected: true, url: URL, sessionId: 'session-1', tabId: 10, documentId: 'document-1' };
  const calls = [], reasons = [];
  let selected = 'Najia';
  const bridge = {
    status: () => ({ ...status }),
    start: async () => ({ port: 12345, token: 'local-test-token' }),
    close: async () => {},
    request: async (method, input) => {
      calls.push({ method, input: structuredClone(input) });
      if (options.request) {
        const override = options.request(method, input, status);
        if (override !== undefined) return await override;
      }
      if (method === 'finish') return demonstration();
      if (method !== 'execute') return { ok: true };
      const before = { url: status.url, text: `Selected brawler: ${selected}` };
      if (input.step.kind === 'click' && input.step.target.name.startsWith('Select ')) selected = input.step.target.name.slice(7);
      return { matched: true, before, after: { url: status.url, text: `Selected brawler: ${selected}` } };
    },
  };
  const reason = async (kind, input) => {
    reasons.push({ kind, input: structuredClone(input) });
    if (options.reason) {
      const override = options.reason(kind, input);
      if (override !== undefined) return await override;
    }
    return kind === 'learn' ? interpretation() : { understood: true, question: '', values: [{ name: 'brawler', value: input.request }] };
  };
  const service = await createBrowserTeaching({ dataDir, bridge, reason });
  t.after(async () => { await service.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { service, status, calls, reasons, dataDir, bridge, reason };
}
async function teach(service) {
  await service.action('start', { intent: 'I am drafting. Input the brawlers while I say them.' });
  await service.command('No, the map is Bridge Too Far, and then select Najia.');
  const reviewed = await service.action('finish');
  assert.equal(reviewed.phase, 'proposal');
  assert.equal(reviewed.procedures.length, 0, 'Learning does not save without the explicit save action');
  const saved = await service.action('save');
  return saved.activeId;
}
const executions = f => f.calls.filter(item => item.method === 'execute').map(item => item.input.step);

test('teaching and explicit saving generalize spoken Jessie and retain the map in the same document', async t => {
  const f = await fixture(t);
  const id = await teach(f.service);
  const reply = await f.service.command('Jessie');
  assert.equal(reply.kind, 'message');
  const state = await settled(f.service);
  assert.equal(state.phase, 'idle');
  assert.equal(state.lastRun.id, id);
  assert.equal(state.lastRun.verified, true);
  assert.deepEqual(state.lastRun.values, { map: 'Bridge Too Far', brawler: 'Jessie' });
  assert.deepEqual(executions(f).map(step => step.kind), ['fill', 'click']);
  assert.equal(executions(f)[0].value, 'Jessie');
  assert.equal(executions(f)[1].target.name, 'Select Jessie');
  assert.deepEqual(f.reasons.find(item => item.kind === 'bind').input.currentValues, { map: 'Bridge Too Far', brawler: 'Najia' });
  assert.match(state.message, /Selected brawler: Jessie/);
});

test('after a reload, selecting a saved procedure reruns setup and replay remains scoped to its page', async t => {
  const f = await fixture(t);
  const id = await teach(f.service);
  await f.service.close();
  f.status.documentId = 'document-2';
  const reopened = await createBrowserTeaching({ dataDir: f.dataDir, bridge: f.bridge, reason: f.reason });
  t.after(() => reopened.close());
  assert.equal((await reopened.read()).activeId, null);
  await reopened.action('select', { id });
  await reopened.command('Jessie');
  assert.equal((await settled(reopened)).lastRun.verified, true);
  assert.equal(executions(f).length, 4);
  assert.equal(executions(f)[0].value, 'Bridge Too Far');
  assert.equal(executions(f)[2].value, 'Jessie');
  f.status.url = 'https://metapick-ai.com/account';
  await assert.rejects(reopened.action('run', { id, values: { brawler: 'Bo' } }), /page where this procedure was taught/);
  assert.equal(executions(f).length, 4);
  assert.equal(await reopened.command('Bo'), null, 'Speech on a different page does not trigger this procedure');
});

test('cancel during learning suppresses a late proposal and late errors', async t => {
  const learning = deferred();
  const f = await fixture(t, { reason: kind => kind === 'learn' ? learning.promise : undefined });
  await f.service.action('start', { intent: 'Learn drafting' });
  await f.service.command("that's it");
  await tick();
  assert.equal((await f.service.read()).phase, 'reviewing');
  await f.service.command('stop');
  learning.resolve(interpretation());
  await tick(); await tick();
  const state = await f.service.read();
  assert.equal(state.phase, 'idle');
  assert.equal(state.proposal, null);
  assert.deepEqual(state.procedures, []);
  assert.deepEqual(executions(f), []);

  const failure = deferred();
  const g = await fixture(t, { reason: kind => kind === 'learn' ? failure.promise : undefined });
  await g.service.action('start', { intent: 'Learn drafting' });
  await g.service.command("that's it");
  await tick();
  await g.service.command('stop');
  failure.reject(new Error('stale model failure'));
  await tick(); await tick();
  assert.equal((await g.service.read()).phase, 'idle');
  assert.doesNotMatch((await g.service.read()).message, /stale model/);
});

test('cancel during interpretation and execution prevents later browser actions', async t => {
  const binding = deferred();
  const f = await fixture(t, { reason: kind => kind === 'bind' ? binding.promise : undefined });
  await teach(f.service);
  await f.service.command('Jessie');
  await f.service.command('stop');
  binding.resolve({ understood: true, question: '', values: [{ name: 'brawler', value: 'Jessie' }] });
  await tick(); await tick();
  assert.deepEqual(executions(f), []);
  assert.equal((await f.service.read()).phase, 'idle');
  assert.equal((await f.service.read()).activeId, null);

  const action = deferred();
  const g = await fixture(t, { request: method => method === 'execute' ? action.promise : undefined });
  await teach(g.service);
  await g.service.command('Jessie');
  await tick();
  assert.equal(executions(g).length, 1);
  await g.service.command('stop');
  action.resolve({ matched: true, before: { url: URL, text: '' }, after: { url: URL, text: 'Selected brawler: Jessie' } });
  await tick(); await tick();
  assert.equal(executions(g).length, 1);
  assert.equal((await g.service.read()).lastRun, null);
});

test('navigation while reasoning cannot reuse the setup baseline of the old document', async t => {
  const learning = deferred();
  const f = await fixture(t, { reason: kind => kind === 'learn' ? learning.promise : undefined });
  await f.service.action('start', { intent: 'Learn drafting' });
  await f.service.command("that's it");
  await tick();
  f.status.documentId = 'new-document-after-demonstration';
  learning.resolve(interpretation());
  await tick(); await tick();
  await f.service.action('save');
  await f.service.command('Jessie');
  await settled(f.service);
  assert.equal(executions(f).length, 4, 'A new document needs the recorded map setup');
  assert.equal(executions(f)[0].value, 'Bridge Too Far');
});

test('page changes between steps stop replay and cannot be reported as a verified completion', async t => {
  let count = 0;
  const f = await fixture(t, { request: (method, input, status) => {
    if (method !== 'execute') return undefined;
    if (++count === 1) status.url = 'https://metapick-ai.com/account';
    return { matched: true, before: { url: URL, text: '' }, after: { url: status.url, text: 'Selected brawler: Jessie' } };
  } });
  const id = await teach(f.service);
  await assert.rejects(f.service.action('run', { id, values: { brawler: 'Jessie' } }), /page changed/);
  assert.equal(executions(f).length, 1);
  assert.equal((await f.service.read()).lastRun, null);
});

test('missing evidence remains unverified and user confirmation authorizes retaining setup for the next input', async t => {
  const f = await fixture(t, { reason: kind => kind === 'learn' ? { ...interpretation(), verificationText: '' } : undefined });
  const id = await teach(f.service);
  await f.service.command('Jessie');
  const unverified = await settled(f.service);
  assert.equal(unverified.lastRun.verified, false);
  assert.match(unverified.message, /Check the result/);
  const confirmed = await f.service.action('confirm');
  assert.equal(confirmed.lastRun.confirmed, true);
  await f.service.action('run', { id, values: { brawler: 'Bo' } });
  assert.equal(executions(f).length, 4, 'Both reuses skip map setup after demonstration and explicit confirmation');
  assert.equal(executions(f)[2].value, 'Bo');
});

test('an after-text match without a before observation cannot prove a new selection', async t => {
  const f = await fixture(t, { request: method => method === 'execute' ? { matched: true, after: { url: URL, text: 'Selected brawler: Jessie' } } : undefined });
  const id = await teach(f.service);
  const state = await f.service.action('run', { id, values: { brawler: 'Jessie' } });
  assert.equal(state.lastRun.verified, false);
});

test('a partially failed replay invalidates setup so the next request restores the requested map', async t => {
  let count = 0, shouldFail = true;
  const f = await fixture(t, { request: method => {
    if (method === 'execute' && ++count === 3 && shouldFail) throw new Error('Control disappeared after changing the map');
    return undefined;
  } });
  const id = await teach(f.service);
  await assert.rejects(f.service.action('run', { id, values: { map: 'Shooting Star', brawler: 'Jessie' } }), /Control disappeared/);
  assert.equal(executions(f).length, 3);
  shouldFail = false;
  await f.service.action('run', { id, values: { brawler: 'Bo' } });
  assert.equal(executions(f).length, 7, 'All setup is repeated after a partial failure');
  assert.equal(executions(f)[3].value, 'Bridge Too Far');
});

test('cancel after changing setup forces setup to run again on the next request', async t => {
  const pending = deferred(); let count = 0;
  const f = await fixture(t, { request: method => method === 'execute' && ++count === 3 ? pending.promise : undefined });
  const id = await teach(f.service);
  const running = f.service.action('run', { id, values: { map: 'Shooting Star', brawler: 'Jessie' } });
  for (let spin = 0; spin < 20 && executions(f).length < 3; spin++) await tick();
  assert.equal(executions(f).length, 3);
  await f.service.action('cancel');
  pending.resolve({ matched: true, before: { url: URL, text: '' }, after: { url: URL, text: 'search ready' } });
  await running;
  await f.service.action('run', { id, values: { brawler: 'Bo' } });
  assert.equal(executions(f).length, 7);
  assert.equal(executions(f)[3].value, 'Bridge Too Far');
});
