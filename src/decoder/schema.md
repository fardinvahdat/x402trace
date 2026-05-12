# Decoder JSON schema

> Authoritative shape of the events `src/decoder/` emits. Stable contract per [ARCHITECTURE.md § JSONL record format](../../ARCHITECTURE.md#jsonl-record-format) — **the file is the API.** Breaking changes require a new ADR.

The decoder consumes raw `ProxyEvent`s from `src/proxy/` and emits `DecodedEvent`s. Each emitted event is one JSON object per line in the same JSONL log the proxy writes (or in a separate decoder log if the operator splits them).

## Events

### `exchange.challenge`

Emitted when the proxy captures a 402 response whose body is a well-formed x402 v1/v2 challenge.

```json
{
  "event": "exchange.challenge",
  "t": "2026-06-15T14:21:03Z",
  "id": "<uuid>",
  "x402Version": 1,
  "challenge": {
    "scheme": "exact",
    "network": "base-sepolia",
    "maxAmountRequired": "1000",
    "resource": "https://api.example.com/api/weather",
    "description": "...",
    "mimeType": "application/json",
    "payTo": "0x...",
    "maxTimeoutSeconds": 300,
    "asset": "0x036C...",
    "outputSchema": { ... },
    "extra": { "name": "USDC", "version": "2" }
  },
  "raw402Error": "X-PAYMENT header is required"
}
```

- `raw402Error` is optional and only set when the 402 body has a top-level `error` string.
- `challenge` is the **first** entry of `accepts[]` in the original v1 spec. Future versions may emit multiple challenge events per response.

### `exchange.payment`

Emitted when the proxy captures a request carrying an `X-PAYMENT` (v1) or `PAYMENT-SIGNATURE` (v2) header.

```json
{
  "event": "exchange.payment",
  "t": "2026-06-15T14:21:04Z",
  "id": "<uuid>",
  "x402Version": 1,
  "payment": {
    "x402Version": 1,
    "scheme": "exact",
    "network": "base-sepolia",
    "payload": {
      "signature": "[REDACTED]",
      "authorization": {
        "from": "0x...",
        "to": "0x...",
        "value": "1000",
        "validAfter": "0",
        "validBefore": "1750000000",
        "nonce": "0xa3f2..."
      }
    }
  }
}
```

- `payload.signature` is `[REDACTED]` by default. Pass `logSecrets: true` to `createDecoder` (or `--log-secrets` from the CLI) to keep the raw signature.

### `exchange.settlement`

Emitted when the proxy captures a response carrying an `X-PAYMENT-RESPONSE` (v1) or `PAYMENT-RESPONSE` (v2) header.

```json
{
  "event": "exchange.settlement",
  "t": "2026-06-15T14:21:05Z",
  "id": "<uuid>",
  "settlement": {
    "success": true,
    "transaction": "0xc5758bf2...",
    "network": "base-sepolia",
    "payer": "0xADEe..."
  }
}
```

- `success` is present on the settle path; verify-side failures show up via `isValid: false` + `invalidReason`.
- `transaction` is the on-chain hash from the facilitator's settlement broadcast.

### `decoder.error`

Emitted when a parse step fails. The proxy event still appears in the JSONL log; this event annotates _why_ it couldn't be decoded so downstream tools can flag the exchange.

```json
{
  "event": "decoder.error",
  "t": "2026-06-15T14:21:03Z",
  "id": "<uuid>",
  "stage": "challenge",
  "message": "challenge body is not JSON: Unexpected token ..."
}
```

- `stage` is `"challenge"` | `"payment"` | `"settlement"`.

## Versioning

Two protocol surfaces are recognized:

| Surface | Request header      | Response header      | `x402Version` body field |
| ------- | ------------------- | -------------------- | ------------------------ |
| v1      | `X-PAYMENT`         | `X-PAYMENT-RESPONSE` | `1`                      |
| v2      | `PAYMENT-SIGNATURE` | `PAYMENT-RESPONSE`   | `2`                      |

v0.1 of x402trace normalizes both into the same `PaymentPayload` / `FacilitatorResponse` shape. The `x402Version` field on `exchange.challenge` and `exchange.payment` events records which surface was on the wire so downstream tooling can branch when needed.
