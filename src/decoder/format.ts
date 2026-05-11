import type { DecodedEvent } from "./types.js";

/**
 * Human-readable single-line summary of a decoded event. Designed for
 * `pnpm proxy` / `x402trace proxy` stdout where compactness matters.
 * Full structure goes to JSONL.
 */
export function formatHuman(event: DecodedEvent): string {
  const stamp = `[${event.t}]`;
  switch (event.event) {
    case "exchange.challenge": {
      const r = event.challenge;
      const amt = r.maxAmountRequired;
      const errSuffix = event.raw402Error ? ` (error=${event.raw402Error})` : "";
      return `${stamp} 402 challenge id=${short(event.id)} v${event.x402Version} ${r.scheme}/${r.network} amount=${amt} payTo=${shortAddr(r.payTo)} asset=${shortAddr(r.asset)}${errSuffix}`;
    }
    case "exchange.payment": {
      const auth = event.payment.payload.authorization;
      return `${stamp} X-PAYMENT id=${short(event.id)} v${event.x402Version} from=${shortAddr(auth.from)} → to=${shortAddr(auth.to)} value=${auth.value} nonce=${short(auth.nonce)} validBefore=${auth.validBefore}`;
    }
    case "exchange.settlement": {
      const s = event.settlement;
      const status =
        s.success === true
          ? "✓ success"
          : s.isValid === false
            ? `✗ invalid: ${s.invalidReason ?? "?"}`
            : s.errorReason
              ? `✗ error: ${s.errorReason}`
              : "?";
      const tx = s.transaction ? ` tx=${short(s.transaction)}` : "";
      return `${stamp} settlement id=${short(event.id)} ${status}${tx}`;
    }
    case "decoder.error": {
      const idStr = event.id ? ` id=${short(event.id)}` : "";
      return `${stamp} decoder.error stage=${event.stage}${idStr} message="${event.message}"`;
    }
  }
}

/** JSON-line representation. Pure JSON.stringify with stable key order via field-by-field copy. */
export function formatJson(event: DecodedEvent): string {
  return JSON.stringify(event);
}

function short(value: string, head = 8): string {
  if (value.length <= head + 4) return value;
  return `${value.slice(0, head)}…`;
}

function shortAddr(value: string): string {
  if (!value.startsWith("0x") || value.length < 12) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}
