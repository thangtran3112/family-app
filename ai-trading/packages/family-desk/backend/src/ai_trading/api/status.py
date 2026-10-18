from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from ai_trading.api.auth import get_current_user

router = APIRouter(prefix="/api/desk", tags=["status"], dependencies=[Depends(get_current_user)])


class StreamingSlotsOut(BaseModel):
    used: int
    max: int


class StatusOut(BaseModel):
    gateway: Literal["not_configured"]
    data_sources: Literal["unknown"]
    streaming_slots: StreamingSlotsOut
    backups: None
    reconciliation: None


@router.get("/status", response_model=StatusOut)
def status() -> StatusOut:
    return StatusOut(
        gateway="not_configured",
        data_sources="unknown",
        streaming_slots=StreamingSlotsOut(used=0, max=70),
        backups=None,
        reconciliation=None,
    )
