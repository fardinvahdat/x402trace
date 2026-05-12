# SPEC.md — x402trace v0.1

> **Status:** Accepted (Week 2). Implements the wedge locked in [ADR-001](./DECISIONS.md#adr-001-v01-wedge). Read this and [CLAUDE.md](./CLAUDE.md) before opening any Week-3+ ticket.

---

## 1. Problem

The x402 payment protocol promises pay-then-fetch in one HTTP round-trip, but the round-trip is not atomic. When the facilitator times out on `/verify` or `/settle`, the on-chain `transferWithAuthorization` can still complete — wallet debited, server has no payment record, autonomous buyer has no recovery path. [coinbase/x402 #1062](https://github.com/coinbase/x402/issues/1062) is the canonical case ("100% failure rate"); the inverse failure is [x402-foundation/x402 #1805](https://github.com/x402-foundation/x402/issues/1805) (one settlement proof reused across concurrent requests, duplicate debits later refunded). Both are the same observability gap: no one place shows "what is the facilitator actually doing with my payload, end-to-end."

## 2. Solution

x402trace is a local CLI:

- **Proxies x402 traffic.** Sits between an x402 client and a paid service; captures every 402 challenge, X-PAYMENT header, and settlement response to a JSONL log on disk.
- **Watches the chain.** Connects to a Base Sepolia RPC and subscribes to USDC `Transfer` events emitted from EIP-3009 `transferWithAuthorization` calls.
- **Reconciles.** Matches facilitator-timed-out payments against the on-chain event stream by `(payer, payee, value, nonce)`. When matched, emits a `RECONCILED` record naming the tx hash, the resource URL, and the time gap.
- **Local only.** No cloud, no auth, no API. Logs are JSONL files the operator owns.

## 3. User flow

```bash
$ x402trace proxy --upstream https://api.example.com --port 8402 --reconcile
[x402trace] proxy   :  http://localhost:8402  →  https://api.example.com
[x402trace] watcher :  Base Sepolia (chain 84532) via https://sepolia.base.org
[x402trace] log     :  ./x402trace.jsonl

# (an agent makes paid requests through the proxy; one of them times out at the facilitator)

[x402trace] 2026-06-15T14:21:03Z  facilitator timeout
              payer=0xADEeaf…B895   resource=/api/weather
              nonce=0xa3f2…   waiting on-chain (max 60s)…

[x402trace] 2026-06-15T14:21:34Z  RECONCILED  ⚠ settled-but-server-thinks-not
              tx=0xc5758bf2…6cbf   payer=0xADEeaf…B895 → payee=0xADEeaf…B895
              value=1000 (= $0.001 USDC)   gap=31s
              full chain: x402trace.jsonl#L142–L147
```

## 4. v0.1 scope

**In:**

- `x402trace proxy --upstream <url> --port <n> [--reconcile]` — forward-proxy x402 traffic to disk
- `x402trace reconcile --log <file.jsonl>` — re-run reconciliation against an existing log (offline)
- Base Sepolia RPC client (default `https://sepolia.base.org`; override via `--rpc-url`)
- Single facilitator profile: `x402.org/facilitator`
- Single scheme: `exact` EVM
- Detect-and-notify: structured records to JSONL + colored stdout. **Nothing else.**

**Out:**

- Mainnet (testnet-only until v0.1 ships and runs ≥1 week without panics)
- Any chain other than Base Sepolia
- Auto-refund, auto-replay, auto-retry
- Multi-facilitator support
- SVM / Lightning / escrow schemes
- Hosted dashboard, web UI, persistent DB, alerts, team accounts, auth, webhooks

## 5. v0.2 scope (picked in [ADR-002](./DECISIONS.md#adr-002-v02-feature-pick--validate-primary--explain-paired))

**Two new subcommands sharing one diagnostic engine.** Together they close pre/post-payment debugging — v0.1 owns mid-flight (the proxy) + post-settlement (the reconciliation engine).

- **`x402trace validate <wallet> <service>`** — pre-flight check before signing. Reuses v0.1's chain client (USDC balance, allowance, EIP-3009 nonce status) + decoder (parse the service's 402 challenge). Reports "you would succeed" / "you would fail because X" with the actionable fix per failure. Closes [X402-6 pain rank #4](./dogfood-notes.md#top-painful-moments-synthesized---x402-6) (wallet-state pre-flight gap). Wallet kinds: EOA + Smart Wallet in v0.2; ERC-6492 deferred to v0.3.
- **`x402trace explain <captured-402.json | jsonl-log>`** — offline plain-English diagnosis of a single 402 or a `reconcile.result` line from the v0.1 JSONL log. Runs the same diagnostic-rule engine as `validate` against captured state. Closes [pain rank #3](./dogfood-notes.md#top-painful-moments-synthesized---x402-6) (generic 402 with no error reason). Distinct from v0.1's `inspect`: `inspect` is bulk + temporal (replay a whole reconciliation log), `explain` is single-record + per-failure prose.

New module `src/diagnose/` holds the rule engine; both subcommands are thin wrappers.

### v0.3 stretch (kept, not killed)

- Mainnet (gated on ≥1 week of clean testnet traffic per [§ 6](#6-success-criteria))
- ERC-6492 wallet-kind support in `validate`
- `x402trace diff cdp,payai,x402-rs <payload>` — cross-facilitator behavior diff ([dogfood-notes Candidate D](./dogfood-notes.md#candidate-d-cross-facilitator-drift-dashboard-rank-5))
- `x402trace bazaar-check` — Bazaar indexing diagnostics (pain rank #2)
- `x402trace versions` — SDK-skew audit (pain rank #7)
- `--watch` daemon mode with alerting integrations (PagerDuty / webhook / Slack)
- `--replay` re-fire-with-modification — only worth shipping with multi-signer support
- Reconciliation actions beyond JSONL log (webhook, structured remediation, optional auto-retry)

## 6. Success criteria

v0.1 is **done** when all of these are true:

- [ ] `x402trace proxy --upstream <X402-3-dogfood-rig> --reconcile` runs against the [deployed dogfood URL](https://x402trace-dogfood-git-v1-fardinvahdats-projects.vercel.app) and logs the full happy-path 402→200 to JSONL with no panics.
- [ ] [X402-15](https://vahdatfardin.atlassian.net/browse/X402-15) end-to-end demo — mock facilitator deliberately stalled past Base block confirmation — produces a `RECONCILED` record with the correct tx hash within 30s of on-chain settlement.
- [ ] `pnpm test:coverage` reports ≥80% line coverage on the reconciliation engine; integration tests cover proxy + decoder + reconcile end-to-end against the mock facilitator (no real on-chain spend in CI).
- [ ] `npx x402trace --help` works on a fresh `node:20` Docker image with no prior install.
- [ ] README quickstart works from a fresh clone in <5 minutes.

## 7. Out of scope (explicit non-goals)

- Authentication, user accounts, API keys
- Web UI, dashboard, hosted anything
- Multi-user collaboration, team features
- Chains other than Base Sepolia
- Mainnet (until success-criteria are met on testnet)
- Reconciliation **actions** (refund, replay, retry) — only detection in v0.1
- Multi-facilitator support — single profile only
- SVM / Lightning / escrow schemes

## 8. Differentiation

How x402trace differs from existing tools in the x402 ecosystem (catalogued in [Notion Validation evidence § Competitive landscape](https://www.notion.so/35c03c62b26381099eeec3e9c12ce438)):

- **vs xpay** — xpay does spending controls + a dashboard ("Datadog for x402"). Does not match facilitator timeouts to on-chain settlements. **Reconciliation is the gap.**
- **vs x402scan** — x402scan is an explorer (Etherscan-for-x402); shows on-chain truth. Does not see your server's view. **Reconciliation needs both sides.**
- **vs x402lint** — config validator, runs pre-deploy. Doesn't observe the running system. Complementary.
- **vs x402-watch** — uptime monitor; doesn't parse x402 protocol semantics. **Decoder + structured log is the gap.**
- **vs zauth / PaySentry** — both ship partial timeout handling (zauth's auto-refund, PaySentry's retry). Neither matches against on-chain `transferWithAuthorization` events. **They treat the symptom; x402trace observes the cause.**
