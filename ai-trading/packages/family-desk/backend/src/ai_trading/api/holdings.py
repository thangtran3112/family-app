"""`/api/desk/holdings*` and `/accounts/{id}` (02n §c3 #2 to #5). Contract-first: with `DESK_FUNDAMENTAL_STUB=1` they
answer from the invented world (`fundamental_stub/`), without it 503 "not available yet" until the real services land
(02n §h step 3c). The broker account number has no field in any response (02n §c1)."""

from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from ai_trading.api.auth import get_current_user
from ai_trading.api.schemas.fundamental import AccountOut, AccountPatch, HoldingsOut, ImportOut, LotsOut
from ai_trading.fundamental_stub import holdings as stub_holdings
from ai_trading.fundamental_stub import stub_enabled, unavailable

router = APIRouter(prefix="/api/desk", tags=["holdings"], dependencies=[Depends(get_current_user)])


@router.get("/holdings", response_model=HoldingsOut)
def list_holdings(account_id: int | None = None) -> dict[str, Any]:
    """Import state, accounts, totals, one row per held symbol and the option lots."""
    if not stub_enabled():
        unavailable()
    return stub_holdings.holdings(account_id)


@router.get("/holdings/{symbol}/lots", response_model=LotsOut)
def list_lots(symbol: str) -> dict[str, Any]:
    """The tax lots and the open short calls of one symbol."""
    if not stub_enabled():
        unavailable()
    return stub_holdings.lots(symbol.upper())


@router.post(
    "/holdings/import",
    status_code=202,
    response_model=ImportOut,
    responses={409: {"description": "An import ran in the last 60 seconds (Flex allows 10 requests a minute)"}},
)
def run_import() -> dict[str, Any]:
    """Run the Flex import now. Idempotent per statement date. The stub starts nothing and says it is running."""
    if not stub_enabled():
        unavailable()
    return {"import": stub_holdings.import_state("running")}


@router.patch("/accounts/{account_id}", response_model=AccountOut)
def patch_account(account_id: int, body: AccountPatch) -> dict[str, Any]:
    """Name an account and say what kind it is. The stub stores nothing."""
    if not stub_enabled():
        unavailable()
    if body.label is None and body.type is None:
        raise HTTPException(status_code=422, detail={"problems": [{"path": "", "message": "send a label or a type"}]})
    return stub_holdings.account_patch(account_id, body.label, body.type)
