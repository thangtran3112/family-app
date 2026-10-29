"""The Research reads of the Fundamental lane that need no provider call (02n §c3 #12, #13, §d): the Desk AI brief and
one symbol's consensus and analyst targets, read from the snapshot tables `research/consensus.py` fills every day.

Honest by construction: a figure is a stored row or null, never a stand-in. The Desk AI verdict and brief rows are step
5's (their shape is that spec's), so `verdict` is always null and the brief has no rows until that job exists. The
stamp is the freshest stored row's own provider, quality and time; with nothing stored it is the unavailable stamp.
"""

from datetime import date, datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ai_trading.api.stamp import feed_last_ok, make_stamp, no_run_stamp
from ai_trading.core.calendar import ET
from ai_trading.db.models import AiCall, AnalystTarget, ConsensusSnapshot, EarningsResult
from ai_trading.research.consensus import CONSENSUS_FEED

REVISION_DAYS = (7, 30, 90)
_REVISION_SLACK = 7  # a revision looks back N days, and accepts the closest snapshot up to a week older than that
_SURPRISES = 4
_SNAPSHOT_INTERVAL = timedelta(days=1)
#: Providers' own report-time codes (Alpha Vantage's `pre-market`/`post-market`, Finnhub's `bmo`/`amc`) in words.
_TIMING = {
    "bmo": "before open",
    "pre-market": "before open",
    "before_open": "before open",
    "amc": "after close",
    "post-market": "after close",
    "after_close": "after close",
    "dmh": "during market",
}


def today_et(now: datetime) -> date:
    return now.astimezone(ET).date()


def period_label(prefix: str, fiscal_year: int | None, fiscal_quarter: int | None, period_end: date | None) -> str:
    """ "Q4 2026" for a quarter, "FY2026" for a year; the period's end date when the provider gave no fiscal label."""
    if prefix == "Q" and fiscal_year is not None and fiscal_quarter is not None:
        return f"Q{fiscal_quarter} {fiscal_year}"
    if prefix == "FY" and fiscal_year is not None:
        return f"FY{fiscal_year}"
    return period_end.isoformat() if period_end is not None else "unknown period"


def timing_text(report_time: str | None) -> str:
    return _TIMING.get((report_time or "").strip().lower(), "time unknown")


def current_fiscal_year(db: Session, symbol: str, day: date) -> tuple[date, date] | None:
    """(end of the earliest fiscal year not yet over, the symbol's latest snapshot day), or None with no such row."""
    latest = db.execute(
        select(func.max(ConsensusSnapshot.snapshot_date)).where(ConsensusSnapshot.symbol == symbol)
    ).scalar_one()
    if latest is None:
        return None
    period_end = db.execute(
        select(func.min(ConsensusSnapshot.period_end)).where(
            ConsensusSnapshot.symbol == symbol,
            ConsensusSnapshot.period_kind == "annual",
            ConsensusSnapshot.snapshot_date == latest,
            ConsensusSnapshot.period_end >= day,
        )
    ).scalar_one()
    return None if period_end is None else (period_end, latest)


def _revisions(db: Session, symbol: str, fiscal_year: tuple[date, date] | None, day: date) -> dict[str, float | None]:
    """The percent change of the current fiscal year's consensus EPS over 7, 30 and 90 days, from the Desk's own
    snapshots. A window with no snapshot (history not that long yet, or a gap) or an old estimate of 0 is null: the
    base is the old estimate's size, so a negative estimate still reads as a rise when it narrows."""
    out: dict[str, float | None] = {f"d{n}": None for n in REVISION_DAYS}
    if fiscal_year is None:
        return out
    period_end, latest = fiscal_year
    key = (ConsensusSnapshot.symbol == symbol, ConsensusSnapshot.period_kind == "annual")

    def eps_on(snapshot_day: date) -> float | None:
        return db.execute(
            select(ConsensusSnapshot.eps_mean).where(
                *key, ConsensusSnapshot.period_end == period_end, ConsensusSnapshot.snapshot_date == snapshot_day
            )
        ).scalar_one_or_none()

    current = eps_on(latest)
    if current is None:
        return out
    for n in REVISION_DAYS:
        target = latest - timedelta(days=n)
        old_day = db.execute(
            select(func.max(ConsensusSnapshot.snapshot_date)).where(
                *key,
                ConsensusSnapshot.period_end == period_end,
                ConsensusSnapshot.snapshot_date <= target,
                ConsensusSnapshot.snapshot_date >= target - timedelta(days=_REVISION_SLACK),
            )
        ).scalar_one()
        old = None if old_day is None else eps_on(old_day)
        if old:
            out[f"d{n}"] = round((current - old) / abs(old) * 100, 2)
    return out


def _consensus(db: Session, symbol: str, day: date, used: list[Any]) -> dict[str, Any] | None:
    latest = db.execute(
        select(func.max(ConsensusSnapshot.snapshot_date)).where(ConsensusSnapshot.symbol == symbol)
    ).scalar_one()
    if latest is None:
        return None
    rows = db.scalars(
        select(ConsensusSnapshot)
        .where(ConsensusSnapshot.symbol == symbol, ConsensusSnapshot.snapshot_date == latest)
        .order_by(ConsensusSnapshot.period_end)
    ).all()
    used += rows

    def periods(kind: str, prefix: str) -> list[dict[str, Any]]:
        return [
            {
                "period": period_label(prefix, r.fiscal_year, r.fiscal_quarter, r.period_end),
                "eps_estimate": r.eps_mean,
                "analysts": r.analyst_count,
            }
            for r in rows
            if r.period_kind == kind and r.period_end >= day
        ]

    reported = db.scalars(
        select(EarningsResult)
        .where(EarningsResult.symbol == symbol, EarningsResult.eps_actual.is_not(None))
        .order_by(EarningsResult.period_end.desc())
        .limit(_SURPRISES)
    ).all()
    upcoming = db.scalars(
        select(EarningsResult)
        .where(EarningsResult.symbol == symbol, EarningsResult.eps_actual.is_(None), EarningsResult.report_date >= day)
        .order_by(EarningsResult.report_date)
        .limit(1)
    ).first()
    used += reported + ([upcoming] if upcoming is not None else [])
    return {
        "quarters": periods("quarter", "Q"),
        "fiscal_years": periods("annual", "FY"),
        "surprises": [
            {
                "period": period_label("Q", r.fiscal_year, r.fiscal_quarter, r.period_end),
                "actual": r.eps_actual,
                "estimate": r.eps_estimate,
                "surprise_pct": r.surprise_percent,
            }
            for r in reported
        ],
        "next_earnings": None
        if upcoming is None
        else {"date": upcoming.report_date, "timing": timing_text(upcoming.report_time)},
        "revisions": _revisions(db, symbol, current_fiscal_year(db, symbol, day), day),
    }


def _targets(db: Session, symbol: str, used: list[Any]) -> dict[str, Any] | None:
    row = db.scalars(
        select(AnalystTarget)
        .where(AnalystTarget.symbol == symbol)
        .order_by(AnalystTarget.snapshot_date.desc())
        .limit(1)
    ).first()
    if row is None:
        return None
    used.append(row)
    return {
        "low": row.target_low,
        "mean": row.target_mean,
        "high": row.target_high,
        "counts": {
            "buy": (row.strong_buy or 0) + (row.buy or 0),
            "hold": row.hold or 0,
            "sell": (row.sell or 0) + (row.strong_sell or 0),
        },
    }


def symbol_research(db: Session, symbol: str, *, now: datetime) -> dict[str, Any]:
    """One symbol's consensus and targets from the stored snapshots. Nothing stored is `consensus: null`,
    `targets: null` and the unavailable stamp, still a 200: the symbol may be real and simply not on a watchlist."""
    used: list[Any] = []
    consensus = _consensus(db, symbol, today_et(now), used)
    targets = _targets(db, symbol, used)
    if used:
        freshest = max(used, key=lambda row: row.as_of)
        stamp = make_stamp(
            quality=freshest.quality,
            source=freshest.provider,
            as_of=freshest.as_of,
            interval=_SNAPSHOT_INTERVAL,
            last_ok_at=feed_last_ok(db, CONSENSUS_FEED),
            now=now,
        )
    else:
        stamp = no_run_stamp()
    return {
        "symbol": symbol,
        "verdict": None,  # the Desk AI verdict is step 5's; its shape is that spec's
        "consensus": consensus,
        "targets": targets,
        "stamp": stamp.model_dump(),
    }


def brief(db: Session, on: date | None, *, now: datetime) -> dict[str, Any]:
    """No Desk AI run exists before step 5, so no rows and no run; the track record counts the stored calls (none yet:
    nothing settles before the settlement job, so every call is pending)."""
    calls = db.execute(select(func.count()).select_from(AiCall)).scalar_one()
    return {
        "date": on or today_et(now),
        "run": None,
        "rows": [],
        "track_record": {"calls": calls, "settled": 0, "pending": calls},
    }
