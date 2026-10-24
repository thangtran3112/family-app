"""Evaluates a strategy spec on closed bars into signal candidates (02a section 5).

Rules see closed bars only: a 1-minute bar counts once its minute has ended, a daily bar once
its regular session has closed. A strategy fires when its rule turns true at an evaluation point
(a rising edge), so a rule that stays true does not fire again:
- bar_close_1m: every closed 1-minute bar in the watched session; the edge resets each day.
- bar_close_5m, bar_close_15m, bar_close_1h: the same, over bars built by aggregating 1-minute
  bars from the start of each session phase, so a bar never spans a pre/regular/post boundary
  (02c Shared Interfaces).
- premarket_0830: once per trading day at 08:30 ET, from the bars closed by then; no edge.
- daily_close: every closed daily bar. weekly: the last trading day of each finished week.

`then.alert.frequency` picks which evaluation points fire (02k section 3):
- absent or every_time: each rising edge, as above.
- once_per_bar: every closed bar where the rule is true, edge or not.
- once: the first firing only.
`then.alert.expiresOn` (an America/New_York date) drops candidates on a later day; a date that is not
a real calendar day counts as already expired. `then.alert.message` is rendered into each candidate.
"""

import json
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date, time
from typing import Any

import numpy as np
import pandas as pd

from ai_trading.contracts.strategy_spec_v1 import FilterStrategySpecV1, StrategySpecV1
from ai_trading.core import bias, indicators, levels, patterns, pivots
from ai_trading.core.calendar import ET, Asset, annotate, et, session

CADENCE_MINUTES = {"bar_close_1m": 1, "bar_close_5m": 5, "bar_close_15m": 15, "bar_close_1h": 60}
INTRADAY_CADENCES = set(CADENCE_MINUTES) | {"premarket_0830"}
_SESSION_LEVELS = {"premarket_high", "premarket_low", "overnight_high", "overnight_low"}
_OPENING_LEVELS = {"opening_range_high", "opening_range_low"}
_RUNNING_LEVELS = {"session_high", "session_low"}
# Cadences whose evaluation point is not a closed candle: a pattern has no bar to read there.
# `check()` rejects them at save time, so a stored spec never reaches a tick that would misread it.
_NO_CANDLE_CADENCES = {
    "premarket_0830": "premarket_0830 has no closed candle at its evaluation point",
    "weekly": "weekly runs on daily bars, not weekly candles",
}
_COMPARE = {"gt": np.greater, "gte": np.greater_equal, "lt": np.less, "lte": np.less_equal}
_PIVOT_METHODS = {
    "classic": pivots.classic_pivots,
    "fibonacci": pivots.fibonacci_pivots,
    "camarilla": pivots.camarilla_pivots,
}
_BIAS_FIELD = {"oscillators": "oscillator_score", "moving_averages": "ma_score", "summary": "summary_score"}
_PHASE_START = {"pre": "extended_open", "regular": "regular_open", "post": "regular_close"}
_PHASE_END = {"pre": "regular_open", "regular": "regular_close", "post": "extended_close"}


@dataclass(frozen=True)
class SignalCandidate:
    """`evidence` holds only the operands known at `bar_time` (JSON/jsonb has no NaN), plus the
    completing candle of each `pattern` condition as "<pattern>.<field>". `message` is the strategy's
    `then.alert.message` with its placeholders filled in, or None when the spec has none."""

    symbol: str
    bar_time: pd.Timestamp
    evidence: dict[str, float]
    message: str | None = None


def _nodes(condition: dict[str, Any]):
    yield condition
    for child in condition.get("all", []) + condition.get("any", []):
        yield from _nodes(child)
    if "not" in condition:
        yield from _nodes(condition["not"])


def _operands(condition: dict[str, Any]):
    for node in _nodes(condition):
        for side in ("left", "right"):
            if side in node and "value" not in node[side]:
                yield node[side]


def label(operand: dict[str, Any]) -> str:
    """Evidence key, e.g. "close", "sma(20)", "opening_range_high(15)", "macd(12, line, 9, 26)".
    Every parameter besides the block's own kind (`series`/`level`), in whatever field order the
    generated Pydantic model's `model_dump()` produces for that operand -- stable within a process
    and across identical inputs, since it comes from the dumped model rather than JSON source
    text, but not a property this function sorts or guarantees itself. Today that order happens to
    be alphabetical by key name (an artifact of the datamodel-code-generator toolchain); see
    `test_label_evidence_key_pins_the_schema_order` for the pinned example."""
    name = operand.get("series") or operand["level"]
    args = [str(value) for key, value in operand.items() if key not in ("series", "level")]
    return f"{name}({', '.join(args)})" if args else name


def check(spec: StrategySpecV1) -> list[str]:
    """Rules the JSON Schema cannot express: operands that the cadence cannot compute."""
    dumped = spec.model_dump(by_alias=True, exclude_none=True)
    order = dumped["then"].get("paperOrder", {})
    exits = [leg for leg in (order.get("stop"), order.get("target")) if leg and "level" in leg]
    return _cadence_problems(spec.watch.runOn, dumped["when"], exit_levels=exits)


def check_filter(spec: FilterStrategySpecV1) -> list[str]:
    """`check()` for a screener: its `when` and its `rank.by` series must exist at its `runOn` cadence."""
    dumped = spec.model_dump(by_alias=True, exclude_none=True)
    return _cadence_problems(spec.watch.runOn, dumped["when"], [dumped["rank"]["by"]] if "rank" in dumped else [])


def _cadence_problems(
    run_on: str,
    when: dict[str, Any],
    extra_operands: Sequence[dict[str, Any]] = (),
    exit_levels: Sequence[dict[str, Any]] = (),
) -> list[str]:
    """`exit_levels` are a paper order's stop and target levels, read after the entry bar: they need
    intraday bars on an intraday-only level, but are not "unknown at 08:30"."""
    intraday_only = {"vwap"} | _SESSION_LEVELS | _OPENING_LEVELS | _RUNNING_LEVELS
    problems = []
    for operand in exit_levels:
        if run_on not in INTRADAY_CADENCES and operand["level"] in intraday_only:
            problems.append(f"{operand['level']} needs intraday bars; {run_on} uses daily bars")
    for operand in [*_operands(when), *extra_operands]:
        name = operand.get("series") or operand["level"]
        if run_on not in INTRADAY_CADENCES and name in intraday_only:
            problems.append(f"{name} needs intraday bars; {run_on} uses daily bars")
        if run_on == "premarket_0830" and name in intraday_only:
            problems.append(f"{name} is not known at 08:30 ET")
    if run_on not in INTRADAY_CADENCES and any(n.get("op") == "time_between" for n in _nodes(when)):
        problems.append(f"time_between needs intraday bars; {run_on} uses daily bars")
    if run_on in _NO_CANDLE_CADENCES and any(n.get("op") == "pattern" for n in _nodes(when)):
        problems.append(f"the pattern condition is not supported by the engine yet: {_NO_CANDLE_CADENCES[run_on]}")
    return problems


@dataclass(frozen=True)
class _Frame:
    bars: pd.DataFrame  # annotated 1-minute bars, or daily bars indexed by date
    days: pd.Index  # trading day of each row
    daily: pd.DataFrame
    asset: Asset
    intraday: bool
    cache: dict[str, pd.Series] = field(default_factory=dict)
    session: str = "extended"  # watch.session: "regular" keeps pre/post bars out of candle patterns

    def per_day(self, values: pd.Series) -> pd.Series:
        return pd.Series(values.reindex(self.days).to_numpy(), index=self.bars.index)


def _series(operand: dict[str, Any], frame: _Frame) -> pd.Series:
    key = json.dumps(operand, sort_keys=True)
    if key not in frame.cache:
        frame.cache[key] = _compute(operand, frame)
    return frame.cache[key]


def _compute(operand: dict[str, Any], frame: _Frame) -> pd.Series:
    bars = frame.bars
    if "value" in operand:
        return pd.Series(float(operand["value"]), index=bars.index)
    unique_days = pd.Index(frame.days.unique())
    if "level" in operand:
        name = operand["level"]
        if name == "pivot":
            high, low, close = pivots.prior_period_hlc(frame.daily, unique_days, frame.asset, operand["period"])
            points = _PIVOT_METHODS[operand["method"]](high, low, close)
            return frame.per_day(points[operand["point"]])
        if name.startswith("prior_day_"):
            column = name.removeprefix("prior_day_")
            return frame.per_day(levels.prior_day(frame.daily, unique_days, frame.asset, column))
        if name.startswith("n_day_"):
            column = name.removeprefix("n_day_")
            return frame.per_day(levels.n_day(frame.daily, unique_days, operand["days"], column))
        if name in ("support", "resistance"):
            return frame.per_day(levels.support_resistance(frame.daily, unique_days, operand["days"], name))
        if name in _SESSION_LEVELS:
            return levels.pre_phase(bars, name.rsplit("_", 1)[1])
        if name in _RUNNING_LEVELS:
            return levels.session_extreme(bars, name.rsplit("_", 1)[1])
        return levels.opening_range(bars, frame.asset, operand["minutes"], name.rsplit("_", 1)[1])
    name = operand["series"]
    if name in ("open", "high", "low", "close", "volume"):
        return bars[name].astype(float)
    if name == "vwap":
        return indicators.session_vwap(bars)
    if name in ("sma", "ema", "rsi", "momentum", "hull_ma"):
        return getattr(indicators, name)(bars["close"], operand["length"])
    if name in ("atr", "cci", "williams_r", "vwma"):
        return getattr(indicators, name)(bars, operand["length"])
    if name == "macd":
        m = indicators.macd(bars["close"], operand["fast"], operand["slow"], operand["signal"])
        return getattr(m, operand["line"])
    if name == "stochastic":
        st = indicators.stochastic(bars, operand["length"], operand["smoothK"], operand["smoothD"])
        return getattr(st, operand["line"])
    if name == "stoch_rsi":
        sr = indicators.stoch_rsi(
            bars["close"], operand["smoothK"], operand["smoothD"], operand["rsiLength"], operand["stochLength"]
        )
        return getattr(sr, operand["line"])
    if name == "adx":
        return getattr(indicators.adx(bars, operand["length"]), operand["line"])
    if name == "awesome_oscillator":
        return indicators.awesome_oscillator(bars, operand["fast"], operand["slow"])
    if name == "bull_bear_power":
        return getattr(indicators.bull_bear_power(bars, operand["length"]), operand["line"])
    if name == "ultimate_oscillator":
        return indicators.ultimate_oscillator(bars, operand["fast"], operand["mid"], operand["slow"])
    if name == "ichimoku":
        ic = indicators.ichimoku(bars, operand["conversionLength"], operand["baseLength"], operand["spanBLength"])
        return getattr(ic, operand["line"])
    if name == "atr_pct":
        return indicators.atr_percent(bars, operand["length"], operand["medianLength"]).pct
    if name == "bias":
        return _bias_series(bars, operand["part"])
    if name == "rvol":
        if frame.intraday:
            return indicators.rvol_intraday(bars, operand["lookbackDays"])
        return indicators.rvol_daily(bars, operand["lookbackDays"])
    # gap_pct: intraday, last price against the prior regular close; daily, open against it.
    if frame.intraday:
        prior = frame.per_day(levels.prior_day(frame.daily, unique_days, frame.asset, "close"))
        return (bars["close"] - prior) / prior * 100
    prior = bars["close"].shift(1)
    return (bars["open"] - prior) / prior * 100


def level_series(bars: pd.DataFrame, daily: pd.DataFrame, asset: Asset, operand: dict[str, Any]) -> pd.Series:
    """Public: `operand`'s level value (e.g. `{"level": "pivot", "method": ..., "period": ...,
    "point": ...}`) at every row of `bars`, through the same dispatch `_compute` uses for a
    `when` operand's level. `bars` is annotated intraday bars with a `day` column (`annotate()`'s
    output) or daily bars indexed by trading day; `daily` is always regular-session daily bars.

    `backtest.py`'s `paperOrder.stop`/`target` level resolves through this one dispatch, so the
    two can never drift (the Phase 1c pivot addition included)."""
    intraday = "day" in bars.columns
    days = pd.Index(bars["day"]) if intraday else bars.index
    frame = _Frame(bars, days, daily, asset, intraday=intraday)
    return _compute(operand, frame)


def _truth(values: np.ndarray, known: pd.Series) -> pd.Series:
    return pd.Series(values, index=known.index, dtype="boolean").mask(~known)


def _condition(node: dict[str, Any], frame: _Frame) -> pd.Series:
    if "all" in node or "any" in node:
        parts = [_condition(child, frame) for child in node.get("all") or node["any"]]
        out = parts[0]
        for part in parts[1:]:
            out = (out & part) if "all" in node else (out | part)
        return out
    if "not" in node:
        return ~_condition(node["not"], frame)
    op = node["op"]
    if op == "pattern":
        return _pattern(node, frame)[0]
    if op == "time_between":
        clock = frame.bars.index.tz_convert(ET).time
        start, end = time.fromisoformat(node["start"]), time.fromisoformat(node["end"])
        inside = (clock >= start) & (clock < end) if start <= end else (clock >= start) | (clock < end)
        return pd.Series(inside, index=frame.bars.index, dtype="boolean")
    left, right = _series(node["left"], frame), _series(node["right"], frame)
    known = left.notna() & right.notna()
    if op in _COMPARE:
        return _truth(_COMPARE[op](left.to_numpy(), right.to_numpy()), known)
    if op == "within_pct":
        near = (left - right).abs().to_numpy() <= node["pct"] / 100 * right.abs().to_numpy()
        return _truth(near, known)
    # crosses: now beyond, and the previous bar at or behind. A level or a constant that only
    # became known on this bar is compared with its current value, on either side; a series needs
    # its own known previous value, so it joins the known mask below instead of falling back.
    before_left = _before_cross(left, node["left"])
    before_right = _before_cross(right, node["right"])
    if op == "crosses_above":
        now, before = left > right, before_left <= before_right
    else:
        now, before = left < right, before_left >= before_right
    return _truth((now & before).to_numpy(), known & before_left.notna() & before_right.notna())


def _pattern(node: dict[str, Any], frame: _Frame) -> tuple[pd.Series, pd.Series]:
    """A `pattern` condition on every row of `frame.bars`: its truth (NA where undecided) and the
    start time of the bar the pattern completed on (None where it did not). A `regular` session
    reads only regular-phase bars, so pre/post bars are never candles of a pattern."""
    key = "pattern:" + json.dumps(node, sort_keys=True)
    if key not in frame.cache:
        rows = frame.bars
        if frame.intraday and frame.session == "regular":
            rows = rows[rows["phase"] == "regular"]
        found = patterns.detect(
            rows,
            node["pattern"],
            trend=node.get("trend"),
            trend_bars=node.get("trendBars", patterns.DEFAULT_TREND_BARS),
            within_bars=node.get("withinBars", 1),
            groups=rows["day"].to_numpy() if frame.intraday else None,  # a pattern never carries into the next day
        )
        position = found.completed_at.to_numpy(dtype=float, na_value=np.nan)
        completed = np.full(len(rows), None, dtype=object)
        for at in np.flatnonzero(~np.isnan(position)):
            completed[at] = rows.index[int(position[at])]
        frame.cache[key] = found.truth.reindex(frame.bars.index)
        frame.cache[key + "|completed"] = pd.Series(completed, index=rows.index).reindex(frame.bars.index)
    return frame.cache[key], frame.cache[key + "|completed"]


def _before_cross(value: pd.Series, operand: dict[str, Any]) -> pd.Series:
    """The previous bar's value for a crosses operand: a level or a constant that only became
    known on this bar falls back to its current value; a series needs its own known value."""
    shifted = value.shift(1)
    return shifted if "series" in operand else shifted.fillna(value)


def _resample(ann: pd.DataFrame, asset: Asset, minutes: int, as_of: pd.Timestamp) -> pd.DataFrame:
    """Aggregates closed, annotated 1-minute bars (`day`/`phase` columns from `annotate()`) into
    `minutes`-minute OHLCV bars, binned by phase-aligned timestamp (not row position) so a bar
    never spans a pre/regular/post boundary, and a missing 1-minute bar inside a bin never shifts
    later bars into it: a bin's identity and end time come from the calendar, not from how many
    rows happen to exist.

    A bin's window is `[bin_start, bin_end)`, capped at the phase's own end. It is exposed once
    that whole window has elapsed as of `as_of` (`bin_end <= as_of`) -- equivalently, once a bar
    at or after `bin_end` has itself closed, or the bin's own phase has ended. A missing minute
    *inside* an otherwise-closed bin is fine -- the bin aggregates whatever bars actually exist in
    its window. A bin with no bars at all is never emitted (pandas' `groupby` only visits bin ids
    that have at least one row, so this falls out for free). A still-forming bin is never exposed.
    """
    if minutes == 1:
        return ann
    columns = ["open", "high", "low", "close", "volume", "day", "phase"]
    rows: dict[str, list] = {column: [] for column in columns}
    index: list[pd.Timestamp] = []
    bin_width = pd.Timedelta(minutes=minutes)
    for (day, phase), group in ann.groupby(["day", "phase"], sort=False):
        day_session = session(asset, day)
        phase_start = getattr(day_session, _PHASE_START[phase])
        phase_end = getattr(day_session, _PHASE_END[phase])
        bin_id = (group.index - phase_start) // bin_width
        for b, chunk in group.groupby(bin_id):
            bin_start = phase_start + b * bin_width
            bin_end = min(bin_start + bin_width, phase_end)
            if as_of < bin_end:
                continue  # still forming: a bar inside this bin's window could still arrive
            index.append(bin_start)
            rows["open"].append(chunk["open"].iloc[0])
            rows["high"].append(chunk["high"].max())
            rows["low"].append(chunk["low"].min())
            rows["close"].append(chunk["close"].iloc[-1])
            rows["volume"].append(chunk["volume"].sum())
            rows["day"].append(day)
            rows["phase"].append(phase)
    out = pd.DataFrame(rows, index=pd.DatetimeIndex(index, name=ann.index.name))
    return out.astype({"open": float, "high": float, "low": float, "close": float, "volume": float}).sort_index()


def _bias_series(bars: pd.DataFrame, part: str) -> pd.Series:
    """The Desk Technical Bias score (02f §3) as of each bar: NaN while warming up (fewer than
    `bias.MIN_BARS` closed bars).

    ponytail: `bias.bias()` only reports a point-in-time snapshot (Phase 1c REPORT-C decision 5),
    so getting a series means recomputing every vote from its own full history at each bar --
    O(n^2) over `bars`. Fine at today's bar counts; replace with an incremental bias if a cadence's
    history grows large enough to make this a hot path.
    """
    field_name = _BIAS_FIELD[part]
    out = np.full(len(bars), np.nan)
    for i in range(bias.MIN_BARS - 1, len(bars)):
        result = bias.bias(bars.iloc[: i + 1])
        if result != "warming up":
            out[i] = getattr(result, field_name)
    return pd.Series(out, index=bars.index)


def _points(run_on: str, frame: _Frame, session_name: str, as_of: pd.Timestamp) -> pd.Series:
    """Maps each evaluation point's time (index) to the frame row it reads (values)."""
    bars = frame.bars
    if run_on in CADENCE_MINUTES:
        rows = bars.index if session_name == "extended" else bars.index[bars["phase"] == "regular"]
        return pd.Series(rows, index=rows)
    if run_on == "premarket_0830":
        out = {}
        for day, rows in bars.groupby("day").groups.items():
            point = et(day, "08:30")
            closed = rows[rows < point]  # bars that started before 08:30 have closed by then
            if point <= as_of and len(closed):
                out[point] = closed[-1]
        return pd.Series(out, dtype=object)
    closes = {day: session(frame.asset, day).regular_close for day in bars.index}
    days = list(bars.index)
    if run_on == "weekly":
        days = [day for day in days if _last_of_week(frame.asset, day)]
    return pd.Series(days, index=pd.DatetimeIndex([closes[day] for day in days]), dtype=object)


def _last_of_week(asset: Asset, day: date) -> bool:
    """True when no later trading day falls in the same ISO week."""
    for offset in range(1, 7 - day.weekday()):
        later = pd.Timestamp(day) + pd.Timedelta(days=offset)
        if session(asset, later.date()) is not None:
            return False
    return True


def evaluate(
    spec: StrategySpecV1,
    symbol: str,
    asset: Asset,
    *,
    bars_1m: pd.DataFrame | None,
    bars_1d: pd.DataFrame,
    as_of: pd.Timestamp,
) -> list[SignalCandidate]:
    """Signal candidates for every evaluation point closed by `as_of`.

    `bars_1m`: OHLCV indexed by UTC bar start (needed by intraday cadences).
    `bars_1d`: regular-session OHLCV indexed by trading day (`datetime.date`).
    """
    problems = check(spec)
    if problems:
        raise ValueError("; ".join(problems))
    run_on = spec.watch.runOn
    closed_days = [day for day in bars_1d.index if session(asset, day).regular_close <= as_of]
    daily = bars_1d.loc[closed_days].sort_index()
    if run_on in INTRADAY_CADENCES:
        if bars_1m is None:
            raise ValueError(f"{run_on} needs 1-minute bars")
        closed = bars_1m[bars_1m.index + pd.Timedelta(minutes=1) <= as_of].sort_index()
        bars = annotate(closed, asset)
        if run_on in CADENCE_MINUTES:
            bars = _resample(bars, asset, CADENCE_MINUTES[run_on], as_of)
        frame = _Frame(bars, pd.Index(bars["day"]), daily, asset, intraday=True, session=spec.watch.session)
    else:
        frame = _Frame(daily, daily.index, daily, asset, intraday=False)

    when = spec.model_dump(by_alias=True, exclude_none=True)["when"]
    alert = spec.then.alert
    truth = _condition(when, frame)
    points = _points(run_on, frame, spec.watch.session, as_of)
    if points.empty:
        return []
    rows = pd.Index(points.to_numpy())
    now = truth.reindex(rows)
    now.index = points.index
    if run_on == "premarket_0830" or alert.frequency == "once_per_bar":
        fired = now.fillna(False).astype(bool)
    else:
        # An unknown point neither fires nor resets the edge: compare with the last KNOWN state
        # before it (per day for the bar-close cadences, the whole series for daily_close/weekly).
        groups = frame.days.to_series(index=frame.bars.index).reindex(rows).to_numpy()
        keys = groups if run_on in CADENCE_MINUTES else np.zeros(len(now))
        last_known = now.groupby(keys).transform(lambda s: s.ffill().shift(1))
        fired = now.fillna(False).astype(bool) & ~last_known.fillna(False).astype(bool)

    evidence = {label(op): _series(op, frame).reindex(rows).to_numpy() for op in _operands(when)}
    closes = frame.bars["close"].reindex(rows).to_numpy()
    completed = [
        _pattern(node, frame)[1].reindex(rows).to_numpy() for node in _nodes(when) if node.get("op") == "pattern"
    ]
    names = [node["pattern"] for node in _nodes(when) if node.get("op") == "pattern"]
    out = []
    for position in np.flatnonzero(fired.to_numpy()):
        bar_time = points.index[position]
        if alert.expiresOn is not None and not _before_expiry(bar_time, alert.expiresOn):
            continue
        values = {
            key: round(float(series[position]), 6) for key, series in evidence.items() if not np.isnan(series[position])
        }
        for name, stamps in zip(names, completed, strict=True):
            if not pd.isna(stamps[position]):
                candle = patterns.candle_evidence(frame.bars, frame.bars.index.get_loc(stamps[position]))
                values |= {f"{name}.{field}": value for field, value in candle.items()}
        message = None
        if alert.message:
            message = _message(alert.message, symbol, closes[position], run_on, _bar_close(frame, run_on, bar_time))
        out.append(SignalCandidate(symbol, bar_time, values, message))
    return out[:1] if alert.frequency == "once" else out


def _before_expiry(bar_time: pd.Timestamp, expires_on: str) -> bool:
    """True while `bar_time`'s America/New_York date is on or before `expires_on`. The schema checks
    month and day ranges, not the calendar, so "2026-02-30" parses to nothing and counts as expired."""
    try:
        return bar_time.tz_convert(ET).date() <= date.fromisoformat(expires_on)
    except ValueError:
        return False


def _bar_close(frame: _Frame, run_on: str, bar_time: pd.Timestamp) -> pd.Timestamp:
    """When the evaluated bar closed: its start plus the cadence, capped at the end of its phase (the
    last bin of a pre/regular/post phase can be shorter). `bar_time` itself for the other cadences."""
    if run_on not in CADENCE_MINUTES:
        return bar_time
    row = frame.bars.loc[bar_time]
    phase_end = getattr(session(frame.asset, row["day"]), _PHASE_END[row["phase"]])
    return min(bar_time + pd.Timedelta(minutes=CADENCE_MINUTES[run_on]), phase_end)


def _message(template: str, symbol: str, close: float, run_on: str, closed_at: pd.Timestamp) -> str:
    """`then.alert.message` with {symbol}, {close} (the evaluated bar's close) and {time} filled in:
    the bar's close in America/New_York ("10:30 ET"), or the trading day for daily and weekly runs."""
    local = closed_at.tz_convert(ET)
    stamp = f"{local:%H:%M} ET" if run_on in INTRADAY_CADENCES else f"{local:%Y-%m-%d}"
    price = f"{close:.2f}" if abs(close) >= 1 else f"{close:.4f}"
    return template.replace("{symbol}", symbol).replace("{close}", price).replace("{time}", stamp)
