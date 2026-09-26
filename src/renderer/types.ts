export type Project = { id: string; name: string; path: string; color: string };
export type Activity = { app: string; bundleId: string; title?: string; documentPath?: string; at: string; suggestedProjectId?: string; reason?: string };
export type FileRecord = { id: string; name: string; path: string; originalPath?: string; extension: string; size: number; firstSeenAt: string; createdAt?: string; modifiedAt?: string; lastSeenAt: string; projectId: string | null; projectSource: 'selected' | 'inferred' | 'corrected' | null; status: 'present' | 'missing' | 'filed' | 'waiting' | 'unconfirmed'; reason?: string; accessIssue?: string; sourceUrl?: string; filingAt?: string };
export type EventRecord = { id: string; at: string; type: string; title: string; detail?: string; fileId?: string; projectId?: string | null };
export type Settings = { paused: boolean; accessibilityEnabled: boolean; activityEnabled: boolean; retentionDays: number; calendarUrl: string; whisperModel: string; handsFree: boolean; excludedApps: string[]; accentColor?: string; benchmarkKeyConfigured?: boolean };
export type Snapshot = { version: 1; usage?: UsageView; projects: Project[]; currentProjectId: string | null; activity: Activity | null; files: FileRecord[]; events: EventRecord[]; settings: Settings; health: { watching: boolean; accessibility: boolean; native: boolean; whisper: boolean; errors: string[]; lastScanAt: string | null }; knowledge?: KnowledgeSnapshot; localModel?: LocalModelHealth; wake?: WakeHealth; speaker?: SpeakerHealth; fnKey?: { status: 'off' | 'starting' | 'ready' | 'permission-required' | 'error' }; benchmark?: { fetchedAt: string; source: string; models: { name: string; score: number | null }[]; error?: string }; dataDir: string };
export type CommandResult = { kind: 'files' | 'context' | 'message' | 'benchmark' | 'unknown'; message: string; routineReceiptId?: string; completedCommand?: string; routineName?: string; failed?: boolean; warning?: string; fileIds?: string[]; projectId?: string | null };
export type VoiceMode = 'off' | 'command' | 'handsfree';
export type VoiceStatus = { state: string; mode: VoiceMode; micActive: boolean; text?: string; enrollment?: { count: number; total: number; phase: 'listening' | 'hearing' | 'captured' | 'done' } };
export type SettingsPatch = Partial<Settings> & { benchmarkApiKey?: string };
export type SummonBridge = {
  detectWake(audio: ArrayBuffer): Promise<{detected:boolean;keyword?:string;elapsedMs:number}>;
  verifySpeaker(audio: ArrayBuffer): Promise<{verified:boolean;score:number;elapsedMs:number;reason?:string;error?:string}>;
  beginEnrollment(): Promise<{minSamples:number}>;
  enrollSpeaker(audio: ArrayBuffer): Promise<{count:number;error?:string;elapsedMs:number}>;
  finishEnrollment(): Promise<{saved:boolean;samples:number}>;
  cancelEnrollment(): Promise<void>;
  interpret(text:string): Promise<LocalProposal>;
  localModelStatus(): Promise<Snapshot>;
  searchMemory(query:string,options?:{projectId?:string|null;limit?:number}):Promise<MemoryHit[]>;
  remember(value:{text:string;projectId?:string|null}):Promise<Snapshot>;
  forget(id:string):Promise<Snapshot>;
  saveRoutine(value:{receiptId:string;name:string;trigger:string;projectId?:string|null}):Promise<Snapshot>;
  removeRoutine(id:string):Promise<Snapshot>;
  runRoutine(id:string):Promise<CommandResult>;
  snapshot(): Promise<Snapshot>;
  command(text: string): Promise<CommandResult>;
  selectProject(id: string | null): Promise<Snapshot>;
  correctFile(id: string, projectId: string | null): Promise<Snapshot>;
  openFile(id: string): Promise<void>;
  revealFile(id: string): Promise<void>;
  settings(patch: SettingsPatch): Promise<Snapshot>;
  addProject(): Promise<Snapshot>;
  chooseModel(): Promise<Snapshot>;
  openLink(name: 'calendar' | 'benchmark' | 'accessibility' | 'microphone' | 'input-monitoring' | 'data-folder' | 'claude-login' | 'codex-login' | 'file-access'): Promise<void>;
  transcribe(audio: ArrayBuffer): Promise<{ text: string }>;
  // 'auto' lets main pick the CLI with the most subscription quota left (engine-choice.mjs); engine and reason say which and why.
  ask(engine: 'claude' | 'codex' | 'auto', text: string): Promise<{ text: string; engine?: UsageProvider; reason?: string }>;
  // The usage meter: the last reading, or a fresh one with refresh (two bounded CLI reads, about a second, no quota spent).
  usage(options?: { refresh?: boolean; provider?: UsageProvider }): Promise<UsageView>;
  usageSettings(patch: Partial<UsageSettings>): Promise<UsageView>;
  onUpdate(callback: (snapshot: Snapshot) => void): () => void;
  onVoiceToggle(callback: () => void): () => void;
  onVoiceMode(callback: (mode: VoiceMode) => void): () => void;
  onEnrollSpeaker(callback: () => void): () => void;
  voiceState(status: VoiceStatus): Promise<void>;
  showWindow(): Promise<void>;
  workInFlight(options?: { refresh?: boolean }): Promise<WorkInFlight>;
  groupWork(repoId: string | null, options?: { force?: boolean; reason?: 'panel' | 'open' }): Promise<WifJob>;
  workInFlightSettings(patch: Partial<WifSettings>): Promise<WorkInFlight>;
  revealPlace(placeId: string): Promise<void>;
  markStanding(repoId: string | null): Promise<void>;
  onWorkInFlight(callback: (value: WorkInFlight) => void): () => void;
  agentSessions(options?: { refresh?: boolean }): Promise<AgentSessionsView>;
  // Sanitized hook metadata for a session in the last read, including sessions without a repository.
  agentSessionTrace(key: string): Promise<VisualTrace>;
  openAgentSession(key: string): Promise<AgentSessionOpenResult | void>;
  agentSessionsSettings(patch: Partial<AgentSessionsSettings>): Promise<AgentSessionsView>;
  // Sent by the menu-bar count when it is clicked: open this panel and show it.
  onOpenPanel(callback: (panel: SummonPanel) => void): () => void;
  // Starts claude or codex in Terminal for a workspace (a click in the workbench only). hooks is false when node was
  // not found, so the session cannot report its state; mcp says whether Summon's MCP server came from the user's own
  // config ('global'), was attached for this session ('attached') or could not be ('none').
  launchAgent(options: { app: 'claude' | 'codex'; projectId: string }): Promise<AgentLaunchResult>;
  // Preferences: merge Summon's Claude hooks into ~/.claude/settings.json after a timestamped backup. Click only.
  installClaudeHooks(): Promise<{ installed: boolean; backup: string | null; events: string[] }>;
  claudeHooksStatus(): Promise<ClaudeHooksStatus>;
  visualRepository(repoId: string, options?: { refresh?: boolean }): Promise<VisualRepository>;
  saveVisualGoal(input: VisualGoalInput): Promise<VisualGoal[]>;
};
// The usage meter: what each CLI reports about its own subscription windows (src/core/usage.mjs). Unknown usage is a
// status, never 0 %. stale is set by main when a reading is older than 20 minutes; the engine choice ignores stale readings.
export type UsageProvider = 'claude' | 'codex';
export type UsageStatus = 'ok' | 'not_signed_in' | 'not_installed' | 'not_applicable' | 'error';
export type UsageWindow = { id: string; label: string; usedPercent: number; resetsAt: string | null };
export type UsageReport = { provider: UsageProvider; plan: string | null; status: UsageStatus; windows: UsageWindow[]; fetchedAt: string; error?: string; stale?: boolean };
export type UsageSettings = { usageCeiling: number; defaultEngine: UsageProvider };
export type UsageView = { version: 1; settings: UsageSettings; providers: Record<UsageProvider, UsageReport | null>; refreshing: UsageProvider[]; problem: string | null };
export type AgentLaunchResult = { app: string; tag: string; sessionId: string | null; folder: string; hooks: boolean; mcp: 'global' | 'attached' | 'none' };
export type ClaudeHooksStatus = { claude: { installed: boolean; current: boolean } };
export type SummonPanel = 'agent-sessions';

declare global {
  interface Window { summon?: SummonBridge }
}

export type MemoryHit={id:string;kind:'explicit'|'retrieved';text:string;projectId:string|null;source:{label:string;path?:string;line?:number;modifiedAt?:string};score:number};
export type KnowledgeSnapshot={version:1;memories:{id:string;text:string;projectId:string|null;source:string;kind:'explicit';createdAt:string;updatedAt:string}[];routines:{id:string;name:string;trigger:string;command:string;projectId:string|null;actionType:string;createdAt:string;updatedAt:string;lastUsedAt:string|null;useCount:number}[];sources:{id:string;title:string;path:string;projectId:string|null;modifiedAt:string}[];health:{lastRefreshAt:string|null;errors:string[]}};
export type LocalProposal={kind:'proposal'|'clarify'|'unavailable';message:string;model:string;elapsedMs:number;command?:string};
export type LocalModelHealth={available:boolean;installed:boolean;loaded:boolean;model:string;version?:string;error?:string};
export type WakeHealth={available:boolean;loaded:boolean;keyword:string;model:string;error?:string};
export type SpeakerHealth={available:boolean;enrolled:boolean;active:boolean;enrolling:boolean;error?:string};

// Work in flight: read-only git status across workspaces plus user-requested workstream grouping.
// withheldFiles: only on agent-facing reads (MCP), which leave private file names out of the lists.
export type WifArea = 'product' | 'backend' | 'frontend' | 'outreach' | 'business' | 'docs' | 'automation' | 'content' | 'tooling' | 'config' | 'research' | 'local-only' | 'other';
export type WifReadiness = 'ready' | 'in-progress' | 'scratch' | 'generated';
export type WifWorkstream = { id: string; title: string; summary: string; area: WifArea; readiness: WifReadiness; files: string[]; sharedFiles: string[]; added: number; removed: number; suggestedCommit: string | null; private: boolean; withheldFiles?: number };
export type WifGrouping = { engine: 'codex' | 'claude' | 'paths'; model: string | null; groupedAt: string | null; stale: boolean; note: string | null; workstreams: WifWorkstream[] };
export type WifFile = { path: string; status: 'modified' | 'added' | 'deleted' | 'renamed' | 'typechange' | 'untracked' | 'conflicted'; staged: boolean; added: number | null; removed: number | null; binary: boolean; isDir: boolean; fileCount: number | null; private: boolean };
export type WifPlace = { id: string; kind: 'main' | 'claude' | 'codex' | 'cursor' | 'other'; label: string; path: string; displayPath: string; missing: boolean;
  branch: string | null; detached: boolean; head: string | null; upstream: string | null; ahead: number | null; behind: number | null; aheadOfBase: number | null; behindBase: number | null;
  stateWords: string[]; counts: { staged: number; unstaged: number; untracked: number; conflicted: number; items: number }; added: number; removed: number;
  lastChangedAt: string | null; mirrorOf: string | null; files?: WifFile[]; filesTruncated: boolean; grouping: WifGrouping | null; error: string | null; withheldFiles?: number };
export type WifBranch = { name: string; tip: string; subject: string; lastCommitAt: string | null; upstream: string | null; upstreamGone: boolean; ahead: number | null; behind: number | null;
  aheadOfBase: number; behindBase: number; placeId: string | null; merged: boolean; stateWords: string[]; summary: string | null; summaryStale: boolean; topPaths: string[] };
export type WifStash = { index: number; message: string; branch: string | null; createdAt: string | null; files: number };
export type WifRepo = { id: string; projectId: string | null; name: string; path: string; displayPath: string; status: 'clean' | 'work' | 'attention' | 'error';
  headline: string; defaultBranch: string | null; hasRemote: boolean; lastFetchedAt: string | null; places: WifPlace[]; branches: WifBranch[]; stashes: WifStash[]; error: string | null };
export type WifJob = { id: string; status: 'queued' | 'running' | 'done' | 'failed'; reason: 'panel' | 'open' | 'agent' | 'cli'; engine: 'codex' | 'claude'; startedAt: string; finishedAt: string | null;
  progress: { done: number; total: number }; current: string | null; errors: string[] };
// consentedAt: when Group changes was first pressed; set only by the service, never by a settings patch.
export type WifSettings = { engine: 'codex' | 'claude' | 'off'; effort: 'low' | 'medium' | 'high'; claudeModel: 'opus' | 'sonnet' | 'haiku'; groupOnOpen: boolean; extraRoots: string[]; excludedRoots: string[]; privatePaths: Record<string, string[]>; consentedAt: string | null };
export type WorkInFlight = { version: 1; scannedAt: string; repos: WifRepo[]; totals: { reposWithWork: number; unsavedItems: number; unsharedCommits: number; setAside: number; openBranches: number; staleGroupings: number };
  job: WifJob | null; settings: WifSettings; disclosure: string; privateDefaults: string[]; errors: string[] };

// Agent sessions: read-only metadata about Claude, Codex, Cursor and Hermes sessions (never conversation content).
// Titles are untrusted text from those apps. folder is a ~-relative display path and is null on agent-facing reads.
export type AgentApp = 'claude' | 'codex' | 'cursor' | 'hermes';
export type AgentSessionGroupId = 'needs-you' | 'new' | 'working' | 'open' | 'interrupted' | 'recent';
// What a session is changing, counted from files only: its own diff counts ('session') or, for a worktree only this
// session works in, that folder's ('folder'). area is a folder inside the project; workstream is Work in flight's wording.
export type AgentSessionWork = { added: number | null; removed: number | null; files: number | null; area: string | null;
  scope: 'session' | 'folder'; workstream: string | null; workstreamState: string | null };
export type AgentSession = { key: string; app: AgentApp; surface: 'desktop' | 'terminal' | 'ide' | 'cli' | 'background'; appLabel: string; title: string; titleIsFallback: boolean;
  project: string | null; placeId: string | null; repoId: string | null; placeLabel: string | null; folder: string | null; branch: string | null;
  group: AgentSessionGroupId; activity: 'working' | 'needs-you' | 'failed' | 'open' | 'quiet' | 'interrupted' | 'unknown'; reason: string | null;
  stateText: string; sinceText?: string | null; sinceAt: string | null; updatedAt: string | null; unread: boolean; pinned: boolean; live: boolean;
  confidence: 'reported' | 'inferred'; helpers: number; work: CountedAgentSessionWork | null; workText: string;
  // 'summon' when Summon started this session itself (Summon's own fact, never app text); null for every other row.
  startedFrom: 'summon' | null;
  openable: 'link' | 'copy' | 'folder' | 'none'; openHint: string };
export type AgentSessionGroup = { id: AgentSessionGroupId; title: string; sessions: AgentSession[] };
export type AgentSessionSource = { app: AgentApp; label: string; available: boolean; running: boolean; detail: string | null };
export type AgentPlaceSummary = { working: number; needsYou: number; newReplies: number; open: number; apps: AgentApp[]; text: string };
// trayCount: what the menu-bar item counts. 'needs' is the default, 'working' also counts background runs the list
// leaves out, and 'off' means no item and no background check.
export type AgentSessionsSettings = { recentHours: number; newReplyHours: number; showQuiet: boolean; showBackground: boolean; trayCount: 'needs' | 'working' | 'off'; pathAliases: Record<string, string> };
// What the menu bar reads. New replies are not counted; text is the plain sentence for the tooltip.
export type AgentSessionsSummary = { needsYou: number; working: number; backgroundWorking: number; text: string };
export type AgentSessionsView = { version: 1; checkedAt: string; totals: { needsYou: number; newReplies: number; working: number; open: number }; summary: AgentSessionsSummary;
  groups: AgentSessionGroup[]; sources: AgentSessionSource[]; byPlace: Record<string, AgentPlaceSummary>; settings: AgentSessionsSettings; warnings: string[] };
// What main did for an explicit open: launched the app, copied a resume command, or showed the folder in Finder.
export type AgentSessionOpenResult = { opened?: boolean; copied?: boolean; shown?: boolean };

// Where this stands: what changed since the last time you looked, counted against a watermark you set by
// looking (a project section you keep on screen, or Mark as read), never by opening the panel. Everything
// here is subtraction against that mark, so an empty paragraph means nothing moved, not that nothing was checked.
// Every note and rail row names the folder it was read from and that folder's fingerprint at the time, so the
// panel drops a guess the moment `fingerprints` says that folder has changed under it.
export type WifStandingKind = 'landed' | 'rewritten' | 'saved' | 'dropped' | 'ready' | 'moved' | 'still' | 'spinning' | 'blocked' | 'rot';
export type WifStandingNote = { id: string; kind: WifStandingKind; text: string; inferred: boolean; placeId: string; fingerprint: string };
export type WifStandingEntry = { kind: 'still' | 'spinning' | 'blocked' | 'rot'; repoId: string; repoName: string; placeId: string; placeLabel: string;
  since: string | null; days: number | null; minutes: number | null; why: string; confidence: 'reported' | 'inferred'; inferred: boolean; fingerprint: string };
// lines is the same block of notes as plain sentences, for a caller that wants the words without the evidence. The
// panel uses notes, because only those carry the fingerprint that lets it drop a guess whose folder has moved on.
export type WifStandingRepo = { repoId: string; since: string | null; notes: WifStandingNote[]; moved: boolean; landed: number; landedMore: boolean;
  landedSubjects: string[]; rewritten: boolean; streamsSaved: number; streamsDropped: number; streamsReady: number; lines?: string[] };
export type WifStanding = { version: number; at: string; since: string | null; sinceText: string; moved: string[]; landed: number; landedSubjects: string[];
  streamsSaved: number; streamsDropped: number; streamsReady: number; fingerprints: Record<string, string>;
  still: WifStandingEntry[]; spinning: WifStandingEntry[]; blocked: WifStandingEntry[]; rot: WifStandingEntry[];
  // notMoving is the rail itself: the four kinds sorted, one row per folder, already capped by the core.
  notMoving: WifStandingEntry[]; rewritten: string[]; unreadRepos: string[]; byRepo: Record<string, WifStandingRepo>; text: string };
// Optional while the core that counts it is being built: an older core sends no paragraph and none is shown.
export type WorkInFlightStanding = WorkInFlight & { standing?: WifStanding | null };
// Sessions say where they are: the readers address a row by project and piece of work, and the app's own
// machine-written title stays underneath it. Read defensively, a window can outlive the app that sends them.
export type AgentSessionAddress = { headline: string | null; titleIsAuto: boolean };
export type LocatedAgentSession = AgentSession & Partial<AgentSessionAddress>;

// Visual workspace: local commit ancestry, observed imports, explicit goals and reported hook events.
export type VisualGoalStatus = 'planned' | 'working' | 'blocked' | 'done';
export type VisualGoalLinks = { placeId: string | null; branch: string | null; sessionKey: string | null; component: string | null };
export type VisualGoal = { id: string; repoId: string; title: string; status: VisualGoalStatus; parentId: string | null; dependsOn: string[]; links: VisualGoalLinks; createdAt: string; updatedAt: string };
export type VisualGoalInput = { repoId: string; id?: string; title?: string; status?: VisualGoalStatus; parentId?: string | null; dependsOn?: string[]; links?: Partial<VisualGoalLinks> };
export type VisualCommit = { id: string; parents: string[]; subject: string; at: string | null };
export type VisualRef = { name: string; commitId: string; kind: 'branch' | 'remote' | 'tag' | 'head' };
export type VisualCodebaseNode = { id: string; label: string; path: string; files: number; changed: number };
export type VisualCodebaseEdge = { source: string; target: string; count: number };
export type VisualTraceEvent = { id: string; at: string; event: string; toolName: string | null; state: string | null; confidence: 'reported' };
export type VisualTrace = { sessionKey: string; events: VisualTraceEvent[]; truncated: boolean };
export type VisualRepository = { version: 1; repoId: string; scannedAt: string;
  git: { commits: VisualCommit[]; refs: VisualRef[]; truncated: boolean; error: string | null };
  codebase: { nodes: VisualCodebaseNode[]; edges: VisualCodebaseEdge[]; truncated: boolean; error: string | null; note?: string | null; mode: 'imports' };
  goals: VisualGoal[]; traces: VisualTrace[]; warnings: string[] };

// What the core actually puts in AgentSessionAddress above.
// headline is never empty: '<Project> · <piece of work>' when the session's own edited files fall in one of the
//   folder's workstreams, otherwise '<Project> · <worktree branch or main folder>'. An agent-facing read of a session
//   in a private folder says 'Work in a private folder' and nothing else.
// titleIsAuto is false only when the person named the session themselves. The apps write nearly all of these titles, so a
//   reader that says nothing counts as automatic, and the panel quotes an automatic title under the headline rather
//   than leading with it.
// What Work in flight tells Agent sessions about the pieces of work inside one folder, so a session's own edited
// files can be matched to one of them. files are folder-relative paths, exactly as WifWorkstream lists them, and an
// absent list means the folder has not been grouped, which is not the same as having no work in it.
export type AgentSessionsPlaceWorkstream = { id?: string; title: string; files: string[]; readiness: WifReadiness | null };

// Sessions that named no file of their own. Claude keeps one folder of backups per session and names every entry
// after the file it holds, as the first 16 hex characters of sha256 of that file's absolute path, so hashing the
// paths Work in flight already has answers "did this session touch any of these files?" without discovering a path
// and without opening a backup. A session can therefore be placed in a piece of work it never named.
// workstreamInferred is true only when the piece of work came from those hashed names rather than from paths the
//   session itself reported. A row that shows it should mark it as inferred, and drop it when the folder is grouped
//   again. A tie or a weak overlap sets no workstream at all, so this is never a guess between two candidates.
// touchedFiles and touchedAt are how many distinct files that session has backed up and when the newest was written,
//   counted from the listing of the session's own backup folder, absent when there is no folder to count. That folder
//   holds everything the session wrote, so the count can include files in other projects and files this row will not
//   name, and it is never a count of work in the row's own folder.
export type AgentSessionEdits = { workstreamInferred: boolean; touchedFiles: number | null; touchedAt: string | null };
export type CountedAgentSessionWork = AgentSessionWork & Partial<AgentSessionEdits>;
// What a reader sends the aggregator about those backups: the hashed names, the count and the newest time. The hashes
// are one way, so they can be compared with a path we already have and can never be turned back into one we do not.
export type AgentSessionBackups = { touchedHashes: string[] | null; touchedFiles: number | null; touchedAt: number | null };
