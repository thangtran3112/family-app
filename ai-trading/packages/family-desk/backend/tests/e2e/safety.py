"""Fail closed unless E2E data is confined to a uniquely named loopback database."""

import os
import re

from sqlalchemy.engine import URL, make_url

_DB_NAME = re.compile(r"desk_e2e_[0-9a-f]{12}\Z")
_LOOPBACK = {"127.0.0.1", "localhost", "::1"}
_LIBPQ_ROUTING_ENV = ("PGHOST", "PGHOSTADDR", "PGPORT", "PGDATABASE", "PGSERVICE", "PGSERVICEFILE")


def _reject_ambient_routing() -> None:
    if any(os.environ.get(name) for name in _LIBPQ_ROUTING_ENV):
        raise ValueError("E2E database refuses libpq routing environment overrides")


def e2e_url(value: str) -> URL:
    _reject_ambient_routing()
    url = make_url(value)
    if url.query:
        raise ValueError("E2E database URL must not include query parameters")
    if url.drivername != "postgresql+psycopg" or url.host not in _LOOPBACK or not url.database:
        raise ValueError("E2E database must use psycopg and a loopback host")
    if not _DB_NAME.fullmatch(url.database):
        raise ValueError("E2E database name must be a unique desk_e2e_<12 hex> name")
    return url


def admin_url(value: str) -> URL:
    _reject_ambient_routing()
    url = make_url(value)
    if url.query:
        raise ValueError("E2E admin URL must not include query parameters")
    if url.drivername != "postgresql+psycopg" or url.host not in _LOOPBACK or url.database != "postgres":
        raise ValueError("E2E admin URL must use psycopg, loopback, and the postgres maintenance database")
    return url
