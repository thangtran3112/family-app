import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from ai_trading.contracts.json_pointer import Edit, EditError, apply_edits, json_equal, resolve_pointer

CASES = json.loads(
    (Path(__file__).resolve().parents[2] / "contracts" / "fixtures" / "json-pointer" / "cases.json").read_text()
)


def test_cases_exist():
    assert len(CASES) >= 20


@pytest.mark.parametrize("case", CASES, ids=lambda c: c["name"])
def test_edits_match_the_zod_cases(case):
    edits = [Edit.model_validate(edit) for edit in case["edits"]]
    before = json.loads(json.dumps(case["doc"]))
    if case.get("error"):
        with pytest.raises(EditError):
            apply_edits(case["doc"], edits)
    else:
        assert json_equal(apply_edits(case["doc"], edits), case["result"])
        assert case["doc"] == before, "apply_edits must not mutate its input"


@pytest.mark.parametrize(
    "bad",
    [
        {"op": "replace", "path": "/a"},
        {"op": "remove", "path": "/a", "value": 1},
        {"op": "move", "path": "/a", "value": 1},
        {"op": "add", "path": "a", "value": 1},
        {"op": "add", "path": "", "value": 1},
        {"op": "add", "path": "/a~2", "value": 1},
        {"op": "add", "path": "/a", "value": None},
        {"op": "add", "path": "/a", "value": True},
        {"op": "add", "path": "/a", "value": {"b": [1, None]}},
        {"op": "add", "path": "/a", "value": float("inf")},
        {"op": "add", "path": "/a", "value": {"b": [float("nan")]}},
        {"op": "add", "path": "/a", "value": 1, "extra": 1},
    ],
)
def test_edit_model_rejects_what_zod_rejects(bad):
    with pytest.raises(ValidationError):
        Edit.model_validate(bad)


def test_edit_model_rejects_json_overflow():
    with pytest.raises(ValidationError):
        Edit.model_validate_json('{"op": "add", "path": "/a", "value": {"b": 1e400}}')


def test_resolve_pointer_and_json_equal():
    assert resolve_pointer({"a": [{"b": 1}]}, "/a/0/b") == (True, 1)
    assert resolve_pointer({"a": []}, "/a/0")[0] is False
    assert json_equal({"a": 1, "b": [1, 2]}, {"b": [1, 2], "a": 1})
    assert not json_equal({"a": 1}, {"a": 1, "b": 2})
    assert not json_equal([1], {"0": 1})
