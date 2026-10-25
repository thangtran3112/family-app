"""Shared fixtures for the replay unit tests: the R0 TSLA day through the same registry protocols the services use."""

import sys
from datetime import UTC, date, datetime
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))

from daily_world import NOW as DAILY_NOW  # noqa: E402
from daily_world import SyntheticBars, _build_world, make_services  # noqa: E402
from fakes import fake_data_sources  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from ai_trading.cli.seed_technical import seed_user  # noqa: E402
from ai_trading.db.models import User  # noqa: E402
from ai_trading.replay import fixture  # noqa: E402
from ai_trading.replay.cache import MemoryBlobStore  # noqa: E402
from ai_trading.replay.data import DayInputs, History  # noqa: E402
from ai_trading.replay.session import Services  # noqa: E402
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


# -- the daily-list world (tests/daily_world.py): synthetic bars, the owner and the services over them --------


@pytest.fixture
def world() -> SyntheticBars:
    return _build_world()


@pytest.fixture
def svc(world) -> Services:
    return make_services(world)


@pytest.fixture
def user_id(db_session: Session) -> int:
    user = User(email="owner@example.com", settings={})
    db_session.add(user)
    db_session.flush()
    seed_user(db_session, user.id, now=DAILY_NOW)
    db_session.commit()
    return user.id
