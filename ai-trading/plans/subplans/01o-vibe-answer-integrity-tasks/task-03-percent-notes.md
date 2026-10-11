# Task 3: Compare a percent whose note already multiplies by 100

Part of [01o-vibe-answer-integrity-plan.md](../01o-vibe-answer-integrity-plan.md). Read its Global Constraints and Test Runner first; every command runs from the repository root of the worktree, with `vt_test` defined as in the Test Runner section.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A derived percent written as `(260.50 / 258.10 - 1) * 100` is compared in percentage points as well as the existing fraction reading. The checker used to scale its result a second time ("evaluates to 93%"): 16 issues in six real runs.

**Files:**
- Create: `ai-trading/packages/vibe-trading/agent/tests/test_grounding_percent_notes.py`
- Modify: `ai-trading/packages/vibe-trading/agent/src/agent/grounding/policies.py` (`_check_derived`)
- Modify: `ai-trading/packages/vibe-trading/DIVERGENCE.md` (one Backend row)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `_check_derived` accepts a percent figure when its formula has a literal `100` operand and its result, in points, matches the written figure. A formula without a `100` operand, and a figure that misses its own formula, behave as before.

- [ ] **Step 1: Write the failing test module.** Create `agent/tests/test_grounding_percent_notes.py`:

````python
"""A percent whose note already multiplies by 100 (family-app fork).

``(260.50 / 258.10 - 1) * 100`` states 0.93 percentage points. The gate read the
formula's result as a fraction and scaled it a second time ("evaluates to
93%"), so a correct derived percent cost a revision round and, once the
revisions ran out, cost the user the figure (16 issues in six real runs).
Both spellings are pinned, and so is the wrong number under the same formula.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.agent.grounding import GroundingLedger, ValidationResult

pytestmark = pytest.mark.unit

SYMBOL = "AMZN.US"
HDR = "AMZN.US (Yahoo, USD) closed at 260.50 on 2026-10-09."
CLOSE = "260.50 | observed | AMZN.US close 2026-10-09 | prices"
PRIOR = "258.10 | observed | AMZN.US close 2026-10-08 | prices"


def _market_payload() -> str:
    return json.dumps(
        {
            SYMBOL: [
                {"trade_date": "2026-10-08", "open": 253.78, "high": 259.0, "low": 253.0, "close": 258.1, "volume": 1},
                {"trade_date": "2026-10-09", "open": 258.0, "high": 262.8, "low": 257.0, "close": 260.5, "volume": 1},
            ],
            "_provenance": {
                SYMBOL: {
                    "source": "yahoo",
                    "requested_source": "auto",
                    "detected_source": "yahoo",
                    "fallback_used": False,
                    "currency_conversion": "none",
                }
            },
        }
    )


def _ledger(tmp_path: Path) -> GroundingLedger:
    ledger = GroundingLedger(run_dir=tmp_path, user_message="How did AMZN move on the day?")
    ledger.ingest_tool_result(
        tool_name="get_market_data",
        arguments={"codes": [SYMBOL]},
        result=_market_payload(),
        call_id="prices",
        success=True,
    )
    return ledger


def _block(*rows: str) -> str:
    return "\n\n```figures\n" + "\n".join(rows) + "\n```"


def _reasons(result: ValidationResult) -> list[str]:
    return [str(issue.get("reason")) for issue in result.issues]


def _gain(percent: str) -> str:
    return HDR + f" That is up from 258.10 the day before, a gain of {percent}."


def test_a_percent_whose_note_already_multiplies_by_100_matches_in_points(tmp_path: Path) -> None:
    ledger = _ledger(tmp_path)

    result = ledger.validate_final_answer(
        _gain("0.93%") + _block(CLOSE, PRIOR, "0.93% | derived | (260.50 / 258.10 - 1) * 100 | prices")
    )

    assert result.valid is True, result.issues


def test_a_percent_note_without_the_100_is_still_read_as_a_fraction(tmp_path: Path) -> None:
    ledger = _ledger(tmp_path)

    result = ledger.validate_final_answer(
        _gain("0.93%") + _block(CLOSE, PRIOR, "0.93% | derived | 260.50 / 258.10 - 1 | prices")
    )

    assert result.valid is True, result.issues


def test_a_percent_that_misses_its_own_times_100_formula_is_still_rejected(tmp_path: Path) -> None:
    ledger = _ledger(tmp_path)

    result = ledger.validate_final_answer(
        _gain("5.00%") + _block(CLOSE, PRIOR, "5.00% | derived | (260.50 / 258.10 - 1) * 100 | prices")
    )

    assert result.valid is False
    assert "derivation_result_mismatch" in _reasons(result)
````

- [ ] **Step 2: Run it and confirm the new case fails.**

```bash
vt_test tests/test_grounding_percent_notes.py -q
```

Expected: `1 failed, 2 passed`. The failure is `test_a_percent_whose_note_already_multiplies_by_100_matches_in_points` (the gate reports `derivation_result_mismatch`); the fraction-spelling and wrong-number cases pass.

- [ ] **Step 3: Implement it.**

Save the diff to a file and apply it (or make the same edits by hand; the hunks are exact):

```bash
cat > "${TMPDIR:-/tmp}/task-03.patch" <<'PATCH'
diff --git a/agent/src/agent/grounding/policies.py b/agent/src/agent/grounding/policies.py
index 43222b5..e34a3b9 100644
--- a/agent/src/agent/grounding/policies.py
+++ b/agent/src/agent/grounding/policies.py
@@ -1846,7 +1846,11 @@ class _PolicyMixin:
                     "least two operands with one of them observed in this session",
                 )
             ]
-        result, _ = derivation
+        result, operands = derivation
+        # A note that already multiplies by 100 states percentage points ("0.93%" from
+        # "(a / b - 1) * 100"), which ``_result_matches`` would otherwise scale a second time.
+        if figure.percent and 100.0 in operands and self._result_matches(figure, result / 100.0):
+            return []
         if self._result_matches(figure, result):
             return []
         # Reported in the figure's own units, as ``_result_matches`` compares it.
PATCH
```

```bash
git -C ai-trading/packages/vibe-trading apply "${TMPDIR:-/tmp}/task-03.patch"
```

- [ ] **Step 4: Run the module, then every grounding-related test.**

```bash
vt_test tests/test_grounding_percent_notes.py -q
vt_test tests -q -n 8 -k "grounding or figures or policies or evidence or release or loop"
```

Expected: `3 passed`, then no failures.

- [ ] **Step 5: Add the ledger row.**

Insert the row below into the **Backend** table of `ai-trading/packages/vibe-trading/DIVERGENCE.md`, immediately above the row that starts with ``| `tests/test_settings_api.py` |`` (so rows stay in task order):

```markdown
| `agent/src/agent/grounding/policies.py` | `_check_derived`: a percent figure whose formula has a literal `100` operand is also compared in percentage points (`0.93%` from `(260.50 / 258.10 - 1) * 100`), not only as a fraction. Tests: `tests/test_grounding_percent_notes.py`. | The result was scaled by 100 a second time ("evaluates to 93%"): 16 issues in six real runs. |
```

- [ ] **Step 6: Commit.**

```bash
git -C ai-trading/packages/vibe-trading add -A agent DIVERGENCE.md
git -C ai-trading/packages/vibe-trading commit -m "fix(family-app): compare a percent whose note already multiplies by 100 in points"
```
