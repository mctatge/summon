import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createWorkRecoverySources } from '../src/core/sessions/work-recovery-sources.mjs';

const AT = Date.parse('2026-09-21T12:00:00.000Z');
let serial = 0;
const id = () => `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`;
const jsonl = row => `${JSON.stringify(row)}\n`;
const codex = (text, at = AT, extra = {}) => ({ timestamp: new Date(at).toISOString(), type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text }] }, ...extra });
const user = (text, at = AT) => codex(text, at, { type: 'event_msg', payload: { type: 'user_message', message: text } });
const claude = (sessionId, cwd, text, at = AT, extra = {}) => ({ type: 'user', sessionId, cwd, entrypoint: 'cli', uuid: id(), timestamp: new Date(at).toISOString(), message: { role: 'user', content: text }, ...extra });

async function fixture(t, limits = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'summon-recovery-sources-')));
  const home = path.join(root, 'home'), repo = { id: 'repo', path: path.join(root, 'project'), places: [] };
  const worktree = path.join(root, 'worktree'), other = path.join(root, 'other');
  const claudeRoot = path.join(home, '.claude', 'projects', 'ambiguous-slug');
  const codexRoot = path.join(home, '.codex', 'sessions', '2026', '09', '21');
  for (const folder of [repo.path, worktree, other, claudeRoot, codexRoot, path.join(home, '.codex', 'archived_sessions')]) await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(home, '.codex', 'state_5.sqlite'), 'fixture database');
  const rows = [], calls = [];
  const snapshots = { async query(db, statements) {
    calls.push(statements);
    assert.ok(statements.every(statement => !/\b(title|preview|first_user_message)\b/.test(statement.sql)));
    if (statements[0].name === 'schema') return { schema: [{ name: 'threads', sql: 'CREATE TABLE threads (id TEXT, rollout_path TEXT, source TEXT, cwd TEXT, model TEXT, thread_source TEXT, archived INTEGER, updated_at_ms INTEGER)' }] };
    return { threads: rows.slice(0, statements[0].params.at(-1)), children: [], edges: [] };
  } };
  const reader = createWorkRecoverySources({ homeDir: home, snapshots, limits });
  t.after(async () => { await reader.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, home, repo, worktree, other, rows, calls, reader, claudeRoot, codexRoot, snapshots,
    async addCodex(lines, options = {}) {
      const sessionId = options.sessionId ?? id();
      const file = options.file ?? path.join(options.archived ? path.join(home, '.codex', 'archived_sessions') : codexRoot, `${sessionId}.jsonl`);
      await fs.writeFile(file, lines.map(row => typeof row === 'string' ? row : jsonl(row)).join(''));
      rows.push({ id: sessionId, rollout_path: file, source: 'vscode', cwd: repo.path, model: 'test', thread_source: 'user', archived: options.archived ? 1 : 0, updated_at_ms: 1, ...options.row });
      return { file, sessionId };
    },
    async addClaude(text = 'Remember the next step', options = {}) {
      const sessionId = id(), file = path.join(claudeRoot, `${sessionId}.jsonl`);
      const row = claude(sessionId, options.cwd ?? repo.path, text, options.at ?? AT, options.row ?? {});
      await fs.writeFile(file, jsonl(row));
      return { file, sessionId, row };
    },
  };
}

test('discovery includes old ended and archived sources in this repo and registered worktrees only', async t => {
  const fx = await fixture(t);
  fx.repo.places = [{ path: fx.worktree }];
  const old = await fx.addCodex([codex('old archived')], { archived: true });
  await fx.addCodex([codex('other repo')], { row: { cwd: fx.other } });
  await fx.addCodex([codex('subagent')], { row: { source: '{"subagent":{}}', thread_source: 'subagent' } });
  const imported = await fx.addCodex([codex('imported')]);
  await fs.writeFile(path.join(fx.home, '.codex', 'external_agent_session_imports.json'), JSON.stringify([{ imported_thread_id: imported.sessionId }]));
  const work = await fx.addClaude('worktree task', { cwd: fx.worktree });
  await fx.addClaude('outside task', { cwd: fx.other });
  const found = await fx.reader.discover({ repo: fx.repo, since: AT });
  assert.equal(found.truncated, false);
  assert.deepEqual(found.sources.map(source => source.sessionId).sort(), [old.sessionId, work.sessionId].sort());
  assert.ok(!JSON.stringify(found).includes('old archived'));
  assert.ok(!JSON.stringify(found).includes('worktree task'));
});

test('baseline avoids historical content and an unfinished old line, then captures later complete lines', async t => {
  const fx = await fixture(t);
  const pending = jsonl(codex('unfinished old')).slice(0, -4);
  const item = await fx.addCodex([codex('historical'), pending]);
  const { sources: [source] } = await fx.reader.discover({ repo: fx.repo });
  const baseline = await fx.reader.readBatch(source, null, { baseline: true });
  assert.deepEqual(baseline.events, []);
  assert.equal(baseline.cursor.skipping, true);
  await fs.appendFile(item.file, `${jsonl(codex('unfinished old')).slice(-4)}${jsonl(codex('new follow-up', AT + 1000))}`);
  const next = await fx.reader.readBatch(source, baseline.cursor);
  assert.deepEqual(next.events.map(event => event.text), ['new follow-up']);
  assert.equal(next.cursor.skipping, undefined);
  assert.equal(next.eof, true);
  assert.ok(!JSON.stringify(next.cursor).includes('follow-up'));
  assert.equal(next.events[0].cwd, fx.repo.path);
});

test('incremental cursors survive reader restart without duplicates', async t => {
  const fx = await fixture(t);
  const item = await fx.addClaude('first message');
  let { sources: [source] } = await fx.reader.discover({ repo: fx.repo });
  const first = await fx.reader.readBatch(source, null);
  assert.equal(first.events.length, 1);
  const restart = createWorkRecoverySources({ homeDir: fx.home, snapshots: fx.snapshots });
  t.after(() => restart.close());
  ({ sources: [source] } = await restart.discover({ repo: fx.repo }));
  const unchanged = await restart.readBatch(source, JSON.parse(JSON.stringify(first.cursor)));
  assert.deepEqual(unchanged.events, []);
  await fs.appendFile(item.file, jsonl(claude(item.sessionId, fx.repo.path, 'second message', AT + 1000)));
  const second = await restart.readBatch(source, unchanged.cursor);
  assert.deepEqual(second.events.map(event => event.text), ['second message']);
});

test('partial UTF-8 and JSON lines are retained until newline without replacement characters', async t => {
  const fx = await fixture(t);
  const whole = Buffer.from(jsonl(codex('Continue 🪁 later'))), emoji = whole.indexOf(Buffer.from('🪁'));
  const item = await fx.addCodex([]);
  await fs.writeFile(item.file, whole.subarray(0, emoji + 2));
  const { sources: [source] } = await fx.reader.discover({ repo: fx.repo });
  const first = await fx.reader.readBatch(source, null);
  assert.equal(first.cursor.offset, 0);
  assert.equal(first.eof, true);
  await fs.appendFile(item.file, whole.subarray(emoji + 2));
  const second = await fx.reader.readBatch(source, first.cursor);
  assert.deepEqual(second.events.map(event => event.text), ['Continue 🪁 later']);
});

test('overlong lines consume bounded bytes with durable skip state and an explicit warning', async t => {
  const fx = await fixture(t, { batchBytes: 512, lineBytes: 256 });
  const item = await fx.addCodex([codex('x'.repeat(1700)), codex('after the long line')]);
  const { sources: [source] } = await fx.reader.discover({ repo: fx.repo });
  let cursor = null, events = [], warnings = [], passes = 0, eof = false;
  do {
    const next = await fx.reader.readBatch(source, cursor);
    assert.ok(next.cursor.offset - (cursor?.offset ?? 0) <= 512);
    cursor = JSON.parse(JSON.stringify(next.cursor));
    events.push(...next.events); warnings.push(...next.warnings); eof = next.eof;
  } while (!eof && ++passes < 10);
  assert.ok(eof);
  assert.deepEqual(events.map(event => event.text), ['after the long line']);
  assert.ok(warnings.some(warning => warning.includes('overlong')));
  assert.ok((await fs.stat(item.file)).size === cursor.offset);
});

test('replacement and same-inode rewrite reset cursors with stable replay event IDs', async t => {
  const fx = await fixture(t);
  const original = codex('original step');
  const item = await fx.addCodex([original]);
  const { sources: [source] } = await fx.reader.discover({ repo: fx.repo });
  const first = await fx.reader.readBatch(source, null);
  await fs.rename(item.file, `${item.file}.old`);
  await fs.writeFile(item.file, jsonl(original) + jsonl(codex('new step', AT + 1)));
  const replay = await fx.reader.readBatch(source, first.cursor);
  assert.equal(replay.events[0].id, first.events[0].id);
  assert.ok(replay.warnings.some(warning => warning.includes('replaced')));
  await fs.writeFile(item.file, jsonl(codex('rewrite step')) + jsonl(codex('new step', AT + 1)));
  const rewritten = await fx.reader.readBatch(source, replay.cursor);
  assert.ok(rewritten.warnings.some(warning => warning.includes('rewritten')));
  assert.equal(rewritten.events[0].text, 'rewrite step');
});

test('Codex twin user representations dedupe across batches without suppressing separate requests', async t => {
  const fx = await fixture(t, { batchBytes: 330, lineBytes: 250 });
  const twin = codex('unused', AT + 500, { payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'pending request' }] } });
  await fx.addCodex([user('pending request'), twin, user('pending request', AT + 10000)]);
  const { sources: [source] } = await fx.reader.discover({ repo: fx.repo });
  let cursor = null, events = [], eof = false;
  for (let count = 0; !eof && count < 5; count++) {
    const batch = await fx.reader.readBatch(source, cursor); cursor = batch.cursor; eof = batch.eof; events.push(...batch.events);
  }
  assert.deepEqual(events.map(event => event.text), ['pending request', 'pending request']);
  assert.equal(events[1].at, AT + 10000);
});

test('Codex excludes analysis, tools, injected messages and messages after cwd moves outside scope', async t => {
  const fx = await fixture(t);
  await fx.addCodex([
    codex('analysis secret', AT, { payload: { type: 'message', role: 'assistant', channel: 'analysis', content: [{ type: 'output_text', text: 'analysis secret' }] } }),
    codex('tool secret', AT, { payload: { type: 'function_call_output', output: 'tool secret' } }),
    user('# AGENTS.md instructions for this folder'),
    codex('visible answer'),
    { type: 'turn_context', payload: { cwd: fx.other } }, codex('different project'),
    { type: 'turn_context', payload: { cwd: fx.repo.path } }, codex('back in scope', AT + 1000),
  ]);
  const { sources: [source] } = await fx.reader.discover({ repo: fx.repo });
  const batch = await fx.reader.readBatch(source, null);
  assert.deepEqual(batch.events.map(event => event.text), ['visible answer', 'back in scope']);
});

test('Codex requires current final_answer phase or explicit legacy final channel, never missing markers', async t => {
  const fx = await fixture(t);
  const message = (text, markers = {}, role = 'assistant') => codex(text, AT, {
    payload: { type: 'message', id: null, role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
      internal_chat_message_metadata_passthrough: {}, ...markers },
  });
  await fx.addCodex([
    message('Current commentary must stay out', { phase: 'commentary' }),
    message('Current final reply', { phase: 'final_answer' }),
    message('Current analysis must stay out', { phase: 'analysis' }),
    message('Legacy final reply', { channel: 'final' }),
    message('Missing markers are ambiguous'),
    message('Conflicting markers stay out', { phase: 'commentary', channel: 'final' }),
    message('Unfamiliar phase stays out', { phase: 'future_phase', channel: 'final' }),
    message('A real user request needs no assistant phase', {}, 'user'),
  ]);
  const { sources: [source] } = await fx.reader.discover({ repo: fx.repo });
  const batch = await fx.reader.readBatch(source, null);
  assert.deepEqual(batch.events.map(event => event.text), ['Current final reply', 'Legacy final reply', 'A real user request needs no assistant phase']);
  assert.ok(batch.warnings.some(warning => warning.includes('Codex assistant message without a final reply marker')));
});

test('Claude excludes tool results, summaries, sidechains, metadata and cross-project rows', async t => {
  const fx = await fixture(t);
  const item = await fx.addClaude('first');
  const lines = [
    claude(item.sessionId, fx.repo.path, '', AT, { message: { content: [{ type: 'tool_result', content: 'tool secret' }] } }),
    claude(item.sessionId, fx.repo.path, 'sidechain secret', AT, { isSidechain: true }),
    claude(item.sessionId, fx.repo.path, 'summary secret', AT, { isCompactSummary: true }),
    claude(item.sessionId, fx.repo.path, 'meta secret', AT, { isMeta: true }),
    claude(item.sessionId, fx.other, 'other project secret'),
    claude(item.sessionId, fx.repo.path, 'last visible', AT + 1000),
  ];
  await fs.appendFile(item.file, lines.map(jsonl).join(''));
  const { sources: [source] } = await fx.reader.discover({ repo: fx.repo });
  const batch = await fx.reader.readBatch(source, null);
  assert.deepEqual(batch.events.map(event => event.text), ['first', 'last visible']);
});

test('Claude keeps only completed assistant replies, excluding tool-use commentary and ambiguous text', async t => {
  const fx = await fixture(t);
  const item = await fx.addClaude('request');
  const reply = (text, stop_reason) => claude(item.sessionId, fx.repo.path, '', AT + 1000, {
    type: 'assistant', message: { role: 'assistant', stop_reason, content: [{ type: 'text', text }] },
  });
  await fs.appendFile(item.file, [reply('I will inspect the file', 'tool_use'), reply('still streaming', null), reply('Finished; next step remains', 'end_turn')].map(jsonl).join(''));
  const { sources: [source] } = await fx.reader.discover({ repo: fx.repo });
  const batch = await fx.reader.readBatch(source, null);
  assert.deepEqual(batch.events.map(event => event.text), ['request', 'Finished; next step remains']);
  assert.ok(batch.warnings.some(warning => warning.includes('final reply marker')));
});

test('same-sized in-place changes are replayed even when the final boundary bytes are unchanged', async t => {
  const fx = await fixture(t);
  const item = await fx.addCodex([codex('aaaa'), codex('unchanged '.repeat(30), AT + 1000)]);
  const { sources: [source] } = await fx.reader.discover({ repo: fx.repo });
  const first = await fx.reader.readBatch(source, null);
  await fs.writeFile(item.file, jsonl(codex('bbbb')) + jsonl(codex('unchanged '.repeat(30), AT + 1000)));
  await fs.utimes(item.file, new Date(), new Date(first.cursor.mtimeMs + 1000));
  const replay = await fx.reader.readBatch(source, first.cursor);
  assert.equal(replay.events[0].text, 'bbbb');
  assert.ok(replay.warnings.length);
});

test('source symlinks and a cwd symlink outside a registered root cannot be read', async t => {
  const fx = await fixture(t);
  const outside = path.join(fx.other, 'transcript.jsonl');
  await fs.writeFile(outside, jsonl(codex('outside secret')));
  const bad = await fx.addCodex([]);
  await fs.unlink(bad.file); await fs.symlink(outside, bad.file);
  const cwdLink = path.join(fx.repo.path, 'linked'); await fs.symlink(fx.other, cwdLink);
  await fx.addCodex([codex('cwd secret')], { row: { cwd: cwdLink } });
  const found = await fx.reader.discover({ repo: fx.repo });
  assert.deepEqual(found.sources, []);
  assert.ok(found.warnings.length);
  const good = await fx.addCodex([codex('visible')]);
  const { sources: [source] } = await fx.reader.discover({ repo: fx.repo });
  await fs.unlink(good.file); await fs.symlink(outside, good.file);
  await assert.rejects(fx.reader.readBatch(source, null), /safely read/);
});

test('discovery caps and query failures remain visible', async t => {
  const fx = await fixture(t, { sources: 1 });
  await fx.addCodex([codex('one')]); await fx.addCodex([codex('two')]);
  let found = await fx.reader.discover({ repo: fx.repo });
  assert.equal(found.truncated, true);
  assert.ok(found.warnings.some(warning => warning.includes('incomplete')));
  fx.snapshots.query = async () => { throw new Error('fixture read failure'); };
  found = await fx.reader.discover({ repo: fx.repo });
  assert.equal(found.truncated, true);
  assert.ok(found.warnings.some(warning => warning.includes('could not be read')));
});

test('empty and metadata-only Claude files are discovered when their first conversation arrives', async t => {
  const fx = await fixture(t);
  const sessionId = id(), file = path.join(fx.claudeRoot, `${sessionId}.jsonl`);
  await fs.writeFile(file, jsonl({ type: 'queue-operation', operation: 'dequeue' }));
  const empty = await fx.reader.discover({ repo: fx.repo });
  assert.deepEqual(empty.sources, []); assert.equal(empty.truncated, false);
  await fs.appendFile(file, jsonl(claude(sessionId, fx.repo.path, 'a new request')));
  const ready = await fx.reader.discover({ repo: fx.repo });
  assert.equal(ready.sources.length, 1);
});

test('long normalized excerpts are explicitly marked truncated and cursor stores no message text', async t => {
  const fx = await fixture(t);
  await fx.addCodex([codex('A'.repeat(2000))]);
  const { sources: [source] } = await fx.reader.discover({ repo: fx.repo });
  const batch = await fx.reader.readBatch(source, null);
  assert.equal(batch.events[0].text.length, 1000);
  assert.equal(batch.events[0].truncated, true);
  assert.ok(!JSON.stringify(batch.cursor).includes('AAAA'));
});
