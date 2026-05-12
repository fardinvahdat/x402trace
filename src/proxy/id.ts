import { randomUUID } from "node:crypto";
import type { ExchangeId } from "./types.js";

/**
 * Generate a unique exchange id. ULIDs would be sort-friendlier; UUIDv4
 * is plenty for v0.1 (the JSONL `t` timestamp gives ordering).
 */
export function newExchangeId(): ExchangeId {
  return randomUUID();
}
