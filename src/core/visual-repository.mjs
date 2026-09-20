import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { GIT_ENV, gitArgs } from './git-scan.mjs';
import { classifyPath, hidePrivateText, redact, sealedPath } from './workstreams.mjs';

const DEFAULTS = { commits: 100, refs: 120, files: 2000, sourceFiles: 400, fileBytes: 128 * 1024, sourceBytes: 4 * 1024 * 1024, nodes: 100, edges: 400, timeout: 5000, budgetMs: 12000, maxBytes: 2 * 1024 * 1024 };
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/;
const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const SKIP_DIR = /^(?:vendor|third_party|third-party|vendors|\.git|\.claude|\.codex|\.cursor|\.worktrees|worktrees)$/i;
const NESTED = new Set(['src', 'apps', 'packages', 'services', 'libs', 'crates', 'backend', 'frontend']);
const byText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const validPath = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !UNSAFE.test(value) && !value.includes('\\') && !path.posix.isAbsolute(value) && value.split('/').every(part => part && part !== '.' && part !== '..');
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && !UNSAFE.test(value);
const within = (value, root) => value === root || value.startsWith(`${root}${path.sep}`);
const limited = limits => Object.fromEntries(Object.entries(DEFAULTS).map(([key, maximum]) => [key, Number.isFinite(limits?.[key]) ? Math.max(1, Math.min(maximum, Math.floor(limits[key]))) : maximum]));
const text = (value, privatePaths, length = 180) => redact(hidePrivateText(String(value ?? ''), privatePaths)).replace(new RegExp(UNSAFE.source, 'g'), ' ').replace(/\s+/g, ' ').trim().slice(0, length);

function message(error, fallback) {
  const detail = `${error?.message ?? ''} ${error?.stderr ?? ''}`;
  if (/timed out|time budget/i.test(detail)) return 'Repository scanning took too long. The view may be incomplete.';
  if (/exceeded the allowed size/i.test(detail)) return 'This repository exceeded the scan size limit.';
  if (/dubious ownership|safe\.directory/i.test(detail)) return 'Git does not trust this repository folder.';
  return fallback;
}

function safeEnvironment(env) {
  // Only process-location variables are useful for a read-only git invocation. Provider keys and inherited GIT_* never pass through.
  const result = {};
  for (const key of ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'PATH']) if (typeof env?.[key] === 'string') result[key] = env[key];
  return { ...result, ...GIT_ENV };
}

function allowed(file, privatePaths) {
  if (!validPath(file) || sealedPath(file) || file.split('/').some(part => SKIP_DIR.test(part))) return false;
  const cls = classifyPath(file, { privatePaths });
  return !cls.private && !cls.secret && !cls.generated && !cls.binary && !cls.data;
}

function component(file) {
  const dirs = file.split('/').slice(0, -1);
  return dirs.length ? dirs.slice(0, NESTED.has(dirs[0]) ? 2 : 1).join('/') : '.';
}

/** A small lexer, not a code evaluator. It omits comments, template bodies and regex literals before identifying import syntax. */
function imports(source) {
  const tokens = [];
  let cursor = 0;
  const expressionStart = () => !tokens.length || ['=', '(', '[', '{', ',', ':', ';', '!', '?', 'return', '=>'].includes(tokens.at(-1).value);
  while (cursor < source.length) {
    const ch = source[cursor];
    if (/\s/.test(ch)) { cursor++; continue; }
    if (ch === '/' && source[cursor + 1] === '/') { cursor = source.indexOf('\n', cursor + 2); if (cursor < 0) break; continue; }
    if (ch === '/' && source[cursor + 1] === '*') { const end = source.indexOf('*/', cursor + 2); if (end < 0) break; cursor = end + 2; continue; }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      let value = '', escaped = false, closed = false;
      cursor++;
      while (cursor < source.length) {
        const next = source[cursor++];
        if (next === '\\') { escaped = true; cursor++; continue; }
        if (next === quote) { closed = true; break; }
        value += next;
      }
      // Escape sequences and template expressions are deliberately unsupported; never guess their path.
      tokens.push({ kind: closed && !escaped && quote !== '`' ? 'string' : 'opaque', value: closed && !escaped && quote !== '`' ? value : '' });
      continue;
    }
    if (ch === '/' && expressionStart()) {
      let inClass = false;
      cursor++;
      while (cursor < source.length) {
        const next = source[cursor++];
        if (next === '\\') { cursor++; continue; }
        if (next === '[') inClass = true;
        if (next === ']') inClass = false;
        if (next === '/' && !inClass) break;
        if (next === '\n') break;
      }
      while (/[a-z]/i.test(source[cursor] || '0')) cursor++;
      tokens.push({ kind: 'opaque', value: '' });
      continue;
    }
    const identifier = /^[A-Za-z_$][\w$]*/.exec(source.slice(cursor));
    if (identifier) { tokens.push({ kind: 'word', value: identifier[0] }); cursor += identifier[0].length; }
    else { tokens.push({ kind: 'punctuation', value: ch }); cursor++; }
  }
  const found = new Set();
  const add = token => { if (token?.kind === 'string' && /^\.\.?\//.test(token.value)) found.add(token.value); };
  for (let index = 0; index < tokens.length; index++) {
    const current = tokens[index];
    if (current.kind !== 'word' || tokens[index - 1]?.value === '.') continue;
    if (current.value === 'require' && tokens[index + 1]?.value === '(' && tokens[index + 3]?.value === ')') add(tokens[index + 2]);
    if (current.value === 'import') {
      add(tokens[index + 1]);
      if (tokens[index + 1]?.value === '(' && [')', ','].includes(tokens[index + 3]?.value)) add(tokens[index + 2]);
    }
    if ((current.value === 'import' && !['(', '.'].includes(tokens[index + 1]?.value)) || current.value === 'export') {
      for (let end = index + 1; end < Math.min(tokens.length, index + 100); end++) {
        if ([';', '=', 'const', 'let', 'function', 'class'].includes(tokens[end].value)) break;
        if (tokens[end].kind === 'word' && tokens[end].value === 'from') { add(tokens[end + 1]); break; }
      }
    }
  }
  return [...found];
}

function resolveImport(file, specifier, files) {
  if (UNSAFE.test(specifier) || specifier.includes('\\') || specifier.includes('?') || specifier.includes('#')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
  if (!validPath(base)) return null;
  const candidates = [base];
  if (/\.[cm]?js$/i.test(base)) candidates.push(base.replace(/\.js$/i, '.ts').replace(/\.mjs$/i, '.mts').replace(/\.cjs$/i, '.cts'), base.replace(/\.js$/i, '.tsx'));
  if (!path.posix.extname(base)) for (const extension of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']) candidates.push(`${base}${extension}`, `${base}/index${extension}`);
  return candidates.find(candidate => files.has(candidate)) ?? null;
}

async function safeStat(root, file) {
  // Check every segment, not just the final file: a tracked directory may have been replaced by a symlink.
  let current = root;
  const pieces = file.split('/');
  for (let index = 0; index < pieces.length; index++) {
    current = path.join(current, pieces[index]);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || (index < pieces.length - 1 ? !stat.isDirectory() : !stat.isFile())) return null;
    if (index === pieces.length - 1) return stat;
  }
  return null;
}

async function readSource(root, file, stat, maxBytes) {
  let handle;
  try {
    const full = path.join(root, file);
    handle = await fs.open(full, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size > maxBytes) return null;
    if (!within(await fs.realpath(full), root) || !(await safeStat(root, file))) return null;
    const buffer = Buffer.alloc(opened.size);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== opened.size || buffer.includes(0)) return null;
    return buffer.toString('utf8');
  } finally { await handle?.close().catch(() => {}); }
}

async function history(g, lim, privatePaths, shallow) {
  const result = { commits: [], refs: [], truncated: shallow, error: null };
  try {
    const [rawRefs, head] = await Promise.all([
      g(['for-each-ref', `--count=${lim.refs + 1}`, '--sort=refname', '--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)', 'refs/heads', 'refs/remotes', 'refs/tags']),
      g(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).then(value => value.trim(), error => { if (error?.exitCode === 1) return null; throw error; })
    ]);
    const rows = rawRefs.trimEnd().split('\n').filter(Boolean);
    result.truncated ||= rows.length > lim.refs;
    for (const row of rows.slice(0, lim.refs)) {
      const [name, object, type, peeled, peeledType] = row.split('\0');
      const match = /^refs\/(heads|remotes|tags)\/(.+)$/.exec(name);
      const commitId = type === 'commit' ? object : peeledType === 'commit' ? peeled : null;
      if (!match || !OID.test(commitId || '') || UNSAFE.test(match[2])) continue;
      result.refs.push({ name: text(match[2], privatePaths), commitId, kind: { heads: 'branch', remotes: 'remote', tags: 'tag' }[match[1]] });
    }
    if (OID.test(head || '')) result.refs.push({ name: 'HEAD', commitId: head, kind: 'head' });
    const tips = [...new Set(result.refs.map(ref => ref.commitId))];
    if (!tips.length) return result;
    const raw = await g(['log', '--stdin', '--topo-order', `--max-count=${lim.commits + 1}`, '--no-decorate', '--no-show-signature', '--no-patch', '-z', '--format=%H%x1f%P%x1f%cI%x1f%s'], { input: `${tips.join('\n')}\n` });
    const records = raw.split('\0').filter(Boolean);
    result.truncated ||= records.length > lim.commits;
    for (const record of records.slice(0, lim.commits)) {
      const [id, parentText, at, ...subject] = record.split('\x1f');
      const parents = parentText?.split(' ').filter(Boolean) ?? [];
      if (!OID.test(id) || parents.some(parent => !OID.test(parent))) { result.truncated = true; continue; }
      result.commits.push({ id, parents, at: Number.isFinite(Date.parse(at)) ? new Date(at).toISOString() : null, subject: text(subject.join(' '), privatePaths) });
    }
  } catch (error) { result.error = message(error, 'Summon could not read the local commit graph.'); result.truncated = true; }
  return result;
}

async function codebase(g, root, repo, lim, privatePaths, deadline) {
  const result = { nodes: [], edges: [], truncated: false, error: null, note: null, mode: 'imports' };
  try {
    const raw = await g(['ls-files', '--cached', '--stage', '-z']);
    const entries = raw.split('\0').filter(Boolean);
    result.truncated = entries.length > lim.files;
    const candidates = new Set();
    for (const entry of entries.slice(0, lim.files)) {
      const match = /^(100644|100755) [0-9a-f]{40,64} 0\t([\s\S]+)$/.exec(entry);
      if (match && allowed(match[2], privatePaths)) candidates.add(match[2]);
    }
    const changed = new Set();
    const withheld = new Set();
    for (const place of Array.isArray(repo.places) ? repo.places.slice(0, 30) : []) {
      if (place.missing || place.path !== repo.path) continue;
      result.truncated ||= place.filesTruncated === true;
      for (const file of Array.isArray(place.files) ? place.files.slice(0, lim.files) : []) {
        if (file.private && validPath(file.path)) withheld.add(file.path);
        else if (!file.isDir && allowed(file.path, privatePaths)) changed.add(file.path);
      }
    }
    const files = new Map();
    const nodes = new Map();
    for (const file of [...candidates].filter(file => !withheld.has(file)).sort(byText)) {
      if (Date.now() >= deadline) { result.truncated = true; break; }
      let stat;
      try { stat = await safeStat(root, file); } catch (error) { if (error.code === 'ENOENT') stat = { missing: true }; else { result.truncated = true; continue; } }
      if (!stat) continue;
      const group = component(file);
      if (!nodes.has(group)) {
        if (nodes.size >= lim.nodes) { result.truncated = true; continue; }
        nodes.set(group, { id: group, label: group === '.' ? 'Repository root' : group, path: group, files: 0, changed: 0 });
      }
      const node = nodes.get(group);
      node.files++;
      if (changed.has(file)) node.changed++;
      files.set(file, { stat, group });
    }
    const edges = new Map();
    let sourceFiles = 0, sourceBytes = 0;
    for (const [file, { stat, group }] of files) {
      if (!SOURCE.test(file) || stat.missing) continue;
      if (sourceFiles >= lim.sourceFiles || Date.now() >= deadline) { result.truncated = true; break; }
      if (stat.size > lim.fileBytes || sourceBytes + stat.size > lim.sourceBytes) { result.truncated = true; continue; }
      sourceFiles++;
      sourceBytes += stat.size;
      let content;
      try { content = await readSource(root, file, stat, lim.fileBytes); } catch { result.truncated = true; continue; }
      if (content === null) { result.truncated = true; continue; }
      for (const specifier of imports(content)) {
        const targetFile = resolveImport(file, specifier, files);
        const target = targetFile && files.get(targetFile)?.group;
        if (!target || target === group) continue;
        const key = JSON.stringify([group, target]);
        if (!edges.has(key)) {
          if (edges.size >= lim.edges) { result.truncated = true; continue; }
          edges.set(key, { source: group, target, count: 0 });
        }
        edges.get(key).count++;
      }
    }
    result.nodes = [...nodes.values()];
    result.edges = [...edges.values()].sort((a, b) => byText(a.source, b.source) || byText(a.target, b.target));
    if (!result.edges.length) result.note = sourceFiles ? 'No relative JS/TS imports between these groups were found. Package aliases and other languages are not resolved.' : 'No readable tracked JS/TS source was found. File groups are shown without import connections.';
  } catch (error) { result.error = message(error, 'Summon could not read the local codebase map.'); result.truncated = true; }
  return result;
}

/** Bounded local evidence only: commit parents and tracked-file relative imports. Never runs code, filters, hooks, diffs or network commands. */
export async function scanVisualRepository({ repo, run, git = '/usr/bin/git', env = {}, privatePaths = [], limits = {} } = {}) {
  const result = { repoId: typeof repo?.id === 'string' ? repo.id : '', scannedAt: new Date().toISOString(), git: { commits: [], refs: [], truncated: false, error: null }, codebase: { nodes: [], edges: [], truncated: false, error: null, note: null, mode: 'imports' } };
  const lim = limited(limits);
  const deadline = Date.now() + lim.budgetMs;
  try {
    if (!absolute(repo?.path) || sealedPath(repo.path) || !absolute(git) || typeof run !== 'function') throw new Error('invalid');
    const root = await fs.realpath(repo.path);
    if (sealedPath(root) || !(await fs.lstat(root)).isDirectory()) throw new Error('invalid');
    // WifRepo points at the owning checkout. Reject borrowed/nested repositories before reading their history.
    if (!(await fs.lstat(path.join(root, '.git'))).isDirectory()) throw new Error('borrowed');
    for (const item of ['config', 'HEAD', 'index', 'shallow', 'objects', 'objects/info', 'objects/pack', 'refs', 'refs/heads', 'refs/remotes', 'refs/tags', 'packed-refs']) {
      try { if ((await fs.lstat(path.join(root, '.git', item))).isSymbolicLink()) throw new Error('borrowed'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    for (const item of ['commondir', 'objects/info/alternates', 'objects/info/http-alternates']) {
      try { await fs.lstat(path.join(root, '.git', item)); throw new Error('borrowed'); }
      catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    }
    const shallow = await fs.stat(path.join(root, '.git/shallow')).then(stat => stat.size > 0, () => false);
    const g = async (args, extra = {}) => {
      const timeout = Math.min(lim.timeout, deadline - Date.now());
      if (timeout <= 0) throw new Error('time budget');
      return (await run(git, gitArgs(root, args), { cwd: root, env: safeEnvironment(env), timeout, maxBytes: lim.maxBytes, ...extra })).stdout;
    };
    const [common, top] = (await g(['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'])).trimEnd().split('\n');
    if (top !== root || common !== path.join(root, '.git')) throw new Error('borrowed');
    [result.git, result.codebase] = await Promise.all([history(g, lim, privatePaths, shallow), codebase(g, root, repo, lim, privatePaths, deadline)]);
  } catch (error) {
    const description = message(error, 'This folder is unavailable or is not the owning repository checkout.');
    result.git.error = description;
    result.codebase.error = description;
  }
  return result;
}
