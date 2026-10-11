# Task 2: Read a sign written before the currency mark

Part of [01o-vibe-answer-integrity-plan.md](../01o-vibe-answer-integrity-plan.md). Read its Global Constraints and Test Runner first; every command runs from the repository root of the worktree, with `vt_test` defined as in the Test Runner section.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A figures declaration such as `−$2,582.00 | derived | ...` is read as a signed amount. One such line used to make the whole block "malformed", so every other figure was checked as if it had never been declared (9 issues in six real runs).

**Files:**
- Modify: `ai-trading/packages/vibe-trading/agent/src/agent/grounding/figures.py` (`_parse_value`; new constant `_LEADING_SIGNS`)
- Modify (append tests): `ai-trading/packages/vibe-trading/agent/tests/test_grounding_figures_contract.py`
- Modify: `ai-trading/packages/vibe-trading/DIVERGENCE.md` (one Backend row)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `parse_figures_block` returns a `Declaration` with the signed `value` and canonical `value_text` for `−$2,582.00`, `-$2,582.00`, `+$35.90`, `−US$12.74`, `–$53.43` and `-€3.5`. No signature changes.

- [ ] **Step 1: Write the failing tests.** Append this to `agent/tests/test_grounding_figures_contract.py` (it already imports `pytest` and `parse_figures_block`):

````python
@pytest.mark.parametrize(
    ("cell", "value", "canonical"),
    [
        ("−$2,582.00", -2582.0, "-2582.00"),
        ("-$2,582.00", -2582.0, "-2582.00"),
        ("+$35.90", 35.9, "35.90"),
        ("−US$12.74", -12.74, "-12.74"),
        ("–$53.43", -53.43, "-53.43"),
        ("-€3.5", -3.5, "-3.5"),
        ("$-2,582.00", -2582.0, "-2582.00"),
        ("$2,582.00", 2582.0, "2582.00"),
    ],
)
def test_a_sign_before_the_currency_mark_is_the_values_sign(
    cell: str, value: float, canonical: str
) -> None:
    """`−$2,582.00` is a signed amount, not an unreadable line.

    One unreadable declaration used to make the whole figures block "malformed",
    so every other figure was checked as if it had never been declared.
    """
    block = parse_figures_block(f"```figures\n{cell} | derived | 100 * 25.82 | financial_rigor\n```")

    assert block.malformed == ()
    assert [(d.value, d.value_text) for d in block.declarations] == [(value, canonical)]


def test_a_bare_sign_without_a_number_stays_malformed() -> None:
    block = parse_figures_block("```figures\n−$ | derived | 100 * 25.82 | financial_rigor\n```")

    assert block.declarations == ()
    assert len(block.malformed) == 1
````

- [ ] **Step 2: Run the file and confirm the six signed-currency cases fail.**

```bash
vt_test tests/test_grounding_figures_contract.py -q
```

Expected: `6 failed, 125 passed`. The adjacent-sign cases (`$-2,582.00`), the plain `$2,582.00` and the bare sign `−$` already behave and pass.

- [ ] **Step 3: Implement it.**

Save the diff to a file and apply it (or make the same edits by hand; the hunks are exact):

```bash
cat > "${TMPDIR:-/tmp}/task-02.patch" <<'PATCH'
diff --git a/agent/src/agent/grounding/figures.py b/agent/src/agent/grounding/figures.py
index 68da78a..c1457d7 100644
--- a/agent/src/agent/grounding/figures.py
+++ b/agent/src/agent/grounding/figures.py
@@ -97,6 +97,10 @@ _POINT_MARKS = (("bps", 0.01), ("pp", 1.0), ("bp", 0.01))
 # currency marks. They scale the comparison with evidence and never decide shape.
 _MAGNITUDES = {"K": 1e3, "M": 1e6, "B": 1e9, "千": 1e3, "万": 1e4, "亿": 1e8}
 
+# A sign written before the currency mark ("−$2,582.00") rather than before the
+# digits; the en dash is not among ``_LOOKALIKES``, so it is listed here.
+_LEADING_SIGNS = "+-\u2212\u2013"
+
 # A CJK currency word is at most three characters (人民币); bounding the run
 # keeps 元宵/元件, inside longer CJK runs, from reading as money.
 _MAX_CURRENCY_WORD = 3
@@ -640,9 +644,14 @@ def _parse_value(
     if not unit and tail in _MULTIPLE_MARKS:
         # "5.5x": a multiple, written the way the answer writes it.
         tail = ""
-    if not (_is_currency_mark(tail) and _is_currency_mark(field[: token.start].strip())):
+    prefix = field[: token.start].strip()
+    sign = token.sign
+    if not sign and prefix and prefix[0] in _LEADING_SIGNS:
+        # "−$2,582.00": the sign leads the currency mark instead of the digits.
+        sign, prefix = ("+" if prefix[0] == "+" else "-"), prefix[1:].strip()
+    if not (_is_currency_mark(tail) and _is_currency_mark(prefix)):
         return None
-    reading = _reading(token.sign, token.digits, unit)
+    reading = _reading(sign, token.digits, unit)
     if reading is None:
         return None
     value, canonical = reading
PATCH
```

```bash
git -C ai-trading/packages/vibe-trading apply "${TMPDIR:-/tmp}/task-02.patch"
```

- [ ] **Step 4: Run the file again, then its neighbours.**

```bash
vt_test tests/test_grounding_figures_contract.py -q
vt_test tests/test_grounding_release.py tests/test_grounding_shape_hardening.py tests/test_grounding_backtest_outputs.py -q
```

Expected: `131 passed`, then no failures.

- [ ] **Step 5: Add the ledger row.**

Insert the row below into the **Backend** table of `ai-trading/packages/vibe-trading/DIVERGENCE.md`, immediately above the row that starts with ``| `tests/test_settings_api.py` |`` (so rows stay in task order):

```markdown
| `agent/src/agent/grounding/figures.py` | `_parse_value` reads a sign written before the currency mark (`−$2,582.00`, `+$35.90`, `−US$12.74`, `–$53.43`) as the value's sign. Tests: `tests/test_grounding_figures_contract.py`. | One such declaration made the whole figures block "malformed", so every other figure was checked as if it had never been declared (9 issues in six real runs). |
```

- [ ] **Step 6: Commit.**

```bash
git -C ai-trading/packages/vibe-trading add -A agent DIVERGENCE.md
git -C ai-trading/packages/vibe-trading commit -m "fix(family-app): read a sign before the currency mark in a figures declaration"
```
