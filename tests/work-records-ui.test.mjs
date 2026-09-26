import test from 'node:test';
import assert from 'node:assert/strict';
import { goalDraft, goalInput, completionProblem, savePreviewGoal, workConflicts, workPriority, goalHasSession, goalForSession, preferredGoalSession } from '../src/renderer/work-records.ts';

const goal = (id, patch = {}) => ({ id, repoId: 'repo', title: id, status: 'planned', parentId: null, dependsOn: [], links: { placeId: null, branch: null, sessionKey: null, component: null }, createdAt: '2026-09-20T12:00:00Z', updatedAt: '2026-09-20T12:00:00Z', revision: 1, ...patch });

test('adopting inferred completion preserves source without treating the report as verified', () => {
  const suggested = goal('inferred-preview', { status: 'done', inference: { summary: 'Session reports the picker works.', evidence: ['User requested a picker.', 'Assistant reports it is implemented.'], updatedAt: '2026-09-20T13:00:00Z' } });
  const draft = goalDraft(suggested);
  assert.equal(draft.id, undefined);
  assert.equal(draft.expectedRevision, undefined);
  assert.equal(draft.status, 'needs-verification');
  assert.equal(draft.completion.kind, 'reported');
  assert.deepEqual(draft.origin, { summary: suggested.inference.summary, evidence: suggested.inference.evidence, capturedAt: suggested.inference.updatedAt });
  const input = goalInput(draft, 'repo');
  assert.ok(!('inference' in input));
  assert.ok(!('expectedRevision' in input));
  draft.origin.evidence.push('Changed locally');
  assert.equal(suggested.inference.evidence.length, 2);
});

test('draft saves use the revision originally opened and omit server history', () => {
  const stored = goal('durable', { revision: 7, ownerSessionKey: 'dead-session', sessionKeys: ['dead-session'], history: [{ actor: 'agent' }], scopePaths: ['src/'], coordinationKeys: ['shared-contract'] });
  const draft = goalDraft(stored);
  draft.scopePaths.push('', 'src/core', 'src/core');
  const input = goalInput(draft, 'repo');
  assert.equal(input.expectedRevision, 7);
  assert.equal(input.ownerSessionKey, 'dead-session');
  assert.deepEqual(input.scopePaths, ['src', 'src/core']);
  assert.ok(!('revision' in input));
  assert.ok(!('history' in input));
  assert.ok(!('sessionKeys' in input));
});

test('preview rejects stale saves while preserving old attempts on reassignment', () => {
  const current = goal('work', { revision: 4, ownerSessionKey: 'old-session', sessionKeys: ['old-session'], parentId: 'parent' });
  assert.throws(() => savePreviewGoal({ id: 'work', repoId: 'repo', expectedRevision: 3, nextStep: 'Overwrite' }, [current]), /changed while you were editing/);
  const saved = savePreviewGoal({ id: 'work', repoId: 'repo', expectedRevision: 4, parentId: null, ownerSessionKey: 'new-session', nextStep: 'Verify the result' }, [current]).find(item => item.id === 'work');
  assert.equal(saved.revision, 5);
  assert.ok(!('expectedRevision' in saved));
  assert.equal(saved.parentId, null);
  assert.deepEqual(saved.sessionKeys, ['old-session', 'new-session']);
  assert.equal(saved.history.at(-1).sessionKey, 'new-session');
});

test('done requires confirmation, completed checks and done dependencies', () => {
  const candidate = goal('work', { status: 'done', completion: { kind: 'reported', summary: 'Implemented' }, checklist: [{ id: 'a', text: 'Verify', done: false }], dependsOn: ['dependency'] });
  assert.match(completionProblem(candidate, []), /Confirm the outcome/);
  candidate.completion.kind = 'confirmed';
  assert.match(completionProblem(candidate, []), /every checklist item/);
  candidate.checklist[0].done = true;
  assert.match(completionProblem(candidate, [goal('dependency')]), /dependencies/);
  assert.equal(completionProblem(candidate, [goal('dependency', { status: 'done' })]), null);
});

test('conflict warnings honor unavailable owners, path boundaries and symmetric serial constraints', () => {
  const mine = goal('mine', { scopePaths: ['src/router'], coordinationKeys: ['contract'] });
  const active = goal('active', { status: 'working', ownerSessionKey: 'closed-session', scopePaths: ['src/router/policy.mjs'], coordinationKeys: ['contract'], serialWith: ['mine'] });
  assert.equal(workConflicts(mine, [active])[0].reasons.length, 3);
  assert.deepEqual(workConflicts(goal('other', { scopePaths: ['src/route'] }), [active]), []);
  assert.deepEqual(workConflicts(mine, [{ ...active, repoId: 'different-repo' }]), []);
  assert.deepEqual(workConflicts(mine, [{ ...active, ownerSessionKey: null }]), []);
  assert.throws(() => savePreviewGoal({ repoId: 'repo', title: 'New attempt', status: 'working', scopePaths: ['src/router'] }, [active]), /Coordinate/);
});

test('verification and blocked goals lead the work queue', () => {
  const goals = ['done', 'planned', 'working', 'blocked', 'needs-verification', 'dismissed'].map(status => goal(status, { status }));
  assert.deepEqual(goals.sort((a, b) => workPriority(a) - workPriority(b)).map(item => item.status), ['needs-verification', 'blocked', 'working', 'planned', 'done', 'dismissed']);
});

// Render the actual TSX so session loss and provenance remain visible, rather
// than testing only the derived record values.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { runInThisContext } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import * as recordHelpers from '../src/renderer/work-records.ts';
const require = createRequire(import.meta.url);
function component(filename, name) {
  const code = ts.transpileModule(fs.readFileSync(new URL(`../src/renderer/${filename}`, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const mod = { exports: {} };
  runInThisContext(`(function(require,module,exports){${code}\n})`)(id => id === './work-records' ? recordHelpers : require(id), mod, mod.exports);
  return mod.exports[name];
}

test('inspector retains dead-session ownership, source evidence and reported completion as text', () => {
  const Inspector = component('WorkRecordInspector.tsx', 'WorkRecordInspector');
  const record = goal('verification', { status: 'needs-verification', nextStep: 'Check the microphone in the installed app.', ownerSessionKey: 'ended-session', sessionKeys: ['older-session'], origin: { summary: 'Identified in a previous session.', evidence: ['User requested an actual microphone test.'], capturedAt: '2026-09-20T12:00:00Z' }, completion: { kind: 'reported', summary: 'The build passed.', reference: 'https://example.test/proof' } });
  const html = renderToStaticMarkup(React.createElement(Inspector, { goal: record, goals: [record], sessions: [], onSelect() {} }));
  assert.match(html, /Owner unavailable · needs continuation/);
  assert.match(html, /Ownership is retained/);
  assert.match(html, /User requested an actual microphone test/);
  assert.match(html, /Completion report/);
  assert.match(html, /ended-session/);
  assert.match(html, /older-session/);
  assert.doesNotMatch(html, /<a\b/);
});

test('editor exposes incomplete verification gates and retains an unavailable owner option', () => {
  const Editor = component('WorkRecordEditor.tsx', 'WorkRecordEditor');
  const draft = goalDraft(goal('work', { status: 'done', ownerSessionKey: 'missing-session', completion: { kind: 'reported', summary: 'Looks complete.', reference: '' } }));
  const html = renderToStaticMarkup(React.createElement(Editor, { draft, goals: [], repo: { branches: [], places: [] }, sessions: [], repository: { codebase: { nodes: [] } }, saving: false, error: '', onChange() {}, onSave() {}, onCancel() {} }));
  assert.match(html, /Assigned session unavailable · needs continuation/);
  assert.match(html, /Confirm the outcome/);
  assert.match(html, /type="submit" disabled=""/);
  assert.match(html, /Settled findings/);
  assert.match(html, /Ownership and parallel work/);
});

test('changing a completed outcome requires explicit reconfirmation in preview and editor', () => {
  const record = goal('finished', { status: 'done', acceptanceCriteria: 'Original behavior', checklist: [], scopePaths: [], completion: { kind: 'confirmed', summary: 'Original behavior verified', reference: '' } });
  assert.throws(() => savePreviewGoal({ id: record.id, repoId: 'repo', expectedRevision: 1, acceptanceCriteria: 'Expanded behavior' }, [record]), /explicitly reconfirm/);
  const Editor = component('WorkRecordEditor.tsx', 'WorkRecordEditor');
  const draft = goalDraft(record);
  draft.acceptanceCriteria = 'Expanded behavior';
  const html = renderToStaticMarkup(React.createElement(Editor, { draft, goals: [record], repo: { branches: [], places: [] }, sessions: [], repository: { codebase: { nodes: [] } }, saving: false, error: '', onChange() {}, onSave() {}, onCancel() {} }));
  assert.match(html, /I verified the revised outcome/);
  assert.match(html, /type="submit" disabled=""/);
});

test('legacy done metadata edits preserve history without fabricating verification', () => {
  const historical = goal('legacy', { status: 'done', completion: { kind: 'legacy', summary: 'Marked done before verification records existed.', reference: '' } });
  const draft = goalDraft(historical);
  draft.nextStep = 'Retain this conclusion for future sessions.';
  draft.findings = [{ id: 'finding', text: 'The original implementation already handles empty input.', evidence: 'Existing implementation and test.', revisitWhen: 'Input contract changes.' }];
  assert.equal(completionProblem(draft, [historical]), null);
  const saved = savePreviewGoal(goalInput(draft, 'repo'), [historical]).find(item => item.id === 'legacy');
  assert.equal(saved.status, 'done');
  assert.deepEqual(saved.completion, historical.completion);
  assert.equal(saved.findings.length, 1);
  assert.equal(saved.nextStep, draft.nextStep);

  const Editor = component('WorkRecordEditor.tsx', 'WorkRecordEditor');
  const html = renderToStaticMarkup(React.createElement(Editor, { draft, goals: [historical], repo: { branches: [], places: [] }, sessions: [], repository: { codebase: { nodes: [] } }, saving: false, error: '', onChange() {}, onSave() {}, onCancel() {} }));
  assert.doesNotMatch(html, /type="submit" disabled=""/);
  assert.match(html, /Historical completion note/);
  assert.doesNotMatch(html, /I verified the revised outcome/);

  draft.acceptanceCriteria = 'A new requirement';
  assert.match(completionProblem(draft, [historical]), /Confirm the outcome/);
  assert.throws(() => savePreviewGoal(goalInput(draft, 'repo'), [historical]), /explicitly reconfirm/);
  assert.match(completionProblem({ ...draft, id: undefined }, []), /Confirm the outcome/);
});

test('unchanged historical completion permits notes when an old dependency is reopened', () => {
  const historical = goal('legacy-parent', { status: 'done', dependsOn: ['dependency'], completion: { kind: 'legacy', summary: 'Historical completion.', reference: '' } });
  const dependency = goal('dependency', { status: 'planned' });
  const draft = goalDraft(historical);
  draft.nextStep = 'Keep this historical record.';
  assert.equal(completionProblem(draft, [historical, dependency]), null);
  draft.completion = { kind: 'confirmed', summary: 'New verification.', reference: '' };
  assert.match(completionProblem(draft, [historical, dependency]), /dependencies/);
});

test('sessions find owned and historical work even without an explicit session link', () => {
  const owned = goal('owned', { ownerSessionKey: 'current-session', sessionKeys: ['dead-session'] });
  const unrelated = goal('unrelated');
  assert.equal(goalForSession([unrelated, owned], 'current-session'), owned);
  assert.equal(goalForSession([unrelated, owned], 'dead-session'), owned);
  assert.equal(goalHasSession(owned, 'dead-session'), true);
  assert.equal(goalHasSession(owned, 'unrelated-session'), false);
  const linked = goal('linked', { links: { ...owned.links, sessionKey: 'current-session' } });
  assert.equal(goalForSession([linked, owned], 'current-session'), owned);
});

test('goal selection prefers the current owner and falls back to retained session associations', () => {
  const record = goal('work', { ownerSessionKey: 'owner', links: { placeId: null, branch: null, sessionKey: 'linked', component: null }, sessionKeys: ['old-attempt', 'recent-attempt'] });
  assert.equal(preferredGoalSession(record, [{ key: 'linked' }, { key: 'owner' }]), 'owner');
  assert.equal(preferredGoalSession(record, [{ key: 'linked' }]), 'linked');
  assert.equal(preferredGoalSession(record, [{ key: 'old-attempt' }, { key: 'recent-attempt' }]), 'recent-attempt');
  assert.equal(preferredGoalSession(record, []), 'linked');
  assert.equal(preferredGoalSession(goal('only-owner', { ownerSessionKey: 'unavailable-owner' }), []), 'unavailable-owner');
});

test('editing retains explicit external dependencies and delegated agent identity', () => {
  const stored = goal('legal', { links: { placeId: null, branch: null, sessionKey: 'claude:parent', agentId: 'child-7', component: null }, crossRepoDependsOn: [{ repoId: 'shared', goalId: 'policy' }] });
  const draft = goalDraft(stored);
  draft.nextStep = 'Review the delegated result.';
  const input = goalInput(draft, 'repo');
  assert.deepEqual(input.crossRepoDependsOn, stored.crossRepoDependsOn);
  assert.equal(input.links.agentId, 'child-7');
  draft.crossRepoDependsOn.push({ repoId: 'shared', goalId: 'terms' });
  assert.equal(stored.crossRepoDependsOn.length, 1, 'Draft relationships must not mutate the saved record');
});

test('external prerequisites gate preview starting and confirmation', () => {
  const prerequisite = goal('policy', { repoId: 'shared' });
  const work = goal('legal', { crossRepoDependsOn: [{ repoId: 'shared', goalId: 'policy' }] });
  assert.throws(() => savePreviewGoal({ ...goalInput(goalDraft(work), 'repo'), status: 'working' }, [work, prerequisite]), /dependencies in other projects/);
  const done = { ...work, status: 'done', completion: { kind: 'confirmed', summary: 'Reviewed result' } };
  assert.match(completionProblem(done, [work, prerequisite]), /dependencies in other projects/);
  assert.equal(completionProblem(done, [work, { ...prerequisite, status: 'done' }]), null);
});
