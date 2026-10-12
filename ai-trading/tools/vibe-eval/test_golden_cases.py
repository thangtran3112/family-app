"""Golden casebook integrity and source contracts."""

import json
from pathlib import Path

import pytest
from golden_cases import case_set_sha, load_cases

BOOK = Path(__file__).with_name("golden_cases.json")


def test_casebook_has_25_unique_us_cases_and_correct_lane_counts():
    cases = load_cases(BOOK)
    assert [case["id"] for case in cases] == [f"F{i:02d}" for i in range(1, 19)] + [
        f"R{i:02d}" for i in range(1, 8)
    ]
    assert (sum(c["lane"] == "fixed" for c in cases), sum(c["lane"] == "rolling" for c in cases)) == (18, 7)
    assert len({c["category"] for c in cases}) == 8
    assert len(case_set_sha(BOOK)) == 64


def test_missing_oracle_is_refused_for_a_fixed_fact(tmp_path):
    data = json.loads(BOOK.read_text())
    del data["cases"][0]["facts"][0][4]
    path = tmp_path / "broken.json"
    path.write_text(json.dumps(data))
    with pytest.raises(ValueError, match="fact source"):
        load_cases(path)


def test_casebook_contains_no_reader_or_private_account_details():
    text = BOOK.read_text()
    assert "read_url" not in text and "jina" not in text.lower()
    assert "@" not in text and "api_key" not in text.lower()
