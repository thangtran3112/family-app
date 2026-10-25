# 02p: Family Desk swing practice (placeholder)

Status: PLANNED 2026-10-25, not started. No design, code, migration, or routes exist yet. [02q](02q-laptop-migration.md) reserves the number `02p` for this amendment. The design is written when the owner schedules it (STATUS row 5K).

## What it is

A swing lane for Practice (Replay), the feature in [02o](02o-desk-replay-practice-plan.md). The user replays a fixed universe of 50 symbols over 3 weeks to 1 month and holds positions across days. 02o §h item 8 recommends this follow-up plan after v1 ships.

## What it reuses

The 02o replay core, with the same shape: sessions, the tape (`replay/tape.py`), practice marks, and the journal (`replay/journal.py`). The session model generalizes by replacing the single `day` and `window` with a date range (02o §h item 8).

## What differs from day-trade practice

- **Fixed universe.** The 50 symbols are set once. The daily-list flow in 02o-b (per-day filter lists, the day clock, stars) does not apply.
- **Multi-day holds.** A position can stay open across sessions. Marks, stop notes, and P/L carry from one day to the next.
- **Weekly review.** The journal scores each week as well as each session.
- **Same rules as 02o §g.** No orders, no automated backtesting, and no lookahead: bars and prints are released only up to the playhead.

## Open until scheduled

Universe source and refresh, bar interval (daily or hourly), how holds carry across sessions, the weekly journal layout, and the migration number.
