"""catalog.json (PresetCatalogV1): the index of every shipped template, and the templates' own defaults."""

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from ai_trading.contracts.strategy_spec_v1 import FilterStrategySpecV1, PresetCatalogV1, StrategySpecV1

CONTRACTS = Path(__file__).resolve().parents[2] / "contracts"
TEMPLATES = CONTRACTS / "templates"
FIXTURES = CONTRACTS / "fixtures" / "preset-catalog-v1"
VALID = sorted((FIXTURES / "valid").glob("*.json"))
INVALID = sorted((FIXTURES / "invalid").glob("*.json"))
CATALOG = PresetCatalogV1.model_validate_json((CONTRACTS / "catalog.json").read_text())


def test_fixture_folders_are_not_empty():
    assert len(VALID) >= 4 and len(INVALID) >= 24


@pytest.mark.parametrize("path", VALID, ids=lambda p: p.name)
def test_accepts_what_zod_accepts(path: Path):
    PresetCatalogV1.model_validate_json(path.read_text())


@pytest.mark.parametrize("path", INVALID, ids=lambda p: p.name)
def test_rejects_what_zod_rejects(path: Path):
    with pytest.raises(ValidationError):
        PresetCatalogV1.model_validate_json(path.read_text())


def test_catalog_ids_and_files_are_unique():
    assert len({e.id for e in CATALOG.entries}) == len(CATALOG.entries)
    assert len({e.file for e in CATALOG.entries}) == len(CATALOG.entries)


def test_every_template_file_is_cataloged():
    on_disk = sorted(str(path.relative_to(TEMPLATES)) for path in TEMPLATES.rglob("*.json"))
    assert sorted(e.file for e in CATALOG.entries) == on_disk


@pytest.mark.parametrize("entry", CATALOG.entries, ids=lambda e: e.id)
def test_entry_file_parses_as_its_kind(entry):
    spec_type = FilterStrategySpecV1 if entry.kind == "filter" else StrategySpecV1
    spec_type.model_validate_json((TEMPLATES / entry.file).read_text())
    assert entry.file.startswith("filters/") == (entry.kind == "filter")
    assert entry.file.startswith("patterns/") == (entry.category == "candlestick")


def test_pattern_templates_cover_every_pattern_once():
    patterns = [
        json.loads(path.read_text())["when"]["pattern"] for path in sorted((TEMPLATES / "patterns").glob("*.json"))
    ]
    assert len(patterns) == len(set(patterns)) == 20
