"""Telegram delivery end to end against a FAKE Telegram HTTP server (a local `http.server`; the real
`requests` call runs, only `api.telegram.org` is swapped for it). The token comes from the env the deploy
renders out of Firestore `family-config`, never from a file; the chat comes from the user's linked chat id.
Everything here uses the placeholder token below, which is not a real bot."""

import json
import socket
import threading
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from ai_trading.api.app import _build_channels
from ai_trading.db.models import Alert, Delivery, User
from ai_trading.notify.channel import ChannelError, ChannelNotConnected
from ai_trading.notify.dispatch import RETRY_DELAYS_SECONDS, dispatch_pending

_TOKEN = "123456789:TEST-ONLY-NOT-A-REAL-TOKEN"  # TEST placeholder
_ENV = {"TELEGRAM_BOT_TOKEN": _TOKEN}
_FLAG = "DESK_ALERTS_RUNTIME_ENABLED"
_NOW = datetime(2026, 7, 15, 16, 0, tzinfo=UTC)  # 12:00 ET: outside the default quiet hours
_TEXT = "[OPPORTUNITY] NVDA: ORB 15m\n\nNVDA 120.50 10:15 AM"


class FakeTelegram:
    """Records every request; answers from `script` (status, json) in order, then 200 ok."""

    def __init__(self) -> None:
        self.requests: list[tuple[str, str, dict]] = []  # (path, content type, json body)
        self.script: list[tuple[int, dict]] = []
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                fake.requests.append((self.path, self.headers["Content-Type"], body))
                status, payload = fake.script.pop(0) if fake.script else (200, {"ok": True, "result": {}})
                raw = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def log_message(self, *args: object) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def telegram(monkeypatch: pytest.MonkeyPatch):
    fake = FakeTelegram()
    monkeypatch.setenv("NO_PROXY", "127.0.0.1")
    monkeypatch.setattr("ai_trading.notify.telegram._API_BASE", fake.url)
    monkeypatch.delenv(_FLAG, raising=False)
    yield fake
    fake.close()


@pytest.fixture
def runtime_on(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(_FLAG, "1")


def _send(channel, **kwargs) -> None:
    channel.send(title="NVDA: ORB 15m", body="NVDA 120.50 10:15 AM", severity="opportunity", **kwargs)


# --- the sender: token from settings storage, message shape, failure states -----------------------------------


def test_the_token_alone_wires_telegram_and_no_token_wires_nothing():
    assert set(_build_channels(_ENV)) == {"telegram"}  # her chat is the one she links, so no chat id is needed here
    assert _build_channels({}) == {}
    assert _build_channels({"TELEGRAM_CHAT_ID": "42"}) == {}  # a chat without a bot token is not a connected bot


def test_a_send_posts_the_inbox_message_as_json_to_the_bot_api(telegram, runtime_on):
    _send(_build_channels(_ENV)["telegram"], chat_id="555")

    [(path, content_type, body)] = telegram.requests
    assert path == f"/bot{_TOKEN}/sendMessage"
    assert content_type == "application/json"
    assert body == {"chat_id": "555", "text": _TEXT}


def test_a_message_over_the_telegram_limit_is_cut_instead_of_refused(telegram, runtime_on):
    channel = _build_channels(_ENV)["telegram"]

    channel.send(title="t", body="x" * 5000, severity="info", chat_id="555")

    assert len(telegram.requests[0][2]["text"]) == 4096


def test_the_fallback_chat_is_used_when_no_chat_is_given(telegram, runtime_on):
    _send(_build_channels({**_ENV, "TELEGRAM_CHAT_ID": "-100777"})["telegram"])

    assert telegram.requests[0][2]["chat_id"] == "-100777"


def test_nothing_is_sent_while_the_alert_runtime_is_off(telegram):
    channel = _build_channels(_ENV)["telegram"]

    with pytest.raises(ChannelNotConnected):
        _send(channel, chat_id="555")

    assert telegram.requests == []


def test_nothing_is_sent_without_a_linked_chat(telegram, runtime_on):
    channel = _build_channels(_ENV)["telegram"]

    with pytest.raises(ChannelNotConnected):
        _send(channel)

    assert telegram.requests == []


@pytest.mark.parametrize(
    ("status", "description"),
    [
        (400, "Bad Request: chat not found"),
        (401, "Unauthorized"),
        (403, "Forbidden: bot was blocked by the user"),
        (429, "Too Many Requests: retry after 3"),
        (500, "Internal Server Error"),
    ],
)
def test_an_error_answer_fails_the_send_without_leaking_the_token(telegram, runtime_on, status, description):
    telegram.script = [(status, {"ok": False, "error_code": status, "description": f"{description} /bot{_TOKEN}/x"})]

    with pytest.raises(ChannelError) as raised:
        _send(_build_channels(_ENV)["telegram"], chat_id="555")

    assert str(status) in str(raised.value)
    assert not isinstance(raised.value, ChannelNotConnected)
    assert _TOKEN not in str(raised.value)


def test_an_unreachable_server_fails_the_send_without_leaking_the_token(monkeypatch, runtime_on):
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]  # nothing listens here once the socket is closed
    monkeypatch.setenv("NO_PROXY", "127.0.0.1")
    monkeypatch.setattr("ai_trading.notify.telegram._API_BASE", f"http://127.0.0.1:{port}")

    with pytest.raises(ChannelError) as raised:
        _send(_build_channels(_ENV)["telegram"], chat_id="555")

    assert _TOKEN not in str(raised.value)


# --- delivery: inbox first, Telegram after, Telegram's trouble recorded on its own row ---------------------------


def _alert_with(db_session, *, chat_id: str | None = "555", channels=("inbox", "telegram")):
    user = User(email="owner@example.com", settings={}, telegram_chat_id=chat_id)
    db_session.add(user)
    db_session.flush()
    alert = Alert(
        user_id=user.id,
        kind="signal",
        severity="opportunity",
        title="NVDA: ORB 15m",
        body="NVDA 120.50 10:15 AM",
        created_at=_NOW,
    )
    db_session.add(alert)
    db_session.flush()
    rows = {name: Delivery(alert_id=alert.id, channel=name) for name in channels}
    db_session.add_all(rows.values())
    db_session.flush()
    return rows


def _dispatch(db_session, channels, sleeps=None):
    return dispatch_pending(
        db_session, channels=channels, now=_NOW, sleep=(sleeps if sleeps is not None else []).append
    )


def test_an_alert_reaches_the_inbox_and_her_linked_telegram_chat(db_session, telegram, runtime_on):
    rows = _alert_with(db_session)

    _dispatch(db_session, _build_channels(_ENV))

    assert (rows["inbox"].status, rows["telegram"].status) == ("sent", "sent")
    [(_, _, body)] = telegram.requests
    assert body == {"chat_id": "555", "text": _TEXT}


def test_a_telegram_failure_is_recorded_after_the_backoff_and_the_inbox_is_unaffected(db_session, telegram, runtime_on):
    rows = _alert_with(db_session)
    telegram.script = [(500, {"ok": False, "description": f"down /bot{_TOKEN}/sendMessage"})] * 4
    sleeps: list[float] = []

    _dispatch(db_session, _build_channels(_ENV), sleeps)

    assert rows["inbox"].status == "sent"
    assert rows["telegram"].status == "failed"
    assert len(telegram.requests) == len(RETRY_DELAYS_SECONDS) + 1
    assert sleeps == list(RETRY_DELAYS_SECONDS)
    assert "500" in rows["telegram"].error
    assert _TOKEN not in rows["telegram"].error


def test_a_telegram_failure_that_clears_on_retry_ends_sent(db_session, telegram, runtime_on):
    rows = _alert_with(db_session)
    telegram.script = [(429, {"ok": False}), (500, {"ok": False})]
    sleeps: list[float] = []

    _dispatch(db_session, _build_channels(_ENV), sleeps)

    assert rows["telegram"].status == "sent"
    assert len(telegram.requests) == 3
    assert sleeps == list(RETRY_DELAYS_SECONDS[:2])


def test_a_failed_telegram_row_is_not_sent_again_on_a_later_pass(db_session, telegram, runtime_on):
    rows = _alert_with(db_session)
    telegram.script = [(500, {"ok": False})] * 4
    _dispatch(db_session, _build_channels(_ENV))

    _dispatch(db_session, _build_channels(_ENV))

    assert rows["telegram"].status == "failed"
    assert len(telegram.requests) == 4


def test_nothing_leaves_while_the_alert_runtime_is_off_but_the_inbox_still_delivers(db_session, telegram):
    rows = _alert_with(db_session)
    sleeps: list[float] = []

    _dispatch(db_session, _build_channels(_ENV), sleeps)

    assert (rows["inbox"].status, rows["telegram"].status) == ("sent", "no_channel")
    assert telegram.requests == [] and sleeps == []


def test_nothing_leaves_when_no_bot_is_connected(db_session, telegram, runtime_on):
    rows = _alert_with(db_session)

    _dispatch(db_session, _build_channels({}))

    assert (rows["inbox"].status, rows["telegram"].status) == ("sent", "no_channel")
    assert telegram.requests == []


def test_nothing_leaves_for_a_user_who_has_not_linked_a_chat(db_session, telegram, runtime_on):
    rows = _alert_with(db_session, chat_id=None)
    sleeps: list[float] = []

    _dispatch(db_session, _build_channels(_ENV), sleeps)

    assert (rows["inbox"].status, rows["telegram"].status) == ("sent", "no_channel")
    assert telegram.requests == [] and sleeps == []  # not retried: retrying cannot link a chat


def test_a_broken_channel_still_leaves_the_inbox_sent_and_fails_only_its_own_row(db_session):
    class Broken:
        name = "telegram"

        def send(self, **_: str) -> None:
            raise RuntimeError("bug in the sender")

    rows = _alert_with(db_session)

    _dispatch(db_session, {"telegram": Broken()})

    assert (rows["inbox"].status, rows["telegram"].status) == ("sent", "failed")
