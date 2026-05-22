/**
 * X402-43 (D.5) — variant-aware `extensions.bazaar` validation.
 *
 * `@x402/extensions@2.11.0` ships TWO discovery-extension variants. Up
 * through v0.3.1 we assumed only the MCP-style shape (top-level `name`
 * + `description`), which produced false-positive `implementation_issue`
 * verdicts against API-style services that legitimately use the
 * Body-discovery shape (`info.input` + `info.output` + `schema`). This
 * was AsaiShota's [#72](https://github.com/fardinvahdat/x402trace/issues/72)
 * + corroborated by @0xdespot on
 * [x402-foundation/x402#2207](https://github.com/x402-foundation/x402/issues/2207).
 *
 * Variant rules:
 *
 *   - **body-discovery** — `info.input` + `info.output` + `schema` all
 *     present at the top level of `extensions.bazaar`. Validated by
 *     requiring each of those three to be a non-null object.
 *   - **mcp-discovery** — default fallback per ADR-004's "else assume
 *     Mcp" rule. Validated by requiring top-level `name` + `description`
 *     as non-empty strings. Preserves the v0.3.0/0.3.1 behavior — the
 *     TheRoosters / GM / hypeprinter007-stack #65 pain set.
 *   - **unknown** — defensive third state for future `@x402/extensions`
 *     additions. Fires only when the argument is not an object at all;
 *     in that case validation is a no-op (skip). Callers already
 *     pre-screen for non-object before reaching this helper, so in
 *     practice this branch is unreachable from production code — but
 *     it's documented so future variants land here cleanly (per the
 *     ADR-004 risk register).
 *
 * Helper stays presentation-free: it returns the detected variant + the
 * per-field missing list. Each caller (challenge.ts + well-known.ts)
 * formats the user-facing message in its own voice.
 */

export type BazaarVariant = "mcp-discovery" | "body-discovery" | "unknown";

export interface BazaarValidationResult {
  readonly variant: BazaarVariant;
  /** True when no per-variant required field is missing. */
  readonly ok: boolean;
  /** Per-variant required fields that are missing or malformed. */
  readonly missing: readonly string[];
}

/**
 * Identify which discovery-extension variant `extensions.bazaar` is.
 *
 * Rule order is intentional: body-discovery wins when its indicators
 * (info.input + info.output + schema) are all present. Anything else
 * that is an object falls through to mcp-discovery per ADR-004's "else
 * assume Mcp" decision.
 */
export function detectBazaarVariant(bazaar: unknown): BazaarVariant {
  if (typeof bazaar !== "object" || bazaar === null) return "unknown";
  const b = bazaar as Record<string, unknown>;
  if (isBodyDiscoveryShape(b)) return "body-discovery";
  return "mcp-discovery";
}

/**
 * Validate `extensions.bazaar` per its detected variant. Returns the
 * variant plus the names of any required fields that are missing or
 * malformed for that variant.
 */
export function validateBazaarExtension(bazaar: unknown): BazaarValidationResult {
  const variant = detectBazaarVariant(bazaar);
  if (variant === "unknown") {
    // Non-object input: caller already pre-screened. Return ok=true so
    // upstream "unknown variant; skip validation" semantics hold.
    return { variant, ok: true, missing: [] };
  }
  const b = bazaar as Record<string, unknown>;
  const missing: string[] = [];
  if (variant === "mcp-discovery") {
    if (!isNonEmptyString(b["name"])) missing.push("name");
    if (!isNonEmptyString(b["description"])) missing.push("description");
  } else {
    // body-discovery — detect path above guarantees info is an object
    const info = b["info"] as Record<string, unknown>;
    if (!isObject(info["input"])) missing.push("info.input");
    if (!isObject(info["output"])) missing.push("info.output");
    if (!isObject(b["schema"])) missing.push("schema");
  }
  return { variant, ok: missing.length === 0, missing };
}

function isBodyDiscoveryShape(b: Record<string, unknown>): boolean {
  const info = b["info"];
  if (typeof info !== "object" || info === null) return false;
  const i = info as Record<string, unknown>;
  return "input" in i && "output" in i && "schema" in b;
}

function isNonEmptyString(v: unknown): boolean {
  return typeof v === "string" && v.trim() !== "";
}

function isObject(v: unknown): boolean {
  return typeof v === "object" && v !== null;
}
