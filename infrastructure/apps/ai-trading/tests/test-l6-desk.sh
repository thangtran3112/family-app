#!/usr/bin/env bash
# Offline test for Family Desk Task 3.6's L6 (deploy) lane.
# No live Docker daemon is REQUIRED for the static checks (Cases 1-9); Cases
# 10-12 use a real `docker compose config`/`caddy validate`/a real throwaway
# Caddy + stub-upstream container trio when a Docker daemon is available, and
# SKIP (not fail) when it isn't -- same discipline as the existing
# test-deploy-firestore.sh's own real-Docker cases. No live Firestore, VPS,
# or secret value is used anywhere in this file.
#
# Run from this repository's own infrastructure/apps/ai-trading/tests/ directory
# (resolves its sibling infrastructure/apps/ai-trading/ files the same way the
# real deploy scripts resolve them).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROD_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOY_SH="$PROD_DIR/deploy.sh"
HEALTH_SH="$PROD_DIR/health-check.sh"
COMPOSE_FILE="$PROD_DIR/docker-compose.yml"
MIROFISH_COMPOSE_FILE="$PROD_DIR/docker-compose.mirofish.yml"
CADDYFILE="$PROD_DIR/Caddyfile"
AI_TRADING_ROOT="$(cd "$SCRIPT_DIR/../../../../ai-trading" && pwd)"
BAKE_HCL="$AI_TRADING_ROOT/deploy/docker-bake.hcl"
DOCKERFILE="$AI_TRADING_ROOT/packages/family-desk/backend/Dockerfile"

# Task 3.6 only owns the Dockerfile/bake/compose/Caddyfile/deploy.sh (its own
# Files list) -- Task 3.1's docker/postgres/zz-20-desk-roles.sh and
# infrastructure/host/apps/ai-trading-desk.conf are a different task and are
# not required to exist on this lane's own base.
for f in "$DEPLOY_SH" "$HEALTH_SH" "$COMPOSE_FILE" "$MIROFISH_COMPOSE_FILE" "$CADDYFILE" "$BAKE_HCL" "$DOCKERFILE"; do
  [[ -f "$f" ]] || { echo "test-l6-desk: missing $f" >&2; exit 1; }
done

PASS=0
FAIL_COUNT=0
ok() { PASS=$((PASS + 1)); printf 'ok %d - %s\n' "$PASS" "$*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); printf 'FAIL - %s\n' "$*" >&2; }

# --- Case 1: deploy.sh's SECRET_FILES includes desk.env ---
if grep -qE '^SECRET_FILES=\(.*\bdesk\.env\b.*\)$' "$DEPLOY_SH"; then
  ok "deploy.sh SECRET_FILES includes desk.env"
else
  fail "deploy.sh SECRET_FILES does not include desk.env"
fi

# --- Case 2: render_profiles' family_config render call list includes ai-trading/desk ---
# shellcheck disable=SC2016
if grep -qE '"\$family_config" render .*ai-trading/desk' "$DEPLOY_SH"; then
  ok "deploy.sh render_profiles call list includes ai-trading/desk"
else
  fail "deploy.sh render_profiles call list does not include ai-trading/desk"
fi

# --- Case 3: docker-compose.yml defines api and scheduler service blocks ---
if grep -qE '^  api:$' "$COMPOSE_FILE"; then ok "docker-compose.yml defines an api: service"; else fail "docker-compose.yml missing api: service"; fi
if grep -qE '^  scheduler:$' "$COMPOSE_FILE"; then ok "docker-compose.yml defines a scheduler: service"; else fail "docker-compose.yml missing scheduler: service"; fi

# --- Case 4: neither new service publishes a host port ---
# Extracts each service's own block (from its "  <name>:" line to just before
# the next top-level "  <name>:" line or EOF) and checks it has no "ports:" key.
service_block() {
  awk -v svc="  $1:" '
    $0 == svc { found=1; print; next }
    found && /^  [A-Za-z0-9_-]+:$/ { exit }
    found { print }
  ' "$COMPOSE_FILE"
}
if service_block api | grep -q '^\s*ports:'; then
  fail "api: service publishes a host port"
else
  ok "api: service publishes no host port"
fi
if service_block scheduler | grep -q '^\s*ports:'; then
  fail "scheduler: service publishes a host port"
else
  ok "scheduler: service publishes no host port"
fi

# --- Case 5: no desk-postgres service/volume, no ib-gateway, anywhere in this lane ---
if grep -qE '^  desk-postgres:' "$COMPOSE_FILE"; then
  fail "a desk-postgres: service block exists (owner decision D-e forbids it)"
else
  ok "no desk-postgres: service block"
fi
if grep -q 'desk-postgres-data' "$COMPOSE_FILE"; then
  fail "a desk-postgres-data volume exists"
else
  ok "no desk-postgres-data volume"
fi
if grep -rq --exclude-dir=tests 'ib-gateway' "$PROD_DIR" "$AI_TRADING_ROOT/packages/family-desk" 2>/dev/null; then
  fail "ib-gateway referenced somewhere in this lane (D-c: no IBKR in Phase 3)"
else
  ok "no ib-gateway reference anywhere in this lane"
fi

# --- Case 6: api/scheduler join the external postgres_default network as "database" ---
if grep -A2 '^  database:$' "$COMPOSE_FILE" | grep -q 'external: true' \
   && grep -A2 '^  database:$' "$COMPOSE_FILE" | grep -q 'name: postgres_default'; then
  ok "top-level 'database' network is external postgres_default"
else
  fail "top-level 'database' network is not external postgres_default"
fi
if service_block api | grep -qE 'networks: \[database, gateway, marketdata\]'; then
  ok "api: joins database, gateway, and marketdata (the bridge, 02t)"
else
  fail "api: does not join [database, gateway, marketdata]"
fi
if service_block scheduler | grep -qE 'networks: \[database, marketdata\]'; then
  ok "scheduler: joins database and marketdata, never gateway"
else
  fail "scheduler: does not join [database, marketdata] only"
fi

# --- Case 7: neither new service has a depends_on (D-e: cross-project, no gating via Compose) ---
if service_block api | grep -q 'depends_on:'; then
  fail "api: has a depends_on (the shared cluster is a different Compose project)"
else
  ok "api: has no depends_on"
fi
if service_block scheduler | grep -q 'depends_on:'; then
  fail "scheduler: has a depends_on"
else
  ok "scheduler: has no depends_on"
fi

# --- Case 8: health-check.sh needs no edit for this task, and never names
# desk-postgres. The app-controls system (Decision 5, HELD) made SERVICES a
# dynamically computed list (selected_services_text(), from control/state.py's
# catalog) instead of a static per-app array -- so this task's own Files list
# says "No change" to this file, and a static "SERVICES=(... api scheduler
# ...)" line is no longer the right shape to look for (api/scheduler are not
# yet registered in the catalog; that registration is Decision 5's own
# separate, owner-approved follow-up). ---
if grep -qE '^SERVICES=\([^)]*\b(api|scheduler)\b' "$HEALTH_SH"; then
  fail "health-check.sh hardcodes a static SERVICES list naming api/scheduler (should stay dynamic until Decision 5 lands)"
else
  ok "health-check.sh keeps SERVICES dynamically computed (no static per-app list for this task to edit)"
fi
if grep -q 'desk-postgres' "$HEALTH_SH"; then
  fail "health-check.sh wrongly references desk-postgres (not this project's container)"
else
  ok "health-check.sh does not reference desk-postgres"
fi

# --- Case 9: Caddy authenticates both Desk API path shapes before the plain
# /api/* MiroFish handle can swallow them. Literal route order is security-
# relevant: strip caller identity, authenticate, copy verified identity, proxy. ---
desk_line="$(grep -n '@desk_api path /api/desk /api/desk/\*' "$CADDYFILE" | head -1 | cut -d: -f1 || true)"
api_line="$(grep -n 'handle /api/\*' "$CADDYFILE" | head -1 | cut -d: -f1 || true)"
if [[ -n "$desk_line" && -n "$api_line" && "$desk_line" -lt "$api_line" ]]; then
  ok "Caddyfile: authenticated Desk API route precedes handle /api/*"
else
  fail "Caddyfile: authenticated Desk API route is missing or follows /api/* (desk=$desk_line api=$api_line)"
fi
desk_block="$(awk '/handle @desk_api \{/{f=1} f{print; if (/^\t\}$/) exit}' "$CADDYFILE")"
strip_line="$(grep -n 'request_header -Cf-Access-Authenticated-User-Email' <<<"$desk_block" | head -1 | cut -d: -f1 || true)"
auth_line="$(grep -n 'forward_auth auth:8181' <<<"$desk_block" | head -1 | cut -d: -f1 || true)"
copy_line="$(grep -n 'copy_headers X-Verified-Email>Cf-Access-Authenticated-User-Email' <<<"$desk_block" | head -1 | cut -d: -f1 || true)"
proxy_line="$(grep -n 'reverse_proxy api:8000' <<<"$desk_block" | head -1 | cut -d: -f1 || true)"
if [[ -n "$strip_line" && -n "$auth_line" && -n "$copy_line" && -n "$proxy_line" \
      && "$strip_line" -lt "$auth_line" && "$auth_line" -lt "$copy_line" && "$copy_line" -lt "$proxy_line" ]] \
   && ! grep -qE 'respond 404|availability_gate|X-Test-|X-Desk-|default.*(user|principal)' <<<"$desk_block"; then
  ok "Caddyfile: Desk API strips caller identity, authenticates, copies verified identity, then proxies only to api:8000"
else
  fail "Caddyfile: Desk API auth/proxy order is unsafe: $desk_block"
fi

if grep -qE '^  (ib-gateway|broker|orders?):' "$COMPOSE_FILE" \
   || service_block api | grep -qiE 'IBKR|BROKER|ORDER' \
   || service_block scheduler | grep -qiE 'IBKR|BROKER|ORDER'; then
  fail "compose activates a broker/IBKR/order service or environment"
else
  ok "compose activates no broker, IBKR, or order runtime"
fi

# --- Case 10 (real Docker, skipped if unavailable): docker compose config
# --quiet validates the edited compose files together, same merged
# base+mirofish inputs deploy.sh's own validate_staged_compose uses. ---
if ! docker compose version >/dev/null 2>&1; then
  echo "SKIP - docker compose not available in this environment (Case 10)"
else
  fake_secrets="$(mktemp -d)"
  for name in tradingagents.env ai-hedge-fund.env vibe-trading.env vibe-gateway.env vibe-consensus.env auth.env market-data.env market-data-bridge.env desk.env cloudflared.env; do
    printf 'FAKE_VALUE=fake-not-real-%s\n' "$name" >"$fake_secrets/$name"
  done
  if AI_TRADING_IMAGE_TAG=0000000000000000000000000000000000000000 \
     AI_TRADING_SECRETS_DIR="$fake_secrets" \
     docker compose --project-name ai-trading-l6-test -f "$COMPOSE_FILE" -f "$MIROFISH_COMPOSE_FILE" config --quiet; then
    ok "docker compose config --quiet validates the edited docker-compose.yml + docker-compose.mirofish.yml"
  else
    fail "docker compose config --quiet rejected the edited compose files"
  fi
  rm -rf "$fake_secrets"
fi

# --- Case 11 (real Docker, skipped if unavailable): `caddy validate` accepts
# the edited Caddyfile. ---
if ! docker image inspect caddy:2-alpine >/dev/null 2>&1 && ! docker pull caddy:2-alpine >/dev/null 2>&1; then
  echo "SKIP - caddy:2-alpine image not available in this environment (Case 11)"
else
  if docker run --rm -v "$CADDYFILE:/etc/caddy/Caddyfile:ro" caddy:2-alpine \
       caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
    ok "caddy validate accepts the edited Caddyfile"
  else
    fail "caddy validate rejected the edited Caddyfile"
  fi
fi

# --- Case 12 (real Docker + real Caddy + stub upstreams, skipped if
# unavailable): proves the routing itself. Desk is authenticated and reaches
# its own upstream, while authenticated plain /api/* still reaches MiroFish.
#
# The real Caddyfile now wraps /api/* (and every other toggleable app route)
# in `import availability_gate <id>`, which calls a control helper over a
# unix socket at /run/family-app/ai-trading-control/control.sock (Task 4,
# 01g). This harness never touches that real host path -- it stands up its
# own tiny Python control stub, listening on a unix socket inside a
# throwaway temp directory ($control_stub_dir below), and bind-mounts that
# directory into the Caddy container at the exact path the Caddyfile
# hardcodes, the same way production bind-mounts the real helper's socket
# directory in. The stub answers 200 for every /gate/* path. ---
run_case12() {
  local net stub_dir control_stub_dir port
  net="l6-desk-route-check-$$"
  # Must live under this repo checkout, not a generic /tmp -- a Colima/
  # virtiofs Docker host (this machine's setup) only bind-mounts paths under
  # its configured mount roots (the home directory by default); /tmp is not
  # one of them there and silently mounts as an empty directory instead.
  stub_dir="$SCRIPT_DIR/.l6-route-check-stub-$$"
  control_stub_dir="$SCRIPT_DIR/.l6-route-check-control-$$"
  mkdir -p "$stub_dir" "$control_stub_dir"

  cat >"$stub_dir/auth_stub.py" <<'PY'
import http.server
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/__auth/check":
            if self.headers.get("X-Test-Authed") == "1":
                self.send_response(200); self.send_header("X-Verified-Email", "fake@example.com"); self.end_headers()
            else:
                self.send_response(401); self.end_headers()
        else:
            self.send_response(404); self.end_headers()
    def log_message(self, *a): pass
http.server.HTTPServer(("0.0.0.0", 8181), H).serve_forever()
PY
  cat >"$stub_dir/api_stub.py" <<'PY'
import http.server
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b"DESK-API-STUB")
    def log_message(self, *a): pass
http.server.HTTPServer(("0.0.0.0", 8000), H).serve_forever()
PY
  cat >"$stub_dir/mirofish_stub.py" <<'PY'
import http.server
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b"MIROFISH-STUB")
    def log_message(self, *a): pass
http.server.HTTPServer(("0.0.0.0", 5001), H).serve_forever()
PY
  # Fake stand-in for Task 4's control helper (ai-trading/control/server.py):
  # a bare unix-socket HTTP server, 200 for every /gate/* path. This file is
  # never run against the real socket path -- only against control.sock
  # inside $control_stub_dir, bind-mounted into the Caddy container below.
  cat >"$control_stub_dir/control_stub.py" <<'PY'
import http.server
import os
import socketserver

sock_path = "/sockdir/control.sock"
if os.path.exists(sock_path):
    os.remove(sock_path)

class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/gate/"):
            self.send_response(200); self.end_headers(); self.wfile.write(b'{"available":true}')
        else:
            self.send_response(404); self.end_headers()
    def log_message(self, *a): pass

class UnixHTTPServer(socketserver.UnixStreamServer):
    allow_reuse_address = True

server = UnixHTTPServer(sock_path, H)
try:
    os.chmod(sock_path, 0o666)
except OSError:
    pass  # some bind-mount filesystems (e.g. macOS virtiofs) reject chmod on a socket; default perms already work
server.serve_forever()
PY

  docker network create "$net" >/dev/null 2>&1
  docker run -d --name "l6-auth-$$" --network "$net" --network-alias auth -v "$stub_dir":/stubs:ro python:3.12-slim-trixie python /stubs/auth_stub.py >/dev/null 2>&1
  docker run -d --name "l6-api-$$" --network "$net" --network-alias api -v "$stub_dir":/stubs:ro python:3.12-slim-trixie python /stubs/api_stub.py >/dev/null 2>&1
  docker run -d --name "l6-mirofish-$$" --network "$net" --network-alias mirofish -v "$stub_dir":/stubs:ro python:3.12-slim-trixie python /stubs/mirofish_stub.py >/dev/null 2>&1
  # Control stub: read-write mount so it can create the socket file; Caddy
  # mounts the same host directory read-only at the real hardcoded path.
  docker run -d --name "l6-control-$$" --network "$net" -v "$control_stub_dir":/sockdir python:3.12-slim-trixie python /sockdir/control_stub.py >/dev/null 2>&1
  port=$((20000 + (RANDOM % 10000)))
  docker run -d --name "l6-caddy-$$" --network "$net" -p "127.0.0.1:$port:8080" \
    -v "$CADDYFILE:/etc/caddy/Caddyfile:ro" \
    -v "$control_stub_dir":/run/family-app/ai-trading-control:ro \
    caddy:2-alpine >/dev/null 2>&1
  sleep 3

  local code_bare code_unauth code_authed body_authed_mirofish code_forged
  code_bare="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/desk")"
  code_unauth="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/desk/foo")"
  code_authed="$(curl -s -o /dev/null -w '%{http_code}' -H 'X-Test-Authed: 1' "http://127.0.0.1:$port/api/desk/foo")"
  body_authed_mirofish="$(curl -s -H 'X-Test-Authed: 1' "http://127.0.0.1:$port/api/foo")"
  code_forged="$(curl -s -o /dev/null -w '%{http_code}' -H 'Cf-Access-Authenticated-User-Email: attacker@evil.com' "http://127.0.0.1:$port/api/desk/foo")"

  if [[ "$code_bare" == 401 ]]; then ok "bare /api/desk requires auth (401)"; else fail "bare /api/desk -> $code_bare, expected 401"; fi
  if [[ "$code_unauth" == 401 ]]; then ok "unauthenticated /api/desk/* is rejected (401)"; else fail "unauthenticated /api/desk/* -> $code_unauth, expected 401"; fi
  if [[ "$code_authed" == 200 ]]; then ok "authenticated /api/desk/* reaches the Desk upstream"; else fail "authenticated /api/desk/* -> $code_authed, expected 200"; fi
  if [[ "$body_authed_mirofish" == "MIROFISH-STUB" ]]; then ok "authenticated plain /api/* still reaches mirofish, not the Desk"; else fail "authenticated plain /api/* returned: $body_authed_mirofish"; fi
  if [[ "$code_forged" == 401 ]]; then ok "forged identity cannot authenticate /api/desk/* (401)"; else fail "forged-header request to /api/desk/* -> $code_forged, expected 401"; fi

  docker rm -f "l6-auth-$$" "l6-api-$$" "l6-mirofish-$$" "l6-control-$$" "l6-caddy-$$" >/dev/null 2>&1
  docker network rm "$net" >/dev/null 2>&1
  rm -rf "$stub_dir" "$control_stub_dir"
}

if ! docker compose version >/dev/null 2>&1; then
  echo "SKIP - docker not available for the real-Caddy routing check (Case 12)"
else
  run_case12
fi

# --- Case 13: SKIPPED. Walking up from this real tests/ directory to
# build the real Dockerfile against the real common/+packages/family-desk/
# backend/ would need a real `uv lock`/network-reachable build, which no
# offline CI case should depend on -- the equivalent check is a manual
# `docker buildx bake` run instead (ai-trading/AGENTS.md's own Verification
# section), not reproduced here to avoid a misleading always-stale-source
# check landing in this deliverable.
echo "SKIP - Case 13 (Dockerfile build) run manually instead; see ai-trading/AGENTS.md Verification"

printf '\n%d checks passed, %d failed (test-l6-desk.sh)\n' "$PASS" "$FAIL_COUNT"
[[ "$FAIL_COUNT" -eq 0 ]]
