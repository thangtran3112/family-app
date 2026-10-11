# Task 8: get_stock_profile keeps the revenue range and adds EPS surprise history

Part of [01o-vibe-answer-integrity-plan.md](../01o-vibe-answer-integrity-plan.md). Read its Global Constraints and Test Runner first; every command runs from the repository root of the worktree, with `vt_test` defined as in the Test Runner section.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `earnings_trend` rows keep Yahoo's revenue range, analyst count and growth plus the extra revision counts, and a new default section `earnings_history` returns the last four quarters' EPS actual, estimate, difference and surprise. The NVDA consensus answer had to say "not retrieved" for revenue analyst counts and ranges, and an earnings question had no EPS-surprise history. Yahoo has no upward 90-day count, so the tool returns what exists.

**Files:**
- Modify (append tests): `ai-trading/packages/vibe-trading/agent/tests/test_stock_profile_tool.py`
- Modify: `ai-trading/packages/vibe-trading/agent/src/tools/stock_profile_tool.py` (`_SECTION_MODULES`, `_earnings_trend`, new `_earnings_history`, `_SHAPERS`, the tool description)
- Modify: `ai-trading/packages/vibe-trading/DIVERGENCE.md` (one Backend row)

**Interfaces:**
- Consumes: nothing from earlier tasks (the new money-valued leaf names `revenue_low`, `revenue_high`, `eps_actual`, `eps_estimate` and `eps_difference` are already in Task 04's `_EXACT_REF_MONEY_LEAVES`, so figures quoted from them by exact ref ground).
- Produces: `earnings_trend` rows gain `revenue_low`, `revenue_high`, `revenue_analysts`, `revenue_growth`, `eps_revisions_up_7d`, `eps_revisions_down_7d`, `eps_revisions_down_90d`; section `earnings_history` is a list of `{quarter, eps_actual, eps_estimate, eps_difference, surprise_percent}` (`surprise_percent` is a fraction: 0.0346 is 3.46%) and joins `_ALL_SECTIONS`, so the default call returns it.

- [ ] **Step 1: Write the failing tests.** Append this to `agent/tests/test_stock_profile_tool.py` (it already imports `json`, `patch` and `sp`). The payload carries the fields Yahoo really returns, including the odd `downLast7Days` capitalisation:

```python
def _consensus_summary() -> dict:
    """The earnings fields Yahoo returns for a large-cap, as observed for NVDA on 2026-10-10."""
    return {
        "price": {
            "symbol": "NVDA",
            "exchange": "NMS",
            "exchangeName": "NasdaqGS",
            "fullExchangeName": "NasdaqGS",
            "quoteType": "EQUITY",
            "currency": "USD",
        },
        "earningsTrend": {
            "trend": [
                {
                    "period": "0q",
                    "endDate": "2026-10-31",
                    "growth": {"raw": 0.9025},
                    "earningsEstimate": {
                        "avg": {"raw": 2.47325},
                        "low": {"raw": 2.34},
                        "high": {"raw": 2.7},
                        "numberOfAnalysts": {"raw": 44},
                    },
                    "revenueEstimate": {
                        "avg": {"raw": 108_976_837_760},
                        "low": {"raw": 105_000_000_000},
                        "high": {"raw": 112_000_000_000},
                        "numberOfAnalysts": {"raw": 41},
                        "growth": {"raw": 0.62},
                    },
                    "epsTrend": {"current": {"raw": 2.47325}, "90daysAgo": {"raw": 2.33883}},
                    "epsRevisions": {
                        "upLast7days": {"raw": 3},
                        "upLast30days": {"raw": 35},
                        "downLast7Days": {"raw": 0},
                        "downLast30days": {"raw": 2},
                        "downLast90days": {"raw": 4},
                    },
                }
            ]
        },
        "earningsHistory": {
            "history": [
                {
                    "quarter": {"raw": 1_761_868_800, "fmt": "2025-10-31"},
                    "epsActual": {"raw": 1.3},
                    "epsEstimate": {"raw": 1.25647},
                    "epsDifference": {"raw": 0.04},
                    "surprisePercent": {"raw": 0.0346},
                }
            ]
        },
    }


def test_earnings_trend_keeps_the_revenue_range_and_the_other_revision_counts() -> None:
    with patch.object(sp, "get_quote_summary", return_value=_consensus_summary()):
        out = sp.StockProfileTool().execute(ticker="NVDA.US", sections=["earnings_trend"])

    row = json.loads(out)["data"]["sections"]["earnings_trend"][0]
    assert (row["revenue_low"], row["revenue_high"]) == (105_000_000_000, 112_000_000_000)
    assert (row["revenue_analysts"], row["revenue_growth"]) == (41, 0.62)
    assert (row["eps_revisions_up_7d"], row["eps_revisions_down_7d"]) == (3, 0)
    assert row["eps_revisions_down_90d"] == 4
    # What the tool always kept still arrives unchanged.
    assert (row["eps_avg"], row["eps_analysts"], row["revenue_avg"]) == (2.47325, 44, 108_976_837_760)
    assert (row["eps_revisions_up_30d"], row["eps_revisions_down_30d"]) == (35, 2)


def test_earnings_history_returns_each_quarter_actual_against_its_estimate() -> None:
    with patch.object(sp, "get_quote_summary", return_value=_consensus_summary()) as mock_get:
        out = sp.StockProfileTool().execute(ticker="NVDA.US")

    history = json.loads(out)["data"]["sections"]["earnings_history"]
    assert history == [
        {
            "quarter": "2025-10-31",
            "eps_actual": 1.3,
            "eps_estimate": 1.25647,
            "eps_difference": 0.04,
            "surprise_percent": 0.0346,
        }
    ]
    assert "earnings_history" in sp._ALL_SECTIONS
    assert "earningsHistory" in mock_get.mock_calls[0].args[1]


def test_a_missing_earnings_history_module_yields_an_empty_section() -> None:
    with patch.object(sp, "get_quote_summary", return_value={}):
        out = sp.StockProfileTool().execute(ticker="NVDA.US", sections=["earnings_history"])

    assert json.loads(out)["data"]["sections"]["earnings_history"] == []
```

- [ ] **Step 2: Run the file and confirm the three new tests fail.**

```bash
vt_test tests/test_stock_profile_tool.py -q
```

Expected: `3 failed, 10 passed`.

- [ ] **Step 3: Implement it.**

Save the diff to a file and apply it (or make the same edits by hand; the hunks are exact):

```bash
cat > "${TMPDIR:-/tmp}/task-08.patch" <<'PATCH'
diff --git a/agent/src/tools/stock_profile_tool.py b/agent/src/tools/stock_profile_tool.py
index c95d085..ecc54c3 100644
--- a/agent/src/tools/stock_profile_tool.py
+++ b/agent/src/tools/stock_profile_tool.py
@@ -23,6 +23,7 @@ _SECTION_MODULES: Dict[str, str] = {
     "key_stats": "defaultKeyStatistics",
     "financials": "financialData",
     "earnings_trend": "earningsTrend",
+    "earnings_history": "earningsHistory",
     "institution_ownership": "institutionOwnership",
     "insider_holders": "insiderHolders",
     "recommendation_trend": "recommendationTrend",
@@ -127,12 +128,41 @@ def _earnings_trend(module: Dict[str, Any]) -> List[Dict[str, Any]]:
                 "eps_high": _raw(eps.get("high")),
                 "eps_analysts": _raw(eps.get("numberOfAnalysts")),
                 "revenue_avg": _raw(rev.get("avg")),
+                # Yahoo's revenueEstimate carries the range, the analyst count and the
+                # growth as well; the tool kept only the average (family-app fork).
+                "revenue_low": _raw(rev.get("low")),
+                "revenue_high": _raw(rev.get("high")),
+                "revenue_analysts": _raw(rev.get("numberOfAnalysts")),
+                "revenue_growth": _raw(rev.get("growth")),
                 "eps_trend_current": _raw(trend.get("current")),
                 "eps_trend_7d_ago": _raw(trend.get("7daysAgo")),
                 "eps_trend_30d_ago": _raw(trend.get("30daysAgo")),
                 "eps_trend_90d_ago": _raw(trend.get("90daysAgo")),
                 "eps_revisions_up_30d": _raw(revisions.get("upLast30days")),
                 "eps_revisions_down_30d": _raw(revisions.get("downLast30days")),
+                # Yahoo has no upward 90-day count; its 7-day down key is spelled "Days".
+                "eps_revisions_up_7d": _raw(revisions.get("upLast7days")),
+                "eps_revisions_down_7d": _raw(revisions.get("downLast7Days")),
+                "eps_revisions_down_90d": _raw(revisions.get("downLast90days")),
+            }
+        )
+    return rows
+
+
+def _earnings_history(module: Dict[str, Any]) -> List[Dict[str, Any]]:
+    """Shape the earningsHistory quarters into actual-versus-estimate rows."""
+    rows: List[Dict[str, Any]] = []
+    for entry in (module.get("history") or [])[:_MAX_ROWS]:
+        if not isinstance(entry, dict):
+            continue
+        quarter = entry.get("quarter")
+        rows.append(
+            {
+                "quarter": quarter.get("fmt") if isinstance(quarter, dict) else None,
+                "eps_actual": _raw(entry.get("epsActual")),
+                "eps_estimate": _raw(entry.get("epsEstimate")),
+                "eps_difference": _raw(entry.get("epsDifference")),
+                "surprise_percent": _raw(entry.get("surprisePercent")),
             }
         )
     return rows
@@ -234,6 +264,7 @@ _SHAPERS = {
     "key_stats": _key_stats,
     "financials": _financials,
     "earnings_trend": _earnings_trend,
+    "earnings_history": _earnings_history,
     "institution_ownership": _institution_ownership,
     "insider_holders": _insider_holders,
     "recommendation_trend": _recommendation_trend,
@@ -286,8 +317,10 @@ class StockProfileTool(BaseTool):
         "Fetch a read-only company profile for a US, Hong Kong, UK (LSE .L), or "
         "Argentina (BYMA .BA) "
         "listing from Yahoo Finance: valuation key statistics, analyst price "
-        "targets and earnings/revenue estimates, institutional and insider "
-        "ownership, and the analyst recommendation trend. Always includes "
+        "targets and earnings/revenue estimates (with analyst counts, ranges and "
+        "revisions), the last four quarters' EPS actual versus estimate "
+        "(surprise_percent is a fraction: 0.0346 is 3.46%), institutional and "
+        "insider ownership, and the analyst recommendation trend. Always includes "
         "the listing's own venue and quote currency, kept separate from "
         "issuer fundamentals so a secondary/international listing does not "
         "read as the primary one. Use this for fundamentals and consensus "
@@ -314,7 +347,7 @@ class StockProfileTool(BaseTool):
                 },
                 "description": (
                     "Which profile sections to return. One or more of: "
-                    "key_stats, financials, earnings_trend, "
+                    "key_stats, financials, earnings_trend, earnings_history, "
                     "institution_ownership, insider_holders, "
                     "recommendation_trend. Defaults to all sections."
                 ),
PATCH
```

```bash
git -C ai-trading/packages/vibe-trading apply "${TMPDIR:-/tmp}/task-08.patch"
```

- [ ] **Step 4: Run the file and every test that touches the profile tool.**

```bash
vt_test tests/test_stock_profile_tool.py -q
vt_test tests/test_agent_output_discipline.py tests/test_argentina_market_routing.py tests/test_grounding_exact_field_refs.py tests/test_grounding_flagged_release.py tests/test_grounding_role_hardening.py tests/test_mcp_json_string_args.py -q
```

Expected: `13 passed`, then no failures (the existing default-sections test derives its expectation from `_ALL_SECTIONS`, so it needs no edit).

- [ ] **Step 5: Add the ledger row.**

Insert the row below into the **Backend** table of `ai-trading/packages/vibe-trading/DIVERGENCE.md`, immediately above the row that starts with ``| `tests/test_settings_api.py` |`` (so rows stay in task order):

```markdown
| `agent/src/tools/stock_profile_tool.py` | `earnings_trend` rows keep Yahoo's revenue range, analyst count and growth (`revenue_low`, `revenue_high`, `revenue_analysts`, `revenue_growth`) and the 7-day up/down and 90-day down revision counts; new default section `earnings_history` (`earningsHistory`: the last four quarters' EPS actual, estimate, difference and surprise). Tests: `tests/test_stock_profile_tool.py`. | The NVDA consensus answer had to say "not retrieved" for revenue analyst counts and ranges, and an earnings question had no EPS-surprise history. |
```

- [ ] **Step 6: Commit.**

```bash
git -C ai-trading/packages/vibe-trading add agent/src/tools/stock_profile_tool.py agent/tests/test_stock_profile_tool.py DIVERGENCE.md
git -C ai-trading/packages/vibe-trading commit -m "feat(family-app): get_stock_profile keeps the revenue range and adds EPS surprise history"
```
