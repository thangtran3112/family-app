"""Filter strategy (kind "filter") and its shipped preset catalog entry (kind "filter_preset").

Mirror of contracts/src/filter-strategy.ts: same field names, same limits, same rules. Each Zod
superRefine rule has a matching model_validator here (the validator names are ours; Zod has none).
Hand-written, not generated.
"""

from typing import Annotated, Literal, NamedTuple

from pydantic import Field, model_validator

from ai_trading.contracts.common import ConfigModel, Description, Name, SchemaVersion, Slug, Timeframe, Universe
from ai_trading.contracts.json_pointer import JsonPointer, resolve_pointer

Lookback = Annotated[int, Field(ge=2, le=500)]
# Must match the Zod regex exactly: lowercase first letter, then camelCase letters and digits.
ParamKey = Annotated[str, Field(pattern=r"^[a-z][A-Za-z0-9]{0,31}$")]


class SimpleMetric(ConfigModel):
    metric: Literal["close", "volume", "dollar_volume", "gap_pct"]


class LookbackMetric(ConfigModel):
    metric: Literal[
        "avg_volume",
        "volume_ratio",
        "atr",
        "atr_pct",
        "stdev_pct",
        "pct_from_high",
        "pct_from_low",
        "sma",
        "ema",
        "rsi",
    ]
    lookback: Lookback


class ChangePctMetric(ConfigModel):
    metric: Literal["change_pct"]
    lookback: Annotated[int, Field(ge=1, le=500)]


class VolatilityPercentileMetric(ConfigModel):
    metric: Literal["volatility_percentile"]
    measure: Literal["atr", "stdev"]
    lookback: Lookback
    window: Annotated[int, Field(ge=20, le=1000)]


FilterMetric = Annotated[
    SimpleMetric | LookbackMetric | ChangePctMetric | VolatilityPercentileMetric,
    Field(discriminator="metric"),
]

# Allowed threshold range per metric, inclusive. None = unbounded on that side.
FILTER_METRIC_DOMAIN: dict[str, tuple[float, float | None]] = {
    "close": (0, None),
    "volume": (0, None),
    "dollar_volume": (0, None),
    "gap_pct": (-100, None),
    "avg_volume": (0, None),
    "volume_ratio": (0, None),
    "atr": (0, None),
    "atr_pct": (0, None),
    "stdev_pct": (0, None),
    "pct_from_high": (0, 100),
    "pct_from_low": (0, None),
    "sma": (0, None),
    "ema": (0, None),
    "rsi": (0, 100),
    "change_pct": (-100, None),
    "volatility_percentile": (0, 100),
}


def _check_domain(metric: str, value: float) -> None:
    low, high = FILTER_METRIC_DOMAIN[metric]
    if value < low or (high is not None and value > high):
        raise ValueError(f"{value} is outside the {metric} domain")


# A condition is one metric's fields plus a comparison or a closed range. The comparison and
# range mixins read `self.metric`, which the concrete class supplies from its metric shape.
class _Comparison(ConfigModel):
    op: Literal["gt", "gte", "lt", "lte"]
    threshold: float

    @model_validator(mode="after")
    def _threshold_in_domain(self):
        _check_domain(self.metric, self.threshold)
        return self


class _Between(ConfigModel):
    op: Literal["between"]
    min: float
    max: float

    @model_validator(mode="after")
    def _between_rules(self):
        if not self.min < self.max:
            raise ValueError("between needs min < max")
        _check_domain(self.metric, self.min)
        _check_domain(self.metric, self.max)
        return self


class SimpleComparison(SimpleMetric, _Comparison):
    pass


class LookbackComparison(LookbackMetric, _Comparison):
    pass


class ChangePctComparison(ChangePctMetric, _Comparison):
    pass


class VolatilityPercentileComparison(VolatilityPercentileMetric, _Comparison):
    pass


class SimpleBetween(SimpleMetric, _Between):
    pass


class LookbackBetween(LookbackMetric, _Between):
    pass


class ChangePctBetween(ChangePctMetric, _Between):
    pass


class VolatilityPercentileBetween(VolatilityPercentileMetric, _Between):
    pass


FilterCondition = (
    SimpleComparison
    | LookbackComparison
    | ChangePctComparison
    | VolatilityPercentileComparison
    | SimpleBetween
    | LookbackBetween
    | ChangePctBetween
    | VolatilityPercentileBetween
)


class AllGroup(ConfigModel):
    all: Annotated[list["FilterNode"], Field(min_length=1, max_length=20)]


class AnyGroup(ConfigModel):
    any: Annotated[list["FilterNode"], Field(min_length=1, max_length=20)]


FilterGroup = AllGroup | AnyGroup
FilterNode = FilterCondition | AllGroup | AnyGroup
AllGroup.model_rebuild()
AnyGroup.model_rebuild()


class FilterGroupStats(NamedTuple):
    depth: int
    leaves: int


def filter_group_stats(group: FilterGroup) -> FilterGroupStats:
    """Depth (the top group is 1) and condition leaves. Every consumer keeps depth <= 3 and leaves <= 30."""
    nodes = group.all if isinstance(group, AllGroup) else group.any
    depth, leaves = 1, 0
    for node in nodes:
        if isinstance(node, AllGroup | AnyGroup):
            inner = filter_group_stats(node)
            depth = max(depth, inner.depth + 1)
            leaves += inner.leaves
        else:
            leaves += 1
    return FilterGroupStats(depth, leaves)


class FilterRank(ConfigModel):
    by: FilterMetric
    order: Literal["asc", "desc"]
    limit: Annotated[int, Field(ge=1, le=200)]


class FilterPresetRef(ConfigModel):
    """Provenance of a customized shipped preset: the values the user chose."""

    id: Slug
    params: dict[ParamKey, float]


class FilterStrategy(ConfigModel):
    schemaVersion: SchemaVersion
    kind: Literal["filter"]
    name: Name
    description: Description | None = None
    timeframe: Timeframe
    universe: Universe | None = None
    match: FilterGroup
    rank: FilterRank | None = None
    preset: FilterPresetRef | None = None

    @model_validator(mode="after")
    def _match_size(self) -> "FilterStrategy":
        stats = filter_group_stats(self.match)
        if stats.depth > 3:
            raise ValueError(f"group depth {stats.depth} exceeds 3")
        if stats.leaves > 30:
            raise ValueError(f"{stats.leaves} conditions exceed 30")
        return self


PresetUnit = Literal["x", "pct", "percentile", "bars", "usd", "shares"]
PresetCategory = Literal["volume", "volatility", "gap", "range", "proximity"]


class PresetParam(ConfigModel):
    key: ParamKey
    label: Annotated[str, Field(min_length=1, max_length=60)]
    unit: PresetUnit
    path: JsonPointer
    default: float
    min: float
    max: float
    step: Annotated[float, Field(gt=0)] | None = None


class FilterPreset(ConfigModel):
    schemaVersion: SchemaVersion
    kind: Literal["filter_preset"]
    id: Slug
    name: Name
    description: Description
    category: PresetCategory
    params: Annotated[list[PresetParam], Field(min_length=1, max_length=8)]
    strategy: FilterStrategy

    @model_validator(mode="after")
    def _preset_rules(self) -> "FilterPreset":
        ref = self.strategy.preset
        if ref is None:
            raise ValueError("strategy.preset is required")
        if ref.id != self.id:
            raise ValueError("strategy.preset.id must equal the preset id")
        keys = [param.key for param in self.params]
        paths = [param.path for param in self.params]
        if len(set(keys)) != len(keys):
            raise ValueError("param keys must be unique")
        if len(set(paths)) != len(paths):
            raise ValueError("param paths must be unique")
        if len(ref.params) != len(self.params):
            raise ValueError("strategy.preset.params keys must equal the param keys")

        doc = self.strategy.model_dump(by_alias=True, exclude_none=True)
        for param in self.params:
            if not param.min < param.max:
                raise ValueError(f"{param.key}: needs min < max")
            if not param.min <= param.default <= param.max:
                raise ValueError(f"{param.key}: default must lie in min..max")
            if ref.params.get(param.key) != param.default:
                raise ValueError(f"strategy.preset.params.{param.key} must equal its default")
            found, value = resolve_pointer(doc, param.path)
            if not found or not isinstance(value, (int, float)):
                raise ValueError(f"{param.key}: path does not resolve to a number")
            if value != param.default:
                raise ValueError(f"{param.key}: value at path differs from default")
        return self
