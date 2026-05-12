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
  1. [CLAUDE.md](./CLAUDE.md) tentatively named it from project start: *"Wedge: Timeout reconciliation (tentative; confirmed in Week 2 via ADR-001)."*
  2. The [Notion Validation evidence page](https://www.notion.so/35c03c62b26381099eeec3e9c12ce438) "Possible sharp wedges" list ranked it #1 — *"No competitor solves this fully today."*
  3. The X402-6 synthesis ranked **Candidate A (timeout reconciliation, bundled with Candidate E proxy substrate)** at the highest evidence weight by reproduction count + production-money impact + recency.

- **Decision:** **v0.1 wedge = local HTTP proxy as substrate, with a timeout-reconciliation engine on top.** Concretely:
  1. **`x402trace proxy`** — captures every x402 challenge / payment / settlement exchange to a JSONL log. Sits in front of either the buying agent or the paid service, indifferently.
  2. **`x402trace reconcile`** — watches Base Sepolia USDC `Transfer` events via RPC and matches them against pending facilitator-timed-out payments by EIP-3009 nonce + payer + payee + value. When a settled-but-server-thinks-not case fires, emit a structured record (tx hash, payer, resource URL, nonce, time gap, recommended action).
  
  **Scope tightening required for the 5-week timeline (this is load-bearing):**
  - **Base Sepolia only.** No mainnet. No multi-chain. Per [CLAUDE.md](./CLAUDE.md) hard rule 2 and the *"Not multi-chain (Base only for v0.1)"* declaration.
  - **Single facilitator profile.** Default: `https://x402.org/facilitator`. The mock facilitator from X402-3 stays in the test suite. CDP-compat is nice-to-have, not required for v0.1.
  - **One scheme:** `exact` EVM. No SVM, no Lightning, no escrow.
  - **Detect-and-notify only.** Emit a structured log record. **No auto-refund. No auto-replay.** Those are v0.2 territory; v0.1's job is observability, not remediation.

- **Consequences:**
  - **Enables.** Direct attack on the canonical [#1062](https://github.com/x402-foundation/x402/issues/1062) case (facilitator timeout race condition on Base). Inverse-direction detection of [#1805](https://github.com/x402-foundation/x402/issues/1805) (replay/duplicate-debit) falls out for free — same nonce, multiple inbound requests. The proxy substrate compounds: every v0.2+ feature (`inspect`, `doctor`, `bazaar-check`, `versions`) reads its data.
  - **Restricts.** v0.1 will NOT address the Bazaar indexing failure cluster (X402-5 #2112, #1982, #2162, #2156, #1461), which is the *loudest currently-active* pain — 5 OPEN issues, multi-team reproductions, visibly degraded patience. Those filers won't be our v0.1 users. This is a tactical loss; positioning argument is that the timeout-reconciliation story is more durable and the Bazaar issues may resolve themselves as CDP iterates.
  - **Risks.**
    1. **L-effort in ~5 weeks is tight.** The scope-tightening above is not optional. Auto-refund creep, multi-chain creep, multi-facilitator creep, multi-scheme creep — any of them blows the timeline.
    2. **On-chain RPC complexity.** Rate limits, reorgs (Base reorgs are rare but real), event-filter gaps, RPC provider downtime. Need to pick a strategy (Alchemy free tier? viem default? public node?) and have a fallback.
    3. **Reconciliation-action ambiguity.** "What does the reconciliation engine *do* when it fires?" — emit a log line is the v0.1 answer, but downstream consumers (the agent? the merchant? the operator?) will want different things. Defer the answer; capture in JSONL and let consumers decide.
    4. **CDP could fix #1062 upstream.** The canonical case has been open ~4 months with no fix. If they ship a fix in their v3, the wedge's reason-to-exist weakens — but the reconciliation engine still detects every other facilitator's equivalent gap (PayAI, x402-rs, custom), so the substrate retains value.
    5. **#1860 was closed without acceptance.** The community's diagnostic-extension RFC didn't land in the spec. We're betting that x402trace's reconciliation-record format becomes the de facto layer the RFC asked for. If a competitor (PaySentry, xpay) ships first with their own format, we adopt or compete on quality.

- **Rejected alternatives:**
  - **Candidate B — Plain-English error translator + `inspect` + `doctor` + `versions`.** Easier to ship (M-effort, 2–3 weeks). Lower differentiation: x402lint already covers ~70% of `versions`; the rest is closer to "developer convenience" than "developer money saved." **Defer to v0.2** where these tools sit on the v0.1 proxy substrate cleanly (`inspect` reads the proxy's JSONL log; `doctor` shares spec-validation logic).
  - **Candidate C — Bazaar discovery diagnostics.** Addresses the *loudest currently-active* pain cluster (5 OPEN X402-5 issues) and would have a vocal audience this month. Rejected as v0.1 because:
    - Narrow ceiling: if CDP fixes their Bazaar indexing pipeline (single-vendor dependency on `/discovery/resources`), the tool's reason-to-exist evaporates.
    - The same proxy substrate from this ADR enables `bazaar-check` in v0.2 trivially — defer, don't kill.
  - **Candidate D — Cross-facilitator behavior diff.** Real differentiation vs. xpay/x402scan/zauth (which all *claim* cross-facilitator but only mean "different URLs in our config"). Rejected as v0.1 because:
    - Demand thin: multi-facilitator users are <10% of x402.org listings per the Notion data.
    - Auth complexity is a long pole (CDP JWT, PayAI bearer, x402-rs whatever) — supporting >1 facilitator's auth in 5 weeks competes for time with the reconciliation engine.
    - Defer to v0.2+ when multi-facilitator users grow.
  - **Candidate E alone — proxy + structured logging only.** Foundational but weak standalone pitch ("yet another observability tool"). The proxy is included in this ADR's choice, just *bundled with* reconciliation rather than shipped alone.

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

  | X402-20 candidate | Pain rank addressed | Already covered by v0.1 |
  |---|---|---|
  | `--validate` (pre-flight) | **#4 — Wallet-state pre-flight gap** | ❌ Not addressed |
  | `--explain` (offline 402 decode) | **#3 — Generic 402 with no error reason** | ❌ Not addressed |
  | `--diff` (cross-facilitator) | #5 — Cross-facilitator drift | ❌ Not addressed |
  | `--watch` (daemon + alerting) | extends #1 | ✅ v0.1 detects in real-time |
  | `--replay` (re-fire logged) | no specific pain rank | ❌ |

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
  - **Restricts.** v0.2 still won't address Bazaar indexing (pain rank #2 — the loudest *currently-active* cluster) or cross-facilitator drift (#5). The Bazaar audience continues to be unserved; this is a tactical loss. Mainnet support (#1 in [SPEC.md § 5 v0.2 stretch](./SPEC.md#5-v02-stretch-deferred-not-killed)) also slips to v0.3.
  - **Risks.**
    1. **`validate`'s wallet-kind detection is the hard part.** EOA is trivial; Smart Wallet detection requires a contract-code check + signature-style probe. ERC-6492 is documented (the wrapped signature) but the heuristics aren't 1:1. v0.2 will ship EOA + Smart Wallet only and document the ERC-6492 gap as a known limitation — better than an unreliable detection.
    2. **`explain` overlaps with `inspect`.** v0.1's `inspect` already replays a captured JSONL log offline. The line between "inspect" (replay reconciliation) and "explain" (diagnose a single 402) needs to be explicit in the SPEC: `inspect` is bulk + temporal, `explain` is single-record + per-failure prose.
    3. **Diagnostic-rule engine becomes a v0.2 contract.** Every new x402 spec edge case requires a new rule. The rule set is the source of truth users will read; sloppy rules erode trust faster than missing ones. Mitigation: each rule has a corresponding integration test using a captured fixture from `tests/` or `dogfood-notes.md § Failure modes`.
    4. **Audience overlap with x402lint.** x402lint already does some config-level validation. `validate` differentiates by being *runtime* (wallet + chain state) vs x402lint's *static* (config + types). Make this distinction explicit in the README / docs to avoid "they already do this" objections.

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
