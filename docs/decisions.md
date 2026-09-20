# Decisions

Dated, with the reasoning that produced them. Overturn deliberately, not by drift.

## 2026-08-18 — Electron over Tauri

**Decision**: Electron shell.

**Why**: Three of this app's load-bearing behaviors are Electron-native and
Tauri-hostile:

1. **The Agent SDK is a Node library.** In Electron it runs in-process in main.
   In Tauri it must be compiled to a standalone sidecar binary (`@yao-pkg/pkg` /
   `bun build --compile`), shipped per-arch, with hand-rolled stdin/stdout or
   localhost IPC — permanent plumbing tax on the core of the app.
2. **Inline artifact rendering** needs consistent, controllable HTML rendering.
   Electron ships Chromium and offers `WebContentsView` for sandboxed inline
   embeds; Tauri renders through WKWebView with a weaker multi-embed story.
3. **Multiple frameless HUD windows** (transparent, always-on-top, click-through
   with hover-forwarding) are well-trodden Electron patterns.

**Cost accepted**: ~200–300MB idle RAM and ~100MB bundle vs Tauri's ~30–40MB /
5–10MB. Acceptable for a single always-running personal app; the M1/16GB
"unusable" measurement in the vault was about *local LLM inference*, not a UI
shell. **Escape hatch**: Tauri port (see opcode / desktop-cc-gui for prior art)
if idle RAM becomes a felt problem — that decision would also mean adopting the
sidecar model, so it is a rewrite of the shell, not a tweak.

## 2026-08-18 — Subscription auth via the user's own Claude Code login; API key as fallback

**Decision**: The engine spawns the official SDK/CLI which reads its own stored
OAuth (macOS Keychain). The app never touches, extracts, or proxies credentials,
and never "offers" login itself — setup instructions say `claude login`.
`ANTHROPIC_API_KEY` is explicitly stripped from the child env unless the user
opts into API mode in settings; the active auth mode is displayed in the UI.

**Why**: Unset key + logged-in CLI = subscription mode: no per-token billing,
Max-plan rate limits as the ceiling. Setting the key silently flips to metered
billing — that must never happen by accident. ToS: Anthropic disallows third
parties *offering claude.ai login* to their end users; running your own tool
under your own login is the same act as running Claude Code. Full analysis and
OSS framing in [open-source.md](open-source.md).

**Watch**: known macOS quirk where Keychain logic can shadow `ANTHROPIC_API_KEY`
(claude-code#25069); auth precedence can change under us — pin SDK versions,
test upgrades.

## 2026-08-18 — One `show_surface` tool + registry, not MCP-UI, not one-tool-per-surface

**Decision**: A single in-process `show_surface(surfaceId, payload, placement)`
tool; surface ids as a `z.enum` allowlist; per-surface Zod schemas validate at
the renderer door. Companion `read_surface_result(panelId)` for surfaces that
produce a result.

**Why in-process over MCP-UI/MCP Apps (SEP-1865)**: MCP Apps standardizes
iframe-sandboxed, server-declared UI — right for *third-party* surface interop,
heavier than needed when we author and trust every surface. The in-process
handler gives native rendering plus an immediate ack to the model in one step.
Track MCP Apps; adopt later if third-party surfaces ever become a goal.

**Why not one-tool-per-surface (Tambo-style)**: cleaner per-surface schemas in
the tool definition itself, but bloats the tool list the model carries and makes
"drop in a surface" require touching tool registration. Mitigation for the
schema-guidance loss: each manifest's description + schema are compiled into the
system-prompt catalog, and payloads are validated at the door anyway. Revisit if
the model misfires payloads often. (The SDK's tool-search deferral would soften
the token cost of per-surface tools if we flip.)

## 2026-08-18 — Voice: local whisper.cpp, tap-to-toggle first

**Decision**: v1 = `globalShortcut` tap-to-toggle + `getUserMedia` + ffmpeg +
`whisper-cli` (small.en). v2 = `uiohook-napi` hold-to-talk + warm
`whisper-server`. No cloud STT, no wake word.

**Why**: Measured ~0.95s warm transcription on this exact machine with software
already installed. On-device matters (vault holds medical/financial data). Cloud
STT (~$0.006/min) adds a key, a bill, and an audio egress for no felt latency
win. Stock Electron cannot do global hold-to-talk (no keyup events,
electron#26301) — hence toggle first, native hook later. Wake word = always-on
mic + Picovoice account + false triggers; skip until hands-free is a real need.

## 2026-08-18 — Permission posture: `allowedTools` + `dontAsk`, not `bypassPermissions`

**Decision**: Enumerate the tool surface explicitly; hard-deny everything else;
never prompt.

**Why**: `bypassPermissions` grants unrestricted Bash/file access and
`allowedTools` does *not* constrain it — wrong default for an app others will
fork. `dontAsk` + explicit allowlist gives a trusted-but-bounded assistant, and
forkers widen it consciously. Workspaces pointed at sensitive dirs (the vault)
inherit protection from the explicit list.

## 2026-08-18 — Surfaces render; tools fetch

**Decision**: Data acquisition (status scraping, vault reads, web checks) lives
in `mcp__data__*` tools; surfaces are pure renderers with schemas.

**Why**: The agent can compose them ("scrape status, then show it"), each side
is independently forkable/testable, and a surface never embeds network access —
which keeps the untrusted-content story clean (fetchers sanitize, renderers
sandbox).

## 2026-08-18 — Working name "summon"

Placeholder; describes the core mechanic (the agent summons surfaces). Known
namespace collision: CyberArk's `summon` (secrets CLI). Naming + trademark
guidance ("X for Claude" is the safe convention; don't brand as "Claude-…") in
[open-source.md](open-source.md). Rename is a find-replace away; do it before
the repo goes public.

## 2026-08-19 — Latency: captured tools over improvised actions

**Decision**: Any command likely to recur gets captured as a named
deterministic tool (or skill); runtime improvisation is the fallback path,
not the norm. Dispatch turns run on a fast model (`setModel()` — e.g. Haiku
for routing), the big model only when a task needs real reasoning.

**Why (measured, this machine)**: "pull up Word on my monitor" improvised
end-to-end by a deep-reasoning model took ~90s: ~800 tokens of runtime
code-authoring (a JXA window-placement script), two model round trips, and
narration prose. Rerunning the already-written script: **6.6s** (0.3s CPU —
the rest was the script's own conservative polling). A pre-built tool turns
the model's output from ~800 tokens of *how* into ~20 tokens of *what*
(`open_in_app({app, display})`). Budget for the same voice command:
~1s whisper + 1–2s to first tool call + ~1s execution ≈ **3–4s perceived**,
plus the app's own launch time. Optimistic HUD on the streamed `tool_use`
start makes the felt response ~1s.

**Capture loop**: when the agent improvises something successfully and it
looks reusable, offer to promote it into a named tool — every improvised
command is a one-time 60–90s tax; every captured one is 3–4s forever.

**Staleness posture — interface stable, implementation disposable**: the tool
ids the model sees stay fixed; tool bodies are small OS-API scripts (`open`,
NSScreen, System Events — years-stable APIs) that the agent itself can
regenerate when one breaks or a better method appears. Failure mode is
self-correcting: stale tool errors → agent falls back to the slow improvised
path → rewrites the tool body (human approves the diff). Capture only
high-frequency commands; prune ones unused for months. Rot degrades to
slowness, never to lost capability.


## 2026-09-15 — Build the local companion around shared activity and file receipts

**Decision:** Ship a scoped desktop companion first: an Electron workbench,
local metadata service, Swift app-context helper, file ledger, direct command
router, and MCP adapter. The earlier SDK surface/session architecture remains
future work; it is not a dependency of this version.

**Why:** The user's new direction centers on finding what just downloaded,
knowing where Automatic Filing put it, and preserving working context across
Claude Code and Codex. Both interfaces need the same observations and history.
A local service supplies them without a language-model call on every event.
The service currently lives inside Electron and remains available while the
menu-bar app is running.

**Scope:** Watch Downloads/Desktop and configured filing destinations/known
directories; import Automatic Filing's journal read-only; never recursively
index project repositories or file contents. Summon does not move files. A
workspace correction changes context, not the file's location. User selection,
filesystem facts, and inferred associations remain distinct. Discovery baselines
do not attribute existing files to the newly selected workspace.

**Routing:** Calendar access, file lookup, workspace selection and requested
benchmark retrieval use direct handlers. Model rankings are source-attributed,
cached for an hour per category, and fetched only on request. No scheduled
rankings polling or background AI interpretation is introduced.

**AI boundary:** Optional Ask Claude/Codex actions invoke the installed CLI in a
temporary directory with restricted, ephemeral answer settings. Claude has no
tools/MCP; Codex uses the implementation's read-only/disabled-action settings.
The user explicitly chooses the provider before the request and a bounded
metadata context are shared. There is no credential extraction or automatic
API-key forwarding, no implicit API billing fallback, and no claim that the
user's provider login has been validated. MCP access is separately configured
by the user and follows the receiving client's permissions.

**Observation and voice:** Basic app changes are independent of Accessibility.
Window title/document-path collection is opt-in and permission-gated. Voice is
separately enabled and starts off on every launch. Hands-free uses local Whisper
phrase detection, not a dedicated low-power wake-word model; it keeps the
microphone on and can use more processing. No screen recording, keystroke
capture, or browser-history monitoring is part of this implementation.

Operational details and limits belong in [desktop-companion.md](desktop-companion.md).


## 2026-09-16 — Local wake gate, explicit memory and reviewed interpretation

**Decision:** Keep deterministic commands and local Whisper; add a small dedicated offline keyword detector before hands-free transcription, an optional local text interpreter, explicit durable facts, bounded sourced project-note search, and user-saved command routines. This supersedes the earlier phrase-transcription-only hands-free implementation. The user explicitly requested this iteration after discussing open-source voice/reasoning and Hermes Agent.

**Boundary:** Wake loading does not record. Microphone use stays opt-in per session. Ordinary ambient segments stay in the keyword worker; only explicit commands or confirmed wake phrases reach local Whisper. No screen recording, Input Monitoring or continuous model reasoning is introduced.

**Knowledge:** A configured Second Brain workspace authorizes Home and project-hub retrieval. This deliberately expands v0.1 metadata-only context to short sourced note excerpts. It excludes private profile/area notes and imported conversations. Explicit CLI Ask actions disclose and may share up to five matching excerpts/facts; MCP clients can request scoped search and save facts only on explicit user instruction. All retrieved text remains untrusted context. No autonomous memory consolidation or self-written executable skills.

**Routines:** Borrow the Hermes separation of durable memory, searchable history and reusable skills as an architectural pattern; do not install Hermes Agent or couple Summon to its agent loop. A completed direct command can be saved by the user under a phrase. Main owns success receipts and revalidates actions; model output has no execution callback. Existing CLI restrictions and authentication ownership remain intact.

**Local model:** Reuse an installed small Ollama text model. Fixed loopback requests, bounded schema/context, explicit Run confirmation, measured latency and visible failure. No automatic model download, cloud fallback, or LLM call on every activity event. A slow model cannot delay the direct-command route.

Sources: [Hermes memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory), [Hermes skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills), [Hermes source](https://github.com/NousResearch/hermes-agent). Implementation and runtime setup are documented in [desktop-companion.md](desktop-companion.md).


## 2026-09-16 — Desktop voice control and selected local model

The user requested a desktop button to enable ongoing voice listening and accepted the Liquid model recommendation. Add a small movable control visible across workspaces. Capture has one owner in the existing workbench renderer; the widget gets only voice status, toggle, show-workbench, and hide operations. It cannot read files, invoke commands or providers, or request microphone access itself. Main-frame identity checks remain separate for each renderer.

The default is per-session listening for “Summon,” with microphone activity visible; launching the app does not reopen the microphone. Hide, stop, sleep and screen lock stop capture. Captured requests become visible for review in the workbench. Existing Ask Claude/Codex actions remain explicit and keep the restricted CLI execution/auth boundaries.

Use the official LiquidAI LFM2.5-1.2B-Instruct QAD Q4_0 artifact for optional local command interpretation, registered as summon-local:latest. Keep finite schemas, grounding checks, review before execution, and bounded context/output/timeouts. Ordinary commands and speech capture do not invoke this model automatically. Download/model verification and measured results live in routing-research.md; the app never downloads weights at launch.


## 2026-09-16 — Repair command transcription latency

After the user reported a long wait specifically in “Transcribing,” replace per-phrase ffmpeg/whisper-cli launches with one owned native stdio worker. Prepare the selected model when listening starts, retain it for that session, and release after 60 seconds off once pending work settles. Keep audio in memory and preserve the original Whisper beam-search settings; the faster greedy variant failed the reported phrase and was rejected. Startup is bounded to 20 seconds and decoding to 15 seconds, with explicit failure instead of a hidden CPU retry. This changes voice mechanics, not OS action or provider authority. Popup dismissal remains unsupported.

Set capture to 48 kHz, use a bounded adaptive amplitude gate with a 0.8-second pause, and expose hearing/pause/transcription phases. Render recognized words before command lookup finishes. Test the actual Electron flow using synthetic speech, keeping the physical microphone off. Measurements and the sampled cold Metal shader-compilation stall remain in routing-research.md. Prepare the final signed helper’s GPU cache as part of local installation and verify a second start; this does not promise a permanently warm cache after future updates or eviction. Avoid downloading a Metal toolchain or rebuilding the entire ggml backend for this local repair.


## 2026-09-16 — Adopt a maintained Hermes fork for agent execution

The user explicitly asked to download/fork Hermes and wire in the existing fixes after discovering that a transcribed popup-dismissal request had no executor. This supersedes the earlier decision to borrow Hermes patterns without installing it. Use a maintained Hermes fork (a local checkout outside this repository) as the action-capable desktop assistant, keeping this Summon app as the scoped file/context service exposed over MCP. The restricted Ask buttons in this app are unchanged; they are not the new action interface.

Hermes invokes the official Codex CLI app-server, with vendor-owned login, per-session model/context/tool configuration, standard approvals and a bounded workspace. Do not import OAuth tokens or implicitly forward provider API keys. The live Hermes computer-use and memory tools stay attached to their owning session and approval UI. Claude remains a separately authenticated CLI, not a shared conversation or implicit fallback. General actions use the new Hermes interface; preserve this app for ledger/context access.

Reuse the existing Whisper worker/model and wake assets; preserve original PCM audio, prepare before listening, reuse the worker, and expose preparation honestly. Listening starts off; the existing observation pause stays paused. Cua Driver handles on-demand computer control only after its macOS permissions are granted. This does not authorize continuous screen recording or keyboard monitoring.

Keep local settings/history/credentials outside Git. The public fork tracks official upstream separately, pins its base, and refuses normal in-place self-updates; community changes are reviewed and tested in a separate worktree before installation. The integration router, setup and actual validation records live in the fork's `integrations/summon/`; do not duplicate implementation details here.

## 2026-09-16 — Single assistant entry from the menu bar

The user requested one assistant control and settled on the macOS menu bar,
superseding the proposed desktop button and floating overlay. An opt-in local
setting makes Summon's menu-bar icon open the installed Hermes assistant on an
explicit click. Right-click retains access to working context. Summon starts
without showing its workbench or desktop voice widget, and leaves microphone
and wake capture to the Hermes interface. Observation settings, MCP scope,
provider authentication, and action approvals are unchanged. No login item is
installed. See `docs/desktop-companion.md` for the setting and behavior.

## 2026-09-16 — Background listening from the Summon menu

The user requested Start listening from the menu bar without showing a window,
with **Hermes** as the spoken wake word and **Summon** retained as the menu name.
Hermes now owns that opt-in native menu and retains its primary renderer while
the chat is hidden. Summon's companion tray is suppressed by a private
`menuOwner: "hermes"` setting; its context service and observation pause stay
independent. Opening working context is still an explicit menu action.

Start is a session-only microphone action: it does not persist the wake-enabled
flag. Stop cancels capture and speech; sleep, lock, disconnect and quit release
listening. Startup and wake do not reveal the chat or floating voice indicator.
Only the trusted primary renderer can acknowledge menu commands, and native
state reflects its readiness and capture reports. Existing authentication,
tool permissions and approval requirements are unchanged. No login item is
installed. Setup and limitations live in `docs/desktop-companion.md` and the
maintained Hermes integration documentation.

## 2026-09-16 — Fn starts the menu-bar listener

The user explicitly requested the laptop Fn key as an additional Start listening
control. Add a separately enabled local native helper under Hermes's existing
menu-bar opt-in. It uses a passive macOS event tap gated by Input Monitoring;
only an isolated Fn release can signal Start. Existing listening is not toggled
or restarted, Fn combinations remain available, and sleep/lock disable the
shortcut until the system resumes or unlocks. A helper never starts speech or
opens a window directly; the existing menu controller remains the owner.

This is a narrow exception to the earlier no-keyboard-monitoring scope: event
categories are inspected transiently to reject chords, without decoding or
retaining typed characters or exposing raw keyboard events to Hermes. No agent
tool authority, provider authentication or observation setting is changed. The
user's macOS Fn action is changed from Emoji & Symbols to Do Nothing to avoid
the system popup. Permission is handled through macOS's normal settings.

## 2026-09-16 — Fn toggles menu-bar listening

The user requested Fn as a Stop control too, superseding the start-only behavior
above. A plain Fn tap starts listening when off and requests the existing Stop
action when listening or starting. Stop releases wake and conversation capture
and stops spoken playback; taps during stopping are ignored until cleanup finishes.
The existing menu controller owns the transition and keeps the chat hidden.

The native helper, Input Monitoring permission, chord rejection and sleep/lock
behavior are unchanged. This changes only the action assigned to an authorized
Fn tap; it adds no keyboard data, provider access or agent tool authority.

## 2026-09-16 — Fn enables direct voice conversation

After a continuous “Hermes pull up Codex” command lost its leading words during
the wake-to-recorder transition, the user requested readiness immediately after
toggling Fn, without a spoken wake phrase. Fn and Start listening now start the
existing voice conversation directly. Readiness is acknowledged after actual
microphone capture starts; Fn/Stop cancels preparation, capture and playback.
Silence keeps a bounded audio buffer and an open capture stream, avoiding idle
recorder restarts. Launch, lock, sleep and disconnect still leave listening off.

During that explicitly enabled conversation, recognized speech is submitted to
the configured agent; the keyword detector is not armed. Upgrade local speech
recognition to a verified Whisper Large v3 Turbo Q5_0 model after synthetic tests,
retaining previous weights and a private configuration backup. No cloud audio
service or provider credential is added. Codex-native command approvals must use
Hermes's existing per-session review queue, with missing/denied approvals failing
closed; this repairs review delivery without widening tool authority.

## 2026-09-17 — Work in flight (read-only git status and grouped workstreams)

The user asked for one plain-language view of unfinished work across the git
repositories he works in, because he does not read diffs. Add Work in flight: a
workbench panel, `npm run flight`, and two MCP tools. For each repository it
shows the main folder and worktrees, unsaved changes grouped by intent into
workstreams, commits not shared, unmerged branches with a one-line summary, and
stashes.

**Scope:** Read-only git over registered workspaces plus explicit `extraRoots`
from its own settings file. A root must contain a `.git` directory; worktrees
come from `git worktree list`. Paths under `excludedRoots` or with a sealed-project
segment are never opened. Every git call goes through `gitArgs()` with
`GIT_ENV`: `--no-optional-locks`, `core.fsmonitor=false`,
`core.hooksPath=/dev/null`, an empty `diff.external`, `core.quotePath=false`,
color and signature display off, `--no-ext-diff --no-textconv` on diffs, and
`GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`, `GIT_NO_LAZY_FETCH=1`,
`GIT_PAGER=cat`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_LITERAL_PATHSPECS=1`,
`GIT_NO_REPLACE_OBJECTS=1`, `LC_ALL=C`. Comparing a worktree with the main
folder uses `hash-object --no-filters` without `-w`. Summon never fetches,
pulls, pushes, runs gc or maintenance, stages (including `add -N`), creates or
applies stashes, checks out, switches, resets, updates the index, runs
`status --ignored`, or runs any other writing command. "Newer on GitHub" counts
are as of the last fetch made by something else, and the date is shown. Tests
create repositories only inside temporary fixtures and check that the index is
unchanged after a scan.

This supersedes the 2026-09-15 rule to "never recursively index project
repositories or file contents" only for the git metadata and diff reads
described here. The file ledger still does not crawl repositories. Excerpts are
built in memory for one grouping request and are never stored.

**AI boundary:** Grouping may now send diff-derived excerpts to the CLI provider
the user chose in Summon: file names, change counts, recent commit subjects,
branch names, up to 8 changed lines per non-private text file (160 characters
each, 48 KB per request), and the first lines of up to 20 new non-private text
files. Private, secret, data, generated and binary files never send contents.
Private files are not named either; they are counted under their private
folder. Privacy uses a default list of folder names plus per-repository
`privatePaths`. Emails, phone numbers, credential URLs, long tokens and known
key formats are masked before sending, and a path to a private file quoted
inside a changed line or commit subject becomes `[private path]`. A new
folder may list up to 8 of its non-private file names so moves can be paired. The panel shows what will be sent before
any grouping, and the MCP tool description repeats it. Repository text is
marked as data, not instructions. The model's answer must match a strict schema
and is validated, trimmed and rendered as plain text.

The restricted CLI boundary is otherwise unchanged: a temporary working
directory, the scrubbed environment, Codex through `restrictedCodexArgs()` in a
read-only sandbox plus `--output-schema`, and Claude with no tools, no MCP
servers, `dontAsk`, one turn and `--json-schema`. Reasoning is stronger than the
Ask defaults: effort `medium` (low, medium or high selectable) and, for Claude,
`opus` by default (sonnet or haiku selectable). Codex is the default engine
because Claude's headless login was expired on this date. "Folders only"
(`off`) groups by folder on the Mac with no provider call. No API keys; the
CLIs own login.

This widens the 2026-09-15 "bounded metadata context" and the 2026-09-16 note
excerpt rule. Code and notes outside private folders can still contain startup
strategy or customer details; the controls are `privatePaths` and Folders only.

**Triggers:** A provider call happens only when the user clicks **Group
changes**, opens the panel with **Group on open** turned on (the default) while a
grouping is out of date, runs `npm run flight -- --group`, or asks a connected
agent, which then calls `group_work_in_flight`. The panel-open and agent routes
work only after the user has clicked **Group changes** once (see the addendum). There are no timers, file
watchers or background AI. One job runs at a time. A folder whose change
fingerprint matches its last grouping is skipped unless forced, and a folder
with a single change is grouped without a model.

**MCP:** `work_in_flight` is read-only. It returns the deterministic scan plus
cached groupings with stale flags, without file lists by default. Because its
answer reaches the agent's provider, private file names are left out of every
list it returns (only counted), and private paths quoted in commit subjects and
stash messages become `[private path]`; the local panel and CLI still show them.
`group_work_in_flight` starts a provider call with the user's saved engine and
returns a job immediately. The saved setting stands in for the per-request
provider choice required on 2026-09-15; this wider rule is accepted here. The
tool description limits use to explicit user requests, an agent's call follows
that client's own tool permissions, and Folders only turns it off. Neither tool
changes a repository, and neither name matches run, execute or shell. The
socket allows 20 seconds for these two methods (others keep 10), and the MCP
adapter waits 18 seconds.

**Storage:** `work-in-flight.json` in the data directory (mode 0600, atomic
writes, 2 MiB cap, unreadable files quarantined) holds settings, groupings per
folder with their change fingerprint, and branch summaries with the branch tip
they describe. It holds no diff text.

**Limits:** 8 seconds and 8 MB per git call; a 12-second scan deadline with four
repositories at a time and a 20-second cache; 400 changed paths checked per
folder; 2,000 names per new folder; 25 unmerged branches with details; 20
stashes; 250 prompt items before the rest are rolled up by folder; 400 KB per
prompt; model calls of up to 5 minutes and 4 MB, two at a time; 20 extra and 20
excluded roots; 40 private prefixes per repository. Operational details live in
[desktop-companion.md](desktop-companion.md#work-in-flight).

### 2026-09-17 addendum — Work in flight review fixes

A security, privacy and UX review of the first build found gaps; these rules now
apply on top of the entry above.

- **Consent before any automatic send.** The first provider call always comes from
  a click on **Group changes**, which records `consentedAt` in the settings file
  before anything is sent. Until then, opening the panel with Group on open and
  agent calls through `group_work_in_flight` are refused; the terminal
  `--group` is an explicit request, prints the disclosure first, and does not
  count as that consent. The disclosure now names everything that is sent
  (folder and branch names, commit messages, file types and counts for private
  folders) and says when Group on open or agents can send.
- **Fail closed on settings.** An unreadable `work-in-flight.json` is kept as
  `.corrupt-*`; valid settings and known private folders are kept and grouping is
  turned off (and saved off) until the user picks an engine again. Private-folder
  keys are canonical (trailing slash and symlinks resolved), and keys that are not
  folders are reported.
- **Scanner guards.** Linked worktrees are checked by their real folder, their
  `.git` file and `rev-parse` before any read; a `.git` folder with `commondir` is
  refused. Filter names are looked up in every folder before any folder is read,
  and a failed lookup stops that read. Submodules are compared with
  `--ignore-submodules=dirty`.
- **Prompt privacy.** Prefixed and camelCase secret assignments, `*.env` and
  similar secret files, files renamed out of private folders, `../` and
  space-containing private paths, private-looking folder names and branch names are
  withheld or masked. Excerpts are read at twice the shown width and a partial
  value at the cut is dropped before masking.
- **Agent answers.** `work_in_flight` returns a compact overview under about 36 KB
  (client tool-output limits), requires `projectId` for file lists, and masks
  private paths in commit subjects and stash messages. Socket clients accept only a
  socket owned by the current user and stop at an overall deadline.
- **Status words.** A folder that could not be read makes the project need a look
  instead of reading "All caught up"; a branch checked out in an existing folder is
  never "done, safe to clean up"; a worktree whose changes are a byte-identical
  subset of the main folder's is shown as a mirror. **Show in Finder** reveals a
  folder and never opens it through LaunchServices.

## 2026-09-17 — Agent sessions

The user asked for one calm view of the AI agent sessions he runs at the same
time in Claude (desktop Code sessions and terminal `claude`), Codex (the
ChatGPT/Codex app and the `codex` CLI), Cursor and Hermes: what needs him, what
has a new reply and what is still working, with each row opening the exact
session. Add Agent sessions: a workbench panel (⌘E), a count on its Quick access
button, "Claude working here" chips on Work in flight folders, `npm run
sessions`, and the read-only MCP tool `agent_sessions`.

**Scope:** Read-only metadata from these stores only. Claude: live session
records (`~/.claude/sessions/<pid>.json`), desktop session files, the archive
index and `git-worktrees.json` under `~/Library/Application Support/Claude/`,
the app's localStorage key `epitaxy-unread-v1`, and the last 64 KB of terminal
transcripts under `~/.claude/projects/` (96 KB since the Where this stands
entry at the end of this file, which reads the file paths on those transcripts'
file-history lines and nothing else new). Codex: `~/.codex/state_<n>.sqlite`,
`session_index.jsonl`, the unread and pinned keys of
`.codex-global-state.json`, `external_agent_session_imports.json`,
`thread-writer-locks/`, rollout tails and worktree owner files. Cursor: the
global `state.vscdb` (`composerHeaders`, single fields of `cursorDiskKV` rows
picked with `json_extract`, and `worktree.metadata`). Hermes:
`~/.hermes/state.db` and `runtime/active_sessions.json`. Summon never writes,
renames, deletes, locks or opens in place any file of those apps. A SQLite
database is cloned with `/bin/cp -c`, together with its `-wal` and `-shm`, into
a fresh 0700 temporary folder; only the clone is opened, only read-only
`SELECT`/`WITH` queries run, and the folder is removed after every read. If cloning fails, a database
up to 64 MB may be copied instead; Cursor's is never fully copied. Claude's
LevelDB is read from its `.log` and `.ldb` files without taking `LOCK`.
Processes come from one `ps -axo pid=,ppid=,lstart=,comm=`: process id, parent,
start time and program path, never arguments, because `claude -p "<prompt>"`
carries a prompt. Claude's live records and Hermes's open-chat entries count
only while their process id and start time both still match. Summon never connects to those apps'
sockets (`/tmp/cc-socks/*`, `~/.codex/ipc/ipc.sock`) or Hermes's local HTTP
server, never runs their CLIs, and never reads `~/.claude/sessions/*.key`,
Claude's `config.json`, `~/.codex/auth.json` or any token file.

**No conversation content:** Summon never reads or keeps message text, prompts,
tool output, previews or drafts. That includes `first_user_message` and Codex's
`title` and `preview` columns, Codex `prompt-history`,
`composer-prompt-drafts-v2` and `thread-descriptions-v1`, Claude `last-prompt`,
Cursor `text`, `richText`, `conversation*` and `subtitle`, and Hermes
`messages`, `system_prompt` and `last_activity_description`. Titles are the
only free text shown (a name the user or the app set, never a prompt). They are
untrusted data, stripped of control characters and cut at 120 characters.

**No AI, no network, no read on a schedule of its own:** Reading needs no model
and no network request. A read happens when a visible view polls, when the
terminal command runs, or when a connected agent calls `agent_sessions`. The
window's timers are every 4 seconds while the panel is open, every 20 seconds for the Quick
access count while the workbench is visible, and every 10 seconds for the Work
in flight chips while that panel is open. These timers run in the window.
The window keeps its timers running while hidden (background throttling is
off), so while it is hidden main answers them from the last read instead of
reading again; the main process kept no timers or file watchers for this, until the
menu-bar count added later the same day (see the entry at the end of this file), which is
the one read on a schedule of its own. Requests from the terminal view or a connected agent are served by reading, with or without a window. This is an explicit exception to the earlier "no timers" rule (Work in
flight), limited to reading local metadata with no provider call. One read has
4 seconds across the four apps, and a read less than 3 seconds old is reused
unless Work in flight has found different folders since.

**Opening sessions:** Only an explicit click or Enter in the panel opens a
session, through the trusted window's IPC. The window sends only a session key
from the last read; main builds the target from allowlisted templates after a
strict id check: `claude://claude.ai/epitaxy/local_<id>`,
`codex://threads/<uuid>`, `cursor://anysphere.cursor-deeplink/agent?id=<uuid
or bc-uuid>` and `hermes://open/<YYYYMMDD_HHMMSS_hex>`. Before
`shell.openExternal`, the app registered for that link must be the expected one
(Claude, ChatGPT or Codex, Cursor, Hermes); otherwise nothing opens. A running
terminal `claude` cannot be focused, so its folder is selected in Finder; a
finished one offers to copy `cd <folder> && claude --resume <uuid>` to the
clipboard, which Summon never runs. Claude's `resume` link is not used, because
it imports a terminal session into the desktop app. Nothing opens from RPC, MCP
or the terminal view.

**MCP:** `agent_sessions` is read-only (`readOnlyHint`) and cannot open,
message or control a session. It returns groups, plain state words, app,
project, place label and branch for up to 60 sessions in about 48 KB, with no
full folder paths, and leaves out recently active sessions unless asked or
nothing else is listed. Titles pass through `redact` and `hidePrivateText` from
`src/core/workstreams.mjs` with the project's `privatePaths`, and a session in
a private folder shows "Title hidden (private folder)". Titles and states still
reach the agent's provider: this widens the 2026-09-15 bounded metadata context
rule (and the Work in flight widening above) to agent session titles and
states. `npm run sessions` uses the same socket method and gets the same view
(always with the recent group, which it shows only with `--recent`);
its `--direct` mode reads in its own process without Summon and without
matching folders to projects.

**Storage:** `agent-sessions.json` in the data directory (mode 0600, atomic
writes, 256 KiB cap; an unreadable file is kept as `.corrupt-*` and its valid
settings are kept) holds settings only: `recentHours` (1 to 168, default 24),
`newReplyHours` (1 to 720, default 72: an unread mark older than this keeps its
dot but is listed under the recently active group rather than New replies,
because the apps never clear their own unread marks),
`showQuiet`, `showBackground`, `trayCount` (the menu-bar count, see the entry at
the end of this file) and up to 50 `pathAliases` for moved folders. It
holds no titles, ids or states. Summon keeps no unread marks of its own.

**Limits accepted:** Hermes and Codex keep approval waits in memory only, so
Hermes never shows "needs you", and Codex shows only "Probably waiting for your
OK", inferred when a turn reviewed by the user has an unanswered tool call and
its log has been unchanged for 30 seconds. Cursor has no process per agent, so
"working" shows only while Cursor runs, and runs left unfinished show as
interrupted once it closes. Terminal Claude sessions cannot be focused and have
no unread mark; older `claude` versions without a status get an inferred state
from the transcript tail. If Claude's localStorage cannot be read, no Claude
session shows a new reply and a warning says so; unread is never guessed from
focus times. Up to 300 sessions per app. Claude sessions imported by Codex
(unless continued there) or Cursor are skipped so nothing is listed twice.

**Sealed folders:** A session whose working folder, or the real folder behind it, has
a sealed-project segment is dropped entirely, not masked. Moved-folder aliases
cannot point into one.

Operational details live in
[desktop-companion.md](desktop-companion.md#agent-sessions).

## 2026-09-17 — A menu-bar count, and the first background read in Summon

**Decision**: A status item in the menu bar shows `◐ N` while N agent sessions
need you, `◉` while something is working and nothing needs you, and nothing at
all when it is quiet. A timer in the main process refreshes it: every 60
seconds normally, every 20 seconds while the item is showing something, paused
while the machine sleeps and while Summon is quitting. `trayCount` in
`agent-sessions.json` turns it off (`off`), or widens it to background runs the
panel hides (`working`); the default is `needs`.

**Why**: The titles the apps write are ambiguous ("Excel recorder" and "Signal
framing in Excel files" are the same project and say nothing), so the answer to
"who is waiting on me" was a board you had to open and read. A count is the
smallest thing that answers it without a board: one glance, no window, no
reading. The rows behind the right-click are named by app and project rather
than by title alone for the same reason.

**Why this breaks the earlier "no timers in main" rule**: Work in flight and
Agent sessions both promised that main runs no timer of its own and that the
app reads nothing while you are not looking. A menu-bar count cannot keep that
promise, so this is a deliberate, bounded exception rather than drift:

- It reads the same local metadata the panel reads and nothing else: ids,
  titles, folders, times, states and unread marks from files on this Mac,
  through the same read-only path (database clones opened read-only, no locks
  taken, no conversation text). No model, no network, no writes.
- It is one `read({maxAgeMs: 0})` per tick, the same call the open panel makes
  three times as often, and it shares the pass a panel read has already
  started. One read is bounded at 4 seconds across all four apps, and each app
  skips files that have not changed.
- It is off in three situations without any further check: the setting is
  `off`, the machine is asleep (`powerMonitor` suspend and resume), or Summon is
  quitting. A failed read is silent and backs off to the slow poll, so a broken
  app store cannot turn the count into a stream of errors or log noise.

**What it counts**: the Needs you group only, plus a plain "something is
working" state. New replies are deliberately left out: the apps never clear
their own unread marks, so counting them would light the menu bar up and keep
it lit, which is the failure mode this feature exists to avoid. Background runs
(`codex exec` and friends) are counted only under `trayCount: "working"`, which
matches `showBackground` for the panel.

**Why plain text and not an icon**: Summon already had a menu-bar star, and
Hermes owns that star now. A second star was confusing the last time there were
two, so the count is text in the menu bar's own colour, which also reads on both
light and dark menu bars and cannot be mistaken for the assistant's entry. The
count appears whether or not Hermes owns the star.

**Opening from the menu bar**: the right-click rows open a session through the
same internal function the window's IPC handler calls, so the id check, the
allowlisted link templates and the "is the expected app installed" check are
one path, not two. The menu never holds a link, only a session key from the
last read. Left click reveals the workbench and sends `summon:open-panel` with
`agent-sessions`; the window decides what to show.

## 2026-09-17 — Where this stands: a watermark, what moved, and sessions that say where they are

The user asked what is progressing and what it is moving towards. Work in
flight answers "what is unfinished" and Agent sessions answers "what is
running"; neither answers "what changed since I last looked", and the apps'
machine-written session titles ("Excel file review") do not tell two pieces of
work apart. Add three deterministic things: a paragraph at the top of Work in
flight counted against a watermark the user sets by looking, a short "Not
moving" rail under it, and session rows that lead with the project and the
piece of work being touched, with the app's own title kept underneath in
quotes.

Nothing here calls a model, opens a network connection, adds a panel, adds a
shortcut, or adds a timer to the main process. Every line is subtraction
between two scans the app already makes.

**The watermark is set by looking, not by opening.** A repository's mark
advances only when its section has been expanded and on screen for at least
three seconds, or when the user clicks **Mark as read**. Opening the panel
advances nothing. This is the whole difference between a feature and a blank
line: a mark that moves on open makes the paragraph permanently empty and
nobody notices it is broken. The dwell is a window timer next to the existing
panel polls, not a new one in main.

**One new git read.** For a place whose fingerprint changed since the mark,
and only for such a place, one
`log --left-right --format=%m<unit>%H<unit>%s <seen oid>...<current oid>`
through `gitArgs()`/`GIT_ENV`, capped at five subjects plus a count. It stays
off the global scan path, so a scan of thirteen repositories does not pay for
it. It is the symmetric difference rather than the plain range because a rebase
or an amend leaves the recorded commit in the object database, so git does not
error and `a..b` quietly becomes "the whole new base plus rewritten copies of
work he has already seen". A record on the left side is a watermark the current
tip cannot reach, which is history that moved under him: the answer is then
"history was rewritten here" and nothing is counted. A full page could hide the
left side, so a capped read is trusted only once `merge-base --is-ancestor`
confirms the watermark is still an ancestor; a guard that cannot answer throws
rather than guesses. A recorded commit git no longer has at all reads the same
way. The project's total counts distinct commits, because a worktree and the
folder it merges into hold the same ones and "6 saves landed" for three commits
is simply false; each folder's own bullet still counts its own range.
Read-only stays absolute: no new command that writes, no new flag, no write.

**Commit subjects are a new text channel.** They are repository text, so they
pass through `redact` and `hidePrivateText` from `src/core/workstreams.mjs`
with that project's `privatePaths`, exactly as diff excerpts do, before they
are shown, recorded or returned, and they are cut at 80 characters. A subject
that still names a private path after masking is dropped whole rather than
shown with a hole in it, and the count of what landed carries the fact by
itself. Elsewhere `work_in_flight` turns such a path into `[private path]` in
commit subjects and stash messages; here the stricter rule applies because
these subjects are also written to disk. Subjects are untrusted data rendered
as text. A stored record carries the id of the filter that made it, and a
record whose filter is no longer current is recomputed rather than replayed, so
adding a private folder takes effect at once on text already on disk and a
later fix to `redact`/`hidePrivateText` reaches records already written. A
record that is not usable right now is dropped rather than kept, so the ledger
stops carrying repository text it will never show. The trade is that a log read
that merely times out drops the count for one scan instead of showing the last
one; fail closed is the right side of that for a privacy filter, and nothing
caches a null, so the next scan recomputes.

**Transcript metadata lines are a new source, paths only.** A session's own
edits are what locate it, so the Claude reader now also takes the tail of
`~/.claude/projects/<slug>/<session>.jsonl` (96 KB, and on later passes only
the bytes that arrived since, by remembered offset and size) and keeps the file
paths named on `file-history-snapshot` and `file-history-delta` records, plus
the session's `cwd`. Nothing else on those lines is parsed: no message text, no
prompt, no tool output, no title beyond the one already read. **The backup
files those records point at, under `~/.claude/file-history/`, hold the
contents of the user's files and are never opened.** Codex contributes the
paths of `item_completed` items of type `FileChange` from the rollout tail it
already reads. Cursor has nothing cheap to read, so it stays empty rather than
guessed. At most 200 paths per session, newest kept. A path that
`classifyPath()` calls private or secret is dropped, and a session whose folder
is private contributes no paths at all.

**Sessions are re-addressed, not renamed.** Summon does not own those titles
and nearly all of them are machine written, so renaming them is not the fix.
The row leads with the project and the workstream the session's touched paths
match, or with the project and its folder when nothing matches, and the app's
own title sits under it in quotes, marked when you named it yourself. Only
Claude reports a title's source, so "the app wrote this" is a claim Summon
cannot make about a Codex, Cursor or Hermes row; the wording says the title
belongs to that session's app, which is all any reader tells it. A name in
front that would only repeat the project, which is every main-folder session
with no matched piece of work, is no address at all, so those rows keep the
app's own title in the lead and get the project chip back underneath.
Matching is a file overlap between the session's paths and a workstream's
files, never a reading of what the session said.

**Storage.** A new `standing.json` in the data directory, not a new key in
`work-in-flight.json`, whose `validState()` whitelist silently drops keys it
does not know. Same discipline as its neighbour: mode 0600, atomic write with
the file and the directory flushed, an unreadable file kept as `.corrupt-*`,
and a hard cap of 512 KB with the oldest samples dropped before any
repository's mark. It holds scan metrics and hashes: per place a ring of at
most 12 samples (fingerprint, commit, counts, ahead and behind, conflicts,
stream signatures), the mark itself, branch tips, and when each stream was
first seen. It also holds up to five commit subjects per place, filtered as
above, which makes it the first state file of Summon's that keeps any
repository text. It holds no diff text and no session content.

The file is written compactly: indentation nobody reads was over half of the
old 128 KB budget, and the sample ring paid for it one dropped sample at a
time. Three of the four "Not moving" rules need two or three samples of
history, so a trimmed ring quietly turned the rail into one kind of row and
looked exactly like a quiet week.

**A guess is marked and a claim about now is withdrawn.** Anything inferred
carries the folder it was read from and goes the moment the scan says that
folder moved. Two things follow that the first pass missed. The paragraph is
plain text with nowhere to put a marker, so it closes on something counted,
never on the spinning or rot guess above it; and a counted line written in the
present tense, such as "no file here has changed in eight days", is a claim
about now rather than about a moment that happened, so it is withdrawn too when
this scan positively contradicts it. A folder merely missing from a scan never
withdraws a count. The paragraph itself is held for the life of one look so
that marking a project as read does not rewrite the sentence being read, but a
paragraph that has grown replaces it, since marking only ever shrinks these
counts and work landing while the panel sits open is already visible in the
rows underneath.

**Stream identity is the one real algorithm.** Workstream ids and titles are
rewritten by every grouping, so a stream is identified by the hash of its
sorted file list and matched to the previous sample greedily, one to one, by a
Jaccard overlap of at least 0.5. Without that, a regroup reads as "everything
is new and everything old is gone", which looks exactly like a broken ledger.
A synthetic regroup is in the tests for that reason.

**Two states, not four bands.** Work is moving or it is not moving, plus
"waiting on a save", which is read straight from readiness, a suggested commit,
no conflicts and an unchanged fingerprint. Hills, stations and progress bands
were considered and cut: they would be guessed from about a dozen irregular
samples, and one discovered lie costs more than they are worth.

**Inference discipline.** Anything inferred says so in the existing
`reported` and `inferred` vocabulary, carries the place and the fingerprint it
was computed from, and disappears the moment that fingerprint changes, or the
moment that folder is gone from the scan. No percentages and no confidence
numbers, and no claim wider than its evidence: the spinning line says that an
agent is in the folder now and that no file has changed for a stretch, because
how long that agent has been at it is not something this ledger can see. That
stretch is said in minutes, then hours, then days, since a folder can sit
untouched for weeks and "12960 minutes" is not a length anybody reads. Movement is judged by fingerprint and
never by modification time, because iCloud and Time Machine touch files without
anyone editing them.

**Limits.** 40 repositories and 20 places in the ledger, 12 samples per place,
10 streams per place, 5 commit subjects of 80 characters out of a count that
stops at 50 and then says there were more, 400 first-seen
entries, 25 branch tips, 5 rows in the "Not moving" rail, and at most 4 bullets
in a project's own block before the rest are counted. Not moving means no
fingerprint change for 7 days; spinning means the same fingerprint across three
samples while an agent is working in that folder; blocked means conflicts
across two samples; rot means falling further behind the main line while
nothing new is saved and the last commit is older than 14 days.

**A session can be matched by the files it backed up, not only by the ones it
named.** The paths above come from the transcript's own file-history metadata
lines, and most sessions do not carry one in the tail that gets read: measured
on this Mac, 2 of 13 live rows could name the piece of work they were on. There
is a second, cheaper source next to it. Claude keeps one folder of backups per
session at `~/.claude/file-history/<session id>` and names every entry after the
file it holds, as the first 16 hex characters of sha256 of that file's absolute
path, then `@v` and a version. Checked on 2026-09-17 against a live session, 3
of 3 known files hashed to an entry that was there. So the reader lists that
folder by name only and keeps the hashes, how many distinct files there are, and
the newest entry's time, and the aggregator hashes the file lists Work in flight
already holds and looks for them among that session's entries. The hashes that
travel are the entries of that session's most recent stretch of work, six hours
back from its own newest entry: a session open for days backed up whatever it
touched on its first day, and those entries would otherwise outvote the ones
from the last hour. The window runs back from the folder rather than from the
clock, so an idle session keeps its answer, and the count and the time stay the
whole folder, which is what "touched 12 files in all" says. The question only
ever runs one way: a path we already have is hashed and compared. No path is
discovered, nothing is reversed, and the backup files themselves, which hold the
contents of your files, are still never opened. A symlink wearing an entry's
name is listed and left alone. An unchanged folder costs one stat, which is
about half a millisecond for the whole Mac on a warm read.

**The hashed match is the second source and says it is inferred.** Paths a
session named itself are exact and win. The hashed names answer for the rest,
and they answer conservatively: at least two files in common that are a
twentieth of what the session has written, or a single file that is a third of
both sides, and a clear win over the runner-up. The floor on the session's own
side is what keeps a version bump and a memory note, which one piece of work
happens to own, from naming work the session is not on, and a piece of work too
big for one file to stand for is still counted as the runner-up, so a single
shared file cannot hand the session to the smaller list. A tie names
nothing at all, because a wrong answer to "what is this session doing" is worse
than no answer, and one wrong row teaches you to distrust the column. What this
finds is marked `workstreamInferred`, and the row shows it as a guess in the
word the rest of the panel uses ("Probably Detection engine"), so it reads as a
guess and is dropped the moment the folder is grouped again. Private and secret files are left out
before anything is hashed, so a private file can never produce a match, and the
file lists are hashed once per folder and kept until that folder's own lists,
roots or private folders change, which costs about a millisecond for the 200
grouped files on this Mac and then nothing.

**Rows that share a piece of work still have to be told apart.** Several
sessions in one project really are often on the same thing, and saying so is
right; showing the same line three times is not. A shared piece of work adds the
one thing that differs: the worktree or branch when that is unique, otherwise
how many files that session has touched. The app's own title stays quoted
underneath either way. When no piece of work matches, the counts stand in for it
("touched 12 files in all, most recently 4 min ago"), and both numbers are real
or the line is not shown. They never follow a named piece of work, because after
that separator a count reads as that piece of work's own, and this one is the
whole backup folder: other projects, other pieces of work, and files the row
will not name. A count only tells two rows apart when no other row in the list
carries the same one, and a list of rows counting different things carries no
count at all. Measured on this Mac after the change: of 14 live rows, 3
name a piece of work (up from 2), 7 carry file counts (up from 0), and 7 are
bare (down from 11). The remaining gap is not the matcher but Work in flight:
only 8 of those rows sit in a folder that has been grouped at all, and a row in
a folder with no workstreams has nothing to be matched to.

## 2026-09-18 — Speaker verification and voice enrollment

Recorded after the fact: this shipped earlier today without an entry. Summon
can now check that a hands-free command comes from the enrolled voice before
it reaches wake detection or Whisper. The check runs in a local Python worker
(`native/speaker/speaker-worker.py`, reusing the wake venv) with the WeSpeaker
ResNet34 ONNX embedding model that `native/speaker/setup.py` downloads from the
sherpa-onnx releases into Summon's data folder. The worker takes PCM WAV over
stdio, has no microphone and no network, and compares cosine similarity against
the enrolled profile at a 0.6 threshold. Profiles stay under `speaker/` in the
data folder. When the model is not installed or no voice is enrolled, the gate
passes audio through unchanged, so nothing regresses for an unconfigured Mac.

Enrollment captures ten spoken samples through the ordinary capture pipeline
from the tray, the new Voice menu or Preferences, with a progress overlay and a
cancel that discards partial samples. Boundary change: in assistant mode the
renderer's microphone permission is granted only while an enrollment is active
and denied again when it ends; ordinary voice stays off there. The worker
itself starts in both modes so status and enrollment are available. No agent
tool authority, provider authentication or observation setting changes.

## 2026-09-18 — Fn toggles Summon's own voice command; the bundle keeps a stable signing requirement

The user is moving the Fn shortcut from the Hermes menu bar into Summon itself.
Summon now ships the same passive native helper Hermes uses (`native/fn-key`,
detector logic identical to Hermes's tested copy) and a supervisor
(`src/main/fn-key.mjs`). A bare Fn tap does exactly what **⌘⇧Space** does: reveal
the workbench and toggle the voice command. This extends the 2026-09-16
Input Monitoring exception to Summon under the same limits: key and modifier
categories are inspected transiently to reject chords; typed characters are
never decoded, stored, logged or forwarded; only a tap signal and a helper
status cross the process boundary. The helper starts only when Summon is not
in assistant mode, because Hermes owns Fn there, exactly as the global shortcut
and wake worker already stay off in that mode. No agent tool authority,
provider authentication or observation setting changes.

Permission handling: a missing grant asks macOS once per run, is shown under
Preferences → Voice with a link to Input Monitoring (not as a workbench error,
which would sit in front of later errors for the whole run), and is re-checked quietly (every ten seconds, on window focus,
wake and unlock) so a grant made in System Settings takes effect without a
relaunch. The supervisor never asks twice in one run.

Root cause of "Fn does nothing" after a rebuild, and the packaging decision: the
local bundle is ad-hoc signed, and an ad-hoc signature's default designated
requirement is its code hash, so macOS keyed the Input Monitoring grant to one
build and silently stopped honoring it after the next (`csreq` in TCC still held
the 16:46 hash while the 18:21 bundle had a new one). `scripts/after-sign.mjs`
now re-signs only the outer bundle with `designated => identifier
"com.summon.companion"`, keeping the hardened runtime and entitlements and the
nested helpers' own signatures. Grants made from now on survive rebuilds (verified the same evening: after `tccutil reset Accessibility com.summon.companion` and re-adding the installed bundle, TCC stored `identifier "com.summon.companion"` as the requirement and the helper reported Accessibility trusted; toggling or removing the old row in the pane had kept the stale hash both times, so the reset is the step that matters). The
trade-off is accepted for a local development build: any other ad-hoc bundle on
this Mac claiming the same identifier would inherit the grant. Revisit when a
Developer ID certificate exists (then the hook steps aside on its own). The
grant made before this change is still keyed to the old hash and has to be made
once more, after the new bundle is installed; the recipe lives in
`docs/desktop-companion.md`. In assistant mode this change is inert by design:
Hermes's own helper owns Fn there, and Summon's shortcut starts only outside it.

## 2026-09-18 — Recorded, not tackled: Hermes's learning loop is off

Finding while explaining the Hermes/Summon split. Upstream Hermes learns three
ways: an explicit memory tool (`~/.hermes/memories`, empty after two days of
use), a post-session background review that distills transcripts into memories
and self-written skills, and session search at run time. On this Mac
`auxiliary.background_review` and `curator` are disabled in `~/.hermes/config.yaml`,
so every skill under `~/.hermes/skills` is a bundled pack and Hermes keeps no
state between sessions unless asked. They are off because those auxiliary passes
make their own provider HTTP call, which needs an API key; the fork rerouted only
the main turn through the Codex app-server. Summon in the loop neither causes
nor blocks this: it only supplies context over MCP. The durable memory that does
work is Summon's (vault hubs, `remember_fact`, the nightly librarian), shared by
Claude Code, Codex and Hermes.

Deferred on purpose. Two options keep the auth rule intact: route the review
through the same Codex app-server machinery the fork already uses (a change in
the local Hermes fork), or add a nightly Summon routine, like the librarian, that
runs headless `codex exec` over the day's Hermes transcripts and appends to the
vault. The second fits the direction of absorbing Hermes into Summon. Revisit
when the executor question is settled; until then, tell Hermes explicitly what
to remember, or record it in the vault.

Assessed the same evening and not adopted, so this is not re-litigated:
**LangChain / LangGraph** declined. Its chat models authenticate with provider
keys or bearer tokens, `@langchain/core` turns on LangSmith tracing from an
inherited environment variable (the silent flip the auth rule exists to
prevent), and it duplicates what `engines.mjs`, the Ollama interpreter and the
planned Agent SDK loop already cover. Revisit only if CLI-owned login is
replaced. A LangChain agent elsewhere can still use Summon as an MCP client.
**TypeSafe** (a third-party router) declined again for context and effort routing: bearer-key
only, no CLI, and the router is designed as a local embedding-centroid
classifier that never sends an utterance off the Mac. The single open door
remains the 2026-09-17 grouping-verification spike with its thresholds.
**Codex Computer History (Skysight)** deferred. It is a keystroke, selection
and accessibility event stream under the CUAService group container plus
server-written Markdown summaries under `~/.codex/memories/extensions/skysight`,
which Summon promises never to capture and whose `computer_use` and memories
features the restricted `codex exec` already disables. The only future slot is
the same nightly routine as the learning loop above: summaries only, treated as
untrusted excerpts through the existing redaction, off by default, with its own
decisions entry. Byproduct worth keeping: `~/.codex/thread_history_1.sqlite`
`thread_turns` (status and timestamps, no content) is a cleaner source for
`sessions/codex.mjs` working and interrupted detection than tailing rollouts.

## 2026-09-19 — Summon hosts the assistant; Hermes retired from the daily path

Owner's instruction: "let's just migrate everything to summon so we can stop
having to go through hermes. i want to retain the hermes capability of
learning, though." This supersedes the 2026-09-16 entries "Adopt a maintained
Hermes fork for agent execution", "Single assistant entry from the menu bar" and
"Background listening from the Summon menu"; the 2026-09-18 Fn entries stand.
The local Hermes fork stays on disk as reference; the read-only Hermes session
reader stays; Hermes's `summon-menu-bar.json` Fn opt-in and its Input
Monitoring grant are retired. Summon is the single Fn, microphone and menu-bar
owner. The phased plan, with defaults for its open questions, is
`docs/migration-plan.md`.

What widens, and how it stays bounded (each phase records its own details):
- **Executor.** Summon will host a persistent `codex app-server` thread per
  selected workspace, spawned with the allowlist environment, sign-in owned by
  the Codex CLI, no provider key ever held or forwarded. Sandbox is
  `workspace-write` for a selected non-vault workspace, `read-only` otherwise;
  approvals are `on-request` and answered only from the trusted workbench
  window (once, session, deny); timeout, hidden window, interrupt or any error
  declines; permission-escalation requests are always declined. This widens
  the restricted answer boundary for that thread only; `claude -p` and
  `codex exec` answers keep their no-tools posture.
- **Spoken conversation.** Fn and ⌘⇧Space toggle a conversation mode:
  speaker-verified utterances, no wake gate, a stop word, replies spoken by the
  local macOS voice from the main process, capture muted while speaking.
- **Transcripts.** Summon will keep user and assistant text of its own agent
  turns under its data folder with 30-day retention, never served over RPC or
  MCP; agent-session readers stay metadata-only.
- **Learning.** A tool-less, schema-bound `codex exec` review over Summon's
  own transcripts proposes memory and skill operations; Summon's main process
  is the only writer; memory adds apply with provenance and are removable,
  everything else waits for a click. This replaces the earlier "no autonomous
  learning" wording in `knowledge.mjs` with "no unreviewed learning".

## 2026-09-19 — Start Claude or Codex from Summon, and let sessions report through hooks

Owner's instruction: "build the launcher with hooks". Two boundaries widen, both recorded here; the 2026-09-17 Agent sessions entry otherwise stands.

**Launching (a click, nothing else).** Summon's only way to run `claude` or `codex` had been the tool-less one-shot answers and the sign-in links. Now a "Start Claude here" / "Start Codex here" button in the workbench, from the trusted window over IPC only (`agent-launch`), writes a per-launch 0700 `.command` under the data folder and opens it with `open -a Terminal`, the same shape as `claude-login`. The script unsets provider keys (Terminal does not inherit `scrubbedEnv()`), `cd`s into the workspace's real path and `exec`s the installed CLI. Sign-in stays with the CLIs; no key or token is passed. Refused: the vault (a project named Second Brain, by name and by path), any sealed folder, a folder that is gone. Nothing launches over RPC, MCP or `npm run sessions`; the 2026-09-17 sentence "never runs their CLIs" now reads "never runs their CLIs except to start a new session on a click". `codex-login.command` is bundled beside `claude-login.command` and reachable as `openLink('codex-login')`.

**Per-session settings, no global edits.** Claude gets `--session-id <uuid>` (so the launch and its session share one id) and `--settings <data>/claude-hooks.json`; Codex gets `-c notify=[node, summon-hook.mjs, codex, --launch, <tag>]`. `--settings` merges with `~/.claude/settings.json`, so the user's own Stop hooks keep running. Summon's MCP server is attached with `--mcp-config` / `-c mcp_servers.summon` only when the user config lacks it, never with `--strict-mcp-config`; the launch result says `global`, `attached` or `none`. Without `node` on the Mac the session still starts, with no hooks and no attached server, and the workbench message says so. Trade-off accepted: a Summon-launched Codex session replaces the user's `notify` (SkyComputerUseClient "turn-ended") for that session only; Codex `-c hooks.*` were rejected because they are untrusted until Codex's own review dialog writes `hooks.state`, and `--dangerously-bypass-hook-trust` is not a flag Summon will pass.

**What hooks send.** `scripts/summon-hook.mjs` forwards event name, session/thread id, cwd, tool name and notification kind to the RPC socket as method `hook`, never writes stdout or stderr, exits 0 within 0.9 s whether or not Summon runs. It never reads or forwards prompt text, `last_assistant_message`, tool input or output, `transcript_path`, notification message text or `turn_id`. The socket validates every field (UUID, absolute path, allowlisted event names, 120-char tool name), refuses any key beyond the nine it knows, and drops the rest.

**What Summon keeps.** `hook-events.json` (0600, 7-day and 500-session retention, 256 KiB cap) holds per session: ids, cwd, state word, event name, tool name, kind, timestamps and the launch tag. This is the first Summon file that records session ids and states; `agent-sessions.json` still holds settings only, and Summon still keeps no unread marks: a Stop makes a row "Open, your move", never "New reply".

**How a hook state is used.** A reader takes a hook state over the app's own record when the record is inferred or older than the hook, and over nothing when hooks are off; a working report older than ten minutes is ignored; hook states show as reported, not "Probably". `SessionEnd` ends a live row at once. Rows Summon launched say "Started from Summon" (`startedFrom` in the contract). A hook arrival drops the cached view and re-arms the menu-bar count once; the panel keeps its 4 s poll and CONTRACT.md's "no push event" stands.

**Installing hooks elsewhere.** A Preferences button merges the same Claude hooks into `~/.claude/settings.json`, after a byte-identical timestamped backup (`settings.json.summon-backup-<YYYYMMDD-HHMMSS>`), keeping every other entry and key, and only on that click; a second click changes nothing. Summon never edits `~/.claude.json` or `~/.codex/config.toml`.

**Not done:** async hooks, PostToolUseFailure/Subagent/Compact events, Codex hooks, worktree-row launch buttons, chaining the user's own Codex `notify`, reading `hostSessionId` in `pickRegistry()`, deriving unread from Stop events.

## 2026-09-19 — Usage meter: each CLI reports its own limits; Summon routes on them

Owner's instruction: build the usage meter and route on it. One boundary widens and is recorded here; the 2026-09-17 Agent sessions entry ("never runs their CLIs") and the launcher entry above otherwise stand.

**Exactly two invocations, both read-only, neither a turn.**
- `claude -p --input-format stream-json --output-format stream-json --verbose --max-turns 1 --tools '' --permission-mode dontAsk --strict-mcp-config --mcp-config '{"mcpServers":{}}' --no-session-persistence --disable-slash-commands --settings '{"disableAllHooks":true}'` with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` in the environment (hooks off so an installed Summon reporter never sees the probe as a session; no flag refetch, so `~/.claude.json` and its backup ring are left alone; both measured 2026-09-19), one stdin line `{"type":"control_request","request_id":"usage-1","request":{"subtype":"get_usage","skip_behaviors":true}}`, read until the matching `control_response`, then stdin ends. No prompt, no turn, no quota spent (0.9 s live). `--setting-sources ''` and `--bare` are not passed: both hide the plan. `claude auth status` is not used (it prints loggedIn:false while turns succeed).
- `codex app-server` under `RUST_LOG=warn`: `initialize` (clientInfo summon) → `initialized` → `account/rateLimits/read {excludeResetCreditDetails:true}`, then stdin ends and the group is stopped (0.7 s live). Never `thread/start`; a server request during the read is answered with a refusal.

Nothing else runs: no `auth status`, no login command, no network of Summon's own, no read of `~/.claude`, `~/.codex`, keychain, config or cookie files. Both children get `scrubbedEnv()` (no provider key), a temporary cwd, a 15 s deadline, and are stopped as a process group. Their output is untrusted data: parsed as JSON or dropped, and every kept field is checked again in `src/core/usage.mjs`. The 2026-09-17 sentence now reads "never runs their CLIs except to start a new session on a click and to ask each CLI, without a turn, how much of its own plan is used".

**Kept:** per provider, plan name, status (`ok`, `not_signed_in`, `not_installed`, `not_applicable`, `error`), windows `{id, label, usedPercent, resetsAt}` and `fetchedAt`. Claude: `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet` only. Codex: windows named by `windowDurationMins` (300 → five_hour, 10080 → seven_day, else `<n>m`), never by position.
**Dropped:** Claude's session cost, behaviors, context and every unknown window name; Codex's `accountId`, credits, upsell, `rateLimitsByLimitId`, `spendControlReached`. Claude's `rate_limits_available:false` or `subscription_type:null` is `not_applicable`, never 0 %. Stored in `usage.json` (0600) with `usageCeiling` (50–100, default 85) and `defaultEngine` (default claude).

**When:** a five-minute loop in `src/core/usage.mjs` (first read 5 s after ready, paused on suspend, resumed on resume and unlock, stopped on quit), **Refresh usage** in the tray menu and in Preferences, and `usage {refresh:true}` over the socket or MCP. One exchange per provider at a time. A reading older than 20 minutes is stale: shown, never routed on.

**Routing rule** (`src/main/engine-choice.mjs`, deterministic, no model): a pinned engine wins; a running thread is never switched; otherwise the most of the 5-hour window left, tie on the 7-day window; any window at or over the ceiling makes that provider unavailable; unknown or stale usage is never treated as empty; both unavailable, or nothing known, means the default engine, with the reason stated. Used by **Ask Auto** (the `ask` IPC with engine `auto`; the answer carries `engine` and `reason`) and by the read-only `pick_engine` MCP tool, which starts nothing. Work in flight grouping keeps its explicit setting.

**Surfaces:** tray rows "Claude 5h 27% · 7d 18%" / "Codex 7d 1%" (read-only labels) and Refresh usage on the standard tray menu (not the assistant-mode menu); Preferences → Usage; socket methods `usage` and `pick-engine`; MCP tools `usage` and `pick_engine` (readOnlyHint). Nothing here can open, launch or sign in.

**Not done:** ingesting the `rate_limit_event` lines that every Summon `claude -p` turn already emits (a free refresh); Auto for Work in flight grouping; usage rows on the assistant-mode tray menu.

## 2026-09-19 — Assistant mode removed

Phase 2 of `docs/migration-plan.md`, under "Summon hosts the assistant" above.
This supersedes the 2026-09-16 entries "Single assistant entry from the menu
bar" and "Background listening from the Summon menu"; the 2026-09-16 "Fn starts
the menu-bar listener" entry is superseded for Summon by the 2026-09-18 Fn
entry, whose "in assistant mode" sentences now describe a mode that no longer
exists. `src/main/assistant-entry.mjs` and every `assistantMode` gate are gone:
Summon always starts with its Dock icon, workbench and tray, and ⌘⇧Space, ⌘⇧J,
the Fn helper, the wake detector, desktop voice and the Whisper warm-up run
unconditionally; nothing opens, launches or hands the menu bar to another app,
and a leftover `assistant-entry.json` is never read. Microphone permission is
unchanged and now has no exception: the main window's main frame, audio only
(the enrollment-time widening from the 2026-09-18 speaker entry existed only
for assistant mode and goes with it). The read-only Hermes session reader
stays, as for any other agent. Observation, MCP scope and provider
authentication do not change.

## 2026-09-20 — Connected visual workspace, explicit goals and bounded hook history

The owner requested goal diagrams, both codebase and commit-history diagrams, a kitchen-style agent view and a live event graph. Implement these as five presentations within Summon's existing workbench. The common identities are repository, worktree and session; relationship labels distinguish explicit goal links, observed import edges and reported/inferred session state.

The codebase view adds a bounded, local read of tracked JavaScript/TypeScript source to identify relative imports. Secret/private/generated/vendor paths are excluded and no source bodies leave the process or enter durable state. The git view reads real commit parents and locally stored references with the existing read-only git environment. No network, hosted diagram generator, provider credential or autonomous model call is introduced.

Goals are user-authored records with explicit statuses, parent milestones, dependencies and optional local links. Their private data file is `visual-goals.json`; no progress percentage or completion is inferred from git or agent activity. Cycles and cross-repository links are rejected before saving.

The hook ledger now retains a bounded sequence of the same metadata it already accepted (event name, optional tool name, state and receipt time), alongside the existing latest-state entry. Retention is at most seven days, 100 events per session and 2,000 events in total, also subject to the ledger byte cap. Prompt text, tool inputs/outputs and transcript contents remain excluded. Old latest-state files load without fabricated history. The timeline reports observed actions, not internal reasoning or reconstructed intent.

The owner clarified that the kitchen should have Agenttrail’s animated 3D appearance. Bundle its MIT-licensed procedural chef rigs, art helpers and animation with Three.js, retaining attribution and license text. The room controller and React adapter are native to Summon; no Agenttrail server, provider adapters, automatic setup or extra watcher runs. Unlike Agenttrail’s role-based chefs, each Summon chef is one known session. Cooking, walking and attention gestures illustrate current session activity; they never infer a completed goal, shipped artifact or successful tool result. Animation is optional, honors reduced motion and stops when the document is hidden or the panel unmounts. WebGL failure retains the accessible session list. GitDiagram remains a design reference. All new reads and goal writes are trusted-window IPC; no change is made to the restricted CLI answer or MCP tool boundaries.


## 2026-09-20 — Visual sessions span the workstation

The owner clarified that Summon’s visual agent view must show working sessions across projects. Kitchen now opens on All projects and consumes the existing combined session view without filtering out sessions lacking a repository. Project, folder and unassigned scopes are optional filters; working and attention states precede history. Existing reader coverage and visibility settings remain authoritative. Git, codebase maps and goal edits retain explicit repository scope. Session trace reads use the existing known session key through trusted-window IPC independently of Git scans; no new watcher, provider access or MCP capability is introduced.
