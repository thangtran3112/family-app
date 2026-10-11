from datetime import date

import pandas as pd
import pytest
from bars import trading_days

from ai_trading.core.settlement import HORIZON_DAYS, AiCall, Outcome, Pending, calibration_bucket, settle, settle_all

LAST_DAY = date(2026, 12, 31)
DAYS = trading_days("stock", LAST_DAY, HORIZON_DAYS + 20)  # real XNYS sessions, oldest first


def frame(closes: list[float], highs: list[float] | None = None, lows: list[float] | None = None) -> pd.DataFrame:
    days = DAYS[: len(closes)]
    return pd.DataFrame(
        {"close": closes, "high": highs if highs is not None else closes, "low": lows if lows is not None else closes},
        index=pd.Index(days),
    )


def spy_series(values: list[float]) -> pd.Series:
    return pd.Series(values, index=pd.Index(DAYS[: len(values)]))


def flat_with_horizon_move(count: int, move: float) -> pd.DataFrame:
    """100 every day except at the 90-session horizon (index `HORIZON_DAYS`), which is
    `100 * (1 + move)`."""
    values = [100.0] * count
    values[HORIZON_DAYS] = 100.0 * (1 + move)
    return frame(values)


def flat_spy(count: int, move: float = 0.0) -> pd.Series:
    values = [100.0] * count
    values[HORIZON_DAYS] = 100.0 * (1 + move)
    return spy_series(values)


def call(rating="buy", confidence=70.0, base_target=100.0, call_date=None) -> AiCall:
    return AiCall(
        symbol="TEST", call_date=call_date or DAYS[0], rating=rating, confidence=confidence, base_target=base_target
    )


def test_unmatured_as_of_before_the_horizon_date_stays_pending():
    prices = flat_with_horizon_move(HORIZON_DAYS + 5, 0.10)
    spy = flat_spy(HORIZON_DAYS + 5)
    settle_date = DAYS[HORIZON_DAYS]
    before = settle(call(), prices, spy, as_of=DAYS[HORIZON_DAYS - 1])
    assert before == Pending(call(), "not_matured")
    matured = settle(call(), prices, spy, as_of=settle_date)
    assert isinstance(matured, Outcome)


@pytest.mark.parametrize(
    ("rating", "expected_success"),
    [("buy", True), ("sell", False), ("hold", True)],  # excess is exactly +5%: Hold's boundary
)
def test_success_rule_at_the_positive_hold_boundary(rating, expected_success):
    prices = flat_with_horizon_move(HORIZON_DAYS + 1, 0.10)  # +10%
    spy = flat_spy(HORIZON_DAYS + 1, 0.05)  # +5%, so excess is +5.0 exactly
    outcome = settle(call(rating=rating), prices, spy, as_of=date(2030, 1, 1))
    assert outcome.excess_return_pct == pytest.approx(5.0)
    assert outcome.success is expected_success


@pytest.mark.parametrize(
    ("rating", "expected_success"),
    [("buy", False), ("sell", True), ("hold", True)],  # excess is exactly -5%: Hold's other boundary
)
def test_success_rule_at_the_negative_hold_boundary(rating, expected_success):
    prices = flat_with_horizon_move(HORIZON_DAYS + 1, 0.0)  # flat
    spy = flat_spy(HORIZON_DAYS + 1, 0.05)  # SPY +5%, so excess is -5.0 exactly
    outcome = settle(call(rating=rating), prices, spy, as_of=date(2030, 1, 1))
    assert outcome.excess_return_pct == pytest.approx(-5.0)
    assert outcome.success is expected_success


@pytest.mark.parametrize(
    ("rating", "excess_move", "expected_success"),
    [
        ("buy", 0.0001, True),
        ("buy", -0.0001, False),
        ("buy", 0.0, False),  # a tie is not a Buy success
        ("sell", -0.0001, True),
        ("sell", 0.0001, False),
        ("sell", 0.0, False),  # a tie is not a Sell success
        ("hold", 0.050001, False),  # just past the +/-5% band
        ("hold", -0.050001, False),
    ],
)
def test_success_rule_just_off_its_boundary(rating, excess_move, expected_success):
    prices = flat_with_horizon_move(HORIZON_DAYS + 1, excess_move)
    spy = flat_spy(HORIZON_DAYS + 1)
    outcome = settle(call(rating=rating), prices, spy, as_of=date(2030, 1, 1))
    assert outcome.success is expected_success


def test_target_window_excludes_the_call_date_itself():
    count = HORIZON_DAYS + 1
    closes = [100.0] * count
    spy = flat_spy(count)

    highs_on_call_date = list(closes)
    highs_on_call_date[0] = 200.0  # touches a high target on the call date itself: must not count
    only_call_date = settle(
        call(base_target=150.0), frame(closes, highs=highs_on_call_date, lows=closes), spy, date(2030, 1, 1)
    )
    assert only_call_date.target_hit is False

    highs_next_day = list(closes)
    highs_next_day[1] = 200.0  # the very next session: counts
    next_day = settle(call(base_target=150.0), frame(closes, highs=highs_next_day, lows=closes), spy, date(2030, 1, 1))
    assert next_day.target_hit is True


def test_incomplete_high_low_coverage_makes_the_target_unknown_but_still_settles_the_verdict():
    count = HORIZON_DAYS + 1
    closes = [100.0] * count
    closes[HORIZON_DAYS] = 110.0  # +10% move: still settles the excess return and success
    highs, lows = list(closes), list(closes)
    highs[40] = float("nan")  # one session in the window has no recorded high
    prices = frame(closes, highs=highs, lows=lows)
    spy = flat_spy(count)

    outcome = settle(call(base_target=105.0), prices, spy, as_of=date(2030, 1, 1))
    assert outcome.target_hit is None
    assert outcome.target_hit_reason is not None and "high/low" in outcome.target_hit_reason
    assert outcome.excess_return_pct == pytest.approx(10.0)  # only needs the two endpoints
    assert outcome.success is True


def test_a_row_missing_entirely_from_the_target_window_also_makes_it_unknown():
    count = HORIZON_DAYS + 1
    closes = [100.0] * count
    closes[HORIZON_DAYS] = 110.0
    prices = frame(closes).drop(index=DAYS[40])
    spy = flat_spy(count)
    outcome = settle(call(base_target=105.0), prices, spy, as_of=date(2030, 1, 1))
    assert outcome.target_hit is None


def test_settle_gives_pending_with_a_reason_for_a_symbol_with_no_price_data():
    spy = flat_spy(HORIZON_DAYS + 1)
    result = settle(call(), None, spy, as_of=date(2030, 1, 1))
    assert result == Pending(call(), "no price data for TEST")


def test_settle_all_skips_a_call_whose_symbol_has_no_price_data_without_raising():
    prices = flat_with_horizon_move(HORIZON_DAYS + 1, 0.10)
    spy = flat_spy(HORIZON_DAYS + 1)
    result = settle_all([call()], {"OTHER": prices}, spy, as_of=date(2030, 1, 1))
    assert result == []


def test_target_above_entry_is_reached_by_a_high_that_never_closes_there():
    count = HORIZON_DAYS + 1
    closes = [100.0] * count
    highs = list(closes)
    highs[40] = 111.0  # touches the target mid-horizon intraday, closes back down the same day
    prices = frame(closes, highs=highs, lows=closes)
    spy = flat_spy(count)
    hit = settle(call(base_target=110.0), prices, spy, as_of=date(2030, 1, 1))
    missed = settle(call(base_target=112.0), prices, spy, as_of=date(2030, 1, 1))
    assert hit.target_hit is True
    assert closes[40] < 110.0  # the close itself never reached it
    assert missed.target_hit is False


def test_target_below_entry_is_reached_by_a_low_that_never_closes_there():
    count = HORIZON_DAYS + 1
    closes = [100.0] * count
    lows = list(closes)
    lows[40] = 89.0  # touches the target mid-horizon intraday, closes back up the same day
    prices = frame(closes, highs=closes, lows=lows)
    spy = flat_spy(count)
    hit = settle(call(base_target=90.0), prices, spy, as_of=date(2030, 1, 1))
    missed = settle(call(base_target=88.0), prices, spy, as_of=date(2030, 1, 1))
    assert hit.target_hit is True
    assert closes[40] > 90.0  # the close itself never reached it
    assert missed.target_hit is False


def test_settling_the_same_call_twice_is_identical():
    prices = flat_with_horizon_move(HORIZON_DAYS + 1, 0.10)
    spy = flat_spy(HORIZON_DAYS + 1, 0.02)
    first = settle(call(), prices, spy, as_of=date(2030, 1, 1))
    second = settle(call(), prices, spy, as_of=date(2030, 1, 1))
    assert first == second


@pytest.mark.parametrize("drop", ["call_date", "settle_date"])
def test_a_gap_in_the_price_data_stays_pending_not_a_keyerror(drop):
    count = HORIZON_DAYS + 1
    prices = flat_with_horizon_move(count, 0.10)
    missing_day = call().call_date if drop == "call_date" else DAYS[HORIZON_DAYS]
    gapped = prices.drop(index=missing_day)
    spy = flat_spy(count)
    result = settle(call(), gapped, spy, as_of=date(2030, 1, 1))
    assert result == Pending(call(), "missing_price_data")


def test_a_missing_spy_row_on_the_settle_date_stays_pending_not_a_keyerror():
    count = HORIZON_DAYS + 1
    prices = flat_with_horizon_move(count, 0.10)
    spy = flat_spy(count).drop(index=DAYS[HORIZON_DAYS])
    result = settle(call(), prices, spy, as_of=date(2030, 1, 1))
    assert result == Pending(call(), "missing_price_data")


def test_settle_all_catches_up_a_missed_day_without_changing_earlier_outcomes():
    count = HORIZON_DAYS + 11
    closes = [100.0] * count
    closes[HORIZON_DAYS] = 110.0  # call A's horizon day
    closes[HORIZON_DAYS + 10] = 90.0  # call B's horizon day
    prices = frame(closes)
    spy = spy_series([100.0] * count)
    call_a = call(call_date=DAYS[0])
    call_b = call(call_date=DAYS[10], rating="sell")

    only_a = settle_all([call_a, call_b], {"TEST": prices}, spy, as_of=DAYS[HORIZON_DAYS])
    assert [o.call for o in only_a] == [call_a]

    both = settle_all([call_a, call_b], {"TEST": prices}, spy, as_of=DAYS[HORIZON_DAYS + 10])
    assert [o.call for o in both] == [call_a, call_b]
    assert both[0] == only_a[0]  # the catch-up run did not change call A's already-matured outcome


@pytest.mark.parametrize(
    ("confidence", "bucket"),
    [
        (0.0, "<50"),
        (49.9, "<50"),
        (50.0, "50-60"),
        (59.9, "50-60"),
        (60.0, "60-70"),
        (69.9, "60-70"),
        (70.0, "70-80"),
        (79.9, "70-80"),
        (80.0, "80+"),
        (100.0, "80+"),
    ],
)
def test_calibration_buckets_at_their_boundaries(confidence, bucket):
    assert calibration_bucket(confidence) == bucket
