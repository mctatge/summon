import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CHILD = fileURLToPath(new URL('./fixtures/work-recovery-process.mjs', import.meta.url));
const AT = Date.parse('2026-09-21T12:00:00.000Z');
const SESSION = '00000000-0000-4000-8000-000000000001';

function nextMessage(child, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Recovery fixture did not report its result.')), 15000);
    const onExit = (code, signal) => finish(new Error(`Recovery fixture exited early (${code ?? signal}).`));
    const onMessage = value => {
      if (value?.type === 'failure') finish(new Error(value.message));
      else if (value?.type === type) finish(null, value);
    };
    function finish(error, value) {
      clearTimeout(timer); child.off('exit', onExit); child.off('message', onMessage);
      if (error) reject(error); else resolve(value);
    }
    child.on('message', onMessage); child.on('exit', onExit);
  });
}

function exited(child) {
  return new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
}

test('a killed recovery process resumes real local transcripts once without altering work records', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'summon-recovery-crash-')));
  const home = path.join(root, 'home'), repo = path.join(root, 'repo'), data = path.join(root, 'data');
  const transcriptDir = path.join(home, '.claude', 'projects', 'fixture');
  for (const dir of [home, repo, data, transcriptDir]) await fs.mkdir(dir, { recursive: true });
  const source = path.join(transcriptDir, `${SESSION}.jsonl`);
  const user = (text, at, uuid, role = 'user') => ({ type: role, sessionId: SESSION, cwd: repo, entrypoint: 'cli', uuid,
    timestamp: new Date(at).toISOString(), message: { role, stop_reason: role === 'assistant' ? 'end_turn' : undefined, content: text } });
  await fs.writeFile(source, `${JSON.stringify(user('Historical material stays outside capture.', AT - 1000, 'old'))}\n`);
  const untouched = `${JSON.stringify({ fixture: 'Existing goals, ownership and hierarchy must remain exact.' })}\n`;
  const goals = path.join(data, 'visual-goals.json'); await fs.writeFile(goals, untouched);
  const children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await fs.rm(root, { recursive: true, force: true });
  });
  const launch = mode => {
    const child = fork(CHILD, [home, repo, data, mode, source, SESSION, String(mode === 'prime' ? AT : AT + 10000)],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] });
    children.push(child); child.stderr.resume(); return child;
  };
  const firstProcess = launch('prime');
  const ready = await nextMessage(firstProcess, 'ready');
  assert.equal(ready.captured.total, 1);
  assert.equal(ready.captured.items.some(item => item.text.includes('sk-Ab12cd34')), false);
  const death = exited(firstProcess); firstProcess.kill('SIGKILL');
  assert.deepEqual(await death, { code: null, signal: 'SIGKILL' });

  // The source app can keep writing while Summon is absent. No checkpoint is produced in either process.
  const missed = [user('Also recover the unfinished native check.', AT + 100, 'offline-request'),
    user('The native check remains unverified; inspect it next.', AT + 200, 'offline-final', 'assistant')];
  await fs.appendFile(source, missed.map(row => `${JSON.stringify(row)}\n`).join(''));
  const secondProcess = launch('resume'), completion = exited(secondProcess);
  const recovered = await nextMessage(secondProcess, 'recovered');
  assert.deepEqual(await completion, { code: 0, signal: null });
  assert.equal(recovered.first.total, 3); assert.equal(recovered.second.total, 3);
  assert.equal(new Set(recovered.second.items.map(item => item.id)).size, 3);
  assert.ok(recovered.second.items.some(item => item.text.includes('unfinished native check')));
  assert.ok(recovered.second.items.some(item => item.role === 'assistant' && item.text.includes('remains unverified')));
  assert.equal(recovered.second.items.some(item => item.text.includes('Historical material')), false);
  assert.equal(await fs.readFile(goals, 'utf8'), untouched);
  const journal = await fs.readFile(path.join(data, 'work-recovery.json'), 'utf8');
  assert.equal(journal.includes('sk-Ab12cd34EF56gh78IJ90kl12'), false);
  assert.equal((await fs.stat(path.join(data, 'work-recovery.json'))).mode & 0o777, 0o600);
  assert.deepEqual((await fs.readdir(data)).sort(), ['visual-goals.json', 'work-recovery.json']);
});
