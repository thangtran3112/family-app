"""Invoke the production engine tick against E2E-seeded Postgres; assert real idempotency."""

import json
import os
from datetime import timedelta

import pandas as pd
from clock import E2E_NOW
from safety import e2e_url
from sqlalchemy import func, select

from ai_trading.data.bars import read_bars
from ai_trading.db.engine import make_engine, make_session_factory
from ai_trading.db.models import Alert, Signal, Strategy, StrategyVersion
from ai_trading.engine.tick import tick


def run_tick(database_url: str) -> dict[str, dict]:
    url = e2e_url(database_url)
    engine = make_engine(url.render_as_string(hide_password=False))
    factory = make_session_factory(engine)
    try:
        with factory() as session:
            assert session.scalar(select(func.count()).select_from(Alert)) == 0, "alerts must come from engine.tick"
            bars = read_bars(
                session,
                "NVDA",
                "1m",
                E2E_NOW.date() - timedelta(days=30),
                E2E_NOW.date(),
                "stock",
                as_of=pd.Timestamp(E2E_NOW),
            )
            assert isinstance(bars.index, pd.DatetimeIndex), (
                f"seeded 1m bars must have UTC index, got {bars.index.dtype}"
            )
            assert all(point.utcoffset() == timedelta(0) for point in bars.index)
            versions = session.execute(select(StrategyVersion)).scalars().all()
            assert versions and all(version.created_at <= E2E_NOW for version in versions)
            assert session.scalar(select(func.count()).select_from(Strategy).where(Strategy.stage == "alert_only")) == 1

            first = tick(session, now=E2E_NOW)
            second = tick(session, now=E2E_NOW)
            signal_count = session.scalar(select(func.count()).select_from(Signal))
            alert_count = session.scalar(select(func.count()).select_from(Alert))

        assert first.new_signals == 1, f"expected one seeded NVDA VWAP reclaim; got {first}"
        assert second.new_signals == 0, f"same tick must be deduplicated; got {second}"
        assert signal_count == alert_count == 1
        return {
            "first": {"evaluated": first.evaluated_strategies, "new_signals": first.new_signals},
            "second": {"evaluated": second.evaluated_strategies, "new_signals": second.new_signals},
        }
    finally:
        engine.dispose()


if __name__ == "__main__":
    print(json.dumps(run_tick(os.environ["DESK_E2E_DATABASE_URL"])))
