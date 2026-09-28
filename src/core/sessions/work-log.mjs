/** The work log: what a Claude session did, read without a model from its own transcript as the transcript grows
 * (decisions 2026-09-27, "Session cards"). One forward-only pass per transcript, remembered per file like the edit
 * pass in claude.mjs, so a session that has not grown costs nothing beyond the stat the reader already made. The same
 * pass also runs over the session's sub-agent transcripts, which is where an Agent or Workflow call does its work.
 *
 * From that pass, and nothing else, it keeps:
 * - the `gitOperation` object Claude Code writes on a tool result (commit SHA, kind and branch; pushed branch; branch
 *   ref and action; pull request number and action), which is harness metadata rather than tool output;
 * - for a Bash call, whether its command is a `git commit`, another git or `gh pr` command, or a test run, and the
 *   folder each of those ran in, decided in memory from the command, which is never kept;
 * - for a commit call whose result carries no annotation (a `-q` commit, mostly, and every commit a sub-agent made,
 *   since no result in a sub-agent's transcript carries one), that folder and the time from the call to its result, so
 *   the repository can say which commit it made;
 * - for a test call only, the runner and the passed and failed counts matched in the last 8 KB of its stdout and
 *   stderr by fixed summary-line patterns (for Node's runner, which prints its failures after the summary, the 8 KB
 *   above its "failing tests" heading instead);
 * - the file_path of an Edit, Write, MultiEdit or NotebookEdit call that succeeded, with the time of its result;
 * - whether the last paragraph of the final assistant message of a finished turn asks the person something, judged
 *   on its last 400 characters, keeping only that yes and its time, and when the person last wrote;
 * - the files named on the file-history metadata lines (edited-files.mjs), with a time only where the line has one.
 * Commit messages, command text, tool output beyond the matched counts and message text are never kept. In the
 * session's own transcript, rows written by sub-agents (isSidechain) and rows copied from another session (a fork)
 * are skipped. Transcript content is untrusted data: nothing here follows it. */
import path from 'node:path';
import { sealedPath } from '../workstreams.mjs';
import { conversationText } from './recent-context.mjs';
import { openRead, readRange } from './read-file.mjs';
import { editPath, headForked, historyEdits, ownerState, ownLine, ownEdits, releaseHeld } from './edited-files.mjs';

export const WORK_LIMITS = Object.freeze({
  // The first look starts at most this far before the end; each later look reads at most this much of what arrived.
  firstBytes: 4 * 1024 * 1024, passBytes: 4 * 1024 * 1024,
  // A longer line is skipped without being parsed: a huge tool result is never worth holding in memory.
  lineBytes: 1024 * 1024,
  // Classified calls still waiting for their result, carried from one pass to the next. The oldest goes first.
  pending: 200,
  // Kept per session, newest first: git actions, test runs, and files edited.
  git: 50, tests: 20, edited: 200,
  // The end of stdout and of stderr a test summary is looked for in, and the end of the final message a question is.
  outputBytes: 8 * 1024, questionChars: 400,
  // A longer command is not classified at all; one that changes folder more often than this names no folder.
  commandChars: 64 * 1024, folderHops: 32,
  // How much of a transcript's start a first look that begins partway in reads to see whose rows the file starts with.
  headBytes: 64 * 1024,
});

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const time = value => Number.isFinite(value) && value > 0 && value < 1e14 ? Math.round(value) : null;
const isoTime = value => typeof value === 'string' ? time(Date.parse(value)) : null;
const whole = value => Number.isSafeInteger(value) && value >= 0 && value <= 1e7 ? value : null;
const absPath = value => typeof value === 'string' && value.length <= 4096 && path.isAbsolute(value) && !/[\u0000-\u001f]/.test(value) ? path.normalize(value) : null;
// Branch names and action words are the harness's own fields, but still untrusted text: control and bidi characters go.
const refText = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 200) || null : null;
const word = value => typeof value === 'string' && /^[a-z][a-z-]{0,23}$/i.test(value) ? value.toLowerCase() : null;
const TOOL_ID = /^[A-Za-z0-9_-]{1,100}$/;
const SHA = /^[0-9a-f]{7,64}$/i;
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
// The tools that write a file, and the input field that names it. Nothing else of their input is read.
const EDIT_TOOLS = new Map([['Edit', 'file_path'], ['Write', 'file_path'], ['MultiEdit', 'file_path'], ['NotebookEdit', 'notebook_path']]);

// ---- commands (in memory only) ----
// A command is read in three layers, all the same length so an offset in one is an offset in the others: the command,
// the command with heredoc bodies blanked (a `cd` or `git commit` inside a file being written, or inside a message
// passed as `-m "$(cat <<'EOF' … EOF)"`, never runs), and that with quoted text, escapes and comments masked (a `;`
// or `cd` inside a string is never shell syntax). Structure is matched on the last; words are read from the second.
const HEREDOC = /(?<!<)<<(-?)[ \t]*(["']?)([A-Za-z_][A-Za-z0-9_]{0,63})\2/g;
function blankHeredocs(command) {
  let out = null;
  HEREDOC.lastIndex = 0;
  for (let match; (match = HEREDOC.exec(command));) {
    const open = command.indexOf('\n', HEREDOC.lastIndex);
    if (open < 0) break;
    let end = command.length;
    for (let from = open + 1; from < command.length;) {
      let stop = command.indexOf('\n', from);
      if (stop < 0) stop = command.length;
      const line = command.slice(from, stop);
      if ((match[1] ? line.replace(/^\t+/, '') : line) === match[3]) { end = stop; break; }
      from = stop + 1;
    }
    out ??= command.split('');
    for (let i = open + 1; i < end; i++) out[i] = ' ';
    HEREDOC.lastIndex = Math.max(end, HEREDOC.lastIndex);
  }
  return out ? out.join('') : command;
}
function maskQuotes(text) {
  const out = text.split('');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    // An escaped character is part of its word; an escaped newline joins two lines into one command.
    if (c === '\\') { if (i + 1 < text.length) out[i + 1] = text[i + 1] === '\n' ? ' ' : '_'; i++; continue; }
    // A comment runs to the end of its line.
    if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) { while (i < text.length && text[i] !== '\n') out[i++] = ' '; i--; continue; }
    if (c !== "'" && c !== '"') continue;
    let j = i + 1;
    while (j < text.length && text[j] !== c) {
      if (c === '"' && text[j] === '\\' && j + 1 < text.length) { out[j] = '_'; out[j + 1] = '_'; j += 2; continue; }
      out[j] = '_'; j++;
    }
    i = j;
  }
  return out.join('');
}

// One shell word in the masked layer: quoted strings (already masked) and bare characters, joined.
const WORD = String.raw`(?:"[^"]*"|'[^']*'|[^\s;&|<>()"'])+`;
// A command that changes folder, where a simple command can start: after a separator, a parenthesis or a brace (group
// 1), then at most four clause keywords (`if`, `then`, `while !` …) and at most eight VAR=value assignments, with its
// arguments up to the next separator. Every start is a separator and both repeats are bounded, so no start rescans the
// rest of the command: with a keyword allowed to start anywhere and the assignments unbounded, one crafted 64 KB
// command took seconds on the main thread (measured 3.3 s; bounded, about 5 ms).
const MOVE = new RegExp(String.raw`(^|&&|\|\||[;&|\n(){}])[ \t]*(?:(?:if|elif|while|until|then|do|else|!)[ \t]+){0,4}(?:[A-Za-z_][A-Za-z0-9_]*=[^\s;&|()]*[ \t]+){0,8}(cd|pushd|popd)(?=[\s;&|)}]|$)((?:\$\([^()\n]*\)|[^;&|\n()}])*)`, 'g');
// A shell function's definition, up to the brace its body opens with: `name() {` or `function name {`.
const FUNCTION = /(?:^|[\s;&|(){}])(?:function[ \t]+[A-Za-z_][\w.:-]*(?:[ \t]*\([ \t]*\))?|[A-Za-z_][\w.:-]*[ \t]*\([ \t]*\))[ \t\n]*\{/g;
// git reads its folder from these as well as from its options; a command that sets one names no folder we can trust.
const GIT_ENV_FOLDER = /(?:^|[^\w])GIT_(?:DIR|WORK_TREE)=/;
// The git global options that can sit before a subcommand; -C, --git-dir and --work-tree say where it runs.
const GIT_OPTION = String.raw`\s+(?:-C\s+${WORD}|-c\s+${WORD}|--git-dir(?:=|\s+)${WORD}|--work-tree(?:=|\s+)${WORD}|--namespace(?:=|\s+)${WORD}|--no-pager|--paginate|-[pP]|--no-optional-locks|--literal-pathspecs|--no-replace-objects|--bare)`;
const GIT_COMMIT = new RegExp(String.raw`(?:^|[\s;&|(){}])git((?:${GIT_OPTION})*)\s+commit(?=[\s;&|)}]|$)`, 'd');
const GIT_ANY = new RegExp(String.raw`(?:^|[\s;&|(){}])(?:git((?:${GIT_OPTION})*)\s+[a-z]|gh\s+pr\b)`, 'd');
const OPTION_VALUE = new RegExp(String.raw`(-C\s+|--git-dir(?:=|\s+)|--work-tree(?:=|\s+))(${WORD})`, 'g');
// Test runners whose summary lines testSummary() knows. `npm run test:unit` counts; `npm run lint` does not.
const TEST = /(?:^|[\s;&|(){}])(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|npm\s+t\b|(?:python3?\s+-m\s+)?pytest\b|(?:npx\s+|pnpm\s+(?:exec\s+)?|yarn\s+|bunx\s+)?(?:jest|vitest)\b|cargo\s+(?:\+\S+\s+)?test\b|go\s+test\b)/;
// `node … --test`: found from each `--test` back to a `node` at most 300 characters before it in the same simple
// command, so a long line that repeats `node` costs one scan rather than a regex backtracking across it from each one.
function nodeTest(shape) {
  for (let at = shape.indexOf('--test'); at >= 0; at = shape.indexOf('--test', at + 6)) {
    if (/\w/.test(shape[at + 6] ?? '') || !/\s/.test(shape[at - 1] ?? '')) continue;
    const from = Math.max(0, at - 300);
    const before = shape.slice(from, at);
    const cut = Math.max(before.lastIndexOf('\n'), before.lastIndexOf(';'), before.lastIndexOf('&'), before.lastIndexOf('|')) + 1;
    const found = /(?:^|[\s(){}])node\s/.exec(before.slice(cut));
    if (found) { const index = from + cut + found.index; return { index, 0: shape.slice(index, at + 6) }; }
  }
  return null;
}
const TOPLEVEL = /^"?\$\(git rev-parse --show-toplevel\)"?$/;

/** The literal text of one shell word, or null when any part of it expands ($, backticks, globs, braces) or is not a
 *  plain `~` or `~/…`: such a word is not a folder we can name. */
function literalWord(text, homeDir) {
  let out = '';
  let i = 0;
  if (text === '~' || text.startsWith('~/')) {
    if (!homeDir || !path.isAbsolute(homeDir)) return null;
    out = homeDir; i = 1;
  } else if (text.startsWith('~')) return null;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === "'") { const end = text.indexOf("'", i + 1); if (end < 0) return null; out += text.slice(i + 1, end); i = end; continue; }
    if (c === '"') {
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) {
        if (text[j] === '$' || text[j] === '`') return null;
        if (text[j] === '\\' && j + 1 < text.length && '$`"\\'.includes(text[j + 1])) j++;
        out += text[j];
      }
      if (j >= text.length) return null;
      i = j;
      continue;
    }
    if (c === '\\') { if (i + 1 >= text.length) return null; out += text[++i]; continue; }
    if ('$`*?[{'.includes(c)) return null;
    out += c;
  }
  return out;
}
/** A folder named by one word, made absolute against `base`, or null when it cannot be named. */
function resolveWord(text, base, homeDir) {
  if (TOPLEVEL.test(text)) return base;
  const value = literalWord(text, homeDir);
  if (!value || value.length > 4096 || /[\u0000-\u001f]/.test(value)) return null;
  if (path.isAbsolute(value)) return path.normalize(value);
  return base ? path.resolve(base, value) : null;
}
// The words of a stretch of the command, redirections dropped: [start, end) offsets in the masked layer, text read
// from the unmasked one.
function wordsIn(shape, body, from, to) {
  const out = [];
  let skip = false;
  for (const match of shape.slice(from, to).matchAll(/(?:\$\([^()\n]*\)|\S)+/g)) {
    const text = body.slice(from + match.index, from + match.index + match[0].length);
    if (skip) { skip = false; continue; }
    if (/^(?:\d*|&)[<>]{1,2}&?$/.test(match[0])) { skip = true; continue; }
    if (/^(?:\d*|&)[<>]/.test(match[0])) continue;
    out.push(text);
  }
  return out;
}
/** For each offset, whether the first separator at or after it (redirections such as 2>&1 skipped) is a single `|`, so
 *  whether a simple command ending there feeds a pipe. One pass from the end: a command with many moves costs one scan,
 *  not one per move (scanning forward from each measured 1.4 s on a crafted 64 KB command). */
function pipeMap(shape) {
  const out = new Uint8Array(shape.length + 1);
  let next = 0;
  for (let i = shape.length - 1; i >= 0; i--) {
    const c = shape[i];
    if (c === '|') next = shape[i + 1] === '|' || shape[i - 1] === '|' ? 0 : 1;
    else if (c === '&') { if (!(shape[i - 1] === '>' || shape[i - 1] === '<' || shape[i + 1] === '>')) next = 0; }
    else if (c === ';' || c === '\n' || c === '(' || c === ')' || c === '{' || c === '}') next = 0;
    out[i] = next;
  }
  return out;
}
/** Where each offset of a command runs: every cd, pushd and popd in order, with a subshell or command substitution
 *  putting the folder back when it closes. A folder that cannot be named (an expanding word, `cd -`, popd) is null from
 *  there on rather than the folder before it, and so is one after more than folderHops changes. A cd in a pipeline
 *  stage runs in a subshell of its own, and one inside a function body runs only when the function is called, so
 *  neither moves what follows. */
function folderTracker(shape, body, base, homeDir) {
  const events = [];
  for (let i = 0; i < shape.length; i++) if (shape[i] === '(' || shape[i] === ')') events.push({ at: i, kind: shape[i] });
  // Function bodies, from the brace that opens one to the brace that closes it, matched in one pass over the command.
  const closing = new Map();
  const open = [];
  for (let i = 0; i < shape.length; i++) {
    if (shape[i] === '{') open.push(i);
    else if (shape[i] === '}' && open.length) closing.set(open.pop(), i);
  }
  FUNCTION.lastIndex = 0;
  for (const match of shape.matchAll(FUNCTION)) {
    const brace = match.index + match[0].length - 1;
    events.push({ at: brace, kind: 'body' }, { at: closing.get(brace) ?? shape.length, kind: 'end' });
  }
  const piped = pipeMap(shape);
  MOVE.lastIndex = 0;
  for (const match of shape.matchAll(MOVE)) {
    const end = match.index + match[0].length;
    const from = end - match[3].length;
    if (match[1] === '|' || piped[end]) continue;
    events.push({ at: from - match[2].length, kind: 'move', verb: match[2], from, to: end });
  }
  events.sort((a, b) => a.at - b.at);
  const moveTo = (event, folder) => {
    if (event.verb === 'popd') return null;
    const args = wordsIn(shape, body, event.from, event.to).filter(text => !/^-[PLe@n]$/.test(text));
    if (!args.length) return event.verb === 'cd' && homeDir && path.isAbsolute(homeDir) ? path.normalize(homeDir) : null;
    if (args.length > 1 || /^[-+]\d*$/.test(args[0])) return null;
    return resolveWord(args[0], folder, homeDir);
  };
  return index => {
    let folder = base;
    let hops = 0;
    let bodies = 0;
    const stack = [];
    for (const event of events) {
      if (event.at >= index) break;
      if (event.kind === '(') stack.push(folder);
      else if (event.kind === ')') { if (stack.length) folder = stack.pop(); }
      else if (event.kind === 'body') bodies++;
      else if (event.kind === 'end') bodies = Math.max(0, bodies - 1);
      else if (bodies) continue;
      else if (++hops > WORK_LIMITS.folderHops || (folder && folder.length > 4096)) return null;
      else folder = moveTo(event, folder);
    }
    return folder;
  };
}
/** The folder a git command runs in: the shell's folder, moved by each -C in turn; a --work-tree names the checkout
 *  outright, and a --git-dir ending in .git names the folder above it. Any other git folder (a bare repository, a
 *  worktree's admin folder) names no checkout. */
function gitFolder(match, shape, body, folder, homeDir) {
  const [start, end] = match.indices?.[1] ?? [0, 0];
  let workTree, gitDir;
  let hops = 0;
  OPTION_VALUE.lastIndex = 0;
  for (const option of shape.slice(start, end).matchAll(OPTION_VALUE)) {
    // Like cd: past folderHops moves, or once a folder outgrows any real length, it is no longer one we can name.
    if (++hops > WORK_LIMITS.folderHops || (folder && folder.length > 4096)) return null;
    const from = start + option.index + option[1].length;
    const target = resolveWord(body.slice(from, from + option[2].length), folder, homeDir);
    if (option[1].startsWith('-C')) folder = target;
    else if (option[1].startsWith('--work-tree')) workTree = target;
    else gitDir = target;
  }
  if (workTree !== undefined) return workTree;
  if (gitDir !== undefined) return gitDir && path.basename(gitDir) === '.git' ? path.dirname(gitDir) : null;
  return folder;
}

const SEALED = Object.freeze({ commit: false, test: false, git: false, folder: null, testFolder: null, sealed: true });
/** What a Bash command is, and where it ran: { commit, test, git, folder, testFolder, sealed }, or null when it is none
 *  of those. `folder` is where its git command ran (the commit when there is one), `testFolder` where its test run
 *  did; either is null when it cannot be named, and the caller then keeps nothing that would need it rather than
 *  crediting the row's working folder. A command that names a sealed folder anywhere (a cd, a subshell, pushd,
 *  --git-dir, a variable set to it) comes back as { sealed: true } alone, so its result is dropped too. Used in
 *  memory only; the command itself is never kept. */
export function classifyCommand(command, cwd, { homeDir = null } = {}) {
  if (typeof command !== 'string' || !command || command.length > WORK_LIMITS.commandChars) return null;
  if (sealedPath(command)) return SEALED;
  const body = blankHeredocs(command);
  const shape = maskQuotes(body);
  const commit = GIT_COMMIT.exec(shape);
  const test = TEST.exec(shape) ?? nodeTest(shape);
  const git = commit ?? GIT_ANY.exec(shape);
  if (!commit && !test && !git) return null;
  const base = absPath(cwd);
  if (base && sealedPath(base)) return SEALED;
  const folderAt = folderTracker(shape, body, base, homeDir);
  // A match starts with the separator before the command, when there is one.
  const start = match => match.index + (/^[\s;&|(){}]/.test(match[0]) ? 1 : 0);
  // GIT_DIR or GIT_WORK_TREE set anywhere before the git command (a prefix, an export, env) moves it where this cannot
  // follow, so its folder is unknown rather than the shell's.
  const gitAt = git && !GIT_ENV_FOLDER.test(shape.slice(0, start(git))) ? absPath(gitFolder(git, shape, body, folderAt(start(git)), homeDir)) : null;
  const testAt = test ? absPath(folderAt(start(test))) : null;
  if ((gitAt && sealedPath(gitAt)) || (testAt && sealedPath(testAt))) return SEALED;
  return { commit: Boolean(commit), test: Boolean(test), git: Boolean(git), folder: git ? gitAt : testAt, testFolder: test ? testAt : null, sealed: false };
}

// ---- test summaries ----
const counted = text => { const n = Number(text); return Number.isSafeInteger(n) && n >= 0 && n <= 1e7 ? n : null; };
function lastMatch(pattern, text) {
  let found = null;
  for (const match of text.matchAll(pattern)) found = match;
  return found;
}
function countsIn(phrase) {
  const passed = /(\d+) passed/.exec(phrase);
  const failed = /(\d+) failed/.exec(phrase);
  const errors = /(\d+) errors?\b/.exec(phrase);
  if (!passed && !failed) return null;
  return { passed: counted(passed?.[1] ?? 0) ?? 0, failed: (counted(failed?.[1] ?? 0) ?? 0) + (counted(errors?.[1] ?? 0) ?? 0) };
}
function nodeCounts(text) {
  const pass = lastMatch(/^[ \t]*ℹ pass (\d+)[ \t]*$/gm, text), fail = lastMatch(/^[ \t]*ℹ fail (\d+)[ \t]*$/gm, text);
  return pass && fail ? { passed: counted(pass[1]), failed: counted(fail[1]), index: Math.max(pass.index, fail.index) } : null;
}
const plain = text => text.replace(ANSI, '').replace(/\r/g, '');
// Each runner's summary, found by where it last appears, so the output of a command that runs two tools reports the
// one that finished last. Node and TAP report their last block only, which never double counts a block cut in half
// by the 8 KB window; cargo prints one line per test binary, so its lines add up.
const RUNNERS = [
  ['node', nodeCounts],
  ['tap', text => {
    const pass = lastMatch(/^# pass (\d+)[ \t]*$/gm, text), fail = lastMatch(/^# fail (\d+)[ \t]*$/gm, text);
    return pass && fail ? { passed: counted(pass[1]), failed: counted(fail[1]), index: Math.max(pass.index, fail.index) } : null;
  }],
  ['pytest', text => {
    const line = lastMatch(/^=*[ \t]*((?:\d+ (?:passed|failed|errors?|skipped|xfailed|xpassed|deselected|warnings?|rerun)(?:, )?)+) in [\d.]+s\b.*$/gm, text);
    const counts = line && countsIn(line[1]);
    return counts ? { ...counts, index: line.index } : null;
  }],
  ['jest', text => {
    const line = lastMatch(/^Tests:[ \t]+(.+ \d+ total)[ \t]*$/gm, text);
    const counts = line && countsIn(line[1]);
    return counts ? { ...counts, index: line.index } : null;
  }],
  ['vitest', text => {
    const line = lastMatch(/^[ \t]*Tests[ \t]{2,}(.+\(\d+\))[ \t]*$/gm, text);
    const counts = line && countsIn(line[1]);
    return counts ? { ...counts, index: line.index } : null;
  }],
  ['cargo', text => {
    let passed = 0, failed = 0, index = -1;
    for (const match of text.matchAll(/test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed;/g)) {
      passed += counted(match[1]) ?? 0; failed += counted(match[2]) ?? 0; index = match.index;
    }
    return index >= 0 ? { passed, failed, index } : null;
  }],
  // `go test -v` names every test on an unindented `--- PASS` line (subtests are indented), but those add up only when
  // the whole output is in view; otherwise, and without -v, the package lines that end every run are what is counted.
  ['go', (text, complete) => {
    const tests = complete ? [...text.matchAll(/^--- (PASS|FAIL): /gm)] : [];
    const rows = tests.length ? tests : [...text.matchAll(/^(ok|FAIL)[ \t]+\S+[ \t]+(?:[\d.]+s|\(cached\))/gm)];
    if (!rows.length) return null;
    const failed = rows.filter(match => match[1] === 'FAIL').length;
    return { passed: rows.length - failed, failed, index: rows.at(-1).index };
  }],
];
/** The test summary in a run's output tail, or null: { runner, passed, failed }. Counts only; the text is dropped.
 *  `complete`: the text is the whole output, not a tail of it. */
export function testSummary(output, { complete = false } = {}) {
  if (typeof output !== 'string' || !output) return null;
  const text = plain(output);
  let best = null;
  for (const [runner, find] of RUNNERS) {
    const found = find(text, complete);
    if (found && found.passed !== null && found.failed !== null && (!best || found.index > best.index)) best = { runner, ...found };
  }
  return best ? { runner: best.runner, passed: best.passed, failed: best.failed } : null;
}
// Node's spec reporter prints its summary and then every failure's details under this heading, so a long report pushes
// the summary out of the tail and the counts sit just above the heading instead.
const NODE_FAILING = '✖ failing tests:';
/** A test run's counts from what it printed: the tail first; for Node, the block above its failure report; and a run
 *  that printed that report without counts anywhere is still a failed run, with the counts unknown (null), so an older
 *  passing run never stands in for it. */
export function testRun(texts, bytes = WORK_LIMITS.outputBytes) {
  const outputs = texts.filter(text => typeof text === 'string' && text);
  if (!outputs.length) return null;
  const found = testSummary(outputs.map(text => text.slice(-bytes)).join('\n'), { complete: outputs.every(text => text.length <= bytes) });
  if (found) return found;
  for (const text of outputs) {
    const at = text.lastIndexOf(NODE_FAILING);
    if (at < 0) continue;
    const counts = nodeCounts(plain(text.slice(Math.max(0, at - bytes), at)));
    return counts && counts.passed !== null && counts.failed !== null ? { runner: 'node', passed: counts.passed, failed: counts.failed } : { runner: 'node', passed: null, failed: null };
  }
  return null;
}

// ---- did the last message ask something ----
const LIST_ITEM = /^\s*(?:[-*•]|\d{1,2}[.)])\s+\S/;
// Words in a lead-in that offer the person a choice. A lead-in without one ("Changes:") introduces a list, not a question.
const CHOICE = /\b(?:which|pick|choose|prefer|options?|your call|up to you|decide|either|would you like|want me to|shall i|should i|let me know)\b/i;
// A paragraph of list items after a lead-in that ends in a colon and offers a choice ("Your call:", then the options)
// asks the person to pick, which is how a turn often ends without a question mark.
function offersChoice(paragraphs) {
  const lines = paragraphs.at(-1).split('\n');
  const first = lines.findIndex(line => LIST_ITEM.test(line));
  if (first < 0 || !lines.slice(first).every(line => LIST_ITEM.test(line) || /^\s+\S/.test(line) || !line.trim())) return false;
  const lead = (first > 0 ? lines[first - 1] : paragraphs.at(-2)?.split('\n').at(-1) ?? '').trim();
  return /:[*_]*$/.test(lead) && CHOICE.test(lead);
}
/** True when the last paragraph of this text asks the person something: a sentence in it ends in a question mark, or
 *  it is a list of options after a lead-in that offers a choice. Code is left out first, so `a ? b : c` and `x?.y`
 *  are not questions. Only the answer is kept. */
export function asksQuestion(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  let body = text.replace(/```[\s\S]*?```/g, '\n\n');
  // A fence left over is almost always the closing one of a block the 400-character window started inside (a long
  // block, then a short question), so what came before it is code and only what follows it is read.
  const fence = body.lastIndexOf('```');
  if (fence >= 0) body = body.slice(fence + 3);
  body = body.replace(/`[^`\n]*`/g, ' ');
  const paragraphs = body.split(/\n[ \t]*\n/).map(part => part.trim()).filter(Boolean);
  const last = paragraphs.at(-1);
  return Boolean(last) && (/\?(?=[)\]"'*_»”’]*(?:\s|$))/.test(last) || offersChoice(paragraphs));
}

// ---- the pass ----
export function emptyWorkState() {
  return { git: [], tests: [], edited: new Map(), asked: null, lastUserAt: null, finalId: null, pending: new Map(), owner: ownerState() };
}

// A file named again moves to the newest end with the later of its two times; the cap drops the oldest.
function addEdited(state, found, limits) {
  for (const { path: file, at } of found) {
    const before = state.edited.get(file) ?? null;
    state.edited.delete(file);
    state.edited.set(file, at && at > (before ?? 0) ? at : before);
  }
  while (state.edited.size > limits.edited) state.edited.delete(state.edited.keys().next().value);
}
function addGit(state, actions, limits) {
  if (!actions.length) return;
  state.git.unshift(...actions.reverse());
  if (state.git.length > limits.git) state.git.length = limits.git;
}
// One gitOperation object can say several things at once (a commit and its push). Unknown keys are ignored.
function gitActions(op, at, folder) {
  const out = [];
  const base = { at, folder, sha: null, branch: null, action: null, number: null, quiet: false, from: null };
  if (isObject(op.commit) && typeof op.commit.sha === 'string' && SHA.test(op.commit.sha)) {
    out.push({ ...base, kind: 'commit', sha: op.commit.sha.toLowerCase(), branch: refText(op.commit.branch), action: word(op.commit.kind) });
  }
  if (isObject(op.branch)) out.push({ ...base, kind: 'branch', branch: refText(op.branch.ref), action: word(op.branch.action) });
  if (isObject(op.push)) out.push({ ...base, kind: 'push', branch: refText(op.push.branch) });
  if (isObject(op.pr)) out.push({ ...base, kind: 'pr', number: whole(op.pr.number), action: word(op.pr.action) });
  return out;
}
// What a call printed: toolUseResult's stdout and stderr when the harness wrote them, else the text of the tool_result
// block itself (a failed call's result is often a plain string). Only a test run's is ever looked at, and only its
// summary lines are kept.
function outputsOf(row, block, single) {
  const result = single && isObject(row.toolUseResult) ? row.toolUseResult : null;
  if (result && (typeof result.stdout === 'string' || typeof result.stderr === 'string')) return [result.stdout, result.stderr];
  const content = block?.content;
  if (typeof content === 'string') return [content];
  if (Array.isArray(content)) return [content.slice(0, 16).filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n')];
  return [];
}
function remember(state, id, call, limits) {
  state.pending.delete(id);
  state.pending.set(id, call);
  while (state.pending.size > limits.pending) state.pending.delete(state.pending.keys().next().value);
}

function onAssistant(row, at, cwd, state, options) {
  const { limits, homeDir, sidechain } = options;
  const message = row.message;
  if (!isObject(message)) return;
  const id = typeof message.id === 'string' && message.id.length <= 100 ? message.id : `at:${at}`;
  // A new assistant message after a question means the session went on without waiting for the answer.
  if (state.asked && id !== state.finalId) state.asked = null;
  const content = Array.isArray(message.content) ? message.content.slice(0, 64) : [];
  for (const block of content) {
    if (!isObject(block) || block.type !== 'tool_use' || !isObject(block.input) || typeof block.id !== 'string' || !TOOL_ID.test(block.id)) continue;
    if (block.name === 'Bash') {
      const kind = classifyCommand(block.input.command, cwd, { homeDir });
      if (kind) remember(state, block.id, { ...kind, at }, limits);
    } else if (EDIT_TOOLS.has(block.name)) {
      // The file an edit tool writes, through the same secret-name and sealed filters as the file-history names.
      const file = editPath(block.input[EDIT_TOOLS.get(block.name)], null);
      if (file) remember(state, block.id, { edit: file, at }, limits);
    }
  }
  // A sub-agent's final message answers the session that started it, not the person.
  if (sidechain) return;
  const stop = message.stop_reason;
  if ((stop !== 'end_turn' && stop !== 'stop_sequence') || row.isApiErrorMessage === true) return;
  // Claude Code writes one row per content block and copies the stop reason onto each, so the rows of one message are
  // told apart by its id: a new final message starts with no question, and its last text row decides.
  if (id !== state.finalId) { state.finalId = id; state.asked = null; }
  const texts = content.filter(block => isObject(block) && block.type === 'text' && typeof block.text === 'string');
  if (texts.length) state.asked = at && asksQuestion(texts.at(-1).text.slice(-limits.questionChars)) ? { at } : null;
}

function onUser(row, at, cwd, state, options) {
  const { limits, sidechain } = options;
  const content = row.message?.content;
  const results = Array.isArray(content) ? content.slice(0, 64).filter(block => isObject(block) && block.type === 'tool_result') : [];
  if (!results.length) {
    // A message from the person answers whatever the session asked. Harness wrappers, compaction summaries and
    // injected notices are not the person (conversationText already knows them); only the fact and time are kept.
    // In a sub-agent's transcript the "user" is the session that started it.
    if (sidechain || row.isMeta === true || row.isCompactSummary === true || !at || !conversationText(content)) return;
    state.lastUserAt = Math.max(state.lastUserAt ?? 0, at);
    state.asked = null;
    return;
  }
  const single = results.length === 1;
  const op = isObject(row.toolUseResult) && isObject(row.toolUseResult.gitOperation) ? row.toolUseResult.gitOperation : null;
  const rowSealed = Boolean(cwd && sealedPath(cwd));
  results.forEach((block, index) => {
    const id = typeof block.tool_use_id === 'string' && TOOL_ID.test(block.tool_use_id) ? block.tool_use_id : null;
    const call = id ? state.pending.get(id) ?? null : null;
    if (id) state.pending.delete(id);
    if (call?.sealed || rowSealed) return;
    const failed = block.is_error === true;
    if (call?.edit) { if (!failed && at) addEdited(state, [{ path: call.edit, at }], limits); return; }
    // Where the annotation belongs: the classified call's own folder, which is null when the command moved somewhere
    // that cannot be named (and then nothing is kept), else, for a call this pass never saw, the row's working folder.
    const folder = call ? call.folder : cwd;
    // The annotation belongs to the row, so with several results only the first can claim it.
    const own = index === 0 ? op : null;
    const actions = own && at && folder ? gitActions(own, at, folder) : [];
    addGit(state, actions, limits);
    if (!call || !at) return;
    // An ordinary commit carries a commit annotation. One without (a -q commit, mostly) keeps its folder and the time
    // from the call to its result, and the repository says later which commit, if any, it made. A call that failed
    // (nothing to commit, a hook that refused) made none, so it leaves no window for another session's commit to fill.
    // Claude Code writes its structured result (stdout, the annotation) on the session's own rows only: no result in a
    // sub-agent's transcript carries one (0 of 8,581 on this Mac; the few that have a toolUseResult have an error
    // string), so there a result that did not fail and has none is settled too, and every commit it made is a window.
    const settled = !failed && (isObject(row.toolUseResult) || (sidechain && row.toolUseResult === undefined));
    if (call.commit && settled && !actions.some(action => action.kind === 'commit') && call.folder && call.at && call.at <= at) {
      addGit(state, [{ kind: 'commit', at, folder: call.folder, sha: null, branch: null, action: null, number: null, quiet: true, from: call.at }], limits);
    }
    if (call.test && call.testFolder) {
      const summary = testRun(outputsOf(row, block, single), limits.outputBytes);
      if (summary) {
        state.tests.unshift({ ...summary, at, folder: call.testFolder });
        if (state.tests.length > limits.tests) state.tests.length = limits.tests;
      }
    }
  });
}

// Cheap checks on the raw bytes before anything is decoded or parsed: a line is parsed only if it can be a Bash or
// edit call, a finished turn, the result of a call this pass is waiting for, a git annotation, or a message from the
// person. Claude Code writes compact JSON, and a structural key never matches inside string content, where its quotes
// are escaped; the row is checked properly once parsed. Measured on this Mac: about one line in eight is parsed.
const BYTES = Object.fromEntries(Object.entries({
  result: '"tool_result"', git: '"gitOperation"', bash: '"name":"Bash"', end: '"stop_reason":"end_turn"',
  sequence: '"stop_reason":"stop_sequence"', user: '"type":"user"', assistant: '"type":"assistant"', resultId: '"tool_use_id":"',
  history: '"type":"file-history-', edit: '"name":"Edit"', write: '"name":"Write"', multi: '"name":"MultiEdit"', notebook: '"name":"NotebookEdit"',
}).map(([key, text]) => [key, Buffer.from(text)]));
const has = (line, key) => line.indexOf(BYTES[key]) >= 0;
function wanted(line, state) {
  if (has(line, 'result')) {
    if (has(line, 'git')) return true;
    const at = line.indexOf(BYTES.resultId);
    if (at < 0 || !state.pending.size) return false;
    const from = at + BYTES.resultId.length;
    const to = line.indexOf(34, from);
    return to > from && to - from <= 100 && state.pending.has(line.toString('latin1', from, to));
  }
  if (has(line, 'bash') || has(line, 'end') || has(line, 'sequence') || has(line, 'user')) return true;
  if (has(line, 'edit') || has(line, 'write') || has(line, 'multi') || has(line, 'notebook')) return true;
  // Any later assistant row settles an open question, so while one is open assistant rows are read too.
  return Boolean(state.asked) && has(line, 'assistant');
}

/** Parses complete transcript lines into `state` (mutated). `partial`: the first line may be cut and is dropped.
 *  `ownIds`: the session ids whose rows are this session's own (see ownLine in edited-files.mjs); rows of any other
 *  session are skipped. `sidechain`: a sub-agent's transcript, whose rows are all sub-agent rows and which asks the
 *  person nothing. */
export function parseWorkBuffer(buffer, state, { limits = WORK_LIMITS, homeDir = null, partial = false, ownIds = null, sidechain = false } = {}) {
  const options = { limits: { ...WORK_LIMITS, ...limits }, homeDir, sidechain };
  const owners = ownIds instanceof Set ? ownIds : Array.isArray(ownIds) ? new Set(ownIds) : null;
  state.owner ??= ownerState();
  const release = settle => { const held = releaseHeld(state.owner, settle); if (held.length) addEdited(state, held, options.limits); };
  let pos = 0;
  if (partial) { const first = buffer.indexOf(10); pos = first < 0 ? buffer.length : first + 1; }
  while (pos < buffer.length) {
    let end = buffer.indexOf(10, pos);
    if (end < 0) end = buffer.length;
    const line = buffer.subarray(pos, end);
    pos = end + 1;
    if (line[0] !== 123 || line.length > options.limits.lineBytes) continue;
    if (!ownLine(line, state.owner, owners)) continue;
    if (state.owner.held.length) release();
    // File-history lines lead with their type, so the first bytes decide; only names and backupTime are read from them.
    if (line.subarray(0, 64).indexOf(BYTES.history) >= 0) {
      try { addEdited(state, ownEdits(historyEdits(JSON.parse(line.toString('utf8')), options.limits.edited), state.owner, owners), options.limits); } catch { /* a cut line */ }
      continue;
    }
    if (!wanted(line, state)) continue;
    let row;
    try { row = JSON.parse(line.toString('utf8')); } catch { continue; }
    if (!isObject(row) || (row.isSidechain === true && !sidechain)) continue;
    const at = isoTime(row.timestamp);
    const cwd = absPath(row.cwd);
    if (row.type === 'assistant') onAssistant(row, at, cwd, state, options);
    else if (row.type === 'user') onUser(row, at, cwd, state, options);
  }
  release({ endOfPass: true });
  return state;
}
/** The same for text (tests and callers that already hold a string). */
export function parseWorkText(text, state, options = {}) {
  return parseWorkBuffer(Buffer.from(String(text), 'utf8'), state, options);
}

/** What a session's work log says, as plain data for the session object, or null when it says nothing. */
export function workLogOf(state) {
  if (!state) return null;
  const log = {
    git: state.git.map(item => ({ ...item })), tests: state.tests.map(item => ({ ...item })),
    edited: [...state.edited].reverse().map(([file, at]) => ({ path: file, at })),
    asked: state.asked ? { at: state.asked.at } : null, lastUserAt: state.lastUserAt,
  };
  return log.git.length || log.tests.length || log.edited.length || log.asked || log.lastUserAt ? log : null;
}
/** One session's log from its own transcript and its sub-agents' (each a workLogOf result or null): git actions and
 *  test runs newest first, each file at its newest time, and the question and the person's last message from the
 *  session's own transcript only. Capped like one log. */
export function mergeWorkLogs(main, helpers = [], limits = WORK_LIMITS) {
  const lim = { ...WORK_LIMITS, ...limits };
  const parts = [main, ...helpers].filter(Boolean);
  if (parts.length <= 1) return main ?? (parts[0] ? { ...parts[0], asked: null, lastUserAt: null } : null);
  const byTime = (a, b) => (b.at ?? 0) - (a.at ?? 0);
  const git = parts.flatMap(part => part.git).sort(byTime).slice(0, lim.git);
  const tests = parts.flatMap(part => part.tests).sort(byTime).slice(0, lim.tests);
  const files = new Map();
  for (const part of parts) for (const item of part.edited) if (!files.has(item.path) || (item.at ?? 0) > (files.get(item.path) ?? 0)) files.set(item.path, item.at ?? files.get(item.path) ?? null);
  const edited = [...files].map(([file, at]) => ({ path: file, at })).sort(byTime).slice(0, lim.edited);
  const log = { git, tests, edited, asked: main?.asked ?? null, lastUserAt: main?.lastUserAt ?? null };
  return git.length || tests.length || edited.length || log.asked || log.lastUserAt ? log : null;
}

/** One pass over a transcript. The first look starts at most firstBytes before the end; later looks read only what was
 *  appended since, at most passBytes at a time, from the offset remembered per file. A read that starts mid-line drops
 *  that line; a new inode or a file that shrank starts over. Returns `previous` itself when nothing was appended;
 *  `caughtUp` says whether this pass reached the end of the file as it was when opened, so a caller never takes a
 *  pass that stopped short (a large growth, an over-long line) for one that has read everything. */
export async function readWorkLog(file, previous, { limits = WORK_LIMITS, homeDir = null, ownIds = null, sidechain = false } = {}) {
  const lim = { ...WORK_LIMITS, ...limits };
  const { handle, stat } = await openRead(file);
  try {
    const size = Number(stat.size), dev = Number(stat.dev), ino = Number(stat.ino);
    const same = Boolean(previous) && previous.dev === dev && previous.ino === ino && size >= previous.consumed;
    if (same && size === previous.consumed) return previous;
    const start = same ? previous.consumed : Math.max(0, size - Math.min(lim.firstBytes, size));
    const most = same ? lim.passBytes : lim.firstBytes;
    const length = Math.min(size - start, most);
    const buffer = await readRange(handle, start, length);
    const next = same ? { ...previous, dev, ino } : { dev, ino, consumed: start, aligned: start === 0, state: emptyWorkState() };
    // A first look that starts partway in may start past the rows a fork copied from another session; the file's first
    // rows say whether it is one.
    if (!same && start > 0 && ownIds) next.state.owner.forked = headForked(await readRange(handle, 0, Math.min(size, lim.headBytes)), ownIds instanceof Set ? ownIds : new Set(ownIds));
    const end = buffer.lastIndexOf(10) + 1;
    if (end > 0) {
      parseWorkBuffer(buffer.subarray(0, end), next.state, { limits: lim, homeDir, partial: !next.aligned, ownIds, sidechain });
      next.consumed = start + end;
      next.aligned = true;
    } else if (buffer.length >= most) {
      // One line longer than a whole pass: skip past it; the next pass drops the rest of it up to its newline.
      next.consumed = start + buffer.length;
      next.aligned = false;
    }
    next.caughtUp = start + buffer.length >= size;
    return next;
  } finally { await handle.close().catch(() => {}); }
}
