import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Work items outlive the sessions that attempt them. Observed activity never proves completion.
// Never replace an unreadable record with an empty ledger.
const VERSION = 2;
const STATUSES = new Set(['planned', 'working', 'blocked', 'needs-verification', 'done', 'deferred', 'dismissed']);
const ACTORS = new Set(['user', 'agent']);
const LIMITS = { goals: 1000, perRepo: 200, dependencies: 32, fileBytes: 4 * 1024 * 1024, titleChars: 240, idChars: 200, linkChars: 300, checklist: 50, findings: 40, evidence: 40, scopePaths: 32, coordinationKeys: 16, serialWith: 32, sessions: 200, history: 40, originEvidence: 20 };
const FIELDS = new Set(['id', 'repoId', 'title', 'status', 'parentId', 'dependsOn', 'crossRepoDependsOn', 'links', 'acceptanceCriteria', 'nextStep', 'checklist', 'findings', 'evidence', 'ownerSessionKey', 'scopePaths', 'coordinationKeys', 'serialWith', 'origin', 'completion']);
const STORED_FIELDS = new Set(['createdAt', 'updatedAt', 'revision', 'sessionKeys', 'history']);
const INPUT_FIELDS = new Set(['expectedRevision', 'reportingSessionKey']);
const LINK_FIELDS = ['placeId', 'branch', 'sessionKey', 'agentId', 'component'];
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
const clone = value => structuredClone(value);
const controls = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

function identifier(value, name, max) {
  if (typeof value !== 'string' || value.length > max || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value)) throw new Error(`Invalid ${name}.`);
  return value;
}
function text(value, name, max, empty = false) {
  if (typeof value !== 'string' || value.length > max) throw new Error(`${name} must be text of at most ${max} characters.`);
  const cleaned = value.replace(controls, ' ').replace(/\s+/g, ' ').trim();
  if (!empty && !cleaned) throw new Error(`${name} cannot be empty.`);
  return cleaned;
}
function date(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('Invalid goal date.');
  return new Date(value).toISOString();
}
function shape(value, fields, name) {
  if (!isObject(value) || Object.keys(value).some(key => !fields.includes(key))) throw new Error(`Invalid ${name}.`);
}
function list(value, max, name, check) {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${name} must be a list of at most ${max} entries.`);
  return value.map(check);
}
function records(value, max, name, fields, check, limit) {
  const seen = new Set();
  return list(value, max, name, item => {
    shape(item, ['id', ...fields], name);
    const id = identifier(item.id, `${name} id`, limit.idChars);
    if (seen.has(id)) throw new Error(`Duplicate ${name} id.`);
    seen.add(id);
    return { id, ...check(item) };
  });
}
function scopePath(value) {
  if (typeof value !== 'string' || !value || value.length > 500 || value.trim() !== value || /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\\]/.test(value) || path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.startsWith('~')) throw new Error('Scope paths must be normalized repository-relative paths.');
  const normalized = value.endsWith('/') ? value.slice(0, -1) : value;
  if (!normalized || normalized.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Scope paths must be normalized repository-relative paths.');
  return normalized;
}
function completionRecord(value) {
  if (value === null) return null;
  shape(value, ['kind', 'summary', 'reference'], 'completion evidence');
  if (!['reported', 'confirmed', 'legacy'].includes(value.kind)) throw new Error('Choose a valid completion evidence kind.');
  return { kind: value.kind, summary: text(value.summary, 'Completion summary', 2000), reference: text(value.reference ?? '', 'Completion reference', 1000, true) };
}
function originRecord(value, limit) {
  if (value === null) return null;
  shape(value, ['summary', 'evidence', 'capturedAt'], 'goal origin');
  return { summary: text(value.summary, 'Origin summary', 2000), evidence: list(value.evidence, limit.originEvidence, 'Origin evidence', item => text(item, 'Origin evidence', 1000)), capturedAt: date(value.capturedAt) };
}
function checkedGoal(input, previous, limit, at, { stored = false, version = VERSION, actor = 'user' } = {}) {
  if (!isObject(input)) throw new Error('A goal must be an object.');
  for (const key of Object.keys(input)) if (!FIELDS.has(key) && !(stored ? STORED_FIELDS.has(key) : INPUT_FIELDS.has(key))) throw new Error(`Unknown or read-only goal field: ${key}`);
  const get = (key, fallback) => own(input, key) ? input[key] : previous?.[key] ?? fallback;
  const id = own(input, 'id') ? identifier(input.id, 'goal id', limit.idChars) : previous?.id ?? randomUUID();
  const repoId = identifier(input.repoId, 'repository id', limit.idChars);
  if (previous && previous.repoId !== repoId) throw new Error('A goal cannot move to another repository.');
  const title = text(get('title'), 'Goal title', limit.titleChars);
  const status = get('status', 'planned');
  if (!STATUSES.has(status)) throw new Error('Choose a valid goal status.');
  const parent = get('parentId', null);
  const parentId = parent === null ? null : identifier(parent, 'parent goal id', limit.idChars);
  const ids = (key, max) => [...new Set(list(get(key, []), max, key, item => identifier(item, `${key} goal id`, limit.idChars)))];
  const dependsOn = ids('dependsOn', limit.dependencies), serialWith = ids('serialWith', limit.serialWith);
  const crossRepoDependsOn = list(get('crossRepoDependsOn', []), limit.dependencies, 'Cross-project dependencies', item => {
    shape(item, ['repoId', 'goalId'], 'cross-project dependency');
    const dependency = { repoId: identifier(item.repoId, 'dependency repository id', limit.idChars), goalId: identifier(item.goalId, 'dependency goal id', limit.idChars) };
    if (dependency.repoId === repoId) throw new Error('Use dependsOn for a goal in this repository.');
    return dependency;
  }).filter((item, index, entries) => entries.findIndex(other => other.repoId === item.repoId && other.goalId === item.goalId) === index);
  if (dependsOn.length + crossRepoDependsOn.length > limit.dependencies) throw new Error(`Goals may have at most ${limit.dependencies} dependencies.`);
  const links = { placeId: null, branch: null, sessionKey: null, agentId: null, component: null, ...previous?.links };
  if (own(input, 'links')) {
    shape(input.links, LINK_FIELDS, 'goal links');
    for (const [key, value] of Object.entries(input.links)) links[key] = value === null ? null : ['placeId', 'agentId'].includes(key) ? identifier(value, `Goal ${key}`, limit.idChars) : text(value, `Goal ${key}`, limit.linkChars);
  }
  if (links.agentId && !links.sessionKey) throw new Error('A child agent link needs its parent session.');
  const acceptanceCriteria = text(get('acceptanceCriteria', ''), 'Acceptance criteria', 4000, true);
  const nextStep = text(get('nextStep', ''), 'Next step', 2000, true);
  const checklist = records(get('checklist', []), limit.checklist, 'checklist', ['text', 'done'], item => {
    if (typeof item.done !== 'boolean') throw new Error('Checklist done must be a boolean.');
    return { text: text(item.text, 'Checklist text', 500), done: item.done };
  }, limit);
  const findings = records(get('findings', []), limit.findings, 'finding', ['text', 'evidence', 'revisitWhen'], item => ({ text: text(item.text, 'Finding text', 1000), evidence: text(item.evidence ?? '', 'Finding evidence', 1000, true), revisitWhen: text(item.revisitWhen ?? '', 'Revisit condition', 500, true) }), limit);
  const evidence = records(get('evidence', []), limit.evidence, 'evidence', ['summary', 'reference'], item => ({ summary: text(item.summary, 'Evidence summary', 1000), reference: text(item.reference ?? '', 'Evidence reference', 1000, true) }), limit);
  const ownerValue = get('ownerSessionKey', null), ownerSessionKey = ownerValue === null ? null : text(ownerValue, 'Owner session key', limit.linkChars);
  const scopePaths = [...new Set(list(get('scopePaths', []), limit.scopePaths, 'Scope paths', scopePath))];
  const coordinationKeys = [...new Set(list(get('coordinationKeys', []), limit.coordinationKeys, 'Coordination keys', item => text(item, 'Coordination key', 120)))];
  const origin = originRecord(get('origin', null), limit);
  let completion = completionRecord(get('completion', null));
  if (stored && version === 1 && status === 'done' && !completion) completion = { kind: 'legacy', summary: 'Marked done before completion evidence was recorded. This is a historical status, not verified proof.', reference: '' };
  if (stored && status === 'done' && !['confirmed', 'legacy'].includes(completion?.kind)) throw new Error('Saved done goals require completion evidence.');
  if (!stored && completion?.kind === 'legacy' && (previous?.completion?.kind !== 'legacy' || JSON.stringify(completion) !== JSON.stringify(previous.completion))) throw new Error('Legacy completion is reserved for migrated records.');
  const createdAt = stored ? date(input.createdAt) : previous?.createdAt ?? at;
  const updatedAt = stored ? date(input.updatedAt) : at;
  let revision, sessionKeys, history;
  if (stored) {
    revision = input.revision ?? (version === 1 ? 1 : undefined);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('Invalid goal revision.');
    sessionKeys = [...new Set(list(input.sessionKeys ?? [], limit.sessions, 'Session history', item => text(item, 'Session key', limit.linkChars)))];
    history = list(input.history ?? [], limit.history, 'Goal history', item => {
      shape(item, ['at', 'actor', 'status', 'nextStep', 'sessionKey'], 'history entry');
      if (!ACTORS.has(item.actor) || !STATUSES.has(item.status)) throw new Error('Invalid goal history state.');
      return { at: date(item.at), actor: item.actor, status: item.status, nextStep: text(item.nextStep, 'Historical next step', 2000, true), sessionKey: item.sessionKey === null ? null : text(item.sessionKey, 'Historical session key', limit.linkChars) };
    });
  } else {
    if (previous && input.expectedRevision !== previous.revision) throw new Error(`This goal changed since you read it (revision ${previous.revision}). Refresh it and retry with expectedRevision.`);
    if (!previous && own(input, 'expectedRevision')) throw new Error('A new goal must not include expectedRevision.');
    revision = (previous?.revision ?? 0) + 1;
    if (!Number.isSafeInteger(revision)) throw new Error('The goal revision limit was reached.');
    const reporting = own(input, 'reportingSessionKey') && input.reportingSessionKey !== null ? text(input.reportingSessionKey, 'Reporting session key', limit.linkChars) : null;
    sessionKeys = [...new Set([...(previous?.sessionKeys ?? []), links.sessionKey, ownerSessionKey, reporting].filter(Boolean))];
    if (sessionKeys.length > limit.sessions) throw new Error('There are too many linked session attempts.');
    history = [...(previous?.history ?? []), { at, actor, status, nextStep, sessionKey: reporting ?? ownerSessionKey ?? links.sessionKey }].slice(-limit.history);
  }
  // A v1 link becomes historical provenance without inventing a checkpoint or claiming work happened.
  sessionKeys = [...new Set([...sessionKeys, links.sessionKey, ownerSessionKey].filter(Boolean))];
  if (sessionKeys.length > limit.sessions) throw new Error('There are too many linked session attempts.');
  return { id, repoId, title, status, parentId, dependsOn, crossRepoDependsOn, links, acceptanceCriteria, nextStep, checklist, findings, evidence, ownerSessionKey, scopePaths, coordinationKeys, serialWith, origin, completion, revision, sessionKeys, history, createdAt, updatedAt };
}

function checkGraph(goals, limit) {
  if (goals.size > limit.goals) throw new Error('There are too many saved goals.');
  const perRepo = new Map();
  for (const goal of goals.values()) {
    const count = (perRepo.get(goal.repoId) ?? 0) + 1;
    if (count > limit.perRepo) throw new Error('There are too many goals in this repository.');
    perRepo.set(goal.repoId, count);
    if (goal.serialWith.includes(goal.id)) throw new Error('A goal cannot be serial with itself.');
    for (const id of [goal.parentId, ...goal.dependsOn, ...goal.serialWith].filter(Boolean)) {
      const target = goals.get(id);
      if (!target) throw new Error('A linked goal no longer exists.');
      if (target.repoId !== goal.repoId) throw new Error('Linked goals must belong to the same repository.');
    }
    for (const dependency of goal.crossRepoDependsOn) {
      const target = goals.get(dependency.goalId);
      if (!target || target.repoId !== dependency.repoId) throw new Error('A linked cross-project goal no longer exists.');
    }
  }
  const visited = new Set(), visiting = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error('Goal relationships cannot contain a cycle.');
    if (visited.has(id)) return;
    visiting.add(id);
    const goal = goals.get(id);
    for (const next of [goal.parentId, ...goal.dependsOn, ...goal.crossRepoDependsOn.map(item => item.goalId)].filter(Boolean)) visit(next);
    visiting.delete(id); visited.add(id);
  }
  for (const id of goals.keys()) visit(id);
}

/** Advisory shared scopes become an enforced exclusion when another item is working and owned. */
export function goalConflicts(goal, goals) {
  const others = goals instanceof Map ? [...goals.values()] : goals;
  if (!Array.isArray(others)) return [];
  const overlaps = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  return others.filter(other => other.id !== goal.id && other.repoId === goal.repoId && other.status === 'working' && other.ownerSessionKey).flatMap(other => {
    const reasons = [];
    if (goal.serialWith?.includes(other.id) || other.serialWith?.includes(goal.id)) reasons.push('Explicitly marked to run serially');
    const scopes = (goal.scopePaths ?? []).filter(scope => (other.scopePaths ?? []).some(otherScope => overlaps(scope, otherScope)));
    if (scopes.length) reasons.push(`Overlapping scope: ${scopes.join(', ')}`);
    const keys = (goal.coordinationKeys ?? []).filter(key => other.coordinationKeys?.includes(key));
    if (keys.length) reasons.push(`Shared coordination: ${keys.join(', ')}`);
    return reasons.length ? [{ id: other.id, title: other.title, reasons }] : [];
  });
}

function checkTransition(goal, previous, input, actor, goals) {
  if (actor === 'agent') {
    if (input.status === 'done' || input.completion?.kind === 'confirmed' || (goal.status === 'done' && previous?.status !== 'done')) throw new Error('Agents must report needs-verification; only the user can confirm completion.');
    if (previous?.ownerSessionKey && goal.ownerSessionKey !== previous.ownerSessionKey) throw new Error('This goal already has an owner. Only the user can reassign or release it.');
  }
  const unchangedDone = previous?.status === 'done' && goal.status === 'done' && JSON.stringify(previous.completion) === JSON.stringify(goal.completion);
  const acceptanceChanged = previous?.status === 'done' && ['acceptanceCriteria', 'checklist', 'dependsOn', 'crossRepoDependsOn', 'scopePaths'].some(key => JSON.stringify(goal[key]) !== JSON.stringify(previous[key]));
  if (goal.status === 'done' && acceptanceChanged && (actor !== 'user' || input.completion?.kind !== 'confirmed')) throw new Error('Completed work has changed acceptance criteria, checklist, dependencies or scope. Reopen it or explicitly reconfirm completion.');
  if (goal.status === 'done') {
    if (!unchangedDone && goal.completion?.kind !== 'confirmed') throw new Error('Marking done requires confirmed completion evidence with a summary.');
    if (goal.checklist.some(item => !item.done)) throw new Error('Finish every checklist item before marking this goal done.');
  }
  if (goal.status === 'working' || (goal.status === 'done' && (!unchangedDone || acceptanceChanged))) {
    const incomplete = [...goal.dependsOn, ...goal.crossRepoDependsOn.map(item => item.goalId)].map(id => goals.get(id)).filter(item => item?.status !== 'done');
    if (incomplete.length) throw new Error(`Finish dependencies first: ${incomplete.map(item => item?.title ?? 'unavailable goal').join(', ')}.`);
  }
  if (goal.status === 'working') {
    const conflicts = goalConflicts(goal, goals);
    if (conflicts.length) throw new Error(`Cannot work in parallel with ${conflicts.map(item => `"${item.title}" (${item.reasons.join('; ')})`).join(', ')}. Finish that work or explicitly reassign its owner first.`);
  }
}

export async function createVisualGoals({ dataDir, now = Date.now, limits = {} } = {}) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || dataDir.includes('\0') || path.normalize(dataDir) !== dataDir) throw new Error('Visual goals need a full data folder path.');
  const limit = { ...LIMITS, ...limits };
  for (const value of Object.values(limit)) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid visual goal limit.');
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const filename = path.join(dataDir, 'visual-goals.json');
  let goals = new Map(), queue = Promise.resolve(), closed = false;
  try {
    const handle = await fs.open(filename, 'r');
    let content;
    try {
      if ((await handle.stat()).size > limit.fileBytes) throw new Error('The goals file is too large.');
      content = await handle.readFile('utf8');
    } finally { await handle.close(); }
    if (Buffer.byteLength(content) > limit.fileBytes) throw new Error('The goals file is too large.');
    const parsed = JSON.parse(content);
    if (!isObject(parsed) || ![1, VERSION].includes(parsed.version) || !Array.isArray(parsed.goals) || parsed.goals.length > limit.goals) throw new Error('Unrecognized goals file.');
    for (const raw of parsed.goals) {
      if (!isObject(raw) || !own(raw, 'id')) throw new Error('Invalid saved goal.');
      const goal = checkedGoal(raw, null, limit, null, { stored: true, version: parsed.version });
      if (goals.has(goal.id)) throw new Error('Duplicate goal id.');
      goals.set(goal.id, goal);
    }
    checkGraph(goals, limit);
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Visual goals could not be read; the original file was left untouched. ${error.message}`);
  }

  function read(repoId) {
    identifier(repoId, 'repository id', limit.idChars);
    return clone([...goals.values()].filter(goal => goal.repoId === repoId));
  }
  async function write(next) {
    const contents = `${JSON.stringify({ version: VERSION, goals: [...next.values()] }, null, 2)}\n`;
    if (Buffer.byteLength(contents) > limit.fileBytes) throw new Error('The goals file would be too large.');
    const tmp = path.join(dataDir, `.visual-goals-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(tmp, 'wx', 0o600);
      await handle.writeFile(contents); await handle.sync(); await handle.close(); handle = null;
      await fs.rename(tmp, filename);
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(tmp).catch(() => {});
      throw new Error(`Visual goals could not be saved. ${error.message}`);
    }
  }
  function save(input, { actor = 'user' } = {}) {
    if (!ACTORS.has(actor)) return Promise.reject(new Error('Choose a valid goal actor.'));
    if (closed) return Promise.reject(new Error('Summon is closing. No goals were changed.'));
    // Detach caller-owned objects before waiting behind another save.
    let value;
    try { value = clone(input); } catch { return Promise.reject(new Error('Invalid goal.')); }
    const result = queue.then(async () => {
      const previous = value?.id ? goals.get(value.id) : null;
      if (value?.id && !previous) throw new Error('That goal no longer exists.');
      const goal = checkedGoal(value, previous, limit, new Date(now()).toISOString(), { actor });
      const next = new Map(goals); next.set(goal.id, goal);
      checkGraph(next, limit);
      checkTransition(goal, previous, value, actor, next);
      await write(next);
      goals = next;
      return read(goal.repoId);
    });
    queue = result.catch(() => {});
    return result;
  }
  async function close() { closed = true; await queue; }
  return { read, save, close };
}
