"""Fail closed unless E2E data is confined to a uniquely named loopback database."""

import re

from sqlalchemy.engine import URL, make_url

_DB_NAME = re.compile(r"desk_e2e_[0-9a-f]{12}\Z")
_LOOPBACK = {"127.0.0.1", "localhost", "::1"}


def e2e_url(value: str) -> URL:
    url = make_url(value)
    if url.drivername != "postgresql+psycopg" or url.host not in _LOOPBACK or not url.database:
        raise ValueError("E2E database must use psycopg and a loopback host")
    if not _DB_NAME.fullmatch(url.database):
        raise ValueError("E2E database name must be a unique desk_e2e_<12 hex> name")
    return url


def admin_url(value: str) -> URL:
    url = make_url(value)
    if url.drivername != "postgresql+psycopg" or url.host not in _LOOPBACK or url.database != "postgres":
        raise ValueError("E2E admin URL must use psycopg, loopback, and the postgres maintenance database")
    return url
