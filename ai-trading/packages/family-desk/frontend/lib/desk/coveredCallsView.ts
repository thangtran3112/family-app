import type { Candidates, CoverageRow, HoldingAccount, Income, ShortCall } from "../api/fundamentalSchemas.ts";
import { EMPTY_VALUE, formatPct } from "./format.ts";
import { COPY } from "./freshness.ts";
import { formatUsd, MASK } from "./mask.ts";
import { niceTicks } from "./ticks.ts";

// View models and wording for the covered-call screens (02n §b3 FD4, FD5). The engine's numbers arrive final; this file only
// turns them into text. Yields, upside cap and return if called are fractions of the share price (0.1605 is 16.1%); spread,
// moneyness and IV rank are already percent.

const isNumber = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value);

/** A fraction of the share price as a percent: 0.160548 is "16.1%". */
export const formatYield = (fraction: number | null | undefined, digits = 1): string => (isNumber(fraction) ? formatPct(fraction * 100, digits) : EMPTY_VALUE);
export const formatDelta = (delta: number | null | undefined): string => (isNumber(delta) ? delta.toFixed(2) : EMPTY_VALUE);
export const formatScore = (score: number | null | undefined): string => (isNumber(score) ? score.toFixed(2) : EMPTY_VALUE);

/** Why a holding can or cannot be covered, in plain words without any count: what shows while values are hidden. */
export const REASON_WORDS: Record<CoverageRow["reason"], string> = {
  ok: "Ready to cover",
  under_one_contract: "Under one contract at the cap",
  earnings_wait: "Earnings soon: waits",
  fully_covered: "Fully covered at its cap",
  no_chain: "Option quotes not connected",
};

/** The API's own sentence carries share counts ("120 shares: under one contract at a 50% cap"), so it shows only when values do. */
export const coverageReason = (row: Pick<CoverageRow, "reason" | "reason_text">, masked: boolean): string => (masked ? REASON_WORDS[row.reason] : row.reason_text);

export const capText = (capPct: number): string => `Cap ${Number.isInteger(capPct) ? capPct : capPct.toFixed(1)}% of shares`;

const FLAG_WORDS: Record<string, string> = {
  ex_dividend_before_expiry: "Ex-dividend before expiry",
  strike_below_cost_basis: "Strike below cost",
  short_term_lots: "Short-term lots",
  cover_tax_advantaged_first: "Cover the IRA first",
};

/** A flag in words; an unknown flag reads as its own name with spaces. */
export function flagText(flag: string): string {
  const known = FLAG_WORDS[flag];
  if (known) return known;
  const spaced = flag.replace(/_/g, " ").trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : EMPTY_VALUE;
}

export const flagsText = (flags: readonly string[]): string => (flags.length === 0 ? "None" : flags.map(flagText).join(", "));

/** The distinct flags across candidates, in the order first met, for the notes under the table. */
export const distinctFlags = (candidates: ReadonlyArray<{ flags: readonly string[] }>): string[] => [...new Set(candidates.flatMap((candidate) => candidate.flags))];

/** The owner-set alias of an account; the id alone never reaches the screen. */
export const accountLabel = (accounts: readonly Pick<HoldingAccount, "id" | "label">[], id: number): string => accounts.find((account) => account.id === id)?.label ?? "Account";

export const NO_RISKS = "No risks flagged";
/** The first risk in words, for the table; the detail pane lists them all. */
export const topRisk = (risks: ShortCall["risks"]): string => risks[0]?.text ?? NO_RISKS;

/** The open call to detail first: the one with the most risks, then the nearest expiry. A first row with no risks must not hide the urgent call below it. */
export function mostUrgentCall<R extends Pick<ShortCall, "risks" | "dte">>(rows: readonly R[]): R | null {
  let best: R | null = null;
  for (const row of rows) {
    if (best === null || row.risks.length > best.risks.length || (row.risks.length === best.risks.length && row.dte < best.dte)) best = row;
  }
  return best;
}

/** "5.6% below the strike" / "2.0% above the strike": the spot against the strike, in words. */
export function moneynessWords(moneynessPct: number | null): string {
  if (!isNumber(moneynessPct)) return EMPTY_VALUE;
  if (moneynessPct === 0) return "At the strike";
  return `${formatPct(Math.abs(moneynessPct), 1)} ${moneynessPct < 0 ? "below" : "above"} the strike`;
}

/** The engine keeps an IV rank only after 60 sessions of history; before that, say how far along it is. */
export const IV_SESSIONS_NEEDED = 60;
export function ivRankLine(candidates: Pick<Candidates, "iv_rank" | "iv_history_sessions">): string {
  if (isNumber(candidates.iv_rank)) return `IV rank ${Math.round(candidates.iv_rank)}`;
  return `${COPY.ivRankShortHistory} (${candidates.iv_history_sessions} of ${IV_SESSIONS_NEEDED} sessions)`;
}

export type ChainState = "not_connected" | "no_match" | "ready";
/** `not_connected`: no chain could be read (say it plainly, show nothing else); `no_match`: a chain, but no call passes the filters. */
export function chainState(candidates: Pick<Candidates, "chain_stamp" | "candidates">): ChainState {
  if (candidates.chain_stamp.freshness === "unavailable" || candidates.chain_stamp.quality === "unavailable") return "not_connected";
  return candidates.candidates.length === 0 ? "no_match" : "ready";
}
export const NO_MATCH_TEXT = "No call passes your filters right now";

/** The opportunity banner: the engine's flag, the top call's own yield. Null when the engine did not raise it. */
export function opportunityText(candidates: Pick<Candidates, "opportunity" | "candidates" | "symbol">): string | null {
  const top = candidates.candidates[0];
  if (!candidates.opportunity || !top) return null;
  return `Opportunity: a ${top.expiry} $${top.strike} call on ${candidates.symbol} yields ${formatYield(top.annualized_yield)} a year`;
}

export const NEEDS_TRADES_TEXT = "Premium history needs the Flex Trades section";
export const NO_INCOME_TEXT = "No premium collected in this period";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-10" as "Oct"; January also carries the year ("Jan 2026"), so a year of bars reads without a second axis. */
export function monthLabel(month: string): string {
  const [year, number] = month.split("-");
  const name = MONTHS[Number(number) - 1];
  if (!year || !name) return month;
  return number === "01" ? `${name} ${year}` : name;
}

export type IncomeBar = { month: string; label: string; premium: number; contracts: number; share: number };
export type IncomeTick = { value: number; label: string; share: number };
export type IncomeChart = { bars: IncomeBar[]; ticks: IncomeTick[] };

/** Bars scaled to the tallest month (`share` 0 to 1) and a numeric $ axis. While values are hidden the axis labels are `•••••`: the bars keep their shape and no amount shows. */
export function incomeChart(byMonth: Income["by_month"], masked: boolean): IncomeChart {
  const max = Math.max(0, ...byMonth.map((month) => month.premium));
  const ticks = niceTicks(0, max, { inside: true });
  const top = ticks.length > 0 ? Math.max(ticks[ticks.length - 1]!, max) : max;
  return {
    bars: byMonth.map((month) => ({ month: month.month, label: monthLabel(month.month), premium: month.premium, contracts: month.contracts, share: top > 0 ? month.premium / top : 0 })),
    ticks: ticks.map((value) => ({ value, label: masked ? MASK : formatUsd(value), share: top > 0 ? value / top : 0 })),
  };
}

export type IncomeView = { kind: "needs_trades" } | { kind: "empty" } | { kind: "ok"; chart: IncomeChart };
/** `needs_trades` is its own honest state: never a row of zero bars. */
export function incomeView(income: Pick<Income, "state" | "by_month">, masked: boolean): IncomeView {
  if (income.state === "needs_trades") return { kind: "needs_trades" };
  if (income.by_month.length === 0) return { kind: "empty" };
  return { kind: "ok", chart: incomeChart(income.by_month, masked) };
}

/** The coverage row to open first: the first one with something to sell, else the first row. */
export function defaultCoverageRow<R extends Pick<CoverageRow, "coverable">>(rows: readonly R[]): R | null {
  return rows.find((row) => row.coverable > 0) ?? rows[0] ?? null;
}

/** The roll pane's price line: per-share prices are never masked. */
export const costToCloseText = (cost: number | null): string => (isNumber(cost) ? `${formatUsd(cost, { cents: true })} a share` : COPY.optionQuotesNotConnected);

/** The assignment note by account type, ending in "Not tax advice" exactly once (the API's own sentence may already say it). */
export function assignmentNoteText(note: { text: string }): string {
  return /not tax advice/i.test(note.text) ? note.text : `${note.text} ${COPY.tax}`;
}
