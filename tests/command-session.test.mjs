import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createKnowledge } from '../src/core/knowledge.mjs';
import { classifyCommand } from '../src/main/commands.mjs';
import { createCommandSession } from '../src/main/command-session.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'summon-command-session-')));
  const state = { projects: [{ id: 'demo', name: 'Demo', path: root }], currentProjectId: null, activity: null, settings: { paused: false } };
  const calls = { calendar: 0, benchmark: 0, files: [] };
  let files = [{ id: 'sheet' }]; let benchmarkError = null; let calendarAction = async () => { calls.calendar++; };
  const knowledge = await createKnowledge({ dataDir: root, projects: state.projects, validateCommand: classifyCommand });
  const service = { snapshot: () => structuredClone(state), searchFiles: async () => files, selectProject: async id => { state.currentProjectId = id; }, updateSettings: async patch => { Object.assign(state.settings, patch); } };
  const session = createCommandSession({ service, knowledge, openCalendar: () => calendarAction(), openBenchmark: async () => { calls.benchmark++; }, fetchBenchmark: async () => ({ error: benchmarkError, fetchedAt: new Date().toISOString() }), openFile: async id => { calls.files.push(id); } });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, state, calls, knowledge, service, session, setFiles: value => { files = value; }, setBenchmarkError: value => { benchmarkError = value; }, setCalendarAction: value => { calendarAction = value; } };
}
async function saveCalendar(f) {
  const receipt = await f.session.execute('open my calendar');
  await f.session.save({ receiptId: receipt.routineReceiptId, name: 'Morning calendar', trigger: 'morning desk' });
  return f.knowledge.snapshot().routines[0];
}

test('only successful direct commands create server-owned routine receipts', async t => {
  const f = await fixture(t);
  await assert.rejects(() => f.session.save({ receiptId: 'invented', name: 'Unsafe', trigger: 'morning desk', command: 'rm -rf private' }), /Run the command successfully/);
  const result = await f.session.execute('open my calendar');
  assert.ok(result.routineReceiptId);
  assert.equal(f.calls.calendar, 1);
  await f.session.save({ receiptId: result.routineReceiptId, name: 'Morning', trigger: 'morning desk', command: 'rm -rf private' });
  assert.equal(f.knowledge.snapshot().routines[0].command, 'open my calendar');
  assert.equal((await f.session.execute('explain a strange idea')).routineReceiptId, undefined);
  f.setFiles([]);
  assert.equal((await f.session.execute('find my Excel file')).routineReceiptId, undefined);
  f.setBenchmarkError('Ranking source unavailable');
  assert.equal((await f.session.execute('best coding model')).routineReceiptId, undefined);
  f.setCalendarAction(async () => { throw new Error('Calendar could not open'); });
  await assert.rejects(() => f.session.execute('open my calendar'), /could not open/);
});

test('exact aliases run the saved direct action and builtins retain precedence', async t => {
  const f = await fixture(t);
  const routine = await saveCalendar(f);
  const result = await f.session.execute('MORNING DESK.');
  assert.equal(f.calls.calendar, 2);
  assert.equal(result.routineName, routine.name);
  assert.equal(f.knowledge.snapshot().routines[0].useCount, 1);
  await f.session.execute('open my calendar');
  assert.equal(f.calls.calendar, 3);
  assert.equal(f.knowledge.snapshot().routines[0].useCount, 1);
  assert.equal((await f.session.execute('please do morning desk')).kind, 'unknown');
});

test('failed routine results do not increment successful usage or create fresh receipts', async t => {
  const f = await fixture(t);
  const receipt = await f.session.execute('best coding model');
  await f.session.save({ receiptId: receipt.routineReceiptId, name: 'Models', trigger: 'morning ranking' });
  const routine = f.knowledge.snapshot().routines[0];
  f.setBenchmarkError('Service is unavailable');
  const failed = await f.session.runRoutine(routine.id);
  assert.equal(failed.failed, true);
  assert.equal(failed.routineReceiptId, undefined);
  assert.equal(f.knowledge.snapshot().routines[0].useCount, 0);
});

test('external deletion is loaded before a routine can execute', async t => {
  const f = await fixture(t);
  const routine = await saveCalendar(f);
  const filename = path.join(f.root, 'knowledge.json');
  const edited = JSON.parse(await fs.readFile(filename, 'utf8'));
  edited.routines = [];
  await fs.writeFile(filename, JSON.stringify(edited));
  await assert.rejects(() => f.session.runRoutine(routine.id), /no longer exists/);
  assert.equal(f.calls.calendar, 1, 'the deleted routine must not open Calendar before discovering deletion');
});

test('externally renamed triggers take effect on the next unknown command', async t => {
  const f = await fixture(t);
  await saveCalendar(f);
  const filename = path.join(f.root, 'knowledge.json');
  const edited = JSON.parse(await fs.readFile(filename, 'utf8'));
  edited.routines[0].trigger = 'evening desk';
  await fs.writeFile(filename, JSON.stringify(edited));
  assert.equal((await f.session.execute('morning desk')).kind, 'unknown');
  await f.session.execute('evening desk');
  assert.equal(f.calls.calendar, 2);
});

test('a routine changed during an awaited action is not credited for another command', async t => {
  const f = await fixture(t);
  const routine = await saveCalendar(f);
  let release; let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  f.setCalendarAction(async () => { f.calls.calendar++; entered(); await blocked; });
  const pending = f.session.runRoutine(routine.id);
  await ready;
  await f.knowledge.saveRoutine({ name: 'New action', trigger: 'morning desk', command: 'current project' });
  release();
  const result = await pending;
  assert.equal(result.message, 'Opened your calendar.');
  assert.equal(f.knowledge.snapshot().routines[0].useCount, 0);
});

test('usage persistence failure does not report a completed application action as unexecuted', async t => {
  const f = await fixture(t);
  const routine = await saveCalendar(f);
  t.mock.method(f.knowledge, 'useRoutine', async () => { throw new Error('Storage unavailable'); });
  const result = await f.session.runRoutine(routine.id);
  assert.equal(result.message, 'Opened your calendar.');
  assert.equal(f.calls.calendar, 2);
});

test('receipt save rejects expired proof and changed workspace routing', async t => {
  const f = await fixture(t);
  const receipt = await f.session.execute('work on Demo');
  f.state.projects[0].name = 'Renamed';
  await assert.rejects(() => f.session.save({ receiptId: receipt.routineReceiptId, name: 'Desk', trigger: 'morning desk' }), /command changed/);
  const calendar = await f.session.execute('open my calendar');
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 3_600_001);
  await assert.rejects(() => f.session.save({ receiptId: calendar.routineReceiptId, name: 'Desk', trigger: 'morning desk' }), /Run the command successfully/);
});
