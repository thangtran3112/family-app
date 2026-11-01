import type { Holdings, Income, ShortCall } from "../api/fundamentalSchemas.ts";
import { changeTone, EMPTY_VALUE, formatEtDay, formatSignedPct, type Tone } from "./format.ts";
import { COPY } from "./freshness.ts";
import { hasHoldingsData, importLine } from "./fundamentalView.ts";
import { formatUsdPrice, maskedSignedUsd, maskedUsd } from "./mask.ts";

// FD2 Today, Fundamental variant (02n §b3). `GET /dashboard/fundamental` is gated until its sources exist, so the screen
// builds the "Needs you" feed and its tiles here from the real holdings, short-call and income reads. Pure: the as-of day
// comes in as `today` (a New York `YYYY-MM-DD`), nothing reads a clock.

export type FeedKind = "short_call_risk" | "earnings_soon" | "ex_dividend" | "import";
export type FeedItem = { kind: FeedKind; symbol: string | null; title: string; detail: string; at: string; href: string };

export const FEED_LIMIT = 20;
export const EARNINGS_FEED_DAYS = 7;
export const EVENTS_DAYS = 14;
const CALLS_HREF = "/covered-calls#income";

const DAY_MS = 86_400_000;
const dayNumber = (date: string): number => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / DAY_MS;

/** Whole calendar days from one `YYYY-MM-DD` to another (negative when `to` is earlier). */
export const daysBetween = (from: string, to: string): number => Math.round(dayNumber(to) - dayNumber(from));

const daysLeft = (days: number): string => (days <= 0 ? "expires today" : days === 1 ? "1 day left" : `${days} days left`);

function inDaysText(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

export type UpcomingEarnings = { symbol: string; date: string; day: string; when: string };

/** Held symbols that report from `today` through `days` days later, soonest first. */
export function upcomingEarnings(holdings: Holdings | null, today: string, days: number): UpcomingEarnings[] {
  if (!holdings || !hasHoldingsData(holdings.import)) return [];
  return holdings.rows
    .flatMap((row) => {
      const away = row.next_earnings === null ? null : daysBetween(today, row.next_earnings);
      return row.next_earnings !== null && away !== null && away >= 0 && away <= days
        ? [{ symbol: row.symbol, date: row.next_earnings, day: formatEtDay(row.next_earnings), when: inDaysText(away) }]
        : [];
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol));
}

/**
 * What needs the owner, most pressing first: import problems, short-call risks (soonest expiry first), ex-dividend dates
 * before a call expires, earnings within a week, then the one "ex-dividend date unknown" reminder. At most `FEED_LIMIT`
 * items. Covered-call opportunities and Desk AI changes join when their sources do (steps 5 and 6), never as stand-ins.
 */
export function needsYouFeed({ holdings, shortCalls, today }: { holdings: Holdings | null; shortCalls: readonly ShortCall[] | null; today: string }): FeedItem[] {
  const items: FeedItem[] = [];
  if (holdings) {
    const line = importLine(holdings.import);
    // A good or running import needs nothing; a failed, not-connected or empty one does (the tone no longer tells these apart).
    if (holdings.import.state === "failed" || holdings.import.state === "not_configured" || holdings.import.state === "none") {
      items.push({ kind: "import", symbol: null, title: line.text, detail: "Holdings import", at: holdings.import.imported_at ?? today, href: "/settings" });
    }
  }
  const calls = [...(shortCalls ?? [])].sort((a, b) => a.dte - b.dte || a.symbol.localeCompare(b.symbol) || a.id - b.id);
  const callText = (call: ShortCall) => `${call.symbol} · ${formatUsdPrice(call.strike)} call · expires ${formatEtDay(call.expiry)}`;

  for (const call of calls) {
    for (const risk of call.risks) {
      items.push({ kind: "short_call_risk", symbol: call.symbol, title: risk.text, detail: `${callText(call)} · ${daysLeft(call.dte)}`, at: call.stamp.as_of ?? today, href: CALLS_HREF });
    }
  }

  const rows = new Map((holdings?.rows ?? []).map((row) => [row.symbol, row]));
  const unknownDividend = new Set<string>();
  const dated: FeedItem[] = [];
  for (const call of calls) {
    // The engine already says so when it can (it needs the extrinsic value); do not repeat it.
    if (call.risks.some((risk) => risk.kind === "early_assignment_before_dividend")) continue;
    const row = rows.get(call.symbol);
    if (!row) continue;
    const exDividend = row.fundamentals.ex_dividend ?? null;
    if (exDividend === null) unknownDividend.add(call.symbol);
    else if (exDividend >= today && exDividend <= call.expiry) {
      dated.push({
        kind: "ex_dividend",
        symbol: call.symbol,
        title: `${call.symbol} goes ex-dividend ${formatEtDay(exDividend)}`,
        detail: `Before the ${formatUsdPrice(call.strike)} call expires ${formatEtDay(call.expiry)} · early assignment is possible`,
        at: exDividend,
        href: CALLS_HREF,
      });
    }
  }
  items.push(...dated.sort((a, b) => a.at.localeCompare(b.at) || (a.symbol ?? "").localeCompare(b.symbol ?? "")));

  for (const earnings of upcomingEarnings(holdings, today, EARNINGS_FEED_DAYS)) {
    items.push({
      kind: "earnings_soon",
      symbol: earnings.symbol,
      title: `${earnings.symbol} reports earnings ${earnings.when}`,
      detail: earnings.day,
      at: earnings.date,
      href: `/stocks?symbol=${encodeURIComponent(earnings.symbol)}#overview`,
    });
  }

  if (unknownDividend.size > 0) {
    items.push({ kind: "ex_dividend", symbol: null, title: COPY.exDividendUnknown, detail: [...unknownDividend].sort().join(", "), at: today, href: CALLS_HREF });
  }
  return items.slice(0, FEED_LIMIT);
}

export type TodayTile = { id: string; label: string; value: string; note: string | null; tone: Tone };

const tile = (id: string, label: string, value: string, note: string | null = null, tone: Tone = "flat"): TodayTile => ({ id, label, value, note, tone });

/** Portfolio value, day change and unrealized gain. Dollars hide while `masked`; percentages stay. Without holdings every tile is a dash. */
export function portfolioTiles(holdings: Holdings | null, masked: boolean): TodayTile[] {
  const totals = holdings && hasHoldingsData(holdings.import) ? holdings.totals : null;
  const day = totals && totals.day_change_pct !== null ? `${maskedSignedUsd(masked, totals.day_change)} · ${formatSignedPct(totals.day_change_pct)}` : EMPTY_VALUE;
  const unrealizedUsd = maskedSignedUsd(masked, totals?.unrealized);
  return [
    tile("value", "Portfolio value", maskedUsd(masked, totals?.market_value)),
    tile("day", "Day change", day, null, changeTone(totals?.day_change_pct)),
    tile("unrealized", "Unrealized", formatSignedPct(totals?.unrealized_pct), unrealizedUsd === EMPTY_VALUE ? null : unrealizedUsd, changeTone(totals?.unrealized_pct)),
  ];
}

/** Premium sold this month. Until the Flex query carries Trades the income is not known, and the tile says so instead of showing zero. */
export function incomeTile(income: Income | null, today: string, masked: boolean): TodayTile {
  if (!income) return tile("income", "Income this month", EMPTY_VALUE);
  if (income.state === "needs_trades") return tile("income", "Income this month", EMPTY_VALUE, "Needs the Flex Trades section");
  const month = income.by_month.find((entry) => entry.month === today.slice(0, 7));
  return tile("income", "Income this month", maskedUsd(masked, month?.premium ?? 0), "Premium sold, month to date");
}

/** How many short calls are open and when the first expires. */
export function openCallsTile(shortCalls: readonly ShortCall[] | null): TodayTile {
  if (!shortCalls) return tile("open-calls", "Open calls", EMPTY_VALUE);
  if (shortCalls.length === 0) return tile("open-calls", "Open calls", "None");
  const next = shortCalls.map((call) => call.expiry).sort()[0]!;
  return tile("open-calls", "Open calls", String(shortCalls.length), `Next expiry ${formatEtDay(next)}`);
}
