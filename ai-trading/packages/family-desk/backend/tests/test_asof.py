import pandas as pd

from ai_trading.core import asof

ASOF = pd.Timestamp("2026-06-15", tz="UTC")


def test_known_is_strict_by_default_and_inclusive_on_request():
    before = pd.Timestamp("2026-06-14", tz="UTC")
    on = ASOF
    after = pd.Timestamp("2026-06-16", tz="UTC")
    assert asof.known(before, ASOF) is True
    assert asof.known(on, ASOF) is False  # strict: not yet known at its own instant
    assert asof.known(after, ASOF) is False
    assert asof.known(on, ASOF, inclusive=True) is True  # a filing is known the day it is filed
    assert asof.known(after, ASOF, inclusive=True) is False


def test_undated_is_never_known():
    assert asof.known(None, ASOF) is False
    assert asof.known(pd.NaT, ASOF, inclusive=True) is False


def test_window_is_half_open_ending_at_asof():
    start, end = asof.window(ASOF, pd.Timedelta(days=30))
    assert start == pd.Timestamp("2026-05-16", tz="UTC")
    assert end == ASOF
    assert asof.in_window(start, start, end) is True  # start is inside
    assert asof.in_window(end, start, end) is False  # end is excluded
    assert asof.in_window(None, start, end) is False


def test_closed_bars_excludes_the_bar_still_forming():
    bars = pd.DataFrame(
        {"close": [100.0, 101.0, 102.0]},
        index=pd.DatetimeIndex(["2026-06-13", "2026-06-14", "2026-06-15"], tz="UTC"),
    )
    out = asof.closed_bars(bars, ASOF)
    assert list(out["close"]) == [100.0, 101.0]


def test_filings_are_known_the_day_they_are_filed_news_is_not():
    filings = pd.DataFrame(
        {
            "filed_at": [
                pd.Timestamp("2026-06-14", tz="UTC"),
                ASOF,
                pd.Timestamp("2026-06-16", tz="UTC"),
                pd.NaT,
            ]
        }
    )
    out = asof.as_filed(filings, ASOF)
    assert list(out.index) == [0, 1]  # on or before asof; the undated row (3) is withheld

    news = pd.DataFrame(
        {
            "published_at": [
                pd.Timestamp("2026-06-14", tz="UTC"),
                ASOF,
                None,
            ]
        }
    )
    out = asof.published(news, ASOF)
    assert list(out.index) == [0]  # strictly before asof; same-instant and undated are withheld
