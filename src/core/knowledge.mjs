import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const LIMITS = { memories: 500, routines: 100, sources: 200, directories: 300, entries: 3000, noteBytes: 65536, projectNoteBytes: 262144, projectPassageChars: 900, searchBytes: 1048576, stateBytes: 2097152 };
const ACTIONS = new Set(['calendar', 'benchmark-open', 'benchmark', 'project', 'context', 'files', 'pause', 'resume']);
const iso = () => new Date().toISOString();
const clone = value => structuredClone(value);
const idFor = text => createHash('sha256').update(text).digest('hex').slice(0, 20);
const within = (candidate, root) => candidate === root || candidate.startsWith(`${root}${path.sep}`);
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value && !value.includes('\0');
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const normalized = text => text.normalize('NFKC').toLocaleLowerCase().replace(/[.!?]+$/g, '').replace(/\s+/g, ' ').trim();
const signature = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
function textValue(value, field, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error(`${field} must contain between 1 and ${max} characters.`);
  return value.trim();
}
function projectList(input) {
  if (!Array.isArray(input) || input.length > 1000 || input.some(p => !p || typeof p.id !== 'string' || typeof p.name !== 'string' || !absolute(p.path))) throw new Error('Invalid workspace list.');
  return input.map(({ id, name, path: folder }) => ({ id, name, path: folder }));
}
function validState(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.memories) || !Array.isArray(value.routines) || !value.config || value.memories.length > LIMITS.memories || value.routines.length > LIMITS.routines) throw new Error('Unsupported knowledge schema or limits.');
  const ids = new Set();
  for (const memory of value.memories) {
    textValue(memory.text, 'Memory', 2000);
    textValue(memory.source, 'Memory source', 200);
    if (typeof memory.id !== 'string' || ids.has(memory.id) || memory.kind !== 'explicit' || !(memory.projectId === null || typeof memory.projectId === 'string') || !date(memory.createdAt) || !date(memory.updatedAt)) throw new Error('Invalid memory record.');
    ids.add(memory.id);
  }
  const triggers = new Set();
  for (const routine of value.routines) {
    textValue(routine.name, 'Routine name', 100); textValue(routine.trigger, 'Routine trigger', 160); textValue(routine.command, 'Routine command', 1000);
    const key = `${routine.projectId}\0${normalized(routine.trigger)}`;
    if (typeof routine.id !== 'string' || ids.has(routine.id) || triggers.has(key) || !(routine.projectId === null || typeof routine.projectId === 'string') || !ACTIONS.has(routine.actionType) || !date(routine.createdAt) || !date(routine.updatedAt) || !(routine.lastUsedAt === null || date(routine.lastUsedAt)) || !Number.isSafeInteger(routine.useCount) || routine.useCount < 0) throw new Error('Invalid routine record.');
    ids.add(routine.id); triggers.add(key);
  }
  if (value.config.vaultPath !== null && !absolute(value.config.vaultPath)) throw new Error('Invalid vault configuration.');
  if (!Array.isArray(value.config.notes) || value.config.notes.length > 32 || value.config.notes.some(note => !absolute(note) || !value.config.vaultPath || !within(note, value.config.vaultPath) || path.extname(note).toLowerCase() !== '.md')) throw new Error('Invalid explicit note configuration.');
  return value;
}

/** Curated local knowledge. No model calls, shell execution, or autonomous learning. */
export async function createKnowledge({ dataDir, projects = [], validateCommand, emit = () => {} } = {}) {
  if (!absolute(dataDir)) throw new Error('Knowledge directory must be an absolute path.');
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  dataDir = await fs.realpath(dataDir);
  const filename = path.join(dataDir, 'knowledge.json');
  let workspaces = projectList(projects);
  let state = { version: 1, memories: [], routines: [], config: { vaultPath: null, notes: [] } };
  let sources = [];
  let fileSignature = null;
  let queue = Promise.resolve();
  const health = { lastRefreshAt: null, errors: [] };
  const problem = message => { if (!health.errors.includes(message)) health.errors = [...health.errors.slice(-9), String(message).slice(0, 500)]; };
  const snapshot = () => ({ version: 1, memories: clone(state.memories).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), routines: clone(state.routines).sort((a, b) => a.name.localeCompare(b.name)), sources: clone(sources), health: clone(health) });
  const notify = () => { try { emit(snapshot()); } catch { /* UI failures must not corrupt saved knowledge. */ } };
  const enqueue = fn => { const result = queue.then(fn); queue = result.catch(() => {}); return result; };
  async function readState({ startup = false } = {}) {
    try {
      const stat = await fs.lstat(filename, { bigint: true });
      if (signature(stat) === fileSignature) return;
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > BigInt(LIMITS.stateBytes)) throw new Error('Knowledge state must be a regular file under 2 MiB.');
      const next = validState(JSON.parse(await fs.readFile(filename, 'utf8')));
      state = next; fileSignature = signature(stat);
    } catch (error) {
      if (error.code === 'ENOENT') { fileSignature = null; return; }
      if (!startup) throw new Error(`Knowledge changed on disk but could not be loaded; no changes were written. ${error.message}`);
      // Preserve invalid user-edited state for recovery instead of silently replacing it.
      const quarantine = `${filename}.corrupt-${Date.now()}-${randomUUID().slice(0, 6)}`;
      await fs.rename(filename, quarantine);
      problem(`Knowledge could not be loaded; preserved as ${path.basename(quarantine)}. ${error.message}`);
      fileSignature = null;
    }
  }
  async function save() {
    const tmp = path.join(dataDir, `.knowledge-${randomUUID()}.tmp`);
    let handle;
    try {
      let current = null;
      try { current = signature(await fs.lstat(filename, { bigint: true })); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (current !== fileSignature) throw new Error('Knowledge was edited externally during this operation. Retry to load those edits.');
      const contents = `${JSON.stringify(state, null, 2)}\n`;
      if (Buffer.byteLength(contents) > LIMITS.stateBytes) throw new Error('Knowledge storage limit reached. Remove unused memories or routines.');
      handle = await fs.open(tmp, 'wx', 0o600);
      await handle.writeFile(contents); await handle.sync(); await handle.close(); handle = null;
      await fs.rename(tmp, filename);
      const dir = await fs.open(dataDir, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
      fileSignature = signature(await fs.lstat(filename, { bigint: true }));
      health.errors = health.errors.filter(error => !error.startsWith('Could not save knowledge:'));
    } catch (error) {
      problem(`Could not save knowledge: ${error.message}`);
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(tmp).catch(() => {});
      throw error;
    }
  }
  async function mutate(fn) {
    await readState();
    const before = clone(state);
    try { const result = await fn(); await save(); notify(); return result === undefined ? snapshot() : clone(result); }
    catch (error) { state = before; throw error; }
  }
  function checkedProject(id = null) {
    if (id !== null && (typeof id !== 'string' || !workspaces.some(project => project.id === id))) throw new Error('Choose a saved workspace for this knowledge.');
    return id;
  }
  async function classify(command) {
    if (typeof validateCommand !== 'function') throw new Error('Routine command validation is unavailable.');
    const result = await validateCommand(command, clone(workspaces));
    if (!result || typeof result.type !== 'string') throw new Error('Routine command validation failed.');
    return result;
  }
  async function validatedRoutine(command) {
    command = textValue(command, 'Routine command', 1000);
    if (/[\r\n]/.test(command)) throw new Error('A routine must contain one direct command.');
    const result = await classify(command);
    if (!ACTIONS.has(result.type)) throw new Error('Save an existing direct command, such as opening the calendar or finding a file.');
    if (result.type === 'project') checkedProject(result.projectId);
    return { command, actionType: result.type };
  }
  function sourceProject(notePath) {
    const names = [path.basename(path.dirname(notePath)), path.basename(notePath, '.md').replace(/\s*Hub$/i, '')].map(normalized);
    const matching = workspaces.filter(project => names.includes(normalized(project.name)));
    return matching.length === 1 ? matching[0].id : null;
  }
  async function safeNote(notePath, vaultPath) {
    if (!absolute(notePath) || !within(notePath, vaultPath) || path.extname(notePath).toLowerCase() !== '.md') return null;
    try {
      const stat = await fs.lstat(notePath, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || await fs.realpath(notePath) !== notePath) return null;
      return { stat, source: { id: `note-${idFor(notePath)}`, title: path.basename(notePath, '.md'), path: notePath, projectId: sourceProject(notePath), modifiedAt: new Date(Number(stat.mtimeNs) / 1e6).toISOString() } };
    } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) problem(`Cannot read configured source ${notePath}: ${error.code || error.message}`); return null; }
  }
  async function refreshIndex() {
    sources = [];
    const vault = state.config.vaultPath;
    if (!vault) { health.lastRefreshAt = iso(); return; }
    const candidates = new Set([path.join(vault, 'Home.md'), ...state.config.notes]);
    const pending = [{ dir: path.join(vault, 'Projects'), depth: 0 }];
    let directoryCount = 0; let entryCount = 0;
    while (pending.length && directoryCount < LIMITS.directories && entryCount < LIMITS.entries && candidates.size < LIMITS.sources) {
      const { dir, depth } = pending.shift(); directoryCount++;
      try {
        const stat = await fs.lstat(dir);
        if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(dir) !== dir) continue;
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (++entryCount > LIMITS.entries || candidates.size >= LIMITS.sources) break;
          if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.isSymbolicLink()) continue;
          const target = path.join(dir, entry.name);
          if (entry.isFile() && /Hub\.md$/i.test(entry.name)) candidates.add(target);
          else if (entry.isDirectory() && depth < 3) pending.push({ dir: target, depth: depth + 1 });
        }
      } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) problem(`Cannot read configured project hubs: ${error.code || error.message}`); }
    }
    for (const candidate of [...candidates].slice(0, LIMITS.sources)) {
      const note = await safeNote(candidate, vault);
      if (note) sources.push(note.source);
    }
    if (pending.length || entryCount >= LIMITS.entries || candidates.size >= LIMITS.sources) problem('Source discovery reached its local safety limit; narrow the configured vault or use explicit note paths.');
    health.lastRefreshAt = iso();
  }
  async function noteText(source, remaining, maxBytes = LIMITS.noteBytes) {
    const note = await safeNote(source.path, state.config.vaultPath);
    if (!note) return null;
    let handle;
    try {
      handle = await fs.open(source.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile() || stat.dev !== note.stat.dev || stat.ino !== note.stat.ino || await fs.realpath(source.path) !== source.path) return null;
      const buffer = Buffer.alloc(Math.min(maxBytes, remaining, Number(stat.size)));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return { source: note.source, text: buffer.subarray(0, bytesRead).toString('utf8'), bytes: bytesRead, truncated: bytesRead < Number(stat.size) };
    } catch (error) { problem(`Cannot read configured source ${source.path}: ${error.code || error.message}`); return null; }
    finally { if (handle) await handle.close(); }
  }
  const stopwords = new Set(['a', 'an', 'the', 'my', 'me', 'what', 'which', 'where', 'is', 'are', 'was', 'were', 'do', 'did', 'does', 'i', 'we', 'you', 'about', 'for', 'to', 'of', 'on', 'in', 'and', 'or', 'please', 'find', 'search', 'show', 'remember', 'know', 'tell', 'latest', 'current']);
  function scoreText(text, terms) {
    const lower = text.toLocaleLowerCase();
    return terms.reduce((score, term) => score + (lower.includes(term) ? 1 : 0), 0);
  }
  function excerpt(text, terms) {
    const lines = text.split(/\r?\n/);
    let firstContent = 0;
    if (lines[0]?.trim() === '---') { const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---'); if (end >= 0) firstContent = end + 1; }
    const heading = index => /^\s{0,3}#{1,6}\s/.test(lines[index]) || (/^\s*(?:=+|-+)\s*$/.test(lines[index + 1] || '') && Boolean(lines[index]?.trim()));
    let best = firstContent; let bestRank = [-1, -1, -1];
    for (let index = firstContent; index < lines.length; index++) {
      const content = lines[index].trim();
      if (!content) continue;
      // Matching a document title is less useful than the project facts below it.
      // Match count remains primary; ties prefer body text, then substantive length.
      const rank = [scoreText(content, terms), heading(index) || /^[-*_]{3,}$/.test(content) ? 0 : 1, Math.min(content.length, 240)];
      if (rank[0] > bestRank[0] || (rank[0] === bestRank[0] && (rank[1] > bestRank[1] || (rank[1] === bestRank[1] && rank[2] > bestRank[2])))) { best = index; bestRank = rank; }
    }
    let start = best;
    // Include a little preceding paragraph context only when it fits without
    // pushing the selected matching line outside the excerpt's size limit.
    while (start > firstContent && start > best - 2 && lines[start - 1].trim() && !heading(start - 1) && lines.slice(start - 1, best + 1).join('\n').length <= 700) start--;
    const selected = lines.slice(start, Math.min(lines.length, best + 3)).join('\n').trim();
    // A hub can keep a whole dated entry on one very long line. Center the
    // bounded excerpt on its matching words instead of losing them at char 700.
    const lower = selected.toLocaleLowerCase();
    const hits = terms.flatMap(term => [...lower.matchAll(new RegExp(term, 'gu'))].map(match => match.index));
    const anchor = hits.sort((a, b) => scoreText(selected.slice(b, b + 600), terms) - scoreText(selected.slice(a, a + 600), terms) || a - b)[0] ?? 0;
    const offset = selected.length <= 700 ? 0 : Math.max(0, anchor - 100);
    return { text: selected.slice(offset, offset + 700), line: start + 1 + (selected.slice(0, offset).match(/\n/g) || []).length };
  }
  function pendingRank(text) {
    // Ranking is evidence selection only. Keep the author's literal status and
    // let the reasoning layer weigh newer contradictory evidence.
    if (/\b(?:not (?:yet )?sent|unsent|still owe|yet to (?:send|follow|contact)|proposed[,; —-]+not sent)\b/i.test(text)) return 12;
    if (/^\s*[-*+]\s+\[ \]/m.test(text) || /\b(?:next action|next step|to[- ]do|remains? open)\b/i.test(text)) return 7;
    if (/\b(?:awaiting|waiting (?:on|for)|pending|not (?:yet )?(?:done|completed?|resolved))\b/i.test(text)) return 4;
    return 0;
  }
  function passageChunks(text, line) {
    const chunks = [];
    let offset = 0;
    while (offset < text.length) {
      let end = Math.min(text.length, offset + LIMITS.projectPassageChars);
      if (end < text.length) {
        const candidate = text.slice(offset, end);
        // Prefer a sentence boundary, then whitespace, without dropping text.
        const sentences = [...candidate.matchAll(/[.!?](?:["')*]*)\s+/g)];
        const sentence = sentences.at(-1);
        const boundary = sentence && sentence.index > 400 ? sentence.index + sentence[0].length : candidate.lastIndexOf(' ');
        if (boundary > 400) end = offset + boundary;
      }
      const literal = text.slice(offset, end);
      const leading = literal.length - literal.trimStart().length;
      const content = literal.trim();
      if (content.length >= 30 && /[\p{L}]/u.test(content)) chunks.push({ text: content, line: line + (text.slice(0, offset + leading).match(/\n/g) || []).length, offset, pending: pendingRank(content) });
      offset = end;
    }
    return chunks;
  }
  function projectPassages(note) {
    const lines = note.text.split(/\r?\n/);
    // Do not infer a status from the unfinished last line of a capped read.
    if (note.truncated) lines.pop();
    const passages = [];
    const headings = [];
    let frontmatter = lines[0]?.trim() === '---';
    let fence = null; let comment = false; let block = []; let first = 0;
    const flush = () => {
      if (!block.length) return;
      const text = block.join('\n');
      const ownDate = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/)?.[1];
      const datedHeading = headings.findLast(heading => /\b20\d{2}-\d{2}-\d{2}\b/.test(heading.text));
      const writtenDate = ownDate || datedHeading?.text.match(/\b(20\d{2}-\d{2}-\d{2})\b/)?.[1] || '';
      const label = datedHeading ? `${note.source.title} · ${datedHeading.text}` : note.source.title;
      const routine = /\b(?:housekeeping|backfill|repo audit|disk triage|daily catch-up|application\/add-in monitoring|scraper work published)\b/i.test(text.slice(0, 260));
      for (const chunk of passageChunks(text, first + 1)) {
        passages.push({ ...chunk, date: date(writtenDate) ? writtenDate : '', routine, group: `${note.source.id}:${first}`, result: {
          id: `${note.source.id}:${first + 1}:${chunk.offset}`, kind: 'project-note', text: chunk.text, projectId: note.source.projectId,
          source: { label: ownDate && chunk.offset > 0 ? `${label} · ${ownDate}` : label, path: note.source.path, line: chunk.line, modifiedAt: note.source.modifiedAt },
        } });
      }
      block = [];
    };
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (frontmatter) { if (index > 0 && line.trim() === '---') frontmatter = false; continue; }
      const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (marker) {
        flush();
        if (!fence) fence = marker[1];
        else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
        continue;
      }
      if (fence) continue;
      if (comment || line.includes('<!--')) { flush(); comment = !line.includes('-->'); continue; }
      const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading) {
        flush();
        while (headings.length && headings.at(-1).depth >= heading[1].length) headings.pop();
        headings.push({ depth: heading[1].length, text: heading[2] });
        continue;
      }
      // Curated documents are still untrusted data, not operating instructions.
      const boilerplate = headings.some(heading => /\b(?:instructions|universal rules|maintenance|where things live|note conventions)\b/i.test(heading.text));
      if (!line.trim() || /^(?: {4}|\t)/.test(line) || /^\s*[-*_]{3,}\s*$/.test(line) || boilerplate) { flush(); continue; }
      if (/^\s*[-*+]\s/.test(line) && block.length) flush();
      if (!block.length) first = index;
      block.push(line);
    }
    flush();
    return passages;
  }
  function routineForTrigger(trigger, projectId = null) {
    if (typeof trigger !== 'string' || trigger.length > 160) return null;
    const match = normalized(trigger);
    const routine = (projectId && state.routines.find(row => row.projectId === projectId && normalized(row.trigger) === match)) || state.routines.find(row => row.projectId === null && normalized(row.trigger) === match);
    return routine ? clone(routine) : null;
  }
  const service = {
    snapshot,
    remember: input => enqueue(() => mutate(() => {
      if (!input || typeof input !== 'object') throw new Error('Provide a memory to save.');
      const text = textValue(input.text, 'Memory', 2000);
      const projectId = checkedProject(input.projectId);
      const source = input.source === undefined ? 'You' : textValue(input.source, 'Memory source', 200);
      const existing = state.memories.find(memory => memory.projectId === projectId && normalized(memory.text) === normalized(text));
      if (existing) { existing.text = text; existing.source = source; existing.updatedAt = iso(); }
      else {
        if (state.memories.length >= LIMITS.memories) throw new Error('Memory limit reached. Remove an unused memory before saving another.');
        const at = iso(); state.memories.push({ id: randomUUID(), kind: 'explicit', text, projectId, source, createdAt: at, updatedAt: at });
      }
    })),
    forget: id => enqueue(() => mutate(() => {
      if (!state.memories.some(memory => memory.id === id)) throw new Error('Unknown memory.');
      state.memories = state.memories.filter(memory => memory.id !== id);
    })),
    refreshSources: input => enqueue(async () => {
      if (!input || typeof input !== 'object') throw new Error('Provide source configuration.');
      if (input.projects !== undefined) workspaces = projectList(input.projects);
      await mutate(async () => {
        if (input.vaultPath !== undefined) {
          if (input.vaultPath === null || input.vaultPath === '') state.config = { vaultPath: null, notes: [] };
          else {
            if (!absolute(input.vaultPath)) throw new Error('Choose an absolute Second Brain folder.');
            const canonical = await fs.realpath(input.vaultPath);
            if (!(await fs.stat(canonical)).isDirectory()) throw new Error('The vault must be a folder.');
            if (state.config.vaultPath !== canonical) state.config.notes = [];
            state.config.vaultPath = canonical;
          }
        }
        if (input.notes !== undefined) {
          if (!state.config.vaultPath || !Array.isArray(input.notes) || input.notes.length > 32) throw new Error('Choose up to 32 explicit notes inside the configured vault.');
          state.config.notes = [];
          for (const value of input.notes) {
            if (typeof value !== 'string' || value.includes('\0')) throw new Error('Invalid explicit note path.');
            const candidate = path.resolve(state.config.vaultPath, value);
            if (!await safeNote(candidate, state.config.vaultPath)) throw new Error('Explicit notes must be real Markdown files inside the configured vault, without symlink traversal.');
            state.config.notes.push(candidate);
          }
          state.config.notes = [...new Set(state.config.notes)];
        }
      });
      await refreshIndex(); notify(); return snapshot();
    }),
    projectContext: (projectId, { limit = 8 } = {}) => enqueue(async () => {
      await readState();
      checkedProject(projectId);
      if (!Number.isInteger(limit) || limit < 1 || limit > 8) throw new Error('Choose a project context limit between 1 and 8.');
      if (!projectId) return [];
      const candidates = [];
      for (const memory of state.memories.filter(memory => memory.projectId === projectId)) {
        const chunks = passageChunks(memory.text, 1);
        const chunk = chunks.sort((a, b) => b.pending - a.pending || a.offset - b.offset)[0];
        const text = chunk?.text || memory.text.slice(0, LIMITS.projectPassageChars);
        candidates.push({ pending: pendingRank(text), date: memory.updatedAt.slice(0, 10), group: memory.id, explicit: true, result: {
          id: memory.id, kind: 'explicit', text, projectId, source: { label: memory.source, modifiedAt: memory.updatedAt },
        } });
      }
      await refreshIndex();
      let remaining = LIMITS.searchBytes;
      // The broad search API intentionally permits unscoped Home/global facts.
      // Goal inference must use only sources mapped to this exact workspace.
      for (const source of sources.filter(source => source.projectId === projectId).sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.path.localeCompare(b.path))) {
        if (remaining <= 0) break;
        const note = await noteText(source, remaining, LIMITS.projectNoteBytes);
        if (!note) continue;
        remaining -= note.bytes;
        if (note.source.projectId === projectId) candidates.push(...projectPassages(note));
      }
      const activityDate = candidate => (Date.parse(candidate.date) || 0) - (candidate.routine ? 14 * 86400000 : 0);
      let topics = [];
      const related = candidate => scoreText(candidate.result.text, topics) + (candidate.offset === 0 ? 4 : 0);
      const recent = (a, b) => activityDate(b) - activityDate(a) || related(b) - related(a) || Number(Boolean(b.explicit)) - Number(Boolean(a.explicit)) || (a.line ?? 0) - (b.line ?? 0) || (a.offset ?? 0) - (b.offset ?? 0);
      const selected = []; const groups = new Set();
      const add = candidate => {
        if (!groups.has(candidate.group) && selected.length < limit) { selected.push(candidate); groups.add(candidate.group); }
      };
      // Reserve room both for older unsent commitments and newer progress.
      const pendingBudget = Math.min(2, Math.ceil(limit / 3));
      for (const candidate of candidates.filter(candidate => candidate.pending >= 4).sort((a, b) => b.pending - a.pending || b.date.localeCompare(a.date) || recent(a, b))) {
        if (selected.length >= pendingBudget) break;
        add(candidate);
      }
      // Within equally recent entries, prefer progress related to the open
      // commitments. Routine monitoring remains eligible but does not crowd out
      // the product work that a pending update would actually discuss.
      const generic = new Set(['drafted', 'instead', 'formal', 'notes', 'which', 'their', 'using', 'source', 'status', 'project', 'proposed', 'since', 'would', 'could', 'should']);
      topics = [...new Set([...selected].sort((a, b) => a.result.text.length - b.result.text.length).flatMap(candidate => candidate.result.text.toLocaleLowerCase().match(/[\p{L}]{5,}/gu) || []).filter(term => !stopwords.has(term) && !generic.has(term)))].slice(0, 60);
      for (const candidate of candidates.sort(recent)) add(candidate);
      return selected.map(candidate => candidate.result);
    }),
    search: (query, { projectId = null, limit = 8 } = {}) => enqueue(async () => {
      await readState();
      checkedProject(projectId);
      if (typeof query !== 'string' || query.length > 500) throw new Error('Use a knowledge search under 500 characters.');
      if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('Choose a result limit between 1 and 20.');
      const terms = [...new Set((query.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(term => !stopwords.has(term)))].slice(0, 12);
      if (!terms.length) return [];
      const results = [];
      for (const memory of state.memories) {
        if (projectId && memory.projectId && memory.projectId !== projectId) continue;
        const score = scoreText(memory.text, terms);
        if (score) results.push({ id: memory.id, kind: 'explicit', text: memory.text, projectId: memory.projectId, source: { label: memory.source }, score: score + (projectId && memory.projectId === projectId ? 0.5 : 0) + 0.25 });
      }
      await refreshIndex();
      let remaining = LIMITS.searchBytes;
      const candidates = sources.filter(source => !projectId || !source.projectId || source.projectId === projectId).sort((a, b) => scoreText(b.title, terms) - scoreText(a.title, terms));
      for (const source of candidates) {
        if (remaining <= 0) break;
        const note = await noteText(source, remaining);
        if (!note) continue;
        remaining -= note.bytes;
        const score = scoreText(`${note.source.title}\n${note.text}`, terms);
        if (!score) continue;
        const snippet = excerpt(note.text, terms);
        if (snippet.text) results.push({ id: source.id, kind: 'retrieved', text: snippet.text, projectId: source.projectId, source: { label: note.source.title, path: source.path, line: snippet.line, modifiedAt: note.source.modifiedAt }, score: score + (projectId && source.projectId === projectId ? 0.5 : 0) });
      }
      return results.sort((a, b) => b.score - a.score).slice(0, limit);
    }),
    saveRoutine: input => enqueue(() => mutate(async () => {
      if (!input || typeof input !== 'object') throw new Error('Provide a routine to save.');
      const name = textValue(input.name, 'Routine name', 100);
      const trigger = textValue(input.trigger, 'Routine trigger', 160);
      if (/[\r\n]/.test(trigger)) throw new Error('Use a single phrase as the routine trigger.');
      const projectId = checkedProject(input.projectId);
      const triggerAction = await classify(trigger);
      if (triggerAction.type !== 'unknown') throw new Error('That trigger is already a direct command. Choose a distinct phrase for your routine.');
      const { command, actionType } = await validatedRoutine(input.command);
      const existing = state.routines.find(routine => routine.projectId === projectId && normalized(routine.trigger) === normalized(trigger));
      if (existing) Object.assign(existing, { name, trigger, command, actionType, updatedAt: iso() });
      else {
        if (state.routines.length >= LIMITS.routines) throw new Error('Routine limit reached. Remove an unused routine first.');
        const at = iso(); state.routines.push({ id: randomUUID(), name, trigger, command, actionType, projectId, createdAt: at, updatedAt: at, lastUsedAt: null, useCount: 0 });
      }
    })),
    removeRoutine: id => enqueue(() => mutate(() => {
      if (!state.routines.some(routine => routine.id === id)) throw new Error('Unknown routine.');
      state.routines = state.routines.filter(routine => routine.id !== id);
    })),
    findRoutine: routineForTrigger,
    resolveRoutine: (trigger, projectId = null) => enqueue(async () => {
      await readState(); checkedProject(projectId);
      return routineForTrigger(trigger, projectId);
    }),
    prepareRoutine: (id, { trigger, projectId } = {}) => enqueue(async () => {
      await readState();
      const routine = state.routines.find(row => row.id === id);
      if (!routine) throw new Error('This routine no longer exists.');
      checkedProject(routine.projectId);
      if (trigger !== undefined && (typeof trigger !== 'string' || normalized(trigger) !== normalized(routine.trigger))) throw new Error('This routine trigger changed. Use its current phrase.');
      if (projectId !== undefined && routine.projectId !== null && routine.projectId !== checkedProject(projectId)) throw new Error('This routine no longer matches the current workspace.');
      const action = await validatedRoutine(routine.command);
      if (action.actionType !== routine.actionType || (await classify(routine.trigger)).type !== 'unknown') throw new Error('This routine needs to be saved again after its command changed.');
      return clone(routine);
    }),
    useRoutine: (id, { expectedCommand, expectedUpdatedAt } = {}) => enqueue(() => mutate(async () => {
      const routine = state.routines.find(row => row.id === id);
      const guarded = expectedCommand !== undefined || expectedUpdatedAt !== undefined;
      if (guarded && (!routine || (expectedCommand !== undefined && routine.command !== expectedCommand) || (expectedUpdatedAt !== undefined && routine.updatedAt !== expectedUpdatedAt))) return null;
      if (!routine) throw new Error('Unknown routine.');
      checkedProject(routine.projectId);
      await validatedRoutine(routine.command);
      routine.lastUsedAt = iso(); routine.useCount++;
      return routine;
    })),
  };
  await readState({ startup: true });
  await refreshIndex();
  return service;
}
