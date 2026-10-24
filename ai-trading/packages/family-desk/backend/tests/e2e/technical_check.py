"""Explicit-runner-only: the Technical alert path against a frozen clock, over real HTTP (02m §d5, backend side).

Run by `run.py` after the browser suite, in its own disposable database seeded with the Technical world
(`technical_seed.py`: the five seed strategies as shipped, bars derived from the Run 0 snapshot). Each test
resets that world, then drives the production runtime (`alerts.runtime.tick`, `notify.dispatch`) with explicit
instants on the frozen clock, and reads the outcome back through the API the browser uses:

    seed strategy -> delayed bar arrives -> signal -> inbox alert -> log row
    a quiet-hours hold; a stale-data pause with no catch-up burst; no order object, ever

The seed holds a whole session of minute bars. These tests cut the feed at 11:00 ET (the provider is 15 minutes
behind) and let one bar "arrive": a flat minute below VWAP, then a minute that closes above it, which is the
`crosses_above close vwap` the VWAP reclaim seed strategy waits for.
"""

import json
import os
from contextlib import contextmanager
from datetime import UTC, date, datetime

import httpx
import pandas as pd
import pytest
from clock import reset_now, set_now
from http_check import real_servers  # noqa: F401  (the fixture: real API and proxy on loopback)
from seed import reset_database
from server import app
from sqlalchemy import delete, inspect, select, update

from ai_trading.alerts.runtime import tick
from ai_trading.core import backtest, sizing
from ai_trading.core.calendar import annotate, et
from ai_trading.core.indicators import session_vwap
from ai_trading.db.models import Bar1m, FeedHealth, StrategyVersion
from ai_trading.notify.channel import ChannelError
from ai_trading.notify.dispatch import dispatch_pending

DAY = date(2026, 10, 15)  # the seeded session (Thursday); the clock's default is 20:00 ET that evening
SESSION = {"cookie": "desk_e2e_session=1"}
RUNTIME_FLAG = "DESK_ALERTS_RUNTIME_ENABLED"
QUIET = {"start": "10:00", "end": "12:00"}
CUT = "11:00"  # the first minute that has not arrived yet when the test starts


def at(hhmm: str) -> datetime:
    return et(DAY, hhmm).to_pydatetime().astimezone(UTC)


class Telegram:
    """A stand-in channel; it records what it was asked to send."""

    name = "telegram"

    def __init__(self, fails: bool = False) -> None:
        self.sent: list[str] = []
        self.fails = fails

    def send(self, *, title: str, body: str, severity: str, **_: str) -> None:
        if self.fails:
            raise ChannelError("unreachable")
        self.sent.append(body)


@contextmanager
def runtime_enabled():
    """The operator's release step (02m §b5 item 6); the flag is read on every request."""
    os.environ[RUNTIME_FLAG] = "1"
    try:
        yield
    finally:
        os.environ.pop(RUNTIME_FLAG, None)


class World:
    """The Technical world behind the real API, and the production runtime driven on the frozen clock."""

    def __init__(self, client: httpx.Client) -> None:
        self.client = client
        self.factory = app.state.session_factory

    def get(self, path: str):
        response = self.client.get(path)
        assert response.status_code == 200, (path, response.text)
        return response.json()

    def strategy(self, name: str) -> dict:
        return next(row for row in self.get("/api/desk/alert-strategies") if row["name"] == name)

    def turn_on(self, name: str) -> None:
        with runtime_enabled():
            response = self.client.post(f"/api/desk/alert-strategies/{self.strategy(name)['id']}/resume")
        assert response.status_code == 200 and response.json()["stage"] == "alert_only"

    def tick(self, hhmm: str):
        set_now(at(hhmm))
        with self.factory() as db:
            return tick(db, now=at(hhmm))

    def dispatch(self, hhmm: str, channels: dict[str, Telegram] | None = None):
        set_now(at(hhmm))
        with self.factory() as db:
            outcomes = dispatch_pending(db, channels=channels or {}, now=at(hhmm), sleep=lambda _: None)
            db.commit()
        return outcomes

    def feed_ok(self, hhmm: str) -> None:
        with self.factory() as db:
            db.execute(update(FeedHealth).values(state="ok", last_ok_at=at(hhmm), updated_at=at(hhmm)))
            db.commit()

    def log(self) -> list[tuple[str, str, str]]:
        return sorted((row["strategy_name"], row["channel"], row["status"]) for row in self.get("/api/desk/alerts/log"))

    # -- the delayed feed ---------------------------------------------------------------------------------------

    def cut_feed(self, hhmm: str = CUT) -> None:
        """Minutes from `hhmm` on have not arrived: the store ends there, as the delayed provider's would."""
        with self.factory() as db:
            db.execute(delete(Bar1m).where(Bar1m.bar_start >= at(hhmm)))
            db.commit()

    def _vwap(self, db, until: datetime) -> float:
        rows = db.execute(
            select(Bar1m).where(Bar1m.symbol == "NVDA", Bar1m.bar_start < until).order_by(Bar1m.bar_start)
        ).scalars()
        bars = pd.DataFrame(
            [(r.bar_start, r.open, r.high, r.low, r.close, r.volume) for r in rows],
            columns=["bar_start", "open", "high", "low", "close", "volume"],
        ).set_index("bar_start")
        return float(session_vwap(annotate(bars, "stock")).dropna().iloc[-1])

    def _put(self, db, start: datetime, open_: float, close: float, volume: float) -> None:
        bar = db.get(Bar1m, ("NVDA", start))
        values = {"open": open_, "high": max(open_, close), "low": min(open_, close), "close": close, "volume": volume}
        if bar is None:
            db.add(Bar1m(symbol="NVDA", bar_start=start, source="alpaca", **values))
        else:
            for column, value in values.items():
                setattr(bar, column, value)

    def refill(self, first: str, last: str, price: float) -> None:
        """Flat minutes from `first` to `last` (inclusive): the delayed feed catching up after an outage."""
        with self.factory() as db:
            for start in pd.date_range(at(first), at(last), freq="1min"):
                self._put(db, start.to_pydatetime(), price, price, 1_000.0)
            db.commit()

    def dip(self, hhmm: str = "10:59") -> None:
        """A flat minute one dollar under VWAP: the close the next minute has to climb back over."""
        start = at(hhmm)
        with self.factory() as db:
            volume = db.get(Bar1m, ("NVDA", start)).volume
            below = self._vwap(db, start) - 1.0
            self._put(db, start, below, below, volume)
            db.commit()

    def arrive(self, hhmm: str = CUT) -> float:
        """The delayed minute that reclaims VWAP; returns its close."""
        start = at(hhmm)
        with self.factory() as db:
            before = db.get(Bar1m, ("NVDA", start - pd.Timedelta(minutes=1)))
            reclaim = self._vwap(db, start) + 1.0
            self._put(db, start, before.close, reclaim, before.volume)
            db.commit()
        return reclaim


@pytest.fixture
def world(real_servers):  # noqa: F811
    _, proxy_origin = real_servers
    reset_now()
    reset_database(os.environ["DESK_E2E_DATABASE_URL"], "technical")
    with httpx.Client(base_url=proxy_origin, headers=SESSION, timeout=10) as client:
        yield World(client)
    os.environ.pop(RUNTIME_FLAG, None)
    reset_now()


def test_technical_seed_is_the_shipped_state(world):
    assert world.get("/api/desk/status")["market"]["session"] == "closed"  # 20:00 ET, the clock's default
    strategies = world.get("/api/desk/alert-strategies")
    assert sorted(row["name"] for row in strategies) == [
        "Abnormal volume",
        "Hammer 15m near S1",
        "High-of-day break",
        "ORB 15m",
        "VWAP reclaim",
    ]
    assert {row["stage"] for row in strategies} == {"draft"}  # seeds ship as drafts
    assert len(world.get("/api/desk/screener/filters")) == 10
    assert [row["name"] for row in world.get("/api/desk/watchlists")] == ["Day movers", "Swing"]
    assert world.get("/api/desk/alerts") == [] and world.get("/api/desk/alerts/log") == []
    assert world.get("/api/desk/status")["alerts"]["state"] == "not_started"
    refused = world.client.post(f"/api/desk/alert-strategies/{world.strategy('VWAP reclaim')['id']}/resume")
    assert refused.status_code == 409  # the runtime flag is off: Turn on answers with the plain sentence
    assert "Alerts start when live quotes are connected" in refused.text
    bars = world.get("/api/desk/bars/NVDA?interval=15m&days=30")
    assert bars["quality"] == "delayed-15m" and len(bars["bars"]) == 52  # two sessions, as recorded


def test_seed_strategy_to_log_row_on_a_delayed_bar(world):
    world.turn_on("VWAP reclaim")
    world.cut_feed()
    world.dip()
    world.feed_ok("10:59")

    before = world.tick("11:15")  # the bar for 11:00 has not arrived
    assert before.new_signals == 0 and before.errors == []
    assert world.get("/api/desk/alerts") == []

    close = world.arrive()  # it arrives, 15 minutes late
    world.feed_ok("11:01")
    arrived = world.tick("11:16")
    assert arrived.new_signals == 1 and arrived.errors == []
    assert world.tick("11:16").new_signals == 0  # the same bar again writes nothing

    (alert,) = world.get("/api/desk/alerts")
    assert (alert["symbol"], alert["strategy_name"], alert["kind"]) == ("NVDA", "VWAP reclaim", "signal")
    assert alert["body"] == f"NVDA {close:.2f} at 11:01 AM"  # {symbol} {close} at {time}, time in ET
    assert world.get("/api/desk/dashboard")["signals"][0]["strategy_name"] == "VWAP reclaim"
    assert world.get("/api/desk/status")["alerts"]["unread"] == 1

    outcomes = world.dispatch("11:17")  # nothing is wired for Telegram in this runtime
    assert sorted(outcome.status for outcome in outcomes) == ["no_channel", "sent"]
    assert world.log() == [("VWAP reclaim", "inbox", "delivered"), ("VWAP reclaim", "telegram", "no_channel")]
    fires = world.get(f"/api/desk/alert-strategies/{world.strategy('VWAP reclaim')['id']}/fires")
    assert [fire["symbol"] for fire in fires] == ["NVDA"]


def test_quiet_hours_hold_a_delivery_until_they_end(world):
    world.turn_on("VWAP reclaim")
    world.cut_feed()
    world.dip()
    world.arrive()
    world.feed_ok("11:01")
    assert world.tick("11:16").new_signals == 1

    settings = world.get("/api/desk/settings")["settings"]
    saved = world.client.put("/api/desk/settings", json={"settings": {**settings, "quiet_hours": QUIET}})
    assert saved.status_code == 200
    telegram = Telegram()
    world.dispatch("11:17", {"telegram": telegram})
    assert telegram.sent == []  # inside 10:00-12:00 ET: held, not sent
    assert world.log() == [("VWAP reclaim", "inbox", "delivered"), ("VWAP reclaim", "telegram", "held_quiet_hours")]

    world.dispatch("12:01", {"telegram": telegram})  # the window is over: the held delivery goes out
    assert len(telegram.sent) == 1 and telegram.sent[0].startswith("NVDA ")
    assert world.log() == [("VWAP reclaim", "inbox", "delivered"), ("VWAP reclaim", "telegram", "delivered")]


def test_stale_data_pauses_alerts_and_recovery_does_not_burst(world):
    world.turn_on("VWAP reclaim")
    world.cut_feed()
    world.dip()
    close = world.arrive()  # a crossing bar is in the store...
    world.feed_ok("11:01")

    set_now(at("12:00"))  # ...but the feed has said nothing for 59 minutes
    stale = world.tick("12:00")
    assert stale.new_signals == 0 and stale.stale_symbols >= 1  # never alert on stale data
    status = world.get("/api/desk/status")
    assert status["alerts"]["state"] == "paused_no_quotes" and status["quotes"]["freshness"] == "paused"
    assert world.get("/api/desk/alerts") == []

    world.refill("11:01", "12:15", close)  # data returns; the 11:00 cross is far older than one bar
    world.feed_ok("12:15")
    recovered = world.tick("12:16")
    assert recovered.new_signals == 0  # no catch-up burst
    assert world.get("/api/desk/status")["alerts"]["state"] == "running"


def test_no_order_object_is_ever_built(world, monkeypatch):
    def no_order(*args, **kwargs):
        raise AssertionError("the alert path asked for an order plan")

    monkeypatch.setattr(sizing, "plan_order", no_order)
    monkeypatch.setattr(backtest, "plan_order", no_order)
    for name in ("VWAP reclaim", "ORB 15m"):
        world.turn_on(name)
    world.cut_feed()
    world.dip()
    world.arrive()
    world.feed_ok("11:01")
    assert world.tick("11:16").new_signals >= 1
    world.dispatch("11:17")

    paths = [path for path in app.openapi()["paths"] if path.startswith("/api/desk")]
    named = [path for path in paths if any(word in path for word in ("order", "position", "broker"))]
    assert paths and named == ["/api/desk/watchlists/{watchlist_id}/order"]  # reordering symbols, the one exception
    with app.state.e2e_engine.connect() as connection:
        tables = inspect(connection).get_table_names()
    assert not [name for name in tables if any(word in name for word in ("order", "position", "broker", "fill"))]

    refused = world.client.post(
        "/api/desk/alert-strategies",
        json={
            "save_as": "draft",
            "spec": {**world.strategy("VWAP reclaim")["spec"], "name": "Smuggled order", "then": _with_order()},
        },
    )
    assert refused.status_code == 422  # a `paperOrder` is not part of an alert strategy
    assert "paperOrder" in refused.text

    with world.factory() as db:
        specs = db.execute(select(StrategyVersion.spec)).scalars().all()
    assert specs and not any("paperOrder" in json.dumps(spec) for spec in specs)
    alerts = world.get("/api/desk/alerts")
    assert alerts and not any("order" in json.dumps(alert["payload"]) for alert in alerts)


def _with_order() -> dict:
    return {
        "alert": {"channels": ["inbox"], "severity": "info"},
        "paperOrder": {"side": "buy", "size": {"riskUsd": 100}, "stop": {"atrMultiple": 2}, "target": {"r": 2}},
    }
