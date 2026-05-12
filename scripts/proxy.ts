/**
 * Thin shim — defers to the X402-14 CLI. Kept so `pnpm proxy --upstream <url>`
 * keeps working from prior docs. The CLI surface lives in `src/cli/`.
 */
import { runCli } from "../src/cli/index.js";

void runCli(["proxy", ...process.argv.slice(2)], {
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
}).then((code) => {
  process.exit(code);
});
