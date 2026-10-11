"""As-of boundaries and half-open windows: filters that keep only data known at a decision time,
so backtests and historical tool calls replay without seeing the future (02h section 1).

Adapted from TradingAgents `tradingagents/dataflows/date_window.py` (Apache License 2.0; local
copy at ai-trading/packages/trading-agents; see THIRD_PARTY_NOTICES.md). **Modified** from the
original: pandas Timestamps replace "YYYY-MM-DD" strings, filters operate over a Series/DataFrame
instead of per-item string clamping, and the model-facing tool helpers (`as_of`, `as_of_window`,
`coverage_gap`, `withhold_*`) are dropped — the Desk's stored bars and filings are already dated,
so there is no live "did the model ask for a later date" guard to adapt. The original's `in_window`
keeps an undated item when a live window "reaches the present"; this pure module has no clock to
compare against, so an undated item here is always withheld, never guessed about.
"""

import pandas as pd


def known(ts: pd.Timestamp | None, asof: pd.Timestamp, *, inclusive: bool = False) -> bool:
    """Whether a dated item was known at `asof`.

    Strictly before `asof` by default (a bar is known once it closes; news once published).
    `inclusive=True` for items known on their own date (an SEC filing is known the day it is
    filed). An undated item (`ts` is None or NaT) is withheld: never known.
    """
    if ts is None or pd.isna(ts):
        return False
    return ts <= asof if inclusive else ts < asof


def window(asof: pd.Timestamp, lookback: pd.Timedelta) -> tuple[pd.Timestamp, pd.Timestamp]:
    """The half-open window `[asof - lookback, asof)` of data known at `asof`."""
    return asof - lookback, asof


def in_window(ts: pd.Timestamp | None, start: pd.Timestamp, end: pd.Timestamp) -> bool:
    """Whether a dated item falls in the half-open window `[start, end)`. Undated is withheld."""
    if ts is None or pd.isna(ts):
        return False
    return start <= ts < end


def closed_bars(bars: pd.DataFrame, asof: pd.Timestamp) -> pd.DataFrame:
    """Rows of `bars` (indexed by the bar's own close time) that had closed before `asof`."""
    return bars[bars.index < asof]


def as_filed(filings: pd.DataFrame, asof: pd.Timestamp, column: str = "filed_at") -> pd.DataFrame:
    """Rows of `filings` filed on or before `asof`. A row with no `column` value is withheld."""
    dated = filings[filings[column].notna()]
    return dated[dated[column] <= asof]


def published(news: pd.DataFrame, asof: pd.Timestamp, column: str = "published_at") -> pd.DataFrame:
    """Rows of `news` published strictly before `asof`. A row with no `column` value is withheld."""
    dated = news[news[column].notna()]
    return dated[dated[column] < asof]
