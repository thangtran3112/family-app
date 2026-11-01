"""Response and request models for the Practice (replay) lane, `/api/desk/replay/*` (02o §b2, §c5).

What she authors (`ReplaySessionV1`, `PracticeMarkV1`) is a contract (`ai_trading.contracts`); what the
server computes is plain Pydantic here. Numbers are `FiniteFloat` or null, timestamps ISO-8601 UTC.

No-lookahead shape rules (02o decision 1): nothing in these models can carry a value past the session's
`revealed_through`. The would-fire list is never a field of an active session (only `fires_so_far` per
armed strategy). A tape row is `[time, price, size, tick]`, oldest first.
"""

from datetime import date, datetime
from typing import ClassVar, Literal

from pydantic import BaseModel, ConfigDict, Field, FiniteFloat, field_serializer

from ai_trading.api.schemas.common import Stamp, SwingOptional
from ai_trading.api.schemas.threads import ThreadBriefOut, ThreadSummaryOut
from ai_trading.contracts.practice_block import PracticeBlockV1
from ai_trading.contracts.replay_session import ReplaySessionV1

Interval = Literal["1m", "5m", "15m"]
TapeFeed = Literal["sip", "iex", "off"]  # "off": a swing thread's default, no tape is read (02p a4)
SessionStatus = Literal["active", "ended"]
ArmedSource = Literal["alert_strategy", "filter"]
Bias = Literal["bullish", "bearish", "neutral"]
NotableTag = Literal["gap_up", "gap_down", "heavy_volume", "earnings"]
Weekday = Literal["Mon", "Tue", "Wed", "Thu", "Fri"]
MarkKind = Literal["long_entry", "short_entry", "long_exit", "short_exit", "stop", "note"]
Side = Literal["long", "short"]
OrderSide = Literal["buy", "sell"]  # a buy is a long entry, a sell is a short entry
WorkingOrderType = Literal["limit", "stop", "stop_limit"]  # a market entry is a mark (`POST .../marks`)
OrderStatus = Literal["working", "filled", "cancelled"]
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


class OrderOut(BaseModel):
    """A practice order that was not filled at once, and what became of it (the fill rules are in the orders module).
    A fill is also an entry mark (`mark_id`)."""

    id: int
    side: OrderSide
    type: WorkingOrderType
    shares: int
    limit_price: FiniteFloat | None
    stop_price: FiniteFloat | None  # the stop leg's trigger
    status: OrderStatus
    placed_at: datetime  # the playhead when it was placed
    triggered_at: datetime | None  # stop-limit: when the stop leg triggered
    closed_at: datetime | None  # when it filled or was cancelled, on the tape's clock
    fill_price: FiniteFloat | None
    mark_id: int | None
    reason: str | None  # why it was cancelled, when the server did it


class OpenTradeOut(SwingOptional):
    """The name's open trade. For a swing session it is the name's practice hold (`trade_no` is the hold id) and the
    four last fields say how long it has been held and which price it is valued at; a day session leaves them out."""

    swing_only: ClassVar[tuple[str, ...]] = (
        "opened_day_no",
        "days_held",
        "gap_usd",
        "price_basis",
        "stop_hit_at",
        "entry_at",
    )

    trade_no: int
    side: Side
    shares: int
    entry_price: FiniteFloat
    stop_price: FiniteFloat | None
    last_price: FiniteFloat  # a swing hold is never null here: its prior close stands in before the first price
    unrealized_usd: FiniteFloat
    r: FiniteFloat | None  # unrealized R when a stop note exists
    opened_day_no: int | None = None
    days_held: int | None = None  # counts the day itself
    gap_usd: FiniteFloat | None = None  # a carried hold's overnight gap so far, signed for its side
    price_basis: Literal["prior_close", "last"] | None = None
    # a day's `DaySessionOut.position` only: when play paused because this trade's stop was crossed (an exit, a new
    # entry or a new stop note clears it). Left out while there is no pause.
    stop_hit_at: datetime | None = None
    # a day trade only: when the entry mark was placed (the Portfolio shows it and orders the open trades by it).
    # A swing hold leaves it out; its entry is a day number.
    entry_at: datetime | None = None


# -- swing session shapes (02p): holds, the stop pause, the day strip and the daily block ------------------------------


class EarningsChipOut(BaseModel):
    """An explicit report date and timing within the next ten sessions. Never a guess from a gap (02p a3 rule 9)."""

    in_sessions: int  # 0 is the day itself
    timing: Literal["before open", "after close"]


class HoldOut(BaseModel):
    """A practice hold as the screens read it. Days are numbers and weekdays, never dates. An open hold carries
    `unrealized_usd`, a closed one `pnl_usd`; `price_basis` says which price an open one is valued at."""

    id: int
    symbol: str
    side: Side
    shares: int  # after any split since entry
    entry_day_no: int
    entry_weekday: Weekday
    entry_price: FiniteFloat
    days_held: int
    stop_at_entry: FiniteFloat | None
    stop_price: FiniteFloat | None
    stop_hit: Literal["yes", "no"]  # the stop was crossed and the pause not yet answered
    status: Literal["open", "closed"]
    exit_day_no: int | None
    exit_price: FiniteFloat | None
    exit_source: Literal["her", "auto"] | None
    last_close: FiniteFloat | None  # the last official close the hold was marked at, on its current share basis
    price_basis: Literal["prior_close", "last"] | None
    unrealized_usd: FiniteFloat | None
    pnl_usd: FiniteFloat | None
    r: FiniteFloat | None
    gap_usd: FiniteFloat | None
    earnings: EarningsChipOut | None
    split_note: str | None


class PausedOut(BaseModel):
    """A stop was crossed: the playhead stopped at the close of the first one-minute bar that did (02p b5). It is a
    pause, never an exit. `also` lists every other hold crossed in the same minute."""

    symbol: str
    stop_price: FiniteFloat
    at: datetime
    price: FiniteFloat
    kind: Literal["cross", "gap"]
    also: list[str]


class StripHoldOut(BaseModel):
    side: Side
    shares: int
    unrealized_usd: FiniteFloat
    stop_price: FiniteFloat | None
    stop_distance_pct: FiniteFloat | None  # positive while the price is on the safe side of the stop
    stopped: Literal["yes", "no"]


class StripRowOut(BaseModel):
    """A row of the day strip: every open hold, then the focus names, at most ten. `last` is the last revealed regular
    session price at the DAY CLOCK; `chg_pct` is against the restated prior close."""

    symbol: str
    source: Literal["hold", "focus"]
    last: FiniteFloat | None
    chg_pct: FiniteFloat | None
    hold: StripHoldOut | None


class DailyBarOut(BaseModel):
    t: date
    o: FiniteFloat
    h: FiniteFloat
    l: FiniteFloat  # noqa: E741 -- the wire name
    c: FiniteFloat
    v: FiniteFloat


class DailyHoldMarkerOut(BaseModel):
    entry_t: date
    side: Side
    entry_price: FiniteFloat
    stop_price: FiniteFloat | None


class DailyBlockOut(BaseModel):
    """The Daily chart: the rebased bars through the session before the day (never the day's own), the forming candle
    built from revealed one-minute bars, and this name's open hold for the entry marker and the stop line."""

    bars: list[DailyBarOut]
    forming: DailyBarOut | None
    holds: list[DailyHoldMarkerOut]


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
    thread_id: int | None  # the practice thread its realized trades book into; null for a standalone session
    thread: ThreadBriefOut | None = None  # the workspace header: the SIMULATED balance and today's realized P/L
    attempt: int
    status: SessionStatus
    spec: ReplaySessionV1
    window_start: datetime
    window_end: datetime
    revealed_through: datetime
    day_clock: datetime | None  # the day list's shared clock; null for a standalone session
    behind_clock: bool  # this name is behind the day clock: its next advance catches it up; no marks until then
    tape_feed: TapeFeed
    armed: list[ArmedOut]
    marks: list[MarkOut]
    open_trade: OpenTradeOut | None
    orders: list[OrderOut] = []  # the session's orders that were not filled at once, newest last
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
    thread_id: int | None
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
    seen: bool  # false: it fired while she was on another name, so it is on the chart but not scored


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


class AdvanceOut(SwingOptional):
    """What the playhead revealed in `(previous, revealed_through]`: display-interval bars that closed inside
    it, the forming bar, the prints (size-filtered, capped), the would-fire signals whose bar closed inside it,
    and the levels, last print and open trade at the new playhead."""

    swing_only: ClassVar[tuple[str, ...]] = ("paused", "strip", "daily_forming", "fills")

    revealed_through: datetime
    day_clock: datetime | None  # the day list's shared clock; null for a standalone session
    behind_clock: bool  # this name's playhead is behind the day clock (the feed of a name she left)
    at_end: bool
    bars: list[ReplayBarOut]
    forming: FormingBarOut | None
    prints: PrintsOut
    signals: list[ReplaySignalOut]
    levels: ReplayLevelsOut
    last: LastPrintOut | None
    quiet_s: int | None  # seconds with no eligible print, once that passes a minute: a halt looks like this
    open_trade: OpenTradeOut | None
    orders: list[OrderOut] = []
    stamp: Stamp
    # working orders the tape filled inside this advance, as the entry marks they became. Left out while there are none.
    fills: list[MarkOut] | None = None
    # a stop was crossed on any open name of the day: play stopped at the close of its bar (a swing or a day session).
    # Left out of the JSON while there is no pause.
    paused: PausedOut | None = None
    # swing sessions only (02p); left out of a day session's JSON
    strip: list[StripRowOut] | None = None
    daily_forming: DailyBarOut | None = None


class FeedOut(AdvanceOut):
    """Everything revealed so far, for resume and interval switches: `bars` is the lookback (up to 10 prior
    sessions, at `interval`) plus the revealed window; `prints` is the last minute's prints (at most 200);
    `signals` is every released signal (the whole list after `end`)."""

    swing_only: ClassVar[tuple[str, ...]] = (*AdvanceOut.swing_only, "daily")

    interval: Interval
    window_start: datetime  # where the revealed window starts inside `bars`
    daily: DailyBlockOut | None = None  # a swing session only


# -- marks --------------------------------------------------------------------------------------------------


class MarkResultOut(SwingOptional):
    swing_only: ClassVar[tuple[str, ...]] = ("hold",)

    mark: MarkOut
    open_trade: OpenTradeOut | None
    journal: JournalOut
    warning: str | None  # set when the mark was priced off a print older than 30 seconds
    thread: ThreadBriefOut | None = None  # an exit mark books its P/L: the balance after it
    hold: HoldOut | None = None  # a swing session: the hold this mark opened, changed or closed


class MarkUndoOut(SwingOptional):
    swing_only: ClassVar[tuple[str, ...]] = ("hold",)

    removed_mark_id: int
    open_trade: OpenTradeOut | None
    journal: JournalOut
    thread: ThreadBriefOut | None = None  # undoing an exit takes its P/L back out of the balance
    hold: HoldOut | None = None  # a swing session: the hold after the undo (null when an entry was undone)


class OrderIn(BaseModel):
    """A limit, stop or stop-limit entry. Prices are in dollars; `shares` defaults to the session's. A limit order takes
    `limitPrice` only, a stop order `stopPrice` only, a stop-limit both; anything else is a 422 that names the field."""

    model_config = ConfigDict(extra="forbid")

    side: OrderSide
    orderType: WorkingOrderType
    shares: int | None = Field(default=None, ge=1)
    limitPrice: float | None = None
    stopPrice: float | None = None


class OrderResultOut(SwingOptional):
    swing_only: ClassVar[tuple[str, ...]] = ("hold",)

    order: OrderOut
    orders: list[OrderOut]
    mark: MarkOut | None  # set when the order filled at once (a limit through the market)
    open_trade: OpenTradeOut | None
    journal: JournalOut
    warning: str | None
    thread: ThreadBriefOut | None = None
    hold: HoldOut | None = None


class OrderCancelOut(BaseModel):
    order: OrderOut
    orders: list[OrderOut]


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
    thread_id: int | None  # the practice thread this plan's days book into
    spec: PracticeBlockV1
    sessions: int
    days_opened: int
    day_offset: int  # ended days the thread had before this plan: a day's number in the thread is `day_no + day_offset`
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
    """The hub's daily-list card: her plan and cursor, and her active day thread (balance and stats)."""

    plan: PracticePlanOut | None
    thread: ThreadSummaryOut | None


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


class UniverseMembershipOut(BaseModel):
    """Where the scanned names came from (02o-b2): the symbols the Desk recorded for that morning (`universe_days`), or
    today's Desk set for a day before the recording began. `note` says so in plain words."""

    source: Literal["universe_days", "today"]
    recorded_size: int | None  # symbols the Desk recorded that morning; null when no pass recorded it
    scanned_size: int  # the ones the list scanned (the recorded names her plan prepared)
    note: str


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
    membership: UniverseMembershipOut | None = None  # null for a list opened before 02o-b2


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


class RescanCandidateOut(CandidateOut):
    """A name a re-scan shows. `new_since_list`: the day list did not hold it (it cannot be starred or practised)."""

    new_since_list: bool


class RescanOut(BaseModel):
    """The latest re-scan of the day's filters (02o-b2), run at the day clock `as_of` on data through `data_through`.
    It is a view of its own: the frozen list above is unchanged. `seq` counts the day's scans."""

    seq: int
    as_of: datetime
    data_through: datetime
    universe: ListUniverseOut
    columns: list[ListColumnOut]
    candidates: list[RescanCandidateOut]
    new_count: int
    created_at: datetime


class StarOut(BaseModel):
    symbol: str
    starred_clock: datetime  # the day clock when she starred it (the list time before the day starts)


class DaySessionOut(BaseModel):
    """A name she has opened today: a row of the day's portfolio. Flat unless `position` is set."""

    id: int
    symbol: str
    status: SessionStatus
    revealed_through: datetime
    behind_clock: bool  # behind the day clock: its next advance catches it up, and it cannot be marked until then
    has_open_trade: bool  # the name holds an open trade (one per name, at most five across the day)
    trades: int  # closed trades on this name today
    realized_usd: FiniteFloat  # the closed trades' P/L (swing sessions report none here: their holds are scored weekly)
    position: OpenTradeOut | None  # the open trade marked at the DAY CLOCK, not the name's playhead; null when flat


class DayPnlOut(BaseModel):
    """The day's live P/L, SIMULATED: every name's closed trades plus every open trade marked at the one day clock."""

    realized_usd: FiniteFloat
    open_usd: FiniteFloat
    total_usd: FiniteFloat  # realized + open
    open_count: int  # open trades right now, at most five
    as_of: datetime  # the day clock (the list time before the day starts)


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


class DayTradeLineOut(JournalTradeOut):
    """One closed practice trade of the day, with the name it was on."""

    symbol: str


class DayJournalOut(BaseModel):
    """The day's practice result, SIMULATED dollars to the cent: one line per closed trade, the win and loss counts
    (a scratch is neither), and the thread's balance before and after the day (null for a day with no thread)."""

    sessions: list[DayJournalSessionOut]
    trades: int
    pnl_usd: FiniteFloat
    wins: int
    losses: int
    scratches: int
    lines: list[DayTradeLineOut]
    balance_before: FiniteFloat | None
    balance_after: FiniteFloat | None


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
    rank: int | None  # 1 = the biggest gain from the list price to the window end; a loss ranks below every gain
    picked: StarKind | None


class SelectionPickOut(BaseModel):
    symbol: str
    kind: StarKind
    move_pct: FiniteFloat
    rank: int


class SelectionOut(BaseModel):
    """Signed: a loss pulls the median and the average down (D-031 ranked and averaged by size before)."""

    picks: list[SelectionPickOut]
    median_move_pct: FiniteFloat | None
    picks_avg_move_pct: FiniteFloat | None


class ReviewOut(BaseModel):
    """Every candidate's move from its list price to the window end and the close, ranked by the signed move to the
    window end, biggest gain first. Only present once the day ended. `day` is the finished day's date: the screen
    hid it during the day when `dates_hidden`, and shows it here with a line saying so (D-029)."""

    day: date
    dates_hidden: bool
    window_end: datetime
    of: int  # candidates with a move
    rows: list[ReviewRowOut]
    selection: SelectionOut


class WatchCheckOut(BaseModel):
    """ "Traded only names on your watch": data for the screen to render. `traded` is the names she entered a trade on;
    `off_watch` the ones she had not starred. Nothing scores it."""

    starred: list[str]
    traded: list[str]
    off_watch: list[str]
    verdict: Literal["no_trades", "on_watch", "off_watch"]
    label: str


class RelistOfferOut(BaseModel):
    """The in-screen remedy for a list built too early for its filters (D-012): re-list at `list_at` (HH:MM ET), which
    moves the plan's list time, and the practice window's start with it when `window_from` is set."""

    list_at: str
    label: str
    window_from: str | None


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
    day_pnl: DayPnlOut
    watch_check: WatchCheckOut
    thread: ThreadBriefOut | None  # the SIMULATED balance and today's realized P/L of the thread this day books into
    warnings: list[str]
    relist: RelistOfferOut | None
    rescan: RescanOut | None  # the latest re-scan at the day clock; null until she runs one
    peek: PeekOut | None
    journal: DayJournalOut | None
    review: ReviewOut | None
    notes: str | None
    rating: int | None
    created_at: datetime
    ended_at: datetime | None
    stamp: Stamp


class DayListPatch(BaseModel):
    """PATCH body: the stars (at most 20 names from the list), notes, and the self-rating. A key left out is left
    alone; `null` clears notes and rating."""

    watch: list[str] | None = Field(default=None, max_length=20)
    notes: str | None = Field(default=None, max_length=2000)
    rating: int | None = Field(default=None, ge=1, le=5)


class DayRelistIn(BaseModel):
    """POST body: the list time to re-list at, "HH:MM" ET. The plan's rules apply (422)."""

    listAt: str = Field(pattern=r"^([01][0-9]|2[0-3]):[0-5][0-9]$")


class DaySessionIn(BaseModel):
    symbol: str = Field(pattern=r"^[A-Z][A-Z0-9.]{0,9}$")


# -- the recorded universe (02o-b2) ----------------------------------------------------------------------------


class UniverseCoverageOut(BaseModel):
    first_day: date | None  # the first morning a premarket pass recorded the Desk's universe
    last_day: date | None
    days: int


class UniverseDayOut(BaseModel):
    """One morning's recorded membership. `recorded` false: no pass wrote it, so that day's list scans today's set."""

    day: date
    recorded: bool
    size: int | None
    symbols: list[str]
    note: str


class UniverseDaysOut(BaseModel):
    """The `universe_days` read path: its coverage, the first day a new plan should default to (null until 20 finished
    days have been recorded), and with `?day=` that morning's membership."""

    coverage: UniverseCoverageOut
    first_day_default: date | None
    first_day_note: str
    day: UniverseDayOut | None
