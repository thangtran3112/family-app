# Walkthrough wave 18: the wave-21 fixes walked live on wave 24, and a fresh pass

Date: 2026-11-03. New defects D-237 to D-240 (4: P0 0, P1 0, P2 0, P3 4). Nothing was fixed in this lane.
Wave-24 verification (PR #425, #426, #427): D-233, D-234 and D-236 hold on live at 1440 and at 1180 (D-234 with one gap, D-239). D-232 holds for the top bar at 1180 on all nine routes and every sentence I could make
the bar print, but two neighbours turned up: the status bar of `/feedback` still scrolls the page sideways with the backup sentence (D-237), and at 1440 three badge sentences are cut (D-238). D-235 stays Open: the Screen's
layouts are down to 10 or 11 per load as claimed, but 5 of 10 cold loads at 1x still run one task of 55 to 72 ms (the Summary runs none), and 4x adds three to five. D-217 is in flight in its own lane; its evidence is below and
the row is untouched. The market was in pre-market for the whole walk, so most quote sentences were forced (see "How it was run") and none of them is a live reading.

Screenshots are not in the repository; the names below are files in the run's `walk-18/` directory (outside the repo). A name ending `-1440` or `-1180` is the viewport width, and every one is the live build. The
long-task, layout and column numbers were read in the page and are not in any file.

## How it was run

- Cut: `origin/dev` `e32b5e81` (#427). Worktree `practice-walk-18`, branch `feature/practice-walk-18`. The ledger on the cut ended at D-236 and `origin/dev` held no later row, so the new rows start at D-237.
- Live build only: `https://trading.tobytran.dev`, release wave 24 (`last-modified` of `/` read as Tue, 03 Nov 2026 12:01:52 GMT, after the 11:47Z deploy), an isolated browser context (`walk18`), 1440 x 900 and 1180 x 820,
  signed in as the test user. Clerk asked for the new-device code; I read the one verification email through the `gmail-dashify` search (the code is in the subject line; no message was opened, labelled or deleted) and
  typed it into the field; the email and password were pasted from the clipboard, which I cleared afterwards. The browser tool echoes what it types and logs, so the code and the account's address appeared in my tool output
  only; none of it is in any file, screenshot, report or log written here.
- The market was in pre-market all walk (about 7:10 to 7:45 AM ET). The only real quote sentence I saw was "Pre-market" beside "Pre-market · 7:00 AM ET" (the feed said "delayed 15 min", Alpaca). For D-232 I forced every
  other sentence in my own tab: `GET /api/desk/status` was answered by a Playwright route with the live body and only `market.session` and the `quotes` fields changed (live, delayed, paused 7 hr and 59 min, backup
  `quality = fallback`, closed, after hours, unavailable, status 500, never answered). "Reconnecting" was forced by letting the first answer through and aborting every later poll, then reading after the 30 s poll. Nothing
  was sent to the live feed or changed on the server.
- Practice threads: thread 18 (three filters, start Mon 2026-08-03 9:30, 5m, $50,000) for D-233, D-235, D-236 and D-217 (a scan at Wed 2026-08-05 9:30 took 33 s: "245 of 250 scanned · 128 matched · showing 30"; replay
  session 38 on TSLL); threads 19 and 20 (one filter, Abnormal volume) for D-234 at 1440 and at 1180. **All three are deleted**; the landing is back to "No practice thread yet" and "Thread slots 6 of 10". The two tabs
  already open in the shared browser (a thread and a `/practice/day` page, not mine) were not touched; my own tab is closed.
- Probes on every route at both widths (script run after each navigation, the long-task observer injected with `addInitScript`): computed type under 11 px (HTML text, and SVG text scaled by its viewBox), clipped text,
  unnamed controls, document-level horizontal scroll, links to `practice/day`, `practice/week`, `practice/order`, the words day, week, swing and session, and long tasks of 50 ms or more since navigation. Machine load while
  measuring: 2.4 on 16 cores.

## Wave-24 verification (D-232, D-233, D-234, D-236) and D-235

| ID | Verdict | What was run and the number or sentence that decides it | Screenshots |
|---|---|---|---|
| D-232 | **Holds for the top bar (1180 and 1440); two neighbours filed (D-237, D-238)** | See "D-232 in detail" below. At 1180, nine routes (`/`, `/today`, `/stocks`, `/holdings`, `/covered-calls`, `/ask`, `/settings`, `/feedback`, `/more`), ten sentences: bar overflow 0, no label cut, account button right edge x 1164 (x 1168 beside the closed sentence), the page exactly as wide as the window. Real state (pre-market): no sideways scroll on any of the nine routes at either width. Short forms keep the whole sentence in `title` and `aria-label`; "Market closed · showing last close" stays whole. Not clean: `/feedback` with the backup sentence scrolls sideways through its status bar (D-237), and at 1440 the badge cuts three sentences (D-238). | `d232-paused7-stocks-1180-topbar`, `d232-closed-stocks-1180-topbar`, `d232-backup-stocks-1180-topbar`, `topbar-reconnecting-stocks-1180`, `d232-backup-feedback-1180` |
| D-233 | **Holds (1440, 1180)** | The line shows only while the shown clock is the Jump's target and ends at the next clock move; the named time was never behind the clock. 1440: Jump to Mon 11:15, "Jumped to Mon 2026-08-03 · 11:15 AM ET." with the clock at 11:15:00 and "At" 11:15, held for 6 s; Next open: line gone at 0.26 s (clock Tue 9:30:00); Jump to Tue 11:15: line at 0.26 s; Play: line gone at 0.25 s, the clock 11:15:06 after 6 s, no line. 1180: Jump to Tue 12:00 (line), Play (gone), a Jump to 1:00 PM while running (clock 12:00:02 to 1:00:00, no line, "At" 1:00 PM), Pause, Jump to 1:30 (line), Next open: gone at 0.25 s, clock Wed 2026-08-05 9:30:00. A Jump backwards (10:05 against 11:15) and a Jump to the clock's own minute (11:15 at 11:15:00) have a disabled Jump button, so neither can be issued from the page; I did not try the 422 path again (known since wave 15). | `d233-after-jump-1440`, `d233-after-next-open-1440`, `d233-after-play-1440`, `d233-after-jump-1180`, `d233-jump-while-running-1180`, `d233-after-next-open-1180` |
| D-234 | **Holds (1440, 1180), with one gap (D-239)** | Thread of one filter at Mon 9:30: one sentence, "Abnormal volume waits until 10:00 AM ET · no filter has a bar to read at 9:30 AM ET. Move the clock on the Summary (Play, Next open or Jump), then scan.", a "Go to the Summary" link to the thread's Summary, no "Try again" anywhere in the main text, no trailing "·", and Scan now disabled; one `POST …/screen/rescan` (409). A forced click, Enter and Space on the disabled button sent nothing. A Play of 4 s (9:30:04, same minute) kept it disabled; a Jump to 10:30 from another window enabled it within 2 s and cleared the sentence. 1180: the same sentence, link and disabled button, page width 1180. The gap: leaving the Screen and coming back, or a reload, enables the button again and a second scan at 9:30 posts (D-239). | `d234-refusal-1440`, `d234-after-jump-1440`, `d234-refusal-1180` |
| D-236 | **Holds (1440, 1180)** | Thread at Wed 2026-08-05 9:30 after a scan (30 rows): the EARNINGS column (98 px at both widths) prints "—" in all 30 cells; one cell carries `title="No report before the open"`, 29 carry no title; the word "None" appears nowhere in the Screen's main text, in any title, at either width (wave 17 read four "None" cells on the same kind of list). | `d236-screen-scanned-1440`, `d236-screen-scanned-1180` |
| D-235 | **Stays Open** | See "D-235, live numbers" below. | none (numbers only) |

### D-232 in detail

Pair width is the market pill and the quote badge together (the Fundamental bar leaves 287 px at 1180). Each row was read on all nine routes at 1180 (a second run on `/stocks` also read `title`, `aria-label` and 1440).

| 1180 sentence (pill · badge) | Forced? | Pair width | Result |
|---|---|---|---|
| Pre-market · Pre-market · 7:00 AM ET | real | 260 px | fits, whole |
| Open · Live | forced | 122 px | fits |
| Open · Delayed 15 min | forced | 172 px | fits |
| Open · Quotes paused · 7 hr ago | forced | 230 px | fits; title and aria-label "Quotes paused · last update 7 hr ago" |
| Pre-market · Quotes paused · 59 min ago | forced | 279 px | fits (the widest short form); title and aria-label whole |
| Open · Backup quotes · may differ | forced | 239 px | fits; title and aria-label "Using backup quotes · may differ slightly from IBKR" (page still scrolls on `/feedback`: D-237) |
| Closed · Market closed · showing last close | forced | 291 px | fits, whole; account button right edge x 1168, whole and reachable |
| After hours · After hours | forced | 182 px | fits |
| Open · Quotes unavailable | forced | 195 px | fits; title and aria-label "Quotes unavailable right now · trying again" |
| Unavailable · Status unavailable (status 500) | forced | 225 px | fits; title and aria-label "Status unavailable right now" |
| Checking… · Updating quotes… (status never answers) | forced | 224 px | fits |
| Pre-market · Reconnecting… | forced | not read | fits and whole; title and aria-label "Reconnecting… · last update 7:00:33 AM ET" (read on `/stocks` only) |

At 1440 the nine routes were read for the real state, paused 7 hr and closed (bar overflow 0, avatar right edge x 1424, page 1440 wide); the other sentences were read on `/stocks` and `/`. The Technical routes `/screener` and
`/technicals` print the same short forms at 1180 and fit; the Practice routes `/practice` and `/practice/screen` carry no quote pills in Backtest mode and fit at both widths. The 1440 cuts are D-238.

Not reachable: any of the live sentences other than Pre-market (market closed, open, backup, paused, unavailable, reconnecting all need a different market or feed state), and a real feed fault whose other fields (alerts,
holdings, options) change with it; the forced answers keep the live values for those.

### D-235, live numbers

`/practice/screen?thread=18`, 30 rows, 16 columns, cold loads (cache disabled, a fresh navigation from a blank page), five per cell. The window runs from the navigation until the 30 rows are present, plus 2.5 s at rest.
"Layouts" is the Chrome performance counter `LayoutCount`; "busy" is the main thread's `TaskDuration`; long tasks are `PerformanceObserver` entries (50 ms or more). The Summary of the same thread was run through the same
harness as the control for what the boot costs without the Screen.

| Page, width, CPU | Layouts per load | Main thread busy, median (range) | Long tasks |
|---|---|---|---|
| Screen, 1440, 1x | 11 (10 to 11) | 276 ms (180 to 301) | 3 of 5 loads ran one task: 72, 55, 57 ms |
| Screen, 1180, 1x | 10 | 229 ms (206 to 283) | 2 of 5 loads ran one task: 60, 56 ms |
| Screen, 1440, 4x | 11 (10 to 11) | 1,128 ms (735 to 1,210) | 2 to 5 per load (median 4); longest per load 143 ms (median), 297 ms (worst) |
| Screen, 1180, 4x | 10 | 983 ms (671 to 1,183) | 2 to 3 per load (median 3); longest per load 137 ms (median), 303 ms (worst) |
| Summary, 1440, 1x (control) | 5 | 193 ms (151 to 230) | none in 5 loads |
| Summary, 1440, 4x (control) | 5 | 678 ms (531 to 715) | one per load (76 to 98 ms), the boot task |

Against the lane's own numbers: the layout count agrees (40 down to 12 at 1440; here 11 at 1440 and 10 at 1180). Main-thread busy does not compare (178 ms there, 276 ms here at 1440): my window includes the live network,
the whole boot and 2.5 s at rest, which is why the Summary reads 193 ms in the same harness; the Screen costs about 80 ms more than the Summary at 1440 and 1x. **The row cannot close.** The criterion D-206 and D-212 set,
no single task of 50 ms or more, is not met at 1x (5 of 10 Screen loads ran one, 55 to 72 ms, where the Summary ran none in 5), and at 4x the Screen runs three to five tasks where the Summary runs one. The lane's reading that
what is left at 2x is the shared boot task holds at 4x only for one of them. A load of `/practice/replay?id=` is a second, separate cost (D-240).

## D-217 evidence (in flight, row untouched)

`/practice/replay?id=38`, TSLL (not AMZN as in walks 16 and 17), 1m, tape "All", about 6,000 source bars, the thread clock at 1x (`POST …/clock {running:true}`), one window, long tasks by `PerformanceObserver`,
machine load 2.4. Each run: 5 s at rest, then the clock on until one new bar and 3.5 s after it. "Bar" is the "Chart data table · N source bars" count going up by one.

| Width | At rest 5 s | New bar | Long tasks around the bar |
|---|---|---|---|
| 1440 | 0 | 6,000 to 6,001 at 65.5 s | five: 69 ms at 65.4 s, then 182, 50, 93 and 138 ms between 67.9 s and 68.8 s (532 ms in all) |
| 1440 | 0 | 6,003 to 6,004 at 61.5 s | none |
| 1180 | 0 | 6,001 to 6,002 at 61.5 s | none |
| 1180 | 0 | 6,002 to 6,003 at 61.5 s | none |

One bar in four cost any task here, against 18 of 20 on AMZN in walk 17, so the name or the tape matters; D-212's own criterion (no single task of 50 ms or more at a new bar) is met on three bars and missed on one,
and four bars are too few to say more. `d217-1m-1440` and `d217-1m-1180` are the last page of each run.

## Fresh full pass (1440 and 1180)

Routes: `/`, `/today` (read with `?mode=fundamental`, as in wave 17), `/screener`, `/screener/filters`, `/watchlists`, `/strategies`, `/strategies/library`, `/alerts`, `/technicals`, `/stocks`, `/futures`, `/paper`,
`/backtests`, `/holdings`, `/covered-calls`, `/ask`, `/settings`, `/feedback`, `/more`, `/practice`, the practice routes with no id (`/practice/screen`, `/practice/thread`, `/practice/journal` which replaces to
`/practice`, `/practice/replay`) and with thread 18 (`/practice/screen?thread=`, `/practice/thread?id=`, `/practice/journal?thread=`, `/practice/replay?id=`).

| Probe | 1440 | 1180 |
|---|---|---|
| Computed type under 11 px, HTML and SVG | none on any route | none on any route |
| Unnamed controls | none | none |
| Links to `practice/day`, `practice/week`, `practice/order` | none | none |
| Document-level horizontal scroll (real state) | none on any route | none on any route; the nine D-232 routes are whole (the 25 px of wave 17 is gone) |
| Long tasks on load | `/practice/replay?id=` two (121, 68 ms): D-240; every other route none | `/practice/screen?thread=` one (58 ms): D-235; `/practice/replay?id=` two (85, 61 ms): D-240; every other route none |
| Clipped text | only visually hidden labels (the "Default mode" label on `/settings` and `/more`) and `/strategies/library` "Futures overnight-range break" by 2 px (192 of 190; seen in waves 16 and 17 and left) | the same |
| The words day, week, swing, session | only where they are right: "52-week breakout", "New 20-day high", "Prior day high", "SESSION AND RUN ON" and "session high" (filter names), "Day change" and "your holdings in the next two weeks" on Today, "Swing · 8 sample symbols" on `/backtests`, "FUTURES · SWING", "Week ahead" and "CME session" on `/futures`, "LAST 30 DAYS" on `/paper`; on the practice routes only "its first bar of the day cannot be read yet" on the Screen | the same |

## New defects

Rows are in `DEFECTS.md` (D-237 to D-240, status Open); the evidence is in the rows. In short:

- **P3 D-237** `/feedback` at 1180 with the backup sentence: the status bar's right group ends at x 1236, so the page scrolls sideways by 56 px and "Report a problem" is half off screen (forced state; reproduced 3 of 3).
- **P3 D-238** at 1440 the quote badge is capped at 260 px and cuts "Using backup quotes · may differ slightly from IBKR" (291 px in 238), "Quotes unavailable right now · trying again" (242 in 238) and "Reconnecting… · last update 7:00:33 AM ET", in both modes (forced states).
- **P3 D-239** the Screen's refused-scan state is the mounted page's: leave the Screen and return, or reload, and the button is enabled again and a second scan at the same minute posts (409).
- **P3 D-240** opening `/practice/replay?id=` runs one to four long tasks (55 to 428 ms) in nine of ten loads, at both widths.

## Not filed (seen, judged not defects, or owned by something else)

- The Screen after a clock move that was not a Jump (D-233's "Jump while running" case): the line never shows because the clock is already past the target when the Jump lands. That agrees with the fix (the line shows only while the clock equals the target), so there is no feedback line after a Jump during Play; left as an observation.
- One `GET /api/desk/status` stalled for 30 s in my context once (about 12:20 UTC) and answered in 1.5 s on the next call; static pages answered in 0.1 s at the same time. Not repeated, not filed.
- On a fresh load at 1440 the first read of `/screener` and `/technicals` showed "Checking the market… · Updating quotes…" 1.1 s after the document was ready while `/status` was being answered (that run had a route installed that passed the real answer through). It cleared; not filed.
- The Screen carries hidden columns (Prev close, Prev volume, Prev gap %, Prev vs VWAP %, Since; 0 px wide at both widths); not visible, so not filed (as in wave 17).
- Console: the 409 from every refused scan (expected, D-234 and D-239) and the failed `/status` polls I forced; one warning on a few pages was not opened.

## Not exercised

- The market-open and market-closed top bar and status bar in a real state (pre-market all walk); D-232's closed, paused, backup, unavailable and reconnecting sentences were forced, not read from the live feed.
- A Jump backwards through the API (the button is disabled before it), a Jump that fails with 422, a thread with an open position (D-218), Limit, Stop and Stop-limit tickets, Set stop, Add note, the Chart menu toggles, Full screen, the Edit plan form, Close thread, 10x with a second window, two open positions, a
  thread of 10 slots, and any thread of another user.
- D-217 on AMZN (walk 17's name) and over more than four bars.
