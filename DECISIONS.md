# Architecture Decision Records

Append-only log of significant decisions. New ADRs go at the bottom. Never edit a finalized ADR; supersede it with a new one.

---

## Format

Each ADR uses this template:

```markdown
## ADR-NNN: Title

- **Status:** Proposed | Accepted | Superseded by ADR-XXX | Deprecated
- **Date:** YYYY-MM-DD
- **Context:** What's the situation that prompted this decision?
- **Decision:** What did we decide?
- **Consequences:** What does this enable, restrict, or risk?
- **Rejected alternatives:** What else was considered, and why was it rejected?
```

---

## ADR-001: v0.1 wedge

- **Status:** Accepted
- **Date:** 2026-05-12
- **Context:** Week 1 of the 6-week v0.1 timeline produced four grounded inputs:
  - [X402-3](https://vahdatfardin.atlassian.net/browse/X402-3) — dogfood rig live on Base Sepolia with two real-facilitator 200 settlements (txs `0x8b53a04d…b3428`, `0xc5758bf2…6cbf`). The deploy itself surfaced five sharp edges in the Vercel + x402 + faucet pipeline; the wallet-state pre-flight gap was discovered live (mock facilitator built as a fallback).
  - [X402-4](https://vahdatfardin.atlassian.net/browse/X402-4) — five deliberate failure modes with verbatim error captures from the real facilitator. Failure 5 (facilitator unavailable) explicitly captured the observability asymmetry between server-side and client-side debuggability.
  - [X402-5](https://vahdatfardin.atlassian.net/browse/X402-5) — 25-issue catalogue from `x402-foundation/x402` appended to the Notion Validation evidence page. Top 3 categories by frequency: **facilitator reliability (6), spec drift (6), observability/Bazaar (5)**. Two strong wedge-relevant individual signals: [#1860](https://github.com/x402-foundation/x402/issues/1860) (community RFC for diagnostic 402 — closed without acceptance) and [#1805](https://github.com/x402-foundation/x402/issues/1805) (5 concurrent requests reused one settlement proof — production replay).
  - [X402-6](https://vahdatfardin.atlassian.net/browse/X402-6) — synthesis in [dogfood-notes.md § Top painful moments](./dogfood-notes.md#top-painful-moments-synthesized---x402-6): 9 ranked pains, 5 wedge candidates (A reconciliation, B inspect+doctor, C bazaar-check, D cross-facilitator, E proxy substrate), 4 best-paired bundles.

  Three independent signals pointed at timeout reconciliation as the wedge:
  1. [CLAUDE.md](./CLAUDE.md) tentatively named it from project start: _"Wedge: Timeout reconciliation (tentative; confirmed in Week 2 via ADR-001)."_
  2. The [Notion Validation evidence page](https://www.notion.so/35c03c62b26381099eeec3e9c12ce438) "Possible sharp wedges" list ranked it #1 — _"No competitor solves this fully today."_
  3. The X402-6 synthesis ranked **Candidate A (timeout reconciliation, bundled with Candidate E proxy substrate)** at the highest evidence weight by reproduction count + production-money impact + recency.

- **Decision:** **v0.1 wedge = local HTTP proxy as substrate, with a timeout-reconciliation engine on top.** Concretely:
  1. **`x402trace proxy`** — captures every x402 challenge / payment / settlement exchange to a JSONL log. Sits in front of either the buying agent or the paid service, indifferently.
  2. **`x402trace reconcile`** — watches Base Sepolia USDC `Transfer` events via RPC and matches them against pending facilitator-timed-out payments by EIP-3009 nonce + payer + payee + value. When a settled-but-server-thinks-not case fires, emit a structured record (tx hash, payer, resource URL, nonce, time gap, recommended action).

  **Scope tightening required for the 5-week timeline (this is load-bearing):**
  - **Base Sepolia only.** No mainnet. No multi-chain. Per [CLAUDE.md](./CLAUDE.md) hard rule 2 and the _"Not multi-chain (Base only for v0.1)"_ declaration.
  - **Single facilitator profile.** Default: `https://x402.org/facilitator`. The mock facilitator from X402-3 stays in the test suite. CDP-compat is nice-to-have, not required for v0.1.
  - **One scheme:** `exact` EVM. No SVM, no Lightning, no escrow.
  - **Detect-and-notify only.** Emit a structured log record. **No auto-refund. No auto-replay.** Those are v0.2 territory; v0.1's job is observability, not remediation.

- **Consequences:**
  - **Enables.** Direct attack on the canonical [#1062](https://github.com/x402-foundation/x402/issues/1062) case (facilitator timeout race condition on Base). Inverse-direction detection of [#1805](https://github.com/x402-foundation/x402/issues/1805) (replay/duplicate-debit) falls out for free — same nonce, multiple inbound requests. The proxy substrate compounds: every v0.2+ feature (`inspect`, `doctor`, `bazaar-check`, `versions`) reads its data.
  - **Restricts.** v0.1 will NOT address the Bazaar indexing failure cluster (X402-5 #2112, #1982, #2162, #2156, #1461), which is the _loudest currently-active_ pain — 5 OPEN issues, multi-team reproductions, visibly degraded patience. Those filers won't be our v0.1 users. This is a tactical loss; positioning argument is that the timeout-reconciliation story is more durable and the Bazaar issues may resolve themselves as CDP iterates.
  - **Risks.**
    1. **L-effort in ~5 weeks is tight.** The scope-tightening above is not optional. Auto-refund creep, multi-chain creep, multi-facilitator creep, multi-scheme creep — any of them blows the timeline.
    2. **On-chain RPC complexity.** Rate limits, reorgs (Base reorgs are rare but real), event-filter gaps, RPC provider downtime. Need to pick a strategy (Alchemy free tier? viem default? public node?) and have a fallback.
    3. **Reconciliation-action ambiguity.** "What does the reconciliation engine _do_ when it fires?" — emit a log line is the v0.1 answer, but downstream consumers (the agent? the merchant? the operator?) will want different things. Defer the answer; capture in JSONL and let consumers decide.
    4. **CDP could fix #1062 upstream.** The canonical case has been open ~4 months with no fix. If they ship a fix in their v3, the wedge's reason-to-exist weakens — but the reconciliation engine still detects every other facilitator's equivalent gap (PayAI, x402-rs, custom), so the substrate retains value.
    5. **#1860 was closed without acceptance.** The community's diagnostic-extension RFC didn't land in the spec. We're betting that x402trace's reconciliation-record format becomes the de facto layer the RFC asked for. If a competitor (PaySentry, xpay) ships first with their own format, we adopt or compete on quality.

- **Rejected alternatives:**
  - **Candidate B — Plain-English error translator + `inspect` + `doctor` + `versions`.** Easier to ship (M-effort, 2–3 weeks). Lower differentiation: x402lint already covers ~70% of `versions`; the rest is closer to "developer convenience" than "developer money saved." **Defer to v0.2** where these tools sit on the v0.1 proxy substrate cleanly (`inspect` reads the proxy's JSONL log; `doctor` shares spec-validation logic).
  - **Candidate C — Bazaar discovery diagnostics.** Addresses the _loudest currently-active_ pain cluster (5 OPEN X402-5 issues) and would have a vocal audience this month. Rejected as v0.1 because:
    - Narrow ceiling: if CDP fixes their Bazaar indexing pipeline (single-vendor dependency on `/discovery/resources`), the tool's reason-to-exist evaporates.
    - The same proxy substrate from this ADR enables `bazaar-check` in v0.2 trivially — defer, don't kill.
  - **Candidate D — Cross-facilitator behavior diff.** Real differentiation vs. xpay/x402scan/zauth (which all _claim_ cross-facilitator but only mean "different URLs in our config"). Rejected as v0.1 because:
    - Demand thin: multi-facilitator users are <10% of x402.org listings per the Notion data.
    - Auth complexity is a long pole (CDP JWT, PayAI bearer, x402-rs whatever) — supporting >1 facilitator's auth in 5 weeks competes for time with the reconciliation engine.
    - Defer to v0.2+ when multi-facilitator users grow.
  - **Candidate E alone — proxy + structured logging only.** Foundational but weak standalone pitch ("yet another observability tool"). The proxy is included in this ADR's choice, just _bundled with_ reconciliation rather than shipped alone.

- **What this means concretely for the next 5 weeks:**
  - **[X402-8 SPEC.md](https://vahdatfardin.atlassian.net/browse/X402-8):** specify the JSONL log format the proxy emits, the reconciliation match algorithm (nonce + payer + payee + value tuple), the RPC strategy, and the JSON shape of the "settled-but-server-thinks-not" record. Defer remediation actions.
  - **[X402-9 ARCHITECTURE.md](https://vahdatfardin.atlassian.net/browse/X402-9):** components and data flow follow from SPEC.md. Three components: proxy, base-rpc client, reconciliation engine. The dogfood rig from X402-3 is the test target.
  - **[X402-10 Local HTTP proxy core](https://vahdatfardin.atlassian.net/browse/X402-10), [X402-11 decoder + logger](https://vahdatfardin.atlassian.net/browse/X402-11), [X402-12 Base RPC client](https://vahdatfardin.atlassian.net/browse/X402-12), [X402-13 Reconciliation engine](https://vahdatfardin.atlassian.net/browse/X402-13)** — build in that order. Each feeds the next.
  - **[X402-15 End-to-end testnet demo](https://vahdatfardin.atlassian.net/browse/X402-15):** deliberately stall the mock facilitator past Base block confirmation; x402trace catches the settled-but-not-acknowledged tx and emits the reconciliation record. This is the v0.1 demo.

  **Out of scope for v0.1, kept for v0.2+:** auto-refund, multi-chain, multi-facilitator, Bazaar diagnostics, cross-facilitator behavior diff, full inspect/doctor/versions toolchain.

---

## ADR-002: v0.2 feature pick — `validate` (primary) + `explain` (paired)

- **Status:** Accepted
- **Date:** 2026-05-12
- **Context:** v0.1 shipped on 2026-05-12 as [`x402trace@0.1.0`](https://www.npmjs.com/package/x402trace). The wedge is in production: local proxy + timeout-reconciliation engine, verified against three independent live Base Sepolia settlements (the two from X402-3 + the X402-15 demo tx `0x116ccf73…ba52`). 215 tests, CI on Node 20+22, Apache-2.0. [X402-20](https://vahdatfardin.atlassian.net/browse/X402-20) is the decision ticket for "what's the next most useful thing." Its candidate list narrows the X402-7 decision space:
  - `--watch` mode — daemonize the existing proxy + reconcile flow, add alerting
  - `--diff` mode — fire the same payment at multiple facilitators, diff responses
  - `--replay` mode — re-fire a logged payment against the same / different upstream
  - `--explain` mode — convert cryptic x402 errors into plain English
  - `--validate` mode — pre-flight config + wallet check before deploy

  The X402-6 pain rankings map onto these candidates:

  | X402-20 candidate                | Pain rank addressed                       | Already covered by v0.1      |
  | -------------------------------- | ----------------------------------------- | ---------------------------- |
  | `--validate` (pre-flight)        | **#4 — Wallet-state pre-flight gap**      | ❌ Not addressed             |
  | `--explain` (offline 402 decode) | **#3 — Generic 402 with no error reason** | ❌ Not addressed             |
  | `--diff` (cross-facilitator)     | #5 — Cross-facilitator drift              | ❌ Not addressed             |
  | `--watch` (daemon + alerting)    | extends #1                                | ✅ v0.1 detects in real-time |
  | `--replay` (re-fire logged)      | no specific pain rank                     | ❌                           |

  Two of the top four unaddressed pains map to `validate` + `explain`. They share most of the diagnostic engine — one is "would this succeed?", the other is "why didn't this succeed?". Building both at once is meaningfully cheaper than building either alone.

- **Decision:** **v0.2 = `x402trace validate` (primary) + `x402trace explain` (paired stretch).** Concretely:
  1. **`x402trace validate <wallet> <service-url>`** — pre-flight check, offline-first. Runs without signing any payment:
     - Fetch the service's 402 challenge (one unauthed GET, parse with v0.1's decoder)
     - Query the chain for the wallet's USDC balance + allowance + EIP-3009 nonce status
     - Compare against the challenge's `accepts[0]` requirements (asset, network, payTo, maxAmountRequired, validBefore window)
     - Detect wallet kind heuristically (EOA / Smart Wallet / ERC-6492) — v0.2 starts with EOA + Smart Wallet
     - Output: "you would succeed" / "you would fail because X" with the actionable fix per failure. Exit code 0 = would succeed, 2 = would fail.

  2. **`x402trace explain <captured-402.json | jsonl-log>`** — offline diagnosis of a failed exchange. Reads either a single captured 402 file OR a `reconcile.result` line from a v0.1 JSONL log:
     - Decode the payment payload + the challenge
     - Run the same diagnostic checks as `validate` against the captured state
     - Render plain-English explanations: "validBefore was 1778573803, but the facilitator received the payment at 1778573900 — the authorization expired 97 seconds before settlement attempted"
     - For `reconcile.result` lines, summarize what went wrong with the proxy / chain join (value mismatch vs recipient mismatch vs no-match)

  **Scope tightening for ~2-week v0.2 timeline:**
  - **Base Sepolia only** still. Mainnet stays a v0.3 line item — gated on ≥1 week of clean testnet traffic per [SPEC.md § 6](./SPEC.md#6-success-criteria).
  - **EOA + Smart Wallet** wallet-kind detection only. ERC-6492 / Coinbase Wallet quirks are v0.3.
  - **Single facilitator profile** still (`x402.org/facilitator`). `--diff`-style multi-facilitator stays rejected for v0.2.
  - **No on-chain writes** ever. `validate` is read-only by construction; `explain` only reads logs.
  - **No new dependencies.** Reuse `viem` (chain), `commander` (CLI), the v0.1 decoder modules. The diagnostic-rule engine is a new pure module under `src/diagnose/` that both `validate` and `explain` import.

- **Consequences:**
  - **Enables.** Closes the second- and third-highest unaddressed pain from the X402-6 ranking. Pairs naturally with v0.1: the same x402trace user can now (a) pre-flight before signing, (b) trace mid-flight via the proxy, (c) reconcile post-settlement, (d) explain why something failed if reconciliation flags it. One coherent debugger across the full payment lifecycle. Validates the v0.1 proxy substrate by reading its JSONL log in `explain`.
  - **Restricts.** v0.2 still won't address Bazaar indexing (pain rank #2 — the loudest _currently-active_ cluster) or cross-facilitator drift (#5). The Bazaar audience continues to be unserved; this is a tactical loss. Mainnet support (#1 in [SPEC.md § 5 v0.2 stretch](./SPEC.md#5-v02-stretch-deferred-not-killed)) also slips to v0.3.
  - **Risks.**
    1. **`validate`'s wallet-kind detection is the hard part.** EOA is trivial; Smart Wallet detection requires a contract-code check + signature-style probe. ERC-6492 is documented (the wrapped signature) but the heuristics aren't 1:1. v0.2 will ship EOA + Smart Wallet only and document the ERC-6492 gap as a known limitation — better than an unreliable detection.
    2. **`explain` overlaps with `inspect`.** v0.1's `inspect` already replays a captured JSONL log offline. The line between "inspect" (replay reconciliation) and "explain" (diagnose a single 402) needs to be explicit in the SPEC: `inspect` is bulk + temporal, `explain` is single-record + per-failure prose.
    3. **Diagnostic-rule engine becomes a v0.2 contract.** Every new x402 spec edge case requires a new rule. The rule set is the source of truth users will read; sloppy rules erode trust faster than missing ones. Mitigation: each rule has a corresponding integration test using a captured fixture from `tests/` or `dogfood-notes.md § Failure modes`.
    4. **Audience overlap with x402lint.** x402lint already does some config-level validation. `validate` differentiates by being _runtime_ (wallet + chain state) vs x402lint's _static_ (config + types). Make this distinction explicit in the README / docs to avoid "they already do this" objections.

- **Rejected alternatives:**
  - **`--diff` (cross-facilitator).** Strong differentiation per [dogfood-notes Candidate D](./dogfood-notes.md#candidate-d-cross-facilitator-drift-dashboard-rank-5), but lower pain rank (#5) and meaningful auth complexity (CDP JWT, PayAI bearer, x402-rs token — each is a separate integration). v0.2's 2-week window doesn't afford the long pole. **Defer to v0.3** once multi-facilitator usage grows above the current ~10% per Notion data.
  - **`--watch` (daemon mode).** Low differentiation — users can `while sleep 60; do x402trace proxy …; done` today. Real value is in the alerting integrations (PagerDuty? webhook? Slack?), each of which is a separate integration. The v0.1 proxy already detects in real-time inside its event loop; the gap `--watch` would close is "keep doing it across restarts." Better as a v0.3 production-readiness pass than a v0.2 feature.
  - **`--replay` (re-fire logged payment).** Useful for developer dry-runs but maps to no documented pain rank in [X402-6](https://vahdatfardin.atlassian.net/browse/X402-6). The closest production use case (dispute resolution) needs more than re-firing — it needs replay-with-modification + multi-signer support. Pulled out of v0.2 to avoid scoping it shallow.
  - **`doctor` / `versions` / `bazaar-check` from the original X402-6 list.** Not in the X402-20 ticket's narrowed candidate list. `doctor` overlaps heavily with `validate` (the ticket is a refinement of `doctor`). `versions` is small enough to land later as a one-shot. `bazaar-check` remains kept-for-later per ADR-001.

- **What this means concretely for the next ~2 weeks:**
  - **[X402-21 Implement v0.2 feature](https://vahdatfardin.atlassian.net/browse/X402-21):** build `src/diagnose/` (pure diagnostic-rule engine), `src/cli/validate-command.ts`, `src/cli/explain-command.ts`. Reuse the v0.1 chain client for balance/allowance/nonce queries; reuse the v0.1 decoder for 402 parsing. Two new subcommands in `src/cli/index.ts`.
  - **[X402-22 v0.2.0 release](https://vahdatfardin.atlassian.net/browse/X402-22):** same chain as v0.1.0 (v1 → staging → main → tag), now with the workflow fix already in place. Should be uneventful.
  - **Out of scope for v0.2, kept for v0.3+:** mainnet, ERC-6492 wallet-kind, `--diff` multi-facilitator, `--watch` daemon, `--replay`, Bazaar diagnostics, reconciliation auto-actions (refund/retry hooks).

---

## ADR-003: v0.3 feature pick — `bazaar-check` (headline) + 5 facilitator-aware diagnose rules + `validate --diff` + Base mainnet. Autonomous execution under strict 6-stage audit gate.

- **Status:** Accepted
- **Date:** 2026-05-14
- **Context:** v0.2.0 shipped on 2026-05-13 ([`x402trace@0.2.0`](https://www.npmjs.com/package/x402trace)) with `validate` + `explain` on a shared diagnostic-rule engine. v0.2.1 / v0.2.2 / v0.2.3 followed in two days — discoverability patches culminating in the v0.2.3 supply-chain hardening cut (X402-26..30, dep classification + community files + CI publish-surface guard + Dependabot). The published install graph is now clean: 4 runtime deps (`commander`, `dotenv`, `viem`, `x402`), 74 files, 222 KB unpacked, CI guard locked in.

  The natural question — _what's the next thing operators need?_ — went through a cross-platform audience-pain survey rather than a structural-pain audit, in deliberate contrast to ADR-002 (which leaned on the X402-6 pain ranking, mostly dogfood-derived). The first-pass v0.3 list biased toward structural-only picks (mainnet, ERC-6492, reconciliation webhook) — items I could justify on paper without naming a single user who'd asked. The user audit ("consider audience pains and requests") forced a re-audit against actual reported pain. The findings:
  - **Coinbase Developer Discord #x402 transcript** (2026-05-06 → 2026-05-13, captured to `discord-x402.md` and referenced from [the Notion v0.3.0 plan](https://www.notion.so/36003c62b26381fd9ae5c48758d53ccd)) — the single dominant pain across 10+ named voices (despot, akiyama, AgentOracle, GM, Rohias, moa, ScoobyCarolan, Bullhead Bitcoin, Fima, TheRoosters, Poteshniy, Myceliaman14) is **"my settlements succeed but my service never gets indexed in agentic.market / Bazaar, and I have no way to know why."** Subordinate but real pains: CDP $0.001 minimum silently rejecting payments (akiyama's multi-day chase), self-payment rejection (TerraDeed CDP → xpay), 403/throttling (tanissian), SDK version skew (Myceliaman14 Python → TS V2 refactor, Poteshniy `@x402/fetch 2.10.0` extension echo bug), SLA gap (Hikari/Recourse).
  - **GitHub Issues on `x402-foundation/x402`** — [#2207](https://github.com/x402-foundation/x402/issues/2207) (94 comments) + [#2112](https://github.com/x402-foundation/x402/issues/2112) + [#2156](https://github.com/x402-foundation/x402/issues/2156) + [#2162](https://github.com/x402-foundation/x402/issues/2162) + [#2281](https://github.com/x402-foundation/x402/issues/2281) confirm the Bazaar-indexing cluster. [#1065](https://github.com/x402-foundation/x402/issues/1065) reports 40% success rate on `/settle` with `unable to estimate gas` — surfaces an intermittent Base-mainnet failure mode Discord didn't.
  - **Dev.to** — [mkmkkkkk's article](https://dev.to/mkmkkkkk/x402-payment-timeouts-why-your-agent-loses-money-and-how-to-fix-it-fgk) independently quotes ~60% failure rate on the same `#1065` flake; mentions "PaySentry" (their open-source control plane, in development).
  - **`x402-foundation/x402#2294`** opened 2026-05-13 by @AllanMangeni proposes a "Settlement recovery after facilitator timeout" middleware. Cites NDSS 2026 formalizing the same pattern as the "Two-Phase Gap." This is the third independent builder converging on the v0.1 reconciliation pain we already shipped (mkmkkkkk's PaySentry, AllanMangeni's #2294 middleware, x402trace).
  - **`x402-foundation/x402#1875`** (open) — Mycelia Signal author's `extensions.diagnostic` spec proposal. Active engagement; the schema is still in flux; we engaged Mycelia's author via Discord DM and made a peer-not-pitch offer.
  - **agentic.market directory** — [`x402station.io Preflight`](https://agentic.market/validate) already exists as a paid ($0.001 USDC/check) buyer-side risk validator. **Different audience from x402trace** (buyers doing pre-payment risk scoring vs operators validating their own implementation).
  - **Platforms blocked or empty:** Farcaster `/x402` channel (no content via WebFetch), X/Twitter individual posts (auth wall), HN Algolia (403), Reddit (no x402 community).

  Two structural risks emerged from the audit:
  1. **Three parallel builders** in the #1062 reconciliation space (us, PaySentry, #2294 middleware). x402trace is the only one with shipped working code + a live tx hash. Risk: a competitor stabilizes their cut first and we become a follower. Mitigation: ship v0.3 quickly, comment on #2294 with our live evidence to assert prior art (done 2026-05-14 — [issuecomment-4471613294](https://github.com/x402-foundation/x402/issues/2294#issuecomment-4471613294)).
  2. **Coinbase could ship an official Bazaar checker** that obsoletes `bazaar-check`. Mitigation: ship before they do; even if they ship, x402trace stays useful as the cross-facilitator, offline-replay-capable, JSONL-first tool.

- **Decision:** **v0.3.0 = the "did I implement x402 right?" release.** Concretely:
  1. **`x402trace bazaar-check <service-url>`** (headline) — pre-ship Bazaar / agentic.market implementation validator. Composes six checks (well-known manifest, 402 challenge structure, optional paid pass, indexing query, self-payment guard, verdict synthesis) into a single bottom-line verdict. Read-only by default; opt-in paid-pass mode via `--with-wallet` or `X402TRACE_TEST_WALLET` env. **Tracked in [X402-32](https://vahdatfardin.atlassian.net/browse/X402-32).**

  2. **Five new facilitator-aware diagnose rules** in `src/diagnose/rules.ts`, each pure-function `pass`/`fail`/`skip`: `cdpMinAmountRule`, `selfPaymentRule`, `facilitatorThrottlingRule`, `extensionResponsesMissingRule`, `gasEstimationFailureRule`. Picked up automatically by `explain` and `validate`. **Tracked in [X402-33](https://vahdatfardin.atlassian.net/browse/X402-33).**

  3. **`x402trace validate --diff <facilitator-1>,<facilitator-2>`** — cross-facilitator drift on `/verify`, runs the same payload through both facilitators in parallel, surfaces drift. **Tracked in [X402-35](https://vahdatfardin.atlassian.net/browse/X402-35).**

  4. **Base mainnet support** — new `--chain <base-sepolia|base>` flag (default `base-sepolia`, no surprise change), mainnet USDC address added, testnet-only guard becomes opt-in. The v0.1 testnet-only gate ("≥1 week of clean testnet traffic") is satisfied by three independent live Base Sepolia settlements + 8+ months of CI green + v0.2.3 supply-chain hardening cut. **Tracked in [X402-34](https://vahdatfardin.atlassian.net/browse/X402-34).**

  **Stretch (ship only if scope budget allows):**
  5. **`x402trace versions <service-url>`** — SDK skew audit. **Tracked in [X402-36](https://vahdatfardin.atlassian.net/browse/X402-36).**
  6. **SLA-breach observation event in proxy JSONL** — new `service.sla_breach` discriminant. Requires **ADR-004** (event-shape change). **Tracked in [X402-37](https://vahdatfardin.atlassian.net/browse/X402-37).**

  **Operating mode for v0.3:** autonomous execution under a **strict 6-stage audit gate** codified in [CLAUDE.md § Strict audit gate](./CLAUDE.md). User explicitly stated "not going to get involved at all for this version" on 2026-05-14 and authorized re-use of the existing NPM token for the v0.3.0 publish (token rotation reminder bookends the run). The gate substitutes for user review: every ticket runs through (1) pre-work check, (2) implementation, (3) correctness audit, (4) edge-case enumeration ≥5, (5) re-audit / gap check, (6) ship via PR with audit log in the body + CI green + self-merge.

  **Scope tightening for the autonomous run:**
  - **Base mainnet enabled — but the CLAUDE.md hard rule "testnet only" needs updating** (now becomes "no committed mainnet RPC URLs" rather than "no mainnet code"). Handled in this PR.
  - **Single facilitator profile per call still — `--diff` adds multi-facilitator at the _call_ level**, not as a per-instance default. Each call still has one primary facilitator.
  - **One scheme:** `exact` EVM still. No SVM, no Lightning, no escrow. Solana adoption (despite x402-foundation/x402#2097, #2222) is a v0.4+ concern.
  - **Still read-only.** No key handling in production paths. `bazaar-check --with-wallet` is the one exception, and it's opt-in + testnet-balance-only.
  - **No SaaS surface.** Local CLI only. `bazaar-check` is a CLI command, not a hosted endpoint.

- **Consequences:**
  - **Enables.** Direct address of the highest-evidence audience pain (Bazaar indexing failure, ≥10 named voices). Catches four currently-undocumented footguns operators currently lose multi-day debug sessions to (CDP min amount, self-payment, throttling, EXTENSION-RESPONSES missing, gas estimation). Unblocks every active mainnet operator in the Discord cohort. Positions x402trace's JSONL schema as a reference shape that the #2294 middleware adopts (the AllanMangeni exchange in #2294 explicitly asked for it). Makes `bazaar-check` the "did I do this right?" answer that Discord operators are currently asking each other in real-time.
  - **Restricts.** Still no Solana coverage (#2097, #2222), no Lightning, no escrow scheme — out of our Base + `exact` EVM wedge per ADR-001. Still no auto-remediation (no auto-refund, no auto-retry) — those break the read-only security promise. Still no hosted SaaS — the CLI-only commitment from v0.1 persists. ERC-6492 Smart Wallet support stays held below the strictness bar (zero Discord voices) — build only if a real user reports the wrong-answer bug from `validate`. The `extensions.diagnostic` decoder ([#1875](https://github.com/x402-foundation/x402/pull/1875)) stays gated on the upstream spec merging — tracked in [X402-39](https://vahdatfardin.atlassian.net/browse/X402-39), no work scheduled.
  - **Risks.**
    1. **Bazaar / CDP API surface drift.** `bazaar-check` queries `/v2/x402/discovery/resources` and parses `EXTENSION-RESPONSES` header semantics — both actively evolving. Mitigation: hit the latest spec at runtime, fail-soft with "spec changed, please update x402trace" on shape drift. Don't pretend to be a parser of a frozen format.
    2. **Coinbase ships an official Bazaar checker first.** Plausible (the kind of thing CDP would build). Mitigation: ship soon; even if they ship, x402trace stays the cross-facilitator + offline-replay + JSONL-first tool. The two compete weakly, not strongly.
    3. **The diagnostic-extension PR ([#1875](https://github.com/x402-foundation/x402/pull/1875)) merges during v0.3 development.** Low likelihood (spec PRs are slow per Myceliaman14). Mitigation: the four new rules detect server-state observable today; the diagnostic extension is orthogonal — when it lands, rules become "compute locally OR consume from `extensions.diagnostic` if emitted."
    4. **`--with-wallet` paid-pass encourages key-on-command-line.** Medium. Mitigation: prefer `X402TRACE_TEST_WALLET` env, document `.env` pattern, refuse to run if wallet has >$1 mainnet balance. Same testnet-wallet discipline as the X402-15 demo.
    5. **Mainnet flag misuse.** Low-medium. Mitigation: print a startup banner on `--chain base`. The tool doesn't sign; the worst case is a failed read.
    6. **Scope creep mid-run.** High in a 9-ticket autonomous run. Mitigation: this plan is the strict scope; the "Non-goals" table in the Notion plan is the line; new pain → new ticket → v0.3.1+.
    7. **Parallel builders shipping first.** Medium. PaySentry (mkmkkkkk) + #2294 middleware (AllanMangeni) target the same reconciliation pain. Mitigation: ship v0.3 quickly; the prior-art comment on #2294 is up; the JSONL schema is now positioned as the middleware's reference shape.

- **Rejected alternatives:**
  - **ERC-6492 Smart Wallet support in `validate`.** Zero Discord voices. Pure structural pain. Build only when a real user reports a wrong-answer bug from `validate` for a Smart Wallet — file the bug ticket then.
  - **Reconciliation webhook / auto-retry.** Zero Discord voices. Auto-retry also breaks the read-only security promise. Park indefinitely.
  - **Server-side broken-client detection.** Suggested by Mycelia Signal's @jonathanbulkeley in DM (his 144k bad-request pain over 18 days). Zero Discord voices for it — even his own _Discord-visible_ pain is about indexing, not bad-client detection. He's pursuing the spec route via [#1875](https://github.com/x402-foundation/x402/pull/1875). Defer until the spec lands; revisit then.
  - **`extensions.diagnostic` decoder.** Gated on [#1875](https://github.com/x402-foundation/x402/pull/1875) merging. Don't build against an open PR — the schema shape is still under review. Tracking-only in [X402-39](https://vahdatfardin.atlassian.net/browse/X402-39).
  - **`tokenNameMismatchRule` ("USD Coin" vs "USDC" rejection).** Single voice on a single platform (Dev.to only). Below the strictness bar. File v0.3.1 backlog; promote when a second voice surfaces.
  - **`repeatedNonceRule` (replay / settlement-proof reuse).** Single GitHub voice ([#1805](https://github.com/x402-foundation/x402/issues/1805) — we chimed in). Below the strictness bar. File v0.3.1 backlog.
  - **`--watch` daemon mode.** Zero Discord voices. Daemon lifecycle, signal handling, restart semantics are real cost for unclaimed use case.
  - **Audit / compliance export (CSV / PDF).** Zero voices. No concrete user asking.
  - **Cold-start optimization.** No complaint. Premature.
  - **Multi-chain (non-Base).** Zero Discord voices for non-Base in the v0.3 cohort. Base mainnet first; if Polygon / Arbitrum demand surfaces, separate ADR.
  - **`bazaar-check`-as-hosted-SaaS.** Different product. Local CLI commitment from v0.1 persists.

- **What this means concretely for the next ~4 weeks (autonomous run):**
  - **Execution order:** [X402-31](https://vahdatfardin.atlassian.net/browse/X402-31) (this ADR + CLAUDE.md gate codification + SPEC.md § 5 update) → ([X402-32](https://vahdatfardin.atlassian.net/browse/X402-32) ∥ [X402-33](https://vahdatfardin.atlassian.net/browse/X402-33) ∥ [X402-34](https://vahdatfardin.atlassian.net/browse/X402-34)) → [X402-35](https://vahdatfardin.atlassian.net/browse/X402-35) → ([X402-36](https://vahdatfardin.atlassian.net/browse/X402-36) ∥ [X402-37](https://vahdatfardin.atlassian.net/browse/X402-37) if scope allows) → [X402-38](https://vahdatfardin.atlassian.net/browse/X402-38) (release cut).
  - **Each ticket runs through the strict 6-stage audit gate** documented in [CLAUDE.md § Strict audit gate](./CLAUDE.md). The audit log goes in every PR body so the substitution for user review is auditable post-hoc.
  - **No `--diff` / `versions` / `bazaar-check` work begins until [X402-31](https://vahdatfardin.atlassian.net/browse/X402-31) merges.** Scope-lock first, then build.
  - **Out of scope for v0.3, kept for v0.3.1+ or later:** ERC-6492 Smart Wallet, reconciliation webhook / auto-retry, server-side broken-client detection, `extensions.diagnostic` decoder (gated on upstream), `tokenNameMismatchRule`, `repeatedNonceRule`, `--watch` daemon, audit export, cold-start optimization, non-Base chains, SaaS surface.

---

## ADR-004: v0.3.2 metadata-propagation scope + JSON API stability commitment + facilitator-aware verdict semantics

- **Status:** Accepted
- **Date:** 2026-05-22
- **Context:** v0.3.0 shipped 2026-05-17 with `bazaar-check`'s three-verdict taxonomy (`looks_correct` / `implementation_issue` / `upstream_issue`). v0.3.1 hotfix shipped 2026-05-20 with two external-contributor PRs ([#66](https://github.com/fardinvahdat/x402trace/pull/66) v2 challenge parse fix by @hypeprinter007-stack, [#67](https://github.com/fardinvahdat/x402trace/pull/67) bazaar-check HTTP probe timeouts by @peterxing). Adoption signal was strong: 6 unique named operators ran v0.3.1 against production in <72h (@TomSmart_ai 19-URL fixture, @AsaiShota test-echo-cdp, @evanatpizzarobot tensorfeed, @TKCollective agentoracle.co, @Ferj Discord diagnostics, @0xdespot hyperD.ai). The v0.3.1 verdict-taxonomy held stable across the hotfix (@TomSmart_ai 2026-05-21 rerun: 19/19 stay `implementation_issue`, no verdict shift).

  Three structural decisions surfaced from v0.3.1+ operator activity that require an ADR before v0.3.2 implementation begins:

  1. **Verdict taxonomy needs a 4th composite.** Max's `polyodds.bet` settle on 2026-05-20 succeeded against CDP `/settle` with `{bazaar: {status: "processing"}}`, but Seller Tools showed empty `{bazaar:{}}` — queue never drains. The current `upstream_issue` verdict conflates "facilitator settled but indexer is broken" with "I never reached the facilitator," which is precisely the conflation Aayushi (cdp-verified support) hit when initially diagnosing Max's case as "we don't see your settle." D.3 (X402-46, indexer-state probe) introduces a new top-level composite `upstream_stuck` to surface stalled-indexer cases distinctly from generic upstream failures.

  2. **JSON output shape needs to be a public contract.** @TomSmart_ai's sampled-probe → tier-dimension store integration depends on the `--log json` envelope staying stable across minor versions. He raised this in DM 2026-05-20 building "a weekly bg job that updates a tier column on the catalogue." Maintainer commitment in DM reply: *"Will keep the JSON output shape stable across minor versions explicitly going forward."* That commitment needs to land as an explicit ADR + snapshot tests + versioning rule + `### JSON API` CHANGELOG discipline so downstream consumers can take a runtime dependency on the shape.

  3. **Verdict semantics need to be facilitator-aware.** @Cryptor's Discord #general 2026-05-21 empirical test established that Bazaar indexing is CDP-only by design; @Ferj (cdp-verified, the original [[bazaar-indexing-spec]] authority) publicly self-corrected the prior "facilitator-agnostic" claim within 4 minutes: *"Bazaar indexing is gated on a successful CDP transaction, not just the manifest being present."* x402trace's verdict logic was built on the now-retracted facilitator-agnostic model. Without a refinement, non-CDP services (self-hosted facilitators, x402-rs, hypeprinter007's JPYC-on-Polygon rail in anchor-x402) would verdict to `upstream_issue` for failing to surface on Bazaar — a false positive on working-as-intended behavior.

  All three need to land together because they jointly define the v0.3.2 verdict surface. D.2 (X402-45 propagation diff) + D.3 (X402-46 indexer-state) + D.5 (X402-43 variant-aware extensions.bazaar) all consume the verdict-semantic decisions made here.

- **Decision:** **v0.3.2 = the "verdict precision" release.** Three pillars lock now:

  **Pillar 1 — verdict taxonomy extension: `upstream_stuck`**

  Top-level verdict gains a 4th value:
  - `looks_correct` (existing)
  - `implementation_issue` (existing)
  - `upstream_issue` (existing)
  - **`upstream_stuck`** (new) — facilitator settled the transaction, but the downstream indexer hasn't advanced past `processing` within the staleness threshold (default 24h, configurable via `--processing-stale-after-hours`)

  **Exit-code contract preserved:** `upstream_stuck` rolls up to **exit code 3** (folds into `upstream_issue` for CI integration backward-compat). The verdict prose + JSON facets carry the granularity; the exit-code surface stays a 3-value contract (`0` looks_correct / `2` implementation_issue / `3` upstream_issue OR upstream_stuck). Downstream CI consumers that grep exit codes don't break.

  **D.3 ([X402-46](https://vahdatfardin.atlassian.net/browse/X402-46)) introduces this verdict + the supporting `indexer_state` facet** (`indexed | processing_fresh | processing_stale | unknown | not_applicable_non_cdp` — the last value derives from Pillar 3 below).

  **Pillar 2 — JSON API stability commitment**

  The `--log json` envelope becomes a documented public API contract:

  - **Snapshot tests** in `tests/integration/bazaar-check-json-api.test.ts` against a frozen exemplar at `tests/fixtures/bazaar/json-api-snapshot.json`. Any field rename, removal, or unexpected reordering fails CI.
  - **Versioning rule:** additive changes (new optional fields, new optional facets) ship in minor versions. Renames / removals / shape changes require a major version + integrator notice + an explicit CHANGELOG `### JSON API` subsection.
  - **`src/bazaar/json-api.md`** documents the contract (top-level keys, each facet's shape, versioning rule).
  - **CHANGELOG discipline:** any change to `--log json` output gets an explicit `### JSON API` subsection going forward. PR template + `CONTRIBUTING.md` reinforce the discipline.

  **JSON API stability ([X402-44](https://vahdatfardin.atlassian.net/browse/X402-44)) lands before D.2/D.3** so the new D.x facets go through the snapshot contract from the start.

  **Pillar 3 — facilitator-aware verdict semantics**

  Bazaar indexing is CDP-only by design. Non-CDP services produce two new verdict-facet states:

  - `indexer_state: not_applicable_non_cdp` (in D.3)
  - `metadata_propagation: not_applicable_non_cdp` (in D.2)

  Both roll up to **composite verdict `looks_correct`** (working-as-intended), NOT `upstream_issue`. The principle: **x402trace reports on what Bazaar can index, not what Bazaar *should* index.**

  **Facilitator detection** (decision deferred to D.3 implementation, three options remain open):
  1. Trust `bazaar.facilitator` manifest claim if the operator self-declares
  2. Derive from runtime behavior via TomSmart's cdp-mature fixture `facilitator_inferred` field
  3. Empirical probe against CDP discovery (`/v2/x402/discovery/resources?payTo=<addr>`)

  Option (3) is most robust but adds latency. Option (1) is fastest but trusts self-declaration. Option (2) is the precision middle-ground but requires TomSmart's fixture to land first (2026-05-24 ETA).

  **Upstream verdict still reflects implementation correctness.** A non-CDP service with a malformed challenge still verdicts to `implementation_issue` on D.5 (variant-aware extensions.bazaar) — just not on D.2/D.3 facets.

  **v0.3.2 committed scope (7 items, sequenced by [X402-41](https://vahdatfardin.atlassian.net/browse/X402-41) → [X402-48](https://vahdatfardin.atlassian.net/browse/X402-48)):**

  | Item | Ticket | Source/evidence |
  |---|---|---|
  | ADR-004 (this ADR) | X402-41 | Three pillars above |
  | D.4 `--endpoint <paid-url>` per-route probe | X402-42 | @AsaiShota + @evanatpizzarobot + @0xdespot on [#2207](https://github.com/x402-foundation/x402/issues/2207) |
  | D.5 variant-aware `extensions.bazaar` validation (Body vs Mcp discovery) | X402-43 | @AsaiShota [#72](https://github.com/fardinvahdat/x402trace/issues/72) + @0xdespot corroboration on #2207 |
  | JSON API stability (Pillar 2) | X402-44 | @TomSmart_ai mapper integration commitment |
  | D.2 propagation diff (manifest vs indexer render) | X402-45 | TheRoosters + GM + @zev |
  | D.3 indexer-state probe + `upstream_stuck` (Pillar 1) | X402-46 | @Max + @0xdespot bucket-1/2/3 taxonomy |
  | Production-set fixture consumption (6-fixture pipeline) | X402-47 | @TomSmart_ai + @AsaiShota + @evanatpizzarobot + @0xdespot + @hypeprinter007-stack |
  | v0.3.2 release cut | X402-48 | All above |

  10 Blocks dependency links wired in Jira. Fixture-freeze gate: @TomSmart_ai cdp-mature drop in `#show-and-tell` on 2026-05-24 ~07:00 UTC.

  **Operating mode for v0.3.2:** strict 6-stage audit gate stays active (carried from ADR-003), but user IS in the review loop again — so PR-body audit logs become **abbreviated** (one-line summary per stage instead of paragraphs). Drive-by guard, edge-case enumeration, and re-audit gap-check still required substantively. If user shifts back to autonomous mode mid-cycle (travel, focus block), revert to full-write-up audit logs.

  **Naming-collision resolution:** [X402-37](https://vahdatfardin.atlassian.net/browse/X402-37) (stretch SLA-breach observation, v0.3.0 cycle, never started) reserved "ADR-004" historically. This ADR claims the number; X402-37's ADR reference renumbers to next available (likely ADR-005) when/if that stretch ticket goes active.

- **Consequences:**
  - **Enables.** Verdict precision across four distinct upstream failure modes (well-known absence, indexer queue stalled, indexer drops fields, non-CDP service out-of-scope). JSON output becomes a runtime contract @TomSmart_ai can take a dependency on; mapper-integration ships against a stable envelope. Non-CDP services (self-hosted facilitators, x402-rs, JPYC-on-Polygon, future ecosystem additions) get accurate verdicts instead of false-positive `upstream_issue` for working-as-intended behavior. Six pre-committed fixtures (TomSmart 19-URL + cdp-mature, AsaiShota test-echo-cdp, evanatpizzarobot tensorfeed, 0xdespot hyperD, hypeprinter007 anchor-x402 multi-rail) anchor the integration tests against real-operator data.
  - **Restricts.** Still no Solana coverage, no Lightning, no escrow scheme — out of Base + `exact` EVM wedge per ADR-001. Still read-only — no auto-remediation. Still no SaaS surface. Candidate F (alt-challenge-surface from @0xdespot's `x-free-tier-upgrade` observation) stays below the strictness bar at 1/n; no implementation lean recorded publicly. Candidate G (facilitator-fitness check) stays watch-only in `next_likely_fires`; needs 2nd voice on non-CDP-indexing operator pain to fire (TomSmart's mapper-db filter is corroborative, not generative).
  - **Risks.**
    1. **`upstream_stuck` rollup-to-3 could surprise CI integrations** that expected a new exit code for the new verdict. Mitigation: rollup is deliberate per the exit-code-contract decision above; CHANGELOG `### JSON API` discipline makes the additive shape explicit; the new verdict-prose carries the granularity for log-grepping consumers.
    2. **JSON API snapshot tests create churn on intentional shape evolutions.** Medium. Mitigation: snapshot fixture is a hand-rolled exemplar regenerated when shape is intentionally changed; CONTRIBUTING.md documents the regenerate-snapshot + CHANGELOG `### JSON API` workflow; PR template asks the question.
    3. **D.3 staleness threshold (24h default) is wrong for real operators.** Medium-high. Mitigation: `--processing-stale-after-hours` configurable; default based on Ferj's "happens a few times a day" indexing-cadence note in [[bazaar-indexing-spec]]; revisit after first month of operator feedback post-ship.
    4. **CDP discovery API shape drift breaks D.2/D.3.** Medium (Coinbase has changed indexing API surface multiple times this year per Discord transcripts). Mitigation: cache known-good response shape in tests; fail soft with "discovery API shape changed, please update x402trace" on drift; don't pretend to parse a frozen format. Same mitigation pattern as ADR-003 risk register.
    5. **Facilitator-detection logic is wrong for some operators.** Low-medium. Mitigation: default-deny on ambiguous cases (e.g., `unknown` facilitator → `not_applicable_non_cdp` rather than false-positive `upstream_issue`); D.3 implementation picks one of the 3 options above per latency/correctness tradeoff.
    6. **Composite verdict change (`upstream_stuck`) breaks downstream consumers** that parse verdict prose literally. Low. Exit code 3 preserved; CHANGELOG `### JSON API` discipline documents the change; sub-verdict facets are additive in JSON output.
    7. **TomSmart's fixture drop slips past 2026-05-24.** Low. If his Sunday drop slides, the v0.3.2 fixture-freeze gate slides with it (not the scope). The 2026-05-26 estimated tag-push is provisional; ~36-40h audit-gate window after his drop is the hard window.
    8. **The retraction in [[bazaar-indexing-spec]] memory creates churn for other downstream consumers** (operator-facing copy, listing-readiness framing). Mitigation: prepend correction notice preserves audit trail; [[listing-readiness-framing]] gets a CDP-only nuance section; TomSmart's coinage still works for CDP-settled majority.

- **Rejected alternatives:**
  - **New top-level exit code (4) for `upstream_stuck`.** Considered to preserve verdict/exit-code 1:1 mapping. Rejected: existing CI integrations grep exit code 3 for any upstream issue; introducing exit code 4 forces all downstream consumers to update for a granularity refinement they may not care about. The verdict prose + JSON facets carry the granularity for tools that do care.
  - **Make JSON API stability a TODO instead of a contract.** Considered to defer the commitment cost. Rejected: TomSmart's integration is in flight NOW, building against the current shape; without an explicit contract, the next bug-fix-driven shape tweak silently breaks his mapper. The snapshot test + `### JSON API` discipline are cheap to maintain; the cost of not committing is asymmetric (one mapper breakage costs more than 100 snapshot regenerations).
  - **Treat non-CDP services as `unknown` instead of `not_applicable_non_cdp`.** Considered for simpler state machine. Rejected: "unknown" implies x402trace couldn't determine the state (transient, missing data). "not_applicable_non_cdp" is a definitive answer with different operator response — a non-CDP operator running `bazaar-check` shouldn't be told their service "isn't ready for listing" when the actual situation is "Bazaar doesn't surface non-CDP services in the first place." Different semantic, different remediation; deserves a distinct state.
  - **Defer Pillar 3 (facilitator-aware semantics) to v0.4.** Considered the night the correction landed (2026-05-21). Rejected: D.5 (X402-43) implementation against anchor-x402's multi-rail fixture (which includes a non-CDP JPYC Polygon rail) starts within the v0.3.2 cycle; baking the constraint in retroactively after D.5 ships would mean false-positive `implementation_issue` on JPYC for the v0.3.2 ship window. Pillar 3 must land in the ADR before D.x implementation begins.
  - **Promote candidate_G (facilitator-fitness check) to v0.3.2 committed scope.** Considered given the architectural alignment surfaced by TomSmart's mapper-db filter. Rejected: 1 voice (Cryptor's empirical test) is corrective, not pain. Promotion requires a non-CDP operator surfacing operator-facing frustration with non-indexing. Hold for 2nd voice; watch-only in `candidates.json next_likely_fires`.

- **What this means concretely for the v0.3.2 cycle (provisional 2026-05-22 → 2026-05-26):**
  - **Execution order:** [X402-41](https://vahdatfardin.atlassian.net/browse/X402-41) (this ADR) → ([X402-42](https://vahdatfardin.atlassian.net/browse/X402-42) D.4 ∥ [X402-43](https://vahdatfardin.atlassian.net/browse/X402-43) D.5) → [X402-44](https://vahdatfardin.atlassian.net/browse/X402-44) JSON API stability → [X402-45](https://vahdatfardin.atlassian.net/browse/X402-45) D.2 → [X402-46](https://vahdatfardin.atlassian.net/browse/X402-46) D.3 → [X402-47](https://vahdatfardin.atlassian.net/browse/X402-47) fixture consumption → [X402-48](https://vahdatfardin.atlassian.net/browse/X402-48) release cut.
  - **No D.x implementation begins until [X402-41](https://vahdatfardin.atlassian.net/browse/X402-41) merges.** Scope-lock first, then build. Same pattern as ADR-003 → X402-31.
  - **Fixture-freeze gate:** @TomSmart_ai cdp-mature fixture lands in `#show-and-tell` on 2026-05-24 ~07:00 UTC (or Sat 2026-05-23 morning per his preference). Mirror to `tests/fixtures/bazaar/multi-rail/cdp-mature-2026-05-21.json` on merge. ~36-40h wire-up + audit-gate window after his drop is the v0.3.2 ship window.
  - **Out of scope for v0.3.2, kept for v0.3.4+ or later:** candidate_F alt-challenge-surface (1 voice @0xdespot), candidate_G facilitator-fitness check (1 voice @Cryptor, corroborative not generative), `tokenNameMismatchRule`, `repeatedNonceRule`, `extensions.diagnostic` decoder (gated on [x402-foundation/x402#1875](https://github.com/x402-foundation/x402/pull/1875)), `--watch` daemon, ERC-6492, non-Base chains, SaaS surface. All retained per ADR-003's restrictions; this ADR adds no new restrictions, only sharpens verdict semantics within the existing wedge.

---

## ADR-007: v0.3.4 K — payment-payload echo gap diagnose rules + `upstream_stuck_cause` sub-verdict discriminator

- **Status:** Proposed
- **Date:** 2026-05-27
- **Numbering note:** ADR-005 + ADR-006 are reserved for the sibling v0.3.4 candidates G (facilitator-fitness, [X402-51](https://vahdatfardin.atlassian.net/browse/X402-51)) and I (`service_unreachable`, [X402-52](https://vahdatfardin.atlassian.net/browse/X402-52)) respectively. They will be appended in the same v0.3.4 cycle when those tickets enter implementation. ADR-007 lands first because K ([X402-50](https://vahdatfardin.atlassian.net/browse/X402-50)) has the cleanest spec (canonical writeup + reference implementation already merged in operator-side commits) and the lowest scope-ambiguity (no new top-level verdict, no new exit code).

- **Context:** [x402-foundation/x402#2207](https://github.com/x402-foundation/x402/issues/2207) cracked open 2026-05-26 with a canonical two-field root cause that had been silently swallowing CDP Bazaar listings for weeks. The signature: `EXTENSION-RESPONSES: e30=` (base64 for `{}`) on `/settle` 200 responses, no catalog landing, `l30DaysTotalCalls` frozen indefinitely. v0.3.2's `upstream_stuck` verdict (introduced in ADR-004 Pillar 1) correctly identifies the symptom but offers no attribution between the multiple root causes that produce it.

  **Three operators provided the evidence in a 12-hour window 2026-05-26:**

  | Voice | Role | Evidence |
  | --- | --- | --- |
  | @RipperMercs (TensorFeed) | **Primary voice** | Canonical writeup. 1 → 29 indexed in under an hour for $0.52 of test settles after shipping both fixes server-side. Reference impl committed at [tensorfeed worker/src/cdp-facilitator.ts](https://github.com/RipperMercs/tensorfeed/blob/main/worker/src/cdp-facilitator.ts). |
  | @TKCollective (AgentOracle) | **Corroborating voice** | Applied both enrichments in commit `71272948` (44-line patch). After 16+ days `upstream_stuck`, indexed 22 minutes post-fix (tx [`0xa48fa2c2…7017`](https://basescan.org/tx/0xa48fa2c264dbf19be0b2b2885edb63ad15ee4f10facd4d54df4fda6d0b734017)). Committed to dropping a pre/post-fix delta row on the [#72](https://github.com/fardinvahdat/x402trace/issues/72) captured-response fixture. |
  | @AsaiShota (x402-market) | **Contrast voice** | test-echo-cdp has shipped both enrichments since ~2026-05-09 and remains frozen in `/discovery` since 2026-05-11. Establishes a **second failure mode past payload enrichment** — payload-shape-correct-but-still-stuck. Rules must NOT mis-classify this case as a payload echo gap. |

  **The two missing buyer-side fields** (per `PaymentPayloadV2Schema`, `@x402/core@2.11.0` `schemas/index.d.mts:315-389`):

  1. `paymentPayload.resource` must be `{url, description?, mimeType?}` **object**, not a URL string. A bare string returns CDP HTTP 400 `'paymentPayload' is invalid`.
  2. `paymentPayload.extensions` must be **echoed verbatim from the 402 challenge**. Without this, CDP skips bazaar processing entirely and emits the `EXTENSION-RESPONSES: e30=` signature.

  **Strictness-bar verification:** 2 named independent voices on the root-cause rules themselves (RipperMercs + TKCollective). Both observed the indexer flip post-fix on independent services with independent payload-construction code. AsaiShota's case is intentionally NOT counted toward the rule pair — they document the contrast (payload-correct, still stuck) which becomes a guard-rail rather than a promotion signal. Promoted via the standard ≥2-voice path, not the bug-pathway.

  **Concurrent v0.3.4 candidates** (filed in same scope-eval session):
  - [X402-51](https://vahdatfardin.atlassian.net/browse/X402-51) **G** — facilitator-fitness (non-CDP rail awareness); ADR-005 pending implementation.
  - [X402-52](https://vahdatfardin.atlassian.net/browse/X402-52) **I** — `service_unreachable` sub-verdict (network-layer vs x402-layer); ADR-006 pending implementation.
  - Together with K, three diagnose-rule additions across the v0.3.4 cycle. Same shape as v0.3.2's D.1-D.5 fan-out.

- **Decision:** Two new diagnose rules in `src/diagnose/` refining `upstream_stuck` with a new sub-cause discriminator. **No new top-level verdict. No new exit code.** Strictly additive to v0.3.2's JSON API contract (X402-44).

  ### Rule 1: `payment_payload_missing_resource_object`

  Fires when buyer-side payload capture (proxy mode or fixture replay) shows `paymentPayload.resource` as a bare URL string. Requires payload capture; if no capture is available, the rule **defers** (does not fire false-negative). Deterministic: schema is canonical, the string-vs-object check is bit-for-bit identifiable.

  ### Rule 2: `extensions_not_echoed`

  Fires when `EXTENSION-RESPONSES: e30=` (base64 `{}`) appears on `/settle` 200 responses **AND** the upstream 402 challenge declared a non-empty `extensions` block. Requires both signals — the empty-`{}` alone is not enough (some bazaar-disabled paths legitimately produce `{}`); the challenge-side non-empty declaration is what makes the gap diagnosable.

  ### Sub-verdict discriminator: `detail.upstream_stuck_cause`

  Refines the existing `upstream_stuck` composite verdict (from ADR-004 Pillar 1, [X402-46](https://vahdatfardin.atlassian.net/browse/X402-46)) with attribution:

  ```
  detail.upstream_stuck_cause:
    | "payload_echo_gap"        # ≥1 of K's two rules fired
    | "indexer_state_terminal"   # bucket-3 per @0xdespot — catalog never lands (X402-46)
    | "indexer_state_processing" # bucket-2 working-slow per @0xdespot (X402-46)
    | "unknown"                  # default — covers AsaiShota's contrast case
  ```

  **Rollup unchanged:** `upstream_stuck` continues to map to exit code 3 (the existing `upstream_issue`-folded exit-code per ADR-004). `detail.upstream_stuck_cause` is additive in JSON output and surfaces as one line in human-format output beneath the verdict. CI integrations that grep exit codes don't break.

  **Multi-endpoint synthesis:** in a single `bazaar-check` run touching multiple paid endpoints, per-endpoint `upstream_stuck_cause` is emitted; top-level `upstream_stuck_cause` is the union — `payload_echo_gap` if any endpoint fires either rule. The narrower causes (`indexer_state_*`) win over `unknown` but yield to `payload_echo_gap` when both are present (echo gap is upstream of the indexer state).

  **Fixture-driven validation:** @TKCollective's pre/post-fix delta on the [#72](https://github.com/fardinvahdat/x402trace/issues/72) captured-response fixture is the canonical snapshot test. Pre-fix capture must assert `upstream_stuck_cause: payload_echo_gap`. Post-fix capture must assert either `looks_correct` or `upstream_stuck_cause: unknown`. @AsaiShota's test-echo-cdp must assert `upstream_stuck_cause: unknown` (NOT `payload_echo_gap`) — guards the contrast voice into the test bed as a false-positive sentinel.

  **Reference impl is a comment, not a dependency:** @RipperMercs's [tensorfeed worker/src/cdp-facilitator.ts](https://github.com/RipperMercs/tensorfeed/blob/main/worker/src/cdp-facilitator.ts) is documented as the canonical fix shape in `src/bazaar/diagnose-rules.md`. x402trace does not import their code; their pattern is the operator-side remediation that the rules surface.

- **Consequences:**
  - **Enables.** Operator running `bazaar-check` against a stuck listing now gets attribution: "your listing is stuck because your buyer wrapper isn't echoing `extensions`, here's the canonical fix shape," rather than "your listing is stuck, here's a generic upstream-issue message." Five operators in the 2026-05-26 #2207 thread spent collective days debugging this; v0.3.4 closes the loop. JSON consumers (@TomSmart's mapper db, @poteshniy's `agenttrust.uk/v1/reputation`) get a discriminator they can use to bucket stuck listings without re-implementing the payload introspection. The contrast voice (@AsaiShota's test-echo-cdp) gets a sentinel that protects against false-positive routing — the rule pair improves attribution precision without losing recall on the existing `upstream_stuck` taxonomy.
  - **Restricts.** Rule 1 requires buyer-side payload capture (proxy mode or fixture replay). Without capture, the rule defers — never fires false-positive on absent data. This means `bazaar-check` standalone (no proxy, no fixture) can detect Rule 2 (response-side signature) but not Rule 1 — accepted tradeoff. No remediation: x402trace does not modify buyer wrappers; it surfaces the gap and points at the canonical fix. Exit-code contract unchanged.
  - **Risks.**
    1. **Rule 2's `e30=` signature could appear in legitimate bazaar-disabled paths.** Medium. Mitigation: rule requires both the empty-`{}` response signature AND non-empty challenge-side `extensions` declaration; bazaar-disabled paths won't have the latter. Cross-validated against @AsaiShota's test-echo-cdp fixture (challenge declares extensions, response is `e30=`, but indexer-state-side facets explain why — `upstream_stuck_cause: unknown` is the right output, NOT `payload_echo_gap`).
    2. **Multi-endpoint synthesis rule (union over per-endpoint discriminators) may surprise operators expecting a single-endpoint focus.** Low-medium. Mitigation: per-endpoint discriminators always emitted alongside the top-level; human-format output shows the per-endpoint breakdown when more than one fires; documentation in `src/bazaar/diagnose-rules.md` covers the synthesis explicitly.
    3. **The reference-impl link to @RipperMercs's facilitator wrapper could rot if they restructure their repo.** Low. Mitigation: link is a documentation pointer, not a dependency; if the link rots, the rules continue to work; CHANGELOG ships a copy of the relevant pattern in `src/bazaar/diagnose-rules.md` so the canonical fix shape lives in-repo too.
    4. **Future spec evolution of `PaymentPayloadV2Schema` could deprecate the `resource` object shape entirely.** Low (the schema is already canonical in `@x402/core@2.11.0`, used in production by CDP). Mitigation: rule pair pins to the `PaymentPayloadV2Schema` shape current at v0.3.4 ship; if the spec evolves, supersede this ADR rather than mutating the rules in place.
    5. **JSON API snapshot churn on the new `upstream_stuck_cause` field.** Low. Strictly additive per X402-44 contract; snapshot test asserts presence of the new key, downstream consumers add a single optional field handler.
    6. **Concurrent v0.3.4 work (G + I) introduces other new facets that could intersect with `upstream_stuck_cause`.** Low-medium. Mitigation: ADR-005 (G) and ADR-006 (I) are sequenced after this ADR; both must explicitly cross-reference `upstream_stuck_cause` and document how `reachability` / `facilitator_fitness` interact with the discriminator before their tickets close. Specifically, `service_unreachable` (I's new top-level verdict) takes precedence over `upstream_stuck` when both could apply — a service that fails DNS doesn't get an `upstream_stuck_cause` because it never reached upstream.

- **Rejected alternatives:**
  - **New top-level verdict `payload_echo_gap`.** Considered to give the payload gap its own composite verdict equal to `upstream_stuck` / `upstream_issue`. Rejected: the gap IS an upstream-stuck case; promoting it to a sibling verdict would force downstream consumers (TomSmart's mapper db, poteshniy's `/v1/reputation`) to handle a new top-level type for a refinement of an existing taxonomy. The discriminator field is the cheaper additive surface.
  - **New exit code 5 for `upstream_stuck_cause: payload_echo_gap`.** Considered for CI integrations that want to differentiate. Rejected per the same logic as ADR-004's `upstream_stuck` rollup-to-3 decision: the exit code surface is a three-value contract; cause-attribution lives in JSON facets, not exit codes.
  - **Detect the gap on the response side only (don't require buyer-side payload capture for Rule 1).** Considered for `bazaar-check`-standalone deployment without proxy. Rejected: response side can't distinguish "resource sent as string but accepted somehow" from "resource sent as object correctly" — the schema enforcement happens at CDP's facilitator boundary, so the response-side signature is the same shape regardless of which form the buyer sent. Capture-required for Rule 1 is the correct precision tradeoff.
  - **Promote K via the bug-pathway (single-voice + confirmed defect).** Considered given the cleanness of the spec match. Rejected: the bug is in buyer-side wrapper code across the ecosystem, not in x402 spec or x402trace itself. The rule pair is a *feature* (new diagnose-rule capability) addressing the bug pattern. Standard ≥2-voice promotion applies; voices satisfied (RipperMercs + TKCollective).
  - **Fold K into G or I's ticket** to consolidate v0.3.4 scope. Considered. Rejected: K's surface (refining an existing verdict's facet) is structurally different from G's (new facet entirely, non-CDP rail awareness) and I's (new top-level verdict, exit-code question). Three separate tickets, three separate ADRs, three separate audit-gate cycles — same shape as D.2/D.3/D.4/D.5's separability in v0.3.2.
  - **Defer K to v0.4.** Considered to keep v0.3.4 surface small. Rejected: @TKCollective's [#72](https://github.com/fardinvahdat/x402trace/issues/72) delta-row fixture commit is in flight (committed for "tomorrow" from his 2026-05-26 reply). The captured-response fixture lands in days, not months; deferring K means an arriving high-quality fixture sits idle in `tests/fixtures/` without a consumer rule. Land K in v0.3.4 to absorb the fixture in the same cycle it arrives.

- **What this means concretely for the v0.3.4 cycle:**
  - **Execution order:** ADR-007 (this) → [X402-50](https://vahdatfardin.atlassian.net/browse/X402-50) K implementation → ADR-005 + [X402-51](https://vahdatfardin.atlassian.net/browse/X402-51) G implementation → ADR-006 + [X402-52](https://vahdatfardin.atlassian.net/browse/X402-52) I implementation → v0.3.4 release cut. ADRs land first in each sub-cycle, same pattern as ADR-003 → X402-31 (v0.3.0) and ADR-004 → D.x (v0.3.2).
  - **Fixture-driven entry point:** TKCollective's #72 delta-row capture from his 2026-05-26 commitment is the canonical test surface. Ticket scaffolding can start before the fixture lands; the fixture wires in mid-cycle.
  - **Out of scope for v0.3.4, kept for v0.4+:** auto-remediation (Rule 1 firing doesn't rewrite the buyer's wrapper code), hosted-product surface (deagentic.ai super-app is its own future-direction track per `[[deagentic-super-app-vision]]`), candidate_F alt-challenge-surface (still 1 voice), candidate_H directory-only manifest signal (still 1 voice), candidate_J orphaned-wallet (0 voices). All retained per ADR-001 + ADR-003 restrictions.

---

---

## ADR-008: v0.3.4 L — host_pollution listing-hygiene verdict (single-voice bypass under D.5 precedent)

- **Status:** Accepted
- **Date:** 2026-05-29
- **Context:** Ferj (cdp-verified, anchor-x402.com) ran `bazaar-check` against `api.anchor-x402.com` on 2026-05-27 and received `looks_correct` — yet CDP's `/discovery/merchant?payTo=0x127462e296fAc1A7F5cF33bA57bB2f0FFf5cD0B6&limit=50` returns **23 indexed entries for that single payTo, spread across 3 hosts** (`api.anchor-x402.com`, `chat.anchor-x402.com`, and the raw API Gateway URL `1c09pdnrx1.execute-api.us-east-1.amazonaws.com`). Same Lambda answers all three. `/v1/anchor` for example lives under both `api.anchor-x402.com` and the raw API Gateway URL simultaneously. Canonical `resource.url` doesn't fix it because CDP captures the URL the buyer hit, not the canonical resource URL.

  This is a **listing-hygiene gap** that the existing verdict taxonomy cannot surface. The technical verdict (`looks_correct`) is correct — the code is right; the ops are leaky. Distinct from #2207 upstream-stuck cluster (which is indexer-side fault). Distinct from facilitator-fitness (which is rail-side). Root: AWS Lambda + multi-host CDN/custom-domain is a structural pattern; many operators are silently in the same state.

  Naming clash: in the existing Notion v0.3.4 plan, `H` is reserved for "directory-only manifest signal" (@RipperMercs #85, still 1 voice, held). To avoid cross-doc confusion, the new candidate is filed as `L` (next available letter after F/G/H/I/J/K).

  **Strictness-bar question:** Ferj is the only named voice. Default strictness bar requires ≥2 voices for promotion. v0.3.4 committed scope (K+G+I) is locked at 2-voice promotions. Three options:
  1. Wait for 2nd voice (defer to v0.3.5)
  2. Single-voice bypass under the D.5 precedent (ADR-004's body-discovery split, X402-43, single-voice promotion of AsaiShota via "bug pathway bypass — confirmed false-positive on legitimate body-discovery service, not feature speculation")
  3. Defer to v0.3.5 strictly

- **Decision:** **Option 2 — single-voice bypass.** Promote `candidate_L (host_pollution)` into v0.3.4 committed scope as the 4th item alongside K+G+I. Maintainer approval 2026-05-29 ("B"). Jira ticket filed under the v0.3.4 release (X402-53 or next-available).

  **Bypass criteria met (matching D.5 precedent + adding cdp-verified status):**
  1. **cdp-verified operator** (Ferj, anchor-x402.com — first contribution to land in v0.3.x scope; multiple #2207 cluster touches before this)
  2. **Concrete reproducible curl** with 23-entry payload — anyone running multi-host AWS can verify in their own CDP listing
  3. **Structural pattern** — AWS Lambda + custom domain is standard; many operators in the same state silently
  4. **Additive verdict** — `extensions.bazaar.host_pollution` is new facet; doesn't change existing `looks_correct` / `upstream_stuck` / `implementation_issue` discriminator surface
  5. **Small impl** — one CDP `/discovery/merchant?payTo=...` query + group-by-canonical-resource-path; estimated ~80 LOC + 1 fixture
  6. **JSON API stability preserved** — additive per X402-44 contract; existing snapshot test untouched

  **What lands in v0.3.4:**
  - New `extensions.bazaar.host_pollution` facet shape: `{ hosts: [...], resource_path: "...", entries_count: N }`
  - Detection logic in `src/bazaar/`: query CDP `/discovery/merchant?payTo=<merchant payTo>` → group by canonical resource path → flag if N distinct hosts > 1 for same path
  - New JSONL `event` discriminant `bazaar.host_pollution` (additive)
  - Captured-response fixture: request from Ferj via DM after ticket files (anchor-x402.com setup is the canonical case)
  - README + `src/bazaar/json-api.md` doc update (additive)
  - CHANGELOG `### Added` entry under v0.3.4

  **What's out of scope (kept for later):**
  - Cleanup recommendations / auto-fix (diagnostic only)
  - Cross-merchant pollution detection (this is single-payTo, multi-host; cross-payTo is a different shape)
  - Configurable threshold for "how many hosts is too many" — ship as `host_pollution` warning when N > 1 (binary), revisit if operators want a threshold knob

- **Consequences:**
  - **Enables.** Operators running multi-host AWS Lambda or CDN/custom-domain setups get a listing-hygiene signal. Distinguishes ops-side hygiene from code-side correctness. Ferj's class of failure is no longer silently `looks_correct`. The bazaar-check verdict taxonomy gains a new warning layer (additive to existing exit-code 0 → still 0 with the warning facet; not a new exit code).
  - **Restricts.** No auto-fix (diagnostic only). Single-payTo focus (cross-payTo pollution is different). No threshold knob in v0.3.4 (binary "more than one host = warning").
  - **Risks.**
    1. **2nd voice never materializes — we shipped a rule for one named operator.** Low-medium. Mitigation: Ferj's curl is reproducible; pattern is structural (AWS Lambda + custom domain is standard). Anyone running similar infra can verify the pattern exists. The bypass is precedent-bounded, not a general weakening.
    2. **Operators may not understand the warning** ("my code is right, why is bazaar-check complaining?"). Low. Mitigation: clear human-format remediation copy: "Your service is indexed under N hosts in CDP /discovery/merchant. Same code, multiple hostnames. Consider configuring CDN/Lambda to canonicalize to one host."
    3. **CDP /discovery/merchant rate-limit on the new query.** Low-medium. Mitigation: cache responses for the duration of a single `bazaar-check` run; one query per merchant payTo per run.
    4. **JSON API snapshot churn from the new facet.** Low. Strictly additive per X402-44; snapshot test asserts presence of the new optional key, downstream consumers add a single handler.
    5. **Strictness-bar precedent weakening risk.** Low-medium. Mitigation: ADR-008 + memory `[[candidate-L-host-pollution-v034-bypass]]` document the bypass criteria explicitly. Going forward: cdp-verified + concrete reproducible curl + additive impl + small surface = bypass-eligible. NOT a general rule weakening — every criterion must hold.

- **Rejected alternatives:**
  - **Wait for 2nd voice (Option 1).** Considered. Rejected: Ferj's signal quality (cdp-verified + concrete repro + structural pattern) is high; impl is small + additive; D.5 precedent already established the bypass path. Forcing 2-voice wait when every quality marker is present would be valuing the bar's letter over its purpose (signal quality).
  - **Defer to v0.3.5 strictly (Option 3).** Considered to keep v0.3.4 scope tight. Rejected: K+G+I are diagnose-rule additions; L is a new verdict facet — structurally orthogonal. Bundling L into v0.3.4 reuses the same audit-gate cycle. v0.3.5 may pile up with batch-scheme work + other organics; L is independent and can land alongside without sequencing conflict.
  - **Promote L to a new top-level verdict.** Considered (parallel to `service_unreachable` in I). Rejected: `host_pollution` is a WARNING not a FAILURE — code is correct, ops are leaky. Top-level verdict would force consumers (TomSmart's mapper db, poteshniy's `/v1/reputation`) to handle a new top-level type for a refinement-warning. Facet under `extensions.bazaar` is the cheaper additive surface — same logic as ADR-007's K facet decision.
  - **Threshold-knob configurability in v0.3.4** (`--host-pollution-threshold N`). Considered. Rejected: binary "more than one host" is the right v0.3.4 floor; threshold-knob is a v0.4+ refinement if operators ask for one.
  - **Combine L with K (same ADR).** Considered to consolidate. Rejected: K refines an existing verdict's facet (`upstream_stuck_cause`); L adds a new facet (`host_pollution`) under a different code path (CDP `/discovery/merchant` query). Three separate concerns in v0.3.4 = three separate ADRs (ADR-005 G, ADR-006 I, ADR-007 K, ADR-008 L), same pattern as ADR-003 → D.2/D.3/D.4/D.5 in v0.3.2.

- **Naming-clash resolution:** ADR-007's "Consequences" section incorrectly references "candidate_H directory-only manifest signal (still 1 voice)" as v0.4+ held. That `H` is RipperMercs #85 (Notion v0.3.4 plan's Held table). Ferj's host_pollution is a different signal; this ADR formalizes the rename to `candidate_L`. ADR-007's H reference still stands as a v0.4+ held candidate (no change to the directory-only-manifest signal).

- **Reference impl is documentation, not dependency:** Ferj's anchor-x402.com setup is the canonical example. Captured-response fixture will request from Ferj via DM after the ticket is filed.

- **What this means concretely for v0.3.4 cycle:**
  - **Execution order shift:** ADR-008 (this) → X402-53 L implementation → can land first (independent of K/G/I) OR last (after K+G+I) — no sequencing constraint. Suggest landing last to keep K+G+I's ADR-005/006/007 cycle clean.
  - **Notion plan update:** L row added to "Committed scope" table; evidence accumulation section dated 2026-05-29.
  - **CHANGELOG forecasting:** v0.3.4's `### Added` will include all four (K + G + I + L).
  - **Out of scope for v0.3.4, kept for v0.4+:** unchanged from ADR-007 (auto-remediation, hosted-product surface, candidate_F, candidate_H directory-only manifest, candidate_J orphaned-wallet) PLUS now `host_pollution` threshold-knob configurability + cross-payTo pollution detection.

---

## ADR-005: v0.3.4 G — facilitator-aware fitness check (non-CDP rail awareness)

- **Status:** Accepted
- **Date:** 2026-05-29
- **Context:** v0.3.2 introduced a `not_applicable_non_cdp` short-circuit in `bazaar-check`'s indexing-state probe ([X402-46](https://vahdatfardin.atlassian.net/browse/X402-46)) — correctly avoids misattribution by emitting `indexing.indexer_state: not_applicable` when the merchant declares a non-CDP facilitator, since CDP `/discovery/merchant` has no knowledge of services that don't settle through it. Side effect: non-CDP services get verdict silence on the facilitator dimension. The merchant configured a non-CDP rail correctly, x402trace verdicts `looks_correct` on the technical surface, and the operator has no positive signal that the *facilitator itself* is reachable / healthy / responding within the EIP-3009 timeout window.

  Voices that surfaced this gap:
  - **@Cryptor** (Discord #general 2026-05-21 19:55 UTC) — empirical test against CDP `/discovery/merchant?payTo=...` established that **bazaar indexing is CDP-only by design** (`Only after successful transaction through CDP the 402 endpoint will be visible on Bazaar`). Corrected the `[[bazaar-indexing-spec]]` memory which had previously assumed facilitator-agnostic indexing. Spec-correction voice, not pain voice — confirms the architectural reality the new G check needs to respect.
  - **@TomSmart_ai** (Discord DM 2026-05-23) — mapper ingests both CDP and non-CDP facilitators; will consume a `facilitator_fitness` mapper-db column as positive signal complementing the existing `cdp_indexed` column. Operator-side pain voice: non-CDP services in mapper currently have no fitness signal beyond "operator declared this facilitator," so health-monitoring is blind to non-CDP outages.
  - **@Cinderwright** (x402-foundation/x402#1065 comment 2026-05-29 02:31 UTC) — 3rd-touch voice post-promotion. Names **PayAI's facilitator (`facilitator.payai.network`)** as a concrete CDP alternative ("more consistent on Base mainnet for small amounts"). Built **3-second auto-retry layer** that catches transient settle failures. Validates that operators do migrate between facilitators in production; fitness-per-rail is actionable, not academic.
  - **@hypeprinter007-stack's `anchor-x402` multi-rail fixture** (offered via [#2207](https://github.com/x402-foundation/x402/issues/2207) 2026-05-21) — three rails on identical 16 paid endpoints: Base USDC (CDP), Solana USDC (CDP), JPYC Polygon (in-process self-hosted, **non-CDP**, EIP-712 domain `"JPY Coin"` v1). Multi-rail synthesis acceptance target.
  - **@TKCollective's SKALE+PayAI gasless rail fixture** (offered via #2207 follow-up 2026-05-27) — AgentOracle's `/deep-research/skale` route on SKALE Base (chainId `1187947933`) with **gasless settlement via the PayAI facilitator**. First paid settle: tx `0x809361edad3ea6aebfacea978c6d6acf8cb32f7f03e4b5d13ee070e00c9f8e42`. Second non-CDP rail acceptance target.

  Strictness-bar state: ≥2 voices met (Cryptor + TomSmart_ai are the load-bearing pair; Cinderwright, hypeprinter007, TKCollective are post-promotion validation and fixture sources). Promoted as committed v0.3.4 scope alongside K (ADR-007), I (ADR-006), L (ADR-008).

- **Decision:** Add `extensions.bazaar.facilitator_fitness` facet, emitted **per declared facilitator rail**. Values are an enum: `ok | degraded | unreachable | unknown`. Top-level verdict unchanged — facet is additive under existing `looks_correct` / `upstream_issue` rollup.

  **Identity source for the facilitator:** the declared `extensions.bazaar.facilitator` field on the merchant's manifest, **directly**. Not tx-`from` address inference. This is load-bearing for two reasons:
  1. **Gasless rails** (SKALE+PayAI per TKCollective's fixture) have no on-chain settle-fee signal; tx-`from` matches the buyer's gasless-relayer address, not the facilitator's. Inference would mis-identify or null-out.
  2. **Declared identity is the operator's intent.** Whatever the merchant declared is what should be probed. If they declared wrong, the verdict surfaces *that* — the wrongness is the signal.

  **tx-`from` inference reserved as last-resort fallback for non-gasless rails only**, when the manifest omits the facilitator declaration entirely (legacy / malformed manifests). Documented as `facilitator_fitness_identity_source: declared | inferred-from-tx | unknown` in the facet for transparency.

  **Detection logic per rail:**
  1. Read declared `extensions.bazaar.facilitator` (string URL or facilitator-id from a known registry).
  2. Resolve to facilitator probe endpoints. v0.3.4 ships with a small built-in registry (`CDP`, `PayAI`, `x402.org/facilitator`) for the named facilitators in the operator-evidence anchors; unknown facilitators emit `facilitator_fitness: unknown` with a remediation hint.
  3. Probe `/verify` (or scheme-specific health endpoint) with a bounded timeout (default 5s).
  4. Classify:
     - `ok` — `/verify` returns 200 within timeout, scheme-expected response shape
     - `degraded` — `/verify` returns 200 with elevated latency (≥3× declared `maxTimeoutSeconds` proportional) OR returns 5xx that recovers within bounded retry (≤3 attempts, exponential backoff per the @mkmkkkkk pattern from #1065)
     - `unreachable` — `/verify` fails consistently (TCP refused / TLS error / 5xx that doesn't recover) across bounded retries
     - `unknown` — facilitator not in built-in registry AND inference disabled / non-gasless inference returns no data
  5. Cache result per facilitator URL for the duration of a single `bazaar-check` run.

  **Multi-rail synthesis (services declaring multiple rails like `anchor-x402`):**
  - Emit `facilitator_fitness` as an **array** when multiple distinct facilitator URLs declared across `accepts[]` or `items[].accepts[]`.
  - Per-rail facet array: `[{ rail: 0, facilitator: "...", fitness: "ok" }, { rail: 1, facilitator: "...", fitness: "degraded" }, ...]`.
  - **Healthy CDP rails are not masked by degraded non-CDP rails** — each rail's verdict stands on its own.
  - Top-level rollup: if any rail is `unreachable`, exit code 3 (`upstream_issue` bucket); otherwise exit 0 (existing `looks_correct` rollup) — facet still emitted with `degraded` info even on exit 0.

  **Documentation generalization:** `src/bazaar/diagnose-rules.md` adds a `facilitator_fitness` section with the registry shape (`{ facilitator_id, declared_urls, probe_endpoint, classification_thresholds }`) and the per-rail-not-composite synthesis rule.

- **Consequences:**
  - **Enables.** Positive fitness signal for non-CDP rails (TomSmart's mapper gets a `facilitator_fitness` column; Cinderwright's hosted leaderboard can grade fitness alongside spec compliance; operators running multi-rail get per-rail verdicts instead of `not_applicable_non_cdp` silence). The PayAI-vs-CDP fallback pattern that Cinderwright's #1065 workaround surfaces becomes a *signal x402trace can express* rather than tribal knowledge. Closes the `x402.org/facilitator` mock case from v0.1 — the substrate now grades all known facilitators on the same axis. hypeprinter007's multi-rail fixture becomes the canonical acceptance test for the per-rail array shape.
  - **Restricts.** The facet is per-rail; no single-composite fitness verdict at the merchant level. Operators wanting "is my merchant healthy overall" must read the array. v0.3.4 ships with a small built-in registry (3 facilitators); unknown facilitators emit `unknown` rather than attempting structural probing — adds maintenance overhead per new facilitator, but the registry is data not code (extensible without engine changes).
  - **Risks.**
    1. **Built-in registry rots if facilitator endpoints change.** Medium. Mitigation: registry is in `src/bazaar/facilitator-registry.json` (data, not code); operators can override via `--facilitator-registry <path>`; documentation explicitly notes the registry shape so PRs adding new facilitators are trivial.
    2. **Probe-side timeouts produce false `unreachable` verdicts under transient network conditions.** Medium. Mitigation: bounded retry (≤3 attempts, exponential backoff 500ms/1s/2s per the @mkmkkkkk pattern from #1065); `unreachable` requires consistent failure across all retries; `degraded` covers transient + recovered cases.
    3. **Probing facilitators that don't expect health-checks may rate-limit or block x402trace IP.** Low-medium. Mitigation: probe `/verify` with a trivial valid-shape but invalid-signature request — same surface as a malformed buyer would hit, so facilitators that accept normal traffic accept this; document in `src/bazaar/diagnose-rules.md`. If a facilitator explicitly blocks, `unreachable` is the correct verdict.
    4. **Gasless rail (SKALE+PayAI) introduces dual-identity ambiguity** — the buyer-side tx `from` is the gasless relayer, not the facilitator; on-chain inference would mis-identify. Resolved by declared-identity-first design above.
    5. **Multi-rail array shape breaks downstream consumers expecting single-value.** Low. Mitigation: X402-44 snapshot-test guards the JSON API contract; v0.3.4 release notes call out the new per-rail array shape; consumers can read first element for single-rail merchants and degrade gracefully.
    6. **The Cinderwright PayAI-as-CDP-alternative narrative could imply CDP is unreliable.** Low — narrative, not technical risk. Mitigation: facet is descriptive (`degraded`/`unreachable`), not prescriptive (no "switch to PayAI" remediation copy); operators read their own rail state and decide.
    7. **Cross-facet interaction with K and I.** Low-medium. Mitigation: `service_unreachable` (I's top-level verdict) takes precedence over `facilitator_fitness: unreachable` — if the service itself is DNS-failing, the facilitator-fitness probe is moot. Cross-reference in ADR-006 below.

- **Rejected alternatives:**
  - **tx-`from` inference as primary identity source.** Considered (simpler — no declared-field dependency). Rejected: breaks for gasless rails (SKALE+PayAI), where buyer relayer's `from` is not the facilitator. Declared identity is more reliable and more operator-meaningful.
  - **New top-level verdict `facilitator_unfit`.** Considered to give the gap its own verdict equal to `looks_correct` / `upstream_stuck`. Rejected per ADR-007 + ADR-008 same logic: refinement of existing taxonomy belongs in facet, not top-level. Top-level would force downstream consumers (mapper, agenttrust.uk, ideafactorylab.org) to handle a new top-level type for a per-rail signal.
  - **Single composite multi-rail synthesis** (one fitness verdict per merchant aggregating across rails). Considered. Rejected: loses the per-rail information that's actually actionable. `anchor-x402` operator running Base USDC (CDP, `ok`) + JPYC Polygon (self-hosted, `degraded`) needs to know *which* rail is degraded, not "your merchant is partly unhealthy."
  - **Probe-side `/settle` instead of `/verify`.** Considered (more thorough). Rejected: `/settle` writes on-chain — probing would either burn real USDC or be rejected as malformed-with-no-balance; either way produces noise. `/verify` is the read-side health surface; consistent across facilitators by spec.
  - **Defer G to v0.4 to keep v0.3.4 surface tight.** Considered. Rejected: voices are at-or-above bar (Cryptor + TomSmart_ai with Cinderwright 3rd-touch validation); hypeprinter007 + TKCollective fixtures are in flight from #2207 cycle; deferring leaves fixtures sitting idle in `tests/fixtures/` without a consumer rule, same problem as deferring K (per ADR-007).
  - **Configurable per-facilitator probe-timeout knob in v0.3.4.** Considered. Rejected: default 5s is reasonable for known facilitators; per-facilitator override is a v0.4+ refinement if operators ask.

- **What this means concretely for v0.3.4 cycle:**
  - **Execution order:** ADR-005 (this) → [X402-51](https://vahdatfardin.atlassian.net/browse/X402-51) G implementation. Parallel-eligible with K (X402-50), I (X402-52), L (X402-53) — facet additions don't conflict.
  - **Fixture-driven acceptance:** hypeprinter007's `anchor-x402` multi-rail + TKCollective's `/deep-research/skale` SKALE+PayAI fixture. Both already offered; pull into `tests/fixtures/bazaar/captured-responses/` mid-cycle.
  - **Registry data file:** `src/bazaar/facilitator-registry.json` ships with 3 entries (`CDP`, `PayAI`, `x402.org/facilitator`); additive in v0.3.5+ as new facilitators surface.
  - **Cross-link in K + I + L ADRs:** facet ordering in `extensions.bazaar` output is documented in `src/bazaar/json-api.md` — `host_pollution` (L) and `facilitator_fitness` (G) are siblings; `upstream_stuck_cause` (K) and `reachability` (I) are siblings under their respective top-level verdicts.

---

## ADR-006: v0.3.4 I — `service_unreachable` top-level verdict + probe-history state + multi-probe consensus

- **Status:** Accepted
- **Date:** 2026-05-29
- **Context:** Original I scope (committed 2026-05-27 in the v0.3.4 plan) called for a `service_unreachable` sub-verdict distinguishing network-layer-fail from x402-layer-fail. The naive shape — "DNS fails on first probe → emit `service_unreachable`" — was sketched against TomSmart_ai's mapper.db query (2026-05-24) which surfaced ~36 endpoints with `status IS NULL or 0 AND last_seen > 7d AND consecutive_fails > 3`. Three named in that query: `api.hyperclaw.app` (39 fails), `api.adprompt.io` (39 fails), `agent.paywall402.com` (66 fails). Plus the divigent probe (2026-05-23) where DNS doesn't resolve and v0.3.2 mis-classified as `implementation_issue`.

  **TomSmart_ai's Tuesday-2026-05-28 traceroute is the decisive anti-evidence.** Gist: https://gist.github.com/smartflowproai-lang/c57ae6e5aaeaf038e60ce76312d1283a. Sample of **15 endpoints labeled `service_unreachable` in mapper.db** (status IS NULL or 0, bot-farm excluded):
  - 6× HTTP 402 (working x402 — wrongly labeled unreachable)
  - 2× HTTP 200
  - 4× HTTP 308/404/503
  - **2× truly unreachable: 1× NXDOMAIN, 1× connect_refused**

  **13/15 (86.7%) actually reachable on re-probe.** The mapper.db status field is stale: historical state lagging endpoint churn, not current. A v0.3.4 rule keyed naively on this single field would emit ~86% false-positive `service_unreachable` verdicts. Memory `[[service-unreachable-rule-anti-evidence]]` records this anti-evidence; X402-52 comment 2026-05-29 records the AC reshape; Notion v0.3.4 plan section "Evidence accumulation — 2026-05-27 PM" carries the canonical writeup.

  TomSmart's framing (verbatim DM): _"mapper.db status field is stale for most of the cohort, not a clean v0.4 filter candidate as-is. the persistent-NXDOMAIN-over-N-probes subset is clean. broader cohort needs multi-probe consensus + failure-mode classification (DNS vs TCP refused vs TLS) before service_unreachable is reliable."_

  Promoted voices: **divigent probe** (DNS-fail real example) + **TomSmart_ai mapper.db** (cohort evidence + anti-evidence reshape). Strictness bar met at 2 voices; AC must now resolve the design questions the anti-evidence raised before X402-52 implementation can start.

- **Decision:** `service_unreachable` ships as a **top-level verdict** (sibling to `looks_correct` / `upstream_stuck` / `implementation_issue`), gated on multi-probe consensus + failure-mode classification. The naive single-snapshot approach is rejected by anti-evidence.

  **Required AC additions (vs original X402-52 scope):**

  1. **Multi-probe consensus** — `service_unreachable` verdict requires probe failure across **N consecutive probes** (configurable via `--unreachable-consensus-count <n>`, default `3`, spaced ≥`--unreachable-probe-interval <duration>` default `5m`). Single-probe failure does **NOT** promote to top-level verdict.

  2. **Failure-mode classification axis** — every probe attempt emits `reachability` facet with one of:
     - `unreachable_cause: dns_failure` — NXDOMAIN, NS unreachable, no A/AAAA records
     - `unreachable_cause: tcp_refused` — DNS resolved, port connect refused (no listener)
     - `unreachable_cause: tls_error` — TCP connected, TLS handshake failed (cert validation, protocol mismatch, ALPN)
     - `unreachable_cause: timeout` — TCP connected, HTTP request issued, no response within bounded window (default 10s)
     - `unreachable_cause: persistent_5xx` — HTTP responded with 5xx consistently — *server malfunction*, **not** unreachable in network sense; emitted under `reachability` facet but does **not** promote to `service_unreachable` top-level even with consensus (synthesizes to existing `upstream_issue`)
     Each cause carries distinct remediation copy in human-format output.

  3. **Persistent-NXDOMAIN floor ships first.** Among the failure modes, NXDOMAIN-over-N-probes is the cleanest subset (TomSmart's analysis: 1/15 in his sample was true NXDOMAIN). It's the smallest cohort but the highest-confidence signal. Implementation order: NXDOMAIN-over-N-probes → tcp_refused-over-N-probes → tls_error-over-N-probes → timeout. Each subsequent failure mode adds noise; ship in order of cleanliness.

  4. **Single-probe DNS-fail handling.** Emits `reachability: { state: 'unreachable_first_probe', cause: 'dns_failure' }` facet but synthesizes to existing `implementation_issue` verdict + INFO note in human-format output: _"DNS resolution failed on first probe — may be transient; re-run with `--unreachable-consensus-count 3` to confirm. Persistent NXDOMAIN promotes to top-level `service_unreachable` verdict."_ Does **NOT** promote to top-level `service_unreachable` on first probe.

  **Architectural decision — probe-history state boundary:** v0.3.4's `service_unreachable` is the **first verdict that requires probe-history state**. Pre-v0.3.4 verdict taxonomy was deterministic-per-probe (every verdict emitted purely from data captured in the current `bazaar-check` invocation). Multi-probe consensus requires the engine to read prior probe state.

  Resolved: **inline in JSONL log** (re-probe reads prior emissions via `event: bazaar.probe_attempt`). External state (config or cache dir under `~/.x402trace/` or similar) **rejected** — adds a new boundary the engine doesn't have, complicates uninstall, introduces stale-cache failure modes, breaks the "local-first stateless" property of v0.1..v0.3.3.

  **JSONL schema addition:** new event discriminant `bazaar.probe_attempt` emitted by every reachability probe (success or fail), with fields: `attempt_seq` (1-indexed), `probed_at_ms`, `unreachable_cause` (null on success), `latency_ms`, `service_url`. Re-probe reads the merchant's last-N probe attempts from the same JSONL log to determine if consensus threshold is met. Documented additively in `src/decoder/schema.md` per the schema-stability discipline (no breaking changes to existing discriminants).

  **Exit code question:** lean **fold-into-3** for v0.3.4 (`service_unreachable` → exit code 3, same as existing `upstream_issue` bucket). New exit code 4 proposed in a future v0.4 ADR with deprecation cycle. Rationale: exit-code surface is a three-value contract per ADR-004 Pillar 2; adding a new code is a breaking change for CI integrations; v0.3.4 prefers additive JSON facets over breaking exit-code expansion.

  **Probe protocol detail (DNS / TCP / TLS classification):**
  - DNS resolution via Node's `dns.resolve4` + `dns.resolve6`; classify NXDOMAIN if both fail with `ENOTFOUND` or `ESERVFAIL`.
  - TCP connect via raw socket, classify `tcp_refused` on `ECONNREFUSED` (post-DNS-resolved).
  - TLS handshake via Node's `tls.connect`, classify `tls_error` on `CERT_HAS_EXPIRED`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `ALPN_PROTOCOL_MISMATCH`, etc.
  - HTTP `timeout` via fetch with bounded timeout; classify on `AbortError` after timeout window.
  - `persistent_5xx` classified after ≥3 consecutive 5xx responses (separate threshold from consensus N; 5xx is consistency-of-server-error not consistency-of-unreachable).

  **Documentation generalization:** `src/bazaar/diagnose-rules.md` adds a `reachability` section with the probe-history-via-JSONL pattern documented as the **first stateful verdict** and the precedent for any future stateful verdicts. Includes the explicit anti-pattern: _"Do not key verdicts on third-party single-snapshot status fields (e.g., mapper.db status=0). Use multi-probe consensus."_

- **Consequences:**
  - **Enables.** Distinguishes network-layer-fail from x402-layer-fail at the top-level verdict surface. Operators with DNS-failing services get `service_unreachable` instead of misleading `implementation_issue`. TomSmart's mapper.db `consecutive_fails > 3` cohort can be re-verified via x402trace's multi-probe pipeline and the truly-unreachable subset (~13.3% per his sample) confirmed. The probe-history-via-JSONL pattern establishes a precedent for future stateful verdicts without requiring a new state boundary.
  - **Restricts.** Top-level `service_unreachable` requires N probes spaced ≥M minutes — a single `bazaar-check` invocation **cannot** emit `service_unreachable` from a one-shot run; the verdict requires re-probes over time. Single-probe mode emits the facet under `implementation_issue` with an INFO note (preserves backward-compat for users running `bazaar-check` once-off). Probe-history state inlined in JSONL means re-probes must operate on the same log file (operators piping `bazaar-check` output through `jq` or other transforms lose history); documented constraint.
  - **Risks.**
    1. **JSONL-as-state-store fragility.** Medium. If the JSONL log is rotated, truncated, or piped through a transform that drops `bazaar.probe_attempt` events, re-probe sees no history and synthesizes back to single-probe `implementation_issue` mode. Mitigation: `bazaar-check --log <file>` is the canonical pattern; document that probe-history requires the same `--log` file across runs; emit warning when consensus threshold > 1 and no prior probe-history found.
    2. **Multi-probe latency makes `service_unreachable` only useful in scheduled re-probe contexts.** Medium. Operators doing one-shot `bazaar-check` won't see top-level `service_unreachable`. Mitigation: README + CHANGELOG explicitly call out the consensus discipline; provide an example `cron` invocation for scheduled re-probes; the `reachability` facet emits on single-probe so CI integrations get *something*.
    3. **DNS caches between probes can mask transient NXDOMAIN recoveries.** Low-medium. Mitigation: probe explicitly with `dns.setServers(['1.1.1.1', '8.8.8.8'])` or document that operators may need to flush DNS cache; consensus interval default 5min should exceed most DNS TTLs.
    4. **TLS handshake classification depends on Node.js error names which may change across versions.** Low. Mitigation: error-code classification is a small allowlist with fallback to `tls_error: unknown`; `dist/` compiled against the supported Node.js range (20+, 22+); test fixtures cover Node 20 and 22 explicitly per the existing CI matrix.
    5. **`persistent_5xx` may overlap with K's `payload_echo_gap` rule or G's `facilitator_fitness: degraded`.** Medium. Mitigation: `persistent_5xx` is a server-level signal under `reachability` facet; ADR-007 (K) operates on a different evidence surface (payment-payload-side, not service-response-side); ADR-005 (G) operates on the facilitator endpoint, not the merchant service. Documented cross-facet precedence: `service_unreachable` > `upstream_stuck (payload_echo_gap)` > `facilitator_fitness` > `looks_correct`. A service that fails DNS doesn't get `upstream_stuck_cause` or `facilitator_fitness` because it never reached the upstream surfaces those probe.
    6. **Probe behavior could be interpreted as scanning by operators of probed services.** Low-medium. Mitigation: probe emits a User-Agent string `x402trace/<version> (https://github.com/fardinvahdat/x402trace; debug-tool)`; documented in README + `src/bazaar/diagnose-rules.md`; probe rate is bounded by consensus interval (≥5min default); only probes services the user explicitly passed to `bazaar-check`.
    7. **Stale cohort signal in mapper.db (TomSmart's anti-evidence) could recur with other third-party mappers.** Low. Mitigation: documentation anti-pattern in `src/bazaar/diagnose-rules.md` generalizes the lesson; future third-party-mapper integrations require multi-probe consensus.

- **Rejected alternatives:**
  - **Single-snapshot keying off mapper.db `status` field** (original X402-52 sketch). **Hard reject** per TomSmart's anti-evidence (86.7% false-positive rate). Documented as the canonical anti-pattern in `src/bazaar/diagnose-rules.md`.
  - **External state directory** (`~/.x402trace/probe-history/`) for probe-history. Considered. Rejected: adds a boundary the engine doesn't have; complicates uninstall; introduces stale-cache modes; breaks the local-first stateless property; JSONL-as-state-store is the simpler architecture even with its rotation fragility.
  - **New exit code 4 for `service_unreachable` in v0.3.4.** Considered (clean differentiation for CI). Rejected: exit-code surface is a three-value contract per ADR-004; adding a code is a breaking change; defer to v0.4 with deprecation cycle. v0.3.4 folds `service_unreachable` into existing exit 3 (`upstream_issue` bucket) with the JSON facet carrying the discriminator.
  - **Single-probe `service_unreachable` with `--unreachable-strict-mode` flag for operators wanting consensus.** Considered. Rejected: default should be the safe shape (consensus required); flag-flipping to be more strict is the inversion of how strictness should default. Single-probe mode is the *backward-compat path* (emits facet under `implementation_issue` + INFO note), not the headline behavior.
  - **Consensus threshold via wall-clock instead of probe-count** (e.g., "fails for ≥1 hour"). Considered. Rejected: wall-clock requires the engine to know when the first probe occurred (history-state by another name) AND introduces interval-not-probe-count ambiguity. Probe-count + interval is cleaner and matches the way operators run re-probes (N invocations of `bazaar-check`).
  - **Inline-or-external state runtime knob.** Considered (let operators choose). Rejected: one canonical state store is simpler; the JSONL pattern dovetails with the existing `--log` discipline.
  - **Top-level verdict `network_layer_fail` instead of `service_unreachable`.** Considered (more precise). Rejected: `service_unreachable` is the operator-language framing (per TomSmart's mapper-db column and the dogfood-pain-ranking memory); `network_layer_fail` is engine-internal jargon. Top-level verdict names face operators.
  - **Defer I to v0.4 to keep v0.3.4 scope tight.** Considered. Rejected: 2 voices met (divigent + TomSmart) and anti-evidence reshape is in hand; deferring would leave the divigent verdict mis-classification unfixed and TomSmart's mapper integration without the column it needs. Same logic as K (ADR-007) and L (ADR-008) — voices and infrastructure are in place; deferral has no downside-protection benefit.

- **What this means concretely for v0.3.4 cycle:**
  - **Execution order:** ADR-006 (this) → [X402-52](https://vahdatfardin.atlassian.net/browse/X402-52) I implementation. Parallel-eligible with K (X402-50), G (X402-51), L (X402-53) — different code paths, no scope-overlap with each other beyond the cross-facet precedence documented in Consequences risk #5.
  - **Fixture-driven acceptance:** divigent (DNS-fail real example) → `unreachable_cause: dns_failure` + (with consensus mode) top-level `service_unreachable`. TomSmart's 3 named examples (`api.hyperclaw.app`, `api.adprompt.io`, `agent.paywall402.com`) → run through the multi-probe pipeline and classify the surviving subset. AsaiShota test-echo-cdp (reaches 402) → `reachability: ok` (sentinel for false-positive guard, same pattern as K's contrast voice). Per Notion v0.3.4 plan "Acceptance tests against operator services" section.
  - **JSONL schema additive change:** new `bazaar.probe_attempt` event discriminant. Document in `src/decoder/schema.md` with the probe-history pattern. Schema-stability discipline preserved (no breaking changes to existing discriminants).
  - **New CLI flags:** `--unreachable-consensus-count <n>` (default 3) + `--unreachable-probe-interval <duration>` (default 5m). Document in README + `bazaar-check --help`.
  - **Documentation generalization in `src/bazaar/diagnose-rules.md`:** `reachability` section + the anti-pattern callout (don't key verdicts on third-party single-snapshot status). Becomes the precedent for any future stateful verdict.
  - **Cross-facet precedence documented:** `service_unreachable` > `upstream_stuck (payload_echo_gap)` > `facilitator_fitness` > `looks_correct`. Lands in `src/bazaar/json-api.md`.

---
