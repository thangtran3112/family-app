"""FastAPI app wiring (PROTO-BRIEF.md §4 L4): identity (`api/auth.py`), the `/api/desk/*` REST
routers, SSE quotes, the `/healthz` route `health-check.sh` polls, and two background loops --
`alerts.runtime.tick` every 60s and `notify.dispatch.dispatch_pending` every 10s, each against a
fresh `Session` (never one long-lived session for the process's lifetime).

Run by the `api` compose service via `ai_trading.api.main:app` (`main.py` re-exports this exact
`app` object -- there is exactly one served ASGI app; integration fix, PROTO-BRIEF.md). Every
resource below (the DB engine,
`DataSources`, the notify channel map) is built from the environment at *lifespan* startup, not at
import time, so importing this module -- e.g. from a test -- never requires a live database or
network. Without `DESK_RUNTIME_DATABASE_URL` set, the background loops simply don't start (logged,
never a crash); tests instead override `api.auth.get_session`/`get_data_sources` directly and
never rely on `app.state`.
"""

import asyncio
import logging
import os
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from datetime import UTC, datetime

from ai_trading_common.registry import DataSources
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.orm import Session, sessionmaker

from ai_trading.alerts.runtime import tick
from ai_trading.api import (
    alert_strategies,
    alerts,
    bars,
    charts,
    covered_calls,
    dashboard,
    feedback,
    fundamental_alerts,
    futures,
    holdings,
    library,
    me,
    quotes,
    replay,
    research,
    screener,
    settings,
    signals,
    status,
    strategies,
    symbols,
    technicals,
    watchlists,
)
from ai_trading.db.engine import make_engine, make_health_check_engine, make_session_factory, session_scope
from ai_trading.notify.channel import Channel, RuntimeGated
from ai_trading.notify.dispatch import dispatch_pending
from ai_trading.notify.slack import SlackChannel
from ai_trading.notify.telegram import TelegramChannel

logger = logging.getLogger(__name__)

TICK_INTERVAL_SECONDS = 60.0
DISPATCH_INTERVAL_SECONDS = 10.0

_DATABASE_URL_VAR = "DESK_RUNTIME_DATABASE_URL"


def _build_channels(env: dict[str, str]) -> dict[str, Channel]:
    """Only a channel with real credentials present gets wired (D-a) -- `inbox` needs none
    (`dispatch_pending` handles it directly). A `telegram`/`slack` delivery with no entry here
    is recorded `no_channel`, never a crash, until the owner sets these keys. The values come from the
    Firestore `family-config` profile rendered into the container env at deploy time. Telegram needs the bot
    token only: each user's chat is the one she links (`PUT /settings/channels/telegram`); `TELEGRAM_CHAT_ID`
    is an optional fallback chat. Both wired channels send nothing while the alert runtime is off."""
    channels: dict[str, Channel] = {}
    if bot_token := env.get("TELEGRAM_BOT_TOKEN"):
        channels["telegram"] = RuntimeGated(TelegramChannel(bot_token, env.get("TELEGRAM_CHAT_ID")))
    if webhook_url := env.get("SLACK_WEBHOOK_URL_OWNER"):
        channels["slack"] = RuntimeGated(SlackChannel(webhook_url))
    return channels


async def _background_loop(
    work: Callable[[Session, datetime], None],
    session_factory: sessionmaker[Session],
    *,
    interval: float,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    clock: Callable[[], datetime] = lambda: datetime.now(UTC),
) -> None:
    """Runs `work` against a fresh `Session` every `interval` seconds, forever, until the task is
    cancelled. One exception from `work` is logged and never kills the loop -- a single bad
    tick/dispatch cycle must not take the whole background loop down. `work` runs in a worker thread,
    so a slow or retrying channel send (`time.sleep` backoff) never stalls the API, inbox reads included."""

    def run() -> None:
        with session_scope(session_factory) as session:
            work(session, clock())

    while True:
        try:
            await asyncio.to_thread(run)
        except Exception:
            logger.exception("background loop iteration failed")
        await sleep(interval)


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    tasks: list[asyncio.Task[None]] = []
    database_url = os.environ.get(_DATABASE_URL_VAR)
    if database_url:
        app.state.session_factory = make_session_factory(make_engine(database_url))
        app.state.health_engine = make_health_check_engine(database_url)
        app.state.data_sources = DataSources.from_env()
        channels = _build_channels(dict(os.environ))
        app.state.channels = channels  # `POST /settings/channels/{channel}/test` sends through these
        tasks.append(
            asyncio.create_task(
                _background_loop(
                    lambda session, now: tick(session, now=now),
                    app.state.session_factory,
                    interval=TICK_INTERVAL_SECONDS,
                )
            )
        )
        tasks.append(
            asyncio.create_task(
                _background_loop(
                    lambda session, now: dispatch_pending(session, channels=channels, now=now),
                    app.state.session_factory,
                    interval=DISPATCH_INTERVAL_SECONDS,
                )
            )
        )
    else:
        # No database configured, e.g. a test TestClient that overrides get_session/
        # get_data_sources directly. Never crash the app over it; just skip the background work.
        logger.warning("%s is not set; background tick/dispatch loops are not running", _DATABASE_URL_VAR)
    try:
        yield
    finally:
        for task in tasks:
            task.cancel()


app = FastAPI(title="ai-trading-desk", lifespan=_lifespan)

for _router_module in (
    watchlists,
    strategies,
    signals,
    alerts,
    settings,
    quotes,
    me,
    bars,
    technicals,
    futures,
    status,
    symbols,
    dashboard,
    charts,
    screener,
    library,
    alert_strategies,
    replay,
    feedback,
    holdings,
    covered_calls,
    research,
    fundamental_alerts,
):
    app.include_router(_router_module.router)


#: Step 0 integration fix: `/healthz` is a READINESS check, not a static "ok". `health-check.sh`'s
#: Docker-level healthcheck (docker-compose.yml) polls this with its own interval/retries/
#: start_period -- that is what gives a cold/slow shared Postgres cluster time to become reachable
#: (`api` has no `depends_on` across Compose projects, D-e); this route itself makes exactly one
#: bounded attempt per call, never its own internal retry loop.
@app.get("/healthz")
def healthz(request: Request) -> JSONResponse:
    engine = getattr(request.app.state, "health_engine", None)
    if engine is None:
        return JSONResponse({"status": "unavailable"}, status_code=503)
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
    except Exception:
        # Never the real exception text or the database URL in the response body (AGENTS.md: no
        # VPS address or credential in anything this process returns) -- a fixed, generic body.
        return JSONResponse({"status": "unavailable"}, status_code=503)
    return JSONResponse({"status": "ok"}, status_code=200)
