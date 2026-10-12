# Vibe US-Stock Committee Gate and Free Consensus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give US-stock chat an own Buy/Sell verdict or SEC-derived numeric target only after a substantively approved committee review and fresh independent free consensus evidence; otherwise release analysis-only without leaking a draft.

**Architecture:** A private Python 3.12 bridge exposes Finnhub recommendation counts through `ai_trading_common.registry.DataSources` to Vibe's Python 3.11 app on the internal `vibe` network. Vibe's shared `AgentLoop` buffers answer text/reasoning tails, orchestrates a single committee for own-verdict intent, validates a typed chair disposition and source/valuation proof, then releases checked analysis and an optional server-rendered recommendation. Runtime, checkpoint, SSE, CLI and MCP share that boundary; SP5 owns restart-resilient multi-minute runs.

**Tech Stack:** Python 3.12 + `ai-trading-common`/uv (bridge); Python 3.11 + existing LangChain/OpenAI and `SwarmTool` (Vibe fork); stdlib HTTP server/Decimal, Docker Bake/Compose, Firestore `family-config`, existing pytest/Vitest/CI/smoke tooling.

**Spec:** [01r-vibe-committee-gate-design.md](01r-vibe-committee-gate-design.md), owner approved after the narrow shared-period amendment; baseline [01q results](01q-vibe-golden-eval-results.md).

## Global Constraints

- US-listed stocks only. Ordinary non-US response behavior stays unchanged. An ambiguous market or ticker gets a buffered analysis-only fallback, never an invented US identity. No broker action, paid API, Jina, OpenRouter, new vendor account or unchecked own Buy/Sell/target.
- Owner-approved, narrow shared-code exception: add optional `AnalystTargets.period: date | None` and set it in Finnhub/Eulerpool adapters, with their tests. Do not lower `ai-trading/common`'s Python `>=3.12,<3.13` floor, change provider priority, import provider modules in callers or edit other Desk code.
- `ai-trading/packages/vibe-trading` is a fork submodule: initialize it only at execution time; verify its `origin` is `thangtran3112/Vibe-Trading` and branch `family-app` before edits. Every fork commit also updates `DIVERGENCE.md`; push that fork branch before the superproject gitlink moves. Never edit the three other upstream submodules.
- Set `VIBE_VENV` to the existing upstream-CI-equivalent Python 3.11 venv outside the repository (SP3 used the approved `.../opencode/vibe-venv2`); if absent, build it with `pip install -r requirements-lock.txt` followed by `pip install -e ".[dev,openbb,stats,anthropic]"` from the fork root as `ai-trading/AGENTS.md` specifies. No environment/key file inside `ai-trading/`.
- The free Finnhub key is not configured. Missing/rejected key, source month older than 45 calendar days, absent/zero counts, wrong ticker, Yahoo cross-check unavailable, or unresolved conflict means **no own verdict or target**. A numerically valid SEC-based valuation is an additional prerequisite for an own target, not for an otherwise reviewed Buy/Sell. No key file in the repo; only `family_config.py` reads/writes Firestore. Live analysis-only is verifiable without a key; positive source path is verified with offline fakes until the owner supplies one.
- `DataSources.from_env` targets chain is explicitly Finnhub; its `period` is vendor observation month and `as_of` stays retrieval timestamp. Finnhub free tier supplies counts but **no price target**; Alpha Vantage `EARNINGS_ESTIMATES` and Finnhub price-target endpoints are premium and excluded. Yahoo targets are attributed third-party context, never an own numeric target.
- Model-produced US-stock answer text, `reasoning_delta.tail`, committee summaries and tool-result previews stay hidden until release. Tool names/status/elapsed/progress may stream after sanitizing model-generated fields. No unapproved answer reaches SSE, response checkpoint, history, CLI/MCP result or generated report link. A policy-verifier outage fails closed.
- Keep ai-trading's app groups and MiroFish state across deploys. The bridge is a Vibe group member, never public or Caddy-routed. An **optional** `ai-trading/consensus` Firestore profile contains only `FINNHUB_API_KEY` when the owner supplies a free key; unlike `ai-trading/market-data`, it is not an env file for any other app. Derive only its Finnhub value and Vibe's existing internal auth into root-only bridge env files; atomic staging/rollback includes them. No other app receives Finnhub, and no LLM or Alpaca keys reach the bridge.
- Work in the user-approved `.worktrees/vibe-committee-gate` branch; stage exact paths and merge `origin/dev` before pushing. PR to `dev` only as a finished phase; scoped release from `origin/main` includes only SP4-owned ai-trading and workflow paths, followed by deploy/live verification under standing authorization. Do not release Desk or expense paths.

## Review Focus

1. **Early target leak:** a model writes `My target is $200` before the committee returns; tests in Task 5 prove no `text_delta`, reasoning tail, swarm/tool preview, checkpoint or history contains it before release.
2. **False committee proof:** `run.json` says `completed` but chair's typed disposition says `incomplete`, a worker failed, or the run belongs to another ticker; Task 4's test keeps own output blocked.
3. **Stale free consensus:** Finnhub's `as_of` is today while vendor `period` is old; Task 1/2/4 tests require the *source* month and block a 46-day-old row without making a network request.
4. **Mixed share basis:** SEC EPS from one filing is pre-split but the current quote is post-split; Task 4's exact Decimal/identity test refuses to issue a numeric target.
5. **Concurrent/retried chat:** reconnect or a correction iteration triggers the same request twice; Task 5's test proves at most one committee run per locked ticker/attempt and no recovery of hidden draft text.
6. **Group-off deployment:** the Vibe app is disabled when a deploy stages a new bridge image/key; Task 3's transaction test proves neither service starts implicitly, while other app groups and MiroFish stay as chosen.

## File map and interfaces

| Path relative to repository root | Purpose | Task |
|---|---|---|
| `ai-trading/common/src/ai_trading_common/types.py`, `providers/{finnhub,eulerpool}.py`, targeted tests | Preserve vendor recommendation period through registry | 1 |
| `ai-trading/consensus/server.py`, `test_server.py`, `Dockerfile`, `README.md` | Private authenticated count-only bridge | 2 |
| `ai-trading/deploy/{docker-bake.hcl,docker-bake.ci.hcl}`, `deploy/production/{docker-compose.yml,deploy.sh,README.md}`, `control/catalog.json`, `deploy/ci/{test-deploy-firestore.sh,test-app-controls-deploy.sh,test-vibe-consensus-image.sh}`, `.github/workflows/ai-trading-ci.yml` | Build, stage, group-start and verify bridge; optional isolated key profile; existing health-check derives services from catalog | 3 |
| `ai-trading/packages/vibe-trading/agent/src/agent/committee_gate.py`, `agent/src/swarm/{runtime.py,presets/investment_committee.yaml}`, `agent/backtest/loaders/yahoo_client.py`, focused backend tests, `DIVERGENCE.md` | Typed chair/run binding, source/valuation checks and private bridge client; no model-callable bridge tool | 4 |
| `ai-trading/packages/vibe-trading/agent/src/{agent/loop.py,session/service.py}`, focused loop/session/stream tests, `DIVERGENCE.md` | Automatic committee, one output policy applied before all callbacks/checkpoints and final result | 5 |
| `ai-trading/plans/subplans/01r-vibe-committee-gate-results.md`, `plans/STATUS.md`, fork/superproject commits and scoped PR/release | Real-model/browser/Caddy evidence and delivery | 6 |

**Interfaces:** Task 1 adds `AnalystTargets.period`; Task 2 serves `GET /v1/recommendations/<US_TICKER>` with `status`, `symbol`, `period`, `retrieved_at`, `provider`, and five integer count fields, never targets. Task 4's fixed-host `fetch_counts(ticker, token, base_url, opener)` returns that schema or an unavailable envelope; pure `needs_committee`, `verify_committee`, `valuation_target` and `render_recommendation` define the proof, and `CommitteeGate` holds per-run evidence/attempt state. Task 5 adds `CommitteeGate.orchestrate(...)` and `CommitteeGate.release(candidate, proof, llm)` and calls them from `AgentLoop`, emits only safe events, and persists the proof under the run directory. The only final SSE/return text is the result of `release`, not a streamed draft. The model cannot invoke the bridge with arbitrary arguments.

### Task 1: Preserve source period through shared targets type

**Files:** modify `ai-trading/common/src/ai_trading_common/types.py`, `providers/finnhub.py`, `providers/eulerpool.py`, `tests/providers/test_finnhub.py`, `tests/providers/test_eulerpool.py`, `tests/test_chains.py`.

**Interfaces:** `AnalystTargets.period: date | None = None` at the *end* of its frozen dataclass, so existing constructors remain valid. Finnhub and Eulerpool adapters both set `period=latest.period`; `as_of` remains the caller's retrieval timestamp. Fallback relabeling via `dataclasses.replace` retains `period` automatically.

- [ ] **Step 1: Add failing tests** using the already checked-in 2026-09-01 AAPL recommendation fixtures:

```python
from datetime import date

# test_finnhub.py::test_analyst_targets_has_counts_but_no_prices, after `got`:
assert got.period == date(2026, 9, 1)
assert got.as_of == pd.Timestamp("2026-10-11T00:00:00Z")
# test_eulerpool.py::test_analyst_targets_carries_both_counts_and_prices:
assert got.period == date(2026, 9, 1)
assert got.as_of == NOW  # retrieval time must not become the vendor month
# test_chains.py::_targets(), add `period=date(2026, 9, 1)` to its AnalystTargets constructor;
# TestTargetsChain.test_finnhub_fallback_has_counts_but_no_targets, after `got`:
assert got.period == date(2026, 9, 1)
```

- [ ] **Step 2: Run** `cd ai-trading/common && uv run pytest -q tests/providers/test_finnhub.py tests/providers/test_eulerpool.py tests/test_chains.py`; expect `AttributeError: 'AnalystTargets' object has no attribute 'period'`.
- [ ] **Step 3: Make the additive change** only (no global default/priority mutation):

```python
# types.py, after `as_of` in AnalystTargets:
period: date | None = None

# finnhub.py and eulerpool.py, in their AnalystTargets constructors:
period=latest.period,
```

- [ ] **Step 4: Run** focused tests plus `cd ai-trading/common && uv run ruff check . && uv run pytest -q`; expected all pass. Provider registry default target order stays Eulerpool→Finnhub for Desk; bridge overrides only its own `DATA_PROVIDERS_TARGETS`.
- [ ] **Step 5: Commit** exactly six Task 1 files with `git commit -m 'feat(ai-trading): retain analyst recommendation source period'`.

### Task 2: Authenticated count-only Python 3.12 bridge

**Files:** create `ai-trading/consensus/server.py`, `test_server.py`, `Dockerfile`, `README.md`.

**Interfaces:** `make_server(port: int, auth_key: str, sources: DataSources, clock: Callable[[], datetime], host: str = "127.0.0.1") -> HTTPServer`; the container entrypoint passes `host="0.0.0.0"`, while tests use the loopback default and port 0. `snapshot(symbol: str, sources: DataSources, now: datetime) -> dict` validates US identity and returns normalized counts plus source `period` and retrieval time. Response contract: 200 JSON `{"status":"ok","symbol":"AAPL.US","provider":"finnhub","period":"2026-09-01","retrieved_at":"2026-10-11T...Z","strong_buy":12,"buy":22,"hold":15,"sell":3,"strong_sell":1}`. 401 on invalid internal key; 400 on bad ticker; 503 `{"status":"unavailable","reason":"not_configured|stale|no_data|upstream"}` on provider problems, without provider response bodies/keys.

- [ ] **Step 1: Write failing tests** with a fake registry *interface* (not a fake vendor client); use the fixture's literal counts. Test 200, 401, missing key, stale vendor period despite fresh `as_of`, zero analysts, non-US/URL-shaped symbols and absence of any target-price field. Example test core:

```python
from datetime import date, datetime, timezone
from types import SimpleNamespace
import pandas as pd
from ai_trading_common.types import AnalystTargets
from server import snapshot

NOW = datetime(2026, 10, 11, tzinfo=timezone.utc)

def targets(period=date(2026, 9, 1)):
    return AnalystTargets("AAPL", None, None, None, None, 12, 22, 15, 3, 1,
                          "finnhub", "eod", pd.Timestamp(NOW), period)

def test_source_period_not_retrieval_clock_governs_freshness():
    source = SimpleNamespace(targets=SimpleNamespace(analyst_targets=lambda symbol, now: targets(date(2026, 8, 1))))
    assert snapshot("AAPL.US", source, NOW) == {"status": "unavailable", "reason": "stale"}

def test_free_response_has_counts_not_price_targets():
    source = SimpleNamespace(targets=SimpleNamespace(analyst_targets=lambda symbol, now: targets()))
    result = snapshot("AAPL.US", source, NOW)
    assert result["symbol"] == "AAPL.US" and result["buy"] == 22
    assert not any(key.startswith("target_") for key in result)
```

Add an actual localhost `HTTPServer` test using `urllib.request.Request` with a fake key: unauthenticated `GET /healthz` is 200; `/v1/recommendations/AAPL.US` without/with wrong key is 401; correct key returns the same `snapshot` object. Close the server in `finally` via the test utility, not production code.

- [ ] **Step 2: Run** `cd ai-trading/common && uv run pytest -q ../consensus/test_server.py`; expect missing `server`/`snapshot`.
- [ ] **Step 3: Implement bridge in stdlib** using `HTTPServer`, `BaseHTTPRequestHandler`, `hmac.compare_digest`, fixed path and `DataSources.from_env(env={**os.environ, "DATA_PROVIDERS_TARGETS": "finnhub"})`. Keep a single process-scoped `DataSources`: `ThrottledClient` maintains the free-plan rate bucket. `snapshot` rejects a source period in the future or >45 days old and an absent/zero count; do not invent a minimum analyst quorum. Never parse a URL from the user or follow an upstream redirect. No model/SEC/Yahoo call belongs in this service. Core logic:

```python
import re
from datetime import timezone
import pandas as pd
from ai_trading_common.errors import NoData, NotConfigured, SoftBanned, Unavailable

US_TICKER = re.compile(r"[A-Z]{1,5}(?:\.[A-Z])?\.US\Z")

def snapshot(symbol, sources, now):
    if not US_TICKER.fullmatch(symbol):
        raise ValueError("US ticker required")
    bare = symbol[:-3]
    try:
        value = sources.targets.analyst_targets(bare, now=pd.Timestamp(now))
    except NotConfigured:
        return {"status": "unavailable", "reason": "not_configured"}
    except NoData:
        return {"status": "unavailable", "reason": "no_data"}
    except (Unavailable, SoftBanned):
        return {"status": "unavailable", "reason": "upstream"}
    if value.provider != "finnhub" or value.symbol != bare or value.period is None:
        return {"status": "unavailable", "reason": "no_data"}
    age = (now.date() - value.period).days
    if not 0 <= age <= 45:
        return {"status": "unavailable", "reason": "stale"}
    names = ("strong_buy", "buy", "hold", "sell", "strong_sell")
    counts = {name: getattr(value, name) for name in names}
    if any(type(n) is not int or n < 0 for n in counts.values()) or sum(counts.values()) == 0:
        return {"status": "unavailable", "reason": "no_data"}
    return {"status": "ok", "symbol": bare + ".US", "provider": "finnhub",
            "period": value.period.isoformat(), "retrieved_at": now.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"), **counts}
```

Auth check precedes symbol parsing on the private route. The handler returns the status selected by `snapshot`, never a raw provider exception. Fixed-host Finnhub requests should not follow redirects: pass `http=ThrottledClient(session=NoRedirectSession())` to `DataSources.from_env`, where the session's `get` sets `allow_redirects=False`; a 302 becomes `Unavailable` and a 503 envelope. Implement the stdlib handler with this exact fail-closed shape:

```python
import hmac, json, os, re
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
import requests
from ai_trading_common.http import ThrottledClient
from ai_trading_common.registry import DataSources

class NoRedirectSession(requests.Session):
    def get(self, url, **kwargs):
        kwargs["allow_redirects"] = False
        return super().get(url, **kwargs)

def make_server(port, auth_key, sources, clock=lambda: datetime.now(timezone.utc), host="127.0.0.1"):
    if not auth_key:
        raise ValueError("internal auth key required")

    class Handler(BaseHTTPRequestHandler):
        def _send(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == "/healthz":
                return self._send(200, {"status": "ok"})
            if not hmac.compare_digest(self.headers.get("X-API-Key", ""), auth_key):
                return self._send(401, {"status": "error", "reason": "unauthorized"})
            match = re.fullmatch(r"/v1/recommendations/([A-Z.]{1,12})", self.path)
            if not match:
                return self._send(404, {"status": "error", "reason": "not_found"})
            try:
                body = snapshot(match.group(1), sources, clock())
            except ValueError:
                return self._send(400, {"status": "error", "reason": "bad_symbol"})
            except Exception:
                return self._send(503, {"status": "unavailable", "reason": "upstream"})
            return self._send(200 if body["status"] == "ok" else 503, body)

        def log_message(self, fmt, *args):
            pass  # never log request URLs or key-bearing headers

    # ponytail: one worker serializes HTTP requests; use bounded workers only if throughput requires it.
    return HTTPServer((host, port), Handler)

if __name__ == "__main__":
    sources = DataSources.from_env(
        env={**os.environ, "DATA_PROVIDERS_TARGETS": "finnhub"},
        http=ThrottledClient(session=NoRedirectSession()),
    )
    make_server(8000, os.environ["VIBE_API_AUTH_KEY"], sources, host="0.0.0.0").serve_forever()
```

The health endpoint never reports key presence. `Dockerfile` uses the existing Desk Python 3.12 image digest/uv version, copies `common/pyproject.toml`, `common/uv.lock`, `common/src/` in two cached build layers, runs `uv sync --frozen --no-dev --no-editable`, and copies its venv plus `consensus/server.py` into a non-root, read-only runtime. Context is `ai-trading/`; no new package dependency or lock.

```dockerfile
# syntax=docker/dockerfile:1.7
ARG PYTHON_IMAGE=python:3.12-slim-trixie@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1
FROM ${PYTHON_IMAGE} AS build
COPY --from=ghcr.io/astral-sh/uv:0.9.26 /uv /uvx /bin/
WORKDIR /src/common
COPY common/pyproject.toml common/uv.lock ./
RUN uv sync --frozen --no-dev --no-editable --no-install-project
COPY common/src ./src
RUN uv sync --frozen --no-dev --no-editable
FROM ${PYTHON_IMAGE}
RUN useradd --create-home --shell /usr/sbin/nologin app
COPY --from=build /src/common/.venv /opt/venv
COPY consensus/server.py /app/server.py
ENV PATH=/opt/venv/bin:$PATH PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
USER app
WORKDIR /app
CMD ["python", "server.py"]
```

- [ ] **Step 4: Run** `(cd ai-trading/common && uv run pytest -q ../consensus/test_server.py && uv run ruff check ../consensus)` from root. Before Task 3 adds the Bake target, use `docker build -t vibe-consensus:plan-test -f ai-trading/consensus/Dockerfile ai-trading` and a network-disabled fake-key container health probe; expected tests pass, image starts without Finnhub key, `/healthz` returns 200 and private request returns 503, not a provider call. After Task 3, rerun via Bake.
- [ ] **Step 5: Commit** exactly `ai-trading/consensus/` paths with `git commit -m 'feat(ai-trading): add private Finnhub recommendation bridge'`.

### Task 3: Deploy bridge with Vibe's app group and atomic secrets

**Files:** modify `ai-trading/deploy/docker-bake.hcl`, `deploy/docker-bake.ci.hcl`, `deploy/production/docker-compose.yml`, `deploy/production/deploy.sh`, `deploy/production/README.md`, `control/catalog.json`, `deploy/ci/test-deploy-firestore.sh`, `deploy/ci/test-app-controls-deploy.sh`, `.github/workflows/ai-trading-ci.yml`; create `deploy/ci/test-vibe-consensus-image.sh`. Read `deploy/production/health-check.sh` but do not add a second hardcoded service list: it already reads `control/catalog.json`.

**Interfaces:** Compose service `vibe-consensus` joins only `vibe` network, has no host port/public route and is listed in catalog app group `vibe-trading`. Its env files are existing `vibe-gateway.env` (only `VIBE_API_AUTH_KEY`) plus newly derived `vibe-consensus.env` (only optional `FINNHUB_API_KEY`). Source Finnhub value comes from **optional `ai-trading/consensus`**, never the mandatory `market-data.env` consumed by another app. `deploy.sh` includes new file in `SECRET_FILES` so staging/rollback treats it atomically. Vibe gets only public `VIBE_CONSENSUS_URL=http://vibe-consensus:8000`, not provider key.

- [ ] **Step 1: Add failing offline deploy tests.** In `test-deploy-firestore.sh`'s `fake_family_config` heredoc, allow a **separate** `ai-trading/consensus` render: fail it when `FAKE_FC_FINNHUB_KEY` is unset, otherwise write only `FINNHUB_API_KEY=fake-test-value`; leave fake `market-data.env` unchanged and assert it never contains FINNHUB. Use existing `new_scratch`/`run_scenario` helpers. Prove `vibe-consensus.env` holds **only** optional key, has mode 0600, and restores/removes in injected rollback cases. Without profile, normal `s1` case yields comment-only file and other apps' deploy succeeds. In `test-app-controls-deploy.sh`, seed off and on `vibe-trading` group as case 6 already does, then use real `control/state.py services` output to assert both `vibe-trading` and `vibe-consensus` are selected together, or neither; other groups and MiroFish keep prior state. Concrete assertions using actual helper names:

```bash
# Inside fake_family_config's `for target` heredoc, add one `elif`
# after its existing `elif [[ "$profile" == vibe-trading ... ]]` branch:
elif [[ "$profile" == consensus ]]; then
  [[ "${FAKE_FC_FINNHUB_KEY:-}" == 1 ]] || exit 2
  printf 'FINNHUB_API_KEY=fake-test-value\n' >"$tmp"

# Below the existing case 1 test (normal missing-key render):
[[ -f "$s1/secrets/vibe-consensus.env" ]] || fail "case1: missing optional consensus env"
! grep -q '^FINNHUB_API_KEY=' "$s1/secrets/vibe-consensus.env" || fail "case1: unexpected Finnhub key"

# New fake-key case:
s_consensus="$(new_scratch case_consensus)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s_consensus/ci-staging/cloudflared.env"
status="$(FAKE_FC_FINNHUB_KEY=1 run_scenario "$s_consensus")"
[[ "$status" == 0 ]] || fail "consensus render failed"
grep -qx 'FINNHUB_API_KEY=fake-test-value' "$s_consensus/secrets/vibe-consensus.env"
! grep -Eq 'ALPACA|OPENAI|ANTHROPIC|VIBE_API_AUTH_KEY' "$s_consensus/secrets/vibe-consensus.env"
! grep -q '^FINNHUB_API_KEY=' "$s_consensus/secrets/market-data.env"
[[ "$(stat -c '%a' "$s_consensus/secrets/vibe-consensus.env" 2>/dev/null || stat -f '%Lp' "$s_consensus/secrets/vibe-consensus.env")" == 600 ]]

# New failure-after-the-new-file case: prior file is restored, not replaced.
s_consensus_rollback="$(new_scratch case_consensus_rollback)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s_consensus_rollback/ci-staging/cloudflared.env"
printf 'OLD_VALUE=prior-consensus\n' >"$s_consensus_rollback/secrets/vibe-consensus.env"
chmod 0600 "$s_consensus_rollback/secrets/vibe-consensus.env"
export DEPLOY_SH_FAIL_AFTER=vibe-consensus.env
status="$(FAKE_FC_FINNHUB_KEY=1 run_scenario "$s_consensus_rollback")"
unset DEPLOY_SH_FAIL_AFTER
[[ "$status" != 0 ]] || fail "consensus rollback injection unexpectedly passed"
grep -qx 'OLD_VALUE=prior-consensus' "$s_consensus_rollback/secrets/vibe-consensus.env" || fail "consensus secret not restored"

# Repeat with no prior vibe-consensus.env; rollback must remove that file.
s_consensus_first="$(new_scratch case_consensus_first)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s_consensus_first/ci-staging/cloudflared.env"
export DEPLOY_SH_FAIL_AFTER=vibe-consensus.env
status="$(FAKE_FC_FINNHUB_KEY=1 run_scenario "$s_consensus_first")"
unset DEPLOY_SH_FAIL_AFTER
[[ "$status" != 0 && ! -e "$s_consensus_first/secrets/vibe-consensus.env" ]] || fail "new consensus secret survived rollback"
```

In `test-app-controls-deploy.sh`'s case 6, `got6` already holds selected services. Assert `grep -qx 'vibe-consensus' <<<"$got6"` when Vibe is on; seed a second state with `"vibe-trading":false` and assert both service names absent. Use `fail` for each failed assertion and increment the script's `CASE_COUNT` for the new scenario. Never create a real `.env` under the repository. The tests must run RED before `SECRET_FILES`/render/catalog changes.

- [ ] **Step 2: Run** `ai-trading/deploy/ci/test-deploy-firestore.sh` and `ai-trading/deploy/ci/test-app-controls-deploy.sh` from the repository root; expect missing `vibe-consensus.env`/service assertions.
- [ ] **Step 3: Change only the owned configuration.** Add `"vibe-consensus"` immediately before `"vibe-trading"` in `control/catalog.json`'s Vibe group; leave the `protected` list and all other groups unchanged. Add Bake target to the default group and one image tag:

```hcl
# group "default" targets now include "vibe-consensus" next to "vibe-trading"
target "vibe-consensus" {
  context    = "ai-trading"
  dockerfile = "consensus/Dockerfile"
  tags       = ["${REGISTRY}/ai-trading-vibe-consensus:${TAG}"]
}
```

Add Compose's `vibe-consensus` service next to Vibe, with image from Bake, `env_file: [vibe-gateway.env, vibe-consensus.env]` under `AI_TRADING_SECRETS_DIR`, `networks: [vibe]`, `read_only: true`, `cap_drop: [ALL]`, `security_opt: ["no-new-privileges:true"]`, `tmpfs: [/tmp]`, `pids_limit: 128`, `mem_limit: 512m`, and local `/healthz` healthcheck. Do **not** put `ports:` or `depends_on:` on it; `apply_selected_services` already uses catalog-driven `compose up --no-deps` and `health-check.sh` uses the same catalog. Vibe gets `VIBE_CONSENSUS_URL=http://vibe-consensus:8000` in its non-secret Compose environment. In `deploy.sh`:

```bash
SECRET_FILES=(tradingagents.env ai-hedge-fund.env vibe-trading.env vibe-gateway.env vibe-consensus.env auth.env market-data.env desk.env cloudflared.env)
# In render_profiles(), after deriving vibe-gateway.env; an absent optional
# profile never spoils the mandatory render or another app group's deploy:
local finnhub_key
finnhub_key=''
if FAMILY_CONFIG_CREDENTIALS="${FAMILY_CONFIG_CREDENTIALS:-/etc/family-app/config-reader.json}" \
     "$family_config" render ai-trading/consensus --out-dir "$RENDER_SRC_DIR" >/dev/null 2>&1; then
  finnhub_key="$(sed -n 's/^FINNHUB_API_KEY=//p' "$RENDER_SRC_DIR/consensus.env")"
fi
[[ "$finnhub_key" =~ ^[A-Za-z0-9_-]{8,128}$ ]] || finnhub_key=''
(
  umask 077
  printf '# Finnhub key not configured\n' >"$RENDER_SRC_DIR/vibe-consensus.env"
  if [[ -n "$finnhub_key" ]]; then
    printf 'FINNHUB_API_KEY=%s\n' "$finnhub_key" >"$RENDER_SRC_DIR/vibe-consensus.env"
  fi
)
```

The bridge reads `VIBE_API_AUTH_KEY` from `vibe-gateway.env`; no second auth key is created. Optional `ai-trading/consensus` is not created until owner supplies a free Finnhub key via `family_config.py set`; an absent profile, empty key or render outage leaves the bridge analysis-only without stopping the mandatory deploy. `consensus.env` stays in root-only scratch, never installed as-is or passed to any app; only the one extracted value enters the staged bridge file. Validate the key is a single line before writing it; reject/drop malformed optional values rather than leaking another env line. Update `deploy/production/README.md` with the profile/CLI name and group behavior, then re-run offline tests. Never log `$finnhub_key` or include it in a Docker build arg.

- [ ] **Step 4: Wire CI image/offline tests and smoke.** In `ai-trading-ci.yml`'s existing `desk` job, after `common` runs `uv sync --locked`, add `uv run pytest -q ../consensus/test_server.py`; reuse its pinned uv setup and cache instead of adding another action/job. The images job's default Bake builds `vibe-consensus`; add a dedicated GHA cache scope in `docker-bake.ci.hcl`. After its real-Caddy smoke, `test-vibe-consensus-image.sh` runs only the owned bridge image with `--network none`, a fake auth key and no Finnhub key. Its executable self-check uses `docker exec` to query `127.0.0.1:8000` *inside* the container and asserts `/healthz` 200, wrong/missing key 401 and authorized request 503 without opening a host port. In the scripts job's `Validate compose files` scratch loop, add `vibe-consensus` to the list of empty dummy env filenames so Compose parsing succeeds. No CI provider key. Run `actionlint` and ShellCheck on new shell script.
- [ ] **Step 5: Run** both offline deploy scripts, `uv run pytest -q ../consensus/test_server.py`, `docker buildx bake -f ai-trading/deploy/docker-bake.hcl --load`, `ai-trading/deploy/ci/smoke-test.sh all`, `test-vibe-consensus-image.sh`, `actionlint .github/workflows/ai-trading-ci.yml` and `shellcheck` on changed shell files.
- [ ] **Step 6: Commit** exact Task 3 paths with `git commit -m 'feat(ai-trading): stage and run private consensus bridge with Vibe'`.

### Task 4: Strict typed chair proof, source checks and valuation math in Vibe fork

**Files:** create `ai-trading/packages/vibe-trading/agent/src/agent/committee_gate.py`, `agent/tests/test_committee_gate.py`; modify `agent/src/swarm/{runtime.py,presets/investment_committee.yaml}`, `agent/backtest/loaders/yahoo_client.py`, `agent/tests/test_swarm_run_metadata.py`, `agent/tests/test_yahoo_client.py` (or its existing chart-client test file), `DIVERGENCE.md`. No Vibe image edit yet: the bridge client uses Vibe's existing Python 3.11 stdlib `urllib.request` and a fixed internal Compose URL.

**Interfaces:** `needs_committee(user_message: str, history: list[dict] | None) -> bool` distinguishes “your Buy/Sell/target” from attributed Yahoo/analyst questions. `fetch_counts(ticker: str, token: str, base_url: str, opener: Any | None = None) -> dict` accepts only a validated `*.US` ticker and a fixed `http://vibe-consensus:8000` origin; production builds a no-redirect opener, tests inject a fake. `verify_committee(run_id: str, ticker: str, swarm_root: Path, ledger: GroundingLedger, bridge: dict, yahoo: dict, *, now: datetime) -> dict` returns `{"status":"approved","symbol":...,"verdict":...,"target":...,"evidence_ids":[...]}` or `{"status":"analysis_only","reason":...}`. An own Buy/Sell requires a completed matching run, typed `approved` chair, nonempty bull/bear/risk/PM tasks, fresh Finnhub/Yahoo counts and a chair discussion of disagreement. An own numeric target additionally requires `valuation_target(record, sec_fact, quote_fact, split_events) -> Decimal | None` with exact SEC accession/annual period, a checked same-share-basis USD quote, 12-month horizon, confidence range and server-recomputed Decimal target. `render_recommendation(proof: dict) -> str` emits only checked typed values. A Task 4 `CommitteeGate(user_message, history, *, bridge_fetcher=fetch_counts)` stores per-run intent/full tool facts and an `attempted=False` flag; Task 5 extends it with orchestration/release. Never reuse proof across separate user turns; a follow-up with its own recommendation request starts a fresh committee rather than trusting an old as-of snapshot.

Before the first fork test/edit, from the repository root run `git submodule sync -- ai-trading/packages/vibe-trading` and `git submodule update --init -- ai-trading/packages/vibe-trading`; verify `git -C ai-trading/packages/vibe-trading remote get-url origin` names the family fork, then fetch its `family-app` branch and switch to it without a reset/rebase. If the checked-out branch contains unexpected user commits or differs from the pinned gitlink, stop and inspect rather than overwriting it. Use `git status --short --branch` before committing in either repository.

**Yahoo shape to test:** `get_stock_profile` returns `{"ok":true,"market":"us","source":"yahoo","data":{"ticker":"AAPL.US","listing":{"symbol":"AAPL","currency":"USD","exchange":"NMS"},"sections":{"recommendation_trend":[{"period":"0m","strong_buy":12,"buy":22,"hold":15,"sell":3,"strong_sell":1}],"financials":{"currentPrice":250}}}}`. This tool does **not** include a retrieval timestamp: stamp the successful tool call in the parent gate's in-memory ledger at receipt. `0m` means Yahoo's current relative window, **not** an ISO source date; reject an absent `0m` row, non-US listing, missing quote or stale receipt timestamp. Finnhub's absolute source period is checked independently (≤45 calendar days); do not demand exact count equality between analyst universes. Add one offline test with a valid `0m` row and one with only `-1m`; the latter must return `analysis_only`.

**SEC/quote basis to test:** `get_sec_filings(metric="EarningsPerShareDiluted")` returns `data.metric.unit="USD/shares"`, and a point under `data.metric.points[]` with `val=7.46`, `start`, `end="2025-09-27"`, `filed`, `form="10-K"`, `accession="0000320193-25-000079"`. Treat displayed `USD/share` as normalized notation, but compare source unit `USD/shares` exactly. `get_stock_profile` supplies same-symbol USD quote and server-stamped receipt time. Yahoo chart already requests `events=div,splits` but `_parse_chart` discards events. Add `get_split_events(symbol, start, end)` in its existing client, using a bounded chart query that covers the **entire** span after the SEC period and a validated chart result/meta; an absent `events` block on a successful full-span response means no split, while malformed/incomplete response is unavailable. Suppress targets for **any** intervening split (do not guess a factor). Test empty events with complete coverage, a split in the interval, and a truncated chart response; the latter two withhold a target. These checks apply only to own targets; otherwise-approved verdicts survive target-evidence failure.

- [ ] **Step 1: Write failing pure tests** before touching the fork implementation or YAML. Use a temporary real `run.json` fixture with `id="swarm-20261012-120000-abcdef12"`, preset `investment_committee`, four completed tasks and a typed chair footer; use the exact public SEC F02 fact from the golden casebook. Test mismatched ticker, forged/path-shaped run ID, missing report, `status=completed` but typed `incomplete`, free-text `INCOMPLETE — ANALYSIS ONLY` overriding contradictory typed approval, one failed worker, missing/stale Finnhub/Yahoo, conflicting Finnhub/Yahoo majorities with no chair explanation naming both source windows, and a reviewed as-of period that differs from the two inputs. For a valid, fresh October 2026 snapshot, AAPL EPS 7.46, growth 0.08, P/E 25 and split factor 1 must produce **$201.42**; unsupported candidate $999, a pre-split EPS paired with a post-split quote, missing split-history coverage, missing/stale quote, wrong SEC accession/unit/form, filed-in-future fact, horizon other than 12 months or absent confidence range yields no target.

```python
import json
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from src.agent.committee_gate import needs_committee, valuation_target, verify_committee

NOW = datetime(2026, 10, 12, tzinfo=timezone.utc)

def test_own_view_triggers_committee_but_attributed_consensus_does_not():
    assert needs_committee("Should I buy AAPL? Give your own 12-month target", None)
    assert not needs_committee("What is Yahoo's analyst consensus target for AAPL?", None)

def test_sec_valuation_is_recomputed_not_copied_from_model():
    record = {"eps":"7.46", "growth":"0.08", "multiple":"25", "split_factor":"1",
              "candidate_target":"201.42", "accession":"0000320193-25-000079", "period_end":"2025-09-27",
              "symbol":"AAPL.US", "unit":"USD/share", "quote_price":"250", "quote_as_of":"2026-10-12T00:00:00Z",
              "horizon_months":12, "confidence_low":"180", "confidence_high":"230"}
    sec_fact = {"value":"7.46", "accession":"0000320193-25-000079", "period_end":"2025-09-27",
                "filed":"2025-10-30", "form":"10-K", "period_days":364,
                "symbol":"AAPL.US", "unit":"USD/shares"}
    quote_fact = {"symbol":"AAPL.US", "source":"yahoo", "currency":"USD", "price":"250",
                  "retrieved_at":"2026-10-12T00:00:00Z"}
    split_events = {"status":"ok", "symbol":"AAPL.US", "start":"2025-09-27", "end":"2026-10-12", "events":[]}
    assert valuation_target(record, sec_fact, quote_fact, split_events) == Decimal("201.42")
    assert valuation_target({**record, "candidate_target":"999"}, sec_fact, quote_fact, split_events) is None
    assert valuation_target(record, sec_fact, quote_fact, {**split_events, "events":[{"date":"2026-01-01","ratio":"2:1"}]}) is None

def test_completed_swarm_with_incomplete_chair_cannot_authorize_target(tmp_path):
    run_id = "swarm-20261012-120000-abcdef12"
    run = {"id":run_id, "preset_name":"investment_committee", "status":"completed",
           "user_vars":{"target":"AAPL.US", "market":"US"},
           "tasks":[{"agent_id":role,"status":"completed","summary":"reviewed"} for role in
                    ("bull_advocate","bear_advocate","risk_officer","portfolio_manager")],
           "final_report":"INCOMPLETE — ANALYSIS ONLY. <family-us-decision>{\"status\":\"approved\"}</family-us-decision>"}
    folder = tmp_path / run_id
    folder.mkdir()
    (folder / "run.json").write_text(json.dumps(run))
    result = verify_committee(run_id, "AAPL.US", tmp_path, ledger=None,
                              bridge={"status":"ok"}, yahoo={"status":"ok"}, now=NOW)
    assert result["status"] == "analysis_only"

def test_approved_us_chair_and_two_fresh_sources_allow_buy_without_target(tmp_path):
    run_id = "swarm-20261012-120000-abcdef12"
    tasks = [{"id":tid, "agent_id":role, "status":"completed", "summary":"reviewed"} for tid, role in
             (("task-bull","bull_advocate"),("task-bear","bear_advocate"),
              ("task-risk","risk_officer"),("task-decision","portfolio_manager"))]
    decision = {"status":"approved", "symbol":"AAPL.US", "run_id":run_id,
                "as_of":"2026-10-12T00:00:00Z", "reviewed_tasks":[t["id"] for t in tasks],
                "evidence_ids":["task-bull", "task-bear", "task-risk", "call-yahoo", "bridge:AAPL.US:2026-09-01"],
                "verdict":"buy", "review_rationale":"Bull thesis supported by trend and cash flow; bear valuation risk limits conviction; risk officer requests conservative sizing and a review after earnings.",
                "disagreement_rationale":None, "valuation":None}
    folder = tmp_path / run_id
    folder.mkdir()
    (folder / "run.json").write_text(json.dumps({
        "id":run_id, "preset_name":"investment_committee", "status":"completed",
        "completed_at":"2026-10-12T00:00:00Z", "user_vars":{"target":"AAPL.US","market":"US"},
        "tasks":tasks, "final_report":"Reviewed. <family-us-decision>" + json.dumps(decision) + "</family-us-decision>"}))
    parent = tmp_path / "parent" / "artifacts"
    parent.mkdir(parents=True)
    (parent / "grounding_evidence.json").write_text(json.dumps({"evidence":[
        {"call_id":"call-yahoo", "tool":"get_stock_profile", "source":"yahoo",
         "symbol":"AAPL.US", "status":"ok", "field":"recommendation_trend", "value":"0m"}]}))
    ledger = SimpleNamespace(run_dir=parent.parent)
    bridge = {"status":"ok", "symbol":"AAPL.US", "provider":"finnhub", "period":"2026-09-01",
              "evidence_id":"bridge:AAPL.US:2026-09-01",
              "retrieved_at":"2026-10-12T00:00:00Z", "strong_buy":12,"buy":22,"hold":15,"sell":3,"strong_sell":1}
    yahoo = {"status":"ok", "symbol":"AAPL.US", "source":"yahoo", "period":"0m", "call_id":"call-yahoo",
             "retrieved_at":"2026-10-12T00:00:00Z", "strong_buy":10,"buy":20,"hold":12,"sell":2,"strong_sell":1}
    got = verify_committee(run_id, "AAPL.US", tmp_path, ledger, bridge, yahoo, now=NOW)
    assert got["status"] == "approved" and got["verdict"] == "buy" and got["target"] is None
```

Tests import `json` and use a fake ledger object containing exact `call_id`/field/value/source/symbol records for the positive path; they never call a live LLM or broker. The gate adds `bridge:AAPL.US:2026-09-01` **after** verifying the authenticated bridge envelope; this ID is not a caller-supplied bridge field. The test's extra `evidence_id` represents that gate-generated binding, not a change to the Task 2 HTTP schema. `ledger=None` is valid only for the explicit incomplete-chair negative case above because proof checking stops before evidence access. A completed runtime with an empty final_report must also fail closed.

- [ ] **Step 2: Run** from `ai-trading/packages/vibe-trading` with the upstream-CI venv: `"$VIBE_VENV/bin/python" -m pytest agent/tests/test_committee_gate.py -q`; expect missing module/symbols.
- [ ] **Step 3: Implement policy plus chair input binding.** In `SwarmRuntime.start_run`, after `build_run_from_preset` has generated its ID and before `create_run`, for `investment_committee` **only** overwrite `run.user_vars["committee_run_id"] = run.id` regardless of caller input; no other preset changes. Its `task-decision.prompt_template` includes `{committee_run_id}` and `{consensus_context}` (normalized independent Finnhub/Yahoo counts, periods and source IDs supplied by Task 5 as an ordinary variable); never trust user-provided text for run ID. Add preset load test and spoofed-`committee_run_id` test in `test_swarm_run_metadata.py`. Chair footer is requested in PM task prompt **for the automatic US committee request only**, not for non-US runs: `status: approved|incomplete`, exact `symbol`, `run_id`, `as_of`, `reviewed_tasks`, `evidence_ids`, `verdict: buy|sell|hold|null`, `review_rationale`, `disagreement_rationale` and optional `valuation` with `eps,growth,multiple,split_factor,accession,period_end,symbol,unit,quote_price,quote_as_of,horizon_months,confidence_low,confidence_high,candidate_target`. Its report must cite bull/bear/risk discussion and both source windows. Implement `committee_gate.py` with stdlib `Decimal`, `json`, `Path.resolve().is_relative_to` and bounded JSON parsing; reject missing/duplicate/unclosed footer, >8 KiB JSON, unknown status/verdict, missing/short (<80 chars) review rationale or rationale that does not address bull, bear and risk, run ID/symbol mismatch, or an evidence ID not bound to exact completed task IDs or successful parent tool call IDs. Literal `INCOMPLETE — ANALYSIS ONLY` always outranks typed approval. Do not use free-form model text as issued recommendation. Pure arithmetic core:

```python
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

def valuation_target(record: dict, sec_fact: dict, quote_fact: dict, split_events: dict) -> Decimal | None:
    if any(record.get(k) != sec_fact.get(k) for k in ("accession", "period_end", "symbol")):
        return None
    if (record.get("unit") != "USD/share" or sec_fact.get("unit") != "USD/shares" or
        sec_fact.get("form") != "10-K" or not 330 <= sec_fact.get("period_days", 0) <= 400 or
        record.get("horizon_months") != 12 or
        quote_fact.get("symbol") != record.get("symbol") or quote_fact.get("currency") != "USD" or
        str(record.get("quote_price")) != str(quote_fact.get("price")) or
        record.get("quote_as_of") != quote_fact.get("retrieved_at") or
        split_events.get("status") != "ok" or split_events.get("symbol") != record.get("symbol") or
        split_events.get("start") != record.get("period_end") or split_events.get("events") != []):
        return None
    try:
        eps = Decimal(str(sec_fact["value"]))
        growth = Decimal(str(record["growth"]))
        multiple = Decimal(str(record["multiple"]))
        factor = Decimal(str(record["split_factor"]))
        price = Decimal(str(quote_fact["price"]))
        low = Decimal(str(record["confidence_low"]))
        high = Decimal(str(record["confidence_high"]))
        proposed = Decimal(str(record["candidate_target"]))
        filed = date.fromisoformat(sec_fact["filed"])
        period_end = date.fromisoformat(record["period_end"])
        quote_at = datetime.fromisoformat(record["quote_as_of"].replace("Z", "+00:00"))
    except (KeyError, ValueError, InvalidOperation, TypeError):
        return None
    if (not all(x.is_finite() for x in (eps, growth, multiple, factor, price, low, high, proposed)) or
        eps <= 0 or price <= 0 or not Decimal("-0.5") <= growth <= 1 or
        not 1 <= multiple <= 100 or factor != 1 or quote_at.tzinfo is None or
        not period_end < filed <= quote_at.date() or (quote_at.date() - period_end).days > 450 or
        split_events.get("end") != quote_at.date().isoformat() or not 0 < low <= proposed <= high):
        return None
    target = (eps * (1 + growth) * multiple).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return target if abs(target - proposed) <= Decimal("0.01") else None
```

The arithmetic function is the core only; its caller additionally checks `now - quote_at <= 5 days` (bounded holidays), the annual SEC record is the freshest eligible filed point, the chart query covers the full EPS-to-quote interval, and issuer/venue/currency match the locked US symbol. `factor != 1` is a deliberate conservative ceiling: a proven corporate-action adjustment is a separate enhancement, not a guessed factor. Compare `candidate_target` to calculated target within $0.01, but always **render the calculated Decimal**, never the candidate string. A correctly approved committee can still issue Buy/Sell without a target when valuation data is unavailable. Strict bridge client request uses the fixed Compose host and `X-API-Key` header; reject redirects/non-JSON bodies, cap at 30 seconds, and map network/provider errors to `analysis_only` without logging the token. Yahoo snapshot comes from the **full** successful `get_stock_profile` tool result captured inside `AgentLoop` (Task 5), never its 200-character SSE preview. If Finnhub/Yahoo directions disagree, `disagreement_rationale` must cite both source names and their windows (Finnhub absolute period, Yahoo `0m`); do not average counts across vendors.

- [ ] **Step 4: Run** focused test file, `"$VIBE_VENV/bin/python" -m pytest agent/tests/test_swarm_tool_preset_matching.py agent/tests/test_swarm_run_metadata.py agent/tests/test_yahoo_client.py agent/tests/test_agent_grounding.py -q -n 8` and preset parser test from fork root. Update `DIVERGENCE.md` for chair/runtime/chart/policy changes.
- [ ] **Step 5: Commit** only fork Task 4 paths, including `DIVERGENCE.md`, with `git commit -m 'feat: validate US-stock committee decisions and SEC targets'`. Do not push yet; Task 6 pushes fork before moving superproject gitlink.

### Task 5: Automatic committee and one pre-stream release boundary

**Files:** modify fork `ai-trading/packages/vibe-trading/agent/src/agent/loop.py`, `src/agent/committee_gate.py`, `src/session/service.py`; add `agent/tests/test_committee_gate_stream.py` and focused additions to `agent/tests/test_session_restart_recovery.py` and `agent/tests/test_session_tool_trail.py`; update `DIVERGENCE.md` in same fork commit. No new UI component: existing progress/tool-stage widgets remain.

**Interfaces:** a run-scoped `CommitteeGate` has `buffering: bool`, `attempted: bool`, `sanitize_event(event_type, data) -> dict | None`, `ingest_tool_result(name, arguments, full_result, call_id)`, `orchestrate(registry, user_message, symbol, ledger, run_dir, *, now) -> dict` (one `registry.execute("run_swarm", {"prompt":...,"preset_name":"investment_committee","variables":{"target":symbol,"market":"US","consensus_context":verified_counts}})` call at most), and `release(raw_answer, proof, llm) -> str`. It captures **full successful** `get_stock_profile`/`get_sec_filings` tool results at `_finalize_tool_result`, not the 200-character trail preview; it stores only validated structured facts and call IDs, not arbitrary response text. The server constructs `consensus_context` from checked counts/periods and its own evidence IDs, not model prose; the runtime injects `committee_run_id` as specified in Task 4. The already implemented SP2 path `SessionService` → `build_registry(reasoning_effort=...)` → `SwarmTool` → worker `ChatLLM` propagates per-chat effort; reuse it and add an integration assertion that `run.json.reasoning_effort` matches the parent. `AgentLoop` owns a gate for *every* top-level user run, but only US-stock/ambiguous-market responses buffer. Swarm workers do not instantiate nested gates.

- [ ] **Step 1: Write failing tests** using a scripted `LLMResponse` that invokes `on_text_chunk("My target is $200")` and `on_reasoning_chunk("I would buy")` before returning content. Use a real `AgentLoop` and event sink as `test_agent_loop_stream_retry.py` does, with a fake registry `run_swarm` tool and fake bridge response, not a real provider call. Cases: F17 no key → one committee attempt but only analysis-only response; completed/incomplete chair → no own target; valid approved chair + fresh counts + SEC record → one server-rendered target; unsolicited target in generic company research → blocked; attributed Yahoo consensus in ordinary research → allowed as third-party; non-US answer retains existing stream behavior. If the LLM itself requests `run_swarm` before the automatic gate, its request does **not** launch another swarm; one controlled run at most. Check no raw target/reasoning tail/tool-result preview leaks through SSE, returned `react_trace`, persisted trace files, stored assistant reply or durable `ResponseCheckpoint`. Specifically feed `SwarmTool._emit_session_event("swarm.event", {"event":{"type":"worker_completed","task_id":"task-decision","data":{"summary":"My target is $200"}}})` through the **actual SessionService callback** and verify no summary reaches checkpoint, event bus replay or tool trail: `SwarmTool` is given that callback directly by `build_registry`, bypassing `AgentLoop._emit`. Same attempt's correction/reconnect must not spawn another swarm; two concurrent sessions cannot share a gate.

```python
from src.providers.chat import LLMResponse
from src.agent.loop import AgentLoop
from src.agent.committee_gate import CommitteeGate
from src.memory.persistent import PersistentMemory
from src.tools import build_registry

class DraftLLM:
    def stream_chat(self, messages, tools=None, on_text_chunk=None, on_reasoning_chunk=None, **kwargs):
        on_text_chunk("My own target is $200")
        on_reasoning_chunk("I would buy before checking")
        return LLMResponse(content="My own target is $200")
    def chat(self, messages, **kwargs):
        return LLMResponse(content='{"own_verdict":true,"own_target":true,"uncertain":false}')

def make_loop(llm, events, run_dir):
    pm = PersistentMemory()
    agent = AgentLoop(registry=build_registry(persistent_memory=pm, include_shell_tools=False),
                      llm=llm, event_callback=lambda kind, data: events.append((kind, data)),
                      max_iterations=3, persistent_memory=pm)
    run_dir.mkdir(parents=True)
    agent.memory.run_dir = str(run_dir)
    return agent

def test_no_draft_target_reaches_stream_or_result_when_key_absent(tmp_path, monkeypatch):
    events = []
    calls = []
    def no_key(self, registry, user_message, symbol, ledger, run_dir, *, now):
        calls.append(symbol)
        return {"status":"analysis_only","reason":"not_configured"}
    monkeypatch.setattr(CommitteeGate, "orchestrate", no_key)
    agent = make_loop(DraftLLM(), events=events, run_dir=tmp_path / "run")
    result = agent.run(user_message="Should I Buy NVDA? Give your own price target", session_id="test-session")
    assert "My own target is $200" not in result["content"]
    assert "My own target is $200" not in str(result["react_trace"])
    assert not any("My own target is $200" in str(data) for _, data in events)
    assert not any("I would buy before checking" in str(data) for _, data in events)
    assert len(calls) == 1
```

Keep `make_loop` in this **test file**, not production. The scripted LLM returns a forbidden draft; `no_key` stands in only for the external committee/bridge boundary, while `AgentLoop` event/release code remains real. A separate pure orchestrator test registers a fake `run_swarm` tool in `ToolRegistry`, calls `gate.orchestrate` twice with the same locked symbol, and asserts exactly one execute call. For a response-checkpoint integration test, use a real `SessionStore` and `ResponseCheckpoint` from the existing session tests, feed only emitted safe events, recreate `SessionService`, and assert no recovered partial includes the forbidden draft. A fake error/result from the classifier must trigger the same analysis-only fallback without a retry loop. Add a Chinese and an Arabic own-target fixture whose model-provided classifier verdict is `own_target=true`; neither may enter SSE or saved history.

- [ ] **Step 2: Run** `"$VIBE_VENV/bin/python" -m pytest agent/tests/test_committee_gate_stream.py agent/tests/test_session_restart_recovery.py -q` from the fork root; expect an early `text_delta`/reasoning tail or missing `CommitteeGate` integration.
- [ ] **Step 3: Implement one policy used on both callback paths.** Construct `CommitteeGate(attempt.prompt, history)` in `SessionService._run_with_agent` **before** `build_registry` and pass it into optional `AgentLoop(..., committee_gate=gate)`; CLI/MCP loops create their own gate at run start. At `SessionService.event_callback`, call `gate.sanitize_event` **before** `checkpoint.handle_event`, tool-trail recording and event-bus emit; a `None` result drops the event. `AgentLoop._emit` calls the same idempotent sanitizer before its callback, so direct CLI/MCP callers get the same result. Market requests with unresolved identity buffer conservatively. At each iteration, set `buffer_text_output = self._grounding.should_buffer_output or gate.buffering`. While own-verdict intent is active, omit `run_swarm` from LLM-advertised tool definitions and reject a forged tool call of that name at `_process_tool_calls`; only `CommitteeGate.orchestrate` invokes it. `sanitize_event` allowlists fixed progress fields (`tool`, `call_id`, `status`, `elapsed_ms`, `run_id`, task counts) while gated and drops unknown `swarm.*` shapes; no nested worker `event.data.summary`, free-form arguments, provider preview or artifact URL. `_on_reasoning_chunk` emits counts but never `tail`. Existing text-delta branches (success, grounding fallback, tool syntax, no-progress, retry/reset) are all suppressed by same check. Sanitize `TraceWriter` inputs and `react_trace` **at write time** while gated; never write a raw draft then redact it after the fact.

```python
# In SessionService._run_with_agent's callback, BEFORE checkpoint.handle_event:
safe = gate.sanitize_event(event_type, data)
if safe is None:
    return
data = safe

# In AgentLoop._emit, BEFORE invoking its callback (idempotent second check):
data = self._committee_gate.sanitize_event(event_type, data)
if data is None:
    return

# CommitteeGate.sanitize_event, while buffering:
if event_type == "text_delta":
    return None
if event_type == "reasoning_delta":
    return {key: data[key] for key in ("iter", "chars") if key in data}
if event_type == "swarm.event":
    nested = data.get("event") or {}
    allowed_stages = {"run_started", "layer_started", "worker_started", "worker_completed", "run_completed"}
    if nested.get("type") not in allowed_stages:
        return None
    return {"run_id": data.get("run_id"), "stage": nested["type"],
            "task_id": nested.get("task_id") if nested.get("task_id") in
            {"task-bull", "task-bear", "task-risk", "task-decision"} else None}
if event_type in {"tool_result", "tool_call", "swarm.started"}:
    return {key: data[key] for key in ("tool", "call_id", "status", "elapsed_ms", "run_id", "preset", "done", "total") if key in data}
if event_type.startswith("swarm."):
    return None  # unexpected nested worker payload
if event_type in {"tool_progress", "iteration", "thinking_done"}:
    return {key: data[key] for key in ("tool", "call_id", "status", "elapsed_ms", "iter", "done", "total") if key in data}
return None  # fail closed on an unclassified event shape

# In the run's central post-loop path, before resolve_final_status/build_result_dict:
if gate.buffering and final_content and not self._cancel_event.is_set():
    proof = gate.orchestrate(self.registry, user_message, gate.single_locked_us_symbol(self._grounding), self._grounding, run_dir, now=datetime.now(timezone.utc))
    final_content = gate.release(final_content, proof, self.llm)
    # react_trace and disk trace already hold only safe summaries while gated.
    gate.buffering = False
    self._emit("text_delta", {"delta": final_content, "iter": current_iter})
```

`gate.release` first requests an **analysis-only** version of the candidate from the existing direct-OpenAI `ChatLLM.chat(..., tools=None)`, with at most two bounded attempts. A deterministic own-advice scanner and a separate JSON-only classifier request each must return safe; malformed/error/uncertain classification fails closed to a fixed neutral notice. Then append `render_recommendation(proof)` *only* for approved typed fields. No raw committee prose is ever appended directly, and `trace.write_text_entry`/user-download paths for quarantined drafts store hashes/issue codes rather than original target text. Do not erase a prior `grounding_status` failure or treat a policy block as verified numeric evidence. `AgentLoop`'s result `content`, SSE final delta, persisted reply and checkpoint contain the same checked text. A cancelled/failed run emits no recommendation even with a prior committee artifact.

- [ ] **Step 4: Run** focused gate/stream/recovery tests plus `"$VIBE_VENV/bin/python" -m pytest agent/tests/test_agent_grounding.py agent/tests/test_agent_loop_stream_retry.py agent/tests/test_reasoning_delta_throttle.py agent/tests/test_session_tool_trail.py -q -n 8` from fork root. Update `DIVERGENCE.md` for loop/session/output changes.
- [ ] **Step 5: Commit** exact fork Task 5 paths, including `DIVERGENCE.md`, with `git commit -m 'feat: quarantine US-stock answers until committee approval'`. Do not move superproject gitlink or push fork before full fork verification in Task 6.

### Task 6: Full verification, measured rollout and scoped delivery

**Files:** create `ai-trading/plans/subplans/01r-vibe-committee-gate-results.md`; modify only the Vibe row/decision in `ai-trading/plans/STATUS.md` and the SP4 notes in `packages/vibe-trading/DIVERGENCE.md` when necessary. The product files are already in Tasks 1–5.

- [ ] **Step 1: Run the exact offline suites**, in the branch's initialized fork and common/bridge packages. Check the fork's `origin` points at the family fork *before* changing or pushing it. Commands from repository root, with local venv/Node deps set up as in `ai-trading/AGENTS.md`:

```bash
: "${VIBE_VENV:?set VIBE_VENV to the fork's upstream-CI virtualenv outside the repository}"
(cd ai-trading/common && uv run ruff check . && uv run pytest -q)
(cd ai-trading/common && uv run pytest -q ../consensus/test_server.py)
(cd ai-trading/packages/vibe-trading && "$VIBE_VENV/bin/python" -m pytest agent/tests -q -n 8)
(cd ai-trading/packages/vibe-trading/frontend && npx tsc -b && npx vitest run && npm run build)
ai-trading/deploy/ci/test-deploy-firestore.sh
ai-trading/deploy/ci/test-app-controls-deploy.sh
docker buildx bake -f ai-trading/deploy/docker-bake.hcl --load
ai-trading/deploy/ci/test-vibe-consensus-image.sh
ai-trading/deploy/ci/smoke-test.sh all
actionlint .github/workflows/ai-trading-ci.yml
```

The bridge image test runs after Bake; pass its `TAG`/`REGISTRY` exactly as the existing smoke script does. New frontend UI code is not planned, but run its checks because SSE/history behavior changes. If a test fails, investigate its root cause, write a regression test, then repair; no waived failures. Do not commit production keys, full reports, accounts, VPS addresses or local env files.

- [ ] **Step 2: Run real-model and browser checks** in isolated external scratch homes with the Firestore production Vibe profile, sponsored OpenAI/Anthropic keys, a local bridge returning `not_configured` and then a controlled fake fresh recommendation response. F17 must never stream/store/return an own target without a substantively approved committee; R07's technically completed but `INCOMPLETE — ANALYSIS ONLY` chair response remains analysis-only; a correctly approved fixture with SEC AAPL FY2025 accession and fresh Finnhub counts can emit the server-computed $201.42 target, not the model's $999. Include a generic US-stock request where the model volunteers an own Buy target, a Yahoo-consensus-only request (no auto committee), and a restart/reconnect before release. Observe SSE event payloads and post-reload history in the real signed-in browser; capture no private/raw answers in the public results doc. If the owner's free Finnhub key is still absent, the real-provider positive path is explicitly *not verified* and production must remain analysis-only.
- [ ] **Step 3: Write and commit the measured local results with the phase batch.** `01r-vibe-committee-gate-results.md` records before/after F17/R07, bridge key/no-key fixture results, 45-day source-month check, SEC valuation proof, wall time, output-leak assertions and the explicit live positive-path limit while the free key is absent. Update only the small Vibe tracker row in `plans/STATUS.md`. Include offline/image/Caddy/browser evidence already run; do not invent future PR/deploy IDs. Verify links and public-repo confidentiality, commit these docs with the implementation rather than opening a docs-only PR.
- [ ] **Step 4: Review the fork and deliver to `dev`.** `git -C ai-trading/packages/vibe-trading status --short --branch`, `git -C ... remote get-url origin` must show the family fork and `family-app` branch; verify `DIVERGENCE.md` names each source change. Push `family-app` to the fork **before** staging the superproject gitlink. Stage exactly the remaining gitlink and results/status paths; Tasks 1–5 already committed their own implementation files. Merge `origin/dev`, run the offline suites again, self-review the whole diff, then open **one** meaningful PR to `dev`. CI must pass; merge without admin/force. Do not push a docs-only PR or push an open PR for cosmetic edits.
- [ ] **Step 5: Scoped release after `dev` merge.** Create a release branch from `origin/main`, bring across **only** completed SP4 `ai-trading/` paths, its new bridge image workflow changes and verified Vibe gitlink, never all of `dev` (Desk/expense work must stay unreleased). Follow standing delivery authorization: release PR to `main`, wait for CI/deploy, preserve `MIROFISH_ACTIVATE=keep` and other app-control choices, upload static assets only if actually changed. Monitor container health and Caddy/Clerk gate; verify no key/value leak, no app-group revival, no Vibe target via SSE/history with the free key absent, and signed-in analysis-only browser behavior. Report live PR/deploy URLs and any positive-path limitation in the completion response; add them to the results doc with the next meaningful ai-trading phase, not a docs-only CI rerun. A deployment blocked by missing required secrets or the VPS 30 GiB guard stops the release; do not bypass the guard. Keep SP5 deploy-safe run recovery and optional chat model picker/full-page reader deferred.

## Plan self-review gate

- Map each spec section to Tasks 1–6: shared period, bridge, atomic deployment, typed chair/valuation, output gate across channels, offline+real verification and scoped delivery.
- Check that every Review Focus failure mode has a literal failing-test step in its owning task. Test both **positive and fail-closed** source paths without a live Finnhub key.
- Verify code-block names, test paths and env-file names match their producing tasks; run placeholder/contradiction scan and amend before asking for plan approval.
