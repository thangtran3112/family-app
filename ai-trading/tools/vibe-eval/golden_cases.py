"""Versioned public US-stock research cases and oracle validation."""

from __future__ import annotations

import hashlib
import json
from datetime import date
from decimal import Decimal, InvalidOperation
from pathlib import Path

DEFAULT = Path(__file__).with_name("golden_cases.json")
CATEGORIES = {"sec_earnings", "consensus", "valuation", "technical", "options", "portfolio", "news", "safety"}
UNITS = {"USD", "USD/share", "percent", "count", "date", "ratio", "per USD"}
POLICIES = {"analysis_only", "solo_no_recommendation", "no_trade", "committee_required"}


def load_cases(path: Path = DEFAULT) -> list[dict]:
    data = json.loads(path.read_text(encoding="utf-8"))
    cases = data["cases"]
    ids = [case["id"] for case in cases]
    wanted = [f"F{i:02d}" for i in range(1, 19)] + [f"R{i:02d}" for i in range(1, 8)]
    if data.get("version") != "1" or ids != wanted or {c["category"] for c in cases} != CATEGORIES:
        raise ValueError("case version, ID order/count or category set is invalid")
    for case in cases:
        cid = case["id"]
        if case["lane"] != ("fixed" if cid.startswith("F") else "rolling") or case["policy"] not in POLICIES:
            raise ValueError(f"invalid lane/policy: {cid}")
        if (not isinstance(case["prompt"], str) or not case["prompt"].strip()
                or not isinstance(case["tools"], list)
                or any(not isinstance(tool, str) or not tool for tool in case["tools"])):
            raise ValueError(f"invalid prompt/tools: {cid}")
        if case["lane"] == "fixed":
            date.fromisoformat(case["as_of"])
            if not case["oracle"].startswith(("SEC:", "synthetic:", "policy:")):
                raise ValueError(f"invalid oracle: {cid}")
            if case["category"] != "safety" and not case["facts"]:
                raise ValueError(f"fixed fact missing: {cid}")
        elif case["oracle"] != "none" or case["facts"]:
            raise ValueError(f"rolling facts require an independent oracle: {cid}")
        elif (not isinstance(case.get("window"), str) or not case["window"].strip()
              or not isinstance(case.get("oracle_reason"), str) or not case["oracle_reason"].strip()):
            raise ValueError(f"rolling window/oracle reason missing: {cid}")
        for fact in case["facts"]:
            if not isinstance(fact, list) or len(fact) != 5 or not fact[4]:
                raise ValueError(f"fact source or shape: {cid}")
            label, expected, unit, tolerance, source = fact
            if unit not in UNITS or not str(source).startswith(("SEC:", "synthetic:")) or not label:
                raise ValueError(f"invalid fact metadata: {cid}")
            if source != case["oracle"]:
                raise ValueError(f"fact source differs from oracle: {cid}")
            if unit == "date":
                date.fromisoformat(expected)
                if tolerance != "0":
                    raise ValueError(f"invalid date tolerance: {cid}")
            else:
                try:
                    value, band = Decimal(expected), Decimal(tolerance)
                except InvalidOperation as exc:
                    raise ValueError(f"invalid fact number: {cid}") from exc
                if not value.is_finite() or not band.is_finite() or band < 0:
                    raise ValueError(f"invalid fact number: {cid}")
    return cases


def case_set_sha(path: Path = DEFAULT) -> str:
    data = json.loads(path.read_text(encoding="utf-8"))
    return hashlib.sha256(json.dumps(data, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
