from datetime import UTC, datetime, timedelta

import pytest

from ai_trading.jobs import (
    JobResult,
    consensus_snapshot,
    daily_close,
    healthcheck,
    premarket,
    refresh_15m,
    relogin_reminder,
    scheduler,
    watchdog,
    weekly,
)
from ai_trading.jobs.clock import JobClock


class _FakeSources:
    bars = object()


def test_due_now_lists_only_jobs_that_are_due(monkeypatch):
    # `scheduler._DUE_NOW` binds each submodule's `due_now` once at import time, so patching it
    # directly (not the submodule's own attribute) is what actually takes effect here.
    due = {
        "premarket_0830": True,
        "daily_close": False,
        "consensus_snapshot": False,
        "weekly": False,
        "relogin_reminder": False,
        "refresh_15m": True,
        "watchdog": False,
    }
    monkeypatch.setattr(scheduler, "_DUE_NOW", {name: (lambda now, v=v: v) for name, v in due.items()})

    assert scheduler.due_now(datetime(2026, 10, 6, 13, 30, tzinfo=UTC)) == ["premarket_0830", "refresh_15m"]


def test_due_now_includes_relogin_reminder_on_sunday_at_1800_et():
    # F2: relogin_reminder was missing from _DUE_NOW entirely, so it never ran.
    assert "relogin_reminder" in scheduler.due_now(datetime(2026, 10, 11, 22, 0, tzinfo=UTC))


def test_run_due_skips_jobs_that_are_not_due(monkeypatch):
    monkeypatch.setattr(scheduler, "_DUE_NOW", dict.fromkeys(scheduler._ORDER, lambda now: False))
    results = scheduler.run_due(object(), _FakeSources(), JobClock(), now=datetime(2026, 10, 6, 13, 30, tzinfo=UTC))
    assert results == []


def test_run_due_runs_jobs_in_order_with_watchdog_last(monkeypatch):
    calls = []
    monkeypatch.setattr(scheduler, "_DUE_NOW", dict.fromkeys(scheduler._ORDER, lambda now: True))
    monkeypatch.setattr(
        premarket, "run", lambda s, c, *, now, data_sources: calls.append("premarket_0830") or JobResult("x", True)
    )
    monkeypatch.setattr(daily_close, "run", lambda s, d, c, *, now: calls.append("daily_close") or JobResult("x", True))
    monkeypatch.setattr(
        consensus_snapshot, "run", lambda s, d, c, *, now: calls.append("consensus_snapshot") or JobResult("x", True)
    )
    monkeypatch.setattr(weekly, "run", lambda s, c, *, now: calls.append("weekly") or JobResult("x", True))
    monkeypatch.setattr(
        relogin_reminder, "run", lambda s, c, *, now: calls.append("relogin_reminder") or JobResult("x", True)
    )
    monkeypatch.setattr(refresh_15m, "run", lambda s, d, *, now: calls.append("refresh_15m") or JobResult("x", True))
    monkeypatch.setattr(watchdog, "run", lambda s, c, *, now: calls.append("watchdog") or [])

    scheduler.run_due(object(), _FakeSources(), JobClock(), now=datetime(2026, 10, 6, 13, 30, tzinfo=UTC))

    assert calls == [
        "premarket_0830",
        "daily_close",
        "consensus_snapshot",
        "weekly",
        "relogin_reminder",
        "refresh_15m",
        "watchdog",
    ]


def test_run_due_a_failing_job_does_not_stop_the_others(monkeypatch):
    monkeypatch.setattr(scheduler, "_DUE_NOW", dict.fromkeys(scheduler._ORDER, lambda now: True))

    def _boom(*args, **kwargs):
        raise ValueError("boom")

    monkeypatch.setattr(premarket, "run", _boom)
    monkeypatch.setattr(daily_close, "run", lambda s, d, c, *, now: JobResult("daily_close", True))
    monkeypatch.setattr(consensus_snapshot, "run", lambda s, d, c, *, now: JobResult("consensus_snapshot", True))
    monkeypatch.setattr(weekly, "run", lambda s, c, *, now: JobResult("weekly", True))
    monkeypatch.setattr(relogin_reminder, "run", lambda s, c, *, now: JobResult("relogin_reminder", True))
    monkeypatch.setattr(refresh_15m, "run", lambda s, d, *, now: JobResult("refresh_15m", True))
    monkeypatch.setattr(watchdog, "run", lambda s, c, *, now: [])

    results = scheduler.run_due(object(), _FakeSources(), JobClock(), now=datetime(2026, 10, 6, 13, 30, tzinfo=UTC))

    by_name = {r.name: r for r in results}
    assert by_name["premarket_0830"].ok is False
    assert "boom" in by_name["premarket_0830"].error
    assert by_name["daily_close"].ok is True
    assert by_name["consensus_snapshot"].ok is True
    assert by_name["weekly"].ok is True
    assert by_name["relogin_reminder"].ok is True
    assert by_name["refresh_15m"].ok is True
    assert by_name["watchdog"].ok is True


def test_run_due_returns_a_job_result_for_each_due_job(monkeypatch):
    monkeypatch.setattr(scheduler, "_DUE_NOW", {**dict.fromkeys(scheduler._ORDER, lambda now: False)})
    monkeypatch.setitem(scheduler._DUE_NOW, "daily_close", lambda now: True)
    monkeypatch.setattr(daily_close, "run", lambda s, d, c, *, now: JobResult("daily_close", True))

    results = scheduler.run_due(object(), _FakeSources(), JobClock(), now=datetime(2026, 10, 6, 20, 0, tzinfo=UTC))

    assert [r.name for r in results] == ["daily_close"]


def test_a_late_wakeup_still_catches_up_premarket_exactly_once_this_call(monkeypatch):
    """The scheduler was "down" through premarket's whole slot; on resuming, calling `run_due`
    once sees `premarket_0830` due and runs it exactly once -- not once per missed minute."""
    calls = []
    monkeypatch.setattr(scheduler, "_DUE_NOW", {**dict.fromkeys(scheduler._ORDER, lambda now: False)})
    monkeypatch.setitem(scheduler._DUE_NOW, "premarket_0830", lambda now: True)
    monkeypatch.setattr(
        premarket, "run", lambda s, c, *, now, data_sources: calls.append(now) or JobResult("premarket_0830", True)
    )

    late_now = datetime(2026, 10, 6, 15, 0, tzinfo=UTC)  # long after the 08:30 ET slot
    results = scheduler.run_due(object(), _FakeSources(), JobClock(), now=late_now)

    assert calls == [late_now]
    assert results == [JobResult("premarket_0830", True)]


# -- F1/F2: a successful slotted job is gated by JobClock, a failed one is retried --------------


def test_run_due_does_not_rerun_a_successful_slotted_job_the_next_minute(monkeypatch):
    monkeypatch.setattr(scheduler, "_DUE_NOW", {**dict.fromkeys(scheduler._ORDER, lambda now: False)})
    monkeypatch.setitem(scheduler._DUE_NOW, "daily_close", lambda now: True)
    calls = []

    def _succeed(s, d, c, *, now):
        calls.append(now)
        c.mark("daily_close", now.date())
        return JobResult("daily_close", True)

    monkeypatch.setattr(daily_close, "run", _succeed)
    clock = JobClock()
    now = datetime(2026, 10, 6, 20, 30, tzinfo=UTC)

    first = scheduler.run_due(object(), _FakeSources(), clock, now=now)
    second = scheduler.run_due(object(), _FakeSources(), clock, now=now + timedelta(minutes=1))

    assert calls == [now]  # daily_close.run was never called the second time
    assert first == [JobResult("daily_close", True)]
    assert second == [JobResult("daily_close", ok=True, ran=False)]


def test_run_due_retries_a_failed_slotted_job_on_the_next_tick(monkeypatch):
    monkeypatch.setattr(scheduler, "_DUE_NOW", {**dict.fromkeys(scheduler._ORDER, lambda now: False)})
    monkeypatch.setitem(scheduler._DUE_NOW, "daily_close", lambda now: True)
    calls = []

    def _boom(*args, **kwargs):
        calls.append(1)
        raise ValueError("boom")

    monkeypatch.setattr(daily_close, "run", _boom)
    clock = JobClock()
    now = datetime(2026, 10, 6, 20, 30, tzinfo=UTC)

    first = scheduler.run_due(object(), _FakeSources(), clock, now=now)
    second = scheduler.run_due(object(), _FakeSources(), clock, now=now + timedelta(minutes=1))

    assert len(calls) == 2  # a failed run never marks the clock, so the next tick retries it
    assert first[0].ok is False
    assert second[0].ok is False


def test_run_due_fires_a_slotted_job_once_per_slot_across_many_ticks(monkeypatch):
    monkeypatch.setattr(scheduler, "_DUE_NOW", {**dict.fromkeys(scheduler._ORDER, lambda now: False)})
    monkeypatch.setitem(scheduler._DUE_NOW, "weekly", lambda now: True)
    calls = []

    def _succeed(s, c, *, now):
        calls.append(now)
        c.mark("weekly", now.date())
        return JobResult("weekly", True)

    monkeypatch.setattr(weekly, "run", _succeed)
    clock = JobClock()
    start = datetime(2026, 10, 6, 11, 0, tzinfo=UTC)

    for minute in range(10):
        scheduler.run_due(object(), _FakeSources(), clock, now=start + timedelta(minutes=minute))

    assert calls == [start]  # fired exactly once across the whole 10-minute window


# -- F4a: bounded startup retry -------------------------------------------------------------------


class _FlakyEngine:
    def __init__(self, fail_times: int) -> None:
        self.fail_times = fail_times
        self.calls = 0

    def connect(self):
        self.calls += 1
        if self.calls <= self.fail_times:
            raise OSError("database not reachable yet")
        return _FakeConnection()


class _FakeConnection:
    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False

    def execute(self, _stmt):
        return None


def test_wait_for_database_returns_once_a_later_attempt_succeeds():
    engine = _FlakyEngine(fail_times=2)
    sleeps = []

    scheduler._wait_for_database(engine, attempts=5, delay=0, sleep=sleeps.append)

    assert engine.calls == 3
    assert sleeps == [0, 0]


def test_wait_for_database_exits_non_zero_after_exhausting_the_retry_limit():
    engine = _FlakyEngine(fail_times=999)
    sleeps = []

    with pytest.raises(SystemExit) as exc_info:
        scheduler._wait_for_database(engine, attempts=3, delay=0, sleep=sleeps.append)

    assert exc_info.value.code == 1
    assert engine.calls == 3
    assert len(sleeps) == 3


def test_wait_for_database_default_retry_limit_is_30_attempts_2s_apart():
    assert scheduler._STARTUP_RETRY_ATTEMPTS == 30
    assert scheduler._STARTUP_RETRY_DELAY_SECONDS == 2.0


# -- F4b/F4c: heartbeat file + the healthcheck module ----------------------------------------------


def test_touch_heartbeat_creates_the_file_and_its_parent_directory(tmp_path):
    path = tmp_path / "sub" / "heartbeat"

    healthcheck.touch(path)

    assert path.exists()


def test_healthcheck_is_healthy_fresh_vs_stale(tmp_path):
    path = tmp_path / "heartbeat"
    healthcheck.touch(path)
    mtime = path.stat().st_mtime

    assert healthcheck.is_healthy(path, now=mtime + 1) is True
    assert healthcheck.is_healthy(path, now=mtime + healthcheck.FRESH_SECONDS + 1) is False


def test_healthcheck_is_healthy_false_when_the_file_does_not_exist(tmp_path):
    assert healthcheck.is_healthy(tmp_path / "missing") is False


def test_healthcheck_main_exit_code_follows_heartbeat_freshness(tmp_path, monkeypatch):
    path = tmp_path / "heartbeat"
    monkeypatch.setenv(healthcheck.HEARTBEAT_PATH_VAR, str(path))

    assert healthcheck.main() == 1  # no heartbeat written yet

    healthcheck.touch(path)
    assert healthcheck.main() == 0


def test_run_due_hands_premarket_the_data_sources_the_refresher_needs(monkeypatch):
    seen = []
    monkeypatch.setattr(scheduler, "_DUE_NOW", {**dict.fromkeys(scheduler._ORDER, lambda now: False)})
    monkeypatch.setitem(scheduler._DUE_NOW, "premarket_0830", lambda now: True)
    monkeypatch.setattr(
        premarket,
        "run",
        lambda s, c, *, now, data_sources: seen.append(data_sources) or JobResult("premarket_0830", True),
    )
    sources = _FakeSources()

    scheduler.run_due(object(), sources, JobClock(), now=datetime(2026, 10, 6, 13, 30, tzinfo=UTC))

    assert seen == [sources]


def test_seed_strip_never_stops_a_tick(monkeypatch):
    class _Savepoint:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    class _Session:
        def begin_nested(self):
            return _Savepoint()

    def boom(session, sources, *, now):
        raise RuntimeError("provider exploded")

    monkeypatch.setattr(scheduler.refresher, "ensure_market_strip", boom)
    assert scheduler.seed_strip(_Session(), _FakeSources(), now=datetime(2026, 10, 24, 15, 0, tzinfo=UTC)) is False

    monkeypatch.setattr(scheduler.refresher, "ensure_market_strip", lambda session, sources, *, now: True)
    assert scheduler.seed_strip(_Session(), _FakeSources(), now=datetime(2026, 10, 24, 15, 0, tzinfo=UTC)) is True


def test_log_result_warns_on_a_failure_and_stays_quiet_otherwise(caplog, monkeypatch):
    monkeypatch.setattr(scheduler.logger, "disabled", False)  # alembic's fileConfig in the DB fixtures disables it
    with caplog.at_level("DEBUG", logger=scheduler.logger.name):
        scheduler._log_result(JobResult("premarket_0830", ok=False, error="boom"))
        scheduler._log_result(JobResult("daily_close", ok=True, ran=False))
    warnings = [r for r in caplog.records if r.levelname == "WARNING"]
    assert [r.getMessage() for r in warnings] == ["job premarket_0830 failed (ok=False ran=True): boom"]
    assert [r.levelname for r in caplog.records] == ["WARNING", "DEBUG"]
