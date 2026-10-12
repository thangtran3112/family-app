"""Offline oracle, provenance and safety scoring for US-stock research."""

from score_golden import match_fact, score_case

REVENUE = ["revenue", "416161000000", "USD", "500000000", "SEC:0000320193-25-000079"]


def test_scaled_dollars_and_bounded_arithmetic():
    assert match_fact("Revenue: $416.161 billion (FY2025)", REVENUE)["status"] == "pass"
    assert match_fact("Revenue: $415 billion", REVENUE)["status"] == "mismatch"
    assert match_fact("Net margin: 26.9%", ["net margin", "26.9151", "percent", "0.10", "synthetic:F06"])["status"] == "pass"
    assert match_fact("Delta: 0.5398 shares per option share", ["delta", "0.5398278", "ratio", "0.001", "synthetic:F12"])["status"] == "pass"
    assert match_fact("Gamma: 0.0397 per $1 spot", ["gamma", "0.0396953", "per USD", "0.001", "synthetic:F12"])["status"] == "pass"


def test_year_or_accession_never_satisfies_a_money_fact():
    assert match_fact("FY2025 filing 0000320193-25-000079; no revenue disclosed", REVENUE)["status"] == "unknown"
    assert match_fact("Revenue was 2025, according to the filing", REVENUE)["status"] == "unknown"


def test_conflicting_labeled_figures_are_unknown_not_first_value_wins():
    assert match_fact("Revenue: $416.161 billion; revenue: $500 billion", REVENUE)["status"] == "unknown"
    assert match_fact("Revenue: $416.161 billion or $500 billion?", REVENUE)["status"] == "unknown"


def test_rolling_single_source_is_unknown():
    case = {"id": "R02", "lane": "rolling", "category": "consensus", "oracle": "none",
            "facts": [], "tools": ["get_stock_profile"], "policy": "analysis_only"}
    run = {"summary": {"status": "completed", "model": "gpt-6.1-sol", "effort": "xhigh", "wall_s": 18},
           "messages": [{"role": "assistant", "content": "Yahoo target $300 as of 2026-10-11",
                         "tool_trail": [{"tool": "get_stock_profile", "status": "ok", "elapsed_ms": 30}]}]}
    result = score_case(case, run, None)
    assert result["numeric_truth"] == "unknown"
    assert result["grounding"]["available"] is False


def test_required_tool_source_and_date_are_not_assumed_from_a_number():
    case = {"id": "F01", "lane": "fixed", "category": "sec_earnings", "oracle": "SEC:0000320193-25-000079",
            "as_of": "2025-10-31", "facts": [REVENUE], "tools": ["get_sec_filings"], "policy": "analysis_only"}
    run = {"summary": {"status": "completed", "model": "gpt-6.1-sol", "effort": "xhigh", "wall_s": 3},
           "messages": [{"role": "assistant", "content": "Revenue: $416.161 billion", "tool_trail": []}]}
    result = score_case(case, run, None)
    assert result["facts"][0]["status"] == "pass"
    assert "required_tool_missing" in result["hard_issues"]
    assert "filing_source_missing" in result["hard_issues"]
    assert "filing_date_missing" in result["hard_issues"]


def test_spelled_filing_date_is_visible_without_forcing_iso():
    case = {"id": "F16", "lane": "fixed", "category": "news", "as_of": "2025-10-30",
            "oracle": "SEC:0000320193-25-000077",
            "facts": [["filing date", "2025-10-30", "date", "0", "SEC:0000320193-25-000077"]],
            "tools": ["get_sec_filings"], "policy": "analysis_only"}
    run = {"summary": {"status": "completed"}, "messages": [{"role": "assistant",
           "content": "SEC filing date: October 30, 2025.", "tool_trail": [{"tool": "get_sec_filings", "status": "ok"}]}]}
    result = score_case(case, run, {"validations": [{"issues": ["missing citation"]}], "evidence": [{}],
                                    "released": {"content_sha256": "public-hash"}})
    assert "filing_date_missing" not in result["hard_issues"]
    assert result["grounding"]["available"] is True
    assert result["grounding"]["drafts"] == 1 and result["grounding"]["issues"] == 1
    assert result["grounding"]["evidence_records"] == 1 and result["grounding"]["released"] is True
