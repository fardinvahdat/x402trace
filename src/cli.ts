#!/usr/bin/env node
/**
 * X402-14 binary entry. `package.json` `bin.x402trace` points at
 * `dist/cli.js` (the compiled form of this file). Pure shim: wire real
 * `process` handles to `runCli` and translate its return value to
 * `process.exit`.
 *
 * Keep this file dependency-light — actual command logic lives under
 * `src/cli/`. The reason for the split is that `runCli` is testable in
 * isolation (with injected stdout/stderr/env/waitForShutdown) while
 * `process.exit` cannot be safely called from a vitest worker.
 */
import { runCli } from "./cli/index.js";

void runCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
}).then((code) => {
  process.exit(code);
});
