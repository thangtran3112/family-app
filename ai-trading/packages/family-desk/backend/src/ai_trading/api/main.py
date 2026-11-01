"""The one served ASGI app (integration fix, PROTO-BRIEF.md): `infrastructure/apps/ai-trading/docker-compose.yml`'s
`api` service runs `uvicorn ai_trading.api.main:app`, the exact same FastAPI instance `app.py`
builds (routers, `/healthz`, and the lifespan that wires the DB engine, `DataSources`, the notify
channel map, and the background tick/dispatch loops from the environment at startup, never at
import time) -- `main.py` only re-exports it under this name and adds `main()`/`python -m
ai_trading.api.main` as a local-dev convenience around the same object, for running outside
uvicorn's own CLI invocation.
"""

import uvicorn

from ai_trading.api.app import app


def main() -> None:
    uvicorn.run(app, host="0.0.0.0", port=8000)


if __name__ == "__main__":
    main()
