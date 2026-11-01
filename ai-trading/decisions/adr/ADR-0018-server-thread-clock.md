# ADR-0018: The day-trade thread's clock runs on the server, and its controls live on the Summary

Status: accepted 2026-11-01 (owner's directive; built on `feature/thread-clock-server`). Supersedes the *placement* part of [ADR-0017](ADR-0017-thread-clock.md) (the clock is no longer a bar above the replay workspace) and keeps the rest of it (one clock per thread; lazy lift of a name's session; no eager scoring of names she is not watching).

## The problem

The thread's time was one shared clock (`replay_day_lists.revealed_through`) but only a browser moved it: the replay workspace asked `/advance` once a second while its `Play` was on. Leave the screen and the timer died with the component, so the thread stopped, and coming back needed `Play` again. Logging out stopped it for good. The balance was realized P/L only, so an open long or short never moved it.

## What a paper-trading account is, done right

A paper account is three things and nothing else:

1. **Time.** A simulated exchange clock. It belongs to the simulated world, not to a screen. It advances at `speed x wall time` while running, and it can be paused, stepped and jumped. A viewer neither owns nor keeps it.
2. **A ledger.** The append-only list of executions: each Buy and Sell with shares, price and time. It is the only record of what she did. Cash, positions and realized P/L are derived from it.
3. **Marks.** The price of each name *at the clock*, never later (no lookahead).

Everything she looks at is a pure function of `(ledger, marks at the clock)`: `equity(t) = starting cash + realized + sum(position x (mark(t) - average cost))`. So the balance moves because the clock moves, whether or not anyone is looking. Nothing in the client stores time, positions or a balance; it renders what the server computes for "now".

## Decision

- **Clock state on the server, on the day list.** `replay_day_lists` gains `clock_running`, `clock_speed` (1, 2, 5, 10), `clock_anchor_at` (the wall instant `revealed_through` was last true) and `clock_pause` (why it stopped). The simulated time is still `revealed_through`.
- **Lazy materialization, no worker.** `replay/clock.py::settle` computes `target = revealed_through + speed x (now - anchor)` whenever the clock is read, under the day-list lock, and writes it back with a new anchor. The clock therefore survives logout, navigation, a closed laptop and a server restart: it is a function of wall time, not of a connection. Two requests cannot double-count (the lock serializes them; the second finds a fresh anchor).
- **Stops and the close.** `settle` runs the existing stop scan over every open name: the clock stops at the first crossed stop (`clock_pause.kind = "stop"`, a stop never exits). It stops at the window end (`kind = "close"`) and the day is *not* ended for her: End day or Skip day books the exits at the window-end price. A clock that ran to the close while nobody was there is explained by `clock_pause` when she comes back.
- **Transport at the Summary.** `Play/Pause`, `Step`, speed, `Jump`, `Next signal`, `To the close` and the timeline are the `ThreadClockPanel` on the thread Summary. They call `POST /api/desk/replay/threads/{id}/clock`. The day-trade replay workspace and the day list carry no transport. A swing thread keeps its own per-session transport (its week/hold clock is a different model; not changed here).
- **Skip day.** `POST /threads/{id}/skip-day` runs the clock to the window end *ignoring stop pauses*, ends the day (every open name flattens at the close), and opens the next day's list. It is the "I am done acting today" action; End day (exit at the clock now) stays.
- **Names follow the clock; no scoring change.** A name's session `revealed_through` is still her view of that name (ADR-0017). A name she is on is lifted quietly to the clock when it is behind by no more than `ATTENTION_S` of thread time (she was watching: the replay screen syncs every 2 s and any mark or order does the same lift first). A name she was away from keeps the old rules: the span is an away span, signals in it are not scored, a resting order the tape reached is cancelled. Nothing is written to a session she is not on.
- **Balance.** `GET /threads/{id}/clock` returns `account`: realized balance, open P/L of every open position priced at the clock, and equity. The Summary shows equity as the live balance.
- **Ledger.** Every execution is already a `practice_marks` row (`kind`, `shares`, `price`, `at`, `trade_no`, `source`); each realized exit is a `practice_ledger` row. The client used to see them only through one session at a time. `GET /threads/{id}/fills` returns every Buy and Sell of the thread (shares, price, time, whether it opened or closed), computed on the server from the marks; the Trades tab renders it.
- **Order tab.** The tab no longer resolves to "the open day's newest session". `/practice/order?thread=<id>` is a neutral "pick a stock" screen; a chart opens only for a `{stockId}` chosen on the Day list or the Portfolio (`/practice/replay?id=<session>`).

## Sync: poll, not push (recommendation and why)

**Client polling every 2 s while the page is visible, against a lazily settled server clock.**

- **No lookahead forbids client self-calculation of the balance.** To price a position between polls the client would need prices after the clock, which the server must never send. The client may extrapolate the *clock label* (`clock + (now - fetched) x speed`, clamped to the close) but not a balance; the balance comes from the server on every poll.
- **Push buys nothing here.** The clock needs no tick loop (it is computed on read), so a push channel would add a connection registry, heartbeat and reconnect logic, and WebSocket/SSE buffering through the Cloudflare tunnel and the Caddy/Clerk gate, for one household user per thread. Polling is one idempotent request, easy to test with an injected clock, and it works the same after a restart.
- **Cost.** A settle on a running clock is one row lock and, at most, a stop scan; a stopped clock costs one indexed read. Polling pauses when the tab is hidden and resumes with an immediate read.
- **Not a ceiling.** If sub-second prices or many viewers ever matter, SSE can wrap the same `settle`; the server model does not change.

## Edge cases decided

- Clock reaches the close while playing: stops there, `state = "at_close"`, `clock_pause = close`; positions stay open at the close mark; End day or Skip day books them.
- Stop crossed while she is away: clock stops at the crossing; `clock_pause` carries symbol, stop, price; the Summary shows it and Resume continues past it (the stop is marked hit, as before).
- Step and Jump while running keep it running; a stop pause or the close ends the run.
- A day that has not started (no name opened) has no clock to run: the panel says to start the day. Skip day on a listed day books a Pass and opens the next.
- Speed change materializes the clock at the old speed first, so no past time is re-priced.
- The next day opens paused (a day starts when she opens a name); speed carries over.

## Tests

`tests/replay/test_thread_clock.py` (settle, pause at a stop, window end, speed change, step/jump, skip day, logout resilience with an injected `now`, no lookahead, account equity, fills), the migration test, `lib/replay/threadClock.test.ts`, and `e2e/desk/practice-clock.spec.ts`.
