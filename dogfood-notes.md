# dogfood-notes.md

> Running journal of pain encountered while dogfooding x402 during Week 1 ([X402-3](https://vahdatfardin.atlassian.net/browse/X402-3), [X402-4](https://vahdatfardin.atlassian.net/browse/X402-4)). Becomes the input to the wedge decision ([X402-7](https://vahdatfardin.atlassian.net/browse/X402-7)).
>
> **Honesty rule:** write what actually happened, not what would have made the journal look good. Time-to-diagnose includes the 30 minutes you spent on Stack Overflow looking up the wrong thing.

---

## Setup

_To be filled in by X402-3._

- **Server URL:** _TBD_
- **Server framework:** Hono with `paymentMiddleware`
- **Client repo:** _TBD_
- **Wallet address:** _TBD (testnet)_
- **RPC URL:** _TBD_
- **Facilitator URL:** _TBD_
- **Setup commit:** _TBD_

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
