"""The one place that turns data quality, market session, and update age into a freshness state (02m
§b3, 02l §c3). The UI never computes freshness: every stamp the API returns carries the value from
here.

The states map one to one onto the 02l §c3 badges. "Updating" and "Reconnecting" are client states
(a request in flight, an SSE connection down) and are not values here. The "backup source" badge
follows `quality == "fallback"` and is independent of the state.
"""

from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Literal

import pandas as pd
from ai_trading_common.quality import Quality

from ai_trading.core.calendar import ET, previous_session, session

#: "replay" is never computed here: the Practice lane stamps it on its own responses (02o §b1).
Freshness = Literal["live", "delayed", "closed", "paused", "unavailable", "replay"]
MarketSession = Literal["pre", "regular", "after", "closed"]

#: 02m §b3: no update past `max(120 s, 2 x bar interval)` is "paused".
MIN_PAUSE_SECONDS = 120.0
_LOOKAHEAD_DAYS = 10  # a stock exchange is never closed for ten sessions in a row


def pause_limit(interval: timedelta) -> timedelta:
    return max(timedelta(seconds=MIN_PAUSE_SECONDS), 2 * interval)


def freshness(
    quality: Quality,
    market_session: MarketSession,
    last_ok_at: datetime | None,
    now: datetime,
    interval: timedelta,
) -> Freshness:
    """`last_ok_at` is when the feed last updated successfully (`feed_health.last_ok_at`), `interval`
    the bar interval the consumer reads. Checked in order, first match wins:

    1. `unavailable`: the provider chain failed (quality "unavailable"), or the feed never worked.
    2. `closed`: the market session is closed, whatever the quality.
    3. `paused`: no update within `pause_limit(interval)`.
    4. `live`: realtime quality (an IBKR quote); every other quality (delayed-15m, eod, fallback)
       is `delayed`, because a backup source is never IBKR-fresh.

    02l §c3 describes live as "within 5 s". Only the pause limit says a realtime source has stopped,
    so a quiet realtime symbol (one trade a minute) stays `live` until that limit; a hard 5 s cut
    would flicker it to "Delayed 15 min", which is wrong text for a realtime source.
    """
    if quality == "unavailable" or last_ok_at is None:
        return "unavailable"
    if market_session == "closed":
        return "closed"
    if now - last_ok_at > pause_limit(interval):
        return "paused"
    if quality == "realtime":
        return "live"
    return "delayed"


@dataclass(frozen=True)
class MarketState:
    session: MarketSession
    next_open: datetime  # UTC, the next regular open strictly after `now`
    last_close: datetime  # UTC, the latest regular close at or before `now`


def market_session(now: datetime) -> MarketSession:
    """`pre` 04:00-09:30 ET, `regular` to the close (13:00 on half days), `after` to four hours past
    the close, otherwise `closed` (overnight, weekends, holidays). US stocks only: futures read
    `unavailable` until the IBKR slot is live."""
    found = session("stock", now.astimezone(ET).date())
    if found is None:
        return "closed"
    stamp = pd.Timestamp(now)
    if stamp < found.extended_open or stamp >= found.extended_close:
        return "closed"
    if stamp < found.regular_open:
        return "pre"
    if stamp < found.regular_close:
        return "regular"
    return "after"


def market_state(now: datetime) -> MarketState:
    day: date = now.astimezone(ET).date()
    stamp = pd.Timestamp(now)
    next_open = last_close = None
    for offset in range(_LOOKAHEAD_DAYS):
        found = session("stock", day + timedelta(days=offset))
        if found is not None and found.regular_open > stamp:
            next_open = found.regular_open.to_pydatetime()
            break
    day_back = day + timedelta(days=1)  # the session whose date is today may not have closed yet
    for _ in range(_LOOKAHEAD_DAYS):
        day_back = previous_session("stock", day_back)
        found = session("stock", day_back)
        if found is not None and found.regular_close <= stamp:
            last_close = found.regular_close.to_pydatetime()
            break
    if next_open is None or last_close is None:
        raise ValueError(f"no NYSE session within {_LOOKAHEAD_DAYS} days of {now.astimezone(UTC).isoformat()}")
    return MarketState(market_session(now), next_open, last_close)
