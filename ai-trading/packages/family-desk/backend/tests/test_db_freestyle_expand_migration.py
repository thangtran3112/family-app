"""0021 (ADR-0025 step 2): the freestyle expand migration and its data step (plan §5.1, §6.1). Runs on its own database,
migrated to 0020 first so there are day threads to move.

The point of the data step is that nothing changes for the person using a thread: `test_..._balance_and_equity_...`
reads every thread's balance and its equity at `clock_at` through the OLD structure (the open day list's active
sessions) before the migration and through the NEW one (the thread's lanes) after it, and both must be the same
figures, to the cent. Nothing reads the new columns yet, so these tests read them directly."""

import json
import os
import uuid
from collections.abc import Iterator
from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

import pandas as pd
import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.exc import IntegrityError

from ai_trading.api.schemas.replay import OrderOut
from ai_trading.replay import journal as journal_mod
from ai_trading.replay.model import Mark

_ALEMBIC_INI = Path(__file__).resolve().parents[1] / "alembic.ini"

NOW = datetime(2026, 10, 20, 15, 12, tzinfo=UTC)
MON, TUE = date(2026, 10, 19), date(2026, 10, 20)  # an EDT week: 09:30 ET is 13:30 UTC
WINTER = date(2026, 11, 3)  # EST: 20:00 ET is 01:00 UTC the next day
PRICES = {"AAPL": 153.25, "MSFT": 410.0, "NVDA": 120.0}  # the one `quote` both sides of the invariant price with


def spec(window_from: str = "10:00") -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "firstDay": "2026-10-19",
        "sessions": 5,
        "hideDates": "no",
        "screen": {"filters": [{"id": 1}], "listAt": "09:00", "maxList": 20},
        "setup": {
            "window": {"from": window_from, "to": "15:00"},
            "session": "regular",
            "interval": "5m",
            "armed": [],
        },
    }


@pytest.fixture
def at_0020() -> Iterator[tuple[Engine, Config]]:
    server_url = os.environ.get("DESK_TEST_DATABASE_URL")
    if not server_url:
        if os.environ.get("DESK_REQUIRE_DB") == "1":
            pytest.fail("DESK_TEST_DATABASE_URL is unset and DESK_REQUIRE_DB=1")
        pytest.skip("DESK_TEST_DATABASE_URL is not set")
    name = f"desk_test_{uuid.uuid4().hex[:12]}"
    admin = create_engine(server_url, isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.execute(text(f'CREATE DATABASE "{name}"'))
    url = make_url(server_url).set(database=name).render_as_string(hide_password=False)
    config = Config(str(_ALEMBIC_INI))
    config.set_main_option("sqlalchemy.url", url)
    command.upgrade(config, "0020")
    engine = create_engine(url)
    try:
        yield engine, config
    finally:
        engine.dispose()
        with admin.connect() as conn:
            conn.execute(text(f'DROP DATABASE "{name}" WITH (FORCE)'))
        admin.dispose()


# -- seeding (the schema of 0020: a day list per day, a session per name per day) ---------------------------


def _user(conn, email: str) -> int:
    return conn.execute(text("INSERT INTO users (email) VALUES (:e) RETURNING id"), {"e": email}).scalar_one()


def _thread(conn, owner: int, mode: str = "day", status: str = "active", name: str = "Thread") -> int:
    return conn.execute(
        text(
            "INSERT INTO practice_threads (owner_user_id, mode, name, starting_balance, stop_note_on_entry, "
            "trade_only_on_signal, status, created_at, updated_at, closed_at) VALUES (:o, :m, :n, 50000, 'yes', 'no', "
            "CAST(:s AS text), :t, :t, CASE WHEN CAST(:s AS text) = 'closed' THEN CAST(:t AS timestamptz) END) "
            "RETURNING id"
        ),
        {"o": owner, "m": mode, "n": name, "s": status, "t": NOW},
    ).scalar_one()


def _plan(conn, owner: int, thread: int, window_from: str = "10:00", status: str = "active") -> int:
    return conn.execute(
        text(
            "INSERT INTO practice_plans (owner_user_id, thread_id, schema_version, spec, first_day, universe, prep, "
            "status, created_at, updated_at) VALUES (:o, :th, 1, CAST(:spec AS jsonb), :d, CAST('{}' AS jsonb), "
            "CAST('{}' AS jsonb), :s, :t, :t) RETURNING id"
        ),
        {"o": owner, "th": thread, "spec": json.dumps(spec(window_from)), "d": MON, "s": status, "t": NOW},
    ).scalar_one()


def _day(
    conn,
    plan: int,
    owner: int,
    day: date,
    no: int,
    status: str,
    through: datetime | None,
    *,
    running: bool = False,
    speed: int = 1,
) -> int:
    return conn.execute(
        text(
            "INSERT INTO replay_day_lists (plan_id, owner_user_id, day, day_no, screen, list_at, data_through, "
            "universe, columns, candidates, watch, status, revealed_through, clock_running, clock_speed, "
            "clock_anchor_at, created_at, updated_at) VALUES (:p, :o, :d, :n, CAST('{}' AS jsonb), :t, :t, "
            "CAST('{}' AS jsonb), CAST('[]' AS jsonb), CAST('[]' AS jsonb), CAST('[]' AS jsonb), :s, :rt, :run, :sp, "
            "CASE WHEN :run THEN :t END, :t, :t) RETURNING id"
        ),
        {"p": plan, "o": owner, "d": day, "n": no, "s": status, "rt": through, "run": running, "sp": speed, "t": NOW},
    ).scalar_one()


def _session(
    conn,
    owner: int,
    symbol: str,
    day: date,
    *,
    thread: int | None = None,
    day_list: int | None = None,
    status: str = "active",
    attempt: int = 1,
    orders: list[dict[str, Any]] | None = None,
) -> int:
    return conn.execute(
        text(
            "INSERT INTO replay_sessions (owner_user_id, symbol, day, attempt, schema_version, spec, armed, signals, "
            "window_start, window_end, revealed_through, tape_feed, status, created_at, updated_at, day_list_id, "
            "thread_id, orders) VALUES (:o, :s, :d, :at, 1, CAST('{}' AS jsonb), CAST('[]' AS jsonb), "
            "CAST('[]' AS jsonb), :t, :t, :t, 'sip', :st, :t, :t, :l, :th, CAST(:orders AS jsonb)) RETURNING id"
        ),
        {
            "o": owner,
            "s": symbol,
            "d": day,
            "st": status,
            "at": attempt,
            "l": day_list,
            "th": thread,
            "t": NOW,
            "orders": json.dumps(orders or []),
        },
    ).scalar_one()


def _mark(conn, session: int, seq: int, kind: str, minute: int, price: float, shares: int | None = None) -> int:
    return conn.execute(
        text(
            "INSERT INTO practice_marks (session_id, seq, kind, at, price, shares, source, created_at) VALUES "
            "(:s, :q, :k, :at, :p, :n, 'her', :t) RETURNING id"
        ),
        {
            "s": session,
            "q": seq,
            "k": kind,
            "at": datetime(2026, 10, 20, 14, minute, tzinfo=UTC),
            "p": price,
            "n": shares,
            "t": NOW,
        },
    ).scalar_one()


def _ledger(
    conn, thread: int, session: int, mark: int, day: date, symbol: str, shares: int, entry: float, exit_: float
):
    pnl = (Decimal(str(exit_)) - Decimal(str(entry))) * shares
    conn.execute(
        text(
            "INSERT INTO practice_ledger (thread_id, session_id, mark_id, day, symbol, side, shares, entry_price, "
            "exit_price, pnl_usd, realized_at, created_at) VALUES (:th, :s, :m, :d, :sym, 'long', :n, :e, :x, :pnl, "
            ":t, :t)"
        ),
        {
            "th": thread,
            "s": session,
            "m": mark,
            "d": day,
            "sym": symbol,
            "n": shares,
            "e": entry,
            "x": exit_,
            "pnl": pnl,
            "t": NOW,
        },
    )


def _order(order_id: int, **fields: Any) -> dict[str, Any]:
    base = {
        "id": order_id,
        "side": "sell",
        "type": "stop",
        "shares": 100,
        "limit_price": None,
        "stop_price": 145.0,
        "status": "working",
        "placed_at": "2026-10-20T14:00:00+00:00",
        "triggered_at": None,
        "closed_at": None,
        "fill_price": None,
        "mark_id": None,
        "reason": None,
    }
    return {**base, **fields}


WORKING = _order(1)
CANCELLED = _order(
    2, side="buy", type="limit", shares=50, limit_price=140.0, stop_price=None, status="cancelled",
    closed_at="2026-10-20T14:30:00+00:00", reason="Cancelled by you",
)  # fmt: skip
ORDERS = [WORKING, CANCELLED]


def _seed(conn) -> dict[str, int]:
    """Six threads: A has an open day with three names (a long carried with a working stop, a short, a flat one) after
    an ended first day with its own realized trade, and a clock running at 2x; B has only an ended day and runs at 10x;
    C has a day that was listed and never started; D is closed; E is a swing thread; F is another owner's running
    day."""
    owner, other = _user(conn, "owner@example.com"), _user(conn, "spouse@example.com")
    ids: dict[str, int] = {"owner": owner, "other": other}

    a = ids["a"] = _thread(conn, owner, name="A")
    plan = _plan(conn, owner, a)
    d1 = ids["a_d1"] = _day(conn, plan, owner, MON, 1, "ended", datetime(2026, 10, 20, 13, 30, tzinfo=UTC), speed=5)
    d2 = ids["a_d2"] = _day(conn, plan, owner, TUE, 2, "practicing", NOW, running=True, speed=2)
    mon_aapl = _session(conn, owner, "AAPL", MON, thread=a, day_list=d1, status="ended")
    _mark(conn, mon_aapl, 1, "long_entry", 0, 150.0, 100)
    exit_mark = _mark(conn, mon_aapl, 2, "long_exit", 5, 151.23)
    _ledger(conn, a, mon_aapl, exit_mark, MON, "AAPL", 100, 150.0, 151.23)  # +123.00
    aapl = ids["a_aapl"] = _session(conn, owner, "AAPL", TUE, thread=a, day_list=d2, orders=ORDERS)
    _mark(conn, aapl, 1, "long_entry", 1, 150.0, 100)  # carried: 100 @ 150, marked at 153.25 = +325.00
    nvda = ids["a_nvda"] = _session(conn, owner, "NVDA", TUE, thread=a, day_list=d2)
    _mark(conn, nvda, 1, "short_entry", 2, 125.0, 40)  # a short: 40 @ 125, marked at 120 = +200.00
    msft = ids["a_msft"] = _session(conn, owner, "MSFT", TUE, thread=a, day_list=d2)
    _mark(conn, msft, 1, "long_entry", 3, 410.0, 10)
    exit_mark = _mark(conn, msft, 2, "long_exit", 8, 402.45)
    _ledger(conn, a, msft, exit_mark, TUE, "MSFT", 10, 410.0, 402.45)  # -75.50, flat afterwards

    b = ids["b"] = _thread(conn, owner, name="B")
    plan = _plan(conn, owner, b, window_from="09:30")
    ids["b_d1"] = _day(conn, plan, owner, MON, 1, "ended", datetime(2026, 10, 20, 13, 30, tzinfo=UTC), speed=10)

    c = ids["c"] = _thread(conn, owner, name="C")
    plan = _plan(conn, owner, c, window_from="09:45")
    ids["c_d1"] = _day(conn, plan, owner, MON, 1, "listed", None)

    d = ids["d"] = _thread(conn, owner, status="closed", name="D")
    plan = _plan(conn, owner, d, status="archived")
    ids["d_d1"] = _day(conn, plan, owner, MON, 1, "ended", datetime(2026, 10, 19, 21, 0, tzinfo=UTC), speed=2)

    e = ids["e"] = _thread(conn, owner, mode="swing", name="E")
    plan = _plan(conn, owner, e)
    ids["e_d1"] = _day(conn, plan, owner, MON, 1, "practicing", None)

    f = ids["f"] = _thread(conn, other, name="F")
    plan = _plan(conn, other, f)
    f_day = ids["f_d1"] = _day(conn, plan, other, TUE, 1, "practicing", NOW, running=True, speed=10)
    f_aapl = ids["f_aapl"] = _session(conn, other, "AAPL", TUE, thread=f, day_list=f_day)  # same name, same day as A's
    _mark(conn, f_aapl, 1, "short_entry", 1, 155.0, 20)  # 20 short @ 155, marked at 153.25 = +35.00
    return ids


# -- the two readings of "what she holds" -----------------------------------------------------------------------


def _open_trades(conn, session_ids: list[tuple[int, str]]) -> list[tuple[str, Any]]:
    out = []
    for session_id, symbol in session_ids:
        rows = conn.execute(
            text("SELECT id, seq, kind, at, price, shares FROM practice_marks WHERE session_id = :s ORDER BY seq"),
            {"s": session_id},
        ).all()
        marks = [
            Mark(id=i, seq=q, kind=k, at=pd.Timestamp(at), price=None if p is None else float(p), shares=n)
            for i, q, k, at, p, n in rows
        ]
        _, open_ = journal_mod.assemble(marks)
        if open_ is not None:
            out.append((symbol, open_))
    return out


def _balance(conn, thread: int) -> float:
    start = conn.execute(
        text("SELECT starting_balance FROM practice_threads WHERE id = :t"), {"t": thread}
    ).scalar_one()
    ledger = conn.execute(
        text("SELECT COALESCE(SUM(pnl_usd), 0) FROM practice_ledger WHERE thread_id = :t"), {"t": thread}
    ).scalar_one()
    return float(start + ledger)


def _equity(conn, thread: int, sessions: list[tuple[int, str]]) -> float:
    held = _open_trades(conn, sessions)
    return round(_balance(conn, thread) + sum(trade.unrealized(PRICES[symbol]) for symbol, trade in held), 2)


def _before(conn, thread: int) -> list[tuple[int, str]]:
    """The old structure: the active sessions of the thread's open day list."""
    return [
        (r.id, r.symbol)
        for r in conn.execute(
            text(
                "SELECT s.id, s.symbol FROM replay_sessions s JOIN replay_day_lists d ON d.id = s.day_list_id "
                "JOIN practice_plans p ON p.id = d.plan_id WHERE p.thread_id = :t AND d.status <> 'ended' "
                "AND s.status = 'active' ORDER BY s.id"
            ),
            {"t": thread},
        )
    ]


def _after(conn, thread: int) -> list[tuple[int, str]]:
    """The new structure: the thread's lanes."""
    return [
        (r.id, r.symbol)
        for r in conn.execute(
            text("SELECT id, symbol FROM replay_sessions WHERE thread_id = :t AND status = 'active' ORDER BY id"),
            {"t": thread},
        )
    ]


def _thread_row(conn, thread: int):
    return conn.execute(text("SELECT * FROM practice_threads WHERE id = :t"), {"t": thread}).mappings().one()


def _day_row(conn, day_list: int):
    return conn.execute(text("SELECT * FROM replay_day_lists WHERE id = :d"), {"d": day_list}).mappings().one()


def _et(day: date, hhmm: str) -> datetime:
    return pd.Timestamp(f"{day.isoformat()} {hhmm}", tz="America/New_York").tz_convert("UTC").to_pydatetime()


# -- the data step ------------------------------------------------------------------------------------------------


def test_every_threads_balance_and_equity_at_the_clock_are_the_same_after_the_migration(at_0020) -> None:
    engine, config = at_0020
    with engine.begin() as conn:
        ids = _seed(conn)
    threads = [ids[k] for k in ("a", "b", "c", "d", "e", "f")]
    with engine.begin() as conn:
        before = {t: (_balance(conn, t), _equity(conn, t, _before(conn, t))) for t in threads}
        clock_before = _day_row(conn, ids["a_d2"])["revealed_through"]
    # hand-computed: 50,000 + 123.00 - 75.50 realized; + 325.00 (long AAPL) + 200.00 (short NVDA) unrealized
    assert before[ids["a"]] == (50_047.5, 50_572.5)
    assert before[ids["f"]] == (50_000.0, 50_035.0)

    command.upgrade(config, "0021")

    with engine.begin() as conn:
        after = {t: (_balance(conn, t), _equity(conn, t, _after(conn, t))) for t in threads}
        carried = _open_trades(conn, _after(conn, ids["a"]))
        a = _thread_row(conn, ids["a"])
    assert after == before  # balance and equity at `clock_at`, to the cent, for every thread
    # the open positions carry: same names, sides, shares and average cost
    assert [(s, t.side, t.shares, t.entry_price) for s, t in carried] == [
        ("AAPL", "long", 100, 150.0),
        ("NVDA", "short", 40, 125.0),
    ]
    assert a["clock_at"] == clock_before  # equity is read at the time the day list was at


def test_a_day_threads_clock_is_copied_and_paused_where_it_last_settled(at_0020) -> None:
    engine, config = at_0020
    with engine.begin() as conn:
        ids = _seed(conn)
        d2_before = _day_row(conn, ids["a_d2"])
    assert d2_before["clock_running"] and d2_before["clock_anchor_at"] is not None
    command.upgrade(config, "0021")
    with engine.begin() as conn:
        threads = {k: _thread_row(conn, ids[k]) for k in ("a", "b", "c", "d", "e", "f")}
        d2, f_day = _day_row(conn, ids["a_d2"]), _day_row(conn, ids["f_d1"])
        running = conn.execute(text("SELECT count(*) FROM replay_day_lists WHERE clock_running")).scalar_one()
    # every running clock stopped where it last settled: not advanced, not rewound, no anchor to settle from
    assert running == 0 and d2["clock_anchor_at"] is None and f_day["clock_anchor_at"] is None
    assert d2["revealed_through"] == d2_before["revealed_through"] == NOW
    a, b, c, d, e, f = (threads[k] for k in ("a", "b", "c", "d", "e", "f"))
    # A: the open day's clock and speed; started on the plan's first day at its window start (10:00 ET)
    assert (a["clock_at"], a["clock_speed"], a["start_at"]) == (NOW, 2, _et(MON, "10:00"))
    # B: no open day, so the last ended day's; C: a day that never started, so the plan's first day at 09:45 ET
    assert (b["clock_at"], b["clock_speed"], b["start_at"]) == (_et(TUE, "09:30"), 10, _et(MON, "09:30"))
    assert (c["clock_at"], c["clock_speed"], c["start_at"]) == (_et(MON, "09:45"), 1, _et(MON, "09:45"))
    # D (closed) keeps its last ended day's clock; F belongs to another owner and runs at 10x: paused, same rule
    assert (d["clock_at"], d["clock_speed"], d["status"]) == (datetime(2026, 10, 19, 21, 0, tzinfo=UTC), 2, "closed")
    assert (f["clock_at"], f["clock_speed"], f["start_at"]) == (NOW, 10, _et(MON, "10:00"))
    for thread in (a, b, c, d, f):
        assert thread["start_at"] <= thread["clock_at"]
        assert (thread["clock_running"], thread["clock_anchor_at"], thread["clock_pause"]) == (False, None, None)
    # a swing thread is not a day thread: untouched, and still a swing thread
    assert (e["mode"], e["start_at"], e["clock_at"], e["clock_speed"]) == ("swing", None, None, 1)


def test_the_open_day_list_becomes_the_threads_screen_and_ended_days_stay_history(at_0020) -> None:
    engine, config = at_0020
    with engine.begin() as conn:
        ids = _seed(conn)
    command.upgrade(config, "0021")
    with engine.begin() as conn:
        screens = dict(conn.execute(text("SELECT id, thread_id FROM replay_day_lists")).all())
        lanes = dict(
            conn.execute(text("SELECT id, status FROM replay_sessions WHERE thread_id = :t"), {"t": ids["a"]}).all()
        )
        marks = conn.execute(text("SELECT count(*) FROM practice_marks")).scalar_one()
        ledger = conn.execute(text("SELECT count(*), SUM(pnl_usd) FROM practice_ledger")).one()
    assert screens[ids["a_d2"]] == ids["a"]  # A's open day
    assert screens[ids["c_d1"]] == ids["c"]  # a listed day is an open day too
    assert screens[ids["f_d1"]] == ids["f"]
    assert screens[ids["a_d1"]] is None and screens[ids["b_d1"]] is None  # ended: legacy history
    assert screens[ids["d_d1"]] is None  # closed thread, nothing open
    assert screens[ids["e_d1"]] is None  # a swing day is not a Screen
    assert len(lanes) == 4 and set(lanes.values()) == {
        "active",
        "ended",
    }  # the open day's names plus Monday's ended one
    assert marks == 7 and tuple(ledger) == (2, Decimal("47.50"))  # nothing was written to marks or the ledger


def test_working_orders_get_a_lifetime_and_existing_keys_win(at_0020) -> None:
    engine, config = at_0020
    with engine.begin() as conn:
        ids = _seed(conn)
        owner = ids["owner"]
        winter = _session(conn, owner, "TSLA", WINTER, orders=[_order(1)])  # standalone, an EST day
        done = _order(1, status="filled", fill_price=145.0)
        keyed = _session(conn, owner, "AMD", MON, status="ended", orders=[{**done, "tif": "gtc", "reduce_only": True}])
        empty = ids["a_nvda"]  # no orders at all
    command.upgrade(config, "0021")
    with engine.begin() as conn:
        orders = {
            sid: conn.execute(text("SELECT orders FROM replay_sessions WHERE id = :s"), {"s": sid}).scalar_one()
            for sid in (ids["a_aapl"], winter, keyed, empty)
        }
    first, second = orders[ids["a_aapl"]]
    day_end = "2026-10-21T00:00:00+00:00"  # 20:00 EDT on Oct 20
    assert (first["tif"], first["expires_at"], first["reduce_only"]) == ("day", day_end, False)
    assert (second["tif"], second["expires_at"], second["reduce_only"]) == ("day", day_end, False)  # every status
    assert [
        {k: v for k, v in o.items() if k not in ("tif", "expires_at", "reduce_only")} for o in (first, second)
    ] == ORDERS
    assert orders[winter][0]["expires_at"] == "2026-11-04T01:00:00+00:00"  # 20:00 EST, a standalone session too
    assert (orders[keyed][0]["tif"], orders[keyed][0]["reduce_only"]) == ("gtc", True)  # an existing key is kept
    assert orders[keyed][0]["expires_at"] == "2026-10-20T00:00:00+00:00"  # the one missing key is filled
    assert orders[empty] == []
    for order in (first, second):  # the code that is still live reads these rows: the extra keys are harmless
        OrderOut.model_validate(order)


# -- the schema ----------------------------------------------------------------------------------------------------


def test_no_existing_thread_changes_mode_and_the_mode_check_allows_freestyle(at_0020) -> None:
    """The live code lists, clocks and caps a thread by `mode` ('day') and selects the swing hold model by 'swing', so
    this revision leaves every stored mode alone; the check only learns the new value."""
    engine, config = at_0020
    with engine.begin() as conn:
        ids = _seed(conn)
        modes_before = dict(conn.execute(text("SELECT id, mode FROM practice_threads")).all())
    command.upgrade(config, "0021")
    with engine.begin() as conn:
        modes_after = dict(conn.execute(text("SELECT id, mode FROM practice_threads")).all())
        conn.execute(text("UPDATE practice_threads SET mode = 'freestyle' WHERE id = :t"), {"t": ids["b"]})
    assert modes_after == modes_before and modes_before[ids["e"]] == "swing"
    with pytest.raises(IntegrityError), engine.begin() as conn:
        conn.execute(text("UPDATE practice_threads SET mode = 'weekly' WHERE id = :t"), {"t": ids["b"]})
    with pytest.raises(IntegrityError), engine.begin() as conn:
        conn.execute(text("UPDATE practice_threads SET clock_speed = 3 WHERE id = :t"), {"t": ids["b"]})


def test_a_lane_is_one_active_row_per_thread_and_name_and_the_standalone_rule_is_kept(at_0020) -> None:
    engine, config = at_0020
    with engine.begin() as conn:
        ids = _seed(conn)
        second = _thread(conn, ids["owner"], name="A2")
    with pytest.raises(IntegrityError), engine.begin() as conn:  # before: one active row per owner, name and DAY
        _session(conn, ids["owner"], "AAPL", TUE, thread=second, attempt=2)
    command.upgrade(config, "0021")
    with engine.begin() as conn:  # after: another thread of the same owner may hold the same name on the same day
        _session(conn, ids["owner"], "AAPL", TUE, thread=second, attempt=2)
    with pytest.raises(IntegrityError), engine.begin() as conn:  # but a thread has one lane per name, on any day
        _session(conn, ids["owner"], "AAPL", WINTER, thread=ids["a"])
    with engine.begin() as conn:  # an ended attempt is not a lane
        _session(conn, ids["owner"], "AAPL", WINTER, thread=ids["a"], status="ended")
        _session(conn, ids["owner"], "ZM", WINTER)
    with pytest.raises(IntegrityError), engine.begin() as conn:  # a standalone session keeps its own-day rule
        _session(conn, ids["owner"], "ZM", WINTER, attempt=2)


def test_split_marks_and_one_screen_per_thread(at_0020) -> None:
    engine, config = at_0020
    with engine.begin() as conn:
        ids = _seed(conn)
    command.upgrade(config, "0021")
    with engine.begin() as conn:
        _mark(conn, ids["a_aapl"], 2, "split", 6, 150.0)  # a corporate-action mark is now a valid kind
        conn.execute(
            text("UPDATE replay_day_lists SET thread_id = :t WHERE id = :d"), {"t": ids["b"], "d": ids["b_d1"]}
        )
    with pytest.raises(IntegrityError), engine.begin() as conn:  # a thread has one Screen
        conn.execute(
            text("UPDATE replay_day_lists SET thread_id = :t WHERE id = :d"), {"t": ids["b"], "d": ids["a_d1"]}
        )
    with pytest.raises(IntegrityError), engine.begin() as conn:
        _mark(conn, ids["a_aapl"], 3, "dividend", 7, 150.0)
    with engine.begin() as conn:  # deleting the thread takes its Screen with it (the plan cascade does anyway)
        conn.execute(text("DELETE FROM practice_threads WHERE id = :t"), {"t": ids["c"]})
        assert (
            conn.execute(text("SELECT count(*) FROM replay_day_lists WHERE id = :d"), {"d": ids["c_d1"]}).scalar_one()
            == 0
        )


# -- the way back --------------------------------------------------------------------------------------------------


def _shape(conn) -> dict[str, list[Any]]:
    tables = "('practice_threads', 'replay_sessions', 'practice_marks', 'replay_day_lists')"
    return {
        "columns": [
            tuple(r)
            for r in conn.execute(
                text(
                    "SELECT table_name, column_name, data_type, is_nullable, column_default FROM "
                    f"information_schema.columns WHERE table_name IN {tables} ORDER BY 1, 2"
                )
            )
        ],
        "indexes": [
            tuple(r)
            for r in conn.execute(
                text(f"SELECT tablename, indexname, indexdef FROM pg_indexes WHERE tablename IN {tables} ORDER BY 1, 2")
            )
        ],
        "constraints": [
            tuple(r)
            for r in conn.execute(
                text(
                    "SELECT conrelid::regclass::text, conname, pg_get_constraintdef(oid) FROM pg_constraint "
                    f"WHERE conrelid::regclass::text IN {tables} ORDER BY 1, 2"
                )
            )
        ],
    }


def test_the_migration_reverses_to_the_exact_schema_and_orders_it_found_and_applies_again(at_0020) -> None:
    engine, config = at_0020
    with engine.begin() as conn:
        ids = _seed(conn)
        shape = _shape(conn)
        orders = conn.execute(text("SELECT id, orders FROM replay_sessions ORDER BY id")).all()
    command.upgrade(config, "0021")
    with engine.begin() as conn:
        assert _shape(conn) != shape
    command.downgrade(config, "0020")
    with engine.begin() as conn:
        assert _shape(conn) == shape  # columns, indexes (with their predicates) and checks, as they were
        assert conn.execute(text("SELECT id, orders FROM replay_sessions ORDER BY id")).all() == orders
        assert _balance(conn, ids["a"]) == 50_047.5
    command.upgrade(config, "0021")  # and it applies again over the surviving rows
    with engine.begin() as conn:
        assert _thread_row(conn, ids["a"])["clock_at"] == NOW


def test_downgrade_refuses_rather_than_lose_a_freestyle_thread(at_0020) -> None:
    engine, config = at_0020
    with engine.begin() as conn:
        ids = _seed(conn)
    command.upgrade(config, "0021")
    with engine.begin() as conn:
        conn.execute(text("UPDATE practice_threads SET mode = 'freestyle' WHERE id = :t"), {"t": ids["b"]})
    with pytest.raises(IntegrityError):  # the old mode check cannot hold it: loud, and nothing is half-done
        command.downgrade(config, "0020")
    with engine.begin() as conn:
        assert conn.execute(text("SELECT version_num FROM alembic_version")).scalar_one() == "0021"
        conn.execute(text("UPDATE practice_threads SET mode = 'day' WHERE id = :t"), {"t": ids["b"]})
    command.downgrade(config, "0020")
