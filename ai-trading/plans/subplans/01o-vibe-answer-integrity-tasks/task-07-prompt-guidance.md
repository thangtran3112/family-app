# Task 7: Tell the model how to file web numbers and which tools to open with

Part of [01o-vibe-answer-integrity-plan.md](../01o-vibe-answer-integrity-plan.md). Read its Global Constraints and Test Runner first; every command runs from the repository root of the worktree, with `vt_test` defined as in the Test Runner section.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The system prompt says that a number read in a `web_search` result is `cited`, never `observed` (all 33 `no_evidence` issues were such numbers), that a value passed into a calculator tool is that tool's input and not an observation (a covered-call answer cited a payoff tool's input echo as the source of the market price), and that US-equity research opens with structured tools. `read_url` is disabled in Task 9; do not tell the agent to use it.

**Files:**
- Modify (append a test): `ai-trading/packages/vibe-trading/agent/tests/test_agent_output_discipline.py`
- Modify: `ai-trading/packages/vibe-trading/agent/src/agent/context.py` (`_SYSTEM_PROMPT`)
- Modify: `ai-trading/packages/vibe-trading/DIVERGENCE.md` (one Backend row)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: three sentences in `context._SYSTEM_PROMPT`: the `cited` rule and the calculator-input rule inside the figures instructions, and one working-rule bullet for US equities. The existing test `test_every_figures_example_in_the_system_prompt_parses` must keep passing (no figures example changes).

- [ ] **Step 1: Write the failing test.** Append this to `agent/tests/test_agent_output_discipline.py` (it already imports `_SYSTEM_PROMPT`):

```python
def test_the_prompt_files_web_numbers_as_cited_and_prefers_the_structured_us_tools() -> None:
    """All 33 `no_evidence` rejections in six real US-equity runs were `web_search` numbers
    declared `observed`, and `web_search` was 73 of 368 tool calls while the structured
    tools that already hold consensus, targets and estimates sat unused."""
    flat = " ".join(_SYSTEM_PROMPT.split())

    assert "A number read in a `web_search` result is `cited`, never `observed`" in flat
    assert "For US equities, start with the structured tools" in flat
    assert "A value you passed into `options_payoff`, `options_pricing` or `financial_rigor` is that tool's input" in flat
    assert flat.index("`get_stock_profile`") < flat.index("use `web_search` only for what they do not return")
```

- [ ] **Step 2: Run the file and confirm the new test fails.**

```bash
vt_test tests/test_agent_output_discipline.py -q
```

Expected: `1 failed, 62 passed`.

- [ ] **Step 3: Implement it.**

Save the diff to a file and apply it (or make the same edits by hand; the hunks are exact):

```bash
cat > "${TMPDIR:-/tmp}/task-07.patch" <<'PATCH'
diff --git a/agent/src/agent/context.py b/agent/src/agent/context.py
index f8d83b9..26715b6 100644
--- a/agent/src/agent/context.py
+++ b/agent/src/agent/context.py
@@ -225,7 +225,12 @@ Decide which workflow to use based on the request:
   the observed price range, or with a formula over observed values in `note`; a
   percentage is not a level, so state the price it implies;
   `cited` — from a source other than this session's tools: name the source in the
-  same sentence as the figure, and in `note`;
+  same sentence as the figure, and in `note`. A number read in a `web_search`
+  result is `cited`, never `observed`: it returns text, not
+  checked values. A value you passed into `options_payoff`, `options_pricing` or
+  `financial_rigor` is that tool's input, not an observation: declare it from the
+  tool that returned it (`get_market_data`, `get_options_chain`, ...), and declare
+  what the calculator computes as `derived` with its formula;
   `count` — a count, weight, threshold, window, probability or other parameter
   you chose, never a price or an amount. Plain integers, dates and security
   codes need no line. Example (zh):
@@ -255,6 +260,7 @@ Decide which workflow to use based on the request:
   figures to a symbol this session never handled, is rejected and handed back to
   you with the specific conflict — it never reaches the user.
 - Load the relevant skill BEFORE starting any task, after any required identity resolution. Skills contain the exact API contracts and examples.
+- For US equities, start with the structured tools: `get_stock_profile` (analyst consensus, price targets, EPS and revenue estimates), `get_financial_statements`, `get_sec_filings` and `get_stock_news`; use `web_search` only for what they do not return.
 - Ask the user if critical info is missing (assets, dates, strategy type). Never guess.
 - Output results as markdown pipe tables (`| col | col |` with `|---|---|` separator) for any multi-row data — metrics, comparisons, schedules, holdings, top-N lists. Renderers upgrade these to native tables. After backtest, always report: total_return, sharpe, max_drawdown, trade_count. Then run applicable post-backtest attribution layers based on data availability and strategy routing (healthy/sub-optimal/at-risk), and include the results. Attribution is secondary — strategy correctness always comes first.
 - Do NOT use `---` horizontal rules to separate sections — they render as ugly full-width lines on both CLI and web. Use `##` / `###` markdown headings instead.
PATCH
```

```bash
git -C ai-trading/packages/vibe-trading apply "${TMPDIR:-/tmp}/task-07.patch"
```

- [ ] **Step 4: Run the prompt-related tests.**

```bash
vt_test tests/test_agent_output_discipline.py tests/test_grounding_figures_contract.py tests/test_context_attribution_layers.py -q
```

Expected: `63 passed` for the first file and no failures in the others.

- [ ] **Step 5: Add the ledger row.**

Insert the row below into the **Backend** table of `ai-trading/packages/vibe-trading/DIVERGENCE.md`, immediately above the row that starts with ``| `tests/test_settings_api.py` |`` (so rows stay in task order):

```markdown
| `agent/src/agent/context.py` | Three additions to the system prompt: a number read in a `web_search` result is `cited`, never `observed` (the Jina-backed `read_url` is disabled); a value passed into `options_payoff`, `options_pricing` or `financial_rigor` is that tool's input, not an observation, so it is declared from the tool that returned it; for US equities start with `get_stock_profile`, `get_financial_statements`, `get_sec_filings` and `get_stock_news` and use `web_search` only for what they lack. Tests: `tests/test_agent_output_discipline.py`. | All 33 `no_evidence` rejections in six real runs were `web_search` numbers declared `observed`; `web_search` was 73 of 368 tool calls; a covered-call answer cited a payoff tool's input echo as the source of the market price. |
```

- [ ] **Step 6: Commit.**

```bash
git -C ai-trading/packages/vibe-trading add agent/src/agent/context.py agent/tests/test_agent_output_discipline.py DIVERGENCE.md
git -C ai-trading/packages/vibe-trading commit -m "feat(family-app): file web numbers as cited and prefer the structured US-equity tools"
```
