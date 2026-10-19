import pytest
from safety import admin_url, e2e_url

_ADMIN = "postgresql+psycopg://fake:fake@127.0.0.1/postgres"
_E2E = "postgresql+psycopg://fake:fake@127.0.0.1/desk_e2e_0123456789ab"
_OVERRIDES = (
    "host=outside.invalid",
    "hostaddr=outside.invalid",
    "port=5433",
    "dbname=not_a_test_database",
    "service=production",
)


def test_dedicated_loopback_dsns_keep_their_database_scope():
    assert admin_url(_ADMIN).database == "postgres"
    assert e2e_url(_E2E).database == "desk_e2e_0123456789ab"


@pytest.mark.parametrize("override", _OVERRIDES)
def test_admin_dsn_rejects_connection_query_overrides_without_connecting(override):
    with pytest.raises(ValueError, match="query parameters"):
        admin_url(f"{_ADMIN}?{override}")


@pytest.mark.parametrize("override", _OVERRIDES)
def test_e2e_dsn_rejects_connection_query_overrides_without_connecting(override):
    with pytest.raises(ValueError, match="query parameters"):
        e2e_url(f"{_E2E}?{override}")


@pytest.mark.parametrize("name", ("PGHOST", "PGHOSTADDR", "PGPORT", "PGDATABASE", "PGSERVICE", "PGSERVICEFILE"))
def test_dsn_guards_reject_ambient_libpq_routing_overrides(monkeypatch, name):
    monkeypatch.setenv(name, "unsafe-ambient-override")
    with pytest.raises(ValueError, match="libpq routing environment"):
        admin_url(_ADMIN)
    with pytest.raises(ValueError, match="libpq routing environment"):
        e2e_url(_E2E)
