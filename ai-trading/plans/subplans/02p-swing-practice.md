# 02p: Family Desk swing practice: a fixed universe, multi-day practice holds, and a weekly review

Status: **PLANNED (owner-scheduled). Design complete 2026-10-25.** Docs only: no code, migration, or routes exist yet.
Implementation starts after [02r](02r-desk-practice-threads.md) lands **and** the owner says go (STATUS row 5K).
[02q](02q-laptop-migration.md) reserves the number `02p` for this amendment.

Author: design lead (Opus). Implementers: Sonnet and Haiku (§j).

Inputs read: [02r](02r-desk-practice-threads.md) (threads: the wallet, ledger, and stats this mode must reuse);
[02o](02o-desk-replay-practice-plan.md) §1–§6, §a–§k (the replay core, the 02o-b v1 record, and the 02o-b2 deferrals); the
daily-list design (02o-b, Opus, 2026-10-24: as-of screener semantics, the split rebase, the universe, prep cost, and its §8
swing sketch); the replay code on this branch (`replay/session.py`, `plan.py`, `screen.py`, `review.py`, `data.py`,
`journal.py`, `model.py`; migrations `0005` and `0006`; `components/practice/*`).

## What it is (owner's model, 2026-10-25)

The wife practises swing trading inside a **practice thread** (02r) with `mode=swing`. At thread creation she picks a
**fixed universe of up to 50 symbols** and a run of **3 weeks to 1 month of past sessions**. She walks those days forward. A
practice hold she opens on one day can stay open for days and is exited later at a replayed price. The thread uses **the same
wallet as a day-trade thread**: starting balance, ledger, and stats. She is scored **weekly**, not daily.

Day-trade practice (02o-b, 02r) builds a new candidate list each morning and closes every trade the same day. Swing practice
keeps one list for the whole thread and lets trades cross nights. Everything else (the forward-only playhead, marks priced
by the server, the Practice band, no orders) is the 02o core.

## Design decisions

1. **A swing thread is a 02r thread plus one calendar.** `practice_threads.mode = 'swing'`; its calendar is one
   `practice_plans` row (first day, 15 to 23 sessions, the frozen universe, prep, and the day cursor), and each past session is
   one `replay_day_lists` row. The 02o-b machinery (walk-forward cursor, shared day clock, stars, sessions under a day, prep)
   is reused as built. The wallet, ledger, and stats are 02r's, unchanged. The only new money rule is that a practice hold
   credits the ledger at the end of the day it exits.
2. **One sitting is one past day.** She opens the next day and reads the **swing board**: the universe as of the prior
   close, with her open holds pinned at the top. She replays that day's regular session (09:30 to 16:00 ET) at her own pace
   on one shared day clock, then **Ends** the day or **Passes** it unwatched. Open holds carry to the next day; they are
   never auto-exited at a day's end.
3. **Per-day sessions, not a range playhead.** 02o §h item 8 suggested replacing a session's `day` and `window` with a date
   range. Rejected: per-day sessions keep `advance`, the tape, marks, the forward-only playhead, and every lookahead test as
   they are. Multi-day state lives in one new table, `practice_holds`, which links the entry mark on one day to the exit mark
   on a later day.
4. **Price basis.** Overnight, a hold is valued at the **prior official close** (the raw daily bar's close, restated on the
   day's share basis). A trade price on day D is **always a revealed regular-session price**: the first SIP print at or after
   09:30 (tape on), or the 09:30 one-minute bar's close at 09:31 (tape off). The prior close is never a trade price, and
   premarket prints never price a swing mark. The gap is shown as its own number.
5. **No lookahead across days.** Days open strictly in order. All symbols share one day clock. The board, the daily chart,
   and Peek are cut at D−1's close. Holds and the day strip are marked only at revealed prices. A week's review reads nothing
   after that week's last close. A swing day cannot be replayed again inside its thread. Details in §a3.
6. **Practice holds.** At most one hold per symbol; no scaling in and no partial exits. The plan field `maxOpenHolds` (1 to
   5, default 3) is scored. A hard cap of 5 open holds is enforced. A **1x cash rule** applies: open notional, long and short
   alike, may not exceed free cash. There is no margin and no interest (02r).
7. **Stops never exit; play pauses instead.** A stop note is still a note (02o §6: an auto-exit would simulate an order).
   Play, Step, Jump, and End-of-window **pause at the first one-minute bar that crosses an open hold's stop**, gap opens
   included. This is the replay form of a price alert. A stop crossed while she was away (a passed day, or after an early
   End day) is scored at her next watched open.
8. **Corporate actions.** A split restates the hold before the open of the day it takes effect. It uses the same two
   pre-known ratios as `screen.rebase_split`. Dividends are not credited or charged, and the footnote says so.
9. **Universe at creation, frozen, labelled.** Up to 50 symbols (at least 10), in this order: her watchlists and manual adds,
   then optional fills. The fills are a daily filter's matches and a dollar-volume rank, both **as of the close before Day 1**
   and drawn from the Desk set. Each symbol keeps a source tag. Every swing screen carries a survivorship and hindsight label.
   The universe never changes inside a thread.
10. **Weekly review instead of a daily one.** At each replay week's last close the server freezes a week review with these
    parts: P/L split into realized, unrealized, and overnight-gap; week-scoped adherence; **selection quality against the fixed
    universe** (close-to-close rank and edge versus the universe median); **timing** (her prices versus close-to-close);
    filter and source quality; and the SPY and equal-weight-universe benchmarks. A day ends with only a short summary.

## a. How a swing thread day works

### a1. The calendar

- `firstDay` must be a session on or after 2017-01-03 (`screen.EARLIEST_LIST_DAY`, so 52-week filters have history).
  `sessions` is 15 to 23, default 20 (about four weeks). Every session must be finished (`data.check_day` on the last one).
  The default first day is the Monday session about three months back, and dates are hidden by default (the 02o render
  rule: "Day 7 of 20 · Week 2 · Tue").
- **Weeks** are the ISO calendar weeks of the replayed dates. A holiday week has four days, and a partial first or last week
  is labelled "Week 1 · 3 days". A `practice_weeks` row is created when its first day opens.
- The thread's real-world pace is free: a skipped real-world evening changes nothing (02r). The replayed calendar moves only
  when she ends or passes a day.

### a2. The day lifecycle

| Step | What she sees and does | Server |
|---|---|---|
| 1. Open | Thread page → `Continue Day 7` | `POST /replay/daily/next` (with the thread id, 02r) opens the next day. It applies splits that take effect on D to her open holds (§b4). Then it builds the **swing board** (§d1) as of D−1's close and stores it as the day list's `candidates`. With its week's first day it also opens the `practice_weeks` row. When D is the first day of a new week, the client shows the previous week's review first (one click, "Start Week 3"). |
| 2. Board (pre-open) | The 50 names as of the prior close; holds pinned with their prior-close value, stop, days held, and earnings chip; her armed daily filters' matches; Peek (daily chart through D−1). She stars up to 5 **focus** names. | `PATCH /day-lists/{id}` stores stars with the day clock (02o-b). |
| 3. Replay | `Start Day 7` opens the workspace on the first focus name, or on a hold, at 09:30. The shared day clock moves forward only. She switches between focus names and holds freely (§d2). She enters, exits, sets stops, and adds notes with the 02o keys. | 02o `advance`, `feed`, `marks`, plus the swing additions in §f2. Sessions for other names start at the day clock (02o-b `create` already does this). |
| 4a. End day | `End day` at any time. Before 16:00 it asks: "End Day 7 at 11:40? Your 2 holds stay open through the close, unwatched." | `POST /day-lists/{id}/end` ends every session with **no auto-exit**, reveals the day through 16:00, and marks each open hold at D's official close. It records stop crossings after the clock as "while away". It credits the holds that exited today to the ledger (02r end-of-day credit) and stores the day summary (§b6). On the week's last day it freezes the week review (§e). On the thread's last day it closes every hold at that close (§b7). |
| 4b. Pass day | `Pass this day` on the board. It confirms: "Your 2 holds ride through Day 7 unwatched." | The same `end` call on a day list with no sessions. Nothing is markable on that day. |

There is no "Replay this day again" in a swing thread: a second attempt would fork the wallet. After the thread is closed,
a standalone 02o session on any of its days is allowed again (outside every wallet). While a swing day is active, the 02o-b
rule already makes a standalone session on the same symbol and day a 409.

### a3. No-lookahead rules for multi-day holds

1. **Walk forward.** Day N+1 opens only after day N is ended or passed (the 02o-b cursor). Passing is how she skips; a
   passed day still marks her holds at its close.
2. **One day clock.** `replay_day_lists.revealed_through` is shared by every session of the day (02o-b). A name she switches
   to starts at the clock; what lies between is revealed and cannot be marked (the 02o Jump rule).
3. **The board is the prior evening.** Its metrics and filter matches come from daily bars cut at D−1's regular close
   (`screen.cut_frames`), rebased to D's share basis (`screen.rebase_split`). No minute of D is read. Filters armed on a
   swing thread must be daily cadence (`daily_close`). An intraday filter is rejected at creation: "Use a daily filter for a
   swing thread".
4. **The daily chart.** `DayInputs.daily` ends **at** D, so it holds D's own bar, which is the day's outcome. The swing
   `daily` block serves the rebased frame through D−1 plus a **forming** D candle built from revealed regular one-minute
   bars. It never serves D's stored daily bar while the day is active.
5. **Holds and the strip.** A hold's value before anything of D is revealed is the prior close, labelled "prior close". After
   that it is the last revealed regular-session price (decision 4). The strip uses closed one-minute bars at or before the
   clock, as 02o-b designed it.
6. **Reads outside the day.** `GET …/holds`, thread stats, and week reads mark open holds at the **last ended day's close**,
   never at a later day's close. Prep has already cached the later days, so this is a serving rule, and the property test in
   §k pins it.
7. **Week review.** It is computed from data through the week's last close only. A hold still open is valued at that close,
   never at its later exit.
8. **Pausing at stops.** The pause target is the first crossing inside `(previous, to]`. It reveals the crossing exactly when
   the playhead reaches it, as `step: "next_signal"` does, and never earlier.
9. **Earnings chips** show only explicit report dates and times (`days.earnings_events`) within the next 10 sessions. Report
   calendars are published weeks ahead. A gap-derived guess is never shown (the 02o-b rule).
10. **Splits** use only the two ratios that `rebase_split` reads from the effective day's bar. A corporate action is known
    before the open. That day's prices are never read.

### a4. The price basis

| Moment | Price | Label |
|---|---|---|
| Overnight value, the equity curve, the board's hold rows | The official close of D−1: the raw daily close, restated on D's share basis | "Prior close 187.40" |
| Day D, before the first regular price is revealed | The same prior close; marks answer `422` "Market not open yet · step to the first bar" | "Prior close" |
| First markable price on D, tape on | The first eligible SIP print at or after 09:30:00 (the opening print) once the playhead has passed it | "Last 182.10" |
| First markable price on D, tape off | The 09:30 one-minute bar's close, available from 09:31 | "Last 182.35 · one-minute close" |
| Later marks | 02o `last_price`, limited to the regular session: the last print (tape on) or the last closed regular one-minute bar (tape off) | 02o stale-print warning |
| Overnight gap of a carried hold | (first regular price of D − prior close) × shares, with the sign of the side | "Gap −$412" |
| End-of-day value | The official close of D | carried to D+1 |

Swing holds trade in the regular session only. Premarket and after-hours practice are out of v1 (§l). The tape-off price has
one-minute resolution. That is enough for a swing trade, and the footnote says so: "Swing prices are one-minute closes ·
turn the tape on for exact prints".

## b. Practice holds

### b1. The record

`practice_holds` is the record of truth for a multi-day trade. Marks stay per-session annotations (02o). An entry mark
creates the hold, a stop mark updates it, and an exit mark closes it. The hold stores entry and exit (day, time, price,
session, mark), shares, side, the stop at entry (for R), the current stop, `stop_hit_at`, the last close and its day, and
any splits applied.

### b2. Rules (server, `422` problems unless marked)

- An entry needs no open hold on that symbol in this thread, and fewer than 5 open holds (`409` "Five practice holds is
  the most at once"). The symbol must be in the thread universe. Sessions exist only for universe symbols, so this is a
  create-time rule.
- **Cash.** Free cash = the thread balance at the start of the day + today's realized P/L − Σ entry notional of open holds.
  An entry with shares × price > free cash returns "Not enough practice cash · $8,240 free". Shorts are cash-secured: their
  notional counts the same. There is no margin and no interest.
- An exit closes the whole hold on that symbol (one hold, full exit; partial exits stay out, as in 02o §h item 7).
- A stop needs an open hold and a price on the losing side of the last price (02o). It clears `stop_hit_at`.
- Undo (02o: only the last mark, only before the playhead moves): undoing an entry deletes the hold, and undoing an exit
  reopens it.
- The plan limits (`maxOpenHolds`, the week's `maxLossUsd`, `maxTrades`) are scored, not blocked. This follows 02o: "a plan
  warning, not a block".
- **Sizing hint** (02r): shares = `riskPerHoldUsd` ÷ |last − stop|, falling back to 02r's `maxLossUsd`, and capped by free
  cash ÷ last. It is a hint only.

### b3. P/L

- Hold P/L = (exit − entry) × shares for a long, (entry − exit) × shares for a short. R = P/L per share ÷ |entry −
  stop at entry| when a stop existed at entry. Prices and shares are restated by any split.
- Unrealized at the clock = the same formula at the revealed price. At a close it uses the official close.
- **Balance** (02r) = starting balance + Σ ledger rows. A hold's ledger row is written when the day it exits ends.
  **Equity** = balance + Σ open holds' unrealized at the last close. The thread shows both. The balance never contains
  unrealized P/L.
- Day attribution for the review: **gap P/L** (the carried holds' overnight gaps), **intraday P/L** (the rest of the day's
  change), and **realized** (the holds closed today, in full).

### b4. Splits and dividends

- When day D opens, for each open hold: r(d) = raw close(d) ÷ split-adjusted close(d) (`History.split_daily` plus the raw
  daily frame that prep already holds), and k = r(D−1) ÷ r(D). If k ≠ 1: shares × k (rounded down; "cash in lieu not
  modeled"), entry, stop, stop at entry, and last close ÷ k, and an entry in `splits`. The board row reads "Split 10-for-1
  before today's open · 100 shares are now 1,000 at 120.38". It is a pure function with one golden test (a 10:1 split mid-hold,
  for a long and a short).
- Dividends: not credited or charged. On an ex-dividend morning the price drops by the dividend and the holder is not paid.
  The board and review footnote says "Dividends are not credited in practice". Ceiling recorded in §l.

### b5. Stops: the pause

- In `advance` for a swing session with open holds, the server scans the one-minute bars of **every** open-hold symbol in
  `(previous, target]`. A long is crossed when the low ≤ its stop, and a short when the high ≥ its stop. Only holds whose
  `stop_hit_at` is null count. The server clamps `target` to the close of the first crossing minute, sets that hold's
  `stop_hit_at`, and returns `paused: {symbol, stop_price, at, price}`. The client stops playback and shows "NVDA crossed
  your stop 182.50 at 11:42 · Exit or keep". A gap open reads "NVDA opened below your stop 182.50 at 179.10".
- One pause per stop note: a new stop mark clears `stop_hit_at`.
- End day reveals the rest of the day without pausing. Crossings found there, and on passed days, are recorded as **while
  away** in the day summary.

### b6. The day summary (`replay_day_lists.journal` for a swing day)

`{passed, realized_usd, gap_usd, intraday_usd, unrealized_change_usd, balance_usd, equity_usd, holds: [marked at the close],
stop_hits: [{symbol, at, watched}], late_stars: [...], entries, exits}`. The board's ended state shows it as one strip of
tiles. The weekly review is the place to read it properly.

### b7. End of thread

- On the last day's `end`, every open hold exits at that day's official close: `exit_source: 'auto'`, no mark (the exit
  mark id is null, because there may be no session for that symbol that day). The ledger is credited and the final week is
  frozen. The thread reads "Finished · Day 20 of 20", and the plan row is archived. She then closes it with 02r's close.
- Closing early (02r close): it needs no active day (`409` "End Day 7 first"). Open holds exit at the last ended day's
  close, the same way. The partial week is frozen as "Week 3 · 2 of 5 days".

## c. Universe selection at thread creation

### c1. The form (the 02r thread form with mode Swing)

The 02r fields stay as they are: starting balance (default 50,000), the risk plan, and mode. **Swing** reveals one section:

1. **Days:** first day (native date input, default the Monday session about 3 months back), sessions (15 to 23, default
   20), hide dates (default yes). One line: "20 sessions · 4 weeks · ends on day 20".
2. **Universe:** a builder with a live table and these sources:
   - **Your watchlists:** a checkbox per list ("Swing seed · 6", "Day movers · 8"). It is instant.
   - **Add symbols:** `SymbolField` search, and remove from any row. It is instant.
   - **Fill from a filter** (optional, up to 3 of her daily filters or presets, for example "New 20-day high"): matches as
     of the close before Day 1, in filter-rank order.
   - **Fill by liquidity** (default on): the Desk set ranked by 20-day average dollar volume as of the close before Day 1,
     after the live floor (`screen.passes_floor`: $5, 500,000 shares).
   - **Target size:** default 50, 10 to 50.
   Fill order: watchlists, then manual adds, then filter matches, then liquidity; duplicates removed; capped at the
   target. Each row shows its source tag, prior close, 20-day change before Day 1, average dollar volume, and ATR%. It also
   shows warnings: "below floor" (allowed for her own picks only) and "not enough data for the whole range" (excluded,
   listed under the table with that neutral reason, which reveals no later event).
3. **Swing plan:** `maxOpenHolds` (1 to 5, default 3), `riskPerHoldUsd` (optional), interval (`15m` default or `5m`), tape
   (`Off` default or `On`), and armed strategies (up to 5: daily filters for board matches, alert strategies for intraday
   would-fire bells).
4. `Start swing thread`.

### c2. Data for the fills

- The filter and liquidity fills need as-of daily bars for the pool (the Desk set, `plan.practice_universe`, capped at 250,
  about 133 above the floor today). The first preview starts a background **pool prep**: `screen.asof_frames` for Day 1, two
  requests per symbol (raw and split). That is about 270 requests, roughly 2 minutes at the measured 127 requests a minute,
  run once per first day. The blobs are write-once and shared with every later plan.
- Progress needs no table. The preview counts the pool's cached as-of frames. A restart re-kicks the prep on the next
  preview call, which is idempotent. The form says "Preparing as-of data · 96 of 133 · watchlist and manual picks are ready".
- Pool and thread prep use the 02o-b v1 pattern (API-process background, no scheduler slot). After creation, the thread prep
  loads one-minute bars for the 50 names over the sessions plus 10 lookback sessions. The measured cost for 50 symbols × 31
  sessions is 171 requests and 24 MB. It also loads the daily raw and split frames for the 50 plus **SPY** as the benchmark
  (outside the universe). Day 1 is ready first.

### c3. The label (every swing screen: board footer, setup, week review)

> Fixed universe · 50 symbols chosen today from the symbols the Desk tracks now. Stocks that were delisted or renamed since
> Day 1 cannot appear, so the list leans toward survivors. Your watchlists are today's lists: a name may be on them because of
> moves you already know about.

The thread line keeps the mix: "50 symbols · 9 watchlist · 2 manual · 6 New 20-day high · 33 liquidity · as of the close
before Day 1 · survivors only". The universe is frozen on the plan row (`{source: "swing", symbols: [{symbol, source}],
basis_day, frozen_at}`) and never changes inside the thread.

## d. Session cadence

### d1. The swing board (the day list screen, swing variant)

- Header: "Day 7 of 20 · Week 2 · Tue · as of the prior close · Balance $51,240 · Equity $52,010 · SIMULATED".
- **Holds** (pinned rows): symbol, side, shares, entry (Day 3 · 184.20), days held, stop, prior close, unrealized, R at the
  prior close, earnings chip, split note.
- **Universe** (`DenseTable`, 50 rows): source tag, prior close, change 1d / 5d / 20d %, ATR% 14, RSI 14, daily RVOL 20d,
  % from the 20-day high, % versus the 50-day average, **Matches** (her armed daily filters at that close), and earnings chip.
  The table reuses the daily fields of `metric_row`. The default sort is filter matches, then source, then dollar volume.
  Stars go in the first column.
- **Peek** (`PeekPanel`, daily only, cut at D−1) for the selected row.
- `Start Day 7` and `Pass this day`.

### d2. The day strip and switching

- **Focus:** up to 5 stars (`plan.MAX_WATCH`), placed on the board or later. A late star is allowed and scored (§e3).
  Entries are allowed only on focus names and held names, which are the only ones on the strip.
- **The day strip** (workspace left rail, at most 10 rows): every open hold and every focus name, each showing the last
  price at the clock, the change from the prior close, and for a hold its unrealized P/L and stop distance. A row whose stop
  paused the clock is amber. Clicking a row **switches**: it opens or resumes that name's session at the day clock.
- Switching is allowed with open holds: multiple holds are the point of swing. The 02o-b v1 rule of one name a day and one
  open trade a day applies to day threads only. This builds the 02o-b2 "switch protocol and watch strip" for swing; day
  threads can adopt the same code later.
- **One chart, one tape** (multi-chart stays a non-goal). The chart toggles **Daily · 15m · 5m**. Daily is the rebased
  frame through D−1 plus the forming D candle (§a3 rule 4), with her hold's entry marker and stop line spanning the days.
- **Tape** off by default (`tape_feed = 'off'`: no prints fetched, marks priced at one-minute closes). A thread created with
  tape on behaves as 02o: chunks are fetched only around the playhead of the focused name.
- **Speed and jumps:** the 02o transport plus `+1 hour` and `to the close` in the Jump menu (both are plain `to` values).
  The step at 15m is 26 bars a day. Every advance can pause at a stop (§b5).

## e. The weekly review

Frozen into `practice_weeks.review` at the end of the week's last day, from data through that close only. An open week
serves "Week to date" through the last ended close, computed on read with the same function.

### e1. Contents (`/practice/week?thread=&week=`)

- **Tiles:** week realized, unrealized change, equity change, balance, win rate and average win / average loss (holds
  closed this week), average days held, gap share of P/L, adherence %, **Selection** (points versus the universe median),
  **Timing** (points), and the benchmarks (SPY and the equal-weight universe for the week).
- **Equity chart:** balance and equity at each close from Day 1, with this week shaded (`MarketChart` line panes).
- **Days table:** day, weekday (date hidden), watched or passed, entries, exits, realized, gap, intraday, adherence. A row
  opens that day's board in its ended state.
- **Holds table** (every hold active in the week): symbol, side, shares, entry day and price, exit day and price or "open
  · Fri close", days held, P/L, R, gap P/L, stop (set / honored / crossed while away), selection rank, timing.
- **Universe heat strip:** the 50 names sorted by week return, with her holds and focus names highlighted. This is the
  selection picture at a glance.
- **Adherence** checklist (§e3), notes, rating 1 to 5, and `Start Week 3` (it opens the next day).

### e2. Selection and timing (pure, `replay/week.py`)

Returns use split-adjusted closes, so they are correct across a split. Dividends are excluded, as everywhere else.

- **Universe week return** u(s) = close(week's last day) ÷ close(the session before the week's first day) − 1, for each
  of the 50. The review reports the median, the equal-weight mean, and SPY.
- For each hold active in the week, the **span** runs from the close before its entry day (or the week's start, if
  earlier) to the close of its exit day (or the week's last close, if later):
  - **Selection edge** = the side-signed close-to-close return of its symbol over the span − the universe median over the
    same span. **Rank** = its place among the 50 by side-signed return ("ranked 4th of 50").
  - **Timing edge** = her side-signed return over the span (entry price → exit price, or → the span's last close) − the
    symbol's close-to-close return over the span. A positive value means her entry and exit beat simply holding close to
    close.
- **Focus names she did not trade:** the rank of their return from the star day's prior close to the week's last close
  (informational).
- **Filter quality:** the median return of names her armed filters flagged on the week's boards (flag day's prior close →
  the week's close) against the universe median. **Source quality:** the median week return by source tag ("Watchlist
  +1.4% · liquidity +0.3%").
- Tile copy: "Selection +1.8 pts vs the universe median · your holds ranked 4th, 11th and 23rd of 50 · Timing −0.6 pts".

### e3. Adherence (week scope; `score_pct` = passed ÷ applicable, the 02o rule)

| Check | Applies when | Passes when |
|---|---|---|
| Stop on every entry | plan `stopRequired` | every hold opened this week had a stop at entry |
| Stop honored | a stop was hit this week | the exit came within one display bar of the first moment she could act: the crossing itself when watched, or the first regular bar of her next watched day when away |
| Risk per hold | `riskPerHoldUsd` set | shares × \|entry − stop at entry\| ≤ `riskPerHoldUsd` |
| Open holds within plan | always (`maxOpenHolds`) | never more than `maxOpenHolds` open at once |
| Week loss limit | plan `maxLossUsd` (week scope in swing) | no entry after the week's realized P/L reached −`maxLossUsd` |
| Entries per week | plan `maxTrades` (week scope in swing) | entries this week ≤ `maxTrades` |
| On a signal | plan `signalOnly` | the symbol matched an armed daily filter on that day's board, or the entry came within 3 display bars after an armed intraday would-fire (02o) |
| Focus before the open | any entry this week | every entry was on a hold or on a name starred before the day's first reveal (02o-b) |

The 02r plan fields keep their names. In a swing thread `maxLossUsd` and `maxTrades` count per week, and the form says so.

## f. API, contracts, and schema (additive on 02r)

Conventions are 02o §b: everything under `/api/desk/replay`, `get_current_user`, rows scoped to the user (404 otherwise),
`422 {"detail": {"problems": [...]}}`, and `Cache-Control: no-store`. No path contains `order`, `position`, or `broker`.
The paths below assume 02r puts its routes at `/replay/threads`; if 02r lands another prefix, swing follows it.

### f1. New endpoints (5)

| # | Method and path | Screen | Purpose |
|---|---|---|---|
| 1 | POST `/replay/threads/swing-universe` | setup | Preview only, no write. Body `{first_day, sessions, watchlist_ids[], filter_ids[] (≤ 3, daily cadence), fill: "liquidity" \| "none", add[], remove[], target}`. Returns `{basis_day, state: "ready" \| "preparing", prep: {done, total}, rows: [{symbol, source, prior_close, chg_20d_pct, avg_dollar_volume_20d, atr_pct_14, matched[], warnings[]}], excluded: [{symbol, reason}], counts, survivorship}`. Every metric is as of `basis_day`. The first call starts the pool prep (§c2). |
| 2 | GET `/replay/threads/{id}/holds?status=open\|closed\|all` | thread, week | Holds with P/L. Open holds are marked at the last ended day's close (§a3 rule 6). |
| 3 | GET `/replay/threads/{id}/weeks` | thread | Week rows: number, days, status, realized, equity change, adherence, selection, timing. |
| 4 | GET `/replay/threads/{id}/weeks/{week_no}` | week | The frozen review, or "Week to date" for the open week. |
| 5 | PATCH `/replay/threads/{id}/weeks/{week_no}` | week | Notes and rating only. |

### f2. Changes to existing endpoints (additive fields and swing-only branches)

| Endpoint | Change for a swing thread |
|---|---|
| 02r POST threads | **Activation:** accepts `mode: "swing"` with a `swing` block (`SwingSetupV1`). Until 02p ships, the server answers `422` "Swing practice is not open yet" (02r keeps the enum value, so activation is a server change only). It validates days, universe coverage, and daily-cadence arms; creates the plan row; and starts prep. |
| 02r GET thread | Adds `swing: {day_no, days, week_no, weeks, holds_open, free_cash_usd, equity_usd, equity_series: [{day_no, day, balance_usd, equity_usd}], next: "day" \| "week_review" \| "finished"}`. The series stops at the last ended day. |
| 02r close thread | Auto-exits open holds at the last ended close (§b7). Returns `409` while a day is active. |
| `POST /daily/next` (with the thread id, 02r) | For a swing thread: applies splits to holds, builds the swing board (§d1), and opens the week row. |
| `GET /day-lists/{id}` | Adds `swing: {holds, board_columns, week_no, free_cash_usd}`. An ended day adds the summary (§b6). |
| `PATCH /day-lists/{id}` | Unchanged (stars, at most 5). |
| `POST /day-lists/{id}/sessions` | Swing: a second, third, … name is allowed (no 02o-b v1 `409`). The symbol must be a focus name or a hold. The spec is built with window 09:30–16:00 regular, the swing interval, and `tape_feed` `off` or `sip`. |
| `POST /day-lists/{id}/end` | Swing: no auto-exit; marks at the close; ledger credit; week freeze; thread end. On a day with no sessions it is **Pass**. |
| `POST /sessions/{id}/advance` | Swing: the stop clamp and `paused` (§b5); `strip: [{symbol, last, chg_pct, hold?: {side, shares, unrealized_usd, stop_price}}]`; `daily_forming` when the display is Daily. |
| `GET /sessions/{id}/feed` | Swing: `daily: {bars (rebased through D−1), forming}` and `strip`. |
| `POST /sessions/{id}/marks`, `DELETE …/marks/{mark_id}` | Swing: the hold rules (§b2), a regular-session price only, and a `hold` object in the response. |
| `GET /sessions/{id}` | `open_trade` is the symbol's hold at the clock, plus `opened_day_no`, `days_held`, and `gap_usd`, so the 02o open-trade card works unchanged. `journal` for a swing session lists its marks and the holds closed in it; adherence is null with "Scored weekly". |

Route count: +5 on top of 02r (69 today, plus 02r's about 5, plus 5 is about 79).

### f3. Contract (`contracts/src/practice-thread-v1.ts`, 02r's file, an extra `$def`)

```ts
export const SwingSetupV1Schema = z.strictObject({
  firstDay: IsoDaySchema,                                    // ≥ 2017-01-03 and a session (server rules)
  sessions: z.int().min(15).max(23),                         // 3 weeks to a month; default 20
  hideDates: YesNoSchema,                                    // default "yes"
  universe: z.array(z.strictObject({
    symbol: StockTickerSchema,
    source: z.enum(["watchlist", "manual", "filter", "liquidity"]),
  })).min(10).max(50),                                       // unique symbols (superRefine)
  interval: z.enum(["5m", "15m"]),                           // default "15m"
  tape: z.enum(["off", "on"]),                               // default "off"
  armed: ArmedRefsSchema,                                    // ≤ 5; filters must be daily cadence (server rule)
  maxOpenHolds: z.int().min(1).max(5),                       // plan, scored; default 3
  riskPerHoldUsd: z.int().min(1).max(100_000).optional(),
}).meta({ id: "SwingSetupV1" });
// PracticeThreadV1 (02r): mode: z.enum(["day", "swing"]); swing: SwingSetupV1Schema.optional(),
// with superRefine: swing is required when mode is "swing" and absent otherwise.
```

`ReplaySessionV1`, `PracticeMarkV1`, and `PracticeBlockV1` are unchanged. A swing session stores a server-built
`ReplaySessionV1`. Fixtures in `valid/` and `invalid/`: 9 and 51 symbols, a duplicate symbol, 14 and 24 sessions, an unknown
source, mode swing without the block, and the block on a day thread.

### f4. Migration `0008_swing_practice` (after 02r's `0007_practice_threads`; additive, `downgrade()` reverses it)

| Table | Columns |
|---|---|
| `practice_holds` (new) | `id`, `thread_id` FK `practice_threads` (cascade), `owner_user_id` FK `users` (cascade), `symbol`, `side` (`long\|short`), `shares int`, `entry_day date`, `entry_at`, `entry_price numeric`, `entry_session_id` FK null, `entry_mark_id` FK null, `stop_at_entry numeric null`, `stop_price numeric null`, `stop_hit_at null`, `status` (`open\|closed`), `exit_day null`, `exit_at null`, `exit_price null`, `exit_session_id` FK null, `exit_mark_id` FK null, `exit_source` (`her\|auto`) null, `last_close numeric null`, `last_close_day date null`, `splits jsonb` default `[]`, `created_at`, `updated_at`. Unique `(thread_id, symbol) WHERE status = 'open'`; index `(thread_id, status)`. |
| `practice_weeks` (new) | `thread_id` FK (cascade), `owner_user_id` FK (cascade), `week_no int`, `first_day date`, `last_day date`, `status` (`open\|closed`), `review jsonb null`, `notes text null`, `rating smallint null` (1–5), `created_at`, `closed_at null`. PK `(thread_id, week_no)`. |
| `practice_ledger` (02r) | Adds `hold_id int null` FK `practice_holds`. A swing row's `session` is the exit session, which is null for an auto exit at a close. |

There are no changes to `replay_sessions`, `replay_day_lists`, or `practice_marks`. Their jsonb columns carry the swing
shapes, and `tape_feed` has no CHECK, so `'off'` needs no migration. The same pull request adds the runtime-role grants
(`docker/postgres/zz-20-desk-roles.sh`, `tests/test_db_roles.py`), the migration tests, and the ORM models. Lock order for
every swing write: day list → session → thread → holds. This extends the 02o-b order, so `advance`, `marks`, and `end`
cannot deadlock.

## g. Backend modules (`backend/src/ai_trading/replay/`)

| Module | New or extended | Responsibility | Tests |
|---|---|---|---|
| `holds.py` | new (pure core + small DB layer) | hold state rules, P/L and R, free cash, split restatement, stop-cross scan over one-minute bars, mark at a close | golden: long, short, gap through the stop, a split mid-hold, auto exit at the thread end, cash refusal, cap of 5 |
| `swing.py` | new | the universe preview and pool prep; the swing board (cut daily frames, `metric_row` daily fields, daily filter matches, earnings chips, holds pinned); swing branches of `start_session` and `end_day`, Pass, and the thread end | the board equals itself when every bar after D−1's close is replaced; daily-cadence-only arms; the fill order; neutral exclusion reasons |
| `week.py` | new (pure) | the week review (§e) from the day summaries, holds, ledger, and the universe's split-adjusted closes | golden review; identical when every bar after the week's last close is replaced; selection and timing signs for shorts |
| `session.py` | extended | swing branches: `create` (fixed window, `tape_feed` off); `advance` (stop clamp, strip, daily forming); `feed` (daily block); `place_mark` and `undo_mark` (through `holds`); `end` (`via_day`, carry); `last_price` limited to the regular session and skipping the tape when off | the 02o lookahead property test extended to the strip, the daily block, and holds across two days |
| `plan.py` | extended | `open_next`, `start_session`, and `end_day` dispatch on `spec["mode"] == "swing"` to `swing.py`; `run_prep` loads the swing universe plus SPY | existing tests unchanged |
| threads module (02r) | extended | swing activation; the `swing` stats block; close with auto-exit; ledger rows with `hold_id` | ledger reconciles to the holds |
| `api/replay.py`, `api/schemas/replay.py` | extended | the 5 routes and the additive fields | 401 walk, ownership 404, no-orders route test |

## h. UI screens (desktop first; 1440 and 1180)

| Screen | Route | What differs from the day-trade screens |
|---|---|---|
| Hub card | `/practice` (02r "Your threads") | "Swing · 50 names · Week 2 of 4 · Day 7 of 20 · Balance $51,240 · Equity $52,010 · 2 holds open · `Continue Day 7`", or "Week 1 review ready" |
| Thread setup | the 02r thread form, mode Swing | the Swing section of §c1 with the universe builder and the label |
| Thread journal | 02r thread page | the swing variant: a balance **and** equity curve, a week table linking to reviews, open holds, and `Continue` |
| Swing board | `/practice/day?id=` (swing variant of `DayListScreen`) | §d1: holds pinned, the 50-row universe as of the prior close, Matches, Peek daily only, `Pass this day`, no list-time chips and no review panel; an ended day shows the summary strip |
| Swing workspace | `/practice/replay?id=` | header with balance, equity, free cash, and day and week; the left rail **Day strip** (holds plus focus) replaces Day watch and keeps the swing plan checklist (open holds 2 of 3, week loss, entries this week); the chart toggle Daily · 15m · 5m with multi-day hold markers; tape off by default ("Tape off · swing prices are one-minute closes"); the stop-pause toast; End day says "2 holds stay open overnight"; the open-trade card shows days held and gap |
| Weekly review | `/practice/week?thread=&week=` (new) | §e1 |

**Frontend components** (new unless marked): `practice/swing/SwingSetupSection`, `UniverseBuilder` (`DenseTable`, source
chips, `SymbolField`, survivorship note), `SwingBoard`, `HoldsTable`, `DayStrip`, `ChartIntervalToggle`, `StopPausedToast`,
`WeekReview` (`SummaryTiles`, the equity chart on `MarketChart` panes, `DaysTable`, `HoldsTable`, `UniverseHeatStrip`,
`AdherenceChecklist`, `NotesAndRating`). Extended: `DayListScreen` (variant switch), `ReplayWorkspace`,
`PracticeControls` (cash and sizing hint), `JumpMenu` (`+1 hour`, `to the close`), `EndPrompt`, `PracticeHub`. Logic
with node tests in `lib/replay/`: `swing.ts` (hold labels, free cash, gap text, pause handling), `weekView.ts`,
`universeView.ts` (fill order and counts as displayed), loaders and zod, and copy rows in `lib/desk/freshness.ts`. The
banned Practice words (**order, position, filled, broker, execute**) also cover swing copy, so the UI says "practice hold",
never "position".

## i. Paper boards (file TobyTest, page "R3 · Desktop · Technical MVP")

The runs duplicate the D1 shell groups and the Practice groups that run PA named, plus 02r's wallet header from its hub
board. **Rows:** the next two free rows below 02r's boards. These are expected at y = 58400 and 61200 (step 2800) after PD1
and PD2 and 02r's rows. Each run first reads the bottom edge of the row above (02o §e rule) and records any move.

| Board | Name | Size | Model, run |
|---|---|---|---|
| PS1 | `R3 · Practice · Swing thread setup · desktop` | 1440 × 900 | Sonnet, PSA |
| PS2 | `R3 · Practice · Swing board · desktop` | 1440 × 900 | Sonnet, PSA |
| PS3 | `R3 · Practice · Swing workspace · desktop` (the template) | 1440 × 900 | Sonnet, PSA |
| PS4 | `R3 · Practice · Swing week review · desktop` | 1440 × 900 | Sonnet, PSB |
| PS5 | `R3 · Practice · Swing states · desktop` | 1440 × 900 | Haiku, PSC |
| PS6 | `R3 · Practice · Swing workspace · desktop 1180` | 1180 × 820 | Haiku, PSC |
| PS7 | `R3 · Practice · Swing week review · desktop 1180` | 1180 × 820 | Haiku, PSC |
| (edit) | 02r hub board: one swing thread card beside the day card | n/a | Haiku, PSC |

**7 new boards** (4 Sonnet, 3 Haiku) plus one card edit. PS5 shows: pool prep in progress, an excluded symbol, not enough
cash, the cap of 5, the stop pause (watched and at a gap open), the End day confirm with holds, the Pass confirm, the split
note on the board, "Market not open yet", thread finished with auto exits, and the open week's "Week to date".

**Run R0s (Sonnet, no Paper, throwaway under `ai-trading/temp/desk-swing/`, keys only through
`common/config/family_config.py run ai-trading/desk -- …`).** It builds a real universe as of a real basis day through the
pool prep and fill path. It loads 4 weeks of real daily and one-minute bars for the 50 and SPY, and picks a range that
contains a real split in the universe (for example NVDA's 10-for-1, effective 2024-06-10). It computes one real hold
through a gap open and one through the split. It records request counts, prep seconds, and blob sizes (counts only in the
run JSON). Real on the boards: the universe, metrics, matches, bars, gaps, the split, and the week returns. SIMULATED: her
holds, marks, notes, and every wallet number built on them. Every board shows the Practice band.

## j. Implementation order, models, and gates

Opus wrote this design and reviews only on request. Streams follow 02m §d1 (S: `backend/`, `common/`, `contracts/`; F:
`frontend/`). Commits stack, with one pull request at the end of the phase (the Actions-minutes rule).

**Owner gates.** G1: the owner schedules 02p and says go. Nothing below starts without it. G2: the owner and the wife approve
PS2 and PS3 before PSB, PSC, and the workspace frontend. G3: the acceptance week with the wife (§k) before swing is
announced. 02r must be merged before any code step: the wallet, ledger, threads, and migration `0007` are inputs.

| Step | Owner | Work | Depends on | Gate |
|---|---|---|---|---|
| 0 | Opus | this design | n/a | done |
| 1 | Sonnet (no Paper) | **R0s** real-data run (§i) | Alpaca reads only; it may run before 02r merges | G1 |
| 2 | S: Sonnet; Haiku for fixtures | `SwingSetupV1`, the bundle, regenerated Pydantic, crosscheck | 02r contract merged | G1; then immediate |
| 3 | S: Sonnet; Haiku for grants and migration tests | `0008_swing_practice`, ORM | 2 | immediate |
| 4 | S: Sonnet, test first | pure `holds.py` and `week.py` (golden and replace-later-data tests) | none (pure); parallel to 2–3 | immediate |
| 5 | S: Sonnet, test first | `swing.py` (preview, pool prep, board, day end, Pass, thread end) and the `session.py`/`plan.py` branches (stop clamp, strip, daily block, hold marks, regular-session pricing); the lookahead property test across days | 3, 4 | immediate |
| 6 | S: Haiku, reviewed by Sonnet | routes and schemas, the stub fixture (a 2-week thread over 5 symbols with one gap and one split, trimmed from R0s), `pnpm gen:api`, OpenAPI committed. **F starts here.** | 5 | immediate |
| 7 | Sonnet (PSA, PSB), Haiku (PSC) | Paper runs (§i) | R0s; 02r's Paper boards | G1 (the single Paper writer); **G2 after PSA** |
| 8 | F: Sonnet for `SwingBoard`, `DayStrip` and switching, the workspace variant, `WeekReview`; Haiku for loaders and zod, copy rows, `UniverseBuilder` table, the hub card, `swing.ts`, `weekView.ts`, `universeView.ts`, 1180 priorities | frontend | 6; the board and workspace after G2 | G2 |
| 9 | Both, Sonnet | integration with the stub off; Playwright at 1440 and 1180: create a swing thread → day 1 enter 2 holds → End day → day 2 gap → stop pause → exit → Pass day 3 → week review; acceptance | 5, 8 | G3 |

So once G1 is given and 02r has merged, steps 2 to 6 start at once with no further owner input. R0s needs only G1. The
Paper runs wait for the Paper writer and G2, and the user-facing activation waits for G3.

## k. Tests and acceptance

- **Lookahead across days (the core guarantee):** a property test drives random advances, switches, End days, and Passes
  over a 2-week fixture. It asserts the following. No strip, daily, or hold value is later than the clock. While a day is
  active, no board, Peek, or daily-block value comes from D or later. `GET holds`, thread stats, and week reads never use a
  close after the last ended day. The day clock never decreases. A swing day cannot get a second attempt.
- **Replace-later-data:** the board for D, and the review for week W, are identical when every bar after D−1's close (or
  the week's last close) is replaced. This is the 02o-b pattern.
- **Price basis:** a mark before the first regular price returns `422`. The first markable price is the opening print (tape
  on) or the 09:30 bar close at 09:31 (tape off). A premarket print never prices a swing mark. The gap equals the first price
  minus the prior official close.
- **Holds:** the golden cases in §g; one open hold per symbol; the cap of 5; the cash refusal (long and short); undo of an
  entry and of an exit; one stop pause per stop note, including at a gap open; a crossing while away; a split restates
  shares and prices with unchanged P/L; dividends untouched.
- **Ledger:** a hold credits the ledger only when its exit day ends, with `hold_id`; the balance reconciles to the ledger;
  equity = balance + open holds at the last close; an early thread close auto-exits at the last ended close.
- **Universe:** the fill order; an intraday filter is rejected; the excluded reason is neutral; the preview is identical
  before and after the pool prep for watchlist and manual picks; the label is present on every swing screen.
- **Existing walks:** the 401 walk, ownership 404 on holds and weeks, and the no-orders route test cover the 5 new routes
  unchanged. Contracts: Zod, Pydantic, and crosscheck over the new fixtures.
- **Frontend (node tests in `lib/`):** pause handling in the player (playback stops and no request is stacked); strip
  labels; free cash and sizing hint; week view selection and timing signs; copy rows against the banned and Practice word
  lists.
- **Acceptance (G3):** she completes one full replay week, holds at least 2 names across at least 2 nights, and one of
  them through a gap. The owner hand-checks one carried hold's P/L from the daily closes and the exit price. The browser's
  network log shows no strip, daily, or hold data past the clock. One hold's selection rank matches a hand calculation from
  the week's closes.

## l. Non-goals and ceilings

- **Orders of any kind** (02o §g): no order objects, no automatic stop or target exits, no broker path. The stop pause is a
  pause, not an exit.
- **No margin, interest, borrow fees, dividends** (label only; ceiling: an ex-dividend morning understates a long's P/L by
  the dividend, about 0.2 to 1% of price), or cash in lieu on odd splits.
- **Regular session only:** no premarket or after-hours swing marks. Ceiling: an after-hours earnings exit cannot be
  practised. Add an `extended` swing window if she asks.
- **No scaling in, partial exits, or more than 5 holds.** No universe changes inside a thread. No second attempt of a swing
  day. No hourly interval (Daily, 15m, and 5m cover it). No multi-chart view. No mobile. No options or futures.
- **Automated backtesting** stays out: the week review scores her own holds over days she watched or passed. It never runs
  a rule across the universe on its own.

## m. Dependencies on 02r (to settle when 02r is built)

1. `PracticeThreadV1.mode` carries `"swing"` from the start, rejected by the server until 02p. Activation is then a server
   change only.
2. `practice_plans` gains `thread_id`, and the "one active plan" index becomes **one active plan per thread**, so a day
   thread and a swing thread can run at the same time. If 02r keeps the per-user index, `0008` replaces it.
3. The ledger credits at the end of the day (02r's rule) and allows a null session (an auto exit at a close). `0008` adds
   `hold_id`.
4. The thread header (balance, today's P/L) is one component, which swing extends with equity and free cash.

## n. Open questions for the owner (only true owner decisions)

1. **G1: schedule.** When does 02p start after 02r lands? Recommend right after her first two weeks on a day thread, so the
   wallet has been used once before it carries holds overnight.
2. **The cash rule for the shared wallet.** Swing enforces 1x cash (open notional ≤ free cash; shorts cash-secured). Should
   02r day threads use the same rule? **Recommend yes:** "the same wallet" should mean the same buying power, and today
   nothing stops a $500,000 day-trade entry on a $50,000 balance. This is decided in 02r.
3. **Confirm with your wife at the G2 review:** regular-hours-only holds, tape off by default, and one universe frozen for
   the whole thread. Recommend all three. Each is a small switch later, not a redesign.
