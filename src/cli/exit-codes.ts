/**
 * X402-14 CLI exit codes:
 *   0 = success
 *   1 = usage error (bad flags, missing required args)
 *   2 = runtime error / implementation issue (proxy crash, log file
 *       unreadable; bazaar-check found issues in YOUR implementation)
 *   3 = upstream issue detected (X402-32 bazaar-check found an
 *       upstream signal like the #2207 cluster — your implementation
 *       looks correct but Bazaar discovery is gated upstream of you)
 *
 * Centralised so subcommands and tests reference the same constants.
 */
export const EXIT_SUCCESS = 0 as const;
export const EXIT_USAGE = 1 as const;
export const EXIT_RUNTIME = 2 as const;
export const EXIT_UPSTREAM = 3 as const;

export type ExitCode =
  | typeof EXIT_SUCCESS
  | typeof EXIT_USAGE
  | typeof EXIT_RUNTIME
  | typeof EXIT_UPSTREAM;
