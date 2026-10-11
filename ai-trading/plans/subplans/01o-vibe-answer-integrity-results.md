# Vibe Answer Integrity: Measured Results

Part of [01o-vibe-answer-integrity.md](01o-vibe-answer-integrity.md). All runs: `gpt-6.1-sol` at `xhigh` through the Responses API, the figure gate on, a local server, the sponsored OpenAI key, 2026-10-10.

## Baseline: the pinned fork commit `d402c2df`

Ten runs of the same prompts (`ai-trading/tools/vibe-eval/run_scenarios.py`, outcomes from `grounding_report.py`). "Drafts" is how many drafts the gate rejected, "issues" how many findings it raised over them.

| Prompt | Run | Drafts | Issues | Outcome | `web_search` | `get_stock_profile` |
|---|---|---:|---:|---|---:|---:|
| S02 AMZN analyst consensus | 1 | 3 | 35 | CUT, 9 figures | 7 | 1 |
| S02 AMZN analyst consensus | 2 | 3 | 19 | CUT, 3 figures | 6 | 1 |
| S03 AAPL earnings | 1 | 5 | 63 | CUT, 1 figure | 19 | 0 |
| S03 AAPL earnings | 2 | 5 | 112 | CUT, 1 figure | 11 | 0 |
| S06 portfolio risk | 1 | 2 | 23 | CUT, 4 figures | 0 | 0 |
| S07 SPY moving-average backtest | 1 | 2 | 40 | CUT, 9 figures | 0 | 0 |
| S08 MSFT covered call | 1 | 2 | 44 | **STUB** (365 characters) | 0 | 0 |
| S08 MSFT covered call | 2 | 2 | 51 | **STUB** (365 characters) | 0 | 0 |
| S09 META news | 1 | 2 | 7 | CUT, 3 figures | 20 | 1 |
| S12 PLTR calibration | 1 | 2 | 4 | CUT, 1 figure | 2 | 0 |

None of the ten finished clean. Both covered-call runs were replaced by a canned refusal; the rest lost one to nine figures. Single runs vary (S02 lost 9 figures in one run and 3 in the next on identical code), so compare outcomes, not exact counts.
