"""indexes for the alert inbox, the delivery log and the signal reads

Revision ID: 0015
Revises: 0014
Create Date: 2026-11-01

Additive: five plain b-tree indexes, no column, constraint or row changes. Each backs a filter the code already
runs and that today has no index to use (the unique constraint on `signals` leads with `strategy_version_id`, and a
Postgres foreign key does not index its referencing column):

- `ix_alerts_user_id_created_at` (`user_id, created_at DESC, id DESC`): the inbox (`GET /alerts`), the delivery log
  (`GET /alerts/log`), `POST /alerts/read-all` and the unread badge in `/status` all filter `alerts.user_id`, and the
  inbox and log page by `created_at DESC, id DESC` -- the index serves the filter and the ordering, so a page is a
  short index walk instead of a scan and sort of every alert.
- `ix_alerts_signal_id`: `alerts/service.py` `fires` finds an alert's deliveries by `alerts.signal_id`.
- `ix_deliveries_alert_id`: every delivery read joins `deliveries.alert_id` to `alerts` (the log, `fires`, the
  dispatch pass every few seconds), and deleting an alert cascades to its deliveries through this column.
- `ix_signals_symbol_bar_time` (`symbol, bar_time`): the chart markers, the watchlist tags, the runtime's per-symbol
  history and `GET /signals?symbol=` filter by symbol and a bar-time range.
- `ix_signals_bar_time`: the dashboard's "since" window filters `bar_time >= ...` and orders by it, with no symbol.

`downgrade()` drops the five indexes.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0015"
down_revision: str | None = "0014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_index(
        "ix_alerts_user_id_created_at", "alerts", ["user_id", sa.text("created_at DESC"), sa.text("id DESC")]
    )
    op.create_index("ix_alerts_signal_id", "alerts", ["signal_id"])
    op.create_index("ix_deliveries_alert_id", "deliveries", ["alert_id"])
    op.create_index("ix_signals_symbol_bar_time", "signals", ["symbol", "bar_time"])
    op.create_index("ix_signals_bar_time", "signals", ["bar_time"])


def downgrade() -> None:
    op.drop_index("ix_signals_bar_time", table_name="signals")
    op.drop_index("ix_signals_symbol_bar_time", table_name="signals")
    op.drop_index("ix_deliveries_alert_id", table_name="deliveries")
    op.drop_index("ix_alerts_signal_id", table_name="alerts")
    op.drop_index("ix_alerts_user_id_created_at", table_name="alerts")
