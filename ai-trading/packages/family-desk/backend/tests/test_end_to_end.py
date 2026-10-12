"""End-to-end: a recorded Alpaca daily fixture goes through `backfill`, then `read_bars`, then
`ai_trading.core.evaluate.evaluate` with a simple template -- proving the client's frame shape
(`ai_trading_common.bars.Bars`), the store's shape (`ai_trading.data.bars`), and the core's
shape (`ai_trading.core.evaluate`) actually agree. Needs a real Postgres (`scripts/test-db.sh`).

Goes through `ai_trading_common.registry.DataSources.from_env` (not `AlpacaBars` directly), the
same way the Desk's real runtime builds its data sources (02j §7) -- `backfill` only ever sees
the `BarsSource` Protocol, never a vendor class.
"""

import json
from datetime import date
from pathlib import Path

from ai_trading_common.registry import DataSources
from ai_trading_common.testing import FakeResponse, make_client

from ai_trading.contracts.strategy_spec_v1 import StrategySpecV1
from ai_trading.core.calendar import et
from ai_trading.core.evaluate import evaluate
from ai_trading.data.backfill import backfill
from ai_trading.data.bars import read_bars

FIXTURES = Path(__file__).parent / "fixtures" / "alpaca"


def test_backfilled_alpaca_bars_evaluate_cleanly(db_session):
    body = json.loads((FIXTURES / "daily_range_aapl.json").read_text())["body"]
    http, _, _ = make_client([FakeResponse(200, body)])
    sources = DataSources.from_env(
        env={"ALPACA_API_KEY_ID": "fake-id", "ALPACA_API_SECRET_KEY": "fake-secret"}, http=http
    )

    start, end = date(2026, 1, 2), date(2026, 1, 14)
    now = et(end, "20:00")  # after the fixture's last session has closed

    result = backfill(db_session, "AAPL", "1d", "stock", start, end, bars_source=sources.bars, now=now)
    db_session.commit()
    assert result.uncovered == []
    assert len(result.written) == 9  # every trading day in the fixture's range

    bars_1d = read_bars(db_session, "AAPL", "1d", start, end, "stock", as_of=now)
    assert len(bars_1d) == 9
    assert list(bars_1d.columns) == ["open", "high", "low", "close", "volume"]

    spec = StrategySpecV1.model_validate(
        {
            "schemaVersion": 1,
            "name": "E2E smoke: close above 265",
            "watch": {"universe": {"symbols": ["AAPL"]}, "session": "regular", "runOn": "daily_close"},
            "when": {"op": "gt", "left": {"series": "close"}, "right": {"value": 265}},
            "then": {"alert": {"channels": ["inbox"]}},
        }
    )

    candidates = evaluate(spec, "AAPL", "stock", bars_1m=None, bars_1d=bars_1d, as_of=now)

    # The fixture's first close (270.27) is the only day above 265 that also starts the series
    # true -- a rising edge with no prior known state -- so exactly one candidate fires.
    assert len(candidates) == 1
    assert candidates[0].bar_time.date() == date(2026, 1, 2)
    assert candidates[0].evidence["close"] == 270.27
