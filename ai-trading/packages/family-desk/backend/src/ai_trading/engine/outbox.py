"""The signal outbox (PROTO-BRIEF.md section 4 L2; 02a section 5): a signal's `signals` row and
its `alerts`/`deliveries` rows land in one transaction, and the `signals` unique constraint
`(strategy_version_id, symbol, bar_time)` -- not any engine-side bookkeeping -- is what makes a
restart replaying an already-signaled bar a no-op instead of a duplicate alert (Review Focus 1).

Degraded strategies alert but place no paper orders (the global constraint): there is no
`order_intents` table in Phase 3, so this module simply never writes one. `data_quality` is still
recorded on every signal so Phase 6 can read it back and gate paper orders on it then.
"""

from dataclasses import dataclass
from datetime import datetime

from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from ai_trading.core.evaluate import SignalCandidate
from ai_trading.db.models import Alert, Delivery, Signal
from ai_trading.engine.degraded import DataQuality


@dataclass(frozen=True)
class AlertSpec:
    """From a strategy version's `spec.then.alert` block."""

    channels: list[str]  # always at least one (the schema enforces min_length=1)
    severity: str = "info"  # spec.then.alert.severity, defaulted by the caller when None


def record_signal(
    session: Session,
    *,
    strategy_version_id: int,
    owner_user_id: int,
    symbol: str,
    candidate: SignalCandidate,
    data_quality: DataQuality,
    alert: AlertSpec,
    now: datetime,
) -> bool:
    """`INSERT INTO signals ... ON CONFLICT (strategy_version_id, symbol, bar_time) DO NOTHING
    RETURNING id`. No row returned (already recorded -- a restart or catch-up re-run) -> returns
    False and writes nothing else: this IS Review Focus 1, enforced by the database, not by
    engine-side bookkeeping.

    Row inserted -> in the SAME transaction (no commit here; the caller commits once per tick),
    inserts one `alerts` row and one `deliveries` row per `alert.channels` entry (status
    defaults to "pending"). Returns True.
    """
    insert_signal = (
        pg_insert(Signal)
        .values(
            strategy_version_id=strategy_version_id,
            symbol=symbol,
            bar_time=candidate.bar_time,
            evidence=candidate.evidence,
            data_quality=data_quality,
            created_at=now,
        )
        .on_conflict_do_nothing(index_elements=["strategy_version_id", "symbol", "bar_time"])
        .returning(Signal.id)
    )
    signal_id = session.execute(insert_signal).scalar_one_or_none()
    if signal_id is None:
        return False

    title, body = _render(symbol, candidate)
    alert_row = Alert(
        user_id=owner_user_id,
        signal_id=signal_id,
        kind="signal",
        severity=alert.severity,
        title=title,
        body=body,
        created_at=now,
    )
    session.add(alert_row)
    session.flush()  # assigns alert_row.id for the deliveries below; still the same transaction
    for channel in alert.channels:
        session.add(Delivery(alert_id=alert_row.id, channel=channel))
    return True


def _render(symbol: str, candidate: SignalCandidate) -> tuple[str, str]:
    title = f"{symbol} signal at {candidate.bar_time.isoformat()}"
    evidence = ", ".join(f"{key}={value}" for key, value in candidate.evidence.items())
    body = f"{symbol} at {candidate.bar_time.isoformat()}: {evidence}" if evidence else title
    return title, body
