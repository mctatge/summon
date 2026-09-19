# Architecture

> **Current implementation:** See [Desktop companion](desktop-companion.md) for the running metadata service, file ledger, direct commands, voice, MCP bridge, Work in flight, Agent sessions and Where this stands. The SDK engine, surface registry, persistent sessions, and HUD architecture below are an earlier proposal and are still not implemented.

Summon is a macOS menubar assistant where **Claude is the brain and tool calls summon the UI**.
The app is three layers glued by one pattern:

```
┌────────────────────────────────────────────────────────┐
│  SHELL (Electron)                                      │
│  tray popover · HUD panels · chat transcript · voice   │
├────────────────────────────────────────────────────────┤
│  SURFACE SYSTEM                                        │
│  registry of pre-built panels; the agent summons them  │
│  via one in-process tool: show_surface(id, payload)    │
├────────────────────────────────────────────────────────┤
│  ENGINE (@anthropic-ai/claude-agent-sdk, in-process)   │
│  query() streaming · custom tools · sessions ·         │
│  subscription auth via the user's own `claude` login   │
└────────────────────────────────────────────────────────┘
```

The defining loop:

> voice/text → engine → Claude decides a *surface* serves better than prose →
> calls `show_surface("clog-status", {...})` → in-process handler fires IPC →
> panel animates out of the menubar → ack returns to Claude → it narrates briefly.

Nothing ever bounces to an external browser. Artifacts render **inline, sandboxed**.

---

## 1. Engine — Claude Agent SDK, in-process

The SDK (`@anthropic-ai/claude-agent-sdk`, TS) runs inside Electron's **main process**.
No sidecar, no subprocess plumbing — this is the decisive reason Electron won over
Tauri (see [decisions.md](decisions.md)).

### Driving a turn

```ts
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";

const q = query({
  prompt: userText,
  options: {
    cwd: workspaceDir,                    // sessions namespace by cwd (see §4)
    resume: threadId,                     // continue a specific thread
    mcpServers: { ui: uiServer, data: dataServer },
    allowedTools: ["mcp__ui__*", "mcp__data__*", "Read", "Grep", "WebSearch"],
    permissionMode: "dontAsk",            // never prompts; hard-denies unlisted
    systemPrompt: workspacePersona,       // default is EMPTY post-rename — we own the persona
    includePartialMessages: true,         // token-level streaming for the transcript
  },
});

for await (const msg of q) {
  switch (msg.type) {
    case "system":        // subtype "init" → session_id
    case "stream_event":  // live tokens + tool_use starts (optimistic UI)
    case "assistant":     // complete blocks — NOTE: nested at msg.message.content
    case "result":        // final text, session_id, subtype success/error
  }
}
```

Key facts (verified against code.claude.com/docs/en/agent-sdk, v0.3.234 Aug 2026):

- `query()` returns an AsyncGenerator **plus control methods**: `interrupt()`,
  `setPermissionMode()`, `setModel()`, `streamInput()`, `close()`.
- For snappy multi-turn chat, use **streaming-input mode** (prompt as an
  `AsyncIterable<SDKUserMessage>`) so one long-lived query drives the whole
  conversation instead of one `query()` per message.
- `tools: []` strips the coding built-ins entirely; add back `Read`/`Grep`/
  `WebSearch` deliberately. The default system prompt is empty since the
  SDK rename — the coder persona is opt-in, so "it's coding-agent-shaped"
  is mostly solved by configuration.
- Assistant content blocks live at `msg.message.content` (nested), a known footgun.

### Auth (the whole point)

- User runs `claude login` **in a real terminal**. The SDK reuses the Claude Code
  CLI's stored OAuth from the macOS Keychain item "Claude Code-credentials".
  **Verified 2026-08-20 — being signed into the Claude *desktop app* is NOT
  sufficient**: the desktop app keeps its live token in its own Electron
  safeStorage vault ("Claude Safe Storage"), leaving "Claude Code-credentials" as
  a stale stub with a zero-length `refreshToken` that cannot self-refresh. On this
  machine that item's token had been expired for 60 days while the desktop app
  worked fine, and every SDK call 401'd.
- **`ANTHROPIC_API_KEY` must be unset** in the spawned env — if present it silently
  flips to metered API billing. The engine explicitly deletes it from the child env
  and surfaces which auth mode is active in the UI (a "subscription / API / none"
  badge), so this is never a silent failure or silent charge.
- Rate limits become the ceiling instead of a bill. **Verified**: `accountInfo()`
  reports this account as **Claude Pro**, not Max — size the quota assumptions to
  Pro. `usage_EXPERIMENTAL_*()` exposes a `rate_limits` field but it returned
  `null` under dead credentials; re-check before building a quota HUD on it.
- OSS posture: each user authenticates **themselves** via the official CLI. The app
  never touches, extracts, or proxies credentials. API-key mode is a supported
  fallback for users who prefer it. See [open-source.md](open-source.md) for the
  ToS analysis behind this design.

### Verified engine configuration (measured 2026-08-20)

Established by capturing the exact request bodies the SDK assembles, against a
local mock Messages API. **Client-side facts are definitive; nothing here was
confirmed against a live server response** (auth was dead — see above).

**The env footgun — this is how "auth is sacred" is actually implemented.**
`Options.env`, when omitted, forwards the **entire `process.env`** to the spawned
CLI verbatim, `ANTHROPIC_API_KEY` included; the SDK's own `.d.ts` says so and
names the key. The engine must therefore always pass an **explicit, whitelisted
env object** — deleting the key from `process.env` is not enough, because
omitting `env` re-inherits whatever the parent had. Scrubbing is proven safe:
auth behaviour was identical scrubbed vs inherited (the credential is the only
variable).

**`tools: []` is load-bearing; `allowedTools: []` is not.** Measured request
bodies for one dispatch turn:

| config | body | tools |
|---|---|---|
| default | **47.4 KB** (~12k tokens) | 11 Claude Code tools |
| `allowedTools: []` | 47.4 KB | still 11 — **no reduction** |
| `tools: []` | **1.76 KB** | 0 |
| `tools: []` + one in-process MCP tool | **2.03 KB** | 1 |

**`Options.title` suppresses a hidden per-turn cost.** Without it the SDK fires an
auxiliary `claude-haiku-4-5-20251001` "session title" inference call on *every*
user turn — a 2x call multiplier against quota. It only fires for prompts ≥10
characters, so every real voice command triggers it. Setting `title` removes it
entirely (verified 2x2: 38-char prompt → 2 requests without, 1 with).

**Haiku defaults to thinking ENABLED** with a 31,999-token budget. For dispatch,
`thinking: {type: 'disabled'}` (or `maxThinkingTokens: 0`) emits
`thinking: {"type":"disabled"}` — the correct low-latency lever.

Resulting dispatch session config:

```ts
{ model: "claude-haiku-4-5", tools: [], skills: [], settingSources: [],
  mcpServers: { summon: surfaceServer },
  thinking: { type: "disabled" },
  title: "summon",                  // suppresses the per-turn aux Haiku call
  env: scrubbedEnv,                 // explicit whitelist — never omit
  systemPrompt: dispatchPrompt }
```

**One long-lived streaming session, pre-warmed at launch.** Local overhead only
(mock server, so no model time): cold spawn-to-wire ~0.5–1.4s, `startup()`
~2.3–3.3s to ready, warm second turn ~20–170ms. Create the session during Electron
boot and push turns into it; never one `query()` per utterance.

**Zero-cost observability**: `accountInfo()`, `supportedModels()`,
`initializationResult()`, `supportedCommands()` all return **before any prompt is
sent** — no inference, no tokens — and work even with expired credentials. This is
the right foundation for the auth-mode badge and a first-run health check.
`supportedModels()` is the authoritative per-model capability table.

**Auth health check**: on first run, open a streaming session and call
`accountInfo()`. Do not wait for a model call to discover a bad credential — a 401
is retried **11 times internally** before surfacing, burning seconds. Show a
"re-run `claude login`" surface instead of a spinner. Also note
`SDKResultSuccess.duration_ms` badly understates real latency (reported 236ms for
a 2,455ms turn) — instrument wall-clock from the push-to-talk keyup.

**In-process MCP tools** (`createSdkMcpServer` + `tool`) reach the wire cleanly as
normal custom tools with `eager_input_streaming` — the surface mechanism works.

**Version note**: the SDK bundles and spawns its **own** 305MB CLI binary
(0.3.237 → CLI 2.1.237), *not* the user's PATH `claude` (2.1.218). Pin
deliberately; `pathToClaudeCodeExecutable` overrides it.

## 2. Surface system — the heart of the app

**Pattern** (borrowed from generative-UI practice — Vercel AI SDK, assistant-ui,
Tambo — adapted to the Agent SDK's in-process tools):

- A **registry** of pre-built surfaces. Each surface = a React component + a Zod
  payload schema + a manifest entry (id, description, where it may render).
- **One tool**, `show_surface`, whose `z.enum` of surface ids IS the allowlist.
  Unknown id → Fallback component, never eval, never dynamic import.
- The tool handler runs **in the host process**, so it can fire the render and
  return an ack to the model in a single step:

```ts
const showSurface = tool(
  "show_surface",
  "Render a native UI panel when the user should SEE something rather than read prose.",
  {
    surfaceId: z.enum(["clog-status", "artifact-viewer", "note-preview", "table", "timer"]),
    payload: z.record(z.any()).describe("Props for the surface; see each surface's schema"),
    placement: z.enum(["popover", "hud"]).default("popover"),
    replacePanelId: z.string().optional(),
  },
  async (args) => {
    const panelId = args.replacePanelId ?? crypto.randomUUID();
    windows.route(args.placement).webContents.send("surface:show", { panelId, ...args });
    return {
      content: [{ type: "text", text: `Rendered ${args.surfaceId} (${panelId}).` }],
      structuredContent: { panelId },
    };
  },
  { annotations: { readOnlyHint: true } }   // pure-UI → parallel-safe
);
```

- Renderer side: a `PanelHost` validates payloads **at the door** with the
  surface's Zod schema, then mounts the component. Results flow back via a
  companion `read_surface_result(panelId)` tool (e.g. user clicks a note in a
  list surface; the agent reads the pick on its next turn).

### Surfaces as the extension point (OSS)

A surface is a folder: `surfaces/<id>/{manifest.ts, Component.tsx, schema.ts}`.
Forkers add capability by dropping in a surface, not by touching the shell.
The registry auto-discovers them at build time; the `show_surface` enum and the
system-prompt catalog regenerate from manifests. "Build your own assistant" =
"write a React component with a schema."

**v1 surface set** (each small, each real):

| id | what it shows | placement |
|---|---|---|
| `clog-status` | scraped summary of status.claude.com (the author's original ask) | HUD bar |
| `artifact-viewer` | agent-produced HTML/markdown/charts, sandboxed inline | popover |
| `note-preview` | a vault note, rendered, with backlinks | popover |
| `table` | generic tabular data | popover |
| `timer` | countdown the agent can set | HUD |
| `sticky-note` | a post-it the agent pins anywhere on screen for an output message — small, draggable, dismissible; can persist across summons | desktop-anchored |

Data acquisition (e.g. the status scrape) lives in **data tools**
(`mcp__data__scrape_status`), not in surfaces — surfaces render, tools fetch.
That separation is what makes both sides independently forkable.

## 3. Shell — Electron mechanics

- **Tray popover**: `menubar` npm package (Tray + positioning + focus-lost
  auto-hide, `preloadWindow: true` for instant pop). Manual fallback:
  `electron-traywindow-positioner` (handles the multi-monitor `Tray.getBounds()`
  bugs, electron#13461).
- **HUD panels** (the "bar that pops out of the top"): persistent hidden
  `BrowserWindow` with `{frame:false, transparent:true, alwaysOnTop:true,
  hasShadow:false, focusable:false, skipTaskbar:true}`, elevated via
  `setAlwaysOnTop(true, "screen-saver")`, visible over fullscreen apps via
  `setVisibleOnAllWorkspaces(true, {visibleOnFullScreen:true})`, shown with
  `showInactive()` so it never steals focus. Slide-in animated in CSS;
  click-through via `setIgnoreMouseEvents(true, {forward:true})` with
  per-hotspot re-enable (macOS-supported pattern). Transparent windows are
  fixed-size on macOS — design HUDs accordingly.
- **Inline artifacts**: `WebContentsView` (the supported successor to
  BrowserView; **never** `<webview>` — Electron warns against it) with
  `sandbox:true, contextIsolation:true, nodeIntegration:false`, a strict CSP,
  `setWindowOpenHandler(() => ({action:"deny"}))`, and `will-navigate`
  interception. Tool-returned / scraped HTML is treated as **untrusted data**;
  trusted self-generated markdown may use a sandboxed `<iframe srcdoc>` as the
  lighter path.
- **Hardening baseline**: `session.setPermissionRequestHandler(deny)` globally;
  minimal `contextBridge` API in preloads; no `shell.openExternal` except on
  explicit user gesture.

## 4. Sessions — organized your way

This is where owning the client pays off. The desktop app's flat "Recents" list is
a documented pain point (anthropics/claude-code #22617 et al.). The SDK exposes
everything needed to replace it:

| primitive | use |
|---|---|
| `options.cwd` | sessions namespace by working directory → **workspaces** |
| `resume` / `continue` | persistent threads / most-recent-in-cwd |
| `forkSession` | branch a thread without destroying it |
| `persistSession: false` | ephemeral one-shot task threads |
| `listSessions({dir})`, `getSessionInfo`, `renameSession`, `tagSession` | build the organizer UI |

**The model**: a *workspace* = a working directory. For the author that maps 1:1 onto
PARA vault dirs (`Projects/Harbor`, `Areas/Career`, …) — each workspace gets its
own per-context system prompt (or the dir's own CLAUDE.md), a **persistent
"assistant" thread** (long-lived resume id), and cheap **ephemeral task threads**
(fork / non-persisted). The sidebar organizer is built from `listSessions` +
rename/tag, plus a small sidecar index of our own (pins, per-workspace surface
defaults). For everyone else: workspaces are just folders they pick — the same
mechanic with zero vault assumptions baked in.

## 5. Voice — push-to-talk, all on-device

Measured on this machine (M1, 16GB): whisper.cpp 1.9.1 is already installed via
brew with the Metal backend working, `ggml-small.en` (465MB) already downloaded;
a 4.1s spoken command transcribes in **~0.95s warm / ~1.5s cold**, accurately.
So voice is local, private, and free — important given vault data sensitivity.

- **v1 (zero new deps)**: `globalShortcut` tap-to-toggle (Electron cannot see
  keyup globally — electron#26301, so hold-to-talk is impossible with stock
  APIs). Press → hidden renderer records via `getUserMedia` + `MediaRecorder`;
  press again (or ~1.2s silence) → ffmpeg (installed) converts to 16kHz wav →
  spawn `whisper-cli -m small.en -nt --prompt "<proper-noun seed>"` → text →
  engine. Seed `--prompt` with the user's proper nouns (workspace names) to fix
  name recognition.
- **v2**: true hold-to-talk via `uiohook-napi` (native keyDown/keyUp hook;
  needs electron-rebuild + Accessibility permission) and a warm transcriber
  (`whisper-server` kept resident, or the `smart-whisper` binding) to shave the
  ~200ms per-call model reload.
- **Non-paths, verified**: Chromium's Web Speech API is effectively broken in
  Electron (no Google key). macOS system Dictation types into any field but
  can't act as a global agent trigger. Wake word (Porcupine + custom "Claude"
  .ppn) is feasible but always-on-mic + account dependency — not worth it for
  push-to-talk ergonomics; revisit only if hands-free becomes a hard need.

## 6. Process/IPC map

```
Electron main ──────────────────────────────────────────────
  engine.ts        query() loop, streaming, session registry
  tools/ui.ts      show_surface, read_surface_result
  tools/data.ts    scrape_status, read_vault, ... (fetchers)
  windows.ts       popover, HUD pool, WebContentsView factory
  voice.ts         hotkey, recorder orchestration, whisper spawn
      │  typed IPC (contextBridge, validated payloads)
Renderer(s) ────────────────────────────────────────────────
  popover:  Transcript · PanelHost · workspace/thread sidebar
  hud:      PanelHost (HUD-placement surfaces only)
  recorder: hidden getUserMedia window
```

Streamed `tool_use` events drive *optimistic* UI (spinner: "summoning
clog-status…"); the in-process handler remains the source of truth for the
actual render. Every boundary (tool → IPC → panel) validates with the same Zod
schema, so a malformed payload dies at the door, not in a component.
