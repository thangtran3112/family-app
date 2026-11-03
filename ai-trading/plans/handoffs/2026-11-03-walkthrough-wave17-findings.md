# Walkthrough wave 17: the wave-20 fixes walked live on wave 23 (`f651c3de`), and a fresh pass

Date: 2026-11-03. New defects D-232 to D-236 (5: P0 0, P1 0, P2 1, P3 4). Nothing was fixed in this lane.
Wave-23 verification (PR #422): all 15 rows marked Fixed hold on live, at 1440 and at 1180 (D-216, D-218 to D-231). No `Fixed` row was reopened or touched. D-217 stays Open: 18 of 20 new 1m bars still cost one long task
of 58 to 92 ms, the same as wave 22. The one P2 is not on the freestyle path: at 1180 the Fundamental top bar now overflows the window by 25 px when the quotes pill says "Quotes paused · last update 7 hr ago", so the
account avatar sits off screen on nine routes (D-232, a neighbour of D-211). Three P3 rows are small leftovers beside rows that hold: the "Jumped to" line outliving Next open (D-233), a Try again button that cannot work
when every filter waits (D-234), long tasks while the Screen loads (D-235); one more is a question about the EARNINGS column (D-236).

Screenshots are not in the repository; the names below are files in the run's `walk-17/` directory (outside the repo, next to the run's copy of this report). A name ending `-1440` or `-1180` is the viewport width, and
every one is the live build. The long-task and column numbers quoted here were read in the page and are not in any file.

## How it was run

- Cut: `origin/dev` `fbc4e355` (#422). Worktree `practice-walk-17`, branch `feature/practice-walk-17`. The ledger on the cut ended at D-231 and `origin/dev` held no later row, so the new rows start at D-232.
- Live build only: `https://trading.tobytran.dev`, release wave 23 (`f651c3de`; static `last-modified` of `/practice` read as Tue, 03 Nov 2026 09:55:46 GMT), an isolated browser context (`walk17`), 1440 x 900 and
  1180 x 820, signed in as the test user. Clerk asked for the new-device code; I read the one verification email through the `gmail-dashify` search (the code is in the subject line; no message was opened, labelled or
  deleted), typed it into the field, and pasted the email and password from the clipboard, which I cleared afterwards. No credential or code is in any file, screenshot, report or log. One slip: my first "Continue"
  selector matched "Continue with Google" and took the tab to Google's account page; nothing was entered there, I went back to the Clerk form and clicked the exact "Continue".
- The test user began with no thread ("No practice thread yet", "Thread slots 6 of 10", the shared count). Thread 15 (three filters, start Mon 2026-08-03 9:30, 5m, $50,000): scanned at 9:30, jumped to 10:05, scanned
  again, AMZN opened (replay session 37), bought 100 at 284.03, Jump to 11:15, Next open, Exit; Jump to Tue 10:30, the clock run at 1x and 10x for D-217; at 1180 bought 100 at 277.07, Jump, Next open, Exit, scanned
  at Wed 9:30. Thread 17 (one filter, Abnormal volume) was made to try the all-filters-wait refusal and was scanned once. **Both threads are deleted**; the landing is back to "No practice thread yet" and "Thread slots 6
  of 10". Two refused Starts (a market-holiday date at 1440 and at 1180, 422) created nothing. The two tabs already open in the shared browser (a thread and a `/practice/day` page, not mine) were not touched; my own
  tab is closed. No other user's thread was read or moved.
- Probes on every route at both widths (script injected on each navigation): computed type under 11 px (HTML text, and SVG text scaled by its viewBox), clipped text, unnamed controls, document-level horizontal scroll,
  links to `practice/day`, `practice/week`, `practice/order`, the words day, week, swing and session, and long tasks since navigation (`PerformanceObserver`, buffered). Machine load while measuring: 1.7 on 16 cores.
  The clock was driven by `POST /api/desk/replay/threads/15/clock` from the page for the D-217 runs (the same call the buttons use); Jump and Next open went through their buttons.

## Wave-23 verification (D-216, D-218 to D-231)

| ID | Verdict | What was run and the number or sentence that decides it | Screenshots |
|---|---|---|---|
| D-216 | **Holds (1440, 1180)** | A thread with the form's defaults (09:30, Abnormal volume, High volatility, Gap up): Scan now at Mon 2026-08-03 9:30 ran, 31 s, "244 of 250 scanned · 122 matched · showing 30", "Scan 1 · run at Mon 2026-08-03 9:30 AM ET · data through 9:15 AM", the list holds the other two filters' names (SOXS "High volatility · Gap up"), and the Screen names the waiting one: "Abnormal volume lists no names until 10:00 AM ET · at 9:30 AM ET its first bar of the day cannot be read yet". 1180: the same at Wed 2026-08-05 9:30, 30 s, "Scan 3". A thread with only Abnormal volume at 9:30 is refused and the refusal names it ("Abnormal volume waits until 10:00 AM ET · no filter has a bar to read at 9:30 AM ET"), so a scan is refused only when every filter waits. The refusal's dead end is D-234. | `practice-screen-notscanned-1440`, `practice-screen-scanned-0930-1440`, `practice-screen-scanned-0930-wed-1180`, `practice-screen-all-filters-wait-1180` |
| D-218 | **Holds (1440, 1180)** | One open position. 1440: Jump from 10:05 to 11:15, "At" and Equity change together (at 4 s: "At Mon 2026-08-03 · 11:15 AM ET", $50,099.00, Open P/L +$99.00; the first three reads, 0.3 to 2 s, held the old clock, the old time and the old equity together); Next open: at 0.5 s "At Tue 2026-08-04 · 9:30 AM ET", $49,206.00, −$794.00, the clock line the same, still so at 14 s. 1180: Jump to 11:15 at 0.3 s "At Tue 2026-08-04 · 11:15 AM ET", $49,184.00, −$22.00; Next open at 0.5 s "At Wed 2026-08-05 · 9:30 AM ET", $49,652.00, +$446.00. The figure and its time agree at every read. The Jump with a position took 2 to 4 s to land at 1440 and 0.3 s at 1180 (not repeated). The line under the Jump box is D-233. | `practice-thread-after-jump-position-1440`, `practice-thread-after-next-open-1440`, `practice-thread-after-jump-1180`, `practice-thread-after-next-open-1180` |
| D-219 | **Holds (1440, 1180)** | 1440: 100 AMZN bought Mon 10:05:00 AM, sold by Exit at Tue 9:30:00 AM: FILLS lists "Tue 2026-08-04 · 9:30:00 AM ET Sell" above "Mon 2026-08-03 · 10:05:00 AM ET Buy". 1180: four fills in time order (Wed 9:30 Sell, Tue 10:48:34 Buy, Tue 9:30 Sell, Mon 10:05 Buy). `GET …/fills` still returns `day: "2026-08-03"` for the Tuesday sell (the session's day) beside `at: 2026-08-04T13:30:00Z`; the table now prints the ET date of `at`, as the other tables do. | `practice-trades-after-exit-1440`, `practice-trades-after-exit-1180` |
| D-220 | **Holds (1440, 1180)** | `/practice/replay?id=` right after Next open (Tue 2026-08-04 at 1440, Wed 2026-08-05 at 1180, both 9:30:00 AM ET), 1m, 5m and 15m: candles fill the plot from the left edge to the replay time and the time axis carries labels (5m "Aug 4, 05:00 AM … 09:00 AM", 1m "08:15 AM … 09:26 AM", 15m "05:00 AM … 09:00 AM"). No empty plot, no pressed-left bars. | `practice-replay-open-5m-1440`, `practice-replay-open-1m-1440`, `practice-replay-open-15m-1440`, `practice-replay-open-5m-1180`, `practice-replay-open-1m-1180`, `practice-replay-open-15m-1180` |
| D-221 | **Holds (1440, 1180)** | The stamp reads "Scan 1 · run at Mon 2026-08-03 9:30 AM ET · data through 9:15 AM" and "Scan 2 · run at Mon 2026-08-03 10:05 AM ET · data through 9:50 AM"; after Next open the page header says "Screen · Wed 2026-08-05" and "Thread time · Wed 2026-08-05 · 9:30:00 AM ET" while the stamp still reads "Mon 2026-08-03 10:05 AM ET", so the date says how old the scan is; the footer reads "Scanned Wed 2026-08-05 9:30 AM ET" after the new scan. | `practice-screen-scanned-1005-1440`, `practice-screen-stale-after-next-open-1180`, `practice-screen-scanned-0930-wed-1180` |
| D-222 | **Holds (1440, 1180); one caveat** | Every column header is a button. Press once: ascending (`aria-sort="ascending"`, "▲"), twice: descending, a third press: none. Symbol ascending AAOI, APLD, ARM, ASTS, AXTI, descending WULF, TSLL, SPCH, SOXS, SOXL; Filters descending puts "High volatility · Gap up" first; Price at scan and Prev RVOL sort by value; only the pressed header carries `aria-sort`. At 1180 the Filters sort held for 60 s of polling. Caveat: on a reload every header reads `aria-sort="none"` while the rows come in ATR % descending order, so the default order is not marked; in the page that had just run a scan at 1440 I found ATR % marked "▼ descending" before pressing anything. Left as an observation (see "Not filed"). | `practice-screen-sorted-1440`, `practice-screen-sorted-1180` |
| D-223 | **Holds (1440, 1180)** | The Filters column is 162 px at 1440 and at 1180 (131 px at 1180 on the Wed scan, which also carries an EARNINGS column), the text "High volatility · Gap up" shows whole, the table fits the pane (page 1180 of 1180, no sideways scroll). | `practice-screen-scanned-0930-1440`, `practice-screen-scanned-0930-1180`, `practice-screen-scanned-0930-wed-1180` |
| D-224 | **Holds (1440, 1180)** | Band on the landing and the thread screens: "Practice · a pretend account with one clock · nothing here reaches a broker"; band on the replay: "Practice · replay of Wed 2026-08-05 · nothing here reaches a broker"; strip: "Practice trades are simulated at the thread clock · nothing is sent to a broker"; footer: "Practice · past market data". The word probe found no "finished day", "past day", "day list", "Day 1", "days opened" or "week" on any practice route at either width; the one "session" is "VWAP is the session's, from 1-minute bars" (the market session, correct). | `practice-landing-thread-1440`, `practice-thread-summary-1440`, `practice-replay-pass-1440`, `practice-landing-thread-1180`, `practice-replay-pass-1180` |
| D-225 | **Holds (1440, 1180)** | New thread, "Start and chart": "The Desk has recorded 6 finished days of its universe so far · the start is three months back"; the sentence about 20 days is gone. `/practice/replay` with no id: "No practice thread selected · Pick a thread, then open a name from its Screen." at both widths. "6 finished days of its universe" is a fact about the recorded data and is left (see "Not filed"). | `practice-newthread-1440`, `practice-replay-bare-1440`, `practice-replay-bare-1180` |
| D-226 | **Holds (1440, 1180); no pre-fix thread to see** | A thread made on Tue 2026-11-03 with Start date 2026-08-03 is "Freestyle · Aug 3" on the landing ("Started Aug 3"), the thread header and Trades; a second thread with the same start day was "Freestyle · Aug 3 (2)", so two threads are told apart. The test user had no thread from before the fix, so the known residual (old names keep "Nov 3") was not seen. | `practice-landing-thread-1440`, `practice-landing-thread-1180`, `practice-thread-summary-1440` |
| D-227 | **Holds (1440, 1180)** | Portfolio header "PRICE AT THREAD TIME" (TICKER, SIDE, SHARES, AVG COST, PRICE AT THREAD TIME, GAIN/LOSS, HELD FOR, WORKING ORDERS); the footer says "Each is priced at the thread's time" and the P/L card "priced at 9:30 AM ET". | `practice-portfolio-1440`, `practice-portfolio-1180` |
| D-228 | **Holds (1440, 1180)** | With one open position Trades reads "1 open position · not in this balance until you close it · See the Portfolio" and the chart note "open positions are not in it until you close them" (the plural "them" there is about positions in general). Two open positions were not tried. | `practice-trades-open-position-1440`, `practice-trades-open-position-1180` |
| D-229 | **Holds (1440, 1180)** | Start date typed as 2026-12-25 (and 2030-01-01 at 1440): "No replay for a date after today · pick Mon 2026-11-02 or earlier" at both widths. Today's date (2026-11-03) says "This session isn't finished yet · replay opens at 4:15 PM ET", which is true for today (left, see "Not filed"). | `newthread-future-date-1440` |
| D-230 | **Holds (1440, 1180)** | Start date 2026-07-03 (Friday, market closed) with filters ticked: Start thread answers 422 and "No trading on Fri 2026-07-03 · the market was closed" is a `role="alert"` paragraph 4 px under the date field (`aria-describedby` and `aria-invalid` set on the field), in view without scrolling at 1440 (y 470 of 900) and 1180 (y 430 of 820); the weekend date still shows its sentence in the footer. | `newthread-holiday-refusal-1440`, `newthread-holiday-refusal-1180` |
| D-231 | **Holds (1440, 1180)** | Pixel scan of the chart canvas for the VWAP colour (255, 176, 32). Mon 10:05 5m: the line starts at the 9:30 open (x 631 to 684 of 778), nothing across the pre-market. Zoomed out over two sessions (Tue 10:30, 5m, 1440): Monday's line ends at x 36 and Tuesday's starts at x 474, no orange pixel between them; on the 1m chart (Tue 10:30) the line starts at the 9:30 open and nothing is drawn across the pre-market to its left. At 1180 (Wed 9:30, 5m, zoomed out): Tuesday's line ends at x 88 and there is none yet on Wednesday, with "VWAP —" and "Warming up" at the open. | `practice-replay-amzn-1005-1440`, `practice-replay-vwap-zoomout-5m-1440`, `practice-replay-vwap-zoomout-1m-1440`, `practice-replay-vwap-zoomout-5m-1180` |

## D-217 re-measured (still Open)

`/practice/replay?id=` AMZN, 1m, tape "All", `PerformanceObserver` long tasks, machine load 1.7 on 16 cores, one window. Each run: 5 s idle, then the clock run at 1x or 10x. "Bar" is the "source bars" count going up by one.

| Width and speed | Window | Idle 5 s | New bars | Long tasks at a bar | Long tasks not at a bar |
|---|---|---|---|---|---|
| 1440, 1x | 68 s | 0 | 1 | 85 ms | none |
| 1440, 1x | 122 s | 0 | 2 | none, then 69 ms | 449 ms and 77 ms together, 3 s before the first bar |
| 1440, 1x | 150 s | 0 | 2 | 67 ms and 92 ms together, then 70 ms | 59 ms at 19 s |
| 1440, 10x | 40 s | 0 | 6 | 71, 82, 87, 62, 64, 64 ms (430 ms) | none |
| 1180, 1x | 122 s | 0 | 2 | 88 ms, 87 ms | 176 ms and 71 ms together, 12 s after the second bar |
| 1180, 10x | 40 s | 0 | 7 | 68, 70, 63, 75, 58, 72 ms (406 ms), one bar none | none |

Of 20 new bars, 18 cost a long task of 58 to 92 ms (walk 16: 74 to 102 ms at 1440, 50 to 94 ms at 1180). The polls cost none. D-212's own criterion, no single task of 50 ms or more at a new bar, is not met; the row stays Open
and carries these numbers. The tasks not tied to a bar are one-offs: the 449 ms one (the longest in this walk) did not recur in the 150 s window, and the 1x and 10x runs of 40 s showed none; I did not trace them. The 10x
runs here used one window; walk 16's 10x runs had a second window open.

## The freestyle path, again

Nothing new broke on the path the wave touched: a thread is made, scanned at its start, traded, jumped and read; a position survives Jump and Next open into Portfolio and Trades (Mon 10:05 buy, Tue 9:30 sell, Tue
10:48:34 buy, Wed 9:30 sell), and every figure that carries a time agrees with the clock. Timings seen: first scan at 9:30 31 s (1440) and 30 s (1180), scan at 10:05 46 s; Next open 0.5 s; Exit closes at once. The
three problems on the path are D-233 (a stale "Jumped to" line), D-234 (the all-filters-wait dead end) and D-236 (the EARNINGS spelling), plus the Screen's load cost, D-235.

## Fresh full pass (1440 and 1180)

Routes: `/`, `/today` (both replace to `/practice` while Backtest is the stored mode, so they were read with `?mode=fundamental`), `/screener`, `/screener/filters`, `/watchlists`, `/strategies`, `/strategies/library`,
`/alerts`, `/technicals`, `/stocks`, `/futures`, `/paper`, `/backtests`, `/holdings`, `/covered-calls`, `/ask`, `/settings`, `/feedback`, `/more`, `/practice`, and the four practice routes with no id (each says "No practice
thread selected · Pick a thread to open its Screen/Summary" or, for replay, "Pick a thread, then open a name from its Screen", and lists the thread; `/practice/journal` with no id replaces to `/practice`) and with a thread
(`/practice/screen?thread=`, `/practice/thread?id=` Summary and Portfolio, `/practice/journal?thread=`, `/practice/replay?id=`).

| Probe | 1440 | 1180 |
|---|---|---|
| Computed type under 11 px, HTML and SVG | none on any route | none on any route |
| Unnamed controls | none | none |
| Links to `practice/day`, `practice/week`, `practice/order` | none | none |
| Document-level horizontal scroll | none | **25 px on nine routes** (`/`, `/today`, `/stocks`, `/holdings`, `/covered-calls`, `/ask`, `/settings`, `/feedback`, `/more`): D-232 |
| Long tasks on load | `/practice/screen?thread=` three (65, 72, 68 ms): D-235; every other route none | `/practice/screen?thread=` two loads, two and four tasks (56 to 79 ms): D-235; `/practice/replay?id=` one of 89 ms; every other route none |
| Clipped text | only visually hidden labels ("Read-only", "Search presets", "Default mode", "Actions", "Same price", "Down-tick") and `/strategies/library` "Futures overnight-range break" by 2 px (seen in wave 16 and left) | only visually hidden labels ("Actions", "Up-tick") |
| The words day, week, swing, session | only where they are right: "52-week breakout", "New 20-day high" and "SESSION AND RUN ON" (filter names and headings), "Swing · 8 sample symbols" on `/backtests` and "FUTURES · SWING" and "CME session" on `/futures` (sample and spec screens), "your holdings in the next two weeks" on Today; on the practice routes only "VWAP is the session's" | the same |

## New defects

Rows are in `DEFECTS.md` (D-232 to D-236, status Open); the evidence is in the rows. In short:

- **P2 D-232** Fundamental top bar at 1180: the 231 px "Quotes paused · last update 7 hr ago" pill (kept whole by D-211's `flex-shrink: 0`) makes the bar 26 px too wide; the avatar button sits at x 1178 to 1206 and the page scrolls sideways on nine routes.
- **P3 D-233** the "Jumped to …" line under the Jump box stays after Next open and names a time that is no longer the clock.
- **P3 D-234** when every filter waits, Try again re-posts and gets 409 again, the sentence ends in a dangling "·", and the Screen does not say that time moves on the Summary.
- **P3 D-235** a scanned Screen costs two to four long tasks of 56 to 79 ms to load (and the 1180 replay one of 89 ms).
- **P3 D-236** the EARNINGS column prints "None" for some names and "—" for the rest.

## Not filed (seen, judged not defects, or owned by something else)

- "The Desk has recorded 6 finished days of its universe so far" (New thread form) and "This session isn't finished yet · replay opens at 4:15 PM ET" (Start date set to today): both are facts about recorded data or about today's market session, and true; the D-225 and D-229 sentences about 20 days and future dates are gone.
- The Screen's default order is not marked consistently (D-222's caveat): `aria-sort="none"` on every header after a reload, ATR % marked "▼ descending" in a page that had just scanned. The sort itself works; whether the default should always be marked is the owner's call.
- The Screen carries hidden columns (Prev close, Prev volume, Prev gap %, Prev vs VWAP %, Since; 0 px wide at both widths). Not visible at 1440 or 1180, so not filed.
- Console: the 422 from a Start on a market-holiday date (expected) and the 409 from a refused scan (D-234); one warning on a few pages was not opened.
- `Thread slots 6 of 10` with no thread of the user's own: the count is shared across users (known since wave 15).

## Not exercised

- Limit, Stop and Stop-limit tickets, Set stop, Add note, the Chart menu toggles, Full screen, the Edit plan form, Close thread, a Play at 1x through the Summary button (the clock was driven by the same `POST …/clock` the buttons use), 10x with a second window, the Sell side of D-214, a
  winning trade, two open positions (the plural of D-228), a thread of 10 slots, a thread made before the D-226 fix, and any thread of another user.
- The market-open top bar and the "Market closed · showing last close" pill (the market was in pre-market all walk), so D-211's own sentence was not re-read at 1180.
