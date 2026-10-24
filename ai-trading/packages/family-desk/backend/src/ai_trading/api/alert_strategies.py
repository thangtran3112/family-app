"""`/api/desk/alert-strategies*` (02m §a3.7). Validation is real in every mode: pydantic, then the engine gate
(`core.evaluate.check`). `POST .../validate` is the one endpoint that answers without the stub: it reads the
user's watchlists. Every other endpoint answers from the fixture world while `DESK_MVP_STUB=1` and 503s otherwise.
`validate` is declared before the `/{id}` routes."""

from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from ai_trading.api.auth import AuthedUser, get_current_user, get_session
from ai_trading.api.problems import problems_from_validation_error
from ai_trading.api.schemas.alerts import (
    AlertStrategyCategory,
    AlertStrategyCreate,
    AlertStrategyDetailOut,
    AlertStrategyFireOut,
    AlertStrategyOut,
    AlertStrategyPauseIn,
    AlertStrategyStatus,
    AlertStrategyUpdate,
    AlertStrategyValidateIn,
    AlertStrategyValidateOut,
)
from ai_trading.contracts.alert_strategy import AlertStrategySpecV1
from ai_trading.core.evaluate import check
from ai_trading.db.models import Watchlist, WatchlistItem
from ai_trading.mvp_stub import alerts as mvp_alerts
from ai_trading.mvp_stub import stub_enabled, unavailable
from ai_trading.runtime_flags import alerts_runtime_enabled

router = APIRouter(
    prefix="/api/desk/alert-strategies", tags=["alert strategies"], dependencies=[Depends(get_current_user)]
)

_RUNTIME_OFF = "Alerts start when live quotes are connected"


def _engine_problem(message: str) -> dict[str, str]:
    """`check()` names an alert-block field in its message ("then.alert.frequency is not supported ..."); every
    other engine problem is an operand in `when`."""
    path = message.split(" ", 1)[0] if message.startswith("then.") else "when"
    return {"path": path, "message": message}


def _check(raw: dict[str, Any]) -> tuple[AlertStrategySpecV1 | None, list[dict[str, str]]]:
    """The validated spec (None when pydantic rejects it) and every problem: pydantic's, or the engine gate's."""
    try:
        model = AlertStrategySpecV1.model_validate(raw)
    except ValidationError as exc:
        return None, problems_from_validation_error(exc)
    return model, [_engine_problem(message) for message in check(model)]


def _valid_spec(raw: dict[str, Any]) -> dict[str, Any]:
    """The spec dumped for storage. Any problem answers 422 with the plain `problems` list (02m §a1)."""
    model, problems = _check(raw)
    if model is None or problems:
        raise HTTPException(status_code=422, detail={"problems": problems})
    return model.model_dump(mode="json", by_alias=True, exclude_none=True)


def _stub_row(strategy_id: int) -> dict[str, Any]:
    row = mvp_alerts.find_strategy(strategy_id)
    if row is None:
        raise HTTPException(status_code=404, detail="alert strategy not found")
    return row


def _db_watchlist_symbols(session: Session, user_id: int, name: str) -> list[str] | None:
    """The symbols of the user's watchlist named `name`, in manage-mode order; None when there is no such list."""
    watchlist_id = session.execute(
        select(Watchlist.id).where(Watchlist.user_id == user_id, Watchlist.name == name)
    ).scalar_one_or_none()
    if watchlist_id is None:
        return None
    return list(
        session.execute(
            select(WatchlistItem.symbol)
            .where(WatchlistItem.watchlist_id == watchlist_id)
            .order_by(WatchlistItem.position, WatchlistItem.symbol)
        ).scalars()
    )


def _resolved_symbols(session: Session, user: AuthedUser, universe: dict[str, Any]) -> list[str]:
    """What a source resolves to. A watchlist is the user's list (in the stub, the fixture list when the user has
    none by that name); a symbol source is its list; a filter source has no real run yet, so it is empty."""
    if "symbols" in universe:
        return list(universe["symbols"])
    if "watchlist" in universe:
        found = _db_watchlist_symbols(session, user.id, universe["watchlist"])
        if found is not None:
            return found
        return mvp_alerts.watchlist_symbols(universe["watchlist"]) if stub_enabled() else []
    return mvp_alerts.screener_symbols(universe["filter"]) if stub_enabled() else []


@router.post("/validate", response_model=AlertStrategyValidateOut)
def validate_alert_strategy(
    body: AlertStrategyValidateIn,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> AlertStrategyValidateOut:
    model, problems = _check(body.spec)
    if model is None:  # not even a spec: nothing to resolve
        return AlertStrategyValidateOut(problems=problems, resolved_symbols=[], run_on=None)
    # Engine problems (for example a filter source, which the engine cannot run yet) still resolve, so the
    # summary pane can show the first symbol while the user is still editing.
    universe = model.model_dump(mode="json", by_alias=True, exclude_none=True)["watch"]["universe"]
    return AlertStrategyValidateOut(
        problems=problems,
        resolved_symbols=_resolved_symbols(session, user, universe),
        run_on=model.watch.runOn,
    )


@router.get("", response_model=list[AlertStrategyOut])
def list_alert_strategies(
    status: AlertStrategyStatus | None = None,
    category: AlertStrategyCategory | None = None,
    symbol: str | None = None,
    watchlist_id: int | None = None,
    sort: Literal["name", "last_fired", "status"] = "name",
) -> list[dict[str, Any]]:
    if stub_enabled():
        return mvp_alerts.strategies(
            status=status, category=category, symbol=symbol, watchlist_id=watchlist_id, sort=sort
        )
    unavailable()


@router.post("", status_code=201, response_model=AlertStrategyOut)
def create_alert_strategy(body: AlertStrategyCreate) -> dict[str, Any]:
    spec = _valid_spec(body.spec)
    if body.save_as == "on" and not alerts_runtime_enabled():
        raise HTTPException(status_code=409, detail=_RUNTIME_OFF)
    if stub_enabled():
        return mvp_alerts.new_strategy(spec, save_as=body.save_as)
    unavailable()


@router.get("/{strategy_id}", response_model=AlertStrategyDetailOut)
def get_alert_strategy(strategy_id: int) -> dict[str, Any]:
    if stub_enabled():
        return mvp_alerts.detail(_stub_row(strategy_id))
    unavailable()


@router.put("/{strategy_id}", response_model=AlertStrategyDetailOut)
def update_alert_strategy(strategy_id: int, body: AlertStrategyUpdate) -> dict[str, Any]:
    spec = _valid_spec(body.spec)
    if stub_enabled():
        return mvp_alerts.revise(_stub_row(strategy_id), spec, body.change_note)
    unavailable()


@router.delete("/{strategy_id}", status_code=204, response_model=None)
def archive_alert_strategy(strategy_id: int) -> None:
    if stub_enabled():
        _stub_row(strategy_id)  # the fixture has nothing to archive; the id must still exist
        return None
    unavailable()


@router.post("/{strategy_id}/pause", response_model=AlertStrategyOut)
def pause_alert_strategy(strategy_id: int, body: AlertStrategyPauseIn) -> dict[str, Any]:
    if stub_enabled():
        return mvp_alerts.pause(_stub_row(strategy_id), body.reason)
    unavailable()


@router.post("/{strategy_id}/resume", response_model=AlertStrategyOut)
def resume_alert_strategy(strategy_id: int) -> dict[str, Any]:
    if stub_enabled():
        row = _stub_row(strategy_id)
        # A draft only leaves draft for alert_only when the runtime is on (02m §b5 item 6).
        if row["stage"] == "draft" and not alerts_runtime_enabled():
            raise HTTPException(status_code=409, detail=_RUNTIME_OFF)
        return mvp_alerts.resume(row)
    unavailable()


@router.get("/{strategy_id}/fires", response_model=list[AlertStrategyFireOut])
def list_alert_strategy_fires(strategy_id: int, limit: int = Query(10, ge=1, le=200)) -> list[dict[str, Any]]:
    if stub_enabled():
        return mvp_alerts.fires(_stub_row(strategy_id), limit)
    unavailable()
