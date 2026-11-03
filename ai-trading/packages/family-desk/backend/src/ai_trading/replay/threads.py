"""Practice threads (02r, ADR-0025): the SIMULATED paper account she practises in, with ONE clock, and its stats.

A thread holds a starting balance, the risk plan (D-007), a start instant and the clock (`replay/clock.py`). It is a
freestyle thread: there is no day and no mode to choose, and nothing the clock crosses closes anything. Every realized
practice trade books a ledger row (`replay/ledger.py`). **Nothing derived is stored**: the balance is `starting_balance`
plus the ledger, the by-date series and the stats are read back from the ledger, so the numbers cannot drift from the
trades.

- **Several active threads per owner**, at most `MAX_ACTIVE_THREADS` across all users. Each has its own plan, lanes,
  ledger and balance; `active_thread` is the most recently started one, for callers that name no thread.
- **Plan edits apply from the next lane.** A lane snapshots the plan when it opens, so a position under way is scored
  against the plan it began with. The starting balance never changes.
- **Closing** cancels the working orders ("Thread closed"), archives the plan and freezes the clock where it is. It
  leaves every position open, valued at the frozen time: final equity is realized P/L plus those marks (ADR-0025 P1).
- **Deleting** removes the thread and everything under it (its ledger, plans, Screen and lanes).
- **A date in the journal** is a grouping key only: the ledger rows of an ET date, in order. No date is a unit that
  ends, resets or reviews anything.

All money here is SIMULATED and every sentence that mentions it says so.
"""

from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

import pandas as pd
from sqlalchemy import delete, func, or_, select, text
from sqlalchemy.orm import Session

from ai_trading.contracts.practice_thread import PracticeThreadCreateV1, PracticeThreadPatchV1, PracticeThreadV1
from ai_trading.core.calendar import ET
from ai_trading.db.models import (
    PracticeHold,
    PracticeLedger,
    PracticePlan,
    PracticeThread,
    PracticeWeek,
    ReplayDayList,
    ReplaySession,
)
from ai_trading.replay import session as session_mod
from ai_trading.replay.ledger import entry_out, utc_z
from ai_trading.replay.session import ReplayProblem, Services

SIMULATED_LABEL = "Simulated money · practice only, never a real account"
# Owner rule (2026-11-02, restated by ADR-0025): at most this many ACTIVE threads across all users. Closing a thread
# frees its slot; threads already over the cap are left alone and only new creates are refused. A constant, not a
# setting: it changes with an owner decision, not at run time.
MAX_ACTIVE_THREADS = 10
SLOTS_FULL = "All {max} practice-thread slots are in use · close a thread to start another"
SWING_CLOSED = "Swing threads are closed · start a freestyle thread"
SWING_SHARES = "A swing thread sizes each hold from its cash · the share count is for day threads"
NO_THREAD = "Start a practice thread first · it holds your simulated balance and risk plan"
CLOSED_THREAD = "Your practice thread is closed · start a new thread to keep practising"
LEDGER_LIMIT = 500


class ThreadNotFound(Exception):
    pass


# -- the thread's cash ---------------------------------------------------------------------------------------


def balance(db: Session, thread: PracticeThread) -> float:
    """The thread's balance: the starting balance plus its ledger (never unrealized P/L, 02p b3)."""
    total = db.execute(
        select(func.coalesce(func.sum(PracticeLedger.pnl_usd), 0)).where(PracticeLedger.thread_id == thread.id)
    ).scalar_one()
    return _money(thread.starting_balance + Decimal(total))


# -- reading -------------------------------------------------------------------------------------------------


def get_thread(db: Session, user_id: int, thread_id: int, *, lock: bool = False) -> PracticeThread:
    query = select(PracticeThread).where(PracticeThread.id == thread_id)
    row = db.execute(query.with_for_update() if lock else query).scalar_one_or_none()
    if row is None or row.owner_user_id != user_id:  # never confirm existence to a non-owner
        raise ThreadNotFound(thread_id)
    return row


def active_threads(db: Session, user_id: int, mode: str = "day", *, lock: bool = False) -> list[PracticeThread]:
    """Her active threads of the mode, the newest first."""
    query = (
        select(PracticeThread)
        .where(PracticeThread.owner_user_id == user_id, PracticeThread.mode == mode, PracticeThread.status == "active")
        .order_by(PracticeThread.created_at.desc(), PracticeThread.id.desc())
    )
    return list(db.execute(query.with_for_update() if lock else query).scalars())


def active_thread(db: Session, user_id: int, mode: str = "day", *, lock: bool = False) -> PracticeThread | None:
    """The most recently started active thread of the mode: what a caller that names no thread means."""
    return next(iter(active_threads(db, user_id, mode, lock=lock)), None)


def plan_dict(thread: PracticeThread) -> dict[str, Any]:
    """The thread's `PracticeThreadPlanV1`: an unset limit or note is absent, never null."""
    plan: dict[str, Any] = {
        "stopNoteOnEntry": thread.stop_note_on_entry,
        "tradeOnlyOnSignal": thread.trade_only_on_signal,
    }
    for key, value in (
        ("maxLossUsd", thread.max_loss_usd),
        ("maxTrades", thread.max_trades),
        ("planNote", thread.plan_note),
    ):
        if value is not None:
            plan[key] = value
    return plan


def session_plan(thread: PracticeThread) -> dict[str, Any]:
    """The thread's plan as a `ReplaySessionV1.plan`, which is what the journal scores a session against. A day thread
    has no stop rule (owner ruling, 2026-11-02: a stop is optional): its sessions are written with `stopRequired:
    "no"`, so the "Stop note on every entry" item is never applicable to them, whatever a client sent. A session
    already started keeps the plan it began with; a swing thread's column is read as it was saved (a legacy "yes"
    still scores)."""
    plan: dict[str, Any] = {
        "stopRequired": "no" if thread.mode == "day" else thread.stop_note_on_entry,
        "signalOnly": thread.trade_only_on_signal,
    }
    for key, value in (
        ("maxLossUsd", thread.max_loss_usd),
        ("maxTrades", thread.max_trades),
        ("note", thread.plan_note),
    ):
        if value is not None:
            plan[key] = value
    return plan


# -- writing -------------------------------------------------------------------------------------------------


def _check_plan(plan: dict[str, Any], balance: int | Decimal) -> None:
    """The server rule on top of the contract: a day's max loss cannot be more than the whole simulated balance."""
    if plan.get("maxLossUsd", 0) > balance:
        raise ReplayProblem(
            f"Max loss can't be more than your simulated starting balance (${int(balance):,})", path="plan.maxLossUsd"
        )


def create_thread(
    db: Session, user_id: int, spec: PracticeThreadCreateV1, now: datetime, started: datetime | None = None
) -> PracticeThread:
    """A freestyle thread. The contract's mode stays `day` until the contract migration (ADR-0025); a swing body is
    refused."""
    dumped = spec.model_dump(mode="json", by_alias=True, exclude_none=True)
    if dumped["mode"] != "day":
        raise ReplayProblem(SWING_CLOSED, path="mode")
    check_new_thread(dumped)
    # One lock for the count and the insert, held to the end of the transaction: two creates at nine active threads
    # cannot both read nine. The second waits for the first to commit, then counts ten and is refused.
    db.execute(text("select pg_advisory_xact_lock(hashtext('day-thread-cap'))"))
    if slots_used(db) >= MAX_ACTIVE_THREADS:
        raise ReplayProblem(SLOTS_FULL.format(max=MAX_ACTIVE_THREADS), path="mode", status=409)
    return add_thread(db, user_id, dumped, now, started)


def slots_used(db: Session) -> int:
    """Active threads across all users: the slots in use (every thread counts, whatever its mode column says)."""
    return db.execute(
        select(func.count()).select_from(PracticeThread).where(PracticeThread.status == "active")
    ).scalar_one()


def capacity(db: Session) -> dict[str, int]:
    """`{day_active, day_max}`: the thread slots in use and the most there can be (every user shares them). The keys
    keep their contract names until the contract migration."""
    return {"day_active": slots_used(db), "day_max": MAX_ACTIVE_THREADS}


def check_new_thread(dumped: dict[str, Any]) -> None:
    """The create rule on top of the contract: the plan fits the balance. Threads share `MAX_ACTIVE_THREADS` slots
    (checked, under a lock, by `create_thread`)."""
    _check_plan(dumped["plan"], dumped["startingBalance"])


def thread_name(db: Session, user_id: int, mode: str, now: datetime, started: datetime | None = None) -> str:
    """The new thread's own name (D-069): "Freestyle · Oct 15" after the ET day its clock starts (`started`, the setup's
    start instant; `now`, the moment it was made, when it has no setup yet), and "(2)", "(3)" ... on a later thread of
    hers with that name, so no two of her threads read alike. The name is the thread's own time, not the wall clock's
    day of creation (D-226). Threads named before ADR-0025 keep their "Day thread" and "Swing thread" names.

    ponytail: no lock, so two creates of one owner in the same instant could pick the same name; it is only a label,
    and a unique index plus a retry is the upgrade if that ever shows."""
    day = (started or now).astimezone(ET)
    base = f"{'Swing thread' if mode == 'swing' else 'Freestyle'} · {day:%b} {day.day}"
    taken = set(
        db.execute(
            select(PracticeThread.name).where(
                PracticeThread.owner_user_id == user_id, PracticeThread.name.startswith(base, autoescape=True)
            )
        ).scalars()
    )
    candidates = (base, *(f"{base} ({n})" for n in range(2, len(taken) + 3)))
    return next(name for name in candidates if name not in taken)


def add_thread(
    db: Session, user_id: int, dumped: dict[str, Any], now: datetime, started: datetime | None = None
) -> PracticeThread:
    """Write the thread row (`dumped` passed `check_new_thread`), under a name of its own."""
    plan = dumped["plan"]
    row = PracticeThread(
        owner_user_id=user_id,
        name=thread_name(db, user_id, dumped["mode"], now, started),
        mode=dumped["mode"],
        starting_balance=Decimal(dumped["startingBalance"]),
        stop_note_on_entry=plan["stopNoteOnEntry"],
        trade_only_on_signal=plan["tradeOnlyOnSignal"],
        max_loss_usd=plan.get("maxLossUsd"),
        max_trades=plan.get("maxTrades"),
        plan_note=plan.get("planNote"),
        status="active",
        created_at=now,
        updated_at=now,
        closed_at=None,
    )
    db.add(row)
    db.flush()
    return row


def patch_thread(
    db: Session, user_id: int, thread_id: int, spec: PracticeThreadPatchV1, now: datetime
) -> PracticeThread:
    """Replace the plan and the entry size while the thread is active. A limit or a size left out is cleared."""
    row = get_thread(db, user_id, thread_id, lock=True)
    if row.status == "closed":
        raise ReplayProblem("This thread is closed · its plan can no longer change", path="plan", status=409)
    if spec.shares is not None and row.mode != "day":
        raise ReplayProblem(SWING_SHARES, path="shares")
    plan = spec.model_dump(mode="json", by_alias=True, exclude_none=True)["plan"]
    _check_plan(plan, row.starting_balance)
    row.stop_note_on_entry = plan["stopNoteOnEntry"]
    row.trade_only_on_signal = plan["tradeOnlyOnSignal"]
    row.max_loss_usd = plan.get("maxLossUsd")
    row.max_trades = plan.get("maxTrades")
    row.plan_note = plan.get("planNote")
    row.shares = spec.shares
    row.updated_at = now
    db.flush()
    return row


def close_thread(
    db: Session, user_id: int, thread_id: int, now: datetime, svc: Services | None = None
) -> PracticeThread:
    """Freeze the thread (ADR-0025 P1): its working orders are cancelled ("Thread closed"), its plan is archived and its
    clock stops where it is. **Every position stays open**, valued at the frozen time: the final equity is realized P/L
    plus those marks, and nothing is sold, booked or flattened by closing. With `svc` a running clock is brought to now
    first, so it freezes at the time it had reached. Idempotent."""
    row = get_thread(db, user_id, thread_id, lock=True)
    if row.status == "closed":
        return row
    if svc is not None:
        session_mod._clock().settle(db, svc, row)
    at = pd.Timestamp(row.clock_at if row.clock_at is not None else now)
    session_mod.cancel_working(db, row.id, at if at.tzinfo else at.tz_localize("UTC"), session_mod.THREAD_CLOSED, now)
    for plan in db.execute(
        select(PracticePlan).where(PracticePlan.thread_id == row.id, PracticePlan.status == "active")
    ).scalars():
        plan.status, plan.updated_at = "archived", now
    row.clock_running, row.clock_anchor_at = False, None
    row.status, row.closed_at, row.updated_at = "closed", now, now
    db.flush()
    return row


def delete_thread(db: Session, user_id: int, thread_id: int) -> None:
    """Remove the thread and everything under it: its ledger, plans, Screen and lanes. There is no open day to wait for
    (ADR-0025): an open position goes with the thread, as the rest of its book does. It cannot be undone. Children go
    before parents (the FKs cascade as well, so this order is the explicit one)."""
    row = get_thread(db, user_id, thread_id, lock=True)
    plans = select(PracticePlan.id).where(PracticePlan.thread_id == row.id)
    day_lists = select(ReplayDayList.id).where(
        or_(ReplayDayList.plan_id.in_(plans), ReplayDayList.thread_id == row.id)
    )
    for stmt in (
        delete(PracticeLedger).where(PracticeLedger.thread_id == row.id),
        delete(PracticeHold).where(PracticeHold.thread_id == row.id),
        delete(PracticeWeek).where(PracticeWeek.thread_id == row.id),
        delete(ReplaySession).where(or_(ReplaySession.thread_id == row.id, ReplaySession.day_list_id.in_(day_lists))),
        delete(ReplayDayList).where(ReplayDayList.id.in_(day_lists)),
        delete(PracticePlan).where(PracticePlan.thread_id == row.id),
        delete(PracticeThread).where(PracticeThread.id == row.id),
    ):
        db.execute(stmt.execution_options(synchronize_session=False))
    db.expire_all()


def resolve_for_plan(db: Session, user_id: int, thread_id: int | None) -> PracticeThread:
    """The thread a new daily plan binds to: the one named, else her active day thread. A closed or missing thread is a
    plain 409 (a thread that is not hers or does not exist is a 404). The thread row is locked until the request
    commits, so a close that arrives meanwhile waits and then archives the plan this request is creating."""
    if thread_id is not None:
        thread = get_thread(db, user_id, thread_id, lock=True)
        if thread.status == "closed":
            raise ReplayProblem(CLOSED_THREAD, path="threadId", status=409)
        if thread.mode != "day":
            raise ReplayProblem("Daily lists run in a day thread", path="threadId")
        return thread
    thread = active_thread(db, user_id, "day", lock=True)
    if thread is not None:
        return thread
    any_thread = db.execute(
        select(PracticeThread.id).where(PracticeThread.owner_user_id == user_id, PracticeThread.mode == "day").limit(1)
    ).first()
    raise ReplayProblem(NO_THREAD if any_thread is None else CLOSED_THREAD, path="threadId", status=409)


# -- the numbers: all read back from the ledger and the ended day lists -----------------------------------------


def _weekday(day: Any) -> str:
    return day.strftime("%a")


def _money(value: float | Decimal) -> float:
    """Dollars to the cent. Decimal all the way (D-033): a float round can land a half cent on the wrong side."""
    return float(Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def _ledger(db: Session, thread_id: int) -> list[PracticeLedger]:
    return list(
        db.execute(
            select(PracticeLedger)
            .where(PracticeLedger.thread_id == thread_id)
            .order_by(PracticeLedger.realized_at, PracticeLedger.id)
        ).scalars()
    )


def _series(thread: PracticeThread, ledger: list[PracticeLedger]) -> list[dict[str, Any]]:
    """One row per ET date that realized a trade, in date order: its trades and P/L, and the balance after. A date is a
    grouping key for the journal and nothing more (ADR-0025): the same ledger rows, grouped, so the rows add up to the
    balance."""
    pnl: dict[date, Decimal] = {}
    trades: dict[date, int] = {}
    for entry in ledger:
        pnl[entry.day] = pnl.get(entry.day, Decimal(0)) + entry.pnl_usd
        trades[entry.day] = trades.get(entry.day, 0) + 1
    balance, rows = thread.starting_balance, []
    for index, day in enumerate(sorted(pnl), start=1):
        balance += pnl[day]
        rows.append(
            {
                "n": index,
                "day": day,
                "weekday": _weekday(day),
                "trades": trades[day],
                "pnl_usd": _money(pnl[day]),
                "balance": _money(balance),
            }
        )
    return rows


def _stats(thread: PracticeThread, ledger: list[PracticeLedger], series: list[dict[str, Any]]) -> dict[str, Any]:
    """`PracticeThreadStatsV1`: every figure from the ledger and the date series; an empty figure is absent. The
    contract's day counts keep their names: `daysPracticed` is the dates that realized a trade, `daysSkipped` is 0."""
    pnls = [entry.pnl_usd for entry in ledger]
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p < 0]
    stats: dict[str, Any] = {
        "balance": _money(thread.starting_balance + sum(pnls, Decimal(0))),
        "daysPracticed": len(series),
        "daysSkipped": 0,
        "wins": len(wins),
        "losses": len(losses),
    }
    optional = {
        "winRate": round(len(wins) / len(pnls), 3) if pnls else None,
        "avgWinUsd": _money(sum(wins, Decimal(0)) / len(wins)) if wins else None,
        "avgLossUsd": _money(sum(losses, Decimal(0)) / len(losses)) if losses else None,
        "bestDayUsd": max(row["pnl_usd"] for row in series) if series else None,
        "worstDayUsd": min(row["pnl_usd"] for row in series) if series else None,
    }
    return {**stats, **{key: value for key, value in optional.items() if value is not None}}


def _contract(db: Session, thread: PracticeThread, stats: dict[str, Any]) -> PracticeThreadV1:
    doc: dict[str, Any] = {
        "schemaVersion": 1,
        "id": thread.id,
        "name": thread.name,
        "mode": thread.mode if thread.mode in ("day", "swing") else "day",
        "startingBalance": int(thread.starting_balance),
        "status": thread.status,
        "plan": plan_dict(thread),
        "createdAt": utc_z(thread.created_at),
        "stats": stats,
    }
    if thread.shares is not None:
        doc["shares"] = thread.shares
    if thread.closed_at is not None:
        doc["closedAt"] = utc_z(thread.closed_at)
    if thread.mode == "swing":  # a legacy thread: the contract's `swing` block is the setup the plan row froze (R2)
        spec = db.execute(
            select(PracticePlan.spec)
            .where(PracticePlan.thread_id == thread.id)
            .order_by(PracticePlan.id.desc())
            .limit(1)
        ).scalar_one()
        doc["swing"] = {key: value for key, value in spec.items() if key not in ("mode", "maxOpenHolds")}  # legacy cap
    return PracticeThreadV1.model_validate(doc)


def _last_activity(db: Session, thread: PracticeThread) -> datetime | None:
    """The wall-clock moment something last changed in the thread: a lane touched, a trade booked, the thread edited.
    Booking times only, never a replayed date (those are spoilers). None for a thread nothing has happened in."""
    lanes = select(func.max(ReplaySession.updated_at)).where(ReplaySession.thread_id == thread.id)
    booked = select(func.max(PracticeLedger.created_at)).where(PracticeLedger.thread_id == thread.id)
    times = [t for t in (db.execute(lanes).scalar_one(), db.execute(booked).scalar_one()) if t is not None]
    return max(times, default=None)


def _clock_brief(thread: PracticeThread) -> dict[str, Any] | None:
    """Where the thread's time is, without the account (a hub row needs no price): None before its plan starts it."""
    if thread.clock_at is None:
        return None
    return {
        "clock": thread.clock_at,
        "running": thread.clock_running,
        "speed": thread.clock_speed,
        "start_at": thread.start_at,
        "pause": thread.clock_pause,
    }


def summary(db: Session, thread: PracticeThread) -> dict[str, Any]:
    ledger = _ledger(db, thread.id)
    series = _series(thread, ledger)
    return {
        "thread": _contract(db, thread, _stats(thread, ledger, series)),
        "clock": _clock_brief(thread),
        "positions_open": sum(1 for _, open_ in session_mod.book(db, thread.id).values() if open_ is not None),
        "last_activity_at": _last_activity(db, thread),
        "label": SIMULATED_LABEL,
    }


def detail(db: Session, thread: PracticeThread) -> dict[str, Any]:
    """The thread, its stats, its clock, the by-date P/L series and the balance curve (the starting point, then each
    date that realized a trade)."""
    ledger = _ledger(db, thread.id)
    series = _series(thread, ledger)
    curve = [{"n": 0, "day": None, "balance": _money(thread.starting_balance)}] + [
        {"n": row["n"], "day": row["day"], "balance": row["balance"]} for row in series
    ]
    return {**summary(db, thread), "daily": series, "curve": curve}


def list_threads(db: Session, user_id: int) -> list[dict[str, Any]]:
    """Her threads, the active ones first, then newest first."""
    rows = db.execute(
        select(PracticeThread)
        .where(PracticeThread.owner_user_id == user_id)
        .order_by(
            (PracticeThread.status == "active").desc(), PracticeThread.created_at.desc(), PracticeThread.id.desc()
        )
    ).scalars()
    return [summary(db, row) for row in rows]


def ledger_page(db: Session, thread: PracticeThread, *, limit: int = LEDGER_LIMIT) -> dict[str, Any]:
    """The `limit` most recently booked ledger rows, newest first (booking order, not the replayed market time: a later
    plan in the same thread may replay an earlier month), with the total row count."""
    rows = list(
        db.execute(
            select(PracticeLedger)
            .where(PracticeLedger.thread_id == thread.id)
            .order_by(PracticeLedger.id.desc())
            .limit(limit)
        ).scalars()
    )
    total = db.execute(select(func.count(PracticeLedger.id)).where(PracticeLedger.thread_id == thread.id)).scalar_one()
    return {
        "thread_id": thread.id,
        "total": total,
        "entries": [entry_out(row) for row in rows],
        "label": SIMULATED_LABEL,
    }


def brief(db: Session, thread_id: int | None) -> dict[str, Any] | None:
    """The header strip of a workspace: the SIMULATED balance. None without a thread."""
    if thread_id is None:
        return None
    thread = db.get(PracticeThread, thread_id)
    if thread is None:
        return None
    return {
        "id": thread.id,
        "mode": thread.mode,
        "status": thread.status,
        "balance": balance(db, thread),
        "label": SIMULATED_LABEL,
    }


__all__ = (
    "ThreadNotFound",
    "active_thread",
    "active_threads",
    "add_thread",
    "brief",
    "capacity",
    "check_new_thread",
    "close_thread",
    "create_thread",
    "delete_thread",
    "detail",
    "get_thread",
    "ledger_page",
    "list_threads",
    "patch_thread",
    "plan_dict",
    "resolve_for_plan",
    "session_plan",
    "summary",
    "thread_name",
)
