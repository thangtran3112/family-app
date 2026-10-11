#!/usr/bin/env bash
# Smoke-tests locally loaded ai-trading images.
# Usage: ai-trading/deploy/ci/smoke-test.sh [web|ta-terminal|ahf-terminal|vibe-trading|mirofish-backend|mirofish|gateway|all]
# REGISTRY and TAG select the images (same defaults as docker-bake.hcl).
set -Eeuo pipefail

REGISTRY="${REGISTRY:-ghcr.io/thangtran3112/family-app}"
TAG="${TAG:-local}"
ACCESS_HEADER="Cf-Access-Authenticated-User-Email: smoke@example.test"
VIBE_OPENAI_ENV=(-e LANGCHAIN_PROVIDER=openai -e LANGCHAIN_MODEL_NAME=gpt-5.5
  -e OPENAI_BASE_URL=https://api.openai.com/v1 -e OPENAI_API_KEY=sk-smoke-openai-dummy
  -e LANGCHAIN_REASONING_EFFORT=none
  -e VIBE_TRADING_DESKTOP_SECURE_CREDENTIALS=1)
containers=()

cleanup() {
  if ((${#containers[@]})); then
    docker rm -fv "${containers[@]}" >/dev/null 2>&1 || true
  fi
  docker network rm smoke-gateway-net smoke-research-net >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

image() { echo "${REGISTRY}/ai-trading-$1:${TAG}"; }

# start NAME IMAGE HOST_PORT CONTAINER_PORT [extra docker run arguments...]
start() {
  local name="$1" img="$2" host_port="$3" container_port="$4"
  shift 4
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" -p "127.0.0.1:${host_port}:${container_port}" "$@" "$img" >/dev/null
  containers+=("$name")
}

# expect_status CODE URL [curl arguments...]; retries for WAIT_SECONDS (default 60).
expect_status() {
  local want="$1" url="$2" got=""
  shift 2
  local deadline=$((SECONDS + ${WAIT_SECONDS:-60}))
  while ((SECONDS < deadline)); do
    got="$(curl -s --connect-timeout 5 --max-time 10 -o /dev/null -w '%{http_code}' "$@" "$url" || true)"
    if [[ "$got" == "$want" ]]; then
      echo "ok   $want $url"
      return 0
    fi
    sleep 2
  done
  fail "expected $want from $url, got ${got:-no response}"
}

# expect_body TEXT URL: the page must contain TEXT.
expect_body() {
  curl -fsS --connect-timeout 5 --max-time 10 "$2" | grep -qF "$1" || fail "$2 does not contain $1"
  echo "ok   $2 contains $1"
}

# tmux runs a multi-argument command without the shell, and the config loads.
tmux_probe() {
  docker run --rm --entrypoint sh "$1" -c '
    set -e
    tmux -f /etc/ai-trading/tmux.conf new-session -d -s probe env sleep 30
    sleep 1
    tmux has-session -t probe
    test "$(tmux show-options -gv status)" = off' || fail "tmux probe failed for $1"
  echo "ok   tmux probe $1"
}

smoke_web() {
  start smoke-web "$(image web)" 13000 3000
  expect_status 200 http://127.0.0.1:13000/
  expect_status 200 http://127.0.0.1:13000/apps/tradingagents
  expect_status 200 http://127.0.0.1:13000/apps/ai-hedge-fund
  expect_status 200 http://127.0.0.1:13000/apps/vibe-trading
  expect_status 404 http://127.0.0.1:13000/apps/desk
  expect_status 404 http://127.0.0.1:13000/apps/unknown
  expect_body "/u/tradingagents/" http://127.0.0.1:13000/apps/tradingagents
  expect_body "/u/ai-hedge-fund/" http://127.0.0.1:13000/apps/ai-hedge-fund
  local headers
  headers="$(curl -fsSI http://127.0.0.1:13000/)"
  grep -qi '^cache-control: no-store' <<<"$headers" || fail "expected no-store Cache-Control on /"
  grep -qi '^x-frame-options: DENY' <<<"$headers" || fail "expected X-Frame-Options on /"
}

# smoke_terminal SERVICE CLI BASE_PATH HOST_PORT
smoke_terminal() {
  local service="$1" cli="$2" base="$3" port="$4" img
  img="$(image "$service")"
  docker run --rm --entrypoint "$cli" "$img" --help >/dev/null || fail "$cli --help failed"
  echo "ok   $cli --help"
  tmux_probe "$img"
  docker run --rm --network none --entrypoint python \
    -v "$PWD/ai-trading/deploy/upstream/terminal/test-session-lifecycle.py:/checks/test-session-lifecycle.py:ro" \
    "$img" /checks/test-session-lifecycle.py || fail "terminal lifecycle failed for $service"
  start "smoke-$service" "$img" "$port" 7681
  expect_status 407 "http://127.0.0.1:${port}${base}/"
  expect_status 200 "http://127.0.0.1:${port}${base}/" -H "$ACCESS_HEADER"
  expect_status 302 "http://127.0.0.1:${port}${base}" -H "$ACCESS_HEADER"
}

smoke_vibe() {
  docker run --rm --network none --entrypoint python "${VIBE_OPENAI_ENV[@]}" \
    "$(image vibe-trading)" -c '
from langchain_openai import ChatOpenAI
from src.providers.llm import build_llm
client=build_llm()
assert isinstance(client, ChatOpenAI)
assert client.openai_api_base=="https://api.openai.com/v1"
' || fail "Vibe-Trading direct OpenAI adapter could not be constructed"
  echo "ok   Vibe-Trading constructs its direct OpenAI adapter offline"
  local rejected
  # Value: protects=fail-closed boot for a complete direct OpenAI profile;
  # fails_when=any required provider/model/key/secure-mode guard is removed;
  # why_new=existing negative cases covered only provider and endpoint; seam=none.
  for rejected in LANGCHAIN_PROVIDER=openrouter OPENAI_BASE_URL=https://openrouter.ai/api/v1 \
    LANGCHAIN_MODEL_NAME= OPENAI_API_KEY= VIBE_TRADING_DESKTOP_SECURE_CREDENTIALS=0; do
    local rejection
    if rejection="$(docker run --rm --network none --entrypoint python "${VIBE_OPENAI_ENV[@]}" \
      -e "$rejected" "$(image vibe-trading)" /usr/local/bin/start-vibe.py \
      python -c 'raise SystemExit(0)' 2>&1)"; then
      fail "Vibe startup accepted an incomplete/non-OpenAI profile override ($rejected)"
    fi
    grep -qF 'Vibe requires the direct OpenAI family-config profile' <<<"$rejection" \
      || fail "Vibe startup failed for a reason other than the provider policy ($rejected)"
  done
  echo "ok   Vibe startup refuses OpenRouter, missing model/key, and disabled secure-credentials overrides"
  # Value: protects=stale provider credentials are cleared on a volume-backed redeploy;
  # fails_when=settings upsert or stale credential clearing is removed;
  # why_new=the normal boot test starts with an empty settings volume; seam=none.
  docker run --rm --network none --entrypoint python "${VIBE_OPENAI_ENV[@]}" "$(image vibe-trading)" -c '
import os, pathlib, sys
d = pathlib.Path.home() / ".vibe-trading"
d.mkdir(parents=True, exist_ok=True)
(d / ".env").write_text(
    "LANGCHAIN_PROVIDER=openrouter\n"
    "LANGCHAIN_MODEL_NAME=deepseek/deepseek-v4-pro\n"
    "OPENROUTER_BASE_URL=https://openrouter.ai/api/v1\n"
    "OPENROUTER_API_KEY=sk-or-v1-stale-dummy-router-key\n"
    "ANTHROPIC_API_KEY=sk-ant-stale-dummy-anthropic-key\n"
    "TUSHARE_TOKEN=stale-dummy-tushare-token\n"
    "LANGCHAIN_REASONING_EFFORT=high\n"
    "LANGCHAIN_TEMPERATURE=0.9\n"
    "MAX_RETRIES=9\n"
)
check = """
import os, pathlib, stat
from src.api.helpers import _read_env_values
path = pathlib.Path.home() / ".vibe-trading" / ".env"
values = _read_env_values(path)
assert values["LANGCHAIN_PROVIDER"] == "openai"
assert values["LANGCHAIN_MODEL_NAME"] == "gpt-5.5"
assert values["OPENAI_BASE_URL"] == "https://api.openai.com/v1"
assert values["LANGCHAIN_REASONING_EFFORT"] == "none"
for name in ("OPENROUTER_BASE_URL", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "TUSHARE_TOKEN"):
    assert values.get(name, "") == "", name + " was not cleared"
assert values["LANGCHAIN_TEMPERATURE"] == "0.9"
assert values["MAX_RETRIES"] == "9"
assert stat.S_IMODE(path.stat().st_mode) == 0o600
assert os.environ["OPENAI_API_KEY"] == "sk-smoke-openai-dummy"
"""
os.execvp(sys.executable, [sys.executable, "/usr/local/bin/start-vibe.py", sys.executable, "-c", check])
' || fail "Vibe did not overwrite a stale persisted .env (old provider/keys/endpoint) while preserving unrelated settings"
  echo "ok   Vibe overwrites a stale persisted .env without wiping its unrelated settings"
  # Retain native Anthropic compatibility. Construct its actual adapter
  # with a fake key and no network; liveness alone misses absent extras.
  docker run --rm --network none --entrypoint python \
    -v "$PWD/ai-trading/packages/vibe-trading/requirements-lock.txt:/expected-base-requirements.txt:ro" \
    -e ANTHROPIC_API_KEY=sk-ant-smoke-dummy -e LANGCHAIN_PROVIDER=anthropic \
    -e LANGCHAIN_MODEL_NAME=claude-sonnet-5-5 "$(image vibe-trading)" -c '
import importlib.metadata as metadata
import re
from pathlib import Path
# Optional provider installation must not upgrade upstream hash-locked packages.
for line in Path("/expected-base-requirements.txt").read_text().splitlines():
    pin = re.match(r"^([A-Za-z0-9_.-]+)==([^ ;\\]+)", line)
    if not pin:
        continue
    name, expected = pin.groups()
    try:
        actual = metadata.version(name)
    except metadata.PackageNotFoundError:
        continue  # platform-specific packages may be absent from this image
    assert actual == expected, f"{name} changed from upstream {expected} to {actual}"
from langchain_anthropic import ChatAnthropic
from src.providers.llm import build_llm
assert isinstance(build_llm(), ChatAnthropic)
' || fail "Vibe-Trading native Anthropic adapter could not be constructed"
  echo "ok   Vibe-Trading constructs its native Anthropic adapter offline"
  local url=http://127.0.0.1:18899/auth/sse-ticket
  local site=(-X POST -H "Origin: https://vibe.example.test" -H "Host: vibe.example.test")
  start smoke-vibe "$(image vibe-trading)" 18899 8899 \
    -e API_AUTH_KEY=smoke-key -e "FORWARDED_ALLOW_IPS=*" \
    "${VIBE_OPENAI_ENV[@]}" \
    --read-only --tmpfs /tmp --tmpfs /home/vibe/.cache --tmpfs /home/vibe/.config \
    -v /app/agent/runs -v /app/agent/sessions -v /app/agent/uploads -v /app/agent/.swarm/runs -v /home/vibe/.vibe-trading \
    --cap-drop ALL --cap-add SETUID --cap-add SETGID --security-opt no-new-privileges:true
  WAIT_SECONDS=240 expect_status 200 http://127.0.0.1:18899/live
  curl -fsS -H 'Authorization: Bearer smoke-key' http://127.0.0.1:18899/settings/llm | python3 -c '
import json,sys
settings=json.load(sys.stdin)
assert settings["provider"]=="openai", "Settings fell back to the upstream example provider"
assert settings["model_name"]=="gpt-5.5"
assert settings["base_url"]=="https://api.openai.com/v1"
assert settings["api_key_configured"] is True
assert settings["reasoning_effort"]=="none"
assert "sk-smoke-openai-dummy" not in json.dumps(settings)
' || fail "Vibe settings do not reflect the injected OpenAI configuration"
  docker exec smoke-vibe python -c '
import pathlib,stat
path=pathlib.Path.home()/".vibe-trading"/".env"
assert stat.S_IMODE(path.stat().st_mode)==0o600
assert "sk-smoke-openai-dummy" not in path.read_text(), "Provider key was copied into settings"
' || fail "Vibe settings must be private and contain no copied provider key"
  echo "ok   Vibe settings match direct OpenAI without copying/exposing its key"
  # Behind the TLS tunnel: its own UI's POST is accepted ...
  expect_status 200 "$url" "${site[@]}" -H "Authorization: Bearer smoke-key" -H "X-Forwarded-Proto: https"
  # ... without the forwarded scheme the same-site check rejects it ...
  expect_status 403 "$url" "${site[@]}" -H "Authorization: Bearer smoke-key"
  # ... a cross-site Origin is rejected even with the forwarded scheme and the right key ...
  expect_status 403 "$url" -X POST -H "Origin: https://evil.example.test" -H "Host: vibe.example.test" \
    -H "Authorization: Bearer smoke-key" -H "X-Forwarded-Proto: https"
  # ... and a wrong key is refused.
  expect_status 401 "$url" "${site[@]}" -H "Authorization: Bearer wrong-key" -H "X-Forwarded-Proto: https"
}

# smoke_mirofish_backend: dummy, non-secret keys only, no real Zep/LLM call.
# This never signals "the simulation engine works" (Review Focus #1).
smoke_mirofish_backend() {
  start smoke-mirofish-backend "$(image mirofish-backend)" 15001 5001 \
    -e LLM_API_KEY=sk-smoke-dummy -e ZEP_API_KEY=z_smoke-dummy
  expect_status 200 http://127.0.0.1:15001/health
  expect_body '"status":"ok"' http://127.0.0.1:15001/health
  expect_body '"service":"MiroFish Backend"' http://127.0.0.1:15001/health
}

# smoke_mirofish_frontend: the real `docker buildx bake mirofish-frontend`
# export output (ai-trading/frontend-artifacts/mirofish), not a container.
# Checks the static Vue build is present, content-hashed, and built with a
# real VITE_API_BASE_URL (no leftover localhost:5001 dev default).
smoke_mirofish_frontend() {
  local dir="ai-trading/frontend-artifacts/mirofish"
  [[ -f "$dir/index.html" ]] || fail "$dir/index.html missing -- run docker buildx bake mirofish-frontend first"
  grep -qE 'assets/index-[A-Za-z0-9_-]+\.js' "$dir/index.html" || fail "$dir/index.html does not reference a content-hashed assets/index-*.js bundle"
  compgen -G "$dir/assets/index-*.js" >/dev/null || fail "$dir/assets has no hashed index-*.js bundle"
  if grep -qF "localhost:5001" -r "$dir"; then
    fail "mirofish static build still references localhost:5001"
  fi
  echo "ok   mirofish static build has no localhost:5001 reference"
}

# sign_smoke_cookie KEY_HEX EMAIL EXP_OFFSET_SECONDS: signs a cookie value
# with the same HMAC scheme as ai-trading/auth/src/session.js, using only
# Node (already a dependency of this script's own checks elsewhere), so this
# test needs no extra tooling beyond Docker.
sign_smoke_cookie() {
  docker run --rm node:24-alpine node -e '
const { createHmac } = require("node:crypto");
const key = Buffer.from(process.argv[1], "hex");
const payload = JSON.stringify({ email: process.argv[2], exp: Math.floor(Date.now() / 1000) + Number(process.argv[3]) });
const body = Buffer.from(payload).toString("base64url");
const mac = createHmac("sha256", key).update(body).digest("base64url");
process.stdout.write(`__ai_trading_session=${body}.${mac}`);
' "$1" "$2" "$3"
}

smoke_gateway() {
  # Two networks, modeling production (review round 1, Critical): ta-research
  # is never a peer of ta-terminal. "$net" stands for the shared `ta`/`ahf`/
  # `vibe`/`gateway` networks (the legacy terminal and its gateway both sit
  # on it, same as today); "$net_research" stands for production's dedicated
  # `research` network, reusing its exact subnet so ta-research's own
  # FORWARDED_ALLOW_IPS can be tested unchanged from docker-compose.yml.
  # Only smoke-caddy joins both -- it is the one real gateway peer.
  local net="smoke-gateway-net" net_research="smoke-research-net" research_subnet="172.30.90.0/29" key
  docker network rm "$net" "$net_research" >/dev/null 2>&1 || true
  docker network create "$net" >/dev/null
  docker network create --subnet "$research_subnet" "$net_research" >/dev/null
  key="$(printf 'a%.0s' {1..64})"

  docker run -d --name smoke-auth --network "$net" --network-alias auth \
    -e SESSION_SIGNING_KEY="$key" -e ALLOWED_EMAILS=smoke@example.test \
    -e ALLOWED_ORIGINS=https://trading.example.test \
    "$(image auth)" >/dev/null
  containers+=(smoke-auth)

  # Header-echo stand-in for ta-terminal: returns whatever it received as
  # Cf-Access-Authenticated-User-Email, so the test can prove Caddy replaced
  # a forged value before any upstream ever saw it. No WebSocket code here --
  # this container is swapped for a real ttyd image below for that check.
  docker run -d --name smoke-echo-upstream --network "$net" --network-alias ta-terminal \
    python:3.12-alpine python3 -c '
import http.server
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = self.headers.get("Cf-Access-Authenticated-User-Email", "none").encode()
        self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers()
        self.wfile.write(body)
http.server.HTTPServer(("0.0.0.0", 7681), H).serve_forever()
' >/dev/null
  containers+=(smoke-echo-upstream)

  # Real ta-research service (06), not a stand-in: identity/prefix/CORS
  # enforcement and the private/share/revoke/download contract below all run
  # against the real ta_web.app, reached through real Caddy + real auth. On
  # "$net_research" ONLY -- never "$net" (where ta-terminal lives) -- with
  # the same FORWARDED_ALLOW_IPS/subnet docker-compose.yml trusts in
  # production. Published on its own port too, for the direct (no-Caddy)
  # "local HTTP port" shape check further down and the readiness wait below
  # (host port publishing bypasses both docker networks entirely, so it does
  # not weaken the isolation this test exists to prove). Fixtures are seeded
  # with ta_web's own Store/reports modules inside this same container (real,
  # non-mocked persistence/export code) -- never a real research run, which
  # would need a real provider key and a live model call.
  docker run -d --name smoke-ta-research --network "$net_research" --network-alias ta-research \
    -e "FORWARDED_ALLOW_IPS=$research_subnet" \
    -p 127.0.0.1:18182:8182 "$(image ta-research)" >/dev/null
  containers+=(smoke-ta-research)
  WAIT_SECONDS=30 expect_status 200 http://127.0.0.1:18182/__healthz

  # Network-bypass regression (review round 1, Critical): a peer that only
  # shares ta-terminal's own network must be unable to reach ta-research AT
  # ALL, by raw IP -- not merely lacking its DNS alias. smoke-echo-upstream
  # (the ta-terminal stand-in, "$net" only) tries ta-research's real IP on
  # "$net_research" directly, with a forged identity header; a successful
  # connection here would be exactly the bypass the review found.
  local research_ip bypass_result
  research_ip="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$net_research\").IPAddress}}" smoke-ta-research)"
  [[ -n "$research_ip" ]] || fail "could not determine smoke-ta-research's $net_research IP"
  bypass_result="$(docker exec smoke-echo-upstream python3 -c "
import socket
import urllib.error
import urllib.request

req = urllib.request.Request(
    'http://$research_ip:8182/api/research',
    headers={'Cf-Access-Authenticated-User-Email': 'attacker@evil.com'},
)
try:
    urllib.request.urlopen(req, timeout=3)
    print('REACHED')
except (urllib.error.URLError, OSError, socket.timeout):
    print('UNREACHABLE')
" 2>/dev/null)"
  [[ "$bypass_result" == "UNREACHABLE" ]] \
    || fail "a legacy-network peer (same network as ta-terminal) must not be able to reach ta-research at all by IP -- got: $bypass_result"
  echo "ok   a legacy ta-network peer (same network as ta-terminal) cannot reach ta-research's IP at all -- real network isolation, not just a missing DNS alias"

  # smoke-caddy is the one real peer that bridges both networks, same as the
  # production gateway service (docker-compose.yml networks: [..., research]).
  docker run -d --name smoke-caddy --network "$net" -p 127.0.0.1:18080:8080 \
    -e VIBE_API_AUTH_KEY=smoke-key \
    -v "$PWD/ai-trading/deploy/production/Caddyfile:/etc/caddy/Caddyfile:ro" \
    caddy:2-alpine >/dev/null
  containers+=(smoke-caddy)
  docker network connect "$net_research" smoke-caddy
  docker restart smoke-caddy >/dev/null
  sleep 1

  local cookie expired_cookie body
  cookie="$(sign_smoke_cookie "$key" smoke@example.test 3600)"
  expired_cookie="$(sign_smoke_cookie "$key" smoke@example.test -10)"

  expect_status 401 http://127.0.0.1:18080/u/tradingagents/
  # Vibe's dedicated hostname must cross this same Clerk/Caddy gate, not
  # reach its upstream API directly through the tunnel.
  expect_status 401 http://127.0.0.1:18080/live -H 'Host: vibe-trading.tobytran.dev'
  expect_status 403 http://127.0.0.1:18080/__auth/session \
    -X POST -H 'Origin: https://evil.example.test' -H 'Content-Type: application/json' -d '{}'
  expect_status 403 http://127.0.0.1:18080/__auth/logout \
    -X POST -H 'Origin: https://evil.example.test' --cookie "$cookie"
  expect_status 405 http://127.0.0.1:18080/__auth/logout
  expect_status 204 http://127.0.0.1:18080/__auth/logout \
    -X POST -H 'Origin: https://trading.example.test' --cookie "$cookie"
  local logout_headers
  logout_headers="$(curl -s -D - -o /dev/null --cookie "$cookie" \
    -X POST -H 'Origin: https://trading.example.test' http://127.0.0.1:18080/__auth/logout)"
  grep -qi '^set-cookie: __ai_trading_session=; .*Max-Age=0' <<<"$logout_headers" || fail "Caddy did not forward the trading cookie deletion"
  echo "ok   Caddy forwards Origin-checked gateway cookie logout"
  expect_status 401 http://127.0.0.1:18080/u/tradingagents/ --cookie "$expired_cookie"

  body="$(curl -s --cookie "$cookie" -H 'Cf-Access-Authenticated-User-Email: attacker@evil.com' \
    http://127.0.0.1:18080/u/tradingagents/)"
  [[ "$body" == "smoke@example.test" ]] || fail "expected the upstream to see the verified email, got: $body"
  echo "ok   Caddy replaced a spoofed Cf-Access-Authenticated-User-Email header with the verified one"

  # Terminal hostnames (01l): same gate, `/` rewritten onto ttyd's base path,
  # signed-out navigations sent to the hub login, everything else 401.
  local ta_host=(-H 'Host: tradingagents.tobytran.dev')
  local nav
  nav="$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "${ta_host[@]}" -H 'Sec-Fetch-Mode: navigate' http://127.0.0.1:18080/)"
  [[ "$nav" == "302 https://trading-hub.tobytran.dev/login?returnTo=https%3A%2F%2Ftradingagents.tobytran.dev%2F" ]] \
    || fail "signed-out navigation on the terminal hostname should redirect to the hub login, got: $nav"
  echo "ok   signed-out navigation on a terminal hostname redirects to the hub login"
  expect_status 401 http://127.0.0.1:18080/token "${ta_host[@]}"
  expect_status 401 http://127.0.0.1:18080/u/tradingagents/ "${ta_host[@]}"
  expect_status 401 http://127.0.0.1:18080/ "${ta_host[@]}" --cookie "$expired_cookie" -H 'Sec-Fetch-Mode: websocket'
  body="$(curl -s --cookie "$cookie" -H 'Cf-Access-Authenticated-User-Email: attacker@evil.com' "${ta_host[@]}" http://127.0.0.1:18080/)"
  [[ "$body" == "smoke@example.test" ]] || fail "terminal hostname: expected the verified email upstream, got: $body"
  echo "ok   terminal hostname replaces a spoofed identity header with the verified one"
  expect_status 401 http://127.0.0.1:18080/token -H 'Host: ai-hedge-fund.tobytran.dev'

  # Research (06) routing/prefix/identity contract, both at the dedicated
  # TradingAgents host and the hub's /u/tradingagents prefix, against the
  # real ta-research service started above.
  body="$(curl -s --cookie "$cookie" -H 'Cf-Access-Authenticated-User-Email: attacker@evil.com' "${ta_host[@]}" http://127.0.0.1:18080/research)"
  [[ "$body" == *'data-app-prefix=""'* ]] || fail "dedicated host /research: expected the real shell with an empty trusted prefix -- got: $body"
  echo "ok   dedicated host /research: real service renders the shell with an empty prefix (forged identity header replaced before reaching it)"
  expect_status 401 http://127.0.0.1:18080/research "${ta_host[@]}" --cookie "$expired_cookie"
  # Exact path list, not a bare prefix wildcard: an unrelated sibling like
  # /researchevil must still fall through to the terminal's own catch-all
  # (echoing the plain identity string -- the real ta-research app would
  # 404 any unmatched path, but never even see this request), same
  # anti-sibling-wildcard reasoning as @tradingagents/@aihedgefund.
  body="$(curl -s --cookie "$cookie" -H 'Cf-Access-Authenticated-User-Email: attacker@evil.com' "${ta_host[@]}" http://127.0.0.1:18080/researchevil)"
  [[ "$body" == "smoke@example.test" ]] || fail "dedicated host /researchevil should fall through to the terminal, not ta-research -- got: $body"
  echo "ok   dedicated host /researchevil is not swallowed by the /research matcher"

  body="$(curl -s --cookie "$cookie" -H 'Cf-Access-Authenticated-User-Email: attacker@evil.com' http://127.0.0.1:18080/u/tradingagents/research)"
  [[ "$body" == *'data-app-prefix="/u/tradingagents"'* ]] || fail "hub /u/tradingagents/research: expected the real shell with the hub prefix -- got: $body"
  echo "ok   hub /u/tradingagents/research: real service renders the shell with the hub-overwritten prefix"
  body="$(curl -s --cookie "$cookie" -H 'Cf-Access-Authenticated-User-Email: attacker@evil.com' http://127.0.0.1:18080/u/tradingagents/researchevil)"
  [[ "$body" == "smoke@example.test" ]] || fail "hub /u/tradingagents/researchevil should fall through to the terminal, not ta-research -- got: $body"
  echo "ok   hub /u/tradingagents/researchevil is not swallowed by the /research matcher"
  expect_status 401 http://127.0.0.1:18080/u/tradingagents/api/research

  # Private/shared-read, nonowner-mutation, revoke, and real attachment-byte
  # checks: seed one real completed+published run (ta_web.store/ta_web.reports,
  # no model call) inside the running container, then exercise it only
  # through real Caddy + real auth with two distinct synthetic identities.
  local owner_a="research-owner@example.test" owner_b="research-reader@example.test"
  local run_id
  run_id="$(docker exec smoke-ta-research python3 -c '
from datetime import UTC, datetime
from pathlib import Path
from ta_web.domain import Inputs, owner_key
from ta_web.reports import publish
from ta_web.store import Store

store = Store(Path.home() / ".tradingagents")
owner = owner_key("research-owner@example.test")
today = datetime.now(UTC).date().isoformat()
inputs = Inputs(ticker="SPY", analysis_date=today, asset_type="stock", analysts=["market"], research_depth=1)
run = store.create(owner, inputs)
store.update(
    run["id"],
    status="completed",
    state={
        "trade_date": today,
        "market_report": "<script>window.bad=1</script> safe market smoke text",
        "final_trade_decision": "Buy",
    },
)
publish(store, run["id"])
print(run["id"])
')"
  [[ -n "$run_id" ]] || fail "failed to seed a real completed research run inside smoke-ta-research"
  echo "ok   seeded a real completed+published research run via ta_web.store/ta_web.reports (no model call)"

  # Every hub-prefix call below sends the real production Host so the
  # Origin checks below ("https://trading-hub.tobytran.dev") actually match
  # what Caddy forwards (header_up Host {host}) -- without this, Caddy would
  # forward the test's own default Host (127.0.0.1:18080) and every one of
  # these same-origin POSTs would wrongly look cross-site.
  local hub_host=(-H 'Host: trading-hub.tobytran.dev')
  local owner_a_key owner_a_cookie owner_b_cookie hub="http://127.0.0.1:18080/u/tradingagents"
  owner_a_key="$(python3 -c "import hashlib; print(hashlib.sha256('$owner_a'.strip().lower().encode()).hexdigest())")"
  owner_a_cookie="$(sign_smoke_cookie "$key" "$owner_a" 3600)"
  owner_b_cookie="$(sign_smoke_cookie "$key" "$owner_b" 3600)"

  body="$(curl -s --cookie "$owner_a_cookie" -H 'Cf-Access-Authenticated-User-Email: attacker@evil.com' "${hub_host[@]}" "$hub/api/research")"
  python3 -c "
import json
d = json.loads('''$body''')
assert d['owner_id'] == '$owner_a_key', d
assert any(i['id'] == '$run_id' for i in d['items']), d
" || fail "hub research list: expected the verified owner's id and the seeded private run -- got: $body"
  echo "ok   hub research list: the real, verified (not forged) identity owns the seeded private run"

  body="$(curl -s --cookie "$owner_b_cookie" "${hub_host[@]}" "$hub/api/research")"
  python3 -c "
import json
d = json.loads('''$body''')
assert not any(i['id'] == '$run_id' for i in d['items']), d
" || fail "hub research list: a private run must not appear in a different owner's list -- got: $body"
  expect_status 404 "$hub/api/research/$run_id" "${hub_host[@]}" --cookie "$owner_b_cookie"
  expect_status 404 "$hub/api/research/$run_id/download?format=md" "${hub_host[@]}" --cookie "$owner_b_cookie"
  echo "ok   hub: a private run is invisible (list, detail, download) to a non-owner"
  expect_status 200 "$hub/api/research/$run_id" "${hub_host[@]}" --cookie "$owner_a_cookie"

  # Nonowner mutation denied: a reader can never flip this run's own sharing
  # flag, even with a validly-authenticated, correctly-Origin'd request (a
  # same-origin Origin is required here too -- the Guard's Origin check
  # runs before the route handler's own ownership check either way).
  expect_status 404 "$hub/api/research/$run_id/sharing" "${hub_host[@]}" --cookie "$owner_b_cookie" \
    -X POST -H 'Origin: https://trading-hub.tobytran.dev' -H 'Content-Type: application/json' -d '{"enabled":true}'
  echo "ok   hub: nonowner sharing mutation denied (404, same as nonexistent -- never reveals existence)"

  # CORS/Origin on the real API's own owner POST: missing/cross-site Origin
  # denied, same-origin (matching the forwarded Host) accepted.
  expect_status 403 "$hub/api/research/$run_id/sharing" "${hub_host[@]}" --cookie "$owner_a_cookie" \
    -X POST -H 'Content-Type: application/json' -d '{"enabled":true}'
  expect_status 403 "$hub/api/research/$run_id/sharing" "${hub_host[@]}" --cookie "$owner_a_cookie" \
    -X POST -H 'Origin: https://evil.example.test' -H 'Content-Type: application/json' -d '{"enabled":true}'
  expect_status 200 "$hub/api/research/$run_id/sharing" "${hub_host[@]}" --cookie "$owner_a_cookie" \
    -X POST -H 'Origin: https://trading-hub.tobytran.dev' -H 'Content-Type: application/json' -d '{"enabled":true}'
  echo "ok   hub: owner's sharing POST requires a same-origin Origin (https, matching the forwarded Host)"

  expect_status 200 "$hub/api/research/$run_id" "${hub_host[@]}" --cookie "$owner_b_cookie"
  echo "ok   hub: an explicitly shared run becomes visible to a non-owner read"

  body="$(curl -s --cookie "$owner_b_cookie" "${hub_host[@]}" "$hub/api/research/$run_id/download?format=md")"
  [[ "$body" == *"safe market smoke text"* ]] || fail "shared md download: expected the real published report text -- got: $body"
  local dl_headers
  dl_headers="$(curl -s -D - -o /dev/null --cookie "$owner_b_cookie" "${hub_host[@]}" "$hub/api/research/$run_id/download?format=md")"
  grep -qi '^content-type: text/markdown' <<<"$dl_headers" || fail "md download: wrong content-type -- $dl_headers"
  grep -qiF "content-disposition: attachment; filename=\"$run_id" <<<"$dl_headers" || fail "md download: wrong content-disposition -- $dl_headers"
  echo "ok   shared md download: real report bytes, text/markdown content-type, attachment disposition"

  body="$(curl -s --cookie "$owner_b_cookie" "${hub_host[@]}" "$hub/api/research/$run_id/download?format=html")"
  [[ "$body" != *"<script>"* ]] || fail "html download still contains a raw <script> tag"
  dl_headers="$(curl -s -D - -o /dev/null --cookie "$owner_b_cookie" "${hub_host[@]}" "$hub/api/research/$run_id/download?format=html")"
  grep -qi '^content-type: text/html' <<<"$dl_headers" || fail "html download: wrong content-type -- $dl_headers"
  echo "ok   shared html download: hostile report input is not rendered as a raw <script> tag"

  local zip_path="$PWD/ai-trading/temp/smoke-research-$run_id.zip"
  mkdir -p "$(dirname "$zip_path")"
  curl -s --cookie "$owner_b_cookie" "${hub_host[@]}" -o "$zip_path" "$hub/api/research/$run_id/download?format=zip"
  dl_headers="$(curl -s -D - -o /dev/null --cookie "$owner_b_cookie" "${hub_host[@]}" "$hub/api/research/$run_id/download?format=zip")"
  grep -qi '^content-type: application/zip' <<<"$dl_headers" || fail "zip download: wrong content-type -- $dl_headers"
  python3 -c "
import zipfile
with zipfile.ZipFile('$zip_path') as z:
    assert 'complete_report.md' in z.namelist(), z.namelist()
" || fail "zip download: missing complete_report.md"
  rm -f "$zip_path"
  echo "ok   shared zip download: real archive, application/zip content-type, contains complete_report.md"

  expect_status 200 "$hub/api/research/$run_id/sharing" "${hub_host[@]}" --cookie "$owner_a_cookie" \
    -X POST -H 'Origin: https://trading-hub.tobytran.dev' -H 'Content-Type: application/json' -d '{"enabled":false}'
  expect_status 404 "$hub/api/research/$run_id" "${hub_host[@]}" --cookie "$owner_b_cookie"
  expect_status 404 "$hub/api/research/$run_id/download?format=md" "${hub_host[@]}" --cookie "$owner_b_cookie"
  echo "ok   hub: revoke makes every fresh non-owner read (detail + download) 404 again"

  # Dedicated host: the same Origin check is bound to ITS OWN host, not the
  # hub's -- a hub-Origin'd POST here is cross-site and must still be denied.
  expect_status 403 "http://127.0.0.1:18080/api/research/$run_id/sharing" "${ta_host[@]}" --cookie "$owner_a_cookie" \
    -X POST -H 'Origin: https://trading-hub.tobytran.dev' -H 'Content-Type: application/json' -d '{"enabled":true}'
  expect_status 200 "http://127.0.0.1:18080/api/research/$run_id/sharing" "${ta_host[@]}" --cookie "$owner_a_cookie" \
    -X POST -H 'Origin: https://tradingagents.tobytran.dev' -H 'Content-Type: application/json' -d '{"enabled":true}'
  expect_status 200 "http://127.0.0.1:18080/api/research/$run_id" "${ta_host[@]}" --cookie "$owner_b_cookie"
  expect_status 200 "http://127.0.0.1:18080/api/research/$run_id/sharing" "${ta_host[@]}" --cookie "$owner_a_cookie" \
    -X POST -H 'Origin: https://tradingagents.tobytran.dev' -H 'Content-Type: application/json' -d '{"enabled":false}'
  echo "ok   dedicated host: owner's sharing POST is bound to its own Host/Origin, not the hub's"

  # "local HTTP port" shape (deploy/local/Caddyfile never forces
  # X-Forwarded-Proto, unlike production): direct to the real container,
  # bypassing Caddy, so this exercises the real Guard's own scheme fallback
  # -- not a value this test forces -- accepting a plain-http same-origin
  # POST and still rejecting a cross-origin one.
  expect_status 200 "http://127.0.0.1:18182/api/research/$run_id/sharing" \
    -H "Cf-Access-Authenticated-User-Email: $owner_a" -H 'Origin: http://127.0.0.1:18182' \
    -H 'Content-Type: application/json' -X POST -d '{"enabled":true}'
  expect_status 403 "http://127.0.0.1:18182/api/research/$run_id/sharing" \
    -H "Cf-Access-Authenticated-User-Email: $owner_a" -H 'Origin: https://evil.example.test' \
    -H 'Content-Type: application/json' -X POST -d '{"enabled":true}'
  expect_status 200 "http://127.0.0.1:18182/api/research/$run_id/sharing" \
    -H "Cf-Access-Authenticated-User-Email: $owner_a" -H 'Origin: http://127.0.0.1:18182' \
    -H 'Content-Type: application/json' -X POST -d '{"enabled":false}'
  echo "ok   local HTTP shape (no forced scheme): the real app's Origin check still requires a matching, plain-http same-origin value"

  local research_nav
  research_nav="$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' -H 'Sec-Fetch-Mode: navigate' http://127.0.0.1:18080/u/tradingagents/research)"
  [[ "$research_nav" == "302 https://trading-hub.tobytran.dev/login?returnTo=https%3A%2F%2Ftrading-hub.tobytran.dev%2Fu%2Ftradingagents%2Fresearch" ]] \
    || fail "signed-out navigation to the research root should redirect preserving the research path, got: $research_nav"
  echo "ok   signed-out navigation to the research root redirects to the hub login with the research path preserved"
  research_nav="$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' -H 'Sec-Fetch-Mode: navigate' \
    'http://127.0.0.1:18080/u/tradingagents/research/0b32e9ee-6e57-4b1b-9f0a-6c2a8c8d9b11?evil=%3Cscript%3E')"
  # The captured "/<id>" is inserted verbatim (Caddy does not re-encode
  # placeholder substitutions), so this one slash is literal rather than
  # %2F-encoded like the rest of the static returnTo URL -- still a valid,
  # unambiguous query value per RFC 3986 (query = *( pchar / "/" / "?" )).
  [[ "$research_nav" == "302 https://trading-hub.tobytran.dev/login?returnTo=https%3A%2F%2Ftrading-hub.tobytran.dev%2Fu%2Ftradingagents%2Fresearch/0b32e9ee-6e57-4b1b-9f0a-6c2a8c8d9b11" ]] \
    || fail "signed-out navigation to a research UUID path should redirect preserving only the UUID path, got: $research_nav"
  echo "ok   signed-out navigation to a research detail path preserves only the validated UUID path and discards the query"
  expect_status 401 http://127.0.0.1:18080/u/tradingagents/api/research -H 'Sec-Fetch-Mode: navigate'
  echo "ok   an unauthenticated research API request stays a plain 401 even with a navigate header"

  # re-review 1 (Important): the redirect must accept ONLY a canonical
  # lowercase UUID4 descendant, matching ta_web/store.py's own
  # _validate_run_id contract exactly -- not any hex/hyphen string. A
  # malformed, non-v4, or uppercase-spelled id must stay a plain 401.
  expect_status 401 http://127.0.0.1:18080/u/tradingagents/research/---- -H 'Sec-Fetch-Mode: navigate'
  expect_status 401 http://127.0.0.1:18080/u/tradingagents/research/0b32e9ee-6e57-1b1b-9f0a-6c2a8c8d9b11 -H 'Sec-Fetch-Mode: navigate'
  expect_status 401 http://127.0.0.1:18080/u/tradingagents/research/0B32E9EE-6E57-4B1B-9F0A-6C2A8C8D9B11 -H 'Sec-Fetch-Mode: navigate'
  echo "ok   hub: a malformed, non-v4, or uppercase-spelled research id never triggers the redirect (stays 401)"
  expect_status 401 http://127.0.0.1:18080/u/tradingagents/research/assets/app.mjs -H 'Sec-Fetch-Mode: navigate'
  echo "ok   hub: a research asset path is never redirected, even with a navigate header (stays 401)"

  # Review round 1 (Important): the dedicated host needs the identical
  # root/UUID-only redirect, not a plain 401 -- it previously had no
  # handle_response branch on this route at all.
  research_nav="$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "${ta_host[@]}" -H 'Sec-Fetch-Mode: navigate' http://127.0.0.1:18080/research)"
  [[ "$research_nav" == "302 https://trading-hub.tobytran.dev/login?returnTo=https%3A%2F%2Ftradingagents.tobytran.dev%2Fresearch" ]] \
    || fail "dedicated host: signed-out navigation to the research root should redirect preserving the research path, got: $research_nav"
  echo "ok   dedicated host: signed-out navigation to the research root redirects to the hub login with the research path preserved"
  research_nav="$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "${ta_host[@]}" -H 'Sec-Fetch-Mode: navigate' \
    'http://127.0.0.1:18080/research/0b32e9ee-6e57-4b1b-9f0a-6c2a8c8d9b11?evil=%3Cscript%3E')"
  [[ "$research_nav" == "302 https://trading-hub.tobytran.dev/login?returnTo=https%3A%2F%2Ftradingagents.tobytran.dev%2Fresearch/0b32e9ee-6e57-4b1b-9f0a-6c2a8c8d9b11" ]] \
    || fail "dedicated host: signed-out navigation to a research UUID path should redirect preserving only the UUID path, got: $research_nav"
  echo "ok   dedicated host: signed-out navigation to a research detail path preserves only the validated UUID path and discards the query"
  expect_status 401 http://127.0.0.1:18080/api/research "${ta_host[@]}" -H 'Sec-Fetch-Mode: navigate'
  echo "ok   dedicated host: an unauthenticated research API request stays a plain 401 even with a navigate header"

  # re-review 1 (Important): same canonical-UUID4-only restriction and
  # asset-401 coverage as the hub, at the dedicated host (its matcher was
  # fixed together with the hub's, for one consistent redirect contract).
  expect_status 401 http://127.0.0.1:18080/research/---- "${ta_host[@]}" -H 'Sec-Fetch-Mode: navigate'
  expect_status 401 http://127.0.0.1:18080/research/0b32e9ee-6e57-1b1b-9f0a-6c2a8c8d9b11 "${ta_host[@]}" -H 'Sec-Fetch-Mode: navigate'
  expect_status 401 http://127.0.0.1:18080/research/0B32E9EE-6E57-4B1B-9F0A-6C2A8C8D9B11 "${ta_host[@]}" -H 'Sec-Fetch-Mode: navigate'
  echo "ok   dedicated host: a malformed, non-v4, or uppercase-spelled research id never triggers the redirect (stays 401)"
  expect_status 401 http://127.0.0.1:18080/research/assets/app.mjs "${ta_host[@]}" -H 'Sec-Fetch-Mode: navigate'
  echo "ok   dedicated host: a research asset path is never redirected, even with a navigate header (stays 401 -- required dedicated APIs/assets coverage)"

  # Swap the header-echo stand-in for a real ttyd to prove the WebSocket
  # handshake actually reaches a real upstream through forward_auth + reverse_proxy.
  # "smoke-ta-terminal" also names smoke_terminal's own container (started
  # before smoke_gateway in the "all" dispatch order and still running for
  # its own trap cleanup) -- rm -f it here too, same idempotent-start guard
  # used throughout this script, so the name is free to reuse.
  docker rm -f smoke-echo-upstream smoke-ta-terminal >/dev/null 2>&1 || true
  docker run -d --name smoke-ta-terminal --network "$net" --network-alias ta-terminal "$(image ta-terminal)" >/dev/null
  containers+=(smoke-ta-terminal)
  docker restart smoke-caddy >/dev/null
  sleep 2

  local ws_status
  ws_status="$(curl -s -o /dev/null -w '%{http_code}' --cookie "$cookie" \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
    http://127.0.0.1:18080/u/tradingagents/)"
  [[ "$ws_status" == "101" ]] || fail "expected 101 Switching Protocols through Caddy to a real ttyd, got $ws_status"
  echo "ok   WebSocket handshake reaches a real ttyd through Caddy with a valid cookie"
  ws_status="$(curl -s -o /dev/null -w '%{http_code}' --cookie "$cookie" -H 'Host: tradingagents.tobytran.dev' \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
    -H 'Origin: http://tradingagents.tobytran.dev' \
    http://127.0.0.1:18080/ws)"
  [[ "$ws_status" == "101" ]] || fail "expected 101 from a real ttyd at /ws on the terminal hostname, got $ws_status"
  echo "ok   WebSocket handshake reaches a real ttyd at /ws on the terminal hostname"

  docker run -d --name smoke-vibe-gateway --network "$net" --network-alias vibe-trading \
    -e API_AUTH_KEY=smoke-key -e 'FORWARDED_ALLOW_IPS=*' \
    "${VIBE_OPENAI_ENV[@]}" \
    --read-only --tmpfs /tmp --tmpfs /home/vibe/.cache --tmpfs /home/vibe/.config \
    -v /app/agent/runs -v /app/agent/sessions -v /app/agent/uploads -v /app/agent/.swarm/runs -v /home/vibe/.vibe-trading \
    --cap-drop ALL --cap-add SETUID --cap-add SETGID --security-opt no-new-privileges:true \
    "$(image vibe-trading)" >/dev/null
  containers+=(smoke-vibe-gateway)
  local vibe_host=(-H 'Host: vibe-trading.tobytran.dev')
  WAIT_SECONDS=240 expect_status 200 http://127.0.0.1:18080/live "${vibe_host[@]}" --cookie "$cookie"
  expect_status 401 http://127.0.0.1:18080/live "${vibe_host[@]}" --cookie "$expired_cookie"
  expect_status 401 http://127.0.0.1:18080/live "${vibe_host[@]}" -H 'Cf-Access-Authenticated-User-Email: forged'
  # Caddy supplies Vibe's API key after the Clerk check: no browser key needed,
  # and a wrong browser-sent key is replaced rather than forwarded.
  expect_status 200 http://127.0.0.1:18080/api/connections "${vibe_host[@]}" --cookie "$cookie"
  expect_status 200 http://127.0.0.1:18080/api/connections "${vibe_host[@]}" --cookie "$cookie" \
    -H 'Authorization: Bearer wrong-key'
  expect_status 200 http://127.0.0.1:18080/auth/sse-ticket "${vibe_host[@]}" --cookie "$cookie" \
    -X POST -H 'Origin: https://vibe-trading.tobytran.dev'
  expect_status 401 http://127.0.0.1:18080/api/connections "${vibe_host[@]}" \
    -H 'Authorization: Bearer smoke-key'
  docker rm -f smoke-vibe-gateway >/dev/null

  docker network rm "$net" >/dev/null 2>&1 || true
}

smoke_market_data() {
  local net="smoke-md-net"
  docker network rm "$net" >/dev/null 2>&1 || true
  docker network create "$net" >/dev/null
  docker run -d --name smoke-market-data --network "$net" --network-alias market-data \
    -e MARKET_DATA_TOKEN=smoke-token "$(image market-data)" >/dev/null
  containers+=(smoke-market-data)
  # Real upstream FDClient, repointed by the wrapper's sitecustomize, against the
  # real service with no provider keys: earnings 501, prices 502, bad key 401.
  docker run --rm --network "$net" -e FD_BASE_URL=http://market-data:8000 -e FINANCIAL_DATASETS_API_KEY=smoke-token \
    --entrypoint python "$(image ahf-terminal)" -c '
import time, urllib.request
for _ in range(30):
    try:
        urllib.request.urlopen("http://market-data:8000/healthz", timeout=2); break
    except Exception:
        time.sleep(1)
from hedge_fund.data import FDClient, FDClientError
assert FDClient.BASE_URL == "http://market-data:8000", FDClient.BASE_URL
def status(call):
    try:
        call(); return 200
    except FDClientError as e:
        return e.status_code
fd = FDClient()
assert status(lambda: fd.get_earnings("AAPL")) == 501
assert status(lambda: fd.get_prices("AAPL", "2024-01-01", "2024-01-31")) == 502
assert status(lambda: FDClient(api_key="wrong").get_prices("AAPL", "2024-01-01", "2024-01-31")) == 401
' || fail "ai-hedge-fund FDClient against market-data"
  echo "ok   ai-hedge-fund FDClient reaches market-data: 501/502/401 contract"
  # Shape contract: our responses parse into upstream's own pydantic models
  # (server code run in-process with fake providers, inside the real ahf image).
  docker run --rm --network none -v "$PWD/ai-trading/market-data:/md:ro" -e PYTHONPATH=/md -e PYTHONDONTWRITEBYTECODE=1 \
    --entrypoint python "$(image ahf-terminal)" -c '
import threading
import server, test_metrics
from hedge_fund.data import FDClient
class P:
    def daily_bars(self, t, s, e, a):
        return [{"open": 1.0, "close": 20.0, "high": 2.0, "low": 0.5, "volume": 7, "time": "2024-04-30T04:00:00Z"}]
class F:
    def companyfacts(self, t): return test_metrics.company()
    def facts(self, t): return {"ticker": t, "name": "Example", "cik": "1", "is_active": True, "sector": "Manufacturing"}
srv = server.make_server(0, "k", P(), F())
threading.Thread(target=srv.serve_forever, daemon=True).start()
FDClient.BASE_URL = f"http://127.0.0.1:{srv.server_address[1]}"
fd = FDClient(api_key="k")
assert fd.get_prices("AAPL", "2024-04-01", "2024-04-30")[0].close == 20.0
m = fd.get_financial_metrics("AAPL", "2024-05-01", limit=2)
assert [r.report_period for r in m] == ["2024-03-31", "2023-12-31"] and m[0].market_cap == 200.0, m
assert fd.get_company_facts("AAPL").sector == "Manufacturing"
' || fail "market-data responses do not parse into upstream models"
  echo "ok   market-data prices, metrics, and facts parse into upstream models"
  docker rm -f smoke-market-data >/dev/null
  docker network rm "$net" >/dev/null 2>&1 || true
}

case "${1:-all}" in
  web) smoke_web ;;
  ta-terminal) smoke_terminal ta-terminal tradingagents /u/tradingagents 17681 ;;
  ahf-terminal) smoke_terminal ahf-terminal aihf /u/ai-hedge-fund 17682 ;;
  vibe-trading) smoke_vibe ;;
  mirofish-backend) smoke_mirofish_backend ;;
  mirofish) smoke_mirofish_backend; smoke_mirofish_frontend ;;
  gateway) smoke_gateway ;;
  market-data) smoke_market_data ;;
  all)
    smoke_web
    smoke_terminal ta-terminal tradingagents /u/tradingagents 17681
    smoke_gateway
    smoke_terminal ahf-terminal aihf /u/ai-hedge-fund 17682
    smoke_market_data
    smoke_vibe
    smoke_mirofish_backend
    smoke_mirofish_frontend
    ;;
  *)
    echo "usage: $0 [web|ta-terminal|ahf-terminal|market-data|vibe-trading|mirofish-backend|mirofish|gateway|all]" >&2
    exit 2
    ;;
esac
echo "smoke tests passed: ${1:-all}"
