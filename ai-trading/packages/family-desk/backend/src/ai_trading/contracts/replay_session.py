"""ReplaySessionV1 (mirror of contracts/src/replay-session-v1.ts): the Practice lane's session setup.

The shape is generated (strategy_spec_v1.py); the window rules live in Zod `superRefine`, which JSON
Schema cannot carry, so they are hand-written here on top of it. `PracticeMarkV1` needs nothing
hand-written: its per-kind variants are a plain `oneOf`, and the state rules (flat book, an open
trade, the losing side of the last price) are server rules in `replay/session.py`.
"""

from typing import NamedTuple

from pydantic import model_validator

from ai_trading.contracts.strategy_spec_v1 import PracticeMarkV1
from ai_trading.contracts.strategy_spec_v1 import ReplaySessionV1 as _GeneratedReplaySessionV1

__all__ = ["REPLAY_WINDOW_RULES", "PracticeMarkV1", "ReplaySessionV1"]


class _Rule(NamedTuple):
    id: str
    description: str


REPLAY_WINDOW_RULES: tuple[_Rule, ...] = (
    _Rule("window-order", "window.from must be before window.to"),
    _Rule("window-in-session", "window must stay inside 04:00-20:00 ET"),
    _Rule("window-in-regular", "a regular-session window must stay inside 09:30-16:00 ET"),
)
_TEXT: dict[str, str] = {rule.id: rule.description for rule in REPLAY_WINDOW_RULES}


class ReplaySessionV1(_GeneratedReplaySessionV1):
    @model_validator(mode="after")
    def _window_rules(self) -> "ReplaySessionV1":
        start, end = self.window.from_, self.window.to  # "HH:MM" zero-padded: string order is time order
        problems = []
        if start >= end:
            problems.append(_TEXT["window-order"])
        if start < "04:00" or end > "20:00":
            problems.append(_TEXT["window-in-session"])
        elif self.session == "regular" and (start < "09:30" or end > "16:00"):
            problems.append(_TEXT["window-in-regular"])
        if problems:
            raise ValueError("; ".join(problems))
        return self
