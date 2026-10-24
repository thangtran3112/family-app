"""Shared primitives for the strategy-draft exchange model (mirror of contracts/src/strategy-common.ts).

Hand-written, not generated: the draft's cross-field rules live in Zod `superRefine`, which JSON
Schema cannot carry, so the models implement each rule next to the field it guards. The specs
themselves (strategy_spec_v1.py: StrategySpecV1, FilterStrategySpecV1, PresetCatalogV1) are generated.
"""

from typing import Annotated, Literal

from pydantic import ConfigDict, Field

from ai_trading.contracts.base import SpecModel


class ConfigModel(SpecModel):
    """SpecModel (strict, no nulls or booleans) plus Zod's strictObject: unknown keys are errors."""

    model_config = ConfigDict(extra="forbid")


SchemaVersion = Literal[1]
# [a-z0-9], not \w: Zod and Python must agree on ASCII.
Slug = Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9_-]{0,63}$")]
UtcTimestamp = Annotated[
    str,
    Field(pattern=r"^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$"),
]
