# x402trace

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![CI](https://github.com/fardinvahdat/x402trace/actions/workflows/ci.yml/badge.svg?branch=v1)](https://github.com/fardinvahdat/x402trace/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/x402trace.svg)](https://www.npmjs.com/package/x402trace)

**A local CLI debugger for [`x402`](https://x402.org) — the HTTP-402-based agentic-payment protocol** — on Base. Verified against real Base Sepolia + the production `x402.org/facilitator`, three independent live reconciliations on-chain (latest: [`0x116ccf73…ba52`](https://sepolia.basescan.org/tx/0x116ccf73fa77eda19aea149606042f1e848e8afe2f719a0d2890dd2b2ff0ba52)).

![x402trace catching a real Base Sepolia timeout-reconciliation failure end-to-end](./examples/cast/e2e-timeout-reconciliation.gif)

_Real-time capture of the `RECONCILED ⚠ settled-but-server-thinks-not` detection against live Base Sepolia + `x402.org/facilitator`. ~17 seconds, real on-chain tx. Cast file replayable with `asciinema play examples/cast/e2e-timeout-reconciliation.cast`._

## When to use x402trace

- **Your buyer's wallet was debited but the server says payment failed** — the canonical [coinbase/x402#1062](https://github.com/coinbase/x402/issues/1062) reconciliation gap. [`x402trace proxy --reconcile`](#cli) detects it in seconds against live USDC `Transfer` events; `x402trace inspect` replays captured logs offline.
- **You want to pre-flight a wallet before signing** — USDC balance, EIP-3009 nonce status, wallet kind (EOA vs Smart Wallet). `x402trace validate <wallet> <service-url>` is read-only and exits non-zero if the payment would fail.
- **You got a cryptic `Bad Gateway` or a generic 402** and need plain-English diagnosis. `x402trace explain <jsonl-log>` runs 10 diagnostic rules against captured payment state and tells you what was wrong, with actionable fixes per failure.
- **You're shipping an agent that pays for HTTP APIs** and want a JSONL audit trail of every 402 / X-PAYMENT / settlement your client or server produced. `x402trace proxy` records it.

## The four subcommands at a glance

```
     BEFORE SIGNING         DURING PAYMENT          POST-SETTLEMENT          ON FAILURE
  ────────────────────  ──────────────────────  ──────────────────────  ─────────────────────
  ┌──────────────────┐  ┌──────────────────┐    ┌────────────────────┐  ┌───────────────────┐
  │  validate        │  │  proxy           │    │  inspect           │  │  explain          │
  │  ─────────       │  │  ─────           │    │  ───────           │  │  ───────          │
  │  Pre-flight a    │  │  Live capture    │    │  Offline replay    │  │  Plain-English    │
  │  wallet against  │  │  of every        │    │  of a captured     │  │  diagnosis of     │
  │  a service's     │  │  X-PAYMENT       │    │  log + re-run      │  │  every failed     │
  │  402 challenge   │  │  exchange        │    │  reconciliation    │  │  exchange         │
  └──────────────────┘  └──────────────────┘    └────────────────────┘  └───────────────────┘
     USDC balance         JSONL audit log          settled_on_chain        actionable fix
     EIP-3009 nonce       Joins on-chain           not_settled              per failed rule
     Wallet kind          USDC Transfers           value/recipient_         (10 rules)
                          by EIP-3009 nonce        mismatch
```

---

## The problem

You wire up [x402](https://x402.org) on Base Sepolia. A buyer sends `X-PAYMENT`. The facilitator broadcasts the EIP-3009 `transferWithAuthorization` — and then hangs. Your `paymentMiddleware` times out and your client gets back:

```
HTTP/1.1 502 Bad Gateway
content-type: text/plain

Bad Gateway
```

The buyer sees a failure. The buyer's wallet was actually debited. The on-chain receipt exists, but nothing in your logs points at it. You have no programmatic path to reconcile.

This is the [#1062](https://github.com/coinbase/x402/issues/1062) gap. **x402trace closes it.**

## 30-second quickstart

> Requires Node ≥ 20, pnpm, and a Base Sepolia test wallet funded with USDC + dust ETH. See [`examples/README.md`](./examples/README.md) for the full prereq list.

```bash
# 1. Install
git clone https://github.com/fardinvahdat/x402trace.git
cd x402trace
pnpm install

# 2. Populate .env (one-time)
cp .env.example .env
$EDITOR .env   # set PAYER_PRIVATE_KEY + RECEIVER_ADDRESS

# 3. Run the canonical #1062 demo (real Base Sepolia, ~17s)
./examples/e2e-timeout-reconciliation.sh
```

The last line of output is the detection x402trace was built for:

```
RECONCILED ⚠ settled-but-server-thinks-not  id=35d9aea1…
  tx=0x116ccf73…  value=1000  payer=0xADEe…B895 → payee=0xADEe…B895  gap=11904ms
```

That `tx=` field is a real Base Sepolia settlement — [view it on basescan](https://sepolia.basescan.org/tx/0x116ccf73fa77eda19aea149606042f1e848e8afe2f719a0d2890dd2b2ff0ba52). An asciinema replay of the full run is committed at [`examples/cast/e2e-timeout-reconciliation.cast`](./examples/cast/e2e-timeout-reconciliation.cast) — `asciinema play` it locally.

## Install

```bash
npm install -g x402trace      # or `pnpm add -g x402trace`, `npx x402trace --help`
```

Requires Node ≥ 20.

> **Node 22 + `npx` users:** if `npx x402trace` hangs with no output, install globally instead (`npm i -g x402trace`) or pin to Node 20 (`nvm use 20`). This is a known Node 22 ESM-resolver interaction with a transitive dep that anchor-x402 / x402-fetch consumers ride on; `npm i -g` and `pnpm add -g` are not affected. Tracked at [X402-40](https://vahdatfardin.atlassian.net/browse/X402-40).

## How it works

```
┌────────┐     ┌────────────┐     ┌──────────┐     ┌─────────────────────┐
│ client │ ──► │ x402trace  │ ──► │  your    │ ──► │ x402.org/facilitator│
└────────┘     │   proxy    │     │  server  │     └──────────┬──────────┘
               └──────┬─────┘     └──────────┘                │
                      │                 ▲                     │ /settle
                      │                 │ slow/timeout      broadcasts
                      │                 │                     ▼
                      │           ┌─────┴────────┐     ┌──────────────┐
                      │           │ reconcile    │ ◄── │ Base Sepolia │
                      └──────────►│ engine       │     │ USDC Transfer│
                                  └──────────────┘     └──────────────┘
```

- **Proxy** — sits between the client and your x402 server. Captures every `X-PAYMENT` / `X-PAYMENT-RESPONSE` header to a JSONL log.
- **Decoder** — turns each captured request into structured `PaymentRequirements` / `PaymentPayload` / `FacilitatorResponse` records.
- **Chain client** — subscribes to Base Sepolia USDC `Transfer` events, enriches each with the matching EIP-3009 `AuthorizationUsed.nonce`.
- **Reconciliation engine** — joins facilitator-rejected exchanges against on-chain transfers by `(payer, payee, value, nonce)` and emits `settled_on_chain` / `not_settled` / `value_mismatch` / `recipient_mismatch`.

Full architecture: [ARCHITECTURE.md](./ARCHITECTURE.md). Wedge rationale: [DECISIONS.md → ADR-001](./DECISIONS.md). On-disk schema: [`src/decoder/schema.md`](./src/decoder/schema.md).

## CLI

```bash
# v0.1 — during/after payment
x402trace proxy    --upstream <url> [--reconcile] [--log human|json] …
x402trace inspect  <jsonl-log-file> [--log human|json] …

# v0.2 — before/explaining payment
x402trace validate <wallet> <service-url> [--strict] [--log human|json]
x402trace explain  <jsonl-log-file> [--log human|json]
```

The full pre/during/post-payment debugger:

- **`validate <wallet> <service>`** — read-only pre-flight before signing. Fetches the 402, queries USDC balance + EIP-3009 nonce + wallet kind, runs 10 diagnostic rules, prints a plain-English report. Exits 0 if the payment would succeed, 2 if it would fail. Closes [pain rank #4](./dogfood-notes.md#top-painful-moments-synthesized---x402-6) (wallet-state pre-flight gap).
- **`explain <jsonl-log>`** — read a JSONL log produced by `proxy --reconcile`, find every exchange that didn't `settled_on_chain`, run the same rule engine against the captured state, print per-failure prose with actionable fixes. CI-friendly: exits 2 if any failures, 0 if clean. Closes [pain rank #3](./dogfood-notes.md#top-painful-moments-synthesized---x402-6) (generic 402 with no error reason).

The authoritative flag list is `x402trace --help` (or per-subcommand `--help`) — wired into the unit tests so it can't drift.

### `versions` (v0.3+) — SDK skew audit

Compares your local `package.json` `@x402/*` versions and the service's 402 version hints against a bundled known-skew table. Catches the kind of multi-day debugging chase Myceliaman14 (Python SDK pre-v2 → TS V2 refactor) and Poteshniy (`@x402/fetch 2.10.0` extension-echo bug) hit on Discord.

```bash
x402trace versions https://your-service.example/api/route
x402trace versions https://… --log json
```

Output names each match with severity (`warning` / `blocking`), the upstream evidence link (#2157, #2207), and a concrete fix. Exit `0` = no skew, `2` = at least one match.

### `validate --diff` (v0.3+) — cross-facilitator drift detection

When a payment works on one facilitator but fails on another (TerraDeed's CDP → xpay switch in the Discord transcript), `--diff` runs the same synthesised payload through both `/verify` endpoints in parallel and shows you exactly where they disagree.

```bash
# Built-in aliases: cdp, xpay, payai, x402.org. Full URLs also accepted.
x402trace validate 0xYourWallet https://your-service.example/api/route --diff cdp,xpay

# JSON output for CI; per-facilitator timeout knob
x402trace validate 0xYourWallet https://… --diff cdp,xpay --log json --diff-timeout-ms 5000
```

Each row reports the per-facilitator HTTP status + body, captured rejection reason, and any X402-33 facilitator-aware rules firing (e.g. CDP minimum amount, throttling 403/429). Exit codes: `0` = at least one accepts, `2` = all reject, `3` = all timeout.

### `bazaar-check` (v0.3+) — pre-ship Bazaar / agentic.market validator

The headline of v0.3. Answers the question Discord operators are asking each other in real-time: **"is my Bazaar / agentic.market integration implemented correctly, or is the bug upstream of me?"**

```bash
# Default — Base Sepolia
x402trace bazaar-check https://your-service.example/api/route

# Mainnet discovery query (banner printed; still read-only)
x402trace bazaar-check https://your-service.example/api/route --chain base

# With a payer-hint (enables the self-payment guard)
x402trace bazaar-check https://your-service.example/api/route --payer-hint 0xYourPayer

# Shorten the per-request HTTP timeout for CI/smoke checks
x402trace bazaar-check https://your-service.example/api/route --timeout-ms 5000
```

Four read-only checks compose into a single bottom-line verdict:

| Check          | What it validates                                                                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `well-known`   | `/.well-known/x402` manifest exists with `name` + `description` + `accepts[]`                                                                                                        |
| `challenge`    | The protected endpoint returns 402 with a valid x402 v1/v2 body AND `extensions.bazaar.{name, description}`                                                                          |
| `self-payment` | When `--payer-hint` is supplied, flags `payer == payTo` (CDP rejects this with a generic `invalid_payload`)                                                                          |
| `indexing`     | CDP discovery (`/v2/x402/discovery/resources?payTo=…`) returns non-empty resources (else: matches the [#2207](https://github.com/x402-foundation/x402/issues/2207) upstream pattern) |

**Exit codes:**

- `0` — looks correct
- `2` — found issues in your implementation (fix the failed check)
- `3` — your code looks correct; the bug is upstream (e.g. the canonical [#2207](https://github.com/x402-foundation/x402/issues/2207) Bazaar indexing failure — 94 reports). The verdict prose names the GitHub issue so you don't have to map the symptom.

**Scope notes:**

- Read-only. Never signs, never broadcasts.
- Each HTTP probe has a 10s default timeout; use `--timeout-ms` to shorten it in CI or when checking flaky endpoints.
- The opt-in paid-pass mode (`--with-wallet`) is **deferred** — see [ADR-003](./DECISIONS.md). The static-analysis-only checks shipped here cover the dominant Discord pain (Bazaar indexing failure) without needing signing infrastructure.
- **`--endpoint <paid-url>` (v0.3.2+)** — skip the root `/.well-known/x402` probe and read the 402 challenge directly from a paid route. Use this for services that publish per-route only (the [#2207](https://github.com/x402-foundation/x402/issues/2207) shape — AsaiShota's test-echo-cdp, evanatpizzarobot's TensorFeed, 0xdespot's hyperD).

### JSON API (v0.3.2+) — `--log json` is a public contract

`bazaar-check --log json` emits a JSON envelope downstream consumers can take a runtime dependency on. Per [ADR-004 Pillar 2](./DECISIONS.md), the maintainer commits to:

- **Additive changes** (new optional fields, new optional facets) — ship in MINOR versions
- **Shape-breaking changes** (renames, removals, type changes, fixed-position reordering) — require a MAJOR version + integrator notice
- Every change to the `--log json` output is documented in `CHANGELOG.md` under a `### JSON API` subsection

The full contract — envelope shape, per-check `detail` keys, verdict discriminator, regeneration workflow — lives at [`src/bazaar/json-api.md`](./src/bazaar/json-api.md). A frozen exemplar lives at [`tests/fixtures/bazaar/json-api-snapshot.json`](./tests/fixtures/bazaar/json-api-snapshot.json) and is enforced by [`tests/integration/bazaar-check-json-api.test.ts`](./tests/integration/bazaar-check-json-api.test.ts).

```bash
# Pipe the JSON into your own consumer
x402trace bazaar-check https://your-service.example.com --log json | jq '.verdict.kind'
# → "looks_correct"  (or "implementation_issue" / "upstream_issue")
```

### Chain selection (Base mainnet, v0.3+)

x402trace v0.3 enables Base mainnet alongside the default Base Sepolia. The `--chain` flag (or `BASE_CHAIN_ID` env) selects the chain; default stays `base-sepolia` for backward compatibility.

```bash
# Default — Base Sepolia (unchanged)
x402trace proxy --upstream <url> --reconcile

# Base mainnet — RPC URL must be supplied; there is no built-in mainnet endpoint
x402trace proxy --upstream <url> --reconcile --chain base --rpc-url https://your-mainnet-rpc

# Validate a mainnet wallet (read-only)
x402trace validate 0xYourWallet https://your-service --chain base --rpc-url https://your-mainnet-rpc
```

**Mainnet safety notes:**

- x402trace never signs transactions and never broadcasts. The worst case from a misconfigured mainnet run is a failed read or a misleading reconciliation verdict.
- The buyer's wallet (which signs the EIP-3009 authorization) is upstream of x402trace. The buyer's risk model is unchanged.
- No mainnet RPC URL is shipped — supply your own via `--rpc-url` or `BASE_RPC_URL` env. Mainnet startup prints a `⚠ MAINNET` banner so accidental mainnet runs are visible at a glance.
- CI never uses mainnet (CLAUDE.md hard rule #2). Don't commit a populated mainnet URL.

### `validate` — example output

![x402trace validate against a live Base Sepolia wallet — all 10 rules pass](./examples/cast/validate-demo.gif)

```
$ x402trace validate 0xADEeaf70…B895 https://example.com/api/weather

diagnose: ✓ would succeed

  ✓ network-match:    network matches: base-sepolia
  ✓ recipient-match:  recipient matches: 0x1111…1111
  ✓ value-sufficient: signed 1000 >= required 1000
  ✓ valid-before:     validBefore=1778573803 is 300s in the future
  ✓ payer-balance:    wallet has 5000000 USDC (raw), needs 1000
  ✓ nonce-fresh:      nonce 0x000000… is fresh
  ✓ wallet-kind:      wallet kind: eoa
  ✓ asset-address:    asset is canonical Base Sepolia USDC
```

A failing run flips the headline to `✗ would fail` and prints a `fix:` line under each failed rule.

### `explain` — example output

![x402trace explain on a captured JSONL log — flags an expired validBefore with the actionable fix](./examples/cast/explain-demo.gif)

```
$ x402trace explain ./x402trace.jsonl

─── exchange 94c15089… not_settled at 2026-05-12T08:13:18Z ───
diagnose: ✗ would fail

  ✗ valid-before:    validBefore=1778573803 expired 97s ago (now=1778573900)
    fix: re-sign the authorization with a later validBefore (typical: now + 300s)

explained 1 failed exchange(s), 0 decoder error(s) from 24 lines
```

## FAQ

**Q: I see `Bad Gateway` from `x402-fetch` but my wallet was debited. What do I do?**
That's the canonical [coinbase/x402#1062](https://github.com/coinbase/x402/issues/1062). Run `x402trace proxy --reconcile --upstream <your-server>` between the buyer and your server; when the chain client matches the EIP-3009 nonce against a failed exchange you'll get a `RECONCILED ⚠ settled-but-server-thinks-not` record with the live tx hash.

**Q: The facilitator returned `invalid_payload` with no explanation. How do I figure out why?**
Save the captured 402 (proxy does this automatically) and run `x402trace explain <log>`. It runs 10 rules against the captured state — most `invalid_payload` cases turn out to be a `validBefore` expiry, value mismatch, or recipient mismatch, each rendered as a single failed rule with an actionable fix.

**Q: Can I check whether a wallet _can_ pay a service without actually signing?**
Yes — `x402trace validate <wallet> <service-url>` is read-only. It fetches the 402, queries chain state (USDC balance, EIP-3009 nonce, wallet kind), runs the same rules `explain` uses. Exits `0` if would-succeed, `2` if would-fail.

**Q: Does this work on mainnet?**
Yes — Base mainnet shipped in v0.3.0 per [ADR-003](./DECISIONS.md#adr-003-v03-feature-pick--bazaar-check-headline--5-facilitator-aware-diagnose-rules--validate---diff--base-mainnet-autonomous-execution-under-strict-6-stage-audit-gate). Pass `--chain base` (or set `BASE_CHAIN_ID=base`) to switch. You must supply your own mainnet RPC URL via `--rpc-url` or `BASE_RPC_URL` env — x402trace ships no default mainnet endpoint (CLAUDE.md hard rule #2). Default stays `base-sepolia` for backward compatibility. See [Chain selection (Base mainnet, v0.3+)](#chain-selection-base-mainnet-v03) above for examples and safety notes.

**Q: My supply-chain scanner shows transitive alerts on dependencies. Are these in x402trace?**
No. As of v0.3.2 the runtime tree is `commander` + `dotenv` + `viem` + `x402` only — the published `dist/` imports nothing else (enforced by `pnpm check:publish-surface` in CI). The test-tooling deps (`hono`, `x402-fetch`, `x402-hono`) are `devDependencies` and are not installed by `npm i x402trace`. Any wallet-SDK / WalletConnect / MetaMask transitives a scanner shows on the package come in via `viem` (read-only chain client). See [SECURITY.md](./SECURITY.md) to report a vulnerability in x402trace itself.

## Roadmap

- **v0.1.0** (2026-05-12) — local proxy + timeout reconciliation. [ADR-001](./DECISIONS.md#adr-001-v01-wedge).
- **v0.2.0 — v0.2.3** (2026-05-12 → 2026-05-13) — `validate` + `explain` on a shared diagnostic rule engine. [ADR-002](./DECISIONS.md#adr-002-v02-feature-pick--validate-primary--explain-paired).
- **v0.3.0** (2026-05-17) — `bazaar-check` (headline), `validate --diff` cross-facilitator, 5 facilitator-aware diagnose rules, Base mainnet support, `versions` SDK-skew audit. [ADR-003](./DECISIONS.md#adr-003-v03-feature-pick--bazaar-check-headline--5-facilitator-aware-diagnose-rules--validate---diff--base-mainnet-autonomous-execution-under-strict-6-stage-audit-gate).
- **v0.3.1** (2026-05-20) — hotfix: v2 challenge body parsing ([#66](https://github.com/fardinvahdat/x402trace/pull/66) by @hypeprinter007-stack — first external contributor), `bazaar-check` HTTP probe timeouts ([#67](https://github.com/fardinvahdat/x402trace/pull/67) by @peterxing), npm package description audit-gap fix.
- **v0.3.2** (current, 2026-05-23) — metadata-propagation cut. D.2 propagation diff (manifest vs CDP discovery render — @zev's api.lastlookdata.com pattern), D.3 indexer-state probe + new `upstream_stuck` verdict (Max's polyodds.bet pattern + the canonical [#2207](https://github.com/x402-foundation/x402/issues/2207) cluster), D.4 `--endpoint <paid-url>` per-route probe (AsaiShota / evanatpizzarobot / 0xdespot's per-route services), D.5 variant-aware `extensions.bazaar` (fixes the [#72](https://github.com/fardinvahdat/x402trace/issues/72) Body-discovery false-positive), public JSON API contract + snapshot tests, facilitator-aware verdict semantics. [ADR-004](./DECISIONS.md). 511 tests.
- **v0.3.3+ planned** — TomSmart cdp-mature + 4 other contributor fixtures wired into the captured-responses harness; `processing_fresh` vs `processing_stale` distinction on D.3 (operator-supplied settle-timestamp); `facilitator-status` if a 2nd CDP outage cluster lands.
- **Deferred (kept, not killed)** — ERC-6492 Smart Wallet kind, `extensions.diagnostic` decoder (gated on [#1875](https://github.com/x402-foundation/x402/pull/1875)), `--watch` daemon, reconciliation actions (webhook / auto-retry), hosted SaaS, multi-chain non-Base, `bazaar-check --with-wallet` paid-pass mode. See [SPEC.md § 5b "v0.3.2+ deferred"](./SPEC.md).

## How x402trace compares

| Capability                                                                             | x402trace |  xpay   | x402scan | x402lint |
| -------------------------------------------------------------------------------------- | :-------: | :-----: | :------: | :------: |
| Local proxy + JSONL audit log                                                          |    ✅     |    —    |    —     |    —     |
| Timeout reconciliation (catches [#1062](https://github.com/coinbase/x402/issues/1062)) |    ✅     | partial |    —     |    —     |
| Pre-flight wallet check (no signing)                                                   |    ✅     |    —    |    —     |    —     |
| Plain-English 402 diagnosis                                                            |    ✅     |    —    |    —     | partial  |
| Static config validation                                                               |  partial  |    —    |    —     |    ✅    |
| Network explorer / discovery                                                           |     —     |    —    |    ✅    |    —     |
| Spending controls                                                                      |     —     |   ✅    |    —     |    —     |

x402trace is the **debugger** in the x402 toolbox — built for the narrow, expensive moment when a payment fell into the gap between facilitator and chain. The other tools target adjacent jobs (routing, explorer, lint, controls) and compose well. Full comparison in [SPEC.md § 8](./SPEC.md#8-differentiation).

## Contributing

Personal project. PRs and bug reports welcome. Read in this order:

1. [CLAUDE.md](./CLAUDE.md) — operating manual + hard rules
2. [TESTING.md](./TESTING.md) — testing is a hard requirement, not a nice-to-have
3. [CONTRIBUTING.md](./CONTRIBUTING.md) — branching + PR workflow

## Donate

If x402trace saved you time and you want to send something back, the maintainer accepts USDC or ETH on Base or Ethereum mainnet:

**`0xe922Cc1D44C69bDEc8581Cc9Fd28bab8f59478CC`**

Verify on [Basescan](https://basescan.org/address/0xe922Cc1D44C69bDEc8581Cc9Fd28bab8f59478CC) or [Etherscan](https://etherscan.io/address/0xe922Cc1D44C69bDEc8581Cc9Fd28bab8f59478CC). All amounts welcome — donations fund maintainer time on the next release (currently: v0.3.2.1 fast-follow + v0.3.3 trust-taxonomy slate per the [v0.3.2 release notes](https://github.com/fardinvahdat/x402trace/releases/tag/v0.3.2)).

## Paid audits

Maintainer-side reviews available for teams shipping x402-paid services at scale:

- **Listing-readiness sweep** — `bazaar-check` across N endpoints from your catalog with a verdict distribution + per-URL fix recommendations
- **Release smoke** — pre-ship verification packet (Markdown executive summary + JSONL log + suggested fixes)
- **Custom diagnostic** — one-shot custom check + reproduction harness for a service-specific failure mode
- **Fixture contribution** — closure-row JSON envelopes packaged as captured-response fixtures for the regression bed

Payable in USDC on Base. Reach out via [GitHub Issue](https://github.com/fardinvahdat/x402trace/issues/new) or Coinbase Developer Discord DM with scope; typical turnaround 48-72h.

## Acknowledgments

External contributors who've shaped x402trace:

- [@hypeprinter007-stack](https://github.com/hypeprinter007-stack) — first external contributor; fixed v2 challenge body parsing ([#65](https://github.com/fardinvahdat/x402trace/issues/65), [#66](https://github.com/fardinvahdat/x402trace/pull/66)); manifest-hygiene empty-string detection ([#70](https://github.com/fardinvahdat/x402trace/pull/70))
- [@peterxing](https://github.com/peterxing) — `bazaar-check` HTTP probe timeouts ([#67](https://github.com/fardinvahdat/x402trace/pull/67))
- [@TomSmart_ai](https://github.com/TomSmart_ai) — first production-scale validation against a 19-endpoint mapper catalog (Coinbase Developer Discord, 2026-05-20); coined the "listing-readiness gap" framing for `bazaar-check`; named integrator for the v0.3.2 JSON API contract
- [@AsaiShota](https://github.com/AsaiShota) — origin of [#72](https://github.com/fardinvahdat/x402trace/issues/72) (Body-discovery extension shape, drove D.5 / X402-43) + [#2207](https://github.com/x402-foundation/x402/issues/2207) per-route services corroboration (drove D.4 / X402-42)
- [@evanatpizzarobot](https://github.com/evanatpizzarobot) — second-voice corroboration on D.4 per-route shape ([#2207](https://github.com/x402-foundation/x402/issues/2207), TensorFeed)
- [@0xdespot](https://github.com/0xdespot) — D.4 third-voice corroboration (hyperD.ai) + D.5 BodyDiscoveryExtension corroboration + bucket taxonomy that informs the D.3 `indexer_state` enum on [#2207](https://github.com/x402-foundation/x402/issues/2207)
- @Cryptor + @Ferj (Coinbase Developer Discord, 2026-05-21) — CDP-only Bazaar-indexing clarification that anchors ADR-004 Pillar 3 (facilitator-aware verdict attribution)
- @zev (Discord) — D.2 propagation-diff pain pattern (api.lastlookdata.com)
- Max (Discord) — D.3 indexer-state probe pain pattern (polyodds.bet)

Per-release credit lives in the [CHANGELOG](./CHANGELOG.md).

## License

[Apache 2.0](./LICENSE)
