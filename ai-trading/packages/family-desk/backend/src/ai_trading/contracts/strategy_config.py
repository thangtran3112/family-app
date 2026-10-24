"""Every persona-split config document, told apart by `kind` (mirror of contracts/src/strategy-config.ts).

`strategy_config_adapter.validate_json(text)` is the one entry point for a persisted strategy
result or a shipped preset. strategy_spec_v1 is separate: it is the alert-and-paper-order spec.
"""

from typing import Annotated

from pydantic import Field, TypeAdapter

from ai_trading.contracts.alert_strategy import AlertStrategy
from ai_trading.contracts.custom_strategy import CustomStrategy
from ai_trading.contracts.filter_strategy import FilterPreset, FilterStrategy
from ai_trading.contracts.pattern_preset_strategy import PatternPreset
from ai_trading.contracts.strategy_draft import StrategyDraft

StrategyConfig = Annotated[
    FilterStrategy | FilterPreset | PatternPreset | CustomStrategy | AlertStrategy | StrategyDraft,
    Field(discriminator="kind"),
]

strategy_config_adapter: TypeAdapter[StrategyConfig] = TypeAdapter(StrategyConfig)
