from datetime import UTC, datetime

from conftest import OTHER_EMAIL, OWNER_EMAIL, auth_headers
from sqlalchemy import select

from ai_trading.db.models import Alert, User

NOW = datetime(2026, 7, 15, 20, 0, tzinfo=UTC)


def _user_id(client, db_session, email: str) -> int:
    client.get("/api/desk/settings", headers=auth_headers(email))
    return db_session.execute(select(User.id).where(User.email == email)).scalar_one()


def _make_alert(db_session, user_id: int, *, read_at=None) -> Alert:
    alert = Alert(user_id=user_id, kind="system", severity="info", title="t", body="b", created_at=NOW, read_at=read_at)
    db_session.add(alert)
    db_session.flush()
    return alert


def test_list_alerts_unread_filter(client, db_session):
    owner_id = _user_id(client, db_session, OWNER_EMAIL)
    unread = _make_alert(db_session, owner_id)
    _make_alert(db_session, owner_id, read_at=NOW)

    response = client.get("/api/desk/alerts", params={"unread": "true"}, headers=auth_headers(OWNER_EMAIL))

    assert [row["id"] for row in response.json()] == [unread.id]


def test_list_alerts_is_scoped_to_the_current_user(client, db_session):
    owner_id = _user_id(client, db_session, OWNER_EMAIL)
    other_id = _user_id(client, db_session, OTHER_EMAIL)
    mine = _make_alert(db_session, owner_id)
    _make_alert(db_session, other_id)

    response = client.get("/api/desk/alerts", headers=auth_headers(OWNER_EMAIL))

    assert [row["id"] for row in response.json()] == [mine.id]


def test_mark_alert_read_sets_read_at(client, db_session):
    owner_id = _user_id(client, db_session, OWNER_EMAIL)
    alert = _make_alert(db_session, owner_id)

    response = client.post(f"/api/desk/alerts/{alert.id}/read", headers=auth_headers(OWNER_EMAIL))

    assert response.status_code == 200
    assert response.json()["read_at"] is not None


def test_mark_alert_read_404s_for_a_non_owner(client, db_session):
    owner_id = _user_id(client, db_session, OWNER_EMAIL)
    _user_id(client, db_session, OTHER_EMAIL)
    alert = _make_alert(db_session, owner_id)

    response = client.post(f"/api/desk/alerts/{alert.id}/read", headers=auth_headers(OTHER_EMAIL))

    assert response.status_code == 404
