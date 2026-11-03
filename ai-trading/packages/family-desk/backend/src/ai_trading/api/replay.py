"""`/api/desk/replay/*` (02o §b, rewritten by ADR-0025): the freestyle Practice lane.

A practice thread is a SIMULATED paper account with ONE clock. Its routes: the thread (create with its setup, list,
read, edit the plan, `PUT setup`, close, delete, the ledger, the fills, the capacity), its clock (`GET`/`POST
/threads/{id}/clock`: play, pause, speed, a step or a Jump, all forward only), its Portfolio
(`GET /threads/{id}/portfolio`), its Screen (`GET`/`PATCH /threads/{id}/screen`, `POST .../screen/rescan`) and its
lanes (`POST /threads/{id}/lanes`); then a lane's own routes (`/sessions/{id}`: read, patch notes and rating,
`advance` with `sync` only, the feed, marks, orders). There is no day to open, list, skip or end, and no swing thread.

Everything is behind the gateway identity and scoped to the signed-in user (a non-owner gets 404), all `Cache-Control:
no-store`. Nothing in these paths reaches a broker or an account: a practice mark is a record on a finished past
(`/replay/sessions/{id}/marks`), and a practice order (`/replay/sessions/{id}/orders`: a limit, stop or stop-limit that
waits on the replayed tape, GTC or Day) is the one simulated order the Desk has. The route guard in
`tests/api/test_mvp_routes.py` names exactly those two paths. The server owns the clock (`replay/clock.py`) and every
lane's playhead (`replay/session.py`): nothing past them leaves it.

Request bodies are the contracts (`ReplaySessionV1`, `PracticeMarkV1`, `PracticeSetupV2`, `PracticeThreadCreateV1`,
`PracticeThreadPatchV1`), validated by hand so a failure is the plain `422 {"detail": {"problems": [...]}}` list.
`DESK_REPLAY_STUB=1` swaps the data sources for the trimmed R0 fixture (`replay/fixture.py`); the services themselves
run unchanged.
"""

import logging
import threading
from collections.abc import Callable
from datetime import date
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
    LaneIn,
    MarkResultOut,
    MarkUndoOut,
    OrderCancelOut,
    OrderIn,
    OrderResultOut,
    PortfolioOut,
    ReplaySessionOut,
    ReplaySessionPatch,
    ScreenOut,
    ScreenPatch,
    UniverseDaysOut,
)
from ai_trading.api.schemas.threads import (
    ClockIn,
    ThreadCapacityOut,
    ThreadClockOut,
    ThreadFillsOut,
    ThreadLedgerOut,
    ThreadOut,
    ThreadSummaryOut,
)
from ai_trading.contracts.practice_setup import PracticeSetupV2
from ai_trading.contracts.practice_thread import PracticeThreadCreateV1, PracticeThreadPatchV1
from ai_trading.contracts.replay_session import PracticeMarkV1
from ai_trading.db.engine import session_scope
from ai_trading.replay import clock as clock_mod
from ai_trading.replay import fixture
from ai_trading.replay import ledger as ledger_mod
from ai_trading.replay import plan as plan_mod
from ai_trading.replay import session as svc_mod
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


def _with_thread(db: Session, out: dict[str, Any], thread_id: int | None) -> dict[str, Any]:
    """Add the thread header strip (the SIMULATED balance) to a response dict."""
    return {**out, "thread": threads_mod.brief(db, thread_id)}


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


# -- one session --------------------------------------------------------------------------------------------


@router.get("/sessions/{session_id}", response_model=ReplaySessionOut)
def get_session_state(
    session_id: int,
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
    services: Services = Depends(get_services),
) -> dict[str, Any]:
    row = _call(svc_mod.get_row, db, user.id, session_id)
    _call(svc_mod.settle_thread, db, services, row.thread_id)  # a running thread clock has moved (ADR-0018)
    return _with_thread(db, svc_mod.session_out(_call(svc_mod.context, db, services, row)), row.thread_id)


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
    return _with_thread(db, out, out["thread_id"])


# -- the playhead -------------------------------------------------------------------------------------------


@router.post("/sessions/{session_id}/advance", response_model=AdvanceOut)
def advance_session(
    session_id: int,
    body: AdvanceIn,
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
    services: Services = Depends(get_services),
) -> dict[str, Any]:
    """Follow the thread's clock (`sync`): the only thing a name may do to time. `to` and `step` are a 422 (a name does
    not move the thread's time; the thread's clock does, forward only)."""
    return _call(
        svc_mod.advance,
        db,
        user.id,
        session_id,
        services,
        to=body.to,
        step=body.step,
        sync=body.sync,
        since=body.since,
        interval=body.interval,
        min_size=body.min_size,
        min_notional=body.min_notional,
        max_prints=body.max_prints,
    )


@router.get("/sessions/{session_id}/feed", response_model=FeedOut)
def session_feed(
    session_id: int,
    request: Request,
    interval: Interval | None = None,
    min_size: int = Query(default=0, ge=0, le=1_000_000),
    min_notional: int = Query(default=0, ge=0, le=1_000_000_000),
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
    services: Services = Depends(get_services),
) -> dict[str, Any]:
    out = _call(
        svc_mod.feed, db, user.id, session_id, services, interval=interval, min_size=min_size, min_notional=min_notional
    )
    if interval is not None and out["market"] is not None:
        # A chart switched interval: this name's series was built in the request; prepare the rest of the Screen's names
        # at it in the background, so the next name she opens is a slice too.
        _warm_screen(db, request, services, svc_mod.get_row(db, user.id, session_id).day_list_id, interval)
    return out


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
    return _with_thread(db, out, row.thread_id)


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
    return _with_thread(db, out, row.thread_id)


@router.post("/sessions/{session_id}/orders", response_model=OrderResultOut)
def place_order(
    session_id: int,
    raw: Any = Depends(_json_body),
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
    services: Services = Depends(get_services),
) -> dict[str, Any]:
    """Place a limit, stop or stop-limit practice order, GTC (default) or Day (`timeInForce`). It fills when the
    thread's clock crosses a later one-minute bar that proves it, however many days that takes (or at once at the last
    print when a limit already accepts it); a market entry is a mark. A closing order is derived reduce-only."""
    body = _validated(OrderIn, raw, rule_path="orderType").model_dump(exclude_none=True)
    out = _call(svc_mod.place_order, db, user.id, session_id, services, body)
    row = svc_mod.get_row(db, user.id, session_id)
    return _with_thread(db, out, row.thread_id)


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


# -- daily-list practice (02o-b v1) ---------------------------------------------------------------------------


def _detach(task: Callable[..., None], *args: Any) -> None:
    """Run a slow job (a prep, a re-scan) on its own thread, never as a FastAPI `BackgroundTasks` entry.

    FastAPI closes a yield dependency (`get_session`: commit and close) only AFTER the response and its background
    tasks. A request that read a running thread clock after it queued its task (`settle_day` takes the day list's row
    lock) therefore kept that lock until the task ended, and a re-scan, which needs the same lock, waited on a request
    that was waiting for it: a deadlock Postgres cannot see. Every poll of the thread then queued behind the lock, each
    holding a pooled connection and a worker thread, until no route could get one (Cloudflare 524 on every
    `/api/desk/*`, 500 on the polls that timed out of the pool). A detached thread leaves the request to end at once.
    The caller has committed what the task reads (the task has its own session)."""
    threading.Thread(target=task, args=args, name=task.__name__, daemon=True).start()


_WARMING: set[tuple[int, str]] = set()  # (day list, interval) pairs being warmed in this process right now


_PREPARING: set[tuple[int, str]] = set()  # (user, symbol) pairs a pool prep in this process is fetching right now
_PREPARING_LOCK = threading.Lock()


@router.get("/threads/{thread_id}/screen", response_model=ScreenOut)
def get_screen(
    thread_id: int,
    peek: str | None = Query(default=None, max_length=10, pattern=r"^[A-Z][A-Z0-9.]*$"),
    live: bool = Query(default=False),
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
    services: Services = Depends(get_services),
) -> dict[str, Any]:
    """The thread's Screen (ADR-0025): the latest scan of her filters at the thread's time, her stars, the names she
    holds, and (with `peek`) the pre-open chart data of one candidate. With `live`, each candidate also carries `live`:
    the name priced at the thread's time (nothing later); the scan's values stay in the candidate itself."""
    return _call(plan_mod.screen_out, db, user.id, thread_id, services, peek=peek, live=live)


@router.patch("/threads/{thread_id}/screen", response_model=ScreenOut)
def patch_screen(
    thread_id: int,
    body: ScreenPatch,
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
    services: Services = Depends(get_services),
) -> dict[str, Any]:
    """Stars (at most 20 names from the Screen, each stamped with the thread's time), notes and the self-rating."""
    _call(
        plan_mod.patch_screen,
        db,
        user.id,
        thread_id,
        services,
        watch=body.watch,
        notes=body.notes,
        rating=body.rating,
        fields=set(body.model_fields_set),
    )
    return _call(plan_mod.screen_out, db, user.id, thread_id, services)


def _warm_in_background(app: Any, services: Services, day_list_id: int, interval: str | None) -> None:
    """Prepare the Screen's names at a chart interval on their own session, after the response (`plan.warm`): the decode
    work moves off the first read. One warm of a (Screen, interval) at a time in this process; a process without a
    session factory (a test) skips it, and a failed warm costs nothing (the first read builds the series)."""
    factory = getattr(app.state, "session_factory", None)
    key = (day_list_id, interval or "")
    if factory is None:
        return
    with _PREPARING_LOCK:
        if key in _WARMING:
            return
        _WARMING.add(key)
    try:
        with session_scope(factory) as db:
            plan_mod.warm(db, services, day_list_id, interval)
    except Exception:  # noqa: BLE001 -- the first read of an unprepared name builds it
        log.exception("screen warm failed for %s", day_list_id)
    finally:
        with _PREPARING_LOCK:
            _WARMING.discard(key)


def _warm_screen(
    db: Session, request: Request, services: Services, day_list_id: int | None, interval: str | None
) -> None:
    """Start a warm of the Screen's names after this request: the rows must be committed first."""
    if day_list_id is not None:
        db.commit()
        _detach(_warm_in_background, request.app, services, day_list_id, interval)


def _rescan_in_background(app: Any, services: Services, day_list_id: int, run: str) -> None:
    """Run the re-scan on its own session after the response, reporting progress on the day list's job. A process
    without a session factory (a test) skips it: the tests call `plan.run_rescan` directly. `run_rescan` closes its
    job as failed on any error, so a dead worker is only ever a dead process (the job then goes stale)."""
    factory = getattr(app.state, "session_factory", None)
    if factory is None:
        return
    with session_scope(factory) as db:
        plan_mod.run_rescan(db, services, day_list_id, run)


@router.post("/threads/{thread_id}/screen/rescan", response_model=ScreenOut)
def rescan_screen(
    thread_id: int,
    request: Request,
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
    services: Services = Depends(get_services),
) -> dict[str, Any]:
    """Start a re-scan of the Screen's filters at the thread's time (02o-b2) and answer at once: the Screen with
    `rescan_job` `running` and its `done` of `total` symbols read. Poll `GET /threads/{id}/screen` while it runs. When
    `state` is `done` the scan has REPOPULATED the Screen (its names, columns and counts are the scan's) and `rescan`
    labels it with the time it ran at. Stars and lanes stay; a name she holds or starred that the scan no longer matches
    stays on the Screen as `held_over`. A scan already running is joined, not doubled; a second scan at the same time
    starts nothing. A 409 on a closed thread and for a filter that cannot have bars at this time yet."""
    screen_id, run = _call(plan_mod.start_rescan, db, user.id, thread_id, services)
    if run is not None:
        db.commit()  # the task runs on its own session: the claim must be visible to it
        _detach(_rescan_in_background, request.app, services, screen_id, run)
    return _call(plan_mod.screen_out, db, user.id, thread_id, services)


# -- practice threads (02r) -------------------------------------------------------------------------------------


def _swing_closed() -> None:
    """ADR-0025 step 1: no new swing thread, whatever the body holds (409, before the body is read). The swing code
    below stays until the swing removal step; a swing test that needs a thread patches this to a no-op."""
    raise _problem(threads_mod.SWING_CLOSED, "mode", 409)


@router.post(
    "/threads",
    response_model=ThreadOut,
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {
                "application/json": {
                    "schema": {
                        "type": "object",
                        "description": "A PracticeThreadCreateV1, plus an optional `setup` (a PracticeSetupV2)",
                    }
                }
            },
        }
    },
)
def create_thread(
    request: Request,
    raw: Any = Depends(_json_body),
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
    services: Services = Depends(get_services),
) -> dict[str, Any]:
    """Start a freestyle practice thread from a `PracticeThreadCreateV1`: a SIMULATED starting balance (default 50,000)
    and the risk plan. A `setup` key beside them (a `PracticeSetupV2`: the start instant, her filters, the chart setup)
    also starts the thread's clock, paused at `startAt`, and its Screen. `mode: swing` is closed (409, ADR-0025).
    Threads share ten slots across all users (a full house is a 409 on `mode`; closing a thread frees a slot). Each
    thread has its own balance and its own `name` (the server gives it one: "Freestyle · Oct 15", "(2)" when she
    already has it)."""
    if isinstance(raw, dict) and raw.get("mode") == "swing":
        _swing_closed()
    setup = raw.get("setup") if isinstance(raw, dict) else None
    body = {key: value for key, value in raw.items() if key != "setup"} if isinstance(raw, dict) else raw
    spec = _validated(PracticeThreadCreateV1, body, "plan")
    setup_spec = None if setup is None else _validated(PracticeSetupV2, setup, "setup")
    row = _call(threads_mod.create_thread, db, user.id, spec, services.now())
    if setup_spec is not None:
        _call(plan_mod.create_plan, db, user.id, setup_spec, services, row)
    return threads_mod.detail(db, row)


@router.get("/threads", response_model=list[ThreadSummaryOut])
def list_threads(
    user: AuthedUser = Depends(get_current_user), db: Session = Depends(get_session)
) -> list[dict[str, Any]]:
    """Her threads, the active ones first, each with its plan, stats and today (the hub's resume list)."""
    return threads_mod.list_threads(db, user.id)


@router.get("/threads/capacity", response_model=ThreadCapacityOut)
def thread_capacity(user: AuthedUser = Depends(get_current_user), db: Session = Depends(get_session)) -> dict[str, int]:
    """The day-trade slots in use across all users and the most there can be (10). Declared before
    `/threads/{thread_id}`, which would otherwise read "capacity" as an id."""
    return threads_mod.capacity(db)


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
    """Replace the risk plan and the entry size (`shares`, a day thread only; left out clears it) while the thread is
    active (a closed thread is a 409). It applies from the next session: a session already started keeps the plan and
    the size it began with."""
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
    """Close the thread (ADR-0025 P1): its working orders are cancelled ("Thread closed"), its plan is archived and its
    clock freezes where it is. Every position stays open, valued at the frozen time; nothing is sold or booked.
    Idempotent."""
    row = _call(threads_mod.close_thread, db, user.id, thread_id, services.now(), services)
    return threads_mod.detail(db, row)


@router.delete("/threads/{thread_id}", status_code=204, response_model=None)
def delete_thread(
    thread_id: int, user: AuthedUser = Depends(get_current_user), db: Session = Depends(get_session)
) -> Response:
    """Delete the thread and everything under it: its ledger, plans, Screen and lanes. It cannot be undone; a thread
    that is not hers is a 404."""
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


@router.get("/threads/{thread_id}/fills", response_model=ThreadFillsOut)
def get_thread_fills(
    thread_id: int,
    limit: int = Query(default=100, ge=1, le=threads_mod.LEDGER_LIMIT),
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> dict[str, Any]:
    """The thread's executions (ADR-0018), newest first: every Buy and Sell with its shares, price and time, and how
    many of the shares closed the name's position. The server keeps the book; the screen never rebuilds a trade from
    memory."""
    thread = _call(threads_mod.get_thread, db, user.id, thread_id)
    return ledger_mod.fills_page(db, thread.id, limit=limit)


@router.get("/threads/{thread_id}/clock", response_model=ThreadClockOut)
def get_thread_clock(
    thread_id: int,
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
    services: Services = Depends(get_services),
) -> dict[str, Any]:
    """The thread's clock now (ADR-0025): its state, speed, the simulated time, when the first regular open after it
    is (`next_open`), the latest time it can be jumped to (`horizon`) and the simulated account at that time (balance,
    open P/L, equity). A running clock is brought to now first, so this is the answer whether or not anyone was
    looking in between. Nothing happens at a close or an open. Poll it; it is idempotent."""
    return _call(clock_mod.read, db, user.id, thread_id, services)


@router.post("/threads/{thread_id}/clock", response_model=ThreadClockOut)
def control_thread_clock(
    thread_id: int,
    body: ClockIn,
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
    services: Services = Depends(get_services),
) -> dict[str, Any]:
    """Play or pause the thread's clock, set its speed (1, 2, 5, 10), step it a bar, or jump it:
    `{"to": "<ISO time with its UTC offset>"}` sets the clock to that date and time (Next open is a Jump to
    `next_open`).
    Forward only (422 on a `to` already past; a `to` equal to the clock changes nothing) and no later than `horizon`
    (422). Every position and working order is kept: orders fill as the clock crosses them, splits restate holdings, and
    each position is valued at the new time. A running clock stops at the horizon with `pause`."""
    _call(
        clock_mod.control,
        db,
        user.id,
        thread_id,
        services,
        running=body.running,
        speed=body.speed,
        to=body.to,
        step=body.step,
    )
    return _call(clock_mod.read, db, user.id, thread_id, services)


# -- swing threads (02p): holds and weeks -----------------------------------------------------------------------


@router.put(
    "/threads/{thread_id}/setup",
    response_model=ThreadOut,
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {"application/json": {"schema": {"$ref": "#/components/schemas/PracticeSetupV2"}}},
        }
    },
)
def put_thread_setup(
    thread_id: int,
    raw: Any = Depends(_json_body),
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
    services: Services = Depends(get_services),
) -> dict[str, Any]:
    """Save the thread's setup (a `PracticeSetupV2`): the start instant, her filters and the chart setup. The first one
    starts the thread's clock, paused at `startAt`; a later one replaces the plan and the Screen's filters and never
    moves time. A closed thread is a 409."""
    setup = _validated(PracticeSetupV2, raw, "setup")
    thread = _call(threads_mod.resolve_for_plan, db, user.id, thread_id)
    _call(plan_mod.create_plan, db, user.id, setup, services, thread)
    return threads_mod.detail(db, thread)


@router.get("/threads/{thread_id}/portfolio", response_model=PortfolioOut)
def get_thread_portfolio(
    thread_id: int,
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
    services: Services = Depends(get_services),
) -> dict[str, Any]:
    """The thread's Portfolio at its time T (ADR-0025): every open position across its lanes with its average cost, its
    price AT T (the one price function, `mark_at`) and its gain or loss, the working orders, and the account. Jump a
    month ahead and the first read prices every holding at the new time."""
    thread = _call(threads_mod.get_thread, db, user.id, thread_id)
    _call(svc_mod.settle_thread, db, services, thread.id)
    db.refresh(thread)
    return _call(svc_mod.portfolio, db, services, thread)


@router.post("/threads/{thread_id}/lanes", response_model=ReplaySessionOut)
def open_thread_lane(
    thread_id: int,
    body: LaneIn,
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
    services: Services = Depends(get_services),
) -> dict[str, Any]:
    """Open her lane on a name (or resume it): one book per name for the thread's life, at the thread's time. Any name
    of the Screen or of the thread's universe opens, and a position open on another name never blocks the switch."""
    row = _call(plan_mod.open_lane, db, user.id, thread_id, body.symbol, services)
    return _with_thread(db, svc_mod.session_out(_call(svc_mod.context, db, services, row)), row.thread_id)
