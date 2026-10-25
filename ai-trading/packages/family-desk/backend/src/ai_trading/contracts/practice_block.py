"""PracticeBlockV1 (mirror of contracts/src/practice-block-v1.ts): the daily-list practice plan (02o-b v1).

The risk plan and the entry size are not part of it (02r, D-007): they belong to the practice thread
(`contracts/practice_thread.py`), and `replay/plan.py` drops `setup.plan` and `setup.shares` from an old client's block
before it is validated here.

The shape is generated (strategy_spec_v1.py); the window and list-time rules live in Zod `superRefine`, which JSON
Schema cannot carry, so they are hand-written here on top of it. The rules that need a database (the filters are
hers and runnable, `listAt` of 08:30 or later for a premarket filter, every day finished, `firstDay` from
2017-01-03) are server rules in `replay/plan.py`.
"""

from typing import NamedTuple

from pydantic import model_validator

from ai_trading.contracts.strategy_spec_v1 import PracticeBlockV1 as _GeneratedPracticeBlockV1

__all__ = ["PRACTICE_BLOCK_RULES", "PracticeBlockV1"]


class _Rule(NamedTuple):
    id: str
    description: str


PRACTICE_BLOCK_RULES: tuple[_Rule, ...] = (
    _Rule("window-order", "window.from must be before window.to"),
    _Rule("window-in-session", "window must stay inside 04:00-20:00 ET"),
    _Rule("window-in-regular", "a regular-session window must stay inside 09:30-16:00 ET"),
    _Rule("list-time-range", "screen.listAt must be between 04:30 and 15:30 ET"),
    _Rule("window-after-list", "window.from must be at or after screen.listAt"),
)
_TEXT: dict[str, str] = {rule.id: rule.description for rule in PRACTICE_BLOCK_RULES}


class PracticeBlockV1(_GeneratedPracticeBlockV1):
    @model_validator(mode="after")
    def _rules(self) -> "PracticeBlockV1":
        start, end = self.setup.window.from_, self.setup.window.to  # "HH:MM" zero-padded: string order is time order
        list_at = self.screen.listAt
        problems = []
        if start >= end:
            problems.append(_TEXT["window-order"])
        if start < "04:00" or end > "20:00":
            problems.append(_TEXT["window-in-session"])
        elif self.setup.session == "regular" and (start < "09:30" or end > "16:00"):
            problems.append(_TEXT["window-in-regular"])
        if list_at < "04:30" or list_at > "15:30":
            problems.append(_TEXT["list-time-range"])
        if start < list_at:
            problems.append(_TEXT["window-after-list"])
        if problems:
            raise ValueError("; ".join(problems))
        return self
