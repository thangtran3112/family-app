# Walkthrough wave 22: D-243, D-244 and D-245 re-walked live on wave 31, and one new row

Date: 2026-11-03. New defect: **D-246** (Watchlists: a futures symbol stays pending forever). Two rows close on live numbers (**D-244** Fixed, **D-245** Fixed). **D-243 stays Open**: the 1180 and 1300 panes are fixed, the 1440 pane still scrolls 19 px sideways. This lane is docs only: it wrote the verdicts the orchestrator ruled into `DEFECTS.md` (D-244 and D-245 flipped, D-243 gained its 1440 numbers, D-246 added at the end) and wrote this file. It measured nothing itself.

Wave-31 verdicts (live build: `last-modified` of `/` read Tue, 03 Nov 2026 23:25:00 GMT; the build carries #457, merged 22:55Z, and so the D-243 fix `200ea722`, the D-244 fix `2956e78c` and the D-245 fix `72840d25`):

| Row | Verdict |
|---|---|
| D-244 | **Fixed**, fixed-in `2956e78c`. `POST /api/desk/watchlists/<id>/items` on a fresh list: AAPL 201 in 395 ms (the cold first call), MSFT 201 in 119 ms, a repeat AAPL 409 in 112 ms, KO 201 in 114 ms with its bars already in the DB, CHWY and ETSY 201 in 129 and 150 ms. Pending to ready by itself: CHWY about 132 s, ETSY about 170 s. No 10 s wait, no "Couldn't save that change". DELETE list 204 in 85 ms. |
| D-245 | **Fixed**, fixed-in `72840d25`. After the close (19:00 to 19:06 ET) on `/today?mode=fundamental`, `/screener` and `/today?mode=technical`, at 1440 x 900 and 1180 x 820, 6 of 6 loads: the pill reads "After hours", the badge reads "Delayed 15 min", the two share no word, no pill is cut. |
| D-243 | **Still Open, 1440 only.** `/practice/screen?thread=30` (30 rows) at 1440: `clientWidth` 1,088 / `scrollWidth` 1,107, so **19 px sideways**; the RVOL NOW cell box sits 19.6 px under the pinned Actions, at most 7.6 px of its text visible. At 1180 it is exact (1,108 / 1,108) and at 1300 it fits (1,228 / 1,228). |
| D-246 | **New, P2, Open.** /ES added to a watchlist: 201 in 88 ms, the item stays `pending` forever (still pending after 8 minutes and a reload). |

**The two open items are the 19 px D-243 residual and the futures row D-246.**

Screenshots and numbers are not in the repository. They are files in the run's `walk-22/` directory (outside the repo): `measurements.json` holds the numbers, `progress.md` the running log, `c-d243-*` the Screen at 1440, 1180 and the resize round trips, `c-d244-*` the watchlist, `c-d245-*` the top bar, `f-*` the full pass at both widths.

## How it was run

- The walk lane **died twice mid-run**. The numbers here were reconstructed by the orchestrator from `walk-22/measurements.json` and `walk-22/progress.md`; nothing was re-measured for this file, and the lane never wrote its own report.
- Live build only: `https://trading.tobytran.dev`, 1440 x 900 and 1180 x 820, signed in as the test user. Wave 31, `last-modified` of `/` Tue, 03 Nov 2026 23:25:00 GMT.
- The continuation started at 23:52Z (6:52 PM ET), **after the close**, so everything below was read with the market shut: D-244 from 23:52Z to 23:59Z, D-245 from 00:00Z to 00:06Z (19:00 to 19:06 ET), D-243 from 00:01Z to 00:02Z, the full pass from 00:10Z. The first lane's D-244 screenshots were reused for the pictures only; every number was measured again.
- State made on the live Desk: a watchlist (the test user's own), deleted at the end (`DELETE` 204 in 85 ms, then `GET /api/desk/watchlists` read `[]`). The Screen's subject was thread 30 (5m, 30-row scan at Mon 2026-08-03 10:30 AM ET); the files do not say whether it was kept.
- This docs lane was cut from `origin/dev` `2e8107f0` (#457 merged).

## D-244 (Fixed by `2956e78c`): the stock path adds in about a tenth of a second

`/watchlists` > Manage, a new list, 1440 x 900, API timings measured from the page:

| Call | Status | Wall time |
|---|---|---|
| POST AAPL (first, cold) | 201 | 395 ms |
| POST MSFT | 201 | 119 ms |
| POST AAPL again | 409 | 112 ms |
| POST /ES (future) | 201 | 88 ms |
| POST KO (bars already in the DB) | 201 | 114 ms, ready at once |
| POST CHWY, POST ETSY (no bars yet) | 201, 201 | 129 ms, 150 ms; both pending at once |
| DELETE the list | 204 | 85 ms |

- AAPL and MSFT read `ready` on the first read seconds later. CHWY was ready by about 132 s and ETSY by about 170 s (ETSY was still pending at about 150 s). The 10 s wait and the "Couldn't save that change" sentence of walk 21 did not appear once.
- After a backfill the bars exist: CHWY and ETSY had 22 daily and 572 15-minute bars (`GET /api/desk/bars/<symbol>?interval=...&days=30`).
- The page also has two things this walk did not close, both in D-246: /ES never leaves pending, and the table cells of a freshly backfilled stock were blank (unconfirmed).

## D-245 (Fixed by `72840d25`): the two pills say two things

`/today?mode=fundamental`, `/screener` and `/today?mode=technical` at both widths, after the close:

- The market pill reads and is titled "After hours" (1159 to 1222 px at 1440; 899 to 962 px at 1180). The quote badge reads and is titled "Delayed 15 min" (1252 to 1337 px at 1440; 992 to 1077 px at 1180). The two share no word and neither is cut: 6 of 6 loads.
- The status bar repeats "Delayed 15 min" ("Quotes: Alpaca · Delayed 15 min", "Last update 6:33 PM ET"), by design. The old bundle showed "After hours" twice in the first lane's shot.
- Not read: the badge **during** the session (walk 21 recorded "Delayed 15 min" there; nothing changed for that state in the fix).

## D-243 (Open): the 1440 pane is 19 px short

The fix removed the overlap at 1180 and 1300 but not at 1440. `/practice/screen?thread=30`, 30 rows, scan Mon 2026-08-03 10:30 AM ET:

| Width | Container (`clientWidth` / `scrollWidth`) | Columns | Actions starts | Overlap |
|---|---|---|---|---|
| 1440 | 1,088 / **1,107** (19 px sideways) | 10 (8 dropped) | 919 px | RVOL NOW box 19.6 px under the actions, text at most 7.6 px |
| 1300 | 1,228 / 1,228 | 11 (Prev RVOL returns) | 1,059 px | none |
| 1180 | 1,108 / 1,108 | 10 | 939 px | none |

- 1440 headers: SYMBOL 16-198, FILTERS 198-412, PRICE AT SCAN 412-484, PRICE NOW 484-555, VS PREV CLOSE % NOW 555-637, ATR % 637-711, RSI 711-773, EARNINGS 773-871, RVOL NOW 871-939, ACTIONS 919-1,104 (pinned). Dropped: Prev close, Prev RVOL, Prev change %, Change % now, Volume now, Gap, Vs VWAP, Since.
- Why: the set that never drops is 1,107 px and the pane is 1,088 px. The Symbol cell is 182 px and the Filters cell 214 px; the fix lane assumed 87 and 162 px. So it is the never-drop set, not the fit code, that is wider than the pane.
- Resizes: 1440 to 1300 reads 1,228 / 1,228 with 11 columns; 1300 back to 1440 reads 1,088 / 1,107 with the 19.6 px box, **identical to a fresh 1440 load**; 1180 to 1300 to 1180 is clean (1,228 / 1,228 at 1300, 1,108 / 1,108 back at 1180).
- First paint on both widths: a skeleton of 18 columns at 161 to 163 ms, 10 columns by 170 to 174 ms.
- Status stays `Open`, Fixed-in `-`. A fix must either make the never-drop set fit 1,088 px (narrower Symbol or Filters cell, or one more column off the set) or measure the two cells instead of assuming them; the check to run is `scrollWidth` against `clientWidth` at 1440, not only at 1180 and 1300.

## D-246 (new): a futures symbol never leaves pending

`/watchlists` > Manage, Asset type Future, add /ES: `POST` 201 in 88 ms. The row stays `pending`: right after the add, after 2 minutes and a reload, and on a third read about 8 minutes after, with the banner "Backfilling history for 1 symbol" on the page. The stocks on the same list left pending by themselves (D-244). **P2**: the add works and stock rows work, but a futures row cannot become ready and the banner does not clear.

- Cause, from a code read only (not traced live): futures symbols write no `Bar1d`, so the backfill readiness the row waits on never completes.
- **Unconfirmed half, recorded in the row:** after CHWY and ETSY finished their backfill, the table row's last, change and RVOL cells and the freshness line stayed blank, while KO (bars in the DB before the add) showed quotes. It was read after the close, when a new symbol may simply have no last to show. It needs one read during the session before it is a row of its own.

## The fresh pass: nothing new

23 routes at 1440 and 1180, one load each with the HTTP cache on (except `/` at 1180, see the gaps): `/`, `/today`, `/screener`, `/screener/filters`, `/watchlists`, `/strategies`, `/strategies/library`, `/alerts`, `/technicals`, `/stocks`, `/futures`, `/paper`, `/backtests`, `/holdings`, `/covered-calls`, `/ask`, `/settings`, `/feedback`, `/more`, `/practice`, `/practice/thread`, `/practice/journal`, `/practice/replay`.

- 0 long tasks on every load; no sideways scroll of the document anywhere; no type under 11 px; no shared words in the top bar; no unnamed controls (the two hits were an sr-only legend and a `Copy` button, both false positives).
- Dense tables: screener results fit whole (808 / 808 at 1440, 868 / 868 at 1180); the technicals and futures tables fit.
- The retired routes `/practice/day?id=30`, `/practice/week` and `/practice/order` answer the standard 404 "This page does not exist" at both widths (6 of 6), and no link to them exists on `/practice`, `/practice/thread` or `/practice/screen`.
- The `backtest` lane sends `/` to `/practice`; known, not filed.

## `feedback.spec.ts` is stale, not the page

`/feedback/new?from=%2Fpractice%2Fday%3Fid%3D5` at both widths: the form's "Where were you?" reads Screen "Practice", Route `/practice/day?id=5`, "Which screen?" Practice. `e2e/desk/feedback.spec.ts` still expects the retired label **"Practice · Screen"**, `/practice/screen?thread=5` and "Thread 5". `/practice/day` is gone (404), so nothing maps it any more and the form falls back to the generic "Practice". A user sees no failure; the spec needs a `/practice/screen?thread=5` fixture (the same conclusion as walk 21's note on `:337` and `:378`). No row.

## The honest gaps

- **The cache-off long-task batch was cut by the lane's death and was NOT re-measured.** The pass above is cache on, one load per route. The 0 long tasks of walk 21's cache-off series (D-241) has no wave-31 counterpart.
- **The screener resize round trip** was queued after the batches and has no recorded result; only the first-paint widths (808 / 808, 868 / 868) are known.
- **Two retests were left unconfirmed, and are not rows:**
  - `/` at 1180 returned a null `goto` once; not reproduced, not retried.
  - `/screener/filters` showed one unnamed button at 1440 once (shot `f-filters-unnamed-1440`); not reproduced.
- **D-246's second half is unconfirmed** (blank quote cells after a backfill, read after the close).
- Everything was read **after the close** (6:52 PM ET onward): no in-session quote cell, no in-session badge, no live backfill with a feed running.
- D-217, D-239, D-240, D-241 and D-242 are not in walk 22's measurements and were not re-walked.

## Traps for the next walk

- Re-read the Screen with `scrollWidth` against `clientWidth` at **1440**, not only 1180: the fit passed at 1180 (1,108 / 1,108) and 1300 and failed at 1440 by 19 px.
- A futures symbol never turns `ready`; use a stock to test the backfill, and a stock whose bars are already in the DB (KO) to compare quote cells with one that is not.
- Read the quote cells of a newly backfilled stock **during the session** before deciding D-246's second half.
- The brief's stamp check (`last-modified` of `/`) says only that the upload began; fetch the page's `script[src]` files with `cache: "no-store"` for the string the fix added, as walks 20 and 21 did.
- Delete the watchlist you made and read `GET /api/desk/watchlists` as `[]` before you finish.
