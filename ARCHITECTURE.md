# ARCHITECTURE.md

> **Status:** Accepted (Week 2). Implements [SPEC.md](./SPEC.md) §§ 2–4 in component terms. Read this when a Week-3+ build ticket (X402-10..14) needs to know *how the pieces fit*. The TypeScript interfaces below are the source-of-truth shapes the implementation tickets refine into code.

---

## Component overview

```
                                          ┌───────────────────────────────┐
                                          │   Reconciliation engine       │
                                          │   src/reconciliation/         │
                                          │                               │
                                          │   matches PaymentExchange     │
                                          │   ↔ ChainTransfer by          │
                                          │   (payer, payee, value,       │
                                          │    nonce)                     │
                                          └────▲──────────────────────▲───┘
                                               │                      │
                                          PaymentExchange         ChainTransfer
                                               │                      │
┌────────┐    ┌────────────┐    ┌──────────────┴───┐    ┌─────────────┴──────┐
│ Client │───▶│   Proxy    │───▶│     Decoder      │    │  Chain RPC client  │
│ (agent)│◀───│ src/proxy/ │◀───│  src/decoder/    │    │   src/chain/       │
└────────┘    │            │    │                  │    │                    │
              │ HTTP fwd   │    │ parses 402 hdrs  │    │ viem + Base Sepolia│
              │ + raw      │    │ + X-PAYMENT      │    │ subscribes to USDC │
              │ JSONL log  │    │ + settlement     │    │ Transfer events    │
              └─────┬──────┘    └──────────────────┘    └────────────────────┘
                    │                                              ▲
                    ▼                                              │
            ┌─────────────────┐                            ┌───────┴───────┐
            │  Upstream x402  │                            │  CLI driver   │
            │     server      │                            │  src/cli/     │
            └─────────────────┘                            └───────────────┘
                                                                    │
                                                       composes all of the above
```

Five components, each as its own folder under `src/`. Names are **final** — they become folder names in [X402-10](https://vahdatfardin.atlassian.net/browse/X402-10)–[X402-14](https://vahdatfardin.atlassian.net/browse/X402-14).

---

## Components

### Proxy (`src/proxy/`) — [X402-10](https://vahdatfardin.atlassian.net/browse/X402-10)

- Listens on `--port` (default `8402`). Forwards all HTTP requests/responses to `--upstream`.
- For every request that returns `402 Payment Required` OR includes an `X-PAYMENT` header, emits a typed `ProxyEvent` to the JSONL log AND to an in-memory event bus.
- Does NOT decode payloads. Just records raw headers + bodies (base64 if non-UTF8).
- One JSONL line per event. Append-only. No retries, no buffering longer than the OS flush.
- Read-only: never holds private keys.

### Decoder (`src/decoder/`) — [X402-11](https://vahdatfardin.atlassian.net/browse/X402-11)

- Consumes `ProxyEvent`s, parses x402 protocol messages, produces typed `PaymentExchange` records.
- Handles both protocol surfaces: v1 (`X-PAYMENT`, `X-PAYMENT-RESPONSE`) and v2 (`PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`) — v0.1 normalizes both into the same `PaymentExchange` shape.
- Pure functions, no I/O. Easy to unit-test against fixtures captured by the dogfood rig.

### Chain RPC client (`src/chain/`) — [X402-12](https://vahdatfardin.atlassian.net/browse/X402-12)

- Thin wrapper over `viem`. Connects to `--rpc-url` (default `https://sepolia.base.org`).
- Two exported functions:
  - `subscribeUsdcTransfers(payer?: Address): AsyncIterable<ChainTransfer>` — watches `Transfer(from, to, value)` events from the Base Sepolia USDC contract (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`), optionally filtered to a payer. Also surfaces the matching `AuthorizationUsed(authorizer, nonce)` event from the same tx so the reconciliation engine can match by EIP-3009 nonce.
  - `getTransferByTxHash(hash: Hex): Promise<ChainTransfer | null>` — one-shot lookup for the offline `reconcile --log` path.
- Read-only. Never handles private keys. RPC failures retry with exponential backoff (max 3 attempts), then mark the watch as degraded — the proxy keeps logging regardless.

### Reconciliation engine (`src/reconciliation/`) — [X402-13](https://vahdatfardin.atlassian.net/browse/X402-13)

- Holds an in-memory pending set of `PaymentExchange`s whose `outcome.kind` is `rejected` or `upstream_timeout`. Each has the buyer's signed `PaymentAuthorization`, which carries the EIP-3009 nonce.
- Consumes `ChainTransfer`s from the chain client. Matches against the pending set by `(from, to, value, authorizationNonce)`.
- On a match: emits a `ReconciliationResult` to the JSONL log and the in-memory bus; removes from pending.
- On no match after `--watch-timeout-ms` (default `60000`): emits `kind: 'not_settled'` and removes from pending.
- The match is **exact-equality** on all four fields. No fuzziness; the EIP-3009 nonce alone is unique per (payer, contract), so a (payer, payee, value, nonce) tuple is collision-safe.

### CLI driver (`src/cli/`) — [X402-14](https://vahdatfardin.atlassian.net/browse/X402-14)

- Two subcommands: `proxy` and `reconcile`.
- Wires the four components together based on flags. No business logic of its own.
- Handles signals (SIGINT/SIGTERM) → flush JSONL → exit cleanly.
- Output: stdout for human-friendly summary lines (per [SPEC.md § 3 user flow](./SPEC.md#3-user-flow)); JSONL for the canonical record.

---

## Data flow — one example

A buying agent pays $0.001 USDC through the proxy. The flow:

1. **Agent → Proxy.** `GET http://localhost:8402/api/weather`. No `X-PAYMENT` header.
2. **Proxy → Upstream.** Forwards verbatim. Receives `402` with `accepts: [{network:'base-sepolia', payTo:0xADEe…, value:1000, asset:0x036C…}]`.
3. **Proxy → JSONL.** Emits `{event:'exchange.opened', id, request, raw402}`. Returns `402` to agent.
4. **Decoder.** Picks up the event from the bus. Parses the body, builds `PaymentExchange { id, challenge: PaymentRequirements }`. Re-emits to bus.
5. **Agent.** Signs an EIP-3009 `transferWithAuthorization` (nonce `0xa3f2…`, validBefore = now+300). Retries through proxy with `X-PAYMENT: <base64>`.
6. **Proxy → Upstream.** Forwards. Upstream calls facilitator `/verify` then `/settle`.
7. **Three outcomes (the engine handles all three):**

   **a. Happy path.** Facilitator returns success; upstream returns `200` + `X-PAYMENT-RESPONSE`. Proxy emits `exchange.outcome { kind:'paid', settlement }`. Reconciliation: no-op (success doesn't need reconciliation).

   **b. Facilitator-rejected.** Upstream returns `402` with `error: 'insufficient_balance'` or similar. Proxy emits `exchange.outcome { kind:'rejected', errorReason }`. Reconciliation moves this `PaymentExchange` into the pending set, starts the on-chain watch with `--watch-timeout-ms` budget.

   **c. Facilitator timeout / upstream timeout.** Upstream hangs past its own timeout, returns `502/504/connection-reset`, OR a long delay. Proxy emits `exchange.outcome { kind:'upstream_timeout', afterMs }`. Same handling as (b): move to pending, start chain watch.

8. **Chain client.** Subscribed to USDC `Transfer` events since proxy start. Emits one `ChainTransfer` per matching event.
9. **Reconciliation match.** Iterates pending set. Finds the exchange whose `payment.authorization.nonce` equals the chain event's `authorizationNonce` AND `from/to/value` match. Emits:

   ```
   ReconciliationResult { kind: 'settled_on_chain', exchange, onChain, gapMs: 31_000 }
   ```

   This is the **`RECONCILED ⚠ settled-but-server-thinks-not`** line in [SPEC.md § 3](./SPEC.md#3-user-flow).

10. **CLI.** Renders the result line to stdout. JSONL `reconcile.result` record is the durable artifact.

---

## Key interfaces

These TypeScript shapes are the boundaries between components. Implementation tickets refine the bodies but **keep these names and discriminants** so the JSONL format stays stable across versions.

```typescript
// src/decoder/types.ts — parsed x402 protocol messages

export interface PaymentRequirements {
  scheme: "exact";
  network: "base-sepolia";
  maxAmountRequired: string; // base units, USDC has 6 decimals
  resource: string;           // resource URL the buyer requested
  payTo: `0x${string}`;
  asset: `0x${string}`;       // ERC-20 contract
  maxTimeoutSeconds: number;
  extra: { name: string; version: string }; // EIP-712 domain components
  x402Version: 1;
}

export interface PaymentAuthorization {
  from: `0x${string}`;
  to: `0x${string}`;
  value: string;            // same scale as maxAmountRequired
  validAfter: string;       // unix seconds
  validBefore: string;
  nonce: `0x${string}`;     // EIP-3009 nonce, 32 bytes
}

export interface PaymentPayload {
  x402Version: 1;
  scheme: "exact";
  network: "base-sepolia";
  payload: { signature: `0x${string}`; authorization: PaymentAuthorization };
}

export interface FacilitatorResponse {
  isValid?: boolean;
  invalidReason?: string;       // verify path
  success?: boolean;
  transaction?: `0x${string}`;  // settle path, on-chain tx
  payer?: `0x${string}`;
  network?: string;
  errorReason?: string;
}
```

```typescript
// src/proxy/types.ts — captured request lifecycles

export type ExchangeOutcome =
  | { kind: "paid"; status: 200; settlement: FacilitatorResponse; receivedAt: string }
  | { kind: "rejected"; status: 402; errorReason: string; receivedAt: string }
  | { kind: "upstream_timeout"; afterMs: number; observedAt: string }
  | { kind: "unknown"; status: number; receivedAt: string };

export interface PaymentExchange {
  id: string;                          // ULID — sortable, unique across processes
  startedAt: string;                   // ISO 8601
  proxyPort: number;
  upstreamUrl: string;
  request: { method: string; path: string; headers: Record<string, string> };
  challenge?: PaymentRequirements;     // set once decoder parses the 402
  payment?: PaymentPayload;            // set once decoder parses the X-PAYMENT
  outcome?: ExchangeOutcome;           // set once the response cycle closes
  completedAt?: string;
}
```

```typescript
// src/chain/types.ts — on-chain settlement events

export interface ChainTransfer {
  txHash: `0x${string}`;
  blockNumber: bigint;
  blockTimestamp: number;                  // unix seconds
  from: `0x${string}`;
  to: `0x${string}`;
  value: bigint;                           // raw base units
  authorizationNonce?: `0x${string}`;      // from the same-tx AuthorizationUsed event
}
```

```typescript
// src/reconciliation/types.ts — match outcomes

export type ReconciliationResult =
  | { kind: "settled_on_chain";
      exchange: PaymentExchange;
      onChain: ChainTransfer;
      gapMs: number; }                     // observation-to-match latency
  | { kind: "not_settled";
      exchange: PaymentExchange;
      waitedMs: number; }
  | { kind: "value_mismatch";
      exchange: PaymentExchange;
      onChain: ChainTransfer;
      expected: bigint; actual: bigint; }
  | { kind: "recipient_mismatch";
      exchange: PaymentExchange;
      onChain: ChainTransfer;
      expectedPayee: `0x${string}`;
      actualPayee: `0x${string}`; };
```

---

## JSONL record format

The proxy + decoder + chain + reconciler all append to one JSONL file. Every line has `t` (ISO 8601 timestamp) and `event` (discriminant). One event per line, no nesting, ordering by line number = causal order within a process.

| `event` | Source | Body |
|---|---|---|
| `exchange.opened` | Proxy | `id`, `request: {method, path, headers}`, `upstreamUrl` |
| `exchange.challenge` | Decoder | `id`, `challenge: PaymentRequirements` |
| `exchange.payment` | Decoder | `id`, `payment: PaymentPayload` |
| `exchange.outcome` | Proxy (after upstream replies) | `id`, `outcome: ExchangeOutcome` |
| `chain.transfer` | Chain RPC client | `ChainTransfer` flattened |
| `reconcile.result` | Reconciliation engine | `ReconciliationResult` flattened |
| `proxy.error` | Any | `id?`, `message`, `stack?` |

Downstream tooling (`x402trace reconcile --log <file>`, future v0.2 features) reads only the JSONL. **The file IS the API.** Breaking changes to this shape require a new ADR.

---

## Configuration

Precedence (highest wins):

| Source | Precedence |
| --- | --- |
| CLI flag | 1 (highest) |
| Environment variable | 2 |
| `.env` file | 3 |
| Built-in default | 4 (lowest) |

Full list:

| Flag | Env | Default | Component |
|---|---|---|---|
| `--upstream <url>` | `X402TRACE_UPSTREAM` | _(required)_ | Proxy |
| `--port <n>` | `X402TRACE_PORT` | `8402` | Proxy |
| `--log <path>` | `X402TRACE_LOG` | `./x402trace.jsonl` | Proxy / all |
| `--rpc-url <url>` | `BASE_RPC_URL` | `https://sepolia.base.org` | Chain |
| `--reconcile` | `X402TRACE_RECONCILE` | `false` (opt-in) | Reconciliation |
| `--watch-timeout-ms <n>` | `X402TRACE_WATCH_TIMEOUT_MS` | `60000` | Reconciliation |
| `--rpc-timeout-ms <n>` | `X402TRACE_RPC_TIMEOUT_MS` | `10000` | Chain |
| `--log-level <lvl>` | `LOG_LEVEL` | `info` | CLI |

See [`.env.example`](./.env.example) for the canonical template.

---

## Extension points

Where v0.2 features (from [SPEC.md § 5](./SPEC.md#5-v02-stretch-deferred-not-killed) and [dogfood-notes.md § Wedge candidates](./dogfood-notes.md#wedge-candidates)) plug in without touching v0.1's core:

- **`--watch` (monitor mode)** — wraps the proxy in attach-mode against an already-running service. Hooks into Proxy's event bus; the rest of the pipeline is unchanged.
- **`--diff <fac-a,fac-b>` (cross-facilitator)** — replays a captured `PaymentPayload` from the JSONL against multiple `FACILITATOR_URL`s using the Decoder's types. New module under `src/cross-facilitator/`, reads JSONL, doesn't touch Proxy or Chain.
- **`--replay <log.jsonl>` (offline reconcile)** — already supported in v0.1 via `x402trace reconcile --log`. v0.2 extends with `--from <timestamp>` slicing.
- **`x402trace inspect <captured-402.json>`** — uses Decoder's `PaymentRequirements` + `PaymentPayload` types to produce a translator output. No proxy/chain needed; pure-function.
- **`x402trace doctor <wallet> <service>`** — new pre-flight CLI. Reads Chain client's `getBalance`/`getAllowance` (new exports) plus the Decoder's spec-validation helpers. Doesn't touch Proxy.
- **`x402trace bazaar-check`** — new module under `src/bazaar/`, reads a JSONL exchange + service URL, calls CDP discovery + agentic.market APIs. Independent of Proxy.
- **`x402trace versions`** — pure dependency-tree analyzer, no other components.

Every v0.2 feature builds on a type or capability already exported by a v0.1 component. **No v0.1 component is rewritten for v0.2.** That's the test of this architecture.
