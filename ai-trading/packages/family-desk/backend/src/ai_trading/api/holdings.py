"""`/api/desk/holdings*` and `/accounts/{id}` (02n §c3 #2 to #5): the real holdings service (`holdings/`). Every read is
scoped to the signed-in user's own accounts; the broker account number has no field in any response (02n §c1). With
`DESK_FUNDAMENTAL_STUB=1` they answer from the invented world (`fundamental_stub/`) so the frontend can code against
the frozen fixtures."""

import os
from datetime import UTC, datetime
from typing import Any

from ai_trading_common.registry import DataSources
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from sqlalchemy.orm import Session, sessionmaker

from ai_trading.api.auth import AuthedUser, get_current_user, get_data_sources, get_session
from ai_trading.api.schemas.fundamental import AccountOut, AccountPatch, HoldingsOut, ImportOut, LotsOut
from ai_trading.covered_calls import service as covered_calls
from ai_trading.fundamental.sources import fundamental_sources
from ai_trading.fundamental_stub import holdings as stub_holdings
from ai_trading.fundamental_stub import stub_enabled
from ai_trading.holdings import importer
from ai_trading.holdings import service as holdings_service

router = APIRouter(prefix="/api/desk", tags=["holdings"], dependencies=[Depends(get_current_user)])


def get_session_factory(request: Request) -> sessionmaker[Session]:
    """The factory the import's background task opens its own session from (the request's session closes first);
    tests override it like `get_session`."""
    return request.app.state.session_factory


@router.get("/holdings", response_model=HoldingsOut)
def list_holdings(
    account_id: int | None = None,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
    sources: DataSources = Depends(get_data_sources),
) -> dict[str, Any]:
    """Import state, accounts, totals, one row per held symbol and the option lots."""
    if stub_enabled():
        return stub_holdings.holdings(account_id)
    return holdings_service.holdings(session, user.id, user.email, sources, os.environ, account_id, datetime.now(UTC))


@router.get("/holdings/{symbol}/lots", response_model=LotsOut)
def list_lots(
    symbol: str,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
    sources: DataSources = Depends(get_data_sources),
) -> dict[str, Any]:
    """The tax lots and the open short calls of one symbol."""
    if stub_enabled():
        return stub_holdings.lots(symbol.upper())
    now, symbol = datetime.now(UTC), symbol.upper()
    return {
        **holdings_service.lots(session, user.id, sources, symbol, now),
        "short_calls": covered_calls.short_calls(session, user.id, sources, now, symbol=symbol),
    }


@router.post(
    "/holdings/import",
    status_code=202,
    response_model=ImportOut,
    responses={
        404: {"description": "The import belongs to another Desk user"},
        409: {"description": "An import ran in the last 60 seconds (Flex allows 10 requests a minute)"},
        503: {"description": "The Flex import is not set up"},
    },
)
def run_import(
    background: BackgroundTasks,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
    factory: sessionmaker[Session] = Depends(get_session_factory),
) -> dict[str, Any]:
    """Start the Flex import and answer 202 with the running state; the statement is fetched and stored in the
    background (idempotent per account and statement date). Only the Desk user named by `DESK_FLEX_USER` may start
    it."""
    if stub_enabled():
        return {"import": stub_holdings.import_state("running")}
    env = dict(os.environ)
    flex_user = importer.flex_user_email(env)
    if fundamental_sources(env)["holdings"].state != "configured" or flex_user is None:
        raise HTTPException(status_code=503, detail="holdings import is not set up")
    if user.email.lower() != flex_user:
        raise HTTPException(status_code=404, detail="no holdings import for you")
    if not importer.RUNTIME.begin(datetime.now(UTC)):
        raise HTTPException(status_code=409, detail="an import ran in the last minute")
    background.add_task(importer.run_import, factory, env)
    return {"import": holdings_service.import_state(session, user.email, user.id, env)}


@router.patch("/accounts/{account_id}", response_model=AccountOut)
def patch_account(
    account_id: int,
    body: AccountPatch,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    """Name an account and say what kind it is."""
    if body.label is None and body.type is None:
        raise HTTPException(status_code=422, detail={"problems": [{"path": "", "message": "send a label or a type"}]})
    if stub_enabled():
        return stub_holdings.account_patch(account_id, body.label, body.type)
    return holdings_service.patch_account(session, user.id, account_id, body.label, body.type)
