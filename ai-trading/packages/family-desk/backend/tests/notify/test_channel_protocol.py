from ai_trading.notify.channel import Channel
from ai_trading.notify.slack import SlackChannel
from ai_trading.notify.telegram import TelegramChannel


class _OkResponse:
    status_code = 200
    text = "ok"


def _ok_post(url: str, payload: dict) -> _OkResponse:
    return _OkResponse()


def test_telegram_channel_satisfies_the_channel_protocol():
    channel = TelegramChannel("123456789:fake-bot-token", "chat-1", post=_ok_post)
    assert isinstance(channel, Channel)
    assert channel.name == "telegram"
    channel.send(title="t", body="b", severity="info")  # must not raise


def test_slack_channel_satisfies_the_channel_protocol():
    channel = SlackChannel("https://example.test/webhook/FAKE-SECRET-2", post=_ok_post)
    assert isinstance(channel, Channel)
    assert channel.name == "slack"
    channel.send(title="t", body="b", severity="info")  # must not raise


def test_a_bare_object_with_name_and_send_satisfies_the_protocol():
    class Custom:
        name = "custom"

        def send(self, *, title: str, body: str, severity: str) -> None:
            pass

    assert isinstance(Custom(), Channel)


def test_an_object_missing_send_does_not_satisfy_the_protocol():
    class NotAChannel:
        name = "nope"

    assert not isinstance(NotAChannel(), Channel)
