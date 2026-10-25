"""Response and request models for the Practice (replay) lane, `/api/desk/replay/*` (02o §b2, §c5).

What she authors (`ReplaySessionV1`, `PracticeMarkV1`) is a contract (`ai_trading.contracts`); what the
server computes is plain Pydantic here. Numbers are `FiniteFloat` or null, timestamps ISO-8601 UTC.

No-lookahead shape rules (02o decision 1): nothing in these models can carry a value past the session's
`revealed_through`. The would-fire list is never a field of an active session (only `fires_so_far` per
armed strategy). A tape row is `[time, price, size, tick]`, oldest first.
"""

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field, FiniteFloat, field_serializer

from ai_trading.api.schemas.common import Stamp
from ai_trading.contracts.replay_session import ReplaySessionV1

Interval = Literal["1m", "5m", "15m"]
TapeFeed = Literal["sip", "iex"]
SessionStatus = Literal["active", "ended"]
ArmedSource = Literal["alert_strategy", "filter"]
Bias = Literal["bullish", "bearish", "neutral"]
NotableTag = Literal["gap_up", "gap_down", "heavy_volume", "earnings"]
Weekday = Literal["Mon", "Tue", "Wed", "Thu", "Fri"]
MarkKind = Literal["long_entry", "short_entry", "long_exit", "short_exit", "stop", "note"]
Side = Literal["long", "short"]
PaceBand = Literal["quiet", "steady", "busy", "frantic"]


# -- days ---------------------------------------------------------------------------------------------------


class ReplayDayOut(BaseModel):
    """One notable day. Spoiler-free: only what a trader knows at the open (the gap) plus non-directional heat
    (volatility rank, heavy volume). Never the day's change, range, close, or close location."""

    symbol: str
    day: date
    weekday: Weekday
    rank: int  # 1 = the symbol's most volatile session of the last year
    rv_pct_rank: FiniteFloat  # 100 * (N - rank) / N over the symbol's last 252 sessions
    gap_pct: FiniteFloat | None
    tags: list[NotableTag]
    attempts: int  # her sessions on this symbol and day


class ReplayDaysOut(BaseModel):
    days: list[ReplayDayOut]
    symbols: list[str]  # the symbols notable days are listed for (her watchlist symbols)
    lookback_sessions: int
    stamp: Stamp


# -- marks, trades, journal ----------------------------------------------------------------------------------


class MarkOut(BaseModel):
    id: int
    seq: int
    kind: MarkKind
    at: datetime  # the playhead when it was placed: the server stamps it
    price: FiniteFloat | None  # the last print at or before `at`; null for a note
    shares: int | None
    stop_price: FiniteFloat | None
    note: str | None
    trade_no: int | None
    source: Literal["her", "auto"]


class OpenTradeOut(BaseModel):
    trade_no: int
    side: Side
    shares: int
    entry_price: FiniteFloat
    stop_price: FiniteFloat | None
    last_price: FiniteFloat
    unrealized_usd: FiniteFloat
    r: FiniteFloat | None  # unrealized R when a stop note exists


class JournalTotalsOut(BaseModel):
    pnl_usd: FiniteFloat
    r_total: FiniteFloat
    trades: int
    wins: int
    losses: int
    scratches: int
    win_rate: FiniteFloat | None  # 0..1, null with no trades
    avg_win_usd: FiniteFloat | None
    avg_loss_usd: FiniteFloat | None
    largest_loss_usd: FiniteFloat | None


class JournalTradeOut(BaseModel):
    no: int
    side: Side
    entry_at: datetime
    entry_price: FiniteFloat
    exit_at: datetime
    exit_price: FiniteFloat
    shares: int
    pnl_usd: FiniteFloat
    r: FiniteFloat | None
    stop_price: FiniteFloat | None
    on_signal: bool
    exit_source: Literal["her", "auto"]


class AdherenceCheckOut(BaseModel):
    id: Literal["stop_set", "stop_honored", "on_signal", "max_loss", "max_trades"]
    label: str
    applicable: bool
    passed: bool
    detail: str  # "3 of 3"


class AdherenceOut(BaseModel):
    score_pct: int | None  # passed / applicable; null when no check applies
    hint: str | None  # "Add a plan to get an adherence score" when score_pct is null
    checks: list[AdherenceCheckOut]


class SignalVsTradeOut(BaseModel):
    time: datetime
    name: str
    close: FiniteFloat
    chg_15m_pct: FiniteFloat | None
    chg_30m_pct: FiniteFloat | None
    her: str  # "entered 2 min later" | "no trade"


class PnlPointOut(BaseModel):
    t: datetime
    pnl_usd: FiniteFloat


class JournalOut(BaseModel):
    """Live while the session is active (realized plus the open trade marked at the playhead); final after
    `end`. `signals_vs_trades` and the 15/30-minute changes look past the playhead, so they are empty until
    the session has ended."""

    totals: JournalTotalsOut
    trades: list[JournalTradeOut]
    adherence: AdherenceOut
    signals_vs_trades: list[SignalVsTradeOut]
    pnl_series: list[PnlPointOut]


# -- sessions -----------------------------------------------------------------------------------------------


class ArmedOut(BaseModel):
    source: ArmedSource
    id: int
    version_id: int  # snapshotted at start: editing the strategy later never changes this session
    name: str
    bias: Bias | None
    fires_so_far: int  # released fires only; a count of future fires would be lookahead


class ReplaySessionOut(BaseModel):
    id: int
    attempt: int
    status: SessionStatus
    spec: ReplaySessionV1
    window_start: datetime
    window_end: datetime
    revealed_through: datetime
    tape_feed: TapeFeed
    armed: list[ArmedOut]
    marks: list[MarkOut]
    open_trade: OpenTradeOut | None
    journal: JournalOut
    notes: str | None
    rating: int | None
    created_at: datetime
    ended_at: datetime | None
    stamp: Stamp

    @field_serializer("spec")
    def _spec_as_authored(
        self, spec: ReplaySessionV1
    ):  # no return annotation: the OpenAPI schema stays `ReplaySessionV1`
        """The spec goes out the way she authored it: an unset plan field is absent, never null (the Zod contract,
        which the web app parses it with, does not accept null there)."""
        return spec.model_dump(mode="json", by_alias=True, exclude_none=True)


class ReplaySessionSummaryOut(BaseModel):
    """A row of the hub's Resume card and Recent sessions table."""

    id: int
    symbol: str
    day: date
    attempt: int
    status: SessionStatus
    hide_date: Literal["yes", "no"]
    revealed_through: datetime
    window_end: datetime
    trades: int
    pnl_usd: FiniteFloat | None
    adherence_pct: int | None
    updated_at: datetime


class ReplaySessionPatch(BaseModel):
    """PATCH body: notes and the self-rating only."""

    notes: str | None = Field(default=None, max_length=2000)
    rating: int | None = Field(default=None, ge=1, le=5)


# -- advance and feed ---------------------------------------------------------------------------------------


class AdvanceIn(BaseModel):
    """Exactly one of `to` and `step`. `to` at or before `revealed_through` answers an empty delta; `to` past
    the window end is clamped and `at_end` is true. `step: "next_signal"` reveals through the next would-fire bar
    close (a strategy-testing tool: it tells her a signal is coming); with none left it answers 422."""

    to: datetime | None = None
    step: Literal["bar", "next_signal"] | None = None
    interval: Interval | None = None
    min_size: int = Field(default=0, ge=0, le=1_000_000)
    min_notional: int = Field(default=0, ge=0, le=1_000_000_000)  # USD; the "Big only" chip
    max_prints: int = Field(default=500, ge=1, le=2000)


class ReplayBarOut(BaseModel):
    t: datetime  # the bar's start
    o: FiniteFloat
    h: FiniteFloat
    l: FiniteFloat  # noqa: E741 -- the wire name
    c: FiniteFloat
    v: FiniteFloat
    ext: bool  # an extended-hours bar


class FormingBarOut(BaseModel):
    """The current display bar built from revealed closed 1-minute bars; it updates once a minute."""

    t: datetime
    o: FiniteFloat
    h: FiniteFloat
    l: FiniteFloat  # noqa: E741
    c: FiniteFloat
    v: FiniteFloat


class PaceOut(BaseModel):
    """Eligible prints and shares per market second over the last `window_s` seconds before the playhead."""

    window_s: int
    prints_per_s: FiniteFloat
    shares_per_s: FiniteFloat
    x_of_avg: FiniteFloat | None  # shares per second over the prior 10-session average; null without a history
    band: PaceBand | None  # < 1.5 quiet, 1.5-4 steady, 4-8 busy, >= 8 frantic


class PrintsOut(BaseModel):
    feed: TapeFeed
    # [time, price, size, tick] oldest first; tick 1 up, -1 down, 0 same (the tick rule: no bid/ask exists here)
    rows: list[tuple[datetime, FiniteFloat, int, Literal[-1, 0, 1]]]
    count: int  # eligible prints in the window, before the size filter and the cap
    volume: int  # shares in those prints
    shown: int  # len(rows); smaller than the filtered count when the tape is fast and capped
    big_print_usd: int  # a print of at least this notional is a big print (the amber highlight)
    pace: PaceOut | None


class ReplaySignalOut(BaseModel):
    source: ArmedSource
    id: int
    name: str
    bias: Bias | None
    bar_time: datetime
    bar_close: datetime
    close: FiniteFloat
    evidence: dict[str, FiniteFloat]


class ReplayLevelsOut(BaseModel):
    prior_close: FiniteFloat | None = None
    session_high: FiniteFloat | None = None
    session_low: FiniteFloat | None = None
    opening_range_high: FiniteFloat | None = None
    opening_range_low: FiniteFloat | None = None


class LastPrintOut(BaseModel):
    price: FiniteFloat
    at: datetime


class AdvanceOut(BaseModel):
    """What the playhead revealed in `(previous, revealed_through]`: display-interval bars that closed inside
    it, the forming bar, the prints (size-filtered, capped), the would-fire signals whose bar closed inside it,
    and the levels, last print and open trade at the new playhead."""

    revealed_through: datetime
    at_end: bool
    bars: list[ReplayBarOut]
    forming: FormingBarOut | None
    prints: PrintsOut
    signals: list[ReplaySignalOut]
    levels: ReplayLevelsOut
    last: LastPrintOut | None
    open_trade: OpenTradeOut | None
    stamp: Stamp


class FeedOut(AdvanceOut):
    """Everything revealed so far, for resume and interval switches: `bars` is the lookback (up to 10 prior
    sessions, at `interval`) plus the revealed window; `prints` is the last minute's prints (at most 200);
    `signals` is every released signal (the whole list after `end`)."""

    interval: Interval
    window_start: datetime  # where the revealed window starts inside `bars`


# -- marks --------------------------------------------------------------------------------------------------


class MarkResultOut(BaseModel):
    mark: MarkOut
    open_trade: OpenTradeOut | None
    journal: JournalOut


class MarkUndoOut(BaseModel):
    removed_mark_id: int
    open_trade: OpenTradeOut | None
    journal: JournalOut
