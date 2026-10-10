"""Operator-driven legacy report import: assign an explicit owner, never HTTP.

Accepts only an explicit, already-opaque owner key (the hex shape
``owner_key`` produces) and a recognized Markdown report layout — a
consolidated ``complete_report.md``, the structured per-section tree
(``1_analysts/market.md`` etc., :mod:`tradingagents.reporting`'s own
``write_report_tree`` layout), or the flat CLI-interrupted layout
(``reports/market_report.md`` etc., written by ``cli/run.py``'s live display
decorator even when "Save report?" was declined). Completion/ownership is
never inferred from folder name or mtime. The fingerprint hashes exactly the
recognized files a run's content came from (ordered relative names + bytes)
— never unrelated config/log/checkpoint files, and never old HTML (never
trusted/regenerated-from); reads are bounded before allocation, the same 32
MiB ceiling as downloads. The source folder is only ever read, never
modified. ``Store.add_import``'s ``created`` flag plus ``discard_import``
roll back only this call's own not-yet-published row/files on failure — an
existing dedupe hit is returned untouched.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import shutil
import stat
import sys
import uuid
from html import escape
from pathlib import Path

from markdown_it import MarkdownIt

from .domain import Run
from .reports import _MAX_BYTES, ReportError, _fsync_tree, run_directory
from .store import Store

__all__ = ["import_folder", "main"]

_HEX64 = re.compile(r"^[0-9a-f]{64}$")

# write_report_tree's structured section tree (tradingagents/reporting.py).
_SECTION_FOLDERS = ("1_analysts", "2_research", "3_trading", "4_risk", "5_portfolio")
_SECTION_FILES = {
    "1_analysts": ("market.md", "sentiment.md", "news.md", "fundamentals.md"),
    "2_research": ("bull.md", "bear.md", "manager.md"),
    "3_trading": ("trader.md",),
    "4_risk": ("aggressive.md", "conservative.md", "neutral.md"),
    "5_portfolio": ("decision.md",),
}
# cli/run.py's live-display decorator: flat `reports/<section>.md`, written as
# each section finalizes, independent of the end-of-run "Save report?" prompt
# (cli/display.py's MessageBuffer.REPORT_SECTIONS keys).
_FLAT_SECTION_NAMES = (
    "market_report",
    "sentiment_report",
    "news_report",
    "fundamentals_report",
    "investment_plan",
    "trader_investment_plan",
    "final_trade_decision",
)

_INPUT_KEYS = ("ticker", "analysis_date", "asset_type", "analysts", "research_depth")

_MD = MarkdownIt("commonmark", {"html": False}).disable("image")


def _validate_owner_hex(owner_id: str) -> str:
    """Only an explicit operator-assigned opaque key (``owner_key``'s own shape)."""
    if not isinstance(owner_id, str) or not _HEX64.fullmatch(owner_id):
        raise ValueError("owner_id must be an explicit 64-character lowercase hex key")
    return owner_id


def _regular_file(path: Path) -> bool:
    return path.is_file() and not path.is_symlink()


def _bounded_read(path: Path, remaining_budget: int) -> bytes:
    """No-follow, regular-file-only read, rejected *before* allocation if it
    would exceed the remaining budget."""
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


def _collect(source: Path, names: list[tuple[Path, Path]]) -> list[tuple[Path, bytes]]:
    """``[(relative_path, bytes), ...]`` for the present, recognized files in
    ``names`` (``(relative_path, absolute_path)`` pairs), bounded in total."""
    collected: list[tuple[Path, bytes]] = []
    remaining = _MAX_BYTES
    for relative, absolute in names:
        if not _regular_file(absolute):
            continue
        data = _bounded_read(absolute, remaining)
        remaining -= len(data)
        if remaining < 0:
            raise ReportError("REPORT_TOO_LARGE")
        collected.append((relative, data))
    return collected


def _find_content(source: Path) -> tuple[str, bool, list[tuple[Path, bytes]]]:
    """``(markdown_text, consolidated, files)``: ``files`` is exactly the
    recognized, bounded-read files that contributed — the one set the
    fingerprint hashes. Never infers content from name/mtime or globs."""
    consolidated_path = source / "complete_report.md"
    if _regular_file(consolidated_path):
        data = _bounded_read(consolidated_path, _MAX_BYTES)
        rel = Path("complete_report.md")
        return data.decode("utf-8", errors="replace"), True, [(rel, data)]

    nested = [
        (Path(folder) / name, source / folder / name)
        for folder in _SECTION_FOLDERS
        for name in _SECTION_FILES[folder]
    ]
    files = _collect(source, nested)
    if not files:
        flat = [(Path("reports") / f"{name}.md", source / "reports" / f"{name}.md") for name in _FLAT_SECTION_NAMES]
        files = _collect(source, flat)
    if not files:
        raise ReportError("REPORT_INVALID_FORMAT")
    text = "\n\n".join(data.decode("utf-8", errors="replace") for _rel, data in files)
    return text, False, files


def _fingerprint(files: list[tuple[Path, bytes]]) -> str:
    """Hash of exactly the recognized files ``_find_content`` accepted —
    ordered relative names + bytes. An unrelated config/log/checkpoint file
    elsewhere in the source folder never changes dedupe identity."""
    digest = hashlib.sha256()
    for rel, data in sorted(files, key=lambda item: str(item[0])):
        digest.update(str(rel).encode("utf-8"))
        digest.update(b"\0")
        digest.update(data)
        digest.update(b"\0")
    return digest.hexdigest()


def _title_from_markdown(markdown_text: str) -> str:
    for line in markdown_text.splitlines():
        stripped = line.strip().lstrip("#").strip()
        if line.strip().startswith("#") and stripped:
            return stripped
    return "Imported research"


def _render_html(markdown_text: str) -> str:
    """Regenerated from Markdown only: raw HTML/images disabled, CSP, escaped title."""
    title = escape(_title_from_markdown(markdown_text))
    body = _MD.render(markdown_text)
    return (
        "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n"
        "<meta http-equiv=\"Content-Security-Policy\" "
        "content=\"default-src 'none'; style-src 'unsafe-inline'\">\n"
        f"<title>{title}</title>\n</head>\n<body>\n<main>{body}</main>\n</body>\n</html>\n"
    )


def _write_exports(store: Store, owner: str, run_id: str, markdown_text: str) -> None:
    target_dir = run_directory(store, owner, run_id)
    exports_dir = target_dir / "exports"
    target_dir.mkdir(parents=True, exist_ok=True)
    stage = target_dir / f".exports-{uuid.uuid4().hex}"
    stage.mkdir(parents=True)
    try:
        (stage / "complete_report.md").write_text(markdown_text, encoding="utf-8")
        (stage / "complete_report.html").write_text(_render_html(markdown_text), encoding="utf-8")
        _fsync_tree(stage)
        os.replace(stage, exports_dir)
    except Exception:
        shutil.rmtree(stage, ignore_errors=True)
        raise


def import_folder(store: Store, source: Path, owner_id: str) -> Run:
    owner = _validate_owner_hex(owner_id)
    source = Path(source)
    if source.is_symlink() or not source.is_dir():
        raise ReportError("REPORT_INVALID_FORMAT")

    markdown_text, consolidated, files = _find_content(source)
    fingerprint = _fingerprint(files)
    inputs = dict.fromkeys(_INPUT_KEYS)
    inputs["analysts"] = []
    state = {"imported_markdown": markdown_text}

    run, created = store.add_import(owner, fingerprint, inputs, state, {}, not consolidated)
    if not created:
        return run

    try:
        _write_exports(store, run["owner_id"], run["id"], markdown_text)
    except Exception:
        store.discard_import(run["id"], owner)
        raise
    store.update(run["id"], artifacts_ready=True)
    return store.worker_run(run["id"])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m ta_web.import_reports")
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--owner-id", required=True)
    parser.add_argument("--source", required=True, type=Path)
    args = parser.parse_args(argv)

    store = Store(args.root)
    try:
        run = import_folder(store, args.source, args.owner_id)
    except (ValueError, ReportError) as exc:
        print(f"import failed: {exc}", file=sys.stderr)
        return 1
    print(f"{run['id']} status={run['status']} partial={run['partial']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
