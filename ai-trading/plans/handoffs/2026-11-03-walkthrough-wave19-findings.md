# Walkthrough wave 19: the wave-22 fixes walked live on wave 27, and a fresh pass

Date: 2026-11-03. New defects: none (D-241 is still free; `DEFECTS.md` is untouched and ends at D-240). Nothing was fixed in this lane, and no existing row was flipped.

Wave-27 verdicts (live build: `last-modified` of `/` read Tue, 03 Nov 2026 15:03:46 GMT before the walk and again at 15:58Z, so one build for the whole walk):

| Row | Verdict |
|---|---|
| D-239 | **Holds** at 1440 and 1180: one POST per refused minute, the refusal survives leaving the Screen and a reload, a clock move into a new minute clears it. |
| D-237 | **Holds**: nine routes at 1180, every status sentence I could make the bar print, page exactly 1180 wide, "Report a problem" inside it. |
| D-238 | **Holds**: eleven routes at 1440, no cut badge sentence, whole sentence in `title` and `aria-label`. |
| D-235 | **Can close on its own criterion** (live walk reads no task at 1x): 0 of 20 Screen loads ran a task of 50 ms or more at 1x, against 5 of 10 in wave 24. At 4x one task of 51 to 57 ms is left on every warm load (the Summary runs none): see "D-235". |
| D-240 | **Can close on its own criterion**: 1 of 45 replay loads at 1x ran a task (52 ms), against 9 of 10 in wave 24. At 4x the first load of a fresh renderer runs the same shell-boot tasks as the Summary and the home page, which supports the lane's claim; warm 1m loads keep one task of 50 to 57 ms: see "D-240". |
| D-217 | **Holds live** (`f912fd4d`): 33 of 34 new 1m bars cost no task of 50 ms or more; the one that did (84 ms) did not repeat. The row stays as it is. |

Screenshots and numbers are not in the repository; they are files in the run's `walk-19/` directory (outside the repo): `*-1440.png` and `*-1180.png` are the live build at that width, `measurements.json` holds the load and bar numbers, `notes.md` the running log.

## How it was run

- Cut: `origin/dev` `4ac89040` (#439). Worktree `practice-walk-19`, branch `feature/practice-walk-19`. `origin/dev` had no later commit and the ledger ended at D-240 when I finished.
- Live build only: `https://trading.tobytran.dev`, release wave 27, an isolated browser context (`walk19`), 1440 x 900 and 1180 x 820, signed in as the test user. Clerk asked for the new-device code; I read the one verification email through the `gmail-dashify` search (the code is in the subject line; no message was opened, labelled or deleted) and typed it into the field. The email and password were pasted from the clipboard, which I cleared afterwards. None of it is in any file, screenshot, report or log written here.
- The market was **open** the whole walk (about 10:10 to 10:55 AM ET), so the real top bar read "Open" and "Delayed 15 min" (status bar "Quotes: Alpaca · Delayed 15 min"). Every other sentence was forced in my own tab: `GET /api/desk/status` was answered by a Playwright route with the live body and only `market.session` and the `quotes` fields changed (backup `quality = fallback`, paused 7 hr, unavailable, closed, status 500, never answered). "Reconnecting" was forced by letting the first answer through, aborting every later poll and reading after the 30 s poll (38 s). Nothing was sent to the live feed.
- Practice threads (test user): 21 and 22 (one filter, Abnormal volume, start Mon 2026-08-03 9:30) for D-239 at 1440 and 1180; 23 (Abnormal volume, High volatility, Top movers; 5m plan; jumped to Mon 10:30; scan "246 of 250 scanned · 142 matched · showing 30") for D-235 and the 5m replay of SQQQ (session 40, 1,998 source bars); 24 (one filter, 1m plan, Mon 10:30) for the 1m replay of SQQQ (session 41, 6,060 bars) and D-217; 25 (one filter) for one extra D-239 flow. **All five are deleted**; the landing is back to "No practice thread yet" and "Thread slots 6 of 10". The two tabs already open in the shared browser (not mine) were not touched.
- Load harness (one fresh page per cell, `about:blank` between loads, cache disabled, CDP `Performance.getMetrics` for `LayoutCount` and `TaskDuration`, `PerformanceObserver` long tasks of 50 ms or more from the navigation, window = navigation until the content is ready plus 2.5 s, 3.5 s on replay; `Emulation.setCPUThrottlingRate` set once per page, a 4-million-step calibration loop read at the end: 7 to 10 ms at 1x, 12 to 13 ms at 4x, 21 ms in the two cells that were contended). The first load of a fresh page is a cold renderer; loads two to five are warm. Machine load while measuring: 2.7 to 3.9 on 16 cores. A cold load of a replay resets the chart interval to the thread's plan interval, so the 1m runs use a thread whose plan is 1m (session 41) and the 5m runs use session 40. One 5m cell was mislabelled 1m by my first attempt (the timeframe click does not survive a navigation); I kept it as a second 5m cell.

## D-239 (Fixed by `daea4495`): holds

`/practice/screen?thread=` of a thread with one filter (Abnormal volume) at Mon 2026-08-03 9:30 AM ET. POSTs counted with a request listener on `…/screen/rescan`.

| Step (1440, thread 21) | Result | POSTs after the step |
|---|---|---|
| Scan now at 9:30:00 | 409; sentence "Abnormal volume waits until 10:00 AM ET · no filter has a bar to read at 9:30 AM ET. Move the clock on the Summary (Play, Next open or Jump), then scan."; "Go to the Summary" link; Scan now disabled; page 1440 wide | 1 |
| Go to the Summary, then "Open Screen" (clock unmoved) | sentence, link and disabled button all still there | 1 |
| Reload | still refused, no new POST | 1 |
| Play 4 s from a second window (clock 9:30:04) | still refused and disabled: the clock is still in the 9:30 minute, so a scan would be refused again | 1 |
| Jump to 9:31 | sentence cleared and button enabled at the first read, 6 s after the Jump (a new minute) | 1 |
| Scan now at 9:31:00 | 409, refused again with the same sentence | 2 |
| Reload at 9:31 | still refused, no new POST | 2 |
| Jump to 10:30 | sentence cleared, button enabled at the first read, 5.5 s after the Jump; Scan now | 3 (200) |

1180 (thread 22): scan 1 (409), Summary and back 1, reload 1, Jump to 10:30 cleared and enabled, scan 2 (200); page 1180 wide at every step. Natural flow (thread 25, 1440): refused at 9:30 (1 POST, 409), "Go to the Summary", Jump to 10:30 there, "Open Screen": no sentence, Scan now enabled, still 1 POST. So the claim holds: one POST per refused minute, and the refusal no longer depends on the mounted page. The brief's "Play 4 s must clear it" does not: a 4 s Play stays inside the same minute, which is the claim's own unit (wave 24 read the same). Screenshots: `d239-refusal-1440`, `d239-back-1440`, `d239-reload-1440`, `d239-after-jump-1440`, `d239-refusal-1180`, `d239-back-1180`, `d239-after-jump-1180`.

## D-237 and D-238 (Fixed by `bd5f5ce6`): both hold

Read on nine routes (`/`, `/today`, `/stocks`, `/holdings`, `/covered-calls`, `/ask`, `/settings`, `/feedback`, `/more`) at 1180, and on those plus `/screener` and `/technicals` at 1440, in seven states each: real (open, delayed), backup, paused 7 hr, unavailable, closed, status 500, status never answered. Reconnecting was read on `/stocks` and `/feedback` at 1180 and `/` and `/stocks` at 1440.

| State | 1180 status bar (visible, whole sentence in `title` and read as hidden text) | 1180 and 1440 top-bar badge |
|---|---|---|
| Backup | "Backup quotes · may differ"; `title` and hidden text "Using backup quotes · may differ slightly from IBKR" (equal) | 1180 and 1440: "Backup quotes · may differ" (174 px at 1440), `title` and `aria-label` "Using backup quotes · may differ slightly from IBKR", no cut |
| Paused 7 hr | "Quotes paused · 7 hr ago"; whole "Quotes paused · last update 7 hr ago" | whole at 1440 (231 px); `title` and `aria-label` at 1180 |
| Unavailable | "Quotes unavailable"; whole "Quotes unavailable right now · trying again" | "Quotes unavailable" (130 px), `title` and `aria-label` whole |
| Reconnecting | "Reconnecting…"; whole "Reconnecting… · last update 10:15:24 AM ET" | "Reconnecting…" (110 px), `title` and `aria-label` whole |
| Status 500 | "Status unavailable"; whole "Status unavailable right now" | top bar: "Status unavailable" at 1180, "Status unavailable right now" at 1440 (its `title` was not read in this state) |
| Closed | "Quotes: Alpaca · Market closed" | "Market closed · showing last close" whole (217 px at 1440) |
| Real (open) | "Quotes: Alpaca · Delayed 15 min" | "Delayed 15 min" |

At 1440 the status bar has room and prints the whole sentence for backup, paused, unavailable and reconnecting. Every cell, both widths: top-bar overflow 0; page exactly as wide as the window (1180 or 1440, no sideways scroll); account button right edge x 1164 (x 1424); status-bar overflow 0; "Report a problem" right edge x 1164 (x 1424), inside the page, including `/feedback` with the backup sentence (wave 24: 56 px wider). No route redirected. Screenshots: `d237-backup-feedback-1180`, `d238-backup-stocks-1440`, `d238-backup-home-1440`, `reconnecting-{stocks,feedback}-1180`, `reconnecting-{stocks,home}-1440`.

## D-235: live numbers (can close on its criterion)

`/practice/screen?thread=23`, 30 rows, cold loads, five per cell (the 1x cells run twice, ten loads). Controls: the Summary of the same thread, same harness. Layouts and busy time are medians; "tasks" are long tasks of 50 ms or more, one load per `;`.

| Page, width, CPU | Loads with a task | Tasks (ms) | Layouts | Busy (ms) |
|---|---|---|---|---|
| Screen, 1440, 1x | **0 of 10** | none | 12 (11 to 13) | 103 and 107 |
| Screen, 1180, 1x | **0 of 10** | none | 11 (10 to 11) | 98 and 115 |
| Summary (control), 1440 and 1180, 1x | 0 of 5 each | none | 6 | 74 and 67 |
| Screen, 1440, 4x | 5 of 5 | 52/57/64/128/73 ; 57 ; 54 ; 54 ; 51 | 12 | 425 |
| Screen, 1180, 4x | 5 of 5 | 64/64/129/71 ; 55 ; 55 ; 53 ; 51 | 11 | 403 |
| Summary (control), 1440, 4x | 1 of 5 | 58/70/138 ; none x4 | 6 | 260 |
| Summary (control), 1180, 4x | 1 of 5 | 62/65/132 ; none x4 | 6 | 236 |

Reading: at 1x, the only load that matters to the row's own criterion ("stays Open until a live walk at the same load reads none"), the Screen ran no task in 20 of 20 loads at both widths, where wave 24 read one in 5 of 10 (55 to 72 ms). The layout count agrees with the lane (10 to 13, down from 40). At 4x the first load of a fresh renderer runs four or five tasks on the Screen against three on the Summary (the shell boot: 58, 70, 138 ms), and every warm Screen load keeps **one task of 51 to 57 ms** where the warm Summary runs none (8 of 8 Screen loads, 0 of 8 Summary loads). The lane's rig read no task at 4x, so the lane's 4x claim does not carry over to live; the task is 1 to 7 ms over the line at a 4x slowdown, and I did not file it as a row because it is the same defect class under an emulated slowdown and the row's own bar is the live 1x reading. If the orchestrator wants the 4x residual tracked, it needs a row of its own after D-235 closes.

## D-240: live numbers (can close on its criterion)

`/practice/replay?id=` of SQQQ at Mon 2026-08-03 10:30 (session 41: 1m, 6,060 source bars; session 40: 5m, 1,998 bars), cold loads, five per cell, same harness; controls measured in the same run: the thread Summary and the home page (`/?mode=fundamental`).

| Page, width, CPU | Loads with a task | Tasks (ms), one load per `;` | Layouts | Busy (ms) |
|---|---|---|---|---|
| Replay 1m, 1440, 1x | **0 of 10** | none | 32 | 176 and 186 |
| Replay 5m, 1440, 1x | **0 of 15** | none | 31 to 32 | 176, 149, 162 (three rounds of five) |
| Replay 1m, 1180, 1x | **0 of 10** | none | 23 to 33 | 179 and 519 |
| Replay 5m, 1180, 1x | **1 of 10** | 52 (one load) | 32 | 366 and 368 |
| Summary / home (control), 1440, 1x | 0 of 5 each | none | 6 / 5 | 73 / 59 |
| Summary / home (control), 1180, 1x | 0 of 5 each | none | 6 / 6 | 67 / 61 |
| Replay 1m, 1440, 4x | 5 of 5 | 60/70/143 ; 56 ; 50 ; 57 ; 55/113/66/126/53 (load five: busy 2,519 ms, contended) | 33 | 793 |
| Replay 5m, 1440, 4x | 2 of 5 | 61/68/150 ; 67/57/114/54 ; none x3 | 34 | 618 |
| Summary (control), 1440, 4x | 1 of 5 | 60/76/71/142 ; none x4 | 6 | 281 |
| Home (control), 1440, 4x | 1 of 5 | 68/72/65 ; none x4 | 6 | 237 |
| Replay 1m, 1180, 4x | 4 of 5 | 60/69/140/58 ; 50 ; 52 ; none ; 51 | 33 | 698 |
| Replay 5m, 1180, 4x | 4 of 5 | 73/69/140/66 ; 50 ; none ; 55 ; 50 | 33 | 562 |
| Summary (control), 1180, 4x | 2 of 5 | 57/70/135 ; none ; 56 ; none ; none | 6 | 265 |
| Home (control), 1180, 4x | 2 of 5 | 92/82/85/50/79 (calibration 21 ms: contended) ; none ; 88 ; none ; none | 6 | 411 |

Reading: at 1x the replay route's cold load ran no task in 44 of 45 loads (the one task, 52 ms, came in a 1180 5m cell that read 0 of 5 on the next round; wave 24 read one or more in 9 of 10). The 1180 busy numbers are noisy (519 against 179 for the same cell on two rounds) because the machine was loaded, so I read tasks, not busy time. At 4x the lane's claim holds for the first load of a fresh renderer: the replay runs the same three or four tasks (60 to 150 ms) as the Summary (57 to 142 ms) and the home page (65 to 92 ms), which is the shell boot. What it adds on warm loads at 4x is one task of 50 to 57 ms on the 1m session (1440: 56, 50, 57; 1180: 50, 52, 51) and on the 5m session at 1180 (50, 55, 50) (one warm 5m load at 1440 ran four, 54 to 114 ms, and the others none) while the warm controls at 1440 run none and at 1180 run one each (56 and 88 ms, the latter in a contended cell). The replay's own layouts are 31 to 34 against 5 or 6 for the controls, as expected for a chart page. Same call as D-235: the row's own bar is met at 1x; the 4x residual (50 to 57 ms, 0 to 7 ms over the line) is the orchestrator's to track or drop.

## D-217 (Fixed, `f912fd4d`): holds live, row untouched

SQQQ 1m on session 41 (6,060 to 6,094 source bars), tape "All" (the default), CPU 1x, long tasks by `PerformanceObserver`, machine load about 3.

| Run | Width | Bars | Long tasks |
|---|---|---|---|
| Idle 5 s before the steps | 1440 and 1180 | 0 | none |
| `POST …/clock {step: "bar"}`, one bar at a time, 3.5 s after each | 1440 | 8 | none |
| the same | 1180 | 8 | one: 84 ms, 1.78 s after the request, on the first bar after a fresh load; the other seven none |
| Repeat: three fresh loads, two bars each | 1180 and 1440 | 12 | none |
| Clock running at 1x, two bars (60.9 s and 121.7 s) | 1440 | 2 | none at a bar; two tasks away from bars: 60 ms at 104.7 s and 148 ms at 115.8 s |
| The same, second 125 s window | 1440 | 2 | none |
| The same, 115 s window | 1180 | 2 | none |

34 new bars, one with a task of 50 ms or more (84 ms, once); it did not repeat in the six first-bars-after-a-fresh-load that followed. The two tasks at 1440 that were not at a bar did not repeat in the second 125 s window. File only what reproduces twice, so neither is a row; they are the same kind of one-off wave 23 saw (449 and 77 ms away from bars). The fix reached live: wave 24 read 5 tasks around one of four bars (532 ms), here none around 33 of 34.

## Fresh full pass (1440 and 1180)

Routes: `/`, `/today`, `/screener`, `/screener/filters`, `/watchlists`, `/strategies`, `/strategies/library`, `/alerts`, `/technicals`, `/stocks`, `/futures`, `/paper`, `/backtests`, `/holdings`, `/covered-calls`, `/ask`, `/settings`, `/feedback`, `/more`, `/practice`, `/practice/screen`, `/practice/thread`, `/practice/journal` (replaces to `/practice`), `/practice/replay`, and with thread 23: `/practice/screen?thread=`, `/practice/thread?id=`, `/practice/journal?thread=`, `/practice/replay?id=`. Screenshots: `pass-<route>-1440.png` and `pass-<route>-1180.png`.

| Probe | 1440 | 1180 |
|---|---|---|
| Computed type under 11 px, HTML and SVG | none on any route | none on any route |
| Unnamed controls | none (a "Copy" button in the collapsed JSON panel of `/screener/filters` reads as unnamed because its `<details>` is closed: it is not rendered) | none |
| Links to `practice/day`, `practice/week`, `practice/order` | none | none |
| Document-level horizontal scroll | none on any route | none on any route |
| Long tasks on load (1x) | none on any route, including `/practice/screen?thread=` and `/practice/replay?id=` | none on any route |
| Clipped text | only the visually hidden "Default mode" label on `/settings` and `/more`, and `/strategies/library` "Futures overnight-range break" by 2 px (192 of 190; seen since wave 16 and left) | the same |
| The words day, week, swing, session | only where they are right: filter names ("52-week breakout", "New 20-day high", "Prior day high", "SESSION AND RUN ON"), "FUTURES · SWING", "Week ahead", "CME session" on `/futures`, "LAST 30 DAYS" on `/paper`, "Swing · 8 sample symbols" on `/backtests`, "Shortest expiry (days)" on `/settings`, "IBKR's weekly session needs a fresh 2FA login" on Today at 1440; on the practice routes only "VWAP is the session's, from 1-minute bars, on every chart interval" on the replay | the same |

## New defects

None. D-241 is still free.

## Not filed (seen, judged not defects, or did not repeat)

- The 4x residual on the Screen (51 to 57 ms, every warm load) and on the replay 1m load (50 to 57 ms): see D-235 and D-240; the orchestrator decides whether it needs a row after those two close.
- One 84 ms task on the first 1m bar after a fresh load at 1180, and two tasks (60, 148 ms) away from bars in one 122 s window at 1440 (D-217 section): each seen once.
- The first "Open" of SQQQ on the thread-23 Screen showed "Opening SQQQ…" for more than 12 s; the next two opens (AMZN 1.6 s, BABA 2.1 s) were fast and I did not time a second SQQQ. Seen once.
- Play 4 s on the refused Screen does not clear it (same minute); that is the claim, not a defect.
- Console: the only errors I saw were the 409s of refused scans (expected) and the `/status` polls I forced to fail; I did not open the warnings.

## Not exercised

- The market-closed, paused, backup, unavailable and reconnecting top bar and status bar in a real feed state (the market was open and delayed all walk); those sentences were forced in my own tab with the live body.
- D-217 at 10x and with two windows, on AMZN, and over more than 34 bars; D-235 and D-240 at 2x; the Screen at 128 matched rows (wave 24's Wed 9:30 scan); loads on a thread with an open position; Limit, Stop and Stop-limit tickets, Set stop, Add note, Full screen, the Edit plan form, Close thread, and any thread of another user.
