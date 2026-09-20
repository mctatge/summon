import { createVisualGoals } from './visual-goals.mjs';
import { scanVisualRepository } from './visual-repository.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 300 && !/[\u0000-\u001f\u007f]/u.test(value);
const clone = value => structuredClone(value);

/** Trusted-window-only coordinator. Roots and session identities come from the existing services, never IPC paths. */
export async function createVisualWorkspace({ dataDir, getWorkInFlight, getAgentSessions, traceSession, run, git, env,
  getPrivatePaths = () => [], scanRepository = scanVisualRepository, now = Date.now, cacheMs = 60_000, goals: suppliedGoals } = {}) {
  const goals = suppliedGoals ?? await createVisualGoals({ dataDir, now });
  const cache = new Map();
  const pending = new Map();
  let closed = false;
  const scopeOf = repo => JSON.stringify([repo.id, repo.path, getPrivatePaths(repo.path)]);

  async function repository(repoId) {
    if (closed) throw new Error('Summon is closing.');
    if (!validId(repoId)) throw new Error('Choose a known repository.');
    const flight = await getWorkInFlight();
    const repo = flight.repos.find(item => item.id === repoId);
    if (!repo) throw new Error('That repository is no longer available. Refresh Work in flight.');
    return repo;
  }

  async function scan(repo, refresh) {
    const privatePaths = getPrivatePaths(repo.path);
    // Changes to privacy scope or repository identity cannot reuse a graph from the old scope.
    const key = JSON.stringify([repo.id, repo.path, privatePaths]);
    const cached = cache.get(key);
    if (!refresh && cached && now() - cached.at < cacheMs) return clone(cached.value);
    if (pending.has(key)) return clone(await pending.get(key));
    const task = Promise.resolve().then(() => scanRepository({ repo, run, git, env, privatePaths }));
    pending.set(key, task);
    try {
      const value = await task;
      if (!closed) {
        cache.delete(key);
        cache.set(key, { at: now(), value: clone(value) });
        while (cache.size > 8) cache.delete(cache.keys().next().value);
      }
      return value;
    } finally { pending.delete(key); }
  }

  async function read(repoId, options = {}, attempt = 0) {
    if (!object(options) || Object.keys(options).some(key => key !== 'refresh') || (options.refresh !== undefined && typeof options.refresh !== 'boolean')) throw new Error('Invalid visual workspace request.');
    const repo = await repository(repoId);
    const scope = scopeOf(repo);
    const warnings = [];
    const [graph, sessionResult] = await Promise.all([
      scan(repo, options.refresh === true),
      Promise.resolve().then(getAgentSessions).catch(() => { warnings.push('Agent sessions could not be refreshed.'); return null; }),
    ]);
    const sessions = sessionResult?.groups.flatMap(group => group.sessions).filter(session => session.repoId === repoId) ?? [];
    const traces = [];
    for (const session of sessions.slice(0, 100)) {
      try { traces.push(await traceSession(session.key)); }
      catch { warnings.push(`Reported events are unavailable for ${session.appLabel || 'this agent'} session.`); }
    }
    if (sessions.length > 100) warnings.push('Event history is limited to the first 100 visible sessions.');
    // Settings can change while disk work or a session pass is pending. Do not publish a graph under an old scope.
    const current = await repository(repoId);
    if (scope !== scopeOf(current)) {
      if (attempt >= 2) throw new Error('The repository scope changed during the scan. Refresh to try again.');
      return read(repoId, { refresh: true }, attempt + 1);
    }
    return { version: 1, ...graph, goals: goals.read(repoId), traces, warnings: [...new Set(warnings)] };
  }

  async function saveGoal(input) {
    if (!object(input)) throw new Error('Invalid goal.');
    const repo = await repository(input.repoId);
    const existing = typeof input.id === 'string' ? goals.read(repo.id).find(goal => goal.id === input.id) : null;
    if (input.links !== undefined) {
      if (!object(input.links)) throw new Error('Invalid goal links.');
      for (const [key, value] of Object.entries(input.links)) {
        if (!['placeId', 'branch', 'sessionKey', 'component'].includes(key) || (value !== null && !validId(value))) throw new Error('Invalid goal link.');
        // An existing link may outlive its session/worktree. Keep it visible as historical intent without inventing a new association.
        if (value === null || value === existing?.links[key]) continue;
        if (key === 'placeId' && !repo.places.some(place => place.id === value)) throw new Error('Choose a worktree in this repository.');
        if (key === 'branch' && !repo.branches.some(branch => branch.name === value) && !repo.places.some(place => place.branch === value)) throw new Error('Choose a branch in this repository.');
        if (key === 'sessionKey') {
          const sessions = await getAgentSessions();
          if (!sessions.groups.some(group => group.sessions.some(session => session.key === value && session.repoId === repo.id))) throw new Error('Choose a session in this repository.');
        }
        if (key === 'component' && !(await scan(repo, false)).codebase.nodes.some(node => node.id === value)) throw new Error('Choose a component in this repository.');
      }
    }
    return goals.save(input);
  }

  return {
    read: (repoId, options) => read(repoId, options), saveGoal,
    async close() { closed = true; await Promise.allSettled([...pending.values()]); cache.clear(); await goals.close(); },
  };
}
