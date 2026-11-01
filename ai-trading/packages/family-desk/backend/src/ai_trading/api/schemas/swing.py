"""Response and request models for swing practice (02p), the routes of `api/replay.py` that only a swing thread has.

The session-side shapes (`HoldOut`, `PausedOut`, the strip and the daily block) live in `schemas/replay.py` next to the
session models that carry them, and the thread's `swing` state in `schemas/threads.py`; this module holds the rest:
the universe preview, the swing board (the swing counterpart of `DayListOut`), the plan cursor, the hold list and the
weekly review. Plain Pydantic, snake_case. A swing payload names days by number and weekday; the only dates are the day
list's own `day` (the web hides it by the `hideDates` rule) and the preview's `basis_day` (setup, not a session). Every
dollar figure is SIMULATED and the `label` fields say so in words.
"""

from datetime import date, datetime
from typing import Annotated, Literal

from pydantic import BaseModel, Field, FiniteFloat

from ai_trading.api.schemas.common import Stamp
from ai_trading.api.schemas.replay import (
    DayListStatus,
    DaySessionOut,
    EarningsChipOut,
    HoldOut,
    ListColumnOut,
    PeekDailyBarOut,
    PeekLevelsOut,
    PlanCurrentOut,
    PlanPrepOut,
    StarOut,
    Weekday,
)
from ai_trading.api.schemas.threads import ThreadBriefOut

SwingSource = Literal["watchlist", "manual", "filter", "liquidity"]
# A hand edit is normalised (trimmed, upper-cased) and checked by the service, which answers in plain words at `add.N`.
Typed = Annotated[str, Field(max_length=12)]


# -- the universe preview (setup) ---------------------------------------------------------------------------------


class SwingUniversePreviewIn(BaseModel):
    """What the setup form sends: the dates, her lists and filters, the fill rule, the hand edits and the target size.
    Nothing is written; the first call starts the data prep for the symbols still missing."""

    first_day: date
    sessions: int = Field(ge=15, le=23)
    watchlist_ids: list[int] = Field(default_factory=list, max_length=20)
    filter_ids: list[int] = Field(default_factory=list, max_length=3)  # daily filters only
    fill: Literal["liquidity", "none"] = "liquidity"
    add: list[Typed] = Field(default_factory=list, max_length=50)
    remove: list[Typed] = Field(default_factory=list, max_length=50)
    target: int = Field(default=50, ge=10, le=50)


class UniversePrepOut(BaseModel):
    done: int
    total: int


class UniverseRowOut(BaseModel):
    """A symbol of the table, every figure as of `basis_day`. `warnings` is plain words ("below floor")."""

    symbol: str
    source: SwingSource
    prior_close: FiniteFloat
    chg_20d_pct: FiniteFloat | None
    avg_dollar_volume_20d: FiniteFloat
    atr_pct_14: FiniteFloat | None
    matched: list[str]
    warnings: list[str]


class UniverseExcludedOut(BaseModel):
    """One neutral reason that names no date, so the list reveals nothing about what happened later."""

    symbol: str
    reason: str


class UniverseCountsOut(BaseModel):
    watchlist: int
    manual: int
    filter: int
    liquidity: int
    total: int


class SwingUniversePreviewOut(BaseModel):
    """The table she edits. `state` is `preparing` while symbols are still being fetched (`pending_symbols` of them);
    the rows already shown do not change when the rest arrive. `label` is the survivorship text: show it beside the
    table."""

    basis_day: date  # the session before the first day: every figure is as of its close
    state: Literal["ready", "preparing"]
    prep: UniversePrepOut
    rows: list[UniverseRowOut]
    excluded: list[UniverseExcludedOut]
    counts: UniverseCountsOut
    survivorship: str
    label: str
    pending_symbols: int


# -- the plan cursor and the open-next answer -----------------------------------------------------------------------


class SwingPlanOut(BaseModel):
    """A swing thread's calendar cursor and prep. No dates: `next_day_no` and `next_weekday` only."""

    id: int
    thread_id: int | None
    mode: Literal["swing"]
    sessions: int
    days_opened: int
    current: PlanCurrentOut | None
    next_day_no: int | None
    next_weekday: Weekday | None
    finished: bool
    prep: PlanPrepOut


class SwingOpenNextOut(BaseModel):
    """`POST /daily/next` for a swing thread. `day_list_id` is null while the prep runs (poll `GET /threads/{id}`) and
    once every day is done."""

    kind: Literal["swing"]
    plan: SwingPlanOut
    day_list_id: int | None


# -- the swing board (the day list) ---------------------------------------------------------------------------------


class SwingUniverseOut(BaseModel):
    source: Literal["swing"]
    size: int
    mix: dict[str, int]
    label: str
    footnote: str


class BoardRowOut(BaseModel):
    """One name of the board, every figure read from daily bars through the prior close. A row with no data keeps its
    place with empty figures."""

    symbol: str
    source: SwingSource
    prior_close: FiniteFloat | None
    chg_1d_pct: FiniteFloat | None
    chg_5d_pct: FiniteFloat | None
    chg_20d_pct: FiniteFloat | None
    atr_pct_14: FiniteFloat | None
    rsi_14: FiniteFloat | None
    rvol_10d: FiniteFloat | None
    pct_from_20d_high: FiniteFloat | None
    vs_50d_avg_pct: FiniteFloat | None
    avg_dollar_volume_20d: FiniteFloat | None
    matches: list[str]  # her armed daily filters this name matches
    earnings: EarningsChipOut | None


class SwingPeekOut(BaseModel):
    """Pre-open chart data for one name: daily bars through the prior close, never a minute of the day."""

    symbol: str
    daily: list[PeekDailyBarOut]
    levels: PeekLevelsOut


class StopHitOut(BaseModel):
    symbol: str
    at: str  # "HH:MM" ET
    watched: Literal["yes", "no"]  # no: crossed while she was away and found at the end of the day


class SwingDaySummaryOut(BaseModel):
    """The strip of tiles an ended day serves (02p b6): the equity change split into realized, overnight gap and
    intraday, with the holds as they stood at the close."""

    passed: Literal["yes", "no"]
    realized_usd: FiniteFloat
    gap_usd: FiniteFloat
    intraday_usd: FiniteFloat
    unrealized_change_usd: FiniteFloat
    equity_change_usd: FiniteFloat
    balance_usd: FiniteFloat
    equity_usd: FiniteFloat
    free_cash_usd: FiniteFloat
    holds: list[HoldOut]
    stop_hits: list[StopHitOut]
    late_stars: list[str]  # names starred after the open
    entries: int
    exits: int
    max_open_seen: int


class SwingDayListOut(BaseModel):
    """One swing day: the board as of the prior close, her focus names, the holds pinned above it and the day clock.
    `kind` is always `"swing"`: it tells this model from `DayListOut`. Nothing here is later than the prior close or the
    day clock until `status` is `ended`, when `journal` carries the day's summary."""

    kind: Literal["swing"]
    id: int
    plan: SwingPlanOut
    thread: ThreadBriefOut | None
    day: date
    weekday: Weekday
    day_no: int
    of: int
    week_no: int
    week_label: str
    status: DayListStatus
    clock: datetime | None
    watch: list[StarOut]
    columns: list[ListColumnOut]
    candidates: list[BoardRowOut]
    holds: list[HoldOut]
    free_cash_usd: FiniteFloat | None
    sessions: list[DaySessionOut]
    universe: SwingUniverseOut
    label: str  # the survivorship text
    peek: SwingPeekOut | None
    journal: SwingDaySummaryOut | None
    notes: str | None
    rating: int | None
    created_at: datetime
    ended_at: datetime | None
    stamp: Stamp


# -- holds and weeks ------------------------------------------------------------------------------------------------


class HoldsOut(BaseModel):
    """The thread's holds. Open ones are marked at the LAST ENDED day's close, never later (`as_of_day_no`)."""

    thread_id: int
    as_of_day_no: int | None
    holds: list[HoldOut]
    label: str


class WeekRowOut(BaseModel):
    week_no: int
    label: str
    days: int
    first_day_no: int
    last_day_no: int
    status: Literal["open", "closed"]
    realized_usd: FiniteFloat | None
    equity_change_usd: FiniteFloat | None
    adherence_pct: int | None
    selection_pts: FiniteFloat | None
    timing_pts: FiniteFloat | None


class WeeksOut(BaseModel):
    thread_id: int
    weeks: list[WeekRowOut]
    label: str


class WeekMetaOut(BaseModel):
    week_no: int
    label: str
    first_day_no: int
    last_day_no: int


class WeekTilesOut(BaseModel):
    """The review's tiles. A figure that cannot be computed is null, never a guess."""

    realized_usd: FiniteFloat | None
    unrealized_change_usd: FiniteFloat | None
    equity_change_usd: FiniteFloat | None
    balance_usd: FiniteFloat | None
    win_rate: FiniteFloat | None  # 0..1
    avg_win_usd: FiniteFloat | None
    avg_loss_usd: FiniteFloat | None
    avg_days_held: FiniteFloat | None
    gap_usd: FiniteFloat | None
    gap_share_pct: FiniteFloat | None
    adherence_pct: int | None
    selection_pts: FiniteFloat | None  # side-signed excess return over the universe median, in percent points
    timing_pts: FiniteFloat | None
    spy_return_pct: FiniteFloat | None
    universe_median_return_pct: FiniteFloat | None
    universe_mean_return_pct: FiniteFloat | None


class WeekEquityPointOut(BaseModel):
    day_no: int
    balance_usd: FiniteFloat
    equity_usd: FiniteFloat


class WeekDayOut(BaseModel):
    day_no: int
    weekday: Weekday
    watched: Literal["yes", "no"]
    entries: int
    exits: int
    realized_usd: FiniteFloat
    gap_usd: FiniteFloat
    intraday_usd: FiniteFloat
    adherence_pct: int | None


class WeekHoldOut(BaseModel):
    """A hold active in the week, scored against the universe over its span (02p e2)."""

    hold_id: int
    symbol: str
    side: Literal["long", "short"]
    shares: int
    entry_day_no: int
    entry_price: FiniteFloat
    status: Literal["open", "closed"]  # open: still held at the week's last close
    exit_day_no: int | None
    exit_price: FiniteFloat | None
    days_held: int
    pnl_usd: FiniteFloat
    r: FiniteFloat | None
    gap_usd: FiniteFloat | None
    stop: Literal["none", "set", "honored", "away"]
    selection_rank: int | None  # 1 is the best pick for the hold's side
    selection_of: int | None
    selection_edge_pts: FiniteFloat | None
    timing_edge_pts: FiniteFloat | None


class WeekHeatOut(BaseModel):
    symbol: str
    source: SwingSource | None
    return_pct: FiniteFloat
    held: Literal["yes", "no"]
    focus: Literal["yes", "no"]


class WeekCheckOut(BaseModel):
    id: Literal[
        "stop_set",
        "stop_honored",
        "risk_per_hold",
        "week_loss_limit",
        "entries_per_week",
        "on_signal",
        "focus_before_open",
    ]
    label: str
    applicable: bool
    passed: bool
    detail: str  # "3 of 3"


class WeekAdherenceOut(BaseModel):
    score_pct: int | None  # passed / applicable; null when nothing applies
    checks: list[WeekCheckOut]


class FilterQualityOut(BaseModel):
    n: int
    median_return_pct: FiniteFloat
    universe_median_pct: FiniteFloat
    edge_pts: FiniteFloat


class SourceQualityOut(BaseModel):
    source: str
    median_return_pct: FiniteFloat
    n: int


class FocusUntradedOut(BaseModel):
    """A name she starred and never held: where it would have ranked as a long from the star day on."""

    symbol: str
    rank: int
    of: int
    return_pct: FiniteFloat


class WeekReviewOut(BaseModel):
    """The review of one week (02p e1), as `week.compute_review` builds it. `lines` is the key `copy` on the wire (a
    field cannot be called `copy`): the sentences the screen shows under the tiles."""

    week: WeekMetaOut
    tiles: WeekTilesOut
    equity: list[WeekEquityPointOut]
    days: list[WeekDayOut]
    holds: list[WeekHoldOut]
    heat: list[WeekHeatOut]
    adherence: WeekAdherenceOut
    filter_quality: FilterQualityOut | None
    source_quality: list[SourceQualityOut]
    focus_untraded: list[FocusUntradedOut]
    lines: list[str] = Field(alias="copy")


class WeekOut(BaseModel):
    """A frozen review, or "Week to date" (`to_date` yes) for the open week through the last ended close."""

    week_no: int
    label: str
    status: Literal["open", "closed"]
    to_date: Literal["yes", "no"]
    review: WeekReviewOut
    notes: str | None
    rating: int | None
    universe_label: str
    footnote: str


class WeekPatch(BaseModel):
    """PATCH body: notes and the self-rating only. A key left out is left alone; `null` clears it."""

    notes: str | None = Field(default=None, max_length=2000)
    rating: int | None = Field(default=None, ge=1, le=5)
