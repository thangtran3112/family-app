"""Practice threads end to end on synthetic bars (02r, `replay/threads.py`, `replay/ledger.py`): the thread rules, the
daily plan binding to a thread, the ledger written once per exit mark, the stats read back from the ledger (and the
tests that pin ledger, journal and balance to each other), and the day rules that count every session of a day.
Real Postgres (`scripts/test-db.sh`); the history is the synthetic world of `tests/daily_world.py`, no network.

The world: GAPPER sits at 106 in the premarket and 110 from the open, so a long entered at 09:30 and exited after
10:00 wins 4 a share and the same short loses 4 a share. SPLITTER sits at 100 all day."""

import json
from pathlib import Path

import pytest
from daily_world import DAYS, NOW, make_thread
from sqlalchemy import select, update
from test_replay_plan import _advance, _block, _first_list, _open, _plan, _ready, _thread

from ai_trading.contracts.practice_thread import (
    PracticeLedgerEntryV1,
    PracticeThreadCreateV1,
    PracticeThreadPatchV1,
    PracticeThreadV1,
)
from ai_trading.core.calendar import et
from ai_trading.db.models import (
    PracticeLedger,
    PracticeMark,
    PracticePlan,
    PracticeThread,
    ReplayDayList,
    ReplaySession,
    User,
)
from ai_trading.replay import journal as journal_mod
from ai_trading.replay import ledger as ledger_mod
from ai_trading.replay import plan as plan_mod
from ai_trading.replay import session as session_mod
from ai_trading.replay import threads as threads_mod
from ai_trading.replay.session import ReplayProblem, SessionNotFound

# A swing thread is created with a swing block (the contract), so this is the block of a valid swing create.
_SWING_CREATE = (
    Path(__file__).resolve().parents[3] / "contracts/fixtures/practice-thread-create-v1/valid/swing-10-symbols.json"
)
SWING = json.loads(_SWING_CREATE.read_text())["swing"]


def _create(mode="day", balance=None, **plan):
    body = {"schemaVersion": 1, "mode": mode, "plan": {"stopNoteOnEntry": "no", "tradeOnlyOnSignal": "no", **plan}}
    if balance is not None:
        body["startingBalance"] = balance
    if mode == "swing":
        body["swing"] = SWING
    return PracticeThreadCreateV1.model_validate(body)


def _patch(**plan):
    body = {"schemaVersion": 1, "plan": {"stopNoteOnEntry": "no", "tradeOnlyOnSignal": "no", **plan}}
    return PracticeThreadPatchV1.model_validate(body)


def _stats(db_session, thread):
    return threads_mod.detail(db_session, thread)["thread"].stats


def _mark(db_session, user_id, svc, session_id, kind, **extra):
    return session_mod.place_mark(db_session, user_id, session_id, svc, {"schemaVersion": 1, "kind": kind, **extra})


def _ledger(db_session, thread_id=None):
    query = select(PracticeLedger).order_by(PracticeLedger.id)
    if thread_id is not None:
        query = query.where(PracticeLedger.thread_id == thread_id)
    return list(db_session.execute(query).scalars())


def _trade(db_session, user_id, svc, session_id, side, *, shares, enter="09:30", leave="10:00", **extra):
    """A round trip on GAPPER: enters at `enter` (106 before the open's first bar closes), exits at `leave` (110)."""
    _advance(db_session, user_id, svc, session_id, enter)
    _mark(db_session, user_id, svc, session_id, f"{side}_entry", shares=shares, **extra)
    _advance(db_session, user_id, svc, session_id, leave)
    return _mark(db_session, user_id, svc, session_id, f"{side}_exit")


# -- the thread's own rules --------------------------------------------------------------------------------------


def test_a_thread_starts_with_the_default_balance_and_the_contract_reads_back(db_session, user_id) -> None:
    thread = threads_mod.create_thread(db_session, user_id, _create(maxLossUsd=300, planNote="First hour."), NOW)
    out = threads_mod.detail(db_session, thread)
    contract = PracticeThreadV1.model_validate(out["thread"].model_dump(mode="json", by_alias=True, exclude_none=True))
    assert (contract.startingBalance, contract.status, contract.mode) == (50_000, "active", "day")
    assert contract.plan.maxLossUsd == 300 and contract.plan.maxTrades is None and contract.closedAt is None
    assert contract.stats.balance == 50_000 and contract.stats.daysPracticed == 0 and contract.stats.winRate is None
    assert out["curve"] == [{"n": 0, "day": None, "balance": 50_000.0}] and out["daily"] == [] and out["today"] is None
    assert "Simulated" in out["label"]


def test_one_active_day_thread_per_owner_and_a_swing_create_is_not_served_by_the_day_path(db_session, user_id) -> None:
    threads_mod.create_thread(db_session, user_id, _create(), NOW)
    with pytest.raises(ReplayProblem) as second:
        threads_mod.create_thread(db_session, user_id, _create(), NOW)
    assert (second.value.status, second.value.path) == (409, "mode")
    assert second.value.message == "You already have an active day thread · close it before starting another"
    # A valid swing create (it carries its swing block) still belongs to `swing.create_thread`, not to this path.
    with pytest.raises(ReplayProblem) as swing:
        threads_mod.create_thread(db_session, user_id, _create(mode="swing"), NOW)
    assert (swing.value.status, swing.value.path) == (422, "mode")


def test_a_max_loss_above_the_simulated_balance_is_refused_at_create_and_at_patch(db_session, user_id) -> None:
    with pytest.raises(ReplayProblem) as create:
        threads_mod.create_thread(db_session, user_id, _create(balance=1000, maxLossUsd=1001), NOW)
    assert create.value.path == "plan.maxLossUsd" and "simulated starting balance ($1,000)" in create.value.message
    thread = threads_mod.create_thread(db_session, user_id, _create(balance=1000), NOW)
    with pytest.raises(ReplayProblem) as patch:
        threads_mod.patch_thread(db_session, user_id, thread.id, _patch(maxLossUsd=2000), NOW)
    assert patch.value.path == "plan.maxLossUsd"
    threads_mod.patch_thread(db_session, user_id, thread.id, _patch(maxLossUsd=1000), NOW)  # the whole balance is fine


def test_patch_replaces_the_plan_clears_what_is_left_out_and_never_touches_the_balance(db_session, user_id) -> None:
    thread = threads_mod.create_thread(db_session, user_id, _create(balance=20_000, maxLossUsd=200, maxTrades=4), NOW)
    threads_mod.patch_thread(
        db_session, user_id, thread.id, _patch(stopNoteOnEntry="yes", tradeOnlyOnSignal="yes", maxTrades=2), NOW
    )
    assert threads_mod.plan_dict(thread) == {"stopNoteOnEntry": "yes", "tradeOnlyOnSignal": "yes", "maxTrades": 2}
    assert int(thread.starting_balance) == 20_000


def test_a_stranger_cannot_read_or_change_a_thread(db_session, user_id) -> None:
    thread = threads_mod.create_thread(db_session, user_id, _create(), NOW)
    other = User(email="spouse@example.com", settings={})
    db_session.add(other)
    db_session.commit()
    for call in (
        lambda: threads_mod.get_thread(db_session, other.id, thread.id),
        lambda: threads_mod.patch_thread(db_session, other.id, thread.id, _patch(), NOW),
        lambda: threads_mod.close_thread(db_session, other.id, thread.id, NOW),
        lambda: threads_mod.resolve_for_plan(db_session, other.id, thread.id),
    ):
        with pytest.raises(threads_mod.ThreadNotFound):
            call()
    assert threads_mod.list_threads(db_session, other.id) == []


# -- the daily plan binds to a thread ----------------------------------------


def test_a_plan_needs_a_thread_and_says_so_in_plain_words(db_session, user_id) -> None:
    with pytest.raises(ReplayProblem) as none:
        threads_mod.resolve_for_plan(db_session, user_id, None)
    assert (none.value.status, none.value.path) == (409, "threadId")
    assert none.value.message == "Start a practice thread first · it holds your simulated balance and risk plan"


def test_a_plan_binds_to_the_named_thread_or_to_the_active_one(db_session, user_id, svc) -> None:
    thread = make_thread(db_session, user_id)
    assert threads_mod.resolve_for_plan(db_session, user_id, None).id == thread.id
    assert threads_mod.resolve_for_plan(db_session, user_id, thread.id).id == thread.id
    plan = plan_mod.create_plan(db_session, user_id, _block(db_session, user_id), svc, thread)
    assert plan.thread_id == thread.id and plan_mod.plan_out(db_session, plan)["thread_id"] == thread.id
    assert plan_mod.hub(db_session, user_id)["thread"]["thread"].id == thread.id


def test_closing_waits_for_an_open_day_then_archives_the_plan_and_refuses_new_plans(db_session, user_id, svc) -> None:
    row = _first_list(db_session, user_id, svc)
    thread = threads_mod.active_thread(db_session, user_id)
    with pytest.raises(ReplayProblem) as open_day:
        threads_mod.close_thread(db_session, user_id, thread.id, NOW)
    assert open_day.value.status == 409 and "End today's practice day" in open_day.value.message
    plan_mod.end_day(db_session, user_id, row.id, svc)
    closed = threads_mod.close_thread(db_session, user_id, thread.id, NOW)
    assert closed.status == "closed" and closed.closed_at == NOW
    plan = db_session.get(PracticePlan, row.plan_id)
    assert plan.status == "archived" and plan_mod.hub(db_session, user_id)["plan"] is None
    assert threads_mod.close_thread(db_session, user_id, thread.id, NOW) is closed  # idempotent

    expected = "Your practice thread is closed · start a new thread to keep practising"
    for named in (None, thread.id):
        with pytest.raises(ReplayProblem) as refused:
            threads_mod.resolve_for_plan(db_session, user_id, named)
        assert (refused.value.status, refused.value.message) == (409, expected)
    with pytest.raises(ReplayProblem) as edit:
        threads_mod.patch_thread(db_session, user_id, thread.id, _patch(), NOW)
    assert edit.value.status == 409 and "closed" in edit.value.message
    assert threads_mod.create_thread(db_session, user_id, _create(), NOW).status == "active"  # a new thread may start
    out = threads_mod.detail(db_session, closed)["thread"]
    assert out.status == "closed" and out.closedAt is not None


def _open_days(db_session, thread_id):
    """Every unfinished day list of the thread, on any of its plans."""
    return list(
        db_session.execute(
            select(ReplayDayList)
            .join(PracticePlan, PracticePlan.id == ReplayDayList.plan_id)
            .where(PracticePlan.thread_id == thread_id, ReplayDayList.status != "ended")
        ).scalars()
    )


def test_replacing_a_plan_ends_its_half_practised_day_so_one_day_is_open_and_the_balance_reconciles(
    db_session, user_id, svc
) -> None:
    """D-030: the replaced plan's half-practised day used to stay open beside the new plan's Day 1, and TODAY read the
    new day's $0 beside a balance that already held the old day's +$40."""
    row, session, thread = _day_one(db_session, user_id, svc)
    _trade(db_session, user_id, svc, session.id, "long", shares=10)  # +40 booked, the day still open
    assert threads_mod.brief(db_session, thread.id)["today_pnl_usd"] == 40.0

    _ready(db_session, user_id, svc)  # a new plan replaces the old one
    old = db_session.get(PracticePlan, row.plan_id)
    ended = db_session.get(ReplayDayList, row.id)
    assert old.status == "archived" and ended.status == "ended" and ended.ended_at is not None
    assert ended.journal["pnl_usd"] == 40.0 and ended.journal["trades"] == 1 and ended.review is not None
    assert _open_days(db_session, thread.id) == []  # the old day is over; the new plan has not opened a day yet

    opened = _open(db_session, user_id, svc).day_list  # the new plan's Day 1
    assert opened.id != row.id and (opened.day_no, opened.status) == (1, "listed")
    assert [day.id for day in _open_days(db_session, thread.id)] == [opened.id]
    assert threads_mod.open_day(db_session, thread.id).id == opened.id

    detail = threads_mod.detail(db_session, thread)
    assert detail["thread"].stats.balance == 50_040.0 == detail["curve"][-1]["balance"]
    assert [(d["day_list_id"], d["kind"], d["pnl_usd"], d["balance"]) for d in detail["daily"]] == [
        (row.id, "practiced", 40.0, 50_040.0)
    ]
    assert detail["today"]["day_list_id"] == opened.id and detail["today"]["pnl_usd"] == 0.0
    assert threads_mod.brief(db_session, thread.id, row.id)["today_pnl_usd"] == 40.0  # the old day keeps its own header
    assert threads_mod.brief(db_session, thread.id)["balance"] == 50_040.0
    assert _stats(db_session, thread).bestDayUsd == _stats(db_session, thread).worstDayUsd == 40.0


def test_a_day_has_one_number_in_its_thread_after_a_plan_replacement(db_session, user_id, svc) -> None:
    """D-047: the replaced plan's Day 1 and the new plan's Day 1 both read `day_no` 1, and the journal called the second
    one D2. A plan carries the days the thread ended before it (`day_offset`), so `day_no + day_offset` is the one
    number of a day in the thread, and it is the journal's `n`."""
    row, session, thread = _day_one(db_session, user_id, svc)
    _trade(db_session, user_id, svc, session.id, "long", shares=10)
    _ready(db_session, user_id, svc)  # a new plan; the half-practised day ends with the old one
    opened = _open(db_session, user_id, svc).day_list
    assert (row.day_no, opened.day_no) == (1, 1)  # the list rows alone cannot tell the days apart

    def number(day_list_id: int) -> int:
        out = plan_mod.day_list_out(db_session, user_id, day_list_id, svc)
        return out["day_no"] + out["plan"]["day_offset"]

    assert (number(row.id), number(opened.id)) == (1, 2)
    assert plan_mod.plan_out(db_session, db_session.get(PracticePlan, opened.plan_id))["current"]["day_no"] == 1
    plan_mod.end_day(db_session, user_id, opened.id, svc)
    second = _open(db_session, user_id, svc).day_list
    assert (second.day_no, number(second.id)) == (2, 3)
    plan_mod.end_day(db_session, user_id, second.id, svc)
    journal = {day["day_list_id"]: day["n"] for day in threads_mod.detail(db_session, thread)["daily"]}
    assert journal == {row.id: 1, opened.id: 2, second.id: 3}
    assert [number(day_id) for day_id in journal] == [1, 2, 3]


def test_a_plan_after_a_listed_only_day_does_not_count_it(db_session, user_id, svc) -> None:
    """A replaced plan's day that was only listed never ends: the journal never numbers it, and nor does the offset."""
    row = _first_list(db_session, user_id, svc)
    thread = threads_mod.active_thread(db_session, user_id)
    _plan(db_session, user_id, svc)
    opened = _open(db_session, user_id, svc).day_list
    assert opened.id != row.id
    assert plan_mod.day_list_out(db_session, user_id, opened.id, svc)["plan"]["day_offset"] == 0
    assert threads_mod.detail(db_session, thread)["daily"] == []


def test_the_card_row_reads_the_last_ended_day_from_the_balances_own_series(db_session, user_id, svc) -> None:
    """The thread list answers the last ended day beside `today`, so the hub card shows a figure with no day open."""
    row, session, thread = _day_one(db_session, user_id, svc)
    assert threads_mod.summary(db_session, thread)["last_day"] is None
    _trade(db_session, user_id, svc, session.id, "long", shares=10)
    plan_mod.end_day(db_session, user_id, row.id, svc)
    summary = threads_mod.summary(db_session, thread)
    assert summary["today"] is None
    assert summary["last_day"]["pnl_usd"] == 40.0 and summary["last_day"]["trades"] == 1
    assert summary["last_day"] == threads_mod.detail(db_session, thread)["daily"][-1]
    assert summary["last_day"]["balance"] == summary["thread"].stats.balance == 50_040.0


def test_replacing_a_plan_exits_an_open_trade_at_the_last_price_and_books_it(db_session, user_id, svc) -> None:
    row, session, thread = _day_one(db_session, user_id, svc)
    _advance(db_session, user_id, svc, session.id, "09:30")
    _mark(db_session, user_id, svc, session.id, "long_entry", shares=10)
    _advance(db_session, user_id, svc, session.id, "10:00")  # GAPPER is 110 here, 4 a share above the entry
    assert _ledger(db_session, thread.id) == []  # an open trade has realized nothing

    _plan(db_session, user_id, svc)
    ended = db_session.get(ReplayDayList, row.id)
    assert ended.status == "ended" and ended.journal["pnl_usd"] == 40.0
    assert [entry.pnl_usd for entry in _ledger(db_session, thread.id)] == [40]
    assert _stats(db_session, thread).balance == 50_040.0 and _open_days(db_session, thread.id) == []


def test_a_rejected_replacement_leaves_the_half_practised_day_open(db_session, user_id, svc) -> None:
    row, session, thread = _day_one(db_session, user_id, svc)
    _trade(db_session, user_id, svc, session.id, "long", shares=10)
    db_session.commit()
    with pytest.raises(ReplayProblem):
        _plan(db_session, user_id, svc, firstDay="2016-12-30")  # fails validation before the old plan is touched
    db_session.rollback()
    assert db_session.get(ReplayDayList, row.id).status == "practicing"
    assert db_session.get(PracticePlan, row.plan_id).status == "active"


def test_a_replaced_plans_day_that_was_only_listed_does_not_hold_the_thread(db_session, user_id, svc) -> None:
    row = _first_list(db_session, user_id, svc)  # listed, no session
    thread = threads_mod.active_thread(db_session, user_id)
    _plan(db_session, user_id, svc)
    assert db_session.get(type(row), row.id).status == "listed" and threads_mod.open_day(db_session, thread.id) is None
    assert threads_mod.close_thread(db_session, user_id, thread.id, NOW).status == "closed"


def test_a_day_left_open_on_an_archived_plan_cannot_start_a_session_in_a_closed_thread(
    db_session, user_id, svc
) -> None:
    row = _first_list(db_session, user_id, svc)
    thread = threads_mod.active_thread(db_session, user_id)
    plan = db_session.get(PracticePlan, row.plan_id)
    plan.status = "archived"  # a replaced plan leaves its open day behind
    db_session.commit()
    threads_mod.close_thread(db_session, user_id, thread.id, NOW)
    with pytest.raises(ReplayProblem) as refused:
        plan_mod.start_session(db_session, user_id, row.id, "GAPPER", svc)
    assert refused.value.status == 409 and "closed" in refused.value.message


# -- the session scores against the thread's plan -----------------------------------------------------------------


def test_a_session_snapshots_the_threads_plan_and_a_later_edit_does_not_rescore_it(db_session, user_id, svc) -> None:
    thread = make_thread(db_session, user_id, stopNoteOnEntry="yes", maxLossUsd=250, maxTrades=3, planNote="Plan A.")
    _ready(db_session, user_id, svc)
    row = _open(db_session, user_id, svc).day_list
    first = plan_mod.start_session(db_session, user_id, row.id, "GAPPER", svc)
    assert first.thread_id == thread.id and first.day_list_id == row.id
    assert first.spec["plan"] == {
        "stopRequired": "yes",
        "signalOnly": "no",
        "maxLossUsd": 250,
        "maxTrades": 3,
        "note": "Plan A.",
    }
    assert first.spec["shares"] == plan_mod.DAY_SESSION_SHARES
    threads_mod.patch_thread(db_session, user_id, thread.id, _patch(maxTrades=1), NOW)
    db_session.commit()
    db_session.refresh(first)
    assert first.spec["plan"]["maxTrades"] == 3  # the session began under Plan A
    plan_mod.end_day(db_session, user_id, row.id, svc)
    next_session = plan_mod._session_spec(db_session.get(PracticePlan, row.plan_id), DAYS[1], "GAPPER", thread)
    assert next_session.plan.model_dump(exclude_none=True) == {"stopRequired": "no", "signalOnly": "no", "maxTrades": 1}


def test_a_standalone_session_has_no_thread_and_books_nothing(db_session, user_id, svc) -> None:
    make_thread(db_session, user_id)
    spec = plan_mod._session_spec(
        PracticePlan(spec=_block(db_session, user_id).model_dump(by_alias=True, exclude_none=True)),
        DAYS[0],
        "GAPPER",
        _thread(db_session, user_id),
    )
    standalone = session_mod.create(db_session, user_id, spec, svc)
    assert standalone.thread_id is None and standalone.day_list_id is None
    _advance(db_session, user_id, svc, standalone.id, "09:30")
    _mark(db_session, user_id, svc, standalone.id, "long_entry", shares=10)
    _advance(db_session, user_id, svc, standalone.id, "10:00")
    _mark(db_session, user_id, svc, standalone.id, "long_exit")
    assert _ledger(db_session) == []


# -- the ledger ----------------------------------------


def _day_one(db_session, user_id, svc):
    row = _first_list(db_session, user_id, svc)
    session = plan_mod.start_session(db_session, user_id, row.id, "GAPPER", svc)
    thread = threads_mod.active_thread(db_session, user_id)
    return row, session, thread


def test_an_exit_mark_books_one_ledger_row_with_the_journals_figure(db_session, user_id, svc) -> None:
    _, session, thread = _day_one(db_session, user_id, svc)
    _advance(db_session, user_id, svc, session.id, "09:30")
    entry = _mark(db_session, user_id, svc, session.id, "long_entry", shares=10, stopPrice=104.0)
    assert _ledger(db_session) == []  # an entry realizes nothing
    _advance(db_session, user_id, svc, session.id, "10:00")
    placed = _mark(db_session, user_id, svc, session.id, "long_exit")
    (booked,) = _ledger(db_session)
    assert (booked.thread_id, booked.session_id, booked.mark_id) == (thread.id, session.id, placed["mark"]["id"])
    assert (booked.symbol, booked.side, booked.shares, booked.day) == ("GAPPER", "long", 10, DAYS[0])
    assert (float(booked.entry_price), float(booked.exit_price)) == (106.0, 110.0)
    assert float(booked.pnl_usd) == 40.0 and float(booked.r) == 2.0  # (110 - 106) / |106 - 104|
    assert placed["journal"]["totals"]["pnl_usd"] == 40.0 and entry["mark"]["trade_no"] == 1
    out = PracticeLedgerEntryV1.model_validate(ledger_mod.entry_out(booked))
    assert out.pnlUsd == 40.0 and out.r == 2.0 and out.realizedAt.endswith("Z")
    assert threads_mod.brief(db_session, thread.id)["balance"] == 50_040.0


def test_booking_twice_is_a_no_op_and_undoing_the_exit_takes_the_row_back(db_session, user_id, svc) -> None:
    _, session, thread = _day_one(db_session, user_id, svc)
    placed = _trade(db_session, user_id, svc, session.id, "long", shares=10)
    marks = list(db_session.execute(select(PracticeMark).where(PracticeMark.session_id == session.id)).scalars())
    closed, _ = journal_mod.assemble(session_mod._marks_of(marks))
    assert ledger_mod.book(db_session, session, closed, NOW) == 0  # already booked: idempotent per mark
    assert len(_ledger(db_session)) == 1
    session_mod.undo_mark(db_session, user_id, session.id, placed["mark"]["id"], svc)
    db_session.expire_all()
    assert _ledger(db_session) == [] and threads_mod.brief(db_session, thread.id)["balance"] == 50_000.0
    _mark(db_session, user_id, svc, session.id, "long_exit")  # exit again: booked again, once
    assert len(_ledger(db_session)) == 1


def test_the_days_auto_exit_books_the_open_trade(db_session, user_id, svc) -> None:
    row, session, thread = _day_one(db_session, user_id, svc)
    _advance(db_session, user_id, svc, session.id, "09:30")
    _mark(db_session, user_id, svc, session.id, "long_entry", shares=10)
    _advance(db_session, user_id, svc, session.id, "10:00")
    assert _ledger(db_session) == []  # open: not realized
    plan_mod.end_day(db_session, user_id, row.id, svc)
    (booked,) = _ledger(db_session)
    assert float(booked.pnl_usd) == 40.0 and booked.symbol == "GAPPER"
    marks = list(db_session.execute(select(PracticeMark).where(PracticeMark.session_id == session.id)).scalars())
    assert booked.mark_id == marks[-1].id and marks[-1].source == "auto"
    plan_mod.end_day(db_session, user_id, row.id, svc)  # ending the day again books nothing more
    assert len(_ledger(db_session)) == 1


# -- the numbers: ledger, journal and balance must agree ----------------------------------------


def test_reconcile_ledger_sums_equal_the_session_journal_and_the_balance(db_session, user_id, svc) -> None:
    """One day, two trades (a win and a loss): the ledger's sum per session is the journal's total, its win and loss
    counts are the journal's, and the thread's balance is the starting balance plus that total."""
    row, session, thread = _day_one(db_session, user_id, svc)
    _trade(db_session, user_id, svc, session.id, "long", shares=10, enter="09:30", leave="10:00")  # +40
    _advance(db_session, user_id, svc, session.id, "10:05")
    _mark(db_session, user_id, svc, session.id, "short_entry", shares=5)
    _advance(db_session, user_id, svc, session.id, "10:10")
    _mark(db_session, user_id, svc, session.id, "short_exit")  # 110 to 110: a scratch
    _advance(db_session, user_id, svc, session.id, "10:15")
    _mark(db_session, user_id, svc, session.id, "short_entry", shares=3)
    _mark(db_session, user_id, svc, session.id, "short_exit")  # same minute: a scratch
    plan_mod.end_day(db_session, user_id, row.id, svc)
    db_session.refresh(session)
    totals = session.journal["totals"]
    rows = _ledger(db_session, thread.id)
    assert round(sum(float(r.pnl_usd) for r in rows), 2) == totals["pnl_usd"] == 40.0
    assert len(rows) == totals["trades"] == 3
    stats = _stats(db_session, thread)
    assert (stats.wins, stats.losses) == (totals["wins"], totals["losses"]) == (1, 0)
    assert stats.balance == 50_000 + totals["pnl_usd"]
    detail = threads_mod.detail(db_session, thread)
    assert (
        [d["pnl_usd"] for d in detail["daily"]]
        == [totals["pnl_usd"]]
        == [row_day["pnl_usd"] for row_day in detail["daily"]]
    )
    assert detail["curve"][-1]["balance"] == stats.balance and detail["daily"][-1]["balance"] == stats.balance
    assert detail["daily"][0]["trades"] == 3 and detail["daily"][0]["kind"] == "practiced"


def test_reconcile_the_balance_is_the_ended_days_plus_what_today_has_realized(db_session, user_id, svc) -> None:
    row, session, thread = _day_one(db_session, user_id, svc)
    _trade(db_session, user_id, svc, session.id, "long", shares=10)  # +40 realized, the day still open
    detail = threads_mod.detail(db_session, thread)
    assert detail["today"]["pnl_usd"] == 40.0 and detail["today"]["trades"] == 1 and detail["daily"] == []
    assert detail["thread"].stats.balance == 50_000 + 40.0 and detail["thread"].stats.daysPracticed == 0
    plan_mod.end_day(db_session, user_id, row.id, svc)
    detail = threads_mod.detail(db_session, thread)
    assert detail["today"] is None
    assert (
        detail["thread"].stats.balance
        == detail["daily"][-1]["balance"]
        == 50_000 + sum(d["pnl_usd"] for d in detail["daily"])
    )


def test_stats_are_read_from_the_ledger_never_stored(db_session, user_id, svc) -> None:
    row, session, thread = _day_one(db_session, user_id, svc)
    _trade(db_session, user_id, svc, session.id, "long", shares=10)
    plan_mod.end_day(db_session, user_id, row.id, svc)
    assert _stats(db_session, thread).balance == 50_040.0
    db_session.execute(update(PracticeLedger).values(pnl_usd=-15.5))
    db_session.commit()
    stats = _stats(db_session, thread)
    assert stats.balance == 49_984.5 and (stats.wins, stats.losses) == (0, 1) and stats.avgLossUsd == -15.5
    assert not {"balance", "stats"} & {c.name for c in PracticeThread.__table__.columns}


def test_wins_losses_averages_best_and_worst_day_over_practiced_and_skipped_days(db_session, user_id, svc) -> None:
    row, session, thread = _day_one(db_session, user_id, svc)
    _trade(db_session, user_id, svc, session.id, "long", shares=10)  # day 1: +40
    plan_mod.end_day(db_session, user_id, row.id, svc)
    skipped = _open(db_session, user_id, svc).day_list
    plan_mod.end_day(db_session, user_id, skipped.id, svc)  # day 2: no session, the balance carries
    third = _open(db_session, user_id, svc).day_list
    session3 = plan_mod.start_session(db_session, user_id, third.id, "GAPPER", svc)
    _advance_day(db_session, user_id, svc, session3.id, third.day, "09:30")
    _mark(db_session, user_id, svc, session3.id, "short_entry", shares=10)
    _advance_day(db_session, user_id, svc, session3.id, third.day, "10:00")
    _mark(db_session, user_id, svc, session3.id, "short_exit")  # day 3: -40 (gap day: 106 to 110)
    plan_mod.end_day(db_session, user_id, third.id, svc)

    detail = threads_mod.detail(db_session, thread)
    assert [(d["n"], d["kind"], d["pnl_usd"]) for d in detail["daily"]] == [
        (1, "practiced", 40.0),
        (2, "skipped", 0.0),
        (3, "practiced", -40.0),
    ]
    assert [p["balance"] for p in detail["curve"]] == [50_000.0, 50_040.0, 50_040.0, 50_000.0]
    stats = detail["thread"].stats
    assert (stats.daysPracticed, stats.daysSkipped, stats.wins, stats.losses) == (2, 1, 1, 1)
    assert (stats.winRate, stats.avgWinUsd, stats.avgLossUsd) == (0.5, 40.0, -40.0)
    assert (stats.bestDayUsd, stats.worstDayUsd, stats.balance) == (40.0, -40.0, 50_000.0)


def _advance_day(db_session, user_id, svc, session_id, day, hhmm):
    return session_mod.advance(
        db_session,
        user_id,
        session_id,
        svc,
        to=et(day, hhmm).to_pydatetime(),
        step=None,
        interval=None,
        min_size=0,
        min_notional=0,
        max_prints=50,
    )


def test_a_day_entry_without_a_stop_is_refused_when_the_plan_asks_for_one(db_session, user_id, svc) -> None:
    """D-060: "Stop on every entry" is enforced, not just scored. The refusal says what to do; a stop typed with the
    entry goes through, and the adherence check passes for it."""
    make_thread(db_session, user_id, stopNoteOnEntry="yes")
    _, session, _ = _day_one(db_session, user_id, svc)
    _advance(db_session, user_id, svc, session.id, "09:30")
    with pytest.raises(ReplayProblem) as caught:
        _mark(db_session, user_id, svc, session.id, "long_entry", shares=10)
    assert (caught.value.message, caught.value.path, caught.value.status) == (
        session_mod.STOP_REQUIRED,
        "stopPrice",
        422,
    )
    assert session_mod._load_marks(db_session, session.id) == []  # nothing was written
    placed = _mark(db_session, user_id, svc, session.id, "long_entry", shares=10, stopPrice=104.0)
    assert placed["open_trade"]["stop_price"] == 104.0
    placed = _mark(db_session, user_id, svc, session.id, "stop", stopPrice=105.0)  # the Stop key moves the line
    assert placed["open_trade"]["stop_price"] == 105.0
    _advance(db_session, user_id, svc, session.id, "10:00")
    done = _mark(db_session, user_id, svc, session.id, "long_exit")
    (check,) = [c for c in done["journal"]["adherence"]["checks"] if c["id"] == "stop_set"]
    assert (check["applicable"], check["passed"], check["detail"]) == (True, True, "1 of 1")


def test_adherence_endpoints_are_the_first_and_latest_scored_day(db_session, user_id, svc) -> None:
    make_thread(db_session, user_id, stopNoteOnEntry="yes", tradeOnlyOnSignal="yes")
    row, session, thread = _day_one(db_session, user_id, svc)
    _trade(db_session, user_id, svc, session.id, "long", shares=10, stopPrice=104.0)  # stop set, off a signal: 2 of 3
    plan_mod.end_day(db_session, user_id, row.id, svc)
    second = _open(db_session, user_id, svc).day_list
    plan_mod.end_day(db_session, user_id, second.id, svc)  # skipped: no score
    stats = _stats(db_session, thread)
    day_one = plan_mod.day_list_out(db_session, user_id, row.id, svc)["journal"]["sessions"][0]["adherence_pct"]
    assert day_one == 67 and (stats.adherenceFirstPct, stats.adherenceLastPct) == (67, 67)


def test_listing_puts_active_threads_first_and_a_closed_thread_keeps_its_numbers(db_session, user_id, svc) -> None:
    row, session, old = _day_one(db_session, user_id, svc)
    _trade(db_session, user_id, svc, session.id, "long", shares=10)
    plan_mod.end_day(db_session, user_id, row.id, svc)
    threads_mod.close_thread(db_session, user_id, old.id, NOW)
    new = threads_mod.create_thread(db_session, user_id, _create(balance=10_000), NOW)
    listed = threads_mod.list_threads(db_session, user_id)
    assert [item["thread"].id for item in listed] == [new.id, old.id]
    assert [item["thread"].status for item in listed] == ["active", "closed"]
    assert listed[1]["thread"].stats.balance == 50_040.0 and listed[0]["thread"].stats.balance == 10_000.0


def test_the_ledger_page_is_newest_first_and_counts_every_row(db_session, user_id, svc) -> None:
    row, session, thread = _day_one(db_session, user_id, svc)
    _trade(db_session, user_id, svc, session.id, "long", shares=10, leave="10:00")
    _advance(db_session, user_id, svc, session.id, "10:05")
    _mark(db_session, user_id, svc, session.id, "long_entry", shares=2)
    _advance(db_session, user_id, svc, session.id, "10:10")
    _mark(db_session, user_id, svc, session.id, "long_exit")
    page = threads_mod.ledger_page(db_session, thread, limit=1)
    assert page["total"] == 2 and len(page["entries"]) == 1 and page["entries"][0]["shares"] == 2
    assert "Simulated" in page["label"]
    for entry in threads_mod.ledger_page(db_session, thread)["entries"]:
        PracticeLedgerEntryV1.model_validate(entry)


def test_the_ledger_page_orders_by_booking_not_by_the_replayed_market_time(db_session, user_id, svc) -> None:
    row, session, thread = _day_one(db_session, user_id, svc)
    _trade(db_session, user_id, svc, session.id, "long", shares=10, leave="10:00")
    _advance(db_session, user_id, svc, session.id, "10:05")
    _mark(db_session, user_id, svc, session.id, "long_entry", shares=2)
    _advance(db_session, user_id, svc, session.id, "10:10")
    _mark(db_session, user_id, svc, session.id, "long_exit")
    newest = _ledger(db_session)[-1]
    newest.realized_at = et(DAYS[0], "04:00") - (NOW - NOW.replace(year=2024))  # a replay of a far older month
    db_session.commit()
    assert threads_mod.ledger_page(db_session, thread, limit=1)["entries"][0]["id"] == newest.id


def test_a_thread_session_belongs_to_the_thread_row(db_session, user_id, svc) -> None:
    _, session, thread = _day_one(db_session, user_id, svc)
    assert db_session.get(ReplaySession, session.id).thread_id == thread.id
    with pytest.raises(SessionNotFound):
        session_mod.get_row(db_session, user_id + 99, session.id)


# -- the day rules count every session of the day ----------------------------------------


def _second_name(db_session, user_id, svc, row, thread, symbol="SPLITTER"):
    """A second session on the same day list, through the service (the route's cap and open-trade checks are in
    test_replay_switch.py)."""
    plan = db_session.get(PracticePlan, row.plan_id)
    spec = plan_mod._session_spec(plan, row.day, symbol, thread)
    return session_mod.create(db_session, user_id, spec, svc, day_list=row, thread_id=thread.id)


def _checks(journal):
    return {c["id"]: c for c in journal["adherence"]["checks"]}


def test_max_trades_and_max_loss_count_across_the_days_sessions(db_session, user_id, svc) -> None:
    make_thread(db_session, user_id, maxLossUsd=300, maxTrades=2)
    row, a, thread = _day_one(db_session, user_id, svc)
    _trade(db_session, user_id, svc, a.id, "short", shares=100)  # GAPPER short 106 to 110: -400 at 10:00
    alone = session_mod.session_out(session_mod.context(db_session, svc, db_session.get(ReplaySession, a.id)))
    assert _checks(alone["journal"])["max_loss"]["passed"] is True  # one trade: nothing came after the loss
    b = _second_name(db_session, user_id, svc, row, thread)
    assert b.revealed_through == et(DAYS[0], "10:00")  # starts on the shared day clock
    _mark(db_session, user_id, svc, b.id, "long_entry", shares=1)  # entered after the day's -400 on the other name
    _advance(db_session, user_id, svc, b.id, "10:05")
    _mark(db_session, user_id, svc, b.id, "long_exit")
    _mark(db_session, user_id, svc, b.id, "long_entry", shares=1)
    _advance(db_session, user_id, svc, b.id, "10:10")
    _mark(db_session, user_id, svc, b.id, "long_exit")  # the day's third trade
    plan_mod.end_day(db_session, user_id, row.id, svc)
    for session in (a, b):
        db_session.refresh(session)
        checks = _checks(session.journal)
        assert checks["max_loss"]["passed"] is False and checks["max_loss"]["detail"] == "1 of 3"
        assert checks["max_trades"]["passed"] is False and checks["max_trades"]["detail"] == "3 of 2"
        assert checks["max_trades"]["label"].endswith("across the day")
    assert _checks(b.journal)["stop_set"]["applicable"] is False  # the other checks stay per session


def test_a_siblings_last_exit_is_counted_once_the_day_ends(db_session, user_id, svc) -> None:
    make_thread(db_session, user_id, maxTrades=1)
    row, a, thread = _day_one(db_session, user_id, svc)
    _trade(db_session, user_id, svc, a.id, "long", shares=10)
    b = _second_name(db_session, user_id, svc, row, thread)
    _mark(db_session, user_id, svc, b.id, "long_entry", shares=1)  # left open: the day's auto-exit closes it
    plan_mod.end_day(db_session, user_id, row.id, svc)
    for session in (a, b):
        db_session.refresh(session)
        assert _checks(session.journal)["max_trades"]["detail"] == "2 of 1"  # A ended first, then was rescored
    assert plan_mod.day_list_out(db_session, user_id, row.id, svc)["journal"]["trades"] == 2


def test_sequential_trades_of_one_session_score_exactly_as_before(db_session, user_id, svc) -> None:
    make_thread(db_session, user_id, maxLossUsd=100, maxTrades=2)
    row, a, _ = _day_one(db_session, user_id, svc)
    _trade(db_session, user_id, svc, a.id, "short", shares=100, leave="10:00")  # -400
    _advance(db_session, user_id, svc, a.id, "10:05")
    _mark(db_session, user_id, svc, a.id, "long_entry", shares=1)  # an entry after the loss is a breach
    _mark(db_session, user_id, svc, a.id, "long_exit")
    out = session_mod.session_out(session_mod.context(db_session, svc, db_session.get(ReplaySession, a.id)))
    checks = _checks(out["journal"])
    assert checks["max_loss"]["detail"] == "1 of 2" and checks["max_loss"]["passed"] is False
    assert checks["max_trades"]["passed"] is True and not checks["max_trades"]["label"].endswith("across the day")


# -- the watch check ----------------------------------------


def test_the_watch_check_lists_starred_traded_and_off_watch_names(db_session, user_id, svc) -> None:
    row, a, thread = _day_one(db_session, user_id, svc)
    empty = plan_mod.day_list_out(db_session, user_id, row.id, svc)["watch_check"]
    assert empty == {
        "starred": [],
        "traded": [],
        "off_watch": [],
        "verdict": "no_trades",
        "label": "No trades yet · nothing to check against your watch",
    }
    plan_mod.patch_day_list(
        db_session, user_id, row.id, svc, watch=["GAPPER"], notes=None, rating=None, fields={"watch"}
    )
    _advance(db_session, user_id, svc, a.id, "09:30")
    _mark(db_session, user_id, svc, a.id, "long_entry", shares=1)
    on = plan_mod.day_list_out(db_session, user_id, row.id, svc)["watch_check"]
    assert (on["starred"], on["traded"], on["off_watch"], on["verdict"]) == (["GAPPER"], ["GAPPER"], [], "on_watch")
    assert on["label"] == "Traded only names on your watch"
    _mark(db_session, user_id, svc, a.id, "long_exit")  # one open trade a day: GAPPER closes before the next name
    b = _second_name(db_session, user_id, svc, row, thread)
    _mark(db_session, user_id, svc, b.id, "long_entry", shares=1)
    off = plan_mod.day_list_out(db_session, user_id, row.id, svc)["watch_check"]
    assert (off["traded"], off["off_watch"], off["verdict"]) == (["GAPPER", "SPLITTER"], ["SPLITTER"], "off_watch")
    assert off["label"] == "Traded SPLITTER, not on your watch"
    watching_only = _second_name(db_session, user_id, svc, row, thread, symbol="FLAT")  # a name looked at, not traded
    assert "FLAT" not in plan_mod.day_list_out(db_session, user_id, row.id, svc)["watch_check"]["traded"]
    assert watching_only.day_list_id == row.id


def test_the_day_screen_carries_the_thread_header(db_session, user_id, svc) -> None:
    row, session, thread = _day_one(db_session, user_id, svc)
    _trade(db_session, user_id, svc, session.id, "long", shares=10)
    out = plan_mod.day_list_out(db_session, user_id, row.id, svc)
    assert out["thread"] == {
        "id": thread.id,
        "mode": "day",
        "status": "active",
        "balance": 50_040.0,
        "today_pnl_usd": 40.0,
        "label": threads_mod.SIMULATED_LABEL,
    }


# -- D-007: the old plan fields in a block are ignored, never read, never an error ----------------------------------


LEGACY_SETUP = {"shares": 500, "plan": {"stopRequired": "yes", "signalOnly": "yes", "maxLossUsd": 1, "maxTrades": 1}}


def test_without_legacy_plan_fields_drops_exactly_the_two_keys_and_nothing_else() -> None:
    block = {"firstDay": "2026-09-28", "setup": {"interval": "5m", "armed": [], **LEGACY_SETUP}}
    assert plan_mod.without_legacy_plan_fields(block) == {
        "firstDay": "2026-09-28",
        "setup": {"interval": "5m", "armed": []},
    }
    for odd in (None, [], "x", {"setup": None}, {"firstDay": "2026-09-28"}):
        assert plan_mod.without_legacy_plan_fields(odd) == odd  # not a block: left for the validator to refuse


def test_a_plan_saved_before_0007_is_served_without_the_old_fields_and_scores_with_the_thread(
    db_session, user_id, svc
) -> None:
    thread = make_thread(db_session, user_id, maxTrades=7)
    plan = _ready(db_session, user_id, svc)
    plan.spec = {**plan.spec, "setup": {**plan.spec["setup"], **LEGACY_SETUP}}  # the row as 0006 stored it
    db_session.commit()
    served = plan_mod.plan_out(db_session, plan)["spec"]
    assert "plan" not in served["setup"] and "shares" not in served["setup"]
    row = _open(db_session, user_id, svc).day_list
    session = plan_mod.start_session(db_session, user_id, row.id, "GAPPER", svc)
    assert session.spec["plan"] == {"stopRequired": "no", "signalOnly": "no", "maxTrades": 7}  # not the legacy plan
    assert session.spec["shares"] == plan_mod.DAY_SESSION_SHARES and session.thread_id == thread.id
