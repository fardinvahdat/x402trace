# x402trace

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![CI](https://github.com/fardinvahdat/x402trace/actions/workflows/ci.yml/badge.svg?branch=v1)](https://github.com/fardinvahdat/x402trace/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/x402trace.svg)](https://www.npmjs.com/package/x402trace)

**A local CLI debugger for [`x402`](https://x402.org) — the HTTP-402-based agentic-payment protocol** — on Base. Verified against real Base Sepolia + the production `x402.org/facilitator`, three independent live reconciliations on-chain (latest: [`0x116ccf73…ba52`](https://sepolia.basescan.org/tx/0x116ccf73fa77eda19aea149606042f1e848e8afe2f719a0d2890dd2b2ff0ba52)).

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

### `validate` — example output

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

**Q: Can I check whether a wallet *can* pay a service without actually signing?**
Yes — `x402trace validate <wallet> <service-url>` is read-only. It fetches the 402, queries chain state (USDC balance, EIP-3009 nonce, wallet kind), runs the same rules `explain` uses. Exits `0` if would-succeed, `2` if would-fail.

**Q: Does this work on mainnet?**
Not yet — v0.2 is Base Sepolia only per [ADR-002](./DECISIONS.md#adr-002-v02-feature-pick--validate-primary--explain-paired). Mainnet support is on the v0.3 stretch list, gated on ≥1 week of clean testnet traffic.

## Roadmap

- **v0.1.0** (2026-05-12) — local proxy + timeout reconciliation. [ADR-001](./DECISIONS.md#adr-001-v01-wedge).
- **v0.2** (current) — `validate` + `explain` on a shared diagnostic rule engine. [ADR-002](./DECISIONS.md#adr-002-v02-feature-pick--validate-primary--explain-paired).
- **v0.3 stretch** — mainnet, ERC-6492 wallet kind, `--diff` cross-facilitator, `bazaar-check`, SDK-skew `versions` audit, `--watch` daemon, reconciliation actions (webhook / auto-retry). Full list: [SPEC.md § 5](./SPEC.md#5-v02-scope-picked-in-adr-002).

## How x402trace compares

| Capability | x402trace | xpay | x402scan | x402lint |
|---|:-:|:-:|:-:|:-:|
| Local proxy + JSONL audit log | ✅ | — | — | — |
| Timeout reconciliation (catches [#1062](https://github.com/coinbase/x402/issues/1062)) | ✅ | partial | — | — |
| Pre-flight wallet check (no signing) | ✅ | — | — | — |
| Plain-English 402 diagnosis | ✅ | — | — | partial |
| Static config validation | partial | — | — | ✅ |
| Network explorer / discovery | — | — | ✅ | — |
| Spending controls | — | ✅ | — | — |

x402trace is the **debugger** in the x402 toolbox — built for the narrow, expensive moment when a payment fell into the gap between facilitator and chain. The other tools target adjacent jobs (routing, explorer, lint, controls) and compose well. Full comparison in [SPEC.md § 8](./SPEC.md#8-differentiation).

## Contributing

Personal project. PRs and bug reports welcome. Read in this order:

1. [CLAUDE.md](./CLAUDE.md) — operating manual + hard rules
2. [TESTING.md](./TESTING.md) — testing is a hard requirement, not a nice-to-have
3. [CONTRIBUTING.md](./CONTRIBUTING.md) — branching + PR workflow

## License

[Apache 2.0](./LICENSE)
