"""The E2E fixture clock (`clock.py`): one frozen instant the scenarios can move, patched into every API module
that reads the wall clock, and put back afterwards."""

from datetime import UTC, datetime

import clock
import pytest
from clock import E2E_NOW, FrozenDateTime, current_now, freeze_api_clocks, reset_now, set_now

from ai_trading.api import dashboard, status


@pytest.fixture(autouse=True)
def _unfrozen():
    yield
    reset_now()


def test_the_clock_starts_at_the_seed_instant_and_moves_on_request():
    assert current_now() == E2E_NOW
    set_now(datetime(2026, 10, 15, 15, 30, tzinfo=UTC))
    assert FrozenDateTime.now(UTC) == datetime(2026, 10, 15, 15, 30, tzinfo=UTC)
    reset_now()
    assert FrozenDateTime.now(UTC) == E2E_NOW


def test_a_scenario_instant_needs_a_timezone():
    with pytest.raises(ValueError, match="timezone"):
        set_now(datetime(2026, 10, 15, 15, 30))


def test_freezing_patches_every_listed_api_module_and_restore_puts_them_back():
    originals = {module: module.datetime for module in (dashboard, status)}
    restore = freeze_api_clocks()
    try:
        assert dashboard.datetime is FrozenDateTime and status.datetime is FrozenDateTime
        assert dashboard.datetime.now(UTC) == E2E_NOW
    finally:
        restore()
    assert {module: module.datetime for module in (dashboard, status)} == originals
    assert clock.FrozenDate.today() == E2E_NOW.date()
