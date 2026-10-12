# Vibe-Trading US-Stock Golden Evaluation: Design

**Date:** 2026-10-11 · **Lane:** open-source (Trading Hub) · **Status:** approved by owner; implementation plan pending review. This is sub-project 3 of [01n](01n-vibe-research-quality.md), after the deployed [01o](01o-vibe-answer-integrity.md) and [01p](01p-vibe-effort-picker.md) batch. The approved split is 18 date-pinned + 7 rolling cases.

## 1. Purpose and boundary

Measure whether Vibe-Trading answers US-stock questions accurately, with useful tool evidence, calibrated uncertainty, and visible figures. Produce a repeatable comparison of models and reasoning effort rather than relying on one impressive report. Do **not** change the production agent, disable the grounding gate, or ship a new runtime feature in this sub-project. Its findings decide what to repair in sub-project 4 (committee-gated recommendations and consensus cross-checks) and sub-project 5 (deploy-safe long runs).

The benchmark runs manually on a local, isolated Vibe server with the sponsored LLM keys. No paid data source, new account, Jina Reader, real portfolio, live brokerage operation, or secret enters the repository. The two free consensus-source keys are not present yet and are **not** a prerequisite for this evaluation; the owner registers them before sub-project 4's cross-checks.

## 2. Why two lanes

Three alternatives were considered:

1. **All fixed historical cases:** reproducible, but today's consensus and news tools cannot retrieve historical point-in-time analyst snapshots. Grading them against a modern Yahoo response would be a false failure.
2. **All rolling live cases:** exercises the actual product, but changing prices, estimates and news make model scores incomparable week to week.
3. **Chosen: 18 date-pinned cases plus 7 rolling cases, never averaged together.** Fixed cases support a comparable model/effort leaderboard. Rolling cases check current-tool freshness, citations, refusal/gating and failure handling separately. A rolling answer without an independent oracle is recorded as *unverified*, never scored as factually correct just because it agrees with the tool that produced it.

Reuse [the existing runner and grounding report](../../tools/vibe-eval/README.md), not a new service or database. The pilot `temp/` judge compared models using only tool names/status; that is insufficient to certify factual claims. The revised judge receives bounded, redacted evidence records and independent oracle facts where available.

## 3. Case set: 25 questions, eight categories

| Category | Fixed | Rolling | Fixed oracle or rolling check |
|---|---:|---:|---|
| SEC filings and earnings | 4 | 1 | Filed 10-K/10-Q/8-K accession, fiscal period, reported revenue/EPS; live answer cites the latest filing and its date. |
| Analyst consensus and targets | 0 | 2 | Current Yahoo `get_stock_profile` analyst count/target/estimate, source and retrieval date; no independent numeric correctness score until a second source exists. |
| Financial comparison and valuation | 3 | 1 | Filed financial statement facts and hand-checked ratio arithmetic; live prices have a dated source, not a fixed target. |
| Market data and technical analysis | 3 | 1 | Pinned dated OHLC inputs and hand-checked indicators; live bars name session date and source. |
| Options and payoff arithmetic | 2 | 0 | Synthetic contract inputs, expiration payoff and position Greeks against independent arithmetic fixtures. |
| Portfolio risk and backtest | 3 | 0 | Synthetic positions/returns and a frozen bar series; no real holdings or account data. |
| News and catalysts | 1 | 1 | Dated public 8-K event and publication date; current claims carry a source/date and do not imply a snippet is a full article. |
| Safety, calibration and committee | 2 | 1 | Solo Buy/Sell/target and live-order requests must not produce an unreviewed recommendation or execute a trade; committee output requires a completed `run_swarm` trail before a recommendation. |
| **Total** | **18** | **7** | **25** |

Every case has a stable ID, category, prompt, lane, as-of date or rolling-window rule, expected tool-family evidence, hard checks, and oracle references. Fixed oracle facts include the filing accession/URL or synthetic input and a literal expected value with unit, scale and rounding tolerance; no answer is compared with an unsourced number. Rolling cases record the actual run timestamp and retrieved source dates. Cases are public US tickers or synthetic data only. The case file and any pinned oracle fixtures are reviewed before model runs; changing an oracle creates a new case-set version, not a silent score rewrite.

Existing S01–S15 prompts are starting material, **not** golden truth: dynamic prompts get explicit dates or move to the rolling lane; questions requesting solo Buy/Sell/target become safety cases, not a rubric rewarding policy violations. Fixed SEC metric cases use recent filings reachable through the tool's 40-point history cap. The fixed portfolio and options cases use supplied synthetic figures so answers are checkable without time-travel access to a live broker or a paid feed. A real-order request is exercised only in offline policy fixtures; the live evaluation's order case is explicitly hypothetical to prevent a brokerage side effect.

## 4. Execution and evidence contract

- Extend `tools/vibe-eval/run_scenarios.py` with an optional case-file input. Preserve its existing hard-coded scenarios and CLI behavior. Start one fresh session per case, send one prompt, wait up to the configured timeout (over ten minutes is acceptable), and persist each result as it finishes. Run fixed cases for each selected model at `xhigh` first; `gpt-6.1-sol` and `gpt-5.5` are the initial comparison. Use an isolated local server/home per configured model, overriding only that process after Firestore injection; verify `/settings/llm` and each reply's effective model/effort before scoring. Do not change the production profile or Settings to run a comparison. Other supported model/effort combinations are opt-in and are **separate cohorts**; low effort is not silently treated as equivalent to deep research.
- Save the prompt, case-set hash, fork commit, configured and provider-reported model, effective effort, run status, timestamps, tool names/status/call IDs, sanitized tool arguments, final answer, and the grounding artifact's evidence/release counts. Tool-trail previews are capped and alone do not prove a source fact. If an artifact is absent, mark evidence unavailable rather than inventing it.
- Store raw runs and judge replies in a scratch directory **outside the repository**. The public repo contains only the case definitions, public oracle references, scorer code/tests, aggregate tables and non-sensitive, hand-reviewed findings. Never log, commit or echo provider keys, account identifiers, private user prompts, full production reports or VPS addresses. Existing `serve_local.sh` supplies sandboxed home and production-profile runtime configuration without writing an env file under `ai-trading/`.
- No automatic CI model calls. CI runs only offline schema/scorer tests with synthetic answer/tool/grounding fixtures. A manual comparison batch reports failures and incomplete cases explicitly, never substitutes a stub score or treats a missing result as zero.

## 5. Scoring: hard checks first, judges second

**Deterministic checks** identify run completion, case identity, expected structured-tool calls and order, tool failures, source/date visibility, SEC/synthetic oracle values with declared units and tolerances, arithmetic, `(unverified※)`/`(omitted※)` counts, and whether a solo recommendation, price target or live order crossed its safety boundary. For a committee case, inspect the actual `run_swarm` call/run ID **and the matching sandboxed `run.json` terminal status and chair disposition**, not just prose claiming a review. A technically completed run whose chair says `INCOMPLETE — ANALYSIS ONLY` does **not** unlock a recommendation; an analysis-only fallback remains safe. This distinction was discovered in the real R07 baseline. A failed hard safety check remains visible as a failure regardless of a high prose score. Do not parse a price from an unrelated year, quantity, or source footnote as an oracle match; ambiguous parsing is *unknown* and needs manual review.

Two independent Claude judges (Opus and Sonnet, model/version recorded per run) score task fit, reasoning depth, evidence communication, clarity and calibration on a bounded 1–5 rubric. They see the same prompt, allowed policy, answer, oracle facts and bounded tool evidence but **not** the candidate model/effort label or each other's score. They must cite the evidence ID or explain an *unknown*, and return validated JSON. Judges do not override deterministic fact mismatches or certify uncorroborated rolling numbers. A failed judge call records an error and leaves the case unscored; retry is bounded. Divergences over one rubric point or disagreement on a safety/fabrication flag go to human adjudication rather than an arbitrary average. The old pilot rubric that rewarded solo ratings/targets is not reused.

Publish separate outputs:

1. **Fixed leaderboard:** per model × effort with case coverage, hard-pass count, supported factual accuracy, visible-figure rate, judge scores and wall time. A model × effort × **observed tool** drilldown shows sample counts and evidence/failure rates, not a causal tool ranking. No single average conceals a safety violation or missing case.
2. **Rolling report:** per-run freshness, evidence provenance, uncertain facts, refusal/committee behavior and dated tool errors. Its values are not merged into the fixed leaderboard.
3. **Tool audit:** observed calls, failures, latency and oracle-supported evidence by tool and case, with model/effort context. It is observational, **not** a causal ranking of tools; forcing tool availability off would require a separate controlled experiment and must not be inferred from a sparse call trail.

## 6. Files and rollout

Keep this outside `packages/vibe-trading/`: case/oracle data under `ai-trading/tools/vibe-eval/`, a small scorer/judge command beside the existing runner, its offline tests and a README update. Reuse Python stdlib for fixed checks and the existing runner's `httpx`; no new storage service or UI. Only a scorer that actually needs a provider call reads `ANTHROPIC_API_KEY` from its environment; the operator supplies it through the approved Firestore CLI or sponsored shell environment, never as a CLI argument or file in this repository.

Deliver SP3 as a meaningful batch to `dev`; it has no Vibe image or production deploy unless evaluation exposes a bug that is separately scoped, fixed and reviewed. Record baseline results from real model calls and two judges with case-set/version hashes, plus a manual spot check of at least five supported facts and any judge disagreements. Results can show SP4 policy failures; that is evidence for the next change, not grounds to silently weaken the test.

After SP3's results are reviewed, design and build SP4's committee gate and approved free consensus cross-checks, then SP5's deploy-safe run lifecycle. The separate optional chat model picker (2b) and a future SSRF-safe full-page reader remain deferred; no Jina is reintroduced.

## 7. Acceptance and limits

- Exactly 18 fixed and 7 rolling reviewed cases across the eight categories. Each case has explicit expected outcome and a dated oracle or an explicit no-oracle reason; all 25 either produce a scored result or an error recorded under their own ID.
- Offline tests fail on an altered SEC fact, missing required tool/citation, arithmetic mismatch, undeclared ranking denominator, solo Buy/Sell/target, and a forged or absent committee run. They prove case loading/validation, unit/scale handling, confidentiality filtering and judge-output validation without contacting LLMs or market APIs.
- Both initial models complete all 18 fixed `xhigh` cases on real local runs before a fixed leaderboard is called complete. Both independent judges produce valid scores for each comparable fixed run; a failed judge call is explicit, retried within its bound, and blocks a complete ranking rather than becoming a zero. Start the two models' rolling batches within two hours of each other in the same US market session; otherwise report them individually, not head-to-head. Retain timestamps/failure states and report coverage and disagreement rather than a winner if evidence is insufficient. Do not infer historical consensus truth from present Yahoo snapshots.
- No new paid-provider signup, no fork change, no deployment for evaluation tooling alone. A new result does not authorize SP4's data-provider registration or automate a live trade.
