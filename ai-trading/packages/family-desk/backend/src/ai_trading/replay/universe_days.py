"""The `universe_days` read path (02o-b2): which symbols the Desk scanned on a past morning.

The live premarket pass writes one row a day (`data/refresher.record_universe_day`: the floor survivors it scans).
Before this module a practice list could only scan today's Desk set, which holds names that joined the Desk after the
day she replays (a hindsight leak by membership). With a row for the day, a market-scope filter scans the symbols of
that morning, cut to the ones her plan prepared; with none, the list scans today's set and says so in a footnote.

Coverage starts on the first day a pass wrote a row, so days before it keep the plain "today's set" footnote. Once 20
finished days exist since that first row, the plan form's first day defaults to it (`default_first_day`): a new plan
then runs on days with a recorded universe.
"""

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ai_trading.core.calendar import session as trading_session
from ai_trading.db.models import UniverseDay
from ai_trading.replay.data import ReplayDayError, check_day

MIN_FINISHED_DAYS = 20  # finished recorded days that must exist before the form's first day defaults to the first one
SCANNED_LABEL = "Practice universe · the {symbols} the Desk scanned that morning, as recorded"
TODAYS_SET_NOTE = (
    "this day is before the Desk began recording each morning's universe, so the list scans today's Desk set, "
    "which may include names that were not on the Desk then"
)


def scanned_label(size: int) -> str:
    return SCANNED_LABEL.format(symbols=f"{size} symbol" if size == 1 else f"{size} symbols")


@dataclass(frozen=True)
class Coverage:
    first_day: date | None
    last_day: date | None
    days: int


def coverage(db: Session) -> Coverage:
    first, last, count = db.execute(select(func.min(UniverseDay.day), func.max(UniverseDay.day), func.count())).one()
    return Coverage(first, last, int(count))


def symbols_on(db: Session, day: date) -> list[str] | None:
    """The recorded symbols of `day` (sorted, unique), or None when no pass recorded that morning."""
    row = db.get(UniverseDay, day)
    return None if row is None else sorted({str(s) for s in row.symbols})


def membership(planned: list[str], recorded: list[str] | None) -> tuple[list[str], dict[str, Any]]:
    """`(symbols the list scans, the membership record kept on the list)`. With a recording, the symbols the Desk
    scanned that morning that the plan prepared; without one, the plan's frozen (today's) set. The record names its
    source and says in plain words what the list could not know."""
    if recorded is None:
        return list(planned), {
            "source": "today",
            "recorded_size": None,
            "scanned_size": len(planned),
            "symbols": list(planned),
            "note": TODAYS_SET_NOTE,
        }
    prepared = set(planned)
    used = [symbol for symbol in recorded if symbol in prepared]
    left_out = len(recorded) - len(used)
    note = scanned_label(len(recorded))
    if left_out:
        note += f" · {left_out} of them were not in your plan's prepared set and are left out"
    return used, {
        "source": "universe_days",
        "recorded_size": len(recorded),
        "scanned_size": len(used),
        "symbols": used,
        "note": note,
    }


def finished_days_since(first: date, now: datetime) -> list[date]:
    """The finished trading sessions from `first` to the last one a replay can open."""
    out, cursor = [], first
    while cursor <= now.date():
        if trading_session("stock", cursor) is not None:
            try:
                check_day(cursor, now)
            except ReplayDayError:
                break
            out.append(cursor)
        cursor += timedelta(days=1)
    return out


def default_first_day(db: Session, now: datetime) -> tuple[date | None, str]:
    """The plan form's first day once the recording has `MIN_FINISHED_DAYS` finished days, else None; with the reason in
    plain words either way."""
    cover = coverage(db)
    if cover.first_day is None:
        return None, "The Desk has not recorded a morning's universe yet · the default start is three months back"
    finished = len(finished_days_since(cover.first_day, now))
    if finished < MIN_FINISHED_DAYS:
        return None, (
            f"The Desk has recorded {finished} finished {'day' if finished == 1 else 'days'} of its universe so far · "
            f"the default start moves to the first recorded day once there are {MIN_FINISHED_DAYS}"
        )
    first = next(d for d in finished_days_since(cover.first_day, now))
    return first, f"The first day the Desk recorded its universe · {finished} finished days of it exist"


def read(db: Session, day: date | None, now: datetime) -> dict[str, Any]:
    """`GET /replay/universe-days`: the recording's coverage, the plan form's default first day, and (with `day`) that
    morning's recorded membership."""
    cover = coverage(db)
    default, note = default_first_day(db, now)
    one = None
    if day is not None:
        recorded = symbols_on(db, day)
        one = {
            "day": day,
            "recorded": recorded is not None,
            "size": None if recorded is None else len(recorded),
            "symbols": recorded or [],
            "note": TODAYS_SET_NOTE if recorded is None else scanned_label(len(recorded)),
        }
    return {
        "coverage": {"first_day": cover.first_day, "last_day": cover.last_day, "days": cover.days},
        "first_day_default": default,
        "first_day_note": note,
        "day": one,
    }
