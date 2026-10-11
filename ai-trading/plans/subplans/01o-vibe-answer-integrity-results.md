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

## After: first seven real runs on the no-Jina fork (2026-10-11)

`gpt-6.1-sol`, `xhigh`, figure gate on, local server using the Firestore profile; fork commit `16630aa` (Tasks 2–9). All seven runs completed. `drafts` is the number of rejected drafts, not the number of tool calls. `FLAGGED` means the answer survived with marks; a row can also have a few individual figures omitted for cut-class reasons.

| Prompt | Drafts | Issues | Outcome | `web_search` | `get_stock_profile` |
|---|---:|---:|---|---:|---:|
| S02 AMZN analyst consensus | 2 | 7 | clean | 4 | 1 |
| S03 AAPL earnings | 2 | 10 | FLAGGED, 2 marked | 21 | 1 |
| S06 portfolio risk | 2 | 8 | FLAGGED, 1 marked, 3 omitted (`symbol_mismatch`) | 0 | 0 |
| S07 SPY moving-average backtest | 2 | 20 | FLAGGED, 1 marked | 0 | 0 |
| S08 MSFT covered call | 2 | 19 | FLAGGED, 5 marked | 0 | 0 |
| S09 META news | 2 | 11 | FLAGGED, 2 marked | 19 | 1 |
| S12 PLTR calibration | 2 | 8 | FLAGGED, 4 marked | 3 | 1 |

**Outcome:** 1 clean, 6 flagged, 0 whole-answer cut, 0 stub; S02, S03 and S09 used `get_stock_profile`. S06's three omitted figures had the `symbol_mismatch` reason, which the design deliberately keeps in the cut class. S08 exposed an unintended mark after the date year in “November 13, 2026 $560 call”: the scanner associated the dollar sign with `2026` rather than `560`. The fix in fork commit `e13ff4d` has 4 red→green scanner cases (including USD and yuan prefixes).

**Spot check, five flagged figures across three answers:** 5 of 5 matched session tool data. S03's US$333.14 AAPL close rounds the observed `333.1426696777344` (July 30). S09's US$63.35 billion META revenue estimate rounds `get_stock_profile.earnings_trend[0].revenue_avg = 63352671120`, also passed through `financial_rigor`. S08's gamma −0.7073, theta +32.25 and vega −60.01 equal the short-call position multiplier `−100` times the respective `options_pricing` values `0.007073`, `−0.322463` and `0.600051` (to the displayed precision). The S08 date year was also correct (option-chain expiration `1794528000` is 2026-11-13 UTC), but it should have been exempt, not marked; rerun verifies that change.

**No-Jina gate:** `read_url` absent from local and MCP tool catalogs; direct compatibility calls return `unavailable` without HTTP, bundled `web-reader` skill is removed, and active prompt/presets do not grant the reader. No Jina account or key was created.

### Corrected S08 rerun on fork `e13ff4d`

| Prompt | Drafts | Issues | Outcome | `web_search` | `get_stock_profile` |
|---|---:|---:|---|---:|---:|
| S08 MSFT covered call | 2 | 20 | FLAGGED, 3 marked, 0 omitted; **date year unmarked** | 0 | 0 |

The three remaining flags were derived Greek exposures (`formula_not_anchored`) rather than the date. This rerun completed at `gpt-6.1-sol`/`xhigh`. Combined with the other six first-pass prompts, the corrected batch remains **1 clean, 6 flagged, 0 whole-answer cut, 0 stub**. Backend after the fix: **17,498 passed, 77 skipped, 0 failed** with `-n 8`.
