"""Technical desktop MVP seed for the E2E harness (02m §d5): the production seed CLI's rows plus bars,
metrics and screener runs derived from the committed Run 0 snapshot (`tests/fixtures/desk-mvp`).

The snapshot's last close is Fri 2026-10-23; the E2E clock stands on Thu 2026-10-15 at 20:00 ET. Every
snapshot time therefore moves back by the same number of NYSE sessions (`SessionShift`), keeping each
time of day, so "today's" session in the browser is the snapshot's last session and nothing is in the
future of the frozen clock. Values are the snapshot's own; only the dates move.

What is stored, and by whom:

- **Bars** for SPY, NVDA and MSFT: daily and hourly rows as recorded, and 1-minute rows split out of the
  recorded 5-minute (last session, with its extended hours) and 15-minute (the session before) bars, so
  resampling to those intervals gives the recorded bars back.
- **Metrics and universe** for the 53 symbols the snapshot scanned, with the 15-minute bias label.
- **Screener runs** for the ten seed filters, as the scheduler would have stored them at the last close.
- **Feed health** fresh as of the clock, so a closed market reads "closed", not "unavailable".
- The user, her two watchlists, the ten seed filters and the five seed alert strategies come from
  `ai_trading.cli.seed_technical` unchanged (the strategies stay `draft`).

Nothing here places an order, and nothing calls a provider.
"""

import json
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import exchange_calendars as xcals
import pandas as pd
from clock import E2E_NOW
from sqlalchemy import select
from sqlalchemy.orm import Session

from ai_trading.alerts.runtime import DEFAULT_MESSAGE, delivery_channels
from ai_trading.cli.seed_technical import SeedReport, seed_user
from ai_trading.core.evaluate import SignalCandidate, render_message
from ai_trading.db.models import (
    Alert,
    Bar1d,
    Bar1h,
    Bar1m,
    FeedHealth,
    FilterMatch,
    FilterRun,
    FilterStrategy,
    FilterStrategyVersion,
    Strategy,
    StrategyVersion,
    SymbolMetrics,
    UniverseSymbol,
    User,
)
from ai_trading.engine.outbox import AlertSpec, record_signal
from ai_trading.notify.channel import ChannelError
from ai_trading.notify.dispatch import dispatch_pending

SNAPSHOT = Path(__file__).resolve().parents[1] / "fixtures" / "desk-mvp" / "snapshot_trimmed.json"
SNAPSHOT_LAST_SESSION = date(2026, 10, 23)
BAR_SYMBOLS = ("SPY", "NVDA", "MSFT")
ET = ZoneInfo("America/New_York")

# Display names for the symbols a spec reads on screen; the rest of the universe shows its ticker.
_NAMES = {
    "SPY": "SPDR S&P 500 ETF Trust",
    "QQQ": "Invesco QQQ Trust",
    "IWM": "iShares Russell 2000 ETF",
    "NVDA": "NVIDIA Corp",
    "MSFT": "Microsoft Corp",
    "AAPL": "Apple Inc",
    "AMD": "Advanced Micro Devices Inc",
    "TSLA": "Tesla Inc",
    "META": "Meta Platforms Inc",
    "AMZN": "Amazon.com Inc",
    "GOOGL": "Alphabet Inc",
    "AVGO": "Broadcom Inc",
    "PLTR": "Palantir Technologies Inc",
    "COIN": "Coinbase Global Inc",
    "CRWD": "CrowdStrike Holdings Inc",
    "SHOP": "Shopify Inc",
    "UBER": "Uber Technologies Inc",
}
_ETFS = frozenset({"SPY", "QQQ", "IWM", "BIL", "SCHD", "SPTI", "SPDN", "SOXL", "XLE", "KORU"})


@dataclass(frozen=True)
class SessionShift:
    """Moves snapshot dates back by a whole number of NYSE sessions, keeping times of day."""

    sessions: tuple[date, ...]
    offset: int

    @classmethod
    def for_now(cls, now: datetime) -> "SessionShift":
        calendar = xcals.get_calendar("XNYS")
        days = tuple(stamp.date() for stamp in calendar.sessions_in_range("2024-01-02", "2026-12-31"))
        today = now.astimezone(ET).date()
        if today not in days or today > SNAPSHOT_LAST_SESSION:
            raise RuntimeError("DESK_E2E_NOW must land on an XNYS session on or before the snapshot's last close")
        return cls(days, days.index(SNAPSHOT_LAST_SESSION) - days.index(today))

    def day(self, snapshot_day: date) -> date:
        return self.sessions[self.sessions.index(snapshot_day) - self.offset]

    def moment(self, text: str) -> datetime:
        """`'2026-10-23 15:45'` (snapshot ET text) to the shifted UTC instant."""
        day, _, clock = text.partition(" ")
        shifted = self.day(date.fromisoformat(day))
        return datetime.fromisoformat(f"{shifted.isoformat()} {clock or '00:00'}").replace(tzinfo=ET).astimezone(UTC)


def load_snapshot() -> dict[str, Any]:
    return json.loads(SNAPSHOT.read_text())


DAILY_HISTORY_BLOCKS = 5  # 60 recorded sessions x 5 = 300 closed daily bars, past the bias's 250 (`core.bias.MIN_BARS`)


def daily_history(rows: list[list[Any]], blocks: int = DAILY_HISTORY_BLOCKS) -> list[list[Any]]:
    """The recorded daily rows `[day, open, high, low, close, volume]` with earlier sessions in front: the same
    block repeated, each copy scaled so its last close meets the next block's first open. The snapshot trimmed
    its daily history to 60 sessions; the Desk Technical Bias needs 250 closed bars before it rates anything, so
    the daily gauges would otherwise always read "warming up" in the browser. Oldest first; the repeated blocks
    carry no date (`None`), the caller supplies the sessions before the recorded ones."""
    history: list[list[Any]] = []
    first_open = rows[0][1]
    for block in range(blocks - 1, 0, -1):
        scale = (first_open / rows[-1][4]) ** block
        history += [[None, *(price * scale for price in row[1:5]), row[5]] for row in rows]
        # Each earlier block ends where the next one starts, so continuity compounds block by block.
    return history + [list(row) for row in rows]


def split_minutes(start: datetime, row: list[float], parts: int) -> list[dict[str, Any]]:
    """One recorded bar as `parts` 1-minute bars: the open on the first, the close on the last, the high and
    the low on two different minutes, and the volume shared out evenly. Resampled, they are the recorded bar."""
    _, open_, high, low, close, volume = row
    path = [open_ + (close - open_) * (k + 1) / parts for k in range(parts)]
    bars = []
    for k in range(parts):
        before = open_ if k == 0 else path[k - 1]
        bars.append(
            {
                "bar_start": start + timedelta(minutes=k),
                "open": before,
                "high": max(before, path[k]),
                "low": min(before, path[k]),
                "close": path[k],
                "volume": volume / parts,
            }
        )
    bars[min(1, parts - 1)]["high"] = high
    bars[parts - 1]["low"] = low
    return bars


def seed_bars(session: Session, snapshot: dict[str, Any], shift: SessionShift) -> None:
    for symbol in BAR_SYMBOLS:
        recorded = snapshot["symbols"][symbol]["bars"]
        recorded_days = [date.fromisoformat(row[0]) for row in recorded["1d"]["rows"]]
        first = shift.sessions.index(shift.day(recorded_days[0]))
        earlier = list(shift.sessions[first - (DAILY_HISTORY_BLOCKS - 1) * len(recorded_days) : first])
        days = earlier + [shift.day(day) for day in recorded_days]
        for day, (_, open_, high, low, close, volume) in zip(days, daily_history(recorded["1d"]["rows"]), strict=True):
            session.add(
                Bar1d(
                    symbol=symbol,
                    day=day,
                    open=open_,
                    high=high,
                    low=low,
                    close=close,
                    volume=volume,
                    source="alpaca",
                )
            )
        for stamp, open_, high, low, close, volume in recorded["1h"]["rows"]:
            session.add(
                Bar1h(
                    symbol=symbol,
                    bar_start=shift.moment(stamp),
                    open=open_,
                    high=high,
                    low=low,
                    close=close,
                    volume=volume,
                    source="alpaca",
                )
            )
        last_day = SNAPSHOT_LAST_SESSION.isoformat()
        # The last session: its regular 5-minute bars plus the extended-hours ones the snapshot kept apart; the
        # session before it, from its 15-minute bars.
        sources = [(row, 5) for row in recorded["5m"]["rows"] + recorded["5m_extended_friday"]["rows"]] + [
            (row, 15) for row in recorded["15m"]["rows"] if not row[0].startswith(last_day)
        ]
        for row, parts in sources:
            for bar in split_minutes(shift.moment(row[0]), row, parts):
                session.add(Bar1m(symbol=symbol, source="alpaca", **bar))


def seed_universe_and_metrics(session: Session, snapshot: dict[str, Any], shift: SessionShift, now: datetime) -> None:
    as_of = shift.moment(f"{SNAPSHOT_LAST_SESSION.isoformat()} 16:00")
    bias = snapshot["bias_15m"]
    for symbol, metrics in sorted(snapshot["screener"]["metrics"].items()):
        session.add(
            UniverseSymbol(
                symbol=symbol,
                name=_NAMES.get(symbol, symbol),
                asset_type="etf" if symbol in _ETFS else "stock",
                exchange="US",
                active=True,
                passed_floor=True,
                floor_reason=None,
                updated_at=now,
            )
        )
        values = {**metrics, "bias_15m": bias[symbol]} if symbol in bias else dict(metrics)
        session.add(SymbolMetrics(symbol=symbol, as_of=as_of, source="alpaca", quality="delayed-15m", metrics=values))


def seed_filter_runs(
    session: Session, snapshot: dict[str, Any], shift: SessionShift, user_id: int, now: datetime
) -> int:
    """The snapshot's ten screeners stored as the scheduler's last pass: one run per seed filter, with its
    matches' columns copied from the stored metric rows, as `screener.runner` does."""
    stored = {row.symbol: row.metrics for row in session.execute(select(SymbolMetrics)).scalars()}
    rows = session.execute(
        select(FilterStrategy.seed_key, FilterStrategy.current_version_id).where(
            FilterStrategy.owner_user_id == user_id, FilterStrategy.origin == "seed"
        )
    ).all()
    versions = {key: version_id for key, version_id in rows}
    written = 0
    for key, recorded in snapshot["screener"]["screeners"].items():
        version = session.get(FilterStrategyVersion, versions[key])
        spec = version.spec
        matches = recorded["matches"]
        evaluation = shift.moment(matches[0]["evaluation_point"]) if matches else shift.moment("2026-10-23 16:00")
        run = FilterRun(
            filter_strategy_version_id=version.id,
            run_on=spec["watch"]["runOn"],
            session=spec["watch"]["session"],
            evaluation_point=evaluation,
            scanned=recorded["scanned"],
            no_data=recorded["no_data_on_eval_day"],
            matches_total=recorded["matches_total"],
            source="alpaca",
            quality="eod" if spec["watch"]["runOn"] in ("daily_close", "weekly") else "delayed-15m",
            created_at=min(now, evaluation + timedelta(minutes=1)),
        )
        session.add(run)
        session.flush()
        for rank, match in enumerate(matches, start=1):
            session.add(
                FilterMatch(
                    run_id=run.id,
                    symbol=match["symbol"],
                    rank=rank,
                    rank_value=match["rank_value"] if match["rank_value"] is not None else 0.0,
                    matched_since=shift.moment(match["matched_since"]),
                    operands=match["operands"],
                    columns=stored.get(match["symbol"], match["columns"]),
                )
            )
        written += 1
    return written


def seed_feeds(session: Session, now: datetime) -> None:
    """Both feeds answered a few minutes before the clock, as a healthy scheduler leaves them."""
    last_ok = now - timedelta(minutes=5)
    for feed in ("bars_delayed", "scan"):
        session.add(FeedHealth(feed=feed, state="ok", last_ok_at=last_ok, detail=None, updated_at=last_ok))


class _TelegramDouble:
    """A stand-in Telegram channel: sends, or fails every attempt when `fails`."""

    name = "telegram"

    def __init__(self, fails: bool = False) -> None:
        self.fails = fails

    def send(self, *, title: str, body: str, severity: str, **_: str) -> None:
        if self.fails:
            raise ChannelError("telegram is unreachable")


# (strategy name, time the bar starts (ET), minutes it covers, the channels wired when it was dispatched, quiet
# hours in force then). One log row of each kind (02m §a3.7) on the Telegram channel: no channel (nothing wired),
# failed (a channel that errors), delivered (a working one), and held for quiet hours (a working one, inside her
# window). Each pass also retries earlier held rows, so the held fire is the last in time and in this list.
_FIRES: tuple[tuple[str, str, int, dict[str, _TelegramDouble], dict[str, str] | None], ...] = (
    ("ORB 15m", "10:02", 1, {}, None),
    ("VWAP reclaim", "11:20", 1, {"telegram": _TelegramDouble(fails=True)}, None),
    ("High-of-day break", "14:10", 1, {"telegram": _TelegramDouble()}, None),
    ("Hammer 15m near S1", "15:15", 15, {"telegram": _TelegramDouble()}, {"start": "15:00", "end": "16:00"}),
)


def seed_alert_history(session: Session, user_id: int, shift: SessionShift, *, today: date | None = None) -> None:
    """Four NVDA fires of her seed strategies earlier in the last session, written through the runtime's own
    outbox (`record_signal`) and delivered through `dispatch_pending`, then the strategies that fired are
    `alert_only`. The fires are hand-built candidates on recorded bars: the evaluator's own path, from an
    arriving bar to a log row, is `technical_check.py`'s."""
    day = today or shift.day(SNAPSHOT_LAST_SESSION)
    user = session.get(User, user_id)
    original_settings = dict(user.settings)
    strategies = {
        row.name: (row, session.get(StrategyVersion, row.current_version_id))
        for row in session.execute(select(Strategy).where(Strategy.owner_user_id == user_id)).scalars()
    }
    for name, at, minutes, wired, quiet in _FIRES:
        strategy, version = strategies[name]
        alert = version.spec["then"]["alert"]
        start = datetime.fromisoformat(f"{day.isoformat()} {at}").replace(tzinfo=ET).astimezone(UTC)
        closed = start + timedelta(minutes=minutes)
        close = session.execute(
            select(Bar1m.close).where(Bar1m.symbol == "NVDA", Bar1m.bar_start == closed - timedelta(minutes=1))
        ).scalar_one()
        message = alert.get("message") or DEFAULT_MESSAGE
        body = render_message(message, "NVDA", close, pd.Timestamp(closed))
        record_signal(
            session,
            strategy_version_id=version.id,
            owner_user_id=user_id,
            symbol="NVDA",
            candidate=SignalCandidate("NVDA", pd.Timestamp(start), {"close": close}, body),
            data_quality="delayed-15m",
            alert=AlertSpec(channels=delivery_channels(alert["channels"]), severity=alert.get("severity") or "info"),
            now=closed,
            strategy_id=strategy.id,
            text=(f"NVDA: {name}", body),
            payload={"strategy": name, "bar_time": start.isoformat(), "evidence": {"close": close}},
        )
        strategy.stage = "alert_only"
        user.settings = {**original_settings, **({"quiet_hours": quiet} if quiet else {})}
        session.flush()
        dispatch_pending(session, channels=wired, now=closed + timedelta(minutes=1), sleep=lambda _: None)
    user.settings = original_settings
    first = session.execute(
        select(Alert).where(Alert.user_id == user_id).order_by(Alert.created_at).limit(1)
    ).scalar_one()
    first.read_at = first.created_at + timedelta(minutes=20)  # one read, the rest unread: the bell shows a count
    session.flush()


def seed_technical(session: Session, user_id: int, *, now: datetime = E2E_NOW, alerts: bool = False) -> SeedReport:
    """Everything above for one existing user; with `alerts`, her alert history too. The caller commits."""
    snapshot = load_snapshot()
    shift = SessionShift.for_now(now)
    report = seed_user(session, user_id, now=now)
    session.flush()
    seed_bars(session, snapshot, shift)
    seed_universe_and_metrics(session, snapshot, shift, now)
    session.flush()
    seed_filter_runs(session, snapshot, shift, user_id, now)
    seed_feeds(session, now)
    session.flush()
    if alerts:
        seed_alert_history(session, user_id, shift)
    return report


__all__ = ("BAR_SYMBOLS", "SessionShift", "load_snapshot", "seed_technical", "split_minutes")
