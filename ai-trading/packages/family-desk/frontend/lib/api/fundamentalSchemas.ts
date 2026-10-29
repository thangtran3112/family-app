import { z } from "zod";
import type { components } from "./openapi.js";
import { StampSchema } from "./schemas.ts";

// The Fundamental lane's response schemas (02n §c3), one per real endpoint. Each `satisfies` the generated type, so a
// contract change breaks the build here first. The gated routes (`/dashboard/fundamental`, `/futures/readings`, the two
// fundamental-alert routes) have no schema on purpose: no screen calls them until their sources are built.

const finite = z.number().finite();
const optionalNumber = finite.nullable().optional();
const date = z.iso.date();
const timestamp = z.iso.datetime({ offset: true });
const rating = z.enum(["buy", "hold", "sell"]);
const accountType = z.enum(["taxable", "ira", "roth"]);

export const ImportStateSchema = z.object({
  source: z.literal("ibkr_flex"),
  account_scope: z.enum(["data", "main_interim"]),
  statement_date: date.nullable(),
  imported_at: timestamp.nullable(),
  lots: finite.int(),
  state: z.enum(["ok", "running", "failed", "not_configured", "none"]),
}) satisfies z.ZodType<components["schemas"]["ImportStateOut"]>;

const AccountSchema = z.object({ id: finite.int(), label: z.string(), type: accountType }) satisfies z.ZodType<components["schemas"]["AccountOut"]>;

const FundamentalsSchema = z.object({
  fwd_pe: optionalNumber,
  pe_vs_5y_median_pct: optionalNumber,
  fcf_yield_pct: optionalNumber,
  revenue_growth_yoy_pct: optionalNumber,
  debt_to_equity: optionalNumber,
  eps_rev_7d_pct: optionalNumber,
  eps_rev_30d_pct: optionalNumber,
  eps_rev_90d_pct: optionalNumber,
  next_earnings: z.string().nullable().optional(),
  dividend_yield_pct: optionalNumber,
  ex_dividend: z.string().nullable().optional(),
  ai_rating: rating.nullable().optional(),
  ai_target_base: optionalNumber,
  ai_upside_pct: optionalNumber,
  dist_to_252d_high_pct: optionalNumber,
  weight_pct: optionalNumber,
  gain_vs_cost_pct: optionalNumber,
  cc_coverable: finite.int().nullable().optional(),
}) satisfies z.ZodType<components["schemas"]["Fundamentals"]>;

const HoldingRowSchema = z.object({
  symbol: z.string(),
  name: z.string(),
  account_ids: z.array(finite.int()),
  shares: finite,
  avg_cost: finite,
  last: finite.nullable(),
  change_pct: finite.nullable(),
  market_value: finite.nullable(),
  weight_pct: finite.nullable(),
  unrealized_pct: finite.nullable(),
  coverable_contracts: finite.int(),
  open_calls: finite.int(),
  next_earnings: date.nullable(),
  ai_rating: rating.nullable(),
  fundamentals: FundamentalsSchema,
  stamp: StampSchema,
}) satisfies z.ZodType<components["schemas"]["HoldingRowOut"]>;

export const HoldingsSchema = z.object({
  import: ImportStateSchema,
  accounts: z.array(AccountSchema),
  totals: z.object({
    market_value: finite.nullable(),
    cost: finite.nullable(),
    unrealized: finite.nullable(),
    unrealized_pct: finite.nullable(),
    day_change: finite.nullable(),
    day_change_pct: finite.nullable(),
  }) satisfies z.ZodType<components["schemas"]["HoldingsTotalsOut"]>,
  rows: z.array(HoldingRowSchema),
  option_lots: z.array(z.object({
    id: finite.int(),
    symbol: z.string(),
    account_id: finite.int(),
    right: z.enum(["C", "P"]),
    strike: finite,
    expiry: date,
    contracts: finite.int(),
  }) satisfies z.ZodType<components["schemas"]["OptionLotOut"]>),
}) satisfies z.ZodType<components["schemas"]["HoldingsOut"]>;

export const ImportResponseSchema = z.object({ import: ImportStateSchema }) satisfies z.ZodType<components["schemas"]["ImportOut"]>;
export const AccountOutSchema = AccountSchema;

const ShortCallRiskSchema = z.object({
  kind: z.enum(["delta_above_0_50", "near_strike_near_expiry", "early_assignment_before_dividend", "earnings_before_expiry"]),
  text: z.string(),
}) satisfies z.ZodType<components["schemas"]["ShortCallRiskOut"]>;

const ShortCallRowSchema = z.object({
  id: finite.int(),
  symbol: z.string(),
  account_id: finite.int(),
  strike: finite,
  expiry: date,
  contracts: finite.int(),
  dte: finite.int(),
  spot: finite.nullable(),
  moneyness_pct: finite.nullable(),
  delta: finite.nullable(),
  risks: z.array(ShortCallRiskSchema),
  stamp: StampSchema,
}) satisfies z.ZodType<components["schemas"]["ShortCallRowOut"]>;

export const ShortCallsSchema = z.array(ShortCallRowSchema);

export const LotsSchema = z.object({
  symbol: z.string(),
  lots: z.array(z.object({
    account_id: finite.int(),
    shares: finite,
    cost_per_share: finite,
    acquired: date,
    term: z.enum(["short", "long"]),
    gain_pct: finite.nullable(),
  }) satisfies z.ZodType<components["schemas"]["LotOut"]>),
  short_calls: ShortCallsSchema,
}) satisfies z.ZodType<components["schemas"]["LotsOut"]>;

export const CoverageSchema = z.object({
  cap_pct: finite,
  rows: z.array(z.object({
    symbol: z.string(),
    account_id: finite.int(),
    shares: finite,
    open_contracts: finite.int(),
    coverable: finite.int(),
    reason: z.enum(["ok", "under_one_contract", "earnings_wait", "fully_covered", "no_chain"]),
    reason_text: z.string(),
  }) satisfies z.ZodType<components["schemas"]["CoverageRowOut"]>),
}) satisfies z.ZodType<components["schemas"]["CoverageOut"]>;

export const CandidatesSchema = z.object({
  symbol: z.string(),
  account_id: finite.int(),
  spot: finite.nullable(),
  spot_stamp: StampSchema,
  chain_stamp: StampSchema,
  iv_rank: finite.nullable(),
  iv_history_sessions: finite.int(),
  opportunity: z.boolean(),
  candidates: z.array(z.object({
    expiry: date,
    strike: finite,
    dte: finite.int(),
    bid: finite,
    ask: finite,
    delta: finite,
    premium_yield: finite,
    annualized_yield: finite,
    upside_cap: finite,
    return_if_called: finite,
    spread_pct: finite,
    open_interest: finite.int(),
    flags: z.array(z.string()),
    score: finite,
  }) satisfies z.ZodType<components["schemas"]["CoveredCallCandidateOut"]>),
  ai_context: z.object({ rating, target_base: finite, note: z.string().nullable() }).nullable(),
}) satisfies z.ZodType<components["schemas"]["CandidatesOut"]>;

export const RollSchema = z.object({
  cost_to_close: finite.nullable(),
  candidates: z.array(z.object({
    expiry: date,
    strike: finite,
    dte: finite.int(),
    delta: finite.nullable(),
    net_credit: finite,
    flags: z.array(z.string()),
  }) satisfies z.ZodType<components["schemas"]["RollCandidateOut"]>),
  assignment_note: z.object({ account_type: accountType, text: z.string() }) satisfies z.ZodType<components["schemas"]["AssignmentNoteOut"]>,
  chain_stamp: StampSchema,
}) satisfies z.ZodType<components["schemas"]["RollOut"]>;

export const IncomeSchema = z.object({
  by_month: z.array(z.object({ month: z.string(), premium: finite, contracts: finite.int() }) satisfies z.ZodType<components["schemas"]["IncomeMonthOut"]>),
  assignments: z.array(z.object({ date, symbol: z.string(), contracts: finite.int(), strike: finite }) satisfies z.ZodType<components["schemas"]["AssignmentOut"]>),
  ytd_premium: finite.nullable(),
  state: z.enum(["ok", "needs_trades"]),
  source_stamp: StampSchema,
}) satisfies z.ZodType<components["schemas"]["IncomeOut"]>;

const targetRange = z.object({ low: finite, base: finite, high: finite }) satisfies z.ZodType<components["schemas"]["TargetRangeOut"]>;

export const BriefSchema = z.object({
  date,
  run: z.object({ ran_at: timestamp, analyzed: finite.int(), skipped: finite.int(), cost_usd: finite }).nullable(),
  rows: z.array(z.object({
    symbol: z.string(),
    rating,
    prev_rating: rating.nullable(),
    target: targetRange,
    upside_pct: finite.nullable(),
    confidence: finite,
    eps_rev_30d_pct: finite.nullable(),
    earnings_in_days: finite.int().nullable(),
    stale_days: finite.int(),
  }) satisfies z.ZodType<components["schemas"]["BriefRowOut"]>),
  track_record: z.object({ calls: finite.int(), settled: finite.int(), pending: finite.int() }) satisfies z.ZodType<components["schemas"]["TrackRecordOut"]>,
}) satisfies z.ZodType<components["schemas"]["BriefOut"]>;

const consensusPeriod = z.object({ period: z.string(), eps_estimate: finite.nullable(), analysts: finite.int().nullable() }) satisfies z.ZodType<components["schemas"]["ConsensusPeriodOut"]>;

const VerdictSchema = z.object({
  rating,
  target: targetRange,
  confidence: finite,
  reasons: z.array(z.string()),
  risks: z.array(z.string()),
  changed: z.string(),
  votes: z.array(z.object({ name: z.string(), signal: rating, score: finite, reasons: z.array(z.string()) }) satisfies z.ZodType<components["schemas"]["VerdictVoteOut"]>),
  bull: z.string(),
  bear: z.string(),
  inputs: z.array(z.object({ name: z.string(), as_of: z.string() }) satisfies z.ZodType<components["schemas"]["VerdictInputOut"]>),
  as_of: z.string(),
  stale_days: finite.int(),
}) satisfies z.ZodType<components["schemas"]["VerdictOut"]>;

export const ResearchSchema = z.object({
  symbol: z.string(),
  verdict: VerdictSchema.nullable(),
  consensus: z.object({
    quarters: z.array(consensusPeriod),
    fiscal_years: z.array(consensusPeriod),
    surprises: z.array(z.object({ period: z.string(), actual: finite.nullable(), estimate: finite.nullable(), surprise_pct: finite.nullable() }) satisfies z.ZodType<components["schemas"]["SurpriseOut"]>),
    next_earnings: z.object({ date, timing: z.string() }).nullable(),
    revisions: z.object({ d7: finite.nullable(), d30: finite.nullable(), d90: finite.nullable() }) satisfies z.ZodType<components["schemas"]["RevisionsOut"]>,
  }).nullable(),
  targets: z.object({
    low: finite.nullable(),
    mean: finite.nullable(),
    high: finite.nullable(),
    counts: z.object({ buy: finite.int(), hold: finite.int(), sell: finite.int() }),
  }).nullable(),
  stamp: StampSchema,
}) satisfies z.ZodType<components["schemas"]["ResearchOut"]>;

const reactionBucket = z.object({ n: finite.int(), avg_excess_pct: finite.nullable() }) satisfies z.ZodType<components["schemas"]["ReactionBucketOut"]>;

export const ValuationSchema = z.object({
  price: finite.nullable(),
  methods: z.array(z.object({
    id: z.enum(["dcf", "owner_earnings", "ev_ebitda", "residual_income"]),
    value: finite.nullable(),
    inputs: z.record(z.string(), finite.nullable()),
    fallbacks: z.array(z.string()),
  }) satisfies z.ZodType<components["schemas"]["ValuationMethodOut"]>),
  blend: finite.nullable(),
  filing_as_of: z.string().nullable(),
  earnings_reaction: z.object({
    reports: finite.int(),
    avg_abs_move_pct: finite,
    avg_excess_pct: finite,
    beats: reactionBucket,
    misses: reactionBucket,
    series: z.array(z.object({ date, move_pct: finite, excess_pct: finite }) satisfies z.ZodType<components["schemas"]["ReactionPointOut"]>),
    implied_move_pct: finite.nullable(),
  }).nullable(),
}) satisfies z.ZodType<components["schemas"]["ValuationOut"]>;

export const TimelineSchema = z.object({
  items: z.array(z.object({
    at: z.string(),
    kind: z.enum(["earnings", "desk_ai", "news", "strategy", "filing", "macro", "consensus"]),
    title: z.string(),
    detail: z.string(),
    source: z.string(),
    href: z.string().nullable(),
  }) satisfies z.ZodType<components["schemas"]["TimelineItemOut"]>),
  total: finite.int(),
}) satisfies z.ZodType<components["schemas"]["TimelineOut"]>;

export type Holdings = z.infer<typeof HoldingsSchema>;
export type HoldingRow = Holdings["rows"][number];
export type HoldingAccount = Holdings["accounts"][number];
export type OptionLot = Holdings["option_lots"][number];
export type ImportState = z.infer<typeof ImportStateSchema>;
export type AccountType = z.infer<typeof AccountOutSchema>["type"];
export type Lots = z.infer<typeof LotsSchema>;
export type ShortCall = z.infer<typeof ShortCallsSchema>[number];
export type Coverage = z.infer<typeof CoverageSchema>;
export type CoverageRow = Coverage["rows"][number];
export type Candidates = z.infer<typeof CandidatesSchema>;
export type CoveredCallCandidate = Candidates["candidates"][number];
export type Roll = z.infer<typeof RollSchema>;
export type Income = z.infer<typeof IncomeSchema>;
export type Brief = z.infer<typeof BriefSchema>;
export type BriefRow = Brief["rows"][number];
export type Research = z.infer<typeof ResearchSchema>;
export type Valuation = z.infer<typeof ValuationSchema>;
export type Timeline = z.infer<typeof TimelineSchema>;
export type TimelineItem = Timeline["items"][number];
export type Rating = z.infer<typeof rating>;
