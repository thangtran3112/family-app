"""`/api/desk/replay/*` (02o §b): the Practice lane. Ten routes, all new, all behind the gateway identity, all
scoped to the signed-in user (a non-owner gets 404), all `Cache-Control: no-store`.

There is no order, position, or broker anywhere in these paths: practice marks are journal annotations on a
finished past day, a resource of their own under `/replay/sessions/{id}/marks` (the no-orders route test passes
unchanged). The server owns the playhead (`replay/session.py`): nothing past `revealed_through` leaves it.

Request bodies are the contracts (`ReplaySessionV1`, `PracticeMarkV1`), validated by hand so a failure is the plain
`422 {"detail": {"problems": [...]}}` list. `DESK_REPLAY_STUB=1` swaps the data sources for the trimmed R0 fixture
(`replay/fixture.py`); the services themselves run unchanged.
"""

import logging
from datetime import UTC, datetime
from typing import Any

from ai_trading_common.errors import ProviderError
from ai_trading_common.registry import DataSources
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import ValidationError
from sqlalchemy.orm import Session

from ai_trading.api.auth import AuthedUser, get_current_user, get_data_sources, get_session
from ai_trading.api.problems import problems_from_validation_error
from ai_trading.api.schemas.replay import (
    AdvanceIn,
    AdvanceOut,
    FeedOut,
    Interval,
    MarkResultOut,
    MarkUndoOut,
    ReplayDaysOut,
    ReplaySessionOut,
    ReplaySessionPatch,
    ReplaySessionSummaryOut,
    SessionStatus,
)
from ai_trading.contracts.replay_session import PracticeMarkV1, ReplaySessionV1
from ai_trading.replay import days as days_mod
from ai_trading.replay import fixture
from ai_trading.replay import session as svc_mod
from ai_trading.replay.data import History, ReplayDayError
from ai_trading.replay.session import ReplayProblem, Services, SessionNotFound
from ai_trading.replay.tape import Tape

log = logging.getLogger(__name__)

NO_STORE = "no-store"


def _no_store(response: Response) -> None:
    response.headers["Cache-Control"] = NO_STORE


router = APIRouter(
    prefix="/api/desk/replay",
    tags=["replay"],
    dependencies=[Depends(get_current_user), Depends(_no_store)],
)


def get_services(request: Request, sources: DataSources = Depends(get_data_sources)) -> Services:
    """The process-wide replay services, built once from `DataSources` (the fixture's under the stub flag)."""
    cached = getattr(request.app.state, "replay_services", None)
    if cached is None:
        source = fixture.fixture_sources(sources) if fixture.stub_enabled() else sources
        cached = Services(history=History(source), tape=Tape(source))
        request.app.state.replay_services = cached
    return cached


def _problem(message: str, path: str, status: int = 422) -> HTTPException:
    return HTTPException(status_code=status, detail={"problems": [{"path": path, "message": message}]})


def _not_found() -> HTTPException:
    return HTTPException(status_code=404, detail="practice session not found")


async def _json_body(request: Request) -> Any:
    try:
        return await request.json()
    except ValueError:
        raise _problem("Send a JSON body", "") from None


def _validated[T](model: type[T], raw: Any) -> T:
    try:
        return model.model_validate(raw)  # type: ignore[attr-defined]
    except ValidationError as exc:
        problems = problems_from_validation_error(exc)
        # A rule on the whole object (the window rules) has no field path; they are about the window.
        raise HTTPException(
            status_code=422,
            detail={"problems": [{**p, "path": p["path"] or "window"} for p in problems]},
        ) from None


def _call[T](fn, *args, **kwargs) -> T:
    """Run a service function, turning its rejections into the plain HTTP errors of 02m §a1."""
    try:
        return fn(*args, **kwargs)
    except SessionNotFound:
        raise _not_found() from None
    except ReplayProblem as exc:
        raise _problem(exc.message, exc.path, exc.status) from None
    except ReplayDayError as exc:
        raise _problem(exc.message, exc.path) from None
    except ProviderError as exc:
        log.warning("replay data unavailable: %s", exc)
        raise HTTPException(status_code=503, detail="Market data is unavailable right now · try again") from None


# -- notable days and the session list -----------------------------------------------------------------------


@router.get("/days", response_model=ReplayDaysOut)
def list_days(
    symbol: str | None = Query(default=None, max_length=10, pattern=r"^[A-Z][A-Z0-9.]*$"),
    limit: int = Query(default=20, ge=1, le=100),
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> dict[str, Any]:
    return days_mod.list_days(db, user.id, symbol=symbol, limit=limit, now=datetime.now(UTC))


@router.get("/sessions", response_model=list[ReplaySessionSummaryOut])
def list_sessions(
    status: SessionStatus | None = None,
    limit: int = Query(default=20, ge=1, le=100),
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> list[dict[str, Any]]:
    return svc_mod.list_sessions(db, user.id, status=status, limit=limit)


# -- one session --------------------------------------------------------------------------------------------


@router.post(
    "/sessions",
    response_model=ReplaySessionOut,
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {"application/json": {"schema": {"$ref": "#/components/schemas/ReplaySessionV1"}}},
        }
    },
)
def create_session(
    raw: Any = Depends(_json_body),
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
    services: Services = Depends(get_services),
) -> dict[str, Any]:
    """Start a practice session from a `ReplaySessionV1`: validates the day and its data, snapshots the armed
    strategy versions, and computes the would-fire signals (held back until the playhead reaches them). One
    active session per symbol and day: a second POST returns the existing one; after `end` it is attempt n + 1."""
    spec = _validated(ReplaySessionV1, raw)
    row = _call(svc_mod.create, db, user.id, spec, services)
    return svc_mod.session_out(_call(svc_mod.context, db, services, row))


@router.get("/sessions/{session_id}", response_model=ReplaySessionOut)
def get_session_state(
    session_id: int,
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
    services: Services = Depends(get_services),
) -> dict[str, Any]:
    row = _call(svc_mod.get_row, db, user.id, session_id)
    return svc_mod.session_out(_call(svc_mod.context, db, services, row))


@router.patch("/sessions/{session_id}", response_model=ReplaySessionOut)
def patch_session(
    session_id: int,
    body: ReplaySessionPatch,
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
    services: Services = Depends(get_services),
) -> dict[str, Any]:
    """Notes and the self-rating only; a key left out is left alone, `null` clears it."""
    return _call(
        svc_mod.patch,
        db,
        user.id,
        session_id,
        services,
        notes=body.notes,
        rating=body.rating,
        fields=set(body.model_fields_set),
    )


# -- the playhead -------------------------------------------------------------------------------------------


@router.post("/sessions/{session_id}/advance", response_model=AdvanceOut)
def advance_session(
    session_id: int,
    body: AdvanceIn,
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
    services: Services = Depends(get_services),
) -> dict[str, Any]:
    return _call(
        svc_mod.advance,
        db,
        user.id,
        session_id,
        services,
        to=body.to,
        step=body.step,
        interval=body.interval,
        min_size=body.min_size,
        min_notional=body.min_notional,
        max_prints=body.max_prints,
    )


@router.get("/sessions/{session_id}/feed", response_model=FeedOut)
def session_feed(
    session_id: int,
    interval: Interval | None = None,
    min_size: int = Query(default=0, ge=0, le=1_000_000),
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
    services: Services = Depends(get_services),
) -> dict[str, Any]:
    return _call(svc_mod.feed, db, user.id, session_id, services, interval=interval, min_size=min_size)


# -- practice marks -----------------------------------------------------------------------------------------


@router.post(
    "/sessions/{session_id}/marks",
    response_model=MarkResultOut,
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {"application/json": {"schema": {"type": "object", "description": "A PracticeMarkV1"}}},
        }
    },
)
def place_mark(
    session_id: int,
    raw: Any = Depends(_json_body),
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
    services: Services = Depends(get_services),
) -> dict[str, Any]:
    """Place a practice mark at the playhead: the server stamps the time and the last print's price."""
    mark = _validated(PracticeMarkV1, raw).root.model_dump(mode="json", by_alias=True, exclude_none=True)
    return _call(svc_mod.place_mark, db, user.id, session_id, services, mark)


@router.delete("/sessions/{session_id}/marks/{mark_id}", response_model=MarkUndoOut)
def undo_mark(
    session_id: int,
    mark_id: int,
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
    services: Services = Depends(get_services),
) -> dict[str, Any]:
    """Undo the last mark, only while the playhead has not moved since it was placed (else 409)."""
    return _call(svc_mod.undo_mark, db, user.id, session_id, mark_id, services)


@router.post("/sessions/{session_id}/end", response_model=ReplaySessionOut)
def end_session(
    session_id: int,
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
    services: Services = Depends(get_services),
) -> dict[str, Any]:
    """Auto-exit an open trade at the last price, reveal the whole window, and store the final journal. Idempotent."""
    return _call(svc_mod.end, db, user.id, session_id, services)
