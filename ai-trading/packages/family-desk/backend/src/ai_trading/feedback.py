"""The Desk feedback log (02s): the bugs and feature requests the family files from the Desk, their status, and their
screenshots.

Every write goes through this module, for the API (`api/feedback.py`) and the CLI (`cli/feedback.py`) alike, so the
transition rules of 02s hold in both. A function flushes and never commits: the caller's session scope does. A
rejection raises `FeedbackProblem` (`422 {"detail": {"problems": [...]}}`) or `FeedbackError` (a plain `{"detail": ...}`
with the status the API answers). Nothing is written before a rejection is raised.

Who may do what is the `Actor`: a signed-in user is `user`, or `owner` when `DESK_OWNER_EMAILS` lists them; the CLI
names `owner`, `claude-code` or `hermes`. There is no order, broker or position anywhere here.
"""

import hashlib
import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Literal, get_args

from sqlalchemy import asc, delete, desc, func, or_, select
from sqlalchemy.orm import Session, undefer

from ai_trading.db.models import FeedbackAttachment, FeedbackEvent, FeedbackReport, User

Kind = Literal["bug", "request"]
Severity = Literal["P0", "P1", "P2", "P3"]
Status = Literal["open", "in_progress", "fixed", "wont_fix", "duplicate"]
ActorName = Literal["user", "owner", "claude-code", "hermes"]
Sort = Literal["newest", "updated", "oldest"]

STATUSES: tuple[str, ...] = get_args(Status)
AGENTS = frozenset({"claude-code", "hermes"})

MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
MAX_ATTACHMENTS = 6  # per report, and staged per user
MAX_LINKS = 10
STAGED_TTL = timedelta(hours=24)
MAX_NOTE = 1000
EDITABLE = frozenset({"title", "body", "expected", "severity", "links"})  # what the filer may edit while it is open

# A commit (7 to 40 hex characters) and/or `PR #nnn`, joined by a space, a comma or "and".
_REF = r"(?:[0-9a-f]{7,40}|PR #[0-9]{1,7})"
FIX_REF = re.compile(rf"{_REF}(?:(?:, | and | ){_REF})*", re.IGNORECASE)
_EXTENSIONS = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}

_OWNER = frozenset({"owner"})
_OWNER_OR_AGENT = frozenset({"owner", *AGENTS})
#: 02s "Status model and who may set what": (from, to) -> who. A move that is not here is a 409.
TRANSITIONS: dict[tuple[str, str], frozenset[str]] = {
    ("open", "in_progress"): _OWNER_OR_AGENT,
    ("in_progress", "open"): _OWNER_OR_AGENT,
    ("open", "fixed"): _OWNER_OR_AGENT,
    ("in_progress", "fixed"): _OWNER_OR_AGENT,
    ("open", "wont_fix"): _OWNER,
    ("in_progress", "wont_fix"): _OWNER,
    ("open", "duplicate"): _OWNER,
    ("in_progress", "duplicate"): _OWNER,
    ("fixed", "open"): _OWNER,
    ("wont_fix", "open"): _OWNER,
    ("duplicate", "open"): _OWNER,
}


class FeedbackProblem(Exception):
    """A field the request got wrong, with a plain sentence: `422 {"detail": {"problems": [{path, message}]}}`."""

    def __init__(self, message: str, path: str = "") -> None:
        super().__init__(message)
        self.message, self.path = message, path


class FeedbackError(Exception):
    """A refusal with a plain `{"detail": message}`: 403, 404, 409, 413 or 415."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status, self.message = status, message


@dataclass(frozen=True)
class Actor:
    name: ActorName
    user_id: int | None = None  # the signed-in user behind an API call; the CLI has none


def ref(report_id: int) -> str:
    return f"F-{report_id:03d}"


def parse_ref(text: str) -> int:
    """`F-014`, `f14` or `14` -> 14."""
    match = re.fullmatch(r"(?:F-?)?([0-9]+)", text.strip(), re.IGNORECASE)
    if match is None:
        raise ValueError(f"{text!r} is not a report id such as F-014")
    return int(match[1])


def area_of(route: str) -> str:
    """The first path segment of the screen she was on (`/practice/day?id=5` -> `practice`); the home page is `home`."""
    parts = route.split("?", 1)[0].split("/")
    return (parts[1] if len(parts) > 1 else parts[0]) or "home"


# -- reading ------------------------------------------------------------------------------------------------


def _item(report: FeedbackReport, display_name: str | None, email: str) -> dict[str, Any]:
    return {
        "id": report.id,
        "ref": ref(report.id),
        "kind": report.kind,
        "severity": report.severity,
        "title": report.title,
        "route": report.route,
        "area": area_of(report.route),
        "reported_by": display_name or email.split("@", 1)[0],  # never the address itself
        "updated_at": report.updated_at,
        "status": report.status,
        "fix_ref": report.fix_ref,
    }


def _escape_like(text: str) -> str:
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def list_reports(
    db: Session,
    *,
    statuses: list[str] | None = None,
    kind: str | None = None,
    area: str | None = None,
    q: str | None = None,
    sort: str = "newest",
    limit: int = 50,
    offset: int = 0,
) -> dict[str, Any]:
    """The dashboard list. `counts` are over the whole log, not over the filtered page."""
    query = select(FeedbackReport, User.display_name, User.email).join(User, User.id == FeedbackReport.user_id)
    if statuses:
        query = query.where(FeedbackReport.status.in_(statuses))
    if kind:
        query = query.where(FeedbackReport.kind == kind)
    if area:
        route_area = func.split_part(func.split_part(FeedbackReport.route, "?", 1), "/", 2)
        query = query.where(route_area == ("" if area == "home" else area))
    if q:
        pattern = f"%{_escape_like(q.strip())}%"
        query = query.where(
            or_(FeedbackReport.title.ilike(pattern, escape="\\"), FeedbackReport.body.ilike(pattern, escape="\\"))
        )
    order = {
        "newest": (desc(FeedbackReport.id),),
        "updated": (desc(FeedbackReport.updated_at), desc(FeedbackReport.id)),
        "oldest": (asc(FeedbackReport.id),),
    }[sort]
    rows = db.execute(query.order_by(*order).limit(limit).offset(offset)).all()
    counts = dict.fromkeys(STATUSES, 0)
    counts.update(dict(db.execute(select(FeedbackReport.status, func.count()).group_by(FeedbackReport.status)).all()))
    return {"items": [_item(*row) for row in rows], "counts": counts}


def _lock(db: Session, report_id: int) -> FeedbackReport:
    """The report, locked for this transaction (two writers on one report take turns); a missing one is a 404."""
    report = db.scalar(select(FeedbackReport).where(FeedbackReport.id == report_id).with_for_update())
    if report is None:
        raise FeedbackError(404, "feedback report not found")
    return report


def detail(db: Session, report_id: int) -> dict[str, Any]:
    row = db.execute(
        select(FeedbackReport, User.display_name, User.email)
        .join(User, User.id == FeedbackReport.user_id)
        .where(FeedbackReport.id == report_id)
    ).one_or_none()
    if row is None:
        raise FeedbackError(404, "feedback report not found")
    report = row[0]
    attachments = db.execute(
        select(
            FeedbackAttachment.id,
            FeedbackAttachment.filename,
            FeedbackAttachment.size_bytes,
            FeedbackAttachment.content_type,
        )
        .where(FeedbackAttachment.report_id == report_id)
        .order_by(FeedbackAttachment.id)
    ).all()
    events = db.scalars(
        select(FeedbackEvent).where(FeedbackEvent.report_id == report_id).order_by(FeedbackEvent.at, FeedbackEvent.id)
    ).all()
    return {
        **_item(*row),
        "body": report.body,
        "expected": report.expected,
        "screen": report.screen,
        "app_version": report.app_version,
        "context": report.context,
        "captured_at": report.captured_at,
        "links": report.links,
        "duplicate_of": report.duplicate_of,
        "attachments": [dict(a._mapping) for a in attachments],
        "events": [
            {"at": e.at, "actor": e.actor, "from_status": e.from_status, "to_status": e.to_status, "note": e.note}
            for e in events
        ],
    }


# -- filing and editing -------------------------------------------------------------------------------------


def _claim_staged(db: Session, user_id: int, attachment_ids: list[int]) -> list[FeedbackAttachment]:
    """The caller's own staged files named by a new report; anything else is a problem, never a guess."""
    if len(attachment_ids) > MAX_ATTACHMENTS:
        raise FeedbackProblem(f"A report holds at most {MAX_ATTACHMENTS} screenshots", "attachment_ids")
    if len(set(attachment_ids)) != len(attachment_ids):
        raise FeedbackProblem("A screenshot is listed twice", "attachment_ids")
    rows = db.scalars(
        select(FeedbackAttachment)
        .where(
            FeedbackAttachment.id.in_(attachment_ids),
            FeedbackAttachment.user_id == user_id,
            FeedbackAttachment.report_id.is_(None),
        )
        .with_for_update()
    ).all()
    missing = sorted(set(attachment_ids) - {row.id for row in rows})
    if missing:
        raise FeedbackProblem(f"Screenshot {missing[0]} is not one of your uploaded screenshots", "attachment_ids")
    return list(rows)


def create_report(
    db: Session,
    actor: Actor,
    *,
    kind: str,
    severity: str | None,
    title: str,
    body: str,
    expected: str | None,
    screen: str,
    route: str,
    app_version: str,
    context: dict[str, Any],
    captured_at: datetime,
    links: list[dict[str, Any]],
    attachment_ids: list[int],
    now: datetime,
) -> dict[str, Any]:
    """File a report: status `open`, the first timeline event, and the staged screenshots attached."""
    assert actor.user_id is not None, "a report is filed by a signed-in user"
    if (kind == "bug") != (severity is not None):
        raise FeedbackProblem("A bug needs a severity and a feature request has none", "severity")
    if len(links) > MAX_LINKS:
        raise FeedbackProblem(f"A report holds at most {MAX_LINKS} links", "links")
    staged = _claim_staged(db, actor.user_id, attachment_ids)
    report = FeedbackReport(
        user_id=actor.user_id,
        kind=kind,
        severity=severity,
        title=title,
        body=body,
        expected=expected,
        screen=screen,
        route=route,
        app_version=app_version,
        context=context,
        captured_at=captured_at,
        links=links,
        status="open",
        created_at=now,
        updated_at=now,
    )
    db.add(report)
    db.flush()
    db.add(FeedbackEvent(report_id=report.id, at=now, actor=actor.name, from_status=None, to_status="open"))
    for row in staged:
        row.report_id = report.id
    db.flush()
    return detail(db, report.id)


def edit_report(db: Session, report_id: int, actor: Actor, changes: dict[str, Any], now: datetime) -> dict[str, Any]:
    """The filer's own edit of title, description, expected result, severity and links, while the report is `open`.
    `changes` holds only the keys she sent (`expected` may be null: that clears it)."""
    report = _lock(db, report_id)
    if actor.user_id is None or actor.user_id != report.user_id:
        raise FeedbackError(403, "only the person who filed a report can edit it")
    if report.status != "open":
        raise FeedbackError(409, "a report can be edited only while it is open")
    if not changes:
        raise FeedbackProblem("Send at least one field to change")
    if unknown := sorted(set(changes) - EDITABLE):
        raise FeedbackProblem("The filer cannot change this", unknown[0])
    for key in ("title", "body", "severity", "links"):
        if key in changes and changes[key] is None:
            raise FeedbackProblem("This cannot be empty", key)
    if "severity" in changes and report.kind != "bug":
        raise FeedbackProblem("A feature request has no severity", "severity")
    if "links" in changes and len(changes["links"]) > MAX_LINKS:
        raise FeedbackProblem(f"A report holds at most {MAX_LINKS} links", "links")
    for key, value in changes.items():
        setattr(report, key, value)
    report.updated_at = now
    db.flush()
    return detail(db, report.id)


# -- status -------------------------------------------------------------------------------------------------


def _event_note(to_status: str, fix_ref: str | None, duplicate_of: int | None, note: str | None) -> str | None:
    """The timeline keeps what the row forgets on a reopen: the fix reference and the original it repeated."""
    lead = fix_ref if to_status == "fixed" else f"Duplicate of {ref(duplicate_of)}" if duplicate_of else None
    return " · ".join(part for part in (lead, note) if part) or None


def set_status(
    db: Session,
    report_id: int,
    actor: Actor,
    to_status: str,
    *,
    fix_ref: str | None = None,
    duplicate_of: int | None = None,
    note: str | None = None,
    now: datetime,
) -> dict[str, Any]:
    """Move a report to `to_status` (02s table): 403 for who may not, 409 for a move the table has no row for, 422 for
    a `fixed` with no fix, a `duplicate` with no original, or a `won't fix` with no reason."""
    report = _lock(db, report_id)
    if actor.name == "user":
        raise FeedbackError(403, "only the owner can change a report's status")
    who = TRANSITIONS.get((report.status, to_status))
    if who is None:
        raise FeedbackError(409, f"a report that is {report.status} cannot become {to_status}")
    if actor.name not in who:
        raise FeedbackError(403, f"only the owner can set {to_status}")
    fix_ref, note = (fix_ref or "").strip() or None, (note or "").strip() or None
    if note and len(note) > MAX_NOTE:
        raise FeedbackProblem(f"A note holds at most {MAX_NOTE} characters", "note")
    if to_status == "fixed":
        if fix_ref is None or FIX_REF.fullmatch(fix_ref) is None or len(fix_ref) > 200:
            raise FeedbackProblem("Name the fix: a commit hash (7 to 40 hex characters) and/or PR #123", "fix_ref")
    elif fix_ref is not None:
        raise FeedbackProblem("A fix reference goes only with fixed", "fix_ref")
    if to_status == "duplicate":
        if duplicate_of is None:
            raise FeedbackProblem("Name the report this repeats", "duplicate_of")
        if duplicate_of == report.id or not db.scalar(
            select(FeedbackReport.id).where(FeedbackReport.id == duplicate_of)
        ):
            raise FeedbackProblem("Name a different report that exists", "duplicate_of")
    elif duplicate_of is not None:
        raise FeedbackProblem("An original goes only with duplicate", "duplicate_of")
    if to_status == "wont_fix" and note is None:
        raise FeedbackProblem("Say why it will not be fixed: she reads this", "note")
    db.add(
        FeedbackEvent(
            report_id=report.id,
            at=now,
            actor=actor.name,
            from_status=report.status,
            to_status=to_status,
            note=_event_note(to_status, fix_ref, duplicate_of, note),
        )
    )
    report.status = to_status
    report.fix_ref = fix_ref  # a reopen clears both; the old values stay in the events
    report.duplicate_of = duplicate_of
    report.updated_at = now
    db.flush()
    return detail(db, report.id)


# -- screenshots --------------------------------------------------------------------------------------------


def sniff_image(data: bytes) -> str | None:
    """PNG, JPEG or WebP by magic bytes: the header the client sent says nothing."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def _clean_filename(name: str | None, content_type: str) -> str:
    base = (name or "").replace("\\", "/").rsplit("/", 1)[-1]
    base = "".join(c for c in base if c.isprintable()).strip().lstrip(".")[:120]
    return base or f"screenshot.{_EXTENSIONS[content_type]}"


def _screenshot(
    user_id: int, report_id: int | None, filename: str | None, data: bytes, now: datetime
) -> FeedbackAttachment:
    if len(data) > MAX_ATTACHMENT_BYTES:
        raise FeedbackError(413, f"This file is {len(data) / 1e6:.1f} MB, the limit is 5 MB")
    content_type = sniff_image(data)
    if content_type is None:
        raise FeedbackError(415, "Screenshots must be PNG, JPEG or WebP images")
    return FeedbackAttachment(
        report_id=report_id,
        user_id=user_id,
        filename=_clean_filename(filename, content_type),
        content_type=content_type,
        size_bytes=len(data),
        sha256=hashlib.sha256(data).hexdigest(),
        payload=data,
        created_at=now,
    )


def _attachment_out(row: FeedbackAttachment) -> dict[str, Any]:
    return {
        "id": row.id,
        "report_id": row.report_id,
        "filename": row.filename,
        "size_bytes": row.size_bytes,
        "content_type": row.content_type,
    }


def sweep_staged(db: Session, now: datetime) -> int:
    """Delete every staged screenshot older than 24 hours (nobody's report took it). No scheduler runs this: the
    staging route does, on its next call."""
    result = db.execute(
        delete(FeedbackAttachment).where(
            FeedbackAttachment.report_id.is_(None), FeedbackAttachment.created_at < now - STAGED_TTL
        )
    )
    return result.rowcount


def stage_attachment(db: Session, user_id: int, filename: str | None, data: bytes, now: datetime) -> dict[str, Any]:
    """Upload a screenshot before its report exists (the form shows the upload before Send). A sixth staged file per
    user is the limit."""
    sweep_staged(db, now)
    db.execute(select(User.id).where(User.id == user_id).with_for_update())  # one staging call per user at a time
    staged = db.scalar(
        select(func.count())
        .select_from(FeedbackAttachment)
        .where(FeedbackAttachment.user_id == user_id, FeedbackAttachment.report_id.is_(None))
    )
    if staged >= MAX_ATTACHMENTS:
        raise FeedbackError(
            409, f"You already have {MAX_ATTACHMENTS} screenshots waiting; send the report or remove one"
        )
    row = _screenshot(user_id, None, filename, data, now)
    db.add(row)
    db.flush()
    return _attachment_out(row)


def add_attachment(
    db: Session, report_id: int, actor: Actor, filename: str | None, data: bytes, now: datetime
) -> dict[str, Any]:
    """Add a screenshot to an existing report: the filer or the owner, up to six."""
    assert actor.user_id is not None, "a screenshot is uploaded by a signed-in user"
    report = _lock(db, report_id)
    if actor.name != "owner" and actor.user_id != report.user_id:
        raise FeedbackError(403, "only the person who filed a report, or the owner, can add a screenshot")
    held = db.scalar(
        select(func.count()).select_from(FeedbackAttachment).where(FeedbackAttachment.report_id == report_id)
    )
    if held >= MAX_ATTACHMENTS:
        raise FeedbackError(409, f"A report holds at most {MAX_ATTACHMENTS} screenshots")
    row = _screenshot(actor.user_id, report_id, filename, data, now)
    db.add(row)
    report.updated_at = now
    db.flush()
    return _attachment_out(row)


def read_attachment(db: Session, attachment_id: int, user_id: int) -> tuple[str, bytes]:
    """The stored type and bytes. A staged file is its uploader's alone; an attached one is every user's, like its
    report. Anything else is a 404."""
    row = db.get(FeedbackAttachment, attachment_id)
    if row is None or (row.report_id is None and row.user_id != user_id):
        raise FeedbackError(404, "screenshot not found")
    return row.content_type, row.payload


def report_screenshots(db: Session, report_id: int) -> list[tuple[int, str, bytes]]:
    """`(id, filename, bytes)` of a report's screenshots, for the CLI's `export`."""
    rows = db.scalars(
        select(FeedbackAttachment)
        .options(undefer(FeedbackAttachment.payload))
        .where(FeedbackAttachment.report_id == report_id)
        .order_by(FeedbackAttachment.id)
    )
    return [(row.id, row.filename, row.payload) for row in rows]
