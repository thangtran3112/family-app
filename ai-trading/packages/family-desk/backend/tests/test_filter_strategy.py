import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from ai_trading.contracts.filter_strategy import FilterPreset, FilterStrategy, filter_group_stats
from ai_trading.contracts.json_pointer import Edit, apply_edits

BACKEND = Path(__file__).resolve().parents[1]
CONTRACTS = BACKEND.parent / "contracts"
FIXTURES = CONTRACTS / "fixtures" / "filter-strategy"


def _files(directory: Path) -> list[Path]:
    return sorted(directory.glob("*.json"))


VALID = _files(FIXTURES / "valid")
INVALID = _files(FIXTURES / "invalid")
VALID_PRESETS = _files(FIXTURES / "valid-preset")
INVALID_PRESETS = _files(FIXTURES / "invalid-preset")
SHIPPED = _files(CONTRACTS / "presets" / "filters")


def test_fixture_folders_are_not_empty():
    assert len(VALID) >= 5 and len(INVALID) >= 14
    assert len(SHIPPED) == 7 and VALID_PRESETS and INVALID_PRESETS


@pytest.mark.parametrize("path", VALID, ids=lambda p: p.name)
def test_accepts_what_zod_accepts(path: Path):
    FilterStrategy.model_validate_json(path.read_text())


@pytest.mark.parametrize("path", INVALID, ids=lambda p: p.name)
def test_rejects_what_zod_rejects(path: Path):
    with pytest.raises(ValidationError):
        FilterStrategy.model_validate_json(path.read_text())


@pytest.mark.parametrize("path", SHIPPED + VALID_PRESETS, ids=lambda p: p.name)
def test_accepts_preset_what_zod_accepts(path: Path):
    FilterPreset.model_validate_json(path.read_text())


@pytest.mark.parametrize("path", INVALID_PRESETS, ids=lambda p: p.name)
def test_rejects_preset_what_zod_rejects(path: Path):
    with pytest.raises(ValidationError):
        FilterPreset.model_validate_json(path.read_text())


@pytest.mark.parametrize("path", VALID, ids=lambda p: p.name)
def test_dump_equals_the_stored_file(path: Path):
    raw = path.read_text()
    dumped = FilterStrategy.model_validate_json(raw).model_dump(mode="json", by_alias=True, exclude_unset=True)
    assert dumped == json.loads(raw)


@pytest.mark.parametrize("path", SHIPPED + VALID_PRESETS, ids=lambda p: p.name)
def test_preset_dump_equals_the_stored_file(path: Path):
    raw = path.read_text()
    dumped = FilterPreset.model_validate_json(raw).model_dump(mode="json", by_alias=True, exclude_unset=True)
    assert dumped == json.loads(raw)


@pytest.mark.parametrize("path", SHIPPED, ids=lambda p: p.name)
def test_shipped_preset_strategy_parses_with_every_param_at_min_and_max(path: Path):
    doc = json.loads(path.read_text())
    for bound in ("min", "max"):
        edits = [Edit(op="replace", path=param["path"], value=param[bound]) for param in doc["params"]]
        FilterStrategy.model_validate(apply_edits(doc["strategy"], edits))


def test_group_stats_count_depth_and_leaves():
    nested = next(p for p in VALID if p.name == "nested-all-any.json")
    stats = filter_group_stats(FilterStrategy.model_validate_json(nested.read_text()).match)
    assert (stats.depth, stats.leaves) == (3, 5)
