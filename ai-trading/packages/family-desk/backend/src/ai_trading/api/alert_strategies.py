"""`/api/desk/alert-strategies*` (02m §a3.7). Validation is the same in every mode: pydantic, then the engine
gate (`core.evaluate.check`). The handlers read and write the strategy tables through `alerts/service.py`; with
`DESK_MVP_STUB=1` they answer from the fixture world instead (the frontend stream's development fixture, removed
at the end of 02m §d2 step 3). `validate` is declared before the `/{id}` routes."""

from datetime import UTC, datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import ValidationError
from sqlalchemy.orm import Session

from ai_trading.alerts import service
from ai_trading.alerts.service import RuntimeDisabled, StrategyNotFound
from ai_trading.alerts.universe import resolve
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
from ai_trading.mvp_stub import alerts as mvp_alerts
from ai_trading.mvp_stub import stub_enabled
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


def _resolved_symbols(session: Session, user: AuthedUser, universe: dict[str, Any]) -> list[str]:
    """What a source resolves to: the symbols listed, the user's watchlist, or a filter's last matches. In the
    stub, a watchlist or filter the user does not have resolves to the fixture world's."""
    if "symbols" in universe:
        return list(universe["symbols"])
    found = [symbol for symbol, _ in resolve(session, user.id, universe)]
    if found or not stub_enabled():
        return found
    if "watchlist" in universe:
        return mvp_alerts.watchlist_symbols(universe["watchlist"])
    return mvp_alerts.screener_symbols(universe["filter"])


def _wired(request: Request) -> list[str]:
    return ["inbox", *getattr(request.app.state, "channels", {})]


def _real_one(session: Session, user: AuthedUser, view: service.StrategyView, now: datetime) -> dict[str, Any]:
    return service.strategy_out(session, user.id, [view], now)[0]


def _real_detail(session: Session, user: AuthedUser, view: service.StrategyView, now: datetime) -> dict[str, Any]:
    return {**_real_one(session, user, view, now), "versions": service.versions_out(session, view.row.id)}


def _not_found() -> HTTPException:
    return HTTPException(status_code=404, detail="alert strategy not found")


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
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> list[dict[str, Any]]:
    if stub_enabled():
        return mvp_alerts.strategies(
            status=status, category=category, symbol=symbol, watchlist_id=watchlist_id, sort=sort
        )
    return service.list_strategies(
        session,
        user.id,
        now=datetime.now(UTC),
        status=status,
        category=category,
        symbol=symbol,
        watchlist_id=watchlist_id,
        sort=sort,
    )


@router.post("", status_code=201, response_model=AlertStrategyOut)
def create_alert_strategy(
    body: AlertStrategyCreate,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    spec = _valid_spec(body.spec)
    if body.save_as == "on" and not alerts_runtime_enabled():
        raise HTTPException(status_code=409, detail=_RUNTIME_OFF)
    if stub_enabled():
        return mvp_alerts.new_strategy(spec, save_as=body.save_as)
    now = datetime.now(UTC)
    try:
        view = service.create_strategy(session, user.id, spec, save_as=body.save_as, now=now)
    except RuntimeDisabled as exc:
        raise HTTPException(status_code=409, detail=_RUNTIME_OFF) from exc
    session.commit()
    return _real_one(session, user, view, now)


@router.get("/{strategy_id}", response_model=AlertStrategyDetailOut)
def get_alert_strategy(
    strategy_id: int, user: AuthedUser = Depends(get_current_user), session: Session = Depends(get_session)
) -> dict[str, Any]:
    if stub_enabled():
        return mvp_alerts.detail(_stub_row(strategy_id))
    try:
        view = service.get_strategy(session, user.id, strategy_id)
    except StrategyNotFound as exc:
        raise _not_found() from exc
    return _real_detail(session, user, view, datetime.now(UTC))


@router.put("/{strategy_id}", response_model=AlertStrategyDetailOut)
def update_alert_strategy(
    strategy_id: int,
    body: AlertStrategyUpdate,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    spec = _valid_spec(body.spec)
    if stub_enabled():
        return mvp_alerts.revise(_stub_row(strategy_id), spec, body.change_note)
    now = datetime.now(UTC)
    try:
        view = service.revise_strategy(session, user.id, strategy_id, spec, body.change_note, now=now)
    except StrategyNotFound as exc:
        raise _not_found() from exc
    session.commit()
    return _real_detail(session, user, view, now)


@router.delete("/{strategy_id}", status_code=204, response_model=None)
def archive_alert_strategy(
    strategy_id: int, user: AuthedUser = Depends(get_current_user), session: Session = Depends(get_session)
) -> None:
    if stub_enabled():
        _stub_row(strategy_id)  # the fixture has nothing to archive; the id must still exist
        return None
    try:
        service.archive_strategy(session, user.id, strategy_id, now=datetime.now(UTC))
    except StrategyNotFound as exc:
        raise _not_found() from exc
    session.commit()
    return None


@router.post("/{strategy_id}/pause", response_model=AlertStrategyOut)
def pause_alert_strategy(
    strategy_id: int,
    body: AlertStrategyPauseIn,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    if stub_enabled():
        return mvp_alerts.pause(_stub_row(strategy_id), body.reason)
    try:
        view = service.pause_strategy(session, user.id, strategy_id, body.reason)
    except StrategyNotFound as exc:
        raise _not_found() from exc
    session.commit()
    return _real_one(session, user, view, datetime.now(UTC))


@router.post("/{strategy_id}/resume", response_model=AlertStrategyOut)
def resume_alert_strategy(
    strategy_id: int, user: AuthedUser = Depends(get_current_user), session: Session = Depends(get_session)
) -> dict[str, Any]:
    if stub_enabled():
        row = _stub_row(strategy_id)
        # A draft only leaves draft for alert_only when the runtime is on (02m §b5 item 6).
        if row["stage"] == "draft" and not alerts_runtime_enabled():
            raise HTTPException(status_code=409, detail=_RUNTIME_OFF)
        return mvp_alerts.resume(row)
    try:
        view = service.resume_strategy(session, user.id, strategy_id)
    except StrategyNotFound as exc:
        raise _not_found() from exc
    except RuntimeDisabled as exc:
        raise HTTPException(status_code=409, detail=_RUNTIME_OFF) from exc
    session.commit()
    return _real_one(session, user, view, datetime.now(UTC))


@router.get("/{strategy_id}/fires", response_model=list[AlertStrategyFireOut])
def list_alert_strategy_fires(
    strategy_id: int,
    request: Request,
    limit: int = Query(10, ge=1, le=200),
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> list[dict[str, Any]]:
    if stub_enabled():
        return mvp_alerts.fires(_stub_row(strategy_id), limit)
    try:
        return service.fires(session, user.id, strategy_id, limit, _wired(request))
    except StrategyNotFound as exc:
        raise _not_found() from exc
