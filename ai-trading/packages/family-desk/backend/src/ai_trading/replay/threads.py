"""Practice threads (02r): the SIMULATED paper account she practises in across days, and its stats.

A thread holds a starting balance and the risk plan (D-007: the plan is the thread's, not the daily list's). Each daily
plan binds to one thread; every realized practice trade books a ledger row (`replay/ledger.py`). **Nothing derived is
stored**: the balance is `starting_balance` plus the ledger, the day series and the stats are read back from the
ledger and the ended day lists, so the numbers cannot drift from the trades (the reconciliation tests pin this).

- **One active thread per owner and mode.** A second `day` thread is a 409 until the first is closed. A swing thread is
  created by `swing.create_thread` (02p), which shares the checks and the insert below.
- **Plan edits apply from the next session.** A session snapshots the plan when it starts, so a day already under way
  is scored against the plan it began with. The starting balance and the mode never change.
- **Closing** archives the daily plan and freezes the thread (no plan edits, no new days). It waits for an open
  practice day: that day holds trades that are not scored yet. A swing thread's open holds exit at the last ended
  day's close first (`swing.close_thread`).
- **A practised day** is an ended day list that had a session; a **skipped day** ended with none, and the balance
  simply carries. In a swing thread a ledger row belongs to the ended day it exited on (it may have no session).

All money here is SIMULATED and every sentence that mentions it says so.
"""

from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ai_trading.contracts.practice_thread import PracticeThreadCreateV1, PracticeThreadPatchV1, PracticeThreadV1
from ai_trading.db.models import PracticeLedger, PracticePlan, PracticeThread, ReplayDayList, ReplaySession
from ai_trading.replay.ledger import entry_out, utc_z
from ai_trading.replay.session import ReplayProblem, Services

SIMULATED_LABEL = "Simulated money · practice only, never a real account"
SWING_CLOSED = "Swing threads are not open yet · start a day thread"
NO_THREAD = "Start a practice thread first · it holds your simulated balance and risk plan"
CLOSED_THREAD = "Your practice thread is closed · start a new thread to keep practising"
DAY_OPEN = "End today's practice day before closing the thread · its simulated trades are not scored yet"
LEDGER_LIMIT = 500


class ThreadNotFound(Exception):
    pass


def _swing() -> Any:
    """The swing module, imported on first use: it imports this module."""
    from ai_trading.replay import swing

    return swing


# -- reading -------------------------------------------------------------------------------------------------


def get_thread(db: Session, user_id: int, thread_id: int, *, lock: bool = False) -> PracticeThread:
    query = select(PracticeThread).where(PracticeThread.id == thread_id)
    row = db.execute(query.with_for_update() if lock else query).scalar_one_or_none()
    if row is None or row.owner_user_id != user_id:  # never confirm existence to a non-owner
        raise ThreadNotFound(thread_id)
    return row


def active_thread(db: Session, user_id: int, mode: str = "day", *, lock: bool = False) -> PracticeThread | None:
    query = select(PracticeThread).where(
        PracticeThread.owner_user_id == user_id, PracticeThread.mode == mode, PracticeThread.status == "active"
    )
    return db.execute(query.with_for_update() if lock else query).scalar_one_or_none()


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
    """The thread's plan as a `ReplaySessionV1.plan`, which is what the journal scores a session against."""
    plan: dict[str, Any] = {
        "stopRequired": thread.stop_note_on_entry,
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


def create_thread(db: Session, user_id: int, spec: PracticeThreadCreateV1, now: datetime) -> PracticeThread:
    """A DAY thread. A swing body is not served here: swing threads are created by `swing.create_thread`, which checks
    the days, the universe and the arms first and then calls `check_new_thread` and `add_thread` below. The 422 stays
    for a swing body that reaches this path."""
    dumped = spec.model_dump(mode="json", by_alias=True, exclude_none=True)
    if dumped["mode"] != "day":
        raise ReplayProblem(SWING_CLOSED, path="mode")
    check_new_thread(db, user_id, dumped)
    return add_thread(db, user_id, dumped, now)


def check_new_thread(db: Session, user_id: int, dumped: dict[str, Any]) -> None:
    """The create rules on top of the contract: the plan fits the balance, no other thread of the mode is active."""
    _check_plan(dumped["plan"], dumped["startingBalance"])
    if active_thread(db, user_id, dumped["mode"], lock=True) is not None:
        raise _already_active(dumped["mode"])


def add_thread(db: Session, user_id: int, dumped: dict[str, Any], now: datetime) -> PracticeThread:
    """Write the thread row (`dumped` passed `check_new_thread`). The unique index is the backstop for a concurrent
    create of the same mode."""
    plan = dumped["plan"]
    row = PracticeThread(
        owner_user_id=user_id,
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
    try:
        db.flush()
    except IntegrityError:  # a concurrent create of the same thread
        db.rollback()
        raise _already_active(dumped["mode"]) from None
    return row


def _already_active(mode: str) -> ReplayProblem:
    return ReplayProblem(
        f"You already have an active {mode} thread · close it before starting another", path="mode", status=409
    )


def patch_thread(
    db: Session, user_id: int, thread_id: int, spec: PracticeThreadPatchV1, now: datetime
) -> PracticeThread:
    """Replace the plan while the thread is active. A limit left out is cleared."""
    row = get_thread(db, user_id, thread_id, lock=True)
    if row.status == "closed":
        raise ReplayProblem("This thread is closed · its plan can no longer change", path="plan", status=409)
    plan = spec.model_dump(mode="json", by_alias=True, exclude_none=True)["plan"]
    _check_plan(plan, row.starting_balance)
    row.stop_note_on_entry = plan["stopNoteOnEntry"]
    row.trade_only_on_signal = plan["tradeOnlyOnSignal"]
    row.max_loss_usd = plan.get("maxLossUsd")
    row.max_trades = plan.get("maxTrades")
    row.plan_note = plan.get("planNote")
    row.updated_at = now
    db.flush()
    return row


def open_day(db: Session, thread_id: int) -> ReplayDayList | None:
    """The practice day under way: the unfinished day list of the thread's active daily plan, else a day a replaced
    plan left half practised (it has a session whose trades still book, so it holds the thread open). A new plan ends
    the day it replaces (D-030), so that second case is a day stored before then. A replaced plan's day that was only
    listed holds nothing and is ignored."""
    return db.execute(
        select(ReplayDayList)
        .join(PracticePlan, PracticePlan.id == ReplayDayList.plan_id)
        .where(
            PracticePlan.thread_id == thread_id,
            ReplayDayList.status != "ended",
            or_(PracticePlan.status == "active", ReplayDayList.status == "practicing"),
        )
        .order_by((PracticePlan.status == "active").desc(), ReplayDayList.day.desc())
        .limit(1)
    ).scalar_one_or_none()


def close_thread(
    db: Session, user_id: int, thread_id: int, now: datetime, svc: Services | None = None
) -> PracticeThread:
    """Freeze the thread: archive its daily plan, stamp `closed_at`. A swing thread's open holds exit at the last ended
    close and its open week is frozen first (with its review when `svc` is given). Idempotent."""
    row = get_thread(db, user_id, thread_id, lock=True)
    if row.status == "closed":
        return row
    under_way = open_day(db, row.id)
    if under_way is not None:
        # 02p b7: a swing thread names the day ("scored weekly" makes the day thread's sentence wrong for it).
        raise ReplayProblem(
            f"End Day {under_way.day_no} first" if row.mode == "swing" else DAY_OPEN, path="status", status=409
        )
    if row.mode == "swing":
        _swing().close_thread(db, row, now, svc)
    for plan in db.execute(
        select(PracticePlan).where(PracticePlan.thread_id == row.id, PracticePlan.status == "active")
    ).scalars():
        plan.status, plan.updated_at = "archived", now
    row.status, row.closed_at, row.updated_at = "closed", now, now
    db.flush()
    return row


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


def _ended_days(db: Session, thread_id: int) -> list[ReplayDayList]:
    return list(
        db.execute(
            select(ReplayDayList)
            .join(PracticePlan, PracticePlan.id == ReplayDayList.plan_id)
            .where(PracticePlan.thread_id == thread_id, ReplayDayList.status == "ended")
            .order_by(ReplayDayList.ended_at, ReplayDayList.id)
        ).scalars()
    )


def _day_adherence(day: ReplayDayList) -> int | None:
    """The day's adherence: the mean of its sessions' scores (a session with no applicable check has none)."""
    scores = [s["adherence_pct"] for s in (day.journal or {}).get("sessions", []) if s.get("adherence_pct") is not None]
    return round(sum(scores) / len(scores)) if scores else None


def _series(db: Session, thread: PracticeThread, ledger: list[PracticeLedger]) -> list[dict[str, Any]]:
    """One row per ended day, in practice order: skipped or practised, its trades and P/L, the balance after."""
    days = _ended_days(db, thread.id)
    if not days:
        return []
    ids = [d.id for d in days]
    session_day = dict(
        db.execute(select(ReplaySession.id, ReplaySession.day_list_id).where(ReplaySession.day_list_id.in_(ids))).all()
    )
    sessions = dict(
        db.execute(
            select(ReplaySession.day_list_id, func.count())
            .where(ReplaySession.day_list_id.in_(ids))
            .group_by(ReplaySession.day_list_id)
        ).all()
    )
    pnl: dict[int, Decimal] = {}
    trades: dict[int, int] = {}
    by_date = {day.day: day.id for day in days} if thread.mode == "swing" else {}
    for entry in ledger:
        # a swing row may have no session (an auto exit at a close): it belongs to the ended day it exited on
        day_list_id = by_date.get(entry.day) if thread.mode == "swing" else session_day.get(entry.session_id)
        if day_list_id is not None:
            pnl[day_list_id] = pnl.get(day_list_id, Decimal(0)) + entry.pnl_usd
            trades[day_list_id] = trades.get(day_list_id, 0) + 1
    balance, rows = thread.starting_balance, []
    for index, day in enumerate(days, start=1):
        day_pnl = pnl.get(day.id, Decimal(0))
        balance += day_pnl
        rows.append(
            {
                "n": index,
                "day_list_id": day.id,
                "day": day.day,
                "weekday": _weekday(day.day),
                "kind": "practiced" if sessions.get(day.id) else "skipped",
                "trades": trades.get(day.id, 0),
                "pnl_usd": _money(day_pnl),
                "adherence_pct": _day_adherence(day),
                "balance": _money(balance),
            }
        )
    return rows


def day_balances(db: Session, thread: PracticeThread, day_list_id: int) -> tuple[float, float] | None:
    """The SIMULATED balance before and after one ended day of the thread, from the same series the journal draws (None
    for a day that has not ended or is not the thread's)."""
    for row in _series(db, thread, _ledger(db, thread.id)):
        if row["day_list_id"] == day_list_id:
            return _money(Decimal(str(row["balance"])) - Decimal(str(row["pnl_usd"]))), row["balance"]
    return None


def _stats(thread: PracticeThread, ledger: list[PracticeLedger], series: list[dict[str, Any]]) -> dict[str, Any]:
    """`PracticeThreadStatsV1`: every figure from the ledger and the day series; an empty figure is absent."""
    pnls = [entry.pnl_usd for entry in ledger]
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p < 0]
    practised = [row for row in series if row["kind"] == "practiced"]
    scored = [row["adherence_pct"] for row in practised if row["adherence_pct"] is not None]
    stats: dict[str, Any] = {
        "balance": _money(thread.starting_balance + sum(pnls, Decimal(0))),
        "daysPracticed": len(practised),
        "daysSkipped": len(series) - len(practised),
        "wins": len(wins),
        "losses": len(losses),
    }
    optional = {
        "winRate": round(len(wins) / len(pnls), 3) if pnls else None,
        "avgWinUsd": _money(sum(wins, Decimal(0)) / len(wins)) if wins else None,
        "avgLossUsd": _money(sum(losses, Decimal(0)) / len(losses)) if losses else None,
        "bestDayUsd": max(row["pnl_usd"] for row in practised) if practised else None,
        "worstDayUsd": min(row["pnl_usd"] for row in practised) if practised else None,
        "adherenceFirstPct": scored[0] if scored else None,
        "adherenceLastPct": scored[-1] if scored else None,
    }
    return {**stats, **{key: value for key, value in optional.items() if value is not None}}


def _contract(db: Session, thread: PracticeThread, stats: dict[str, Any]) -> PracticeThreadV1:
    doc: dict[str, Any] = {
        "schemaVersion": 1,
        "id": thread.id,
        "mode": thread.mode,
        "startingBalance": int(thread.starting_balance),
        "status": thread.status,
        "plan": plan_dict(thread),
        "createdAt": utc_z(thread.created_at),
        "stats": stats,
    }
    if thread.closed_at is not None:
        doc["closedAt"] = utc_z(thread.closed_at)
    if thread.mode == "swing":  # the contract's `swing` block is the setup the plan row froze (R2)
        spec = db.execute(
            select(PracticePlan.spec)
            .where(PracticePlan.thread_id == thread.id)
            .order_by(PracticePlan.id.desc())
            .limit(1)
        ).scalar_one()
        doc["swing"] = {key: value for key, value in spec.items() if key != "mode"}
    return PracticeThreadV1.model_validate(doc)


def _realized(db: Session, thread: PracticeThread, day: ReplayDayList | None) -> tuple[int, Decimal]:
    """What the day's trades have credited to the ledger. A swing hold credits when its exit day ENDS, so a day under
    way reads zero; its rows have no session, so they are found by date."""
    if day is None:
        return 0, Decimal(0)
    query = select(func.count(PracticeLedger.id), func.coalesce(func.sum(PracticeLedger.pnl_usd), 0))
    if thread.mode == "swing":
        query = query.where(PracticeLedger.thread_id == thread.id, PracticeLedger.day == day.day)
    else:
        query = query.join(ReplaySession, ReplaySession.id == PracticeLedger.session_id).where(
            ReplaySession.day_list_id == day.id
        )
    count, total = db.execute(query).one()
    return count, Decimal(total)


def _today(db: Session, thread: PracticeThread) -> dict[str, Any] | None:
    """The practice day under way and what it has realized so far (an open trade is not realized)."""
    day = open_day(db, thread.id)
    if day is None:
        return None
    trades, pnl = _realized(db, thread, day)
    return {
        "day_list_id": day.id,
        "day": day.day,
        "weekday": _weekday(day.day),
        "day_no": day.day_no,
        "status": day.status,
        "trades": trades,
        "pnl_usd": _money(pnl),
    }


def summary(db: Session, thread: PracticeThread) -> dict[str, Any]:
    ledger = _ledger(db, thread.id)
    stats = _stats(thread, ledger, _series(db, thread, ledger))
    out = {"thread": _contract(db, thread, stats), "today": _today(db, thread), "label": SIMULATED_LABEL}
    if thread.mode == "swing":
        out["swing"] = _swing().state(db, thread)
    return out


def detail(db: Session, thread: PracticeThread) -> dict[str, Any]:
    """The thread, its stats, today, the day series and the balance curve (the starting point, then each ended day)."""
    ledger = _ledger(db, thread.id)
    series = _series(db, thread, ledger)
    curve = [{"n": 0, "day": None, "balance": _money(thread.starting_balance)}] + [
        {"n": row["n"], "day": row["day"], "balance": row["balance"]} for row in series
    ]
    out = {
        "thread": _contract(db, thread, _stats(thread, ledger, series)),
        "today": _today(db, thread),
        "label": SIMULATED_LABEL,
        "daily": series,
        "curve": curve,
    }
    if thread.mode == "swing":
        out["swing"] = _swing().state(db, thread)
    return out


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


def brief(db: Session, thread_id: int | None, day_list_id: int | None = None) -> dict[str, Any] | None:
    """The header strip of a day screen or the workspace: balance and the realized P/L of the day being viewed
    (`day_list_id`), else of the practice day under way. None without a thread."""
    if thread_id is None:
        return None
    thread = db.get(PracticeThread, thread_id)
    if thread is None:
        return None
    total = db.execute(
        select(func.coalesce(func.sum(PracticeLedger.pnl_usd), 0)).where(PracticeLedger.thread_id == thread.id)
    ).scalar_one()
    if day_list_id is not None:
        today_pnl: float | None = _money(_realized(db, thread, db.get(ReplayDayList, day_list_id))[1])
    else:
        today = _today(db, thread)
        today_pnl = None if today is None else today["pnl_usd"]
    out = {
        "id": thread.id,
        "mode": thread.mode,
        "status": thread.status,
        "balance": _money(thread.starting_balance + Decimal(total)),
        "today_pnl_usd": today_pnl,
        "label": SIMULATED_LABEL,
    }
    if thread.mode == "swing":
        state = _swing().state(db, thread)
        out |= {key: state[key] for key in ("equity_usd", "free_cash_usd", "day_no", "days", "week_no")}
    return out


__all__ = (
    "ThreadNotFound",
    "active_thread",
    "add_thread",
    "brief",
    "check_new_thread",
    "close_thread",
    "create_thread",
    "day_balances",
    "detail",
    "get_thread",
    "ledger_page",
    "list_threads",
    "open_day",
    "patch_thread",
    "plan_dict",
    "resolve_for_plan",
    "session_plan",
    "summary",
)
