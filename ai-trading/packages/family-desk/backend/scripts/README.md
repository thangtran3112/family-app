# Backend scripts

## `reconcile_swing_to_freestyle.py` (ADR-0025 step 5, one time)

Converts every swing thread to a freestyle thread and carries its open holds over as positions (D3: convert, never
liquidate). Run it once in production, after the freestyle code (steps 3 and 4) and migrations `0021`/`0022` are live and
before the contract migration drops `practice_holds`. Delete the script with that migration: it reads those tables.

It needs the runtime database URL and the market-data keys, rendered from Firestore like `ai_trading.cli.replay_prep`
(never printed, never in a file in the repository):

    cd ai-trading/packages/family-desk/backend
    ../../../../common/config/family_config.py run ai-trading/desk -- \
        uv run python scripts/reconcile_swing_to_freestyle.py            # 1. dry run: writes nothing

The dry run prints, per swing thread, the instant it will freeze at (`T`), and per open hold the swing valuation
(`before`), the freestyle mark at `T` (`after`) and the difference in USD, then the total. Read it.

- A thread marked **BLOCKED** is left alone and the script exits 1. The two causes are printed: a closed hold with no
  ledger row (it exited on a swing day that never ended, so its P/L was never credited; converting would drop it from the
  balance) and an owner with no live screener filter (the freestyle plan's Screen needs one). Fix the cause, run again.
- The differences should be cents (the official close against the last print). `--apply` is refused (exit 3, nothing
  written) when the sum of their absolute values is above 25 USD. If you have read the table and the larger figures are
  expected (a hold bought on a swing day that had not ended is priced at its entry by the swing book and at `T` here),
  add `--accept-drift`.

Then:

    ../../../../common/config/family_config.py run ai-trading/desk -- \
        uv run python scripts/reconcile_swing_to_freestyle.py --apply    # 2. one transaction per thread

`--thread ID` limits either run to one thread. Re-running is safe: a thread that is already freestyle is skipped. Each
thread's balance is checked inside its transaction and the thread rolls back if it moved.

What it changes, per active swing thread: the thread's clock (`start_at`, `clock_at`, paused) and `mode`; one lane and
one entry mark per open hold; the swing plan is archived and a freestyle plan is created over the same names; the
thread's old swing sessions are ended and detached from it (`thread_id` NULL). Closed holds, the ledger,
`practice_holds` and `practice_weeks` are not touched. A closed swing thread only gets `mode = 'freestyle'`.
