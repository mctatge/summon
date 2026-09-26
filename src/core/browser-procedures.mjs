import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// The model may label inputs and explain a recording. It never supplies executable steps.
const VERSION = 1;
const LIMITS = { events: 80, parameters: 12, controls: 80, utterances: 30, text: 4000, value: 500, selector: 1000, bytes: 512 * 1024, fileBytes: 8 * 1024 * 1024, procedures: 100 };
const FORBIDDEN_NAMES = new Set(['__proto__', 'prototype', 'constructor']);
const BAD_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;
const SENSITIVE = /password|passwd|passcode|one[\s_-]*time|\botp\b|\bcvv\b|\bcvc\b|\bssn\b|social[\s_-]*security|credit[\s_-]*card|card[\s_-]*number|api[\s_-]*key|access[\s_-]*token|secret|recovery[\s_-]*code/i;
const TARGET_KEYS = ['selector', 'tag', 'role', 'name', 'placeholder', 'inputType'];
const PROCEDURE_KEYS = ['id', 'version', 'name', 'summary', 'scope', 'url', 'title', 'intent', 'utterances', 'parameters', 'steps', 'verification', 'createdAt', 'updatedAt'];
const own = (value, key) => Object.hasOwn(value, key);
const clone = value => structuredClone(value);

function record(value, label, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${label} must be a plain object.`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || FORBIDDEN_NAMES.has(key) || (keys && !keys.includes(key))) throw new Error(`Unsupported ${label} field: ${String(key)}.`);
    if (!own(Object.getOwnPropertyDescriptor(value, key), 'value')) throw new Error(`${label} cannot contain accessors.`);
  }
  return value;
}
function string(value, label, max = LIMITS.text, { empty = false, templates = false } = {}) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || BAD_TEXT.test(value)) throw new Error(`${label} must be valid text of at most ${max} characters.`);
  if (!templates && /\{\{|\}\}/u.test(value)) throw new Error(`${label} cannot contain template syntax.`);
  return value;
}
function boundedArray(value, label, max, min = 0) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < min || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) throw new Error(`${label} must contain ${min} to ${max} items.`);
  for (let index = 0; index < value.length; index++) if (!Object.getOwnPropertyDescriptor(value, index) || !own(Object.getOwnPropertyDescriptor(value, index), 'value')) throw new Error(`${label} cannot contain missing items or accessors.`);
  return value;
}
function site(value) {
  string(value, 'Page URL', 2000);
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('A valid browser page URL is required.'); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Only ordinary HTTP or HTTPS pages can be taught.');
  // Query strings and fragments may contain personal tokens; they are not a teaching scope.
  return { origin: parsed.origin, pathname: parsed.pathname, url: `${parsed.origin}${parsed.pathname}` };
}
function inScope(value, scope) {
  const parsed = site(value);
  if (parsed.origin !== scope.origin || parsed.pathname !== scope.pathname) throw new Error('A demonstration must stay on the same page origin and path.');
  return parsed.url;
}
function target(input, { templates = false, requireLocator = true } = {}) {
  record(input, 'target', TARGET_KEYS);
  const result = {};
  for (const key of TARGET_KEYS) if (own(input, key)) result[key] = string(input[key], `Target ${key}`, key === 'selector' ? LIMITS.selector : LIMITS.value, { empty: true, templates });
  if (SENSITIVE.test(Object.values(result).join(' '))) throw new Error('Sensitive fields cannot be recorded or replayed.');
  if (result.inputType && !['text', 'search', 'number', 'url', 'email', 'tel', 'button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'date', 'time', 'month', 'week', 'datetime-local', 'color', ''].includes(result.inputType.toLowerCase())) throw new Error('Unsupported input type in demonstration.');
  if (requireLocator && !result.selector?.trim() && !result.name?.trim() && !result.placeholder?.trim()) throw new Error('Each step needs an identifiable target.');
  return result;
}
function snapshot(input, scope) {
  record(input, 'page snapshot', ['url', 'text', 'controls']);
  const result = {};
  if (own(input, 'url')) result.url = inScope(input.url, scope);
  if (own(input, 'text')) result.text = string(input.text, 'Page text', LIMITS.text, { empty: true });
  if (own(input, 'controls')) result.controls = boundedArray(input.controls, 'Page controls', LIMITS.controls).map(item => target(item, { requireLocator: false }));
  return result;
}
function event(input, scope, templates = false) {
  record(input, 'event', ['kind', 'target', 'value', 'before', 'after']);
  if (!['fill', 'click', 'select', 'press'].includes(input.kind)) throw new Error('Unsupported demonstration action.');
  const result = { kind: input.kind, target: target(input.target, { templates }) };
  if (['fill', 'select', 'press'].includes(input.kind) || own(input, 'value')) result.value = string(input.value, 'Step value', LIMITS.value, { empty: input.kind === 'fill', templates });
  if (input.kind === 'press' && input.value !== 'Enter') throw new Error('Only Enter can be replayed as a key press.');
  if (input.kind === 'click' && own(input, 'value')) throw new Error('Click steps cannot contain a value.');
  if (own(input, 'before')) result.before = snapshot(input.before, scope);
  if (own(input, 'after')) result.after = snapshot(input.after, scope);
  return result;
}
function byteLimit(value, max = LIMITS.bytes) {
  if (Buffer.byteLength(JSON.stringify(value)) > max) throw new Error('The browser demonstration is too large.');
  return value;
}

export function validateDemonstration(input) {
  record(input, 'demonstration', ['url', 'title', 'intent', 'utterances', 'events']);
  const scope = site(input.url);
  return byteLimit({
    url: scope.url,
    title: string(input.title ?? '', 'Page title', 500, { empty: true }),
    intent: string(input.intent, 'Demonstration intent', LIMITS.text),
    utterances: boundedArray(input.utterances ?? [], 'Utterances', LIMITS.utterances).map(item => string(item, 'Utterance', LIMITS.text)),
    events: boundedArray(input.events, 'Demonstration events', LIMITS.events, 1).map(item => event(item, scope)),
  });
}
function parameter(input) {
  record(input, 'parameter', ['name', 'label', 'example', 'primary']);
  if (typeof input.name !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(input.name) || FORBIDDEN_NAMES.has(input.name)) throw new Error('Invalid parameter name.');
  if (typeof input.primary !== 'boolean') throw new Error('Each parameter must declare whether it is primary.');
  return { name: input.name, label: string(input.label, 'Parameter label', 100), example: string(input.example, 'Parameter example', LIMITS.value), primary: input.primary };
}
function parameters(input) {
  const result = boundedArray(input, 'Parameters', LIMITS.parameters).map(parameter);
  if (new Set(result.map(item => item.name)).size !== result.length || new Set(result.map(item => item.example)).size !== result.length) throw new Error('Parameter names and examples must be unique.');
  if (result.filter(item => item.primary).length > 1) throw new Error('Only one parameter can be primary.');
  return result;
}
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function templatedText(value, params) {
  if (!value || !params.length) return value;
  const byExample = new Map(params.map(item => [item.example, item.name]));
  // One pass avoids reinterpreting an inserted parameter name as another example.
  const expression = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${[...byExample.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}_])`, 'gu');
  return value.replace(expression, example => `{{${byExample.get(example)}}}`);
}

export function compileProcedure(input, analysis) {
  const demo = validateDemonstration(input);
  record(analysis, 'analysis', ['name', 'summary', 'parameters', 'verificationText']);
  const params = parameters(analysis.parameters);
  const observedValues = new Set(demo.events.filter(item => ['fill', 'select'].includes(item.kind)).map(item => item.value));
  for (const item of params) if (!observedValues.has(item.example)) throw new Error('Parameter examples must come from a recorded fill or selection.');
  const steps = demo.events.map(observed => {
    const step = clone(observed);
    if (['fill', 'select'].includes(step.kind)) {
      const param = params.find(item => item.example === step.value);
      if (param) step.value = `{{${param.name}}}`;
    }
    for (const key of ['name', 'placeholder']) if (step.target[key]) step.target[key] = templatedText(step.target[key], params);
    // Never interpolate untrusted text into CSS syntax. Use its recorded accessible
    // name/placeholder instead; refuse the recording if there is no such locator.
    if (step.target.selector && params.some(item => step.target.selector.includes(item.example))) {
      delete step.target.selector;
      if (!step.target.name && !step.target.placeholder) throw new Error('This changing target needs an accessible name or placeholder.');
    }
    return step;
  });
  const scope = site(demo.url);
  const at = new Date().toISOString();
  const evidence = string(analysis.verificationText ?? '', 'Verification text', 240, { empty: true });
  const final = demo.events.at(-1);
  const primary = params.find(item => item.primary);
  const expected = templatedText(evidence, params);
  const verification = evidence.trim() && typeof final.before?.text === 'string' && typeof final.after?.text === 'string' && final.after.text.includes(evidence) && !final.before.text.includes(evidence) && (!primary || expected.includes(`{{${primary.name}}}`))
    ? { text: expected } : null;
  return checkedProcedure({ id: randomUUID(), version: VERSION, name: string(analysis.name, 'Procedure name', 120), summary: string(analysis.summary, 'Procedure summary', LIMITS.text), scope: { origin: scope.origin, pathname: scope.pathname }, url: demo.url, title: demo.title, intent: demo.intent, utterances: demo.utterances, parameters: params, steps, verification, createdAt: at, updatedAt: at });
}
function identifier(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value) || FORBIDDEN_NAMES.has(value)) throw new Error('Invalid procedure id.');
  return value;
}
function checkedDate(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('Invalid procedure date.');
  return new Date(value).toISOString();
}
function checkedProcedure(input) {
  record(input, 'procedure', PROCEDURE_KEYS);
  if (input.version !== VERSION) throw new Error('Unsupported procedure version.');
  const scope = site(input.url);
  record(input.scope, 'procedure scope', ['origin', 'pathname']);
  if (input.scope.origin !== scope.origin || input.scope.pathname !== scope.pathname) throw new Error('The procedure scope must match its page.');
  const params = parameters(input.parameters);
  const result = { id: identifier(input.id), version: VERSION, name: string(input.name, 'Procedure name', 120), summary: string(input.summary, 'Procedure summary', LIMITS.text), scope: { origin: scope.origin, pathname: scope.pathname }, url: scope.url, title: string(input.title, 'Page title', 500, { empty: true }), intent: string(input.intent, 'Demonstration intent'), utterances: boundedArray(input.utterances, 'Utterances', LIMITS.utterances).map(item => string(item, 'Utterance')), parameters: params, steps: boundedArray(input.steps, 'Procedure steps', LIMITS.events, 1).map(item => event(item, scope, true)), createdAt: checkedDate(input.createdAt), updatedAt: checkedDate(input.updatedAt) };
  const names = new Set(params.map(item => item.name));
  const used = new Set();
  result.verification = null;
  if (input.verification !== null && input.verification !== undefined) {
    record(input.verification, 'verification', ['text']);
    const text = string(input.verification.text, 'Verification text', 240 + LIMITS.parameters * 44, { templates: true });
    const literal = text.replace(/\{\{([a-z][a-z0-9_]{0,39})\}\}/g, (_, name) => {
      if (!names.has(name)) throw new Error('Unknown verification parameter.');
      return params.find(item => item.name === name).example;
    });
    string(literal, 'Verification evidence', 240);
    const final = result.steps.at(-1);
    const primary = params.find(item => item.primary);
    if (typeof final.before?.text !== 'string' || typeof final.after?.text !== 'string' || !final.after.text.includes(literal) || final.before.text.includes(literal) || (primary && !text.includes(`{{${primary.name}}}`))) throw new Error('Verification must be grounded in the final recorded page transition.');
    result.verification = { text };
  }
  for (const step of result.steps) {
    if (/\{\{|\}\}/u.test(step.target.selector ?? '')) throw new Error('Selectors cannot contain parameters.');
    for (const field of [step.value, step.target.name, step.target.placeholder].filter(item => item !== undefined)) {
      const remainder = field.replace(/\{\{([a-z][a-z0-9_]{0,39})\}\}/g, (_, name) => {
        if (!names.has(name)) throw new Error('Unknown step parameter.');
        used.add(name); return '';
      });
      if (/\{\{|\}\}/u.test(remainder)) throw new Error('Malformed step template.');
    }
    for (const key of ['tag', 'role', 'inputType']) if (/\{\{|\}\}/u.test(step.target[key] ?? '')) throw new Error('Only names and placeholders can be parameterized.');
  }
  if (params.some(item => !used.has(item.name))) throw new Error('A parameter must occur in a recorded step.');
  return byteLimit(result);
}

export function bindProcedure(input, values = {}) {
  const procedure = checkedProcedure(input);
  record(values, 'parameter values', procedure.parameters.map(item => item.name));
  const bindings = Object.fromEntries(procedure.parameters.map(item => [item.name, string(own(values, item.name) ? values[item.name] : item.example, `Value for ${item.label}`, LIMITS.value)]));
  const bind = value => value.replace(/\{\{([a-z][a-z0-9_]{0,39})\}\}/g, (_, name) => bindings[name]);
  const steps = procedure.steps.map(original => {
    const step = clone(original);
    if (step.value !== undefined) step.value = bind(step.value);
    for (const key of ['name', 'placeholder']) if (step.target[key]) step.target[key] = bind(step.target[key]);
    // Re-check concrete lengths and sensitive target descriptors after binding.
    return event(step, procedure.scope);
  });
  return { ...procedure, steps, bindings, verification: procedure.verification ? { text: string(bind(procedure.verification.text), 'Bound verification text', LIMITS.text) } : null };
}

export async function createProcedureStore({ dataDir } = {}) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || dataDir.includes('\0') || path.normalize(dataDir) !== dataDir) throw new Error('Browser procedures need a full data folder path.');
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const filename = path.join(dataDir, 'procedures.json');
  let procedures = new Map(), queue = Promise.resolve(), closed = false;
  try {
    const handle = await fs.open(filename, 'r');
    let content;
    try {
      if ((await handle.stat()).size > LIMITS.fileBytes) throw new Error('The procedures file is too large.');
      content = await handle.readFile('utf8');
    } finally { await handle.close(); }
    if (Buffer.byteLength(content) > LIMITS.fileBytes) throw new Error('The procedures file is too large.');
    const parsed = JSON.parse(content);
    record(parsed, 'procedures file', ['version', 'procedures']);
    if (parsed.version !== VERSION) throw new Error('Unsupported procedures file version.');
    for (const raw of boundedArray(parsed.procedures, 'Saved procedures', LIMITS.procedures)) {
      const procedure = checkedProcedure(raw);
      if (procedures.has(procedure.id)) throw new Error('Duplicate procedure id.');
      procedures.set(procedure.id, procedure);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Browser procedures could not be read; the original file was left untouched. ${error.message}`);
  }
  async function write(next) {
    const contents = `${JSON.stringify({ version: VERSION, procedures: [...next.values()] }, null, 2)}\n`;
    if (Buffer.byteLength(contents) > LIMITS.fileBytes) throw new Error('The procedures file would be too large.');
    const tmp = path.join(dataDir, `.procedures-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(tmp, 'wx', 0o600);
      await handle.writeFile(contents); await handle.sync(); await handle.close(); handle = null;
      await fs.rename(tmp, filename);
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(tmp).catch(() => {});
      throw new Error(`Browser procedures could not be saved. ${error.message}`);
    }
  }
  function mutation(operation) {
    if (closed) return Promise.reject(new Error('Summon is closing. No browser procedures were changed.'));
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }
  function list(options = {}) {
    record(options, 'list options', ['url']);
    const scope = own(options, 'url') ? site(options.url) : null;
    return clone([...procedures.values()].filter(item => !scope || (item.scope.origin === scope.origin && item.scope.pathname === scope.pathname)));
  }
  function get(id) { return clone(procedures.get(identifier(id)) ?? null); }
  function save(input) {
    let procedure;
    try { procedure = checkedProcedure(input); } catch (error) { return Promise.reject(error); }
    return mutation(async () => {
      const previous = procedures.get(procedure.id);
      if (previous && (previous.scope.origin !== procedure.scope.origin || previous.scope.pathname !== procedure.scope.pathname)) throw new Error('A saved procedure cannot move to another page.');
      const next = new Map(procedures);
      next.set(procedure.id, { ...procedure, createdAt: previous?.createdAt ?? procedure.createdAt, updatedAt: new Date().toISOString() });
      if (next.size > LIMITS.procedures) throw new Error('At most 100 browser procedures can be saved.');
      await write(next); procedures = next;
      return get(procedure.id);
    });
  }
  function remove(id) {
    try { identifier(id); } catch (error) { return Promise.reject(error); }
    return mutation(async () => {
      if (!procedures.has(id)) return false;
      const next = new Map(procedures); next.delete(id);
      await write(next); procedures = next;
      return true;
    });
  }
  async function close() { closed = true; await queue; }
  return { list, get, save, remove, close };
}
