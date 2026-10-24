"""The technicals view's last-value panels (02m §a3.3), pure functions over closed bars of one timeframe:
the indicator map, the bias history ("What changed"), and the key levels.

The definitions are the Run 0 snapshot's (`temp/desk-desktop-mvp/snapshot.py`, `indicator_panel`,
`bias_history`), so its recorded cells are the oracle. Chart series stay in the browser; only these last
values come from the server.
"""

import math
from dataclasses import dataclass
from datetime import date

import pandas as pd

from ai_trading.core import bias, indicators
from ai_trading.core.calendar import ET

MA_LENGTHS = (5, 10, 20, 50, 100, 200)
HISTORY_BARS = 20


def _number(value: object, digits: int = 4) -> float | None:
    try:
        number = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return None if (math.isnan(number) or math.isinf(number)) else round(number, digits)


def _last(series: pd.Series) -> float | None:
    return _number(series.iloc[-1]) if len(series) else None


def indicator_panel(frame: pd.DataFrame) -> dict[str, float | str | None]:
    """Last value of each moving average (SMA and EMA, five lengths), RSI(14), MACD, and ATR, as the
    snapshot's `indicators` map: `sma_5 ... ema_200`, `rsi_14`, `macd_line/signal/histogram`, `atr_14`,
    `atr_pct`, `atr_label`. A value that is not known yet is null."""
    close = frame["close"]
    out: dict[str, float | str | None] = {
        f"{kind}_{length}": _last(getattr(indicators, kind)(close, length))
        for kind in ("sma", "ema")
        for length in MA_LENGTHS
    }
    macd = indicators.macd(close)
    atr_percent = indicators.atr_percent(frame, 14, 100)
    label = atr_percent.label.iloc[-1] if len(atr_percent.label) else None
    out.update(
        rsi_14=_last(indicators.rsi(close, 14)),
        macd_line=_last(macd.line),
        macd_signal=_last(macd.signal),
        macd_histogram=_last(macd.histogram),
        atr_14=_last(indicators.atr(frame, 14)),
        atr_pct=_last(atr_percent.pct),
        atr_label=None if label is None or (isinstance(label, float) and math.isnan(label)) else str(label),
    )
    return out


@dataclass(frozen=True)
class BiasPoint:
    bar: object  # the bar's index value: a UTC timestamp, or a date for daily and weekly frames
    summary: str
    score: float | None
    oscillators: str
    moving_averages: str


@dataclass(frozen=True)
class BiasChange:
    from_label: str
    to_label: str
    at_bar: object


def bias_history(frame: pd.DataFrame, count: int = HISTORY_BARS) -> tuple[list[BiasPoint], BiasChange | None]:
    """The bias after each of the last `count` closed bars (oldest first), skipping any bar that is still
    warming up, and the newest change of the summary label inside that window. Each point recomputes the
    bias over the bars up to it, so this is `count` bias evaluations.

    ponytail: recomputed per bar, not incrementally; fine for 20 points, cache by (symbol, timeframe, last
    bar) in the caller if the chart's timeframe switch ever feels slow."""
    points: list[BiasPoint] = []
    for end in range(max(len(frame) - count, bias.MIN_BARS - 1), len(frame)):
        result = bias.bias(frame.iloc[: end + 1])
        if result == "warming up":
            continue
        points.append(
            BiasPoint(
                bar=frame.index[end],
                summary=result.summary_label,
                score=_number(result.summary_score, 3),
                oscillators=result.oscillator_label,
                moving_averages=result.ma_label,
            )
        )
    change = None
    for previous, current in zip(points, points[1:], strict=False):
        if previous.summary != current.summary:
            change = BiasChange(previous.summary, current.summary, current.bar)
    return points, change


@dataclass(frozen=True)
class Levels:
    prior_close: float | None
    session_high: float | None
    session_low: float | None


def session_levels(frame: pd.DataFrame) -> Levels:
    """The last bar's session high and low, and the close of the session before it.

    Intraday frames (a UTC `DatetimeIndex`, regular session only): the session is the New York trading day of
    the last bar, so the high and low span that day's bars so far, and the prior close is the last bar of the
    previous day in the frame. Daily and weekly frames (a date index): the last bar is the session, and the
    prior close is the bar before it."""
    if frame.empty:
        return Levels(None, None, None)
    if isinstance(frame.index, pd.DatetimeIndex):
        days = pd.Index(frame.index.tz_convert(ET).date)
        today: date = days[-1]
        in_day = frame[days == today]
        before = frame[days < today]
        prior = _number(before["close"].iloc[-1]) if len(before) else None
        return Levels(prior, _number(in_day["high"].max()), _number(in_day["low"].min()))
    last = frame.iloc[-1]
    prior = _number(frame["close"].iloc[-2]) if len(frame) > 1 else None
    return Levels(prior, _number(last["high"]), _number(last["low"]))
