# ADR-0023: A day runs open to open; Skip day lands on the open; Jump replaces End day

Status: accepted 2026-11-02, owner's directive on the Practice time controls. Amends [ADR-0018](ADR-0018-server-thread-clock.md) (the hand-over time and the manual End day) and keeps the [ADR-0022](ADR-0022-one-thread-time.md) invariants.

**Why.** Skip day jumped to the plan's "Start at" time (10:00 in the owner's plan), which hid the first 30 minutes of the session: practice bias. End day closed the day at the clock, so a position never lived through the close, the night or the weekend, which the thread clock otherwise flows through.

**The decision.**

- **A day ends at the exchange's regular open (9:30 ET) of the next trading day**, never at the plan's "Start at". `plan.next_day_start` returns that open; the hand-over (`clock.roll`), Skip day (`clock.skip_day`) and `ThreadClockOut.next_start` all use it. A plan's first day still begins at its "Start at" (nothing is handed over to it); every later day opens at the open, also when the hub opens it without a carried clock.
- **The hand-over is the one end of a day.** It books the open positions at the tape's end and stores the day's review, as End day did, so the review needs no trigger. The plan's last day ends at the open that follows it (`plan.plan_end`), when nothing opens; a clock past it reads `no_day`.
- **No manual End day for a day-trade day.** `POST /day-lists/{id}/end` answers 409 while a day-trade day is open (a swing day keeps it; an ended day answers as it is). Closing a day thread ends its open day itself, because it was the only other way to stop mid-plan; deleting a thread needs it closed first.
- **Jump = `POST /threads/{id}/clock {"to": <ISO time with offset>}`.** Forward only (a past time leaves the clock where it is), no later than `jump_limit` (the end of the plan; 422 on `to` beyond it). Past an open it hands the day over, day by day. It is the same move as a running clock, so no-lookahead and the tape-end rules are unchanged.
- **A list is not out before its time.** A day opened at 9:30 can precede the plan's list time (10:00, 10:45). Until the clock reaches `list_at` the day list answers `list_pending` with no names or counts, and no name can be opened or starred (409). A name opened before the plan's "Start at" joins at the clock and never lifts it.

**Consequences.** A position open at the hand-over exits at the day's tape-end price, not at the clock the owner last saw. Skipping across several opens builds each skipped day's list (a jump of N days costs N builds). `ThreadClockOut.window_start` is the earlier of the exchange's open and where practice starts.
