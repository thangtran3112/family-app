from conftest import OWNER_EMAIL, auth_headers


def test_get_settings_defaults_to_an_empty_object(client):
    response = client.get("/api/desk/settings", headers=auth_headers(OWNER_EMAIL))

    assert response.status_code == 200
    assert response.json() == {"settings": {}}


def test_put_settings_round_trips(client):
    body = {"settings": {"quiet_hours": {"start": "22:00", "end": "07:00"}, "channels": ["inbox", "telegram"]}}

    put = client.put("/api/desk/settings", json=body, headers=auth_headers(OWNER_EMAIL))
    get = client.get("/api/desk/settings", headers=auth_headers(OWNER_EMAIL))

    assert put.status_code == 200
    assert put.json() == body
    assert get.json() == body
