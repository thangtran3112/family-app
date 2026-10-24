"""`/api/desk/screener*` (02m §a3.4, D5, D6): saved filters, their results, the live preview, and the universe.

Stub-backed (02m §d2): with `DESK_MVP_STUB=1` the answers come from `mvp_stub.screener`; with the flag off each
route answers 503. Spec validation is real in both modes, so a bad spec gets its `problems` either way.
"""

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import ValidationError

from ai_trading.api.auth import get_current_user
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
from ai_trading.contracts.strategy_spec_v1 import FilterStrategySpecV1
from ai_trading.mvp_stub import screener as stub
from ai_trading.mvp_stub import stub_enabled, unavailable

router = APIRouter(prefix="/api/desk/screener", tags=["screener"], dependencies=[Depends(get_current_user)])

_SEED_EDIT = "Default filters can't be edited · copy it to edit"
_SEED_DELETE = "Default filters can't be deleted"


def _require_stub() -> None:
    if not stub_enabled():
        unavailable()


def _validated_spec(raw: dict[str, Any]) -> dict[str, Any]:
    """The dumped spec, or a 422 carrying the plain-English `problems` (02m §a1)."""
    try:
        spec = FilterStrategySpecV1.model_validate(raw)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail={"problems": problems_from_validation_error(exc)}) from exc
    return spec.model_dump(mode="json", by_alias=True, exclude_none=True)


def _filter_or_404(filter_id: int) -> dict[str, Any]:
    row = stub.find_filter(filter_id)
    if row is None:
        raise HTTPException(status_code=404, detail="filter not found")
    return row


@router.get("/filters", response_model=list[ScreenerFilterOut])
def list_filters() -> list[dict[str, Any]]:
    _require_stub()
    return stub.filter_list()


@router.post("/filters", status_code=201, response_model=ScreenerFilterDetailOut)
def create_filter(body: ScreenerFilterCreate) -> dict[str, Any]:
    if body.spec is not None:
        spec = _validated_spec(body.spec)
        _require_stub()
        return stub.saved_detail(spec)
    _require_stub()
    return stub.copy_detail(_filter_or_404(body.copy_of))


@router.get("/filters/{filter_id}", response_model=ScreenerFilterDetailOut)
def get_filter(filter_id: int) -> dict[str, Any]:
    _require_stub()
    return stub.filter_detail(_filter_or_404(filter_id))


@router.put("/filters/{filter_id}", response_model=ScreenerFilterDetailOut)
def update_filter(filter_id: int, body: ScreenerFilterUpdate) -> dict[str, Any]:
    spec = _validated_spec(body.spec)
    _require_stub()
    row = _filter_or_404(filter_id)
    if row["origin"] == "seed":
        raise HTTPException(status_code=409, detail=_SEED_EDIT)
    return stub.edited_detail(row["id"], spec)  # unreachable in the stub: it persists no user filter


@router.delete("/filters/{filter_id}", status_code=204, response_model=None)
def delete_filter(filter_id: int) -> Response:
    _require_stub()
    row = _filter_or_404(filter_id)
    if row["origin"] == "seed":
        raise HTTPException(status_code=409, detail=_SEED_DELETE)
    return Response(status_code=204)  # unreachable in the stub: it persists no user filter


@router.get("/filters/{filter_id}/results", response_model=ScreenerResultsOut)
def get_results(filter_id: int, session: ScreenerSession | None = None) -> dict[str, Any]:
    # `session` is validated as a literal and otherwise ignored: the filter's own session is what runs.
    _require_stub()
    return stub.results(_filter_or_404(filter_id))


@router.post("/preview", response_model=ScreenerPreviewOut)
def preview(body: ScreenerPreviewIn) -> dict[str, Any]:
    empty: dict[str, Any] = {"problems": [], "matches_total": None, "scanned": 0, "top": []}
    try:
        spec = FilterStrategySpecV1.model_validate(body.spec)
    except ValidationError as exc:
        return {**empty, "problems": problems_from_validation_error(exc)}
    if not stub_enabled():
        return empty
    return stub.preview(spec.name)


@router.get("/universe", response_model=ScreenerUniverseOut)
def get_universe() -> dict[str, Any]:
    _require_stub()
    return stub.universe()
