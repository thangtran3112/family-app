"""Private, count-only Finnhub recommendations for Vibe's Python 3.11 gate."""

import hmac
import json
import os
import re
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, HTTPServer

import pandas as pd
import requests

from ai_trading_common.errors import NoData, NotConfigured, Unavailable
from ai_trading_common.http import ThrottledClient
from ai_trading_common.registry import DataSources

US_TICKER = re.compile(r"[A-Z]{1,5}(?:\.[A-Z])?\.US\Z")
ROUTE = re.compile(r"/v1/recommendations/([A-Z.]{1,12})\Z")
COUNT_FIELDS = ("strong_buy", "buy", "hold", "sell", "strong_sell")


class NoRedirectSession(requests.Session):
    """Do not follow an unexpected provider redirect with a query-string key."""

    def get(self, url, **kwargs):
        kwargs["allow_redirects"] = False
        return super().get(url, **kwargs)


def snapshot(symbol: str, sources: DataSources, now: datetime) -> dict:
    """Return only current, positive, source-dated US recommendation counts."""
    if not US_TICKER.fullmatch(symbol):
        raise ValueError("US ticker required")
    bare = symbol[:-3]
    try:
        value = sources.targets.analyst_targets(bare, now=pd.Timestamp(now))
    except NotConfigured:
        return {"status": "unavailable", "reason": "not_configured"}
    except NoData:
        return {"status": "unavailable", "reason": "no_data"}
    except Unavailable:
        return {"status": "unavailable", "reason": "upstream"}
    if value.provider != "finnhub" or value.symbol != bare or value.period is None:
        return {"status": "unavailable", "reason": "no_data"}
    age = (now.date() - value.period).days
    if not 0 <= age <= 45:
        return {"status": "unavailable", "reason": "stale"}
    counts = {name: getattr(value, name) for name in COUNT_FIELDS}
    if any(type(n) is not int or n < 0 for n in counts.values()) or sum(counts.values()) == 0:
        return {"status": "unavailable", "reason": "no_data"}
    return {
        "status": "ok",
        "symbol": symbol,
        "provider": "finnhub",
        "period": value.period.isoformat(),
        "retrieved_at": now.astimezone(UTC).isoformat().replace("+00:00", "Z"),
        **counts,
    }


def make_server(
    port: int,
    auth_key: str,
    sources: DataSources,
    clock=lambda: datetime.now(UTC),
    host: str = "127.0.0.1",
) -> HTTPServer:
    """Construct an internal HTTP listener; only /healthz skips auth."""
    if not auth_key:
        raise ValueError("internal auth key required")

    class Handler(BaseHTTPRequestHandler):
        def _send(self, status: int, body: dict) -> None:
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:
            if self.path == "/healthz":
                return self._send(200, {"status": "ok"})
            if not hmac.compare_digest(self.headers.get("X-API-Key", ""), auth_key):
                return self._send(401, {"status": "error", "reason": "unauthorized"})
            match = ROUTE.fullmatch(self.path)
            if match is None:
                return self._send(404, {"status": "error", "reason": "not_found"})
            try:
                body = snapshot(match.group(1), sources, clock())
            except ValueError:
                return self._send(400, {"status": "error", "reason": "bad_symbol"})
            except Exception:
                return self._send(503, {"status": "unavailable", "reason": "upstream"})
            return self._send(200 if body["status"] == "ok" else 503, body)

        def log_message(self, format, *args):
            pass  # key-bearing provider URLs and headers must never enter access logs

    # ponytail: one worker serializes requests; use a bounded pool only if contention becomes real.
    return HTTPServer((host, port), Handler)


if __name__ == "__main__":
    sources = DataSources.from_env(
        env={**os.environ, "DATA_PROVIDERS_TARGETS": "finnhub"},
        http=ThrottledClient(session=NoRedirectSession()),
    )
    make_server(8000, os.environ["VIBE_API_AUTH_KEY"], sources, host="0.0.0.0").serve_forever()
