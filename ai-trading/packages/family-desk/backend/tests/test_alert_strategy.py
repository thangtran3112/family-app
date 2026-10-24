"""AlertStrategySpecV1: a StrategySpecV1 with an alert-only `then`, unique channels, inbox first."""

import re
from pathlib import Path

import pytest
from pydantic import ValidationError

from ai_trading.contracts.alert_strategy import ALERT_RULES, AlertStrategySpecV1
from ai_trading.contracts.strategy_spec_v1 import StrategySpecV1

CONTRACTS = Path(__file__).resolve().parents[2] / "contracts"
FIXTURES = CONTRACTS / "fixtures" / "alert-strategy"
VALID = sorted((FIXTURES / "valid").glob("*.json"))
INVALID = sorted((FIXTURES / "invalid").glob("*.json"))
RULE_FIXTURES = {
    "channels-unique": ["channels-duplicate-inbox.json", "channels-duplicate-telegram.json"],
    "channels-inbox-first": [
        "channels-telegram-first.json",
        "channels-no-inbox.json",
        "channels-slack-first-inbox-last.json",
    ],
}


def test_fixture_folders_are_not_empty():
    assert len(VALID) >= 10 and len(INVALID) >= 22


@pytest.mark.parametrize("path", VALID, ids=lambda p: p.name)
def test_accepts_what_zod_accepts(path: Path):
    AlertStrategySpecV1.model_validate_json(path.read_text())
    StrategySpecV1.model_validate_json(path.read_text())  # an alert strategy is also a plain spec


@pytest.mark.parametrize("path", INVALID, ids=lambda p: p.name)
def test_rejects_what_zod_rejects(path: Path):
    with pytest.raises(ValidationError):
        AlertStrategySpecV1.model_validate_json(path.read_text())


@pytest.mark.parametrize("rule", ALERT_RULES, ids=lambda r: r.id)
def test_rule_fixtures_are_rejected_with_that_rule(rule):
    for name in RULE_FIXTURES[rule.id]:
        with pytest.raises(ValidationError) as exc:
            AlertStrategySpecV1.model_validate_json((FIXTURES / "invalid" / name).read_text())
        assert any(rule.description in err["msg"] for err in exc.value.errors()), name


def test_rule_ids_match_the_zod_source():
    source = (CONTRACTS / "src" / "alert-strategy.ts").read_text()
    block = source.split("export const ALERT_RULES", 1)[1].split("] as const", 1)[0]
    assert [rule.id for rule in ALERT_RULES] == re.findall(r'\bid: "([a-z-]+)"', block)
    assert [rule.description for rule in ALERT_RULES] == re.findall(r'description: "([^"]*)"', block)
