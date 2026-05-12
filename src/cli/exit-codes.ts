/**
 * X402-14 CLI exit codes. Per the X402-14 acceptance criteria:
 *   0 = success
 *   1 = usage error (bad flags, missing required args)
 *   2 = runtime error (proxy crash, log file unreadable, etc.)
 *
 * Centralised so subcommands and tests reference the same constants.
 */
export const EXIT_SUCCESS = 0 as const;
export const EXIT_USAGE = 1 as const;
export const EXIT_RUNTIME = 2 as const;

export type ExitCode = typeof EXIT_SUCCESS | typeof EXIT_USAGE | typeof EXIT_RUNTIME;
