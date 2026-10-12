"""The streaming-slot allocator (02a §7)."""

from datetime import UTC, datetime

from ai_trading.data.slots import SlotDemand, allocate

T0 = datetime(2026, 1, 1, tzinfo=UTC)


def at(minutes: int) -> datetime:
    return T0.replace(minute=minutes % 60, hour=minutes // 60)


def test_priority_order_wins_over_arrival_time():
    # A later intraday-strategy demand still beats an earlier open-chart one (02a §7's order).
    demands = [
        SlotDemand("AAPL", "open_chart", at(0)),
        SlotDemand("MSFT", "intraday_strategy", at(10)),
    ]
    decisions = {d.symbol: d for d in allocate(demands, cap=1)}
    assert decisions["MSFT"].granted is True
    assert decisions["AAPL"].granted is False
    assert decisions["AAPL"].reason == "no streaming slot available (cap 1)"


def test_within_a_kind_earlier_since_wins_then_symbol():
    demands = [
        SlotDemand("ZZZ", "open_chart", at(5)),
        SlotDemand("AAA", "open_chart", at(5)),  # same since as ZZZ: symbol breaks the tie
        SlotDemand("BBB", "open_chart", at(1)),  # earliest: wins first
    ]
    decisions = allocate(demands, cap=2)
    granted = [d.symbol for d in decisions if d.granted]
    assert granted == ["BBB", "AAA"]  # AAA beats ZZZ at the same `since`


def test_one_symbol_many_demands_counts_once_under_its_best_kind():
    demands = [
        SlotDemand("AAPL", "covered_call_scan", at(0)),
        SlotDemand("AAPL", "intraday_strategy", at(20)),
        SlotDemand("AAPL", "open_chart", at(5)),
    ]
    decisions = allocate(demands, cap=70)
    assert len(decisions) == 1
    assert decisions[0].kind == "intraday_strategy"
    assert decisions[0].since == at(20)
    assert decisions[0].granted is True


def test_cap_denies_the_overflow_deterministically():
    demands = [SlotDemand(f"SYM{i}", "open_chart", at(i)) for i in range(5)]
    decisions = allocate(demands, cap=3)
    granted = sorted(d.symbol for d in decisions if d.granted)
    denied = sorted(d.symbol for d in decisions if not d.granted)
    assert granted == ["SYM0", "SYM1", "SYM2"]
    assert denied == ["SYM3", "SYM4"]
    assert all(d.reason for d in decisions if not d.granted)


def test_allocation_is_deterministic_regardless_of_input_order():
    demands = [SlotDemand(f"SYM{i}", "open_chart", at(i)) for i in range(10)]
    forward = allocate(demands, cap=4)
    backward = allocate(list(reversed(demands)), cap=4)
    assert forward == backward
