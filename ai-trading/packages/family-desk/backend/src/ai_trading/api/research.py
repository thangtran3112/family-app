"""`/api/desk/research*` (02n §c3 #12 to #15): the Desk AI brief, one symbol's verdict with consensus and targets, its
valuation and earnings reaction, and its timeline. Contract-first like `api/holdings.py`; every Desk AI field is
SIMULATED until the step-5 job exists."""

from datetime import date
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query

from ai_trading.api.auth import get_current_user
from ai_trading.api.schemas.fundamental import BriefOut, ResearchOut, TimelineKind, TimelineOut, ValuationOut
from ai_trading.fundamental_stub import research as stub_research
from ai_trading.fundamental_stub import stub_enabled, unavailable

router = APIRouter(prefix="/api/desk/research", tags=["research"], dependencies=[Depends(get_current_user)])

_DEFAULT_LIMIT = 50  # paginated like /signals
_MAX_LIMIT = 200


@router.get("/brief", response_model=BriefOut)
def brief(on: Annotated[date | None, Query(alias="date")] = None) -> dict[str, Any]:
    """Every analyzed stock after the close, the run summary and the track-record counts."""
    if not stub_enabled():
        unavailable()
    return stub_research.brief(on)


@router.get("/symbols/{symbol}", response_model=ResearchOut)
def research(symbol: str) -> dict[str, Any]:
    if not stub_enabled():
        unavailable()
    return stub_research.research(symbol.upper())


@router.get("/symbols/{symbol}/valuation", response_model=ValuationOut)
def valuation(symbol: str) -> dict[str, Any]:
    if not stub_enabled():
        unavailable()
    return stub_research.valuation(symbol.upper())


@router.get("/symbols/{symbol}/timeline", response_model=TimelineOut)
def timeline(
    symbol: str,
    kind: TimelineKind | None = None,
    limit: Annotated[int, Query(ge=1, le=_MAX_LIMIT)] = _DEFAULT_LIMIT,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> dict[str, Any]:
    if not stub_enabled():
        unavailable()
    return stub_research.timeline(symbol.upper(), kind, limit, offset)
