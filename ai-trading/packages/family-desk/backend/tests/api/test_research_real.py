"""The real Research routes (02n §h step 3c, §c3 #12 to #15) on a real Postgres and fake providers, no network: the
brief and the Desk AI verdict are empty until step 5, consensus and targets are the stored snapshots, valuation and
the earnings reaction come from canned filings and bars, and the timeline is a newest-first read model. With
`DESK_FUNDAMENTAL_STUB=1` the same routes still answer from the invented world (`test_fundamental_contract.py`)."""

from datetime import UTC, datetime, timedelta
from typing import Any

import pandas as pd
import pytest
from ai_trading_common.errors import Unavailable
from ai_trading_common.types import NewsItem
from conftest import OTHER_EMAIL, OWNER_EMAIL, auth_headers
from fastapi.testclient import TestClient
from research_world import (
    FY_ENDS,
    FakeAnnouncements,
    FakeBars,
    FakeFundamentals,
    FakeNews,
    FakeQuotes,
    announced,
    data_sources,
)
from sqlalchemy.orm import Session

from ai_trading.api.app import app
from ai_trading.api.auth import get_data_sources
from ai_trading.core.calendar import ET
from ai_trading.db.models import (
    AiCall,
    AiVerdict,
    Alert,
    AnalystTarget,
    ConsensusSnapshot,
    EarningsResult,
    FeedHealth,
    User,
)
from ai_trading.fundamental_stub import STUB_FLAG
from ai_trading.research.valuation import clear_cache

PREFIX = "/api/desk/research"
NOW = datetime.now(UTC)
TODAY = datetime.now(ET).date()
METHODS = ["dcf", "owner_earnings", "ev_ebitda", "residual_income"]
UNAVAILABLE_STAMP = {"as_of": None, "source": None, "quality": "unavailable", "freshness": "unavailable"}


@pytest.fixture(autouse=True)
def real_services(monkeypatch: pytest.MonkeyPatch):
    """The stub flag off (the default) and the per-process valuation cache empty around every test."""
    monkeypatch.delenv(STUB_FLAG, raising=False)
    clear_cache()
    yield
    clear_cache()


def serve(**sources: Any) -> None:
    """Replace the fake `DataSources` the `client` fixture installed; kinds not named stay unused sentinels, so a
    route that reaches for a provider it should not need fails loudly."""
    app.dependency_overrides[get_data_sources] = lambda: data_sources(**sources)


def get(client: TestClient, path: str, **kwargs: Any) -> Any:
    return client.get(f"{PREFIX}{path}", headers=auth_headers(), **kwargs)


def day(offset: int):
    return TODAY + timedelta(days=offset)


def consensus_row(
    kind: str, period: int, eps: float | None, *, snapshot: int = 0, fy: int | None = None, fq: int | None = None
) -> ConsensusSnapshot:
    return ConsensusSnapshot(
        symbol="AAPL",
        period_kind=kind,
        period_end=day(period),
        snapshot_date=day(snapshot),
        fiscal_year=fy,
        fiscal_quarter=fq,
        eps_mean=eps,
        analyst_count=31,
        provider="eulerpool",
        quality="eod",
        as_of=NOW,
        captured_at=NOW,
    )


def result_row(period: int, actual: float | None, *, report: int | None = None, symbol: str = "AAPL", **fields: Any):
    return EarningsResult(
        symbol=symbol,
        period_end=day(period),
        report_date=None if report is None else day(report),
        eps_estimate=1.1,
        eps_actual=actual,
        provider="eulerpool",
        quality="eod",
        as_of=NOW,
        captured_at=NOW,
        **fields,
    )


def seed_consensus(db: Session) -> None:
    """AAPL: today's snapshot, and the current year's history with a hit, a nearer decoy and a gap at 90 days."""
    db.add_all(
        [
            consensus_row("quarter", 30, 1.50, fy=2026, fq=4),
            consensus_row("quarter", 120, 1.60, fy=2027, fq=1),
            consensus_row("quarter", -60, 1.40, fy=2026, fq=3),  # over: not listed
            consensus_row("annual", 100, 6.30, fy=2026),
            consensus_row("annual", 465, 7.00, fy=2027),
            consensus_row("annual", -265, 5.50, fy=2025),  # over: not listed, never the current year
            *(
                consensus_row("annual", 100, eps, snapshot=ago, fy=2026)
                for ago, eps in ((-7, 6.00), (-9, 1.00), (-30, 5.25), (-32, 9.90), (-85, 4.00))
            ),
            *(
                result_row(offset, actual, report=offset + 20, fiscal_year=fy, fiscal_quarter=fq, **extra)
                for offset, actual, fy, fq, extra in (
                    (-60, 1.20, 2026, 3, {"surprise_percent": 9.09}),
                    (-150, 1.00, 2026, 2, {"surprise_percent": -4.76}),
                    (-240, 0.95, 2026, 1, {}),
                    (-330, 0.90, 2025, 4, {}),
                    (-420, 0.85, 2025, 3, {}),  # a fifth report: only four surprises are listed
                )
            ),
            result_row(-10, None, report=-5),  # stale: its report date passed with no result, so not "next"
            result_row(30, None, report=25, report_time="amc"),
            AnalystTarget(
                symbol="AAPL",
                snapshot_date=day(-10),
                target_mean=170.0,
                provider="finnhub",
                quality="eod",
                as_of=NOW,
                captured_at=NOW,
            ),
            AnalystTarget(
                symbol="AAPL",
                snapshot_date=day(0),
                target_low=150.0,
                target_mean=190.0,
                target_high=230.0,
                strong_buy=10,
                buy=14,
                hold=9,
                sell=1,
                strong_sell=1,
                provider="finnhub",
                quality="eod",
                as_of=NOW,
                captured_at=NOW,
            ),
        ]
    )
    db.commit()


def test_the_brief_is_empty_with_honest_zero_counts_until_step_5(client: TestClient) -> None:
    body = get(client, "/brief").json()
    assert body["rows"] == [] and body["run"] is None
    assert body["track_record"] == {"calls": 0, "settled": 0, "pending": 0}
    assert body["date"] == TODAY.isoformat()
    assert get(client, "/brief?date=2026-10-23").json()["date"] == "2026-10-23"


def test_the_brief_counts_stored_calls_as_pending(client: TestClient, db_session: Session) -> None:
    db_session.add(
        AiVerdict(
            symbol="AAPL",
            trading_day=day(-1),
            rating="buy",
            target_low=90,
            target_base=100,
            target_high=110,
            confidence=60,
            model="test-model",
            content_hash="h",
            created_at=NOW,
        )
    )
    db_session.flush()
    db_session.add(AiCall(symbol="AAPL", trading_day=day(-1), rating="buy", prev_rating=None, created_at=NOW))
    db_session.commit()
    body = get(client, "/brief").json()
    assert body["track_record"] == {"calls": 1, "settled": 0, "pending": 1}
    assert body["rows"] == []  # the verdict job is step 5's: a stored verdict is not read into the brief yet


def test_a_symbol_with_nothing_stored_is_a_200_with_the_unavailable_stamp(client: TestClient) -> None:
    response = get(client, "/symbols/zzzz")  # lower case is accepted and upper-cased
    assert response.status_code == 200
    assert response.json() == {
        "symbol": "ZZZZ",
        "verdict": None,
        "consensus": None,
        "targets": None,
        "stamp": UNAVAILABLE_STAMP,
    }


def test_consensus_reads_the_latest_snapshot_with_labels_surprises_and_revisions(
    client: TestClient, db_session: Session
) -> None:
    seed_consensus(db_session)
    db_session.add(FeedHealth(feed="consensus", state="ok", last_ok_at=NOW, updated_at=NOW))
    db_session.commit()
    body = get(client, "/symbols/AAPL").json()
    assert body["verdict"] is None  # the Desk AI verdict is step 5's
    consensus = body["consensus"]
    assert consensus["quarters"] == [
        {"period": "Q4 2026", "eps_estimate": 1.5, "analysts": 31},
        {"period": "Q1 2027", "eps_estimate": 1.6, "analysts": 31},
    ]
    assert consensus["fiscal_years"] == [
        {"period": "FY2026", "eps_estimate": 6.3, "analysts": 31},
        {"period": "FY2027", "eps_estimate": 7.0, "analysts": 31},
    ]
    assert len(consensus["surprises"]) == 4
    assert consensus["surprises"][0] == {"period": "Q3 2026", "actual": 1.2, "estimate": 1.1, "surprise_pct": 9.09}
    assert consensus["surprises"][1]["period"] == "Q2 2026" and consensus["surprises"][1]["surprise_pct"] == -4.76
    assert consensus["next_earnings"] == {"date": day(25).isoformat(), "timing": "after close"}
    # 7 days: the snapshot of day -7 (not the older decoy at -9); 30 days: day -30 (not -32); 90 days: nothing within a
    # week of day -90 (the nearest is day -85), so a gap is null, never a guess.
    assert consensus["revisions"] == {"d7": 5.0, "d30": 20.0, "d90": None}
    assert body["targets"] == {"low": 150.0, "mean": 190.0, "high": 230.0, "counts": {"buy": 24, "hold": 9, "sell": 2}}
    stamp = body["stamp"]
    assert (stamp["source"], stamp["quality"]) == ("eulerpool", "eod") and stamp["as_of"] is not None
    assert stamp["freshness"] in {"closed", "delayed"}


def test_stored_rows_with_a_feed_that_never_ran_are_stamped_unavailable_not_fresh(
    client: TestClient, db_session: Session
) -> None:
    seed_consensus(db_session)
    stamp = get(client, "/symbols/AAPL").json()["stamp"]
    assert stamp["source"] == "eulerpool" and stamp["freshness"] == "unavailable"


def test_a_revision_needs_a_nonzero_old_estimate(client: TestClient, db_session: Session) -> None:
    db_session.add_all(
        [consensus_row("annual", 100, 0.5, fy=2026), consensus_row("annual", 100, 0.0, snapshot=-7, fy=2026)]
    )
    db_session.commit()
    assert get(client, "/symbols/AAPL").json()["consensus"]["revisions"] == {"d7": None, "d30": None, "d90": None}


@pytest.mark.parametrize("bad", ["%24BAD", "A" * 16, "-AAPL", "A%20B"])
def test_a_malformed_symbol_is_a_422_with_problems(client: TestClient, bad: str) -> None:
    for suffix in ("", "/valuation", "/timeline"):
        response = get(client, f"/symbols/{bad}{suffix}")
        assert response.status_code == 422, (bad, suffix)
        assert response.json()["detail"]["problems"][0]["path"] == "symbol"


def test_the_stub_flag_still_serves_the_invented_world(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(STUB_FLAG, "1")
    research = get(client, "/symbols/AAPL").json()
    assert research["verdict"] is not None and research["stamp"]["source"] == "simulated"
    assert get(client, "/brief").json()["rows"]
    assert get(client, "/symbols/AAPL/valuation").json()["methods"]
    assert get(client, "/symbols/KO/timeline").json()["items"]


# -- valuation -----------------------------------------------------------------------------------------------------


def working_sources(**overrides: Any) -> dict[str, Any]:
    return {
        "fundamentals": FakeFundamentals(),
        "quotes": FakeQuotes(),
        "bars": FakeBars(),
        "earnings_announcements": FakeAnnouncements(),
        **overrides,
    }


def values(body: dict[str, Any]) -> dict[str, Any]:
    return {method["id"]: method["value"] for method in body["methods"]}


def test_valuation_blends_the_four_methods_and_summarizes_the_reaction(client: TestClient, db_session: Session) -> None:
    bars = FakeBars().frames["AAA"]
    # One stored result per announcement, alternating beat and miss, so the reaction splits them.
    db_session.add_all(
        EarningsResult(
            symbol="AAA",
            period_end=bars.index[day_index],
            report_date=bars.index[day_index],
            eps_estimate=1.0,
            eps_actual=1.1 if k % 2 == 0 else 0.9,
            provider="eulerpool",
            quality="eod",
            as_of=NOW,
            captured_at=NOW,
        )
        for k, day_index in enumerate(range(300, 300 + 63 * 8, 63))
    )
    db_session.commit()
    serve(**working_sources())
    response = get(client, "/symbols/AAA/valuation")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["price"] == 100.0
    assert [m["id"] for m in body["methods"]] == METHODS
    per_share = values(body)
    assert all(value is not None and value > 0 for value in per_share.values())
    expected = 0.6 * per_share["dcf"] + 0.4 * (sum(v for k, v in per_share.items() if k != "dcf") / 3)
    assert body["blend"] == pytest.approx(expected, abs=0.01)  # 60% DCF, 40% the mean of the other three (02h §4)
    assert body["filing_as_of"] == (FY_ENDS[0] + timedelta(days=35)).isoformat()
    reaction = body["earnings_reaction"]
    assert reaction["reports"] == 8 and reaction["beats"]["n"] == 4 and reaction["misses"]["n"] == 4
    assert reaction["beats"]["avg_excess_pct"] > 3 > -1 > reaction["misses"]["avg_excess_pct"]
    assert reaction["implied_move_pct"] is None  # the delayed-chain implied move is not built yet
    assert [m["fallbacks"] for m in body["methods"] if m["value"] is not None]  # every default is in words


def test_valuation_without_a_quote_has_a_null_price_and_no_price_based_method(client: TestClient) -> None:
    serve(**working_sources(quotes=FakeQuotes(None)))
    body = get(client, "/symbols/AAA/valuation").json()
    assert body["price"] is None and body["blend"] is None
    per_share = values(body)
    assert per_share["owner_earnings"] is not None
    assert per_share["dcf"] is None and per_share["ev_ebitda"] is None and per_share["residual_income"] is None
    dcf = body["methods"][0]
    assert "Price unavailable: the market value needs it" in dcf["fallbacks"]


def test_a_failed_quote_provider_is_a_null_price_not_a_500(client: TestClient) -> None:
    serve(**working_sources(quotes=FakeQuotes(raises=Unavailable("alpaca", "down"))))
    response = get(client, "/symbols/AAA/valuation")
    assert response.status_code == 200 and response.json()["price"] is None


def test_the_filings_source_failing_leaves_every_method_null_and_says_so(client: TestClient) -> None:
    serve(**working_sources(fundamentals=FakeFundamentals(raises=Unavailable("sec_edgar", "down"))))
    response = get(client, "/symbols/AAA/valuation")
    assert response.status_code == 200
    body = response.json()
    assert set(values(body).values()) == {None} and body["blend"] is None and body["filing_as_of"] is None
    assert [m["fallbacks"] for m in body["methods"]] == [["Filings source unavailable: SEC EDGAR did not answer"]] * 4


def test_a_failed_fetch_is_not_cached_but_a_good_one_is(client: TestClient) -> None:
    serve(**working_sources(fundamentals=FakeFundamentals(raises=Unavailable("sec_edgar", "down"))))
    assert get(client, "/symbols/AAA/valuation").json()["blend"] is None
    working = FakeFundamentals()
    serve(**working_sources(fundamentals=working))
    assert get(client, "/symbols/AAA/valuation").json()["blend"] is not None  # retried: the failure was not kept
    assert get(client, "/symbols/AAA/valuation").json()["blend"] is not None
    assert working.calls == 1  # the second good read came from the cache


def test_a_failed_bars_provider_leaves_the_reaction_and_the_multiple_null_but_not_the_rest(client: TestClient) -> None:
    serve(**working_sources(bars=FakeBars(raises=Unavailable("alpaca", "down"))))
    body = get(client, "/symbols/AAA/valuation").json()
    assert body["earnings_reaction"] is None
    per_share = values(body)
    assert per_share["ev_ebitda"] is None and per_share["dcf"] is not None and per_share["owner_earnings"] is not None


def test_fewer_than_four_announcements_give_no_reaction(client: TestClient) -> None:
    serve(**working_sources(earnings_announcements=FakeAnnouncements(announced(3))))
    assert get(client, "/symbols/AAA/valuation").json()["earnings_reaction"] is None
    serve(**working_sources(earnings_announcements=FakeAnnouncements(announced(4))))
    clear_cache()
    assert get(client, "/symbols/AAA/valuation").json()["earnings_reaction"]["reports"] == 4


# -- timeline ------------------------------------------------------------------------------------------------------


def news(*headlines: str) -> FakeNews:
    return FakeNews(
        [
            NewsItem(
                symbol="AAA",
                headline=headline,
                publisher="Example Wire",
                url=f"https://example.com/{i}",
                published_at=pd.Timestamp(NOW - timedelta(days=i + 1)),
                provider="finnhub",
                quality="delayed-15m",
            )
            for i, headline in enumerate(headlines)
        ]
    )


def seed_timeline(db: Session) -> None:
    """AAA: two reported results, the next report, one change of the current fiscal year's estimate (the unchanged
    snapshot between is no item), one alert of the owner's and one of another user's."""
    owner, other = User(email=OWNER_EMAIL, settings={}), User(email=OTHER_EMAIL, settings={})
    db.add_all([owner, other])
    db.flush()
    db.add_all(
        [
            result_row(-60, 1.20, report=-40, symbol="AAA", fiscal_year=2026, fiscal_quarter=3, surprise_percent=9.09),
            result_row(-150, 1.00, report=-130, symbol="AAA", fiscal_year=2026, fiscal_quarter=2),
            result_row(30, None, report=25, symbol="AAA", report_time="bmo"),
            *(
                ConsensusSnapshot(
                    symbol="AAA",
                    period_kind="annual",
                    period_end=day(100),
                    snapshot_date=day(ago),
                    fiscal_year=2026,
                    eps_mean=eps,
                    provider="eulerpool",
                    quality="eod",
                    as_of=NOW,
                    captured_at=NOW,
                )
                for ago, eps in ((-10, 6.00), (-5, 6.00), (-2, 6.30))
            ),
            Alert(
                user_id=owner.id,
                symbol="AAA",
                kind="signal",
                severity="info",
                title="AAA crossed above its 20-day high",
                body="Daily close.",
                created_at=NOW - timedelta(days=3),
            ),
            Alert(
                user_id=other.id,
                symbol="AAA",
                kind="signal",
                severity="info",
                title="Someone else's alert",
                body="Not the owner's.",
                created_at=NOW - timedelta(days=3),
            ),
        ]
    )
    db.commit()


def timeline_sources() -> dict[str, Any]:
    return {"earnings_announcements": FakeAnnouncements(announced(2)), "news": news("Headline one", "Headline two")}


def test_the_timeline_is_newest_first_across_every_kind_and_never_has_desk_ai_or_macro(
    client: TestClient, db_session: Session
) -> None:
    seed_timeline(db_session)
    serve(**timeline_sources())
    body = get(client, "/symbols/AAA/timeline").json()
    assert body["total"] == 9  # 3 earnings, 1 consensus, 2 filings, 2 news, 1 alert (the other user's is not his)
    times = [datetime.fromisoformat(item["at"].replace("Z", "+00:00")) for item in body["items"]]
    assert times == sorted(times, reverse=True)
    assert (
        body["items"][0]["title"] == "Reports earnings"
        and body["items"][0]["detail"] == "Before open · EPS estimate 1.10"
    )
    assert {item["kind"] for item in body["items"]} == {"earnings", "consensus", "filing", "news", "strategy"}
    titles = [item["title"] for item in body["items"]]
    assert "Reported Q3 2026: EPS 1.20 vs 1.10 estimate" in titles
    assert "FY2026 EPS estimate 6.00 to 6.30" in titles and "Someone else's alert" not in titles
    by_kind = {item["kind"]: item for item in body["items"]}
    assert by_kind["news"]["href"].startswith("https://example.com/") and by_kind["filing"]["href"] is None
    assert by_kind["consensus"]["detail"] == f"+5.0% since {day(-5).isoformat()}"


def test_the_kind_filter_narrows_the_list_and_the_total_and_only_asks_that_kinds_provider(
    client: TestClient, db_session: Session
) -> None:
    seed_timeline(db_session)
    serve()  # no provider at all: any kind that reached for one would fail the request
    earnings = get(client, "/symbols/AAA/timeline?kind=earnings").json()
    assert earnings["total"] == 3 and {item["kind"] for item in earnings["items"]} == {"earnings"}
    assert get(client, "/symbols/AAA/timeline?kind=consensus").json()["total"] == 1
    assert get(client, "/symbols/AAA/timeline?kind=strategy").json()["total"] == 1
    for unbuilt in ("desk_ai", "macro"):
        assert get(client, f"/symbols/AAA/timeline?kind={unbuilt}").json() == {"items": [], "total": 0}
    assert get(client, "/symbols/AAA/timeline?kind=bogus").status_code == 422


def test_timeline_pages_concatenate_to_the_whole_list(client: TestClient, db_session: Session) -> None:
    seed_timeline(db_session)
    serve(**timeline_sources())
    whole = get(client, "/symbols/AAA/timeline").json()["items"]
    pages = [get(client, f"/symbols/AAA/timeline?limit=4&offset={offset}").json() for offset in (0, 4, 8)]
    assert [page["total"] for page in pages] == [9, 9, 9]
    assert [len(page["items"]) for page in pages] == [4, 4, 1]
    assert [item for page in pages for item in page["items"]] == whole
    assert get(client, "/symbols/AAA/timeline?limit=0").status_code == 422
    assert get(client, "/symbols/AAA/timeline?offset=-1").status_code == 422


def test_a_failing_news_or_filings_provider_drops_its_kind_not_the_request(
    client: TestClient, db_session: Session
) -> None:
    seed_timeline(db_session)
    serve(
        earnings_announcements=FakeAnnouncements(raises=Unavailable("sec_edgar", "down")),
        news=FakeNews(raises=Unavailable("finnhub", "down")),
    )
    body = get(client, "/symbols/AAA/timeline").json()
    assert body["total"] == 5 and {item["kind"] for item in body["items"]} == {"earnings", "consensus", "strategy"}
