# 02r — Desk practice threads: the persistent paper account across practice days

Status: **PLANNED — immediate next practice phase** (owner directive, 2026-10-25). Design-level
decisions below are owner-stated; implementation detail is ours. Starts after the current
defect batch lands; mock-board updates ride with it.

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
