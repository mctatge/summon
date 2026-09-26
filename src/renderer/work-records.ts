import type { VisualGoal, VisualGoalInput, WorkRecordFields, CrossRepoDependency } from './types';

export const WORK_STATUS: Record<VisualGoal['status'], string> = { planned: 'Planned', working: 'Working', blocked: 'Blocked', 'needs-verification': 'Needs verification', done: 'Done', deferred: 'Deferred', dismissed: 'Dismissed' };
export const inferredGoal = (goal: VisualGoal) => Boolean(goal.inference) || goal.id.startsWith('inferred-');
export type GoalDraft = WorkRecordFields & { id?: string; expectedRevision?: number; title: string; status: VisualGoal['status']; parentId: string; dependsOn: string[]; crossRepoDependsOn: CrossRepoDependency[]; agentId: string; placeId: string; branch: string; sessionKey: string; component: string };
export function goalDraft(goal?: VisualGoal, parentId = ''): GoalDraft {
  const inferred = goal && inferredGoal(goal);
  return {
    id: goal && !inferred ? goal.id : undefined, expectedRevision: goal && !inferred ? goal.revision ?? 1 : undefined,
    title: goal?.title ?? '', status: inferred && goal.status === 'done' ? 'needs-verification' : goal?.status ?? 'planned',
    parentId: inferred ? '' : goal?.parentId ?? parentId, dependsOn: goal?.dependsOn.filter(id => !id.startsWith('inferred-')) ?? [],
    crossRepoDependsOn: structuredClone(goal?.crossRepoDependsOn ?? []), agentId: goal?.links.agentId ?? '',
    placeId: goal?.links.placeId ?? '', branch: goal?.links.branch ?? '', sessionKey: goal?.links.sessionKey ?? '', component: goal?.links.component ?? '',
    acceptanceCriteria: goal?.acceptanceCriteria ?? '', nextStep: goal?.nextStep ?? '', checklist: structuredClone(goal?.checklist ?? []),
    findings: structuredClone(goal?.findings ?? []), evidence: structuredClone(goal?.evidence ?? []), ownerSessionKey: goal?.ownerSessionKey ?? null,
    scopePaths: [...goal?.scopePaths ?? []], coordinationKeys: [...goal?.coordinationKeys ?? []], serialWith: [...goal?.serialWith ?? []],
    origin: goal?.origin ? structuredClone(goal.origin) : goal?.inference ? { summary: goal.inference.summary, evidence: [...goal.inference.evidence], capturedAt: goal.inference.updatedAt } : null,
    completion: goal?.completion ? structuredClone(goal.completion) : inferred && goal.status === 'done' ? { kind: 'reported', summary: goal.inference?.summary || goal.title, reference: '' } : null,
  };
}
export function goalInput(draft: GoalDraft, repoId: string): VisualGoalInput {
  const { id, expectedRevision, placeId, branch, sessionKey, component, agentId, parentId, ...fields } = draft;
  return { ...fields, scopePaths: [...new Set(fields.scopePaths.map(value => value.trim().replace(/\/$/, '')).filter(Boolean))], coordinationKeys: [...new Set(fields.coordinationKeys.map(value => value.trim()).filter(Boolean))], ...(id ? { id, expectedRevision } : {}), repoId, title: draft.title.trim(), parentId: parentId || null, links: { agentId: agentId || null, placeId: placeId || null, branch: branch || null, sessionKey: sessionKey || null, component: component || null } };
}
type CompletionCandidate = Pick<VisualGoal, 'status' | 'completion' | 'checklist' | 'dependsOn'> & Partial<Pick<VisualGoal, 'id' | 'acceptanceCriteria' | 'scopePaths' | 'crossRepoDependsOn'>>;
export function completionDefinitionChanged(goal: CompletionCandidate, previous?: VisualGoal | null) {
  return previous?.status === 'done' && goal.status === 'done' && (['acceptanceCriteria', 'checklist', 'dependsOn', 'crossRepoDependsOn', 'scopePaths'] as const).some(key => JSON.stringify(previous[key] ?? (key === 'acceptanceCriteria' ? '' : [])) !== JSON.stringify(goal[key] ?? (key === 'acceptanceCriteria' ? '' : [])));
}
export function completionProblem(goal: CompletionCandidate, goals: VisualGoal[]) {
  if (goal.status !== 'done') return null;
  const previous = goal.id ? goals.find(item => item.id === goal.id) : null;
  // Keeping a migrated completion preserves its historical meaning; metadata
  // edits must not require inventing a new verification that never happened.
  const retainedCompletion = previous?.status === 'done' && ['confirmed', 'legacy'].includes(previous.completion?.kind ?? '') && JSON.stringify(previous.completion) === JSON.stringify(goal.completion) && !completionDefinitionChanged(goal, previous);
  if (!retainedCompletion && (goal.completion?.kind !== 'confirmed' || !goal.completion.summary.trim())) return 'Confirm the outcome with a short verification summary before marking it done.';
  if (goal.checklist?.some(item => !item.done)) return 'Complete every checklist item before marking this goal done.';
  if (!retainedCompletion && goal.dependsOn.some(id => goals.find(item => item.id === id)?.status !== 'done')) return 'Finish the dependencies before marking this goal done.';
  if (!retainedCompletion && goal.crossRepoDependsOn?.some(ref => goals.find(item => item.id === ref.goalId && item.repoId === ref.repoId)?.status !== 'done')) return 'Load and finish the dependencies in other projects before confirming this goal.';
  return null;
}

const pathInside = (a: string, b: string) => a === b || a.startsWith(`${b.replace(/\/$/, '')}/`);
export function workConflicts(goal: Pick<VisualGoal, 'id' | 'scopePaths' | 'coordinationKeys' | 'serialWith'> & { repoId?: string }, goals: VisualGoal[]) {
  return goals.filter(other => other.id !== goal.id && (!goal.repoId || other.repoId === goal.repoId) && other.status === 'working' && other.ownerSessionKey).flatMap(other => {
    const reasons: string[] = [];
    if (goal.serialWith?.includes(other.id) || other.serialWith?.includes(goal.id)) reasons.push('Explicitly marked to run one at a time');
    const paths = (goal.scopePaths ?? []).filter(a => other.scopePaths?.some(b => pathInside(a, b) || pathInside(b, a)));
    if (paths.length) reasons.push(`Overlapping scope: ${paths.join(', ')}`);
    const keys = (goal.coordinationKeys ?? []).filter(key => other.coordinationKeys?.includes(key));
    if (keys.length) reasons.push(`Shared decision: ${keys.join(', ')}`);
    return reasons.length ? [{ goal: other, reasons }] : [];
  });
}
export function goalHasSession(goal: VisualGoal, sessionKey: string) {
  return goal.ownerSessionKey === sessionKey || goal.links.sessionKey === sessionKey || goal.sessionKeys?.includes(sessionKey) === true;
}
export function goalForSession(goals: VisualGoal[], sessionKey: string) {
  return goals.find(goal => goal.ownerSessionKey === sessionKey) ?? goals.find(goal => goalHasSession(goal, sessionKey));
}
export function preferredGoalSession(goal: VisualGoal, sessions: Array<{ key: string }>) {
  const keys = [...new Set([goal.ownerSessionKey, goal.links.sessionKey, ...[...(goal.sessionKeys ?? [])].reverse()].filter((key): key is string => Boolean(key)))];
  return keys.find(key => sessions.some(session => session.key === key)) ?? goal.links.sessionKey ?? goal.ownerSessionKey ?? keys[0] ?? null;
}
export function workPriority(goal: VisualGoal) {
  return ({ 'needs-verification': 0, blocked: 1, working: 2, planned: 3, deferred: 4, done: 5, dismissed: 6 })[goal.status];
}
/** Browser preview observes the same concurrency and completion rules as native saves. */
export function savePreviewGoal(input: VisualGoalInput, existing: VisualGoal[], now = new Date().toISOString()): VisualGoal[] {
  const previous = input.id ? existing.find(item => item.id === input.id) : null;
  if (input.id && !previous) throw new Error('That goal no longer exists.');
  if (previous && input.expectedRevision !== (previous.revision ?? 1)) throw new Error('This goal changed while you were editing. Cancel and reopen it to use the latest version.');
  const id = input.id ?? `preview-${crypto.randomUUID()}`;
  const base = goalDraft(previous ?? undefined);
  const { expectedRevision: _, ...fields } = input;
  const { expectedRevision: _baseRevision, ...baseFields } = goalInput(base, input.repoId);
  const goal: VisualGoal = { ...baseFields, ...fields, id, repoId: input.repoId, title: input.title ?? previous?.title ?? '', status: input.status ?? previous?.status ?? 'planned', parentId: input.parentId !== undefined ? input.parentId : previous?.parentId ?? null, dependsOn: input.dependsOn ?? previous?.dependsOn ?? [], links: { placeId: null, branch: null, sessionKey: null, component: null, ...previous?.links, ...input.links }, revision: (previous?.revision ?? 0) + 1, createdAt: previous?.createdAt ?? now, updatedAt: now };
  const changedDefinition = completionDefinitionChanged(goal, previous);
  if (changedDefinition && input.completion?.kind !== 'confirmed') throw new Error('The completed outcome changed. Reopen it or explicitly reconfirm its completion.');
  const problem = completionProblem(goal, existing);
  if (problem) throw new Error(problem);
  if (goal.status === 'working' && goal.dependsOn.some(id => existing.find(item => item.id === id)?.status !== 'done')) throw new Error('Finish the dependencies before starting this goal.');
  if (goal.status === 'working' && goal.crossRepoDependsOn?.some(ref => existing.find(item => item.id === ref.goalId && item.repoId === ref.repoId)?.status !== 'done')) throw new Error('Finish the dependencies in other projects before starting this goal.');
  const conflicts = workConflicts(goal, existing);
  if (goal.status === 'working' && conflicts.length) throw new Error(`Coordinate with “${conflicts[0].goal.title}” before starting: ${conflicts[0].reasons.join('; ')}.`);
  goal.sessionKeys = [...new Set([...(previous?.sessionKeys ?? []), goal.links.sessionKey, goal.ownerSessionKey].filter((value): value is string => Boolean(value)))];
  goal.history = [...(previous?.history ?? []), { at: now, actor: 'user' as const, status: goal.status, nextStep: goal.nextStep ?? '', sessionKey: goal.ownerSessionKey ?? goal.links.sessionKey }].slice(-40);
  const next = [...existing.filter(item => item.id !== id), goal];
  const visited = new Set<string>(), visiting = new Set<string>();
  const visit = (key: string) => {
    if (visiting.has(key)) throw new Error('Goal relationships cannot contain a cycle.');
    if (visited.has(key)) return;
    const item = next.find(candidate => candidate.id === key);
    if (!item) throw new Error('A linked goal no longer exists.');
    visiting.add(key);
    for (const linked of [item.parentId, ...item.dependsOn, ...(item.crossRepoDependsOn ?? []).map(ref => ref.goalId)]) if (linked) visit(linked);
    visiting.delete(key); visited.add(key);
  };
  next.forEach(item => visit(item.id));
  return next;
}
