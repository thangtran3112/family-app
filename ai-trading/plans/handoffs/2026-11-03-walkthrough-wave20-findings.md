# Walkthrough wave 20: D-204 and D-205 walked live on wave 28, and a fresh full pass

Date: 2026-11-03. New defects: **D-241** (replay: one long task on a second visit) and **D-242** (condition number boxes are not `aria-invalid`). Nothing was fixed in this lane, no existing row was flipped, and `DEFECTS.md` only gained the two rows at its end.

Wave-28 verdicts (live build: `last-modified` of `/` read Tue, 03 Nov 2026 17:13:48 GMT, after the deploy's static upload job had finished; see "The stamp is not the end of the upload"):

| Row | Verdict |
|---|---|
| D-204 | **Holds** at 1440 and 1180. For all five bad values the sentence is on the page **once** (1 text node), the footer reads the "Starts with a pretend $X…" hint, Start is `aria-disabled="true"`, Enter sends 0 requests, and clearing the field removes the alert and re-enables Start. The two footer-owned problems still print once in the footer. |
| D-205 | **Holds** at 1440 and 1180, and on `/alerts/new`. The summary says "Average volume days" for 3 and for 61, and `Rank by · Days: ` for 61 in Rank by's Days box. A sweep of every kit metric on every side found 0 summary lines that name a box differently from its label and 0 "Lookback". |
| D-235 | **Still holds** on its own criterion: the 30-row Screen ran 0 tasks of 50 ms or more in 8 of 8 loads at 1440 and 1x (and in the one 1180 load of the pass). |
| D-240 | **Holds for a cold load, with a residue that is now a row**: with the HTTP cache disabled (walk 19's harness) 0 of 10 replay loads ran a task; with the cache **on** (a second visit) 8 of 43 loads at 1440 ran one task of 50 to 90 ms. Filed as D-241, not as a reopen. |
| D-217, D-239 | Not re-walked (the brief asked for the two load re-measures only). Seen in passing: after a scan at 10:30 the Screen's button read "Re-scan now" and was disabled when the Screen was reloaded in the same clock minute, as D-239's fix says. |

Screenshots and numbers are not in the repository. They are files in the run's `walk-20/` directory (outside the repo): `d204-*` and `d205-*` are the verdict shots, `pass-*` the pass at both widths, `walk-*` and `walk2-*` the Practice flows, `measurements.json` the numbers, `notes.md` the running log.

## How it was run

- Cut: `origin/dev` `1d4f9861` (#443 and #444 merged). Worktree `practice-walk-20`, branch `feature/practice-walk-20`. `origin/dev` had not moved and the ledger ended at D-240 when I started and when I finished.
- Live build only: `https://trading.tobytran.dev`, release wave 28 (deploy run 41679618876, launched 16:58Z), an isolated browser context (`walk20`), 1440 x 900 and 1180 x 820, signed in as the test user. Clerk asked for the new-device code; I read the one verification email through a `gmail-dashify` subject search (the code is in the subject line; no message was opened, labelled or deleted) and typed it. The email and password were pasted from the clipboard, which I cleared afterwards. None of it is in any file, screenshot, report or log written here.
- The market was open for the whole walk (about 12:00 to 1:20 PM ET). Nothing was sent to a broker: all Practice flows are pretend money on past data.
- Practice threads (test user): 26 (Abnormal volume and Top movers, 5m plan, start Mon 2026-08-03 9:30) and 27 (same filters, 5m). Replay sessions 44 (SQQQ) and 45 (SNAP). **Both threads are deleted**; the landing reads "No practice thread yet" and "Thread slots 6 of 10", the same as before I started. No saved filter or alert was created (every invalid value was refused with a 422, and the alert setup's Turn on button stayed disabled); the two tabs already open in the shared browser (not mine) were not touched, and the tabs I opened are closed.
- Load harness for the regression watch: one fresh page per load (`context.newPage()`), a `PerformanceObserver` for `longtask` registered before navigation and buffered, `about:blank` between loads, 3.5 s after `#main-content` (4 s on the replay), 1x CPU. It was run with the HTTP cache on and with it disabled (CDP `Network.setCacheDisabled`). For attribution the same page also observed `long-animation-frame`, whose `scripts` entries name the callback and its forced style and layout time.

## The stamp is not the end of the upload (read this before the next walk)

`last-modified` of `/` moved from 15:03:46Z to 17:13:48Z at 17:14Z, which is the brief's check, but the job "Upload Desk static release" (its step "Upload Desk static build to GCS") kept writing files until about 17:19Z: `/practice` was stamped 17:14:37Z. My first D-204 pass, at about 17:14Z, ran against a half-uploaded tree and read the **old** footer (2 text nodes for each sentence, the footer repeating the field's sentence). That pass is discarded; the numbers in this file are from a second pass after the job read `completed` and after I confirmed the bundle: the chunk that holds `threadSubmitHint` contains `new Set(["mode","shares"])` on the new build (the old chunk had the footer built from `Object.values(...).find(...)`). A cheap bundle check for the next walk: fetch the page's own `script[src]` files with `cache: "no-store"` and look for the string the fix added. The "Deploy to the VPS" job was still running when I started; I saw no backend error.

## D-204 (Fixed by `7dc49054`): holds

`/practice`, New thread modal, "Abnormal volume" ticked. One bad value at a time, then the field put back. "Nodes" is the number of text nodes in `document.body` (`createTreeWalker`, `SHOW_TEXT`) that hold the field's sentence; the same numbers at 1440 and 1180.

| Bad value | Sentence at the field (one `role="alert"`) | Nodes | Footer status | Start | Enter | After clearing |
|---|---|---|---|---|---|---|
| Starting balance 500 | "Starting balance: whole dollars from 1,000 to 10,000,000" | 1 | "Starts with a pretend $500. You can change the plan later." | `aria-disabled="true"` | 0 POSTs, modal stays | 0 alerts, Start on, footer back to "$50,000" |
| Start time 03:00 | "Pick a trading day and a time between 4:00 AM and 8:00 PM ET" | 1 | "Starts with a pretend $50,000. …" | off | 0, stays | 0 alerts, Start on |
| Start date 2026-11-03 (after the last finished day, 2026-11-02) | "This session isn't finished yet · replay opens at 4:15 PM ET" | 1 | the hint | off | 0, stays | 0 alerts, Start on |
| Screen size 5 | "Screen size: a whole number from 20 to 49" | 1 | the hint | off | 0, stays | 0 alerts, Start on |
| Max loss 500000 | "Max loss: whole dollars from 1 to 100,000" | 1 | the hint | off | 0, stays | 0 alerts, Start on |

Before any edit the footer already read the hint (Start on). The old build (wave 24, and my discarded first pass on a half-uploaded tree) read 2 nodes for each sentence.

Footer-owned problems, both widths. I did not fill the shared slots (6 of 10 were in use, by other users' threads as well): the capacity answer was set to 10 of 10 in my own tab, and the create call was answered 409 on `mode` with the server's own sentence from `replay/threads.py`.

| State | Footer | Field alerts | Nodes | Start |
|---|---|---|---|---|
| Capacity 10 of 10 | "All 10 thread slots are in use · close a thread to start another" | 0 | 1 | disabled |
| Capacity 10 of 10 and Starting balance 500 | still the slots sentence; the balance sentence is at its field | 1 | 1 (slots) and 1 (balance) | disabled |
| 409 on `mode` after pressing Start | "All 10 practice-thread slots are in use · close a thread to start another" | 0 | 1 | disabled |

Note: the client's sentence says "thread slots" and the server's 409 says "practice-thread slots" for the same state. It only shows on a race (the capacity read says free, the create finds it full), and I could only reach it by forcing the answer, so it is not a row. Screenshots: `d204-before`, `d204-<edit>` for the five edits, `d204-slots-full` and `d204-409`, each at 1440 and 1180.

## D-205 (Fixed by `378f0d6f`): holds

| Step | 1440 and 1180 |
|---|---|
| `/screener/filters`: Average volume days = 3, Create filter | "Average volume days: Must be 5 or more." |
| = 61 | "Average volume days: Must be 60 or less." |
| Rank the matches on, Rank by Relative volume (days), Days = 61 | "Rank by · Days: Must be 60 or less." (one problem; the line starts `Rank by · Days: `) |
| Any "Lookback" text | none |

Sweep (the kit's own labels against the summary line): for every metric option on the Metric, Compared with and Rank by sides of `/screener/filters`, an out-of-range value in each parameter box, then Create filter. 29 boxes (Metric 11, Compared with 11, Rank by 7), at 1440 and at 1180: 0 mismatches, 0 "Lookback". "ATR % vs its median" has two boxes ("ATR length", "Median length"); each is named right on its own on all three sides. `/alerts/new` (the summary is live there): 22 boxes on the Metric and Compared with sides, 0 "Lookback"; three rows my script flagged were my own leftovers (the other box of the same metric was still invalid, or the line had not printed in 600 ms) and each named its box right when re-run alone ("Condition · Metric · Median length: Must be 500 or less.", "Condition · Compared with · Days: Must be 260 or less."). Screenshots: `d205-rank61-1440`, `d205-rank61-1180`, `d205-alerts-new-days61-1440`.

## The fresh pass

Cold loads, 3.5 s settle, 1440 and 1180. Probes: computed type under 11 px (HTML text, and SVG text scaled by `getScreenCTM`), clipped text, unnamed controls, document-level sideways scroll, links to retired routes, day/week/swing/session words, long tasks of 50 ms or more from navigation start.

| Group | Result at both widths |
|---|---|
| `/`, `/today`, `/screener`, `/screener/filters`, `/watchlists`, `/strategies`, `/strategies/library`, `/alerts`, `/technicals`, `/stocks`, `/futures`, `/paper`, `/backtests`, `/holdings`, `/covered-calls`, `/ask`, `/settings`, `/feedback`, `/more` | 0 long tasks of 50 ms or more on every route, page exactly as wide as the window, 0 type under 11 px, 0 unnamed controls, 0 retired links |
| `/practice`, `/practice/screen`, `/practice/thread`, `/practice/replay` (no id) | the same; with no thread each says "No practice thread yet" or, with one, shows the thread picker |
| `/practice/journal` (no id) | goes to `/practice` (the other bare routes show a picker) |
| `/practice/day`, `/practice/week`, `/practice/order` | **404** on direct load at both widths, linked from nowhere |
| Thread surfaces (thread 26/27): Summary, Portfolio (also with an open position), Screen with 30 scanned rows, journal (also the 1180 right strip), replay of SQQQ and SNAP | the same, 0 long tasks on a cold load of each except the replay's warm-cache residue (D-241); replay also checked with a position, with the Chart menu, Full screen and Set stop open |

Practice flows I drove, at 1440 unless noted: Jump forward (0.5 s), a Jump back (refused client-side: "That time is not ahead of the clock · Jump goes forward only", button disabled), Play 5 s (clock +4 s at 1x), Pause (clock stable), 2x (8 s in 5 s), Next open (Mon 9:30 to Tue 9:30), Scan now (34.3, 35.7, 41.4 and 54.7 s; during it the Screen shows "Scanning at 11:00 AM ET · applying your filters to 250 names…" with a bar and a disabled button, and no long task ran), Open, Peek (drawer closes on Escape), Star and Unstar, interval 1m/5m/15m, Chart menu, Full screen (Escape leaves), Levels, Add note, ticket Buy 100 market (fills in 0.55 s), Sell (opens a short), Close position (one click, marks "Practice exit"), Limit with a price (a working order, cancelled from the Orders row), quantity 0, -5, 2.5 and empty ("Quantity: a whole number of 1 or more"), quantity 99,999,999 ("Exceeds buying power · this order costs $4,233,999,958, buying power is $50,000", button disabled), Set stop 5.50 (mark "Practice stop 5.50 · 5.50"), Delete thread.

Wording: "week", "weeks" and "session" appear only where they are right ("52-week breakout", "Session: Regular, Extended", VWAP "from the session", "Session high", the CME and IBKR session notes). "Swing" appears on `/futures` ("Futures swing") and `/backtests` ("Swing · 8 sample symbols"), which are not Practice. Nothing in Practice says day, week, swing or day-trade slots any more. The New thread date sentence still says "This session isn't finished yet" (D-229's wording, Fixed).

Under the "Backtest" mode a stored `desk.lane` of `backtest` makes `/` and `/today` land on `/practice` (that mode's home); with the other modes they stay. I first read that as a bug at 1180 and re-ran both under the fundamental mode: clean.

## D-241 (new): a second visit to the replay still runs one long task

`/practice/replay?id=` (SQQQ, 5m, 2,001 source bars), 1440 x 900, 1x, fresh page per load, long tasks from navigation start, machine load 2.4 to 3.5 on 16 cores (the Mac's Spotlight and `duetexpertd` were busy during the later series).

| Series | Cache | Width | Loads with a task | Tasks (ms @ ms after navigation) |
|---|---|---|---|---|
| 1 | on | 1440 | 2 of 3 | 90 @ 558, 50 @ 514 |
| 2 | on | 1440 | 5 of 10 | 57 @ 523, 55 @ 541, 51 @ 591, 55 @ 493, 60 @ 525 |
| 3 | on | 1180 | 0 of 10 | none |
| 4 | on | 1440 | 0 of 10 | none |
| 5 | on | 1440 | 1 of 10 | 61 @ 463 |
| 6 | on | 1440 | 0 of 10 | none |
| 7 | **off** | 1440 | 0 of 10 | none |
| controls | on | 1440 | 0 of 24 | home 0/5, Summary 0/8, Screen 0/8, journal 0/3 |

Eight of 43 loads at 1440 with the cache on; always exactly one task, always 460 to 590 ms after navigation start. The Long Animation Frames entry of series 5 (frame 453 to 515 ms) lists a `requestAnimationFrame` callback in the chunk that holds `DenseTable` (the pane-fit measure that D-235's wave 22 change moved into `flushSync` inside a frame callback), 41 ms of it forced style and layout, and a 10 ms message handler. It is a residue of D-235 and D-240, which the brief said to file new, not reopen. What I could not settle: why 1180 and series 4 and 6 were clean (the hits came in bursts, series 2 loads 4 to 6 and 9 to 10, which looks like machine contention on a task that sits right at the 50 ms line); a profile on a quiet machine would show whether `DenseTable`'s measure alone is over the line. The row says that.

## D-242 (new): condition number boxes are not `aria-invalid`

On `/screener/filters` and `/alerts/new`, Relative volume with 61 in its Days box: the summary and a line under the row name the box, but the input has no `aria-invalid` and no `aria-describedby`, and the line has no id, while the Average volume days box on the same page has `aria-invalid="true"` and `aria-describedby="filter-avgVolumeDays-error"`. 22 cases (11 boxes at each width) on the Metric side, 0 with either attribute; the Compared with and Rank by sides use the same picker. The Desk's own rule for forms (the field wires one id to the label and one message line) is not met inside `OperandPicker`. A screen reader user is told nothing on the box itself. Screenshot: `walk-operand-invalid-1440`.

## Looked at and not filed

- `/strategies/library`: preset descriptions are cut to two lines (48 px of text in 32), inside a card button. The whole sentence is in the DOM and the card opens the preset; prose, not a value, so not D-157's rule.
- The ticket's order line for a Limit reads "Buy 100 SQQQ · Limit · limit 41.50 · GTC" and the stop mark "Practice stop 5.50 · 5.50": the word or the price is said twice. Copy only.
- A scan on a fresh thread takes 34 to 55 s on live (cold server data). The page says what it is doing and the button is disabled meanwhile, so I did not call it a defect; if the orchestrator wants a time promise on it ("up to a minute", like Skip day had), that is a copy row.
- The alert setup prints the full summary sentence ("Condition · Metric · Days: Must be 60 or less.") under the row as well as in the summary; the filter editor prints only "Must be 60 or less." under it. ADR-0026 keeps the summary-plus-inline pattern as is, so this is the two pages differing, not a double print.
- A replay chart with a position draws two price tags at the same height (average cost and last price both 42.34).

## What I could not reach

- A real full set of thread slots: 4 of the 10 slots were free and others' threads hold the rest, so the footer's full-slots and 409 cases were forced in my tab (the sentences are the real ones). Nothing on the server was filled.
- The 1m replay (6,000 bars) was not measured this time, only 5m; the 4x CPU numbers were not repeated (the brief set 1x).
- D-217 (the new-bar cost on a running replay) and D-239 were not re-walked beyond the incidental reading above.
- Peek, Star, Full screen and the Chart menu were driven at 1440 only; at 1180 I probed the Screen, the replay with a position and the Portfolio, not those overlays.
- The IBKR and quote-state sentences (D-237, D-238) were out of this brief.

## Traps for the next walk

- Wait for the job "Upload Desk static release" to read `completed` (and check the bundle), not for `last-modified` of `/`.
- `page.addInitScript` stays on a page for good: a second observer double-counts every long task, so register one per page or use a fresh `context.newPage()` per measurement (what the load numbers above do).
- A form that has been edited asks the browser to confirm before a `goto`: register `page.on("dialog", d => d.accept())` before sweeping.
- Load numbers differ with the HTTP cache: walk 19's harness disabled it. A returning user has it on, so measure both (D-241 only shows with it on).
- `/` and `/today` follow the stored mode (`desk.lane`): set it before reading their redirect.
