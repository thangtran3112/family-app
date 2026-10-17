#!/usr/bin/env bash
# Check the built bridge image itself, without external network or host ports.
set -euo pipefail

registry="${REGISTRY:-ghcr.io/thangtran3112/family-app}"
tag="${TAG:-local}"
docker run --rm -i --network none --read-only \
  -e VIBE_API_AUTH_KEY=fake-ci-key \
  "$registry/ai-trading-vibe-consensus:$tag" python - <<'PY'
import json
import os
import threading
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from ai_trading_common.registry import DataSources
from server import make_server

assert os.getuid() != 0
assert "FINNHUB_API_KEY" not in os.environ
sources = DataSources.from_env(env={"DATA_PROVIDERS_TARGETS": "finnhub"})
server = make_server(0, os.environ["VIBE_API_AUTH_KEY"], sources)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()


def check(path, key=None):
    headers = {"X-API-Key": key} if key else {}
    req = Request(f"http://127.0.0.1:{server.server_port}{path}", headers=headers)
    try:
        with urlopen(req, timeout=2) as response:
            return response.status, json.load(response)
    except HTTPError as error:
        return error.code, json.load(error)


try:
    assert check("/healthz") == (200, {"status": "ok"})
    assert check("/v1/recommendations/AAPL.US")[0] == 401
    assert check("/v1/recommendations/AAPL.US", "wrong")[0] == 401
    assert check("/v1/recommendations/AAPL.US", "fake-ci-key") == (
        503, {"status": "unavailable", "reason": "not_configured"}
    )
    print("vibe-consensus image: health 200, unauthorized 401, no-key 503")
finally:
    server.shutdown()
    server.server_close()
    thread.join(timeout=2)
PY
