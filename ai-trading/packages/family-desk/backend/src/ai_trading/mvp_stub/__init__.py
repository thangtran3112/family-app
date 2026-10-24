"""`DESK_MVP_STUB=1`: the contract-first stub layer of the technical desktop MVP (02m §d2 step 2).

Every new or extended endpoint answers from the trimmed Run 0 snapshot (`tests/fixtures/desk-mvp/`)
when the flag is on, so the frontend codes against real response shapes before the real services
exist. The flag is read from the environment on each call and is off in every deployed environment:
no compose file, Dockerfile, or workflow under `ai-trading/` sets it (`tests/test_mvp_stub_flag.py`
proves that). Each real service replaces its stub branch, and this package is deleted at the end of
02m §d2 step 3.

Builders here return plain dicts that FastAPI validates against the endpoint's `response_model`, so
this package imports no response model and a shape drift fails the request, not silently.
"""

import json
import os
from datetime import UTC, datetime
from functools import cache
from pathlib import Path
from typing import Any, NoReturn
from zoneinfo import ZoneInfo

from fastapi import HTTPException

STUB_FLAG = "DESK_MVP_STUB"
FIXTURE_DIR_VAR = "DESK_MVP_FIXTURE_DIR"
_REPO_FIXTURES = Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "desk-mvp"
_ET = ZoneInfo("America/New_York")

#: The instant the snapshot was taken: Friday 2026-10-23 at the 16:00 ET close. Every stub stamp
#: uses it, so stub output never depends on the wall clock.
SNAPSHOT_AS_OF = "2026-10-23T20:00:00Z"


def stub_enabled() -> bool:
    return os.environ.get(STUB_FLAG) == "1"


def unavailable() -> NoReturn:
    """What an endpoint answers while it has no real service yet and the stub flag is off."""
    raise HTTPException(status_code=503, detail="not available yet")


def fixture_dir() -> Path:
    return Path(os.environ.get(FIXTURE_DIR_VAR) or _REPO_FIXTURES)


@cache
def snapshot() -> dict[str, Any]:
    """The trimmed snapshot (`scripts/trim_desk_mvp_snapshot.py`). Treat it as read-only."""
    path = fixture_dir() / "snapshot_trimmed.json"
    if not path.is_file():
        raise HTTPException(status_code=503, detail=f"stub fixture missing; set {FIXTURE_DIR_VAR}")
    return json.loads(path.read_text())


def stamp(
    freshness: str = "closed",
    quality: str = "delayed-15m",
    source: str | None = "alpaca",
    as_of: str | None = SNAPSHOT_AS_OF,
) -> dict[str, Any]:
    return {"as_of": as_of, "source": source, "quality": quality, "freshness": freshness}


def unavailable_stamp() -> dict[str, Any]:
    """The ES and NQ tiles before the IBKR slot is live: a stamp with nothing behind it."""
    return stamp(freshness="unavailable", quality="unavailable", source=None, as_of=None)


def et_to_utc(text: str) -> str:
    """The snapshot's ET strings (`2026-10-23 15:45`, or a bare date) as ISO-8601 UTC with `Z`."""
    moment = datetime.fromisoformat(text.replace(" ", "T"))
    return moment.replace(tzinfo=_ET).astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def et_to_utc_offset(text: str) -> str:
    """Same instant in the `+00:00` form the existing `/bars` and `/technicals` routes emit."""
    moment = datetime.fromisoformat(text.replace(" ", "T")).replace(tzinfo=_ET)
    return moment.astimezone(UTC).isoformat()
