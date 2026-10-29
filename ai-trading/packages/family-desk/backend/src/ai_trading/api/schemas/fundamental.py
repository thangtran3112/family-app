"""Pydantic response and request models for the Desktop Fundamental lane (02n §c3), one block per endpoint family. The
generated `frontend/lib/api/openapi.*` is the frozen contract stream F codes against, so a change here is a contract
change: regenerate it with `pnpm gen:api`.

Privacy (02n §c1): the broker account number lives in `accounts.external_id` and has no field in any model here; an
account is `{id, label, type}` and nothing else. `tests/api/test_fundamental_stub.py` scans the schemas for it.
"""

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, FiniteFloat

from ai_trading.api.schemas.common import Stamp
from ai_trading.api.schemas.platform import DashboardMarketOut, MarketStripTileOut

AccountType = Literal["taxable", "ira", "roth"]
AiRating = Literal["buy", "hold", "sell"]
Signal = Literal["buy", "hold", "sell"]
AlertTemplate = Literal["covered_call_income", "short_call_risk", "ai_daily_view"]
Number = FiniteFloat | None


class AccountOut(BaseModel):
    id: int
    label: str
    type: AccountType


class AccountPatch(BaseModel):
    """`PATCH /accounts/{id}`: the owner names an account and says what kind it is (the assignment note and the tax
    flags follow the type)."""

    model_config = ConfigDict(extra="forbid")

    label: str | None = Field(default=None, min_length=1, max_length=40)
    type: AccountType | None = None


class ImportStateOut(BaseModel):
    source: Literal["ibkr_flex"]
    account_scope: Literal["data", "main_interim"]
    statement_date: date | None
    imported_at: datetime | None
    lots: int
    state: Literal["ok", "running", "failed", "not_configured", "none"]


class ImportOut(BaseModel):
    """`POST /holdings/import` answers 202 with the running state."""

    model_config = ConfigDict(populate_by_name=True)

    import_: ImportStateOut = Field(alias="import")


class Fundamentals(BaseModel):
    """02n §c4: the metric keys a holdings row, a `long_term` watchlist row and the `Columns` menu share. Numbers or
    null, never NaN; a date or a rating where the key says so."""

    fwd_pe: Number = None
    pe_vs_5y_median_pct: Number = None
    fcf_yield_pct: Number = None
    revenue_growth_yoy_pct: Number = None
    debt_to_equity: Number = None
    eps_rev_7d_pct: Number = None
    eps_rev_30d_pct: Number = None
    eps_rev_90d_pct: Number = None
    next_earnings: date | None = None
    dividend_yield_pct: Number = None
    ex_dividend: date | None = None
    ai_rating: AiRating | None = None
    ai_target_base: Number = None
    ai_upside_pct: Number = None
    dist_to_252d_high_pct: Number = None
    weight_pct: Number = None
    gain_vs_cost_pct: Number = None
    cc_coverable: int | None = None


class HoldingsTotalsOut(BaseModel):
    market_value: Number
    cost: Number
    unrealized: Number
    unrealized_pct: Number
    day_change: Number
    day_change_pct: Number


class HoldingRowOut(BaseModel):
    symbol: str
    name: str
    account_ids: list[int]
    shares: FiniteFloat
    avg_cost: FiniteFloat
    last: Number
    change_pct: Number
    market_value: Number
    weight_pct: Number
    unrealized_pct: Number
    coverable_contracts: int
    open_calls: int
    next_earnings: date | None
    ai_rating: AiRating | None
    fundamentals: Fundamentals
    stamp: Stamp


class OptionLotOut(BaseModel):
    id: int
    symbol: str
    account_id: int
    right: Literal["C", "P"]
    strike: FiniteFloat
    expiry: date
    contracts: int  # below 0 = short


class HoldingsOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    import_: ImportStateOut = Field(alias="import")
    accounts: list[AccountOut]
    totals: HoldingsTotalsOut
    rows: list[HoldingRowOut]
    option_lots: list[OptionLotOut]


class LotOut(BaseModel):
    account_id: int
    shares: FiniteFloat
    cost_per_share: FiniteFloat
    acquired: date
    term: Literal["short", "long"]
    gain_pct: Number


RiskKind = Literal[
    "delta_above_0_50", "near_strike_near_expiry", "early_assignment_before_dividend", "earnings_before_expiry"
]


class ShortCallRiskOut(BaseModel):
    kind: RiskKind
    text: str


class ShortCallRowOut(BaseModel):
    id: int
    symbol: str
    account_id: int
    strike: FiniteFloat
    expiry: date
    contracts: int
    dte: int
    spot: Number
    moneyness_pct: Number
    delta: Number
    risks: list[ShortCallRiskOut]
    stamp: Stamp


class LotsOut(BaseModel):
    symbol: str
    lots: list[LotOut]
    short_calls: list[ShortCallRowOut]


CoverageReason = Literal["ok", "under_one_contract", "earnings_wait", "fully_covered", "no_chain"]


class CoverageRowOut(BaseModel):
    symbol: str
    account_id: int
    shares: FiniteFloat
    open_contracts: int
    coverable: int
    reason: CoverageReason
    reason_text: str


class CoverageOut(BaseModel):
    cap_pct: FiniteFloat
    rows: list[CoverageRowOut]


class CoveredCallCandidateOut(BaseModel):
    """The engine's `core.covered_calls.Candidate`, flattened. Yields are fractions (0.16 = 16%); `spread_pct` is a
    percentage of the mid."""

    expiry: date
    strike: FiniteFloat
    dte: int
    bid: FiniteFloat
    ask: FiniteFloat
    delta: FiniteFloat
    premium_yield: FiniteFloat
    annualized_yield: FiniteFloat
    upside_cap: FiniteFloat
    return_if_called: FiniteFloat
    spread_pct: FiniteFloat
    open_interest: int
    flags: list[str]
    score: FiniteFloat


class AiContextOut(BaseModel):
    rating: AiRating
    target_base: FiniteFloat
    note: str | None


class CandidatesOut(BaseModel):
    symbol: str
    account_id: int
    spot: Number
    spot_stamp: Stamp
    chain_stamp: Stamp
    iv_rank: Number
    iv_history_sessions: int
    opportunity: bool
    candidates: list[CoveredCallCandidateOut]
    ai_context: AiContextOut | None


class RollCandidateOut(BaseModel):
    expiry: date
    strike: FiniteFloat
    dte: int
    delta: Number
    net_credit: FiniteFloat
    flags: list[str]


class AssignmentNoteOut(BaseModel):
    account_type: AccountType
    text: str


class RollOut(BaseModel):
    cost_to_close: Number  # per share; null while there is no option quote
    candidates: list[RollCandidateOut]
    assignment_note: AssignmentNoteOut
    chain_stamp: Stamp


class IncomeMonthOut(BaseModel):
    month: str = Field(pattern=r"^\d{4}-\d{2}$")
    premium: FiniteFloat
    contracts: int


class AssignmentOut(BaseModel):
    date: date
    symbol: str
    contracts: int
    strike: FiniteFloat


class IncomeOut(BaseModel):
    state: Literal["ok", "needs_trades"]  # `needs_trades` until the Flex query carries a Trades section
    by_month: list[IncomeMonthOut]
    assignments: list[AssignmentOut]
    ytd_premium: Number
    source_stamp: Stamp


class FuturesReadingOut(BaseModel):
    root: Literal["/ES", "/NQ", "/CL", "/GC"]
    front: str
    last: Number
    change_pct: Number
    week_high: Number
    week_low: Number
    next_roll: date
    expiry: date
    stamp: Stamp


class MacroReleaseOut(BaseModel):
    date: date
    release: str
    series_id: str


class FuturesReadingsOut(BaseModel):
    rows: list[FuturesReadingOut]
    macro_week: list[MacroReleaseOut]


class TargetRangeOut(BaseModel):
    low: FiniteFloat
    base: FiniteFloat
    high: FiniteFloat


class BriefRunOut(BaseModel):
    ran_at: datetime
    analyzed: int
    skipped: int
    cost_usd: FiniteFloat


class BriefRowOut(BaseModel):
    symbol: str
    rating: AiRating
    prev_rating: AiRating | None
    target: TargetRangeOut
    upside_pct: Number
    confidence: FiniteFloat
    eps_rev_30d_pct: Number
    earnings_in_days: int | None
    stale_days: int


class TrackRecordOut(BaseModel):
    calls: int
    settled: int
    pending: int


class BriefOut(BaseModel):
    date: date
    run: BriefRunOut | None
    rows: list[BriefRowOut]
    track_record: TrackRecordOut


class VerdictVoteOut(BaseModel):
    name: str
    signal: Signal
    score: FiniteFloat
    reasons: list[str]


class VerdictInputOut(BaseModel):
    name: str
    as_of: date


class VerdictOut(BaseModel):
    rating: AiRating
    target: TargetRangeOut
    confidence: FiniteFloat
    reasons: list[str]
    risks: list[str]
    changed: str
    votes: list[VerdictVoteOut]
    bull: str
    bear: str
    inputs: list[VerdictInputOut]
    as_of: datetime
    stale_days: int


class ConsensusPeriodOut(BaseModel):
    period: str
    eps_estimate: Number
    analysts: int | None


class SurpriseOut(BaseModel):
    period: str
    actual: Number
    estimate: Number
    surprise_pct: Number


class NextEarningsOut(BaseModel):
    date: date
    timing: str


class RevisionsOut(BaseModel):
    d7: Number  # null until that much snapshot history exists
    d30: Number
    d90: Number


class ConsensusOut(BaseModel):
    quarters: list[ConsensusPeriodOut]
    fiscal_years: list[ConsensusPeriodOut]
    surprises: list[SurpriseOut]
    next_earnings: NextEarningsOut | None
    revisions: RevisionsOut


class RatingCountsOut(BaseModel):
    buy: int
    hold: int
    sell: int


class AnalystTargetsOut(BaseModel):
    low: Number
    mean: Number
    high: Number
    counts: RatingCountsOut


class ResearchOut(BaseModel):
    symbol: str
    verdict: VerdictOut | None
    consensus: ConsensusOut | None
    targets: AnalystTargetsOut | None
    stamp: Stamp


class ValuationMethodOut(BaseModel):
    id: Literal["dcf", "owner_earnings", "ev_ebitda", "residual_income"]
    value: Number
    inputs: dict[str, Number]
    fallbacks: list[str]


class ReactionBucketOut(BaseModel):
    n: int
    avg_excess_pct: Number


class ReactionPointOut(BaseModel):
    date: date
    move_pct: FiniteFloat
    excess_pct: FiniteFloat


class EarningsReactionOut(BaseModel):
    reports: int
    avg_abs_move_pct: FiniteFloat
    avg_excess_pct: FiniteFloat
    beats: ReactionBucketOut
    misses: ReactionBucketOut
    series: list[ReactionPointOut]
    implied_move_pct: Number  # null until option quotes exist


class ValuationOut(BaseModel):
    price: Number
    methods: list[ValuationMethodOut]
    blend: Number
    filing_as_of: date | None
    earnings_reaction: EarningsReactionOut | None  # null below 4 reports (02h §7)


TimelineKind = Literal["earnings", "desk_ai", "news", "strategy", "filing", "macro", "consensus"]


class TimelineItemOut(BaseModel):
    at: datetime
    kind: TimelineKind
    title: str
    detail: str
    source: str
    href: str | None


class TimelineOut(BaseModel):
    items: list[TimelineItemOut]
    total: int


class WatchlistScopeOut(BaseModel):
    watchlist_id: int


class FundamentalAlertOut(BaseModel):
    template: AlertTemplate
    enabled: bool
    scope: Literal["holdings"] | WatchlistScopeOut
    rules: dict[str, FiniteFloat | bool]
    strategy_id: int | None


class FundamentalAlertPut(BaseModel):
    """`PUT /fundamental-alerts/{template}`: whatever is sent changes, the rest stays; a change saves a new strategy
    version."""

    model_config = ConfigDict(extra="forbid")

    enabled: bool | None = None
    scope: Literal["holdings"] | WatchlistScopeOut | None = None
    rules: dict[str, FiniteFloat | bool] | None = None


class FeedItemOut(BaseModel):
    kind: Literal["short_call_risk", "earnings_soon", "ex_dividend", "cc_opportunity", "ai_change", "import"]
    symbol: str | None
    title: str
    detail: str
    at: datetime
    href: str


class DashboardPortfolioOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    value: Number
    day_change: Number
    day_change_pct: Number
    unrealized_pct: Number
    import_: ImportStateOut = Field(alias="import")


class DashboardIncomeOut(BaseModel):
    month_to_date: Number
    open_calls: int
    next_expiry: date | None


class DashboardFundamentalEventOut(BaseModel):
    symbol: str | None
    kind: Literal["earnings", "ex_dividend", "macro"]
    date: date
    label: str


class DashboardFundamentalOut(BaseModel):
    stamp: Stamp
    market: DashboardMarketOut
    market_strip: list[MarketStripTileOut]  # SPY, QQQ, IWM, /ES, /NQ; futures "unavailable" until the IBKR slot
    portfolio: DashboardPortfolioOut
    feed: list[FeedItemOut]  # at most 20, newest first
    income: DashboardIncomeOut
    events: list[DashboardFundamentalEventOut]


class StatusOptionsOut(Stamp):
    state: Literal["connected", "not_connected"]


class StatusAiDailyOut(BaseModel):
    state: Literal["not_started", "ok", "partial", "failed"]
    last_run_at: datetime | None
