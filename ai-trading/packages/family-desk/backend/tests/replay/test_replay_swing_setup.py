"""The swing setup half end to end on the synthetic swing world (`tests/swing_world.py`, 02p): the world's scripted
events, the universe preview (fill order, cap, remove, the daily-only filter rule, excluded symbols, floor warnings,
as-of metrics, budget and pending), the pool prep, swing thread creation (rows, the one-active-thread rule, coverage,
arms, days), the day and swing plans side by side, and the swing thread prep. Real Postgres (`scripts/test-db.sh`); the
history is in memory, no network."""

import dataclasses
from datetime import date

import pytest
from ai_trading_common.errors import ProviderError
from daily_world import SyntheticBars, make_thread
from sqlalchemy import func, select
from swing_world import (
    BENCHMARK,
    DAYS,
    FIRST_DAY,
    GAP_DOWN_DAY,
    GAP_UP_DAY,
    HISTORY,
    NOW,
    SOURCES,
    SPLIT_DAY,
    SYMBOLS,
    VOLUME,
    create_swing_thread,
    make_owner,
    scrambled,
    swing_create,
    swing_services,
    swing_setup,
    swing_world,
)

from ai_trading.contracts.practice_thread import PracticeThreadCreateV1
from ai_trading.core.calendar import previous_session
from ai_trading.db.models import (
    FilterStrategy,
    PracticePlan,
    PracticeThread,
    Strategy,
    Watchlist,
    WatchlistItem,
)
from ai_trading.replay import plan as plan_mod
from ai_trading.replay import prep as prep_mod
from ai_trading.replay import screen, swing
from ai_trading.replay import threads as threads_mod
from ai_trading.replay.cache import BlobKey, DbBlobStore
from ai_trading.replay.session import ReplayProblem
from ai_trading.screener import service as filter_service

BASIS_DAY = previous_session("stock", FIRST_DAY)
RANGE = DAYS[:15]  # the days of a 15-session thread


@pytest.fixture
def world() -> SyntheticBars:
    return swing_world()


@pytest.fixture
def svc(world):
    return swing_services(world)


@pytest.fixture
def owner(db_session) -> int:
    return make_owner(db_session)


@pytest.fixture(autouse=True)
def pool(monkeypatch):
    """The Desk set of these tests is the twelve synthetic stocks (the real one adds the seed symbols)."""
    monkeypatch.setattr(plan_mod, "practice_universe", lambda db, user_id: (list(SYMBOLS), False))


def _request(**changes) -> swing.PreviewRequest:
    return swing.PreviewRequest(**{"first_day": FIRST_DAY, "sessions": 15, "target": 10, **changes})


def _watchlist(db, user_id: int, name: str, symbols: list[str]) -> int:
    row = Watchlist(user_id=user_id, name=name, horizon="swing")
    db.add(row)
    db.flush()
    for position, symbol in enumerate(symbols):
        db.add(WatchlistItem(watchlist_id=row.id, symbol=symbol, asset_type="stock", position=position))
    db.commit()
    return row.id


def _filter(db, user_id: int, name: str = "Price above 85", above: float = 85, run_on: str = "daily_close") -> int:
    spec = {
        "schemaVersion": 1,
        "name": name,
        "watch": {"universe": {"market": "us_equities"}, "session": "regular", "runOn": run_on},
        "liquidity": {"minPrice": 5, "minAvgVolume": 500_000},
        "when": {"op": "gt", "left": {"series": "close"}, "right": {"value": above}},
        "rank": {"by": {"series": "close"}, "order": "desc"},
        "maxResults": 50,
    }
    view = filter_service.create_from_spec(db, user_id, spec, now=NOW)
    db.commit()
    return view.row.id


def _seed_filter(db, user_id: int, name: str) -> int:
    return db.execute(
        select(FilterStrategy.id).where(FilterStrategy.owner_user_id == user_id, FilterStrategy.name == name)
    ).scalar_one()


def _hole(world: SyntheticBars, symbol: str, day: date) -> None:
    """The symbol has no bar on `day` (a halt, a listing gap): dropped from the raw and the split series."""
    world.raw[symbol] = world.raw[symbol].drop(index=day)
    world.split[symbol] = world.split[symbol].drop(index=day)


def _symbols(result: swing.PreviewResult, source: str | None = None) -> list[str]:
    return [r["symbol"] for r in result.body["rows"] if source is None or r["source"] == source]


def _dollar_rank(world: SyntheticBars, among: list[str]) -> list[str]:
    """`among` by 20-day average dollar volume at the basis close, from the raw bars (how the table must rank)."""
    window = [d for d in HISTORY if d < FIRST_DAY][-20:]

    def value(symbol: str) -> float:
        frame = world.raw[symbol].loc[window]
        return float((frame["close"] * frame["volume"]).mean())

    return sorted(among, key=lambda s: (-value(s), s))


# -- the world ---------------------------------------------------------------------------------------------


def test_the_scripted_events_are_in_the_world(world) -> None:
    assert (DAYS[0], DAYS[-1]) == (date(2026, 9, 14), date(2026, 10, 9)) and len(DAYS) == 20
    assert (GAP_UP_DAY, SPLIT_DAY, GAP_DOWN_DAY) == (DAYS[3], DAYS[5], DAYS[6])
    raw, split = world.raw, world.split
    up = raw["S01"].loc[GAP_UP_DAY, "open"] / raw["S01"].loc[DAYS[2], "close"]
    down = raw["S02"].loc[GAP_DOWN_DAY, "open"] / raw["S02"].loc[DAYS[5], "close"]
    assert round(up, 4) == 1.06 and round(down, 4) == 0.92
    # the split: raw closes halve from session 6, the adjusted series does not move, its volume doubles before it
    assert round(raw["S03"].loc[DAYS[4], "close"] / raw["S03"].loc[SPLIT_DAY, "close"], 1) == 2.0
    assert abs(split["S03"].loc[DAYS[4], "close"] / split["S03"].loc[SPLIT_DAY, "close"] - 1) < 0.01
    assert split["S03"].loc[DAYS[4], "volume"] == 2 * split["S03"].loc[SPLIT_DAY, "volume"]
    assert raw["S03"].loc[DAYS[4], "volume"] == raw["S03"].loc[SPLIT_DAY, "volume"]
    # the trends are exactly 1% a day
    steps = raw["S04"]["close"].loc[DAYS[0] :].pct_change().dropna().round(4)
    assert set(steps) == {0.01} and set(raw["S05"]["close"].loc[DAYS[0] :].pct_change().dropna().round(4)) == {-0.01}
    assert len(HISTORY) >= 120 and BENCHMARK in raw and BENCHMARK not in world.minutes


def test_the_gap_is_at_the_regular_open_and_the_premarket_sits_at_the_prior_close(world) -> None:
    minutes = world.minutes["S01"]
    gap_day = minutes[[ts.tz_convert("America/New_York").date() == GAP_UP_DAY for ts in minutes.index]]
    premarket, regular = gap_day.iloc[0]["close"], gap_day.iloc[330]["close"]  # 04:00 and 09:30
    assert round(regular / premarket, 4) == 1.06
    assert len(gap_day) == 960


def test_swing_setup_is_a_valid_contract_block_and_overrides_apply() -> None:
    create = swing_create(sessions=20, maxOpenHolds=2)
    assert create.swing is not None and (create.swing.sessions, create.swing.maxOpenHolds) == (20, 2)
    assert [e.symbol for e in create.swing.universe] == SYMBOLS
    assert {e.symbol: e.source for e in create.swing.universe} == SOURCES


# -- asof_frames with a split frame ----------------------------------------------------------------------


def test_asof_frames_given_a_split_frame_asks_for_the_raw_dailies_only(world, svc) -> None:
    store = svc.store_factory(None)
    split = swing.split_frame(svc.history, store, "S03", FIRST_DAY, DAYS[-1])
    asked = len(world.calls)
    given = screen.asof_frames(svc.history, store, "S03", RANGE, split=split)
    assert world.calls[asked:] == [("S03", "1d", "raw")]  # the split request is saved
    other = swing_services(swing_world())
    assert all(
        given[d].equals(frame)
        for d, frame in screen.asof_frames(other.history, other.store_factory(None), "S03", RANGE).items()
    )


def test_the_split_frame_is_fetched_and_stored_once_through_the_last_day(world, svc) -> None:
    store = svc.store_factory(None)
    first = swing.split_frame(svc.history, store, "S01", FIRST_DAY, DAYS[-1])
    again = swing.split_frame(svc.history, store, "S01", FIRST_DAY, DAYS[-1])
    assert world.calls.count(("S01", "1d", "split")) == 1 and first.equals(again)
    assert BlobKey("bars1d", "S01", DAYS[-1], "swingsplit", "sip") in store.blobs
    assert first.index[-1] == DAYS[-1]
    empty = swing.split_frame(svc.history, store, "NOSUCH", FIRST_DAY, DAYS[-1])  # a symbol without data
    swing.split_frame(svc.history, store, "NOSUCH", FIRST_DAY, DAYS[-1])
    assert empty.empty and world.calls.count(("NOSUCH", "1d", "split")) == 1


def test_a_symbol_a_day_plan_cached_still_lacks_the_swing_split_frame(world, svc) -> None:
    store = svc.store_factory(None)
    days = plan_mod.plan_days(FIRST_DAY, 15)
    screen.asof_frames(svc.history, store, "S01", days)  # what a daily-list plan stores
    assert swing.is_cached(store, "S01", days) is False  # the swing split frame is not there yet
    swing.universe_frames(svc.history, store, "S01", days)
    assert swing.is_cached(store, "S01", days) is True and swing.is_cached(store, "S01", days[:-1]) is False


# -- the preview ---------------------------------------------------------------------------------------


def test_a_plain_preview_fills_by_liquidity_and_every_figure_is_as_of_the_basis_close(
    db_session, owner, world, svc
) -> None:
    result = swing.preview(db_session, owner, _request(), svc)
    body = result.body
    assert (body["basis_day"], body["state"], result.pending) == (BASIS_DAY.isoformat(), "ready", [])
    assert _symbols(result) == _dollar_rank(world, SYMBOLS)[:10]
    assert {row["source"] for row in body["rows"]} == {"liquidity"} and body["excluded"] == []
    assert body["counts"] == {"watchlist": 0, "manual": 0, "filter": 0, "liquidity": 10, "total": 10}
    assert body["prep"] == {"done": 12, "total": 12}
    assert body["survivorship"].startswith("Fixed universe · 10 symbols chosen today from the symbols the Desk tracks")
    assert "survivors" in body["survivorship"] and "moves you already know about" in body["survivorship"]
    by_symbol = {row["symbol"]: row for row in body["rows"]}
    s04 = by_symbol["S04"]  # flat until the scripted window, so the basis close is its base price
    assert (s04["prior_close"], s04["chg_20d_pct"], s04["avg_dollar_volume_20d"]) == (
        80.0,
        0.0,
        round(80 * VOLUME["S04"]),
    )
    assert s04["atr_pct_14"] is not None and s04["matched"] == [] and s04["warnings"] == []
    s01 = by_symbol["S01"]
    assert s01["prior_close"] == round(world.raw["S01"].loc[BASIS_DAY, "close"], 4)
    # the split-ratio symbol is shown on the day's own (raw) share basis
    assert by_symbol["S03"]["prior_close"] == round(world.raw["S03"].loc[BASIS_DAY, "close"], 4)


def test_the_preview_writes_nothing_but_the_blob_cache(db_session, owner, svc) -> None:
    swing.preview(db_session, owner, _request(), svc)
    for model in (PracticePlan, PracticeThread):
        assert db_session.scalar(select(func.count()).select_from(model)) == 0


def test_fill_order_is_watchlists_then_manual_then_filter_then_liquidity_duplicates_once_and_capped(
    db_session, owner, world, svc
) -> None:
    lists = [_watchlist(db_session, owner, "Swing seed", ["S12", "S11", "S05"])]
    filters = [_filter(db_session, owner)]  # close above 85: S05, S01, S03 and S02 at the basis close
    request = _request(watchlist_ids=lists, filter_ids=filters, add=["s09", "S12", " S10 "], target=10)
    result = swing.preview(db_session, owner, request, svc)
    rows = {r["symbol"]: r for r in result.body["rows"]}
    assert _symbols(result, "watchlist") == ["S12", "S11", "S05"]  # S05 matches the filter too: listed once, as hers
    assert _symbols(result, "manual") == ["S09", "S10"]  # normalised, and S12 (already on the list) not repeated
    matches = _symbols(result, "filter")
    assert sorted(matches) == ["S01", "S02", "S03"]
    assert matches == sorted(matches, key=lambda s: -rows[s]["prior_close"])  # in filter-rank order (close, high first)
    taken = {*_symbols(result, "watchlist"), *_symbols(result, "manual"), *matches}
    assert _symbols(result, "liquidity") == [s for s in _dollar_rank(world, SYMBOLS) if s not in taken][:2]
    assert len(result.body["rows"]) == 10 and result.body["counts"]["total"] == 10  # the target caps it
    assert rows["S05"]["matched"] == ["Price above 85"] and rows["S01"]["matched"] == ["Price above 85"]
    assert rows["S12"]["matched"] == [] and len(set(_symbols(result))) == 10
    # the order of the table is the fill order
    sources = [r["source"] for r in result.body["rows"]]
    assert sources == sorted(sources, key=["watchlist", "manual", "filter", "liquidity"].index)


def test_a_fill_that_is_off_does_not_pad_and_a_smaller_target_stops_early(db_session, owner, svc) -> None:
    lists = [_watchlist(db_session, owner, "Swing seed", ["S12", "S11", "S05"])]
    result = swing.preview(db_session, owner, _request(watchlist_ids=lists, fill="none"), svc)
    assert _symbols(result) == ["S12", "S11", "S05"] and result.body["counts"]["total"] == 3
    assert result.body["prep"] == {"done": 3, "total": 3}  # the pool is not needed, so it is not fetched
    capped = swing.preview(db_session, owner, _request(add=[f"S{n:02d}" for n in range(1, 13)], target=10), svc)
    assert _symbols(capped) == [f"S{n:02d}" for n in range(1, 11)]


def test_remove_drops_a_symbol_from_every_source_and_the_fill_backfills(db_session, owner, world, svc) -> None:
    lists = [_watchlist(db_session, owner, "Swing seed", ["S12", "S11"])]
    top = _dollar_rank(world, SYMBOLS)[0]
    swing.preview(db_session, owner, _request(watchlist_ids=lists), svc)  # everything is cached by now
    request = _request(watchlist_ids=lists, remove=["s12", top])
    result = swing.preview(db_session, owner, request, svc)
    assert "S12" not in _symbols(result) and top not in _symbols(result)
    assert len(result.body["rows"]) == 10 and _symbols(result, "watchlist") == ["S11"]
    assert result.body["excluded"] == []
    # a symbol she removed is not even fetched
    fresh_world = swing_world()
    swing.preview(db_session, owner, request, swing_services(fresh_world))
    assert {call[0] for call in fresh_world.calls}.isdisjoint({"S12", top})


def test_an_intraday_filter_is_the_daily_only_problem(db_session, owner, svc) -> None:
    gap_up = _seed_filter(db_session, owner, "Gap up")  # runs at the premarket
    with pytest.raises(ReplayProblem) as caught:
        swing.preview(db_session, owner, _request(filter_ids=[_filter(db_session, owner), gap_up]), svc)
    assert (caught.value.message, caught.value.path, caught.value.status) == (swing.DAILY_ONLY, "filter_ids.1", 422)
    assert swing.DAILY_ONLY == "Use a daily filter for a swing thread"


def test_lists_and_filters_that_are_not_hers_or_do_not_exist_are_plain_problems(db_session, owner, svc) -> None:
    other = make_owner(db_session, "spouse@example.com")
    theirs = _watchlist(db_session, other, "Theirs", ["S01"])
    for kwargs, path, message in (
        ({"watchlist_ids": [theirs]}, "watchlist_ids.0", "Watchlist not found"),
        ({"watchlist_ids": [999_999]}, "watchlist_ids.0", "Watchlist not found"),
        ({"filter_ids": [_filter(db_session, other, "Theirs")]}, "filter_ids.0", "Filter not found"),
        ({"filter_ids": [999_999]}, "filter_ids.0", "Filter not found"),
        ({"add": ["S01", "not a symbol"]}, "add.1", "NOT A SYMBOL is not a stock symbol"),
    ):
        with pytest.raises(ReplayProblem) as caught:
            swing.preview(db_session, owner, _request(**kwargs), svc)
        assert (caught.value.path, caught.value.message) == (path, message)


@pytest.mark.parametrize(
    ("changes", "path", "message"),
    [
        ({"first_day": date(2016, 12, 30)}, "first_day", "Daily lists start on Jan 3, 2017 · pick a later day"),
        ({"first_day": date(2026, 9, 12)}, "first_day", "No trading on Sat 2026-09-12 · pick a weekday"),
        (
            {"first_day": date(2026, 10, 20)},
            "first_day",
            "15 sessions from Tue 2026-10-20 run past the last finished day · pick an earlier start",
        ),
        ({"sessions": 14}, "sessions", "A swing thread runs 15 to 23 sessions"),
        ({"target": 9}, "target", "The target size is 10 to 50 symbols"),
        ({"target": 51}, "target", "The target size is 10 to 50 symbols"),
        ({"filter_ids": [1, 2, 3, 4]}, "filter_ids", "Pick at most 3 filters"),
        ({"fill": "all"}, "fill", "Fill by liquidity or not at all"),
    ],
)
def test_preview_validates_the_days_and_the_request_with_the_plan_sentences(
    db_session, owner, svc, changes, path, message
) -> None:
    with pytest.raises(ReplayProblem) as caught:
        swing.preview(db_session, owner, _request(**changes), svc)
    assert (caught.value.path, caught.value.message) == (path, message)


def test_a_symbol_with_a_hole_in_its_history_is_excluded_with_a_neutral_reason_and_the_fill_backfills(
    db_session, owner, world, svc
) -> None:
    _hole(world, "S06", DAYS[8])  # inside the 15 sessions
    lists = [_watchlist(db_session, owner, "Swing seed", ["S06", "S07"])]
    result = swing.preview(db_session, owner, _request(watchlist_ids=lists, add=["ZZZZ"]), svc)
    assert result.body["excluded"] == [
        {"symbol": "S06", "reason": swing.EXCLUDED_REASON},
        {"symbol": "ZZZZ", "reason": swing.EXCLUDED_REASON},
    ]
    assert swing.EXCLUDED_REASON == "Not enough price history for this whole range"
    assert "S06" not in _symbols(result) and "ZZZZ" not in _symbols(result) and _symbols(result)[0] == "S07"
    assert len(result.body["rows"]) == 10  # S06 took no slot: the liquidity fill reached further
    assert not any(ch.isdigit() for item in result.body["excluded"] for ch in item["reason"])  # no date, no event
    # a symbol that listed one session before Day 1 has too short a history for any of it
    short = swing_world()
    for frames in (short.raw, short.split):
        frames["S07"] = frames["S07"].loc[BASIS_DAY:]
    listed = swing.preview(db_session, owner, _request(watchlist_ids=lists), swing_services(short))
    assert listed.body["excluded"] == [{"symbol": "S07", "reason": swing.EXCLUDED_REASON}]
    # a hole AFTER the thread's range does not matter: only the sessions she will walk are checked
    later = swing_world()
    _hole(later, "S06", DAYS[17])
    again = swing.preview(db_session, owner, _request(watchlist_ids=lists), swing_services(later))
    assert again.body["excluded"] == [] and _symbols(again, "watchlist") == ["S06", "S07"]


def test_a_floor_failer_is_warned_on_her_own_pick_and_never_filled(db_session, owner, world, svc) -> None:
    for frames in (world.raw, world.split):
        frames["S12"] = frames["S12"].assign(volume=100_000.0)  # under the 500,000-share floor
    lists = [_watchlist(db_session, owner, "Swing seed", ["S12"])]
    mine = swing.preview(db_session, owner, _request(watchlist_ids=lists), svc)
    row = next(r for r in mine.body["rows"] if r["symbol"] == "S12")
    assert row["source"] == "watchlist" and row["warnings"] == ["below floor"]
    assert all(r["warnings"] == [] for r in mine.body["rows"] if r["symbol"] != "S12")
    fill = swing.preview(db_session, owner, _request(target=12), svc)
    assert "S12" not in _symbols(fill) and len(fill.body["rows"]) == 11  # never padded with a floor failer


def test_the_rows_are_identical_when_every_bar_after_the_basis_close_is_replaced(db_session, owner, world) -> None:
    lists = [_watchlist(db_session, owner, "Swing seed", ["S12", "S03", "S01"])]
    request = _request(watchlist_ids=lists, filter_ids=[_filter(db_session, owner)], add=["S09"], target=11)
    real = swing.preview(db_session, owner, request, swing_services(world))
    garbage = swing.preview(db_session, owner, request, swing_services(scrambled(world, BASIS_DAY)))
    assert real.body == garbage.body and len(real.body["rows"]) == 11


def test_the_picks_she_made_are_the_same_before_and_after_the_pool_is_prepared(
    db_session, owner, world, svc, monkeypatch
) -> None:
    lists = [_watchlist(db_session, owner, "Swing seed", ["S12", "S11"])]
    request = _request(watchlist_ids=lists, add=["S09"])
    days = plan_mod.plan_days(FIRST_DAY, 15)
    swing.pool_prep(db_session, svc, owner, request, ["S12", "S11", "S09"])  # only her own picks are ready
    monkeypatch.setattr(swing, "PREVIEW_BUDGET_S", 0.0)
    early = swing.preview(db_session, owner, request, svc)
    assert early.body["state"] == "preparing" and _symbols(early) == ["S12", "S11", "S09"]
    assert early.body["prep"] == {"done": 3, "total": 12} and early.pending == [
        s for s in SYMBOLS if s not in {"S12", "S11", "S09"}
    ]
    assert swing.pool_prep(db_session, svc, owner, request, early.pending) == {}
    monkeypatch.setattr(swing, "PREVIEW_BUDGET_S", 8.0)
    fetched = len(world.calls)
    done = swing.preview(db_session, owner, request, svc)
    assert len(world.calls) == fetched  # nothing left to fetch
    assert done.body["state"] == "ready" and done.pending == [] and done.body["prep"] == {"done": 12, "total": 12}
    assert done.body["rows"][:3] == early.body["rows"]  # her picks: the same rows, in the same places
    assert all(swing.is_cached(svc.store_factory(db_session), s, days) for s in SYMBOLS)


def test_an_exhausted_budget_is_preparing_with_the_pending_list_in_priority_order_and_a_second_call_finishes(
    db_session, owner, svc, monkeypatch
) -> None:
    lists = [_watchlist(db_session, owner, "Swing seed", ["S12", "S11"])]
    request = _request(watchlist_ids=lists, add=["S09", "S11"])
    monkeypatch.setattr(swing, "PREVIEW_BUDGET_S", 0.0)
    first = swing.preview(db_session, owner, request, svc)
    assert first.body["state"] == "preparing" and first.body["rows"] == [] and first.body["counts"]["total"] == 0
    assert first.body["prep"] == {"done": 0, "total": 12}
    # her lists first, then her adds, then the rest of the pool in its order
    assert first.pending == ["S12", "S11", "S09", "S01", "S02", "S03", "S04", "S05", "S06", "S07", "S08", "S10"]
    monkeypatch.setattr(swing, "PREVIEW_BUDGET_S", 8.0)
    second = swing.preview(db_session, owner, request, svc)
    assert second.body["state"] == "ready" and second.pending == [] and len(second.body["rows"]) == 10


def test_pool_prep_commits_each_symbol_and_rolls_back_the_half_done_one(db_session, owner, world) -> None:
    class Flaky(SyntheticBars):
        def bars(self, symbol, timeframe, start, end, *, now, adjustment="all"):
            if symbol == "S07" and adjustment == "raw":  # the split request goes through, the raw one fails
                raise ProviderError("synthetic", "boom")
            return super().bars(symbol, timeframe, start, end, now=now, adjustment=adjustment)

    svc = dataclasses.replace(swing_services(Flaky(world.raw, world.split, world.minutes)), store_factory=DbBlobStore)
    days = plan_mod.plan_days(FIRST_DAY, 15)
    assert swing.pool_prep(db_session, svc, owner, _request(), ["S06", "S07", "S08"]) == {"S07": "ProviderError"}
    db_session.rollback()  # whatever was not committed is gone
    store = DbBlobStore(db_session)
    assert swing.is_cached(store, "S06", days) and swing.is_cached(store, "S08", days)
    assert store.get(BlobKey("bars1d", "S07", days[-1], "swingsplit", "sip")) is None  # S07's half is not kept


def test_pool_prep_commits_per_symbol_and_one_failing_symbol_never_stops_the_rest(db_session, owner, world) -> None:
    class Flaky(SyntheticBars):
        def bars(self, symbol, timeframe, start, end, *, now, adjustment="all"):
            if symbol == "S07":
                raise ProviderError("synthetic", "boom")
            return super().bars(symbol, timeframe, start, end, now=now, adjustment=adjustment)

    flaky = Flaky(world.raw, world.split, world.minutes)
    svc = swing_services(flaky)
    failed = swing.pool_prep(db_session, svc, owner, _request(), SYMBOLS)
    assert failed == {"S07": "ProviderError"}
    days = plan_mod.plan_days(FIRST_DAY, 15)
    store = svc.store_factory(db_session)
    assert [s for s in SYMBOLS if swing.is_cached(store, s, days)] == [s for s in SYMBOLS if s != "S07"]
    # a symbol the provider keeps refusing stays pending in the preview: it is never "excluded" for an outage
    result = swing.preview(db_session, owner, _request(), svc)
    assert result.pending == ["S07"] and result.body["state"] == "preparing" and "S07" not in _symbols(result)


# -- creating a swing thread ---------------------------------------------------------------------------------


def test_create_writes_the_thread_and_one_plan_with_the_universe_frozen_in_order(db_session, owner, svc) -> None:
    thread, plan = create_swing_thread(
        db_session, owner, svc, balance=80_000, plan={"stopNoteOnEntry": "yes", "maxTrades": 4}
    )
    assert (thread.mode, thread.status, int(thread.starting_balance), thread.stop_note_on_entry) == (
        "swing",
        "active",
        80_000,
        "yes",
    )
    assert (thread.max_trades, thread.max_loss_usd) == (4, None)
    assert threads_mod.active_thread(db_session, owner, "swing").id == thread.id
    assert threads_mod.active_thread(db_session, owner, "day") is None
    assert (plan.thread_id, plan.owner_user_id, plan.status, plan.first_day) == (thread.id, owner, "active", FIRST_DAY)
    assert plan.spec == {**swing_setup(), "mode": "swing"}
    assert plan.universe["source"] == "swing"
    assert plan.universe["symbols"] == [{"symbol": s, "source": SOURCES[s]} for s in SYMBOLS]
    assert plan.universe["basis_day"] == BASIS_DAY.isoformat() and plan.universe["frozen_at"] == NOW.isoformat()
    assert plan.prep == {"state": "running", "done": 0, "total": 13, "failed": {}, "updated_at": NOW.isoformat()}
    assert (plan.day_cursor, plan.days_opened, plan.schema_version) == (None, 0, 1)
    assert db_session.scalar(select(func.count()).select_from(PracticePlan)) == 1  # ONE plan row
    # the coverage check stored every symbol's data for the whole range: thread prep and the board read it
    store = svc.store_factory(db_session)
    assert all(swing.is_cached(store, s, plan_mod.plan_days(FIRST_DAY, 15)) for s in SYMBOLS)


def test_risk_per_hold_is_kept_and_an_absent_one_stays_absent(db_session, owner, svc) -> None:
    _, plan = create_swing_thread(db_session, owner, svc, riskPerHoldUsd=250)
    assert plan.spec["riskPerHoldUsd"] == 250
    other = make_owner(db_session, "spouse@example.com")
    _, bare = create_swing_thread(db_session, other, svc)
    assert "riskPerHoldUsd" not in bare.spec


def test_one_active_swing_thread_per_owner_but_a_day_thread_can_run_beside_it(db_session, owner, svc) -> None:
    day = make_thread(db_session, owner)
    swing_thread, _ = create_swing_thread(db_session, owner, svc)
    assert {t.mode for t in db_session.scalars(select(PracticeThread)).all()} == {"day", "swing"}
    with pytest.raises(ReplayProblem) as second:
        swing.create_thread(db_session, owner, swing_create(), svc)
    assert (second.value.status, second.value.path) == (409, "mode")
    assert second.value.message == "You already have an active swing thread · close it before starting another"
    threads_mod.close_thread(db_session, owner, swing_thread.id, NOW)
    db_session.commit()
    again, _ = create_swing_thread(db_session, owner, svc)  # closing the first frees the slot
    assert again.id != swing_thread.id and threads_mod.active_thread(db_session, owner, "day").id == day.id


def test_a_day_thread_can_be_created_while_a_swing_thread_is_active(db_session, owner, svc) -> None:
    swing_thread, _ = create_swing_thread(db_session, owner, svc)
    day = make_thread(db_session, owner)
    assert day.mode == "day" and swing_thread.mode == "swing"


def test_the_day_path_still_refuses_a_swing_create(db_session, owner) -> None:
    with pytest.raises(ReplayProblem) as caught:
        threads_mod.create_thread(db_session, owner, swing_create(), NOW)
    assert (caught.value.status, caught.value.path, caught.value.message) == (422, "mode", threads_mod.SWING_CLOSED)
    with pytest.raises(ReplayProblem):
        swing.create_thread(db_session, owner, _day_create(), swing_services())


def _day_create() -> PracticeThreadCreateV1:
    return PracticeThreadCreateV1.model_validate(
        {"schemaVersion": 1, "mode": "day", "plan": {"stopNoteOnEntry": "no", "tradeOnlyOnSignal": "no"}}
    )


def test_a_symbol_without_data_for_the_whole_range_is_a_422_that_names_it_and_writes_nothing(
    db_session, owner, world
) -> None:
    _hole(world, "S06", DAYS[8])
    with pytest.raises(ReplayProblem) as caught:
        create_swing_thread(db_session, owner, swing_services(world))
    assert caught.value.message == "S06 has not enough price history for this whole range"
    assert (caught.value.path, caught.value.status) == ("swing.universe.5.symbol", 422)
    db_session.rollback()
    assert db_session.scalar(select(func.count()).select_from(PracticeThread)) == 0
    assert db_session.scalar(select(func.count()).select_from(PracticePlan)) == 0
    # a symbol the provider does not know at all
    universe = [{"symbol": s, "source": "manual"} for s in ("NOSUCH", *SYMBOLS[:9])]
    with pytest.raises(ReplayProblem) as unknown:
        create_swing_thread(db_session, owner, swing_services(), universe=universe)
    assert unknown.value.message == "NOSUCH has not enough price history for this whole range"
    assert unknown.value.path == "swing.universe.0.symbol"


@pytest.mark.parametrize(
    ("changes", "path", "message"),
    [
        ({"firstDay": "2016-12-30"}, "swing.firstDay", "Daily lists start on Jan 3, 2017 · pick a later day"),
        ({"firstDay": "2026-09-12"}, "swing.firstDay", "No trading on Sat 2026-09-12 · pick a weekday"),
        (
            {"firstDay": "2026-10-20"},
            "swing.firstDay",
            "15 sessions from Tue 2026-10-20 run past the last finished day · pick an earlier start",
        ),
    ],
)
def test_create_validates_the_days_with_the_plan_sentences(db_session, owner, svc, changes, path, message) -> None:
    with pytest.raises(ReplayProblem) as caught:
        create_swing_thread(db_session, owner, svc, **changes)
    assert (caught.value.path, caught.value.message) == (path, message)


def test_a_max_loss_above_the_balance_is_refused_like_a_day_thread(db_session, owner, svc) -> None:
    with pytest.raises(ReplayProblem) as caught:
        create_swing_thread(db_session, owner, svc, balance=1000, plan={"maxLossUsd": 2000})
    assert caught.value.path == "plan.maxLossUsd"


def test_armed_filters_must_be_daily_and_hers_and_alert_strategies_must_run(db_session, owner, svc) -> None:
    daily = _filter(db_session, owner)
    intraday = _seed_filter(db_session, owner, "Gap up")
    other = make_owner(db_session, "spouse@example.com")
    theirs = _filter(db_session, other, "Theirs")
    strategy = db_session.execute(select(Strategy.id).where(Strategy.owner_user_id == owner)).scalars().first()
    assert strategy is not None
    for armed, path, message in (
        (
            [{"id": daily, "source": "filter"}, {"id": intraday, "source": "filter"}],
            "swing.armed.1.id",
            swing.DAILY_ONLY,
        ),
        ([{"id": theirs, "source": "filter"}], "swing.armed.0.id", "Filter not found"),
        ([{"id": 999_999, "source": "filter"}], "swing.armed.0.id", "Filter not found"),
        ([{"id": 999_999, "source": "alert_strategy"}], "swing.armed.0.id", "Strategy not found"),
    ):
        with pytest.raises(ReplayProblem) as caught:
            create_swing_thread(db_session, owner, svc, armed=armed)
        assert (caught.value.path, caught.value.message) == (path, message)
    db_session.rollback()
    armed = [{"id": daily, "source": "filter"}, {"id": strategy, "source": "alert_strategy"}]
    _, plan = create_swing_thread(db_session, owner, svc, armed=armed)
    assert plan.spec["armed"] == armed


# -- the day plan and the swing plan side by side --------------------------------------------------------------


def test_each_thread_has_its_own_active_plan_and_the_day_list_hub_sees_only_the_day_one(db_session, owner, svc) -> None:
    from test_replay_plan import _block

    day_thread = make_thread(db_session, owner)
    day_plan = plan_mod.create_plan(db_session, owner, _block(db_session, owner), svc, day_thread)
    swing_thread, swing_plan = create_swing_thread(db_session, owner, svc)
    assert plan_mod.active_plan(db_session, owner).id == day_plan.id  # the default is her DAY plan
    assert plan_mod.active_plan(db_session, owner, thread_id=day_thread.id).id == day_plan.id
    assert plan_mod.active_plan(db_session, owner, thread_id=swing_thread.id).id == swing_plan.id
    assert plan_mod.active_plan(db_session, owner, thread_id=swing_thread.id + 1000) is None
    assert plan_mod.active_plan(db_session, owner, lock=True).id == day_plan.id
    assert plan_mod.hub(db_session, owner)["plan"]["id"] == day_plan.id
    # a new day plan archives the day plan and leaves the swing plan alone
    newer = plan_mod.create_plan(db_session, owner, _block(db_session, owner), svc, day_thread)
    db_session.commit()
    db_session.refresh(day_plan)
    db_session.refresh(swing_plan)
    assert (day_plan.status, newer.status, swing_plan.status) == ("archived", "active", "active")
    assert plan_mod.active_plan(db_session, owner).id == newer.id
    assert plan_mod.active_plan(db_session, owner, thread_id=swing_thread.id).id == swing_plan.id


def test_without_a_day_thread_the_default_active_plan_is_none_even_with_a_swing_plan(db_session, owner, svc) -> None:
    create_swing_thread(db_session, owner, svc)
    assert plan_mod.active_plan(db_session, owner) is None
    assert plan_mod.hub(db_session, owner)["plan"] is None


# -- swing thread prep ---------------------------------------------------------------------------------------


def _minute_days(store, symbol):
    return {k.day for k in store.keys("bars1m", symbol, [*HISTORY[-34:]])}


def test_run_prep_stores_bars_and_as_of_blobs_for_the_universe_and_spy_and_reports_done(db_session, owner, svc) -> None:
    _, plan = create_swing_thread(db_session, owner, svc)
    report = plan_mod.run_prep(db_session, svc, plan.id)  # the day entry point dispatches on the plan's mode
    assert report["state"] == "done" and (report["done"], report["total"], report["failed"]) == (13, 13, {})
    store = svc.store_factory(db_session)
    days = plan_mod.plan_days(FIRST_DAY, 15)
    needed = prep_mod.needed_sessions(days, 10)
    for symbol in SYMBOLS:
        assert _minute_days(store, symbol) >= set(needed)
        assert swing.is_cached(store, symbol, days)
        assert BlobKey("bars1d", symbol, days[-1], "", "sip") in store.keys("bars1d", symbol, days)  # raw dailies
    assert swing.is_cached(store, BENCHMARK, days) and _minute_days(store, BENCHMARK) == set()  # SPY: dailies only
    db_session.refresh(plan)
    assert BENCHMARK not in [e["symbol"] for e in plan.universe["symbols"]] and plan.prep == report
    assert plan.prep["state"] == "done"


def test_run_prep_is_resumable_a_second_run_fetches_nothing(db_session, owner, world, svc) -> None:
    _, plan = create_swing_thread(db_session, owner, svc)
    swing.run_prep(db_session, svc, plan.id)
    fetches, calls = svc.history.fetches, len(world.calls)
    again = swing.run_prep(db_session, svc, plan.id)
    assert (svc.history.fetches, len(world.calls)) == (fetches, calls) and again["state"] == "done"


def test_run_prep_records_a_failing_symbol_and_finishes_the_rest(db_session, owner, world) -> None:
    class Flaky(SyntheticBars):
        fail = False

        def bars(self, symbol, timeframe, start, end, *, now, adjustment="all"):
            if self.fail and symbol == "S07" and timeframe == "1m":
                raise ProviderError("synthetic", "boom")
            return super().bars(symbol, timeframe, start, end, now=now, adjustment=adjustment)

    flaky = Flaky(world.raw, world.split, world.minutes)
    svc = swing_services(flaky)
    _, plan = create_swing_thread(db_session, owner, svc)
    flaky.fail = True
    report = swing.run_prep(db_session, svc, plan.id)
    assert report["state"] == "done" and report["done"] == 13 and report["failed"] == {"S07": "ProviderError"}
    store = svc.store_factory(db_session)
    assert _minute_days(store, "S07") == set() and _minute_days(store, "S08") != set()
    assert swing.is_cached(store, BENCHMARK, plan_mod.plan_days(FIRST_DAY, 15))  # SPY came after the failure


def test_day_ready_is_true_when_prep_is_done_or_the_day_is_stored_for_the_universe_and_spy(
    db_session, owner, svc
) -> None:
    _, plan = create_swing_thread(db_session, owner, svc)
    store = svc.store_factory(db_session)
    days = plan_mod.plan_days(FIRST_DAY, 15)
    # the coverage check already stored every universe symbol, but SPY has not been fetched yet
    assert swing.day_ready(plan, store, days[0]) is False
    swing.universe_frames(svc.history, store, BENCHMARK, days)
    assert swing.day_ready(plan, store, days[0]) is True and swing.day_ready(plan, store, days[-1]) is True
    assert swing.day_ready(plan, store, date(2026, 10, 9)) is False  # a day outside the plan has no blobs
    plan.prep = {**plan.prep, "state": "done"}
    assert swing.day_ready(plan, store, date(2026, 10, 9)) is True


def test_a_day_plan_prep_is_untouched_by_the_dispatch(db_session, owner) -> None:
    from daily_world import make_services
    from test_replay_plan import _ready

    day_plan = _ready(db_session, owner, make_services())  # a daily-list plan over the daily world's three names
    db_session.refresh(day_plan)
    assert day_plan.spec.get("mode") is None and day_plan.prep["state"] == "done"
