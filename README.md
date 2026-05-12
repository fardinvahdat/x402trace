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

*Coming with v0.1.0:* `npx x402trace --help` from any directory. See the [Roadmap](#roadmap) below.

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
x402trace proxy   --upstream <url> [--reconcile] [--log human|json] …
x402trace inspect <jsonl-log-file> [--log human|json] …
```

The authoritative flag list is `x402trace --help` / `x402trace proxy --help` / `x402trace inspect --help` — they're the source of truth and are wired into the unit tests. See also [`pnpm x402trace --help`](./src/cli/index.ts) directly in the repo.

## Roadmap

**v0.1** (current, ~6 weeks from project start) — local proxy + timeout reconciliation + structured logs. Base Sepolia, `x402.org/facilitator`, `exact` EVM scheme only. Detect-and-notify, no auto-refund. Wedge accepted in [ADR-001](./DECISIONS.md).

**v0.2 stretch** (from [SPEC.md § 5](./SPEC.md#5-v02-stretch-deferred-not-killed), ordered by ranked dogfood pain):

- Mainnet (after ≥1 week of clean testnet traffic)
- `x402trace inspect <captured-402.json>` — pure-function offline 402 decode
- `x402trace doctor <wallet> <service>` — pre-flight wallet/service check
- `x402trace bazaar-check` — Bazaar indexing diagnostics
- `x402trace versions` — SDK-skew audit across `x402`, `x402-fetch`, facilitator
- Multi-facilitator support (CDP, PayAI, x402-rs)
- Reconciliation **actions** beyond JSONL (webhook, structured remediation)

## Differentiation

`x402scan` / `xpay` / `x402lint` are excellent at general inspection and routing. x402trace is for the narrow, expensive moment when your payment vanished into the gap between facilitator and chain — when you most need a debugger and least have one. Full comparison in [SPEC.md § 8](./SPEC.md#8-differentiation).

## Contributing

Personal project. PRs and bug reports welcome. Read in this order:

1. [CLAUDE.md](./CLAUDE.md) — operating manual + hard rules
2. [TESTING.md](./TESTING.md) — testing is a hard requirement, not a nice-to-have
3. [CONTRIBUTING.md](./CONTRIBUTING.md) — branching + PR workflow

## License

[Apache 2.0](./LICENSE)
