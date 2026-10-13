#!/usr/bin/env bash
# Verifies the running ai-trading stack: every selected service running,
# health checks passing, the app-control helper active and privately
# reachable as the gateway identity, and the Cloudflare Tunnel connected
# (always-on, regardless of any app preference). Runs on the VPS as root.
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/family-app/ai-trading}"
ATTEMPTS="${HEALTH_CHECK_ATTEMPTS:-30}"
DELAY="${HEALTH_CHECK_DELAY_SECONDS:-2}"
# Task 5 (app-controls): the SAME control/state.py CLI and persisted state
# file deploy.sh and the control helper use. AI_TRADING_CONTROL_DIR lets
# deploy.sh point this script (when it runs a scratch copy of this exact
# file -- see deploy.sh's deploy_tag()) at ITS OWN run-owned coordinator
# copy, never $APP_DIR/control, which a same-run rollback may already have
# reverted or removed; a standalone/production invocation of this script
# defaults to the normally installed location.
CONTROL_DIR="${AI_TRADING_CONTROL_DIR:-$APP_DIR/control}"
CONTROL_STATE_PATH="${AI_TRADING_STATE_PATH:-/var/lib/family-app/ai-trading/control.json}"
CONTROL_OWNER_UID="${AI_TRADING_CONTROL_OWNER_UID:-0}"
CONTROL_SOCKET_PATH="${AI_TRADING_CONTROL_SOCKET:-/run/family-app/ai-trading-control/control.sock}"
CONTROL_SERVICE_NAME="${AI_TRADING_CONTROL_SERVICE:-ai-trading-control.service}"
CONTROL_GATEWAY_USER="${AI_TRADING_CONTROL_GATEWAY_USER:-ai-trading-gateway}"
# Test-only: skip control_helper_ready() entirely -- this check needs a real
# systemd unit and a real gateway-identity user to mean anything, which an
# offline fake-Compose scenario never has. Never set this in production; a
# dedicated focused test (test-app-controls-deploy.sh) exercises the real
# function with faked systemctl/runuser/curl instead.
SKIP_CONTROL_CHECK="${HEALTH_CHECK_SKIP_CONTROL:-}"

compose() {
  local mirofish_compose=()
  [[ -f "$APP_DIR/docker-compose.mirofish.yml" ]] && mirofish_compose=(-f "$APP_DIR/docker-compose.mirofish.yml")
  docker compose --project-name ai-trading --env-file "$APP_DIR/images.env" -f "$APP_DIR/docker-compose.yml" "${mirofish_compose[@]}" "$@"
}

# mirofish_enabled: true only when *this* run actually activated MiroFish --
# COMPOSE_PROFILES=mirofish (inherited from deploy.sh's own activate_mirofish,
# which deploy_tag invokes this script right after). Never just because
# $AI_TRADING_RUNTIME_ENV_DIR/mirofish.env happens to still exist on disk: a
# redeploy after MiroFish was previously activated, but whose own
# MIROFISH_ACTIVATE isn't set this time, correctly unsets COMPOSE_PROFILES
# (deploy.sh's own activate_mirofish does this unconditionally) and must
# still pass health-check even though that stale file is still sitting
# there from the earlier run.
#
# Deliberately does NOT also require `compose ps -q mirofish` to be
# non-empty (review P1, round 2): that extra check made a *died/stopped*
# mirofish container silently drop out of SERVICES instead of failing --
# COMPOSE_PROFILES=mirofish said "this deploy enabled it," so the service
# belongs in SERVICES regardless of its current container state, and
# service_ok() below already fails correctly on a missing or stopped
# container (same as it does for every other service).
mirofish_enabled() {
  [[ "${COMPOSE_PROFILES:-}" == mirofish ]]
}

service_ok() {
  local id state health
  id="$(compose ps -q "$1")"
  [[ -n "$id" ]] || return 1
  state="$(docker inspect -f '{{.State.Status}}' "$id")"
  health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id")"
  [[ "$state" == running && ("$health" == healthy || "$health" == none) ]]
}

# cloudflared is distroless, so ask from the web container on the shared network.
# Always-on and unconditional, regardless of any app preference (task-5-brief:
# "Health still tunnel-ready always-on").
tunnel_ready() {
  compose exec -T web node -e "fetch('http://cloudflared:2000/ready').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
}

# selected_services_text: the exact same effective selected-service list
# deploy.sh's own apply_selected_services/stop_disabled_groups computed for
# this deploy -- the single shared source of "which services should be up
# right now," never a second, independently maintained hardcoded list.
# Deliberately a checked command substitution, never `mapfile <
# <(selected_services_text)` (task-5-brief: that form hides a failing
# Python exit status).
selected_services_text() {
  local ready=false
  mirofish_enabled && ready=true
  python3 "$CONTROL_DIR/state.py" services --mirofish-ready "$ready" \
    --state "$CONTROL_STATE_PATH" --owner-uid "$CONTROL_OWNER_UID"
}

# control_helper_ready: readiness means the systemd-managed helper is
# ACTIVE and privately answers an authenticated GET as the dedicated
# gateway identity (UID 22001 over SO_PEERCRED) -- never merely "the
# gateway's own /__healthz responded" (task-5-brief: "not mere
# gatewayhealth"). `runuser` drops to that identity for the one curl call;
# this script itself still runs as root throughout.
control_helper_ready() {
  systemctl is-active --quiet "$CONTROL_SERVICE_NAME" || return 1
  runuser -u "$CONTROL_GATEWAY_USER" -- \
    curl -fsS --max-time 5 --unix-socket "$CONTROL_SOCKET_PATH" \
    -H "X-Verified-Actor: healthcheck" http://control-helper/apps >/dev/null 2>&1
}

# --- main flow below this line; test-deploy-firestore.sh sources only the
# function definitions above it and calls them directly. ---
selected_text="$(selected_services_text)" || {
  echo "health-check: failed to compute the selected service list" >&2
  exit 1
}
[[ -n "$selected_text" ]] || {
  echo "health-check: selected service list is empty" >&2
  exit 1
}
SERVICES=()
mapfile -t SERVICES <<<"$selected_text"

# Rollback redeploy (deploy.sh sets HEALTH_CHECK_ROLLBACK=1): the catalog is this
# run's, but the previous tag's compose decides what it runs. A service that
# compose does not define is not required; a service it defines but that is not
# running still fails. Forward deploys keep the strict check.
if [[ -n "${HEALTH_CHECK_ROLLBACK:-}" ]]; then
  defined_text="$(compose config --services)" || {
    echo "health-check: cannot read the rollback target's services" >&2
    exit 1
  }
  kept=()
  for service in "${SERVICES[@]}"; do
    if grep -qxF -- "$service" <<<"$defined_text"; then
      kept+=("$service")
    else
      echo "health-check: rollback target does not run $service; not required" >&2
    fi
  done
  SERVICES=("${kept[@]+"${kept[@]}"}")
fi

failing=()
for ((attempt = 1; attempt <= ATTEMPTS; attempt++)); do
  failing=()
  for service in "${SERVICES[@]}"; do
    service_ok "$service" || failing+=("$service")
  done
  if [[ -n "$SKIP_CONTROL_CHECK" ]]; then
    control_ok=0
  else
    control_ok=1
    control_helper_ready && control_ok=0
  fi
  if ((${#failing[@]} == 0)) && ((control_ok == 0)) && tunnel_ready; then
    echo "health-check: all services healthy; app controls ready; tunnel connected"
    exit 0
  fi
  sleep "$DELAY"
done
echo "health-check: failing services: ${failing[*]:-none}; app controls ready: $([[ "$control_ok" == 0 ]] && echo yes || echo no); tunnel connected: $(tunnel_ready && echo yes || echo no)" >&2
exit 1
