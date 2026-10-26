"""Feedback log CLI (02s): `python -m ai_trading.cli.feedback <command>`. How Hermes and Claude Code pick up the open
reports on the owner's say-so ("pick up the open feedback"): there is no poller, no auto-fix and no HTTP token. Needs
`DESK_RUNTIME_DATABASE_URL` in the environment (render it with
`common/config/family_config.py run ai-trading/desk -- ...`; this program never prints it).

    list [--status S ...] [--kind K] [--json]        the log, newest first, with the counts per status
    show F-014 [--json]                              one report with its links, screenshots and timeline
    export F-014 --dir DIR                           write its screenshots to DIR (never inside a git repository)
    start F-014 --actor claude-code [--note ...]     open -> in progress
    fix F-014 --ref <commit and/or PR #n> --actor claude-code [--note ...]
    wontfix F-014 --note "..." --actor owner         the owner's say-so, with the reason she will read
    duplicate F-014 --of F-009 --actor owner

Every write goes through `ai_trading.feedback`, the same service functions as the API, so the transition rules hold
here too: `--actor` is required and is written to the timeline, and `wontfix` and `duplicate` are the owner's alone.
Exit 0 on success, 1 when a rule refuses the change, 2 on a usage or setup error.

Example, from `ai-trading/packages/family-desk/backend`:

    ../../../../common/config/family_config.py run ai-trading/desk -- \\
        uv run python -m ai_trading.cli.feedback list --status open --json
"""

import argparse
import json
import os
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from ai_trading import feedback as svc
from ai_trading.api.schemas.feedback import FeedbackDetailOut, FeedbackListOut
from ai_trading.db.engine import make_engine, make_session_factory, session_scope

DATABASE_URL_VAR = "DESK_RUNTIME_DATABASE_URL"
ACTORS = ("owner", "claude-code", "hermes")


def _report_id(text: str) -> int:
    try:
        return svc.parse_ref(text)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(str(exc)) from None


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="feedback", description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)

    list_ = sub.add_parser("list")
    list_.add_argument("--status", action="append", choices=svc.STATUSES)
    list_.add_argument("--kind", choices=("bug", "request"))
    list_.add_argument("--json", action="store_true")

    show = sub.add_parser("show")
    show.add_argument("report", type=_report_id)
    show.add_argument("--json", action="store_true")

    export = sub.add_parser("export")
    export.add_argument("report", type=_report_id)
    export.add_argument("--dir", required=True, type=Path)

    for name in ("start", "fix", "wontfix", "duplicate"):
        write = sub.add_parser(name)
        write.add_argument("report", type=_report_id)
        write.add_argument("--actor", required=True, choices=ACTORS)
        write.add_argument("--note", required=name == "wontfix")
    sub.choices["fix"].add_argument("--ref", dest="fix_ref", required=True)
    sub.choices["duplicate"].add_argument("--of", dest="original", required=True, type=_report_id)
    return parser


def inside_git_repository(path: Path) -> bool:
    """The repository is public: screenshots can show balances, so they never land in any git work tree."""
    path = path.expanduser().resolve()
    return any((candidate / ".git").exists() for candidate in (path, *path.parents))


def _print_json(model: Any, data: dict[str, Any]) -> None:
    print(json.dumps(model.model_validate(data).model_dump(mode="json"), indent=2))


def _print_item(item: dict[str, Any]) -> None:
    kind = f"bug {item['severity']}" if item["kind"] == "bug" else "request"
    print(f"{item['ref']}  {item['status']:<11}  {kind:<8}  {item['title']}  ({item['area']}, {item['reported_by']})")


def _print_report(report: dict[str, Any]) -> None:
    _print_item(report)
    print(f"route: {report['route']}   screen: {report['screen']}   version: {report['app_version']}")
    print(f"\n{report['body']}")
    if report["expected"]:
        print(f"\nexpected: {report['expected']}")
    for link in report["links"]:
        print(f"link: {link['url']}" + (f"  ({link['label']})" if link["label"] else ""))
    for attachment in report["attachments"]:
        print(f"screenshot {attachment['id']}: {attachment['filename']} ({attachment['size_bytes']:,} bytes)")
    if report["fix_ref"]:
        print(f"fixed in: {report['fix_ref']}")
    if report["duplicate_of"]:
        print(f"duplicate of: {svc.ref(report['duplicate_of'])}")
    print("\ntimeline:")
    for event in report["events"]:
        move = f"{event['from_status'] or '-'} -> {event['to_status']}"
        note = f"  {event['note']}" if event["note"] else ""
        print(f"  {event['at']:%Y-%m-%d %H:%M}  {event['actor']:<11} {move}{note}")


def _run(args: argparse.Namespace, db: Any, now: datetime) -> int:
    if args.command == "list":
        found = svc.list_reports(db, statuses=args.status, kind=args.kind, limit=100)  # the API's own maximum
        if args.json:
            _print_json(FeedbackListOut, found)
        else:
            for item in found["items"]:
                _print_item(item)
            print("  ".join(f"{status}: {count}" for status, count in found["counts"].items()))
        return 0
    if args.command == "show":
        report = svc.detail(db, args.report)
        if args.json:
            _print_json(FeedbackDetailOut, report)
        else:
            _print_report(report)
        return 0
    if args.command == "export":
        svc.detail(db, args.report)  # a missing report is a 404, not an empty folder
        if inside_git_repository(args.dir):
            print("--dir must be outside every git repository: screenshots can show balances", file=sys.stderr)
            return 2
        args.dir.mkdir(parents=True, exist_ok=True)
        for attachment_id, filename, payload in svc.report_screenshots(db, args.report):
            target = args.dir / f"{svc.ref(args.report)}-{attachment_id}-{filename}"
            target.write_bytes(payload)
            print(target)
        return 0
    actor = svc.Actor(args.actor)
    if args.command == "start":
        svc.set_status(db, args.report, actor, "in_progress", note=args.note, now=now)
    elif args.command == "fix":
        svc.set_status(db, args.report, actor, "fixed", fix_ref=args.fix_ref, note=args.note, now=now)
    elif args.command == "wontfix":
        svc.set_status(db, args.report, actor, "wont_fix", note=args.note, now=now)
    else:
        svc.set_status(db, args.report, actor, "duplicate", duplicate_of=args.original, note=args.note, now=now)
    print(f"{svc.ref(args.report)}: done")
    return 0


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    url = os.environ.get(DATABASE_URL_VAR)
    if not url:
        print(f"{DATABASE_URL_VAR} is not set", file=sys.stderr)
        return 2
    engine = make_engine(url)
    try:
        with session_scope(make_session_factory(engine)) as db:
            return _run(args, db, datetime.now(UTC))
    except svc.FeedbackProblem as exc:
        print(f"{exc.path}: {exc.message}" if exc.path else exc.message, file=sys.stderr)
    except svc.FeedbackError as exc:
        print(f"{exc.status}: {exc.message}", file=sys.stderr)
    finally:
        engine.dispose()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
