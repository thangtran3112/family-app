"""Safe report preview, immutable export publish, and bounded downloads.

Reuses the upstream exporter verbatim (``tradingagents.reporting.write_report_tree``,
``tradingagents.report_html.render_report``) instead of re-implementing
rendering: those already escape agent text through CommonMark with raw HTML
and images disabled, and set the page's own CSP. This module only adds the
privacy boundary (``clean_state``/``safe_settings``, re-exported — never
duplicated — from :mod:`ta_web.domain`), the immutable atomic publish step,
and allowlisted, no-follow, size-bounded reads for download/export.
"""

from __future__ import annotations

import io
import os
import shutil
import stat
import uuid
import zipfile
from pathlib import Path

# `_report_parts` is a private upstream helper (tradingagents/reporting.py),
# not a published API: tracked compatibility dependency, not guaranteed
# stable across upstream versions. `write_report_tree`/`render_report` are
# the two public entry points this module otherwise relies on.
from tradingagents.report_html import render_report
from tradingagents.reporting import _report_parts, write_report_tree

from .domain import Run, clean_state, safe_settings
from .store import Store

__all__ = ["ReportError", "clean_state", "download", "preview", "publish"]

# Single in-memory read/zip bound (brief: "32 MiB known ceiling").
# ponytail: whole-file reads, not streamed; upgrade to chunked streaming if a
# report routinely approaches this ceiling.
_MAX_BYTES = 32 * 1024 * 1024

_SECTION_FOLDERS = ("1_analysts", "2_research", "3_trading", "4_risk", "5_portfolio")
_SECTION_FILES = {
    "1_analysts": ("market.md", "sentiment.md", "news.md", "fundamentals.md"),
    "2_research": ("bull.md", "bear.md", "manager.md"),
    "3_trading": ("trader.md",),
    "4_risk": ("aggressive.md", "conservative.md", "neutral.md"),
    "5_portfolio": ("decision.md",),
}
_TOP_LEVEL_FILES = ("complete_report.md", "complete_report.html")

_STATUS_BY_CODE = {
    "REPORT_NOT_READY": 409,
    "REPORT_INVALID_FORMAT": 422,
    "REPORT_TOO_LARGE": 413,
    "EXPORT_FAILED": 503,
}


class ReportError(Exception):
    """One of the fixed report error codes; ``status`` is its mapped HTTP code."""

    def __init__(self, code: str):
        if code not in _STATUS_BY_CODE:
            raise ValueError(f"unknown report error code: {code!r}")
        super().__init__(code)
        self.code = code
        self.status = _STATUS_BY_CODE[code]


def _ticker(run: Run) -> str:
    inputs = run.get("inputs")
    value = inputs.get("ticker") if isinstance(inputs, dict) else None
    if isinstance(value, str) and value:
        return value
    state = run.get("state")
    value = state.get("company_of_interest") if isinstance(state, dict) else None
    return value if isinstance(value, str) and value else "Unknown"


def preview(run: Run) -> str:
    """Safe HTML render of a run's report: public state/settings only."""
    state = clean_state(run["state"])
    settings = safe_settings(run["settings"])
    return render_report(_ticker(run), state, settings, _report_parts(state))


def run_directory(store: Store, run_id: str) -> Path:
    """Where this run's own files live, beneath the store's one research_dir."""
    return store.research_dir / "runs" / run_id


def _fsync_tree(path: Path) -> None:
    """Best-effort durability before the atomic rename; never fails publish."""
    try:
        for root, _dirs, files in os.walk(path):
            for name in files:
                fd = os.open(os.path.join(root, name), os.O_RDONLY)
                try:
                    os.fsync(fd)
                finally:
                    os.close(fd)
        dfd = os.open(path, os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    except OSError:
        pass


def publish(store: Store, id: str) -> None:
    """Render and write a run's reports once, atomically, then mark ready.

    Internal-only (worker end-of-run / legacy import): may run before the
    run's own ``status`` is set to its terminal value — this only ever
    touches ``exports``/``artifacts_ready``. A run with nothing but a header
    (no analyst/debate/decision text) is refused rather than published as an
    empty "analysis". Exports are immutable: a run already published is a
    silent no-op, never rewritten.
    """
    run = store.worker_run(id)
    state = clean_state(run["state"])
    settings = safe_settings(run["settings"])
    parts = _report_parts(state)
    if not parts and not state.get("final_trade_decision"):
        raise ReportError("EXPORT_FAILED")

    target_dir = run_directory(store, run["id"])
    exports_dir = target_dir / "exports"
    if exports_dir.exists():
        return

    target_dir.mkdir(parents=True, exist_ok=True)
    stage = target_dir / f".exports-{uuid.uuid4().hex}"
    try:
        write_report_tree(state, _ticker(run), stage, settings=settings, html=True)
        _fsync_tree(stage)
        os.replace(stage, exports_dir)
    except Exception as exc:
        shutil.rmtree(stage, ignore_errors=True)
        raise ReportError("EXPORT_FAILED") from exc
    store.update(run["id"], artifacts_ready=True)


def _read_file(path: Path, remaining_budget: int) -> bytes:
    """Open ``path`` with no-follow semantics; regular file only, size-bounded."""
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError as exc:
        raise ReportError("EXPORT_FAILED") from exc
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise ReportError("EXPORT_FAILED")
        if info.st_size > remaining_budget:
            raise ReportError("REPORT_TOO_LARGE")
        with os.fdopen(fd, "rb") as fh:
            fd = -1  # fdopen now owns the descriptor
            return fh.read()
    finally:
        if fd != -1:
            os.close(fd)


def _within(base: Path, path: Path) -> bool:
    try:
        return Path(os.path.realpath(path)).is_relative_to(os.path.realpath(base))
    except OSError:
        return False


def _safe_read(exports_dir: Path, relative: str) -> bytes:
    target = exports_dir / relative
    if not _within(exports_dir, target.parent):
        raise ReportError("EXPORT_FAILED")
    return _read_file(target, _MAX_BYTES)


def _zip_entries(exports_dir: Path) -> list[str]:
    """Explicit allowlisted report files actually present; never a glob."""
    entries = []
    for name in _TOP_LEVEL_FILES:
        path = exports_dir / name
        if path.is_file() and not path.is_symlink():
            entries.append(name)
    for folder in _SECTION_FOLDERS:
        folder_dir = exports_dir / folder
        if not folder_dir.is_dir() or folder_dir.is_symlink():
            continue
        for name in _SECTION_FILES[folder]:
            path = folder_dir / name
            if path.is_file() and not path.is_symlink():
                entries.append(f"{folder}/{name}")
    return entries


def _build_zip(exports_dir: Path) -> bytes:
    buf = io.BytesIO()
    remaining = _MAX_BYTES
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name in _zip_entries(exports_dir):
            data = _safe_read(exports_dir, name)
            remaining -= len(data)
            if remaining < 0:
                raise ReportError("REPORT_TOO_LARGE")
            zf.writestr(name, data)
    return buf.getvalue()


def download(store: Store, id: str, viewer: str, format: str) -> tuple[bytes, str, str]:
    """``(bytes, mime, filename)`` for an owner/shared-visible, published run."""
    if format not in ("md", "html", "zip"):
        raise ReportError("REPORT_INVALID_FORMAT")
    run = store.get_visible(id, viewer)
    if run["status"] == "running" or not run["artifacts_ready"]:
        raise ReportError("REPORT_NOT_READY")

    exports_dir = run_directory(store, run["id"]) / "exports"
    label = f"{run['id']}-partial" if run["partial"] else run["id"]
    if format == "md":
        return _safe_read(exports_dir, "complete_report.md"), "text/markdown; charset=utf-8", f"{label}.md"
    if format == "html":
        return _safe_read(exports_dir, "complete_report.html"), "text/html; charset=utf-8", f"{label}.html"
    return _build_zip(exports_dir), "application/zip", f"{label}.zip"
