import json
import re
from pathlib import Path

import pytest
from pydantic import ValidationError

from ai_trading.contracts.custom_strategy import CUSTOM_RULES, CustomRule, CustomStrategy

BACKEND = Path(__file__).resolve().parents[1]
CONTRACTS = BACKEND.parent / "contracts"
FIXTURES = CONTRACTS / "fixtures" / "custom-strategy"
TS_SOURCE = CONTRACTS / "src" / "custom-strategy.ts"


def _files(directory: Path) -> list[Path]:
    return sorted(directory.glob("*.json"))


VALID = _files(FIXTURES / "valid")
INVALID = _files(FIXTURES / "invalid")


def _ts_rule_ids() -> list[str]:
    text = TS_SOURCE.read_text()
    block = text[text.index("export const CUSTOM_RULES") : text.index("] as const")]
    return re.findall(r'\bid: "([a-z0-9-]+)"', block)


def test_fixture_folders_are_not_empty():
    assert len(VALID) >= 6 and len(INVALID) >= 20


@pytest.mark.parametrize("path", VALID, ids=lambda p: p.name)
def test_accepts_what_zod_accepts(path: Path):
    CustomStrategy.model_validate_json(path.read_text())


@pytest.mark.parametrize("path", INVALID, ids=lambda p: p.name)
def test_rejects_what_zod_rejects(path: Path):
    with pytest.raises(ValidationError):
        CustomStrategy.model_validate_json(path.read_text())


@pytest.mark.parametrize("path", VALID, ids=lambda p: p.name)
def test_dump_equals_the_stored_file(path: Path):
    raw = path.read_text()
    dumped = CustomStrategy.model_validate_json(raw).model_dump(mode="json", by_alias=True, exclude_unset=True)
    assert dumped == json.loads(raw)


def test_rule_ids_match_the_typescript_list():
    assert [rule.id for rule in CUSTOM_RULES] == _ts_rule_ids()


@pytest.mark.parametrize("rule", CUSTOM_RULES, ids=lambda rule: rule.id)
def test_every_rule_has_an_invalid_fixture_that_fails_on_it(rule: CustomRule):
    named = [path for path in INVALID if path.name.startswith(rule.id)]
    assert named, f"no invalid fixture named after {rule.id}"
    for path in named:
        with pytest.raises(ValidationError) as exc:
            CustomStrategy.model_validate_json(path.read_text())
        assert rule.id in {error["type"] for error in exc.value.errors()}, path.name
