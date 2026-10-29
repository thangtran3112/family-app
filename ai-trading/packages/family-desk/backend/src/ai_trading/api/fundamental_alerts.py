"""`/api/desk/fundamental-alerts*` (02n §c3 #16, #17): the state of the three Fundamental alert templates and a
toggle or rule edit (which will save a new strategy version). Contract-first like `api/holdings.py`; the stub stores
nothing."""

from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from ai_trading.api.auth import get_current_user
from ai_trading.api.schemas.fundamental import AlertTemplate, FundamentalAlertOut, FundamentalAlertPut
from ai_trading.fundamental_stub import platform as stub_platform
from ai_trading.fundamental_stub import stub_enabled, unavailable

router = APIRouter(
    prefix="/api/desk/fundamental-alerts", tags=["fundamental-alerts"], dependencies=[Depends(get_current_user)]
)


@router.get("", response_model=list[FundamentalAlertOut])
def list_alerts() -> list[dict[str, Any]]:
    if not stub_enabled():
        unavailable()
    return stub_platform.alerts()


@router.put("/{template}", response_model=FundamentalAlertOut)
def put_alert(template: AlertTemplate, body: FundamentalAlertPut) -> dict[str, Any]:
    if not stub_enabled():
        unavailable()
    if problems := stub_platform.alert_problems(template, body.rules):
        raise HTTPException(status_code=422, detail={"problems": problems})
    scope = body.scope if isinstance(body.scope, str | None) else body.scope.model_dump()
    return stub_platform.alert(template, body.enabled, body.rules, scope)
