"""FilterStrategySpecV1 (generated model): accepts and rejects what the Zod schema does."""

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from ai_trading.contracts.strategy_spec_v1 import FilterStrategySpecV1, StrategySpecV1
from ai_trading.core.evaluate import check

CONTRACTS = Path(__file__).resolve().parents[2] / "contracts"
FIXTURES = CONTRACTS / "fixtures" / "filter-strategy-spec-v1"
DEFAULTS = sorted((CONTRACTS / "templates" / "filters").glob("*.json"))
VALID = sorted((FIXTURES / "valid").glob("*.json")) + DEFAULTS
INVALID = sorted((FIXTURES / "invalid").glob("*.json"))


def test_fixture_folders_are_not_empty():
    assert len(VALID) >= 19 and len(INVALID) >= 36


@pytest.mark.parametrize("path", VALID, ids=lambda p: p.name)
def test_accepts_what_zod_accepts(path: Path):
    FilterStrategySpecV1.model_validate_json(path.read_text())


@pytest.mark.parametrize("path", INVALID, ids=lambda p: p.name)
def test_rejects_what_zod_rejects(path: Path):
    with pytest.raises(ValidationError):
        FilterStrategySpecV1.model_validate_json(path.read_text())


@pytest.mark.parametrize("path", DEFAULTS, ids=lambda p: p.name)
def test_default_runs_on_todays_engine(path: Path):
    """A screener default only uses operands its cadence can compute: as a StrategySpecV1 it passes check()."""
    filter_spec = json.loads(path.read_text())
    spec = StrategySpecV1.model_validate(
        {
            "schemaVersion": 1,
            "name": filter_spec["name"],
            "watch": {
                "universe": {"symbols": ["AAPL"]},
                "session": filter_spec["watch"]["session"],
                "runOn": filter_spec["watch"]["runOn"],
            },
            "when": filter_spec["when"],
            "then": {"alert": {"channels": ["inbox"]}},
        }
    )
    assert check(spec) == []
