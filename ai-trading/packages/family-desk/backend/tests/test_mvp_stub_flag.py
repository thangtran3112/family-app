"""`DESK_MVP_STUB` is a development flag: it must never reach a deployed environment (02m §d2 step 2)."""

import dataclasses
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

import pandas as pd
import pytest
from ai_trading_common.errors import NoData
from ai_trading_common.registry import DataSources

from ai_trading.api.replay import get_services
from ai_trading.mvp_stub import STUB_FLAG, stub_enabled
from ai_trading.replay import fixture

_BACKEND = Path(__file__).resolve().parents[1]
_AI_TRADING = _BACKEND.parents[2]
_REPO = _AI_TRADING.parent
#: Everything that configures a deployed environment: compose files and scripts, the image, the
#: infrastructure tree, and the CI workflows that build and deploy ai-trading.
_DEPLOY_PATHS = [
    _AI_TRADING / "deploy",
    _BACKEND / "Dockerfile",
    _BACKEND / "docker",
    _REPO / "infrastructure",
    *sorted((_REPO / ".github" / "workflows").glob("ai-trading*")),
]


@pytest.mark.parametrize(
    ("value", "expected"), [("1", True), ("0", False), ("true", False), ("", False), (None, False)]
)
def test_only_exactly_one_turns_the_stub_on(monkeypatch: pytest.MonkeyPatch, value: str | None, expected: bool) -> None:
    if value is None:
        monkeypatch.delenv(STUB_FLAG, raising=False)
    else:
        monkeypatch.setenv(STUB_FLAG, value)
    assert stub_enabled() is expected


@pytest.mark.parametrize(
    ("value", "expected"), [("1", True), ("0", False), ("true", False), ("", False), (None, False)]
)
def test_only_exactly_one_turns_the_replay_stub_on(
    monkeypatch: pytest.MonkeyPatch, value: str | None, expected: bool
) -> None:
    if value is None:
        monkeypatch.delenv(fixture.STUB_FLAG, raising=False)
    else:
        monkeypatch.setenv(fixture.STUB_FLAG, value)
    assert fixture.stub_enabled() is expected


def test_no_deploy_file_sets_the_stub_flag() -> None:
    existing = [path for path in _DEPLOY_PATHS if path.exists()]
    assert existing, "deploy paths moved: update _DEPLOY_PATHS"
    offenders = []
    for root in existing:
        for path in [root] if root.is_file() else (p for p in root.rglob("*") if p.is_file()):
            try:
                if any(flag in path.read_text(errors="ignore") for flag in (STUB_FLAG, fixture.STUB_FLAG)):
                    offenders.append(str(path.relative_to(_REPO)))
            except OSError:
                continue
    assert offenders == []


def test_the_stub_flag_serves_the_tsla_fixture_and_nothing_else(monkeypatch: pytest.MonkeyPatch) -> None:
    """The swing world the browser server serves (`tests/e2e/swing_services.py`) is installed by the E2E lifespan only:
    the flag's own services still answer for TSLA on the fixture day and say `NoData` for a swing symbol."""
    monkeypatch.setenv(fixture.STUB_FLAG, "1")
    base = DataSources(**{field.name: object() for field in dataclasses.fields(DataSources)})
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace()))
    services = get_services(request, base)  # type: ignore[arg-type]
    assert request.app.state.replay_services is services and services.sources is None
    day = pd.Timestamp(fixture.DAY, tz="UTC")
    bars = services.history._sources.bars  # type: ignore[attr-defined]
    assert len(bars.bars("TSLA", "1d", day - pd.Timedelta(days=30), day, now=datetime.now(UTC)).frame) > 0
    for symbol in ("S01", "SPY", "AAPL"):
        with pytest.raises(NoData):
            bars.bars(symbol, "1d", day - pd.Timedelta(days=30), day, now=datetime.now(UTC))
