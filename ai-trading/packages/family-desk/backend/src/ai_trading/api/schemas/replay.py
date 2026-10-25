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
from ai_trading.contracts.practice_block import PracticeBlockV1
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
    day_list_id: int | None  # the day list this session practises; null for a standalone session
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
    day_list_id: int | None
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
    age_s: int  # seconds from this print to the playhead; a mark priced off an old print carries a warning


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
    quiet_s: int | None  # seconds with no eligible print, once that passes a minute: a halt looks like this
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
    warning: str | None  # set when the mark was priced off a print older than 30 seconds


class MarkUndoOut(BaseModel):
    removed_mark_id: int
    open_trade: OpenTradeOut | None
    journal: JournalOut


# -- daily-list practice (02o-b v1) ---------------------------------------------------------------------------


DayListStatus = Literal["listed", "practicing", "ended"]
StarKind = Literal["traded", "starred"]


class PlanFilterOut(BaseModel):
    id: int
    name: str


class PlanCurrentOut(BaseModel):
    id: int
    day_no: int
    status: DayListStatus


class PlanPrepOut(BaseModel):
    state: Literal["running", "done"]
    done: int
    total: int
    failed: int  # symbols whose bars could not be fetched; they read as no data on the lists


class PracticePlanOut(BaseModel):
    """The saved daily-list plan and its cursor. `next_*` is the day Continue opens (the current one while it is
    not over); `finished` is true once every day has ended. Dates are returned and hidden by a render rule."""

    id: int
    spec: PracticeBlockV1
    sessions: int
    days_opened: int
    filters: list[PlanFilterOut]
    current: PlanCurrentOut | None
    next_day: date | None
    next_weekday: Weekday | None
    next_day_no: int | None
    finished: bool
    prep: PlanPrepOut

    @field_serializer("spec")
    def _spec_as_authored(self, spec: PracticeBlockV1):  # no return annotation: the schema stays `PracticeBlockV1`
        return spec.model_dump(mode="json", by_alias=True, exclude_none=True)


class DailyOut(BaseModel):
    plan: PracticePlanOut | None


class OpenNextOut(BaseModel):
    """`day_list_id` is null while the plan's data is still being prepared (poll `GET /replay/daily`) and once every
    day is done."""

    plan: PracticePlanOut
    day_list_id: int | None


class DayFilterOut(BaseModel):
    id: int
    version_id: int  # frozen on the day: editing the filter later never rewrites an old list
    name: str


class DayScreenOut(BaseModel):
    filters: list[DayFilterOut]
    list_at: str  # "HH:MM" ET
    max_list: int


class ListFilterCountsOut(BaseModel):
    id: int
    version_id: int
    name: str
    scanned: int
    no_data: int
    matches_total: int


class ListUniverseOut(BaseModel):
    """What was scanned. `label` and `footnote` state the universe plainly; show them beside any score."""

    source: Literal["desk"]
    size: int
    scanned: int
    no_data: int
    below_floor: int
    matches_total: int
    shown: int
    prev_basis: bool  # no regular bar of the day exists at the cut: the metric columns are the previous session's
    filters: list[ListFilterCountsOut]
    label: str
    footnote: str


class ListColumnOut(BaseModel):
    key: str
    label: str
    format: str


class CandidateOut(BaseModel):
    """One name on the list, as of `data_through`. `list_price` is the price at the evaluating filter's cut."""

    rank: int
    symbol: str
    filters: list[str]
    rank_value: FiniteFloat | None
    matched_since: datetime
    operands: dict[str, FiniteFloat | None]
    list_price: FiniteFloat
    price_at: datetime
    prior_close: FiniteFloat | None
    reported_before_open: bool  # an explicit before-the-open report (or yesterday's after-close one); never directional
    metrics: dict[str, FiniteFloat | None]


class StarOut(BaseModel):
    symbol: str
    starred_clock: datetime  # the day clock when she starred it (the list time before the day starts)


class DaySessionOut(BaseModel):
    id: int
    symbol: str
    status: SessionStatus


class PeekDailyBarOut(BaseModel):
    t: date
    o: FiniteFloat
    h: FiniteFloat
    l: FiniteFloat  # noqa: E741 -- the wire name
    c: FiniteFloat
    v: FiniteFloat


class PeekMinuteBarOut(BaseModel):
    t: datetime
    o: FiniteFloat
    h: FiniteFloat
    l: FiniteFloat  # noqa: E741
    c: FiniteFloat
    v: FiniteFloat


class PeekLevelsOut(BaseModel):
    prior_high: FiniteFloat | None = None
    prior_low: FiniteFloat | None = None
    prior_close: FiniteFloat | None = None
    premarket_high: FiniteFloat | None = None
    premarket_low: FiniteFloat | None = None


class PeekOut(BaseModel):
    """Pre-open chart data for one candidate, cut at `data_through`: the same rebased daily bars the list was
    screened on, and the day's minutes through the cut."""

    symbol: str
    data_through: datetime
    list_price: FiniteFloat | None = None
    daily: list[PeekDailyBarOut]
    minutes: list[PeekMinuteBarOut]
    levels: PeekLevelsOut


class DayJournalSessionOut(BaseModel):
    id: int
    symbol: str
    trades: int
    pnl_usd: FiniteFloat
    adherence_pct: int | None


class DayJournalOut(BaseModel):
    sessions: list[DayJournalSessionOut]
    trades: int
    pnl_usd: FiniteFloat


class ReviewRowOut(BaseModel):
    symbol: str
    list_price: FiniteFloat
    window_end_price: FiniteFloat | None
    move_pct: FiniteFloat | None
    close_price: FiniteFloat | None
    close_move_pct: FiniteFloat | None
    high_pct: FiniteFloat | None
    low_pct: FiniteFloat | None
    range_pct: FiniteFloat | None
    rank: int | None  # 1 = the biggest absolute move from the list price
    picked: StarKind | None


class SelectionPickOut(BaseModel):
    symbol: str
    kind: StarKind
    move_pct: FiniteFloat
    rank: int


class SelectionOut(BaseModel):
    picks: list[SelectionPickOut]
    median_abs_move_pct: FiniteFloat | None
    picks_avg_abs_move_pct: FiniteFloat | None


class ReviewOut(BaseModel):
    """Every candidate's move from its list price to the window end and the close. Only present once the day ended."""

    window_end: datetime
    of: int  # candidates with a move
    rows: list[ReviewRowOut]
    selection: SelectionOut


class DayListOut(BaseModel):
    """One practice day. Before `status` is `ended` nothing here is later than `data_through` (the list, the stars,
    Peek) or the day clock; `review` and `journal` are null until then."""

    id: int
    plan: PracticePlanOut
    day: date
    weekday: Weekday
    day_no: int
    of: int
    status: DayListStatus
    list_at: datetime
    data_through: datetime
    screen: DayScreenOut
    universe: ListUniverseOut
    columns: list[ListColumnOut]
    candidates: list[CandidateOut]
    watch: list[StarOut]
    clock: datetime | None
    sessions: list[DaySessionOut]
    warnings: list[str]
    peek: PeekOut | None
    journal: DayJournalOut | None
    review: ReviewOut | None
    notes: str | None
    rating: int | None
    created_at: datetime
    ended_at: datetime | None
    stamp: Stamp


class DayListPatch(BaseModel):
    """PATCH body: the stars (at most five names from the list), notes, and the self-rating. A key left out is left
    alone; `null` clears notes and rating."""

    watch: list[str] | None = Field(default=None, max_length=5)
    notes: str | None = Field(default=None, max_length=2000)
    rating: int | None = Field(default=None, ge=1, le=5)


class DaySessionIn(BaseModel):
    symbol: str = Field(pattern=r"^[A-Z][A-Z0-9.]{0,9}$")
