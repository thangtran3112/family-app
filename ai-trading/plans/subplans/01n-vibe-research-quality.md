# Vibe-Trading Research Quality for US Stocks: Overview and Decomposition

**Date:** 2026-10-10 · **Lane:** open-source (Trading Hub) · **Status:** decomposition and the specs for sub-projects 1 and 2 approved by the owner; implementation plans written, awaiting owner review and the choice of execution method

Related: [01o](01o-vibe-answer-integrity.md) and its [plan](01o-vibe-answer-integrity-plan.md) (sub-project 1), [01p](01p-vibe-effort-picker.md) and its [plan](01p-vibe-effort-picker-plan.md) (sub-project 2), [results of sub-project 1](01o-vibe-answer-integrity-results.md), `packages/vibe-trading/DIVERGENCE.md` (the fork ledger every sub-project updates).

## 1. Goal

- Vibe-Trading's US-stock research is complete, correct and fast enough to trust: the right tools and data sources, readable reports, and a Buy/Sell/target recommendation only after the agent team has reviewed.
- Success is measured, not felt. A golden set (sub-project 3) scores answers, models and tools, and every sub-project states its own before and after numbers.

## 2. Owner Decisions (2026-10-10)

- US markets only. Runs over ten minutes are fine; token cost is not a concern; `xhigh` is the minimum effort.
- Buy/Sell/target is allowed only after the agent team (the investment committee) has reviewed the analysis. A solo answer stays analysis-only and offers to convene the committee.
- Reasoning effort must be changeable in the chat, not only in Settings.
- Build a sample golden set that evaluates answers, models and tools.
- No paid data source, signup or account without the owner's go-ahead. The free cross-checks (Finnhub, Alpha Vantage) are approved in principle; the owner registers the two keys.
- Every change to the fork carries its row in `packages/vibe-trading/DIVERGENCE.md` in the same commit.
- Seeking Alpha and Interactive Brokers are not automated (section 3.4).

## 3. Evidence

All of it measured on 2026-10-10 on real runs with the sponsored keys. Runs used `gpt-6.1-sol` at `xhigh` through the Responses API unless stated. "Old pin" is fork commit `d7d09115`; "current pin" is `d402c2df` (merged with upstream `8e43007`). The sync fixed some old-pin defects (prose-wrapped formula notes now parse), so only current-pin numbers justify fixes.

### 3.1 The grounding gate degrades answers

Same six prompts that reach the gate, current pin, gate on:

| Run | Drafts rejected | Issues | Outcome |
|---|---:|---:|---|
| S02 AMZN consensus | 3 | 35 | 9 figures cut (the analyst targets) |
| S03 AAPL earnings | 5 | 63 | 1 figure cut |
| S06 portfolio risk | 2 | 23 | 4 figures cut |
| S07 SPY backtest | 2 | 40 | 9 figures cut |
| S08 MSFT covered call | 2 | 44 | **whole answer replaced by a 365-character stub** |
| S12 PLTR calibration | 2 | 4 | 1 figure cut |

None of the six is clean. On the old pin, judging the same questions with the gate on and off (9 paired questions, one Claude judge): overall 2.91 → 4.15, key figures visible 2.00 → 4.33, answers the question 2.78 → 4.33. The gate-off answers may hold unsupported numbers (the judge saw tool names only), so the fix keeps the gate.

Why figures fail on the current pin (209 issues over those six runs; the figure checker's own reason codes):

| Count | Reason | What actually happened |
|---:|---|---|
| 33 | `no_evidence` | Every one is a figure read from `web_search` and declared `observed`; web text is not checked evidence |
| 31 | `value_mismatch` | A target, EPS, revenue, strike, option premium or initial capital compared with the instrument's price range: a category error, not a contradiction |
| 25 | `undeclared` | Figures the model did not declare (backtest counts, an option premium) |
| 21 | `not_in_referenced_call` | The declared field is real but is not a "price", so it never matches |
| 20 | `formula_not_evaluable` | A note with field names or embedded prose |
| 18 | `field_ref_needs_call_id` | `tool::field` where the tool was called once |
| 16 | `derivation_result_mismatch` | The formula already multiplies by 100 and the checker multiplies again |
| 15 + 12 | `additive_operand_not_observed`, `formula_not_anchored` | Operands taken from artifact files or option-chain fields that are not evidence |
| 9 | `unparseable_declaration` | `−$2,582.00`: a sign before the currency mark makes the whole block unreadable |
| 9 | other | `unknown_call_id`, `symbol_mismatch`, `no_symbol` |

### 3.2 Models

Seven OpenAI models, five questions each, gate off, each at `xhigh`, scored by two independent Claude judges:

| Model | Average | Opus 5.5 | Sonnet 5.5 | Mean wall time | Mean tool calls |
|---|---:|---:|---:|---:|---:|
| gpt-6.1-sol | 3.93 | 3.97 | 3.90 | 249 s | 43 |
| gpt-6-astra | 3.88 | 4.07 | 3.70 | 242 s | 39 |
| gpt-5.5 | 3.82 | 3.87 | 3.77 | 181 s | 20 |
| gpt-5.6-sol | 3.77 | 3.80 | 3.73 | 243 s | 48 |
| gpt-5.6-terra | 3.70 | 3.63 | 3.77 | 157 s | 25 |
| gpt-6-luna | 3.68 | 3.77 | 3.60 | 245 s | 33 |
| gpt-6-sol | 3.48 | 3.63 | 3.33 | 161 s | 47 |

There is no clear winner: the spread is 0.45 of 5 points, the judges agree on rank only weakly (Spearman 0.36), and each cell is one run of five questions. Both judges put `gpt-6.1-sol` and `gpt-5.5` in their top three and `gpt-6-sol` in their bottom two. `gpt-5.5` is 27% faster with half the tool calls but weaker on calibration and depth. Decision: keep `gpt-6.1-sol` at `xhigh` as the default, offer `gpt-5.5` as the fast pick (chosen in Settings until the chat has a model picker, section 4), and settle further on the golden set. Twelve models were probed on the current pin with a real tool round trip on the Responses route: all completed at their lowest offered level, and at the highest all did except `o3`, which failed with a 400 at `xhigh`, a level the Settings probe wrongly offers (01p).

### 3.3 Tools and data

- **Consensus data already exists.** `get_stock_profile` returns EPS consensus per period with analyst counts, rating counts and mean/high/low target for free. It drops `revenueEstimate.low/high/numberOfAnalysts/growth` and has no EPS-surprise history, so the NVDA consensus answer had to say "not retrieved".
- **`read_url` fails on anonymous access.** The Jina reader answers anonymous callers with HTTP 401 ("bad network reputation") or 403 ("Anonymous access to domain … blocked"). 0 of 17 calls worked on a laptop; production worked 6 of 7 in the STX/WDC session and failed on the seventh with the 403. `web_reader_tool.py` cannot send a key.
- **The investment committee cannot see US consensus.** Its analysts have no `get_stock_profile`, `web_search`, `read_url` or `get_sec_filings`, carry China-only tools (`get_fund_flow`, `get_margin_trading`, `get_research_reports`), and the portfolio manager has five tools. The NVDA committee target was circular (forward EPS × today's multiple = today's price) and ignored the sell-side target. A full committee run takes 17 to 31 minutes.
- **Search over structure.** `web_search` was 73 of 368 tool calls; the earnings question used 18 searches and still lacked the figures.
- **Deploys kill runs.** A deploy killed the first STX/WDC attempt and the UI showed a green "Done · 0 steps".

### 3.4 Data sources

| Source | Verdict |
|---|---|
| Yahoo through `get_stock_profile` | Primary. Works today, keyless, unofficial. |
| Finnhub free, Alpha Vantage `EARNINGS_ESTIMATES` free | Cross-checks (sub-project 4). Alpha Vantage verified with its demo key; Finnhub's price-target endpoint may be a paid field (unverified). The owner registers the keys. |
| Interactive Brokers Analyst Forecast | Dead end. TWS API 10.47 (2026-05-20) removed `reqFundamentalData`; the Web API changelog of 2026-01-06 deprecated the EPS and fundamentals tags. The tab is GUI-only and scraping it breaches IBKR's terms. |
| Seeking Alpha Premium | Read it yourself; never automate it. Its terms (sections 6, 18, 20) ban robots and databasing its S&P-licensed estimates; it runs PerimeterX and Cloudflare with IP-bound cookies. |
| TipRanks MCP ($49.99/month Smart plan) | Not now. Its terms forbid using its data to evaluate AI, so never golden-set ground truth. |
| EODHD fundamentals feed ($59.99/month) | Not now; revisit if the golden set shows a gap. |

## 4. Decomposition

| # | Sub-project | What | Spec | Ships |
|---|---|---|---|---|
| 1 | Answer integrity and tool reliability | Flag unverifiable figures instead of cutting them or replacing the answer; repair deterministic false rejections; `cited` guidance for web numbers; richer `get_stock_profile`; disable Jina-backed `read_url` everywhere | [01o](01o-vibe-answer-integrity.md) | Batch 1, deploy |
| 2 | Per-chat reasoning effort | Effort selector in the chat bar; optional `reasoning_effort` per message, validated per model, also applied to committee runs; honest effort probe | [01p](01p-vibe-effort-picker.md) | Batch 1 |
| 2b | Chat model picker | Per-message model beside the effort selector, on the same plumbing; needs a short list of offered models | sketched in 01p section 11 | After 2, owner decides |
| 3 | Golden set and judge | About 25 sample questions in 8 categories; deterministic checks, SEC oracle facts, two Claude judges; leaderboard by model × effort × tool; lives outside the fork | later | Batch 2, no deploy |
| 4 | Committee-gated recommendation | Principle 4 change; `us_investment_committee` preset; `record_recommendation` tool that refuses without a finished committee run; Recommendation card; `get_analyst_consensus` with Finnhub and Alpha Vantage cross-checks | later | Batch 3, deploy, needs the two keys |
| 5 | Long-run protection | Deploys wait for active runs; amber "interrupted, resume" instead of a green "Done" | later | Batch 4 |

Order 1 → 2 → 3 → 4 → 5. Each sub-project gets its own spec, plan and review. Sub-projects 1 and 2 ship together (one fork commit set, one pull request, one deploy), which also applies `LANGCHAIN_USE_RESPONSES_API=true` to production: it is set in Firestore but not deployed, and without it 3 of 6 simultaneous runs on a fresh server failed with the Sol `reasoning_effort` 400.

## 5. Process Rules for Every Fork Change

- Work in the worktree `.worktrees/vibe-evals` on branch `feature/vibe-evals`, based on `origin/dev`. The submodule is on branch `family-app` of `thangtran3112/Vibe-Trading`.
- The fork commit carries its rows in `packages/vibe-trading/DIVERGENCE.md`: the "Why" section, the changes tables, "Behaviour to preserve through a sync", the expected-conflict list under "Reapplying after a sync", and, once a batch is verified, a "Verification" section with its numbers. The branch is pushed to the fork before the superproject's gitlink moves. Other checkouts run `git submodule sync -- ai-trading/packages/vibe-trading` before `git submodule update`.
- Verification before a pull request: the backend suite (`python -m pytest agent/tests -q -n 8` in a venv from the new `requirements-lock.txt`), the frontend checks (`npx tsc -b && npx vitest run && npm run build`), and `ai-trading/deploy/ci/smoke-test.sh vibe-trading` after `docker buildx bake`.
- One pull request per batch to `dev`, then a scoped release to `main` and a deploy, verified live (the standing delivery authorization in `ai-trading/AGENTS.md`). A deploy restarts containers and kills in-flight runs, so check for active runs first.

## 6. Defaults Assumed (the owner may correct any)

- The Recommendation card shows a five-level rating, a 12-month target with bear/base/bull, the horizon, what would change the view and the confidence. It shows no position size.
- An explicit "should I buy X?" convenes the committee in the background (about 20 to 30 minutes). Other questions stay analysis-only and offer it.
- The effort picker is per chat and defaults to the server's `xhigh`; its options come from the model's accepted list. **A chat model picker is split out as sub-project 2b**, a change from the first approved table (01p section 11 says why and sketches it); until then `gpt-5.5` is chosen in Settings.
- The golden set is a manual run, not part of CI (cost, time, nondeterminism). Only its scorer has CI tests.
- Sub-projects 1 to 3 need no paid source and no new account.

## 7. Not Now

- Paid data sources, TipRanks and EODHD (section 3.4).
- Offering effort `max`: the Responses API accepts it for Sol but only a real request can prove it per model, and the owner asked for `xhigh` or more, which the picker already gives.
- A replacement `read_url`: owner rejected Jina entirely on 2026-10-11. This batch disables the local/MCP tool; a safe public-page reader needs its own design with SSRF protection (private addresses, DNS rebinding, redirects).
- Changing the committee's gating to a heavier approval flow, or any trading automation.
