# Walkthrough wave 15: the wave-18 fixes on the live Desk (`5cb12632`) and a fresh pass over `dev` (`1d411c59`)

Date: 2026-11-03. New defects D-212 to D-215 (4: P0 0, P1 0, P2 0, P3 4). Nothing was fixed in this lane.
Wave-18 verification (D-206 to D-211, #404): five hold on the live screens they name. D-206 holds for what its row names (idle polls, a 600 ms task per new bar) but a busy tape at 10x
still costs long tasks (D-212). D-207 is proven on the rig only. No `Fixed` row was touched. The newly landed behaviour (#405, #406, #407, #401, #410) works as described.

Screenshots are not in the repository; the names below are files in the run's `walk-15/` directory (outside the repo, next to the run's copy of this report). A name ending `-1440`
or `-1180` is the viewport width; `prod-*` were taken on the live build, `rig-*` and the numbered ones on the local rig. Each numbered rig screenshot has a `.json` with the probe facts (clipped
text, type under 11 px including SVG text, unnamed controls, banned wording, SVG labels that overlap or are cut). `walk-15/evidence/` holds the throwaway specs, the Playwright config, the run
script, the run logs and the sampling outputs. `walk-15/notes-live.md` is the running log of the live walk. None of it is in the commit.

## How it was run

- Cut: `origin/dev` `1d411c59` (#410). Worktree `practice-walk-15`, branch `feature/practice-walk-15`. `origin/dev` has since moved to `212e2144` (freestyle step 3); this report is about
  `1d411c59`. `DEFECTS.md` on the cut ended at D-211; `origin/dev` held no later row, so the new rows start at D-212.
- Same code on the rig and on the live build: all 17 script names on the live `/practice` page exist in this cut's `out/_next/static`. Live is built from `3ac83bb8`, which already holds #401
  and #405 to #408; the only commit after it on this cut is #410 (backend, contracts v2, migration 0021), so #410 is exercised on the rig only and the browser code is identical.
- Live build: an isolated browser context (`walk15`), 1440 x 900 and 1180 x 820, signed in as the test user. Clerk asked for the new-device code; I read the one verification email through the
  `gmail-dashify` tool (search result only, no other message opened), typed the code into the field and used the clipboard for the email and password, so no credential is in any file, screenshot,
  report or log. The test user has no practice threads of its own (the landing says "No practice thread yet"; the "Day-trade slots 5 of 10" counter is the shared one across users). I created two
  day threads for it (ids 10 and 11), traded, skipped a day, jumped, and **deleted both**; the landing is back to "No practice thread yet" and "5 of 10". Nothing of the owner's was touched, and no
  clock on a thread that is not mine was moved.
- Rig: the Desk e2e stack through `tests/e2e/run.py --browser -- …` ("Without Docker" in `e2e/README.md`) on 18070/18071, a disposable `desk_e2e_<hex>` database in another session's tmpfs
  `desk-test-postgres` container, `--output=/tmp/w15/pw-<tag>`, one worker per run; seven runs (A to G). Throwaway specs `zz-w15-*` (wave 14's `01`, `02`, `03`, `12`, `14`, `19`, `20`, `25` re-pointed,
  plus `00`, `04`, `05`) and the repo's own `practice-tabs`, `topbar-pills`, `sample-type-floor`, `practice-jump` and `practice-chart-refresh` specs. Everything throwaway was removed from the worktree
  before the commit.
- Probe totals over the 86 rig snapshots: banned wording 0, document-level horizontal scroll 0, computed type under 11 px 0, SVG text under 11 px 0, unnamed controls 0. The only `clipped` entry
  is the 1 px visually hidden description span of the disabled Day list tab (D-207's accessible description). On the live build every route below measured no text under 11 px and no
  document-level horizontal scroll at both widths.

## Wave-18 verification (D-206 to D-211)

| ID | Verdict | Route, steps and the number that decides it | Screenshots |
|---|---|---|---|
| D-206 | **Fixed for what the row names; one neighbour filed (D-212)** | Live `/practice/replay?id=` (AMZN, 1m, 6,000 to 6,020 source bars), clock paused, 5 s: 1m 0 long tasks (70 ms busy at 1440, 209 at 1180); 5m 0 long tasks (40 ms, 50 ms) (was 200 ms per idle 5m poll). New bars (10x, one window): AMZN 1440, 26 tasks of 51 to 96 ms in 40 s, six bars (was 631 to 724 ms per bar); 1180, 14 tasks of 51 to 91 ms. SQQQ with the tape on "All": 1440 up to 317 ms, 1180 up to 128 ms; on "Big only" at most 66 ms. Rig, the repo's `practice-chart-refresh.spec.ts`: green at both widths, no long task at 1m, 5m, 15m or at 10x in two windows (busy 14 to 110 ms per step, 1,056 to 1,152 ms per 40 s of 10x). The fix note's "no single task reaches 50 ms" does not hold on a busy live tape. | `prod-replay-5m-1440`, `prod-replay-5m-1180`, `prod-replay-10x-1440`, `prod-replay-10x-1180`, `prod-replay-sqqq-1180` |
| D-207 | **Fixed (rig only)** | Rig, a fresh day thread before its first day opens, 1440 and 1180: the Day list tab is `aria-disabled="true"`, `title` and accessible description "No day is open · start the next day first", Portfolio stays enabled; `practice-tabs.spec.ts` "a day thread with no day open" green at both widths. Live: not reachable. The modal waited 34 to 44 s for Day 1's list, so the thread page already had its day open (all four tabs enabled, correct) and Skip day opens Day 2 at once. The swing Board half cannot be exercised any more (swing creation is closed, #405). | `rig-d207-summary-no-day-1440`, `rig-d207-summary-no-day-1180`, `05-thread-summary-before-day-1440` |
| D-208 | **Fixed (live)** | Live `/today` right rail at 1440: "Sun 7:00 PM", "Sun 6:00 PM", "Fri 11:24 PM", "Fri 10:22 PM" … (`created_at` 2026-11-01 and 2026-10-31); the bell's list at 1440 and 1180 shows the same stamps. | `prod-today-1440`, `prod-bell-open-1440`, `prod-bell-open-1180` |
| D-209 | **Fixed (live)** | Live `/futures` (no broker) at 1440 and 1180: the chart header is "1D CHART · /MES" with "Unavailable"; no "as of" anywhere on the page. | `prod-futures-1440`, `prod-futures-1180` |
| D-210 | **Fixed (live and rig)** | Live `/paper`, `/backtests`, `/ask` at 1440 and 1180: smallest computed font size 11 px; the markers ("Illustrative", "Sample records", "Sample only", "Demo configuration", "Not a strategy result", "Synthetic chart", "Annual returns", "Sample history", "Illustrative chat", "Not quotes", "Not saved") 11 px; the chart values "+3.2%" and "2018" 12 px. `sample-type-floor.spec.ts` 6/6 green on the rig. | `prod-d210-paper-1440`, `prod-d210-backtests-1180`, `prod-d210-ask-1180` |
| D-211 | **Fixed (live closed; rig open and closed)** | Live Fundamental `/stocks`, `/holdings`, `/covered-calls`, `/ask` at 1180, market closed: "Market closed · showing last close" is 195 px of text in a 195 px box (`scrollWidth` = `clientWidth`), whole on all four routes; the same at 1440. The market-open state cannot be reached live (Mon 11 PM ET); `topbar-pills.spec.ts` (Fundamental and Technical, closed, open, quotes paused) is 10/10 green at both widths. | `prod-stocks-1180`, `prod-holdings-1180`, `prod-covered-calls-1180`, `prod-ask-1180` |

## What this release changed

| Change | Result | Evidence |
|---|---|---|
| #407 Portfolio, held names only | **Works.** Bought 100 AMZN on live, then Portfolio: columns TICKER, LAST, CHANGE, CHANGE %, POSITION, AVG PRICE, VALUE, UNREALIZED P/L, ACTIONS (no Realized, no Total P/L); Unrealized P/L present at 1440 (pane 1374 of 1374) and 1180 (1114 of 1114); footer "Open P/L $0.00 · 1 open · as of 10:20 AM ET". Exit closed it: "No open positions", with "closed trades are in Trades"; Trades lists the Sell and the Buy. Same on the rig (TSLA). | `prod-portfolio-open-1440`, `prod-portfolio-open-1180`, `prod-portfolio-exit-click-1180`, `prod-trades-after-exit-1440`, `rig-portfolio-open-1180`, `rig-portfolio-after-exit-1440` |
| #406 no global Trades tab, bare journal | **Works.** The Backtest top bar reads "Family Desk, Practice" only; `/practice/journal` with no `?thread=` replaces to `/practice` (live and rig); the thread's own Trades tab opens `/practice/journal?thread=<id>` with balance, results and fills. | `prod-trades-after-exit-1180`, `prod-trades-day2-1440`, `rig-trades-1440` |
| #405 swing creation closed, past Jump refused | **Works.** The New plan modal has no Day/Swing choice (only filters, days, list time, list size, interval, start time). A past Jump is refused before sending: Jump is disabled and the form says "That time is not ahead of the clock · Jump goes forward only". Straight to the API: `POST …/clock` with a past `to` answers 422 "Time only moves forward · that time has passed"; `POST /threads` with `mode: "swing"` answers 409 "Swing threads are closed · start a day thread" (live and rig). | `prod-newplan-open-1180`, `prod-jump-past-before-1440`, `rig-jump-past-1440`, `rig-jump-past-1180` |
| #401 H1 archive, #410 freestyle contracts and migration 0021 | **Nothing different on screen** (#401 is in the live build; #410 is rig-only: every rig run above is on it and showed no change on screen). Live day lists read "List built at 10:00 AM ET from data through 9:45 AM", bars "Alpaca SIP · past days", the 1m replay chart 6,000 source bars, and no 503, "preparing" state or new freshness word appeared. Slow: Start 20-day practice stayed on "Starting…" for 34 s and 44 s (two threads), and Skip day took 47 s with its own line "Skipping to the next day. This can take up to a minute."; both finished with no error. | `prod-thread-start-wait-1180`, `prod-skipday-running-1440`, `prod-skipday-done-1440` |

## New defects

Rows are in `DEFECTS.md` (D-212 to D-215, status Open). Evidence in short:

- **D-212 (P3), a busy tape at 10x still costs long tasks.** The numbers are in the D-206 row above and in the ledger row. The same name and window with the tape on "Big only" costs about a third as
  much, so the tape's 500-row panel is the place to look. The rig cannot see it (its stub tape is quiet), which is why the repo's spec is green. The numbers move by tens of ms with the machine's load.
- **D-213 (P3), `/practice/day?id=abc` opens the open day.** Live with Day 2 open: `?id=abc`, `?id=0` and `?id=` each land on `/practice/day?id=28`; `?id=99999` says not found. The notice for a given
  bad id is replaced once the open-day read arrives. `prod-route-practice-day-id-abc-1440`.
- **D-214 (P3), the 1180 ticket.** The Buy under the chart stays live when the order exceeds buying power, and its refusal prints under Quantity and again under the order line (two different costs
  when the price moved). 1440 has one disabled Buy and one sentence. `rig-ticket-second-buy-drawer-closed-1180`, `rig-ticket-after-first-buy-1180`, `20-replay-long-1m-1180`.
- **D-215 (P3), "of 1 days opened".** The Trades tab's tile does not take the singular while the header of the same screen says "1 day practiced". `rig-days-opened-tile-1440`.

## Not filed (seen, judged not defects, or owned by something else)

- Two repo specs are red on this cut at both widths, for reasons that are the code's own changes, not defects on screen: `practice-tabs.spec.ts:50` expects "TSLA" in the thread Portfolio after only
  opening the name (#407 shows held names only, so it reads "No open positions"), and `practice-tabs.spec.ts:133` builds a swing thread (#405: 409). Neither was updated with its change. The backend
  logged `StaleDataError` on `practice_plans` from `_prep_in_background` while a spec's database reset ran; it only appeared around resets.
- Choosing the Limit order type shows "Limit price: a number above 0" in red on the untouched field and the order line reads "Buy 100 TSLA · Limit · limit —"; wave 14 saw the same and no row exists.
  A judgement call, left to the owner.
- At 1180 the top bar shows the short "Closed" pill next to "Market closed · showing last close"; `marketPillShort` makes that on purpose (D-211 only asked for the sentence to be whole).
- The "Day-trade slots 5 of 10" counter counts every user's slots (the route's own docstring), so a user with no thread sees 5 used.
- AAPL's quote header (328.81, after hours) against the last 15m candle (339.11, 3:45 PM): the same quote-versus-regular-session gap wave 14 recorded for SGML.
- A Skip day or Start that takes 34 to 47 s is long, but the screen says so and it finishes; the "Still starting · …" slow-start line was not seen in the first 6 s of the modal and was not waited for.

## Clean (looked at, nothing to file)

Live at 1440 and 1180, no text under 11 px, no document-level horizontal scroll, no console or HTTP error: `/`, `/today`, `/screener`, `/screener/filters`, `/watchlists`, `/strategies`, `/alerts`,
`/technicals`, `/settings`, `/more`, `/feedback`, `/stocks`, `/holdings`, `/covered-calls`, `/paper`, `/backtests`, `/ask`, `/futures`. Practice live: `/practice` landing (empty and with a thread row:
Start Trading and Delete, columns drop Last day at 1180 with no horizontal scroll), New plan (empty, ticked, window error, 1180 width), the thread Summary, Portfolio, Day list (columns, Peek at both
widths, Start Trading, Delete plan confirm and delete), Trades, `/practice/replay` (fresh load, 1m/5m, wheel zoom, double-click fit, Full screen, the 1180 toolbar), `/practice/week` for a day thread
("Weekly reviews are for swing threads…"), `/practice/order` 404, and the not-found notices for a thread, a session and a day id that do not exist. Rig at both widths: landing, modal, Summary, day list,
rescan, Peek, replay intervals, ticket types, drawer at 1180, axis and Full screen specs (`19`, `20`, `25`).

## Not exercised

- A live swing thread, the Week review and the swing Board: swing creation is closed (#405) and the test user has none.
- The market-open top bar on the live build (the market was closed); the rig specs cover it.
- A live Skip day or Jump across several days beyond Day 2, a live 1x run for a minute, and two windows on the live chart.
- `origin/dev` `212e2144` (freestyle step 3, thread clock and persistent positions): it landed after this cut.
