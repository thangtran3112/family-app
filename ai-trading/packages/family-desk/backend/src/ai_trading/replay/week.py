"""The weekly review of a swing thread (02p §e). Pure: no database, no clock, no network.

Everything is computed from data THROUGH the week's last close. The module slices every series and every fact to
`<= week.last_day` itself, so a caller that hands it later bars (prep has cached them) or later exits cannot leak
them: the review of week W is the same whatever lies after W. A hold that exits after the week is still open in it.

**Returns** use split-adjusted closes (`pd.Series` indexed by `date`, one per symbol, from the close before Day 1 on).
A price she traded at must be on that same basis: `to_adjusted(price, raw_close, adj_close)` restates a printed price
using the raw and adjusted close of the price's own day. Dividends are excluded, as everywhere else in practice.

**Sign conventions** (percent points are plain numbers x100 rounded to 2 dp, so `+1.8` means 1.8 points):
- `selection_edge(side, r, m) = sign * (r - m)` with `sign` +1 long, -1 short, `r` the symbol's close-to-close return
  over the hold's span and `m` the UNsigned universe median over the same span. A long scores positive when the stock
  beat the median; a short scores positive when the stock fell MORE than the median fell (or rose less), the mirror
  image. `selection_rank` orders the universe by the same side-signed return: 1 is the best pick for that side.
- `timing_edge(...) = sign * (exit/entry - close_at_exit/close_before_entry)`: her side-signed return over the span
  minus the symbol's side-signed close-to-close return over it. Positive means her entry and exit beat simply holding
  close to close.

**Hold span** (`hold_span`): from the close before the entry day (or the close before the week, if the hold came in
from an earlier week) to the exit day's close (or the week's last close, if it left later or is still open). For a
hold carried in, her entry leg is that opening close, so the timing edge scores this week's decisions only.

**Inputs of `compute_review`** (`ReviewInputs`; day numbers are 1-based over the whole thread):
- `days`: every replayed session of the thread, in order; `basis_day`: the session before `days[0]`; `week_no`.
- `plan` (`WeekPlan`), `entries` (`EntryFact`, one per hold opened), `stop_events` `(hold_id, honored)`.
- `day_facts` (`DayFact`): the day summaries (02p b6), from Day 1 through at least the week's last day.
- `holds` (`HoldFact`): every hold active in the week, as the server stored it: display prices as she saw them, the
  same prices on the adjusted basis, `pnl_usd` as of the week's last close (realized if it exited in the week, else
  marked at that close), and `stop` an opaque label the caller derived ("none" | "set" | "honored" | "away").
- `closes`: split-adjusted closes of the universe (indexed by date, from `basis_day`); `benchmark`: SPY the same way;
  `sources`: symbol -> source tag; `focus`: symbol -> the day it was starred; `flags`: board day -> symbols her
  armed daily filters flagged.
The module never invents data: whatever has no input is None, never a guess.
"""

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date
from statistics import fmean
from statistics import median as _median
from typing import Any, Literal

import pandas as pd

Side = Literal["long", "short"]
WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
SOURCE_ORDER = ("watchlist", "manual", "filter", "liquidity")
# the checks one day's entries can answer on their own; the loss limit, the entry count and stops are week rules
DAY_CHECKS = frozenset({"stop_set", "risk_per_hold", "open_holds_within_plan", "on_signal", "focus_before_open"})


# -- weeks --------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class WeekSpan:
    week_no: int
    days: tuple[date, ...]
    first_day_no: int
    last_day_no: int
    label: str  # "Week 2", or "Week 1 · 3 days" when the week is short


def week_spans(days: Sequence[date]) -> list[WeekSpan]:
    """The ISO calendar weeks of the replayed dates, in order (`days` ascending)."""
    groups: list[list[date]] = []
    key = None
    for d in days:
        iso = d.isocalendar()
        if (iso.year, iso.week) != key:
            groups.append([])
            key = (iso.year, iso.week)
        groups[-1].append(d)
    spans, first = [], 1
    for no, group in enumerate(groups, 1):
        n = len(group)
        label = f"Week {no}" if n == 5 else f"Week {no} · {n} day{'' if n == 1 else 's'}"
        spans.append(WeekSpan(no, tuple(group), first, first + n - 1, label))
        first += n
    return spans


def span_for(days: Sequence[date], day: date) -> WeekSpan:
    for span in week_spans(days):
        if day in span.days:
            return span
    raise ValueError(f"{day} is not a day of this thread")


def is_last_day_of_week(days: Sequence[date], day: date) -> bool:
    return span_for(days, day).days[-1] == day


def _prior(days: Sequence[date], basis_day: date, day: date) -> date:
    """The session before `day`: the close that values a hold overnight into it. Day 1's is the basis day."""
    i = list(days).index(day)
    return basis_day if i == 0 else days[i - 1]


def hold_span(
    days: Sequence[date], basis_day: date, week: WeekSpan, entry_day: date, exit_day: date | None
) -> tuple[date, date]:
    """`(start_close_day, end_close_day)` of a hold's span inside `week` (see the module docstring)."""
    start = max(_prior(days, basis_day, entry_day), _prior(days, basis_day, week.days[0]))
    end = week.days[-1] if exit_day is None else min(exit_day, week.days[-1])
    return start, end


# -- returns, rank and edges --------------------------------------------------------------------------------


def _pts(x: float) -> float:
    return round(x * 100, 2) + 0.0  # + 0.0 turns -0.0 into 0.0


def _r2(x: float | None) -> float | None:
    return None if x is None else round(x, 2)


def signed(side: Side, r: float) -> float:
    return r if side == "long" else -r


def median(values: Iterable[float]) -> float | None:
    data = list(values)
    return float(_median(data)) if data else None


def mean(values: Iterable[float]) -> float | None:
    data = list(values)
    return fmean(data) if data else None


def to_adjusted(price: float, raw_close: float, adj_close: float) -> float:
    """A price printed on a day, on the split-adjusted basis: `price * adj_close / raw_close` of that same day."""
    return price * adj_close / raw_close


def _close(series: pd.Series | None, day: date) -> float | None:
    if series is None or day not in series.index:
        return None
    value = series[day]
    return None if pd.isna(value) or value <= 0 else float(value)


def _through(series: pd.Series, last: date) -> pd.Series:
    return series[[d <= last for d in series.index]]


def universe_returns(closes: Mapping[str, pd.Series], before: date, last: date) -> dict[str, float]:
    """`close(last) / close(before) - 1` per symbol; a symbol lacking either close is dropped."""
    returns = {symbol: _return(closes, symbol, before, last) for symbol in closes}
    return {symbol: r for symbol, r in returns.items() if r is not None}


def _return(closes: Mapping[str, pd.Series], symbol: str, before: date, last: date) -> float | None:
    a, b = _close(closes.get(symbol), before), _close(closes.get(symbol), last)
    return None if a is None or b is None else b / a - 1


def selection_rank(side: Side, symbol: str, returns: Mapping[str, float]) -> tuple[int, int]:
    """`(rank, of)`: 1 is the best side-signed return in the universe; ties go to the alphabetically first symbol."""
    order = sorted(returns, key=lambda s: (-signed(side, returns[s]), s))
    return order.index(symbol) + 1, len(order)


def selection_edge(side: Side, symbol_return: float, universe_median_return: float) -> float:
    return _pts(signed(side, symbol_return - universe_median_return))


def timing_edge(
    side: Side, entry_price_adj: float, exit_price_adj: float, close_before_entry: float, close_at_exit: float
) -> float:
    hers = exit_price_adj / entry_price_adj - 1
    symbols = close_at_exit / close_before_entry - 1
    return _pts(signed(side, hers - symbols))


def ordinal(n: int) -> str:
    suffix = "th" if n % 100 in (11, 12, 13) else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix}"


# -- adherence ----------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class WeekPlan:
    """The plan limits the week is scored against (the thread's plan under the 02p names; None / False = unset)."""

    stop_required: bool = False
    risk_per_hold_usd: int | None = None
    max_open_holds: int | None = None
    max_loss_usd: int | None = None
    max_trades: int | None = None
    signal_only: bool = False


@dataclass(frozen=True)
class EntryFact:
    hold_id: int
    symbol: str
    day_no: int
    had_stop: bool
    risk_usd: float | None  # shares * |entry - stop at entry|; None without a stop at entry
    on_signal: bool
    focused_before_open: bool  # she held the name or had starred it before the day's first reveal
    week_realized_before: float  # the week's realized P/L when she entered


def _check(id_: str, label: str, applicable: bool, passed: bool, detail: str) -> dict[str, Any]:
    return {"id": id_, "label": label, "applicable": applicable, "passed": passed, "detail": detail}


def adherence_checks(
    plan: WeekPlan, entries: Sequence[EntryFact], stop_events: Sequence[tuple[int, bool]], max_open_seen: int
) -> list[dict[str, Any]]:
    """02p e3 over the week's entries. `stop_events`: `(hold_id, honored)` for each stop hit; `max_open_seen`: the most
    holds open at once. A check that cannot apply says so (`applicable` False) and is left out of the score."""
    n = len(entries)
    with_stop = sum(e.had_stop for e in entries)
    hit, honored = len(stop_events), sum(ok for _, ok in stop_events)
    risk = plan.risk_per_hold_usd
    within = sum(e.risk_usd is not None and round(e.risk_usd, 2) <= risk for e in entries) if risk is not None else 0
    loss = plan.max_loss_usd
    breaches = sum(e.week_realized_before <= -loss for e in entries) if loss is not None else 0
    signalled = sum(e.on_signal for e in entries)
    focused = sum(e.focused_before_open for e in entries)
    return [
        _check(
            "stop_set", "Stop note on every entry", plan.stop_required and n > 0, with_stop == n, f"{with_stop} of {n}"
        ),
        _check(
            "stop_honored", "Exited promptly after a stop was crossed", hit > 0, honored == hit, f"{honored} of {hit}"
        ),
        _check(
            "risk_per_hold",
            "Risk per hold within the plan",
            risk is not None and n > 0,
            within == n,
            f"{within} of {n}",
        ),
        _check(
            "open_holds_within_plan",
            "Stayed within the open-hold limit",
            plan.max_open_holds is not None,
            plan.max_open_holds is None or max_open_seen <= plan.max_open_holds,
            f"{max_open_seen} of {plan.max_open_holds}",
        ),
        _check(
            "week_loss_limit",
            "No entry after the week's loss limit was reached",
            loss is not None and n > 0,
            breaches == 0,
            f"{n - breaches} of {n}",
        ),
        _check(
            "entries_per_week",
            "Stayed within the entry limit for the week",
            plan.max_trades is not None,
            plan.max_trades is None or n <= plan.max_trades,
            f"{n} of {plan.max_trades}",
        ),
        _check(
            "on_signal", "Entered on an armed signal", plan.signal_only and n > 0, signalled == n, f"{signalled} of {n}"
        ),
        _check("focus_before_open", "Focus name chosen before the open", n > 0, focused == n, f"{focused} of {n}"),
    ]


def score_pct(checks: Sequence[Mapping[str, Any]]) -> int | None:
    """Passed over applicable, as a whole percent; None when nothing applies."""
    applicable = [c for c in checks if c["applicable"]]
    return round(100 * sum(bool(c["passed"]) for c in applicable) / len(applicable)) if applicable else None


# -- the review ---------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class DayFact:
    """One ended day's summary (02p b6)."""

    day: date
    passed: bool  # passed unwatched
    entries: int
    exits: int
    realized_usd: float
    gap_usd: float
    intraday_usd: float
    unrealized_change_usd: float
    balance_usd: float
    equity_usd: float
    max_open_seen: int = 0  # the most holds open at once that day


@dataclass(frozen=True)
class HoldFact:
    id: int
    symbol: str
    side: Side
    shares: int
    entry_day: date
    entry_price: float  # as she saw it that day
    entry_price_adj: float  # the same price on the adjusted basis (`to_adjusted`)
    exit_day: date | None
    exit_price: float | None
    exit_price_adj: float | None
    pnl_usd: float  # as of the week's last close: realized if it exited in the week, else marked at that close
    gap_usd: float | None = None
    r: float | None = None
    stop: str = "none"


@dataclass(frozen=True)
class ReviewInputs:
    days: Sequence[date]
    basis_day: date
    week_no: int
    plan: WeekPlan
    day_facts: Sequence[DayFact]
    holds: Sequence[HoldFact]
    entries: Sequence[EntryFact]
    closes: Mapping[str, pd.Series]
    sources: Mapping[str, str]
    stop_events: Sequence[tuple[int, bool]] = ()
    benchmark: pd.Series | None = None
    focus: Mapping[str, date] = field(default_factory=dict)
    flags: Mapping[date, Sequence[str]] = field(default_factory=dict)


def _total(values: Iterable[float]) -> float | None:
    data = list(values)
    return round(sum(data), 2) if data else None


def _signed_pts(x: float) -> str:
    text = f"{abs(x):.1f}"
    return text if text == "0.0" else ("+" if x > 0 else "−") + text


def _join(items: list[str]) -> str:
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " and " + items[-1]


def _copy(selection: float | None, timing: float | None, rows: list[dict[str, Any]]) -> list[str]:
    ranked = [(r["selection_rank"], r["selection_of"]) for r in rows if r["selection_rank"] is not None]
    if selection is None or not ranked:
        return []
    universe = {of for _, of in ranked}
    places = [ordinal(rank) for rank, _ in ranked]
    where = (
        f"{_join(places)} of {universe.pop()}"
        if len(universe) == 1
        else _join([f"{ordinal(r)} of {o}" for r, o in ranked])
    )
    line = (
        f"Selection {_signed_pts(selection)} pts vs the universe median"
        f" · your {'hold' if len(ranked) == 1 else 'holds'} ranked {where}"
    )
    return [line if timing is None else f"{line} · Timing {_signed_pts(timing)} pts"]


def _hold_row(
    h: HoldFact, x: ReviewInputs, week: WeekSpan, closes: Mapping[str, pd.Series], number: Mapping[date, int]
) -> dict[str, Any]:
    first, last = week.days[0], week.days[-1]
    exited = h.exit_day is not None and h.exit_day <= last  # an exit after the week is not known in it
    row: dict[str, Any] = {
        "hold_id": h.id,
        "symbol": h.symbol,
        "side": h.side,
        "shares": h.shares,
        "entry_day_no": number[h.entry_day],
        "entry_price": h.entry_price,
        "status": "open",
        "exit_day_no": None,
        "exit_price": None,
        "days_held": number[last] - number[h.entry_day] + 1,
        "pnl_usd": h.pnl_usd,
        "r": h.r,
        "gap_usd": h.gap_usd,
        "stop": h.stop,
        "selection_rank": None,
        "selection_of": None,
        "selection_edge_pts": None,
        "timing_edge_pts": None,
    }
    if exited:
        assert h.exit_day is not None
        row |= {
            "status": "closed",
            "exit_day_no": number[h.exit_day],
            "exit_price": h.exit_price,
            "days_held": number[h.exit_day] - number[h.entry_day] + 1,
        }
    start, end = hold_span(x.days, x.basis_day, week, h.entry_day, h.exit_day)
    returns = universe_returns(closes, start, end)
    if h.symbol not in returns:
        return row
    universe_median = median(returns.values())
    assert universe_median is not None
    row["selection_rank"], row["selection_of"] = selection_rank(h.side, h.symbol, returns)
    row["selection_edge_pts"] = selection_edge(h.side, returns[h.symbol], universe_median)
    c0, c1 = _close(closes.get(h.symbol), start), _close(closes.get(h.symbol), end)
    entry_leg = h.entry_price_adj if h.entry_day >= first else c0  # carried in: her leg starts at the week
    exit_leg = h.exit_price_adj if exited else c1
    if entry_leg is not None and exit_leg is not None and c0 is not None and c1 is not None:
        row["timing_edge_pts"] = timing_edge(h.side, entry_leg, exit_leg, c0, c1)
    return row


def _source_quality(returns: Mapping[str, float], sources: Mapping[str, str]) -> list[dict[str, Any]]:
    by_source: dict[str, list[float]] = {}
    for symbol, r in returns.items():
        if symbol in sources:
            by_source.setdefault(sources[symbol], []).append(r)

    def order(tag: str) -> tuple[int, str]:
        return (SOURCE_ORDER.index(tag) if tag in SOURCE_ORDER else len(SOURCE_ORDER), tag)

    return [
        {"source": tag, "median_return_pct": _pts(float(_median(by_source[tag]))), "n": len(by_source[tag])}
        for tag in sorted(by_source, key=order)
    ]


def compute_review(x: ReviewInputs) -> dict[str, Any]:
    """The weekly review of 02p e1 as plain JSON-able data (None where an input is missing)."""
    week = next((w for w in week_spans(x.days) if w.week_no == x.week_no), None)
    if week is None:
        raise ValueError(f"This thread has no week {x.week_no}")
    first, last = week.days[0], week.days[-1]
    number = {d: i for i, d in enumerate(x.days, 1)}
    closes = {symbol: _through(series, last) for symbol, series in x.closes.items()}
    opening = _prior(x.days, x.basis_day, first)  # the close before the week
    week_returns = universe_returns(closes, opening, last)
    week_median = median(week_returns.values())

    # holds: those with a day in the week, in entry order
    active = sorted(
        (h for h in x.holds if h.entry_day <= last and (h.exit_day is None or h.exit_day >= first)),
        key=lambda h: (h.entry_day, h.id),
    )
    rows = [_hold_row(h, x, week, closes, number) for h in active]
    closed = [row for row in rows if row["status"] == "closed"]
    pnls = [row["pnl_usd"] for row in closed]
    wins, losses = [p for p in pnls if p > 0], [p for p in pnls if p < 0]

    # days, equity and adherence
    facts = sorted((f for f in x.day_facts if f.day <= last and f.day in number), key=lambda f: f.day)
    in_week = [f for f in facts if f.day >= first]
    entries = [e for e in x.entries if week.first_day_no <= e.day_no <= week.last_day_no]
    checks = adherence_checks(x.plan, entries, x.stop_events, max((f.max_open_seen for f in in_week), default=0))
    adherence = score_pct(checks)
    days_out = []
    for f in in_week:
        mine = [e for e in entries if e.day_no == number[f.day]]
        day_checks = [c for c in adherence_checks(x.plan, mine, (), f.max_open_seen) if c["id"] in DAY_CHECKS]
        days_out.append(
            {
                "day_no": number[f.day],
                "weekday": WEEKDAYS[f.day.weekday()],
                "watched": "no" if f.passed else "yes",
                "entries": f.entries,
                "exits": f.exits,
                "realized_usd": f.realized_usd,
                "gap_usd": f.gap_usd,
                "intraday_usd": f.intraday_usd,
                "adherence_pct": score_pct(day_checks) if mine else None,
            }
        )

    # tiles
    realized = _total(f.realized_usd for f in in_week)
    unrealized = _total(f.unrealized_change_usd for f in in_week)
    equity_change = None if realized is None or unrealized is None else round(realized + unrealized, 2)
    gap = _total(f.gap_usd for f in in_week)
    benchmark = None if x.benchmark is None else _through(x.benchmark, last)
    spy_a, spy_b = _close(benchmark, opening), _close(benchmark, last)
    selection = _r2(mean(r["selection_edge_pts"] for r in rows if r["selection_edge_pts"] is not None))
    timing = _r2(mean(r["timing_edge_pts"] for r in rows if r["timing_edge_pts"] is not None))
    tiles = {
        "realized_usd": realized,
        "unrealized_change_usd": unrealized,
        "equity_change_usd": equity_change,
        "balance_usd": in_week[-1].balance_usd if in_week else None,
        "win_rate": round(len(wins) / len(pnls), 3) if pnls else None,
        "avg_win_usd": _r2(mean(wins)),
        "avg_loss_usd": _r2(mean(losses)),
        "avg_days_held": _r2(mean(row["days_held"] for row in closed)),
        "gap_usd": gap,
        "gap_share_pct": round(100 * gap / equity_change, 1) if gap is not None and equity_change else None,
        "adherence_pct": adherence,
        "selection_pts": selection,
        "timing_pts": timing,
        "spy_return_pct": None if spy_a is None or spy_b is None else _pts(spy_b / spy_a - 1),
        "universe_median_return_pct": None if week_median is None else _pts(week_median),
        "universe_mean_return_pct": _r2(None if not week_returns else 100 * fmean(week_returns.values())),
    }

    # the universe pictures
    held = {h.symbol for h in active}
    starred = {symbol for symbol, day in x.focus.items() if day <= last}
    heat = [
        {
            "symbol": symbol,
            "source": x.sources.get(symbol),
            "return_pct": _pts(r),
            "held": "yes" if symbol in held else "no",
            "focus": "yes" if symbol in starred else "no",
        }
        for symbol, r in sorted(week_returns.items(), key=lambda item: (-item[1], item[0]))
    ]

    flagged: dict[str, date] = {}  # each name once, at its first flag in the week
    for d in sorted(x.flags):
        if first <= d <= last:
            for symbol in x.flags[d]:
                flagged.setdefault(symbol, d)
    flagged_returns = [
        r
        for symbol, d in flagged.items()
        if (r := _return(closes, symbol, max(_prior(x.days, x.basis_day, d), opening), last)) is not None
    ]
    filter_quality = None
    if flagged_returns and week_median is not None:
        flagged_median = float(_median(flagged_returns))
        filter_quality = {
            "n": len(flagged_returns),
            "median_return_pct": _pts(flagged_median),
            "universe_median_pct": _pts(week_median),
            "edge_pts": _pts(flagged_median - week_median),
        }

    untraded = []  # starred, never held: where would they have ranked from the star day on
    for symbol, day in sorted(x.focus.items()):
        if day > last or symbol in held:
            continue
        returns = universe_returns(closes, max(_prior(x.days, x.basis_day, day), opening), last)
        if symbol in returns:
            rank, of = selection_rank("long", symbol, returns)
            untraded.append({"symbol": symbol, "rank": rank, "of": of, "return_pct": _pts(returns[symbol])})
    untraded.sort(key=lambda row: (row["rank"], row["symbol"]))

    return {
        "week": {
            "week_no": week.week_no,
            "label": week.label,
            "first_day_no": week.first_day_no,
            "last_day_no": week.last_day_no,
        },
        "tiles": tiles,
        "equity": [{"day_no": number[f.day], "balance_usd": f.balance_usd, "equity_usd": f.equity_usd} for f in facts],
        "days": days_out,
        "holds": rows,
        "heat": heat,
        "adherence": {"score_pct": adherence, "checks": checks},
        "filter_quality": filter_quality,
        "source_quality": _source_quality(week_returns, x.sources),
        "focus_untraded": untraded,
        "copy": _copy(selection, timing, rows),
    }
