"""`/api/desk/dashboard` (02m §a3.2): one aggregate read for the dashboard. Stub-only until the real services
land; the flag-off answer is 503 like every other stub endpoint."""

from typing import Any

from fastapi import APIRouter, Depends, Query

from ai_trading.api.auth import get_current_user
from ai_trading.api.schemas.platform import DashboardOut
from ai_trading.mvp_stub import platform as stub_platform
from ai_trading.mvp_stub import stub_enabled, unavailable

router = APIRouter(prefix="/api/desk/dashboard", tags=["dashboard"], dependencies=[Depends(get_current_user)])


@router.get("", response_model=DashboardOut)
def dashboard(watchlist_id: int = Query(default=1)) -> DashboardOut | dict[str, Any]:
    if stub_enabled():
        return stub_platform.dashboard(watchlist_id)
    unavailable()
