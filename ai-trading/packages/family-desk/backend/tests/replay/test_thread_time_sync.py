"""One thread time (Step 0 of the time-sync plan): every surface of a day thread tells the same time, the same tape end
and the same price at the thread clock T. Real Postgres; the synthetic world of `tests/daily_world.py`.

**The reproduction.** Thursday-style night: the thread clock sits at 20:00 ET plus five hours (01:00 ET the next
calendar date, the "Fri 1:22 AM" of the report), paused, with the wall clock pinned. Two names are open: GAPPER (opened
by `start_session`, so its stored tape end is the extended close) and FLAT, whose row is rewritten to the shape every
session saved before ADR-0018 amendment (b) has: `window_end` 16:00, `spec.session` "regular". After 16:00 FLAT trades
at 52 (the extended-hours tape), before it at 50.

**What "no data" on the day list was (settled, not guessed).** Candidates (a) read failed/timed out, (b) provider error
on a name, (c) `History._lru` of 8 days evicting. Probed here against this code and the synthetic data path:
  * The day list's `live` block is NOT null at T past 20:00: `screen.live_quote` cuts every input at T with
    `cut_frames` and returns the last extended-hours close (`test_the_day_list_prices_every_name_overnight`, green on
    dev). So no rule in the live path turns a night clock into "no data", and the dashes are not a logic defect.
  * Candidate (c) as written is wrong: the live path never touches `History._lru` (that LRU serves `day_inputs`, the
    session path). It reads `minutes_loader`, which calls `History.minute_bars` for the day and 14 prior sessions of
    EVERY listed name on EVERY read, and `minute_bars` has no memory cache: each read is names x 15 blob fetches and
    decodes (15 per name, counted in `test_a_live_read_decodes_names_times_sessions_blobs`; 48 names = 720 per read).
    Measured on a tmpfs Postgres with `DbBlobStore` and the synthetic FLAT-like bars (which compress far better than
    a real 10,500-row day): a 48-name `day_list_out(live=True)` took 3.6 s, six reads in a row, 0 of 48 `live` null.
  * So the real trigger is (a), produced by that per-read cost: `DayListScreen` re-reads the whole live list every clock
    minute (and on each re-scan), each read decodes ~720 blobs from Postgres, and a request that is slow, contended
    (`settle_day` takes the day-list row lock on a running clock) or cut off leaves the screen with no `live` block,
    which it draws as dashes. (b) is a per-name `None` and cannot blank a whole list.
  Not provable from here: the owner's production database and a captured failing response are out of reach of a
  sandboxed checkout (and no ad-hoc production reads are allowed), so (a) is established from the code path and the
  measured per-read cost, not from a captured 5xx. A2/A7 remove the cost (one prepared series per name, in memory).

**Invariants (plan §2.1).** I1 one instant: `thread_time` is T on every payload. I2 one tape end: `data_through` is
`min(T, 20:00)` for every name of the day, legacy rows included. I3 one price: the chart, the day list's `live` block,
the positions and the clock's account agree. I5: a read moves nothing.
"""

import pandas as pd
import pytest
from daily_world import DAYS, NOW, make_thread
from test_day_positions import _bend
from test_replay_switch import _feed, _mark, _names, _row

from ai_trading.core.calendar import et
from ai_trading.db.models import PracticePlan
from ai_trading.replay import clock as clock_mod
from ai_trading.replay import plan as plan_mod
from ai_trading.replay import session as session_mod

NIGHT = et(DAYS[0], "20:00") + pd.Timedelta(hours=5)  # 01:00 ET on the next calendar date
TAPE_END = et(DAYS[0], "20:00")


@pytest.fixture
def pinned(svc) -> list:
    """The wall clock, pinned: no settle can move a paused clock, and a running one settles by exactly zero."""
    now = [NOW]
    svc.wall = lambda: now[0]
    return now


def _sync(db_session, user_id, svc, session_id) -> dict:
    return session_mod.advance(
        db_session,
        user_id,
        session_id,
        svc,
        to=None,
        step=None,
        sync=True,
        interval=None,
        min_size=0,
        min_notional=0,
        max_prints=50,
    )


def _night(db_session, user_id, svc, world, *, long_flat: bool = True):
    """A day with GAPPER and a legacy FLAT open, FLAT long 10 shares from 09:30, the clock at `NIGHT`. Returns
    `(thread id, day list, GAPPER session, FLAT session)`."""
    _bend(world, "FLAT", "16:00", None, open=52.0, high=52.0, low=52.0, close=52.0)  # the extended-hours tape
    make_thread(db_session, user_id)
    row, gapper = _names(db_session, user_id, svc, "FLAT")
    flat = plan_mod.start_session(db_session, user_id, row.id, "FLAT", svc)
    if long_flat:
        _mark(db_session, user_id, svc, flat.id, "long_entry", shares=10)
    legacy = _row(db_session, flat.id)
    legacy.window_end = et(DAYS[0], "16:00").to_pydatetime()  # a session saved before the extended-tape rule
    assert legacy.spec["session"] == "regular"
    db_session.commit()
    thread_id = db_session.get(PracticePlan, row.plan_id).thread_id
    clock_mod.control(
        db_session, user_id, thread_id, svc, running=None, speed=None, to=NIGHT.to_pydatetime(), step=None
    )
    db_session.commit()
    return thread_id, row, gapper, flat


def _live(db_session, user_id, svc, row) -> dict:
    return plan_mod.day_list_out(db_session, user_id, row.id, svc, live=True)


def _candidate(out: dict, symbol: str) -> dict:
    return next(c for c in out["candidates"] if c["symbol"] == symbol)


# -- I1: one instant --------------------------------------------------------------------------------------------------


def test_every_surface_reports_the_thread_clock_as_its_time(db_session, user_id, svc, world, pinned) -> None:
    thread_id, row, gapper, flat = _night(db_session, user_id, svc, world)
    clock = clock_mod.read(db_session, user_id, thread_id, svc)["clock"]
    db_session.commit()
    assert clock == NIGHT  # the clock view is the reference

    seen = {"clock": clock}
    for label, session_id in (("GAPPER", gapper.id), ("FLAT (legacy)", flat.id)):
        seen[f"feed {label}"] = _feed(db_session, user_id, svc, session_id).get("thread_time")
        db_session.commit()
        frame = _sync(db_session, user_id, svc, session_id)
        db_session.commit()
        # Today the only time on a name's payload is `day_clock`, which is min(T, the name's stored tape end).
        seen[f"advance {label}"] = frame.get("thread_time")
        seen[f"day_clock {label}"] = frame["day_clock"]
    listed = _live(db_session, user_id, svc, row)
    seen["day list"] = listed.get("thread_time")
    wrong = {label: value for label, value in seen.items() if value != NIGHT}
    assert not wrong, f"every surface must name T={NIGHT}; these do not: {wrong}"


# -- I2: one tape end per day -----------------------------------------------------------------------------------------


def test_a_name_that_was_not_synced_shows_the_tape_through_its_end(db_session, user_id, svc, world, pinned) -> None:
    """RC3: the feed cuts at the name's stored playhead (09:30, nobody synced it), not at the thread's time."""
    _, _, gapper, flat = _night(db_session, user_id, svc, world)
    for label, session_id in (("GAPPER", gapper.id), ("FLAT (legacy)", flat.id)):
        out = _feed(db_session, user_id, svc, session_id)
        db_session.commit()
        assert out.get("data_through") == TAPE_END, (label, out["revealed_through"], out.get("data_through"))
        assert out["bars"][-1]["t"] + pd.Timedelta(minutes=5) == TAPE_END, label


def test_a_legacy_row_with_a_sixteen_hundred_end_runs_to_the_extended_close(
    db_session, user_id, svc, world, pinned
) -> None:
    """RC1: `window_end_of` keeps a legacy open row at 16:00 while the Summary says the tape runs to 20:00."""
    _, _, gapper, flat = _night(db_session, user_id, svc, world)
    gapper_frame = _sync(db_session, user_id, svc, gapper.id)
    flat_frame = _sync(db_session, user_id, svc, flat.id)
    db_session.commit()
    assert gapper_frame["revealed_through"] == TAPE_END  # the new row already ends at 20:00
    assert flat_frame["revealed_through"] == TAPE_END, "the legacy FLAT row stopped at its stored 16:00 end"
    assert flat_frame["at_end"] is True and flat_frame.get("data_through") == TAPE_END
    assert session_mod.window_end_of(_row(db_session, flat.id)) == TAPE_END


# -- I3: one price ----------------------------------------------------------------------------------------------------


def test_one_price_on_the_chart_the_day_list_the_position_and_the_account(
    db_session, user_id, svc, world, pinned
) -> None:
    thread_id, row, _, flat = _night(db_session, user_id, svc, world)
    clock = pd.Timestamp(NIGHT)
    prices = {
        "feed.last": _feed(db_session, user_id, svc, flat.id)["last"]["price"],
        "day list live": _candidate(_live(db_session, user_id, svc, row), "FLAT")["live"]["price"],
        "positions()": session_mod.positions(db_session, svc, row.id, clock)[0].price,
        "advance(sync).last": _sync(db_session, user_id, svc, flat.id)["last"]["price"],
    }
    account = clock_mod.read(db_session, user_id, thread_id, svc)["account"]
    db_session.commit()
    prices["account (entry + open P/L per share)"] = 50.0 + account["open_pnl_usd"] / 10
    assert set(prices.values()) == {52.0}, prices


# -- what stays true today (guards, green before and after) ------------------------------------------------------------


def test_the_day_list_prices_every_name_overnight(db_session, user_id, svc, world, pinned) -> None:
    """The live block is not null past 20:00: the "no data" of the report is not a logic defect (see the header)."""
    _, row, _, _ = _night(db_session, user_id, svc, world)
    listed = _live(db_session, user_id, svc, row)
    for candidate in listed["candidates"]:
        live = candidate["live"]
        assert live is not None and live["price"] is not None, candidate["symbol"]
        assert pd.Timestamp(live["at"]) == NIGHT


def test_a_live_read_decodes_names_times_sessions_blobs(db_session, user_id, svc, world, pinned) -> None:
    """Candidate (c)/(a): count blob reads of one live day-list read. 3 names x 15 sessions (14 lookback + the day),
    twice over (daily as-of blob + minute blobs are separate kinds, so only minutes are counted here)."""
    _, row, _, _ = _night(db_session, user_id, svc, world)
    store = svc.store_factory(db_session)
    reads: list[str] = []
    real = store.get

    def counting(key):
        reads.append(key.kind)
        return real(key)

    store.get = counting  # type: ignore[method-assign]
    _live(db_session, user_id, svc, row)
    minute_reads = reads.count("bars1m")
    names = len(row.candidates)
    assert minute_reads >= names * 15, (minute_reads, names)
    print(f"\n[no-data probe] one live read: {minute_reads} bars1m blob reads for {names} names")


def test_a_read_moves_nothing(db_session, user_id, svc, world, pinned) -> None:
    """I5: the same T gives the same output, and a feed does not write a name's playhead."""
    _, row, gapper, _ = _night(db_session, user_id, svc, world)
    before = _row(db_session, gapper.id).revealed_through
    first, second = _feed(db_session, user_id, svc, gapper.id), _feed(db_session, user_id, svc, gapper.id)
    assert first == second
    assert _row(db_session, gapper.id).revealed_through == before
    assert _live(db_session, user_id, svc, row) == _live(db_session, user_id, svc, row)
