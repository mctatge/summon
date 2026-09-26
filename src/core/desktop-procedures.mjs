import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const VERSION = 1;
const LIMITS = { events: 80, controls: 160, apps: 12, parameters: 12, text: 12000, value: 2000, bytes: 1024 * 1024, fileBytes: 16 * 1024 * 1024, procedures: 100 };
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const BAD_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;
const SENSITIVE = /password|passwd|passcode|secure[\s_-]*(?:text|input|field)|one[\s_-]*time|\botp\b|\bcvv\b|\bcvc\b|\bssn\b|social[\s_-]*security|credit[\s_-]*card|card[\s_-]*number|api[\s_-]*key|access[\s_-]*token|secret|recovery[\s_-]*code/i;
const own = (value, key) => Object.hasOwn(value, key);
const clone = value => structuredClone(value);

function record(value, label, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${label} must be a plain object.`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || FORBIDDEN.has(key) || !keys.includes(key)) throw new Error(`Unsupported ${label} field: ${String(key)}.`);
    if (!own(Object.getOwnPropertyDescriptor(value, key), 'value')) throw new Error(`${label} cannot contain accessors.`);
  }
  return value;
}
function string(value, label, max = LIMITS.text, { empty = false, templates = false } = {}) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || BAD_TEXT.test(value)) throw new Error(`${label} must be valid text of at most ${max} characters.`);
  if (!templates && /\{\{|\}\}/u.test(value)) throw new Error(`${label} cannot contain template syntax.`);
  return value;
}
function array(value, label, max, min = 0) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < min || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) throw new Error(`${label} must contain ${min} to ${max} items.`);
  for (let i = 0; i < value.length; i++) if (!own(Object.getOwnPropertyDescriptor(value, i) ?? {}, 'value')) throw new Error(`${label} cannot contain missing items or accessors.`);
  return value;
}
function bundleId(value) {
  string(value, 'Application identifier', 250);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(value) || FORBIDDEN.has(value)) throw new Error('Invalid application identifier.');
  return value;
}
function surface(value, allowedApps) {
  record(value, 'surface', ['kind', 'bundleId', 'app', 'title']);
  if (value.kind !== 'desktop') throw new Error('A desktop surface is required.');
  const id = bundleId(value.bundleId);
  if (allowedApps && !allowedApps.includes(id)) throw new Error('The demonstration contains an application outside its allowed apps.');
  return { kind: 'desktop', bundleId: id, app: string(value.app, 'Application name', 250), title: string(value.title ?? '', 'Window title', 500, { empty: true }) };
}
function target(value, { templates = false } = {}) {
  record(value, 'target', ['role', 'name', 'identifier']);
  const result = { role: string(value.role, 'Target role', 100), name: string(value.name ?? '', 'Target name', LIMITS.value, { empty: true, templates }) };
  if (own(value, 'identifier')) result.identifier = string(value.identifier, 'Target identifier', 500, { empty: true });
  if (!result.name.trim() && !result.identifier?.trim()) throw new Error('A target needs an accessible name or identifier.');
  if (SENSITIVE.test(Object.values(result).join(' '))) throw new Error('Sensitive controls cannot be recorded or replayed.');
  return result;
}
function control(value) {
  record(value, 'control', ['id', 'role', 'name', 'identifier', 'value', 'editable', 'actions']);
  const result = { id: string(value.id, 'Control id', 100), role: string(value.role, 'Control role', 100), name: string(value.name ?? '', 'Control name', LIMITS.value, { empty: true }) };
  if (own(value, 'identifier')) result.identifier = string(value.identifier, 'Control identifier', 500, { empty: true });
  if (own(value, 'value')) result.value = string(value.value, 'Control value', LIMITS.value, { empty: true });
  if (SENSITIVE.test([result.role, result.name, result.identifier ?? ''].join(' '))) throw new Error('Sensitive controls cannot be recorded or replayed.');
  if (typeof value.editable !== 'boolean') throw new Error('A control must declare whether it is editable.');
  result.editable = value.editable;
  result.actions = array(value.actions, 'Control actions', 20).map(item => string(item, 'Control action', 100));
  if (new Set(result.actions).size !== result.actions.length) throw new Error('Control actions must be unique.');
  return result;
}
function bytes(value, max = LIMITS.bytes) {
  if (Buffer.byteLength(JSON.stringify(value)) > max) throw new Error('The desktop demonstration is too large.');
  return value;
}
export function validateDesktopObservation(value, allowedApps) {
  record(value, 'observation', ['surface', 'revision', 'text', 'controls']);
  const result = { surface: surface(value.surface, allowedApps), revision: string(value.revision, 'Observation revision', 200), text: string(value.text, 'Visible text', LIMITS.text, { empty: true }), controls: array(value.controls, 'Controls', LIMITS.controls).map(control) };
  if (new Set(result.controls.map(item => item.id)).size !== result.controls.length) throw new Error('Control IDs must be unique within an observation.');
  return bytes(result);
}
function event(value, allowedApps, templates = false) {
  record(value, 'event', ['kind', 'surface', 'target', 'value', 'before', 'after']);
  if (!['fill', 'click', 'select', 'press', 'activate'].includes(value.kind)) throw new Error('Unsupported desktop action.');
  const result = { kind: value.kind, surface: surface(value.surface, allowedApps) };
  if (value.kind === 'activate') {
    if (own(value, 'target') || own(value, 'value')) throw new Error('An app activation cannot contain a target or value.');
  } else {
    result.target = target(value.target, { templates });
    if (value.kind === 'click') {
      if (own(value, 'value')) throw new Error('Click steps cannot contain values.');
    } else result.value = string(value.value, 'Step value', LIMITS.value, { empty: value.kind === 'fill', templates });
    if (value.kind === 'press' && !['Enter', 'Tab', 'Escape'].includes(value.value)) throw new Error('Only Enter, Tab and Escape can be replayed as keys.');
  }
  for (const key of ['before', 'after']) {
    if (own(value, key)) {
      result[key] = validateDesktopObservation(value[key], allowedApps);
      // Activation is the only primitive that can change the foreground app.
      if ((value.kind !== 'activate' || key === 'after') && result[key].surface.bundleId !== result.surface.bundleId) throw new Error('An action observation must belong to its demonstrated application.');
    }
  }
  return result;
}
export function validateDesktopDemonstration(value) {
  record(value, 'demonstration', ['intent', 'utterances', 'events', 'allowedApps']);
  const allowedApps = array(value.allowedApps, 'Allowed apps', LIMITS.apps, 1).map(bundleId);
  if (new Set(allowedApps).size !== allowedApps.length) throw new Error('Allowed application identifiers must be unique.');
  const result = { intent: string(value.intent, 'Demonstration intent'), utterances: array(value.utterances ?? [], 'Utterances', 30).map(item => string(item, 'Utterance')), events: array(value.events, 'Demonstration events', LIMITS.events, 1).map(item => event(item, allowedApps)), allowedApps };
  return bytes(result);
}
function parameters(values) {
  const result = array(values, 'Parameters', LIMITS.parameters).map(value => {
    record(value, 'parameter', ['name', 'label', 'example', 'primary']);
    if (typeof value.name !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(value.name) || FORBIDDEN.has(value.name)) throw new Error('Invalid parameter name.');
    if (typeof value.primary !== 'boolean') throw new Error('Each parameter must declare whether it is primary.');
    return { name: value.name, label: string(value.label, 'Parameter label', 100), example: string(value.example, 'Parameter example', LIMITS.value), primary: value.primary };
  });
  if (new Set(result.map(item => item.name)).size !== result.length || new Set(result.map(item => item.example)).size !== result.length) throw new Error('Parameter names and examples must be unique.');
  if (result.filter(item => item.primary).length > 1) throw new Error('Only one parameter can be primary.');
  return result;
}
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function template(text, params) {
  if (!text || !params.length) return text;
  const examples = new Map(params.map(item => [item.example, item.name]));
  const expression = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${[...examples.keys()].sort((a, b) => b.length - a.length).map(escape).join('|')})(?![\\p{L}\\p{N}_])`, 'gu');
  return text.replace(expression, example => `{{${examples.get(example)}}}`);
}
function identifier(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value) || FORBIDDEN.has(value)) throw new Error('Invalid procedure id.');
  return value;
}
function date(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('Invalid procedure date.');
  return new Date(value).toISOString();
}
function checkedProcedure(value) {
  record(value, 'procedure', ['id', 'version', 'kind', 'name', 'summary', 'intent', 'parameters', 'steps', 'apps', 'verification', 'createdAt', 'updatedAt']);
  if (value.kind !== 'desktop' || value.version !== VERSION) throw new Error('Unsupported desktop procedure version.');
  const apps = array(value.apps, 'Procedure applications', LIMITS.apps, 1).map(app => {
    record(app, 'application', ['bundleId', 'name']);
    return { bundleId: bundleId(app.bundleId), name: string(app.name, 'Application name', 250) };
  });
  const appIds = apps.map(app => app.bundleId);
  if (new Set(appIds).size !== appIds.length) throw new Error('Procedure applications must be unique.');
  const params = parameters(value.parameters);
  const result = { id: identifier(value.id), version: VERSION, kind: 'desktop', name: string(value.name, 'Procedure name', 120), summary: string(value.summary, 'Procedure summary'), intent: string(value.intent, 'Procedure intent'), parameters: params, steps: array(value.steps, 'Procedure steps', LIMITS.events, 1).map(item => event(item, appIds, true)), apps, verification: null, createdAt: date(value.createdAt), updatedAt: date(value.updatedAt) };
  const used = new Set();
  const unbind = text => {
    const literal = text.replace(/\{\{([a-z][a-z0-9_]{0,39})\}\}/g, (_, name) => {
      const param = params.find(item => item.name === name);
      if (!param) throw new Error('Unknown step parameter.');
      used.add(name); return param.example;
    });
    string(literal, 'Literal step value', LIMITS.text);
    return literal;
  };
  for (const step of result.steps) for (const field of [step.value, step.target?.name].filter(item => item !== undefined && item !== '')) unbind(field);
  if (params.some(item => !used.has(item.name))) throw new Error('A parameter must occur in a recorded step.');
  // Verify parameter provenance even when reading an edited store from disk.
  for (const param of params) if (!result.steps.some(step => ['fill', 'select'].includes(step.kind) && step.value === `{{${param.name}}}`)) throw new Error('Parameter examples must come from a recorded fill or selection.');
  if (value.verification !== null && value.verification !== undefined) {
    record(value.verification, 'verification', ['text']);
    const text = string(value.verification.text, 'Verification text', 1000, { templates: true });
    const literal = unbind(text), final = result.steps.at(-1), primary = params.find(item => item.primary);
    if (typeof final.before?.text !== 'string' || typeof final.after?.text !== 'string' || !final.after.text.includes(literal) || final.before.text.includes(literal) || (primary && !text.includes(`{{${primary.name}}}`))) throw new Error('Verification must be grounded in the final observed transition.');
    result.verification = { text };
  }
  return bytes(result);
}
export function compileDesktopProcedure(input, analysis) {
  const demo = validateDesktopDemonstration(input);
  record(analysis, 'analysis', ['name', 'summary', 'parameters', 'verificationText']);
  const params = parameters(analysis.parameters);
  const observed = new Set(demo.events.filter(item => ['fill', 'select'].includes(item.kind)).map(item => item.value));
  if (params.some(item => !observed.has(item.example))) throw new Error('Parameter examples must come from a recorded fill or selection.');
  const steps = demo.events.map(original => {
    const step = clone(original);
    if (['fill', 'select'].includes(step.kind)) {
      const param = params.find(item => item.example === step.value);
      if (param) step.value = `{{${param.name}}}`;
    }
    if (step.target) {
      step.target.name = template(step.target.name, params);
      if (step.target.identifier && params.some(item => step.target.identifier.includes(item.example))) delete step.target.identifier;
    }
    return step;
  });
  const observedSurfaces = demo.events.flatMap(item => [item.surface, item.before?.surface, item.after?.surface].filter(Boolean));
  const apps = [...new Map(observedSurfaces.map(item => [item.bundleId, { bundleId: item.bundleId, name: item.app }])).values()];
  const evidence = string(analysis.verificationText ?? '', 'Verification evidence', 500, { empty: true });
  const final = demo.events.at(-1), primary = params.find(item => item.primary), text = template(evidence, params);
  const verification = evidence.trim() && typeof final.before?.text === 'string' && typeof final.after?.text === 'string' && final.after.text.includes(evidence) && !final.before.text.includes(evidence) && (!primary || text.includes(`{{${primary.name}}}`)) ? { text } : null;
  const at = new Date().toISOString();
  return checkedProcedure({ id: randomUUID(), version: VERSION, kind: 'desktop', name: analysis.name, summary: analysis.summary, intent: demo.intent, parameters: params, steps, apps, verification, createdAt: at, updatedAt: at });
}
export function bindDesktopProcedure(input, values = {}) {
  const procedure = checkedProcedure(input);
  record(values, 'parameter values', procedure.parameters.map(item => item.name));
  const bindings = Object.fromEntries(procedure.parameters.map(item => [item.name, string(own(values, item.name) ? values[item.name] : item.example, `Value for ${item.label}`, LIMITS.value)]));
  const bind = value => value.replace(/\{\{([a-z][a-z0-9_]{0,39})\}\}/g, (_, name) => bindings[name]);
  const appIds = procedure.apps.map(item => item.bundleId);
  const steps = procedure.steps.map(original => {
    const step = clone(original);
    if (step.value !== undefined) step.value = bind(step.value);
    if (step.target) step.target.name = bind(step.target.name);
    return event(step, appIds);
  });
  return { ...procedure, steps, bindings, verification: procedure.verification ? { text: string(bind(procedure.verification.text), 'Bound verification', LIMITS.text) } : null };
}
export async function createDesktopProcedureStore({ dataDir } = {}) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || dataDir.includes('\0') || path.normalize(dataDir) !== dataDir) throw new Error('Desktop procedures need a full data folder path.');
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const filename = path.join(dataDir, 'desktop-procedures.json');
  let procedures = new Map(), queue = Promise.resolve(), closed = false;
  try {
    const handle = await fs.open(filename, 'r');
    let contents;
    try {
      if ((await handle.stat()).size > LIMITS.fileBytes) throw new Error('The procedures file is too large.');
      contents = await handle.readFile('utf8');
    } finally { await handle.close(); }
    if (Buffer.byteLength(contents) > LIMITS.fileBytes) throw new Error('The procedures file is too large.');
    const parsed = JSON.parse(contents); record(parsed, 'procedures file', ['version', 'procedures']);
    if (parsed.version !== VERSION) throw new Error('Unsupported procedures file version.');
    for (const raw of array(parsed.procedures, 'Saved procedures', LIMITS.procedures)) {
      const procedure = checkedProcedure(raw);
      if (procedures.has(procedure.id)) throw new Error('Duplicate procedure id.');
      procedures.set(procedure.id, procedure);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Desktop procedures could not be read; the original file was left untouched. ${error.message}`);
  }
  async function write(next) {
    const contents = `${JSON.stringify({ version: VERSION, procedures: [...next.values()] }, null, 2)}\n`;
    if (Buffer.byteLength(contents) > LIMITS.fileBytes) throw new Error('The procedures file would be too large.');
    const tmp = path.join(dataDir, `.desktop-procedures-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(tmp, 'wx', 0o600); await handle.writeFile(contents); await handle.sync(); await handle.close(); handle = null;
      await fs.rename(tmp, filename);
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(tmp).catch(() => {});
      throw new Error(`Desktop procedures could not be saved. ${error.message}`);
    }
  }
  function mutation(operation) {
    if (closed) return Promise.reject(new Error('Summon is closing. No desktop procedures were changed.'));
    const result = queue.then(operation); queue = result.catch(() => {}); return result;
  }
  const list = () => clone([...procedures.values()]);
  const get = id => clone(procedures.get(identifier(id)) ?? null);
  function save(input) {
    let procedure;
    try { procedure = checkedProcedure(input); } catch (error) { return Promise.reject(error); }
    return mutation(async () => {
      const previous = procedures.get(procedure.id);
      if (previous && JSON.stringify(previous.apps.map(item => item.bundleId).sort()) !== JSON.stringify(procedure.apps.map(item => item.bundleId).sort())) throw new Error('A saved procedure cannot move to different applications.');
      const next = new Map(procedures); next.set(procedure.id, { ...procedure, createdAt: previous?.createdAt ?? procedure.createdAt, updatedAt: new Date().toISOString() });
      if (next.size > LIMITS.procedures) throw new Error('At most 100 desktop procedures can be saved.');
      await write(next); procedures = next; return get(procedure.id);
    });
  }
  function remove(id) {
    try { identifier(id); } catch (error) { return Promise.reject(error); }
    return mutation(async () => { if (!procedures.has(id)) return false; const next = new Map(procedures); next.delete(id); await write(next); procedures = next; return true; });
  }
  async function close() { closed = true; await queue; }
  return { list, get, save, remove, close };
}
