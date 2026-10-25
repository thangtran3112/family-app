"""Golden journal cases (02o §i): hand-computed sessions on a synthetic 1-minute path. Prices are chosen so
every expected number below can be checked by hand."""

import pandas as pd
import pytest

from ai_trading.replay.journal import compute_journal
from ai_trading.replay.model import Fire, Mark, Plan

T0 = pd.Timestamp("2026-10-23T13:30:00Z")  # 09:30 ET
END = T0 + pd.Timedelta(minutes=60)


def at(minute: float) -> pd.Timestamp:
    return T0 + pd.Timedelta(minutes=minute)


def flat_bars(price: float = 100.0, *, lows: dict[int, float] | None = None, highs: dict[int, float] | None = None):
    index = pd.date_range(T0, periods=60, freq="1min")
    frame = pd.DataFrame({"open": price, "high": price, "low": price, "close": price, "volume": 1000.0}, index=index)
    for minute, low in (lows or {}).items():
        frame.iloc[minute, frame.columns.get_loc("low")] = low
    for minute, high in (highs or {}).items():
        frame.iloc[minute, frame.columns.get_loc("high")] = high
    return frame


NO_PLAN = Plan()


def journal(marks, *, bars=None, fires=(), plan=NO_PLAN, as_of=END, last_price=100.0, final=True, display=5):
    return compute_journal(
        marks,
        bars=flat_bars() if bars is None else bars,
        fires=list(fires),
        plan=plan,
        display_minutes=display,
        window_start=T0,
        window_end=END,
        as_of=as_of,
        last_price=last_price,
        final=final,
    )


def long_trade(entry: float, exit_: float, shares: int, *, stop: float | None, opened=5, closed=10, no=1, base=0):
    return [
        Mark(base + 1, "long_entry", at(opened), entry, shares, stop, trade_no=no),
        Mark(base + 2, "long_exit", at(closed), exit_, trade_no=no),
    ]


def test_long_win_in_dollars_and_r():
    j = journal(long_trade(100.0, 101.5, 100, stop=99.0))
    assert j["totals"]["pnl_usd"] == 150.0
    assert j["totals"]["r_total"] == 1.5
    assert (j["totals"]["wins"], j["totals"]["losses"], j["totals"]["win_rate"]) == (1, 0, 1.0)
    assert j["trades"][0]["pnl_usd"] == 150.0 and j["trades"][0]["r"] == 1.5
    assert j["totals"]["avg_win_usd"] == 150.0 and j["totals"]["avg_loss_usd"] is None


def test_short_loss_is_entry_minus_exit_times_shares():
    marks = [
        Mark(1, "short_entry", at(5), 50.0, 200, 51.0, trade_no=1),
        Mark(2, "short_exit", at(10), 50.75, trade_no=1),
    ]
    j = journal(marks)
    assert j["trades"][0]["side"] == "short"
    assert j["trades"][0]["pnl_usd"] == -150.0
    assert j["trades"][0]["r"] == -0.75
    assert j["totals"]["largest_loss_usd"] == -150.0 and j["totals"]["avg_loss_usd"] == -150.0


def test_scratch_has_no_win_or_loss_and_no_r_without_a_stop():
    j = journal(long_trade(100.0, 100.0, 10, stop=None))
    assert j["totals"]["scratches"] == 1 and j["totals"]["wins"] == 0 and j["totals"]["losses"] == 0
    assert j["trades"][0]["r"] is None and j["totals"]["r_total"] == 0.0


def test_stop_note_set_after_entry_is_the_r_basis_and_later_notes_only_move_the_line():
    marks = [
        Mark(1, "long_entry", at(5), 100.0, 100, None, trade_no=1),
        Mark(2, "stop", at(6), None, None, 98.0, trade_no=1),
        Mark(3, "stop", at(7), None, None, 99.5, trade_no=1),  # trailed up: R keeps the first stop
        Mark(4, "long_exit", at(10), 102.0, trade_no=1),
    ]
    j = journal(marks)
    assert j["trades"][0]["stop_price"] == 98.0
    assert j["trades"][0]["r"] == 1.0  # (102 - 100) / |100 - 98|


def test_auto_exit_is_labelled():
    marks = [
        Mark(1, "long_entry", at(5), 100.0, 10, None, trade_no=1),
        Mark(2, "long_exit", END, 101.0, trade_no=1, source="auto"),
    ]
    assert journal(marks)["trades"][0]["exit_source"] == "auto"


def test_open_trade_counts_in_the_series_not_in_the_totals():
    marks = [Mark(1, "long_entry", at(5), 100.0, 100, None, trade_no=1)]
    bars = flat_bars(103.0)
    j = journal(marks, bars=bars, as_of=at(20), last_price=103.0, final=False)
    assert j["totals"]["trades"] == 0
    assert j["pnl_series"][-1]["pnl_usd"] == 300.0
    assert j["pnl_series"][0] == {"t": T0, "pnl_usd": 0.0}
    assert j["signals_vs_trades"] == []  # looks past the playhead: empty until the session ends


def test_pnl_series_steps_to_realized_at_the_exit():
    j = journal(long_trade(100.0, 101.0, 100, stop=None), bars=flat_bars(100.5))
    by_time = {point["t"]: point["pnl_usd"] for point in j["pnl_series"]}
    assert by_time[at(8)] == 50.0  # open, marked at the minute close
    assert by_time[at(11)] == 100.0  # realized
    assert j["pnl_series"][-1]["pnl_usd"] == 100.0


def test_stop_honored_when_exit_comes_by_the_next_close():
    bars = flat_bars(lows={7: 98.5})  # minute 7 trades below the 99 stop
    honored = long_trade(100.0, 98.6, 100, stop=99.0, closed=8.5)  # exits inside the next minute
    late = long_trade(100.0, 97.0, 100, stop=99.0, closed=12)
    plan = Plan()
    assert journal(honored, bars=bars, plan=plan)["adherence"]["checks"][1]["passed"] is True
    check = journal(late, bars=bars, plan=plan)["adherence"]["checks"][1]
    assert check["passed"] is False and check["detail"] == "0 of 1" and check["applicable"] is True


def test_short_stop_crossing_uses_the_high():
    bars = flat_bars(highs={7: 101.5})
    marks = [
        Mark(1, "short_entry", at(5), 100.0, 10, 101.0, trade_no=1),
        Mark(2, "short_exit", at(15), 102.0, trade_no=1),
    ]
    assert journal(marks, bars=bars)["adherence"]["checks"][1]["passed"] is False


def test_no_plan_gives_a_null_score_and_the_hint():
    j = journal(long_trade(100.0, 101.0, 10, stop=None))
    assert j["adherence"]["score_pct"] is None
    assert j["adherence"]["hint"] == "Add a plan to get an adherence score"


def test_plan_with_no_trades_has_no_score_yet():
    j = journal([], plan=Plan(stop_required=True, max_trades=3))
    checks = {c["id"]: c for c in j["adherence"]["checks"]}
    assert j["adherence"]["score_pct"] == 100  # only max_trades applies (0 of 3), and it passes
    assert checks["stop_set"]["applicable"] is False and checks["max_trades"]["applicable"] is True
    assert j["totals"]["win_rate"] is None


def test_max_loss_flags_an_entry_after_the_limit():
    marks = [
        *long_trade(100.0, 94.0, 100, stop=None, opened=5, closed=8),  # -600
        *long_trade(100.0, 101.0, 100, stop=None, opened=12, closed=15, no=2, base=2),
    ]
    j = journal(marks, plan=Plan(max_loss_usd=500))
    check = next(c for c in j["adherence"]["checks"] if c["id"] == "max_loss")
    assert check["applicable"] and not check["passed"] and check["detail"] == "1 of 2"
    ok = journal(marks, plan=Plan(max_loss_usd=700))
    assert next(c for c in ok["adherence"]["checks"] if c["id"] == "max_loss")["passed"] is True


def test_max_trades_and_score_arithmetic():
    marks = [
        *long_trade(100.0, 101.0, 10, stop=99.0, opened=5, closed=8),
        *long_trade(100.0, 101.0, 10, stop=None, opened=10, closed=12, no=2, base=2),
    ]
    j = journal(marks, plan=Plan(stop_required=True, max_trades=1))
    checks = {c["id"]: c for c in j["adherence"]["checks"]}
    assert checks["stop_set"]["detail"] == "1 of 2" and checks["stop_set"]["passed"] is False
    assert checks["max_trades"]["detail"] == "2 of 1" and checks["max_trades"]["passed"] is False
    # applicable: stop_set, stop_honored (one trade has a stop), max_trades -> one passes of three
    assert j["adherence"]["score_pct"] == 33


def fire(bar_close_minute: float, close: float = 100.0, name: str = "ORB 15m") -> Fire:
    return Fire("alert_strategy", 7, name, "bullish", at(bar_close_minute - 5), at(bar_close_minute), close)


def test_on_signal_window_is_three_display_bars():
    marks = [
        *long_trade(100.0, 101.0, 10, stop=None, opened=12, closed=14),  # 2 min after the 10:00 close: on a signal
        *long_trade(100.0, 101.0, 10, stop=None, opened=40, closed=42, no=2, base=2),  # 30 min after: not
    ]
    j = journal(marks, fires=[fire(10)], plan=Plan(signal_only=True), display=5)
    assert [t["on_signal"] for t in j["trades"]] == [True, False]
    check = next(c for c in j["adherence"]["checks"] if c["id"] == "on_signal")
    assert check["detail"] == "1 of 2" and check["passed"] is False


def test_signals_versus_trades_fills_after_the_end_only():
    bars = flat_bars(100.0)
    bars.loc[bars.index >= at(24), "close"] = 101.0  # the bar that closes 15 minutes after the signal
    bars.loc[bars.index >= at(39), "close"] = 99.0  # the bar that closes 30 minutes after it
    marks = long_trade(100.0, 101.0, 10, stop=None, opened=12, closed=14)
    j = journal(marks, bars=bars, fires=[fire(10, 100.0), fire(50, 100.0, "VWAP reclaim")], final=True)
    first, late = j["signals_vs_trades"]
    assert first["her"] == "entered 2 min later"
    assert first["chg_15m_pct"] == 1.0 and first["chg_30m_pct"] == -1.0
    assert late["her"] == "no trade" and late["chg_30m_pct"] is None  # 30 minutes past the window end
    assert journal(marks, bars=bars, fires=[fire(10)], final=False)["signals_vs_trades"] == []


@pytest.mark.parametrize("kind", ["long_exit", "short_exit"])
def test_an_exit_with_no_open_trade_is_ignored(kind):
    j = journal([Mark(1, kind, at(5), 100.0)])
    assert j["totals"]["trades"] == 0
