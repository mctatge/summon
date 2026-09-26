# Routing research — context routing + model/effort selection

Verified 2026-08-20. Findings survived an adversarial review pass; corrections
from that pass are folded in below. Claims are marked where they remain
contested or unmeasured. **Read the caveats — several widely-quoted numbers in
this space are misattributed or measured under conditions that don't transfer.**

Two separate problems with very different evidence bases:
- **(A) context routing** — which workspace/thread does this utterance belong to
- **(B) model + effort routing** — which model and reasoning effort to spend

Treat them separately. (A) is well-supported and cheap. (B) is weakly supported
and the literature's objective (dollars) does not transfer to subscription auth.

---

## 1. (A) Context routing — local embeddings, measured on this M1

**Verdict: build it. It is effectively free.** All numbers below were measured on
the test machine (M1/16GB, Node v25.2.1, onnxruntime-node 1.24.3, all-MiniLM-L6-v2 int8).

| quantity | measured |
|---|---|
| warm embed, 6-word utterance | **p50 1.7–2.5 ms**, p90 ~5 ms, p99 ~13 ms |
| main-thread event-loop stall (single embed) | p50 2.3 ms, max 4.5 ms — under one 60fps frame |
| cold load (bundled, offline) | ~160 ms lean path / 462 ms transformers.js |
| resident cost | +90 MB RSS (int8), 0.45% of one core idle |
| cosine kNN over 2,000 × 384-d vectors (pure JS) | 1.18 ms |
| accuracy, 4–20 classes, 5–10 examples each | **97–99.8%** (centroid) |

Against a 3–4s dispatch budget (and whisper's ~950 ms), the router is ~0.1%.
Latency is not the constraint; **out-of-scope handling is** (see §1.3).

### 1.1 Recommended stack

- **onnxruntime-node + `@huggingface/tokenizers` directly**, not transformers.js.
  Bit-equivalent output (cosine 1.000000), ~3x faster cold start, and it avoids
  two large dependencies:
  - `sharp` is a **hard, eager, non-optional** dependency of transformers.js v4
    even for text-only feature extraction (verified: unconditional
    `require("sharp")` in the shipped CJS bundle) — drags in libvips, 16 MB, and
    a second Mach-O to sign/notarize.
  - `onnxruntime-web` (131 MB) is never loaded on the Node path — exclude it.
- **Model**: all-MiniLM-L6-v2 **int8** (`model_quantized.onnx`, 23 MB), bundled,
  `allowRemoteModels=false`. Never fetch at runtime (latency + vault privacy).
  fp32 costs ~2x latency and ~2.3x memory for no measured gain here. bge-small /
  gte-small are 2–4x slower for no benefit at this class count.
- **Session config**: `intraOpNumThreads: 2`. ORT's default costs ~2.4x on p99.
  (Note: `interOp: 1` was recommended but never benchmarked — sweep it.)
- **Load once at startup, keep resident.** Do not lazy-load per utterance.
- No native rebuild needed: onnxruntime-node is N-API v6, prebuilt darwin-arm64.

### 1.2 Classifier: centroids, not kNN

Class-centroid matching beat kNN-1 by **7.6 points** at 10 shots (CLINC150, 150
classes: centroid 89.1 vs kNN-1 81.6) and is *cheaper* at query time. A logistic
head adds only +1.5 — keep as an upgrade path once real labeled traffic exists.

**Both lookups from one embedding works, but implement them differently**:
workspace = nearest centroid; model tier = a **learned direction** (probe or
centroid pair), never a kNN over a bank mixing both labels. Topic dominates the
geometry — same-topic/different-tier pairs sit at cosine 0.263 vs
same-tier/different-topic at 0.144, so a kNN would return topic-neighbors and
inherit their tier at random. A tier probe trained on 8 topics generalized to 4
held-out topics at 97.5%.

### 1.3 The real weak spot: out-of-scope rejection

A similarity threshold tuned for 95% in-scope recall rejected only ~68–78% of
out-of-scope utterances — **and those numbers are an optimistic ceiling**: the
threshold was fit on the test set's own distribution (oracle) and measured on
kNN-1 rather than the recommended centroids. Real OOS performance is **unmeasured
and will be worse**. Design for it explicitly:
- similarity floor → fall through to the LLM (or ask) below it
- make the routing decision **visible and correctable** in the HUD
- log every low-margin decision as a candidate labeled example

Bias the threshold toward escalation: a wrong workspace on "pull up Word" is
cheap; a real writing task sent to a low-effort tier is the expensive failure.

### 1.4 Packaging (electron-builder)

`asarUnpack: ["**/*.node", "**/libonnxruntime*.dylib"]`; `hardenedRuntime: true`;
an `afterSign` hook that Developer-ID-signs **both** `onnxruntime_binding.node`
and `libonnxruntime.*.dylib`. Both ship **ad-hoc/linker-signed** and the `.node`
resolves the dylib via `@rpath` — signing only one fails notarization or crashes
at load. Add `files: ["!**/onnxruntime-web/**"]`.

**Rejected**: Ollama embeddings (p50 59 ms, 20–35x slower, daemon dependency);
fastembed-js (pins ORT 1.21.0 → duplicate native module, ships `tar@^6` with a
critical advisory); node-llama-cpp (main-process-only, unpacked-binary
complexity, GGUF/Metal value wasted on a 6-layer model). Keyword/proper-noun
matching is worth keeping as a cheap high-precision *pre*-filter (it shares the
whisper `--prompt` seed list) but cannot handle paraphrase.

---

## 2. (B) Model/effort routing — weak evidence, different objective

### 2.1 Why the cost literature doesn't transfer

Every headline number in the routing literature (FrugalGPT's "98% cost
reduction", RouteLLM's CPT, RouterBench's AIQ) optimizes **dollars**. Under
subscription auth there is no per-token dollar cost. summon's transferable
objective is **latency and quota consumption**. Most cited wins simply don't apply.

Also: routing gains scale with **workload entropy**, and summon's dominant
traffic (short dispatch to one tool from a small allowlist) is very low-entropy.
Oracle uplift there is small by construction.

### 2.2 Route effort, not model

The closest peer-reviewed analogue is the vLLM semantic router (NeurIPS 2025):
routing *reasoning on/off* gave **+10.2 pp on MMLU-Pro with 47.1% lower latency
and 48.5% fewer tokens**. Gains were uneven by domain (>20 pts in
knowledge-intensive, weak in engineering/CS) — which is itself the argument for
a per-task-class table rather than a global setting.

**CORRECTED 2026-08-20 by measurement** — the earlier statement here (that
`low`/`medium`/`high` work on Haiku 4.5) was wrong:

- **Effort is a total silent no-op on claude-haiku-4-5.** Not an error — a
  *byte-identical* request body whether effort is omitted, `low`, or `max`, via
  both `Options.effort` and per-turn `applyFlagSettings`. `supportedModels()`
  confirms Haiku 4.5 carries no `supportsEffort` key at all, while sonnet-5 /
  opus-5 / fable-5 all carry `["low","medium","high","xhigh","max"]`.
- **Per-turn effort DOES exist in the SDK** (contradicting the docs):
  `query.applyFlagSettings({ effortLevel })` changes `output_config.effort` on the
  very next turn of a live streaming session, all five levels, no restart needed.
  Server-side *acceptance* is unproven.
- Sonnet 5 defaults to effort `high` — set `low` explicitly for anything
  latency-sensitive.

**So the tiering axis is not "effort on one model."** It is: Haiku 4.5 with
thinking disabled for dispatch (effort is meaningless there), and Sonnet 5 with an
explicit `effortLevel` for the reasoning minority.

The claimed disabled-thinking tool-call leak (model writes a tool call as visible
text) was **not found in the docs and never tested live** — auth was dead. Still
open; a handful of trials could not prove absence anyway.

### 2.3 Building the policy table

The formulation **"cheapest configuration that clears a per-task-class quality
bar"** is correct and is already the established methodology, not a novel idea —
it is literally RouteLLM's CPT metric, RouterBench's cost-quality convex hull,
and OmniRouter's constrained optimization.

**Do not derive the table from public benchmarks.** Rank inversions on narrow
domains are documented (DomainCodeBench: models ranked 4th on HumanEval lead in
most application domains), and no published study covers short tool-dispatch
utterances against a small allowlist — **summon's regime is unstudied**.

Instead: capture **100–300 real utterances** from actual traffic, label each with
the correct tool call + surface + workspace, sweep the grid
`{Haiku 4.5, Sonnet 5, Opus 5} × {low, medium, high}`, and record exact-tool-match
rate and p50/p95 latency per task class. Pick the cheapest cell clearing the bar.
Re-run on every model release. For dispatch the bar should be **high and
unforgiving** (≥98% exact tool match) — a wrong tool call in a menubar assistant
is a visible, trust-destroying failure, not a slightly worse paragraph.

### 2.4 Don't make the router an LLM call

Routers with an API dependency were the measured latency outliers in RouterArena
while others stayed sub-100ms. An LLM-as-classifier hop is ~300–800 ms — 10–25%
of the entire budget, spent *before* the real work starts. The local embedding
router (§1) is ~2 ms and consumes no quota.

---

## 3. Why cascades lose here (and what's contested)

**The decisive argument is latency tail, not model capability.** Every escalated
request pays *both* models: cascade latency on the escalated fraction is always
`L_small + L_verify + L_large > L_large`. Against a 3–4s perceived budget, an
escalation rate above roughly 5% wrecks p95 even when mean latency looks fine.
Cascades are a batch/cost optimization; summon's constraint is interactive tail
latency. **Use predictive routing on the voice path**; reserve cascade behavior
for background/async work. (The break-even arithmetic is a derivation, not a
quoted result, but the cascade cost model behind it is standard.)

Supporting arguments, in descending confidence:

- **Schema validity is a bad correctness proxy.** "The Constraint Tax"
  (arXiv:2605.26128): a calendar tool-call task stayed **100% schema-valid while
  executable accuracy fell 91.5% → 48.0%**. "Confidently calls the wrong tool" is
  a named, taxonomized failure mode (PA-Tool, arXiv:2510.07248) whose dominant
  sub-type is generating a plausible tool name from pretraining conventions
  rather than your schema. **This kills the "structural gate" version of a
  cascade**, which was the obvious repair.
- **No logprobs on the Anthropic API.** The best-validated cheap escalation
  signal — action-level perplexity/entropy, which powers ~15%-escalation cascades
  at near-large-model quality (ReDAct) — is unavailable. Verified: zero hits for
  `logprob`/`top_logprob` across the entire bundled API reference.
- **Intrinsic self-correction doesn't work.** Asking a model to re-check itself
  without external feedback degrades performance (Huang et al., ICLR 2024,
  arXiv:2310.01798; FlipFlop, arXiv:2311.08596). "Ask it if it's sure" is refuted.
- **Self-consistency is weak and errors are correlated.** ρ(consistency,
  correctness) only 0.20–0.59; at consistency ≥0.8 answers were still wrong 48%
  of the time; a cross-model audit found Claude Opus/Sonnet/Haiku **shared wrong
  answers 67–71%** of the time — so a second opinion from a sibling model is not
  independent.

### 3.1 CONTESTED — do not write "small models can't self-assess" into decisions

The claim that verbalized self-confidence is worthless is well-supported for
**small open-weight base models** (0.5B–3B) — but Tian et al. (EMNLP 2023,
arXiv:2305.14975, "Just Ask for Calibration") found that for **RLHF-tuned models,
explicitly including Claude**, verbalized confidence is *better* calibrated than
the model's own conditional probabilities, cutting ECE by ~50%. That is the model
class summon would actually deploy. Nobody has measured Haiku 4.5. ~200 logged
utterances would settle it. **Measure before deleting this from the design.**

Note the distinction that makes both true: *eliciting a confidence number on the
first pass* (possibly fine) is a different operation from *challenging an answer
on a second pass* (well-refuted).

### 3.2 The Advisor tool — a first-party escalation primitive

Anthropic ships `advisor_20260301` (beta): a cheap **executor** model paired with
a high-intelligence **advisor** consulted **mid-generation, server-side**, with
`max_uses`/`max_tokens` caps. The valid-pairs table lists `claude-haiku-4-5` as
executor with `claude-opus-5` / `claude-fable-5` as advisor. Because the consult
is server-side, the "cascade costs a full client round trip" objection does not
apply to it.

**Measured 2026-08-20 — the client side is settled, the server side is not.**
`Options.settings: { advisorModel: "claude-opus-5" }` with a Haiku executor emits a
real server-tool block in `tools[]`:

```json
{ "type": "advisor_20260301", "name": "advisor", "model": "claude-opus-5" }
```

and the required beta (`advisor-tool-2026-03-01`) is already in the SDK's default
header. So it is **reachable from the SDK**. But: no live call ever succeeded, so
**server acceptance under subscription auth is still unproven**, and published
executor/advisor pairing tables disagree with each other. Claude Code also gates it
behind a *fetched feature flag*, which the mock could not exercise.

Three costs that are settled: it adds ~2.1KB of prefix; it injects a `# Advisor
Tool` prose section into a **cached** system block (so toggling it mid-session
dirties the cache — decide per session, not per turn); and **its wall-clock cost
is completely unknown**, with the executor's stream pausing during a consult.

**Treat it as incompatible with the 3–4s dispatch path until someone measures a
consult.** (c) still stands regardless: *the executor decides when to consult*,
which is the self-assessment whose reliability is contested in §3.1.

---

## 4. Security: routers are adversarially manipulable

A query-independent "confounder gadget" prefix drove upgrade-to-strong-model
rates to **100%** for similarity, matrix-factorization, and BERT routers (from
58–81%), and caused up to **8x cost increases** on commercial routers
(arXiv:2501.01818). For summon the analogous damage is **quota burn and
unpredictable latency**, triggered by content the project already classifies as
untrusted.

**Rule: the router is keyed strictly on the user's own utterance. Tool-returned
or scraped content never reaches the router's input.** This is a direct extension
of the existing untrusted-content rule in CLAUDE.md.

---

## 5. Corrections worth knowing (widely-quoted numbers that are wrong)

- **RouteLLM's "85% cheaper at 95% of GPT-4"** is the v1/blog number and is
  MT-Bench-specific. The current paper reports cost-saving *ratios at the quality
  actually reached*: MT Bench 3.66x at 95%, **MMLU 1.41x at 92%, GSM8K 1.49x at
  87%** — on reasoning tasks the cost win *and* the quality win degrade together.
- **"Routers are near-chance (AUC ~50)"** is a **metric misreading** — that AUC
  is normalized area under a cost-performance convex hull (max 100), not ROC-AUC.
  The correct reading of the narrow 50.18–53.14 spread is: *the marginal return
  from a more sophisticated router architecture is small*, i.e. if a simple router
  doesn't work a complex one probably won't either. It says nothing about whether
  routing signal exists.
- **"Frozen embeddings beat few-shot LLM prompting"** is false at matched
  supervision — the FastFit LLM baselines fit only ~1 example per class in a 4K
  context; at 1 shot the centroid scores 66.6 vs Flan-ul2's 80.3. The embedding
  router's real advantage is **latency, privacy, and zero quota** — not accuracy.
- **Independent benchmarks find commercial routers unimpressive**: LLMRouterBench
  (400K instances, 33 models) — "several recent approaches, including commercial
  routers, fail to reliably outperform a simple baseline"; RouterArena — "all
  routers fall short of the best achievable performance." Vendor router accuracy
  claims (Martian, NotDiamond, OrcaRouter) are marketing and were not
  independently reproduced. Do not design against them.

---

## 6. Recommended sequencing

1. **Ship (A)**: local embedding + centroid workspace routing, with stickiness
   (default to current workspace) so most turns cost zero routing work, a
   visible/correctable HUD badge, and a similarity floor that falls through.
2. **Rules table for (B)**: effort by task class, hand-written. Don't build a
   learned model router yet — the independent benchmarks say it is unlikely to
   beat rules-plus-measurement.
3. **Instrument the golden set** from real traffic (§2.3). This is the only
   artifact that transfers across model releases.
4. **Then measure** the two open questions: Haiku 4.5's actual calibration
   (§3.1) and whether the Advisor tool is reachable via the SDK under
   subscription auth (§3.2).

**Bigger levers than routing** for a 3–4s target, all deterministic rather than
probabilistic: prompt caching on a stable `tools` → `system` prefix (verify with
`usage.cache_read_input_tokens`; if it's zero you have a silent invalidator),
streaming so first surface paint beats completion, and Fast Mode if the dispatch
path turns out to be output-bound.

---

## 7. SDK mechanics — resolved 2026-08-20

Measured by installing the SDK and capturing the exact request bodies it assembles
against a **local mock Messages API**. Engine-config consequences live in
[architecture.md](architecture.md) §1; routing-specific results are here.

**Method caveat, and it is a big one**: subscription auth was dead on the test machine
(see below), so **zero live inference calls completed**. Everything below is what
the client *sends*. No server response was ever observed. All latency figures
exclude model time and were taken on a heavily loaded box (load avg ~20–57).

### 7.1 The blocker: auth was dead, and how

The CLI's stored credential on the test machine was a stale stub that could not
refresh itself, so both the SDK's bundled CLI and the installed one returned
`401 OAuth access token has expired`, in scrubbed *and* fully-inherited env,
independently reproduced by two agents. Zero quota was consumed.

Inferred cause: the test machine authenticates through **Claude Desktop**, which holds
its live token in its own safeStorage vault, leaving the CLI's Keychain item a
stale stub. **Consequence for summon: "user is signed into Claude" is not the
precondition — "user ran `claude login` in a terminal" is.** Ship the auth health
check described in architecture.md.

**Corollary that survives cleanly**: env scrubbing made no difference to auth, so
summon's scrubbed-env posture is safe. The credential is the only variable.

### 7.2 Resolved

- **`setModel()` works mid-session.** Switching haiku→sonnet→haiku on a live
  streaming session swaps `model`, `max_tokens`, `thinking` and `output_config` on
  the immediately following turn, leaving the `tools` array byte-identical. So
  model routing *within* one thread is mechanically viable — no per-model threads
  needed for structural reasons.
- **Per-turn effort exists** via `applyFlagSettings({ effortLevel })`; **effort is
  a silent no-op on Haiku 4.5** (§2.2).
- **The SDK sets cache breakpoints automatically** — exactly 3 per request, all
  `ttl: "1h"`, on `system[1]`, `system[2]`, and the last user content block. None
  on tool definitions, so the first breakpoint covers the whole tools array.
- **The advisor tool is emitted by the client** (§3.2).
- **Fast mode is reachable** on Opus 5 via `settings: { fastMode: true }` (emits
  `speed:"fast"`, forces effort `high`). It **bills usage credits — real money —
  and sits outside subscription rate limits.** Never default it on; if exposed at
  all it needs an explicit labelled toggle and a decisions.md entry.

### 7.3 The sleeper finding: there may be no cache to invalidate

I framed "does `setModel()` invalidate the prompt cache?" as the key question. It
is probably **moot for dispatch**. summon's dispatch prefix measures ~99–181
tokens (§7.2 config), one-to-two orders of magnitude **below Haiku 4.5's 4,096-token
cache minimum** — so caching likely never engages on that path at all, and summon
pays full prefill every turn. At that prefix size that is cheap and fine.

Caching therefore only matters for the **reasoning path** with a long prefix. The
practical shape: keep the tiny Haiku dispatch session cache-free, and run a
separate long-prefix Sonnet/Opus session for real work where the cache earns out.

Unresolved and worth one call each once auth works: whether caching engages at all
(read `cache_read_input_tokens` across two turns), and whether a model switch
zeroes it. Also unresolved: a **volatile `x-anthropic-billing-header` block sits at
`system[0]`, before the first breakpoint, and changes every request** — the
`prompt-caching-scope-2026-01-05` beta presumably excludes it from the cache key,
but that is inferred, not observed.

### 7.4 Still open (needs working auth; ~12 calls total)

1. **Real end-to-end latency — the entire 3–4s target is unmeasured.** Not one
   inference round-trip completed. TTFT for a short Haiku dispatch turn is exactly
   as unknown as before. **This is the gap; everything else is secondary.**
2. Whether the server *accepts* what the client sends: `output_config.effort` on
   Sonnet 5, the Haiku-executor/Opus-advisor pairing, `speed:"fast"`.
3. Whether prompt caching engages, and cache behaviour across `setModel()` (§7.3).
4. Advisor wall-clock cost per consult.
5. The disabled-thinking tool-call leak (§2.2).
6. Whether `rate_limits` populates after a successful call (it returned `null`).
7. Keychain ACL from a **packaged, hardened-runtime** Electron app — higher risk
   than assumed now that credential ownership turned out to be contested between
   the desktop app and the CLI. Worth an early spike.

### 7.5 Reusable asset

The mock-API harness (`scratchpad/sdk-mechanics/mockapi.mjs` +
`ANTHROPIC_BASE_URL` + `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1`) gives full
request-body inspection at **zero quota cost** with firstParty gating intact. It
belongs in summon's test suite as a regression guard on prefix size and on the
"no API key ever forwarded" rule.


## 2026-09-16 — Original optional local command interpreter

Version 0.2 reuses installed `qwen2.5:3b` through the existing Ollama 0.15.6
loopback service on the M1/16 GB Mac. No additional reasoning model was
downloaded. This is a guarded command interpreter, not the broader embedding
router or SDK design above.

The finite action schema covers file search, calendar viewing, exact known
workspace selection, current context, and requested model rankings. Output is
validated and grounded in the request; code constructs a canonical command.
The user reviews a proposal before execution. Unsupported, compound, unrelated,
ambiguous, malformed and timed-out requests do not execute. Real model mistakes
were rejected by these checks during testing.

Final measurements used a 1,024-token context, batch 64, temperature zero and a
bounded 96-token output; actual short action outputs were typically 7–12 tokens.
The prompt includes only the short request and up to eight workspace names/IDs.
The final request limit is 600 characters, with prompt metadata bounded to 1,800
bytes. No file contents, vault snippets or provider keys enter this path.

| Synthetic set | Guarded pipeline outcomes | First request | Warm requests |
|---|---|---|---|
| Development, 8 cases | 8/8 expected proposals or safe clarifications | 9.31 s | 1.02–1.93 s |
| Held out, 8 cases | 8/8 expected proposals or safe clarifications | 9.44 s | 1.41–2.72 s; median 2.02 s |

These are small smoke benchmarks, not a general accuracy or reasoning score.
One earlier full-schema version achieved only 5/8 before its schema was
simplified. An earlier cold probe timed out after 45 seconds; the cause was not
established. Resource pressure can still change latency. The shipped adapter
uses a visible 20-second generation timeout and a 60-second keep-alive;
familiar direct commands and saved routines do not call it. Tests unloaded the
benchmark model and verified no models remained loaded afterward.

Reproduce locally with `node scripts/benchmark-local.mjs`. This deliberately
runs local inference and then releases a model loaded by the benchmark. Unit
validation is covered by `tests/local-model.test.mjs`.

## 2026-09-16 — Liquid local interpreter installation and evaluation

The accepted replacement is `summon-local:latest`, imported from Liquid AI's
official **LFM2.5-1.2B-Instruct-QAD-Q4_0.gguf**. This is the QAD checkpoint, not
the similarly named ordinary Q4_0 quantization. The default in
`src/main/local-model.mjs` now uses this dedicated name and accepts the `lfm2`
model family. Other local text-model support remains available through the
adapter's explicit model option. No global runtime upgrade was needed.

Installation evidence:

- [Official model and exact QAD file](https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct-GGUF).
- [Published file pointer](https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct-GGUF/raw/main/LFM2.5-1.2B-Instruct-QAD-Q4_0.gguf)
  reports **695,755,488 bytes** and SHA-256
  `bb741ebb106d543e9de114b843a3d3d73d51c74b5801e69da2abde821a0cb3e1`.
- Both downloaded bytes and the imported Ollama blob were hashed locally and
  matched that value. The temporary GGUF download was removed after import;
  there is one retained copy of these weights. Existing models were retained.
- Existing Ollama **0.15.6**, at `http://127.0.0.1:11434`, successfully imported
  and executed it on the M1/16 GB Mac. Its [LFM2 implementation](https://raw.githubusercontent.com/ollama/ollama/v0.15.6/model/models/lfm2/model.go)
  supports the architecture. Actual generation, not only metadata inspection,
  confirmed this checkpoint's compatibility.
- Model manifest:
  `~/.ollama/models/manifests/registry.ollama.ai/library/summon-local/latest`.
  Weights:
  `~/.ollama/models/blobs/sha256-bb741ebb106d543e9de114b843a3d3d73d51c74b5801e69da2abde821a0cb3e1`.
- Liquid's [LFM Open License v1.0](https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct/raw/main/LICENSE)
  is stored in the Ollama model's license layer. It is not Apache or MIT. The
  model is installed locally, separately from the Summon app bundle.

The imported template is the plain system/user equivalent of the
[upstream chat template](https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct/blob/main/chat_template.jinja):

```text
{{ if .System }}<|im_start|>system
{{ .System }}<|im_end|>
{{ end }}{{ if .Prompt }}<|im_start|>user
{{ .Prompt }}<|im_end|>
{{ end }}<|im_start|>assistant
{{ .Response }}
```

The GGUF sets `add_bos_token=true`; its tokenizer supplies BOS exactly once.
The explicit template does not add another BOS. Stops are `<|im_end|>` and
`<|im_start|>`. The source checkpoint's weights are unchanged. The import was
created with `ollama create summon-local:latest --file <Modelfile>`, using a
`FROM` line for the verified GGUF, the template above, the full upstream
`LICENSE` text, `num_ctx 1024` and `temperature 0`. To reproduce on another Mac,
download that exact official file, verify its hash before importing, retain its
license, and remove the temporary download after the stored blob is verified.

The finite action schema, 600-character request bound, 1,800-byte metadata
bound, 96-token output cap, 20-second generation timeout and 60-second
keep-alive remain in place. Requests include only short request text, bounded
workspace IDs/names and an optional app name. No files, vault contents, tool
access, provider credentials, redirects or cloud fallback were added. Proposals
still require review; the interpreter cannot execute an action. Its cleanup
unloads a model only when that interpreter found it unloaded and loaded it.

### Initial failures and bounded improvements

With the previous Qwen-oriented instructions unchanged, Liquid achieved **6/8**
development outcomes and **7/8** held-out outcomes. It confused one workspace
resumption with calendar viewing, and two model-ranking requests with current
workspace context. Validation rejected each wrong action as a clarification.
Cold requests were 3.573 s and 2.386 s; warm inference requests were
0.518–1.631 s. Those results were insufficient to select it on speed alone.

The instructions were made more explicit about each finite action, named
workspace resumption and model rankings versus current workspace context. No
test phrase was copied into the prompt. After that change, both original sets
reached 8/8 guarded outcomes, while **11/12** new paraphrases passed. The new
failure selected the coding category for an explicit reasoning-model request;
the existing validator rejected that mismatch.

The final grammar applies the same explicit-category restriction that the
validator already enforces: an explicit coding, reasoning or speed request
limits the category enum to that category. Other actions, including clarify,
remain possible. The validator still rejects an output that violates these
requirements, including conflicting categories. This is a general constraint
on generated proposals, not an assertion that the raw model classifies every
request correctly.

### Final validation

All runs below used the production 20-second timeout and the installed official
QAD-Q4_0 weights. Each set started with the model unloaded; cold values are the
first whole inference request, including model loading. Warm values include
metadata checks and generation, but exclude requests stopped before inference.

| Synthetic set | Guarded outcomes | Model calls | Cold first request | Warm inference requests |
|---|---|---|---|---|
| Development | 8/8 | 7 | 2.998 s | 0.454–0.754 s; median 0.730 s |
| Held out | 8/8 | 7 | 5.627 s | 0.497–0.953 s; median 0.811 s |
| New paraphrases | 12/12 | 10 | 2.673 s | 0.460–0.775 s; median 0.699 s |

The 28/28 figure describes this small **guarded pipeline**, not raw model
accuracy or a general reasoning score. Several unrelated or ambiguous inputs
still produced wrong raw actions that the validator converted into safe
clarifications. Four requests were rejected before calling the model. Ranking
cases check category as well as action type. No test executed proposed actions,
read private context or called a cloud model. Ordinary file-search proposals
were checked as proposals, not evaluated against the user's real file corpus.

Prompt counts were about 420–426 tokens and typical output counts 8–15 tokens.
The first tuned held-out run took **12.658 seconds**, including an Ollama-reported
10.582-second load, despite later cold runs being faster. The cause of that
loading variance was not established; keep-alive and machine workload affect
the experienced delay. Warm timing is not a promise for the first request after
the model unloads. The full guarded result remains subject to the 20-second
generation timeout.

Fifteen focused local-interpreter unit tests pass, including model allowlisting,
fixed-loopback requests, schema constraints, output rejection, timeout,
cancellation and ownership-based unloading. Every benchmark unloaded the model
it loaded; final `/api/ps` returned an empty list.

Reproduce all three sets:

```sh
node --test tests/local-model.test.mjs
node scripts/benchmark-local.mjs --debug --timeout 20000
node scripts/benchmark-local.mjs --held-out --debug --timeout 20000
node scripts/benchmark-local.mjs --fresh --debug --timeout 20000
```

`--debug` prints only these synthetic raw outputs and token/load measurements.
The benchmark separates completed inference requests from preflight
clarifications, records whether the model was already loaded and releases only
loads it owns. It never installs or deletes a model. The final, initial and
intermediate JSONL run records were kept locally, outside the repository, so
unsuccessful trials stayed reviewable during this setup.


## 2026-09-16 — Transcription latency repair (v0.3.1)

The user reported a long wait while the UI said “Transcribing” for “close this Force Quit Applications popup.” The prior implementation converted every renderer PCM WAV through ffmpeg and launched whisper-cli/model/Metal afresh. Its GPU-error fallback could start a second CPU attempt. The new private stdio worker keeps the selected small.en model ready during listening and accepts validated/resampled PCM in memory. No new model was downloaded.

Synthetic measurements on the same M1 Mac, using the unchanged “Summon. Calendar. Excel workbook.” seed prompt:

| Check | Measured result |
|---|---|
| Prior full conversion + CLI, reported phrase | 2.243 and 1.900 seconds; correct |
| Final retained worker, same reported phrase | 1.096, 1.186, 1.050 seconds; correct each time, including after noise |
| Final representative clip batch | 1.025–1.413 seconds per clip; workbook/calendar/wake-prefixed and noisy workbook speech recognized |
| 48 kHz “Summon” + reported phrase | 1.159 seconds including 20 ms PCM preparation; correct |
| Faint/noisy variant | 1.264 seconds including 12 ms preparation; correct |
| Worker preparation | 1.407–2.030 seconds in final checks, overlapped with microphone startup/capture |
| Sampled worker RSS | About 805 MiB peak; excludes attributing all shared/unified-memory GPU use |
| Worker close | About 35 ms |
| Actual Electron synthetic microphone → transcript → workbook result | 714 ms input startup, 2058 ms speech capture/pause, 1196 ms transcription, 8 ms command lookup; total 3976 ms including speaking time |
| Transcript-render regression probe | Recognized synthetic text visible in 22 ms before any voice-result event |

An initial greedy prototype misheard “Force Quit” as “for squid”; it was rejected. The final worker retains beam size 5, best-of 5 and temperature fallback, with a 15-second decode deadline. Three seconds of synthetic noise alone produced “I’m.”; noise hallucination remains an ASR limitation, and wake gating is still required. Two first runs exceeded the 20-second preparation deadline. A sampled stack then isolated a roughly 19.2-second wait in ggml_backend_load_all → ggml_metal_library_init → newLibraryWithSource → Metal compiler XPC, before the model loaded. The sampled process footprint at that point was only about 6.5 MiB. The signed worker subsequently prepared in about 2 seconds and decoded correctly in about 1.25 seconds. This reproduces a cold shader-compilation stall consistent with the report; the user’s original invocation was not recorded, so its exact timings are unavailable. The installed Homebrew backend embeds shader source and cannot use a precompiled metallib through its resource environment variable. Installation therefore explicitly prepares the final signed helper’s GPU cache and checks a second start; a future cache eviction, library change or differently signed update can require compilation again. Shipping a private precompiled backend would require a separate build/toolchain change. The startup limit, restored warning/error diagnostics, reuse and removal of hidden CPU retries make failure visible and bounded.

The capture regression used 1.024 seconds of synthetic speech followed by 0.018 RMS noise: the old threshold held it toward the 18-second cap, while the revised threshold ended after 0.853 seconds and submitted about 1.877 seconds of audio. Tests also preserve a 0.512-second internal pause, gradually quieter speech, queued wake-following commands, and cancellation. These synthetic fixtures do not establish recognition or endpoint accuracy in the user's room.

Validation: 118 automated tests, TypeScript, native build, complete Electron UI/synthetic speech flow, and desktop Stop/Hide/lock tests passed. Voice stays off across the installation restart; activity pause settings and model selection remain user-owned.

Final installed-path preparation: GPU backend/shader setup 17.323 seconds, model load 0.513 seconds, total ready 19.102 seconds. A fresh worker at the same installed path then prepared in 2.024 seconds and transcribed the workbook fixture correctly in 1.468 seconds (1.431 seconds decode). Both closed cleanly. This confirms that copying the signed helper to its installed path can require another initial shader preparation; prepare the installed path, not just the staging bundle. The app was relaunched and its desktop widget visibly showed Microphone off.


## 2026-09-20 implementation update

The local rules-plus-measurement step is now implemented in `src/main/task-routing.mjs`, `engine-choice.mjs` and `task-router.mjs`, with bounded explicit feedback. See [Task routing](desktop-companion.md#task-routing) for current behavior and thresholds. Rules choose reasoning effort; user-rated task cohorts can choose between available subscriptions; quota is the fallback. Claude's exact live model catalog intersects fresh public combined benchmark scores for model selection. This does not implement the earlier embedding workspace-router proposal or a trained model router, and does not integrate Sakana Fugu. No claim of routing accuracy is made from the earlier research numbers; regression fixtures verify the implemented policy, and actual useful/not-useful ratings are accumulated separately.
