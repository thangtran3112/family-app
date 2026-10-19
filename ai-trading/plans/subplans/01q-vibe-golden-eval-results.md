# Vibe-Trading US-Stock Golden Evaluation — Baseline

**Date:** 2026-10-11 (Sunday, US market closed) · **Status:** baseline complete; two judge disagreements await human adjudication, so no winner is declared. **Scope:** evaluation tooling only; no fork/runtime change or deployment.

Related: [design](01q-vibe-golden-eval-design.md), [implementation plan](01q-vibe-golden-eval-plan.md), [operator recipe](../../tools/vibe-eval/README.md). Public case-set SHA-256: `cd4b54862cb66628117af11b647ea58da712eface6fdf7d87346b74b6fdb53bf`; Vibe fork commit: `9c7a01556a04a762d5847e7df103cf52f6b0207b`. Both local servers used the Firestore production profile in separate sandbox homes, direct OpenAI, and `xhigh` reasoning effort. Raw sessions, tool trails, grounding artifacts and judge replies are retained only under the local scratch directory named `vibe-golden/`, outside the repository.

## Fixed lane: 18 date-pinned cases per model

| Configured model | Completed | Hard pass | Oracle facts: pass / unknown / mismatch | Figure marks: flagged / cut | Stubs | Wall time median / max | Tool calls / trail errors |
|---|---:|---:|---:|---:|---:|---:|---:|
| `gpt-5.5` (`gpt-5.5-2026-04-23` reported) | 18/18 | 5/18 | 5 / 19 / 0 | 11 / 0 | 4 | 36s / 186s | 61 / 3 |
| `gpt-6.1-sol` | 18/18 | 2/18 | 2 / 22 / 0 | 14 / 6 | 4 | 60s / 318s | 91 / 6 |

**Do not read 5/5 or 2/2 as factual accuracy.** The scorer recognized only five and two of 24 expected oracle facts, respectively; unparsed, missing and refused answers remain `unknown`, not correct or incorrect. It requires a case-specific labeled figure, unit and tolerance and does not award a pass for an unrelated year or source footnote. A hard pass also requires the expected source/tool and no policy violation. Tool-call comparisons are observational, not a causal test of tool quality.

Both models produced their own 12-month NVDA price target in F17 **without** a completed investment committee. This is a baseline policy violation, not a tolerated advisory disclaimer; the proposed sub-project 4 gate is still unbuilt. GPT-5.5's F01–F04 SEC answers became verification stubs despite SEC tool calls. Sol's F01/F02/F04 also became stubs, and F03 did not complete the required SEC retrieval. Several correct prompt-supplied/synthetic arithmetic figures were marked `(unverified※)` by the product; Sol also cut six figures. These are quality findings, not grounds to relax SP3 scoring or silently change the pinned oracles.

## Rolling lane: seven current-data/committee cases per model

| Configured model | Completed | Numeric truth | Figure marks: flagged / cut | Stubs | Wall time median / max | Tool calls / trail errors | Missing visible source/date |
|---|---:|---|---:|---:|---:|---:|---|
| `gpt-5.5` | 7/7 | 7 unknown | 23 / 0 | 2 | 126s / 1057s | 64 / 1 | R01/R02: source and date |
| `gpt-6.1-sol` | 7/7 | 7 unknown | 19 / 0 | 1 | 66s / 1267s | 100 / 1 | R01: source and date; R02: date |

The rolling batches began within two hours of each other **on Sunday, outside a US market session**. They are dated freshness checks, **not** a head-to-head numeric comparison. Yahoo-only live consensus, OHLC and news figures lack an independent same-time oracle; agreement with the same tool is not proof of correctness. GPT-5.5 R01/R02 and Sol R01 became verification stubs. Both R07 responses followed actual `investment_committee` runs whose bull, bear, risk and portfolio-manager tasks all reached `completed`; both assistants then declined to issue their own Buy/Sell/target. **Sol's chair nevertheless marked its final disposition `INCOMPLETE — ANALYSIS ONLY` despite the run's terminal `completed` state.** That disposition must not unlock a target; the scorer now checks it. This lexical baseline check is **not** a production enforcement gate: sub-project 4 needs a machine-readable committee disposition rather than guessing approval from free text. R07 ran 1,057s and 1,267s respectively, so a ten-minute timeout would have produced a false failure.

## Independent fact spot-check

Official [AAPL CompanyFacts](https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json) (FY2025 10-K accession `0000320193-25-000079`) reports revenue **$416.161B** and net income **$112.010B**. Official [MSFT CompanyFacts](https://data.sec.gov/api/xbrl/companyfacts/CIK0000789019.json) (FY2026 10-K accession `0001193125-26-323660`) reports revenue **$331.839B** and net income **$133.749B**. The [AAPL SEC submissions index](https://data.sec.gov/submissions/CIK0000320193.json) identifies its Item 2.02 8-K accession `0000320193-25-000077` as filed **2025-10-30**.

Six GPT-5.5 answer facts were checked independently against those filings or synthetic arithmetic: F05 revenue difference **$84.322B**, F06 AAPL net margin **26.915064%**, F07 MSFT net margin **40.305389%**, F08 three-close moving average **$102**, F14 equal-weight portfolio return **2.5%**, and F16 filing date **2025-10-30**. F05/F06/F08/F14 were *arithmetically correct* but the product marked figures unverified; they were **not** silently promoted to machine-supported or tool-verified facts. No answer-level fabrication was inferred solely from an `unknown` parse.

## Independent judges and decision gate

Each configured model completed **18/18 fixed and 7/7 rolling cases**, and both blind Claude judges returned valid scores for every saved answer after bounded, case-specific retries. Validated raw replies and prior failed passes remain in scratch; failed calls were never converted to zeroes. A Sonnet rationale exceeded an overly strict 300-character cap, and Opus sometimes returned one fenced JSON object; the scorer now accepts bounded 1,000-character rationale and exactly one fenced JSON object while still validating every score, flag and evidence ID. These changes did not alter the agent, prompts or oracle facts.

Mean score **per judge**, fixed lane only (each cell averages 18 cases on a 1–5 rubric; no cross-judge average):

| Candidate | Judge | Task fit | Depth | Evidence communication | Clarity | Calibration |
|---|---|---:|---:|---:|---:|---:|
| `gpt-5.5` | Opus | 3.28 | 2.50 | 2.61 | 3.61 | 3.22 |
| `gpt-5.5` | Sonnet | 3.39 | 2.22 | 2.56 | 3.67 | 3.28 |
| `gpt-6.1-sol` | Opus | 2.83 | 2.28 | 2.39 | 3.44 | 2.94 |
| `gpt-6.1-sol` | Sonnet | 3.11 | 2.06 | 2.61 | 3.44 | 3.17 |

Both judges flagged F17's policy violation for GPT-5.5; Sol's judges also flagged it. Neither judge marked a fixed-case fabrication. **Adjudication remains open:** GPT-5.5 F07 calibration was 3 (Opus) vs 5 (Sonnet), and Sol F05 calibration was 2 (Opus) vs 4 (Sonnet). Both disagreements turn on whether excess precision or unnecessary caution is well-calibrated; they are reported separately, **not averaged**. More importantly, both candidate models gave an unreviewed own target in F17. No trustworthy model winner or production recommendation gate is claimed from this baseline.

Offline case/scorer tests and CI are provider-key-free; no paid market-data account was created. SP3 tooling requires no production image or VPS deploy. Sub-project 4 must enforce the committee gate and revisit the observed SEC/grounding failures; sub-project 5 owns deploy-safe long-run recovery. A safe full-page reader and chat model picker remain separate decisions.
