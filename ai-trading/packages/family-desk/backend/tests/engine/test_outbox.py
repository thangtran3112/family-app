"""`engine.outbox.record_signal` (PROTO-BRIEF.md section 4 L2): the dedupe key lives in the
`signals` unique constraint, not in this module -- the restart/catch-up test with this exact
behavior end to end is `tests/engine/test_tick.py`'s Review Focus 1."""

import pandas as pd
from sqlalchemy import select
from sqlalchemy.orm import Session
from strategies import NOW, make_spec, make_strategy, make_user

from ai_trading.core.evaluate import SignalCandidate
from ai_trading.db import models
from ai_trading.db.models import Alert, Delivery, Signal
from ai_trading.engine.outbox import AlertSpec, record_signal

BAR_TIME = pd.Timestamp("2026-10-12T14:30:00", tz="UTC")
WHEN = {"op": "gt", "left": {"series": "close"}, "right": {"value": 100.0}}


def _candidate(bar_time: pd.Timestamp = BAR_TIME, **evidence: float) -> SignalCandidate:
    return SignalCandidate(symbol="AAPL", bar_time=bar_time, evidence=evidence or {"close": 101.5})


def _setup(db_session: Session) -> tuple[int, int]:
    user_id = make_user(db_session)
    _, version_id = make_strategy(db_session, user_id, make_spec(when=WHEN))
    db_session.commit()
    return user_id, version_id


def test_first_insert_writes_a_signal_an_alert_and_a_pending_delivery(db_session: Session):
    user_id, version_id = _setup(db_session)
    wrote = record_signal(
        db_session,
        strategy_version_id=version_id,
        owner_user_id=user_id,
        symbol="AAPL",
        candidate=_candidate(),
        data_quality="delayed-15m",
        alert=AlertSpec(channels=["inbox"], severity="info"),
        now=NOW,
    )
    db_session.commit()

    assert wrote is True
    signal = db_session.execute(select(Signal)).scalar_one()
    assert signal.symbol == "AAPL"
    assert signal.data_quality == "delayed-15m"
    assert signal.evidence == {"close": 101.5}
    alert = db_session.execute(select(Alert)).scalar_one()
    assert alert.signal_id == signal.id
    assert alert.user_id == user_id
    assert alert.kind == "signal"
    assert alert.severity == "info"
    delivery = db_session.execute(select(Delivery)).scalar_one()
    assert delivery.alert_id == alert.id
    assert delivery.channel == "inbox"
    assert delivery.status == "pending"


def test_second_insert_of_the_same_key_writes_nothing_and_returns_false(db_session: Session):
    user_id, version_id = _setup(db_session)
    alert_spec = AlertSpec(channels=["inbox"])
    first = record_signal(
        db_session,
        strategy_version_id=version_id,
        owner_user_id=user_id,
        symbol="AAPL",
        candidate=_candidate(),
        data_quality="delayed-15m",
        alert=alert_spec,
        now=NOW,
    )
    db_session.commit()
    second = record_signal(
        db_session,
        strategy_version_id=version_id,
        owner_user_id=user_id,
        symbol="AAPL",
        candidate=_candidate(close=999.0),  # different evidence, same dedupe key: still a no-op
        data_quality="delayed-15m",
        alert=alert_spec,
        now=NOW,
    )
    db_session.commit()

    assert first is True
    assert second is False
    assert len(db_session.execute(select(Signal)).scalars().all()) == 1
    assert len(db_session.execute(select(Alert)).scalars().all()) == 1
    assert len(db_session.execute(select(Delivery)).scalars().all()) == 1


def test_a_different_bar_time_is_a_different_dedupe_key(db_session: Session):
    user_id, version_id = _setup(db_session)
    alert_spec = AlertSpec(channels=["inbox"])
    for bar_time in (BAR_TIME, BAR_TIME + pd.Timedelta(minutes=1)):
        wrote = record_signal(
            db_session,
            strategy_version_id=version_id,
            owner_user_id=user_id,
            symbol="AAPL",
            candidate=_candidate(bar_time=bar_time),
            data_quality="delayed-15m",
            alert=alert_spec,
            now=NOW,
        )
        assert wrote is True
    db_session.commit()
    assert len(db_session.execute(select(Signal)).scalars().all()) == 2


def test_multiple_channels_each_get_their_own_pending_delivery_row(db_session: Session):
    user_id, version_id = _setup(db_session)
    record_signal(
        db_session,
        strategy_version_id=version_id,
        owner_user_id=user_id,
        symbol="AAPL",
        candidate=_candidate(),
        data_quality="eod",
        alert=AlertSpec(channels=["inbox", "telegram", "slack"], severity="risk"),
        now=NOW,
    )
    db_session.commit()

    deliveries = db_session.execute(select(Delivery)).scalars().all()
    assert sorted(d.channel for d in deliveries) == ["inbox", "slack", "telegram"]
    assert all(d.status == "pending" for d in deliveries)


def test_no_order_intents_table_exists_for_a_paper_order_spec():
    # Phase 3 ships no order_intents/fills code at all (Phase 6 scope). record_signal never takes
    # a paperOrder block in the first place -- a spec naming one simply has nowhere to write it.
    assert "order_intents" not in models.Base.metadata.tables
    assert not hasattr(models, "OrderIntent")
