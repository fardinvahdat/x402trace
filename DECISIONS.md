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
