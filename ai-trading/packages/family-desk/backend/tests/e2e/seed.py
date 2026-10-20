"""Seed invented NVDA and /ES bars into one fresh, uniquely named loopback E2E database."""

import json
import os
from datetime import UTC
from zoneinfo import ZoneInfo

import exchange_calendars as xcals
import pandas as pd
from clock import E2E_EMAIL, E2E_NOW
from safety import e2e_url
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ai_trading.db.models import Bar1d, Bar1m, Base, User, Watchlist, WatchlistItem


def seed_database(database_url: str) -> tuple[int, int]:
    url = e2e_url(database_url)
    from sqlalchemy import create_engine

    engine = create_engine(url.render_as_string(hide_password=False))
    try:
        with Session(engine) as session:
            for model in Base.registry.mappers:
                table = model.class_
                if session.scalar(select(func.count()).select_from(table)):
                    raise RuntimeError("E2E seed requires a fresh, empty database")

            calendar = xcals.get_calendar("XNYS")
            day = E2E_NOW.astimezone(ZoneInfo("America/New_York")).date()
            label = pd.Timestamp(day)
            if not calendar.is_session(label):
                raise RuntimeError("DESK_E2E_NOW must land on an XNYS weekday session")
            session_close = calendar.session_close(label)
            if pd.Timestamp(E2E_NOW) < session_close or E2E_NOW.date() <= day:
                raise RuntimeError("DESK_E2E_NOW must follow the NY close and advance to next UTC date")

            sessions = calendar.sessions_in_range(label - pd.Timedelta(days=90), label)
            daily_days = [stamp.date() for stamp in sessions if stamp.date() < day][-40:]
            if len(daily_days) < 30:
                raise RuntimeError("E2E seed needs at least 30 prior XNYS sessions")

            user = User(email=E2E_EMAIL, settings={"e2e_unknown": {"keep": True}})
            session.add(user)
            session.flush()
            day_movers = Watchlist(user_id=user.id, name="Day movers", horizon="intraday")
            futures = Watchlist(user_id=user.id, name="Futures", horizon="intraday")
            identity = Watchlist(user_id=user.id, name="Identity", horizon="swing")
            session.add_all([day_movers, futures, identity])
            session.flush()
            session.add_all(
                [
                    WatchlistItem(watchlist_id=day_movers.id, symbol="NVDA", asset_type="stock"),
                    WatchlistItem(watchlist_id=day_movers.id, symbol="/ES", asset_type="future"),
                    WatchlistItem(watchlist_id=futures.id, symbol="/ES", asset_type="future"),
                    WatchlistItem(watchlist_id=identity.id, symbol="CL", asset_type="stock"),
                    WatchlistItem(watchlist_id=identity.id, symbol="/CL", asset_type="future"),
                ]
            )

            symbols = (
                ("NVDA", 100.0),
                ("/ES", 5_000.0),
                ("CL", 70.0),
                ("/CL", 71.0),
                ("/MNQ", 15_000.0),
                ("/MCL", 74.0),
                ("AAPL", 150.0),
                ("GAP", 200.0),
            )
            for symbol, base in symbols:
                symbol_days = daily_days[-10:] if symbol == "GAP" else daily_days
                for index, trading_day in enumerate(symbol_days):
                    close = base + index * (0.5 if symbol == "NVDA" else 3.0)
                    session.add(
                        Bar1d(
                            symbol=symbol,
                            day=trading_day,
                            open=close - 0.5,
                            high=close + 1.0,
                            low=close - 1.0,
                            close=close,
                            volume=1_000_000.0,
                            source="alpaca",
                        )
                    )

                session_open = calendar.session_open(label).to_pydatetime()
                last_closed_start = session_close - pd.Timedelta(minutes=2)
                bar_starts = pd.date_range(
                    start=session_open,
                    end=last_closed_start,
                    freq="1min",
                )
                for index, bar_start in enumerate(bar_starts):
                    if index < 30:
                        close = base
                    elif index == 30:
                        close = base - 1.0
                    else:
                        close = base + (2.0 if symbol == "NVDA" else 2.0)
                    session.add(
                        Bar1m(
                            symbol=symbol,
                            bar_start=bar_start.to_pydatetime().astimezone(UTC),
                            open=close,
                            high=close,
                            low=close,
                            close=close,
                            volume=100.0,
                            source="alpaca",
                        )
                    )

            session.commit()
            daily_count = sum(10 if symbol == "GAP" else len(daily_days) for symbol, _ in symbols)
            return daily_count, len(bar_starts) * len(symbols)
    finally:
        engine.dispose()


if __name__ == "__main__":
    daily_count, minute_count = seed_database(os.environ["DESK_E2E_DATABASE_URL"])
    print(json.dumps({"seeded_daily_bars": daily_count, "seeded_1m_bars": minute_count}))
