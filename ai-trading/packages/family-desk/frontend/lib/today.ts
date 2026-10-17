import type { z } from "zod";
import { deskFetch } from "./api/client.ts";
import {
  AlertOutSchema,
  BarsSchema,
  SignalsResponseSchema,
  WatchlistsResponseSchema,
  WatchlistItemsSchema,
} from "./api/schemas.ts";
import type { Quality } from "./labels.ts";

export type DeskFetcher = typeof deskFetch;
export type AssetType = "stock" | "future";
export type DailyBar = Pick<z.infer<typeof BarsSchema>["bars"][number], "t" | "c">;
export type TodaySignal = Pick<z.infer<typeof SignalsResponseSchema>[number], "symbol" | "created_at">;

export function marketSymbol(symbol: string, assetType: AssetType): string {
  return assetType === "future" && !symbol.startsWith("/") ? `/${symbol}` : symbol;
}

export function marketDataPath(prefix: string, symbol: string, assetType: AssetType): string {
  return `${prefix}/${encodeURIComponent(marketSymbol(symbol, assetType))}`;
}

export async function loadOwnedWatchlists(fetcher: DeskFetcher = deskFetch) {
  const watchlists = await fetcher("/api/desk/watchlists", WatchlistsResponseSchema);
  return Promise.all(
    watchlists.map(async (watchlist) => ({
      ...watchlist,
      items: await fetcher(`/api/desk/watchlists/${watchlist.id}/items`, WatchlistItemsSchema),
    })),
  );
}

export function loadDailyBars(symbol: string, assetType: AssetType, fetcher: DeskFetcher = deskFetch) {
  const path = marketDataPath("/api/desk/bars", symbol, assetType);
  return fetcher(`${path}?interval=1d&days=30`, BarsSchema);
}

export function loadTodaySignals(fetcher: DeskFetcher = deskFetch) {
  return (async () => {
    const pageSize = 200;
    const signals: z.infer<typeof SignalsResponseSchema> = [];
    for (let offset = 0; ; offset += pageSize) {
      const page = await fetcher(`/api/desk/signals?limit=${pageSize}&offset=${offset}`, SignalsResponseSchema);
      signals.push(...page);
      if (page.length < pageSize) return signals;
    }
  })();
}

export function markAlertRead(alertId: number, fetcher: DeskFetcher = deskFetch) {
  return fetcher(`/api/desk/alerts/${alertId}/read`, AlertOutSchema, { method: "POST" });
}

function validDateOnly(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day] = match;
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return parsed.getUTCFullYear() === Number(year) &&
    parsed.getUTCMonth() === Number(month) - 1 &&
    parsed.getUTCDate() === Number(day)
    ? value
    : null;
}

export function newYorkDate(value: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return validDateOnly(value);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const part = Object.fromEntries(parts.map(({ type, value: text }) => [type, text]));
  return `${part.year}-${part.month}-${part.day}`;
}

export function previousDailyClose(bars: readonly DailyBar[], quoteAsOf: string): number | null {
  const tradingDate = newYorkDate(quoteAsOf);
  if (!tradingDate) return null;
  let previous: DailyBar | undefined;
  for (const bar of bars) {
    const date = validDateOnly(bar.t);
    if (date && date < tradingDate && (!previous || date > previous.t)) previous = bar;
  }
  return previous && typeof previous.c === "number" && Number.isFinite(previous.c) && previous.c !== 0
    ? previous.c
    : null;
}

export function dailyChange(current: number | null | undefined, previousClose: number | null): {
  amount: number;
  percent: number;
} | null {
  if (typeof current !== "number" || !Number.isFinite(current) || previousClose === null ||
      !Number.isFinite(previousClose) || previousClose === 0) return null;
  const amount = current - previousClose;
  const percent = (amount / previousClose) * 100;
  return Number.isFinite(amount) && Number.isFinite(percent) ? { amount, percent } : null;
}

const priceFormatter = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatPrice(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? priceFormatter.format(value) : "not available";
}

export function formatChange(change: ReturnType<typeof dailyChange>): string {
  if (!change) return "not available";
  const signed = (value: number) => `${value < 0 ? "−" : "+"}${priceFormatter.format(Math.abs(value))}`;
  return `${signed(change.amount)} (${signed(change.percent)}%)`;
}

export function formatAsOf(value: string | null | undefined): string {
  if (!value) return "not available";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const dateOnly = validDateOnly(value);
    if (!dateOnly) return "not available";
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(`${dateOnly}T12:00:00Z`));
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "not available";
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(timestamp));
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
  return `${date}, ${time} ET`;
}

export function quoteAsOfCaption(asOf: string | null, quality: Quality, now = Date.now()): string {
  const formatted = formatAsOf(asOf);
  if (formatted === "not available") return formatted;
  const timestamp = asOf ? Date.parse(asOf) : Number.NaN;
  const stale = quality === "delayed-15m" || quality === "fallback" ||
    (Number.isFinite(timestamp) && now - timestamp > 120_000);
  return `${stale ? "Last known · " : ""}as of ${formatted}`;
}

export function countSignalsToday(
  signals: readonly TodaySignal[],
  symbol: string,
  today: string,
): number {
  return signals.filter((signal) => signal.symbol === symbol && newYorkDate(signal.created_at) === today).length;
}
