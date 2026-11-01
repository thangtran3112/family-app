"""Gateway-verified identity (PROTO-BRIEF.md §4 L4).

`IDENTITY_HEADER` is the header Caddy's `forward_auth` sets from Clerk's verified email
(`infrastructure/apps/ai-trading/Caddyfile`: every protected route strips any caller-supplied
`Cf-Access-Authenticated-User-Email` first, then `copy_headers X-Verified-Email>
Cf-Access-Authenticated-User-Email` writes the gateway's own verified value). This module only
ever trusts that one header name -- never a query param, a cookie, or any other header -- so a
request that reaches this process without going through Caddy's `forward_auth` (or carrying a
forged value Caddy didn't strip) is Caddy's trust boundary to hold, not this function's: proven by
the production Caddyfile's own integration test, not re-proven here.
"""

from collections.abc import Iterator
from dataclasses import dataclass

from ai_trading_common.registry import DataSources
from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from ai_trading.db.engine import session_scope
from ai_trading.db.models import User

IDENTITY_HEADER = "Cf-Access-Authenticated-User-Email"  # set by Caddy's forward_auth copy_headers


@dataclass(frozen=True)
class AuthedUser:
    id: int
    email: str


def get_session(request: Request) -> Iterator[Session]:
    """One fresh `Session` per request, committed on a clean response and rolled back on an
    exception (`ai_trading.db.engine.session_scope`) -- never one long-lived session for the
    process's lifetime. `request.app.state.session_factory` is built once at startup
    (`api/app.py`'s lifespan) from `DESK_RUNTIME_DATABASE_URL`; tests override this dependency
    directly with `tests/conftest.py`'s real-Postgres `db_session` fixture instead of touching
    `app.state`."""
    factory: sessionmaker[Session] = request.app.state.session_factory
    with session_scope(factory) as session:
        yield session


def get_data_sources(request: Request) -> DataSources:
    """The process-wide `DataSources` built once at startup (`api/app.py`'s lifespan) from
    `DataSources.from_env()`; tests override this dependency with a fake instead of touching
    `app.state`."""
    return request.app.state.data_sources


def get_current_user(request: Request, session: Session = Depends(get_session)) -> AuthedUser:
    """401 if `IDENTITY_HEADER` is missing or empty -- never trusts any other header, and never
    falls back to a query param or cookie. On a known email, looks up (and lazily creates, since
    only two users ever exist) the `users` row. A request whose header carries a forged identity
    is never distinguishable from a legitimate one at this layer -- that trust boundary is Caddy's
    forward_auth, proven by the existing production integration test; this function only trusts
    whatever header name reaches it, by design."""
    email = _verified_email(request)
    return _user_for_email(email, session)


def get_current_user_for_stream(request: Request) -> AuthedUser:
    """Resolve the same gateway identity with a short-lived session before an SSE response starts."""
    email = _verified_email(request)
    with session_scope(request.app.state.session_factory) as session:
        return _user_for_email(email, session)


def _verified_email(request: Request) -> str:
    email = request.headers.get(IDENTITY_HEADER)
    if not email:
        raise HTTPException(status_code=401, detail="missing verified identity header")
    return email


def _user_for_email(email: str, session: Session) -> AuthedUser:
    user = session.execute(select(User).where(User.email == email)).scalar_one_or_none()
    if user is None:
        user = User(email=email, settings={})
        session.add(user)
        session.flush()  # assign user.id without ending the request's transaction early
    return AuthedUser(id=user.id, email=user.email)
