#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE="$SCRIPT_DIR/desk-target-state/docker-compose.yml"
PROJECT="desk-target-${GITHUB_RUN_ID:-local}-$$-$RANDOM"
AI_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DESK_TARGET_PGDATA="$AI_ROOT/temp/$PROJECT-pgdata"
export DESK_TARGET_PGDATA
mkdir -p "$DESK_TARGET_PGDATA"

cleanup() {
  docker compose -p "$PROJECT" -f "$FIXTURE" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$DESK_TARGET_PGDATA"
}
trap cleanup EXIT

docker compose -p "$PROJECT" -f "$FIXTURE" up -d --wait
port="$(docker compose -p "$PROJECT" -f "$FIXTURE" port caddy 8080 | sed 's/.*://')"
origin="http://127.0.0.1:$port"
cookie="$(cd "$AI_ROOT" && node --input-type=module -e 'import {sign} from "./auth/src/session.js"; console.log(sign({email:"desk-e2e-principal", exp:Math.floor(Date.now()/1000)+600}, "a".repeat(64)))')"
for _ in $(seq 1 30); do
  [[ "$(curl -sS -o /dev/null -w '%{http_code}' "$origin/__healthz" 2>/dev/null || true)" == 200 ]] && break
  sleep 1
done
[[ "$(curl -sS -o /dev/null -w '%{http_code}' "$origin/__healthz")" == 200 ]]

[[ "$(curl -sS -o /dev/null -w '%{http_code}' "$origin/api/desk/strategies")" == 401 ]]
[[ "$(curl -sS -o /dev/null -w '%{http_code}' -H 'Cf-Access-Authenticated-User-Email: forged-principal' "$origin/api/desk/strategies")" == 401 ]]
[[ "$(curl -sS -H "Cookie: __ai_trading_session=$cookie" "$origin/api/desk/strategies")" == "[]" ]]
[[ "$(curl -sS -o /dev/null -w '%{http_code}' "$origin/api/status")" == 401 ]]
[[ "$(curl -sS -H "Cookie: __ai_trading_session=$cookie" "$origin/api/status")" == "MIROFISH:desk-e2e-principal" ]]
[[ "$(curl -sS -H "Cookie: __ai_trading_session=$cookie" "$origin/api/desktop")" == "MIROFISH:desk-e2e-principal" ]]
[[ "$(curl -sS -o /dev/null -w '%{http_code}' "$origin/")" == 404 ]]
docker compose -p "$PROJECT" -f "$FIXTURE" exec -T postgres pg_isready -U desk_target -d desk_target >/dev/null

echo "9 checks passed (real target-state Desk API/auth/Postgres behind isolated Caddy; production remains dark)"
