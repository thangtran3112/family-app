"""The as-of screen (02o-b v1, `replay/screen.py`): the share-basis rebase, the one cut, the list price, the lag
constant, the lookback, and the union. Synthetic bars on the real calendar; no database, no network.

The leak tests are the point: `metric_row` synthesizes a partial "today" from whatever minutes it is handed, so
the same cut object must feed it and the scan, and no field of a list built at 08:30 may know anything after 08:15.
"""

from datetime import date

import pandas as pd
import pytest
from bars import daily_bars, minute_bars, set_bar, trading_days

from ai_trading.contracts.strategy_spec_v1 import FilterStrategySpecV1
from ai_trading.core.calendar import et, previous_session, session
from ai_trading.data.metrics import metric_row
from ai_trading.library.catalog import load_template
from ai_trading.replay import data as replay_data
from ai_trading.replay import screen
from ai_trading.replay.screen import (
    LIST_DATA_LAG,
    FilterInput,
    build_list,
    cut_frames,
    list_sessions,
    rebase_split,
)
from ai_trading.screener.evaluator import SymbolBars

DAY = date(2026, 9, 25)  # a Friday session
PRIOR = previous_session("stock", DAY)


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


def _template(name: str) -> dict:
    raw = FilterStrategySpecV1.model_validate(load_template(f"filters/{name}.json"))
    return raw.model_dump(mode="json", by_alias=True, exclude_none=True)


GAP_UP = _template("gap-up")


def _flag(name: str, spec: dict, symbols: list[str], fid: int = 1) -> FilterInput:
    return FilterInput(id=fid, version_id=fid * 10, name=name, spec=spec, symbols=symbols)


def _minutes(price: float, *, day_price: float | None = None, premarket: float | None = None) -> pd.DataFrame:
    """Prior sessions flat at `price` (1,000 a minute); `DAY` premarket at `premarket`, then (after 08:15, the
    leak canary) a wildly different regular session at `day_price` on 9x the volume."""
    sessions = list_sessions(DAY)
    frames = [minute_bars("stock", d, price=price, volume=1_000) for d in sessions[:-1]]
    today = minute_bars("stock", DAY, price=premarket or price, volume=5_000 if premarket else 1_000)
    if day_price is not None:
        regular = (today.index >= et(DAY, "09:30")) & (today.index < et(DAY, "16:00"))
        for column in ("open", "high", "low", "close"):
            today.loc[regular, column] = day_price
        today.loc[regular, "volume"] = 9_000.0
        set_bar(today, DAY, "15:59", close=day_price * 1.1)  # the day closes off its VWAP
        late = today.index >= et(DAY, "08:15")  # everything after the cut gets a loud, different value
        today.loc[late & ~regular, ["open", "high", "low", "close"]] = (premarket or price) * 1.2
    return pd.concat([*frames, today])


def _daily(price: float, volume: float = 2_000_000, count: int = 60) -> pd.DataFrame:
    return daily_bars(trading_days("stock", PRIOR, count), [price] * count, volume=volume)


@pytest.fixture
def world() -> dict[str, dict]:
    """GAPPER gaps +6% premarket on 5x the volume; FLAT does nothing; THIN is a $3 stock; NEWIPO has one daily bar."""
    return {
        "GAPPER": {"daily": _daily(100.0), "minutes": _minutes(100.0, premarket=106.0, day_price=130.0)},
        "FLAT": {"daily": _daily(50.0), "minutes": _minutes(50.0, day_price=70.0)},
        "THIN": {"daily": _daily(3.0), "minutes": _minutes(3.0)},
        "NEWIPO": {"daily": _daily(40.0, count=1), "minutes": None},
    }


def _build(world, filters, list_at="08:30", max_list=30):
    return build_list(
        filters=filters,
        daily_of=lambda s: world[s]["daily"],
        minutes_of=lambda s: world[s]["minutes"],
        day=DAY,
        list_at=et(DAY, list_at),
        max_list=max_list,
    )


# -- the constant ----------------------------------------------------------------------------------------------------


def test_the_list_lag_is_the_one_sip_embargo_not_a_second_15() -> None:
    assert screen.EMBARGO is replay_data.EMBARGO  # imported, so changing the embargo changes the lag
    assert LIST_DATA_LAG == pd.Timedelta(minutes=15)


# -- the share basis -------------------------------------------------------------------------------------------------


def _frames(days: list[date], closes: list[float], volumes: list[float]) -> pd.DataFrame:
    return pd.DataFrame(
        {"open": closes, "high": closes, "low": closes, "close": closes, "volume": volumes},
        index=pd.Index(days),
        dtype=float,
    )


def test_a_split_after_the_day_is_rebased_to_the_days_own_share_basis() -> None:
    days = trading_days("stock", DAY, 4)  # three prior sessions and DAY
    # A 2-for-1 split after DAY: raw DAY close is 100; Alpaca's split-adjusted series halves every earlier bar.
    raw = _frames(days, [98.0, 99.0, 100.0, 100.0], [1_000, 1_000, 1_000, 1_000])
    split = _frames(days, [49.0, 49.5, 50.0, 50.0], [2_000, 2_000, 2_000, 2_000])
    out = rebase_split(split, raw, DAY)
    assert list(out.index) == days[:3]  # DAY's own bar is dropped
    assert out["close"].tolist() == [98.0, 99.0, 100.0]  # the basis the premarket prints are quoted on
    assert out["volume"].tolist() == [1_000.0, 1_000.0, 1_000.0]


def test_a_split_before_the_day_makes_no_false_gap() -> None:
    days = trading_days("stock", DAY, 4)
    # A 10-for-1 split between the second and third bars: the split-adjusted series is already on the new basis.
    raw = _frames(days, [1000.0, 1000.0, 100.0, 101.0], [100, 100, 1_000, 1_000])
    split = _frames(days, [100.0, 100.0, 100.0, 101.0], [1_000, 1_000, 1_000, 1_000])
    out = rebase_split(split, raw, DAY)
    assert out["close"].tolist() == [100.0, 100.0, 100.0]  # no -90% step into the day
    assert out["volume"].tolist() == [1_000.0, 1_000.0, 1_000.0]


def test_dividends_are_not_applied_so_an_ex_dividend_morning_matches_the_live_store() -> None:
    # The day is ex-dividend: Alpaca's `all` series would lower every earlier close by the dividend; the split-only
    # series (what History.split_daily asks for) leaves them alone, so prior close == the raw prior close.
    days = trading_days("stock", DAY, 3)
    raw = _frames(days, [100.0, 100.0, 99.0], [1_000, 1_000, 1_000])
    split = raw.copy()
    out = rebase_split(split, raw, DAY)
    assert out["close"].iloc[-1] == 100.0  # the live store's prior close that morning


def test_the_rebase_asks_alpaca_for_split_only_bars() -> None:
    class Sources:
        class bars:  # noqa: N801
            calls: list[str] = []

            @classmethod
            def bars(cls, symbol, timeframe, start, end, *, now, adjustment="all"):
                cls.calls.append(adjustment)
                raise AssertionError("stop here")

    history = replay_data.History(Sources, now=lambda: pd.Timestamp("2026-10-24T16:00:00Z").to_pydatetime())
    with pytest.raises(AssertionError):
        history.split_daily("AAA", DAY, DAY)
    assert Sources.bars.calls == ["split"]


def test_no_bar_for_the_day_is_no_data() -> None:
    days = trading_days("stock", PRIOR, 3)
    frame = _frames(days, [1, 1, 1], [1, 1, 1])
    assert rebase_split(frame, frame, DAY) is None


# -- the cut ---------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("list_at", ["08:30", "09:45", "10:00", "11:00", "15:30"])
def test_cut_frames_keeps_nothing_after_data_through(world, list_at) -> None:
    through = et(DAY, list_at) - LIST_DATA_LAG
    cut = cut_frames(SymbolBars(world["GAPPER"]["daily"], world["GAPPER"]["minutes"]), through)
    assert cut.minutes is not None
    assert (cut.minutes.index + pd.Timedelta(minutes=1) <= through).all()
    assert all(session("stock", d).regular_close <= through for d in cut.daily.index)
    assert cut.minutes.index.max() + pd.Timedelta(minutes=1) == through  # and keeps right up to it


def test_scan_and_metric_row_get_the_same_cut_inputs(world, monkeypatch) -> None:
    """Every symbol the scan and `metric_row` see is cut at `data_through`, at every list time."""
    seen_scan: list[tuple[str, SymbolBars]] = []
    seen_metric: list[SymbolBars] = []
    real_scan, real_metric = screen.scan, screen.metric_row

    def spy_scan(spec, data, as_of, **kwargs):
        seen_scan.extend((s, data[s]) for s in data)
        return real_scan(spec, data, as_of, **kwargs)

    def spy_metric(daily, minutes=None):
        seen_metric.append(SymbolBars(daily, minutes))
        return real_metric(daily, minutes)

    monkeypatch.setattr(screen, "scan", spy_scan)
    monkeypatch.setattr(screen, "metric_row", spy_metric)
    five = _spec(
        watch={"universe": {"market": "us_equities"}, "session": "regular", "runOn": "bar_close_5m"},
        when={"op": "gt", "left": {"series": "close"}, "right": {"value": 1}},
    )
    for list_at in ("08:30", "10:00", "13:00"):
        seen_scan.clear()
        seen_metric.clear()
        built = _build(world, [_flag("Five", five, list(world))], list_at=list_at)
        assert built.candidates and seen_scan and seen_metric
        for bars in [b for _, b in seen_scan] + seen_metric:
            assert bars.minutes is not None
            assert (bars.minutes.index + pd.Timedelta(minutes=1) <= built.data_through).all()
            assert all(session("stock", d).regular_close <= built.data_through for d in bars.daily.index)


# -- no field of the list knows the future ---------------------------------------------------------------------------


FULL_DAY_FIELDS = (
    "last",
    "change_pct",
    "volume",
    "rvol_10d",
    "gap_pct_open",
    "vwap_close",
    "vs_vwap_pct",
    "rvol_intraday_10d_at_close",
)


def test_metric_row_would_leak_the_whole_day_without_the_cut_and_no_field_equals_its_full_day_value(world) -> None:
    """The review's leak: handed the uncut minutes, `metric_row` builds today's partial bar from the whole day."""
    daily, minutes = world["GAPPER"]["daily"], world["GAPPER"]["minutes"]
    full_day = metric_row(daily, minutes)  # what an uncut feed would have produced
    cut = cut_frames(SymbolBars(daily, minutes), et(DAY, "08:30") - LIST_DATA_LAG)
    at_cut = metric_row(cut.daily, cut.minutes)
    assert full_day["last"] == pytest.approx(143.0)  # the canary is loud: the uncut row knows the whole session
    for field_name in FULL_DAY_FIELDS:
        assert at_cut[field_name] != full_day[field_name], field_name
    assert at_cut["last"] == 100.0  # the previous close, which is why the list price is not `last`


@pytest.mark.parametrize("list_at", ["08:30", "10:00", "12:00"])
def test_a_list_is_identical_when_every_bar_after_the_cut_is_replaced(world, list_at) -> None:
    through = et(DAY, list_at) - LIST_DATA_LAG
    spec = _spec(
        watch={"universe": {"market": "us_equities"}, "session": "regular", "runOn": "bar_close_5m"},
        when={"op": "gt", "left": {"series": "close"}, "right": {"value": 1}},
    )
    filters = [_flag("Five", spec, list(world)), _flag("Gap", GAP_UP, ["GAPPER", "FLAT"], 2)]
    base = _build(world, filters, list_at=list_at)

    corrupted = {s: dict(w) for s, w in world.items()}
    for w in corrupted.values():
        if w["minutes"] is not None:
            future = w["minutes"].index + pd.Timedelta(minutes=1) > through
            w["minutes"] = w["minutes"].copy()
            w["minutes"].loc[future, ["open", "high", "low", "close"]] = 777.0
            w["minutes"].loc[future, "volume"] = 99_999_999.0
    other = _build(corrupted, filters, list_at=list_at)
    assert other.candidates == base.candidates
    assert other.columns == base.columns


# -- the price of the list -------------------------------------------------------------------------------------------


def test_a_premarket_list_prices_at_the_0814_bar_not_at_metric_row_last(world) -> None:
    built = _build(world, [_flag("Gap up", GAP_UP, list(world))])
    assert [c["symbol"] for c in built.candidates] == ["GAPPER"]
    row = built.candidates[0]
    assert row["list_price"] == 106.0  # the 08:14 bar close
    assert row["price_at"] == et(DAY, "08:15")
    assert row["metrics"]["last"] == 100.0  # metric_row.last is the previous close on a premarket list
    assert row["prior_close"] == 100.0 and row["metrics"]["list_change_pct"] == 6.0
    assert built.data_through == et(DAY, "08:15") and built.prev_basis is True


def test_premarket_columns_say_prev_where_the_value_is_the_previous_session(world) -> None:
    built = _build(world, [_flag("Gap up", GAP_UP, list(world))])
    labels = {c["key"]: c["label"] for c in built.columns}
    assert labels["list_price"] == "List price" and labels["list_change_pct"] == "vs prev close %"
    assert (
        labels["last"] == "Prev close" and labels["change_pct"] == "Prev change %" and labels["volume"] == "Prev volume"
    )
    assert built.columns[-1]["key"] == "matched_since"


def test_a_cadence_list_prices_at_the_cadence_bar_close() -> None:
    spec = _spec(
        watch={"universe": {"market": "us_equities"}, "session": "regular", "runOn": "bar_close_5m"},
        when={"op": "gt", "left": {"series": "close"}, "right": {"value": 105}},
    )
    minutes = _minutes(100.0, day_price=106.0)
    set_bar(minutes, DAY, "09:44", close=107.0)  # the last 5-minute bar before the cut (09:40-09:45)
    world = {"AAA": {"daily": _daily(100.0), "minutes": minutes}}
    built = _build(world, [_flag("Five", spec, ["AAA"])], list_at="10:00")
    row = built.candidates[0]
    assert built.data_through == et(DAY, "09:45") and built.prev_basis is False
    assert row["price_at"] == et(DAY, "09:45") and row["list_price"] == 107.0
    labels = {c["key"]: c["label"] for c in built.columns}
    assert labels["change_pct"] == "Change %" and "last" not in labels  # a live partial day: standard labels


def test_a_daily_list_prices_at_the_rebased_previous_close() -> None:
    spec = _spec(when={"op": "gt", "left": {"series": "close"}, "right": {"value": 99}})
    world = {"AAA": {"daily": _daily(100.0), "minutes": None}}
    row = _build(world, [_flag("Close", spec, ["AAA"])]).candidates[0]
    assert row["list_price"] == 100.0 and row["price_at"] == session("stock", PRIOR).regular_close
    assert row["metrics"]["list_change_pct"] is None  # no intraday price to compare with the close


# -- the lookback and the floor --------------------------------------------------------------------------------------


def test_metric_row_gets_the_wider_lookback_or_the_intraday_rvol_is_null(world) -> None:
    through = et(DAY, "08:30") - LIST_DATA_LAG
    daily, minutes = world["GAPPER"]["daily"], world["GAPPER"]["minutes"]
    wide = cut_frames(SymbolBars(daily, minutes), through)
    assert metric_row(wide.daily, wide.minutes)["rvol_intraday_10d_at_close"] is not None
    prior10 = set(replay_data.prior_sessions(DAY, 10))  # the replay session's own lookback: one session short
    short_minutes = minutes[[d.date() in prior10 for d in minutes.index.tz_convert("America/New_York")]]
    short = cut_frames(SymbolBars(daily, short_minutes), through)
    assert metric_row(short.daily, short.minutes)["rvol_intraday_10d_at_close"] is None
    assert len(list_sessions(DAY)) > 11


def test_the_floor_and_the_empty_frames_are_counted_not_scanned(world) -> None:
    built = _build(world, [_flag("Gap up", GAP_UP, list(world))])
    assert built.universe == {"size": 4, "scanned": 2, "no_data": 1, "below_floor": 1}


# -- the union -------------------------------------------------------------------------------------------------------


def test_union_orders_by_filter_then_rank_dedupes_names_and_caps_without_padding() -> None:
    def close_above(level):
        return _spec(when={"op": "gt", "left": {"series": "close"}, "right": {"value": level}})

    ranked = _spec(
        when={"op": "gt", "left": {"series": "close"}, "right": {"value": 0}},
        rank={"by": {"series": "close"}, "order": "desc"},
    )
    world = {
        s: {"daily": _daily(p), "minutes": None}
        for s, p in {"AAA": 100.0, "BBB": 80.0, "CCC": 60.0, "DDD": 40.0}.items()
    }
    first = _flag("First", close_above(70), ["AAA", "BBB", "CCC", "DDD"], 1)
    second = _flag("Second", ranked, ["AAA", "BBB", "CCC", "DDD"], 2)
    built = _build(world, [first, second], max_list=3)
    assert [c["symbol"] for c in built.candidates] == ["AAA", "BBB", "CCC"]  # First's two, then Second's best new
    assert [c["rank"] for c in built.candidates] == [1, 2, 3]
    assert built.candidates[0]["filters"] == ["First", "Second"] and built.candidates[2]["filters"] == ["Second"]
    assert built.matches_total == 4  # the cap drops DDD from the list, not from the count
    few = _build(world, [first], max_list=30)
    assert [c["symbol"] for c in few.candidates] == ["AAA", "BBB"]  # never padded to fill the list size


def test_a_filter_with_its_own_symbol_universe_scans_only_those() -> None:
    spec = _spec(when={"op": "gt", "left": {"series": "close"}, "right": {"value": 1}})
    world = {s: {"daily": _daily(100.0), "minutes": None} for s in ("AAA", "BBB")}
    built = _build(world, [_flag("Mine", spec, ["BBB"])])
    assert [c["symbol"] for c in built.candidates] == ["BBB"]


def test_reported_before_the_open_flags_pre_and_prior_post_but_not_same_day_post() -> None:
    nxt = previous_session("stock", DAY)
    assert screen.reported_before_open([(DAY, "pre-market")], DAY) is True  # before-the-open report dated the day
    assert screen.reported_before_open([(nxt, "post-market")], DAY) is True  # after-the-close report the day before
    assert screen.reported_before_open([(DAY, "post-market")], DAY) is False  # same-day after the close: next session
    assert screen.reported_before_open([(DAY, "")], DAY) is False  # no time of day: never guessed from the gap
