"""Build the response `stamp` (02m §a1) from the data's quality and the feed's health. Every endpoint
that carries market data goes through here, so freshness is computed in one place (`core/freshness.py`)."""

from datetime import UTC, datetime, timedelta

from ai_trading_common.quality import Quality
from sqlalchemy.orm import Session

from ai_trading.api.schemas.common import Stamp
from ai_trading.core.freshness import freshness, market_session
from ai_trading.db.models import FeedHealth


def feed_last_ok(db: Session, feed: str) -> datetime | None:
    """When the scheduler's refresher last updated `feed` (`bars_delayed`, `quotes_live`, `scan`)."""
    row = db.get(FeedHealth, feed)
    return None if row is None else row.last_ok_at


def make_stamp(
    *,
    quality: Quality,
    source: str | None,
    as_of: datetime | None,
    interval: timedelta,
    last_ok_at: datetime | None,
    now: datetime | None = None,
) -> Stamp:
    """`last_ok_at` is when the feed last answered. An on-demand provider read that just succeeded
    passes `now`; a stored read passes `feed_last_ok(...)`."""
    now = now or datetime.now(UTC)
    return Stamp(
        as_of=as_of,
        source=source,
        quality=quality,
        freshness=freshness(quality, market_session(now), last_ok_at, now, interval),
    )
