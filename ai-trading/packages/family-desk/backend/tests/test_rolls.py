"""The futures roll map: contiguous windows from `core.futures`' roll dates, their storage, and the
difference back-adjusted continuous series (Review Focus 4: "the roll test -- no cross-contract
gap")."""

from datetime import date, timedelta

import pandas as pd
import pytest
from sqlalchemy import select

from ai_trading.core import futures
from ai_trading.data import rolls
from ai_trading.db.models import FuturesRoll


def test_roll_windows_are_contiguous_with_no_gap_or_overlap():
    start, end = date(2026, 1, 1), date(2026, 12, 31)
    windows = rolls.roll_windows("ES", start, end)

    assert windows[0].active_from == start
    assert windows[-1].active_until == end
    for earlier, later in zip(windows, windows[1:], strict=False):
        assert later.active_from == earlier.active_until + timedelta(days=1)
    for w in windows:
        assert w.active_from <= w.active_until
        assert w.product == "ES"
        assert futures._extract_product(w.contract_symbol) == "ES"
        # Still the front month through this window's own last day.
        assert futures.front_month("ES", w.active_until) == w.contract_month


def test_roll_windows_accepts_a_micro_symbol_on_its_own_terms():
    # "MES" is itself one of the Desk's 12 listed products (`_extract_product` does not collapse a
    # micro to its mini): it gets its own windows and contract symbols.
    windows = rolls.roll_windows("MES", date(2026, 1, 1), date(2026, 3, 1))
    assert all(w.product == "MES" for w in windows)
    assert all(w.contract_symbol.startswith("MES") for w in windows)


def test_roll_windows_covers_a_physically_settled_product_too():
    windows = rolls.roll_windows("CL", date(2026, 1, 1), date(2026, 6, 30))
    assert windows[0].active_from == date(2026, 1, 1)
    assert windows[-1].active_until == date(2026, 6, 30)
    for earlier, later in zip(windows, windows[1:], strict=False):
        assert later.active_from == earlier.active_until + timedelta(days=1)


def test_store_roll_windows_is_idempotent(db_session):
    windows = rolls.roll_windows("ES", date(2026, 1, 1), date(2026, 12, 31))
    rolls.store_roll_windows(db_session, windows)
    rolls.store_roll_windows(db_session, windows)  # re-run: no duplicate-key error
    db_session.commit()
    stored = db_session.execute(select(FuturesRoll).where(FuturesRoll.product == "ES")).scalars().all()
    assert len(stored) == len(windows)
    assert {row.contract_symbol for row in stored} == {w.contract_symbol for w in windows}


# --- continuous: difference back-adjustment -------------------------------------------------------


def _daily(days: list[date], closes: list[float]) -> pd.DataFrame:
    """Daily bars indexed by trading day (`datetime.date`), matching `core.backtest`'s `bars_1d`
    shape -- not a `DatetimeIndex`."""
    return pd.DataFrame({"close": closes}, index=pd.Index(days))


def test_continuous_back_adjusts_by_the_difference_at_each_roll():
    roll_day = date(2026, 3, 16)
    w_old = rolls.RollWindow("ES", date(2026, 3, 1), "ESH6", date(2026, 3, 1), roll_day - timedelta(days=1))
    w_new = rolls.RollWindow("ES", date(2026, 6, 1), "ESM6", roll_day, date(2026, 3, 20))

    bars = {
        # The front (old) contract: 5000 the day before the roll.
        "ESH6": _daily([roll_day - timedelta(days=1), roll_day], [5000.0, 5010.0]),
        # The new contract trades 20 points richer at the bridge day, and that gap must disappear.
        "ESM6": _daily([roll_day - timedelta(days=1), roll_day, date(2026, 3, 20)], [5020.0, 5030.0, 5040.0]),
    }

    out = rolls.continuous([w_old, w_new], bars)

    # The latest segment stays at real (unadjusted) prices.
    assert out.loc[roll_day] == 5030.0
    assert out.loc[date(2026, 3, 20)] == 5040.0
    # The old segment is shifted by the +20 gap observed at the bridge day, so the series is level.
    assert out.loc[roll_day - timedelta(days=1)] == pytest.approx(5020.0)
    assert list(out.index) == sorted(out.index)


def test_continuous_raises_when_contracts_share_no_bar_near_the_roll():
    roll_day = date(2026, 3, 16)
    w_old = rolls.RollWindow("ES", date(2026, 3, 1), "ESH6", date(2026, 3, 1), roll_day - timedelta(days=1))
    w_new = rolls.RollWindow("ES", date(2026, 6, 1), "ESM6", roll_day, date(2026, 3, 20))
    bars = {
        "ESH6": _daily([roll_day - timedelta(days=1)], [5000.0]),
        "ESM6": _daily([date(2026, 3, 25)], [5040.0]),  # no overlap with the old contract at all
    }
    with pytest.raises(ValueError, match="no common bar"):
        rolls.continuous([w_old, w_new], bars)


def test_continuous_of_a_single_window_is_unadjusted():
    w = rolls.RollWindow("ES", date(2026, 3, 1), "ESH6", date(2026, 3, 1), date(2026, 3, 10))
    bars = {"ESH6": _daily([date(2026, 3, 1), date(2026, 3, 10)], [5000.0, 5005.0])}
    out = rolls.continuous([w], bars)
    assert list(out) == [5000.0, 5005.0]
