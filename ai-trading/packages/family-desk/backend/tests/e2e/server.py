"""Test-only ASGI lifespan: real routes/DB, seeded data, no providers or background jobs."""

import os
import threading
from contextlib import asynccontextmanager

from clock import freeze_api_clocks
from fastapi import FastAPI
from safety import e2e_url
from seeded_source import data_sources
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from ai_trading.api import futures, market_data, quotes, strategies
from ai_trading.api.main import app
from ai_trading.db.engine import make_health_check_engine


class SessionLifecycle:
    def __init__(self):
        self._condition = threading.Condition()
        self.active = 0
        self.closed = 0

    def opened(self):
        with self._condition:
            self.active += 1

    def closed_one(self):
        with self._condition:
            self.active -= 1
            self.closed += 1
            self._condition.notify_all()

    def wait_for_closed(self, count: int, timeout: float) -> bool:
        with self._condition:
            return self._condition.wait_for(lambda: self.closed >= count, timeout)


SESSION_LIFECYCLE = SessionLifecycle()
STREAM_CLOSED = threading.Event()
STREAM_ACTIVE = 0
STREAMS_CLOSED = 0
STREAM_LOCK = threading.Lock()
_production_quote_events = quotes.quote_events


class E2ESession(Session):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._e2e_open = True
        SESSION_LIFECYCLE.opened()

    def close(self):
        try:
            super().close()
        finally:
            if self._e2e_open:
                self._e2e_open = False
                SESSION_LIFECYCLE.closed_one()


@asynccontextmanager
async def _e2e_lifespan(application: FastAPI):
    database_url = e2e_url(os.environ["DESK_E2E_DATABASE_URL"]).render_as_string(hide_password=False)
    engine = create_engine(database_url)
    health_engine = make_health_check_engine(database_url)
    factory = sessionmaker(engine, expire_on_commit=False, class_=E2ESession)
    missing = object()
    previous = {
        name: getattr(application.state, name, missing)
        for name in ("session_factory", "health_engine", "data_sources", "e2e_engine")
    }
    application.state.session_factory = factory
    application.state.health_engine = health_engine
    application.state.data_sources = data_sources(factory)
    application.state.e2e_engine = engine
    try:
        yield
    finally:
        health_engine.dispose()
        engine.dispose()
        for name, value in previous.items():
            if value is missing:
                delattr(application.state, name)
            else:
                setattr(application.state, name, value)


async def _observed_quote_events(*args, **kwargs):
    global STREAM_ACTIVE, STREAMS_CLOSED
    with STREAM_LOCK:
        STREAM_ACTIVE += 1
    try:
        async for event in _production_quote_events(*args, **kwargs):
            yield event
    finally:
        with STREAM_LOCK:
            STREAM_ACTIVE -= 1
            STREAMS_CLOSED += 1
        STREAM_CLOSED.set()


def install_e2e_runtime():
    """Install process-local test overrides and return restoration callback."""
    global _production_quote_events
    original = {
        "lifespan": app.router.lifespan_context,
        "quote_events": quotes.quote_events,
        "quotes_datetime": quotes.datetime,
        "strategies_datetime": strategies.datetime,
        "market_data_pd": market_data.pd,
        "futures_date": futures.date,
    }
    _production_quote_events = original["quote_events"]
    freeze_api_clocks()
    quotes.quote_events = _observed_quote_events
    app.router.lifespan_context = _e2e_lifespan

    def restore():
        global _production_quote_events
        _production_quote_events = original["quote_events"]
        quotes.quote_events = original["quote_events"]
        quotes.datetime = original["quotes_datetime"]
        strategies.datetime = original["strategies_datetime"]
        market_data.pd = original["market_data_pd"]
        futures.date = original["futures_date"]
        app.router.lifespan_context = original["lifespan"]

    return restore
