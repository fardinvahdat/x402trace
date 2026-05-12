#!/usr/bin/env bash
# X402-15 end-to-end demo — reproduces the canonical Issue #1062 scenario
# end-to-end on Base Sepolia using only x402trace's substrates.
#
#   github.com/coinbase/x402#issue-1062: "wallet got debited but the
#    facilitator returned an error / the client thinks the payment failed."
#
# Choreography:
#
#   1. Start the dogfood server with DEMO_SLEEP_MS=10000 and
#      DEMO_FAIL_AFTER_SLEEP=1. The x402 paymentMiddleware runs
#      verify+settle against the real x402.org facilitator FIRST
#      (the on-chain USDC transfer happens here). Then the route
#      handler sleeps 10s and returns 500 — simulating a server
#      that crashed after settlement.
#
#   2. Start `x402trace proxy --reconcile --upstream-timeout-ms 5000`
#      in front of it. The 5s upstream timeout kicks in DURING the
#      server's 10s post-settle sleep, so the proxy emits
#      `upstream_timeout` and returns 502 to the client. The
#      reconciliation engine flags the exchange as pending and
#      starts watching Base Sepolia.
#
#   3. Run the dogfood client through the proxy. It signs an
#      EIP-3009 transferWithAuthorization, sends X-PAYMENT, and
#      gets the 502 back. From the client's perspective: payment
#      failed.
#
#   4. The Base Sepolia chain client picks up the matching USDC
#      Transfer event (same EIP-3009 nonce as the client's payment).
#      The engine matches and emits:
#
#        RECONCILED ⚠ settled-but-server-thinks-not
#          id=… tx=<basescan tx> value=1000 gap=<ms>
#
#      x402trace just told you the buyer was debited even though the
#      facilitator + server reported failure.
#
# Prerequisites (see examples/README.md for the full list):
#
#   - Node >= 20, pnpm
#   - .env populated:
#       PAYER_PRIVATE_KEY  (Base Sepolia test wallet, has >0.01 USDC + dust ETH)
#       RECEIVER_ADDRESS   (any 0x-prefixed 20-byte address)
#       FACILITATOR_URL    (default: https://x402.org/facilitator)
#       BASE_RPC_URL       (default: https://sepolia.base.org)
#   - This script runs `pnpm install` once if node_modules is missing
#
# Total demo runtime: ~25–40 seconds.

set -Eeuo pipefail

DEMO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")"/.. && pwd)"
cd "$DEMO_ROOT"

# ---------- knobs ----------
SERVER_PORT="${DEMO_SERVER_PORT:-3402}"
PROXY_PORT="${DEMO_PROXY_PORT:-8402}"
SLEEP_MS="${DEMO_SLEEP_MS:-10000}"
PROXY_TIMEOUT_MS="${DEMO_PROXY_TIMEOUT_MS:-5000}"
WATCH_TIMEOUT_MS="${DEMO_WATCH_TIMEOUT_MS:-90000}"
LOG_FILE="${DEMO_LOG_FILE:-${TMPDIR:-/tmp}/x402trace-e2e-$$.jsonl}"
PROXY_STDOUT="${TMPDIR:-/tmp}/x402trace-e2e-proxy-$$.stdout"
SERVER_STDOUT="${TMPDIR:-/tmp}/x402trace-e2e-server-$$.stdout"
# Per-run wait budget (seconds) before we give up waiting for the warning.
WAIT_BUDGET="${DEMO_WAIT_BUDGET:-90}"

cyan()   { printf "\033[36m%s\033[0m\n" "$*"; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
red()    { printf "\033[31m%s\033[0m\n" "$*"; }
dim()    { printf "\033[2m%s\033[0m\n" "$*"; }

# ---------- prereq checks ----------
require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    red "✗ missing env: $name"
    echo "   see examples/README.md for the full prereq list."
    exit 2
  fi
}

cyan "── x402trace e2e demo (X402-15) ───────────────────────────────────"
# Source .env if present so users don't need to export every var
# manually. Same precedence model as the Node-side `dotenv/config`,
# with one extra safety net: bash `source` lets *later* assignments win,
# so a half-edited .env (real value on top, placeholder block from
# `.env.example` left below) silently overrides the real value with
# `0x`. Warn the user instead of letting them debug a downstream
# "0x is not a valid address" wait_for_port timeout.
if [ -f "$DEMO_ROOT/.env" ]; then
  for key in RECEIVER_ADDRESS PAYER_PRIVATE_KEY; do
    count=$(grep -cE "^${key}=" "$DEMO_ROOT/.env" || true)
    if [ "$count" -gt 1 ]; then
      red "✗ .env has $count lines starting with ${key}="
      echo "   bash sources top-to-bottom and the LAST assignment wins, which usually"
      echo "   means a placeholder from .env.example is overriding your real value."
      echo "   keep one line per key and re-run."
      exit 2
    fi
  done
  set -a
  # shellcheck disable=SC1091
  . "$DEMO_ROOT/.env"
  set +a
fi
require_env PAYER_PRIVATE_KEY
require_env RECEIVER_ADDRESS
: "${FACILITATOR_URL:=https://x402.org/facilitator}"
: "${BASE_RPC_URL:=https://sepolia.base.org}"
export FACILITATOR_URL BASE_RPC_URL

dim "  server port      : $SERVER_PORT"
dim "  proxy port       : $PROXY_PORT"
dim "  post-settle sleep: ${SLEEP_MS}ms (server)"
dim "  proxy timeout    : ${PROXY_TIMEOUT_MS}ms (proxy → server)"
dim "  watch timeout    : ${WATCH_TIMEOUT_MS}ms (engine on-chain watch)"
dim "  facilitator      : $FACILITATOR_URL"
dim "  rpc url          : $BASE_RPC_URL"
dim "  log file         : $LOG_FILE"

if [ ! -d node_modules ]; then
  cyan "── pnpm install (first run) ──"
  pnpm install --silent
fi

# ---------- background-process bookkeeping ----------
SERVER_PID=""
PROXY_PID=""
cleanup() {
  local exit_code=$?
  set +e
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
  fi
  if [ -n "$PROXY_PID" ] && kill -0 "$PROXY_PID" 2>/dev/null; then
    kill "$PROXY_PID" 2>/dev/null
    wait "$PROXY_PID" 2>/dev/null
  fi
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

wait_for_port() {
  local port="$1"
  local stdout_path="${2:-}"
  # 60 cycles × 0.5s = 30s budget. tsx cold-start on a fresh machine
  # plus dotenv + hono + x402-* imports can take >10s; 30s leaves head-
  # room without making a real failure feel sluggish to detect.
  local budget=60
  while [ "$budget" -gt 0 ]; do
    if (printf "" >"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
      return 0
    fi
    sleep 0.5
    budget=$((budget - 1))
  done
  red "✗ timed out waiting for localhost:$port"
  if [ -n "$stdout_path" ] && [ -s "$stdout_path" ]; then
    echo
    yellow "  process stdout/stderr (last 30 lines of $stdout_path):"
    tail -n 30 "$stdout_path" | sed 's/^/    /'
  fi
  return 1
}

# ---------- step 1: dogfood server with mid-handler sleep ----------
# The x402-hono paymentMiddleware verifies BEFORE the handler runs and
# settles AFTER the handler returns. A handler sleep > proxy timeout
# means: client gets 502 (proxy gave up), server still completes
# /settle in the background, on-chain Transfer lands → reconciliation
# engine catches it.
#
# We deliberately do NOT use DEMO_FAIL_AFTER_SLEEP here: x402-hono
# treats a 5xx response as a settlement skip, which would defeat the
# whole point of the demo.
cyan "── (1) dogfood server with DEMO_SLEEP_MS=${SLEEP_MS} (no post-sleep fail) ──"
DEMO_SLEEP_MS="$SLEEP_MS" \
DOGFOOD_PORT="$SERVER_PORT" \
pnpm --silent dogfood:server >"$SERVER_STDOUT" 2>&1 &
SERVER_PID=$!
wait_for_port "$SERVER_PORT" "$SERVER_STDOUT"
green "  server up on http://localhost:$SERVER_PORT  (pid=$SERVER_PID)"

# ---------- step 2: x402trace proxy --reconcile in front ----------
cyan "── (2) x402trace proxy --reconcile (upstream timeout ${PROXY_TIMEOUT_MS}ms) ──"
pnpm --silent x402trace proxy \
  --upstream "http://localhost:$SERVER_PORT" \
  --port "$PROXY_PORT" \
  --reconcile \
  --rpc-url "$BASE_RPC_URL" \
  --upstream-timeout-ms "$PROXY_TIMEOUT_MS" \
  --watch-timeout-ms "$WATCH_TIMEOUT_MS" \
  --log-file "$LOG_FILE" \
  --log human \
  >"$PROXY_STDOUT" 2>&1 &
PROXY_PID=$!
wait_for_port "$PROXY_PORT" "$PROXY_STDOUT"
green "  proxy up on http://localhost:$PROXY_PORT  (pid=$PROXY_PID)"

# ---------- step 3: dogfood client through the proxy ----------
cyan "── (3) dogfood client through the proxy (expect non-200) ──"
DOGFOOD_SERVER_URL="http://localhost:$PROXY_PORT" \
pnpm --silent dogfood:client || true
yellow "  client failed (as expected — the proxy timed out the server's sleep)"

# ---------- step 4: wait for the reconciliation warning ----------
cyan "── (4) waiting up to ${WAIT_BUDGET}s for the engine to surface settled_on_chain ──"
elapsed=0
while [ "$elapsed" -lt "$WAIT_BUDGET" ]; do
  if grep -q "RECONCILED" "$PROXY_STDOUT"; then
    break
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done

echo
cyan "── proxy stdout (tail) ──"
tail -n 30 "$PROXY_STDOUT" || true

echo
if grep -q "RECONCILED" "$PROXY_STDOUT"; then
  green "✓ demo succeeded — x402trace detected the settled-but-server-thinks-not exchange."
  echo
  echo "Captured JSONL: $LOG_FILE"
  echo "Filter to the reconcile.result lines with:"
  echo "  grep '\"event\":\"reconcile.result\"' $LOG_FILE | jq ."
  exit 0
else
  red "✗ demo timed out — no RECONCILED line within ${WAIT_BUDGET}s."
  echo "   Possible causes:"
  echo "   - BASE_RPC_URL is rate-limited (try a hosted RPC)"
  echo "   - the on-chain Transfer event hadn't landed by the time the engine polled"
  echo "   - your facilitator timed out before broadcasting"
  echo
  echo "Server stdout (tail):"
  tail -n 30 "$SERVER_STDOUT" || true
  exit 2
fi
