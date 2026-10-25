import { formatNumber, formatPrice } from "../desk/format.ts";
import { PRACTICE_COPY, practiceText } from "../desk/freshness.ts";
import type { PaceView, ReplayView, TapeRow } from "./feedState.ts";
import type { TapeFeed } from "./schemas.ts";

// View logic of the time & sales tape (02o §a3): size filter chips, big prints, the pace meter and the labels.
// The server filters and caps; these helpers only choose parameters and word what came back.

export type SizeFilterId = "all" | "100" | "1000" | "big";
export type SizeFilter = { id: SizeFilterId; label: string; minSize: number; bigOnly: boolean };

export const SIZE_FILTERS: readonly SizeFilter[] = [
  { id: "all", label: "All", minSize: 0, bigOnly: false },
  { id: "100", label: "≥100", minSize: 100, bigOnly: false },
  { id: "1000", label: "≥1,000", minSize: 1000, bigOnly: false },
  { id: "big", label: "Big only", minSize: 0, bigOnly: true },
];

/** Used for the amber highlight and the "Big only" chip until the API reports its own `big_print_usd`. */
export const DEFAULT_BIG_PRINT_USD = 200_000;

export const filterById = (id: SizeFilterId): SizeFilter => SIZE_FILTERS.find((filter) => filter.id === id) ?? SIZE_FILTERS[0]!;

export type TapeQuery = { minSize: number; minNotional: number };

/** The request parameters of a filter chip. Big only asks the server for prints worth at least the big-print notional. */
export function tapeQuery(filter: SizeFilter, bigPrintUsd: number | null): TapeQuery {
  return { minSize: filter.minSize, minNotional: filter.bigOnly ? (bigPrintUsd ?? DEFAULT_BIG_PRINT_USD) : 0 };
}

export const isBigPrint = (row: Pick<TapeRow, "price" | "size">, bigPrintUsd: number | null): boolean =>
  row.price * row.size >= (bigPrintUsd ?? DEFAULT_BIG_PRINT_USD);

export type TickTone = "up" | "down" | "same";
export const tickTone = (tick: -1 | 0 | 1): TickTone => (tick > 0 ? "up" : tick < 0 ? "down" : "same");

export type TapeDisplayRow = { key: string; t: string; price: string; size: string; tone: TickTone; big: boolean };

/** Newest first, as a tape reads. At most `limit` rows are drawn so a fast tape stays cheap to paint. */
export function tapeRows(view: Pick<ReplayView, "tape" | "tapeMeta">, limit = 120): TapeDisplayRow[] {
  const big = view.tapeMeta?.bigPrintUsd ?? null;
  const rows: TapeDisplayRow[] = [];
  for (let index = view.tape.length - 1; index >= 0 && rows.length < limit; index -= 1) {
    const row = view.tape[index]!;
    rows.push({ key: `${row.t}:${index}`, t: row.t, price: formatPrice(row.price), size: formatNumber(row.size, 0), tone: tickTone(row.tick), big: isBigPrint(row, big) });
  }
  return rows;
}

export const feedLabel = (feed: TapeFeed): string => (feed === "sip" ? PRACTICE_COPY.feedSip : PRACTICE_COPY.feedIex);

/** "Fast tape · showing the latest 500 of 1,043 prints"; null when nothing was capped. */
export function fastTapeText(meta: { shown: number; count: number } | null): string | null {
  if (!meta || meta.shown >= meta.count) return null;
  return practiceText("fastTape", { shown: formatNumber(meta.shown, 0), count: formatNumber(meta.count, 0) });
}

/** "No prints for 95 s · the stock may be halted", or "2 min 14 s" past two minutes; null while prints flow. */
export function haltedTapeText(quietS: number | null): string | null {
  if (quietS === null) return null;
  const time = quietS < 120 ? `${quietS} s` : `${Math.floor(quietS / 60)} min ${String(quietS % 60).padStart(2, "0")} s`;
  return practiceText("haltedTape", { time });
}

const BAND_LABEL = { quiet: "Quiet", steady: "Steady", busy: "Busy", frantic: "Frantic" } as const;

/** "12 prints/s · 3,400 sh/s · Busy · 1.8x avg". */
export function paceText(pace: PaceView | null): string {
  if (!pace) return "Pace · waiting for prints";
  const parts = [
    `${formatNumber(pace.printsPerSecond, pace.printsPerSecond < 10 ? 1 : 0)} prints/s`,
    `${formatNumber(pace.sharesPerSecond, 0)} sh/s`,
  ];
  if (pace.band) parts.push(BAND_LABEL[pace.band]);
  if (pace.timesAverage != null) parts.push(`${formatNumber(pace.timesAverage, 1)}x avg`);
  return parts.join(" · ");
}

/** Bar fill 0..1 for the pace meter: the band when the API gives one, else a log-ish scale of shares per second. */
export function paceLevel(pace: PaceView | null): number {
  if (!pace) return 0;
  if (pace.band) return { quiet: 0.2, steady: 0.5, busy: 0.78, frantic: 1 }[pace.band];
  return Math.min(1, Math.log10(1 + pace.sharesPerSecond) / 5);
}
