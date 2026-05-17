/**
 * X402-34 — shared chain-selection helpers.
 *
 * Used by `proxy`, `validate`, `inspect` (and eventually `bazaar-check`)
 * to resolve a `ChainKey` from either the `--chain` CLI flag or the
 * `BASE_CHAIN_ID` env var. Default is `"base-sepolia"` per ADR-003.
 */

import type { ChainKey } from "../chain/index.js";

/**
 * Parse the `BASE_CHAIN_ID` env or `--chain` flag value into a `ChainKey`.
 * Accepts numeric Chain ID forms (`8453` / `84532`) and string keys
 * (`base` / `base-sepolia`). Unknown values return undefined so the
 * caller can apply its own default.
 */
export function parseChainOrUndefined(raw: string | undefined): ChainKey | undefined {
  if (!raw) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "base" || v === "8453") return "base";
  if (v === "base-sepolia" || v === "basesepolia" || v === "84532") return "base-sepolia";
  return undefined;
}
