"""Regressions found in review of the 02k engine work: windows, bar-close times, and draft edge cases."""

import json
from datetime import date
from pathlib import Path

import pandas as pd
import pytest
from bars import minute_bars, trading_days

from ai_trading.contracts.json_pointer import Edit, apply_edits, json_equal
from ai_trading.contracts.strategy_spec_v1 import StrategySpecV1
from ai_trading.core import patterns
from ai_trading.core.calendar import et
from ai_trading.core.draft import diff_edits, draft_filter, finalize_filter_draft, to_strategy_draft
from ai_trading.core.evaluate import evaluate

DAY = date(2026, 10, 6)
FILTERS = Path(__file__).resolve().parents[2] / "contracts" / "templates" / "filters"


def _spec(when: dict, run_on: str, alert: dict | None = None) -> StrategySpecV1:
    return StrategySpecV1.model_validate(
        {
            "schemaVersion": 1,
            "name": "Test",
            "watch": {"universe": {"symbols": ["TEST"]}, "session": "regular", "runOn": run_on},
            "when": when,
            "then": {"alert": {"channels": ["inbox"], **(alert or {})}},
        }
    )


def _candidates(spec: StrategySpecV1, bars: pd.DataFrame):
    daily = pd.DataFrame({"open": [], "high": [], "low": [], "close": [], "volume": []}, dtype=float)
    return evaluate(spec, "TEST", "stock", bars_1m=bars, bars_1d=daily, as_of=et(DAY, "20:00"))


def test_a_pattern_window_never_carries_into_the_next_trading_day():
    first, second = trading_days("stock", DAY, 2)
    bars = pd.concat([minute_bars("stock", first), minute_bars("stock", second)])
    bars.loc[et(first, "15:59"), ["open", "high", "low", "close"]] = [99.8, 100.0, 99.0, 100.0]  # a hammer
    for within in (1, 3):
        spec = _spec({"op": "pattern", "pattern": "hammer", "withinBars": within}, "bar_close_1m")
        found = [c.bar_time for c in _candidates(spec, bars)]
        assert found == [et(first, "15:59")], within


def test_the_detect_window_stays_inside_its_group_and_a_group_start_is_decided_by_its_own_rows():
    candles = pd.DataFrame(
        {
            "open": [1.0, 1.0, 99.8, 1.0, 1.0],
            "high": [1.1, 1.1, 100.0, 1.1, 1.1],
            "low": [0.9, 0.9, 99.0, 0.9, 0.9],
            "close": [1.05, 1.05, 100.0, 1.05, 1.05],
        },
        index=pd.date_range("2026-10-06 14:30", periods=5, freq="15min", tz="UTC"),
    )  # row 2 is a hammer
    days = [0, 0, 0, 1, 1]
    loose = patterns.detect(candles, "hammer", within_bars=3).truth.tolist()
    grouped = patterns.detect(candles, "hammer", within_bars=3, groups=days).truth.tolist()
    assert loose[2:] == [True, True, True]
    assert grouped[2:] == [True, False, False]


@pytest.mark.parametrize(("run_on", "first", "last"), [("bar_close_1h", "10:30 AM", "4:00 PM")])
def test_time_in_a_message_is_the_real_close_of_a_capped_last_bin(run_on, first, last):
    spec = _spec(
        {"op": "gt", "left": {"series": "close"}, "right": {"value": 50}},
        run_on,
        {"frequency": "once_per_bar", "message": "{time}"},
    )
    messages = [c.message for c in _candidates(spec, minute_bars("stock", DAY))]
    assert messages[0] == first
    assert messages[-1] == last  # the 15:30 bin ends with the session, not at 16:30


def _filter(name: str) -> dict:
    return json.loads((FILTERS / f"{name}.json").read_text())


def _nest(depth: int, leaf: float) -> dict:
    when: dict = {"op": "gt", "left": {"series": "close"}, "right": {"value": leaf}}
    for _ in range(depth):
        when = {"not": when}
    return when


def test_draft_filter_survives_a_change_buried_in_a_deeply_nested_condition():
    base = {**_filter("gap-up"), "when": _nest(60, 1)}
    proposal = {**base, "when": _nest(60, 2)}
    response = draft_filter(proposal, base=base)
    assert response.problems == []
    assert all(len(edit.path) <= 200 for edit in response.diff)
    assert json_equal(apply_edits(response.spec and base, response.diff), response.spec)


def test_diff_edits_replaces_a_subtree_once_its_pointer_is_long():
    old, new = _nest(60, 1), _nest(60, 2)
    edits = diff_edits(old, new)
    assert len(edits) == 1 and edits[0].op == "replace"
    assert json_equal(apply_edits(old, edits), new)


@pytest.mark.parametrize("status", ["rejected", "final"])
def test_a_rejected_or_final_draft_cannot_be_finalized(status):
    response = draft_filter(_filter("gap-up"))
    proposed = to_strategy_draft(
        response, draft_id="demo-1", created_at="2026-10-24T14:30:00Z", request="gap ups", rationale="why"
    )
    final = finalize_filter_draft(proposed, [Edit(op="replace", path="/maxResults", value=10)])
    assert final.status == "final"
    with pytest.raises(ValueError, match="cannot be finalized"):
        finalize_filter_draft(final, [])
    rejected = proposed.model_copy(update={"status": status})
    with pytest.raises(ValueError, match="cannot be finalized"):
        finalize_filter_draft(rejected, [])
