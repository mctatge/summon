#!/usr/bin/env node
// Synthetic only: no personal file paths, workspace names, or app activity.
// Uses an already-installed model. Does not download or delete models.
import { createLocalInterpreter, DEFAULT_LOCAL_MODEL } from '../src/main/local-model.mjs';

const args = process.argv.slice(2);
const value = flag => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
const model = value('--model') || DEFAULT_LOCAL_MODEL;
const port = Number(value('--port') || 11434);
const timeoutMs = Number(value('--timeout') || 35000);
const inferenceRecords = [];
const fetcher = async (url, init) => {
  const response = await fetch(url, init);
  if (url.endsWith('/api/generate') && JSON.parse(init.body || '{}').prompt) {
    const data = await response.clone().json();
    const record = { promptTokens: data.prompt_eval_count, generatedTokens: data.eval_count, loadMs: Math.round((data.load_duration || 0) / 1e6), generationMs: Math.round((data.eval_duration || 0) / 1e6) };
    inferenceRecords.push(record);
    if (args.includes('--debug')) console.log(JSON.stringify({ phase: 'synthetic-raw', response: data.response, ...record }));
  }
  return response;
};
const interpreter = createLocalInterpreter({ model, port, timeoutMs, fetcher });
const projects = [{ id: 'studio', name: 'Studio' }, { id: 'learning', name: 'Learning' }];
const cases = args.includes('--fresh') ? [
  ['Could I see my schedule for today?', 'open_calendar'],
  ['Locate the invoice PDF from yesterday.', 'find_files'],
  ['Please return to Studio.', 'set_project'],
  ['What workspace is active on this computer?', 'show_context'],
  ['Show me the best reasoning model.', 'check_models', { category: 'reasoning' }],
  ['What is the highest ranked AI model overall?', 'check_models', { category: 'combined' }],
  ['Compare models by response speed.', 'check_models', { category: 'speed' }],
  ['Which is the best model to write code?', 'check_models', { category: 'coding' }],
  ['Tell me whether Studio or Learning would suit this task.', 'clarify'],
  ['Send the PDF to my colleague.', 'clarify'],
  ['Open my schedule and then switch to Learning.', 'clarify'],
  ['Summarize this PDF for me.', 'clarify'],
] : args.includes('--held-out') ? [
  ['Bring the agenda into view.', 'open_calendar'],
  ['Show me the quarterly budget report.', 'find_files'],
  ["I'm switching gears to Learning now.", 'set_project'],
  ['Remind me what work is selected.', 'show_context'],
  ['Which model is the fastest?', 'check_models', { category: 'speed' }],
  ['Tell me a joke about calendars.', 'clarify'],
  ['Use Studio or Learning, whichever is best.', 'clarify'],
  ['View the agenda and find my spreadsheet.', 'clarify'],
] : [
  ['Could you bring up my appointments?', 'open_calendar'],
  ['Can you get the spreadsheet I downloaded earlier?', 'find_files'],
  ['I want to get back to working in Studio.', 'set_project'],
  ['Which project am I working in right now?', 'show_context'],
  ['Which model ranks highest for coding?', 'check_models', { category: 'coding' }],
  ['What is the meaning of life?', 'clarify'],
  ['Delete the workbook and email it to someone.', 'clarify'],
  ['Could you bring up my appointments?', 'open_calendar'],
];
const results = [];
try {
  const health = await interpreter.health();
  console.log(JSON.stringify({ phase: 'health', ...health }));
  if (!health.available) process.exitCode = 1;
  else {
    for (const [text, expected, expectedFields] of cases) {
      const inferenceCount = inferenceRecords.length;
      const output = await interpreter.suggestCommand(text, { projects });
      const actual = output.action?.type || output.kind;
      const passed = actual === expected && Object.entries(expectedFields || {}).every(([key, value]) => output.action?.[key] === value);
      const result = { text, expected, ...(expectedFields ? { expectedFields } : {}), actual, passed, ...output, inference: inferenceRecords.length > inferenceCount ? inferenceRecords.at(-1) : null };
      results.push(result); console.log(JSON.stringify(result));
      if (output.kind === 'unavailable') break;
    }
    const times = results.filter(result => result.elapsedMs > 0).map(result => result.elapsedMs).sort((a, b) => a - b);
    const inferred = results.filter(result => result.inference);
    const warm = inferred.slice(1).map(result => result.elapsedMs).sort((a, b) => a - b);
    console.log(JSON.stringify({ phase: 'summary', measured: 'guarded pipeline outcomes, not raw model accuracy', tested: results.length, passed: results.filter(result => result.passed).length, medianMs: times[Math.floor(times.length / 2)] || 0, inferenceRequests: inferred.length, withoutInference: results.length - inferred.length, firstInferenceMs: inferred[0]?.elapsedMs ?? null, warmInferenceMs: warm.length ? { min: warm[0], median: warm[Math.floor(warm.length / 2)], max: warm.at(-1) } : null, initiallyLoaded: health.loaded, model, port }));
    if (results.some(result => !result.passed)) process.exitCode = 1;
  }
} finally {
  const unloaded = await interpreter.unload();
  console.log(JSON.stringify({ phase: 'cleanup', unloadedModelLoadedByBenchmark: unloaded }));
  await interpreter.close();
}
