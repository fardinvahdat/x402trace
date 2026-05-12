# x402trace

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![CI](https://github.com/fardinvahdat/x402trace/actions/workflows/ci.yml/badge.svg?branch=v1)](https://github.com/fardinvahdat/x402trace/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/x402trace.svg)](https://www.npmjs.com/package/x402trace)

**A local CLI that catches `x402` payment failures that cost real money** — starting with the [coinbase/x402 #1062](https://github.com/coinbase/x402/issues/1062) symptom: the buyer is debited on-chain, but the facilitator times out and your server thinks the payment failed.

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

The authoritative flag list is `x402trace --help` (or per-subcommand `--help`) — they're the source of truth and are wired into the unit tests.

## Roadmap

**v0.1.0** (shipped 2026-05-12 as [`x402trace@0.1.0`](https://www.npmjs.com/package/x402trace)) — local proxy + timeout reconciliation + structured logs. Base Sepolia, `x402.org/facilitator`, `exact` EVM scheme only. Detect-and-notify, no auto-refund. Wedge accepted in [ADR-001](./DECISIONS.md#adr-001-v01-wedge). Verified by three independent live Base Sepolia settlements.

**v0.2** (current) — `validate` (pre-flight) + `explain` (offline 402 diagnosis), sharing a new `src/diagnose/` rule engine. Same scope tightening as v0.1: Base Sepolia, single facilitator, `exact` EVM, read-only. Decision: [ADR-002](./DECISIONS.md#adr-002-v02-feature-pick--validate-primary--explain-paired).

**v0.3 stretch** (kept, not killed — full list in [SPEC.md § 5](./SPEC.md#5-v02-scope-picked-in-adr-002)):

- Mainnet (after ≥1 week of clean testnet traffic)
- ERC-6492 wallet-kind support in `validate`
- `x402trace diff` — cross-facilitator behavior comparison
- `x402trace bazaar-check` — Bazaar indexing diagnostics
- `x402trace versions` — SDK-skew audit
- `--watch` daemon mode with alerting integrations
- Reconciliation actions beyond JSONL (webhook, optional auto-retry)

## Differentiation

`x402scan` / `xpay` / `x402lint` are excellent at general inspection and routing. x402trace is for the narrow, expensive moment when your payment vanished into the gap between facilitator and chain — when you most need a debugger and least have one. Full comparison in [SPEC.md § 8](./SPEC.md#8-differentiation).

## Contributing

Personal project. PRs and bug reports welcome. Read in this order:

1. [CLAUDE.md](./CLAUDE.md) — operating manual + hard rules
2. [TESTING.md](./TESTING.md) — testing is a hard requirement, not a nice-to-have
3. [CONTRIBUTING.md](./CONTRIBUTING.md) — branching + PR workflow

## License

[Apache 2.0](./LICENSE)
