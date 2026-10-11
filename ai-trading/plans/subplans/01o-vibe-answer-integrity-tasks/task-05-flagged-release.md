# Task 5: flagged_release: keep and mark the figures the gate could not verify

Part of [01o-vibe-answer-integrity-plan.md](../01o-vibe-answer-integrity-plan.md). Read its Global Constraints and Test Runner first; every command runs from the repository root of the worktree, with `vt_test` defined as in the Test Runner section.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After two rejected drafts the release keeps every figure the model declared but the gate could not verify and marks it `(unverified※)` with one footnote. It still cuts a `proposed` level, every failing figure of a draft with no figures block, and any reason it does not list; it still releases nothing for an identity finding, a market answer with no observed price, or a figure it cannot locate.

**Files:**
- Create: `ai-trading/packages/vibe-trading/agent/tests/test_grounding_flagged_release.py`
- Modify: `ai-trading/packages/vibe-trading/agent/src/agent/grounding/release.py` (new `flagged_release`, `_edit_figures`, `_flag_note`, `_is_year_like`, `_FLAGGABLE_REASONS`, the two unverified marks; `_strip_release_markers`; `_marker_for`)
- Modify: `ai-trading/packages/vibe-trading/agent/src/agent/grounding/ledger.py` (new property `figures_flagged`)
- Modify: `ai-trading/packages/vibe-trading/DIVERGENCE.md` (two Backend rows)

**Interfaces:**
- Consumes (upstream, unchanged): `_REDACTABLE_CODES`, `_REPAIRABLE_PROVENANCE_CODES`, `_issue_span`, `_provenance_note`, `_release_note`, `_observed_range_summary`, `scan_figures`, `parse_figures_block`, `strip_figures_block`, `ValidationResult`.
- Produces:
  - `GroundingLedger.flagged_release(content: str, validation: ValidationResult) -> str | None`.
  - `GroundingLedger.figures_flagged -> int` (beside `figures_removed`).
  - `release._FLAGGABLE_REASONS: frozenset[str]`, `release._UNVERIFIED_MARKER_EN == "(unverified※)"`, `release._UNVERIFIED_MARKER_ZH == "（未核验※）"`.
  - After a call, `ledger._released` is `{released_at, content_sha256, mode: "flagged", figures_flagged, figures_removed, revalidated: False}`, persisted in `artifacts/grounding_evidence.json`.
- Task 06 calls `flagged_release` and reads `figures_flagged`.

- [ ] **Step 1: Write the failing test module.** Create `agent/tests/test_grounding_flagged_release.py`:

````python
"""Flagged release: figures the gate could not verify are kept and marked (family-app fork).

After two rejected drafts the gate used to cut each failing figure to
``(omitted※)``, and when a figure could not be located or the cut text still
failed it replaced the whole answer with a canned refusal. On the pinned code
that left none of six real US-equity runs clean: 24 figures were cut (the
analyst targets of a consensus question, the EPS and revenue of an earnings
question) and one covered-call answer became a stub.

``flagged_release`` keeps the analysis and marks the figure ``(unverified※)``.
What the gate exists to stop is still stopped, and every case below pins one
side of that line: a proposed level outside the observed range is cut, a reason
the fork does not know is cut, and an unresolved identity, a market answer that
observed no price, and a figure that cannot be located release nothing.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from src.agent.grounding import GROUNDING_ARTIFACT, GroundingLedger, ValidationResult
from src.agent.grounding import release as release_module
from src.tools.stock_profile_tool import StockProfileTool

pytestmark = pytest.mark.unit

SYMBOL = "AMZN.US"
HDR = "AMZN.US (Yahoo, USD) closed at 260.50 on 2026-10-09."
CLOSE = "260.50 | observed | AMZN.US close 2026-10-09 | prices"
MARK = "(unverified※)"


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


def _profile_result() -> str:
    summary = {
        "price": {
            "symbol": "AMZN",
            "exchange": "NMS",
            "exchangeName": "NasdaqGS",
            "fullExchangeName": "NasdaqGS",
            "quoteType": "EQUITY",
            "currency": "USD",
        },
        "financialData": {"currentPrice": {"raw": 260.5}, "targetMeanPrice": {"raw": 331.53}, "financialCurrency": "USD"},
    }
    with patch("src.tools.stock_profile_tool.get_quote_summary", return_value=summary):
        return StockProfileTool().execute(ticker=SYMBOL, sections=["financials"])


def _ledger(
    tmp_path: Path,
    message: str = "What is the analyst consensus target for AMZN?",
    *,
    market: bool = True,
) -> GroundingLedger:
    ledger = GroundingLedger(run_dir=tmp_path, user_message=message)
    if market:
        ledger.ingest_tool_result(
            tool_name="get_market_data",
            arguments={"codes": [SYMBOL]},
            result=_market_payload(),
            call_id="prices",
            success=True,
        )
        ledger.ingest_tool_result(
            tool_name="get_stock_profile",
            arguments={"ticker": SYMBOL},
            result=_profile_result(),
            call_id="prof1",
            success=True,
        )
    return ledger


def _block(*rows: str) -> str:
    return "\n\n```figures\n" + "\n".join(rows) + "\n```"


# The tool name alone is a pooled ref, which cannot ground an analyst target: a
# "could not verify" finding (`not_in_referenced_call`), not a contradiction.
TARGET_ROW = "US$331.53 | observed | mean target | get_stock_profile"
FLAG_DRAFT = (
    HDR + " The mean analyst target is US$331.53, so the stock trades below consensus." + _block(CLOSE, TARGET_ROW)
)
# A proposed entry far outside the observed range is the invention the gate exists to stop.
LEVEL_ROW = "US$150.00 | proposed | entry | prices"


def _validated(ledger: GroundingLedger, draft: str) -> ValidationResult:
    result = ledger.validate_final_answer(draft)
    assert result.valid is False
    return result


def test_an_unverifiable_figure_is_kept_and_marked(tmp_path: Path) -> None:
    ledger = _ledger(tmp_path)
    validation = _validated(ledger, FLAG_DRAFT)
    assert [issue["reason"] for issue in validation.issues] == ["not_in_referenced_call"]

    released = ledger.flagged_release(FLAG_DRAFT, validation)

    assert released is not None
    assert f"US$331.53 {MARK}, so the stock trades below consensus." in released
    assert "```figures" not in released and "get_stock_profile" not in released
    assert "※ 1 figure(s) could not be matched to this session's tool data" in released
    assert "omitted" not in released
    assert ledger.figures_flagged == 1 and ledger.figures_removed == 0


def test_removing_the_marks_and_the_note_restores_the_draft(tmp_path: Path) -> None:
    ledger = _ledger(tmp_path)
    released = ledger.flagged_release(FLAG_DRAFT, _validated(ledger, FLAG_DRAFT))

    assert released is not None
    body = released.rsplit("\n\n※", 1)[0]
    assert body.replace(f" {MARK}", "") == FLAG_DRAFT.split("\n\n```figures")[0]


def test_a_proposed_level_outside_the_observed_range_is_cut_not_flagged(tmp_path: Path) -> None:
    ledger = _ledger(tmp_path)
    draft = HDR + " A reasonable entry is US$150.00." + _block(CLOSE, LEVEL_ROW)
    validation = _validated(ledger, draft)
    assert [issue["reason"] for issue in validation.issues] == ["outside_observed_range"]

    released = ledger.flagged_release(draft, validation)

    assert released is not None
    assert "150.00" not in released and "(omitted※)" in released and MARK not in released
    assert ledger.figures_flagged == 0 and ledger.figures_removed == 1


def test_a_draft_without_a_figures_block_is_cut_as_before(tmp_path: Path) -> None:
    """With nothing declared, an invented price cannot be told from a category error."""
    ledger = _ledger(tmp_path)
    draft = HDR + " A reasonable entry is US$150.00, below the close."
    validation = _validated(ledger, draft)
    assert [issue["reason"] for issue in validation.issues] == ["value_mismatch"]

    released = ledger.flagged_release(draft, validation)

    assert released is not None
    assert "150.00" not in released and "(omitted※)" in released and MARK not in released
    assert ledger.figures_flagged == 0 and ledger.figures_removed == 1


def test_flagging_and_cutting_happen_in_one_pass(tmp_path: Path) -> None:
    ledger = _ledger(tmp_path)
    draft = (
        HDR
        + " The mean analyst target is US$331.53. A reasonable entry is US$150.00, below the close."
        + _block(CLOSE, TARGET_ROW, LEVEL_ROW)
    )
    validation = _validated(ledger, draft)

    released = ledger.flagged_release(draft, validation)

    assert released is not None
    assert f"The mean analyst target is US$331.53 {MARK}." in released
    assert "A reasonable entry is (omitted※), below the close." in released
    assert "※ 1 figure(s) could not be matched" in released
    assert "※ 1 figure(s) that could not be matched to this session's tool data were omitted" in released
    assert ledger.figures_flagged == 1 and ledger.figures_removed == 1


def test_a_reason_the_fork_does_not_list_is_cut_not_flagged(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An unknown reason (a later upstream one) fails closed, as the old release did."""
    monkeypatch.setattr(release_module, "_FLAGGABLE_REASONS", frozenset())
    ledger = _ledger(tmp_path)

    released = ledger.flagged_release(FLAG_DRAFT, _validated(ledger, FLAG_DRAFT))

    assert released is not None
    assert "331.53" not in released and "(omitted※)" in released and MARK not in released


def test_an_identity_finding_releases_nothing(tmp_path: Path) -> None:
    ledger = _ledger(tmp_path)
    validation = ValidationResult(
        valid=False,
        issues=[
            {"code": "numeric_claim_conflict", "reason": "no_evidence", "claim": "US$331.53", "value": "331.53"},
            {"code": "listed_identity_relabelled_private", "symbols": [SYMBOL]},
        ],
    )

    assert ledger.flagged_release(FLAG_DRAFT, validation) is None


def test_a_market_answer_that_observed_no_price_releases_nothing(tmp_path: Path) -> None:
    ledger = _ledger(tmp_path, message="Analyse AMZN.US and give me an entry price", market=False)
    draft = HDR + " The mean analyst target is US$331.53." + _block(TARGET_ROW)
    validation = ledger.validate_final_answer(draft)
    assert validation.valid is False

    assert ledger.flagged_release(draft, validation) is None


@pytest.mark.parametrize(
    "issue",
    [
        {"code": "numeric_claim_conflict", "reason": "no_evidence", "role": "observed", "value": "331.53"},
        {"code": "numeric_claim_conflict", "reason": "no_evidence", "role": "observed", "value": "331.53", "span": [0, 3]},
    ],
)
def test_a_figure_that_cannot_be_located_releases_nothing(tmp_path: Path, issue: dict) -> None:
    ledger = _ledger(tmp_path)

    assert ledger.flagged_release(FLAG_DRAFT, ValidationResult(valid=False, issues=[issue])) is None


def test_a_model_written_mark_is_stripped_not_echoed(tmp_path: Path) -> None:
    forged = FLAG_DRAFT.replace("260.50 on", f"260.50 {MARK} on") + "\n\n※ 9 figure(s) were omitted."
    ledger = _ledger(tmp_path)
    validation = ledger.validate_final_answer(forged)
    assert validation.valid is False

    released = ledger.flagged_release(forged, validation)

    assert released is not None
    assert released.count(MARK) == 1 + 1  # the one real mark, and the note's own mention of it
    assert "9 figure(s)" not in released
    assert f"260.50 {MARK}" not in released


def test_a_chinese_line_gets_the_chinese_mark_and_note(tmp_path: Path) -> None:
    ledger = _ledger(tmp_path, message="分析 AMZN.US 的分析师目标价")
    draft = "AMZN.US（Yahoo，USD）收盘价 260.50 美元。分析师平均目标价为 US$331.53，高于现价。" + _block(CLOSE, TARGET_ROW)
    validation = ledger.validate_final_answer(draft)
    assert validation.valid is False

    released = ledger.flagged_release(draft, validation)

    assert released is not None
    assert "US$331.53（未核验※）" in released
    assert "※ 有 1 处数值无法与本会话工具数据对上" in released


def test_a_table_cell_keeps_its_row_intact(tmp_path: Path) -> None:
    ledger = _ledger(tmp_path)
    draft = HDR + "\n\n| Metric | Value |\n|---|---|\n| Mean target | US$331.53 |\n" + _block(CLOSE, TARGET_ROW)
    validation = ledger.validate_final_answer(draft)
    assert validation.valid is False

    released = ledger.flagged_release(draft, validation)

    assert released is not None
    assert f"| Mean target | US$331.53 {MARK} |" in released


def test_a_value_mismatch_names_the_observed_range(tmp_path: Path) -> None:
    """A target set beside a price reads as a mismatch; the range lets the reader tell it from a conflict."""
    ledger = _ledger(tmp_path)
    draft = HDR + " The stock closed at US$350.00." + _block(CLOSE, "US$350.00 | observed | close | AMZN.US")
    validation = ledger.validate_final_answer(draft)
    assert [issue["reason"] for issue in validation.issues] == ["value_mismatch"]

    released = ledger.flagged_release(draft, validation)

    assert released is not None
    assert f"US$350.00 {MARK}" in released
    assert "Observed OHLC range: AMZN.US: 253–262.8 USD" in released


def test_the_release_is_recorded_in_the_grounding_artifact(tmp_path: Path) -> None:
    ledger = _ledger(tmp_path)

    ledger.flagged_release(FLAG_DRAFT, _validated(ledger, FLAG_DRAFT))

    artifact = tmp_path / "artifacts" / GROUNDING_ARTIFACT
    released = json.loads(artifact.read_text(encoding="utf-8"))["released"]
    assert released["mode"] == "flagged"
    assert released["figures_flagged"] == 1 and released["figures_removed"] == 0
    assert released["revalidated"] is False


def test_a_figure_repeated_in_prose_and_in_a_table_is_marked_at_each_place(tmp_path: Path) -> None:
    ledger = _ledger(tmp_path)
    draft = (
        HDR
        + " The mean analyst target is US$331.53.\n\n| Metric | Value |\n|---|---|\n| Mean target | US$331.53 |\n"
        + _block(CLOSE, TARGET_ROW)
    )
    validation = ledger.validate_final_answer(draft)
    assert validation.valid is False

    released = ledger.flagged_release(draft, validation)

    assert released is not None
    assert released.count(f"US$331.53 {MARK}") == 2
    assert "※ 2 figure(s) could not be matched" in released
    assert ledger.figures_flagged == 2


def test_a_currency_written_after_the_figure_is_marked_after_the_currency(tmp_path: Path) -> None:
    ledger = _ledger(tmp_path)
    draft = (
        HDR
        + " The mean analyst target is 331.53 USD, so the stock trades below consensus."
        + _block(CLOSE, "331.53 USD | observed | mean target | get_stock_profile")
    )
    validation = ledger.validate_final_answer(draft)
    assert validation.valid is False

    released = ledger.flagged_release(draft, validation)

    assert released is not None
    assert f"331.53 USD {MARK}, so the stock trades below consensus." in released


def test_a_malformed_declaration_alone_is_released_clean(tmp_path: Path) -> None:
    """The block is not answer text, and no figure is left to mark."""
    ledger = _ledger(tmp_path)
    draft = HDR + _block(CLOSE, "this line is not a declaration")
    validation = ledger.validate_final_answer(draft)
    assert [issue["reason"] for issue in validation.issues] == ["unparseable_declaration"]

    released = ledger.flagged_release(draft, validation)

    assert released == HDR
    assert ledger.figures_flagged == 0 and ledger.figures_removed == 0


def test_a_portfolio_wide_figure_the_session_cannot_attribute_is_flagged_not_cut(tmp_path: Path) -> None:
    """`no_symbol`: several instruments in the session and nothing ties the figure to one of them."""
    ledger = _ledger(tmp_path)
    msft = json.dumps(
        {
            "MSFT.US": [{"trade_date": "2026-10-09", "open": 530.0, "high": 537.0, "low": 529.0, "close": 535.07, "volume": 1}],
            "_provenance": {
                "MSFT.US": {
                    "source": "yahoo",
                    "requested_source": "auto",
                    "detected_source": "yahoo",
                    "fallback_used": False,
                    "currency_conversion": "none",
                }
            },
        }
    )
    ledger.ingest_tool_result(
        tool_name="get_market_data", arguments={"codes": ["MSFT.US"]}, result=msft, call_id="prices2", success=True
    )
    draft = (
        HDR
        + "\nMSFT.US (Yahoo, USD) closed at 535.07 on 2026-10-09.\nAn equal-risk split gives each position 33.33% of the portfolio risk."
        + _block(CLOSE, "535.07 | observed | MSFT.US close | prices2", "33.33% | derived | 100 / 3 | prices, prices2")
    )
    validation = ledger.validate_final_answer(draft)
    assert [issue["reason"] for issue in validation.issues] == ["no_symbol"]

    released = ledger.flagged_release(draft, validation)

    assert released is not None
    assert f"33.33% {MARK} of the portfolio risk" in released
    assert "(omitted※)" not in released
    assert ledger.figures_flagged == 1 and ledger.figures_removed == 0


def test_a_bare_year_is_never_marked_or_cut(tmp_path: Path) -> None:
    ledger = _ledger(tmp_path)
    draft = (
        HDR
        + " The call expires November 13, 2026, and the mean analyst target is US$331.53."
        + _block(CLOSE, TARGET_ROW)
    )
    real = ledger.validate_final_answer(draft)
    year_start = draft.index("2026,")
    year = {"code": "figure_undeclared", "reason": "undeclared", "role": None, "value": "2026", "span": [year_start, year_start + 4]}

    released = ledger.flagged_release(draft, ValidationResult(valid=False, issues=[year, *real.issues]))

    assert released is not None
    assert f"November 13, 2026, and the mean analyst target is US$331.53 {MARK}." in released
    assert ledger.figures_flagged == 1 and ledger.figures_removed == 0
````

- [ ] **Step 2: Run it and confirm every test fails on the missing method.**

```bash
vt_test tests/test_grounding_flagged_release.py -q
```

Expected: `20 failed`, each with `AttributeError: 'GroundingLedger' object has no attribute 'flagged_release'` (or `_FLAGGABLE_REASONS`). The assertions before each call (the reason codes of the validated draft) already pass, which shows the fixtures produce the intended findings.

- [ ] **Step 3: Implement it.**

Save the diff to a file and apply it (or make the same edits by hand; the hunks are exact):

```bash
cat > "${TMPDIR:-/tmp}/task-05.patch" <<'PATCH'
diff --git a/agent/src/agent/grounding/ledger.py b/agent/src/agent/grounding/ledger.py
index 4ad0134..48b6965 100644
--- a/agent/src/agent/grounding/ledger.py
+++ b/agent/src/agent/grounding/ledger.py
@@ -213,6 +213,11 @@ class GroundingLedger(
         """Return how many figures the discounted release cut, or 0."""
         return int((self._released or {}).get("figures_removed", 0))
 
+    @property
+    def figures_flagged(self) -> int:
+        """Return how many figures the flagged release kept and marked unverified, or 0."""
+        return int((self._released or {}).get("figures_flagged", 0))
+
     @staticmethod
     def streamable_length(text: str) -> int:
         """Return how much of a streaming answer may be shown live.
diff --git a/agent/src/agent/grounding/release.py b/agent/src/agent/grounding/release.py
index 9cbc0c9..e217ca8 100644
--- a/agent/src/agent/grounding/release.py
+++ b/agent/src/agent/grounding/release.py
@@ -56,11 +56,54 @@ _REDACTION_MARKER_ZH = "（略※）"
 
 _REDACTION_MARKER_EN = "(omitted※)"
 
+# The flag keeps the figure and follows it: a figure the gate could not verify is the
+# model's own statement, not a tool result, and the reader is told so (family-app fork).
+_UNVERIFIED_MARKER_ZH = "（未核验※）"
+
+_UNVERIFIED_MARKER_EN = "(unverified※)"
+
+# Reasons (``issue["reason"]``) that mean the gate could not verify a figure, as opposed
+# to finding it invented or misattributed. A figure the model declared, with one of them,
+# keeps its text and is marked; a proposed level, a draft with no figures block, and any
+# reason not listed (``outside_observed_range``, ``symbol_mismatch``, and whatever a later
+# upstream sync adds), is cut as ``redacted_release`` cuts it, so an unknown reason fails
+# closed.
+_FLAGGABLE_REASONS = frozenset(
+    {
+        "no_evidence",
+        "no_symbol",
+        "value_mismatch",
+        "undeclared",
+        "not_in_referenced_call",
+        "field_ref_needs_call_id",
+        "unknown_call_id",
+        "ambiguous_field_ref",
+        "tail_risk_needs_field_ref",
+        "formula_not_evaluable",
+        "formula_not_anchored",
+        "additive_operand_not_observed",
+        "derivation_result_mismatch",
+        "no_formula",
+        "citation_without_source",
+        "citation_not_visible",
+        "cited_as_observed",
+    }
+)
+
 MAX_SYMBOL_RESOLUTION_ATTEMPTS = 2
 
 MAX_PRICE_EVIDENCE_ATTEMPTS = 3
 
 
+def _is_year_like(figure: Figure) -> bool:
+    """A bare four-digit year: a date part, not a measurement, so it is never marked or cut."""
+    return (
+        not figure.currency
+        and not figure.percent
+        and re.fullmatch(r"(?:19|20)\d{2}", figure.text.strip()) is not None
+    )
+
+
 def _format_price(value: float) -> str:
     """Render a price without scientific notation (``%g`` gives "1.23457e+06")."""
     return format(value, ".10g")
@@ -161,8 +204,12 @@ def _strip_release_markers(content: str) -> str:
     Returns:
         The draft with every marker and note-shaped line removed.
     """
-    stripped = content.replace(_REDACTION_MARKER_ZH, "").replace(
-        _REDACTION_MARKER_EN, ""
+    stripped = (
+        content.replace(_REDACTION_MARKER_ZH, "")
+        .replace(_REDACTION_MARKER_EN, "")
+        .replace(_UNVERIFIED_MARKER_ZH, "")
+        .replace(f" {_UNVERIFIED_MARKER_EN}", "")
+        .replace(_UNVERIFIED_MARKER_EN, "")
     )
     return "\n".join(
         line for line in stripped.splitlines() if not line.lstrip().startswith("※")
@@ -768,25 +815,26 @@ class _ReleaseMixin:
         pieces.append(text[cursor:])
         return "".join(pieces), removed
 
-    def _marker_for(self, text: str, position: int) -> str:
-        """Pick the omission marker in the script of the line being cut.
+    def _marker_for(self, text: str, position: int, *, flagged: bool = False) -> str:
+        """Pick the omission marker, or the unverified mark, in the script of the line.
 
         A line with neither script (a numeric table row) uses the user's language.
         """
+        zh, en = (
+            (_UNVERIFIED_MARKER_ZH, _UNVERIFIED_MARKER_EN)
+            if flagged
+            else (_REDACTION_MARKER_ZH, _REDACTION_MARKER_EN)
+        )
         line = ""
         for candidate, start in _lines_with_offsets(text):
             if start <= position <= start + len(candidate):
                 line = candidate
                 break
         if any("\u3400" <= char <= "\u9fff" for char in line):
-            return _REDACTION_MARKER_ZH
+            return zh
         if any(char.isascii() and char.isalpha() for char in line):
-            return _REDACTION_MARKER_EN
-        return (
-            _REDACTION_MARKER_ZH
-            if self._user_writes_chinese()
-            else _REDACTION_MARKER_EN
-        )
+            return en
+        return zh if self._user_writes_chinese() else en
 
     def _release_note(self, removed: int, content: str | None = None) -> str:
         """Explain the redaction to the user, with the observed range."""
@@ -811,3 +859,165 @@ class _ReleaseMixin:
             "For an entry price, ask me to derive one with a visible formula from an "
             "observed close or moving average."
         )
+
+    def flagged_release(self, content: str, validation: ValidationResult) -> str | None:
+        """Release the last rejected draft with the figures the gate could not verify marked.
+
+        In a draft with a figures block, a figure whose issue role is not ``proposed`` and
+        whose reason is in ``_FLAGGABLE_REASONS`` keeps its text and gains
+        ``(unverified※)``: the model declared it, so it is the model's own statement. Every
+        other failing figure is cut to ``(omitted※)`` as ``redacted_release`` cuts it,
+        including every failing figure of a draft with no block, where nothing separates
+        an invented price from a category error. Both
+        edits are made in one pass over the located figures, the declaration block is
+        removed, and one footnote per kind says what was marked or cut. The released
+        text is not re-validated: its marked figures would fail by definition.
+
+        Fail-closed exactly where ``redacted_release`` is: None when a market answer
+        observed no price, an issue code is outside the redactable and provenance sets
+        (an identity finding), or a figure to cut or mark cannot be located.
+
+        Args:
+            content: The rejected draft.
+            validation: Its validation result.
+
+        Returns:
+            The released answer, without its declaration block and with its
+            footnote(s), or None.
+        """
+        if self._identity_required and not self._price_records() and not self._analysis_completed:
+            return None
+        text = _strip_release_markers(content)
+        # Stripping shifts offsets and the edits anchor on issue spans, so the verdict is
+        # retaken on the stripped text.
+        check = validation if text == content else self._validate(text, record=False)
+        codes = {issue.get("code") for issue in check.issues}
+        if not codes <= (_REDACTABLE_CODES | _REPAIRABLE_PROVENANCE_CODES | {"figures_block_malformed"}):
+            return None
+        block = parse_figures_block(text)
+        figures = scan_figures(text, block)
+        located = {(figure.start, figure.end): figure for figure in figures}
+        cuts: dict[tuple[int, int], Figure] = {}
+        flags: dict[tuple[int, int], Figure] = {}
+        reasons: set[str] = set()
+        for issue in check.issues:
+            if issue.get("code") not in _REDACTABLE_CODES:
+                continue
+            span = self._issue_span(text, issue)
+            if span is None:
+                return None
+            if issue.get("value") is None:
+                # Figures attached to a symbol the session never handled: every measured
+                # figure inside the clause is cut, as ``_cut_flagged`` cuts it.
+                cuts.update(
+                    ((figure.start, figure.end), figure)
+                    for figure in figures
+                    if figure.shape == "measured" and span[0] <= figure.start and figure.end <= span[1]
+                )
+            elif span not in located:
+                return None
+            elif _is_year_like(located[span]):
+                continue
+            elif (
+                block.present
+                and issue.get("role") != "proposed"
+                and issue.get("reason") in _FLAGGABLE_REASONS
+            ):
+                flags[span] = located[span]
+                reasons.add(str(issue["reason"]))
+            else:
+                cuts[span] = located[span]
+        for span in cuts:
+            flags.pop(span, None)
+        edited, removed = self._edit_figures(text, cuts.values(), flags.values())
+        body = strip_figures_block(edited, parse_figures_block(edited))
+        if codes & _REPAIRABLE_PROVENANCE_CODES:
+            note = self._provenance_note(body)
+            if note is not None:
+                body = body.rstrip() + "\n\n" + note
+        notes = []
+        if flags:
+            notes.append(self._flag_note(len(flags), body, "value_mismatch" in reasons))
+        if removed:
+            notes.append(self._release_note(len(removed), body))
+        released = body.rstrip() + ("\n\n" + "\n".join(notes) if notes else "")
+        self._released = {
+            "released_at": _utc_now(),
+            "content_sha256": hashlib.sha256(released.encode("utf-8")).hexdigest(),
+            "mode": "flagged",
+            "figures_flagged": len(flags),
+            "figures_removed": len(removed),
+            "revalidated": False,
+        }
+        self.persist()
+        return released
+
+    def _edit_figures(
+        self,
+        text: str,
+        cuts: Iterable[Figure],
+        flags: Iterable[Figure],
+    ) -> tuple[str, list[str]]:
+        """Cut or mark the located figures in one pass, so every offset stays valid.
+
+        A cut figure and its glued marks become the omission marker, as in
+        ``_apply_cuts``; a flagged figure keeps its text and gains the unverified mark,
+        in the script of its line.
+
+        Args:
+            text: The document both lists were located in.
+            cuts: The figures to remove.
+            flags: The figures to keep and mark.
+
+        Returns:
+            ``(rewritten text, normalized digits of each figure cut)``.
+        """
+        edits = [(*(figure.extent or (figure.start, figure.end)), True, figure) for figure in cuts]
+        edits += [(*(figure.extent or (figure.start, figure.end)), False, figure) for figure in flags]
+        pieces: list[str] = []
+        removed: list[str] = []
+        cursor = 0
+        for start, end, cut, figure in sorted(edits, key=lambda item: (item[0], item[1], not item[2])):
+            if start < cursor:
+                continue
+            if cut:
+                removed.append(figure.digits)
+                start = max(cursor, start)
+                marker = self._marker_for(text, start)
+                if marker is _REDACTION_MARKER_ZH:
+                    # Flush against the word, but not against a table pipe (see ``_apply_cuts``).
+                    while (
+                        start > cursor
+                        and text[start - 1] == " "
+                        and text[:start - 1].rstrip(" ")[-1:] not in {"|", ""}
+                    ):
+                        start -= 1
+                pieces.append(text[cursor:start])
+                pieces.append(marker)
+            else:
+                marker = self._marker_for(text, start, flagged=True)
+                pieces.append(text[cursor:end])
+                pieces.append(marker if marker == _UNVERIFIED_MARKER_ZH else f" {marker}")
+            cursor = end
+        pieces.append(text[cursor:])
+        return "".join(pieces), removed
+
+    def _flag_note(self, flagged: int, content: str | None = None, with_range: bool = False) -> str:
+        """Explain the unverified marks to the user, with the observed range when asked.
+
+        Args:
+            flagged: How many figures were marked.
+            content: The answer the note is appended to, so the symbol is spelled as it spells it.
+            with_range: Whether to add the observed OHLC range, which lets a reader tell a
+                category error (a target set beside a price) from a real conflict.
+        """
+        is_zh = self._user_writes_chinese()
+        joined = self._observed_range_summary(is_zh, content) if with_range else None
+        if is_zh:
+            note = f"※ 有 {flagged} 处数值无法与本会话工具数据对上，已标注（未核验※）；检查器未能确认，请视为未经核验。"
+            return note + (f"已观测 OHLC 范围：{joined}。" if joined else "")
+        note = (
+            f"※ {flagged} figure(s) could not be matched to this session's tool data and are "
+            "marked (unverified※). The checker could not confirm them, so treat them as unchecked."
+        )
+        return note + (f" Observed OHLC range: {joined}." if joined else "")
PATCH
```

```bash
git -C ai-trading/packages/vibe-trading apply "${TMPDIR:-/tmp}/task-05.patch"
```

- [ ] **Step 4: Run the module and the release tests that pin upstream's cut path.**

```bash
vt_test tests/test_grounding_flagged_release.py -q
vt_test tests/test_grounding_release.py -q
```

Expected: `20 passed`, then no failures (`redacted_release` is untouched).

- [ ] **Step 5: Add the ledger rows.**

Insert the rows below into the **Backend** table of `ai-trading/packages/vibe-trading/DIVERGENCE.md`, immediately above the row that starts with ``| `tests/test_settings_api.py` |`` (so rows stay in task order):

```markdown
| `agent/src/agent/grounding/release.py` | New `flagged_release()` with `_FLAGGABLE_REASONS`, the `(unverified※)` and `（未核验※）` marks, `_edit_figures()` (one pass that cuts and marks) and `_flag_note()`. `_strip_release_markers` also strips the new marks and `_marker_for` takes `flagged=`. `redacted_release` is untouched. A bare four-digit year is never marked or cut. Tests: `tests/test_grounding_flagged_release.py`. | Owner request: a completed analysis is never cut or replaced for figures the checker could not verify; they are kept and marked. On the pinned code none of six real US-equity runs was clean (24 figures cut, one answer replaced by a stub). |
| `agent/src/agent/grounding/ledger.py` | `figures_flagged` property beside `figures_removed`. | Reporting. |
```

- [ ] **Step 6: Commit.**

```bash
git -C ai-trading/packages/vibe-trading add agent/src/agent/grounding/release.py agent/src/agent/grounding/ledger.py agent/tests/test_grounding_flagged_release.py DIVERGENCE.md
git -C ai-trading/packages/vibe-trading commit -m "feat(family-app): flagged_release keeps and marks figures the gate could not verify"
```
