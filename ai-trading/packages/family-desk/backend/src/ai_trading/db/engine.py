"""A minimal SQLAlchemy 2 engine/session helper. No pooling tuning, no global state: callers build
one engine per process (or per test database) and pass it in.
"""

from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker


def make_engine(url: str) -> Engine:
    return create_engine(url)


def make_session_factory(engine: Engine) -> sessionmaker[Session]:
    return sessionmaker(engine, expire_on_commit=False)


def make_health_check_engine(url: str) -> Engine:
    """A dedicated engine for the `/healthz` readiness probe (Step 0 integration fix): a 1-second
    `connect_timeout` bounds how long an unreachable or slow-to-answer database can block the
    check, independent of the main session_factory's engine (a real request should wait for a
    real connection, never time out after 1s). `psycopg`'s `connect_timeout` connect arg is a
    TCP-connect-phase timeout; a `SELECT 1` against an already-open connection returns
    essentially immediately, so this is the only timeout the probe needs.
    """
    return create_engine(url, connect_args={"connect_timeout": 1})


@contextmanager
def session_scope(factory: sessionmaker[Session]) -> Iterator[Session]:
    """Commits on a clean exit, rolls back and re-raises otherwise."""
    session = factory()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
