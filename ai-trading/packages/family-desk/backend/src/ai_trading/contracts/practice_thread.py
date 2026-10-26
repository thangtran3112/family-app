"""PracticeThreadV1 and its siblings (mirror of contracts/src/practice-thread-v1.ts): the practice thread (02r) and its
swing setup (02p).

The shapes are generated (strategy_spec_v1.py). `PracticeThreadPatchV1` and `PracticeLedgerEntryV1` need nothing on top
of them. `SwingSetupV1` (unique universe symbols), `PracticeThreadCreateV1` and `PracticeThreadV1` (the `swing` block
exactly when the mode is swing, and for the thread `closedAt` exactly when closed) carry cross-field rules that live
in Zod `superRefine`, which JSON Schema cannot, so they are hand-written here; the two thread models re-declare
`swing` so it is the rule-carrying `SwingSetupV1`. The rules that need a database (one active thread per mode, no
plan edit once closed, the daily plan binding to an active thread, the swing days and universe) are server rules in
`replay/threads.py`.
"""

from typing import NamedTuple

from pydantic import model_validator

from ai_trading.contracts.strategy_spec_v1 import (
    PracticeLedgerEntryV1,
    PracticeThreadPatchV1,
    PracticeThreadPlanV1,
    PracticeThreadStatsV1,
    SwingUniverseEntryV1,
)
from ai_trading.contracts.strategy_spec_v1 import PracticeThreadCreateV1 as _GeneratedPracticeThreadCreateV1
from ai_trading.contracts.strategy_spec_v1 import PracticeThreadV1 as _GeneratedPracticeThreadV1
from ai_trading.contracts.strategy_spec_v1 import SwingSetupV1 as _GeneratedSwingSetupV1

__all__ = [
    "DEFAULT_STARTING_BALANCE",
    "PRACTICE_THREAD_RULES",
    "SWING_SETUP_RULES",
    "PracticeLedgerEntryV1",
    "PracticeThreadCreateV1",
    "PracticeThreadPatchV1",
    "PracticeThreadPlanV1",
    "PracticeThreadStatsV1",
    "PracticeThreadV1",
    "SwingSetupV1",
    "SwingUniverseEntryV1",
]

DEFAULT_STARTING_BALANCE = 50_000


class _Rule(NamedTuple):
    id: str
    description: str


PRACTICE_THREAD_RULES: tuple[_Rule, ...] = (
    _Rule("closed-at-matches-status", "closedAt is present exactly when status is closed"),
    _Rule("swing-block-matches-mode", "swing is present exactly when mode is swing"),
)
SWING_SETUP_RULES: tuple[_Rule, ...] = (_Rule("universe-symbols-unique", "universe symbols must be unique"),)


class SwingSetupV1(_GeneratedSwingSetupV1):
    @model_validator(mode="after")
    def _rules(self) -> "SwingSetupV1":
        symbols = [entry.symbol for entry in self.universe]
        if len(set(symbols)) != len(symbols):
            raise ValueError(SWING_SETUP_RULES[0].description)
        return self


def _swing_block_mismatch(thread: "PracticeThreadCreateV1 | PracticeThreadV1") -> bool:
    return (thread.mode == "swing") != (thread.swing is not None)


class PracticeThreadCreateV1(_GeneratedPracticeThreadCreateV1):
    swing: SwingSetupV1 | None = None

    @model_validator(mode="after")
    def _rules(self) -> "PracticeThreadCreateV1":
        if _swing_block_mismatch(self):
            raise ValueError(PRACTICE_THREAD_RULES[1].description)
        return self


class PracticeThreadV1(_GeneratedPracticeThreadV1):
    swing: SwingSetupV1 | None = None

    @model_validator(mode="after")
    def _rules(self) -> "PracticeThreadV1":
        problems = []
        if (self.status == "closed") != (self.closedAt is not None):
            problems.append(PRACTICE_THREAD_RULES[0].description)
        if _swing_block_mismatch(self):
            problems.append(PRACTICE_THREAD_RULES[1].description)
        if problems:
            raise ValueError("; ".join(problems))
        return self
