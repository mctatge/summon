import type { AgentSession, AgentSessionsView, WifRepo } from './types';

export const ALL_PROJECTS = 'all';
export type VisualSessionScope = { value: string; label: string; repoId: string | null };

const ACTIVITY_ORDER: Record<AgentSession['activity'], number> = {
  'needs-you': 0, failed: 1, working: 2, open: 3, interrupted: 4, quiet: 5, unknown: 6,
};

/** Only the session's reported attribution determines its scope. A project name
 * or folder that resembles a repository never silently becomes that repository. */
export function sessionScope(session: AgentSession): string {
  if (session.repoId) return `repo:${session.repoId}`;
  if (session.project) return `project:${session.project}`;
  if (session.folder) return `folder:${session.folder}`;
  return 'unassigned';
}

function uniqueSessions(sessions: AgentSession[]): AgentSession[] {
  const seen = new Set<string>();
  return sessions.filter(session => {
    if (seen.has(session.key)) return false;
    seen.add(session.key);
    return true;
  });
}

/** Keep the first row for each exact session key. Attention and working sessions
 * precede history; stable sorting preserves source order within each activity. */
export function getVisualSessions(view: AgentSessionsView | null, scope = ALL_PROJECTS): AgentSession[] {
  const sessions = uniqueSessions((view?.groups ?? []).flatMap(group => group.sessions));
  return sessions.filter(session => scope === ALL_PROJECTS || sessionScope(session) === scope)
    .sort((a, b) => (ACTIVITY_ORDER[a.activity] ?? ACTIVITY_ORDER.unknown) - (ACTIVITY_ORDER[b.activity] ?? ACTIVITY_ORDER.unknown));
}

/** Git repositories and session-only contexts coexist. Unavailable repositories,
 * non-git projects, folders, and unattributed sessions remain selectable. */
export function getSessionScopes(repos: WifRepo[], sessions: AgentSession[]): VisualSessionScope[] {
  const scopes = new Map<string, VisualSessionScope>();
  scopes.set(ALL_PROJECTS, { value: ALL_PROJECTS, label: 'All projects', repoId: null });
  for (const repo of repos) {
    const value = `repo:${repo.id}`;
    if (!scopes.has(value)) scopes.set(value, { value, label: repo.name, repoId: repo.id });
  }
  for (const session of uniqueSessions(sessions)) {
    const value = sessionScope(session);
    if (scopes.has(value)) continue;
    const label = session.repoId
      ? session.project || session.folder || session.repoId
      : session.project || session.folder || 'Unassigned sessions';
    scopes.set(value, { value, label, repoId: session.repoId || null });
  }
  return [...scopes.values()];
}
