# Summon

A local context and control plane for a multi-agent workstation on macOS. Summon keeps your working context (the project you are in, what arrived, where it went), shows your Claude, Codex, Cursor and Hermes agent sessions on one board with hooks that report their state, groups unfinished git work into plain-language workstreams, meters how much of your Claude and Codex plans is used, starts new agent sessions in the right folder, and shares all of it, plus explicit memory over your notes vault, with Claude Code and Codex through MCP. Everything runs on your Mac, reads only the metadata it names, and uses the CLIs you already installed and signed into. The current version is in `package.json`.

The command bar handles familiar requests directly: “find my Excel files,” “open my calendar,” “working on Studio,” and “best coding model.” Choose a file to see where it arrived, its current known location, and why it belongs to a workspace.

## What works today

- Recent-file search, Open and Show in Finder, workspace selection, and correcting file context.
- Read-only integration with an existing Automatic Filing installation's configuration and move journal. Summon records its receipts; it does not move files or change filing rules.
- Active-app changes, with optional focused-window titles and document paths through macOS Accessibility.
- A menu-bar star that lights green while the microphone is on, with per-session listening controls in its menu.
- Local voice commands through Whisper, plus an optional dedicated offline “Summon” keyword detector. The microphone starts off.
- Calendar access and requested AI Stupid Level rankings, with a local one-hour cache.
- Optional **Ask Claude** and **Ask Codex** buttons for questions requiring reasoning, using installed CLIs and their existing sign-ins.
- Explicit saved facts, sourced project-note search over a notes vault (a workspace named Second Brain), and reusable named command routines.
- Optional local command interpretation through an installed Ollama model, with a review step before execution.
- An MCP server so both clients can read the same working context, file history, and memory.
- **Work in flight**: a read-only view of unfinished work across your git projects (unsaved changes grouped into plain-language workstreams, commits not shared, open branches, set-aside changes), in the workbench, through `npm run flight`, and for connected agents. Grouping calls Codex or Claude only when you ask. See [Work in flight](docs/desktop-companion.md#work-in-flight).
- **Agent sessions**: one read-only board of your Claude, Codex, Cursor and Hermes sessions that need you, have a new reply, or are still working, each with a button that opens that exact session. Open it with **⌘E** in the workbench, `npm run -s sessions`, or the `agent_sessions` MCP tool. A small count in the menu bar says how many sessions are waiting on you without opening anything. It reads session details only (never conversations), with no AI and no network. **Start Claude here** and **Start Codex here** open a session in Terminal for the selected workspace, and sessions started that way report their state through hooks; Summon keeps only ids, folders, state words and times of those reports in `hook-events.json`, never prompt or transcript text. See [Agent sessions](docs/desktop-companion.md#agent-sessions).
- **Where this stands**: one paragraph at the top of Work in flight saying what changed since the last time you looked, counted against a mark you set by looking rather than by opening the panel, a short list of work that has stopped, and session rows that lead with the project and the piece of work instead of the app's own title. No AI and no network. See [Where this stands](docs/desktop-companion.md#where-this-stands).
- **Usage**: how much of your Claude and Codex plans is used, as each CLI reports about itself through one bounded, tool-less call (no prompt, no turn, no token read), checked every five minutes, shown in the menu bar and Preferences, and used by **Ask Auto** and the `pick_engine` MCP tool to route by remaining quota. See [Usage](docs/desktop-companion.md#usage).
- **Visual workspace**: connected views of local commit history, observed code imports, explicit goals and milestones, an animated 3D agent kitchen across projects, and reported hook events. The kitchen opens on All projects, with optional project filters. Open **Visual workspace** in the title bar or press **⌘⇧V** outside a text field. Everything stays local; goals are entered explicitly, and event coverage depends on each provider's hooks. See [Visual workspace](docs/desktop-companion.md#visual-workspace).

This version does not record the screen, capture keystrokes, index arbitrary document contents, or monitor browser history. See [scope, setup, and limitations](docs/desktop-companion.md).

## Run locally

Requires macOS, Xcode Command Line Tools, and Node.js 22.12 or newer. Building the speech worker needs the Homebrew `whisper-cpp` and `ggml` libraries; the local build uses whisper.cpp 1.9.1. Voice needs those runtime libraries and a local Whisper `.bin` model. The file ledger works without voice or an AI login. Summon keeps the speech model ready during a listening session and releases it after listening has been off for about a minute. Current microphone audio stays in memory; no `ffmpeg` conversion is needed.

From this repository:

```sh
npm install
node "node_modules/electron/install.js"
npm run build
npm run start
```

The explicit Electron install command downloads the runtime required by the pinned Electron package. If `npm install` has finished but Electron cannot be found, run that command before starting or packaging.

For development after the initial build:

```sh
npm run dev
```

This starts Vite and Electron together. A regular browser displays a labeled sample preview; native actions require Electron.

To produce a locally ad-hoc-signed application bundle for the current Mac architecture:

```sh
npm run package
```

The bundle is written under `release/`. Packaging does not install it, register MCP clients, or add a login item.

## First use

1. Use **Add workspace** to choose project folders, then select what you are working on.
2. Download a file into Downloads or Desktop and follow its receipt in the ledger.
3. Open **Preferences** for optional window context, microphone/model setup, your calendar URL, exclusions, retention, and an AI Stupid Level data key.

Choose **Start hands-free listening** from the menu-bar star to listen for “Summon”, and **Stop listening** to turn it off. The star lights green while the microphone is active and returns to monochrome when it is off. Speech appears in the workbench for review and optional Ask Claude/Codex.

**⌘⇧J** opens Summon. **⌘K** focuses the command bar. **⌘⇧Space** toggles a voice command, and so does a plain **Fn** tap once Input Monitoring is allowed for Summon (see [Menu bar and shortcuts](docs/desktop-companion.md#menu-bar-and-shortcuts)). Closing the window leaves the app running in the menu bar; **Quit Summon** stops it.

## Connect Claude Code and Codex

With this repository as the current directory:

```sh
claude mcp add --scope user summon -- node "$PWD/scripts/mcp-server.mjs"
codex mcp add summon -- node "$PWD/scripts/mcp-server.mjs"
```

These are setup commands to run deliberately; installing or starting Summon does not run them. Keep Summon running, then reload the client so it can discover the tools. Use an absolute Node executable path if the client cannot resolve `node`. See [MCP tool scope and troubleshooting](docs/desktop-companion.md#shared-context-through-mcp).

## Development checks

```sh
npm run typecheck
npm test
node "native/check.mjs"
```

Local records and personal workspace configuration live outside the repository, normally in `~/Library/Application Support/Summon/`. **Preferences → Show data folder** opens the actual location.

## Acknowledgements

The animated kitchen uses [Agenttrail](https://github.com/sodiumsun/agenttrail)'s procedural chef models, art and animation (Kelly Sun, MIT), rendered locally with Three.js. See [third-party notices](docs/third-party.md).

Summon ran the Hermes desktop assistant (Nous Research, MIT) as its voice and execution shell for a week in September 2026. The Fn shortcut came out of that experiment and is now built into Summon; the approvals posture for a Summon-hosted Codex thread and the shape of a spoken conversation loop are being rebuilt from it (see `docs/migration-plan.md`). No Hermes code is included today; any file ported later carries its MIT notice. The read-only Hermes row in Agent sessions observes Hermes the way it observes any other agent app.

## Not affiliated

Summon works with the Claude Code and Codex CLIs that you install and sign into yourself. It never handles, stores or transmits your credentials; all authentication is performed by those vendors' own software, and subscription use of a CLI through a third-party client is governed by each vendor's terms (see `docs/open-source.md`), which you should check yourself. Summon is an independent project, not affiliated with or endorsed by Anthropic, OpenAI or Nous Research. Claude, Codex, Cursor, Hermes and other product names are trademarks of their respective owners and appear here only to say which tools Summon works with.

[Current implementation](docs/desktop-companion.md) · [Decisions](docs/decisions.md) · [Earlier SDK architecture proposal](docs/architecture.md)
