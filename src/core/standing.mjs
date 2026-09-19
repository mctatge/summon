import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const VERSION = 1;
// The ledger is written compactly and holds only scan metrics, never a copy of the work itself. Keep it that way:
// indentation nobody reads spent more than half the old budget, and the sample ring is what paid for it, one
// dropped sample at a time, until spinning, blocked and rot had too little history left to fire at all.
const LIMITS = { stateBytes: 524288, repos: 40, places: 20, samples: 12, streams: 10, sketch: 16, subjects: 5, subjectChars: 80, landedOids: 50, firstSeen: 400, branchTips: 25, rail: 5, notes: 8 };
const MATCH = 0.5;
// minSampleMs keeps the ring a record of time passing rather than of how often the panel asked. spinMinMs makes the
// spinning claim honest whatever the sampling rate: three scans five seconds apart are not forty minutes of nothing.
const DEFAULTS = { stillDays: 7, spinSamples: 3, blockSamples: 2, rotDays: 14, minSampleMs: 300000, spinMinMs: 900000 };
const DAY = 86400000;
// Watermarks set in one look differ by seconds; anything wider is two looks and cannot share one date.
const AGREED = 60000;
const NO_HISTORY = 'Summon starts counting from now.';
const REWRITTEN = 'History was rewritten here, so Summon is not counting what landed.';

const iso = ms => new Date(ms).toISOString();
const sha1 = value => createHash('sha1').update(value).digest('hex');
const clone = value => structuredClone(value);
const listOf = value => Array.isArray(value) ? value : [];
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0');
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const count = value => Number.isSafeInteger(value) && value > 0 ? value : 0;
const numberOrNull = value => Number.isFinite(value) ? value : null;
const signature = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
// Ledger text comes from repositories: drop control and bidirectional-override characters before it reaches any surface.
const clean = (value, max = 200) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max) : '';
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const startOfDay = value => { const day = new Date(value); day.setHours(0, 0, 0, 0); return day.getTime(); };

/**
 * How long a stretch lasted, in the largest unit that keeps it readable: "44 minutes", "6 hours", "9 days".
 * Minutes past a couple of hours stop meaning anything to a person, and a folder can sit unchanged for weeks.
 */
export function spanText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 120) return plural(minutes, 'minute');
  const hours = Math.round(ms / 3600000);
  return hours < 48 ? plural(hours, 'hour') : plural(Math.max(2, Math.round(ms / DAY)), 'day');
}

/** "Harbor and AutoCine", "Harbor, AutoCine and Brawl Draft", "Harbor and 4 others". */
export function listText(names, max = 3) {
  const all = listOf(names).filter(name => typeof name === 'string' && name);
  const shown = all.slice(0, max);
  const rest = all.length - shown.length;
  if (rest > 0) return `${shown.join(', ')} and ${rest === 1 ? '1 other' : `${rest} others`}`;
  if (shown.length <= 1) return shown[0] || '';
  return `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`;
}

/** "today at 4pm", "yesterday at 4:05pm", "Tuesday at 4pm", "September 5". Plain, local, never a raw timestamp. */
export function whenText(ms, nowMs) {
  if (!Number.isFinite(ms) || !Number.isFinite(nowMs)) return null;
  const then = new Date(ms);
  const time = then.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(':00', '').replace(/\s+/g, '').toLowerCase();
  const days = Math.round((startOfDay(nowMs) - startOfDay(ms)) / DAY);
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `yesterday at ${time}`;
  if (days > 1 && days < 7) return `${then.toLocaleDateString('en-US', { weekday: 'long' })} at ${time}`;
  return then.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
}

/**
 * A stream's signature: the sorted list of files it holds, hashed. Workstream ids and titles are rewritten by every
 * grouping, so they cannot carry identity across time; the set of files can.
 */
export function streamSignature(files) {
  const list = [...new Set(listOf(files).filter(file => typeof file === 'string' && file))].sort();
  return list.length ? sha1(list.join('\n')).slice(0, 12) : null;
}

/** The smallest file hashes of a set, so two file sets can be compared later without keeping either list. */
export function sketchOf(files, k = LIMITS.sketch) {
  const list = [...new Set(listOf(files).filter(file => typeof file === 'string' && file))].map(file => sha1(file).slice(0, 8)).sort();
  return { size: list.length, hashes: list.slice(0, Math.max(1, k)) };
}

/** How much two sketched file sets overlap, 0 to 1. Exact while both sets fit in their sketch, estimated above that. */
export function jaccard(a, b) {
  const left = listOf(a?.hashes).filter(item => typeof item === 'string');
  const right = listOf(b?.hashes).filter(item => typeof item === 'string');
  if (!left.length || !right.length) return 0;
  const inLeft = new Set(left);
  const inRight = new Set(right);
  if (count(a.size) <= left.length && count(b.size) <= right.length) {
    const both = left.filter(item => inRight.has(item)).length;
    const union = new Set([...left, ...right]).size;
    return union ? both / union : 0;
  }
  // Bottom-k estimate: among the smallest hashes either side knows about, how many are on both sides.
  const k = Math.min(left.length, right.length);
  const union = [...new Set([...left, ...right])].sort().slice(0, k);
  return union.filter(item => inLeft.has(item) && inRight.has(item)).length / k;
}

/**
 * Carries each stream's identity from the previous scan to this one, greedily, best pair first, one to one.
 * Without it a regroup reads as "every stream is new and every old one is gone", which is the same shape as a broken ledger.
 */
export function matchStreams(previous, current, threshold = MATCH) {
  const before = listOf(previous);
  const after = listOf(current);
  const pairs = [];
  before.forEach((prev, i) => after.forEach((cur, j) => {
    const score = prev?.sig && cur?.sig && prev.sig === cur.sig ? 1 : jaccard(prev?.sketch, cur?.sketch);
    if (score >= threshold) pairs.push({ i, j, score });
  }));
  pairs.sort((a, b) => b.score - a.score || String(before[a.i]?.key).localeCompare(String(before[b.i]?.key)) || a.j - b.j);
  const takenPrev = new Set();
  const takenCur = new Set();
  const keys = new Array(after.length).fill(null);
  for (const pair of pairs) {
    if (takenPrev.has(pair.i) || takenCur.has(pair.j)) continue;
    takenPrev.add(pair.i);
    takenCur.add(pair.j);
    keys[pair.j] = before[pair.i].key;
  }
  return { keys, gone: before.filter((_, i) => !takenPrev.has(i)) };
}

function validStreams(value) {
  return listOf(value).slice(0, LIMITS.streams).filter(item => isObject(item) && typeof item.key === 'string' && item.key.length <= 20 && isObject(item.sketch))
    .map(item => ({
      key: item.key, sig: typeof item.sig === 'string' ? item.sig.slice(0, 20) : null,
      readiness: typeof item.readiness === 'string' ? item.readiness.slice(0, 20) : null,
      sketch: { size: count(item.sketch.size), hashes: listOf(item.sketch.hashes).filter(hash => typeof hash === 'string' && hash.length <= 16).slice(0, LIMITS.sketch) },
    }));
}

function validSamples(value) {
  return listOf(value).filter(item => isObject(item) && validDate(item.at) && typeof item.fingerprint === 'string' && item.fingerprint.length <= 200).slice(-LIMITS.samples)
    .map(item => ({
      at: item.at, fingerprint: item.fingerprint, oid: typeof item.oid === 'string' && item.oid.length <= 64 ? item.oid : null,
      items: count(item.items), added: count(item.added), removed: count(item.removed), conflicted: count(item.conflicted), paths: count(item.paths),
      aheadOfBase: numberOrNull(item.aheadOfBase), behindBase: numberOrNull(item.behindBase), working: count(item.working),
      lastCommitAt: validDate(item.lastCommitAt) ? item.lastCommitAt : null,
      streamSigs: listOf(item.streamSigs).filter(sig => typeof sig === 'string' && sig.length <= 20).slice(0, LIMITS.streams),
    }));
}

function validLanded(value) {
  if (!isObject(value) || typeof value.from !== 'string' || typeof value.to !== 'string') return null;
  return {
    from: value.from.slice(0, 64), to: value.to.slice(0, 64), count: count(value.count), more: Boolean(value.more), rewritten: Boolean(value.rewritten),
    // Which filter produced this text. A record made under rules that no longer apply is recomputed, never replayed.
    filter: typeof value.filter === 'string' ? value.filter.slice(0, 20) : null,
    // The commits counted, short. Two folders in one project often reach the same ones, and a total should say three.
    oids: listOf(value.oids).filter(item => typeof item === 'string' && /^[0-9a-f]{4,64}$/.test(item)).slice(0, LIMITS.landedOids).map(item => item.slice(0, 12)),
    subjects: listOf(value.subjects).filter(item => typeof item === 'string').slice(0, LIMITS.subjects).map(item => clean(item, LIMITS.subjectChars)).filter(Boolean),
  };
}

function validTips(value) {
  const tips = {};
  for (const [name, tip] of Object.entries(isObject(value) ? value : {}).slice(0, LIMITS.branchTips)) {
    if (typeof tip === 'string' && tip.length <= 64) tips[String(name).slice(0, 200)] = tip;
  }
  return tips;
}

function validSeen(value) {
  if (!isObject(value) || !validDate(value.at)) return null;
  const perPlace = {};
  for (const [placeId, entry] of Object.entries(isObject(value.perPlace) ? value.perPlace : {}).slice(0, LIMITS.places)) {
    if (!isObject(entry) || typeof entry.fingerprint !== 'string' || entry.fingerprint.length > 200) continue;
    const readiness = {};
    for (const [key, word] of Object.entries(isObject(entry.readiness) ? entry.readiness : {}).slice(0, LIMITS.streams)) {
      if (typeof word === 'string') readiness[String(key).slice(0, 20)] = word.slice(0, 20);
    }
    perPlace[placeId] = {
      fingerprint: entry.fingerprint, oid: typeof entry.oid === 'string' && entry.oid.length <= 64 ? entry.oid : null,
      streamSigs: listOf(entry.streamSigs).filter(sig => typeof sig === 'string' && sig.length <= 20).slice(0, LIMITS.streams), readiness,
    };
  }
  return { at: value.at, perPlace, branchTips: validTips(value.branchTips) };
}

function validState(value) {
  if (!isObject(value) || value.version !== VERSION) throw new Error('Unrecognized standing schema.');
  if (!isObject(value.repos)) throw new Error('Invalid saved standing.');
  const repos = {};
  for (const [repoId, entry] of Object.entries(value.repos)) {
    if (typeof repoId !== 'string' || repoId.length > 200 || !isObject(entry)) continue;
    const places = {};
    for (const [placeId, place] of Object.entries(isObject(entry.places) ? entry.places : {})) {
      if (typeof placeId !== 'string' || placeId.length > 200 || !isObject(place)) continue;
      places[placeId] = { label: clean(place.label, 120), streams: validStreams(place.streams), samples: validSamples(place.samples), landed: validLanded(place.landed) };
    }
    const firstSeenAt = {};
    for (const [key, at] of Object.entries(isObject(entry.firstSeenAt) ? entry.firstSeenAt : {}).slice(0, LIMITS.firstSeen)) {
      if (Number.isFinite(at)) firstSeenAt[String(key).slice(0, 20)] = at;
    }
    repos[repoId] = { name: clean(entry.name, 120), at: validDate(entry.at) ? entry.at : null, seen: validSeen(entry.seen), firstSeenAt, tips: validTips(entry.tips), places };
  }
  return { version: VERSION, repos };
}

const emptyDelta = () => ({ moved: false, landed: 0, landedMore: false, landedSubjects: [], landedOids: [], rewritten: false, streamsSaved: 0, streamsDropped: 0, streamsReady: 0, since: null, notes: [], lines: [] });

function railEntry(kind, place, repo, { at, days, minutes, why, confidence }) {
  return {
    kind, repoId: repo.repoId, repoName: repo.repoName, placeId: place.placeId, placeLabel: place.label,
    since: Number.isFinite(at) ? iso(at) : null, days: Number.isFinite(days) ? days : null, minutes: Number.isFinite(minutes) ? minutes : null,
    // confidence is the vocabulary the rest of Summon uses; inferred is the flag the panel reads to mark a guess.
    why, confidence, inferred: confidence === 'inferred', fingerprint: place.fingerprint,
  };
}

/** How long the newest run of identical fingerprints has lasted, and how many scans it covers. */
function runOf(samples, fingerprint) {
  let index = samples.length - 1;
  while (index >= 0 && samples[index].fingerprint === fingerprint) index -= 1;
  const run = samples.slice(index + 1);
  return { run, length: run.length, startedAt: run.length ? Date.parse(run[0].at) : null };
}

function sentencesFor({ sinceAt, sinceNewest, toldFrom, toldTo, nowMs, moved, movedIds, landed, landedMore, rewrittenRepos, streamsReady, notMoving }) {
  if (!Number.isFinite(sinceAt)) return NO_HISTORY;
  /* A date may only be given to a sentence every project it speaks for was read at. The counts are each measured
     against their own project's watermark, and the panel moves those one project at a time, so a single date over
     a spread of watermarks attaches a number measured over minutes to a day weeks old. "Since X, A and B moved"
     claims something only about the projects that contributed, so the contributors' span dates it; "Nothing has
     moved since X" quantifies over every project read, so only the full span will do. */
  const dateOf = (from, to) => Number.isFinite(from) && Number.isFinite(to) && to - from <= AGREED ? whenText(from, nowMs) : null;
  const since = (moved.length ? dateOf(toldFrom, toldTo) : dateOf(sinceAt, sinceNewest)) ?? 'you last looked';
  const first = moved.length ? `Since ${since}, ${listText(moved)} moved.` : `Nothing has moved since ${since}.`;
  const clauses = [];
  // The count is capped, and the folder's own bullet already says so, so the paragraph says it too rather than
  // printing a floor as an exact figure.
  if (landed > 0) clauses.push(`${plural(landed, 'save')}${landedMore ? ' or more' : ''} landed`);
  if (streamsReady > 0) clauses.push(`${plural(streamsReady, 'piece')} of work ${streamsReady === 1 ? 'is' : 'are'} now ready to save`);
  let second = clauses.length ? `${clauses.join(' and ')}.` : '';
  if (!second && rewrittenRepos.length) second = `History was rewritten in ${listText(rewrittenRepos)}, so Summon is not counting saves there.`;
  if (second) second = `${second.charAt(0).toUpperCase()}${second.slice(1)}`;
  // The paragraph is plain text with no room for a marker, and the panel holds it for the life of one look, so it
  // can only close on something that was counted. A guess belongs on the rail, marked and dropping with its evidence.
  const top = notMoving.find(entry => !entry.inferred) ?? null;
  // The rail is one row per folder while moved is one name per project, so a project can be in both. Name the folder
  // when it is, or this sentence says a project has not changed right after the first sentence says it moved.
  const name = clean(top?.repoName, 120);
  const folder = name && movedIds.has(top.repoId) ? clean(String(top.placeLabel ?? '').split(' \u00b7 ')[0], 60) : '';
  const who = folder ? `${name}'s ${folder}` : name;
  const third = !top ? ''
    : top.kind === 'spinning' ? `${who} has an agent working without changing a file.`
      : top.kind === 'blocked' ? `${who} is waiting on a decision about conflicting edits.`
        : Number.isFinite(top.days) ? `${who} has not changed in ${plural(top.days, 'day')}.`
          : `${who} has not changed.`;
  return [first, second, third].filter(Boolean).join(' ');
}

/**
 * Where work stands: a small ledger of past scans plus the plain deltas against a watermark the person sets by looking.
 * Records nothing but scan metrics and file-set hashes. Never reads a repository and never calls a model.
 */
export async function createStanding({ dataDir, now = () => Date.now(), limits = {}, settings = {} } = {}) {
  if (!absolute(dataDir)) throw new Error('Standing needs a full data folder path.');
  const limit = { ...LIMITS, ...limits };
  const tuning = { ...DEFAULTS, ...settings };
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  dataDir = await fs.realpath(dataDir);
  const filename = path.join(dataDir, 'standing.json');
  let state = { version: VERSION, repos: {} };
  let fileSignature = null;
  let problems = [];
  let queue = Promise.resolve();
  let closing = false;
  const enqueue = fn => { const result = queue.then(fn); queue = result.catch(() => {}); return result; };
  const problem = message => { const text = clean(message, 400); if (text && !problems.includes(text)) problems = [...problems.slice(-5), text]; };

  async function readState() {
    let stat;
    try { stat = await fs.lstat(filename, { bigint: true }); } catch (error) {
      // No ledger yet is the ordinary first run: it means "no history yet", not a problem worth showing.
      if (error.code === 'ENOENT') { fileSignature = null; state = { version: VERSION, repos: {} }; return; }
      state = { version: VERSION, repos: {} };
      fileSignature = null;
      problem(`Could not read where work stands: ${error.message}`);
      return;
    }
    if (signature(stat) === fileSignature) return;
    try {
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > BigInt(limit.stateBytes * 4)) throw new Error('It must be a regular file.');
      state = validState(JSON.parse(await fs.readFile(filename, 'utf8')));
      fileSignature = signature(stat);
      problems = problems.filter(message => !message.startsWith('Could not read where work stands:'));
    } catch (error) {
      // Fail closed to "no history yet": keep the file for recovery and start counting again.
      const quarantine = `${filename}.corrupt-${Date.now()}-${randomUUID().slice(0, 6)}`;
      const kept = await fs.rename(filename, quarantine).then(() => true, () => false);
      state = { version: VERSION, repos: {} };
      fileSignature = null;
      problem(`Could not read where work stands${kept ? ` (kept as ${path.basename(quarantine)})` : ''}. Summon starts counting from now. ${error.message}`);
    }
  }

  function prune() {
    const byAge = Object.entries(state.repos).sort((a, b) => String(b[1].at ?? '').localeCompare(String(a[1].at ?? '')));
    state.repos = Object.fromEntries(byAge.slice(0, limit.repos));
    for (const repo of Object.values(state.repos)) {
      const places = Object.entries(repo.places).sort((a, b) => String(b[1].samples.at(-1)?.at ?? '').localeCompare(String(a[1].samples.at(-1)?.at ?? '')));
      repo.places = Object.fromEntries(places.slice(0, limit.places));
      const live = new Set([...Object.values(repo.places).flatMap(place => place.streams.map(stream => stream.key)), ...Object.values(repo.seen?.perPlace ?? {}).flatMap(entry => entry.streamSigs)]);
      repo.firstSeenAt = Object.fromEntries(Object.entries(repo.firstSeenAt).filter(([key]) => live.has(key)).slice(0, limit.firstSeen));
    }
  }
  function dropOldest() {
    const entries = Object.entries(state.repos);
    if (!entries.length) return false;
    // Trim history before dropping a repository: an older sample is worth less than a repository's watermark.
    let longest = null;
    for (const [, repo] of entries) for (const place of Object.values(repo.places)) if (place.samples.length > 1 && (!longest || place.samples.length > longest.samples.length)) longest = place;
    if (longest) { longest.samples = longest.samples.slice(1); return true; }
    const oldest = entries.sort((a, b) => String(a[1].at ?? '').localeCompare(String(b[1].at ?? '')))[0];
    delete state.repos[oldest[0]];
    return true;
  }
  async function save() {
    prune();
    let contents = `${JSON.stringify(state)}\n`;
    while (Buffer.byteLength(contents) > limit.stateBytes && dropOldest()) contents = `${JSON.stringify(state)}\n`;
    const tmp = path.join(dataDir, `.standing-${randomUUID()}.tmp`);
    let handle;
    try {
      if (Buffer.byteLength(contents) > limit.stateBytes) throw new Error('Storage limit reached.');
      handle = await fs.open(tmp, 'wx', 0o600);
      await handle.writeFile(contents); await handle.sync(); await handle.close(); handle = null;
      await fs.rename(tmp, filename);
      const dir = await fs.open(dataDir, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
      fileSignature = signature(await fs.lstat(filename, { bigint: true }));
      problems = problems.filter(message => !message.startsWith('Could not save where work stands:'));
    } catch (error) {
      problem(`Could not save where work stands: ${error.message}`);
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(tmp).catch(() => {});
    }
  }

  const repoEntry = (observation, at) => {
    const entry = state.repos[observation.repoId] ||= { name: '', at: null, seen: null, firstSeenAt: {}, tips: {}, places: {} };
    entry.name = clean(observation.repoName, 120) || entry.name;
    entry.at = at;
    return entry;
  };

  /** One folder: carry stream identity forward, write the next sample, and say what changed since the watermark. */
  async function placePass(observation, place, repo, nowMs, landedFor) {
    const stored = repo.places[place.placeId] ?? { label: '', streams: [], samples: [], landed: null };
    const current = listOf(place.streams).slice(0, limit.streams).map(stream => ({ sig: streamSignature(stream.files), sketch: sketchOf(stream.files, limit.sketch), readiness: typeof stream.readiness === 'string' ? stream.readiness : null }));
    const { keys } = matchStreams(stored.streams, current);
    const streams = current.map((stream, index) => ({ key: keys[index] ?? stream.sig ?? `ws-${index}`, sig: stream.sig, readiness: stream.readiness, sketch: stream.sketch }));
    const firstSeenAt = { ...repo.firstSeenAt };
    for (const stream of streams) if (!Number.isFinite(firstSeenAt[stream.key])) firstSeenAt[stream.key] = nowMs;
    const sample = {
      at: iso(nowMs), fingerprint: place.fingerprint, oid: place.oid ?? null, items: count(place.items), added: count(place.added), removed: count(place.removed),
      conflicted: count(place.conflicted), paths: count(place.paths), aheadOfBase: numberOrNull(place.aheadOfBase), behindBase: numberOrNull(place.behindBase),
      working: count(place.working), lastCommitAt: validDate(place.lastCommitAt) ? place.lastCommitAt : null, streamSigs: streams.map(stream => stream.key),
    };
    // A new sample only when the folder actually changed, or enough time passed. Reading the panel is not an event.
    const previous = stored.samples.at(-1);
    const fresh = !previous || previous.fingerprint !== place.fingerprint || nowMs - Date.parse(previous.at) >= tuning.minSampleMs;
    const samples = fresh ? [...stored.samples, sample].slice(-limit.samples) : stored.samples;
    const sameStreams = stored.streams.length === streams.length
      && stored.streams.every((item, index) => item.key === streams[index].key && item.sig === streams[index].sig && item.readiness === streams[index].readiness);
    const seen = repo.seen?.perPlace?.[place.placeId] ?? null;
    const delta = emptyDelta();
    let landed = stored.landed;
    if (seen) {
      delta.moved = seen.fingerprint !== place.fingerprint;
      // A stored record is repository text that some filter produced once. Only the caller knows which filter that
      // was and whether it is still current, so hand it back rather than trusting the commit range alone. Anything
      // not usable right now is dropped, so the ledger stops carrying text it will never show.
      const keptLanded = landed && landed.from === seen.oid && landed.to === place.oid ? landed : null;
      if (delta.moved && seen.oid && place.oid && seen.oid !== place.oid) {
        landed = typeof landedFor === 'function'
          ? validLanded(await landedFor({ repoId: observation.repoId, placeId: place.placeId, placePath: place.path, from: seen.oid, to: place.oid, stored: keptLanded }))
          : keptLanded;
      } else landed = null;
      const usable = landed && landed.from === seen.oid && landed.to === place.oid ? landed : null;
      if (usable) {
        delta.landed = usable.count;
        delta.landedMore = usable.more;
        delta.landedSubjects = [...usable.subjects];
        delta.landedOids = [...usable.oids];
        delta.rewritten = usable.rewritten;
      }
      const live = new Set(streams.map(stream => stream.key));
      const closed = seen.streamSigs.filter(key => !live.has(key)).length;
      // Saved against dropped needs the folder to have really moved and the count to be known. Known means the commit
      // did not move, or the log read came back with a number; an unknown or rewritten count is not evidence of a loss.
      const counted = seen.oid === place.oid || Boolean(usable && !usable.rewritten);
      // A stream that is gone while commits landed here was saved; gone with nothing landed means it was dropped.
      if (closed && delta.moved && counted) { if (delta.landed > 0) delta.streamsSaved = closed; else delta.streamsDropped = closed; }
      // Readiness is the grouping model's word. Once the folder has moved past the grouping it was read from, that
      // word is about files that are no longer there, so nothing is claimed until a grouping looks at what is there now.
      if (!place.staleGrouping) delta.streamsReady = streams.filter(stream => stream.readiness === 'ready' && seen.readiness[stream.key] !== 'ready').length;
    }
    const nextStreams = streams.map(stream => ({ key: stream.key, sig: stream.sig, readiness: stream.readiness, sketch: stream.sketch }));
    const dirty = fresh || !sameStreams || landed !== stored.landed;
    return { placeId: place.placeId, next: { label: clean(place.label, 120), streams: nextStreams, samples, landed }, firstSeenAt, delta, samples, seen, dirty };
  }

  function railFor(observation, place, pass, nowMs, seenAt) {
    const out = [];
    const { samples } = pass;
    const { run, length, startedAt } = runOf(samples, place.fingerprint);
    const watermark = pass.seen && pass.seen.fingerprint === place.fingerprint && validDate(seenAt) ? Date.parse(seenAt) : null;
    const from = Number.isFinite(watermark) ? Math.min(watermark, startedAt ?? watermark) : startedAt;
    const days = Number.isFinite(from) ? Math.floor((nowMs - from) / DAY) : null;
    const items = count(place.items);
    const repo = { repoId: observation.repoId, repoName: observation.repoName };
    const target = { placeId: place.placeId, label: clean(place.label, 120), fingerprint: place.fingerprint };
    if (items > 0 && Number.isFinite(days) && days >= tuning.stillDays) {
      out.push(railEntry('still', target, repo, { at: from, days, why: `No file here has changed in ${plural(days, 'day')}.`, confidence: 'reported' }));
    }
    if (items > 0 && length >= tuning.spinSamples && count(place.working) > 0 && Number.isFinite(startedAt) && nowMs - startedAt >= tuning.spinMinMs) {
      const minutes = Math.max(1, Math.round((nowMs - startedAt) / 60000));
      // What the evidence says is that nothing here has changed for that long and that an agent is in the folder now.
      // How long the agent itself has been at it is not something this ledger knows, so the sentence does not claim it.
      out.push(railEntry('spinning', target, repo, { at: startedAt, days, minutes, why: `An agent is working here and no file has changed in ${spanText(nowMs - startedAt)}.`, confidence: 'inferred' }));
    }
    const blocking = samples.slice(-tuning.blockSamples);
    if (count(place.conflicted) > 0 && blocking.length >= tuning.blockSamples && blocking.every(item => item.conflicted > 0)) {
      out.push(railEntry('blocked', target, repo, { at: Date.parse(blocking[0].at), days, why: `Conflicting edits have been waiting through ${plural(blocking.length, 'check')}.`, confidence: 'reported' }));
    }
    const oldest = run[0] ?? samples[0];
    const newest = samples.at(-1);
    const lastCommit = validDate(newest?.lastCommitAt) ? Date.parse(newest.lastCommitAt) : null;
    const commitDays = Number.isFinite(lastCommit) ? Math.floor((nowMs - lastCommit) / DAY) : null;
    if (samples.length >= 2 && oldest && newest && Number.isFinite(newest.behindBase) && Number.isFinite(oldest.behindBase) && newest.behindBase > oldest.behindBase
      && newest.aheadOfBase === oldest.aheadOfBase && Number.isFinite(commitDays) && commitDays >= tuning.rotDays) {
      out.push(railEntry('rot', target, repo, { at: lastCommit, days: commitDays, why: `The main line moved ahead while this stayed put, and the last save here was ${plural(commitDays, 'day')} ago.`, confidence: 'inferred' }));
    }
    return out;
  }

  /**
   * One folder's part of the "Since you last looked" block. Every note says which folder it came from and what that
   * folder looked like at the time, so the panel can drop a guess the moment its evidence changes.
   */
  function notesFor(placeId, label, fingerprint, delta, rail) {
    const notes = [];
    const note = (kind, text, inferred = false) => notes.push({ id: `${kind}:${placeId}:${notes.length}`, kind, text, inferred, placeId, fingerprint });
    if (delta.landed > 0) note('landed', `${plural(delta.landed, 'save')}${delta.landedMore ? ' or more' : ''} landed in ${label}.`);
    for (const subject of delta.landedSubjects) note('landed', `Saved \u201c${subject}\u201d.`);
    if (delta.rewritten) note('rewritten', REWRITTEN);
    // Whether a stream was finished or abandoned is read from whether commits landed beside it, so it is a guess.
    if (delta.streamsSaved > 0) note('saved', `${plural(delta.streamsSaved, 'piece')} of work finished and left ${label}.`, true);
    if (delta.streamsDropped > 0) note('dropped', `${plural(delta.streamsDropped, 'piece')} of work left ${label} without being saved.`, true);
    // Ready is the grouping model's judgement about the files it was shown, not something counted off disk, so it
    // is marked as a guess and goes the moment the folder moves past the grouping it came from.
    if (delta.streamsReady > 0) note('ready', `${plural(delta.streamsReady, 'piece')} of work ${delta.streamsReady === 1 ? 'is' : 'are'} now ready to save in ${label}.`, true);
    if (!notes.length && delta.moved) note('moved', `Files changed in ${label}.`);
    for (const entry of rail) note(entry.kind, `${entry.placeLabel || 'This folder'}: ${entry.why}`, entry.inferred);
    return notes.slice(0, limit.notes);
  }

  /**
   * Records one scan and returns the deltas against the watermark. `observations` is the view's own projection:
   * [{ repoId, repoName, seenAt?, branchTips, places: [{ placeId, label, path, fingerprint, oid, items, ... , streams }] }].
   * `landedFor` is the caller's read-only git log; without it nothing is claimed about what landed.
   * `record` false computes without touching the ledger, for a filtered read.
   */
  async function sample(observations, { landedFor = null, record = true } = {}) {
    if (!Array.isArray(observations)) throw new Error('A scan must be a list of projects.');
    if (closing) record = false;
    return enqueue(async () => {
      await readState();
      const nowMs = now();
      const at = iso(nowMs);
      const byRepo = {};
      const fingerprints = {};
      const moved = [];
      // Keyed by id, not by name: moved carries cleaned names while a rail row carries the raw one.
      const movedIds = new Set();
      const rewrittenRepos = [];
      const unreadRepos = [];
      const rail = [];
      const landedSubjects = [];
      let landed = 0;
      let landedMore = false;
      let streamsSaved = 0;
      let streamsDropped = 0;
      let streamsReady = 0;
      let sinceAt = null;
      // The oldest and newest watermark among the projects read, and the span of the ones the counts came from.
      let sinceNewest = null;
      let toldFrom = null;
      let toldTo = null;
      const writes = [];
      for (const observation of observations.slice(0, limit.repos)) {
        if (!isObject(observation) || typeof observation.repoId !== 'string' || !observation.repoId) continue;
        const repo = state.repos[observation.repoId] ?? { name: '', at: null, seen: null, firstSeenAt: {}, tips: {}, places: {} };
        const seenAt = repo.seen?.at ?? null;
        const summary = { ...emptyDelta(), repoId: observation.repoId, since: seenAt, places: {} };
        const seenMs = validDate(repo.seen?.at) ? Date.parse(repo.seen.at) : null;
        if (Number.isFinite(seenMs) && (!Number.isFinite(sinceAt) || seenMs < sinceAt)) sinceAt = seenMs;
        if (Number.isFinite(seenMs) && (!Number.isFinite(sinceNewest) || seenMs > sinceNewest)) sinceNewest = seenMs;
        if (!repo.seen && observation.hasWork) unreadRepos.push(clean(observation.repoName, 120));
        // A worktree and the folder it merges into hold the same commits, so a project total counts each one once.
        // A record written before oids were kept, or a rewritten one, contributes its own number instead.
        const landedOids = new Set();
        let landedUnknown = 0;
        for (const place of listOf(observation.places).slice(0, limit.places)) {
          if (!isObject(place) || typeof place.placeId !== 'string' || typeof place.fingerprint !== 'string' || !place.fingerprint) continue;
          const pass = await placePass(observation, place, repo, nowMs, landedFor);
          writes.push({ repoId: observation.repoId, observation, pass });
          fingerprints[place.placeId] = place.fingerprint;
          const { delta } = pass;
          summary.moved = summary.moved || delta.moved;
          if (delta.landedOids.length) for (const oid of delta.landedOids) landedOids.add(oid); else landedUnknown += delta.landed;
          summary.landedMore = summary.landedMore || delta.landedMore;
          summary.rewritten = summary.rewritten || delta.rewritten;
          summary.streamsSaved += delta.streamsSaved;
          summary.streamsDropped += delta.streamsDropped;
          summary.streamsReady += delta.streamsReady;
          summary.landedSubjects.push(...delta.landedSubjects);
          const own = railFor(observation, place, pass, nowMs, seenAt);
          rail.push(...own);
          summary.places[place.placeId] = { ...delta, label: clean(place.label, 120), notes: notesFor(place.placeId, clean(place.label, 120), place.fingerprint, delta, own) };
        }
        summary.landed = landedOids.size + landedUnknown;
        // The same commit is reported by every folder that reaches it, so the project's list says each subject once.
        summary.landedSubjects = [...new Set(summary.landedSubjects)].slice(0, limit.subjects);
        summary.notes = Object.values(summary.places).flatMap(place => place.notes).slice(0, limit.notes);
        // lines is the same block as plain sentences, for a caller that only wants the words.
        summary.lines = summary.notes.map(note => note.text);
        byRepo[observation.repoId] = summary;
        if (summary.moved) { moved.push(clean(observation.repoName, 120)); movedIds.add(observation.repoId); }
        if (summary.rewritten) rewrittenRepos.push(clean(observation.repoName, 120));
        landed += summary.landed;
        landedMore = landedMore || summary.landedMore;
        streamsSaved += summary.streamsSaved;
        streamsDropped += summary.streamsDropped;
        streamsReady += summary.streamsReady;
        landedSubjects.push(...summary.landedSubjects);
        // The span the counts were actually measured over, so the first sentence can only be dated by its own scope.
        if (Number.isFinite(seenMs) && (summary.moved || summary.landed > 0 || summary.streamsReady > 0)) {
          if (!Number.isFinite(toldFrom) || seenMs < toldFrom) toldFrom = seenMs;
          if (!Number.isFinite(toldTo) || seenMs > toldTo) toldTo = seenMs;
        }
      }
      if (record && writes.some(write => write.pass.dirty)) {
        for (const write of writes) {
          const repo = repoEntry(write.observation, at);
          repo.places[write.pass.placeId] = write.pass.next;
          // Merged, not assigned: every folder's pass started from the same map, so the last one would drop the others.
          repo.firstSeenAt = { ...repo.firstSeenAt, ...write.pass.firstSeenAt };
          repo.tips = validTips(write.observation.branchTips);
        }
        await save();
      }
      const order = { spinning: 0, blocked: 1, rot: 2, still: 3 };
      rail.sort((a, b) => order[a.kind] - order[b.kind] || (b.days ?? 0) - (a.days ?? 0) || a.repoName.localeCompare(b.repoName));
      const seenIds = new Set();
      const notMoving = rail.filter(entry => { const key = `${entry.placeId}`; if (seenIds.has(key)) return false; seenIds.add(key); return true; }).slice(0, limit.rail);
      const text = sentencesFor({ sinceAt, sinceNewest, toldFrom, toldTo, nowMs, moved: [...new Set(moved)], movedIds, landed, landedMore, rewrittenRepos: [...new Set(rewrittenRepos)], streamsReady, notMoving });
      return {
        version: VERSION, at, since: Number.isFinite(sinceAt) ? iso(sinceAt) : null, sinceText: whenText(sinceAt, nowMs),
        moved: [...new Set(moved)], landed, landedSubjects: [...new Set(landedSubjects)].slice(0, limit.subjects), streamsSaved, streamsDropped, streamsReady, fingerprints,
        still: rail.filter(entry => entry.kind === 'still'), spinning: rail.filter(entry => entry.kind === 'spinning'),
        blocked: rail.filter(entry => entry.kind === 'blocked'), rot: rail.filter(entry => entry.kind === 'rot'),
        notMoving, rewritten: [...new Set(rewrittenRepos)], unreadRepos: [...new Set(unreadRepos)], byRepo, text, problems: [...problems],
      };
    });
  }

  /**
   * Advances the watermark for one project, or one folder in it, to what the last scan saw.
   * Only an expanded, visible section or an explicit "Mark as read" may call this; never panel open.
   */
  async function mark(request = {}) {
    // A plain id (or null for every project the ledger knows) is what the panel sends; the object form names a folder.
    const { repoId = null, placeId = null } = typeof request === 'string' || request === null ? { repoId: request } : request;
    if (repoId !== null && (typeof repoId !== 'string' || !repoId || repoId.length > 200)) throw new Error('Project id must be a short text value.');
    if (placeId !== null && (typeof placeId !== 'string' || !placeId || placeId.length > 200)) throw new Error('Folder id must be a short text value.');
    if (placeId !== null && repoId === null) throw new Error('A folder can only be marked inside its project.');
    if (closing) throw new Error('Summon is closing. Try again after it restarts.');
    return enqueue(async () => {
      await readState();
      const wanted = repoId === null ? Object.keys(state.repos) : [repoId];
      if (repoId !== null && !state.repos[repoId]) throw new Error('That project has not been checked yet.');
      const at = iso(now());
      let markedPlaces = 0;
      for (const id of wanted) {
        const repo = state.repos[id];
        if (!repo) continue;
        const perPlace = placeId ? { ...(repo.seen?.perPlace ?? {}) } : {};
        for (const [place, entry] of Object.entries(repo.places)) {
          if (placeId && place !== placeId) continue;
          const newest = entry.samples.at(-1);
          if (!newest) continue;
          const readiness = {};
          for (const item of entry.streams) if (item.readiness) readiness[item.key] = item.readiness;
          perPlace[place] = { fingerprint: newest.fingerprint, oid: newest.oid, streamSigs: [...newest.streamSigs], readiness };
          entry.landed = null;
          markedPlaces += 1;
        }
        repo.seen = { at, perPlace, branchTips: { ...(repo.tips ?? {}) } };
        repo.at = at;
      }
      await save();
      return { repoId, placeId, at, markedPlaces, markedRepos: wanted.length };
    });
  }

  async function forget(repoId) {
    if (typeof repoId !== 'string' || !repoId) throw new Error('Project id must be a short text value.');
    return enqueue(async () => {
      await readState();
      if (!state.repos[repoId]) return false;
      delete state.repos[repoId];
      await save();
      return true;
    });
  }

  async function read() { return enqueue(async () => { await readState(); return clone(state); }); }

  async function close() { closing = true; await queue; }

  await enqueue(readState);
  return { read, mark, sample, forget, close, path: filename, problems: () => [...problems] };
}
