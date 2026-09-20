import type { Snapshot } from './types';
import type { WifFile, WifPlace, WorkInFlightStanding } from './types';
import type { AgentSession, AgentSessionAddress, AgentSessionWork, AgentSessionsView, LocatedAgentSession } from './types';
import type { WifStanding, WifStandingEntry, WifStandingNote, WifStandingRepo } from './types';
import type { VisualRepository, VisualGoal } from './types';

// These records only render in a regular browser without the native bridge.
// Preview never opens files, changes settings, or captures activity.
const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

// Synthetic data for the explicitly labelled browser preview only. Native reads never use these records.
export function previewVisualRepository(repoId: string): VisualRepository {
  const repo = previewWorkInFlight.repos.find(item => item.id === repoId);
  const sessions = previewAgentSessions.groups.flatMap(group => group.sessions).filter(session => session.repoId === repoId);
  const firstPlace = repo?.places[0];
  const branch = repo?.branches.find(item => !item.merged);
  const oid = (shortId: string) => shortId.padEnd(40, '0');
  const head = oid(firstPlace?.head || '4f2a91c0');
  const branchTip = oid(branch?.tip || '51b0e7c2');
  const rootId = `preview-goal-${repoId}`;
  const goal = (id: string, title: string, status: VisualGoal['status'], parentId: string | null, index: number): VisualGoal => ({
    id, repoId, title, status, parentId, dependsOn: [],
    links: { placeId: firstPlace?.id ?? null, branch: firstPlace?.branch ?? null, sessionKey: sessions[index]?.key ?? null, component: index === 1 ? 'src/shared' : 'src/templates' },
    createdAt: ago(180), updatedAt: ago(3),
  });
  return {
    version: 1, repoId, scannedAt: ago(1),
    git: { commits: repo?.error ? [] : [
      { id: head, parents: [oid('b7c042d1')], subject: 'Add the preview drawer', at: ago(12) },
      { id: branchTip, parents: [oid('b7c042d1')], subject: branch?.subject || 'Refine the working view', at: ago(30) },
      { id: oid('b7c042d1'), parents: [oid('c8de39a2'), oid('e16a540b')], subject: 'Merge the shared controls', at: ago(120) },
      { id: oid('e16a540b'), parents: [oid('c8de39a2')], subject: 'Make shared controls accessible', at: ago(150) },
      { id: oid('c8de39a2'), parents: [], subject: 'Start the workspace', at: ago(240) },
    ], refs: repo?.error ? [] : [
      { name: firstPlace?.branch || 'main', commitId: head, kind: 'branch' },
      { name: branch?.name || 'codex/working-view', commitId: branchTip, kind: 'branch' },
      { name: 'origin/main', commitId: oid('b7c042d1'), kind: 'remote' },
    ], truncated: false, error: repo?.error ?? null },
    codebase: { mode: 'imports', nodes: repo?.error ? [] : [
      { id: 'src/templates', label: 'templates', path: 'src/templates', files: 18, changed: 5 },
      { id: 'src/pricing', label: 'pricing', path: 'src/pricing', files: 9, changed: 2 },
      { id: 'src/shared', label: 'shared', path: 'src/shared', files: 12, changed: 1 },
      { id: 'tests', label: 'tests', path: 'tests', files: 16, changed: 2 },
    ], edges: repo?.error ? [] : [{ source: 'src/templates', target: 'src/shared', count: 6 }, { source: 'src/pricing', target: 'src/shared', count: 3 }, { source: 'tests', target: 'src/templates', count: 4 }],
      truncated: false, error: repo?.error ?? null, note: 'Sample local import relationships.' },
    goals: repo?.error ? [] : [
      { ...goal(rootId, 'Make the workspace easier to follow', 'working', null, 0), links: { placeId: null, branch: null, sessionKey: null, component: null } },
      goal(`${rootId}-controls`, 'Finish the shared controls', 'done', rootId, 1),
      goal(`${rootId}-preview`, 'Make the preview useful', 'working', rootId, 0),
      { ...goal(`${rootId}-review`, 'Review the complete flow', 'blocked', rootId, 2), dependsOn: [`${rootId}-preview`] },
    ],
    traces: sessions.map((session, index) => ({ sessionKey: session.key, truncated: false, events: session.app === 'claude' ? [
      { id: `preview-${index}-1`, at: ago(8), event: 'UserPromptSubmit', toolName: null, state: 'working', confidence: 'reported' },
      { id: `preview-${index}-2`, at: ago(7), event: 'PreToolUse', toolName: 'Read', state: 'working', confidence: 'reported' },
      { id: `preview-${index}-3`, at: ago(6), event: 'PostToolUse', toolName: 'Read', state: 'working', confidence: 'reported' },
      { id: `preview-${index}-4`, at: ago(4), event: 'PreToolUse', toolName: 'Edit', state: 'working', confidence: 'reported' },
      { id: `preview-${index}-5`, at: ago(2), event: session.activity === 'needs-you' ? 'PermissionRequest' : 'PostToolUse', toolName: 'Edit', state: session.activity === 'needs-you' ? 'needs-you' : 'working', confidence: 'reported' },
    ] : session.app === 'codex' ? [{ id: `preview-${index}-1`, at: ago(3), event: 'UserPromptSubmit', toolName: null, state: 'working', confidence: 'reported' }] : [] })),
    warnings: [],
  };
}
export const previewSnapshot: Snapshot = {
  version: 1,
  projects: [
    { id: 'studio', name: 'Studio', path: '~/Projects/Studio', color: '#356962' },
    { id: 'learning', name: 'Learning', path: '~/Projects/Learning', color: '#756a53' },
  ],
  currentProjectId: 'studio',
  activity: { app: 'Microsoft Excel', bundleId: 'com.microsoft.Excel', title: 'Forecast.xlsx', documentPath: '~/Downloads/Forecast.xlsx', at: ago(1), suggestedProjectId: 'studio', reason: 'Document belongs to the selected workspace.' },
  files: [
    { id: 'forecast', name: 'Forecast.xlsx', path: '~/Projects/Studio/Incoming/Forecast.xlsx', originalPath: '~/Downloads/Forecast.xlsx', extension: '.xlsx', size: 58201, firstSeenAt: ago(6), lastSeenAt: ago(1), projectId: 'studio', projectSource: 'selected', status: 'filed', sourceUrl: 'https://example.com/course/materials', reason: 'Studio was selected when this file arrived.', filingAt: ago(5) },
    { id: 'notes', name: 'Workshop notes.pdf', path: '~/Downloads/Workshop notes.pdf', extension: '.pdf', size: 2185100, firstSeenAt: ago(24), lastSeenAt: ago(24), projectId: 'learning', projectSource: 'inferred', status: 'present', reason: 'The filename matches a registered workspace.' },
    { id: 'budget', name: 'September budget.xlsx', path: '~/Downloads/September budget.xlsx', extension: '.xlsx', size: 21522, firstSeenAt: ago(47), lastSeenAt: ago(47), projectId: null, projectSource: null, status: 'present' },
    { id: 'brief', name: 'Project brief.docx', path: '~/Projects/Studio/Incoming/Project brief.docx', originalPath: '~/Desktop/Project brief.docx', extension: '.docx', size: 38792, firstSeenAt: ago(103), lastSeenAt: ago(90), projectId: 'studio', projectSource: 'corrected', status: 'filed', reason: 'Workspace corrected by you.', filingAt: ago(90) },
    { id: 'dataset', name: 'Research dataset.csv', path: '~/Downloads/Research dataset.csv', extension: '.csv', size: 350678, firstSeenAt: ago(138), lastSeenAt: ago(138), projectId: null, projectSource: null, status: 'present' },
  ],
  events: [
    { id: 'e1', at: ago(1), type: 'activity', title: 'Microsoft Excel became active', detail: 'Forecast.xlsx' },
    { id: 'e2', at: ago(5), type: 'filed', title: 'Filing receipt recorded', detail: 'Forecast.xlsx → Studio / Incoming', fileId: 'forecast' },
    { id: 'e3', at: ago(6), type: 'download', title: 'Workbook arrived', detail: 'Forecast.xlsx · Downloads', fileId: 'forecast' },
    { id: 'e4', at: ago(12), type: 'context', title: 'Workspace selected', detail: 'Studio' },
  ],
  settings: { paused: false, accessibilityEnabled: false, activityEnabled: true, retentionDays: 30, calendarUrl: '', whisperModel: '', handsFree: false, excludedApps: [] },
  health: { watching: false, accessibility: false, native: false, whisper: false, errors: [], lastScanAt: null },
  // Usage meter sample: made-up numbers in the shape each CLI reports.
  usage: { version: 1, settings: { usageCeiling: 85, defaultEngine: 'claude' }, refreshing: [], problem: null, providers: {
    claude: { provider: 'claude', plan: 'max', status: 'ok', fetchedAt: ago(4), stale: false, windows: [{ id: 'five_hour', label: '5h', usedPercent: 27, resetsAt: ago(-180) }, { id: 'seven_day', label: '7d', usedPercent: 18, resetsAt: ago(-4000) }] },
    codex: { provider: 'codex', plan: 'plus', status: 'ok', fetchedAt: ago(4), stale: false, windows: [{ id: 'seven_day', label: '7d', usedPercent: 1, resetsAt: ago(-6000) }] } } },
  dataDir: 'Local application data',
};

// Work in flight sample: synthetic projects, branches and names only.
const file = (path: string, status: WifFile['status'], added: number | null, removed: number | null, extra: Partial<WifFile> = {}): WifFile => ({ path, status, staged: false, added, removed, binary: false, isDir: false, fileCount: null, private: false, ...extra });
const place = (value: Partial<WifPlace> & Pick<WifPlace, 'id' | 'kind' | 'label' | 'path' | 'displayPath' | 'stateWords'>): WifPlace => ({ missing: false, branch: 'main', detached: false, head: '4f2a91c0', upstream: 'origin/main', ahead: 0, behind: 0, aheadOfBase: 0, behindBase: 0, counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, items: 0 }, added: 0, removed: 0, lastChangedAt: null, mirrorOf: null, files: [], filesTruncated: false, grouping: null, error: null, ...value });
const harborFiles = [
  file('src/templates/TemplatesTab.tsx', 'modified', 212, 340), file('src/templates/PreviewDrawer.tsx', 'added', 148, 0), file('src/templates/FormatCompare.tsx', 'deleted', 0, 402),
  file('src/templates/format.ts', 'modified', 61, 44), file('src/templates/format.test.ts', 'modified', 38, 12), file('src/templates/styles.css', 'modified', 55, 60), file('src/templates/assets/', 'untracked', null, null, { isDir: true, fileCount: 22 }),
  file('src/pricing/PlanTable.tsx', 'modified', 41, 9), file('src/pricing/copy.ts', 'modified', 23, 3),
  file('pilot/people/', 'untracked', null, null, { isDir: true, fileCount: 6, private: true }), file('pilot/emails/intro-draft.md', 'untracked', null, null, { private: true }), file('pilot/outreach-plan.md', 'modified', 34, 0, { private: true }),
  file('src/shared/Button.tsx', 'modified', 12, 4),
];
const draftFiles = [
  file('api/counters.py', 'modified', 88, 31), file('api/scoring.py', 'modified', 46, 20), file('tests/test_counters.py', 'added', 64, 0),
  file('data/snapshots/2026-09-16.json', 'untracked', null, null, { binary: true }), file('reports/nightly.log', 'modified', 120, 0),
];
// Where this stands sample: the same projects, counted against a watermark set yesterday afternoon, in the
// wording the core writes. Guesses carry the fingerprint they were read from, so they go once that folder moves.
const HARBOR_MAIN = 'a1b2c3d4e5f6', HARBOR_CLAUDE = '55667788aabb', DRAFT_MAIN = 'c4d5e6f7a8b9', DRAFT_CODEX = '9f8e7d6c5b4a';
const standingNote = (id: string, kind: WifStandingNote['kind'], text: string, placeId: string, fingerprint: string, inferred = false): WifStandingNote =>
  ({ id, kind, text, inferred, placeId, fingerprint });
const standingRepo = (value: Partial<WifStandingRepo> & Pick<WifStandingRepo, 'repoId' | 'notes'>): WifStandingRepo => ({
  since: ago(20 * 60), moved: false, landed: 0, landedMore: false, landedSubjects: [], rewritten: false, streamsSaved: 0, streamsDropped: 0, streamsReady: 0, ...value,
});
const stillRow = (value: Partial<WifStandingEntry> & Pick<WifStandingEntry, 'kind' | 'repoId' | 'repoName' | 'placeId' | 'placeLabel' | 'why' | 'fingerprint'>): WifStandingEntry => ({
  since: ago(20 * 60), days: null, minutes: null, confidence: 'reported', inferred: false, ...value,
});
const spinningRow = stillRow({ kind: 'spinning', repoId: 'draft-board', repoName: 'Draft Board', placeId: 'place-draft-codex', placeLabel: 'Codex worktree · 0ced',
  since: ago(44), days: 0, minutes: 44, why: 'An agent is working here and no file has changed in 44 minutes.', confidence: 'inferred', inferred: true, fingerprint: DRAFT_CODEX });
const stillRowDraft = stillRow({ kind: 'still', repoId: 'draft-board', repoName: 'Draft Board', placeId: 'place-draft-main', placeLabel: 'Main folder',
  since: ago(8 * 24 * 60), days: 8, why: 'No file here has changed in 8 days.', fingerprint: DRAFT_MAIN });
const previewStanding: WifStanding = {
  version: 1,
  at: ago(1),
  since: ago(20 * 60),
  sinceText: 'yesterday at 4pm',
  moved: ['Harbor'],
  landed: 6,
  landedSubjects: ['Add preview drawer to the templates tab', 'Clarify the annual price column'],
  streamsSaved: 2,
  streamsDropped: 1,
  streamsReady: 1,
  fingerprints: { 'place-harbor-main': HARBOR_MAIN, 'place-harbor-claude': HARBOR_CLAUDE, 'place-draft-main': DRAFT_MAIN, 'place-draft-codex': DRAFT_CODEX },
  still: [stillRowDraft],
  spinning: [spinningRow],
  blocked: [],
  rot: [],
  notMoving: [spinningRow, stillRowDraft],
  rewritten: [],
  unreadRepos: [],
  byRepo: {
    harbor: standingRepo({ repoId: 'harbor', moved: true, landed: 6, landedSubjects: ['Add preview drawer to the templates tab'], streamsSaved: 2, streamsDropped: 1, streamsReady: 1, notes: [
      standingNote('landed:place-harbor-main:0', 'landed', '6 saves landed in Main folder.', 'place-harbor-main', HARBOR_MAIN),
      standingNote('landed:place-harbor-main:1', 'landed', 'Saved “Add preview drawer to the templates tab”.', 'place-harbor-main', HARBOR_MAIN),
      standingNote('saved:place-harbor-main:2', 'saved', '2 pieces of work finished and left Main folder.', 'place-harbor-main', HARBOR_MAIN, true),
      standingNote('ready:place-harbor-main:3', 'ready', '1 piece of work is now ready to save in Main folder.', 'place-harbor-main', HARBOR_MAIN, true),
      standingNote('dropped:place-harbor-main:4', 'dropped', '1 piece of work left Main folder without being saved.', 'place-harbor-main', HARBOR_MAIN, true),
      standingNote('moved:place-harbor-claude:0', 'moved', 'Files changed in Claude worktree · calm-lighthouse-8611fb.', 'place-harbor-claude', HARBOR_CLAUDE),
    ] }),
    'draft-board': standingRepo({ repoId: 'draft-board', notes: [
      standingNote('still:place-draft-main:0', 'still', 'Main folder: No file here has changed in 8 days.', 'place-draft-main', DRAFT_MAIN),
      standingNote('spinning:place-draft-codex:0', 'spinning', 'Codex worktree · 0ced: An agent is working here and no file has changed in 44 minutes.', 'place-draft-codex', DRAFT_CODEX, true),
    ] }),
  },
  text: 'Since yesterday at 4pm, Harbor moved. 6 saves landed and 1 piece of work is now ready to save. Draft Board has not changed in 8 days.',
};
export const previewWorkInFlight: WorkInFlightStanding = {
  version: 1,
  scannedAt: ago(1),
  repos: [
    {
      id: 'harbor', projectId: 'harbor', name: 'Harbor', path: '/Users/you/Projects/Harbor', displayPath: '~/Projects/Harbor', status: 'work',
      headline: '4 things in progress, 1 looks ready to save', defaultBranch: 'main', hasRemote: true, lastFetchedAt: ago(26 * 60),
      places: [
        place({ id: 'place-harbor-main', kind: 'main', label: 'Main folder', path: '/Users/you/Projects/Harbor', displayPath: '~/Projects/Harbor', ahead: 2, behind: 0,
          stateWords: ['not saved yet', '2 saved, not shared'], counts: { staged: 1, unstaged: 8, untracked: 4, conflicted: 0, items: 13 }, added: 714, removed: 874, lastChangedAt: ago(9), files: harborFiles,
          grouping: { engine: 'codex', model: 'gpt-5-codex', groupedAt: ago(25), stale: false, note: null, workstreams: [
            { id: 'ws-templates', title: 'Templates tab: new preview and formatting compare', summary: 'Replaces the old side-by-side compare with a preview drawer and cleaner formatting rules. Tests are updated, but the new drawer still has placeholder images.', area: 'product', readiness: 'in-progress', files: ['src/templates/FormatCompare.tsx', 'src/templates/PreviewDrawer.tsx', 'src/templates/TemplatesTab.tsx', 'src/templates/assets/', 'src/templates/format.test.ts', 'src/templates/format.ts', 'src/templates/styles.css'], sharedFiles: ['src/shared/Button.tsx'], added: 514, removed: 858, suggestedCommit: 'feat(templates): add preview drawer and formatting compare', private: false },
            { id: 'ws-pricing', title: 'Pricing page: clearer plan table and copy', summary: 'Tightens the plan names and fixes the annual price column. Looks complete.', area: 'frontend', readiness: 'ready', files: ['src/pricing/PlanTable.tsx', 'src/pricing/copy.ts', 'src/shared/Button.tsx'], sharedFiles: [], added: 76, removed: 16, suggestedCommit: 'fix(pricing): clarify plan table and annual prices', private: false },
            { id: 'ws-outreach', title: 'Customer outreach: notes and emails for the university pilot', summary: 'Private notes and draft emails for the pilot. Keep these on this Mac.', area: 'outreach', readiness: 'scratch', files: ['pilot/emails/intro-draft.md', 'pilot/outreach-plan.md', 'pilot/people/'], sharedFiles: [], added: 34, removed: 0, suggestedCommit: null, private: true },
          ] } }),
        place({ id: 'place-harbor-claude', kind: 'claude', label: 'Claude worktree · calm-lighthouse-8611fb', path: '/Users/you/Projects/Harbor/.claude/worktrees/calm-lighthouse-8611fb', displayPath: '~/Projects/Harbor/.claude/worktrees/calm-lighthouse-8611fb',
          branch: 'quiet-harbor-ff8777', upstream: null, ahead: null, behind: null, aheadOfBase: 2, stateWords: ['not saved yet', 'only on this Mac'], counts: { staged: 0, unstaged: 2, untracked: 0, conflicted: 0, items: 2 }, added: 40, removed: 6, lastChangedAt: ago(140),
          files: [file('docs/onboarding.md', 'modified', 31, 6), file('docs/checklist.md', 'added', 9, 0)],
          grouping: { engine: 'paths', model: null, groupedAt: null, stale: false, note: 'Grouped by folder. Use Group changes for plain-language workstreams.', workstreams: [
            { id: 'ws-docs', title: 'docs', summary: '', area: 'other', readiness: 'in-progress', files: ['docs/checklist.md', 'docs/onboarding.md'], sharedFiles: [], added: 40, removed: 6, suggestedCommit: null, private: false },
          ] } }),
      ],
      branches: [
        { name: 'audit-governance', tip: '9c1d22ab', subject: 'Add audit log for pricing rules', lastCommitAt: ago(2 * 24 * 60), upstream: null, upstreamGone: false, ahead: null, behind: null, aheadOfBase: 3, behindBase: 14, placeId: null, merged: false, stateWords: ['3 commits not in main', 'only on this Mac'], summary: 'Adds a governance page that lists who changed pricing rules and when.', summaryStale: false, topPaths: ['src/audit/'] },
        { name: 'quiet-harbor-ff8777', tip: '51b0e7c2', subject: 'Draft onboarding checklist', lastCommitAt: ago(3 * 60), upstream: null, upstreamGone: false, ahead: null, behind: null, aheadOfBase: 2, behindBase: 0, placeId: 'place-harbor-claude', merged: false, stateWords: ['2 commits not in main', 'only on this Mac', 'open in Claude worktree · calm-lighthouse-8611fb'], summary: null, summaryStale: false, topPaths: ['docs/'] },
        { name: 'fix-login-copy', tip: '0a7e3d91', subject: 'Fix login button copy', lastCommitAt: ago(9 * 24 * 60), upstream: 'origin/fix-login-copy', upstreamGone: false, ahead: 0, behind: 0, aheadOfBase: 0, behindBase: 31, placeId: null, merged: true, stateWords: ['done, safe to clean up'], summary: null, summaryStale: false, topPaths: [] },
      ],
      stashes: [{ index: 0, message: 'WIP on main: 4f2a91c Tidy onboarding copy', branch: 'main', createdAt: ago(5 * 24 * 60), files: 8 }],
      error: null,
    },
    {
      id: 'draft-board', projectId: 'draft-board', name: 'Draft Board', path: '/Users/you/Projects/Draft Board', displayPath: '~/Projects/Draft Board', status: 'attention',
      headline: 'A branch was deleted on GitHub. 2 things in progress', defaultBranch: 'main', hasRemote: true, lastFetchedAt: ago(3 * 24 * 60),
      places: [
        place({ id: 'place-draft-main', kind: 'main', label: 'Main folder', path: '/Users/you/Projects/Draft Board', displayPath: '~/Projects/Draft Board', stateWords: ['not saved yet'], counts: { staged: 0, unstaged: 4, untracked: 1, conflicted: 0, items: 5 }, added: 318, removed: 51, lastChangedAt: ago(48), files: draftFiles,
          grouping: { engine: 'claude', model: 'opus', groupedAt: ago(20 * 60), stale: true, note: 'Changed since it was grouped.', workstreams: [
            { id: 'ws-counters', title: 'Draft picks: faster counter-pick scoring', summary: 'Rewrites how counter picks are scored and adds tests for the new rules.', area: 'backend', readiness: 'in-progress', files: ['api/counters.py', 'api/scoring.py', 'tests/test_counters.py'], sharedFiles: [], added: 198, removed: 51, suggestedCommit: 'feat(api): faster counter-pick scoring', private: false },
            { id: 'ws-nightly', title: 'Crawler output: nightly match snapshots', summary: 'Files written by the nightly crawler. Usually not saved by hand.', area: 'automation', readiness: 'generated', files: ['data/snapshots/2026-09-16.json', 'reports/nightly.log'], sharedFiles: [], added: 120, removed: 0, suggestedCommit: null, private: false },
          ] } }),
        place({ id: 'place-draft-codex', kind: 'codex', label: 'Codex worktree · 0ced', path: '/Users/you/.codex/worktrees/0ced/Draft Board', displayPath: '~/.codex/worktrees/0ced/Draft Board', branch: null, detached: true, head: 'a1b2c3d4', upstream: null, ahead: null, behind: null, aheadOfBase: null, behindBase: null,
          stateWords: ['not saved yet', 'not on a branch', 'its unsaved changes are all in Main folder too'], counts: { staged: 0, unstaged: 4, untracked: 1, conflicted: 0, items: 5 }, added: 318, removed: 51, lastChangedAt: ago(50), mirrorOf: 'place-draft-main' }),
      ],
      branches: [
        { name: 'old-tier-list', tip: 'c0ffee12', subject: 'Tier list experiment', lastCommitAt: ago(21 * 24 * 60), upstream: 'origin/old-tier-list', upstreamGone: true, ahead: null, behind: null, aheadOfBase: 2, behindBase: 40, placeId: null, merged: false, stateWords: ['2 commits not in main', 'GitHub copy was deleted'], summary: 'An older experiment with a drag-and-drop tier list.', summaryStale: true, topPaths: ['web/tiers/'] },
      ],
      stashes: [],
      error: null,
    },
    { id: 'old-prototype', projectId: null, name: 'Old Prototype', path: '/Users/you/Code/Old Prototype', displayPath: '~/Code/Old Prototype', status: 'error', headline: 'Still checking; try again in a moment.', defaultBranch: null, hasRemote: false, lastFetchedAt: null, places: [], branches: [], stashes: [], error: 'Still checking; try again in a moment.' },
    { id: 'pocket-meter', projectId: 'pocket-meter', name: 'Pocket Meter', path: '/Users/you/Projects/Pocket Meter', displayPath: '~/Projects/Pocket Meter', status: 'clean', headline: 'All caught up.', defaultBranch: 'main', hasRemote: true, lastFetchedAt: ago(2 * 60),
      places: [place({ id: 'place-meter-main', kind: 'main', label: 'Main folder', path: '/Users/you/Projects/Pocket Meter', displayPath: '~/Projects/Pocket Meter', stateWords: ['all saved'], grouping: null })], branches: [], stashes: [], error: null },
    { id: 'notes-sync', projectId: 'notes-sync', name: 'Notes Sync', path: '/Users/you/Projects/Notes Sync', displayPath: '~/Projects/Notes Sync', status: 'clean', headline: 'All caught up.', defaultBranch: 'main', hasRemote: false, lastFetchedAt: null,
      places: [place({ id: 'place-notes-main', kind: 'main', label: 'Main folder', path: '/Users/you/Projects/Notes Sync', displayPath: '~/Projects/Notes Sync', upstream: null, stateWords: ['all saved'], grouping: null })], branches: [], stashes: [], error: null },
  ],
  totals: { reposWithWork: 2, unsavedItems: 20, unsharedCommits: 2, setAside: 1, openBranches: 3, staleGroupings: 1 },
  job: { id: 'job-preview', status: 'done', reason: 'panel', engine: 'codex', startedAt: ago(27), finishedAt: ago(25), progress: { done: 2, total: 2 }, current: null, errors: [] },
  settings: { engine: 'codex', effort: 'medium', claudeModel: 'opus', groupOnOpen: true, extraRoots: [], excludedRoots: [], privatePaths: { '/Users/you/Projects/Harbor': ['pilot/'] }, consentedAt: ago(27) },
  disclosure: 'Grouping sends to Codex (your ChatGPT sign-in): project, folder and branch names, recent commit messages, changed file names with line counts, short excerpts from non-private text files, and a few file names in new folders. Private folders send only their folder name, file types, change and line counts, and edit dates. Group on open is on, so opening this panel sends changed work right away. Agents you ask can send it too.',
  standing: previewStanding,
  privateDefaults: ['email', 'emails', 'people', 'contacts', 'customers', 'clients', 'leads', 'prospects', 'recordings', 'transcripts', 'legal', 'contracts', 'invoices', 'payroll', 'medical', 'health-records', 'tax', 'taxes', 'secrets', 'credentials', 'private', 'personal', 'real-submissions', '_source'],
  errors: [],
};

// Agent sessions sample: synthetic sessions, titles and ids only. byPlace uses the Work in flight sample place ids.
// work holds the counts, and workText the one line a row shows. Sessions without either keep the plain row.
const sessionWork = (value: Partial<AgentSessionWork> = {}): AgentSessionWork => ({ added: null, removed: null, files: null, area: null, scope: 'session', workstream: null, workstreamState: null, ...value });
const agentSession = (value: Partial<AgentSession> & Partial<AgentSessionAddress> & Pick<AgentSession, 'key' | 'app' | 'surface' | 'appLabel' | 'title' | 'group' | 'activity' | 'stateText' | 'openHint'>): LocatedAgentSession => ({
  titleIsFallback: false, project: null, placeId: null, repoId: null, placeLabel: null, folder: null, branch: null, reason: null, sinceText: null, sinceAt: null, updatedAt: null,
  unread: false, pinned: false, live: true, confidence: 'reported', helpers: 0, work: null, workText: '', openable: 'link', headline: null, titleIsAuto: true, startedFrom: null, ...value,
});
export const previewAgentSessions: AgentSessionsView = {
  version: 1,
  checkedAt: ago(0),
  totals: { needsYou: 1, newReplies: 2, working: 3, open: 1 },
  groups: [
    { id: 'needs-you', title: 'Needs you', sessions: [
      agentSession({ key: 'claude:desktop:local_preview-onboarding-copy', app: 'claude', surface: 'desktop', appLabel: 'Claude app', title: 'Onboarding checklist copy', headline: 'Harbor · calm-lighthouse-8611fb', project: 'Harbor', placeId: 'place-harbor-claude', repoId: 'harbor', placeLabel: 'Claude worktree · calm-lighthouse-8611fb', folder: '~/Projects/Harbor/.claude/worktrees/calm-lighthouse-8611fb', branch: 'quiet-harbor-ff8777',
        group: 'needs-you', activity: 'needs-you', reason: 'Waiting for your OK', stateText: 'Waiting for your OK · 4 min', sinceText: '4 min', sinceAt: ago(4), updatedAt: ago(4), openHint: 'Open in Claude',
        work: sessionWork({ added: 40, removed: 6, files: 2, area: 'docs' }), workText: '+40 −6 in 2 files · mostly docs' }),
    ] },
    { id: 'new', title: 'New replies', sessions: [
      agentSession({ key: 'codex:desktop:6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b', app: 'codex', surface: 'desktop', appLabel: 'Codex', title: 'Counter-pick scoring tests', headline: 'Draft Board · Draft picks: faster counter-pick scoring', project: 'Draft Board', placeId: 'place-draft-main', repoId: 'draft-board', placeLabel: 'Main folder', folder: '~/Projects/Draft Board', branch: 'main',
        group: 'new', activity: 'open', stateText: 'New reply · 12 min ago', sinceText: '12 min ago', sinceAt: ago(12), updatedAt: ago(12), unread: true, openHint: 'Open in Codex',
        work: sessionWork({ added: 198, removed: 51, files: 3, area: 'api', workstream: 'Draft picks: faster counter-pick scoring', workstreamState: 'still in progress' }), workText: 'Draft picks: faster counter-pick scoring (still in progress) · +198 −51 in 3 files' }),
      agentSession({ key: 'cursor:ide:2b8d4f60-7a1e-4c3b-9d2f-5e6a7b8c9d0e', app: 'cursor', surface: 'ide', appLabel: 'Cursor', title: 'Pricing table spacing on small screens', titleIsAuto: false, headline: 'Harbor · Pricing page: clearer plan table and copy', project: 'Harbor', placeId: 'place-harbor-main', repoId: 'harbor', placeLabel: 'Main folder', folder: '~/Projects/Harbor', branch: 'main',
        group: 'new', activity: 'quiet', stateText: 'New reply · 38 min ago', sinceText: '38 min ago', sinceAt: ago(38), updatedAt: ago(38), unread: true, pinned: true, live: false, openHint: 'Open in Cursor',
        work: sessionWork({ added: 76, removed: 16, files: 2, area: 'src/pricing', workstream: 'Pricing page: clearer plan table and copy', workstreamState: 'looks ready to save' }), workText: 'Pricing page: clearer plan table and copy (looks ready to save)' }),
    ] },
    { id: 'working', title: 'Working', sessions: [
      agentSession({ key: 'claude:desktop:local_preview-templates-drawer', app: 'claude', surface: 'desktop', appLabel: 'Claude app', title: 'Templates tab preview drawer', headline: 'Harbor · Templates tab: new preview and formatting compare', project: 'Harbor', placeId: 'place-harbor-main', repoId: 'harbor', placeLabel: 'Main folder', folder: '~/Projects/Harbor', branch: 'main',
        group: 'working', activity: 'working', stateText: 'Working · 18 min', sinceText: '18 min', sinceAt: ago(18), updatedAt: ago(0), helpers: 2, openHint: 'Open in Claude',
        work: sessionWork({ added: 514, removed: 858, files: 7, area: 'src/templates', scope: 'folder', workstream: 'Templates tab: new preview and formatting compare', workstreamState: 'still in progress' }), workText: 'Templates tab: new preview and formatting compare (still in progress)' }),
      agentSession({ key: 'codex:desktop:0d4e5f6a-1b2c-4d3e-8f9a-7b6c5d4e3f2a', app: 'codex', surface: 'desktop', appLabel: 'Codex', title: 'Nightly snapshot cleanup', headline: 'Draft Board', project: 'Draft Board', placeId: 'place-draft-codex', repoId: 'draft-board', placeLabel: 'Codex worktree · 0ced', folder: '~/.codex/worktrees/0ced/Draft Board',
        group: 'working', activity: 'working', stateText: 'Working · 44 min', sinceText: '44 min', sinceAt: ago(44), updatedAt: ago(1), unread: true, openHint: 'Open in Codex',
        work: sessionWork({ added: 318, removed: 51, files: 5, area: 'api', scope: 'folder' }), workText: '+318 −51 in 5 files · mostly api' }),
      agentSession({ key: 'hermes:desktop:20260917_091502_a1b2c3', app: 'hermes', surface: 'desktop', appLabel: 'Hermes', title: 'Morning desk summary', headline: 'Somewhere else', titleIsAuto: false,
        group: 'working', activity: 'working', stateText: 'Working · just started', sinceText: 'just now', sinceAt: ago(0), updatedAt: ago(0), openHint: 'Open in Hermes' }),
    ] },
    { id: 'open', title: 'Open, your move', sessions: [
      agentSession({ key: 'claude:terminal:9a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d', app: 'claude', surface: 'terminal', appLabel: 'Claude in Terminal', title: 'Pocket Meter release notes', headline: 'Pocket Meter \u00b7 main folder', project: 'Pocket Meter', placeId: 'place-meter-main', repoId: 'pocket-meter', placeLabel: 'Main folder', folder: '~/Projects/Pocket Meter', branch: 'main',
        group: 'open', activity: 'open', stateText: 'Open, your move', sinceText: '9 min ago', sinceAt: ago(9), updatedAt: ago(9), openable: 'folder', openHint: 'Show folder', startedFrom: 'summon' }),
    ] },
    { id: 'interrupted', title: 'Interrupted', sessions: [
      agentSession({ key: 'cursor:ide:5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f', app: 'cursor', surface: 'ide', appLabel: 'Cursor', title: 'Sync conflict resolver', headline: 'Notes Sync · Sync conflicts: stop two devices overwriting each other in the merge picker', project: 'Notes Sync', placeId: 'place-notes-main', repoId: 'notes-sync', placeLabel: 'Main folder', folder: '~/Projects/Notes Sync', branch: 'conflict-resolver',
        group: 'interrupted', activity: 'interrupted', reason: 'Interrupted when the app closed', stateText: 'Interrupted when the app closed', sinceText: '3 h ago', sinceAt: ago(180), updatedAt: ago(176), live: false, openHint: 'Open in Cursor',
        work: sessionWork({ added: 120, removed: 44, files: 4, area: 'src/sync', scope: 'folder', workstream: 'Sync conflicts: stop two devices overwriting each other in the merge picker', workstreamState: 'still in progress' }), workText: 'Sync conflicts: stop two devices overwriting each other in the merge picker' }),
    ] },
    { id: 'recent', title: 'Earlier today', sessions: [
      agentSession({ key: 'codex:desktop:1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', app: 'codex', surface: 'desktop', appLabel: 'Codex', title: 'Rename draft board filters', headline: 'Draft Board \u00b7 main folder', project: 'Draft Board', placeId: 'place-draft-main', repoId: 'draft-board', placeLabel: 'Main folder', folder: '~/Projects/Draft Board', branch: 'main',
        group: 'recent', activity: 'quiet', stateText: 'Last active 2 h ago', sinceText: '2 h ago', sinceAt: ago(125), updatedAt: ago(125), live: false, openHint: 'Open in Codex', work: sessionWork({ added: 12, removed: 3, files: 1, area: 'web/tiers' }), workText: '+12 −3 in 1 file · mostly web/tiers' }),
      agentSession({ key: 'claude:terminal:4e5f6a7b-8c9d-4e0f-9a1b-2c3d4e5f6a7b', app: 'claude', surface: 'terminal', appLabel: 'Claude in Terminal', title: 'Untitled Claude session', titleIsFallback: true, headline: 'Notes Sync', project: 'Notes Sync', repoId: 'notes-sync', placeId: 'place-notes-main', placeLabel: 'Main folder', folder: '~/Projects/Notes Sync',
        group: 'recent', activity: 'quiet', stateText: 'Last active 3 h ago', sinceText: '3 h ago', sinceAt: ago(190), updatedAt: ago(190), live: false, openable: 'copy', openHint: 'Copy resume command', work: sessionWork({ added: 31, removed: 6, files: 3, area: 'docs' }), workText: '+31 −6 in 3 files · mostly docs' }),
      agentSession({ key: 'hermes:desktop:20260917_063011_0f9e8d', app: 'hermes', surface: 'desktop', appLabel: 'Hermes', title: 'Weekly review prep', headline: 'Somewhere else', titleIsAuto: false,
        group: 'recent', activity: 'quiet', stateText: 'Last active 5 h ago', sinceText: '5 h ago', sinceAt: ago(300), updatedAt: ago(300), live: false, openHint: 'Open in Hermes' }),
    ] },
  ],
  sources: [
    { app: 'claude', label: 'Claude app', available: true, running: true, detail: null },
    { app: 'claude', label: 'Claude in Terminal', available: true, running: true, detail: null },
    { app: 'codex', label: 'Codex', available: true, running: true, detail: null },
    { app: 'cursor', label: 'Cursor', available: true, running: false, detail: 'Cursor is closed, so nothing there is running.' },
    { app: 'hermes', label: 'Hermes', available: true, running: true, detail: null },
  ],
  byPlace: {
    'place-harbor-claude': { working: 0, needsYou: 1, newReplies: 0, open: 0, apps: ['claude'], text: 'Claude needs you here' },
    'place-harbor-main': { working: 1, needsYou: 0, newReplies: 1, open: 0, apps: ['claude', 'cursor'], text: 'Claude working here' },
    'place-draft-main': { working: 0, needsYou: 0, newReplies: 1, open: 0, apps: ['codex'], text: 'New reply from Codex here' },
    'place-draft-codex': { working: 1, needsYou: 0, newReplies: 0, open: 0, apps: ['codex'], text: 'Codex working here' },
    'place-meter-main': { working: 0, needsYou: 0, newReplies: 0, open: 1, apps: ['claude'], text: 'Claude open here' },
  },
  summary: { needsYou: 1, working: 3, backgroundWorking: 0, text: '1 session is waiting on you. 3 working.' },
  settings: { recentHours: 24, newReplyHours: 72, showQuiet: true, showBackground: false, trayCount: 'needs', pathAliases: {} },
  warnings: [],
};
