#!/usr/bin/env node
// Summon hook reporter. Claude Code runs it as a settings hook (JSON on stdin); Codex runs it as `notify`
// (JSON as the last argument). It forwards the event name, session or thread id, folder, tool name and
// notification kind to the running Summon over its private socket, as one line with method "hook".
//   summon-hook.mjs <claude|codex> [--launch <tag>] [<json>]
// It never writes to stdout or stderr (Claude would show that to the model or to you), never reads prompt
// text, transcript paths, tool input or output, and always exits 0 within 0.9 s, whether or not Summon runs.
import net from 'node:net';
import { lstatSync } from 'node:fs';

const bail = setTimeout(() => process.exit(0), 900);
void bail;
process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied']);
const MAX_STDIN = 8 * 1024 * 1024; // PostToolUse payloads carry whole tool outputs; a cut payload would be dropped, not forwarded
const str = (value, max) => (typeof value === 'string' && value ? value.slice(0, max) : null);

const [app, ...rest] = process.argv.slice(2);
let launch = null;
const args = [];
for (let i = 0; i < rest.length; i++) { if (rest[i] === '--launch') launch = str(rest[++i], 64); else args.push(rest[i]); }

function send(payload) {
  const line = JSON.stringify(payload);
  if (line.length > 4096) process.exit(0);
  const socketPath = process.env.SUMMON_SOCKET || `/tmp/summon-${process.getuid?.() ?? 'local'}.sock`;
  let info;
  try { info = lstatSync(socketPath); } catch { process.exit(0); }
  if (!info.isSocket() || (process.getuid && info.uid !== process.getuid())) process.exit(0);
  const socket = net.connect(socketPath);
  socket.setTimeout(600, () => process.exit(0));
  socket.on('connect', () => socket.write(`${line}\n`));
  socket.on('data', () => {});
  socket.on('error', () => process.exit(0));
  socket.on('end', () => process.exit(0));
  socket.on('close', () => process.exit(0));
}

function claude(data) {
  const sessionId = str(data.session_id, 40);
  const event = str(data.hook_event_name, 40);
  if (!sessionId || !UUID.test(sessionId) || !event) process.exit(0);
  const kind = event === 'Notification' ? str(data.notification_type, 40) : event === 'SessionStart' ? str(data.source, 40) : event === 'SessionEnd' ? str(data.reason, 40) : null;
  // Preserve child identity on every event that supplies it. Never forward subagent prompts, responses or transcript paths.
  const child = {};
  for (const [source, target, max] of [['agent_id', 'agentId', 200], ['agent_type', 'agentType', 120]]) {
    const value = data[source];
    if (value !== undefined && value !== null) {
      if (typeof value !== 'string' || value.length > max || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value)) {
        if (source === 'agent_id') process.exit(0);
        continue; // An unsupported custom type must not hide an otherwise identified child lifecycle.
      }
      child[target] = value;
    }
  }
  send({ method: 'hook', v: 1, app: 'claude', event, sessionId: sessionId.toLowerCase(), cwd: str(data.cwd, 1024), toolName: TOOL_EVENTS.has(event) ? str(data.tool_name, 120) : null, kind, launch, ...child });
}

function codex(data) {
  if (data.type !== 'agent-turn-complete') process.exit(0);
  const sessionId = str(data['thread-id'], 40);
  if (!sessionId || !UUID.test(sessionId)) process.exit(0);
  send({ method: 'hook', v: 1, app: 'codex', event: 'agent-turn-complete', sessionId: sessionId.toLowerCase(), cwd: str(data.cwd, 1024), toolName: null, kind: null, launch });
}

function parse(text) {
  let data;
  try { data = JSON.parse(text); } catch { process.exit(0); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) process.exit(0);
  return data;
}

if (app === 'claude') {
  let text = '';
  let done = false;
  const finish = () => { if (done) return; done = true; claude(parse(text)); };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { text += chunk; if (text.length > MAX_STDIN) { process.stdin.destroy(); process.exit(0); } });
  process.stdin.on('end', finish);
  process.stdin.on('close', finish);
  process.stdin.on('error', () => process.exit(0));
} else if (app === 'codex') {
  codex(parse(args.at(-1) ?? ''));
} else {
  process.exit(0);
}
