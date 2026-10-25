"""`/api/desk/screener*` (02m §a3.4, D5, D6): saved filters, their results, the live preview, and the universe.

Real handlers read and write the filter tables (`screener/service.py`) and show the runner's stored results.
With `DESK_MVP_STUB=1` the same routes answer from `mvp_stub.screener` instead (the frontend stream's
development fixture, removed at the end of 02m §d2 step 3). Spec validation is the same in both modes, so a
bad spec gets its `problems` either way.
"""

from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import ValidationError
from sqlalchemy.orm import Session

from ai_trading.api.auth import AuthedUser, get_current_user, get_session
from ai_trading.api.problems import problems_from_validation_error
from ai_trading.api.schemas.screener import (
    ScreenerFilterCreate,
    ScreenerFilterDetailOut,
    ScreenerFilterOut,
    ScreenerFilterUpdate,
    ScreenerPreviewIn,
    ScreenerPreviewOut,
    ScreenerResultsOut,
    ScreenerSession,
    ScreenerUniverseOut,
)
from ai_trading.api.stamp import SCAN_INTERVAL, feed_last_ok, make_stamp, no_run_stamp, run_stamp
from ai_trading.contracts.strategy_spec_v1 import FilterStrategySpecV1
from ai_trading.data.universe import MIN_AVG_VOLUME, MIN_PRICE
from ai_trading.mvp_stub import screener as stub
from ai_trading.mvp_stub import stub_enabled
from ai_trading.screener import runner, service
from ai_trading.screener.columns import table_columns
from ai_trading.screener.evaluator import check_filter
from ai_trading.screener.service import FilterNotFound, FilterReadOnly, FilterView, NameTaken

router = APIRouter(prefix="/api/desk/screener", tags=["screener"], dependencies=[Depends(get_current_user)])

_SEED_EDIT = "Default filters can't be edited · copy it to edit"
_SEED_DELETE = "Default filters can't be deleted"
_SAVE_RUN_BUDGET = 5.0  # seconds a save may spend running the filter once so its results are not empty


def _problems(raw: dict[str, Any]) -> tuple[dict[str, Any] | None, list[dict[str, str]]]:
    """The dumped spec (None when pydantic rejects it) and every problem: pydantic's, or the screener gate's."""
    try:
        spec = FilterStrategySpecV1.model_validate(raw)
    except ValidationError as exc:
        return None, problems_from_validation_error(exc)
    dumped = service.dump_spec(spec)
    return dumped, [{"path": "when", "message": message} for message in check_filter(dumped)]


def _validated_spec(raw: dict[str, Any]) -> dict[str, Any]:
    """The dumped spec, or a 422 carrying the plain-English `problems` (02m §a1)."""
    spec, problems = _problems(raw)
    if spec is None or problems:
        raise HTTPException(status_code=422, detail={"problems": problems})
    return spec


def _stub_filter(filter_id: int) -> dict[str, Any]:
    row = stub.find_filter(filter_id)
    if row is None:
        raise HTTPException(status_code=404, detail="filter not found")
    return row


def _view(session: Session, user: AuthedUser, filter_id: int) -> FilterView:
    try:
        return service.get_filter(session, user.id, filter_id)
    except FilterNotFound as exc:
        raise HTTPException(status_code=404, detail="filter not found") from exc


def _list_row(session: Session, view: FilterView, now: datetime) -> dict[str, Any]:
    run = service.last_run(session, view)
    return {
        "id": view.row.id,
        "name": view.row.name,
        "origin": view.row.origin,
        "seed_key": view.row.seed_key if view.read_only else None,
        "read_only": view.read_only,
        "run_on": view.spec["watch"]["runOn"],
        "session": view.spec["watch"]["session"],
        "last_run": None
        if run is None
        else {
            "evaluation_point": run.evaluation_point,
            "matches_total": run.matches_total,
            "scanned": run.scanned,
            "stamp": run_stamp(session, run, now),
        },
    }


def _detail(session: Session, view: FilterView, now: datetime) -> dict[str, Any]:
    default = service.seed_spec(view.row.seed_key) if view.row.seed_key and not view.read_only else None
    return {
        "id": view.row.id,
        "name": view.row.name,
        "origin": view.row.origin,
        "read_only": view.read_only,
        "version": view.version.version,
        "spec": view.spec,
        "default_spec": default,
        "stamp": run_stamp(session, service.last_run(session, view), now),
    }


def _run_once(session: Session, view: FilterView, now: datetime) -> None:
    """Run a just-saved filter once so its results are not empty until the next scheduled pass. A failure here
    is the scheduler's to retry: the save itself already succeeded."""
    try:
        runner.run_filters(session, now=now, version_ids=[view.version.id], budget=_SAVE_RUN_BUDGET)
    except Exception:  # the filter is saved; its first scheduled run will fill the results
        session.rollback()


@router.get("/filters", response_model=list[ScreenerFilterOut])
def list_filters(
    user: AuthedUser = Depends(get_current_user), session: Session = Depends(get_session)
) -> list[dict[str, Any]]:
    if stub_enabled():
        return stub.filter_list()
    now = datetime.now(UTC)
    service.ensure_seed_filters(session, user.id, now=now)  # a first visit finds the defaults, not an empty screener
    return [_list_row(session, view, now) for view in service.list_filters(session, user.id)]


@router.post("/filters", status_code=201, response_model=ScreenerFilterDetailOut)
def create_filter(
    body: ScreenerFilterCreate,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    spec = _validated_spec(body.spec) if body.spec is not None else None
    if stub_enabled():
        return stub.saved_detail(spec) if spec is not None else stub.copy_detail(_stub_filter(body.copy_of))
    now = datetime.now(UTC)
    try:
        if spec is not None:
            view = service.create_from_spec(session, user.id, spec, now=now)
        else:
            view = service.create_from_copy(session, user.id, body.copy_of, now=now)
    except FilterNotFound as exc:
        raise HTTPException(status_code=404, detail="filter not found") from exc
    except NameTaken as exc:
        raise HTTPException(status_code=409, detail=f"You already have a filter named {exc.name}") from exc
    session.commit()
    _run_once(session, view, now)
    session.commit()
    return _detail(session, view, now)


@router.get("/filters/{filter_id}", response_model=ScreenerFilterDetailOut)
def get_filter(
    filter_id: int, user: AuthedUser = Depends(get_current_user), session: Session = Depends(get_session)
) -> dict[str, Any]:
    if stub_enabled():
        return stub.filter_detail(_stub_filter(filter_id))
    return _detail(session, _view(session, user, filter_id), datetime.now(UTC))


@router.put("/filters/{filter_id}", response_model=ScreenerFilterDetailOut)
def update_filter(
    filter_id: int,
    body: ScreenerFilterUpdate,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    spec = _validated_spec(body.spec)
    if stub_enabled():
        row = _stub_filter(filter_id)
        if row["origin"] == "seed":
            raise HTTPException(status_code=409, detail=_SEED_EDIT)
        return stub.edited_detail(row["id"], spec)  # unreachable in the stub: it persists no user filter
    now = datetime.now(UTC)
    try:
        view = service.update_filter(session, user.id, filter_id, spec, body.change_note, now=now)
    except FilterNotFound as exc:
        raise HTTPException(status_code=404, detail="filter not found") from exc
    except FilterReadOnly as exc:
        raise HTTPException(status_code=409, detail=_SEED_EDIT) from exc
    except NameTaken as exc:
        raise HTTPException(status_code=409, detail=f"You already have a filter named {exc.name}") from exc
    session.commit()
    _run_once(session, view, now)
    session.commit()
    return _detail(session, view, now)


@router.delete("/filters/{filter_id}", status_code=204, response_model=None)
def delete_filter(
    filter_id: int, user: AuthedUser = Depends(get_current_user), session: Session = Depends(get_session)
) -> Response:
    if stub_enabled():
        row = _stub_filter(filter_id)
        if row["origin"] == "seed":
            raise HTTPException(status_code=409, detail=_SEED_DELETE)
        return Response(status_code=204)  # unreachable in the stub: it persists no user filter
    try:
        service.archive_filter(session, user.id, filter_id, now=datetime.now(UTC))
    except FilterNotFound as exc:
        raise HTTPException(status_code=404, detail="filter not found") from exc
    except FilterReadOnly as exc:
        raise HTTPException(status_code=409, detail=_SEED_DELETE) from exc
    session.commit()
    return Response(status_code=204)


@router.get("/filters/{filter_id}/results", response_model=ScreenerResultsOut)
def get_results(
    filter_id: int,
    session_name: ScreenerSession | None = Query(default=None, alias="session"),
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    """The filter's newest stored run. Before its first run it answers 200 with no matches and an
    `unavailable` stamp (no `as_of`), so the screen can say "Waiting for the first scan" without an error."""
    # `session` is validated as a literal and otherwise ignored: the filter's own session is what runs.
    if stub_enabled():
        return stub.results(_stub_filter(filter_id))
    now = datetime.now(UTC)
    view = _view(session, user, filter_id)
    spec = view.spec
    run = service.last_run(session, view)
    rows = [] if run is None else runner.run_matches(session, run.id)
    ranked = spec.get("rank") is not None
    return {
        "filter_id": view.row.id,
        "name": view.row.name,
        "run_on": spec["watch"]["runOn"],
        "session": spec["watch"]["session"],
        "rank": spec.get("rank"),
        "liquidity": spec.get("liquidity"),
        "evaluation_point": now if run is None else run.evaluation_point,
        "scanned": 0 if run is None else run.scanned,
        "no_data_on_eval_day": 0 if run is None else run.no_data,
        "matches_total": 0 if run is None else run.matches_total,
        "matches_returned": len(rows),
        "stamp": run_stamp(session, run, now),
        "table_columns": table_columns(spec),
        "matches": [
            {
                "symbol": row.symbol,
                "matched_since": row.matched_since,
                "rank_value": row.rank_value if ranked else None,
                "operands": row.operands,
                "columns": row.columns,
            }
            for row in rows
        ],
    }


@router.post("/preview", response_model=ScreenerPreviewOut)
def preview(
    body: ScreenerPreviewIn,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    """Evaluate an unsaved spec over the stored universe, never a provider, within `PREVIEW_BUDGET_SECONDS`.
    Over budget it answers `matches_total: null` and no `top` (a partial ranking would mislead)."""
    empty: dict[str, Any] = {"problems": [], "matches_total": None, "scanned": 0, "top": []}
    spec, problems = _problems(body.spec)
    if spec is None or problems:
        return {**empty, "problems": problems}
    if stub_enabled():
        return stub.preview(spec["name"])
    result = runner.preview_spec(session, spec, user.id, now=datetime.now(UTC))
    if result.truncated:
        return {**empty, "scanned": result.scanned}
    return {
        "problems": [],
        "matches_total": result.matches_total,
        "scanned": result.scanned,
        "top": [{"symbol": m.symbol, "rank_value": m.rank_value} for m in result.matches[:5]],
    }


@router.get("/universe", response_model=ScreenerUniverseOut)
def get_universe(session: Session = Depends(get_session)) -> dict[str, Any]:
    if stub_enabled():
        return stub.universe()
    counts = service.universe_counts(session)
    now = datetime.now(UTC)
    if counts.as_of is None:
        stamp = no_run_stamp()
    else:
        stamp = make_stamp(
            quality=counts.quality,
            source="alpaca",
            as_of=counts.as_of,
            interval=SCAN_INTERVAL,
            last_ok_at=feed_last_ok(session, "scan"),
            now=now,
        )
    return {
        "scan_basis": (
            "seed lists + market strip + Alpaca screener most-actives (by volume and by trades, top 100 each) "
            "+ movers (top 50 gainers and losers). This is not the full US equity universe."
        ),
        "candidates": counts.candidates,
        "scanned": counts.scanned,
        "dropped_non_plain_tickers": counts.dropped_non_plain,
        "no_daily_data": counts.no_daily_data,
        "liquidity_floor": {"minPrice": MIN_PRICE, "minAvgVolume": MIN_AVG_VOLUME, "avgVolumeDays": 20},
        "stamp": stamp,
    }
