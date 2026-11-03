# Walkthrough wave 21: D-241 and D-242 walked live on wave 29, and a fresh full pass

Date: 2026-11-03. New defects: **D-243** (Practice Screen: three columns sit under the pinned actions), **D-244** (Watchlists: adding a stock fails after 10 s) and **D-245** (top bar after the close: two pills say "After hours"). Nothing was fixed in this lane, no existing row was flipped, and `DEFECTS.md` only gained the three rows at its end.

Wave-29 verdicts (live build: release `aece33e7`, deploy run 41705666933; `last-modified` of `/` read Tue, 03 Nov 2026 19:57:03 GMT, then 20:26:09 GMT when the second deploy ran; see "The stamp" below):

| Row | Verdict |
|---|---|
| D-241 | **Fixed on its own condition.** 1440 x 900, 1x CPU, HTTP cache on, one fresh page per load: **0 of 73 replay loads ran a task of 50 ms or more** (walk 20: 8 of 43). 1180: 0 of 10. Cache off: 0 of 10. Controls (home, Summary, Screen with 30 rows, journal): 0 of 32. No Long Animation Frame of 50 ms or more in any cache-on load, so no script to name at 1x. |
| D-242 | **Fixed.** 102 of 102 kit number boxes (filter editor 29 at each width, alert setup 22 at each width) are `aria-invalid="true"` with an `aria-describedby` that resolves to the box's own sentence when a value over the cap is typed, and carry neither attribute again once a good value is put back (walk 20 measured 0 of 22). One caveat on "once": see D-242 below. |
| D-240, D-235 | Not re-walked beyond the load numbers; the replay and the 30-row Screen both ran 0 long tasks at 1x (D-241 section). |
| D-217, D-239 | Not re-walked. |

Screenshots and numbers are not in the repository. They are files in the run's `walk-21/` directory (outside the repo): `measurements.json` holds the numbers, `notes.md` is the running log, `d242-*` the condition-kit shots, `pass-*` the pass at both widths, `d-screen-*` the Screen, `tab-*`, `journal-*`, `watchlists-8-*`, `replay-*` and `feedback-*` the rest.

## How it was run

- Cut: `origin/dev` `247ddead` (#448, #449, #450 merged). Worktree `practice-walk-21`, branch `feature/practice-walk-21`. `origin/dev` had not moved when I started and when I finished.
- Live build only: `https://trading.tobytran.dev`, an isolated browser context (`walk21`), 1440 x 900 and 1180 x 820, signed in as the test user. Clerk asked for the new-device code; I read the one verification email through a `gmail-dashify` subject search and typed the code. The email address and password were pasted from the clipboard, which I cleared afterwards. None of it is in any file, screenshot, report or log written here.
- The machine that ran the browser was busier than in walk 20: load average 2.2 to 12 on 16 cores during the load series (walk 20: 2.4 to 3.5).
- State I made on the live Desk, all removed again: practice threads 28 and 29 (5m, Abnormal volume and Top movers, clock jumped to Mon 2026-08-03 10:30 AM ET, one scan each, replay sessions 46 and 47 of SQQQ; on thread 28 a Buy 100 market and a Close position, and the clock played 20 s at 1x and 12 s at 5x), both deleted: the landing reads "No practice thread yet" and "Thread slots 6 of 10", as before. One watchlist (the test user's, with futures only), deleted. 24 feedback screenshots uploaded and 24 removed by the page's own Remove button; no report was sent. No saved filter and no alert strategy was created (every over-cap value was refused). The two tabs already open in the shared browser (not mine) were not touched, and the tab I opened is closed.
- Load harness (as walk 20): one fresh page per load (`context.newPage()`), `about:blank` first, a `PerformanceObserver` for `longtask` and `long-animation-frame` registered before navigation and buffered, 4 s after `#main-content` (3.5 s for the controls), CPU 1x. Cache on means the page's script files come from the HTTP cache: the harness reads 24 of 24 (replay) script resources with `transferSize` 0 on every load, and 0 of 24 with `Network.setCacheDisabled`. The replay tape had 120 rows on every load.

## The stamp, and the second deploy

The brief warned that `last-modified` of `/` moves before the static upload finishes. This time:

- At 20:21Z the stamp read 19:57:03Z (first deploy, run 41705666933, finished). The second deploy (run 41710147307, release #452, the same tree under a new tag) was still running its static upload job. I fetched each page's own `script[src]` files with `cache: "no-store"` and found the wave-29 strings: the `DenseTable` chunk (`3_aqqqyfmhx7n.js`) holds `fitsAsRendered` (`.hidden.length>0||x.wrap`) and the filter-editor chunk (`1q1auvh8a6gx5.js`) holds the new box id (`condition-${path}`).
- At 20:26:09Z the stamp moved (the second deploy rewriting the same tree). I read the page's scripts again at 20:32Z and at 21:08Z: **the same chunk names, the same strings**. Chunk names are content hashes (`cache-control: public, max-age=31536000, immutable`), so a re-upload of the same tree cannot change what a page loads.
- The second deploy finished at 20:37:45Z (all jobs success, including "Deploy to the VPS"). The first 53 replay loads and the filter-editor sweeps ran before that; to be sure, I made a **new thread and ran 20 more cache-on replay loads at 21:08Z, after both deploys had finished: 0 of 20**.

## D-241: holds on its own condition

`/practice/replay?id=` of a 5m thread, SQQQ, about 2,000 source bars, tape of 120 rows (the same shape as walk 20's). Cache on, 1x, 1440 x 900.

| Series | Width | Loads with a task of 50 ms or more | Machine load (1 min) |
|---|---|---|---|
| trial | 1440 | 0 of 3 | 6.6 |
| 1 | 1440 | 0 of 10 | 8.6 |
| 2 | 1440 | 0 of 10 | 3.8 |
| 3 | 1440 | 0 of 10 | 3.4 |
| 4 | 1440 | 0 of 10 | 3.0 |
| 5 | 1440 | 0 of 10 | 2.2 |
| 6, 7 (new thread, after both deploys) | 1440 | 0 of 20 | about 12 |
| 8 | 1180 | 0 of 10 | about 2 |
| cache **off** | 1440 | 0 of 10 | 2 |
| controls, cache on | 1440 | home 0 of 8, Summary 0 of 8, Screen with 30 rows 0 of 8, journal 0 of 8 | about 7 |

Totals: 73 cache-on loads at 1440, none with a task; at walk 20's rate (8 of 43) the chance of this is about 2 in 10 million. With the cache off, three frames of 50 to 62 ms were logged at 62 to 100 ms after navigation with **no script attributed** (parse and first render of an uncached page; not a task). While a replay ran (the clock at 1x for 20 s at 1440, at 5x for 12 s at 1180) there was no long task, no Long Animation Frame, the tape stayed at 120 rows and the pane never scrolled.

What is left at 4x CPU (CDP `Emulation.setCPUThrottlingRate` set once on a fresh page, cache on, not the row's condition): the replay runs 2 to 3 tasks on all 10 loads (50 to 57 ms in `405f22ul_aqz2.js`, 51 to 62 ms and 102 to 110 ms in the React scheduler). **The thread Summary runs the same three on 6 of 6 loads** (50 to 57, 51 to 57, 102 to 110 ms), so they are the shell boot that D-240 described, not the replay. The only replay-specific cost is a `requestAnimationFrame` callback in the `DenseTable` chunk of 30 to 31 ms (29 to 30 ms of forced style and layout) on 4 of 10 loads, inside a frame of 50 to 57 ms made of several small tasks: the measure still runs on some loads, now below the bar and with no single task over it. Not filed.

## D-242: holds, with one count to read

Method: on `/screener/filters` and `/alerts/new`, for every metric option of the Metric and Compared with sides (and Rank by on the filter editor), type 99999 in each kit number box on its own, press Create filter (the alert setup is live), read the input's `aria-invalid` and `aria-describedby`, resolve the id, read its text, count the text nodes on the page that hold that sentence, then put the old value back and read both attributes again.

| Page | Width | Boxes wired (invalid + describedby resolves to the box's own sentence) | Both attributes gone after a good value |
|---|---|---|---|
| `/screener/filters` | 1440 | **29 of 29** (Metric 11, Compared with 11, Rank by 7) | 29 of 29 |
| `/screener/filters` | 1180 | **29 of 29** on the second full pass (first pass 27 of 29, see below) | 29 of 29 |
| `/alerts/new` | 1440 | **22 of 22** (Metric 11, Compared with 11) | 22 of 22 |
| `/alerts/new` | 1180 | **22 of 22** | 22 of 22 |
| Total | | **102 of 102** (walk 20: 0 of 22) | 102 of 102 |

The 11 boxes per side are Days of Relative volume; Length of RSI, SMA, EMA and ATR; ATR length and Median length of ATR % vs its median; Minutes of the two opening-range metrics; Days of N-day high and low. The id is `condition-<spec path>` (for example `condition-when.left.lookbackDays`) and the line is `condition-<path>-error`, a `p[role=alert]`. A neighbouring box that was not touched carries neither attribute in every case. Screenshots: `d242-filters-days61-1440` and `-1180`, `d242-alerts-days61-1440` and `-1180`.

- **First pass at 1180: 27 of 29.** Two boxes (Compared with ATR % vs its median, ATR length and Median length) read no attribute and no line after the over-cap value. I could not reproduce it: 6 isolated runs of those two boxes at 1180 (3 each) wired every time, the whole Compared with side alone read 11 of 11, and a full second pass read 29 of 29. I treat the first pass as a harness miss (an earlier sweep step overlapping the click) and filed nothing.
- **The attributes clear within about half a second of the edit, not at once**: right after the value is put back they are still set at 100 ms and gone by 500 ms (three runs on EMA). It is the form's problem state clearing, not a defect.
- **"Once on the page" is two text nodes.** Each box's own line exists once (one element, the `aria-describedby` target). The form's problem summary also lists the sentence with the box's label in front ("Condition · Metric · Days: Must be 60 or less.", a span on the filter editor and a link on the alert setup), so a text-node count reads 2 on every case. The Field-wired **Average volume days** box on the same page reads the same two ("Average volume days: Must be 5 or more." plus its own line), and walk 20 recorded the summary-plus-inline pattern as ADR-0026's. On `/alerts/new` the inline line itself carries the whole labelled sentence, the same text as the summary entry. If D-204's "once" is meant to cover these summaries, none of the form's boxes meets it and that is a design call, not this fix; I did not file it.
- On `/alerts/new` with Days 61, Turn on stays disabled.

## The fresh pass

Cold loads, 3.5 s settle, 1440 and 1180. Probes: computed type under 11 px (HTML text, and SVG text scaled by `getScreenCTM`), clipped text, unnamed controls, document-level sideways scroll, links to retired routes, long tasks of 50 ms or more from navigation start.

| Group | Result at both widths |
|---|---|
| `/` and `/today` (Fundamental mode), `/screener`, `/screener/filters`, `/watchlists`, `/strategies`, `/strategies/library`, `/alerts`, `/alerts/new`, `/technicals`, `/stocks`, `/futures`, `/paper`, `/backtests`, `/holdings`, `/covered-calls`, `/ask`, `/settings`, `/feedback`, `/more` | 0 long tasks of 50 ms or more, page exactly as wide as the window, 0 type under 11 px, 0 retired links |
| `/practice`, `/practice/screen`, `/practice/thread`, `/practice/replay` bare | the same; with a thread each shows a picker (`h1` empty) |
| `/practice/journal` bare | goes to `/practice` (as in walk 20) |
| `/practice/screen?thread=`, `/practice/thread?id=`, `/practice/journal?thread=`, `/practice/replay?id=` | the same, 0 long tasks on a cold load of each |
| `/practice/day`, `/practice/week`, `/practice/order` | **404** at both widths, linked from nowhere |

Unnamed controls: 0, except one `Copy` button inside the closed "View JSON" details on `/screener/filters` (not rendered, so not a control a user can reach). Clipped text: `/strategies/library` preset descriptions are cut to two lines (the whole sentence is in the DOM; known from walk 20, not filed).

Dense tables, at 1440 and 1180, first paint and after a resize round trip (1440 to 1180 to 1440 and 1180 to 1440 to 1180) with the width read each time:

| Table | Result |
|---|---|
| Portfolio (open position), Trades (1 fill, then 2), journal (2 rows), replay tape (120 rows, 4 columns), screener results (9 rows, 11 columns), watchlists with 8 futures (rail 4 columns, main 7) | every column whole, no header clipped, pane never scrolls sideways, and the width follows the pane on each resize |
| Practice Screen (30 rows) | **not whole at either width: D-243** |

Practice flows I drove: New thread (5m, two filters), Jump to 10:30, Scan now (41 s and 40 s, the page says "Scanning at…" and the button is disabled meanwhile), Open a name (SQQQ), Buy 100 market (fills at once, "Long · 100 shares"), Close position ("Practice exit"), Play at 1x and 5x with the replay open, Delete thread (two clicks). At 3.5 s on a cold Screen load the "now" cells show grey placeholders for a few seconds and fill in by about 12 s; after the clock moves they do so again. Placeholders, not flicker: a 30 s sample of the first row's Price now read the same value from the first sample.

## D-243 (new): three Screen columns are under the pinned actions at first paint

`/practice/screen?thread=` with a scan of 30 rows: 18 columns, 5 hidden by priority, 13 kept at 1,343 to 1,350 px in a pane of 1,088 px (1440) or 1,108 px (1180), so the pane scrolls sideways by 242 to 262 px. The pinned Open, Peek and Star cell starts at 903 px, so **Earnings, RVOL NOW and CHANGE % NOW** are under it or past the edge; a user sees Symbol to RSI and the buttons. The line above the table talks about the "now" columns. A resize to 1300 and back changes nothing. `BOARD_PRIORITIES.practiceList` keeps those columns whatever the pane (and D-223 keeps the filter names), so the never-drop set is wider than the pane: this is the Screen's column set against D-157's rule, not the fit code (every other table fits and re-fits). Reproduced on 6 loads of 6, both widths. Screenshots: `d-screen-1440-12s`, `d-screen-scrolled-1440` and `-1180`, `pass-practice-screen-thread-28-1180`.

## D-244 (new): adding a stock to a watchlist fails after 10 s

`/watchlists` > Manage, a new list, Asset type Stock, Add symbol with AAPL, SPY or MSFT: "Adding…" for 10.1 to 10.2 s, then `POST /api/desk/watchlists/<id>/items` answers **503 `{"detail":"The Desk is busy · try again"}`** and the page says "Couldn't save that change · Try again". 5 of 5 attempts, in two pages, 20:44Z to 20:59Z (after the second deploy finished). With Asset type Future the same list took /ES in 144 ms (201) and seven more futures; creating, renaming and deleting a list worked; `GET /api/desk/status` read normal. **P1** because the page's one job is filling a list and the Add symbol button is its only control for it, so a user cannot build a stock watchlist at all. I did not look at a server log; the constant 10 s looks like a wait that gives up (the first place to look is that route around 20:44Z). Because of it the watchlist table was walked with futures (8 rows, fits and re-fits); a stock row's cells were not seen.

## D-245 (new): "After hours" twice in the top bar

After the close (16:02 ET to 16:10 ET, `/today?mode=fundamental` and `/screener`, 1440 and 1180, 4 of 4 loads) the market pill and the quote badge are side by side and both read, and are titled, "After hours"; the status bar repeats it ("After hours · Last update 4:00 PM ET"). `/api/desk/status` read `market.session` "after" and quotes `delayed-15m`. The two words come from two entries of `lib/desk/freshness.ts` (`marketAfter`, `after_hours`). During the session the badge says "Delayed 15 min". Screenshots: `topbar-after-hours-*`.

## The 6 pre-existing e2e failures (`feedback.spec.ts:337`, `:378`, `:500`)

Checked by hand on the live `/feedback/new` at both widths. **No row**: a user sees none of the three.

- **:337 and :378 are stale fixtures.** Both open `/feedback/new?from=%2Fpractice%2Fday%3Fid%3D5` and expect "Practice · Screen", `/practice/screen?thread=5` and "Thread 5". `/practice/day` was retired (it is a 404, linked from nowhere); on live the same URL reads screen "Practice", route `/practice/day?id=5`, thread "—", because nothing maps the old route any more. The link a user really has, from the Screen, reads "Practice · Screen", `/practice/screen?thread=28`, "Thread 28", with Bug and P2 checked and Send disabled with "Reason: a title and a description are required." at both widths. The specs need a `/practice/screen?thread=5` fixture.
- **:500 works for a user.** At 1440 and 1180: drop a PNG (progress "Uploading dropped.png"), cancel it (no progress bar left, "0 of 6"), paste one (it uploads, "· PNG · uploaded"), choose five more ("6 of 6"; the add button reads "That is the most a report can hold" and is disabled), and Remove deletes each on the server (6 POST 201, 6 DELETE 204). All six uploaded within 520 ms. What I could not tell is why the spec fails: right after "6 of 6" five rows still read "Uploading 0%" for a moment, so a count of 6 `uploaded` rows taken at once fails and one taken with retries passes; that is a guess about the rig.

## Looked at and not filed

- `/strategies/library`: preset descriptions cut to two lines (known).
- The retired-route 404s are the standard "This page does not exist" page.
- The Screen's Price now and "vs prev close % now" show grey placeholders for the first seconds of a cold load (live quotes at the thread clock). It is the loading state; the Screen's header says nothing about it.

## What I could not reach

- A stock row in the watchlist table (D-244).
- The 1m replay (6,000 bars), D-217 (the new-bar cost on a running replay) and D-239 were not re-walked; the 4x numbers are replay and Summary only.
- Tables that are empty for the test user: Holdings, Alerts, Paper, Backtests and `/futures` showed no rows, so their dense tables were not measured with data.
- Peek, Star, Full screen and the Chart menu were not driven (the replay itself was, at both widths).
- IBKR-connected states and the quote-state sentences (D-237, D-238) were out of this brief; D-245 is a side finding of the clock reaching the close.

## Traps for the next walk

- Wait for the job "Upload Desk static release" to read `completed`, and check the bundle by fetching the page's `script[src]` files with `cache: "no-store"`; a stamp that moves again with the same chunk names is a re-upload of the same tree.
- `page.on("dialog")` registered in several `browser_run_code_unsafe` calls on the same page stacks: the second handler throws "already handled" and the call hangs on the edited form's `beforeunload`. Use a fresh `context.newPage()` per sweep and register one handler with `.catch(() => {})`. A call that times out leaks its page; close it before the next one.
- The kit's boxes are `condition-<spec path>…` and their attributes clear about half a second after the edit: wait 900 ms before reading "good".
- `/` and `/today` follow the stored mode (`desk.lane`) and the stored lane of a fresh context sent `/` to `/practice`: use `?mode=fundamental` for the Fundamental routes.
- A closed `<details>` keeps its children's boxes but not their text: skip them in a probe (`innerText` is empty), or "unnamed" and "table 5 columns, 258 px in a 122 px pane" come out of the chart data table and the JSON panel.
- Machine load matters for a task at the 50 ms line: record it per series.
