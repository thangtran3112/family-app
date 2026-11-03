import type { ServerSeries } from "../desk/workspace.ts";
import type { IndicatorTable } from "./feedState.ts";
import type { ReplayBar } from "./schemas.ts";
import { ms } from "./time.ts";

// The replay chart and the left rail draw the indicators the server computed (ADR-0022), from the same cut as the bars, the price and the forming
// candle, so the header price, the forming candle's close, EMA 9/21, VWAP, RSI and MACD are one payload. The browser only lines the rows up with
// the bars it draws; it computes nothing (the live workspace still does, with `buildChartSeries`).

/**
 * The server's rows laid on `bars` by bar open. A bar with no row (or a table for another interval) reads unknown, never a stale or filled value.
 * One carry: the server gives the forming candle (`formingAt`) a VWAP only once a minute inside it has closed, so on a 1m chart it never has one. The candle
 * then reads the VWAP of the bar before it (as of the last closed minute), as the old minute-bar VWAP did (D-168), so the newest point is not a hole.
 */
export function serverSeries(bars: readonly Pick<ReplayBar, "t">[], table: IndicatorTable | null, interval: string, formingAt: string | null = null): ServerSeries {
  const rows = new Map<number, IndicatorTable["rows"][number]>();
  if (table !== null && table.interval === interval) for (const row of table.rows) rows.set(ms(row.t), row);
  // One pass, one lookup a bar: parsing the 6,000 start times and reading each row five times over was 15 ms of every new bar (D-206).
  const count = bars.length;
  const out: ServerSeries = { vwap: new Array(count), ema9: new Array(count), ema21: new Array(count), rsi14: new Array(count), macd: { dif: new Array(count), signal: new Array(count), histogram: new Array(count) } };
  for (let index = 0; index < count; index += 1) {
    const row = rows.get(ms(bars[index]!.t));
    out.vwap[index] = row ? row.vwap : null;
    out.ema9[index] = row ? row.ema9 : null;
    out.ema21[index] = row ? row.ema21 : null;
    out.rsi14[index] = row ? row.rsi14 : null;
    out.macd.dif[index] = row ? row.macd : null;
    out.macd.signal[index] = row ? row.macd_signal : null;
    out.macd.histogram[index] = row ? row.macd_hist : null;
  }
  const last = count - 1;
  if (formingAt !== null && last > 0 && bars[last]!.t === formingAt && out.vwap[last] === null && rows.has(ms(bars[last]!.t))) out.vwap[last] = out.vwap[last - 1] ?? null;
  return out;
}
