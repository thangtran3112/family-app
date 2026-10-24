"""The screener evaluator (02m §b1): match semantics, `matched_since`, no-data, the liquidity floor, ranking
and the cap, intraday cadences, the preview deadline, and the engine helpers it leans on."""

import copy
import time
from datetime import date

import pandas as pd
from bars import daily_bars, minute_bars, set_bar, trading_days

from ai_trading.contracts.strategy_spec_v1 import FilterStrategySpecV1
from ai_trading.core import evaluate as engine
from ai_trading.core.calendar import et, session
from ai_trading.library.catalog import load_catalog, load_template
from ai_trading.screener.evaluator import SymbolBars, check_filter, passes_liquidity, scan

LAST = date(2026, 10, 6)  # a regular session
PREVIOUS = date(2026, 10, 5)
AS_OF = session("stock", LAST).regular_close


def _spec(**changes) -> dict:
    spec = {
        "schemaVersion": 1,
        "name": "Test filter",
        "watch": {"universe": {"market": "us_equities"}, "session": "regular", "runOn": "daily_close"},
        "when": {"op": "gt", "left": {"series": "close"}, "right": {"value": 100}},
        "maxResults": 50,
    }
    spec.update(changes)
    return FilterStrategySpecV1.model_validate(spec).model_dump(mode="json", by_alias=True, exclude_none=True)


def _daily(closes: list[float], volume: float = 1_000_000) -> pd.DataFrame:
    return daily_bars(trading_days("stock", LAST, len(closes)), closes, volume=volume)


def test_every_seed_filter_passes_the_gate():
    for entry in load_catalog().entries:
        if entry.kind == "filter":
            raw = FilterStrategySpecV1.model_validate(load_template(entry.file))
            assert check_filter(raw.model_dump(mode="json", by_alias=True, exclude_none=True)) == [], entry.id


def test_the_gate_names_operands_the_cadence_cannot_compute_and_features_nothing_runs_yet():
    vwap = _spec(when={"op": "gt", "left": {"series": "close"}, "right": {"series": "vwap"}})
    assert check_filter(vwap) == ["vwap needs intraday bars; daily_close uses daily bars"]
    ranked = _spec(rank={"by": {"series": "vwap"}, "order": "desc"})
    assert any("vwap" in p for p in check_filter(ranked))
    premarket = _spec(
        watch={"universe": {"market": "us_equities"}, "session": "extended", "runOn": "premarket_0830"},
        when={"op": "gt", "left": {"series": "close"}, "right": {"series": "vwap"}},
    )
    assert check_filter(premarket) == ["vwap is not known at 08:30 ET"]
    clock = _spec(when={"op": "time_between", "start": "09:30", "end": "10:00"})
    assert check_filter(clock) == ["time_between needs intraday bars; daily_close uses daily bars"]
    pattern = _spec(when={"op": "pattern", "pattern": "hammer"})
    assert check_filter(pattern) == ["the pattern condition is not supported by the screener yet"]
    session_high = _spec(
        watch={"universe": {"market": "us_equities"}, "session": "regular", "runOn": "bar_close_5m"},
        when={"op": "gt", "left": {"series": "close"}, "right": {"level": "session_high"}},
    )
    assert check_filter(session_high) == ["session_high is not supported by the screener yet"]


def test_the_engine_helpers_the_evaluator_leans_on_still_exist():
    for name in ("_Frame", "_condition", "_points", "_resample", "_operands", "_nodes", "_series", "label"):
        assert hasattr(engine, name), name
    for name in ("CADENCE_MINUTES", "INTRADAY_CADENCES", "_SESSION_LEVELS", "_OPENING_LEVELS", "_UNSUPPORTED_LEVELS"):
        assert hasattr(engine, name), name


def test_liquidity_reads_the_last_close_and_the_mean_volume_of_the_window():
    daily = _daily([10.0] * 30, volume=600_000)
    assert passes_liquidity(daily, None)
    assert passes_liquidity(daily, {"minPrice": 5, "minAvgVolume": 500_000})
    assert not passes_liquidity(daily, {"minPrice": 11})
    assert not passes_liquidity(daily, {"minAvgVolume": 700_000})
    assert not passes_liquidity(daily.iloc[0:0], {"minPrice": 1})
    recent_surge = daily.copy()
    recent_surge.iloc[-5:, recent_surge.columns.get_loc("volume")] = 10_000_000
    assert passes_liquidity(recent_surge, {"minAvgVolume": 3_000_000, "avgVolumeDays": 5})
    assert not passes_liquidity(recent_surge, {"minAvgVolume": 3_000_000, "avgVolumeDays": 20})


def test_a_symbol_matches_when_the_condition_is_true_at_its_last_point():
    data = {
        "UP": SymbolBars(_daily([99.0, 99.5, 101.0, 102.0])),
        "DOWN": SymbolBars(_daily([101.0, 102.0, 99.0, 98.0])),
    }
    result = scan(_spec(), data, AS_OF)
    assert [m.symbol for m in result.matches] == ["UP"]
    assert (result.scanned, result.no_data, result.matches_total) == (2, 0, 1)
    assert result.evaluation_point == AS_OF


def test_matched_since_is_the_start_of_the_unbroken_run_of_true_points():
    bars = _daily([99.0, 101.0, 99.0, 101.0, 102.0, 103.0])
    (match,) = scan(_spec(), {"RUN": SymbolBars(bars)}, AS_OF).matches
    days = list(bars.index)
    assert match.matched_since == session("stock", days[3]).regular_close  # the break at 99 resets the run
    assert match.evaluation_point == AS_OF


def test_operand_values_are_reported_for_the_last_point_and_the_rank_value_rounds_to_six_places():
    spec = _spec(rank={"by": {"series": "volume"}, "order": "desc"})
    (match,) = scan(spec, {"A": SymbolBars(_daily([99.0, 105.0], volume=1_234_567.891))}, AS_OF).matches
    assert match.operands == {"close": 105.0}
    assert match.rank_value == 1234567.891


def test_ranking_order_ties_and_the_cap():
    volumes = {"AAA": 1_000_000, "BBB": 3_000_000, "CCC": 3_000_000, "DDD": 2_000_000}
    data = {s: SymbolBars(_daily([99.0, 105.0], volume=v)) for s, v in volumes.items()}
    descending = scan(_spec(rank={"by": {"series": "volume"}, "order": "desc"}, maxResults=3), data, AS_OF)
    assert [m.symbol for m in descending.matches] == ["BBB", "CCC", "DDD"]  # the tie breaks by symbol
    assert descending.matches_total == 4
    ascending = scan(_spec(rank={"by": {"series": "volume"}, "order": "asc"}), data, AS_OF)
    assert [m.symbol for m in ascending.matches] == ["AAA", "DDD", "BBB", "CCC"]
    unranked = scan(_spec(), data, AS_OF)
    assert [m.symbol for m in unranked.matches] == ["AAA", "BBB", "CCC", "DDD"]
    assert all(m.rank_value is None for m in unranked.matches)


def test_a_symbol_without_the_newest_day_is_no_data_and_one_below_the_floor_is_not_scanned_at_all():
    stale = _daily([99.0, 105.0]).iloc[:-1]  # no bar on the newest day
    data = {
        "FRESH": SymbolBars(_daily([99.0, 105.0])),
        "STALE": SymbolBars(stale),
        "PENNY": SymbolBars(_daily([1.0, 2.0])),
        "EMPTY": SymbolBars(_daily([1.0]).iloc[0:0]),
    }
    result = scan(_spec(liquidity={"minPrice": 5}), data, AS_OF)
    assert (result.scanned, result.no_data) == (1, 1)  # PENNY and EMPTY fail the floor and vanish
    assert result.evaluation_point == AS_OF


def test_a_bar_that_has_not_closed_by_as_of_is_not_read():
    data = {"A": SymbolBars(_daily([99.0, 105.0]))}
    before_close = AS_OF - pd.Timedelta(minutes=1)
    result = scan(_spec(), data, before_close)
    assert result.evaluation_point == session("stock", PREVIOUS).regular_close
    assert result.matches_total == 0  # the 105 close is the unclosed LAST bar; PREVIOUS closed at 99


def _minutes(price: float = 100.0) -> pd.DataFrame:
    return minute_bars("stock", LAST, price=price)


def test_an_intraday_cadence_needs_minutes_and_counts_from_the_start_of_the_day():
    spec = _spec(
        watch={"universe": {"market": "us_equities"}, "session": "regular", "runOn": "bar_close_15m"},
        when={"op": "gt", "left": {"series": "close"}, "right": {"value": 101}},
    )
    minutes = _minutes()
    for hhmm in ("10:00", "10:01", "10:14", "10:15", "10:29"):
        set_bar(minutes, LAST, hhmm, close=105.0)
    yesterday = minute_bars("stock", PREVIOUS, price=105.0)  # true all of yesterday too
    both = pd.concat([yesterday, minutes])
    as_of = et(LAST, "10:30")
    data = {
        "RUN": SymbolBars(_daily([100.0] * 25), both),
        "NOMIN": SymbolBars(_daily([100.0] * 25), None),
    }
    result = scan(spec, data, as_of)
    assert (result.scanned, result.no_data, result.matches_total) == (1, 1, 1)
    (match,) = result.matches
    assert match.evaluation_point == et(LAST, "10:15")  # the bar that started 10:15 closed at 10:30
    assert match.matched_since == et(LAST, "10:00")  # yesterday's run does not count
    assert match.operands == {"close": 105.0}


def test_the_preview_deadline_stops_the_scan_and_says_so():
    data = {f"S{i}": SymbolBars(_daily([99.0, 105.0])) for i in range(5)}
    result = scan(_spec(), data, AS_OF, deadline=time.monotonic() - 1)
    assert result.truncated is True
    assert result.scanned == 0 and result.matches == []


def test_one_symbols_bad_bars_read_as_no_data_without_failing_the_pass():
    broken = _daily([99.0, 105.0]).drop(columns=["close"])
    data = {"BAD": SymbolBars(broken), "GOOD": SymbolBars(_daily([99.0, 105.0]))}
    result = scan(_spec(), data, AS_OF)
    assert [m.symbol for m in result.matches] == ["GOOD"]
    assert result.no_data >= 1


def test_the_spec_is_not_changed_by_a_scan():
    spec = _spec()
    before = copy.deepcopy(spec)
    scan(spec, {"A": SymbolBars(_daily([99.0, 105.0]))}, AS_OF)
    assert spec == before
