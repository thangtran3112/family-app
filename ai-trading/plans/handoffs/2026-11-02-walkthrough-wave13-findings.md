# Walkthrough wave 13: the Practice desk on `dev` (`34f8b110`)

Date: 2026-11-02. New defects D-198 to D-205 (8: P0 0, P1 0, P2 2, P3 6). Nothing was fixed in this lane.
Wave-16 verification (D-195 to D-197, the fixes of #382): D-195 holds on every single-window path it names; D-197 holds on every point it names; D-196 does not hold
(a tick is still cut at the pane edge and under tags the chart stacks apart: D-199, D-200). One more defect hides behind D-195's repro: a chart open in two windows
on the same session loses bars (D-198). No `Fixed` row was touched.

Screenshots are not in the repository; the names below are files in the run's `walk-13/` directory (outside the repo, next to the run's copy of this report).
A name ending `-1440` or `-1180` is the viewport width; `-tall` is the same screen on a 2,600 px viewport; `d195-*` are the D-195 timelines, `d196-*`, `d196s-*`
and `sheet-*` are 2x crops of the replay price axis, `d197-*` the screener filter editor, `twowin-*` the two-window run. Each full-page screenshot has a `.json` next
to it with the probe facts (clipped text, scrollers, type under 11 px including the effective size of SVG text, unnamed controls, banned wording, SVG labels that
overlap one another, sit on a drawn series or are cut by their box, the main region's text). `walk-13/evidence/` holds the 47 throwaway specs, the throwaway Playwright
config, the sampling outputs and the run logs (none of them is in the commit).

## How it was run

- Cut: `origin/dev` `34f8b110` (carries #379, #380, #382). Worktree `practice-walk-13`, branch `feature/practice-walk-13`. `origin/dev` moved on while the lane ran
  (three commits: `6088bae9` market-data cache, `de3a09d9` "Start Trading, Delete plan, no Order route, block days…", `cedc71e6` "open-to-open days, Skip day lands on
  the open, Jump replaced"); none of that code was exercised, and some of what is filed here (the `/practice/order` route, the Jump panel) may have changed there. `DEFECTS.md`
  on that head still ends at D-197.
- Harness: the Desk e2e stack through `tests/e2e/run.py --browser -- …` exactly as `e2e/README.md` describes for "Without Docker": a disposable `desk_e2e_<hex>` database in
  another session's tmpfs `desk-test-postgres` container (`DESK_E2E_ADMIN_DATABASE_URL`, loopback), the static export built from this worktree (`next build`), `browser_server.py`
  and `proxy.mjs` on ports 18048/18049 (a second lane on 18050/18051 for the leak and timing runs), `--output=/tmp/w13/pw-<tag>`, one worker. No Docker, no `pnpm test:e2e`.
  Every run's database was dropped by `run.py`.
- 47 throwaway specs (wave 12's 33 re-pointed after #379 removed Hide dates and the window's end, plus 14 new ones: D-195 `41`, `42`, `44`, `47`; D-196 `45`, `48`;
  D-197 `46`; the two-window run `43`; the warm-server leak `40`, `49`, `50`; the level-tooltip and mouse-cost probes `51`, `52`; the swing Daily rail `55`) drove it at
  1440 x 900 and 1180 x 820. 24 run logs; the final probe set is 338 snapshots and 720 images. The real `practice-chart.spec.ts` and `practice-a11y.spec.ts` ran at both
  widths for the leak check.
- Probe totals over the 338 snapshots: banned wording 0, a document-level horizontal scrollbar 0, type under 11 px by computed size 0, SVG labels overlapping or cut by their box 0,
  unnamed controls 2 (both the "Copy" button inside the closed "View JSON" disclosure on `/screener/filters` and `/alerts/new`, which the probe counts as visible), SVG text under
  11 px by effective size: one screen (D-202). The `clipped` list held only the visually hidden 1 px spans, `legend "Default mode"`, and the ellipsis cases that are on purpose.
- Real clock: the harness freezes the browser clock. The D-195 claims were sampled on the frozen-clock page and in a second browser context with a real clock.
- Seeds: `technical` (the live surfaces), the stub replay day (TSLA, Fri 2026-09-25, 09:30 to 09:40 ET) for day threads, the swing world `S01` to `S12`.

## Wave-16 verification (D-195 to D-197)

| ID | Verdict | Route and steps | Proof (screenshots in `walk-13/`) |
|---|---|---|---|
| D-195 | Fixed on every single-window path it names. One neighbour: D-198 | `/practice/replay?id=` on TSLA 1m, one window per session. (1) At 9:30 before the open the chart waits at the first bar (#373's rule): candles 0 to 0.02 of the plot, no ticks, at both widths. (2) Four bars stepped through the thread clock route (`stepBar`): after each, candles 0 to 0.90 of the plot, the data table grows 6001, 6002, 6003, 6004, ticks across 08:15 (08:30 at 1180) to 09:30 AM at both widths; the same in a second context with a real clock, one window (0 to 0.90, ticks present, 6011 to 6013 bars through 9:43). (3) 10x Play from the Summary in a second window with the chart open, then Pause: the chart follows (0.89 to 0.90, bars 6005 to 6010 at 9:35 to 9:40, one more per minute) and stays right 0.5, 2 and 4 s after the Pause, at both widths. (4) Route 1 of wave 12 (10x Play on the Summary at 9:30, Day list, open TSLA at once): sliver at 9:30:09, the whole chart at 9:31:00 (1440) and 9:31:18 (1180), 0.89 to 0.90 through 9:35. (5) Scrolled back (dragged 260 px right): the view reads the same before and after one more bar (6004 to 6005 bars): 0 to 1.00 at 1440, 0.01 to 0.99 at 1180. It stays put. | `d195-10-A-at-open-*`, `d195-11-A-9-34-*`, `d195-12-A-scrolled-back-*`, `d195-12-A-scrolled-back-after-step-*`, `d195-13-A-10x-*`, `d195-13-A-after-pause-*`, `d195-14-R-real-clock-*`, `d195-20-route1-{0,4,9}-*`; `evidence/d195-clean-*.txt`, `d195-route1-*.txt`, `d195-trace-1440.txt` |
| D-196 | Not fixed: a tick is still cut at the pane edge and under tags the chart stacks apart. New rows D-199, D-200 | `/practice/replay?id=` on TSLA 1m at 9:34 AM ET, 1440 and 1180, 2x crops. Flat: no tick sits under the session high/low, prior close or last-price tag any more (372.00 and 370.00 are left out); but "368.00" at the bottom edge is cut in half. With 100 shares bought: the green position tag "372.62" stacks against the red "372.47" and cuts "374.00". With a stop at 370.50 added: the same cut; the stop's orange "370.50" tag stacks on the grey "370.26" tag and the 370.00 tick is left out. Later minutes and 15m show the same two causes. | `d196-1-flat-axis-*`, `d196-2-long-axis-*`, `d196-3-long-stop-axis-*`, `sheet-d196-*`, `sheet-sweep-*`, `crop-bottom-*`, `203-drawer-15m-full-1180` |
| D-197 | Fixed | `/screener/filters` at 1440 and 1180: "Average volume days" opens at 20 (placeholder 20, min 5, max 60) with the hint "5 to 60 · blank is 20" in the label line. Cleared, the box is empty and shows the placeholder 20. Create filter with it blank saves `avgVolumeDays: 20` (`minPrice 5, minAvgVolume 500000, avgVolumeDays 20`) and reopens showing 20. 3 and 61 are refused at the field ("Must be 5 or more." / "Must be 60 or less."). A shipped filter (Abnormal volume, read-only) shows the box empty with the placeholder 20 and its spec has no days; a user filter saved without days (min price 7, volume 123,456) opens with the box empty, and after a rename and Save its spec is unchanged (no days added): it round-trips. One neighbour: D-205 (error summary says "Avg volume days"). | `d197-1-new-filter-*`, `d197-2-cleared-*`, `d197-3-after-create-*`, `d197-4-three-*`, `d197-5-shipped-*`, `d197-6-prefix-*`, `d197-6-prefix-after-edit-*`; `evidence/d197-*.txt` |

## New defects

### D-198 (P2) Practice / replay chart open in two windows loses bars

- Surface: `/practice/replay?id=` for one name on a day thread, 1440 (the same code path at 1180).
- Route and steps: start a plan, open Day 1, open TSLA's chart; open the same URL in a second window; step the clock four bars through the thread clock route (`stepBar`, what Play at 10x
  also calls); read "Chart data table · N source bars" in each window five seconds after each step; then reload the second window.
- Expected: both windows show every closed bar through the thread clock (6001, 6002, 6003, 6004), with the VWAP and indicators of those bars.
- Seen: after four steps window A reads 6001 and window B 6003, a reload of B 6004. A's candles end at the 9:30 bar while its clock reads 9:34:00 and its last price 372.62; its VWAP
  is 385.20 (378.78 on the whole series) and its RSI 65.5 (25.5). B's data table runs 9:29, 9:31, 9:32, 9:33: no 9:30 row. No "not updating" notice (every poll is answered); a reload repairs it until
  the next bar. The cause is visible in `advance {sync: true}` answers: `bars[1]` once, `bars[0]` for every later poll of the other window (`evidence/d195-trace-1440.txt` for one window,
  `evidence/twowin-1440.txt` for two). With one window per session every step and every Play/Pause tick is shown.
- Screenshots: `twowin-A-1440`, `twowin-B-1440`; `evidence/twowin-1440.txt`.
- Doc checked: ADR-0018 "Sync: poll, not push" (sizes the poll for "one household user per thread", calls it "one idempotent request"); ADR-0022 and the header of `lib/replay/feedState.ts`
  ("`advance` answers; it never slices … the server owns the reveal boundary"). Neither says what a second window gets, so the row is filed as a defect, and the decision (per-window cursor, or
  re-read the bars on a changed clock) is the owner's.

### D-199 (P3) Practice / replay price axis: a tick is cut at the pane edge (D-196 left over)

- Surface: `/practice/replay?id=` and the Day list's Peek chart.
- Route and steps: TSLA 1m, step to 9:34 flat, read the bottom of the price axis at 2x, 1440 and 1180; the sweep to 9:40 and Peek on the Day list show the same.
- Expected: no price tick or tag label is cut by the pane's edge (D-180's ruling: the axis may drop a label, it may not cut one).
- Seen: "368.00" sits on the bottom edge with its lower half missing at 9:34 to 9:40; the Peek chart's orange VWAP tag "378.54" is cut at its bottom the same way.
- Screenshots: `crop-bottom-1440`, `crop-bottom-1180`, `sheet-sweep-*`, `130-peek-1440`.
- Doc checked: D-180 and D-196 rows, `02m`, ADR-0020 (silent on price ticks).

### D-200 (P3) Practice / replay price axis: a tick under a tag the chart stacks apart (D-196 left over)

- Surface: `/practice/replay?id=`, 1m and 15m, 1440 and 1180.
- Route and steps: 1m at 9:34 with 100 shares bought (and with a stop at 370.50); 1m flat at 9:37; 15m at 9:40; 15m at 9:34 with the Practice drawer open at 1180; 1m at 9:35 scrolled back.
- Expected: a tick is left out when a tag is drawn over it, wherever the chart draws the tag.
- Seen: "374.00" half hidden under the green "372.62" position tag (with and without the stop); "380.00" under "378.89" at 9:37; "382.00" under "380.62" (15m) and "382.50" under "380.59" (15m, 1180);
  a tick label behind the white "381.28" tag when scrolled back. The chart moves crowded tags apart (a tag is drawn up to a tag height from its price), D-196's 16 px rule measures from the price.
- Screenshots: `d196-2-long-axis-*`, `d196-3-long-stop-axis-*`, `sheet-d196-*`, `sheet-sweep-*`, `203-drawer-15m-full-1180`, `crop-scrolled-axis-big`.
- Doc checked: D-180 and D-181 rows (`clearTickLabel`), D-196 row; no design document names price ticks.

### D-201 (P2) Practice / replay chart: every mouse move over the plot blocks the page

- Surface: `/practice/replay?id=`, 1440 and 1180 (measured on a standalone stub session; a day-thread name draws the same component from the same bars).
- Route and steps: open a replay at 9:33, 1m, move the pointer across the plot (12 `mouse.move` calls) with a `longtask` observer on; repeat at 5m and 15m, over the left rail, and on the Technicals NVDA 15m chart.
- Expected: a crosshair move costs the same at 6,000 bars as at 600: a legend and tooltip update.
- Seen: 545 to 585 ms of main-thread time per move at 1m (6,003 source bars), 180 to 200 ms at 5m (1,987), 60 to 68 ms at 15m (663); the Technicals chart 10 ms; the left rail 8 to 66 ms. A CPU
  profile of eight moves has 4.4 s of 5.1 s in two functions of the app's chunks. The level-hover sweep spec (about 34 moves) times out for this reason (see the known-red verdicts below). Caveat: headless
  Chromium on a laptop with a second Playwright run going; the gap to the Technicals chart in the same run and the linear growth with bars are the finding, the absolute numbers are inflated.
- Screenshots: none (timings): `evidence/mouse-1440.txt`, `mouse2-1440.txt`, `mouse3-1440.txt`, `mouse3-1180.txt`, `level-1440.txt`, `level-1180.txt`.
- Doc checked: ADR-0020 (the chart "reads as a broker's"); no document sets a hover budget.

### D-202 (P3) Practice / journal charts at 1180 with a drawer open

- Surface: `/practice/journal?thread=<day thread>` at 1180.
- Route and steps: one lost day on a day thread; open the journal; open the Improvement (then Thread plan, Close thread) tab on the right edge.
- Expected: chart text stays at 12 px (11 px caps floor, `ui-primitives.md`); the chart redraws or thins its labels when its column narrows.
- Seen: all SVG text of both charts renders at 7.9 px (effective size) with the drawer open (580 px centre column); 12.6 px with it shut, 11.7 px at 1440. The swing journal stays at 12.6 px.
- Screenshots: `74-journal-drawer-improvement-1180` (also `-threadplan-`, `-closethread-`) against `73-journal-trades-1180`; probe facts in the `.json` files (`svgMin`, `svgSmall`).
- Doc checked: `ui-primitives.md` "Tokens" (type floor) and "small SVG chart is MiniChartFrame".

### D-203 (P3) Practice / swing Daily indicators note names VWAP

- Surface: `/practice/replay?id=<swing session>`, Daily view, 1440 and 1180.
- Route and steps: swing thread, open a name, press Daily, read the left rail.
- Expected: the Daily rail's note has no VWAP sentence (the spec `practice-chart.spec.ts` "the type applies to the Daily chart…" asserts that).
- Seen: RSI, MACD, EMA 9 and EMA 21 rows, then "Read from the bars shown on the chart, up to the replay time. Nothing here looks ahead. VWAP is the session's, from 1-minute bars, on every chart interval."
- Screenshots: `550-swing-daily-indicators-1440`, `550-swing-daily-indicators-1180`, `550-swing-daily-indicators-panel-*`.
- Doc checked: `design-system-rulings.md` D-168 (VWAP is a session figure; about the intraday views).

### D-204 (P3) Practice / New plan Start at before the open

- Surface: `/practice` > New plan.
- Route and steps: tick a filter, type 09:20 in "Start at (ET)".
- Expected: a plain sentence at the field, once ("Start at must be between 9:30 AM and 4:00 PM").
- Seen: the server's sentence "a regular-session window must stay inside 09:30-16:00 ET" at the field and again in the footer: lower-case, "window" (no such control any more), 24-hour range under a 12-hour field.
- Screenshots: `03-modal-window-error-1440`, `03-modal-window-error-1180`.
- Doc checked: `lib/desk/problems.ts` (`PATH_SENTENCES` maps three window sentences; `window-in-regular` is not among them), ADR-0022 (the end of the window is gone).

### D-205 (P3) Screener / filter editor names a field two ways

- Surface: `/screener/filters`.
- Route and steps: type 3 (or 61) in "Average volume days", Create filter.
- Expected: the error summary names the field as its label does.
- Seen: label "Average volume days", summary "Avg volume days: Must be 5 or more." (`paramLabel`, `lib/spec/labels.ts`).
- Screenshots: `d197-4-three-1440`, `d197-4-three-1180`.
- Doc checked: `ui-primitives.md` "Forms" (error words come from `problems.ts`).

## The two known-red specs, and the warm-server leak

- Level-hover sweep (`practice-chart.spec.ts` "a level's name shows only on hover"): a real defect, but not in the hover: the tooltips appear ("Session high", "Prior close", "Session low") and go 0.6 s after the pointer leaves
  (`level-*.txt`); the spec times out because each move costs half a second (D-201).
- Swing Daily `not.toContainText("VWAP")`: a real defect, and the spec is right: D-203.
- Warm-server leak (the wave-16 lane's "6610 bars through 7:59 PM at 9:30 instead of 6000"): not reproduced. A day-thread TSLA chart opened at 9:30 read 6000 source bars (6002 two bars later, still 6002
  after a 5m then 1m switch) after each of: a standalone TSLA session stepped three bars; one jumped +5 min; one at 5m and 15m and back; an extended session stepped; an extended session jumped to the close
  (that standalone chart itself read 6610, which is the leak's number, so a feed that returned an unsliced series would show it); the whole real `practice-a11y.spec.ts`; the whole real `practice-chart.spec.ts` (19
  tests, the two known reds included), each at 1440 and the last two also at 1180 (warm after 1440). The suspected prepared-series cache (`SeriesCache`, #375) keys by (symbol, day, width) and holds the whole
  extended day, and the thread feed slices it by the clock, which is what every read here showed. Whatever produced 6610 in wave 16 did not recur; the workaround (XOM) in `practice-chart-follow.spec.ts` is not needed on
  this cut for the ordering tried here, but I did not run the whole suite in one process. `evidence/leak-*.txt`, `run-leak*.log`.

## What held (clean)

- Landing at 1440 and 1180: empty state, "Day-trade slots 0 of 10" / "1 of 10", a day and a swing row (Start Day 1, Open Day 1, Delete), numbers and dates; New plan modal: Days, List time with the 8:30 option disabled for Abnormal volume
  and its reason, List size, Chart interval, Start at; no Hide dates, no "Focus until" field, no hidden-day wording anywhere in 338 snapshots.
- Thread Summary: "Fri 2026-09-25 · 9:30:00 AM ET" clock, Paused/Play state line, "Next session starts Mon 2026-09-28 · 9:30 AM ET", 1x/2x/5x/10x, Skip day (confirm, lands on Mon day 2), End day (confirm text names the date and time); Equity headline, block and
  Today card agree through rest, 10x Play and Pause (−$791, −$868, −$822 each on all three; −$791, −$867, −$771 on the 1180 run); replay chip, footer and header clock agree.
- Day list: columns at both widths (Symbol to RSI plus Open and Peek), "Price now follows the day clock, Fri 2026-09-25 · 9:30 AM ET", VS PREV CLOSE % NOW +1.72% = 384.43 / 377.94, Peek (Up to list time, Daily) opens and closes, a cell click opens the chart.
- Day review at scrollTop 0 after End day at both widths (the D-189 path holds: 0 at arrival, stays 0 while the content grows); the review's trade arithmetic (100 × (372.76 − 380.48) = −$772.00, −2.03%, balance $50,000.00 → $49,228.00).
- Portfolio: $/% switch, "1 open position", unrealized −$222.00 = 100 × (372.72 − 374.94), −0.59%, buying power $12,506.00 = $50,000.00 − 100 × 374.94, Day P/L = realized + open.
- Week review routes (`?thread=`, `week=0`, `1`, `3`, `99`, abc, a day thread) and the order routes (bare picker, `?thread=abc` "not found", `?thread=`, `?id=999` the picker): same answers as wave 12; every malformed id on `/practice/*` says not found and links out; tab titles of 22 routes.
- Journal: "After day 1 $49,246.00" clears the Balance line at 1440 and 1180 (D-188 holds), the drawer tabs open at 1180, the swing journal's labels clear; chart text sizes except D-202.
- Replay chart: fresh load 0 to 0.90 of the plot at 1440 and 1180 with ticks, frozen and real clock; 1m, 5m, 15m and back settle in the first 500 ms sample; wheel zoom out and in, double-click on the axis, drag, Full screen and back, reload; Practice drawer at 1180 (580 px chart); the order ticket (Market, Limit, Stop, Stop-limit, Bracket disabled with its reason; 1,000,000 shares → "Exceeds buying power · this order costs $374,940,000, buying power is $50,000"; empty quantity and price fields say why at the field).
- `/today`, `/screener` (results, preview drawer), `/watchlists`, `/strategies`, `/settings`, `/feedback`, `/alerts`: no wrong number or unit, no clipped glyph beyond the on-purpose ellipses, no unnamed control beyond the closed-JSON false positive, no 1180 layout losing a control.
- Order guard: no order control or request outside the replay ticket on any route (the e2e fixture's `expectCleanScreen` ran after every spec).

## What was not exercised

- The three `origin/dev` commits after the cut (Start Trading, Delete plan, no Order route, open-to-open days, Jump replaced, the market-data cache).
- A real deployed environment: everything ran on the stub day and the seeded worlds, in headless Chromium; real-day volumes (the tape, the lookback) are the stub's.
- The 5x clock-agreement comparison of spec 06 compared "thread" readouts that no longer exist (it read `undefined`); the chip, footer and header clocks agreed in every sample, which is what was read.
- A swing session's chart in two windows (D-198 was reproduced on a day thread only).
- Mobile (below 1100 px).
