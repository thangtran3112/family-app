"""Zod JSON <-> Pydantic parse, in both directions, over every shared fixture and shipped preset.

Zod -> Pydantic: each valid file is parsed by `strategy_config_adapter` and dumps back to itself.
Pydantic -> Zod: those dumps are re-parsed by contracts/scripts/parse-configs.ts (Zod
`StrategyConfigSchema`); every invalid file must fail in both validators.
"""

import json
import shutil
import subprocess
from pathlib import Path

import pytest
from pydantic import ValidationError

from ai_trading.contracts.strategy_config import strategy_config_adapter

CONTRACTS = Path(__file__).resolve().parents[2] / "contracts"
SCRIPT = CONTRACTS / "scripts" / "parse-configs.ts"
FAMILIES = ("filter-strategy", "pattern-preset-strategy", "custom-strategy", "alert-strategy", "strategy-draft")


def _files(*directories: str) -> list[Path]:
    return sorted(path for directory in directories for path in (CONTRACTS / directory).glob("*.json"))


VALID = [
    *(path for family in FAMILIES for path in _files(f"fixtures/{family}/valid")),
    *_files("fixtures/filter-strategy/valid-preset", "presets/filters", "presets/patterns"),
]
INVALID = [
    *(path for family in FAMILIES for path in _files(f"fixtures/{family}/invalid")),
    *_files("fixtures/filter-strategy/invalid-preset"),
]
# Pydantic reaches the same verdict through different error text, but the parity of the verdict is the contract.
needs_zod = pytest.mark.skipif(
    shutil.which("node") is None or not (CONTRACTS / "node_modules" / "zod").exists(),
    reason="needs node and `pnpm install` in contracts/",
)


def _rel(path: Path) -> str:
    return str(path.relative_to(CONTRACTS))


def test_every_family_has_fixtures():
    assert len(VALID) >= 60 and len(INVALID) >= 100


@pytest.mark.parametrize("path", VALID, ids=_rel)
def test_valid_file_round_trips_through_pydantic(path: Path):
    raw = json.loads(path.read_text())
    config = strategy_config_adapter.validate_json(path.read_text())
    assert config.kind == raw["kind"]
    assert strategy_config_adapter.dump_python(config, mode="json", by_alias=True, exclude_unset=True) == raw


@pytest.mark.parametrize("path", INVALID, ids=_rel)
def test_invalid_file_is_rejected_by_pydantic(path: Path):
    with pytest.raises(ValidationError):
        strategy_config_adapter.validate_json(path.read_text())


def _run_zod(*args: str | Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["node", str(SCRIPT), *map(str, args)], cwd=CONTRACTS, capture_output=True, text=True)


@needs_zod
def test_zod_parses_what_pydantic_serializes(tmp_path: Path):
    for index, path in enumerate(VALID):
        config = strategy_config_adapter.validate_json(path.read_text())
        dump = strategy_config_adapter.dump_json(config, by_alias=True, exclude_unset=True)
        (tmp_path / f"{index:03d}-{path.name}").write_bytes(dump)
    result = _run_zod(tmp_path)
    assert result.returncode == 0, result.stderr


@needs_zod
def test_zod_rejects_what_pydantic_rejects(tmp_path: Path):
    for index, path in enumerate(INVALID):
        (tmp_path / f"{index:03d}-{path.name}").write_text(path.read_text())
    result = _run_zod("--expect-fail", tmp_path)
    assert result.returncode == 0, result.stderr
