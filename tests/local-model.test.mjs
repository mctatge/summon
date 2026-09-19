import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalInterpreter, validateProposal, commandSchema, DEFAULT_LOCAL_MODEL } from '../src/main/local-model.mjs';

const projects = [{ id: 'studio', name: 'Studio' }, { id: 'learning', name: 'Learning' }];
const proposal = (action, extra = {}) => ({ action, ...extra });
const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
function fakeServer(generate, options = {}) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    assert.match(url, /^http:\/\/127\.0\.0\.1:1143[45]\/api\//);
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
    assert.equal(init.headers.Authorization, undefined);
    const route = new URL(url).pathname;
    if (route === '/api/version') return json({ version: 'test' });
    if (route === '/api/tags') return json({ models: options.models ?? [{ name: DEFAULT_LOCAL_MODEL, size: 695_755_488, details: { family: 'lfm2' } }] });
    if (route === '/api/ps') return json({ models: options.loaded ? [{ name: DEFAULT_LOCAL_MODEL }] : [] });
    if (route === '/api/generate') {
      const body = JSON.parse(init.body);
      if (body.keep_alive === 0) return json({ done: true });
      if (generate) return generate(body, init);
      return json({ done: true, done_reason: 'stop', response: JSON.stringify(proposal('open_calendar')) });
    }
    throw new Error('Unexpected endpoint');
  };
  return { fetcher, calls };
}

test('local interpreter can only reach fixed loopback ports', () => {
  assert.throws(() => createLocalInterpreter({ port: 443 }), /fixed local/);
  assert.throws(() => createLocalInterpreter({ port: '11434' }), /fixed local/);
  assert.throws(() => createLocalInterpreter({ timeoutMs: 999999 }), /timeout/);
});

test('the default accepts the small local Liquid model without relaxing cloud or size checks', async () => {
  assert.equal(DEFAULT_LOCAL_MODEL, 'summon-local:latest');
  for (const [entry, allowed] of [
    [{ name: DEFAULT_LOCAL_MODEL, size: 695_755_488, details: { family: 'lfm2' } }, true],
    [{ name: DEFAULT_LOCAL_MODEL, size: 695_755_488, details: { family: 'lfm2' }, remote_model: 'hosted-model' }, false],
    [{ name: DEFAULT_LOCAL_MODEL, size: 4 * 1024 ** 3, details: { family: 'lfm2' } }, false],
  ]) {
    const server = fakeServer(null, { models: [entry] });
    const local = createLocalInterpreter({ fetcher: server.fetcher });
    assert.equal((await local.health()).available, allowed);
    assert.equal(server.calls.some(call => call.url.endsWith('/api/generate')), false);
    await local.close();
  }
});

test('safe actions become canonical proposals, never executable model text', () => {
  assert.deepEqual(validateProposal(proposal('open_calendar'), { text: 'Could you bring up my appointments?' }).action, { type: 'open_calendar' });
  const found = validateProposal(proposal('find_files', { query: 'Excel workbook' }), { text: 'I need the spreadsheet from earlier.' });
  assert.equal(found.command, 'find files Excel workbook');
  assert.equal(validateProposal(proposal('check_models', { category: 'coding' }), { text: 'Which model is best for coding?' }).command, 'best coding model');
  assert.equal(validateProposal(proposal('show_context'), { text: 'What project am I working on?' }).command, 'show my context');
});

test('workspace ID must be known, mentioned, and unambiguous', () => {
  assert.equal(validateProposal(proposal('set_project', { projectId: 'studio' }), { text: 'Back to Studio please.', projects }).command, 'working on Studio');
  assert.equal(validateProposal(proposal('set_project', { projectId: 'learning' }), { text: "I'm switching gears to Learning now.", projects }).command, 'working on Learning');
  for (const [text, id] of [['Back to Studio please.', 'unknown'], ['Which is better?', 'studio'], ['Studio or Learning?', 'studio']]) {
    assert.equal(validateProposal(proposal('set_project', { projectId: id }), { text, projects }).kind, 'clarify');
  }
});

test('reject unsupported, compound, ambiguous, malformed, and injected outputs', () => {
  const cases = [
    [proposal('open_calendar'), 'Delete all appointments.'],
    [proposal('open_calendar'), 'Show my calendar and then delete the workbook.'],
    [proposal('open_calendar'), 'Show my calendar and find a file.'],
    [proposal('open_calendar'), 'Do that thing.'],
    [proposal('open_calendar'), 'Tell me a joke about calendars.'],
    [proposal('find_files', { query: 'report' }), 'Tell me a story about a report.'],
    [proposal('set_project', { projectId: 'studio' }), 'What do you think of Studio?'],
    [proposal('check_models', { category: 'combined' }), 'Tell me about language models.'],
    [proposal('open_calendar', { query: 'rm -rf /' }), 'Show my calendar'],
    [{ ...proposal('open_calendar'), shell: 'open /tmp/secret' }, 'Show my calendar'],
    [proposal('find_files', { query: 'foo\nopen calendar' }), 'Find the file'],
    [proposal('execute', { query: 'rm -rf /' }), 'Find the file'],
    [proposal('check_models', { category: 'secret' }), 'Which model?'],
    [[], 'Find a file'], [null, 'Find a file'],
  ];
  for (const [raw, text] of cases) assert.equal(validateProposal(raw, { text, projects }).kind, 'clarify');
});

test('health is metadata-only, supports synchronous status, and rejects missing/oversized/remote models', async () => {
  for (const models of [[], [{ name: DEFAULT_LOCAL_MODEL, size: 47_000_000_000, details: { family: 'qwen2' } }], [{ name: DEFAULT_LOCAL_MODEL, size: 10, remote_host: 'https://example.com', details: { family: 'qwen2' } }], [{ name: DEFAULT_LOCAL_MODEL, size: 45_000_000, details: { family: 'bert' } }]]) {
    const server = fakeServer(null, { models });
    const local = createLocalInterpreter({ fetcher: server.fetcher });
    assert.equal((await local.health()).available, false);
    assert.equal(local.status().available, false);
    assert.equal((await local.suggestCommand('My calendar please.')).kind, 'unavailable');
    assert.equal(server.calls.some(call => call.url.endsWith('/api/generate')), false);
  }
});

test('synthetic request sends bounded minimal metadata, no paths or other context', async () => {
  const server = fakeServer(); const local = createLocalInterpreter({ fetcher: server.fetcher });
  const result = await local.suggestCommand('My calendar please.', { projects: projects.map(p => ({ ...p, path: '/private/should-not-leave' })), context: { app: 'Example App', title: 'Private title', files: [{ path: '/private/file' }] } });
  assert.equal(result.kind, 'proposal');
  const generation = server.calls.find(call => call.body?.prompt);
  assert.equal(generation.body.options.num_ctx, 1024);
  assert.equal(generation.body.options.num_predict, 96);
  assert.equal(generation.body.keep_alive, '60s');
  assert.equal(generation.body.prompt.includes('/private'), false);
  assert.equal(generation.body.prompt.includes('Private title'), false);
  assert.deepEqual(Object.keys(JSON.parse(generation.body.prompt)), ['workspaces', 'app', 'request']);
  assert.equal(await local.unload(), true);
  assert.equal(server.calls.at(-1).body.keep_alive, 0);
  await local.close();
});

test('malformed/truncated output cannot produce a proposal', async () => {
  for (const result of [{ done: true, response: '{oops' }, { done: true, done_reason: 'length', response: JSON.stringify(proposal('open_calendar')) }, { done: true, prompt_eval_count: 1000, response: JSON.stringify(proposal('open_calendar')) }, { done: false, response: JSON.stringify(proposal('open_calendar')) }]) {
    const local = createLocalInterpreter({ fetcher: fakeServer(() => json(result)).fetcher });
    assert.equal((await local.suggestCommand('My calendar please.')).kind, 'clarify');
    await local.close();
  }
});

test('forbidden requests never call the model', async () => {
  const server = fakeServer(); const local = createLocalInterpreter({ fetcher: server.fetcher });
  assert.equal((await local.suggestCommand('Delete the workbook and email it.')).kind, 'clarify');
  assert.equal((await local.suggestCommand('x'.repeat(601))).kind, 'clarify');
  assert.equal(server.calls.length, 0);
});

test('local generation times out visibly and never falls back to a cloud endpoint', async () => {
  const server = fakeServer((_body, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })));
  const local = createLocalInterpreter({ fetcher: server.fetcher, timeoutMs: 50 });
  const result = await local.suggestCommand('My calendar please.');
  assert.equal(result.kind, 'unavailable'); assert.match(result.message, /timed out/);
  assert.equal(server.calls.filter(call => call.body?.prompt).length, 1);
  await local.close();
});

test('concurrent requests are refused and shutdown cancels active generation', async () => {
  let entered; const waiting = new Promise(resolve => { entered = resolve; });
  const server = fakeServer((_body, init) => { entered(); return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })); });
  const local = createLocalInterpreter({ fetcher: server.fetcher });
  const pending = local.suggestCommand('My calendar please.'); await waiting;
  assert.equal((await local.suggestCommand('My appointments please.')).kind, 'unavailable');
  await local.close();
  assert.match((await pending).message, /closing/);
  assert.equal((await local.suggestCommand('My calendar please.')).kind, 'unavailable');
});

test('does not unload a model that another application had already loaded', async () => {
  const server = fakeServer(null, { loaded: true }); const local = createLocalInterpreter({ fetcher: server.fetcher });
  await local.suggestCommand('My calendar please.');
  assert.equal(await local.unload(), false);
  await local.close();
  assert.equal(server.calls.some(call => call.body?.keep_alive === 0), false);
});

test('benchmark category must agree with the stated task', () => {
  assert.equal(validateProposal(proposal('check_models', { category: 'reasoning' }), { text: 'What is the best model for coding?' }).kind, 'clarify');
  assert.equal(validateProposal(proposal('check_models', { category: 'speed' }), { text: 'What is the fastest model?' }).kind, 'proposal');
});

test('generation grammar and validator share the explicit ranking category constraint', async () => {
  for (const [text, category] of [['Which model is best at programming?', 'coding'], ['Compare the best reasoning model.', 'reasoning'], ['What model is fastest?', 'speed']]) {
    const server = fakeServer(() => json({ done: true, response: JSON.stringify(proposal('check_models', { category })) }));
    const local = createLocalInterpreter({ fetcher: server.fetcher });
    assert.equal((await local.suggestCommand(text)).action.category, category);
    const schema = server.calls.find(call => call.body?.prompt).body.format;
    assert.deepEqual(schema.oneOf.find(shape => shape.properties.category).properties.category.enum, [category]);
    assert.equal(schema.oneOf.some(shape => shape.properties.action.enum.includes('clarify')), true);
    await local.close();
  }
  assert.equal(validateProposal(proposal('check_models', { category: 'coding' }), { text: 'Which model is best for coding and reasoning?' }).kind, 'clarify');
});

test('schema exposes only the safe enum and known project IDs', () => {
  const schema = commandSchema(projects);
  assert.equal(schema.oneOf.every(shape => shape.additionalProperties === false), true);
  assert.deepEqual(schema.oneOf.find(shape => shape.properties.projectId).properties.projectId.enum, ['studio', 'learning']);
  const actions = schema.oneOf.flatMap(shape => shape.properties.action.enum);
  assert.equal(actions.includes('open_file'), false);
  assert.equal(actions.includes('shell'), false);
});
