# Walkthrough wave 16: the freestyle cutover walked live on wave 22 (`c28e9799`), and a fresh pass

Date: 2026-11-03. New defects D-216 to D-231 (16: P0 0, P1 0, P2 4, P3 12). Nothing was fixed in this lane.
Wave-19 verification (D-212 to D-215, #419): D-214 and D-215 hold on the live screens they name. D-212 holds for the polls and for 5m and 15m, but every new 1m bar still costs one long task
(D-217). D-213 cannot be tested as worded: `/practice/day` is gone, a 404 by design. No `Fixed` row was touched. The freestyle cutover (#411, #414, #416) works end to end on live: a thread is made,
scanned, traded, jumped and read, a position survives Jump and Next open into the Portfolio and the journal. The four P2 rows are all on that path: the first scan at the default start (D-216), a stale "At" time
on the equity card (D-218), a wrong ET date on a fill (D-219), and an empty chart at every open (D-220).

Screenshots are not in the repository; the names below are files in the run's `walk-16/` directory (outside the repo, next to the run's copy of this report). A name ending `-1440` or `-1180` is the
viewport width, and every one is the live build. `walk-16/probes-live.json` holds the measured numbers (long tasks, column widths, route probes, the fills API body). None of it is in the commit.

## How it was run

- Cut: `origin/dev` `f14b6086` (#419). Worktree `practice-walk-16`, branch `feature/practice-walk-16`. The ledger on the cut ended at D-215 and `origin/dev` held no later row, so the new rows start at D-216.
- Live build only: `https://trading.tobytran.dev`, release wave 22 (main `c28e9799`, built from dev `f14b6086`), an isolated browser context (`walk16`), 1440 x 900 and 1180 x 820, signed in as the test user. Clerk asked for
  the new-device code; I read the one verification email through the `gmail-dashify` search (the code is in the subject line; no message was opened, labelled or deleted), typed the code into the field and pasted
  the email and password from the clipboard, which I cleared afterwards. No credential is in any file, screenshot, report or log. No second challenge appeared, so nothing is rig-only: every verdict below is live.
- The test user began with no thread ("No practice thread yet", "Thread slots 6 of 10", the shared count). I made one (id 12, three filters, start 2026-08-03 9:30, 5m), scanned, bought and sold AMZN, jumped,
  used Next open twice and **deleted it**; the landing is back to "No practice thread yet" and "Thread slots 6 of 10". One more Start (a market-holiday date) was refused by the server and created nothing. The two
  tabs that were already open in the shared browser (a thread and a `/practice/day` page, not mine) were not touched. No other user's thread was read or moved.
- Probes on every route at both widths: computed type under 11 px (HTML and SVG text), clipped text, unnamed controls, document-level horizontal scroll, links to `practice/day`, `practice/week`, `practice/order`,
  the words day, week, swing and session, and long tasks (`PerformanceObserver`). Machine load while measuring: 2.4 on 16 cores.

## Wave-19 verification (D-212 to D-215)

| ID | Verdict | Route, steps and the number that decides it | Screenshots |
|---|---|---|---|
| D-212 | **Partly holds; D-217 filed** | `/practice/replay?id=` AMZN, 6,035 to 6,059 source bars, tape "All". Idle 5 s: 1m, 5m and 15m 0 long tasks at 1440 and 1180. One new bar: 5m 0 at 1440 (65 ms at 1180), 15m 0, **1m one task of 74 to 102 ms at 1440 (87, 83, 84, 92, 95, 96, 102, 74) and 50 to 94 ms at 1180 (94, 83, 82+65, 64, 50)**. 10x with a second window, 40 s, six bars: 1440 six tasks of 57 to 110 ms (445 ms); 1180 ten tasks of 52 to 90 ms (674 ms); the other window none. Before: 26 tasks of 51 to 96 ms in 40 s. The count fell by two thirds; "a new bar costs no long task" does not hold. | `probes-live.json` (no screenshot: numbers) |
| D-213 | **Cannot hold as worded; the new routes are clean** | `/practice/day`, `/practice/day?id=14`, `/practice/day?id=abc`, `/practice/week`, `/practice/order` are 404 "This page does not exist" (the brief lists them as correct), so a deep link cannot land on the screen. What the row was about holds on the new routes: `/practice/thread?id=`, `/practice/screen?thread=`, `/practice/journal?thread=` and `/practice/replay?id=` with an empty, `0`, `-1`, `1.5`, `12abc`, `abc` or `99999` id all say "That practice thread was not found" (session for replay), never another thread; `/practice/journal` with no `?thread=` replaces to `/practice`; `/practice`, `/practice/screen`, `/practice/thread` and `/practice/replay` with no id say "No practice thread selected". | `prod-63-practice-day-404-1440`, `prod-62-replay-no-thread-1440` |
| D-214 | **Holds (live, 1180)** | `/practice/replay?id=` AMZN 5m at 1180, a 100-share long held ($49,031 balance, buying power $21,422), a second Buy of 100 ($27,609): the chart's Buy is disabled (opacity 0.6, `title` carries the sentence) and the drawer's Buy is disabled; the sentence "Exceeds buying power · this order costs $27,609, buying power is $21,422" appears once on the page. At 1440 the same single sentence and one dimmed Buy. Not exercised: the Sell side beyond closing the position. | `prod-37-drawer-open-1180`, `prod-36-after-chart-buy-drawer-shut-1180`, `prod-57-replay-at-open-5m-1440` |
| D-215 | **Holds (live)** | A closed trade: Trades "WIN RATE 0% · 0 of 1 trade", "ET DATES TRADED 1 · with a closed trade"; Summary "CLOSED TRADES 1 · LOSSES 1". No "days opened" tile and no "days" count anywhere on the landing, Summary, Portfolio, Screen, Trades or replay (the Day list no longer exists). "1 of 1 trade" itself needs a winning trade and was not reached; the singular in "0 of 1 trade" is right. A neighbour, "until you close them" for one position, is D-228. | `prod-27-trades-after-exit-1440-tall`, `prod-28-summary-after-exit-1440` |

## The freestyle cutover, live

| Surface | Result |
|---|---|
| `/practice` landing and New thread | Landing: "A thread is a pretend account with one clock. Move time forward and your positions stay open, priced at the new time", "Thread slots 6 of 10", New thread; with a thread: THREAD, BALANCE, OPEN POSITIONS, THREAD TIME, LAST ACTIVITY (dropped at 1180, no horizontal scroll), Open Screen and Delete. New thread: Starting balance (whole dollars 1,000 to 10,000,000), ten filters, up to three (the fourth box is disabled), Start date (min 2016-01-04, max 2026-11-02), Start time (ET) (4:00 AM to 8:00 PM), Screen size (20 to 49), Chart interval 1m/5m/15m, Risk rules (Trade only on a signal, Max loss 1 to 100,000, Max trades), Plan note (500). **No Swing or Day choice.** Created in 2 s. Sentences seen: "Pick at least one filter to start a thread", weekend "No trading on Sat 2026-08-01 · pick a weekday", "Replay goes back to Jan 4, 2016", "Pick a trading day and a time between 4:00 AM and 8:00 PM ET". Problems: D-225, D-229, D-230. |
| `/practice/screen?thread=` | Opens as "Not scanned yet" until Scan now; a scan at 10:05 took about 39 s ("Scanning at 10:05 AM ET · applying your filters to 250 names…"), then "244 of 250 scanned · 125 matched · showing 30", skeleton pills in the now columns for a few seconds, settled by about 10 s at 1440 (still pills in Price now at 1180 after 6 s). 12 columns fill the pane at both widths (1,088 and 1,108 px), no horizontal scroll; Open goes to the replay in 5.7 s, Peek opens a labelled panel (Up to the scan, Daily), Star is there. Problems: D-216, D-221, D-222, D-223. |
| Thread Summary | Equity, Trade (Open Screen, Delete thread), the clock (Play, 1x/2x/5x/10x, Next open, Date and Time, Jump), buying power, Results by date, Trades so far. A past Jump is refused in plain words ("That time is not ahead of the clock · Jump goes forward only"), a Jump past the data likewise ("The data reaches Mon 2026-11-02 · 8:00 PM ET · pick an earlier time"); a forward Jump to 10:05 took 0.5 s; Next open took 4.9 s with a position open and says "1 open position stays open and is priced at the new time". Problems: D-218, D-224, D-226. |
| Portfolio | Held names only; columns TICKER, SIDE, SHARES, AVG COST, PRICE AT T, GAIN/LOSS, HELD FOR, WORKING ORDERS, Exit; no Realized or Total P/L. A position bought Mon 10:29 AM showed on Tue 9:30 AM at 276.09 (−$969.00, held 23h). Exit closes at once ("No open positions · … closed trades are in Trades"). Problem: D-227. |
| Trades (journal) | `/practice/journal?thread=` is the thread's own Trades tab: balance, balance and result charts by ET date (no SVG text under 11 px at 1180), SUMMARY SO FAR, FILLS. Its Thread plan and Close thread drawers at 1180 explain that closing does not sell open positions. Problems: D-219, D-228. |
| Replay | Fresh load, 1m/5m/15m, wheel zoom (the axis changes), double-click returns to the default view, Full screen (778 to 1,058 px wide at 1440, Escape restores), Chart menu (Candles, Hollow, Bars, Line, Area; VWAP, EMA 9, EMA 21, Volume; Prior close, Session high and low, Opening range), the drawer at 1180 (Practice and Signals tabs), Market Buy and Close position. Persistent positions work: the Marks list shows Mon's buy and Tue's buy and exit; the position card reads "since Tue 2026-08-04 · 9:30 AM ET". Problems: D-217, D-220, D-231. |
| Cutover scars | No link to `practice/day`, `practice/week` or `practice/order` on any route; no tab to a missing route (the thread tabs are Summary, Portfolio, Screen, Trades); the top bar mode follows the route: `/` and `/today` with Backtest stored replace to `/practice`, `/today?mode=fundamental` is Fundamental, `/practice?mode=technical` stays Backtest, `/screener` is Technical, `/settings`, `/feedback` and `/more` keep the stored mode. Copy that still speaks of days: D-224, D-225. |

## Fresh full pass (1440 and 1180)

`/today` (right rail "Mon 8:00 PM"; the bell lists "Sun 7:00 PM", "Fri 11:24 PM"), `/screener`, `/screener/filters` (Average volume days "5 to 60 · blank is 20"), `/watchlists`, `/strategies` (new, library),
`/alerts` (new), `/technicals`, `/stocks`, `/futures` (specs, read), `/paper`, `/backtests`, `/holdings`, `/covered-calls`, `/ask`, `/settings`, `/feedback` (new), `/more`: no computed type under 11 px (HTML or SVG),
no document-level horizontal scroll, no link to a retired route, no unnamed control (the "Copy" buttons the probe flagged sit in a closed "View JSON" details), no long task on load but one 63 ms task on `/technicals`
at 1440. Seen and left: `/strategies/library` clips "Futures overnight-range break" by 2 px with an ellipsis at both widths.

## New defects

Rows are in `DEFECTS.md` (D-216 to D-231, status Open); the evidence is in the rows. In short:

- **P2 D-216** first scan of a new thread is refused at the form's default start: Abnormal volume cannot run at 9:30 and the other two filters' names are lost.
- **P2 D-218** the equity card's "At" time stays on the old clock after Jump or Next open.
- **P2 D-219** a fill's ET DATE after a jump is the old session day: the sell reads Mon 9:30 AM above the Mon 10:29 AM buy.
- **P2 D-220** the replay chart at the open (the first view after every Next open) shows the last bars at the left edge of an empty plot with no time labels.
- **P3 D-217** (D-212 not closed), **D-221** scan stamp without a date, **D-222** no sort, **D-223** Filters column hidden, **D-224** "a finished day" strip, **D-225** 20-day and day-list leftovers,
  **D-226** thread name carries the creation date, **D-227** "PRICE AT T", **D-228** "close them", **D-229** future-date sentence, **D-230** holiday refusal below the fold, **D-231** straight VWAP segment.

## Not filed (seen, judged not defects, or owned by something else)

- "Thread slots 6 of 10" with no thread of the user's own: the count is shared across users (known since wave 15).
- `/practice/day`, `/practice/week`, `/practice/order` 404 (listed as correct). Their body says "the journal now opens from a practice thread", a sentence about a different route; left as the generic not-found text.
- Console: one 409 on `screen/rescan` (D-216) and one 422 on `POST /threads` (D-230); two preload warnings for CSS chunks on the replay page.
- Peek and Open work, but a row's "Price now" and "Vs prev close % now" stayed as skeleton pills for the 6 s the 1180 screenshot waited while RVOL and Change % had values; they settled at 1440 within 10 s. Not timed further.
- "VS PREV CLOSE % NOW" and "CHANGE % NOW" differ by a few hundredths on the same row (SQQQ −1.55% and −1.57%); two columns that look the same. Not investigated.

## Not exercised

- Limit, Stop and Stop-limit tickets, Set stop, Add note, the Chart menu toggles, Full screen at 1180, the Edit plan form, Close thread, a Play at 1x through the UI (the clock was driven by the same `POST …/clock` the buttons use), 10x without a second window,
  the Sell side of D-214, a winning trade ("1 of 1 trade"), a thread with 10 slots used, and any thread of another user.
- The market-open top bar (the market was closed all walk).
