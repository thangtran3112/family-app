# ADR-0022 — One thread time: pinned payloads, prepared data, no date masking

Every surface of a day-trade thread agrees on one time — the thread clock after `settle` — and the date is visible always, not hidden behind spoiler protection.

**Why.** The thread clock runs through the close, after-hours, overnight and the weekend, but the day list, the chart and the positions priced it independently: a name's tape end was frozen into its session row (a legacy row kept a 16:00 end while the Summary said 20:00); the name's payload carried a clamped `day_clock` while the Summary extrapolated the uncapped T; a name's chart was cut at its own stored playhead, which only the active tab's sync poll moved, and failed polls were silent; the header price, the forming candle, the indicators, VWAP and the day-list `live` block all came from separate reads at different instants. A day list at a clock past 20:00 showed dashes ("no data") because the live read per clock minute re-decoded 720 blobs and burned seconds of CPU under the day-list row lock, so a slow or cut-off request returned no live block.

**The decision.** Six invariants:

1. **One instant.** `thread_time` (uncapped T) is on every thread-scoped payload. Every label carries the payload's own time.
2. **One tape end.** An open day-thread session's tape end is always `market_close(day, "extended")` (20:00 ET), derived at read time, never read from a stored cell. Ended sessions keep their stored end.
3. **One price function.** `frames.quote_at(symbol, day, T)` prices every surface: chart header, forming candle, day-list `live`, positions, account and mark fills.
4. **One computation of price and indicators.** The server returns bars, forming candle, price, EMA 9/21, VWAP, RSI 14 and MACD from one cut in one call. The browser draws them without a separate data path or recomputing.
5. **Reads don't move data.** The same T gives byte-identical output. Only the clock moves time.
6. **No lookahead.** `PreparedSeries` holds the whole day server-side but exposes only `.at(T)` (causal indicators; a `_bend`-after-T test proves no future data leaks).

The practice date is visible always — the "hidden day" / "replayed market date" / "date hidden" / "show date" spoiler strings, the `dateShown` helper, every `hideDates` prop and every backend `hide_date`/`dates_hidden` response field are gone, and the thread date is rendered as `Fri 2026-10-23 · 1:22:24 AM ET` on the Summary and every Practice page. The "Practice window 10:00–11:30", the "Stop on every entry" requirement and the "Focus until" 11:30 mark are removed as dead guidance the owner rejected.

A day-trade thread is capped at 10 active across all users (advisory lock on create) and a day list is capped at 49 names. A prepared series is warmed for every name when a day opens and on interval change, and the caches (`History.LRU_DAYS 64`, `PreparedSeries` LRU 128) keep decoding local. Day-list live-read cost dropped from about 3.6 s to about 0.03 s per read (720 blob decodes → one per-name pre-warmed metric row). No migration; the tape-end change is a read-time derive, not a data rewrite.