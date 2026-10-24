"""`screener/columns.py`: the table columns each seed filter shows (02l D5), and the add/promote rules."""

import pytest

from ai_trading.contracts.strategy_spec_v1 import FilterStrategySpecV1
from ai_trading.library.catalog import load_catalog, load_template
from ai_trading.screener.columns import FIXED, table_columns

METRIC_BLOCK_WITH_RVOL_FIRST = [
    "last",
    "rvol_10d",
    "change_pct",
    "volume",
    "atr_pct_14",
    "gap_pct_open",
    "rsi_14",
    "vs_vwap_pct",
]
METRIC_BLOCK_WITH_GAP_FIRST = [
    "last",
    "gap_pct_open",
    "change_pct",
    "volume",
    "rvol_10d",
    "atr_pct_14",
    "rsi_14",
    "vs_vwap_pct",
]
WITH_52W_HIGH = METRIC_BLOCK_WITH_RVOL_FIRST + ["high_252d", "dist_to_252d_high_pct"]

#: The ten seeds (catalog `kind == "filter"`), each with its metric keys in display order.
EXPECTED = {
    "abnormal-volume": METRIC_BLOCK_WITH_RVOL_FIRST,  # rank.by rvol promotes rvol_10d after last
    "high-volatility": [
        "last",
        "atr_pct_14",
        "change_pct",
        "volume",
        "rvol_10d",
        "gap_pct_open",
        "rsi_14",
        "vs_vwap_pct",
    ],
    "gap-up": METRIC_BLOCK_WITH_GAP_FIRST,
    "gap-down": METRIC_BLOCK_WITH_GAP_FIRST,
    "new-20-day-high": METRIC_BLOCK_WITH_RVOL_FIRST,  # the 20-day high has no metric column
    "52-week-breakout": WITH_52W_HIGH,  # n_day_high(252) adds the level and the distance to it
    "oversold-rsi": ["last", "rsi_14", "change_pct", "volume", "rvol_10d", "atr_pct_14", "gap_pct_open", "vs_vwap_pct"],
    "overbought-rsi": [
        "last",
        "rsi_14",
        "change_pct",
        "volume",
        "rvol_10d",
        "atr_pct_14",
        "gap_pct_open",
        "vs_vwap_pct",
    ],
    "above-vwap-on-volume": METRIC_BLOCK_WITH_RVOL_FIRST,
    "top-movers": METRIC_BLOCK_WITH_GAP_FIRST,
}


def _dumped(spec: dict) -> dict:
    return FilterStrategySpecV1.model_validate(spec).model_dump(mode="json", by_alias=True, exclude_none=True)


def _keys(spec: dict) -> list[str]:
    return [column["key"] for column in table_columns(spec)]


SEED_FILES = [(entry.id, entry.file) for entry in load_catalog().entries if entry.kind == "filter"]


def test_expected_table_covers_exactly_the_ten_seeds():
    assert sorted(EXPECTED) == sorted(key for key, _ in SEED_FILES)


@pytest.mark.parametrize(("key", "file"), SEED_FILES, ids=[key for key, _ in SEED_FILES])
def test_each_seed_shows_the_columns_its_operands_and_rank_call_for(key, file):
    assert _keys(_dumped(load_template(file))) == EXPECTED[key] + ["matched_since"]


def test_a_filter_with_no_operands_or_rank_shows_only_the_fixed_block():
    when = {"op": "gt", "left": {"series": "sma", "length": 20}, "right": {"value": 1}}
    assert _keys({"when": when}) == [*FIXED, "matched_since"]


def test_conditions_are_walked_through_all_any_and_not():
    when = {"not": {"any": [{"op": "gt", "left": {"level": "n_day_high", "days": 252}, "right": {"value": 1}}]}}
    assert _keys({"when": when}) == [*FIXED, "high_252d", "dist_to_252d_high_pct", "matched_since"]


def test_a_rank_series_already_at_the_front_stays_first():
    rank = {"by": {"series": "close"}, "order": "desc"}  # close is `last`, which always leads
    assert _keys({"when": {"op": "gt", "left": {"series": "volume"}, "right": {"value": 1}}, "rank": rank}) == [
        *FIXED,
        "matched_since",
    ]


@pytest.mark.parametrize(
    "operand",
    [
        {"series": "rvol", "lookbackDays": 20},  # no 20-day RVOL column
        {"series": "rsi", "length": 2},  # the RSI column is 14-period only
        {"series": "atr", "length": 14},  # plain ATR is in dollars, not the ATR % column
        {"series": "sma", "length": 20},
    ],
)
def test_operands_whose_metric_does_not_match_add_nothing(operand):
    when = {"op": "gt", "left": operand, "right": {"value": 1}}
    assert _keys({"when": when}) == [*FIXED, "matched_since"]


def test_last_column_is_labelled_and_formatted_and_since_closes_the_table():
    columns = table_columns({"when": {"op": "gt", "left": {"series": "close"}, "right": {"value": 1}}})
    assert columns[0] == {"key": "last", "label": "Last", "format": "price"}
    assert columns[-1] == {"key": "matched_since", "label": "Since", "format": "time"}
