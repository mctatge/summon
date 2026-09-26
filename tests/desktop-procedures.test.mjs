import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateDesktopDemonstration, validateDesktopObservation, compileDesktopProcedure, bindDesktopProcedure, createDesktopProcedureStore } from '../src/core/desktop-procedures.mjs';

const catalog = { kind: 'desktop', bundleId: 'com.example.Catalog', app: 'Catalog', title: 'Items' };
const planner = { kind: 'desktop', bundleId: 'com.example.Planner', app: 'Planner', title: 'Plan' };
const target = { role: 'AXTextField', name: 'Find an item', identifier: 'search' };
const observation = (surface, revision, text) => ({ surface, revision, text, controls: [{ id: 'field-1', ...target, value: '', editable: true, actions: [] }] });
function demo() {
  return { intent: 'Find the item I name and select its matching entry in my plan.', utterances: ['Like this'], allowedApps: [catalog.bundleId, planner.bundleId], events: [
    { kind: 'fill', surface: catalog, target, value: 'Winter report', before: observation(catalog, '1', 'Catalog'), after: observation(catalog, '2', 'Found Winter report') },
    { kind: 'activate', surface: planner, before: observation(catalog, '2', 'Found Winter report'), after: observation(planner, '3', 'Plan') },
    { kind: 'fill', surface: planner, target: { ...target, name: 'Find an entry' }, value: 'Winter report' },
    { kind: 'click', surface: planner, target: { role: 'AXButton', name: 'Select Winter report', identifier: 'Winter report-card' }, before: observation(planner, '4', 'Choose an entry'), after: observation(planner, '5', 'Selected Winter report') },
  ] };
}
const analysis = () => ({ name: 'Select an item for the plan', summary: 'Find the named item in the catalog and select its matching plan entry.', parameters: [{ name: 'item', label: 'Item', example: 'Winter report', primary: true }], verificationText: 'Selected Winter report' });

test('a cross-app demonstration reuses a new value with semantic targets and historical evidence intact', () => {
  const input = demo(), original = structuredClone(input);
  const procedure = compileDesktopProcedure(input, analysis());
  const bound = bindDesktopProcedure(procedure, { item: 'Summer report' });
  assert.deepEqual(input, original);
  assert.equal(bound.kind, 'desktop'); assert.equal(bound.version, 1);
  assert.deepEqual(bound.apps.map(item => item.bundleId), [catalog.bundleId, planner.bundleId]);
  assert.equal(bound.steps[0].value, 'Summer report'); assert.equal(bound.steps[2].value, 'Summer report');
  assert.equal(bound.steps[3].target.name, 'Select Summer report'); assert.equal(bound.steps[3].target.identifier, undefined);
  assert.equal(bound.steps[1].kind, 'activate'); assert.equal(bound.steps[1].surface.bundleId, planner.bundleId);
  assert.equal(bound.steps[3].after.text, 'Selected Winter report');
  assert.deepEqual(procedure.verification, { text: 'Selected {{item}}' });
  assert.deepEqual(bound.verification, { text: 'Selected Summer report' });
  assert.equal(procedure.steps[0].value, '{{item}}');
  assert.equal(bindDesktopProcedure(procedure).steps[0].value, 'Winter report');
});

test('model output may label recorded inputs but cannot invent actions, roles, apps or input examples', () => {
  for (const addition of [{ steps: [] }, { apps: [{ bundleId: 'com.evil.App' }] }, { code: 'execute()' }, { role: 'AXButton' }]) assert.throws(() => compileDesktopProcedure(demo(), { ...analysis(), ...addition }), /Unsupported analysis field/);
  const changed = analysis(); changed.parameters[0].example = 'Unobserved';
  assert.throws(() => compileDesktopProcedure(demo(), changed), /recorded fill or selection/);
  assert.deepEqual(compileDesktopProcedure(demo(), { ...analysis(), summary: 'Click an unrelated destructive control.' }).steps, compileDesktopProcedure(demo(), analysis()).steps);
  const outside = demo(); outside.allowedApps = [catalog.bundleId];
  assert.throws(() => validateDesktopDemonstration(outside), /outside its allowed apps/);
  const wrong = demo(); wrong.events[0].after.surface = planner;
  assert.throws(() => validateDesktopDemonstration(wrong), /demonstrated application/);
  const press = demo(); press.events = [{ kind: 'press', surface: catalog, target, value: 'Command+Q' }];
  assert.throws(() => validateDesktopDemonstration(press), /Only Enter, Tab and Escape/);
});

test('parameters and literal substitution cannot alter app identity, role, or identifier', () => {
  const procedure = compileDesktopProcedure(demo(), analysis());
  const bound = bindDesktopProcedure(procedure, { item: 'Summer $& `x`' });
  assert.equal(bound.steps[3].target.name, 'Select Summer $& `x`');
  assert.equal(bound.steps[0].target.role, 'AXTextField');
  for (const values of [{ unknown: 'x' }, { item: '{{other}}' }, { item: 0 }, null, [], JSON.parse('{"__proto__":"x"}')]) assert.throws(() => bindDesktopProcedure(procedure, values));
  for (const name of ['__proto__', 'constructor', 'prototype', 'Item', 'item.name']) {
    const changed = analysis(); changed.parameters[0].name = name;
    assert.throws(() => compileDesktopProcedure(demo(), changed), /parameter name/);
  }
  const getter = {}; Object.defineProperty(getter, 'item', { enumerable: true, get() { assert.fail('accessor was executed'); } });
  assert.throws(() => bindDesktopProcedure(procedure, getter), /accessors/);
  const changed = structuredClone(procedure); changed.steps[0].target.role = '{{item}}';
  assert.throws(() => bindDesktopProcedure(changed), /template syntax/);
});

test('capture rejects secret controls, duplicate IDs, oversized recordings and unsafe object structures', () => {
  for (const secret of [{ role: 'AXSecureTextField', name: 'Password' }, { role: 'AXSecureTextField', name: 'Input' }, { role: 'AXTextField', name: 'API key' }]) {
    const input = demo(); input.events[0].target = secret;
    assert.throws(() => validateDesktopDemonstration(input), /Sensitive/);
  }
  const view = observation(catalog, '1', 'Catalog'); view.controls.push(structuredClone(view.controls[0]));
  assert.throws(() => validateDesktopObservation(view), /unique/);
  const input = demo(); input.events = Array(81).fill(input.events[0]);
  assert.throws(() => validateDesktopDemonstration(input), /1 to 80/);
  assert.throws(() => validateDesktopDemonstration({ ...demo(), intent: 'x'.repeat(12001) }), /valid text/);
  const accessor = demo(); Object.defineProperty(accessor.events, '0', { get() { assert.fail('getter executed'); } });
  assert.throws(() => validateDesktopDemonstration(accessor), /accessors/);
  assert.throws(() => validateDesktopObservation({ ...observation(catalog, '1', ''), controls: [{ ...observation(catalog, '1', '').controls[0], id: 'one', actions: ['AXPress', 'AXPress'] }] }), /unique/);
});

test('an initial app activation keeps its before-app evidence in the demonstrated scope', () => {
  const input = demo(); input.events.shift();
  const procedure = compileDesktopProcedure(input, analysis());
  assert.ok(procedure.apps.some(app => app.bundleId === catalog.bundleId));
  assert.equal(bindDesktopProcedure(procedure, { item: 'Summer report' }).steps[0].kind, 'activate');
});

test('only distinct final result evidence supports automatic verification', () => {
  for (const quote of ['Invented result', 'Choose an entry', 'Selected']) assert.equal(compileDesktopProcedure(demo(), { ...analysis(), verificationText: quote }).verification, null);
  const same = demo(); same.events.at(-1).before.text = 'Selected Winter report';
  assert.equal(compileDesktopProcedure(same, analysis()).verification, null);
  const procedure = compileDesktopProcedure(demo(), analysis()); procedure.verification.text = 'Invented {{item}}';
  assert.throws(() => bindDesktopProcedure(procedure), /grounded/);
});

test('private atomic store survives concurrent writes, isolates callers and preserves original corrupt files', async t => {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'summon-desktop-procedures-')));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = await createDesktopProcedureStore({ dataDir });
  const a = compileDesktopProcedure(demo(), analysis()), b = compileDesktopProcedure(demo(), analysis());
  await Promise.all([store.save(a), store.save(b)]);
  assert.equal(store.list().length, 2); assert.equal((await fs.stat(path.join(dataDir, 'desktop-procedures.json'))).mode & 0o777, 0o600);
  store.get(a.id).steps[0].value = 'changed'; assert.equal(store.get(a.id).steps[0].value, '{{item}}');
  const changed = structuredClone(a); changed.apps.push({ bundleId: 'com.example.Unseen', name: 'Unseen' });
  await assert.rejects(store.save(changed), /different applications/);
  assert.equal(await store.remove(a.id), true); assert.equal(await store.remove(a.id), false);
  await store.close(); await assert.rejects(store.save(a), /closing/);
  const reopened = await createDesktopProcedureStore({ dataDir }); assert.equal(reopened.list().length, 1); await reopened.close();
  const filename = path.join(dataDir, 'desktop-procedures.json'), corrupt = '{"version":1,"procedures": [oops';
  await fs.writeFile(filename, corrupt);
  await assert.rejects(createDesktopProcedureStore({ dataDir }), /original file was left untouched/);
  assert.equal(await fs.readFile(filename, 'utf8'), corrupt);
  assert.deepEqual(await fs.readdir(dataDir), ['desktop-procedures.json']);
});
