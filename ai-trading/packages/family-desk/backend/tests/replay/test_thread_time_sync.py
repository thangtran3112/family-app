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
    session path). It read `minutes_loader`, which calls `History.minute_bars` for the day and 14 prior sessions of
    EVERY listed name on EVERY read, and `minute_bars` has no memory cache: 15 blob decodes a name (counted on dev; 48
    names = 720 per read).
  * Measured on a tmpfs Postgres with `DbBlobStore` and the synthetic FLAT-like bars (48 names, `day_list_out(live=
    True)`, 0 of 48 `live` null at any point): dev 3.6 s per read, six reads in a row. A2 replaced the decodes with
    prepared series and it was still 2.8 s: cProfile put the rest in `metric_row`, about 55 ms a name per read (a
    strftime over every minute bar and a rolling pivot in `rvol_intraday`), so the decodes were about a quarter of the
    cost and the metric row about three quarters. A7 computes the metric row once per closed minute and name and warms
    it: 0.03 s a read (`test_day_warm.py` counts the blobs and the metric rows of a warm 49-name read).
  * So the real trigger is (a), produced by that per-read cost: `DayListScreen` re-reads the whole live list every clock
    minute (and on each re-scan), each read burned seconds of CPU on the request thread (more on real 10,500-row days
    than on these flat bars), and a request that is slow, contended (`settle_day` takes the day-list row lock on a
    running clock) or cut off leaves the screen with no `live` block, which it draws as dashes. (b) is a per-name
    `None` and cannot blank a whole list.
  Not provable from here: the owner's production database and a captured failing response are out of reach of a
  sandboxed checkout (and no ad-hoc production reads are allowed), so (a) is established from the code path and the
  measured per-read cost, not from a captured 5xx or a timing taken on production data.

**Invariants (plan §2.1).** I1 one instant: `thread_time` is T on every payload. I2 one tape end: `data_through` is
`min(T, 20:00)` for every name of the day, legacy rows included. I3 one price: the chart, the day list's `live` block,
the positions and the clock's account agree. I5: a read moves nothing.
"""

from types import SimpleNamespace

import pandas as pd
import pytest
from ai_trading_common.trades import Trades
from daily_world import DAYS, NOW, make_thread
from test_day_positions import _bend
from test_replay_switch import _feed, _mark, _names, _row

from ai_trading.core.calendar import et
from ai_trading.db.models import PracticePlan
from ai_trading.replay import clock as clock_mod
from ai_trading.replay import frames
from ai_trading.replay import plan as plan_mod
from ai_trading.replay import session as session_mod
from ai_trading.replay.session import ReplayProblem
from ai_trading.replay.tape import Tape

NIGHT = et(DAYS[0], "20:00") + pd.Timedelta(hours=5)  # 01:00 ET on the next calendar date
TAPE_END = et(DAYS[0], "20:00")
LATE = et(DAYS[0], "19:58:30")  # inside the print's lookback: a last print exists at this clock


class PrintTrades:
    """One eligible print on FLAT at 19:58:10 ET for 52.37 (the 19:57 bar closes at 52.0): a tape that disagrees with
    the minute bars by a few cents, the way a live print inside a minute does."""

    def trades(self, symbol, start, end, *, feed, now=None):
        at = et(DAYS[0], "19:58:10")
        rows = [(at, 52.37, 100, "D", "@")] if symbol == "FLAT" and start <= at <= end else []
        frame = pd.DataFrame(rows, columns=["t", "p", "s", "x", "c"])
        frame["t"] = pd.to_datetime(frame["t"], utc=True)
        return Trades(frame=frame, source="synthetic", feed=feed)


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


def _night(db_session, user_id, svc, world, *, at=NIGHT):
    """A day with GAPPER and a legacy FLAT open, FLAT long 10 shares from 09:30, the clock at `at`. Returns
    `(thread id, day list, GAPPER session, FLAT session)`."""
    _bend(world, "FLAT", "16:00", None, open=52.0, high=52.0, low=52.0, close=52.0)  # the extended-hours tape
    make_thread(db_session, user_id)
    row, gapper = _names(db_session, user_id, svc, "FLAT")
    flat = plan_mod.start_session(db_session, user_id, row.id, "FLAT", svc)
    _mark(db_session, user_id, svc, flat.id, "long_entry", shares=10)
    legacy = _row(db_session, flat.id)
    legacy.window_end = et(DAYS[0], "16:00").to_pydatetime()  # a session saved before the extended-tape rule
    assert legacy.spec["session"] == "regular"
    db_session.commit()
    thread_id = db_session.get(PracticePlan, row.plan_id).thread_id
    clock_mod.control(db_session, user_id, thread_id, svc, running=None, speed=None, to=at.to_pydatetime(), step=None)
    db_session.commit()
    return thread_id, row, gapper, flat


def _live(db_session, user_id, svc, row) -> dict:
    return plan_mod.day_list_out(db_session, user_id, row.id, svc, live=True)


def _candidate(out: dict, symbol: str) -> dict:
    return next(c for c in out["candidates"] if c["symbol"] == symbol)


# -- I2 (A1): one tape end per day ------------------------------------------------------------------------------------


def test_a_legacy_row_with_a_sixteen_hundred_end_runs_to_the_extended_close(
    db_session, user_id, svc, world, pinned
) -> None:
    """RC1: `window_end_of` kept a legacy open row at 16:00 while the Summary says the tape runs to 20:00."""
    _, _, gapper, flat = _night(db_session, user_id, svc, world)
    gapper_frame = _sync(db_session, user_id, svc, gapper.id)
    flat_frame = _sync(db_session, user_id, svc, flat.id)
    db_session.commit()
    assert gapper_frame["revealed_through"] == TAPE_END  # the new row already ends at 20:00
    assert flat_frame["revealed_through"] == TAPE_END, "the legacy FLAT row stopped at its stored 16:00 end"
    assert flat_frame["day_clock"] == TAPE_END and flat_frame["at_end"] is True
    assert session_mod.window_end_of(_row(db_session, flat.id), day_thread=True) == TAPE_END


def test_the_derived_end_applies_to_an_open_day_thread_session_only() -> None:
    row = SimpleNamespace(
        status="active", day=DAYS[0], window_end=et(DAYS[0], "16:00").to_pydatetime(), spec={"session": "regular"}
    )
    assert session_mod.window_end_of(row, day_thread=True) == TAPE_END  # derived, whatever was stored
    assert session_mod.window_end_of(row, day_thread=False) == et(DAYS[0], "16:00")  # swing and standalone: as before
    row.window_end = et(DAYS[0], "11:30").to_pydatetime()  # a row stored with her old focus mark
    assert session_mod.window_end_of(row, day_thread=False) == et(DAYS[0], "16:00")
    row.status, row.window_end = "ended", et(DAYS[0], "12:00").to_pydatetime()
    assert session_mod.window_end_of(row, day_thread=True) == et(DAYS[0], "12:00")  # an ended session keeps its end


# -- I3: one price ----------------------------------------------------------------------------------------------------


def test_one_price_on_the_chart_the_day_list_the_position_and_the_account_at_night(
    db_session, user_id, svc, world, pinned
) -> None:
    thread_id, row, _, flat = _night(db_session, user_id, svc, world)
    clock = pd.Timestamp(NIGHT)
    synced = _sync(db_session, user_id, svc, flat.id)["last"]["price"]
    prices = {
        "advance(sync).last": synced,
        "feed.last": _feed(db_session, user_id, svc, flat.id)["last"]["price"],
        "day list live": _candidate(_live(db_session, user_id, svc, row), "FLAT")["live"]["price"],
        "positions()": session_mod.positions(db_session, svc, row.id, clock)[0].price,
    }
    account = clock_mod.read(db_session, user_id, thread_id, svc)["account"]
    db_session.commit()
    prices["account (entry + open P/L per share)"] = 50.0 + account["open_pnl_usd"] / 10
    assert set(prices.values()) == {52.0}, prices


def test_the_day_list_prices_an_opened_name_like_its_chart_inside_a_minute(
    db_session, user_id, svc, world, pinned
) -> None:
    svc.tape = Tape(svc.sources.__class__(**{**svc.sources.__dict__, "trades": PrintTrades()}), now=lambda: NOW)
    thread_id, row, _, flat = _night(db_session, user_id, svc, world, at=LATE)
    clock = pd.Timestamp(LATE)
    prices = {
        "advance(sync).last": _sync(db_session, user_id, svc, flat.id)["last"]["price"],
        "feed.last": _feed(db_session, user_id, svc, flat.id)["last"]["price"],
        "day list live": _candidate(_live(db_session, user_id, svc, row), "FLAT")["live"]["price"],
        "positions()": session_mod.positions(db_session, svc, row.id, clock)[0].price,
    }
    assert set(prices.values()) == {52.37}, prices


# -- I1 (A3): one instant ---------------------------------------------------------------------------------------------


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
        seen[f"advance {label}"] = frame.get("thread_time")
    listed = _live(db_session, user_id, svc, row)
    seen["day list"] = listed.get("thread_time")
    wrong = {label: value for label, value in seen.items() if value != NIGHT}
    assert not wrong, f"every surface must name T={NIGHT}; these do not: {wrong}"


def test_a_jump_lands_every_surface_on_the_jumped_instant(db_session, user_id, svc, world, pinned) -> None:
    """I1 after the user's own clock action: a Jump to 14:07 moves the clock, the account, the day list's prices and
    each open name's chart to that one instant, none of them ahead of it."""
    make_thread(db_session, user_id)
    row, gapper = _names(db_session, user_id, svc)
    thread_id = db_session.get(PracticePlan, row.plan_id).thread_id
    target = et(DAYS[0], "14:07")
    out = clock_mod.control(
        db_session, user_id, thread_id, svc, running=None, speed=None, to=target.to_pydatetime(), step=None
    )
    db_session.commit()
    listed = _live(db_session, user_id, svc, row)
    frame = _sync(db_session, user_id, svc, gapper.id)
    seen = {
        "clock": out["clock"],
        "account": out["account"]["as_of"],
        "day list": listed["thread_time"],
        "chart": frame["thread_time"],
        "chart playhead": frame["revealed_through"],
        "price": pd.Timestamp(_candidate(listed, "GAPPER")["live"]["at"]),
    }
    assert {label: at for label, at in seen.items() if at != target} == {}, f"every surface must name {target}"


def test_data_through_is_the_tape_end_on_every_name_payload(db_session, user_id, svc, world, pinned) -> None:
    thread_id, _, gapper, flat = _night(db_session, user_id, svc, world)
    for label, session_id in (("GAPPER", gapper.id), ("FLAT (legacy)", flat.id)):
        for source, frame in (
            ("advance", _sync(db_session, user_id, svc, session_id)),
            ("feed", _feed(db_session, user_id, svc, session_id)),
        ):
            assert frame.get("data_through") == TAPE_END, (label, source)
            assert frame["market"]["phase"] == "closed" and frame["market"]["tape_end"] == TAPE_END, (label, source)
            assert frame["market"]["last_bar_at"] == TAPE_END, (label, source)  # the 19:59 bar closes at 20:00
            assert frame["market"]["next_open_at"] == et(DAYS[1], "09:30"), (label, source)
    assert clock_mod.read(db_session, user_id, thread_id, svc)["market"]["phase"] == "closed"


def test_the_market_phase_follows_the_thread_time() -> None:
    cases = {
        "04:00": "premarket",
        "09:29": "premarket",
        "09:30": "regular",
        "15:59": "regular",
        "16:00": "after_hours",
        "19:59": "after_hours",
        "20:00": "closed",
    }
    for hhmm, phase in cases.items():
        assert frames.market_block(DAYS[0], et(DAYS[0], hhmm), None, None)["phase"] == phase, hhmm
    assert frames.market_block(DAYS[0], NIGHT, None, None)["phase"] == "closed"  # the night: no bars, no phase


def test_a_paused_thread_returns_identical_payloads_on_repeated_reads(db_session, user_id, svc, world, pinned) -> None:
    """I5 on the new fields: thread_time, data_through and market do not move between two reads at one instant."""
    thread_id, row, gapper, _ = _night(db_session, user_id, svc, world)
    first = (_sync(db_session, user_id, svc, gapper.id), _feed(db_session, user_id, svc, gapper.id))
    second = (_sync(db_session, user_id, svc, gapper.id), _feed(db_session, user_id, svc, gapper.id))
    for one, two in zip(first, second, strict=True):
        assert (one["thread_time"], one["data_through"], one["market"]) == (
            two["thread_time"],
            two["data_through"],
            two["market"],
        )
    assert clock_mod.read(db_session, user_id, thread_id, svc) == clock_mod.read(db_session, user_id, thread_id, svc)
    assert _live(db_session, user_id, svc, row)["market"] == _live(db_session, user_id, svc, row)["market"]


# -- RC3 (A4): a feed is cut at the thread's time ---------------------------------------------------------------------


def test_a_name_that_was_not_synced_shows_the_tape_through_its_end(db_session, user_id, svc, world, pinned) -> None:
    """RC3: the feed cut at the name's stored playhead (09:30, nobody synced it), not at the thread's time."""
    _, _, gapper, flat = _night(db_session, user_id, svc, world)
    for label, session_id in (("GAPPER", gapper.id), ("FLAT (legacy)", flat.id)):
        stored = _row(db_session, session_id).revealed_through
        out = _feed(db_session, user_id, svc, session_id)
        db_session.commit()
        assert out["revealed_through"] == TAPE_END, (label, out["revealed_through"])
        assert out["bars"][-1]["t"] + pd.Timedelta(minutes=5) == TAPE_END, label
        assert _row(db_session, session_id).revealed_through == stored, "a GET never writes the playhead"
    flat_out = _feed(db_session, user_id, svc, flat.id)
    assert flat_out["last"]["price"] == 52.0 and flat_out["behind_clock"] is True  # still not markable until a sync


def test_a_stale_name_is_read_at_the_thread_time_never_past_it_and_still_cannot_be_marked(
    db_session, user_id, svc, world, pinned
) -> None:
    """A4 acceptance: the playhead is 09:30, the clock 14:00. The feed returns bars through 14:00 and nothing later
    (every bar after T is bent to 999), the stored playhead is untouched by the GET, and a mark waits for an advance."""
    _bend(world, "FLAT", "14:00", None, open=999.0, high=999.0, low=999.0, close=999.0)
    make_thread(db_session, user_id)
    row, _ = _names(db_session, user_id, svc, "FLAT")
    flat = plan_mod.start_session(db_session, user_id, row.id, "FLAT", svc)
    thread_id = db_session.get(PracticePlan, row.plan_id).thread_id
    at = et(DAYS[0], "14:00")
    clock_mod.control(db_session, user_id, thread_id, svc, running=None, speed=None, to=at.to_pydatetime(), step=None)
    db_session.commit()

    out = _feed(db_session, user_id, svc, flat.id)
    assert out["revealed_through"] == at and out["data_through"] == at and out["thread_time"] == at
    assert out["bars"][-1]["t"] + pd.Timedelta(minutes=5) == at
    assert max(bar["h"] for bar in out["bars"]) < 999.0 and out["forming"] is None
    assert out["last"]["price"] == 50.0 and out["levels"]["session_high"] == 50.0
    assert _row(db_session, flat.id).revealed_through == et(DAYS[0], "09:30")  # a GET moves nothing
    with pytest.raises(ReplayProblem) as caught:
        _mark(db_session, user_id, svc, flat.id, "long_entry", shares=1)
    assert caught.value.message == "This name is behind the day clock · catch up before you mark"
    _sync(db_session, user_id, svc, flat.id)
    assert _mark(db_session, user_id, svc, flat.id, "long_entry", shares=1)["mark"]["at"] == at


def test_the_indicator_block_is_cut_from_the_same_payload_as_the_price_and_the_candle(
    db_session, user_id, svc, world, pinned
) -> None:
    """I4: bars, forming candle, price and indicators of one name come from one cut. The forming candle closes at the
    header price and its indicator row is the last one; the closed rows are the indicators of the bars it carries."""
    svc.tape = Tape(svc.sources.__class__(**{**svc.sources.__dict__, "trades": PrintTrades()}), now=lambda: NOW)
    _, _, _, flat = _night(db_session, user_id, svc, world, at=LATE)
    out = _sync(db_session, user_id, svc, flat.id)
    feed = _feed(db_session, user_id, svc, flat.id)
    for frame in (out, feed):
        assert frame["last"]["price"] == 52.37 and frame["forming"]["c"] == 52.37
        assert frame["forming"]["h"] >= 52.37
        block = frame["indicators"]
        assert block["interval"] == "5m" and block["as_of_bar"] == frame["forming"]["t"]
        assert block["rows"][-1]["t"] == frame["forming"]["t"]  # the forming candle's own row, last
        assert [r["t"] for r in block["rows"][:-1]] == [b["t"] for b in frame["bars"]]
    assert feed["indicators"]["rows"][-1]["ema9"] is not None and feed["indicators"]["rows"][-1]["rsi14"] is not None


# -- what stays true (guards, green before and after) ------------------------------------------------------------------


def test_the_day_list_prices_every_name_overnight(db_session, user_id, svc, world, pinned) -> None:
    """The live block is not null past 20:00: the "no data" of the report is not a logic defect (see the header)."""
    _, row, _, _ = _night(db_session, user_id, svc, world)
    listed = _live(db_session, user_id, svc, row)
    for candidate in listed["candidates"]:
        live = candidate["live"]
        assert live is not None and live["price"] is not None, candidate["symbol"]
        assert pd.Timestamp(live["at"]) == NIGHT


def test_a_warm_live_read_decodes_no_minute_blobs(db_session, user_id, svc, world, pinned) -> None:
    """The "no data" cost (header): a live read decoded 15 minute blobs per name on dev. Prepared series are read from
    memory now, so a second read of the same list decodes none and asks the provider for nothing."""
    _, row, _, _ = _night(db_session, user_id, svc, world)
    _live(db_session, user_id, svc, row)
    store = svc.store_factory(db_session)
    reads: list[str] = []
    real = store.get

    def counting(key):
        reads.append(key.kind)
        return real(key)

    store.get = counting  # type: ignore[method-assign]
    fetches = svc.history.fetches
    _live(db_session, user_id, svc, row)
    assert reads.count("bars1m") == 0 and svc.history.fetches == fetches, reads


def test_a_read_moves_nothing(db_session, user_id, svc, world, pinned) -> None:
    """I5: the same T gives the same output, and a feed does not write a name's playhead."""
    _, row, gapper, _ = _night(db_session, user_id, svc, world)
    before = _row(db_session, gapper.id).revealed_through
    first, second = _feed(db_session, user_id, svc, gapper.id), _feed(db_session, user_id, svc, gapper.id)
    assert first == second
    assert _row(db_session, gapper.id).revealed_through == before
    assert _live(db_session, user_id, svc, row) == _live(db_session, user_id, svc, row)
