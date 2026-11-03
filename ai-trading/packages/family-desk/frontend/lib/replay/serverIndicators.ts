import type { ServerSeries } from "../desk/workspace.ts";
import type { IndicatorTable } from "./feedState.ts";
import type { ReplayBar } from "./schemas.ts";
import { firstBarFrom, ms } from "./time.ts";

// The replay chart and the left rail draw the indicators the server computed (ADR-0022), from the same cut as the bars, the price and the forming
// candle, so the header price, the forming candle's close, EMA 9/21, VWAP, RSI and MACD are one payload. The browser only lines the rows up with
// the bars it draws; it computes nothing (the live workspace still does, with `buildChartSeries`).

type Row = IndicatorTable["rows"][number];
type Bars = readonly Pick<ReplayBar, "t">[];
const NO_ROWS: readonly Row[] = [];

/** What the last call laid out, so the next one (a poll that adds a bar) redoes only what changed (D-217). `ordered`: its bars and its rows both ascend by start. */
let last: { bars: Bars; rows: readonly Row[]; interval: string; out: ServerSeries; ordered: boolean } | null = null;

/** How many leading items of `a` and `b` are the very same object. */
function sharedPrefix(a: readonly object[], b: readonly object[]): number {
  const most = Math.min(a.length, b.length);
  let at = 0;
  while (at < most && a[at] === b[at]) at += 1;
  return at;
}

/** True when the starts of `list` ascend from item `from - 1` on (the items before are known to). */
function ascendsFrom(list: readonly { t: string }[], from: number): boolean {
  for (let index = Math.max(1, from); index < list.length; index += 1) if (!(ms(list[index]!.t) > ms(list[index - 1]!.t))) return false;
  return true;
}

const emptySeries = (): ServerSeries => ({ vwap: [], ema9: [], ema21: [], rsi14: [], macd: { dif: [], signal: [], histogram: [] } });

/**
 * The server's rows laid on `bars` by bar open. A bar with no row (or a table for another interval) reads unknown, never a stale or filled value.
 * One carry: the server gives the forming candle (`formingAt`) a VWAP only once a minute inside it has closed, so on a 1m chart it never has one. The candle
 * then reads the VWAP of the bar before it (as of the last closed minute), as the old minute-bar VWAP did (D-168), so the newest point is not a hole.
 *
 * The feed keeps the bars and the rows in ascending order of start, and every bar and row that did not change as the same object. A new poll then differs
 * from the last at its tail only: the lines up to the first bar or row that changed are copied from the last answer, and only the rest is laid out again, by
 * walking the bars and the rows together (parsing the 6,000 start times of a 1m chart on every bar was 5 ms of the main thread, D-206, D-217). The answer is the
 * same as laying every bar out by a lookup of its start; rows or bars that are not in order are laid out that way.
 */
export function serverSeries(bars: Bars, table: IndicatorTable | null, interval: string, formingAt: string | null = null): ServerSeries {
  const rows = table !== null && table.interval === interval ? table.rows : NO_ROWS;
  const count = bars.length;
  const before = last !== null && last.interval === interval ? last : null;
  const sharedBars = before !== null ? sharedPrefix(bars, before.bars) : 0;
  const sharedRows = before !== null ? sharedPrefix(rows, before.rows) : 0;
  // Only what is new since the last answer has to be checked for order, when the last answer was in order.
  const fromBar = before !== null && before.ordered ? sharedBars : 0;
  const fromRow = before !== null && before.ordered ? sharedRows : 0;
  const ordered = ascendsFrom(bars, fromBar) && ascendsFrom(rows, fromRow);
  const out = emptySeries();
  let newest: Row | undefined;
  if (!ordered) {
    const byStart = new Map<number, Row>();
    for (const row of rows) byStart.set(ms(row.t), row);
    for (let index = 0; index < count; index += 1) {
      const row = byStart.get(ms(bars[index]!.t));
      setLine(out, index, row);
      newest = row;
    }
  } else {
    let from = 0;
    if (before !== null && before.ordered) {
      from = sharedBars;
      // The first row that is not the one before: bars that start earlier have the rows they had.
      const earliest = Math.min(rows[sharedRows] ? ms(rows[sharedRows]!.t) : Number.POSITIVE_INFINITY, before.rows[sharedRows] ? ms(before.rows[sharedRows]!.t) : Number.POSITIVE_INFINITY);
      if (earliest !== Number.POSITIVE_INFINITY) from = Math.min(from, firstBarFrom(bars, earliest));
      from = Math.min(from, Math.max(0, count - 1)); // the newest bar is always laid out again: it may be, or have been, the forming one
      const kept = before.out;
      out.vwap = kept.vwap.slice(0, from);
      out.ema9 = kept.ema9.slice(0, from);
      out.ema21 = kept.ema21.slice(0, from);
      out.rsi14 = kept.rsi14.slice(0, from);
      out.macd = { dif: kept.macd.dif.slice(0, from), signal: kept.macd.signal.slice(0, from), histogram: kept.macd.histogram.slice(0, from) };
    }
    // Walk the bars and the rows together from `from`: the string is compared first, the start time parsed only where the two spellings differ.
    let at = rows.length === 0 || from >= count ? 0 : firstBarFrom(rows, ms(bars[from]!.t));
    for (let index = from; index < count; index += 1) {
      const start = bars[index]!.t;
      while (at < rows.length && rows[at]!.t !== start && ms(rows[at]!.t) < ms(start)) at += 1;
      const row = at < rows.length && (rows[at]!.t === start || ms(rows[at]!.t) === ms(start)) ? rows[at] : undefined;
      setLine(out, index, row);
      newest = row;
    }
  }
  const lastIndex = count - 1;
  if (formingAt !== null && lastIndex > 0 && bars[lastIndex]!.t === formingAt && out.vwap[lastIndex] === null && newest !== undefined) out.vwap[lastIndex] = out.vwap[lastIndex - 1] ?? null;
  last = { bars, rows, interval, out, ordered };
  return out;
}

function setLine(out: ServerSeries, index: number, row: Row | undefined): void {
  out.vwap[index] = row ? row.vwap : null;
  out.ema9[index] = row ? row.ema9 : null;
  out.ema21[index] = row ? row.ema21 : null;
  out.rsi14[index] = row ? row.rsi14 : null;
  out.macd.dif[index] = row ? row.macd : null;
  out.macd.signal[index] = row ? row.macd_signal : null;
  out.macd.histogram[index] = row ? row.macd_hist : null;
}
