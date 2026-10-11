import math
import statistics
from datetime import date
from typing import Any

import pandas as pd
import pytest
from bars import daily_bars, minute_bars, set_bar, trading_days

from ai_trading.contracts.strategy_spec_v1 import StrategySpecV1
from ai_trading.core.backtest import InstrumentSpec, SymbolBars, Trade, backtest, stats
from ai_trading.core.calendar import et, previous_session

LAST_DAY = date(2026, 11, 10)
DAY = date(2026, 10, 6)  # a plain trading day, for the intraday fixtures


def make_spec(limits: dict[str, Any] | None = None, size: dict[str, Any] | None = None) -> StrategySpecV1:
    """Buy when close breaks above 100: stop at the prior day's low (never referenced in `when`),
    target 2R, risk a fixed $300 unless `size` overrides it."""
    body: dict[str, Any] = {
        "schemaVersion": 1,
        "name": "Test breakout",
        "watch": {"universe": {"symbols": ["TEST"]}, "session": "regular", "runOn": "daily_close"},
        "when": {"op": "gt", "left": {"series": "close"}, "right": {"value": 100}},
        "then": {
            "alert": {"channels": ["inbox"]},
            "paperOrder": {
                "side": "buy",
                "size": size or {"riskUsd": 300},
                "stop": {"level": "prior_day_low"},
                "target": {"r": 2},
            },
        },
    }
    if limits is not None:
        body["limits"] = limits
    return StrategySpecV1.model_validate(body)


def make_bars(count: int) -> pd.DataFrame:
    """Flat bars (close 90, low 88) up to day 20, which closes at 101 (the signal). Day 21 opens
    gapped up at 103 (the fill) and holds; day 22 opens gapped down at 80, through the 88 stop.
    Every later day is flat again, so no further signal fires."""
    days = trading_days("stock", LAST_DAY, count)
    opens, highs, lows, closes = [90.0] * count, [92.0] * count, [88.0] * count, [90.0] * count
    closes[20], highs[20] = 101.0, 103.0
    opens[21], highs[21], lows[21], closes[21] = 103.0, 105.0, 101.0, 104.0
    opens[22], highs[22], lows[22], closes[22] = 80.0, 81.0, 78.0, 79.0
    data = {"open": opens, "high": highs, "low": lows, "close": closes, "volume": 1_000_000.0}
    return pd.DataFrame(data, index=pd.Index(days))


def flat_benchmark(frame: pd.DataFrame) -> pd.Series:
    return pd.Series(100.0, index=frame.index)


def _custom_bars(count: int, overrides: dict[int, tuple[float, float, float, float]]) -> pd.DataFrame:
    """Flat bars (open/high/low/close 90/92/88/90) with specific day positions overridden to
    (open, high, low, close)."""
    days = trading_days("stock", LAST_DAY, count)
    o, h, lo, c = [90.0] * count, [92.0] * count, [88.0] * count, [90.0] * count
    for day_index, (oo, hh, ll, cc) in overrides.items():
        o[day_index], h[day_index], lo[day_index], c[day_index] = oo, hh, ll, cc
    return pd.DataFrame({"open": o, "high": h, "low": lo, "close": c, "volume": 1.0}, index=pd.Index(days))


def run(count: int = 23, bars: pd.DataFrame | None = None, limits=None, instruments=None, benchmark=None):
    frame = bars if bars is not None else make_bars(count)
    bm = benchmark if benchmark is not None else flat_benchmark(frame)
    result = backtest(
        make_spec(limits),
        "stock",
        {"TEST": SymbolBars(bars_1d=frame)},
        benchmark=bm,
        instruments=instruments,
    )
    return result, frame


def test_signal_fills_at_the_next_bars_open_not_the_signal_bars_close():
    result, frame = run()
    [trade] = result.trades
    assert frame.loc[frame.index[20], "close"] == 101.0  # the signal bar's close...
    assert trade.entry_time == frame.index[21]
    assert trade.entry_price == pytest.approx(103.01)  # ...differs from the next bar's open + slippage
    assert trade.side == "buy" and trade.quantity == 20  # $300 risk / (103 - 88 stop) = 20


def test_a_gap_through_the_stop_fills_at_the_open_not_the_stop_level():
    result, frame = run()
    [trade] = result.trades
    assert trade.exit_time == frame.index[22]
    assert trade.exit_reason == "stop"
    assert trade.exit_price == pytest.approx(79.99)  # day 22 opens at 80, through the 88 stop
    assert trade.r == pytest.approx((79.99 - 103.01) / 15, abs=1e-6)
    assert trade.pnl == pytest.approx((79.99 - 103.01) * 20 - 20 * 0.005 * 2)


def test_paper_order_level_resolves_even_though_when_never_uses_it():
    # `when` only ever compares `close` to a constant; `prior_day_low` appears nowhere in it.
    when = make_spec().model_dump(by_alias=True, exclude_none=True)["when"]
    assert "level" not in when["left"] and "level" not in when["right"]
    result, _ = run()
    [trade] = result.trades
    assert trade.quantity == 20  # $300 risk / (103 entry - 88 prior-day-low stop), resolved directly


def test_mutating_bars_after_a_date_leaves_every_earlier_trade_identical():
    frame = make_bars(40)
    before, _ = run(bars=frame)
    [original] = before.trades

    mutated = frame.copy()
    mutated.loc[mutated.index[30:], ["open", "high", "low", "close"]] = [150.0, 155.0, 148.0, 152.0]
    after, _ = run(bars=mutated)

    assert after.trades[0] == original


def test_no_same_bar_reentry_when_an_old_stop_and_a_new_entry_share_a_bar():
    """The reviewer's case: a signal fires while a position is held (day 23, dropped on sight),
    and the held position itself later gaps through its stop (day 24). The dropped signal must
    not resurrect itself as a new entry just because the bar it would have filled on is also the
    bar the old position happens to exit on."""
    frame = _custom_bars(
        26,
        {
            20: (90.0, 103.0, 88.0, 101.0),  # the original signal
            21: (103.0, 105.0, 101.0, 104.0),  # the original entry fill, holds
            22: (104.0, 105.0, 95.0, 95.0),  # dips back below 100: resets the edge
            23: (96.0, 103.0, 95.0, 102.0),  # crosses back above 100 while still holding: dropped
            24: (50.0, 55.0, 45.0, 48.0),  # the original position gaps through its stop
        },
    )
    result, _ = run(bars=frame)
    assert len(result.trades) == 1  # the day-23 signal never became a second entry
    [trade] = result.trades
    assert trade.entry_time == frame.index[21]
    assert trade.exit_time == frame.index[24]
    assert trade.exit_reason == "stop"


def test_a_signal_while_holding_a_position_is_dropped():
    frame = _custom_bars(
        28,
        {
            20: (90.0, 103.0, 88.0, 101.0),
            21: (103.0, 105.0, 101.0, 104.0),  # entry fill, holds
            22: (104.0, 105.0, 95.0, 95.0),  # dips back below 100: resets the edge
            23: (96.0, 103.0, 95.0, 102.0),  # crosses back above 100 while still holding: dropped
            24: (100.0, 102.0, 95.0, 100.0),
            25: (100.0, 102.0, 95.0, 100.0),
            26: (100.0, 102.0, 95.0, 100.0),
            27: (100.0, 102.0, 95.0, 100.0),
        },
    )
    result, _ = run(bars=frame)
    assert len(result.trades) == 1  # the day-23 signal, fired while still holding, never entered
    [trade] = result.trades
    assert trade.entry_time == frame.index[21]
    assert trade.exit_reason == "end_of_data"


def test_stop_checked_before_target_when_a_bar_touches_both():
    frame = _custom_bars(
        24,
        {
            20: (90.0, 103.0, 88.0, 101.0),
            21: (103.0, 105.0, 101.0, 104.0),  # entry fill, holds
            22: (103.0, 140.0, 80.0, 110.0),  # no gap at the open; touches stop and target intrabar
        },
    )
    result, _ = run(bars=frame)
    [trade] = result.trades
    assert trade.exit_time == frame.index[22]
    assert trade.exit_reason == "stop"
    assert trade.exit_price == pytest.approx(87.99)  # the 88 stop level minus slippage, not the target


def _open_time_sizing_fixture() -> tuple[pd.DataFrame, pd.DataFrame]:
    """A breaks out on day 20 and keeps rising; on day 26 it opens still well inside its stop and
    target, but touches its stop intrabar and exits there. B's signal (day 25) queues its entry
    for day 26's open too, sized with `pctOfBook` alongside A."""
    frame_a = _custom_bars(
        30,
        {
            20: (90.0, 103.0, 88.0, 101.0),
            21: (103.0, 105.0, 101.0, 104.0),
            22: (104.0, 106.0, 103.0, 105.0),
            23: (105.0, 107.0, 104.0, 106.0),
            24: (106.0, 108.0, 105.0, 107.0),
            25: (107.0, 112.0, 106.0, 110.0),
            26: (120.0, 121.0, 88.0, 90.0),  # open 120, still well clear; touches the 88 stop intrabar
        },
    )
    frame_b = _custom_bars(
        30,
        {
            25: (90.0, 103.0, 88.0, 101.0),
            26: (103.0, 105.0, 101.0, 104.0),
        },
    )
    return frame_a, frame_b


def test_sizing_uses_open_time_equity_not_a_later_exit_in_the_same_bar():
    frame_a, frame_b = _open_time_sizing_fixture()
    spec = make_spec(size={"pctOfBook": 50})
    result = backtest(
        spec,
        "stock",
        {"A": SymbolBars(bars_1d=frame_a), "B": SymbolBars(bars_1d=frame_b)},
        benchmark=flat_benchmark(frame_a),
    )
    by_symbol = {t.symbol: t for t in result.trades}
    assert by_symbol["A"].exit_time == frame_a.index[26]
    assert by_symbol["A"].exit_reason == "stop"  # A is still open at this bar's open, exits intrabar
    # B is sized from cash plus A's unrealized gain marked at THIS bar's *open* (120), not A's
    # exit later in the same bar: 99,997.575 + (120 - 103.01) x 485 = 108,237.725; 50% of that
    # over $103 floors to 525 — not the 485 cash alone would give, nor the 450 A's post-exit
    # cash would give.
    assert by_symbol["B"].quantity == 525


def test_two_symbols_trade_independently_off_one_shared_equity():
    frame = make_bars(23)
    bm = flat_benchmark(frame)
    result = backtest(
        make_spec(), "stock", {"TEST": SymbolBars(bars_1d=frame), "OTHER": SymbolBars(bars_1d=frame)}, benchmark=bm
    )
    assert {t.symbol for t in result.trades} == {"TEST", "OTHER"}
    assert len(result.trades) == 2
    assert result.trades[0].pnl == result.trades[1].pnl  # identical bars, identical fills


def test_symbols_on_different_calendars_are_rejected():
    frame = make_bars(23)
    bm = flat_benchmark(frame)
    with pytest.raises(ValueError, match="share one index"):
        backtest(
            make_spec(),
            "stock",
            {"TEST": SymbolBars(bars_1d=frame), "OTHER": SymbolBars(bars_1d=frame.iloc[1:])},
            benchmark=bm,
        )


def test_no_paper_order_is_a_clear_error():
    spec = make_spec().model_copy(update={"then": make_spec().then.model_copy(update={"paperOrder": None})})
    frame = make_bars(23)
    with pytest.raises(ValueError, match="paperOrder"):
        backtest(spec, "stock", {"TEST": SymbolBars(bars_1d=frame)}, benchmark=flat_benchmark(frame))


def test_benchmark_return_is_buy_and_hold_over_the_same_period():
    frame = make_bars(23)
    bm = pd.Series([100.0 + i for i in range(len(frame))], index=frame.index)
    result, _ = run(bars=frame, benchmark=bm)
    expected = (bm.iloc[-1] / bm.iloc[0] - 1) * 100
    assert result.stats.benchmark_return_pct == pytest.approx(expected)


def test_two_instruments_use_their_own_multiplier_tick_size_and_commission():
    frame = make_bars(23)
    bm = flat_benchmark(frame)
    instruments = {"FUT": InstrumentSpec(multiplier=5.0, tick_size=0.25, commission_per_unit=2.50)}
    result = backtest(
        make_spec(),
        "stock",
        {"TEST": SymbolBars(bars_1d=frame), "FUT": SymbolBars(bars_1d=frame)},
        benchmark=bm,
        instruments=instruments,
    )
    by_symbol = {t.symbol: t for t in result.trades}
    assert by_symbol["TEST"].quantity == 20  # default stock spec: $300 / (15 risk x 1 multiplier)
    assert by_symbol["TEST"].entry_price == pytest.approx(103.01)  # 1-cent tick slippage
    assert by_symbol["TEST"].exit_price == pytest.approx(79.99)
    # TEST's default $0.005/share commission, both legs.
    assert by_symbol["TEST"].pnl == pytest.approx((79.99 - 103.01) * 20 - 20 * 0.005 * 2)
    assert by_symbol["FUT"].quantity == 4  # $300 / (15 risk x 5 multiplier)
    assert by_symbol["FUT"].entry_price == pytest.approx(103.25)  # quarter-point tick slippage
    assert by_symbol["FUT"].exit_price == pytest.approx(79.75)
    # FUT's $2.50/contract commission and 5x multiplier, both legs.
    assert by_symbol["FUT"].pnl == pytest.approx((79.75 - 103.25) * 4 * 5 - 4 * 2.50 * 2)


def _marking_fixture() -> tuple[pd.DataFrame, pd.DataFrame]:
    """Symbol A breaks out on day 20 and keeps rising, so it has a large open unrealized gain by
    the time symbol B breaks out on day 25 and is sized with `pctOfBook`."""
    count = 30
    days = trading_days("stock", LAST_DAY, count)

    def flat() -> tuple[list[float], list[float], list[float], list[float]]:
        return [90.0] * count, [92.0] * count, [88.0] * count, [90.0] * count

    a_o, a_h, a_l, a_c = flat()
    a_c[20], a_h[20] = 101.0, 103.0
    for i, (o, h, lo, c) in enumerate(
        [(103, 105, 101, 104), (104, 106, 103, 105), (105, 107, 104, 106), (106, 108, 105, 107), (107, 112, 106, 110)]
    ):
        a_o[21 + i], a_h[21 + i], a_l[21 + i], a_c[21 + i] = o, h, lo, c
    for i in range(26, count):
        a_o[i], a_h[i], a_l[i], a_c[i] = 110.0, 112.0, 108.0, 110.0
    frame_a = pd.DataFrame({"open": a_o, "high": a_h, "low": a_l, "close": a_c, "volume": 1.0}, index=pd.Index(days))

    b_o, b_h, b_l, b_c = flat()
    b_c[25], b_h[25] = 101.0, 103.0
    b_o[26], b_h[26], b_l[26], b_c[26] = 103.0, 105.0, 101.0, 104.0
    for i in range(27, count):
        b_o[i], b_h[i], b_l[i], b_c[i] = 104.0, 106.0, 102.0, 104.0
    frame_b = pd.DataFrame({"open": b_o, "high": b_h, "low": b_l, "close": b_c, "volume": 1.0}, index=pd.Index(days))
    return frame_a, frame_b


def test_pct_of_book_sizing_uses_marked_to_market_equity_not_cash_alone():
    frame_a, frame_b = _marking_fixture()
    spec = make_spec(size={"pctOfBook": 50})
    result = backtest(
        spec,
        "stock",
        {"A": SymbolBars(bars_1d=frame_a), "B": SymbolBars(bars_1d=frame_b)},
        benchmark=flat_benchmark(frame_a),
    )
    by_symbol = {t.symbol: t for t in result.trades}
    assert by_symbol["A"].quantity == 485  # 50% of the $100,000 starting cash, entry $103
    # B is sized off cash *plus* A's ~$3,390 unrealized gain, marked at B's own signal bar's close,
    # not cash alone (which would give 485 again).
    assert by_symbol["B"].quantity == 501


def test_max_drawdown_counts_from_starting_equity_as_the_initial_peak():
    curve = pd.Series([8_000.0], index=pd.Index([date(2026, 1, 1)]))
    result = stats([], curve, 10_000.0, pd.Series(100.0, index=curve.index))
    assert result.max_drawdown_pct == pytest.approx(20.0)  # the first mark is already a 20% loss


def test_sharpe_annualizes_by_frequency():
    dates = [date(2026, 1, 9), date(2026, 1, 16), date(2026, 1, 23), date(2026, 1, 30)]  # 4 distinct ISO weeks
    curve = pd.Series([10_000.0, 11_000.0, 9_900.0, 10_890.0], index=pd.Index(dates))
    benchmark = pd.Series(100.0, index=curve.index)
    daily_result = stats([], curve, 10_000.0, benchmark, frequency="daily")
    weekly_result = stats([], curve, 10_000.0, benchmark, frequency="weekly")

    returns = [0.10, -0.10, 0.10]
    mean, stdev = statistics.mean(returns), statistics.stdev(returns)
    assert daily_result.sharpe == pytest.approx(mean / stdev * math.sqrt(252))
    assert weekly_result.sharpe == pytest.approx(mean / stdev * math.sqrt(52))
    assert daily_result.sharpe != pytest.approx(weekly_result.sharpe)


def test_sharpe_aggregates_intraday_equity_to_daily_first():
    idx = pd.DatetimeIndex(
        [
            et(date(2026, 1, 5), "10:00"),
            et(date(2026, 1, 5), "15:00"),
            et(date(2026, 1, 6), "10:00"),
            et(date(2026, 1, 6), "15:00"),
            et(date(2026, 1, 7), "10:00"),
            et(date(2026, 1, 7), "15:00"),
        ]
    )
    curve = pd.Series([10_500.0, 10_000.0, 10_600.0, 11_000.0, 10_200.0, 9_900.0], index=idx)
    result = stats([], curve, 10_000.0, pd.Series(100.0, index=idx))

    daily_values = [10_000.0, 11_000.0, 9_900.0]  # each day's last intraday mark
    returns = [daily_values[1] / daily_values[0] - 1, daily_values[2] / daily_values[1] - 1]
    expected = statistics.mean(returns) / statistics.stdev(returns) * math.sqrt(252)
    assert result.sharpe == pytest.approx(expected)


def test_max_open_positions_blocks_a_second_simultaneous_entry():
    frame = make_bars(23)
    spec = make_spec(limits={"maxOpenPositions": 1})
    result = backtest(
        spec,
        "stock",
        {"S1": SymbolBars(bars_1d=frame), "S2": SymbolBars(bars_1d=frame)},
        benchmark=flat_benchmark(frame),
    )
    assert {t.symbol for t in result.trades} == {"S1"}  # S2's simultaneous entry is dropped, not deferred


def test_max_trades_per_day_blocks_a_second_entry_the_same_day():
    frame = make_bars(23)
    spec = make_spec(limits={"maxTradesPerDay": 1})
    result = backtest(
        spec,
        "stock",
        {"S1": SymbolBars(bars_1d=frame), "S2": SymbolBars(bars_1d=frame)},
        benchmark=flat_benchmark(frame),
    )
    assert {t.symbol for t in result.trades} == {"S1"}


def _pause_fixture() -> tuple[pd.DataFrame, pd.DataFrame]:
    """S1 enters cleanly on day 21 and gaps through its stop at day 22's open (known at that
    open, before any new entry is considered); S2's signal fires a day later than S1's so its
    entry is also queued for day 22's open, and would otherwise fill cleanly."""
    count = 23
    days = trading_days("stock", LAST_DAY, count)
    o, h, lo, c = [90.0] * count, [92.0] * count, [88.0] * count, [90.0] * count
    c[20], h[20] = 101.0, 103.0  # S1's signal
    o[21], h[21], lo[21], c[21] = 103.0, 105.0, 101.0, 104.0  # a normal, clean entry
    o[22], h[22], lo[22], c[22] = 50.0, 55.0, 45.0, 48.0  # gaps through the 88 stop at the open
    s1 = pd.DataFrame({"open": o, "high": h, "low": lo, "close": c, "volume": 1.0}, index=pd.Index(days))

    o2, h2, lo2, c2 = [90.0] * count, [92.0] * count, [88.0] * count, [90.0] * count
    c2[21], h2[21] = 101.0, 103.0  # S2's signal, one day after S1's
    o2[22], h2[22], lo2[22], c2[22] = 103.0, 105.0, 101.0, 104.0  # a normal, clean entry
    s2 = pd.DataFrame({"open": o2, "high": h2, "low": lo2, "close": c2, "volume": 1.0}, index=pd.Index(days))
    return s1, s2


def test_pause_after_daily_loss_blocks_a_later_entry_the_same_day():
    s1, s2 = _pause_fixture()
    spec = make_spec(limits={"pauseAfterDailyLossUsd": 300})
    result = backtest(
        spec, "stock", {"S1": SymbolBars(bars_1d=s1), "S2": SymbolBars(bars_1d=s2)}, benchmark=flat_benchmark(s1)
    )
    by_symbol = {t.symbol: t for t in result.trades}
    assert by_symbol["S1"].pnl == pytest.approx(-1060.6)  # the gap-stop realized at day 22's open
    assert "S2" not in by_symbol  # S1's loss, known at that same open, already breached the pause


def _intraday_spec(limits: dict[str, Any], target_r: float = 2.0) -> StrategySpecV1:
    return StrategySpecV1.model_validate(
        {
            "schemaVersion": 1,
            "name": "Intraday limits test",
            "watch": {"universe": {"symbols": ["TEST"]}, "session": "regular", "runOn": "bar_close_1m"},
            "when": {"op": "crosses_above", "left": {"series": "close"}, "right": {"value": 100}},
            "limits": limits,
            "then": {
                "alert": {"channels": ["inbox"]},
                "paperOrder": {
                    "side": "buy",
                    "size": {"riskUsd": 50},
                    "stop": {"level": "prior_day_low"},
                    "target": {"r": target_r},
                },
            },
        }
    )


def _hold(bars: pd.DataFrame, day: date, start: str, end: str, value: float) -> None:
    for at in pd.date_range(et(day, start), et(day, end), freq="1min", inclusive="left"):
        bars.loc[at, ["open", "high", "low", "close"]] = value


def test_cooldown_blocks_a_quick_reentry_in_the_same_symbol():
    bars = minute_bars("stock", DAY)
    set_bar(bars, DAY, "10:00", close=101.0)
    set_bar(bars, DAY, "10:01", open=103.0, high=103.0, low=50.0, close=60.0)  # entry, same-bar stop-out
    set_bar(bars, DAY, "10:02", close=90.0)
    set_bar(bars, DAY, "10:05", close=101.0)  # 4 minutes after the exit: inside a 10-minute cooldown
    set_bar(bars, DAY, "10:06", open=103.0, high=105.0, low=101.0, close=104.0)  # would-be entry
    set_bar(bars, DAY, "10:07", close=90.0)
    set_bar(bars, DAY, "10:15", close=101.0)  # 14 minutes after the exit: outside the cooldown
    set_bar(bars, DAY, "10:16", open=103.0, high=105.0, low=101.0, close=104.0)

    daily = daily_bars([previous_session("stock", DAY)], [90.0])
    spec = _intraday_spec({"cooldownMinutes": 10})
    result = backtest(
        spec, "stock", {"TEST": SymbolBars(bars_1d=daily, bars_1m=bars)}, benchmark=pd.Series(100.0, index=bars.index)
    )
    assert len(result.trades) == 2  # the 10:05 signal's entry is blocked; 10:00 and 10:15 fill
    assert [t.entry_time for t in result.trades] == [et(DAY, "10:01"), et(DAY, "10:16")]


def test_flat_by_forces_an_intraday_exit_at_the_close_of_the_bar_ending_at_it():
    # Bars are labeled by their start, so "flat by 11:00" fires on the 10:59 bar (it ends at
    # 11:00), not the 11:00 bar (which only ends at 11:01).
    bars = minute_bars("stock", DAY)
    set_bar(bars, DAY, "10:00", close=101.0)
    set_bar(bars, DAY, "10:01", open=103.0, high=105.0, low=101.0, close=104.0)
    _hold(bars, DAY, "10:02", "10:59", 104.0)  # stays well inside the stop/target band until flatBy
    set_bar(bars, DAY, "10:59", open=104.0, high=106.0, low=103.0, close=107.0)
    set_bar(bars, DAY, "11:00", open=107.0, high=109.0, low=105.0, close=108.0)  # never reached

    daily = daily_bars([previous_session("stock", DAY)], [90.0])
    spec = _intraday_spec({"flatBy": "11:00"}, target_r=5.0)
    result = backtest(
        spec, "stock", {"TEST": SymbolBars(bars_1d=daily, bars_1m=bars)}, benchmark=pd.Series(100.0, index=bars.index)
    )
    [trade] = result.trades
    assert trade.exit_reason == "time"
    assert trade.exit_time == et(DAY, "11:00")  # the 10:59 bar's end, not its 10:59 start
    assert trade.exit_price == pytest.approx(106.99)  # the 10:59 bar's close (minus slippage)


def test_flat_by_uses_the_first_later_bar_when_its_own_bar_is_missing():
    # The 10:59 bar (which would end exactly at 11:00) is missing; the next bar present is 11:00,
    # which ends at 11:01, so the exit happens there, with its own real end time.
    bars = minute_bars("stock", DAY)
    set_bar(bars, DAY, "10:00", close=101.0)
    set_bar(bars, DAY, "10:01", open=103.0, high=105.0, low=101.0, close=104.0)
    _hold(bars, DAY, "10:02", "10:59", 104.0)
    set_bar(bars, DAY, "11:00", open=104.0, high=106.0, low=103.0, close=108.0)
    bars = bars.drop(index=et(DAY, "10:59"))

    daily = daily_bars([previous_session("stock", DAY)], [90.0])
    spec = _intraday_spec({"flatBy": "11:00"}, target_r=5.0)
    result = backtest(
        spec, "stock", {"TEST": SymbolBars(bars_1d=daily, bars_1m=bars)}, benchmark=pd.Series(100.0, index=bars.index)
    )
    [trade] = result.trades
    assert trade.exit_reason == "time"
    assert trade.exit_time == et(DAY, "11:01")  # the 11:00 bar's own end
    assert trade.exit_price == pytest.approx(107.99)  # the 11:00 bar's close (minus slippage)


def test_flat_by_does_not_apply_to_daily_bars():
    frame = make_bars(23)  # the day-21 entry still exits via the day-22 gap-stop, not a time exit
    spec = make_spec(limits={"flatBy": "12:00"})
    result = backtest(spec, "stock", {"TEST": SymbolBars(bars_1d=frame)}, benchmark=flat_benchmark(frame))
    [trade] = result.trades
    assert trade.exit_reason == "stop"


EQUITY_DATES = [date(2025, 12, 30), date(2025, 12, 31), date(2026, 1, 2), date(2026, 1, 3)]
EQUITY_VALUES = [10_000.0, 11_000.0, 9_900.0, 10_890.0]  # +10%, -10%, +10%


def equity_curve() -> pd.Series:
    return pd.Series(EQUITY_VALUES, index=pd.Index(EQUITY_DATES))


def trade(entry: int, exit_: int, r: float, pnl: float, quantity: int = 10) -> Trade:
    d = EQUITY_DATES
    return Trade("TEST", "buy", d[entry], 100.0, d[exit_], 100.0, quantity, r, "target" if r > 0 else "stop", pnl)


def test_statistics_on_a_hand_computed_trade_list():
    trades = [
        trade(0, 0, -1.0, -100.0),
        trade(0, 1, -2.0, -200.0),
        trade(1, 2, 0.0, 0.0),
        trade(1, 2, 3.0, 300.0),
        trade(2, 3, -0.5, -50.0),
    ]
    benchmark = pd.Series(
        {date(2025, 12, 30): 100.0, date(2025, 12, 31): 101.0, date(2026, 1, 2): 102.0, date(2026, 1, 3): 103.0}
    )
    result = stats(trades, equity_curve(), 10_000.0, benchmark, bars_in_position=6, total_bars=20)

    assert result.trades == 5
    assert result.total_return_pct == pytest.approx(8.9)
    assert result.max_drawdown_pct == pytest.approx(10.0)
    assert result.win_rate_pct == pytest.approx(20.0)  # 1 win of 5 trades (the breakeven counts, not as a win)
    assert result.avg_win_r == pytest.approx(3.0)
    assert result.avg_loss_r == pytest.approx(-3.5 / 3)
    assert result.expectancy_r == pytest.approx(-0.1)
    assert result.profit_factor == pytest.approx(300.0 / 350.0)
    assert result.avg_hold_bars == pytest.approx(1.8)
    assert result.exposure_pct == pytest.approx(30.0)
    assert result.longest_losing_streak == 2  # the first two trades, back to back
    assert result.returns_by_year == pytest.approx({2025: 10.0, 2026: -1.0})
    assert result.benchmark_return_pct == pytest.approx(3.0)

    daily_returns = [0.10, -0.10, 0.10]
    expected_sharpe = statistics.mean(daily_returns) / statistics.stdev(daily_returns) * math.sqrt(252)
    assert result.sharpe == pytest.approx(expected_sharpe)

    days = (EQUITY_DATES[-1] - EQUITY_DATES[0]).days
    expected_cagr = ((10_890.0 / 10_000.0) ** (365.25 / days) - 1) * 100
    assert result.cagr_pct == pytest.approx(expected_cagr)


def test_stats_of_an_empty_trade_list_is_all_unknown():
    curve = pd.Series([10_000.0], index=pd.Index([date(2026, 1, 1)]))
    result = stats([], curve, 10_000.0, pd.Series(100.0, index=curve.index))
    assert result.trades == 0
    assert math.isnan(result.win_rate_pct)
    assert math.isnan(result.sharpe)
    assert result.total_return_pct == pytest.approx(0.0)
