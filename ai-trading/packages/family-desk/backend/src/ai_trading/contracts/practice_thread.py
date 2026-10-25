"""PracticeThreadV1 and its siblings (mirror of contracts/src/practice-thread-v1.ts): the practice thread (02r).

The shapes are generated (strategy_spec_v1.py). `PracticeThreadCreateV1`, `PracticeThreadPatchV1` and
`PracticeLedgerEntryV1` need nothing on top of them; `PracticeThreadV1` carries one cross-field rule that lives in
Zod `superRefine`, which JSON Schema cannot, so it is hand-written here. The rules that need a database (one active
thread per mode, no plan edit once closed, the daily plan binding to an active thread) are server rules in
`replay/threads.py`.
"""

from typing import NamedTuple

from pydantic import model_validator

from ai_trading.contracts.strategy_spec_v1 import (
    PracticeLedgerEntryV1,
    PracticeThreadCreateV1,
    PracticeThreadPatchV1,
    PracticeThreadPlanV1,
    PracticeThreadStatsV1,
)
from ai_trading.contracts.strategy_spec_v1 import PracticeThreadV1 as _GeneratedPracticeThreadV1

__all__ = [
    "DEFAULT_STARTING_BALANCE",
    "PRACTICE_THREAD_RULES",
    "PracticeLedgerEntryV1",
    "PracticeThreadCreateV1",
    "PracticeThreadPatchV1",
    "PracticeThreadPlanV1",
    "PracticeThreadStatsV1",
    "PracticeThreadV1",
]

DEFAULT_STARTING_BALANCE = 50_000


class _Rule(NamedTuple):
    id: str
    description: str


PRACTICE_THREAD_RULES: tuple[_Rule, ...] = (
    _Rule("closed-at-matches-status", "closedAt is present exactly when status is closed"),
)


class PracticeThreadV1(_GeneratedPracticeThreadV1):
    @model_validator(mode="after")
    def _rules(self) -> "PracticeThreadV1":
        if (self.status == "closed") != (self.closedAt is not None):
            raise ValueError(PRACTICE_THREAD_RULES[0].description)
        return self
