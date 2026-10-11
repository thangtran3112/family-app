# Desk: Research Tools from the Upstream Recon (Backtests, AI Track Record, Valuation, Timeline)

Status: the owner asked on 2026-10-10 for a recon of the four upstream apps and for expanded mocks and features where the tools justify them. This file specifies the four features the recon earned. The owner reviews it with the comprehensive plan ([02c](02c-desk-v1-implementation-plan.md)). It extends [02a](02a-desk-v1-strategies-design.md), [02f](02f-desk-indicators-and-ai-daily-design.md), and [02g](02g-desk-covered-calls-and-futures-swing-design.md). The reuse map is 02a §11.

## 1. Why These Four

The recon (local notes: `ai-trading/temp/desk-research/recon-*.md`) found two things:
- No upstream app has a strategy-rule backtester the Desk could lift.
- ai-hedge-fund shows that a pure, tested evaluator plus a loop over history makes one cheap. The Desk already has that evaluator (Phase 1).

TradingAgents contributes the discipline (as-of guards, settlement after a horizon, known-then data). ai-hedge-fund contributes the valuation math and the point-in-time patterns. MiroFish (AGPL-3.0, ideas only) contributes the timeline idea.

| Feature | Serves | Mock |
|---|---|---|
| Strategy backtests | Both: test a setup on history before paper | D17 |
| Desk AI track record | Owner: decide how far to trust the AI | D18 |
| Valuation and earnings reaction | Owner: long-term context and covered calls around earnings | D19 |
| Holding timeline | Both: review one holding's events in order | M11 |

## 2. Strategy Backtests

- **What:** run a strategy version over stored history (Alpaca daily and intraday bars, Phase 2) through the same closed-bar evaluator that runs live (Phase 1). It produces trades, an equity curve, and statistics.
- **Fills and costs:**
  - a signal on a closed bar fills at the **next bar's open** (ai-hedge-fund's decide-at-close, execute-next pattern);
  - stops and targets fill at their level, or at the bar's open when price gaps through;
  - commission and slippage are settings (default $0.005 a share plus 1 tick each way; futures use the 02g contract specs).
- **Sizing:** Phase 1b's `sizing.py`, with risk as a percent of equity or a fixed dollar amount.
- **Statistics:** total return, CAGR, max drawdown, Sharpe, trades, win rate, average win and loss in R, expectancy in R, profit factor, average hold, exposure, longest losing streak, per-year returns, and the buy-and-hold benchmark over the same period.
- **No look-ahead:** the evaluator sees only bars that closed before the decision. Indicators, levels, and fundamentals respect the as-of time (TradingAgents' date-window pattern).
- **Honest labels**, shown with every result:
  - "Survivorship: this list was chosen today";
  - "Past results do not predict paper or live results".
- **Stages:** a backtest never places orders. "Promote to Paper" is the normal stage change from 02a §4.2.
- **Runs:** on demand, a few at a time, as a scheduler job. The results are stored per strategy version (`backtest_runs`, `backtest_trades`).

## 3. Desk AI Track Record

- **What counts as a call:** each Desk AI rating change (02f §5). Daily repeats of the same rating are not new calls.
- **Settlement:** after 90 trading days, each call is scored against SPY using only the data the AI saw at the time ("known then"):
  - Buy succeeds if the stock beats SPY;
  - Sell succeeds if it lags SPY;
  - Hold succeeds if it stays within ±5% of SPY.

  Separately, the target scores a hit if the price reaches the AI base target within its horizon.
- **Shows:**
  - calls, settled, and pending counts;
  - results by rating;
  - calibration (confidence bucket against hit rate, with n);
  - the target hit rate;
  - recent settled calls with a one-line lesson.
- **Lessons are shown, never fed back silently.** A later verdict prompt may cite them only as labeled context (TradingAgents' reflection pattern).
- **Settlement is idempotent:** a call settles once. A missed day is caught up, never skipped (ai-hedge-fund's tick pattern).
- **Tables:** `ai_calls`, `ai_call_outcomes`.

## 4. Valuation and Earnings Reaction (Deterministic, No LLM)

**Intrinsic value**, from SEC filings as of their filing date. The methods are ai-hedge-fund's v1 valuation functions, copied with attribution:
- DCF on free cash flow: bear, base, and bull, weighted 20/60/20;
- owner earnings, with a 25% margin of safety;
- EV/EBITDA at the stock's own 5-year median multiple;
- residual income.

The blended value is 60% DCF plus 40% the mean of the other three. The inputs and assumptions are shown, and "Adjust assumptions" recomputes the values locally.

**Earnings reaction** over the last 8 reports:
- the average absolute next-day move;
- the average excess move against SPY over days 0–1 (a simplified single-stock market model, after ai-hedge-fund's event study, without the bootstrap);
- results for beats and for misses;
- the options-implied move for the next report, from IBKR.

Announcement dates come from the 8-K (Item 2.02), not the 10-Q (ai-hedge-fund's PEAD lesson).

**Feeds the Desk AI:** the valuation vote (02f §5) receives these numbers.

## 5. Holding Timeline

One dated list per holding, newest first, with filters (All, Earnings, Desk AI, News, Strategy, Filings). It holds:
- scheduled earnings, with the implied move;
- macro releases (FRED);
- Desk AI rating changes;
- consensus revisions;
- cited news headlines;
- strategy versions, signals, and paper fills;
- SEC filings with their EPS result.

Every item links to its source or record. It is a read model over tables the other phases already fill; there is no new data source.

## 6. Phase Placement (02c)

| Phase | Work |
|---|---|
| 1d (new, pure) | The valuation methods, earnings-reaction statistics, the backtest engine core and its statistics, the settlement math, and the as-of window helpers |
| 5 | The valuation and earnings cards (D19), the AI call settlement job and the track record (D18), the holding timeline (M11) |
| 6b (new) | Backtest runs over stored bars, the results page (D17), and "Promote to Paper" |

## 7. Testing

- **Backtest:**
  - a fixture series where the signal bar's close and the next bar's open differ proves next-open fills;
  - a gap through the stop fills at the open;
  - statistics on a hand-computed trade list;
  - no look-ahead, by mutating future bars and asserting identical past trades.
- **Settlement:** each rating's success rule at its boundaries (±5% for Hold); idempotent re-runs; catch-up after a missed day.
- **Valuation:** each method against the hand-checked values of ai-hedge-fund's own examples; zero or negative cash flow returns `unavailable`, never a number.
- **Earnings reaction:** a fixture with known returns gives the expected market-model excess; fewer than 4 reports gives `unavailable`.

## 8. Not in v1

- Parameter optimization or walk-forward search, which invites overfitting
- Backtesting option strategies (needs the IV-smile model; later)
- "What-if" conditional analysis in Ask (MiroFish idea; later)
- Blind (anonymized) replays of past AI verdicts (ai-hedge-fund idea; later)
