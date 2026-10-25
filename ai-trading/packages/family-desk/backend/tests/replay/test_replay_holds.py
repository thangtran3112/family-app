"""Golden practice-hold cases (02p §b, §g): hand-computed holds on a synthetic one-minute path. Every expected number
below can be checked by hand; the arithmetic sits in the comment next to it."""

import random
import subprocess
import sys
from dataclasses import replace
from datetime import date

import pandas as pd
import pytest

from ai_trading.replay.holds import (
    HARD_CAP,
    Crossing,
    Hold,
    HoldProblem,
    check_entry,
    check_stop,
    closed_pnl,
    day_attribution,
    exit_hold,
    first_stop_crossing,
    free_cash,
    gap_usd,
    mark_close,
    pnl,
    r_multiple,
    restate,
    set_stop,
    sizing_hint,
    split_factor,
)
from ai_trading.replay.session import ReplayProblem, _check_stop_side

DAY = date(2026, 10, 26)
T0 = pd.Timestamp("2026-10-27T13:30:00Z")  # 09:30 ET on the day after the entry
MINUTE = pd.Timedelta(minutes=1)


def at(minute: float) -> pd.Timestamp:
    return T0 + pd.Timedelta(minutes=minute)


def hold(symbol="AAA", side="long", shares=100, entry=100.0, stop=None, **kw) -> Hold:
    """An open hold entered the day before; `stop` is the stop at entry and (unless `stop_price` is given) in force."""
    return Hold(
        id=kw.pop("id", 1),
        symbol=symbol,
        side=side,
        shares=shares,
        entry_day=DAY,
        entry_at=pd.Timestamp("2026-10-26T15:00:00Z"),
        entry_price=entry,
        stop_at_entry=stop,
        stop_price=kw.pop("stop_price", stop),
        stop_hit_at=kw.pop("stop_hit_at", None),
        **kw,
    )


def bars(rows: dict[int, tuple[float, float, float, float]] | None = None, n: int = 10, flat: float = 100.0):
    """`n` one-minute bars from 09:30 ET; `rows` maps a bar number to its (open, high, low, close)."""
    frame = pd.DataFrame(
        [(flat,) * 4] * n, index=pd.date_range(T0, periods=n, freq="1min"), columns=["open", "high", "low", "close"]
    )
    for number, values in (rows or {}).items():
        frame.iloc[number] = values
    return frame


# -- money: P/L and R ------------------------------------------------------------------------------------------


def test_long_round_trip_pnl_and_r():
    h = hold(shares=100, entry=50.0, stop=49.0)
    assert pnl(h, 52.5) == 250.0  # (52.50 - 50.00) * 100
    assert r_multiple(h, 52.5) == 2.5  # 2.50 per share / |50 - 49|
    done = exit_hold(h, day=date(2026, 10, 28), at=at(30), price=51.0, source="her")
    assert done.status == "closed" and done.is_open is False
    assert closed_pnl(done) == 100.0  # (51 - 50) * 100
    assert r_multiple(done, 51.0) == 1.0


def test_short_round_trip_pnl_and_r():
    h = hold(side="short", shares=200, entry=80.0, stop=81.0)
    assert h.sign == -1 and h.notional == 16_000.0  # 200 * 80
    done = exit_hold(h, day=date(2026, 10, 28), at=at(30), price=78.5, source="her")
    assert closed_pnl(done) == 300.0  # (80 - 78.50) * 200
    assert r_multiple(done, 78.5) == 1.5  # 1.50 gained per share / |80 - 81|
    lost = exit_hold(h, day=date(2026, 10, 28), at=at(30), price=81.25, source="her")
    assert closed_pnl(lost) == -250.0  # (80 - 81.25) * 200
    assert r_multiple(lost, 81.25) == -1.25


def test_pnl_rounds_to_the_cent():
    assert pnl(hold(shares=7, entry=10.0), 10.0814) == 0.57  # 0.0814 * 7 = 0.5698


def test_r_is_none_without_a_stop_at_entry_or_when_the_stop_equals_the_entry():
    assert r_multiple(hold(stop=None), 105.0) is None
    assert r_multiple(hold(stop=100.0), 105.0) is None


def test_a_later_stop_moves_the_line_never_the_r_basis():
    h = hold(entry=100.0, stop=None)
    later = set_stop(h, 98.0)
    assert later.stop_price == 98.0 and later.stop_at_entry is None and r_multiple(later, 103.0) is None
    kept = set_stop(hold(entry=100.0, stop=99.0), 100.5)
    assert kept.stop_price == 100.5 and kept.stop_at_entry == 99.0
    assert r_multiple(kept, 102.0) == 2.0  # 2 per share / |100 - 99|, not |100 - 100.5|


def test_set_stop_clears_the_pause_flag_and_never_mutates_the_original():
    h = hold(stop=99.0, stop_hit_at=at(5))
    moved = set_stop(h, 98.0)
    assert moved.stop_hit_at is None and moved.stop_price == 98.0
    assert h.stop_hit_at == at(5) and h.stop_price == 99.0


def test_exit_mark_close_and_set_stop_rules():
    h = hold(stop=99.0)
    marked = mark_close(h, 101.25, date(2026, 10, 27))
    assert (marked.last_close, marked.last_close_day) == (101.25, date(2026, 10, 27)) and h.last_close is None
    done = exit_hold(marked, day=date(2026, 10, 28), at=at(2), price=102.0, source="auto")
    assert (done.exit_day, done.exit_at, done.exit_price, done.exit_source) == (
        date(2026, 10, 28),
        at(2),
        102.0,
        "auto",
    )
    assert mark_close(done, 5.0, date(2026, 10, 29)) is done  # a closed hold is not marked again
    with pytest.raises(HoldProblem):
        exit_hold(done, day=DAY, at=at(3), price=1.0, source="her")
    with pytest.raises(HoldProblem):
        set_stop(done, 98.0)


# -- splits ----------------------------------------------------------------------------------------------------


def test_split_factor_ten_for_one_and_the_reverse():
    # raw / split-adjusted close the day before (pre-split 1300 vs 130) and on the day (130 vs 130): r = 10 then 1
    assert split_factor(1300.0, 130.0, 130.0, 130.0) == 10.0
    assert split_factor(10.0, 100.0, 100.0, 100.0) == 0.1  # 1-for-10: r(d-1) = 0.1, r(d) = 1
    assert split_factor(150.0, 100.0, 100.0, 100.0) == 1.5  # 3-for-2


def test_split_factor_cleans_float_noise_and_ignores_dividend_sized_wobble():
    assert split_factor(200.0, 100.0000001, 100.0, 100.0) == 2.0  # 1.9999999 -> 6 dp
    assert split_factor(100.0, 99.96, 100.0, 100.0) == 1.0  # k = 1.0004: a dividend, not a split
    assert split_factor(100.0, 100.0, 100.0, 100.0) == 1.0
    assert split_factor(100.0, 99.8, 100.0, 100.0) == 1.002004  # above the tolerance it is kept


def test_split_factor_refuses_a_non_positive_close():
    with pytest.raises(ValueError):
        split_factor(100.0, 0.0, 100.0, 100.0)


def test_ten_for_one_split_mid_hold_for_a_long_and_a_short():
    long_ = hold(symbol="LNG", side="long", shares=100, entry=1200.0, stop=1150.0, last_close=1300.0)
    short = hold(symbol="SHT", side="short", shares=100, entry=1200.0, stop=1250.0, last_close=1300.0)
    before = {"long": pnl(long_, 1300.0), "short": pnl(short, 1300.0)}
    assert before == {"long": 10_000.0, "short": -10_000.0}  # +/-(1300 - 1200) * 100

    day = date(2026, 10, 27)
    new_long, new_short = restate(long_, 10.0, day), restate(short, 10.0, day)
    assert (new_long.shares, new_long.entry_price, new_long.stop_at_entry, new_long.stop_price) == (
        1000,
        120.0,
        115.0,
        115.0,
    )
    assert (new_short.shares, new_short.entry_price, new_short.stop_at_entry, new_short.stop_price) == (
        1000,
        120.0,
        125.0,
        125.0,
    )
    assert new_long.last_close == 130.0 and new_short.last_close == 130.0
    assert new_long.splits == ({"day": "2026-10-27", "ratio": 10.0, "shares_before": 100, "shares_after": 1000},)
    assert pnl(new_long, 130.0) == before["long"]  # (130 - 120) * 1000
    assert pnl(new_short, 130.0) == before["short"]  # -(130 - 120) * 1000
    assert r_multiple(new_long, 130.0) == r_multiple(long_, 1300.0) == 2.0  # 10 per share / |120 - 115|
    assert long_.shares == 100 and long_.splits == ()  # the original is untouched


def test_restate_appends_to_earlier_splits_and_leaves_an_unset_last_close_unset():
    h = hold(shares=10, entry=40.0, stop=None)
    twice = restate(restate(h, 2.0, date(2026, 10, 27)), 3.0, date(2026, 10, 28))
    assert twice.shares == 60 and twice.entry_price == pytest.approx(40.0 / 6)
    assert [s["day"] for s in twice.splits] == ["2026-10-27", "2026-10-28"]
    assert twice.stop_price is None and twice.stop_at_entry is None and twice.last_close is None


def test_reverse_split_floors_the_shares_and_cash_in_lieu_is_not_modeled():
    h = hold(shares=15, entry=8.0, stop=7.5)
    out = restate(h, 0.1, date(2026, 10, 27))
    assert out.shares == 1  # floor(15 * 0.1) = floor(1.5)
    assert out.entry_price == 80.0 and out.stop_price == 75.0  # divided by 0.1
    assert out.splits[0]["shares_before"] == 15 and out.splits[0]["shares_after"] == 1


def test_a_one_for_three_reverse_split_does_not_lose_a_share_to_the_six_decimal_ratio():
    # split_factor rounds 1/3 to 0.333333, so 30 * k = 9.99999: a bare floor would give 9 instead of 10
    k = split_factor(10.0, 30.0, 100.0, 100.0)  # r(d-1) = 10/30, r(d) = 1
    assert k == 0.333333
    assert restate(hold(shares=30, entry=9.0), k, date(2026, 10, 27)).shares == 10


def test_no_split_and_closed_holds_come_back_untouched():
    h = hold()
    assert restate(h, 1.0, date(2026, 10, 27)) is h
    done = exit_hold(h, day=date(2026, 10, 28), at=at(1), price=101.0, source="her")
    assert restate(done, 10.0, date(2026, 10, 29)) is done


def test_restate_leaves_unrealized_pnl_unchanged_within_a_cent():
    rng = random.Random(7)
    reverse = [2, 4, 5, 8, 10, 20]  # ratios whose reciprocal is exact in six decimals
    for _ in range(300):
        if rng.random() < 0.5:
            k, shares = float(rng.randint(2, 10)), rng.randint(1, 500)
        else:
            n = rng.choice(reverse)
            k, shares = round(1 / n, 6), n * rng.randint(1, 200)
        entry = round(rng.uniform(5, 500), 2)
        price = round(max(entry + rng.uniform(-30, 30), 1.0), 2)
        side = rng.choice(["long", "short"])
        h = hold(side=side, shares=shares, entry=entry, stop=None)
        out = restate(h, k, date(2026, 10, 27))
        assert abs(pnl(out, price / k) - pnl(h, price)) <= 0.01 + 1e-9, (side, shares, entry, price, k)


# -- cash and the entry rules ----------------------------------------------------------------------------------


def test_free_cash_with_an_open_long_and_an_open_short():
    long_ = hold(symbol="LNG", shares=100, entry=100.0)  # notional 10,000
    short = hold(symbol="SHT", side="short", shares=50, entry=200.0)  # notional 10,000, cash-secured like a long
    assert free_cash(50_000.0, 125.25, [long_, short]) == 30_125.25  # 50,000 + 125.25 - 20,000
    assert free_cash(50_000.0, -250.5, []) == 49_749.5
    done = exit_hold(long_, day=DAY, at=at(1), price=101.0, source="her")
    assert free_cash(50_000.0, 0.0, [done, short]) == 40_000.0  # a closed hold holds no cash


def test_check_entry_passes_when_the_notional_equals_free_cash():
    check_entry(open_holds=[], symbol="AAA", shares=100, price=50.0, free_cash_usd=5_000.0)  # 100 * 50 == 5,000


def test_check_entry_refuses_a_cash_shortfall_for_a_long_or_a_short_the_same_way():
    with pytest.raises(HoldProblem) as err:
        check_entry(open_holds=[], symbol="AAA", shares=100, price=50.0, free_cash_usd=4_999.4)
    assert err.value.message == "Not enough practice cash · $4,999 free"
    assert (err.value.path, err.value.status) == ("shares", 422)
    with pytest.raises(HoldProblem) as err:
        check_entry(open_holds=[], symbol="AAA", shares=200, price=50.0, free_cash_usd=8_240.4)
    assert err.value.message == "Not enough practice cash · $8,240 free"  # 200 * 50 = 10,000 > 8,240.40


def test_check_entry_needs_at_least_one_share():
    with pytest.raises(HoldProblem) as err:
        check_entry(open_holds=[], symbol="AAA", shares=0, price=50.0, free_cash_usd=1_000.0)
    assert (err.value.path, err.value.status) == ("shares", 422)


def test_check_entry_refuses_a_second_hold_on_a_symbol():
    with pytest.raises(HoldProblem) as err:
        check_entry(open_holds=[hold(symbol="AAA")], symbol="AAA", shares=1, price=1.0, free_cash_usd=1_000.0)
    assert err.value.message == "Close your open AAA practice hold first" and err.value.status == 422
    check_entry(open_holds=[hold(symbol="AAA")], symbol="BBB", shares=1, price=1.0, free_cash_usd=1_000.0)


def test_the_cap_of_five_is_a_409_and_a_sixth_name_is_refused():
    five = [hold(symbol=name, id=i) for i, name in enumerate("ABCDE", start=1)]
    assert HARD_CAP == 5
    check_entry(open_holds=five[:4], symbol="F", shares=1, price=1.0, free_cash_usd=100.0)
    with pytest.raises(HoldProblem) as err:
        check_entry(open_holds=five, symbol="F", shares=1, price=1.0, free_cash_usd=100.0)
    assert err.value.message == "Five practice holds is the most at once" and err.value.status == 409


def test_check_entry_order_is_shares_then_duplicate_then_cap_then_cash():
    five = [hold(symbol=name, id=i) for i, name in enumerate("ABCDE", start=1)]
    broke = {"price": 100.0, "free_cash_usd": 1.0}
    with pytest.raises(HoldProblem) as err:  # duplicate beats the cap and the cash
        check_entry(open_holds=five, symbol="A", shares=10, **broke)
    assert err.value.message.startswith("Close your open A")
    with pytest.raises(HoldProblem) as err:  # the cap beats the cash
        check_entry(open_holds=five, symbol="F", shares=10, **broke)
    assert err.value.status == 409
    with pytest.raises(HoldProblem) as err:  # shares beat the duplicate
        check_entry(open_holds=five, symbol="A", shares=0, **broke)
    assert err.value.path == "shares" and not err.value.message.startswith("Close your")


@pytest.mark.parametrize(
    ("side", "stop", "last"),
    [
        ("long", 99.0, 100.0),
        ("long", 100.0, 100.0),
        ("long", 101.0, 100.0),
        ("short", 101.0, 100.0),
        ("short", 100.0, 100.0),
        ("short", 99.0, 100.0),
        ("long", 99.0, None),
        ("short", 101.0, None),
    ],
)
def test_check_stop_says_what_the_session_says(side, stop, last):
    try:
        _check_stop_side(side == "long", stop, last)
        expected = None
    except ReplayProblem as problem:
        expected = (problem.message, problem.path)
    try:
        check_stop(side, stop, last)
        got = None
    except HoldProblem as problem:
        got = (problem.message, problem.path)
    assert got == expected
    if side == "long" and stop >= 100.0:
        assert got == ("A long stop goes below the last price", "stopPrice")
    if side == "short" and stop <= 100.0 and last is not None:
        assert got == ("A short stop goes above the last price", "stopPrice")


def test_sizing_hint_is_risk_over_the_stop_distance_capped_by_cash():
    # 200 of risk / |50 - 48| per share = 100 shares; 20,000 free cash / 50 = 400 shares, so risk binds
    assert sizing_hint(risk_usd=200, last=50.0, stop=48.0, free_cash_usd=20_000.0) == 100
    # a stop above the price (a short) uses the same distance; 3,000 free cash / 50 = 60 shares, so cash binds
    assert sizing_hint(risk_usd=200, last=50.0, stop=52.0, free_cash_usd=3_000.0) == 60
    assert sizing_hint(risk_usd=100, last=50.0, stop=47.0, free_cash_usd=20_000.0) == 33  # floor(100 / 3)


@pytest.mark.parametrize(
    ("risk", "last", "stop", "cash"),
    [
        (None, 50.0, 48.0, 1e4),  # no risk set
        (0, 50.0, 48.0, 1e4),
        (200, 50.0, 50.0, 1e4),  # the stop is the last price
        (1, 50.0, 48.0, 1e4),  # floor(1 / 2) = 0 shares
        (200, 50.0, 48.0, 10.0),  # floor(10 / 50) = 0 shares of cash
        (200, 50.0, 48.0, -5.0),
        (200, 0.0, -1.0, 1e4),
    ],
)
def test_sizing_hint_is_none_without_a_usable_answer(risk, last, stop, cash):
    assert sizing_hint(risk_usd=risk, last=last, stop=stop, free_cash_usd=cash) is None


# -- the stop pause --------------------------------------------------------------------------------------------


def scan(holds, minutes, previous=T0, target=None):
    return first_stop_crossing(holds, minutes, previous, at(10) if target is None else target)


def test_a_normal_long_cross_returns_the_bar_close_and_price():
    h = hold(stop=99.0)
    frame = bars({4: (100.0, 100.0, 98.9, 99.2)})  # bar 4 runs 09:34-09:35; the low touches 98.90 <= 99.00
    assert scan([h], {"AAA": frame}) == Crossing("AAA", 99.0, at(5), 99.2, "cross", ())


def test_a_stop_touched_exactly_counts_as_crossed():
    h = hold(stop=99.0)
    assert scan([h], {"AAA": bars({2: (100.0, 100.0, 99.0, 99.5)})}).at == at(3)


def test_a_gap_through_the_stop_on_the_first_bar_reports_the_open():
    h = hold(stop=99.0)
    frame = bars({0: (98.0, 98.4, 97.5, 98.2)})  # the day opens at 98.00, already below the 99.00 stop
    assert scan([h], {"AAA": frame}) == Crossing("AAA", 99.0, at(1), 98.0, "gap", ())


def test_a_short_crosses_on_the_high_and_gaps_on_the_open():
    h = hold(symbol="SHT", side="short", entry=100.0, stop=101.0)
    cross = scan([h], {"SHT": bars({2: (100.5, 101.2, 100.4, 101.1)})})
    assert cross == Crossing("SHT", 101.0, at(3), 101.1, "cross", ())
    gap = scan([h], {"SHT": bars({0: (101.5, 101.9, 101.2, 101.6)})})
    assert gap == Crossing("SHT", 101.0, at(1), 101.5, "gap", ())


def test_a_mid_day_gap_is_a_gap_too():
    h = hold(stop=99.0)
    frame = bars({3: (98.5, 99.0, 98.0, 98.8)})  # the bar before closed at 100.00, this one opens below the stop
    assert scan([h], {"AAA": frame}).kind == "gap"


def test_only_bars_closing_inside_previous_and_target_are_read():
    h = hold(stop=99.0)
    through = {1: (100.0, 100.0, 98.0, 98.5)}  # closes at the playhead (09:32) when previous = 09:32: excluded
    assert scan([h], {"AAA": bars(through)}, previous=at(2), target=at(4)) is None
    assert scan([h], {"AAA": bars({3: (100.0, 100.0, 98.0, 98.5)})}, previous=at(2), target=at(4)).at == at(4)
    assert scan([h], {"AAA": bars({4: (100.0, 100.0, 98.0, 98.5)})}, previous=at(2), target=at(4)) is None


def test_the_scan_never_reads_a_bar_closing_after_the_target():
    h = hold(stop=99.0)
    clean = bars()
    garbage = clean.copy()
    later = garbage.index + MINUTE > at(4)
    garbage.loc[later, "low"], garbage.loc[later, "open"] = -1e9, -1e9  # would cross every long stop
    garbage.loc[later, "high"], garbage.loc[later, "close"] = 1e9, 1e9  # and every short stop
    assert scan([h], {"AAA": clean}, previous=at(1), target=at(4)) is None
    assert scan([h], {"AAA": garbage}, previous=at(1), target=at(4)) is None
    short = hold(symbol="SHT", side="short", stop=101.0)
    assert scan([short], {"SHT": garbage}, previous=at(1), target=at(4)) is None


def test_a_same_minute_double_cross_lists_the_others_in_also():
    frame = bars({3: (100.0, 101.5, 98.5, 100.0)})  # one wide bar crosses every stop below and above it
    holds = [
        hold(symbol="CCC", stop=99.5, id=3),
        hold(symbol="BBB", side="short", stop=101.0, id=2),
        hold(symbol="AAA", stop=99.0, id=1),
        hold(symbol="DDD", stop=90.0, id=4),  # untouched
    ]
    minutes = {s: frame for s in ("AAA", "BBB", "CCC", "DDD")}
    found = scan(holds, minutes)
    assert (found.symbol, found.stop_price, found.at, found.kind) == ("AAA", 99.0, at(4), "cross")
    assert found.also == ("BBB", "CCC")


def test_the_earliest_crossing_wins_even_when_its_symbol_sorts_later():
    early = bars({1: (100.0, 100.0, 98.0, 98.5)})
    late = bars({5: (100.0, 100.0, 98.0, 98.5)})
    found = scan([hold(symbol="AAA", stop=99.0), hold(symbol="ZZZ", stop=99.0, id=2)], {"AAA": late, "ZZZ": early})
    assert (found.symbol, found.at, found.also) == ("ZZZ", at(2), ())


def test_holds_that_cannot_pause_the_clock_are_skipped():
    crossing = bars({1: (100.0, 100.0, 98.0, 98.5)})
    skipped = [
        hold(symbol="HIT", stop=99.0, stop_hit_at=at(0)),  # one pause per stop note
        hold(symbol="NOSTOP", stop=None),
        exit_hold(hold(symbol="DONE", stop=99.0), day=DAY, at=at(0), price=100.0, source="her"),
        hold(symbol="NOFRAME", stop=99.0),
    ]
    minutes = {"HIT": crossing, "NOSTOP": crossing, "DONE": crossing}
    assert scan(skipped, minutes) is None
    only = hold(symbol="LATE", stop=99.0)
    found = scan([*skipped, only], {**minutes, "LATE": bars({6: (100.0, 100.0, 98.0, 98.5)})})
    assert found.symbol == "LATE" and found.at == at(7)


# -- gaps and the day's attribution ----------------------------------------------------------------------------


def test_gap_usd_has_the_sign_of_the_side():
    assert gap_usd(hold(shares=100), 182.10, 187.40) == -530.0  # (182.10 - 187.40) * 100
    assert gap_usd(hold(side="short", shares=100), 182.10, 187.40) == 530.0
    assert gap_usd(hold(shares=3), 10.004, 10.0) == 0.01  # 0.012 rounds to the cent


def test_day_attribution_splits_a_days_equity_change_into_gap_and_intraday():
    # realized 160 (a hold exited and was credited), unrealized 160 -> 40, overnight gap -5
    got = day_attribution(realized_credit=160.0, unrealized_start=160.0, unrealized_end=40.0, gap=-5.0)
    assert got == {
        "realized_usd": 160.0,
        "gap_usd": -5.0,
        "intraday_usd": 45.0,  # 40 - (-5)
        "unrealized_change_usd": -120.0,  # 40 - 160
        "equity_change_usd": 40.0,  # 160 + (-120)
    }
    quiet = day_attribution(realized_credit=0.0, unrealized_start=0.0, unrealized_end=30.0, gap=0.0)
    assert quiet["intraday_usd"] == 30.0 and quiet["equity_change_usd"] == 30.0


# -- purity ----------------------------------------------------------------------------------------------------


def test_the_module_is_pure():
    code = (
        "import sys, ai_trading.replay.holds\n"
        "bad = [m for m in sys.modules if m.startswith(('ai_trading.db', 'ai_trading.api', 'ai_trading.replay.session',"
        " 'sqlalchemy', 'fastapi'))]\n"
        "assert not bad, bad"
    )
    done = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert done.returncode == 0, done.stderr


def test_dataclasses_are_frozen():
    h = hold()
    with pytest.raises(AttributeError):
        h.shares = 5  # type: ignore[misc]
    assert replace(h, shares=5).shares == 5
