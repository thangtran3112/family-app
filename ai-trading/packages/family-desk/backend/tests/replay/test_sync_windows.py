"""Two windows on one followed chart (D-198, ADR-0018 "Sync: poll, not push"). A day-thread chart asks the server every
2 s to bring its session up to the thread clock (`advance` with `sync`). The session has one playhead, so the answer
used to carry only the bars the *playhead* moved over: the window that polled first took each bar and the other
window never saw it. The answer now starts at the playhead the window itself holds (`since`), so every window ends
with every closed bar through the thread clock, whoever else has the session open.
Real Postgres; the synthetic world of `tests/daily_world.py` (a paused clock stepped bar by bar)."""

import pandas as pd
import pytest
from daily_world import DAYS
from test_thread_clock import _control, _started

from ai_trading.core.calendar import et
from ai_trading.replay import session as session_mod
from ai_trading.replay.session import ReplayProblem


@pytest.fixture(autouse=True)
def _paused(svc) -> None:
    """The wall clock pinned: the paused thread clock moves only when the test steps it."""
    wall = svc.now()
    svc.wall = lambda: wall


class Window:
    """One open tab of the chart: the bars it holds (keyed by start time, as the browser merges them) and the
    playhead it last read, which it sends back as `since`."""

    def __init__(self, db_session, user_id, svc, session_id) -> None:
        self.db, self.user_id, self.svc, self.session_id = db_session, user_id, svc, session_id
        feed = session_mod.feed(db_session, user_id, session_id, svc, interval=None)
        self.bars = [bar["t"] for bar in feed["bars"]]
        self.cursor = feed["revealed_through"]
        self.sent = 0  # bars received over the window's life, duplicates included

    def poll(self, *, since=True, max_prints: int = 50) -> dict:
        frame = session_mod.advance(
            self.db,
            self.user_id,
            self.session_id,
            self.svc,
            to=None,
            step=None,
            sync=True,
            since=self.cursor if since else None,
            interval=None,
            min_size=0,
            min_notional=0,
            max_prints=max_prints,
        )
        self.db.commit()
        self.sent += len(frame["bars"])
        self.bars = sorted({*self.bars, *(bar["t"] for bar in frame["bars"])})
        self.cursor = max(self.cursor, frame["revealed_through"])
        return frame


def _truth(db_session, user_id, svc, session_id) -> list:
    """Every closed bar through the thread clock, the way a fresh load reads them."""
    out = session_mod.feed(db_session, user_id, session_id, svc, interval=None)
    db_session.commit()
    return sorted(bar["t"] for bar in out["bars"])


def _step(db_session, user_id, svc, thread_id) -> None:
    _control(db_session, user_id, svc, thread_id, step="bar")
    db_session.commit()


def test_every_window_ends_with_every_closed_bar_whoever_polls_first(db_session, user_id, svc, world) -> None:
    thread_id, _row, gapper = _started(db_session, user_id, svc)
    a = Window(db_session, user_id, svc, gapper.id)
    b = Window(db_session, user_id, svc, gapper.id)
    for turn in range(6):
        _step(db_session, user_id, svc, thread_id)
        first, second = (a, b) if turn % 2 == 0 else (b, a)  # whichever tab polls first takes the playhead along
        first.poll()
        second.poll()
        truth = _truth(db_session, user_id, svc, gapper.id)
        assert a.bars == truth, f"window A after step {turn + 1}"
        assert b.bars == truth, f"window B after step {turn + 1}"
    assert truth[-1] > pd.Timestamp(et(DAYS[0], "09:30"))  # the clock really moved


def test_a_window_left_alone_for_several_bars_catches_up_in_one_poll(db_session, user_id, svc, world) -> None:
    thread_id, _row, gapper = _started(db_session, user_id, svc)
    busy = Window(db_session, user_id, svc, gapper.id)
    idle = Window(db_session, user_id, svc, gapper.id)  # a tab left open beside the one in use
    for _ in range(5):
        _step(db_session, user_id, svc, thread_id)
        busy.poll()
    missing = len(set(busy.bars) - set(idle.bars))
    assert missing == 5  # it has not polled: it lags by every step
    frame = idle.poll()
    assert len(frame["bars"]) == missing  # exactly what it lacked, once
    assert idle.bars == busy.bars == _truth(db_session, user_id, svc, gapper.id)


def test_one_window_polling_alone_is_unchanged(db_session, user_id, svc, world) -> None:
    """No duplicate bars, nothing resent while the clock stands still, and the answer stays one step wide."""
    thread_id, _row, gapper = _started(db_session, user_id, svc)
    window = Window(db_session, user_id, svc, gapper.id)
    steps = 5
    for _ in range(steps):
        _step(db_session, user_id, svc, thread_id)
        for _poll in range(3):  # the 2 s poll answers again and again between two clock moves
            before = window.sent
            frame = window.poll()
            assert len(frame["bars"]) <= 1, "an answer carries the bars of one clock move, not the history"
            assert len(frame["prints"]["rows"]) <= 50 and frame["prints"]["shown"] <= 50
            if _poll > 0:
                assert window.sent == before, "a poll with nothing new carries no bars"
    assert window.sent == steps  # every bar once
    assert len(window.bars) == len(set(window.bars))
    assert window.bars == _truth(db_session, user_id, svc, gapper.id)


def test_the_answer_without_a_cursor_is_what_it_was(db_session, user_id, svc, world) -> None:
    """A client that sends no `since` (an older build) gets the playhead's delta, exactly as before."""
    thread_id, _row, gapper = _started(db_session, user_id, svc)
    window = Window(db_session, user_id, svc, gapper.id)
    _step(db_session, user_id, svc, thread_id)
    other = Window(db_session, user_id, svc, gapper.id)
    other.poll()  # takes the playhead along
    assert window.poll(since=False)["bars"] == []


def test_a_cursor_from_before_the_window_never_reaches_into_the_lookback(db_session, user_id, svc, world) -> None:
    """`since` is clamped to where the session's window starts: a far-back value costs the window, not the history."""
    thread_id, _row, gapper = _started(db_session, user_id, svc)
    for _ in range(3):
        _step(db_session, user_id, svc, thread_id)
    window = Window(db_session, user_id, svc, gapper.id)
    window.cursor = pd.Timestamp(et(DAYS[0], "04:00")) - pd.Timedelta(days=30)
    start = session_mod.feed(db_session, user_id, gapper.id, svc, interval=None)["window_start"]
    frame = window.poll()
    assert frame["bars"] and all(pd.Timestamp(bar["t"]) >= pd.Timestamp(start) for bar in frame["bars"])


def test_a_cursor_needs_the_sync(db_session, user_id, svc, world) -> None:
    _thread_id, _row, gapper = _started(db_session, user_id, svc)
    with pytest.raises(ReplayProblem) as problem:
        session_mod.advance(
            db_session,
            user_id,
            gapper.id,
            svc,
            to=None,
            step="bar",
            sync=False,
            since=et(DAYS[0], "09:30").to_pydatetime(),
            interval=None,
            min_size=0,
            min_notional=0,
            max_prints=50,
        )
    assert problem.value.path == "since"
