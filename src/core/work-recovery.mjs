/** Local conversation inbox, on by default per project; an explicit off sticks. This journal never infers or mutates work records. */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { classifyPath, hidePrivateText, redact, sealedPath } from './workstreams.mjs';

// `projects` bounds registered projects that are on; `records` also counts projects turned off, whose choice must be remembered.
const DEFAULT_LIMITS = Object.freeze({ projects: 20, records: 100, sources: 500, events: 2000, sourcesPerScan: 25, journalBytes: 8 * 1024 * 1024 });
const DAY = 24 * 60 * 60 * 1000, LOOKBACK = 14 * DAY, RETENTION = 30 * DAY;
const CAP_NOTICE = 'Older conversation excerpts were removed to stay within recovery limits.';
const AGE_NOTICE = 'Excerpts older than 30 days were removed.';
const SLOTS = 'Conversation recovery project limit reached.';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const inside = (file, root) => file === root || file.startsWith(`${root}${path.sep}`);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso = time => new Date(time).toISOString();
const keyOf = source => `${source.provider}:${source.sessionId}`;
const optionalTime = value => value == null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const older = (a, b) => order(a.at, b.at) || order(a.capturedAt, b.capturedAt) || order(a.id, b.id);
const list = repos => (Array.isArray(repos) ? repos : repos?.repos ?? []);
const taken = (projects, registered) => projects.filter(p => p.enabled && registered.has(p.repoId)).length;
const stamp = d => (Number.isFinite(d?.size) && Number.isFinite(d?.modifiedAt) ? `${d.size}:${d.modifiedAt}` : null);
const modified = s => (Number.isFinite(s.descriptor?.modifiedAt) ? s.descriptor.modifiedAt : Number.isFinite(s.cursor?.mtimeMs) ? s.cursor.mtimeMs : null);
const empty = (repo, now) => ({ repoId: repo.id, repoPath: repo.path, enabled: false, choice: 'user', enabledAt: null, lookbackFrom: null, disabledAt: null, checkedAt: null,
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
    if (!object(state) || state.version !== 1 || !Array.isArray(state.projects) || state.projects.length > DEFAULT_LIMITS.records ||
      state.projects.some(p => !object(p) || typeof p.repoId !== 'string' || typeof p.repoPath !== 'string' || typeof p.enabled !== 'boolean' ||
        (p.choice !== undefined && !['default', 'user'].includes(p.choice)) || !optionalTime(p.lookbackFrom) || !optionalTime(p.disabledAt) ||
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
  // `masked`: saved records already masked under a scope fingerprint, so an unchanged privacy setting skips the remask.
  const errors = new Map(), masked = new WeakMap();
  const enqueue = fn => {
    if (closed) return Promise.reject(new Error('Conversation recovery is closed.'));
    const result = queue.then(fn); queue = result.catch(() => {}); return result;
  };
  async function scope(repoId) {
    const repos = list(await getRepositories());
    const matches = repos.filter(repo => repo.id === repoId);
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
    context.registered = new Set(repos.map(item => item?.id));
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
  const expired = (cutoff, event) => Date.parse(event.at) < cutoff;
  const stale = (cutoff, source) => { const at = modified(source); return at !== null && at < cutoff; };
  function serialize(next) {
    // A removal copies a record still shared with the saved state, so a failed write leaves that state intact.
    const own = project => {
      if (!state.projects.includes(project)) return project;
      const copy = { ...project, events: [...project.events], sources: [...project.sources], notices: [...project.notices] };
      next.projects[next.projects.indexOf(project)] = copy; return copy;
    };
    // Retention: no journal write keeps an excerpt, or a source last changed, more than 30 days ago.
    const cutoff = now() - RETENTION;
    for (const project of [...next.projects]) {
      if (!project.events.some(e => expired(cutoff, e)) && !project.sources.some(s => stale(cutoff, s))) continue;
      const p = own(project), before = p.events.length;
      p.events = p.events.filter(e => !expired(cutoff, e)); p.sources = p.sources.filter(s => !stale(cutoff, s));
      if (p.events.length < before) notice(p, AGE_NOTICE);
    }
    // Past the byte cap the globally oldest excerpts go first, so capture keeps advancing instead of stalling.
    for (;;) {
      const text = `${JSON.stringify(next)}\n`, drop = new Set();
      let over = Buffer.byteLength(text) - limits.journalBytes;
      if (over <= 0) return text;
      for (const event of next.projects.flatMap(project => project.events).sort(older)) {
        if (over <= 0) break;
        drop.add(event); over -= Buffer.byteLength(JSON.stringify(event)) + 1;
      }
      if (!drop.size) throw new Error('Conversation recovery journal is full. Capture is paused; unread source positions were kept.');
      for (const project of [...next.projects]) if (project.events.some(e => drop.has(e))) { const p = own(project); p.events = p.events.filter(e => !drop.has(e)); notice(p, CAP_NOTICE); }
    }
  }
  function settle(next, context) {
    state = next; errors.delete(context.repo.id);
    // Every caller remasked this record (or found it current) under this fingerprint before saving it.
    const project = next.projects.find(p => p.repoId === context.repo.id); if (project) masked.set(project, context.fingerprint);
  }
  async function commit(next, context, { capture = false } = {}) {
    const text = serialize(next);
    await assertScope(context);
    if (capture && isPaused()) throw new Error('Conversation recovery was paused. Unread source positions were retained.');
    await persist(file, text); settle(next, context);
  }
  // Only the record being changed is copied; the others stay shared with the saved state until a write must alter them.
  const fork = repoId => ({ ...state, projects: state.projects.map(p => (p.repoId === repoId ? clone(p) : p)) });
  async function refresh(project, context) {
    const saved = state.projects.find(p => p.repoId === context.repo.id);
    if (!project || (saved && masked.get(saved) === context.fingerprint)) return false;
    const before = JSON.stringify(project); await remask(project, context);
    const changed = JSON.stringify(project) !== before;
    if (!changed && saved) masked.set(saved, context.fingerprint);
    return changed;
  }
  function projectOf(next, context, create = false) {
    let project = next.projects.find(p => p.repoId === context.repo.id);
    if (project && project.repoPath !== context.repo.path) throw new Error('The registered repository folder changed; the prior recovery journal is retained separately.');
    if (!project && create) {
      if (next.projects.length >= limits.records) throw new Error(`${SLOTS} Existing records were kept.`);
      project = empty(context.repo, now()); next.projects.push(project);
    }
    return project;
  }
  function snapshot(project, context, { offset = 0, limit = 20, includeReviewed = false } = {}) {
    const p = project ?? empty(context.repo, now());
    // Newest message first: a look-back import captures old messages late, so capture time would bury recent ones.
    const rows = p.events.filter(e => includeReviewed || !e.reviewedAt).sort((a, b) => older(b, a));
    const items = rows.slice(offset, offset + limit).map(({ cwd, root, ...event }) => event);
    // No record yet: choice null means the next automatic check turns capture on; 'default' while off means the project limit keeps it off.
    const full = !project && (taken(state.projects, context.registered) >= limits.projects || state.projects.length >= limits.records);
    return { repoId: context.repo.id, enabled: p.enabled, enabledAt: p.enabledAt, choice: project ? project.choice ?? 'user' : full ? 'default' : null,
      lookbackFrom: project ? project.lookbackFrom ?? project.enabledAt : null, paused: Boolean(isPaused()), checkedAt: p.checkedAt,
      pending: p.events.filter(e => !e.reviewedAt).length, total: p.events.length, sources: p.sources.length,
      hasMore: p.hasMore || errors.has(context.repo.id), warnings: [...new Set([...p.notices, ...p.warnings, ...(full ? [`${SLOTS} This project is not captured.`] : [])])].slice(0, 25),
      error: errors.get(context.repo.id) ?? null, items, nextOffset: offset + items.length < rows.length ? offset + items.length : null };
  }
  async function readInner(options) {
    validateOptions(options, ['repoId', 'offset', 'limit', 'includeReviewed']);
    if ((options.offset !== undefined && (!Number.isSafeInteger(options.offset) || options.offset < 0 || options.offset > limits.events)) ||
      (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 20)) ||
      (options.includeReviewed !== undefined && typeof options.includeReviewed !== 'boolean')) throw new Error('Invalid conversation recovery page.');
    const context = await scope(options.repoId), next = fork(options.repoId), project = projectOf(next, context);
    if (await refresh(project, context)) await commit(next, context);
    await assertScope(context);
    return snapshot(project, context, options);
  }
  function notice(project, text) {
    if (!text || project.notices.includes(text)) return;
    if (project.notices.length < 20) project.notices.push(text);
    else project.notices[19] = 'Additional source coverage warnings occurred. Some conversation material could not be retained.';
  }
  function note(project, warning, context) { notice(project, safeText(warning, context)); }
  // Oldest message time kept: the look-back (legacy records: enabledAt), never older than retention.
  const floor = project => Math.max(Date.parse(project.lookbackFrom ?? project.enabledAt), now() - RETENTION);
  async function discovery(context, project, pass) {
    const result = await sourceReader.discover({ repo: context.repo, since: floor(project), ...(pass ? { pass } : {}) });
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
    const context = await scope(options.repoId), next = fork(options.repoId), existing = projectOf(next, context);
    await refresh(existing, context);
    // An explicit off is saved even before the first automatic check, so default capture never overrides it.
    if (existing && existing.enabled === options.enabled) return snapshot(existing, context);
    if (options.enabled && isPaused()) throw new Error('Resume Summon observation before enabling conversation recovery.');
    // A project that is off, or no longer registered, holds no slot; turning one on needs a free slot.
    if (options.enabled && taken(next.projects, context.registered) >= limits.projects) throw new Error(`${SLOTS} Turn another project off first.`);
    const project = existing ?? projectOf(next, context, true);
    project.enabled = options.enabled; project.choice = 'user';
    // Turning off deletes this project's saved excerpts and positions; only the off choice is kept.
    if (!options.enabled) Object.assign(project, { disabledAt: iso(now()), events: [], sources: [], nextSource: 0, hasMore: false, warnings: [], notices: [] });
    else {
      // A first enable looks back 14 days. Every existing record here was turned off, so turning it back on starts at this moment and never reads the off period.
      const at = now();
      Object.assign(project, { enabledAt: iso(at), lookbackFrom: iso(existing ? at : at - LOOKBACK), sources: [], nextSource: 0, hasMore: false });
      const found = await discovery(context, project);
      // Sources unchanged since before the window cannot hold a message to keep, so they are not tracked.
      const recent = found.sources.filter(s => !(s.modifiedAt < (existing ? at - RETENTION : floor(project))));
      for (const descriptor of recent.slice(0, limits.sources)) {
        if (!existing) { project.sources.push({ descriptor, cursor: null, eof: false }); continue; }
        try {
          const batch = await sourceReader.readBatch(descriptor, null, { baseline: true });
          project.sources.push({ descriptor, cursor: batch.cursor, eof: true, ...(stamp(descriptor) ? { seen: stamp(descriptor) } : {}) });
          for (const warning of batch.warnings ?? []) note(project, warning, context);
        } catch { project.warnings.push('A source could not be baselined. Only dated messages after enabling will be considered on retry.'); project.hasMore = true; }
      }
      if (recent.length > limits.sources) project.warnings.push('Source limit reached. Additional sources remain uncaptured.');
      project.hasMore ||= found.incomplete || recent.length > limits.sources || project.sources.some(s => !s.eof);
      if (existing) project.enabledAt = project.lookbackFrom = iso(now());
      project.checkedAt = iso(now());
    }
    await commit(next, context, { capture: options.enabled }); return snapshot(project, context);
  }
  async function scanOne(repoId, pass) {
    const context = await scope(repoId), next = fork(repoId), project = projectOf(next, context);
    if (!project?.enabled || isPaused()) return snapshot(project, context);
    const stable = () => JSON.stringify({ ...project, checkedAt: null }), before = stable();
    await refresh(project, context);
    const from = floor(project);
    const found = await discovery(context, project, pass), available = new Map(found.sources.map(s => [keyOf(s), s]));
    let incomplete = found.incomplete;
    for (const source of project.sources) {
      const descriptor = available.get(keyOf(source.descriptor));
      if (descriptor) source.descriptor = descriptor;
      else { source.eof = false; incomplete = true; project.warnings.push('A previously tracked source is unavailable or excluded. Its saved position was retained.'); }
    }
    // A new source unchanged since before the look-back holds nothing to keep. At the source limit the most recently changed
    // sources are tracked; a displaced one is read again from its start, with duplicate protection, once it changes.
    const tracked = new Set(project.sources.map(s => keyOf(s.descriptor)));
    for (const s of found.sources) if (!tracked.has(keyOf(s)) && !(s.modifiedAt < from)) { tracked.add(keyOf(s)); project.sources.push({ descriptor: s, cursor: null, eof: false }); }
    if (project.sources.length > limits.sources) {
      const kept = new Set([...project.sources].sort((a, b) => (modified(b) ?? 0) - (modified(a) ?? 0)).slice(0, limits.sources));
      project.sources = project.sources.filter(s => kept.has(s)); incomplete = true;
      project.warnings.push('Source limit reached. Additional sources remain uncaptured.');
    }
    // Unread sources first, then finished ones that changed since their last read; an unchanged finished source is not reopened.
    const start = project.nextSource % Math.max(1, project.sources.length);
    const ordered = project.sources.slice(start).concat(project.sources.slice(0, start)).filter(s => available.has(keyOf(s.descriptor)));
    const due = [...ordered.filter(s => !s.eof), ...ordered.filter(s => s.eof && (!stamp(s.descriptor) || s.seen !== stamp(s.descriptor)))].slice(0, limits.sourcesPerScan);
    for (const source of due) {
      const descriptor = available.get(keyOf(source.descriptor));
      let batch;
      try { batch = await sourceReader.readBatch(descriptor, source.cursor, { baselineBefore: from }); }
      catch { source.eof = false; incomplete = true; project.warnings.push('A conversation source could not be read. Its saved position was retained for retry.'); continue; }
      const known = new Set(project.events.map(e => e.id));
      let additions = [];
      for (const event of batch.events) {
        if (!Number.isFinite(event.at)) { note(project, 'An undated conversation message was skipped because its capture boundary could not be verified.', context); continue; }
        if (event.at < from || await hidden(event.cwd ?? descriptor.cwd, context) || known.has(event.id)) continue;
        const masked = maskedText(event.text, context, event.truncated), text = masked.slice(0, 1000);
        if (!text) continue;
        known.add(event.id);
        const cwd = context.realCwds.get(event.cwd ?? descriptor.cwd);
        const root = context.realRoots.filter(root => inside(cwd, root)).sort((a, b) => b.length - a.length)[0];
        additions.push({ id: event.id, provider: descriptor.provider, sessionKey: descriptor.sessionKey, role: event.role, text,
          at: iso(event.at), capturedAt: iso(now()), truncated: Boolean(event.truncated) || masked.length > 1000, reviewedAt: null, cwd, root });
      }
      if (project.events.length + additions.length > limits.events) {
        // Keep the newest excerpts by message time; the cursor still advances, so capture never stalls.
        const drop = new Set([...project.events, ...additions].sort(older).slice(0, project.events.length + additions.length - limits.events));
        project.events = project.events.filter(e => !drop.has(e)); additions = additions.filter(e => !drop.has(e));
        note(project, CAP_NOTICE, context);
      }
      project.events.push(...additions); source.cursor = batch.cursor; source.eof = batch.eof;
      if (stamp(descriptor)) source.seen = stamp(descriptor); else delete source.seen;
      for (const warning of batch.warnings ?? []) note(project, warning, context);
    }
    if (due.length) project.nextSource = (project.sources.indexOf(due.at(-1)) + 1) % project.sources.length;
    project.hasMore = incomplete || project.sources.some(s => !s.eof);
    project.warnings = [...new Set(project.warnings)].slice(0, 20);
    project.checkedAt = iso(now());
    // A mid-read pause must not consume messages that the user meant to exclude.
    if (isPaused()) return snapshot(state.projects.find(p => p.repoId === repoId), context);
    // With every project on, rewriting an unchanged journal each minute would only add disk writes.
    if (stable() === before) { await assertScope(context); settle(next, context); return snapshot(project, context); }
    await commit(next, context, { capture: true }); return snapshot(project, context);
  }
  async function adopt() {
    // Default capture: a repository without any record starts once, looking back 14 days. An explicit off is a record, so it is never overridden.
    if (isPaused()) return 0;
    let repos, unplaced = 0;
    try { repos = list(await getRepositories()); } catch { return 0; }
    const registered = new Set(repos.map(repo => repo?.id));
    for (const repo of repos) {
      if (typeof repo?.id !== 'string' || !repo.id || repo.id.length > 200 || state.projects.some(p => p.repoId === repo.id)) continue;
      if (isPaused()) break;
      let context;
      try { context = await scope(repo.id); } catch { continue; }
      if (taken(state.projects, registered) >= limits.projects || state.projects.length >= limits.records) { unplaced++; continue; }
      try {
        const next = fork(null), project = projectOf(next, context, true), at = now();
        Object.assign(project, { enabled: true, choice: 'default', enabledAt: iso(at), lookbackFrom: iso(at - LOOKBACK), hasMore: true });
        await commit(next, context, { capture: true });
      } catch { if (!isPaused()) errors.set(repo.id, 'Conversation recovery could not start for this project. It will retry at the next check.'); }
    }
    return unplaced;
  }
  async function expire() {
    // Retention needs no scope: records of moved, removed or sealed repositories lose old excerpts too.
    const cutoff = now() - RETENTION;
    if (!state.projects.some(p => p.events.some(e => expired(cutoff, e)) || p.sources.some(s => stale(cutoff, s)))) return;
    const next = { ...state, projects: [...state.projects] };
    await persist(file, serialize(next)); state = next;
  }
  return {
    read: options => enqueue(() => readInner(options)),
    setEnabled: options => enqueue(() => enableInner(options)),
    scan: (options = {}) => enqueue(async () => {
      if (!object(options) || Object.keys(options).some(key => key !== 'repoId')) throw new Error('Invalid recovery scan request.');
      if (options.repoId !== undefined) validateOptions(options, ['repoId']);
      // A failed retention write is retried by the next write or check; it never blocks capture.
      await expire().catch(() => {});
      // Only automatic checks turn projects on.
      const unplaced = options.repoId ? 0 : await adopt();
      let ids = [options.repoId];
      if (!options.repoId) {
        const registered = new Set(list(await Promise.resolve().then(getRepositories).catch(() => [])).map(repo => repo?.id));
        ids = state.projects.filter(p => p.enabled && registered.has(p.repoId)).map(p => p.repoId);
        // A project registered again after others filled its slot waits instead of exceeding the bound.
        for (const id of ids.splice(limits.projects)) errors.set(id, `${SLOTS} This project waits until another project is turned off.`);
      }
      const pass = {};
      let result = null;
      for (const id of ids) {
        try { result = await scanOne(id, pass); }
        catch (error) { errors.set(id, 'Conversation recovery could not finish. Saved excerpts and unread source positions were retained.'); if (options.repoId) throw error; }
      }
      return unplaced && result ? { ...result, warnings: [...new Set([...result.warnings, `${SLOTS} ${unplaced} more ${unplaced === 1 ? 'repository is' : 'repositories are'} not captured.`])] } : result;
    }),
    review: options => enqueue(async () => {
      validateOptions(options, ['repoId', 'id', 'reviewed']);
      if (typeof options.id !== 'string' || options.id.length > 300 || typeof options.reviewed !== 'boolean') throw new Error('Invalid recovered excerpt.');
      const context = await scope(options.repoId), next = fork(options.repoId), project = projectOf(next, context);
      const event = project?.events.find(e => e.id === options.id);
      if (!event) throw new Error('The recovered excerpt is not in this repository.');
      event.reviewedAt = options.reviewed ? iso(now()) : null; await refresh(project, context);
      await commit(next, context); return snapshot(project, context);
    }),
    // Internal only (never RPC/MCP/preload): the completion reconciler reads the user's own words under the same scope and masking as read().
    userMessages: () => enqueue(async () => {
      if (isPaused()) return [];
      const result = [];
      for (const repoId of state.projects.filter(p => p.enabled).map(p => p.repoId)) {
        try {
          const context = await scope(repoId), next = fork(repoId), project = projectOf(next, context);
          if (!project?.enabled) continue;
          if (await refresh(project, context)) await commit(next, context);
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
