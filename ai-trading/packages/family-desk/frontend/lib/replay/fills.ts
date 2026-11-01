import { z } from "zod";
import type { components } from "../api/openapi.js";
import { clientOf, deskPath, readInit, type RequestOptions } from "../desk/api.ts";
import { EMPTY_VALUE, formatEtTime, formatNumber, formatPrice } from "../desk/format.ts";
import { practiceText } from "../desk/freshness.ts";
import type { Thread } from "./threads.ts";

// The Fills panel of a day thread's Trades screen: every Buy and Sell the server booked (`GET /replay/threads/{id}/fills`, ADR-0018).
// The server keeps the book; the screen only lists it. Checked against the generated OpenAPI with `satisfies` like threads.ts. Dates
// stay hidden: a fill's day is "Day 3 · Wed" (read off the thread's own days), its time is the ET clock. Every figure is SIMULATED.

const finite = z.number().finite();

export const FillSchema = z.object({
  id: finite.int(),
  session_id: finite.int(),
  symbol: z.string(),
  day: z.iso.date(),
  action: z.enum(["buy", "sell"]),
  shares: finite.int(),
  price: finite,
  at: z.iso.datetime({ offset: true }),
  /** Of `shares`, how many closed the name's position; `opens` opened or added to one (a flip has both). */
  closes: finite.int(),
  opens: finite.int(),
  trade_no: finite.int().nullable(),
  source: z.enum(["her", "auto"]),
}) satisfies z.ZodType<components["schemas"]["FillOut"]>;

/** Newest first; `total` counts every fill of the thread, so it can exceed `fills`. */
export const ThreadFillsSchema = z.object({
  thread_id: finite.int(),
  total: finite.int(),
  fills: z.array(FillSchema),
}) satisfies z.ZodType<components["schemas"]["ThreadFillsOut"]>;

export type Fill = z.infer<typeof FillSchema>;
export type ThreadFills = z.infer<typeof ThreadFillsSchema>;

/** A day thread only: a swing thread keeps its positions as holds and answers 404. */
export const loadThreadFills = (threadId: number, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/replay/threads/${threadId}/fills`), ThreadFillsSchema, readInit(options));

/** What a fill did to the name's position. */
export function fillEffect({ closes, opens }: Pick<Fill, "closes" | "opens">): string {
  if (closes > 0 && opens > 0) return "Flipped";
  if (closes > 0) return "Closed";
  return opens > 0 ? "Opened or added" : EMPTY_VALUE;
}

/** ISO date to "Day 3 · Wed" for each day the thread has opened (its ended days and the open one), so no calendar date is shown. */
export function dayLabels(thread: Pick<Thread, "daily" | "today">): Map<string, string> {
  const days = thread.daily.map(({ day, n, weekday }) => ({ day, n, weekday }));
  if (thread.today !== null) days.push({ day: thread.today.day, n: thread.today.day_no, weekday: thread.today.weekday });
  return new Map(days.map(({ day, n, weekday }) => [day, practiceText("swingDayShort", { day: n, weekday })]));
}

export type FillRow = { key: string; day: string; time: string; symbol: string; action: string; shares: string; price: string; effect: string };

export const fillRows = (fills: readonly Fill[], labels: ReadonlyMap<string, string>): FillRow[] =>
  fills.map((fill) => ({
    key: String(fill.id),
    day: labels.get(fill.day) ?? EMPTY_VALUE,
    time: formatEtTime(fill.at),
    symbol: fill.symbol,
    action: fill.action === "buy" ? "Buy" : "Sell",
    shares: formatNumber(fill.shares, 0),
    price: formatPrice(fill.price),
    effect: `${fillEffect(fill)}${fill.source === "auto" ? " (auto, window end)" : ""}`,
  }));
