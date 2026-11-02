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
  const rows = new Map((table !== null && table.interval === interval ? table.rows : []).map((row) => [ms(row.t), row]));
  const pick = (value: (row: IndicatorTable["rows"][number]) => number | null): Array<number | null> => bars.map((bar) => (rows.get(ms(bar.t)) ? value(rows.get(ms(bar.t))!) : null));
  const vwap = pick((row) => row.vwap);
  const last = bars.length - 1;
  if (formingAt !== null && last > 0 && bars[last]!.t === formingAt && vwap[last] === null && rows.has(ms(bars[last]!.t))) vwap[last] = vwap[last - 1] ?? null;
  return {
    vwap,
    ema9: pick((row) => row.ema9),
    ema21: pick((row) => row.ema21),
    rsi14: pick((row) => row.rsi14),
    macd: { dif: pick((row) => row.macd), signal: pick((row) => row.macd_signal), histogram: pick((row) => row.macd_hist) },
  };
}
