"""Shared fixtures for the replay unit tests: the R0 TSLA day through the same registry protocols the services use."""

import sys
from datetime import UTC, date, datetime
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))

from fakes import fake_data_sources  # noqa: E402

from ai_trading.replay import fixture  # noqa: E402
from ai_trading.replay.cache import MemoryBlobStore  # noqa: E402
from ai_trading.replay.data import DayInputs, History  # noqa: E402
from ai_trading.replay.tape import Tape  # noqa: E402

NOW = datetime(2026, 10, 24, 16, 0, tzinfo=UTC)
DAY = date(2026, 9, 25)


@pytest.fixture(scope="session")
def sources():
    return fixture.fixture_sources(fake_data_sources())


@pytest.fixture(scope="session")
def inputs(sources) -> DayInputs:
    return History(sources, now=lambda: NOW).day_inputs(MemoryBlobStore(), "TSLA", DAY)


@pytest.fixture
def store() -> MemoryBlobStore:
    return MemoryBlobStore()


@pytest.fixture
def tape(sources) -> Tape:
    return Tape(sources, now=lambda: NOW)
