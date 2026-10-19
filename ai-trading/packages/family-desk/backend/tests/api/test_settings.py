import pytest
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


@pytest.mark.parametrize(
    "quiet_hours",
    [
        {"start": "25:00", "end": "07:30"},
        {"start": "22:00", "end": "7:30"},
        {"start": "22:00", "end": "07:30:00"},
        {"start": "22:00"},
        "22:00-07:30",
    ],
)
def test_put_settings_rejects_invalid_quiet_hours_before_persistence(client, quiet_hours):
    response = client.put(
        "/api/desk/settings",
        json={"settings": {"quiet_hours": quiet_hours}},
        headers=auth_headers(OWNER_EMAIL),
    )

    assert response.status_code == 422
    assert client.get("/api/desk/settings", headers=auth_headers(OWNER_EMAIL)).json() == {"settings": {}}


@pytest.mark.parametrize("channels", ["telegram", ["telegram", "sms"], [1]])
def test_put_settings_rejects_invalid_channel_preferences(client, channels):
    response = client.put(
        "/api/desk/settings",
        json={"settings": {"channels": channels}},
        headers=auth_headers(OWNER_EMAIL),
    )

    assert response.status_code == 422
    assert client.get("/api/desk/settings", headers=auth_headers(OWNER_EMAIL)).json() == {"settings": {}}


def test_put_settings_accepts_explicit_empty_channels_and_preserves_unknown_keys(client):
    body = {"settings": {"channels": [], "quiet_hours": {"start": "22:00", "end": "07:30", "custom": True}, "other": 1}}

    response = client.put("/api/desk/settings", json=body, headers=auth_headers(OWNER_EMAIL))

    assert response.status_code == 200
    assert response.json() == body


def test_put_settings_rejects_unicode_digits_without_overwriting_unknown_metadata(client):
    original = {
        "settings": {
            "channels": ["inbox"],
            "quiet_hours": {"start": "22:00", "end": "07:00", "future": {"keep": True}},
            "future_setting": {"keep": True},
        }
    }
    valid = client.put("/api/desk/settings", json=original, headers=auth_headers(OWNER_EMAIL))
    assert valid.status_code == 200

    invalid = {
        "settings": {
            **original["settings"],
            "quiet_hours": {**original["settings"]["quiet_hours"], "start": "0\u0661:0\u0660"},
        }
    }
    response = client.put("/api/desk/settings", json=invalid, headers=auth_headers(OWNER_EMAIL))

    assert response.status_code == 422
    assert client.get("/api/desk/settings", headers=auth_headers(OWNER_EMAIL)).json() == original
