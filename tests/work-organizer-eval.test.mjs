import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { modelInput, validateDecisions, scoreDecisions, scoreGroups, replayInIsolation } from '../scripts/experiments/work-organizer-eval.mjs';

const fixture = () => ({
  id: 'unit-fixture', title: 'PRIVATE_EXPECTATION_TITLE', category: 'PRIVATE_EXPECTATION_CATEGORY', provenance: { note: 'PRIVATE_EXPECTATION_PROVENANCE' },
  records: [
    { id: 'outcome-a', repoId: 'repo-a', kind: 'outcome', parentId: null, title: 'Reliable context', status: 'working' },
    { id: 'task-a', repoId: 'repo-a', kind: 'task', parentId: 'outcome-a', title: 'Fix context isolation', status: 'working' },
    { id: 'outcome-b', repoId: 'repo-b', kind: 'outcome', parentId: null, title: 'Reliable context', status: 'working' },
    { id: 'task-b', repoId: 'repo-b', kind: 'task', parentId: 'outcome-b', title: 'Fix context isolation', status: 'working' },
  ],
  events: [{ id: 'event-a', repoId: 'repo-a', sessionId: 'session-a', role: 'assistant', text: 'Checkpoint for task-a: tests pass, but the installed behavior has not been verified.' }],
  corrections: [{ id: 'correction-a', repoId: 'repo-a', recordId: 'task-a', rule: 'retain-parent', text: 'Keep task-a under outcome-a.' }, { id: 'correction-b', repoId: 'repo-b', recordId: 'task-b', rule: 'retain-parent', text: 'Keep task-b under outcome-b.' }],
  expected: [{ eventId: 'event-a', action: ['attach'], targetIds: ['task-a'], parentIds: [null], statuses: ['needs-verification'], critical: 'Do not invent completion or cross project scope.' }],
});
const decision = patch => ({ eventId: 'event-a', action: 'attach', targetId: 'task-a', parentId: null, title: null, status: 'needs-verification', evidenceIds: ['event-a'], ...patch });
const proposal = patch => ({ decisions: [decision(patch)] });

test('model input excludes expected decisions and evaluation metadata', () => {
  const input = modelInput(fixture());
  assert.deepEqual(Object.keys(input).sort(), ['corrections', 'events', 'records']);
  assert.equal(JSON.stringify(input).includes('PRIVATE_EXPECTATION'), false);
  assert.equal(Object.hasOwn(input, 'expected'), false);
});

test('a correct decision passes the raw grader without needing guard repair', () => {
  assert.deepEqual(validateDecisions(proposal(), modelInput(fixture())), []);
  const score = scoreDecisions(proposal(), fixture());
  assert.equal(score.passed, true);
  assert.equal(score.criticalFailures, 0);
});

test('unknown event, record, and evidence IDs are rejected', () => {
  for (const patch of [{ eventId: 'invented-event' }, { targetId: 'invented-record' }, { evidenceIds: ['event-a', 'invented-evidence'] }]) {
    assert.ok(validateDecisions(proposal(patch), modelInput(fixture())).length > 0, JSON.stringify(patch));
    assert.equal(scoreDecisions(proposal(patch), fixture()).passed, false);
  }
});

test('foreign record targets, task parents, and evidence cannot cross project scope', () => {
  assert.ok(validateDecisions(proposal({ targetId: 'task-b' }), modelInput(fixture())).some(error => error.includes('association')));
  const input = modelInput(fixture()); input.events = [{ ...input.events[0], role: 'user' }];
  assert.ok(validateDecisions(proposal({ action: 'create_task', targetId: null, parentId: 'outcome-b', title: 'New step', status: 'planned' }), input).some(error => error.includes('new task')));
  assert.ok(validateDecisions(proposal({ evidenceIds: ['event-a', 'correction-b'] }), modelInput(fixture())).some(error => error.includes('foreign evidence')));
});

test('matching expected fields with foreign evidence is a critical failure, not a guarded pass', () => {
  const score = scoreDecisions(proposal({ evidenceIds: ['event-a', 'correction-b'] }), fixture());
  assert.equal(score.passed, false);
  assert.ok(score.validation.length > 0);
  assert.ok(score.criticalFailures > 0);
});

test('an assistant completion claim cannot pass or confirm the outcome', () => {
  const raw = proposal({ status: 'done' });
  assert.ok(validateDecisions(raw, modelInput(fixture())).some(error => error.includes('completion')));
  const score = scoreDecisions(raw, fixture());
  assert.equal(score.passed, false);
  assert.ok(score.criticalFailures > 0);
  assert.equal(fixture().records.find(record => record.id === 'outcome-a').status, 'working');
});

test('malformed model rows fail grading without aborting the experiment', () => {
  for (const raw of [null, { decisions: [null] }, proposal({ action: null }), proposal({ action: 42 }), { decisions: [] }, { decisions: [decision(), decision()] }]) {
    assert.doesNotThrow(() => validateDecisions(raw, modelInput(fixture())));
    assert.doesNotThrow(() => scoreDecisions(raw, fixture()));
    assert.equal(scoreDecisions(raw, fixture()).passed, false);
  }
});

test('isolated replay refuses invalid proposals before creating a journal', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'summon-organizer-reject-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const journal = path.join(directory, 'journal');
  const result = await replayInIsolation(journal, fixture(), proposal({ targetId: 'task-b' }));
  assert.equal(result.passed, false);
  assert.equal(result.skipped, true);
  await assert.rejects(fs.stat(journal), { code: 'ENOENT' });
});

test('isolated interruption and replay apply each event once and preserve corrections and parent outcomes', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'summon-organizer-replay-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const input = fixture();
  input.events.push({ id: 'event-new', repoId: 'repo-a', sessionId: 'session-new', role: 'user', text: 'Add a planned keyboard navigation task under outcome-a.' });
  input.events.push({ id: 'event-noise', repoId: 'repo-a', sessionId: 'session-new', role: 'system', text: 'A helper exited.' });
  const original = structuredClone(input);
  const raw = { decisions: [decision(), decision({ eventId: 'event-new', action: 'create_task', targetId: null, parentId: 'outcome-a', title: 'Add keyboard navigation', status: 'planned', evidenceIds: ['event-new'] }), decision({ eventId: 'event-noise', action: 'ignore', targetId: null, status: null, evidenceIds: ['event-noise'] })] };
  const result = await replayInIsolation(directory, input, raw);
  assert.equal(result.passed, true);
  assert.equal(result.recordCount, original.records.length + 1);
  assert.equal(result.processedEvents, 3);
  assert.equal(result.attemptCount, 2);
  const state = JSON.parse(await fs.readFile(path.join(directory, 'evaluation-state.json'), 'utf8'));
  assert.equal(new Set(state.processed).size, 3);
  assert.equal(new Set(state.records.map(record => record.id)).size, state.records.length);
  assert.equal(new Set(state.attempts.map(attempt => attempt.id)).size, 2);
  assert.equal(state.records.filter(record => record.title === 'Add keyboard navigation').length, 1);
  assert.equal(state.records.find(record => record.id === 'task-a').status, 'needs-verification');
  assert.equal(state.records.find(record => record.id === 'task-a').parentId, 'outcome-a');
  assert.equal(state.records.find(record => record.id === 'outcome-a').status, 'working');
  assert.deepEqual(state.corrections, original.corrections);
  assert.deepEqual(input, original, 'the fixture itself must remain unchanged');
  assert.match(result.note, /not production ingestion/);
});

test('group coverage rejects unknown, duplicate, and omitted record identities', () => {
  const input = { roots: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
  const groups = ids => ({ groups: ids.map((id, index) => ({ title: `Outcome ${index}`, reason: 'Shared intended result.', memberIds: [id] })) });
  assert.equal(scoreGroups(groups(['a', 'b', 'c']), input).passed, true);
  assert.equal(scoreGroups(groups(['a', 'b', 'unknown']), input).passed, false);
  assert.equal(scoreGroups(groups(['a', 'b', 'a']), input).passed, false);
});

test('malformed grouping output fails coverage without losing the experiment summary', () => {
  const input = { roots: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
  const raw = { groups: [null, { title: 'Second', reason: 'Evidence', memberIds: ['b'] }, { title: 'Third', reason: 'Evidence', memberIds: ['c'] }] };
  assert.doesNotThrow(() => scoreGroups(raw, input));
  assert.equal(scoreGroups(raw, input).passed, false);
});
