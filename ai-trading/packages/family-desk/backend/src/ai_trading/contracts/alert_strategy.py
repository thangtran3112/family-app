"""Alert strategy: a StrategySpecV1 for a strategy at stage "alert_only" (mirror of contracts/src/alert-strategy.ts).

Same watch/when/limits as StrategySpecV1, but `then` carries the alert alone, never a paperOrder
(02a: only strategies create alerts). The alert's channels are unique and start with "inbox", the
in-app channel. Hand-written on top of the generated StrategySpecV1: JSON Schema cannot say
"unique, inbox first".
"""

from typing import NamedTuple

from pydantic import model_validator

from ai_trading.contracts.common import ConfigModel
from ai_trading.contracts.strategy_spec_v1 import Alert, StrategySpecV1


class _Rule(NamedTuple):
    id: str
    description: str


ALERT_RULES: tuple[_Rule, ...] = (
    _Rule("channels-unique", "alert channels must not repeat"),
    _Rule("channels-inbox-first", "the first alert channel must be inbox"),
)
_RULE_TEXT: dict[str, str] = {rule.id: rule.description for rule in ALERT_RULES}


class AlertOnlyThen(ConfigModel):
    alert: Alert


class AlertStrategySpecV1(StrategySpecV1):
    then: AlertOnlyThen  # narrower than StrategySpecV1.then: no paperOrder

    @model_validator(mode="after")
    def _channel_rules(self) -> "AlertStrategySpecV1":
        channels = self.then.alert.channels
        problems = []
        if len(set(channels)) != len(channels):
            problems.append(_RULE_TEXT["channels-unique"])
        if channels[0] != "inbox":
            problems.append(_RULE_TEXT["channels-inbox-first"])
        if problems:
            raise ValueError("; ".join(problems))
        return self
