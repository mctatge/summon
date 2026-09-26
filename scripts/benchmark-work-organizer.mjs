#!/usr/bin/env node
// Local-only frozen evaluation. No production hierarchy writes or provider calls.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createLocalInterpreter, DEFAULT_LOCAL_MODEL } from '../src/main/local-model.mjs';
import { workOrganizerCases } from './fixtures/work-organizer-cases.mjs';
import { ORGANIZER_SCHEMA, ORGANIZER_SYSTEM, GROUP_SCHEMA, GROUP_SYSTEM, modelInput, scoreDecisions, scoreGroups, replayInIsolation } from './experiments/work-organizer-eval.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const outputDir = path.resolve(option('--output', '/private/tmp/summon-work-organizer-eval'));
const snapshotPath = option('--snapshot', null);
const modelInfoPath = option('--model-info', null);
const validateOnly = args.includes('--validate-only');
const sha256 = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2 : null; };
const scenarios = workOrganizerCases.map(fixture => ({ ...fixture, input: modelInput(fixture) }));
const snapshot = snapshotPath ? JSON.parse(await fs.readFile(snapshotPath, 'utf8')) : null;
const manifest = { version: 1, createdAt: new Date().toISOString(), model: DEFAULT_LOCAL_MODEL,
  modelInfo: modelInfoPath ? JSON.parse(await fs.readFile(modelInfoPath, 'utf8')) : null,
  acceptance: { decisionCases: scenarios.length, minimumCorrect: Math.ceil(scenarios.length * .9), maximumCriticalFailures: 0, maximumIncompleteCalls: 0, maximumInvalidOutputs: 0,
    backgroundMedianTargetMs: 10000, note: 'Preliminary smoke screen, not statistical proof. Group semantic review is separate. A guard rejection does not turn a wrong model answer into a pass.' },
  decoding: { temperature: 0, seed: 42, num_ctx: 8192, num_predict: 1024, timeoutMs: 90000 },
  cases: scenarios, snapshot, prompts: { decisions: ORGANIZER_SYSTEM, grouping: GROUP_SYSTEM }, schemas: { decisions: ORGANIZER_SCHEMA, grouping: GROUP_SCHEMA },
  hashes: { fixtures: sha256(workOrganizerCases), snapshot: snapshot ? sha256(snapshot) : null, prompt: sha256(ORGANIZER_SYSTEM), schema: sha256(ORGANIZER_SCHEMA) },
};
for (const fixture of scenarios) {
  if (!fixture.expected.length || fixture.expected.length !== fixture.events.length) throw new Error(`Invalid fixture expectation count: ${fixture.id}`);
  if (fixture.expected.some(expected => ['action', 'targetIds', 'parentIds', 'statuses'].some(key => !Array.isArray(expected[key]) || !expected[key].length))) throw new Error(`Invalid fixture allowed decisions: ${fixture.id}`);
}
if (validateOnly) { console.log(JSON.stringify({ valid: true, cases: scenarios.length, hashes: manifest.hashes })); process.exit(0); }
await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
// Never silently replace an earlier experiment or its raw responses.
await fs.writeFile(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
const write = async entry => { await fs.appendFile(path.join(outputDir, 'results.jsonl'), `${JSON.stringify(entry)}\n`, { mode: 0o600 }); console.log(JSON.stringify(entry.phase === 'case' ? { phase: entry.phase, id: entry.id, passed: entry.score?.passed ?? false, wallMs: entry.wallMs, error: entry.error ?? null } : entry)); };
let telemetry = null;
const fetcher = async (url, init) => {
  if (!url.startsWith('http://127.0.0.1:11434/')) throw new Error('Only local inference is allowed');
  const response = await fetch(url, init);
  if (url.endsWith('/api/generate') && JSON.parse(init.body || '{}').prompt) {
    const body = await response.clone().json();
    telemetry = { done: body.done, doneReason: body.done_reason, promptTokens: body.prompt_eval_count, outputTokens: body.eval_count,
      loadMs: Math.round((body.load_duration ?? 0) / 1e6), promptMs: Math.round((body.prompt_eval_duration ?? 0) / 1e6), decodeMs: Math.round((body.eval_duration ?? 0) / 1e6), response: body.response };
  }
  return response;
};
const local = createLocalInterpreter({ fetcher, contextTimeoutMs: 90000 });
const health = await local.health();
await write({ phase: 'health', ...health });
if (!health.available) throw new Error(health.error);
const rows = [];
for (const fixture of scenarios) {
  telemetry = null; const start = performance.now(); let raw = null, error = null;
  try { ({ raw } = await local.reasonStructured({ systemPrompt: ORGANIZER_SYSTEM, schema: ORGANIZER_SCHEMA, prompt: `PROJECT_WORK_AND_NEW_EVIDENCE\n${JSON.stringify(fixture.input)}` })); }
  catch (failure) { error = { code: failure.code ?? null, message: failure.message }; }
  const wallMs = Math.round(performance.now() - start);
  const score = scoreDecisions(raw, fixture);
  const replay = raw ? await replayInIsolation(path.join(outputDir, 'replay', fixture.id), fixture, raw) : null;
  const row = { phase: 'case', id: fixture.id, category: fixture.category, provenance: fixture.provenance, wallMs, raw, error, telemetry, score, replay };
  rows.push(row); await write(row);
}
if (snapshot) {
  telemetry = null; const start = performance.now(); let raw = null, error = null;
  try { ({ raw } = await local.reasonStructured({ systemPrompt: GROUP_SYSTEM, schema: GROUP_SCHEMA, prompt: `PROJECT_WORK\n${JSON.stringify(snapshot)}` })); }
  catch (failure) { error = { code: failure.code ?? null, message: failure.message }; }
  await write({ phase: 'grouping', wallMs: Math.round(performance.now() - start), raw, error, telemetry, score: scoreGroups(raw, snapshot) });
}
const semanticGatePassed = rows.filter(row => row.score.passed).length >= manifest.acceptance.minimumCorrect && rows.every(row => !row.score.criticalFailures && !row.error && !row.score.validation.length);
const latencyGatePassed = median(rows.map(row => row.wallMs)) <= manifest.acceptance.backgroundMedianTargetMs;
const summary = { phase: 'summary', model: DEFAULT_LOCAL_MODEL, total: rows.length, passed: rows.filter(row => row.score.passed).length,
  criticalFailures: rows.reduce((n, row) => n + row.score.criticalFailures, 0), incompleteCalls: rows.filter(row => row.error).length,
  invalidOutputs: rows.filter(row => row.score.validation.length).length,
  medianMs: median(rows.map(row => row.wallMs)), slowestMs: Math.max(...rows.map(row => row.wallMs)),
  replayChecks: rows.filter(row => row.replay?.passed).length,
  semanticGatePassed, latencyGatePassed, preliminaryGatePassed: semanticGatePassed && latencyGatePassed,
  limitations: 'One deterministic pass on 12 curated cases. Some observed-context paraphrases, some synthetic. No live transcript ingestion, runtime integration or UI resurfacing tested. Group semantics reviewed separately. Current Ollama may serve other app requests; latency is observational. Model left to its normal 60-second expiry to avoid disrupting other clients.' };
await write(summary);
await fs.writeFile(path.join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
if (!summary.preliminaryGatePassed) process.exitCode = 1;
