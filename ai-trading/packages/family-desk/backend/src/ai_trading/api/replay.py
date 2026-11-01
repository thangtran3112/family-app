"""`/api/desk/replay/*` (02o §b): the Practice lane. Ten routes (02o), the recorded universe (02o-b2), seven for
daily-list practice (02o-b v1: the hub plan read, open or advance the next day list, read, star, start the day's
session, end the day; 02o-b2: the re-scan at the day clock; plus the D-012 relist route), six for practice threads
(02r: create, list, read with stats and curve, edit the plan, close, the ledger) and five for swing practice (02p:
the universe preview, the holds, the weeks and one week's review and notes), all behind the gateway identity, all
scoped to the signed-in user (a non-owner gets 404), all `Cache-Control: no-store`.

The day-list, open-next, thread and session routes serve a swing thread too: they dispatch on the plan's mode, so a day
thread's responses are exactly what they were and a swing thread's carry the extra (additive) shapes of
`schemas/swing.py`. The two day-list responses and open-next are a union of the day model and the swing one (`kind` is
`"swing"` on the swing model).

Nothing in these paths reaches a broker or an account: a practice mark is a record on a finished past day
(`/replay/sessions/{id}/marks`), and a practice order (`/replay/sessions/{id}/orders`: a limit, stop or stop-limit
entry that waits on the replayed tape) is the one simulated order the Desk has. The route guard in
`tests/api/test_mvp_routes.py` names exactly those two paths. The server owns the playhead (`replay/session.py`):
nothing past `revealed_through` leaves it.

Request bodies are the contracts (`ReplaySessionV1`, `PracticeMarkV1`, `PracticeBlockV1`, `PracticeThreadCreateV1`,
`PracticeThreadPatchV1`), validated by hand so a
failure is the plain `422 {"detail": {"problems": [...]}}` list. `DESK_REPLAY_STUB=1` swaps the data sources for
the trimmed R0 fixture (`replay/fixture.py`); the services themselves run unchanged.
"""

import logging
import threading
from datetime import UTC, date, datetime
from typing import Any, Literal

from ai_trading_common.errors import ProviderError
from ai_trading_common.registry import DataSources
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request, Response
from pydantic import ValidationError
from sqlalchemy.orm import Session

from ai_trading.api.auth import AuthedUser, get_current_user, get_data_sources, get_session
from ai_trading.api.problems import problems_from_validation_error
from ai_trading.api.schemas.replay import (
    AdvanceIn,
    AdvanceOut,
    DailyOut,
    DayListOut,
    DayListPatch,
    DayRelistIn,
    DaySessionIn,
    FeedOut,
    Interval,
    MarkResultOut,
    MarkUndoOut,
    OpenNextOut,
    OrderCancelOut,
    OrderIn,
    OrderResultOut,
    ReplayDaysOut,
    ReplaySessionOut,
    ReplaySessionPatch,
    ReplaySessionSummaryOut,
    SessionStatus,
    UniverseDaysOut,
)
from ai_trading.api.schemas.swing import (
    HoldsOut,
    SwingDayListOut,
    SwingOpenNextOut,
    SwingUniversePreviewIn,
    SwingUniversePreviewOut,
    WeekOut,
    WeekPatch,
    WeeksOut,
)
from ai_trading.api.schemas.threads import ThreadLedgerOut, ThreadOut, ThreadSummaryOut
from ai_trading.contracts.practice_block import PracticeBlockV1
from ai_trading.contracts.practice_thread import PracticeThreadCreateV1, PracticeThreadPatchV1
from ai_trading.contracts.replay_session import PracticeMarkV1, ReplaySessionV1
from ai_trading.db.engine import session_scope
from ai_trading.replay import days as days_mod
from ai_trading.replay import fixture, swing_weeks
from ai_trading.replay import plan as plan_mod
from ai_trading.replay import session as svc_mod
from ai_trading.replay import swing as swing_mod
from ai_trading.replay import threads as threads_mod
from ai_trading.replay import universe_days as universe_mod
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
        stub = fixture.stub_enabled()
        source = fixture.fixture_sources(sources) if stub else sources
        # The day list's earnings flag asks the live calendar providers; the stub fixture has none to ask.
        cached = Services(history=History(source), tape=Tape(source), sources=None if stub else source)
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


def _validated[T](model: type[T], raw: Any, rule_path: str = "window") -> T:
    try:
        return model.model_validate(raw)  # type: ignore[attr-defined]
    except ValidationError as exc:
        problems = problems_from_validation_error(exc)
        # A rule on the whole object (the window rules) has no field path; they are about the window.
        raise HTTPException(
            status_code=422,
            detail={"problems": [{**p, "path": p["path"] or rule_path} for p in problems]},
        ) from None


def _call[T](fn, *args, **kwargs) -> T:
    """Run a service function, turning its rejections into the plain HTTP errors of 02m §a1."""
    try:
        return fn(*args, **kwargs)
    except threads_mod.ThreadNotFound:
        raise HTTPException(status_code=404, detail="practice thread not found") from None
    except SessionNotFound:
        raise _not_found() from None
    except ReplayProblem as exc:
        raise _problem(exc.message, exc.path, exc.status) from None
    except ReplayDayError as exc:
        raise _problem(exc.message, exc.path) from None
    except ProviderError as exc:
        log.warning("replay data unavailable: %s", exc)
        raise HTTPException(status_code=503, detail="Market data is unavailable right now · try again") from None


def _with_thread(db: Session, out: dict[str, Any], thread_id: int | None, day_list_id: int | None) -> dict[str, Any]:
    """Add the thread header strip (the SIMULATED balance and the day's realized P/L) to a response dict."""
    return {**out, "thread": threads_mod.brief(db, thread_id, day_list_id)}


# -- notable days and the session list -----------------------------------------------------------------------


@router.get("/days", response_model=ReplayDaysOut)
def list_days(
    symbol: str | None = Query(default=None, max_length=10, pattern=r"^[A-Z][A-Z0-9.]*$"),
    limit: int = Query(default=20, ge=1, le=100),
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> dict[str, Any]:
    return days_mod.list_days(db, user.id, symbol=symbol, limit=limit, now=datetime.now(UTC))


@router.get("/universe-days", response_model=UniverseDaysOut)
def get_universe_days(
    day: date | None = None,
    db: Session = Depends(get_session),
    services: Services = Depends(get_services),
) -> dict[str, Any]:
    """The recorded universe (02o-b2): which mornings the Desk recorded the names it scanned, the first day a new plan
    defaults to once 20 finished days are recorded, and with `day` that morning's membership. A day without a recording
    scans today's Desk set, and says so."""
    return universe_mod.read(db, day, services.now())


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
    return _with_thread(
        db, svc_mod.session_out(_call(svc_mod.context, db, services, row)), row.thread_id, row.day_list_id
    )


@router.get("/sessions/{session_id}", response_model=ReplaySessionOut)
def get_session_state(
    session_id: int,
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
    services: Services = Depends(get_services),
) -> dict[str, Any]:
    row = _call(svc_mod.get_row, db, user.id, session_id)
    return _with_thread(
        db, svc_mod.session_out(_call(svc_mod.context, db, services, row)), row.thread_id, row.day_list_id
    )


@router.patch("/sessions/{session_id}", response_model=ReplaySessionOut)
def patch_session(
    session_id: int,
    body: ReplaySessionPatch,
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
    services: Services = Depends(get_services),
) -> dict[str, Any]:
    """Notes and the self-rating only; a key left out is left alone, `null` clears it."""
    out = _call(
        svc_mod.patch,
        db,
        user.id,
        session_id,
        services,
        notes=body.notes,
        rating=body.rating,
        fields=set(body.model_fields_set),
    )
    return _with_thread(db, out, out["thread_id"], out["day_list_id"])


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
    min_notional: int = Query(default=0, ge=0, le=1_000_000_000),
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
    services: Services = Depends(get_services),
) -> dict[str, Any]:
    return _call(
        svc_mod.feed, db, user.id, session_id, services, interval=interval, min_size=min_size, min_notional=min_notional
    )


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
    out = _call(svc_mod.place_mark, db, user.id, session_id, services, mark)
    row = svc_mod.get_row(db, user.id, session_id)
    return _with_thread(db, out, row.thread_id, row.day_list_id)


@router.delete("/sessions/{session_id}/marks/{mark_id}", response_model=MarkUndoOut)
def undo_mark(
    session_id: int,
    mark_id: int,
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
    services: Services = Depends(get_services),
) -> dict[str, Any]:
    """Undo the last mark, only while the playhead has not moved since it was placed (else 409)."""
    out = _call(svc_mod.undo_mark, db, user.id, session_id, mark_id, services)
    row = svc_mod.get_row(db, user.id, session_id)
    return _with_thread(db, out, row.thread_id, row.day_list_id)


@router.post("/sessions/{session_id}/orders", response_model=OrderResultOut)
def place_order(
    session_id: int,
    raw: Any = Depends(_json_body),
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
    services: Services = Depends(get_services),
) -> dict[str, Any]:
    """Place a limit, stop or stop-limit practice entry. It fills only on a later one-minute bar of the replayed tape
    (or at once at the last print when a limit already accepts it); a market entry is a mark."""
    body = _validated(OrderIn, raw, rule_path="orderType").model_dump(exclude_none=True)
    out = _call(svc_mod.place_order, db, user.id, session_id, services, body)
    row = svc_mod.get_row(db, user.id, session_id)
    return _with_thread(db, out, row.thread_id, row.day_list_id)


@router.delete("/sessions/{session_id}/orders/{order_id}", response_model=OrderCancelOut)
def cancel_order(
    session_id: int,
    order_id: int,
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
    services: Services = Depends(get_services),
) -> dict[str, Any]:
    """Cancel a working practice order (409 once it has filled or been cancelled)."""
    return _call(svc_mod.cancel_order, db, user.id, session_id, order_id, services)


@router.post("/sessions/{session_id}/end", response_model=ReplaySessionOut)
def end_session(
    session_id: int,
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
    services: Services = Depends(get_services),
) -> dict[str, Any]:
    """Auto-exit an open trade at the last price, reveal the whole window, and store the final journal. Idempotent."""
    out = _call(svc_mod.end, db, user.id, session_id, services)
    return _with_thread(db, out, out["thread_id"], out["day_list_id"])


# -- daily-list practice (02o-b v1) ---------------------------------------------------------------------------


def _prep_in_background(app: Any, services: Services, plan_id: int) -> None:
    """Fetch the plan's bars once, on its own session, after the response. A process without a session factory
    (a test) skips it: the tests call `plan.run_prep` directly."""
    factory = getattr(app.state, "session_factory", None)
    if factory is None:
        return
    try:
        with session_scope(factory) as db:
            plan_mod.run_prep(db, services, plan_id)
    except Exception:  # noqa: BLE001 -- a dead prep is picked up again by the next open (it goes stale)
        log.exception("daily-list prep failed for plan %s", plan_id)


_PREPARING: set[tuple[int, str]] = set()  # (user, symbol) pairs a pool prep in this process is fetching right now
_PREPARING_LOCK = threading.Lock()


def _pool_prep_in_background(
    app: Any, services: Services, user_id: int, req: swing_mod.PreviewRequest, symbols: list[str]
) -> None:
    """Fetch the pool symbols the preview could not afford, on their own session after the response. The setup form
    polls the preview while it says "preparing", so a pair already being fetched here is skipped (ponytail: per
    process; a second worker would fetch the same symbol twice, which the write-once blob cache makes harmless)."""
    factory = getattr(app.state, "session_factory", None)
    if factory is None:
        return
    with _PREPARING_LOCK:
        mine = [symbol for symbol in symbols if (user_id, symbol) not in _PREPARING]
        _PREPARING.update((user_id, symbol) for symbol in mine)
    try:
        if mine:
            with session_scope(factory) as db:
                swing_mod.pool_prep(db, services, user_id, req, mine)
    except Exception:  # noqa: BLE001 -- the next preview call finds what is still missing and asks again
        log.exception("swing pool prep failed for user %s", user_id)
    finally:
        with _PREPARING_LOCK:
            _PREPARING.difference_update((user_id, symbol) for symbol in mine)


@router.get("/daily", response_model=DailyOut)
def get_daily(
    thread_id: int | None = Query(default=None, alias="threadId", ge=1),
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> dict[str, Any]:
    """The daily-list card: a plan and where its cursor is, and its thread with its SIMULATED balance and stats; either
    is `null` before she has one. `threadId` names the thread whose plan to read (404 when it is not hers); without it
    the answer is her most recently started active day thread."""
    return _call(plan_mod.hub, db, user.id, thread_id)


@router.post(
    "/daily/next",
    response_model=OpenNextOut | SwingOpenNextOut,
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {
                "application/json": {
                    "schema": {
                        "type": "object",
                        "properties": {
                            "plan": {"$ref": "#/components/schemas/PracticeBlockV1"},
                            "threadId": {"type": "integer", "minimum": 1},
                        },
                        "additionalProperties": False,
                    }
                }
            },
        }
    },
)
def open_next(
    request: Request,
    background: BackgroundTasks,
    raw: Any = Depends(_json_body),
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
    services: Services = Depends(get_services),
) -> dict[str, Any]:
    """Open the next day's list, or continue the current one. A body with a `plan` (a `PracticeBlockV1`) first saves
    that plan, replacing hers, and starts preparing its data in the background. While the data is not ready the
    answer carries no `day_list_id`; poll `GET /replay/daily`. Days open in order, one at a time.

    A new plan binds to a practice thread: `threadId`, else her active day thread (a closed or missing one is a 409
    in plain words). The thread, not the plan, carries the risk plan (D-007): `setup.plan` and `setup.shares` from an
    old client are ignored.

    `{"threadId": n}` alone continues that thread: a SWING thread's calendar (it has no plan to send: its universe is
    frozen with the thread; the answer is `kind: "swing"`), or a day thread's current plan. `{}` continues her most
    recently started day thread."""
    if not isinstance(raw, dict) or set(raw) - {"plan", "threadId"}:
        raise _problem('Send {} to continue, or {"plan": ..., "threadId": ...} to start a plan', "")
    started = raw.get("plan") is not None
    thread_id = raw.get("threadId")
    if thread_id is not None and (isinstance(thread_id, bool) or not isinstance(thread_id, int)):
        raise _problem("Send threadId, a whole number", "threadId")
    swing_thread_id = None
    if thread_id is not None and not started:
        swing_thread_id = thread_id if _call(threads_mod.get_thread, db, user.id, thread_id).mode == "swing" else None
    if started:
        block = _validated(PracticeBlockV1, plan_mod.without_legacy_plan_fields(raw["plan"]))
        thread = _call(threads_mod.resolve_for_plan, db, user.id, thread_id)
        _call(plan_mod.create_plan, db, user.id, block, services, thread)
        thread_id = thread.id
    opened = _call(plan_mod.open_next, db, user.id, services, thread_id)
    if started or opened.restart_prep:
        # The task runs on its own session while this request's one is still open (FastAPI closes a yield dependency
        # after the response and its background tasks), so the plan must be committed before the task can see it.
        db.commit()
        background.add_task(_prep_in_background, request.app, services, opened.plan.id)
    out = {
        "plan": plan_mod.plan_out(db, opened.plan),
        "day_list_id": None if opened.day_list is None else opened.day_list.id,
    }
    return out if swing_thread_id is None else {"kind": "swing", **out}


@router.get("/day-lists/{day_list_id}", response_model=DayListOut | SwingDayListOut)
def get_day_list(
    day_list_id: int,
    peek: str | None = Query(default=None, max_length=10, pattern=r"^[A-Z][A-Z0-9.]*$"),
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
    services: Services = Depends(get_services),
) -> dict[str, Any]:
    """One practice day: the frozen candidate list as of `data_through`, her stars, the day clock, the day's
    session, and (with `peek`) the pre-open chart data of one candidate. The review and the day journal are null
    until the day has ended. A swing thread's day is the board as of the prior close (`SwingDayListOut`)."""
    return _call(plan_mod.day_list_out, db, user.id, day_list_id, services, peek=peek)


@router.patch("/day-lists/{day_list_id}", response_model=DayListOut | SwingDayListOut)
def patch_day_list(
    day_list_id: int,
    body: DayListPatch,
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
    services: Services = Depends(get_services),
) -> dict[str, Any]:
    """Stars (at most 20 names from the list, each stamped with the day clock), notes and the self-rating."""
    _call(
        plan_mod.patch_day_list,
        db,
        user.id,
        day_list_id,
        services,
        watch=body.watch,
        notes=body.notes,
        rating=body.rating,
        fields=set(body.model_fields_set),
    )
    return _call(plan_mod.day_list_out, db, user.id, day_list_id, services)


@router.post("/day-lists/{day_list_id}/relist", response_model=DayListOut)
def relist_day_list(
    day_list_id: int,
    body: DayRelistIn,
    request: Request,
    background: BackgroundTasks,
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
    services: Services = Depends(get_services),
) -> dict[str, Any]:
    """Re-list a day she has not started at a later list time: moves the open plan's list time (the practice window
    follows when it would start before the list) and rebuilds this day's list on today's Desk universe. The plan's
    list-time rules answer 422; a day under way or on a replaced plan is a 409. When the universe grew and its bars
    are not ready the list stays as it was while the data prepares: re-list again then."""
    opened = _call(plan_mod.relist, db, user.id, day_list_id, body.listAt, services)
    if opened.restart_prep:
        db.commit()  # see `open_next`: the task runs on its own session
        background.add_task(_prep_in_background, request.app, services, opened.plan.id)
    return _call(plan_mod.day_list_out, db, user.id, day_list_id, services)


@router.post("/day-lists/{day_list_id}/sessions", response_model=ReplaySessionOut)
def start_day_session(
    day_list_id: int,
    body: DaySessionIn,
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
    services: Services = Depends(get_services),
) -> dict[str, Any]:
    """Open one name from the list and practise it, built from the plan's setup, starting at the day clock. Any list
    name opens, and a position open on another name never blocks the switch."""
    row = _call(plan_mod.start_session, db, user.id, day_list_id, body.symbol, services)
    return _with_thread(
        db, svc_mod.session_out(_call(svc_mod.context, db, services, row)), row.thread_id, row.day_list_id
    )


@router.post("/day-lists/{day_list_id}/rescan", response_model=DayListOut)
def rescan_day(
    day_list_id: int,
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
    services: Services = Depends(get_services),
) -> dict[str, Any]:
    """Re-run the day's filters at the day clock (02o-b2). The answer is the day list with `rescan` set to the new scan,
    labelled with the clock it ran at; the frozen list, stars and review are untouched. A 409 before the first name is
    practised (no clock yet) and after the day ends. A second scan at the same clock returns the first."""
    _call(plan_mod.rescan, db, user.id, day_list_id, services)
    return _call(plan_mod.day_list_out, db, user.id, day_list_id, services)


@router.post("/day-lists/{day_list_id}/end", response_model=DayListOut | SwingDayListOut)
def end_day(
    day_list_id: int,
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
    services: Services = Depends(get_services),
) -> dict[str, Any]:
    """End the day: the open practice trade exits at the last price, the window unseals, and the list review
    (every candidate's move from its list price) is stored and served. Idempotent. A swing day exits nothing: the open
    holds are marked at the close, and a day with no session is a Pass."""
    _call(plan_mod.end_day, db, user.id, day_list_id, services)
    return _call(plan_mod.day_list_out, db, user.id, day_list_id, services)


# -- practice threads (02r) -------------------------------------------------------------------------------------


@router.post(
    "/threads",
    response_model=ThreadOut,
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {"application/json": {"schema": {"type": "object", "description": "A PracticeThreadCreateV1"}}},
        }
    },
)
def create_thread(
    request: Request,
    background: BackgroundTasks,
    raw: Any = Depends(_json_body),
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
    services: Services = Depends(get_services),
) -> dict[str, Any]:
    """Start a practice thread from a `PracticeThreadCreateV1`: a SIMULATED starting balance (default 50,000), the
    risk plan, and the mode (`day`, or `swing` with its `swing` block). Any number of threads of a mode may be active,
    each with its own plan and balance. A swing thread freezes its universe and calendar here, after the days, the data
    and the arms check out (every rejection is a plain problem), and starts preparing its bars in the background."""
    swing = isinstance(raw, dict) and raw.get("mode") == "swing"
    spec = _validated(PracticeThreadCreateV1, raw, "swing" if swing else "plan")
    if not swing:
        row = _call(threads_mod.create_thread, db, user.id, spec, services.now())
        return threads_mod.detail(db, row)
    row, plan = _call(swing_mod.create_thread, db, user.id, spec, services)
    db.commit()  # the prep runs on its own session: the plan must be visible to it
    background.add_task(_prep_in_background, request.app, services, plan.id)
    return threads_mod.detail(db, row)


@router.post("/threads/swing-universe", response_model=SwingUniversePreviewOut)
def preview_swing_universe(
    request: Request,
    background: BackgroundTasks,
    body: SwingUniversePreviewIn,
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
    services: Services = Depends(get_services),
) -> dict[str, Any]:
    """The universe table of a swing thread's setup form (02p c1), every figure as of the close before the first day.
    Nothing is saved but the bar cache. Her own picks are fetched first; what the request's time budget could not reach
    is `pending` and fetched in the background, so the form calls this again while `state` is `preparing`."""
    req = swing_mod.PreviewRequest(
        first_day=body.first_day,
        sessions=body.sessions,
        watchlist_ids=tuple(body.watchlist_ids),
        filter_ids=tuple(body.filter_ids),
        fill=body.fill,
        add=tuple(body.add),
        remove=tuple(body.remove),
        target=body.target,
    )
    result = _call(swing_mod.preview, db, user.id, req, services)
    db.commit()  # the preview cached bars through this session; the background prep and the next call read them
    if result.pending:
        background.add_task(_pool_prep_in_background, request.app, services, user.id, req, result.pending)
    return {**result.body, "label": result.body["survivorship"], "pending_symbols": len(result.pending)}


@router.get("/threads", response_model=list[ThreadSummaryOut])
def list_threads(
    user: AuthedUser = Depends(get_current_user), db: Session = Depends(get_session)
) -> list[dict[str, Any]]:
    """Her threads, the active ones first, each with its plan, stats and today (the hub's resume list)."""
    return threads_mod.list_threads(db, user.id)


@router.get("/threads/{thread_id}", response_model=ThreadOut)
def get_thread(
    thread_id: int, user: AuthedUser = Depends(get_current_user), db: Session = Depends(get_session)
) -> dict[str, Any]:
    """One thread: its plan, stats, today, the daily P/L series (one row per ended day) and the balance curve. Every
    figure is read back from the ledger; nothing is stored twice."""
    return threads_mod.detail(db, _call(threads_mod.get_thread, db, user.id, thread_id))


@router.patch(
    "/threads/{thread_id}",
    response_model=ThreadOut,
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {"application/json": {"schema": {"type": "object", "description": "A PracticeThreadPatchV1"}}},
        }
    },
)
def patch_thread(
    thread_id: int,
    raw: Any = Depends(_json_body),
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
    services: Services = Depends(get_services),
) -> dict[str, Any]:
    """Replace the risk plan while the thread is active (a closed thread is a 409). It applies from the next session:
    a session already started keeps the plan it began with."""
    spec = _validated(PracticeThreadPatchV1, raw, "plan")
    row = _call(threads_mod.patch_thread, db, user.id, thread_id, spec, services.now())
    return threads_mod.detail(db, row)


@router.post("/threads/{thread_id}/close", response_model=ThreadOut)
def close_thread(
    thread_id: int,
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
    services: Services = Depends(get_services),
) -> dict[str, Any]:
    """Close the thread: its daily plan is archived and its plan and balance freeze. An open practice day is a 409 (end
    it first). A swing thread's open holds exit at the last ended close and its open week is frozen with its review.
    Idempotent."""
    row = _call(threads_mod.close_thread, db, user.id, thread_id, services.now(), services)
    return threads_mod.detail(db, row)


@router.delete("/threads/{thread_id}", status_code=204, response_model=None)
def delete_thread(
    thread_id: int, user: AuthedUser = Depends(get_current_user), db: Session = Depends(get_session)
) -> Response:
    """Delete the thread and everything under it: its ledger, plans, day lists, sessions and (swing) holds and weeks. An
    open practice day is a 409 (end it first), like closing. It cannot be undone; a thread that is not hers is a 404."""
    _call(threads_mod.delete_thread, db, user.id, thread_id)
    return Response(status_code=204)


@router.get("/threads/{thread_id}/ledger", response_model=ThreadLedgerOut)
def get_thread_ledger(
    thread_id: int,
    limit: int = Query(default=100, ge=1, le=threads_mod.LEDGER_LIMIT),
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> dict[str, Any]:
    """The thread's realized practice trades (`PracticeLedgerEntryV1`), newest first: the rows its balance is of."""
    return threads_mod.ledger_page(db, _call(threads_mod.get_thread, db, user.id, thread_id), limit=limit)


# -- swing threads (02p): holds and weeks -----------------------------------------------------------------------


def _swing_thread(db: Session, user_id: int, thread_id: int):
    """The thread when it is hers and a swing thread (a day thread has no holds or weeks: 404)."""
    thread = _call(threads_mod.get_thread, db, user_id, thread_id)
    if thread.mode != "swing":
        raise HTTPException(status_code=404, detail="swing threads only")
    return thread


@router.get("/threads/{thread_id}/holds", response_model=HoldsOut)
def get_thread_holds(
    thread_id: int,
    status: Literal["open", "closed", "all"] = "all",
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
    services: Services = Depends(get_services),
) -> dict[str, Any]:
    """The thread's practice holds in entry order, each with its P/L. An open hold is marked at the LAST ENDED day's
    close, never at a later price."""
    thread = _swing_thread(db, user.id, thread_id)
    return _call(swing_weeks.holds_out, db, services, thread, status)


@router.get("/threads/{thread_id}/weeks", response_model=WeeksOut)
def get_thread_weeks(
    thread_id: int, user: AuthedUser = Depends(get_current_user), db: Session = Depends(get_session)
) -> dict[str, Any]:
    """One row per week opened so far: its days, status and the headline figures of its review."""
    return _call(swing_weeks.weeks_out, db, _swing_thread(db, user.id, thread_id))


@router.get("/threads/{thread_id}/weeks/{week_no}", response_model=WeekOut)
def get_thread_week(
    thread_id: int,
    week_no: int,
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
    services: Services = Depends(get_services),
) -> dict[str, Any]:
    """The frozen review of a finished week, or "Week to date" (`to_date` is `yes`) for the open one, computed on read
    through the last ended close. A week that has not started, or has no finished day yet, is a 404."""
    return _call(swing_weeks.week_out, db, services, _swing_thread(db, user.id, thread_id), week_no)


@router.patch("/threads/{thread_id}/weeks/{week_no}", response_model=WeekOut)
def patch_thread_week(
    thread_id: int,
    week_no: int,
    body: WeekPatch,
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
    services: Services = Depends(get_services),
) -> dict[str, Any]:
    """Notes and the self-rating of a week; a key left out is left alone, `null` clears it."""
    thread = _swing_thread(db, user.id, thread_id)
    _call(
        swing_weeks.patch_week,
        db,
        thread,
        week_no,
        notes=body.notes,
        rating=body.rating,
        fields=set(body.model_fields_set),
        now=services.now(),
    )
    return _call(swing_weeks.week_out, db, services, thread, week_no)
