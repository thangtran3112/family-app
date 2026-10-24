"""`/api/desk/library*` (02m §a3.6): the shipped preset catalog, read from files on each request, and
attach. Reads and attach validation are real in both modes. Only the stored copy is stub-only: with the
stub flag on, attach answers 201 with the copy and stores nothing; with it off, attach answers 503."""

from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from ai_trading.api.auth import AuthedUser, get_current_user, get_session
from ai_trading.api.problems import problems_from_validation_error
from ai_trading.api.schemas.library import (
    LibraryAttachIn,
    LibraryAttachOut,
    LibraryEntryOut,
    LibraryItemOut,
)
from ai_trading.contracts.strategy_spec_v1 import Entry
from ai_trading.db.models import Watchlist
from ai_trading.library.catalog import alert_only_spec, load_catalog, load_template
from ai_trading.mvp_stub import library as stub_library
from ai_trading.mvp_stub import stub_enabled, unavailable
from ai_trading.runtime_flags import alerts_runtime_enabled

router = APIRouter(prefix="/api/desk/library", tags=["library"], dependencies=[Depends(get_current_user)])

FILTER_BLOCKED = "Copy this preset to My filters instead"
FUTURES_BLOCKED = "Futures alerts start when IBKR quotes connect"


def _entry(entry_id: str) -> tuple[int, Entry]:
    for index, entry in enumerate(load_catalog().entries):
        if entry.id == entry_id:
            return index, entry
    raise HTTPException(status_code=404, detail="library entry not found")


def _blocked_reason(entry: Entry) -> str | None:
    if entry.kind == "filter":
        return FILTER_BLOCKED
    if entry.category == "futures":
        return FUTURES_BLOCKED
    return None


def _item(entry: Entry) -> LibraryItemOut:
    reason = _blocked_reason(entry)
    return LibraryItemOut(**entry.model_dump(), attachable=reason is None, attach_blocked_reason=reason)


def _defaults(entry: Entry, template: dict[str, Any]) -> dict[str, Any]:
    if entry.kind == "filter":
        return {}
    alert = template["then"]["alert"]
    return {
        "limits": {key: value for key, value in template.get("limits", {}).items() if key == "cooldownMinutes"},
        "severity": alert.get("severity", "info"),
        "channels": alert["channels"],
    }


@router.get("", response_model=list[LibraryItemOut])
def list_library(
    category: str | None = None,
    q: str | None = None,
    kind: Literal["strategy", "filter"] = "strategy",
    lane: Literal["technical", "fundamental"] = "technical",
) -> list[LibraryItemOut]:
    needle = q.casefold() if q else None
    out: list[LibraryItemOut] = []
    for entry in load_catalog().entries:
        if entry.kind != kind or entry.lane != lane:
            continue
        if category and entry.category != category:
            continue
        if needle and needle not in entry.label.casefold() and needle not in entry.summary.casefold():
            continue
        out.append(_item(entry))
    return out


@router.get("/{entry_id}", response_model=LibraryEntryOut)
def get_library_entry(entry_id: str) -> LibraryEntryOut:
    _, entry = _entry(entry_id)
    template = load_template(entry.file)
    example = stub_library.example(template) if stub_enabled() else None
    return LibraryEntryOut(
        **_item(entry).model_dump(),
        spec=template,
        defaults=_defaults(entry, template),
        example=example,
    )


@router.post("/{entry_id}/attach", status_code=201, response_model=LibraryAttachOut)
def attach_library_entry(
    entry_id: str,
    body: LibraryAttachIn,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> LibraryAttachOut:
    index, entry = _entry(entry_id)
    reason = _blocked_reason(entry)
    if reason is not None:
        raise HTTPException(status_code=422, detail=reason)
    watchlist = session.execute(
        select(Watchlist).where(Watchlist.id == body.watchlist_id, Watchlist.user_id == user.id)
    ).scalar_one_or_none()
    if watchlist is None:
        raise HTTPException(status_code=404, detail="watchlist not found")
    try:
        spec = alert_only_spec(
            load_template(entry.file),
            watchlist=watchlist.name,
            channels=body.channels,
            severity=body.severity,
        )
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail={"problems": problems_from_validation_error(exc)}) from exc
    if not stub_enabled():
        unavailable()
    stage = "alert_only" if alerts_runtime_enabled() else "draft"
    return stub_library.attached(
        index,
        spec.model_dump(mode="json", by_alias=True, exclude_none=True),
        watchlist_id=watchlist.id,
        watchlist_name=watchlist.name,
        stage=stage,
    )
