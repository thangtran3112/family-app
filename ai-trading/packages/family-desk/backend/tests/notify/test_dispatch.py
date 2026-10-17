from datetime import UTC, datetime

import requests

from ai_trading.db.models import Alert, Delivery, User
from ai_trading.notify.channel import ChannelError
from ai_trading.notify.dispatch import RETRY_DELAYS_SECONDS, DeliveryOutcome, dispatch_pending
from ai_trading.notify.slack import SlackChannel
from ai_trading.notify.telegram import TelegramChannel

_NOW = datetime(2026, 7, 15, 16, 0, tzinfo=UTC)  # 12:00 ET on a fixed EDT day -- outside default quiet hours


def _no_sleep(seconds: float) -> None:
    return None


class _FakeChannel:
    name = "telegram"

    def __init__(self, *, fail_times: int = 0, error: str = "boom") -> None:
        self.fail_times = fail_times
        self.error = error
        self.calls = 0

    def send(self, *, title: str, body: str, severity: str) -> None:
        self.calls += 1
        if self.calls <= self.fail_times:
            raise ChannelError(self.error)


def _make_user(db_session, *, settings: dict | None = None) -> User:
    user = User(email="owner@example.com", settings=settings or {})
    db_session.add(user)
    db_session.flush()
    return user


def _make_alert(db_session, user: User, *, severity: str = "info") -> Alert:
    alert = Alert(
        user_id=user.id,
        kind="signal",
        severity=severity,
        title="ORB breakout",
        body="AAPL crossed the opening range high",
        created_at=_NOW,
    )
    db_session.add(alert)
    db_session.flush()
    return alert


def _make_delivery(db_session, alert: Alert, *, channel: str) -> Delivery:
    delivery = Delivery(alert_id=alert.id, channel=channel)
    db_session.add(delivery)
    db_session.flush()
    return delivery


def test_dispatch_pending_sends_an_inbox_delivery_immediately(db_session):
    user = _make_user(db_session)
    alert = _make_alert(db_session, user)
    delivery = _make_delivery(db_session, alert, channel="inbox")

    outcomes = dispatch_pending(db_session, channels={}, now=_NOW)

    assert len(outcomes) == 1
    assert outcomes[0].delivery_id == delivery.id
    assert outcomes[0].status == "sent"
    assert delivery.status == "sent"
    assert delivery.attempted_at == _NOW


def test_dispatch_pending_sends_via_a_wired_channel_on_the_first_attempt(db_session):
    user = _make_user(db_session)
    alert = _make_alert(db_session, user)
    delivery = _make_delivery(db_session, alert, channel="telegram")
    channel = _FakeChannel()

    outcomes = dispatch_pending(db_session, channels={"telegram": channel}, now=_NOW)

    assert channel.calls == 1
    assert outcomes == [DeliveryOutcome(delivery.id, "sent")]
    assert delivery.status == "sent"
    assert delivery.attempted_at == _NOW


def test_absent_channel_preferences_keep_legacy_external_delivery_enabled(db_session):
    user = _make_user(db_session)
    alert = _make_alert(db_session, user)
    delivery = _make_delivery(db_session, alert, channel="telegram")
    channel = _FakeChannel()

    outcomes = dispatch_pending(db_session, channels={"telegram": channel}, now=_NOW)

    assert outcomes == [DeliveryOutcome(delivery.id, "sent")]
    assert channel.calls == 1
    assert delivery.status == "sent"


def test_explicitly_disabled_external_channel_stays_pending_while_inbox_sends(db_session):
    user = _make_user(db_session, settings={"channels": []})
    alert = _make_alert(db_session, user)
    inbox = _make_delivery(db_session, alert, channel="inbox")
    telegram = _make_delivery(db_session, alert, channel="telegram")
    channel = _FakeChannel()

    outcomes = dispatch_pending(db_session, channels={"telegram": channel}, now=_NOW)

    assert {outcome.delivery_id: outcome.status for outcome in outcomes} == {
        inbox.id: "sent",
        telegram.id: "skipped_preferences",
    }
    assert channel.calls == 0
    assert inbox.status == "sent"
    assert inbox.attempted_at == _NOW
    assert telegram.status == "pending"
    assert telegram.attempted_at is None


def test_reenabled_external_channel_delivers_its_pending_row(db_session):
    user = _make_user(db_session, settings={"channels": []})
    alert = _make_alert(db_session, user)
    delivery = _make_delivery(db_session, alert, channel="telegram")
    channel = _FakeChannel()

    skipped = dispatch_pending(db_session, channels={"telegram": channel}, now=_NOW)
    user.settings = {"channels": ["telegram"]}
    delivered = dispatch_pending(db_session, channels={"telegram": channel}, now=_NOW)

    assert skipped == [DeliveryOutcome(delivery.id, "skipped_preferences")]
    assert delivered == [DeliveryOutcome(delivery.id, "sent")]
    assert channel.calls == 1
    assert delivery.status == "sent"
    assert delivery.attempted_at == _NOW


def test_malformed_legacy_preferences_fail_closed_without_blocking_other_users(db_session):
    malformed_user = _make_user(db_session, settings={"quiet_hours": {"start": "25:00", "end": "07:00"}})
    malformed_alert = _make_alert(db_session, malformed_user)
    inbox = _make_delivery(db_session, malformed_alert, channel="inbox")
    deferred = _make_delivery(db_session, malformed_alert, channel="telegram")

    normal_user = User(email="other-test-user", settings={})
    db_session.add(normal_user)
    db_session.flush()
    normal_alert = _make_alert(db_session, normal_user)
    normal_delivery = _make_delivery(db_session, normal_alert, channel="telegram")
    channel = _FakeChannel()

    outcomes = dispatch_pending(db_session, channels={"telegram": channel}, now=_NOW)

    assert {outcome.delivery_id: outcome.status for outcome in outcomes} == {
        inbox.id: "sent",
        deferred.id: "skipped_preferences",
        normal_delivery.id: "sent",
    }
    assert channel.calls == 1
    assert inbox.status == "sent"
    assert deferred.status == "pending"
    assert deferred.attempted_at is None
    assert normal_delivery.status == "sent"


def test_malformed_legacy_channel_preferences_fail_closed_for_external_only(db_session):
    user = _make_user(db_session, settings={"channels": ["telegram", "unknown"]})
    alert = _make_alert(db_session, user)
    inbox = _make_delivery(db_session, alert, channel="inbox")
    telegram = _make_delivery(db_session, alert, channel="telegram")
    channel = _FakeChannel()

    outcomes = dispatch_pending(db_session, channels={"telegram": channel}, now=_NOW)

    assert {outcome.delivery_id: outcome.status for outcome in outcomes} == {
        inbox.id: "sent",
        telegram.id: "skipped_preferences",
    }
    assert channel.calls == 0
    assert inbox.status == "sent"
    assert telegram.status == "pending"
    assert telegram.attempted_at is None


def test_dispatch_pending_retries_then_succeeds(db_session):
    user = _make_user(db_session)
    alert = _make_alert(db_session, user)
    delivery = _make_delivery(db_session, alert, channel="telegram")
    channel = _FakeChannel(fail_times=2)
    sleeps = []

    outcomes = dispatch_pending(db_session, channels={"telegram": channel}, now=_NOW, sleep=sleeps.append)

    assert channel.calls == 3
    assert sleeps == [RETRY_DELAYS_SECONDS[0], RETRY_DELAYS_SECONDS[1]]
    assert outcomes[0].status == "sent"
    assert delivery.status == "sent"


def test_dispatch_pending_exhausts_retries_and_marks_failed(db_session):
    user = _make_user(db_session)
    alert = _make_alert(db_session, user)
    delivery = _make_delivery(db_session, alert, channel="telegram")
    channel = _FakeChannel(fail_times=99, error="telegram responded 500: internal error")
    sleeps = []

    outcomes = dispatch_pending(db_session, channels={"telegram": channel}, now=_NOW, sleep=sleeps.append)

    assert channel.calls == len(RETRY_DELAYS_SECONDS) + 1
    assert sleeps == list(RETRY_DELAYS_SECONDS)
    assert outcomes[0].status == "failed"
    assert delivery.status == "failed"
    assert delivery.attempted_at == _NOW
    assert delivery.error == "telegram responded 500: internal error"


def test_dispatch_pending_skips_a_channel_delivery_during_quiet_hours_leaving_it_pending(db_session):
    user = _make_user(db_session, settings={"quiet_hours": {"start": "00:00", "end": "23:59"}})
    alert = _make_alert(db_session, user, severity="info")
    delivery = _make_delivery(db_session, alert, channel="telegram")
    channel = _FakeChannel()

    outcomes = dispatch_pending(db_session, channels={"telegram": channel}, now=_NOW)

    assert channel.calls == 0
    assert outcomes == [DeliveryOutcome(delivery.id, "skipped_quiet_hours")]
    assert delivery.status == "pending"
    assert delivery.attempted_at is None


def test_dispatch_pending_still_sends_a_system_alert_during_quiet_hours(db_session):
    user = _make_user(db_session, settings={"quiet_hours": {"start": "00:00", "end": "23:59"}})
    alert = _make_alert(db_session, user, severity="system")
    delivery = _make_delivery(db_session, alert, channel="telegram")
    channel = _FakeChannel()

    outcomes = dispatch_pending(db_session, channels={"telegram": channel}, now=_NOW)

    assert channel.calls == 1
    assert outcomes[0].status == "sent"
    assert delivery.status == "sent"


def test_equal_quiet_hours_bounds_mean_no_quiet_period(db_session):
    user = _make_user(db_session, settings={"quiet_hours": {"start": "22:00", "end": "22:00"}})
    alert = _make_alert(db_session, user)
    delivery = _make_delivery(db_session, alert, channel="telegram")
    channel = _FakeChannel()

    outcomes = dispatch_pending(db_session, channels={"telegram": channel}, now=_NOW)

    assert outcomes == [DeliveryOutcome(delivery.id, "sent")]
    assert channel.calls == 1


def test_dispatch_pending_leaves_an_unwired_channel_delivery_pending_forever(db_session):
    user = _make_user(db_session)
    alert = _make_alert(db_session, user)
    delivery = _make_delivery(db_session, alert, channel="slack")

    outcomes = dispatch_pending(db_session, channels={}, now=_NOW)  # neither telegram nor slack wired (D-a)

    assert outcomes == []
    assert delivery.status == "pending"
    assert delivery.attempted_at is None


def test_dispatch_pending_is_a_no_op_on_a_second_call_for_already_handled_rows(db_session):
    user = _make_user(db_session)
    alert = _make_alert(db_session, user)
    _make_delivery(db_session, alert, channel="inbox")

    dispatch_pending(db_session, channels={}, now=_NOW)
    second = dispatch_pending(db_session, channels={}, now=_NOW)

    assert second == []


def test_dispatch_pending_updates_several_rows_independently(db_session):
    user = _make_user(db_session)
    alert = _make_alert(db_session, user)
    inbox_delivery = _make_delivery(db_session, alert, channel="inbox")
    telegram_delivery = _make_delivery(db_session, alert, channel="telegram")
    channel = _FakeChannel()

    outcomes = dispatch_pending(db_session, channels={"telegram": channel}, now=_NOW)

    by_id = {outcome.delivery_id: outcome.status for outcome in outcomes}
    assert by_id == {inbox_delivery.id: "sent", telegram_delivery.id: "sent"}


def test_delivery_error_text_never_contains_the_bot_token_or_webhook_url(db_session):
    """Review Focus 5: a fake `requests` connection error whose own `str()` embeds a real-looking
    webhook URL with a credential-shaped path segment must never leak into `ChannelError.__str__`
    or the `deliveries.error` column written from it.
    """
    bot_token = "123456789:AAFakeBotTokenValueNotReal0000"
    chat_id = "-100999"
    webhook_url = "https://example.test/webhook/FAKE-SECRET-3"

    def telegram_post(url: str, payload: dict):
        raise requests.exceptions.ConnectionError(
            f"HTTPSConnectionPool(host='api.telegram.org', port=443): Max retries exceeded with "
            f"url: /bot{bot_token}/sendMessage (Caused by NewConnectionError(...))"
        )

    def slack_post(url: str, payload: dict):
        raise requests.exceptions.ConnectionError(
            f"HTTPSConnectionPool(host='hooks.slack.com', port=443): Max retries exceeded with url: {webhook_url}"
        )

    user = _make_user(db_session)
    telegram_alert = _make_alert(db_session, user)
    telegram_delivery = _make_delivery(db_session, telegram_alert, channel="telegram")
    slack_alert = _make_alert(db_session, user)
    slack_delivery = _make_delivery(db_session, slack_alert, channel="slack")

    channels = {
        "telegram": TelegramChannel(bot_token, chat_id, post=telegram_post),
        "slack": SlackChannel(webhook_url, post=slack_post),
    }

    dispatch_pending(db_session, channels=channels, now=_NOW, sleep=_no_sleep)

    assert telegram_delivery.status == "failed"
    assert bot_token not in telegram_delivery.error
    assert f"/bot{bot_token}/" not in telegram_delivery.error

    assert slack_delivery.status == "failed"
    assert webhook_url not in slack_delivery.error
