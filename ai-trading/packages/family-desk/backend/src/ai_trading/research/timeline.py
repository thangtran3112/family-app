"""The holding timeline of one stock (02n §c3 #15, §d `research/timeline.py`, 02h §5): a newest-first read model over
what the Desk already stores or can ask a provider for, with no new source.

Kinds emitted: `earnings` (the stored reported-vs-estimated rows and the next report), `consensus` (each change of the
current fiscal year's EPS estimate between two daily snapshots), `filing` (8-K Item 2.02 earnings releases), `news`
(the last 30 days of headlines) and `strategy` (this user's alerts on the symbol). `desk_ai` waits for step 5 and
`macro` for the futures lane, so neither is ever emitted. A link is set only where the provider's own record carries
one; a provider that fails drops its kind from the list instead of failing the request.
"""

from datetime import UTC, date, datetime, timedelta
from typing import Any

import pandas as pd
from ai_trading_common.errors import ProviderError
from ai_trading_common.registry import DataSources
from sqlalchemy import select
from sqlalchemy.orm import Session

from ai_trading.db.models import Alert, ConsensusSnapshot, EarningsResult
from ai_trading.research.service import current_fiscal_year, period_label, timing_text, today_et

FILING_DAYS = 365
NEWS_DAYS = 30
ALERT_LIMIT = 50
_SOURCE_NAMES = {
    "sec_edgar": "SEC EDGAR",
    "finnhub": "Finnhub",
    "eulerpool": "Eulerpool",
    "alphavantage": "Alpha Vantage",
}


def _at(day: date) -> datetime:
    return datetime(day.year, day.month, day.day, tzinfo=UTC)


def _source(provider: str) -> str:
    return _SOURCE_NAMES.get(provider, provider)


def _earnings(db: Session, symbol: str, today: date) -> list[dict[str, Any]]:
    out = []
    for row in db.scalars(select(EarningsResult).where(EarningsResult.symbol == symbol)):
        source = _source(row.provider)
        if row.eps_actual is not None:
            label = period_label("Q", row.fiscal_year, row.fiscal_quarter, row.period_end)
            vs = "" if row.eps_estimate is None else f" vs {row.eps_estimate:.2f} estimate"
            out.append(
                {
                    "at": _at(row.report_date or row.period_end),
                    "kind": "earnings",
                    "title": f"Reported {label}: EPS {row.eps_actual:.2f}{vs}",
                    "detail": "" if row.surprise_percent is None else f"Surprise {row.surprise_percent:+.1f}%",
                    "source": source,
                    "href": None,
                }
            )
        elif row.report_date is not None and row.report_date >= today:
            estimate = "" if row.eps_estimate is None else f" · EPS estimate {row.eps_estimate:.2f}"
            out.append(
                {
                    "at": _at(row.report_date),
                    "kind": "earnings",
                    "title": "Reports earnings",
                    "detail": f"{timing_text(row.report_time).capitalize()}{estimate}",
                    "source": source,
                    "href": None,
                }
            )
    return out


def _consensus(db: Session, symbol: str, today: date) -> list[dict[str, Any]]:
    current = current_fiscal_year(db, symbol, today)
    if current is None:
        return []
    rows = db.scalars(
        select(ConsensusSnapshot)
        .where(
            ConsensusSnapshot.symbol == symbol,
            ConsensusSnapshot.period_kind == "annual",
            ConsensusSnapshot.period_end == current[0],
        )
        .order_by(ConsensusSnapshot.snapshot_date)
    ).all()
    out = []
    for before, after in zip(rows, rows[1:], strict=False):
        if before.eps_mean is None or after.eps_mean is None or before.eps_mean == after.eps_mean:
            continue
        pct = (after.eps_mean - before.eps_mean) / abs(before.eps_mean) * 100 if before.eps_mean else None
        label = period_label("FY", after.fiscal_year, None, after.period_end)
        out.append(
            {
                "at": _at(after.snapshot_date),
                "kind": "consensus",
                "title": f"{label} EPS estimate {before.eps_mean:.2f} to {after.eps_mean:.2f}",
                "detail": "" if pct is None else f"{pct:+.1f}% since {before.snapshot_date.isoformat()}",
                "source": "Desk snapshot",
                "href": None,
            }
        )
    return out


def _filings(sources: DataSources, symbol: str, today: date) -> list[dict[str, Any]]:
    try:
        found = sources.earnings_announcements.announcements(symbol, since=today - timedelta(days=FILING_DAYS))
    except ProviderError:
        return []
    return [
        {
            "at": _at(item.announced_on),
            "kind": "filing",
            "title": "Earnings release filed (8-K)",
            "detail": "Item 2.02, results of operations and financial condition",
            "source": _source(item.provider),
            "href": None,  # the provider's record names the filing, not a URL
        }
        for item in found
    ]


def _news(sources: DataSources, symbol: str, today: date) -> list[dict[str, Any]]:
    try:
        found = sources.news.news(symbol, today - timedelta(days=NEWS_DAYS), today)
    except ProviderError:
        return []
    return [
        {
            "at": pd.Timestamp(item.published_at).to_pydatetime(),
            "kind": "news",
            "title": item.headline,
            "detail": item.publisher,
            "source": _source(item.provider),
            "href": item.url or None,
        }
        for item in found
    ]


def _strategy(db: Session, user_id: int, symbol: str) -> list[dict[str, Any]]:
    alerts = db.scalars(
        select(Alert)
        .where(Alert.user_id == user_id, Alert.symbol == symbol)
        .order_by(Alert.created_at.desc())
        .limit(ALERT_LIMIT)
    )
    return [
        {"at": a.created_at, "kind": "strategy", "title": a.title, "detail": a.body, "source": "Desk", "href": None}
        for a in alerts
    ]


def timeline(
    db: Session,
    sources: DataSources,
    user_id: int,
    symbol: str,
    kind: str | None,
    limit: int,
    offset: int,
    *,
    now: datetime,
) -> dict[str, Any]:
    """One page of the symbol's timeline, newest first. `total` counts the items after the `kind` filter, and only
    the providers of the asked kind are called."""
    today = today_et(now)
    readers = {
        "earnings": lambda: _earnings(db, symbol, today),
        "consensus": lambda: _consensus(db, symbol, today),
        "filing": lambda: _filings(sources, symbol, today),
        "news": lambda: _news(sources, symbol, today),
        "strategy": lambda: _strategy(db, user_id, symbol),
    }
    items = [item for name, read in readers.items() if kind in (None, name) for item in read()]
    items.sort(key=lambda item: item["at"], reverse=True)
    return {"items": items[offset : offset + limit], "total": len(items)}
