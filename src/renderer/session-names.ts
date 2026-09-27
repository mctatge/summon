import type { AgentSession, AgentSessionGoal, SessionTitleSource } from './types';
import { WORK_STATUS } from './work-records';

/* Summon's own session names (decisions 2026-09-26). The core decides the name: a plain name for the kind of work
   ('New project creation') that reads at a glance while your head is somewhere else, and an optional short line
   naming the specific thing. That line sits directly under the name; the app's own title steps back to the tooltip
   and the inspectors. Every view only reads these fields, defensively, since a window can outlive the app version
   that started sending them. Names, details, titles and goal titles are untrusted text, only ever rendered as text. */

/** Where the shown title came from. An older core sends no source, which means the app's own title. */
export const nameSource = (session: AgentSession): SessionTitleSource => session.titleSource === 'summon' || session.titleSource === 'goal' ? session.titleSource : 'native';
export const summonNamed = (session: AgentSession) => nameSource(session) !== 'native';

/** The app's own title, for tooltips and the inspectors, when Summon shows its own name in front and the two differ.
 *  A title the reader had to invent ('Untitled Claude session') is not worth quoting. */
export function appTitle(session: AgentSession): string | null {
  if (!summonNamed(session) || session.titleIsFallback) return null;
  const original = typeof session.originalTitle === 'string' ? session.originalTitle.trim() : '';
  return original && original !== session.title ? original : null;
}

/** The small line under a Summon name: the specific thing, never a repeat of the name. Goal and native titles have none. */
export function nameDetail(session: AgentSession): string | null {
  if (nameSource(session) !== 'summon') return null;
  const detail = typeof session.titleDetail === 'string' ? session.titleDetail.trim() : '';
  return detail && detail.toLowerCase() !== session.title.trim().toLowerCase() ? detail : null;
}

/** The app title a row still shows. A Summon name has its own detail line, so its app title waits in the tooltip; a goal
 *  name keeps it, since it is what tells apart two sessions serving the same goal. */
export const rowAppTitle = (session: AgentSession) => nameSource(session) === 'summon' ? null : appTitle(session);

/** The saved goal this session serves, when the core resolved one to a current goal. */
export function servedGoal(session: AgentSession): AgentSessionGoal | null {
  const goal = session.servesGoal;
  return goal && typeof goal.title === 'string' && goal.title.trim() && typeof goal.id === 'string' ? goal : null;
}

/** The goal as short words: its status alone when the name in front already says the goal. */
export function goalWords(session: AgentSession): { title: string; status: string; text: string; tip: string } | null {
  const goal = servedGoal(session);
  if (!goal) return null;
  const status = WORK_STATUS[goal.status] ?? 'Saved';
  const repeats = session.title.toLowerCase().includes(goal.title.trim().toLowerCase());
  return { title: goal.title, status, text: repeats ? `Saved goal · ${status}` : `${goal.title} · ${status}`, tip: `Serves your saved goal “${goal.title}” · ${status}` };
}

/** One plain sentence on where the name in front came from, for tooltips and the inspectors. */
export function nameOrigin(session: AgentSession): string | null {
  const source = nameSource(session);
  if (source === 'summon') return 'Named by Summon from the recent conversation';
  if (source === 'goal') return 'Named after the saved goal this session serves';
  return null;
}

export const OUTDATED_WORD = 'updating';
export const OUTDATED_TIP = 'The conversation has moved on since Summon named it. The name is renewed on a later pass.';
export const APP_TITLE_TIP = 'The title this session carries in its app. Summon never changes it.';
