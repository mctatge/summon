// Private, read-only transcript sources for durable recovery. The caller masks excerpts before persistence.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { sealedPath } from '../workstreams.mjs';
import { conversationText, CONTEXT_CHARS } from './recent-context.mjs';
import { discoverCodexWorkTranscripts } from './codex.mjs';
import { createSqliteSnapshots } from './sqlite-snapshot.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRANSCRIPT = /^([0-9a-f-]{36})\.jsonl$/i;
const TEXT_TYPES = new Set(['text', 'input_text', 'output_text']);
const CLAUDE_METADATA = new Set(['ai-title', 'custom-title', 'bridge-session', 'last-prompt', 'queue-operation', 'system', 'file-history-snapshot', 'file-history-delta']);
const DEFAULTS = { sources: 2000, directories: 1000, metadataBytes: 65536, lineBytes: 65536, batchBytes: 262144 };
const absolute = value => typeof value === 'string' && value.length <= 4096 && path.isAbsolute(value) && path.normalize(value) === value && !/[\0-\x1f]/.test(value);
const inside = (file, root) => file === root || file.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
const hash = value => createHash('sha256').update(value).digest('hex');
const identity = stat => `${stat.dev}:${stat.ino}`;
const validTime = value => { const at = typeof value === 'string' ? Date.parse(value) : value; return Number.isFinite(at) && at > 0 ? at : null; };
const sourceKey = source => `${source.provider}:${source.sessionId}:${source.file}`;
const safeWarning = provider => `${provider === 'codex' ? 'Codex' : 'Claude'} recovery source could not be safely read.`;

async function bytesAt(handle, offset, length) {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(buffer, done, length - done, offset + done);
    if (!bytesRead) break;
    done += bytesRead;
  }
  return buffer.subarray(0, done);
}

async function entries(dir, limit) {
  const out = [];
  let truncated = false;
  let listing;
  try { listing = await fs.opendir(dir); } catch (error) { if (error.code === 'ENOENT') return { entries: out, truncated }; throw error; }
  for await (const entry of listing) {
    if (out.length >= limit) { truncated = true; break; }
    out.push(entry);
  }
  return { entries: out, truncated };
}

function rawText(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter(part => part && TEXT_TYPES.has(part.type) && typeof part.text === 'string').slice(0, 16).map(part => part.text).join('\n') : '';
}

/** Source descriptors are internal capabilities: discover before readBatch, including after a restart.
 * No activity horizon is applied. `since` is reserved for future metadata optimizations; callers filter events by time. */
export function createWorkRecoverySources({ homeDir = os.homedir(), run, snapshots, limits = {} } = {}) {
  if (!absolute(homeDir)) throw new Error('Recovery needs an absolute home directory.');
  const bound = { ...DEFAULTS };
  for (const key of Object.keys(bound)) if (Number.isSafeInteger(limits[key]) && limits[key] > 0) bound[key] = Math.min(limits[key], DEFAULTS[key]);
  // A bounded batch must contain enough bytes to distinguish an incomplete line from an overlong one.
  bound.batchBytes = Math.max(bound.batchBytes, bound.lineBytes + 1);
  let ownedSnapshots = null;
  const getSnapshots = () => snapshots ?? (ownedSnapshots ??= createSqliteSnapshots({ run }));
  const discovered = new Map();
  let closed = false;
  const providerPaths = {
    codex: [path.join(homeDir, '.codex', 'sessions'), path.join(homeDir, '.codex', 'archived_sessions')],
    claude: [path.join(homeDir, '.claude', 'projects')],
  };

  async function providerRoots(provider) {
    const roots = [];
    for (const lexical of providerPaths[provider] ?? []) {
      try { const real = await fs.realpath(lexical); if (!sealedPath(real)) roots.push({ lexical, real }); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return roots;
  }

  async function openSource(source, roots) {
    if (!absolute(source.file) || sealedPath(source.file) || !roots.some(root => inside(source.file, root.lexical))) throw new Error(safeWarning(source.provider));
    const real = await fs.realpath(source.file);
    if (sealedPath(real) || !roots.some(root => inside(real, root.real))) throw new Error(safeWarning(source.provider));
    // Never follow a final symlink, including one which happens to point back inside the allowed root.
    if ((await fs.lstat(source.file)).isSymbolicLink()) throw new Error(safeWarning(source.provider));
    const handle = await fs.open(real, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
    try {
      const stat = await handle.stat();
      const current = await fs.stat(real);
      if (!stat.isFile() || identity(current) !== identity(stat) || await fs.realpath(source.file) !== real) throw new Error(safeWarning(source.provider));
      return { handle, stat };
    } catch (error) { await handle.close(); throw error; }
  }

  async function projectRoots(repo) {
    const roots = [];
    for (const candidate of [repo?.path, ...(Array.isArray(repo?.places) ? repo.places.map(place => typeof place === 'string' ? place : place?.path) : [])]) {
      if (!absolute(candidate) || sealedPath(candidate)) continue;
      try { const real = await fs.realpath(candidate); if (!sealedPath(real) && !roots.includes(real)) roots.push(real); }
      catch { /* Missing roots cannot prove the scope of a newly read source. */ }
    }
    return roots;
  }

  async function scopedCwd(cwd, roots) {
    if (!absolute(cwd) || sealedPath(cwd)) return false;
    try { const real = await fs.realpath(cwd); return !sealedPath(real) && roots.some(root => inside(real, root)); }
    catch { return false; }
  }

  async function claudeMetadata(source, roots) {
    const { handle, stat } = await openSource(source, roots);
    try {
      let found = null;
      let metadataOnly = stat.size <= bound.metadataBytes;
      const ranges = [[0, Math.min(stat.size, bound.metadataBytes)]];
      if (stat.size > bound.metadataBytes) ranges.push([Math.max(0, stat.size - bound.metadataBytes), bound.metadataBytes]);
      for (const [offset, size] of ranges) {
        const bytes = await bytesAt(handle, offset, size);
        let from = offset > 0 ? bytes.indexOf(10) + 1 : 0;
        if (offset > 0 && from === 0) continue;
        for (; from < bytes.length;) {
          const end = bytes.indexOf(10, from);
          if (end < 0) { metadataOnly = false; break; }
          if (end - from <= bound.lineBytes) {
            try {
              const row = JSON.parse(bytes.toString('utf8', from, end));
              if (!CLAUDE_METADATA.has(row.type)) metadataOnly = false;
              if (['user', 'assistant'].includes(row.type) && row.isSidechain !== true && row.isMeta !== true
                && absolute(row.cwd) && (!row.sessionId || row.sessionId.toLowerCase() === source.sessionId)) {
                found = { cwd: row.cwd, desktop: typeof row.entrypoint === 'string' && row.entrypoint.startsWith('claude-desktop') };
              }
            } catch { metadataOnly = false; /* Unknown or incomplete lines do not provide source identity. */ }
          } else metadataOnly = false;
          from = end + 1;
        }
      }
      return found ?? (metadataOnly ? { empty: true } : null);
    } finally { await handle.close(); }
  }

  async function discover({ repo } = {}) {
    if (closed) throw new Error('Recovery sources are closed.');
    const sources = [], warnings = [];
    let truncated = false;
    const roots = await projectRoots(repo);
    if (!roots.length) return { sources, warnings: ['Recovery could not resolve this repository or its worktrees.'], truncated: true };
    const retain = async (source, provider) => {
      if (!(await scopedCwd(source.cwd, roots))) return;
      try {
        const opened = await openSource(source, provider);
        await opened.handle.close();
        if (sources.length >= bound.sources) { truncated = true; return; }
        discovered.set(sourceKey(source), { roots, provider, cwd: source.cwd, repoId: repo.id });
        sources.push(source);
      } catch { warnings.push(safeWarning(source.provider)); truncated = true; }
    };
    // Expire only this repository's capabilities. Other repositories may be processed by the same service.
    for (const [key, value] of discovered) if (value.repoId === repo.id) discovered.delete(key);
    try {
      const provider = await providerRoots('codex');
      const inventory = await discoverCodexWorkTranscripts({ homeDir, run, snapshots: getSnapshots(), maxSources: bound.sources });
      warnings.push(...inventory.warnings); truncated ||= inventory.truncated;
      for (const source of inventory.sources) await retain(source, provider);
    } catch { warnings.push('Codex recovery discovery failed.'); truncated = true; }
    try {
      const provider = await providerRoots('claude');
      const root = path.join(homeDir, '.claude', 'projects');
      const listing = await entries(root, bound.directories);
      truncated ||= listing.truncated;
      let checked = 0;
      outer: for (const dir of listing.entries) {
        if (!dir.isDirectory() || sealedPath(dir.name)) continue;
        const folder = path.join(root, dir.name);
        const real = await fs.realpath(folder);
        if (!provider.some(item => inside(real, item.real)) || sealedPath(real)) continue;
        const files = await entries(folder, bound.sources + 1);
        truncated ||= files.truncated;
        for (const file of files.entries) {
          const match = TRANSCRIPT.exec(file.name);
          if (!match || !UUID.test(match[1]) || !file.isFile()) continue;
          if (checked++ >= bound.sources) { truncated = true; break outer; }
          const id = match[1].toLowerCase();
          const source = { provider: 'claude', sessionId: id, sessionKey: `claude:terminal:${id}`, file: path.join(folder, file.name), cwd: null };
          try {
            const metadata = await claudeMetadata(source, provider);
            if (metadata?.empty) continue; // No conversation yet; a future discovery checks the file again.
            if (!metadata) { warnings.push('Some Claude recovery sources have no readable project metadata.'); truncated = true; continue; }
            source.cwd = metadata.cwd;
            await retain(source, provider);
          } catch { warnings.push(safeWarning('claude')); truncated = true; }
        }
      }
    } catch { warnings.push('Claude recovery discovery failed.'); truncated = true; }
    if (truncated) warnings.push('Recovery source discovery is incomplete; unchecked conversations have not been marked processed.');
    return { sources, warnings: [...new Set(warnings)], truncated };
  }

  async function anchorAt(handle, offset) {
    const start = Math.max(0, offset - 128);
    const bytes = await bytesAt(handle, start, offset - start);
    return { start, length: bytes.length, hash: hash(bytes) };
  }

  async function readBatch(source, previous, { baseline = false } = {}) {
    if (closed) throw new Error('Recovery sources are closed.');
    const scope = discovered.get(sourceKey(source));
    if (!scope || scope.cwd !== source.cwd || !(await scopedCwd(source.cwd, scope.roots))) throw new Error('Discover and verify this recovery source before reading it.');
    const { handle, stat } = await openSource(source, await providerRoots(source.provider));
    const warnings = [], events = [];
    try {
      let cursor = { offset: 0, identity: identity(stat), contextCwd: source.cwd };
      if (previous && Number.isSafeInteger(previous.offset) && previous.offset >= 0) {
        let valid = previous.identity === identity(stat) && previous.offset <= stat.size;
        if (valid && previous.size === stat.size && Number.isFinite(previous.mtimeMs) && previous.mtimeMs !== stat.mtimeMs) valid = false;
        if (valid && previous.anchor) {
          const actual = await anchorAt(handle, previous.offset);
          valid = actual.start === previous.anchor.start && actual.length === previous.anchor.length && actual.hash === previous.anchor.hash;
        }
        if (valid) {
          cursor = { offset: previous.offset, identity: identity(stat), contextCwd: absolute(previous.contextCwd) ? previous.contextCwd : null };
          if (previous.skipping === true) cursor.skipping = true;
          if (/^[0-9a-f]{64}$/.test(previous.lastUser?.digest ?? '') && validTime(previous.lastUser.at) !== null && ['event', 'response'].includes(previous.lastUser.kind)) {
            cursor.lastUser = { digest: previous.lastUser.digest, at: previous.lastUser.at, kind: previous.lastUser.kind };
          }
        }
        else warnings.push('A recovery source was replaced, shortened or rewritten; reading it again with duplicate protection.');
      }
      if (baseline) {
        const last = stat.size ? await bytesAt(handle, stat.size - 1, 1) : null;
        cursor = { offset: stat.size, identity: identity(stat), contextCwd: source.cwd, ...(last?.[0] !== 10 && stat.size ? { skipping: true } : {}) };
        cursor.size = stat.size; cursor.mtimeMs = stat.mtimeMs;
        cursor.anchor = await anchorAt(handle, cursor.offset);
        return { cursor, events, warnings, eof: true };
      }
      const initial = cursor.offset;
      const bytes = await bytesAt(handle, initial, Math.min(bound.batchBytes, stat.size - initial));
      let index = 0;
      let inspectedEnd = initial;
      while (index < bytes.length) {
        const nl = bytes.indexOf(10, index);
        if (cursor.skipping) {
          if (nl < 0) { cursor.offset = initial + bytes.length; inspectedEnd = cursor.offset; break; }
          index = nl + 1; cursor.offset = initial + index; delete cursor.skipping; continue;
        }
        if (nl < 0) {
          inspectedEnd = initial + bytes.length;
          if (bytes.length - index > bound.lineBytes) {
            cursor.offset = inspectedEnd; cursor.skipping = true;
            warnings.push('An overlong recovery transcript line was skipped; its conversation content was not captured.');
          }
          break; // Preserve an incomplete UTF-8/JSON line until its newline arrives.
        }
        const offset = initial + index, endOffset = initial + nl + 1;
        if (nl - index > bound.lineBytes) warnings.push('An overlong recovery transcript line was skipped; its conversation content was not captured.');
        else if (nl > index) {
          let row;
          try { row = JSON.parse(bytes.toString('utf8', index, nl)); }
          catch { warnings.push('An unreadable recovery transcript line was skipped.'); }
          if (row && typeof row === 'object') {
            let role = null, content = null, kind = null, uuid = null;
            if (source.provider === 'codex') {
              if (row.type === 'session_meta' || row.type === 'turn_context') cursor.contextCwd = absolute(row.payload?.cwd) ? row.payload.cwd : null;
              if (row.type === 'session_meta') {
                const declaredId = row.payload?.id ?? row.payload?.session_id;
                if (declaredId && (typeof declaredId !== 'string' || declaredId.toLowerCase() !== source.sessionId)) throw new Error('Recovery source session identity changed.');
              }
              if (row.type === 'event_msg' && row.payload?.type === 'user_message') { role = 'user'; content = row.payload.message; kind = 'event'; }
              if (row.type === 'response_item' && row.payload?.type === 'message') {
                const { role: messageRole, phase, channel } = row.payload;
                // Current Codex rollouts use phase=final_answer; older ones can explicitly say channel=final.
                // A missing channel alone also describes commentary, so it is never evidence of a final reply.
                const final = (phase === 'final_answer' || channel === 'final')
                  && (phase == null || phase === 'final_answer') && (channel == null || channel === 'final');
                if (messageRole === 'user' || (messageRole === 'assistant' && final)) {
                  role = messageRole; content = row.payload.content; kind = 'response';
                } else if (messageRole === 'assistant' && !['analysis', 'commentary'].includes(phase)
                  && !['analysis', 'commentary'].includes(channel) && conversationText(row.payload.content)) {
                  warnings.push('A Codex assistant message without a final reply marker was skipped.');
                }
              }
            } else if (['user', 'assistant'].includes(row.type) && !row.isSidechain && !row.isMeta && !row.isCompactSummary && !row.isApiErrorMessage) {
              if (row.sessionId && (typeof row.sessionId !== 'string' || row.sessionId.toLowerCase() !== source.sessionId)) throw new Error('Recovery source session identity changed.');
              const final = row.type === 'user' || ['end_turn', 'stop_sequence'].includes(row.message?.stop_reason);
              if (final) { role = row.type; content = row.message?.content; uuid = typeof row.uuid === 'string' ? row.uuid.slice(0, 200) : null; }
              else if (row.message?.stop_reason !== 'tool_use' && conversationText(row.message?.content)) warnings.push('A Claude assistant message without a final reply marker was skipped.');
              cursor.contextCwd = absolute(row.cwd) ? row.cwd : null;
            }
            if (['user', 'assistant'].includes(role) && await scopedCwd(cursor.contextCwd, scope.roots)) {
              const raw = rawText(content), text = conversationText(content), at = validTime(row.timestamp);
              if (text && at !== null) {
                const digest = hash(raw);
                const twin = source.provider === 'codex' && role === 'user' && cursor.lastUser?.digest === digest
                  && cursor.lastUser.kind !== kind && Math.abs(cursor.lastUser.at - at) < 2000;
                if (!twin) {
                  const record = uuid ? `uuid:${uuid}:${digest}` : `${role}:${at}:${digest}`;
                  events.push({ id: hash(`${source.provider}:${source.sessionId}:${record}`), role, text, at, offset, endOffset, cwd: cursor.contextCwd,
                    truncated: text.length >= CONTEXT_CHARS - 1 && raw.length > CONTEXT_CHARS });
                }
                if (source.provider === 'codex') {
                  if (role === 'user') cursor.lastUser = { digest, at, kind };
                  else delete cursor.lastUser;
                }
              } else if (text && at === null) warnings.push('A recovery message without a valid timestamp was skipped.');
            }
          }
        }
        index = nl + 1; cursor.offset = endOffset; inspectedEnd = endOffset;
      }
      cursor.anchor = await anchorAt(handle, cursor.offset);
      cursor.size = stat.size; cursor.mtimeMs = stat.mtimeMs;
      return { cursor, events, warnings: [...new Set(warnings)], eof: inspectedEnd >= stat.size };
    } finally { await handle.close(); }
  }

  return { discover, readBatch, async close() { closed = true; discovered.clear(); await ownedSnapshots?.close(); } };
}
