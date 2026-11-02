"""Capacity (owner rule, 2026-11-02): at most 10 ACTIVE day threads across all users, and a day list of at most 49
names. Closing a thread frees its slot, swing threads do not use one, and a stored plan that says 50 still loads. Real
Postgres; the synthetic world of `tests/daily_world.py`."""

import threading
from datetime import timedelta

import pytest
from daily_world import NOW, make_thread
from sqlalchemy.orm import sessionmaker
from test_replay_plan import _block, _plan
from test_replay_switch import _names

from ai_trading.contracts.practice_thread import PracticeThreadCreateV1
from ai_trading.db.models import PracticeThread, User
from ai_trading.replay import plan as plan_mod
from ai_trading.replay import threads as threads_mod
from ai_trading.replay.session import ReplayProblem

FULL = "All 10 day-trade slots are in use · close a day thread to start another"


def _spec() -> PracticeThreadCreateV1:
    return PracticeThreadCreateV1.model_validate(
        {"schemaVersion": 1, "mode": "day", "plan": {"stopNoteOnEntry": "no", "tradeOnlyOnSignal": "no"}}
    )


def _dumped(mode: str = "day") -> dict:
    """What `create_thread` hands `add_thread`; a swing row is the same body with its mode (no swing setup is needed to
    count a swing thread)."""
    return {**_spec().model_dump(mode="json", by_alias=True, exclude_none=True), "mode": mode}


def _owners(db_session, count: int = 3) -> list[int]:
    users = [User(email=f"slot{i}@example.com", settings={}) for i in range(count)]
    db_session.add_all(users)
    db_session.commit()
    return [user.id for user in users]


def _fill(db_session, owners: list[int], count: int = 10) -> list[PracticeThread]:
    """`count` active day threads, dealt round-robin over `owners`."""
    out = [
        threads_mod.create_thread(db_session, owners[i % len(owners)], _spec(), NOW + timedelta(seconds=i))
        for i in range(count)
    ]
    db_session.commit()
    return out


def test_ten_active_day_threads_across_three_users_fill_the_house_and_the_eleventh_is_refused(db_session) -> None:
    owners = _owners(db_session)
    _fill(db_session, owners)
    assert threads_mod.capacity(db_session) == {"day_active": 10, "day_max": 10}
    for owner in owners:  # whoever asks: the slots are shared
        with pytest.raises(ReplayProblem) as caught:
            threads_mod.create_thread(db_session, owner, _spec(), NOW)
        assert (caught.value.status, caught.value.path, caught.value.message) == (409, "mode", FULL)
        db_session.rollback()


def test_closing_a_thread_frees_its_slot_and_swing_threads_use_none(db_session) -> None:
    owners = _owners(db_session)
    threads = _fill(db_session, owners)
    for _ in range(12):  # swing is uncapped: it never counts and is never refused
        threads_mod.add_thread(db_session, owners[0], _dumped("swing"), NOW)
    db_session.commit()
    assert threads_mod.capacity(db_session)["day_active"] == 10
    first = threads[0]
    threads_mod.close_thread(db_session, first.owner_user_id, first.id, NOW)
    db_session.commit()
    assert threads_mod.capacity(db_session)["day_active"] == 9
    threads_mod.create_thread(db_session, owners[1], _spec(), NOW)  # the freed slot is taken
    db_session.commit()
    with pytest.raises(ReplayProblem):
        threads_mod.create_thread(db_session, owners[2], _spec(), NOW)


def test_a_house_already_over_the_cap_is_left_alone_and_only_new_creates_are_refused(db_session) -> None:
    owners = _owners(db_session)
    _fill(db_session, owners)
    threads_mod.add_thread(db_session, owners[0], _dumped(), NOW)  # a legacy 11th
    db_session.commit()
    assert threads_mod.capacity(db_session) == {"day_active": 11, "day_max": 10}  # nothing is closed for her
    with pytest.raises(ReplayProblem):
        threads_mod.create_thread(db_session, owners[1], _spec(), NOW)


def test_two_creates_at_nine_active_threads_produce_exactly_one_success(db_engine, db_session) -> None:
    """The advisory lock: the first create holds it until it commits, so the second waits, counts ten and is refused.
    The first transaction is kept open until the second has started, so without the lock both would read nine and
    succeed."""
    owners = _owners(db_session)
    _fill(db_session, owners, 9)
    factory = sessionmaker(db_engine, expire_on_commit=False)
    first_created, second_started = threading.Event(), threading.Event()
    results: dict[str, object] = {}

    def first() -> None:
        with factory() as db:
            try:
                threads_mod.create_thread(db, owners[0], _spec(), NOW)
                first_created.set()
                second_started.wait(5)
                threading.Event().wait(0.5)  # the second is now blocked on the lock (or, without it, already inserted)
                db.commit()
                results["first"] = "created"
            except ReplayProblem as exc:
                db.rollback()
                results["first"] = exc.message

    def second() -> None:
        with factory() as db:
            first_created.wait(5)
            second_started.set()
            try:
                threads_mod.create_thread(db, owners[1], _spec(), NOW)
                db.commit()
                results["second"] = "created"
            except ReplayProblem as exc:
                db.rollback()
                results["second"] = exc.message

    workers = [threading.Thread(target=first), threading.Thread(target=second)]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join(15)
    assert sorted(map(str, results.values())) == sorted(["created", FULL]), results
    db_session.rollback()
    assert threads_mod.capacity(db_session)["day_active"] == 10


# -- 49 names ---------------------------------------------------------------------------------------------------------


def test_a_new_plan_above_49_names_is_refused_and_a_stored_one_that_says_50_still_loads(
    db_session, user_id, svc
) -> None:
    assert plan_mod.MAX_LIST == 49
    make_thread(db_session, user_id)
    for too_many in (50,):  # the contract still allows 50: the server refuses it for a NEW plan
        block = _block(db_session, user_id, screen={"maxList": too_many})
        with pytest.raises(ReplayProblem) as caught:
            plan_mod.create_plan(db_session, user_id, block, svc, threads_mod.active_thread(db_session, user_id))
        assert (caught.value.path, caught.value.message) == ("screen.maxList", "A day list holds at most 49 names")
        db_session.rollback()
    plan = _plan(db_session, user_id, svc, screen={"maxList": 49})  # 49 is accepted
    assert plan.spec["screen"]["maxList"] == 49
    plan.spec = {**plan.spec, "screen": {**plan.spec["screen"], "maxList": 50}}  # a plan stored before the rule
    db_session.commit()
    plan_mod.run_prep(db_session, svc, plan.id)
    row = plan_mod.open_next(db_session, user_id, svc).day_list
    assert row is not None and row.screen["maxList"] == 49  # loads, and the list is built for at most 49


def test_the_rescan_makes_room_for_the_names_she_holds(db_session) -> None:
    ranked = [{"symbol": f"S{i}", "rank": i} for i in range(1, 50)]  # a full 49-name scan
    fitted = plan_mod._fit_list(ranked, holding={"S49", "S3"}, held=2)  # two held names it no longer matches
    assert len(fitted) + 2 == 49 and {"S49", "S3"} <= {c["symbol"] for c in fitted}  # never drops a held match
    assert [c["rank"] for c in fitted] == list(range(1, len(fitted) + 1))  # numbered again
    assert plan_mod._fit_list(ranked[:40], holding=set(), held=2) == ranked[:40]  # room enough: untouched


def test_a_day_never_opens_more_than_the_list_holds(db_session, user_id, svc, monkeypatch) -> None:
    make_thread(db_session, user_id)
    row, _ = _names(db_session, user_id, svc, "FLAT", "SPLITTER")  # GAPPER open; three names listed
    monkeypatch.setattr(plan_mod, "MAX_LIST", 2)  # after the plan: a new plan above the cap is refused too
    plan_mod.start_session(db_session, user_id, row.id, "FLAT", svc)  # the second name opens
    with pytest.raises(ReplayProblem) as caught:
        plan_mod.start_session(db_session, user_id, row.id, "SPLITTER", svc)  # a third would be over the cap
    assert (caught.value.status, caught.value.path) == (409, "symbol")
    assert plan_mod.start_session(db_session, user_id, row.id, "FLAT", svc).symbol == "FLAT"  # a name in hand resumes
