#!/usr/bin/env bash
# Verifies the ta-research image (06): the tradingagents-web wrapper's own
# offline unittest suite actually runs inside the built image's environment
# (not just a host dev venv -- proves the hash-pinned additions and upstream
# base actually support it), and the service boots and serves /__healthz.
# REGISTRY/TAG select the image, same defaults as docker-bake.hcl and
# smoke-test.sh. Build first: docker buildx bake -f ai-trading/deploy/docker-bake.hcl ta-research --load
#
# The service-boot check depends on ta_web.app:application, which lands in a
# later reviewed task; until then this script fails there on purpose rather
# than faking a pass -- see ai-trading/tradingagents-web/DIVERGENCE.md.
set -Eeuo pipefail

REGISTRY="${REGISTRY:-ghcr.io/thangtran3112/family-app}"
TAG="${TAG:-local}"
IMAGE="${REGISTRY}/ai-trading-ta-research:${TAG}"
PORT="${TEST_TA_RESEARCH_PORT:-18182}"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

echo "== ta-research: offline unittest suite inside the built image =="
docker run --rm --network none \
  -v "$PWD/ai-trading/tradingagents-web/tests:/tests:ro" \
  -e PYTHONDONTWRITEBYTECODE=1 -e PYTHONPATH=/home/appuser/app \
  --entrypoint python3 "$IMAGE" \
  -m unittest discover -s /tests -p 'test_*.py' -v \
  || fail "tradingagents-web unittest suite failed inside $IMAGE"
echo "ok   tradingagents-web unittest suite passes inside the built image"

echo "== ta-research: service boots and serves /__healthz =="
name="test-ta-research-$$"
docker rm -f "$name" >/dev/null 2>&1 || true
cleanup() { docker rm -fv "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run -d --name "$name" -p "127.0.0.1:${PORT}:8182" "$IMAGE" >/dev/null

got=""
deadline=$((SECONDS + 30))
while ((SECONDS < deadline)); do
  got="$(curl -s --connect-timeout 2 --max-time 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/__healthz" || true)"
  [[ "$got" == "200" ]] && break
  sleep 1
done
[[ "$got" == "200" ]] || fail "expected 200 from /__healthz, got ${got:-no response} (ta_web.app:application likely not landed yet)"
echo "ok   ta-research serves 200 on /__healthz"

echo "tradingagents-research image tests passed"
