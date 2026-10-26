"""Request and response models for `/api/desk/feedback` (02s).

Plain Pydantic, like `threads.py`: nothing here is a spec the user authors and versions, so there is no `contracts/`
file. Timestamps are ISO-8601 UTC with `Z`. A field problem in a request is the plain `422 {"detail": {"problems":
[...]}}` list (the route class in `api/feedback.py` turns FastAPI's own 422 into it).
"""

import json
from datetime import UTC, datetime
from typing import Annotated, Any
from urllib.parse import urlsplit

from pydantic import AfterValidator, AwareDatetime, BaseModel, ConfigDict, Field, ValidationInfo, field_validator

from ai_trading.feedback import MAX_ATTACHMENTS, MAX_LINKS, MAX_NOTE, ActorName, Kind, Severity, Status

MAX_CONTEXT_BYTES = 8192

UtcDatetime = Annotated[datetime, AfterValidator(lambda moment: moment.astimezone(UTC))]


# -- requests -----------------------------------------------------------------------------------------------


class FeedbackLinkIn(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    label: str | None = Field(default=None, max_length=80)
    url: str = Field(min_length=1, max_length=2000)

    @field_validator("url")
    @classmethod
    def _web_address(cls, value: str) -> str:
        try:
            parts = urlsplit(value)
        except ValueError:
            parts = None
        if (
            parts is None
            or parts.scheme not in ("http", "https")
            or not parts.netloc
            or any(c.isspace() for c in value)
        ):
            raise ValueError("Use a web address that starts with http:// or https://")
        return value


class FeedbackCreateIn(BaseModel):
    """File a report. A bug carries a severity and a feature request does not; `attachment_ids` are screenshots the
    caller staged earlier (`POST /attachments`)."""

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    kind: Kind
    severity: Severity | None = Field(default=None, validate_default=True)
    title: str = Field(min_length=1, max_length=120)
    body: str = Field(min_length=1, max_length=4000)
    expected: str | None = Field(default=None, max_length=4000)
    screen: str = Field(max_length=120)
    route: str = Field(min_length=1, max_length=300, pattern=r"^/")
    app_version: str = Field(max_length=64)
    context: dict[str, Any]  # practice day, symbol, anything else the screen captured
    captured_at: AwareDatetime
    links: list[FeedbackLinkIn] = Field(default_factory=list, max_length=MAX_LINKS)
    attachment_ids: list[int] = Field(default_factory=list, max_length=MAX_ATTACHMENTS)

    @field_validator("severity")
    @classmethod
    def _severity_goes_with_a_bug(cls, value: str | None, info: ValidationInfo) -> str | None:
        kind = info.data.get("kind")
        if kind == "bug" and value is None:
            raise ValueError("A bug needs a severity")
        if kind == "request" and value is not None:
            raise ValueError("A feature request has no severity")
        return value

    @field_validator("context")
    @classmethod
    def _small_context(cls, value: dict[str, Any]) -> dict[str, Any]:
        if len(json.dumps(value, default=str)) > MAX_CONTEXT_BYTES:
            raise ValueError("The captured context is too large")
        return value


class FeedbackPatchIn(BaseModel):
    """Either a status change (the owner: `status`, `fix_ref`, `duplicate_of`, `note`) or the filer's own edit while the
    report is open (`title`, `body`, `expected`, `severity`, `links`); a key left out is left alone."""

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    status: Status | None = None
    fix_ref: str | None = Field(default=None, max_length=200)
    duplicate_of: int | None = Field(default=None, ge=1)
    note: str | None = Field(default=None, max_length=MAX_NOTE)
    title: str | None = Field(default=None, min_length=1, max_length=120)
    body: str | None = Field(default=None, min_length=1, max_length=4000)
    expected: str | None = Field(default=None, max_length=4000)  # null clears it
    severity: Severity | None = None
    links: list[FeedbackLinkIn] | None = Field(default=None, max_length=MAX_LINKS)


# -- responses ----------------------------------------------------------------------------------------------


class FeedbackItemOut(BaseModel):
    """A row of the dashboard list."""

    id: int
    ref: str  # "F-014"
    kind: Kind
    severity: Severity | None
    title: str
    route: str
    area: str  # the first path segment of `route`; "home" for the home page
    reported_by: str
    updated_at: UtcDatetime
    status: Status
    fix_ref: str | None


class FeedbackCountsOut(BaseModel):
    """Reports per status over the whole log, not over the page."""

    open: int
    in_progress: int
    fixed: int
    wont_fix: int
    duplicate: int


class FeedbackListOut(BaseModel):
    items: list[FeedbackItemOut]
    counts: FeedbackCountsOut


class FeedbackLinkOut(BaseModel):
    label: str | None
    url: str


class FeedbackAttachmentOut(BaseModel):
    id: int
    filename: str
    size_bytes: int
    content_type: str


class FeedbackUploadOut(FeedbackAttachmentOut):
    report_id: int | None  # null while the screenshot is staged


class FeedbackEventOut(BaseModel):
    at: UtcDatetime
    actor: ActorName
    from_status: Status | None
    to_status: Status
    note: str | None


class FeedbackDetailOut(FeedbackItemOut):
    body: str
    expected: str | None
    screen: str
    app_version: str
    context: dict[str, Any]
    captured_at: UtcDatetime
    links: list[FeedbackLinkOut]
    attachments: list[FeedbackAttachmentOut]
    events: list[FeedbackEventOut]
    duplicate_of: int | None
