# Build plan

> **Current implementation:** The local desktop companion is built; setup and scope are in [Desktop companion](desktop-companion.md). The SDK-first phases below remain an earlier future-work proposal. Their “done when” commands and features should not be treated as current functionality.

Phased so every phase ends with something the author can run. Claude builds, the author
steers — each phase ends with a "steer checkpoint": what to try, what taste
decisions are open.

## Phase 0 — Engine proof (no UI)
Scaffold `electron-vite` + React + TS (crib structure from
`vanzan01/claude-agent-sdk-starter`, but ours is assistant-shaped, not IDE-shaped).
A bare script drives one `query()` on subscription auth and streams text to
stdout; proves auth mode detection (subscription vs API vs none) and that
`ANTHROPIC_API_KEY` stripping works.
- **Done when**: `npm run engine-check` prints a streamed Claude reply + "auth: subscription".
- **Steer**: none — mechanical.

## Phase 1 — Menubar chat
`menubar` tray popover with transcript + input box; streaming-input mode (one
long-lived query per thread); token-level streaming into the transcript;
`tools: []` + our system prompt (assistant persona, not coder).
- **Done when**: click menubar icon, type, watch Claude stream back. Feels fast.
- **Steer**: popover size/feel, persona voice, light/dark.

## Phase 2 — Surface system + the first two surfaces
The registry, `show_surface` + `read_surface_result`, PanelHost with Zod
validation + Fallback, HUD window pool. Ship:
1. **`clog-status`** (the original ask): `mcp__data__scrape_status` fetches
   status.claude.com summary; HUD bar slides from the top, auto-dismisses,
   click-through except its hotspots.
2. **`artifact-viewer`**: sandboxed inline rendering (WebContentsView; strict
   CSP; no browser escape).
- **Done when**: "pull up the claude status" (typed) → bar pops with a real
  scraped summary; "make me a chart of X" → renders inline.
- **Steer**: HUD placement/animation taste; which surfaces come next.

## Phase 3 — Voice
Tap-to-toggle global hotkey → record → ffmpeg → `whisper-cli` (small.en,
`--prompt` seeded with workspace proper nouns) → engine. Recording indicator on
the HUD. Mic permission flow.
- **Done when**: hotkey, say "pull up the claude status", bar appears. Round-trip
  voice→panel under ~4s.
- **Steer**: hotkey choice; whether hold-to-talk (uiohook-napi) is worth the
  Accessibility-permission ask now or later.

## Phase 4 — Sessions, organized your way
Workspaces (= cwd) with per-workspace system prompt; persistent assistant thread
+ ephemeral task threads (fork / persistSession:false); sidebar organizer via
`listSessions`/`renameSession`/`tagSession` + sidecar index (pins, defaults).
For the author: workspaces mapped to vault PARA dirs; for the OSS repo: plain folder
picker, no vault assumptions.
- **Done when**: two workspaces with independent threads; kill the app, reopen,
  resume both mid-conversation.
- **Steer**: the organization model itself — this phase exists because the
  desktop app's model doesn't fit you. Sketch what you want before we build.

## Phase 5 — Open-source packaging
Rename (drop the working name if keeping it public), LICENSE, README framed for
forkers ("bring your own subscription via `claude login`; here's how to write a
surface in 20 lines"), `docs/writing-a-surface.md`, example `.env`, unsigned
`.app` build docs (`electron-builder --mac --dir`, right-click-open), CI lint.
ToS-compliance framing per [open-source.md](open-source.md).
- **Done when**: a stranger can clone → `claude login` → `npm start` → summon a
  surface, and add their own surface without touching the shell.
- **Steer**: name, README voice, what personal surfaces stay out of the public repo.

## Phase 6 — Polish backlog (pull, don't schedule)
Hold-to-talk (uiohook-napi); warm `whisper-server`; more surfaces (`note-preview`,
`table`, `timer`, vault-search); optimistic "summoning…" shimmer from streamed
tool_use events; per-workspace surface defaults; TTS read-back (`say` or the
gloss pipeline); Sparkle-style auto-update if it ever ships beyond one machine.

## Standing risks
- **SDK velocity**: weekly releases; SDK version pins a bundled CLI. Pin +
  changelog check before upgrades ([decisions.md](decisions.md)).
- **Auth policy drift**: Anthropic could tighten subscription-auth behavior at
  any time; the app degrades to API-key mode, never breaks silently.
- **Rate limits**: heavy agentic loops burn Max caps — the engine should show
  remaining-window state rather than let a session die mysteriously.
