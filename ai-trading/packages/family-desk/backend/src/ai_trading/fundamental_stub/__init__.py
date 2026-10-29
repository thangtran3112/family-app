"""`DESK_FUNDAMENTAL_STUB=1`: the contract-first stub layer of the Desktop Fundamental lane (02n §h step 3b), the 02m
§d2 step 2 pattern (`mvp_stub`) for the 17 new and 3 extended §c2 endpoints.

With the flag on, each endpoint answers from an invented world (`world.py`: no real holding, price, account or
statement), so the frontend codes against real response shapes before the real services exist. With it off, a new
endpoint answers 503 "not available yet" and serves nothing fake. The flag is read from the environment on each call
and is off in every deployed environment: no compose file, Dockerfile, or workflow under `ai-trading/` sets it
(`tests/test_mvp_stub_flag.py` proves that). Each real service replaces its stub branch, and this package is deleted
when the last one lands (02n §h step 8).

Labels: every stub stamp carries `source: "simulated"`, so no invented number passes for a provider's. Its `quality`
says what the real value will be (`delayed-15m` for quotes, `eod` for the Flex close); a field no provider covers yet
(futures prices for CL and GC) is the unavailable stamp with null values.

Builders return plain dicts that FastAPI validates against the endpoint's `response_model`, so this package imports no
response model and a shape drift fails the request, not silently.
"""

import os
from typing import Any, NoReturn

from fastapi import HTTPException

STUB_FLAG = "DESK_FUNDAMENTAL_STUB"
SIMULATED = "simulated"

#: The instant of the world's close: Friday 2026-10-23 at the 16:00 ET bell.
SNAPSHOT_AS_OF = "2026-10-23T20:00:00Z"


def stub_enabled() -> bool:
    return os.environ.get(STUB_FLAG) == "1"


def unavailable() -> NoReturn:
    """What a new endpoint answers while it has no real service yet and the stub flag is off."""
    raise HTTPException(status_code=503, detail="not available yet")


def stamp(
    quality: str = "delayed-15m", freshness: str = "closed", as_of: str | None = SNAPSHOT_AS_OF
) -> dict[str, Any]:
    return {"as_of": as_of, "source": SIMULATED, "quality": quality, "freshness": freshness}


def unavailable_stamp() -> dict[str, Any]:
    """A field nothing feeds yet (CL and GC prices, option quotes before the chain kind): nothing behind it."""
    return {"as_of": None, "source": None, "quality": "unavailable", "freshness": "unavailable"}
