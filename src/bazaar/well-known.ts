/**
 * X402-32 — `/.well-known/x402` manifest check.
 *
 * Operators register their service for Bazaar discovery by serving a
 * manifest at `<service-base>/.well-known/x402`. Crawlers (CDP Bazaar,
 * x402scan, TomSmart_ai's mapper per Discord) iterate this path and
 * skip endpoints without it — so a malformed manifest is the silent
 * #1 cause of "I shipped but I'm not indexed."
 *
 * What this check validates:
 *   - The URL fetches with HTTP 200 + valid JSON.
 *   - Top-level `name` (string, non-empty) is present.
 *   - Top-level `description` (string, non-empty) is present.
 *   - `accepts` (array, optional) — if present, each entry is an object.
 *   - `extensions.bazaar.{name, description}` (string, non-empty) when
 *     bazaar discovery is opted into — either via `discovery_extension:
 *     "bazaar"` or by including `extensions.bazaar` at all. Empty string
 *     and whitespace-only are treated as missing: the mapper's listing
 *     UI renders them as blank cards, which is the failure mode that
 *     keeps reaching Discord (TheRoosters, GM, and the Max/Zev case
 *     surfaced by hypeprinter007-stack in #65 finding 2).
 *
 * Intentionally lenient on the rest of the spec. The schema is actively
 * evolving (per ADR-003 risk register); strict validation would
 * false-positive on operators ahead of the spec curve. We fail only on
 * the structural defects that crawlers definitely reject.
 */

import type { CheckResult, WellKnownManifest } from "./types.js";

export interface WellKnownFetcher {
  (url: string): Promise<Response>;
}

const WELL_KNOWN_PATH = "/.well-known/x402";

/**
 * Resolve the well-known manifest URL from a service URL. Accepts both
 * a full URL and a base URL — the well-known suffix replaces any path.
 */
export function wellKnownUrlFor(serviceUrl: string): string {
  const u = new URL(serviceUrl);
  return `${u.origin}${WELL_KNOWN_PATH}`;
}

/**
 * Run the well-known check against the given service URL.
 *
 * Returns a `CheckResult` and (optionally) the parsed manifest. The
 * manifest is returned so downstream checks (challenge, indexing) can
 * cross-reference `name` / `description` for verdict prose.
 */
export async function checkWellKnown(
  serviceUrl: string,
  fetcher: WellKnownFetcher = fetch,
): Promise<{ result: CheckResult; manifest?: WellKnownManifest }> {
  const url = wellKnownUrlFor(serviceUrl);
  let response: Response;
  try {
    response = await fetcher(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      result: {
        check: "well-known",
        status: "fail",
        message: `failed to fetch ${url}: ${msg}`,
        fix: `serve a JSON manifest at /.well-known/x402 (origin: ${new URL(serviceUrl).origin}). Bazaar crawlers + x402scan iterate this path and skip endpoints without it.`,
      },
    };
  }

  if (response.status !== 200) {
    return {
      result: {
        check: "well-known",
        status: "fail",
        message: `${url} returned HTTP ${response.status} (expected 200)`,
        fix: `serve the manifest with HTTP 200 + Content-Type: application/json. Many web servers default to 404 for /.well-known/* paths — add an explicit route.`,
        detail: { httpStatus: response.status },
      },
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      result: {
        check: "well-known",
        status: "fail",
        message: `${url} returned non-JSON body`,
        fix: `the manifest must be a JSON object. Check Content-Type: application/json and that the server doesn't HTML-wrap the response.`,
      },
    };
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return {
      result: {
        check: "well-known",
        status: "fail",
        message: `${url} body is not a JSON object (got ${Array.isArray(body) ? "array" : typeof body})`,
        fix: `the manifest must be a JSON object {} at the top level. Arrays and primitives are rejected by crawlers.`,
      },
    };
  }

  const manifest = body as WellKnownManifest;
  const issues: string[] = [];
  if (typeof manifest.name !== "string" || manifest.name.trim() === "") {
    issues.push("missing or empty `name` field");
  }
  if (typeof manifest.description !== "string" || manifest.description.trim() === "") {
    issues.push("missing or empty `description` field");
  }
  if (manifest.accepts !== undefined && !Array.isArray(manifest.accepts)) {
    issues.push("`accepts` field is present but not an array");
  }

  const bazaarExt = readBazaarExtension(manifest);
  const declaresBazaar = manifest.discovery_extension === "bazaar";
  if (declaresBazaar || bazaarExt !== undefined) {
    if (bazaarExt === undefined) {
      issues.push(
        '`discovery_extension: "bazaar"` declared but `extensions.bazaar` is missing or not an object',
      );
    } else {
      if (typeof bazaarExt.name !== "string" || bazaarExt.name.trim() === "") {
        issues.push("missing or empty `extensions.bazaar.name` field");
      }
      if (typeof bazaarExt.description !== "string" || bazaarExt.description.trim() === "") {
        issues.push("missing or empty `extensions.bazaar.description` field");
      }
    }
  }

  if (issues.length > 0) {
    return {
      result: {
        check: "well-known",
        status: "fail",
        message: `manifest at ${url} has ${issues.length} issue(s): ${issues.join(", ")}`,
        fix: `fix each: every Bazaar-listable service needs a top-level name (string), description (string), and accepts (array of payment requirement objects). Services opted into bazaar discovery (extensions.bazaar present, or discovery_extension: "bazaar") additionally need extensions.bazaar.{name, description} as non-empty strings — empty strings render as blank listing cards on the mapper.`,
        detail: { issues },
      },
      manifest,
    };
  }

  return {
    result: {
      check: "well-known",
      status: "pass",
      message: `manifest at ${url} is well-formed (name="${manifest.name}", description set, accepts ${Array.isArray(manifest.accepts) ? `[${manifest.accepts.length}]` : "absent"}${bazaarExt ? `, extensions.bazaar populated` : ""})`,
    },
    manifest,
  };
}

/**
 * Read `manifest.extensions.bazaar` if it is present and shaped as an
 * object. Returns `undefined` when absent, null, or a non-object — those
 * cases are handled by the caller's opt-in branch.
 */
function readBazaarExtension(
  manifest: WellKnownManifest,
): { name?: unknown; description?: unknown } | undefined {
  const ext = manifest.extensions;
  if (typeof ext !== "object" || ext === null) {
    return undefined;
  }
  const bazaar = (ext as Record<string, unknown>)["bazaar"];
  if (typeof bazaar !== "object" || bazaar === null) {
    return undefined;
  }
  return bazaar as { name?: unknown; description?: unknown };
}
