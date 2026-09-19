# Open-source viability, ToS, naming, license

Researched 2026-08-18 against Anthropic's live pages + the full 2025–26
enforcement record. Policy here flip-flopped three times in eight months —
re-verify the live pages before the public launch (Phase 5).

## Verdict

- **Personal app: safe.** You, on your machine, spawning the official CLI/Agent
  SDK under your own Max login is "ordinary, individual usage of Claude Code and
  the Agent SDK" (legal-and-compliance page), and the help center confirms
  third-party app usage draws from subscription limits "for now" (June 16, 2026
  pause note). No enforcement has ever hit this pattern.
- **OSS repo: publishable with honest framing — moderate, manageable risk.**
  Frame it as *a client for your existing, already-authenticated Claude Code
  installation* — never as an app you "sign into with your Claude account."
  Each user runs it locally under their own login. No hosted service, no
  self-implemented OAuth, no bundled/automated login, ever.

## The bright line (what the enforcement record actually shows)

Every ban/block 2025–26 hit one of two things:

1. **Token extraction** — tools that pulled the OAuth token out of the official
   harness and called the API themselves, spoofed the Claude Code client, or
   embedded Anthropic's OAuth client ID (opencode bans Jan 2026 + legal request;
   Feb 2026 docs tightening; Apr 2026 billing cutoff of OpenClaw et al.).
2. **Trademarks** — names/marketing too close to Claude (Clawdbot C&D Jan 27,
   2026 — even "Clawd" was too close; forced rename chain to OpenClaw).

**Zero enforcement** against apps that spawn the official harness and let it own
auth: opcode (13k+ stars) operates untouched; Zed was later *named by Anthropic*
as a supported third-party category (May 2026 Agent SDK credits announcement,
which explicitly listed "third-party apps that authenticate with your Claude
subscription through the Agent SDK" as a sanctioned category before the June
pause). The spawning-vs-extraction distinction is strongly supported by the
record and by Anthropic's own May framework — but it has never been stated as a
bright-line rule in the ToS itself. Honest reading of the tension: the dev docs
say "use API keys unless previously approved" while the consumer help center
acknowledges subscription-drawing third-party apps "for now." A future re-split
most likely changes the *economics* (metered credits), not the legality; a hard
reversal can't be ruled out.

## Design rules that keep us on the right side (already in the architecture)

1. **Never touch credentials.** Don't read `~/.claude/.credentials.json` or the
   Keychain, don't embed the OAuth client ID, don't mint/refresh/store tokens,
   don't ship a "login" button. At most, run `claude` and let its own login flow
   appear. This single line separates every banned project from every tolerated
   one.
2. **First-class API-key mode** alongside subscription mode — the only mode
   Anthropic unambiguously blesses for third-party developers, and the
   future-proofing if billing re-splits.
3. **Ordinary, individual workloads**: no multi-user daemon, serve only the
   logged-in user, human-triggered/bursty (24/7 agent loops can trip abuse
   heuristics), sane limits on background jobs.
4. **Own branding, no harness spoofing**: no Claude Code mimicry (ASCII art,
   visuals), no user-agent games.
5. **Auth mode visible in-app** + link to Anthropic's policy page — the
   informed-choice pattern (OpenClaw's "user-choice risk" framing).

## Naming & trademark

- **No "Claude"/"Clawd"/"Claude Code" in the product name.** Clawdbot's C&D
  proves sound-alikes count. "summon" (working name) is clean on this axis;
  check general namespace collisions before launch (CyberArk `summon` exists).
- Officially sanctioned patterns (Agent SDK branding guidelines):
  **"{Name} — Powered by Claude"** as tagline; nominative references ("built on
  the Claude Agent SDK") in the README; "Claude Agent" inside menus. Product
  must maintain its own identity and "not appear to be Claude Code or any
  Anthropic product."
- Battle-tested disclaimer (opcode's, adapt verbatim): *"Not affiliated with,
  endorsed by, or sponsored by Anthropic. Claude is a trademark of Anthropic,
  PBC. This is an independent developer project using Claude."*

## README framing checklist (Phase 5)

- [ ] Original name + "Powered by Claude" tagline; non-affiliation disclaimer
- [ ] "Requires the official Claude Code CLI, installed and authenticated with
      **your own** Claude account or an Anthropic API key. This app never
      handles, stores, or transmits your credentials — all authentication is
      performed by Anthropic's official software."
- [ ] Short "Terms" note: subscription use of the Agent SDK is governed by
      Anthropic's terms, which changed several times in 2026 (link the
      [legal page](https://code.claude.com/docs/en/legal-and-compliance) and
      [help-center article](https://support.claude.com/en/articles/15036540));
      users verify current policy; API-key mode is the unambiguous path.
- [ ] Extension-first framing: "write a surface in 20 lines," good-first-issues
      for new surfaces, no personal config in the repo.

## License

**Apache-2.0.** Explicit patent grant protects redistributors/extenders; §6
explicitly grants no trademark rights (reinforces the Claude-trademark
disclaimer); clean contribution terms. MIT would be acceptable; AGPL (opcode's
choice) would discourage the casual fork-and-extend adoption this repo exists
to invite.

## Key sources

- https://code.claude.com/docs/en/legal-and-compliance (live 2026-08-18)
- https://code.claude.com/docs/en/sdk/sdk-overview (incl. branding guidelines)
- https://support.claude.com/en/articles/15036540 (June 16, 2026 pause note)
- https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access/
- https://www.theregister.com/2026/04/06/anthropic_closes_door_on_subscription/
- https://zed.dev/blog/anthropic-subscription-changes
- https://github.com/winfunc/opcode · https://docs.openclaw.ai/concepts/oauth
- https://www.anthropic.com/legal/trademark-guidelines
