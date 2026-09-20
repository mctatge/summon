import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Goals are the person's explicit record, not an inference from commits or agent activity.
// Keep a failed or unreadable save visible; never replace an unreadable goals file with an empty one.
const VERSION = 1;
const STATUSES = new Set(['planned', 'working', 'blocked', 'done']);
const LIMITS = { goals: 1000, perRepo: 200, dependencies: 32, fileBytes: 1024 * 1024, titleChars: 240, idChars: 200, linkChars: 300 };
const FIELDS = new Set(['id', 'repoId', 'title', 'status', 'parentId', 'dependsOn', 'links']);
const LINK_FIELDS = ['placeId', 'branch', 'sessionKey', 'component'];
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
const clone = value => structuredClone(value);
const controls = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

function identifier(value, name, max) {
  if (typeof value !== 'string' || value.length > max || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value)) throw new Error(`Invalid ${name}.`);
  return value;
}
function text(value, name, max) {
  if (typeof value !== 'string' || value.length > max) throw new Error(`${name} must be text of at most ${max} characters.`);
  const cleaned = value.replace(controls, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) throw new Error(`${name} cannot be empty.`);
  return cleaned;
}
function date(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('Invalid goal date.');
  return new Date(value).toISOString();
}

function checkedGoal(input, previous, limit, at, stored = false) {
  if (!isObject(input)) throw new Error('A goal must be an object.');
  for (const key of Object.keys(input)) if (!FIELDS.has(key) && !(stored && (key === 'createdAt' || key === 'updatedAt'))) throw new Error(`Unknown goal field: ${key}`);
  const id = own(input, 'id') ? identifier(input.id, 'goal id', limit.idChars) : previous?.id ?? randomUUID();
  const repoId = identifier(input.repoId, 'repository id', limit.idChars);
  if (previous && previous.repoId !== repoId) throw new Error('A goal cannot move to another repository.');
  const title = text(own(input, 'title') ? input.title : previous?.title, 'Goal title', limit.titleChars);
  const status = own(input, 'status') ? input.status : previous?.status ?? 'planned';
  if (!STATUSES.has(status)) throw new Error('Choose a valid goal status.');
  const parent = own(input, 'parentId') ? input.parentId : previous?.parentId ?? null;
  const parentId = parent === null ? null : identifier(parent, 'parent goal id', limit.idChars);
  const deps = own(input, 'dependsOn') ? input.dependsOn : previous?.dependsOn ?? [];
  if (!Array.isArray(deps) || deps.length > limit.dependencies) throw new Error(`A goal can have at most ${limit.dependencies} dependencies.`);
  const dependsOn = [...new Set(deps.map(id => identifier(id, 'dependency id', limit.idChars)))];
  const links = { placeId: null, branch: null, sessionKey: null, component: null, ...previous?.links };
  if (own(input, 'links')) {
    if (!isObject(input.links)) throw new Error('Goal links must be an object.');
    for (const [key, value] of Object.entries(input.links)) {
      if (!LINK_FIELDS.includes(key)) throw new Error(`Unknown goal link: ${key}`);
      links[key] = value === null ? null : key === 'placeId' ? identifier(value, 'place id', limit.idChars) : text(value, `Goal ${key}`, limit.linkChars);
    }
  }
  return { id, repoId, title, status, parentId, dependsOn, links, createdAt: stored ? date(input.createdAt) : previous?.createdAt ?? at, updatedAt: stored ? date(input.updatedAt) : at };
}

function checkGraph(goals, limit) {
  if (goals.size > limit.goals) throw new Error('There are too many saved goals.');
  const perRepo = new Map();
  for (const goal of goals.values()) {
    const count = (perRepo.get(goal.repoId) ?? 0) + 1;
    if (count > limit.perRepo) throw new Error('There are too many goals in this repository.');
    perRepo.set(goal.repoId, count);
    for (const id of [goal.parentId, ...goal.dependsOn].filter(Boolean)) {
      const target = goals.get(id);
      if (!target) throw new Error('A linked goal no longer exists.');
      if (target.repoId !== goal.repoId) throw new Error('Linked goals must belong to the same repository.');
    }
  }
  const visited = new Set(), visiting = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error('Goal relationships cannot contain a cycle.');
    if (visited.has(id)) return;
    visiting.add(id);
    const goal = goals.get(id);
    for (const next of [goal.parentId, ...goal.dependsOn].filter(Boolean)) visit(next);
    visiting.delete(id); visited.add(id);
  }
  for (const id of goals.keys()) visit(id);
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
    if (!isObject(parsed) || parsed.version !== VERSION || !Array.isArray(parsed.goals) || parsed.goals.length > limit.goals) throw new Error('Unrecognized goals file.');
    for (const raw of parsed.goals) {
      if (!isObject(raw) || !own(raw, 'id')) throw new Error('Invalid saved goal.');
      const goal = checkedGoal(raw, null, limit, null, true);
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
  function save(input) {
    if (closed) return Promise.reject(new Error('Summon is closing. No goals were changed.'));
    // Detach caller-owned objects before waiting behind another save.
    let value;
    try { value = clone(input); } catch { return Promise.reject(new Error('Invalid goal.')); }
    const result = queue.then(async () => {
      const previous = value?.id ? goals.get(value.id) : null;
      if (value?.id && !previous) throw new Error('That goal no longer exists.');
      const goal = checkedGoal(value, previous, limit, new Date(now()).toISOString());
      const next = new Map(goals); next.set(goal.id, goal);
      checkGraph(next, limit);
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
