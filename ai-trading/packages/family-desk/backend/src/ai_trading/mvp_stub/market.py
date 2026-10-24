"""Stub builders for the market-data family (02m §a3.3, §a4): bars, technicals, chart markers, the quote
SSE event, and the signal feed. Plain dicts that FastAPI validates against the response models. Only
SPY, NVDA and MSFT exist in the fixture; any other symbol answers 404, as an unknown id does."""

from datetime import UTC, date, datetime, timedelta
from typing import Any

from fastapi import HTTPException

from ai_trading.mvp_stub import et_to_utc, et_to_utc_offset, snapshot, stamp, unavailable_stamp, world

_EXTENDED_FRIDAY = "5m_extended_friday"  # the only extended-hours series; session=extended reads it for 5m


def has_symbol(symbol: str) -> bool:
    return symbol in snapshot()["symbols"]


def _block(symbol: str) -> dict[str, Any]:
    if not has_symbol(symbol):
        raise HTTPException(status_code=404, detail="symbol not in the stub fixture")
    return snapshot()["symbols"][symbol]


def _cell(symbol: str, timeframe: str) -> dict[str, Any]:
    cell = _block(symbol)["timeframes"].get(timeframe)
    if cell is None:
        raise HTTPException(status_code=404, detail="timeframe not in the stub fixture")
    return cell


def _records(block: dict[str, Any]) -> list[dict[str, Any]]:
    """The snapshot's `{columns, rows}` form as one dict per bar."""
    return [dict(zip(block["columns"], row, strict=True)) for row in block["rows"]]


def _day(record: dict[str, Any]) -> str:
    return record["date"] if "date" in record else record["time_et"][:10]


def _instant(text: str) -> str:
    """A snapshot bar string as UTC `Z`. A bare date is that day's 00:00 UTC, as the daily bars are."""
    return f"{text}T00:00:00Z" if len(text) == 10 else et_to_utc(text)


def _aware(moment: datetime) -> datetime:
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


def _bar_t(record: dict[str, Any]) -> str:
    """The `t` of a bar exactly as the existing `/bars` route emits it: a daily bar is its bare date
    (`bar_as_of` of a `date`), an intraday bar is `isoformat()` of the UTC start (`+00:00`)."""
    if "date" in record:
        return record["date"]
    return et_to_utc_offset(record["time_et"])


def _extended(record: dict[str, Any]) -> bool:
    """Outside 09:30-16:00 ET. Daily bars are never extended."""
    if "date" in record:
        return False
    clock = record["time_et"][11:16]
    return clock < "09:30" or clock >= "16:00"


def bars(symbol: str, interval: str, days: int, session: str) -> dict[str, Any]:
    block = _block(symbol)
    name = _EXTENDED_FRIDAY if session == "extended" and interval == "5m" else interval
    series = block["bars"].get(name)
    if series is None:  # 1m, 30m, 4h, 1w: the snapshot has no bars for them
        return {
            "symbol": symbol,
            "interval": interval,
            "quality": "unavailable",
            "as_of": None,
            "bars": [],
            "stamp": unavailable_stamp(),
        }
    quality = block["timeframes"][interval]["quality"]
    records = _records(series)
    cutoff = (date.fromisoformat(_day(records[-1])) - timedelta(days=days - 1)).isoformat()
    out = [
        {
            "t": _bar_t(record),
            "o": record["o"],
            "h": record["h"],
            "l": record["l"],
            "c": record["c"],
            "v": record["v"],
            "ext": _extended(record),
        }
        for record in records
        if _day(record) >= cutoff
    ]
    return {
        "symbol": symbol,
        "interval": interval,
        "quality": quality,
        "as_of": out[-1]["t"],
        "bars": out,
        "stamp": stamp(quality=quality),
    }


def _levels(block: dict[str, Any]) -> dict[str, float | None]:
    """Prior close (the daily bar before the last session) and the last session's high and low (15m bars)."""
    intraday = _records(block["bars"]["15m"])
    last_day = _day(intraday[-1])
    today = [record for record in intraday if _day(record) == last_day]
    prior = [record for record in _records(block["bars"]["1d"]) if record["date"] < last_day]
    return {
        "prior_close": prior[-1]["c"] if prior else None,
        "session_high": max(record["h"] for record in today) if today else None,
        "session_low": min(record["l"] for record in today) if today else None,
    }


def _bias_history(raw: dict[str, Any]) -> dict[str, Any]:
    change = raw["last_change_in_window"]
    return {
        "history": [
            {
                "bar": _instant(entry["bar"]),
                "summary": entry["summary"],
                "score": entry["score"],
                "oscillators": entry["oscillators"],
                "moving_averages": entry["moving_averages"],
            }
            for entry in raw["history"]
        ],
        "last_change_in_window": None
        if change is None
        else {"from": change["from"], "to": change["to"], "at_bar": _instant(change["at_bar"])},
    }


def _strategies(symbol: str, timeframe: str) -> dict[str, Any] | None:
    if (symbol, timeframe) != ("NVDA", "15m"):
        return None
    return {
        "label": "Buy",
        "score": 0.33,
        "counts": {"buy": 2, "neutral": 0, "sell": 1},
        "votes": [
            {"strategy_id": 2, "name": "VWAP reclaim", "bias": "bullish", "vote": "buy"},
            {"strategy_id": 6, "name": "EMA 9/21 cross", "bias": "bullish", "vote": "buy"},
            {"strategy_id": 7, "name": "VWAP loss", "bias": "bearish", "vote": "sell"},
        ],
        "watching": [{"strategy_id": 1, "name": "ORB 15m"}],
    }


def technicals(symbol: str, timeframe: str) -> dict[str, Any]:
    cell = _cell(symbol, timeframe)
    out = dict(cell["technicals"])
    out["gauges"] = {**out["gauges"], "strategies": _strategies(symbol, timeframe)}
    out.update(
        timeframe=timeframe,
        bars_used=cell["bars_used"],
        first_bar=_instant(cell["first_bar"]),
        last_bar=_instant(cell["last_bar"]),
        bias_ready=cell["bias_ready"],
        indicators=cell["indicators"],
        bias_history=_bias_history(cell["bias_history"]),
        levels=_levels(_block(symbol)),
        stamp=stamp(quality=cell["quality"]),
    )
    return out


def _aware_or_none(value: datetime | None) -> datetime | None:
    return None if value is None else _aware(value)


def _in_range(moment: datetime, start: datetime | None, end: datetime | None) -> bool:
    return (start is None or moment >= start) and (end is None or moment <= end)


def markers(
    symbol: str, timeframe: str, all_patterns: bool, start: datetime | None, end: datetime | None
) -> dict[str, Any]:
    """Patterns exist only for the fixture symbols; fires exist for the signal feed's symbols, which overlap
    the fixture only partly, so an unknown symbol gets empty patterns and whatever fires it has."""
    start, end = _aware_or_none(start), _aware_or_none(end)
    patterns = []
    for occurrence in snapshot()["patterns"]["occurrences"]:
        if occurrence["symbol"] != symbol or occurrence["timeframe"] != timeframe:
            continue
        if not all_patterns and occurrence["pattern"] != "hammer":  # default: the attached-strategy patterns
            continue
        bar_start = datetime.fromisoformat(et_to_utc(occurrence["bar_start_et"]))
        if not _in_range(bar_start, start, end):
            continue
        patterns.append(
            {
                "pattern": occurrence["pattern"],
                "template": occurrence["template"],
                "bar_start": bar_start,
                "bar_close": datetime.fromisoformat(et_to_utc(occurrence["bar_close_et"])),
                "ohlc": occurrence["ohlc"],
            }
        )
    fires = []
    for signal in world.signals():
        bar_time = datetime.fromisoformat(signal["bar_time"])
        if signal["symbol"] == symbol and _in_range(bar_time, start, end):
            fires.append({"signal_id": signal["id"], "strategy_name": signal["strategy_name"], "bar_time": bar_time})
    return {"patterns": sorted(patterns, key=lambda item: item["bar_start"]), "fires": fires}


def latest_quote(symbol: str) -> dict[str, Any]:
    """The SSE quote for a fixture symbol: the last 15m bar's close, stamped with that bar's start."""
    row = _records(_block(symbol)["bars"]["15m"])[-1]
    return {
        "symbol": symbol,
        "close": row["c"],
        "quality": "delayed-15m",
        "as_of": et_to_utc(row["time_et"]),
        "freshness": "closed",
        "source": "alpaca",
        "session": "closed",
    }


def signal_rows(symbol: str | None, since: datetime | None, limit: int, offset: int) -> list[dict[str, Any]]:
    """The signal feed, newest first, in the `SignalOut` shape."""
    since = _aware_or_none(since)
    rows = [
        row
        for row in world.signals()
        if (symbol is None or row["symbol"] == symbol)
        and (since is None or datetime.fromisoformat(row["bar_time"]) >= since)
    ]
    rows.reverse()
    return [
        {
            "id": row["id"],
            "strategy_version_id": row["strategy_id"],
            "strategy_id": row["strategy_id"],
            "strategy_name": row["strategy_name"],
            "kind": row["kind"],
            "symbol": row["symbol"],
            "bar_time": row["bar_time"],
            "evidence": row["evidence"],
            "data_quality": "delayed-15m",
            "created_at": row["bar_time"],
        }
        for row in rows[offset : offset + limit]
    ]
