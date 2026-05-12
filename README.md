# x402trace

> 🚧 **Pre-release.** v0.1 in active development. See [SPEC.md](./SPEC.md) and the [Jira board](https://vahdatfardin.atlassian.net/jira/software/projects/X402) for current status.

Local CLI for debugging [x402](https://x402.org) payment flows on Base. Catches failure modes that cost real money — starting with **timeout reconciliation**, where the facilitator times out but the on-chain transaction settled anyway.

---

## The problem (v0.1 wedge)

You integrate x402 on Base Sepolia. A request hits your facilitator. The facilitator times out. Your server returns 500. Your test wallet was debited anyway, the transaction is on-chain, and you have no recovery path. The logs tell you nothing useful.

This is [coinbase/x402 #1062](https://github.com/coinbase/x402/issues/1062). **x402trace surfaces it in real time** so you know immediately when it happens — and gives you the on-chain transaction hash to reconcile.

## What x402trace does

- Sits as a local proxy between your client and your x402 server
- Decodes every `PAYMENT-REQUIRED` and `PAYMENT-RESPONSE` header into structured logs
- Watches the facilitator response — if it times out or errors, x402trace queries Base directly to check whether the payment actually settled
- Surfaces "settled but unconfirmed" payments with the tx hash so you can reconcile

## Quick demo

```bash
git clone https://github.com/fardinvahdat/x402trace.git && cd x402trace
pnpm install

# populate .env with PAYER_PRIVATE_KEY (Base Sepolia testnet) and
# RECEIVER_ADDRESS — see examples/README.md for the full prereq list.
./examples/e2e-timeout-reconciliation.sh
```

Under 40 seconds the demo:

1. Starts the dogfood server with a 10 s post-settle sleep + 500
2. Starts `x402trace proxy --reconcile --upstream-timeout-ms 5000` in front of it
3. Pays through the proxy with a real Base Sepolia signer
4. The proxy times out, the facilitator already broadcast on-chain
5. x402trace's chain subscription matches the EIP-3009 nonce and emits:

   ```
   ⚠ RECONCILED  settled-but-server-thinks-not  tx=0x… value=1000 gap=…ms
   ```

That's the canonical [#1062](https://github.com/coinbase/x402/issues/1062) detection. See [examples/README.md](./examples/README.md) for prereqs, knobs, and asciinema recording.

## CLI

```bash
x402trace proxy --upstream <url> --reconcile        # live capture + reconciliation
x402trace inspect <jsonl-log-file>                  # replay a captured log offline
x402trace --help
```

## Status

| Item | State |
| --- | --- |
| v0.1 spec | ✅ Locked — see [SPEC.md](./SPEC.md) |
| Architecture | ✅ Locked — see [ARCHITECTURE.md](./ARCHITECTURE.md) |
| Implementation | Week 3 complete — proxy, decoder, chain client, reconciliation engine, CLI, e2e demo all shipped (X402-10..15) |
| First release | Target: 6 weeks from project start |

## Roadmap

See [SPEC.md](./SPEC.md) for full scope. Short version:

- **v0.1** — Local proxy + timeout reconciliation + structured logs (Base only, testnet-validated)
- **v0.2** — TBD based on dogfooding (see [DECISIONS.md](./DECISIONS.md) → ADR-002)

## Install

```bash
# When v0.1 is released:
npx x402trace --help
```

Nothing installable yet. Watch the GitHub releases page or the Jira board for v0.1.0.

## Why not just use x402scan / xpay / x402lint?

Different problem. Those are great for general inspection and routing. x402trace is for the specific moment when your payment vanished into the gap between facilitator and chain — which is when you most need a debugger and least have one.

See `SPEC.md → Differentiation` (once written) for details.

## Contributing

Personal project. PRs and bug reports welcome. Read in this order:

1. [CLAUDE.md](./CLAUDE.md) — the operating manual
2. [TESTING.md](./TESTING.md) — **testing is a hard requirement**, not a nice-to-have
3. [CONTRIBUTING.md](./CONTRIBUTING.md) — workflow

## License

[Apache 2.0](./LICENSE)
