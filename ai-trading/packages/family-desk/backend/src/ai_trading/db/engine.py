"""A minimal SQLAlchemy 2 engine/session helper. No pooling tuning, no global state: callers build
one engine per process (or per test database) and pass it in.
"""

from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker


def make_engine(url: str, *, lock_timeout_ms: int | None = None, idle_in_transaction_ms: int | None = None) -> Engine:
    """`lock_timeout_ms`: a statement that waits this long for a row lock fails (`LockNotAvailable`) instead of holding
    its pooled connection and a worker thread for as long as the holder lives. `idle_in_transaction_ms`: Postgres ends a
    connection that sits idle inside a transaction this long, which frees the locks it holds. Both are per connection;
    leave them out (the CLIs, the jobs) and nothing changes."""
    options = []
    if lock_timeout_ms is not None:
        options.append(f"-c lock_timeout={lock_timeout_ms}")
    if idle_in_transaction_ms is not None:
        options.append(f"-c idle_in_transaction_session_timeout={idle_in_transaction_ms}")
    return create_engine(url, connect_args={"options": " ".join(options)} if options else {})


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
