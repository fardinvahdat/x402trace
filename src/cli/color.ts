/**
 * Minimal ANSI color helpers. Honours `NO_COLOR` (https://no-color.org)
 * and TTY detection so output is clean when piped to grep / a file /
 * `tee`. No external dependency — we render six escape codes by hand.
 */

const RESET = "\x1b[0m";
const CODES = {
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
} as const;

export type ColorName = keyof typeof CODES;

export interface Colorizer {
  readonly enabled: boolean;
  paint(code: ColorName, text: string): string;
}

export interface ColorOptions {
  /** Force-enable / force-disable. When undefined, auto-detect from TTY + NO_COLOR. */
  readonly enabled?: boolean;
  /** Stream to interrogate for `isTTY`. Default: `process.stdout`. */
  readonly stream?: { readonly isTTY?: boolean };
  /** Environment to interrogate for `NO_COLOR`. Default: `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export function createColorizer(opts: ColorOptions = {}): Colorizer {
  const stream = opts.stream ?? process.stdout;
  const env = opts.env ?? process.env;
  const auto = typeof stream.isTTY === "boolean" && stream.isTTY === true && !("NO_COLOR" in env);
  const enabled = opts.enabled ?? auto;

  return {
    enabled,
    paint(code, text) {
      return enabled ? `${CODES[code]}${text}${RESET}` : text;
    },
  };
}
