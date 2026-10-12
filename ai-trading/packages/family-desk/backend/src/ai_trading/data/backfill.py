"""Backfills the missing sessions for one symbol/timeframe from a `BarsSource`.

Glue between `ai_trading_common.sources.BarsSource` (a single provider or a registry chain --
the caller decides which, via `ai_trading_common.registry.DataSources`) and the bar store
(`ai_trading.data.bars`): `missing_sessions` finds the gaps, this module groups them into
contiguous trading-session ranges, fetches each range through the source, and `upsert_bars`s it
under the source's own returned `Bars.source` label. `ai_trading_common` never imports the Desk;
this is the one module on the Desk side that imports both packages -- and it imports only
`ai_trading_common.sources`/`errors`, never `ai_trading_common.providers` (02j §7: the import
boundary, enforced by `tests/test_import_boundary.py`).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

import pandas as pd
from ai_trading_common.errors import ProviderError
from ai_trading_common.sources import BarsSource
from sqlalchemy.orm import Session

from ai_trading.core.calendar import Asset, previous_session, session
from ai_trading.data.bars import Timeframe, missing_sessions, upsert_bars

#: Alpaca's free Basic plan history starts here (02b §2 finding 4). Stooq, the Desk's planned
#: pre-2016 fallback, was dropped after Lane P1 found its CSV endpoint gated behind a JS
#: proof-of-work challenge with no API key offered -- there is currently no substitute, so a
#: request reaching further back is clamped, never fabricated.
ALPACA_FREE_HISTORY_START = date(2016, 1, 1)


@dataclass(frozen=True)
class BackfillResult:
    """What one `backfill` call covered within `requested`.

    `written`: the missing sessions a provider call was attempted for without error (a session
    with genuinely no bars in its own range, e.g. a quiet day, still counts -- `upsert_bars`
    simply stores nothing for it; this is not treated as a failure).
    `uncovered`: missing sessions before `ALPACA_FREE_HISTORY_START`, clamped out of every
    provider call and never fabricated.
    """

    requested: tuple[date, date]
    written: list[date]
    uncovered: list[date]


def _contiguous_ranges(asset: Asset, days: list[date]) -> list[tuple[date, date]]:
    """Groups `days` (already sorted ascending, as `missing_sessions` returns them) into the
    fewest `[start, end]` ranges of *actually adjacent* trading sessions -- a gap where some
    other, non-missing session sits between two missing ones starts a new range, so each
    resulting range is truly contiguous on the exchange calendar, not just adjacent in the
    list."""
    if not days:
        return []
    ranges: list[list[date]] = [[days[0]]]
    for day in days[1:]:
        if previous_session(asset, day) == ranges[-1][-1]:
            ranges[-1].append(day)
        else:
            ranges.append([day])
    return [(group[0], group[-1]) for group in ranges]


def backfill(
    session_: Session,
    symbol: str,
    timeframe: Timeframe,
    asset: Asset,
    start: date,
    end: date,
    *,
    bars_source: BarsSource,
    now: pd.Timestamp,
) -> BackfillResult:
    """Fills every missing `symbol`/`timeframe` session in `[start, end]` from `bars_source`.

    A provider error (`ai_trading_common.errors.ProviderError` and its subclasses --
    `NotConfigured`, `Unavailable`, `SoftBanned`, `NoData`) propagates to the caller with its
    own type intact (never wrapped or swallowed), with a note attached naming the range the
    backfill was attempting when it failed (`exc.__notes__`, via `BaseException.add_note`).
    Every range upserted before that point is already applied to `session_` (not yet
    committed -- committing or rolling back is the caller's job, same as `upsert_bars`), so a
    caller that commits after catching the error keeps everything that did succeed.
    """
    missing = missing_sessions(session_, symbol, timeframe, asset, start, end)
    uncovered = [day for day in missing if day < ALPACA_FREE_HISTORY_START]
    to_fill = [day for day in missing if day >= ALPACA_FREE_HISTORY_START]

    written: list[date] = []
    for range_start, range_end in _contiguous_ranges(asset, to_fill):
        start_session = session(asset, range_start)
        end_session = session(asset, range_end)
        assert start_session is not None and end_session is not None  # missing_sessions only names real sessions

        try:
            bars = bars_source.bars(symbol, timeframe, start_session.extended_open, end_session.extended_close, now=now)
        except ProviderError as exc:
            exc.add_note(f"backfill stopped fetching {symbol} {timeframe} {range_start}..{range_end}")
            raise

        upsert_bars(session_, symbol, timeframe, bars.frame, bars.source, asset, now=now)
        written.extend(day for day in to_fill if range_start <= day <= range_end)

    return BackfillResult(requested=(start, end), written=written, uncovered=uncovered)


__all__ = ("ALPACA_FREE_HISTORY_START", "BackfillResult", "backfill")
