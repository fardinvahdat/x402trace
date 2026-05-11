# dogfood-notes.md

> Running journal of pain encountered while dogfooding x402 during Week 1 ([X402-3](https://vahdatfardin.atlassian.net/browse/X402-3), [X402-4](https://vahdatfardin.atlassian.net/browse/X402-4)). Becomes the input to the wedge decision ([X402-7](https://vahdatfardin.atlassian.net/browse/X402-7)).
>
> **Honesty rule:** write what actually happened, not what would have made the journal look good. Time-to-diagnose includes the 30 minutes you spent on Stack Overflow looking up the wrong thing.

---

## Setup

Filled in by X402-3 ([feat/X402-3-dogfood-setup](https://github.com/fardinvahdat/x402trace/tree/feat/X402-3-dogfood-setup)).

- **Server framework:** Hono 4.12.x with `paymentMiddleware` from `x402-hono@1.2.0` (v1 protocol; matches the SDK referenced in [coinbase/x402 Issue #1062](https://github.com/coinbase/x402/issues/1062))
- **Client:** `x402-fetch@1.2.0` wrapping `globalThis.fetch`, signer built via `createSigner("base-sepolia", PAYER_PRIVATE_KEY)` from `x402/types`
- **Chain:** Base Sepolia (chain ID 84532)
- **USDC asset (Base Sepolia):** `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (resolved by x402-hono from `network: "base-sepolia"`; we don't hardcode it)
- **RPC URL:** `https://sepolia.base.org` (chain default; `BASE_RPC_URL` env validated for testnet-only but the dogfood client uses the chain default)
- **Facilitator URL:** `https://x402.org/facilitator` (the testnet facilitator; configurable via `FACILITATOR_URL`)
- **Payer / receiver wallet (testnet, throwaway):** `0xADEeaf70FE6fcBD42D926E4159c25d7fc85eB895`
- **Local dev:** `pnpm dogfood:server` on port 3402, `pnpm dogfood:client` to drive a paid GET
- **Public deploy target:** Vercel via `hono/vercel` + `api/[...all].ts` catch-all + `vercel.json` rewrite

### `.env` values used (redacted)

```
BASE_RPC_URL=https://sepolia.base.org
FACILITATOR_URL=https://x402.org/facilitator
RECEIVER_ADDRESS=0xADEeaf70FE6fcBD42D926E4159c25d7fc85eB895
PAYER_PRIVATE_KEY=0x************************************************************    # 32-byte hex, REDACTED
LOG_LEVEL=info
DOGFOOD_PORT=3402
DOGFOOD_SERVER_URL=http://localhost:3402
PROXY_PORT=8402
RECONCILIATION_WINDOW_SECONDS=60
```

`.env` is `.gitignore`d (`git check-ignore -v .env` confirms `gitignore:13:.env`). Never committed.

### Local end-to-end run (captured 2026-05-11)

**Server boot:**

```
> x402trace@0.0.0 dogfood:server /Users/fardinvahdat/workspace/x402trace
> tsx scripts/dev-server.ts

x402trace dogfood server listening on http://localhost:3402
  receiver:    0xADEeaf70FE6fcBD42D926E4159c25d7fc85eB895
  network:     base-sepolia
  facilitator: https://x402.org/facilitator
  protected:   GET /api/weather @ $0.001
  unpaid GET:  curl -i http://localhost:3402/api/weather
```

**Unpaid `GET /api/weather` → 402 challenge:**

```
HTTP/1.1 402 Payment Required
content-type: application/json

{
  "error": "X-PAYMENT header is required",
  "accepts": [
    {
      "scheme": "exact",
      "network": "base-sepolia",
      "maxAmountRequired": "1000",
      "resource": "http://localhost:3402/api/weather",
      "description": "x402trace dogfood: Base Sepolia weather (testnet)",
      "mimeType": "application/json",
      "payTo": "0xADEeaf70FE6fcBD42D926E4159c25d7fc85eB895",
      "maxTimeoutSeconds": 300,
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "outputSchema": { "input": { "type": "http", "method": "GET", "discoverable": true } },
      "extra": { "name": "USDC", "version": "2" }
    }
  ],
  "x402Version": 1
}
```

**Client run (`pnpm dogfood:client`):**

```
[client] target: http://localhost:3402/api/weather
[client] payer:  0xADEeaf70FE6fcBD42D926E4159c25d7fc85eB895
[client] chain:  Base Sepolia (84532)
[client] unpaid GET -> 402
[client] 402 challenge body: { … same payload as above … }
[client] paid GET   -> 402
[client] response body: {
  "error": "invalid_exact_evm_insufficient_balance",
  "accepts": [ { … same accepts entry … } ],
  "payer": "0xADEeaf70FE6fcBD42D926E4159c25d7fc85eB895",
  "x402Version": 1
}
[client] failed: Error: expected paid request to succeed, got 402
```

### What this proves vs. what's still pending

✅ **Verified end-to-end:**

- Hono server boots on Vercel-style routing
- `paymentMiddleware` correctly returns a 402 with a well-formed v1 `accepts` body
- Client wraps `fetch`, signs an EIP-3009 authorization via the payer's private key, attaches an `X-PAYMENT` header, replays the request
- Facilitator at `x402.org/facilitator` accepts the signature (no signature-verification error) and progresses to on-chain balance check
- Failure path is structured JSON — exactly the shape x402trace will need to surface to users

🟡 **Pending: 200 settlement on a funded wallet.**

The throwaway payer wallet `0xADEeaf70FE6fcBD42D926E4159c25d7fc85eB895` is empty on Base Sepolia. Circle's faucet (`faucet.circle.com`) gates on a mainnet-ETH balance, which this wallet does not have. Two paths to unblock:

1. Use the **Coinbase CDP Base Sepolia faucet** (less gated; requires a CDP account but no mainnet ETH).
2. Send a few testnet USDC from another funded wallet.

After funding, re-run `pnpm dogfood:client` and expect `paid GET -> 200` with an `x-payment-response` header carrying the settlement transaction hash. Capture that here under "Setup → funded run".

### Wedge implications (already useful)

- The facilitator's `invalid_exact_evm_insufficient_balance` error is a real `accepts`-plus-`payer`-plus-`error` envelope. A debugger like x402trace must be able to decode this shape on the failure path, not just the happy path. Adding this to the failure-mode fixtures (X402-4 #3, "Insufficient USDC balance") is essentially free now.
- The facilitator does **not** return any indication of *which* on-chain check failed (balance vs. allowance vs. nonce vs. timing). x402trace can add value by cross-checking the user's actual on-chain state when this error fires — first concrete dogfood-pain data point for the wedge ([X402-7](https://vahdatfardin.atlassian.net/browse/X402-7)).

### Funding the testnet wallet — what didn't work (2026-05-11)

Both standard faucets are inaccessible to this engineer's setup, so the canonical real-facilitator capture is parked as a follow-up:

| Faucet | Result |
| --- | --- |
| Circle (`faucet.circle.com`) | Blocked — requires non-zero **mainnet ETH** balance to claim. Wallet has none. |
| Coinbase Developer Platform (`portal.cdp.coinbase.com/products/faucet`) | Blocked — requires **mobile-phone verification** during signup. No phone number available. |
| Coinbase consumer faucet (`coinbase.com/faucets/...`) | Same mobile-phone gate. |

This is the kind of friction the x402 ecosystem itself struggles with, and worth recording as a real onboarding pain point — file under "things that block builders even before they write a line of code."

Follow-up paths (anyone with a teammate / Discord access can unblock):

- Ask someone in the [x402 Discord](https://discord.gg/x402) or [Coinbase Developer Discord](https://discord.gg/cdp) for a community drip of Base Sepolia USDC to `0xADEeaf70FE6fcBD42D926E4159c25d7fc85eB895`.
- Have any teammate with mainnet ETH claim from Circle's faucet and forward.
- Once funded, drop `FACILITATOR_URL=https://x402.org/facilitator` back in `.env`, run `pnpm dogfood:server` + `pnpm dogfood:client`, and append the resulting transaction hash here under "Setup → funded run".

### Mock-facilitator green-path capture (2026-05-11)

Because the real-facilitator path is funding-blocked, X402-3 also ships a **local mock facilitator** ([src/dogfood/mock-facilitator.ts](./src/dogfood/mock-facilitator.ts)) that implements the v1 `POST /verify` and `POST /settle` endpoints with canned-success responses. This proves the server/client/middleware wiring end-to-end without on-chain USDC. It is **not** a substitute for the real-facilitator capture (acceptance criterion still pending); it is the test harness that `TESTING.md` recommends for integration testing.

Both apps were started locally, then `pnpm dogfood:client` ran against the dogfood server with `FACILITATOR_URL=http://localhost:4402`:

**Dogfood server log:**

```
x402trace dogfood server listening on http://localhost:3402
  receiver:    0xADEeaf70FE6fcBD42D926E4159c25d7fc85eB895
  network:     base-sepolia
  facilitator: http://localhost:4402
  protected:   GET /api/weather @ $0.001
[2026-05-11T20:23:26.579Z] GET /api/weather -> 402   9ms accept=*/* x-payment:none
[2026-05-11T20:23:26.587Z] GET /api/weather -> 402   1ms accept=*/* x-payment:none
[2026-05-11T20:23:26.619Z] GET /api/weather -> 200  23ms accept=*/* x-payment:present x-payment-response:present
```

**Mock facilitator log:**

```
x402trace MOCK facilitator listening on http://localhost:4402
  WARNING: always approves. Local test harness only — do NOT deploy.
[2026-05-11T20:23:26.612Z] mock-facilitator POST /verify -> 200 5ms
[2026-05-11T20:23:26.618Z] mock-facilitator POST /settle -> 200 1ms
```

**Client output:**

```
[client] target: http://localhost:3402/api/weather
[client] payer:  0xADEeaf70FE6fcBD42D926E4159c25d7fc85eB895
[client] chain:  Base Sepolia (84532)
[client] unpaid GET -> 402
[client] 402 challenge body: { … same as above … }
[client] paid GET   -> 200
[client] settlement: {
  "success": true,
  "transaction": "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffff00000001",
  "network": "base-sepolia",
  "payer": "0xADEeaf70FE6fcBD42D926E4159c25d7fc85eB895"
}
[client] response body: {
  "endpoint": "/api/weather",
  "network": "base-sepolia",
  "priceUsd": "$0.001",
  "servedAt": "2026-05-11T20:23:26.616Z",
  "note": "Paid response from x402trace dogfood server on Base Sepolia."
}
```

The `transaction` field is a synthetic, mock-emitted hash (notice the `ffff…0001` pattern) — clearly not a real Base Sepolia tx. That's intentional: it's how you'll know in a glance whether you're looking at mock or real-facilitator data.

This same flow is asserted automatically by `tests/integration/dogfood-paid-flow.test.ts` and runs on every `pnpm test`.

---

## Failure modes

> Five deliberate failures, one block each. To be filled in by X402-4. Structure is identical for every failure so the eventual synthesis is mechanical.

### 1. Wrong chain ID

- **What I tried:** _TBD_
- **Server error:**
  ```
  TBD
  ```
- **Client error:**
  ```
  TBD
  ```
- **Facilitator error:**
  ```
  TBD
  ```
- **Where the error surfaced:** _TBD_
- **Was it actionable from the message alone?** _TBD_
- **Time to diagnose:** _TBD (be honest)_
- **What would have helped:** _TBD_

### 2. Expired validBefore / maxTimeoutSeconds

_TBD — same structure_

### 3. Insufficient USDC balance

_TBD — same structure_

### 4. Malformed signature

_TBD — same structure_

### 5. Facilitator unavailable

_TBD — same structure_

---

## Top painful moments (synthesized — [X402-6](https://vahdatfardin.atlassian.net/browse/X402-6))

| Rank | Pain | Proposed feature | Difficulty (S/M/L) | Notes |
| --- | --- | --- | --- | --- |
| 1 | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| 2 | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| 3 | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| 4 | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| 5 | _TBD_ | _TBD_ | _TBD_ | _TBD_ |

---

## Wedge candidates

_To be filled in by X402-6._

- **Candidate 1:** _TBD_
- **Candidate 2:** _TBD_
- **Candidate 3:** _TBD_

---

## Decision

Picked in [X402-7](https://vahdatfardin.atlassian.net/browse/X402-7) → recorded as ADR-001 in [DECISIONS.md](./DECISIONS.md).
