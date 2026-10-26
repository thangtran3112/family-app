"""`/api/desk/feedback/*` (02s): the feedback log. Seven routes: the dashboard list with its counts, filing a
report, one report, the owner's status change or the filer's own edit, and the screenshots (staged before Send, added
to a report, and the bytes). All behind the gateway identity, all `Cache-Control: no-store`.

Every signed-in user reads every report (two users share one flat log). Who may change a status is the owner, an email
in `DESK_OWNER_EMAILS`; everyone else is a filer. The rules live in `ai_trading.feedback`, which the CLI calls too.

A screenshot is read from the raw request stream and the read stops once the body passes the 5 MB limit (plus a few KB
of multipart framing), so an oversized upload never fills memory; the file's own size is then checked to the byte and
its type by magic bytes, never by the header the client sent. `python-multipart` is not a dependency, so the one
`file` part is cut out of the body here.
"""

from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from email import message_from_string
from email.message import Message
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from sqlalchemy.orm import Session

from ai_trading import feedback as svc
from ai_trading.api.auth import AuthedUser, get_current_user, get_session
from ai_trading.api.problems import MAX_PROBLEMS
from ai_trading.api.schemas.feedback import (
    FeedbackCreateIn,
    FeedbackDetailOut,
    FeedbackListOut,
    FeedbackPatchIn,
    FeedbackUploadOut,
)
from ai_trading.runtime_flags import desk_owner_emails

NO_STORE = "no-store"
#: The request body of one screenshot: the file's limit plus room for the multipart framing around it.
MAX_BODY_BYTES = svc.MAX_ATTACHMENT_BYTES + 16 * 1024
_IMAGE_TYPES = ("image/png", "image/jpeg", "image/webp")


def _no_store(response: Response) -> None:
    response.headers["Cache-Control"] = NO_STORE


def _problems(exc: RequestValidationError) -> list[dict[str, str]]:
    """FastAPI's list of errors as the `problems` of 02m §a1: a plain message and a dotted path (`links.0.url`)."""
    seen: set[tuple[str, str]] = set()
    problems: list[dict[str, str]] = []
    for error in exc.errors():
        loc = tuple(error["loc"])
        if loc == ("body",) or error["type"] == "json_invalid":
            path, message = "", "Send a JSON body"
        else:
            path, message = ".".join(str(part) for part in loc[1:]), error["msg"].removeprefix("Value error, ")
        if (path, message) not in seen:
            seen.add((path, message))
            problems.append({"path": path, "message": message})
    return problems[:MAX_PROBLEMS]


class _ProblemsRoute(APIRoute):
    """A bad body or query answers `422 {"detail": {"problems": [...]}}`, like the Desk's other routes."""

    def get_route_handler(self) -> Callable[[Request], Awaitable[Response]]:
        handler = super().get_route_handler()

        async def problems_handler(request: Request) -> Response:
            try:
                return await handler(request)
            except RequestValidationError as exc:
                raise HTTPException(status_code=422, detail={"problems": _problems(exc)}) from None

        return problems_handler


router = APIRouter(
    prefix="/api/desk/feedback",
    tags=["feedback"],
    dependencies=[Depends(get_current_user), Depends(_no_store)],
    route_class=_ProblemsRoute,
)


def _problem(message: str, path: str) -> HTTPException:
    return HTTPException(status_code=422, detail={"problems": [{"path": path, "message": message}]})


def _call[T](fn: Callable[..., T], *args: Any, **kwargs: Any) -> T:
    """Run a service function, turning its refusals into the plain HTTP errors of 02s."""
    try:
        return fn(*args, **kwargs)
    except svc.FeedbackProblem as exc:
        raise _problem(exc.message, exc.path) from None
    except svc.FeedbackError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.message) from None


def _actor(user: AuthedUser) -> svc.Actor:
    return svc.Actor("owner" if user.email.lower() in desk_owner_emails() else "user", user.id)


def _now() -> datetime:
    return datetime.now(UTC)


# -- screenshots in -----------------------------------------------------------------------------------------


async def read_capped(stream: AsyncIterator[bytes], limit: int) -> bytes:
    """The whole body, or a 413 the moment it passes `limit` bytes: the rest of the stream is never read."""
    chunks: list[bytes] = []
    total = 0
    async for chunk in stream:
        total += len(chunk)
        if total > limit:
            raise HTTPException(status_code=413, detail="Screenshots can be at most 5 MB")
        chunks.append(chunk)
    return b"".join(chunks)


def file_part(content_type: str, body: bytes) -> tuple[str | None, bytes] | None:
    """The `file` part of a multipart body as `(filename, bytes)`, or None when there is none. The bytes are exactly
    what the client sent: a part ends at the CRLF before the next boundary line, whatever the file contains."""
    header = Message()
    header["Content-Type"] = content_type
    boundary = header.get_boundary()
    if not boundary:
        return None
    for part in (b"\r\n" + body).split(b"\r\n--" + boundary.encode())[1:]:
        if part.startswith(b"--"):  # the closing boundary
            break
        head, found, data = part.partition(b"\r\n\r\n")
        if not found:
            continue
        headers = message_from_string(head.decode("utf-8", "replace").lstrip(" \t\r\n"))
        if headers.get_param("name", header="content-disposition") == "file":
            filename = headers.get_filename()
            return (filename if isinstance(filename, str) else None), data
    return None


@dataclass(frozen=True)
class Upload:
    filename: str | None
    data: bytes


async def _upload(request: Request) -> Upload:
    content_type = request.headers.get("content-type", "")
    if not content_type.lower().startswith("multipart/form-data"):
        raise _problem("Send the screenshot as multipart form data, in a field named file", "file")
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > MAX_BODY_BYTES:
        raise HTTPException(status_code=413, detail="Screenshots can be at most 5 MB")
    found = file_part(content_type, await read_capped(request.stream(), MAX_BODY_BYTES))
    if found is None:
        raise _problem("Attach a screenshot in the field named file", "file")
    return Upload(*found)


UPLOAD_BODY: dict[str, Any] = {
    "requestBody": {
        "required": True,
        "content": {
            "multipart/form-data": {
                "schema": {
                    "type": "object",
                    "required": ["file"],
                    "properties": {"file": {"type": "string", "format": "binary"}},
                }
            }
        },
    }
}


# -- the log ------------------------------------------------------------------------------------------------


@router.get("", response_model=FeedbackListOut)
def list_feedback(
    status: list[svc.Status] | None = Query(default=None),
    kind: svc.Kind | None = None,
    area: str | None = Query(default=None, max_length=60),
    q: str | None = Query(default=None, max_length=200),
    sort: svc.Sort = "newest",
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_session),
) -> dict[str, Any]:
    """The dashboard: reports newest first by default, and the counts per status over the whole log. `limit` guards the
    answer; the Desk shows one scrolling list."""
    return svc.list_reports(db, statuses=status, kind=kind, area=area, q=q, sort=sort, limit=limit, offset=offset)


@router.post("", response_model=FeedbackDetailOut, status_code=201)
def create_feedback(
    body: FeedbackCreateIn,
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> dict[str, Any]:
    """File a bug or a feature request. The screenshots are the caller's own staged files, named by id."""
    return _call(
        svc.create_report,
        db,
        _actor(user),
        kind=body.kind,
        severity=body.severity,
        title=body.title,
        body=body.body,
        expected=body.expected or None,
        screen=body.screen,
        route=body.route,
        app_version=body.app_version,
        context=body.context,
        captured_at=body.captured_at,
        links=[link.model_dump() for link in body.links],
        attachment_ids=body.attachment_ids,
        now=_now(),
    )


@router.post("/attachments", response_model=FeedbackUploadOut, status_code=201, openapi_extra=UPLOAD_BODY)
def stage_screenshot(
    upload: Upload = Depends(_upload),
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> dict[str, Any]:
    """Stage a screenshot before the report exists, so the form can show the upload before Send. Staged files older
    than 24 hours are deleted by this route on its next call; a user holds at most six."""
    return _call(svc.stage_attachment, db, user.id, upload.filename, upload.data, _now())


@router.get(
    "/attachments/{attachment_id}",
    response_class=Response,
    responses={
        200: {
            "description": "The screenshot's bytes, with the stored content type.",
            "content": {kind: {"schema": {"type": "string", "format": "binary"}} for kind in _IMAGE_TYPES},
        }
    },
)
def get_screenshot(
    attachment_id: int,
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> Response:
    """The bytes. A staged file is its uploader's alone; an attached one is every signed-in user's."""
    content_type, payload = _call(svc.read_attachment, db, attachment_id, user.id)
    return Response(
        payload,
        media_type=content_type,
        headers={
            "Content-Disposition": "inline",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, no-store",  # a returned Response skips the router's `no-store` dependency
        },
    )


@router.get("/{report_id}", response_model=FeedbackDetailOut)
def get_feedback(report_id: int, db: Session = Depends(get_session)) -> dict[str, Any]:
    return _call(svc.detail, db, report_id)


@router.patch("/{report_id}", response_model=FeedbackDetailOut)
def patch_feedback(
    report_id: int,
    body: FeedbackPatchIn,
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> dict[str, Any]:
    """The owner moves a report between statuses (`status`, with `fix_ref`, `duplicate_of` or `note` where the status
    needs them); the filer edits her own report while it is open. One request does one of the two."""
    sent = body.model_fields_set
    changes = sent & svc.EDITABLE
    if sent & {"status", "fix_ref", "duplicate_of", "note"}:
        if changes:
            raise _problem("Send a status change or an edit, not both", "status")
        if body.status is None:
            raise _problem("Say which status this is for", "status")
        return _call(
            svc.set_status,
            db,
            report_id,
            _actor(user),
            body.status,
            fix_ref=body.fix_ref,
            duplicate_of=body.duplicate_of,
            note=body.note,
            now=_now(),
        )
    edits: dict[str, Any] = {key: getattr(body, key) for key in changes}
    if body.links is not None:
        edits["links"] = [link.model_dump() for link in body.links]
    if "expected" in edits:
        edits["expected"] = edits["expected"] or None
    return _call(svc.edit_report, db, report_id, _actor(user), edits, _now())


@router.post("/{report_id}/attachments", response_model=FeedbackUploadOut, status_code=201, openapi_extra=UPLOAD_BODY)
def add_screenshot(
    report_id: int,
    upload: Upload = Depends(_upload),
    user: AuthedUser = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> dict[str, Any]:
    """Add a screenshot to an existing report: the filer or the owner, up to six in all."""
    return _call(svc.add_attachment, db, report_id, _actor(user), upload.filename, upload.data, _now())
