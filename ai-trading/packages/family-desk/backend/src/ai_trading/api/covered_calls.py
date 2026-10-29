"""`/api/desk/covered-calls*` (02n §c3 #6 to #10): coverage, the latest scan's top three, open short calls with their
risks, the roll panel and premium income. Contract-first like `api/holdings.py`; the numbers are the engine's
(`core/covered_calls.py`), never recomputed here or in the browser."""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query

from ai_trading.api.auth import get_current_user
from ai_trading.api.schemas.fundamental import CandidatesOut, CoverageOut, IncomeOut, RollOut, ShortCallRowOut
from ai_trading.fundamental_stub import covered_calls as stub_calls
from ai_trading.fundamental_stub import stub_enabled, unavailable

router = APIRouter(prefix="/api/desk/covered-calls", tags=["covered-calls"], dependencies=[Depends(get_current_user)])

_MAX_MONTHS = 36


@router.get("/coverage", response_model=CoverageOut)
def coverage() -> dict[str, Any]:
    """Coverable contracts per holding and account, with the reason in words."""
    if not stub_enabled():
        unavailable()
    return stub_calls.coverage()


@router.get("/candidates", response_model=CandidatesOut)
def candidates(
    symbol: Annotated[str, Query(min_length=1, max_length=32)], account_id: int | None = None
) -> dict[str, Any]:
    """The top three calls from the latest scan; an empty list with an unavailable chain stamp before option quotes."""
    if not stub_enabled():
        unavailable()
    return stub_calls.candidates(symbol.upper(), account_id)


@router.get("/short-calls", response_model=list[ShortCallRowOut])
def short_calls() -> list[dict[str, Any]]:
    if not stub_enabled():
        unavailable()
    return stub_calls.short_calls()


@router.get("/short-calls/{call_id}/roll", response_model=RollOut)
def roll(call_id: int) -> dict[str, Any]:
    """Cost to close, roll candidates and the assignment note for one open short call."""
    if not stub_enabled():
        unavailable()
    return stub_calls.roll(call_id)


@router.get("/income", response_model=IncomeOut)
def income(months: Annotated[int, Query(ge=1, le=_MAX_MONTHS)] = 12) -> dict[str, Any]:
    if not stub_enabled():
        unavailable()
    return stub_calls.income(months)
