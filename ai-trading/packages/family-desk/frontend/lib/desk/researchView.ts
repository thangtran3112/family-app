import { DeskApiError } from "../api/client.ts";
import type { Brief, BriefRow, Rating, Research, TimelineItem, Valuation } from "../api/fundamentalSchemas.ts";
import { changeTone, EMPTY_VALUE, formatEtDay, formatEtTimeZone, formatPct, formatSignedPct, type Tone } from "./format.ts";
import { COPY, deskAiStaleText } from "./freshness.ts";
import { ratingText } from "./fundamentalView.ts";
import { formatUsd, formatUsdPrice } from "./mask.ts";
import type { TimelineKind } from "./research.ts";

// View models for the Research screens (02n §b3 FD7 to FD10): the API rows turned into display text once, here, so the
// components stay plain. The numbers are the services'; nothing here recomputes a verdict, an estimate or a valuation.

// ---- Routing --------------------------------------------------------------------------------------------------

export type StockView = "overview" | "valuation" | "timeline";
export const STOCK_VIEWS: ReadonlyArray<{ id: StockView; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "valuation", label: "Valuation & earnings" },
  { id: "timeline", label: "Timeline" },
];

/** `#overview` is the default; anything but `#valuation` and `#timeline` reads as the overview. */
export const stockViewFromHash = (hash: string): StockView => (hash === "valuation" || hash === "timeline" ? hash : "overview");

const TICKER = /^[A-Z0-9][A-Z0-9.-]{0,14}$/;
/** The upper-cased ticker from `?symbol=`, or null when it is missing or not a ticker (the backend takes the same shape). */
export function parseSymbolParam(raw: string | null | undefined): string | null {
  const symbol = raw?.trim().toUpperCase() ?? "";
  return TICKER.test(symbol) ? symbol : null;
}

export const stockHref = (symbol: string, view: StockView = "overview"): string => `/stocks?symbol=${encodeURIComponent(symbol)}#${view}`;

/** The backend answers 422 for something that is not a ticker. */
export const isBadSymbolError = (error: unknown): boolean => error instanceof DeskApiError && error.kind === "http" && error.status === 422;

// ---- FD7 Brief ------------------------------------------------------------------------------------------------

/** "Ran Fri 2026-10-23 · 5:05 PM ET · 4 analyzed · 1 skipped · cost $0.42"; null before the first run. */
export function briefRunLine(run: Brief["run"]): string | null {
  if (!run) return null;
  return [`Ran ${formatEtDay(run.ran_at)} · ${formatEtTimeZone(run.ran_at)}`, `${run.analyzed} analyzed`, `${run.skipped} skipped`, `cost ${formatUsd(run.cost_usd, { cents: true })}`].join(" · ");
}

/** The weekday a stale view is from: the brief's date minus its stale days ("Thu"). */
export function staleWeekday(date: string, staleDays: number): string {
  const day = new Date(`${date}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() - staleDays);
  return formatEtDay(day.toISOString().slice(0, 10)).split(" ")[0] ?? EMPTY_VALUE;
}

/** "Desk AI view from Thu · today's update didn't finish", or null when the view is today's. */
export const staleMarker = (date: string, staleDays: number): string | null => (staleDays > 0 ? deskAiStaleText(staleWeekday(date, staleDays)) : null);

/** "Buy → Hold", "New" (no earlier rating) or "Unchanged". */
export function ratingChange(rating: Rating, prev: Rating | null): string {
  if (prev === null) return "New";
  return prev === rating ? "Unchanged" : `${ratingText(prev)} → ${ratingText(rating)}`;
}

export function earningsInText(days: number | null): string {
  if (days === null) return EMPTY_VALUE;
  if (days === 0) return "Today";
  return `in ${days} ${days === 1 ? "day" : "days"}`;
}

export type BriefRowView = {
  symbol: string;
  href: string;
  rating: Rating;
  change: string;
  target: string;
  range: string;
  upside: string;
  upsideTone: Tone;
  upsideValue: number | null;
  confidence: string;
  confidenceValue: number;
  epsRev30d: string;
  epsRevTone: Tone;
  epsRevValue: number | null;
  earnings: string;
  earningsDays: number | null;
  stale: string | null;
};

export function briefRows(brief: Pick<Brief, "date" | "rows">): BriefRowView[] {
  return brief.rows.map((row: BriefRow) => ({
    symbol: row.symbol,
    href: stockHref(row.symbol),
    rating: row.rating,
    change: ratingChange(row.rating, row.prev_rating),
    target: formatUsdPrice(row.target.base),
    range: `${formatUsdPrice(row.target.low)}–${formatUsdPrice(row.target.high)}`,
    upside: formatSignedPct(row.upside_pct, 1),
    upsideTone: changeTone(row.upside_pct),
    upsideValue: row.upside_pct,
    confidence: formatPct(row.confidence, 0),
    confidenceValue: row.confidence,
    epsRev30d: formatSignedPct(row.eps_rev_30d_pct, 1),
    epsRevTone: changeTone(row.eps_rev_30d_pct),
    epsRevValue: row.eps_rev_30d_pct,
    earnings: earningsInText(row.earnings_in_days),
    earningsDays: row.earnings_in_days,
    stale: staleMarker(brief.date, row.stale_days),
  }));
}

/** Three tiles, always shown: zero calls is real, not missing. */
export function trackRecordTiles(record: Brief["track_record"]): Array<{ label: string; value: string }> {
  return [
    { label: "Calls", value: String(record.calls) },
    { label: "Settled", value: String(record.settled) },
    { label: "Pending", value: String(record.pending) },
  ];
}

/** True when the Desk AI has produced nothing yet: no run and no rows. */
export const briefNotStarted = (brief: Pick<Brief, "run" | "rows">): boolean => brief.run === null && brief.rows.length === 0;

// ---- FD8 Overview ---------------------------------------------------------------------------------------------

export const EPS_NOT_ENOUGH_HISTORY = "Needs more history";
export const NO_CONSENSUS = "No consensus data for this symbol yet";

export type ConsensusPeriodView = { period: string; eps: string; analysts: string };
export function consensusPeriods(periods: ReadonlyArray<{ period: string; eps_estimate: number | null; analysts: number | null }>): ConsensusPeriodView[] {
  return periods.map(({ period, eps_estimate, analysts }) => ({ period, eps: formatUsdPrice(eps_estimate), analysts: analysts === null ? EMPTY_VALUE : String(analysts) }));
}

/** "Beat", "Miss" or "In line" from the sign of the surprise. */
export function surpriseWord(surprisePct: number | null): string {
  if (surprisePct === null) return EMPTY_VALUE;
  if (surprisePct > 0) return "Beat";
  return surprisePct < 0 ? "Miss" : "In line";
}

export type SurpriseView = { period: string; actual: string; estimate: string; surprise: string; word: string; tone: Tone };
export function surpriseRows(surprises: NonNullable<Research["consensus"]>["surprises"]): SurpriseView[] {
  return surprises.map(({ period, actual, estimate, surprise_pct }) => ({
    period,
    actual: formatUsdPrice(actual),
    estimate: formatUsdPrice(estimate),
    surprise: formatSignedPct(surprise_pct, 1),
    word: surpriseWord(surprise_pct),
    tone: changeTone(surprise_pct),
  }));
}

/** 7, 30 and 90 days; a revision is null until the Desk's own snapshots reach back that far. */
export function revisionCells(revisions: NonNullable<Research["consensus"]>["revisions"]): Array<{ label: string; text: string; tone: Tone }> {
  const cell = (label: string, value: number | null) => ({ label, text: value === null ? EPS_NOT_ENOUGH_HISTORY : formatSignedPct(value, 1), tone: changeTone(value) });
  return [cell("7 days", revisions.d7), cell("30 days", revisions.d30), cell("90 days", revisions.d90)];
}

export function nextEarningsText(next: NonNullable<Research["consensus"]>["next_earnings"]): string {
  return next ? `${formatEtDay(next.date)} · ${next.timing}` : EMPTY_VALUE;
}

/** Analyst targets, context only: low, mean and high per share and the buy, hold and sell counts. */
export function targetsView(targets: NonNullable<Research["targets"]>): { low: string; mean: string; high: string; counts: string } {
  return {
    low: formatUsdPrice(targets.low),
    mean: formatUsdPrice(targets.mean),
    high: formatUsdPrice(targets.high),
    counts: `${targets.counts.buy} Buy · ${targets.counts.hold} Hold · ${targets.counts.sell} Sell`,
  };
}

/** Where `value` sits on the line from `lo` to `hi`, in percent, held inside the line. */
export function linePosition(value: number, lo: number, hi: number): number {
  if (!(hi > lo)) return 50;
  return Math.min(100, Math.max(0, ((value - lo) / (hi - lo)) * 100));
}

export type TargetBarView = { low: number; base: number; high: number; price: number | null };
/** Positions (percent) of the low, base and high targets and the price on one shared line, with a margin either side. */
export function targetBar(target: { low: number; base: number; high: number }, price: number | null): TargetBarView {
  const points = price === null ? [target.low, target.high] : [target.low, target.high, price];
  const min = Math.min(...points);
  const max = Math.max(...points);
  const margin = (max - min) * 0.1 || 1;
  const lo = min - margin;
  const hi = max + margin;
  return { low: linePosition(target.low, lo, hi), base: linePosition(target.base, lo, hi), high: linePosition(target.high, lo, hi), price: price === null ? null : linePosition(price, lo, hi) };
}

export const confidenceText = (confidence: number): string => `${formatPct(confidence, 0)} confidence`;

/** The verdict's own freshness line, or null when it is today's. */
export const verdictStale = (staleDays: number, asOf: string): string | null => (staleDays > 0 ? deskAiStaleText(formatEtDay(asOf).split(" ")[0] ?? EMPTY_VALUE) : null);

export const voteLine = (vote: { name: string; signal: Rating; score: number }): string => `${vote.name} · ${ratingText(vote.signal)} · score ${vote.score}`;

// ---- FD9 Valuation & earnings ---------------------------------------------------------------------------------

export const METHOD_LABELS: Record<Valuation["methods"][number]["id"], string> = {
  dcf: "Discounted cash flow",
  owner_earnings: "Owner earnings",
  ev_ebitda: "EV / EBITDA",
  residual_income: "Residual income",
};

const INPUT_LABELS: Record<string, string> = {
  fcf_yield_pct: "Free-cash-flow yield",
  growth_pct: "Growth",
  wacc_pct: "Discount rate",
  required_return_pct: "Required return",
  debt_to_equity: "Debt to equity",
  fwd_pe: "Forward P/E",
  book_value_growth_pct: "Book value growth",
  cost_of_equity_pct: "Cost of equity",
};

/** "fcf_yield_pct" reads "Free-cash-flow yield"; a key without a label reads as its own words. */
export const inputLabel = (key: string): string => INPUT_LABELS[key] ?? key.replace(/_pct$/, "").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

function inputText(key: string, value: number | null): string {
  const label = inputLabel(key);
  if (value === null) return `${label}: not available`;
  return key.endsWith("_pct") ? `${label} ${formatPct(value, 1)}` : `${label} ${value}`;
}

export const NOT_ENOUGH_DATA = "Not enough data";

export type MethodView = { id: string; label: string; value: string; hasValue: boolean; inputs: string[]; fallbacks: string[] };
export function methodRows(methods: Valuation["methods"]): MethodView[] {
  return methods.map((method) => ({
    id: method.id,
    label: METHOD_LABELS[method.id],
    value: method.value === null ? NOT_ENOUGH_DATA : formatUsdPrice(method.value),
    hasValue: method.value !== null,
    inputs: Object.entries(method.inputs).map(([key, value]) => inputText(key, value)),
    // The engine's own sentences, shown as they are ("Book value growth: 4% default").
    fallbacks: method.fallbacks,
  }));
}

export type BlendView = { blend: string; price: string; word: string | null; blendPct: number; pricePct: number } | null;
/** The 60/40 blend beside the price on one scale; null when either is missing (the screen then says so in words). */
export function blendView(blend: number | null, price: number | null): BlendView {
  if (blend === null || price === null) return null;
  const top = Math.max(blend, price);
  return {
    blend: formatUsdPrice(blend),
    price: formatUsdPrice(price),
    word: blend === price ? "Blend equals the price" : blend > price ? "Blend is above the price" : "Blend is below the price",
    blendPct: top > 0 ? (blend / top) * 100 : 0,
    pricePct: top > 0 ? (price / top) * 100 : 0,
  };
}

export const filingText = (asOf: string | null): string => (asOf ? `Latest filing as of ${formatEtDay(asOf)}` : "No filing date available");

export const REACTION_NEEDS_REPORTS = "Needs at least 4 earnings reports before this shows";

/** "Options imply a move of ±4.6%", or the copy-table row while option quotes are not connected. */
export const impliedMoveText = (impliedMovePct: number | null): string => (impliedMovePct === null ? COPY.optionQuotesNotConnected : `Options imply a move of ±${formatPct(impliedMovePct, 1)}`);

export function reactionSummary(reaction: NonNullable<Valuation["earnings_reaction"]>): Array<{ label: string; value: string }> {
  const bucket = (n: number, avg: number | null) => (n === 0 ? "None" : `${n} · average ${formatSignedPct(avg, 2)} vs SPY`);
  return [
    { label: "Reports", value: String(reaction.reports) },
    { label: "Average move", value: formatPct(reaction.avg_abs_move_pct, 1) },
    { label: "Average vs SPY", value: formatSignedPct(reaction.avg_excess_pct, 2) },
    { label: "Beats", value: bucket(reaction.beats.n, reaction.beats.avg_excess_pct) },
    { label: "Misses", value: bucket(reaction.misses.n, reaction.misses.avg_excess_pct) },
  ];
}

/** Axis ticks at round steps that cover `maxAbs`, mirrored around zero: step 2 and top 8 give -8, -6 ... 8. */
export function axisTicks(maxAbs: number): { step: number; top: number; ticks: number[] } {
  const safe = Number.isFinite(maxAbs) && maxAbs > 0 ? maxAbs : 1;
  const raw = safe / 2;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 5, 10].map((m) => m * pow).find((candidate) => candidate >= raw) ?? raw) as number;
  const top = Math.ceil(safe / step) * step;
  const count = Math.round(top / step);
  const ticks = Array.from({ length: count * 2 + 1 }, (_, index) => Number(((index - count) * step).toFixed(6)));
  return { step, top, ticks };
}

export type ReactionBar = { date: string; label: string; value: number; text: string; tone: Tone; heightPct: number };
/** One bar per report, oldest first (the API sends newest first), heights as a share of the axis top. */
export function reactionBars(series: NonNullable<Valuation["earnings_reaction"]>["series"]): { bars: ReactionBar[]; axis: ReturnType<typeof axisTicks> } {
  const axis = axisTicks(Math.max(0, ...series.map((point) => Math.abs(point.move_pct))));
  const bars = [...series].reverse().map((point) => ({
    date: point.date,
    label: point.date.slice(2, 7),
    value: point.move_pct,
    text: formatSignedPct(point.move_pct, 1),
    tone: changeTone(point.move_pct),
    heightPct: (Math.abs(point.move_pct) / axis.top) * 50,
  }));
  return { bars, axis };
}

export const axisLabel = (tick: number): string => (tick === 0 ? "0%" : formatSignedPct(tick, tick % 1 === 0 ? 0 : 1));

// ---- FD10 Timeline --------------------------------------------------------------------------------------------

export type TimelineFilterId = "all" | "earnings" | "desk_ai" | "news" | "strategy" | "filing";
export const TIMELINE_FILTERS: ReadonlyArray<{ id: TimelineFilterId; label: string; kind: TimelineKind | undefined }> = [
  { id: "all", label: "All", kind: undefined },
  { id: "earnings", label: "Earnings", kind: "earnings" },
  { id: "desk_ai", label: "Desk AI", kind: "desk_ai" },
  { id: "news", label: "News", kind: "news" },
  { id: "strategy", label: "Strategy", kind: "strategy" },
  { id: "filing", label: "Filings", kind: "filing" },
];

export const KIND_LABEL: Record<TimelineKind, string> = {
  earnings: "Earnings",
  desk_ai: "Desk AI",
  news: "News",
  strategy: "Strategy",
  filing: "Filing",
  macro: "Macro",
  consensus: "Consensus",
};

export const TIMELINE_PAGE = 20;

/** A link a person may follow: a path on this site, or an http(s) address (opened in a new tab). Anything else is dropped. */
export function safeHref(href: string | null): { href: string; external: boolean } | null {
  if (!href) return null;
  if (href.startsWith("/") && !href.startsWith("//") && !href.includes("\\")) return { href, external: false };
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:" ? { href: url.href, external: true } : null;
  } catch {
    return null;
  }
}

export type TimelineRowView = { key: string; when: string; kind: string; isAi: boolean; title: string; detail: string; source: string; link: ReturnType<typeof safeHref> };
export function timelineRows(items: readonly TimelineItem[]): TimelineRowView[] {
  return items.map((item, index) => ({
    key: `${item.at}:${item.kind}:${index}`,
    when: formatEtDay(item.at),
    kind: KIND_LABEL[item.kind],
    isAi: item.kind === "desk_ai",
    title: item.title,
    detail: item.detail,
    source: item.source,
    link: safeHref(item.href),
  }));
}

/** More pages exist while fewer items than the total have been loaded. */
export const timelineHasMore = (loaded: number, total: number): boolean => loaded < total;
