// Five real, tool-less Codex CLI requests over synthetic desktop observations.
// Uses existing CLI-owned sign-in. Never starts a native helper, observes an app,
// persists a procedure or executes an inferred action. No private data is read.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { reasonAboutDesktopTeaching } from '../src/main/desktop-teaching-engine.mjs';
import { compileDesktopProcedure, bindDesktopProcedure } from '../src/core/desktop-procedures.mjs';

const surface = { kind: 'desktop', bundleId: 'com.summon.fixture.Catalog', app: 'Synthetic Catalog', title: 'Reports' };
const search = { id: 'search-1', role: 'AXTextField', name: 'Search reports', identifier: 'report-search', value: '', editable: true, actions: [] };
const button = (id, name) => ({ id, role: 'AXButton', name, identifier: id, editable: false, actions: ['AXPress'] });
const observe = (revision, text, controls) => ({ surface, revision, text, controls });
const initial = observe('demo-0', 'Search reports', [search]);
const found = observe('demo-1', 'Search reports: Orion. Result: Orion.', [{ ...search, value: 'Orion' }, button('open-orion', 'Open Orion')]);
const opened = observe('demo-2', 'Opened report: Orion. Report workspace ready.', []);
const demo = {
  intent: 'Open each report I name. I am demonstrating the report named Orion; the report name is the repeated input.',
  utterances: ['Like this: search for Orion, then open its matching result.'],
  allowedApps: [surface.bundleId],
  events: [
    { kind: 'fill', surface, target: { role: search.role, name: search.name, identifier: search.identifier }, value: 'Orion', before: initial, after: found },
    { kind: 'click', surface, target: { role: 'AXButton', name: 'Open Orion', identifier: 'open-orion' }, before: found, after: opened },
  ],
};

let calls = 0;
async function reason(kind, input) {
  const start = performance.now();
  console.log(`Codex request ${++calls}/5: ${kind}`);
  const result = await reasonAboutDesktopTeaching(kind, input);
  console.log(`Validated ${kind} response in ${((performance.now() - start) / 1000).toFixed(1)}s`);
  return result;
}

const analysis = await reason('learn', demo);
const procedure = compileDesktopProcedure(demo, analysis);
assert.equal(procedure.parameters.length, 1, 'The demonstrated report name is the only variable.');
const parameter = procedure.parameters[0];
assert.equal(parameter.example, 'Orion'); assert.equal(parameter.primary, true);

const binding = await reason('bind', { request: 'Open Vega instead.', procedure: { name: procedure.name, intent: procedure.intent, parameters: procedure.parameters }, currentValues: { [parameter.name]: 'Orion' } });
assert.equal(binding.understood, true);
assert.deepEqual(binding.values, [{ name: parameter.name, value: 'Vega' }]);
const bound = bindDesktopProcedure(procedure, Object.fromEntries(binding.values.map(item => [item.name, item.value])));
assert.equal(bound.steps[0].value, 'Vega'); assert.equal(bound.steps[1].target.name, 'Open Vega');

const current = observe('live-3', 'Search reports: Vega. Result: Vega. Use Read to open a report.', [{ ...search, id: 'current-search', value: 'Vega' }, button('current-vega-read', 'Read Vega'), button('current-lyra-read', 'Read Lyra')]);
const resolved = await reason('resolve', { step: bound.steps[1], observation: current, allowedApps: [surface.bundleId], goal: 'Open report Vega', history: [{ kind: 'fill', target: 'Search reports', value: 'Vega', result: 'The matching search result is visible.' }] });
assert.equal(resolved.status, 'act'); assert.equal(resolved.controlId, 'current-vega-read');

const task = 'Open report Vega in Synthetic Catalog.';
const allowedApps = [{ bundleId: surface.bundleId, name: surface.app }];
const lessons = [{ id: procedure.id, name: procedure.name, summary: procedure.summary, intent: procedure.intent, parameters: procedure.parameters, steps: procedure.steps }];
const history = [{ kind: 'fill', bundleId: surface.bundleId, controlId: 'current-search', value: 'Vega', result: 'Matching search results are visible.' }];
const next = await reason('next', { task, allowedApps, observation: current, lessons, history, stepLimit: 24, remaining: 23 });
assert.equal(next.status, 'act'); assert.equal(next.kind, 'click'); assert.equal(next.bundleId, surface.bundleId);
assert.equal(next.controlId, 'current-vega-read'); assert.equal(next.value, '');

// The fixture supplies the hypothetical post-action observation. No OS action ran.
const final = observe('live-4', 'Opened report: Vega. Report workspace ready.', []);
const done = await reason('next', { task, allowedApps, observation: final, lessons, history: [...history, { ...next, result: 'The report workspace is now visible.' }], stepLimit: 24, remaining: 22 });
assert.equal(done.status, 'done');
assert.ok(final.text.includes(done.evidence), 'Completion evidence must be an exact current observation quote.');
assert.ok(!current.text.includes(done.evidence), 'Completion evidence must be new relative to the pre-action observation.');
assert.ok(done.evidence.includes('Vega'), 'Completion must refer to the requested report.');
assert.equal(calls, 5);
console.log('PASS: live Codex learned Orion → bound Vega → resolved a renamed Read control by its fresh ID → planned that current click → grounded completion in newly supplied Vega outcome text. Synthetic observations only; no native capture, OS action, microphone, or persistence was exercised.');
