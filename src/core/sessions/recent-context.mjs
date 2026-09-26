// Recent conversational evidence for Summon's reasoning. These are untrusted excerpts, never instructions.
// Raw readers keep this in memory only; agent-sessions applies project privacy masks before publishing it.
export const CONTEXT_MESSAGES = 6;
export const CONTEXT_CHARS = 1000;
export const CONTEXT_LINE_BYTES = 64 * 1024;
const TEXT_TYPES = new Set(['text', 'input_text', 'output_text']);
const WRAPPER = /<(environment_context|system-reminder|system_reminder|instructions|permissions instructions|app-context|skills_instructions|user_instructions|developer_instructions|recommended_plugins|collaboration_mode|subagent_notification)\b[^>]*>[\s\S]*?<\/\1>/gi;
const INJECTED = /^(?:#\s*(?:AGENTS\.md|CLAUDE\.md)\s+instructions\b|\[Request interrupted by user|This session is being continued from a previous conversation|You are an AI assistant|<turn_aborted>|<local-command-|<command-name>)/i;
const cut = (text, max) => { const out = text.slice(0, max); return /[\ud800-\udbff]$/.test(out) ? out.slice(0, -1) : out; };

export function conversationText(content) {
  const raw = typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(part => part && TEXT_TYPES.has(part.type) && typeof part.text === 'string').slice(0, 16).map(part => part.text).join('\n') : '';
  if (!raw || INJECTED.test(raw.trim())) return null;
  const text = raw.replace(WRAPPER, ' ').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text || INJECTED.test(text)) return null;
  return cut(text, CONTEXT_CHARS);
}

export function recentContext(messages) {
  const kept = [];
  // Bound work even when a malformed reader sends an unexpectedly long list.
  for (const row of (Array.isArray(messages) ? messages : []).slice(-48)) {
    if (!row || !['user', 'assistant'].includes(row.role)) continue;
    const text = conversationText(row.text ?? row.content);
    if (!text) continue;
    const at = typeof row.at === 'string' ? Date.parse(row.at) : row.at;
    const item = { role: row.role, text, at: Number.isFinite(at) && at > 0 ? at : null };
    const previous = kept.at(-1);
    if (previous?.role === item.role && previous.text === item.text && (previous.at === item.at || (previous.at && item.at && Math.abs(previous.at - item.at) < 2000))) continue;
    kept.push(item);
  }
  let bounded = kept.slice(-CONTEXT_MESSAGES);
  // A busy assistant may emit many updates before answering. Keep the latest actual request alongside them.
  if (!bounded.some(item => item.role === 'user')) {
    const latestUser = kept.findLast(item => item.role === 'user');
    if (latestUser) bounded = [latestUser, ...kept.slice(-(CONTEXT_MESSAGES - 1))];
  }
  return bounded.length ? { messages: bounded, updatedAt: Math.max(...bounded.map(item => item.at ?? 0)) || null } : null;
}
