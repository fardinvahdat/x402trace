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

🟡 **Originally pending: 200 settlement on a funded wallet** — _resolved 2026-05-12. See "Real-facilitator green-path capture" below._

The throwaway payer wallet `0xADEeaf70FE6fcBD42D926E4159c25d7fc85eB895` was empty on Base Sepolia at the time of the first run. Circle's faucet (`faucet.circle.com`) gated on a mainnet-ETH balance, which this wallet did not have. Two paths considered: Coinbase CDP faucet (also gated by phone-verification, see below), or a community drip. The drip path eventually came through.

### Wedge implications (already useful)

- The facilitator's `invalid_exact_evm_insufficient_balance` error is a real `accepts`-plus-`payer`-plus-`error` envelope. A debugger like x402trace must be able to decode this shape on the failure path, not just the happy path. Adding this to the failure-mode fixtures (X402-4 #3, "Insufficient USDC balance") is essentially free now.
- The facilitator does **not** return any indication of *which* on-chain check failed (balance vs. allowance vs. nonce vs. timing). x402trace can add value by cross-checking the user's actual on-chain state when this error fires — first concrete dogfood-pain data point for the wedge ([X402-7](https://vahdatfardin.atlassian.net/browse/X402-7)).

### Funding the testnet wallet — what didn't work (2026-05-11; resolved 2026-05-12)

Three standard faucet paths were all blocked. Wallet was eventually funded via a non-faucet route (community / other source) on 2026-05-12 — Basescan confirms USDC at [`0xADEeaf...B895`](https://sepolia.basescan.org/token/0x036cbd53842c5426634e7929541ec2318f3dcf7e?a=0xADEeaf70FE6fcBD42D926E4159c25d7fc85eB895).

| Faucet | Result |
| --- | --- |
| Circle (`faucet.circle.com`) | Blocked — requires non-zero **mainnet ETH** balance to claim. Wallet has none. |
| Coinbase Developer Platform (`portal.cdp.coinbase.com/products/faucet`) | Blocked — requires **mobile-phone verification** during signup. No phone number available. |
| Coinbase consumer faucet (`coinbase.com/faucets/...`) | Same mobile-phone gate. |

This is the kind of friction the x402 ecosystem itself struggles with, and worth recording as a real onboarding pain point — file under "things that block builders even before they write a line of code." A debugger like x402trace can't fix the faucet walls, but it can pre-flight the wallet state (USDC balance, allowance) and tell the user **before** they ship code that they will hit `invalid_exact_evm_insufficient_balance` at runtime.

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

### Public Vercel deploy (2026-05-12)

**Production URL (stable, v1 branch alias):** [`https://x402trace-dogfood-git-v1-fardinvahdats-projects.vercel.app`](https://x402trace-dogfood-git-v1-fardinvahdats-projects.vercel.app)

This is the canonical URL going forward. The initial PR-2 preview deploy ran on the now-deleted `feat/X402-3-dogfood-setup` branch alias; after PR-2 was merged, Vercel's production branch was switched from `main` to `v1` and a fresh production deploy was cut. The probe and client output below was captured against the original preview alias on 2026-05-12 but is equivalent to what the production alias serves today — the build is identical commit-for-commit. A second production capture against the v1 alias confirmed the paid flow at settlement tx [`0xc5758bf2…6cbf`](https://sepolia.basescan.org/tx/0xc5758bf2a0f8668a5613aae125a7ab529ef90ce96760020a1ff73309788c6cbf).

`vercel.json` configures `outputDirectory: "public"`, declares `api/**/*.ts` as serverless functions explicitly (necessary — without this, Vercel was treating the project as static-only and the `api/` directory was never bundled), and pins `installCommand: "pnpm install --frozen-lockfile"`. `api/[...all].ts` is a Node-style `(req, res)` handler that bridges to `app.fetch()`; it deliberately avoids referencing Web Fetch global types by name because Vercel's serverless build env resolves those as empty shells (while our local tsconfig has them via `@types/node@22`).

**Probe capture:**

```
$ curl -i https://x402trace-dogfood-git-feat-x402-3-ce2524-fardinvahdats-projects.vercel.app/api/weather
HTTP/2 402
content-type: application/json
server: Vercel
x-vercel-cache: MISS

{
  "error": "X-PAYMENT header is required",
  "accepts": [
    {
      "scheme": "exact",
      "network": "base-sepolia",
      "maxAmountRequired": "1000",
      "resource": "https://x402trace-dogfood-git-feat-x402-3-ce2524-fardinvahdats-projects.vercel.app/api/weather?...all=weather",
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

The `resource` URL contains `?...all=weather` because Vercel's catch-all route `[...all]` captures the path segments as a query parameter. This is a Vercel routing artifact, not an x402 protocol issue — the actual endpoint URL is `/api/weather` and the paymentMiddleware accepts payments addressed to the trailing-slash-free path. **Future cleanup**: either move to a named function (`api/weather.ts`) or strip the `?...all=…` query before computing `resource` so client libraries see a clean URL.

**What I learned in the deploy slog (worth recording as failure-mode/onboarding data):**

| Symptom | Root cause | Fix |
| --- | --- | --- |
| Vercel built `main` (no tsconfig) → `tsc` printed `--help` and exited 1 | Vercel's default production branch was `main`; the dashboard "Import" UI doesn't ask which branch to preview | Push the feature branch and use the auto-generated preview, OR temporarily set production branch in Settings |
| `Error: No Output Directory named "public" found` | Vercel's "Other" preset expects a static output dir | Add `public/index.html` + set `outputDirectory: "public"` |
| Every `/api/*` request hung for 12s+ with HTTP 000 | Two stacked issues: (a) `hono/vercel`'s Edge-style `handle` mismatched the Node runtime; (b) Vercel's tsc compile of `api/*.ts` was silently failing because Web Fetch global types resolved as empty shells in its build env | (a) Replace with hand-rolled `(req, res) => void` Node handler that calls `app.fetch()`. (b) Stop referencing those types by name; pull constructors off `globalThis` and use `any`-typed locals with runtime guards |
| Vercel Preview deploys returned `401 Authentication Required` even with the URL | Default Vercel Authentication on Preview deploys (Hobby plan) | Settings → Deployment Protection → disable Vercel Authentication for Preview |
| Circle's USDC faucet, CDP faucet, and Coinbase consumer faucet all gated me out (mainnet ETH and/or phone verification) | Faucet anti-sybil walls assume mainstream onboarding paths | Documented above; pending teammate/Discord drip to fund the wallet for the real-facilitator 200 capture |

Each of those is a real onboarding paper-cut that an x402-tracing tool can either surface, warn about, or pre-flight against in v0.1+.

### Real-facilitator green-path capture (2026-05-12)

Wallet `0xADEeaf70FE6fcBD42D926E4159c25d7fc85eB895` was funded with Base Sepolia USDC. `pnpm dogfood:client` was run with the **production** environment — pointing at the **deployed Vercel URL** and the **official `https://x402.org/facilitator`** (i.e., no mocks anywhere in the chain):

```bash
$ DOGFOOD_SERVER_URL=https://x402trace-dogfood-git-feat-x402-3-ce2524-fardinvahdats-projects.vercel.app \
  FACILITATOR_URL=https://x402.org/facilitator \
  pnpm dogfood:client

[client] target: https://x402trace-dogfood-git-feat-x402-3-ce2524-fardinvahdats-projects.vercel.app/api/weather
[client] payer:  0xADEeaf70FE6fcBD42D926E4159c25d7fc85eB895
[client] chain:  Base Sepolia (84532)
[client] unpaid GET -> 402
[client] 402 challenge body: { …well-formed x402 v1 challenge, payTo + asset + maxAmountRequired all correct… }
[client] paid GET   -> 200
[client] settlement: {
  "success": true,
  "transaction": "0x8b53a04d71cd7dcc35fdf3682ae173758a76213db4ec1abae3e846b8c12b3428",
  "network": "base-sepolia",
  "payer": "0xADEeaf70FE6fcBD42D926E4159c25d7fc85eB895"
}
[client] response body: {
  "endpoint": "/api/weather",
  "network": "base-sepolia",
  "priceUsd": "$0.001",
  "servedAt": "2026-05-11T21:38:45.909Z",
  "note": "Paid response from x402trace dogfood server on Base Sepolia."
}
```

On-chain settlement: [`0x8b53a04d71cd7dcc35fdf3682ae173758a76213db4ec1abae3e846b8c12b3428`](https://sepolia.basescan.org/tx/0x8b53a04d71cd7dcc35fdf3682ae173758a76213db4ec1abae3e846b8c12b3428). Real Ethereum-shaped hash (compare to the mock's pattern-marked `0xffff…0001`).

This is the **canonical proof of the rig** — every layer (client → server → real facilitator → on-chain transfer → server settlement header → client decode) ran end-to-end, against production endpoints, with a real on-chain transfer. The 200-flow acceptance criterion is satisfied.

---

## Failure modes

> Five deliberate failures, one block each. Filled in by X402-4 ([docs/X402-4-failure-modes](https://github.com/fardinvahdat/x402trace/tree/docs/X402-4-failure-modes)). Structure is identical for every failure so the eventual synthesis is mechanical.
>
> All five are reproducible via `pnpm dogfood:failure-modes <1|2|3|4|5|all>` ([scripts/failure-modes.ts](./scripts/failure-modes.ts)). Each scenario spins up its own in-process Hono server on a random port so config tweaks don't pollute the default dev-server. Real facilitator at `https://x402.org/facilitator` is used for #1–#4; #5 points at a dead URL on purpose.

### 1. Wrong chain ID

- **What I tried:** Sign a valid base-sepolia payment, then mutate the encoded payload's `network` field from `"base-sepolia"` to `"avalanche-fuji"` before sending the `X-PAYMENT` header. Server only advertises base-sepolia. *(First tried: pass a wallet keyed for avalanche-fuji to `x402-fetch`. Result: 200. x402-fetch signs against the requirements' chain id regardless of wallet chain, so the wallet-chain mismatch is invisible at the protocol level. Cost me $0.001 USDC to learn this.)*
- **Server error:**
  ```
  HTTP 402
  {
    "error": "Unable to find matching payment requirements",
    "accepts": [ { "scheme": "exact", "network": "base-sepolia", "payTo": "0xADEeaf…B895", ... } ],
    "x402Version": 1
  }
  ```
- **Client error:** none — the request returned 402 cleanly; `x402-fetch` propagated the 402 body as a normal response.
- **Facilitator error:** not reached. Server's `findMatchingPaymentRequirements` rejected the payment before any `/verify` call.
- **Where the error surfaced:** Server (`paymentMiddleware` in `x402-hono`, before facilitator dispatch).
- **Was it actionable from the message alone?** No. "Unable to find matching payment requirements" tells you *something* mismatched, but you have to diff your sent payload against the `accepts` array yourself to find that it was the network. With multiple fields involved (scheme, network, payTo, asset) this is real work in production.
- **Time to diagnose:** ~5 minutes on the first attempt, because the obvious approach (pass a wrong-chain wallet to `x402-fetch`) didn't actually trigger any error — it succeeded and spent USDC. Once I realized the spec validates at submission time, not signing time, the mutate-after-sign trick was 30 seconds.
- **What would have helped:** Server error body should name the mismatching field(s) — e.g., `"mismatch": { "field": "network", "sent": "avalanche-fuji", "accepted": ["base-sepolia"] }`. Bonus: a CLI like `x402trace explain-mismatch <captured-402>` could do the diff offline.

### 2. Expired validBefore / maxTimeoutSeconds

- **What I tried:** Server config sets `maxTimeoutSeconds: -3600` on the protected route. The 402 challenge is emitted with `maxTimeoutSeconds: -3600`, x402-fetch dutifully builds an EIP-3009 authorization with `validBefore = now - 3600s`, signs it, sends it. Facilitator's `/verify` rejects with a typed reason.
- **Server error:**
  ```
  HTTP 402
  {
    "error": "invalid_exact_evm_payload_authorization_valid_before",
    "accepts": [ { … "maxTimeoutSeconds": -3600, … } ],
    "payer": "0xADEeaf70FE6fcBD42D926E4159c25d7fc85eB895",
    "x402Version": 1
  }
  ```
  (The string `invalid_exact_evm_payload_authorization_valid_before` is one of the spec's enumerated `ErrorReasons` in `x402/types`.)
- **Client error:** none. `x402-fetch` did NOT validate the negative timeout client-side — it signed and sent without complaint.
- **Facilitator error:** `invalid_exact_evm_payload_authorization_valid_before` (returned in the verify response body; status 200 from facilitator, but `isValid: false`).
- **Where the error surfaced:** Facilitator's `/verify`, then surfaced verbatim by the server in its 402 body.
- **Was it actionable from the message alone?** Mostly yes — the enumerated reason names the field exactly. But the user has to know what `validBefore` means in EIP-3009 to act on it; a developer dropping in on x402 for the first time wouldn't.
- **Time to diagnose:** 30 seconds. The reason string is precise.
- **What would have helped:** Include the actual `validBefore` timestamp and the facilitator's current time in the error body — e.g., `"validBefore": "1715472000", "now": "1715475600", "expiredBySeconds": 3600`. Lets a debugger render "your authorization expired 1 hour ago" without the user knowing about EIP-3009. Also: client-side guard in `x402-fetch` that rejects negative `maxTimeoutSeconds` *before* signing would catch this at the source.

### 3. Insufficient USDC balance

- **What I tried:** Server config sets `price: "$100.00"` on the protected route. Payer wallet has ~$1 USDC. Bumped `x402-fetch`'s `maxValue` parameter to `200_000_000n` (above the $100 requirement) so the client-side cap wouldn't short-circuit before the facilitator could check on-chain.
- **Server error:**
  ```
  HTTP 402
  {
    "error": "invalid_exact_evm_insufficient_balance",
    "accepts": [ { … "maxAmountRequired": "100000000", … } ],
    "payer": "0xADEeaf70FE6fcBD42D926E4159c25d7fc85eB895",
    "x402Version": 1
  }
  ```
- **Client error:** none. Signed normally; facilitator rejected.
- **Facilitator error:** `invalid_exact_evm_insufficient_balance`.
- **Where the error surfaced:** Facilitator's `/verify` (on-chain balance probe), echoed by server.
- **Was it actionable from the message alone?** Yes for the high-level cause; no for the gap. Tells you "you don't have enough" but not by how much. In a real app where the price is dynamic, this is the difference between a useful retry-after-funding hint and a generic failure.
- **Time to diagnose:** 30 seconds. Reason string is unambiguous.
- **What would have helped:** Include the wallet's current balance and the shortfall — e.g., `"balanceUSDC": "1000000", "requiredUSDC": "100000000", "shortfallUSDC": "99000000"`. x402trace's wedge candidate (pre-flight wallet check before signing) lives directly in this gap: warn the user *before* the signing roundtrip when balance < requested.

### 4. Malformed signature

- **What I tried:** Sign a payment normally with `exact.evm.createPayment`, then flip the last byte of the EIP-3009 signature (XOR `0xff`) to produce a same-length, same-format hex string that recovers to a different address. Re-encode as base64 X-PAYMENT and send.
  - Original signature: `0x8b90032bc00b55ab011675875592dc5ed6b39bb915ff23c316ed82f33661ab8b612642a5ec8e5be25029d08728a5d8fa24cbcbf453730a0f289e68168b7a45481c`
  - Mangled signature: `0x8b90032bc00b55ab011675875592dc5ed6b39bb915ff23c316ed82f33661ab8b612642a5ec8e5be25029d08728a5d8fa24cbcbf453730a0f289e68168b7a4548e3` (last byte `1c → e3`)
- **Server error:**
  ```
  HTTP 402
  {
    "error": "invalid_exact_evm_signature",
    "accepts": [ … ],
    "payer": "0xADEeaf70FE6fcBD42D926E4159c25d7fc85eB895",
    "x402Version": 1
  }
  ```
- **Client error:** none (we bypassed `x402-fetch` for this one and hand-crafted the request).
- **Facilitator error:** `invalid_exact_evm_signature`.
- **Where the error surfaced:** Facilitator's `/verify`. The server's `paymentMiddleware` parses and forwards; the facilitator's signature-recovery step rejects.
- **Was it actionable from the message alone?** Half-actionable. It correctly identifies "signature is the problem," but the `payer` echoed in the body is the *claimed* address (`from` field in the authorization), not the *recovered* address from the signature. So a developer staring at this can't tell whether (a) the claimed `from` was wrong, (b) the wrong private key signed, or (c) the signature bytes were corrupted in transit.
- **Time to diagnose:** ~1 minute. The reason string is clear about *which* component is broken, but the misleading `payer` field would slow real debugging where the cause isn't already known.
- **What would have helped:** Include the recovered address next to the claimed one — `"claimedPayer": "0xADEe…", "recoveredFromSignature": "0xCD12…"`. Side-by-side makes the three sub-cases instantly distinguishable. This is exactly the kind of decode that an x402trace `inspect` command should do offline against a captured 402.

### 5. Facilitator unavailable

- **What I tried:** Server points `FACILITATOR_URL` at `http://127.0.0.1:9` — TCP port 9 is reserved (`discard`), and undici's `fetch` refuses sub-1024 ports outright. So the verify call fails *before* even attempting the connection.
- **Server error (response body):**
  ```
  HTTP 402
  {
    "error": "fetch failed",
    "accepts": [ … ],
    "x402Version": 1
  }
  ```
- **Server error (console stack):**
  ```
  Payment verification failed: TypeError: fetch failed
      at node:internal/deps/undici/undici:13484:13
      ...
      at async verify2 (node_modules/.../x402/src/verify/useFacilitator.ts:52:17)
      at async paymentMiddleware2 (node_modules/.../x402-hono/src/index.ts:287:28)
    [cause]: Error: bad port
        at makeNetworkError (node:internal/deps/undici/undici:9251:35)
        ...
  ```
- **Client error:** none — client sees a 402 with `"error": "fetch failed"` and no other context. Indistinguishable from a real protocol error from the response alone.
- **Facilitator error:** N/A (no facilitator listening).
- **Where the error surfaced:** Server console (full stack with `[cause]: bad port`). Server response body strips the cause and emits only `"error": "fetch failed"`.
- **Was it actionable from the message alone?** From the **client**: no — "fetch failed" could mean a hundred things, including legitimate facilitator-side errors. From the **server console**: yes if you read the stack, since `cause: bad port` and the URL is implicit from the env. But operators rarely tail server logs in production.
- **Time to diagnose:** ~5 minutes if you don't have server console access; ~30 seconds if you do. The asymmetry is the problem.
- **What would have helped:** Server error body should include (a) which URL it was trying to reach and (b) the underlying network/cause if any — e.g., `"facilitatorUrl": "http://127.0.0.1:9", "facilitatorError": "fetch failed: bad port"`. Even a structured `"facilitatorUnreachable": true` flag would let clients distinguish "your payment was rejected" from "we couldn't even ask." This is a high-signal failure for the v0.1 reconciliation engine — when facilitator times out and the on-chain tx may still settle (the canonical x402 issue #1062 case), the client needs to know the verify call never returned a real answer.

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
