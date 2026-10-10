"""Operator-driven legacy report import: assign an explicit owner, never HTTP.

Accepts only an explicit, already-opaque owner key (the hex shape
``owner_key`` produces) and a recognized Markdown report layout — a
consolidated ``complete_report.md`` or surviving per-section CLI report
files. Completion/ownership is never inferred from folder name or mtime.
Content is hashed (ordered relative names + bytes, excluding old HTML, which
is never trusted/regenerated-from) for per-owner dedupe; the source folder is
only ever read, never modified. ``Store.add_import``'s ``created`` flag plus
``discard_import`` roll back only this call's own not-yet-published row/files
on failure — an existing dedupe hit is returned untouched.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import sys
import uuid
from html import escape
from pathlib import Path

from markdown_it import MarkdownIt

from .domain import Run
from .reports import ReportError, _fsync_tree, run_directory
from .store import Store

__all__ = ["import_folder", "main"]

_HEX64 = re.compile(r"^[0-9a-f]{64}$")
_SECTION_FOLDERS = ("1_analysts", "2_research", "3_trading", "4_risk", "5_portfolio")
_SECTION_FILES = {
    "1_analysts": ("market.md", "sentiment.md", "news.md", "fundamentals.md"),
    "2_research": ("bull.md", "bear.md", "manager.md"),
    "3_trading": ("trader.md",),
    "4_risk": ("aggressive.md", "conservative.md", "neutral.md"),
    "5_portfolio": ("decision.md",),
}
_INPUT_KEYS = ("ticker", "analysis_date", "asset_type", "analysts", "research_depth")

_MD = MarkdownIt("commonmark", {"html": False}).disable("image")


def _validate_owner_hex(owner_id: str) -> str:
    """Only an explicit operator-assigned opaque key (``owner_key``'s own shape)."""
    if not isinstance(owner_id, str) or not _HEX64.fullmatch(owner_id):
        raise ValueError("owner_id must be an explicit 64-character lowercase hex key")
    return owner_id


def _find_content(source: Path) -> tuple[str, bool]:
    """``(markdown_text, consolidated)``; never infers content from name/mtime."""
    consolidated_path = source / "complete_report.md"
    if consolidated_path.is_file() and not consolidated_path.is_symlink():
        return consolidated_path.read_text(encoding="utf-8", errors="replace"), True

    parts = []
    for folder in _SECTION_FOLDERS:
        for name in _SECTION_FILES[folder]:
            path = source / folder / name
            if path.is_file() and not path.is_symlink():
                parts.append(path.read_text(encoding="utf-8", errors="replace"))
    if parts:
        return "\n\n".join(parts), False
    raise ReportError("REPORT_INVALID_FORMAT")


def _iter_regular_files(source: Path):
    for root, dirs, files in os.walk(source, followlinks=False):
        dirs[:] = [d for d in dirs if not (Path(root, d)).is_symlink()]
        for name in files:
            path = Path(root, name)
            if not path.is_symlink():
                yield path.relative_to(source)


def _fingerprint(source: Path) -> str:
    """Ordered relative names + contents, excluding old HTML (never trusted)."""
    digest = hashlib.sha256()
    for rel in sorted(_iter_regular_files(source), key=str):
        if rel.suffix.lower() in (".html", ".htm"):
            continue
        digest.update(str(rel).encode("utf-8"))
        digest.update(b"\0")
        digest.update((source / rel).read_bytes())
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


def _write_exports(store: Store, run_id: str, markdown_text: str) -> None:
    target_dir = run_directory(store, run_id)
    exports_dir = target_dir / "exports"
    target_dir.mkdir(parents=True, exist_ok=True)
    stage = target_dir / f".exports-{uuid.uuid4().hex}"
    stage.mkdir(parents=True)
    (stage / "complete_report.md").write_text(markdown_text, encoding="utf-8")
    (stage / "complete_report.html").write_text(_render_html(markdown_text), encoding="utf-8")
    _fsync_tree(stage)
    os.replace(stage, exports_dir)


def import_folder(store: Store, source: Path, owner_id: str) -> Run:
    owner = _validate_owner_hex(owner_id)
    source = Path(source)
    if source.is_symlink() or not source.is_dir():
        raise ReportError("REPORT_INVALID_FORMAT")

    markdown_text, consolidated = _find_content(source)
    fingerprint = _fingerprint(source)
    inputs = dict.fromkeys(_INPUT_KEYS)
    inputs["analysts"] = []
    state = {"imported_markdown": markdown_text}

    run, created = store.add_import(owner, fingerprint, inputs, state, {}, not consolidated)
    if not created:
        return run

    try:
        _write_exports(store, run["id"], markdown_text)
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
