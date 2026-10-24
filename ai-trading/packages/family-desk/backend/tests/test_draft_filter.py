"""The `draft_filter` tool: proposals, diffs against a base version, engine problems, and the
`StrategyDraft` exchange (`to_strategy_draft`, `finalize_filter_draft`)."""

import copy
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from pydantic import BaseModel

from ai_trading.contracts.json_pointer import Edit, apply_edits, json_equal
from ai_trading.contracts.strategy_draft import StrategyDraft
from ai_trading.contracts.strategy_spec_v1 import FilterStrategySpecV1
from ai_trading.core.draft import diff_edits, draft_filter, finalize_filter_draft, to_strategy_draft

CONTRACTS = Path(__file__).resolve().parents[2] / "contracts"
DEFAULT_SPECS: dict[str, dict[str, Any]] = {
    path.stem: json.loads(path.read_text()) for path in sorted((CONTRACTS / "templates" / "filters").glob("*.json"))
}
INVALID_FILTERS = sorted((CONTRACTS / "fixtures" / "filter-strategy-spec-v1" / "invalid").glob("*.json"))
DRAFT_VALID = CONTRACTS / "fixtures" / "strategy-draft" / "valid"
VWAP_DAILY_PROBLEM = "vwap needs intraday bars; daily_close uses daily bars"
PATTERN_WEEKLY_PROBLEM = (
    "the pattern condition is not supported by the engine yet: weekly runs on daily bars, not weekly candles"
)


def _dump(model: BaseModel) -> dict[str, Any]:
    return model.model_dump(mode="json", by_alias=True, exclude_none=True)


def _spec(data: dict[str, Any]) -> dict[str, Any]:
    """The canonical dump of a filter spec dict, as `draft_filter` stores it."""
    return _dump(FilterStrategySpecV1.model_validate(data))


def _mutated(name: str, change: Callable[[dict[str, Any]], Any]) -> dict[str, Any]:
    """A copy of the screener default `name` with `change` applied to the copy."""
    data = copy.deepcopy(DEFAULT_SPECS[name])
    change(data)
    return data


def _pattern_proposal(run_on: str) -> dict[str, Any]:
    def change(data: dict[str, Any]) -> None:
        data["watch"]["runOn"] = run_on
        data["when"] = {"op": "pattern", "pattern": "hammer"}

    return _mutated("above-vwap-on-volume", change)


def _proposed(fixture_name: str) -> StrategyDraft:
    """The `proposed` draft a fixture's draftConfig would be, with the fixture's edits and final config dropped."""
    fixture = json.loads((DRAFT_VALID / fixture_name).read_text())
    kept = {key: value for key, value in fixture.items() if key not in ("status", "edits", "finalConfig")}
    return StrategyDraft.model_validate({**kept, "status": "proposed", "edits": []})


def _edits(fixture_name: str) -> list[Edit]:
    return [Edit.model_validate(edit) for edit in json.loads((DRAFT_VALID / fixture_name).read_text())["edits"]]


def test_there_are_ten_screener_defaults():
    assert len(DEFAULT_SPECS) == 10


@pytest.mark.parametrize("name", list(DEFAULT_SPECS))
def test_default_as_proposal_is_accepted_unchanged(name: str):
    response = draft_filter(DEFAULT_SPECS[name])
    assert response.problems == [], name
    assert json_equal(response.spec, DEFAULT_SPECS[name]), name
    assert response.diff == [], name


def test_every_ordered_pair_of_defaults_round_trips():
    """Base A, proposal B, for all 100 ordered pairs: replaying the diff on A gives B's spec; A == B gives no diff."""
    for base_name, base in DEFAULT_SPECS.items():
        for proposal_name, proposal in DEFAULT_SPECS.items():
            pair = f"{base_name} -> {proposal_name}"
            response = draft_filter(proposal, base=base)
            assert response.spec is not None and response.problems == [], pair
            assert json_equal(apply_edits(_spec(base), response.diff), response.spec), pair
            if base_name == proposal_name:
                assert response.diff == [], pair


TARGETED_EDITS: dict[str, tuple[str, Callable[[dict[str, Any]], Any], list[dict[str, Any]]]] = {
    "threshold": (
        "abnormal-volume",
        lambda d: d["when"]["right"].update(value=3),
        [{"op": "replace", "path": "/when/right/value", "value": 3}],
    ),
    "optional-added": (
        "overbought-rsi",
        lambda d: d["liquidity"].update(avgVolumeDays=20),
        [{"op": "add", "path": "/liquidity/avgVolumeDays", "value": 20}],
    ),
    "optional-removed": (
        "52-week-breakout",
        lambda d: d["liquidity"].pop("minPrice"),
        [{"op": "remove", "path": "/liquidity/minPrice"}],
    ),
    "array-shorter": (
        "above-vwap-on-volume",
        lambda d: d["when"]["all"].pop(),
        [
            {
                "op": "replace",
                "path": "/when/all",
                "value": [{"op": "gt", "left": {"series": "close"}, "right": {"series": "vwap"}}],
            }
        ],
    ),
    "nested-rank": (
        "overbought-rsi",
        lambda d: (d["rank"]["by"].update(length=21), d["rank"].update(order="asc")),
        [
            {"op": "replace", "path": "/rank/by/length", "value": 21},
            {"op": "replace", "path": "/rank/order", "value": "asc"},
        ],
    ),
    "run-on": (
        "abnormal-volume",
        lambda d: d["watch"].update(runOn="bar_close_5m"),
        [{"op": "replace", "path": "/watch/runOn", "value": "bar_close_5m"}],
    ),
}


@pytest.mark.parametrize(("base_name", "change", "expected"), list(TARGETED_EDITS.values()), ids=list(TARGETED_EDITS))
def test_targeted_change_diffs_to_exact_ops(base_name: str, change, expected: list[dict[str, Any]]):
    base = DEFAULT_SPECS[base_name]
    response = draft_filter(_mutated(base_name, change), base=base)
    assert response.problems == []
    assert [edit.model_dump(exclude_unset=True) for edit in response.diff] == expected
    assert json_equal(apply_edits(_spec(base), response.diff), response.spec)


INVALID_PROPOSALS: dict[str, Callable[[dict[str, Any]], Any]] = {
    "missing-maxResults": lambda d: d.pop("maxResults"),
    "unknown-top-level-key": lambda d: d.update(bogus=1),
    "wrong-enum": lambda d: d["watch"].update(runOn="bar_close_3m"),
    "boolean-for-number": lambda d: d["when"]["right"].update(value=True),
    "null-value": lambda d: d["liquidity"].update(minPrice=None),
    "maxResults-zero": lambda d: d.update(maxResults=0),
    "unknown-when-op": lambda d: d["when"].update(op="between"),
}


@pytest.mark.parametrize("mutate", list(INVALID_PROPOSALS.values()), ids=list(INVALID_PROPOSALS))
def test_schema_invalid_proposal_has_no_spec(mutate: Callable[[dict[str, Any]], Any]):
    response = draft_filter(_mutated("abnormal-volume", mutate), base=DEFAULT_SPECS["abnormal-volume"])
    assert response.spec is None
    assert response.problems
    assert response.diff == []


def test_schema_errors_name_the_field():
    response = draft_filter(_mutated("abnormal-volume", lambda d: (d.pop("maxResults"), d.update(bogus=1))))
    assert "maxResults: Field required" in response.problems
    assert "bogus: Extra inputs are not permitted" in response.problems


def test_non_dict_proposal_has_no_spec():
    response = draft_filter([DEFAULT_SPECS["abnormal-volume"]])
    assert response.spec is None
    assert response.problems


def test_every_invalid_filter_fixture_is_rejected_without_raising():
    for path in INVALID_FILTERS:
        response = draft_filter(json.loads(path.read_text()))
        assert response.spec is None and response.problems, path.name


def test_engine_problem_keeps_the_spec_for_a_vwap_condition_at_daily_close():
    response = draft_filter(_mutated("above-vwap-on-volume", lambda d: d["watch"].update(runOn="daily_close")))
    assert response.spec is not None
    assert response.problems == [VWAP_DAILY_PROBLEM]


def test_engine_problem_keeps_the_spec_for_a_vwap_rank_at_daily_close():
    response = draft_filter(_mutated("overbought-rsi", lambda d: d["rank"].update(by={"series": "vwap"})))
    assert response.spec is not None
    assert response.problems == [VWAP_DAILY_PROBLEM]


def test_pattern_condition_is_fine_on_a_15_minute_bar_close():
    response = draft_filter(_pattern_proposal("bar_close_15m"))
    assert response.problems == []
    assert response.spec is not None and response.spec["when"] == {"op": "pattern", "pattern": "hammer"}


def test_pattern_condition_at_weekly_reports_the_engine_problem():
    response = draft_filter(_pattern_proposal("weekly"))
    assert response.spec is not None
    assert response.problems == [PATTERN_WEEKLY_PROBLEM]


@pytest.mark.parametrize(("name", "version"), [("overbought-rsi", 7), ("overbought-rsi", None)])
def test_based_on_version_id_is_echoed(name: str, version: int | None):
    assert draft_filter(DEFAULT_SPECS[name], based_on_version_id=version).basedOnVersionId == version


def test_based_on_version_id_is_echoed_on_a_schema_invalid_proposal():
    assert draft_filter({}, based_on_version_id=3).basedOnVersionId == 3


def test_to_strategy_draft_wraps_a_valid_response_as_proposed():
    response = draft_filter(DEFAULT_SPECS["gap-up"])
    draft = to_strategy_draft(
        response,
        draft_id="demo-1",
        created_at="2026-10-24T14:30:00Z",
        request="Gap ups of 3% or more on at least 1.5x volume.",
        rationale="Pre-market gaps with volume are the setup.",
    )
    assert draft.status == "proposed"
    assert draft.target == "filter"
    assert draft.edits == []
    assert draft.finalConfig is None
    assert json_equal(_dump(draft.draftConfig), response.spec)


def test_to_strategy_draft_refuses_a_schema_invalid_response():
    with pytest.raises(ValueError, match="schema-valid"):
        to_strategy_draft(
            draft_filter({"name": "x"}),
            draft_id="demo-1",
            created_at="2026-10-24T14:30:00Z",
            request="q",
            rationale="r",
        )


@pytest.mark.parametrize("name", ["final-filter-edits.json", "final-filter-add-remove.json"])
def test_finalize_reproduces_the_fixture_final_config(name: str):
    fixture = json.loads((DRAFT_VALID / name).read_text())
    final = finalize_filter_draft(_proposed(name), _edits(name))
    assert final.status == "final"
    assert json_equal(_dump(final.finalConfig), fixture["finalConfig"])
    assert [edit.model_dump(mode="json", exclude_unset=True) for edit in final.edits] == fixture["edits"]


def test_finalize_applies_a_threshold_edit():
    name = "edited-filter-threshold.json"
    expected = copy.deepcopy(json.loads((DRAFT_VALID / name).read_text())["draftConfig"])
    expected["when"]["right"]["value"] = 2.5
    final = finalize_filter_draft(_proposed(name), _edits(name))
    assert final.status == "final"
    assert json_equal(_dump(final.finalConfig), expected)


def test_finalize_rejects_an_edit_that_does_not_apply():
    with pytest.raises(ValueError, match="/no/such/key"):
        finalize_filter_draft(_proposed("final-filter-edits.json"), [Edit(op="replace", path="/no/such/key", value=1)])


def test_finalize_rejects_an_edit_that_makes_a_schema_invalid_spec():
    with pytest.raises(ValueError, match="maxResults"):
        finalize_filter_draft(_proposed("final-filter-edits.json"), [Edit(op="replace", path="/maxResults", value=0)])


def test_finalize_rejects_an_edit_that_makes_an_engine_unrunnable_spec():
    edits = [
        Edit(op="replace", path="/watch/runOn", value="daily_close"),
        Edit(op="replace", path="/when/left", value={"series": "vwap"}),
    ]
    with pytest.raises(ValueError, match="vwap"):
        finalize_filter_draft(_proposed("final-filter-edits.json"), edits)


def test_finalize_refuses_an_alert_draft():
    alert = StrategyDraft.model_validate_json((DRAFT_VALID / "proposed-alert.json").read_text())
    with pytest.raises(ValueError, match="only a filter draft"):
        finalize_filter_draft(alert, [])


@pytest.mark.parametrize(
    ("old", "new", "expected"),
    [
        ({"a": 1, "b": {"c": [1, 2]}}, {"a": 1, "b": {"c": [1, 2]}}, []),
        ({"a": 1, "b": 2}, {"b": 2, "a": 1}, []),
        ({"a": {"b": [1, {"c": 1}]}}, {"a": {"b": [1, {"c": 2}]}}, [("replace", "/a/b/1/c", 2)]),
        ({"a": [1, 2]}, {"a": [1, 2, 3]}, [("replace", "/a", [1, 2, 3])]),
        ({"a": {"b": 1}}, {"a": [1]}, [("replace", "/a", [1])]),
        ({"a": 1}, {"b": 2}, [("remove", "/a", None), ("add", "/b", 2)]),
    ],
)
def test_diff_edits_ops(old: Any, new: Any, expected: list[tuple[str, str, Any]]):
    ops = [edit.model_dump(exclude_unset=True) for edit in diff_edits(old, new)]
    assert ops == [
        {"op": op, "path": path, **({} if op == "remove" else {"value": value})} for op, path, value in expected
    ]


def test_diff_edits_escapes_slash_and_tilde_in_keys():
    old = {"a/b": 1, "m~n": 1, "x~1/y": 1}
    new = {"a/b": 2, "m~n": 2, "x~1/y": 2}
    edits = diff_edits(old, new)
    assert [edit.path for edit in edits] == ["/a~1b", "/m~0n", "/x~01~1y"]
    assert apply_edits(old, edits) == new


def test_diff_edits_of_equal_inputs_is_empty():
    spec = DEFAULT_SPECS["above-vwap-on-volume"]
    assert diff_edits(spec, copy.deepcopy(spec)) == []
