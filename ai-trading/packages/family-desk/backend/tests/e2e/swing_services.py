"""The swing world of the browser E2E server (02p): the replay services the test-only runtime serves, never a deployed
one.

`server.py` installs `replay_services(...)` as `app.state.replay_services` for the E2E lifespan only, so the stub flag
path (`replay/fixture.py`, `DESK_REPLAY_STUB`, TSLA on one real day) is untouched and no deployed process can reach this
module (`tests/test_mvp_stub_flag.py` and `test_swing_services.py` pin both). The services answer from three places:

- `S01`..`S12` and `SPY` from the synthetic swing world (`tests/swing_world.py`, the generators the swing tests use);
- `TSLA` on 2026-09-25 from the fixture, so the existing Practice specs run unchanged;
- anything else is `NoData`, as under the stub flag.

**The scripted world** (all prices made up; session numbers are 1-based from the first day, Mon 2026-09-14, so a swing
thread of 15 to 20 sessions starts there and ends by Fri 2026-10-09; one-minute history reaches 14 sessions before it;
all of it is before the E2E clock of Thu 2026-10-15 20:00 ET). Every stock sits near its base price with a 0.3% wiggle,
trades 1.5 to 3 million shares a day, and a day runs open to close in a straight line:

- `S01` (base 100) gaps UP 6% at the open of session 4 (Thu 2026-09-17) and stays there: a carried hold gains the gap.
- `S02` (90) gaps DOWN 8% at the open of session 7 (Tue 2026-09-22), to about 83. A carried long whose stop is above
  that (86, say) is gapped through, so the stop pause fires at the open.
- `S03` (50 adjusted, 100 raw before the split) splits 2-for-1 effective session 6 (Mon 2026-09-21): a hold carried
  over the weekend doubles its shares.
- `S04` (80) rises exactly 1% a day from session 1; `S05` (120) falls exactly 1% a day.
- `S06`..`S12` (60, 70, 50, 40, 30, 25, 20) have the wiggle only. `SPY` (400) is the benchmark: daily bars only, never
  in a universe, and thinly traded (50,000 shares a day, under the live floor) so the day-list scan of the TSLA practice
  day never lists it.

The universe of `swing_world.swing_setup()` tags `S01`..`S04` watchlist, `S05`-`S06` manual, `S07`-`S08` filter and
`S09`..`S12` liquidity; a spec builds it by `add`ing the twelve symbols with `fill: "none"`. The minute bars are flat
(open = high = low = close) with a volume of 1,000, so a price is the same whatever the display interval; the 09:30
bar's close is the open and the 15:59 bar's close is the close. Because the bars are flat, a stop crossed by the trend
alone reads as a `gap` pause.

The clock is the E2E frozen clock, so a create is checked against Oct 2026 and not against the day the suite runs.
Everything is cheap: the whole world is under a million numbers, built once per process, and nothing touches a network.
"""

import sys
from dataclasses import replace
from pathlib import Path

from ai_trading_common.registry import DataSources

# The synthetic generators live beside the tests (`tests/swing_world.py`, `tests/daily_world.py`, `tests/api/fakes.py`).
_TESTS = Path(__file__).resolve().parents[1]
for _path in (_TESTS, _TESTS / "api"):
    if str(_path) not in sys.path:
        sys.path.append(str(_path))

from clock import current_now  # noqa: E402
from swing_world import BENCHMARK, swing_world  # noqa: E402

from ai_trading.replay.data import History  # noqa: E402
from ai_trading.replay.fixture import FixtureBars, FixtureTrades  # noqa: E402
from ai_trading.replay.session import Services  # noqa: E402
from ai_trading.replay.tape import Tape  # noqa: E402

BENCHMARK_VOLUME = 50_000.0  # shares a day, under the live floor of 500,000


class E2EBars:
    """`BarsSource`: the swing world for its symbols, the fixture (TSLA, else `NoData`) for everything else."""

    def __init__(self) -> None:
        self.world = swing_world()
        self.fixture = FixtureBars()

    def bars(self, symbol, timeframe, start, end, *, now, adjustment="all"):
        # SPY has daily bars only: asking the world for its minutes would be a KeyError, and the fixture says NoData.
        if symbol in self.world.raw and (timeframe == "1d" or symbol in self.world.minutes):
            found = self.world.bars(symbol, timeframe, start, end, now=now, adjustment=adjustment)
            if symbol == BENCHMARK:
                # SPY is one of the Desk's seed symbols, so a daily list of the TSLA practice day would scan it. Under
                # the live liquidity floor it is never listed there; the week review only reads its closes.
                found = replace(found, frame=found.frame.assign(volume=BENCHMARK_VOLUME))
            return found
        return self.fixture.bars(symbol, timeframe, start, end, now=now, adjustment=adjustment)


def replay_services(base: DataSources) -> Services:
    """The Practice services of the E2E runtime over `base` (the seeded sources), on the frozen E2E clock. The earnings
    flag has no calendar to ask (`sources=None`), as under the stub flag."""
    sources = replace(base, bars=E2EBars(), trades=FixtureTrades())
    return Services(
        history=History(sources, now=current_now), tape=Tape(sources, now=current_now), now=current_now, sources=None
    )
