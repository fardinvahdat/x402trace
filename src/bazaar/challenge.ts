/**
 * X402-32 — 402 challenge structure check.
 *
 * Hits the service URL with an unpaid GET. Expects a 402 response with
 * a valid x402 challenge body. Validates:
 *
 *   - HTTP status is 402.
 *   - Body parses as JSON.
 *   - `accepts[0]` exists and decodes as `PaymentRequirements`.
 *   - `extensions.bazaar` is present (when caller signals
 *     `expectBazaar: true`) and has `name` + `description` strings.
 *
 * Why bazaar metadata matters: the listing UI on agentic.market shows
 * `extensions.bazaar.name` and `extensions.bazaar.description` per
 * route. Without them, the listing falls back to raw URLs (TheRoosters,
 * GM in Discord transcript). With them mangled, the listing looks
 * unprofessional and operators have to file support tickets to fix.
 */

import { parseChallengeBody } from "../decoder/parse.js";
import type { CheckResult, ChallengeFetchResult } from "./types.js";

export interface ChallengeFetchOptions {
  /**
   * When true, also validate that the 402 body contains
   * `extensions.bazaar` with the minimum fields `name` and
   * `description`. Default `true` — bazaar-check is, by name, about
   * bazaar.
   */
  readonly expectBazaar?: boolean;
}

export type ChallengeFetcher = (url: string) => Promise<Response>;

export async function fetchChallenge(
  serviceUrl: string,
  fetcher: ChallengeFetcher = fetch,
): Promise<ChallengeFetchResult> {
  let response: Response;
  try {
    response = await fetcher(serviceUrl);
  } catch (err) {
    return {
      ok: false,
      reason: `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (response.status !== 402) {
    return {
      ok: false,
      reason: `expected HTTP 402 from ${serviceUrl}, got ${response.status}`,
      httpStatus: response.status,
    };
  }
  let bodyText: string;
  try {
    bodyText = await response.text();
  } catch {
    return { ok: false, reason: `failed to read response body from ${serviceUrl}` };
  }
  const parsed = parseChallengeBody(bodyText);
  if (!parsed.ok) {
    return {
      ok: false,
      reason: `challenge body parse failed: ${parsed.message}`,
      httpStatus: 402,
    };
  }
  let rawBody: unknown = undefined;
  try {
    rawBody = JSON.parse(bodyText);
  } catch {
    rawBody = undefined;
  }
  return { ok: true, requirements: parsed.value.requirements, rawBody };
}

/**
 * Validate the challenge structure once fetched. Splits fetching from
 * validation so callers can substitute fixtures in tests.
 */
export function checkChallenge(
  serviceUrl: string,
  fetchResult: ChallengeFetchResult,
  opts: ChallengeFetchOptions = {},
): CheckResult {
  const expectBazaar = opts.expectBazaar ?? true;

  if (!fetchResult.ok) {
    return {
      check: "challenge",
      status: "fail",
      message: `${serviceUrl}: ${fetchResult.reason}`,
      fix: `the service must respond 402 with a valid x402 v1 or v2 challenge body when called without an X-PAYMENT header. Check that the x402 middleware is mounted on this route.`,
      ...(fetchResult.httpStatus ? { detail: { httpStatus: fetchResult.httpStatus } } : {}),
    };
  }

  if (!expectBazaar) {
    return {
      check: "challenge",
      status: "pass",
      message: `402 challenge structure valid for ${serviceUrl} (bazaar extension not required by caller)`,
    };
  }

  const rawBody = fetchResult.rawBody;
  if (typeof rawBody !== "object" || rawBody === null) {
    return {
      check: "challenge",
      status: "fail",
      message: `${serviceUrl}: challenge body has no extensions structure`,
      fix: `add extensions.bazaar = { name: "...", description: "..." } to the 402 response body so Bazaar can list the service correctly.`,
    };
  }
  const bodyObj = rawBody as Record<string, unknown>;
  const extensions = bodyObj["extensions"];
  if (typeof extensions !== "object" || extensions === null) {
    return {
      check: "challenge",
      status: "fail",
      message: `${serviceUrl}: no top-level extensions field in 402 body`,
      fix: `add an extensions object to the 402 body: { ..., extensions: { bazaar: { name, description } } }. Most SDKs ship a helper for this — for @x402/hono use declareDiscoveryExtension.`,
    };
  }
  const bazaar = (extensions as Record<string, unknown>)["bazaar"];
  if (typeof bazaar !== "object" || bazaar === null) {
    return {
      check: "challenge",
      status: "fail",
      message: `${serviceUrl}: extensions.bazaar is missing or not an object`,
      fix: `populate extensions.bazaar = { name: "Your service", description: "What it does" }. Without this, agentic.market falls back to raw URLs.`,
    };
  }
  const bazaarObj = bazaar as Record<string, unknown>;
  const missing: string[] = [];
  if (typeof bazaarObj["name"] !== "string" || (bazaarObj["name"] as string).trim() === "") {
    missing.push("name");
  }
  if (
    typeof bazaarObj["description"] !== "string" ||
    (bazaarObj["description"] as string).trim() === ""
  ) {
    missing.push("description");
  }
  if (missing.length > 0) {
    return {
      check: "challenge",
      status: "fail",
      message: `${serviceUrl}: extensions.bazaar is missing required fields: ${missing.join(", ")}`,
      fix: `every Bazaar listing needs extensions.bazaar.name (string, non-empty) and extensions.bazaar.description (string, non-empty). TheRoosters + GM in Discord hit this — fix it and the listing renders correctly.`,
      detail: { missingFields: missing },
    };
  }
  return {
    check: "challenge",
    status: "pass",
    message: `extensions.bazaar present (name="${bazaarObj["name"]}", description set)`,
  };
}

/**
 * Self-payment guard: `payer == payTo` is rejected by some facilitators
 * (notably CDP). Reuses [X402-33]'s selfPaymentRule semantics inline
 * here since we don't have a `payer` until the payment is signed —
 * but we can warn if the operator's payTo matches a known test wallet,
 * or if the operator passed `--payer-hint` we can compare. For v0.3
 * the check is informational unless the caller passes a hint.
 */
export function checkSelfPayment(payTo: string, payerHint?: string): CheckResult {
  if (!payerHint) {
    return {
      check: "self-payment",
      status: "pass",
      message: "no payer-hint supplied; self-payment guard skipped (pass by default)",
    };
  }
  if (payerHint.toLowerCase() === payTo.toLowerCase()) {
    return {
      check: "self-payment",
      status: "fail",
      message: `payer-hint ${payerHint} equals payTo ${payTo} — CDP rejects self-payment with a generic invalid_payload`,
      fix: `use a different wallet for signing test payments, or route through a facilitator that allows self-payment (e.g. xpay). TerraDeed switched CDP → xpay specifically for this.`,
    };
  }
  return {
    check: "self-payment",
    status: "pass",
    message: `payer-hint ${payerHint.slice(0, 10)}… differs from payTo`,
  };
}
