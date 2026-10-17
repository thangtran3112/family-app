#!/usr/bin/env bash
# Verifies a freshly built static export: required files exist, and no
# secret-shaped string made it into the bundle. The Desk package has a
# root-only layout; all other callers are checked as Hub exports.
# Usage: ai-trading/deploy/ci/check-static-export.sh OUT_DIR
set -Eeuo pipefail

OUT_DIR="${1:?usage: check-static-export.sh OUT_DIR}"

fail() {
  echo "check-static-export: $*" >&2
  exit 1
}

PACKAGE_JSON="$(dirname "$OUT_DIR")/package.json"
IS_DESK=false
if [[ -f "$PACKAGE_JSON" ]] && grep -q '"name": "@ai-trading/desk-web"' "$PACKAGE_JSON"; then
  IS_DESK=true
fi

required=(index.html 404.html)
if [[ "$IS_DESK" == false ]]; then
  required+=(apps/tradingagents.html apps/ai-hedge-fund.html apps/vibe-trading.html apps/mirofish.html)
fi

for required_file in "${required[@]}"; do
  [[ -f "$OUT_DIR/$required_file" ]] || fail "missing $required_file"
done
[[ -d "$OUT_DIR/_next/static" ]] || fail "missing _next/static"

if [[ "$IS_DESK" == false ]]; then
  [[ -f "$OUT_DIR/apps/desk.html" ]] && fail "apps/desk.html exists in the Hub export"
fi

# Forbidden patterns: Clerk/OpenAI/Zep secret key prefixes and literal
# secret-section key names. Clerk PUBLISHABLE keys (pk_live_/pk_test_) are
# expected and excluded. sk-[A-Za-z0-9_-]{20,} (hyphen/underscore allowed in
# the body) also catches OpenAI's newer sk-proj-... / sk-svcacct-... keys,
# not just the older bare sk-<alnum> shape.
if grep -RIlE 'sk_(live|test)_|sk-[A-Za-z0-9_-]{20,}|CLERK_SECRET_KEY=|ZEP_API_KEY=|SESSION_SIGNING_KEY=' "$OUT_DIR"; then
  fail "a secret-shaped string was found in the static export"
fi

echo "check-static-export: ok ($OUT_DIR)"
