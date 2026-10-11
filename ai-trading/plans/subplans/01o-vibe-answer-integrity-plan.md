# Vibe Answer Integrity and Tool Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> This file is the master plan. Each task has its own file under [01o-vibe-answer-integrity-tasks/](01o-vibe-answer-integrity-tasks/); an implementer reads this file's Global Constraints and Test Runner plus their own task file. Tasks 2–8 were replayed red→green on a scratch clone. Task 9 was revised by owner on 2026-10-11 (no Jina Reader at all) and must be tested against the real fork before verification numbers are claimed.

**Goal:** A completed Vibe-Trading analysis reaches the user with its figures visible; the checker stops discarding valid work, Yahoo's existing consensus fields survive, and Jina-backed full-page reading is disabled pending a separate safe-reader design.

**Architecture:** A new `flagged_release` sits beside upstream's `redacted_release` and is called from `AgentLoop` once the revision budget is spent. Small repairs go into `figures.py`, `policies.py` and `evidence.py`; the system prompt gains structured-data guidance; `get_stock_profile` returns fields it already fetched. `read_url` is unavailable in local and MCP catalogs, with no Jina request path. Every fork change carries its `DIVERGENCE.md` row in the same commit.

**Tech Stack:** Python 3.11, pytest with xdist, the fork's `agent/src/agent/grounding` package; a shell script and two Python scripts for the eval tools.

**Spec:** [01o-vibe-answer-integrity.md](01o-vibe-answer-integrity.md). Overview and measured evidence: [01n-vibe-research-quality.md](01n-vibe-research-quality.md).

## Global Constraints

- **Fork rules** (`ai-trading/AGENTS.md`): change `packages/vibe-trading` only on its branch `family-app`; keep `packages/vibe-trading/DIVERGENCE.md` current in the same commit as every change; push the branch to the fork before the superproject's gitlink moves. This plan does not push or move the gitlink; that is the ship task of the effort-picker plan ([01p](01p-vibe-effort-picker-plan.md), Task 8), which ships both sub-projects as Batch 1.
- **What the gate still stops.** A `proposed` level, every failing figure of a draft that has no `figures` block, any reason not in `_FLAGGABLE_REASONS` (`outside_observed_range`, `symbol_mismatch`, `unsourced_symbol_figures`, and whatever a later upstream sync adds), and any figure that cannot be located are cut or release nothing, exactly as `redacted_release` behaved. An identity finding (a code outside `_REDACTABLE_CODES | _REPAIRABLE_PROVENANCE_CODES | {"figures_block_malformed"}`) and a market answer that observed no price (unless an analysis completed) release nothing, so the canned stub still applies.
- **Flagged reasons** (`release._FLAGGABLE_REASONS`, exact): `no_evidence`, `no_symbol`, `value_mismatch`, `undeclared`, `not_in_referenced_call`, `field_ref_needs_call_id`, `unknown_call_id`, `ambiguous_field_ref`, `tail_risk_needs_field_ref`, `formula_not_evaluable`, `formula_not_anchored`, `additive_operand_not_observed`, `derivation_result_mismatch`, `no_formula`, `citation_without_source`, `citation_not_visible`, `cited_as_observed`. A figure is flagged only when the draft has a `figures` block and the issue's role is not `proposed`.
- **Marks.** English: one space then `(unverified※)` after the figure and its glued currency; Chinese: `（未核验※）` attached. Model-written marks and `※` lines are stripped first, so a mark is never forged or echoed. A bare four-digit year (1900 to 2099, no currency or percent) is never marked or cut.
- **Footnote.** English: `※ N figure(s) could not be matched to this session's tool data and are marked (unverified※). The checker could not confirm them, so treat them as unchecked.` plus ` Observed OHLC range: ...` when any flagged reason is `value_mismatch`; the existing `(omitted※)` note follows when something was cut. Chinese equivalents.
- **No re-validation.** The flagged text is not re-validated (its marked figures would fail by definition). `ledger._released` becomes `{released_at, content_sha256, mode: "flagged", figures_flagged, figures_removed, revalidated: false}` and is persisted in `artifacts/grounding_evidence.json`.
- **Events.** With a flagged figure the loop emits the trace event `answer_released_flagged` and `grounding_status` stage `released_flagged` (with `flagged` and `removed`); with none flagged the legacy `answer_released_redacted` and `released_redacted`, and their reason text, are unchanged. The run stays `degraded: true`.
- **Repairs.** R2: a sign before the currency mark is the value's sign. R3: a percent figure whose formula has a literal `100` operand is also compared in points. R5: a currency-marked figure may quote a leaf of `_EXACT_REF_MONEY_LEAVES` through a ref that names that exact field, and the operands of a money-derived figure may be any observed money leaf of its symbol; a pooled tool or call ref, a ratio, a return and a count never ground a money figure, and the percent filter is unchanged. **R4 (resolving `tool::field` when the tool ran once) is deliberately not implemented:** upstream pins the opposite in `tests/test_grounding_unknown_call_id_refs.py` ("a known tool keeps its existing correction reason") and in `_tool_field_ref_candidates` ("the hint never selects a call"), and one extra draft does not justify forking it.
- **Out of scope.** Grounding SEC statement values (XBRL concept names with a `_units` map, and scale words such as "billion"); making artifact files or calculator outputs evidence; a kind-agnostic match for pooled refs; a direct-fetch reader fallback (needs an SSRF guard); changing `MAX_GROUNDING_REVISIONS`; styling the marks in the UI.
- **No Jina** (owner, 2026-10-11): do not add `JINA_API_KEY`, call `r.jina.ai`, or replace it with an arbitrary direct fetch. Hide `read_url` from local and MCP tool catalogs and keep direct calls inert. A future safe reader needs its own design.
- **Tests** live in `agent/tests`, are offline (Yahoo is mocked, no network), and use `pytestmark = pytest.mark.unit` where the module has no marker. Never print, log or commit a secret.

## Review Focus

The inputs and conditions most likely to bite a person using this, with the test that pins each:

1. **A flagged figure inside a markdown table row** must leave the row intact (`test_a_table_cell_keeps_its_row_intact`, Task 5).
2. **The same figure twice** (a sentence and a table) is marked at each place and counted twice (`test_a_figure_repeated_in_prose_and_in_a_table_is_marked_at_each_place`, Task 5).
3. **A currency written after the figure** (`331.53 USD`) is marked after the currency, not between figure and word (`test_a_currency_written_after_the_figure_is_marked_after_the_currency`, Task 5).
4. **A model that writes its own `(unverified※)` marks or a `※` footnote** is stripped, never echoed or counted (`test_a_model_written_mark_is_stripped_not_echoed`, Task 5).
5. **A draft with no `figures` block at all**, which an upstream-style model produces when it forgets the contract, is still cut, so the invented price the gate exists to stop never gets a mark that reads as mild (`test_a_draft_without_a_figures_block_is_cut_as_before`, Task 5; loop-level in `test_loop_releases_the_redacted_draft_instead_of_the_canned_refusal`, upstream's own test, which must keep passing in Task 6).

## File Structure

| Path (under `ai-trading/` unless noted) | Responsibility | Task |
|---|---|---|
| `tools/vibe-eval/` (new) | Scenario runner, outcome report, local server script, README and the report's test | 1 |
| `plans/subplans/01o-vibe-answer-integrity-results.md` (new) | Baseline and after numbers | 1, 10 |
| `packages/vibe-trading/agent/src/agent/grounding/figures.py` | Declaration parsing: sign before the currency mark | 2 |
| `.../grounding/policies.py` | Percent notes with a literal 100; exact-ref money leaves; derived anchors | 3, 4 |
| `.../grounding/evidence.py` | `_EXACT_REF_MONEY_LEAVES`, `_is_exact_ref_money_leaf` | 4 |
| `.../grounding/release.py`, `.../grounding/ledger.py` | `flagged_release`, marks, notes, `figures_flagged` | 5 |
| `.../agent/loop.py` | Calls `flagged_release`; events and reason text | 6 |
| `.../agent/context.py` | Three prompt sentences | 7 |
| `.../tools/stock_profile_tool.py` | Revenue range, extra revision counts, `earnings_history` | 8 |
| `.../tools/web_reader_tool.py`, `agent/mcp_server.py`, `.../tools/web_search_tool.py` | Disable Jina requests and reader exposure; remove stale tool guidance | 9 |
| `packages/vibe-trading/DIVERGENCE.md` | One Backend row per change; behaviours to preserve; verification | 2 to 10 |
| `.../agent/tests/` | One new or extended test module per task | 2 to 9 |

## Test Runner

Code-step blocks include literal unified diffs. Their single-space context lines are required by `git apply`; `git diff --check` may report those lines as Markdown trailing whitespace.

Define once per shell, from the repository root of the worktree (`.worktrees/vibe-evals`). `VENV` is a Python 3.11 virtualenv with the fork's lock installed; the one already built for this effort is `/private/var/folders/_1/050mzm_167bd175pmv0rfhz40000gn/T/opencode/vibe-venv2`.

```bash
export VT=ai-trading/packages/vibe-trading
export VENV=/private/var/folders/_1/050mzm_167bd175pmv0rfhz40000gn/T/opencode/vibe-venv2
vt_test() { local h; h="$(mktemp -d)"; (cd "$VT/agent" && PYTHONPATH="$PWD" HOME="$h" VIBE_TRADING_HOME="$h/.vibe-trading" "$VENV/bin/python" -m pytest -p no:cacheprovider "$@"); }
```

To build the virtualenv from scratch (the lock changed in the upstream sync, so an older one is stale; `pytest-xdist` is not in the fork's dev extras but the verification commands use it):

```bash
python3.11 -m venv "$VENV"
"$VENV/bin/pip" install -q --upgrade pip
(cd "$VT" && "$VENV/bin/pip" install -q -r requirements-lock.txt && "$VENV/bin/pip" install -q -e '.[dev,openbb,stats,anthropic]' pytest-xdist)
```

## Prerequisites

- The worktree `.worktrees/vibe-evals` is on branch `feature/vibe-evals`, merged with `origin/dev`, and `ai-trading/packages/vibe-trading` is checked out on branch `family-app` at `d402c2df` or a later commit that contains it (`git -C ai-trading/packages/vibe-trading status --short --branch`, then `git -C ai-trading/packages/vibe-trading log --oneline -1`). If `origin/dev` moved the pin, rerun Task 2's red step first; any diff that no longer applies is a sign the upstream sync touched that code.
- `common/config/family_config.py` can read Firestore (needed only by Task 1's smoke test and Task 10's live check).

## Tasks

| # | Task | Ships |
|---|---|---|
| 1 | [Eval tooling and the recorded baseline](01o-vibe-answer-integrity-tasks/task-01-eval-tooling-and-baseline.md) | superproject |
| 2 | [Read a sign written before the currency mark](01o-vibe-answer-integrity-tasks/task-02-signed-currency-declarations.md) | fork |
| 3 | [Compare a percent whose note already multiplies by 100](01o-vibe-answer-integrity-tasks/task-03-percent-notes.md) | fork |
| 4 | [Let an exact field ref ground a money-valued leaf](01o-vibe-answer-integrity-tasks/task-04-exact-field-money-refs.md) | fork |
| 5 | [flagged_release: keep and mark the figures the gate could not verify](01o-vibe-answer-integrity-tasks/task-05-flagged-release.md) | fork |
| 6 | [Release the flagged draft from the loop](01o-vibe-answer-integrity-tasks/task-06-loop-release.md) | fork |
| 7 | [Tell the model how to file web numbers and which tools to open with](01o-vibe-answer-integrity-tasks/task-07-prompt-guidance.md) | fork |
| 8 | [get_stock_profile keeps the revenue range and adds EPS surprise history](01o-vibe-answer-integrity-tasks/task-08-profile-data.md) | fork |
| 9 | [Disable Jina-backed read_url everywhere](01o-vibe-answer-integrity-tasks/task-09-disable-reader.md) | fork |
| 10 | [Ledger sections, full suite and live verification](01o-vibe-answer-integrity-tasks/task-10-ledger-and-verification.md) | fork and superproject |

Order matters only where an interface says so: Task 6 consumes Task 5; Task 8's new field names are already in Task 4's allow-list; everything else is independent, and each task ends with its own commit so a reviewer can reject one and approve its neighbour.

## Done When

Task 10's live check on the same prompts shows what spec section 1 asks: no run ends in the stub, runs keep their figures with marks where the gate could not verify them, only the cut-class reasons are cut, `get_stock_profile` is used on the consensus, earnings and news prompts, and the results are recorded in [01o-vibe-answer-integrity-results.md](01o-vibe-answer-integrity-results.md). The backend suite passes, and every fork commit carries its ledger row.

## Task Briefs

The executor's `task-start` script extracts these headings. Each linked file is the **full** brief; read it after `task-start` before editing.

### Task 1: Eval tooling and baseline
Full brief: [task-01-eval-tooling-and-baseline.md](01o-vibe-answer-integrity-tasks/task-01-eval-tooling-and-baseline.md).

### Task 2: Signed currency declarations
Full brief: [task-02-signed-currency-declarations.md](01o-vibe-answer-integrity-tasks/task-02-signed-currency-declarations.md).

### Task 3: Percent notes
Full brief: [task-03-percent-notes.md](01o-vibe-answer-integrity-tasks/task-03-percent-notes.md).

### Task 4: Exact field money refs
Full brief: [task-04-exact-field-money-refs.md](01o-vibe-answer-integrity-tasks/task-04-exact-field-money-refs.md).

### Task 5: Flagged release
Full brief: [task-05-flagged-release.md](01o-vibe-answer-integrity-tasks/task-05-flagged-release.md).

### Task 6: Loop release
Full brief: [task-06-loop-release.md](01o-vibe-answer-integrity-tasks/task-06-loop-release.md).

### Task 7: Prompt guidance
Full brief: [task-07-prompt-guidance.md](01o-vibe-answer-integrity-tasks/task-07-prompt-guidance.md).

### Task 8: Profile data
Full brief: [task-08-profile-data.md](01o-vibe-answer-integrity-tasks/task-08-profile-data.md).

### Task 9: Disable Jina reader
Full brief: [task-09-disable-reader.md](01o-vibe-answer-integrity-tasks/task-09-disable-reader.md).

### Task 10: Ledger and live verification
Full brief: [task-10-ledger-and-verification.md](01o-vibe-answer-integrity-tasks/task-10-ledger-and-verification.md).
