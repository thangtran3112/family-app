# Walkthrough wave 9: the Practice desk on `dev` (`da19511f`)

Date: 2026-11-02. New defects D-169 to D-178 (10: P1 0, P2 1, P3 9). Nothing was fixed in this lane.
Wave-8 verification: D-155, D-156, D-158, D-160, D-162, D-163, D-164, D-167, D-168 hold on the live screen; D-161 and D-166 hold in part
(the residue is filed as D-171 and D-172); D-157, D-159 and D-165 are still `Open` in the ledger, are not on this cut, and still break exactly as filed.

Screenshots are not in the repository; the names below are files in the run's `walk-9/` directory (outside the repo, next to the run's copy of this report). A name ending `-1440`
or `-1180` is the viewport width; `-tall` is the same screen on a 2,600 px viewport. Each screenshot has a `.json` next to it with the probe facts
(clipped text, scrollers, type under 11 px, unnamed controls, banned wording, the main region's text). `walk-9/evidence/` holds the sampling logs and
the throwaway specs that produced them (the specs are not in the commit).

## How it was run

- Cut: `origin/dev` `da19511f` (dev had not moved since the brief). Worktree `practice-walk-9`, branch `feature/practice-walk-9`.
- Harness: the Desk e2e stack (disposable `desk_e2e_<hex>` database in the tmpfs `desk-test-postgres` container, `tests/e2e/browser_server.py`, `e2e/proxy.mjs` over a
  copy of the static export built from this worktree). No Docker, no `pnpm test:e2e`; ports 19244 (API) and 19245 (proxy); the stack was brought up once with a small
  script outside the repository (create database, alembic head, `seed_database`, start both servers, drop the database on SIGTERM) and shut down at the end.
  12 throwaway Playwright specs and one config drove it at 1440 x 900 and 1180 x 820, then were deleted before the commit.
- Seeds: `technical` (the live surfaces), the stub replay day (TSLA, Fri 2026-09-25, 09:30 to 09:40 ET) for day threads, and the swing world `S01` to `S12` for the swing board,
  week review and swing journal.
- Clock: most specs use the harness's frozen browser clock (`page.clock.setFixedTime`), under which the thread readout only moves with the server poll. Every clock-agreement claim
  below (D-166, D-172) was therefore re-sampled in a second browser context with a real browser clock, every 100 ms in the page.
- 138 snapshots (217 images) were screenshotted and probed by script at both widths. No snapshot showed banned wording (`bannedWordingOnScreen`), a document-level horizontal
  scrollbar, type under 11 px or an unnamed control. I read the screenshot itself at both widths for the modal, the Summary, the replay, the journal, the day list and the swing board;
  for `/screener`, `/watchlists`, `/strategies`, `/settings` I read the page text and the script facts, not the image; `/today` and `/feedback` were read as images at 1440 only.

## Wave-8 verification (D-155 to D-168)

| ID | Verdict | Route and steps | Proof (screenshots in `walk-9/`) |
|---|---|---|---|
| D-155 | Fixed | `/practice/thread?id=`, Hide dates Yes (default), Day 1 open: the Summary clock reads "Fri · 9:30:00 AM ET" and "Next session starts Mon · 9:30 AM ET"; after Skip day "Mon · 9:30:00 AM ET" and "Tue · 9:30 AM ET". With Hide dates No the same clock reads "Fri, Sep 25 · 9:30:00 AM ET". After End day the review of a Hide dates Yes thread says "Day finished · Fri 2026-09-25". The End day question on a Yes thread was not read (only on the No thread, which shows the date). Residual: Show date does not reach the Summary clock (D-174). | `10-summary-day-open-1440`, `35-summary-after-skip-1180-tall`, `51-nodates-summary-1440`, `111-day-review-hidden-yes-1440-tall` |
| D-156 | Fixed | Buy 100 TSLA at 09:33, step to 09:36, Summary: headline "EQUITY $49,778.00", line under it "Open P/L −$222.00 at the clock · Balance $50,000.00"; Trades tab "Balance now $50,000.00"; chart header "Thread balance $50,000.00". Balance is the realized figure everywhere. Neighbours that the fix left: D-169, D-170. | `23-summary-long-open-1440`, `25-trades-long-1440`, `20-replay-long-1m-1440` |
| D-157 | Not fixed (Open, sibling lane `feature/wave9-daylist` has uncommitted work only) | `/practice/day?id=`, wait 1.5 s. 1440: table 1,521 px in an 808 px pane, PREV (RVOL) cut under ACTIONS; 1180: 1,019 px in 868, PREV CHANGE reads "−0.57" with the % cut. Swing board at 1440: the last header is a lone "$". Screener at 1440: 900 px in 808. The Trades fills table did not overflow at 1180 with the Close thread drawer open (one fill). Day review table: new row D-173. | `07-daylist-settled-1440`, `07-daylist-settled-1180`, `91-swing-board-holds-1440`, `101-screener-1440` |
| D-158 | Fixed | Long open at −$222: header "Thread balance $50,000.00 · realized today $0.00", PRACTICE P/L −$222.00 beside it; the day list's strip and the Thread plan rail say "Realized today". | `20-replay-long-1m-1440`, `07-daylist-settled-1440` |
| D-159 | Not fixed (Open, sibling lane) | `/practice/day?id=`: first paint LIST PRICE, PREV CLOSE, PREV RVOL …; about 400 ms later PRICE AT LIST, PRICE NOW, VS PREV CLOSE % NOW, PREV CLOSE and "Price now follows the day clock, 9:30 AM ET". | `06-daylist-first-paint-1440` against `07-daylist-settled-1440` |
| D-160 | Fixed | New plan, tick Abnormal volume (Start at moves to 10:00), set Focus until 09:20: "Focus until must be after Start at" under the field and in the footer; list time 8:30 with Start at 09:30: "Start at must be at or after List time". No schema path anywhere. | `03-modal-window-error-1440`, `03-modal-window-error-1180`, `04-modal-filled-1440` |
| D-161 | Fixed in part | `/practice/journal?thread=` (Trades): the name "Day thread · Oct 15" and "Swing thread · Oct 15" now sit on their own line, whole at 1440 and 1180. The status line under it is still cut ("· A…" at 1180, "· Active · …" at 1440): filed as D-171. | `25-trades-long-1440`, `25-trades-long-1180`, `93-swing-journal-1440-tall` |
| D-162 | Fixed | Long open, Position panel (right rail at 1440, Practice drawer at 1180): "Unrealized" and its value "−$222.00" sit on two lines, value right-aligned under the label, no overprint. | `20-replay-long-1m-1440`, `22-position-panel-1180` |
| D-163 | Fixed | Replay Signals on a thread with nothing armed: "No signals yet · no strategy is armed on this thread". `/today` with five Draft strategies: "No signals yet today · no strategy is live yet". | `13-replay-start-1440`, `100-today-1440`, `103-strategies-1440` |
| D-164 | Fixed | `/practice/thread`, `/practice/order`, `/practice/journal` with no id: "No practice thread selected · Pick a thread to open its journal" plus the thread list; `/practice/day`: "No practice day selected"; `/practice/day?id=999`, `/practice/replay?id=999`, `/practice/journal?thread=999`, `/practice/thread?id=999`: "… was not found · open one from Practice". `/practice/order?thread=999` was not exercised (my first run passed `id`, which that route does not read). | `77-order-noid-1440`, `79-day-noid-1440`, `81-day-999-1440`, `82-replay-999-1440`, `83-journal-999-1440`, `84-thread-999-1440` |
| D-165 | Not fixed (Open, sibling lane) | `/practice/day?id=` after Re-scan at the 9:30 clock: header "Scan 1 · run at 9:30 AM ET · data through 9:15 AM", note "Every other column is fixed at the 8:30 AM ET list until the market opens" (the clock is 9:30), footer "List built 8:30 AM ET" and "Day lists built before the open". | `11-daylist-after-rescan-1440`, `11-daylist-after-rescan-1180` |
| D-166 | Fixed in part | Real browser clock, thread playing at 1x, 5x and 10x, `/practice/replay?id=` sampled every 100 ms for 6 s (60 samples per speed, both widths): the 20-clock-second gap that stayed in wave 8 is gone, but the footer "Replay clock" and the chip show the previous tick in 27 to 30 of 60 samples at every speed (10x: 9:40:49 against 9:40:41). Filed as D-172. | `evidence/real-clock-1440.txt`, `evidence/real-clock-1180.txt`, `32-replay-10x-1180` |
| D-167 | Fixed | `/feedback` with no reports: no "Select a report" line; the status chips are dimmed; "Reason: filters turn on once there is a report to filter." The right rail is a "REPORT" heading over an empty body (nothing wrong, nothing to say). | `105-feedback-empty-1440`, `105-feedback-empty-1180` |
| D-168 | Fixed | Long open at 09:36: VWAP 377.28 in the header, the legend and the left rail on 1m, 5m and 15m (the rail row says "Price below"); at 09:30:00, before any regular-session bar, "—" with "Warming up". | `21-replay-5m-1440`, `21-replay-15m-1440`, `22-position-panel-1180`, `13-replay-start-1440` |
| #351 lock | No 500 or 524 seen | Dozens of day-list loads, several Re-scans, Day 1 and Day 2 opens, a Skip day and four End days over two hours: every answer came back. Not stress-tested (no concurrent open and Re-scan from two tabs). | n/a |

## New defects

### D-169 · P2 · Practice / thread Summary TODAY card

- Surface: `/practice/thread?id=` Summary, TODAY card. 2026-11-02.
- Steps: Day 1 open, Buy 100 TSLA at 09:32, step to 09:35, open the Summary, Play at 10x for three seconds, Pause, wait four seconds.
- Expected: one open P/L. Seen: headline "Open P/L −$822.00 at the clock" and the block's Open P/L −$822.00 (it was −$867.00 while playing), the TODAY card "$0.00 realized so far · 0 practice trades · 1 open −$791.00" before, during and after. The End day confirm on the same page read "Open P/L −$821.00" beside "1 open −$836.00" on the card. The day review then booked −$821.00, so the card was the stale figure. At 1180 the same: headline −$796.00, card −$791.00.
- Screenshots: `53-summary-nodates-after-10x-1440-tall`, `55-end-day-confirm-1440`; logs `evidence/mismatch-1440.txt`, `evidence/mismatch-1180.txt`.
- Design checked: ADR-0018 "Balance" (account at the clock) and the wave-8 ruling on D-156 ("anywhere a single number is labelled Balance it must be the realized cash figure"); neither describes the TODAY card's figure.

### D-170 · P3 · Practice / thread Summary headline line

- Steps: Buy 100 TSLA, step to 09:36, open the Summary.
- Seen: "EQUITY $49,778.00", "Open P/L −$222.00 at the clock · Balance $50,000.00", then "Started with $50,000 · no change yet". Expected: no "no change yet" under a headline that has moved; D-080 did that for swing holds (`startedWithText`, `threadView.ts`), the day-thread branch with an open position still prints the flat sentence.
- Screenshots: `23-summary-long-open-1440`, `23-summary-long-open-1180`. Design checked: `threadView.ts` comment on D-080; no doc covers the day-thread case.

### D-171 · P3 · Practice / Your threads rail status line (D-161 left over)

- Route: `/practice/journal?thread=` Trades tab. Seen: the name is whole now; under it "$49,246.00 SIMULATED · A…" at 1180 and "· Active · …" at 1440; the span is 191 px wide for 250 to 280 px of text. Same on the swing thread ("· Active · …").
- Expected: the status readable. Screenshots: `25-trades-long-1180`, `25-trades-long-1440`, `93-swing-journal-1440-tall`. Design checked: wave-8 ruling list (no entry for the status line).

### D-172 · P3 · Practice / replay footer and chip clock (D-166 left over)

- Route: `/practice/replay?id=`, thread playing, real browser clock. Steps: Summary, speed, Play, open the chart, sample the page every 100 ms.
- Seen: of 60 samples, 28 (1x), 27 (5x) and 29 (10x) disagree at 1440; 27, 30 and 30 at 1180. Example at 1x "Thread time 9:32:09" with footer "Replay clock 9:32:08"; at 10x "9:40:49" with "9:40:41". The readout ticks each second; the footer and the chip show the previous tick. Before the fix the gap was 20 clock seconds and stuck; now it is at most one tick, but it is on screen about half the time and eight clock seconds wide at 10x.
- Expected: one value (`useShownClock` says all three read it). Cause not traced; footer and chip go through `useReportPracticeChrome`, the readout does not.
- Screenshots: `32-replay-10x-1180`, `54-replay-5x-1440`; logs `evidence/real-clock-1440.txt`, `evidence/real-clock-1180.txt`, `evidence/clock5x-1440.txt`. Design checked: ADR-0018 and `useShownClock.ts` header.

### D-173 · P3 · Practice / day review ranking table (D-157 family)

- Route: `/practice/day?id=` after End day. Seen at 1440: the "Ranked by move from list price" table is 924 px in an 808 px pane; LOW AFTER OPEN is cut to "LOW AFTER", its value to a dash, and RANGE is off screen. At 1180 the table fits (MOVE TO CLOSE and RANGE are dropped).
- Expected: wave-8 ruling on D-157: every shown value whole, columns dropped by pane width. The ruling lists the day list, the swing board and the Trades fills table, not this table; the sibling day-list lane changes `DenseTable`, so re-check after it lands.
- Screenshots: `56-day-review-1440-tall`, `56-day-review-1180`, `111-day-review-hidden-yes-1440-tall`. Design checked: `design-system-rulings.md` (D-157).

### D-174 · P3 · Practice / Show date and the Summary clock

- Steps: Hide dates Yes, Day 1 open, open TSLA, press Show date in the band, open the Summary.
- Seen: chip and chart header "Fri 2026-09-25"; Summary "Fri · 9:33:00 AM ET" and "Next session starts Mon · 9:30 AM ET". Expected (D-155 ruling: the clock shows what the "Replay · hidden day" chip shows): once the chip shows the date, the clock does too, or the chart says the date is shown on this screen only.
- Screenshots: `120-replay-show-date-1440`, `121-summary-after-show-date-1440`. Design checked: `design-system-rulings.md` (D-155), D-023, D-100.

### D-175 · P3 · Practice / Summary Equity block layout

- Seen at 1440 and 1180: Balance, Open P/L and Equity in a two-column grid; "Open P/L" sits beside Balance with its value 500 px away at the card edge, Equity wraps under Balance, and the hint "Balance is what you have realized…" sits directly under the Equity row, in a larger type size than the rows. The card says the same three figures a third time (headline, line under it, block). Also in wave 8's screenshot (`walk-8/12-summary-day-open-paused-1440`), not filed then.
- Screenshots: `10-summary-day-open-1440`, `23-summary-long-open-1180`. Design checked: ADR-0018 "Balance" and the wave-8 rulings fix labels, not layout.

### D-176 · P3 · Practice / Summary while data prepares

- Steps: New plan, Any close, Start, read the Summary at once. Seen: TODAY and PLAN both print "Preparing data · 19 of 53 names" and both "The first list opens when the data is ready. You can leave this page." Expected: said once. D-084 is the same state, other lines.
- Screenshots: `05-thread-summary-before-day-1440`, `05-thread-summary-before-day-1180`. Design checked: D-084 row.

### D-177 · P3 · Practice / replay tape pace at 1180

- Seen: in the 240 px left rail the pace row wraps ("PACE · 10" over "SECONDS", "Busy · 6.5x" over "usual"); at 1440 it is on one line.
- Screenshots: `22-position-panel-1180` (left rail), `20-replay-long-1m-1180`. Design checked: nothing on this row in the design docs read.

### D-178 · P3 · Practice / swing week review hold P/L

- Route: `/practice/week?thread=&week=2`. Seen: the week tiles read UNREALIZED CHANGE +$429.00 and EQUITY CHANGE +$429.00; the "Holds this week" row for S04 reads P/L +$831.00 (since the Day 1 entry, Week 1's +$402.00 included). Expected: the column says since entry, or shows the week's change.
- Screenshots: `95-week2-1440-tall`, `95-week2-1180`. Design checked: `plans/subplans` and `decisions` for "holds this week": no rule.

## Not defects (read and left alone)

- The weekday on the day ladder and the day list header while dates are hidden ("Day 2 · Mon"): D-018 (owner-asked).
- The New plan modal keeps the 10:00 list time after a filter that needs it is unticked: D-017/M-02 sticky suggestion.
- The 1m chart on the stub day shows the practice bars in the left 40 px of the plot: the stub's lookback is 6,000 bars; real data was not available here.
- Intraday prices differ by a few cents between two runs at the same displayed clock second (milliseconds differ); the stub's prints are fixed.
- `/practice/week?thread=<id>` without `&week=` says "No practice thread selected": not reachable from any link (every link carries both).
- The order ticket's blank-price summary "Buy 100 TSLA · Limit · limit —" repeats the word; copy only, not filed.
- `/alerts` condition column is cut to 150 px at 1180 (outside this wave's list).

## Could not exercise

- The Improvement week table past "Too few days to call a trend yet" (it needs two weeks with three practice days each; the stub has one replay day with data). The SIMULATED pill and the 3-day caveat do show ("Reason: week 1 has 1 practice day so far. A trend needs at least 2 weeks with 3 or more practice days each."), `74-journal-drawer-improvement-1180`.
- The day list's Earnings column and its "checked, none" state (no earnings column appears in this seed's day list).
- `/practice/order?thread=999`; the End day question on a Hide dates Yes thread; a concurrent Re-scan and open against the day-list lock (#351).

## Clean: screens and flows that held up

- `/practice` landing (empty and with a thread): row, SIMULATED pill, actions, both widths.
- New plan modal, day and swing: one two-column grid, no Arm strategies, no Risk plan, errors in plain words, the swing universe table and survivorship note.
- Summary: Equity headline, Play, speeds, Pause, Skip day (confirm, hand-over, Day 2 clock "Mon · 9:30:00 AM ET", result −$235.00 booked at the last price), End day (confirm names the open trade and the clock price; the review's trade table adds up: 100 × (372.27 − 380.48) = −$821.00, −2.16%).
- Portfolio with a position and the $ / % switch; Order tab; Trades tab and fills; thread plan and close thread rail.
- Replay: header "realized today", VWAP on 1m/5m/15m, left rail indicators, Position panel, order ticket errors ("Quantity: a whole number of 1 or more", "Not enough practice cash · $50,000 free", "Limit price: a number above 0").
- Swing board (day 1, with holds), Week 1 and Week 2 reviews, swing journal.
- `/today`, `/screener`, `/watchlists`, `/strategies`, `/settings`, `/feedback` (empty): no banned wording, no document overflow, no unnamed control; the Screener's SINCE cut is D-157.
