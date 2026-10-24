import json
import re
from pathlib import Path

import pytest
from pydantic import ValidationError

from ai_trading.contracts.alert_strategy import ALERT_RULES, AlertStrategy

BACKEND = Path(__file__).resolve().parents[1]
CONTRACTS = BACKEND.parent / "contracts"
FIXTURES = CONTRACTS / "fixtures" / "alert-strategy"


def _files(directory: Path) -> list[Path]:
    return sorted(directory.glob("*.json"))


VALID = _files(FIXTURES / "valid")
INVALID = _files(FIXTURES / "invalid")


def test_fixture_folders_are_not_empty():
    assert len(VALID) >= 8 and len(INVALID) >= 20


@pytest.mark.parametrize("path", VALID, ids=lambda p: p.name)
def test_accepts_what_zod_accepts(path: Path):
    AlertStrategy.model_validate_json(path.read_text())


@pytest.mark.parametrize("path", INVALID, ids=lambda p: p.name)
def test_rejects_what_zod_rejects(path: Path):
    with pytest.raises(ValidationError):
        AlertStrategy.model_validate_json(path.read_text())


@pytest.mark.parametrize("path", VALID, ids=lambda p: p.name)
def test_dump_equals_the_stored_file(path: Path):
    raw = path.read_text()
    dumped = AlertStrategy.model_validate_json(raw).model_dump(mode="json", by_alias=True, exclude_unset=True)
    assert dumped == json.loads(raw)


@pytest.mark.parametrize("rule", ALERT_RULES, ids=lambda r: r.id)
def test_rule_fixtures_are_rejected_with_that_rule(rule):
    fixtures = [path for path in INVALID if path.name.startswith(rule.id)]
    assert fixtures, f"no invalid fixture named {rule.id}*"
    for path in fixtures:
        with pytest.raises(ValidationError) as exc:
            AlertStrategy.model_validate_json(path.read_text())
        assert any(rule.description in err["msg"] for err in exc.value.errors()), path.name


def test_rule_ids_match_the_zod_source():
    source = (CONTRACTS / "src" / "alert-strategy.ts").read_text()
    assert [rule.id for rule in ALERT_RULES] == re.findall(r'\bid: "([a-z-]+)"', source)
