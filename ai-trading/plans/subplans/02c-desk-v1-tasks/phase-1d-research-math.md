# Phase 1d: Research Math

Part of [02c-desk-v1-implementation-plan.md](../02c-desk-v1-implementation-plan.md). Read its Global Constraints, Review Focus, and Shared Interfaces first. Builds on [Phase 1](phase-1-strategy-core.md) and [Phase 1b](phase-1b-ported-quant-core.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Subagents work in a `.worktrees/` worktree on their own `feature/*` branch; the main session merges that branch into `feature/toby` (root `AGENTS.md`).

> **Revision note:** this plan was re-rendered from a second, fixed prototype pass after an independent review returned "ready with fixes". The fixes are called out throughout — see "Most consequential" under Decisions for Owner Review and the retired/new entries there.

**Goal:** give the Desk the pure math its research tools need (02h): as-of windows that keep backtests and historical tool calls from seeing the future, deterministic intrinsic-value methods, a single-stock earnings-reaction summary, a backtest engine that runs a strategy spec over history through the live evaluator and enforces the spec's own limits, and idempotent settlement of each Desk AI call against SPY on the real exchange calendar. No I/O; nothing is deployed.

**Architecture:**
- Five modules in `ai-trading/packages/family-desk/backend/src/ai_trading/core/`:
  - `asof.py`: one as-of boundary (`known`) and half-open windows (`window`, `in_window`), plus `closed_bars`, `as_filed`, and `published` filters over a Series/DataFrame — adapted from TradingAgents;
  - `valuation.py`: the six named ai-hedge-fund v1 valuation functions, copied with `None`-for-unavailable semantics, plus a new `blended_value` that returns a `BlendedValue(value, methods_used)` (02h §4);
  - `earnings_reaction.py`: a single-stock market-model reaction (`event_reaction`) and a beats/misses summary (`summarize`), adapted from ai-hedge-fund's event-study engine, without scipy or the bootstrap;
  - `backtest.py`: runs a `StrategySpecV1` over one or more symbols' bars through Phase 1's `evaluate()` and Phase 1b's `sizing.plan_order()`, bar by bar, into trades, an equity curve, and statistics; resolves `paperOrder` stop/target levels directly through `core/levels.py`; marks open positions to market for `pctOfBook` sizing; enforces `spec.limits`; takes per-symbol `InstrumentSpec` and a required benchmark (02h §2);
  - `settlement.py`: settles a Desk AI call against SPY once its 90-trading-**session** horizon (the real XNYS exchange calendar) has matured, idempotently, returning `Pending(call, reason)` rather than raising on a data gap (02h §3).
- No contract changes: these modules take plain values and `StrategySpecV1`/evidence the Desk already produces; nothing new is validated by Zod or Pydantic.
- `packages/family-desk/THIRD_PARTY_NOTICES.md` gains a "TradingAgents" section (Apache-2.0, one row, marked modified, with the **complete, verbatim** upstream `LICENSE`) and an "ai-hedge-fund" section (MIT, two rows, with the **complete, verbatim** upstream `LICENSE` and its real copyright holder). `backtest.py` and `settlement.py` reuse patterns and ideas only, not code, so they add no row.

**Tech Stack:** as Phase 1b, plus `exchange_calendars` for `settlement.py`'s XNYS horizon — already a 02c Tech Stack dependency (`pyproject.toml` already pins `exchange-calendars>=4.13` for the future IBKR/data-foundation phases), so this is not a new dependency. `earnings_reaction.py`'s market-model fit uses `numpy.linalg.lstsq` (numpy is already a dependency via pandas); `valuation.py` uses only the standard library (`statistics`).

**Spec:**
- [02h §2–§4, §7](../02h-desk-research-tools-design.md): strategy backtests, the Desk AI track record (settlement), valuation and earnings reaction, and their test list
- [02a §11](../02a-desk-v1-strategies-design.md): the reuse map's Phase 1d rows
- [02c](../02c-desk-v1-implementation-plan.md) Global Constraints, Review Focus, and Shared Interfaces; "Phase 1d: Research math" in its Phase Outlines; `ai-trading/AGENTS.md` "Our Code"

## Decisions for Owner Review

Consolidated from the three prototype reports (`REPORT-E.md`: as-of helpers, valuation, earnings reaction, unchanged since the last revision; `REPORT-F.md`: backtest engine, settlement, now in its revision-3 "scoped re-review" fixes).

### Most consequential

This round's fixes first (the scoped re-review's own "critical" and "important" findings), then the still-valid fixes from the previous round:

1. **Critical — `backtest.py`'s per-bar loop is now three explicit, ordered stages**, not one pass per symbol that did everything: **(1a)** at the open, a held position gaps out if the open already cleared its stop or target; **(1b)** at the open, only for symbols now flat, a signal queued at the *previous* bar's close fills, sized and limit-gated on state already known at this open; **(2)** during the bar, every open position (including one just filled) is checked against the low and high — stop before target when both are touched — and a due time exit fires at the close; **(3)** at the close, this bar's fired signal queues for the next open only if the symbol is flat *right now*, and is dropped on the spot otherwise. This is the actual fix for same-bar re-entry: previously every fired signal was queued up front regardless of position state at the moment it fired, so a signal that fired while a position was open could still sit in the queue and fill the instant that *old* position happened to exit — even on the very same bar. `_EntryCandidate`/`_entry_candidates` (a precomputed, position-state-independent deque) are gone, replaced by `_signal_positions` (which bar each signal fired, nothing more) and a single `pending: dict[str, int | None]` slot per symbol, set only at a close where that symbol is flat. New tests: `test_no_same_bar_reentry_when_an_old_stop_and_a_new_entry_share_a_bar` (the reviewer's exact case), `test_a_signal_while_holding_a_position_is_dropped` (the general case).
2. **`pctOfBook` sizing now marks every other open position at *this bar's own open*, not the earlier signal bar's close.** `book_equity` at a fill is `cash + unrealized P&L of every other open position, marked at this same open` (`_mark(..., field="open")`), and limits are checked against state already updated through the gap-exit stage that runs first. This refines last round's mark-to-market fix, which marked at the *signal* bar's close — one full bar earlier than the actual fill. `test_sizing_uses_open_time_equity_not_a_later_exit_in_the_same_bar` is the regression: a second symbol's size reflects another position's mark at this bar's open, not its unrealized value a bar earlier nor its exit later the same bar.
3. **`settlement.py`: the target-hit window now excludes the call date itself.** `_target_hit` starts at `exchange_calendars.next_session(call.call_date)` through the settle date (inclusive) — the call is made after that day's close, so it cannot itself register a touch. Previously the window ran from `call.call_date` through the settle date inclusive, so a target already touched on or before the call was made could still count as a hit. `test_target_window_excludes_the_call_date_itself` checks a target reached only on the call date (must not count) against the identical move one session later (must count).
4. **`settlement.py`: a symbol entirely missing from `settle_all`'s `prices` map now gives `Pending(call, "no price data for <symbol>")` instead of raising `KeyError`.** `settle()` itself now accepts `prices: pd.DataFrame | None`, so the "no data at all" case is expressible and testable through `settle()` directly, not just swallowed silently inside `settle_all`'s loop.
5. **`settlement.py`: incomplete high/low coverage in the target window now makes `target_hit` `None` with a reason, never a silently wrong `False`.** A `NaN` high or low — or a session missing entirely from `prices` — anywhere in the window previously compared `False` in pandas, so an incomplete window could register a false "not hit" without any signal that the data was incomplete. `Outcome.target_hit` is now `bool | None`, with a new `target_hit_reason: str | None` naming the first such session; `excess_return_pct`, `success`, and `calibration_bucket` still settle normally, since they need only the two endpoints.
6. **`backtest.py`: commission moved into `InstrumentSpec` as `commission_per_unit`** (default $0.005, per share for a stock or per contract for a future, set by the caller); `Costs` now carries only `slippage_ticks`. Slippage already used each symbol's own `tick_size`; it still does. `test_two_instruments_use_their_own_multiplier_tick_size_and_commission` gives a futures-like instrument its own $2.50/contract commission alongside its multiplier and tick, and checks both symbols' realized `pnl`.
7. **`THIRD_PARTY_NOTICES.md` fix (previous round), unaffected.** The TradingAgents entry carries the complete, verbatim upstream `LICENSE` (not an excerpt with a fabricated copyright line); the ai-hedge-fund MIT entry's copyright reads `Copyright (c) 2024 Virat Singh`, the real upstream holder.
8. **`backtest.py`: stop/target levels resolve independently of `when` (previous round), unaffected.** `_level_series`/`_level_cache` call `core/levels.py`'s functions directly, so a level used only in `paperOrder` still sizes correctly even when the strategy's `when` never mentions it.
9. **`backtest.py`: `spec.limits` gates every new entry (previous round), unaffected in scope.** `maxOpenPositions`/`maxTradesPerDay`/`pauseAfterDailyLossUsd` are account-wide; `cooldownMinutes` is per symbol, intraday cadences only. This round's fix changes *when in the per-bar sequence* a blocked candidate is checked (now stage 1b, against state already updated by stage 1a's gap exits), not which fields are enforced or their scope.
10. **`backtest.py`: Sharpe annualizes by the strategy's own cadence (previous round), unaffected.** `sqrt(252)` for daily, `sqrt(52)` for weekly, via `stats()`'s `frequency` parameter.
11. **`valuation.py`: `blended_value` returns `BlendedValue(value, methods_used)` (previous round), unaffected.** A caller can tell a full three-method 02h §4 blend apart from a weaker one computed over fewer available methods.

### Retired by this round's fixes

- ~~`pctOfBook` sizing marks every other open position to market at the new signal's own bar's close~~ → replaced by Most-consequential #2: marked at the fill bar's own open.
- ~~A signal that fires while a position is already open is already handled (dropped), consistent with how a blocked candidate is dropped~~ → this was not actually guaranteed by the old precomputed-queue design (see Most-consequential #1): a signal fired while holding could still fill later the same bar if the held position happened to exit on it. Replaced by: a signal is queued only at a close where the symbol is flat *at that moment*, never queued otherwise.
- ~~A time exit (`flatBy`) fires at the open of the first bar whose clock time is at or after `flatBy`~~ → replaced: it fires at the **close of the first bar whose end is at or after `flatBy`** (not the bar whose start is), and the exit is recorded at that bar's own end, not its start — see decision 41 in backtest.py below for the exact rule and why it handles a missing bar for free. `test_flat_by_forces_an_intraday_exit_at_the_close_of_the_bar_ending_at_it` (renamed again from `..._at_its_close`) and the new `test_flat_by_uses_the_first_later_bar_when_its_own_bar_is_missing` are the regressions.
- ~~The target-hit window is `prices.loc[call.call_date : settle_date]` (inclusive of the call date)~~ → replaced by Most-consequential #3: the window starts strictly after the call date.
- ~~An incomplete high/low window silently compares `False` (not hit)~~ → replaced by Most-consequential #5: explicit `target_hit=None` with a reason.
- ~~A symbol missing from `settle_all`'s `prices` map raises `KeyError`~~ → replaced by Most-consequential #4: `Pending(call, "no price data for <symbol>")`.
- ~~Commission is a single `Costs.commission_per_share` field shared by every symbol~~ → replaced by Most-consequential #6: `InstrumentSpec.commission_per_unit`, per symbol.

### Retired by the previous round's fixes

- ~~Level-based stop/target resolution reuses `evaluate()`'s own evidence~~ → replaced by Most-consequential #8: levels now resolve directly through `core/levels.py`, independent of `when`.
- ~~The 90-trading-day horizon is counted on the `prices` series' own index~~ → replaced by the XNYS exchange calendar's 90th session, with `Pending` rather than `KeyError` on a gap (now further extended by this round's #3–#5 above).
- ~~`maxOpenPositions`/`maxTradesPerDay`/`cooldownMinutes`/`pauseAfterDailyLossUsd` are not enforced by the backtest core~~ → replaced by Most-consequential #9: all four are enforced.
- ~~Sharpe is always annualized by `sqrt(252)`~~ → replaced by Most-consequential #10: `sqrt(252)` for daily, `sqrt(52)` for a weekly-cadence strategy.
- ~~`target_hit` only uses the daily closes given~~ → replaced by OHLC-based touches (now further refined by this round's #3 and #5 above).

### asof.py

12. **An undated item is always withheld, never kept because "the window reaches the present."** Unaffected by any revision.
13. **`as_filed`/`published` take a DataFrame and a column name**, not a list of dicts. Unaffected by any revision.

### valuation.py

14. **`valuation.py` returns `None`, never `0` or a crash, for unavailable inputs.** Unaffected by any revision.
15. **A denominator that would be non-positive also gives `None`, which upstream never checked.** Unaffected by any revision.
16. **`calculate_ev_ebitda_value` and `calculate_wacc` each lost one dead parameter** (`debt_to_equity`, `growth_metrics`). Unaffected by any revision.

### earnings_reaction.py

17. **`event_reaction` requires `announced` to already be a trading day present in the return index.** Unaffected by any revision.
18. **`r_squared` and the unused `growth_metrics` parameter are dropped.** Unaffected by any revision.
19. **`EventReaction.beat` is `bool | None`**, not a three-way enum. Unaffected by any revision.
20. **`summarize`'s "N reports" is whatever list the caller passes.** Unaffected by any revision.

### backtest.py

21. **A bar's queued entries fill in a fixed (sorted) symbol order, sequentially, within stage 1b.** If two symbols both have a queued entry on the same bar, the second one's `pctOfBook` sizing sees the first one's position already open — consistent with `cash` itself being updated sequentially too (e.g. commission). A deliberate simplification of "simultaneous" orders, not a new source of look-ahead: both still size off this bar's own open, never a later price. New this round.
22. **`benchmark` is a required parameter** of both `backtest()` and `stats()`; `benchmark_return_pct` is a plain `float`, never `None`. Unaffected by this round.
23. **Per-symbol `InstrumentSpec` (multiplier, tick size, commission) replaces the old global `multiplier`/`Costs.commission_per_share`/`Costs.tick_size`.** A symbol missing from the `instruments` map defaults to a stock (multiplier 1, tick $0.01, commission $0.005/share). Unaffected by this round beyond commission's move (Most-consequential #6).
24. **Max drawdown counts from the starting equity as the initial peak**, so a loss already present on the very first mark is captured. Unaffected by this round.
25. **`maxOpenPositions` and `maxTradesPerDay` are account-wide** (summed across every symbol in the run). Unaffected by this round (see Most-consequential #9 for the sequencing refinement).
26. **`pauseAfterDailyLossUsd` is also account-wide**, checked against the sum of that calendar day's realized trade P&L across every symbol. Unaffected by this round.
27. **`cooldownMinutes` is per symbol**, and only applies to intraday cadences. Unaffected by this round.
28. **ATR length for `paperOrder.stop.atrMultiple` defaults to 14.** Unaffected by any revision.
29. **"Risk as a percent of equity or a fixed dollar amount" is exactly `sizing.py`'s existing `riskUsd`/`pctOfBook` size options.** Unaffected by any revision.
30. **Sizing, stop, and target are computed off the unslipped planned entry price.** Unaffected by any revision.
31. **Stop is checked before target when a bar touches both** — now implemented as `_touch_exit`, explicitly separated from the open's gap check (`_gap_exit`), and re-verified under the new three-stage sequencing by `test_stop_checked_before_target_when_a_bar_touches_both`. Unaffected in outcome, re-tested under the new structure.
32. **Multi-symbol backtests require every symbol's execution bars to share one identical index.** Unaffected by any revision.
33. **A position still open at the last bar of the data closes at that bar's close**, exit reason `"end_of_data"`. Unaffected by any revision.
34. **`Trade.pnl` is the full round-trip P&L (both commissions).** Unaffected by any revision.
35. **Win rate's denominator includes breakeven trades; the numerator only counts `r > 0`.** Unaffected by any revision.
36. **`profit_factor` is gross dollar profit / gross dollar loss.** Unaffected by any revision.
37. **CAGR uses calendar days.** Unaffected by any revision.
38. **`returns_by_year` buckets by each bar's own calendar year.** Unaffected by any revision.
39. **`avg_hold_bars` counts the entry and exit bar inclusively.** Unaffected by any revision.
40. **`exposure_pct` is account-level.** Unaffected by any revision.

41. **`flatBy` fires on the first bar whose *end* (not its start) is at or after the limit, and the exit is recorded at that bar's own end, not its start.** Bars are labeled by their start, so "flat by 11:00" fires on the bar that *ends* at or after 11:00 (the 10:59 bar, which ends at 11:00, not the 11:00 bar, which only ends at 11:01); a bar missing from the data is handled for free, since whatever bar actually ends at or after the limit fires, with its own real end — no special-casing needed. This refines the previous round's "flatBy fires at the close, not the open" fix with the exact bar it fires on and the exact time it records. New this round. `test_flat_by_forces_an_intraday_exit_at_the_close_of_the_bar_ending_at_it` and `test_flat_by_uses_the_first_later_bar_when_its_own_bar_is_missing` are the regressions; `test_flat_by_does_not_apply_to_daily_bars` confirms the cadence restriction still holds.

### settlement.py

42. **Settlement's `Rating` is lower-case `"buy"|"hold"|"sell"`, confidence 0-100.** Unaffected by any revision.
43. **Hold's ±5% band is on the excess return, inclusive, rounded to 6 decimals before the comparison.** Unaffected by any revision.
44. **Calibration buckets are half-open.** Unaffected by any revision.
45. **`settle()`'s calendar is a module-level `exchange_calendars.get_calendar("XNYS")`**, not routed through `core/calendar.py`. Unaffected by this round.
46. **`_target_hit`'s window is built from `exchange_calendars.sessions_in_range`**, the same calendar instance `settle()` already uses for the horizon, rather than reusing whatever rows happen to be in `prices` — this is exactly what lets a missing *row* (not just a `NaN` value) inside the window also produce an unknown target. New this round.
47. **A `nan` entry/exit price on the two settlement endpoints is also treated as `Pending("missing_price_data")`**, consistent with "never raises `KeyError`." Unaffected by this round (distinct from the target window's own, separately-reasoned "unknown" case added this round).
48. **`PendingReason` is a plain `str`, not a closed `Literal`**, now that it also carries a dynamic per-symbol message (`f"no price data for {symbol}"`) and `target_hit_reason` carries a dynamic per-session message (`f"missing high/low for {date}"`). New this round.
49. **`settle_all` still returns only `list[Outcome]`**; `Pending` results (any reason) are simply absent. Unaffected by any revision.

## Review Focus

The 5 failure modes most likely to bite overall, each still pinned by a test (not just this round's fixes — level independence, limits enforcement, and data-gap `Pending` are also stable and tested, but are no longer among the top 5; see Decisions #8, #9, #45/#47 for those):

1. **The backtest's three time rules must all hold together, not just individually: a signal fills at the next bar's open, never its own signal bar's close (next-open fills); no later bar's data ever changes an earlier, already-closed trade (no look-ahead); and a signal fired while a position is already open must never queue and fill once that position exits, even on the very same bar (no same-bar re-entry).** These three guarantees interact — the queueing mechanism that gives next-open fills is the same mechanism that can silently reintroduce same-bar re-entry or a look-ahead leak if it is ever changed without re-checking all three together. Pinned by `test_signal_fills_at_the_next_bars_open_not_the_signal_bars_close`, `test_mutating_bars_after_a_date_leaves_every_earlier_trade_identical`, `test_no_same_bar_reentry_when_an_old_stop_and_a_new_entry_share_a_bar`, and `test_a_signal_while_holding_a_position_is_dropped` (Task 1d.4).
2. **Stop must be checked before target when a bar touches both, and this must still hold once gap exits, fills, and intrabar touches are separate stages.** Pinned by `test_stop_checked_before_target_when_a_bar_touches_both` (Task 1d.4).
3. **A target reached on the call date itself must not count as a hit** — the call is made after that day's close. Pinned by `test_target_window_excludes_the_call_date_itself` (Task 1d.5).
4. **Incomplete high/low coverage in the target window must make the target unknown, never a silently wrong "not hit".** Pinned by `test_incomplete_high_low_coverage_makes_the_target_unknown_but_still_settles_the_verdict` and `test_a_row_missing_entirely_from_the_target_window_also_makes_it_unknown` (Task 1d.5).
5. **Commission must be charged per the entering symbol's own instrument spec (per share or per contract), never one flat rate shared by every symbol.** Pinned by `test_two_instruments_use_their_own_multiplier_tick_size_and_commission` (Task 1d.4).

## Integration notes for later phases

These modules are pure; the phases that actually run them in the Desk still have work to do.

**Phase 5 (long-term, covered calls, Desk AI):**
- Persists each settled `Outcome` once — an insert-once (or upsert keyed by the call) into `ai_call_outcomes` — since `settle`/`settle_all` only compute the value to write and do not write it themselves; re-running the job must not duplicate a row for a call already settled.
- Stores an unknown target (`target_hit=None`, with `target_hit_reason`) as unknown — never coerced to `False` — so an incomplete high/low window never shows as a confirmed miss on the track record.
- Supplies point-in-time filing data (through `asof.as_filed`) and the 8-K (Item 2.02) announcement date — not the 10-Q — to `earnings_reaction.event_reaction`, already snapped to a trading day present in the return index (`event_reaction` does not snap it itself; see decision 17).
- Supplies the last 8 reports (sliced by the caller) to `earnings_reaction.summarize`; the module itself only enforces the `< 4` usable floor (decision 20).
- Supplies the daily high and low series, not just closes, to `settlement.settle`'s `prices` DataFrame, so target touches actually see intraday highs and lows.

**Phase 6b (backtests):**
- Supplies the required `benchmark` series to `backtest()` (decision 22) — a backtest run with no benchmark is no longer representable.
- Supplies per-symbol `InstrumentSpec` values, **including `commission_per_unit`** (decision 23, Most-consequential #6): futures from Phase 1c's `core/futures.py` contract specs (multiplier, tick size, and the contract's own per-contract commission), stocks by the default (`InstrumentSpec()`, multiplier 1, tick $0.01, $0.005/share) when a symbol is omitted from the map.
- Presents results with 02h §2's honest-results labels ("Survivorship: this list was chosen today"; "Past results do not predict paper or live results") next to every backtest's statistics, including the required benchmark comparison.

All paths below are relative to `ai-trading/packages/family-desk/` unless they start with `ai-trading/`. Commands run in the directory a step names. Every GREEN step's full-suite count is a **delta**, not an absolute total: the absolute total is Phase 1c's final count (whatever `phase-1c-technicals-and-futures.md` lands at) **plus** this phase's delta. This plan was written against the Phase-1b-only baseline (169 passed, no Phase 1c); verified fresh, this phase's five tasks grow that baseline by 94 (5 + 18 + 8 + 26 + 37 — see each task's own Step for its GREEN count), for 263 passed if Phase 1c has not yet merged when Phase 1d starts.

### Task 1d.1: As-of helpers

**Files:**
- Create: `backend/src/ai_trading/core/asof.py`, `backend/tests/test_asof.py`
- Modify: `THIRD_PARTY_NOTICES.md` (append a new "TradingAgents" section, with the complete, verbatim upstream `LICENSE`)

**Interfaces:**
- Consumes: nothing (pandas only).
- Produces:
  - `known(ts: pd.Timestamp | None, asof: pd.Timestamp, *, inclusive: bool = False) -> bool`
  - `window(asof: pd.Timestamp, lookback: pd.Timedelta) -> tuple[pd.Timestamp, pd.Timestamp]`
  - `in_window(ts: pd.Timestamp | None, start: pd.Timestamp, end: pd.Timestamp) -> bool`
  - `closed_bars(bars: pd.DataFrame, asof: pd.Timestamp) -> pd.DataFrame`
  - `as_filed(filings: pd.DataFrame, asof: pd.Timestamp, column: str = "filed_at") -> pd.DataFrame`
  - `published(news: pd.DataFrame, asof: pd.Timestamp, column: str = "published_at") -> pd.DataFrame`

`asof.py`'s own source and docstring are unchanged by this revision (its attribution header never claimed a fabricated copyright line); only the `THIRD_PARTY_NOTICES.md` entry this task writes changes, to the complete TradingAgents `LICENSE` (see Decisions for Owner Review, Most consequential #1).

- [ ] **Step 1: Write the failing test** `backend/tests/test_asof.py`:

```python
import pandas as pd

from ai_trading.core import asof

ASOF = pd.Timestamp("2026-06-15", tz="UTC")


def test_known_is_strict_by_default_and_inclusive_on_request():
    before = pd.Timestamp("2026-06-14", tz="UTC")
    on = ASOF
    after = pd.Timestamp("2026-06-16", tz="UTC")
    assert asof.known(before, ASOF) is True
    assert asof.known(on, ASOF) is False  # strict: not yet known at its own instant
    assert asof.known(after, ASOF) is False
    assert asof.known(on, ASOF, inclusive=True) is True  # a filing is known the day it is filed
    assert asof.known(after, ASOF, inclusive=True) is False


def test_undated_is_never_known():
    assert asof.known(None, ASOF) is False
    assert asof.known(pd.NaT, ASOF, inclusive=True) is False


def test_window_is_half_open_ending_at_asof():
    start, end = asof.window(ASOF, pd.Timedelta(days=30))
    assert start == pd.Timestamp("2026-05-16", tz="UTC")
    assert end == ASOF
    assert asof.in_window(start, start, end) is True  # start is inside
    assert asof.in_window(end, start, end) is False  # end is excluded
    assert asof.in_window(None, start, end) is False


def test_closed_bars_excludes_the_bar_still_forming():
    bars = pd.DataFrame(
        {"close": [100.0, 101.0, 102.0]},
        index=pd.DatetimeIndex(["2026-06-13", "2026-06-14", "2026-06-15"], tz="UTC"),
    )
    out = asof.closed_bars(bars, ASOF)
    assert list(out["close"]) == [100.0, 101.0]


def test_filings_are_known_the_day_they_are_filed_news_is_not():
    filings = pd.DataFrame(
        {
            "filed_at": [
                pd.Timestamp("2026-06-14", tz="UTC"),
                ASOF,
                pd.Timestamp("2026-06-16", tz="UTC"),
                pd.NaT,
            ]
        }
    )
    out = asof.as_filed(filings, ASOF)
    assert list(out.index) == [0, 1]  # on or before asof; the undated row (3) is withheld

    news = pd.DataFrame(
        {
            "published_at": [
                pd.Timestamp("2026-06-14", tz="UTC"),
                ASOF,
                None,
            ]
        }
    )
    out = asof.published(news, ASOF)
    assert list(out.index) == [0]  # strictly before asof; same-instant and undated are withheld
```

- [ ] **Step 2: Run it and watch it fail.**

Run (in `backend/`): `uv run pytest -q tests/test_asof.py`
Expected: collection error, `ImportError: cannot import name 'asof' from 'ai_trading.core'`.

- [ ] **Step 3: Implement** `backend/src/ai_trading/core/asof.py`:

```python
"""As-of boundaries and half-open windows: filters that keep only data known at a decision time,
so backtests and historical tool calls replay without seeing the future (02h section 1).

Adapted from TradingAgents `tradingagents/dataflows/date_window.py` (Apache License 2.0; local
copy at ai-trading/packages/trading-agents; see THIRD_PARTY_NOTICES.md). **Modified** from the
original: pandas Timestamps replace "YYYY-MM-DD" strings, filters operate over a Series/DataFrame
instead of per-item string clamping, and the model-facing tool helpers (`as_of`, `as_of_window`,
`coverage_gap`, `withhold_*`) are dropped — the Desk's stored bars and filings are already dated,
so there is no live "did the model ask for a later date" guard to adapt. The original's `in_window`
keeps an undated item when a live window "reaches the present"; this pure module has no clock to
compare against, so an undated item here is always withheld, never guessed about.
"""

import pandas as pd


def known(ts: pd.Timestamp | None, asof: pd.Timestamp, *, inclusive: bool = False) -> bool:
    """Whether a dated item was known at `asof`.

    Strictly before `asof` by default (a bar is known once it closes; news once published).
    `inclusive=True` for items known on their own date (an SEC filing is known the day it is
    filed). An undated item (`ts` is None or NaT) is withheld: never known.
    """
    if ts is None or pd.isna(ts):
        return False
    return ts <= asof if inclusive else ts < asof


def window(asof: pd.Timestamp, lookback: pd.Timedelta) -> tuple[pd.Timestamp, pd.Timestamp]:
    """The half-open window `[asof - lookback, asof)` of data known at `asof`."""
    return asof - lookback, asof


def in_window(ts: pd.Timestamp | None, start: pd.Timestamp, end: pd.Timestamp) -> bool:
    """Whether a dated item falls in the half-open window `[start, end)`. Undated is withheld."""
    if ts is None or pd.isna(ts):
        return False
    return start <= ts < end


def closed_bars(bars: pd.DataFrame, asof: pd.Timestamp) -> pd.DataFrame:
    """Rows of `bars` (indexed by the bar's own close time) that had closed before `asof`."""
    return bars[bars.index < asof]


def as_filed(filings: pd.DataFrame, asof: pd.Timestamp, column: str = "filed_at") -> pd.DataFrame:
    """Rows of `filings` filed on or before `asof`. A row with no `column` value is withheld."""
    dated = filings[filings[column].notna()]
    return dated[dated[column] <= asof]


def published(news: pd.DataFrame, asof: pd.Timestamp, column: str = "published_at") -> pd.DataFrame:
    """Rows of `news` published strictly before `asof`. A row with no `column` value is withheld."""
    dated = news[news[column].notna()]
    return dated[dated[column] < asof]
```

- [ ] **Step 4: Append to `THIRD_PARTY_NOTICES.md`**, after the existing "## Vibe-Trading" section (a new top-level section, with the **complete, verbatim** text of `ai-trading/packages/trading-agents/LICENSE` — not an excerpt, and with no copyright line the upstream file lacks):

````markdown
## TradingAgents

Source: https://github.com/TauricResearch/TradingAgents (pinned as `ai-trading/packages/trading-agents`)

Attribution: TradingAgents (TauricResearch/TradingAgents). Apache License 2.0. The repository has no separate NOTICE file. The adapted file is marked as modified in its own header, per section 4(b) of the license.

| Desk file | Adapted from | Changes |
|---|---|---|
| `backend/src/ai_trading/core/asof.py` | `tradingagents/dataflows/date_window.py` | Pandas Timestamps instead of "YYYY-MM-DD" strings; filters over a Series/DataFrame instead of per-item string clamping; dropped the model-facing tool helpers (`as_of`, `as_of_window`, `coverage_gap`, `withhold_*`); an undated item is always withheld instead of kept when a live window reaches the present (this module has no clock) |

The complete, verbatim upstream LICENSE (`ai-trading/packages/trading-agents/LICENSE`):

```text
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```
````

- [ ] **Step 5: Run the tests and lint.**

Run (in `backend/`): `uv run pytest -q tests/test_asof.py && uv run ruff check . && uv run ruff format --check . && uv run pytest -q`
Expected: `5 passed`, ruff clean, then the full suite grows by 5 over the count before this task (Phase 1b alone: 169 passed, so 174 passed; add Phase 1c's own growth if it has already merged).

- [ ] **Step 6: Commit.**

```bash
git add ai-trading/packages/family-desk/backend/src/ai_trading/core/asof.py ai-trading/packages/family-desk/backend/tests/test_asof.py ai-trading/packages/family-desk/THIRD_PARTY_NOTICES.md
git commit -m "feat(ai-trading): Desk as-of windows for backtests and historical tool calls (adapted from TradingAgents)"
```

### Task 1d.2: Valuation

**Files:**
- Create: `backend/src/ai_trading/core/valuation.py`, `backend/tests/test_valuation.py`
- Modify: `THIRD_PARTY_NOTICES.md` (append a new "ai-hedge-fund" section, with the complete, verbatim upstream `LICENSE` and the `valuation.py` row)

**Interfaces:**
- Consumes: nothing (standard library `statistics` and `dataclasses` only).
- Produces:
  - `calculate_owner_earnings_value(net_income, depreciation, capex, working_capital_change, growth_rate=0.05, required_return=0.15, margin_of_safety=0.25, num_years=5) -> float | None`
  - `calculate_intrinsic_value(free_cash_flow, growth_rate=0.05, discount_rate=0.10, terminal_growth_rate=0.02, num_years=5) -> float | None`
  - `calculate_ev_ebitda_value(enterprise_value, market_cap, ev_ebitda_ratios: list[float | None]) -> float | None`
  - `calculate_residual_income_value(market_cap, net_income, price_to_book_ratio, book_value_growth=0.03, cost_of_equity=0.10, terminal_growth_rate=0.03, num_years=5) -> float | None`
  - `calculate_wacc(market_cap, total_debt, cash, interest_coverage, beta_proxy=1.0, risk_free_rate=0.045, market_risk_premium=0.06) -> float`
  - `calculate_dcf_scenarios(fcf_history: list[float], wacc, market_cap, revenue_growth=None) -> dict[str, float | dict[str, float]] | None`
  - `@dataclass(frozen=True) class BlendedValue: value: float; methods_used: tuple[str, ...]` — **new this revision**
  - `blended_value(dcf_value, owner_earnings_value, ev_ebitda_value, residual_income_value) -> BlendedValue | None` — **return type changed from `float | None`** (Decisions, Most consequential #8)

- [ ] **Step 1: Write the failing test** `backend/tests/test_valuation.py`:

```python
import math

import pytest

from ai_trading.core import valuation


def test_intrinsic_value_matches_the_growing_annuity_closed_form():
    # Cross-checked offline against the closed-form growing annuity
    # fcf*(1+g)/(r-g) * (1 - ((1+g)/(1+r))**n) for the PV of years 1..n (ref-venv, no reference
    # library needed: this is independent algebra on the same inputs). Largest diff: 7e-13.
    assert valuation.calculate_intrinsic_value(100.0, 0.05, 0.10, 0.02, 5) == pytest.approx(
        1446.2118899836075, abs=1e-6
    )
    assert valuation.calculate_intrinsic_value(250.0, 0.08, 0.12, 0.025, 5) == pytest.approx(3371.17430425782, abs=1e-6)


def test_intrinsic_value_is_unavailable_for_non_positive_or_missing_cash_flow():
    assert valuation.calculate_intrinsic_value(0.0) is None
    assert valuation.calculate_intrinsic_value(-5.0) is None
    assert valuation.calculate_intrinsic_value(None) is None


def test_intrinsic_value_is_unavailable_when_the_discount_rate_does_not_clear_terminal_growth():
    assert valuation.calculate_intrinsic_value(100.0, discount_rate=0.02, terminal_growth_rate=0.02) is None
    assert valuation.calculate_intrinsic_value(100.0, discount_rate=0.01, terminal_growth_rate=0.02) is None


def test_owner_earnings_value_hand_checked():
    # owner earnings = 100 + 20 - 30 - 10 = 80; discounted at 15%, grown 5%, margin of safety 25%.
    value = valuation.calculate_owner_earnings_value(
        net_income=100.0, depreciation=20.0, capex=30.0, working_capital_change=10.0
    )
    assert value == pytest.approx(557.028187435008, abs=1e-6)  # ref-venv closed-form cross-check


def test_owner_earnings_value_is_unavailable_for_non_positive_earnings_or_missing_input():
    assert valuation.calculate_owner_earnings_value(10.0, 0.0, 20.0, 0.0) is None  # owner earnings -10
    assert valuation.calculate_owner_earnings_value(10.0, None, 20.0, 0.0) is None


def test_ev_ebitda_value_uses_the_median_multiple_and_floors_at_zero():
    # ebitda_now = 12000/12 = 1000; median([12,11,13,10,14]) = 12; implied = 12000; net_debt = 3000.
    value = valuation.calculate_ev_ebitda_value(12000.0, 9000.0, [12.0, 11.0, 13.0, 10.0, 14.0])
    assert value == pytest.approx(9000.0)
    # ebitda_now = 10000/20 = 500; median([20,2,2,2,2]) = 2; implied = 1000; net_debt = 9500.
    floored = valuation.calculate_ev_ebitda_value(10000.0, 500.0, [20.0, 2.0, 2.0, 2.0, 2.0])
    assert floored == 0.0  # implied equity value (1000) is below net debt (9500)


def test_ev_ebitda_value_is_unavailable_without_a_current_ratio_or_enterprise_value():
    assert valuation.calculate_ev_ebitda_value(None, 9000.0, [12.0]) is None
    assert valuation.calculate_ev_ebitda_value(12000.0, 9000.0, [0.0, 11.0]) is None
    assert valuation.calculate_ev_ebitda_value(12000.0, 9000.0, []) is None


def test_residual_income_value_hand_checked():
    # book = 5000/2.5 = 2000; ri0 = 400 - 0.10*2000 = 200.
    value = valuation.calculate_residual_income_value(market_cap=5000.0, net_income=400.0, price_to_book_ratio=2.5)
    assert value == pytest.approx(3954.2857142857138, abs=1e-6)  # ref-venv closed-form cross-check


def test_residual_income_value_is_unavailable_for_non_positive_residual_income_or_missing_input():
    assert valuation.calculate_residual_income_value(5000.0, 10.0, 2.5) is None  # ri0 = 10 - 200 < 0
    assert valuation.calculate_residual_income_value(None, 400.0, 2.5) is None
    assert valuation.calculate_residual_income_value(5000.0, 400.0, 0.0) is None


def test_wacc_hand_checked_and_clamped():
    # coe = .045+.06=.105; cod=max(.055, .045+10/20=.545)=.545; net_debt=1500; total=6500.
    # we=5000/6500=.7692; wd=1500/6500=.2308; wacc=.7692*.105+.2308*.545*.75=.17509615...
    assert valuation.calculate_wacc(5000.0, 2000.0, 500.0, 20.0) == pytest.approx(0.17509615384615385, abs=1e-9)
    assert valuation.calculate_wacc(5000.0, None, None, None) == pytest.approx(0.105, abs=1e-9)
    assert valuation.calculate_wacc(0.0, 0.0, 0.0, None) == pytest.approx(0.105, abs=1e-9)
    assert valuation.calculate_wacc(5000.0, 0.0, 0.0, None, beta_proxy=10.0) == 0.20  # capped
    assert valuation.calculate_wacc(5000.0, 0.0, 0.0, None, beta_proxy=-5.0) == 0.06  # floored


def test_dcf_scenarios_hand_checked():
    # ref-venv reimplementation of the same formula from independent code gave identical floats
    # (0 diff): bear 966.0718963882485, base 1521.141545812627, bull 2095.560234922769.
    fcf_history = [100.0, 95.0, 90.0, 80.0, 70.0, 60.0, 50.0, 40.0]
    result = valuation.calculate_dcf_scenarios(fcf_history, wacc=0.10, market_cap=5_000_000_000.0, revenue_growth=0.08)
    assert result["scenarios"]["bear"] == pytest.approx(966.0718963882485, abs=1e-6)
    assert result["scenarios"]["base"] == pytest.approx(1521.141545812627, abs=1e-6)
    assert result["scenarios"]["bull"] == pytest.approx(2095.560234922769, abs=1e-6)
    assert result["expected_value"] == pytest.approx(1525.0113537497796, abs=1e-6)
    assert result["upside"] == result["scenarios"]["bull"]
    assert result["downside"] == result["scenarios"]["bear"]
    assert result["range"] == pytest.approx(result["scenarios"]["bull"] - result["scenarios"]["bear"])


def test_dcf_scenarios_is_unavailable_for_non_positive_or_missing_cash_flow():
    assert valuation.calculate_dcf_scenarios([], wacc=0.10, market_cap=1.0) is None
    assert valuation.calculate_dcf_scenarios([0.0, 10.0], wacc=0.10, market_cap=1.0) is None
    assert valuation.calculate_dcf_scenarios([-5.0], wacc=0.10, market_cap=1.0) is None


def test_blended_value_with_all_three_other_methods_is_the_literal_02h_blend():
    blend = valuation.blended_value(
        dcf_value=1000.0, owner_earnings_value=800.0, ev_ebitda_value=900.0, residual_income_value=1300.0
    )
    assert blend.value == pytest.approx(0.6 * 1000.0 + 0.4 * ((800.0 + 900.0 + 1300.0) / 3))
    assert blend.methods_used == ("owner_earnings", "ev_ebitda", "residual_income")


def test_blended_value_with_two_other_methods_averages_over_those_two():
    blend = valuation.blended_value(
        dcf_value=1000.0, owner_earnings_value=800.0, ev_ebitda_value=900.0, residual_income_value=None
    )
    assert blend.value == pytest.approx(0.6 * 1000.0 + 0.4 * ((800.0 + 900.0) / 2))
    assert blend.methods_used == ("owner_earnings", "ev_ebitda")


def test_blended_value_with_one_other_method_uses_it_alone():
    blend = valuation.blended_value(
        dcf_value=1000.0, owner_earnings_value=None, ev_ebitda_value=900.0, residual_income_value=None
    )
    assert blend.value == pytest.approx(0.6 * 1000.0 + 0.4 * 900.0)
    assert blend.methods_used == ("ev_ebitda",)


def test_blended_value_with_zero_other_methods_is_unavailable():
    blend = valuation.blended_value(
        dcf_value=1000.0, owner_earnings_value=None, ev_ebitda_value=None, residual_income_value=None
    )
    assert blend is None


def test_blended_value_is_unavailable_without_dcf():
    assert valuation.blended_value(None, 800.0, 900.0, 1300.0) is None


def test_fcf_volatility_defaults_are_internal_but_feed_the_dcf_quality_factor():
    # A single flat-FCF history (no volatility) should value higher than an identical-average but
    # erratic one, because the quality factor only ever discounts, never boosts (max(0.7, ...)).
    erratic_history = [100.0, 10.0, 190.0, 10.0, 190.0, 10.0, 190.0, 10.0]
    flat = valuation.calculate_dcf_scenarios([100.0] * 8, wacc=0.10, market_cap=1.0)
    erratic = valuation.calculate_dcf_scenarios(erratic_history, wacc=0.10, market_cap=1.0)
    assert not math.isnan(flat["expected_value"])
    assert flat["expected_value"] >= erratic["expected_value"]
```

- [ ] **Step 2: Run it and watch it fail.**

Run (in `backend/`): `uv run pytest -q tests/test_valuation.py`
Expected: collection error, `ImportError: cannot import name 'valuation' from 'ai_trading.core'`.

- [ ] **Step 3: Implement** `backend/src/ai_trading/core/valuation.py`:

```python
"""Intrinsic-value methods, deterministic and LLM-free (02h section 4): owner earnings, a classic
single-rate DCF, a bear/base/bull DCF-scenario blend, EV/EBITDA at a historical multiple, residual
income, WACC, and a 60/40 blended value.

Copied from ai-hedge-fund `src/agents/valuation.py` at commit `6c41ae8` (v1 history; MIT License,
Copyright (c) 2024 Virat Singh; see THIRD_PARTY_NOTICES.md). Changes: the framework
ties are gone (no `AgentState`, no network calls, no `FinancialMetrics` objects — plain numbers
in, a number or `None` out); a non-positive cash flow or a missing input gives `None` instead of
upstream's `0`, so a true "unavailable" is never averaged in as a real value of zero; a division
whose denominator (a discount or WACC at or below its matching growth rate) would be non-positive
also gives `None` instead of raising, since the Desk's "Adjust assumptions" recompute lets an
owner pick rates upstream never validated; `calculate_wacc`'s unused `debt_to_equity` parameter
and `calculate_dcf_scenarios`'s unused `growth_metrics` parameter are dropped (dead in the
original: neither function body reads them). `blended_value` is new (02h section 4).
"""

import statistics
from dataclasses import dataclass


def calculate_owner_earnings_value(
    net_income: float | None,
    depreciation: float | None,
    capex: float | None,
    working_capital_change: float | None,
    growth_rate: float = 0.05,
    required_return: float = 0.15,
    margin_of_safety: float = 0.25,
    num_years: int = 5,
) -> float | None:
    """Buffett-style owner-earnings value, discounted at `required_return` with a margin of safety.

    `None` when an input is missing, owner earnings (`net_income + depreciation - capex -
    working_capital_change`) is not positive, or `required_return` does not exceed the terminal
    growth rate (`min(growth_rate, 0.03)`).
    """
    if None in (net_income, depreciation, capex, working_capital_change):
        return None
    owner_earnings = net_income + depreciation - capex - working_capital_change
    if owner_earnings <= 0:
        return None
    terminal_growth = min(growth_rate, 0.03)
    if required_return <= terminal_growth:
        return None

    pv = 0.0
    for year in range(1, num_years + 1):
        pv += owner_earnings * (1 + growth_rate) ** year / (1 + required_return) ** year
    terminal_value = (
        owner_earnings * (1 + growth_rate) ** num_years * (1 + terminal_growth) / (required_return - terminal_growth)
    )
    pv_terminal = terminal_value / (1 + required_return) ** num_years
    return (pv + pv_terminal) * (1 - margin_of_safety)


def calculate_intrinsic_value(
    free_cash_flow: float | None,
    growth_rate: float = 0.05,
    discount_rate: float = 0.10,
    terminal_growth_rate: float = 0.02,
    num_years: int = 5,
) -> float | None:
    """Classic single-rate DCF on free cash flow, with a constant growth rate and terminal value.

    `None` when `free_cash_flow` is missing or not positive, or `discount_rate` does not exceed
    `terminal_growth_rate`.
    """
    if free_cash_flow is None or free_cash_flow <= 0:
        return None
    if discount_rate <= terminal_growth_rate:
        return None

    pv = 0.0
    for year in range(1, num_years + 1):
        pv += free_cash_flow * (1 + growth_rate) ** year / (1 + discount_rate) ** year
    terminal_value = (free_cash_flow * (1 + growth_rate) ** num_years * (1 + terminal_growth_rate)) / (
        discount_rate - terminal_growth_rate
    )
    pv_terminal = terminal_value / (1 + discount_rate) ** num_years
    return pv + pv_terminal


def calculate_ev_ebitda_value(
    enterprise_value: float | None,
    market_cap: float | None,
    ev_ebitda_ratios: list[float | None],
) -> float | None:
    """Implied equity value from the stock's own median EV/EBITDA multiple, applied to today's
    EBITDA (02h: "at the stock's own 5-year median multiple").

    `ev_ebitda_ratios[0]` is the current period's ratio (used with `enterprise_value` to back out
    today's EBITDA); the median is over however many of the given periods (most recent first,
    typically up to 8 quarters) have a ratio. `None` when `enterprise_value` or the current ratio
    is missing or zero. The implied equity value floors at 0 rather than going negative.
    """
    if not enterprise_value or not ev_ebitda_ratios:
        return None
    current_ratio = ev_ebitda_ratios[0]
    if not current_ratio:
        return None
    ebitda_now = enterprise_value / current_ratio
    valid_ratios = [ratio for ratio in ev_ebitda_ratios if ratio]
    median_multiple = statistics.median(valid_ratios)
    implied_ev = median_multiple * ebitda_now
    net_debt = enterprise_value - (market_cap or 0)
    return max(implied_ev - net_debt, 0.0)


def calculate_residual_income_value(
    market_cap: float | None,
    net_income: float | None,
    price_to_book_ratio: float | None,
    book_value_growth: float = 0.03,
    cost_of_equity: float = 0.10,
    terminal_growth_rate: float = 0.03,
    num_years: int = 5,
) -> float | None:
    """Residual income (Edwards-Bell-Ohlson) value: book value plus the present value of income
    above the cost of equity, with a 20% margin of safety.

    `None` when an input is missing or `price_to_book_ratio` is not positive, when first-year
    residual income (`net_income - cost_of_equity * book_value`) is not positive, or when
    `cost_of_equity` does not exceed `terminal_growth_rate`.
    """
    if not (market_cap and net_income and price_to_book_ratio and price_to_book_ratio > 0):
        return None
    if cost_of_equity <= terminal_growth_rate:
        return None
    book_value = market_cap / price_to_book_ratio
    residual_income = net_income - cost_of_equity * book_value
    if residual_income <= 0:
        return None

    pv = 0.0
    for year in range(1, num_years + 1):
        pv += residual_income * (1 + book_value_growth) ** year / (1 + cost_of_equity) ** year
    terminal_value = (
        residual_income * (1 + book_value_growth) ** (num_years + 1) / (cost_of_equity - terminal_growth_rate)
    )
    pv_terminal = terminal_value / (1 + cost_of_equity) ** num_years
    return (book_value + pv + pv_terminal) * 0.8


def calculate_wacc(
    market_cap: float,
    total_debt: float | None,
    cash: float | None,
    interest_coverage: float | None,
    beta_proxy: float = 1.0,
    risk_free_rate: float = 0.045,
    market_risk_premium: float = 0.06,
) -> float:
    """Weighted average cost of capital from a CAPM cost of equity and an interest-coverage proxy
    for the cost of debt, clamped to [6%, 20%]. Always returns a number: a missing `total_debt`,
    `cash`, or `interest_coverage` falls back to no debt or a default spread, same as upstream.
    """
    cost_of_equity = risk_free_rate + beta_proxy * market_risk_premium
    if interest_coverage and interest_coverage > 0:
        cost_of_debt = max(risk_free_rate + 0.01, risk_free_rate + 10 / interest_coverage)
    else:
        cost_of_debt = risk_free_rate + 0.05

    net_debt = max((total_debt or 0) - (cash or 0), 0)
    total_value = market_cap + net_debt
    if total_value > 0:
        weight_equity = market_cap / total_value
        weight_debt = net_debt / total_value
        wacc = weight_equity * cost_of_equity + weight_debt * cost_of_debt * 0.75  # 25% tax shield
    else:
        wacc = cost_of_equity
    return min(max(wacc, 0.06), 0.20)


def _fcf_volatility(fcf_history: list[float]) -> float:
    """Coefficient of variation of the positive entries in `fcf_history`, as a 0-1 quality
    discount for `_enhanced_dcf_value`. A default when there is too little history to measure."""
    if len(fcf_history) < 3:
        return 0.5
    positive = [fcf for fcf in fcf_history if fcf > 0]
    if len(positive) < 2:
        return 0.8
    mean_fcf = statistics.mean(positive)
    if mean_fcf <= 0:
        return 0.8
    return min(statistics.stdev(positive) / mean_fcf, 1.0)


def _enhanced_dcf_value(
    fcf_history: list[float], wacc: float, market_cap: float, revenue_growth: float | None = None
) -> float | None:
    """Three-stage DCF (high growth years 1-3, declining transition years 4-7, terminal value),
    discounted to the present and discounted further by an FCF-volatility quality factor.
    `None` when `fcf_history` is empty or its most recent entry is not positive.
    """
    if not fcf_history or fcf_history[0] <= 0:
        return None
    fcf_current = fcf_history[0]
    fcf_avg_3yr = sum(fcf_history[:3]) / min(3, len(fcf_history))
    volatility = _fcf_volatility(fcf_history)

    high_growth = min(revenue_growth or 0.05, 0.25) if revenue_growth else 0.05
    if market_cap > 50_000_000_000:
        high_growth = min(high_growth, 0.10)
    transition_growth = (high_growth + 0.03) / 2
    terminal_growth = min(0.03, high_growth * 0.6)

    base_fcf = max(fcf_current, fcf_avg_3yr * 0.85)  # a conservative floor under a sharp dip
    pv = 0.0
    for year in range(1, 4):
        pv += base_fcf * (1 + high_growth) ** year / (1 + wacc) ** year
    for year in range(4, 8):
        transition_rate = transition_growth * (8 - year) / 4  # declining to 0 by year 8
        projected = base_fcf * (1 + high_growth) ** 3 * (1 + transition_rate) ** (year - 3)
        pv += projected / (1 + wacc) ** year

    final_fcf = base_fcf * (1 + high_growth) ** 3 * (1 + transition_growth) ** 4
    if wacc <= terminal_growth:
        terminal_growth = wacc * 0.8  # keep the terminal value finite and positive
    terminal_value = final_fcf * (1 + terminal_growth) / (wacc - terminal_growth)
    pv_terminal = terminal_value / (1 + wacc) ** 7

    quality_factor = max(0.7, 1 - volatility * 0.5)
    return (pv + pv_terminal) * quality_factor


def calculate_dcf_scenarios(
    fcf_history: list[float], wacc: float, market_cap: float, revenue_growth: float | None = None
) -> dict[str, float | dict[str, float]] | None:
    """Bear/base/bull DCF, weighted 20/60/20 into `expected_value` (02h section 4). Each scenario
    scales growth and WACC (bear: half the growth, 1.2x WACC; bull: 1.5x growth, 0.9x WACC).

    Returns `{"scenarios": {"bear", "base", "bull"}, "expected_value", "range", "upside",
    "downside"}`. `None` when `fcf_history` is empty or its most recent entry is not positive (the
    same condition that makes every scenario unavailable).
    """
    if not fcf_history or fcf_history[0] <= 0:
        return None
    adjustments = {
        "bear": (0.5, 1.2),
        "base": (1.0, 1.0),
        "bull": (1.5, 0.9),
    }
    base_revenue_growth = revenue_growth or 0.05
    scenarios = {
        name: _enhanced_dcf_value(fcf_history, wacc * wacc_adj, market_cap, base_revenue_growth * growth_adj)
        for name, (growth_adj, wacc_adj) in adjustments.items()
    }
    expected_value = scenarios["bear"] * 0.2 + scenarios["base"] * 0.6 + scenarios["bull"] * 0.2
    return {
        "scenarios": scenarios,
        "expected_value": expected_value,
        "range": scenarios["bull"] - scenarios["bear"],
        "upside": scenarios["bull"],
        "downside": scenarios["bear"],
    }


@dataclass(frozen=True)
class BlendedValue:
    value: float
    methods_used: tuple[str, ...]  # which of "owner_earnings", "ev_ebitda", "residual_income" fed the 40%


def blended_value(
    dcf_value: float | None,
    owner_earnings_value: float | None,
    ev_ebitda_value: float | None,
    residual_income_value: float | None,
) -> BlendedValue | None:
    """60% `dcf_value` (the scenario DCF's `expected_value`) plus 40% the mean of
    `owner_earnings_value`, `ev_ebitda_value`, and `residual_income_value` (02h section 4).

    02h section 4's literal 60/40 blend assumes all three of the other methods are available.
    When one or two are missing, this still computes a blend over whichever are available (one
    missing method should not sink the whole card), but it is a weaker number than the spec's
    blend — `methods_used` names exactly which methods fed the 40% mean, so a caller can label a
    blend that used fewer than three. `None` when `dcf_value` is unavailable, or none of the other
    three are (nothing left to blend).
    """
    candidates = (
        ("owner_earnings", owner_earnings_value),
        ("ev_ebitda", ev_ebitda_value),
        ("residual_income", residual_income_value),
    )
    used = [(name, value) for name, value in candidates if value is not None]
    if dcf_value is None or not used:
        return None
    mean_others = sum(value for _, value in used) / len(used)
    return BlendedValue(0.6 * dcf_value + 0.4 * mean_others, tuple(name for name, _ in used))
```

- [ ] **Step 4: Append to `THIRD_PARTY_NOTICES.md`**, after the "## TradingAgents" section added in Task 1d.1 (a new top-level section, with the **complete, verbatim** text of `ai-trading/packages/ai-hedge-fund/LICENSE` — Copyright (c) 2024 Virat Singh, the real upstream holder, not a fabricated one; the `earnings_reaction.py` row is added to this same table in Task 1d.3):

````markdown
## ai-hedge-fund

Source: https://github.com/virattt/ai-hedge-fund (v1 history; pinned tip as `ai-trading/packages/ai-hedge-fund`)

| Desk file | Adapted from | Changes |
|---|---|---|
| `backend/src/ai_trading/core/valuation.py` | `src/agents/valuation.py` at commit `6c41ae8` | No framework ties (plain numbers in, a number or `None` out); a non-positive cash flow, a missing input, or a rate that does not clear its matching growth rate gives `None` instead of `0`; dropped two parameters unused by the original function bodies (`calculate_wacc`'s `debt_to_equity`, `calculate_dcf_scenarios`'s `growth_metrics`); added `blended_value` (02h section 4) |

```text
MIT License

Copyright (c) 2024 Virat Singh

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

````

- [ ] **Step 5: Run the tests and lint.**

Run (in `backend/`): `uv run pytest -q tests/test_valuation.py && uv run ruff check . && uv run ruff format --check . && uv run pytest -q`
Expected: `18 passed`, ruff clean, then the full suite grows by 18 over Task 1d.1's count (23 total growth over the pre-1d baseline).

- [ ] **Step 6: Commit.**

```bash
git add ai-trading/packages/family-desk/backend/src/ai_trading/core/valuation.py ai-trading/packages/family-desk/backend/tests/test_valuation.py ai-trading/packages/family-desk/THIRD_PARTY_NOTICES.md
git commit -m "feat(ai-trading): Desk intrinsic-value methods (adapted from ai-hedge-fund v1)"
```

### Task 1d.3: Earnings reaction

**Files:**
- Create: `backend/src/ai_trading/core/earnings_reaction.py`, `backend/tests/test_earnings_reaction.py`
- Modify: `THIRD_PARTY_NOTICES.md` (append one row to the "ai-hedge-fund" table added in Task 1d.2)

**Interfaces:**
- Consumes: nothing new (numpy, already a dependency via pandas).
- Produces:
  - `@dataclass(frozen=True) class MarketModel: alpha: float; beta: float`
  - `@dataclass(frozen=True) class EventReaction: announced: pd.Timestamp; model: MarketModel; next_day_return: float | None; excess_0_1: float | None; beat: bool | None = None`
  - `event_reaction(stock_returns: pd.Series, spy_returns: pd.Series, announced: pd.Timestamp, *, beat: bool | None = None) -> EventReaction | None`
  - `@dataclass(frozen=True) class ReactionStats: n: int; avg_absolute_next_day_move: float; avg_excess_0_1: float`
  - `@dataclass(frozen=True) class ReactionSummary: overall: ReactionStats; beats: ReactionStats | None; misses: ReactionStats | None`
  - `summarize(reactions: list[EventReaction | None]) -> ReactionSummary | None`

Public interface and test count are unchanged by this revision; only the module's own attribution-header copyright line changes (`Copyright (c) 2024 Virat Singh`, the real ai-hedge-fund holder, replacing the fabricated one — see Decisions for Owner Review, Most consequential #1).

- [ ] **Step 1: Write the failing test** `backend/tests/test_earnings_reaction.py`:

```python
import numpy as np
import pandas as pd
import pytest

from ai_trading.core import earnings_reaction as er


def _series(n: int, alpha: float, beta: float, seed: int = 7) -> tuple[pd.Series, pd.Series]:
    """`n` trading days of SPY returns and a stock that tracks them exactly via `alpha`/`beta`
    (zero residual), so OLS over any sub-window recovers `alpha` and `beta` exactly."""
    rng = np.random.default_rng(seed)
    spy = rng.normal(0.0004, 0.008, n)
    stock = alpha + beta * spy
    days = pd.bdate_range("2024-01-02", periods=n)
    return pd.Series(stock, index=days), pd.Series(spy, index=days)


def test_event_reaction_recovers_alpha_beta_and_the_injected_abnormal_returns():
    # Cross-checked offline (ref-venv): np.linalg.lstsq matches scipy.stats.linregress to float
    # precision (largest diff 4e-16) on noisy data, and on this exact-linear fixture it recovers
    # alpha/beta exactly since the estimation window holds no injected shock.
    stock, spy = _series(262, alpha=0.0002, beta=1.4)
    event_idx = 255
    ar0, ar1 = 0.03, -0.015
    stock = stock.copy()
    stock.iloc[event_idx] += ar0
    stock.iloc[event_idx + 1] += ar1
    announced = stock.index[event_idx]

    reaction = er.event_reaction(stock, spy, announced)
    assert reaction is not None
    assert reaction.model.alpha == pytest.approx(0.0002, abs=1e-9)
    assert reaction.model.beta == pytest.approx(1.4, abs=1e-9)
    assert reaction.excess_0_1 == pytest.approx(ar0 + ar1, abs=1e-9)
    assert reaction.next_day_return == pytest.approx(stock.iloc[event_idx + 1])


def test_event_reaction_is_none_without_enough_estimation_history():
    stock, spy = _series(262, alpha=0.0, beta=1.0)
    announced = stock.index[100]  # trading days -250..-11 before it would go negative
    assert er.event_reaction(stock, spy, announced) is None


def test_event_reaction_is_none_for_a_date_outside_the_series():
    stock, spy = _series(262, alpha=0.0, beta=1.0)
    assert er.event_reaction(stock, spy, pd.Timestamp("2099-01-01")) is None


def test_event_reaction_next_day_return_and_excess_are_none_past_the_edge_of_history():
    stock, spy = _series(262, alpha=0.0, beta=1.0)
    announced = stock.index[-1]  # the most recent day: no day 1 exists yet
    reaction = er.event_reaction(stock, spy, announced)
    assert reaction is not None
    assert reaction.next_day_return is None
    assert reaction.excess_0_1 is None


def test_summarize_needs_at_least_four_reports():
    stock, spy = _series(300, alpha=0.0, beta=1.0)
    reactions = [er.event_reaction(stock, spy, stock.index[idx]) for idx in (255, 256, 257)]
    assert er.summarize(reactions) is None


def test_summarize_drops_unavailable_reports_before_counting():
    stock, spy = _series(300, alpha=0.0, beta=1.0)
    reactions = [er.event_reaction(stock, spy, stock.index[idx]) for idx in (255, 256, 257, 258)]
    assert er.summarize(reactions + [None]) is not None  # the unavailable report doesn't count
    assert er.summarize(reactions[:3] + [None]) is None  # only 3 usable reports remain


def test_summarize_splits_beats_and_misses_and_averages_absolute_moves():
    stock, spy = _series(300, alpha=0.0, beta=1.0)
    idxs = [255, 260, 265, 270, 275]
    beats = [True, True, False, False, None]
    reactions = [er.event_reaction(stock, spy, stock.index[idx], beat=b) for idx, b in zip(idxs, beats, strict=True)]

    summary = er.summarize(reactions)
    assert summary.overall.n == 5
    assert summary.beats.n == 2
    assert summary.misses.n == 2
    assert summary.overall.avg_absolute_next_day_move == pytest.approx(
        sum(abs(r.next_day_return) for r in reactions) / 5
    )
    assert summary.beats.avg_excess_0_1 == pytest.approx(sum(r.excess_0_1 for r in reactions[:2]) / 2)
    assert summary.misses.avg_excess_0_1 == pytest.approx(sum(r.excess_0_1 for r in reactions[2:4]) / 2)


def test_summarize_is_none_without_beats_or_misses_in_the_window():
    stock, spy = _series(300, alpha=0.0, beta=1.0)
    reactions = [er.event_reaction(stock, spy, stock.index[idx]) for idx in (255, 256, 257, 258)]
    summary = er.summarize(reactions)
    assert summary.beats is None
    assert summary.misses is None
```

- [ ] **Step 2: Run it and watch it fail.**

Run (in `backend/`): `uv run pytest -q tests/test_earnings_reaction.py`
Expected: collection error, `ImportError: cannot import name 'earnings_reaction' from 'ai_trading.core'`.

- [ ] **Step 3: Implement** `backend/src/ai_trading/core/earnings_reaction.py`:

```python
"""A market-model excess return around one earnings announcement, and a summary over the most
recent reports (02h section 4). The options-implied move for the next report needs IBKR (I/O) and
is not part of this module.

Adapted from ai-hedge-fund `hedge_fund/event_study/engine.py` and `stats.py` at commit `78b779c`
(MIT License, Copyright (c) 2024 Virat Singh; see THIRD_PARTY_NOTICES.md). Changes:
one stock at a time, no cross-sectional aggregation by filing type; the t-test and the bootstrap
confidence interval are dropped (with the scipy dependency they need), per the brief; `r_squared`
is dropped from the market-model fit (unused by anything the Desk shows); `announced` is given by
the caller (the 8-K date; 02h's PEAD lesson) and must already be a trading day both return series
have a value for — this module has no calendar of its own (`ai_trading.core.calendar` already
owns trading-day snapping) and does not re-implement upstream's weekend/holiday search.
"""

import math
from dataclasses import dataclass

import numpy as np
import pandas as pd

ESTIMATION_START = -250  # trading days before the event where the estimation window starts
ESTIMATION_END = -11  # ... and ends (a 10-day buffer avoids pre-announcement drift)
MIN_ESTIMATION_DAYS = 200  # fewer days of estimation history than this: the event is unusable
MIN_REPORTS = 4  # fewer usable reports than this: the whole summary is unavailable


@dataclass(frozen=True)
class MarketModel:
    """R_stock = alpha + beta * R_market, fit by OLS over the estimation window."""

    alpha: float
    beta: float


@dataclass(frozen=True)
class EventReaction:
    """One announcement's reaction.

    `next_day_return` is the stock's own actual return on the trading day after `announced` (not
    market-adjusted); `excess_0_1` is the market-model abnormal return (actual minus the model's
    prediction) summed over `announced` and the day after. Either is `None` when that day falls
    beyond the given return series (the announcement is the most recent trading day).
    """

    announced: pd.Timestamp
    model: MarketModel
    next_day_return: float | None
    excess_0_1: float | None
    beat: bool | None = None  # EPS beat (True), miss (False), met or unknown (None)


def _fit_market_model(stock: np.ndarray, market: np.ndarray) -> MarketModel:
    """OLS of `stock` on `market` via the normal equations: alpha (intercept) and beta (slope)."""
    design = np.column_stack([np.ones(len(market)), market])
    (alpha, beta), *_ = np.linalg.lstsq(design, stock, rcond=None)
    return MarketModel(float(alpha), float(beta))


def event_reaction(
    stock_returns: pd.Series,
    spy_returns: pd.Series,
    announced: pd.Timestamp,
    *,
    beat: bool | None = None,
) -> EventReaction | None:
    """The market-model reaction to one announcement, or `None` when it cannot be computed.

    `stock_returns` and `spy_returns` are daily returns indexed by trading day, already aligned to
    the days both have a close (ai-hedge-fund's stock-intersect-SPY step). `announced` is the
    trading day the market first could react; `None` when it is not in the index, or fewer than
    `MIN_ESTIMATION_DAYS` days of estimation history (trading days -250 to -11 before it) exist.
    """
    days = stock_returns.index
    if announced not in days:
        return None
    event_idx = days.get_loc(announced)
    est_start, est_end = event_idx + ESTIMATION_START, event_idx + ESTIMATION_END
    if est_start < 0 or est_end < 0:
        return None
    stock_est = stock_returns.iloc[est_start : est_end + 1].to_numpy()
    spy_est = spy_returns.iloc[est_start : est_end + 1].to_numpy()
    if len(stock_est) < MIN_ESTIMATION_DAYS:
        return None
    model = _fit_market_model(stock_est, spy_est)

    def abnormal(offset: int) -> float | None:
        idx = event_idx + offset
        if idx >= len(days):
            return None
        return float(stock_returns.iloc[idx] - (model.alpha + model.beta * spy_returns.iloc[idx]))

    ar0, ar1 = abnormal(0), abnormal(1)
    excess_0_1 = ar0 + ar1 if ar0 is not None and ar1 is not None else None
    next_idx = event_idx + 1
    next_day_return = float(stock_returns.iloc[next_idx]) if next_idx < len(days) else None
    return EventReaction(announced, model, next_day_return, excess_0_1, beat)


@dataclass(frozen=True)
class ReactionStats:
    n: int
    avg_absolute_next_day_move: float  # NaN when no report in the group has a known next-day move
    avg_excess_0_1: float  # NaN when no report in the group has a known days-0-1 excess


def _stats(group: list[EventReaction]) -> ReactionStats | None:
    """`None` for an empty group (e.g. no misses in the window)."""
    if not group:
        return None
    moves = [abs(r.next_day_return) for r in group if r.next_day_return is not None]
    excess = [r.excess_0_1 for r in group if r.excess_0_1 is not None]
    return ReactionStats(
        n=len(group),
        avg_absolute_next_day_move=float(np.mean(moves)) if moves else math.nan,
        avg_excess_0_1=float(np.mean(excess)) if excess else math.nan,
    )


@dataclass(frozen=True)
class ReactionSummary:
    overall: ReactionStats
    beats: ReactionStats | None
    misses: ReactionStats | None


def summarize(reactions: list[EventReaction | None]) -> ReactionSummary | None:
    """Summary over the given reports (the Desk passes its most recent 8; 02h section 4): the
    average absolute next-day move, the average excess move over days 0-1, and the same two split
    into beats and misses.

    A report whose reaction is `None` (`event_reaction` could not compute one) is dropped first.
    Fewer than `MIN_REPORTS` remaining reports makes the whole summary `None` (unavailable).
    """
    known = [r for r in reactions if r is not None]
    if len(known) < MIN_REPORTS:
        return None
    return ReactionSummary(
        overall=_stats(known),
        beats=_stats([r for r in known if r.beat is True]),
        misses=_stats([r for r in known if r.beat is False]),
    )
```

- [ ] **Step 4: Add one row to the "ai-hedge-fund" table** in `THIRD_PARTY_NOTICES.md` (added in Task 1d.2), right after the `valuation.py` row — the table's header and license text do not change:

```markdown
| `backend/src/ai_trading/core/earnings_reaction.py` | `hedge_fund/event_study/engine.py`, `stats.py` at commit `78b779c` | Single stock, no cross-sectional aggregation; dropped the t-test and bootstrap CI (and the scipy dependency they need); dropped `r_squared`; announcement dates are given, not derived, and must already be a trading day (no weekend/holiday snapping here) |
```

- [ ] **Step 5: Run the tests and lint.**

Run (in `backend/`): `uv run pytest -q tests/test_earnings_reaction.py && uv run ruff check . && uv run ruff format --check . && uv run pytest -q`
Expected: `8 passed`, ruff clean, then the full suite grows by 8 over Task 1d.2's count (31 total growth over the pre-1d baseline).

- [ ] **Step 6: Commit.**

```bash
git add ai-trading/packages/family-desk/backend/src/ai_trading/core/earnings_reaction.py ai-trading/packages/family-desk/backend/tests/test_earnings_reaction.py ai-trading/packages/family-desk/THIRD_PARTY_NOTICES.md
git commit -m "feat(ai-trading): Desk earnings-reaction market model (adapted from ai-hedge-fund's event study)"
```

### Task 1d.4: Backtest engine core

**Files:**
- Create: `backend/src/ai_trading/core/backtest.py`, `backend/tests/test_backtest.py`

**Interfaces:**
- Consumes: `ai_trading.contracts.strategy_spec_v1.{Limits, StrategySpecV1}` (Phase 1); `ai_trading.core.indicators.atr` (Phase 1); `ai_trading.core.levels.{prior_day, n_day, support_resistance, pre_phase, opening_range}` (Phase 1, Phase 1b); `ai_trading.core.calendar.{ET, Asset, annotate, session}` (Phase 1); `ai_trading.core.evaluate.{INTRADAY_CADENCES, SignalCandidate, evaluate}` (Phase 1); `ai_trading.core.sizing.{Bracket, Side, plan_order}` (Phase 1b). The test file also imports the existing `tests/bars.py` helper's `daily_bars`, `minute_bars`, `set_bar`, `trading_days` and `ai_trading.core.calendar.{et, previous_session}` (all Phase 1, unchanged).
- Produces (Phase 6b's backtest runner relies on these):
  - `ExitReason = Literal["stop", "target", "time", "end_of_data"]`, `ATR_LENGTH = 14`
  - `@dataclass(frozen=True) class SymbolBars: bars_1d: pd.DataFrame; bars_1m: pd.DataFrame | None = None`
  - `@dataclass(frozen=True) class InstrumentSpec: multiplier: float = 1.0; tick_size: float = 0.01; commission_per_unit: float = 0.005` — **`commission_per_unit` moved here this revision**, from `Costs.commission_per_share`
  - `@dataclass(frozen=True) class Costs: slippage_ticks: float = 1.0` — **`commission_per_share` removed this revision; see `InstrumentSpec`**
  - `@dataclass(frozen=True) class Trade: symbol, side, entry_time, entry_price, exit_time, exit_price, quantity, r, exit_reason, pnl`
  - `@dataclass(frozen=True) class BacktestStats: total_return_pct, cagr_pct, max_drawdown_pct, sharpe, trades, win_rate_pct, avg_win_r, avg_loss_r, expectancy_r, profit_factor, avg_hold_bars, exposure_pct, longest_losing_streak, returns_by_year: dict[int, float], benchmark_return_pct: float`
  - `@dataclass(frozen=True) class BacktestResult: trades: list[Trade]; equity_curve: pd.Series; stats: BacktestStats`
  - `backtest(spec: StrategySpecV1, asset: Asset, bars: dict[str, SymbolBars], *, benchmark: pd.Series, starting_equity=100_000.0, instruments: dict[str, InstrumentSpec] | None = None, max_position_usd=None, costs=None) -> BacktestResult` — runs the per-bar loop in three stages (gap exit → fill → intrabar touch/time exit → signal queueing at the close); see the module docstring
  - `stats(trades: list[Trade], equity_curve: pd.Series, starting_equity: float, benchmark: pd.Series, *, bars_in_position=0, total_bars=0, frequency: Literal["daily", "weekly"] = "daily") -> BacktestStats`

This revision's changes are internal to `backtest()`'s per-bar loop (now three explicit stages per bar instead of one pass per symbol) and to cost accounting (`commission_per_unit` moved to `InstrumentSpec`); the dataclasses above and `stats()` otherwise keep their Task 1d.4 (revision 2) shapes.

- [ ] **Step 1: Write the failing test** `backend/tests/test_backtest.py`:

```python
import math
import statistics
from datetime import date
from typing import Any

import pandas as pd
import pytest
from bars import daily_bars, minute_bars, set_bar, trading_days

from ai_trading.contracts.strategy_spec_v1 import StrategySpecV1
from ai_trading.core.backtest import InstrumentSpec, SymbolBars, Trade, backtest, stats
from ai_trading.core.calendar import et, previous_session

LAST_DAY = date(2026, 11, 10)
DAY = date(2026, 10, 6)  # a plain trading day, for the intraday fixtures


def make_spec(limits: dict[str, Any] | None = None, size: dict[str, Any] | None = None) -> StrategySpecV1:
    """Buy when close breaks above 100: stop at the prior day's low (never referenced in `when`),
    target 2R, risk a fixed $300 unless `size` overrides it."""
    body: dict[str, Any] = {
        "schemaVersion": 1,
        "name": "Test breakout",
        "watch": {"universe": {"symbols": ["TEST"]}, "session": "regular", "runOn": "daily_close"},
        "when": {"op": "gt", "left": {"series": "close"}, "right": {"value": 100}},
        "then": {
            "alert": {"channels": ["inbox"]},
            "paperOrder": {
                "side": "buy",
                "size": size or {"riskUsd": 300},
                "stop": {"level": "prior_day_low"},
                "target": {"r": 2},
            },
        },
    }
    if limits is not None:
        body["limits"] = limits
    return StrategySpecV1.model_validate(body)


def make_bars(count: int) -> pd.DataFrame:
    """Flat bars (close 90, low 88) up to day 20, which closes at 101 (the signal). Day 21 opens
    gapped up at 103 (the fill) and holds; day 22 opens gapped down at 80, through the 88 stop.
    Every later day is flat again, so no further signal fires."""
    days = trading_days("stock", LAST_DAY, count)
    opens, highs, lows, closes = [90.0] * count, [92.0] * count, [88.0] * count, [90.0] * count
    closes[20], highs[20] = 101.0, 103.0
    opens[21], highs[21], lows[21], closes[21] = 103.0, 105.0, 101.0, 104.0
    opens[22], highs[22], lows[22], closes[22] = 80.0, 81.0, 78.0, 79.0
    data = {"open": opens, "high": highs, "low": lows, "close": closes, "volume": 1_000_000.0}
    return pd.DataFrame(data, index=pd.Index(days))


def flat_benchmark(frame: pd.DataFrame) -> pd.Series:
    return pd.Series(100.0, index=frame.index)


def _custom_bars(count: int, overrides: dict[int, tuple[float, float, float, float]]) -> pd.DataFrame:
    """Flat bars (open/high/low/close 90/92/88/90) with specific day positions overridden to
    (open, high, low, close)."""
    days = trading_days("stock", LAST_DAY, count)
    o, h, lo, c = [90.0] * count, [92.0] * count, [88.0] * count, [90.0] * count
    for day_index, (oo, hh, ll, cc) in overrides.items():
        o[day_index], h[day_index], lo[day_index], c[day_index] = oo, hh, ll, cc
    return pd.DataFrame({"open": o, "high": h, "low": lo, "close": c, "volume": 1.0}, index=pd.Index(days))


def run(count: int = 23, bars: pd.DataFrame | None = None, limits=None, instruments=None, benchmark=None):
    frame = bars if bars is not None else make_bars(count)
    bm = benchmark if benchmark is not None else flat_benchmark(frame)
    result = backtest(
        make_spec(limits),
        "stock",
        {"TEST": SymbolBars(bars_1d=frame)},
        benchmark=bm,
        instruments=instruments,
    )
    return result, frame


def test_signal_fills_at_the_next_bars_open_not_the_signal_bars_close():
    result, frame = run()
    [trade] = result.trades
    assert frame.loc[frame.index[20], "close"] == 101.0  # the signal bar's close...
    assert trade.entry_time == frame.index[21]
    assert trade.entry_price == pytest.approx(103.01)  # ...differs from the next bar's open + slippage
    assert trade.side == "buy" and trade.quantity == 20  # $300 risk / (103 - 88 stop) = 20


def test_a_gap_through_the_stop_fills_at_the_open_not_the_stop_level():
    result, frame = run()
    [trade] = result.trades
    assert trade.exit_time == frame.index[22]
    assert trade.exit_reason == "stop"
    assert trade.exit_price == pytest.approx(79.99)  # day 22 opens at 80, through the 88 stop
    assert trade.r == pytest.approx((79.99 - 103.01) / 15, abs=1e-6)
    assert trade.pnl == pytest.approx((79.99 - 103.01) * 20 - 20 * 0.005 * 2)


def test_paper_order_level_resolves_even_though_when_never_uses_it():
    # `when` only ever compares `close` to a constant; `prior_day_low` appears nowhere in it.
    when = make_spec().model_dump(by_alias=True, exclude_none=True)["when"]
    assert "level" not in when["left"] and "level" not in when["right"]
    result, _ = run()
    [trade] = result.trades
    assert trade.quantity == 20  # $300 risk / (103 entry - 88 prior-day-low stop), resolved directly


def test_mutating_bars_after_a_date_leaves_every_earlier_trade_identical():
    frame = make_bars(40)
    before, _ = run(bars=frame)
    [original] = before.trades

    mutated = frame.copy()
    mutated.loc[mutated.index[30:], ["open", "high", "low", "close"]] = [150.0, 155.0, 148.0, 152.0]
    after, _ = run(bars=mutated)

    assert after.trades[0] == original


def test_no_same_bar_reentry_when_an_old_stop_and_a_new_entry_share_a_bar():
    """The reviewer's case: a signal fires while a position is held (day 23, dropped on sight),
    and the held position itself later gaps through its stop (day 24). The dropped signal must
    not resurrect itself as a new entry just because the bar it would have filled on is also the
    bar the old position happens to exit on."""
    frame = _custom_bars(
        26,
        {
            20: (90.0, 103.0, 88.0, 101.0),  # the original signal
            21: (103.0, 105.0, 101.0, 104.0),  # the original entry fill, holds
            22: (104.0, 105.0, 95.0, 95.0),  # dips back below 100: resets the edge
            23: (96.0, 103.0, 95.0, 102.0),  # crosses back above 100 while still holding: dropped
            24: (50.0, 55.0, 45.0, 48.0),  # the original position gaps through its stop
        },
    )
    result, _ = run(bars=frame)
    assert len(result.trades) == 1  # the day-23 signal never became a second entry
    [trade] = result.trades
    assert trade.entry_time == frame.index[21]
    assert trade.exit_time == frame.index[24]
    assert trade.exit_reason == "stop"


def test_a_signal_while_holding_a_position_is_dropped():
    frame = _custom_bars(
        28,
        {
            20: (90.0, 103.0, 88.0, 101.0),
            21: (103.0, 105.0, 101.0, 104.0),  # entry fill, holds
            22: (104.0, 105.0, 95.0, 95.0),  # dips back below 100: resets the edge
            23: (96.0, 103.0, 95.0, 102.0),  # crosses back above 100 while still holding: dropped
            24: (100.0, 102.0, 95.0, 100.0),
            25: (100.0, 102.0, 95.0, 100.0),
            26: (100.0, 102.0, 95.0, 100.0),
            27: (100.0, 102.0, 95.0, 100.0),
        },
    )
    result, _ = run(bars=frame)
    assert len(result.trades) == 1  # the day-23 signal, fired while still holding, never entered
    [trade] = result.trades
    assert trade.entry_time == frame.index[21]
    assert trade.exit_reason == "end_of_data"


def test_stop_checked_before_target_when_a_bar_touches_both():
    frame = _custom_bars(
        24,
        {
            20: (90.0, 103.0, 88.0, 101.0),
            21: (103.0, 105.0, 101.0, 104.0),  # entry fill, holds
            22: (103.0, 140.0, 80.0, 110.0),  # no gap at the open; touches stop and target intrabar
        },
    )
    result, _ = run(bars=frame)
    [trade] = result.trades
    assert trade.exit_time == frame.index[22]
    assert trade.exit_reason == "stop"
    assert trade.exit_price == pytest.approx(87.99)  # the 88 stop level minus slippage, not the target


def _open_time_sizing_fixture() -> tuple[pd.DataFrame, pd.DataFrame]:
    """A breaks out on day 20 and keeps rising; on day 26 it opens still well inside its stop and
    target, but touches its stop intrabar and exits there. B's signal (day 25) queues its entry
    for day 26's open too, sized with `pctOfBook` alongside A."""
    frame_a = _custom_bars(
        30,
        {
            20: (90.0, 103.0, 88.0, 101.0),
            21: (103.0, 105.0, 101.0, 104.0),
            22: (104.0, 106.0, 103.0, 105.0),
            23: (105.0, 107.0, 104.0, 106.0),
            24: (106.0, 108.0, 105.0, 107.0),
            25: (107.0, 112.0, 106.0, 110.0),
            26: (120.0, 121.0, 88.0, 90.0),  # open 120, still well clear; touches the 88 stop intrabar
        },
    )
    frame_b = _custom_bars(
        30,
        {
            25: (90.0, 103.0, 88.0, 101.0),
            26: (103.0, 105.0, 101.0, 104.0),
        },
    )
    return frame_a, frame_b


def test_sizing_uses_open_time_equity_not_a_later_exit_in_the_same_bar():
    frame_a, frame_b = _open_time_sizing_fixture()
    spec = make_spec(size={"pctOfBook": 50})
    result = backtest(
        spec,
        "stock",
        {"A": SymbolBars(bars_1d=frame_a), "B": SymbolBars(bars_1d=frame_b)},
        benchmark=flat_benchmark(frame_a),
    )
    by_symbol = {t.symbol: t for t in result.trades}
    assert by_symbol["A"].exit_time == frame_a.index[26]
    assert by_symbol["A"].exit_reason == "stop"  # A is still open at this bar's open, exits intrabar
    # B is sized from cash plus A's unrealized gain marked at THIS bar's *open* (120), not A's
    # exit later in the same bar: 99,997.575 + (120 - 103.01) x 485 = 108,237.725; 50% of that
    # over $103 floors to 525 — not the 485 cash alone would give, nor the 450 A's post-exit
    # cash would give.
    assert by_symbol["B"].quantity == 525


def test_two_symbols_trade_independently_off_one_shared_equity():
    frame = make_bars(23)
    bm = flat_benchmark(frame)
    result = backtest(
        make_spec(), "stock", {"TEST": SymbolBars(bars_1d=frame), "OTHER": SymbolBars(bars_1d=frame)}, benchmark=bm
    )
    assert {t.symbol for t in result.trades} == {"TEST", "OTHER"}
    assert len(result.trades) == 2
    assert result.trades[0].pnl == result.trades[1].pnl  # identical bars, identical fills


def test_symbols_on_different_calendars_are_rejected():
    frame = make_bars(23)
    bm = flat_benchmark(frame)
    with pytest.raises(ValueError, match="share one index"):
        backtest(
            make_spec(),
            "stock",
            {"TEST": SymbolBars(bars_1d=frame), "OTHER": SymbolBars(bars_1d=frame.iloc[1:])},
            benchmark=bm,
        )


def test_no_paper_order_is_a_clear_error():
    spec = make_spec().model_copy(update={"then": make_spec().then.model_copy(update={"paperOrder": None})})
    frame = make_bars(23)
    with pytest.raises(ValueError, match="paperOrder"):
        backtest(spec, "stock", {"TEST": SymbolBars(bars_1d=frame)}, benchmark=flat_benchmark(frame))


def test_benchmark_return_is_buy_and_hold_over_the_same_period():
    frame = make_bars(23)
    bm = pd.Series([100.0 + i for i in range(len(frame))], index=frame.index)
    result, _ = run(bars=frame, benchmark=bm)
    expected = (bm.iloc[-1] / bm.iloc[0] - 1) * 100
    assert result.stats.benchmark_return_pct == pytest.approx(expected)


def test_two_instruments_use_their_own_multiplier_tick_size_and_commission():
    frame = make_bars(23)
    bm = flat_benchmark(frame)
    instruments = {"FUT": InstrumentSpec(multiplier=5.0, tick_size=0.25, commission_per_unit=2.50)}
    result = backtest(
        make_spec(),
        "stock",
        {"TEST": SymbolBars(bars_1d=frame), "FUT": SymbolBars(bars_1d=frame)},
        benchmark=bm,
        instruments=instruments,
    )
    by_symbol = {t.symbol: t for t in result.trades}
    assert by_symbol["TEST"].quantity == 20  # default stock spec: $300 / (15 risk x 1 multiplier)
    assert by_symbol["TEST"].entry_price == pytest.approx(103.01)  # 1-cent tick slippage
    assert by_symbol["TEST"].exit_price == pytest.approx(79.99)
    # TEST's default $0.005/share commission, both legs.
    assert by_symbol["TEST"].pnl == pytest.approx((79.99 - 103.01) * 20 - 20 * 0.005 * 2)
    assert by_symbol["FUT"].quantity == 4  # $300 / (15 risk x 5 multiplier)
    assert by_symbol["FUT"].entry_price == pytest.approx(103.25)  # quarter-point tick slippage
    assert by_symbol["FUT"].exit_price == pytest.approx(79.75)
    # FUT's $2.50/contract commission and 5x multiplier, both legs.
    assert by_symbol["FUT"].pnl == pytest.approx((79.75 - 103.25) * 4 * 5 - 4 * 2.50 * 2)


def _marking_fixture() -> tuple[pd.DataFrame, pd.DataFrame]:
    """Symbol A breaks out on day 20 and keeps rising, so it has a large open unrealized gain by
    the time symbol B breaks out on day 25 and is sized with `pctOfBook`."""
    count = 30
    days = trading_days("stock", LAST_DAY, count)

    def flat() -> tuple[list[float], list[float], list[float], list[float]]:
        return [90.0] * count, [92.0] * count, [88.0] * count, [90.0] * count

    a_o, a_h, a_l, a_c = flat()
    a_c[20], a_h[20] = 101.0, 103.0
    for i, (o, h, lo, c) in enumerate(
        [(103, 105, 101, 104), (104, 106, 103, 105), (105, 107, 104, 106), (106, 108, 105, 107), (107, 112, 106, 110)]
    ):
        a_o[21 + i], a_h[21 + i], a_l[21 + i], a_c[21 + i] = o, h, lo, c
    for i in range(26, count):
        a_o[i], a_h[i], a_l[i], a_c[i] = 110.0, 112.0, 108.0, 110.0
    frame_a = pd.DataFrame({"open": a_o, "high": a_h, "low": a_l, "close": a_c, "volume": 1.0}, index=pd.Index(days))

    b_o, b_h, b_l, b_c = flat()
    b_c[25], b_h[25] = 101.0, 103.0
    b_o[26], b_h[26], b_l[26], b_c[26] = 103.0, 105.0, 101.0, 104.0
    for i in range(27, count):
        b_o[i], b_h[i], b_l[i], b_c[i] = 104.0, 106.0, 102.0, 104.0
    frame_b = pd.DataFrame({"open": b_o, "high": b_h, "low": b_l, "close": b_c, "volume": 1.0}, index=pd.Index(days))
    return frame_a, frame_b


def test_pct_of_book_sizing_uses_marked_to_market_equity_not_cash_alone():
    frame_a, frame_b = _marking_fixture()
    spec = make_spec(size={"pctOfBook": 50})
    result = backtest(
        spec,
        "stock",
        {"A": SymbolBars(bars_1d=frame_a), "B": SymbolBars(bars_1d=frame_b)},
        benchmark=flat_benchmark(frame_a),
    )
    by_symbol = {t.symbol: t for t in result.trades}
    assert by_symbol["A"].quantity == 485  # 50% of the $100,000 starting cash, entry $103
    # B is sized off cash *plus* A's ~$3,390 unrealized gain, marked at B's own signal bar's close,
    # not cash alone (which would give 485 again).
    assert by_symbol["B"].quantity == 501


def test_max_drawdown_counts_from_starting_equity_as_the_initial_peak():
    curve = pd.Series([8_000.0], index=pd.Index([date(2026, 1, 1)]))
    result = stats([], curve, 10_000.0, pd.Series(100.0, index=curve.index))
    assert result.max_drawdown_pct == pytest.approx(20.0)  # the first mark is already a 20% loss


def test_sharpe_annualizes_by_frequency():
    dates = [date(2026, 1, 9), date(2026, 1, 16), date(2026, 1, 23), date(2026, 1, 30)]  # 4 distinct ISO weeks
    curve = pd.Series([10_000.0, 11_000.0, 9_900.0, 10_890.0], index=pd.Index(dates))
    benchmark = pd.Series(100.0, index=curve.index)
    daily_result = stats([], curve, 10_000.0, benchmark, frequency="daily")
    weekly_result = stats([], curve, 10_000.0, benchmark, frequency="weekly")

    returns = [0.10, -0.10, 0.10]
    mean, stdev = statistics.mean(returns), statistics.stdev(returns)
    assert daily_result.sharpe == pytest.approx(mean / stdev * math.sqrt(252))
    assert weekly_result.sharpe == pytest.approx(mean / stdev * math.sqrt(52))
    assert daily_result.sharpe != pytest.approx(weekly_result.sharpe)


def test_sharpe_aggregates_intraday_equity_to_daily_first():
    idx = pd.DatetimeIndex(
        [
            et(date(2026, 1, 5), "10:00"),
            et(date(2026, 1, 5), "15:00"),
            et(date(2026, 1, 6), "10:00"),
            et(date(2026, 1, 6), "15:00"),
            et(date(2026, 1, 7), "10:00"),
            et(date(2026, 1, 7), "15:00"),
        ]
    )
    curve = pd.Series([10_500.0, 10_000.0, 10_600.0, 11_000.0, 10_200.0, 9_900.0], index=idx)
    result = stats([], curve, 10_000.0, pd.Series(100.0, index=idx))

    daily_values = [10_000.0, 11_000.0, 9_900.0]  # each day's last intraday mark
    returns = [daily_values[1] / daily_values[0] - 1, daily_values[2] / daily_values[1] - 1]
    expected = statistics.mean(returns) / statistics.stdev(returns) * math.sqrt(252)
    assert result.sharpe == pytest.approx(expected)


def test_max_open_positions_blocks_a_second_simultaneous_entry():
    frame = make_bars(23)
    spec = make_spec(limits={"maxOpenPositions": 1})
    result = backtest(
        spec,
        "stock",
        {"S1": SymbolBars(bars_1d=frame), "S2": SymbolBars(bars_1d=frame)},
        benchmark=flat_benchmark(frame),
    )
    assert {t.symbol for t in result.trades} == {"S1"}  # S2's simultaneous entry is dropped, not deferred


def test_max_trades_per_day_blocks_a_second_entry_the_same_day():
    frame = make_bars(23)
    spec = make_spec(limits={"maxTradesPerDay": 1})
    result = backtest(
        spec,
        "stock",
        {"S1": SymbolBars(bars_1d=frame), "S2": SymbolBars(bars_1d=frame)},
        benchmark=flat_benchmark(frame),
    )
    assert {t.symbol for t in result.trades} == {"S1"}


def _pause_fixture() -> tuple[pd.DataFrame, pd.DataFrame]:
    """S1 enters cleanly on day 21 and gaps through its stop at day 22's open (known at that
    open, before any new entry is considered); S2's signal fires a day later than S1's so its
    entry is also queued for day 22's open, and would otherwise fill cleanly."""
    count = 23
    days = trading_days("stock", LAST_DAY, count)
    o, h, lo, c = [90.0] * count, [92.0] * count, [88.0] * count, [90.0] * count
    c[20], h[20] = 101.0, 103.0  # S1's signal
    o[21], h[21], lo[21], c[21] = 103.0, 105.0, 101.0, 104.0  # a normal, clean entry
    o[22], h[22], lo[22], c[22] = 50.0, 55.0, 45.0, 48.0  # gaps through the 88 stop at the open
    s1 = pd.DataFrame({"open": o, "high": h, "low": lo, "close": c, "volume": 1.0}, index=pd.Index(days))

    o2, h2, lo2, c2 = [90.0] * count, [92.0] * count, [88.0] * count, [90.0] * count
    c2[21], h2[21] = 101.0, 103.0  # S2's signal, one day after S1's
    o2[22], h2[22], lo2[22], c2[22] = 103.0, 105.0, 101.0, 104.0  # a normal, clean entry
    s2 = pd.DataFrame({"open": o2, "high": h2, "low": lo2, "close": c2, "volume": 1.0}, index=pd.Index(days))
    return s1, s2


def test_pause_after_daily_loss_blocks_a_later_entry_the_same_day():
    s1, s2 = _pause_fixture()
    spec = make_spec(limits={"pauseAfterDailyLossUsd": 300})
    result = backtest(
        spec, "stock", {"S1": SymbolBars(bars_1d=s1), "S2": SymbolBars(bars_1d=s2)}, benchmark=flat_benchmark(s1)
    )
    by_symbol = {t.symbol: t for t in result.trades}
    assert by_symbol["S1"].pnl == pytest.approx(-1060.6)  # the gap-stop realized at day 22's open
    assert "S2" not in by_symbol  # S1's loss, known at that same open, already breached the pause


def _intraday_spec(limits: dict[str, Any], target_r: float = 2.0) -> StrategySpecV1:
    return StrategySpecV1.model_validate(
        {
            "schemaVersion": 1,
            "name": "Intraday limits test",
            "watch": {"universe": {"symbols": ["TEST"]}, "session": "regular", "runOn": "bar_close_1m"},
            "when": {"op": "crosses_above", "left": {"series": "close"}, "right": {"value": 100}},
            "limits": limits,
            "then": {
                "alert": {"channels": ["inbox"]},
                "paperOrder": {
                    "side": "buy",
                    "size": {"riskUsd": 50},
                    "stop": {"level": "prior_day_low"},
                    "target": {"r": target_r},
                },
            },
        }
    )


def _hold(bars: pd.DataFrame, day: date, start: str, end: str, value: float) -> None:
    for at in pd.date_range(et(day, start), et(day, end), freq="1min", inclusive="left"):
        bars.loc[at, ["open", "high", "low", "close"]] = value


def test_cooldown_blocks_a_quick_reentry_in_the_same_symbol():
    bars = minute_bars("stock", DAY)
    set_bar(bars, DAY, "10:00", close=101.0)
    set_bar(bars, DAY, "10:01", open=103.0, high=103.0, low=50.0, close=60.0)  # entry, same-bar stop-out
    set_bar(bars, DAY, "10:02", close=90.0)
    set_bar(bars, DAY, "10:05", close=101.0)  # 4 minutes after the exit: inside a 10-minute cooldown
    set_bar(bars, DAY, "10:06", open=103.0, high=105.0, low=101.0, close=104.0)  # would-be entry
    set_bar(bars, DAY, "10:07", close=90.0)
    set_bar(bars, DAY, "10:15", close=101.0)  # 14 minutes after the exit: outside the cooldown
    set_bar(bars, DAY, "10:16", open=103.0, high=105.0, low=101.0, close=104.0)

    daily = daily_bars([previous_session("stock", DAY)], [90.0])
    spec = _intraday_spec({"cooldownMinutes": 10})
    result = backtest(
        spec, "stock", {"TEST": SymbolBars(bars_1d=daily, bars_1m=bars)}, benchmark=pd.Series(100.0, index=bars.index)
    )
    assert len(result.trades) == 2  # the 10:05 signal's entry is blocked; 10:00 and 10:15 fill
    assert [t.entry_time for t in result.trades] == [et(DAY, "10:01"), et(DAY, "10:16")]


def test_flat_by_forces_an_intraday_exit_at_the_close_of_the_bar_ending_at_it():
    # Bars are labeled by their start, so "flat by 11:00" fires on the 10:59 bar (it ends at
    # 11:00), not the 11:00 bar (which only ends at 11:01).
    bars = minute_bars("stock", DAY)
    set_bar(bars, DAY, "10:00", close=101.0)
    set_bar(bars, DAY, "10:01", open=103.0, high=105.0, low=101.0, close=104.0)
    _hold(bars, DAY, "10:02", "10:59", 104.0)  # stays well inside the stop/target band until flatBy
    set_bar(bars, DAY, "10:59", open=104.0, high=106.0, low=103.0, close=107.0)
    set_bar(bars, DAY, "11:00", open=107.0, high=109.0, low=105.0, close=108.0)  # never reached

    daily = daily_bars([previous_session("stock", DAY)], [90.0])
    spec = _intraday_spec({"flatBy": "11:00"}, target_r=5.0)
    result = backtest(
        spec, "stock", {"TEST": SymbolBars(bars_1d=daily, bars_1m=bars)}, benchmark=pd.Series(100.0, index=bars.index)
    )
    [trade] = result.trades
    assert trade.exit_reason == "time"
    assert trade.exit_time == et(DAY, "11:00")  # the 10:59 bar's end, not its 10:59 start
    assert trade.exit_price == pytest.approx(106.99)  # the 10:59 bar's close (minus slippage)


def test_flat_by_uses_the_first_later_bar_when_its_own_bar_is_missing():
    # The 10:59 bar (which would end exactly at 11:00) is missing; the next bar present is 11:00,
    # which ends at 11:01, so the exit happens there, with its own real end time.
    bars = minute_bars("stock", DAY)
    set_bar(bars, DAY, "10:00", close=101.0)
    set_bar(bars, DAY, "10:01", open=103.0, high=105.0, low=101.0, close=104.0)
    _hold(bars, DAY, "10:02", "10:59", 104.0)
    set_bar(bars, DAY, "11:00", open=104.0, high=106.0, low=103.0, close=108.0)
    bars = bars.drop(index=et(DAY, "10:59"))

    daily = daily_bars([previous_session("stock", DAY)], [90.0])
    spec = _intraday_spec({"flatBy": "11:00"}, target_r=5.0)
    result = backtest(
        spec, "stock", {"TEST": SymbolBars(bars_1d=daily, bars_1m=bars)}, benchmark=pd.Series(100.0, index=bars.index)
    )
    [trade] = result.trades
    assert trade.exit_reason == "time"
    assert trade.exit_time == et(DAY, "11:01")  # the 11:00 bar's own end
    assert trade.exit_price == pytest.approx(107.99)  # the 11:00 bar's close (minus slippage)


def test_flat_by_does_not_apply_to_daily_bars():
    frame = make_bars(23)  # the day-21 entry still exits via the day-22 gap-stop, not a time exit
    spec = make_spec(limits={"flatBy": "12:00"})
    result = backtest(spec, "stock", {"TEST": SymbolBars(bars_1d=frame)}, benchmark=flat_benchmark(frame))
    [trade] = result.trades
    assert trade.exit_reason == "stop"


EQUITY_DATES = [date(2025, 12, 30), date(2025, 12, 31), date(2026, 1, 2), date(2026, 1, 3)]
EQUITY_VALUES = [10_000.0, 11_000.0, 9_900.0, 10_890.0]  # +10%, -10%, +10%


def equity_curve() -> pd.Series:
    return pd.Series(EQUITY_VALUES, index=pd.Index(EQUITY_DATES))


def trade(entry: int, exit_: int, r: float, pnl: float, quantity: int = 10) -> Trade:
    d = EQUITY_DATES
    return Trade("TEST", "buy", d[entry], 100.0, d[exit_], 100.0, quantity, r, "target" if r > 0 else "stop", pnl)


def test_statistics_on_a_hand_computed_trade_list():
    trades = [
        trade(0, 0, -1.0, -100.0),
        trade(0, 1, -2.0, -200.0),
        trade(1, 2, 0.0, 0.0),
        trade(1, 2, 3.0, 300.0),
        trade(2, 3, -0.5, -50.0),
    ]
    benchmark = pd.Series(
        {date(2025, 12, 30): 100.0, date(2025, 12, 31): 101.0, date(2026, 1, 2): 102.0, date(2026, 1, 3): 103.0}
    )
    result = stats(trades, equity_curve(), 10_000.0, benchmark, bars_in_position=6, total_bars=20)

    assert result.trades == 5
    assert result.total_return_pct == pytest.approx(8.9)
    assert result.max_drawdown_pct == pytest.approx(10.0)
    assert result.win_rate_pct == pytest.approx(20.0)  # 1 win of 5 trades (the breakeven counts, not as a win)
    assert result.avg_win_r == pytest.approx(3.0)
    assert result.avg_loss_r == pytest.approx(-3.5 / 3)
    assert result.expectancy_r == pytest.approx(-0.1)
    assert result.profit_factor == pytest.approx(300.0 / 350.0)
    assert result.avg_hold_bars == pytest.approx(1.8)
    assert result.exposure_pct == pytest.approx(30.0)
    assert result.longest_losing_streak == 2  # the first two trades, back to back
    assert result.returns_by_year == pytest.approx({2025: 10.0, 2026: -1.0})
    assert result.benchmark_return_pct == pytest.approx(3.0)

    daily_returns = [0.10, -0.10, 0.10]
    expected_sharpe = statistics.mean(daily_returns) / statistics.stdev(daily_returns) * math.sqrt(252)
    assert result.sharpe == pytest.approx(expected_sharpe)

    days = (EQUITY_DATES[-1] - EQUITY_DATES[0]).days
    expected_cagr = ((10_890.0 / 10_000.0) ** (365.25 / days) - 1) * 100
    assert result.cagr_pct == pytest.approx(expected_cagr)


def test_stats_of_an_empty_trade_list_is_all_unknown():
    curve = pd.Series([10_000.0], index=pd.Index([date(2026, 1, 1)]))
    result = stats([], curve, 10_000.0, pd.Series(100.0, index=curve.index))
    assert result.trades == 0
    assert math.isnan(result.win_rate_pct)
    assert math.isnan(result.sharpe)
    assert result.total_return_pct == pytest.approx(0.0)
```

- [ ] **Step 2: Run it and watch it fail.**

Run (in `backend/`): `uv run pytest -q tests/test_backtest.py`
Expected: collection error, `ModuleNotFoundError: No module named 'ai_trading.core.backtest'`.

- [ ] **Step 3: Implement** `backend/src/ai_trading/core/backtest.py`:

```python
"""Runs a strategy spec over historical bars through the live evaluator, no look-ahead (02h
section 2). `backtest()` calls `evaluate()` once per symbol (its indicators are causal, so one
call over the whole series gives the same fired signals a bar-by-bar poll would) and then walks
the execution bars once, bar by bar, in the same order a live paper account would see them:

1. At the open: a position already held gaps out if the open is already through its stop or
   target; then, only for symbols now flat, the previous bar's queued signal fills, sized with
   equity marked at this open and gated by the limits as known at the open.
2. During the bar: every open position (including one just opened) is checked against the bar's
   low and high — stop before target if both are touched — and a due time exit fires at the close.
3. At the close: the strategy's signal for this bar queues for the next bar's open, unless the
   symbol still holds a position, in which case it is dropped.

`core/sizing.py` sizes every fill; each symbol's own `InstrumentSpec` prices its costs.
"""

import math
from dataclasses import dataclass
from datetime import time
from typing import Any, Literal

import pandas as pd

from ai_trading.contracts.strategy_spec_v1 import Limits, StrategySpecV1
from ai_trading.core import indicators, levels
from ai_trading.core.calendar import ET, Asset, annotate, session
from ai_trading.core.evaluate import INTRADAY_CADENCES, SignalCandidate, evaluate
from ai_trading.core.sizing import Bracket, Side, plan_order

ExitReason = Literal["stop", "target", "time", "end_of_data"]
ATR_LENGTH = 14  # paperOrder.stop.atrMultiple has no length field; 14 is the common swing default.
_SESSION_LEVELS = {"premarket_high", "premarket_low", "overnight_high", "overnight_low"}
_ANNUALIZATION = {"daily": 252.0, "weekly": 52.0}
_BAR_LENGTH = pd.Timedelta(minutes=1)  # bars_1m is always 1-minute, the same assumption evaluate.py makes


@dataclass(frozen=True)
class SymbolBars:
    """Bars for one symbol, in the shape `evaluate()` and `backtest()` need."""

    bars_1d: pd.DataFrame
    bars_1m: pd.DataFrame | None = None


@dataclass(frozen=True)
class InstrumentSpec:
    """A symbol's contract terms for sizing and costs. Defaults to a stock: a $1-a-point
    multiplier, a 1-cent tick, and $0.005 commission a share. A caller backtesting futures passes
    its own spec (02g) with its own multiplier, tick, and per-contract commission; this module
    never imports one, to stay a pure function of what it is given."""

    multiplier: float = 1.0
    tick_size: float = 0.01
    commission_per_unit: float = 0.005


@dataclass(frozen=True)
class Costs:
    slippage_ticks: float = 1.0


@dataclass(frozen=True)
class Trade:
    symbol: str
    side: Side
    entry_time: Any
    entry_price: float
    exit_time: Any
    exit_price: float
    quantity: int
    r: float
    exit_reason: ExitReason
    pnl: float  # realized, after commission and slippage


@dataclass(frozen=True)
class BacktestStats:
    total_return_pct: float
    cagr_pct: float
    max_drawdown_pct: float  # positive magnitude, from the starting equity as the initial peak
    sharpe: float  # annualized by `frequency`
    trades: int
    win_rate_pct: float
    avg_win_r: float
    avg_loss_r: float  # negative
    expectancy_r: float
    profit_factor: float
    avg_hold_bars: float
    exposure_pct: float
    longest_losing_streak: int
    returns_by_year: dict[int, float]
    benchmark_return_pct: float  # buy-and-hold of the required benchmark, over the same period


@dataclass(frozen=True)
class BacktestResult:
    trades: list[Trade]
    equity_curve: pd.Series
    stats: BacktestStats


@dataclass
class _Position:
    symbol: str
    side: Side
    quantity: int
    entry_time: Any
    entry_price: float  # realized (slipped) fill
    entry_commission: float
    risk_per_share: float  # |planned entry - stop|, unslipped
    stop: float
    target: float


def _signal_positions(
    signals: list[SignalCandidate], execution_bars: pd.DataFrame, asset: Asset, run_on: str
) -> set[int]:
    """The execution-bar row position of every fired signal."""
    if run_on in INTRADAY_CADENCES:
        return {execution_bars.index.get_loc(sig.bar_time) for sig in signals}
    close_to_day = {session(asset, day).regular_close: day for day in execution_bars.index}
    return {execution_bars.index.get_loc(close_to_day[sig.bar_time]) for sig in signals}


def _level_series(
    level_operand: dict[str, Any], *, daily: pd.DataFrame, bars: pd.DataFrame, days: pd.Index, asset: Asset
) -> pd.Series:
    """`level_operand`'s value at every row of `bars`, through the same `core/levels.py`
    functions `evaluate()`'s own level dispatch uses, so a `paperOrder` stop or target level
    resolves whether or not that level also appears in `when`."""
    name = level_operand["level"]
    unique_days = pd.Index(days.unique())

    def per_day(values: pd.Series) -> pd.Series:
        return pd.Series(values.reindex(days).to_numpy(), index=bars.index)

    if name.startswith("prior_day_"):
        return per_day(levels.prior_day(daily, unique_days, asset, name.removeprefix("prior_day_")))
    if name.startswith("n_day_"):
        return per_day(levels.n_day(daily, unique_days, level_operand["days"], name.removeprefix("n_day_")))
    if name in ("support", "resistance"):
        return per_day(levels.support_resistance(daily, unique_days, level_operand["days"], name))
    if name in _SESSION_LEVELS:
        return levels.pre_phase(bars, name.rsplit("_", 1)[1])
    return levels.opening_range(bars, asset, level_operand["minutes"], name.rsplit("_", 1)[1])


def _level_cache(
    paper_order: dict[str, Any],
    symbols: list[str],
    bars: dict[str, SymbolBars],
    execution_bars: dict[str, pd.DataFrame],
    asset: Asset,
    intraday: bool,
) -> dict[str, tuple[pd.Series | None, pd.Series | None]]:
    """Per symbol, the stop and target level series (None when that side is not level-based),
    aligned to `execution_bars[symbol]`'s index."""
    stop_spec, target_spec = paper_order["stop"], paper_order["target"]
    out: dict[str, tuple[pd.Series | None, pd.Series | None]] = {}
    for s in symbols:
        sb = bars[s]
        if intraday:
            ann = annotate(sb.bars_1m, asset)
            level_bars, level_days = ann, pd.Index(ann["day"])
        else:
            level_bars, level_days = sb.bars_1d, sb.bars_1d.index
        stop_series = (
            _level_series(stop_spec, daily=sb.bars_1d, bars=level_bars, days=level_days, asset=asset).reindex(
                execution_bars[s].index
            )
            if "level" in stop_spec
            else None
        )
        target_series = (
            _level_series(target_spec, daily=sb.bars_1d, bars=level_bars, days=level_days, asset=asset).reindex(
                execution_bars[s].index
            )
            if "level" in target_spec
            else None
        )
        out[s] = (stop_series, target_series)
    return out


def _resolve(
    paper_order: dict[str, Any], stop_value: float | None, target_value: float | None, atr_value: float
) -> tuple[float | None, float | None, float | None]:
    """Stop level, target level, and ATR for `plan_order`."""
    stop_spec, target_spec = paper_order["stop"], paper_order["target"]
    stop_level = stop_value if "level" in stop_spec else None
    target_level = target_value if "level" in target_spec else None
    atr = atr_value if "atrMultiple" in stop_spec else None
    return stop_level, target_level, atr


def _gap_exit(position: _Position, bar: pd.Series) -> tuple[float, ExitReason] | None:
    """Exit at the open, when the open has already gapped through the stop or the target."""
    o = float(bar["open"])
    if position.side == "buy":
        if o <= position.stop:
            return o, "stop"
        if o >= position.target:
            return o, "target"
    else:
        if o >= position.stop:
            return o, "stop"
        if o <= position.target:
            return o, "target"
    return None


def _touch_exit(position: _Position, bar: pd.Series, *, is_last: bool, flat: bool) -> tuple[float, ExitReason] | None:
    """The fill and reason from the rest of `bar` (its low and high), once a gap at the open has
    already been ruled out separately: stop before target when a bar touches both. A due time
    exit fires at the close; a position still open at the last bar of the data closes there too."""
    h, lo = float(bar["high"]), float(bar["low"])
    if position.side == "buy":
        if lo <= position.stop:
            return position.stop, "stop"
        if h >= position.target:
            return position.target, "target"
    else:
        if h >= position.stop:
            return position.stop, "stop"
        if lo <= position.target:
            return position.target, "target"
    if flat:
        return float(bar["close"]), "time"
    if is_last:
        return float(bar["close"]), "end_of_data"
    return None


def _open(bracket: Bracket, entry_time: Any, costs: Costs, instrument: InstrumentSpec) -> _Position:
    sign = 1.0 if bracket.side == "buy" else -1.0
    fill = bracket.entry + sign * costs.slippage_ticks * instrument.tick_size
    return _Position(
        symbol="",  # filled in by the caller, which knows it
        side=bracket.side,
        quantity=bracket.quantity,
        entry_time=entry_time,
        entry_price=fill,
        entry_commission=bracket.quantity * instrument.commission_per_unit,
        risk_per_share=abs(bracket.entry - bracket.stop),
        stop=bracket.stop,
        target=bracket.target,
    )


def _close(
    position: _Position, raw_price: float, reason: ExitReason, exit_time: Any, costs: Costs, instrument: InstrumentSpec
) -> tuple[Trade, float]:
    """The closed `Trade` (whose `pnl` is the full round trip, both commissions) and the cash this
    close adds (the entry commission was already taken out of cash when the position opened)."""
    sign = 1.0 if position.side == "buy" else -1.0
    exit_price = raw_price - sign * costs.slippage_ticks * instrument.tick_size
    gross = (exit_price - position.entry_price) * sign * position.quantity * instrument.multiplier
    exit_commission = position.quantity * instrument.commission_per_unit
    cash_delta = gross - exit_commission
    pnl = cash_delta - position.entry_commission
    r = (
        (exit_price - position.entry_price) * sign / position.risk_per_share
        if position.risk_per_share > 0
        else math.nan
    )
    trade = Trade(
        symbol=position.symbol,
        side=position.side,
        entry_time=position.entry_time,
        entry_price=round(position.entry_price, 6),
        exit_time=exit_time,
        exit_price=round(exit_price, 6),
        quantity=position.quantity,
        r=round(r, 6),
        exit_reason=reason,
        pnl=round(pnl, 6),
    )
    return trade, cash_delta


def _day_of(value: Any) -> Any:
    return value.tz_convert(ET).date() if isinstance(value, pd.Timestamp) else value


def _blocked_by_limits(
    limits: Limits | None,
    *,
    trades_today: int,
    daily_pnl: float,
    open_positions: int,
    last_exit: Any,
    now: Any,
    intraday: bool,
) -> bool:
    """Whether the spec's `limits` (02a) forbid a new entry right now, so a backtest's trade count
    matches what the paper account would actually have placed. Every input here is state already
    known as of this bar's open (trades placed, P&L realized, and exits up through the gap-exit
    step that runs before this check)."""
    if limits is None:
        return False
    if limits.maxOpenPositions is not None and open_positions >= limits.maxOpenPositions:
        return True
    if limits.maxTradesPerDay is not None and trades_today >= limits.maxTradesPerDay:
        return True
    if limits.pauseAfterDailyLossUsd is not None and daily_pnl <= -limits.pauseAfterDailyLossUsd:
        return True
    # cooldownMinutes is a per-symbol re-entry gap; it only has meaning between bars that are
    # minutes apart, so it is skipped for the daily/weekly cadences (see REPORT-F.md).
    if intraday and limits.cooldownMinutes is not None and last_exit is not None:
        if (now - last_exit) < pd.Timedelta(minutes=limits.cooldownMinutes):
            return True
    return False


def _mark(
    positions: dict[str, _Position | None],
    execution_bars: dict[str, pd.DataFrame],
    pos: int,
    instruments: dict[str, InstrumentSpec],
    field: str = "close",
) -> float:
    """Unrealized P&L of every open position, marked at row `pos` of its own symbol's bars, at
    `field` (`"open"` or `"close"`)."""
    return sum(
        (float(execution_bars[s].iloc[pos][field]) - p.entry_price)
        * (1.0 if p.side == "buy" else -1.0)
        * p.quantity
        * instruments[s].multiplier
        for s, p in positions.items()
        if p is not None
    )


def backtest(
    spec: StrategySpecV1,
    asset: Asset,
    bars: dict[str, SymbolBars],
    *,
    benchmark: pd.Series,
    starting_equity: float = 100_000.0,
    instruments: dict[str, InstrumentSpec] | None = None,
    max_position_usd: float | None = None,
    costs: Costs | None = None,
) -> BacktestResult:
    """Runs `spec` over `bars`, one position per symbol, sized by `plan_order` and gated by
    `spec.limits`. `benchmark` is a close series for the buy-and-hold comparison every result
    reports (02h section 2 always shows it next to the strategy's own return).

    Every symbol's execution bars (`bars_1m` for an intraday `runOn`, else `bars_1d`) must share
    the same index: the account's equity is shared across symbols, so they are walked together.
    `instruments` gives each symbol's contract terms (`InstrumentSpec`); a symbol missing from it
    defaults to a stock.
    """
    costs = costs or Costs()
    instruments = instruments or {}
    dumped = spec.model_dump(by_alias=True, exclude_none=True)
    paper_order = dumped.get("then", {}).get("paperOrder")
    if paper_order is None:
        raise ValueError("backtest requires then.paperOrder")
    run_on = spec.watch.runOn
    intraday = run_on in INTRADAY_CADENCES
    limits = spec.limits
    flat_by = time.fromisoformat(limits.flatBy) if limits and limits.flatBy else None

    symbols = sorted(bars)
    specs = {s: instruments.get(s, InstrumentSpec()) for s in symbols}
    signals: dict[str, list[SignalCandidate]] = {}
    for symbol, sb in bars.items():
        as_of = (
            sb.bars_1m.index[-1] + pd.Timedelta(minutes=1)
            if intraday and sb.bars_1m is not None and len(sb.bars_1m)
            else session(asset, sb.bars_1d.index[-1]).regular_close
        )
        signals[symbol] = evaluate(spec, symbol, asset, bars_1m=sb.bars_1m, bars_1d=sb.bars_1d, as_of=as_of)

    execution_bars = {s: (bars[s].bars_1m if intraday else bars[s].bars_1d) for s in symbols}
    reference_index = execution_bars[symbols[0]].index
    for s in symbols[1:]:
        if not execution_bars[s].index.equals(reference_index):
            raise ValueError("backtest requires every symbol's execution bars to share one index")
    n = len(reference_index)

    atr_cache = {s: indicators.atr(execution_bars[s], ATR_LENGTH) for s in symbols}
    level_cache = _level_cache(paper_order, symbols, bars, execution_bars, asset, intraday)
    signal_positions = {s: _signal_positions(signals[s], execution_bars[s], asset, run_on) for s in symbols}
    positions: dict[str, _Position | None] = dict.fromkeys(symbols)
    pending: dict[str, int | None] = dict.fromkeys(symbols)  # the row to fill at, queued at the prior close
    bars_in_position = dict.fromkeys(symbols, 0)
    last_exit: dict[str, Any] = dict.fromkeys(symbols)
    cash = starting_equity
    trades: list[Trade] = []
    equity_values: list[float] = []
    current_day = _day_of(reference_index[0])
    trades_today = 0
    daily_pnl = 0.0

    for i in range(n):
        day = _day_of(reference_index[i])
        if day != current_day:
            current_day, trades_today, daily_pnl = day, 0, 0.0
        is_last = i == n - 1
        # "Flat by T" fires on the first bar whose *end* (bars are labeled by their start) is at
        # or after T, and the exit it records is that end, not the bar's start.
        bar_end = reference_index[i] + _BAR_LENGTH
        flat_time = intraday and flat_by is not None and bar_end.tz_convert(ET).time() >= flat_by

        # 1a. At the open: a held position gaps out if the open is already through its level.
        for s in symbols:
            position = positions[s]
            if position is not None:
                exit_ = _gap_exit(position, execution_bars[s].iloc[i])
                if exit_ is not None:
                    trade, cash_delta = _close(position, exit_[0], exit_[1], reference_index[i], costs, specs[s])
                    trades.append(trade)
                    cash += cash_delta
                    daily_pnl += trade.pnl
                    last_exit[s] = reference_index[i]
                    positions[s] = None

        # 1b. At the open: fill a queued entry, only for symbols now flat; size and gate on
        # equity and limits as known at the open (cash plus positions marked at this open).
        for s in symbols:
            if positions[s] is None and pending[s] == i:
                pending[s] = None
                signal_pos = i - 1  # a fill is always the bar right after its signal
                open_positions = sum(1 for p in positions.values() if p is not None)
                blocked = _blocked_by_limits(
                    limits,
                    trades_today=trades_today,
                    daily_pnl=daily_pnl,
                    open_positions=open_positions,
                    last_exit=last_exit[s],
                    now=reference_index[i],
                    intraday=intraday,
                )
                if not blocked:
                    stop_series, target_series = level_cache[s]
                    stop_value = float(stop_series.iloc[signal_pos]) if stop_series is not None else None
                    target_value = float(target_series.iloc[signal_pos]) if target_series is not None else None
                    atr_value = atr_cache[s].iloc[signal_pos]
                    stop_level, target_level, atr_value = _resolve(paper_order, stop_value, target_value, atr_value)
                    equity_at_open = cash + _mark(positions, execution_bars, i, specs, field="open")
                    plan = plan_order(
                        paper_order,
                        entry=float(execution_bars[s].iloc[i]["open"]),
                        stop_level=stop_level,
                        target_level=target_level,
                        atr=atr_value,
                        book_equity=equity_at_open,
                        multiplier=specs[s].multiplier,
                        max_position_usd=max_position_usd,
                    )
                    if plan.bracket is not None:
                        position = _open(plan.bracket, reference_index[i], costs, specs[s])
                        position.symbol = s
                        cash -= position.entry_commission
                        positions[s] = position
                        trades_today += 1

        # 2. During the bar: the low/high of every open position, including one just opened.
        for s in symbols:
            position = positions[s]
            if position is not None:
                exit_ = _touch_exit(position, execution_bars[s].iloc[i], is_last=is_last, flat=flat_time)
                if exit_ is not None:
                    # A time exit is recorded at the bar's end (when it actually happens), not the
                    # bar's start; every other exit already happens within the bar it is on.
                    exit_time = bar_end if exit_[1] == "time" else reference_index[i]
                    trade, cash_delta = _close(position, exit_[0], exit_[1], exit_time, costs, specs[s])
                    trades.append(trade)
                    cash += cash_delta
                    daily_pnl += trade.pnl
                    last_exit[s] = reference_index[i]
                    positions[s] = None
            if positions[s] is not None:
                bars_in_position[s] += 1

        equity_values.append(cash + _mark(positions, execution_bars, i, specs, field="close"))

        # 3. At the close: queue this bar's signal for the next open, unless still holding.
        for s in symbols:
            if i in signal_positions[s] and positions[s] is None and i + 1 < n:
                pending[s] = i + 1

    equity_curve = pd.Series(equity_values, index=reference_index)
    result_stats = stats(
        trades,
        equity_curve,
        starting_equity,
        benchmark,
        bars_in_position=sum(bars_in_position.values()),
        total_bars=n * len(symbols),
        frequency="weekly" if run_on == "weekly" else "daily",
    )
    return BacktestResult(trades, equity_curve, result_stats)


def _year(value: Any) -> int:
    return value.tz_convert(ET).year if isinstance(value, pd.Timestamp) else value.year


def _periodic_returns(curve: pd.Series, frequency: Literal["daily", "weekly"]) -> pd.Series:
    """`curve` resampled to one value per calendar day (ET, for an intraday curve) and, for a
    weekly `frequency`, further to one value per ISO week, then turned into simple returns."""
    if isinstance(curve.index, pd.DatetimeIndex):
        curve = curve.groupby(curve.index.tz_convert(ET).date).last()
    if frequency == "weekly":
        curve = curve.groupby(lambda d: d.isocalendar()[:2]).last()
    return curve.pct_change().dropna()


def stats(
    trades: list[Trade],
    equity_curve: pd.Series,
    starting_equity: float,
    benchmark: pd.Series,
    *,
    bars_in_position: int = 0,
    total_bars: int = 0,
    frequency: Literal["daily", "weekly"] = "daily",
) -> BacktestStats:
    """Statistics for `trades` and `equity_curve`, independent of `backtest()` so a hand-built
    trade list and equity curve can be checked directly. `benchmark` is a close series sliced to
    the equity curve's own period for the required buy-and-hold comparison."""
    nan = math.nan
    if equity_curve.empty:
        return BacktestStats(
            total_return_pct=nan,
            cagr_pct=nan,
            max_drawdown_pct=nan,
            sharpe=nan,
            trades=0,
            win_rate_pct=nan,
            avg_win_r=nan,
            avg_loss_r=nan,
            expectancy_r=nan,
            profit_factor=nan,
            avg_hold_bars=nan,
            exposure_pct=0.0,
            longest_losing_streak=0,
            returns_by_year={},
            benchmark_return_pct=nan,
        )

    final_equity = float(equity_curve.iloc[-1])
    total_return_pct = (final_equity / starting_equity - 1) * 100 if starting_equity > 0 else nan

    first, last = equity_curve.index[0], equity_curve.index[-1]
    days = (last - first).days if hasattr(last - first, "days") else (last - first)
    cagr_pct = (
        ((final_equity / starting_equity) ** (365.25 / days) - 1) * 100 if days > 0 and starting_equity > 0 else nan
    )

    # The starting equity is the initial peak, so a loss on the very first mark already counts.
    running_max = equity_curve.cummax().clip(lower=starting_equity)
    drawdowns = equity_curve / running_max - 1
    max_drawdown_pct = float(-drawdowns.min() * 100)

    periodic = _periodic_returns(equity_curve, frequency)
    if len(periodic) >= 2 and periodic.std(ddof=1) > 0:
        sharpe = float(periodic.mean() / periodic.std(ddof=1) * math.sqrt(_ANNUALIZATION[frequency]))
    else:
        sharpe = nan

    rs = [t.r for t in trades]
    wins = [r for r in rs if r > 0]
    losses = [r for r in rs if r < 0]
    win_rate_pct = 100 * len(wins) / len(rs) if rs else nan
    avg_win_r = sum(wins) / len(wins) if wins else nan
    avg_loss_r = sum(losses) / len(losses) if losses else nan
    expectancy_r = sum(rs) / len(rs) if rs else nan

    gross_profit = sum(t.pnl for t in trades if t.pnl > 0)
    gross_loss = sum(t.pnl for t in trades if t.pnl < 0)
    if not trades:
        profit_factor = nan
    elif gross_loss == 0:
        profit_factor = math.inf if gross_profit > 0 else nan
    else:
        profit_factor = gross_profit / abs(gross_loss)

    avg_hold_bars = sum(_hold_bars(t, equity_curve.index) for t in trades) / len(trades) if trades else nan
    exposure_pct = 100 * bars_in_position / total_bars if total_bars else 0.0

    streak = longest = 0
    for t in sorted(trades, key=lambda t: t.exit_time):
        if t.r < 0:
            streak += 1
            longest = max(longest, streak)
        else:
            streak = 0

    returns_by_year: dict[int, float] = {}
    baseline = starting_equity
    for year, group in equity_curve.groupby(lambda idx: _year(idx)):
        end = float(group.iloc[-1])
        returns_by_year[year] = (end / baseline - 1) * 100 if baseline > 0 else nan
        baseline = end

    window = benchmark.loc[first:last]
    benchmark_return_pct = (float(window.iloc[-1]) / float(window.iloc[0]) - 1) * 100 if len(window) >= 2 else nan

    return BacktestStats(
        total_return_pct=round(total_return_pct, 6) if not math.isnan(total_return_pct) else nan,
        cagr_pct=round(cagr_pct, 6) if not math.isnan(cagr_pct) else nan,
        max_drawdown_pct=round(max_drawdown_pct, 6),
        sharpe=round(sharpe, 6) if not math.isnan(sharpe) else nan,
        trades=len(trades),
        win_rate_pct=round(win_rate_pct, 6) if not math.isnan(win_rate_pct) else nan,
        avg_win_r=round(avg_win_r, 6) if not math.isnan(avg_win_r) else nan,
        avg_loss_r=round(avg_loss_r, 6) if not math.isnan(avg_loss_r) else nan,
        expectancy_r=round(expectancy_r, 6) if not math.isnan(expectancy_r) else nan,
        profit_factor=(
            round(profit_factor, 6)
            if isinstance(profit_factor, float) and math.isfinite(profit_factor)
            else profit_factor
        ),
        avg_hold_bars=round(avg_hold_bars, 6) if not math.isnan(avg_hold_bars) else nan,
        exposure_pct=round(exposure_pct, 6),
        longest_losing_streak=longest,
        returns_by_year={y: round(v, 6) for y, v in returns_by_year.items()},
        benchmark_return_pct=round(benchmark_return_pct, 6) if not math.isnan(benchmark_return_pct) else nan,
    )


def _hold_bars(trade: Trade, index: pd.Index) -> int:
    return int(index.get_loc(trade.exit_time) - index.get_loc(trade.entry_time) + 1)
```

- [ ] **Step 4: Run the tests and lint.**

Run (in `backend/`): `uv run pytest -q tests/test_backtest.py && uv run ruff check . && uv run ruff format --check . && uv run pytest -q`
Expected: `26 passed`, ruff clean, then the full suite grows by 26 over Task 1d.3's count (57 total growth over the pre-1d baseline).

- [ ] **Step 5: Commit.**

```bash
git add ai-trading/packages/family-desk/backend/src/ai_trading/core/backtest.py ai-trading/packages/family-desk/backend/tests/test_backtest.py
git commit -m "feat(ai-trading): Desk backtest engine core over the live evaluator (02h section 2)"
```

### Task 1d.5: AI call settlement, and phase status

**Files:**
- Create: `backend/src/ai_trading/core/settlement.py`, `backend/tests/test_settlement.py`
- Modify: `ai-trading/plans/subplans/02c-desk-v1-implementation-plan.md` (Phases table), `ai-trading/plans/STATUS.md` (the "5+" row)

**Interfaces:**
- Consumes: `exchange_calendars` (already a 02c Tech Stack dependency; `settlement.py` is its first user in this package), `pandas`. The `AiCall`s it settles come from the future Phase 5 Desk AI job, out of scope here.
- Produces (the Phase 5 track-record job and Phase 5's settlement scheduler rely on these):
  - `HORIZON_DAYS = 90`, `HOLD_BAND_PCT = 5.0`, `Rating = Literal["buy", "hold", "sell"]`
  - `PendingReason = str` — **type changed this revision** from `Literal["not_matured", "missing_price_data"]`, since it now also carries a dynamic per-symbol message (`f"no price data for {symbol}"`)
  - `@dataclass(frozen=True) class AiCall: symbol: str; call_date: date; rating: Rating; confidence: float; base_target: float` — `call_date` must be an XNYS trading session
  - `@dataclass(frozen=True) class Outcome: call: AiCall; settle_date: date; excess_return_pct: float; success: bool; target_hit: bool | None; target_hit_reason: str | None; calibration_bucket: str` — **`target_hit_reason` is new this revision**
  - `@dataclass(frozen=True) class Pending: call: AiCall; reason: PendingReason`
  - `calibration_bucket(confidence: float) -> str`
  - `settle(call: AiCall, prices: pd.DataFrame | None, spy: pd.Series, as_of: date) -> Outcome | Pending` — **`prices` now also accepts `None`** (no data for the symbol at all), giving `Pending(call, f"no price data for {call.symbol}")`
  - `settle_all(calls: list[AiCall], prices: dict[str, pd.DataFrame], spy: pd.Series, as_of: date) -> list[Outcome]` — passes `prices.get(call.symbol)` to `settle()`, so a missing symbol is `Pending`, never a `KeyError`

- [ ] **Step 1: Write the failing test** `backend/tests/test_settlement.py`:

```python
from datetime import date

import pandas as pd
import pytest
from bars import trading_days

from ai_trading.core.settlement import HORIZON_DAYS, AiCall, Outcome, Pending, calibration_bucket, settle, settle_all

LAST_DAY = date(2026, 12, 31)
DAYS = trading_days("stock", LAST_DAY, HORIZON_DAYS + 20)  # real XNYS sessions, oldest first


def frame(closes: list[float], highs: list[float] | None = None, lows: list[float] | None = None) -> pd.DataFrame:
    days = DAYS[: len(closes)]
    return pd.DataFrame(
        {"close": closes, "high": highs if highs is not None else closes, "low": lows if lows is not None else closes},
        index=pd.Index(days),
    )


def spy_series(values: list[float]) -> pd.Series:
    return pd.Series(values, index=pd.Index(DAYS[: len(values)]))


def flat_with_horizon_move(count: int, move: float) -> pd.DataFrame:
    """100 every day except at the 90-session horizon (index `HORIZON_DAYS`), which is
    `100 * (1 + move)`."""
    values = [100.0] * count
    values[HORIZON_DAYS] = 100.0 * (1 + move)
    return frame(values)


def flat_spy(count: int, move: float = 0.0) -> pd.Series:
    values = [100.0] * count
    values[HORIZON_DAYS] = 100.0 * (1 + move)
    return spy_series(values)


def call(rating="buy", confidence=70.0, base_target=100.0, call_date=None) -> AiCall:
    return AiCall(
        symbol="TEST", call_date=call_date or DAYS[0], rating=rating, confidence=confidence, base_target=base_target
    )


def test_unmatured_as_of_before_the_horizon_date_stays_pending():
    prices = flat_with_horizon_move(HORIZON_DAYS + 5, 0.10)
    spy = flat_spy(HORIZON_DAYS + 5)
    settle_date = DAYS[HORIZON_DAYS]
    before = settle(call(), prices, spy, as_of=DAYS[HORIZON_DAYS - 1])
    assert before == Pending(call(), "not_matured")
    matured = settle(call(), prices, spy, as_of=settle_date)
    assert isinstance(matured, Outcome)


@pytest.mark.parametrize(
    ("rating", "expected_success"),
    [("buy", True), ("sell", False), ("hold", True)],  # excess is exactly +5%: Hold's boundary
)
def test_success_rule_at_the_positive_hold_boundary(rating, expected_success):
    prices = flat_with_horizon_move(HORIZON_DAYS + 1, 0.10)  # +10%
    spy = flat_spy(HORIZON_DAYS + 1, 0.05)  # +5%, so excess is +5.0 exactly
    outcome = settle(call(rating=rating), prices, spy, as_of=date(2030, 1, 1))
    assert outcome.excess_return_pct == pytest.approx(5.0)
    assert outcome.success is expected_success


@pytest.mark.parametrize(
    ("rating", "expected_success"),
    [("buy", False), ("sell", True), ("hold", True)],  # excess is exactly -5%: Hold's other boundary
)
def test_success_rule_at_the_negative_hold_boundary(rating, expected_success):
    prices = flat_with_horizon_move(HORIZON_DAYS + 1, 0.0)  # flat
    spy = flat_spy(HORIZON_DAYS + 1, 0.05)  # SPY +5%, so excess is -5.0 exactly
    outcome = settle(call(rating=rating), prices, spy, as_of=date(2030, 1, 1))
    assert outcome.excess_return_pct == pytest.approx(-5.0)
    assert outcome.success is expected_success


@pytest.mark.parametrize(
    ("rating", "excess_move", "expected_success"),
    [
        ("buy", 0.0001, True),
        ("buy", -0.0001, False),
        ("buy", 0.0, False),  # a tie is not a Buy success
        ("sell", -0.0001, True),
        ("sell", 0.0001, False),
        ("sell", 0.0, False),  # a tie is not a Sell success
        ("hold", 0.050001, False),  # just past the +/-5% band
        ("hold", -0.050001, False),
    ],
)
def test_success_rule_just_off_its_boundary(rating, excess_move, expected_success):
    prices = flat_with_horizon_move(HORIZON_DAYS + 1, excess_move)
    spy = flat_spy(HORIZON_DAYS + 1)
    outcome = settle(call(rating=rating), prices, spy, as_of=date(2030, 1, 1))
    assert outcome.success is expected_success


def test_target_window_excludes_the_call_date_itself():
    count = HORIZON_DAYS + 1
    closes = [100.0] * count
    spy = flat_spy(count)

    highs_on_call_date = list(closes)
    highs_on_call_date[0] = 200.0  # touches a high target on the call date itself: must not count
    only_call_date = settle(
        call(base_target=150.0), frame(closes, highs=highs_on_call_date, lows=closes), spy, date(2030, 1, 1)
    )
    assert only_call_date.target_hit is False

    highs_next_day = list(closes)
    highs_next_day[1] = 200.0  # the very next session: counts
    next_day = settle(call(base_target=150.0), frame(closes, highs=highs_next_day, lows=closes), spy, date(2030, 1, 1))
    assert next_day.target_hit is True


def test_incomplete_high_low_coverage_makes_the_target_unknown_but_still_settles_the_verdict():
    count = HORIZON_DAYS + 1
    closes = [100.0] * count
    closes[HORIZON_DAYS] = 110.0  # +10% move: still settles the excess return and success
    highs, lows = list(closes), list(closes)
    highs[40] = float("nan")  # one session in the window has no recorded high
    prices = frame(closes, highs=highs, lows=lows)
    spy = flat_spy(count)

    outcome = settle(call(base_target=105.0), prices, spy, as_of=date(2030, 1, 1))
    assert outcome.target_hit is None
    assert outcome.target_hit_reason is not None and "high/low" in outcome.target_hit_reason
    assert outcome.excess_return_pct == pytest.approx(10.0)  # only needs the two endpoints
    assert outcome.success is True


def test_a_row_missing_entirely_from_the_target_window_also_makes_it_unknown():
    count = HORIZON_DAYS + 1
    closes = [100.0] * count
    closes[HORIZON_DAYS] = 110.0
    prices = frame(closes).drop(index=DAYS[40])
    spy = flat_spy(count)
    outcome = settle(call(base_target=105.0), prices, spy, as_of=date(2030, 1, 1))
    assert outcome.target_hit is None


def test_settle_gives_pending_with_a_reason_for_a_symbol_with_no_price_data():
    spy = flat_spy(HORIZON_DAYS + 1)
    result = settle(call(), None, spy, as_of=date(2030, 1, 1))
    assert result == Pending(call(), "no price data for TEST")


def test_settle_all_skips_a_call_whose_symbol_has_no_price_data_without_raising():
    prices = flat_with_horizon_move(HORIZON_DAYS + 1, 0.10)
    spy = flat_spy(HORIZON_DAYS + 1)
    result = settle_all([call()], {"OTHER": prices}, spy, as_of=date(2030, 1, 1))
    assert result == []


def test_target_above_entry_is_reached_by_a_high_that_never_closes_there():
    count = HORIZON_DAYS + 1
    closes = [100.0] * count
    highs = list(closes)
    highs[40] = 111.0  # touches the target mid-horizon intraday, closes back down the same day
    prices = frame(closes, highs=highs, lows=closes)
    spy = flat_spy(count)
    hit = settle(call(base_target=110.0), prices, spy, as_of=date(2030, 1, 1))
    missed = settle(call(base_target=112.0), prices, spy, as_of=date(2030, 1, 1))
    assert hit.target_hit is True
    assert closes[40] < 110.0  # the close itself never reached it
    assert missed.target_hit is False


def test_target_below_entry_is_reached_by_a_low_that_never_closes_there():
    count = HORIZON_DAYS + 1
    closes = [100.0] * count
    lows = list(closes)
    lows[40] = 89.0  # touches the target mid-horizon intraday, closes back up the same day
    prices = frame(closes, highs=closes, lows=lows)
    spy = flat_spy(count)
    hit = settle(call(base_target=90.0), prices, spy, as_of=date(2030, 1, 1))
    missed = settle(call(base_target=88.0), prices, spy, as_of=date(2030, 1, 1))
    assert hit.target_hit is True
    assert closes[40] > 90.0  # the close itself never reached it
    assert missed.target_hit is False


def test_settling_the_same_call_twice_is_identical():
    prices = flat_with_horizon_move(HORIZON_DAYS + 1, 0.10)
    spy = flat_spy(HORIZON_DAYS + 1, 0.02)
    first = settle(call(), prices, spy, as_of=date(2030, 1, 1))
    second = settle(call(), prices, spy, as_of=date(2030, 1, 1))
    assert first == second


@pytest.mark.parametrize("drop", ["call_date", "settle_date"])
def test_a_gap_in_the_price_data_stays_pending_not_a_keyerror(drop):
    count = HORIZON_DAYS + 1
    prices = flat_with_horizon_move(count, 0.10)
    missing_day = call().call_date if drop == "call_date" else DAYS[HORIZON_DAYS]
    gapped = prices.drop(index=missing_day)
    spy = flat_spy(count)
    result = settle(call(), gapped, spy, as_of=date(2030, 1, 1))
    assert result == Pending(call(), "missing_price_data")


def test_a_missing_spy_row_on_the_settle_date_stays_pending_not_a_keyerror():
    count = HORIZON_DAYS + 1
    prices = flat_with_horizon_move(count, 0.10)
    spy = flat_spy(count).drop(index=DAYS[HORIZON_DAYS])
    result = settle(call(), prices, spy, as_of=date(2030, 1, 1))
    assert result == Pending(call(), "missing_price_data")


def test_settle_all_catches_up_a_missed_day_without_changing_earlier_outcomes():
    count = HORIZON_DAYS + 11
    closes = [100.0] * count
    closes[HORIZON_DAYS] = 110.0  # call A's horizon day
    closes[HORIZON_DAYS + 10] = 90.0  # call B's horizon day
    prices = frame(closes)
    spy = spy_series([100.0] * count)
    call_a = call(call_date=DAYS[0])
    call_b = call(call_date=DAYS[10], rating="sell")

    only_a = settle_all([call_a, call_b], {"TEST": prices}, spy, as_of=DAYS[HORIZON_DAYS])
    assert [o.call for o in only_a] == [call_a]

    both = settle_all([call_a, call_b], {"TEST": prices}, spy, as_of=DAYS[HORIZON_DAYS + 10])
    assert [o.call for o in both] == [call_a, call_b]
    assert both[0] == only_a[0]  # the catch-up run did not change call A's already-matured outcome


@pytest.mark.parametrize(
    ("confidence", "bucket"),
    [
        (0.0, "<50"),
        (49.9, "<50"),
        (50.0, "50-60"),
        (59.9, "50-60"),
        (60.0, "60-70"),
        (69.9, "60-70"),
        (70.0, "70-80"),
        (79.9, "70-80"),
        (80.0, "80+"),
        (100.0, "80+"),
    ],
)
def test_calibration_buckets_at_their_boundaries(confidence, bucket):
    assert calibration_bucket(confidence) == bucket
```

- [ ] **Step 2: Run it and watch it fail.**

Run (in `backend/`): `uv run pytest -q tests/test_settlement.py`
Expected: collection error, `ModuleNotFoundError: No module named 'ai_trading.core.settlement'`.

- [ ] **Step 3: Implement** `backend/src/ai_trading/core/settlement.py`:

```python
"""Settles Desk AI calls 90 trading sessions after they were made (02h section 3): each call is
scored against SPY using only its own and SPY's price series, so settlement is a pure function of
its inputs. Phase 5 runs it as a daily job that persists each `Outcome` once — an insert-once (or
upsert keyed by the call) into `ai_call_outcomes` — so a call settles once however many times this
job re-runs; `settle`/`settle_all` do not do that writing, they only compute the value to write.
"""

from dataclasses import dataclass
from datetime import date
from typing import Literal

import exchange_calendars as xcals
import pandas as pd

HORIZON_DAYS = 90
HOLD_BAND_PCT = 5.0  # a Hold succeeds within +/-5% of SPY's return, inclusive
CALIBRATION_BUCKETS = (50.0, 60.0, 70.0, 80.0)  # "50-60", "60-70", "70-80", "80+"; below 50 is "<50"

_CALENDAR = xcals.get_calendar("XNYS")  # the horizon is 90 XNYS trading sessions, not 90 rows

Rating = Literal["buy", "hold", "sell"]
PendingReason = str  # "not_matured", "missing_price_data", or "no price data for <symbol>"


@dataclass(frozen=True)
class AiCall:
    symbol: str
    call_date: date  # must be an XNYS trading session
    rating: Rating
    confidence: float  # 0-100
    base_target: float


@dataclass(frozen=True)
class Outcome:
    call: AiCall
    settle_date: date
    excess_return_pct: float  # the symbol's return minus SPY's, over the horizon
    success: bool
    target_hit: bool | None  # None when the target window's high/low coverage is incomplete
    target_hit_reason: str | None  # set only when target_hit is None
    calibration_bucket: str


@dataclass(frozen=True)
class Pending:
    """`call` is not settled yet: its horizon has not closed as of `as_of` ("not_matured"), its
    symbol has no entry in the `prices` map passed to `settle_all` ("no price data for
    <symbol>"), or `prices`/`spy` has a gap on `call_date` or the settle date
    ("missing_price_data") — never a `KeyError`. A later re-run with fuller data or a later
    `as_of` may settle it."""

    call: AiCall
    reason: PendingReason


def calibration_bucket(confidence: float) -> str:
    if confidence < CALIBRATION_BUCKETS[0]:
        return "<50"
    for low in reversed(CALIBRATION_BUCKETS):
        if confidence >= low:
            return "80+" if low == CALIBRATION_BUCKETS[-1] else f"{low:.0f}-{low + 10:.0f}"
    raise AssertionError("unreachable")  # confidence >= 50 always matches a bucket above


def _success(rating: Rating, excess_return_pct: float) -> bool:
    if rating == "buy":
        return excess_return_pct > 0
    if rating == "sell":
        return excess_return_pct < 0
    return abs(excess_return_pct) <= HOLD_BAND_PCT


def _target_hit(
    call: "AiCall", prices: pd.DataFrame, entry_price: float, settle_date: date
) -> tuple[bool | None, str | None]:
    """Whether `prices` reaches `call.base_target` in the sessions strictly after `call.call_date`
    through `settle_date` — the call was made after that day's close, so it cannot itself register
    a touch. A target above the entry price needs a high at or above it; one below needs a low at
    or below it. Any session in that window missing a high or a low (absent, or `NaN`) makes the
    answer unknown rather than wrong.
    """
    window_start = _CALENDAR.next_session(pd.Timestamp(call.call_date))
    sessions = [d.date() for d in _CALENDAR.sessions_in_range(window_start, pd.Timestamp(settle_date))]
    for d in sessions:
        if d not in prices.index or pd.isna(prices.loc[d, "high"]) or pd.isna(prices.loc[d, "low"]):
            return None, f"missing high/low for {d.isoformat()}"
    window = prices.loc[sessions]
    if call.base_target >= entry_price:
        return bool((window["high"] >= call.base_target).any()), None
    return bool((window["low"] <= call.base_target).any()), None


def settle(call: AiCall, prices: pd.DataFrame | None, spy: pd.Series, as_of: date) -> Outcome | Pending:
    """`call`'s outcome once its 90-trading-session horizon has matured as of `as_of`, else
    `Pending`. `prices` is daily OHLC bars for `call.symbol` indexed by trading day (the same
    shape as `core/backtest.py`'s `bars_1d`: at least `close`, `high`, `low`), or `None` when the
    caller has no data for the symbol at all; `spy` is SPY's closes, indexed the same way. The
    horizon is counted on the XNYS calendar, not on either series' own rows, so a gap in either on
    `call.call_date` or the settle date leaves the call `Pending("missing_price_data")` rather
    than raising. A target window with incomplete high/low coverage settles the excess-return
    verdict anyway (it needs only its two endpoints) with `target_hit=None` (see `_target_hit`).

    Idempotent: every input is read-only and the result depends on nothing but them, so settling
    the same call against the same data twice gives the same result.
    """
    if prices is None:
        return Pending(call, f"no price data for {call.symbol}")

    settle_date = _CALENDAR.session_offset(pd.Timestamp(call.call_date), HORIZON_DAYS).date()
    if settle_date > as_of:
        return Pending(call, "not_matured")

    missing_price_row = call.call_date not in prices.index or settle_date not in prices.index
    missing_spy_row = call.call_date not in spy.index or settle_date not in spy.index
    if missing_price_row or missing_spy_row:
        return Pending(call, "missing_price_data")

    entry_price, exit_price = float(prices.loc[call.call_date, "close"]), float(prices.loc[settle_date, "close"])
    entry_spy, exit_spy = float(spy.loc[call.call_date]), float(spy.loc[settle_date])
    if any(pd.isna(v) for v in (entry_price, exit_price, entry_spy, exit_spy)):
        return Pending(call, "missing_price_data")

    stock_return = exit_price / entry_price - 1
    spy_return = exit_spy / entry_spy - 1
    # Rounded before it meets the Hold threshold, so an exact +/-5% is not missed to binary
    # floating point (the same convention as covered_calls.py's `_r`).
    excess_return_pct = round((stock_return - spy_return) * 100, 6)

    target_hit, target_hit_reason = _target_hit(call, prices, entry_price, settle_date)

    return Outcome(
        call=call,
        settle_date=settle_date,
        excess_return_pct=excess_return_pct,
        success=_success(call.rating, excess_return_pct),
        target_hit=target_hit,
        target_hit_reason=target_hit_reason,
        calibration_bucket=calibration_bucket(call.confidence),
    )


def settle_all(calls: list[AiCall], prices: dict[str, pd.DataFrame], spy: pd.Series, as_of: date) -> list[Outcome]:
    """Every call in `calls` whose horizon has matured as of `as_of` and whose data was complete;
    anything still `Pending` (including a symbol with no entry in `prices`) is simply absent,
    never a placeholder and never a `KeyError`, so re-running this after the next price update
    settles only what newly matured or newly got its data ("catch-up", never skipped)."""
    out = []
    for call in calls:
        result = settle(call, prices.get(call.symbol), spy, as_of)
        if isinstance(result, Outcome):
            out.append(result)
    return out
```

- [ ] **Step 4: Record the phase.**
  - In 02c's Phases table, set the status of the "1d. Research math" row to `Done`.
  - In `STATUS.md`'s "5+" row, append: "Phase 1d (research math) done: as-of helpers, valuation methods, earnings reaction, the backtest engine, AI call settlement."

- [ ] **Step 5: Run every suite.**

Run (in `backend/`): `uv run pytest -q tests/test_settlement.py && uv run ruff check . && uv run ruff format --check . && uv run pytest -q`
Expected: `37 passed`, ruff clean, then the full suite grows by 37 over Task 1d.4's count (94 total growth over the pre-1d baseline — 263 passed if Phase 1c has not yet merged when Phase 1d starts).

- [ ] **Step 6: Commit.**

```bash
git add ai-trading/packages/family-desk/backend/src/ai_trading/core/settlement.py ai-trading/packages/family-desk/backend/tests/test_settlement.py ai-trading/plans/subplans/02c-desk-v1-implementation-plan.md ai-trading/plans/STATUS.md
git commit -m "feat(ai-trading): Desk AI call settlement against SPY on the XNYS calendar; mark Desk Phase 1d done"
```

## After the Tasks (main session)

1. Merge the subagent's branch into `feature/toby`, then remove its worktree and delete the branch.
2. Phase 1d ships in the same pull request as the next phase, or on its own if nothing follows soon (one pull request per finished phase or meaningful batch). Phases 1c and 1d both change nothing that is deployed (02c), so they may land together.
