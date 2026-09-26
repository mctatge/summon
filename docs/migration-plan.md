# Migration: the assistant moves into Summon

Decision of 2026-09-19 (see `decisions.md`): Summon hosts the executor, the spoken
conversation and the learning loop itself; Hermes leaves the daily path and
the local Hermes fork becomes reference only. This file is the working plan. Each
phase is usable on its own. Sizes are working sessions.

## Thesis

Summon already owns everything in the voice loop except the executor and the mouth: capture/VAD/Whisper/wake/speaker workers, a deterministic command router, curated knowledge, the RPC socket + MCP adapter, and an allowlist env scrubber. Hermes contributed three things worth keeping: (1) a persistent `codex app-server` thread with fail-closed approvals, (2) spoken replies via `/usr/bin/say`, and (3) a learning loop that is in fact switched off in the local install (`~/.hermes/memories` empty, all skills bundled, `configure.py:54-56` disables review/curator; `background_review.py:246-259` hard-gates it under `codex_app_server`). So nothing is migrated as data; three capabilities are rebuilt in Node on Summon's existing boundaries. The protocol knowledge (thread/start fields, server-request table, watchdogs, approval decision map, review prompt text) ports from the fork; the process client, turn driver, speaker, and review orchestration are reimplemented because Summon's `run()` is one-shot and Hermes's are welded to its Python agent loop. Auth rule holds because Codex reads `~/.codex/auth.json` itself under `scrubbedEnv()`; the learning pass uses the same tool-less `codex exec --output-schema` shape `workstream-engine.mjs` already ships. Each phase is usable alone: 1 gives a persistent read-only Codex thread in the workbench, 1b adds approvals and workspace-write, 2 deletes assistant mode, 3 adds the spoken conversation on Fn/⌘⇧Space, 4 adds review + recall.

## Phase 0 (by hand, one leftover) — Summon owns the menu bar and Fn

**Size:** 15 minutes, no code

**Goal.** One tray, one Fn owner, one mic owner before any code lands.

**Deliverables**

- Done: main.mjs runs one path (tray, ⌘⇧Space, wake, Fn all start). Before Phase 2 landed, `~/Library/Application Support/Summon/assistant-entry.json` selected the path; a leftover file is now ignored.
- Leftover: ~/Library/Application Support/Hermes/summon-menu-bar.json is still {"enabled":true,"fnKey":false} and Hermes.app is running. Quit Hermes and set enabled:false there, or its star tray and gateway keep coming up alongside Summon's.
- Confirm the com.summon.companion Input Monitoring grant per docs/desktop-companion.md:87 (tccutil reset ListenEvent com.summon.companion, re-add the installed bundle).

**Risks**

- Two Fn helpers both toggle if Hermes stays enabled; the symptom is a Hermes listening tray appearing when Fn is tapped.

**Verification.** Launch Summon: exactly one star in the menu bar; Fn tap toggles Summon's voice command (fn-key.mjs:14-88 status 'ready' in Preferences); `pgrep -fl hermes_cli` is empty.

## Phase 1 — Executor: a Codex app-server thread hosted by Summon (read-only, approvals declined)

**Size:** 1 working session for the client + tests + smoke (the first slice); a second half-session for main.mjs/renderer wiring and the decisions entry.

**Goal.** Replace one-shot `codex exec` for unknown requests with a persistent per-workspace Codex thread whose context is Summon's own MCP adapter. Sign-in stays with the Codex CLI; Summon holds no token. Approvals are declined until Phase 1b, so this slice is honest but safe.

**Deliverables**

- src/main/process.mjs: add `spawnLongLived(binary,args,{cwd,env})` (or export an `registerOperation({stop,closed})` hook) so a bidirectional child registers in activeProcesses (process.mjs:7-19,69) and dies under stopProcesses() at quit (main.mjs:304-313, 8 s bound). Keep scrubbedEnv() as an allowlist; pass RUST_LOG=warn via the `extra` arg (process.mjs:21-26). No blocklist copy from hermes_cli/codex_cli_status.py:38-44.
- src/main/codex-thread.mjs (new, ~350 lines): newline JSON-RPC 2.0 client over stdio (pending Map by id; {method,id} => server-request queue; {method} only => notification queue; non-JSON stdout lines logged not fatal; 500-line stderr tail redacted before display). Handshake: `initialize {clientInfo:{name:'summon',title:'Summon',version}, capabilities:{}}` then `initialized` notification (port of codex_app_server.py:142-156; no experimentalApi, no dynamicTools). `thread/start {cwd, sandbox:'read-only', approvalPolicy:'on-request', developerInstructions, config:{mcp_servers:{summon:{command:<node>, args:[<Summon>/scripts/mcp-server.mjs], startup_timeout_sec:15, tool_timeout_sec:20}}}}`; thread id from thread.id|thread.sessionId|sessionId|threadId (codex_app_server_session.py:200-222). `turn/start {threadId,input:[{type:'text',text}],effort}` => {turn:{id}}; `turn/interrupt {threadId,turnId}`; notifications turn/started, item/started, item/completed, item/agentMessage/delta, turn/completed {turn:{id,status,error}}, thread/tokenUsage/updated; scope-filter by threadId/turnId, accept unscoped (session.py:64-99). Server requests answered before further notifications after draining ≤8 queued ones; item/commandExecution/requestApproval and item/fileChange/requestApproval => {decision:'decline'} when no approval callback; item/permissions/requestApproval => always 'decline'; mcpServer/elicitation/request => {action:'decline'}; unknown => JSON-RPC error -32601 (session.py:575-615). Watchdogs: 600 s turn deadline, 90 s post-tool silence => interrupt + retire, deadline after a completed agentMessage accepted as final, '<turn_aborted>' marker = aborted (session.py:381-500, 59-61). Retire on subprocess death or stderr/JSON-RPC text matching invalid_grant|refresh token|401|unauthorized|please login|oauth (session.py:120-138) with the user message 'Sign in to Codex in Terminal'. Teardown: snapshot child pids, close stdin, SIGTERM, 3 s, SIGKILL the group (codex_app_server.py:158-180) because Codex spawns Summon's own mcp-server.mjs as a child.
- src/main/summon-instructions.mjs (new, ~60 lines): developerInstructions built from a Summon-owned SOUL text (start from the local Hermes fork's integrations/summon/SOUL.md:1-30 with the Hermes sentences removed) + the untrusted-data framing already in engines.mjs:28. Phase 4 appends the memory block and skills index here.
- src/main/main.mjs: `handle('agent-turn',text)` and `handle('agent-interrupt')`; one thread per selected workspace keyed by project id, cwd = workspace path, or an empty mkdtemp when no workspace is selected; stream events to the renderer with `window.webContents.send('summon:agent-event',…)` (IPC only, CSP forbids sockets: index.html:6). Reuse the engineBusy guard pattern from main.mjs:264.
- src/main/preload.cjs:4-14: add agentTurn, agentInterrupt, onAgentEvent. src/renderer/main.tsx: the `result.kind==='unknown'` branch (main.tsx:238) gets 'Send to Codex' that streams into the existing answer area; keep 'Ask Claude' one-shot as is. src/renderer/types.ts: AgentEvent type.
- src/main/codex-readiness.mjs (~40 lines): `codex login status` through run() with scrubbedEnv, 5 s timeout, output discarded, exit code => health.codex {installed,ready,error?} (port of hermes_cli/codex_cli_status.py:72-91); companion.mjs setHealth (604-608) gains no new shape, put it on the snapshot beside fnKey (main.mjs:44). scripts/codex-login.command modeled on scripts/claude-login.command:3-5 (unset provider keys, run `codex login`).
- tests/codex-thread.test.mjs with a fake app-server child script under tests/fixtures (same technique as tests/transcription.test.mjs 47-101 fakes the Whisper worker): handshake order, thread id variants, approval decline, -32601 on unknown request, watchdog retire, foreign-thread notification ignored, teardown kills the group. Add `createCodexThread` and `codexReadiness` stubs to the vm contexts in tests/lifecycle.test.mjs:40-59, tests/sessions-tray.test.mjs:59-75, tests/assistant-entry.test.mjs:71 (those tests strip imports and inject globals by name).
- docs/decisions.md: one dated 2026-09-19 entry (see decisions_to_record) written in this phase, before the boundary widens.

**Ported from the fork**

- Protocol tables verbatim: thread/start params and id lookup (codex_app_server_session.py:198-222), server-request handler map and fail-closed rule (575-633), decision map once=>accept, session=>acceptForSession, else decline (714-721), notification scope filter (64-99), watchdog constants and deadline acceptance (349-500), OAuth failure heuristics (120-138), teardown order (codex_app_server.py:158-180).
- Binary resolution order is already in process.mjs:27-32 (ChatGPT.app/Codex.app then PATH), matching hermes_cli/codex_cli_status.py:48-70; nothing to port.
- Developer-instruction text: integrations/summon/SOUL.md:1-30, minus the Hermes/Claude-worker sentences.
- Per-thread MCP passthrough shape from hermes_cli/codex_runtime_plugin_migration.py:83-126 and configure.py:35-37 (command/args/timeouts), never ~/.codex/config.toml.

**Risks**

- The installed Codex at the time of writing was 0.155.0-alpha.9.2, newer than anything the fork tested; field names (thread id location, turn/completed shape) must be confirmed by the smoke script, and unsupported versions must fail visibly (CODEX.md:58-60), never fall back to another provider.
- The kanban/-c overrides, dynamic tools, experimentalApi, event projector and gateway fan-out in the fork are deliberately not ported; do not let 'port the client' drift into porting codex_runtime.py.
- Adding an import to main.mjs breaks the three vm-context tests until their global maps gain the new names.

**Verification.** `npm test` green including the fake-server tests; tests/process.test.mjs:6 still proves ANTHROPIC_API_KEY/OPENAI_API_KEY/CODEX_API_KEY are absent from the child env; `node scripts/codex-thread-smoke.mjs` against the real /Applications/ChatGPT.app/Contents/Resources/codex (0.155.0-alpha.9.2) completes two turns in one thread with sandbox read-only and shows a summon MCP tool call in item/completed (mcpToolCall.server==='summon'); an exec request from the model is declined and reported, not hung; quitting Summon during a turn leaves no `codex app-server` or `mcp-server.mjs` process (`pgrep -f 'codex app-server'`).

## Phase 1b — Approvals from the workbench, workspace-write per workspace

**Size:** 1 working session

**Goal.** Let the thread act: exec and apply_patch approvals answered by a human in the trusted window, declined otherwise; sandbox widened to workspace-write only for workspaces that opt in.

**Deliverables**

- codex-thread.mjs: approval callback `(kind, {command,cwd,reason,changeSummary}) => Promise<'accept'|'acceptForSession'|'decline'>`; track item/started fileChange items so the apply_patch prompt shows the changeset (session.py:659-670); 300 s timeout, interrupt, hidden/destroyed window, or callback exception => 'decline'; item/permissions/requestApproval stays 'decline'; no auto-approve flag exists in Summon.
- main.mjs: `handle('agent-approval',{requestId,choice})` where choice ∈ once|session|deny; revealWindow() (main.mjs:46) when a request arrives; pending requests are per thread and cleared on retire. Approvals remain in the trusted workbench; the menu-bar listening controls grant no agent-action authority.
- Renderer: approval card in the answer area showing the redacted command (control chars stripped, 600-char cap as desktop-voice.mjs:82 does) with Allow once / Allow this session / Deny.
- Sandbox policy: per-workspace setting `agentWrite:boolean` (default false) stored in state.json settings via service.updateSettings; thread/start sandbox = 'workspace-write' only when true and the workspace path is not the vault (main.mjs:60 'Second Brain' rule, decisions.md:90-91); changing it starts a new thread.
- Health: health.codex surfaced in Preferences with the 'Sign in to Codex' Terminal link (same pattern as the claude-login link, main.mjs:70). The link itself landed 2026-09-19 with the launcher: `openLink('codex-login')` opens the bundled `codex-login.command` (decisions.md 2026-09-19); only the health surface remains.

**Ported from the fork**

- Prompt wording 'Codex requests exec in <cwd> — <reason>' and apply_patch summary assembly (session.py:635-657).
- Choice=>decision map and the 'timeout and deny both decline' rule (714-716); no allow_permanent (codex_runtime.py:406-414).

**Risks**

- An approval pending while the window is hidden was the documented Hermes pain (docs/desktop-companion.md ~540); revealWindow plus, in Phase 3, a spoken 'Codex wants to run something; approve in the window' cover it.
- Workspace-write on a cwd that contains a git repo lets the model edit tracked files; that is the point, but the default must stay off and per workspace.

**Verification.** Fake-server tests: approval resolves accept/acceptForSession/decline; timeout and window-gone decline; permissions request declined even with a callback; a second thread cannot answer the first thread's request. Manual: ask the thread to `ls` in a workspace with agentWrite off => declined with a visible note; turn agentWrite on => prompt appears in the workbench, Allow once runs it, Deny reports it; the vault workspace never offers agentWrite.

## Phase 2 — Remove assistant mode and every Hermes hand-off (landed 2026-09-19; see decisions.md "Assistant mode removed")

**Size:** half a session

**Goal.** Make the non-assistant path the only path so the Phase 3 loop is not fighting gates; keep the read-only Hermes session reader.

**Deliverables**

- Delete src/main/assistant-entry.mjs and tests/assistant-entry.test.mjs.
- main.mjs: remove import (18), state (33), snapshot field (44), revealAssistant/revealEntry/requireSummonVoice (47-49), read+dock hide (98-100), the assistantMode clauses in the media permission handlers (118-119, keep main-window/main-frame/audio-only), tooltip branches (121), warm gate (127), former desktop voice entry gate (133; retired with the widget on 2026-09-21), detect-wake/transcribe guards (237, 262), the hermes tray owner branch and assistant context menu (265-272), shortcut gate (274), show/start gate (278), background `open -g -j Hermes.app` (279), wake gate (281), Fn gate (284).
- Renderer: main.tsx:181 redirect, :220 'Open assistant' label, :285 'Your assistant' Preferences section; types.ts:6 assistantMode.
- Tests: drop readAssistantEntry/readAssistantMenuOwner/openAssistant from the vm contexts (harmless if left, cleaner removed).
- Docs: docs/desktop-companion.md 471-587 'One assistant from the macOS menu bar' replaced by a short 'Menu bar and shortcuts' section; note that assistant-entry.json is ignored. Keep src/core/sessions/hermes.mjs and the Hermes row in the agent-sessions table (it degrades to 'Hermes is not set up').
- The local Hermes fork stays on disk as reference until Phase 4 lands; do not delete.

**Risks**

- Silent behaviour change if a stale assistant-entry.json exists on another machine: document it in desktop-companion.md 'Local data'.

**Verification.** `grep -rn assistantMode src tests` returns nothing; `npm test` green; app launches with dock icon, tray, ⌘⇧Space and Fn all active regardless of any assistant-entry.json content; mic permission still granted only to the main window's main frame for audio (lifecycle test asserts the handlers are installed).

## Phase 3 — Spoken conversation: Fn/⌘⇧Space starts a session, Whisper + speaker check, thread turn, `say` reply, tap again stops

**Size:** 2 working sessions (loop + speech first; barge-in and cues second)

**Goal.** The Hermes menu-bar loop rebuilt on Summon's single capture owner: no wake gate in conversation mode, speaker-verified utterances, stop word, thinking/speaking states, spoken replies from main, automatic re-listen.

**Deliverables**

- src/main/speech.mjs (new, ~90 lines): `speak(text)` spawns /usr/bin/say via spawn with scrubbedEnv (no -o; say blocks until done and SIGTERM stops it), text sanitized by a ported speech-text sanitizer and capped at 2000 chars, split on sentence boundaries into a queue so the first sentence starts before the rest; `stop()` kills the current say and clears the queue; publishes 'speaking' start/end through voiceControl.updateVoice. Playing from main avoids the renderer autoplay issue (no autoplay flag in main.mjs; only scripts/smoke-desktop-voice.mjs:12 sets one).
- src/main/speech-text.mjs: port of the local Hermes fork's apps/desktop/src/lib/speech-text.ts:1-167 (markdown/code/URL/emoji stripping) as is.
- src/renderer/voice-stop-word.ts: port of apps/desktop/src/lib/voice-stop-word.ts:17-105 with prefixes changed to 'summon'/'hey summon'; applied to the whole utterance before submit.
- src/main/transcription.mjs:99: add the Whisper hallucination filter (tools/voice_mode_transcript.py:22-40 list + repeat regex) after the [..] token strip; apply it after the stop-word check so 'bye' can still end a session.
- src/renderer/voice.ts: add mode 'conversation' (types.ts:8 VoiceMode): getUserMedia as today (voice.ts:162), no wake gate, verifySpeaker on every utterance (passes through when not enrolled, speaker.mjs:87), END_PAUSE 1.25 s and 29 s cap in this mode (Hermes use-voice-conversation.ts:265-266 vs voice.ts:4,216), indefinite wait with the existing 3-chunk pre-roll (voice.ts:205), then bridge.agentTurn(text) instead of bridge.command for classifyCommand 'unknown' results (deterministic commands still run locally first, commands.mjs:1-17). New states 'thinking' and 'speaking'; while speaking, processor.onaudioprocess (voice.ts:190-191) drops frames; when main reports speech ended, re-arm listening; 'off' still cancels partial speech and discards late results (voice-capture tests 43-50 must keep passing).
- src/main/desktop-voice.mjs: STATES += thinking, speaking, awaiting-approval; MODES += conversation. Add matching detailed state labels in the workbench. The menu-bar star remains green strictly while micActive is true and monochrome otherwise; thinking, speaking and approval phases must not imply microphone capture. The desktop widget and its preload were removed on 2026-09-21 (see decisions.md).
- main.mjs: ⌘⇧Space (274) and Fn onTap (286) toggle 'conversation' (start if off, stop if any voice mode is on) instead of 'command'; the Voice app menu keeps 'Speak one command'. Hold transcriber.warm for the whole mode (already keyed to mode!=='off', main.mjs:124-128). On turn completion speak the final agentMessage; on an approval request speak 'Codex wants to run a command. Approve it in the window.' and revealWindow.
- Interrupt: stopping the mode calls agent-interrupt (turn/interrupt) and speech.stop(). Barge-in during speaking is a follow-up (3b): detect on the same processor with thresholds rescaled from Hermes's byte-domain 0.14-0.37 to Summon's float gate, then turn/interrupt + speech.stop + mark the next turn 'interrupted'. Optional cues: port wake-sound.ts:34-58 and thinking-sound.ts (renderer WebAudio, no assets).
- Transcript log: dataDir/agent-transcripts/<threadId>.jsonl {role,text,at,toolNames} written by main for user/assistant text only (no tool output), 30-day retention, listed in the Local data table; never served over RPC/MCP (rpc.mjs:29-47 gains nothing).

**Ported from the fork**

- speech-text.ts (167 lines, pure) and voice-stop-word.ts (105 lines) as is; WHISPER_HALLUCINATIONS list; the loop's constants (silence 1.25 s, cap 29 s, 1 s pre-roll idea, re-listen after speech, stop-word before submit) from use-voice-conversation.ts:143-337 and use-mic-recorder.ts:137-158; the 'ready only after the mic is actually open' rule from store/summon-menu-bar.ts:59-91; the say command line from configure.py:43.
- Not ported: use-mic-recorder/pcm-wav-capture (Summon's voice.ts already does it), the second-stream barge monitor (voice-barge-in.ts opens its own getUserMedia; Summon keeps one owner), the gateway TTS/STT HTTP hops, the tts-lease and voice.prepare heartbeat (transcriber.warm covers it).

**Risks**

- Echo: hands-free capture will hear `say` unless frames are dropped during 'speaking'; echoCancellation is not a guarantee.
- Barge-in constants cannot be copied: Hermes gates on byte-domain RMS/42 with a fixed 0.075 trigger, Summon on float RMS 0.012-0.03 (voice.ts:199-201).
- Long replies: say has no length limit but a 2000-char cap and sentence queue keep interrupts responsive; keep the 15 s stall idea as a per-sentence timeout.

**Verification.** voice-capture tests: conversation mode submits a verified utterance to agentTurn, never to Whisper while 'speaking', discards a late result after stop, ends on 'stop listening'; speech tests with a fake `say`: sentence queue, stop kills the child, text over 2000 chars is truncated not rejected, control characters removed; desktop-voice tests still prove capture-owner identity checks and bounded stop behavior; tray tests prove the star follows actual microphone activity. Manual: Fn => chime/label 'Listening', speak 'what am I working on' => local command answer spoken; speak an open question => thread answers and speaks; Fn again => everything stops within 1.2 s (desktop-voice.mjs:56-66 watchdog); `pgrep say` empty afterwards.

## Phase 4 — Learning: post-session review through headless codex exec, Summon store + vault + skills, recall injected into later threads

**Size:** 2 working sessions (review + memory first; skills + MCP tools + export second)

**Goal.** Retain Hermes's learning capability without its API-key path: a tool-less, schema-bound Codex call over Summon's own transcripts proposes memory and skill ops; Summon main is the only writer; the next thread sees the results.

**Deliverables**

- src/main/review-engine.mjs (new, ~120 lines): `runReview({digest,memoryBlock,skillsIndex,ownedSkills})` using restrictedCodexArgs() + `--output-schema` exactly as workstream-engine.mjs:22-32,40-58 (mkdtemp cwd, 0600 schema file, scrubbedEnv, 300 s, 4 MB, parse item.completed/agent_message). Schema: {nothing_to_save:boolean, memory_ops:[{action:add|replace|remove, target:memory|user, content?, old_text?, projectId?}], skill_ops:[{action:create|patch|write_file, name, category?, content?, old_string?, new_string?, file_path?, file_content?}], notes:string}. Prompt = ported _COMBINED_REVIEW_PROMPT (background_review.py:459-520) with tool names replaced by the JSON ops, the curator/pin sentences and 'Be ACTIVE' removed, plus _DO_NOT_CAPTURE_BLOCK (348-371) and the memory guidance 'declarative facts, not imperatives' (prompt_builder.py:163-209). Input digest per _digest_history rules (269-301): last 24 messages verbatim, older user turns to 300 chars, assistant to 200 chars + tool names; transcripts framed as untrusted data; drop anything under a sealed folder.
- src/core/learning.mjs (new, ~200 lines): proposals store dataDir/learning-proposals.json {version:1, proposals:[{id,kind:memory|skill,op,text,projectId,source,createdAt,status:pending|accepted|dismissed}]}; validation (text ≤2000, control chars, strict injection/exfil scan carried from memory_tool_store.py:26-29 concept, batch may not empty the store); apply rules mirroring Hermes's unattended gates: memory `add` applied at once through knowledge.remember({source:'Learned from review <date>'}) and shown under a 'Learned' heading with Remove; memory replace/remove and every skill op staged pending until Accept; skill patches rejected when old_string is not found in the current SKILL.md; only skills with a `createdBy: review` sidecar are patchable (skill_manager_guards.py:164-215 rule); routine suggestions are dropped unless they pass classifyCommand + ACTIONS (knowledge.mjs:7).
- knowledge.mjs: no schema bump for memories (kind stays 'explicit'); add an optional `target:'user'` memory field only if the profile block is wanted, otherwise keep one list and render the injected block from memories with a soft 3.5k-char budget. Rebase or land the local BM25 worktree (it touches knowledge.mjs:179-225,301-337) before editing search().
- src/core/skills.mjs (new, ~80 lines): dataDir/skills/<category>/<name>/SKILL.md, YAML frontmatter name+description (≤60 chars for the index), optional references/ templates/ scripts/ assets/; walk, parse, render `<available_skills>` index; agentskills.io-compatible so Claude Code/Codex skills can be dropped in. Start empty.
- Recall: summon-instructions.mjs appends the rendered memory block (Hermes header format, memory_tool_store.py:20-21) and the skills index to developerInstructions; frozen per thread, new thread after a review. scripts/mcp-server.mjs:61-73 and rpc.mjs:29-47 gain read-only `get_memory`, `skills_list`, `skill_view`; remember_fact's 'only when asked' contract is untouched because review writes never go through it.
- Trigger: when a conversation ends (mode back to off) and at most once per hour, plus a 'Review now' button in Memory & routines; watermark dataDir/review-state.json {lastReviewedAt,lastTranscriptOffset}. No LaunchAgent; if a nightly pass is wanted later it calls the same runReview through `node scripts/review.mjs`, not `claude --print` with a token (a nightly script that hands `claude --print` a token is exactly what scrubbedEnv forbids).
- Vault: proposals with a projectId get an 'Append to <Project> Hub Log' action that appends one dated line to the hub's Log section on click (append in place, never mv; the same file the user already appends to); the review never writes the vault unattended.
- One-time explicit export: a `scripts/hermes-transcripts-export.mjs` that clones ~/.hermes/state.db+wal+shm (sqlite-snapshot.mjs technique) and writes user/assistant text into a review digest, run by hand once so past Hermes conversations get one review; the read-only agent-sessions reader (src/core/sessions/hermes.mjs:1-2) stays metadata-only.

**Ported from the fork**

- Prompt text: _COMBINED_REVIEW_PROMPT, _LESSON_LAYER_BLOCK, _DO_NOT_CAPTURE_BLOCK (background_review.py:318-371,459-520) with tool names swapped; digest rules (269-301); memory block header format and § entry model (memory_tool_store.py:20-23); unattended add-only rule (memory_tool.py:142-172); review-owned-skills-only and read-before-write rules (skill_manager_guards.py:164-240); SKILL.md format and 60-char description limit (skill_utils.py:741); the hallucination-free session_search idea is replaced by Summon's own transcript log.
- Not ported: background_review.py's fork/cache-parity/usage plumbing, curator.py, skill ledger/blobs/linter, session_search over state.db (one-time export instead).

**Risks**

- knowledge.mjs:45 promises 'no autonomous learning' and validState (line 30) pins kind='explicit'; the decisions entry must restate this as 'no unreviewed learning except provenance-labelled adds' or the pending-only variant, and the UI must make review-written entries removable in one click.
- The skill prompt produces sprawl without a curator; keep skill ops staged and start memory-first.
- Transcripts are a new class of data Summon holds; retention, the Local data row, and 'never over MCP' must land with Phase 3, not here.

**Verification.** review-engine test pins the argv (read-only, approval_policy never, mcp_servers={}, --output-schema present, memories/skill_search/chronicle disabled) like tests/engines.test.mjs:5; learning tests: add applies with provenance, replace/remove/skill ops stay pending, patch with a stale old_string is rejected, injection-pattern text is refused, a run that would empty memory is refused; knowledge-rpc test still shows no routine execution and remember_fact provenance unchanged; manual: hold a short conversation stating a preference, end it, see it under 'Learned' within a minute, start a new conversation and confirm the thread's first answer reflects it (developerInstructions contain the block).

## Defaults chosen for the open questions

The owner's instruction was to migrate now and not optimize for the long term, so the
open questions the plan raised are settled with the simplest working default; each
can be revisited with a dated entry.

- **Sandbox:** `workspace-write` for a selected workspace that is not the vault, `read-only` when no workspace is selected, approvals `on-request` always. Hermes parity; every exec and patch still passes a human approval in the workbench.
- **Memory adds from the review** apply immediately with provenance and are removable from Memory & routines; replace, remove, skill ops and vault appends wait for a click.
- **Whisper model:** keep `settings.whisperModel` (small.en by default); a locally downloaded large-v3-turbo file is a Preferences choice, not a code change.
- **Barge-in** is Phase 3b, after the loop ships; until then a reply finishes its sentence before the next utterance is heard.
- **Vault writes** happen only on click, appended to the project hub's Log; the nightly librarian keeps the vault otherwise.
- **Hermes transcript export:** dropped. Nothing was ever learned from them; the read-only Hermes session reader stays.
- **User profile:** one memory list with a soft 3.5k-character injected block; no second USER.md-style target.
- **Approvals with the window closed:** reveal the workbench automatically; menu-bar listening controls never carry approvals.
- **Minimum Codex version:** whatever the smoke run against the installed `codex app-server` confirms; refuse older with a visible health message.

## Open questions still worth a look

- Codex 0.155.0-alpha.9.2 vs the fork's tested 0.153.4: confirm thread/start, turn/completed and approval request shapes in the smoke run before building on them; decide the minimum version Summon refuses below (the fork used 0.125.0, codex_app_server.py:24).
- Default sandbox for the conversation thread: read-only until a workspace opts in (proposed), or workspace-write by default for non-vault workspaces as Hermes did (CODEX.md:13-15)?
- Memory adds from the review: apply immediately with provenance (Hermes's unattended add-only rule) or stage everything pending? The plan proposes immediate adds + removable UI; it changes the knowledge.mjs:45 promise either way.
- Whisper model for conversation mode: settings.whisperModel currently defaults to ggml-small.en.bin (main.mjs:110) while Hermes's docs describe Large v3 Turbo Q5_0, which whisper-cpp keeps under ~/.cache/whisper-cpp/models/ once downloaded; latency vs accuracy choice, English-only either way.
- Barge-in in Phase 3 or deferred: it needs rescaled thresholds on the float pipeline and a 'turn interrupted' marker on the next turn/start; shipping the loop without it means speaking over Summon does nothing until it finishes a sentence.
- Vault writes: append proposals to the project hub Log on click (proposed) or keep the vault entirely for the nightly librarian and only write knowledge.json?
- One-time Hermes transcript export (~/.hermes/state.db) for a single review, or drop the Hermes history entirely since nothing was ever learned from it?
- Whether to keep a user-profile target (Hermes's USER.md) as a second injected block or one memory list with a soft budget; affects the knowledge schema and the review schema.
- Who owns approvals when the workbench window is closed but the app is running (tray-only): reveal automatically (proposed) or decline and speak 'approve in the window' only?

## First slice

Build src/main/codex-thread.mjs plus its fake-server tests and a smoke script, without touching the renderer. Steps: (1) add `spawnLongLived` to src/main/process.mjs that spawns with scrubbedEnv({RUST_LOG:'warn'}) in a detached group and registers {stop,closed} in activeProcesses so stopProcesses() reaches it (process.mjs:7-19,69); (2) write the JSON-RPC line client and session: initialize/initialized, thread/start {cwd, sandbox:'read-only', approvalPolicy:'on-request', developerInstructions, config.mcp_servers.summon}, turn/start, notification scope filter, server-request table with decline-all and -32601, 600 s/90 s watchdogs, interrupt, retire-on-OAuth-text, group teardown (port the tables from the local Hermes fork's agent/transports/codex_app_server_session.py:192-222, 349-500, 575-657, 714-721 and codex_app_server.py:142-180); (3) tests/codex-thread.test.mjs with a fake `app-server` Node script (same technique as tests/transcription.test.mjs) covering handshake order, the four thread-id shapes, approval decline, unknown-request error, foreign-thread notifications ignored, watchdog retire, and that quitting kills the child group; extend tests/process.test.mjs for spawnLongLived's env; (4) scripts/codex-thread-smoke.mjs that runs two turns against /Applications/ChatGPT.app/Contents/Resources/codex (0.155.0-alpha.9.2) in a temp cwd and prints agentMessage text and any mcpToolCall from server 'summon'; (5) write the dated docs/decisions.md entry. Done when `npm test` is green and the smoke script shows a second turn that remembers the first and a declined exec request that does not hang. Wiring to `handle('agent-turn')` and the 'Send to Codex' button is the next half-session.
