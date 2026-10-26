"""The `universe_days` read path (02o-b2, `replay/universe_days.py`): the recording's coverage, the plan form's default
first day, and a day list that scans the names the Desk recorded for its morning (or says it scans today's set). Real
Postgres; the synthetic world of `tests/daily_world.py`."""

from datetime import date

from daily_world import DAYS, NOW
from test_replay_plan import _open, _ready

from ai_trading.db.models import UniverseDay
from ai_trading.replay import plan as plan_mod
from ai_trading.replay import universe_days as universe_mod


def _record(db_session, day: date, symbols: list[str]) -> None:
    db_session.add(UniverseDay(day=day, symbols=symbols, created_at=NOW))
    db_session.commit()


def test_with_no_recording_there_is_no_default_and_the_reason_is_plain(db_session) -> None:
    out = universe_mod.read(db_session, None, NOW)
    assert out["coverage"] == {"first_day": None, "last_day": None, "days": 0}
    assert out["first_day_default"] is None and out["day"] is None
    assert (
        out["first_day_note"]
        == "The Desk has not recorded a morning's universe yet · the default start is three months back"
    )


def test_the_default_first_day_waits_for_twenty_finished_days_since_the_first_recording(db_session) -> None:
    _record(db_session, date(2026, 9, 29), ["FLAT"])
    assert len(universe_mod.finished_days_since(date(2026, 9, 29), NOW)) == 19
    waiting = universe_mod.read(db_session, None, NOW)
    assert waiting["first_day_default"] is None
    assert waiting["first_day_note"] == (
        "The Desk has recorded 19 finished days of its universe so far · "
        "the default start moves to the first recorded day once there are 20"
    )
    _record(db_session, date(2026, 9, 28), ["FLAT", "GAPPER"])
    ready = universe_mod.read(db_session, None, NOW)
    assert ready["first_day_default"] == date(2026, 9, 28)
    assert ready["coverage"] == {"first_day": date(2026, 9, 28), "last_day": date(2026, 9, 29), "days": 2}
    assert "20 finished days" in ready["first_day_note"]


def test_a_recorded_day_is_read_back_sorted_and_an_unrecorded_one_says_it_is_todays_set(db_session) -> None:
    _record(db_session, DAYS[0], ["GAPPER", "FLAT", "GAPPER"])
    one = universe_mod.read(db_session, DAYS[0], NOW)["day"]
    assert one == {
        "day": DAYS[0],
        "recorded": True,
        "size": 2,
        "symbols": ["FLAT", "GAPPER"],
        "note": "Practice universe · the 2 symbols the Desk scanned that morning, as recorded",
    }
    none = universe_mod.read(db_session, DAYS[1], NOW)["day"]
    assert (none["recorded"], none["size"], none["symbols"]) == (False, None, [])
    assert "before the Desk began recording" in none["note"]


def test_a_single_recorded_symbol_is_not_pluralised() -> None:
    one = universe_mod.scanned_label(1)
    assert one == "Practice universe · the 1 symbol the Desk scanned that morning, as recorded"
    assert universe_mod.scanned_label(0).startswith("Practice universe · the 0 symbols")


def test_membership_cuts_the_recording_to_the_prepared_set_and_says_what_it_left_out() -> None:
    used, record = universe_mod.membership(["A", "B", "C"], ["B", "C", "D", "E"])
    assert used == ["B", "C"] and record["source"] == "universe_days"
    assert (record["recorded_size"], record["scanned_size"]) == (4, 2)
    assert record["note"].endswith("2 of them were not in your plan's prepared set and are left out")
    same, today = universe_mod.membership(["A", "B"], None)
    assert same == ["A", "B"] and today["source"] == "today" and today["recorded_size"] is None


def test_a_day_with_a_recording_scans_that_mornings_names_and_a_day_without_says_it_scans_todays_set(
    db_session, user_id, svc
) -> None:
    _ready(db_session, user_id, svc)
    _record(db_session, DAYS[0], ["FLAT", "SPLITTER"])  # GAPPER was not on the Desk that morning
    first = _open(db_session, user_id, svc).day_list
    out = plan_mod.day_list_out(db_session, user_id, first.id, svc)
    assert [c["symbol"] for c in out["candidates"]] == []  # the gapper was never scanned: today's set cannot leak in
    assert (out["universe"]["size"], out["universe"]["scanned"]) == (2, 2)
    assert out["universe"]["membership"] == {
        "source": "universe_days",
        "recorded_size": 2,
        "scanned_size": 2,
        "note": "Practice universe · the 2 symbols the Desk scanned that morning, as recorded",
    }
    assert out["universe"]["footnote"].startswith("Practice universe · the 2 symbols the Desk scanned that morning")
    assert "capped" not in out["universe"]["footnote"]

    plan_mod.end_day(db_session, user_id, first.id, svc)
    db_session.commit()
    second = _open(db_session, user_id, svc).day_list  # DAYS[1] has no recording: today's set
    again = plan_mod.day_list_out(db_session, user_id, second.id, svc)
    assert again["universe"]["membership"]["source"] == "today"
    assert again["universe"]["size"] == 3 and again["universe"]["scanned"] == 3
    assert "before the Desk began recording each morning's universe" in again["universe"]["footnote"]
    assert again["universe"]["label"].startswith("Practice universe · 3 symbols the Desk has scanned")


def test_a_recording_that_holds_none_of_the_plans_names_scans_nothing_and_says_so(db_session, user_id, svc) -> None:
    _ready(db_session, user_id, svc)
    _record(db_session, DAYS[0], ["ZZZZ"])
    out = plan_mod.day_list_out(db_session, user_id, _open(db_session, user_id, svc).day_list.id, svc)
    assert out["universe"]["scanned"] == 0 and out["universe"]["membership"]["scanned_size"] == 0
    assert "1 of them were not in your plan's prepared set" in out["universe"]["footnote"]
    assert out["warnings"] and out["warnings"][0].startswith("No symbol could be scanned")


def test_the_footnote_never_names_the_day(db_session, user_id, svc) -> None:
    _ready(db_session, user_id, svc)
    _record(db_session, DAYS[0], ["GAPPER"])
    out = plan_mod.day_list_out(db_session, user_id, _open(db_session, user_id, svc).day_list.id, svc)
    text = f"{out['universe']['label']} {out['universe']['footnote']}"
    assert DAYS[0].isoformat() not in text and "Sep" not in text
