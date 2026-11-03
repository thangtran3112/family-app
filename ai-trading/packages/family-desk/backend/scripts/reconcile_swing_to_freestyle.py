"""One-time Swing -> Freestyle reconciliation (ADR-0025 D3, plan section 6.2): CONVERT every open swing hold into a
freestyle position; never liquidate one. Dry-run by default.

    uv run python scripts/reconcile_swing_to_freestyle.py                    # report only, writes nothing
    uv run python scripts/reconcile_swing_to_freestyle.py --apply            # write
    uv run python scripts/reconcile_swing_to_freestyle.py --thread 12        # one thread
    uv run python scripts/reconcile_swing_to_freestyle.py --apply --accept-drift

Needs `DESK_RUNTIME_DATABASE_URL` and the market-data keys in the environment (the same as `ai_trading.cli.replay_prep`:
render them with `common/config/family_config.py run ai-trading/desk -- ...`). Read-only on the market.

It reads `practice_holds` directly. The swing play, week and `end_day` code is gone, so a swing day that is still
open is NOT finished here: the thread's time stops at the last close the swing book was valued at.

Per ACTIVE swing thread, in one transaction:

1. `clock_at` = the official close (16:00 ET, 13:00 on a half day) of the last ended swing day, `start_at` = the
   first day's open, the clock paused. A hold entered on a day that has not ended is anchored at its own entry time
   instead, and `clock_at` is the latest of these (nothing may be revealed before it was bought).
2. Each OPEN hold becomes a lane (`replay_sessions`, one active row per thread and name) with one synthetic entry mark
   at that anchor: the hold's `entry_price` (already on the restated share basis), `shares` and `stop_price`.
3. Closed holds, the ledger, `practice_holds` and `practice_weeks` are not touched (the contract migration drops
   them), so the balance is identical. The script checks that before it commits.
4. The swing plan is archived; a freestyle plan (`practice-setup-v2`) is created over the same names, starting at
   `clock_at`.
5. `mode` -> `freestyle`; the risk rules are not touched.

The thread's old swing sessions leave it (`thread_id` NULL, ended): their entry marks of a still-open hold would
otherwise read as a second open position in the freestyle book (`session.book` assembles every row of the thread).

A CLOSED swing thread only gets `mode = 'freestyle'`. A thread the script cannot convert without changing money is
reported as BLOCKED and left alone (a closed hold with no ledger row: it exited on a day that never ended, so the
day-end that credits it will never run).

Report: per hold, before = the swing valuation (the official close it was marked at; its entry price when it was never
marked), after = the freestyle mark at `clock_at` (`positions.mark_at`: the last print), and the difference in USD. The
difference is expected to be cents. `--apply` is refused when the sum of the absolute differences is above
`TOLERANCE_USD`, unless `--accept-drift`. Safe to re-run: a thread that is already freestyle is skipped.
"""

import argparse
import os
import sys
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime

import pandas as pd
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session, sessionmaker

from ai_trading.contracts.practice_setup import PracticeSetupV2
from ai_trading.core.calendar import ET
from ai_trading.core.calendar import session as trading_session
from ai_trading.db.models import (
    FilterStrategy,
    PracticeHold,
    PracticeLedger,
    PracticeMark,
    PracticePlan,
    PracticeThread,
    ReplayDayList,
    ReplaySession,
)
from ai_trading.replay import positions, prep
from ai_trading.replay import threads as threads_mod
from ai_trading.replay.ledger import utc_z

TOLERANCE_USD = 25.0  # sum of |after - before| over every hold: the official close against the last print is cents
MIN_LIST, MAX_LIST = 20, 49  # PracticeScreenV2.maxList
DATABASE_URL_VAR = "DESK_RUNTIME_DATABASE_URL"

PriceOf = Callable[[Session, str, pd.Timestamp], float | None]


@dataclass
class Line:
    """One open hold, as the report shows it."""

    row: PracticeHold
    at: pd.Timestamp  # where its entry mark is anchored
    before: float  # the swing valuation
    after: float  # the freestyle mark at clock_at
    priced: bool  # False: no price at clock_at, so the name stays at its entry price

    @property
    def delta(self) -> float:
        sign = 1 if self.row.side == "long" else -1
        return round(sign * (self.after - self.before) * self.row.shares, 2)


@dataclass
class Result:
    thread: PracticeThread
    status: str  # "convert" | "closed" | "blocked" | "freestyle"
    reason: str = ""
    clock_at: pd.Timestamp | None = None
    start_at: pd.Timestamp | None = None
    lines: list[Line] = field(default_factory=list)
    plan: PracticePlan | None = None
    filters: list[int] = field(default_factory=list)
    symbols: list[str] = field(default_factory=list)
    legacy_sessions: int = 0


def _ts(value: datetime) -> pd.Timestamp:
    return pd.Timestamp(value).tz_convert("UTC")


def _hhmm(at: pd.Timestamp) -> str:
    return at.tz_convert(ET).strftime("%Y-%m-%d %H:%M")


def _screen_filters(db: Session, plan: PracticePlan) -> list[int]:
    """The Screen's filters of the converted plan (`PracticeSetupV2` needs one to three): her armed filters, as the
    swing plan kept them, else her first live filter. A swing thread picked its names by hand and has no Screen."""
    owner = plan.owner_user_id

    def live(filter_id: int) -> bool:
        row = db.get(FilterStrategy, filter_id)
        return (
            row is not None
            and row.owner_user_id == owner
            and row.archived_at is None
            and row.current_version_id is not None
        )

    armed = [a["id"] for a in plan.spec.get("armed", []) if a.get("source") == "filter" and live(a["id"])]
    if armed:
        return list(dict.fromkeys(armed))[:3]
    first = db.execute(
        select(FilterStrategy.id)
        .where(
            FilterStrategy.owner_user_id == owner,
            FilterStrategy.archived_at.is_(None),
            FilterStrategy.current_version_id.is_not(None),
        )
        .order_by(FilterStrategy.id)
        .limit(1)
    ).scalar_one_or_none()
    return [] if first is None else [first]


def analyse(db: Session, thread: PracticeThread, price_of: PriceOf) -> Result:
    """What converting `thread` would do. Reads only."""
    if thread.mode != "swing":
        return Result(thread, "freestyle")
    if thread.status == "closed":
        return Result(thread, "closed")
    plan = db.execute(
        select(PracticePlan).where(PracticePlan.thread_id == thread.id).order_by(PracticePlan.id.desc()).limit(1)
    ).scalar_one_or_none()
    if plan is None:
        return Result(thread, "blocked", "no swing plan")
    uncredited = list(
        db.execute(
            select(PracticeHold.id).where(
                PracticeHold.thread_id == thread.id,
                PracticeHold.status == "closed",
                ~select(PracticeLedger.id).where(PracticeLedger.hold_id == PracticeHold.id).exists(),
            )
        ).scalars()
    )
    if uncredited:
        ids = ", ".join(f"#{i}" for i in uncredited)
        return Result(
            thread, "blocked", f"closed hold {ids} has no ledger row · its day never ended, so it was never credited"
        )
    filters = _screen_filters(db, plan)
    if not filters:
        return Result(thread, "blocked", "the owner has no live screener filter for the plan's Screen")

    last_ended = db.execute(
        select(func.max(ReplayDayList.day))
        .join(PracticePlan, PracticePlan.id == ReplayDayList.plan_id)
        .where(PracticePlan.thread_id == thread.id, ReplayDayList.status == "ended")
    ).scalar_one()
    first = trading_session("stock", plan.first_day)
    assert first is not None
    start_at = first.regular_open
    base = None
    if last_ended is not None:
        ended = trading_session("stock", last_ended)
        assert ended is not None
        base = ended.regular_close

    holds = list(
        db.execute(
            select(PracticeHold)
            .where(PracticeHold.thread_id == thread.id, PracticeHold.status == "open")
            .order_by(PracticeHold.id)
        ).scalars()
    )
    # A carried hold is anchored at the last close (the share basis the swing book was restated to); one bought on a day
    # that has not ended, at its own entry.
    anchors = {h.id: base if base is not None and _ts(h.entry_at) <= base else _ts(h.entry_at) for h in holds}
    clock_at = max([start_at, *([base] if base is not None else []), *anchors.values()])

    lines = []
    for hold in holds:
        before = float(hold.last_close if hold.last_close is not None else hold.entry_price)
        found = price_of(db, hold.symbol, clock_at)
        after = float(hold.entry_price) if found is None else found
        lines.append(Line(hold, anchors[hold.id], before, after, found is not None))
    symbols = list(dict.fromkeys(e["symbol"] if isinstance(e, dict) else e for e in plan.universe["symbols"]))
    legacy = db.execute(
        select(func.count()).select_from(ReplaySession).where(ReplaySession.thread_id == thread.id)
    ).scalar_one()
    return Result(
        thread,
        "convert",
        clock_at=clock_at,
        start_at=start_at,
        lines=lines,
        plan=plan,
        filters=filters,
        symbols=symbols,
        legacy_sessions=legacy,
    )


# -- writing ---------------------------------------------------------------------------------------------------------


def _lane(db: Session, thread: PracticeThread, hold: PracticeHold, line: Line, res: Result, now: datetime) -> None:
    clock = res.clock_at
    assert clock is not None and res.plan is not None
    day = positions.data_day(clock)
    found = trading_session("stock", day)
    assert found is not None
    attempt = (
        db.execute(
            select(func.coalesce(func.max(ReplaySession.attempt), 0)).where(
                ReplaySession.owner_user_id == thread.owner_user_id,
                ReplaySession.symbol == hold.symbol,
                ReplaySession.day == day,
            )
        ).scalar_one()
        + 1
    )
    spec = {
        "schemaVersion": 1,
        "symbol": hold.symbol,
        "day": day.isoformat(),
        "window": {"from": "09:30", "to": found.regular_close.tz_convert(ET).strftime("%H:%M")},
        "session": "regular",
        "interval": res.plan.spec.get("interval", "5m"),
        "shares": hold.shares,
        "armed": [],
        "plan": threads_mod.session_plan(thread),
        "hideDate": "no",
    }
    lane = ReplaySession(
        owner_user_id=thread.owner_user_id,
        symbol=hold.symbol,
        day=day,
        attempt=attempt,
        schema_version=1,
        spec=spec,
        armed=[],
        signals=[],
        window_start=found.regular_open.to_pydatetime(),
        window_end=found.extended_close.to_pydatetime(),
        revealed_through=clock.to_pydatetime(),
        tape_feed="sip",  # `session.open_lane`'s own fallback when it cannot probe; the script reads no tape
        status="active",
        created_at=now,
        updated_at=now,
        thread_id=thread.id,
    )
    db.add(lane)
    db.flush()
    entry_day_no = len(prep.sessions_between(res.plan.first_day, hold.entry_day))
    db.add(
        PracticeMark(
            session_id=lane.id,
            seq=1,
            kind="long_entry" if hold.side == "long" else "short_entry",
            at=line.at.to_pydatetime(),
            price=hold.entry_price,
            shares=hold.shares,
            stop_price=hold.stop_price,
            note=f"Carried over from swing hold #{hold.id} (entered {hold.entry_day.isoformat()})",
            trade_no=1,
            source="her",
            position_before={
                "migrated": {
                    "entry_at": hold.entry_at.isoformat(),
                    "entry_day_no": entry_day_no,
                    "splits": list(hold.splits or []),
                    "stop_at_entry": None if hold.stop_at_entry is None else float(hold.stop_at_entry),
                }
            },
            created_at=now,
        )
    )


def convert(db: Session, res: Result, now: datetime) -> None:
    """Write one thread. Raises (so the caller rolls back) if its balance moved."""
    thread = db.execute(select(PracticeThread).where(PracticeThread.id == res.thread.id).with_for_update()).scalar_one()
    if thread.mode != "swing":  # converted by someone else since the report
        return
    if res.status == "closed":
        thread.mode, thread.updated_at = "freestyle", now
        return
    assert res.plan is not None and res.clock_at is not None and res.start_at is not None
    balance = threads_mod.balance(db, thread)

    # The old sessions: end the open day's, then let all of them leave the thread (module docstring).
    db.execute(
        update(ReplaySession)
        .where(ReplaySession.thread_id == thread.id, ReplaySession.status == "active")
        .values(status="ended", ended_at=now, updated_at=now),
        execution_options={"synchronize_session": False},
    )
    db.execute(
        update(ReplaySession).where(ReplaySession.thread_id == thread.id).values(thread_id=None),
        execution_options={"synchronize_session": False},
    )
    db.flush()

    thread.mode = "freestyle"  # before the lanes: `session_plan` reads the thread's risk plan, not the swing rule
    thread.start_at, thread.clock_at = res.start_at.to_pydatetime(), res.clock_at.to_pydatetime()
    thread.clock_running, thread.clock_speed, thread.clock_anchor_at, thread.clock_pause = False, 1, None, None
    thread.updated_at = now
    for line in res.lines:
        _lane(db, thread, line.row, line, res, now)

    old = db.get(PracticePlan, res.plan.id)
    assert old is not None
    if old.status == "active":
        old.status, old.updated_at = "archived", now
        db.flush()  # one active plan per thread
    spec = PracticeSetupV2.model_validate(
        {
            "schemaVersion": 2,
            "screen": {
                "filters": [{"id": i} for i in res.filters],
                "maxList": min(MAX_LIST, max(MIN_LIST, len(res.symbols))),
            },
            "setup": {
                "armed": old.spec.get("armed", []),
                "interval": old.spec.get("interval", "5m"),
                "session": "regular",
            },
            "startAt": utc_z(res.clock_at.to_pydatetime()),
        }
    ).model_dump(mode="json", by_alias=True, exclude_none=True)
    db.add(
        PracticePlan(
            owner_user_id=thread.owner_user_id,
            schema_version=2,
            spec=spec,
            first_day=res.clock_at.tz_convert(ET).date(),
            universe={"source": "swing", "symbols": res.symbols, "capped": False, "frozen_at": now.isoformat()},
            prep={
                "state": "done",
                "done": len(res.symbols),
                "total": len(res.symbols),
                "failed": {},
                "updated_at": now.isoformat(),
            },
            day_cursor=None,
            days_opened=0,
            status="active",
            created_at=now,
            updated_at=now,
            thread_id=thread.id,
        )
    )
    db.flush()
    if threads_mod.balance(db, thread) != balance:
        raise RuntimeError(f"thread {thread.id}: the balance moved ({balance} -> {threads_mod.balance(db, thread)})")


# -- the run ---------------------------------------------------------------------------------------------------------


def _report(results: list[Result], out: Callable[[str], None]) -> tuple[float, float, int]:
    absolute = net = holds = 0.0
    for res in results:
        t = res.thread
        head = f"thread {t.id} · {t.name} · {t.status}"
        if res.status == "freestyle":
            out(f"{head} · already freestyle, skipped")
        elif res.status == "closed":
            out(f"{head} · closed: mode -> freestyle, nothing else")
        elif res.status == "blocked":
            out(f"{head} · BLOCKED: {res.reason}")
        else:
            assert res.clock_at is not None and res.start_at is not None
            out(
                f"{head} · {len(res.lines)} open hold(s) · start {_hhmm(res.start_at)} ET"
                f" · T = {_hhmm(res.clock_at)} ET (paused) · {len(res.symbols)} names · Screen filter(s) {res.filters}"
                f" · {res.legacy_sessions} old session(s) leave the thread"
            )
            if res.lines:
                out(
                    f"    {'hold':>6} {'symbol':<8} {'side':<6} {'shares':>7}"
                    f" {'entry':>10} {'before':>10} {'after':>10} {'delta USD':>11}"
                )
            for line in res.lines:
                h = line.row
                note = "" if line.priced else "  (no price at T, carried at entry)"
                out(
                    f"    {'#' + str(h.id):>6} {h.symbol:<8} {h.side:<6} {h.shares:>7} {float(h.entry_price):>10.4f}"
                    f" {line.before:>10.4f} {line.after:>10.4f} {line.delta:>+11.2f}{note}"
                )
                absolute += abs(line.delta)
                net += line.delta
                holds += 1
    return round(absolute, 2), round(net, 2), int(holds)


def run(
    factory: sessionmaker[Session],
    price_of: PriceOf,
    *,
    apply: bool = False,
    thread_id: int | None = None,
    accept_drift: bool = False,
    out: Callable[[str], None] = print,
) -> int:
    """Exit code: 0 done (or a clean dry run), 1 a thread is BLOCKED, 2 no such thread, 3 `--apply` refused (drift)."""
    memo: dict[tuple[str, pd.Timestamp], float | None] = {}

    def priced(db: Session, symbol: str, at: pd.Timestamp) -> float | None:
        if (symbol, at) not in memo:
            memo[symbol, at] = price_of(db, symbol, at)
        return memo[symbol, at]

    with factory() as db:
        query = select(PracticeThread).where(PracticeThread.mode == "swing").order_by(PracticeThread.id)
        if thread_id is not None:
            query = select(PracticeThread).where(PracticeThread.id == thread_id)
        threads = list(db.execute(query).scalars())
        if thread_id is not None and not threads:
            out(f"no thread {thread_id}")
            return 2
        results = [
            analyse(db, t, priced) for t in threads
        ]  # closing the session rolls back: even a price read's blob cache
    absolute, net, count = _report(results, out)
    out(f"total over {count} hold(s): {net:+.2f} USD net, {absolute:.2f} USD absolute · tolerance {TOLERANCE_USD:.2f}")
    blocked = any(r.status == "blocked" for r in results)
    if not apply:
        out("DRY RUN · nothing written · add --apply to convert")
        return 1 if blocked else 0
    if absolute > TOLERANCE_USD and not accept_drift:
        out("REFUSED · the drift is above the tolerance · read the table, then add --accept-drift to go on")
        return 3
    now = datetime.now(UTC)
    for res in results:
        if res.status in ("convert", "closed"):
            with factory.begin() as db:  # one transaction per thread
                convert(db, res, now)
            out(f"thread {res.thread.id} · converted")
    return 1 if blocked else 0


def market_price_of() -> PriceOf:
    """`positions.mark_at` over the real data sources (the keys come from the environment, as for `replay_prep`)."""
    from ai_trading_common.registry import DataSources

    from ai_trading.replay.cache import DbBlobStore
    from ai_trading.replay.data import History
    from ai_trading.replay.session import Services
    from ai_trading.replay.tape import Tape

    sources = DataSources.from_env()
    svc = Services(history=History(sources), tape=Tape(sources), sources=sources)

    def price_of(db: Session, symbol: str, at: pd.Timestamp) -> float | None:
        found = positions.mark_at(svc, DbBlobStore(db), symbol, at)
        return None if found is None else found.price

    return price_of


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--apply", action="store_true", help="write (the default is a dry run)")
    parser.add_argument("--thread", type=int, help="only this thread id")
    parser.add_argument("--accept-drift", action="store_true", help="apply even if the drift is above the tolerance")
    args = parser.parse_args(argv)
    url = os.environ.get(DATABASE_URL_VAR)
    if not url:
        print(f"{DATABASE_URL_VAR} is not set", file=sys.stderr)
        return 2
    from ai_trading.db.engine import make_engine, make_session_factory

    return run(
        make_session_factory(make_engine(url)),
        market_price_of(),
        apply=args.apply,
        thread_id=args.thread,
        accept_drift=args.accept_drift,
    )


if __name__ == "__main__":
    raise SystemExit(main())
