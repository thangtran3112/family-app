# ADR-0019: A resting order the clock reaches while she is away fills, it is not cancelled

Status: accepted 2026-11-01 (owner's directive: balance and equity keep moving when she is logged out). Supersedes the "No fill in a span she was on another name" rule of [ADR-0016](ADR-0016-practice-broker-ticket.md) and the "a resting order the tape reached is cancelled" clause of [ADR-0018](ADR-0018-server-thread-clock.md). Keeps [ADR-0017](ADR-0017-thread-clock.md)'s lazy lift: nothing is written to a name's session while she is not on it.

## The problem

Since ADR-0018 the thread's clock runs on the server, so a limit, stop or stop-limit order on a name she left can be reached by the tape while she is logged out. The old rule cancelled it ("The price reached it while you were on another name · it did not fill") when she came back to the name, and `end` cancelled whatever still waited when the day ended ("The day ended"). A stop that the market crossed vanished. A broker fills it, and the account moves on the fill.

## Decision

- **A resting order the tape reaches fills at the bar that proved it**, in time order, whether she was watching or not: the same `orders.first_fill` rules (side, price, `placed_at`, stop-limit legs), the same cash check against the account as it is when the fill is booked, the same mark stamped at the bar close. Nothing is stamped past the day clock.
- **Where it is booked (still lazy, ADR-0017):** when the name is next lifted to the clock (`advance`: its fill pass already reads `(playhead, target]`, the away span included; `start_session`'s resume: `session.fill_away_orders`), and when the day ends (`session.end` fills what the tape reached up to `min(day clock, window end)` before it flattens and before it cancels what is left). An order whose trigger lies after the day clock is still cancelled at the end with "The day ended": no lookahead.
- **Unchanged:** the away span is still recorded and the journal still scores no *signal* that fired in it; `triggered_at` of a stop-limit whose stop leg fired is still kept; an affordability failure at the fill still cancels the order with the cash reason.

## Consequences

- The fill is real from the moment of its bar (entry price and time, P/L from there), but it is *booked* the next time the name is touched or the day ends. Until then the Summary's equity does not include the new position. Writing every name's session as the clock moves ("eager advance") is still not done (ADR-0017): it would also have to decide which names she is watching.
- A swing name's lift fills the same way (`swing.start_session`); a swing day's end does not (a hold rides overnight and the swing clock is not server-driven).
- `AWAY_FILL` and `settle_away_orders` are gone; the only cancel reasons left are the cash rule, a user cancel and the day's end.
