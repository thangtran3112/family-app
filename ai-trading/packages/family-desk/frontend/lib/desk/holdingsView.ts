import type {
  AccountType, Candidates, CoverageRow, HoldingAccount, HoldingRow, Holdings, Lots, Research, ShortCall,
} from "../api/fundamentalSchemas.ts";
import type { Tone } from "../../components/ui/tone.ts";
import { EMPTY_VALUE, formatEtDay, formatPct, formatSignedPct, signTone } from "./format.ts";
import { COPY } from "./freshness.ts";
import { hasHoldingsData, importLine } from "./fundamentalView.ts";
import { formatUsdPrice, maskedQuantity, maskedSignedUsd, maskedUsd } from "./mask.ts";
import { timingLabel } from "./labels.ts";

// View models for Holdings (FD3), the left-rail Holdings tab and the Fundamental right rail (02n §b1, §b3). The API
// numbers are the engine's; this file turns them into text once and applies the masking rule (dollars, share counts and
// contract counts hide; prices per share, percentages and dates stay).

const TYPE_LABEL: Record<AccountType, string> = { taxable: "Taxable", ira: "IRA", roth: "Roth IRA" };

export type AccountOption = { id: number | null; label: string };

/** "All accounts" first, then each account by its own alias and type; the broker number never reaches the browser. */
export function accountOptions(accounts: readonly HoldingAccount[]): AccountOption[] {
  return [{ id: null, label: "All accounts" }, ...accounts.map((account) => ({ id: account.id, label: `${account.label} · ${TYPE_LABEL[account.type]}` }))];
}

/** The owner-set alias of an account ("Taxable", "IRA"); the default alias when the list does not know it. */
export const accountLabel = (accounts: readonly HoldingAccount[], id: number): string => accounts.find((account) => account.id === id)?.label ?? `Account ${id}`;

export type Tile = { key: string; label: string; value: string; note: string | null; tone: Tone };

/** Portfolio value, day change and unrealized: the dollar figures hide, the percentages stay. */
export function totalsTiles(totals: Holdings["totals"], masked: boolean): Tile[] {
  return [
    { key: "value", label: "Market value", value: maskedUsd(masked, totals.market_value), note: null, tone: "neutral" },
    {
      key: "day",
      label: "Day change",
      value: maskedSignedUsd(masked, totals.day_change),
      note: totals.day_change_pct === null ? null : `${formatSignedPct(totals.day_change_pct)} today`,
      tone: signTone(totals.day_change_pct),
    },
    {
      key: "unrealized",
      label: "Unrealized",
      value: maskedSignedUsd(masked, totals.unrealized),
      note: totals.unrealized_pct === null ? null : formatSignedPct(totals.unrealized_pct, 1),
      tone: signTone(totals.unrealized_pct),
    },
    { key: "cost", label: "Cost", value: maskedUsd(masked, totals.cost), note: null, tone: "neutral" },
  ];
}

export type HoldingView = {
  symbol: string;
  name: string;
  shares: string;
  avgCost: string;
  last: string;
  change: { text: string; tone: Tone };
  value: string;
  weight: string;
  unrealized: { text: string; tone: Tone };
  coverable: string;
  openCalls: string;
  nextEarnings: string;
  row: HoldingRow;
};

export function holdingViews(rows: readonly HoldingRow[], masked: boolean): HoldingView[] {
  return rows.map((row) => ({
    symbol: row.symbol,
    name: row.name,
    shares: maskedQuantity(masked, row.shares),
    avgCost: formatUsdPrice(row.avg_cost),
    last: formatUsdPrice(row.last),
    change: { text: formatSignedPct(row.change_pct), tone: signTone(row.change_pct) },
    value: maskedUsd(masked, row.market_value),
    weight: formatPct(row.weight_pct, 1),
    unrealized: { text: formatSignedPct(row.unrealized_pct, 1), tone: signTone(row.unrealized_pct) },
    coverable: maskedQuantity(masked, row.coverable_contracts),
    openCalls: maskedQuantity(masked, row.open_calls),
    nextEarnings: row.next_earnings ? formatEtDay(row.next_earnings) : EMPTY_VALUE,
    row,
  }));
}

/** The words that stand where the table would be, or null when there are rows to show (a re-import keeps the last rows on screen). */
export function holdingsEmptyText(state: Holdings["import"], rowCount: number): string | null {
  if (rowCount > 0) return null;
  return hasHoldingsData(state) && state.state === "ok" ? COPY.holdingsNone : importLine(state).text;
}

export type RailRow = { symbol: string; weight: string; change: { text: string; tone: Tone }; rating: HoldingRow["ai_rating"] };

/** Left rail: biggest weight first. */
export function railRows(rows: readonly HoldingRow[]): RailRow[] {
  return [...rows]
    .sort((a, b) => (b.weight_pct ?? -1) - (a.weight_pct ?? -1) || a.symbol.localeCompare(b.symbol))
    .map((row) => ({ symbol: row.symbol, weight: formatPct(row.weight_pct, 1), change: { text: formatSignedPct(row.change_pct), tone: signTone(row.change_pct) }, rating: row.ai_rating }));
}

export type LotView = { key: string; accountId: number; acquired: string; shares: string; cost: string; term: string; gain: { text: string; tone: Tone } };

export function lotViews(lots: Lots["lots"], masked: boolean): LotView[] {
  return lots.map((lot, index) => ({
    key: `${lot.account_id}-${lot.acquired}-${index}`,
    accountId: lot.account_id,
    acquired: formatEtDay(lot.acquired),
    shares: maskedQuantity(masked, lot.shares),
    cost: formatUsdPrice(lot.cost_per_share),
    term: lot.term === "long" ? "Long term" : "Short term",
    gain: { text: formatSignedPct(lot.gain_pct, 1), tone: signTone(lot.gain_pct) },
  }));
}

export type ShortCallView = { key: string; accountId: number; title: string; contracts: string; moneyness: string; risks: string[] };

/** An open short call with its risks in words; a call with none says so instead of staying silent. */
export function shortCallViews(calls: readonly ShortCall[], masked: boolean): ShortCallView[] {
  return calls.map((call) => ({
    key: String(call.id),
    accountId: call.account_id,
    title: `${formatUsdPrice(call.strike)} call · ${formatEtDay(call.expiry)} · ${call.dte} ${call.dte === 1 ? "day" : "days"} left`,
    contracts: `${maskedQuantity(masked, call.contracts)} ${call.contracts === 1 ? "contract" : "contracts"}`,
    moneyness: call.moneyness_pct === null ? EMPTY_VALUE : `${formatSignedPct(call.moneyness_pct)} from the strike`,
    risks: call.risks.length === 0 ? ["No risk flagged"] : call.risks.map((risk) => risk.text),
  }));
}

export type CallsCard = {
  coverable: string;
  openCalls: string;
  best: { annualized: string; strike: string; expiry: string; bid: string } | null;
  /** Why there is no best call: the chain is not connected, or nothing passed the filters. */
  note: string | null;
};

/** The covered-call mini card of the right rail: coverable and open contracts hide while values are hidden. */
export function callsCard(symbol: string, coverage: readonly CoverageRow[], shortCalls: readonly ShortCall[], candidates: Candidates | null, masked: boolean): CallsCard {
  const coverable = coverage.filter((row) => row.symbol === symbol).reduce((sum, row) => sum + row.coverable, 0);
  const open = shortCalls.filter((call) => call.symbol === symbol).reduce((sum, call) => sum + call.contracts, 0);
  const top = candidates?.candidates[0];
  const unavailable = candidates !== null && (candidates.chain_stamp.freshness === "unavailable" || candidates.chain_stamp.quality === "unavailable");
  return {
    coverable: maskedQuantity(masked, coverable),
    openCalls: maskedQuantity(masked, open),
    // annualized_yield is a fraction from the engine; x100 is only its display form.
    best: top ? { annualized: formatPct(top.annualized_yield * 100, 1), strike: formatUsdPrice(top.strike), expiry: formatEtDay(top.expiry), bid: formatUsdPrice(top.bid) } : null,
    note: top ? null : unavailable ? COPY.optionQuotesNotConnected : candidates === null ? null : "No call passes the scan filters today",
  };
}

export type EventLine = { key: string; label: string; text: string };

/** Next earnings (date and timing when the consensus knows it) and the ex-dividend date or the word that it is unknown. */
export function eventLines(row: HoldingRow | null, research: Research | null): EventLine[] {
  const earnings = research?.consensus?.next_earnings;
  const date = earnings?.date ?? row?.next_earnings ?? null;
  return [
    { key: "earnings", label: "Earnings", text: date ? `${formatEtDay(date)}${earnings ? ` · ${timingLabel(earnings.timing.replaceAll(" ", "_"))}` : ""}` : "Date not known yet" },
    { key: "ex_dividend", label: "Ex-dividend", text: row?.fundamentals.ex_dividend ? formatEtDay(row.fundamentals.ex_dividend) : COPY.exDividendUnknown },
  ];
}
