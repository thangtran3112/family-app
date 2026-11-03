"""PracticeSetupV2 (mirror of contracts/src/practice-setup-v2.ts): the setup a freestyle thread starts from (ADR-0025).

It replaces `PracticeBlockV1` (`contracts/practice_block.py`), which stays the live contract until the create route
switches over: a start instant, the Screen's filters and cap, and the chart setup a lane opens with. No block of days,
list time, practice window or hidden dates.

The shape is generated (strategy_spec_v1.py); the two `startAt` rules live in Zod `superRefine`, which JSON Schema
cannot carry, so they are hand-written here on top of it. The rules that need data are server rules: that the ET day
is a trading day, that its session has finished, and that `startAt` is not past the thread horizon.
"""

from datetime import UTC, datetime
from typing import NamedTuple

from pydantic import model_validator

from ai_trading.contracts.strategy_spec_v1 import PracticeSetupV2 as _GeneratedPracticeSetupV2

__all__ = ["PRACTICE_SETUP_RULES", "PracticeSetupV2"]


class _Rule(NamedTuple):
    id: str
    description: str


PRACTICE_SETUP_RULES: tuple[_Rule, ...] = (
    _Rule("start-at-real", "startAt must be a real date and time"),
    _Rule("start-at-floor", "startAt must be on or after 2016-01-04 ET"),
)
_TEXT: dict[str, str] = {rule.id: rule.description for rule in PRACTICE_SETUP_RULES}

# 2016-01-04 00:00 ET. January is EST (UTC-5), so the first ET day starts at 05:00 UTC.
_START_AT_FLOOR = datetime(2016, 1, 4, 5, 0, 0, tzinfo=UTC)


class PracticeSetupV2(_GeneratedPracticeSetupV2):
    @model_validator(mode="after")
    def _rules(self) -> "PracticeSetupV2":
        # The field's pattern has already run: this is "HH:MM:SS" plus "Z" or an offset, so only a date that does not
        # exist ("2026-02-31") fails to parse.
        try:
            start = datetime.fromisoformat(self.startAt)
        except ValueError:
            raise ValueError(_TEXT["start-at-real"]) from None
        if start < _START_AT_FLOOR:
            raise ValueError(_TEXT["start-at-floor"])
        return self
