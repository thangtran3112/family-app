# Task 10: Ledger sections, full suite and live verification

Part of [01o-vibe-answer-integrity-plan.md](../01o-vibe-answer-integrity-plan.md). Read its Global Constraints and Test Runner first; every command runs from the repository root of the worktree.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the fork ledger (the Why paragraph, the behaviours to preserve, the expected-conflict list, a Verification section with real numbers), run the whole backend suite, and prove on the same prompts as the baseline that no run ends in the stub and figures survive with marks. Record the numbers.

**Files:**
- Modify: `ai-trading/packages/vibe-trading/DIVERGENCE.md` (the "Why", "Behaviour to preserve through a sync" and "Reapplying after a sync" sections; a new Verification section at the end)
- Modify: `ai-trading/plans/subplans/01o-vibe-answer-integrity-results.md` (append the after section)
- Modify: `ai-trading/plans/subplans/01o-vibe-answer-integrity.md` (status line only)

**Interfaces:**
- Consumes: everything from Tasks 1 to 9; the tools of Task 1 (`serve_local.sh`, `run_scenarios.py`, `grounding_report.py`).
- Produces: the finished ledger and the recorded results that Batch 1's pull request cites.

- [ ] **Step 1: Run the whole backend suite.**

```bash
vt_test tests -q -n 8
```

Expected: no failures. The earlier scratch tree, before the no-Jina revision to Task 9, had 17,502 passed and 77 skipped. Record the **new** counts; do not use the old figure as the acceptance criterion.

- [ ] **Step 2: Run the live check.** The prompts are the seven that reach the gate; they take 5 to 15 minutes each and run in parallel (about 15 minutes in total). `serve_local.sh` starts the server from this worktree's fork, so the run exercises the commits you just made.

```bash
OUT="${TMPDIR:-/tmp}/vibe-after"; HOMEDIR="${TMPDIR:-/tmp}/vibe-home-after"
rm -rf "$OUT" "$HOMEDIR"
ai-trading/tools/vibe-eval/serve_local.sh 18901 "$HOMEDIR" "$VENV" > "${TMPDIR:-/tmp}/serve-after.log" 2>&1 &
for i in $(seq 1 45); do curl -sf -m 2 http://127.0.0.1:18901/live >/dev/null && break; sleep 2; done
"$VENV/bin/python" ai-trading/tools/vibe-eval/run_scenarios.py "$OUT" --base http://127.0.0.1:18901 --conc 7 --only S02,S03,S06,S07,S08,S09,S12 --timeout-min 60
python3 ai-trading/tools/vibe-eval/grounding_report.py "$OUT" "$HOMEDIR/.vibe-trading/runs"
kill $(lsof -tiTCP:18901 -sTCP:LISTEN)
```

Expected: every run `completed`; **no `STUB`**. Most runs `clean` or `FLAGGED`. A `CUT` is acceptable only for a cut-class reason (a `proposed` level, a draft with no `figures` block, `outside_observed_range`, `symbol_mismatch`, `unsourced_symbol_figures`); check each by reading the last validation in `$HOMEDIR/.vibe-trading/runs/<run_id>/artifacts/grounding_evidence.json`. `get_stock_profile` is called on the consensus, earnings and news prompts (S02, S03, S09). Single runs vary: if one prompt misses, rerun that prompt once before concluding.

Reference only: this 2026-10-10 run had the old Jina-backed reader enabled. Task 9's no-Jina change may alter tool calls and answer contents; judge the new runs by the contract above rather than these exact figures:

| Prompt | Drafts | Issues | Outcome | `web_search` | `get_stock_profile` |
|---|---:|---:|---|---:|---:|
| S02 AMZN analyst consensus | 2 | 4 | clean | 7 | 1 |
| S03 AAPL earnings | 2 | 4 | clean | 10 | 1 |
| S06 portfolio risk | 2 | 14 | FLAGGED, 1 marked | 0 | 0 |
| S07 SPY moving-average backtest | 2 | 48 | FLAGGED, 15 marked | 0 | 0 |
| S08 MSFT covered call | 2 | 23 | FLAGGED, 10 marked | 0 | 0 |
| S09 META news | 2 | 10 | FLAGGED, 5 marked | 14 | 1 |
| S12 PLTR calibration | 2 | 7 | FLAGGED, 3 marked | 1 | 1 |

Summary: 2 clean, 5 flagged, 0 cut, 0 stub. For comparison, the baseline's ten runs: 0 clean, 0 flagged, 8 cut, 2 stub.

- [ ] **Step 3: Spot-check the flagged figures.** For three flagged answers (the covered call S08 is the richest), read five flagged figures against the tool results in the stored messages (`tool_trail`) and note for each whether it is correct. Expect most to be right and unverifiable by the gate for a known reason: a value passed through a calculator tool, a payoff or Greek computed by one, or a ref the gate does not resolve. Record `n of m correct`.

- [ ] **Step 4: Finish the ledger.** In `ai-trading/packages/vibe-trading/DIVERGENCE.md` make these four edits (the anchors exist today).

Add a paragraph to "Why". Replace:

```text
The owner also asked for the default OpenAI model to be Sol, and for temperature,
QVeris and the China data-source credentials to be removed from Settings.

## Changes
```

with:

```text
The owner also asked for the default OpenAI model to be Sol, and for temperature,
QVeris and the China data-source credentials to be removed from Settings.

Release 1 research-quality changes (2026-10-10; sub-projects 1 and 2 of
`ai-trading/plans/subplans/01n-vibe-research-quality.md`): on real US-equity runs the
grounding gate cut figures, or replaced the whole answer, for numbers it could not verify,
and none of ten runs on the previous pin finished clean. The gate now keeps and marks such
figures `(unverified※)`, its deterministic false rejections are repaired, Jina-backed
`read_url` is disabled in both local and MCP catalogs (a replacement requires a separate
design), and the profile tool returns the consensus fields it used to drop. The
reasoning effort can also be chosen per chat message. Each difference is a row below.

## Changes
```

Add behaviours 4 and 5. Replace:

```text
   China-only markets are not editable.

## Reapplying after a sync
```

with:

```text
   China-only markets are not editable.
4. A completed analysis is never replaced by the canned stub for figure-level issues. When
   the model declared its figures, those the checker could not verify are released with
   `(unverified※)` and one footnote. A `proposed` level, every failing figure of a draft
   with no figures block, a misattributed figure and any reason the fork does not list are
   cut. An identity finding, and a market answer that observed no price, still get the
   stub.
5. A currency-marked figure whose ref names one exact field is checked against that field
   when the field is a listed money leaf (`_EXACT_REF_MONEY_LEAVES`). A pooled tool or call
   ref, a ratio, a return and a count never ground a money figure.

No-Jina rule: `read_url` stays unavailable in local and MCP tool catalogs; its direct
compatibility function returns an error without HTTP. No Jina key or request path is
configured. A safe full-page reader needs a future approved design.

## Reapplying after a sync
```

Extend the expected-conflict list. Replace:

```text
Expect conflicts in `Settings.tsx`, `settings_routes.py`, `api.ts` and the locale
JSON files. Resolve in favour of upstream's structure, then restore the three
behaviours above. Then:
```

with:

```text
Expect conflicts in `Settings.tsx`, `settings_routes.py`, `api.ts` and the locale
JSON files, and in the grounding package (`release.py`, `policies.py`, `evidence.py`,
`figures.py`), `loop.py`, `context.py`, `web_reader_tool.py`, `web_search_tool.py` and
`mcp_server.py`. Resolve in favour of upstream's structure,
then restore the behaviours above, and re-run the live check of
`ai-trading/plans/subplans/01o-vibe-answer-integrity.md` section 7 (an upstream sync
already fixed some earlier false rejections, so check which repairs are still needed). Then:
```

Append a Verification section at the end of the file, replacing the plan-validation figures below with the results of Steps 1 to 3 before you commit:

```markdown
## Verification of the answer-integrity commits

Plan-validation run on 2026-10-10 against the sponsored OpenAI key (replace these
measurements with the shipping branch's run in Task 10):

- Backend: `cd agent && python -m pytest tests -q -n 8` gave 17,502 passed, 77 skipped, 0 failed.
- Live, same prompts as the baseline in `ai-trading/plans/subplans/01o-vibe-answer-integrity-results.md`, gate on, `gpt-6.1-sol` at `xhigh`: 2 clean, 5 flagged, 0 cut, 0 stub. The baseline was ten runs and none finished clean.
- Spot-check of five flagged figures in the covered-call answer against tool results: 5 of 5 correct: MSFT.US close $535.07 (market-data close and option-chain underlying), call strike $560, option bid $10.70, ask $11.60 (same option-chain row), covered-position gamma −0.7073 (−100 × pricing-tool gamma 0.007073).
- No-Jina checks: `read_url` absent from local and MCP catalogs; direct compatibility call returns `unavailable` without network; no Jina key is configured.
- Not covered: SEC statement values (XBRL concept names with `_units`, scale words such as "billion"), calculator outputs as evidence, a future safe full-page reader.
```

- [ ] **Step 5: Record the results.** Append a table to `ai-trading/plans/subplans/01o-vibe-answer-integrity-results.md` using the **actual** Step 2 output. The layout below comes from the old reader-enabled validation run; replace all row values even if the outcome labels happen to match. Also record Task 9's no-Jina catalog and no-network test results.

```markdown
## After: the same prompts with the answer-integrity changes (fork `family-app`, Tasks 2 to 9)

| Prompt | Drafts | Issues | Outcome | `web_search` | `get_stock_profile` |
|---|---:|---:|---|---:|---:|
| S02 AMZN analyst consensus | 2 | 4 | clean | 7 | 1 |
| S03 AAPL earnings | 2 | 4 | clean | 10 | 1 |
| S06 portfolio risk | 2 | 14 | FLAGGED, 1 marked | 0 | 0 |
| S07 SPY moving-average backtest | 2 | 48 | FLAGGED, 15 marked | 0 | 0 |
| S08 MSFT covered call | 2 | 23 | FLAGGED, 10 marked | 0 | 0 |
| S09 META news | 2 | 10 | FLAGGED, 5 marked | 14 | 1 |
| S12 PLTR calibration | 2 | 7 | FLAGGED, 3 marked | 1 | 1 |

Summary: 2 clean, 5 flagged, 0 cut, 0 stub. The baseline's ten runs: 0 clean, 0 flagged, 8 cut, 2 stub.
```

- [ ] **Step 6: Mark the spec.** In `ai-trading/plans/subplans/01o-vibe-answer-integrity.md`, change the status line to `**Status:** implemented in the fork (Tasks 2 to 9 of 01o-vibe-answer-integrity-plan.md); ships in Batch 1`.

- [ ] **Step 7: Commit the fork, then the superproject.**

```bash
git -C ai-trading/packages/vibe-trading add -A DIVERGENCE.md
git -C ai-trading/packages/vibe-trading commit -m "docs(family-app): ledger sections and verification for the answer-integrity changes"
git add ai-trading/plans/subplans/01o-vibe-answer-integrity-results.md ai-trading/plans/subplans/01o-vibe-answer-integrity.md
git commit -m "docs(ai-trading): results of the Vibe answer-integrity checks"
```

Do not push or move the gitlink here: Batch 1 ships both sub-projects together (Task 8 of [01p-vibe-effort-picker-plan.md](../01p-vibe-effort-picker-plan.md)).
