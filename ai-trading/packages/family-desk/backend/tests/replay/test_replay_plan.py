"""Daily-list practice end to end on synthetic bars (02o-b v1, `replay/plan.py`): plan validation, prep, opening days
in order, the stars, the day's session on the shared clock, ending the day, and the no-lookahead shape of what the
list serves. Real Postgres (`scripts/test-db.sh`); the history comes from an in-memory source, not the network."""

import json
from dataclasses import replace
from datetime import datetime

import pandas as pd
import pytest
from ai_trading_common.types import ActiveSymbol
from daily_world import DAYS, NOW, SYMBOLS, make_thread
from sqlalchemy import select

from ai_trading.contracts.practice_block import PracticeBlockV1
from ai_trading.core.calendar import et
from ai_trading.data.universe import SEED_SYMBOLS
from ai_trading.db.models import FilterStrategy, PracticePlan, ReplayDayList, User
from ai_trading.replay import plan as plan_mod
from ai_trading.replay import screen
from ai_trading.replay import session as session_mod
from ai_trading.replay import threads as threads_mod
from ai_trading.replay.cache import BlobKey, decode_bars
from ai_trading.replay.session import ReplayProblem, SessionNotFound


def _filter_id(db_session, user_id: int, name: str) -> int:
    return db_session.execute(
        select(FilterStrategy.id).where(FilterStrategy.owner_user_id == user_id, FilterStrategy.name == name)
    ).scalar_one()


def _thread(db_session, user_id: int):
    """The owner's active day thread, made on first use."""
    return threads_mod.active_thread(db_session, user_id) or make_thread(db_session, user_id)


def _block(db_session, user_id: int, **changes) -> PracticeBlockV1:
    spec = {
        "schemaVersion": 1,
        "firstDay": DAYS[0].isoformat(),
        "sessions": 5,
        "hideDates": "yes",
        "screen": {
            "filters": [
                {"id": _filter_id(db_session, user_id, "Gap up")},
                {"id": _filter_id(db_session, user_id, "Gap down")},
            ],
            "listAt": "08:30",
            "maxList": 30,
        },
        "setup": {
            "window": {"from": "09:30", "to": "11:30"},
            "session": "regular",
            "interval": "5m",
            "shares": 100,
            "armed": [],
            "plan": {"stopRequired": "no", "signalOnly": "no"},
        },
    }
    for key, value in changes.items():
        spec[key] = {**spec[key], **value} if isinstance(value, dict) and key in ("screen", "setup") else value
    return PracticeBlockV1.model_validate(spec)


def _plan(db_session, user_id, svc, **changes) -> PracticePlan:
    """A saved plan over just the three synthetic symbols (the real universe would add the seed symbols)."""
    plan = plan_mod.create_plan(
        db_session, user_id, _block(db_session, user_id, **changes), svc, _thread(db_session, user_id)
    )
    plan.universe = {**plan.universe, "symbols": SYMBOLS}
    plan.prep = {**plan.prep, "total": len(SYMBOLS)}
    db_session.commit()
    return plan


def _open(db_session, user_id, svc, *, prepared: bool = True) -> plan_mod.Opened:
    opened = plan_mod.open_next(db_session, user_id, svc)
    db_session.commit()
    return opened


def _ready(db_session, user_id, svc) -> PracticePlan:
    plan = _plan(db_session, user_id, svc)
    plan_mod.run_prep(db_session, svc, plan.id)
    return plan


# -- the plan ---------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("changes", "path", "message"),
    [
        ({"firstDay": "2016-12-30"}, "firstDay", "Daily lists start on Jan 3, 2017 · pick a later day"),
        ({"firstDay": "2026-09-26"}, "firstDay", "No trading on Sat 2026-09-26 · pick a weekday"),
        (
            {"firstDay": "2026-10-20"},
            "firstDay",
            "5 sessions from Tue 2026-10-20 run past the last finished day · pick an earlier start",
        ),
        ({"screen": {"filters": [{"id": 999}]}}, "screen.filters.0.id", "Filter not found"),
    ],
)
def test_create_plan_rejections_are_plain_problems(db_session, user_id, svc, changes, path, message) -> None:
    with pytest.raises(ReplayProblem) as caught:
        plan_mod.create_plan(
            db_session, user_id, _block(db_session, user_id, **changes), svc, _thread(db_session, user_id)
        )
    assert (caught.value.path, caught.value.message) == (path, message)


def test_a_premarket_filter_needs_a_list_time_of_0830_or_later(db_session, user_id, svc) -> None:
    changes = {
        "screen": {"listAt": "08:00"},
        "setup": {"session": "extended", "window": {"from": "08:00", "to": "10:00"}},
    }
    with pytest.raises(ReplayProblem) as caught:
        plan_mod.create_plan(
            db_session, user_id, _block(db_session, user_id, **changes), svc, _thread(db_session, user_id)
        )
    assert caught.value.path == "screen.listAt"
    assert caught.value.message == "Premarket filters need a list time of 8:30 AM or later"


@pytest.mark.parametrize(
    ("name", "list_at", "message"),
    [
        (
            "Abnormal volume",
            "08:30",
            "Abnormal volume needs a list time of 10:00 AM or later"
            " · before then none of its bars of the day has closed",
        ),
        (
            "Above VWAP on volume",
            "09:30",
            "Above VWAP on volume needs a list time of 9:50 AM or later"
            " · before then none of its bars of the day has closed",
        ),
    ],
)
def test_a_cadence_filter_before_its_first_bar_of_the_day_is_a_422_naming_the_list_time(
    db_session, user_id, svc, name, list_at, message
) -> None:
    changes = {"screen": {"filters": [{"id": _filter_id(db_session, user_id, name)}], "listAt": list_at}}
    with pytest.raises(ReplayProblem) as caught:
        plan_mod.create_plan(
            db_session, user_id, _block(db_session, user_id, **changes), svc, _thread(db_session, user_id)
        )
    assert (caught.value.path, caught.value.message, caught.value.status) == ("screen.listAt", message, 422)


def test_a_mixed_plan_is_held_to_its_latest_filter_and_saves_from_that_time(db_session, user_id, svc) -> None:
    filters = [{"id": _filter_id(db_session, user_id, n)} for n in ("Gap up", "Abnormal volume", "High volatility")]
    with pytest.raises(ReplayProblem) as caught:
        plan_mod.create_plan(
            db_session,
            user_id,
            _block(db_session, user_id, screen={"filters": filters}),
            svc,
            _thread(db_session, user_id),
        )
    assert caught.value.message.startswith("Abnormal volume needs a list time of 10:00 AM")
    window = {"window": {"from": "10:00", "to": "12:00"}}
    ok = _block(db_session, user_id, screen={"filters": filters, "listAt": "10:00"}, setup=window)
    assert (
        plan_mod.create_plan(db_session, user_id, ok, svc, _thread(db_session, user_id)).spec["screen"]["listAt"]
        == "10:00"
    )
    assert db_session.execute(select(PracticePlan.status).where(PracticePlan.status == "active")).scalars().all() == [
        "active"
    ]  # the refused attempt archived nothing


def test_a_new_plan_archives_the_old_one_and_only_one_is_live(db_session, user_id, svc) -> None:
    first = _plan(db_session, user_id, svc)
    second = _plan(db_session, user_id, svc)
    db_session.refresh(first)
    assert (first.status, second.status) == ("archived", "active")
    assert plan_mod.hub(db_session, user_id)["plan"]["id"] == second.id


def test_the_practice_universe_is_the_desk_set_without_non_plain_tickers(db_session, user_id) -> None:
    from ai_trading.db.models import UniverseSymbol

    for symbol, reason in (
        ("ZZZ", None),
        ("COPL.WS", {"reason": "non_plain_ticker"}),
        ("YYY", {"reason": "below_floor"}),
    ):
        db_session.add(
            UniverseSymbol(
                symbol=symbol,
                name=symbol,
                asset_type="stock",
                exchange="",
                active=False,
                passed_floor=False,
                floor_reason=reason,
                updated_at=NOW,
            )
        )
    db_session.commit()
    symbols, capped = plan_mod.practice_universe(db_session, user_id)
    assert {"ZZZ", "YYY", "SPY"} <= set(symbols) and "COPL.WS" not in symbols and capped is False


class _ListedUniverse:
    """The provider's most-actives list, as plain tickers (no movers, no asset names)."""

    def __init__(self, symbols: list[str]) -> None:
        self.symbols, self.calls = symbols, 0

    def assets(self):
        self.calls += 1
        return []

    def most_actives(self, by, top):
        self.calls += 1
        return [ActiveSymbol(s, 1.0, 1, "fake", "delayed-15m") for s in self.symbols]

    def movers(self, top):
        self.calls += 1
        return []


def test_the_first_plan_on_a_fresh_install_freezes_a_full_universe_not_the_seeds(db_session, user_id, svc) -> None:
    listed = [f"A{chr(65 + i)}{chr(65 + j)}" for i in range(10) for j in range(13)]  # 130 plain tickers
    universe = _ListedUniverse(listed)
    svc.sources = replace(svc.sources, universe=universe)
    first = plan_mod.create_plan(db_session, user_id, _block(db_session, user_id), svc, _thread(db_session, user_id))
    db_session.commit()
    assert len(first.universe["symbols"]) == len(SEED_SYMBOLS) + len(listed) >= 130
    assert set(SEED_SYMBOLS) <= set(first.universe["symbols"]) and first.prep["total"] == len(first.universe["symbols"])

    calls = universe.calls
    plan_mod.create_plan(
        db_session, user_id, _block(db_session, user_id), svc, _thread(db_session, user_id)
    )  # a later plan reuses the stored set
    assert universe.calls == calls


def test_a_plan_still_saves_on_the_seeds_when_the_universe_cannot_be_built(db_session, user_id, svc) -> None:
    plan = plan_mod.create_plan(
        db_session, user_id, _block(db_session, user_id), svc, _thread(db_session, user_id)
    )  # the fake source has no lists
    assert set(plan.universe["symbols"]) == set(SEED_SYMBOLS)


# -- prep and opening days --------------------------------------------------------------------------


def test_prep_stores_the_extended_hours_minutes_a_premarket_list_reads(db_session, user_id, svc) -> None:
    plan = _plan(db_session, user_id, svc)
    plan_mod.run_prep(db_session, svc, plan.id)
    payload = svc.store_factory(db_session).get(BlobKey("bars1m", "GAPPER", DAYS[0], "", "sip"))
    assert payload is not None
    bars = decode_bars(payload)
    local = bars.index.tz_convert("America/New_York")
    minutes = local.hour * 60 + local.minute
    assert minutes.min() == 4 * 60 and minutes.max() == 19 * 60 + 59  # 04:00 to 20:00, not the regular session
    assert int((minutes < 9 * 60 + 30).sum()) == 330
    assert (8 * 60 + 14) in set(minutes)  # the 08:14 bar a list at 08:30 reads


def test_a_day_waits_for_prep_then_opens_and_a_second_open_continues_it(db_session, user_id, svc) -> None:
    plan = _plan(db_session, user_id, svc)
    waiting = _open(db_session, user_id, svc)
    assert waiting.day_list is None and waiting.plan.prep["state"] == "running"  # nothing is guessed while it prepares
    report = plan_mod.run_prep(db_session, svc, plan.id)
    assert report["state"] == "done" and report["done"] == 3 and report["failed"] == {}
    first = _open(db_session, user_id, svc)
    assert first.day_list is not None and first.day_list.day == DAYS[0] and first.day_list.day_no == 1
    assert _open(db_session, user_id, svc).day_list.id == first.day_list.id  # Continue, not a second list


def test_prep_records_a_failing_symbol_and_goes_on(db_session, user_id, svc, world) -> None:
    plan = _plan(db_session, user_id, svc)
    plan.universe = {**plan.universe, "symbols": ["GAPPER", "NOPE", "FLAT"]}
    db_session.commit()
    report = plan_mod.run_prep(db_session, svc, plan.id)
    assert report["state"] == "done" and report["done"] == 3
    assert set(report["failed"]) <= {"NOPE"}  # an unknown symbol is NoData: the list counts it, prep does not stop


def test_the_first_list_has_the_gapper_priced_at_the_0814_bar_and_counts_what_it_skipped(
    db_session, user_id, svc
) -> None:
    _ready(db_session, user_id, svc)
    row = _open(db_session, user_id, svc).day_list
    out = plan_mod.day_list_out(db_session, user_id, row.id, svc)
    assert [c["symbol"] for c in out["candidates"]] == ["GAPPER"]
    candidate = out["candidates"][0]
    assert candidate["list_price"] == 106.0 and candidate["metrics"]["last"] == 100.0
    assert candidate["filters"] == ["Gap up"] and candidate["reported_before_open"] is False
    assert out["data_through"] == et(DAYS[0], "08:15") and out["universe"]["size"] == 3
    assert "Practice universe · 3 symbols the Desk has scanned" in out["universe"]["label"]
    assert out["warnings"] == [
        "Only 1 of the 3 scanned symbols met Gap up and Gap down"
        " · loosen a filter in the Screener to widen the next days' lists"
    ]
    assert out["review"] is None and out["journal"] is None and out["clock"] is None


def test_days_open_in_order_one_at_a_time_and_a_split_makes_no_false_gap(db_session, user_id, svc) -> None:
    _ready(db_session, user_id, svc)
    seen = []
    for number, day in enumerate(DAYS, start=1):
        row = _open(db_session, user_id, svc).day_list
        assert (row.day, row.day_no) == (day, number)
        seen.append([c["symbol"] for c in plan_mod.day_list_out(db_session, user_id, row.id, svc)["candidates"]])
        assert _open(db_session, user_id, svc).day_list.id == row.id  # the next day waits for this one to end
        plan_mod.end_day(db_session, user_id, row.id, svc)
        db_session.commit()
    assert seen == [["GAPPER"], [], ["GAPPER"], [], []]  # SPLITTER's 2-for-1 on day 4 is not a -50% gap down
    done = _open(db_session, user_id, svc)
    assert done.day_list is None and plan_mod.plan_out(db_session, done.plan)["finished"] is True


def test_an_empty_list_says_why_in_the_words_of_the_cause(db_session, user_id, svc) -> None:
    _ready(db_session, user_id, svc)
    first = _open(db_session, user_id, svc).day_list
    plan_mod.end_day(db_session, user_id, first.id, svc)
    db_session.commit()
    second = _open(db_session, user_id, svc).day_list  # a quiet morning: nothing gaps 3%
    assert plan_mod.day_list_out(db_session, user_id, second.id, svc)["warnings"] == [
        "None of the 3 scanned symbols met Gap up and Gap down"
        " · loosen a filter in the Screener to widen the next days' lists"
    ]

    # no symbol scanned at all (nothing passed the floor): the floor is named, not the thresholds
    second.universe = {**second.universe, "scanned": 0, "no_data": 1, "below_floor": 2}
    assert plan_mod.day_list_out(db_session, user_id, second.id, svc)["warnings"] == [
        "No symbol could be scanned · 1 had no price data and 2 fell below the $5 and 500,000-share floor"
    ]
    # symbols passed the floor but no filter found a bar to read: a data gap, not thresholds
    second.universe = {
        **second.universe,
        "scanned": 3,
        "filters": [{**item, "scanned": 0, "no_data": 3} for item in second.universe["filters"]],
    }
    assert plan_mod.day_list_out(db_session, user_id, second.id, svc)["warnings"] == [
        "No bars to read at 8:30 AM for any of the 3 symbols that passed the floor"
        " · the data for this day may be missing"
    ]


def test_a_list_saved_before_the_server_refused_an_early_cadence_filter_says_so(db_session, user_id, svc) -> None:
    changes = {
        "screen": {"filters": [{"id": _filter_id(db_session, user_id, "Abnormal volume")}], "listAt": "10:00"},
        "setup": {"window": {"from": "10:00", "to": "12:00"}},
    }
    plan = _plan(db_session, user_id, svc, **changes)
    plan_mod.run_prep(db_session, svc, plan.id)
    row = _open(db_session, user_id, svc).day_list
    row.screen = {**row.screen, "listAt": "08:30"}  # the plan as it stood before D-001: a 15-minute filter at 8:30
    assert plan_mod.day_list_out(db_session, user_id, row.id, svc)["warnings"] == [
        "Abnormal volume reads bars of the day itself, and none had closed by 8:30 AM · only the previous session was "
        "visible. Start a new plan with a list time of 10:00 AM or later"
    ]


def test_the_list_is_the_one_the_live_runner_would_have_stored(db_session, user_id, svc) -> None:
    """Live equivalence: the same cut data through `StoredBars` (the live reader) scans to the same matches."""
    from ai_trading.data.bars import upsert_bars
    from ai_trading.screener import runner
    from ai_trading.screener.evaluator import scan

    _ready(db_session, user_id, svc)
    day = DAYS[0]
    list_at = et(day, "08:30")
    through = list_at - screen.LIST_DATA_LAG
    store = svc.store_factory(db_session)
    now = pd.Timestamp(NOW)
    for symbol in SYMBOLS:  # the live store at 08:30: daily bars through the previous close, minutes through 08:14
        daily = screen.asof_frames(svc.history, store, symbol, [day])[day]
        upsert_bars(db_session, symbol, "1d", daily, "synthetic", "stock", now=now)
        minutes = screen.minutes_loader(svc.history, store, day)(symbol)
        minutes = minutes[minutes.index + pd.Timedelta(minutes=1) <= through]
        for start in range(0, len(minutes), 2_000):  # one statement may carry only 65,535 parameters
            upsert_bars(db_session, symbol, "1m", minutes.iloc[start : start + 2_000], "synthetic", "stock", now=now)
    db_session.commit()

    gap_up = db_session.get(FilterStrategy, _filter_id(db_session, user_id, "Gap up"))
    from ai_trading.db.models import FilterStrategyVersion

    spec = db_session.get(FilterStrategyVersion, gap_up.current_version_id).spec
    live = scan(spec, runner.StoredBars(db_session, SYMBOLS, now=list_at.to_pydatetime(), minutes=True), list_at)
    built = screen.build_list(
        filters=[screen.FilterInput(gap_up.id, 1, gap_up.name, spec, SYMBOLS)],
        daily_of=screen.asof_loader(svc.history, store, day),
        minutes_of=screen.minutes_loader(svc.history, store, day),
        day=day,
        list_at=list_at,
        max_list=30,
    )
    assert [m.symbol for m in live.matches] == [c["symbol"] for c in built.candidates] == ["GAPPER"]
    assert live.matches[0].operands == built.candidates[0]["operands"]
    assert live.matches[0].rank_value == built.candidates[0]["rank_value"]


# -- stars ------------------------------------------------------------------------------------------


def _first_list(db_session, user_id, svc) -> ReplayDayList:
    _ready(db_session, user_id, svc)
    return _open(db_session, user_id, svc).day_list


def test_stars_must_be_on_the_list_at_most_five_and_carry_the_clock(db_session, user_id, svc) -> None:
    row = _first_list(db_session, user_id, svc)
    with pytest.raises(ReplayProblem) as caught:
        plan_mod.patch_day_list(
            db_session, user_id, row.id, svc, watch=["FLAT"], notes=None, rating=None, fields={"watch"}
        )
    assert (caught.value.path, caught.value.message) == ("watch.0", "FLAT is not on today's list")
    starred = plan_mod.patch_day_list(
        db_session, user_id, row.id, svc, watch=["GAPPER"], notes="x", rating=None, fields={"watch", "notes"}
    )
    assert starred.watch == [{"symbol": "GAPPER", "starred_clock": et(DAYS[0], "08:30").isoformat()}]
    assert starred.notes == "x"
    cleared = plan_mod.patch_day_list(
        db_session, user_id, row.id, svc, watch=[], notes=None, rating=None, fields={"watch"}
    )
    assert cleared.watch == [] and cleared.notes == "x"  # a key left out is left alone


def test_a_non_owner_gets_not_found(db_session, user_id, svc) -> None:
    row = _first_list(db_session, user_id, svc)
    other = User(email="spouse@example.com", settings={})
    db_session.add(other)
    db_session.commit()
    with pytest.raises(SessionNotFound):
        plan_mod.day_list_out(db_session, other.id, row.id, svc)


# -- the day's session on the shared clock ----------------------------------------------------------


def _advance(db_session, user_id, svc, session_id, hhmm):
    to = et(DAYS[0], hhmm).to_pydatetime()
    return session_mod.advance(
        db_session, user_id, session_id, svc, to=to, step=None, interval=None, min_size=0, min_notional=0, max_prints=50
    )


def test_the_session_follows_the_plan_and_the_clock_moves_with_it(db_session, user_id, svc) -> None:
    row = _first_list(db_session, user_id, svc)
    with pytest.raises(ReplayProblem) as caught:
        plan_mod.start_session(db_session, user_id, row.id, "FLAT", svc)
    assert caught.value.message == "FLAT is not on today's list"
    started = plan_mod.start_session(db_session, user_id, row.id, "GAPPER", svc)
    assert started.day_list_id == row.id and started.day == DAYS[0] and started.spec["interval"] == "5m"
    assert started.spec["hideDate"] == "yes" and started.spec["window"] == {"from": "09:30", "to": "11:30"}
    db_session.refresh(row)
    assert row.status == "practicing" and row.revealed_through == et(DAYS[0], "09:30")

    _advance(db_session, user_id, svc, started.id, "10:00")
    db_session.refresh(row)
    assert row.revealed_through == et(DAYS[0], "10:00")  # the day clock follows the playhead
    with pytest.raises(ReplayProblem) as ended:
        session_mod.end(db_session, user_id, started.id, svc)
    assert (ended.value.status, ended.value.message) == (409, "End the day to score this session")
    again = plan_mod.start_session(db_session, user_id, row.id, "GAPPER", svc)
    assert again.id == started.id  # the same name again is the same session
    assert _advance(db_session, user_id, svc, started.id, "09:45")["revealed_through"] == et(
        DAYS[0], "10:00"
    )  # forward only


def test_a_second_name_is_refused_in_v1_and_a_standalone_session_cannot_share_the_day(db_session, user_id, svc) -> None:
    row = _first_list(db_session, user_id, svc)
    plan_mod.start_session(db_session, user_id, row.id, "GAPPER", svc)
    plan = db_session.get(PracticePlan, row.plan_id)
    row.candidates = [*row.candidates, {**row.candidates[0], "symbol": "FLAT", "rank": 2}]
    db_session.commit()
    with pytest.raises(ReplayProblem) as caught:
        plan_mod.start_session(db_session, user_id, row.id, "FLAT", svc)
    assert caught.value.status == 409 and caught.value.message.startswith("Your day is on GAPPER")
    standalone = plan_mod._session_spec(plan, DAYS[0], "GAPPER", _thread(db_session, user_id))
    with pytest.raises(ReplayProblem) as other:
        session_mod.create(db_session, user_id, standalone, svc)
    assert other.value.status == 409 and other.value.message.startswith("This day is part of your daily list")


def test_a_name_behind_the_day_clock_cannot_be_marked_until_it_catches_up(db_session, user_id, svc) -> None:
    row = _first_list(db_session, user_id, svc)
    started = plan_mod.start_session(db_session, user_id, row.id, "GAPPER", svc)
    _advance(db_session, user_id, svc, started.id, "10:00")
    row.revealed_through = et(DAYS[0], "10:30").to_pydatetime()  # another name moved the clock on (02o-b2's switch)
    db_session.commit()
    mark = {"schemaVersion": 1, "kind": "long_entry"}
    with pytest.raises(ReplayProblem) as caught:
        session_mod.place_mark(db_session, user_id, started.id, svc, mark)
    assert caught.value.message == "This name is behind the day clock · advance to catch up before you mark"
    caught_up = _advance(db_session, user_id, svc, started.id, "10:05")  # a nudge catches the name up to the clock
    assert caught_up["revealed_through"] == et(DAYS[0], "10:30")
    placed = session_mod.place_mark(db_session, user_id, started.id, svc, mark)
    assert placed["mark"]["price"] == 110.0 and placed["mark"]["at"] == et(DAYS[0], "10:30")


def test_a_mark_priced_off_an_old_print_carries_a_warning_and_the_tape_goes_quiet(
    db_session, user_id, svc, monkeypatch
) -> None:
    row = _first_list(db_session, user_id, svc)
    started = plan_mod.start_session(db_session, user_id, row.id, "GAPPER", svc)
    frame = _advance(db_session, user_id, svc, started.id, "10:00")
    assert frame["last"]["age_s"] == 0 and frame["quiet_s"] is None  # priced from the minute close that just closed
    placed = session_mod.place_mark(db_session, user_id, started.id, svc, {"schemaVersion": 1, "kind": "long_entry"})
    assert placed["warning"] is None
    monkeypatch.setattr(
        svc.tape, "last_print", lambda store, symbol, through, feed: (through - pd.Timedelta(seconds=95), 109.5)
    )
    frame = session_mod.advance(
        db_session,
        user_id,
        started.id,
        svc,
        to=et(DAYS[0], "10:01").to_pydatetime(),
        step=None,
        interval=None,
        min_size=0,
        min_notional=0,
        max_prints=10,
    )
    assert frame["last"]["age_s"] == 95 and frame["quiet_s"] == 95
    exit_mark = session_mod.place_mark(db_session, user_id, started.id, svc, {"schemaVersion": 1, "kind": "long_exit"})
    assert exit_mark["warning"] == "Priced off a print 95 s old · the tape has been quiet"


# -- ending the day ---------------------------------------------------------------------------------


def _timestamps(value, out: list[pd.Timestamp]) -> None:
    """Every ISO timestamp anywhere in a JSON-ish value."""
    if isinstance(value, dict):
        for item in value.values():
            _timestamps(item, out)
    elif isinstance(value, list):
        for item in value:
            _timestamps(item, out)
    elif isinstance(value, (datetime, pd.Timestamp)):
        out.append(pd.Timestamp(value))
    elif isinstance(value, str) and len(value) >= 19 and value[4] == "-" and value[10] == "T":
        out.append(pd.Timestamp(value))


def test_nothing_the_list_serves_before_the_day_ends_is_later_than_the_cut(db_session, user_id, svc) -> None:
    row = _first_list(db_session, user_id, svc)
    plan_mod.patch_day_list(
        db_session, user_id, row.id, svc, watch=["GAPPER"], notes=None, rating=None, fields={"watch"}
    )
    out = plan_mod.day_list_out(db_session, user_id, row.id, svc, peek="GAPPER")
    served = {k: out[k] for k in ("candidates", "universe", "columns", "peek", "review", "journal")}
    stamps: list[pd.Timestamp] = []
    _timestamps(json.loads(json.dumps(served, default=lambda o: o.isoformat())), stamps)
    through, list_at = pd.Timestamp(out["data_through"]), pd.Timestamp(out["list_at"])
    assert stamps and max(stamps) <= list_at  # the newest thing served is the list time: a point's `matched_since`
    prices: list[pd.Timestamp] = []
    _timestamps([c["price_at"] for c in out["candidates"]] + [out["peek"]["minutes"]], prices)
    assert prices and max(prices) <= through  # every price and bar is cut at 08:15, a quarter hour short of the list
    clocks: list[pd.Timestamp] = []
    _timestamps(out["watch"], clocks)
    assert clocks and max(clocks) <= list_at  # a star carries the list time, not a later one
    assert out["review"] is None and out["journal"] is None
    assert out["peek"]["minutes"] and out["peek"]["minutes"][-1]["t"] < pd.Timestamp(out["data_through"])
    assert out["peek"]["daily"][-1]["t"] < DAYS[0]  # through the previous session, never the day
    assert out["peek"]["levels"]["prior_close"] == 100.0 and out["peek"]["levels"]["premarket_high"] == 106.0


def test_peek_is_fed_the_rebased_daily_frame_not_the_raw_one(db_session, user_id, svc) -> None:
    _ready(db_session, user_id, svc)
    for _ in range(3):  # open days 1 to 3 and end them: day 4 is the morning after SPLITTER's split
        row = _open(db_session, user_id, svc).day_list
        plan_mod.end_day(db_session, user_id, row.id, svc)
        db_session.commit()
    row = _open(db_session, user_id, svc).day_list
    row.candidates = (
        [{**plan_mod.day_list_out(db_session, user_id, row.id, svc)["candidates"][0], "symbol": "SPLITTER"}]
        if row.candidates
        else [{"rank": 1, "symbol": "SPLITTER", "list_price": 50.0, "filters": [], "metrics": {}}]
    )
    db_session.commit()
    peek = plan_mod.day_list_out(db_session, user_id, row.id, svc, peek="SPLITTER")["peek"]
    assert {bar["c"] for bar in peek["daily"]} == {50.0}  # the raw series would show 100 before the split


def test_end_day_unseals_the_review_and_ranks_the_candidates_by_move_from_the_list_price(
    db_session, user_id, svc
) -> None:
    row = _first_list(db_session, user_id, svc)
    plan_mod.patch_day_list(
        db_session, user_id, row.id, svc, watch=["GAPPER"], notes=None, rating=None, fields={"watch"}
    )
    started = plan_mod.start_session(db_session, user_id, row.id, "GAPPER", svc)
    _advance(db_session, user_id, svc, started.id, "10:00")
    session_mod.place_mark(db_session, user_id, started.id, svc, {"schemaVersion": 1, "kind": "long_entry"})
    ended = plan_mod.end_day(db_session, user_id, row.id, svc)
    db_session.commit()
    assert ended.status == "ended" and ended.revealed_through == et(DAYS[0], "11:30")
    out = plan_mod.day_list_out(db_session, user_id, row.id, svc)
    review = out["review"]
    gapper = review["rows"][0]
    assert gapper["symbol"] == "GAPPER" and gapper["list_price"] == 106.0 and gapper["window_end_price"] == 110.0
    assert gapper["move_pct"] == 3.77 and gapper["rank"] == 1 and gapper["picked"] == "traded"
    assert review["selection"]["picks"] == [{"symbol": "GAPPER", "kind": "traded", "move_pct": 3.77, "rank": 1}]
    assert out["journal"]["sessions"][0]["symbol"] == "GAPPER" and out["journal"]["trades"] == 1
    assert out["sessions"] == [{"id": started.id, "symbol": "GAPPER", "status": "ended"}]
    assert plan_mod.end_day(db_session, user_id, row.id, svc).ended_at == ended.ended_at  # idempotent
    with pytest.raises(ReplayProblem):
        plan_mod.patch_day_list(db_session, user_id, row.id, svc, watch=[], notes=None, rating=None, fields={"watch"})


def test_ending_a_day_with_no_practice_still_gives_the_review(db_session, user_id, svc) -> None:
    row = _first_list(db_session, user_id, svc)
    plan_mod.end_day(db_session, user_id, row.id, svc)
    out = plan_mod.day_list_out(db_session, user_id, row.id, svc)
    assert (
        out["status"] == "ended" and out["journal"]["sessions"] == [] and out["review"]["rows"][0]["move_pct"] == 3.77
    )
