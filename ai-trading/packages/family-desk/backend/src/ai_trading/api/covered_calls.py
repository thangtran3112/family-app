"""`/api/desk/covered-calls*` (02n §c3 #6 to #10): coverage, the top three calls, open short calls with their risks,
the roll panel and premium income, from the real service (`covered_calls/`). The numbers are the engine's
(`core/covered_calls.py`), never recomputed here or in the browser. With `DESK_FUNDAMENTAL_STUB=1` they answer from the
invented world so the frontend can code against the frozen fixtures."""

import os
from datetime import UTC, datetime
from typing import Annotated, Any

from ai_trading_common.registry import DataSources
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from ai_trading.api.auth import AuthedUser, get_current_user, get_data_sources, get_session
from ai_trading.api.schemas.fundamental import CandidatesOut, CoverageOut, IncomeOut, RollOut, ShortCallRowOut
from ai_trading.covered_calls import service
from ai_trading.fundamental_stub import covered_calls as stub_calls
from ai_trading.fundamental_stub import stub_enabled

router = APIRouter(prefix="/api/desk/covered-calls", tags=["covered-calls"], dependencies=[Depends(get_current_user)])

_MAX_MONTHS = 36


@router.get("/coverage", response_model=CoverageOut)
def coverage(user: AuthedUser = Depends(get_current_user), session: Session = Depends(get_session)) -> dict[str, Any]:
    """Coverable contracts per holding and account, with the reason in words."""
    if stub_enabled():
        return stub_calls.coverage()
    return service.coverage(session, user.id, os.environ, datetime.now(UTC))


@router.get("/candidates", response_model=CandidatesOut)
def candidates(
    symbol: Annotated[str, Query(min_length=1, max_length=32)],
    account_id: int | None = None,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
    sources: DataSources = Depends(get_data_sources),
) -> dict[str, Any]:
    """The engine's top three calls for one holding, from the delayed spot and chain read now; an empty list with an
    unavailable chain stamp when the chain cannot be read."""
    if stub_enabled():
        return stub_calls.candidates(symbol.upper(), account_id)
    return service.candidates(session, user.id, sources, symbol.upper(), account_id, datetime.now(UTC))


@router.get("/short-calls", response_model=list[ShortCallRowOut])
def short_calls(
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
    sources: DataSources = Depends(get_data_sources),
) -> list[dict[str, Any]]:
    if stub_enabled():
        return stub_calls.short_calls()
    return service.short_calls(session, user.id, sources, datetime.now(UTC))


@router.get("/short-calls/{call_id}/roll", response_model=RollOut)
def roll(
    call_id: int,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
    sources: DataSources = Depends(get_data_sources),
) -> dict[str, Any]:
    """Cost to close, roll candidates and the assignment note for one open short call."""
    if stub_enabled():
        return stub_calls.roll(call_id)
    return service.roll(session, user.id, sources, call_id, datetime.now(UTC))


@router.get("/income", response_model=IncomeOut)
def income(
    months: Annotated[int, Query(ge=1, le=_MAX_MONTHS)] = 12,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    if stub_enabled():
        return stub_calls.income(months)
    return service.income(session, user.id, months, datetime.now(UTC))
