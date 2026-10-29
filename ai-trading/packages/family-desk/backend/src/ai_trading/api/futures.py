from datetime import date
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, FiniteFloat

from ai_trading.api.auth import get_current_user
from ai_trading.api.schemas.fundamental import FuturesReadingsOut
from ai_trading.core.futures import MICRO_OF, MINI_OF, SPECS, roll_date
from ai_trading.fundamental_stub import platform as fundamental_platform
from ai_trading.fundamental_stub import stub_enabled, unavailable

router = APIRouter(prefix="/api/desk/futures", tags=["futures"], dependencies=[Depends(get_current_user)])


class SessionOut(BaseModel):
    open_time: str
    close_time: str


class FuturesSpecOut(BaseModel):
    root: str
    mini: str
    micro: str
    multiplier: FiniteFloat
    tick_size: FiniteFloat
    session: SessionOut
    roll_dates: list[date]
    approx_margin: FiniteFloat | None
    margin_as_of: date | None


def _roll_dates(root: str, today: date) -> list[date]:
    dates: list[date] = []
    for year in range(today.year, today.year + 4):
        for month in SPECS[root].months:
            contract_month = date(year, month, 1)
            value = roll_date(root, contract_month)
            if value >= today:
                dates.append(value)
        if len(dates) >= 4:
            break
    return sorted(dates)[:4]


@router.get("/specs", response_model=list[FuturesSpecOut])
def futures_specs() -> list[FuturesSpecOut]:
    today = date.today()
    return [
        FuturesSpecOut(
            root=root,
            mini=MINI_OF.get(root, root),
            micro=MICRO_OF.get(root, root),
            multiplier=spec.dollars_per_point,
            tick_size=spec.tick_size,
            session=SessionOut(open_time=spec.session.open_time, close_time=spec.session.close_time),
            roll_dates=_roll_dates(root, today),
            approx_margin=None,
            margin_as_of=None,
        )
        for root, spec in SPECS.items()
    ]


@router.get("/readings", response_model=FuturesReadingsOut)
def futures_readings() -> dict[str, Any]:
    """ES, NQ, CL and GC rows (front contract, last, week range, roll, expiry) and the week's macro releases (02n
    §c3 #11). Contract-first: `DESK_FUNDAMENTAL_STUB=1` answers from the invented world, otherwise 503 until the real
    service lands."""
    if not stub_enabled():
        unavailable()
    return fundamental_platform.futures_readings()
