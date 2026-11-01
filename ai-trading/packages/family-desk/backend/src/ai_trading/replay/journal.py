"""The practice journal (02o §c5): marks plus the 1-minute price path to trades, P/L, R, totals, adherence,
signals versus trades and the P/L series. Pure: no database, no clock, no network.

**One average-cost position per name (ADR-0016, "One position per name, many fills").** A Buy (`long_entry`) or a Sell
(`short_entry`) mark is a fill against the name's position: the side it agrees with adds to the position at the
weighted average cost, the side it opposes closes shares first and opens the other way with what is left (a flip).
`assemble` walks the marks and returns the realized trades and the open position. **A trade is one realized exit**:
a mark that closes shares (a sale of part of the position, the cover half of a flip, or Close position) realizes
`shares closed` at the average cost then, so a ledger row, a journal trade and a cent of P/L correspond one to one.
The average cost is carried to six decimals (the price column's scale) and is the price the P/L runs on.

Money rules (02o decision 6): P/L per trade is `(exit - entry) * shares` for a long and `(entry - exit) * shares`
for a short, in dollars to the cent; no fees, spread or slippage. R is P/L per share divided by
`|average cost - stop|`, using the first stop set on the position (a later stop note moves the line, never the R;
the stop belongs to the position, not to one fill). Unrealized P/L is marked at the playhead's last price.

Cent-exact (D-033): a practice fill is a print rounded to the cent (`fill_price`), so the price on screen is the price
the P/L used, and P/L is computed in `Decimal`, never in float. Every dollar figure here goes through `pnl_usd`/
`usd_sum`, so the order of the arithmetic cannot move a cent.
"""

from collections.abc import Sequence
from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

import pandas as pd

from ai_trading.replay.model import ENTRY_KINDS, EXIT_KINDS, Fire, Mark, Plan, Span, unseen

MINUTE = pd.Timedelta(minutes=1)
ON_SIGNAL_BARS = 3  # an entry within this many display bars after an armed signal counts as "on a signal"
HINT_NO_PLAN = "Add a plan to get an adherence score"
HINT_NO_TRADES = "No practice trades yet"
CENT = Decimal("0.01")


def _dec(value: float) -> Decimal:
    """The decimal a float prints as (`repr` is the shortest round-trip form), not its binary expansion."""
    return Decimal(repr(float(value)))


def fill_price(print_price: float) -> float:
    """A tape print as a practice fill: the nearest cent, halves up. SIP prints can be sub-cent (a midpoint print at
    626.475); a fill at that price displayed as 626.48 while the P/L ran on 626.475, so the screen and the ledger
    disagreed by the half cent times the shares (D-033). A fill is always whole cents."""
    return float(_dec(print_price).quantize(CENT, rounding=ROUND_HALF_UP))


def pnl_usd(sign: int, entry: float, price: float, shares: int) -> float:
    """`sign * (price - entry) * shares` in dollars, exact to the cent (halves up, only reachable from a legacy
    sub-cent mark)."""
    return float((sign * (_dec(price) - _dec(entry)) * shares).quantize(CENT, rounding=ROUND_HALF_UP))


def usd_sum(values: list[float]) -> float:
    """A sum of dollar figures with no float drift."""
    return float(sum((_dec(v) for v in values), Decimal(0)).quantize(CENT, rounding=ROUND_HALF_UP))


def usd_mean(values: list[float]) -> float | None:
    """The mean of dollar figures to the cent (None when there are none)."""
    if not values:
        return None
    total = sum((_dec(v) for v in values), Decimal(0))
    return float((total / len(values)).quantize(CENT, rounding=ROUND_HALF_UP))


NOT_ON_NAME = "you were on another name"


@dataclass
class Trade:
    """One realized exit of a position, or the open position itself (`exit_at` None). `entry_price` is the position's
    average cost, `entry_at` its first fill, `stop_price` the first stop set on it. Several trades can share a `no`:
    the position they were closed out of."""

    no: int  # the position's number within the name's day
    side: str  # "long" | "short"
    entry_at: pd.Timestamp
    entry_price: float
    shares: int
    stop_price: float | None  # the first stop set (the R basis and the journal's stop)
    stops: list[tuple[pd.Timestamp, float]] = field(default_factory=list)  # every stop in force, in time order
    exit_at: pd.Timestamp | None = None
    exit_price: float | None = None
    exit_source: str = "her"
    exit_mark_id: int | None = None  # the mark that realized it: the ledger's key
    # Every fill that opened or added to the position since its previous exit, as (when, the day's P/L at the clock
    # then; null: unknown). The max-loss rule scores each one: an add after the loss line is an entry too.
    entries: list[tuple[pd.Timestamp, float | None]] = field(default_factory=list)

    @property
    def sign(self) -> int:
        return 1 if self.side == "long" else -1

    def unrealized(self, price: float) -> float:
        return pnl_usd(self.sign, self.entry_price, price, self.shares)

    def r_of(self, price: float) -> float | None:
        if self.stop_price is None or self.stop_price == self.entry_price:
            return None
        return self.sign * (price - self.entry_price) / abs(self.entry_price - self.stop_price)


SIX = Decimal("0.000001")


def average_cost(held: int, cost: float, added: int, price: float) -> float:
    """The average cost after `added` shares bought (or sold short) at `price` join `held` shares held at `cost`: the
    weighted mean, to six decimals (the price column's scale), halves up. The figure shown is the one P/L runs on."""
    total = _dec(cost) * held + _dec(price) * added
    return float((total / (held + added)).quantize(SIX, rounding=ROUND_HALF_UP))


def fill_split(held_side: str | None, held_shares: int, side: str, shares: int) -> tuple[int, int]:
    """`(closed, opened)`: how many shares of a fill of `shares` on `side` close the position held (`held_side`,
    `held_shares`; no position: `None`, 0) and how many open or add to one. A fill against the position closes up to its
    size and opens the other way with the rest (a flip); a fill with it, or against nothing, only opens."""
    closed = min(shares, held_shares) if held_side is not None and held_side != side else 0
    return closed, shares - closed


def assemble(marks: list[Mark]) -> tuple[list[Trade], Trade | None]:
    """`(realized trades, the open position)` from marks in `seq` order. A Buy or Sell mark is a fill (see the module
    docstring); an exit mark closes the whole position. A stop note outside a position is ignored."""
    closed: list[Trade] = []
    pos: Trade | None = None
    entries: list[tuple[pd.Timestamp, float | None]] = []
    opened = 0
    for mark in sorted(marks, key=lambda m: m.seq):
        if mark.kind in ENTRY_KINDS:
            assert mark.price is not None and mark.shares is not None
            side = "long" if mark.kind == "long_entry" else "short"
            take, rest = fill_split(
                None if pos is None else pos.side, 0 if pos is None else pos.shares, side, mark.shares
            )
            if pos is not None and take:
                closed.append(_realize(pos, take, mark, entries))
                entries = []
                pos.shares -= take
                if pos.shares == 0:
                    pos = None
            if rest:
                entries.append((mark.at, mark.day_pnl_usd))
                if pos is None:
                    opened += 1
                    pos = Trade(opened, side, mark.at, mark.price, rest, None)
                else:
                    pos.entry_price = average_cost(pos.shares, pos.entry_price, rest, mark.price)
                    pos.shares += rest
            if pos is not None and mark.stop_price is not None:
                _set_stop(pos, mark.at, mark.stop_price)
        elif mark.kind == "stop" and pos is not None and mark.stop_price is not None:
            _set_stop(pos, mark.at, mark.stop_price)
        elif mark.kind in EXIT_KINDS and pos is not None:
            closed.append(_realize(pos, pos.shares, mark, entries))
            entries, pos = [], None
    if pos is not None:
        pos.entries = entries
    return closed, pos


def _set_stop(pos: Trade, at: pd.Timestamp, price: float) -> None:
    pos.stops.append((at, price))
    if pos.stop_price is None:
        pos.stop_price = price


def _realize(pos: Trade, shares: int, mark: Mark, entries: list[tuple[pd.Timestamp, float | None]]) -> Trade:
    """The trade `mark` realizes by closing `shares` of `pos` at the mark's price: the average cost as it stood."""
    assert mark.price is not None
    return Trade(
        no=pos.no,
        side=pos.side,
        entry_at=pos.entry_at,
        entry_price=pos.entry_price,
        shares=shares,
        stop_price=pos.stop_price,
        stops=list(pos.stops),
        exit_at=mark.at,
        exit_price=mark.price,
        exit_source=mark.source,
        exit_mark_id=mark.id,
        entries=entries,
    )


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
        "entry_at": trade.entry_at,
        "stop_price": trade.stops[-1][1] if trade.stops else None,
        "last_price": last_price,
        "unrealized_usd": trade.unrealized(last_price),
        "r": None if r is None else round(r, 2),
    }


def trade_pnl(trade: Trade) -> float:
    assert trade.exit_price is not None
    return pnl_usd(trade.sign, trade.entry_price, trade.exit_price, trade.shares)


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


def _breaches(book: list[Trade], max_loss_usd: int | None) -> int:
    """Entries taken after the day's loss had already reached the max loss: every fill that opened or added to a
    position, not only the first. The day's loss at an entry is the snapshot the entry carried: realized plus every open
    trade marked at the day clock. An entry without one (a mark from before several positions could be open, or a
    standalone session's) falls back to the realized loss alone, where a trade counts as realized once its exit is at or
    before the entry."""
    if max_loss_usd is None:
        return 0

    def day_pnl(at: pd.Timestamp, snapshot: float | None) -> float:
        if snapshot is not None:
            return snapshot
        return usd_sum([trade_pnl(t) for t in book if t.exit_at is not None and t.exit_at <= at])

    return sum(1 for trade in book for at, snapshot in trade.entries if day_pnl(at, snapshot) <= -max_loss_usd)


def _checks(
    trades: list[Trade],
    plan: Plan,
    fires: list[Fire],
    bars: pd.DataFrame,
    display_minutes: int,
    day_trades: list[Trade],
) -> list[dict[str, Any]]:
    """`day_trades` are the closed trades of the other sessions of the same day list: the max loss and the trade
    limit are day rules (02o-b2), so they count every name practised that day. The rest score this session alone."""
    n = len(trades)
    book = sorted([*trades, *day_trades], key=lambda t: t.entry_at)
    n_day = len(book)  # trades are exits: a position closed in two parts is two
    n_entries = sum(len(t.entries) for t in book)
    across = " · across the day" if day_trades else ""
    window = pd.Timedelta(minutes=ON_SIGNAL_BARS * display_minutes)
    has_trades = n > 0

    stop_set = sum(1 for t in trades if t.stop_price is not None)
    stops = [t for t in trades if t.stop_price is not None]
    honored = sum(1 for t in stops if _stop_honored(t, bars))
    on_signal = sum(1 for t in trades if any(timedelta_ok(t.entry_at - f.bar_close, window) for f in fires))
    breaches = _breaches(book, plan.max_loss_usd)

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
            "label": f"No entry after the max loss was reached{across}",
            "applicable": plan.max_loss_usd is not None and n_entries > 0,
            "passed": breaches == 0,
            "detail": f"{n_entries - breaches} of {n_entries}",
        },
        {
            "id": "max_trades",
            "label": f"Stayed within the trade limit{across}",
            "applicable": plan.max_trades is not None,
            "passed": plan.max_trades is None or n_day <= plan.max_trades,
            "detail": f"{n_day} of {plan.max_trades}" if plan.max_trades is not None else f"{n_day}",
        },
    ]


def timedelta_ok(delta: pd.Timedelta, window: pd.Timedelta) -> bool:
    return pd.Timedelta(0) <= delta <= window


def _totals(trades: list[Trade]) -> dict[str, Any]:
    pnls = [trade_pnl(t) for t in trades]
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p < 0]
    rs = [t.r_of(t.exit_price) for t in trades if t.exit_price is not None]
    n = len(trades)
    return {
        "pnl_usd": usd_sum(pnls),
        "r_total": round(sum(r for r in rs if r is not None), 2),
        "trades": n,
        "wins": len(wins),
        "losses": len(losses),
        "scratches": n - len(wins) - len(losses),
        "win_rate": round(len(wins) / n, 3) if n else None,
        "avg_win_usd": usd_mean(wins),
        "avg_loss_usd": usd_mean(losses),
        "largest_loss_usd": round(min(losses), 2) if losses else None,
    }


def _signals_vs_trades(
    fires: list[Fire], trades: list[Trade], bars: pd.DataFrame, window_end: pd.Timestamp, away: Sequence[Span] = ()
):
    """One row per fire. The 15/30-minute changes use the last closed minute at or before bar close + N minutes
    and are null when that point is past the window end (nothing was replayed there). A fire inside a span she was on
    another name is listed, and says so instead of "no trade"."""
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
        if unseen(list(away), fire.bar_close):
            row["her"] = NOT_ON_NAME
        elif entered:
            row["her"] = f"entered {round((entered[0].entry_at - fire.bar_close).total_seconds() / 60)} min later"
        else:
            row["her"] = "no trade"
        rows.append(row)
    return rows


def _pnl_series(
    marks: list[Mark], include_open: bool, bars: pd.DataFrame, start: pd.Timestamp, as_of: pd.Timestamp
) -> list[dict[str, Any]]:
    """Realized plus the open position marked at each closed minute, on the 1-minute grid from the window start. The
    position is the one the marks had built by that minute (a later fill or sale never rewrites an earlier minute)."""
    ordered = sorted(marks, key=lambda m: m.seq)
    states = [(mark.at, *assemble(ordered[: i + 1])) for i, mark in enumerate(ordered)]
    series = [{"t": start, "pnl_usd": 0.0}]
    known = 0  # the states up to here were placed at or before the minute being read
    for bar_start, row in bars[(bars.index >= start) & (bars.index + MINUTE <= as_of)].iterrows():
        t_close = bar_start + MINUTE
        while known < len(states) and states[known][0] <= t_close:
            known += 1
        parts: list[float] = []
        if known:
            closed, open_ = states[known - 1][1:]
            parts = [trade_pnl(t) for t in closed]
            if include_open and open_ is not None:
                parts.append(open_.unrealized(float(row["close"])))
        series.append({"t": t_close, "pnl_usd": usd_sum(parts)})
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
    day_trades: list[Trade] | None = None,
    away: Sequence[Span] = (),
) -> dict[str, Any]:
    """The `JournalOut` dict. `bars`: 1-minute OHLC indexed by UTC bar start (only rows closed by `as_of` are
    read). `fires`: the released signals (all of them when `final`). `final` fills `signals_vs_trades`, which
    looks past the playhead; an open trade at `as_of` is marked at `last_price` and counted in the P/L series
    but not in the totals. `away`: the spans she was on another name; a signal that fired inside one was never in front
    of her, so it does not count as "a signal" for the on-signal check (02o-b2)."""
    trades, _ = assemble(marks)
    visible = bars[bars.index + MINUTE <= as_of]
    watched = [f for f in fires if not unseen(list(away), f.bar_close)]
    checks = _checks(trades, plan, watched, visible, display_minutes, day_trades or [])
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
                "pnl_usd": trade_pnl(t),
                "r": None if (r := t.r_of(t.exit_price)) is None else round(r, 2),  # type: ignore[arg-type]
                "stop_price": t.stop_price,
                "on_signal": any(
                    timedelta_ok(t.entry_at - f.bar_close, pd.Timedelta(minutes=ON_SIGNAL_BARS * display_minutes))
                    for f in watched
                ),
                "exit_source": t.exit_source,
            }
            for t in trades
        ],
        "adherence": {"score_pct": score, "hint": hint, "checks": checks},
        "signals_vs_trades": _signals_vs_trades(fires, trades, bars, window_end, away) if final else [],
        "pnl_series": _pnl_series(marks, last_price is not None, visible, window_start, as_of),
    }
