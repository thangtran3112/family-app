"""Runs a strategy spec over historical bars through the live evaluator, no look-ahead (02h
section 2). `backtest()` calls `evaluate()` once per symbol (its indicators are causal, so one
call over the whole series gives the same fired signals a bar-by-bar poll would) and then walks
the execution bars once, bar by bar, in the same order a live paper account would see them:

1. At the open: a position already held gaps out if the open is already through its stop or
   target; then, only for symbols now flat, the previous bar's queued signal fills, sized with
   equity marked at this open and gated by the limits as known at the open.
2. During the bar: every open position (including one just opened) is checked against the bar's
   low and high — stop before target if both are touched — and a due time exit fires at the close.
3. At the close: the strategy's signal for this bar queues for the next bar's open, unless the
   symbol still holds a position, in which case it is dropped.

`core/sizing.py` sizes every fill; each symbol's own `InstrumentSpec` prices its costs.
"""

import math
from dataclasses import dataclass
from datetime import time
from typing import Any, Literal

import pandas as pd

from ai_trading.contracts.strategy_spec_v1 import Limits, StrategySpecV1
from ai_trading.core import indicators, levels
from ai_trading.core.calendar import ET, Asset, annotate, session
from ai_trading.core.evaluate import INTRADAY_CADENCES, SignalCandidate, evaluate
from ai_trading.core.sizing import Bracket, Side, plan_order

ExitReason = Literal["stop", "target", "time", "end_of_data"]
ATR_LENGTH = 14  # paperOrder.stop.atrMultiple has no length field; 14 is the common swing default.
_SESSION_LEVELS = {"premarket_high", "premarket_low", "overnight_high", "overnight_low"}
_ANNUALIZATION = {"daily": 252.0, "weekly": 52.0}
_BAR_LENGTH = pd.Timedelta(minutes=1)  # bars_1m is always 1-minute, the same assumption evaluate.py makes


@dataclass(frozen=True)
class SymbolBars:
    """Bars for one symbol, in the shape `evaluate()` and `backtest()` need."""

    bars_1d: pd.DataFrame
    bars_1m: pd.DataFrame | None = None


@dataclass(frozen=True)
class InstrumentSpec:
    """A symbol's contract terms for sizing and costs. Defaults to a stock: a $1-a-point
    multiplier, a 1-cent tick, and $0.005 commission a share. A caller backtesting futures passes
    its own spec (02g) with its own multiplier, tick, and per-contract commission; this module
    never imports one, to stay a pure function of what it is given."""

    multiplier: float = 1.0
    tick_size: float = 0.01
    commission_per_unit: float = 0.005


@dataclass(frozen=True)
class Costs:
    slippage_ticks: float = 1.0


@dataclass(frozen=True)
class Trade:
    symbol: str
    side: Side
    entry_time: Any
    entry_price: float
    exit_time: Any
    exit_price: float
    quantity: int
    r: float
    exit_reason: ExitReason
    pnl: float  # realized, after commission and slippage
    exit_bar_time: Any = None  # the exit bar's own start; differs from exit_time only for a
    # flat-by exit, which records exit_time as that bar's end. None for a hand-built Trade.


@dataclass(frozen=True)
class BacktestStats:
    total_return_pct: float
    cagr_pct: float
    max_drawdown_pct: float  # positive magnitude, from the starting equity as the initial peak
    sharpe: float  # annualized by `frequency`
    trades: int
    win_rate_pct: float
    avg_win_r: float
    avg_loss_r: float  # negative
    expectancy_r: float
    profit_factor: float
    avg_hold_bars: float
    exposure_pct: float
    longest_losing_streak: int
    returns_by_year: dict[int, float]
    benchmark_return_pct: float  # buy-and-hold of the required benchmark, over the same period


@dataclass(frozen=True)
class BacktestResult:
    trades: list[Trade]
    equity_curve: pd.Series
    stats: BacktestStats


@dataclass
class _Position:
    symbol: str
    side: Side
    quantity: int
    entry_time: Any
    entry_price: float  # realized (slipped) fill
    entry_commission: float
    risk_per_share: float  # |planned entry - stop|, unslipped
    stop: float
    target: float


def _signal_positions(
    signals: list[SignalCandidate], execution_bars: pd.DataFrame, asset: Asset, run_on: str
) -> set[int]:
    """The execution-bar row position of every fired signal."""
    if run_on in INTRADAY_CADENCES:
        return {execution_bars.index.get_loc(sig.bar_time) for sig in signals}
    close_to_day = {session(asset, day).regular_close: day for day in execution_bars.index}
    return {execution_bars.index.get_loc(close_to_day[sig.bar_time]) for sig in signals}


def _level_series(
    level_operand: dict[str, Any], *, daily: pd.DataFrame, bars: pd.DataFrame, days: pd.Index, asset: Asset
) -> pd.Series:
    """`level_operand`'s value at every row of `bars`, through the same `core/levels.py`
    functions `evaluate()`'s own level dispatch uses, so a `paperOrder` stop or target level
    resolves whether or not that level also appears in `when`."""
    name = level_operand["level"]
    unique_days = pd.Index(days.unique())

    def per_day(values: pd.Series) -> pd.Series:
        return pd.Series(values.reindex(days).to_numpy(), index=bars.index)

    if name.startswith("prior_day_"):
        return per_day(levels.prior_day(daily, unique_days, asset, name.removeprefix("prior_day_")))
    if name.startswith("n_day_"):
        return per_day(levels.n_day(daily, unique_days, level_operand["days"], name.removeprefix("n_day_")))
    if name in ("support", "resistance"):
        return per_day(levels.support_resistance(daily, unique_days, level_operand["days"], name))
    if name in _SESSION_LEVELS:
        return levels.pre_phase(bars, name.rsplit("_", 1)[1])
    return levels.opening_range(bars, asset, level_operand["minutes"], name.rsplit("_", 1)[1])


def _level_cache(
    paper_order: dict[str, Any],
    symbols: list[str],
    bars: dict[str, SymbolBars],
    execution_bars: dict[str, pd.DataFrame],
    asset: Asset,
    intraday: bool,
) -> dict[str, tuple[pd.Series | None, pd.Series | None]]:
    """Per symbol, the stop and target level series (None when that side is not level-based),
    aligned to `execution_bars[symbol]`'s index."""
    stop_spec, target_spec = paper_order["stop"], paper_order["target"]
    out: dict[str, tuple[pd.Series | None, pd.Series | None]] = {}
    for s in symbols:
        sb = bars[s]
        if intraday:
            ann = annotate(sb.bars_1m, asset)
            level_bars, level_days = ann, pd.Index(ann["day"])
        else:
            level_bars, level_days = sb.bars_1d, sb.bars_1d.index
        stop_series = (
            _level_series(stop_spec, daily=sb.bars_1d, bars=level_bars, days=level_days, asset=asset).reindex(
                execution_bars[s].index
            )
            if "level" in stop_spec
            else None
        )
        target_series = (
            _level_series(target_spec, daily=sb.bars_1d, bars=level_bars, days=level_days, asset=asset).reindex(
                execution_bars[s].index
            )
            if "level" in target_spec
            else None
        )
        out[s] = (stop_series, target_series)
    return out


def _resolve(
    paper_order: dict[str, Any], stop_value: float | None, target_value: float | None, atr_value: float
) -> tuple[float | None, float | None, float | None]:
    """Stop level, target level, and ATR for `plan_order`."""
    stop_spec, target_spec = paper_order["stop"], paper_order["target"]
    stop_level = stop_value if "level" in stop_spec else None
    target_level = target_value if "level" in target_spec else None
    atr = atr_value if "atrMultiple" in stop_spec else None
    return stop_level, target_level, atr


def _gap_exit(position: _Position, bar: pd.Series) -> tuple[float, ExitReason] | None:
    """Exit at the open, when the open has already gapped through the stop or the target."""
    o = float(bar["open"])
    if position.side == "buy":
        if o <= position.stop:
            return o, "stop"
        if o >= position.target:
            return o, "target"
    else:
        if o >= position.stop:
            return o, "stop"
        if o <= position.target:
            return o, "target"
    return None


def _touch_exit(position: _Position, bar: pd.Series, *, is_last: bool, flat: bool) -> tuple[float, ExitReason] | None:
    """The fill and reason from the rest of `bar` (its low and high), once a gap at the open has
    already been ruled out separately: stop before target when a bar touches both. A due time
    exit fires at the close; a position still open at the last bar of the data closes there too."""
    h, lo = float(bar["high"]), float(bar["low"])
    if position.side == "buy":
        if lo <= position.stop:
            return position.stop, "stop"
        if h >= position.target:
            return position.target, "target"
    else:
        if h >= position.stop:
            return position.stop, "stop"
        if lo <= position.target:
            return position.target, "target"
    if flat:
        return float(bar["close"]), "time"
    if is_last:
        return float(bar["close"]), "end_of_data"
    return None


def _open(bracket: Bracket, entry_time: Any, costs: Costs, instrument: InstrumentSpec) -> _Position:
    sign = 1.0 if bracket.side == "buy" else -1.0
    fill = bracket.entry + sign * costs.slippage_ticks * instrument.tick_size
    return _Position(
        symbol="",  # filled in by the caller, which knows it
        side=bracket.side,
        quantity=bracket.quantity,
        entry_time=entry_time,
        entry_price=fill,
        entry_commission=bracket.quantity * instrument.commission_per_unit,
        risk_per_share=abs(bracket.entry - bracket.stop),
        stop=bracket.stop,
        target=bracket.target,
    )


def _close(
    position: _Position,
    raw_price: float,
    reason: ExitReason,
    exit_time: Any,
    exit_bar_time: Any,
    costs: Costs,
    instrument: InstrumentSpec,
) -> tuple[Trade, float]:
    """The closed `Trade` (whose `pnl` is the full round trip, both commissions) and the cash this
    close adds (the entry commission was already taken out of cash when the position opened).
    `exit_bar_time` is the exit bar's own start (its row in `reference_index`), used for the hold
    duration; `exit_time` is the recorded, user-facing moment the exit happens, which for a
    flat-by exit is that bar's *end*, not its start."""
    sign = 1.0 if position.side == "buy" else -1.0
    exit_price = raw_price - sign * costs.slippage_ticks * instrument.tick_size
    gross = (exit_price - position.entry_price) * sign * position.quantity * instrument.multiplier
    exit_commission = position.quantity * instrument.commission_per_unit
    cash_delta = gross - exit_commission
    pnl = cash_delta - position.entry_commission
    r = (
        (exit_price - position.entry_price) * sign / position.risk_per_share
        if position.risk_per_share > 0
        else math.nan
    )
    trade = Trade(
        symbol=position.symbol,
        side=position.side,
        entry_time=position.entry_time,
        entry_price=round(position.entry_price, 6),
        exit_time=exit_time,
        exit_price=round(exit_price, 6),
        quantity=position.quantity,
        r=round(r, 6),
        exit_reason=reason,
        pnl=round(pnl, 6),
        exit_bar_time=exit_bar_time,
    )
    return trade, cash_delta


def _day_of(value: Any) -> Any:
    return value.tz_convert(ET).date() if isinstance(value, pd.Timestamp) else value


def _blocked_by_limits(
    limits: Limits | None,
    *,
    trades_today: int,
    daily_pnl: float,
    open_positions: int,
    last_exit: Any,
    now: Any,
    intraday: bool,
) -> bool:
    """Whether the spec's `limits` (02a) forbid a new entry right now, so a backtest's trade count
    matches what the paper account would actually have placed. Every input here is state already
    known as of this bar's open (trades placed, P&L realized, and exits up through the gap-exit
    step that runs before this check)."""
    if limits is None:
        return False
    if limits.maxOpenPositions is not None and open_positions >= limits.maxOpenPositions:
        return True
    if limits.maxTradesPerDay is not None and trades_today >= limits.maxTradesPerDay:
        return True
    if limits.pauseAfterDailyLossUsd is not None and daily_pnl <= -limits.pauseAfterDailyLossUsd:
        return True
    # cooldownMinutes is a per-symbol re-entry gap; it only has meaning between bars that are
    # minutes apart, so it is skipped for the daily/weekly cadences (see REPORT-F.md).
    if intraday and limits.cooldownMinutes is not None and last_exit is not None:
        if (now - last_exit) < pd.Timedelta(minutes=limits.cooldownMinutes):
            return True
    return False


def _mark(
    positions: dict[str, _Position | None],
    execution_bars: dict[str, pd.DataFrame],
    pos: int,
    instruments: dict[str, InstrumentSpec],
    field: str = "close",
) -> float:
    """Unrealized P&L of every open position, marked at row `pos` of its own symbol's bars, at
    `field` (`"open"` or `"close"`)."""
    return sum(
        (float(execution_bars[s].iloc[pos][field]) - p.entry_price)
        * (1.0 if p.side == "buy" else -1.0)
        * p.quantity
        * instruments[s].multiplier
        for s, p in positions.items()
        if p is not None
    )


def backtest(
    spec: StrategySpecV1,
    asset: Asset,
    bars: dict[str, SymbolBars],
    *,
    benchmark: pd.Series,
    starting_equity: float = 100_000.0,
    instruments: dict[str, InstrumentSpec] | None = None,
    max_position_usd: float | None = None,
    costs: Costs | None = None,
) -> BacktestResult:
    """Runs `spec` over `bars`, one position per symbol, sized by `plan_order` and gated by
    `spec.limits`. `benchmark` is a close series for the buy-and-hold comparison every result
    reports (02h section 2 always shows it next to the strategy's own return).

    Every symbol's execution bars (`bars_1m` for an intraday `runOn`, else `bars_1d`) must share
    the same index: the account's equity is shared across symbols, so they are walked together.
    `instruments` gives each symbol's contract terms (`InstrumentSpec`); a symbol missing from it
    defaults to a stock.
    """
    costs = costs or Costs()
    instruments = instruments or {}
    dumped = spec.model_dump(by_alias=True, exclude_none=True)
    paper_order = dumped.get("then", {}).get("paperOrder")
    if paper_order is None:
        raise ValueError("backtest requires then.paperOrder")
    run_on = spec.watch.runOn
    intraday = run_on in INTRADAY_CADENCES
    limits = spec.limits
    flat_by = time.fromisoformat(limits.flatBy) if limits and limits.flatBy else None

    symbols = sorted(bars)
    specs = {s: instruments.get(s, InstrumentSpec()) for s in symbols}
    signals: dict[str, list[SignalCandidate]] = {}
    for symbol, sb in bars.items():
        as_of = (
            sb.bars_1m.index[-1] + pd.Timedelta(minutes=1)
            if intraday and sb.bars_1m is not None and len(sb.bars_1m)
            else session(asset, sb.bars_1d.index[-1]).regular_close
        )
        signals[symbol] = evaluate(spec, symbol, asset, bars_1m=sb.bars_1m, bars_1d=sb.bars_1d, as_of=as_of)

    execution_bars = {s: (bars[s].bars_1m if intraday else bars[s].bars_1d) for s in symbols}
    reference_index = execution_bars[symbols[0]].index
    for s in symbols[1:]:
        if not execution_bars[s].index.equals(reference_index):
            raise ValueError("backtest requires every symbol's execution bars to share one index")
    n = len(reference_index)

    atr_cache = {s: indicators.atr(execution_bars[s], ATR_LENGTH) for s in symbols}
    level_cache = _level_cache(paper_order, symbols, bars, execution_bars, asset, intraday)
    signal_positions = {s: _signal_positions(signals[s], execution_bars[s], asset, run_on) for s in symbols}
    positions: dict[str, _Position | None] = dict.fromkeys(symbols)
    pending: dict[str, int | None] = dict.fromkeys(symbols)  # the row to fill at, queued at the prior close
    bars_in_position = dict.fromkeys(symbols, 0)
    last_exit: dict[str, Any] = dict.fromkeys(symbols)
    cash = starting_equity
    trades: list[Trade] = []
    equity_values: list[float] = []
    current_day = _day_of(reference_index[0])
    trades_today = 0
    daily_pnl = 0.0

    for i in range(n):
        day = _day_of(reference_index[i])
        if day != current_day:
            current_day, trades_today, daily_pnl = day, 0, 0.0
        is_last = i == n - 1
        # "Flat by T" fires on the first bar whose *end* (bars are labeled by their start) is at
        # or after T, and the exit it records is that end, not the bar's start.
        bar_end = reference_index[i] + _BAR_LENGTH
        flat_time = intraday and flat_by is not None and bar_end.tz_convert(ET).time() >= flat_by

        # 1a. At the open: a held position gaps out if the open is already through its level.
        for s in symbols:
            position = positions[s]
            if position is not None:
                exit_ = _gap_exit(position, execution_bars[s].iloc[i])
                if exit_ is not None:
                    trade, cash_delta = _close(
                        position, exit_[0], exit_[1], reference_index[i], reference_index[i], costs, specs[s]
                    )
                    trades.append(trade)
                    cash += cash_delta
                    daily_pnl += trade.pnl
                    last_exit[s] = reference_index[i]
                    positions[s] = None

        # 1b. At the open: fill a queued entry, only for symbols now flat; size and gate on
        # equity and limits as known at the open (cash plus positions marked at this open).
        for s in symbols:
            if positions[s] is None and pending[s] == i:
                pending[s] = None
                signal_pos = i - 1  # a fill is always the bar right after its signal
                open_positions = sum(1 for p in positions.values() if p is not None)
                blocked = _blocked_by_limits(
                    limits,
                    trades_today=trades_today,
                    daily_pnl=daily_pnl,
                    open_positions=open_positions,
                    last_exit=last_exit[s],
                    now=reference_index[i],
                    intraday=intraday,
                )
                if not blocked:
                    stop_series, target_series = level_cache[s]
                    stop_value = float(stop_series.iloc[signal_pos]) if stop_series is not None else None
                    target_value = float(target_series.iloc[signal_pos]) if target_series is not None else None
                    atr_value = atr_cache[s].iloc[signal_pos]
                    stop_level, target_level, atr_value = _resolve(paper_order, stop_value, target_value, atr_value)
                    equity_at_open = cash + _mark(positions, execution_bars, i, specs, field="open")
                    plan = plan_order(
                        paper_order,
                        entry=float(execution_bars[s].iloc[i]["open"]),
                        stop_level=stop_level,
                        target_level=target_level,
                        atr=atr_value,
                        book_equity=equity_at_open,
                        multiplier=specs[s].multiplier,
                        max_position_usd=max_position_usd,
                    )
                    if plan.bracket is not None:
                        position = _open(plan.bracket, reference_index[i], costs, specs[s])
                        position.symbol = s
                        cash -= position.entry_commission
                        positions[s] = position
                        trades_today += 1

        # 2. During the bar: the low/high of every open position, including one just opened.
        for s in symbols:
            position = positions[s]
            if position is not None:
                exit_ = _touch_exit(position, execution_bars[s].iloc[i], is_last=is_last, flat=flat_time)
                if exit_ is not None:
                    # A time exit is recorded at the bar's end (when it actually happens), not the
                    # bar's start; every other exit already happens within the bar it is on. The
                    # hold duration always uses this row's own start (`exit_bar_time`), never the
                    # bar's end, so a flat-by exit's hold is not overcounted by one bar.
                    exit_time = bar_end if exit_[1] == "time" else reference_index[i]
                    trade, cash_delta = _close(
                        position, exit_[0], exit_[1], exit_time, reference_index[i], costs, specs[s]
                    )
                    trades.append(trade)
                    cash += cash_delta
                    daily_pnl += trade.pnl
                    last_exit[s] = reference_index[i]
                    positions[s] = None
            if positions[s] is not None:
                bars_in_position[s] += 1

        equity_values.append(cash + _mark(positions, execution_bars, i, specs, field="close"))

        # 3. At the close: queue this bar's signal for the next open, unless still holding.
        for s in symbols:
            if i in signal_positions[s] and positions[s] is None and i + 1 < n:
                pending[s] = i + 1

    equity_curve = pd.Series(equity_values, index=reference_index)
    result_stats = stats(
        trades,
        equity_curve,
        starting_equity,
        benchmark,
        bars_in_position=sum(bars_in_position.values()),
        total_bars=n * len(symbols),
        frequency="weekly" if run_on == "weekly" else "daily",
    )
    return BacktestResult(trades, equity_curve, result_stats)


def _year(value: Any) -> int:
    return value.tz_convert(ET).year if isinstance(value, pd.Timestamp) else value.year


def _periodic_returns(curve: pd.Series, frequency: Literal["daily", "weekly"]) -> pd.Series:
    """`curve` resampled to one value per calendar day (ET, for an intraday curve) and, for a
    weekly `frequency`, further to one value per ISO week, then turned into simple returns."""
    if isinstance(curve.index, pd.DatetimeIndex):
        curve = curve.groupby(curve.index.tz_convert(ET).date).last()
    if frequency == "weekly":
        curve = curve.groupby(lambda d: d.isocalendar()[:2]).last()
    return curve.pct_change().dropna()


def stats(
    trades: list[Trade],
    equity_curve: pd.Series,
    starting_equity: float,
    benchmark: pd.Series,
    *,
    bars_in_position: int = 0,
    total_bars: int = 0,
    frequency: Literal["daily", "weekly"] = "daily",
) -> BacktestStats:
    """Statistics for `trades` and `equity_curve`, independent of `backtest()` so a hand-built
    trade list and equity curve can be checked directly. `benchmark` is a close series sliced to
    the equity curve's own period for the required buy-and-hold comparison."""
    nan = math.nan
    if equity_curve.empty:
        return BacktestStats(
            total_return_pct=nan,
            cagr_pct=nan,
            max_drawdown_pct=nan,
            sharpe=nan,
            trades=0,
            win_rate_pct=nan,
            avg_win_r=nan,
            avg_loss_r=nan,
            expectancy_r=nan,
            profit_factor=nan,
            avg_hold_bars=nan,
            exposure_pct=0.0,
            longest_losing_streak=0,
            returns_by_year={},
            benchmark_return_pct=nan,
        )

    final_equity = float(equity_curve.iloc[-1])
    total_return_pct = (final_equity / starting_equity - 1) * 100 if starting_equity > 0 else nan

    first, last = equity_curve.index[0], equity_curve.index[-1]
    days = (last - first).days if hasattr(last - first, "days") else (last - first)
    cagr_pct = (
        ((final_equity / starting_equity) ** (365.25 / days) - 1) * 100 if days > 0 and starting_equity > 0 else nan
    )

    # The starting equity is the initial peak, so a loss on the very first mark already counts.
    running_max = equity_curve.cummax().clip(lower=starting_equity)
    drawdowns = equity_curve / running_max - 1
    max_drawdown_pct = float(-drawdowns.min() * 100)

    periodic = _periodic_returns(equity_curve, frequency)
    if len(periodic) >= 2 and periodic.std(ddof=1) > 0:
        sharpe = float(periodic.mean() / periodic.std(ddof=1) * math.sqrt(_ANNUALIZATION[frequency]))
    else:
        sharpe = nan

    rs = [t.r for t in trades]
    wins = [r for r in rs if r > 0]
    losses = [r for r in rs if r < 0]
    win_rate_pct = 100 * len(wins) / len(rs) if rs else nan
    avg_win_r = sum(wins) / len(wins) if wins else nan
    avg_loss_r = sum(losses) / len(losses) if losses else nan
    expectancy_r = sum(rs) / len(rs) if rs else nan

    gross_profit = sum(t.pnl for t in trades if t.pnl > 0)
    gross_loss = sum(t.pnl for t in trades if t.pnl < 0)
    if not trades:
        profit_factor = nan
    elif gross_loss == 0:
        profit_factor = math.inf if gross_profit > 0 else nan
    else:
        profit_factor = gross_profit / abs(gross_loss)

    avg_hold_bars = sum(_hold_bars(t, equity_curve.index) for t in trades) / len(trades) if trades else nan
    exposure_pct = 100 * bars_in_position / total_bars if total_bars else 0.0

    streak = longest = 0
    for t in sorted(trades, key=lambda t: t.exit_time):
        if t.r < 0:
            streak += 1
            longest = max(longest, streak)
        else:
            streak = 0

    returns_by_year: dict[int, float] = {}
    baseline = starting_equity
    for year, group in equity_curve.groupby(lambda idx: _year(idx)):
        end = float(group.iloc[-1])
        returns_by_year[year] = (end / baseline - 1) * 100 if baseline > 0 else nan
        baseline = end

    window = benchmark.loc[first:last]
    benchmark_return_pct = (float(window.iloc[-1]) / float(window.iloc[0]) - 1) * 100 if len(window) >= 2 else nan

    return BacktestStats(
        total_return_pct=round(total_return_pct, 6) if not math.isnan(total_return_pct) else nan,
        cagr_pct=round(cagr_pct, 6) if not math.isnan(cagr_pct) else nan,
        max_drawdown_pct=round(max_drawdown_pct, 6),
        sharpe=round(sharpe, 6) if not math.isnan(sharpe) else nan,
        trades=len(trades),
        win_rate_pct=round(win_rate_pct, 6) if not math.isnan(win_rate_pct) else nan,
        avg_win_r=round(avg_win_r, 6) if not math.isnan(avg_win_r) else nan,
        avg_loss_r=round(avg_loss_r, 6) if not math.isnan(avg_loss_r) else nan,
        expectancy_r=round(expectancy_r, 6) if not math.isnan(expectancy_r) else nan,
        profit_factor=(
            round(profit_factor, 6)
            if isinstance(profit_factor, float) and math.isfinite(profit_factor)
            else profit_factor
        ),
        avg_hold_bars=round(avg_hold_bars, 6) if not math.isnan(avg_hold_bars) else nan,
        exposure_pct=round(exposure_pct, 6),
        longest_losing_streak=longest,
        returns_by_year={y: round(v, 6) for y, v in returns_by_year.items()},
        benchmark_return_pct=round(benchmark_return_pct, 6) if not math.isnan(benchmark_return_pct) else nan,
    )


def _hold_bars(trade: Trade, index: pd.Index) -> int:
    """Entry bar to exit bar, inclusive, by their row position — never `exit_time` itself, which
    for a flat-by exit is that bar's *end*, one bar length past its own row (and absent from
    `index` entirely when that bar is the series' last)."""
    exit_time = trade.exit_bar_time if trade.exit_bar_time is not None else trade.exit_time
    return int(index.get_loc(exit_time) - index.get_loc(trade.entry_time) + 1)
