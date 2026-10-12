from datetime import UTC, datetime, time

from ai_trading.notify.quiet_hours import in_quiet_hours

_START = time(22, 0)
_END = time(7, 0)


def _et(hhmm: str) -> datetime:
    """A UTC instant whose America/New_York wall-clock time is `hhmm`, on a fixed EDT date
    (America/New_York is UTC-4 on 2026-07-15)."""
    hour, minute = (int(part) for part in hhmm.split(":"))
    return datetime(2026, 7, 15, (hour + 4) % 24, minute, tzinfo=UTC)


def test_in_quiet_hours_true_inside_a_non_wrapping_window():
    assert in_quiet_hours(_et("10:30"), start=time(9, 0), end=time(17, 0), severity="info") is True


def test_in_quiet_hours_false_outside_a_non_wrapping_window():
    assert in_quiet_hours(_et("20:00"), start=time(9, 0), end=time(17, 0), severity="info") is False


def test_in_quiet_hours_true_just_after_a_wrapping_window_starts():
    assert in_quiet_hours(_et("23:30"), start=_START, end=_END, severity="info") is True


def test_in_quiet_hours_true_just_before_a_wrapping_window_ends():
    assert in_quiet_hours(_et("06:30"), start=_START, end=_END, severity="info") is True


def test_in_quiet_hours_false_at_the_wrapping_windows_end_boundary():
    assert in_quiet_hours(_et("07:00"), start=_START, end=_END, severity="info") is False


def test_in_quiet_hours_false_at_midday_with_a_wrapping_window():
    assert in_quiet_hours(_et("13:00"), start=_START, end=_END, severity="info") is False


def test_in_quiet_hours_system_severity_always_bypasses():
    assert in_quiet_hours(_et("23:30"), start=_START, end=_END, severity="system") is False


def test_in_quiet_hours_risk_severity_always_bypasses():
    assert in_quiet_hours(_et("02:00"), start=_START, end=_END, severity="risk") is False
