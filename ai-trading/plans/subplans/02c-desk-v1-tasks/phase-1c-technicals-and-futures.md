# Phase 1c: Technicals and Futures Math

Part of [02c-desk-v1-implementation-plan.md](../02c-desk-v1-implementation-plan.md). Read its Global Constraints, Review Focus, and Shared Interfaces first. Builds on [Phase 1](phase-1-strategy-core.md) and [Phase 1b](phase-1b-ported-quant-core.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Subagents work in a `.worktrees/` worktree on their own `feature/*` branch; the main session merges that branch into `feature/toby` (root `AGENTS.md`).

**Goal:** give the Desk its technical-analysis layer, with attribution and tests: every 02f §3 indicator, classic/Fibonacci/Camarilla pivots, the Desk Technical Bias (TradingView's published vote rules), and CME futures contract specs, roll/expiry dates, and the micro-first sizer. No I/O; nothing is deployed.

**Architecture:**
- `core/indicators.py` (modified) gains ten oscillators (MACD, Stochastic, Stoch RSI, CCI, ADX/DMI, Awesome Oscillator, Momentum, Williams %R, Bull/Bear Power, Ultimate Oscillator), four moving-average/trend indicators (VWMA, Hull MA, Ichimoku, ATR%), and a shared `_true_range()` helper that `atr()` is refactored onto (same values; `adx()` and `ultimate_oscillator()` reuse it too).
- `core/pivots.py` (new): Classic, Fibonacci, and Camarilla pivot formulas (generic over `float` or `pd.Series`) and `prior_period_hlc`, the prior-session/week/month high-low-close helper.
- `core/calendar.py` (Phase 1 file, modified additively): the underlying `exchange_calendars` instances are built over a fixed, explicit range (2015-2030) instead of a today-relative default, so a futures date years out never depends on the day a test happens to run. `session()`/`previous_session()`/`annotate()`/`et()` keep their existing signatures and behavior.
- `core/futures.py` (new): the 12 contracts' specs and product-code parsing (adapted from Vibe-Trading), last-trade/first-notice/roll dates, the front month, and the micro-first sizer built on Phase 1b's `core/sizing.py` arithmetic style.
- `core/bias.py` (new): the Desk Technical Bias — TradingView's 11 oscillator and 15 moving-average votes over `indicators.py`'s series, scored into an oscillator score, a moving-average score, their mean (summary), and the Strong Sell..Strong Buy labels; "warming up" below 250 bars. Pure scoring code, not adapted from any upstream app.
- `core/evaluate.py` (modified, additive only): new series and level dispatch in `_compute` for every new indicator, the pivot level, and the bias; a `_resample` cadence aggregator for `bar_close_5m/15m/1h`; a `_bias_series` growing-window wrapper over `bias.bias()`; a generalized `label()` that joins every extra operand field; and cadence-aware `_points`/edge logic. `check()`, `evaluate()`, and `SignalCandidate` keep their existing public shapes.
- The strategy-spec contract (`contracts/src/strategy-spec-v1.ts`) gains 15 new series/level block kinds and three new `watch.runOn` cadences. Both generated files are regenerated, the shared fixtures grow, and a "Technical bias change" template is added.
- `packages/family-desk/THIRD_PARTY_NOTICES.md` gains rows for `indicators.py`'s `adx`/`ichimoku` adaptations and `futures.py`'s adaptation, alongside Phase 1b's existing rows.

**Tech Stack:** as Phase 1/1b. No new dependencies: every indicator, pivot, and futures calculation uses pandas/numpy/the standard library already in `pyproject.toml`.

**Spec:**
- [02f §3](../02f-desk-indicators-and-ai-daily-design.md): the indicator table, the Desk Technical Bias scoring and labels, pivots, strategy blocks, "where it runs"
- [02f §6](../02f-desk-indicators-and-ai-daily-design.md): the "Technical bias" template (a chosen timeframe's bias label changes)
- [02g §4](../02g-desk-covered-calls-and-futures-swing-design.md): futures contracts, specs, roll/expiry rules, the sizer
- [02a §11](../02a-desk-v1-strategies-design.md): the reuse map (Phase 1c row): Vibe-Trading's futures tables and parsing (copy); its ADX and Ichimoku (adapt); TradingView's rules (documentation)
- [02c](../02c-desk-v1-implementation-plan.md) Global Constraints, Review Focus, Phases table ("1c. Technicals and futures math"), and Shared Interfaces; `ai-trading/AGENTS.md` "Our Code"

## Global Constraints

- Everything in 02c's Global Constraints and in Phase 1's and Phase 1b's Global Constraints applies.
- Code lives in `ai-trading/packages/family-desk/`. It never imports another package. Code adapted from an upstream app carries an attribution header and a row in `packages/family-desk/THIRD_PARTY_NOTICES.md`. Nothing is copied from MiroFish.
- **No new runtime dependency.** No new dependencies in `pyproject.toml` or `package.json`; every indicator, pivot, and futures calculation uses pandas/numpy/the standard library already there.
- `ai_trading.core` does no I/O and reads no clock.
- **Closed bars only.** Rules evaluate on closed bars only (02a §5): a bar counts once its own cadence has closed it, including the three new `bar_close_5m/15m/1h` cadences (02c Shared Interfaces); a still-forming bin is never exposed early. The signal dedupe key is (strategy version, symbol, bar time).
- **Unknown data never votes or fires.** "An indicator without enough history shows no value… Unknown data never votes and never fires a rule" (02f §3's "Unknowns"; Phase 1 ruling, restated in 02c's Global Constraints). A timeframe with fewer than 250 closed bars shows "warming up" instead of a bias (02f §3).
- Never hand-edit the generated files. Regenerate with `pnpm generate:json-schema` (contracts), then `scripts/generate-contracts.sh` (backend).
- Commits are one line, with no trailer. Do not push.

## Decisions for Owner Review

The eight most consequential first; the rest grouped by module. Source reports: `temp/p1c-proto/REPORT-{A,B,C,D}.md` (not committed; the research trail behind this plan).

1. **ADX's Sell rule: TradingView's two published pages disagree, and this module follows the Technical Ratings page.** [Technical Ratings](https://www.tradingview.com/support/solutions/43000614331-technical-ratings/) states Sell needs `+DI < -DI, ADX > 20, ADX falling` (the opposite of Buy's rising requirement); the [Screener rules page](https://www.tradingview.com/support/solutions/43000475547-what-do-the-ratings-in-the-screener-mean/) says "rising," the same as Buy. **Resolution:** Technical Ratings is canonical, because it says these are the same ratings the Screener columns and Technicals gauges show (so it is describing the one underlying rule, not a second, different one); the Screener page's shorter prose is the one that drifted. `bias._adx_vote` implements the falling rule, with `test_adx_vote_sell_minus_di_above_and_adx_falling_above_20` (golden) and `test_adx_vote_no_sell_when_adx_is_rising` (the case that would wrongly fire Sell under the Screener's wording) pinning it, plus boundary tests at ADX exactly 20 and ADX flat. Every other rule on both pages, including the label boundaries (Sell is `-0.5 <= s < -0.1`; Buy is `+0.1 < s <= +0.5`), was checked against the prototype and matches. (bias)
2. **"Uptrend"/"downtrend" for Stoch RSI and Bull/Bear Power (the bias): price above its own SMA(50) is an uptrend, below is a downtrend; neither (vote stays Neutral) when equal or unknown.** TradingView leaves "trend" itself undefined on both rule pages (unlike "rising"/"falling", which they define precisely), and its Pine source for the rule is not fetchable as text -- so this is the Desk's own choice, not a TradingView rule read literally. SMA(50) is already one of the bias's own 15 MA votes, sits in the middle of the Desk's 10-200 MA length set, and is a common, simple trend filter. An owner with a different preferred definition (e.g. SMA(200), or price vs. the Ichimoku cloud) can swap `_trend`'s body alone; every caller only sees its two booleans. (bias)
3. **One roll rule for every physically settled contract: CL, MCL, GC, and MGC roll `PHYSICAL_ROLL_LEAD_DAYS` (5) CME business days before their own delivery deadline** -- `last_trade_date` for CL/MCL, `first_notice_date` for GC/MGC -- replacing the earlier "CL/MCL rolls on its last trade date itself" rule. 02g §4 only says the roll comes before first notice for GC/MGC and says nothing about CL/MCL rolling early at all; the research notes call the exact lead time "unverified"/broker convention, with no exchange-mandated day for crude. A uniform 5-business-day lead (about a work week) keeps a swing position clear of delivery for every physically settled product without rolling unreasonably early. Pinned by the golden `test_cl_mcl_roll_is_five_business_days_before_last_trade` and `test_gc_mgc_december_2026_last_trade_first_notice_and_roll`, and by the exhaustive sweep over every contract month of 2026/2027 (Review Focus 3). (futures)
4. **GC/MGC expose two distinct dates, not one "expiry":** `last_trade_date` is the third-last business day of the *delivery* month (CME's own rule, confirmed against COMEX Rulebook Chapter 113 and CME's Gold Futures and Options fact card); `first_notice_date` is the last business day of the month *before* the delivery month (confirmed independently against a broker's published contract specs). The two are genuinely different dates (e.g. Dec 2026 GC: last trade Dec 29, first notice Nov 30) and the roll (decision 3) is relative to first notice, not last trade -- the earlier single `expiry_date()` function conflated them. `first_notice_date` raises for every other product, since only GC/MGC are physically settled with a notice day distinct from their last trade date. (futures)
5. **Classic pivots use the TradingView/`finta` formula (`R3 = H + 2(P-L)`, `S3 = L - 2(H-P)`), not `pandas_ta`'s differently-named "Traditional" formula (`R2=P+range, R3=P+2*range`, no H/L term).** `pandas_ta`'s function literally named `pivot_classic` is a different method under the same name; the TradingView-style formula matches 02f's TradingView-anchored conventions elsewhere in the spec. A one-line change per level if the owner wants the other formula. (pivots)
6. **"Label changes to Buy/Sell" (02f §6's template) reuses `crosses_above`/`crosses_below` against the known ±0.1 label thresholds, not a new condition type or operator.** Crossing 0.1 upward means "the label just left Neutral-or-worse and entered Buy-or-better" — exactly 02f §3's own boundary table. A transition from Strong Buy back down to plain Buy (still positive) does **not** refire, by the same rule Phase 1 already uses for every other condition (a rule that stays true doesn't fire again); 02f's own prose ("label changes to Buy") could be read either way. (contract/evaluate)
7. **The bias series (`{"series": "bias", "part": ...}`) has no `timeframe` field; it reads whatever cadence `watch.runOn` already resolved to**, the same way the pre-existing `sma`/`rsi`/etc. blocks do. A second, independent "timeframe" field would let a strategy ask for a bias on a timeframe it isn't evaluating on, which nothing in the evaluator computes. (contract)
8. **Multi-output indicators (MACD, Stochastic, Stoch RSI, ADX, Bull/Bear Power, Ultimate's components, Ichimoku, pivots) use a `line`/`point` enum scoped to that indicator's own output names**, not a shared "component" string reused across kinds. Keeps the Pydantic/Zod unions discriminable per kind and matches the project's existing "one object shape per distinct parameter set" convention (`LevelOperand1..4`). (contract)

**Indicators (`core/indicators.py`):**

9. Every new indicator takes its spec'd parameters as named, defaulted arguments (e.g. `macd(close, fast=12, slow=26, signal=9)`), unlike the pre-existing `sma`/`ema`/`rsi`/`atr`, which require `length` with no default — per spec; the pre-existing functions are untouched.
10. Multi-series indicators return a frozen dataclass of `pd.Series` fields (`Macd`, `Stochastic`, `StochRsi`, `Adx`, `BullBearPower`, `Ichimoku`, `AtrPercent`), matching the project's existing convention (`Bracket`, `Candidate`, `Session`) rather than tuples or dicts.
11. Flat-range (0/0) fallbacks, since 02f and the research notes are silent on this edge case: Stochastic %K/%D and Stoch RSI K/D → 50 (midpoint), Williams %R → −50 (midpoint), CCI → 0 (the numerator is also provably 0 whenever the denominator is). Mirrors the existing `rsi()`'s own 0/0 → 50 convention. VWMA and Ultimate Oscillator's zero-volume/zero-range windows produce NaN instead (no sensible midpoint for a ratio of sums).
12. `_true_range()` is extracted from `atr()`'s inline true-range computation into a shared helper, written as `max(H, prior close) − min(L, prior close)` — algebraically identical to the textbook `max(H−L, |H−PC|, |L−PC|)`, verified by the unchanged `atr()` tests — so `adx()` and `ultimate_oscillator()` reuse it instead of duplicating the three-way max/abs logic.
13. Ichimoku stores no forward displacement (spec's own explicit instruction): `span_a`/`span_b` at bar t are the plain, unshifted Donchian-midpoint values computed from data up to and including bar t, matching `ta.trend.IchimokuIndicator(..., visual=False)` exactly and how the Vibe-Trading source computes them before its own (unused-here) `.shift(displacement)` call.
14. The ATR-percent volatility label uses `None` (not `math.nan`) for "not yet known," since it is a string field; `AtrPercent.pct` itself still uses `math.nan` per the project's numeric convention.
15. CCI's mean-absolute-deviation uses `rolling(...).apply(..., raw=True)` (pure numpy inside the window, no new dependency) since pandas has no built-in rolling MAD; simplest correct option at these fixture sizes.
16. Hull MA's `root` length is `round(sqrt(length))` floored to 1 (and `half = length // 2` floored to 1), so `hull_ma` never divides by a zero-length window for very small `length` values; not spec'd, chosen for robustness at the boundary.

**Pivots (`core/pivots.py`):**

17. Camarilla's `P` is shown as `(H+L+C)/3` for display consistency across all three methods, even though Camarilla's own R/S levels never use it (they offset `close`, not `P`) — matches 02f's "P and S3…R3 for all three methods" and how a "pivot table" would want one `P` column.
18. `prior_period_hlc`'s "week"/"month" are calendar-based (Mon–Sun, calendar month), not trading-week/trading-month based, matching the spec's plain language without needing a separate trading-calendar definition.

**Futures (`core/futures.py`):**

19. `size_futures` accepts either side of a mini/micro pair (e.g. `"ES"` or `"MES"`) and always sizes the micro — "micro-first" per 02g §4. An unrecognized product (including a real CME product the Desk doesn't trade, e.g. `"ZC"`) returns zero contracts with a reason rather than raising, matching `sizing.py`'s "no order and why" convention; `_extract_product` itself still raises `ValueError` for the lower-level symbol-parsing case.
20. The `$` note formatting (`_format_usd`) is `f"${value:,.0f}"`, no cents — matches 02g §4's literal example ("one ES would risk $2,500") and that futures point-value math is always a whole number of dollars for these 12 contracts.
21. **Session hours** (`GlobexHours`, one shared `GLOBEX_SESSION` instance referenced by every `ContractSpec`): Sunday 18:00 ET open, Friday 17:00 ET close, with a daily 17:00-18:00 ET maintenance break, the same for all 12 contracts (02g §4) -- confirmed against CME's own Gold Futures and Options fact card (Sunday 5pm-Friday 4pm CT with a 60-minute daily break, CT+1 hour = ET). A single shared constant rather than repeating the four times 12 times, since nothing here varies by product.
22. The exhaustive date sweep (Review Focus 3) cross-checks `futures.py` against an *independent* plain-Python business-day calculator driven by an explicit, hand-maintained 2026-2027 CME full-holiday list (`CME_HOLIDAYS_2026_27` in `test_futures.py`), not by re-reading the same `exchange_calendars` instance `futures.py` itself uses. That list (New Year's Day, Good Friday, and Christmas Day each year -- CME almost never closes fully; most other US holidays are early closes) was cross-checked against both `exchange_calendars`' own `CMES` calendar and a public source (financecalendar.com), which agree exactly. The sweep covers every contract month of 2026 and 2027 for all six families with no skips: `ai_trading.core.calendar`'s `exchange_calendars` instances are built over a fixed, explicit 2015-01-01..2030-12-31 range (Task 1c.4, Step 3) rather than `exchange_calendars`' own today-relative default, so a contract month years out never falls past the calendar's horizon and a result never depends on the day the suite happens to run. `test_calendar_horizon_reaches_2028` pins a 2028 business day so that horizon cannot quietly shrink back.

**The Desk Technical Bias (`core/bias.py`):**

23. A fully-unknown group's score is `math.nan`, and the summary is `math.nan` if either group's score is — not explicitly specified (02f §3 only covers "fewer than 250 bars" and "unknown indicator never votes"); chosen so a label is never fabricated from zero known votes. With the required 250-bar minimum this path is effectively unreachable except for data-shaped edge cases `indicators.py` already documents as NaN (e.g. `vwma`'s zero-volume window).
24. `bias()` takes a single `bars` DataFrame and reports only the bias as of its last row, not a full time series like `indicators.py`'s functions — matches 02f §3's point-in-time wording ("at each bar close", "a timeframe with fewer than 250 closed bars shows…"). A caller wanting the bias at every historical bar calls `bias()` on a growing window (see the `_bias_series` decision below).
25. `_bias_series` (the evaluator's per-strategy growing-window wrapper over `bias.bias()`) is `ponytail:`-flagged as O(n²) over the cadence's bar count. `bias()` only reports a point-in-time snapshot (decision 24), so a series means recomputing every vote from its own full history at each bar. Fine at today's bar counts (the golden template test uses ~260 bars, well under a second); the upgrade path is an incremental/rolling bias, which needs `bias.py` changes out of this phase's scope.
26. `Vote.values` is a small `dict[str, float]`, not a per-indicator dataclass: the 15 MA and 11 oscillator votes need to live in one `dict[str, Vote]` each for the Technicals page to iterate uniformly, and the indicators behind them have between one and four relevant numbers; a uniform dict avoids 15 one-off dataclasses for no behavioral gain.
27. No `THIRD_PARTY_NOTICES.md` entry for `bias.py`: it re-implements TradingView's published *rules*, not code, over this project's own `indicators.py` outputs.

**Contract and evaluator (`strategy-spec-v1.ts`, `evaluate.py`):**

28. CCI/Momentum/Williams %R/VWMA/Hull MA extend the pre-existing `sma|ema|rsi|atr` + `length` series-block shape, rather than getting their own one-field object each — they all take a single `length` with no other parameters, so this is additive and avoids five near-duplicate Pydantic classes for the exact same shape.
29. Every new length/smoothing field is bound `2..500` (`1..500` for `smoothK`/`smoothD`, the one place a value of 1 is meaningful — no smoothing), reusing the existing generic bound rather than inventing a tighter bound per field.
30. `label()`'s evidence key joins *every* extra operand field, in whatever order the generated Pydantic model's `model_dump()` produces for that operand -- `label()` does not sort anything itself. Today that order happens to be alphabetical by key name, an artifact of the datamodel-code-generator toolchain rather than something this function guarantees; `test_label_evidence_key_pins_the_schema_order` pins the exact key (`"macd(12, line, 9, 26)"`) so a silent change in that order is caught here. Old operands produce byte-identical keys (`"sma(20)"`, `"rvol(10)"`, …) since they only ever had one extra field.
31. **The resampler bins by phase-aligned timestamp, not row position, and a bin closes once its window has fully elapsed as of `as_of`** (`bin_end <= as_of`), not once it happens to hold `minutes` rows. Binning by row count (counting the 1-minute bars actually present) lets a data provider's missing minute -- providers commonly omit minutes with no trades, rather than sending an explicit empty bar -- shift a later bin's bar into the wrong bin. `_resample` now takes `as_of` as a fourth argument; a bin with zero bars is never emitted (falls out of `groupby` for free), and a forming bin is never exposed. Pinned by `test_bar_close_5m_a_missing_minute_does_not_let_the_next_bin_be_swallowed`.

## Review Focus

1. **Indicator warm-up and NaN.** An indicator used before it has enough bars must read as unknown, never a fabricated number — including the shared `_true_range()`/`atr()` refactor and the ten new oscillators built on it. Pinned by `test_indicators_1c.py`'s `NaN until N bars` assertions (Tasks 1c.1–1c.2) and `test_bias.py`'s per-rule "unknown value never votes" tests (Task 1c.5).
2. **Label boundaries at exactly ±0.1 and ±0.5, and ADX's rule.** An off-by-epsilon here silently mislabels every bias reading; a flipped vote condition silently double-counts or drops the opposite side. Pinned by `test_bias.py`'s `test_label_*` boundary tests (`-0.5` is Sell, `-0.500001` is Strong Sell; `0.1` is Neutral, `0.100001` is Buy — confirmed against TradingView's Technical Ratings page) and the ADX vote tests (`test_adx_vote_sell_minus_di_above_and_adx_falling_above_20`, `test_adx_vote_no_sell_when_adx_is_rising`, and the exactly-20/flat boundary tests — see Decision 1) (Task 1c.5).
3. **Last-trade, first-notice, and roll dates around holidays and weekends, with no dependency on the day the suite runs.** A wrong date keeps sizing or indicators reading a contract past its liquidity window, or rolls a physically settled contract too late; a calendar whose horizon drifts with the wall clock would make the same test pass today and fail next year. Pinned by `test_futures.py`'s `test_cl_last_trade_when_the_25th_falls_on_a_weekend` (Oct 25, 2026 is a Sunday), `test_cl_last_trade_when_the_25th_is_a_holiday` (Dec 25, 2026 is a CME holiday on a weekday), the golden `test_gc_mgc_december_2026_last_trade_first_notice_and_roll` and `test_cl_mcl_roll_is_five_business_days_before_last_trade` tests, the exhaustive sweep over every contract month of 2026 and 2027 for all six families against an independent business-day calculator, and `test_calendar_horizon_reaches_2028` pinning the fixed calendar range itself (Task 1c.4).
4. **Resampling never exposes a still-forming bar, and a missing minute never shifts a later bar into the wrong bin.** A `bar_close_5m/15m/1h` bin must not be read as closed before every 1-minute bar that could join it has closed, and binning by row position would let a gap in the data swallow a later bin's bar — both repaint/correctness risks unique to the new cadences. Pinned by `test_evaluate_1c.py`'s `test_bar_close_1h_never_exposes_a_still_forming_bar`, `test_bar_close_1h_never_spans_the_pre_to_regular_boundary`, and `test_bar_close_5m_a_missing_minute_does_not_let_the_next_bin_be_swallowed` (Task 1c.6).
5. **The evaluator's backward compatibility.** `_compute`, `label()`, and `_points` are rewritten additively; every pre-existing operand shape, cadence, and template must behave byte-identically. Pinned by the full pre-existing `test_evaluate.py` and `test_templates.py` suites staying green unmodified, `test_templates.py`'s generalized `test_never_repaints` lag computation (`CADENCE_MINUTES.get(...)`) covering the old `bar_close_1m` case exactly as before, and `test_label_evidence_key_pins_the_schema_order` pinning the exact evidence key `label()` builds for a multi-field operand (Task 1c.6).

All paths below are relative to `ai-trading/packages/family-desk/` unless they start with `ai-trading/`. Commands run in the directory a step names.

---

### Task 1c.1: Indicators, part 1 — oscillators

**Files:**
- Modify: `backend/src/ai_trading/core/indicators.py` (insertion), `THIRD_PARTY_NOTICES.md` (append one row)
- Create: `backend/tests/test_indicators_1c.py`

**Interfaces:**
- Consumes: `_wilder`, `sma`, `ema` (Phase 1).
- Produces (the bias in Task 1c.5 relies on all of these, plus `atr`'s refactor):
  - `_true_range(bars) -> pd.Series` (shared with `atr`, `adx`, and `ultimate_oscillator`)
  - `Macd(line, signal, histogram)`, `macd(close, fast=12, slow=26, signal=9) -> Macd`
  - `Stochastic(k, d)`, `stochastic(bars, length=14, smooth_k=3, smooth_d=3) -> Stochastic`
  - `StochRsi(k, d)`, `stoch_rsi(close, smooth_k=3, smooth_d=3, rsi_length=14, stoch_length=14) -> StochRsi`
  - `cci(bars, length=20) -> pd.Series`
  - `Adx(adx, plus_di, minus_di)`, `adx(bars, length=14) -> Adx`
  - `awesome_oscillator(bars, fast=5, slow=34) -> pd.Series`
  - `momentum(close, length=10) -> pd.Series`
  - `williams_r(bars, length=14) -> pd.Series`
  - `BullBearPower(bull, bear)`, `bull_bear_power(bars, length=13) -> BullBearPower`
  - `ultimate_oscillator(bars, fast=7, mid=14, slow=28) -> pd.Series`
- `atr(bars, length)` keeps its existing signature and values; its body is refactored onto `_true_range`.

- [ ] **Step 1: Write the failing test** `backend/tests/test_indicators_1c.py`:

```python
"""Golden-value tests for the Phase 1c indicator set (02f section 3). Values are checked by hand
(see each test's comment) and cross-checked offline against the `ta` library on a larger synthetic
fixture outside this repo (see REPORT-A.md); `ta`'s own warm-up and seeding conventions differ in
places noted below, so this file's golden values are this module's own arithmetic, not `ta`'s."""

import numpy as np
import pandas as pd

from ai_trading.core import indicators


def series(*values: float) -> pd.Series:
    return pd.Series(values, dtype=float)


def ohlc(high: list[float], low: list[float], close: list[float], volume: list[float] | None = None) -> pd.DataFrame:
    volume = volume if volume is not None else [1.0] * len(high)
    return pd.DataFrame({"high": high, "low": low, "close": close, "volume": volume}, dtype=float)


def test_macd_line_signal_and_histogram():
    # fast=2 (alpha 2/3), slow=4 (alpha 2/5), signal=2, by hand via the existing ema() recursion
    close = series(1, 2, 3, 4, 5, 6, 7, 8)
    m = indicators.macd(close, fast=2, slow=4, signal=2)
    np.testing.assert_allclose(m.line.to_numpy()[3:], [0.694519, 0.811773, 0.885418, 0.930702, 0.958238], atol=1e-6)
    assert m.line.iloc[:3].isna().all()  # NaN until `slow` (4) bars
    np.testing.assert_allclose(m.signal.to_numpy()[4:], [0.772688, 0.847841, 0.903082, 0.939853], atol=1e-6)
    assert m.signal.iloc[:4].isna().all()  # NaN until slow + signal - 1 = 5 bars
    np.testing.assert_allclose(m.histogram.to_numpy()[4:], [0.039085, 0.037577, 0.02762, 0.018386], atol=1e-6)


def test_stochastic_slow_k_and_d():
    # length=3, smooth_k=2, smooth_d=2. Raw %K by hand: 100*(close-lowestLow3)/(highestHigh3-lowestLow3)
    # = [40, 80, 60, 80] at bars 2-5; slow %K is its 2-bar SMA, %D the 2-bar SMA of that.
    bars = ohlc([12, 13, 11, 14, 13, 15], [8, 9, 9, 10, 10, 11], [10, 12, 10, 13, 12, 14])
    st = indicators.stochastic(bars, length=3, smooth_k=2, smooth_d=2)
    np.testing.assert_allclose(st.k.to_numpy()[3:], [60.0, 70.0, 70.0])
    assert st.k.iloc[:3].isna().all()  # NaN until length + smooth_k - 1 = 4 bars
    np.testing.assert_allclose(st.d.to_numpy()[4:], [65.0, 70.0])
    assert st.d.iloc[:4].isna().all()  # NaN until length + smooth_k + smooth_d - 2 = 5 bars


def test_stochastic_flat_range_is_50():
    bars = ohlc([10, 10, 10], [10, 10, 10], [10, 10, 10])
    st = indicators.stochastic(bars, length=2, smooth_k=1, smooth_d=1)
    assert st.k.iloc[-1] == 50.0 and st.d.iloc[-1] == 50.0


def test_stoch_rsi_k_and_d():
    # rsi_length=3, stoch_length=3, smooth_k=2, smooth_d=2. RSI (Wilder, length 3) on this close
    # series is [75, 54.545455, 75, 56.074766, 75] at bars 3-7 by hand; stochastic-of-RSI and its
    # double smoothing give the values below (matches the module's RSI arithmetic exactly).
    close = series(10, 11, 10, 12, 11, 13, 12, 14)
    sr = indicators.stoch_rsi(close, smooth_k=2, smooth_d=2, rsi_length=3, stoch_length=3)
    np.testing.assert_allclose(sr.k.to_numpy()[6:], [53.738318, 53.738318], atol=1e-5)
    assert sr.k.iloc[:6].isna().all()  # NaN until rsi_length + stoch_length + smooth_k - 2 = 6 bars
    np.testing.assert_allclose(sr.d.to_numpy()[7:], [53.738318], atol=1e-5)
    assert sr.d.iloc[:7].isna().all()  # NaN until +smooth_d - 1 more = 8 bars (the dataclass's minimum)


def test_cci_values_and_flat_window_is_zero():
    bars = ohlc([12, 13, 11, 14], [8, 9, 9, 10], [10, 12, 10, 13])
    out = indicators.cci(bars, length=3)
    np.testing.assert_allclose(out.to_numpy()[2:], [-50.0, 90.909091], atol=1e-5)
    assert out.iloc[:2].isna().all()  # NaN until `length` (3) bars
    flat = ohlc([10, 10, 10], [10, 10, 10], [10, 10, 10])
    assert indicators.cci(flat, length=3).iloc[-1] == 0.0


def test_adx_wilder_seeding_on_a_clean_uptrend():
    # length=2, a steady uptrend so -DM is always 0 and ADX should read 100 once it warms up.
    bars = ohlc([10, 12, 15, 19, 24], [9, 10, 12, 15, 19], [9.5, 11, 14, 18, 23])
    a = indicators.adx(bars, length=2)
    np.testing.assert_allclose(a.plus_di.to_numpy()[1:], [57.142857, 69.565217, 76.190476, 80.503145], atol=1e-5)
    assert (a.minus_di.to_numpy()[1:] == 0.0).all()
    assert a.plus_di.iloc[:1].isna().all()  # NaN until `length` (2) bars
    np.testing.assert_allclose(a.adx.to_numpy()[2:], [100.0, 100.0, 100.0])
    assert a.adx.iloc[:2].isna().all()  # NaN until 2*length - 1 = 3 bars


def test_awesome_oscillator():
    # fast=2, slow=3: SMA2 - SMA3 of the median price.
    bars = ohlc([12, 13, 11, 14], [8, 9, 9, 10], [10, 12, 10, 13])
    out = indicators.awesome_oscillator(bars, fast=2, slow=3)
    np.testing.assert_allclose(out.to_numpy()[2:], [0.166667, 0.0], atol=1e-5)
    assert out.iloc[:2].isna().all()  # NaN until `slow` (3) bars


def test_momentum():
    out = indicators.momentum(series(10, 12, 9, 14, 11), length=2)
    np.testing.assert_allclose(out.to_numpy()[2:], [-1.0, 2.0, 2.0])
    assert out.iloc[:2].isna().all()  # NaN until length + 1 = 3 bars


def test_williams_r_and_flat_range():
    bars = ohlc([12, 13, 11, 14], [8, 9, 9, 10], [10, 12, 10, 13])
    out = indicators.williams_r(bars, length=3)
    np.testing.assert_allclose(out.to_numpy()[2:], [-60.0, -20.0])
    assert out.iloc[:2].isna().all()  # NaN until `length` (3) bars
    flat = ohlc([10, 10, 10], [10, 10, 10], [10, 10, 10])
    assert indicators.williams_r(flat, length=3).iloc[-1] == -50.0


def test_bull_bear_power():
    # length=2 (EMA alpha 2/3) by hand via the existing ema() recursion.
    bars = ohlc([12, 13, 11, 14], [8, 9, 9, 10], [10, 12, 10, 13])
    out = indicators.bull_bear_power(bars, length=2)
    np.testing.assert_allclose(out.bull.to_numpy()[1:], [1.666667, 0.555556, 1.851852], atol=1e-5)
    np.testing.assert_allclose(out.bear.to_numpy()[1:], [-2.333333, -1.444444, -2.148148], atol=1e-5)
    assert out.bull.iloc[:1].isna().all()  # NaN until `length` (2) bars


def test_ultimate_oscillator():
    bars = ohlc([12, 13, 11, 14, 15], [8, 9, 9, 10, 11], [10, 12, 10, 13, 14])
    out = indicators.ultimate_oscillator(bars, fast=2, mid=3, slow=4)
    np.testing.assert_allclose(out.to_numpy()[3:], [59.406308, 70.562771], atol=1e-5)
    assert out.iloc[:3].isna().all()  # NaN until `slow` (4) bars
```

- [ ] **Step 2: Run it and watch it fail.**

Run (in `backend/`): `uv run pytest -q tests/test_indicators_1c.py`
Expected: 11 failed. The first collected test fails with `AttributeError: module 'ai_trading.core.indicators' has no attribute 'macd'`; the rest fail the same way against their own new name (`stochastic`, `stoch_rsi`, `cci`, `adx`, `awesome_oscillator`, `momentum`, `williams_r`, `bull_bear_power`, `ultimate_oscillator`).

- [ ] **Step 3: Add the `dataclasses` import.** In `backend/src/ai_trading/core/indicators.py`, replace:

```python
"""Indicators over bar series. Every value uses only its own and earlier bars."""

import numpy as np
import pandas as pd
```

with:

```python
"""Indicators over bar series. Every value uses only its own and earlier bars."""

from dataclasses import dataclass

import numpy as np
import pandas as pd
```

- [ ] **Step 4: Insert the oscillators.** In the same file, replace `atr()`'s body (keep nothing after it is replaced — the new block below both defines `_true_range` and redefines `atr` onto it):

```python
def atr(bars: pd.DataFrame, length: int) -> pd.Series:
    """Wilder's average true range."""
    prev_close = bars["close"].shift(1)
    true_range = pd.concat(
        [
            bars["high"] - bars["low"],
            (bars["high"] - prev_close).abs(),
            (bars["low"] - prev_close).abs(),
        ],
        axis=1,
    ).max(axis=1)
    return _wilder(true_range, length)
```

with:

```python
def _true_range(bars: pd.DataFrame) -> pd.Series:
    """max(high, prior close) - min(low, prior close): equal to the usual max(H-L, |H-PC|, |L-PC|),
    without a prior close (the first bar) this is just H-L."""
    prev_close = bars["close"].shift(1)
    upper = pd.concat([bars["high"], prev_close], axis=1).max(axis=1)
    lower = pd.concat([bars["low"], prev_close], axis=1).min(axis=1)
    return upper - lower


def atr(bars: pd.DataFrame, length: int) -> pd.Series:
    """Wilder's average true range."""
    return _wilder(_true_range(bars), length)


@dataclass(frozen=True)
class Macd:
    line: pd.Series
    signal: pd.Series
    histogram: pd.Series


def macd(close: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9) -> Macd:
    """MACD line (EMA(fast) - EMA(slow)), its signal line (EMA(signal) of the MACD line), and
    their difference. NaN until `slow` bars for the line, `slow + signal - 1` for the signal and
    histogram (34 for the default 12,26,9)."""
    line = ema(close, fast) - ema(close, slow)
    sig = ema(line, signal)
    return Macd(line, sig, line - sig)


@dataclass(frozen=True)
class Stochastic:
    k: pd.Series  # slow %K
    d: pd.Series


def stochastic(bars: pd.DataFrame, length: int = 14, smooth_k: int = 3, smooth_d: int = 3) -> Stochastic:
    """Slow %K (an SMA(smooth_k) of the raw %K) and %D (an SMA(smooth_d) of slow %K). Raw %K is
    100 x (close - lowestLow(length)) / (highestHigh(length) - lowestLow(length)), 50 when that
    range is zero. NaN until `length + smooth_k + smooth_d - 2` bars (18 for the default 14,3,3)."""
    lowest = bars["low"].rolling(length, min_periods=length).min()
    highest = bars["high"].rolling(length, min_periods=length).max()
    span = highest - lowest
    with np.errstate(divide="ignore", invalid="ignore"):
        raw_k = 100 * (bars["close"] - lowest) / span
    raw_k = raw_k.where(span != 0, 50.0)
    k = sma(raw_k, smooth_k)
    return Stochastic(k, sma(k, smooth_d))


@dataclass(frozen=True)
class StochRsi:
    k: pd.Series
    d: pd.Series


def stoch_rsi(
    close: pd.Series, smooth_k: int = 3, smooth_d: int = 3, rsi_length: int = 14, stoch_length: int = 14
) -> StochRsi:
    """A stochastic of Wilder's RSI(rsi_length) over its own `stoch_length`-bar range, scaled
    0-100 and smoothed into %K (SMA(smooth_k)) and %D (SMA(smooth_d) of %K). 50 when the RSI range
    is zero. NaN until `rsi_length + stoch_length + smooth_k + smooth_d - 2` bars (32 for the
    default 3,3,14,14)."""
    rsi_values = rsi(close, rsi_length)
    lowest = rsi_values.rolling(stoch_length, min_periods=stoch_length).min()
    highest = rsi_values.rolling(stoch_length, min_periods=stoch_length).max()
    span = highest - lowest
    with np.errstate(divide="ignore", invalid="ignore"):
        raw = 100 * (rsi_values - lowest) / span
    raw = raw.where(span != 0, 50.0)
    k = sma(raw, smooth_k)
    return StochRsi(k, sma(k, smooth_d))


def cci(bars: pd.DataFrame, length: int = 20) -> pd.Series:
    """(typical price - its SMA(length)) / (0.015 x the mean absolute deviation of the typical
    price from that SMA, over the same window). 0 when every bar in the window has the same
    typical price. NaN until `length` bars."""
    typical = (bars["high"] + bars["low"] + bars["close"]) / 3
    mean = sma(typical, length)
    mad = typical.rolling(length, min_periods=length).apply(lambda w: np.abs(w - w.mean()).mean(), raw=True)
    with np.errstate(divide="ignore", invalid="ignore"):
        out = (typical - mean) / (0.015 * mad)
    return out.where(mad != 0, 0.0)


@dataclass(frozen=True)
class Adx:
    adx: pd.Series
    plus_di: pd.Series
    minus_di: pd.Series


def adx(bars: pd.DataFrame, length: int = 14) -> Adx:
    """Wilder's ADX and +DI/-DI. NaN for +DI/-DI until `length` bars, and for ADX until
    `2 * length - 1` bars (27 for the default 14): +DI/-DI need `length` bars of Wilder-smoothed
    true range and directional movement, then ADX needs another `length` bars of DX to smooth.

    Adapted from Vibe-Trading `agent/src/skills/technical-basic/example_signal_engine.py`
    (`compute_adx`, commit d402c2d; MIT License, see THIRD_PARTY_NOTICES.md). Changes: this
    module's Wilder seeding rule (the mean of the first `length` valid values, via `_wilder`)
    instead of an EWM-only smoothing with no explicit seed.
    """
    high, low = bars["high"], bars["low"]
    up_move = high.diff()
    down_move = -low.diff()
    plus_dm = pd.Series(np.where((up_move > down_move) & (up_move > 0), up_move, 0.0), index=bars.index)
    minus_dm = pd.Series(np.where((down_move > up_move) & (down_move > 0), down_move, 0.0), index=bars.index)
    smoothed_tr = _wilder(_true_range(bars), length)
    smoothed_plus_dm = _wilder(plus_dm, length)
    smoothed_minus_dm = _wilder(minus_dm, length)
    with np.errstate(divide="ignore", invalid="ignore"):
        plus_di = 100 * smoothed_plus_dm / smoothed_tr
        minus_di = 100 * smoothed_minus_dm / smoothed_tr
        dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di)
    return Adx(_wilder(dx, length), plus_di, minus_di)


def awesome_oscillator(bars: pd.DataFrame, fast: int = 5, slow: int = 34) -> pd.Series:
    """SMA(fast) minus SMA(slow) of the median price (high + low) / 2. NaN until `slow` bars."""
    median_price = (bars["high"] + bars["low"]) / 2
    return sma(median_price, fast) - sma(median_price, slow)


def momentum(close: pd.Series, length: int = 10) -> pd.Series:
    """Close minus the close `length` bars ago. NaN until `length + 1` bars."""
    return close.diff(length)


def williams_r(bars: pd.DataFrame, length: int = 14) -> pd.Series:
    """-100 x (highestHigh(length) - close) / (highestHigh(length) - lowestLow(length)). -50 when
    that range is zero. NaN until `length` bars."""
    highest = bars["high"].rolling(length, min_periods=length).max()
    lowest = bars["low"].rolling(length, min_periods=length).min()
    span = highest - lowest
    with np.errstate(divide="ignore", invalid="ignore"):
        out = -100 * (highest - bars["close"]) / span
    return out.where(span != 0, -50.0)


@dataclass(frozen=True)
class BullBearPower:
    bull: pd.Series  # high - EMA(length)
    bear: pd.Series  # low - EMA(length)


def bull_bear_power(bars: pd.DataFrame, length: int = 13) -> BullBearPower:
    """High minus EMA(length) of the close (bull power), and low minus that same EMA (bear
    power). NaN until `length` bars."""
    baseline = ema(bars["close"], length)
    return BullBearPower(bars["high"] - baseline, bars["low"] - baseline)


def ultimate_oscillator(bars: pd.DataFrame, fast: int = 7, mid: int = 14, slow: int = 28) -> pd.Series:
    """Larry Williams' Ultimate Oscillator: a 4:2:1-weighted blend of buying pressure over true
    range (see `_true_range`) at three lookbacks, where buying pressure is the close minus the
    lesser of the low and the prior close. NaN until `slow` bars (28 for the default 7,14,28)."""
    prev_close = bars["close"].shift(1)
    lower = pd.concat([bars["low"], prev_close], axis=1).min(axis=1)
    buying_pressure = bars["close"] - lower
    true_range = _true_range(bars)

    def average(length: int) -> pd.Series:
        bp_sum = buying_pressure.rolling(length, min_periods=length).sum()
        tr_sum = true_range.rolling(length, min_periods=length).sum()
        return bp_sum / tr_sum.replace(0, np.nan)

    return 100 * (4 * average(fast) + 2 * average(mid) + average(slow)) / 7
```

`session_vwap` (the next function in the file) follows immediately after, unchanged.

- [ ] **Step 5: Add the attribution row.** Append this row to the Vibe-Trading table in `THIRD_PARTY_NOTICES.md`, right after the `levels.py` row:

```markdown
| `backend/src/ai_trading/core/indicators.py` (`adx`) | `agent/src/skills/technical-basic/example_signal_engine.py` (`compute_adx`), commit `d402c2d` | This module's Wilder seeding rule (mean of the first `length` valid values, via `_wilder`) instead of an EWM-only smoothing with no explicit seed |
```

- [ ] **Step 6: Run the tests and lint.**

Run (in `backend/`): `uv run pytest -q tests/test_indicators_1c.py && uv run ruff check . && uv run ruff format --check . && uv run pytest -q`
Expected: `11 passed`, ruff clean, then `180 passed`.

- [ ] **Step 7: Commit.**

```bash
git add ai-trading/packages/family-desk/backend/src/ai_trading/core/indicators.py ai-trading/packages/family-desk/backend/tests/test_indicators_1c.py ai-trading/packages/family-desk/THIRD_PARTY_NOTICES.md
git commit -m "feat(ai-trading): Desk oscillator indicators -- MACD, Stochastic, Stoch RSI, CCI, ADX, Awesome Oscillator, Momentum, Williams %R, Bull/Bear Power, Ultimate Oscillator"
```

### Task 1c.2: Indicators, part 2 — moving averages, Ichimoku, and ATR%

**Files:**
- Modify: `backend/src/ai_trading/core/indicators.py` (full file, now byte-identical to the end state), `backend/tests/test_indicators_1c.py` (append), `THIRD_PARTY_NOTICES.md` (append one row)

**Interfaces:**
- Consumes: `ema` (Phase 1), `atr` (Task 1c.1).
- Produces (the bias in Task 1c.5 relies on all of these):
  - `vwma(bars, length=20) -> pd.Series`
  - `_wma(values, length) -> pd.Series` (private; `hull_ma`'s building block)
  - `hull_ma(close, length=9) -> pd.Series`
  - `Ichimoku(conversion, base, span_a, span_b)`, `ichimoku(bars, conversion_length=9, base_length=26, span_b_length=52) -> Ichimoku`
  - `AtrPercent(pct, label)`, `atr_percent(bars, length=14, median_length=100) -> AtrPercent`

- [ ] **Step 1: Write the failing tests.** Append to `backend/tests/test_indicators_1c.py`:

```python
def test_vwma():
    bars = ohlc([1, 1, 1, 1], [1, 1, 1, 1], [10, 12, 14, 16], [100, 200, 100, 300])
    out = indicators.vwma(bars, length=2)
    np.testing.assert_allclose(out.to_numpy()[1:], [11.333333, 12.666667, 15.5], atol=1e-5)
    assert out.iloc[:1].isna().all()  # NaN until `length` (2) bars
    zero_volume = ohlc([1, 1], [1, 1], [10, 12], [0, 0])
    assert np.isnan(indicators.vwma(zero_volume, length=2).iloc[-1])


def test_hull_ma_on_a_straight_line():
    # on a perfectly linear series the Hull MA reproduces the series itself (a known identity).
    out = indicators.hull_ma(series(1, 2, 3, 4, 5, 6, 7), length=4)
    np.testing.assert_allclose(out.to_numpy()[4:], [5.0, 6.0, 7.0])
    assert out.iloc[:4].isna().all()  # NaN until length + round(sqrt(length)) - 1 = 5 bars


def test_ichimoku_no_look_ahead():
    # conversion_length=2, base_length=3, span_b_length=4: every value uses only bars up to it.
    bars = ohlc([12, 13, 11, 14, 15], [8, 9, 9, 10, 11], [10, 12, 10, 13, 14])
    ic = indicators.ichimoku(bars, conversion_length=2, base_length=3, span_b_length=4)
    np.testing.assert_allclose(ic.conversion.to_numpy()[1:], [10.5, 11.0, 11.5, 12.5])
    np.testing.assert_allclose(ic.base.to_numpy()[2:], [10.5, 11.5, 12.0])
    np.testing.assert_allclose(ic.span_a.to_numpy()[2:], [10.75, 11.5, 12.25])
    np.testing.assert_allclose(ic.span_b.to_numpy()[3:], [11.0, 12.0])
    assert ic.conversion.iloc[:1].isna().all()
    assert ic.base.iloc[:2].isna().all()
    assert ic.span_b.iloc[:3].isna().all()


def test_atr_percent_and_volatility_label():
    bars = ohlc(
        [10, 10.2, 10.1, 12, 10.15],
        [9.9, 10.0, 10.0, 9, 10.05],
        [10, 10.1, 10.05, 10, 10.1],
    )
    ap = indicators.atr_percent(bars, length=1, median_length=3)
    np.testing.assert_allclose(ap.pct.to_numpy(), [1.0, 1.980198, 0.995025, 30.0, 1.485149], atol=1e-5)
    assert list(ap.label) == [None, None, "normal", "high", "normal"]
```

- [ ] **Step 2: Run them and watch them fail.**

Run (in `backend/`): `uv run pytest -q tests/test_indicators_1c.py`
Expected: 4 failed (the 11 from Task 1c.1 still pass): `AttributeError: module 'ai_trading.core.indicators' has no attribute 'vwma'`, and the same for `hull_ma`, `ichimoku`, `atr_percent`.

- [ ] **Step 3: Implement.** This task finishes `indicators.py`: replace the whole file with (the import line now also needs `math`, used by `hull_ma`):

```python
"""Indicators over bar series. Every value uses only its own and earlier bars."""

import math
from dataclasses import dataclass

import numpy as np
import pandas as pd

from ai_trading.core.calendar import ET


def sma(values: pd.Series, length: int) -> pd.Series:
    return values.rolling(length, min_periods=length).mean()


def ema(values: pd.Series, length: int) -> pd.Series:
    return values.ewm(span=length, adjust=False, min_periods=length).mean()


def _wilder(values: pd.Series, length: int) -> pd.Series:
    """Wilder's smoothing, seeded by the mean of the first `length` valid values:
    avg_t = (avg_{t-1} * (length - 1) + x_t) / length for every later value."""
    valid = np.flatnonzero(values.notna().to_numpy())
    if len(valid) < length:
        return pd.Series(np.nan, index=values.index)
    seed_at = valid[length - 1]
    seeded = values.copy()
    seeded.iloc[:seed_at] = np.nan
    seeded.iloc[seed_at] = values.iloc[valid[:length]].mean()
    return seeded.ewm(alpha=1 / length, adjust=False).mean()


def rsi(close: pd.Series, length: int) -> pd.Series:
    """Wilder's RSI. 100 when there were no losses, 0 when there were no gains."""
    delta = close.diff()
    gain = _wilder(delta.clip(lower=0), length)
    loss = _wilder(-delta.clip(upper=0), length)
    with np.errstate(divide="ignore", invalid="ignore"):
        out = 100 - 100 / (1 + gain / loss)
    return out.where(~((gain == 0) & (loss == 0)), 50.0)


def _true_range(bars: pd.DataFrame) -> pd.Series:
    """max(high, prior close) - min(low, prior close): equal to the usual max(H-L, |H-PC|, |L-PC|),
    without a prior close (the first bar) this is just H-L."""
    prev_close = bars["close"].shift(1)
    upper = pd.concat([bars["high"], prev_close], axis=1).max(axis=1)
    lower = pd.concat([bars["low"], prev_close], axis=1).min(axis=1)
    return upper - lower


def atr(bars: pd.DataFrame, length: int) -> pd.Series:
    """Wilder's average true range."""
    return _wilder(_true_range(bars), length)


@dataclass(frozen=True)
class Macd:
    line: pd.Series
    signal: pd.Series
    histogram: pd.Series


def macd(close: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9) -> Macd:
    """MACD line (EMA(fast) - EMA(slow)), its signal line (EMA(signal) of the MACD line), and
    their difference. NaN until `slow` bars for the line, `slow + signal - 1` for the signal and
    histogram (34 for the default 12,26,9)."""
    line = ema(close, fast) - ema(close, slow)
    sig = ema(line, signal)
    return Macd(line, sig, line - sig)


@dataclass(frozen=True)
class Stochastic:
    k: pd.Series  # slow %K
    d: pd.Series


def stochastic(bars: pd.DataFrame, length: int = 14, smooth_k: int = 3, smooth_d: int = 3) -> Stochastic:
    """Slow %K (an SMA(smooth_k) of the raw %K) and %D (an SMA(smooth_d) of slow %K). Raw %K is
    100 x (close - lowestLow(length)) / (highestHigh(length) - lowestLow(length)), 50 when that
    range is zero. NaN until `length + smooth_k + smooth_d - 2` bars (18 for the default 14,3,3)."""
    lowest = bars["low"].rolling(length, min_periods=length).min()
    highest = bars["high"].rolling(length, min_periods=length).max()
    span = highest - lowest
    with np.errstate(divide="ignore", invalid="ignore"):
        raw_k = 100 * (bars["close"] - lowest) / span
    raw_k = raw_k.where(span != 0, 50.0)
    k = sma(raw_k, smooth_k)
    return Stochastic(k, sma(k, smooth_d))


@dataclass(frozen=True)
class StochRsi:
    k: pd.Series
    d: pd.Series


def stoch_rsi(
    close: pd.Series, smooth_k: int = 3, smooth_d: int = 3, rsi_length: int = 14, stoch_length: int = 14
) -> StochRsi:
    """A stochastic of Wilder's RSI(rsi_length) over its own `stoch_length`-bar range, scaled
    0-100 and smoothed into %K (SMA(smooth_k)) and %D (SMA(smooth_d) of %K). 50 when the RSI range
    is zero. NaN until `rsi_length + stoch_length + smooth_k + smooth_d - 2` bars (32 for the
    default 3,3,14,14)."""
    rsi_values = rsi(close, rsi_length)
    lowest = rsi_values.rolling(stoch_length, min_periods=stoch_length).min()
    highest = rsi_values.rolling(stoch_length, min_periods=stoch_length).max()
    span = highest - lowest
    with np.errstate(divide="ignore", invalid="ignore"):
        raw = 100 * (rsi_values - lowest) / span
    raw = raw.where(span != 0, 50.0)
    k = sma(raw, smooth_k)
    return StochRsi(k, sma(k, smooth_d))


def cci(bars: pd.DataFrame, length: int = 20) -> pd.Series:
    """(typical price - its SMA(length)) / (0.015 x the mean absolute deviation of the typical
    price from that SMA, over the same window). 0 when every bar in the window has the same
    typical price. NaN until `length` bars."""
    typical = (bars["high"] + bars["low"] + bars["close"]) / 3
    mean = sma(typical, length)
    mad = typical.rolling(length, min_periods=length).apply(lambda w: np.abs(w - w.mean()).mean(), raw=True)
    with np.errstate(divide="ignore", invalid="ignore"):
        out = (typical - mean) / (0.015 * mad)
    return out.where(mad != 0, 0.0)


@dataclass(frozen=True)
class Adx:
    adx: pd.Series
    plus_di: pd.Series
    minus_di: pd.Series


def adx(bars: pd.DataFrame, length: int = 14) -> Adx:
    """Wilder's ADX and +DI/-DI. NaN for +DI/-DI until `length` bars, and for ADX until
    `2 * length - 1` bars (27 for the default 14): +DI/-DI need `length` bars of Wilder-smoothed
    true range and directional movement, then ADX needs another `length` bars of DX to smooth.

    Adapted from Vibe-Trading `agent/src/skills/technical-basic/example_signal_engine.py`
    (`compute_adx`, commit d402c2d; MIT License, see THIRD_PARTY_NOTICES.md). Changes: this
    module's Wilder seeding rule (the mean of the first `length` valid values, via `_wilder`)
    instead of an EWM-only smoothing with no explicit seed.
    """
    high, low = bars["high"], bars["low"]
    up_move = high.diff()
    down_move = -low.diff()
    plus_dm = pd.Series(np.where((up_move > down_move) & (up_move > 0), up_move, 0.0), index=bars.index)
    minus_dm = pd.Series(np.where((down_move > up_move) & (down_move > 0), down_move, 0.0), index=bars.index)
    smoothed_tr = _wilder(_true_range(bars), length)
    smoothed_plus_dm = _wilder(plus_dm, length)
    smoothed_minus_dm = _wilder(minus_dm, length)
    with np.errstate(divide="ignore", invalid="ignore"):
        plus_di = 100 * smoothed_plus_dm / smoothed_tr
        minus_di = 100 * smoothed_minus_dm / smoothed_tr
        dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di)
    return Adx(_wilder(dx, length), plus_di, minus_di)


def awesome_oscillator(bars: pd.DataFrame, fast: int = 5, slow: int = 34) -> pd.Series:
    """SMA(fast) minus SMA(slow) of the median price (high + low) / 2. NaN until `slow` bars."""
    median_price = (bars["high"] + bars["low"]) / 2
    return sma(median_price, fast) - sma(median_price, slow)


def momentum(close: pd.Series, length: int = 10) -> pd.Series:
    """Close minus the close `length` bars ago. NaN until `length + 1` bars."""
    return close.diff(length)


def williams_r(bars: pd.DataFrame, length: int = 14) -> pd.Series:
    """-100 x (highestHigh(length) - close) / (highestHigh(length) - lowestLow(length)). -50 when
    that range is zero. NaN until `length` bars."""
    highest = bars["high"].rolling(length, min_periods=length).max()
    lowest = bars["low"].rolling(length, min_periods=length).min()
    span = highest - lowest
    with np.errstate(divide="ignore", invalid="ignore"):
        out = -100 * (highest - bars["close"]) / span
    return out.where(span != 0, -50.0)


@dataclass(frozen=True)
class BullBearPower:
    bull: pd.Series  # high - EMA(length)
    bear: pd.Series  # low - EMA(length)


def bull_bear_power(bars: pd.DataFrame, length: int = 13) -> BullBearPower:
    """High minus EMA(length) of the close (bull power), and low minus that same EMA (bear
    power). NaN until `length` bars."""
    baseline = ema(bars["close"], length)
    return BullBearPower(bars["high"] - baseline, bars["low"] - baseline)


def ultimate_oscillator(bars: pd.DataFrame, fast: int = 7, mid: int = 14, slow: int = 28) -> pd.Series:
    """Larry Williams' Ultimate Oscillator: a 4:2:1-weighted blend of buying pressure over true
    range (see `_true_range`) at three lookbacks, where buying pressure is the close minus the
    lesser of the low and the prior close. NaN until `slow` bars (28 for the default 7,14,28)."""
    prev_close = bars["close"].shift(1)
    lower = pd.concat([bars["low"], prev_close], axis=1).min(axis=1)
    buying_pressure = bars["close"] - lower
    true_range = _true_range(bars)

    def average(length: int) -> pd.Series:
        bp_sum = buying_pressure.rolling(length, min_periods=length).sum()
        tr_sum = true_range.rolling(length, min_periods=length).sum()
        return bp_sum / tr_sum.replace(0, np.nan)

    return 100 * (4 * average(fast) + 2 * average(mid) + average(slow)) / 7


def vwma(bars: pd.DataFrame, length: int = 20) -> pd.Series:
    """Volume-weighted moving average of the close. NaN until `length` bars, or wherever the
    window's total volume is zero."""
    pv_sum = (bars["close"] * bars["volume"]).rolling(length, min_periods=length).sum()
    vol_sum = bars["volume"].rolling(length, min_periods=length).sum()
    return pv_sum / vol_sum.replace(0, np.nan)


def _wma(values: pd.Series, length: int) -> pd.Series:
    """Linearly weighted moving average: the most recent bar weighs `length`, the oldest weighs 1."""
    weights = np.arange(1, length + 1)
    return values.rolling(length, min_periods=length).apply(lambda w: np.dot(w, weights) / weights.sum(), raw=True)


def hull_ma(close: pd.Series, length: int = 9) -> pd.Series:
    """Hull moving average: WMA(2 x WMA(close, length // 2) - WMA(close, length), round(sqrt(length))).
    NaN until `length + round(sqrt(length)) - 1` bars (11 for the default 9)."""
    half = max(1, length // 2)
    root = max(1, round(math.sqrt(length)))
    raw = 2 * _wma(close, half) - _wma(close, length)
    return _wma(raw, root)


@dataclass(frozen=True)
class Ichimoku:
    conversion: pd.Series  # tenkan-sen
    base: pd.Series  # kijun-sen
    span_a: pd.Series  # senkou span A
    span_b: pd.Series  # senkou span B


def ichimoku(
    bars: pd.DataFrame, conversion_length: int = 9, base_length: int = 26, span_b_length: int = 52
) -> Ichimoku:
    """Conversion (tenkan-sen) and base (kijun-sen) lines, each the midpoint of the highest high
    and lowest low over its own length, and leading spans A (midpoint of conversion and base) and
    B (the same midpoint over `span_b_length`) -- all as they stand at each bar, with no forward
    shift. A traditional chart plots a leading span `base_length` bars ahead of the bar it was
    computed from, so a chart's value at bar t + base_length is this function's span_a/span_b
    value at bar t; shifting is left to the chart, so this never exposes an unclosed future bar as
    the "current" value. NaN until `conversion_length`, `base_length`, and `span_b_length` bars
    respectively (span_a needs `base_length`, the larger of the two).

    Adapted from Vibe-Trading `agent/src/skills/ichimoku/example_signal_engine.py`
    (`_donchian_mid`, commit d402c2d; MIT License, see THIRD_PARTY_NOTICES.md). Changes: no
    forward displacement, and conversion/base/span_a/span_b values only, no TK-cross signal.
    """

    def donchian_mid(length: int) -> pd.Series:
        highest = bars["high"].rolling(length, min_periods=length).max()
        lowest = bars["low"].rolling(length, min_periods=length).min()
        return (highest + lowest) / 2

    conversion = donchian_mid(conversion_length)
    base = donchian_mid(base_length)
    return Ichimoku(conversion, base, (conversion + base) / 2, donchian_mid(span_b_length))


@dataclass(frozen=True)
class AtrPercent:
    pct: pd.Series  # ATR(length) / close * 100
    label: pd.Series  # "low", "normal", "high", or None until the median is known


def atr_percent(bars: pd.DataFrame, length: int = 14, median_length: int = 100) -> AtrPercent:
    """ATR(length) as a percent of the close, and a volatility label against its own trailing
    `median_length`-bar median: "low" below 0.8x that median, "high" above 1.25x, "normal"
    otherwise. The label is None until the median is known. NaN/None until
    `length + median_length - 1` bars (113 for the default 14,100)."""
    pct = atr(bars, length) / bars["close"] * 100
    median = pct.rolling(median_length, min_periods=median_length).median()
    labels = np.select([pct < 0.8 * median, pct > 1.25 * median], ["low", "high"], default="normal")
    return AtrPercent(pct, pd.Series(labels, index=bars.index, dtype=object).where(median.notna(), None))


def session_vwap(ann: pd.DataFrame) -> pd.Series:
    """VWAP of each day's regular session; NaN outside regular hours. `ann` comes from annotate()."""
    regular = ann[ann["phase"] == "regular"]
    typical = (regular["high"] + regular["low"] + regular["close"]) / 3
    weighted = (typical * regular["volume"]).groupby(regular["day"]).cumsum()
    volume = regular["volume"].groupby(regular["day"]).cumsum()
    return (weighted / volume.replace(0, np.nan)).reindex(ann.index)


def rvol_intraday(ann: pd.DataFrame, lookback_days: int) -> pd.Series:
    """Volume so far in this day's phase, over its average at the same clock time on the
    previous `lookback_days` days that have data. NaN until that much history exists."""
    cumulative = ann["volume"].groupby([ann["day"], ann["phase"]]).cumsum()
    key = pd.MultiIndex.from_arrays([ann["phase"], ann.index.tz_convert(ET).strftime("%H:%M")])
    table = (
        pd.Series(
            cumulative.to_numpy(),
            index=pd.MultiIndex.from_arrays([ann["day"], key.get_level_values(0), key.get_level_values(1)]),
        )
        .unstack([1, 2])
        .sort_index()
    )
    table = table.T.groupby(level=0).ffill().T
    baseline = table.shift(1).rolling(lookback_days, min_periods=lookback_days).mean()
    lookup = baseline.stack([0, 1], future_stack=True)
    rows = pd.MultiIndex.from_arrays([ann["day"], key.get_level_values(0), key.get_level_values(1)])
    expected = lookup.reindex(rows).to_numpy()
    with np.errstate(divide="ignore", invalid="ignore"):
        out = cumulative.to_numpy() / np.where(expected > 0, expected, np.nan)
    return pd.Series(out, index=ann.index)


def rvol_daily(daily: pd.DataFrame, lookback_days: int) -> pd.Series:
    """Each day's volume over the average of the previous `lookback_days` days."""
    expected = daily["volume"].shift(1).rolling(lookback_days, min_periods=lookback_days).mean()
    return daily["volume"] / expected.replace(0, np.nan)
```

- [ ] **Step 4: Add the attribution row.** Append this row to the Vibe-Trading table in `THIRD_PARTY_NOTICES.md`, right after the `adx` row added in Task 1c.1:

```markdown
| `backend/src/ai_trading/core/indicators.py` (`ichimoku`, helper `donchian_mid`) | `agent/src/skills/ichimoku/example_signal_engine.py` (`_donchian_mid`), commit `d402c2d` | No forward displacement (so a value never reflects an unclosed future bar); conversion/base/span_a/span_b values only, no TK-cross signal |
```

- [ ] **Step 5: Run the tests and lint.**

Run (in `backend/`): `uv run pytest -q tests/test_indicators_1c.py tests/test_indicators.py && uv run ruff check . && uv run ruff format --check . && uv run pytest -q`
Expected: `22 passed` (15 + the 7 pre-existing `test_indicators.py`, unaffected), ruff clean, then `184 passed`.

- [ ] **Step 6: Commit.**

```bash
git add ai-trading/packages/family-desk/backend/src/ai_trading/core/indicators.py ai-trading/packages/family-desk/backend/tests/test_indicators_1c.py ai-trading/packages/family-desk/THIRD_PARTY_NOTICES.md
git commit -m "feat(ai-trading): Desk VWMA, Hull MA, Ichimoku, and ATR-percent indicators (Ichimoku adapted from Vibe-Trading)"
```

### Task 1c.3: Pivots

**Files:**
- Create: `backend/src/ai_trading/core/pivots.py`, `backend/tests/test_pivots.py`

**Interfaces:**
- Consumes: `levels.prior_day` (Phase 1).
- Produces (the contract wiring in Task 1c.6 relies on these):
  - `Period = Literal["session", "week", "month"]`
  - `prior_period_hlc(daily, days, asset, period) -> tuple[pd.Series, pd.Series, pd.Series]` (high, low, close)
  - `classic_pivots[T: (float, pd.Series)](high: T, low: T, close: T) -> dict[str, T]`
  - `fibonacci_pivots[T: (float, pd.Series)](high: T, low: T, close: T) -> dict[str, T]`
  - `camarilla_pivots[T: (float, pd.Series)](high: T, low: T, close: T) -> dict[str, T]`
  - each dict has keys `"P"`, `"R1"`, `"R2"`, `"R3"`, `"S1"`, `"S2"`, `"S3"`

- [ ] **Step 1: Write the failing test** `backend/tests/test_pivots.py`:

```python
from datetime import date

import numpy as np
import pandas as pd
import pytest
from bars import daily_bars, trading_days

from ai_trading.core import pivots

# A single fixed prior period (checked by hand and cross-checked offline against finta's PIVOT
# and pandas_ta's pivot_fibonacci/pivot_camarilla; see the report for the largest difference).
HIGH, LOW, CLOSE = 110.0, 100.0, 105.0


def test_classic_pivots():
    out = pivots.classic_pivots(HIGH, LOW, CLOSE)
    assert out == {"P": 105.0, "R1": 110.0, "S1": 100.0, "R2": 115.0, "S2": 95.0, "R3": 120.0, "S3": 90.0}


def test_fibonacci_pivots():
    out = pivots.fibonacci_pivots(HIGH, LOW, CLOSE)
    assert out == {
        "P": 105.0,
        "R1": pytest.approx(108.82),
        "S1": pytest.approx(101.18),
        "R2": pytest.approx(111.18),
        "S2": pytest.approx(98.82),
        "R3": 115.0,
        "S3": 95.0,
    }


def test_camarilla_pivots():
    out = pivots.camarilla_pivots(HIGH, LOW, CLOSE)
    assert out["P"] == 105.0
    np.testing.assert_allclose(out["R1"], 105.0 + 10 * 1.1 / 12)
    np.testing.assert_allclose(out["S1"], 105.0 - 10 * 1.1 / 12)
    np.testing.assert_allclose(out["R2"], 105.0 + 10 * 1.1 / 6)
    np.testing.assert_allclose(out["S2"], 105.0 - 10 * 1.1 / 6)
    np.testing.assert_allclose(out["R3"], 107.75)
    np.testing.assert_allclose(out["S3"], 102.25)


def test_pivots_vectorize_over_a_series():
    high = pd.Series([HIGH, HIGH + 10])
    low = pd.Series([LOW, LOW])
    close = pd.Series([CLOSE, CLOSE])
    out = pivots.classic_pivots(high, low, close)
    assert isinstance(out["P"], pd.Series)
    np.testing.assert_allclose(out["P"], [105.0, 108.333333], rtol=1e-6)


def test_prior_session_is_the_prior_trading_day():
    daily = daily_bars([date(2026, 11, 24), date(2026, 11, 25)], [101.0, 102.0])
    days = pd.Index([date(2026, 11, 27)])  # Thanksgiving Thursday skipped
    high, low, close = pivots.prior_period_hlc(daily, days, "stock", "session")
    assert high.iloc[0] == low.iloc[0] == close.iloc[0] == 102.0


def test_prior_week_spans_the_calendar_week_before():
    days = trading_days("stock", date(2026, 10, 30), 15)  # Oct 12 .. Oct 30, 2026
    daily = daily_bars(days, [float(n) for n in range(1, 16)])
    high, low, close = pivots.prior_period_hlc(daily, pd.Index([date(2026, 11, 2)]), "stock", "week")
    # the prior week (Mon Oct 26 .. Fri Oct 30) has closes 11..15
    assert (high.iloc[0], low.iloc[0], close.iloc[0]) == (15.0, 11.0, 15.0)


def test_prior_month_spans_the_calendar_month_before():
    days = trading_days("stock", date(2026, 10, 30), 15)  # all of October 2026
    daily = daily_bars(days, [float(n) for n in range(1, 16)])
    high, low, close = pivots.prior_period_hlc(daily, pd.Index([date(2026, 11, 2)]), "stock", "month")
    assert (high.iloc[0], low.iloc[0], close.iloc[0]) == (15.0, 1.0, 15.0)


def test_prior_week_is_nan_without_a_bar_in_that_week():
    daily = daily_bars([date(2026, 10, 6)], [100.0])  # one lone Tuesday bar
    high, _, _ = pivots.prior_period_hlc(daily, pd.Index([date(2026, 10, 6)]), "stock", "week")
    assert np.isnan(high.iloc[0])
```

- [ ] **Step 2: Run it and watch it fail.**

Run (in `backend/`): `uv run pytest -q tests/test_pivots.py`
Expected: collection error, `ModuleNotFoundError: No module named 'ai_trading.core.pivots'`.

- [ ] **Step 3: Implement** `backend/src/ai_trading/core/pivots.py`:

```python
"""Classic, Fibonacci, and Camarilla pivots from a prior completed period's high, low, and close.

02f §3: intraday timeframes use the prior session, 1D the prior week, 1W the prior month. The
pivot formulas work on a float or a `pd.Series` of the same shape alike, since they are plain
arithmetic on `high`, `low`, and `close`.
"""

from datetime import date, timedelta
from typing import Literal

import pandas as pd

from ai_trading.core import levels
from ai_trading.core.calendar import Asset

Period = Literal["session", "week", "month"]


def _week_start(day: date) -> date:
    return day - timedelta(days=day.weekday())


def _month_start(day: date) -> date:
    return day.replace(day=1)


def _prior_period_start(day: date, period: Period) -> date:
    if period == "week":
        return _week_start(day) - timedelta(days=7)
    previous_day_in_month_before = _month_start(day) - timedelta(days=1)
    return _month_start(previous_day_in_month_before)


def _period_hlc(daily: pd.DataFrame, period: Period) -> pd.DataFrame:
    """One row per calendar week or month, keyed by its start: the period's highest high, lowest
    low, and its last trading day's close. `daily` must be sorted oldest first."""
    starts = [_week_start(day) if period == "week" else _month_start(day) for day in daily.index]
    grouped = daily.groupby(starts)
    return pd.DataFrame({"high": grouped["high"].max(), "low": grouped["low"].min(), "close": grouped["close"].last()})


def prior_period_hlc(daily: pd.DataFrame, days: pd.Index, asset: Asset, period: Period) -> tuple[pd.Series, ...]:
    """The prior completed period's high, low, and close for each of `days`, from regular-session
    daily bars indexed by date (`levels.prior_day`'s convention). NaN wherever that period has no
    bar: no trading day old enough, or (for "week"/"month") a period with no bars at all.
    """
    if period == "session":
        return tuple(levels.prior_day(daily, days, asset, column) for column in ("high", "low", "close"))
    periods = _period_hlc(daily, period)
    prior_starts = [_prior_period_start(day, period) for day in days]
    aligned = periods.reindex(prior_starts)
    return tuple(pd.Series(aligned[column].to_numpy(), index=days, dtype=float) for column in ("high", "low", "close"))


def classic_pivots[T: (float, pd.Series)](high: T, low: T, close: T) -> dict[str, T]:
    """TradingView's "Classic" pivot type (see `pivots.py`'s module docstring for the offline
    cross-check): P = (H+L+C)/3; R1/S1 and R2/S2 mirror P by the prior range; R3/S3 extend from H
    and L through P.
    """
    pivot = (high + low + close) / 3
    rng = high - low
    return {
        "P": pivot,
        "R1": 2 * pivot - low,
        "S1": 2 * pivot - high,
        "R2": pivot + rng,
        "S2": pivot - rng,
        "R3": high + 2 * (pivot - low),
        "S3": low - 2 * (high - pivot),
    }


def fibonacci_pivots[T: (float, pd.Series)](high: T, low: T, close: T) -> dict[str, T]:
    """P = (H+L+C)/3; R1/S1, R2/S2, and R3/S3 offset P by 38.2%, 61.8%, and 100% of the prior
    range."""
    pivot = (high + low + close) / 3
    rng = high - low
    return {
        "P": pivot,
        "R1": pivot + 0.382 * rng,
        "S1": pivot - 0.382 * rng,
        "R2": pivot + 0.618 * rng,
        "S2": pivot - 0.618 * rng,
        "R3": pivot + rng,
        "S3": pivot - rng,
    }


def camarilla_pivots[T: (float, pd.Series)](high: T, low: T, close: T) -> dict[str, T]:
    """P = (H+L+C)/3, shown for the same reference as the other two methods, though Camarilla's
    own R/S levels offset the close (not P) by 1.1/12, 1.1/6, and 1.1/4 of the prior range."""
    pivot = (high + low + close) / 3
    rng = high - low
    return {
        "P": pivot,
        "R1": close + rng * 1.1 / 12,
        "S1": close - rng * 1.1 / 12,
        "R2": close + rng * 1.1 / 6,
        "S2": close - rng * 1.1 / 6,
        "R3": close + rng * 1.1 / 4,
        "S3": close - rng * 1.1 / 4,
    }
```

- [ ] **Step 4: Run the tests and lint.**

Run (in `backend/`): `uv run pytest -q tests/test_pivots.py && uv run ruff check . && uv run ruff format --check . && uv run pytest -q`
Expected: `8 passed`, ruff clean, then `192 passed`.

- [ ] **Step 5: Commit.**

```bash
git add ai-trading/packages/family-desk/backend/src/ai_trading/core/pivots.py ai-trading/packages/family-desk/backend/tests/test_pivots.py
git commit -m "feat(ai-trading): Desk classic/Fibonacci/Camarilla pivots from the prior session, week, or month"
```

### Task 1c.4: A fixed calendar horizon, then futures specs, last-trade/first-notice/roll dates, and the micro-first sizer

**Files:**
- Modify: `backend/src/ai_trading/core/calendar.py` (Phase 1 file; one anchored insertion), `backend/tests/test_calendar.py` (append one test)
- Create: `backend/src/ai_trading/core/futures.py`, `backend/tests/test_futures.py`
- Modify: `THIRD_PARTY_NOTICES.md` (append one row)

**Why `calendar.py` first:** `futures.py`'s date rules reach years into the future (a GC contract month's first notice day, or CL's look-back to the prior month's 25th, compound across a whole sweep of 2026-2027 contract months). `exchange_calendars.get_calendar(name)` with no explicit range defaults to a window relative to *today's* wall-clock date, so a far-future lookup that works today can start raising `DateOutOfBounds` next year, and a test suite's results would depend on which day it happened to run. Building the calendar over a fixed, explicit range removes that dependency everywhere it's used -- not just here, but for Phase 1d's settlement module too (Shared Interfaces), since it reads the same `core/calendar.py` XNYS sessions.

**Interfaces:**
- Consumes/modifies: `calendar._calendar` (Phase 1; still private, same return type, same two callers `session`/`previous_session` unchanged).
- Produces (from `calendar.py`): no new public names -- `_CALENDAR_START = "2015-01-01"`, `_CALENDAR_END = "2030-12-31"` are private constants; `session()`, `previous_session()`, `annotate()`, `et()` keep their existing signatures and behavior, just with more calendar built underneath them.
- Produces (from `futures.py`):
  - `MONTH_CODES: dict[int, str]` (1 -> "F" .. 12 -> "Z"), `PHYSICAL_ROLL_LEAD_DAYS = 5`
  - `GlobexHours(open_time, close_time)`, `GLOBEX_SESSION: GlobexHours` (one shared instance)
  - `ContractSpec(product, dollars_per_point, tick_size, dollars_per_tick, months, session)`
  - `SPECS: dict[str, ContractSpec]` for ES, MES, NQ, MNQ, RTY, M2K, YM, MYM, CL, MCL, GC, MGC -- every spec's `session` is `GLOBEX_SESSION`
  - `MICRO_OF: dict[str, str]`, `MINI_OF: dict[str, str]` (e.g. `MICRO_OF["ES"] == "MES"`)
  - `last_trade_date(product, contract_month) -> date` -- every product
  - `first_notice_date(product, contract_month) -> date` -- GC/MGC only; raises for other products
  - `roll_date(product, contract_month) -> date` -- every product
  - `front_month(product, as_of) -> date`
  - `FuturesSizing(symbol, contracts, risk_per_contract, mini_symbol, mini_note, reason)`
  - `size_futures(risk_usd, entry, stop, product) -> FuturesSizing`

**Date rules (owner ruling, 02g §4 review -- see Decisions 3-4):**
- Equity index: `last_trade_date` is the third Friday (CME's rule); `roll_date` is the Monday before it (4 calendar days earlier).
- CL/MCL: `last_trade_date` is 3 CME business days before the 25th of the prior month (4 if the 25th is not a business day; MCL one business day before CL); `roll_date` is `PHYSICAL_ROLL_LEAD_DAYS` (5) CME business days before `last_trade_date` -- CL/MCL no longer roll on their last trade date itself.
- GC/MGC: `last_trade_date` is the third-last business day of the delivery month; `first_notice_date` is the last business day of the month before; `roll_date` is `PHYSICAL_ROLL_LEAD_DAYS` (5) CME business days before `first_notice_date`.
- One roll rule for every physically settled product (CL, MCL, GC, MGC): `PHYSICAL_ROLL_LEAD_DAYS` business days before its delivery deadline -- `last_trade_date` for CL/MCL, `first_notice_date` for GC/MGC.

- [ ] **Step 1: Write the failing calendar-horizon test.** Append to `backend/tests/test_calendar.py`, right before `test_previous_session_skips_weekends_and_holidays`:

```python
def test_calendar_horizon_reaches_2028():
    # The underlying exchange_calendars instances are built over a fixed, explicit range
    # (2015-01-01 to 2030-12-31), not exchange_calendars' own today-relative default, so a date
    # years out stays available and stays the same no matter what day this test runs. If the
    # range ever quietly shrinks back to a today-relative default, this pin catches it immediately
    # rather than letting a far-future lookup (e.g. a futures contract month) start failing later.
    found = session("stock", date(2028, 6, 15))
    assert found.regular_open == utc("2028-06-15 13:30")
    assert session("future", date(2028, 6, 15)) is not None
```

- [ ] **Step 2: Run it and watch it fail.**

Run (in `backend/`): `uv run pytest -q tests/test_calendar.py::test_calendar_horizon_reaches_2028`
Expected: `exchange_calendars.errors.DateOutOfBounds: Parameter \`date\` receieved as '2028-06-15 00:00:00' although cannot be later than the last session of calendar 'XNYS' (...)` -- the exact far-future failure this task fixes.

- [ ] **Step 3: Fix the calendar's range.** In `backend/src/ai_trading/core/calendar.py`, replace:

```python
@cache
def _calendar(asset: Asset) -> xcals.ExchangeCalendar:
    return xcals.get_calendar("XNYS" if asset == "stock" else "CMES")
```

with:

```python
#: A fixed, explicit range (not `exchange_calendars`' default, which is relative to today and
#: drifts as the wall clock advances) so every result -- including a futures contract month years
#: out -- stays the same no matter when this runs. 2015-01-01 covers everything this project
#: looks up historically; 2030-12-31 leaves more than four years of futures contract months ahead
#: of the Phase 1c cutoff date (2026-10-10).
_CALENDAR_START = "2015-01-01"
_CALENDAR_END = "2030-12-31"


@cache
def _calendar(asset: Asset) -> xcals.ExchangeCalendar:
    name = "XNYS" if asset == "stock" else "CMES"
    return xcals.get_calendar(name, start=_CALENDAR_START, end=_CALENDAR_END)
```

- [ ] **Step 4: Run the calendar tests and the full existing suite.**

Run (in `backend/`): `uv run pytest -q tests/test_calendar.py && uv run ruff check . && uv run ruff format --check . && uv run pytest -q`
Expected: `8 passed`, ruff clean, then `193 passed` (169 at the start of Phase 1c, plus Tasks 1c.1-1c.3's 23, plus this one new test) -- the range change touches no other test's expectations.

- [ ] **Step 5: Write the failing futures test** `backend/tests/test_futures.py`:

```python
"""Futures contract specs, last-trade/first-notice/roll dates, the front month, and the
micro-first sizer (02g §4).

The parametrized sweep below cross-checks `futures.py` against an *independent* business-day
calculator (plain Python, no `exchange_calendars`): `_is_business_day`/`_business_days_before`/
`_last_business_day_of_month`/`_nth_last_business_day_of_month` here, driven by an explicit,
hand-maintained CME full-holiday list for 2026-2027 (`CME_HOLIDAYS_2026_27`), not by reading the
same calendar library `futures.py` itself uses. Two independent implementations landing on the
same date for every contract month of 2026 and 2027, across all six contract families, is much
stronger evidence than one implementation agreeing with itself.

`CME_HOLIDAYS_2026_27` is CME Globex's full-day closures only (CME almost never closes all day;
most US holidays are early closes, not closures) -- cross-checked 2026-10-10 against
https://www.financecalendar.com/futures-market-holidays ("full closures in this period are
December 25, 2026, January 1, 2027, March 26, 2027 and December 24, 2027, with every other listed
date an early close rather than a full holiday") and against `exchange_calendars`' own `CMES`
calendar (same six dates). Early closes (Presidents Day, Memorial Day, Juneteenth, July 4,
Labor Day, Thanksgiving, the day after Thanksgiving, Christmas Eve) do not block a trading day
from counting as a CME business day for last-trade/roll arithmetic.

Spot-checked against public sources, 2026-10-10:
- GC/MGC "third last business day of the delivery month" and "first notice day is the last
  business day of the month before": CME Group's own Gold Futures and Options fact card and
  COMEX Rulebook Chapter 113 (113102.E, "Termination of Trading"), and independently
  discounttrading.com's contract-specs page (same two rules, same wording).
- The CME Globex session (Sunday 18:00 ET to Friday 17:00 ET, with a daily 17:00-18:00 ET
  maintenance break): CME's Gold Futures and Options fact card ("CME Globex: Sunday - 5:00 p.m. -
  Friday 4:00 p.m. CT with a 60-minute break each day beginning at 5:00 p.m."; CT+1 hour = ET).
- The equity-index third-Friday expiration and the CL/MCL 25th-of-the-prior-month rule are
  standard, widely published CME conventions; not separately spot-checked here.

The sweep below covers every contract month of 2026 and 2027 for all six families, with no skips:
`ai_trading.core.calendar`'s `exchange_calendars` instances are built over a fixed, explicit range
(2015-01-01 to 2030-12-31), not `exchange_calendars`' own today-relative default, so every date in
this file is independent of the day this test happens to run.
"""

from datetime import date, timedelta

import pytest

from ai_trading.core import futures

# --- an independent business-day calculator, for the parametrized sweep below -------------------

CME_HOLIDAYS_2026_27 = {
    date(2025, 12, 25),  # Christmas Day (CL/MCL's rule looks back into December for a January
    #                      contract month, so this one extra, uncontroversial date is needed too)
    date(2026, 1, 1),  # New Year's Day
    date(2026, 4, 3),  # Good Friday
    date(2026, 12, 25),  # Christmas Day
    date(2027, 1, 1),  # New Year's Day
    date(2027, 3, 26),  # Good Friday
    date(2027, 12, 24),  # Christmas Day (observed: Dec 25, 2027 is a Saturday)
}


def _is_business_day(d: date) -> bool:
    return d.weekday() < 5 and d not in CME_HOLIDAYS_2026_27


def _business_days_before(d: date, n: int) -> date:
    while n > 0:
        d -= timedelta(days=1)
        if _is_business_day(d):
            n -= 1
    return d


def _last_business_day_of_month(year: int, month: int) -> date:
    d = date(year, 12, 31) if month == 12 else date(year, month + 1, 1) - timedelta(days=1)
    while not _is_business_day(d):
        d -= timedelta(days=1)
    return d


def _nth_last_business_day_of_month(year: int, month: int, n: int) -> date:
    return _business_days_before(_last_business_day_of_month(year, month), n - 1)


def _third_friday(year: int, month: int) -> date:
    first = date(year, month, 1)
    first_friday = first + timedelta(days=(4 - first.weekday()) % 7)
    return first_friday + timedelta(days=14)


# --- golden, hand-pinned dates --------------------------------------------------------------


def test_es_mes_december_2026_last_trade_and_roll():
    assert futures.last_trade_date("ES", date(2026, 12, 1)) == date(2026, 12, 18)  # 3rd Friday
    assert futures.roll_date("ES", date(2026, 12, 1)) == date(2026, 12, 14)  # Monday
    assert futures.last_trade_date("MES", date(2026, 12, 1)) == date(2026, 12, 18)
    assert futures.roll_date("MES", date(2026, 12, 1)) == date(2026, 12, 14)


@pytest.mark.parametrize(
    ("month", "roll"),
    [
        (3, date(2027, 3, 15)),
        (6, date(2027, 6, 14)),
        (9, date(2027, 9, 13)),
        (12, date(2027, 12, 13)),
    ],
)
def test_2027_equity_index_quarterly_rolls(month, roll):
    assert futures.roll_date("NQ", date(2027, month, 1)) == roll  # the rule is the same for every pair
    assert futures.roll_date("YM", date(2027, month, 1)) == roll
    assert futures.roll_date("RTY", date(2027, month, 1)) == roll


def test_cl_last_trade_when_the_25th_falls_on_a_weekend():
    # Oct 25, 2026 is a Sunday, so the rule falls back to 4 business days before it
    assert futures.last_trade_date("CL", date(2026, 11, 1)) == date(2026, 10, 20)  # Tuesday
    assert futures.last_trade_date("MCL", date(2026, 11, 1)) == date(2026, 10, 19)  # one business day earlier


def test_cl_last_trade_when_the_25th_is_a_holiday():
    # Dec 25, 2026 (Christmas) is a CME holiday though a weekday, so the rule still falls back to 4
    assert futures.last_trade_date("CL", date(2027, 1, 1)) == date(2026, 12, 21)  # Monday
    assert futures.last_trade_date("MCL", date(2027, 1, 1)) == date(2026, 12, 18)


def test_cl_mcl_roll_is_five_business_days_before_last_trade():
    # Golden test for the uniform physically-settled roll rule (owner ruling, 02g §4 review):
    # CL/MCL now roll PHYSICAL_ROLL_LEAD_DAYS business days before their own last trade date,
    # not on the last trade date itself.
    last_trade = futures.last_trade_date("CL", date(2026, 11, 1))
    assert last_trade == date(2026, 10, 20)
    assert futures.roll_date("CL", date(2026, 11, 1)) == date(2026, 10, 13)  # 5 business days earlier
    mcl_last_trade = futures.last_trade_date("MCL", date(2026, 11, 1))
    assert mcl_last_trade == date(2026, 10, 19)
    assert futures.roll_date("MCL", date(2026, 11, 1)) == date(2026, 10, 12)


def test_gc_mgc_december_2026_last_trade_first_notice_and_roll():
    # Golden test for GC/MGC's dates and the uniform 5-business-day physical roll lead.
    assert futures.last_trade_date("GC", date(2026, 12, 1)) == date(2026, 12, 29)  # 3rd-last biz day of Dec
    assert futures.last_trade_date("MGC", date(2026, 12, 1)) == date(2026, 12, 29)
    assert futures.first_notice_date("GC", date(2026, 12, 1)) == date(2026, 11, 30)  # last biz day of Nov
    assert futures.first_notice_date("MGC", date(2026, 12, 1)) == date(2026, 11, 30)
    assert futures.roll_date("GC", date(2026, 12, 1)) == date(2026, 11, 23)  # 5 business days before Nov 30
    assert futures.roll_date("MGC", date(2026, 12, 1)) == date(2026, 11, 23)


def test_first_notice_date_is_only_defined_for_gc_mgc():
    with pytest.raises(ValueError, match="no first notice day"):
        futures.first_notice_date("ES", date(2026, 12, 1))
    with pytest.raises(ValueError, match="no first notice day"):
        futures.first_notice_date("CL", date(2026, 12, 1))


def test_a_symbol_with_a_month_code_resolves_to_its_product():
    assert futures.last_trade_date("MESZ6", date(2026, 12, 1)) == date(2026, 12, 18)
    assert futures.roll_date("ESZ26", date(2026, 12, 1)) == date(2026, 12, 14)


def test_front_month_switches_on_the_roll_date_not_the_last_trade_date():
    assert futures.front_month("ES", date(2026, 12, 13)) == date(2026, 12, 1)  # the Sunday before roll
    assert futures.front_month("ES", date(2026, 12, 14)) == date(2027, 3, 1)  # rolls Monday itself
    assert futures.front_month("ES", date(2026, 12, 18)) == date(2027, 3, 1)  # last trade day, already rolled


def test_an_unknown_symbol_is_rejected():
    with pytest.raises(ValueError, match="not one of the Desk's futures products"):
        futures._extract_product("ZC25")  # not one of the Desk's 12 products


# --- session hours, shared by every contract -------------------------------------------------


def test_globex_session_hours_shared_by_every_contract():
    assert futures.GLOBEX_SESSION.open_time == "18:00"  # Sunday ET
    assert futures.GLOBEX_SESSION.close_time == "17:00"  # Friday ET, and every day's break start
    for spec in futures.SPECS.values():
        assert spec.session is futures.GLOBEX_SESSION  # one shared constant, not 12 copies


# --- the sizer ---------------------------------------------------------------------------------


def test_sizer_prefers_the_micro_and_notes_the_mini():
    out = futures.size_futures(500, 6_820, 6_770, "MES")
    assert out.symbol == "MES"
    assert out.contracts == 2
    assert out.risk_per_contract == 250.0
    assert out.mini_symbol == "ES"
    assert out.mini_note == "one ES would risk $2,500"
    assert out.reason is None


def test_sizer_accepts_the_mini_symbol_and_still_sizes_the_micro():
    out = futures.size_futures(500, 6_820, 6_770, "ES")
    assert out.symbol == "MES"
    assert out.contracts == 2


def test_sizer_zero_contracts_comes_with_a_reason():
    out = futures.size_futures(100, 6_820, 6_770, "MES")  # $100 / $250 per micro rounds to 0
    assert out.contracts is None
    assert out.reason == "risk is too small for even one micro contract"


@pytest.mark.parametrize(
    ("risk_usd", "entry", "stop", "reason"),
    [
        (0.0, 6_820, 6_770, "risk is unknown or not positive"),
        (float("nan"), 6_820, 6_770, "risk is unknown or not positive"),
        (500, float("nan"), 6_770, "entry or stop is unknown"),
        (500, 6_820, 6_820, "stop equals entry"),
    ],
)
def test_sizer_no_order_and_why(risk_usd, entry, stop, reason):
    out = futures.size_futures(risk_usd, entry, stop, "MES")
    assert out.contracts is None and out.reason == reason


def test_sizer_rejects_a_product_with_no_micro_mini_pair():
    out = futures.size_futures(500, 6_820, 6_770, "ZC")
    assert out.contracts is None
    assert "not one of the Desk's futures products" in out.reason


# --- the exhaustive sweep: every contract month of 2026 and 2027, all six families -------------

_EQUITY_FAMILIES = [("ES", "MES"), ("NQ", "MNQ"), ("RTY", "M2K"), ("YM", "MYM")]
_EQUITY_MONTHS = (3, 6, 9, 12)
_YEARS = (2026, 2027)


@pytest.mark.parametrize("mini,micro", _EQUITY_FAMILIES)
@pytest.mark.parametrize("year", _YEARS)
@pytest.mark.parametrize("month", _EQUITY_MONTHS)
def test_equity_index_last_trade_and_roll_every_month_both_years(month, year, mini, micro):
    expected_last_trade = _third_friday(year, month)
    expected_roll = expected_last_trade - timedelta(days=4)
    for product in (mini, micro):
        assert futures.last_trade_date(product, date(year, month, 1)) == expected_last_trade
        assert futures.roll_date(product, date(year, month, 1)) == expected_roll


@pytest.mark.parametrize("year", _YEARS)
@pytest.mark.parametrize("month", range(1, 13))
def test_cl_mcl_last_trade_and_roll_every_month_both_years(month, year):
    contract_month = date(year, month, 1)
    prior_25th = date(year - 1, 12, 25) if month == 1 else date(year, month - 1, 25)
    n = 3 if _is_business_day(prior_25th) else 4
    expected_cl = _business_days_before(prior_25th, n)
    expected_mcl = _business_days_before(expected_cl, 1)
    assert futures.last_trade_date("CL", contract_month) == expected_cl
    assert futures.last_trade_date("MCL", contract_month) == expected_mcl
    assert futures.roll_date("CL", contract_month) == _business_days_before(expected_cl, 5)
    assert futures.roll_date("MCL", contract_month) == _business_days_before(expected_mcl, 5)


@pytest.mark.parametrize("year", _YEARS)
@pytest.mark.parametrize("month", futures.GOLD_MONTHS)
def test_gc_last_trade_first_notice_and_roll_every_listed_month_both_years(month, year):
    contract_month = date(year, month, 1)
    expected_last_trade = _nth_last_business_day_of_month(year, month, 3)
    before = date(year, month - 1, 1) if month > 1 else date(year - 1, 12, 1)
    expected_first_notice = _last_business_day_of_month(before.year, before.month)
    expected_roll = _business_days_before(expected_first_notice, 5)
    assert futures.last_trade_date("GC", contract_month) == expected_last_trade
    assert futures.first_notice_date("GC", contract_month) == expected_first_notice
    assert futures.roll_date("GC", contract_month) == expected_roll


@pytest.mark.parametrize("year", _YEARS)
@pytest.mark.parametrize("month", futures.MICRO_GOLD_MONTHS)
def test_mgc_last_trade_first_notice_and_roll_every_listed_month_both_years(month, year):
    contract_month = date(year, month, 1)
    expected_last_trade = _nth_last_business_day_of_month(year, month, 3)
    before = date(year, month - 1, 1) if month > 1 else date(year - 1, 12, 1)
    expected_first_notice = _last_business_day_of_month(before.year, before.month)
    expected_roll = _business_days_before(expected_first_notice, 5)
    assert futures.last_trade_date("MGC", contract_month) == expected_last_trade
    assert futures.first_notice_date("MGC", contract_month) == expected_first_notice
    assert futures.roll_date("MGC", contract_month) == expected_roll
```

- [ ] **Step 6: Run it and watch it fail.**

Run (in `backend/`): `uv run pytest -q tests/test_futures.py`
Expected: collection error, `ModuleNotFoundError: No module named 'ai_trading.core.futures'`.

- [ ] **Step 7: Implement** `backend/src/ai_trading/core/futures.py`:

```python
"""CME futures: contract specs, month codes, last-trade/first-notice/roll dates, the front month,
and the micro-first sizer for the 12 contracts the Desk trades (02g §4).

`SPECS`, `MONTH_CODES`, and `_extract_product` are adapted from Vibe-Trading
`agent/backtest/engines/global_futures.py` (commit d402c2df, MIT License, Copyright (c) 2026
Vibe-Trading Contributors; see THIRD_PARTY_NOTICES.md), modified to carry only the Desk's 12
contracts (no margins, no price limits, no commissions, no backtest engine), with dollars-per-tick,
listed months, and session hours added. The date functions, the front month, and the sizer are new.
"""

import math
import re
from dataclasses import dataclass
from datetime import date, timedelta

from ai_trading.core.calendar import Asset, previous_session, session

MONTH_CODES: dict[int, str] = {
    1: "F",
    2: "G",
    3: "H",
    4: "J",
    5: "K",
    6: "M",
    7: "N",
    8: "Q",
    9: "U",
    10: "V",
    11: "X",
    12: "Z",
}

EQUITY_INDEX_MONTHS = (3, 6, 9, 12)
EVERY_MONTH = tuple(range(1, 13))
# 02g research (futures-and-covered-call-facts.md §2): CME's commonly active gold months skip
# October even though it is listed; the micro trades it.
GOLD_MONTHS = (2, 4, 6, 8, 12)
MICRO_GOLD_MONTHS = (2, 4, 6, 8, 10, 12)

#: How many CME business days before their delivery deadline the Desk rolls a physically settled
#: contract (CL, MCL, GC, MGC) -- the deadline is `last_trade_date` for CL/MCL and
#: `first_notice_date` for GC/MGC (one roll rule for every physically settled product; owner
#: ruling, 02g §4 review). A work week of lead time keeps a swing position clear of delivery
#: without rolling the contract unreasonably early; no exchange mandates this exact number.
PHYSICAL_ROLL_LEAD_DAYS = 5


@dataclass(frozen=True)
class GlobexHours:
    """The CME Globex session every one of the Desk's 12 futures trades on (02g §4): opens Sunday
    at `open_time` ET, closes Friday at `close_time` ET, with a daily maintenance break from
    `close_time` to `open_time` ET every other trading day."""

    open_time: str  # "18:00" ET, Sunday through the week's open
    close_time: str  # "17:00" ET, the week's close and every day's maintenance-break start


#: One shared instance: every contract in `SPECS` trades the same Globex hours, so each
#: `ContractSpec` references this constant rather than repeating the times 12 times.
GLOBEX_SESSION = GlobexHours(open_time="18:00", close_time="17:00")


@dataclass(frozen=True)
class ContractSpec:
    product: str
    dollars_per_point: float
    tick_size: float
    dollars_per_tick: float
    months: tuple[int, ...]  # listed contract months, 1-12
    session: GlobexHours


SPECS: dict[str, ContractSpec] = {
    "ES": ContractSpec("ES", 50.0, 0.25, 12.50, EQUITY_INDEX_MONTHS, GLOBEX_SESSION),
    "MES": ContractSpec("MES", 5.0, 0.25, 1.25, EQUITY_INDEX_MONTHS, GLOBEX_SESSION),
    "NQ": ContractSpec("NQ", 20.0, 0.25, 5.00, EQUITY_INDEX_MONTHS, GLOBEX_SESSION),
    "MNQ": ContractSpec("MNQ", 2.0, 0.25, 0.50, EQUITY_INDEX_MONTHS, GLOBEX_SESSION),
    "RTY": ContractSpec("RTY", 50.0, 0.10, 5.00, EQUITY_INDEX_MONTHS, GLOBEX_SESSION),
    "M2K": ContractSpec("M2K", 5.0, 0.10, 0.50, EQUITY_INDEX_MONTHS, GLOBEX_SESSION),
    "YM": ContractSpec("YM", 5.0, 1.00, 5.00, EQUITY_INDEX_MONTHS, GLOBEX_SESSION),
    "MYM": ContractSpec("MYM", 0.50, 1.00, 0.50, EQUITY_INDEX_MONTHS, GLOBEX_SESSION),
    "CL": ContractSpec("CL", 1000.0, 0.01, 10.00, EVERY_MONTH, GLOBEX_SESSION),
    "MCL": ContractSpec("MCL", 100.0, 0.01, 1.00, EVERY_MONTH, GLOBEX_SESSION),
    "GC": ContractSpec("GC", 100.0, 0.10, 10.00, GOLD_MONTHS, GLOBEX_SESSION),
    "MGC": ContractSpec("MGC", 10.0, 0.10, 1.00, MICRO_GOLD_MONTHS, GLOBEX_SESSION),
}

#: Mini -> micro and its inverse, e.g. MICRO_OF["ES"] == "MES". A micro is one tenth of its mini
#: (02g §4), true of every `dollars_per_point` pair above.
MICRO_OF: dict[str, str] = {"ES": "MES", "NQ": "MNQ", "RTY": "M2K", "YM": "MYM", "CL": "MCL", "GC": "MGC"}
MINI_OF: dict[str, str] = {micro: mini for mini, micro in MICRO_OF.items()}

_EQUITY_INDEX = frozenset(("ES", "MES", "NQ", "MNQ", "RTY", "M2K", "YM", "MYM"))

_CONTRACT_SUFFIX_RE = re.compile(r"^(?:[FGHJKMNQUVXZ]\d{1,4}|\d{4})$")
_PRODUCTS_LONGEST_FIRST = tuple(sorted(SPECS, key=len, reverse=True))


def _extract_product(symbol: str) -> str:
    """The listed product `symbol` names, e.g. "MESZ6" or "ES.CME" -> "MES"/"ES".

    Adapted from Vibe-Trading's `_extract_product`: the shape-regex fallback for a product outside
    `SPECS` is dropped, since every product this Desk prices is listed here.

    Raises:
        ValueError: `symbol` does not name one of the Desk's 12 products.
    """
    code = symbol.split(".")[0].upper()
    if code in SPECS:
        return code
    for product in _PRODUCTS_LONGEST_FIRST:
        if code.startswith(product) and _CONTRACT_SUFFIX_RE.match(code[len(product) :]):
            return product
    raise ValueError(f"{symbol!r} is not one of the Desk's futures products")


def _shift_month(day: date, months: int) -> date:
    """The first of the month `months` months from `day`'s month (`day`'s own day of month is
    dropped)."""
    total = day.year * 12 + (day.month - 1) + months
    year, month = divmod(total, 12)
    return date(year, month + 1, 1)


def _n_business_days_before(asset: Asset, day: date, n: int) -> date:
    for _ in range(n):
        day = previous_session(asset, day)
    return day


def _last_business_day_of_month(year: int, month: int) -> date:
    return previous_session("future", _shift_month(date(year, month, 1), 1))


def _nth_last_business_day_of_month(year: int, month: int, n: int) -> date:
    """The `n`-th business day counting back from the last one (n=1 is the last business day
    itself, n=3 the third-last)."""
    return _n_business_days_before("future", _last_business_day_of_month(year, month), n - 1)


def _third_friday(year: int, month: int) -> date:
    first = date(year, month, 1)
    first_friday = first + timedelta(days=(4 - first.weekday()) % 7)
    return first_friday + timedelta(days=14)


def last_trade_date(product: str, contract_month: date) -> date:
    """The last day `product`'s `contract_month` contract trades (`contract_month` is the first
    of that month; the day of month is ignored): the third Friday for equity index (CME's rule);
    CL/MCL's rule (3 business days before the 25th of the prior month, 4 if the 25th is not a
    business day; MCL one business day before CL); the third-last business day of the delivery
    month for GC/MGC.
    """
    product = _extract_product(product)
    if product in _EQUITY_INDEX:
        return _third_friday(contract_month.year, contract_month.month)
    if product in ("CL", "MCL"):
        prior_25th = _shift_month(contract_month, -1).replace(day=25)
        n = 3 if session("future", prior_25th) is not None else 4
        last_trade = _n_business_days_before("future", prior_25th, n)
        return previous_session("future", last_trade) if product == "MCL" else last_trade
    if product in ("GC", "MGC"):
        return _nth_last_business_day_of_month(contract_month.year, contract_month.month, 3)
    raise ValueError(f"no last-trade rule for {product!r}")


def first_notice_date(product: str, contract_month: date) -> date:
    """GC/MGC's first notice day: the last business day of the month before `contract_month`
    (`contract_month` is the first of that month; the day of month is ignored). Only GC and MGC
    are physically settled with a first notice day distinct from their last trade date.
    """
    product = _extract_product(product)
    if product in ("GC", "MGC"):
        before = _shift_month(contract_month, -1)
        return _last_business_day_of_month(before.year, before.month)
    raise ValueError(f"{product!r} has no first notice day (not physically settled that way)")


def roll_date(product: str, contract_month: date) -> date:
    """The date the Desk treats `product`'s `contract_month` contract as no longer the front
    month: the Monday before the third Friday for equity index (CME's rule); `PHYSICAL_ROLL_LEAD_DAYS`
    CME business days before the delivery deadline for every physically settled product -- the
    last trade date for CL/MCL, the first notice date for GC/MGC (one roll rule for all four;
    owner ruling, 02g §4 review).
    """
    product = _extract_product(product)
    if product in _EQUITY_INDEX:
        return last_trade_date(product, contract_month) - timedelta(days=4)
    if product in ("CL", "MCL"):
        deadline = last_trade_date(product, contract_month)
    elif product in ("GC", "MGC"):
        deadline = first_notice_date(product, contract_month)
    else:
        raise ValueError(f"no roll rule for {product!r}")
    return _n_business_days_before("future", deadline, PHYSICAL_ROLL_LEAD_DAYS)


def front_month(product: str, as_of: date) -> date:
    """The contract month (first of month) that is `product`'s front month on `as_of`: the
    earliest listed month whose roll date has not yet passed on `as_of`."""
    product = _extract_product(product)
    months = SPECS[product].months
    cursor = _shift_month(date(as_of.year, as_of.month, 1), -14)
    end = _shift_month(date(as_of.year, as_of.month, 1), 14)
    while cursor <= end:
        if cursor.month in months and as_of < roll_date(product, cursor):
            return cursor
        cursor = _shift_month(cursor, 1)
    raise ValueError(f"no front month for {product!r} found near {as_of}")


@dataclass(frozen=True)
class FuturesSizing:
    symbol: str | None  # the micro contract sized, e.g. "MES"
    contracts: int | None
    risk_per_contract: float | None  # dollars one `symbol` contract risks
    mini_symbol: str | None
    mini_note: str | None  # e.g. "one ES would risk $2,500"
    reason: str | None  # why there is no order


def _format_usd(value: float) -> str:
    return f"${value:,.0f}"


def size_futures(risk_usd: float, entry: float, stop: float, product: str) -> FuturesSizing:
    """Sizes a futures swing in the micro of `product`'s mini/micro pair (02g §4's "it prefers
    micros"): contracts = floor(risk_usd / (|entry - stop| x the micro's dollars per point)), with
    what one mini contract would risk alongside as a size-up note. `product` may name either side
    of the pair. Zero contracts (the risk is too small for even one micro) comes with a reason.
    """

    def no(reason: str) -> FuturesSizing:
        return FuturesSizing(None, None, None, None, None, reason)

    try:
        extracted = _extract_product(product)
    except ValueError as exc:
        return no(str(exc))
    if extracted in MICRO_OF:
        micro = MICRO_OF[extracted]
    elif extracted in MINI_OF:
        micro = extracted
    else:
        return no(f"{extracted!r} has no micro/mini pair")
    mini = MINI_OF[micro]

    if not (math.isfinite(risk_usd) and risk_usd > 0):
        return no("risk is unknown or not positive")
    if not (math.isfinite(entry) and math.isfinite(stop)):
        return no("entry or stop is unknown")
    points = abs(entry - stop)
    if points <= 0:
        return no("stop equals entry")

    micro_spec, mini_spec = SPECS[micro], SPECS[mini]
    risk_per_contract = points * micro_spec.dollars_per_point
    contracts = math.floor(round(risk_usd / risk_per_contract, 9))
    if contracts < 1:
        return no("risk is too small for even one micro contract")

    mini_risk = points * mini_spec.dollars_per_point
    note = f"one {mini} would risk {_format_usd(mini_risk)}"
    return FuturesSizing(micro, contracts, risk_per_contract, mini, note, None)
```

- [ ] **Step 8: Add the attribution row.** Append this row to the Vibe-Trading table in `THIRD_PARTY_NOTICES.md`, right after the `ichimoku` row added in Task 1c.2:

```markdown
| `backend/src/ai_trading/core/futures.py` (`SPECS`, `MONTH_CODES`, `_extract_product`) | `agent/backtest/engines/global_futures.py` (`_MULTIPLIER`, `_extract_product`) | Only the Desk's 12 contracts (no margins, price limits, commissions, or backtest engine); dollars-per-tick, listed months, and session hours added |
```

- [ ] **Step 9: Run the tests and lint.**

Run (in `backend/`): `uv run pytest -q tests/test_futures.py && uv run ruff check . && uv run ruff format --check . && uv run pytest -q`
Expected: `100 passed`, no skips -- the parametrized sweep covers every contract month of 2026 and 2027 for all six families, and with the calendar's fixed range every one of them resolves -- ruff clean, then `293 passed`.

- [ ] **Step 10: Commit.**

```bash
git add ai-trading/packages/family-desk/backend/src/ai_trading/core/calendar.py ai-trading/packages/family-desk/backend/tests/test_calendar.py ai-trading/packages/family-desk/backend/src/ai_trading/core/futures.py ai-trading/packages/family-desk/backend/tests/test_futures.py ai-trading/packages/family-desk/THIRD_PARTY_NOTICES.md
git commit -m "fix(ai-trading): build the Desk calendar over a fixed 2015-2030 range; add futures contract specs, last-trade/first-notice/roll dates, and the micro-first sizer"
```

### Task 1c.5: The Desk Technical Bias

**Files:**
- Create: `backend/src/ai_trading/core/bias.py`, `backend/tests/test_bias.py`

**Interfaces:**
- Consumes: `indicators.sma`, `indicators.rsi`, `indicators.stochastic`, `indicators.cci`, `indicators.adx`, `indicators.awesome_oscillator`, `indicators.momentum`, `indicators.macd`, `indicators.stoch_rsi`, `indicators.williams_r`, `indicators.bull_bear_power`, `indicators.ultimate_oscillator`, `indicators.ema`, `indicators.vwma`, `indicators.hull_ma`, `indicators.ichimoku`, `indicators.atr_percent` (Tasks 1c.1-1c.2).
- Produces (the contract wiring in Task 1c.6 relies on these):
  - `MIN_BARS = 250`
  - `Action = Literal["Sell", "Neutral", "Buy"]`, `Label = Literal["Strong Sell", "Sell", "Neutral", "Buy", "Strong Buy"]`
  - `Vote(values: dict[str, float], action: Action | None)`
  - `VoteCounts(sell, neutral, buy)`
  - `Bias(oscillators, moving_averages, oscillator_counts, ma_counts, oscillator_score, ma_score, summary_score, oscillator_label, ma_label, summary_label, atr_pct, volatility_label)`
  - `label(score: float) -> Label | None`
  - `bias(bars: pd.DataFrame) -> Bias | Literal["warming up"]`
- `oscillators` keys: `rsi`, `stochastic`, `cci`, `adx`, `awesome_oscillator`, `momentum`, `macd`, `stoch_rsi`, `williams_r`, `bull_bear_power`, `ultimate_oscillator`. `moving_averages` keys: `sma_10..sma_200`, `ema_10..ema_200`, `vwma_20`, `hull_ma_9`, `ichimoku`.
- **ADX's rule (Decision 1):** Buy needs +DI > -DI, ADX > 20, and ADX rising. Sell needs +DI < -DI, ADX > 20, and ADX **falling** -- TradingView's Technical Ratings page (canonical; see Decision 1), not the Screener page's "rising" wording for Sell.

- [ ] **Step 1: Write the failing test** `backend/tests/test_bias.py`:

```python
"""Golden tests for the Desk Technical Bias (02f section 3): every vote rule at its boundaries,
the label thresholds at exactly +/-0.1 and +/-0.5, warming up, an unknown value that never votes,
and one end-to-end fixture shaped like the MOCK-SPECS.md NVDA 15m example."""

import math

import numpy as np
import pandas as pd

from ai_trading.core import bias
from ai_trading.core.indicators import Adx, BullBearPower, Ichimoku, Macd, Stochastic, StochRsi


def series(*values: float) -> pd.Series:
    return pd.Series(values, dtype=float)


def _flat_bars(n: int) -> pd.DataFrame:
    rng = np.random.default_rng(1)
    close = 100 + np.cumsum(rng.normal(0, 0.1, n))
    high = close + np.abs(rng.normal(0.2, 0.05, n))
    low = close - np.abs(rng.normal(0.2, 0.05, n))
    volume = rng.integers(500, 1500, n).astype(float)
    return pd.DataFrame({"high": high, "low": low, "close": close, "volume": volume})


# --- label() thresholds, exactly as 02f section 3's table -----------------------------------


def test_label_strong_sell_below_minus_half():
    assert bias.label(-0.500001) == "Strong Sell"


def test_label_sell_includes_minus_half():
    assert bias.label(-0.5) == "Sell"


def test_label_sell_up_to_but_excluding_minus_tenth():
    assert bias.label(-0.100001) == "Sell"


def test_label_neutral_includes_minus_tenth_and_plus_tenth():
    assert bias.label(-0.1) == "Neutral"
    assert bias.label(0.1) == "Neutral"
    assert bias.label(0.0) == "Neutral"


def test_label_buy_above_plus_tenth_and_includes_plus_half():
    assert bias.label(0.100001) == "Buy"
    assert bias.label(0.5) == "Buy"


def test_label_strong_buy_above_plus_half():
    assert bias.label(0.500001) == "Strong Buy"


def test_label_unknown_score_has_no_label():
    assert bias.label(math.nan) is None


# --- RSI / CCI / Williams %R share the "extreme and turning" rule ---------------------------


def test_extreme_turn_vote_buy_below_threshold_and_rising():
    v = bias._extreme_turn_vote(series(25.0, 28.0), buy_below=30, sell_above=70)
    assert v.action == "Buy" and v.values["value"] == 28.0


def test_extreme_turn_vote_sell_above_threshold_and_falling():
    v = bias._extreme_turn_vote(series(75.0, 72.0), buy_below=30, sell_above=70)
    assert v.action == "Sell"


def test_extreme_turn_vote_below_threshold_but_falling_is_neutral():
    v = bias._extreme_turn_vote(series(28.0, 25.0), buy_below=30, sell_above=70)
    assert v.action == "Neutral"


def test_extreme_turn_vote_above_threshold_but_rising_is_neutral():
    v = bias._extreme_turn_vote(series(72.0, 75.0), buy_below=30, sell_above=70)
    assert v.action == "Neutral"


def test_extreme_turn_vote_at_the_threshold_is_neutral():
    assert bias._extreme_turn_vote(series(29.0, 30.0), buy_below=30, sell_above=70).action == "Neutral"
    assert bias._extreme_turn_vote(series(71.0, 70.0), buy_below=30, sell_above=70).action == "Neutral"


def test_extreme_turn_vote_unknown_value_never_votes():
    assert bias._extreme_turn_vote(series(25.0, math.nan), buy_below=30, sell_above=70).action is None
    assert bias._extreme_turn_vote(series(25.0), buy_below=30, sell_above=70).action is None


def test_williams_r_thresholds_are_minus_80_and_minus_20():
    assert bias._extreme_turn_vote(series(-85.0, -81.0), buy_below=-80, sell_above=-20).action == "Buy"
    assert bias._extreme_turn_vote(series(-15.0, -19.0), buy_below=-80, sell_above=-20).action == "Sell"


def test_cci_thresholds_are_minus_100_and_100():
    assert bias._extreme_turn_vote(series(-120.0, -105.0), buy_below=-100, sell_above=100).action == "Buy"
    assert bias._extreme_turn_vote(series(120.0, 105.0), buy_below=-100, sell_above=100).action == "Sell"


# --- Stochastic -------------------------------------------------------------------------------


def test_stochastic_vote_buy_both_below_20_and_k_above_d():
    v = bias._stochastic_vote(Stochastic(series(19.9), series(10.0)))
    assert v.action == "Buy"


def test_stochastic_vote_sell_both_above_80_and_k_below_d():
    v = bias._stochastic_vote(Stochastic(series(85.0), series(90.0)))
    assert v.action == "Sell"


def test_stochastic_vote_at_20_boundary_is_neutral():
    assert bias._stochastic_vote(Stochastic(series(20.0), series(15.0))).action == "Neutral"


def test_stochastic_vote_below_20_but_k_under_d_is_neutral():
    assert bias._stochastic_vote(Stochastic(series(15.0), series(18.0))).action == "Neutral"


def test_stochastic_vote_unknown_value_never_votes():
    assert bias._stochastic_vote(Stochastic(series(math.nan), series(10.0))).action is None


# --- ADX/DMI: Technical Ratings (canonical) -- Buy needs ADX rising, Sell needs ADX FALLING ----


def test_adx_vote_buy_plus_di_above_and_adx_rising_above_20():
    a = Adx(adx=series(19.0, 21.0), plus_di=series(10.0, 30.0), minus_di=series(10.0, 10.0))
    assert bias._adx_vote(a).action == "Buy"


def test_adx_vote_sell_minus_di_above_and_adx_falling_above_20():
    # Technical Ratings (canonical; see bias.py's module docstring): Sell needs ADX FALLING, the
    # opposite of Buy's rising requirement and of the Screener page's "rising" wording.
    a = Adx(adx=series(25.0, 21.0), plus_di=series(10.0, 10.0), minus_di=series(10.0, 30.0))
    assert bias._adx_vote(a).action == "Sell"


def test_adx_vote_no_sell_when_adx_is_rising():
    a = Adx(adx=series(19.0, 21.0), plus_di=series(10.0, 10.0), minus_di=series(10.0, 30.0))
    assert bias._adx_vote(a).action == "Neutral"


def test_adx_vote_neutral_when_adx_not_above_20():
    a = Adx(adx=series(15.0, 19.0), plus_di=series(10.0, 30.0), minus_di=series(10.0, 10.0))
    assert bias._adx_vote(a).action == "Neutral"


def test_adx_vote_boundary_adx_exactly_20_is_neutral():
    a = Adx(adx=series(19.0, 20.0), plus_di=series(10.0, 30.0), minus_di=series(10.0, 10.0))
    assert bias._adx_vote(a).action == "Neutral"  # ADX must be > 20, not >= 20


def test_adx_vote_boundary_adx_flat_is_neutral_on_both_sides():
    buy_side = Adx(adx=series(21.0, 21.0), plus_di=series(10.0, 30.0), minus_di=series(10.0, 10.0))
    assert bias._adx_vote(buy_side).action == "Neutral"  # not rising
    sell_side = Adx(adx=series(21.0, 21.0), plus_di=series(10.0, 10.0), minus_di=series(10.0, 30.0))
    assert bias._adx_vote(sell_side).action == "Neutral"  # not falling


def test_adx_vote_neutral_on_the_buy_side_when_adx_is_falling():
    a = Adx(adx=series(25.0, 21.0), plus_di=series(10.0, 30.0), minus_di=series(10.0, 10.0))
    assert bias._adx_vote(a).action == "Neutral"


def test_adx_vote_unknown_value_never_votes():
    a = Adx(adx=series(math.nan, 21.0), plus_di=series(10.0, 30.0), minus_di=series(10.0, 10.0))
    assert bias._adx_vote(a).action is None


# --- Awesome Oscillator: zero-cross or two-bar saucer turn ------------------------------------


def test_ao_vote_buy_on_a_cross_over_zero():
    assert bias._awesome_oscillator_vote(series(1.0, -0.5, 0.2)).action == "Buy"


def test_ao_vote_buy_on_a_saucer_turning_up_above_zero():
    assert bias._awesome_oscillator_vote(series(1.0, 0.5, 0.8)).action == "Buy"


def test_ao_vote_sell_on_a_cross_under_zero():
    assert bias._awesome_oscillator_vote(series(-1.0, 0.5, -0.2)).action == "Sell"


def test_ao_vote_sell_on_a_saucer_turning_down_below_zero():
    assert bias._awesome_oscillator_vote(series(-1.0, -0.5, -0.8)).action == "Sell"


def test_ao_vote_neutral_above_zero_without_crossing_or_turning_up():
    assert bias._awesome_oscillator_vote(series(0.9, 1.0, 0.8)).action == "Neutral"


def test_ao_vote_unknown_value_needs_three_bars():
    assert bias._awesome_oscillator_vote(series(1.0, 0.5)).action is None


# --- Momentum -----------------------------------------------------------------------------


def test_momentum_vote_buy_rising():
    assert bias._momentum_vote(series(1.0, 2.0)).action == "Buy"


def test_momentum_vote_sell_falling():
    assert bias._momentum_vote(series(2.0, 1.0)).action == "Sell"


def test_momentum_vote_neutral_when_equal():
    assert bias._momentum_vote(series(1.0, 1.0)).action == "Neutral"


def test_momentum_vote_unknown_value_never_votes():
    assert bias._momentum_vote(series(1.0)).action is None


# --- MACD ---------------------------------------------------------------------------------


def test_macd_vote_buy_above_signal():
    assert bias._macd_vote(Macd(series(1.0), series(0.5), series(0.5))).action == "Buy"


def test_macd_vote_sell_below_signal():
    assert bias._macd_vote(Macd(series(0.5), series(1.0), series(-0.5))).action == "Sell"


def test_macd_vote_neutral_when_equal():
    assert bias._macd_vote(Macd(series(1.0), series(1.0), series(0.0))).action == "Neutral"


def test_macd_vote_unknown_value_never_votes():
    assert bias._macd_vote(Macd(series(math.nan), series(1.0), series(math.nan))).action is None


# --- Stoch RSI: needs the trend filter too -----------------------------------------------


def test_stoch_rsi_vote_buy_in_a_downtrend():
    sr = StochRsi(series(15.0), series(10.0))
    assert bias._stoch_rsi_vote(sr, uptrend=False, downtrend=True).action == "Buy"


def test_stoch_rsi_vote_sell_in_an_uptrend():
    sr = StochRsi(series(85.0), series(90.0))
    assert bias._stoch_rsi_vote(sr, uptrend=True, downtrend=False).action == "Sell"


def test_stoch_rsi_vote_neutral_without_the_matching_trend():
    sr = StochRsi(series(15.0), series(10.0))
    assert bias._stoch_rsi_vote(sr, uptrend=False, downtrend=False).action == "Neutral"
    sr_high = StochRsi(series(85.0), series(90.0))
    assert bias._stoch_rsi_vote(sr_high, uptrend=False, downtrend=False).action == "Neutral"


def test_stoch_rsi_vote_unknown_value_never_votes():
    sr = StochRsi(series(math.nan), series(10.0))
    assert bias._stoch_rsi_vote(sr, uptrend=True, downtrend=False).action is None


# --- Bull/Bear Power: needs the trend filter too -----------------------------------------


def test_bull_bear_power_vote_buy_in_an_uptrend():
    bb = BullBearPower(bull=series(0.1, 0.2), bear=series(-0.5, -0.3))  # bear < 0 and rising
    assert bias._bull_bear_power_vote(bb, uptrend=True, downtrend=False).action == "Buy"


def test_bull_bear_power_vote_sell_in_a_downtrend():
    bb = BullBearPower(bull=series(0.5, 0.3), bear=series(-0.1, -0.2))  # bull > 0 and falling
    assert bias._bull_bear_power_vote(bb, uptrend=False, downtrend=True).action == "Sell"


def test_bull_bear_power_vote_neutral_without_the_matching_trend():
    bb = BullBearPower(bull=series(0.1, 0.2), bear=series(-0.5, -0.3))
    assert bias._bull_bear_power_vote(bb, uptrend=False, downtrend=False).action == "Neutral"


def test_bull_bear_power_vote_unknown_value_never_votes():
    bb = BullBearPower(bull=series(math.nan, 0.2), bear=series(-0.5, -0.3))
    assert bias._bull_bear_power_vote(bb, uptrend=True, downtrend=False).action is None


# --- Ultimate Oscillator: TradingView's rule literally, >70 Buy and <30 Sell -----------------


def test_ultimate_oscillator_vote_buy_above_70():
    assert bias._ultimate_oscillator_vote(series(75.0)).action == "Buy"


def test_ultimate_oscillator_vote_sell_below_30():
    assert bias._ultimate_oscillator_vote(series(25.0)).action == "Sell"


def test_ultimate_oscillator_vote_boundary_values_are_neutral():
    assert bias._ultimate_oscillator_vote(series(70.0)).action == "Neutral"
    assert bias._ultimate_oscillator_vote(series(30.0)).action == "Neutral"


def test_ultimate_oscillator_vote_unknown_value_never_votes():
    assert bias._ultimate_oscillator_vote(series(math.nan)).action is None


# --- Moving averages: buy when below price, sell when above -----------------------------


def test_ma_vote_buy_below_price():
    assert bias._ma_vote(99.0, 100.0).action == "Buy"


def test_ma_vote_sell_above_price():
    assert bias._ma_vote(101.0, 100.0).action == "Sell"


def test_ma_vote_neutral_when_equal_to_price():
    assert bias._ma_vote(100.0, 100.0).action == "Neutral"


def test_ma_vote_unknown_value_never_votes():
    assert bias._ma_vote(math.nan, 100.0).action is None


# --- Ichimoku -------------------------------------------------------------------------------


def test_ichimoku_vote_buy_when_fully_aligned_up():
    ic = Ichimoku(conversion=series(10.0), base=series(9.5), span_a=series(9.0), span_b=series(8.0))
    assert bias._ichimoku_vote(ic, price=10.5).action == "Buy"


def test_ichimoku_vote_sell_when_fully_aligned_down():
    ic = Ichimoku(conversion=series(8.0), base=series(8.5), span_a=series(9.0), span_b=series(10.0))
    assert bias._ichimoku_vote(ic, price=7.5).action == "Sell"


def test_ichimoku_vote_neutral_when_not_fully_aligned():
    ic = Ichimoku(conversion=series(10.0), base=series(9.5), span_a=series(9.0), span_b=series(8.0))
    assert bias._ichimoku_vote(ic, price=9.8).action == "Neutral"  # price has not cleared conversion


def test_ichimoku_vote_unknown_value_never_votes():
    ic = Ichimoku(conversion=series(math.nan), base=series(9.5), span_a=series(9.0), span_b=series(8.0))
    assert bias._ichimoku_vote(ic, price=10.5).action is None


# --- the uptrend/downtrend filter (Decision: price vs its own SMA(50); REPORT-C.md) ----------


def test_trend_above_its_sma_is_an_uptrend():
    up, down = bias._trend(series(10.0, 10.0, 10.0, 20.0), length=3)
    assert up and not down


def test_trend_below_its_sma_is_a_downtrend():
    up, down = bias._trend(series(20.0, 20.0, 20.0, 10.0), length=3)
    assert down and not up


def test_trend_neither_when_unknown():
    up, down = bias._trend(series(10.0, 20.0), length=3)
    assert not up and not down


# --- grouping: counts and the mean score, ignoring unknown votes ----------------------------


def test_score_group_counts_and_means_only_the_known_votes():
    votes = {
        "a": bias.Vote({"value": 1.0}, "Buy"),
        "b": bias.Vote({"value": 2.0}, "Sell"),
        "c": bias.Vote({"value": 3.0}, None),  # unknown: never counted, never scored
        "d": bias.Vote({"value": 4.0}, "Neutral"),
    }
    counts, score = bias._score_group(votes)
    assert counts == bias.VoteCounts(sell=1, neutral=1, buy=1)
    assert score == 0.0


# --- warming up ------------------------------------------------------------------------------


def test_bias_warming_up_below_250_bars():
    assert bias.bias(_flat_bars(bias.MIN_BARS - 1)) == "warming up"


def test_bias_not_warming_up_at_exactly_250_bars():
    assert bias.bias(_flat_bars(bias.MIN_BARS)) != "warming up"


# --- an unknown indicator value never votes, end to end --------------------------------------


def _nvda_shape_bars() -> pd.DataFrame:
    """260 synthetic 15m bars: a rally to a local high, a pullback, a recovery, and a small
    topping dip in the final few bars -- built (by an offline parameter search over this
    generator, see REPORT-C.md) to land on MOCK-SPECS.md's NVDA 15m shape: Oscillators Sell
    1/Neutral 7/Buy 3, MAs Sell 2/Neutral 1/Buy 12, summary +0.42 Buy. Not NVDA's own prices --
    hand-matching 26 real TradingView rule outcomes from a vendor's live values isn't reproducible
    offline, so this fixture's shape, not its literal numbers, is the golden value, pinned here."""
    n = 260
    rng = np.random.default_rng(45)
    t = np.arange(n)
    base = 180 + 10 * (1 / (1 + np.exp(-(t - 90) / 25)))
    pullback = np.where(t > 150, -3.0 * (1 - np.exp(-(t - 150) / 40)), 0.0)
    recover = np.where(t > 230, 2.0 * (1 - np.exp(-(t - 230) / 15)), 0.0)
    close = base + pullback + recover + rng.normal(0, 0.15, n)
    close[-6:] -= np.linspace(0, 0.58, 6)
    high = close + np.abs(rng.normal(0.25, 0.08, n))
    low = close - np.abs(rng.normal(0.25, 0.08, n))
    volume = rng.integers(500, 2000, n).astype(float)
    return pd.DataFrame({"high": high, "low": low, "close": close, "volume": volume})


def test_bias_end_to_end_matches_the_nvda_mock_shape():
    result = bias.bias(_nvda_shape_bars())
    assert result != "warming up"
    counts = result.oscillator_counts
    assert (counts.sell, counts.neutral, counts.buy) == (1, 7, 3)
    ma_counts = result.ma_counts
    assert (ma_counts.sell, ma_counts.neutral, ma_counts.buy) == (2, 1, 12)
    assert round(result.summary_score, 2) == 0.42
    assert result.summary_label == "Buy"
    assert result.volatility_label is not None  # 260 bars is well past ATR's 113-bar warm-up


def test_bias_excludes_an_unknown_indicator_from_its_group_count():
    # VWMA's own 0/0 -> NaN convention (indicators.vwma): zero volume makes it unknown, so it
    # never votes and drops out of the 15 moving-average votes.
    bars = _nvda_shape_bars()
    bars["volume"] = 0.0
    result = bias.bias(bars)
    assert result != "warming up"
    assert result.moving_averages["vwma_20"].action is None
    assert result.ma_counts.sell + result.ma_counts.neutral + result.ma_counts.buy == 14
```

- [ ] **Step 2: Run it and watch it fail.**

Run (in `backend/`): `uv run pytest -q tests/test_bias.py`
Expected: collection error, `ModuleNotFoundError: No module named 'ai_trading.core.bias'`.

- [ ] **Step 3: Implement** `backend/src/ai_trading/core/bias.py`:

```python
"""Desk Technical Bias: TradingView's published -1/0/+1 votes over 11 oscillators and 15 moving
averages/filters (02f section 3), scored into an oscillator, moving-average, and summary rating.

Rule sources, and a conflict between them:
- https://www.tradingview.com/support/solutions/43000614331-technical-ratings/ (canonical: the
  Technical Ratings page says these are the same ratings the Screener columns and Technicals
  gauges show, so it is the tie-breaker when the two disagree)
- https://www.tradingview.com/support/solutions/43000475547-what-do-the-ratings-in-the-screener-mean/

The two pages disagree on ADX's Sell condition: Technical Ratings says ADX must be *falling*
(the opposite of Buy's rising requirement); the Screener page says "rising", the same as Buy.
This module follows Technical Ratings (see `_adx_vote` and REPORT-C.md's Decisions).

Two rules those pages state but do not define ("uptrend"/"downtrend" for Stoch RSI and Bull/Bear
Power) use this module's own definition; see `_trend`'s docstring and REPORT-C.md's Decisions.
Everything else below is TradingView's rule read literally, including the one other surprising
rule it documents plainly: Ultimate Oscillator buys above 70 and sells below 70 (not the usual
overbought/oversold reading).
"""

import math
from dataclasses import dataclass
from typing import Literal

import pandas as pd

from ai_trading.core import indicators
from ai_trading.core.indicators import Adx, BullBearPower, Ichimoku, Macd, Stochastic, StochRsi

MIN_BARS = 250  # 02f §3: fewer closed bars than this returns "warming up" instead of a bias.
_TREND_LENGTH = 50

Action = Literal["Sell", "Neutral", "Buy"]
Label = Literal["Strong Sell", "Sell", "Neutral", "Buy", "Strong Buy"]
_SCORE: dict[Action, float] = {"Sell": -1.0, "Neutral": 0.0, "Buy": 1.0}


@dataclass(frozen=True)
class Vote:
    """One voting indicator's named sub-values (e.g. `{"value": 61.8}` or `{"k": 86.2, "d": 71.4}`,
    for the Technicals page tables) and its action. `action` is `None` when a value the rule needs
    is unknown: it never votes (02f §3's "unknown data never votes")."""

    values: dict[str, float]
    action: Action | None


@dataclass(frozen=True)
class VoteCounts:
    sell: int
    neutral: int
    buy: int


@dataclass(frozen=True)
class Bias:
    oscillators: dict[str, Vote]
    moving_averages: dict[str, Vote]
    oscillator_counts: VoteCounts
    ma_counts: VoteCounts
    oscillator_score: float  # mean of the known oscillator votes; math.nan if none are known
    ma_score: float
    summary_score: float  # mean of oscillator_score and ma_score; math.nan if either is
    oscillator_label: Label | None  # None only when oscillator_score is math.nan
    ma_label: Label | None
    summary_label: Label | None
    atr_pct: float  # ATR(14) as a percent of price; math.nan until known. Never votes (02f §3).
    volatility_label: str | None  # "low" | "normal" | "high"; None until known


def label(score: float) -> Label | None:
    """02f §3's table, with the boundaries exactly as published: Strong Sell below -0.5; Sell
    from -0.5 up to -0.1 (exclusive); Neutral from -0.1 to +0.1 inclusive; Buy above +0.1 up to
    +0.5; Strong Buy above +0.5. `None` only for an unknown (`math.nan`) score."""
    if math.isnan(score):
        return None
    if score < -0.5:
        return "Strong Sell"
    if score < -0.1:
        return "Sell"
    if score <= 0.1:
        return "Neutral"
    if score <= 0.5:
        return "Buy"
    return "Strong Buy"


def _last(values: pd.Series) -> float:
    return float(values.iloc[-1]) if len(values) else math.nan


def _last_two(values: pd.Series) -> tuple[float, float]:
    if len(values) < 2:
        return math.nan, math.nan
    return float(values.iloc[-1]), float(values.iloc[-2])


def _last_three(values: pd.Series) -> tuple[float, float, float]:
    if len(values) < 3:
        return math.nan, math.nan, math.nan
    return float(values.iloc[-1]), float(values.iloc[-2]), float(values.iloc[-3])


def _extreme_turn_vote(values: pd.Series, buy_below: float, sell_above: float) -> Vote:
    """Buy below `buy_below` and rising; Sell above `sell_above` and falling; else Neutral. RSI's,
    CCI's, and Williams %R's rule, read literally off both rule pages."""
    cur, prev = _last_two(values)
    out = {"value": cur}
    if math.isnan(cur) or math.isnan(prev):
        return Vote(out, None)
    if cur < buy_below and cur > prev:
        return Vote(out, "Buy")
    if cur > sell_above and cur < prev:
        return Vote(out, "Sell")
    return Vote(out, "Neutral")


def _stochastic_vote(st: Stochastic) -> Vote:
    k, d = _last(st.k), _last(st.d)
    out = {"k": k, "d": d}
    if math.isnan(k) or math.isnan(d):
        return Vote(out, None)
    if k < 20 and d < 20 and k > d:
        return Vote(out, "Buy")
    if k > 80 and d > 80 and k < d:
        return Vote(out, "Sell")
    return Vote(out, "Neutral")


def _adx_vote(a: Adx) -> Vote:
    """Buy: +DI > -DI, ADX > 20, and ADX rising. Sell: +DI < -DI, ADX > 20, and ADX FALLING --
    Technical Ratings' own rule (canonical; see the module docstring), the opposite of Buy's
    rising requirement and of the Screener page's "rising" wording for Sell."""
    plus, minus = _last(a.plus_di), _last(a.minus_di)
    cur, prev = _last_two(a.adx)
    out = {"adx": cur, "plus_di": plus, "minus_di": minus}
    if math.isnan(plus) or math.isnan(minus) or math.isnan(cur) or math.isnan(prev):
        return Vote(out, None)
    if plus > minus and cur > 20 and cur > prev:
        return Vote(out, "Buy")
    if plus < minus and cur > 20 and cur < prev:
        return Vote(out, "Sell")
    return Vote(out, "Neutral")


def _awesome_oscillator_vote(ao: pd.Series) -> Vote:
    """Buy on a cross over 0, or two consecutive bars above 0 turning up (current > previous and
    previous < two bars back). Sell is the mirror. TradingView's own "saucer" wording for its
    Technical Ratings indicator (the rule page's shorter text is this one in other words)."""
    cur, prev, prev2 = _last_three(ao)
    out = {"value": cur}
    if math.isnan(cur) or math.isnan(prev) or math.isnan(prev2):
        return Vote(out, None)
    crosses_over, crosses_under = prev <= 0 < cur, prev >= 0 > cur
    turns_up = cur > 0 and prev > 0 and cur > prev and prev < prev2
    turns_down = cur < 0 and prev < 0 and cur < prev and prev > prev2
    if crosses_over or turns_up:
        return Vote(out, "Buy")
    if crosses_under or turns_down:
        return Vote(out, "Sell")
    return Vote(out, "Neutral")


def _momentum_vote(values: pd.Series) -> Vote:
    cur, prev = _last_two(values)
    out = {"value": cur}
    if math.isnan(cur) or math.isnan(prev):
        return Vote(out, None)
    if cur > prev:
        return Vote(out, "Buy")
    if cur < prev:
        return Vote(out, "Sell")
    return Vote(out, "Neutral")


def _macd_vote(m: Macd) -> Vote:
    line, signal = _last(m.line), _last(m.signal)
    out = {"line": line, "signal": signal}
    if math.isnan(line) or math.isnan(signal):
        return Vote(out, None)
    if line > signal:
        return Vote(out, "Buy")
    if line < signal:
        return Vote(out, "Sell")
    return Vote(out, "Neutral")


def _stoch_rsi_vote(sr: StochRsi, uptrend: bool, downtrend: bool) -> Vote:
    k, d = _last(sr.k), _last(sr.d)
    out = {"k": k, "d": d}
    if math.isnan(k) or math.isnan(d):
        return Vote(out, None)
    if downtrend and k < 20 and d < 20 and k > d:
        return Vote(out, "Buy")
    if uptrend and k > 80 and d > 80 and k < d:
        return Vote(out, "Sell")
    return Vote(out, "Neutral")


def _bull_bear_power_vote(bb: BullBearPower, uptrend: bool, downtrend: bool) -> Vote:
    bull_cur, bull_prev = _last_two(bb.bull)
    bear_cur, bear_prev = _last_two(bb.bear)
    out = {"bull": bull_cur, "bear": bear_cur}
    if math.isnan(bull_cur) or math.isnan(bull_prev) or math.isnan(bear_cur) or math.isnan(bear_prev):
        return Vote(out, None)
    if uptrend and bear_cur < 0 and bear_cur > bear_prev:
        return Vote(out, "Buy")
    if downtrend and bull_cur > 0 and bull_cur < bull_prev:
        return Vote(out, "Sell")
    return Vote(out, "Neutral")


def _ultimate_oscillator_vote(values: pd.Series) -> Vote:
    """Buy above 70, Sell below 30 -- TradingView's own rule, stated identically on both rule
    pages; the inverse of the usual overbought/oversold reading, kept as published."""
    cur = _last(values)
    out = {"value": cur}
    if math.isnan(cur):
        return Vote(out, None)
    if cur > 70:
        return Vote(out, "Buy")
    if cur < 30:
        return Vote(out, "Sell")
    return Vote(out, "Neutral")


def _ma_vote(value: float, price: float) -> Vote:
    out = {"value": value}
    if math.isnan(value) or math.isnan(price):
        return Vote(out, None)
    if value < price:
        return Vote(out, "Buy")
    if value > price:
        return Vote(out, "Sell")
    return Vote(out, "Neutral")


def _ichimoku_vote(ic: Ichimoku, price: float) -> Vote:
    conversion, base = _last(ic.conversion), _last(ic.base)
    span_a, span_b = _last(ic.span_a), _last(ic.span_b)
    out = {"conversion": conversion, "base": base, "span_a": span_a, "span_b": span_b}
    if any(math.isnan(v) for v in (conversion, base, span_a, span_b, price)):
        return Vote(out, None)
    if span_a > span_b and base > span_a and conversion > base and price > conversion:
        return Vote(out, "Buy")
    if span_a < span_b and base < span_a and conversion < base and price < conversion:
        return Vote(out, "Sell")
    return Vote(out, "Neutral")


def _trend(close: pd.Series, length: int = _TREND_LENGTH) -> tuple[bool, bool]:
    """Both rule pages use "uptrend"/"downtrend" for Stoch RSI's and Bull/Bear Power's votes
    without defining either term (unlike "rising"/"falling", which they define as a change from
    the previous bar). Decision (REPORT-C.md): price above its own SMA(50) is an uptrend, below is
    a downtrend; neither (so both votes stay Neutral) when they are equal or either is unknown."""
    sma = indicators.sma(close, length)
    price, baseline = _last(close), _last(sma)
    if math.isnan(price) or math.isnan(baseline):
        return False, False
    return price > baseline, price < baseline


def _score_group(votes: dict[str, Vote]) -> tuple[VoteCounts, float]:
    actions = [v.action for v in votes.values() if v.action is not None]
    counts = VoteCounts(
        sell=sum(1 for a in actions if a == "Sell"),
        neutral=sum(1 for a in actions if a == "Neutral"),
        buy=sum(1 for a in actions if a == "Buy"),
    )
    score = sum(_SCORE[a] for a in actions) / len(actions) if actions else math.nan
    return counts, score


_MA_LENGTHS = (10, 20, 30, 50, 100, 200)


def bias(bars: pd.DataFrame) -> Bias | Literal["warming up"]:
    """The Desk Technical Bias: TradingView's 11 oscillator votes and 15 moving-average/filter
    votes (02f §3), scored into an oscillator score, a moving-average score, and their mean (the
    summary), each with its Strong Sell..Strong Buy label; plus ATR's volatility label (no vote).

    `bars` is closed-bar OHLCV (columns `high`, `low`, `close`, `volume`), oldest first, matching
    every other `ai_trading.core.indicators` function's convention. Fewer than `MIN_BARS` (250)
    rows returns the literal string `"warming up"` instead of a `Bias` (02f §3). Every vote reads
    only the bars given; closed-bar and look-ahead discipline is the caller's (it passes only bars
    already closed as of the time being evaluated).
    """
    if len(bars) < MIN_BARS:
        return "warming up"
    close = bars["close"]
    price = _last(close)
    uptrend, downtrend = _trend(close)

    oscillators: dict[str, Vote] = {
        "rsi": _extreme_turn_vote(indicators.rsi(close, 14), buy_below=30, sell_above=70),
        "stochastic": _stochastic_vote(indicators.stochastic(bars, 14, 3, 3)),
        "cci": _extreme_turn_vote(indicators.cci(bars, 20), buy_below=-100, sell_above=100),
        "adx": _adx_vote(indicators.adx(bars, 14)),
        "awesome_oscillator": _awesome_oscillator_vote(indicators.awesome_oscillator(bars, 5, 34)),
        "momentum": _momentum_vote(indicators.momentum(close, 10)),
        "macd": _macd_vote(indicators.macd(close, 12, 26, 9)),
        "stoch_rsi": _stoch_rsi_vote(indicators.stoch_rsi(close, 3, 3, 14, 14), uptrend, downtrend),
        "williams_r": _extreme_turn_vote(indicators.williams_r(bars, 14), buy_below=-80, sell_above=-20),
        "bull_bear_power": _bull_bear_power_vote(indicators.bull_bear_power(bars, 13), uptrend, downtrend),
        "ultimate_oscillator": _ultimate_oscillator_vote(indicators.ultimate_oscillator(bars, 7, 14, 28)),
    }

    moving_averages: dict[str, Vote] = {}
    for length in _MA_LENGTHS:
        moving_averages[f"sma_{length}"] = _ma_vote(_last(indicators.sma(close, length)), price)
    for length in _MA_LENGTHS:
        moving_averages[f"ema_{length}"] = _ma_vote(_last(indicators.ema(close, length)), price)
    moving_averages["vwma_20"] = _ma_vote(_last(indicators.vwma(bars, 20)), price)
    moving_averages["hull_ma_9"] = _ma_vote(_last(indicators.hull_ma(close, 9)), price)
    moving_averages["ichimoku"] = _ichimoku_vote(indicators.ichimoku(bars, 9, 26, 52), price)

    oscillator_counts, oscillator_score = _score_group(oscillators)
    ma_counts, ma_score = _score_group(moving_averages)
    summary_score = (
        math.nan if math.isnan(oscillator_score) or math.isnan(ma_score) else (oscillator_score + ma_score) / 2
    )

    atr_percent = indicators.atr_percent(bars, 14, 100)
    return Bias(
        oscillators=oscillators,
        moving_averages=moving_averages,
        oscillator_counts=oscillator_counts,
        ma_counts=ma_counts,
        oscillator_score=oscillator_score,
        ma_score=ma_score,
        summary_score=summary_score,
        oscillator_label=label(oscillator_score),
        ma_label=label(ma_score),
        summary_label=label(summary_score),
        atr_pct=_last(atr_percent.pct),
        volatility_label=atr_percent.label.iloc[-1] if len(atr_percent.label) else None,
    )
```

No `THIRD_PARTY_NOTICES.md` row: this file re-implements TradingView's published rules, not code, over this project's own `indicators.py` outputs (Decision 27).

- [ ] **Step 4: Run the tests and lint.**

Run (in `backend/`): `uv run pytest -q tests/test_bias.py && uv run ruff check . && uv run ruff format --check . && uv run pytest -q`
Expected: `70 passed`, ruff clean, then `363 passed`, no skips.

- [ ] **Step 5: Commit.**

```bash
git add ai-trading/packages/family-desk/backend/src/ai_trading/core/bias.py ai-trading/packages/family-desk/backend/tests/test_bias.py
git commit -m "feat(ai-trading): the Desk Technical Bias -- TradingView's published oscillator and moving-average vote rules"
```

### Task 1c.6: Contract blocks, cadences, template, and evaluator wiring

**Files:**
- Modify: `contracts/src/strategy-spec-v1.ts` (three anchored insertions), `backend/src/ai_trading/core/evaluate.py` (full file), `backend/tests/test_templates.py` (four anchored insertions)
- Create: `backend/tests/test_evaluate_1c.py`, `contracts/templates/technical-bias-change.json`
- Create fixtures: `contracts/fixtures/strategy-spec-v1/valid/{technical-indicator-blocks,bar-close-5m,bar-close-1h}.json`, `contracts/fixtures/strategy-spec-v1/invalid/{pivot-bad-point,bias-bad-part,bad-cadence-timeframe}.json`
- Regenerate: `contracts/generated/strategy-spec-v1.schema.json`, `backend/src/ai_trading/contracts/strategy_spec_v1.py`
- Modify (phase status, this task only): `ai-trading/plans/subplans/02c-desk-v1-implementation-plan.md` (Phases table), `ai-trading/plans/STATUS.md` (the "5+" row)

**Interfaces:**
- Consumes: every `indicators.py` function (Tasks 1c.1-1c.2), `pivots.prior_period_hlc`/`classic_pivots`/`fibonacci_pivots`/`camarilla_pivots` (Task 1c.3), `bias.bias`/`bias.MIN_BARS` (Task 1c.5), `evaluate._compute`/`evaluate.label`/`evaluate._points` (Phase 1).
- Produces (Phase 2's bar store and Phase 3's live evaluation rely on these):
  - `CADENCE_MINUTES: dict[str, int]` (`{"bar_close_1m": 1, "bar_close_5m": 5, "bar_close_15m": 15, "bar_close_1h": 60}`)
  - the 15 new `SeriesOperand`/`LevelOperand` block kinds (02f §3), e.g. `{"series": "macd", "line": "line", "fast": 12, "slow": 26, "signal": 9}`, `{"level": "pivot", "method": "classic", "period": "session", "point": "R1"}`, `{"series": "bias", "part": "summary"}`
  - three new `watch.runOn` cadences: `bar_close_5m`, `bar_close_15m`, `bar_close_1h`
  - the "Technical bias change" template (02f §6)
- `evaluate()`, `check()`, and `SignalCandidate`'s public signatures are unchanged from Phase 1.
- **The resampler bins by phase-aligned timestamp, not row position (owner ruling; Review Focus 4):** `_resample(ann, asset, minutes, as_of)` derives each bin's id from `(bar time - phase start) // bin width`, so a 1-minute bar a data provider never sent (no row, not NaN -- providers omit minutes with no trades) never shifts a later bar into the wrong bin. A bin is exposed once its whole window has elapsed as of `as_of` (`bin_end <= as_of`, equivalently once a bar at or after the bin's end has itself closed, or the bin's own phase has ended); a bin with zero bars is never emitted; a forming bin is never exposed. `_resample` takes `as_of` as a fourth argument. Pinned by `test_bar_close_5m_a_missing_minute_does_not_let_the_next_bin_be_swallowed`.

- [ ] **Step 1: Write the failing tests, and the new fixtures and template.**

Create `backend/tests/test_evaluate_1c.py`:

```python
"""Phase 1c part D: the new 02f §3 series blocks, pivot level blocks, the bar_close_5m/15m/1h
cadences, and the Desk Technical Bias series wiring, all inside `evaluate.py`."""

from datetime import date
from typing import Any

import numpy as np
import pandas as pd
import pytest
from bars import minute_bars, set_bar, trading_days

from ai_trading.contracts.strategy_spec_v1 import StrategySpecV1
from ai_trading.core import bias as bias_module
from ai_trading.core import indicators, pivots
from ai_trading.core.calendar import annotate, et
from ai_trading.core.evaluate import _bias_series, _resample, check, evaluate, label

DAY = date(2026, 10, 6)  # a Tuesday


def make_spec(when: dict[str, Any], run_on: str = "daily_close", session: str = "regular") -> StrategySpecV1:
    return StrategySpecV1.model_validate(
        {
            "schemaVersion": 1,
            "name": "Test",
            "watch": {"universe": {"symbols": ["TEST"]}, "session": session, "runOn": run_on},
            "when": when,
            "then": {"alert": {"channels": ["inbox"]}},
        }
    )


def wavy_daily(n: int, seed: int = 7) -> pd.DataFrame:
    """Daily OHLCV with a real high/low spread, unlike `bars.daily_bars`'s flat bars: needed to
    exercise range-based indicators (CCI, ADX, Williams %R, pivots) meaningfully."""
    rng = np.random.default_rng(seed)
    close = 100 + np.cumsum(rng.normal(0, 1, n))
    high = close + np.abs(rng.normal(0.5, 0.2, n))
    low = close - np.abs(rng.normal(0.5, 0.2, n))
    volume = rng.integers(1_000, 5_000, n).astype(float)
    days = trading_days("stock", DAY, n)
    return pd.DataFrame(
        {"open": close, "high": high, "low": low, "close": close, "volume": volume}, index=pd.Index(days)
    )


DAILY = wavy_daily(300)
CLOSE = DAILY["close"]


def first_known(series: pd.Series) -> tuple[date, float]:
    """The first day `series` is known, and its value there -- a condition that is simply "this
    series is known" fires on evaluate()'s rising edge, i.e. the FIRST known bar, not the last."""
    known = series.dropna()
    assert len(known), "series is never known over this window"
    return known.index[0], float(known.iloc[0])


def run_series(operand: dict[str, Any], full: pd.DataFrame, upto: date) -> float:
    """Evaluates `operand` against a condition that fires once known, over `full` trimmed to end
    at `upto` (so the bar it fires on is also the last bar, matching a value computed from the
    same, un-trimmed `full` at that day). Returns the single evidence value."""
    spec = make_spec({"op": "gt", "left": operand, "right": {"value": -1e9}})
    trimmed = full.loc[:upto]
    found = evaluate(spec, "TEST", "stock", bars_1m=None, bars_1d=trimmed, as_of=et(upto, "20:00"))
    assert len(found) == 1, operand
    [value] = found[0].evidence.values()
    return value


def test_label_evidence_key_pins_the_schema_order():
    # label() doesn't sort anything itself -- it joins operand.items() in whatever order
    # model_dump() hands back. Today that happens to be alphabetical by key name (an artifact of
    # the datamodel-code-generator toolchain, not a guarantee label() makes); this pins the exact
    # key so a silent change in that toolchain's field order is caught here, not in a dashboard.
    operand = {"series": "macd", "line": "line", "fast": 12, "slow": 26, "signal": 9}
    spec = make_spec({"op": "gt", "left": operand, "right": {"value": 0}})
    dumped = spec.model_dump(by_alias=True, exclude_none=True)["when"]["left"]
    assert dumped == {"fast": 12, "line": "line", "series": "macd", "signal": 9, "slow": 26}
    assert label(dumped) == "macd(12, line, 9, 26)"


SERIES_CASES: dict[str, tuple[dict[str, Any], pd.Series]] = {
    "macd line": ({"series": "macd", "line": "line", "fast": 12, "slow": 26, "signal": 9}, indicators.macd(CLOSE).line),
    "macd signal": (
        {"series": "macd", "line": "signal", "fast": 12, "slow": 26, "signal": 9},
        indicators.macd(CLOSE).signal,
    ),
    "macd histogram": (
        {"series": "macd", "line": "histogram", "fast": 12, "slow": 26, "signal": 9},
        indicators.macd(CLOSE).histogram,
    ),
    "stochastic k": (
        {"series": "stochastic", "line": "k", "length": 14, "smoothK": 3, "smoothD": 3},
        indicators.stochastic(DAILY).k,
    ),
    "stochastic d": (
        {"series": "stochastic", "line": "d", "length": 14, "smoothK": 3, "smoothD": 3},
        indicators.stochastic(DAILY).d,
    ),
    "stoch_rsi k": (
        {"series": "stoch_rsi", "line": "k", "smoothK": 3, "smoothD": 3, "rsiLength": 14, "stochLength": 14},
        indicators.stoch_rsi(CLOSE).k,
    ),
    "stoch_rsi d": (
        {"series": "stoch_rsi", "line": "d", "smoothK": 3, "smoothD": 3, "rsiLength": 14, "stochLength": 14},
        indicators.stoch_rsi(CLOSE).d,
    ),
    "cci": ({"series": "cci", "length": 20}, indicators.cci(DAILY)),
    "adx": ({"series": "adx", "line": "adx", "length": 14}, indicators.adx(DAILY).adx),
    "adx plus_di": ({"series": "adx", "line": "plus_di", "length": 14}, indicators.adx(DAILY).plus_di),
    "adx minus_di": ({"series": "adx", "line": "minus_di", "length": 14}, indicators.adx(DAILY).minus_di),
    "awesome_oscillator": (
        {"series": "awesome_oscillator", "fast": 5, "slow": 34},
        indicators.awesome_oscillator(DAILY),
    ),
    "momentum": ({"series": "momentum", "length": 10}, indicators.momentum(CLOSE, 10)),
    "williams_r": ({"series": "williams_r", "length": 14}, indicators.williams_r(DAILY)),
    "bull_bear_power bull": (
        {"series": "bull_bear_power", "line": "bull", "length": 13},
        indicators.bull_bear_power(DAILY).bull,
    ),
    "bull_bear_power bear": (
        {"series": "bull_bear_power", "line": "bear", "length": 13},
        indicators.bull_bear_power(DAILY).bear,
    ),
    "ultimate_oscillator": (
        {"series": "ultimate_oscillator", "fast": 7, "mid": 14, "slow": 28},
        indicators.ultimate_oscillator(DAILY),
    ),
    "vwma": ({"series": "vwma", "length": 20}, indicators.vwma(DAILY, 20)),
    "hull_ma": ({"series": "hull_ma", "length": 9}, indicators.hull_ma(CLOSE, 9)),
    "ichimoku conversion": (
        {"series": "ichimoku", "line": "conversion", "conversionLength": 9, "baseLength": 26, "spanBLength": 52},
        indicators.ichimoku(DAILY).conversion,
    ),
    "ichimoku span_b": (
        {"series": "ichimoku", "line": "span_b", "conversionLength": 9, "baseLength": 26, "spanBLength": 52},
        indicators.ichimoku(DAILY).span_b,
    ),
    "atr_pct": ({"series": "atr_pct", "length": 14, "medianLength": 100}, indicators.atr_percent(DAILY, 14, 100).pct),
}


@pytest.mark.parametrize("name", sorted(SERIES_CASES))
def test_series_block_matches_the_underlying_indicator(name: str):
    operand, series = SERIES_CASES[name]
    day, expected = first_known(series)
    assert run_series(operand, DAILY, day) == pytest.approx(round(expected, 6))


@pytest.mark.parametrize("method", ["classic", "fibonacci", "camarilla"])
@pytest.mark.parametrize("period", ["session", "week", "month"])
def test_pivot_level_matches_the_underlying_formula(method: str, period: str):
    high, low, close = pivots.prior_period_hlc(DAILY, DAILY.index, "stock", period)
    expected_series = getattr(pivots, f"{method}_pivots")(high, low, close)["R1"]
    day, expected = first_known(expected_series)
    operand = {"level": "pivot", "method": method, "period": period, "point": "R1"}
    assert run_series(operand, DAILY, day) == pytest.approx(round(expected, 6))


# --- the Desk Technical Bias series: warming up, then a point-in-time match -------------------


def test_bias_series_is_entirely_unknown_before_warming_up():
    short = DAILY.iloc[: bias_module.MIN_BARS - 1]
    spec = make_spec({"op": "gt", "left": {"series": "bias", "part": "summary"}, "right": {"value": -1e9}})
    assert evaluate(spec, "TEST", "stock", bars_1m=None, bars_1d=short, as_of=et(short.index[-1], "20:00")) == []


def test_bias_series_becomes_known_on_the_bar_min_bars_closes():
    exact = DAILY.iloc[: bias_module.MIN_BARS]
    spec = make_spec({"op": "gt", "left": {"series": "bias", "part": "summary"}, "right": {"value": -1e9}})
    found = evaluate(spec, "TEST", "stock", bars_1m=None, bars_1d=exact, as_of=et(exact.index[-1], "20:00"))
    assert len(found) == 1


@pytest.mark.parametrize("part", ["oscillators", "moving_averages", "summary"])
def test_bias_series_matches_bias_bias_at_every_known_bar(part: str):
    """`_bias_series` (the evaluator's growing-window wrapper) must agree with calling
    `bias.bias()` directly at every bar it's known, not just the first -- checked by reading the
    private series straight off, since `evaluate()`'s rising-edge firing would otherwise only
    ever show the FIRST known bar for an always-true condition."""
    field = {"oscillators": "oscillator_score", "moving_averages": "ma_score", "summary": "summary_score"}[part]
    series = _bias_series(DAILY, part)
    assert series.iloc[: bias_module.MIN_BARS - 1].isna().all()
    for n in (bias_module.MIN_BARS, bias_module.MIN_BARS + 7, bias_module.MIN_BARS + 50, len(DAILY)):
        expected = getattr(bias_module.bias(DAILY.iloc[:n]), field)
        assert series.iloc[n - 1] == pytest.approx(expected)


# --- bar_close_5m / bar_close_15m / bar_close_1h cadences --------------------------------------


def set_bin(bars: pd.DataFrame, start: pd.Timestamp, minutes: int, value: float) -> None:
    """Overwrites a whole `minutes`-long run of 1-minute bars, so the resampled bar built from
    them has a known open/high/low/close, not just one bar inside a bin that stays the fixture's
    flat default."""
    bars.loc[start : start + pd.Timedelta(minutes=minutes - 1), ["open", "high", "low", "close"]] = value


def test_bar_close_5m_aggregates_ohlcv_from_the_five_one_minute_bars():
    bars = minute_bars("stock", DAY)
    set_bar(bars, DAY, "09:30", open=100.0, close=100.0)
    set_bar(bars, DAY, "09:31", high=102.0)
    set_bar(bars, DAY, "09:32", low=98.0)
    set_bar(bars, DAY, "09:34", close=101.0, volume=500.0)
    spec = make_spec({"op": "gt", "left": {"series": "close"}, "right": {"value": -1e9}}, run_on="bar_close_5m")
    found = evaluate(spec, "TEST", "stock", bars_1m=bars, bars_1d=pd.DataFrame(), as_of=et(DAY, "09:35"))
    first = next(c for c in found if c.bar_time == et(DAY, "09:30"))
    assert first.evidence["close"] == 101.0


def test_bar_close_5m_a_missing_minute_does_not_let_the_next_bin_be_swallowed():
    # 09:32 is missing entirely (no row, not NaN -- a provider that omits minutes with no trades).
    # Binning by row position (the bug) would count 09:30,09:31,09:33,09:34,09:35 as five rows and
    # put 09:35 in the first bin; binning by phase-aligned timestamp keeps 09:35 in its own bin.
    bars = minute_bars("stock", DAY)
    set_bar(bars, DAY, "09:30", close=100.0)
    set_bar(bars, DAY, "09:31", close=101.0)
    set_bar(bars, DAY, "09:33", close=103.0)
    set_bar(bars, DAY, "09:34", close=104.0)
    set_bar(bars, DAY, "09:35", close=999.0)  # must never appear in the 09:30 bin
    bars = bars.drop(et(DAY, "09:32"))
    ann = annotate(bars.loc[: et(DAY, "09:39")], "stock")  # only what's closed as of 09:40
    resampled = _resample(ann, "stock", 5, et(DAY, "09:40"))
    first = resampled.loc[et(DAY, "09:30")]
    assert (first["open"], first["close"]) == (100.0, 104.0)  # {09:30, 09:31, 09:33, 09:34}
    assert first["high"] == 104.0  # never 999.0: 09:35 does not leak into this bin
    second = resampled.loc[et(DAY, "09:35")]
    assert second["high"] == 999.0  # 09:35 starts its own bin, not swallowed into the first


def test_bar_close_15m_divides_the_regular_session_into_26_whole_bars():
    bars = minute_bars("stock", DAY)
    bin_starts = pd.date_range(et(DAY, "09:30"), et(DAY, "16:00"), freq="15min", inclusive="left")
    assert len(bin_starts) == 26
    for i, start in enumerate(bin_starts):
        set_bin(bars, start, 15, 101.0 if i % 2 == 0 else 99.0)
    spec = make_spec({"op": "gt", "left": {"series": "close"}, "right": {"value": 100.0}}, run_on="bar_close_15m")
    found = evaluate(spec, "TEST", "stock", bars_1m=bars, bars_1d=pd.DataFrame(), as_of=et(DAY, "16:00"))
    assert [c.bar_time for c in found] == list(bin_starts[::2])  # every other bin is a rising edge


def test_bar_close_1h_closes_a_final_partial_bar_when_the_session_ends():
    bars = minute_bars("stock", DAY)
    set_bin(bars, et(DAY, "15:30"), 30, 101.0)  # the whole final 30-minute bin (15:30-15:59) rises
    spec = make_spec({"op": "gt", "left": {"series": "close"}, "right": {"value": 100.5}}, run_on="bar_close_1h")
    found = evaluate(spec, "TEST", "stock", bars_1m=bars, bars_1d=pd.DataFrame(), as_of=et(DAY, "16:00"))
    # 390 regular minutes = 6 full hours (09:30..15:29) plus one final 30-minute bar (15:30..15:59).
    assert [c.bar_time for c in found] == [et(DAY, "15:30")]


def test_bar_close_1h_never_exposes_a_still_forming_bar():
    bars = minute_bars("stock", DAY)
    set_bin(bars, et(DAY, "10:30"), 60, 101.0)  # the whole 10:30-11:29 bin rises
    spec = make_spec({"op": "gt", "left": {"series": "close"}, "right": {"value": 100.5}}, run_on="bar_close_1h")
    before_the_hour_closes = evaluate(
        spec, "TEST", "stock", bars_1m=bars, bars_1d=pd.DataFrame(), as_of=et(DAY, "11:29")
    )
    assert before_the_hour_closes == []  # 11:29 hasn't closed yet: the 10:30-11:29 bin isn't done
    after = evaluate(spec, "TEST", "stock", bars_1m=bars, bars_1d=pd.DataFrame(), as_of=et(DAY, "11:30"))
    assert [c.bar_time for c in after] == [et(DAY, "10:30")]


def test_bar_close_1h_never_spans_the_pre_to_regular_boundary():
    bars = minute_bars("stock", DAY)  # pre: 04:00-09:30 (330 min, 5 full hours + a 30-minute tail)
    pre_bins = [et(DAY, "04:00") + pd.Timedelta(hours=h) for h in range(5)] + [et(DAY, "09:00")]
    pre_lengths = [60] * 5 + [30]
    toggled = [*pre_bins, et(DAY, "09:30")]  # regular restarts its own fresh 60-minute bin at 09:30
    for i, (start, minutes) in enumerate(zip(toggled, [*pre_lengths, 60], strict=True)):
        set_bin(bars, start, minutes, 101.0 if i % 2 == 0 else 99.0)
    spec = make_spec(
        {"op": "gt", "left": {"series": "close"}, "right": {"value": 100.0}}, run_on="bar_close_1h", session="extended"
    )
    found = evaluate(spec, "TEST", "stock", bars_1m=bars, bars_1d=pd.DataFrame(), as_of=et(DAY, "10:30"))
    # only the even bins rise: 04:00, 06:00, 08:00 (pre, hourly) and 09:30 (regular's own fresh bin,
    # not 10:00 -- proof a bin never spans the pre/regular boundary).
    assert [c.bar_time for c in found] == [et(DAY, "04:00"), et(DAY, "06:00"), et(DAY, "08:00"), et(DAY, "09:30")]


def test_check_allows_vwap_on_the_new_intraday_cadences():
    spec = make_spec({"op": "gt", "left": {"series": "close"}, "right": {"series": "vwap"}}, run_on="bar_close_15m")
    assert check(spec) == []
```

In `backend/tests/test_templates.py`, change the import:

```python
from ai_trading.core.evaluate import SignalCandidate, evaluate
```

to:

```python
from ai_trading.core.evaluate import CADENCE_MINUTES, SignalCandidate, evaluate
```

append these two scenario helpers right after `_build_rsi_reversal`'s return (before `CASES: dict[...]`):

```python


def _regular_session_bars(day: date) -> pd.DataFrame:
    """Regular-session-only 1-minute bars: a bias fixture only needs these, and skipping the
    pre/post phases keeps `bias()`'s per-bar recomputation (see REPORT-C/evaluate.py's
    `_bias_series`) fast across the ~10 trading days its 250-bar warm-up needs."""
    bounds = session("stock", day)
    return minute_bars("stock", day).loc[bounds.regular_open : bounds.regular_close - pd.Timedelta(minutes=1)]


def technical_bias_change(fire: bool) -> Scenario:
    # 10 flat days (26 regular-session 15m bars each = 260) warm the bias past its 250-bar
    # minimum before today's 15m bars arrive.
    days = trading_days("stock", DAY, 11)
    bars = pd.concat([_regular_session_bars(day) for day in [*days[:-1], DAY]])
    if fire:
        closes(bars, "10:00", "10:15", 103.0)  # the whole 15-minute bar rallies and holds
    else:
        closes(bars, "10:00", "10:10", 103.0)  # reverts before the bar closes: no net change
    return Scenario("stock", bars, daily_bars([], []))
```

add this row to `CASES`, right after the `"rsi-reversal"` row:

```python
    "technical-bias-change": (technical_bias_change, "10:00", {"bias(summary)": 0.666667}),
```

and replace the lag line in `test_never_repaints`:

```python
    lag = pd.Timedelta(minutes=1) if spec.watch.runOn == "bar_close_1m" else pd.Timedelta(0)
```

with:

```python
    # bar_time is a bar-close cadence's bar START; it actually closes `lag` later (0 elsewhere).
    lag = pd.Timedelta(minutes=CADENCE_MINUTES.get(spec.watch.runOn, 0))
```

Create `contracts/fixtures/strategy-spec-v1/valid/technical-indicator-blocks.json`:

```json
{
  "schemaVersion": 1,
  "name": "Fixture",
  "watch": { "universe": { "watchlist": "Day movers" }, "session": "regular", "runOn": "bar_close_15m" },
  "when": {
    "all": [
      { "op": "gt", "left": { "series": "cci", "length": 20 }, "right": { "value": -100 } },
      { "op": "gt", "left": { "series": "momentum", "length": 10 }, "right": { "value": 0 } },
      { "op": "gt", "left": { "series": "williams_r", "length": 14 }, "right": { "value": -80 } },
      { "op": "gt", "left": { "series": "vwma", "length": 20 }, "right": { "value": 0 } },
      { "op": "gt", "left": { "series": "hull_ma", "length": 9 }, "right": { "value": 0 } },
      {
        "op": "crosses_above",
        "left": { "series": "macd", "line": "line", "fast": 12, "slow": 26, "signal": 9 },
        "right": { "series": "macd", "line": "signal", "fast": 12, "slow": 26, "signal": 9 }
      },
      {
        "op": "lt",
        "left": { "series": "stochastic", "line": "k", "length": 14, "smoothK": 3, "smoothD": 3 },
        "right": { "value": 20 }
      },
      {
        "op": "lt",
        "left": { "series": "stoch_rsi", "line": "k", "smoothK": 3, "smoothD": 3, "rsiLength": 14, "stochLength": 14 },
        "right": { "value": 20 }
      },
      { "op": "gt", "left": { "series": "adx", "line": "adx", "length": 14 }, "right": { "value": 20 } },
      { "op": "gt", "left": { "series": "awesome_oscillator", "fast": 5, "slow": 34 }, "right": { "value": 0 } },
      { "op": "lt", "left": { "series": "bull_bear_power", "line": "bear", "length": 13 }, "right": { "value": 0 } },
      {
        "op": "gt",
        "left": { "series": "ultimate_oscillator", "fast": 7, "mid": 14, "slow": 28 },
        "right": { "value": 70 }
      },
      {
        "op": "gt",
        "left": { "series": "ichimoku", "line": "conversion", "conversionLength": 9, "baseLength": 26, "spanBLength": 52 },
        "right": { "series": "ichimoku", "line": "base", "conversionLength": 9, "baseLength": 26, "spanBLength": 52 }
      },
      { "op": "lt", "left": { "series": "atr_pct", "length": 14, "medianLength": 100 }, "right": { "value": 3 } },
      {
        "op": "crosses_above",
        "left": { "series": "bias", "part": "summary" },
        "right": { "value": 0.1 }
      },
      {
        "op": "gt",
        "left": { "level": "pivot", "method": "classic", "period": "session", "point": "R1" },
        "right": { "value": 0 }
      }
    ]
  },
  "then": { "alert": { "channels": ["inbox"], "severity": "opportunity" } }
}
```

Create `contracts/fixtures/strategy-spec-v1/valid/bar-close-5m.json`:

```json
{
  "schemaVersion": 1,
  "name": "Fixture",
  "watch": { "universe": { "watchlist": "Day movers" }, "session": "regular", "runOn": "bar_close_5m" },
  "when": { "op": "crosses_above", "left": { "series": "close" }, "right": { "series": "vwap" } },
  "then": { "alert": { "channels": ["inbox"] } }
}
```

Create `contracts/fixtures/strategy-spec-v1/valid/bar-close-1h.json`:

```json
{
  "schemaVersion": 1,
  "name": "Fixture",
  "watch": { "universe": { "watchlist": "Day movers" }, "session": "regular", "runOn": "bar_close_1h" },
  "when": {
    "op": "gt",
    "left": { "level": "pivot", "method": "fibonacci", "period": "week", "point": "S1" },
    "right": { "value": 0 }
  },
  "then": { "alert": { "channels": ["inbox"] } }
}
```

Create `contracts/fixtures/strategy-spec-v1/invalid/pivot-bad-point.json`:

```json
{ "schemaVersion": 1, "name": "Fixture", "watch": { "universe": { "watchlist": "Day movers" }, "session": "regular", "runOn": "bar_close_1m" }, "when": { "op": "gt", "left": { "level": "pivot", "method": "classic", "period": "session", "point": "R4" }, "right": { "value": 0 } }, "then": { "alert": { "channels": ["inbox"] } } }
```

Create `contracts/fixtures/strategy-spec-v1/invalid/bias-bad-part.json`:

```json
{ "schemaVersion": 1, "name": "Fixture", "watch": { "universe": { "watchlist": "Day movers" }, "session": "regular", "runOn": "bar_close_15m" }, "when": { "op": "gt", "left": { "series": "bias", "part": "noise" }, "right": { "value": 0 } }, "then": { "alert": { "channels": ["inbox"] } } }
```

Create `contracts/fixtures/strategy-spec-v1/invalid/bad-cadence-timeframe.json`:

```json
{ "schemaVersion": 1, "name": "Fixture", "watch": { "universe": { "watchlist": "Day movers" }, "session": "regular", "runOn": "bar_close_30m" }, "when": { "op": "gt", "left": { "series": "close" }, "right": { "value": 0 } }, "then": { "alert": { "channels": ["inbox"] } } }
```

Create `contracts/templates/technical-bias-change.json`:

```json
{
  "schemaVersion": 1,
  "name": "Technical bias change",
  "watch": { "universe": { "watchlist": "Day movers" }, "session": "regular", "runOn": "bar_close_15m" },
  "when": {
    "any": [
      { "op": "crosses_above", "left": { "series": "bias", "part": "summary" }, "right": { "value": 0.1 } },
      { "op": "crosses_below", "left": { "series": "bias", "part": "summary" }, "right": { "value": -0.1 } }
    ]
  },
  "then": { "alert": { "channels": ["inbox", "telegram"], "severity": "info" } }
}
```

- [ ] **Step 2: Run everything and watch it fail.**

Run (in `contracts/`): `pnpm test`
Expected: `accepts technical-indicator-blocks.json`, `accepts bar-close-5m.json`, `accepts bar-close-1h.json`, and `accepts technical-bias-change.json` fail (`not ok`); the three new invalid fixtures already fail validation (an unrecognized `level`/`series`/`runOn`), so their `rejects` tests pass; `generated JSON Schema is current` still passes (nothing has changed the schema source yet).

Run (in `backend/`): `uv run pytest -q tests/test_evaluate_1c.py tests/test_templates.py tests/test_contracts.py`
Expected: `tests/test_evaluate_1c.py` fails to collect (`ImportError: cannot import name '_bias_series' from 'ai_trading.core.evaluate'`); `tests/test_templates.py` fails to collect the same way (`ImportError: cannot import name 'CADENCE_MINUTES' from 'ai_trading.core.evaluate'`); `tests/test_contracts.py` fails for the four new JSON files (the generated Pydantic model does not know the new blocks or cadences yet).

- [ ] **Step 3: Add the new blocks and cadences to the contract.** In `contracts/src/strategy-spec-v1.ts`, `SeriesOperandSchema`'s `sma|ema|rsi|atr` member grows five more single-length series. Replace:

```typescript
      series: z.enum(["sma", "ema", "rsi", "atr"]),
```

with:

```typescript
      // 02f §3: cci/momentum/williams_r/vwma/hull_ma share sma/ema/rsi/atr's single-length shape.
      series: z.enum(["sma", "ema", "rsi", "atr", "cci", "momentum", "williams_r", "vwma", "hull_ma"]),
```

Then, in the same union, add 9 new block kinds right after the `rvol` member (before the closing `])`):

```typescript
    z.strictObject({
      series: z.literal("macd"),
      line: z.enum(["line", "signal", "histogram"]),
      fast: z.int().min(2).max(500),
      slow: z.int().min(2).max(500),
      signal: z.int().min(2).max(500),
    }),
    z.strictObject({
      series: z.literal("stochastic"),
      line: z.enum(["k", "d"]),
      length: z.int().min(2).max(500),
      smoothK: z.int().min(1).max(500),
      smoothD: z.int().min(1).max(500),
    }),
    z.strictObject({
      series: z.literal("stoch_rsi"),
      line: z.enum(["k", "d"]),
      smoothK: z.int().min(1).max(500),
      smoothD: z.int().min(1).max(500),
      rsiLength: z.int().min(2).max(500),
      stochLength: z.int().min(2).max(500),
    }),
    z.strictObject({
      series: z.literal("adx"),
      line: z.enum(["adx", "plus_di", "minus_di"]),
      length: z.int().min(2).max(500),
    }),
    z.strictObject({
      series: z.literal("awesome_oscillator"),
      fast: z.int().min(2).max(500),
      slow: z.int().min(2).max(500),
    }),
    z.strictObject({
      series: z.literal("bull_bear_power"),
      line: z.enum(["bull", "bear"]),
      length: z.int().min(2).max(500),
    }),
    z.strictObject({
      series: z.literal("ultimate_oscillator"),
      fast: z.int().min(2).max(500),
      mid: z.int().min(2).max(500),
      slow: z.int().min(2).max(500),
    }),
    z.strictObject({
      series: z.literal("ichimoku"),
      line: z.enum(["conversion", "base", "span_a", "span_b"]),
      conversionLength: z.int().min(2).max(500),
      baseLength: z.int().min(2).max(500),
      spanBLength: z.int().min(2).max(500),
    }),
    z.strictObject({
      series: z.literal("atr_pct"),
      length: z.int().min(2).max(500),
      medianLength: z.int().min(2).max(500),
    }),
    z.strictObject({
      // The Desk Technical Bias (02f §3): the chosen timeframe is `watch.runOn`, not a field
      // here -- the series reads whatever cadence the strategy already evaluates on.
      series: z.literal("bias"),
      part: z.enum(["oscillators", "moving_averages", "summary"]),
    }),
```

In `LevelOperandSchema`'s union, add the pivot block right after the `support`/`resistance` member (before the closing `])`):

```typescript
    z.strictObject({
      // 02f §3 pivots: the prior session (intraday), week (1D), or month (1W).
      level: z.literal("pivot"),
      method: z.enum(["classic", "fibonacci", "camarilla"]),
      period: z.enum(["session", "week", "month"]),
      point: z.enum(["P", "R1", "R2", "R3", "S1", "S2", "S3"]),
    }),
```

Finally, extend `watch.runOn`. Replace:

```typescript
    runOn: z.enum(["bar_close_1m", "premarket_0830", "daily_close", "weekly"]),
```

with:

```typescript
    runOn: z.enum([
      "bar_close_1m",
      "bar_close_5m",
      "bar_close_15m",
      "bar_close_1h",
      "premarket_0830",
      "daily_close",
      "weekly",
    ]),
```

Regenerate both generated files:

Run (in `contracts/`): `pnpm generate:json-schema && pnpm test && pnpm typecheck`
Expected: `# pass 47`, `# fail 0`.

Run (in `backend/`): `scripts/generate-contracts.sh`
Expected: `strategy_spec_v1.py` gains the 15 new block classes (e.g. `class SeriesOperand4(SpecModel)` for MACD, through the bias block) and the three new `runOn` literals. Confirm it is current: re-running both generators leaves `contracts/generated/` and `backend/src/ai_trading/contracts/` byte-identical (`git status --short` on those paths shows nothing).

- [ ] **Step 4: Wire the new blocks, the cadences, and the bias series into the evaluator.** This task finishes `evaluate.py`: replace the whole file with:

```python
"""Evaluates a strategy spec on closed bars into signal candidates (02a section 5).

Rules see closed bars only: a 1-minute bar counts once its minute has ended, a daily bar once
its regular session has closed. A strategy fires when its rule turns true at an evaluation point
(a rising edge), so a rule that stays true does not fire again:
- bar_close_1m: every closed 1-minute bar in the watched session; the edge resets each day.
- bar_close_5m, bar_close_15m, bar_close_1h: the same, over bars built by aggregating 1-minute
  bars from the start of each session phase, so a bar never spans a pre/regular/post boundary
  (02c Shared Interfaces).
- premarket_0830: once per trading day at 08:30 ET, from the bars closed by then; no edge.
- daily_close: every closed daily bar. weekly: the last trading day of each finished week.
"""

import json
from dataclasses import dataclass, field
from datetime import date, time
from typing import Any

import numpy as np
import pandas as pd

from ai_trading.contracts.strategy_spec_v1 import StrategySpecV1
from ai_trading.core import bias, indicators, levels, pivots
from ai_trading.core.calendar import ET, Asset, annotate, et, session

CADENCE_MINUTES = {"bar_close_1m": 1, "bar_close_5m": 5, "bar_close_15m": 15, "bar_close_1h": 60}
INTRADAY_CADENCES = set(CADENCE_MINUTES) | {"premarket_0830"}
_SESSION_LEVELS = {"premarket_high", "premarket_low", "overnight_high", "overnight_low"}
_OPENING_LEVELS = {"opening_range_high", "opening_range_low"}
_COMPARE = {"gt": np.greater, "gte": np.greater_equal, "lt": np.less, "lte": np.less_equal}
_PIVOT_METHODS = {
    "classic": pivots.classic_pivots,
    "fibonacci": pivots.fibonacci_pivots,
    "camarilla": pivots.camarilla_pivots,
}
_BIAS_FIELD = {"oscillators": "oscillator_score", "moving_averages": "ma_score", "summary": "summary_score"}
_PHASE_START = {"pre": "extended_open", "regular": "regular_open", "post": "regular_close"}
_PHASE_END = {"pre": "regular_open", "regular": "regular_close", "post": "extended_close"}


@dataclass(frozen=True)
class SignalCandidate:
    """`evidence` holds only the operands known at `bar_time` (JSON/jsonb has no NaN)."""

    symbol: str
    bar_time: pd.Timestamp
    evidence: dict[str, float]


def _nodes(condition: dict[str, Any]):
    yield condition
    for child in condition.get("all", []) + condition.get("any", []):
        yield from _nodes(child)
    if "not" in condition:
        yield from _nodes(condition["not"])


def _operands(condition: dict[str, Any]):
    for node in _nodes(condition):
        for side in ("left", "right"):
            if side in node and "value" not in node[side]:
                yield node[side]


def label(operand: dict[str, Any]) -> str:
    """Evidence key, e.g. "close", "sma(20)", "opening_range_high(15)", "macd(12, line, 9, 26)".
    Every parameter besides the block's own kind (`series`/`level`), in whatever field order the
    generated Pydantic model's `model_dump()` produces for that operand -- stable within a process
    and across identical inputs, since it comes from the dumped model rather than JSON source
    text, but not a property this function sorts or guarantees itself. Today that order happens to
    be alphabetical by key name (an artifact of the datamodel-code-generator toolchain); see
    `test_label_evidence_key_pins_the_schema_order` for the pinned example."""
    name = operand.get("series") or operand["level"]
    args = [str(value) for key, value in operand.items() if key not in ("series", "level")]
    return f"{name}({', '.join(args)})" if args else name


def check(spec: StrategySpecV1) -> list[str]:
    """Rules the JSON Schema cannot express: operands that the cadence cannot compute."""
    run_on = spec.watch.runOn
    when = spec.model_dump(by_alias=True, exclude_none=True)["when"]
    intraday_only = {"vwap"} | _SESSION_LEVELS | _OPENING_LEVELS
    problems = []
    for operand in _operands(when):
        name = operand.get("series") or operand["level"]
        if run_on not in INTRADAY_CADENCES and name in intraday_only:
            problems.append(f"{name} needs intraday bars; {run_on} uses daily bars")
        if run_on == "premarket_0830" and name in intraday_only:
            problems.append(f"{name} is not known at 08:30 ET")
    if run_on not in INTRADAY_CADENCES and any(n.get("op") == "time_between" for n in _nodes(when)):
        problems.append(f"time_between needs intraday bars; {run_on} uses daily bars")
    return problems


@dataclass(frozen=True)
class _Frame:
    bars: pd.DataFrame  # annotated 1-minute bars, or daily bars indexed by date
    days: pd.Index  # trading day of each row
    daily: pd.DataFrame
    asset: Asset
    intraday: bool
    cache: dict[str, pd.Series] = field(default_factory=dict)

    def per_day(self, values: pd.Series) -> pd.Series:
        return pd.Series(values.reindex(self.days).to_numpy(), index=self.bars.index)


def _series(operand: dict[str, Any], frame: _Frame) -> pd.Series:
    key = json.dumps(operand, sort_keys=True)
    if key not in frame.cache:
        frame.cache[key] = _compute(operand, frame)
    return frame.cache[key]


def _compute(operand: dict[str, Any], frame: _Frame) -> pd.Series:
    bars = frame.bars
    if "value" in operand:
        return pd.Series(float(operand["value"]), index=bars.index)
    unique_days = pd.Index(frame.days.unique())
    if "level" in operand:
        name = operand["level"]
        if name == "pivot":
            high, low, close = pivots.prior_period_hlc(frame.daily, unique_days, frame.asset, operand["period"])
            points = _PIVOT_METHODS[operand["method"]](high, low, close)
            return frame.per_day(points[operand["point"]])
        if name.startswith("prior_day_"):
            column = name.removeprefix("prior_day_")
            return frame.per_day(levels.prior_day(frame.daily, unique_days, frame.asset, column))
        if name.startswith("n_day_"):
            column = name.removeprefix("n_day_")
            return frame.per_day(levels.n_day(frame.daily, unique_days, operand["days"], column))
        if name in ("support", "resistance"):
            return frame.per_day(levels.support_resistance(frame.daily, unique_days, operand["days"], name))
        if name in _SESSION_LEVELS:
            return levels.pre_phase(bars, name.rsplit("_", 1)[1])
        return levels.opening_range(bars, frame.asset, operand["minutes"], name.rsplit("_", 1)[1])
    name = operand["series"]
    if name in ("open", "high", "low", "close", "volume"):
        return bars[name].astype(float)
    if name == "vwap":
        return indicators.session_vwap(bars)
    if name in ("sma", "ema", "rsi", "momentum", "hull_ma"):
        return getattr(indicators, name)(bars["close"], operand["length"])
    if name in ("atr", "cci", "williams_r", "vwma"):
        return getattr(indicators, name)(bars, operand["length"])
    if name == "macd":
        m = indicators.macd(bars["close"], operand["fast"], operand["slow"], operand["signal"])
        return getattr(m, operand["line"])
    if name == "stochastic":
        st = indicators.stochastic(bars, operand["length"], operand["smoothK"], operand["smoothD"])
        return getattr(st, operand["line"])
    if name == "stoch_rsi":
        sr = indicators.stoch_rsi(
            bars["close"], operand["smoothK"], operand["smoothD"], operand["rsiLength"], operand["stochLength"]
        )
        return getattr(sr, operand["line"])
    if name == "adx":
        return getattr(indicators.adx(bars, operand["length"]), operand["line"])
    if name == "awesome_oscillator":
        return indicators.awesome_oscillator(bars, operand["fast"], operand["slow"])
    if name == "bull_bear_power":
        return getattr(indicators.bull_bear_power(bars, operand["length"]), operand["line"])
    if name == "ultimate_oscillator":
        return indicators.ultimate_oscillator(bars, operand["fast"], operand["mid"], operand["slow"])
    if name == "ichimoku":
        ic = indicators.ichimoku(bars, operand["conversionLength"], operand["baseLength"], operand["spanBLength"])
        return getattr(ic, operand["line"])
    if name == "atr_pct":
        return indicators.atr_percent(bars, operand["length"], operand["medianLength"]).pct
    if name == "bias":
        return _bias_series(bars, operand["part"])
    if name == "rvol":
        if frame.intraday:
            return indicators.rvol_intraday(bars, operand["lookbackDays"])
        return indicators.rvol_daily(bars, operand["lookbackDays"])
    # gap_pct: intraday, last price against the prior regular close; daily, open against it.
    if frame.intraday:
        prior = frame.per_day(levels.prior_day(frame.daily, unique_days, frame.asset, "close"))
        return (bars["close"] - prior) / prior * 100
    prior = bars["close"].shift(1)
    return (bars["open"] - prior) / prior * 100


def _truth(values: np.ndarray, known: pd.Series) -> pd.Series:
    return pd.Series(values, index=known.index, dtype="boolean").mask(~known)


def _condition(node: dict[str, Any], frame: _Frame) -> pd.Series:
    if "all" in node or "any" in node:
        parts = [_condition(child, frame) for child in node.get("all") or node["any"]]
        out = parts[0]
        for part in parts[1:]:
            out = (out & part) if "all" in node else (out | part)
        return out
    if "not" in node:
        return ~_condition(node["not"], frame)
    op = node["op"]
    if op == "time_between":
        clock = frame.bars.index.tz_convert(ET).time
        start, end = time.fromisoformat(node["start"]), time.fromisoformat(node["end"])
        inside = (clock >= start) & (clock < end) if start <= end else (clock >= start) | (clock < end)
        return pd.Series(inside, index=frame.bars.index, dtype="boolean")
    left, right = _series(node["left"], frame), _series(node["right"], frame)
    known = left.notna() & right.notna()
    if op in _COMPARE:
        return _truth(_COMPARE[op](left.to_numpy(), right.to_numpy()), known)
    if op == "within_pct":
        near = (left - right).abs().to_numpy() <= node["pct"] / 100 * right.abs().to_numpy()
        return _truth(near, known)
    # crosses: now beyond, and the previous bar at or behind. A level or a constant that only
    # became known on this bar is compared with its current value, on either side; a series needs
    # its own known previous value, so it joins the known mask below instead of falling back.
    before_left = _before_cross(left, node["left"])
    before_right = _before_cross(right, node["right"])
    if op == "crosses_above":
        now, before = left > right, before_left <= before_right
    else:
        now, before = left < right, before_left >= before_right
    return _truth((now & before).to_numpy(), known & before_left.notna() & before_right.notna())


def _before_cross(value: pd.Series, operand: dict[str, Any]) -> pd.Series:
    """The previous bar's value for a crosses operand: a level or a constant that only became
    known on this bar falls back to its current value; a series needs its own known value."""
    shifted = value.shift(1)
    return shifted if "series" in operand else shifted.fillna(value)


def _resample(ann: pd.DataFrame, asset: Asset, minutes: int, as_of: pd.Timestamp) -> pd.DataFrame:
    """Aggregates closed, annotated 1-minute bars (`day`/`phase` columns from `annotate()`) into
    `minutes`-minute OHLCV bars, binned by phase-aligned timestamp (not row position) so a bar
    never spans a pre/regular/post boundary, and a missing 1-minute bar inside a bin never shifts
    later bars into it: a bin's identity and end time come from the calendar, not from how many
    rows happen to exist.

    A bin's window is `[bin_start, bin_end)`, capped at the phase's own end. It is exposed once
    that whole window has elapsed as of `as_of` (`bin_end <= as_of`) -- equivalently, once a bar
    at or after `bin_end` has itself closed, or the bin's own phase has ended. A missing minute
    *inside* an otherwise-closed bin is fine -- the bin aggregates whatever bars actually exist in
    its window. A bin with no bars at all is never emitted (pandas' `groupby` only visits bin ids
    that have at least one row, so this falls out for free). A still-forming bin is never exposed.
    """
    if minutes == 1:
        return ann
    columns = ["open", "high", "low", "close", "volume", "day", "phase"]
    rows: dict[str, list] = {column: [] for column in columns}
    index: list[pd.Timestamp] = []
    bin_width = pd.Timedelta(minutes=minutes)
    for (day, phase), group in ann.groupby(["day", "phase"], sort=False):
        day_session = session(asset, day)
        phase_start = getattr(day_session, _PHASE_START[phase])
        phase_end = getattr(day_session, _PHASE_END[phase])
        bin_id = (group.index - phase_start) // bin_width
        for b, chunk in group.groupby(bin_id):
            bin_start = phase_start + b * bin_width
            bin_end = min(bin_start + bin_width, phase_end)
            if as_of < bin_end:
                continue  # still forming: a bar inside this bin's window could still arrive
            index.append(bin_start)
            rows["open"].append(chunk["open"].iloc[0])
            rows["high"].append(chunk["high"].max())
            rows["low"].append(chunk["low"].min())
            rows["close"].append(chunk["close"].iloc[-1])
            rows["volume"].append(chunk["volume"].sum())
            rows["day"].append(day)
            rows["phase"].append(phase)
    out = pd.DataFrame(rows, index=pd.DatetimeIndex(index, name=ann.index.name))
    return out.astype({"open": float, "high": float, "low": float, "close": float, "volume": float}).sort_index()


def _bias_series(bars: pd.DataFrame, part: str) -> pd.Series:
    """The Desk Technical Bias score (02f §3) as of each bar: NaN while warming up (fewer than
    `bias.MIN_BARS` closed bars).

    ponytail: `bias.bias()` only reports a point-in-time snapshot (Phase 1c REPORT-C decision 5),
    so getting a series means recomputing every vote from its own full history at each bar --
    O(n^2) over `bars`. Fine at today's bar counts; replace with an incremental bias if a cadence's
    history grows large enough to make this a hot path.
    """
    field_name = _BIAS_FIELD[part]
    out = np.full(len(bars), np.nan)
    for i in range(bias.MIN_BARS - 1, len(bars)):
        result = bias.bias(bars.iloc[: i + 1])
        if result != "warming up":
            out[i] = getattr(result, field_name)
    return pd.Series(out, index=bars.index)


def _points(run_on: str, frame: _Frame, session_name: str, as_of: pd.Timestamp) -> pd.Series:
    """Maps each evaluation point's time (index) to the frame row it reads (values)."""
    bars = frame.bars
    if run_on in CADENCE_MINUTES:
        rows = bars.index if session_name == "extended" else bars.index[bars["phase"] == "regular"]
        return pd.Series(rows, index=rows)
    if run_on == "premarket_0830":
        out = {}
        for day, rows in bars.groupby("day").groups.items():
            point = et(day, "08:30")
            closed = rows[rows < point]  # bars that started before 08:30 have closed by then
            if point <= as_of and len(closed):
                out[point] = closed[-1]
        return pd.Series(out, dtype=object)
    closes = {day: session(frame.asset, day).regular_close for day in bars.index}
    days = list(bars.index)
    if run_on == "weekly":
        days = [day for day in days if _last_of_week(frame.asset, day)]
    return pd.Series(days, index=pd.DatetimeIndex([closes[day] for day in days]), dtype=object)


def _last_of_week(asset: Asset, day: date) -> bool:
    """True when no later trading day falls in the same ISO week."""
    for offset in range(1, 7 - day.weekday()):
        later = pd.Timestamp(day) + pd.Timedelta(days=offset)
        if session(asset, later.date()) is not None:
            return False
    return True


def evaluate(
    spec: StrategySpecV1,
    symbol: str,
    asset: Asset,
    *,
    bars_1m: pd.DataFrame | None,
    bars_1d: pd.DataFrame,
    as_of: pd.Timestamp,
) -> list[SignalCandidate]:
    """Signal candidates for every evaluation point closed by `as_of`.

    `bars_1m`: OHLCV indexed by UTC bar start (needed by intraday cadences).
    `bars_1d`: regular-session OHLCV indexed by trading day (`datetime.date`).
    """
    problems = check(spec)
    if problems:
        raise ValueError("; ".join(problems))
    run_on = spec.watch.runOn
    closed_days = [day for day in bars_1d.index if session(asset, day).regular_close <= as_of]
    daily = bars_1d.loc[closed_days].sort_index()
    if run_on in INTRADAY_CADENCES:
        if bars_1m is None:
            raise ValueError(f"{run_on} needs 1-minute bars")
        closed = bars_1m[bars_1m.index + pd.Timedelta(minutes=1) <= as_of].sort_index()
        bars = annotate(closed, asset)
        if run_on in CADENCE_MINUTES:
            bars = _resample(bars, asset, CADENCE_MINUTES[run_on], as_of)
        frame = _Frame(bars, pd.Index(bars["day"]), daily, asset, intraday=True)
    else:
        frame = _Frame(daily, daily.index, daily, asset, intraday=False)

    when = spec.model_dump(by_alias=True, exclude_none=True)["when"]
    truth = _condition(when, frame)
    points = _points(run_on, frame, spec.watch.session, as_of)
    if points.empty:
        return []
    rows = pd.Index(points.to_numpy())
    now = truth.reindex(rows)
    now.index = points.index
    if run_on == "premarket_0830":
        fired = now.fillna(False).astype(bool)
    else:
        # An unknown point neither fires nor resets the edge: compare with the last KNOWN state
        # before it (per day for the bar-close cadences, the whole series for daily_close/weekly).
        groups = frame.days.to_series(index=frame.bars.index).reindex(rows).to_numpy()
        keys = groups if run_on in CADENCE_MINUTES else np.zeros(len(now))
        last_known = now.groupby(keys).transform(lambda s: s.ffill().shift(1))
        fired = now.fillna(False).astype(bool) & ~last_known.fillna(False).astype(bool)

    evidence = {label(op): _series(op, frame).reindex(rows).to_numpy() for op in _operands(when)}
    out = []
    for position in np.flatnonzero(fired.to_numpy()):
        values = {
            key: round(float(series[position]), 6) for key, series in evidence.items() if not np.isnan(series[position])
        }
        out.append(SignalCandidate(symbol, points.index[position], values))
    return out
```

- [ ] **Step 5: Run every suite.**

Run (in `backend/`): `uv run pytest -q && uv run ruff check . && uv run ruff format --check .`
Expected: `417 passed`, no skips, ruff clean. Per-file breakdown: `test_bias.py` 70, `test_calendar.py` 8, `test_contracts.py` 48, `test_covered_calls.py` 27, `test_evaluate.py` 18 (unchanged), `test_evaluate_1c.py` 44, `test_futures.py` 100, `test_indicators.py` 7, `test_indicators_1c.py` 15, `test_levels.py` 9, `test_options_math.py` 10, `test_pivots.py` 8, `test_sizing.py` 19, `test_templates.py` 34.

Run (in `contracts/`): `pnpm typecheck && pnpm test`
Expected: `# pass 47`, `# fail 0`.

- [ ] **Step 6: Record the phase.**
  - In 02c's Phases table, change the "1c. Technicals and futures math" row's task-file cell to a link (`[phase-1c-technicals-and-futures.md](02c-desk-v1-tasks/phase-1c-technicals-and-futures.md)`, matching the 1 and 1b rows) and set its status to `Done`.
  - In `STATUS.md`'s "5+" row, append: "Phase 1c (technicals and futures math) done: every 02f §3 indicator, pivots, the Desk Technical Bias, and futures last-trade/first-notice/roll dates and sizing."

- [ ] **Step 7: Commit.** Every path is listed explicitly -- never a directory -- so the commit carries exactly what this task touched and nothing a sibling worktree might have added underneath `contracts/` or `backend/` in the meantime.

```bash
git add \
  ai-trading/packages/family-desk/contracts/src/strategy-spec-v1.ts \
  ai-trading/packages/family-desk/contracts/generated/strategy-spec-v1.schema.json \
  ai-trading/packages/family-desk/contracts/fixtures/strategy-spec-v1/valid/technical-indicator-blocks.json \
  ai-trading/packages/family-desk/contracts/fixtures/strategy-spec-v1/valid/bar-close-5m.json \
  ai-trading/packages/family-desk/contracts/fixtures/strategy-spec-v1/valid/bar-close-1h.json \
  ai-trading/packages/family-desk/contracts/fixtures/strategy-spec-v1/invalid/pivot-bad-point.json \
  ai-trading/packages/family-desk/contracts/fixtures/strategy-spec-v1/invalid/bias-bad-part.json \
  ai-trading/packages/family-desk/contracts/fixtures/strategy-spec-v1/invalid/bad-cadence-timeframe.json \
  ai-trading/packages/family-desk/contracts/templates/technical-bias-change.json \
  ai-trading/packages/family-desk/backend/src/ai_trading/contracts/strategy_spec_v1.py \
  ai-trading/packages/family-desk/backend/src/ai_trading/core/evaluate.py \
  ai-trading/packages/family-desk/backend/tests/test_evaluate_1c.py \
  ai-trading/packages/family-desk/backend/tests/test_templates.py \
  ai-trading/plans/subplans/02c-desk-v1-implementation-plan.md \
  ai-trading/plans/STATUS.md
git commit -m "feat(ai-trading): wire the 02f indicator, pivot, and bias blocks and the new cadences into the Desk evaluator; mark Desk Phase 1c done"
```

## After the Tasks (main session)

1. Merge the subagent's branch into `feature/toby`, then remove its worktree and delete the branch.
2. Phase 1c ships in the same pull request as Phase 1d, or on its own if 1d is not ready soon (one pull request per finished phase or meaningful batch).
