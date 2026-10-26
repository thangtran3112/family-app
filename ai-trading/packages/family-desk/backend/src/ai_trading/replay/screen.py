"""The as-of screen (02o-b v1): her live filters, run for one past morning with no lookahead.

**The live screener is a pure function of its inputs and an `as_of` time.** `screener.evaluator.scan(spec, data,
as_of)` and `data.metrics.metric_row(daily, bars_1m)` read only the bars they are given. So a past morning's list is
the live code fed from the replay blob cache, with every input cut at the time she would have looked:

- `list_at` (ET) is the `as_of` the live runner would pass; `data_through = list_at - LIST_DATA_LAG`, because the
  live SIP feed withholds the newest 15 minutes (the live 08:30 premarket pass reads the 08:14 bar).
- **One cut, two consumers.** `cut_frames` is the only place bars are cut, and the cut object feeds both the scan
  (`Frames`) and `metric_row`. `metric_row` synthesizes a partial "today" from whatever minutes it is handed, so an
  uncut minute frame would leak the whole day into `last`, `volume`, `rvol_10d` and the VWAP fields.
- **Share basis.** The daily frame is Alpaca's split-adjusted series rebased to the day's own share basis
  (`rebase_split`): a split after the day does not change the list, and a split before it makes no false gap.
  Dividends are never applied, so an ex-dividend morning matches the live store, which did not hold that day's
  dividend yet.
- **The list price** is the price at the evaluating filter's cut (the 08:14 bar on a premarket list, the bar close
  at a cadence point, the last daily close for a daily filter) and not `metric_row.last`, which is the previous
  close on a premarket list.

`build_list` itself is pure: the caller supplies `daily_of` and `minutes_of`. The blob-cache readers that feed it
(`asof_frames`, `minutes_loader`) sit at the bottom and fetch a missing blob once, through `History`.
"""

import logging
import math
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

import numpy as np
import pandas as pd
from ai_trading_common.errors import ProviderError

from ai_trading.core import evaluate as engine
from ai_trading.core.calendar import session as trading_session
from ai_trading.data.metrics import AVG_VOLUME_DAYS, INTRADAY_LOOKBACK_DAYS, metric_row
from ai_trading.data.universe import MIN_AVG_VOLUME, MIN_DAILY_BARS, MIN_PRICE
from ai_trading.replay.cache import BlobKey, BlobStore, decode_daily, encode_daily
from ai_trading.replay.data import DAILY_BARS, EMBARGO, History, prior_sessions
from ai_trading.screener.columns import table_columns
from ai_trading.screener.evaluator import DAILY_RUN_ON, Frames, Match, SymbolBars, scan
from ai_trading.screener.runner import MINUTE_LOOKBACK_DAYS

log = logging.getLogger(__name__)

#: The live SIP embargo, imported (never a second 15). Set to 0 when the live Desk moves to real-time data, so
#: practice keeps matching what the live Desk showed at that time of the morning.
LIST_DATA_LAG = pd.Timedelta(EMBARGO)
#: Prior sessions of minutes a list reads: more than the 18 calendar days the live metric row asks for.
LIST_LOOKBACK_SESSIONS = 14
LIST_AT_MIN = "04:30"  # the contract's earliest list time (`practice_block` `list-time-range`)
ASOF_PART = "asof"
EARLIEST_LIST_DAY = date(2017, 1, 3)  # 252 sessions after the 2016-01-04 SIP floor
_PRICE_COLUMNS = ("open", "high", "low", "close")
_PREV_LABELS = {
    "last": "Prev close",
    "change_pct": "Prev change %",
    "volume": "Prev volume",
    "rvol_10d": "Prev RVOL",
    "gap_pct_open": "Prev gap %",
    "vs_vwap_pct": "Prev vs VWAP %",
}
_MINUTE = pd.Timedelta(minutes=1)


# -- price basis --------------------------------------------------------------------------------------------


def rebase_split(split: pd.DataFrame, raw: pd.DataFrame, day: date) -> pd.DataFrame | None:
    """The split-adjusted daily frame as it stood on `day`'s share basis, through the session before `day`.

    `split`: split-adjusted daily bars (date index) that include `day`; `raw`: raw daily bars that include `day`.
    Only two ratios are taken from `day`'s own bar, `raw / split` for price and for volume; they come from
    corporate actions known before the open, and `day`'s bar itself is dropped and never served. None when either
    frame has no bar for `day` (the symbol did not trade, or had not listed)."""
    if day not in split.index or day not in raw.index:
        return None
    adjusted, unadjusted = split.loc[day], raw.loc[day]
    if not adjusted["close"] or not adjusted["volume"]:
        return None
    price = float(unadjusted["close"]) / float(adjusted["close"])
    volume = float(unadjusted["volume"]) / float(adjusted["volume"])
    out = split[[d < day for d in split.index]].tail(DAILY_BARS).copy()
    out[list(_PRICE_COLUMNS)] = out[list(_PRICE_COLUMNS)] * price
    out["volume"] = out["volume"] * volume
    return out


# -- the cut -------------------------------------------------------------------------------------------------


def cut_frames(bars: SymbolBars, data_through: pd.Timestamp, lookback_days: int = INTRADAY_LOOKBACK_DAYS) -> SymbolBars:
    """The one cut: daily bars whose regular close is at or before `data_through`, and 1-minute bars that have
    closed by it, within `lookback_days` of it. Everything that reads a symbol's bars, the scan and `metric_row`
    alike, reads a cut of this helper. The lookback only trims old history: the scan reads the live runner's
    16 calendar days and the metric row the live metric job's 18, so each matches the store it would have read."""
    keep = [
        day
        for day in bars.daily.index
        if (found := trading_session("stock", day)) is not None and found.regular_close <= data_through
    ]
    daily = bars.daily.loc[keep].sort_index()
    minutes = bars.minutes
    if minutes is not None and len(minutes):
        since = data_through - pd.Timedelta(days=lookback_days)
        minutes = minutes[(minutes.index >= since) & (minutes.index + _MINUTE <= data_through)].sort_index()
        minutes = None if minutes.empty else minutes
    else:
        minutes = None
    return SymbolBars(daily, minutes)


def earliest_list_at(spec: dict[str, Any]) -> str:
    """The earliest list time ("HH:MM" ET) at which `spec` reads a bar of the list day itself.

    A daily filter reads the sessions before the day, so any list time works. `premarket_0830` needs its 08:30
    point. A cadence filter needs its first bar of the day closed and past the data lag: a regular-session bar
    opens at 09:30, an extended-session one at 04:00. Before then the scan would fall back to the previous
    session's last bar and present it as the morning's list (an empty one, usually)."""
    run_on = spec["watch"]["runOn"]
    if run_on in DAILY_RUN_ON:
        return LIST_AT_MIN
    if run_on == "premarket_0830":
        return "08:30"
    opens = 9 * 60 + 30 if spec["watch"]["session"] == "regular" else 4 * 60
    minutes = opens + engine.CADENCE_MINUTES[run_on] + int(LIST_DATA_LAG.total_seconds() // 60)
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def passes_floor(daily: pd.DataFrame) -> bool:
    """The live universe floor ($5 last close, 500,000 average volume over 20 sessions) on as-of daily bars."""
    return bool(
        float(daily["close"].iloc[-1]) >= MIN_PRICE
        and float(daily["volume"].iloc[-AVG_VOLUME_DAYS:].mean()) >= MIN_AVG_VOLUME
    )


# -- the list ------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class FilterInput:
    """One of her filters for a day: its dumped `FilterStrategySpecV1`, and the symbols it scans."""

    id: int
    version_id: int
    name: str
    spec: dict[str, Any]
    symbols: Sequence[str]


@dataclass
class BuiltList:
    list_at: pd.Timestamp
    data_through: pd.Timestamp
    prev_basis: bool  # no regular bar of the day exists at the cut, so the metric block is the previous session's
    candidates: list[dict[str, Any]] = field(default_factory=list)
    columns: list[dict[str, str]] = field(default_factory=list)
    universe: dict[str, int] = field(default_factory=dict)
    filters: list[dict[str, Any]] = field(default_factory=list)
    matches_total: int = 0


class _Bars(Mapping[str, SymbolBars]):
    """Cut `SymbolBars` for the floor survivors, built on first access and kept (the filters of a list share them)."""

    def __init__(
        self,
        daily: Mapping[str, pd.DataFrame],
        minutes_of: Callable[[str], pd.DataFrame | None],
        data_through: pd.Timestamp,
        *,
        minutes: bool,
    ) -> None:
        self._daily, self._minutes_of, self._through, self._wants_minutes = daily, minutes_of, data_through, minutes
        self._cut: dict[str, SymbolBars] = {}

    def __getitem__(self, symbol: str) -> SymbolBars:
        if symbol not in self._daily:
            raise KeyError(symbol)
        if symbol not in self._cut:
            minutes = self._minutes_of(symbol) if self._wants_minutes else None
            self._cut[symbol] = cut_frames(
                SymbolBars(self._daily[symbol], minutes), self._through, MINUTE_LOOKBACK_DAYS
            )
        return self._cut[symbol]

    def __iter__(self) -> Iterator[str]:
        return iter(self._daily)

    def __len__(self) -> int:
        return len(self._daily)


class _View(Mapping[str, SymbolBars]):
    """The part of `_Bars` one filter scans (its own `symbols` universe)."""

    def __init__(self, bars: Mapping[str, SymbolBars], symbols: Sequence[str]) -> None:
        self._bars = bars
        self._symbols = [s for s in dict.fromkeys(symbols) if s in bars]

    def __getitem__(self, symbol: str) -> SymbolBars:
        if symbol not in self._symbols:
            raise KeyError(symbol)
        return self._bars[symbol]

    def __iter__(self) -> Iterator[str]:
        return iter(self._symbols)

    def __len__(self) -> int:
        return len(self._symbols)


def _num(value: object, digits: int = 4) -> float | None:
    try:
        number = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return None if (math.isnan(number) or math.isinf(number)) else round(number, digits)


def _price_at_cut(
    frames: Frames, spec: dict[str, Any], match: Match, as_of: pd.Timestamp
) -> tuple[float, pd.Timestamp] | None:
    """The close and the close time of the bar the filter evaluated at: the 08:14 bar on a premarket list, the
    cadence bar at its close, the last daily close for a daily filter."""
    run_on, watch_session = spec["watch"]["runOn"], spec["watch"]["session"]
    frame = frames.get(run_on, watch_session)
    if frame is None:
        return None
    points = engine._points(run_on, frame, watch_session, as_of)
    if match.evaluation_point not in points.index:
        return None
    row = points.loc[match.evaluation_point]
    price = float(frame.bars.loc[row, "close"])
    if run_on in DAILY_RUN_ON:
        found = trading_session("stock", row)
        return price, (found.regular_close if found is not None else match.evaluation_point)
    closes_at = engine._bar_close(frame, run_on, row) if run_on in engine.CADENCE_MINUTES else row + _MINUTE
    return price, closes_at


def _columns(filters: Sequence[FilterInput], prev_basis: bool, with_change: bool) -> list[dict[str, str]]:
    """Her live table columns (`table_columns` over each filter's spec, merged in filter order). The list price
    leads; where the metric block is the previous session's it is labelled so, never passed off as the morning's."""
    merged: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in filters:
        for column in table_columns(item.spec):
            if column["key"] not in seen and column["key"] != "matched_since":
                seen.add(column["key"])
                merged.append(column)
    head = [{"key": "list_price", "label": "List price", "format": "price"}]
    if with_change:
        head.append({"key": "list_change_pct", "label": "vs prev close %", "format": "pct_signed"})
    out = []
    for column in merged:
        if column["key"] == "last" and not prev_basis:
            continue  # at the cut the list price is the last price
        label = _PREV_LABELS.get(column["key"], column["label"]) if prev_basis else column["label"]
        out.append({**column, "label": label})
    return [*head, *out, {"key": "matched_since", "label": "Since", "format": "time"}]


def build_list(
    *,
    filters: Sequence[FilterInput],
    daily_of: Callable[[str], pd.DataFrame | None],
    minutes_of: Callable[[str], pd.DataFrame | None],
    day: date,
    list_at: pd.Timestamp,
    max_list: int,
) -> BuiltList:
    """Run `filters` for the morning of `day` at `list_at` with every input cut at `list_at - LIST_DATA_LAG`.

    `daily_of(symbol)`: the day's rebased daily frame (strictly before `day`), or None. `minutes_of(symbol)`:
    1-minute bars of the day and its lookback sessions, uncut (the cut happens here, once, for everyone).
    The union is ordered by filter order then each filter's rank, deduplicated by symbol, and capped at `max_list`;
    it is never padded."""
    data_through = list_at - LIST_DATA_LAG
    found = trading_session("stock", day)
    assert found is not None
    prev_basis = data_through <= found.regular_open
    symbols = sorted({s for item in filters for s in item.symbols})
    intraday = any(item.spec["watch"]["runOn"] not in DAILY_RUN_ON for item in filters)

    usable: dict[str, pd.DataFrame] = {}
    no_data = below_floor = 0
    for symbol in symbols:
        daily = daily_of(symbol)
        cut = None if daily is None else cut_frames(SymbolBars(daily), data_through).daily
        if cut is None or len(cut) < MIN_DAILY_BARS:
            no_data += 1
        elif not passes_floor(cut):
            below_floor += 1
        else:
            usable[symbol] = daily  # type: ignore[assignment]
    bars = _Bars(usable, minutes_of, data_through, minutes=intraday)

    shared: dict[str, Frames] = {}

    def frames_for(symbol: str, symbol_bars: SymbolBars) -> Frames:
        if symbol not in shared:
            shared[symbol] = Frames(symbol_bars, list_at)
        return shared[symbol]

    picked: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    filter_rows: list[dict[str, Any]] = []
    extra_total = 0
    for item in filters:
        result = scan(item.spec, _View(bars, item.symbols), list_at, frames_for=frames_for)
        filter_rows.append(
            {
                "id": item.id,
                "version_id": item.version_id,
                "name": item.name,
                "scanned": result.scanned,
                "no_data": result.no_data,
                "matches_total": result.matches_total,
            }
        )
        extra_total += max(0, result.matches_total - len(result.matches))
        for match in result.matches:
            if match.symbol in picked:
                picked[match.symbol]["filters"].append(item.name)
                continue
            priced = _price_at_cut(shared[match.symbol], item.spec, match, list_at)
            if priced is None:
                continue
            picked[match.symbol] = {
                "symbol": match.symbol,
                "filters": [item.name],
                "rank_value": _num(match.rank_value),
                "matched_since": match.matched_since,
                "operands": match.operands,
                "list_price": _num(priced[0]),
                "price_at": priced[1],
                "daily_filter": item.spec["watch"]["runOn"] in DAILY_RUN_ON,
            }
            order.append(match.symbol)

    candidates = []
    for rank, symbol in enumerate(order[:max_list], start=1):
        row = picked[symbol]
        # The same helper and the same `data_through` as the scan; only the live metric job's wider lookback differs.
        inputs = cut_frames(SymbolBars(usable[symbol], minutes_of(symbol)), data_through)
        metrics = metric_row(inputs.daily, inputs.minutes)
        prior_close = float(inputs.daily["close"].iloc[-1])
        change = None if row.pop("daily_filter") else _num((row["list_price"] / prior_close - 1) * 100, 2)
        metrics = {**metrics, "list_price": row["list_price"], "list_change_pct": change}
        candidates.append({"rank": rank, **row, "prior_close": _num(prior_close), "metrics": metrics})

    with_change = any(c["metrics"]["list_change_pct"] is not None for c in candidates)
    return BuiltList(
        list_at=list_at,
        data_through=data_through,
        prev_basis=prev_basis,
        candidates=candidates,
        columns=_columns(filters, prev_basis, with_change),
        universe={
            "size": len(symbols),
            "scanned": len(usable),
            "no_data": no_data,
            "below_floor": below_floor,
        },
        filters=filter_rows,
        matches_total=len(order) + extra_total,
    )


# -- earnings flag --------------------------------------------------------------------------------------------


def reported_before_open(events: Sequence[tuple[date, str]], day: date) -> bool:
    """True when a report with an explicit time of day traded `day`'s session and was known by the open: a
    before-the-open report dated `day`, or an after-the-close report dated the session before. A report dated
    `day` after the close trades the next session, so it is not flagged; an undated time is skipped (the
    notable-days rule would peek at the day's own gap to place it).

    Only events within a few days of `day` can trade `day`'s session, so events outside that window are
    dropped before any calendar lookup: providers return full histories whose first reports predate the
    XNYS calendar (2015-01-02) and would raise DateOutOfBounds out of `reaction_days`."""
    from ai_trading.replay.days import reaction_days

    window = (day - timedelta(days=7), day + timedelta(days=7))
    near = [(report, timing) for report, timing in events if window[0] <= report <= window[1]]
    timed = [(report, timing) for report, timing in near if (timing or "").lower().startswith(("pre", "post"))]
    return day in reaction_days(timed, pd.Series(dtype=float))


# -- blob-cache readers --------------------------------------------------------------------------------------


def _empty_daily() -> pd.DataFrame:
    return pd.DataFrame({c: np.array([], dtype="float64") for c in (*_PRICE_COLUMNS, "volume")}, index=pd.Index([]))


def asof_frames(
    history: History, store: BlobStore, symbol: str, days: list[date], split: pd.DataFrame | None = None
) -> dict[date, pd.DataFrame | None]:
    """The rebased daily frame (through the session before each day) per day, from the blob cache. Missing days
    cost two requests in all: the raw daily range and the split-adjusted range. A day the symbol did not trade
    is stored as an empty frame, so it is asked about once. `split` is a split-adjusted frame that already covers
    every missing day (a swing thread holds one for its whole range): it saves the second request."""
    out: dict[date, pd.DataFrame | None] = {}
    missing = []
    for day in days:
        payload = store.get(BlobKey("bars1d", symbol, day, ASOF_PART, "sip"))
        if payload is None:
            missing.append(day)
        else:
            frame = decode_daily(payload)
            out[day] = frame if len(frame) else None
    if missing:
        raw = history.preload_daily(store, symbol, missing)
        if split is None:
            split = history.split_daily(symbol, missing[0], missing[-1])
        for day in missing:
            frame = rebase_split(split, raw[day], day) if len(raw[day]) else None
            out[day] = frame
            stored = frame if frame is not None else _empty_daily()
            payload, raw_bytes = encode_daily(stored)
            store.put(BlobKey("bars1d", symbol, day, ASOF_PART, "sip"), payload, len(stored), raw_bytes)
    return out


def asof_loader(history: History, store: BlobStore, day: date) -> Callable[[str], pd.DataFrame | None]:
    def load(symbol: str) -> pd.DataFrame | None:
        try:
            return asof_frames(history, store, symbol, [day])[day]
        except ProviderError as exc:  # one symbol's outage reads as no_data; it never fails the list
            log.warning("as-of daily bars unavailable for %s: %s", symbol, exc)
            return None

    return load


def list_sessions(day: date) -> list[date]:
    """The sessions a list on `day` reads minutes from: the day and its lookback (about three weeks of calendar)."""
    return [*prior_sessions(day, LIST_LOOKBACK_SESSIONS), day]


def minutes_loader(history: History, store: BlobStore, day: date) -> Callable[[str], pd.DataFrame | None]:
    sessions = list_sessions(day)

    def load(symbol: str) -> pd.DataFrame | None:
        try:
            frames = history.minute_bars(store, symbol, sessions)
        except ProviderError as exc:
            log.warning("minute bars unavailable for %s: %s", symbol, exc)
            return None
        parts = [frame for frame in frames.values() if len(frame)]
        return pd.concat(parts).sort_index() if parts else None

    return load
