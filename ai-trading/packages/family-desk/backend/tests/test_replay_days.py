"""Notable days (02o decision 3, §i): the score, the tags, the percentile rank, and the incremental self-healing
refresh, on synthetic sessions with known shapes. Real Postgres."""

from dataclasses import dataclass, replace
from datetime import UTC, date, datetime

import numpy as np
import pandas as pd
import pytest
from ai_trading_common.bars import Bars
from ai_trading_common.errors import NoData
from ai_trading_common.registry import DataSources
from sqlalchemy import select
from sqlalchemy.orm import Session

from ai_trading.core.calendar import previous_session, session
from ai_trading.db.models import ReplayNotableDay, ReplaySession, User, Watchlist, WatchlistItem
from ai_trading.replay import days

COLUMNS = ("open", "high", "low", "close", "volume")
NOW = datetime(2026, 10, 24, 12, 0, tzinfo=UTC)
LOOKBACK = 30


def sessions_between(start: pd.Timestamp, end: pd.Timestamp) -> list[date]:
    first = start.tz_convert("America/New_York").date()
    last = end.tz_convert("America/New_York").date()
    out, cursor = [], first
    while cursor <= last:
        if session("stock", cursor) is not None:
            out.append(cursor)
        cursor = date.fromordinal(cursor.toordinal() + 1)
    return out


class Synthetic:
    """Flat days with a known shape: `wild` has big moves, `gap_up` opens 5% up, `heavy` trades 4x the volume."""

    def __init__(self, wild: date, gap_up: date, heavy: date) -> None:
        self.wild, self.gap_up, self.heavy = wild, gap_up, heavy
        self.calls: list[tuple[str, pd.Timestamp, pd.Timestamp, str]] = []
        self.minute_days: dict[date, tuple[float, float, float]] = {}

    def _day(self, day: date, prev_close: float) -> tuple[pd.DataFrame, float]:
        found = session("stock", day)
        index = pd.date_range(found.regular_open, found.regular_close, freq="1min", inclusive="left")
        rng = np.random.default_rng(day.toordinal())
        step = 0.0035 if day == self.wild else 0.0004
        opening = prev_close * (1.05 if day == self.gap_up else 1.0)
        close = opening * np.exp(np.cumsum(rng.normal(0, step, len(index))))
        frame = pd.DataFrame(
            {
                "open": np.concatenate([[opening], close[:-1]]),
                "high": close * 1.0005,
                "low": close * 0.9995,
                "close": close,
                "volume": 4000.0 if day == self.heavy else 1000.0,
            },
            index=index,
        )
        return frame, float(close[-1])

    def bars(self, symbol, timeframe, start, end, *, now, adjustment="all") -> Bars:
        self.calls.append((timeframe, start, end, adjustment))
        if symbol == "NOPE":
            raise NoData("synthetic", "unknown symbol")
        frames, price = [], 100.0
        # replay the whole history from a fixed origin so prices are the same whatever range is asked for
        for day in sessions_between(pd.Timestamp("2026-01-02T12:00:00Z"), pd.Timestamp("2026-11-30T12:00:00Z")):
            frame, price = self._day(day, price)
            frames.append((day, frame))
        wanted = [(d, f) for d, f in frames if f.index[0] >= start - pd.Timedelta(days=1) and f.index[-1] <= end]
        if timeframe == "1d":
            rows = {
                d: [f["open"].iloc[0], f["high"].max(), f["low"].min(), f["close"].iloc[-1], f["volume"].sum()]
                for d, f in wanted
            }
            return Bars(pd.DataFrame.from_dict(rows, orient="index", columns=COLUMNS), "synthetic", "eod")
        frame = pd.concat([f for _, f in wanted])
        return Bars(frame[(frame.index >= start) & (frame.index <= end)], "synthetic", "delayed-15m")


@dataclass
class Report:
    report_date: date
    report_time: str | None


class Calendar:
    def __init__(self, events: dict[str, list[Report]]) -> None:
        self.events = events

    def earnings_results(self, symbol, *, now):
        return self.events.get(symbol, [])


def sources(synthetic: Synthetic, events: dict[str, list[Report]] | None = None) -> DataSources:
    empty = DataSources(**{name: None for name in DataSources.__dataclass_fields__})
    chain = type("Chain", (), {"providers": [Calendar(events or {})]})()
    return replace(empty, bars=synthetic, earnings=chain)


@pytest.fixture(autouse=True)
def short_lookback(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(days, "LOOKBACK_SESSIONS", LOOKBACK)


def window() -> list[date]:
    return days.last_sessions(NOW, LOOKBACK)


def shape() -> tuple[date, date, date, date]:
    win = window()
    return win[-8], win[-15], win[-5], win[-3]  # wild, gap_up, heavy, earnings reaction


def test_last_sessions_are_the_finished_ones(db_session: Session) -> None:
    friday = days.last_sessions(datetime(2026, 10, 23, 20, 10, tzinfo=UTC), 2)
    assert friday[-1] == date(2026, 10, 22)  # 4:10 PM ET is inside the embargo: Friday is not finished yet
    assert days.last_sessions(datetime(2026, 10, 23, 20, 16, tzinfo=UTC), 1) == [date(2026, 10, 23)]


def test_score_ranks_and_tags(db_session: Session) -> None:
    wild, gap_up, heavy, reaction = shape()
    synthetic = Synthetic(wild, gap_up, heavy)
    events = {"AAA": [Report(previous_session("stock", reaction), "post")]}  # after the close: traded the next day
    added = days.refresh(db_session, sources(synthetic, events), now=NOW, symbols=["AAA"])
    assert added == {"AAA": LOOKBACK}
    rows = {r.day: r for r in db_session.execute(select(ReplayNotableDay)).scalars()}
    assert len(rows) == LOOKBACK
    top = max(rows.values(), key=lambda r: r.rv)
    assert top.day == wild and top.rv_pct_rank == round(100 * (LOOKBACK - 1) / LOOKBACK, 1)
    assert "gap_up" in rows[gap_up].tags and rows[gap_up].gap_pct == pytest.approx(5.0, abs=0.3)
    assert "heavy_volume" in rows[heavy].tags
    assert "earnings" in rows[reaction].tags
    assert not set(rows[window()[-2]].tags) & {"gap_up", "gap_down", "heavy_volume", "earnings"}
    assert sorted(r.rv_pct_rank for r in rows.values())[0] == 0.0


def test_refresh_is_incremental_and_a_second_run_fetches_nothing(db_session: Session) -> None:
    synthetic = Synthetic(*shape()[:3])
    days.refresh(db_session, sources(synthetic), now=NOW, symbols=["AAA"])
    synthetic.calls.clear()
    assert days.refresh(db_session, sources(synthetic), now=NOW, symbols=["AAA"]) == {"AAA": 0}
    assert synthetic.calls == []
    # one more session has finished: only that day is fetched, and the window slides (the oldest stays, unranked out)
    later = datetime(2026, 10, 26, 21, 0, tzinfo=UTC)
    days.refresh(db_session, sources(synthetic), now=later, symbols=["AAA"])
    minute_calls = [c for c in synthetic.calls if c[0] == "1m"]
    assert len(minute_calls) == 1
    assert minute_calls[0][1].tz_convert("America/New_York").date() == date(2026, 10, 26)
    ranks = [
        r.rv_pct_rank
        for r in db_session.execute(select(ReplayNotableDay).where(ReplayNotableDay.day >= window()[1])).scalars()
    ]
    assert max(ranks) <= 100.0


def test_a_symbol_the_provider_cannot_serve_is_skipped(db_session: Session) -> None:
    synthetic = Synthetic(*shape()[:3])
    added = days.refresh(db_session, sources(synthetic), now=NOW, symbols=["NOPE", "AAA"])
    assert added["NOPE"] == 0 and added["AAA"] == LOOKBACK


def test_list_days_is_spoiler_free_and_counts_attempts(db_session: Session) -> None:
    wild, gap_up, heavy, _ = shape()
    synthetic = Synthetic(wild, gap_up, heavy)
    user = User(email="owner@example.com", settings={})
    db_session.add(user)
    db_session.flush()
    watch = Watchlist(user_id=user.id, name="Day movers", horizon="intraday")
    db_session.add(watch)
    db_session.flush()
    db_session.add_all(
        [
            WatchlistItem(watchlist_id=watch.id, symbol=s, asset_type="stock", position=i)
            for i, s in enumerate(["AAA", "BBB"])
        ]
        + [WatchlistItem(watchlist_id=watch.id, symbol="ES", asset_type="future", position=2)]
    )
    db_session.flush()
    assert days.watchlist_symbols(db_session, user.id) == ["AAA", "BBB"]  # stocks only
    days.refresh(db_session, sources(synthetic), now=NOW, symbols=days.watchlist_symbols(db_session))
    db_session.add(
        ReplaySession(
            owner_user_id=user.id,
            symbol="AAA",
            day=wild,
            attempt=1,
            schema_version=1,
            spec={},
            armed=[],
            signals=[],
            window_start=NOW,
            window_end=NOW,
            revealed_through=NOW,
            tape_feed="sip",
            status="ended",
            created_at=NOW,
            updated_at=NOW,
        )
    )
    db_session.flush()
    out = days.list_days(db_session, user.id, symbol=None, limit=5, now=NOW)
    assert out["symbols"] == ["AAA", "BBB"] and out["lookback_sessions"] == LOOKBACK
    assert all(
        set(d) == {"symbol", "day", "weekday", "rank", "rv_pct_rank", "gap_pct", "tags", "attempts"}
        for d in out["days"]
    )
    assert [d["rank"] for d in out["days"]] == sorted(d["rank"] for d in out["days"])  # rank 1s first
    wild_row = next(d for d in out["days"] if d["symbol"] == "AAA" and d["day"] == wild.isoformat())
    assert wild_row["attempts"] == 1 and wild_row["rank"] == 1
    one = days.list_days(db_session, user.id, symbol="BBB", limit=3, now=NOW)
    assert len(one["days"]) == 3 and {d["symbol"] for d in one["days"]} == {"BBB"}
    assert out["stamp"]["freshness"] == "replay"
