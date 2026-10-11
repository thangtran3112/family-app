#!/usr/bin/env bash
# Real-Caddy + real-auth-server + real-control-helper integration test for
# Task 4 (01g): fresh Clerk control auth and the availability boundary.
#
# This is its own isolated fixture, never the real ai-trading project, real
# host Docker socket, or real provider/customer data:
#   - a dummy "tradingagents" app group (echo ta-terminal + dummy ta-research,
#     same network-isolation shape as production) stands in for a real app;
#   - the real ai-trading/control/server.py + state.py run against a FAKE
#     Runtime (no docker/compose call anywhere) so app Running/Stopped
#     transitions are deterministic and instant;
#   - the real ai-trading/auth/src/server.js runs with the REAL
#     @clerk/backend SDK, verifying genuinely RS256-signed, locally minted
#     JWTs offline (jwtKey), never a hand-rolled fake verifier and never the
#     network;
#   - the real production Caddyfile drives one real Caddy container.
# Every container/network/volume name is unique to this run so concurrent
# sessions (including another run of this same script, or
# deploy/ci/smoke-test.sh's own gateway fixture) cannot collide.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)" # repository root
CADDYFILE="$ROOT/ai-trading/deploy/production/Caddyfile"
ID="actrlgw-$(date +%s)-$$"
NET="${ID}-net"
RESEARCH_NET="${ID}-rnet"
# Deliberately distinct from smoke-test.sh's own fixed research subnet
# (172.30.90.0/29), and overridable so a different concurrently running
# fixture's subnet never collides with this one's.
RESEARCH_SUBNET="${CONTROL_TEST_RESEARCH_SUBNET:-172.31.95.0/29}"
SOCK_VOLUME="${ID}-sock"
# Fix round 1 review: never under ai-trading/ (not even gitignored scratch --
# the binding constraints forbid key/token material anywhere in the
# repository, cleanup notwithstanding) and not the approved opencode temp
# dir either: on this host, Docker runs in a Colima Lima VM that mounts only
# $HOME by default (confirmed empirically -- a bind mount under either
# /tmp/* or /private/var/folders/*/T/opencode/* silently appears EMPTY
# inside a container, even the approved one). A unique, 0700, trap-cleaned
# scratch directory under $HOME's own cache dir is outside the repository
# and still Colima-mountable.
FIXTURE_DIR="$HOME/.cache/ai-trading-controls-test-fixture/${ID}"
mkdir -p "$FIXTURE_DIR"
chmod 0700 "$FIXTURE_DIR"
GATEWAY_UID=22001
ALLOWED_ORIGIN="https://fixture.tobytran.dev"
ALLOWED_EMAIL="fixture@example.test"
SESSION_KEY="$(printf 'a%.0s' {1..64})"

containers=()

cleanup() {
  if ((${#containers[@]})); then
    docker rm -fv "${containers[@]}" >/dev/null 2>&1 || true
  fi
  docker network rm "$NET" "$RESEARCH_NET" >/dev/null 2>&1 || true
  docker volume rm "$SOCK_VOLUME" >/dev/null 2>&1 || true
  rm -rf "$FIXTURE_DIR"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

ok() { echo "ok   $*"; }

expect_status() {
  local want="$1" url="$2" got=""
  shift 2
  local deadline=$((SECONDS + "${WAIT_SECONDS:-30}"))
  while ((SECONDS < deadline)); do
    got="$(curl -s --connect-timeout 5 --max-time 10 -o /dev/null -w '%{http_code}' "$@" "$url" || true)"
    if [[ "$got" == "$want" ]]; then
      ok "$want $url"
      return 0
    fi
    sleep 1
  done
  fail "expected $want from $url, got ${got:-no response}"
}

# -- fixture generation (JWT keypairs + minting), outside the repository --

cat >"$FIXTURE_DIR/genkey.mjs" <<'EOF'
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
const prefix = process.argv[2] || "";
const kp = generateKeyPairSync("rsa", { modulusLength: 2048 });
writeFileSync(`/out/${prefix}priv.pem`, kp.privateKey.export({ type: "pkcs1", format: "pem" }));
writeFileSync(`/out/${prefix}pub.pem`, kp.publicKey.export({ type: "spki", format: "pem" }));
EOF

cat >"$FIXTURE_DIR/mint.mjs" <<'EOF'
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const claims = JSON.parse(process.env.CLAIMS_JSON);
const priv = readFileSync(process.env.PRIV_KEY_PATH || "/out/priv.pem", "utf8");
const header = b64url(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })));
const payload = b64url(Buffer.from(JSON.stringify(claims)));
const signingInput = `${header}.${payload}`;
const signature = b64url(createSign("RSA-SHA256").update(signingInput).sign(priv));
process.stdout.write(`${signingInput}.${signature}`);
EOF

cat >"$FIXTURE_DIR/auth-harness.mjs" <<'EOF'
// Runs the REAL, unmodified auth/src/server.js (mounted read-only at
// /fixture/auth-src, sibling to a read-only mount of the real
// node_modules -- never nested inside another read-only mount, so this
// never needs a writable /app and never touches the real source tree) with
// the REAL @clerk/backend verifyToken -- only its jwtKey is supplied (a
// local public key), so verification is genuinely offline, never a
// hand-rolled fake that ignores expiry/signature (same technique as
// auth/src/server.test.js).
import { createAuthServer } from "/fixture/auth-src/server.js";
import { verifyToken as realVerifyToken } from "@clerk/backend";
import { readFileSync } from "node:fs";
const jwtKey = readFileSync("/fixture/pub.pem", "utf8");
const server = createAuthServer({
  SESSION_SIGNING_KEY: process.env.SESSION_SIGNING_KEY,
  ALLOWED_EMAILS: process.env.ALLOWED_EMAILS,
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
  verifyToken: (token, opts) => realVerifyToken(token, { ...opts, jwtKey }),
});
server.listen(8181, "0.0.0.0", () => console.log("auth harness listening"));
EOF

cat >"$FIXTURE_DIR/control-harness.py" <<'EOF'
# Runs the REAL, unmodified control/server.py + state.py (mounted read-only
# at /app/control) against a FAKE Runtime -- no docker/compose call exists
# anywhere in this process. Every app starts not-actually-running, same as a
# cold host before anything reconciles, so "stopped" is the natural starting
# condition rather than something this harness has to force.
import sys
import threading
from pathlib import Path

sys.path.insert(0, "/app/control")
import server as server_module  # noqa: E402
from server import create_server  # noqa: E402
from state import atomic_write, initial_state  # noqa: E402

STATE_PATH = Path("/data/control.json")
LOCK_PATH = Path("/data/.control.lock")
SOCKET_PATH = Path("/run/family-app/ai-trading-control/control.sock")
RECEIVED_HEADERS_LOG = Path("/data/received-headers.log")

# Fix round 1 review: prove, not just declare by Caddyfile text, that
# neither Authorization nor Cookie ever reaches this private helper.
# Observation-only wrapper around the REAL, unmodified _Handler -- records
# header PRESENCE only (never the header value, never any token/cookie
# content) to a file inside this ephemeral container, then delegates to the
# real dispatch unchanged via super(). This never alters routing, auth, or
# response behavior; it only makes an already-true-or-false fact assertable
# from the test script.
_RealHandler = server_module._Handler


class _ObservingHandler(_RealHandler):
    def _dispatch(self, method):
        try:
            with open(RECEIVED_HEADERS_LOG, "a", encoding="utf-8") as f:
                f.write(
                    f"path={self.path} "
                    f"has_authorization={self.headers.get('Authorization') is not None} "
                    f"has_cookie={self.headers.get('Cookie') is not None}\n"
                )
        except OSError:
            pass
        return super()._dispatch(method)


server_module._Handler = _ObservingHandler


class FakeRuntime:
    def __init__(self):
        self.ready = {"tradingagents": False, "ai-hedge-fund": False, "vibe-trading": False, "mirofish": False}

    def service_states(self, services):
        return {s: {"status": "absent", "health": "none"} for s in services}

    def group_status(self, app_id, enabled, observations=None):
        if self.ready.get(app_id) == enabled:
            return "Running" if enabled else "Stopped"
        return "Unhealthy"

    def converged(self, app_id, enabled):
        return self.ready.get(app_id) == enabled

    def prepare_mirofish(self, lock_fd=None):
        return True

    def apply(self, app_id, enabled):
        self.ready[app_id] = enabled


runtime = FakeRuntime()
# An empty (not None) running-services collection: every app starts
# desired OFF, matching FakeRuntime's own all-False readiness, so boot
# reconciliation has nothing to "fix" -- this fixture models "stopped",
# not "crashed while supposed to be running".
atomic_write(STATE_PATH, initial_state([]))
server = create_server(SOCKET_PATH, STATE_PATH, LOCK_PATH, runtime, gateway_uid=22001, audit_log_path=Path("/data/audit.log"))
threading.Thread(target=server.reconcile, daemon=True).start()
server.serve_forever()
EOF

# -- networks / volume --

docker network rm "$NET" "$RESEARCH_NET" >/dev/null 2>&1 || true
docker network create "$NET" >/dev/null
docker network create --subnet "$RESEARCH_SUBNET" "$RESEARCH_NET" >/dev/null
docker volume rm "$SOCK_VOLUME" >/dev/null 2>&1 || true
docker volume create "$SOCK_VOLUME" >/dev/null

docker run --rm -v "$FIXTURE_DIR:/out" node:24-alpine node /out/genkey.mjs >/dev/null
docker run --rm -v "$FIXTURE_DIR:/out" node:24-alpine node /out/genkey.mjs other- >/dev/null

# -- real clerk.js's own fixed issuer/audience (never duplicated by hand) --
read -r CLERK_ISSUER CLERK_AUDIENCE < <(docker run --rm -v "$ROOT/ai-trading/auth:/app:ro" -w /app node:24-alpine \
  node -e 'import("./src/clerk.js").then((m) => console.log(m.CLERK_ISSUER, m.CLERK_AUDIENCE))')
[[ -n "$CLERK_ISSUER" && -n "$CLERK_AUDIENCE" ]] || fail "could not read CLERK_ISSUER/CLERK_AUDIENCE from the real clerk.js"

mint_token() {
  local sub="$1" email="$2" exp_offset="$3" priv_path="${4:-/out/priv.pem}"
  local now claims
  now=$(date +%s)
  claims=$(printf '{"sub":"%s","email":"%s","iss":"%s","aud":"%s","azp":"%s","iat":%d,"nbf":%d,"exp":%d}' \
    "$sub" "$email" "$CLERK_ISSUER" "$CLERK_AUDIENCE" "$ALLOWED_ORIGIN" "$((now - 10))" "$((now - 10))" "$((now + exp_offset))")
  docker run --rm -v "$FIXTURE_DIR:/out:ro" -e CLAIMS_JSON="$claims" -e PRIV_KEY_PATH="$priv_path" node:24-alpine node /out/mint.mjs
}

sign_session_cookie() {
  local email="$1" exp_offset="$2"
  docker run --rm node:24-alpine node -e '
const { createHmac } = require("node:crypto");
const key = Buffer.from(process.argv[1], "hex");
const payload = JSON.stringify({ email: process.argv[2], exp: Math.floor(Date.now() / 1000) + Number(process.argv[3]) });
const body = Buffer.from(payload).toString("base64url");
const mac = createHmac("sha256", key).update(body).digest("base64url");
process.stdout.write(`__ai_trading_session=${body}.${mac}`);
' "$SESSION_KEY" "$email" "$exp_offset"
}

# -- dummy tradingagents app group (same network-isolation shape as production) --

docker run -d --name "${ID}-terminal" --network "$NET" --network-alias ta-terminal \
  python:3.12-alpine python3 -c '
import http.server
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = self.headers.get("Cf-Access-Authenticated-User-Email", "none").encode()
        self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers()
        self.wfile.write(body)
http.server.HTTPServer(("0.0.0.0", 7681), H).serve_forever()
' >/dev/null
containers+=("${ID}-terminal")

docker run -d --name "${ID}-research" --network "$RESEARCH_NET" --network-alias ta-research \
  python:3.12-alpine python3 -c '
import http.server
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"research-ok"
        self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers()
        self.wfile.write(body)
http.server.HTTPServer(("0.0.0.0", 8182), H).serve_forever()
' >/dev/null
containers+=("${ID}-research")

# -- real control helper, fake Runtime, socket shared via a named volume --
# (a named, ephemeral docker volume -- never a host-owned bind mount -- is
# the root-owned socket directory both this and Caddy expect; this is also
# what keeps it working under a macOS Docker VM (Colima/Docker Desktop
# alike), where a host bind mount cannot carry real root ownership for a
# 0660 socket.)

docker run -d --name "${ID}-control" \
  -v "$SOCK_VOLUME:/run/family-app/ai-trading-control" \
  -v "$ROOT/ai-trading/control:/app/control:ro" \
  -v "$FIXTURE_DIR/control-harness.py:/harness.py:ro" \
  --tmpfs /data:rw,mode=0755 \
  python:3.12-slim python3 /harness.py >/dev/null
containers+=("${ID}-control")

deadline=$((SECONDS + 15))
until docker exec "${ID}-control" test -S /run/family-app/ai-trading-control/control.sock 2>/dev/null; do
  ((SECONDS < deadline)) || fail "control helper did not create its socket in time"
  sleep 0.3
done
ok "real control helper (fake Runtime) bound its socket"

# -- real auth server, real SDK, offline-minted JWTs --

docker run -d --name "${ID}-auth" --network "$NET" --network-alias auth \
  -v "$ROOT/ai-trading/auth/src:/fixture/auth-src:ro" \
  -v "$ROOT/ai-trading/auth/node_modules:/fixture/node_modules:ro" \
  -v "$FIXTURE_DIR/auth-harness.mjs:/fixture/auth-harness.mjs:ro" \
  -v "$FIXTURE_DIR/pub.pem:/fixture/pub.pem:ro" \
  -e SESSION_SIGNING_KEY="$SESSION_KEY" -e ALLOWED_EMAILS="$ALLOWED_EMAIL" -e ALLOWED_ORIGINS="$ALLOWED_ORIGIN" \
  -w /fixture node:24-alpine node /fixture/auth-harness.mjs >/dev/null
containers+=("${ID}-auth")

# -- real Caddy, the production Caddyfile, the fixed gateway UID/GID --

docker run -d --name "${ID}-caddy" --network "$NET" -p 127.0.0.1:0:8080 \
  --user "$GATEWAY_UID:$GATEWAY_UID" \
  -e VIBE_API_AUTH_KEY=unused-in-this-fixture \
  -v "$CADDYFILE:/etc/caddy/Caddyfile:ro" \
  -v "$SOCK_VOLUME:/run/family-app/ai-trading-control:ro" \
  --tmpfs /config:uid=22001,gid=22001,mode=0700 --tmpfs /data:uid=22001,gid=22001,mode=0700 \
  caddy:2-alpine >/dev/null
containers+=("${ID}-caddy")
docker network connect "$RESEARCH_NET" "${ID}-caddy"
docker restart "${ID}-caddy" >/dev/null

CADDY_PORT="$(docker port "${ID}-caddy" 8080/tcp | sed 's/.*://')"
BASE="http://127.0.0.1:${CADDY_PORT}"
WAIT_SECONDS=20 expect_status 200 "$BASE/__healthz"

# === 1. research isolation (unchanged by this task) ===================

research_ip="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$RESEARCH_NET\").IPAddress}}" "${ID}-research")"
[[ -n "$research_ip" ]] || fail "could not determine the dummy ta-research container's $RESEARCH_NET IP"
bypass="$(docker exec "${ID}-terminal" python3 -c "
import urllib.request, urllib.error, socket
try:
    urllib.request.urlopen(urllib.request.Request('http://$research_ip:8182/'), timeout=3)
    print('REACHED')
except (urllib.error.URLError, OSError, socket.timeout):
    print('UNREACHABLE')
" 2>/dev/null)"
[[ "$bypass" == "UNREACHABLE" ]] || fail "a peer on ta-terminal's own network must not reach ta-research's IP at all -- got: $bypass"
ok "a ta-terminal-network peer cannot reach ta-research's IP at all (research network isolation preserved)"

# === 2. auth-first: unauthenticated app request stays 401 regardless of app state ===

expect_status 401 "$BASE/u/tradingagents/"
ok "an unauthenticated app request is 401 before the availability gate is ever consulted"

# === 3. stopped: authenticated but not-converged app is the helper's own actionable 503 ===

cookie="$(sign_session_cookie "$ALLOWED_EMAIL" 3600)"
status="$(curl -s -o /dev/null -w '%{http_code}' --cookie "$cookie" "$BASE/u/tradingagents/")"
stopped_headers="$(curl -s -D - -o /dev/null --cookie "$cookie" "$BASE/u/tradingagents/")"
body="$(curl -s --cookie "$cookie" "$BASE/u/tradingagents/")"
[[ "$status" == "503" ]] || fail "expected 503 for an authenticated request to a stopped app, got $status"
# Exact fixed contract (not a substring): control/server.py's own
# GATE_UNAVAILABLE_BODY, byte for byte, plus its no-store Cache-Control.
[[ "$body" == '{"error":"app_unavailable","message":"Open Trading Hub Settings to start the app or check its status."}' ]] \
  || fail "expected the helper's exact fixed app_unavailable body, got: $body"
grep -qi '^cache-control: no-store' <<<"$stopped_headers" || fail "expected Cache-Control: no-store on the stopped-app 503, got: $stopped_headers"
ok "an authenticated request to a desired-but-not-converged app gets the helper's own exact, no-store, actionable 503 (not a generic error)"

# === 4. control API: cookie alone is never sufficient ===

expect_status 401 "$BASE/__control/apps" --cookie "$cookie"
ok "a valid gateway session cookie alone cannot authorize the control API"

# === 5. control-check / private gate: not externally reachable under any path ===

expect_status 404 "$BASE/__auth/control-check"
expect_status 404 "$BASE/__control/gate/tradingagents"
expect_status 404 "$BASE/gate/tradingagents"
ok "the internal auth-check and the private gate are both externally 404, not reachable through any public path"

# === 6. control API: fresh bearer required; missing/expired/bad-signature tokens rejected ===

expect_status 401 "$BASE/__control/apps"
token_expired="$(mint_token user_fixture_actor "$ALLOWED_EMAIL" -10)"
expect_status 401 "$BASE/__control/apps" -H "Authorization: Bearer $token_expired"
ok "the control API rejects a missing bearer and a genuinely expired real-SDK-signed token"

token_badsig="$(mint_token user_fixture_actor "$ALLOWED_EMAIL" 3600 /out/other-priv.pem)"
expect_status 401 "$BASE/__control/apps" -H "Authorization: Bearer $token_badsig"
ok "the control API rejects a token signed with the wrong private key (real-SDK signature check)"

token_valid="$(mint_token user_fixture_actor "$ALLOWED_EMAIL" 3600)"
expect_status 200 "$BASE/__control/apps" -H "Authorization: Bearer $token_valid"
ok "a genuinely signed, unexpired, allowed real-SDK token is accepted for GET /__control/apps"

# === 7. control API mutation: Origin checked first, and the ORIGINAL method is Caddy-generated ===

expect_status 403 "$BASE/__control/apps/tradingagents" -X PUT \
  -H "Authorization: Bearer $token_valid" -H 'Origin: https://evil.example.test' \
  -H 'Content-Type: application/json' -d '{"enabled":true,"expectedRevision":0}'
ok "a mutation with a disallowed Origin is rejected (403), even with an otherwise-valid bearer"

expect_status 403 "$BASE/__control/apps/tradingagents" -X PUT \
  -H "Authorization: Bearer $token_valid" -H 'Origin: https://evil.example.test' \
  -H 'X-Forwarded-Method: GET' -H 'Content-Type: application/json' -d '{"enabled":true,"expectedRevision":0}'
ok "a client-forged X-Forwarded-Method cannot bypass the Origin gate -- Caddy's own real method always wins"

# === 8. control API mutation: body preserved end-to-end, app transitions to Running ===

put_status="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/__control/apps/tradingagents" -X PUT \
  -H "Authorization: Bearer $token_valid" -H "Origin: $ALLOWED_ORIGIN" \
  -H 'Content-Type: application/json' -d '{"enabled":true,"expectedRevision":0}')"
[[ "$put_status" == "202" ]] || fail "expected 202 Accepted for the first enable PUT, got $put_status"
ok "PUT /__control/apps/tradingagents with a real body (enabled:true) is accepted (202) -- the body survived forward_auth"

deadline=$((SECONDS + 15))
until curl -s -H "Authorization: Bearer $token_valid" "$BASE/__control/apps" | grep -q '"id":"tradingagents","enabled":true,"status":"Running"'; do
  ((SECONDS < deadline)) || fail "tradingagents never reached Running after the enable PUT"
  sleep 0.5
done
ok "tradingagents converges to Running after its PUT -- the real worker thread's apply() call to the FakeRuntime actually ran"

expect_status 200 "$BASE/u/tradingagents/" --cookie "$cookie" -H 'Cf-Access-Authenticated-User-Email: attacker@evil.com'
echoed="$(curl -s --cookie "$cookie" -H 'Cf-Access-Authenticated-User-Email: attacker@evil.com' "$BASE/u/tradingagents/")"
[[ "$echoed" == "$ALLOWED_EMAIL" ]] || fail "expected the upstream to see the verified email after the app came up, got: $echoed"
ok "once the app converges, an authenticated request reaches the real upstream (availability-before-proxy, auth-before-availability)"

# === 9. actor identity: a forged client header is always overwritten by the verified subject ===

token_other_actor="$(mint_token real_verified_actor "$ALLOWED_EMAIL" 3600)"
# A different, not-yet-touched app (tradingagents is already converged from
# step 8, so re-asserting enabled:true there would be a no-op 200, not a
# genuine 202 change).
expect_status 202 "$BASE/__control/apps/ai-hedge-fund" -X PUT \
  -H "Authorization: Bearer $token_other_actor" -H "Origin: $ALLOWED_ORIGIN" -H 'X-Verified-Actor: attacker_spoofed' \
  -H 'Content-Type: application/json' -d '{"enabled":true,"expectedRevision":1}'
audit="$(docker exec "${ID}-control" cat /data/audit.log)"
[[ "$audit" == *"actor=real_verified_actor"* ]] || fail "expected the audit log to record the verified actor, got: $audit"
[[ "$audit" != *"attacker_spoofed"* ]] || fail "a client-forged X-Verified-Actor leaked into the helper's own audit log: $audit"
ok "a client-supplied X-Verified-Actor is always overwritten by the gateway-verified subject before it ever reaches the helper"

# === 10. credential stripping: the private helper itself never receives Authorization or Cookie ===
# Fix round 1 review: the Caddyfile declares `header_up -Authorization` /
# `header_up -Cookie` on both the availability forward_auth and the
# /__control/* reverse_proxy, but that is only Caddyfile text until proven
# at the real helper boundary. Every request so far (steps 2-9) sent a real
# cookie, a real bearer, or both, straight at Caddy -- if either leaked
# through, the real helper's own observation log (above) would show it.

header_log="$(docker exec "${ID}-control" cat /data/received-headers.log 2>/dev/null || true)"
[[ -n "$header_log" ]] || fail "the helper observed no requests at all -- this assertion would be vacuous"
[[ "$header_log" != *"has_authorization=True"* ]] \
  || fail "the private helper received an Authorization header -- Caddy's header_up -Authorization did not strip it: $header_log"
[[ "$header_log" != *"has_cookie=True"* ]] \
  || fail "the private helper received a Cookie header -- Caddy's header_up -Cookie did not strip it: $header_log"
ok "the private helper never receives Authorization or Cookie end-to-end, across every gate and control-API request made so far"

# === 11. wrong peer UID: filesystem group access is not enough, SO_PEERCRED still denies it ===

bad_uid_result="$(docker run --rm --user "9999:$GATEWAY_UID" -v "$SOCK_VOLUME:/run/family-app/ai-trading-control:ro" \
  curlimages/curl:latest -s -o /dev/null -w '%{http_code}' --max-time 3 \
  --unix-socket /run/family-app/ai-trading-control/control.sock http://localhost/apps 2>&1 || echo "CONNECTION_FAILED")"
[[ "$bad_uid_result" != "200" && "$bad_uid_result" != "204" ]] \
  || fail "a peer at the wrong UID (same GID, filesystem-permitted) was still served -- SO_PEERCRED check did not reject it"
ok "a peer with the wrong UID (but the right GID -- filesystem permissions alone would allow it) is rejected by the real SO_PEERCRED check"

# === 12. outage: the control helper itself is gone -> Caddy's own generic 503, never the app_unavailable body ===

docker rm -fv "${ID}-control" >/dev/null 2>&1 || true
outage_status="$(curl -s -o /dev/null -w '%{http_code}' --cookie "$cookie" "$BASE/u/tradingagents/")"
outage_headers="$(curl -s -D - -o /dev/null --cookie "$cookie" "$BASE/u/tradingagents/")"
outage_body="$(curl -s --cookie "$cookie" "$BASE/u/tradingagents/")"
[[ "$outage_status" == "503" ]] || fail "expected 503 when the control helper itself is unreachable, got $outage_status"
# Exact fixed contract (not a substring): the Caddyfile's own
# `availability_errors` snippet body, byte for byte, plus its no-store
# Cache-Control -- distinct from the helper's own app_unavailable body.
[[ "$outage_body" == '{"error":"service_unavailable","message":"Trading service unavailable. Open Trading Hub Settings or try again."}' ]] \
  || fail "expected Caddy's exact fixed service_unavailable body during an outage, got: $outage_body"
grep -qi '^cache-control: no-store' <<<"$outage_headers" || fail "expected Cache-Control: no-store on the outage 503, got: $outage_headers"
ok "a genuine socket outage (helper gone) produces Caddy's exact, no-store, generic 503 -- distinct from the helper's deliberate app_unavailable body"

echo "test-app-controls-gateway.sh passed"
