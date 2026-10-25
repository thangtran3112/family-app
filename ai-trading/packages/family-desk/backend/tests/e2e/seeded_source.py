"""Network-free provider adapter backed by the E2E database's actual stored bars."""

from datetime import date

import pandas as pd
from ai_trading_common.bars import Bars
from ai_trading_common.registry import DataSources
from ai_trading_common.types import EarningsEvent
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from ai_trading.db.engine import session_scope
from ai_trading.db.models import Bar1d, Bar1h, Bar1m


class SeededBars:
    def __init__(self, factory: sessionmaker[Session]):
        self.factory = factory

    def bars(self, symbol, timeframe, start, end, *, now):
        model = {"1d": Bar1d, "1h": Bar1h, "1m": Bar1m}[timeframe]
        with session_scope(self.factory) as session:
            query = select(model).where(model.symbol == symbol)
            if timeframe == "1d":
                query = query.where(model.day >= start.tz_convert("America/New_York").date())
                query = query.where(model.day <= end.tz_convert("America/New_York").date())
                rows = session.execute(query.order_by(model.day)).scalars().all()
                index = [row.day for row in rows]
            else:
                query = query.where(model.bar_start >= start.to_pydatetime(), model.bar_start <= end.to_pydatetime())
                rows = session.execute(query.order_by(model.bar_start)).scalars().all()
                index = pd.DatetimeIndex([row.bar_start for row in rows], tz="UTC")

        frame = pd.DataFrame(
            [{column: getattr(row, column) for column in ("open", "high", "low", "close", "volume")} for row in rows],
            index=index,
            columns=["open", "high", "low", "close", "volume"],
        )
        quality = "eod" if timeframe == "1d" else "delayed-15m"
        return Bars(frame=frame, source="alpaca", quality=quality)


class SeededEarningsCalendar:
    """One invented, network-free earnings date so the dashboard's Events panel has a row to show."""

    EVENTS = {"MSFT": date(2026, 10, 28)}

    def earnings_calendar(self, symbol, start, end):
        report_date = self.EVENTS.get(symbol)
        if report_date is None or not start <= report_date <= end:
            return []
        return [
            EarningsEvent(
                symbol=symbol,
                report_date=report_date,
                timing="after_close",
                fiscal_year=None,
                fiscal_quarter=None,
                eps_estimate=None,
                eps_actual=None,
                revenue_estimate=None,
                revenue_actual=None,
                provider="seeded",
                quality="eod",
            )
        ]


def data_sources(factory: sessionmaker[Session]) -> DataSources:
    unused = object()
    return DataSources(
        bars=SeededBars(factory),
        fundamentals=unused,
        earnings_announcements=unused,
        macro=unused,
        news=unused,
        earnings_calendar=SeededEarningsCalendar(),
        consensus=unused,
        earnings=unused,
        targets=unused,
        universe=unused,
        quotes=unused,
        trades=unused,
    )
