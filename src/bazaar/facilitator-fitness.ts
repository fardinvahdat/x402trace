/**
 * X402-51 (v0.3.4 G, ADR-005) — facilitator-aware fitness check.
 *
 * Probes the merchant's declared facilitator(s) `/verify` endpoint
 * and emits a per-rail fitness facet under
 * `extensions.bazaar.facilitator_fitness`. Closes the v0.3.2 gap:
 * `indexing.indexer_state: not_applicable_non_cdp` correctly avoids
 * misattribution but offers no positive fitness signal — non-CDP
 * services get verdict silence on the facilitator dimension. G fills
 * the silence with a per-rail health probe.
 *
 * **Identity source: declared `extensions.bazaar.facilitator` field.**
 * Not tx-`from` inference. Load-bearing for gasless rails (SKALE+PayAI
 * per TKCollective's fixture offer) where the buyer-side tx `from`
 * is the gasless relayer, not the facilitator. Declared identity is
 * the operator's intent — whatever they declared is what gets probed.
 *
 * **Built-in registry** ships with three facilitators known to v0.3.4:
 * CDP, PayAI, x402.org/facilitator. Unknown facilitators emit
 * `facilitator_fitness: unknown` with a remediation hint — no
 * structural probing without a known endpoint shape. Registry is
 * data (`src/bazaar/facilitator-registry.json`), not code; new
 * facilitators land as PRs adding entries (ADR-005 § Risks #1).
 *
 * **Multi-rail synthesis** per ADR-005:
 *   - Emit one facet entry per `accepts[]` rail.
 *   - Healthy CDP rails NOT masked by degraded non-CDP rails.
 *   - Top-level verdict: if any rail is `unreachable`, status `info`
 *     (rolls up to `upstream_issue` exit 3); otherwise pass.
 *     `degraded` rails surface as facet info but don't flip verdict.
 *
 * **Probe protocol:**
 *   - POST to `<facilitator>/verify` with a minimal, structurally-valid
 *     but signature-invalid payload — same surface as a malformed buyer
 *     would hit, so facilitators that accept normal traffic accept this.
 *   - Bounded timeout (default 5s).
 *   - Bounded retry on failure (3 attempts, exponential backoff
 *     500ms / 1s / 2s per the @mkmkkkkk pattern from x402-foundation/x402#1065).
 *   - Result cached per facilitator URL for the duration of a single
 *     `bazaar-check` run (probing each rail independently would
 *     duplicate work when N rails share one facilitator).
 *
 * Cross-facet precedence with K + L + I (per `src/bazaar/diagnose-rules.md`):
 *   `service_unreachable` > `upstream_stuck.cause` > `upstream_issue` (from
 *   any-rail-unreachable here) > `facilitator_fitness.degraded` (facet only)
 *   > `host_pollution` > `looks_correct`. A DNS-failing service skips this
 *   check entirely (I's top-level verdict pre-empts).
 */

import facilitatorRegistryJson from "./facilitator-registry.json" with { type: "json" };
import type {
  CheckResult,
  FacilitatorFitnessFacet,
  FacilitatorFitnessIdentitySource,
  FacilitatorFitnessRailEntry,
  FacilitatorFitnessState,
  WellKnownManifest,
} from "./types.js";

/** Public type for callers wanting custom probe implementations in tests. */
export type FacilitatorFitnessFetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** Default probe timeout in ms per ADR-005 § Detection logic. */
export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

/** Backoff schedule for bounded retry (per @mkmkkkkk #1065 pattern). */
export const PROBE_RETRY_DELAYS_MS = [500, 1_000, 2_000] as const;

interface RegistryEntry {
  readonly id: string;
  readonly display_name: string;
  readonly names: readonly string[];
  readonly declared_urls: readonly string[];
  readonly probe_endpoint: string;
  readonly description: string;
}

interface Registry {
  readonly version: number;
  readonly facilitators: readonly RegistryEntry[];
}

/**
 * Built-in facilitator registry. Statically imported from JSON so it
 * ships with the `dist/` bundle and is available offline (operators
 * running `bazaar-check` standalone don't need to fetch it).
 *
 * Operator override via `--facilitator-registry <path>` is a v0.4+
 * refinement; v0.3.4 ships the built-in only.
 */
const builtInRegistry: Registry = facilitatorRegistryJson as Registry;

/**
 * Returns the built-in registry. Exported as a function for caller
 * symmetry with future override paths.
 */
export function loadFacilitatorRegistry(): Registry {
  return builtInRegistry;
}

/**
 * Match a declared facilitator claim against the registry. Returns
 * the registry entry on match, `null` if unknown. Case-insensitive
 * across the `names` aliases and `declared_urls`. URL match is
 * exact-or-prefix (declared `https://api.cdp.coinbase.com` matches
 * `https://api.cdp.coinbase.com/platform/v2/x402`).
 */
export function resolveFacilitator(
  declared: string,
  registry: Registry = loadFacilitatorRegistry(),
): RegistryEntry | null {
  const normalised = declared.trim().toLowerCase();
  if (normalised === "") return null;
  for (const entry of registry.facilitators) {
    for (const name of entry.names) {
      if (name.toLowerCase() === normalised) return entry;
    }
    for (const url of entry.declared_urls) {
      const u = url.toLowerCase();
      if (normalised === u || normalised.startsWith(u + "/") || u.startsWith(normalised + "/")) {
        return entry;
      }
    }
  }
  return null;
}

/**
 * Single probe attempt with bounded timeout. Returns the Response on
 * success or throws on timeout / network failure. Caller handles
 * retry on error.
 */
async function probeOnce(
  probeUrl: string,
  fetcher: FacilitatorFitnessFetcher,
  timeoutMs: number,
): Promise<{ response: Response; latencyMs: number }> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  try {
    const response = await fetcher(probeUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Minimal structurally-valid-but-signature-invalid payload — same
      // surface a malformed buyer would hit. Facilitators that accept
      // normal traffic accept this; non-2xx is the expected response
      // shape (the probe is testing reachability, not authorisation).
      body: JSON.stringify({ probe: "x402trace-fitness", x402Version: 2 }),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - start;
    return { response, latencyMs };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Probe a facilitator with bounded retry. Returns the final fitness
 * classification + a diagnostic string. Outcome semantics:
 *
 *   - First attempt 2xx → `ok` (no retry needed).
 *   - First attempt 5xx → retry; if any retry succeeds → `degraded`;
 *     all retries 5xx → `unreachable`.
 *   - Network error / timeout on all attempts → `unreachable`.
 *   - 4xx → `ok` (facilitator is responsive; rejection of the malformed
 *     probe payload is expected, not a fitness signal).
 */
export async function probeFacilitatorWithRetry(
  probeUrl: string,
  fetcher: FacilitatorFitnessFetcher,
  opts: { readonly timeoutMs?: number; readonly retryDelays?: readonly number[] } = {},
): Promise<{ fitness: FacilitatorFitnessState; diagnostic: string }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const retryDelays = opts.retryDelays ?? PROBE_RETRY_DELAYS_MS;

  const errors: string[] = [];
  let recoveredAfter5xx = false;

  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    if (attempt > 0) {
      const delay = retryDelays[attempt - 1] ?? 0;
      await new Promise((r) => setTimeout(r, delay));
    }
    try {
      const { response, latencyMs } = await probeOnce(probeUrl, fetcher, timeoutMs);
      if (response.status >= 200 && response.status < 300) {
        if (recoveredAfter5xx) {
          return {
            fitness: "degraded",
            diagnostic: `recovered on retry ${attempt} after ${errors.join(", ")} (latency ${latencyMs}ms)`,
          };
        }
        return { fitness: "ok", diagnostic: `2xx on first attempt (${latencyMs}ms)` };
      }
      if (response.status >= 400 && response.status < 500) {
        // 4xx — facilitator is responsive; rejection of the malformed
        // probe is expected, not a fitness signal.
        return {
          fitness: "ok",
          diagnostic: `${response.status} expected (probe-payload rejected; facilitator responsive, ${latencyMs}ms)`,
        };
      }
      // 5xx — retry path
      errors.push(`HTTP ${response.status} on attempt ${attempt + 1}`);
      recoveredAfter5xx = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${msg} on attempt ${attempt + 1}`);
    }
  }
  return {
    fitness: "unreachable",
    diagnostic: `all ${retryDelays.length + 1} attempts failed: ${errors.join(", ")}`,
  };
}

/**
 * Extract the declared facilitator string from a manifest's
 * `extensions.bazaar.facilitator` field. Returns `null` if no
 * declaration is present (rule defers; no probe attempted).
 */
function declaredFacilitatorFrom(manifest: WellKnownManifest | undefined): string | null {
  if (!manifest) return null;
  const ext = manifest.extensions;
  if (typeof ext !== "object" || ext === null) return null;
  const bazaar = (ext as Record<string, unknown>)["bazaar"];
  if (typeof bazaar !== "object" || bazaar === null) return null;
  const facilitator = (bazaar as Record<string, unknown>)["facilitator"];
  if (typeof facilitator !== "string") return null;
  const trimmed = facilitator.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Extract network strings from each `accepts[]` entry on the manifest.
 * Used to enumerate rails for per-rail facet emission.
 */
function railsFromAccepts(manifest: WellKnownManifest | undefined): string[] {
  if (!manifest || !Array.isArray(manifest.accepts)) return [];
  const networks: string[] = [];
  for (const a of manifest.accepts) {
    if (typeof a !== "object" || a === null) continue;
    const net = (a as Record<string, unknown>)["network"];
    networks.push(typeof net === "string" ? net : "");
  }
  return networks;
}

export interface FacilitatorFitnessOptions {
  /**
   * Inject a custom fetcher for tests. Defaults to global `fetch`.
   */
  readonly fetcher?: FacilitatorFitnessFetcher;
  readonly probeTimeoutMs?: number;
  readonly retryDelays?: readonly number[];
}

/**
 * Run the facilitator-fitness check. Reads the manifest's declared
 * facilitator + each `accepts[]` rail, probes the facilitator once
 * (cached per URL), emits the per-rail facet array.
 *
 * Status:
 *   - `info` if ANY rail's fitness is `unreachable` (verdict
 *     synthesizer treats info as upstream signal → upstream_issue
 *     verdict, exit 3).
 *   - `pass` otherwise. `degraded` rails surface in the facet but
 *     don't flip the verdict.
 *
 * When the manifest declares no facilitator OR the declared
 * facilitator is unknown to the registry, all rails emit
 * `fitness: unknown` with no probe attempted. This is the
 * conservative default per ADR-005 risk #1.
 */
export async function checkFacilitatorFitness(
  manifest: WellKnownManifest | undefined,
  opts: FacilitatorFitnessOptions = {},
): Promise<CheckResult> {
  const fetcher = opts.fetcher ?? (fetch as FacilitatorFitnessFetcher);
  const declared = declaredFacilitatorFrom(manifest);
  const networks = railsFromAccepts(manifest);

  // Resolve the declared facilitator once. If unknown OR absent, all
  // rails emit `unknown`.
  let identitySource: FacilitatorFitnessIdentitySource;
  let facilitatorEntry: RegistryEntry | null = null;
  if (declared === null) {
    identitySource = "unknown";
  } else {
    identitySource = "declared";
    facilitatorEntry = resolveFacilitator(declared);
  }

  // Probe once per resolved facilitator (cached). For v0.3.4 MVP the
  // manifest-level declaration applies to all rails uniformly; a
  // per-`accepts[i]` facilitator override is a v0.4+ refinement.
  let probeResult: { fitness: FacilitatorFitnessState; diagnostic: string } | null = null;
  if (facilitatorEntry !== null) {
    const retryDelaysOpt = opts.retryDelays !== undefined ? { retryDelays: opts.retryDelays } : {};
    const timeoutOpt = opts.probeTimeoutMs !== undefined ? { timeoutMs: opts.probeTimeoutMs } : {};
    probeResult = await probeFacilitatorWithRetry(facilitatorEntry.probe_endpoint, fetcher, {
      ...timeoutOpt,
      ...retryDelaysOpt,
    });
  }

  const rails: FacilitatorFitnessRailEntry[] = [];
  if (networks.length === 0) {
    // No rails declared — return a single placeholder entry so the
    // facet is non-empty for snapshot stability. Status is `pass`;
    // facet records the absence diagnostically.
    rails.push({
      rail: 0,
      network: "",
      facilitator: declared,
      identity_source: identitySource,
      fitness: probeResult?.fitness ?? "unknown",
      ...(probeResult ? { diagnostic: probeResult.diagnostic } : {}),
    });
  } else {
    for (let i = 0; i < networks.length; i++) {
      const rail: FacilitatorFitnessRailEntry = {
        rail: i,
        network: networks[i] ?? "",
        facilitator: declared,
        identity_source: identitySource,
        fitness: probeResult?.fitness ?? "unknown",
        ...(probeResult ? { diagnostic: probeResult.diagnostic } : {}),
      };
      rails.push(rail);
    }
  }

  const summary = {
    ok: rails.filter((r) => r.fitness === "ok").length,
    degraded: rails.filter((r) => r.fitness === "degraded").length,
    unreachable: rails.filter((r) => r.fitness === "unreachable").length,
    unknown: rails.filter((r) => r.fitness === "unknown").length,
  };

  const facet: FacilitatorFitnessFacet = { rails, summary };

  // Verdict rollup: any unreachable rail trips info status; otherwise pass.
  if (summary.unreachable > 0) {
    return {
      check: "facilitator-fitness",
      status: "info",
      message: `${summary.unreachable} of ${rails.length} rail(s) report facilitator unreachable: ${declared ?? "(no facilitator declared)"}`,
      fix: `your service settles via ${declared} which failed health probes across ${PROBE_RETRY_DELAYS_MS.length + 1} attempts. Either the facilitator is down (check ${declared}'s status page) or your declared identity is stale. Other rails may be unaffected — see the per-rail array in detail.facilitator_fitness for granularity.`,
      detail: { facilitator_fitness: facet },
    };
  }
  return {
    check: "facilitator-fitness",
    status: "pass",
    message:
      declared === null
        ? `no facilitator declared in extensions.bazaar.facilitator; per-rail array emitted with fitness: unknown for snapshot stability`
        : facilitatorEntry === null
          ? `facilitator "${declared}" not in built-in registry (CDP, PayAI, x402.org); fitness: unknown across ${rails.length} rail(s)`
          : `facilitator probe ok across ${rails.length} rail(s); ${summary.ok} ok, ${summary.degraded} degraded, ${summary.unknown} unknown`,
    detail: { facilitator_fitness: facet },
  };
}
