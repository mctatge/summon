# Desktop companion

First implemented 2026-09-15; memory, routines, dedicated wake detection and local interpretation added 2026-09-16. The selected Liquid model was added on 2026-09-16. Listening controls moved to the menu bar on 2026-09-21. Work in flight was added on 2026-09-17, then Agent sessions, the menu-bar count and Where this stands later the same day. This document describes the running application, whatever its version number; the version itself lives in `package.json`. The earlier SDK, session, and generated-surface proposals in [architecture.md](architecture.md) and [build-plan.md](build-plan.md) are future work.

## How it works

Electron hosts a local metadata service and a React workbench. A small Swift helper reports active applications and optional focused-window context. File watchers and Automatic Filing receipts update a persistent ledger. Both the interface and the MCP bridge read this same service.

Routine commands use a deterministic command router. No language model runs in the background to interpret every app switch or file event. The service is independent of which AI client you use, but is currently hosted by the running Summon app rather than a separate launch daemon.

| Component | Responsibility |
|---|---|
| `src/core/companion.mjs` | File identity, scoped discovery, filing receipts, workspace associations, persistence, retention |
| `src/main/desktop-voice.mjs` | Synchronized voice state, lifecycle and microphone stop behavior |
| `src/main/main.mjs` | Electron lifecycle, validated IPC, native helper, menu bar, shortcuts, permissions |
| `src/main/commands.mjs`, `command-session.mjs` | Direct commands, successful-command receipts, validated routines |
| `src/core/knowledge.mjs` | Explicit facts, scoped project-note retrieval, durable routines |
| `src/main/local-model.mjs` | Optional local Ollama interpretation into reviewed commands |
| `src/main/wake.mjs`, `native/wake/` | Persistent offline keyword detector and setup |
| `src/main/benchmark.mjs` | Requested rankings and category caches |
| `src/main/engines.mjs` | Explicit, restricted CLI answer requests |
| `src/main/usage-claude.mjs`, `src/main/usage-codex.mjs`, `src/core/usage.mjs`, `src/main/engine-choice.mjs` | Usage meter: one bounded read per CLI of its own subscription windows, the cached readings and five-minute loop, and the fixed rule that picks an engine from them |
| `src/core/git-scan.mjs`, `src/core/work-in-flight.mjs` | Work in flight: read-only git scanner; service, cache and grouping jobs |
| `src/core/workstreams.mjs`, `src/main/workstream-engine.mjs` | Work in flight privacy filter, grouping prompt and answer checks; restricted Codex/Claude grouping call |
| `scripts/work-in-flight.mjs`, `src/renderer/WorkInFlightPanel.tsx` | `npm run flight` terminal view and the Work in flight panel |
| `src/core/standing.mjs` | Where this stands: the watermark you set by looking, the ledger of past scans, and the plain deltas behind the paragraph and the “Not moving” rail |
| `src/core/agent-sessions.mjs` | Agent sessions: combined view, groups and words, folder matching, settings, open targets |
| `src/core/sessions/` | Agent sessions: read-only readers for Claude, Codex, Cursor and Hermes, plus the SQLite copy, LevelDB and process-list helpers |
| `scripts/agent-sessions.mjs`, `src/renderer/SessionsPanel.tsx` | `npm run sessions` terminal view and the Agent sessions panel |
| `src/core/visual-repository.mjs`, `visual-goals.mjs`, `visual-workspace.mjs`, `src/renderer/VisualWorkspacePanel.tsx` | Visual workspace: bounded local git/import graphs, explicit goal storage, shared selection, kitchen and hook event history |
| `src/main/transcription.mjs`, `native/transcription-worker.mm` | In-memory PCM conversion and a private persistent Whisper worker |
| `src/main/rpc.mjs`, `scripts/mcp-server.mjs` | Local socket service and stdio MCP adapter |
| `src/renderer/` | Workbench, preferences, local recording, wake-gated voice and memory controls |
| `native/Context.swift` | macOS activity and download-source metadata |

## Workspace and appearance

The workbench opens on **Overview**: the command field, unfinished repository work, attention-first agent sessions, and each CLI's reported subscription windows. The navigation rail keeps **Files**, **Agents**, **Work**, **Memory**, **Visuals** and **Settings** within reach. Commands and voice results reveal the Files view, where the existing answer actions, file receipts and activity remain available. **New task** opens a deliberate launcher: choose a workspace and Claude or Codex, then start the installed CLI in Terminal with its existing sign-in and session hooks. Enter the task in Terminal once it opens.

The approved visual direction is a light gray desk, rounded white panels, generous spacing, Avenir Next with local system fallbacks, and a single black accent by default. Use the title-bar swatches or **Settings → Appearance** to choose Black, Forest, Blue, Plum, Terracotta, or a custom hex color. The choice is saved in Summon's local settings and survives restart. Text, hover colors and usage bars derive readable variants; status colors keep their separate meaning. Appearance settings make no network requests.

Overview cards use the existing local services, refreshing while the window is visible. They never start model grouping or mark work as reviewed. Counts and states come from actual records; unfinished work has no invented completion percentage. Unknown or stale usage remains labeled, and the full detail panels remain available through **View all** or **Details**. The browser-only preview continues to use clearly labeled sample data.

The shell and tokens live in `src/renderer/main.tsx`, `styles.css` and `workspace.css`; bounded overview cards in `WorkspaceOverview.tsx`; accent validation and contrast roles in `src/core/appearance.mjs` and `src/renderer/appearance.ts`; the picker in `AccentPicker.tsx`.


## What it observes

**Files.** The service watches direct files in Downloads and Desktop, configured Automatic Filing destination folders, and known subdirectories identified by records or filing receipts. It records names, sizes, paths, filesystem identity, available filesystem dates, source URL metadata, workspace association, and event times. It does not recursively crawl project repositories or open workbook/document contents. [Work in flight](#work-in-flight) is a separate, on-demand, read-only git reader. [Agent sessions](#agent-sessions) reads session details (never conversations) from Claude, Codex, Cursor and Hermes, only when one of its views is on screen, when the menu-bar count checks, when the terminal command runs, or when a connected agent asks.

Automatic Filing is optional. When installed, Summon reads:

```text
~/Library/Application Support/Automatic Filing/config.json
~/Library/Application Support/Automatic Filing/state/moves.jsonl
```

These are read-only inputs. Move and undo receipts are imported into Summon's own ledger. Summon does not change the filer configuration or move, rename, delete, or undo files itself. Assigning a file to a workspace changes its context record only.

The first scan establishes a baseline: files already present are not treated as if they were downloaded for whichever workspace you just selected. New arrivals can inherit your selected workspace. Path and filename matches are labeled as inferences, and a manual correction takes precedence. File recency uses real creation/modification and filing dates where available; periodic scans do not make an old file appear newly downloaded.

**Apps.** App activity records the application name and bundle identifier on app switches. Window context is separately enabled and may add the focused window title and local document path exposed by the app. It reads no full accessibility tree or document text. Excluded apps clear the current context without saving their identities. Defaults exclude common password managers; Preferences accepts additional app names or bundle identifiers.

**Download source.** The native helper reads the file's `kMDItemWhereFroms` metadata when present. It prefers an available referring page and removes URL credentials, query strings, and fragments. It does not read browser history or install a browser extension. Source metadata is not guaranteed; a download without it appears with “Source not recorded.” Paths and source URLs may still contain sensitive information.

The native helper's exact event format and sampling behavior are documented in [native/README.md](../native/README.md).

## Finding files and understanding limits

Try “find my Excel files,” “where did my workbook go,” or “show my downloads.” The ledger provides **Open file**, **Show in Finder**, and a workspace correction menu. “Open my calendar” opens Calendar; an HTTPS calendar destination in Preferences changes that shortcut.

Workspace selection is explicit intent. An observed application or filename is evidence, not proof of the task you are doing. Selecting a workspace does not make Summon index every file inside it.

A rename or move can be followed when the same filesystem identity is found within the known watched directories, or when a valid filing receipt records the change. Moving a file into an unobserved folder, a new nested directory without a known receipt, another volume, or a location outside the configured scope can leave a **Not found** record with the last known path. Copies have new identities. This is a bounded activity ledger, not a replacement for Spotlight or a universal filesystem index.

If macOS denies access to a folder, existing records are labeled **Access needed**, and their last known locations are retained. Use **File access settings** to review Summon under macOS **Privacy & Security → Files and Folders**. A later successful scan restores the current status. Folder-event failures fall back to metadata polling only for folders that can still be read.

Open and reveal requests resolve a known record and validate its current file identity before acting. A stale record does not authorize opening a different file that later appears at the same path. Hidden files, temporary downloads, and symlink paths are excluded from discovery.

Closing the window hides it; observation continues while Summon remains in the menu bar. The pause control stops collection without removing existing records. Quitting stops the service and microphone. Automatic startup at login is not configured by this build.

## Permissions and local voice

The controls are separate:

| Capability | Required access |
|---|---|
| Basic active-app tracking | The native helper; no Accessibility permission required |
| Downloads/Desktop file records | macOS file access to those locations; the OS may show Files and Folders prompts |
| Focused window title/document path | Explicit Window context setting plus macOS Accessibility permission |
| Voice commands | Explicit recording/listening action, microphone permission, `whisper-cli`, `ffmpeg`, and a local model |
| Fn shortcut | macOS Input Monitoring for the passive Fn helper; it starts only when the helper is installed |
| Usage meter | The installed `claude` and `codex` CLIs and their own sign-in: two bounded, tool-less invocations, each read-only and without a turn; no token, config or keychain entry is read |

Summon does not request Screen Recording. Input Monitoring is asked for only by the Fn shortcut helper below, never for typed text. Enabling Accessibility does not start voice, and granting microphone permission does not turn on listening at startup. Development executables and the packaged app can have separate macOS permission identities.

Voice is English-first and uses the installed `whisper-cli` and a selected `.bin` model. Choose the model in Preferences. The application recognizes the conventional `~/.cache/whisper-cpp/models/ggml-small.en.bin` location if that file already exists; it does not download models automatically. Install the CLI dependencies separately, then restart Summon so the health check sees them.

The **menu-bar star** lights green while the microphone is active and returns to monochrome when it is off. Choose **Start hands-free listening** from its menu to listen for “Summon”, or **Stop listening** to stop. These controls remain available while the workbench is hidden. The workbench shows detailed voice status, including starting, listening, transcribing, stopping, off, and error states. Listening stays off after launch, sleep, or screen lock.

Use the workbench microphone button for a single command, or **⌘⇧Space** to toggle recording. A plain **Fn** tap does the same once macOS **Privacy & Security → Input Monitoring → Summon** is allowed; Fn combinations, held keys and taps during other input are ignored, and set **Keyboard → Press fn/🌐 key to → Do Nothing** so macOS does not also open emoji or Dictation. The helper is a passive event tap: it distinguishes a bare tap from a chord and never decodes, stores or sends typed text; only a tap signal and a status reach Summon. It judges "another key is held" from the key-downs it has itself observed since it started, not from macOS's combined key state: on this Mac that state reported keycode 0 as held forever, which made every tap look like a chord (found 2026-09-19). If the grant is missing, Summon asks macOS once, shows the shortcut's state under **Preferences → Voice** with a link to Input Monitoring, and re-checks every ten seconds (and when the window is focused, or after wake or unlock) so a grant made in System Settings takes effect without a relaunch. The packaged bundle is signed with a designated requirement made of its bundle identifier rather than its build hash (`scripts/after-sign.mjs`), so a rebuild keeps an existing Input Monitoring grant. A grant made to a bundle built before this change is keyed to the old hash and has to be made once more, in this order: install the newly packaged bundle at `~/Applications/Summon.app` first (a reset done before the install would key the fresh grant to the old hash again), then reset only Summon's grant with `tccutil reset ListenEvent com.summon.companion`, then use **Input Monitoring → +** to add the installed `~/Applications/Summon.app`; Summon picks the grant up within ten seconds. Keep no other copy of the bundle under `~/Applications`, hidden or not: macOS resolves the grant's label and its Quit & Reopen by bundle identifier, and a leftover backup with the same identifier can be the one it picks (seen 2026-09-19). Rollback copies belong in the Trash or the `release/` folder. Silence ends a captured phrase. **Listen for “Summon”** enables the dedicated local sherpa-onnx keyword detector for this session. Voice activity detection sends short in-memory speech segments to a persistent keyword-only worker. Ordinary speech does not reach Whisper. A detected wake phrase is then transcribed locally; saying only “Summon” opens an eight-second window for the following command. A detector/transcription disagreement is discarded.

The small English Zipformer model has about 6.3 MB of selected inference weights. Install its pinned Python runtime and verified official archive deliberately:

```sh
python3 "native/wake/setup.py"
```

The script stores the runtime and model under the app data directory, outside the bundle. See [wake setup, source and license](../native/wake/README.md). Restart Summon after setup. The file ledger and single-command microphone mode work without the dedicated wake runtime.

Hands-free keeps the microphone on. It can miss speech or trigger incorrectly; synthetic checks do not establish accuracy in your room. Wake checks and accepted/explicit command transcription keep audio in memory. The desktop control, command bar and menu bar show listening state; the microphone starts off on every launch. Wake-model loading at startup does not open the microphone.

Starting voice also prepares a private Whisper worker through inherited stdin/stdout pipes. The selected speech model stays loaded for the listening session, then is released about 60 seconds after listening stops and outstanding work settles. An idle app does not preload Whisper. Renderer PCM WAV is validated and resampled in memory, without `ffmpeg` or audio files. The worker uses bounded command decoding, with no automatic cloud request. Recognized words appear in the command bar as soon as transcription finishes, before a command's lookup returns.

Capture ends after roughly 0.8 seconds of quiet, with a bounded threshold that adapts to recent voice level and background noise. The control distinguishes hearing speech, waiting for a pause, and transcribing. This remains an amplitude-based detector with an 18-second phrase cap; natural long pauses can still split a request. Speech decoding and OS action support are separate: dismissing arbitrary popups is not a current command handler.

## Memory and reusable routines

**Memory & routines** gives both clients the same explicit saved facts and searchable notes. Save a short fact with an optional workspace. Facts are labeled with who saved them and persist until you forget them; activity retention does not erase explicit memory. No background agent infers personal facts or promotes its own conclusions into memory.

A workspace named **Second Brain** enables a deliberately scoped note index: `Home.md` and `Projects/**/*Hub.md`. It does not index Profile, Areas, imported conversations, attachments, or arbitrary repository/document contents. Source bodies are read only for bounded search and never copied into persisted state. Results include a short excerpt, source title, line and modification date; edits are picked up on search. The UI shows the configured source list. A future explicit note picker can use the core’s bounded selected-note API, but is not exposed in this version.

After a direct command succeeds, **Save as routine** offers its exact command for review. Name it and choose a unique phrase such as “morning desk.” Typing or saying that phrase reruns the known handler without AI. A routine can be global or workspace-specific; an exact scoped phrase wins over its global counterpart. The saved list also offers Run and Remove. Built-in command collisions, unknown actions and arbitrary scripts cannot be saved. Only a main-process success receipt can create a routine from the UI; model prose cannot become executable code. Commands are validated again on use. Saving a routine does not freeze a particular file path: file searches use the current ledger each time.

## Optional local interpretation

An unrecognized request offers **Interpret locally**. It uses `summon-local:latest` through Ollama on a fixed loopback endpoint. The selected model is Liquid AI’s LFM2.5-1.2B-Instruct, using the official QAD Q4_0 GGUF (696 MB). No model is downloaded at app launch, no prompt goes to a cloud model, and no key is required. It receives the request plus a bounded list of workspace names and IDs; it does not receive file contents, memory excerpts, provider credentials or full computer history.

The model can propose a file search, calendar opening, known workspace, current context or model-ranking lookup. Code validates a finite schema and builds the corresponding familiar command. The interface shows that command and requires **Run this command**; a proposal does not execute itself. Unclear, unsupported and failed requests remain visible as clarifications/errors. This is a command interpreter, not an autonomous general reasoning model. Direct commands and saved routines never wait for Ollama.

Ollama holds a requested model for roughly 60 seconds after use, so an idle first request can be slower than the next one. Timeout and unavailable-model errors are explicit; there is no automatic cloud fallback. The adapter avoids unloading a model already loaded by another client at request time. See [routing measurements](routing-research.md) for the measured synthetic benchmark and its limits.

## Optional reasoning through existing CLIs

An unrecognized command also offers **Ask Claude**, **Ask Codex** and **Ask Auto**, which picks whichever CLI has the most of its subscription quota left (see [Usage](#usage)) and says which it chose and why. Clicking one explicitly shares the request, selected workspace, current app context, up to 20 recent file records, up to 12 activity entries, and up to 5 matching saved facts or project-note excerpts with that provider through its installed CLI. File records include paths and available source metadata; the scoped note excerpts are the only document content included. The interface discloses this before the request. No automatic AI call happens on an app switch, download, or routine command.

A captured voice request appears in the workbench, including unfamiliar requests that need a choice of agent. Speech alone does not submit it to a provider. These Ask buttons currently request restricted answers; they do not launch unrestricted coding tasks in the vendor UIs.

The answer operation uses a temporary working directory and restrictive, ephemeral CLI options. Claude receives no tools or MCP servers. Codex is launched with a read-only sandbox and disabled action paths as configured in `src/main/engines.mjs`. The prompt treats context as untrusted data and asks for an answer, not execution. The regular desktop controls remain responsible for opening files and destinations.

The CLIs own authentication. Summon does not implement OAuth, extract credentials, or provide a separate login. Complete the chosen CLI's normal sign-in flow yourself. The application forwards a small environment allowlist and does not implicitly pass provider API keys. This version has no in-app API billing mode and does not promise a particular subscription entitlement. Requests use the provider's existing account limits; install/login failures are shown as errors. A successful login for either provider must be verified separately. An expired Claude login offers **Reconnect Claude**, which opens Claude's normal sign-in command in Terminal. Summon does not handle the resulting tokens.

## Usage

Usage answers “how much of my Claude and Codex plan have I used?” with each CLI reporting on itself. Summon runs no OAuth and reads no token, config, keychain or cookie file; it asks the installed CLI, which owns the sign-in, and keeps what it says.

Two invocations, and nothing else:

- **Claude:** `claude -p --input-format stream-json --output-format stream-json --verbose --max-turns 1 --tools '' --permission-mode dontAsk --strict-mcp-config --mcp-config '{"mcpServers":{}}' --no-session-persistence --disable-slash-commands`, given one line on stdin, `{"type":"control_request","request_id":"usage-1","request":{"subtype":"get_usage","skip_behaviors":true}}`, and read until the matching `control_response`. No prompt is sent and no turn runs, so no quota is spent (about 0.9 s). `--setting-sources ''` and `--bare` are deliberately not passed: both hide the plan. The CLI's own `claude auth status` is not consulted; it reports logged out while turns succeed.
- **Codex:** `codex app-server` with `RUST_LOG=warn`, the JSON-RPC `initialize` / `initialized` handshake as `summon`, one `account/rateLimits/read` with `excludeResetCreditDetails: true`, then stdin ends and the process group is stopped (about 0.7 s). `thread/start` is never sent. A request the server makes during the read is refused at once.

Both run under the same allowlist environment as every other CLI child (`scrubbedEnv()`: `HOME`, `USER`, `LOGNAME`, `PATH`, `TMPDIR` and a few others, never a provider key), in a temporary working directory, with one 15-second deadline, and every line they print is parsed as JSON or dropped.

**What is kept.** Per provider: the plan name (`max`, `plus`, …), a status, the windows, and when it was read. Claude's `five_hour`, `seven_day`, `seven_day_opus` and `seven_day_sonnet` windows are kept (percent used, reset time); its session cost, behaviors and any window name Summon does not know are dropped. Codex's windows are named by their `windowDurationMins` (300 → `five_hour`, 10080 → `seven_day`, anything else by its minute count), never by which slot they came in; its account id, credits and upsell text are dropped. Statuses: `ok`; `not_signed_in` (the CLI said so, in its answer or its log); `not_installed`; `not_applicable` (Claude reports no subscription or no limits, which is not the same as 0 % used; Codex reports null limits); `error` (a timeout, an early exit or an answer Summon could not read). The readings live in `usage.json` (0600) in the data folder, together with two settings; a reading older than 20 minutes is shown as stale and never routed on.

**When it reads.** Five seconds after Summon starts, then every five minutes; not while the Mac is asleep, again shortly after it wakes or unlocks, and not at all once Summon is quitting. Also on **Refresh usage** in the menu-bar menu or in **Preferences → Usage**, on a `usage` call with `refresh: true`, and never otherwise. One read per provider at a time: a second request while one is running waits for it. A read that fails is recorded as an error status until the next one.

**Where it shows.** The menu-bar menu has two read-only rows (“Claude 5h 27% · 7d 18%”, “Codex 7d 1%”, or “Claude · not signed in”) and **Refresh usage**. **Preferences → Usage** shows every window with its reset time in local time, when each provider was last read, the **Ceiling** (default 85 %), the **Default** engine, and a Refresh button. Connected agents get the `usage` and `pick_engine` [MCP tools](#shared-context-through-mcp).

**Routing on it.** **Ask Auto** under an unrecognized command, and an agent's `pick_engine`, choose Claude or Codex by a fixed rule (`src/main/engine-choice.mjs`), with no model involved: a pinned engine wins; a thread already running somewhere is never switched; otherwise the provider with the most of its 5-hour window left, tie broken on the 7-day window; a provider with any window at or over the ceiling is unavailable; a provider whose usage is unknown or stale is neither preferred nor counted as empty; with both unavailable, or nothing to go on, the default engine. The answer names the engine and the reason (“more of its 5-hour window left (Claude 73% left vs Codex 59%)”). Work in flight grouping keeps its own explicit Codex/Claude setting.

**Settings.** In `usage.json`: `usageCeiling` (a whole number from 50 to 100, default 85) and `defaultEngine` (`claude` or `codex`, default `claude`). An unreadable file is kept as `usage.json.corrupt-*` and the meter starts clean.

## Work in flight

Work in flight answers “what is unfinished?” across the git projects you work in, without reading diffs. For each project it shows:

- **Places:** the main folder plus any worktrees (extra copies of the project folder that Claude Code, Codex or Cursor work in). Each place shows its branch and plain state words such as “not saved yet” or “2 saved, not shared.”
- **Workstreams:** the unsaved changes in one place, split by what they are for, such as “Templates tab: new preview” and “Customer outreach: notes for the pilot.” Each has a readiness label, file count, lines added and removed, the file list, and sometimes a suggested commit message to copy.
- **Branches:** separate lines of work not yet folded into the main line, with a one-line plain summary. Merged ones are marked “done, safe to clean up.”
- **Set aside:** stashes, which are changes put on a shelf.

Above all of it, one paragraph says what changed since the last time you looked, and a short rail at the bottom lists work that has stopped. Both are described in [Where this stands](#where-this-stands).

Open it from the workbench: **⌘⇧J**, then **Work in flight** under Quick access, or **⌘G** while the workbench is in front. **Show in Finder** selects a place's folder in Finder; it never opens or runs what is inside (a folder named like `Tool.app` would otherwise launch). Connected agents get the same view through the `work_in_flight` and `group_work_in_flight` [MCP tools](#shared-context-through-mcp).

From a terminal in this repository, `npm run flight` prints the same view as a tree. Summon must be running; otherwise the command says to open it first. Put flags after `--`, for example `npm run flight -- --project Studio --group`.

| Flag | Effect |
|---|---|
| `--project <name or id>` | Show one project only |
| `--group` | Ask for fresh grouping, then wait up to six minutes while showing progress |
| `--force` | With `--group`, regroup places that have not changed |
| `--files` | List the files under each workstream |
| `--all` | List clean projects one by one instead of on a single “All caught up” line |
| `--json` | Print the raw view as JSON. Use `npm run -s flight -- --json` or `node scripts/work-in-flight.mjs --json` when piping, because plain `npm run` prints its own header lines to stdout first |

**Which projects.** Every Summon workspace that is a git repository (a folder with a `.git` directory), plus any `extraRoots` in the settings file below. A `.git` folder that borrows another repository (it has a `commondir` file) is refused. Worktrees are found through git itself. Anything under `excludedRoots`, and any path with a sealed folder in it, is skipped, judged both by the path git lists and by the real folder behind it (so a symlinked worktree cannot point into a skipped folder). A linked worktree is read only if its `.git` file points into this repository and git sees it as this repository's checkout; otherwise it shows “This worktree folder no longer belongs to this repository.”

**Read-only.** Work in flight never changes a repository. It runs git with optional locks, hooks, file-system monitors, external diff tools and text filters turned off. Filters are looked up in every folder (a worktree's own config and branch-specific includes count) before any folder is read; if that lookup fails, the folder is not read. Submodules are compared by commit only, so git never starts inside them: a submodule whose only changes are uncommitted files does not appear. It never fetches, pulls, pushes, stages, stashes, switches branches or cleans up. That means “newer on GitHub” counts come from the last time something else fetched, and the date is shown (“as of Sep 16”). The exact flags are in `src/core/git-scan.mjs` and the [2026-09-17 decision](decisions.md#2026-09-17--work-in-flight-read-only-git-status-and-grouped-workstreams).

**When grouping runs.** Reading git status needs no AI. Splitting changes into workstreams, and writing the one-line branch summaries, uses the reasoning model chosen in the panel: **Codex** (the default, your ChatGPT sign-in), **Claude** (your Claude sign-in), or **Folders only** (grouped by folder on this Mac, with no AI). A model call happens only when you:

- click **Group changes** (the first click is also your consent; until then nothing else can send);
- open the panel with **Group on open** turned on (the default) while at least one grouping is out of date, after that first click;
- run `npm run flight -- --group`; or
- ask a connected agent, which then calls `group_work_in_flight` (also only after that first click).

Nothing groups on a timer, no file watcher starts a grouping, and no AI runs in the background. One grouping job runs at a time, and its progress shows in the panel. A place whose changes are the same as at its last grouping is skipped unless you force it. A place with a single change is always shown grouped by folder, without a model. Until a place is grouped, its changes are shown grouped by folder. Model-written titles and summaries are labeled with the model that suggested them, and marked “changed since grouped” once the files change again. A worktree on the same commit whose every unsaved change is also in the main folder, byte for byte, is shown collapsed and is not sent twice.

**What grouping sends.** The panel shows this before anything is sent, and nothing is sent until you press **Group changes** once. For each place being grouped, the chosen CLI receives the project name, folder and branch names, recent commit messages, other branch names with their commit messages and touched files, changed file names with line counts, and up to 8 changed lines per file (160 characters each, 48 KB per request). It also receives the first lines of up to 20 new text files, and up to 8 non-private file names inside each new folder. Emails, phone numbers, long tokens, API-key patterns and assigned secrets (`DB_PASSWORD=…`, `apiKey: "…"`) are masked first; lines are read at twice the shown width so a value crossing the cut is masked or dropped, never half-sent. A path to a private file quoted inside a changed line, commit message or branch name (including `../` links and names with spaces) is replaced with `[private path]`. File types limit what is sent:

- **Private** files send no name and no contents; they are counted under their folder (“private folder pilot/people/ · 2 changed files”), with file types, the new/edited/deleted mix, line counts and the edit day. A folder that is private only because its own name looks private (“Jane Doe transcripts”) is not named; its files are counted under the folder above it. A file renamed out of a private folder keeps its contents withheld. A path is private when any part of it is a common private name (`customers`, `clients`, `contacts`, `people`, `emails`, `legal`, `contracts`, `invoices`, `medical`, `tax`, `secrets`, `credentials`, `private`, `personal` and a few more; the full list is `DEFAULT_PRIVATE_SEGMENTS` in `src/core/workstreams.mjs`). It is also private when the file name looks like a transcript, résumé, invoice, passport or SSN, when it is a saved email, mailbox or contact card, or when it is under one of the project's `privatePaths`.
- **Secrets** (`.env`, `.env.local`, `prod.env` and other `*.env` files, `.dev.vars`, `*.tfvars`, keys such as `*.pem`, `*.p8` and `*.ppk`, certificates, service-account keys, and files named like tokens or credentials) are handled as private.
- **Data, generated and binary files** (spreadsheets, databases, lockfiles, logs, reports, build output, images, PDFs) send only their name, status and counts.

Private files still appear by name in the panel and the terminal view, which stay on this Mac. The `work_in_flight` MCP tool leaves them out of its file lists and only counts them (`withheldFiles`), and replaces private paths quoted in commit subjects, stash messages and errors with `[private path]`, because its answer goes to the agent's provider. The panel's **What stays private** section lists the built-in private names and lets you add private folders per project; it opens by itself before the first grouping. Code and notes in folders not marked private can still contain business plans or customer details: mark those folders in `privatePaths`, or choose **Folders only** to send nothing. The CLI call uses the same restricted settings as Ask: a temporary folder, a small environment allowlist, no tools, no MCP servers, and Codex's read-only sandbox. The CLIs own login. Excerpts are built in memory for one request and are not saved.

**Settings file.** The panel sets the engine, **Group on open** and each project's private folders. Everything else lives in `work-in-flight.json` in the data folder. If the file cannot be read (a typo, an unknown key, a bad value), Summon keeps it as `work-in-flight.json.corrupt-*`, keeps every valid setting and every private folder it already knew, and turns grouping **off** until you choose Codex or Claude again in the panel. Quit Summon before editing it, because the running app rewrites the file. Change only the `settings` object and leave the rest of the file as it is. Example `settings` value:

```json
{
  "engine": "codex",
  "effort": "medium",
  "claudeModel": "opus",
  "groupOnOpen": true,
  "extraRoots": ["/Users/your-name/Code/side-project"],
  "excludedRoots": ["/Users/your-name/Projects/Old Experiments"],
  "privatePaths": {
    "/Users/your-name/Projects/Studio": ["pilot/", "docs/legal/"]
  }
}
```

- `engine`: `codex`, `claude`, or `off` (Folders only). `effort`: how hard the model thinks, `low`, `medium` or `high`. `claudeModel`: `opus`, `sonnet` or `haiku`.
- `extraRoots`, `excludedRoots`: absolute folder paths, up to 20 each. An extra root must be a git repository.
- `privatePaths`: keyed by the project's absolute path; a trailing slash or a symlinked path is resolved to the real folder when the file is read. A key that is not a folder on this Mac is reported in the panel.
- `consentedAt`: set by Summon the first time you press **Group changes**; it cannot be set from the panel or an agent. Each entry is a folder or file prefix relative to the project root, such as `pilot/`, with no `..`. Up to 40 per project, each up to 200 characters.

**What the words mean.** The panel has the same glossary under “What do these words mean?”

| Words | Meaning |
|---|---|
| Saved (commit) | A checkpoint recorded on this Mac |
| Shared (push) | Copied to GitHub |
| Not saved yet | Changes in the folder that are in no checkpoint |
| N saved, not shared | Checkpoints on this Mac that GitHub does not have yet |
| Only on this Mac | Work with no copy on GitHub |
| N newer on GitHub | Checkpoints on GitHub that this Mac has not brought in, as of the date shown |
| Branch | A separate line of work |
| Worktree | An extra copy of the project folder that an agent works in |
| Set aside (stash) | Changes put on a shelf |
| Merged; done, safe to clean up | Folded into the main line and not checked out in any folder that still exists, so the branch is no longer needed |
| Nothing new on it yet | A branch with no commits beyond the main line that is checked out in a worktree; with unsaved changes there it reads “nothing saved on it yet, work in progress” |
| N commits not in main | Checkpoints on a branch that the main line (the default branch, usually `main`) does not have |
| Needs a decision on conflicting edits | Git stopped because two edits changed the same lines |
| Not on a branch | The folder is parked on one fixed checkpoint |
| Its unsaved changes are all in Main folder too | A worktree whose every unsaved change is also in the main folder, byte for byte |
| Could not be checked | Git could not read this folder; the project headline says why, and the project is listed as needing a look |
| GitHub copy was deleted | The branch used to be on GitHub and was removed there |
| Folder is gone | Git still lists this worktree, but its folder no longer exists |

Readiness labels are the model's suggestion, not a check: **Looks ready to save**, **Still in progress**, **Scratch, probably keep local**, and **Made by a script** (reports, logs, state files).

**Limits.**

- A full scan has 12 seconds. A project not finished by then shows “Still checking; try again in a moment.” Each git command has 8 seconds and 8 MB of output. Four projects scan at once, and a scan less than 20 seconds old is reused.
- Each place checks size and change time for up to 400 changed paths. A new folder is summarized from up to 2,000 file names. Up to 25 unmerged branches get commit details, and up to 20 stashes are listed.
- A grouping request is capped at 400 KB. Past 250 changes, the rest are rolled up by top-level folder. A model call can take up to five minutes, and two run at once. If a project fails, its previous grouping stays and the error is listed.
- Files ignored by `.gitignore` are not shown. Branch counts are fastest with git 2.41 or newer; older git falls back to a slower count.
- Groupings are a model's reading of file names and short excerpts. They can be wrong or out of date. The file lists and state words come straight from git.

## Visual workspace

Open **Visual workspace** in the title bar, or **⌘⇧V** while focus is outside a text field. The Kitchen opens on **All projects**, combining the sessions already detected by Summon across agent apps, projects, folders and sessions without Git attribution. Working sessions and sessions needing attention come before history. Use the project selector to filter; choose a Git project when opening Goals, Codebase or Git. Kitchen and Live trace do not wait for a repository scan, and their session identities remain the same across views. The browser preview is explicitly labelled sample data; its goal edits stay in memory.

**Git** draws actual commit-parent edges and locally stored branch, remote-tracking and tag references. It performs no fetch, checkout, merge or other repository write. Parents outside the bounded history remain boundary references, not invented roots. Local remote-tracking references can be stale.

**Codebase** groups tracked files into directory components and connects them using observed relative JavaScript/TypeScript import relationships. This is a bounded source scan on the selected checkout, not a generated architectural explanation. Dynamic imports, aliases, other languages and excluded or oversized files can leave gaps; coverage and truncation are shown. Secret, private, generated and vendor paths are excluded, and symlinks are not followed outside the repository. Source bodies are neither persisted nor sent to a model. Changed-file counts refer to the checkout scanned, not all worktrees combined.

**Goals** are explicit local records. Add a goal, give it milestones, choose its status, and optionally link it to a worktree, branch, session or component. Dependencies and parent links must remain acyclic and within the same repository. Commit activity, a finished agent turn or a quiet session never automatically marks a goal complete. Goal data is stored atomically in `visual-goals.json` in Summon's data folder, not in the repository.

**Kitchen** renders a local 3D room using Agenttrail’s MIT-licensed chef rigs, procedural art and animation, bundled with Three.js. Each cook represents one actual Summon session. Working cooks move between preparation and cooking stations; sessions needing input raise a hand, while quiet or stopped sessions remain distinct. Six cooks fit in each room, with paging for larger session lists. Tickets show each session’s project or folder, with an explicit unassigned fallback. Existing session visibility settings still apply. Select a chef or its keyboard-accessible ticket to inspect the session and follow its trace. Drag to orbit, scroll to zoom, or reset the camera. Pause animation keeps session states updating; reduced-motion preferences are honored. If WebGL is unavailable, the session tickets still work. The scene uses Summon’s existing readers without running Agenttrail’s service or another watcher. Movement illustrates observed activity and never asserts task completion or authorship of a change. See `docs/third-party.md` for attribution.

**Live trace** shows metadata reported through Summon's existing hooks, including event names, optional tool names, state and time. Step through the retained sequence to inspect it. History begins when this version receives events; old transcripts are not backfilled. Claude, Codex, Cursor and Hermes do not expose identical events, so an empty trace says no retained hook events, not that no work occurred. No prompt, tool arguments, tool output, conversation or private reasoning is stored.

Graphs are cached briefly and refreshed on demand. Visible-only polling keeps session state and trace data current without repeatedly scanning source while the panel is hidden. Renderer calls use trusted-window IPC, registered repository IDs and existing session keys; no caller can supply an arbitrary filesystem path. These views add no MCP mutation tool and make no model or network request.

## Where this stands

Work in flight says what is unfinished. This says what changed since the last
time you looked, and what has stopped. It is all subtraction between two scans:
no model, no network, and nothing sent anywhere.

**Since you last looked.** A short paragraph at the top of the panel, under the
totals: which projects moved, how many saves landed, whether anything became
ready to save, and which project has not changed in a while. If nothing moved
it says exactly that in one line. Before there is any history it says “Summon
starts counting from now.” Each project section, once expanded, carries what
changed in it: at most four lines, and then a count of the rest. What a project
has to say about having stopped belongs on the rail at the bottom, so the block
never repeats a row the rail is already showing.

**The mark moves when you look.** A project's mark moves forward when you have
had its section open and on screen for three seconds, or when you click **Mark
as read** on the paragraph. Opening the panel does not move it, and neither
does a scan. That is deliberate: a mark that moved whenever the panel opened
would leave the paragraph permanently empty.

**Not moving.** A short rail at the bottom, up to five rows: the folder, how
long it has been still, and why Summon says so. These rows are the four ways
work stops, and only the first is about a week: no file changed for seven days,
an agent working without changing a file, conflicting edits waiting, or a line
of work falling further behind the main line. A row that is a reading of repeated scans
rather than something git reported is marked as a guess and carries the folder
it was read from, so it vanishes the moment that folder changes:

| Words | Meaning |
|---|---|
| Moved | The folder's changes are different from what they were at your mark |
| N saves landed | Checkpoints recorded between your mark and now, with up to five of their messages |
| History was rewritten here | The checkpoint your mark recorded is no longer in the project, so Summon will not guess what landed |
| Waiting on a save | The changes look ready, a commit message is suggested, there are no conflicts, and nothing has changed since the last scan |
| Saved | A piece of work that was here at your mark is gone and checkpoints landed, so it was saved |
| Dropped | A piece of work that was here at your mark is gone with nothing saved |
| Not moving | No change to the folder's files for seven days |
| Spinning (a guess) | An agent is in the folder now and no file there has changed across three scans. The line says how long nothing has changed, not how long the agent has been working, which Summon cannot see |
| Blocked (a guess) | Conflicting edits are waiting on a decision across two scans |
| Falling behind | The main line has moved on, nothing new has been saved here, and the last checkpoint is over two weeks old |

Movement is judged by the changes themselves, never by a file's modification
time, because iCloud and backups touch files that nobody edited.

**What it reads.** The same read-only scan Work in flight already makes, plus
one extra git command for a folder whose changes moved since your mark: the
one-line messages of the checkpoints in between, capped at five. Commit
messages go through the same privacy filter as the excerpts grouping sends, so
emails, tokens and paths to private files are masked before they are shown or
saved, and a message that still names a private folder is left out entirely
while the count of what landed stays. Nothing about this feature calls a model.

**Sessions say where they are.** On the [Agent sessions](#agent-sessions) board
and in the folder chips, a row now leads with the project and the piece of work
the session is touching, and keeps the app's own title underneath in quotes.
Summon works out the piece of work from the paths of the files that session
edited, which its own app records, matched against the unsaved changes already
grouped for that folder. It reads paths only, never what was written in them,
never a prompt or a reply, and never the backup copies Claude keeps of your
files. Sessions whose app records nothing useful, such as Cursor's, keep their
plain project and folder line.

**Where it is kept.** `standing.json` in the data folder, 0600, capped at 512
KB, with the oldest samples dropped first and an unreadable file kept as
`standing.json.corrupt-*` while Summon starts counting again. It holds counts,
times, checkpoint ids, hashes of file lists and up to five filtered commit
messages per folder. It holds no changed lines and nothing from any
conversation. Each project's history stands alone, so one can be forgotten
without disturbing the others.

**Limits.**

- Up to 40 projects and 20 folders are remembered, with the last 12 scans of
  each folder. Older scans fall out first, and a project's mark outlives them.
- A piece of work is followed between scans by the set of files in it. A
  regroup that splits or merges work is followed when the file sets still
  overlap by half; past that, work reads as new.
- “Spinning” and “blocked” are readings of repeated scans, not reports from
  git, and they are labelled. “Moved”, “landed”, “saved” and “not moving” come
  from git and from your mark.
- A project you have never expanded is listed as not counted yet rather than
  counted as unchanged.

## Agent sessions

Agent sessions answers “what are my AI agents doing right now?” across the apps you run them in, without reading any conversation:

- **Claude:** Code sessions in the Claude desktop app, and `claude` running in a terminal.
- **Codex:** Codex threads in the ChatGPT (Codex) desktop app, and the `codex` command-line tool.
- **Cursor:** agents in Cursor.
- **Hermes:** chats in the Hermes app.

Sessions are grouped in this order: **Needs you**, **New replies**, **Working**, **Open, your move**, **Interrupted**, then recently active ones (titled **Earlier today**, or **Last 24 hours** and so on, following the recent-hours setting), which start collapsed. Each session sits in the first group that fits; a working session that also has a new reply stays under Working with an unread dot. A row leads with the project and the piece of work the session is touching, worked out from the paths of the files it edited, or, when it named no paths, from the hashed names of the files it backed up (see [Where this stands](#where-this-stands)), and keeps the app's own title under it in quotes, marked when you named it yourself. When several sessions in one project are on the same piece of work, which is often true, each row adds the one thing that differs: its worktree or branch, or how many files it has touched. When that address would only repeat the project, which is a main-folder session with no piece of work matched, the app's own title keeps the front of the row and the project sits in a chip beneath it, because a row that reads “Harbor · main folder” tells two sessions apart no better than nothing. Then the app, the folder it belongs to, the branch, and how long it has been in its state (“Working · 12 min”, “Waiting for your OK · 3 min”). A button on the row opens that exact session (see **Opening a session** below).

Open it from the workbench: **⌘⇧J**, then **Agent sessions** under Quick access, or **⌘E** while the workbench is in front. The Quick access count adds up sessions that need you and new replies. **Next that needs you** opens the session that has waited longest. Folder rows in [Work in flight](#work-in-flight) get a chip such as “Claude working here” or “Codex needs you here”; clicking it opens Agent sessions. Connected agents get the same view through the `agent_sessions` [MCP tool](#shared-context-through-mcp).

From a terminal in this repository, `npm run -s sessions` prints the view. It asks the running Summon and gets the same view agents get (see **What agents get** below). If Summon is not running, it says to open it first, or to add `--direct`. Put flags after `--`, for example `npm run -s sessions -- --app codex`.

```text
Agent sessions · 1 needs you · 1 working
Needs you
◐ Fix share links            Claude app · Studio · upbeat-raman     Waiting for your OK · 4 min
Working
◉ Pilot import               Codex · Studio                         Working · 18 min · 2 helpers
```

| Flag | Effect |
|---|---|
| `--app <name>` | Only sessions from `claude`, `codex`, `cursor` or `hermes` |
| `--recent` | Also list sessions that were active recently but are not working, waiting or open now |
| `--direct` | Read the session files in the terminal process, without Summon. Folders are not matched to your Work in flight projects, and nothing in Summon's data folder is changed |
| `--json` | Print the view as JSON. Use `npm run -s sessions -- --json` so npm's own header lines stay out |

**What the words mean.** The panel has the same glossary under “What do these words mean?”

| Words | Meaning |
|---|---|
| Working | The agent is busy on your last request right now |
| Needs you | The agent stopped and is waiting on you: to approve an action (“Waiting for your OK”), answer a question, review a plan, or look at a problem (“Stopped with a problem”) |
| New reply | The agent finished and you have not looked yet. This is the app's own unread dot |
| Open, your move | The session is open in its app and idle; the next message is yours |
| Interrupted | A turn was cut off, usually because the app quit in the middle of it |
| Earlier today, Last 24 hours | Active recently, but not running now. **Show quiet** hides or shows this group |
| Helpers | Sub-agents the session started that are running now |
| Worktree | An extra copy of the project folder that an agent works in |
| Probably | The app does not record this, so Summon worked it out from indirect signs. It can be wrong |
| Started from Summon | The session was started with **Start Claude here** or **Start Codex here** in the workbench. Summon's own note, not the app's; such sessions report their state through [Summon hooks](#summon-hooks) |

**Where each state comes from.** Everything is read on this Mac, from the apps' own files:

| App | Session list | Working and open | Needs you | New reply |
|---|---|---|---|---|
| Claude | Live session records in `~/.claude/sessions/`, desktop session files in `~/Library/Application Support/Claude/claude-code-sessions/`, and, for terminal sessions, the end of the transcript (title, times, and the paths of the files the session edited, never message text) | The live record's status, trusted only while its process runs with the same start time, or the session's own hook events when they are newer (see [Summon hooks](#summon-hooks)) | The live record's “waiting” status and what it waits for, or the session's own hook events when they are newer. A saved error newer than the last activity shows “Stopped with a problem” | The Claude app's own unread list, read from its local storage |
| Codex | The thread list in `~/.codex/state_<n>.sqlite` | Open while the thread's lock file exists in `~/.codex/thread-writer-locks/` and Codex is running; working when the thread's log also ends on a started turn. A started turn with no lock shows Interrupted. A turn-ended report from a session started in Summon turns a lingering started turn open | Only “Probably waiting for your OK” (see Limits) | The unread list in `~/.codex/.codex-global-state.json` |
| Cursor | The agent list (`composerHeaders`) in Cursor's `state.vscdb` | Working only while Cursor runs and the agent has a run in progress. A run left unfinished when Cursor quit shows Interrupted. Cursor has no open state | An action waiting for approval (“Waiting for your OK”) or a plan to review (“Plan ready for review”) | Cursor's unread flag |
| Hermes | `~/.hermes/state.db` | Working while a running Hermes process holds the chat's turn lease; open while `~/.hermes/runtime/active_sessions.json` lists it for a running process. A lease left by a process that is gone shows Interrupted | Never (Hermes does not save it) | Hermes's last-read time is older than the chat's last activity |

**Read-only, no conversations.** Agent sessions reads ids, titles, folders, branches, times, states, unread marks and the paths of the files a session edited, nothing more. It never reads messages, prompts, tool output, previews or drafts, and it never opens the backup copies of your files that Claude keeps alongside those paths. It never reads the command lines of running programs, because a `claude -p` command line can hold a prompt; the process check uses only the process id, its parent, its start time and the program path. It never writes, renames, deletes or locks another app's files, never connects to their sockets or local servers, and never runs their command-line tools. Databases are cloned (an instant copy on APFS, taken together with their `-wal` and `-shm` files) into a private temporary folder; only the clone is opened, and it is deleted after each read. Claude's local storage is read straight from its files without taking its lock. The only free text a row shows is the app's own title and, when the session's edited paths match a piece of work, that workstream's title from Work in flight: both are treated as untrusted, stripped of control characters and cut at 120 characters. Any session whose folder has a sealed-project segment is dropped entirely.

**How a session is matched to a piece of work.** First, the paths of the files it edited, taken from the transcript's own metadata lines. Most sessions do not carry those in the part that is read, so there is a second source: Claude keeps one folder of backups per session and names every entry after the file it holds, as a hash of that file's full path. Summon lists that folder by name only and hashes the file lists Work in flight already has, so it can ask whether this session touched any of them. It never opens a backup, never follows a symlink in that folder, and never turns a hash back into a path, which it could not do anyway. A match this way looks only at the entries from the session's most recent stretch of work, because a session open for days has backed up whatever it touched on its first day. It needs at least two files in common that are a twentieth of what the session has written, or a single file that is a third of both sides, and a clear win over the runner-up; a tie names nothing. Matches from hashes are shown as a guess, with the same Probably mark the rest of the panel uses, and private files are left out before anything is hashed. When nothing matches, the row falls back to a real count of everything that session has written, wherever it wrote it ("touched 12 files in all, most recently 4 min ago"); the count and the time are that whole backup folder, not this project, which is what in all says.

**When it reads.** No AI and no network. A read happens when a visible view polls, when the menu-bar count checks, when you run `npm run sessions`, or when a connected agent calls `agent_sessions`. The window polls every 4 seconds while the panel is open, every 20 seconds for the Quick access count while the workbench is visible, and every 10 seconds for the Work in flight chips while that panel is open. While the workbench window is hidden, the window's checks are answered from the last read rather than a new one (**Check again** still reads). The menu-bar count below is the one thing that reads on a schedule of its own, and turning it off puts the app back to reading only when you or an agent ask. A terminal or agent request still reads, even with no window open. One read covers all four apps and has 4 seconds; the app check takes at most a second of it, and if it is slow the sessions still appear, only without live marks; an app that takes longer shows “Still checking” and catches up on a later read. A read less than 3 seconds old is reused unless Work in flight has found different folders since, and each app skips files that have not changed.

**What agents get.** `agent_sessions` returns the same groups, words, app, project and branch for up to 60 sessions, with no full folder paths. Recently active sessions are left out unless asked for, or unless nothing else is listed. Titles get the same masking as [Work in flight](#work-in-flight) (emails, tokens, key patterns and paths to private files), and a session whose folder is private in its project (a built-in private name or one of that project's `privatePaths`) shows “Title hidden (private folder)”. Titles still reach the agent's provider, and apps often write them from what you asked, so treat them as sensitive. The tool cannot open, message or control a session.

**Opening a session.** Only a click, or Enter on a focused row, in the panel, or a row in the menu-bar count's menu, opens anything. Agents and the terminal view cannot. Summon builds the link itself from the session's id, checks the id's exact shape, and checks that the app macOS would use for that link is the expected one before opening it:

| Session | What the button does |
|---|---|
| Claude app | **Open in Claude** (`claude://claude.ai/epitaxy/local_…`) |
| Codex | **Open in Codex**, in the ChatGPT (Codex) app (`codex://threads/<id>`) |
| Cursor | **Open in Cursor** (`cursor://anysphere.cursor-deeplink/agent?id=<id>`) |
| Hermes | **Open in Hermes** (`hermes://open/<id>`) |
| Claude in Terminal, still running | **Show folder** selects its folder in Finder. Summon cannot bring a terminal tab to the front |
| Claude in Terminal, finished | **Copy resume command** copies `cd <folder> && claude --resume <id>` for you to paste into a terminal. Summon never runs it |
| Anything else with a folder | **Show folder** |

Opening a session in its app may clear that app's unread dot. Summon itself never changes it.

**The menu-bar count.** While sessions need you, Summon puts a small count in the menu bar: `◐ 2` when two sessions are waiting on you, `◉` when something is working and nothing is waiting, and nothing at all when it is quiet, so an empty slot never sits there. Hovering says it in words ("2 sessions are waiting on you. 1 working."). It is plain text rather than an icon, so it takes the menu bar's own colour on a light or a dark bar and cannot be confused with Summon's own star icon. Clicking it opens the workbench on **Agent sessions**. Right-clicking lists up to five of the sessions waiting on you, each named by its title, app and project, and opening one from there goes through exactly the same checks as opening it from the panel; below them are **Open the board** and **Stop counting**, which sets `trayCount` to `off`.

This is the only part of Summon that reads on a timer. It re-reads the same local session metadata the panel reads, with no AI and no network, every 60 seconds, or every 20 seconds while the count is showing something. It stops while the Mac is asleep, stops while Summon is quitting, and with `trayCount: "off"` it never runs at all. A read that fails is ignored quietly until the next one.

**Settings file.** `agent-sessions.json` in the data folder holds the settings below and nothing else. Summon notices edits on its next read. If the file cannot be read, Summon keeps it as `agent-sessions.json.corrupt-*`, keeps every valid setting, and says so in the panel.

```json
{
  "version": 1,
  "settings": {
    "recentHours": 24,
    "newReplyHours": 72,
    "showQuiet": true,
    "showBackground": false,
    "trayCount": "needs",
    "pathAliases": {
      "/Users/your-name/Studio": "/Users/your-name/Projects/Studio"
    }
  }
}
```

- `recentHours`: how far back “recently active” reaches, a whole number from 1 to 168 (default 24).
- `newReplyHours`: how fresh an unread mark has to be to count as a **New reply**, a whole number from 1 to 720 (default 72). The apps never clear their own unread marks, so an unread session older than this keeps its unread dot but is listed under the recently active group, whose heading then says how many rows there are and how many of them are unread (“Earlier (18, 14 unread)”). The Quick access count and the panel's **new replies** tally count only the fresh ones.
- `showQuiet`: whether the panel shows the recently active group (default on). Flipping **Show quiet** in the panel overrides it for that window and is remembered there; the file is not changed.
- `showBackground`: whether runs with no window, such as `codex exec`, are listed outside Needs you (default off).
- `trayCount`: what the menu-bar count shows. `needs` (the default) puts it there while sessions need you or something is working, `working` also counts background runs that `showBackground` keeps out of the list, and `off` means no menu-bar item and no background reading at all. **Stop counting** in the menu writes `off`. Because nothing is left running to watch the file after that, setting it back by hand starts the count again the next time you open the workbench, not before.
- `pathAliases`: moved folders, as old full path → new full path, up to 50. Sessions started before a folder moved still point at the old path; an alias sends them to the new one (the longest matching old path wins). Without an alias, Summon tries to match the old folder's name to a Summon workspace name, ignoring capitals, spaces, dashes and underscores. Aliases cannot point into a sealed folder.

**Limits.**

- Hermes keeps “waiting for your approval” in memory only, so a Hermes chat that is waiting on you shows as Working or Open, never Needs you.
- Codex also keeps approval waits in memory only. Summon shows “Probably waiting for your OK” only when the thread asks you (not automatic review) to approve actions, a tool call has no result yet, and the thread's log has not changed for 30 seconds. Most Codex turns use automatic review, so this is rare.
- Cursor has no separate process per agent. Working shows only while Cursor is running.
- A running terminal `claude` cannot be brought to the front, and terminal sessions have no unread mark. Finished terminal sessions are listed only if their transcript changed in the last 24 hours. Older `claude` versions that do not report a status get a “Probably” state worked out from the end of the transcript.
- If Claude's unread marks cannot be read, no Claude session shows as a new reply and the panel says so. Summon does not guess.
- Up to 300 sessions per app. Archived sessions are left out. So nothing is listed twice, Claude sessions that Codex or Cursor imported are skipped (unless you continued one in Codex), and sub-agents are counted as helpers instead of rows. Cursor drafts and empty agents are skipped.
- Hermes runs its own Codex app-server against the same store, so a Hermes chat would otherwise be listed twice. Threads with no Codex client of their own whose folder is inside `~/.hermes` are left to the Hermes reader, whose row is also the one whose link works. If a Hermes chat picks a workspace of its own, its Codex thread's folder becomes that repository and this rule stops catching it.
- A session is matched to the deepest Work in flight folder that contains it, so a Claude worktree inside a project counts for that worktree. A session outside every workspace shows its folder name.
- A row can only name a piece of work in a folder Work in flight has grouped. In a folder with no workstreams there is nothing to match to, so the row says where it is working and how much it has touched instead. Only Claude backs its files up this way; Codex, Cursor and Hermes rows rely on the paths their own sessions report.
- States can trail the apps by a few seconds. “Working” means the app reports a turn in progress, not that the turn is making progress.

### Starting a session from Summon

The workspace strip has **Start Claude here** and **Start Codex here**. A click writes one small script under the data folder (`launch/<app>-<workspace>-<id>.command`, mode 0700, removed after a day) and opens it with `open -a Terminal`, the same way the sign-in links work. Terminal titles the window after the workspace. Terminal inherits your login shell, not Summon's allowlist environment, so the script unsets provider keys itself, `cd`s into the workspace's real path and `exec`s the installed CLI. Sign-in stays with the CLI; no key or token is passed. Nothing starts over RPC, MCP or `npm run sessions`.

The Claude script:

```zsh
#!/bin/zsh
# Written by Summon for one launch; safe to delete.
set -eu
unset ANTHROPIC_API_KEY OPENAI_API_KEY CODEX_API_KEY CLAUDECODE NODE_OPTIONS
cd '<workspace>'
exec '<claude>' --session-id '<uuid>' --settings '<data>/claude-hooks.json' [--mcp-config '<data>/claude-mcp.json']
```

`--session-id` gives the launch and its session one id, so the row can say **Started from Summon** at once. `--settings` hands that one session Summon's hooks (below); it merges with `~/.claude/settings.json`, so your own hooks keep running. `--mcp-config` is added only when `~/.claude.json` has no `summon` server, and never with `--strict-mcp-config`.

The Codex script:

```zsh
#!/bin/zsh
# Written by Summon for one launch; safe to delete.
set -eu
unset ANTHROPIC_API_KEY OPENAI_API_KEY CODEX_API_KEY CLAUDECODE NODE_OPTIONS
cd '<workspace>'
exec '<codex>' -C '<workspace>' -c 'notify=["<node>","<summon-hook.mjs>","codex","--launch","<tag>"]' [-c 'mcp_servers.summon.command="<node>"' -c 'mcp_servers.summon.args=["<mcp-server.mjs>"]']
```

Codex cannot be given a thread id up front, so the launch tag travels in `notify` and binds to the thread on its first finished turn. For that session only, `notify` replaces the one in `~/.codex/config.toml`; the file itself is not changed. The MCP lines appear only when `config.toml` has no `[mcp_servers.summon]`. Without `node` on this Mac the session still starts, without hooks or an attached server, and the message under the command field says so.

Refused: the vault (a workspace named Second Brain, by name and by path), any sealed folder, and a folder that no longer exists.

### Summon hooks

A session started from Summon reports its own state through `summon-hook.mjs`, a small script Claude runs as a settings hook and Codex runs as `notify`. On each event it sends one line to Summon's private socket and exits 0 within 0.9 s, whether or not Summon is running, and it never writes to its standard output (Claude would show that to the model). Events: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, Notification (the permission, question and idle kinds), Stop, StopFailure and SessionEnd for Claude; the turn-ended `notify` for Codex. The line:

```json
{"method":"hook","v":1,"app":"claude","event":"PreToolUse","sessionId":"<uuid>","cwd":"/Users/you/Projects/Y","toolName":"Edit","kind":null,"launch":null}
```

Never prompt text, transcript paths, tool input or output, notification message text or turn ids: the reporter has no field for them, and the socket refuses a line with any key beyond these nine, an unknown event name, an id that is not a UUID, or more than 4 KiB. Each accepted event updates that session's entry in `hook-events.json` (see [Local data](#local-data-and-personal-configuration)). The board takes a reported state over the app's own record when that record is inferred or older, shows it without “Probably”, ignores a working report older than ten minutes, and ends a live row at once on SessionEnd. A Stop makes a row “Open, your move”, never “New reply”: Summon still keeps no unread marks of its own.

**Sessions you start yourself.** Preferences → **Agents you start** → **Install Summon hooks** merges the same Claude hooks into `~/.claude/settings.json`, only on that click. It first copies the file byte for byte to `settings.json.summon-backup-<YYYYMMDD-HHMMSS>`, keeps every other entry and key (existing entries, such as a date echo or your own Stop hook, stay first in their lists), and writes the result atomically. A second click changes nothing and makes no second backup; **Reinstall** appears when the installed entries point at a node or reporter path that has moved. Summon never edits `~/.claude.json` or `~/.codex/config.toml`. Codex hooks are not offered: Codex trusts a hook only after its own review dialog, so a session started from Summon reports through `notify` instead.

## AI Stupid Level rankings

Create a data key through [AI Stupid Level](https://aistupidlevel.info/account/data-keys), then save it in Preferences. The key is encrypted using Electron's macOS secure-storage facility and is not returned to the renderer. Direct requests go to the source's current-models endpoint only after a rankings command. Results are attributed, timestamped, and cached for one hour per category; there is no automatic hourly polling.

As verified on 2026-09-15, the free data tier permits **10 requests per day and 1 per minute**, with the daily quota resetting at **00:00 UTC**. A different category can require another request even inside the cache period. The API documentation describes the free tier as evaluation access and reserves scheduled refresh for paid tiers. Check the source for current limits. [Official API documentation](https://aistupidlevel.info/api-docs)

No key means a setup message and an option to open the source. A failed request may show an older cached result with its timestamp and an error. Summon does not invent rankings when the source is unavailable. “Best coding model” means the ordering returned by this source for that category, not a universal recommendation.

## Local data and personal configuration

The default directory is `~/Library/Application Support/Summon/`; **Preferences → Show data folder** is authoritative. `SUMMON_DATA_DIR` can select a separate directory for development/testing.

| File | Purpose |
|---|---|
| `knowledge.json` | Explicit saved facts, routines, and scoped source configuration |
| `wake/` | Locally installed keyword runtime, model files and their license/source records |
| `state.json` | Workspaces, settings, file metadata, events, receipt identities, journal cursor |
| `bootstrap.json` | Optional personal workspace seeds, kept outside source control |
| `sealed.json` | Optional, per machine, never shipped: `{"segments":["..."]}`. Any path with a segment containing one of these names (any capitalization) is a sealed folder that Summon never reads, opens or launches into. Read once at startup and by `npm run sessions -- --direct`; missing means nothing is sealed, and a malformed file is reported on stderr and ignored |
| `benchmark-cache.json` | Timestamped source results by category |
| `benchmark-key.bin` | Encrypted data API key |
| `work-in-flight.json` | Work in flight settings, cached workstream groupings and branch summaries; no diff text. An unreadable copy is kept as `work-in-flight.json.corrupt-*` |
| `agent-sessions.json` | Agent sessions settings: recent hours, the quiet and background switches, what the menu-bar count shows, and moved-folder aliases. No session titles, ids or states. An unreadable copy is kept as `agent-sessions.json.corrupt-*` |
| `hook-events.json` | Hook events: per-session latest state plus a bounded sequence of event/tool identifiers, states and receipt times for [Visual workspace](#visual-workspace). Kept 7 days, at most 500 sessions, 100 history events per session, 2,000 history events total and 256 KiB overall; no prompt, transcript path, title, tool input/output or message text. An unreadable copy is kept as `hook-events.json.corrupt-*` |
| `visual-goals.json` | Explicit goals, milestones, statuses, dependencies and repository-local links. Private atomic saves; unreadable records are left untouched and reported |
| `claude-hooks.json` | The per-session hook settings **Start Claude here** passes with `claude --settings`; the same content on every launch |
| `claude-mcp.json` | Summon's MCP server for `claude --mcp-config`, written only when `~/.claude.json` has no `summon` server |
| `launch/` | One `.command` script per **Start Claude here** or **Start Codex here** click (mode 0700), removed after a day |
| `standing.json` | Where this stands: the mark you set by looking, the last 12 scans of each folder as counts and hashes, and up to five filtered commit messages per folder. No changed lines and nothing from a conversation. An unreadable copy is kept as `standing.json.corrupt-*` |
| `state.json.corrupt-*` | Preserved unreadable state for diagnosis/recovery |
| `assistant-entry.json` | Ignored. Builds before 2026-09-19 read it to hand the menu bar to another app; Summon no longer opens the file, and a leftover copy can be deleted |

The app creates its data directory with user-only permissions and writes records atomically. Metadata is stored as local JSON, not as an encrypted vault. Retention defaults to 30 days and is adjustable from 1 to 365. Old activity and missing-file records expire; files still observed in watched locations remain discoverable. Internal limits bound the ledger to 4,000 files and 6,000 events. Removing a record does not remove the file itself.

Use **Add workspace** for normal setup. For a personal bootstrap, place a file like this in the data directory before launch, replacing the example with real absolute paths:

```json
{
  "projects": [
    { "name": "Studio", "path": "/Users/your-name/Projects/Studio" }
  ]
}
```

The app imports missing workspace paths at startup. The bootstrap is not a general settings or secret file. Keep actual workspace maps, vault paths, keys, and local records outside this repository and application bundle.

## Menu bar and shortcuts

Summon is one ordinary macOS app: it starts with its Dock icon, its workbench window and its own menu-bar icon, and it never hands any of them to another program. There is no hidden or assistant mode, and no settings file changes what starts. A leftover `assistant-entry.json` from a build before 2026-09-19 is ignored (see [Local data](#local-data-and-personal-configuration)).

**The menu-bar icon** is a four-point star. It lights green while the microphone is active and returns to monochrome when it is off; its tooltip also reports the microphone state. Its menu has **Open Summon**, **Start hands-free listening**, **Stop listening**, **Voice command**, **Enroll my voice**, the two read-only [usage](#usage) rows with **Refresh usage**, and **Quit Summon**. The separate [menu-bar count](#agent-sessions) of sessions waiting on you is plain text and appears only while there is something to count.

**Shortcuts.** **⌘⇧J** brings the workbench to the front, as does opening Summon a second time or clicking its Dock icon. **⌘⇧Space** toggles a voice command: the workbench comes forward and recording starts or stops. If another app already holds that shortcut, the workbench says so, and the microphone button and the Voice menu still work. A plain **Fn** tap does exactly what ⌘⇧Space does once Input Monitoring is allowed; the helper, its grant and its limits are described under [Permissions and local voice](#permissions-and-local-voice). Inside the workbench, **⌘K** focuses the command bar and **⌘E** opens Agent sessions.

**The Voice menu** in the application menu bar offers **Voice command**, **Start hands-free listening** (the “Summon” wake word) and **Enroll my voice**. Whichever control started it, listening is off after every launch, sleep or lock.

**Starting agents.** **Start Claude here** and **Start Codex here** in the workbench open a session in Terminal for the selected workspace; see [Starting a session from Summon](#starting-a-session-from-summon).

## Shared context through MCP

The desktop service exposes a user-only Unix socket at `/tmp/summon-<uid>.sock`. `scripts/mcp-server.mjs` adapts it to stdio MCP; it does not create its own competing file watchers. Keep Summon running. Closing its window is fine; quitting it disconnects the service.

From the repository root, register each client you want to use:

```sh
claude mcp add --scope user summon -- node "$PWD/scripts/mcp-server.mjs"
codex mcp add summon -- node "$PWD/scripts/mcp-server.mjs"
```

The installed CLI help for these registration commands was checked on 2026-09-15. These commands change client configuration only when you run them. Restart/reload the client after registration. If it cannot find Node, replace `node` with that installation's absolute executable path. Keep the adapter at a stable path; moving the checkout requires updating the registration.

| MCP tool | Scope |
|---|---|
| `get_working_context` | Selected workspace, available workspaces, observed app/window, collection status |
| `find_files` | Matching file metadata, current known locations, and provenance |
| `recent_activity` | A bounded recent activity/filing history |
| `file_history` | One known file record and its related events |
| `search_memory` | Short sourced excerpts from saved facts and scoped project hubs |
| `remember_fact` | Save a fact only when the user explicitly asks the connected agent to remember it |
| `list_routines` | Read user-saved routine names, triggers and commands; does not execute |
| `set_working_project` | Explicitly select or clear a workspace; no file movement |
| `work_in_flight` | Read-only git status across workspaces: folders and worktrees, unsaved changes grouped into workstreams (from earlier grouping; may be stale), commits not shared, unmerged branches and stashes. With no arguments it returns a compact overview kept under about 36 KB (file counts instead of lists, merged branches counted); past that it lists only project ids and headlines. `includeFiles` needs a `projectId` and returns that project's files, capped to fit |
| `group_work_in_flight` | Regroup unsaved changes with the engine chosen in Summon, only when the user asks. Sends the bounded, privacy-filtered excerpts described in [Work in flight](#work-in-flight); returns a job at once |
| `agent_sessions` | Read-only: which Claude, Codex, Cursor and Hermes sessions need the user, have a new reply, are working or are open, in plain words with app, project and branch. `app` limits it to one app; `includeRecent` adds recently active sessions. Up to 60 sessions in about 48 KB, no full folder paths, titles masked and hidden for private folders (see [Agent sessions](#agent-sessions)). Cannot open, message or control a session |
| `usage` | Read-only: how much of the Claude and Codex subscription windows is used, as each CLI reports about itself (see [Usage](#usage)); the last reading, or a fresh one with `refresh` (no prompt, no turn, no quota spent). Unknown usage is a status, never 0 % |
| `pick_engine` | Read-only: which of Claude or Codex to use for a task, by the fixed rule in [Usage](#usage) (most 5-hour quota left, tie on 7-day, a window at the ceiling is out, else the default); returns engine, reason and the reading it used. Starts nothing |

The MCP service cannot open applications, run routines, move or delete files, or change a repository. Three of its answers carry text you or your tools wrote, rather than metadata about it: the scoped note search described above; `work_in_flight`, which returns read-only git status, commit and stash messages, and model-written workstream titles and summaries; and `agent_sessions`, which returns the titles other AI apps gave your sessions, never their conversations. All three mask emails, tokens and paths to private files first. `group_work_in_flight` is the only tool that can start a provider call; it uses the engine saved in Summon, and **Folders only** turns it off. Requests run as the current local user. Once registered, an AI client can choose to request this metadata under its own permission settings; returned context then participates in that client's conversation. Register it only in clients where that sharing is intended. The application's explicit **Ask** button is a separate route from MCP access.

If a tool says to open Summon, launch the app and retry. A socket-path conflict is reported rather than replacing an unrelated file. A custom adapter socket can be specified with `SUMMON_SOCKET` only when paired with a service configured for the same socket; the packaged app uses the default; development supports the matching `SUMMON_SOCKET` environment variable for isolated tests.

## Build and verification

See the [README](../README.md#run-locally) for installation and run commands. `npm run build` compiles the Swift helper and bundles the renderer; it requires macOS Command Line Tools. `npm run dev` serves the renderer on loopback port 5179 and opens Electron. `npm run package` produces a locally ad-hoc-signed, architecture-specific bundle under `release/`.

`npm run typecheck`, `npm test`, and `node native/check.mjs` cover types, local service/command behavior, and synthetic native-helper checks. The local bundle is ad-hoc signed for development; it is not Developer ID signed or notarized for distribution.

These checks do not establish that microphone permissions, external API credentials, or provider logins work on a particular machine. Test those through the actual app before claiming readiness.
