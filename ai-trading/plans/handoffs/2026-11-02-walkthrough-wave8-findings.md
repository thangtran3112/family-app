# Walkthrough wave 8: the Practice desk on `dev` (`f5a429d0`)

Date: 2026-11-02. Defects D-155 to D-168 (14: P1 0, P2 3, P3 11). Nothing was fixed in this lane.

Screenshots are not in the repository; the screenshot names below are files in the run's `walk-8/` directory. A name ending `-1440` or `-1180` is the viewport width;
`-tall` is the same screen on a 2,600 px viewport (the shell scrolls inside its frame, so this shows the part below the fold).

## How it was run

- Harness: the Desk e2e stack (disposable Postgres database, test API, `proxy.mjs`, static export built from this worktree), brought up
  once and kept running, against an existing loopback Postgres maintenance database (no Docker). A throwaway Playwright config and 16
  throwaway specs drove it at 1440 x 900 and 1180 x 820; the clock is the harness's frozen clock plus the thread's own server clock.
  The specs and the config are deleted before the commit.
- Every snapshot was checked by script for banned wording (`bannedWordingOnScreen`, the `expectCleanScreen` list), clipped or
  overflowing text, type under 11 px, unnamed controls and page-level horizontal overflow. No snapshot showed banned wording, a document-level
  horizontal scrollbar or an unnamed control.
- Seeds: `technical` (the live surfaces) and the stub replay day (TSLA, Fri 2026-09-25, 09:30 to 09:40 ET) plus the swing world
  (`S01` to `S12`) for Practice. Numbers below were hand-checked against the figures on screen where noted.
- Reading depth at 1180: every screen was loaded, screenshotted and probed by script at both widths, but I read the screenshot itself at 1180 only for
  03, 06, 11, 13, 16, 25, 26, 41, 43, 45, 66, 150, 162, 200, 201 and 202. For the rest, only the script facts (clipping, overflow, wording) stand behind
  the 1180 column of this report; the 1440 screenshots were read for everything listed as seen below.

## Defects

### D-155 · P2 · Practice / thread clock / hide dates

- Route: `/practice/thread?id=<n>` (Summary tab), with a thread made with Hide dates "Yes" (the modal's default).
- Steps: Practice, New plan, leave Hide dates on Yes, pick a filter, Start. Open Day 1 (Start Day 1). Open the Summary tab.
- Saw: "THREAD CLOCK  Fri, Sep 25 · 9:30:00 AM ET" and "Next session starts Mon, Sep 28 · 9:30 AM ET". After Skip day the Summary reads
  "Mon, Sep 28" and "Next session starts Tue, Sep 29". On the same thread the chart band says "Day hidden so it cannot spoil the session"
  (with Show date), the header chip says "Replay · hidden day · 9:30 AM ET", the Day list says "Date hidden", the journal says "start date hidden",
  and the modal promises "Hides the calendar dates, so you cannot tell which day you are practicing until you finish it".
- Expected: while the day is open and Hide dates is Yes, the Summary clock shows the time without the calendar date (as the chip does),
  or hides it behind Show date. The date is revealed after End day (D-029, D-100).
- Screenshots: `12-summary-day-open-paused-1440.png`, `13-summary-playing-5x-1180.png`, `73-after-skip-confirmed-1440-tall.png`.
- Design checked: ADR-0018, "The clock shows a full date and ticks" (full date on the clock); it does not mention Hide dates. D-023, D-029 and
  D-100 set the rule that the date stays hidden until the day ends. The two rules meet here and neither wins on paper: owner ruling needed.

### D-156 · P2 · Practice / thread Summary balance label

- Route: `/practice/thread?id=<n>` (Summary) with an open position; also `/practice/replay?id=<n>` and the Trades tab.
- Steps: open the TSLA chart, step to 09:33, Buy 100, step to 09:37, open the Summary.
- Saw: the headline "BALANCE $49,761.00" with "Open P/L −$239.00 at the clock · Balance $50,000.00" under it; the Equity block on the same card
  reads "Balance $50,000.00 · Equity $49,761.00". The Trades tab reads "Balance now $50,000.00" and the chart header reads
  "Thread balance $50,000.00". One word, two numbers.
- Expected: one meaning for "Balance". The headline is equity (ADR-0018 says on purpose: "The Summary shows equity as the live balance"), so
  it should be labelled Equity, or the other places should say what they hold.
- Screenshots: `30-summary-with-long-1440.png` (tall at 1440), `29-trades-with-long-1440.png`, `25-chart-7bars-long-1440.png`.
- Design checked: ADR-0018, "Balance" (line 27). The number is by design; the label is the defect.

### D-157 · P2 · Practice / day list columns cut or off screen

- Route: `/practice/day?id=<n>` (Day 1 open, one candidate), wait one second after load.
- Saw at 1440: the table is 1,524 px in an 808 px pane (14 columns, sticky ACTIONS at x 962 to 1104). PREV RVOL is cut under ACTIONS (the header
  reads "PREV", the value reads "0"); PREV CHANGE %, ATR %, RSI, VOLUME NOW, GAP % NOW, VS VWAP % NOW and SINCE are off screen. At 1180 the table is 1,028 px
  in an 868 px pane; FILTERS, VOLUME NOW, GAP % NOW, VS VWAP % NOW and SINCE are dropped, but PREV CHANGE % is still cut ("PREV CHANGE", "−0.57" with
  the "%" gone) and ATR % and RSI are off screen. No cue other than a hairline. The columns D-018 added (Prev RVOL, Prev change %) are the ones lost.
  Same family: the swing board's last header is a lone "$" clipped at 1440 (`44-swing-board-day1-holds-1440.png`), the Trades fills table cuts
  "Opened or added" to "Opened or ac" at 1180 while the Close thread drawer is open (`162-close-thread-confirm-1180.png`), and the Screener's SINCE column is
  off screen at 1440 (pane 808 of 900).
- Expected: a priority rule that fits the pane (drop by pane width, not viewport width), or no value cut mid-glyph.
- Screenshots: `150-day-list-settled-desktop-1440.png`, `150-day-list-settled-desktop-1180.png`, `160-day-list-after-rescan-1440.png`.
- Design checked: D-136 (wide tables: scroll cue, hide empty columns) is marked Fixed; this is the same table after the Price now columns (#334)
  made it wider.

### D-158 · P3 · Practice / "today" next to a live loss

- Route: `/practice/replay?id=<n>` (and the day list header), with an open position.
- Saw: "Thread balance $50,000.00 · today $0.00" while the same header's PRACTICE P/L reads −$239.00 and the Portfolio reads "Day P/L −$239.00
  (realized $0.00 · open −$239.00)". After the position closes the header says "today −$239.00". "today" is realized only and the label does not say so.
- Expected: "realized today", or include open P/L.
- Screenshots: `25-chart-7bars-long-1440.png`, `26-portfolio-long-dollar-1440.png`, `62-day-review-1440-tall.png`.

### D-159 · P3 · Practice / day list headers change after load

- Route: `/practice/day?id=<n>`.
- Saw: the first paint (about 150 ms) shows LIST PRICE, PREV CLOSE, PREV RVOL, and so on; about 400 ms later the headers become PRICE AT LIST, PRICE NOW,
  VS PREV CLOSE % NOW, PREV CLOSE, and so on (three columns added, one relabelled) and the explanatory line "Price now follows the day clock" appears. The table
  re-lays out under the pointer.
- Expected: one column set from the first paint (reserve the columns, or show a skeleton).
- Screenshots: `06-day-list-1440.png` (first set), `150-day-list-settled-desktop-1440.png` (settled set).

### D-160 · P3 · Practice / New plan modal prints a schema path

- Route: `/practice` then New plan.
- Steps: tick Abnormal volume (List time moves to 10:00 and Start at to 10:00), set Focus until to 09:20.
- Saw: under Start at, and again in the footer: "window.from must be before window.to".
- Expected: a sentence ("Focus until must be after Start at"). The UI rules say never print a schema path (`ui-primitives.md`, Forms; `lib/desk/problems.ts`).
- Screenshot: `138-modal-window-end-before-start-1440.png`.

### D-161 · P3 · Practice / Your threads rail truncates the name

- Route: `/practice/journal?thread=<n>` (the Trades tab).
- Saw: the thread card in YOUR THREADS reads "Day thr…" with "Active · …" at 1440 and "D…" with "A…" at 1180: the name gets 61 px (1440) and 21 px (1180) of
  the 120 px it needs, because the balance and the SIMULATED pill take the row. The same on the swing thread ("Swing t…").
- Expected: the name on its own line, or the pill and balance below it.
- Screenshots: `16-trades-tab-empty-1440.png`, `16-trades-tab-empty-1180.png`, `48-journal-2weeks-1440-tall.png`.

### D-162 · P3 · Practice / Position panel: value overprints the label

- Route: `/practice/replay?id=<n>` with an open position (the right rail at 1440, the Practice drawer at 1180).
- Saw: "Unrealized" and "−$239.00" collide: the value's minus sign is drawn over the final "d" of the label. At both widths.
- Expected: a gap between the label and the value (the label column is 48 px wide for a word that needs about 58 px).
- Screenshots: `25-chart-7bars-long-1440.png`, `25-chart-7bars-long-1180.png`, `161-position-panel-long-1440.png`.

### D-163 · P3 · Signals copy says strategies are watching when none is

- Routes: `/practice/replay?id=<n>` (Signals) and `/today` (Today's signals).
- Saw: the Practice rail reads "No signals yet · your armed strategies are watching" on a new thread, where none is armed (D-153: new plans start with none
  armed). Today reads "No signals yet today · your strategies are watching" while all five strategies are Draft and the banner above it says
  "Alerts start when live quotes are connected".
- Expected: say nothing is armed or watching when that is the case.
- Screenshots: `11-chart-open-1440.png`, `200-live-today-1440.png`, `203-live-strategies-1440.png`.

### D-164 · P3 · Practice / empty and missing-id states disagree

- Routes: `/practice/thread`, `/practice/order`, `/practice/replay?id=999`, `/practice/journal?thread=999`, `/practice/day?id=999`.
- Saw: with no id, `/practice/thread` and `/practice/order` say "No practice thread with that number · open one from Practice" (no number was given), while
  `/practice/journal` says "No practice thread selected · Pick a thread to open its journal" and lists the threads. For an id that does not exist
  (the API answers 404), `/practice/day?id=999` says "That practice day was not found", but `/practice/replay?id=999` says "Couldn't load this session · Try again"
  and `/practice/journal?thread=999` says "Couldn't load this thread · Try again": a retry for something that is not there.
- Expected: one pattern: "not selected" with a way to pick, "not found" with a way back, and "Try again" only for a failed load.
- Screenshots: `84-route-_practice_order-1440.png`, `85-route-_practice_thread-1440.png`, `83-route-_practice_journal-1440.png`,
  `87-route-_practice_replay_id_999-1440.png`, `90-route-_practice_journal_thread_999-1440.png`, `86-route-_practice_day_id_999-1440.png`.

### D-165 · P3 · Practice / re-scan leaves the old clock statements

- Route: `/practice/day?id=<n>`, press Re-scan now at the 09:30 day clock.
- Saw: the header says "Scan 1 · run at 9:30 AM ET · data through 9:15 AM" and the source line "up to 9:15 AM ET", but the note still says "Every other column
  is fixed at the 8:30 AM ET list until the market opens", the footer still says "List built 8:30 AM ET" and "Day lists built before the open". Three clock statements on
  one screen (the D-144 shape).
- Expected: one list time that updates after a re-scan.
- Screenshot: `160-day-list-after-rescan-1440.png`.

### D-166 · P3 · Practice / footer clock lags the thread readout

- Route: `/practice/replay?id=<n>` while the clock runs at 10x.
- Saw: "Thread time 9:32:25 AM ET" in the thread bar and "Replay clock 9:32:05 AM ET" in the footer on the same screen (20 clock seconds apart); the header chip shows only
  "9:32 AM". The readout ticks every second, the footer and chip move with the poll.
- Expected: one source for the visible clock, or a label that says which is polled.
- Evidence: the clock-sync probe (walk 12, CHART-b); screenshot `133-chart-running-1440.png`.

### D-167 · P3 · Feedback / empty state asks to select a report

- Route: `/feedback` with no reports.
- Saw: the right rail reads "REPORT · Select a report to see its details" while the list says "No reports yet"; the status chips look active beside the line
  "Reason: filters turn on once there is a report to filter".
- Expected: no empty "select" prompt (or a rail that says there is nothing to select); chips that look disabled.
- Screenshot: `205-live-feedback-1440.png`.

### D-168 · P3 · Practice / VWAP changes with the chart interval

- Route: `/practice/replay?id=<n>` at the 09:35 thread clock, switch the interval under the chart.
- Saw: the header's VWAP and the left rail's VWAP row read 377.74 on 1m, 376.55 on 5m and "—" ("Warming up") on 15m, for the same stock at the same minute. On 15m the first
  VWAP appears with the second regular-session bar (09:45), after the 09:30 to 09:40 practice window has ended, so a 15m chart has no VWAP for the whole window.
- Expected: one session VWAP for the minute (or a note that it is built from the chart's bars and a 15m chart needs two bars first).
- Screenshots: `102-chart-menu-1440.png` (1m, 377.74), `100-chart-5m-1440.png` (5m, 376.55), `101-chart-15m-1440.png` (15m, "—").
- Design checked: D-154 (the browser's VWAP follows the backend's `session_vwap` on the same bars). The bar dependence is that fix's consequence; the empty 15m row is what a trader notices.

## Not filed (looked wrong, is a stub artifact or by design)

- The VWAP line is drawn as a straight slope across the pre-market on the stub day (`121-pan-1-dragged-right-1440.png`). The stub's lookback bars carry no
  `ext` flag, and lightweight-charts breaks a line at a whitespace point (checked in its docs), so real bars should not do this. Worth one look on real data.
- Day-list "Only 1 of the 4 scanned symbols met…", "No symbol could be scanned · 52 had no price data": the stub has bars for one name.
- Screener preview chart empty ("Chart data table · 0 source bars") for BOLT: the `technical` seed has bars for SPY, NVDA and MSFT only. A real empty chart
  would still need a sentence, but this seed cannot show whether it has one.
- "Open Day 1" on the swing board of Day 1, "Resume on the Summary" on the chart, End day only on the Summary: the last two are #332 and #334 on purpose.

## Clean: what held up

Read at 1440; at 1180 the same screens loaded and passed the script checks (see "How it was run" for which 1180 screenshots I read).

- `/practice` landing: empty state, a day thread, a swing thread, after Day 1 ("Day 1 done", win rate 0%, "−$239.00 · 1 trade", Start Day 2), after Skip day. At 1180 the Last day column is dropped by the priority rule.
- New plan modal (day and swing): filters, days, hide dates, list time, interval; Start disabled with a reason for no filter, a balance of 500 or 999,999,999, and a window
  that ends before it starts (the sentence aside: D-160). Escape asks first.
- `/practice/thread`: Summary before a day (preparing data), with a day open (paused, running at 5x and 10x), after End day and after Skip day (Days table with weekday, balance
  over the days); the clock ticked +120 s in 12 s at 10x and kept running across Day list, Portfolio, chart and Summary. Skip day shows its inline confirm and Day 2 opens
  on "Mon" with the ladder reading Fri, Mon, Tue, Wed, Thu, Fri, Mon, Tue, Wed, Thu.
- Portfolio: empty and with a long; the $ and % switch ("−$239.00" and "−0.64%", hand-checked: −2.39 / 374.94). Order tab (find box, Switch). Trades tab fills.
- `/practice/replay`: indicators left (RSI, MACD, VWAP, EMA 9 and 21 values matched their rows), tape; ticket right (Buy and Sell, quantity, order type with "Bracket · not simulated yet"
  disabled and described, quantity 0 and 100,000 accepted into the label, Buy 100 TSLA); position panel numbers (avg 374.94, last 372.55, unrealized −$239.00, P/L −$239.00 hand-checked);
  Marks line; intervals 1m, 5m, 15m (VWAP aside: D-168); Chart menu (type, overlays, levels, Reset to defaults); Full screen and Escape; Set stop (Stop loss field, Save, Cancel); the Limit order type adds a Limit price field. Panning back in time and stepping three bars kept the view (#336 holds).
- Day review after End day: "1 practice trade · −$239.00", Long 100, 374.94 in at 9:33, 372.55 out at 9:37, 4m, −0.64%, balance $50,000.00 to $49,761.00 (hand-checked).
- Re-scan: disabled with its reason, then "Re-scan finished · the list above is scan 1 · 1 of 1 matched · 0 new in this scan" (clock statements aside: D-165). Peek drawer opens.
- Swing: board (focus names, holds, universe table), week 1 review (realized +$626.00 plus unrealized +$402.00 is equity change +$1,028.00; the open-hold unrealized and week 2 equity change
  −$416.00 = $50,612.00 − $51,028.00 hand-checked), journal after two weeks (realized +$1,285.00 = +$626.00 + +$659.00).
- Journal for a day thread: balance and result charts, weeks rail, Improvement with one week ("Too few days to call a trend yet", SIMULATED pill, the 3-day caveat: D-041's one-week state).
- Bare and wrong routes: `/practice/day` with no id opens the open day; `/practice/replay` and `/practice/week` with no id; `/practice/week` for a day thread explains "Weekly reviews are for swing threads".
- Live surfaces (`/today`, `/screener`, `/watchlists`, `/strategies`, `/settings`, `/feedback`): all load with no banned wording, no document overflow and no unnamed control. At 1180 the Screener drops
  VOLUME and ATR %, Watchlists drops RVOL and BIAS. Settings shows the trading toggles disabled with "Trading is off in the Desk". The feedback form opens from "Report a problem" with the screen and route captured.

## Not exercised

- The Improvement table with two weeks of day-thread practice days: the stub holds one replay day, so a day thread cannot reach two weeks of practice days (D-041's table state was not on screen).
- Limit, Stop and Stop-limit orders were selected (the ticket's fields were looked at) but not placed; no stop crossing; no run of the clock past the 09:40 window end.
- The sub-1100 px mobile shell; a real Clerk sign-in; real provider data (every figure is the seed's).
