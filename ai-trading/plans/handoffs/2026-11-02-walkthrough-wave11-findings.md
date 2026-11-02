# Walkthrough wave 11: the Practice desk on `dev` (`cac694f3`)

Date: 2026-11-02. New defects D-186 to D-194 (9: P0 0, P1 0, P2 1, P3 8). Nothing was fixed in this lane.
Wave-10 verification (D-179 to D-185, the fixes of #368 and #369): three hold on the live screen (D-179, D-182, D-185), D-183 holds as filed, D-180 and
D-181 hold in part, D-184 does not hold at 1180. Each gap is a new row that cites the old one (D-186, D-187, D-188, D-189); no `Fixed` row was touched.
D-190 to D-193 are neighbours of D-183's pickers; D-194 is a spec that #369 left stale.

Screenshots are not in the repository; the names below are files in the run's `walk-11/` directory (outside the repo, next to the run's copy of this report).
A name ending `-1440` or `-1180` is the viewport width; `-tall` is the same screen on a 2,600 px viewport; names starting `19`, `20` and `22` are 2x crops of a chart
axis. Each screenshot has a `.json` next to it with the probe facts (clipped text, scrollers, type under 11 px, unnamed controls, banned wording, SVG labels that
overlap one another, sit on a drawn series or are cut by their box, the main region's text). `walk-11/evidence/` holds the 25 throwaway specs, the throwaway Playwright
config, the sampling logs and the run logs (none of them is in the commit).

## How it was run

- Cut: `origin/dev` `cac694f3` (carries #367, #368 and #369; dev did not move while the lane ran). Worktree `practice-walk-11`, branch `feature/practice-walk-11`.
- Harness: the Desk e2e stack through `tests/e2e/run.py --browser -- …` exactly as `e2e/README.md` describes for "Without Docker": a disposable `desk_e2e_<hex>`
  database in another session's tmpfs `desk-test-postgres` container (`DESK_E2E_ADMIN_DATABASE_URL`, loopback), the static export built from this worktree
  (`pnpm build`), `browser_server.py` and `proxy.mjs` on ports 19644 and 19645, `--output=/tmp/w11/pw`. No Docker, no `pnpm test:e2e`. Every run's database was
  dropped by `run.py`; none was left behind.
- 25 throwaway specs (the wave-10 set adapted, plus targeted ones for D-180, D-184 and the chart findings) drove it at 1440 x 900 and 1180 x 820: 285 probe snapshots
  (457 images with the `-tall` ones and the axis crops). The main chain (19 specs, 38 runs) took 30 minutes; 34 runs passed. The 4 that did not: spec 12 twice (my
  throwaway's last line, a log write, threw after every screen had been read, as in wave 10) and spec 08 twice (D-190: the screen guard failed on `/practice/order`).
- Baseline: for every claim that a chart or fix behaves "as before" I built `8750ab89` (the code before #368 and #369) in a second, detached worktree, served its
  `out/` copy through the same proxy (`DESK_E2E_STATIC_ROOT`) and ran the same probes. That worktree is removed.
- Real clock: the harness freezes the browser clock. Chart claims were sampled both on the frozen-clock page and in a second browser context with a real clock.
- Seeds: `technical` (the live surfaces), the stub replay day (TSLA, Fri 2026-09-25, 09:30 to 09:40 ET) for day threads, the swing world `S01` to `S12`.
- No snapshot showed banned wording (`bannedWordingOnScreen`), a document-level horizontal scrollbar, type under 11 px or an unnamed control. The probe's `clipped` list
  held only visually hidden 1 px spans ("Read-only", "Passed:", the sr-only Replace plan reason) and ellipsis cases that are on purpose (company names in the 95 px
  left-rail cell at 1440; alert condition text in the Alerts list). I read screenshots at 1440 for the landing, the Summary before the first day, the day list, the
  replay (1m, 5m, 15m, with a position), the journal, the week review, the swing journal, `/screener` and its preview; at 1180 for the landing, the day list, Peek,
  the replay with and without its Practice drawer, the journal, the day review after End day and `/screener` with its Preview drawer. The other screens
  (`/today`, `/watchlists`, `/strategies`, `/settings`, `/feedback` at both widths, and the 1180 Summary, modal and week review) I read as page text and probe
  facts; their text is identical to wave 10's.

## Wave-10 verification (D-179 to D-185)

| ID | Verdict | Route and steps | Proof (screenshots in `walk-11/`) |
|---|---|---|---|
| D-179 | Fixed at 1440; at 1180 the cell is not on screen, on purpose | `/practice` with a day thread holding a TSLA long (Buy 100, three bars): LAST DAY reads "Today · realized" over "$0.00 · 0 trades", the cell 190 px wide with nothing cut, beside the swing row's "Today" over "—". At 1180 the LAST DAY column is not drawn at all (`02r2-practice-hub-redesign.md`: "Dropped at the 1180 band"). The open position is still not on the landing (the fix chose the label, not the open figure). | `133-landing-open-position-1440`, `134-landing-day-and-swing-1440`, `134-landing-day-and-swing-1180`; `evidence/walk13-{1440,1180}.txt` |
| D-180 | Fixed as filed (no label is cut); the row's other half, "the axis says no time", is not fixed: D-186, D-187 | Peek on a candidate row: 1440 reads 05:00, 06:00, 07:00, 07:30, 08:00 AM, 1180 reads 05:00, 06:00, 07:00, 07:30 AM, each whole and the 04:00 AM label gone (the case wave 10 did not read at 1180). The replay at 1m reads 08:10 to 09:30 AM whole at both widths, and 5m and 15m read 05:00 to 09:00 AM, with the drawer open or shut. But the replay screen the row was filed on (1180, Practice drawer open) now shows no label at all, because its chart is bunched to the left edge (D-186), and the labels arrive late after a switch (D-187). | `190-peek-open-{1440,1180}`, `191-replay-{1m,5m,15m}-axis-{1440,1180}`, `22-position-panel-1180`, `193-replay-drawer-open-1180`, `203-drawer-5m-full-1180`; `evidence/walk20-*.txt`, `walk21-*.txt` |
| D-181 | Fixed on the swing journal and the week review; not fixed on the day journal: D-188 | Swing journal (`/practice/journal?thread=` on S01 to S12, Day 11): "Equity $51,457.00", "Balance $50,626.00" and "Starting balance" clear of every line and tick. Week 2 review: the $51,500 tick is left out under the Equity tag, ticks $51,250 to $49,750 whole. Day journal after one lost day: "After day 1 $49,246.00" is still crossed by the Balance line, at both widths. | `93-swing-journal-{1440,1180}`, `95-week2-{1440-tall,1180}`, `73-journal-trades-{1440,1180}`; `evidence/crop-d181-day-journal-1440.png` |
| D-182 | Fixed | `/practice/thread?id=` right after Start (TODAY "Preparing data · 28 of 53 names"): the Thread clock card says "The clock starts with the first day, once the data is ready."; Replace plan is disabled, with that sentence as its title and its accessible description. Same at 1180. | `05-thread-summary-before-day-{1440,1180}`; `evidence/d182-{1440,1180}.txt` |
| D-183 | Fixed as filed; four neighbours are filed: D-190 to D-193 | `/practice/week`: no thread "No practice thread selected" with the picker; `?thread=999`, `0`, `abc` "not found"; a day thread (no week, `week=1`, `week=99`) "Weekly reviews are for swing threads"; a swing thread with no week, `week=0`, `abc`, `-1` "No week selected"; `week=1` before Day 1 and `week=99` "has not started yet". Order, Summary and Replay pickers each name their own step ("open its Order tab", "open its Summary", "then open a name from its day") and their rows go there. Identical at 1180. | `150-01` to `150-30` (`150-NN-<route>`), `96-week-{noweek,week0,week1,week3,week99}-{1440,1180}`, `85-order-999-{1440,1180}`; `evidence/walk15-*.txt`, `walk09-weeks-*.txt` |
| D-184 | Not fixed at 1180: D-189 | `/practice/thread?id=` at 1180, Summary scrolled 200 px with a practised name, End day, Yes, end day: the review arrives at scrollTop 24 (page 744 px in 720), the tab strip under the amber band. A 40 ms trace shows the scroll reset runs (top 0 at 120 ms) and the region moves to 24 at 165 ms. At 1440 it lands at 0 (the review fits, as before). | `240-summary-scrolled-before-end-day-1180`, `241-day-review-after-end-day-1180`, `170-after-end-day-offset200-{1440,1180}`; `evidence/walk17-*.txt`, `walk24-*.txt` |
| D-185 | Fixed | `/screener?filter=1` (Abnormal volume), first row BOLT, no bars: the preview says "No price bars for BOLT yet" at 1440 and in the 1180 Preview drawer; LKQ, the next row, the same; a saved filter whose first match NVDA has bars draws its daily chart with whole axis labels ("Jan 2", "Jun 1"). | `101a-screener-filter1-first-row-1440`, `101b-screener-preview-drawer-bolt-1180`, `101c-*`, `101d-screener-preview-nvda-{1440,1180}` |

Counts: fixed 3 (D-179, D-182, D-185), fixed as filed with neighbours 1 (D-183), fixed in part 2 (D-180, D-181), not fixed 1 (D-184), could not exercise 0.

## New defects

### D-186 · P2 · Practice / replay chart range and time axis

- Surface: `/practice/replay?id=`, TSLA 1m at 9:34 AM ET. Both widths, drawer open or shut. 2026-11-02.
- Steps: Start a plan, open Day 1, open TSLA, step three bars, open the same URL again (or press 5m, then 1m).
- Seen: the plot holds only the newest four or five candles against its left edge, blank to their right, and the time axis has no label ("Chart data table · 6004 source
  bars"). It opens like this on every fresh load, with the real browser clock and the frozen one, and on 1m after 5m or 15m. A reload does not cure it; a wheel zoom
  (out, then in), a double-click on the time axis, a drag of the plot, or Full screen do. Stepping the day inside the page draws the chart right (bars across, ticks 08:10
  to 09:30). The build before #368 and #369 does the same (axis ink 93 px there, the cut "0 AM"; 0 px now): D-180's clipped label was one symptom of this view, and its fix
  removed the label, not the cause.
- Expected: the day's bars across the plot with their ticks on every open and every interval switch.
- Screenshots: `220-real-clock-replay-start-{1440,1180}`, `32-replay-10x-1440`, `22-position-panel-1180`, `192-replay-closed-1180`, `201-seq4-1m-c-{1440,1180}`,
  `21-replay-1m-1440` (the same view in wave 10: `walk-10/21-replay-1m-1440`); `evidence/walk21-{head,base}-*.txt`, `walk23-{head,base}-*.txt`, `walk25-*.txt`.
- Design checked: `02m` §b5 ("Time axis in ET"); the rail text "Read from the bars shown on the chart, up to the replay time"; ADR-0018 and ADR-0020 and the `design-*.md`
  files say nothing about the chart's visible range. A defect, not a design choice.

### D-187 · P3 · Practice / chart time axis after an interval switch

- Surface: `/practice/replay?id=` after pressing 5m or 15m.
- Seen: after D-180's fix the axis stays empty for two to four seconds (first inked axis, sampled every 250 ms: 15m at 1440 4.0 and 4.2 s, 15m at 1180 2.9 and 3.8 s, 5m at 1180
  1.9 and 2.8 s). The build before #368 and #369 had it at 1.6 and 2.1 s, 1.3 and 1.6 s, 0.5 and 0.6 s. A screenshot two seconds after the click shows candles and no time.
  Cause not isolated (`MarketChart`'s formatter asks `scale.timeToCoordinate` per tick, which may not be ready on the first layout).
- Expected: the labels print with the candles.
- Screenshots: `201-seq3-15m-{a,b,c}-{1440,1180}` (1 s, 2.5 s, 5 s), `21-replay-15m-1440` against `walk-10/21-replay-15m-1440`; `evidence/walk21-{head,base}-*.txt`.
- Design checked: `02m` §b5; nothing states a paint time.

### D-188 · P3 · Practice / day journal end label

- Surface: `/practice/journal?thread=` on a day thread after one lost day; also the Summary after End day and the 1180 drawers.
- Seen: the Balance line runs through "After day 1 $49,246.00" (the line falls into the last point from the upper left, across the label's right half; only the halo keeps it
  readable). In `placeLabel` the four candidate spots all sit beside the newest point; at the plot's right edge the two right-hand spots leave the plot and both left-hand
  spots are crossed, so the fallback keeps the first. The swing journal and the week review are clear, so D-181 holds there.
- Expected: the label clear of the line.
- Screenshots: `73-journal-trades-{1440,1180}`, `60-summary-after-end-day-{1440,1180}`, `74-journal-drawer-*-1180`; `evidence/crop-d181-day-journal-1440.png`; the `svg` field of the `.json` lists `onSeries`.
- Design checked: `.claude/rules/ui-primitives.md` (`MiniChartFrame` owns box, grid and y labels; end labels are not mentioned).

### D-189 · P3 · Practice / End day lands scrolled at 1180

- Surface: `/practice/thread?id=` then `/practice/day?id=` at 1180.
- Steps: thread with TSLA practised, Summary scrolled 200 px, End day, Yes, end day.
- Seen: the review arrives at scrollTop 24 (744 px in a 720 px region); the tab strip starts 52 px from the top, only its underline under the amber band. The `scrollTo` of #368 runs
  (top 0 at 120 ms in a 40 ms trace) and the region then moves 24 px at 165 ms, when the review's content grows from 720 to 744 px. At 1440 it lands at 0.
- Expected: a new screen starts at the top.
- Screenshots: `241-day-review-after-end-day-1180`, `170-after-end-day-offset200-1180`; `evidence/walk24-1180.txt`.
- Design checked: no document covers scroll on navigation (as for D-184).

### D-190 · P3 · Practice / Order route thread picker and the no-order guard

- Surface: `/practice/order` (no thread, `?thread=abc`, `?id=999`), both widths.
- Seen: each picker row links to `/practice/order?thread=<id>` (#368). `ORDER_TARGET` in `e2e/desk/helpers.ts` matches `/order?`, so `expectCleanScreen` fails with "order control on screen" and
  the row. The Order tab is a button without an address and passes. No existing spec visits the bare route.
- Expected: a clean screen: the guard names this address as the Order tab's own, or the rows do not carry it.
- Screenshots: `85-order-999-{1440,1180}`, `150-17-_practice_order-{1440,1180}`; the failure is in `evidence/run-all.log`.
- Design checked: ADR-0016 (the replay ticket's two paths only); `e2e/README.md`. This is the Order tab's pick-a-stock page, not a ticket.

### D-191 · P3 · Practice / week route thread picker

- Surface: `/practice/week` with no thread.
- Seen: "Pick a swing thread to open its weekly reviews." over every thread, the day thread included; each row goes to `/practice/thread?id=` (the Summary).
- Expected: hint and rows agree (swing threads only, each to its review, or "to open its Summary").
- Screenshots: `150-01-_practice_week-{1440,1180}`; `evidence/walk15-1440.txt`.
- Design checked: D-183's row names the other three pickers only.

### D-192 · P3 · Practice / week route offers a week that has not started

- Surface: `/practice/week?thread=<swing>` (no week or `week=0`) with Days 1 to 10 ended.
- Seen: "No week selected" with "Open Week 3"; the link opens "Week 3 has not started yet." The offered number is `swing.week_no`, which moves on when Week 2 ends.
- Expected: the link goes to a week with a review (Week 2).
- Screenshots: `96-week-noweek-{1440,1180}`, `96-week-week3-{1440,1180}`; `evidence/walk09-weeks-*.txt`.
- Design checked: the thread page's "Open Week 2 review" (`93-swing-journal-1440`) names the right week.

### D-193 · P3 · Practice / a thread id that is not a number

- Surface: `/practice/week?thread=abc`, `/practice/order?thread=abc`, `/practice/journal?thread=abc`, `/practice/day?id=abc`, `/practice/replay?id=0`.
- Seen: "not found" on the week, day and replay routes; "No practice thread selected" and the picker on the order and journal routes (`/practice/thread?id=abc` not read).
- Expected: one answer on every route.
- Screenshots: `150-05` (week, abc), `150-19` (order, abc), `150-24` (replay, id 0), `150-27` (day, abc), `150-30` (journal, abc) (`150-NN-<route>`); `evidence/walk15-*.txt`.
- Design checked: D-164 and D-183 (not selected, not found, failed to load): silent on a malformed id.

### D-194 · P3 · Desk e2e / screener preview spec stale after D-185

- Surface: `e2e/desk/screener.spec.ts:136`, both desktop projects.
- Seen: it waits for the region "BOLT 15m market chart" and its status; the preview now draws "No price bars for BOLT yet" with no chart region. It passes on the build before #368 and
  #369. Five other specs of the same five files fail on that build too (`practice-landing:285` and `:531`, `practice-overview:45`; `practice-landing:244` and `week-chart:38` change width between runs).
- Expected: the spec asserts the new empty state.
- Screenshots: none (a test result); `evidence/run-existing.log`, `evidence/run-existing-base.log`.
- Design checked: `e2e/README.md` (the specs are local gates the delivering session runs).

## Clean: screens and flows that held up

- `/practice` landing empty, with a day thread, with a day and a swing thread; New plan modal (day and swing; the window-error wording of D-160), 1440 and 1180.
- `/practice/day`: the column set whole at both pane widths (1440 drops Prev vs VWAP %, 1180 shows it), list time and footer after a Re-scan (both say 9:30 AM), Open and Peek, a click on
  a row cell reaches the chart, the ladder weekday ("Day 2 · Mon"), the Portfolio view and its $ and % switch; the day review after End day (ranking table whole).
- `/practice/thread`: the Summary clock with Hide dates on and off, Equity headline, Buying power, Skip day and End day confirms, Day 2 after a skip, the 10x clock with one visible clock,
  the preparing state (D-182), the Order and Trades tabs, the journal's thread rail row whole (name, balance with SIMULATED, status) at 1440 and 1180.
- `/practice/replay`: header "realized today", the pace row on one line, rail status, Position panel labels, the ticket's market, limit, stop and stop-limit entries, a working limit buy,
  a short and Close position, the buying-power refusal; the crosshair's orange tags on a chart are the stale mouse position, not a defect (a "378.54" tag beside a list price of 377.94 is that).
- `/practice/week` and the swing journal (Improvement table, SIMULATED pill, "P/L SINCE ENTRY" in the hold table, tiles that reconcile: 831 − 402 = 429), the Improvement, Thread plan and
  Close thread drawers at 1180, `/practice/order` with the stock search and its empty answer.
- `/today`, `/screener` (abnormal-volume first row), `/watchlists`, `/strategies`, `/settings`, `/feedback` (empty): no banned wording, no order control, tables whole at both widths.
- Not defects, on purpose: the LAST DAY column absent at 1180; the Summary clock's "Fri · 9:30:00 AM ET" with Hide dates on; "Replace plan" disabled with its reason only in the title and
  the accessible description (the clock card carries the visible one).

## Could not exercise

- A swing thread past Week 2 with a closed hold; real-data or live-feed states (the stub day covers Fri 2026-09-25, so Day 2 of a block shows its empty state); the Screener preview
  with bars at 1180 (the saved-filter case was read at 1440 and probed at 1180, not read); the journal thread rail at the 191 to 231 px widths the brief names (its width was read from screenshots, not measured, and the row was whole at both viewports); `/practice/thread?id=abc`.
