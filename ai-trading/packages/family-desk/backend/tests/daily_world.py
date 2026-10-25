"""Synthetic bars for the daily-list tests: five sessions from Mon 2026-09-28 over three symbols (GAPPER gaps up 6% in
the premarket on two mornings, SPLITTER splits 2-for-1 after the third day, FLAT does nothing), served through the same
`bars` protocol the services use. All prices and volumes are made up."""

from dataclasses import replace
from datetime import UTC, date, datetime

import pandas as pd
from ai_trading_common.bars import Bars
from ai_trading_common.errors import NoData
from ai_trading_common.trades import Trades
from bars import daily_bars, minute_bars, trading_days
from fakes import fake_data_sources

from ai_trading.contracts.practice_thread import PracticeThreadCreateV1
from ai_trading.core.calendar import et
from ai_trading.replay import screen
from ai_trading.replay import threads as threads_mod
from ai_trading.replay.cache import MemoryBlobStore
from ai_trading.replay.data import History
from ai_trading.replay.session import Services
from ai_trading.replay.tape import Tape

NOW = datetime(2026, 10, 24, 16, 0, tzinfo=UTC)
# Five sessions from Mon 2026-09-28: the live scan reads 16 calendar days of minutes, which is ten sessions here.
DAYS = [date(2026, 9, 28), date(2026, 9, 29), date(2026, 9, 30), date(2026, 10, 1), date(2026, 10, 2)]
GAP_DAYS = {DAYS[0], DAYS[2]}  # GAPPER gaps up 6% in the premarket on these mornings
SYMBOLS = ["GAPPER", "SPLITTER", "FLAT"]


def _empty_trades() -> pd.DataFrame:
    return pd.DataFrame({"t": pd.DatetimeIndex([], tz="UTC"), "p": [], "s": [], "x": [], "c": []})


class EmptyTrades:
    def trades(self, symbol, start, end, *, feed, now=None):
        return Trades(frame=_empty_trades(), source="synthetic", feed=feed)


class SyntheticBars:
    """Raw and split-adjusted daily bars plus 1-minute bars, per symbol; any other symbol is `NoData`."""

    def __init__(self, raw, split, minutes) -> None:
        self.raw, self.split, self.minutes = raw, split, minutes
        self.calls: list[tuple[str, str, str]] = []

    def bars(self, symbol, timeframe, start, end, *, now, adjustment="all"):
        self.calls.append((symbol, timeframe, adjustment))
        if symbol not in self.raw:
            raise NoData("synthetic", "unknown symbol")
        if timeframe == "1d":
            frame = (self.split if adjustment == "split" else self.raw)[symbol]
            keep = [start.date() <= d <= end.date() for d in frame.index]
            return Bars(frame=frame[keep], source="synthetic", quality="eod")
        frame = self.minutes[symbol]
        part = frame[(frame.index >= start) & (frame.index <= end)]
        if part.empty:
            raise NoData("synthetic", "no bars")
        return Bars(frame=part, source="synthetic", quality="delayed-15m")


def _build_world() -> SyntheticBars:
    sessions = screen.list_sessions(DAYS[0])[:-1] + DAYS
    closes = {"GAPPER": [100.0] * 120, "FLAT": [50.0] * 120}
    raw, split = {}, {}
    last = trading_days("stock", DAYS[-1], 120)
    for symbol, values in closes.items():
        raw[symbol] = split[symbol] = daily_bars(last, values, volume=2_000_000)
    # SPLITTER splits 2-for-1 after DAYS[2]: raw closes halve from DAYS[3]; the split-adjusted series is all post-split.
    raw_split = [100.0 if d <= DAYS[2] else 50.0 for d in last]
    raw["SPLITTER"] = daily_bars(last, raw_split, volume=2_000_000)
    split["SPLITTER"] = daily_bars(last, [50.0] * 120, volume=4_000_000)
    split["SPLITTER"].loc[[d <= DAYS[2] for d in last], "volume"] = 4_000_000.0
    split["SPLITTER"].loc[[d > DAYS[2] for d in last], "volume"] = 2_000_000.0
    minutes = {}
    for symbol in ("GAPPER", "SPLITTER", "FLAT"):
        frames = []
        for day in sessions:
            price = {"GAPPER": 100.0, "FLAT": 50.0, "SPLITTER": 100.0 if day <= DAYS[2] else 50.0}[symbol]
            frame = minute_bars("stock", day, price=price, volume=1_000)
            if symbol == "GAPPER" and day in GAP_DAYS:
                pre = (frame.index >= et(day, "04:00")) & (frame.index < et(day, "09:30"))
                for column in ("open", "high", "low", "close"):
                    frame.loc[pre, column] = 106.0
                frame.loc[pre, "volume"] = 5_000.0
                reg = (frame.index >= et(day, "09:30")) & (frame.index < et(day, "11:30"))
                for column in ("open", "high", "low", "close"):
                    frame.loc[reg, column] = 110.0  # the move after the list: 106 to 110
            frames.append(frame)
        minutes[symbol] = pd.concat(frames)
    return SyntheticBars(raw, split, minutes)


def make_services(world: SyntheticBars | None = None) -> Services:
    sources = replace(fake_data_sources(), bars=world or _build_world(), trades=EmptyTrades())
    store = MemoryBlobStore()
    return Services(
        history=History(sources, now=lambda: NOW),
        tape=Tape(sources, now=lambda: NOW),
        now=lambda: NOW,
        store_factory=lambda _db: store,
        sources=sources,
    )


def make_thread(db, user_id: int, *, starting_balance: int = 50_000, **plan):
    """An active day thread for `user_id` (committed): the risk plan day sessions score against."""
    body = {
        "schemaVersion": 1,
        "mode": "day",
        "startingBalance": starting_balance,
        "plan": {"stopNoteOnEntry": "no", "tradeOnlyOnSignal": "no", **plan},
    }
    thread = threads_mod.create_thread(db, user_id, PracticeThreadCreateV1.model_validate(body), NOW)
    db.commit()
    return thread
