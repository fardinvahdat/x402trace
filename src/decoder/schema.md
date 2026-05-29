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

### `bazaar.probe_attempt`

X402-52 (I, ADR-006) — emitted by `bazaar-check`'s reachability check on every network-layer probe of the service URL. Records the outcome of a single probe attempt so re-invocations can compute multi-probe consensus.

```json
{
  "event": "bazaar.probe_attempt",
  "t": "2026-05-30T12:00:00.000Z",
  "service_url": "https://api.example.com/x402",
  "attempt_seq": 3,
  "unreachable_cause": "dns_failure",
  "latency_ms": 50
}
```

- `t` — ISO-8601 UTC timestamp. Used by `consensusReached` for window-membership computation.
- `service_url` — Service URL probed. Used as the grouping key when reading prior `probe_attempt` records (probes for different services don't cross-contaminate consensus).
- `attempt_seq` — 1-indexed sequence within the (service_url, log file) pair. Monotonically increases across invocations of `bazaar-check --probe-history-log <file>`.
- `unreachable_cause` — `null` when probe succeeded (HTTP 2xx/3xx/4xx response); otherwise one of `"dns_failure" | "tcp_refused" | "tls_error" | "timeout" | "persistent_5xx"`. See `src/bazaar/diagnose-rules.md` § reachability for classification semantics.
- `latency_ms` — Wall-clock latency of the probe (from request initiation to response or error).

Written to the JSONL path supplied via `bazaar-check --probe-history-log <file>` (or `BazaarCheckOptions.probeHistoryLog`). When absent, no record is emitted and the reachability check runs in single-probe-only mode — top-level `service_unreachable` verdict cannot fire because consensus is never reached.

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

## Related: `DiagnosticContext` (in-memory only, not part of the JSONL contract)

The X402-33 facilitator-aware diagnose rules (`cdp-min-amount`, `self-payment`, `facilitator-throttling`, `extension-responses-missing`, `gas-estimation-failure`) read from an in-memory `DiagnosticContext.facilitator` field plus a `DiagnosticContext.expectsBazaarExtensions` flag. These fields are NOT currently captured in the JSONL events above — they're populated by live callers (`bazaar-check` from X402-32, `validate --diff` from X402-35) that drive facilitator HTTP themselves.

When a future ticket needs the facilitator-aware rules to run against an `explain`-style replay of a captured JSONL log, the canonical surface to extend is the JSONL — likely by enriching `exchange.settlement` with `httpStatus`, `headers` (lowercase-key map), and `errorMessage` fields. That would be a schema change requiring an ADR per ADR-001.

Canonical TypeScript shape (until/unless it lands in JSONL): see `FacilitatorInteraction` in [`src/diagnose/types.ts`](../diagnose/types.ts).
