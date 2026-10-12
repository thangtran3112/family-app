"""Offline oracle checks for Vibe-Trading's public US-stock research cases."""

from __future__ import annotations

import re
from datetime import datetime
from decimal import Decimal

from grounding_report import classify

MONEY = re.compile(r"(?i)(?P<prefix>US\$|\$|USD\s*)?\s*(?P<number>\d[\d,]*(?:\.\d+)?)\s*(?P<scale>trillion|billion|million|bn|mm)?")
SCALE = {"trillion": Decimal("1000000000000"), "billion": Decimal("1000000000"),
         "bn": Decimal("1000000000"), "million": Decimal("1000000"), "mm": Decimal("1000000")}
DATE_IN_TEXT = re.compile(r"\d{4}-\d{2}-\d{2}|[A-Za-z]+\s+\d{1,2},?\s+\d{4}")


def _date(text: str) -> str | None:
    for fmt in ("%Y-%m-%d", "%B %d, %Y", "%B %d %Y"):
        try:
            return datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            pass
    return None


def date_visible(answer: str, expected: str | None = None) -> bool:
    return any((parsed := _date(found.group())) is not None and (expected is None or parsed == expected)
               for found in DATE_IN_TEXT.finditer(answer))


def match_fact(answer: str, fact: list[str]) -> dict:
    label, expected, unit, tolerance, source = fact
    pattern = re.compile(r"\b" + re.escape(label) + r"\b", re.I)
    matches = [(line, m) for line in answer.splitlines() for m in pattern.finditer(line)]
    unknown = {"label": label, "status": "unknown", "source": source}
    if len(matches) != 1:
        return unknown
    line, match = matches[0]
    tail = line[match.end():][:72]
    candidates: list[Decimal | str] = []
    if unit == "date":
        candidates = [day for found in DATE_IN_TEXT.finditer(tail) if (day := _date(found.group())) is not None]
    elif unit == "percent":
        candidates = [Decimal(found.group(1)) for found in re.finditer(r"(\d+(?:\.\d+)?)\s*%", tail)]
    elif unit in {"ratio", "per USD", "count"}:
        found = re.search(r"(?<![\d.])(\d+(?:\.\d+)?)(?![\d.])", tail)
        if found:
            candidates = [Decimal(found.group(1))]
    else:
        for found in MONEY.finditer(tail):
            prefix, scale = found.group("prefix"), (found.group("scale") or "").lower()
            if (not prefix and not scale) or (unit == "USD/share" and (not prefix or scale)):
                continue
            candidates.append(Decimal(found.group("number").replace(",", "")) * SCALE.get(scale, 1))
    if len(candidates) != 1:
        return unknown
    observed = candidates[0]
    passed = observed == expected if unit == "date" else abs(observed - Decimal(expected)) <= Decimal(tolerance)
    return {"label": label, "status": "pass" if passed else "mismatch", "observed": str(observed), "source": source}


def score_case(case: dict, run: dict, artifact: dict | None) -> dict:
    summary = run.get("summary") or {}
    answers = [message for message in run.get("messages", []) if message.get("role") == "assistant"]
    last = answers[-1] if answers else {}
    answer = last.get("content") or ""
    trail = last.get("tool_trail") or []
    facts = [match_fact(answer, fact) for fact in case["facts"]]
    issues = []
    if summary.get("status") != "completed" or not answers:
        issues.append("incomplete")
    if case["tools"] and not any(t.get("tool") in case["tools"] and t.get("status") == "ok" for t in trail):
        issues.append("required_tool_missing")
    if case["id"] in {"F01", "F02", "F03", "F04", "F16"}:
        if not re.search(r"\bSEC\b|sec\.gov", answer, re.I):
            issues.append("filing_source_missing")
        if not date_visible(answer, case["as_of"]):
            issues.append("filing_date_missing")
    if case["lane"] == "rolling" and case["id"] != "R07":
        if not re.search(r"\bSEC\b|Yahoo|yfinance|Reuters|\bAP\b|sec\.gov|https?://|source:\s*\S+", answer, re.I):
            issues.append("source_missing")
        if not date_visible(answer):
            issues.append("source_date_missing")
    outcome, flagged, cut = classify(answer)
    validations = artifact.get("validations", []) if artifact is not None else []
    truth = ("mismatch" if any(f["status"] == "mismatch" for f in facts) else
             "supported" if facts and all(f["status"] == "pass" for f in facts) else "unknown")
    return {"id": case["id"], "lane": case["lane"], "category": case["category"],
            "model": summary.get("model"), "configured_model": summary.get("configured_model"),
            "effort": summary.get("effort"), "status": summary.get("status"),
            "facts": facts, "numeric_truth": truth, "hard_issues": issues,
            "grounding": {"available": artifact is not None, "drafts": len(validations) if artifact is not None else None,
                          "issues": sum(len(v.get("issues", [])) for v in validations) if artifact is not None else None,
                          "evidence_records": len(artifact.get("evidence", [])) if artifact is not None else None,
                          "released": bool(artifact.get("released")) if artifact is not None else None,
                          "outcome": outcome, "flagged": flagged, "cut": cut},
            "tool_audit": [{"tool": t.get("tool"), "status": t.get("status"), "elapsed_ms": t.get("elapsed_ms")}
                           for t in trail],
            "wall_s": summary.get("wall_s"), "started_utc": run.get("started_utc"),
            "case_set_sha": run.get("case_set_sha"), "fork_commit": run.get("fork_commit")}
