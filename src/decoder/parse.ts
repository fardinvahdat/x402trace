/**
 * Pure parsers from raw HTTP signal → typed x402 structures.
 *
 * Per CLAUDE.md hard rule 4 ("Don't reproduce code from x402 SDKs.
 * Use them as dependencies."), we use the `x402` package's
 * `exact.evm.decodePayment` for the v1 X-PAYMENT header. The v2
 * `PAYMENT-SIGNATURE` header is base64-encoded JSON of a similar
 * shape; the SDK's v1-only decoder rejects it, so we add a
 * minimal forward-compatible parser inline. v0.1 produces the same
 * normalized `PaymentPayload` shape for both surfaces.
 */
import { exact } from "x402/schemes";
import type {
  FacilitatorResponse,
  PaymentPayload,
  PaymentRequirements,
  X402Version,
} from "./types.js";

interface ParseError {
  readonly ok: false;
  readonly message: string;
}
interface ParseOk<T> {
  readonly ok: true;
  readonly value: T;
}
export type ParseResult<T> = ParseOk<T> | ParseError;

const PAYMENT_HEADER_V1 = "x-payment";
const PAYMENT_HEADER_V2 = "payment-signature";
const SETTLEMENT_HEADER_V1 = "x-payment-response";
const SETTLEMENT_HEADER_V2 = "payment-response";

/**
 * Detect the x402 protocol version from headers + body. Returns 1
 * (default) when no clear v2 marker is present.
 */
export function detectVersion(headers: Record<string, string>, body?: unknown): X402Version {
  if (headers[PAYMENT_HEADER_V2] || headers[SETTLEMENT_HEADER_V2]) return 2;
  if (
    body &&
    typeof body === "object" &&
    "x402Version" in body &&
    (body as { x402Version: unknown }).x402Version === 2
  ) {
    return 2;
  }
  return 1;
}

/**
 * Find the (request) payment header value, preferring v1 then v2.
 */
export function findPaymentHeader(
  headers: Record<string, string>,
): { name: string; value: string; version: X402Version } | null {
  if (headers[PAYMENT_HEADER_V1]) {
    return { name: PAYMENT_HEADER_V1, value: headers[PAYMENT_HEADER_V1], version: 1 };
  }
  if (headers[PAYMENT_HEADER_V2]) {
    return { name: PAYMENT_HEADER_V2, value: headers[PAYMENT_HEADER_V2], version: 2 };
  }
  return null;
}

/**
 * Find the (response) settlement header value.
 */
export function findSettlementHeader(
  headers: Record<string, string>,
): { name: string; value: string; version: X402Version } | null {
  if (headers[SETTLEMENT_HEADER_V1]) {
    return { name: SETTLEMENT_HEADER_V1, value: headers[SETTLEMENT_HEADER_V1], version: 1 };
  }
  if (headers[SETTLEMENT_HEADER_V2]) {
    return { name: SETTLEMENT_HEADER_V2, value: headers[SETTLEMENT_HEADER_V2], version: 2 };
  }
  return null;
}

/**
 * Parse a 402 response body (raw text) into a v1 / v2 challenge.
 * Returns the first `accepts[]` entry — v0.1 picks the head; downstream
 * tools can extend.
 */
export function parseChallengeBody(
  rawBody: string,
): ParseResult<{ requirements: PaymentRequirements; x402Version: X402Version; error?: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch (err) {
    return { ok: false, message: `challenge body is not JSON: ${(err as Error).message}` };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, message: "challenge body is not an object" };
  }
  const obj = parsed as {
    x402Version?: number;
    accepts?: unknown[];
    error?: string;
  };
  const x402Version: X402Version = obj.x402Version === 2 ? 2 : 1;
  if (!Array.isArray(obj.accepts) || obj.accepts.length === 0) {
    return { ok: false, message: "challenge body missing accepts[]" };
  }
  const first = obj.accepts[0];
  if (!first || typeof first !== "object") {
    return { ok: false, message: "challenge accepts[0] is not an object" };
  }
  const r = first as Record<string, unknown>;
  // v2 renamed `maxAmountRequired` → `amount` and moved `resource` from
  // per-accept to top-level PaymentRequired. Normalize the amount rename at
  // parse time so downstream consumers (validate-command, diagnose/rules,
  // decoder/format) keep working without per-field branches. The resource
  // field is dropped from required-keys in v2 because the canonical v2 spec
  // doesn't carry it per-accept.
  if (x402Version === 2 && typeof r.amount === "string" && typeof r.maxAmountRequired !== "string") {
    r.maxAmountRequired = r.amount;
  }
  const requiredKeys =
    x402Version === 2
      ? ["scheme", "network", "maxAmountRequired", "payTo", "asset"]
      : ["scheme", "network", "maxAmountRequired", "resource", "payTo", "asset"];
  for (const k of requiredKeys) {
    if (typeof r[k] !== "string") {
      const hint = k === "maxAmountRequired" && x402Version === 2 ? ` (v2 field name: "amount")` : "";
      return { ok: false, message: `challenge accepts[0].${k}${hint} missing or wrong type` };
    }
  }
  return {
    ok: true,
    value: {
      requirements: first as unknown as PaymentRequirements,
      x402Version,
      ...(obj.error ? { error: obj.error } : {}),
    },
  };
}

function decodeBase64Json(value: string): ParseResult<unknown> {
  let decoded: string;
  try {
    decoded = Buffer.from(value, "base64").toString("utf8");
  } catch (err) {
    return { ok: false, message: `not valid base64: ${(err as Error).message}` };
  }
  try {
    return { ok: true, value: JSON.parse(decoded) };
  } catch (err) {
    return { ok: false, message: `base64 decode is not JSON: ${(err as Error).message}` };
  }
}

function shapeCheckPaymentPayload(parsed: unknown): ParseResult<PaymentPayload> {
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, message: "payment payload is not an object" };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.scheme !== "exact" && typeof obj.scheme !== "string") {
    return { ok: false, message: "payment payload missing scheme" };
  }
  if (typeof obj.network !== "string") {
    return { ok: false, message: "payment payload missing network" };
  }
  const payload = obj.payload as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== "object") {
    return { ok: false, message: "payment payload.payload missing" };
  }
  if (typeof payload.signature !== "string") {
    return { ok: false, message: "payment payload.signature missing" };
  }
  const auth = payload.authorization as Record<string, unknown> | undefined;
  if (!auth || typeof auth !== "object") {
    return { ok: false, message: "payment payload.authorization missing" };
  }
  for (const k of ["from", "to", "value", "validAfter", "validBefore", "nonce"]) {
    if (typeof auth[k] !== "string") {
      return { ok: false, message: `payment payload.authorization.${k} missing` };
    }
  }
  return { ok: true, value: parsed as PaymentPayload };
}

/**
 * Parse a base64-encoded X-PAYMENT / PAYMENT-SIGNATURE header value
 * into a typed `PaymentPayload`. Uses the x402 SDK for v1 fast-path
 * and falls back to a hand-rolled shape check for v2.
 */
export function parsePaymentHeader(
  headerValue: string,
  version: X402Version,
): ParseResult<PaymentPayload> {
  if (version === 1) {
    try {
      const decoded = exact.evm.decodePayment(headerValue) as unknown;
      return shapeCheckPaymentPayload(decoded);
    } catch (err) {
      // Fall through to manual decode — some captured fixtures may not be
      // perfectly schema-conforming and we still want to surface what we can.
      const fallback = decodeBase64Json(headerValue);
      if (!fallback.ok) {
        return { ok: false, message: `v1 SDK decode failed: ${(err as Error).message}` };
      }
      return shapeCheckPaymentPayload(fallback.value);
    }
  }
  // v2: hand-rolled.
  const decoded = decodeBase64Json(headerValue);
  if (!decoded.ok) return decoded;
  return shapeCheckPaymentPayload(decoded.value);
}

/**
 * Parse a base64-encoded X-PAYMENT-RESPONSE / PAYMENT-RESPONSE header
 * value into a `FacilitatorResponse`.
 */
export function parseSettlementHeader(headerValue: string): ParseResult<FacilitatorResponse> {
  const decoded = decodeBase64Json(headerValue);
  if (!decoded.ok) return decoded;
  if (!decoded.value || typeof decoded.value !== "object") {
    return { ok: false, message: "settlement payload is not an object" };
  }
  return { ok: true, value: decoded.value as FacilitatorResponse };
}
