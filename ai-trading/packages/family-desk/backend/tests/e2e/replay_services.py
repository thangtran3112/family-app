"""The Practice services of the browser E2E server: the replay services the test-only runtime serves, never a deployed
one.

`server.py` installs `replay_services(...)` as `app.state.replay_services` for the E2E lifespan only, so the stub flag
path (`replay/fixture.py`, `DESK_REPLAY_STUB`) is untouched and no deployed process can reach this module. The services
answer from the fixture (TSLA on one real day, anything else `NoData`, as under the stub flag) on the frozen E2E clock.
The synthetic swing world this module used to serve went with the swing code (ADR-0025).
"""

import sys
from dataclasses import replace
from pathlib import Path

from ai_trading_common.registry import DataSources

_TESTS = Path(__file__).resolve().parents[1]
for _path in (_TESTS, _TESTS / "api"):
    if str(_path) not in sys.path:
        sys.path.append(str(_path))

from clock import current_now  # noqa: E402

from ai_trading.replay.data import History  # noqa: E402
from ai_trading.replay.fixture import FixtureBars, FixtureTrades  # noqa: E402
from ai_trading.replay.session import Services  # noqa: E402
from ai_trading.replay.tape import Tape  # noqa: E402


def replay_services(base: DataSources) -> Services:
    """The Practice services of the E2E runtime over `base` (the seeded sources), on the frozen E2E clock. The earnings
    flag has no calendar to ask (`sources=None`), as under the stub flag."""
    sources = replace(base, bars=FixtureBars(), trades=FixtureTrades())
    return Services(
        history=History(sources, now=current_now), tape=Tape(sources, now=current_now), now=current_now, sources=None
    )
