import json
import re
from pathlib import Path
from typing import Any

import pytest
from pydantic import BaseModel, ValidationError

from ai_trading.contracts.alert_strategy import AlertStrategy
from ai_trading.contracts.filter_strategy import FilterStrategy
from ai_trading.contracts.json_pointer import apply_edits, json_equal
from ai_trading.contracts.strategy_draft import DRAFT_RULES, StrategyDraft

BACKEND = Path(__file__).resolve().parents[1]
CONTRACTS = BACKEND.parent / "contracts"
FIXTURES = CONTRACTS / "fixtures" / "strategy-draft"


def _files(directory: Path) -> list[Path]:
    return sorted(directory.glob("*.json"))


VALID = _files(FIXTURES / "valid")
INVALID = _files(FIXTURES / "invalid")


def _dump(model: BaseModel) -> dict[str, Any]:
    return model.model_dump(mode="json", by_alias=True, exclude_none=True)


def test_fixture_folders_are_not_empty():
    assert len(VALID) >= 8 and len(INVALID) >= 20


@pytest.mark.parametrize("path", VALID, ids=lambda p: p.name)
def test_accepts_what_zod_accepts(path: Path):
    StrategyDraft.model_validate_json(path.read_text())


@pytest.mark.parametrize("path", INVALID, ids=lambda p: p.name)
def test_rejects_what_zod_rejects(path: Path):
    with pytest.raises(ValidationError):
        StrategyDraft.model_validate_json(path.read_text())


@pytest.mark.parametrize("path", VALID, ids=lambda p: p.name)
def test_dump_equals_the_stored_file(path: Path):
    raw = path.read_text()
    dumped = StrategyDraft.model_validate_json(raw).model_dump(mode="json", by_alias=True, exclude_unset=True)
    assert dumped == json.loads(raw)


@pytest.mark.parametrize("rule", DRAFT_RULES, ids=lambda r: r.id)
def test_rule_fixtures_are_rejected_with_that_rule(rule):
    fixtures = [path for path in INVALID if path.name.startswith(rule.id)]
    assert fixtures, f"no invalid fixture named {rule.id}*"
    for path in fixtures:
        with pytest.raises(ValidationError) as exc:
            StrategyDraft.model_validate_json(path.read_text())
        assert any(rule.description in err["msg"] for err in exc.value.errors()), path.name


def test_rule_ids_match_the_zod_source():
    source = (CONTRACTS / "src" / "strategy-draft.ts").read_text()
    block = source.split("export const DRAFT_RULES", 1)[1].split("] as const", 1)[0]
    assert [rule.id for rule in DRAFT_RULES] == re.findall(r'\bid: "([a-z-]+)"', block)
    assert [rule.description for rule in DRAFT_RULES] == re.findall(r'description: "([^"]*)"', block)


FINAL = [path for path in VALID if json.loads(path.read_text())["status"] == "final"]


@pytest.mark.parametrize("path", FINAL, ids=lambda p: p.name)
def test_round_trip_draft_config_plus_edits_equals_final_config(path: Path):
    draft = StrategyDraft.model_validate_json(path.read_text())
    assert draft.finalConfig is not None
    config_type = FilterStrategy if draft.draftConfig.kind == "filter" else AlertStrategy
    replayed = config_type.model_validate(apply_edits(_dump(draft.draftConfig), draft.edits))
    assert json_equal(_dump(replayed), _dump(draft.finalConfig))
