"""practice threads: practice_threads.name and practice_threads.shares

Revision ID: 0020
Revises: 0019
Create Date: 2026-11-01

Additive: two columns on `practice_threads`, one check constraint, and a data step for each column. Nothing is dropped
and no existing row changes meaning.

- `name` (text NOT NULL; D-069): the thread's own label, "Day thread · Oct 15" or "Swing thread · Oct 15" after the
  mode and the ET day the thread started, with " (2)", " (3)" ... on a later thread of the same owner, mode and day.
  Two threads of one mode used to share the default name "October thread"; the server now writes a distinct one when
  a thread starts (`replay/threads.thread_name`). Existing rows are named by the data step below, oldest first, in the
  same words, so no row is ever without one. Nothing renames a thread yet.
- `shares` (integer, null; D-042): the entry size a day thread's tickets open at. Null means "not set" and the day
  session's default applies. The data step lifts it from the newest plan of a day thread that still carries a legacy
  `setup.shares` (plans saved before 0007 stored it; the code never read it afterwards). Any other thread stays null,
  and the journal reads "Not set".

`downgrade()` drops the check constraint and both columns; the names and sizes go with them (the thread plan simply
shows no Shares row again, and the old default name comes back from the code).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0020"
down_revision: str | None = "0019"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# The start day is the ET calendar day (the practice calendar's own zone). The month words are spelled out, not
# `to_char(.., 'Mon')`, which follows the server's lc_time.
_START_DAY = "created_at AT TIME ZONE 'America/New_York'"
_NAME_BACKFILL = f"""
UPDATE practice_threads AS t
SET name = labelled.base || CASE WHEN labelled.n > 1 THEN ' (' || labelled.n || ')' ELSE '' END
FROM (
    SELECT id, base, ROW_NUMBER() OVER (PARTITION BY owner_user_id, base ORDER BY created_at, id) AS n
    FROM (
        SELECT id, owner_user_id, created_at,
            CASE mode WHEN 'swing' THEN 'Swing' ELSE 'Day' END || ' thread · '
            || (ARRAY['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'])[
                EXTRACT(MONTH FROM {_START_DAY})::int]
            || ' ' || EXTRACT(DAY FROM {_START_DAY})::int AS base
        FROM practice_threads
    ) AS named
) AS labelled
WHERE t.id = labelled.id
"""

# `CASE` makes the cast run only for a plain whole number of up to nine digits, so a stray value in an old spec skips
# the row instead of failing the migration.
_SHARES_BACKFILL = """
UPDATE practice_threads AS t
SET shares = legacy.shares
FROM (
    SELECT DISTINCT ON (thread_id) thread_id, shares
    FROM (
        SELECT thread_id, id,
            CASE WHEN spec #>> '{setup,shares}' ~ '^[0-9]{1,9}$' THEN (spec #>> '{setup,shares}')::int END AS shares
        FROM practice_plans
        WHERE thread_id IS NOT NULL
    ) AS parsed
    WHERE shares >= 1
    ORDER BY thread_id, id DESC
) AS legacy
WHERE t.id = legacy.thread_id AND t.mode = 'day'
"""


def upgrade() -> None:
    op.add_column("practice_threads", sa.Column("name", sa.String(), nullable=True))
    op.add_column("practice_threads", sa.Column("shares", sa.Integer(), nullable=True))
    op.execute(sa.text(_NAME_BACKFILL))
    op.alter_column("practice_threads", "name", nullable=False)
    op.execute(sa.text(_SHARES_BACKFILL))
    op.create_check_constraint("ck_practice_threads_shares", "practice_threads", "shares IS NULL OR shares >= 1")


def downgrade() -> None:
    op.drop_constraint("ck_practice_threads_shares", "practice_threads", type_="check")
    op.drop_column("practice_threads", "shares")
    op.drop_column("practice_threads", "name")
