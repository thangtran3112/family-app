"""Zod JSON <-> Pydantic parse, in both directions, over every shared fixture and shipped template.

Zod -> Pydantic: each valid file is parsed by its Pydantic model and dumps back to itself.
Pydantic -> Zod: those dumps are re-parsed by contracts/scripts/parse-configs.ts with the matching
Zod schema; every invalid file must fail in both validators. The verdict is the contract, not the
error text.
"""

import json
import shutil
import subprocess
from pathlib import Path

import pytest
from pydantic import BaseModel, TypeAdapter, ValidationError

from ai_trading.contracts.alert_strategy import AlertStrategySpecV1
from ai_trading.contracts.practice_block import PracticeBlockV1
from ai_trading.contracts.practice_thread import (
    PRACTICE_THREAD_RULES,
    SWING_SETUP_RULES,
    PracticeLedgerEntryV1,
    PracticeThreadCreateV1,
    PracticeThreadPatchV1,
    PracticeThreadV1,
)
from ai_trading.contracts.replay_session import PracticeMarkV1, ReplaySessionV1
from ai_trading.contracts.strategy_draft import StrategyDraft
from ai_trading.contracts.strategy_spec_v1 import FilterStrategySpecV1, PresetCatalogV1, StrategySpecV1

CONTRACTS = Path(__file__).resolve().parents[2] / "contracts"
SCRIPT = CONTRACTS / "scripts" / "parse-configs.ts"

# schema flag -> (Pydantic model, valid directories, invalid directories), relative to contracts/
FAMILIES: dict[str, tuple[type[BaseModel], list[str], list[str]]] = {
    "spec": (
        StrategySpecV1,
        ["fixtures/strategy-spec-v1/valid", "templates", "templates/patterns", "templates/setups"],
        ["fixtures/strategy-spec-v1/invalid"],
    ),
    "filter": (
        FilterStrategySpecV1,
        ["fixtures/filter-strategy-spec-v1/valid", "templates/filters"],
        ["fixtures/filter-strategy-spec-v1/invalid"],
    ),
    "alert": (AlertStrategySpecV1, ["fixtures/alert-strategy/valid"], ["fixtures/alert-strategy/invalid"]),
    "draft": (StrategyDraft, ["fixtures/strategy-draft/valid"], ["fixtures/strategy-draft/invalid"]),
    "catalog": (PresetCatalogV1, ["fixtures/preset-catalog-v1/valid"], ["fixtures/preset-catalog-v1/invalid"]),
    "replay": (ReplaySessionV1, ["fixtures/replay-session-v1/valid"], ["fixtures/replay-session-v1/invalid"]),
    "mark": (PracticeMarkV1, ["fixtures/practice-mark-v1/valid"], ["fixtures/practice-mark-v1/invalid"]),
    "block": (PracticeBlockV1, ["fixtures/practice-block-v1/valid"], ["fixtures/practice-block-v1/invalid"]),
    "threadcreate": (
        PracticeThreadCreateV1,
        ["fixtures/practice-thread-create-v1/valid"],
        ["fixtures/practice-thread-create-v1/invalid"],
    ),
    "threadpatch": (
        PracticeThreadPatchV1,
        ["fixtures/practice-thread-patch-v1/valid"],
        ["fixtures/practice-thread-patch-v1/invalid"],
    ),
    "thread": (PracticeThreadV1, ["fixtures/practice-thread-v1/valid"], ["fixtures/practice-thread-v1/invalid"]),
    "ledger": (
        PracticeLedgerEntryV1,
        ["fixtures/practice-ledger-entry-v1/valid"],
        ["fixtures/practice-ledger-entry-v1/invalid"],
    ),
}

needs_zod = pytest.mark.skipif(
    shutil.which("node") is None or not (CONTRACTS / "node_modules" / "zod").exists(),
    reason="needs node and `pnpm install` in contracts/",
)


def _files(directories: list[str]) -> list[Path]:
    return [path for directory in directories for path in sorted((CONTRACTS / directory).glob("*.json"))]


def _rel(path: Path) -> str:
    return str(path.relative_to(CONTRACTS))


VALID = [(family, path) for family, (_, valid, _) in FAMILIES.items() for path in _files(valid)]
VALID.append(("catalog", CONTRACTS / "catalog.json"))  # the shipped catalog sits outside any fixture folder
INVALID = [(family, path) for family, (_, _, invalid) in FAMILIES.items() for path in _files(invalid)]
_id = lambda pair: f"{pair[0]}:{_rel(pair[1])}"  # noqa: E731


def test_every_family_has_fixtures():
    assert len(VALID) >= 168 and len(INVALID) >= 420


@pytest.mark.parametrize("pair", VALID, ids=_id)
def test_valid_file_round_trips_through_pydantic(pair: tuple[str, Path]):
    family, path = pair
    raw = json.loads(path.read_text())
    model = FAMILIES[family][0].model_validate_json(path.read_text())
    assert TypeAdapter(type(model)).dump_python(model, mode="json", by_alias=True, exclude_unset=True) == raw


@pytest.mark.parametrize("pair", INVALID, ids=_id)
def test_invalid_file_is_rejected_by_pydantic(pair: tuple[str, Path]):
    family, path = pair
    with pytest.raises(ValidationError):
        FAMILIES[family][0].model_validate_json(path.read_text())


@pytest.mark.parametrize(
    ("family", "fixture", "rule"),
    [
        ("threadcreate", "create-v1/invalid/mode-swing-without-block.json", PRACTICE_THREAD_RULES[1]),
        ("threadcreate", "create-v1/invalid/swing-on-day-thread.json", PRACTICE_THREAD_RULES[1]),
        ("thread", "v1/invalid/swing-without-block.json", PRACTICE_THREAD_RULES[1]),
        ("thread", "v1/invalid/day-thread-with-swing-block.json", PRACTICE_THREAD_RULES[1]),
        ("threadcreate", "create-v1/invalid/swing-universe-duplicate-symbol.json", SWING_SETUP_RULES[0]),
    ],
)
def test_swing_rules_fail_with_their_own_message(family: str, fixture: str, rule):
    """A fixture could be rejected for another reason: prove the hand-written rule is the one that fires."""
    path = CONTRACTS / "fixtures" / f"practice-thread-{fixture}"
    with pytest.raises(ValidationError, match=rule.description):
        FAMILIES[family][0].model_validate_json(path.read_text())


def _run_zod(family: str, *args: str | Path) -> subprocess.CompletedProcess[str]:
    command = ["node", str(SCRIPT), "--schema", family, *map(str, args)]
    return subprocess.run(command, cwd=CONTRACTS, capture_output=True, text=True)


@needs_zod
@pytest.mark.parametrize("family", FAMILIES)
def test_zod_parses_what_pydantic_serializes(family: str, tmp_path: Path):
    model_type = FAMILIES[family][0]
    for index, path in enumerate(path for f, path in VALID if f == family):
        dump = model_type.model_validate_json(path.read_text()).model_dump_json(by_alias=True, exclude_unset=True)
        (tmp_path / f"{index:03d}-{path.name}").write_text(dump)
    result = _run_zod(family, tmp_path)
    assert result.returncode == 0, result.stderr


@needs_zod
@pytest.mark.parametrize("family", FAMILIES)
def test_zod_rejects_what_pydantic_rejects(family: str, tmp_path: Path):
    for index, path in enumerate(path for f, path in INVALID if f == family):
        (tmp_path / f"{index:03d}-{path.name}").write_text(path.read_text())
    result = _run_zod(family, "--expect-fail", tmp_path)
    assert result.returncode == 0, result.stderr
