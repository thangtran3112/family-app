"""The practice journal (02o §c5): marks plus the 1-minute price path to trades, P/L, R, totals, adherence,
signals versus trades and the P/L series. Pure: no database, no clock, no network.

Money rules (02o decision 6): P/L per trade is `(exit - entry) * shares` for a long and `(entry - exit) * shares`
for a short, in dollars rounded to the cent; no fees, spread or slippage. R is P/L per share divided by
`|entry - stop|`, using the first stop set during the trade (a later stop note moves the line, never the R).
Unrealized P/L is marked at the playhead's last price.
"""

from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd

from ai_trading.replay.model import ENTRY_KINDS, EXIT_KINDS, Fire, Mark, Plan

MINUTE = pd.Timedelta(minutes=1)
ON_SIGNAL_BARS = 3  # an entry within this many display bars after an armed signal counts as "on a signal"
HINT_NO_PLAN = "Add a plan to get an adherence score"
HINT_NO_TRADES = "No practice trades yet"


@dataclass
class Trade:
    no: int
    side: str  # "long" | "short"
    entry_at: pd.Timestamp
    entry_price: float
    shares: int
    stop_price: float | None  # the first stop set (the R basis and the journal's stop)
    stops: list[tuple[pd.Timestamp, float]] = field(default_factory=list)  # every stop in force, in time order
    exit_at: pd.Timestamp | None = None
    exit_price: float | None = None
    exit_source: str = "her"

    @property
    def sign(self) -> int:
        return 1 if self.side == "long" else -1

    def unrealized(self, price: float) -> float:
        return self.sign * (price - self.entry_price) * self.shares

    def r_of(self, price: float) -> float | None:
        if self.stop_price is None or self.stop_price == self.entry_price:
            return None
        return self.sign * (price - self.entry_price) / abs(self.entry_price - self.stop_price)


def assemble(marks: list[Mark]) -> tuple[list[Trade], Trade | None]:
    """`(closed trades, the open trade)` from marks in `seq` order. A stop note outside a trade is ignored."""
    closed: list[Trade] = []
    current: Trade | None = None
    for mark in sorted(marks, key=lambda m: m.seq):
        if mark.kind in ENTRY_KINDS and current is None:
            assert mark.price is not None and mark.shares is not None
            current = Trade(
                no=mark.trade_no or len(closed) + 1,
                side="long" if mark.kind == "long_entry" else "short",
                entry_at=mark.at,
                entry_price=mark.price,
                shares=mark.shares,
                stop_price=mark.stop_price,
                stops=[] if mark.stop_price is None else [(mark.at, mark.stop_price)],
            )
        elif mark.kind == "stop" and current is not None and mark.stop_price is not None:
            current.stops.append((mark.at, mark.stop_price))
            if current.stop_price is None:
                current.stop_price = mark.stop_price
        elif mark.kind in EXIT_KINDS and current is not None:
            assert mark.price is not None
            current.exit_at, current.exit_price, current.exit_source = mark.at, mark.price, mark.source
            closed.append(current)
            current = None
    return closed, current


def open_trade_out(trade: Trade | None, last_price: float | None) -> dict[str, Any] | None:
    """The open-trade card, marked at the playhead's last price (None when flat or without a price yet)."""
    if trade is None or last_price is None:
        return None
    r = trade.r_of(last_price)
    return {
        "trade_no": trade.no,
        "side": trade.side,
        "shares": trade.shares,
        "entry_price": trade.entry_price,
        "stop_price": trade.stops[-1][1] if trade.stops else None,
        "last_price": last_price,
        "unrealized_usd": round(trade.unrealized(last_price), 2),
        "r": None if r is None else round(r, 2),
    }


def _pnl(trade: Trade) -> float:
    assert trade.exit_price is not None
    return round(trade.sign * (trade.exit_price - trade.entry_price) * trade.shares, 2)


def _stop_honored(trade: Trade, bars: pd.DataFrame) -> bool:
    """True when no 1-minute low (long) or high (short) crossed the stop in force without an exit by the next
    1-minute close. Bars start after the entry minute; a stop only counts from the moment it was set."""
    assert trade.exit_at is not None
    span = bars[(bars.index >= trade.entry_at.floor("min") + MINUTE) & (bars.index < trade.exit_at)]
    for start, row in span.iterrows():
        stops = [price for at, price in trade.stops if at <= start]
        if not stops:
            continue
        crossed = row["low"] < stops[-1] if trade.sign == 1 else row["high"] > stops[-1]
        if crossed:
            return trade.exit_at <= start + 2 * MINUTE  # the close of the next 1-minute bar
    return True


def _checks(
    trades: list[Trade], plan: Plan, fires: list[Fire], bars: pd.DataFrame, display_minutes: int
) -> list[dict[str, Any]]:
    n = len(trades)
    window = pd.Timedelta(minutes=ON_SIGNAL_BARS * display_minutes)
    has_trades = n > 0

    stop_set = sum(1 for t in trades if t.stop_price is not None)
    stops = [t for t in trades if t.stop_price is not None]
    honored = sum(1 for t in stops if _stop_honored(t, bars))
    on_signal = sum(1 for t in trades if any(timedelta_ok(t.entry_at - f.bar_close, window) for f in fires))
    realized, breaches = 0.0, 0
    for trade in trades:
        if plan.max_loss_usd is not None and realized <= -plan.max_loss_usd:
            breaches += 1
        realized += _pnl(trade)

    return [
        {
            "id": "stop_set",
            "label": "Stop note on every entry",
            "applicable": plan.stop_required and has_trades,
            "passed": stop_set == n,
            "detail": f"{stop_set} of {n}",
        },
        {
            "id": "stop_honored",
            "label": "Got out by the next close after the stop was crossed",
            "applicable": bool(stops),
            "passed": honored == len(stops),
            "detail": f"{honored} of {len(stops)}",
        },
        {
            "id": "on_signal",
            "label": "Entered within 3 bars of an armed signal",
            "applicable": plan.signal_only and has_trades,
            "passed": on_signal == n,
            "detail": f"{on_signal} of {n}",
        },
        {
            "id": "max_loss",
            "label": "No entry after the max loss was reached",
            "applicable": plan.max_loss_usd is not None and has_trades,
            "passed": breaches == 0,
            "detail": f"{n - breaches} of {n}",
        },
        {
            "id": "max_trades",
            "label": "Stayed within the trade limit",
            "applicable": plan.max_trades is not None,
            "passed": plan.max_trades is None or n <= plan.max_trades,
            "detail": f"{n} of {plan.max_trades}" if plan.max_trades is not None else f"{n}",
        },
    ]


def timedelta_ok(delta: pd.Timedelta, window: pd.Timedelta) -> bool:
    return pd.Timedelta(0) <= delta <= window


def _totals(trades: list[Trade]) -> dict[str, Any]:
    pnls = [_pnl(t) for t in trades]
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p < 0]
    rs = [t.r_of(t.exit_price) for t in trades if t.exit_price is not None]
    n = len(trades)
    return {
        "pnl_usd": round(sum(pnls), 2),
        "r_total": round(sum(r for r in rs if r is not None), 2),
        "trades": n,
        "wins": len(wins),
        "losses": len(losses),
        "scratches": n - len(wins) - len(losses),
        "win_rate": round(len(wins) / n, 3) if n else None,
        "avg_win_usd": round(float(np.mean(wins)), 2) if wins else None,
        "avg_loss_usd": round(float(np.mean(losses)), 2) if losses else None,
        "largest_loss_usd": round(min(losses), 2) if losses else None,
    }


def _signals_vs_trades(fires: list[Fire], trades: list[Trade], bars: pd.DataFrame, window_end: pd.Timestamp):
    """One row per fire. The 15/30-minute changes use the last closed minute at or before bar close + N minutes
    and are null when that point is past the window end (nothing was replayed there)."""
    rows = []
    closed = bars[bars.index + MINUTE <= window_end]
    for fire in fires:
        row: dict[str, Any] = {"time": fire.bar_close, "name": fire.name, "close": fire.close}
        for minutes in (15, 30):
            point = fire.bar_close + pd.Timedelta(minutes=minutes)
            later = closed[closed.index + MINUTE <= point]
            row[f"chg_{minutes}m_pct"] = (
                round((float(later["close"].iloc[-1]) / fire.close - 1) * 100, 2)
                if point <= window_end and len(later) and fire.close
                else None
            )
        entered = [t for t in trades if timedelta_ok(t.entry_at - fire.bar_close, pd.Timedelta(minutes=15))]
        row["her"] = (
            f"entered {round((entered[0].entry_at - fire.bar_close).total_seconds() / 60)} min later"
            if entered
            else "no trade"
        )
        rows.append(row)
    return rows


def _pnl_series(
    trades: list[Trade], open_now: Trade | None, bars: pd.DataFrame, start: pd.Timestamp, as_of: pd.Timestamp
) -> list[dict[str, Any]]:
    """Realized plus the open trade marked at each closed minute, on the 1-minute grid from the window start."""
    book = [*trades, *([open_now] if open_now is not None else [])]
    series = [{"t": start, "pnl_usd": 0.0}]
    for bar_start, row in bars[(bars.index >= start) & (bars.index + MINUTE <= as_of)].iterrows():
        t_close = bar_start + MINUTE
        pnl = 0.0
        for trade in book:
            if trade.exit_at is not None and t_close >= trade.exit_at:
                pnl += _pnl(trade)
            elif t_close >= trade.entry_at:
                pnl += trade.unrealized(float(row["close"]))
        series.append({"t": t_close, "pnl_usd": round(pnl, 2)})
    return series


def compute_journal(
    marks: list[Mark],
    *,
    bars: pd.DataFrame,
    fires: list[Fire],
    plan: Plan,
    display_minutes: int,
    window_start: pd.Timestamp,
    window_end: pd.Timestamp,
    as_of: pd.Timestamp,
    last_price: float | None,
    final: bool,
) -> dict[str, Any]:
    """The `JournalOut` dict. `bars`: 1-minute OHLC indexed by UTC bar start (only rows closed by `as_of` are
    read). `fires`: the released signals (all of them when `final`). `final` fills `signals_vs_trades`, which
    looks past the playhead; an open trade at `as_of` is marked at `last_price` and counted in the P/L series
    but not in the totals."""
    trades, open_now = assemble(marks)
    visible = bars[bars.index + MINUTE <= as_of]
    checks = _checks(trades, plan, fires, visible, display_minutes)
    applicable = [c for c in checks if c["applicable"]]
    score = round(100 * sum(c["passed"] for c in applicable) / len(applicable)) if applicable else None
    hint = None if score is not None else (HINT_NO_PLAN if not plan.any else HINT_NO_TRADES)
    return {
        "totals": _totals(trades),
        "trades": [
            {
                "no": t.no,
                "side": t.side,
                "entry_at": t.entry_at,
                "entry_price": t.entry_price,
                "exit_at": t.exit_at,
                "exit_price": t.exit_price,
                "shares": t.shares,
                "pnl_usd": _pnl(t),
                "r": None if (r := t.r_of(t.exit_price)) is None else round(r, 2),  # type: ignore[arg-type]
                "stop_price": t.stop_price,
                "on_signal": any(
                    timedelta_ok(t.entry_at - f.bar_close, pd.Timedelta(minutes=ON_SIGNAL_BARS * display_minutes))
                    for f in fires
                ),
                "exit_source": t.exit_source,
            }
            for t in trades
        ],
        "adherence": {"score_pct": score, "hint": hint, "checks": checks},
        "signals_vs_trades": _signals_vs_trades(fires, trades, bars, window_end) if final else [],
        "pnl_series": _pnl_series(trades, open_now if last_price is not None else None, visible, window_start, as_of),
    }
