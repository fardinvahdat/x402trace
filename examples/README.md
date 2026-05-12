# x402trace examples

End-to-end demos of the v0.1 wedge. Each script is a runnable reproduction of one of the failure modes x402trace was built to catch.

---

## [`e2e-timeout-reconciliation.sh`](./e2e-timeout-reconciliation.sh) — the canonical [#1062](https://github.com/coinbase/x402/issues/1062) demo

The flagship X402-15 demo. Drives the full pipeline (proxy + decoder + chain + reconciliation) against a real Base Sepolia settlement and proves x402trace surfaces the **`RECONCILED ⚠ settled-but-server-thinks-not`** warning.

### Storyline

```
┌──────────┐    ┌─────────────┐    ┌──────────┐    ┌──────────────────────┐
│  client  │ →  │ x402trace   │ →  │ dogfood  │ →  │ x402.org/facilitator │
│ (signs)  │    │  proxy      │    │  server  │    │  (real testnet)      │
└──────────┘    └─────────────┘    └──────────┘    └──────────────────────┘
                       │                   │
                       │              (settle broadcasts the tx ✓)
                       │                   │
                       │              (server then sleeps 10s + 500)
                       │ ←── upstream timeout @ 5s, returns 502
                       │
                       ▼
              (engine pends + watches Base Sepolia)
                       │
                       ▼
              ⚠ RECONCILED   tx=0x… value=1000 gap=…ms
```

The server sleeps after the x402 middleware has run — by then, settlement on Base Sepolia is irreversible. The proxy's 5-second `--upstream-timeout-ms` kicks in during the sleep, so the buyer's client gets a 502 and thinks payment failed. x402trace's chain client polls Base Sepolia for the matching USDC `Transfer`, joins it against the pending exchange by EIP-3009 nonce, and emits the headline warning.

### Prerequisites

1. **Node ≥ 20**, **pnpm**.
2. **A Base Sepolia test wallet** funded with:
   - ≥ 0.01 USDC ([Base Sepolia USDC `0x036CbD…CF7e`](https://sepolia.basescan.org/address/0x036CbD53842c5426634e7929541eC2318f3dCF7e))
   - dust ETH on Base Sepolia for any fallback gas paths
   - (the facilitator covers gas on settle, but you need USDC the facilitator can pull)
3. **A `.env` file** in the repo root (the script `source`s it). Minimum:

    ```bash
    PAYER_PRIVATE_KEY=0x<your testnet key — never reuse a mainnet key>
    RECEIVER_ADDRESS=0x<any 0x-prefixed 20-byte address>
    # Optional overrides:
    # FACILITATOR_URL=https://x402.org/facilitator
    # BASE_RPC_URL=https://sepolia.base.org
    ```

4. **`git check-ignore .env`** must return `.env` — the project root `.gitignore` already covers it, but verify.

### Run

```bash
./examples/e2e-timeout-reconciliation.sh
```

Total runtime: ~25–40 seconds depending on chain congestion + RPC responsiveness.

### Knobs

| Env var | Default | What it tunes |
|---|---|---|
| `DEMO_SERVER_PORT` | `3402` | Dogfood server bind port |
| `DEMO_PROXY_PORT` | `8402` | `x402trace proxy` bind port |
| `DEMO_SLEEP_MS` | `10000` | Post-settle sleep injected in the dogfood server |
| `DEMO_PROXY_TIMEOUT_MS` | `5000` | `x402trace proxy --upstream-timeout-ms` |
| `DEMO_WATCH_TIMEOUT_MS` | `90000` | `x402trace proxy --watch-timeout-ms` (engine's chain-watch budget) |
| `DEMO_WAIT_BUDGET` | `90` | Seconds the shell will wait for the `RECONCILED` line before bailing |
| `DEMO_LOG_FILE` | `${TMPDIR}/x402trace-e2e-$$.jsonl` | JSONL output path |

### Recorded cast

A reference run is committed at [`examples/cast/e2e-timeout-reconciliation.cast`](./cast/e2e-timeout-reconciliation.cast). Replay locally:

```bash
brew install asciinema  # one-time install
asciinema play examples/cast/e2e-timeout-reconciliation.cast
```

The committed cast was recorded on 2026-05-12 against real Base Sepolia + the production `x402.org/facilitator`; the on-chain settlement is [`0x116ccf73…ba52`](https://sepolia.basescan.org/tx/0x116ccf73fa77eda19aea149606042f1e848e8afe2f719a0d2890dd2b2ff0ba52). See [`dogfood-notes.md` § Live e2e timeout-reconciliation capture](../dogfood-notes.md#live-e2e-timeout-reconciliation-capture-x402-15-2026-05-12) for the full transcript + timing breakdown.

To re-record after changes (use this before the X-post):

```bash
asciinema rec --overwrite \
              -t "x402trace v0.1 — catches a settled-on-chain timeout" \
              examples/cast/e2e-timeout-reconciliation.cast \
              -c "./examples/e2e-timeout-reconciliation.sh"

# upload for a tweet-embeddable URL:
asciinema upload examples/cast/e2e-timeout-reconciliation.cast
```

The script paints colour for the section headers, the success line, and the failure line — the asciinema replay preserves all of it.

### What success looks like

The final lines of the proxy stdout should include a row like:

```
[2026-05-12T…] RECONCILED ⚠ settled-but-server-thinks-not id=01HZ… tx=0x8b53a04d… value=1000 payer=0xADEe…B895 → payee=0x1111…1111 gap=12345ms
```

…and the same record persisted as a single JSON line in `$DEMO_LOG_FILE`:

```bash
grep '"event":"reconcile.result"' "$DEMO_LOG_FILE" | jq .
```

Look up the `tx` field on [sepolia.basescan.org](https://sepolia.basescan.org) to confirm it's a real USDC `transferWithAuthorization` from your payer.

### Troubleshooting

- **`✗ missing env: PAYER_PRIVATE_KEY`** — populate `.env` or `export` the var in your shell before running.
- **`✗ demo timed out — no RECONCILED line within 90s`** — usually means `BASE_RPC_URL` is rate-limited or the Transfer event hadn't yet been picked up by the chain client's poller. Try a hosted RPC (Alchemy / QuickNode / drpc Base Sepolia endpoint).
- **Server returned 200 instead of timing out** — the proxy's `--upstream-timeout-ms` is longer than the server's `DEMO_SLEEP_MS`. Decrease `DEMO_PROXY_TIMEOUT_MS` or increase `DEMO_SLEEP_MS`.
- **Wallet got debited and the demo failed** — that's the failure x402trace catches. Inspect the JSONL log; the EIP-3009 nonce + tx hash are there. The buyer's USDC is gone; recoverable only by the receiver returning it or a future facilitator dispute flow.

---

## License

All examples are Apache 2.0 — see [`LICENSE`](../LICENSE).
