/** Local, opt-in conversation inbox. This journal never infers or mutates work records. */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { classifyPath, hidePrivateText, redact, sealedPath } from './workstreams.mjs';

const DEFAULT_LIMITS = Object.freeze({ projects: 20, sources: 500, events: 2000, sourcesPerScan: 25, journalBytes: 8 * 1024 * 1024 });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const inside = (file, root) => file === root || file.startsWith(`${root}${path.sep}`);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso = time => new Date(time).toISOString();
const keyOf = source => `${source.provider}:${source.sessionId}`;
const empty = (repo, now) => ({ repoId: repo.id, repoPath: repo.path, enabled: false, enabledAt: null, checkedAt: null,
  sources: [], events: [], warnings: [], notices: [], hasMore: false, nextSource: 0, createdAt: iso(now) });

function validateOptions(input, fields) {
  if (!object(input) || Object.keys(input).some(key => !fields.includes(key))) throw new Error('Invalid conversation recovery request.');
  if (typeof input.repoId !== 'string' || !input.repoId || input.repoId.length > 200) throw new Error('Choose one registered repository.');
  return input;
}

async function readJournal(file, limit) {
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('Conversation recovery journal is invalid or exceeds its size limit.');
    const state = JSON.parse(await handle.readFile('utf8'));
    if (!object(state) || state.version !== 1 || !Array.isArray(state.projects) || state.projects.length > DEFAULT_LIMITS.projects ||
      state.projects.some(p => !object(p) || typeof p.repoId !== 'string' || typeof p.repoPath !== 'string' || typeof p.enabled !== 'boolean' ||
        !Array.isArray(p.sources) || !Array.isArray(p.events) || !Array.isArray(p.warnings) || !Array.isArray(p.notices) ||
        p.sources.length > DEFAULT_LIMITS.sources || p.events.length > DEFAULT_LIMITS.events ||
        p.sources.some(s => !object(s) || !object(s.descriptor) || typeof s.descriptor.file !== 'string') ||
        p.events.some(e => !object(e) || typeof e.id !== 'string' || typeof e.text !== 'string' || typeof e.cwd !== 'string' || typeof e.root !== 'string' ||
          !['user', 'assistant'].includes(e.role) || !['codex', 'claude'].includes(e.provider))) ||
      new Set(state.projects.map(p => p.repoId)).size !== state.projects.length) throw new Error('Conversation recovery journal has an unsupported or damaged structure.');
    return state;
  } catch (error) { if (error.code === 'ENOENT') return { version: 1, projects: [] }; throw error; }
  finally { await handle?.close(); }
}

/** One atomic commit contains both excerpts and cursors. A failed write cannot acknowledge unread source bytes. */
async function writeJournal(file, text) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(tmp, 'wx', 0o600);
    await handle.writeFile(text); await handle.sync(); await handle.close(); handle = null;
    await fs.rename(tmp, file);
    const directory = await fs.open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await handle?.close(); await fs.rm(tmp, { force: true }); }
}

export async function createWorkRecovery({ dataDir, getRepositories, sourceReader, privatePathsFor = () => [],
  isPaused = () => false, now = Date.now, limits: overrides = {}, persist = writeJournal } = {}) {
  if (!dataDir || typeof getRepositories !== 'function' || !sourceReader?.discover || !sourceReader?.readBatch) throw new Error('Conversation recovery needs repositories and a local source reader.');
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_LIMITS[name]) throw new Error(`Invalid recovery limit: ${name}.`);
  await fs.mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, 'work-recovery.json');
  let state = await readJournal(file, limits.journalBytes), queue = Promise.resolve(), closed = false;
  const errors = new Map();
  const enqueue = fn => {
    if (closed) return Promise.reject(new Error('Conversation recovery is closed.'));
    const result = queue.then(fn); queue = result.catch(() => {}); return result;
  };
  async function scope(repoId) {
    const repos = await getRepositories();
    const matches = (Array.isArray(repos) ? repos : repos?.repos ?? []).filter(repo => repo.id === repoId);
    if (matches.length !== 1 || !path.isAbsolute(matches[0].path ?? '') || sealedPath(matches[0].path)) throw new Error('Choose one available registered repository for conversation recovery.');
    const repo = matches[0];
    const roots = [...new Set([repo.path, ...(repo.places ?? []).filter(p => !p.missing && !p.error).map(p => p.path)].filter(p => typeof p === 'string' && path.isAbsolute(p) && !sealedPath(p)))];
    const resolved = await Promise.all(roots.map(root => fs.realpath(root).catch(() => null)));
    const validRoots = roots.filter((root, i) => resolved[i] && !sealedPath(resolved[i]));
    if (!validRoots.includes(repo.path)) throw new Error('The recovery repository folder is unavailable.');
    const prefixes = [...privatePathsFor(repo.path)];
    const context = { repo: { ...repo, places: (repo.places ?? []).filter(p => validRoots.includes(p.path)) }, roots: validRoots,
      realRoots: resolved.filter(root => root && !sealedPath(root)), realCwds: new Map(), prefixes, names: [repo.name, ...validRoots.map(root => path.basename(root))].filter(Boolean) };
    context.fingerprint = hash([repo.id, repo.path, context.roots, context.realRoots, context.prefixes, context.names]);
    return context;
  }
  async function assertScope(context) {
    if ((await scope(context.repo.id)).fingerprint !== context.fingerprint) throw new Error('The recovery project or privacy settings changed. Check again.');
  }
  async function hidden(cwd, context) {
    if (typeof cwd !== 'string' || sealedPath(cwd)) return true;
    if (!context.realCwds.has(cwd)) context.realCwds.set(cwd, await fs.realpath(cwd).catch(() => null));
    const real = context.realCwds.get(cwd);
    if (!real || sealedPath(real)) return true;
    const excluded = (candidate, roots) => {
      const parents = roots.filter(root => inside(candidate, root));
      return !parents.length || parents.every(root => candidate !== root && classifyPath(path.relative(root, candidate), { privatePaths: context.prefixes }).private);
    };
    return excluded(cwd, [...context.roots, ...context.realRoots]) || excluded(real, context.realRoots);
  }
  function maskedText(value, context, truncated = false) {
    if (typeof value !== 'string' || sealedPath(value)) return '[withheld]';
    // The source's bounded excerpt may end inside a credential; discard the cut word before masking.
    let text = truncated ? value.replace(/\S+\s*$/, '…') : value;
    text = redact(text);
    for (let offset = 0; offset < Math.max(1, context.prefixes.length); offset += 40) text = hidePrivateText(text, context.prefixes.slice(offset, offset + 40), context.names);
    return text.replace(/(?:\/Users\/|\/home\/)[^\s/]+/g, '~').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function safeText(value, context, truncated = false) { return maskedText(value, context, truncated).slice(0, 1000); }
  function hiddenSaved(event, context) {
    // Captured provenance remains valid after a temporary worktree or folder is removed.
    // Reapply current privacy restrictions without confusing absence with a privacy change.
    return !path.isAbsolute(event.root) || !inside(event.cwd, event.root) || sealedPath(event.root) || sealedPath(event.cwd) ||
      (event.cwd !== event.root && classifyPath(path.relative(event.root, event.cwd), { privatePaths: context.prefixes }).private);
  }
  async function remask(project, context) {
    // Masking can lengthen text past the excerpt bound; a cut excerpt is then marked shortened.
    for (const event of project.events) {
      const text = hiddenSaved(event, context) ? '[withheld]' : maskedText(event.text, context);
      event.text = text.slice(0, 1000); if (text.length > 1000) event.truncated = true;
    }
    project.warnings = project.warnings.map(w => safeText(w, context));
    project.notices = project.notices.map(w => safeText(w, context));
  }
  async function commit(next, context, { capture = false } = {}) {
    const text = `${JSON.stringify(next)}\n`;
    if (Buffer.byteLength(text) > limits.journalBytes) throw new Error('Conversation recovery journal is full. Capture is paused; unread source positions were kept.');
    await assertScope(context);
    if (capture && isPaused()) throw new Error('Conversation recovery was paused. Unread source positions were retained.');
    await persist(file, text); state = next; errors.delete(context.repo.id);
  }
  function projectOf(next, context, create = false) {
    let project = next.projects.find(p => p.repoId === context.repo.id);
    if (project && project.repoPath !== context.repo.path) throw new Error('The registered repository folder changed; the prior recovery journal is retained separately.');
    if (!project && create) {
      if (next.projects.length >= limits.projects) throw new Error('Conversation recovery project limit reached. Existing records were kept.');
      project = empty(context.repo, now()); next.projects.push(project);
    }
    return project;
  }
  function snapshot(project, context, { offset = 0, limit = 20, includeReviewed = false } = {}) {
    const p = project ?? empty(context.repo, now());
    const rows = p.events.filter(e => includeReviewed || !e.reviewedAt).sort((a, b) => b.capturedAt.localeCompare(a.capturedAt) || b.id.localeCompare(a.id));
    const items = rows.slice(offset, offset + limit).map(({ cwd, root, ...event }) => event);
    return { repoId: context.repo.id, enabled: p.enabled, enabledAt: p.enabledAt, paused: Boolean(isPaused()), checkedAt: p.checkedAt,
      pending: p.events.filter(e => !e.reviewedAt).length, total: p.events.length, sources: p.sources.length,
      hasMore: p.hasMore || errors.has(context.repo.id), warnings: [...new Set([...p.notices, ...p.warnings])].slice(0, 25),
      error: errors.get(context.repo.id) ?? null, items, nextOffset: offset + items.length < rows.length ? offset + items.length : null };
  }
  async function readInner(options) {
    validateOptions(options, ['repoId', 'offset', 'limit', 'includeReviewed']);
    if ((options.offset !== undefined && (!Number.isSafeInteger(options.offset) || options.offset < 0 || options.offset > limits.events)) ||
      (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 20)) ||
      (options.includeReviewed !== undefined && typeof options.includeReviewed !== 'boolean')) throw new Error('Invalid conversation recovery page.');
    const context = await scope(options.repoId), next = clone(state), project = projectOf(next, context);
    if (project) {
      const before = JSON.stringify(project); await remask(project, context);
      if (JSON.stringify(project) !== before) await commit(next, context);
    }
    await assertScope(context);
    return snapshot(project, context, options);
  }
  function note(project, warning, context) {
    const text = safeText(warning, context);
    if (!text || project.notices.includes(text)) return;
    if (project.notices.length < 20) project.notices.push(text);
    else project.notices[19] = 'Additional source coverage warnings occurred. Some conversation material could not be retained.';
  }
  async function discovery(context, project) {
    const result = await sourceReader.discover({ repo: context.repo, since: Date.parse(project.enabledAt) });
    const sources = [];
    for (const s of result.sources) if (['codex', 'claude'].includes(s.provider) && typeof s.sessionId === 'string' &&
      typeof s.sessionKey === 'string' && typeof s.file === 'string' && !sealedPath(s.file) && !await hidden(s.cwd, context)) sources.push(s);
    project.warnings = (result.warnings ?? []).map(w => safeText(w, context)).slice(0, 20);
    if (result.truncated) project.warnings.push('Source discovery is incomplete. Undiscovered conversation files have not been acknowledged.');
    return { sources, incomplete: Boolean(result.truncated || result.warnings?.length) };
  }
  async function enableInner(options) {
    validateOptions(options, ['repoId', 'enabled']);
    if (typeof options.enabled !== 'boolean') throw new Error('Choose whether to enable conversation recovery.');
    const context = await scope(options.repoId), next = clone(state), project = projectOf(next, context, true);
    await remask(project, context);
    if (project.enabled === options.enabled) return snapshot(project, context);
    if (options.enabled && isPaused()) throw new Error('Resume Summon observation before enabling conversation recovery.');
    project.enabled = options.enabled;
    if (options.enabled) {
      project.enabledAt = iso(now()); project.sources = []; project.nextSource = 0; project.hasMore = false;
      const found = await discovery(context, project);
      for (const descriptor of found.sources.slice(0, limits.sources)) {
        // Starting and re-enabling establish a new boundary, never a transcript backfill.
        try {
          const batch = await sourceReader.readBatch(descriptor, null, { baseline: true });
          project.sources.push({ descriptor, cursor: batch.cursor, eof: true });
          for (const warning of batch.warnings ?? []) note(project, warning, context);
        } catch { project.warnings.push('A source could not be baselined. Only dated messages after enabling will be considered on retry.'); project.hasMore = true; }
      }
      if (found.sources.length > limits.sources) project.warnings.push('Source limit reached. Additional sources remain uncaptured.');
      project.hasMore ||= found.incomplete || found.sources.length > limits.sources;
      project.enabledAt = iso(now());
      project.checkedAt = iso(now());
    }
    await commit(next, context, { capture: options.enabled }); return snapshot(project, context);
  }
  async function scanOne(repoId) {
    const context = await scope(repoId), next = clone(state), project = projectOf(next, context);
    if (!project?.enabled || isPaused()) return snapshot(project, context);
    await remask(project, context);
    const found = await discovery(context, project), available = new Map(found.sources.map(s => [keyOf(s), s]));
    let incomplete = found.incomplete;
    for (const descriptor of found.sources) {
      const existing = project.sources.find(s => keyOf(s.descriptor) === keyOf(descriptor));
      if (existing) existing.descriptor = descriptor;
      else if (project.sources.length < limits.sources) project.sources.push({ descriptor, cursor: null, eof: false });
      else { incomplete = true; project.warnings.push('Source limit reached. Additional sources remain uncaptured.'); break; }
    }
    const ordered = project.sources.slice(project.nextSource).concat(project.sources.slice(0, project.nextSource));
    let visited = 0;
    for (const source of ordered.slice(0, limits.sourcesPerScan)) {
      visited++;
      const descriptor = available.get(keyOf(source.descriptor));
      if (!descriptor) { source.eof = false; incomplete = true; project.warnings.push('A previously tracked source is unavailable or excluded. Its saved position was retained.'); continue; }
      let batch;
      try { batch = await sourceReader.readBatch(descriptor, source.cursor); }
      catch { source.eof = false; incomplete = true; project.warnings.push('A conversation source could not be read. Its saved position was retained for retry.'); continue; }
      const known = new Set(project.events.map(e => e.id)), additions = [];
      for (const event of batch.events) {
        if (!Number.isFinite(event.at)) { note(project, 'An undated conversation message was skipped because its capture boundary could not be verified.', context); continue; }
        if (event.at < Date.parse(project.enabledAt) || await hidden(event.cwd ?? descriptor.cwd, context) || known.has(event.id)) continue;
        const masked = maskedText(event.text, context, event.truncated), text = masked.slice(0, 1000);
        if (!text) continue;
        known.add(event.id);
        const cwd = context.realCwds.get(event.cwd ?? descriptor.cwd);
        const root = context.realRoots.filter(root => inside(cwd, root)).sort((a, b) => b.length - a.length)[0];
        additions.push({ id: event.id, provider: descriptor.provider, sessionKey: descriptor.sessionKey, role: event.role, text,
          at: iso(event.at), capturedAt: iso(now()), truncated: Boolean(event.truncated) || masked.length > 1000, reviewedAt: null, cwd, root });
      }
      if (project.events.length + additions.length > limits.events) {
        source.eof = false; incomplete = true; project.warnings.push('Conversation recovery capacity reached. No unread source position was advanced; saved excerpts are retained.'); continue;
      }
      project.events.push(...additions); source.cursor = batch.cursor; source.eof = batch.eof;
      for (const warning of batch.warnings ?? []) note(project, warning, context);
    }
    project.nextSource = project.sources.length ? (project.nextSource + visited) % project.sources.length : 0;
    project.hasMore = incomplete || project.sources.some(s => !s.eof);
    project.warnings = [...new Set(project.warnings)].slice(0, 20);
    project.checkedAt = iso(now());
    // A mid-read pause must not consume messages that the user meant to exclude.
    if (isPaused()) return snapshot(state.projects.find(p => p.repoId === repoId), context);
    await commit(next, context, { capture: true }); return snapshot(project, context);
  }
  return {
    read: options => enqueue(() => readInner(options)),
    setEnabled: options => enqueue(() => enableInner(options)),
    scan: (options = {}) => enqueue(async () => {
      if (!object(options) || Object.keys(options).some(key => key !== 'repoId')) throw new Error('Invalid recovery scan request.');
      if (options.repoId !== undefined) validateOptions(options, ['repoId']);
      const ids = options.repoId ? [options.repoId] : state.projects.filter(p => p.enabled).map(p => p.repoId);
      let result = null;
      for (const id of ids) {
        try { result = await scanOne(id); }
        catch (error) { errors.set(id, 'Conversation recovery could not finish. Saved excerpts and unread source positions were retained.'); if (options.repoId) throw error; }
      }
      return result;
    }),
    review: options => enqueue(async () => {
      validateOptions(options, ['repoId', 'id', 'reviewed']);
      if (typeof options.id !== 'string' || options.id.length > 300 || typeof options.reviewed !== 'boolean') throw new Error('Invalid recovered excerpt.');
      const context = await scope(options.repoId), next = clone(state), project = projectOf(next, context);
      const event = project?.events.find(e => e.id === options.id);
      if (!event) throw new Error('The recovered excerpt is not in this repository.');
      event.reviewedAt = options.reviewed ? iso(now()) : null; await remask(project, context);
      await commit(next, context); return snapshot(project, context);
    }),
    // Internal only (never RPC/MCP/preload): the completion reconciler reads the user's own words under the same scope and masking as read().
    userMessages: () => enqueue(async () => {
      if (isPaused()) return [];
      const result = [];
      for (const repoId of state.projects.filter(p => p.enabled).map(p => p.repoId)) {
        try {
          const context = await scope(repoId), next = clone(state), project = projectOf(next, context);
          if (!project?.enabled) continue;
          const before = JSON.stringify(project); await remask(project, context);
          if (JSON.stringify(project) !== before) await commit(next, context);
          await assertScope(context);
          result.push({ repoId: context.repo.id, messages: project.events.filter(e => e.role === 'user' && e.text && e.text !== '[withheld]')
            .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
            .map(({ id, provider, sessionKey, text, at, truncated }) => ({ id, provider, sessionKey, text, at, truncated: Boolean(truncated) })) });
        } catch { continue; }
      }
      return result;
    }),
    close: async () => { closed = true; await queue; await sourceReader.close?.(); },
  };
}
