# Walkthrough wave 12: the Practice desk on `dev` (`8525da6a`)

Date: 2026-11-02. New defects D-195 to D-197 (3: P0 0, P1 0, P2 1, P3 2). Nothing was fixed in this lane.
Wave-11 verification (D-186 to D-194, the fixes of #372 and #373): all nine hold on the paths their rows name. D-186 and D-187 leave one neighbour: the
replay chart goes bunched at the left edge again when new bars arrive while it is open (D-195). No `Fixed` row was touched.

Screenshots are not in the repository; the names below are files in the run's `walk-12/` directory (outside the repo, next to the run's copy of this report).
A name ending `-1440` or `-1180` is the viewport width; `-tall` is the same screen on a 2,600 px viewport; names starting `300` are chart-only crops or full
pages from the D-186/D-187 sampling, `350` to `370` are timelines of the live-update path, `crop-price-scale-*` are 2x crops of the replay price axis. Each
screenshot has a `.json` next to it with the probe facts (clipped text, scrollers, type under 11 px, unnamed controls, banned wording, SVG labels that overlap one
another, sit on a drawn series or are cut by their box, the main region's text). `walk-12/evidence/` holds the 33 throwaway specs, the throwaway Playwright config, the
sampling outputs and the run logs (none of them is in the commit).

## How it was run

- Cut: `origin/dev` `8525da6a` (carries #372 and #373). Worktree `practice-walk-12`, branch `feature/practice-walk-12`. `origin/dev` moved to `5a0367d2` while the lane ran
  (backend only: the thread-time sync `f16da96a` and the deploy gate #376; no frontend file, no `DEFECTS.md` row); that code was not exercised.
- Harness: the Desk e2e stack through `tests/e2e/run.py --browser -- …` exactly as `e2e/README.md` describes for "Without Docker": a disposable `desk_e2e_<hex>` database in
  another session's tmpfs `desk-test-postgres` container (`DESK_E2E_ADMIN_DATABASE_URL`, loopback), the static export built from this worktree (`pnpm build`),
  `browser_server.py` and `proxy.mjs` on ports 19744 and 19745, `--output=/tmp/w12/pw-<tag>`, one worker. No Docker, no `pnpm test:e2e`. Every run's database was dropped by `run.py`.
- 33 throwaway specs (the wave-11 set re-pointed, plus eight new ones: the D-186/D-187 round trip `30`, malformed ids and the order guard `31`, the other surfaces with data and every
  tab title `32`, the chart settings dialog `33`, unnamed controls `34`, and the three live-update probes `35`, `36`, `37`) drove it at 1440 x 900 and 1180 x 820, plus the real
  `e2e/desk/screener.spec.ts`. 90 runs: 86 passed, 4 failed, and the 4 are my own throwaways (spec 12 twice: a `require` in its last line, as in waves 10 and 11; spec 33 twice
  in its first form, which used a thread-less stub session; the second form passed). 340 probe snapshots, 637 images.
- Probe totals over the 340 snapshots: banned wording 0, a document-level horizontal scrollbar 0, type under 11 px 0, SVG labels overlapping or cut by their box 0, unnamed controls 2
  (both false: the "Copy" button inside the closed "View JSON" disclosure on `/screener/filters` and `/alerts/new`, which the probe counts as visible). The `clipped` list held only
  visually hidden 1 px spans ("Read-only", "Passed:", the sr-only clock and Replace plan reasons), `legend "Default mode"` (an 8 px fieldset legend) and ellipsis cases that are on
  purpose (company names in the 95 px left-rail cell at 1440, alert condition text, feedback list titles).
- Regression read: the main region's text of 245 snapshots was diffed against wave 11's. 210 are identical; the 35 that differ are the D-191 and D-192 wording, the D-193 answer,
  and numbers that move with the clock (open P/L, prices at a given second, the "Preparing data" count).
- Real clock: the harness freezes the browser clock. Every chart claim was sampled on the frozen-clock page and in a second browser context with a real clock.
- Seeds: `technical` (the live surfaces), the stub replay day (TSLA, Fri 2026-09-25, 09:30 to 09:40 ET) for day threads, the swing world `S01` to `S12`.

## Wave-11 verification (D-186 to D-194)

| ID | Verdict | Route and steps | Proof (screenshots in `walk-12/`) |
|---|---|---|---|
| D-186 | Fixed on the paths it names (fresh load, interval switch, refresh); the live-update path is not: D-195 | `/practice/replay?id=` on TSLA paused at 9:34 AM ET. Fresh load of the URL (frozen clock and real clock): the bars span 0 to 90 % of the plot at 1440 (the right 10 % is the price scale) and 0 to 100 % at 1180, ticks 08:15 to 09:30 AM at 1440 and 08:50 to 09:30 at 1180, with the Practice drawer shut or open (580 px chart). Same after a reload, a wheel zoom out and in, a double-click on the time axis, a drag, Full screen and back. Wave 11: five candles at the left edge and no label. | `300-frozen-fresh-page-{1440,1180}`, `300-real-fresh-page-{1440,1180}`, `300-frozen-drawer-fresh-3000-1180`, `192-replay-closed-{1440,1180}`, `193-replay-drawer-open-1180`; `evidence/walk30-*.txt`, `walk23-*.txt`, `walk25-*.txt` |
| D-187 | Fixed | 1m to 5m to 15m to 1m on the same page: the first axis ink is in the first 250 ms sample on every switch (5m 473 and 15m 498 px at 0.5 s at 1440, 461 and 479 at 1180, 302 and 287 with the drawer open), frozen and real clock; wave 11 had 1.9 to 4.2 s. The 1m switch after 15m repaints in 0.8 to 0.9 s (the 0.5 s read still shows the 15m picture): data fetch, not filed. | `300-{frozen,real}-{5m,15m}-{500,1000,2000}-<n>-{1440,1180}`, `201-seq1-1m-a-1440`…`201-seq7-1m-c-1180`; `evidence/walk21-head-*.txt`, `walk22-head-*.txt`, `walk30-*.txt` |
| D-188 | Fixed | `/practice/journal?thread=` on a day thread after one lost day ($50,000 to $49,246): "After day 1 $49,246.00" sits above the Balance line with the line about 20 px below its nearest edge, at 1440 and 1180. The swing journal's "Equity", "Balance" and "Starting balance" labels are still clear, and so is the week review's money axis. | `73-journal-trades-{1440,1180}`, `93-swing-journal-{1440,1180}`, `94-swing-journal-improvement-1180`, `95-week2-1440-tall` |
| D-189 | Fixed | `/practice/thread?id=` at 1180, Summary scrolled 200 px (scrollTop 200 of 1,330 in the 720 px region), practised name, End day, Yes, end day: `/practice/day` arrives at scrollTop 0 at 80 ms, its content grows from 720 to 744 px at 124 ms and the scroll stays 0; the tab strip starts at 76 px (wave 11: 52). At 1440 it lands at 0 as before. | `240-summary-scrolled-before-end-day-{1440,1180}`, `241-day-review-after-end-day-{1440,1180}`, `170-after-end-day-offset200-{1440,1180}`; `evidence/walk17-*.txt`, `walk24-*.txt` |
| D-190 | Fixed | Bare `/practice/order` with a day and a swing thread, `?thread=abc`, `?thread=` and `?id=999`: `expectCleanScreen` passes on every one at both widths (spec 08 and spec 31, which also ends on the bare route and asserts it). The rows still link to `/practice/order?thread=<id>`. | `76-order-{1440,1180}`, `77-order-noid-*`, `85-order-999-*`, `310-01-_practice_order-*`, `310-03-_practice_order_id_999-*` |
| D-191 | Fixed (the hint now matches the rows) | `/practice/week` and `?week=2` with no thread: "No practice thread selected · Pick a thread to open its Summary." over every thread, each row to `/practice/thread?id=`. The day thread is still listed (the Summary exists for it). | `150-01-_practice_week-{1440,1180}`, `150-02-*`, `71-week-{1440,1180}` |
| D-192 | Fixed | Swing thread with Days 1 to 10 ended (Week 2 done, Day 11 waiting): `?thread=` and `week=0` offer "Open Week 2", which opens the Week 2 review; `week=3` and `week=99` say "has not started yet"; `week=1` opens Week 1. | `96-week-noweek-{1440,1180}`, `96-week-week0-*`, `96-week-week3-*`, `95-week2-*`, `93-swing-journal-*`; `evidence/walk09-weeks-*.txt` |
| D-193 | Fixed | 15 addresses: `thread=abc`, `1e2`, `0`, `-1`, `1.5` and an unknown number on `/practice/week`, `/practice/order`, `/practice/thread`, `/practice/journal`, and `id=abc`, `0` on `/practice/day` and `/practice/replay` all say "not found · open one from Practice" (or "from your thread"). A missing id says "No practice thread selected" with the picker. Same at 1180. | `150-05-*`, `150-19-*`, `150-24-*`, `150-27-*`, `150-30-*`, `310-05-_practice_thread_id_abc-*`; `evidence/walk15-*.txt`, `walk31-*.txt` |
| D-194 | Fixed | The real `e2e/desk/screener.spec.ts`, whole file, both desktop projects: 22 of 22 runs pass, `:136` included. The preview for BOLT and LKQ reads "No price bars for BOLT yet"; NVDA draws its daily chart. | `101a-screener-filter1-first-row-1440`, `101b-screener-preview-drawer-bolt-1180`, `101c-*`, `101d-*`; `evidence/run-new.log` |

Counts: fixed 8 (D-187 to D-194), fixed on its named paths with a new neighbour 1 (D-186, now D-195), not fixed 0, could not exercise 0.

## New defects

### D-195 · P2 · Practice / replay chart range on a live update (D-186 left over)

- Surface: `/practice/replay?id=` with the chart open while the thread clock moves. Both widths (1180 with the drawer shut). 2026-11-02.
- Steps, route 1 (one window, the UI only): Start a plan, open Day 1 (paused at 9:30), on the Summary pick 10x and press Play, press Day list, open TSLA at once, read the chart every second.
- Seen: at 9:31:14 and 9:31:34 the plot holds the newest three or four session candles and the lookback against its left edge, blank to their right, one label ("09:30 AM") at the edge
  (1440: candles span 0 to 5 % and 0 to 9 % of the plot). At 9:32:16, 13 s after the open, it redraws with the bars across the plot and ticks 08:15 to 09:30. The same at 1180 (9:31:31).
  At 1x the same two clock minutes would take two real minutes (not run).
- Steps, route 2 (two windows): the chart open at 9:30 in window A; Play at 10x for 6 s and then Pause from the Summary in window B (the clock runs on the server, the Summary says so). At 9:30:50
  window A's plot is a sliver of two candles at the left edge and no label; after the Pause (9:31:07) it is still bunched at +1 s and +3 s and right at +7 s.
- Steps, route 3 (the clock route): the chart open at 9:30, the thread clock stepped four bars with `POST /api/desk/replay/threads/<id>/clock {step: "bar"}` (the e2e `stepBar`): at 9:34 the
  chart stays bunched with no time label for all 14 s sampled, at 1440 and 1180. The wave-11 spec that reached 9:34 this way read the chart whole (candles 0 to 90 %, axis ink 2,211 px at 1440);
  the same spec on this build reads candles 0 to 6 %, ink 1,592 (`evidence/walk21-head-1440.txt` in `walk-11/` and `walk-12/`).
- Recovery: an interval switch, a wheel zoom, a double-click on the time axis or a reload. A fresh load at 9:34 is right (D-186's own repro holds), so this is the update path only.
- Expected: from the first session bar on, the chart follows the newest bars as the clock moves, with its ticks, on an update as on a load.
- Screenshots: `370-run-3-{1440,1180}` (9:31:14 and 9:31:31, route 1), `370-run-8-1440` and `370-run-16-1440` (the same chart right at 9:32:45 and 9:35:42), `360-A-while-playing-1440`,
  `360-A-after-pause-{1000,3000,7000}-1440` (route 2), `350-step4-6-1440`, `350-step4-12-1180` (route 3); `evidence/walk35-*.txt`, `walk36-*.txt`, `walk37-*.txt`.
- Design checked: `02o-desk-replay-practice-plan.md` (the `MarketChart` row: `follow` "keeps the newest bar in view (`scrollToRealTime` after an update unless she has scrolled back)"); ADR-0018
  (the clock runs on the server, so a chart can be open while it moves). The D-186 row's fix text names a fresh load, an interval switch and a refresh, not an update. A defect, not a design choice.
  Pointer, cause not isolated: the update branch of the data effect in `MarketChart.tsx` (`follow && atNewest && waiting === null`), which #373 rewrote.

### D-196 · P3 · Practice / replay price axis ticks under line tags

- Surface: `/practice/replay?id=` on TSLA 1m at 9:34 AM ET, 1440 and 1180 (drawer shut and open).
- Seen: a price-axis tick label is half hidden by a line tag within 10 to 13 px of it. 1440: "372.00" is cut to its lower half under the red last-price tag "372.47" ("386.00" only touches
  "386.83"). 1180 with the Practice drawer open: "387.50" is cut under "386.83" and "382.50" under "380.97". With a short open (50 shares at 374.94): "376.00" is cut under the "374.94" tags.
- Cause: D-181's `clearTickLabel` (a tick within 16 px of a tag is left out) is wired to the money axis only (the swing week chart) and to the overlays' last-value tags only; the replay price scale has no such rule.
- Expected: a tick under a tag is left out, as on the week chart (D-180's ruling: the axis may drop a label, it may not cut one).
- Screenshots: `crop-price-scale-372-1440`, `crop-price-scale-386-1440`, `crop-price-scale-drawer-1180`, `192-replay-closed-1440`, `193-replay-drawer-open-1180`, `143-after-sell-1440`.
- Design checked: `02m` §b5 (the time axis only), ADR-0020 (levels show number-only on the chart); nothing states the price ticks. D-099 (tags stack at one price) and D-181 are the neighbours.

### D-197 · P3 · Screener / New filter liquidity field

- Surface: `/screener/filters` (New filter), 1440 and 1180.
- Seen: Liquidity floor: "Minimum price ($) 5", "Minimum average volume 500000", then "Average volume days" with an empty box, no placeholder, no unit, no hint. A blank means 20 sessions
  (`DEFAULT_AVG_VOLUME_DAYS` in `screener/evaluator.py`), the contract accepts 5 to 60 (`avgVolumeDays`, `ge=5, le=60`); the screen says neither. The "Days" fields under Conditions are filled with 10.
  Create filter saves with the box blank.
- Expected: the default (20, filled in or as a placeholder) and the range (5 to 60) are on screen.
- Screenshots: `325-screener-filters-{1440,1180}`; `evidence/walk34-*.txt` (the input list: `filter-avgVolumeDays`, value empty, no placeholder).
- Design checked: `plans/` and `decisions/` do not name the field (searched `avgVolumeDays`, "Average volume days").

## Looked at and not filed

- The orange crosshair tags on a chart (a "08:09 AM" tag over the "08:15 AM" tick, "378.54" beside a list price of 377.94) are the stale mouse position, not a defect.
- The orange VWAP line is a straight slope across the pre-market on the stub day: the stub's lookback bars carry no `ext` flag (known trap); D-168 and the rail text cover the VWAP's source.
- The swing journal's "Balance $50,626.00" label sits on the $50,500 gridline (probe `onSeries`): a gridline behind a halo-lit label, not a series; the label is whole.
- Feedback list titles are cut with an ellipsis in a 91 px column at 1440 (full text in `title`); the filter chips, counts and rail otherwise read right. The 1180 rail is a drawer, as designed.
- `/today` shows "Alerts start when live quotes are connected" in the banner and in the status bar (the shell line, D-043's family); not new.
- `/practice/day` with no id has no picker (a day has no thread to pick), unlike the Order, Summary, Replay, Journal and Week routes.
- The New plan swing modal's "you have 4" count read 0 once at 1180 and 4 at 1440 and in wave 11 (the as-of data was still loading at 2.5 s); not reproduced.
- At 10x on the Summary, the replay header's last price (the tape's, to the second) and the chart's bar close differ by a few cents during the minute: the bar is the minute's, as the rail says.

## Could not exercise

- The live-update path at 1x in real time (D-195 was measured at 10x and through the clock route; at 1x the same two minutes take two real minutes, not run).
- A baseline build of `a344636c` (before #373) to prove D-195 is from #373: wave 11's two builds read the same flow whole, which is the comparison used.
- The backend changes that reached `dev` after the cut (`f16da96a` thread time, #376).
- Interactions on Watchlists (Manage, reorder, rename), Strategies (the builder beyond its first paint) and Settings beyond first paint at both widths; the existing specs own those and they were not run.
- The mobile shell (`chromium` 1080 project) and real Alpaca data.

## Clean: screens and flows that held up

- `/practice` landing empty, with a day thread, with a day and a swing thread; New plan modal (day and swing; the window-error wording of D-160), 1440 and 1180; LAST DAY "Today · realized" at 1440, dropped at 1180 on purpose.
- `/practice/day`: the column set whole at both pane widths (1440 drops Prev vs VWAP %, 1180 shows it), list time and footer after a Re-scan (both 9:30 AM, "Scan 1 · run at 9:30 AM ET"), Open and Peek (Peek at 1180 with whole axis labels 05:00 to 07:30), a click on a row cell reaches the chart,
  the ladder weekday, the Portfolio view and its $ and % switch, Day 2 with no match ("Re-list at 10:00 AM"), the day review after End day (ranking table whole, "Day 1 of 5 · Fri 2026-09-25").
- `/practice/thread`: the Summary clock with Hide dates on and off, Equity headline, Buying power, Skip day and End day confirms (the open P/L, the exit time and the name behind the clock), the 5x and 10x clock with one visible clock (80 samples at 5x, 0 mismatches at both widths),
  the preparing state (D-182), the Order and Trades tabs, the journal's thread rail row whole (name, balance with SIMULATED, status) at 1440 and 1180, End day from a scrolled Summary at both widths (D-189).
- `/practice/replay`: header "realized today", the pace row on one line (118 px label), rail status, Position panel labels, the ticket's market, limit, stop and stop-limit entries, a working limit buy and its Cancel, a short and Close position, the buying-power refusal, the Chart settings dialog and the EMA 21 legend toggle,
  Full screen and back, the time axis whole on 1m, 5m and 15m with the drawer shut or open.
- `/practice/week` (Improvement, hold table with "P/L SINCE ENTRY", tiles that reconcile: S04 +5.1 % over a $4.29 move, universe median 0.0 %, mean −0.6 %), the swing journal and its Improvement, Thread plan and Close thread drawers at 1180, `/practice/order` with the stock search and its empty answer, every `/practice` route's tab title ("Weekly review - Family Desk", "Practice order - Family Desk", and so on).
- `/today`, `/screener` (abnormal-volume first row, D-185's empty state, the 1180 Preview drawer), `/screener/filters`, `/watchlists`, `/alerts`, `/alerts/new`, `/strategies`, `/strategies/new`, `/strategies/library`, `/settings`, `/more`, `/technicals`, `/feedback` (empty and with three reports, the selected report's rail, the filing form):
  no banned wording, no order control, tables whole at both widths, a tab title on every route.
