# Task 4: Let an exact field ref ground a money-valued leaf

Part of [01o-vibe-answer-integrity-plan.md](../01o-vibe-answer-integrity-plan.md). Read its Global Constraints and Test Runner first; every command runs from the repository root of the worktree, with `vt_test` defined as in the Test Runner section.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A currency-marked figure may quote an analyst target, revenue, EPS, strike or bid through a ref that names that exact field, and a money-derived figure may subtract such an observed value. The money filter used to make `targetMeanPrice` unmatchable, so a correct `US$331.53` was cut (21 issues in six real runs, plus the operands of 27 more). A pooled tool or call ref, and any ratio, return or count field, still cannot ground a money figure.

**Files:**
- Create: `ai-trading/packages/vibe-trading/agent/tests/test_grounding_exact_field_refs.py`
- Modify: `ai-trading/packages/vibe-trading/agent/src/agent/grounding/evidence.py` (new `_EXACT_REF_MONEY_LEAVES`, `_is_exact_ref_money_leaf`)
- Modify: `ai-trading/packages/vibe-trading/agent/src/agent/grounding/policies.py` (new `_ref_names_exact_field`; `_referenced`; `_derivation`)
- Modify: `ai-trading/packages/vibe-trading/DIVERGENCE.md` (two Backend rows)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `evidence._EXACT_REF_MONEY_LEAVES: frozenset[str]`, the casefolded leaf names (analyst targets, `totalrevenue`, `totalcash`, `totaldebt`, `enterprisevalue`, `trailingeps`, `forwardeps`, `eps_avg`, `eps_low`, `eps_high`, `revenue_avg`, `revenue_low`, `revenue_high`, the `eps_trend_*` leaves, `eps_actual`, `eps_estimate`, `eps_difference`, `strike`, `bid`, `ask`, `underlying_price`, `atm_strike`). Task 08 adds profile fields whose names are already in the set.
  - `evidence._is_exact_ref_money_leaf(record: EvidenceRecord) -> bool`.
  - `policies._PolicyMixin._ref_names_exact_field(self, ref: str, symbol: str | None) -> bool`: true for `call_id::path` and for a bare path that resolves to evidence; false for a call id, a tool name or an empty ref.

- [ ] **Step 1: Write the failing test module.** Create `agent/tests/test_grounding_exact_field_refs.py` (it builds the real `get_stock_profile` envelope with Yahoo mocked, so the fixtures match production):

````python
"""A money figure quotes a money-valued leaf through an exact field ref (family-app fork).

Analyst targets, revenue, EPS, strikes and bids are money but not quotes, so the
money filter made ``targetMeanPrice`` unmatchable: a correct, explicitly
referenced `US$331.53` was cut from the answer (21 issues in six real runs, and
the operands of 27 more). A currency-marked figure may now quote one of the
listed leaves through a ref that names it exactly. What stays closed is pinned
beside it: a pooled tool or call ref, a ratio or return field, the wrong value
and the wrong field.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from src.agent.grounding import GroundingLedger, ValidationResult
from src.tools.stock_profile_tool import StockProfileTool

pytestmark = pytest.mark.unit

SYMBOL = "AMZN.US"
HDR = "AMZN.US (Yahoo, USD) closed at 260.50 on 2026-10-09."
CLOSE = "260.50 | observed | AMZN.US close 2026-10-09 | prices"
TARGET_REF = "prof1::data.sections.financials.targetMeanPrice"


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
    """The real tool's envelope for an analyst-target payload (Yahoo mocked)."""
    summary = {
        "price": {
            "symbol": "AMZN",
            "exchange": "NMS",
            "exchangeName": "NasdaqGS",
            "fullExchangeName": "NasdaqGS",
            "quoteType": "EQUITY",
            "currency": "USD",
        },
        "financialData": {
            "currentPrice": {"raw": 260.5},
            "targetMeanPrice": {"raw": 331.53},
            "targetHighPrice": {"raw": 405.0},
            "targetLowPrice": {"raw": 230.0},
            "recommendationKey": "buy",
            "numberOfAnalystOpinions": {"raw": 58},
            "totalRevenue": {"raw": 716_924_000_000},
            "revenueGrowth": {"raw": 0.123},
            "financialCurrency": "USD",
        },
    }
    with patch("src.tools.stock_profile_tool.get_quote_summary", return_value=summary):
        return StockProfileTool().execute(ticker=SYMBOL, sections=["financials"])


def _chain_result() -> str:
    """An option-chain envelope in the shape ``get_options_chain`` returns."""
    return json.dumps(
        {
            "ok": True,
            "market": "us",
            "source": "yahoo",
            "data": {
                "ticker": SYMBOL,
                "underlying_price": 260.5,
                "atm_strike": 260.0,
                "calls_count": 1,
                "puts_count": 0,
                "calls": [
                    {
                        "contract_symbol": "AMZN261120C00280000",
                        "strike": 280.0,
                        "last_price": 3.1,
                        "bid": 2.95,
                        "ask": 3.25,
                        "volume": 12,
                        "open_interest": 340,
                        "implied_volatility": 0.31,
                        "in_the_money": False,
                        "expiration": 1795132800,
                    }
                ],
            },
        }
    )


def _ledger(tmp_path: Path, *, profile: bool = False, chain: bool = False) -> GroundingLedger:
    ledger = GroundingLedger(run_dir=tmp_path, user_message="What is the analyst consensus target for AMZN?")
    ledger.ingest_tool_result(
        tool_name="get_market_data",
        arguments={"codes": [SYMBOL]},
        result=_market_payload(),
        call_id="prices",
        success=True,
    )
    if profile:
        ledger.ingest_tool_result(
            tool_name="get_stock_profile",
            arguments={"ticker": SYMBOL},
            result=_profile_result(),
            call_id="prof1",
            success=True,
        )
    if chain:
        ledger.ingest_tool_result(
            tool_name="get_options_chain",
            arguments={"ticker": SYMBOL},
            result=_chain_result(),
            call_id="opt1",
            success=True,
        )
    return ledger


def _block(*rows: str) -> str:
    return "\n\n```figures\n" + "\n".join(rows) + "\n```"


def _reasons(result: ValidationResult) -> list[str]:
    return [str(issue.get("reason")) for issue in result.issues]


# ---------------------------------------------------------------------------
# A money figure quotes a money-valued leaf through an exact field ref
# ---------------------------------------------------------------------------

TARGET = HDR + " The mean analyst target is US$331.53."


def test_an_exact_field_ref_grounds_an_analyst_target(tmp_path: Path) -> None:
    ledger = _ledger(tmp_path, profile=True)

    result = ledger.validate_final_answer(
        TARGET + _block(CLOSE, f"US$331.53 | observed | mean target | {TARGET_REF}")
    )

    assert result.valid is True, result.issues


def test_a_bare_field_path_grounds_an_analyst_target(tmp_path: Path) -> None:
    ledger = _ledger(tmp_path, profile=True)

    result = ledger.validate_final_answer(
        TARGET + _block(CLOSE, "US$331.53 | observed | mean target | data.sections.financials.targetMeanPrice")
    )

    assert result.valid is True, result.issues


def test_a_tool_name_ref_is_still_corrected_even_when_the_tool_ran_once(tmp_path: Path) -> None:
    """Upstream pins this: the hint never selects a call, the next draft names it."""
    ledger = _ledger(tmp_path, profile=True)

    result = ledger.validate_final_answer(
        TARGET
        + _block(CLOSE, "US$331.53 | observed | mean target | get_stock_profile::data.sections.financials.targetMeanPrice")
    )

    assert result.valid is False
    assert "field_ref_needs_call_id" in _reasons(result)


def test_a_pooled_tool_ref_still_cannot_ground_an_analyst_target(tmp_path: Path) -> None:
    """A whole tool's results are not one field: the money filter keeps its coincidence guard."""
    ledger = _ledger(tmp_path, profile=True)

    result = ledger.validate_final_answer(
        TARGET + _block(CLOSE, "US$331.53 | observed | mean target | get_stock_profile")
    )

    assert result.valid is False
    assert "not_in_referenced_call" in _reasons(result)


def test_the_wrong_value_on_the_right_field_is_still_rejected(tmp_path: Path) -> None:
    ledger = _ledger(tmp_path, profile=True)

    result = ledger.validate_final_answer(
        HDR
        + " The mean analyst target is US$999.99."
        + _block(CLOSE, f"US$999.99 | observed | mean target | {TARGET_REF}")
    )

    assert result.valid is False


def test_the_right_value_on_the_wrong_field_is_still_rejected(tmp_path: Path) -> None:
    ledger = _ledger(tmp_path, profile=True)

    result = ledger.validate_final_answer(
        HDR
        + " The high analyst target is US$331.53."
        + _block(CLOSE, "US$331.53 | observed | high target | prof1::data.sections.financials.targetHighPrice")
    )

    assert result.valid is False


def test_a_derived_money_figure_anchors_on_an_exact_field_ref(tmp_path: Path) -> None:
    """The upside to the target subtracts a target the session observed, named by its field."""
    ledger = _ledger(tmp_path, profile=True)

    result = ledger.validate_final_answer(
        HDR
        + " The implied upside to the mean target is US$71.03."
        + _block(CLOSE, f"US$71.03 | derived | 331.53 - 260.50 | {TARGET_REF}")
    )

    assert result.valid is True, result.issues


def test_a_derived_money_figure_with_an_unobserved_operand_is_still_rejected(tmp_path: Path) -> None:
    ledger = _ledger(tmp_path, profile=True)

    result = ledger.validate_final_answer(
        HDR
        + " The implied upside is US$40.00."
        + _block(CLOSE, f"US$40.00 | derived | 300.50 - 260.50 | {TARGET_REF}")
    )

    assert result.valid is False
    assert "additive_operand_not_observed" in _reasons(result)


def test_a_ratio_field_never_grounds_a_money_figure_even_by_exact_ref(tmp_path: Path) -> None:
    ledger = _ledger(tmp_path, profile=True)

    result = ledger.validate_final_answer(
        HDR
        + " Revenue growth is US$0.12."
        + _block(CLOSE, "US$0.12 | observed | growth | prof1::data.sections.financials.revenueGrowth")
    )

    assert result.valid is False


def test_an_option_strike_and_bid_ground_through_their_exact_refs(tmp_path: Path) -> None:
    ledger = _ledger(tmp_path, chain=True)

    result = ledger.validate_final_answer(
        HDR
        + " The 280 call has a strike of US$280.00 and a bid of US$2.95."
        + _block(
            CLOSE,
            "US$280.00 | observed | strike | opt1::data.calls[0].strike",
            "US$2.95 | observed | bid | opt1::data.calls[0].bid",
        )
    )

    assert result.valid is True, result.issues


def test_an_option_bid_quoted_through_the_pooled_tool_ref_is_still_rejected(tmp_path: Path) -> None:
    ledger = _ledger(tmp_path, chain=True)

    result = ledger.validate_final_answer(
        HDR + " The bid is US$2.95." + _block(CLOSE, "US$2.95 | observed | bid | get_options_chain")
    )

    assert result.valid is False


def test_a_derived_money_figure_anchors_on_an_observed_option_bid_without_an_exact_ref(tmp_path: Path) -> None:
    """The cost of the stock net of the call premium subtracts a bid the session observed."""
    ledger = _ledger(tmp_path, chain=True)

    result = ledger.validate_final_answer(
        HDR
        + " The cost basis net of the call premium is US$257.55."
        + _block(CLOSE, "US$257.55 | derived | 260.50 - 2.95 | financial_rigor")
    )

    assert result.valid is True, result.issues


def test_a_derived_money_figure_with_an_unobserved_bid_is_still_rejected(tmp_path: Path) -> None:
    ledger = _ledger(tmp_path, chain=True)

    result = ledger.validate_final_answer(
        HDR
        + " The cost basis net of the call premium is US$257.60."
        + _block(CLOSE, "US$257.60 | derived | 260.50 - 2.90 | financial_rigor")
    )

    assert result.valid is False
    assert "additive_operand_not_observed" in _reasons(result)
````

- [ ] **Step 2: Run it and confirm only the repairs fail.**

```bash
vt_test tests/test_grounding_exact_field_refs.py -q
```

Expected: `5 failed, 8 passed`. The five failures are the exact-ref target, the bare path, the derived anchor on an exact ref, the option strike and bid, and the derived figure anchored on an observed bid; every still-rejected control (pooled ref, wrong value, wrong field, ratio field, unobserved operand, tool name without a call id) passes.

- [ ] **Step 3: Implement it.**

Save the diff to a file and apply it (or make the same edits by hand; the hunks are exact):

```bash
cat > "${TMPDIR:-/tmp}/task-04.patch" <<'PATCH'
diff --git a/agent/src/agent/grounding/evidence.py b/agent/src/agent/grounding/evidence.py
index 9ce60e2..0489049 100644
--- a/agent/src/agent/grounding/evidence.py
+++ b/agent/src/agent/grounding/evidence.py
@@ -183,6 +183,44 @@ _AMOUNT_FIELDS = frozenset(
     }
 )
 
+# Money-valued leaves of the profile and option-chain tools (analyst targets, revenue,
+# EPS, strikes, bids). They are not quotes, so unscoped matching still excludes them
+# ("the check accepts no more"); a currency-marked figure may quote one only through a
+# ref that names it exactly. Ratios, returns and counts are never listed.
+_EXACT_REF_MONEY_LEAVES = frozenset(
+    {
+        "currentprice",
+        "targetmeanprice",
+        "targethighprice",
+        "targetlowprice",
+        "targetmedianprice",
+        "totalrevenue",
+        "totalcash",
+        "totaldebt",
+        "enterprisevalue",
+        "trailingeps",
+        "forwardeps",
+        "eps_avg",
+        "eps_low",
+        "eps_high",
+        "revenue_avg",
+        "revenue_low",
+        "revenue_high",
+        "eps_trend_current",
+        "eps_trend_7d_ago",
+        "eps_trend_30d_ago",
+        "eps_trend_90d_ago",
+        "eps_actual",
+        "eps_estimate",
+        "eps_difference",
+        "strike",
+        "bid",
+        "ask",
+        "underlying_price",
+        "atm_strike",
+    }
+)
+
 # The backtest engine's summary outputs, relative to its run directory: small
 # documents of scalars, recorded whole when the backtest completes. A list
 # inside them (1,000 Monte Carlo Sharpe samples, one entry per rebalance) is a
@@ -626,6 +664,11 @@ def _is_price_kind(record: EvidenceRecord) -> bool:
     )
 
 
+def _is_exact_ref_money_leaf(record: EvidenceRecord) -> bool:
+    """Whether a record is a money-valued leaf a figure may quote through an exact field ref."""
+    return _leaf_name(record.field) in _EXACT_REF_MONEY_LEAVES
+
+
 class _EvidenceMixin:
     """Evidence behaviour of :class:`GroundingLedger`."""
 
diff --git a/agent/src/agent/grounding/policies.py b/agent/src/agent/grounding/policies.py
index e34a3b9..d1ab704 100644
--- a/agent/src/agent/grounding/policies.py
+++ b/agent/src/agent/grounding/policies.py
@@ -25,6 +25,7 @@ from src.agent.grounding import figures_checks  # noqa: F401  (registers declare
 from src.agent.grounding.registry import GROUNDING_CHECKS
 from src.agent.grounding.evidence import (
     EvidenceRecord,
+    _is_exact_ref_money_leaf,
     _is_metadata_count_leaf,
     _is_number,
     _is_price_kind,
@@ -700,6 +701,26 @@ class _PolicyMixin:
             return line_symbols[figure.line]
         return None
 
+    def _ref_names_exact_field(self, ref: str, symbol: str | None) -> bool:
+        """Whether ``ref`` names one evidence field, not a whole call or tool.
+
+        ``call_id::path`` names a field of one call, and a bare ``path`` names a
+        field the evidence holds; a call id or a tool name names neither.
+        """
+        key = (ref or "").strip()
+        if "::" in key:
+            call_id, field_name = (part.strip() for part in key.split("::", 1))
+            if not call_id or not field_name:
+                return False
+            records, entries = self._field_sources(field_name, symbol)
+            return any(record.call_id == call_id for record in records) or any(
+                entry.get("call_id") == call_id for entry in entries
+            )
+        if not key:
+            return False
+        records, entries = self._field_sources(key, symbol)
+        return bool(records or entries)
+
     def _referenced(
         self,
         ref: str,
@@ -717,8 +738,10 @@ class _PolicyMixin:
         ground a non-price figure (revenue, IC, volume). A backtest's output is
         also named by its run directory or file (:meth:`_artifact_scope`).
         Records of another symbol are dropped when the figure's symbol is
-        known; a currency-marked figure keeps only money-denominated records, a
-        percent only the others, less metadata counts.
+        known; a currency-marked figure keeps only money-denominated records
+        (and, through a ref naming one exact field, the money-valued leaves of
+        ``_EXACT_REF_MONEY_LEAVES``), a percent only the others, less metadata
+        counts.
 
         Args:
             ref: The declaration's ``ref``.
@@ -799,7 +822,14 @@ class _PolicyMixin:
                 if not _is_price_kind(record) and not _is_metadata_count_leaf(record.field)
             ]
         elif figure is not None and figure.currency:
-            records = [record for record in records if _is_price_kind(record)]
+            # A money-valued leaf that is not a quote (``targetMeanPrice``, ``strike``) answers a
+            # currency-marked figure only through a ref that names it exactly.
+            exact_field = self._ref_names_exact_field(key, symbol)
+            records = [
+                record
+                for record in records
+                if _is_price_kind(record) or (exact_field and _is_exact_ref_money_leaf(record))
+            ]
             metrics = []
         return records, metrics
 
@@ -1770,14 +1800,31 @@ class _PolicyMixin:
             anchors = self._price_pool(symbol, records) + self._row_pool(symbol, money_only=money)
             if not money:
                 anchors += self._metric_pool(symbol)
+            else:
+                # An observed money leaf that is not a quote (a bid, a strike, an analyst target)
+                # anchors a money result's operands, as it grounds a figure quoted by exact ref.
+                anchors += [
+                    float(record.value)
+                    for record in self._evidence
+                    if record.status == "observed"
+                    and record.value is not None
+                    and (not symbol or not record.symbol or record.symbol == symbol)
+                    and _is_exact_ref_money_leaf(record)
+                ]
         # Arithmetic across two runs needs both runs' values: a field ref that
         # names several sources anchors all of them instead of none.
         scoped = self._referenced(declaration.ref, symbol, None, pool_ambiguous=True)
         if scoped is not None:
+            exact_field = self._ref_names_exact_field(declaration.ref, symbol)
             anchors.extend(
                 float(record.value)
                 for record in scoped[0]
-                if (not money or _is_price_kind(record)) and not (unattributed and record.symbol)
+                if (
+                    not money
+                    or _is_price_kind(record)
+                    or (exact_field and _is_exact_ref_money_leaf(record))
+                )
+                and not (unattributed and record.symbol)
             )
             if not money and not unattributed:
                 anchors.extend(scoped[1])
PATCH
```

```bash
git -C ai-trading/packages/vibe-trading apply "${TMPDIR:-/tmp}/task-04.patch"
```

- [ ] **Step 4: Run the module and every grounding-related test, including upstream's own ref tests.**

```bash
vt_test tests/test_grounding_exact_field_refs.py -q
vt_test tests/test_grounding_unknown_call_id_refs.py -q
vt_test tests -q -n 8 -k "grounding or figures or policies or evidence or release or loop"
```

Expected: `13 passed`, then no failures. `test_grounding_unknown_call_id_refs.py` must pass unchanged: it pins that a tool name still needs a call id and that `$12.5` never grounds on a `total_return` ratio, which is why the relaxation is an allow-list and not "whatever its kind".

- [ ] **Step 5: Add the ledger rows.**

Insert the rows below into the **Backend** table of `ai-trading/packages/vibe-trading/DIVERGENCE.md`, immediately above the row that starts with ``| `tests/test_settings_api.py` |`` (so rows stay in task order):

```markdown
| `agent/src/agent/grounding/evidence.py` | New `_EXACT_REF_MONEY_LEAVES` (analyst targets, revenue, cash, debt, EPS, strikes, bids) and `_is_exact_ref_money_leaf()`. They are not part of `_is_price_kind`, so unscoped matching is unchanged. Tests: `tests/test_grounding_exact_field_refs.py`. | Correct, explicitly referenced analyst targets and option-chain values were cut from answers (21 issues in six real runs, plus the operands of 27 more). |
| `agent/src/agent/grounding/policies.py` | New `_ref_names_exact_field()`: a currency-marked figure whose ref names one exact field may quote a listed money leaf (observed figures in `_referenced`, derived operands in `_derivation`), and the operands of a money-derived figure may be any observed money leaf of its symbol (a bid, a strike, an analyst target). A pooled call or tool ref, a ratio, a return or a count still cannot ground a money figure. | Same. |
```

- [ ] **Step 6: Commit.**

```bash
git -C ai-trading/packages/vibe-trading add -A agent DIVERGENCE.md
git -C ai-trading/packages/vibe-trading commit -m "fix(family-app): let an exact field ref ground a money-valued leaf such as an analyst target"
```
