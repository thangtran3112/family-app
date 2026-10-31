"""`/api/desk/settings` new keys (02m §a3.9) and channels (§a3.8): shapes per channel state, the
Telegram link, and the test send through fake channel objects. Nothing here reaches the network."""

import pytest
from conftest import OWNER_EMAIL, auth_headers
from sqlalchemy import select

import ai_trading.api.settings as settings_module
from ai_trading.db.models import User
from ai_trading.notify.channel import ChannelError, RuntimeGated
from ai_trading.notify.dispatch import RETRY_DELAYS_SECONDS

CHAT_ID = "123456789"
SECRET_TEXT = "TEST-BOT-TOKEN-XYZ"


class FakeChannel:
    """Duck-typed `Channel`: records every send's title; the first `fail_times` sends raise."""

    def __init__(self, name: str, *, fail_times: int = 0, error_text: str = "down") -> None:
        self.name = name
        self.fail_times = fail_times
        self.error_text = error_text
        self.titles: list[str] = []
        self.chat_ids: list[str | None] = []

    def send(self, *, title: str, body: str, severity: str, chat_id: str | None = None) -> None:
        self.titles.append(title)
        self.chat_ids.append(chat_id)
        if len(self.titles) <= self.fail_times:
            raise ChannelError(self.error_text)


@pytest.fixture
def channels(client, monkeypatch):
    """`app.state.channels` as the lifespan would set it (the TestClient has no database, so it is
    absent by default). Backoff sleeps are recorded instead of waited on."""
    wired: dict = {}
    monkeypatch.setattr(client.app.state, "channels", wired, raising=False)
    return wired


@pytest.fixture
def sleeps(monkeypatch) -> list[float]:
    recorded: list[float] = []
    monkeypatch.setattr(settings_module.time, "sleep", recorded.append)
    return recorded


def _chat_id(db_session) -> str | None:
    return db_session.execute(select(User.telegram_chat_id).where(User.email == OWNER_EMAIL)).scalar()


def _put_settings(client, settings: dict):
    return client.put("/api/desk/settings", json={"settings": settings}, headers=auth_headers(OWNER_EMAIL))


def _get_channels(client) -> list[dict]:
    response = client.get("/api/desk/settings/channels", headers=auth_headers(OWNER_EMAIL))
    assert response.status_code == 200
    return response.json()


def _link_telegram(client, chat_id: str = CHAT_ID):
    return client.put(
        "/api/desk/settings/channels/telegram", json={"chat_id": chat_id}, headers=auth_headers(OWNER_EMAIL)
    )


def _test(client, channel: str):
    return client.post(f"/api/desk/settings/channels/{channel}/test", headers=auth_headers(OWNER_EMAIL))


# --- new settings keys (a3.9) ---------------------------------------------------------------


@pytest.mark.parametrize("default_view", ["technical", "fundamental", "backtest"])
def test_default_view_accepts_the_three_modes(client, default_view):
    response = _put_settings(client, {"default_view": default_view})

    assert response.status_code == 200
    assert response.json() == {"settings": {"default_view": default_view}}


@pytest.mark.parametrize("default_view", ["chart", "Technical", "Backtest", "", None, ["technical"]])
def test_default_view_rejects_anything_else_before_persistence(client, default_view):
    response = _put_settings(client, {"default_view": default_view})

    assert response.status_code == 422
    assert response.json() == {"detail": "default_view must be technical, fundamental or backtest"}
    assert client.get("/api/desk/settings", headers=auth_headers(OWNER_EMAIL)).json() == {"settings": {}}


@pytest.mark.parametrize("pause_all", [True, False])
def test_pause_all_round_trips_a_json_boolean(client, pause_all):
    body = {"settings": {"pause_all": pause_all}}

    response = client.put("/api/desk/settings", json=body, headers=auth_headers(OWNER_EMAIL))

    assert response.status_code == 200
    assert response.json() == body


@pytest.mark.parametrize("pause_all", ["true", 1, 0, None, "false"])
def test_pause_all_rejects_a_non_boolean(client, pause_all):
    response = _put_settings(client, {"pause_all": pause_all})

    assert response.status_code == 422
    assert response.json() == {"detail": "pause_all must be true or false"}


def test_unknown_keys_are_still_kept_next_to_the_new_ones(client):
    body = {"default_view": "fundamental", "pause_all": False, "future_key": {"keep": [1, 2]}}

    assert _put_settings(client, body).status_code == 200
    assert client.get("/api/desk/settings", headers=auth_headers(OWNER_EMAIL)).json() == {"settings": body}


# --- Fundamental keys (02n §c3 #19) ---------------------------------------------------------------


def test_the_fundamental_keys_round_trip(client):
    body = {
        "mask_values": False,
        "fundamental_columns": ["fwd_pe", "cc_coverable"],
        "covered_calls": {"min_dte": 14, "max_dte": 60, "cap_pct": 25},
    }

    assert _put_settings(client, body).status_code == 200
    assert client.get("/api/desk/settings", headers=auth_headers(OWNER_EMAIL)).json() == {"settings": body}


@pytest.mark.parametrize(
    ("settings", "problems"),
    [
        ({"mask_values": "yes"}, [{"path": "mask_values", "message": "must be true or false"}]),
        ({"fundamental_columns": ["rsi"]}, [{"path": "fundamental_columns", "message": "unknown metric: rsi"}]),
        (
            {"covered_calls": {"min_dte": 50, "max_dte": 30}},
            [{"path": "covered_calls.max_dte", "message": "must not be below min_dte"}],
        ),
        (
            {"covered_calls": {"cap_pct": 0}},
            [{"path": "covered_calls.cap_pct", "message": "must be between 1 and 100"}],
        ),
    ],
)
def test_a_bad_fundamental_key_is_a_422_with_problems_and_nothing_is_stored(client, settings, problems):
    response = _put_settings(client, settings)

    assert response.status_code == 422
    assert response.json() == {"detail": {"problems": problems}}
    assert client.get("/api/desk/settings", headers=auth_headers(OWNER_EMAIL)).json() == {"settings": {}}


# --- channels (a3.8): GET shape ---------------------------------------------------------------


def test_channels_with_nothing_linked_or_wired(client):
    # The inbox row carries no `configured`, and telegram/slack carry no `locked`: the a3.8 shape.
    assert _get_channels(client) == [
        {"channel": "inbox", "connected": True, "locked": True},
        {"channel": "telegram", "connected": False, "configured": False},
        {"channel": "slack", "connected": False, "configured": False},
    ]


def test_telegram_connected_follows_the_chat_id_and_configured_follows_wiring(client, channels):
    channels["telegram"] = FakeChannel("telegram")
    _link_telegram(client)

    telegram = _get_channels(client)[1]

    assert telegram == {"channel": "telegram", "connected": True, "configured": True}


def test_slack_connected_needs_both_the_list_and_the_wired_channel(client, channels):
    _put_settings(client, {"channels": ["inbox", "slack"]})
    assert _get_channels(client)[2] == {"channel": "slack", "connected": False, "configured": False}

    channels["slack"] = FakeChannel("slack")
    assert _get_channels(client)[2] == {"channel": "slack", "connected": True, "configured": True}

    _put_settings(client, {"channels": ["inbox"]})
    assert _get_channels(client)[2] == {"channel": "slack", "connected": False, "configured": True}


# --- Telegram link (a3.8) ----------------------------------------------------------------------


@pytest.mark.parametrize("chat_id", ["42", "-7", "1" * 20])
def test_put_telegram_stores_the_chat_id_and_never_returns_it(client, channels, db_session, chat_id):
    channels["telegram"] = FakeChannel("telegram")

    response = _link_telegram(client, chat_id)

    assert response.status_code == 200
    assert response.json() == {"channel": "telegram", "connected": True, "configured": True}
    assert chat_id not in response.text
    assert _chat_id(db_session) == chat_id


@pytest.mark.parametrize(
    "chat_id",
    ["", "abc", "12.5", "+12", " 12", "12 ", "12\n", "--1", "1" * 21, "١٢"],
)
def test_put_telegram_rejects_a_non_numeric_chat_id(client, db_session, chat_id):
    response = _link_telegram(client, chat_id)

    assert response.status_code == 422
    assert _chat_id(db_session) is None


# --- test send (a3.8) --------------------------------------------------------------------------


def test_test_inbox_is_sent_without_calling_any_channel(client, channels):
    channels["telegram"] = FakeChannel("telegram")

    response = _test(client, "inbox")

    assert response.status_code == 200
    assert response.json() == {"status": "sent"}
    assert channels["telegram"].titles == []


def test_test_telegram_is_not_connected_without_a_chat_id(client, channels):
    fake = channels["telegram"] = FakeChannel("telegram")

    assert _test(client, "telegram").json() == {"status": "not_connected"}
    assert fake.titles == []


def test_test_telegram_is_not_connected_when_the_channel_is_not_wired(client, channels):
    _link_telegram(client)

    assert _test(client, "telegram").json() == {"status": "not_connected"}


def test_test_telegram_sends_the_test_message_through_the_channel(client, channels, sleeps):
    fake = channels["telegram"] = FakeChannel("telegram")
    _link_telegram(client)

    response = _test(client, "telegram")

    assert response.json() == {"status": "sent"}
    assert fake.titles == ["Test from Family Desk"]
    assert sleeps == []


def test_test_telegram_goes_to_her_linked_chat(client, channels, sleeps):
    fake = channels["telegram"] = FakeChannel("telegram")
    _link_telegram(client)

    assert _test(client, "telegram").json() == {"status": "sent"}
    assert fake.chat_ids == [CHAT_ID]


def test_test_telegram_is_not_connected_while_the_alert_runtime_is_off(client, channels, sleeps, monkeypatch):
    monkeypatch.delenv("DESK_ALERTS_RUNTIME_ENABLED", raising=False)
    fake = FakeChannel("telegram")
    channels["telegram"] = RuntimeGated(fake)
    _link_telegram(client)

    assert _test(client, "telegram").json() == {"status": "not_connected"}
    assert fake.titles == [] and sleeps == []  # nothing left, and the refusal was not retried

    monkeypatch.setenv("DESK_ALERTS_RUNTIME_ENABLED", "1")

    assert _test(client, "telegram").json() == {"status": "sent"}
    assert fake.titles == ["Test from Family Desk"]


def test_test_telegram_retries_with_the_dispatch_schedule_then_reports_sent(client, channels, sleeps):
    fake = channels["telegram"] = FakeChannel("telegram", fail_times=2)
    _link_telegram(client)

    response = _test(client, "telegram")

    assert response.json() == {"status": "sent"}
    assert len(fake.titles) == 3
    assert sleeps == list(RETRY_DELAYS_SECONDS[:2])


def test_test_telegram_reports_failed_after_every_attempt_and_never_echoes_the_error(client, channels, sleeps):
    fake = channels["telegram"] = FakeChannel(
        "telegram", fail_times=99, error_text=f"refused https://api.telegram.org/bot{SECRET_TEXT}/sendMessage"
    )
    _link_telegram(client)

    response = _test(client, "telegram")

    assert response.status_code == 200
    assert response.json() == {"status": "failed"}
    assert len(fake.titles) == len(RETRY_DELAYS_SECONDS) + 1
    assert sleeps == list(RETRY_DELAYS_SECONDS)
    assert SECRET_TEXT not in response.text


def test_test_slack_needs_the_list_and_the_wired_channel(client, channels, sleeps):
    fake = channels["slack"] = FakeChannel("slack")
    assert _test(client, "slack").json() == {"status": "not_connected"}
    assert fake.titles == []

    _put_settings(client, {"channels": ["inbox", "slack"]})

    assert _test(client, "slack").json() == {"status": "sent"}
    assert fake.titles == ["Test from Family Desk"]


def test_test_rejects_an_unknown_channel(client):
    assert _test(client, "sms").status_code == 422


# --- stub on (DESK_MVP_STUB=1): fixture answers, no channel is ever called ----------------------


def test_stub_test_answers_from_the_fixture_and_never_calls_a_channel(client, channels, monkeypatch):
    monkeypatch.setenv("DESK_MVP_STUB", "1")
    telegram = channels["telegram"] = FakeChannel("telegram")
    slack = channels["slack"] = FakeChannel("slack")
    _put_settings(client, {"channels": ["inbox", "telegram", "slack"]})

    assert _test(client, "inbox").json() == {"status": "sent"}
    assert _test(client, "telegram").json() == {"status": "not_connected"}
    assert _test(client, "slack").json() == {"status": "not_connected"}

    _link_telegram(client)

    assert _test(client, "telegram").json() == {"status": "sent"}
    assert telegram.titles == []
    assert slack.titles == []
