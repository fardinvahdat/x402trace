# ARCHITECTURE.md

> **Status:** Skeleton. Finalized by [X402-9](https://vahdatfardin.atlassian.net/browse/X402-9) during Week 2.

---

## Component overview

```
                                                                          ┌─────────────────┐
                                                                          │  Reconciliation │
                                                                          │     engine      │
                                                                          └────────▲────────┘
                                                                                   │
┌────────┐    ┌────────┐    ┌──────────┐    ┌─────────────┐    ┌────────────┐    │
│ Client │───▶│ Proxy  │───▶│ Decoder  │───▶│ RPC Client  │────┼────────────┼────┘
└────────┘    └───┬────┘    └──────────┘    │   (viem)    │    │   Output   │
                  │                          └─────────────┘    └────────────┘
                  ▼
           ┌─────────────┐
           │  Upstream   │
           │ x402 server │
           └─────────────┘
```

_Diagram and component descriptions filled in by X402-9._

---

## Components

### Proxy (`src/proxy/`)

_TBD — see [X402-10](https://vahdatfardin.atlassian.net/browse/X402-10)_

- Listens on configurable port
- Forwards requests/responses to upstream
- Emits structured events consumed by other components

### Decoder (`src/decoder/`)

_TBD — see [X402-11](https://vahdatfardin.atlassian.net/browse/X402-11)_

- Parses `PAYMENT-REQUIRED` and `PAYMENT-RESPONSE` headers
- Produces typed `PaymentExchange` objects
- Drives the structured logger

### Chain RPC client (`src/chain/`)

_TBD — see [X402-12](https://vahdatfardin.atlassian.net/browse/X402-12)_

- Wraps viem
- Single primary function: `verifyTransfer(...)`
- Read-only; never handles private keys

### Reconciliation engine (`src/reconciliation/`)

_TBD — see [X402-13](https://vahdatfardin.atlassian.net/browse/X402-13)_

- Watches payment exchanges
- On facilitator failure, queries chain for the corresponding on-chain settlement
- Emits `ReconciliationResult`

### CLI (`src/cli/`)

_TBD — see [X402-14](https://vahdatfardin.atlassian.net/browse/X402-14)_

- Argument parsing
- Output formatting (human + JSON)
- Composition of the above components

---

## Data flow

(One example x402 exchange traced end-to-end through every component.)

_TBD in X402-9._

---

## Key interfaces

```typescript
// To be defined in X402-9.

export interface PaymentExchange {
  // TBD
}

export interface FacilitatorResponse {
  // TBD
}

export interface ChainTx {
  // TBD
}

export type ReconciliationResult =
  | { status: 'settled'; evidence: ChainTx }
  | { status: 'not_found' }
  | { status: 'wrong_amount'; expected: bigint; actual: bigint; evidence: ChainTx }
  | { status: 'wrong_recipient'; expected: string; actual: string; evidence: ChainTx };
```

---

## Configuration

Precedence (highest wins):

| Source | Precedence |
| --- | --- |
| CLI flag | 1 (highest) |
| Environment variable | 2 |
| `.env` file | 3 |
| Built-in default | 4 (lowest) |

See [`.env.example`](./.env.example) for the full list of configurable values.

---

## Extension points

Where v0.2 features plug in. _Filled in by X402-9._

- `--watch` mode hooks into _TBD_
- `--diff` mode hooks into _TBD_
- `--replay` mode hooks into _TBD_
- `--explain` mode hooks into _TBD_
