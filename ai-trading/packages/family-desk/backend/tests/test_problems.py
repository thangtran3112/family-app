from pydantic import ValidationError

from ai_trading.api.problems import problems_from_validation_error
from ai_trading.contracts.alert_strategy import AlertStrategySpecV1
from ai_trading.library.catalog import load_template


def _errors(spec: dict) -> list[dict[str, str]]:
    try:
        AlertStrategySpecV1.model_validate(spec)
    except ValidationError as exc:
        return problems_from_validation_error(exc)
    raise AssertionError("spec should be invalid")


def test_channel_rule_reports_the_channels_path_and_a_plain_message() -> None:
    spec = load_template("setups/hod-break.json")
    spec["then"]["alert"]["channels"] = ["telegram", "inbox"]
    assert _errors(spec) == [{"path": "then.alert.channels", "message": "the first alert channel must be inbox"}]


def test_two_channel_rules_become_two_problems_on_the_same_path() -> None:
    spec = load_template("setups/hod-break.json")
    spec["then"]["alert"]["channels"] = ["telegram", "telegram"]
    assert {p["message"] for p in _errors(spec)} == {
        "alert channels must not repeat",
        "the first alert channel must be inbox",
    }


def test_a_bad_operand_reports_only_the_branch_it_belongs_to() -> None:
    spec = load_template("setups/hod-break.json")
    spec["when"] = {"op": "gte", "left": {"series": "rvol", "lookbackDays": 0}, "right": {"value": 1}}
    problems = _errors(spec)
    assert [p["path"] for p in problems] == ["when.left.lookbackDays"]
    assert all(not any(part[:1].isupper() for part in p["path"].split(".")) for p in problems)


def test_problems_are_deduplicated_and_capped() -> None:
    spec = load_template("setups/hod-break.json")
    spec["when"] = {"all": [{"op": "gte", "left": {"series": "nope"}, "right": {"value": 1}}] * 20}
    problems = _errors(spec)
    assert len(problems) <= 10
    assert len({(p["path"], p["message"]) for p in problems}) == len(problems)
