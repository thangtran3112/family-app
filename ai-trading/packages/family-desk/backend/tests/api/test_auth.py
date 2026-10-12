"""Review Focus (PROTO-BRIEF.md §4 L4): identity comes only from `IDENTITY_HEADER`, never a query
param or cookie, and a forged header from outside the gateway is Caddy's trust boundary to hold,
not this layer's -- this file only proves the header *is* trusted when present and *is* required
when absent."""

from conftest import OTHER_EMAIL, OWNER_EMAIL, auth_headers
from sqlalchemy import select

from ai_trading.db.models import User


def test_missing_identity_header_is_401(client):
    response = client.get("/api/desk/settings")
    assert response.status_code == 401


def test_present_identity_header_looks_up_the_right_user_row(client, db_session):
    response = client.get("/api/desk/settings", headers=auth_headers(OWNER_EMAIL))
    assert response.status_code == 200

    user = db_session.execute(select(User).where(User.email == OWNER_EMAIL)).scalar_one()
    assert user.email == OWNER_EMAIL


def test_two_different_emails_map_to_two_different_user_rows(client, db_session):
    client.get("/api/desk/settings", headers=auth_headers(OWNER_EMAIL))
    client.get("/api/desk/settings", headers=auth_headers(OTHER_EMAIL))

    owner = db_session.execute(select(User).where(User.email == OWNER_EMAIL)).scalar_one()
    other = db_session.execute(select(User).where(User.email == OTHER_EMAIL)).scalar_one()
    assert owner.id != other.id


def test_a_query_param_or_cookie_never_substitutes_for_the_header(client):
    client.cookies.set("email", OWNER_EMAIL)
    response = client.get(f"/api/desk/settings?{OWNER_EMAIL.replace('@', '%40')}=1")
    assert response.status_code == 401
