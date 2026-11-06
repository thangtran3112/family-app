# Walkthrough wave 23: D-243 and D-246 close on wave 32, two new rows

Date: 2026-11-03 (the walk ran from 02:14Z to 03:05Z on 2026-11-04, which is 9:14 to 10:05 PM ET on 11-03, so every read was **after the close**). New defects: **D-247** (Practice / Screen: the 112 px Symbol cell hides the rescan badges completely) and **D-248** (Watchlists: the "Backfilling history" caption and tags do not clear when the stock turns ready, only on a reload). Two rows close on live numbers (**D-243** Fixed, **D-246** Fixed). The D-241 regression check is clean and D-241 was not touched. This lane is docs only: it measured everything below itself, flipped the two rows, appended the two new ones and wrote this file.

Wave-32 verdicts (live build: `last-modified` of `/` read Wed, 04 Nov 2026 02:11:07 GMT; the build carries #460 and #461, so the D-246 fix `ade4afe1` and the D-243 fix `e4153c66`):

| Row | Verdict |
|---|---|
| D-243 | **Fixed**, fixed-in `e4153c66`. `/practice/screen?thread=30`, 30 rows, at 1440 x 900: `clientWidth` 1,088 / `scrollWidth` 1,088, 10 columns, Actions starts at 903.4 px, RVOL NOW 825.8-903.4, Earnings 727.5-825.8, no cell box under the Actions cell. 1180: 1,108 / 1,108. 1300: 1,228 / 1,228. A 1440, 1300, 1440 round trip returns the fit exactly. Nothing re-measures in a loop. |
| D-246 | **Fixed**, fixed-in `ade4afe1`. /ES and a fresh /NQ read `backfill: "ready"` once the API was on wave 32; no row tag, and no caption for the futures. The caption counts only the pending stock ("Backfilling history for 1 symbol"). List deleted: DELETE 204, `GET /api/desk/watchlists` read `[]`. The stock caption does not clear by itself, see **D-248**. |
| D-247 | **New, P3, Open.** The Symbol cap does not clip the "New in this scan" / "No longer matches" badge, it removes it: rows read `EAT…`, `NCLH…`, `NOW…`. The tooltip carries the text whole, on a hover only. |
| D-248 | **New, P3, Open.** After a stock turns ready the caption and the Manage tag stay until a reload (DKNG about 560 s, ZM 105 s checked, ROKU's Manage tag 170 s checked). |
| D-241 | **Not flipped.** 42 warm-cache loads (22 replay, 10 Summary, 10 home), 0 long tasks and 0 long animation frames. |

**The open items are D-247 and D-248.**

Screenshots and numbers are not in the repository. They are files in the run's `walk-23/` directory (outside the repo): `measurements.json` holds the numbers (36 entries, each with `surface`, `width`, `metric`, `value`, `at` in UTC), `progress.md` the running log, `d243-*` the Screen (`d243-held-row-1440.png` is the picture behind D-247), `d246-*` the watchlist, `replay-*` the replay series and `pass-*` the full pass at 1440 and 1180.

## How it was run

- Live build only: `https://trading.tobytran.dev`, 1440 x 900, 1180 x 820 and 1300 x 900, signed in as the test user in an isolated browser context (new-device code read from the email subject). One lane, no deaths; the numbers were written to `walk-23/` after every batch.
- **Build check.** `last-modified` moved at 02:11:07Z, and the page's 17 `script[src]` chunks fetched with `cache: "no-store"` carried both wave-32 strings: `symbol:112,filters:200,earnings:140` (`SCREEN_WIDTH_CAPS`) and `"pending"===e.backfill&&"future"!==e.asset_type` (`isBackfilling`). So the **static files were wave 32 from the first read; the API was not.** Run 41757470058 finished "Build and push images" and "Upload Desk static release" first; "Deploy to the VPS" started at 02:19:16Z, sat in "Deploy over SSH" and completed with success at about 02:43Z. D-243 is frontend-only and was judged first; D-246 waited for the deploy (below).
- State made on the live Desk, all the test user's own: a watchlist (id 5, deleted at the end); **thread 30 was kept and changed**: ten names starred (EAT, NCLH, NOW, WULF, ASTS, IREN, RKT, ORCL, ONDS, RDDT), the thread clock moved to Mon 2026-08-03 10:36:41 AM ET (speed 10 for 40 s, then paused at 1x), a second scan ("Scan 2", 39 s), a replay session of SQQQ 5m (id 48), and one market Buy of 100 SQQQ through the Order ticket, so the thread has 1 open position and buying power $45,762.00. It is a ready fixture for the next walk (a Screen with held-over rows, a Portfolio row, a journal row, a tape of 120 rows) and has not been deleted.
- This docs lane was cut from `origin/dev` `e4153c66` (#461 merged); `origin/dev` had not moved when the PR was opened.

## D-243 (Fixed by `e4153c66`): the Screen's pane fits at 1440

`/practice/screen?thread=30`, 30 rows (scan Mon 2026-08-03 10:30 AM ET), one load plus a second read 3.5 s later:

| Width | Container (`clientWidth` / `scrollWidth`) | Columns | Actions starts | Header extents that matter |
|---|---|---|---|---|
| 1440 | 1,088 / 1,088 (both reads) | 10 | 903.4 px | Symbol 0-112, Filters 112-312, Earnings 727.5-825.8, RVOL NOW 825.8-903.4 |
| 1300 | 1,228 / 1,228 | 12 | 1,043.4 px | RVOL NOW 970.1-1,043.4, Earnings 871.9-970.1 |
| 1180 | 1,108 / 1,108 | 11 (walk 22 had 10) | 923.4 px | RVOL NOW 853.3-923.4, Earnings 755-853.3 |

- No cell box sits under the pinned Actions cell at any width (the right edge of every other visible header is at or before the Actions left edge), 0 of 30 RVOL NOW and Earnings cells are clipped, and the document does not scroll sideways. RVOL NOW reads whole (5.57×, 3.08×, 1.60×, ...).
- **Resize round trip.** 1440, 1300, 1440, 1180, 1300, 1180, 1440, 1180, 1440 at 1.8 s per step: every repeat of a width gives the same numbers, so 1300 back to 1440 reads 1,088 / 1,088 with 10 columns and Actions at 903.4, identical to a fresh 1440 load. Walk 22's 19 px did not come back.
- **No re-measure loop.** Five seconds idle at 1440 after the settle: 0 layouts, 0 style recalcs, 14 ms of task time, 0 mutations on the table. One resize 1440 to 1300 cost 4 layouts, 3 recalcs and 55 ms of task time, then nothing.
- **After a rescan** (Scan 2 at 10:36 AM ET: 33 rows, 26 plain, 4 "New in this scan", 3 "No longer matches"): 1440 is still 1,088 / 1,088 (11 columns, Actions 882.6), 1180 is 1,108 / 1,108, 1300 is 1,228 / 1,228, with no overlap.
- **Does the Symbol cap hide anything a reader needs? Yes: see D-247.** The cell is 112 px at 1440 and 1180 (115.5 at 1300). The ticker stays whole (36 to 48 px of the 100 px usable), but the badge beside it is an inline-block pill, so the ellipsis replaces the whole pill, not a part of it. The 3 held-over rows read `EAT…`, `NCLH…` and `NOW…` and the new rows read `TSLL…` and the like (picture: `d243-held-row-1440.png`). The tooltip does carry it **whole**: `title="EAT · No longer matches"`, but only for a mouse hover; a screen reader gets the DOM text ("EATNo longer matches", no space). The caption above the table says "30 of 40 matched · 4 new in this scan · 3 kept because you opened or starred them", which counts and does not say which. The Filters cell of a held row still reads "Top movers". A reader of a held row sees `EAT…` and a "Top movers" tag and cannot tell it no longer matches without hovering. The fix lane's own comment says the cap "clips the rescan badge"; live it is not a clip.
- **Not exercised:** the Filters cap (widest content 131 px of 200; the scan used one or two filters) and the Earnings cap (all 33 rows read an em dash, so no "Reported before the open" badge to clip). Only the Symbol cap bites in this scan.
- The row closes on its own criterion (the pane fits and nothing sits under Actions at 1440, 1300 and 1180, and returns exactly). The cost of the name cap is D-247, filed apart.

## D-243's neighbours: `DenseTable` re-fits everywhere it was checked

Every pane below is exact (`clientWidth` = `scrollWidth`) at each width, every repeat of a width in a 7-step chain (1440, 1180, 1440, 1300, 1180, 1300, 1440 at 1.6 s per step) gives identical numbers, and every table idles at 0 layouts over 4 s (0 style mutations too, wherever a mutation observer was attached: all but the Portfolio):

| Surface | 1440 | 1300 | 1180 |
|---|---|---|---|
| Screener results (8 rows, 11 columns) | 808 / 808 (9 shown) | 988 / 988 (11) | 868 / 868 (10) |
| Watchlists (main table, 7 columns) | 808 / 808 | 988 / 988 | 868 / 868 |
| Watchlists rail (4 columns) | 263 / 263 | 223 / 223 | 223 / 223 |
| Thread Portfolio (1 open position, 9 columns, none dropped, no header clipped) | 1,374 / 1,374 | 1,234 / 1,234 | 1,114 / 1,114 |
| Journal (7 columns) | 808 / 808 | 988 / 988 | 868 / 868 |
| Replay tape (120 rows, 4 columns) | 255 / 255 | 215 / 215 | 215 / 215 |

- A probe flag "UNDER" on the journal (`SHARES`, `PRICE`, `EFFECT`) is the probe matching the plain "Action" column, not a pinned cell: the pane is exact and no header is clipped. Two extra tables on `/screener` at 1440 (a 5-column one in a 122 px pane) are the chart preview's closed `<details>` data table and its canvas, not a `DenseTable`.

## D-241 regression check (not flipped): the new re-measure runs inside the D-241 path and nothing runs long

1440 x 900, 1x CPU, HTTP cache on (scripts served from cache: 24 of 24 on every replay load), one warm-up load first (not counted), then a fresh page per load with `longtask` and `long-animation-frame` observers over 4 s after `#main-content`:

| Surface | Loads | Loads with a long task | Long animation frames |
|---|---|---|---|
| `/practice/replay?id=48` (SQQQ 5m, 3 tables, 120 tape rows) | **22** | **0** (max 0 ms) | 0 |
| Control: thread Summary `/practice/thread?id=30` | 10 | 0 | 0 |
| Control: `/` (lands on `/practice`, the stored lane) | 10 | 0 | 0 |

- **Count: 0 of 42.** No load ran a task of 50 ms or more, so no row is filed and no frame needs naming.
- A first replay series on `/practice/replay?id=30` (22 loads, 0 tasks) was **void**: 30 is a thread id, the page answers "That practice session was not found" with no table (`replay-id30-not-found-1440.png`). The replay id comes from "Open <symbol>" on a Screen row; the counted series used id 48.
- **Cache off** (CDP `Network.setCacheDisabled`, 0 of 11 to 24 scripts from cache every load): 27 of 27 route loads ran 0 long tasks. Replay id 48, 10 loads: 0 long tasks, but 5 loads ran one long animation frame of 52 to 68 ms (3 with an empty `scripts[]`, 2 with one script whose forced style and layout was 0 ms). The Screen of thread 30, 10 loads: 0 long tasks, 3 loads with one frame of 50 to 56 ms and no script. This is the shape walk 21 recorded (frames without a script: rendering, not script); no frame names the measure. Not a long task, not a row.

## D-246 (Fixed by `ade4afe1`): a future is ready, and the page stops counting it

- **Release lag first.** /ES added at 02:21Z (POST 94 ms) read `pending`, with no tag on the row and no caption (the frontend half of the fix already working over an old API: `d246-es-api-pending-1440.png`). It kept reading `pending` for 22 minutes while run 41757470058 sat in "Deploy over SSH". When the deploy completed (about 02:43Z) the same item read `backfill: "ready"`. The brief's 10-minute poll ran out first; the job had not finished, so the wait is reported as release lag and no defect was concluded from it.
- **Fresh future on the wave-32 API.** /NQ: POST 201 in 137 ms and `ready` on the first read. The /ES and /NQ rows carry no "Backfilling history" tag, and a list of only these two futures shows no caption (`d246-two-futures-ready-1440.png`).
- **A stock with no bars beside them.** CHWY (301 ms) and ETSY (147 ms) already had bars from walk 22 and read `ready` at once; so did PINS and TWLO. ROKU (125 ms), DKNG and ZM did not: `pending`, with the caption reading "Backfilling history for 1 symbol", counting the stock and **not** the two futures (`d246-main-caption-pending-1440.png`). They left pending by themselves: ROKU by 61 s, DKNG by 58 s, ZM by about 155 s.
- **The caption does not clear by itself.** After the API read `ready` the caption stayed: DKNG still showed it at about 560 s (500 s after ready), ZM at 260 s (105 s after ready, tab visible and focused). A reload clears it (`d246-after-reload-cleared-1440.png`). That is **D-248**, filed apart. The brief asked the caption to clear when the stock turns ready; it does not without a reload. D-246's own criterion (a future reaches ready and the page stops waiting for it) holds, so the row closes, the same way D-244 closed and its neighbour was filed apart in wave 22.
- **Cleanup.** The list was deleted from Manage ("Delete list", then "Yes, delete list"): DELETE 204 in 1.7 s, then `GET /api/desk/watchlists` read `[]`.
- **The second half of D-246 cannot be judged after the close, and is not filed.** The walk read every quote cell from 9:14 PM ET. For the record only: CHWY (22.05, −0.99%), ETSY (89.86, −2.80%) and ROKU (160.36, +3.11%) showed their last and change values about 3 minutes after the add; DKNG still read "— —" with a "warming up" cell about 5 minutes after its add. After the close a new symbol may simply have no last. One read during the session still decides it.

## D-247 (new, P3): the Symbol cap removes the badges

See the D-243 section for the numbers. Filed because a held-over row ("kept because you opened or starred it, the scan no longer matches it") is a state a reader acts on, and the visible row no longer tells it apart: ticker plus ellipsis plus the same "Top movers" tag. The tooltip is mouse-only. **P3**: the data is right, the fit is right and the hover works. A fix has to keep the 1,088 px fit: a shorter badge text, a dot or marker that is not clipped, or the state moved into the Filters cell.

## D-248 (new, P3): the caption and tags are read once

`WatchlistDesktop.tsx` reads `useDeskQuery("watchlist-items:<id>")` without an `intervalMs`; the table beside it has `intervalMs: 60_000`. So the items, and with them the caption and every row tag (and the Manage row's "Backfilling history" tag and the "Added ROKU. Checking history…" line), are read on load, on an add and on a delete only. Seen three times: DKNG (caption), ZM (caption, tab visible and focused) and ROKU (Manage tag, 170 s after ready). From a code read, not traced further. A fix has to re-read the items while any stock is pending.

## The fresh pass: nothing new

23 routes at 1440 and 1180, one load each with the HTTP cache on: `/`, `/today`, `/screener`, `/screener/filters`, `/watchlists`, `/strategies`, `/strategies/library`, `/alerts`, `/technicals`, `/stocks`, `/futures`, `/paper`, `/backtests`, `/holdings`, `/covered-calls`, `/ask`, `/settings`, `/feedback`, `/more`, `/practice`, `/practice/thread`, `/practice/journal`, `/practice/replay`; plus `/practice/screen?thread=30`, `/practice/thread?id=30`, `/practice/journal?thread=30` and `/practice/replay?id=48`.

- 0 long tasks on every load; no sideways scroll of the document anywhere; 0 text under 11 px; 0 unnamed controls (the walk-22 sr-only legend and `Copy` button false positives did not recur); 0 links to `/practice/day`, `/practice/week` or `/practice/order`.
- The retired routes `/practice/day?id=30`, `/practice/week` and `/practice/order` answer the standard 404 "This page does not exist" at both widths (6 of 6).
- Dense tables in the pass are exact: screener 808 / 808 and 868 / 868, watchlists the same, Screen 1,088 / 1,088 (11 of 18 columns, 33 rows) and 1,108 / 1,108, journal 808 / 808 and 868 / 868.
- **The cache-off long-task batch that walk 22 lost is back:** 27 of 27 routes at 1440 with the cache off, 0 long tasks (above).
- `/` and `/today` answer `/practice` for the test user (the persisted Backtest lane, known since walk 22), so Today was walked with `?mode=technical` and `?mode=fundamental` at both widths: clean. Bare `/practice/journal` answers `/practice`; bare `/practice/replay` has no `h1`. Known behaviour, not filed.

## The honest gaps

- Everything was read **after the close** (9:14 PM ET onward): no in-session quote cell, no in-session badge, no live backfill with a feed running.
- The Filters cap (200) and the Earnings cap (140) were **not exercised** by this scan; only the Symbol cap bites.
- **One Screen load timed out** (`table tbody tr` not visible within 30 s) at about 02:4xZ, one minute before the API deploy completed; the next load, seconds later, took 0.5 s and every later load was fine. Not reproduced and the API was restarting; no row.
- The brief's "caption clears when the stock turns ready" check **failed live** (D-248). D-246 was flipped on its own criterion, as D-244 was in wave 22; reopen it if the owner reads the caption clause as part of the row.
- D-217, D-239, D-240 and D-242 were not re-walked. The screener resize round trip was run (above); the thread Summary, Portfolio and journal were measured with one position and one journal row only.
- `feedback.spec.ts` staleness (walk 22's note) was not re-read.

## Traps for the next walk

- **The static files go live before the API.** `last-modified` of `/` and a chunk string say only that the upload is done; `gh run view <id> --json jobs` shows "Deploy to the VPS". A backend fix reads old until that job completes (here 22 minutes after the stamp).
- **`/practice/replay?id=` takes a replay session id, not a thread id.** Open a name from the Screen ("Open SQQQ") to make one; id 30 answered "not found" and a 22-load series on it measured nothing.
- To see a "No longer matches" row: star names on the Screen, move the thread clock a few minutes (`POST /api/desk/replay/threads/<id>/clock` with `{speed: 10}` then `{running: true}`, then pause), and press "Re-scan now" (39 s); held rows are the starred names the new scan drops. Only the Symbol cell shows them.
- A stock "with no bars" has to be one nobody has added: CHWY and ETSY are ready at once since walk 22; ROKU, DKNG and ZM were pending for 1 to 3 minutes on this walk and are ready now.
- The watchlist caption and Manage tags only change on a reload or another add (D-248): reload before you read them.
- Delete the watchlist you made and read `GET /api/desk/watchlists` as `[]` before you finish. Thread 30 is still there with Scan 2, an open SQQQ position and replay 48.
