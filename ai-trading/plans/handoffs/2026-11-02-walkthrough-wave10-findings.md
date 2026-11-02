# Walkthrough wave 10: the Practice desk on `dev` (`f6461baf`)

Date: 2026-11-02. New defects D-179 to D-185 (7: P0 0, P1 0, P2 0, P3 7). Nothing was fixed in this lane.
Wave-9 verification: D-169 to D-178 all hold on the live screen, at 1440 and at 1180. Two of them leave a neighbour that is filed as new
(D-182 beside D-176, D-183 beside D-164 and the week route); neither reopens the old row.

Screenshots are not in the repository; the names below are files in the run's `walk-10/` directory (outside the repo, next to the run's copy of this report).
A name ending `-1440` or `-1180` is the viewport width; `-tall` is the same screen on a 2,600 px viewport. Each screenshot has a `.json` next to it with
the probe facts (clipped text, scrollers, type under 11 px, unnamed controls, banned wording, the main region's text). `walk-10/evidence/` holds the sampling
logs, the 18 throwaway specs and the throwaway Playwright config that produced them (none of them is in the commit).

## How it was run

- Cut: `origin/dev` `f6461baf` (dev had not moved since the brief). Worktree `practice-walk-10`, branch `feature/practice-walk-10`.
- Harness: the Desk e2e stack through `tests/e2e/run.py --browser -- …` exactly as `e2e/README.md` describes for "Without Docker": a disposable
  `desk_e2e_<hex>` database in another session's tmpfs `desk-test-postgres` container (`DESK_E2E_ADMIN_DATABASE_URL`, loopback), the static export built from this
  worktree (`pnpm build`), `browser_server.py` and `proxy.mjs` on ports 19444 and 19445, `--output=/tmp/w10/pw`. No Docker, no `pnpm test:e2e`. Each run's database was
  dropped by `run.py`, except the one the run I killed left behind, which I dropped by hand.
- One trap cost a run: the repository's Playwright config sets no `actionTimeout`, so a throwaway `click().catch(() => {})` on a missing control waits for the whole
  test timeout (400 s). The first full run was stopped for that reason and rerun through `-c playwright.walk.config.ts` (the repo config plus `actionTimeout: 10000`).
- 18 throwaway specs drove it at 1440 x 900 and 1180 x 820: 190 snapshots (284 images including the `-tall` ones) in `walk-10/`. Spec 12's last line (a log write)
  threw in both projects after every screen had been read; its output was printed first and is in `evidence/`.
- Seeds: `technical` (the live surfaces), the stub replay day (TSLA, Fri 2026-09-25, 09:30 to 09:40 ET) for day threads, the swing world `S01` to `S12` for the swing board,
  week review and swing journal.
- Clock: most specs use the harness's frozen browser clock. Every clock-agreement claim (D-172) was sampled in a second browser context with a real browser clock.
- No snapshot showed banned wording (`bannedWordingOnScreen`), a document-level horizontal scrollbar, type under 11 px or an unnamed control. The probe's `clipped` list
  held only visually hidden 1 px spans ("Actions", "Up-tick", "Down-tick", "Same price", ":") and two ellipsis cases that are on purpose (company names in the 95 px
  left-rail cell at 1440; alert condition text in the Alerts list). I read screenshots at 1440 for the landing, the modal (day and swing), the Summary, the day list, the replay, the journal, the week review, the swing board,
  `/today`, `/screener`, `/watchlists`, `/strategies`, `/settings` and `/feedback`; at 1180 for the day list, the replay with its Practice drawer, the Summary after Show date,
  the journals and their drawers, the week review, the swing board and modal, the day review, `/today` and `/screener`. The other 1180 screens (landing, the day modal,
  the Summary with a position, `/watchlists`, `/strategies`, `/settings`, `/feedback`) I read as page text and probe facts.

## Wave-9 verification (D-169 to D-178)

| ID | Verdict | Route and steps | Proof (screenshots in `walk-10/`) |
|---|---|---|---|
| D-169 | Fixed | `/practice/thread?id=`, Day 1 open, Buy 100 TSLA at 09:32, step to 09:35, Summary, Play 10x for 3 s, Pause, sample at rest, while playing, and 0.3, 1.5, 4 s after the pause. The headline Open P/L and the TODAY card's "1 open …" agree at every sample: 1440 −$791, −$870 (playing), −$792, −$792, −$792; 1180 −$791, −$866, −$772, −$772, −$772. The End day confirm no longer prints an open figure, so it cannot disagree with the card. | `31-summary-10x-1440`, `33-summary-paused-after-10x-1440`, `53-summary-nodates-after-10x-{1440,1180}-tall`, `55-end-day-confirm-1440`; `evidence/mismatch-{1440,1180}.txt` |
| D-170 | Fixed | Buy 100 TSLA, step to 09:36, Summary: "EQUITY $49,778.00", "Open P/L −$222.00 at the clock · Balance $50,000.00", then "Started with $50,000 · realized $0.00 · open P/L −$222.00". No "no change yet" with a position open (it still appears with nothing open, which is true). | `23-summary-long-open-{1440,1180}` |
| D-171 | Fixed | `/practice/journal?thread=` (Trades) on a day thread and a swing thread: the rail row reads "Day thread · Oct 15" / "$50,000.00 SIMULATED" / "Active · Day trading" (swing: "$50,626.00 SIMULATED" / "Active · Swing") on three lines, whole, at 1440 and 1180; `clipped` is empty for the rail. Also whole in the journal drawers at 1180. | `25-trades-long-{1440,1180}`, `73-journal-trades-{1440,1180}`, `93-swing-journal-{1440,1180}-tall`, `74-journal-drawer-improvement-1180` |
| D-172 | Fixed | `/practice/replay?id=` in a second context with a real browser clock, thread playing at 1x, 5x and 10x, thread readout, status-bar "Replay clock" and top chip sampled every 100 ms for 6 s (60 samples per speed, both widths): 0 of 60 disagree in all six cells (before: 27 to 30 of 60). The fixed-clock 5x run: 0 of 80 at both widths. At 1x the readout advances one clock second per real second (series in `evidence/walk13-*.txt`). | `32-replay-10x-{1440,1180}`, `54-replay-5x-{1440,1180}`; `evidence/real-clock-{1440,1180}.txt`, `evidence/clock5x-*.txt` |
| D-173 | Fixed (as filed: the day review ranking table). The brief calls D-173 "rail status wraps"; that is D-171 and is verified above. | `/practice/day?id=` after End day: at 1440 the "Ranked by move" table shows Rank, Symbol, Yours, List price, Move to window end, High after open, Low after open, all whole; at 1180 it also shows Move to close, all whole; `scrollers` and `clipped` empty. | `56-day-review-{1440,1180}-tall`, `111-day-review-hidden-yes-{1440,1180}` |
| D-174 | Fixed | Hide dates Yes, Day 1 open, replay, Show date: the chip reads "Replay · Fri 2026-09-25 · 9:33 AM ET" and the Summary clock reads "Fri, Sep 25 · 9:33:00 AM ET" with "Next session starts Mon, Sep 28 · 9:30 AM ET" (before Show date it read "Fri · …" and "Mon · …": D-155 still holds). | `120-replay-show-date-{1440,1180}`, `121-summary-after-show-date-{1440,1180}`, `35-summary-after-skip-{1440,1180}` |
| D-175 | Fixed | Summary with a day open and a position: the three-figure Equity grid is gone; the Thread clock card carries one "Buying power $12,506.00 SIMULATED" row and the hint in the muted size; the three figures live in the headline and its line only. | `23-summary-long-open-{1440,1180}`, `33-summary-paused-after-10x-1440` |
| D-176 | Fixed | New plan, Any close, Start, Summary at once: TODAY says "Preparing data · 28 of 53 names" and "The first list opens when the data is ready. You can leave this page."; the PLAN card says only "Any close". One status, one card. The clock card beside it is filed as D-182. | `05-thread-summary-before-day-{1440,1180}` |
| D-177 | Fixed | `/practice/replay?id=` left rail: "PACE · 10 SECONDS" over "Busy · 6.5x usual", each one line (118 px wide, `lines=1`) in the 279 px rail at 1440 and the 239 px rail at 1180. | `20-replay-long-1m-{1440,1180}`, `132-replay-long-{1440,1180}`; `evidence/walk13-*.txt` |
| D-178 | Fixed | `/practice/week?thread=&week=2` on a swing thread: the hold table's column reads "P/L SINCE ENTRY" (S04 +$831.00) beside tiles UNREALIZED CHANGE +$429.00 and EQUITY CHANGE +$429.00; $831.00 − $402.00 (Week 1's change) = $429.00, so the figures reconcile. | `95-week2-{1440,1180}-tall` |

Counts: fixed 10, not fixed 0, could not exercise 0.

## New defects

### D-179 · P3 · Practice / landing Today line with an open position

- Surface: `/practice` (the thread table's LAST DAY cell). 2026-11-02.
- Steps: Start a plan, open Day 1, open TSLA, Buy 100, step three bars (PRACTICE P/L −$791.00 on the chart), open `/practice`.
- Seen: "Today / $0.00 · 0 trades" beside "$50,000.00 SIMULATED", with nothing about the open trade. At 1180 the LAST DAY column is dropped by priority, so the figure is not on screen at all.
- Expected: the day's figure says what it holds: "$0.00 realized · 1 open −$791.00". The Summary, the Portfolio and the replay header already give the open figure.
- Screenshots: `133-landing-open-position-1440`, `134-landing-day-and-swing-1440`, `132-replay-long-1440`.
- Design checked: `design-multi-position.md` item 14 (LEW-0: "the thread card's Today line gains · 2 open +$200"); D-158 (the replay header's "realized today"). `ThreadTodayOut` (backend `api/schemas/threads.py`) carries only `trades` and `pnl_usd`.

### D-180 · P3 · Practice / chart time axis first label

- Surface: Peek drawer on `/practice/day?id=` and `/practice/replay?id=` at 1180 with the Practice drawer open.
- Seen: the first axis label is cut at the left edge: Peek at 1440 reads "0 AM" (04:00 AM) then 05:00 AM, 06:00 AM; the 1180 replay chart (pane about 520 px) shows one label, ":30 AM". Whole at 1440 with both rails and at 1180 with the drawer closed.
- Expected: a label is whole or absent.
- Screenshots: `130-peek-1440`, `22-position-panel-1180`; crops in `evidence/crop-axis-1180.png`, `evidence/crop-peek-axis.png`. Peek at 1180 was not read.
- Design checked: ADR-0020 (Peek drawer, level labels) and `design-component-system.md`: silent on axis labels.

### D-181 · P3 · Practice / chart annotations collide with their series

- Surfaces: `/practice/week?thread=&week=2` (swing), `/practice/journal?thread=` on a swing thread and on a day thread. Both widths.
- Seen: the week chart's "Equity $51,457.00" tag sits over the "$51,500" y tick; the swing journal's "Starting balance" is crossed by the dashed Equity line and markers; the day journal's "After day 1 $49,246.00" has the Balance line drawn through it.
- Expected: end labels and the start label clear of ticks and lines.
- Screenshots: `95-week2-{1440,1180}-tall`, `93-swing-journal-{1440,1180}-tall`, `73-journal-trades-{1440,1180}`.
- Design checked: `.claude/rules/ui-primitives.md` (`MiniChartFrame` owns box, grid and y labels; end labels are not mentioned).

### D-182 · P3 · Practice / thread Summary while data prepares

- Surface: `/practice/thread?id=` right after Start. Both widths.
- Seen: TODAY says "Preparing data · 28 of 53 names" (no Start button yet; "Replace plan" disabled with no reason), while the Thread clock card says "No day is open yet. Start the next day to get a clock."
- Expected: while preparing, the clock card says the clock starts with the first day once the data is ready, and Replace plan carries the same reason.
- Screenshots: `05-thread-summary-before-day-{1440,1180}`.
- Design checked: D-084 and D-176 (same state); ADR-0018 gives no wording for it. Source: `ThreadClockPanel.tsx:107`, `NextStep.tsx:94`.

### D-183 · P3 · Practice / weekly review and not-found wording

- Surface: `/practice/week`, with `/practice/order`, `/practice/thread`, `/practice/replay`.
- Seen: `?thread=999` says "No practice thread selected"; `?thread=<existing>` without `week` says it too; `?thread=<swing>&week=0` says it; `?thread=<day thread>&week=99` says "Weekly reviews are for swing threads"; `?thread=<swing>&week=99` says "Week 99 has not started yet". "Pick a thread to open its journal" also appears on the order, thread and replay routes.
- Expected: D-164's pattern: a missing thread is "not found"; a missing week says which week to open.
- Screenshots: `150-1-edge-*` to `150-6-edge-*`; `evidence/walk15-*.txt`, `evidence/walk16-*.txt`.
- Design checked: the D-164 ledger row is the only rule; the wave-8 and wave-9 handoffs say nothing of the week route.

### D-184 · P3 · Practice / End day lands scrolled

- Surface: `/practice/thread?id=` then `/practice/day?id=` at 1180.
- Steps: thread with TSLA practised, Summary scrolled 200 px, End day, Yes, end day.
- Seen: the review arrives at scrollTop 24 (page 744 px in a 720 px region), so the tab strip starts 24 px under the amber band. Tab clicks land at 0, and so does End day at 1440, where the review fits.
- Expected: a new screen starts at the top.
- Screenshots: `170-after-end-day-offset200-1180`, `111-day-review-hidden-yes-1180`; `evidence/walk17-1180.txt`.
- Design checked: no doc covers scroll on navigation.

### D-185 · P3 · Screener / preview chart with no bars

- Surface: `/screener` at 1440, first row (BOLT) selected, on the seeded `technical` world.
- Seen: an empty plot (TradingView mark and a lone axis line) and "Chart data table · 0 source bars"; no sentence says the name has no price history. At 1180 the Preview is a collapsed strip and was not opened. World-dependent: the seed carries bars for SPY, NVDA and MSFT only.
- Expected: "No price bars for BOLT yet".
- Screenshots: `101-screener-1440`.
- Design checked: 02l and 02m state no empty-chart wording.

## Clean: screens and flows that held up

- `/practice` landing empty, with a day thread, with a day and a swing thread; New plan modal, day and swing, window error wording (D-160), 1440 and 1180.
- `/practice/day`: one column set from first paint, whole values at both pane widths (1440: Prev change %, ATR %, RSI; 1180 adds Prev vs VWAP %), list time and footer after a Re-scan (all say 9:30 AM), Open and Peek and a click on a row cell all reach the chart or the drawer, the Portfolio view with the $ and % switch (per ADR-0020 the % view switches the row figures), the ladder weekday ("Day 2 · Mon").
- `/practice/thread`: Summary clock with Hide dates Yes and No, Equity headline arithmetic (50,000 − 222 = 49,778), Buying power with a working order ($50,000 − 10 × 370 = $46,300 at both widths), Skip day and End day confirms, Day 2 after a skip.
- `/practice/replay`: header "realized today", chart header and status bar agree, VWAP one value on 1m, 5m and 15m, Position panel labels apart, the ticket's market, limit, stop and stop-limit entries with field messages, a working limit buy, a short and Close position, the quantity checks ("a whole number of 1 or more"), the buying-power refusal.
- `/practice/week`, `/practice/journal` day and swing, Improvement, Thread plan and Close thread drawers at 1180, `/practice/order` with the stock search and its empty answer.
- `/today`, `/screener`, `/watchlists`, `/strategies`, `/settings`, `/feedback` (empty): no banned wording, no order control, tables whole at both widths, an empty `/feedback` that says why its filters are off.
- Not defects, on purpose: the market and alert status lines repeat in the top bar, the page and the status bar (`02l` §c3 puts the freshness vocabulary in all three); the 1180 day list shows one more column than 1440 (columns drop by pane width, the D-157 ruling); the Skip day confirm books the position at the day's last price while End day books it at the clock (the confirm says so).

## Could not exercise

- A swing thread past Week 2 with a closed hold (only the held-open case), Peek at 1180, the Screener preview at 1180, and any real-data or live-feed state (the stub day covers only Fri 2026-09-25, so Day 2 of a block shows its "No symbol could be scanned" empty state).
