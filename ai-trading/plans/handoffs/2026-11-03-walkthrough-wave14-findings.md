# Walkthrough wave 14: the Practice desk and the live Desk on `dev` (`d98fd5c9`), live release `7fc9a7aa`

Date: 2026-11-03. New defects D-206 to D-211 (6: P0 0, P1 0, P2 1, P3 5). Nothing was fixed in this lane.
Wave-17 verification (D-198 to D-205, the fixes of #394): all eight hold on the screens they name. One neighbour of D-201 is new: the mouse is fixed,
but the chart's own refresh still blocks the page for 0.2 to 0.6 s on every poll or bar (D-206). No `Fixed` row was touched.

Screenshots are not in the repository; the names below are files in the run's `walk-14/` directory (outside the repo, next to the run's copy of this report).
A name ending `-1440` or `-1180` is the viewport width; `-tall` is the same screen on a 2,600 px viewport; `prod-*` were taken on the live build, everything else on the
local rig. `d196-*`, `d196s-*`, `sheet-d199-*` and `d199-*` are 2x crops of price axes, `d198-*` the two-window runs, `twowin-*` the step runs. Each rig screenshot has a `.json`
next to it with the probe facts (clipped text, scrollers, type under 11 px including the effective size of SVG text, unnamed controls, banned wording, SVG labels that overlap one
another, sit on a drawn series or are cut by their box, the main region's text). `walk-14/evidence/` holds the 54 throwaway specs and their helper, the Playwright config, the run scripts, the
sampling outputs (`*.txt`) and the run logs. None of it is in the commit.

## How it was run

- Cut: `origin/dev` `d98fd5c9` (wave 17, #394). Worktree `practice-walk-14`, branch `feature/practice-walk-14`. `origin/dev` has since moved to `8eb8fa14` (an infra change, #399); no Desk
  code differs. `DEFECTS.md` on the cut ended at D-205; no sibling worktree held a row past it, so the new rows start at D-206.
- Same code on the rig and on the live build: the local `next build` of this cut and the live page serve the same content-hashed chunks (eight of eight sampled script names match, for
  example `3ps_78y_x9ed3.js`, `3wq2wnn16_qm6.js`, `0alyww4gw8-ha.js`), so a rig result is a result about what she runs.
- Rig: the Desk e2e stack through `tests/e2e/run.py --browser -- …` as `e2e/README.md` describes "Without Docker": a disposable `desk_e2e_<hex>` database in another session's tmpfs
  `desk-test-postgres` container (`DESK_E2E_ADMIN_DATABASE_URL`, loopback), `browser_server.py` and `proxy.mjs` on 18050/18051 and, for a second lane run at the same time, 18052/18053
  (both were free; no sibling held them), `--output=/tmp/w14/pw-<tag>`, one worker per run. No Docker, no `pnpm test:e2e`. The harness came up on the first attempt; every database was dropped by `run.py`.
- 54 throwaway specs: wave 13's 47 re-pointed at this cut, plus 7 new ones (`71` thread flows, `72` replay deep, `73` Peek axis and two windows at 10x, `74` last price against candle close,
  `75` tab with no open day, `76` delete and close questions, `77` bar-tick cost). 11 run logs; 241 snapshots and 478 images. Specs `03`, `04`, `05`, `06`, `11`, `12`, `14` still drive controls
  that were removed after wave 13 (the Order tab, the `%` switch, End day, Open Day 2, Show date) and stop there: their failures are stale specs, not defects, and what they snapped before stopping was read.
- Live build: the shared agent browser, signed in as her, 1440 x 900 and 1180 x 820 in my own tab. Read-only: no clock was stepped, jumped or skipped on a live thread, nothing was saved or
  deleted, no order was placed. Two things were touched and put back: the persisted mode (Technical, then back to Backtest) and a chart interval (view state; the chart reopens on 5m).
  A filter form left dirty asked before leaving; I left without saving.
- Probe totals over the 241 rig snapshots: banned wording 0, document-level horizontal scroll 0, computed type under 11 px 0, SVG text under 11 px 0, SVG labels overlapping or cut by their box 0,
  unnamed controls 2 (the "Copy" button inside the closed "View JSON" disclosure on `/screener/filters` and `/alerts/new`, which the probe counts as visible; known since wave 13). The `clipped` lists held
  only the visually hidden 1 px spans, `legend "Default mode"`, the company names that ellipsize on purpose and the strategy descriptions that ellipsize on purpose.
- Known-flaky checks, rerun alone with the real specs: `practice-chart.spec.ts` "a level's name shows only on hover" passes at 1440 (11.3 s) and 1180 (10.8 s); on wave 12's and wave 13's
  bases it ran past its 30 s timeout. That was D-201 and it is gone. "the type applies to the Daily chart…" (the swing Daily `not.toContainText("VWAP")` check) passes at both widths (3.3 s, 2.7 s).
  Neither is a defect on this cut.
- Seeds: `technical` (the live-surface screens), the stub replay day (TSLA, Fri 2026-09-25, 09:30 to 09:40 ET) for day threads, the swing world `S01` to `S12`.

## Wave-17 verification (D-198 to D-205)

| ID | Verdict | Route and steps | Proof (screenshots in `walk-14/`) |
|---|---|---|---|
| D-198 | Fixed | `/practice/replay?id=` on TSLA 1m, one session in two windows. Rig, 1440 and 1180: (a) four `stepBar` steps (`POST /replay/threads/<id>/clock {step: "bar"}`), five seconds after each: both windows read 6000, 6001, 6002, 6003, 6004 source bars; their last data rows are identical (9:26 to 9:33, no hole); a reload of the second window reads 6004. (b) 10x Play from the Summary in a third window, twelve samples over 36 s: the two charts read 6000, 6000, 6001, 6001, 6002, 6002, 6003, 6003, 6004, 6004, 6005, 6005 in step with each other, then both 6006 at 9:36:06 after Pause, with the same last four rows. Live: two tabs on her running thread (server clock at 1x, PLTR 1m), nine samples over three minutes: 6305, 6305, 6306, 6306, 6306, 6307, 6307, 6307, 6308 in both tabs at every sample. | `twowin-A-1440`, `twowin-B-1440`, `twowin-A-1180`, `twowin-B-1180`, `d198-10x-A-1440`, `d198-10x-B-1440`, `d198-10x-A-1180`, `d198-10x-B-1180`, `prod-chart-pltr-1180`; `evidence/twowin-*.txt`, `evidence/d198-10x-*.txt` |
| D-199 | Fixed | Replay price axis, 1440 and 1180, TSLA 1m at 9:34 with no position: the lowest tick and the lowest tag sit whole above the pane edge; the sweep 9:31 to 9:40 on 1m, and 5m and 15m at 9:40, shows no half-cut tick at any minute. Day-list Peek ("Up to list time", TSLA): the orange VWAP tag "378.92" sits whole on the bottom edge, no tick under it, at both widths. Live: PLTR 1m at 1180 and 1440, lowest tick "156.00" whole. | `d196-1-flat-axis-*`, `sheet-d199-sweep-1440`, `sheet-d199-sweep-1180`, `130-peek-1440`, `130-peek-1180`, `sheet-d199-peek-vwap`, `prod-axis-1m-1180`, `prod-axis-1m-1440` |
| D-200 | Fixed | The same axis with crowded tags: 9:34 with 100 shares long (green "372.62" stacked over red "372.47") and with a stop at 370.50 (orange "370.50" over grey "370.26"), both widths: a tick that would sit under a tag is left out, none is half hidden. Live, with her 200-share PLTR position (green "158.75", orange VWAP "157.46") and three stacked tags near 163: no tick cut. | `d196-2-long-axis-*`, `d196-3-long-stop-axis-*`, `sheet-d199-d200-axis`, `sheet-prod-axis` |
| D-201 | Fixed (the pointer). Neighbour: D-206 | Mouse over the replay plot on the 6,003-bar lookback, twelve moves each: 1m 8 ms a move (1440) and 9 ms (1180); 5m 1,987 bars 8 and 9 ms; 15m 663 bars 8 and 9 ms; vertical and horizontal sweeps, the left rail and the right edge 8 ms; the Technicals NVDA 15m chart 8 ms. No long task in any run (was 545 to 585 ms a move at 1m). Live: PLTR 6,308 bars at 1m, then 5m and 15m, 1180 and 1440: 7 to 8 ms a move; the one 705 ms long task seen came from a bar arriving, not the pointer (D-206). The real hover spec now passes in 11 s. | `evidence/mouse-1440.txt`, `evidence/mouse3-1440.txt`, `evidence/mouse-1180.txt`, `evidence/mouse3-1180.txt` |
| D-202 | Fixed | Live `/practice/journal?thread=` (the Oct 31 day thread) at 1180, 23 SVG text nodes, effective size = font size times the SVG's screen scale: drawer shut 12.6 px; Improvement, Thread plan and Close thread open 11.0 px (was 7.9). 11.0 px is the caps floor, not the 12 px floor for values, and equals the 1440 reading of wave 13 (11.7); not refiled. | `prod-d202-journal-closed-1180`, `prod-d202-journal-drawer-improvement-1180`, `prod-d202-journal-drawer-threadplan-1180`, `prod-d202-journal-drawer-closethread-1180` |
| D-203 | Fixed (rig; live by bundle) | Rig `/practice/replay?id=` on a swing name (S01), Daily view, 1440 and 1180: the left rail's indicators note reads "Read from the bars shown on the chart, up to the replay time. Nothing here looks ahead." with no VWAP sentence and no "every chart interval"; the real swing Daily spec is green alone at both widths. The chart's header strip still carries a VWAP stat ("—") on Daily; that is the header, not the note (see "Not filed"). Live: her one swing thread has no open day (Week 1 review due), so no Daily chart can open without starting a day; the live bundle carries `indicatorsFootnoteDaily:"Read from the bars shown on the chart, up to the replay time. Nothing here looks ahead."` beside the intraday `indicatorsFootnote` that keeps the VWAP sentence. | `550-swing-daily-indicators-1440`, `550-swing-daily-indicators-1180`, `550-swing-daily-indicators-panel-1440`, `prod-swing-day5-1440` |
| D-204 | Fixed (the words). The echo stays, as the row says | Live `/practice` > New plan at 1440, Abnormal volume ticked, "Start at (ET)" 09:20: under the field "Start at must be between 9:30 AM and 4:00 PM" (the field is `aria-invalid`); the footer repeats it. Plain words, sentence case, 12-hour times. The sentence still shows twice, the gap the row names for the owner to decide; not refiled. | `prod-d204-start-0920-1440`, `prod-newplan-open-1440` |
| D-205 | Fixed (the field it names). The "Days" gap in the row is not exercised | `/screener/filters` at 1440 and 1180 (rig) and 1440 (live): 3 in "Average volume days" and Create filter: summary "Average volume days: Must be 5 or more.", field line "Must be 5 or more."; 61: "Average volume days: Must be 60 or less." One name for the field in both places. | `prod-d205-days-3-1440`, `prod-d205-days-61-1440`; rig output in `evidence/run-B.log` (`days=3`, `days=61`) |

## New defects

### D-206 (P2) Practice / replay chart refresh blocks the page on every poll and every new bar

- Surface: `/practice/replay?id=` on a day thread, 1440 and 1180; the same on the live build.
- Route and steps: open a day thread's TSLA chart (6,000-bar 1m lookback). Record `PerformanceObserver({entryTypes: ["longtask"]})` with no input. On 5m, leave the clock paused for five seconds.
  On 1m, move the clock one bar (`POST /replay/threads/<id>/clock {step: "bar"}`), three times. Then 10x Play with the chart open in two windows. The CPU profile is one 1m step.
- Expected: a poll that brings nothing new costs close to nothing; a new bar costs the same at 6,000 bars as at 60 (the bar is appended; the series and its 5m and 15m aggregates are not rebuilt).
- Seen: 1m idle, no long task; each new bar one long task of 584, 612, 568 ms (1440) and 618, 551, 580 ms (1180). 5m, clock paused, nothing new: a 190 to 210 ms long task on every 2 s poll
  (three in five seconds, both widths). 15m: 73 to 88 ms on every poll. 10x Play, two windows: one 550 to 660 ms task per bar in each window (six bars in 36 s, six such tasks). Live (`7fc9a7aa`, PLTR
  1m, 1x clock): a 705 ms task landed when a bar arrived. The cost grows with source bars as D-201's did (6,003, 1,987, 663). The profile of one 1m step puts about 0.5 s of its 0.9 s of non-idle time
  in two minified functions of the app's own chunks (`0alyww4gw8-ha.js` 287 ms, `04llc_kzubj-w.js` 225 ms). D-201 holds (the pointer costs 8 to 9 ms); this is the other path into the same work. The page
  is not frozen, but with the clock running the crosshair, legend and ticket stall on every bar, and on 5m (the plan's usual interval) for a tenth of every second while the clock is paused.
- Screenshots: no picture shows a stall; `evidence/bartick-1440.txt`, `evidence/bartick-1180.txt`, `evidence/d198-10x-1440.txt` (the "long tasks during the 10x run" line), `evidence/zz-w14-77.spec.ts`.
- Doc checked: ADR-0018 "Sync: poll, not push" (a 2 s idempotent poll per followed chart; it does not budget the cost of an answer) and the D-201 row ("Expected: a crosshair move costs the same at 6,000 bars
  as at 60"). Filed as a defect; the decision (append a bar, or re-aggregate off the main thread) is the owner's.

### D-207 (P3) Practice / thread tab strip: Day list and Board do nothing when no day is open

- Surface: `/practice/thread?id=` Summary, a day thread before its first list and a swing thread whose week review is due, 1440 and 1180; the live "Swing thread" with "Week 1 review due".
- Route and steps: create a thread and do not start a day (or open a swing thread that shows "Week 1 review"); open the Summary; press the Day list tab (Board on a swing thread).
- Expected: the tab says why it cannot open (for example "No day is open · start the next day first") or is described as unavailable, or the Summary points at its one step.
- Seen: nothing happens. No navigation, no toast, the Summary stays selected, the tab is not disabled (`aria-disabled` and `title` empty) and carries no reason. On the live thread the only request is the thread
  read. `resolveTabHref` sends a tab with no open day "to Summary, whose one step starts the day", which is where she already is.
- Screenshots: `110-daylist-tab-no-day-1440`, `110-daylist-tab-no-day-1180`, `111-board-tab-no-day-1440`, `111-board-tab-no-day-1180`, `prod-swing-board-after-click-1440`; `evidence/tabs-1440.txt`.
- Doc checked: `lib/replay/practiceTabs.ts` header ("Every target is resolved from the server's open day"; "with no day open it lands on Summary") and `ui-primitives.md` "Controls" ("an option with
  `disabledReason` is described not hidden"). The routing is as designed; the silence is not covered by either, so it is filed.

### D-208 (P3) Today / alerts rail and bell: every alert carries a bare time

- Surface: the Today right rail (`components/dashboard/AlertsFeed.tsx`) and the top-bar bell (`components/shell/desktop/AlertsBell.tsx`), live, 1440.
- Route and steps: sign in with alerts older than today; open Today on Mon 2026-11-02 evening and read the rail; compare with `GET /api/desk/alerts?limit=50` `created_at`.
- Expected: an alert that is not from today names its day ("Sun 7:00 PM", "Fri 11:24 PM"); `lib/desk/format.ts` has the weekday-and-time form the replay clock uses.
- Seen: both print `formatEtTime` only. The rail reads 7:00 PM and 6:00 PM (the two "Re-login to IBKR" alerts of Sun 2026-11-01), then 11:24 PM, 10:22 PM, 9:20 PM, 8:17 PM, 7:17 PM (the hourly
  `premarket_0830` alerts of Fri 2026-10-30): a list of falling clock times that reads as one evening, three days old.
- Screenshots: `prod-today-1440`.
- Doc checked: D-074 (the repeating alert; its "one row per job per day" polish is still open) covers the alert, not the stamp. No design doc speaks to alert stamps (`design-system-rulings.md` has no ruling on them).

### D-209 (P3) Futures / chart stamp "as of unavailable"

- Surface: `/futures`, 1440, live (no broker).
- Route and steps: open `/futures` while no futures bars are served; read the chart header.
- Expected: no "as of" part when there is no stamp ("Unavailable" alone, or "No bars yet").
- Seen: "1D CHART · /MES" with "Unavailable" and "as of unavailable" at the right, above an empty plot, "Last close unavailable" below. `MarketChart` returns the literal `"as of unavailable"` when the stamp is null.
- Screenshots: `prod-futures-1440`.
- Doc checked: `lib/desk/freshness.ts` ("'Not started' and 'unavailable' are honest states, never a stand-in value"): the state is honest, the sentence around it is not a sentence.

### D-210 (P3) Sample and preview screens: type at 10 px, below the floor

- Surface: `/paper` (1440 and 1180), `/backtests` and `/ask` (1180), live.
- Route and steps: open each; read computed font sizes (the probe lists text under 11 px).
- Expected: sample markers at `--text-micro` (11 px) or more, chart values at 12 px.
- Seen: 10 px on "ILLUSTRATIVE", "SAMPLE RECORDS", "PROVENANCE EXAMPLES", "SAMPLE JOURNAL", "NOT PERFORMANCE HISTORY", "SAMPLE", "FIXTURE ONLY" (`/paper`); "SAMPLE ONLY", "DEMO CONFIGURATION",
  "NOT A STRATEGY RESULT", "SYNTHETIC CHART", "SAMPLE SERIES", "ANNUAL RETURNS" and the chart values "+3.2%" and "2018" (`/backtests`); "SAMPLE HISTORY", "ILLUSTRATIVE CHAT", "NOT QUOTES", "NOT SAVED" (`/ask`). The words that tell
  her the numbers are not real are the smallest type on the screen. Likely source: the three `font-size: 10px` rules in `components/fixtures.module.css` (not confirmed as the only one), which the `tokenRatchet` baseline counts as debt, so no test fails.
- Screenshots: `prod-paper-1440`, `prod-backtests-1180`, `prod-ask-1180`.
- Doc checked: `ui-primitives.md` "Tokens" ("Type floor: `--text-micro` (11px) is for uppercase caps labels only. Running text and values use `--text-meta` (12px) or larger. 10px is banned") and `design-system-rulings.md`
  ruling 3 (the same floor). The ratchet records the debt; neither document grants these screens an exception.

### D-211 (P3) Shell / Fundamental top bar at 1180: the market pill is cut again

- Surface: `/stocks`, `/holdings`, `/covered-calls`, `/ask` at 1180, after the close (live, Mon 2026-11-02 after 8 PM ET).
- Route and steps: switch to Fundamental, 1180 wide, market closed; read the top bar.
- Expected: the sentence whole in every mode (shorter wording, or the pill takes the width), as D-076's fix text asked.
- Seen: "Market closed · showing last cl…" (191 px box, 195 px of text). The Technical bar at 1180 shows it whole; the Fundamental bar also carries "Show values" and five nav links. D-107 and D-076 are `Fixed` in `5b19fad9`.
- Screenshots: `crop-prod-stocks-topbar-1180`, `prod-stocks-1180`.
- Doc checked: the D-076 and D-107 rows; no design doc fixes the pill's width.

## Not filed (seen, judged not defects, or owned by an existing row)

- D-204's echo (the sentence under the field and in the footer) and D-205's "Lookback (days)" against "Days" are the gaps those rows name; both still stand.
- Chart header "LAST PRICE 372.72" against the last 1m candle's "C 372.76" at a paused 9:36:00 on the stub day, and the same "372.72" on 15m: the stub's synthetic tape and bars are two generators; the live PLTR chart's last price differs
  from its in-progress bar by design (print against closed bars). Not a defect; do not file without real-data evidence of a gap at a closed bar.
- The swing Daily chart's header strip shows "VWAP —" (and "LAST PRICE —" before the first tape tick). D-203 is about the rail's note; the header stat is a session figure with no Daily value. Mention for the owner if the Daily view should drop it.
- The live Day list's "now" columns showed placeholders for about four seconds on a first open of a thread's day and filled by about twelve; a reload filled them in 0.7 s. One cold read, not reproduced; not filed.
- The live `/today` and `/` open `/practice` while the persisted mode is Backtest, and open Today once the mode is Technical: ADR-0014's mode rule, not a defect.
- The live screener row "Last" (5.04) against the preview chart's last close (5.21) for SGML after the close: the table is after-hours, the chart is regular-session bars; consistent.

## Clean (looked at, nothing to file)

- `/practice` landing and New plan (empty, filled, window error, swing modal): grid, wording, thread table and slot count at both widths; the live landing with five threads, the Start Trading links and buttons per row, Delete per row.
- `/practice/day`: columns drop by pane width with nothing cut (1440 and 1180), Candidates, click-to-open on a numeric cell, Peek ("Up to list time" and "Daily"), Re-scan, "Day starts" rows in the Thread plan, Block days (the rail at 1440, a drawer at 1180), a day's review after Skip day.
- `/practice/thread`: Summary (equity headline, Thread clock, Play, 1x to 10x, Skip day with its question, Jump with its forward-only error and its "Jumped to" status, no End day), Portfolio with the new broker table (TICKER, LAST, CHANGE, CHANGE %, POSITION, AVG PRICE, VALUE, UNREALIZED P/L,
  TOTAL P/L, Exit: TSLA 100 at 374.94, last 372.72, change −5.22 and −1.38% against the 377.94 prior close, value $37,272.00, unrealized −$222.00, equity $49,778.00, buying power $12,506.00 all reconcile), Trades (journal), Delete plan, Delete thread and Close thread questions.
- `/practice/replay`: fresh load, 1m, 5m, 15m, wheel zoom, double-click fit, Full screen and back, the Chart settings menu and legend toggles, indicators rail, tape, the ticket in each order type, Buy 50 and Close position (realized −$16.50 = (372.39 − 372.72) × 50), the toolbar Buy/Sell/Close at 1180, the right rail as a drawer at 1180.
- `/practice/week` (weeks 1 to 3, odd weeks, week 99), `/practice/journal` (day and swing, with and without a drawer), swing board with holds (free cash $31,993.00 = $50,000.00 − 100 × 100.01 − 100 × 80.06), equity change +$1,457.00 across the two weeks = $51,457.00 − $50,000.00.
- `/today`, `/screener`, `/screener/filters`, `/watchlists`, `/strategies`, `/alerts`, `/alerts/new`, `/settings`, `/feedback`, `/technicals`, `/more` on the rig at both widths; on the live build 1440 and 1180: no document-level horizontal scroll anywhere; `/holdings`, `/covered-calls`, `/ask`, `/backtests`, `/stocks`, `/futures`, `/paper` live only (see D-209, D-210, D-211).
- Banned wording: none on any rig screen (the `cleanDesk` fixture ran after every spec that reached its end, and the probe found none in 241 snapshots).

## Not exercised

- `/stocks`, `/futures`, `/paper`, `/holdings`, `/covered-calls`, `/ask`, `/backtests` on the rig (live only; the Fundamental specs were not run).
- Working (resting) limit and stop orders against buying power, and a short sale: wave 13's spec for them (`14`) drives the removed Order tab and was not re-pointed.
- Skip day, Jump and 10x on a swing thread; Day 2 onwards of a day thread through the UI (Skip day was taken once, on the stub day).
- A live Daily chart on a swing name (her only swing thread has no open day without starting one) and a live two-window run at 10x (it would move her thread's clock); both were done on the rig.
- D-205's "Lookback (days)" against "Days" gap on a condition (named in the row, not re-tested), and the real clock on the rig (the harness freezes the browser clock; the live run covers it for D-198).
