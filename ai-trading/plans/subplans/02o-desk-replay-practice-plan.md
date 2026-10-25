# 02o: Family Desk Practice (Replay) lane: replay past days, read the tape, test strategies by hand

Status: planned 2026-10-24 (docs only; nothing activated). **Owner priority (2026-10-24): this lane goes ahead of the remaining
Fundamental-lane mock runs.** The Practice mock runs (R0, PA–PC, §e) take the single Paper writer before 02n's F1–F6; 02n's F0 was
gated on the Monday 2026-10-26 Flex move anyway (02n §g decision 7), and Practice needs only Alpaca history, which works today.

Implementation (2026-10-24): the backend stream (steps 3a–3d) and the frontend stream (step 4) are complete and integrated on
`feature/desk-beyond-mvp-2`, pending the integration gates and the pull request. The step 5 Playwright Practice specs pass at 1440 and
1180 against the stub (`DESK_REPLAY_STUB=1`); the stub-off real-data run and the §i acceptance checks are still open.

02o-b v1 (daily-list practice, 2026-10-24) is built on top of that tree on `feature/desk-replay-daily`; see §k.

It extends the deployed Technical-lane desktop MVP ([02l](02l-desk-desktop-first-mvp.md), [02m](02m-desk-mvp-implementation-spec.md),
STATUS 5D–5F) and reuses its shell, bands, `DenseTable`, `MarketChart` markers and panes, the copy table, `useDeskQuery`, the stub-first
stream order, and the contracts pipeline ([02k](02k-desk-strategy-config-contracts.md)). Nothing here redesigns them.

Inputs read: 02m §a1–§a3, §b1–§b3, §b6, §c, §d, §e; 02l §a, §c3, §d; 02k §1–§3, §9–§10; 02n §b1, §c, §g–§i (branch
`feature/desk-fundamental-plan`, STATUS 5H); the code on `dev` (`core/evaluate.py`, `screener/evaluator.py`, `data/bars.py`,
`ai_trading_common/providers/alpaca.py`, `components/charts/MarketChart.tsx`, `lib/chart-data.ts`, `components/workspace/*`,
`lib/lanes.ts`); Mobbin (§j); and one read-only Alpaca probe (decision 2).

## Who it serves and what she does

The wife day-trades and swing-trades US stocks and already uses the Technical-lane desktop MVP. She wants to **learn and practise
on real past market data**: replay a past day bar by bar, read the tape (time and sales), and try strategies by hand, with no real
orders and no automated backtesting. A session goes:

1. **Pick** a symbol and a past day (from her notable-days list or any date), an intraday window, a chart interval, the strategies to
   arm, and a short plan (shares, stop rule, max loss).
2. **Replay.** The chart advances bar by bar (play, pause, 1x/2x/5x/10x, step, jump); the tape shows that day's real prints up to the
   playhead; armed strategies show where they *would have* fired, as the playhead reaches each bar close.
3. **Practise.** She marks practice long and short entries, exits, stop notes, and notes with the keyboard (`B`, `S`, `X`, `T`, `N`).
   Every mark is labelled Practice and is priced at the replayed last price.
4. **Review.** The journal scores the session: P/L in dollars and R, wins and losses, plan adherence, her signals versus her trades,
   notes and a self-rating. She can replay the same day again as a new attempt.

## Design decisions (the six questions, resolved)

**1. No lookahead: the server owns the playhead (server-windowed replay), the browser holds only what has been revealed.**
- Each session has a server-side `revealed_through` timestamp that only moves forward. `POST …/advance` returns the bars, prints, and
  would-fire signals in `(previous, to]` and moves the mark; `GET …/feed` re-reads history but never past `revealed_through`. Data after
  the playhead never reaches the browser, so DevTools, the chart's autoscale, the crosshair, the `MarketChart` "Chart data table"
  disclosure (it renders every bar it is given), indicator warm-ups, and the tape list cannot leak it.
- Why not frontend slicing of a full-day download: 02m §a1 makes the server the authority for what the UI shows about data ("the UI never
  computes freshness itself"), and §a3.3 keeps "one source of bars" while the browser computes indicator series from the bars it holds.
  Applied to replay, the server owns the reveal boundary and the browser's existing indicator code (`lib/indicators-with-gaps.ts`,
  `calcVWAP`) is causal by construction. Slicing would invert that: every consumer (chart, legend, levels, VWAP, tape, markers, the data
  table) would have to remember to slice, and one miss leaks the day.
- The playhead is monotonic inside a session: no rewind. "Replay again" starts a new attempt, which keeps the journal honest (a mark
  can only be placed at the frontier, by the server's clock). Jumping forward is allowed; skipped bars are revealed, not markable.
- Replay screens never call `/bars`, `/technicals`, `/charts/{symbol}/markers`, or `/quotes`. Those read the live store (split-adjusted,
  "now" values) and would mismatch the replayed raw prices.
- Cost: one small request per wall-clock second while playing (§b). If a request is slow, the clock waits; playback stutters, it never
  runs ahead of the server.

**2. Data: Alpaca historical SIP bars and SIP trades. The tape is consolidated for past days; IEX is a labelled fallback only.**
- The brief assumed the free plan gives IEX prints only. That holds for the *real-time* stream, not for history older than 15 minutes:
  the repository already reads SIP bars on the free plan (`providers/alpaca.py`: `feed: "sip"` with a 15-minute embargo). A read-only
  probe on 2026-10-24 confirmed it for trades: NVDA, Fri 2026-10-23, 10:00–10:01 ET returned **6,341 SIP prints totalling 420,979
  shares, exactly the SIP 1-minute bar (`v` 420,979, `n` 6,341)**; the IEX feed returned 203 prints, 15,625 shares (**3.7%** of volume).
  (Alpaca's OpenAPI text still says `sip` needs a subscription; the live response outranks it. R0 re-checks a 2016 date.)
- So the tape shows **"Consolidated tape · all US exchanges"**, and volume reads (size, pace, big prints, prints per second) are real
  tape-reading practice. If Alpaca ever refuses `sip` (a plan change), `replay/tape.py` falls back to `iex` and the panel says **"IEX
  prints only · about 4% of volume · bar volume is consolidated"**; in that state the tape is for rhythm and price, not volume reads.
  The bars stay SIP either way. Nothing ever claims consolidated prints when the feed is IEX.
- **Raw prices.** Bars use `adjustment: "raw"` so the chart, the tape (trades are never adjusted), and stored practice prices agree
  forever, and a later split cannot change an old journal. Ceiling: a split inside the 300-day daily lookback distorts long daily
  indicators on that replay; intraday rules and prior-day levels are unaffected.
- **No bid/ask.** Prints are coloured by the tick rule (up-tick green, down-tick red, same price muted) and the legend says so. NBBO
  quotes for at-bid/at-ask colouring are an open question (§h).
- Volume of data: NVDA printed 6,341 times in one minute, so a full day can run to millions of prints. The tape service fetches
  5-minute chunks on demand (pages of 10,000), cached in-process, filters by size on the server, and caps each response (§b).

**3. Notable days: the top realized-volatility days of her watchlist symbols over the last year, shown spoiler-free, plus any date.**
- Score: realized volatility of the regular session, `sqrt(Σ r²)` over 5-minute log returns built from 1-minute SIP bars (overnight gap
  excluded), ranked as a percentile within the symbol's last 252 sessions. Tags: `gap_up` / `gap_down` (|open ÷ prior close − 1| ≥ 2%),
  `heavy_volume` (volume ≥ 2 × 20-day average), `earnings` (when the events kind lists that day).
- **Spoiler-free:** the list never shows the day's change, range, close, or close location; only what a trader would know at the open
  (the gap) plus non-directional heat (volatility rank, heavy volume). Dates are hidden by default behind a "Show dates" toggle, because
  a memorable date spoils the day; hiding is a render rule (like 02n masking), the API returns dates.
- Symbols: the union of her watchlists (Day movers and Swing seed eight plus six symbols, 02m §b6). Any other symbol replays from a custom
  date; its picker says "Notable days are listed for your watchlist symbols".
- Custom entry: native `<input type="date">` plus two `<input type="time">` fields for the window (ET), with session `regular`
  (09:30–16:00 default) or `extended` (04:00–20:00). Earliest day 2016-01-04 (Alpaca SIP history); the latest is a finished session
  (regular close plus the 15-minute embargo).

**4. Strategy on replay: `core/evaluate.py` once per session, released by the playhead; nothing is delivered.**
- At session start the server evaluates each armed strategy over the replay day plus lookback (10 prior sessions of 1-minute bars,
  300 daily bars, all raw) with `as_of` = window end, and stores the would-fire list on the session row. `advance` releases a signal
  when its bar close (`core.evaluate._bar_close`, promoted to a public name) is at or before `to`.
- Releasing a full-day evaluation by the playhead is only safe if `evaluate` is prefix-consistent: candidates from `evaluate(as_of=t)`
  must equal the full-day candidates with bar close ≤ `t`. The engine is causal by design (closed bars only, rising edges per day), and a
  property test over every 1-minute `t` of a fixture day pins it (§i).
- Wrapper rules (in `replay/signals.py`, not in the engine): `then.alert.frequency: "once"` is applied inside the window (the engine's
  own `once` would count lookback days), `expiresOn` is ignored (replay tests the rule, not its schedule), channels and `message` are
  ignored, and nothing is written to `signals`, `alerts`, or the outbox. A test asserts those tables are unchanged after a session.
- Filters arm too: a filter's `watch.session`, `watch.runOn`, and `when` become an in-memory `StrategySpecV1` for the replay symbol
  (never saved); liquidity, universe, `rank`, and `maxResults` do not apply to one symbol. A fire means "started matching". Pattern
  conditions, session levels, and alert fields all run as on the live path (STATUS 5F: 299/299 pattern validation).
- Armed versions are snapshotted (`version_id`) at start, so editing a strategy later never changes an old session.
- `daily_close` and `weekly` strategies show their fire at the close. This is one symbol on one day she watches bar by bar; running a
  rule across many days or symbols is the automated backtest that stays out of scope.

**5. Schemas: two additive contracts (`ReplaySessionV1`, `PracticeMarkV1`) in the 02k family; API envelopes stay Pydantic models.**
- What she authors goes in `contracts/`: the session setup (validated live in the hub form, stored as `jsonb`, reused by "Replay again")
  and the mark she sends. Both follow 02k §2 (Zod source of truth, camelCase, `z.strictObject`, `schemaVersion: 1`, no booleans or
  nulls, bounded fields) and ride the single JSON Schema bundle as extra `$defs` (02k §9), so `datamodel-codegen` emits the Pydantic
  classes into the same generated module and `test_contract_crosscheck.py` covers them. No existing spec changes.
- What the server computes (session state, feed, journal) is plain Pydantic response models and frontend zod schemas that `satisfies`
  the generated OpenAPI types (02m §a3, §c4). Shapes are in §b2 and §c5 below.

**6. P/L: marked to the replayed last price, no fees, no spread, no slippage, shares capped, always labelled Practice.**
- A mark is stamped by the server at `revealed_through`, priced at the last SIP print at or before it (falling back to the last revealed
  1-minute close). She cannot pick a price: there are no limit or stop orders, and a stop note never auto-exits (an auto-triggered stop
  would be order simulation). Fees, spread, and slippage are off and the footnote says so.
- One open practice trade at a time; an exit closes it in full. Shares: the session's `shares` (1–10,000), or a per-entry override in the
  same bound. P/L per trade = (exit − entry) × shares for long, (entry − exit) × shares for short; R = P/L per share ÷ |entry − stop|
  when a stop note existed at entry. Unrealized P/L is marked at the playhead's last price. At `end`, an open trade exits at the last
  price as `source: "auto"`.
- **Scope note on 02m §e** ("no endpoint … that simulates an order"): practice marks are journal annotations on a *finished* past day.
  There is no order object, order type, pending state, account, broker, or live or paper data path; sessions cannot be created for an
  unfinished session. This lane is the owner's 2026-10-24 directive, and the no-orders route test and the `paperOrder` rejection stay.

## a. Screen map

### a1. Navigation and routes

- Technical-lane primary nav gains **Practice** after Strategies: Today · Screener · Watchlists · Alerts · Strategies · Practice.
  `lib/lanes.ts` adds `["/practice", "technical"]`.
- Static-export routes with query ids (02m §c1): `app/practice/page.tsx` (hub), `app/practice/replay/page.tsx` (`?id=`),
  `app/practice/journal/page.tsx` (`?id=`).
- **Practice band** on every Practice page: a 28 px amber band under the top bar, "Practice · replay of Fri 2026-10-23 · nothing here
  reaches IBKR" (the Stripe test-mode band pattern, §j). The top-bar `FreshnessBadge` reads "Replay · Fri 2026-10-23 · 10:07 AM ET"
  (new `freshness: "replay"` value, §b1). With dates hidden: "Replay · hidden day · 10:07 AM ET".

### a2. Practice hub (`/practice`)

- Left rail: the existing `WatchlistsPanel` (click a symbol to fill the setup).
- Center top, **Start a practice session**: symbol (search as `⌘K`), day (date input plus "Pick from notable days"), window (from, to,
  `Regular | Extended`), interval `1m 5m 15m`, **Arm strategies** (her alert strategies and filters, up to 5, each with its plain-English
  rule from `describeSpec`), **Plan** (shares, stop required yes/no, trade only on a signal yes/no, max loss $, max trades, a note),
  `Start practice`.
- Center bottom, **Notable days** (`DenseTable`): symbol, day (hidden by default), weekday, volatility rank, tags (Gap down 6.2% ·
  Heavy volume · Earnings), attempts, `Practise` row action. Header: "Most volatile sessions of the last year for your watchlists ·
  we never show how a day ended". Toggle `Show dates`.
- Right rail: **Resume** card for the active session (symbol, day, playhead time, practice P/L, `Resume`), then **Recent sessions**
  (`DenseTable`: day, symbol, attempt, trades, P/L, adherence, status; row opens the journal).
- States: loading ("Loading practice days…"); no notable days for this symbol; no data for that day (one inline message from the
  server's `422` problem: "No trading on Sat 2026-10-24 · pick a weekday", "This session isn't finished yet · replay opens at 4:15 PM ET",
  "Replay goes back to Jan 4, 2016", "No trades for XYZ on Fri 2026-10-23"); no sessions yet ("No practice sessions yet · pick a day to
  start"); load error. 1180: right rail becomes the drawer (`Resume · Recent`); the table drops weekday, then attempts.

### a3. Replay workspace (`/practice/replay?id=`)

- **Center:** `ReplayHeader` (symbol, day, playhead clock `10:07:32 AM ET`, last price, practice P/L); the chart (the D3
  `WorkspaceChart` on `MarketChart`: candles at the session interval, VWAP / EMA 9 / EMA 21, volume, the forming bar built from revealed
  1-minute bars, practice marks, would-fire bells, the practice stop as an amber dashed level, key levels); the **transport bar** under
  the chart: forward-only controls `Play/Pause`, `Step`, speed chips `1x 2x 5x 10x`, `Jump` menu (+5 min, +15 min, to a
  time, to the next signal, to the window end), and a forward-only timeline: the revealed part shows ticks for her marks and released
  signals, the future part is empty (the Mixpanel replay timeline pattern, §j). Bottom panel tabs `Marks · Levels`.
- **Left rail (Session):** plan checklist with live ticks (stop set, max loss, trades count), **Armed strategies** (name, fires so far),
  and the **Signals rail**: a time-ordered list of released would-fire signals ("9:45 AM · ORB 15m · would fire at 187.10"); clicking
  one moves the crosshair to that bar (never the playhead).
- **Right rail:** **Tape** (top, about 60%): Time · Price · Size rows at 24 px, tick colours, big prints highlighted amber, size filter
  chips `All · ≥100 · ≥1,000 · Big only`, a pace meter (prints and shares per second over the last 10 market seconds), the feed label,
  and "Fast tape · showing the latest 500 of 1,043 prints" when capped. **Practice controls** (bottom): open-trade card (side, shares,
  practice price, unrealized P/L, R if a stop is set), shares field, `Long (B)`, `Short (S)`, `Exit (X)`, `Stop (T)`, `Note (N)`, and
  the footnote "Practice prices are replayed last prices · no spread, slippage, or fees".
- **Keyboard** (active when focus is in the workspace and not in a text field; hints in tooltips, 02m §c3): `Space` play/pause, `→`
  step one bar, `Shift+→` jump to the next signal, `1`–`4` speed, `B` long entry when flat or short exit when short, `S` short entry when
  flat or long exit when long, `X` exit, `T` stop note (price field prefilled with the last price), `N` note, `⌘Z` undo the last mark
  (only before the playhead moves again), `?` shortcuts overlay (the Mercury overlay pattern, §j), `Esc` close.
- States: loading ("Preparing the replay…"); ready ("Paused at 9:30 AM · press Space to play"); playing; paused; load error ("Couldn't
  load the next minute · Try again", playback pauses); mark rejected (inline toast from the `422` problem, for example "No open practice
  trade to exit"); max loss reached (a plan warning, not a block: "Max loss reached · your plan says stop for the day"); quiet tape ("No
  prints in the last 30 s"); IEX fallback label; end of window ("Session over · 3 practice trades · See journal", then `End and score`).
  Reconnecting does not apply: there is no live connection, and the badge never shows Live or Delayed.
- 1180: the right rail collapses to the 40 px strip with drawer tabs `Tape · Practice · Signals`; `Tape` opens by default while
  playing; the practice buttons and keyboard work with the drawer closed; the chart takes the freed width.

### a4. Session journal (`/practice/journal?id=`)

- Center: summary tiles (Practice P/L $, total R, trades, win rate, average win, average loss, largest loss, adherence %); the **journal
  chart** (the full window, now unsealed, with her marks, would-fire bells, and a `Practice P/L` pane line from `MarketChart` panes);
  **Trades** (`DenseTable`: #, side, entry time and price, exit time and price, shares, P/L, R, stop, on a signal); **Signals versus
  your trades** (`DenseTable`: time, strategy, price at the bar close, change 15 and 30 minutes later, what she did: "entered 2 min
  later" or "no trade").
- Right rail: **Adherence** checklist (§c5), self-rating 1–5, notes, `Replay this day again` (new attempt, same setup), `New session`.
- States: session still open ("Session still open · Resume", live stats); ended; no trades ("No practice trades this session · 3
  signals would have fired"); saving notes. 1180: right rail becomes the drawer; the signals table drops the 15-minute column.

### a5. New copy-table rows (`lib/desk/freshness.ts`)

Replay badge, Practice band, both tape feed labels, fast tape, quiet tape, the four no-data messages, ready, end of window, mark
rejected, max loss reached, undo ("Practice mark removed"), the price footnote. The existing banned-term test covers them, plus a
practice list: **order, position, filled, broker, execute** must not appear in Practice copy (and "stream" is already banned, so the
tape copy never says it streams).

## b. API surface (02m §a1 conventions)

All paths under `/api/desk`; every router `APIRouter(..., dependencies=[Depends(get_current_user)])`; rows scoped to `user.id` (a
non-owner gets 404); timestamps ISO-8601 UTC; numbers `FiniteFloat | None`; spec and mark failures `422 {"detail": {"problems": […]}}`;
`Cache-Control: no-store`. No path contains `order`, `position`, or `broker`: practice marks are their own resource under
`/replay/sessions/{id}/marks`, so the 02m §d3 no-orders route test keeps passing unchanged.

### b1. Inventory (10 endpoints, all new)

| # | Method and path | Screen | Purpose |
|---|---|---|---|
| 1 | GET `/replay/days?symbol=&limit=20` | hub | spoiler-free notable days for one symbol, or for all her watchlist symbols |
| 2 | GET `/replay/sessions?status=&limit=20` | hub | her sessions (resume card and recent list) |
| 3 | POST `/replay/sessions` | hub | create from a `ReplaySessionV1`; validates the day and data; snapshots armed versions; computes would-fire signals |
| 4 | GET `/replay/sessions/{id}` | workspace, journal | state, marks, open trade, journal (live while active, final when ended) |
| 5 | PATCH `/replay/sessions/{id}` | journal | notes and rating only |
| 6 | POST `/replay/sessions/{id}/advance` | workspace | move the playhead forward and return what it revealed |
| 7 | GET `/replay/sessions/{id}/feed?interval=&min_size=` | workspace, journal | re-read revealed history (resume, interval switch); the whole window once ended |
| 8 | POST `/replay/sessions/{id}/marks` | workspace | place a practice mark (`PracticeMarkV1`) at the playhead |
| 9 | DELETE `/replay/sessions/{id}/marks/{mark_id}` | workspace | undo: only the last mark, only while `revealed_through` has not moved since it was placed (else `409`) |
| 10 | POST `/replay/sessions/{id}/end` | workspace | auto-exit an open trade, compute the final journal, set `revealed_through` to the window end |

Counts: `/api/desk` grows from 53 to **63** routes (to 80 if 02n's 17 land first). Additive shared change: the `stamp.freshness`
enum gains `"replay"` (its copy row in §a5). Reused unchanged: `/symbols/search`, `/watchlists*`, `/alert-strategies` and
`/screener/filters` (the arm list). Not used by replay screens: `/bars`, `/technicals`, `/charts/…/markers`, `/quotes` (decision 1).

### b2. Shapes in brief

Numbers in the examples are illustrative, not data.

`GET /replay/days`:

```json
{ "days": [ { "symbol": "NVDA", "day": "2026-04-07", "weekday": "Tue", "rank": 1, "rv_pct_rank": 99.6, "gap_pct": -6.2,
              "tags": ["gap_down", "heavy_volume", "earnings"], "attempts": 0 } ],
  "symbols": ["NVDA", "AMD", "…"], "lookback_sessions": 252, "stamp": { "…": "…" } }
```

`POST /replay/sessions` takes a `ReplaySessionV1` (§c4) and returns the session (below) with `status: "active"` and `revealed_through`
= window start. Day and data problems are `422` with `path: "day"` and the plain messages of §a2. One active session per symbol and day
per user: a second `POST` returns the existing active session (idempotent) unless the first one is ended, then it is attempt `n + 1`.

`GET /replay/sessions/{id}`:

```json
{ "id": 12, "attempt": 1, "status": "active", "spec": { "schemaVersion": 1, "symbol": "NVDA", "…": "ReplaySessionV1" },
  "window_start": "2026-04-07T13:30:00Z", "window_end": "2026-04-07T20:00:00Z", "revealed_through": "2026-04-07T14:07:00Z",
  "tape_feed": "sip",
  "armed": [ { "source": "alert_strategy", "id": 7, "version_id": 31, "name": "ORB 15m", "bias": "bullish", "fires_so_far": 1 } ],
  "marks": [ { "id": 3, "seq": 1, "kind": "long_entry", "at": "2026-04-07T13:47:00Z", "price": 187.42, "shares": 100,
               "stop_price": 186.9, "note": "ORB hold", "trade_no": 1, "source": "her" } ],
  "open_trade": { "trade_no": 1, "side": "long", "shares": 100, "entry_price": 187.42, "stop_price": 186.9,
                  "last_price": 188.05, "unrealized_usd": 63.0, "r": 1.21 },
  "journal": { "…": "§c5 shape; live totals while active" },
  "notes": null, "rating": null, "stamp": { "as_of": "2026-04-07T14:07:00Z", "source": "alpaca", "quality": "delayed-15m", "freshness": "replay" } }
```

The would-fire list is never in this response while active (only `fires_so_far` per strategy): a count of future fires is lookahead.

`POST /replay/sessions/{id}/advance` body: exactly one of `{"to": "<ISO>"}` or `{"step": "bar" | "next_signal"}`, plus optional
`interval` (default the session's), `min_size` (default 0), `max_prints` (default 500, max 2,000). `to` at or before
`revealed_through` returns an empty delta (`200`, idempotent); `to` past the window end is clamped and `at_end: true` is returned.

```json
{ "revealed_through": "2026-04-07T14:07:12Z", "at_end": false,
  "bars": [ { "t": "2026-04-07T14:00:00Z", "o": 187.2, "h": 187.6, "l": 186.95, "c": 187.41, "v": 1203344, "ext": false } ],
  "forming": { "t": "2026-04-07T14:05:00Z", "o": 187.41, "h": 188.1, "l": 187.3, "c": 188.05, "v": 402118 },
  "prints": { "feed": "sip", "rows": [ ["2026-04-07T14:07:11.482Z", 188.05, 200, 1] ], "count": 1043, "volume": 81234, "shown": 500 },
  "signals": [ { "source": "alert_strategy", "id": 7, "name": "ORB 15m", "bar_time": "2026-04-07T13:30:00Z",
                 "bar_close": "2026-04-07T13:45:00Z", "close": 187.1, "evidence": { "close": 187.1 } } ],
  "levels": { "prior_close": 195.4, "session_high": 188.6, "session_low": 183.2, "opening_range_high": 187.3, "opening_range_low": 184.9 },
  "last": { "price": 188.05, "at": "2026-04-07T14:07:11.482Z" },
  "open_trade": { "…": "as above, marked at the new last price" },
  "stamp": { "…": "freshness replay" } }
```

- `bars` are display-interval bars that closed inside the delta; `forming` is the current display bar built from revealed closed
  1-minute bars (it updates once a minute; the tape moves every second). Aggregation is the engine's own `_resample`, so the chart, the
  signals, and the journal agree; the browser never aggregates.
- `prints.rows` are `[time, price, size, tick]` (tick 1 up, −1 down, 0 same), oldest first, the latest `shown` of the window after the
  size filter; `count` and `volume` cover every print in the window, so the pace meter stays honest when rows are capped.
- `step: "next_signal"` reveals through the next would-fire bar close (it tells her a signal is coming; it is a strategy-testing tool
  and its menu item says so). With no signal left it answers `422` "No more signals in this session".

`GET /replay/sessions/{id}/feed`: the same object for everything revealed so far: the lookback (10 prior sessions at the interval, for
indicator warm-up and levels), the revealed window, `forming`, the last 200 prints, released signals, levels. After `end` it covers the
whole window and adds the full signals list.

`POST /replay/sessions/{id}/marks` takes a `PracticeMarkV1` and returns `{ "mark": {…}, "open_trade": {…} | null, "journal": {…} }`.
State rules give `422` with `path: "kind"` or `"stopPrice"`: an entry needs a flat book, an exit needs a matching open trade, a stop
needs an open trade and a price on the losing side of the last price, any mark needs `status: "active"`.

`POST /replay/sessions/{id}/end` returns the ended session with the final `journal`; a second call returns the same (idempotent).

## c. Backend modules (under `backend/src/ai_trading/`)

### c1. Module map

| Module | New or extended | Responsibility | Depends on | Tests |
|---|---|---|---|---|
| `replay/data.py` | new | replay inputs for (symbol, day): 1-minute bars of the day plus 10 prior sessions and 300 daily bars, `adjustment: "raw"`, through the registry `bars` kind; day validation (calendar, finished session, 2016 floor, no bars); bounded in-process LRU. Never writes `bars_1m` (its 90-day `prune_1m` retention would delete old days anyway) | `core/calendar.py`, registry | each no-data case; raw adjustment requested; no store writes |
| `replay/tape.py` | new | prints for a window: 5-minute chunks from the registry `trades` kind, pages of 10,000, LRU-cached; drops prints whose conditions do not update the last sale (a pinned constant set); tick rule; size filter; cap; `sip` then `iex` fallback with `tape_feed` | registry `trades` | fixture minute sums to the SIP bar volume; fallback label; cap counts |
| `replay/signals.py` | new | arms alert strategies and filters (filter to in-memory `StrategySpecV1`), snapshots versions, runs `core.evaluate.evaluate` once per session, applies `once` in the window, drops `expiresOn`, sorts by bar close | `core/evaluate.py`, `alerts/service.py`, `screener/service.py` | prefix-consistency property test; `once` in window; no rows in `signals`, `alerts`, outbox |
| `replay/journal.py` | new (pure) | marks plus the 1-minute price path to trades, P/L, R, totals, adherence checks, signals versus trades, the P/L series | none | golden table of hand-computed sessions (long, short, auto exit, stop crossed, max loss) |
| `replay/session.py` | new | create (idempotent per active symbol-day), advance (monotonic `revealed_through`, delta assembly), feed, marks (stamping, state rules, undo), end, patch; ownership | the modules above, models | lookahead property test; monotonicity; undo window; ownership 404 |
| `replay/days.py` | new | realized-volatility notability for her watchlist symbols; self-healing (fills any of the last 252 sessions it lacks from 1-minute SIP bars) | registry `bars`, `alerts/universe.py` (watchlist symbols) | score and tags on a fixture; incremental run fetches only the new day |
| `jobs/daily_close.py` | extended | runs `replay.days.refresh()` after the daily pass | `replay/days.py` | existing `tests/jobs` plus the hook |
| `api/replay.py` | new | thin router and Pydantic models for §b | `replay/*` | §i |
| `core/evaluate.py` | extended (tiny) | `_bar_close` gets a public alias `bar_close_of` for the release rule | | existing tests |
| `api/stamp.py` | extended | `freshness` literal adds `"replay"` | | openapi regenerated |

### c2. Registry addition (`ai-trading/common`, 02j addendum)

- New kind **`trades`**: `TradesSource.trades(symbol, start, end, *, feed: "sip" | "iex") -> Trades(frame[t, p, s, c], source, feed)`, with
  the Alpaca adapter (pagination, the 15-minute embargo cap, the 200-requests-a-minute throttled client), a fake source, and the
  registry conformance test (02j §9 pattern). The Desk reaches it only through `DataSources` (the import-boundary test stays green).
- The `bars` kind's protocol passes an optional `adjustment` (default `"all"`, unchanged behaviour) through to the adapter that already
  accepts it.

### c3. Migration `0004_replay_practice` (additive, `downgrade()` reverses it)

| Table | Columns |
|---|---|
| `replay_sessions` | `id`, `owner_user_id` FK `users` (cascade), `symbol`, `day date`, `attempt int`, `schema_version`, `spec jsonb`, `armed jsonb` (resolved refs with `version_id`, `name`, `bias`), `signals jsonb` (the would-fire list; never served past `revealed_through`), `window_start`, `window_end`, `revealed_through timestamptz`, `tape_feed`, `status` (`active|ended`), `journal jsonb null` (final), `notes text null`, `rating smallint null`, `created_at`, `updated_at`, `ended_at null`; unique `(owner_user_id, symbol, day, attempt)`; index `(owner_user_id, updated_at desc)` |
| `practice_marks` | `id`, `session_id` FK (cascade), `seq int`, `kind`, `at timestamptz`, `price numeric`, `shares int null`, `stop_price numeric null`, `note text null`, `trade_no int null`, `source` (`her|auto`), `created_at`; unique `(session_id, seq)` |
| `replay_notable_days` | `symbol`, `day date`, `rv float`, `rv_pct_rank float`, `gap_pct float`, `rvol float`, `tags jsonb`, `computed_at`; PK `(symbol, day)` |

Same pull request: runtime-role grants in `docker/postgres/zz-20-desk-roles.sh` and `tests/test_db_roles.py`, `tests/test_db_migrations.py`,
ORM models in `db/models.py`. **Numbering:** 02n plans `0004_fundamental_lane`; whichever lane merges second renumbers its file and
`down_revision` (the single-head migration test catches a clash). Practice is expected to merge first. *Resolved 2026-10-24:* the
consensus-history migration (02n step 3a) landed first as `0004_consensus_history`, so Practice shipped as `0005_replay_practice`.

### c4. Contracts (`contracts/src/replay-session-v1.ts`)

```ts
export const ReplaySessionV1 = z.strictObject({
  schemaVersion: z.literal(1),
  symbol: StockTicker,                                    // upper-case stock or ETF; futures roots rejected
  day: IsoDay,                                            // America/New_York trading day, YYYY-MM-DD
  window: z.strictObject({ from: HhMm, to: HhMm }),       // ET, from < to, inside 04:00–20:00 (09:30–16:00 when regular)
  session: z.enum(["regular", "extended"]),
  interval: z.enum(["1m", "5m", "15m"]),
  shares: z.number().int().min(1).max(10_000),
  armed: z.array(z.strictObject({ source: z.enum(["alert_strategy", "filter"]), id: z.number().int().min(1) })).max(5),
  plan: z.strictObject({
    stopRequired: z.enum(["yes", "no"]),
    signalOnly: z.enum(["yes", "no"]),
    maxLossUsd: z.number().int().min(1).max(100_000).optional(),
    maxTrades: z.number().int().min(1).max(50).optional(),
    note: PlainText(1, 500).optional(),
  }),
  hideDate: z.enum(["yes", "no"]),
});

export const PracticeMarkV1 = z.discriminatedUnion("kind", [
  z.strictObject({ schemaVersion: z.literal(1), kind: z.enum(["long_entry", "short_entry"]),
                   shares: z.number().int().min(1).max(10_000).optional(), stopPrice: Price.optional(), note: PlainText(1, 280).optional() }),
  z.strictObject({ schemaVersion: z.literal(1), kind: z.enum(["long_exit", "short_exit"]), note: PlainText(1, 280).optional() }),
  z.strictObject({ schemaVersion: z.literal(1), kind: z.literal("stop"), stopPrice: Price }),
  z.strictObject({ schemaVersion: z.literal(1), kind: z.literal("note"), note: PlainText(1, 280) }),
]);
```

- `Price` is a positive bounded number (≤ 1,000,000); `PlainText` reuses the 02k BMP-only string rule. The per-kind variants carry the
  cross-field rules in JSON Schema (`oneOf` with a `const` kind), so no hand-written Pydantic is needed (02k §9 limits it to what JSON
  Schema cannot say). State rules (flat, open trade, losing side of the last price) are server rules, not contract rules.
- Armed strategies are referenced by id, not by name as the 02k `filter` universe is: a session is a user record, not a portable spec,
  and the server snapshots each `version_id`.
- Fixtures: `valid/` and `invalid/` files for both (bounds, unknown key, boolean, null, a stop without a price, an exit with shares, a
  window outside the session); the Zod, Pydantic, and crosscheck tests pick them up as they do for the 02k specs.

### c5. Journal (computed by `replay/journal.py`)

```json
{ "totals": { "pnl_usd": -42.0, "r_total": -0.4, "trades": 3, "wins": 1, "losses": 2, "scratches": 0, "win_rate": 0.333,
              "avg_win_usd": 63.0, "avg_loss_usd": -52.5, "largest_loss_usd": -71.0 },
  "trades": [ { "no": 1, "side": "long", "entry_at": "…", "entry_price": 187.42, "exit_at": "…", "exit_price": 188.05, "shares": 100,
                "pnl_usd": 63.0, "r": 1.21, "stop_price": 186.9, "on_signal": true, "exit_source": "her" } ],
  "adherence": { "score_pct": 75, "checks": [ { "id": "stop_set", "label": "Stop note on every entry", "applicable": true, "passed": true,
                 "detail": "3 of 3" } ] },
  "signals_vs_trades": [ { "time": "…", "name": "ORB 15m", "close": 187.1, "chg_15m_pct": 0.4, "chg_30m_pct": -0.2, "her": "entered 2 min later" } ],
  "pnl_series": [ { "t": "…", "pnl_usd": 0.0 } ] }
```

Adherence is a fixed set of five checks, each applicable only when its plan field is set: **stop set** (`stopRequired`), **stop honored**
(when a 1-minute low or high crossed the stop note, the exit came by the next 1-minute close), **on a signal** (`signalOnly`: the entry
came within 3 display bars after an armed signal), **max loss** (no entry after realized P/L reached −`maxLossUsd`), **max trades**.
`score_pct` = passed ÷ applicable, `null` with "Add a plan to get an adherence score" when none applies. `signals_vs_trades` and
the 15/30-minute changes are filled only after `end` (they look past the playhead).

## d. Frontend components (under `frontend/`)

| Area | Components and modules (new unless marked) | Data | Notes |
|---|---|---|---|
| Nav | `lib/lanes.ts` (extended), `shell/desktop/PrimaryNav` (extended) | | Practice in the Technical lane |
| Hub | `practice/hub/PracticeHub`, `SessionSetup` (`SymbolField` on `/symbols/search`, native date and time inputs, interval chips, `ArmStrategiesField`, `PlanFields`), `NotableDaysTable` (`DenseTable`), `ResumeCard`, `RecentSessionsTable` (`DenseTable`) | `/replay/days`, `/replay/sessions`, `/alert-strategies`, `/screener/filters`, POST `/replay/sessions` | live validation against `ReplaySessionV1` (the D6 pattern); dates hidden by a render rule |
| Workspace | `practice/replay/ReplayWorkspace`, `PracticeBand`, `ReplayHeader`, `ReplayChart` (wraps existing `workspace/WorkspaceChart`, `ChartLegend`, `KeyLevels`), `TransportBar` (`SpeedChips`, `JumpMenu`, `ReplayTimeline`), `TapePanel` (`DenseTable` compact rows, `TapeFilters`, `TapePace`, `FeedLabel`), `PracticeControls` (`OpenTradeCard`), `PlanChecklist`, `ArmedStrategiesList`, `SignalsRail`, `MarksList`, `ShortcutsOverlay`, `EndPrompt` | `/replay/sessions/{id}`, `…/feed`, `…/advance`, `…/marks`, `…/end` | `useReplayPlayer` hook: `idle → playing ⇄ paused → at_end`, any error to paused; one request in flight, never stacked |
| Journal | `practice/journal/JournalScreen`, `SummaryTiles`, `JournalChart` (`MarketChart` with marks and a `Practice P/L` pane), `TradesTable`, `SignalsVsTradesTable` (both `DenseTable`), `AdherenceChecklist`, `NotesAndRating` | `/replay/sessions/{id}`, `…/feed`, PATCH | |
| Chart | `charts/MarketChart` (extended): `ChartMarkerInput.kind` adds `practice_long`, `practice_short`, `practice_exit`, `would_fire`; new `follow?: boolean` keeps the newest bar in view (`scrollToRealTime` after an update unless she has scrolled back) | | the existing `fitKey` already keeps zoom across data updates |
| Logic (node tests) | `lib/replay/clock.ts` (speed, tick, the next `to`), `lib/replay/keys.ts` (key plus open-trade state to an action), `lib/replay/marks.ts` (marks and signals to `ChartMarkerInput`), `lib/desk/replay.ts` loaders, zod schemas in `lib/api/schemas.ts`, copy rows in `lib/desk/freshness.ts` | | the frontend has no component-test runner (02m §d4), so logic lives in `lib/` |

- The clock asks for `advance` once per wall-clock second while playing (`to = playhead + speed × 1 s`), and at each bar boundary when
  stepping. Prints render in time order as they arrive.
- Marks render as Practice markers: arrow up below the bar for long entries, arrow down above for short entries, a circle for exits,
  each labelled "Practice long 100" and so on; would-fire bells reuse the `fire` style with the strategy name.
- Interval switch calls `feed` at the new interval; the browser never aggregates bars.

## e. Paper boards for the mock phase

Paper file TobyTest, the **same page as D1–D12** ("R3 · Desktop · Technical MVP"), so every run duplicates the named D1 shell groups
(`Desktop shell`, `Desktop top bar`, `Left rail`, `Right rail`, `Status bar`, `Freshness badge`). Board name format
`R3 · Practice · <Screen> · desktop` (1180: `… · desktop 1180`). Run PA names the new groups `Practice band`, `Transport bar`,
`Tape panel`, `Practice controls` for later runs.

**Grid (the D1–D12 and F-row convention).** 1440 boards at x = −195, 1405, 3005, 4605 (1600 px step); 1180 boards at x = −195, 1085
(1280 px step). Technical rows sit at y = 26000–33600 (lowest board ends near 34914). 02n reserves the Fundamental rows y = 36000,
38800, 41600, 44400 (step 2800; its lowest 1180 boards end near 45220). The Practice rows take the next free slots below that
reservation, **y = 47200 and 50000**, so neither plan renumbers the other even though Practice runs first. Before writing, each run reads
the bottom edge of the row above; if a board above ends within 400 px of its row, it moves its row down in 400 px steps and records the
move in its run JSON.

| Board | Name | Width × start height | x | y | Model, run |
|---|---|---|---|---|---|
| P1 | `R3 · Practice · Hub · desktop` | 1440 × 900 | −195 | 47200 | Sonnet, PA |
| P2 | `R3 · Practice · Replay workspace · desktop` | 1440 × 900 | 1405 | 47200 | Sonnet, PA |
| P3 | `R3 · Practice · Journal · desktop` | 1440 × 900 | 3005 | 47200 | Sonnet, PB |
| P4 | `R3 · Practice · Replay states · desktop` | 1440 × 900 | 4605 | 47200 | Haiku, PC |
| P5 | `R3 · Practice · Hub · desktop 1180` | 1180 × 820 | −195 | 50000 | Haiku, PC |
| P6 | `R3 · Practice · Replay workspace · desktop 1180` | 1180 × 820 | 1085 | 50000 | Haiku, PC |

**Count: 6 boards**: 3 Sonnet (P1–P3), 3 Haiku (P4–P6). Heights grow with `fit-content`; the shell fits 900 (820 at 1180), 02l §b1.

- **P1 Hub:** setup filled for NVDA on its top notable day (date hidden), two armed seed strategies, a plan; the notable-days table for
  NVDA and TSLA (real ranks and tags); resume card and recent sessions (SIMULATED rows).
- **P2 Replay workspace** (the template; owner gate): NVDA on that day, playhead 10:07 AM ET, 5m candles with VWAP / EMA 9 / EMA 21 and
  volume, a forming bar, a would-fire bell at the real ORB 15m fire, one open practice long with its stop line, the tape at the real
  prints just before 10:07 with tick colours and a big print, pace meter, `5x` playing, the signals rail, the plan checklist.
- **P3 Journal:** the same session ended: tiles, the unsealed day with marks and the P/L pane, trades, signals versus trades with the
  real 15/30-minute changes, adherence, notes.
- **P4 Replay states:** hub no-data messages (Saturday, unfinished session, before 2016), loading, paused at open, IEX fallback label
  (with R0's measured IEX share), fast-tape cap, mark rejected toast, load error, max loss warning, end-of-window prompt, shortcuts
  overlay, the replay badge in the top bar.
- **P5, P6:** P1 and P2 at 1180 per §a2/§a3 (P6 with the `Tape` drawer open).

**Runs (one Paper writer at a time across both lanes, sequential):**

| Run | Model | Boards | Depends on |
|---|---|---|---|
| R0 | Sonnet (no Paper) | snapshot | Alpaca keys (in Firestore today) |
| PA | Sonnet | P1, P2 | R0; **owner and wife gate after PA** (the workspace is the template for the rest) |
| PB | Sonnet | P3 | PA approved |
| PC | Haiku | P4, P5, P6 | PA approved |

Then 02n's F1–F6 resume (02n §i), F0 permitting.

**Run R0 snapshot.** A throwaway script under `ai-trading/temp/desk-practice-replay/` (gitignored by `ai-trading/.gitignore`'s `temp/`)
reads the Alpaca keys only through `common/config/family_config.py run ai-trading/desk -- …` (never by shell-sourcing an `.env`) and writes
`snapshot-practice-2026-10-23.json` plus `prints-<symbol>-<day>.json.gz`:

- **Notability** for NVDA and TSLA (Day movers): decision 3's score and tags over the 252 sessions to Fri 2026-10-23, from 1-minute SIP
  raw bars; the top 10 per symbol.
- **Three replay days:** NVDA's #1, TSLA's #1, NVDA's #2. For each: 1-minute raw SIP bars 04:00–20:00 ET, 10 prior sessions of 1-minute
  bars, 300 daily bars; **SIP trades 09:30–10:30 ET** (the first hour; the boards sit at 10:07); **IEX trades 09:30–09:35** to measure the
  IEX share for the fallback board; levels (prior close, session high and low, opening range).
- **Would-fire signals** from running `core.evaluate.evaluate` with the five seed alert templates (ORB 15m, VWAP reclaim, Hammer 15m near
  S1, Abnormal volume, High-of-day break) on each day, decision 4's wrapper rules applied by hand.
- **An example session** on NVDA #1: two practice trades placed at real signal bars with stops at real levels, priced from real prints;
  its P/L, R, and adherence computed with the decision-6 formulas. The marks are SIMULATED (she did not make them); the prices are real.
- Checks recorded in the run JSON (counts only): one minute's SIP print sizes sum to its SIP bar volume; SIP history answers for
  2016-01-04; request count. The log never prints keys, and nothing in the folder is committed.

**Real versus SIMULATED on the boards (02l §c2):** real: notable days, ranks, tags, bars, prints, levels, would-fire times and the 15/30-
minute changes, the IEX share. SIMULATED: her marks and notes, the journal numbers built on them (labelled "Example practice session"),
the resume card and recent sessions. Every board shows the Practice band.

Per run: load the Paper guide once, `get_font_family_info` for Inter once, duplicate the D1 shell groups, one screenshot per board at
the end, `finish_working_on_nodes`. No Mobbin calls (the references are in §j).

## f. Implementation order, models, and gates

Opus wrote this plan and reviews only on request. Sonnet runs the streams and the Sonnet Paper runs; Haiku runs the mechanical
sub-tasks as subagents of the stream that owns them. Streams follow 02m §d1 ownership (S: `backend/`, `common/`, `contracts/`; F:
`frontend/`) and the repository rule: stack commits, one pull request when the phase is finished.

| Step | Owner | Work | Gate |
|---|---|---|---|
| 0 | Opus | this plan | done |
| 1 | Sonnet (no Paper) | **R0 snapshot** (§e) | none |
| 2 | Sonnet, then Haiku | **Paper runs PA, PB, PC** (§e); then 02n's F-runs | R0; **owner and wife approve P1 and P2 before PB, PC, and step 4's workspace** |
| 3a | S: Sonnet; Haiku for fixtures | contracts `replay-session-v1.ts`, the bundle, regenerated Pydantic, crosscheck | now, parallel to 1–2 |
| 3b | S: Sonnet; Haiku for grants, migration tests, and the `trades` conformance tests | `0004_replay_practice` and ORM; `trades` kind and the `bars` `adjustment` pass-through in `common` | 3a |
| 3c | S: Sonnet; Haiku for routers and `pnpm gen:api` | contract-first stubs for the 10 endpoints from a trimmed R0 fixture (`tests/fixtures/desk-replay/`, one day, the first hour) behind an off-by-default `DESK_REPLAY_STUB` setting (the 02m §d2 step 2 pattern); OpenAPI committed; **F starts here** | 3b |
| 3d | S: Sonnet (test first on `journal.py` and the lookahead and prefix tests) | real `replay/data`, `tape`, `signals`, `journal`, `session`, `days` and the daily-close hook; stub branches removed at the end | 3c |
| 4 | F: Sonnet; Haiku for loaders and zod, copy rows, lanes and nav, 1180 priorities, `lib/replay/keys.ts` | hub, workspace (`clock`, player hook, tape, transport, controls), journal; `MarketChart` marker kinds and `follow` | 3c; workspace after the PA gate |
| 5 | Both | integration: stub off; Playwright Practice specs at 1440 and 1180; acceptance (§i) | 3d, 4 |

Priority versus 02n: Practice runs take the Paper writer first. On the code side, 02n step 3a's consensus snapshot job may still start
early (its history clock matters) if a stream is free; everything else in 02n waits behind steps 3–5 here.

## g. Non-goals

- **Orders of any kind.** No order object, order type, pending order, limit or stop simulation, account, broker, or IBKR call. Marks are
  priced by the server at the playhead and stops never trigger. No practice on live or unfinished sessions (that is paper trading).
- **Automated backtesting.** No running a strategy across many days or symbols, no batch or scheduled replays, no optimization, no
  aggregate strategy statistics beyond her own session journals. `core/backtest.py` stays unexposed.
- **Lookahead.** No full-day download, no would-fire list or count before the playhead, no day outcome in the picker, no rewind inside a
  session.
- **Consolidated-tape claims on IEX data,** bid/ask (NBBO) colouring, Level 2 and order books, and volume-at-price ladders (§h).
- **Mobile and tablet** (02l §a), multi-symbol replay, futures and options replay (stocks and ETFs only), multi-day swing replay (§h),
  drawing tools, technical-summary gauges at the playhead, sharing, sounds, AI coaching.
- **No activation.** Nothing here turns on the public Desk, IBKR, or the alert runtime; the stub setting stays off in deployments.

## h. Open questions for the orchestrator (each with a recommendation)

1. **Paper rows.** Practice at y = 47200/50000 below 02n's reserved block, or take y = 36000 and push 02n down? **Recommend 47200**:
   02n is a published plan (parallel-session rule), and an empty band on the canvas costs nothing.
2. **Tape cache.** In-process LRU of 5-minute chunks (lost on restart, refetched from Alpaca) or persisted Parquet per symbol-day?
   **Recommend the LRU now**; persist only if refetching shows up in her use.
3. **Bid/ask colouring.** Add Alpaca historical NBBO quotes to colour prints at bid or ask? **Recommend later**: quotes are several times
   the trade volume; the tick rule is a standard substitute and is labelled.
4. **Dates hidden by default** on notable days and in the workspace? **Recommend yes** for notable days; a custom date she typed is
   shown.
5. **Speeds above 10x.** **Recommend no**: `Jump` covers skimming; 1x–10x is the brief.
6. **Migration number.** **Recommend Practice takes `0004`** (it merges first) and 02n renumbers to `0005`.
7. **Partial exits and scaling in.** **Recommend not in v1**: one open trade with full exits keeps P/L and R simple to read; add after her
   first week if she asks.
8. **Multi-day swing replay** (daily or hourly bars over weeks). **Recommend a follow-up plan** after v1 ships; the session model
   generalizes by replacing `day` and `window` with a range.
9. **Forming candle from prints** (tick-by-tick candle instead of once a minute). **Recommend later**: the tape already moves each second,
   and building candles from prints adds a second aggregation path that can disagree with the official bar.

## i. Tests and acceptance (additions to 02m §d3–§d5)

- **Lookahead (backend, the core guarantee):** a property test drives random `advance` sequences (steps, jumps, `next_signal`, clamps)
  over the fixture day and asserts no returned bar closes after `to`, no print is after `to`, no signal's bar close is after `to`, `feed`
  never exceeds `revealed_through`, `revealed_through` never decreases, and an active session's GET never carries the signals list.
- **Prefix consistency:** for every 1-minute `t` in the fixture day, `evaluate(as_of=t)` equals the full-day candidates with bar close
  ≤ `t`, for each seed template and the `once`, `once_per_bar`, and `every_time` frequencies.
- **Marks and journal:** marks stamped at `revealed_through` and priced at the last eligible print; state rules return `422` problems;
  undo only before the playhead moves (`409` after); golden journal cases (long, short, auto exit at end, stop crossed and honored or not,
  max loss, no plan gives `null` score).
- **Data:** each no-data case; raw adjustment requested; tape chunk sums to the SIP bar volume; IEX fallback sets `tape_feed`; caps keep
  `count` and `volume` whole; no writes to `bars_1m`.
- **Side effects:** after a full session with armed strategies, `signals`, `alerts`, and the outbox are unchanged.
- **Contracts:** Zod, Pydantic, and crosscheck over the new fixtures; the generated-file-current tests.
- **Existing walks:** the 401 walk, ownership 404 for sessions and marks, and the no-orders route test cover the 10 routes unchanged.
- **Frontend (node tests in `lib/`):** `clock.ts` (speeds, step boundaries, no stacked requests), `keys.ts` (every key in every
  open-trade state, ignored in text fields), `marks.ts`, loaders and zod (fixtures parse, malformed payload rejected), the copy rows
  against the banned list plus the Practice list, `lanes.ts`, column priorities per band.
- **E2E (Playwright at 1440 × 900 and 1180 × 820):** hub to start; play, `B`, step, `T`, `S`, end; journal shows the trade; a resumed
  session restores the playhead; every Practice page shows the band, has no order control, and no banned words.
- **Acceptance before she relies on it:** she replays one notable day end to end; the journal P/L for one trade matches a hand
  calculation from the tape prints at the two mark times; the owner checks the browser's network log shows no bar or print past the
  playhead; one armed seed strategy's would-fire time matches its fire in the R0 snapshot.

## j. Reference patterns (Mobbin research, 2026-10-24)

Mobbin has no TradingView Bar Replay or thinkorswim OnDemand screens; their conventions (play, step, speed, jump to date, a forward-only
replay cursor) come from product knowledge. What Mobbin did supply:

- Replay timeline with event ticks, a `1x` speed menu, and a timestamped activity rail that jumps on click: [Mixpanel Session Replay](https://mobbin.com/screens/821e21b1-f186-44f4-8ff6-f536d8a277eb) (the transport bar and the signals rail).
- Transport controls centred over a timeline with a current/total time readout: [VEED editor](https://mobbin.com/screens/01c1b4f7-f430-4946-9399-32d9e6a52cb3).
- Time and sales as a narrow Price · Amount · Time column beside the chart, and a "Go to Date" date-and-time picker: [Binance](https://mobbin.com/screens/76a9afed-895e-41a8-8f20-27abf1270d3f); trade history tab beside the order book: [Coinbase Advanced](https://mobbin.com/screens/81223f90-c2e6-486e-ad9d-91e8099fe1e2).
- A persistent tinted test-mode band and a simulation clock you advance through time: [Stripe test clocks](https://mobbin.com/screens/94a95989-00e4-4070-a15b-38e9a0bbc429) (the Practice band); a "Demo trading" pill in the top bar: [OKX](https://mobbin.com/screens/a2bb80c5-27d1-4a5e-a87e-7c852a2d38f3).
- Session-ended summary with a mastery dial, outcome rows, and per-item insights: [SchoolAI](https://mobbin.com/screens/1ba00325-1eb4-4bae-973c-249c2ff8ab8c) (the journal and adherence); ROI, win-rate, and win-count tiles: [Binance lead trader](https://mobbin.com/screens/b92a460e-23dc-40d5-8a9b-cd79d8eb9b7d).
- Grouped keyboard-shortcut overlay with key chips: [Mercury](https://mobbin.com/screens/2f9852a0-c8d6-48b3-95c5-43c044bac813).

## k. 02o-b v1: daily-list practice (built 2026-10-24)

The owner's change: day-trade practice does not use a fixed symbol set. Each practice day, her own `FilterStrategySpecV1`
filters build a candidate list (20 to 50 names) for the past day she is about to replay; she stars a few, practises one,
ends the day, and sees how every candidate moved from its list price. The design (Opus, 2026-10-24) and its red team
reconciled to this v1; the full 9-endpoint design is not built.

**What v1 is.** The live screener fed from the replay blob cache, with every input cut at the time she would have looked
(`replay/screen.py`: `scan` per filter with shared `Frames`, union in filter order then rank, cap at `maxList`, `metric_row`,
the live `table_columns`). One saved plan (`PracticeBlockV1`: filters, `listAt`, `maxList`, start day, days, hide-dates, and the
`ReplaySessionV1` setup minus symbol and day) and a cursor (`practice_plans`, one active per user). Days open in order, one list
at a time, and the next day opens only after the current one ended (strict walk-forward); dates are returned and hidden by a
render rule. Migration `0006_replay_daily_lists`: `practice_plans`, `replay_day_lists`, `replay_sessions.day_list_id`,
`universe_days` (write-only: the premarket pass upserts it inside a savepoint, so it can never fail the live pass).

**Endpoints (six, all under `/api/desk/replay`, 69 `/api/desk` routes in all).** `GET /daily` (the hub card's plan and cursor);
`POST /daily/next` (open or advance the next day list; a body with a `plan` first saves it and starts the background prep);
`GET /day-lists/{id}` (the whole day list; `?peek=SYM` adds one candidate's pre-open chart data); `PATCH /day-lists/{id}`
(stars, at most five, notes, rating); `POST /day-lists/{id}/sessions` (the day's session from the plan's setup, starting at the
day clock); `POST /day-lists/{id}/end` (ends the day and unseals the review). Additive fields on the 02o responses:
`day_list_id`, the last print's `age_s`, `quiet_s` (the no-print marker) and the mark `warning`.

**No lookahead (the review's required fixes).**
- One `screen.cut_frames(bars, data_through)` feeds both the scan and `metric_row` (`metric_row`'s `_live_day` builds a partial
  "today" from whatever minutes it is given, so an uncut frame leaks the day into `last`, `volume`, `rvol_10d` and the VWAP
  fields). Tests: `test_metric_row_would_leak_the_whole_day_without_the_cut_and_no_field_equals_its_full_day_value`,
  `test_a_list_is_identical_when_every_bar_after_the_cut_is_replaced`, `test_scan_and_metric_row_get_the_same_cut_inputs`,
  `test_cut_frames_keeps_nothing_after_data_through`.
- The list price is the evaluating filter's cut price (the 08:14 bar, the cadence bar close, or the rebased last daily close),
  never `metric_row.last` (the previous close on a premarket list): `test_a_premarket_list_prices_at_the_0814_bar_not_at_metric_row_last`.
  The same price is the base of the review's move.
- The rebase uses Alpaca's split-only series (`adjustment=split`), so dividends are never applied and an ex-dividend morning
  matches the live store; a split after the day leaves the list unchanged and a split before it makes no false gap:
  `test_a_split_after_the_day_is_rebased...`, `test_a_split_before_the_day_makes_no_false_gap`,
  `test_dividends_are_not_applied...`, `test_the_rebase_asks_alpaca_for_split_only_bars`,
  `test_days_open_in_order_one_at_a_time_and_a_split_makes_no_false_gap`.
- `LIST_DATA_LAG` is the existing SIP embargo constant (`replay.data.EMBARGO`), imported, never a second 15
  (`test_the_list_lag_is_the_one_sip_embargo_not_a_second_15`).
- `metric_row` gets the live 18-calendar-day minute lookback (the list loads 14 prior sessions; `test_metric_row_gets_the_wider_lookback_or_the_intraday_rvol_is_null`);
  the scan reads the live runner's 16 days, so the list matches what the live store held. Live equivalence with `StoredBars`:
  `test_the_list_is_the_one_the_live_runner_would_have_stored`.
- The day list serves nothing later than `data_through` (candidates, Peek) or the list time (stars) before the day ends, and no
  review or day journal: `test_nothing_the_list_serves_before_the_day_ends_is_later_than_the_cut`, and the Playwright network check.

**Shared day clock, one name at a time.** `replay_day_lists.revealed_through` is the day clock: `advance` moves it (day list
row locked before the session row), a new session starts at it, and `place_mark` refuses a name whose playhead is behind it
(`test_a_name_behind_the_day_clock_cannot_be_marked_until_it_catches_up`). v1 practises one name a day: a second name is a 409, a
standalone session on a day-list name is a 409, and a day-list session ends only with its day (unsealing one name's window would
show the market's direction to the others).

**Realism.** A before-the-open earnings flag on the candidate row (`days.reaction_days` over explicit report times only; a same-day
after-the-close report is not flagged and an undated time is never guessed from the gap); the no-print marker on the tape and a
warning when a mark prices off a print older than 30 s; Peek is fed the same rebased daily frame as the list (stand-in timeline
while dates are hidden); candidate columns say "Prev close", "Prev change %" and so on where they are the previous session's
(premarket lists), beside the list price and "vs prev close %"; the universe line and its footnote sit under the list and under
the review's Selection tile. Backup: `infrastructure/backup/backup.sh` dumps with `--exclude-table-data='*.replay_blobs'`.

**Prep.** `plan.run_prep` runs once at plan creation in the API process's background (`prep.preload_bars` with the wider
lookback, plus the as-of frames), committing progress on the plan row; a day with missing blobs fetches them lazily; a prep that
stops reporting for five minutes is started again by the next open. No scheduler slot, no per-tick budget.

**Deferred to 02o-b2.** The block page and per-day schedule; `maxSymbols` and the watch checks ("picked before the open",
"traded only names on your watch"); the switch protocol and the watch strip on the shared clock; re-scan at the playhead; the
`universe_days` read path (v1 lists use today's Desk set, capped at 250 by today's dollar volume, and say so); the firstDay
post-ship default; day-ordered prep readiness; day-scope `maxLoss` and `maxTrades` across sessions.

**Deviations from the design.** Six routes, not five (the hub card needs its own small plan read); the contract keeps the design's
names (`PracticeBlockV1`, `PracticeScreenV1`) but the table is `practice_plans`; Peek is a query parameter on the day-list read,
not a route; the rebase factor comes from the split-only series, not `all`.
