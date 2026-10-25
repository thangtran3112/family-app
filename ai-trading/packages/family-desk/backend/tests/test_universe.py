"""The screener universe (02m §b1): plain-ticker filter, asset type, the provider build with failures, and
the liquidity floor (real Postgres via `scripts/test-db.sh`)."""

from datetime import UTC, datetime

import pytest
from ai_trading_common.errors import NotConfigured, Unavailable
from ai_trading_common.registry import DataSources
from ai_trading_common.types import ActiveSymbol, Mover, UniverseAsset

from ai_trading.data.metrics import store_metrics
from ai_trading.data.universe import (
    SEED_SYMBOLS,
    apply_floor,
    build_universe,
    classify_asset_type,
    ensure_universe,
    split_plain,
)
from ai_trading.db.models import UniverseSymbol

NOW = datetime(2026, 10, 24, 12, 0, tzinfo=UTC)


class FakeUniverse:
    def __init__(self, *, actives=(), movers=(), assets=(), fail=()):
        self._actives, self._movers, self._assets, self._fail = list(actives), list(movers), list(assets), set(fail)
        self.calls_made = 0

    def _check(self, name: str) -> None:
        self.calls_made += 1
        if name in self._fail:
            raise Unavailable("fake", f"{name} down")

    def assets(self):
        self._check("assets")
        return self._assets

    def most_actives(self, by, top):
        self._check("most_actives")
        return [ActiveSymbol(s, 1.0, 1, "fake", "delayed-15m") for s in self._actives]

    def movers(self, top):
        self._check("movers")
        return [Mover(s, "gainer", 1.0, 10.0, "fake", "delayed-15m") for s in self._movers]


class NotConfiguredUniverse(FakeUniverse):
    def _check(self, name: str) -> None:
        raise NotConfigured("fake", "no key")


def _sources(universe) -> DataSources:
    unused = object()
    return DataSources(
        bars=unused,
        fundamentals=unused,
        earnings_announcements=unused,
        macro=unused,
        news=unused,
        earnings_calendar=unused,
        consensus=unused,
        earnings=unused,
        targets=unused,
        universe=universe,
        quotes=unused,
        trades=unused,
    )


def _asset(symbol: str, name: str, exchange: str = "NASDAQ") -> UniverseAsset:
    return UniverseAsset(symbol, name, exchange, "fake", "eod")


def test_split_plain_drops_warrants_units_and_preferred_and_dedupes():
    kept, dropped = split_plain(["nvda", "NVDA", "COPL.WS", "NE.WSA", "BRK.B", "ABCDEF", "", "AMD"])
    assert kept == ["AMD", "NVDA"]
    assert dropped == ["ABCDEF", "BRK.B", "COPL.WS", "NE.WSA"]


@pytest.mark.parametrize(
    ("symbol", "name", "expected"),
    [
        ("SPY", "SPDR S&P 500 ETF Trust", "etf"),
        ("QQQ", "anything", "etf"),  # the market strip is always an ETF
        ("XLK", "Technology Select Sector SPDR Fund", "etf"),
        ("BIL", "SPDR Bloomberg 1-3 Month T-Bill ETF", "etf"),
        ("NVDA", "NVIDIA Corporation Common Stock", "stock"),
        ("NTRS", "Northern Trust Corporation Common Stock", "stock"),
        ("TSM", "Taiwan Semiconductor Manufacturing American Depositary Shares", "stock"),
        ("ZZZ", "Some Unknown Name", "stock"),
    ],
)
def test_asset_type_follows_the_name(symbol, name, expected):
    assert classify_asset_type(symbol, name) == expected


def test_build_universe_unions_seeds_and_provider_lists_and_records_the_dropped(db_session):
    sources = _sources(
        FakeUniverse(
            actives=["AAPL", "WSX.WS", "XYZ"],
            movers=["XYZ", "MOVR"],
            assets=[_asset("XYZ", "Xyz Corp Common Stock", "NYSE"), _asset("AAPL", "Apple Inc. Common Stock")],
        )
    )
    build = build_universe(db_session, sources, now=NOW)
    db_session.commit()

    rows = {row.symbol: row for row in db_session.query(UniverseSymbol).all()}
    assert set(SEED_SYMBOLS) <= {s for s, r in rows.items() if r.active}
    assert rows["XYZ"].name == "Xyz Corp Common Stock" and rows["XYZ"].exchange == "NYSE"
    assert rows["MOVR"].name == "MOVR"  # not in the asset list: named by its ticker
    assert rows["WSX.WS"].active is False and rows["WSX.WS"].floor_reason == {"reason": "non_plain_ticker"}
    assert build.dropped_non_plain == 1
    assert build.candidates == len(SEED_SYMBOLS) + 3 - 1 and build.failed == {}  # AAPL is a seed; XYZ twice
    assert rows["NVDA"].asset_type == "stock" and rows["SPY"].asset_type == "etf"


def test_a_failed_provider_list_is_recorded_and_the_rest_still_build(db_session):
    sources = _sources(FakeUniverse(actives=["XYZ"], fail=["assets", "movers"]))
    build = build_universe(db_session, sources, now=NOW)
    db_session.commit()
    assert set(build.failed) == {"assets", "movers"}
    assert db_session.get(UniverseSymbol, "XYZ").active is True  # actives alone still contributed
    assert db_session.get(UniverseSymbol, "XYZ").name == "XYZ"


def test_when_every_list_fails_the_stored_universe_is_kept_and_only_seeds_refresh(db_session):
    build_universe(db_session, _sources(FakeUniverse(actives=["XYZ"])), now=NOW)
    db_session.commit()
    build = build_universe(db_session, _sources(NotConfiguredUniverse()), now=NOW)
    db_session.commit()
    assert len(build.failed) == 4 and build.deactivated == 0
    assert db_session.get(UniverseSymbol, "XYZ").active is True


def test_a_symbol_that_leaves_the_lists_becomes_inactive_but_keeps_its_row(db_session):
    build_universe(db_session, _sources(FakeUniverse(actives=["XYZ"], assets=[_asset("XYZ", "Xyz Inc")])), now=NOW)
    db_session.commit()
    build = build_universe(db_session, _sources(FakeUniverse(actives=["OTHER"])), now=NOW)
    db_session.commit()
    assert build.deactivated == 1
    gone = db_session.get(UniverseSymbol, "XYZ")
    assert gone.active is False and gone.name == "Xyz Inc"
    assert db_session.get(UniverseSymbol, "OTHER").active is True


def test_apply_floor_uses_stored_metrics_and_records_why_a_symbol_failed(db_session):
    build_universe(db_session, _sources(FakeUniverse(actives=["BIG", "PENNY", "THIN", "NOBAR"])), now=NOW)
    for symbol, last, volume in (("BIG", 20.0, 2_000_000), ("PENNY", 2.0, 5_000_000), ("THIN", 50.0, 100_000)):
        store_metrics(
            db_session,
            symbol,
            {"last": last, "avg_volume_20d": volume},
            as_of=NOW,
            source="alpaca",
            quality="eod",
        )
    passed, failed = apply_floor(db_session, now=NOW)
    db_session.commit()

    rows = {row.symbol: row for row in db_session.query(UniverseSymbol).all()}
    assert rows["BIG"].passed_floor is True and rows["BIG"].floor_reason is None
    assert rows["PENNY"].floor_reason == {"reason": "below_floor", "last": 2.0, "avg_volume_20d": 5_000_000}
    assert rows["THIN"].passed_floor is False and rows["THIN"].floor_reason["reason"] == "below_floor"
    assert rows["NOBAR"].floor_reason == {"reason": "no_daily_data"}
    assert passed == 1 and failed == len(SEED_SYMBOLS) + 4 - 1  # seeds have no metrics here either


def test_ensure_universe_builds_a_fresh_install_once_and_then_leaves_it_alone(db_session):
    listed = [f"A{chr(65 + i)}{chr(65 + j)}" for i in range(10) for j in range(13)]  # 130 plain tickers
    universe = FakeUniverse(actives=listed, movers=["WSX.WS"])
    sources = _sources(universe)

    first = ensure_universe(db_session, sources, now=NOW)
    db_session.commit()
    active = db_session.query(UniverseSymbol).filter(UniverseSymbol.active.is_(True)).count()
    assert first is not None and active == len(SEED_SYMBOLS) + len(listed) >= 130  # the seeds plus the lists

    calls = universe.calls_made
    assert ensure_universe(db_session, sources, now=NOW) is None and universe.calls_made == calls  # no second build


def test_ensure_universe_retries_while_only_the_seeds_are_stored(db_session):
    down = ensure_universe(db_session, _sources(NotConfiguredUniverse()), now=NOW)
    db_session.commit()
    assert down is not None and len(down.failed) == 4
    assert db_session.query(UniverseSymbol).filter(UniverseSymbol.active.is_(True)).count() == len(SEED_SYMBOLS)

    later = ensure_universe(db_session, _sources(FakeUniverse(actives=["XYZ"])), now=NOW)  # the provider is back
    assert later is not None and db_session.get(UniverseSymbol, "XYZ").active is True
