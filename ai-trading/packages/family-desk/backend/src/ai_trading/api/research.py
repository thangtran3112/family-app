"""`/api/desk/research*` (02n §c3 #12 to #15): the Desk AI brief, one symbol's verdict with consensus and targets, its
valuation and earnings reaction, and its timeline.

Real services (02n §h step 3c): consensus and targets from the stored snapshots (`research/service.py`), valuation and
earnings reaction from SEC filings, bars and the delayed quote (`research/valuation.py`), the timeline as a read model
(`research/timeline.py`). The Desk AI verdict and brief rows are step 5's job, so they are empty here, never invented.
With `DESK_FUNDAMENTAL_STUB=1` each route still answers from the invented world (`fundamental_stub/`), the fixtures
stream F codes against."""

import re
from datetime import UTC, date, datetime
from typing import Annotated, Any

from ai_trading_common.registry import DataSources
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ai_trading.api.auth import AuthedUser, get_current_user, get_data_sources, get_session
from ai_trading.api.schemas.fundamental import BriefOut, ResearchOut, TimelineKind, TimelineOut, ValuationOut
from ai_trading.fundamental_stub import research as stub_research
from ai_trading.fundamental_stub import stub_enabled
from ai_trading.research import service
from ai_trading.research import timeline as timeline_service
from ai_trading.research import valuation as valuation_service

router = APIRouter(prefix="/api/desk/research", tags=["research"], dependencies=[Depends(get_current_user)])

_DEFAULT_LIMIT = 50  # paginated like /signals
_MAX_LIMIT = 200
_SYMBOL = re.compile(r"[A-Z0-9][A-Z0-9.-]{0,14}")


def _symbol(raw: str) -> str:
    """The upper-cased ticker, or 422 in the `{"detail": {"problems": [...]}}` shape (02n §c)."""
    symbol = raw.upper()
    if not _SYMBOL.fullmatch(symbol):
        raise HTTPException(
            status_code=422, detail={"problems": [{"path": "symbol", "message": "is not a ticker symbol"}]}
        )
    return symbol


@router.get("/brief", response_model=BriefOut)
def brief(db: Session = Depends(get_session), on: Annotated[date | None, Query(alias="date")] = None) -> dict[str, Any]:
    """Every analyzed stock after the close, the run summary and the track-record counts. No Desk AI run exists before
    step 5: no rows, no run, and the track record counts the stored calls."""
    if stub_enabled():
        return stub_research.brief(on)
    return service.brief(db, on, now=datetime.now(UTC))


@router.get("/symbols/{symbol}", response_model=ResearchOut)
def research(symbol: str, db: Session = Depends(get_session)) -> dict[str, Any]:
    """Consensus EPS, revisions and analyst targets from the stored snapshots; `verdict` is null until step 5."""
    if stub_enabled():
        return stub_research.research(symbol.upper())
    return service.symbol_research(db, _symbol(symbol), now=datetime.now(UTC))


@router.get("/symbols/{symbol}/valuation", response_model=ValuationOut)
def valuation(
    symbol: str, db: Session = Depends(get_session), sources: DataSources = Depends(get_data_sources)
) -> dict[str, Any]:
    """The four valuation methods per share, the 60/40 blend against the price, and the earnings reaction."""
    if stub_enabled():
        return stub_research.valuation(symbol.upper())
    return valuation_service.valuation(db, sources, _symbol(symbol), now=datetime.now(UTC))


@router.get("/symbols/{symbol}/timeline", response_model=TimelineOut)
def timeline(
    symbol: str,
    kind: TimelineKind | None = None,
    limit: Annotated[int, Query(ge=1, le=_MAX_LIMIT)] = _DEFAULT_LIMIT,
    offset: Annotated[int, Query(ge=0)] = 0,
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
    sources: DataSources = Depends(get_data_sources),
) -> dict[str, Any]:
    if stub_enabled():
        return stub_research.timeline(symbol.upper(), kind, limit, offset)
    return timeline_service.timeline(db, sources, user.id, _symbol(symbol), kind, limit, offset, now=datetime.now(UTC))
