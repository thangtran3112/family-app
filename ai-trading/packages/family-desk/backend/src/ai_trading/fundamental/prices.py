"""The two price reads the Fundamental services share (02n §d): a spot from the registry's `quotes` kind (Alpaca, 15
minutes delayed) for the covered-call math, and the stored daily closes for a holdings row (a close and the one
before it, so a change needs no second source). A symbol nothing answers for is absent from the result, never filled
in: the caller turns that into a null value and the unavailable stamp."""

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any

import pandas as pd
from ai_trading_common.errors import ProviderError
from ai_trading_common.quality import Quality
from ai_trading_common.registry import DataSources
from sqlalchemy import select
from sqlalchemy.orm import Session

from ai_trading.api.stamp import make_stamp
from ai_trading.core.calendar import ET
from ai_trading.data.bars import bar_close
from ai_trading.db.models import Bar1d

_QUOTE_INTERVAL = timedelta(minutes=15)
_CLOSE_INTERVAL = timedelta(days=1)
_CLOSE_LOOKBACK_DAYS = 14  # two closes are always within two weeks of a stored daily series


@dataclass(frozen=True)
class Price:
    last: float
    prev_close: float | None  # None for a quote: it carries no previous close
    as_of: datetime  # UTC
    source: str
    quality: Quality

    @property
    def change_pct(self) -> float | None:
        return None if not self.prev_close else round((self.last / self.prev_close - 1) * 100, 4)


def unavailable_stamp() -> dict[str, Any]:
    """Nothing was ever read: no time, no source (a plain dict, like every builder here; FastAPI validates it)."""
    return {"as_of": None, "source": None, "quality": "unavailable", "freshness": "unavailable"}


def stamp_of(price: Price | None, now: datetime) -> dict[str, Any]:
    """The stamp of a price just read: a quote or a stored close read now has `last_ok_at = as_of` for a close (its
    own age is what freshness measures) and `now` for a quote (the provider answered now)."""
    if price is None:
        return unavailable_stamp()
    stored = price.quality == "eod"
    return make_stamp(
        quality=price.quality,
        source=price.source,
        as_of=price.as_of,
        interval=_CLOSE_INTERVAL if stored else _QUOTE_INTERVAL,
        last_ok_at=price.as_of if stored else now,
        now=now,
    ).model_dump()


def spot_prices(sources: DataSources, symbols: Sequence[str], now: datetime) -> dict[str, Price]:
    """The latest quote of each symbol. A provider failure (no key, a rejected key, an outage) is an empty result: the
    covered-call numbers then say unavailable instead of using a stale or invented spot."""
    wanted = sorted(set(symbols))
    if not wanted:
        return {}
    try:
        quotes = sources.quotes.latest(wanted, now=pd.Timestamp(now))
    except ProviderError:
        return {}
    return {
        q.symbol: Price(float(q.price), None, q.as_of.to_pydatetime(), q.provider, q.quality)
        for q in quotes
        if q.symbol in wanted and q.price > 0
    }


def close_prices(db: Session, symbols: Sequence[str], now: datetime) -> dict[str, Price]:
    """The newest stored daily close of each symbol that had closed by `now`, with the one before it."""
    wanted = sorted(set(symbols))
    if not wanted:
        return {}
    since: date = now.astimezone(ET).date() - timedelta(days=_CLOSE_LOOKBACK_DAYS)
    bars = db.execute(
        select(Bar1d).where(Bar1d.symbol.in_(wanted), Bar1d.day >= since).order_by(Bar1d.symbol, Bar1d.day.desc())
    ).scalars()
    stamp = pd.Timestamp(now)
    closed: dict[str, list[tuple[Bar1d, datetime]]] = {}
    for bar in bars:
        at = bar_close("stock", "1d", bar.day).to_pydatetime().astimezone(UTC)
        if at <= stamp and bar.close > 0:
            closed.setdefault(bar.symbol, []).append((bar, at))
    return {
        symbol: Price(
            float(rows[0][0].close),
            float(rows[1][0].close) if len(rows) > 1 else None,
            rows[0][1],
            rows[0][0].source,
            "eod",
        )
        for symbol, rows in closed.items()
    }
