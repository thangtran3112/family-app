"""Synthetic bars for the swing-practice tests (02p): twelve stocks `S01`..`S12` plus `SPY` over 20 scripted sessions
from Mon 2026-09-14 (so `sessions=20` ends Fri 2026-10-09, finished by `NOW`), served through the same `bars` protocol
the services use (`daily_world.SyntheticBars`). All prices and volumes are made up.

History: 130 daily sessions ending at the last scripted session; 1-minute bars (extended hours) for every scripted
session and the 14 sessions before the first one. Session numbers below are 1-based within `DAYS`.

Every stock sits near a base price with a small deterministic wiggle (a few tenths of a percent, so ATR, RSI and the
week ranks are never degenerate) and trades 1.5 to 3 million shares a day, well above the live floor. A day runs
`open` to `close` in a straight line over the regular session; the premarket sits at the economic prior close and the
after-hours at the close. Scripted events, used by every swing test:

- `S01` gaps UP 6% at the open of session 4 (Thu 2026-09-17) and stays at the new level.
- `S02` gaps DOWN 8% at the open of session 7 (Tue 2026-09-22) and stays at the new level.
- `S03` splits 2-for-1 effective session 6 (Mon 2026-09-21): raw closes halve from that day, the split-adjusted series
  is all post-split, and the adjusted volume is doubled before the split (mirror of `daily_world.SPLITTER`).
- `S04` trends UP exactly 1% a day from session 1; `S05` trends DOWN exactly 1% a day from session 1.
- `SPY` is flat-ish like the rest (the benchmark; it is never in a universe).

The helpers below build the world, the services over it, an owner, a valid `SwingSetupV1` dict, and a swing thread.
`scrambled(world, last_kept)` returns a copy whose every bar after `last_kept`'s close is garbage (the replace-later-
data tests) while the two split ratios of each day stay what they were (a corporate action is known before the open).
"""

import functools
import math
import zlib
from datetime import UTC, date, datetime, timedelta

import numpy as np
import pandas as pd
from bars import trading_days
from daily_world import SyntheticBars, make_services
from sqlalchemy.orm import Session

from ai_trading.cli.seed_technical import seed_user
from ai_trading.contracts.practice_thread import PracticeThreadCreateV1
from ai_trading.core.calendar import et
from ai_trading.core.calendar import session as trading_session
from ai_trading.db.models import User
from ai_trading.replay import plan as plan_mod
from ai_trading.replay import swing

NOW = datetime(2026, 10, 24, 16, 0, tzinfo=UTC)
FIRST_DAY = date(2026, 9, 14)
HISTORY_SESSIONS = 130
LOOKBACK_SESSIONS = 14
SYMBOLS = [f"S{n:02d}" for n in range(1, 13)]
BENCHMARK = "SPY"
SOURCES = dict(zip(SYMBOLS, ["watchlist"] * 4 + ["manual"] * 2 + ["filter"] * 2 + ["liquidity"] * 4, strict=True))


def _scripted_days() -> list[date]:
    out, cursor = [], FIRST_DAY
    while len(out) < 20:
        if trading_session("stock", cursor) is not None:
            out.append(cursor)
        cursor += timedelta(days=1)
    return out


DAYS = _scripted_days()
GAP_UP_DAY, SPLIT_DAY, GAP_DOWN_DAY = DAYS[3], DAYS[5], DAYS[6]
HISTORY = trading_days("stock", DAYS[-1], HISTORY_SESSIONS)
BASE = {
    "S01": 100.0,
    "S02": 90.0,
    "S03": 50.0,  # the split-adjusted level; raw is 100 before the split
    "S04": 80.0,
    "S05": 120.0,
    "S06": 60.0,
    "S07": 70.0,
    "S08": 50.0,
    "S09": 40.0,
    "S10": 30.0,
    "S11": 25.0,
    "S12": 20.0,
    BENCHMARK: 400.0,
}
VOLUME = {symbol: 1_500_000.0 + 125_000.0 * i for i, symbol in enumerate(BASE)}


def _number(day: date) -> int:
    """1 for the first scripted session, 0 and below for the history before it."""
    return HISTORY.index(day) - (len(HISTORY) - len(DAYS)) + 1


def _economic_close(symbol: str, day: date) -> float:
    """The close on the share basis of the scripted window's end (split-adjusted), gaps and trends included."""
    k, i = _number(day), list(BASE).index(symbol)
    if symbol == "S04":
        return round(BASE[symbol] * 1.01 ** max(k, 0), 4)
    if symbol == "S05":
        return round(BASE[symbol] * 0.99 ** max(k, 0), 4)
    level = {"S01": 1.06 if day >= GAP_UP_DAY else 1.0, "S02": 0.92 if day >= GAP_DOWN_DAY else 1.0}.get(symbol, 1.0)
    return round(BASE[symbol] * (1 + 0.003 * math.sin(0.7 * k + i)) * level, 4)


def _raw_factor(symbol: str, day: date) -> float:
    return 2.0 if symbol == "S03" and day < SPLIT_DAY else 1.0


def _economic_open(symbol: str, day: date) -> float:
    """The open: the prior close, except on the two gap mornings."""
    previous = HISTORY[HISTORY.index(day) - 1]
    close = _economic_close(symbol, previous)
    return round(close * {("S01", GAP_UP_DAY): 1.06, ("S02", GAP_DOWN_DAY): 0.92}.get((symbol, day), 1.0), 4)


def _daily(symbol: str, *, raw: bool) -> pd.DataFrame:
    rows = []
    for day in HISTORY[1:]:
        close, open_ = _economic_close(symbol, day), _economic_open(symbol, day)
        volume = VOLUME[symbol]
        if symbol == "S03" and not raw and day < SPLIT_DAY:
            volume *= 2  # the adjusted series carries the split's doubled share count
        factor = _raw_factor(symbol, day) if raw else 1.0
        rows.append((open_ * factor, max(open_, close) * factor, min(open_, close) * factor, close * factor, volume))
    return pd.DataFrame(rows, index=pd.Index(HISTORY[1:]), columns=["open", "high", "low", "close", "volume"])


def _minutes(symbol: str) -> pd.DataFrame:
    frames = []
    for day in HISTORY[-(len(DAYS) + LOOKBACK_SESSIONS) :]:
        found = trading_session("stock", day)
        index = pd.date_range(found.extended_open, found.extended_close, freq="1min", inclusive="left")
        factor = _raw_factor(symbol, day)
        previous = _economic_close(symbol, HISTORY[HISTORY.index(day) - 1])
        open_, close = _economic_open(symbol, day), _economic_close(symbol, day)
        # Gaps happen at the regular open: the premarket still sits at the prior close.
        regular = (index >= found.regular_open) & (index < found.regular_close)
        after = index >= found.regular_close
        price = np.full(len(index), previous)
        price[regular] = np.linspace(open_, close, int(regular.sum()))
        price[after] = close
        price = price * factor
        frames.append(
            pd.DataFrame({"open": price, "high": price, "low": price, "close": price, "volume": 1_000.0}, index=index)
        )
    return pd.concat(frames)


@functools.cache
def _frames() -> tuple[dict[str, pd.DataFrame], dict[str, pd.DataFrame], dict[str, pd.DataFrame]]:
    raw = {symbol: _daily(symbol, raw=True) for symbol in BASE}
    split = {symbol: _daily(symbol, raw=False) for symbol in BASE}
    minutes = {symbol: _minutes(symbol) for symbol in SYMBOLS}
    return raw, split, minutes


def swing_world() -> SyntheticBars:
    """A fresh world over the shared (never mutated) frames: a test may swap a symbol's frame in its own copy."""
    raw, split, minutes = _frames()
    return SyntheticBars(dict(raw), dict(split), dict(minutes))


def scrambled(world: SyntheticBars, last_kept: date) -> SyntheticBars:
    """`world` with every bar after `last_kept`'s regular close replaced by garbage: the minutes of later sessions and
    the daily bars of later days (scaled by one factor per symbol and day, the same in the raw and the split series, so
    the day's raw/split ratios survive: they are corporate actions known before the open)."""

    def factor(symbol: str, day: date) -> float:
        return 0.3 + (zlib.crc32(f"{symbol}{day}".encode()) % 1000) / 1000

    def daily(frames: dict[str, pd.DataFrame]) -> dict[str, pd.DataFrame]:
        out = {}
        for symbol, frame in frames.items():
            scale = pd.Series([1.0 if d <= last_kept else factor(symbol, d) for d in frame.index], index=frame.index)
            out[symbol] = frame.mul(scale, axis=0)
        return out

    minutes = {}
    for symbol, frame in world.minutes.items():
        days = frame.index.tz_convert("America/New_York").date
        by_day = {d: 1.0 if d <= last_kept else factor(symbol, d) for d in set(days)}
        minutes[symbol] = frame.mul(np.fromiter((by_day[d] for d in days), dtype=float, count=len(days)), axis=0)
    return SyntheticBars(daily(world.raw), daily(world.split), minutes)


def swing_services(world: SyntheticBars | None = None):
    return make_services(world or swing_world())


def make_owner(db: Session, email: str = "swing-owner@example.com") -> int:
    """A committed user with the seed watchlists and filters, as the replay tests' `user_id` fixture."""
    user = User(email=email, settings={})
    db.add(user)
    db.flush()
    seed_user(db, user.id, now=NOW)
    db.commit()
    return user.id


def swing_setup(**overrides) -> dict:
    """A valid `SwingSetupV1` dict: the first day, 15 sessions, all twelve stocks with their sources, 15m, tape off."""
    setup = {
        "firstDay": FIRST_DAY.isoformat(),
        "sessions": 15,
        "hideDates": "yes",
        "universe": [{"symbol": symbol, "source": SOURCES[symbol]} for symbol in SYMBOLS],
        "interval": "15m",
        "tape": "off",
        "armed": [],
        "maxOpenHolds": 3,
    }
    return {**setup, **overrides}


def swing_create(*, balance: int = 50_000, plan: dict | None = None, **overrides) -> PracticeThreadCreateV1:
    """The `PracticeThreadCreateV1` of a swing thread: `overrides` change the swing block, `plan` the risk plan."""
    return PracticeThreadCreateV1.model_validate(
        {
            "schemaVersion": 1,
            "mode": "swing",
            "startingBalance": balance,
            "plan": {"stopNoteOnEntry": "no", "tradeOnlyOnSignal": "no", **(plan or {})},
            "swing": swing_setup(**overrides),
        }
    )


def create_swing_thread(
    db: Session, user_id: int, svc, *, balance: int = 50_000, plan: dict | None = None, **overrides
):
    """A committed active swing thread and its plan row: `(thread, plan)`."""
    thread, row = swing.create_thread(db, user_id, swing_create(balance=balance, plan=plan, **overrides), svc)
    db.commit()
    return thread, row


def ready_thread(db: Session, user_id: int, svc, **kwargs):
    """`create_swing_thread` plus its prep run to the end, so every day of the plan can open: `(thread, plan)`."""
    thread, row = create_swing_thread(db, user_id, svc, **kwargs)
    plan_mod.run_prep(db, svc, row.id)
    return thread, row


def bar_close(world: SyntheticBars, symbol: str, day: date, hhmm: str) -> float:
    """The RAW close of the one-minute bar that STARTS at `hhmm` ET on `day` (a hold's prices are raw)."""
    return float(world.minutes[symbol].loc[et(day, hhmm), "close"])
