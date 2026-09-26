// Fixed first-pass evaluation set. Do not revise after seeing a model's results.
// Model input is ONLY { records, events, corrections }; expected, category, title,
// and provenance are evaluation metadata and must never enter its prompt.
// Observed-context cases are adaptations of Summon work discussed in this task,
// not transcript exports. All identifiers, wording, and project names are synthetic.
// Corrections are prior explicit user decisions, ordered oldest to newest.
// A null decision status means "do not change status", not "status is unknown".
// Attach decisions use parentId:null: attaching evidence does not mutate parentage.

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const workOrganizerFixtureVersion = '2026-09-21.initial';

export const workOrganizerCases = deepFreeze([
  {
    id: 'semantic-continuation',
    title: 'A differently worded symptom continues an existing task',
    category: 'continuation',
    provenance: {
      kind: 'deidentified-observed-context',
      note: 'Adapted from selected-workspace context isolation work; no original text or personal project names.',
    },
    records: [
      { id: 'o-context', repoId: 'repo-summon', title: 'Make workspace context trustworthy', kind: 'outcome', parentId: null, status: 'working' },
      { id: 't-isolation', repoId: 'repo-summon', title: 'Keep the current-context summary within the selected project', kind: 'task', parentId: 'o-context', status: 'needs-verification' },
      { id: 't-switch-speed', repoId: 'repo-summon', title: 'Make project switching immediate', kind: 'task', parentId: 'o-context', status: 'working' },
    ],
    events: [
      { id: 'e-isolation', repoId: 'repo-summon', sessionId: 'session-new', role: 'user', text: 'The selection changes immediately now, but after switching from Atlas to Birch, the summary still mentions the Atlas follow-up. Please fix that remaining leak.' },
    ],
    corrections: [],
    expected: [
      { eventId: 'e-isolation', action: ['attach'], targetIds: ['t-isolation'], parentIds: [null], statuses: ['working', null] },
    ],
  },
  {
    id: 'explicit-task-checkpoint',
    title: 'An explicit task identifier beats a related record title',
    category: 'exact-reporting',
    provenance: {
      kind: 'deidentified-observed-context',
      note: 'Adapted from usage-probe repair and installed-app verification checkpoints.',
    },
    records: [
      { id: 'o-usage', repoId: 'repo-summon', title: 'Show reliable agent usage', kind: 'outcome', parentId: null, status: 'working' },
      { id: 't-usage-reader', repoId: 'repo-summon', title: 'Read the installed CLI usage limits correctly', kind: 'task', parentId: 'o-usage', status: 'working' },
      { id: 't-usage-display', repoId: 'repo-summon', title: 'Repair the usage meter display', kind: 'task', parentId: 'o-usage', status: 'working' },
    ],
    events: [
      { id: 'e-usage-report', repoId: 'repo-summon', sessionId: 'session-repair', role: 'assistant', text: 'Checkpoint for work item t-usage-reader: needs-verification. The environment option that made the usage meter show an empty reading is removed, and reader tests pass. The installed app has not been rebuilt or checked. Next step: verify the installed CLI reading through the app.' },
    ],
    corrections: [],
    expected: [
      { eventId: 'e-usage-report', action: ['attach'], targetIds: ['t-usage-reader'], parentIds: [null], statuses: ['needs-verification'], critical: 'Preserve the explicitly reported task and incomplete verification state; do not finish the task or its outcome.' },
    ],
  },
  {
    id: 'new-task-existing-outcome',
    title: 'A session changes subject to work under another existing outcome',
    category: 'task-decomposition',
    provenance: {
      kind: 'deidentified-observed-context',
      note: 'Adapted from distinct computer-task teaching and usage-meter work in Summon.',
    },
    records: [
      { id: 'o-usage', repoId: 'repo-summon', title: 'Show reliable agent usage', kind: 'outcome', parentId: null, status: 'working' },
      { id: 't-usage', repoId: 'repo-summon', title: 'Repair empty usage readings', kind: 'task', parentId: 'o-usage', status: 'needs-verification' },
      { id: 'o-teaching', repoId: 'repo-summon', title: 'Teach and replay reusable computer tasks', kind: 'outcome', parentId: null, status: 'working' },
      { id: 't-teaching-fields', repoId: 'repo-summon', title: 'Allow variable field values in saved demonstrations', kind: 'task', parentId: 'o-teaching', status: 'done' },
    ],
    events: [
      { id: 'e-teaching-keyboard', repoId: 'repo-summon', sessionId: 'session-usage-repair', role: 'user', text: 'Leave the usage work at its current checkpoint. Next, add keyboard-shortcut capture to the task teaching feature so a saved demonstration can replay a shortcut. Plan it under the existing teaching effort.' },
    ],
    corrections: [],
    expected: [
      { eventId: 'e-teaching-keyboard', action: ['create_task'], targetIds: [null], parentIds: ['o-teaching'], statuses: ['planned'], critical: 'Session continuity must not attach a new teaching task to the usage outcome.' },
    ],
  },
  {
    id: 'genuine-new-outcome',
    title: 'A clear new product outcome deserves its own durable record',
    category: 'new-outcome',
    provenance: {
      kind: 'synthetic',
      note: 'Invented distinct product direction to test creation rather than compulsory attachment or abstention.',
    },
    records: [
      { id: 'o-context', repoId: 'repo-summon', title: 'Make workspace context trustworthy', kind: 'outcome', parentId: null, status: 'working' },
      { id: 'o-teaching', repoId: 'repo-summon', title: 'Teach and replay reusable computer tasks', kind: 'outcome', parentId: null, status: 'working' },
    ],
    events: [
      { id: 'e-new-outcome', repoId: 'repo-summon', sessionId: 'session-planning', role: 'user', text: 'Track a new separate outcome for Summon: support collaborative workspaces shared across two computers. It will eventually include device pairing, conflict resolution, and shared activity history. Put it in planned work; we are not starting implementation today.' },
    ],
    corrections: [],
    expected: [
      { eventId: 'e-new-outcome', action: ['create_outcome'], targetIds: [null], parentIds: [null], statuses: ['planned'] },
    ],
  },
  {
    id: 'subagent-lifecycle-is-not-work',
    title: 'Child-agent lifecycle does not create or finish durable work',
    category: 'agent-work-separation',
    provenance: {
      kind: 'synthetic',
      note: 'Provider lifecycle telemetry inspired by the observed multiagent metadata feature; event text is invented.',
    },
    records: [
      { id: 'o-work-map', repoId: 'repo-summon', title: 'Make ongoing work understandable across sessions', kind: 'outcome', parentId: null, status: 'working' },
      { id: 't-child-state', repoId: 'repo-summon', title: 'Display reliable child-agent lifecycle state', kind: 'task', parentId: 'o-work-map', status: 'working' },
    ],
    events: [
      { id: 'e-child-ended', repoId: 'repo-summon', sessionId: 'session-parent', role: 'system', text: 'Provider lifecycle event: child agent agent-review-2, parent session session-parent, display name Review child lifecycle, state stopped, ended normally. This event contains no task checkpoint, review result, or completion evidence.' },
    ],
    corrections: [],
    expected: [
      { eventId: 'e-child-ended', action: ['ignore'], targetIds: [null], parentIds: [null], statuses: [null], critical: 'An agent name is not a work item, and an ended response does not prove task completion.' },
    ],
  },
  {
    id: 'unsupported-completion-claim',
    title: 'A confident completion phrase conflicts with its own evidence',
    category: 'completion-evidence',
    provenance: {
      kind: 'deidentified-observed-context',
      note: 'Adapted from the distinction between source checks and physical installed-app verification.',
    },
    records: [
      { id: 'o-teaching', repoId: 'repo-summon', title: 'Teach and replay reusable computer tasks', kind: 'outcome', parentId: null, status: 'working' },
      { id: 't-native-capture', repoId: 'repo-summon', title: 'Capture physical user clicks during a native task demonstration', kind: 'task', parentId: 'o-teaching', status: 'working' },
    ],
    events: [
      { id: 'e-capture-claim', repoId: 'repo-summon', sessionId: 'session-capture', role: 'assistant', text: 'Done: physical click capture is fixed for t-native-capture. All synthetic event tests passed. I have not tested physical input or rebuilt the installed app, so whether a real user click is captured is still unverified.' },
    ],
    corrections: [],
    expected: [
      { eventId: 'e-capture-claim', action: ['attach'], targetIds: ['t-native-capture'], parentIds: [null], statuses: ['needs-verification'], critical: 'Do not promote an unsupported completion claim to done when the same evidence explicitly leaves the deliverable unverified.' },
    ],
  },
  {
    id: 'cancelled-work-stays-cancelled',
    title: 'A resumed stale plan cannot reverse explicit cancellation',
    category: 'cancellation',
    provenance: {
      kind: 'synthetic',
      note: 'Invented stale-session recovery after explicit user cancellation.',
    },
    records: [
      { id: 'o-local-search', repoId: 'repo-summon', title: 'Find relevant workspace context locally', kind: 'outcome', parentId: null, status: 'working' },
      { id: 't-hosted-ranker', repoId: 'repo-summon', title: 'Add hosted ranking of workspace excerpts', kind: 'task', parentId: 'o-local-search', status: 'dismissed' },
    ],
    events: [
      { id: 'e-stale-plan', repoId: 'repo-summon', sessionId: 'session-restored', role: 'assistant', text: 'Resuming the old plan for t-hosted-ranker. Next I will send the selected workspace excerpts to the hosted ranking service and mark this task working.' },
    ],
    corrections: [
      { id: 'c-cancel-ranker', repoId: 'repo-summon', recordId: 't-hosted-ranker', rule: 'cancelled', text: 'User explicitly cancelled this task after that saved plan: keep retrieval local. Do not restart hosted ranking without a new user request.' },
    ],
    expected: [
      { eventId: 'e-stale-plan', action: ['ignore'], targetIds: [null], parentIds: [null], statuses: [null], critical: 'A stale assistant plan must not reopen dismissed work or override the user cancellation.' },
    ],
  },
  {
    id: 'rejected-grouping-is-sticky',
    title: 'Shared terminology cannot undo a user-corrected hierarchy',
    category: 'sticky-correction',
    provenance: {
      kind: 'synthetic',
      note: 'Invented semantic regrouping conflict to test durable user corrections.',
    },
    records: [
      { id: 'o-local-control', repoId: 'repo-summon', title: 'Speed up local computer control', kind: 'outcome', parentId: null, status: 'working' },
      { id: 'o-context', repoId: 'repo-summon', title: 'Make workspace context trustworthy', kind: 'outcome', parentId: null, status: 'working' },
      { id: 't-context-latency', repoId: 'repo-summon', title: 'Reduce delay before a selected workspace summary appears', kind: 'task', parentId: 'o-context', status: 'working' },
    ],
    events: [
      { id: 'e-summary-speed', repoId: 'repo-summon', sessionId: 'session-speed', role: 'assistant', text: 'Checkpoint for t-context-latency: I am still working on the slow local context summary. The latency profiling code is shared with the local computer-control speed work.' },
    ],
    corrections: [
      { id: 'c-parent-choice', repoId: 'repo-summon', recordId: 't-context-latency', rule: 'retain-parent', text: 'The user rejected grouping this task under o-local-control. Keep it under o-context: its deliverable is reliable selected-workspace context, even when it shares performance code.' },
    ],
    expected: [
      { eventId: 'e-summary-speed', action: ['attach'], targetIds: ['t-context-latency'], parentIds: [null], statuses: ['working', null], critical: 'Retain the user-corrected parent despite overlapping implementation and speed terminology.' },
    ],
  },
  {
    id: 'overlap-is-insufficient',
    title: 'A filename and branch do not disambiguate two possible tasks',
    category: 'ambiguity',
    provenance: {
      kind: 'synthetic',
      note: 'Invented incomplete checkpoint with equal implementation overlap.',
    },
    records: [
      { id: 'o-workspace', repoId: 'repo-summon', title: 'Improve the workspace dashboard', kind: 'outcome', parentId: null, status: 'working' },
      { id: 't-keyboard', repoId: 'repo-summon', title: 'Make workspace cards navigable by keyboard', kind: 'task', parentId: 'o-workspace', status: 'working' },
      { id: 't-selection', repoId: 'repo-summon', title: 'Keep the selected workspace card visible during updates', kind: 'task', parentId: 'o-workspace', status: 'working' },
    ],
    events: [
      { id: 'e-vague-checkpoint', repoId: 'repo-summon', sessionId: 'session-unlinked', role: 'assistant', text: 'Still working on that card change in WorkspacePanel.tsx on branch dashboard. Both open card tasks touch this file and branch. I have not included the task ID, desired behavior, or which task I mean in this checkpoint.' },
    ],
    corrections: [],
    expected: [
      { eventId: 'e-vague-checkpoint', action: ['defer'], targetIds: [null], parentIds: [null], statuses: [null], critical: 'Keep ambiguous work visible for reconciliation instead of choosing a task or creating a duplicate from filename overlap.' },
    ],
  },
  {
    id: 'crash-recovery-deduplication',
    title: 'A fresh session resumes already-saved work after a crash',
    category: 'recovery-deduplication',
    provenance: {
      kind: 'synthetic',
      note: 'Invented crash after durable save but before the old session acknowledged it.',
    },
    records: [
      { id: 'o-loose-ends', repoId: 'repo-summon', title: 'Capture and resurface unfinished work across sessions', kind: 'outcome', parentId: null, status: 'working' },
      { id: 't-return-followups', repoId: 'repo-summon', title: 'Resurface unresolved follow-ups when returning to a project', kind: 'task', parentId: 'o-loose-ends', status: 'planned' },
    ],
    events: [
      { id: 'e-resume-followups', repoId: 'repo-summon', sessionId: 'session-after-crash', role: 'user', text: 'The app crashed after saving my last request, before the agent replied. Continue that work now: when I come back to a project, show me the follow-ups I left unresolved, so I do not have to remember which conversation they were in.' },
    ],
    corrections: [],
    expected: [
      { eventId: 'e-resume-followups', action: ['attach'], targetIds: ['t-return-followups'], parentIds: [null], statuses: ['working', null], critical: 'A new session and missing acknowledgement must not duplicate the already-persisted deliverable.' },
    ],
  },
  {
    id: 'same-title-different-project',
    title: 'Project scope beats an identical title and explicit foreign ID',
    category: 'project-boundary',
    provenance: {
      kind: 'synthetic',
      note: 'Invented pair of projects and copied checkpoint; no personal project names.',
    },
    records: [
      { id: 'a-outcome', repoId: 'repo-atlas', title: 'Make account access reliable', kind: 'outcome', parentId: null, status: 'working' },
      { id: 'a-retry', repoId: 'repo-atlas', title: 'Fix the retry button after sign-in fails', kind: 'task', parentId: 'a-outcome', status: 'working' },
      { id: 'b-outcome', repoId: 'repo-birch', title: 'Make account access reliable', kind: 'outcome', parentId: null, status: 'working' },
      { id: 'b-retry', repoId: 'repo-birch', title: 'Fix the retry button after sign-in fails', kind: 'task', parentId: 'b-outcome', status: 'planned' },
    ],
    events: [
      { id: 'e-birch-retry', repoId: 'repo-birch', sessionId: 'session-birch', role: 'user', text: 'Start fixing the retry button after failed sign-in in Birch. I copied a-retry from my Atlas notes, but that ID is for the other project. This request is only for Birch.' },
    ],
    corrections: [],
    expected: [
      { eventId: 'e-birch-retry', action: ['attach'], targetIds: ['b-retry'], parentIds: [null], statuses: ['working', null], critical: 'Never attach, reparent, or change status across repository scope because of a copied foreign ID or matching title.' },
    ],
  },
  {
    id: 'verified-child-completion',
    title: 'Verified completion finishes the named task while its outcome stays open',
    category: 'verified-completion',
    provenance: {
      kind: 'synthetic',
      note: 'Invented explicit acceptance evidence to test justified completion and avoid rewarding blanket abstention.',
    },
    records: [
      { id: 'o-work-map', repoId: 'repo-summon', title: 'Make ongoing work understandable across sessions', kind: 'outcome', parentId: null, status: 'working' },
      { id: 't-failure-label', repoId: 'repo-summon', title: 'Preserve failed and interrupted child-agent states in the work tree', kind: 'task', parentId: 'o-work-map', status: 'needs-verification' },
      { id: 't-capture-work', repoId: 'repo-summon', title: 'Automatically capture and reconcile work across sessions', kind: 'task', parentId: 'o-work-map', status: 'planned' },
    ],
    events: [
      { id: 'e-accepted-child-state', repoId: 'repo-summon', sessionId: 'session-acceptance', role: 'user', text: 'I verified t-failure-label in the newly installed app with both an interrupted child and a failed child after they ended. Both kept the correct labels, including after restart. That task meets its acceptance criteria; mark it done. The automatic work capture task has not started.' },
    ],
    corrections: [],
    expected: [
      { eventId: 'e-accepted-child-state', action: ['attach'], targetIds: ['t-failure-label'], parentIds: [null], statuses: ['done'], critical: 'Accept explicit verified task completion without marking the parent outcome or unfinished sibling done.' },
    ],
  },
]);

export default workOrganizerCases;
