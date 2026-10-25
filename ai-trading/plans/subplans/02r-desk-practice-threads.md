# 02r — Desk practice threads: the persistent paper account across practice days

Status: **IMPLEMENTED AND INTEGRATED 2026-10-25** (`feature/desk-threads-integration`: backend and web, shipped
note at the end; PR pending); mock boards were not part of this phase. Design-level decisions below are owner-stated; implementation detail is ours.

## The concept (owner's words, condensed)

A practice **thread** is the wife's practice account. When she starts one, she gets a fake
balance — e.g. **$50,000**. Each day she practices inside the thread: filter a list with her
own strategy, replay a couple of names. **Some days she skips entirely** — no activity, the
balance simply carries. The thread tracks **wins, losses, and the balance changing**, so
after ~3 weeks to a month she can see whether she is improving. The **same thread/balance
model serves Swing practice (02p)** — day-trade and swing threads share one wallet concept,
differing only in session cadence.

## What moves where

- **The PLAN section (Shares, Stop on every entry, Trade only on a signal, Max loss, Max
  trades, Plan note) leaves the daily-list setup form.** Those are thread-level risk
  settings, not per-day filter concerns. (Defect D-006 records the current placement.)
- Thread creation asks for: starting balance (default 50,000, editable), the risk plan
  (the fields above), mode (day-trade first; swing when 02p starts).
- The daily-list setup keeps only: filters, days, list time, list size, window, interval,
  armed strategies.

## Ledger and stats

- Every realized practice mark credits/debits the thread balance at end-of-day (SIMULATED
  money; the Practice band stays on every screen).
- Ledger: one row per realized mark (session, symbol, day, P/L, R); balance derived, never
  stored twice without reconciliation.
- Thread stats: balance curve, daily P/L series, win/loss counts, win rate, average win vs
  average loss, adherence trend (existing per-day adherence aggregated), and the per-day
  Selection review stays per-day inside the thread.
- Share sizing hint from the thread: maxLoss-based sizing suggestion (maxLoss / |entry −
  stop|) — a hint only, never an order.

## Schema / contract / API (additive)

- `practice_threads` (id, owner, starting_balance, mode, plan fields, status, created,
  closed), `replay_sessions.thread_id`, `practice_ledger` (per realized mark).
  Migration `0007_practice_threads`; existing sessions/threads reconciled (one default
  thread for current data).
- Contract: `PracticeThreadV1` additive (Zod→Pydantic parity per 02k).
- API ~5 endpoints: create thread, read thread + stats + curve, list threads (resume),
  patch thread plan, close thread. The day-list `daily` endpoints gain `thread_id`.

## UI (desktop first)

- Hub: "Your threads" — start a thread (balance + plan), resume (balance + today), thread
  stats card; the daily-list card binds to the active thread.
- Day screens and workspace header show **thread balance and today's P/L** (SIMULATED).
- Thread journal: the weeks-view — balance curve, daily bars, win rate, adherence trend.
  Paper boards: extend P1 (hub) and add a thread-journal board (Sonnet), plus 1180 variant.

## Swing reuse (02p)

- A swing thread is the same object with `mode=swing`: fixed 50-symbol universe over
  weeks, multi-day holds, weekly review instead of daily. The wallet, ledger, and stats
  are shared — only cadence differs.

## Out of scope

- No real or paper brokerage orders, no backtesting engine (marks and replay only).
- No interest/margin modeling; flat cash balance.

## Relationship to defects

- D-006 (PLAN fields in the daily filter form) is fixed BY this phase.
- D-002 (arming vs filtering confusion) is re-examined here: arming is a thread/session
  concern shown at thread creation and in the workspace rail, not a filter-form concern.

## Backend notes (built 2026-10-25)

**Contracts** (`contracts/src/practice-thread-v1.ts`, Zod to Pydantic parity, four fixture families): `PracticeThreadCreateV1`
(`mode` `day|swing`, `startingBalance` 1000 to 10,000,000 defaulting to 50,000, `plan`), `PracticeThreadPatchV1` (`plan`),
`PracticeThreadV1` (the read model: `id`, `mode`, `startingBalance`, `status`, `plan`, `createdAt`, `closedAt` present exactly
when closed, and `stats`) and `PracticeLedgerEntryV1`. The plan is `stopNoteOnEntry` and `tradeOnlyOnSignal` (yes/no),
`maxLossUsd`, `maxTrades`, `planNote`. `stats` carries `balance`, `daysPracticed`, `daysSkipped`, `wins`, `losses`, `winRate`
(0..1), `avgWinUsd`, `avgLossUsd` (negative), `bestDayUsd`, `worstDayUsd`, `adherenceFirstPct` and `adherenceLastPct`; a figure
with no value is absent, never null. `PracticeBlockV1` lost `setup.plan` and `setup.shares` (D-007).

**Routes** (six, all under `/api/desk/replay`, 75 `/api/desk` routes in all): `POST /threads`, `GET /threads` (active first),
`GET /threads/{id}` (the thread, `today`, `daily` series, balance `curve`), `PATCH /threads/{id}` (replaces the plan while
active), `POST /threads/{id}/close`, `GET /threads/{id}/ledger`. Additive fields elsewhere: `thread_id` on plans, sessions and
session rows; a `thread` header (`id`, `mode`, `status`, `balance`, `today_pnl_usd`, `label`) on sessions, marks, undo and day
lists; `thread` (the full summary) on `GET /daily`; `watch_check` on day lists; `POST /daily/next` accepts `threadId`.

**Rules the screens need to know.**
- **One active thread per mode.** A second `day` thread is a 409; `swing` is a 422 until 02p. A daily plan binds to `threadId`
  or the active day thread; with none it is a 409 "Start a practice thread first", with only a closed one "Your practice thread is
  closed". `setup.plan` and `setup.shares` from an old client are dropped before validation, and a stored plan is served without
  them.
- **The plan is the thread's, snapshotted per session.** A day session copies the thread's plan when it starts (editing the thread
  applies from the next session) and enters at 100 shares unless the mark names `shares`. The maxLoss-based sizing hint is not built.
- **The ledger is the balance.** An exit mark (hers, or the day's auto-exit) books one row, once per mark; undoing the exit
  removes it. Balance, stats, the day series and the curve are read back from the ledger and the ended day lists, never stored.
  `today_pnl_usd` is realized only. A practised day is an ended day with a session; a skipped one ended with none.
- **Closing** archives the daily plan and waits for an open practice day (409), including a day a replaced plan left half practised (it is reachable by its id). Standalone sessions carry no thread and book nothing. The `thread` header on a day screen shows that day's realized P/L as `today_pnl_usd`; the ledger lists rows in booking order, not replayed-market-time order.
- **Day rules.** `maxLossUsd` and `maxTrades` count every session of a day list (checks say "across the day" once a second
  session exists); `watch_check` gives `starred`, `traded`, `off_watch` and a `verdict` for "traded only names on your watch".
  Not built: the switch protocol and re-scan at the playhead (02o-b2).
- Every money-bearing payload has a `label` saying the money is simulated.

**Web stream breaks after `pnpm gen:api`** (the frontend was left untouched): `components/practice/day/DayListScreen.tsx`
reads `setup.shares` and `setup.plan`; the response schemas in `lib/replay/daily.ts` and `lib/replay/schemas.ts` lack the new
required fields (`thread_id`, `thread`, `watch_check`); three tests (`lib/replay/dayView.test.ts`, two in
`lib/replay/planSetup.test.ts`) build a block with the old fields. Run on this branch: `pnpm typecheck` 12 errors, `pnpm test`
393 of 396 passing, all from these.

Resolved on the integration branch (see the shipped note below): the web stream was built against the older contract, and after the
merge the drift reduced to five failing frontend tests (the typecheck was already clean) and one form that still sent the dropped keys.

## Shipped note (integrated 2026-10-25)

`feature/desk-threads-integration` merges the backend (`feature/desk-threads-backend`), the web stream (`feature/desk-threads-frontend`:
the hub threads band with the New thread form, the thread journal at `/practice/journal?thread=`, the thread header on the day
screens and the workspace, thread e2e), the 02r/02p docs and the test-user auth spec into one green tree. The one contract-drift
fix (`05c5be66`): the daily plan form sends only `window`, `session`, `interval` and `armed` in `setup` (no `shares`, no risk plan,
as `PracticeBlockV1` now requires), `withThreadPlan` is gone, and the thread response schemas in `lib/replay/threads.ts` are checked
against the regenerated OpenAPI with `satisfies`. Gates: backend `ruff` clean and 3157 tests (Postgres), contracts 701, frontend 421
unit tests, lint, build, export checks, and the desktop Playwright suite (214 passed at 1440 and 1180; the production auth spec
skips without its credentials). Not built: the sizing hint from `maxLossUsd`, the switch protocol and re-scan at the playhead
(02o-b2), swing mode (02p), Paper boards for the thread screens.
