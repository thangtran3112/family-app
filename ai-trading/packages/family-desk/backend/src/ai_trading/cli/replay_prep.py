"""Replay data prep CLI (02o): `python -m ai_trading.cli.replay_prep <command>`. Read-only market data into the
`replay_blobs` cache; nothing here places or simulates an order. Needs `DESK_RUNTIME_DATABASE_URL` and the Alpaca
keys in the environment (render them with `common/config/family_config.py run ai-trading/desk -- ...`; this
program never prints them).

    bars    Preload raw 1-minute bars (plus 10 prior sessions) and daily bars for every replay day.
            --symbols A,B | --file symbols.txt | --watchlists     (the universe)
            --from 2026-09-21 --to 2026-10-23 | --last-sessions 21 (the replay days; default the last 21)
    tape    Pre-warm consolidated prints for chosen symbols and days (opt-in: dense days are millions of prints).
            --symbols A,B --days 2026-10-22,2026-10-23 --mode first-hour|regular|window [--from 09:30 --to 10:30]
    days    Backfill or refresh the notable-days table (--symbols, default the watchlist symbols).
    status  What the cache holds.

Example, 50 symbols over the last month of sessions (about 250 requests, a few minutes on the free plan):

    uv run python -m ai_trading.cli.replay_prep bars --file universe.txt --last-sessions 21
"""

import argparse
import os
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, date, datetime
from pathlib import Path
from unittest import mock

import requests
from ai_trading_common.registry import DataSources

from ai_trading.db.engine import make_engine, make_session_factory, session_scope
from ai_trading.replay import cache, days, prep
from ai_trading.replay.cache import DbBlobStore
from ai_trading.replay.data import History
from ai_trading.replay.tape import Tape

DATABASE_URL_VAR = "DESK_RUNTIME_DATABASE_URL"
DEFAULT_SESSIONS = 21


@contextmanager
def count_http() -> Iterator[list[int]]:
    """Counts the HTTP requests the providers make (the pages behind each provider call), for the final report."""
    count = [0]
    original = requests.Session.get

    def counted(self, *args, **kwargs):
        count[0] += 1
        return original(self, *args, **kwargs)

    with mock.patch.object(requests.Session, "get", counted):
        yield count


def _symbols(args: argparse.Namespace, db) -> list[str]:
    if args.symbols:
        found = [s.strip().upper() for s in args.symbols.split(",") if s.strip()]
    elif args.file:
        lines = Path(args.file).read_text().splitlines()
        found = [line.split("#")[0].strip().upper() for line in lines if line.split("#")[0].strip()]
    elif getattr(args, "watchlists", False):
        found = days.watchlist_symbols(db)
    else:
        found = []
    return list(dict.fromkeys(found))


def _replay_days(args: argparse.Namespace, now: datetime) -> list[date]:
    if args.first:
        last = date.fromisoformat(args.last) if args.last else days.last_sessions(now, 1)[0]
        return prep.sessions_between(date.fromisoformat(args.first), last)
    last = date.fromisoformat(args.last) if args.last else None
    pool = days.last_sessions(now, args.last_sessions + 40)
    if last:
        pool = [d for d in pool if d <= last]
    return pool[-args.last_sessions :]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="replay_prep", description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("bars", "tape", "days"):
        p = sub.add_parser(name)
        p.add_argument("--symbols")
        p.add_argument("--file")
        if name != "tape":
            p.add_argument("--watchlists", action="store_true")
    bars = sub.choices["bars"]
    bars.add_argument("--from", dest="first")
    bars.add_argument("--to", dest="last")
    bars.add_argument("--last-sessions", type=int, default=DEFAULT_SESSIONS)
    tape = sub.choices["tape"]
    tape.add_argument("--days", required=True, help="comma-separated YYYY-MM-DD; opt-in per day")
    tape.add_argument("--mode", choices=("first-hour", "regular", "window"), default="first-hour")
    tape.add_argument("--from", dest="start")
    tape.add_argument("--to", dest="end")
    tape.add_argument("--feed", choices=("sip", "iex"), default="sip")
    sub.add_parser("status")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    url = os.environ.get(DATABASE_URL_VAR)
    if not url:
        print(f"{DATABASE_URL_VAR} is not set", file=sys.stderr)
        return 2
    factory = make_session_factory(make_engine(url))
    now = datetime.now(UTC)
    sources = DataSources.from_env()
    with session_scope(factory) as db:
        store = DbBlobStore(db)
        if args.command == "status":
            rows = cache.stats(db)
            for kind, blobs, count, size in rows:
                print(f"{kind:<7} {blobs:>7,} blobs {count:>12,} rows {size / 1e6:>9.1f} MB stored")
            print("(no blobs)" if not rows else "")
            return 0
        symbols = _symbols(args, db)
        if not symbols and args.command != "days":
            print("name the symbols: --symbols, --file, or --watchlists", file=sys.stderr)
            return 2
        if args.command == "bars":
            replay_days = _replay_days(args, now)
            print(
                f"bars: {len(symbols)} symbols x {len(replay_days)} replay days "
                f"({replay_days[0]} to {replay_days[-1]}), +10 prior sessions each"
            )
            with count_http() as http:
                report = prep.preload_bars(History(sources), store, symbols, replay_days, now=now)
            db.commit()
            print(
                f"done: {report.symbols} symbols, {report.fetched_sessions} new symbol-sessions, "
                f"{http[0]} HTTP requests, {report.seconds:.0f}s; failed: {sorted(report.failed) or 'none'}"
            )
            return 1 if report.failed else 0
        if args.command == "tape":
            tape = Tape(sources)
            failed = 0
            with count_http() as http:
                for symbol in symbols:
                    for text in args.days.split(","):
                        day = date.fromisoformat(text.strip())
                        window = prep.tape_window(day, args.mode, args.start, args.end)
                        failed += len(prep.prewarm_tape(tape, store, symbol, day, window, feed=args.feed).failed)
                        db.commit()
            print(f"done: {http[0]} HTTP requests")
            return 1 if failed else 0
        added = days.refresh(db, sources, now=now, symbols=symbols or None)
        db.commit()
        print(f"notable days: {sum(added.values())} sessions scored for {len(added)} symbols")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
