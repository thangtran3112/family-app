"""`scripts/reconcile_swing_to_freestyle.py` (ADR-0025 step 5): a swing thread with open holds, on a database at head
(`0022`, the swing tables still there), is converted in place. The invariant is the plan's (section 6.1): the balance is
identical and the freestyle book holds exactly the positions the swing book did. Each test seeds its own world and runs
the script in process, with a price function in place of the market.

The world: Mon 2026-10-19 and Tue 10-20 ended, Wed 10-21 open (an EDT week: 16:00 ET is 20:00 UTC). AAPL is a long of
200 shares at 75.00 (100 at 150.00 before a 2-for-1 split, restated), MSFT a short of 50 at 410.00, NVDA a closed hold
that was credited to the ledger (+150.00)."""

import importlib.util
import sys
from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session, sessionmaker

from ai_trading.contracts.practice_setup import PracticeSetupV2
from ai_trading.db.models import (
    FilterStrategy,
    FilterStrategyVersion,
    PracticeHold,
    PracticeLedger,
    PracticeMark,
    PracticePlan,
    PracticeThread,
    PracticeWeek,
    ReplayDayList,
    ReplaySession,
    User,
)
from ai_trading.replay import session as session_mod
from ai_trading.replay import threads as threads_mod

_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "reconcile_swing_to_freestyle.py"
_spec = importlib.util.spec_from_file_location("reconcile_swing_to_freestyle", _SCRIPT)
assert _spec is not None and _spec.loader is not None
recon = importlib.util.module_from_spec(_spec)
sys.modules["reconcile_swing_to_freestyle"] = recon
_spec.loader.exec_module(recon)

NOW = datetime(2026, 10, 21, 15, 0, tzinfo=UTC)
MON, TUE, WED = date(2026, 10, 19), date(2026, 10, 20), date(2026, 10, 21)
TUE_CLOSE = datetime(2026, 10, 20, 20, 0, tzinfo=UTC)
MON_OPEN = datetime(2026, 10, 19, 13, 30, tzinfo=UTC)
UNIVERSE = ["AAPL", "MSFT", "NVDA", "AMD", "TSLA", "META", "GOOG", "AMZN", "NFLX", "INTC"]
PRICES = {"AAPL": 77.02, "MSFT": 404.9}  # against the swing valuation: AAPL +4.00 and the MSFT short +5.00
SPLIT = {"day": "2026-10-20", "ratio": 2.0, "shares_before": 100, "shares_after": 200}


@pytest.fixture
def factory(db_engine, db_session) -> sessionmaker[Session]:  # db_session: the truncated database
    return sessionmaker(db_engine, expire_on_commit=False)


def _hold(db: Session, thread: PracticeThread, symbol: str, **kw) -> PracticeHold:
    fields = {
        "thread_id": thread.id,
        "owner_user_id": thread.owner_user_id,
        "symbol": symbol,
        "side": "long",
        "shares": 100,
        "entry_day": MON,
        "entry_at": datetime(2026, 10, 19, 14, 0, tzinfo=UTC),
        "entry_price": Decimal("100"),
        "status": "open",
        "splits": [],
        "created_at": NOW,
        "updated_at": NOW,
        **kw,
    }
    row = PracticeHold(**fields)
    db.add(row)
    db.flush()
    return row


def _session(db: Session, thread: PracticeThread, symbol: str, day: date, status: str, **kw) -> ReplaySession:
    row = ReplaySession(
        owner_user_id=thread.owner_user_id,
        symbol=symbol,
        day=day,
        attempt=1,
        schema_version=1,
        spec={},
        armed=[],
        signals=[],
        window_start=NOW,
        window_end=NOW,
        revealed_through=NOW,
        tape_feed="off",
        status=status,
        created_at=NOW,
        updated_at=NOW,
        thread_id=thread.id,
        **kw,
    )
    db.add(row)
    db.flush()
    return row


def seed(db: Session, *, status: str = "active", with_filter: bool = True) -> SimpleNamespace:
    owner = User(email="swing@example.test")
    db.add(owner)
    db.flush()
    filter_id = None
    if with_filter:
        flt = FilterStrategy(owner_user_id=owner.id, name="Gap up", origin="user", created_at=NOW)
        db.add(flt)
        db.flush()
        version = FilterStrategyVersion(
            filter_strategy_id=flt.id, version=1, schema_version=1, spec={}, created_by=owner.id, created_at=NOW
        )
        db.add(version)
        db.flush()
        flt.current_version_id = version.id
        filter_id = flt.id
    thread = PracticeThread(
        owner_user_id=owner.id,
        mode="swing",
        name="Swing thread · Oct 19",
        starting_balance=Decimal("50000"),
        stop_note_on_entry="yes",
        trade_only_on_signal="no",
        max_loss_usd=500,
        status=status,
        created_at=NOW,
        updated_at=NOW,
        closed_at=NOW if status == "closed" else None,
    )
    db.add(thread)
    db.flush()
    plan = PracticePlan(
        owner_user_id=owner.id,
        thread_id=thread.id,
        schema_version=1,
        spec={
            "mode": "swing",
            "firstDay": MON.isoformat(),
            "sessions": 15,
            "interval": "15m",
            "tape": "off",
            "hideDates": "no",
            "armed": [] if filter_id is None else [{"id": filter_id, "source": "filter"}],
            "universe": [{"source": "manual", "symbol": s} for s in UNIVERSE],
        },
        first_day=MON,
        universe={
            "source": "swing",
            "symbols": [{"source": "manual", "symbol": s} for s in UNIVERSE],
            "basis_day": "2026-10-16",
            "frozen_at": NOW.isoformat(),
        },
        prep={"state": "done"},
        status="active",
        created_at=NOW,
        updated_at=NOW,
    )
    db.add(plan)
    db.flush()
    days = {}
    for no, (day, state, through) in enumerate(
        [
            (MON, "ended", datetime(2026, 10, 19, 20, 0, tzinfo=UTC)),
            (TUE, "ended", TUE_CLOSE),
            (WED, "practicing", NOW),
        ],
        start=1,
    ):
        days[day] = ReplayDayList(
            plan_id=plan.id,
            owner_user_id=owner.id,
            day=day,
            day_no=no,
            screen={},
            list_at=NOW,
            data_through=NOW,
            universe={},
            columns=[],
            candidates=[],
            watch=[],
            status=state,
            revealed_through=through,
            created_at=NOW,
            updated_at=NOW,
        )
        db.add(days[day])
    db.flush()
    aapl = _hold(
        db,
        thread,
        "AAPL",
        shares=200,
        entry_price=Decimal("75"),
        stop_at_entry=Decimal("73"),
        stop_price=Decimal("74"),
        last_close=Decimal("77"),
        last_close_day=TUE,
        splits=[SPLIT],
    )
    msft = _hold(
        db,
        thread,
        "MSFT",
        side="short",
        shares=50,
        entry_price=Decimal("410"),
        stop_price=Decimal("420"),
        last_close=Decimal("405"),
        last_close_day=TUE,
    )
    nvda = _hold(
        db,
        thread,
        "NVDA",
        status="closed",
        exit_day=TUE,
        exit_at=TUE_CLOSE,
        exit_price=Decimal("101.5"),
        exit_source="her",
    )
    db.add(
        PracticeLedger(
            thread_id=thread.id,
            hold_id=nvda.id,
            day=TUE,
            symbol="NVDA",
            side="long",
            shares=100,
            entry_price=Decimal("100"),
            exit_price=Decimal("101.5"),
            pnl_usd=Decimal("150.00"),
            realized_at=TUE_CLOSE,
            created_at=NOW,
        )
    )
    db.add(
        PracticeWeek(
            thread_id=thread.id,
            owner_user_id=owner.id,
            week_no=1,
            first_day=MON,
            last_day=date(2026, 10, 23),
            status="open",
            created_at=NOW,
        )
    )
    # The swing sessions: Tuesday's ended one holds the AAPL entry mark that would read as a second open position, and
    # Wednesday's is the open day's active one (it would collide with the AAPL lane).
    old = _session(db, thread, "AAPL", TUE, "ended", day_list_id=days[TUE].id)
    db.add(
        PracticeMark(
            session_id=old.id,
            seq=1,
            kind="long_entry",
            at=datetime(2026, 10, 19, 14, 0, tzinfo=UTC),
            price=Decimal("150"),
            shares=100,
            trade_no=aapl.id,
            source="her",
            created_at=NOW,
        )
    )
    _session(db, thread, "AAPL", WED, "active", day_list_id=days[WED].id)
    db.commit()
    return SimpleNamespace(owner=owner.id, thread=thread.id, plan=plan.id, aapl=aapl.id, msft=msft.id, nvda=nvda.id)


def world(factory, **kw) -> SimpleNamespace:
    with factory() as db:
        return seed(db, **kw)


def price_of(prices: dict[str, float]):
    return lambda db, symbol, at: prices.get(symbol)


def go(factory, prices=PRICES, **kw) -> tuple[int, str]:
    lines: list[str] = []
    code = recon.run(factory, price_of(prices), out=lines.append, **kw)
    return code, "\n".join(lines)


def snapshot(factory, w) -> dict:
    """Everything the script must not touch, and the balance."""
    with factory() as db:
        thread = db.get(PracticeThread, w.thread)
        return {
            "balance": threads_mod.balance(db, thread),
            "holds": db.execute(
                select(PracticeHold.id, PracticeHold.status, PracticeHold.shares, PracticeHold.entry_price)
                .where(PracticeHold.thread_id == w.thread)
                .order_by(PracticeHold.id)
            ).all(),
            "ledger": db.execute(select(PracticeLedger.id, PracticeLedger.pnl_usd).order_by(PracticeLedger.id)).all(),
            "weeks": db.execute(select(func.count()).select_from(PracticeWeek)).scalar_one(),
        }


# -- the dry run -------------------------------------------------------------------------------------------------------


def test_dry_run_reports_each_hold_and_writes_nothing(factory):
    w = world(factory)
    before = snapshot(factory, w)
    code, out = go(factory)

    assert code == 0
    assert "T = 2026-10-20 16:00 ET" in out and "start 2026-10-19 09:30 ET" in out
    assert f"#{w.aapl} AAPL" in out and "long" in out and "+4.00" in out
    assert f"#{w.msft} MSFT" in out and "short" in out and "+5.00" in out
    assert "total over 2 hold(s): +9.00 USD net, 9.00 USD absolute" in out
    assert "DRY RUN" in out
    with factory() as db:
        assert db.get(PracticeThread, w.thread).mode == "swing"
        assert db.get(PracticeThread, w.thread).clock_at is None
        assert db.execute(select(func.count()).select_from(PracticeMark)).scalar_one() == 1  # the legacy mark only
        assert db.execute(select(func.count()).select_from(ReplaySession)).scalar_one() == 2
        assert db.get(PracticePlan, w.plan).status == "active"
    assert snapshot(factory, w) == before


# -- --apply ---------------------------------------------------------------------------------------------------------


def test_apply_turns_each_open_hold_into_a_lane_with_one_entry_mark_at_the_restated_price(factory):
    w = world(factory)
    before = snapshot(factory, w)
    code, out = go(factory, apply=True)
    assert code == 0 and f"thread {w.thread} · converted" in out

    with factory() as db:
        thread = db.get(PracticeThread, w.thread)
        assert thread.mode == "freestyle"
        assert thread.clock_at == TUE_CLOSE and thread.start_at == MON_OPEN
        assert (thread.clock_running, thread.clock_anchor_at, thread.clock_pause, thread.clock_speed) == (
            False,
            None,
            None,
            1,
        )
        assert (thread.max_loss_usd, thread.stop_note_on_entry, thread.starting_balance) == (
            500,
            "yes",
            Decimal("50000"),
        )

        lanes = session_mod.lanes(db, thread.id, active=True)
        assert [(r.symbol, r.status, r.revealed_through, r.signals, r.armed) for r in lanes] == [
            ("AAPL", "active", TUE_CLOSE, [], []),
            ("MSFT", "active", TUE_CLOSE, [], []),
        ]
        assert lanes[0].attempt == 2  # Tuesday's ended AAPL row is attempt 1
        marks = {
            lane.symbol: db.execute(select(PracticeMark).where(PracticeMark.session_id == lane.id)).scalars().all()
            for lane in lanes
        }
        assert [len(m) for m in marks.values()] == [1, 1]
        aapl, msft = marks["AAPL"][0], marks["MSFT"][0]
        assert (aapl.kind, aapl.at, aapl.price, aapl.shares, aapl.stop_price, aapl.source) == (
            "long_entry",
            TUE_CLOSE,
            Decimal("75"),
            200,
            Decimal("74"),
            "her",
        )
        assert aapl.note == f"Carried over from swing hold #{w.aapl} (entered 2026-10-19)"
        assert aapl.position_before == {
            "migrated": {
                "entry_at": "2026-10-19T14:00:00+00:00",
                "entry_day_no": 1,
                "splits": [SPLIT],
                "stop_at_entry": 73.0,
            }
        }
        assert (msft.kind, msft.price, msft.shares, msft.stop_price) == (
            "short_entry",
            Decimal("410"),
            50,
            Decimal("420"),
        )

        # The freestyle book reads exactly the two swing positions: the old sessions' entry marks are not a second one.
        book = [
            (lane.symbol, trade.side, trade.shares, trade.entry_price)
            for lane, trade in session_mod.open_positions(db, thread.id)
        ]
        assert book == [("AAPL", "long", 200, 75.0), ("MSFT", "short", 50, 410.0)]
        assert (
            db.execute(
                select(func.count())
                .select_from(ReplaySession)
                .where(ReplaySession.status == "active", ReplaySession.thread_id.is_(None))
            ).scalar_one()
            == 0
        )

        old, new = db.execute(
            select(PracticePlan).where(PracticePlan.thread_id == thread.id).order_by(PracticePlan.id)
        ).scalars()
        assert (old.id, old.status) == (w.plan, "archived")
        assert (new.status, new.schema_version, new.first_day) == ("active", 2, TUE)
        assert new.universe["symbols"] == UNIVERSE
        parsed = PracticeSetupV2.model_validate(new.spec)
        assert parsed.startAt == "2026-10-20T20:00:00Z"
        assert [f.id for f in parsed.screen.filters] == [db.execute(select(FilterStrategy.id)).scalar_one()]
        assert (parsed.screen.maxList, parsed.setup.interval, parsed.setup.session) == (20, "15m", "regular")

    assert snapshot(factory, w) == before  # balance, every hold row (open ones too), the ledger and the weeks


def test_apply_twice_changes_nothing_the_second_time(factory):
    w = world(factory)
    assert go(factory, apply=True)[0] == 0
    with factory() as db:
        counts = [
            db.execute(select(func.count()).select_from(t)).scalar_one()
            for t in (ReplaySession, PracticeMark, PracticePlan)
        ]

    code, out = go(factory, apply=True)
    assert code == 0 and "converted" not in out
    code, out = go(factory, apply=True, thread_id=w.thread)  # named: it says so
    assert code == 0 and "already freestyle, skipped" in out
    with factory() as db:
        assert counts == [
            db.execute(select(func.count()).select_from(t)).scalar_one()
            for t in (ReplaySession, PracticeMark, PracticePlan)
        ]


# -- the drift guard ---------------------------------------------------------------------------------------------------


def test_apply_is_refused_above_the_tolerance_unless_the_drift_is_accepted(factory):
    w = world(factory)
    far = {"AAPL": 90.0, "MSFT": 404.9}  # AAPL +13.00 a share x 200

    code, out = go(factory, far, apply=True)
    assert code == 3 and "REFUSED" in out and "+2600.00" in out
    with factory() as db:
        assert db.get(PracticeThread, w.thread).mode == "swing"  # nothing written
        assert db.execute(select(func.count()).select_from(ReplaySession)).scalar_one() == 2

    code, out = go(factory, far, apply=True, accept_drift=True)
    assert code == 0 and "converted" in out
    with factory() as db:
        assert db.get(PracticeThread, w.thread).mode == "freestyle"


def test_a_name_with_no_price_is_carried_at_entry_and_said_so(factory):
    world(factory)
    code, out = go(factory, {"MSFT": 404.9})
    assert code == 0 and "no price at T, carried at entry" in out
    assert "-400.00" in out  # AAPL: valued 77.00 by the swing book, 75.00 (its cost) x 200 shares here


# -- the edges ---------------------------------------------------------------------------------------------------------


def test_a_hold_bought_on_the_open_day_is_anchored_at_its_entry_and_time_stops_there(factory):
    w = world(factory)
    bought = datetime(2026, 10, 21, 14, 0, tzinfo=UTC)  # Wed 10:00 ET, the day has not ended
    with factory() as db:
        row = _hold(
            db, db.get(PracticeThread, w.thread), "AMD", entry_day=WED, entry_at=bought, entry_price=Decimal("120")
        )
        db.commit()
        amd = row.id
    assert go(factory, {**PRICES, "AMD": 121.5}, apply=True, accept_drift=True)[0] == 0
    with factory() as db:
        assert db.get(PracticeThread, w.thread).clock_at == bought
        lane = next(r for r in session_mod.lanes(db, w.thread, active=True) if r.symbol == "AMD")
        mark = db.execute(select(PracticeMark).where(PracticeMark.session_id == lane.id)).scalar_one()
        assert (mark.at, mark.price, lane.revealed_through, lane.day) == (bought, Decimal("120"), bought, WED)
        assert db.get(PracticeHold, amd).status == "open"
        carried = db.execute(
            select(PracticeMark.at)
            .join(ReplaySession)
            .where(ReplaySession.symbol == "AAPL", ReplaySession.status == "active")
        ).scalar_one()
        assert carried == TUE_CLOSE  # the carried holds keep the last close


def test_a_closed_hold_that_never_reached_the_ledger_blocks_the_thread(factory):
    w = world(factory)
    with factory() as db:
        _hold(
            db,
            db.get(PracticeThread, w.thread),
            "AMD",
            status="closed",
            exit_day=WED,
            exit_at=NOW,
            exit_price=Decimal("99"),
            exit_source="her",
        )
        db.commit()
    code, out = go(factory, apply=True)
    assert code == 1 and "BLOCKED" in out and "has no ledger row" in out
    with factory() as db:
        assert db.get(PracticeThread, w.thread).mode == "swing"
        assert db.execute(select(func.count()).select_from(PracticePlan)).scalar_one() == 1


def test_a_thread_without_a_filter_to_screen_with_is_blocked(factory):
    w = world(factory, with_filter=False)
    code, out = go(factory, apply=True)
    assert code == 1 and "no live screener filter" in out
    with factory() as db:
        assert db.get(PracticeThread, w.thread).mode == "swing"


def test_a_closed_thread_only_changes_its_mode(factory):
    w = world(factory, status="closed")
    code, out = go(factory, apply=True)
    assert code == 0 and "nothing else" in out
    with factory() as db:
        thread = db.get(PracticeThread, w.thread)
        assert (thread.mode, thread.status, thread.clock_at) == ("freestyle", "closed", None)
        assert db.get(PracticePlan, w.plan).status == "active"
        assert db.execute(select(func.count()).select_from(ReplaySession)).scalar_one() == 2


def test_a_thread_without_open_holds_still_gets_a_clock_and_a_plan(factory):
    w = world(factory)
    with factory() as db:
        db.execute(delete(PracticeHold).where(PracticeHold.status == "open"))
        db.commit()
    code, out = go(factory, apply=True)
    assert code == 0 and "0 open hold(s)" in out
    with factory() as db:
        thread = db.get(PracticeThread, w.thread)
        assert (thread.mode, thread.clock_at, thread.start_at) == ("freestyle", TUE_CLOSE, MON_OPEN)
        assert session_mod.lanes(db, thread.id, active=True) == []
        assert db.execute(
            select(PracticePlan.status).where(PracticePlan.thread_id == thread.id).order_by(PracticePlan.id)
        ).scalars().all() == ["archived", "active"]
