"""Guarded HTTP API: identity/origin/prefix enforcement, routing, downloads.

``create_app(root, start=None)`` returns a Starlette app; ``application`` is
the production ASGI object (``ta_web.app:application``). Importing this
module must never touch the real data home or a database: ``Store``,
the per-process service lock, and (in production) ``Runner`` are all
constructed inside the lifespan, not at import or ``create_app`` time.

``Guard`` is a pure ASGI middleware — it only inspects headers and the
outgoing response's start message, delegating all HTTP parsing/routing to
Starlette.
"""

from __future__ import annotations

import contextlib
import fcntl
import json
import logging
import os
from collections.abc import Callable
from datetime import date
from pathlib import Path

from pydantic import BaseModel, ConfigDict, StrictBool, ValidationError
from starlette.applications import Starlette
from starlette.datastructures import Headers, MutableHeaders
from starlette.middleware import Middleware
from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse, Response
from starlette.routing import Route
from tradingagents.default_config import DEFAULT_CONFIG

from . import reports
from .domain import (
    BusyError,
    Inputs,
    NotFoundError,
    owner_key,
    public_view,
    safe_settings,
)
from .store import Store

_STATIC_DIR = Path(__file__).parent / "static"
_INDEX_HTML = (_STATIC_DIR / "index.html").read_text()
_ASSET_CONTENT_TYPES = {
    "app.mjs": "text/javascript; charset=utf-8",
    "app.css": "text/css; charset=utf-8",
}
# Reuses the same public settings allowlist as a run's own persisted settings
# (never the raw, possibly credential/endpoint-bearing DEFAULT_CONFIG dict).
_DEFAULTS = safe_settings(DEFAULT_CONFIG)

_TRUSTED_PREFIXES = ("", "/u/tradingagents")
_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
_MAX_BODY_BYTES = 16 * 1024

_SECURITY_HEADERS = {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "content-security-policy": "frame-ancestors 'none'",
}
_SECURITY_HEADERS_RAW = [(k.encode("latin-1"), v.encode("latin-1")) for k, v in _SECURITY_HEADERS.items()]

_logger = logging.getLogger("ta_web.app")


class ApiError(Exception):
    """A fixed, safe (code, status) pair for request-shape failures."""

    def __init__(self, code: str, status: int):
        super().__init__(code)
        self.code = code
        self.status = status


class _SharingBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: StrictBool


async def _deny(send, status: int, code: str) -> None:
    body = json.dumps({"error": code}).encode()
    headers = [
        (b"content-type", b"application/json"),
        (b"content-length", str(len(body)).encode("latin-1")),
        *_SECURITY_HEADERS_RAW,
    ]
    await send({"type": "http.response.start", "status": status, "headers": headers})
    await send({"type": "http.response.body", "body": body})


class Guard:
    """Verified identity, prefix, and same-origin enforcement; hardens every response.

    Health is internal-only and bypasses these checks entirely (brief: "not
    publicly proxied"). Everything else requires a verified identity header;
    unsafe methods additionally require an Origin matching the gateway-set
    scheme/Host. A trusted, gateway-set ``X-Family-App-Prefix`` becomes the
    ASGI ``root_path`` for stripped-prefix deployments.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["path"] == "/__healthz":
            await self.app(scope, receive, send)
            return

        headers = Headers(scope=scope)

        prefix = headers.get("x-family-app-prefix", "")
        if prefix not in _TRUSTED_PREFIXES:
            await _deny(send, 400, "UNTRUSTED_PREFIX")
            return

        try:
            owner = owner_key(headers.get("cf-access-authenticated-user-email", ""))
        except ValueError:
            await _deny(send, 401, "UNAUTHENTICATED")
            return

        if scope["method"] not in _SAFE_METHODS:
            scheme = headers.get("x-forwarded-proto") or scope.get("scheme", "http")
            host = headers.get("host")
            if not host:
                server = scope.get("server")
                host = server[0] if server else ""
            if headers.get("origin") != f"{scheme}://{host}":
                await _deny(send, 403, "ORIGIN_DENIED")
                return

        scope.setdefault("state", {})
        scope["state"]["owner"] = owner
        scope["state"]["prefix"] = prefix
        if prefix:
            # Caddy already stripped this prefix from the forwarded path; record
            # it as root_path so request/URL reconstruction stays consistent.
            scope["root_path"] = prefix

        async def send_harden(message):
            if message["type"] == "http.response.start":
                message["headers"] = list(message.get("headers", []))
                mutable = MutableHeaders(raw=message["headers"])
                for key, value in _SECURITY_HEADERS.items():
                    mutable.setdefault(key, value)
            await send(message)

        await self.app(scope, receive, send_harden)


class _OuterSanitizer:
    """The true last line of defense, outside Starlette's ``ServerErrorMiddleware``.

    ``ServerErrorMiddleware`` always re-raises the original exception after
    sending its (already-sanitized) response — documented Starlette behavior,
    meant so a real ASGI server can log it. That re-raise is exactly what
    would otherwise put a raw, possibly secret-bearing exception into the
    server's logs. This wraps the *entire* built middleware stack (including
    ``ServerErrorMiddleware``) so nothing above this point ever sees the
    original exception: it logs one fixed, sanitized line and stops the
    propagation here, never via ``logger.exception``/``raise ... from exc``
    (both would carry the original text/traceback into the log record).
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        response_started = False

        async def _send(message):
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, receive, _send)
        except Exception:  # noqa: BLE001 - deliberate final backstop; never re-raised
            if not response_started:
                # Nothing below produced a response at all (should not happen,
                # since the inner Exception handler already does) — still
                # never let the original exception escape unanswered.
                await _deny(send, 500, "INTERNAL_ERROR")
            # Fixed message only: scope["method"]/["path"] are untrusted
            # caller-supplied ASGI data (a path segment can itself be a
            # secret-bearing identifier) and must never reach the log, same
            # as the original exception text/traceback.
            _logger.error("INTERNAL_REQUEST_ERROR")
            # Deliberately not re-raised and not passed to logger.exception:
            # the original exception stops here, never reaching the ASGI
            # server's own (unsanitized) exception logging.


def _error(status: int, code: str, message: str | None = None) -> JSONResponse:
    payload: dict = {"error": code}
    if message:
        payload["message"] = message
    return JSONResponse(payload, status_code=status, headers=_SECURITY_HEADERS)


async def _on_not_found(request: Request, exc: Exception) -> JSONResponse:
    return _error(404, "NOT_FOUND")


async def _on_busy(request: Request, exc: Exception) -> JSONResponse:
    return _error(409, "BUSY")


async def _on_report_error(request: Request, exc: reports.ReportError) -> JSONResponse:
    return _error(exc.status, exc.code)


async def _on_validation_error(request: Request, exc: ValidationError) -> JSONResponse:
    return _error(422, "INVALID_INPUT")


async def _on_api_error(request: Request, exc: ApiError) -> JSONResponse:
    return _error(exc.status, exc.code)


async def _on_unexpected(request: Request, exc: Exception) -> JSONResponse:
    # Never serialize the real exception: it may carry storage paths, raw
    # upstream text, or other sentinel-bearing detail (global constraint 8).
    return _error(500, "INTERNAL_ERROR")


_EXCEPTION_HANDLERS = {
    NotFoundError: _on_not_found,
    BusyError: _on_busy,
    reports.ReportError: _on_report_error,
    ValidationError: _on_validation_error,
    ApiError: _on_api_error,
    Exception: _on_unexpected,
}


def _check_json_media_type(request: Request) -> None:
    media_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if media_type != "application/json":
        raise ApiError("UNSUPPORTED_MEDIA_TYPE", 415)


async def _read_bounded_json(request: Request) -> dict:
    """Require application/json (optional charset tolerated) before anything
    else, then stream-bound the body to 16 KiB before decoding; require a
    JSON object."""
    _check_json_media_type(request)
    total = 0
    chunks: list[bytes] = []
    async for chunk in request.stream():
        total += len(chunk)
        if total > _MAX_BODY_BYTES:
            raise ApiError("BODY_TOO_LARGE", 413)
        chunks.append(chunk)
    try:
        data = json.loads(b"".join(chunks) or b"null")
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise ApiError("INVALID_JSON", 422) from None
    if not isinstance(data, dict):
        raise ApiError("INVALID_JSON", 422)
    return data


def _clamped_pagination(request: Request) -> tuple[int, int]:
    def _int(value, default):
        try:
            return int(value)
        except (TypeError, ValueError):
            return default

    limit = max(1, min(_int(request.query_params.get("limit"), 25), 100))
    offset = max(0, _int(request.query_params.get("offset"), 0))
    return limit, offset


# --- routes ------------------------------------------------------------------


async def health(request: Request) -> JSONResponse:
    return JSONResponse({"ok": True})


async def shell(request: Request) -> HTMLResponse:
    return HTMLResponse(_INDEX_HTML.replace("__APP_PREFIX__", request.state.prefix))


async def detail_shell(request: Request) -> HTMLResponse:
    store: Store = request.app.state.store
    store.get_visible(request.path_params["id"], request.state.owner)
    return HTMLResponse(_INDEX_HTML.replace("__APP_PREFIX__", request.state.prefix))


async def asset(request: Request) -> Response:
    content_type = _ASSET_CONTENT_TYPES.get(request.path_params["name"])
    if content_type is None:
        raise NotFoundError()
    data = (_STATIC_DIR / request.path_params["name"]).read_bytes()
    return Response(data, media_type=content_type)


async def research_list(request: Request) -> JSONResponse:
    store: Store = request.app.state.store
    owner = request.state.owner
    limit, offset = _clamped_pagination(request)
    # Spec §5: ticker/analysis-date/status filters apply across the caller's
    # whole history, not just the returned page -- Store.list_owned already
    # does the filtering and owner-scoping; this only forwards the validated
    # query params to it. Absent/empty means "no filter" (list_owned's own
    # default). An invalid value (bad date shape, unknown status, or a
    # ticker list_owned's own safe_ticker_component rejects) is the caller's
    # fault, not a storage failure -- surfaced as 422, not 500.
    ticker = request.query_params.get("ticker") or None
    analysis_date = request.query_params.get("analysis_date") or None
    status = request.query_params.get("status") or None
    try:
        items = store.list_owned(
            owner, limit=limit, offset=offset, ticker=ticker, analysis_date=analysis_date, status=status
        )
    except ValueError:
        raise ApiError("INVALID_INPUT", 422) from None
    return JSONResponse(
        {
            "owner_id": owner,
            "items": [public_view(run, owner) for run in items],
            "limit": limit,
            "offset": offset,
            "today": date.today().isoformat(),
            "defaults": _DEFAULTS,
        }
    )


async def research_start(request: Request) -> JSONResponse:
    store: Store = request.app.state.store
    owner = request.state.owner
    body = await _read_bounded_json(request)
    inputs = Inputs(**body)
    run = store.create(owner, inputs)
    try:
        request.app.state.start(run["id"])
    except Exception:  # noqa: BLE001 - launch failure is recorded, never re-raised
        store.update(run["id"], status="failed", error_code="LAUNCH_FAILED")
    return JSONResponse(
        {"id": run["id"], "detail_url": f"{request.state.prefix}/research/{run['id']}"},
        status_code=202,
    )


async def sharing(request: Request) -> JSONResponse:
    store: Store = request.app.state.store
    owner = request.state.owner
    run_id = request.path_params["id"]
    store.get_owned(run_id, owner)  # owner-only visibility before parsing the mutation
    body = await _read_bounded_json(request)
    parsed = _SharingBody(**body)
    updated = store.set_shared(run_id, owner, parsed.enabled)
    return JSONResponse(public_view(updated, owner))


async def report(request: Request) -> HTMLResponse:
    store: Store = request.app.state.store
    run = store.get_visible(request.path_params["id"], request.state.owner)
    html = reports.preview(run)
    return HTMLResponse(
        html,
        headers={"content-security-policy": "frame-ancestors 'self'", "x-frame-options": "SAMEORIGIN"},
    )


async def report_download(request: Request) -> Response:
    store: Store = request.app.state.store
    content, mime, filename = reports.download(
        store, request.path_params["id"], request.state.owner, request.query_params.get("format", "")
    )
    return Response(content, media_type=mime, headers={"content-disposition": f'attachment; filename="{filename}"'})


async def research_detail(request: Request) -> JSONResponse:
    store: Store = request.app.state.store
    owner = request.state.owner
    run = store.get_visible(request.path_params["id"], owner)
    return JSONResponse(public_view(run, owner))


routes = [
    Route("/__healthz", health, methods=["GET"]),
    Route("/research", shell, methods=["GET"]),
    Route("/research/{id}", detail_shell, methods=["GET"]),
    Route("/research/assets/{name}", asset, methods=["GET"]),
    Route("/api/research", research_list, methods=["GET"]),
    Route("/api/research", research_start, methods=["POST"]),
    Route("/api/research/{id}/sharing", sharing, methods=["POST"]),
    Route("/api/research/{id}/report", report, methods=["GET"]),
    Route("/api/research/{id}/download", report_download, methods=["GET"]),
    Route("/api/research/{id}", research_detail, methods=["GET"]),
]


def create_app(root: Path, start: Callable[[str], None] | None = None) -> Starlette:
    root = Path(root)

    @contextlib.asynccontextmanager
    async def lifespan(app: Starlette):
        # Store/the service lock are built here, never at import or create_app
        # time, so importing this module can never touch the real data home.
        store = Store(root)
        lock_fd = os.open(store.research_dir / ".service.lock", os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            os.close(lock_fd)
            raise RuntimeError("ta-research: service lock already held by another process") from exc
        runner = None
        launch = start
        try:
            if launch is None:
                # ponytail: production-only dependency, lazily imported so module
                # import and every test (which inject their own `start`) never need
                # ta_web.runner to exist. Task 3's Runner lands as a separate commit.
                from .runner import Runner

                runner = Runner(root)
                launch = runner.start
            for run_id in store.mark_interrupted():
                try:
                    store.update(run_id, partial=True)
                    reports.publish(store, run_id)
                except reports.ReportError:
                    pass  # nothing worth publishing from a run interrupted before any report text
            app.state.store = store
            app.state.start = launch
            yield
        finally:
            if runner is not None:
                runner.close()
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
            os.close(lock_fd)

    app = Starlette(
        routes=routes,
        middleware=[Middleware(Guard)],
        exception_handlers=_EXCEPTION_HANDLERS,
        lifespan=lifespan,
    )
    # Starlette always puts ServerErrorMiddleware outermost, and it always
    # re-raises after sending its response (see _OuterSanitizer's docstring).
    # Pre-build the normal stack and wrap *that* so the sanitizer sits truly
    # outside it, while `app` itself stays the real Starlette instance (its
    # `.router`/`.state`/lifespan access are unchanged for callers/tests).
    app.middleware_stack = _OuterSanitizer(app.build_middleware_stack())
    return app


def _production_root() -> Path:
    return Path.home() / ".tradingagents"


application = create_app(_production_root())
