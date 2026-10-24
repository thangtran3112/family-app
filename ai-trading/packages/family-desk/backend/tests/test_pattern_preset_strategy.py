import json
from pathlib import Path
from typing import get_args

import pytest
from pydantic import ValidationError

from ai_trading.contracts.pattern_preset_strategy import (
    PATTERN_RULES,
    PatternDirection,
    PatternKind,
    PatternPreset,
    PatternSpec,
    PatternTolerance,
)

BACKEND = Path(__file__).resolve().parents[1]
CONTRACTS = BACKEND.parent / "contracts"
FIXTURES = CONTRACTS / "fixtures" / "pattern-preset-strategy"
PRESETS = CONTRACTS / "presets" / "patterns"

SHIPPED_IDS = [
    "bearish-engulfing",
    "bearish-reversal",
    "breakout-down",
    "breakout-up",
    "bullish-engulfing",
    "bullish-reversal",
    "doji",
    "evening-star",
    "hammer",
    "inverted-hammer",
    "morning-star",
    "three-black-crows",
    "three-white-soldiers",
]


def _files(directory: Path) -> list[Path]:
    return sorted(directory.glob("*.json"))


VALID = _files(FIXTURES / "valid")
INVALID = _files(FIXTURES / "invalid")
SHIPPED = _files(PRESETS)
ACCEPTED = VALID + SHIPPED

# Sample values inside every tolerance range, so each table entry is checked on its own.
SAMPLE_TOLERANCE = {
    "bodyMaxPct": 50.0,
    "bodyMinPct": 50.0,
    "starBodyMaxPct": 50.0,
    "shadowMinRatio": 2.0,
    "engulfMinRatio": 2.0,
    "bufferPct": 1.0,
    "retracePct": 50.0,
}


def test_fixture_folders_are_not_empty_and_the_shipped_catalog_is_complete():
    assert len(VALID) >= 6 and len(INVALID) >= 16
    assert sorted(path.stem for path in SHIPPED) == SHIPPED_IDS


@pytest.mark.parametrize("path", ACCEPTED, ids=lambda p: p.name)
def test_accepts_what_zod_accepts(path: Path):
    PatternPreset.model_validate_json(path.read_text())


@pytest.mark.parametrize("path", INVALID, ids=lambda p: p.name)
def test_rejects_what_zod_rejects(path: Path):
    with pytest.raises(ValidationError):
        PatternPreset.model_validate_json(path.read_text())


@pytest.mark.parametrize("path", ACCEPTED, ids=lambda p: p.name)
def test_dump_of_parsed_file_equals_the_file(path: Path):
    raw = path.read_text()
    parsed = PatternPreset.model_validate_json(raw)
    assert parsed.model_dump(mode="json", by_alias=True, exclude_unset=True) == json.loads(raw)


def test_rules_cover_exactly_the_shipped_kinds():
    shipped_kinds = {PatternPreset.model_validate_json(path.read_text()).spec.pattern for path in SHIPPED}
    assert set(PATTERN_RULES) == set(get_args(PatternKind)) == shipped_kinds


def test_tolerance_model_has_exactly_the_keys_the_table_uses():
    table_keys = {key for rule in PATTERN_RULES.values() for key in rule.tolerance}
    assert set(PatternTolerance.model_fields) == table_keys


def _sample_spec(kind: str, direction: str) -> dict:
    rule = PATTERN_RULES[kind]
    spec: dict = {
        "pattern": kind,
        "direction": direction,
        "timeframe": "1d",
        "confirmation": {"type": "none"},
        "tolerance": {key: SAMPLE_TOLERANCE[key] for key in rule.tolerance},
    }
    if rule.lookback_required:
        spec["lookback"] = 20
    return spec


@pytest.mark.parametrize("kind", list(PATTERN_RULES))
def test_table_is_self_consistent(kind: str):
    rule = PATTERN_RULES[kind]
    assert (rule.category == "technical") == rule.lookback_required
    if rule.category == "candlestick":
        assert rule.bars in (1, 2, 3)
    else:
        assert rule.bars is None
    assert rule.directions and rule.tolerance
    for direction in get_args(PatternDirection):
        spec = _sample_spec(kind, direction)
        if direction in rule.directions:
            PatternSpec.model_validate(spec)
        else:
            with pytest.raises(ValidationError):
                PatternSpec.model_validate(spec)
