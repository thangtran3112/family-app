"""The finished day's review (D-029, D-031, D-032): the list ranked by signed move, the day's trade lines and balances,
and the date the review shows. The first group is pure; the second runs the GAPPER day of `tests/daily_world.py`
through the services (real Postgres, `scripts/test-db.sh`)."""

import pandas as pd
import pytest
from daily_world import DAYS
from sqlalchemy import update
from test_replay_plan import _advance, _first_list, _open, _plan
from test_replay_threads import _mark

from ai_trading.db.models import ReplayDayList
from ai_trading.replay import plan as plan_mod
from ai_trading.replay import review as review_mod
from ai_trading.replay import threads as threads_mod

END = pd.Timestamp("2026-07-01T15:30:00Z")


def _row(symbol: str, move: float | None) -> dict:
    return {
        "symbol": symbol,
        "list_price": 100.0,
        "window_end_price": None if move is None else round(100 + move, 2),
        "move_pct": move,
        "close_price": None,
        "close_move_pct": None,
        "high_pct": None,
        "low_pct": None,
        "range_pct": None,
    }


# The recorded day (D-031): BE -5.00%, META +4.25%, BEZ +3.62%, BEX -3.38%, NKE +3.34% ranked 1 to 5 by size.
RECORDED = [_row("BE", -5.0), _row("META", 4.25), _row("BEZ", 3.62), _row("BEX", -3.38), _row("NKE", 3.34)]


def test_rank_is_by_signed_move_biggest_gain_first_and_a_loss_never_outranks_a_gain() -> None:
    review = review_mod.rank_review(RECORDED, END, {"META": "traded"})
    assert [(r["symbol"], r["rank"]) for r in review["rows"]] == [
        ("META", 1),
        ("BEZ", 2),
        ("NKE", 3),
        ("BEX", 4),
        ("BE", 5),
    ]
    assert review["of"] == 5


def test_the_median_and_the_picks_average_are_signed() -> None:
    review = review_mod.rank_review(RECORDED, END, {"META": "traded", "BE": "starred"})
    assert review["selection"]["median_move_pct"] == 3.34  # of -5.00, -3.38, 3.34, 3.62, 4.25
    assert review["selection"]["picks_avg_move_pct"] == -0.38  # (4.25 - 5.00) / 2
    assert review["selection"]["picks"] == [
        {"symbol": "META", "kind": "traded", "move_pct": 4.25, "rank": 1},
        {"symbol": "BE", "kind": "starred", "move_pct": -5.0, "rank": 5},
    ]
    assert "median_abs_move_pct" not in review["selection"]


def test_ties_break_by_symbol_and_a_candidate_with_no_move_is_unranked_and_out_of_the_median() -> None:
    review = review_mod.rank_review([_row("ZZZ", 1.0), _row("AAA", 1.0), _row("NOMOVE", None)], END, {})
    assert [(r["symbol"], r["rank"]) for r in review["rows"]] == [("AAA", 1), ("ZZZ", 2), ("NOMOVE", None)]
    assert review["of"] == 2 and review["selection"]["median_move_pct"] == 1.0
    empty = review_mod.rank_review([_row("X", None)], END, {})
    assert empty["of"] == 0 and empty["selection"]["median_move_pct"] is None
    assert empty["selection"]["picks_avg_move_pct"] is None


def test_a_review_stored_before_the_fix_is_served_ranked_the_current_way() -> None:
    """Day 1 of the live thread was stored with absolute ranks and the absolute median; it reads like any other day."""
    legacy = review_mod.rank_review(RECORDED, END, {"META": "traded"})
    by_size = sorted(legacy["rows"], key=lambda r: -abs(r["move_pct"]))
    for rank, row in enumerate(by_size, start=1):
        row["rank"] = rank  # BE was 1, META 2 ...
    legacy["rows"] = by_size
    legacy["selection"] = {
        "picks": [{"symbol": "META", "kind": "traded", "move_pct": 4.25, "rank": 2}],
        "median_abs_move_pct": 3.62,
        "picks_avg_abs_move_pct": 4.25,
    }
    served = review_mod.normalized(legacy)
    assert [(r["symbol"], r["rank"]) for r in served["rows"]] == [
        ("META", 1),
        ("BEZ", 2),
        ("NKE", 3),
        ("BEX", 4),
        ("BE", 5),
    ]
    assert served["selection"]["picks"] == [{"symbol": "META", "kind": "traded", "move_pct": 4.25, "rank": 1}]
    assert served["selection"]["median_move_pct"] == 3.34 and "median_abs_move_pct" not in served["selection"]
    assert served["window_end"] == END


# -- through the services -----------------------------------------------------------------------------------------


def _traded_day(db_session, user_id, svc):
    """Day 1: GAPPER long 10 shares entered at 09:30 (106.00) and exited at 10:00 (110.00): +$40.00."""
    row = _first_list(db_session, user_id, svc)
    session = plan_mod.start_session(db_session, user_id, row.id, "GAPPER", svc)
    _advance(db_session, user_id, svc, session.id, "09:30")
    _mark(db_session, user_id, svc, session.id, "long_entry", shares=10)
    _advance(db_session, user_id, svc, session.id, "10:00")
    _mark(db_session, user_id, svc, session.id, "long_exit")
    plan_mod.end_day(db_session, user_id, row.id, svc)
    db_session.commit()
    return row, session


def test_the_review_serves_a_line_per_trade_the_day_result_and_the_balance_before_and_after(
    db_session, user_id, svc
) -> None:
    row, session = _traded_day(db_session, user_id, svc)
    journal = plan_mod.day_list_out(db_session, user_id, row.id, svc)["journal"]
    (line,) = journal["lines"]
    assert line["symbol"] == "GAPPER" and line["side"] == "long" and line["shares"] == 10
    assert (line["entry_price"], line["exit_price"], line["pnl_usd"]) == (106.0, 110.0, 40.0)
    assert line["entry_at"] == "2026-09-28T13:30:00+00:00" or str(line["entry_at"]).startswith("2026-09-28T13:30")
    assert str(line["exit_at"]).startswith("2026-09-28T14:00") and line["exit_source"] == "her"
    assert (journal["trades"], journal["wins"], journal["losses"], journal["scratches"]) == (1, 1, 0, 0)
    assert journal["pnl_usd"] == 40.0
    assert (journal["balance_before"], journal["balance_after"]) == (50_000.0, 50_040.0)  # SIMULATED balance
    assert journal["sessions"][0]["id"] == session.id


def test_a_day_stored_before_the_trade_lines_existed_serves_them_from_its_sessions(db_session, user_id, svc) -> None:
    row, _ = _traded_day(db_session, user_id, svc)
    db_session.execute(
        update(ReplayDayList)
        .where(ReplayDayList.id == row.id)
        .values(journal={"sessions": [], "trades": 1, "pnl_usd": 40.0})  # the old stored shape
    )
    db_session.commit()
    db_session.expire_all()
    journal = plan_mod.day_list_out(db_session, user_id, row.id, svc)["journal"]
    assert len(journal["lines"]) == 1 and journal["lines"][0]["pnl_usd"] == 40.0 and journal["wins"] == 1


def test_a_losing_and_a_winning_trade_count_as_a_loss_and_a_win_in_entry_order(db_session, user_id, svc) -> None:
    row = _first_list(db_session, user_id, svc)
    session = plan_mod.start_session(db_session, user_id, row.id, "GAPPER", svc)
    _advance(db_session, user_id, svc, session.id, "09:30")
    _mark(db_session, user_id, svc, session.id, "short_entry", shares=10)  # short 106, cover 110: -40
    _advance(db_session, user_id, svc, session.id, "09:35")
    _mark(db_session, user_id, svc, session.id, "short_exit")
    _mark(db_session, user_id, svc, session.id, "long_entry", shares=5)  # long 110, out 110: a scratch
    _mark(db_session, user_id, svc, session.id, "long_exit")
    plan_mod.end_day(db_session, user_id, row.id, svc)
    journal = plan_mod.day_list_out(db_session, user_id, row.id, svc)["journal"]
    assert [line["side"] for line in journal["lines"]] == ["short", "long"]
    assert (journal["wins"], journal["losses"], journal["scratches"]) == (0, 1, 1)
    assert journal["pnl_usd"] == -40.0 and journal["balance_after"] == 49_960.0


def test_the_finished_day_carries_its_date_and_whether_the_plan_hid_it(db_session, user_id, svc) -> None:
    row = _first_list(db_session, user_id, svc)
    assert plan_mod.day_list_out(db_session, user_id, row.id, svc)["review"] is None  # nothing while the day runs
    plan_mod.end_day(db_session, user_id, row.id, svc)
    review = plan_mod.day_list_out(db_session, user_id, row.id, svc)["review"]
    assert review["day"] == DAYS[0] and review["dates_hidden"] is True  # the plan hid it; the review states it


def test_the_day_balances_are_the_series_the_journal_draws(db_session, user_id, svc) -> None:
    row, _ = _traded_day(db_session, user_id, svc)
    thread = threads_mod.active_thread(db_session, user_id)
    assert threads_mod.day_balances(db_session, thread, row.id) == (50_000.0, 50_040.0)
    assert threads_mod.day_balances(db_session, thread, row.id + 999) is None
    detail = threads_mod.detail(db_session, thread)
    assert detail["daily"][0]["balance"] == 50_040.0


@pytest.mark.parametrize("hide", ["yes", "no"])
def test_dates_hidden_follows_the_plan(db_session, user_id, svc, hide) -> None:
    plan = _plan(db_session, user_id, svc, hideDates=hide)
    plan_mod.run_prep(db_session, svc, plan.id)
    day = _open(db_session, user_id, svc).day_list
    plan_mod.end_day(db_session, user_id, day.id, svc)
    db_session.commit()
    assert plan_mod.day_list_out(db_session, user_id, day.id, svc)["review"]["dates_hidden"] is (hide == "yes")
