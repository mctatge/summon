import fs from 'node:fs/promises';
import { watch, watchFile, unwatchFile } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';

const VERSION = 1;
const MAX_FILES = 4000;
const MAX_EVENTS = 6000;
const JOURNAL_CHUNK = 4 * 1024 * 1024;
const COLORS = ['#aebdab', '#c2b29d', '#a8b8ca', '#c4acba', '#c9c097'];
const DEFAULTS = {
  paused: false, accessibilityEnabled: false, activityEnabled: true,
  retentionDays: 30, calendarUrl: '', whisperModel: '', handsFree: false,
  excludedApps: ['com.apple.keychainaccess', 'com.1password.1password', 'com.agilebits.onepassword7', 'com.bitwarden.desktop'],
};
const iso = () => new Date().toISOString();
const clone = value => structuredClone(value);
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const clean = (value, max = 300) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max) : '';
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0') && path.normalize(value) === value;
const inside = (candidate, root) => candidate === root || candidate.startsWith(`${root}${path.sep}`);
const idFor = value => createHash('sha256').update(value).digest('hex').slice(0, 16);
const ignoredName = name => name.startsWith('.') || name.startsWith('~$') || /\.(crdownload|download|part|partial|tmp|temp|icloud)$/i.test(name);
const webUrl = value => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; } catch { return undefined; } };
const sourceUrl = value => {
  const valid = webUrl(value);
  if (!valid) return undefined;
  const url = new URL(valid);
  url.search = ''; url.hash = '';
  return url.href;
};
const identity = stat => ({ device: String(stat.dev), inode: String(stat.ino), birthNs: String(stat.birthtimeNs), size: Number(stat.size), mtimeNs: String(stat.mtimeNs) });
const sameIdentity = (a, b) => a && b && a.device === b.device && a.inode === b.inode && (a.birthNs && b.birthNs ? a.birthNs === b.birthNs : a.size === b.size && a.mtimeNs === b.mtimeNs);
const validIdentity = value => value && /^\d+$/.test(value.device) && /^\d+$/.test(value.inode) && (!value.birthNs || /^\d+$/.test(value.birthNs)) && Number.isFinite(value.size) && /^\d+$/.test(value.mtimeNs);
const publicFile = record => { const { _identity, _filingState, _baseline, ...file } = record; return clone(file); };
const publicProject = record => { const { _origin, ...project } = record; return clone(project); };
const fileRecency = file => Math.max(...[file.filingAt, file.createdAt, file.modifiedAt, file._baseline ? undefined : file.firstSeenAt].map(value => validDate(value) ? Date.parse(value) : 0));

function normalizeSettings(patch, current = DEFAULTS) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Settings must be an object.');
  const next = clone(current);
  for (const [key, value] of Object.entries(patch)) {
    if (['paused', 'accessibilityEnabled', 'activityEnabled', 'handsFree'].includes(key)) {
      if (typeof value !== 'boolean') throw new Error(`${key} must be true or false.`);
      next[key] = value;
    } else if (key === 'retentionDays') {
      if (!Number.isInteger(value) || value < 1 || value > 365) throw new Error('Retention must be between 1 and 365 days.');
      next[key] = value;
    } else if (key === 'excludedApps') {
      if (!Array.isArray(value) || value.length > 100 || value.some(item => typeof item !== 'string' || item.length > 200)) throw new Error('App exclusions must be a list of app names or bundle IDs.');
      next[key] = [...new Set(value.map(item => item.trim()).filter(Boolean))];
    } else if (key === 'calendarUrl') {
      if (typeof value !== 'string' || (value && !webUrl(value))) throw new Error('Use an HTTP or HTTPS calendar address.');
      next[key] = value ? webUrl(value) : '';
    } else if (key === 'whisperModel') {
      if (typeof value !== 'string' || (value && !absolute(value))) throw new Error('Whisper model must be an absolute file path.');
      next[key] = value;
    } else throw new Error(`Unknown setting: ${key}`);
  }
  return next;
}

function validateState(value) {
  if (!value || value.version !== VERSION || !Array.isArray(value.files) || !Array.isArray(value.events) || !Array.isArray(value.projects) || !Array.isArray(value.receipts)) throw new Error('Unrecognized state schema.');
  normalizeSettings(value.settings);
  if (value.files.length > 100000 || value.events.length > 100000 || value.projects.length > 2000 || value.receipts.length > 100000) throw new Error('State exceeds supported limits.');
  const projectIds = new Set();
  for (const p of value.projects) {
    if (typeof p.id !== 'string' || projectIds.has(p.id) || !p.name || !absolute(p.path) || typeof p.color !== 'string') throw new Error('Invalid workspace record.');
    projectIds.add(p.id);
  }
  if (value.currentProjectId !== null && !projectIds.has(value.currentProjectId)) throw new Error('Invalid selected workspace.');
  const fileIds = new Set();
  for (const f of value.files) {
    if (typeof f.id !== 'string' || fileIds.has(f.id) || !absolute(f.path) || (f.originalPath && !absolute(f.originalPath)) || !validIdentity(f._identity) || !validDate(f.firstSeenAt) || !validDate(f.lastSeenAt) || typeof f.name !== 'string' || typeof f.extension !== 'string' || !Number.isFinite(f.size) || !['present', 'missing', 'unconfirmed', 'filed', 'waiting'].includes(f.status) || ![null, 'selected', 'inferred', 'corrected'].includes(f.projectSource) || (f.projectId !== null && !projectIds.has(f.projectId))) throw new Error('Invalid file record.');
    fileIds.add(f.id);
  }
  if (value.events.some(e => typeof e.id !== 'string' || !validDate(e.at) || typeof e.title !== 'string' || typeof e.type !== 'string')) throw new Error('Invalid activity record.');
  if (value.receipts.some(r => typeof r.id !== 'string' || typeof r.fileId !== 'string' || !validDate(r.at))) throw new Error('Invalid filing record.');
  if (value.journal && (!Number.isSafeInteger(value.journal.offset) || value.journal.offset < 0 || typeof value.journal.identity !== 'string')) throw new Error('Invalid journal cursor.');
  return value;
}

/** Local metadata service. Never moves files, reads file contents, or scans repositories. */
export async function createCompanion({ dataDir, homeDir = os.homedir(), emit = () => {}, metadata, watchEvents = watch } = {}) {
  if (!absolute(dataDir) || !absolute(homeDir)) throw new Error('Data and home directories must be absolute.');
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  dataDir = await fs.realpath(dataDir);
  homeDir = await fs.realpath(homeDir);
  const statePath = path.join(dataDir, 'state.json');
  const filingDir = path.join(homeDir, 'Library', 'Application Support', 'Automatic Filing');
  const configPath = path.join(filingDir, 'config.json');
  const journalPath = path.join(filingDir, 'state', 'moves.jsonl');
  const intake = [path.join(homeDir, 'Downloads'), path.join(homeDir, 'Desktop')];
  let destinations = [];
  let destinationProjects = [];
  let state = { version: VERSION, projects: [], currentProjectId: null, activity: null, files: [], events: [], settings: clone(DEFAULTS), receipts: [], journal: null, baselineAt: null };
  const health = { watching: false, accessibility: false, native: false, whisper: false, errors: [], lastScanAt: null };
  const report = message => { if (!health.errors.includes(message)) health.errors = [...health.errors.slice(-11), clean(message, 600)]; };
  const pendingSaveErrors = new Set();
  const reportedWatcherMessages = new Set();
  const watchFailures = new Map();
  const folderReadErrors = new Map();
  const reportedAccessMessages = new Set();
  const inspectionDenied = new Set();
  const accessMessage = (dir, error) => ['EPERM', 'EACCES'].includes(error.code) ? `Folder access needed: ${dir} (${error.code}). Allow Summon in macOS Files and Folders.` : `Cannot read folder ${dir}: ${error.code || error.message}`;
  const updateAccessHealth = () => {
    health.errors = health.errors.filter(message => !reportedAccessMessages.has(message));
    reportedAccessMessages.clear();
    for (const message of folderReadErrors.values()) { const safe = clean(message, 600); reportedAccessMessages.add(safe); report(safe); }
  };
  try {
    const stat = await fs.lstat(statePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('State must be a regular file.');
    state = validateState(JSON.parse(await fs.readFile(statePath, 'utf8')));
    state.settings = normalizeSettings(state.settings);
    state.baselineAt ||= state.files.length ? iso() : null;
    for (const file of state.files) {
      const source = sourceUrl(file.sourceUrl);
      if (source) file.sourceUrl = source;
      else delete file.sourceUrl;
    }
    // Session context is deliberately transient; a restart must not claim an old app is active.
    state.activity = null;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      const quarantine = `${statePath}.corrupt-${Date.now()}-${randomUUID().slice(0, 6)}`;
      await fs.rename(statePath, quarantine);
      report(`Saved state could not be read; preserved as ${path.basename(quarantine)}. ${error.message}`);
    }
  }
  let running = false;
  let queue = Promise.resolve();
  let debounce;
  let interval;
  const watchers = new Map();
  const enqueue = fn => { const result = queue.then(fn); queue = result.catch(() => {}); return result; };
  const snapshot = () => ({ version: VERSION, projects: state.projects.map(publicProject), currentProjectId: state.currentProjectId, activity: clone(state.activity), files: [...state.files].sort((a, b) => fileRecency(b) - fileRecency(a)).map(publicFile), events: clone(state.events).reverse().sort((a, b) => b.at.localeCompare(a.at)), settings: clone(state.settings), health: clone(health), dataDir });
  const notify = () => { try { emit(snapshot()); } catch (error) { report(`Update listener failed: ${error.message}`); } };
  const event = ({ type, title, detail, fileId, projectId, at = iso() }) => {
    const row = { id: randomUUID(), at, type: clean(type, 80), title: clean(title, 300) };
    if (detail) row.detail = clean(detail, 2000);
    if (fileId) row.fileId = fileId;
    if (projectId !== undefined) row.projectId = projectId;
    state.events.push(row);
  };
  const trim = () => {
    const cutoff = Date.now() - state.settings.retentionDays * 86400000;
    state.events = state.events.filter(e => Date.parse(e.at) >= cutoff).slice(-MAX_EVENTS);
    // Files still observed in a watched folder stay discoverable. Missing records expire.
    state.files = state.files.filter(f => Date.parse(f.lastSeenAt) >= cutoff).sort((a, b) => a.lastSeenAt.localeCompare(b.lastSeenAt)).slice(-MAX_FILES);
    const liveIds = new Set(state.files.map(f => f.id));
    state.receipts = state.receipts.filter(r => Date.parse(r.at) >= cutoff || liveIds.has(r.fileId)).slice(-12000);
    if (state.activity && Date.parse(state.activity.at) < cutoff) state.activity = null;
  };
  const save = async () => {
    trim();
    const tmp = path.join(dataDir, `.state-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(tmp, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
      await handle.sync();
      await handle.close(); handle = undefined;
      await fs.rename(tmp, statePath);
      const dir = await fs.open(dataDir, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
      // Clear only failures from our own completed write attempts, including an
      // identical message surfaced by the startup caller. Other errors stay visible.
      health.errors = health.errors.filter(message => !pendingSaveErrors.has(message));
      pendingSaveErrors.clear();
    } catch (error) {
      const message = clean(`Could not save local history: ${error.message}`, 600);
      pendingSaveErrors.add(message);
      pendingSaveErrors.add(clean(error.message, 600));
      report(message);
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(tmp).catch(() => {});
      throw error;
    }
  };
  const project = id => {
    if (id === null) return null;
    const found = state.projects.find(p => p.id === id);
    if (!found) throw new Error('Unknown workspace.');
    return found;
  };
  const infer = (filePath, name = path.basename(filePath)) => {
    const byPath = state.projects.filter(p => inside(filePath, p.path)).sort((a, b) => b.path.length - a.path.length)[0];
    if (byPath) return { projectId: byPath.id, projectSource: 'inferred', reason: `Located inside ${byPath.name}.` };
    const destination = destinationProjects.filter(item => inside(filePath, item.root)).sort((a, b) => b.root.length - a.root.length)[0];
    if (destination) return { projectId: destination.projectId, projectSource: 'inferred', reason: `Located in the filing destination for ${project(destination.projectId).name}.` };
    const normalized = name.toLocaleLowerCase();
    const matches = state.projects.filter(p => p.name.length >= 3 && new RegExp(`(?:^|[^\\p{L}\\p{N}])${p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(normalized));
    if (matches.length === 1) return { projectId: matches[0].id, projectSource: 'inferred', reason: `Filename mentions ${matches[0].name}; this is a suggestion.` };
    return { projectId: null, projectSource: null };
  };
  const pathAllowed = filePath => absolute(filePath) && (intake.some(root => path.dirname(filePath) === root) || destinations.some(root => inside(filePath, root)));
  const safeDirectory = async dir => {
    if (!absolute(dir)) return false;
    try { const info = await fs.lstat(dir); return info.isDirectory() && !info.isSymbolicLink() && await fs.realpath(dir) === dir; } catch { return false; }
  };
  const inspect = async filePath => {
    if (!pathAllowed(filePath) || ignoredName(path.basename(filePath))) return null;
    try {
      const stat = await fs.lstat(filePath, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || await fs.realpath(filePath) !== filePath) return null;
      inspectionDenied.delete(filePath);
      return { path: filePath, identity: identity(stat), createdAt: new Date(Number(stat.birthtimeNs) / 1e6).toISOString(), modifiedAt: new Date(Number(stat.mtimeNs) / 1e6).toISOString() };
    } catch (error) {
      if (['EPERM', 'EACCES'].includes(error.code)) { inspectionDenied.add(filePath); folderReadErrors.set(path.dirname(filePath), accessMessage(path.dirname(filePath), error)); }
      else { inspectionDenied.delete(filePath); if (!['ENOENT', 'ENOTDIR'].includes(error.code)) report(`Cannot inspect ${filePath}: ${error.code || error.message}`); }
      return null;
    }
  };
  const refreshConfiguration = async () => {
    try {
      if (await fs.realpath(configPath) !== configPath) throw new Error('Symlinked filing configuration is not supported.');
      const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
      const entries = Object.entries(config.destinations || {}).filter(([, target]) => absolute(target) && inside(target, homeDir) && target !== homeDir);
      destinations = [...new Set(entries.map(([, target]) => target))];
      destinationProjects = [];
      for (const [key, target] of entries) {
        const tags = config.finder_tags?.destinations?.[key];
        if (!Array.isArray(tags) || !tags.includes('Projects')) continue;
        const name = tags.find(tag => typeof tag === 'string' && tag !== 'Projects');
        if (!name) continue;
        let matching = state.projects.find(p => p.name.toLocaleLowerCase() === name.toLocaleLowerCase());
        if (!matching) {
          matching = { id: `project-${idFor(target)}`, name: clean(name, 100), path: target, color: COLORS[state.projects.length % COLORS.length], _origin: 'filing' };
          state.projects.push(matching);
        }
        destinationProjects.push({ root: target, projectId: matching.id });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') report(`Cannot read Automatic Filing configuration: ${error.message}`);
    }
  };
  const receiptRow = raw => {
    if (!raw || !['moved', 'undo_completed'].includes(raw.event) || typeof raw.id !== 'string' || raw.id.length > 200 || !raw.before || !Number.isFinite(raw.time)) return null;
    if (!pathAllowed(raw.source) || !pathAllowed(raw.destination)) return null;
    if (raw.event === 'moved' && (!intake.some(root => path.dirname(raw.source) === root) || !destinations.some(root => inside(raw.destination, root)))) return null;
    if (raw.event === 'undo_completed' && (!intake.some(root => path.dirname(raw.destination) === root) || !destinations.some(root => inside(raw.source, root)) || typeof raw.undo_of !== 'string')) return null;
    const before = { device: String(raw.before.device), inode: String(raw.before.inode), size: raw.before.size, mtimeNs: String(raw.before.mtime_ns) };
    // Python JSON emits nanosecond integers beyond JS's safe integer range. Preserve
    // their original digits during parse below, and never infer identity by filename.
    if (raw.before.birthtime_ns) before.birthNs = String(raw.before.birthtime_ns);
    if (!validIdentity(before)) return null;
    const at = new Date(raw.time * 1000).toISOString();
    if (Date.parse(at) < Date.now() - state.settings.retentionDays * 86400000 || Date.parse(at) > Date.now() + 86400000) return null;
    return { ...raw, before, at };
  };
  const readReceipts = async () => {
    let handle;
    try {
      if (await fs.realpath(journalPath) !== journalPath) throw new Error('Symlinked filing journal is not supported.');
      handle = await fs.open(journalPath, 'r');
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('Filing journal is not a regular file.');
      const key = `${stat.dev}:${stat.ino}`;
      let offset = state.journal?.identity === key && state.journal.offset <= stat.size ? state.journal.offset : 0;
      const length = Math.min(stat.size - offset, JOURNAL_CHUNK);
      if (!length) return [];
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      const end = buffer.lastIndexOf(10, bytesRead - 1);
      if (end < 0) { if (bytesRead === JOURNAL_CHUNK) report('Automatic Filing journal has an oversized line; import is waiting for a valid record.'); return []; }
      const seen = new Set(state.receipts.map(row => row.id));
      const rows = [];
      for (const line of buffer.subarray(0, end).toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const raw = JSON.parse(line.replace(/("(?:mtime_ns|birthtime_ns)"\s*:\s*)(\d+)/g, '$1"$2"'));
          const row = receiptRow(raw);
          if (row && !seen.has(row.id)) { seen.add(row.id); rows.push(row); }
        } catch { report('Skipped a malformed Automatic Filing journal entry.'); }
      }
      state.journal = { identity: key, offset: offset + end + 1 };
      return rows;
    } catch (error) {
      if (error.code !== 'ENOENT') report(`Cannot read Automatic Filing history: ${error.message}`);
      return [];
    } finally { if (handle) await handle.close(); }
  };
  const knownDirectories = rows => new Set([
    ...intake, ...destinations,
    ...state.files.filter(f => pathAllowed(f.path)).map(f => path.dirname(f.path)),
    ...state.files.filter(f => f.originalPath && pathAllowed(f.originalPath)).map(f => path.dirname(f.originalPath)),
    ...rows.flatMap(r => [path.dirname(r.source), path.dirname(r.destination)]),
  ]);
  const gather = async dirs => {
    const found = [];
    for (const dir of dirs) {
      try {
        const stat = await fs.lstat(dir);
        if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(dir) !== dir) continue;
        const entries = await fs.readdir(dir, { withFileTypes: true });
        folderReadErrors.delete(dir);
        for (const entry of entries) {
          if (!entry.isFile() || ignoredName(entry.name)) continue;
          const file = await inspect(path.join(dir, entry.name));
          if (file) found.push(file);
        }
      } catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes(error.code)) folderReadErrors.delete(dir);
        else folderReadErrors.set(dir, accessMessage(dir, error));
      }
    }
    updateAccessHealth();
    return found;
  };
  const synchronizeWatchers = async dirs => {
    if (!running || state.settings.paused) { for (const watcher of watchers.values()) watcher.close(); watchers.clear(); watchFailures.clear(); updateWatcherHealth(); return; }
    dirs.add(path.dirname(journalPath));
    dirs.add(filingDir);
    for (const [dir, watcher] of watchers) if (!dirs.has(dir)) { watcher.close(); watchers.delete(dir); }
    for (const dir of watchFailures.keys()) if (!dirs.has(dir)) watchFailures.delete(dir);
    for (const dir of dirs) {
      const current = watchers.get(dir);
      if (folderReadErrors.has(dir)) { current?.close(); watchers.delete(dir); continue; }
      if (current?.mode === 'polling' && Date.now() >= current.retryAt) { current.close(); watchers.delete(dir); }
      if (watchers.has(dir) || !await safeDirectory(dir)) continue;
      const changed = () => {
          clearTimeout(debounce);
          debounce = setTimeout(() => { service.scan().catch(error => { report(error.message); notify(); }); }, 450);
          debounce.unref?.();
      };
      const pollingFallback = async error => {
        if (!running || state.settings.paused) return;
        if (!['EMFILE', 'ENFILE', 'ENOSPC', 'EPERM', 'EACCES'].includes(error.code)) {
          watchFailures.set(dir, `Cannot watch ${dir}: ${error.code || error.message}`);
          updateWatcherHealth(); notify(); return;
        }
        // macOS can reject an FSEvents subscription while ordinary directory reads
        // still work. Verify access before offering polling as a working fallback.
        try { await fs.readdir(dir); folderReadErrors.delete(dir); updateAccessHealth(); } catch (readError) {
          folderReadErrors.set(dir, accessMessage(dir, readError));
          updateAccessHealth(); updateWatcherHealth(); notify(); return;
        }
        if (!running || state.settings.paused) return;
        const listener = (current, previous) => { if (current.mtimeMs !== previous.mtimeMs || current.ino !== previous.ino) changed(); };
        try {
          watchFile(dir, { persistent: false, interval: 2000 }, listener);
          watchers.set(dir, { mode: 'polling', reason: error.code, retryAt: Date.now() + 60000, close: () => unwatchFile(dir, listener) });
          watchFailures.delete(dir);
        } catch (pollError) { watchFailures.set(dir, `Cannot watch ${dir}: ${pollError.code || pollError.message}`); }
        updateWatcherHealth();
        notify();
      };
      try {
        const watcher = watchEvents(dir, { persistent: false }, changed);
        watcher.mode = 'events';
        watcher.on('error', error => { watcher.close(); watchers.delete(dir); pollingFallback(error).catch(failure => { watchFailures.set(dir, `Cannot watch ${dir}: ${failure.message}`); updateWatcherHealth(); notify(); }); });
        watchers.set(dir, watcher);
        watchFailures.delete(dir);
      } catch (error) { await pollingFallback(error); }
    }
    updateWatcherHealth();
  };
  function updateWatcherHealth() {
    health.errors = health.errors.filter(message => !reportedWatcherMessages.has(message));
    reportedWatcherMessages.clear();
    const polling = [...watchers.values()].filter(watcher => watcher.mode === 'polling');
    const messages = [...watchFailures.values()];
    if (polling.length) messages.push(`Native folder events unavailable (${[...new Set(polling.map(watcher => watcher.reason))].sort().join(', ')}); checking metadata for ${polling.length} ${polling.length === 1 ? 'folder' : 'folders'} every 2 seconds. Native events retry each minute.`);
    for (const message of messages) { const safe = clean(message, 600); reportedWatcherMessages.add(safe); report(safe); }
    health.watching = running && !state.settings.paused && intake.some(dir => watchers.has(dir) && !folderReadErrors.has(dir));
  }
  const metadataFor = async file => {
    if (!metadata) return;
    try {
      const result = await Promise.race([metadata(file.path), new Promise(resolve => { const timer = setTimeout(() => resolve(null), 1500); timer.unref?.(); })]);
      const source = sourceUrl(result?.sourceUrl);
      if (source) file.sourceUrl = source;
    } catch { /* Missing extended attributes are normal. File contents are never read. */ }
  };
  const liveStatus = file => file._filingState === 'filed' && destinations.some(root => inside(file.path, root)) ? 'filed' : file._filingState === 'undone' ? 'present' : intake.some(root => path.dirname(file.path) === root) ? 'waiting' : 'present';
  const observe = async (entry, announce = true, { baseline = false } = {}) => {
    let file = state.files.find(f => sameIdentity(f._identity, entry.identity));
    const now = iso();
    if (!file) {
      const suggestion = infer(entry.path);
      const selected = !baseline && state.currentProjectId && project(state.currentProjectId);
      file = { id: randomUUID(), name: path.basename(entry.path), path: entry.path, extension: path.extname(entry.path).slice(1).toLowerCase(), size: entry.identity.size, firstSeenAt: now, lastSeenAt: now, createdAt: entry.createdAt, modifiedAt: entry.modifiedAt, ...(selected && intake.some(root => path.dirname(entry.path) === root) ? { projectId: selected.id, projectSource: 'selected', reason: `${selected.name} was selected when this file was first observed.` } : suggestion), status: intake.some(root => path.dirname(entry.path) === root) ? 'waiting' : 'present', _identity: entry.identity, _baseline: baseline };
      state.files.push(file);
      await metadataFor(file);
      if (announce) event({ type: 'file-found', title: `Found ${file.name}`, detail: file.path, fileId: file.id, projectId: file.projectId });
    } else {
      if (file.path !== entry.path) {
        // If an inode has several hard links, retain the existing location when it is valid.
        const old = await inspect(file.path);
        if (!old || !sameIdentity(old.identity, file._identity)) {
          const previous = file.path;
          file.originalPath ||= previous;
          file.path = entry.path;
          file.name = path.basename(entry.path);
          file.extension = path.extname(entry.path).slice(1).toLowerCase();
          event({ type: 'file-location', title: `${file.name} changed location`, detail: `${previous} → ${file.path}`, fileId: file.id, projectId: file.projectId });
        }
      }
      file.size = entry.identity.size;
      file.createdAt = entry.createdAt; file.modifiedAt = entry.modifiedAt;
      file._identity = entry.identity;
      file.lastSeenAt = now;
      file.status = liveStatus(file);
    }
    delete file.accessIssue;
    return file;
  };
  const matchesReceipt = (id, before) => sameIdentity(id, before) && (before.birthNs || (id.size === before.size && id.mtimeNs === before.mtimeNs));
  const importReceipt = async (row, observed) => {
    const prior = row.undo_of && state.receipts.find(r => r.id === row.undo_of);
    let file = prior && state.files.find(f => f.id === prior.fileId && sameIdentity(f._identity, row.before));
    file ||= state.files.find(f => matchesReceipt(f._identity, row.before));
    if (!file) {
      const current = observed.find(entry => matchesReceipt(entry.identity, row.before));
      if (current) file = await observe(current, false);
      else {
        file = { id: randomUUID(), name: path.basename(row.destination), path: row.destination, originalPath: row.source, extension: path.extname(row.destination).slice(1).toLowerCase(), size: row.before.size, firstSeenAt: row.at, lastSeenAt: row.at, ...infer(row.destination), status: 'missing', _identity: row.before };
        state.files.push(file);
      }
    }
    file.originalPath ||= row.event === 'undo_completed' ? row.destination : row.source;
    if (row.at < file.firstSeenAt) file.firstSeenAt = row.at;
    file.filingAt = row.at;
    file._filingState = row.event === 'undo_completed' ? 'undone' : 'filed';
    const current = observed.find(entry => entry.path === row.destination && matchesReceipt(entry.identity, row.before));
    if (current) {
      file.path = current.path; file.name = path.basename(current.path); file.extension = path.extname(current.path).slice(1).toLowerCase(); file._identity = current.identity; file.size = current.identity.size;
    }
    const live = observed.some(entry => entry.path === file.path && sameIdentity(entry.identity, file._identity));
    file.status = live ? row.event === 'undo_completed' ? 'present' : 'filed' : 'missing';
    if (![ 'corrected', 'selected' ].includes(file.projectSource)) {
      const inferred = infer(row.event === 'undo_completed' ? row.source : row.destination);
      if (inferred.projectId) Object.assign(file, inferred);
    }
    const receiptDetail = row.event === 'undo_completed' ? `Automatic Filing returned it from ${row.source} to ${row.destination}.` : `Automatic Filing moved it from ${row.source} to ${row.destination}.`;
    // Keep a correction's reason intact; provenance is separately preserved in the event.
    if (file.projectSource !== 'corrected') file.reason = `${receiptDetail}${file.reason ? ` ${file.reason}` : ''}`.slice(0, 2000);
    state.receipts.push({ id: row.id, at: row.at, fileId: file.id, ...(row.undo_of ? { undoOf: row.undo_of } : {}) });
    event({ type: row.event === 'undo_completed' ? 'filing-undone' : 'file-filed', title: row.event === 'undo_completed' ? `${file.name} returned to intake` : `${file.name} was filed`, detail: receiptDetail, fileId: file.id, projectId: file.projectId, at: row.at });
  };
  const scanInternal = async () => {
    if (state.settings.paused) return snapshot();
    await refreshConfiguration();
    const rows = await readReceipts();
    const dirs = knownDirectories(rows);
    const observed = await gather(dirs);
    const baseline = !state.baselineAt;
    // Baseline imports are useful for immediate file lookup, but do not claim that
    // preexisting files just downloaded or belong to today's selected project.
    for (const entry of observed) await observe(entry, true, { baseline });
    for (const row of rows) await importReceipt(row, observed);
    for (const file of state.files) {
      if (observed.some(entry => entry.path === file.path && sameIdentity(entry.identity, file._identity))) continue;
      if (folderReadErrors.has(path.dirname(file.path)) || inspectionDenied.has(file.path)) {
        file.status = 'unconfirmed';
        file.accessIssue = folderReadErrors.get(path.dirname(file.path)) || `Access to ${file.path} is unavailable; its current location is unconfirmed.`;
        continue;
      }
      const current = await inspect(file.path);
      if (inspectionDenied.has(file.path)) {
        file.status = 'unconfirmed'; file.accessIssue = folderReadErrors.get(path.dirname(file.path)); continue;
      }
      if (!current || !sameIdentity(current.identity, file._identity)) {
        if (file.status !== 'missing') event({ type: 'file-missing', title: `Location unconfirmed: ${file.name}`, detail: `Last seen at ${file.path}. Searches cover Downloads, Desktop, and known filing folders.`, fileId: file.id });
        file.status = 'missing'; delete file.accessIssue;
      }
    }
    updateAccessHealth();
    health.lastScanAt = iso();
    state.baselineAt ||= health.lastScanAt;
    await synchronizeWatchers(knownDirectories([]));
    await save(); notify();
    return snapshot();
  };
  const service = {
    snapshot,
    scan: () => enqueue(scanInternal),
    start: () => enqueue(async () => {
      if (!running) {
        running = true;
        interval = setInterval(() => { service.scan().catch(error => { report(error.message); notify(); }); }, 60000);
        interval.unref?.();
      }
      return scanInternal();
    }),
    stop: () => enqueue(async () => {
      running = false; clearInterval(interval); clearTimeout(debounce);
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear(); watchFailures.clear(); updateWatcherHealth();
      await save();
    }),
    selectProject: id => enqueue(async () => {
      const selected = project(id);
      state.currentProjectId = selected?.id || null;
      event({ type: 'project-selected', title: selected ? `Working on ${selected.name}` : 'Working context cleared', projectId: selected?.id || null });
      await save(); notify(); return snapshot();
    }),
    correctFile: (id, projectId) => enqueue(async () => {
      const file = state.files.find(f => f.id === id);
      if (!file) throw new Error('Unknown file.');
      const selected = project(projectId);
      file.projectId = selected?.id || null; file.projectSource = 'corrected';
      file.reason = selected ? `You assigned this file to ${selected.name}.` : 'You removed the workspace assignment.';
      event({ type: 'file-corrected', title: `Updated context for ${file.name}`, detail: file.reason, fileId: file.id, projectId: file.projectId });
      await save(); notify(); return snapshot();
    }),
    addProject: ({ name, path: folder }) => enqueue(async () => {
      name = clean(name, 100).trim();
      if (!name || !absolute(folder)) throw new Error('Choose a named workspace folder.');
      const canonical = await fs.realpath(folder);
      if (!(await fs.stat(canonical)).isDirectory()) throw new Error('Workspace must be a folder.');
      const existing = state.projects.find(p => p.path === canonical);
      const imported = state.projects.find(p => p._origin === 'filing' && p.name.toLocaleLowerCase() === name.toLocaleLowerCase());
      if (!existing && imported) {
        imported.path = canonical; imported._origin = 'user';
        event({ type: 'project-added', title: `Connected ${name} workspace`, detail: canonical });
      } else if (!existing) {
        state.projects.push({ id: `project-${idFor(canonical)}`, name, path: canonical, color: COLORS[state.projects.length % COLORS.length] });
        event({ type: 'project-added', title: `Added ${name}`, detail: canonical });
      }
      await save(); notify(); return snapshot();
    }),
    updateSettings: patch => enqueue(async () => {
      const oldPaused = state.settings.paused;
      state.settings = normalizeSettings(patch, state.settings);
      if (state.settings.paused || !state.settings.activityEnabled || (state.activity && excluded(state.activity))) state.activity = null;
      if (state.activity && !state.settings.accessibilityEnabled) {
        const { app, bundleId, at } = state.activity;
        state.activity = { app, bundleId, at };
      }
      if (oldPaused !== state.settings.paused) event({ type: 'collection', title: state.settings.paused ? 'Context collection paused' : 'Context collection resumed' });
      await synchronizeWatchers(knownDirectories([]));
      await save(); notify();
      if (oldPaused && !state.settings.paused) return scanInternal();
      return snapshot();
    }),
    ingestActivity: input => enqueue(async () => {
      if (state.settings.paused || !state.settings.activityEnabled || !input || typeof input.app !== 'string' || typeof input.bundleId !== 'string') return snapshot();
      if (excluded(input) || input.bundleId === 'com.summon.companion') {
        if (excluded(input) && state.activity) { state.activity = null; await save(); notify(); }
        return snapshot();
      }
      const activity = { app: clean(input.app, 100), bundleId: clean(input.bundleId, 200), at: validDate(input.at) ? input.at : iso() };
      if (state.settings.accessibilityEnabled) {
        if (input.title) activity.title = clean(input.title, 300);
        if (absolute(input.documentPath)) activity.documentPath = input.documentPath;
      }
      const suggestion = activity.documentPath ? infer(activity.documentPath) : activity.title ? infer('', activity.title) : {};
      if (suggestion.projectId) { activity.suggestedProjectId = suggestion.projectId; activity.reason = suggestion.reason; }
      const previous = state.activity;
      state.activity = activity;
      if (!previous || previous.bundleId !== activity.bundleId || previous.title !== activity.title || previous.documentPath !== activity.documentPath) event({ type: 'app-active', title: `Using ${activity.app}`, detail: activity.title || undefined, projectId: activity.suggestedProjectId });
      await save(); notify(); return snapshot();
    }),
    clearActivity: () => enqueue(async () => {
      if (state.activity) { state.activity = null; await save(); notify(); }
      return snapshot();
    }),
    getFile: id => enqueue(async () => {
      const file = state.files.find(f => f.id === id);
      if (!file) throw new Error('Unknown file.');
      let current = await inspect(file.path);
      if (!current || !sameIdentity(current.identity, file._identity)) {
        // An explicit open request may resolve this one known identity while paused.
        const known = await gather(knownDirectories([]));
        current = known.find(entry => sameIdentity(entry.identity, file._identity));
        if (current) await observe(current, false);
      }
      if (!current || !sameIdentity(current.identity, file._identity)) {
        if (folderReadErrors.has(path.dirname(file.path)) || inspectionDenied.has(file.path)) {
          file.status = 'unconfirmed'; file.accessIssue = folderReadErrors.get(path.dirname(file.path)) || `Access to ${file.path} is unavailable; its current location is unconfirmed.`;
          updateAccessHealth(); await save(); notify(); throw new Error(file.accessIssue);
        }
        file.status = 'missing'; delete file.accessIssue; await save(); notify(); throw new Error('This file is no longer at a confirmed location. It may have moved outside the watched folders.');
      }
      delete file.accessIssue;
      file._identity = current.identity; file.size = current.identity.size; file.createdAt = current.createdAt; file.modifiedAt = current.modifiedAt; file.lastSeenAt = iso(); file.status = liveStatus(file);
      await save(); notify(); return publicFile(file);
    }),
    searchFiles: query => {
      // Dictation includes sentence punctuation. Strip boundary periods while
      // retaining internal filename extensions such as Forecast.xlsx.
      const terms = (clean(String(query || ''), 500).toLocaleLowerCase().match(/[\p{L}\p{N}._-]+/gu) || []).map(term => term.replace(/^\.+|\.+$/g, '')).filter(Boolean);
      const stops = new Set(['where', 'did', 'my', 'the', 'a', 'an', 'go', 'find', 'file', 'files', 'open', 'show', 'pull', 'up', 'recent', 'latest', 'last', 'please', 'that', 'is', 'me', 'download', 'downloaded', 'downloads', 'workbook', 'workbooks', 'what', 'happened', 'to', 'it', 'from', 'in', 'on', 'get', 'can', 'you', 'could', 'would', 'locate', 'bring', 's', 'i', 'just']);
      const important = terms.filter(word => !stops.has(word));
      const aliases = { excel: ['xlsx', 'xls', 'xlsm', 'xlsb', 'csv'], spreadsheet: ['xlsx', 'xls', 'xlsm', 'xlsb', 'csv', 'ods'], spreadsheets: ['xlsx', 'xls', 'xlsm', 'xlsb', 'csv', 'ods'], pdf: ['pdf'], presentation: ['ppt', 'pptx', 'key'], word: ['doc', 'docx', 'rtf'] };
      if (terms.some(term => ['workbook', 'workbooks'].includes(term)) && !important.some(term => aliases[term])) important.push('excel');
      return state.files.map(file => {
        const projectName = state.projects.find(p => p.id === file.projectId)?.name || '';
        const haystack = `${file.name} ${file.path} ${projectName} ${file.sourceUrl || ''}`.toLocaleLowerCase();
        let score = 0;
        for (const term of important) {
          if (aliases[term] ? aliases[term].includes(file.extension) : haystack.includes(term)) score += file.name.toLocaleLowerCase().includes(term) ? 4 : 2;
          else return null;
        }
        if (state.currentProjectId && file.projectId === state.currentProjectId) score += 0.25;
        return { file, score };
      }).filter(Boolean).sort((a, b) => b.score - a.score || fileRecency(b.file) - fileRecency(a.file)).slice(0, 80).map(({ file }) => publicFile(file));
    },
    addEvent: input => enqueue(async () => { event(input); await save(); notify(); }),
    setHealth: patch => {
      for (const key of ['watching', 'accessibility', 'native', 'whisper']) if (typeof patch[key] === 'boolean') health[key] = patch[key];
      if (Array.isArray(patch.resolved)) { const gone = new Set(patch.resolved.map(message => clean(message, 600))); health.errors = health.errors.filter(message => !gone.has(message)); }
      if (Array.isArray(patch.errors)) for (const error of patch.errors) if (typeof error === 'string') report(error);
      notify();
    },
  };
  function excluded(input) { return state.settings.excludedApps.some(item => [input.app, input.bundleId].some(value => typeof value === 'string' && value.toLocaleLowerCase() === item.toLocaleLowerCase())); }
  await refreshConfiguration();
  trim();
  return service;
}
