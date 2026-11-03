"""freestyle thread, expand step: the thread clock, lane and Screen keys, `split` marks, order lifetime keys

Revision ID: 0021
Revises: 0020
Create Date: 2026-11-02

Additive (ADR-0025, step 2 of the freestyle redesign): the schema the freestyle thread needs, plus the data step that
moves a day thread's clock and open day onto it. NO route or handler reads any of it yet, and the old code keeps
working unchanged against it. The contract step (`0022`: drop swing, `mode`, the day-only columns) comes later.

Schema:

- `practice_threads`: `start_at`, `clock_at` (timestamptz, null), `clock_running` (boolean NOT NULL, false),
  `clock_speed` (smallint NOT NULL, 1; 1, 2, 5 or 10), `clock_anchor_at` (timestamptz, null), `clock_pause` (jsonb,
  null: `{"kind": "horizon"}` only). The thread's time `T` is `clock_at`, settled lazily like the day-list clock of
  0019, which moves here. `ck_practice_threads_mode` also allows `'freestyle'`.
- `replay_sessions`: a thread's book for one name is ONE row for the life of the thread (a lane), so a new unique
  index allows one active row per thread and symbol. The existing one (one active row per owner, symbol and DAY) and
  `attempt`'s stay as they are, see below.
- `practice_marks`: `ck_practice_marks_kind` also allows `'split'` (a corporate-action mark, written by the code that
  lands with the clock; nothing writes one yet).
- `replay_day_lists`: `thread_id` (nullable FK, cascade) with a unique constraint, so the row IS the thread's Screen.
  Rows keep it null (legacy history) unless the data step below names them.
- Working orders are JSON on the session row. Every order gets `tif` (`gtc` | `day`), `expires_at` and `reduce_only`.

Data step, for every day thread (`mode = 'day'`), in this one transaction:

1. Every running day-list clock is paused where it last settled (`clock_running` false, anchor null). A running clock
   must not cross an open while old and new code overlap in a rolling deploy: the old `roll` would end the day and
   flatten what is held. It stops at the last time anyone read it, so no time is skipped back and none is revealed.
2. The thread's `clock_at` and `clock_speed` copy the open day's `revealed_through` and `clock_speed`; with no open day
   (or one that never started its clock), the last ended day's; with neither, the plan's first day at
   `setup.window.from` ET. `start_at` is that first-day start of the thread's first plan, never later than `clock_at`.
3. The open day's active sessions already are `(thread, symbol)`-unique, so they simply become lanes: their marks,
   orders and stop lines are untouched and their open positions carry.
4. The open day's list row becomes the thread's Screen (`thread_id` set). A thread with no open day gets one on its
   first re-scan, later.
5. Ended days, their sessions and reviews stay as they are, read-only history. The ledger is not touched, so every
   thread's balance is exactly what it was; the migration test checks balance and equity at `clock_at`.
6. Orders get `tif = 'day'`, `expires_at` = 20:00 ET of the session's day and `reduce_only = false`: their old lifetime.
   (20:00 ET is the extended close; an early-close day's 17:00 is not special-cased. Only a working order of a day that
   is still open when this runs reads it.) An order that already carries a key keeps its value.

Left to the revision that lands the code which depends on them, because the code of THIS revision still branches on
`practice_threads.mode` (`'day'` lists, clocks and caps a thread; `'swing'` selects the hold model), validates every
stored `practice_plans.spec` as a v1 block, and refuses a second thread of one owner the same name on the same day
(`session._active_for`, backed by the one-active-row-per-owner-symbol-day index, whose lost race it turns into a 409):

- backfilling `mode = 'freestyle'` and rewriting each `spec` to `practice-setup-v2` would hide every existing day
  thread and strip every swing thread of its holds;
- narrowing the owner-symbol-day index to standalone rows (`thread_id IS NULL`) would open that race and leave the
  database allowing what the code still forbids. It narrows when two threads may hold one name.

Pre-flight for the new `(thread_id, symbol)` index, which fails the upgrade (and rolls it back) on a duplicate:
`SELECT thread_id, symbol, count(*) FROM replay_sessions WHERE status = 'active' AND thread_id IS NOT NULL GROUP BY 1, 2
HAVING count(*) > 1`. A day ends every session of its list and a thread has one open day, so there should be none.

`downgrade()` drops everything the schema step adds and strips the three order keys again, so an up/down round trip
restores the JSON it found. It cannot un-pause a clock. It refuses (a check constraint, loud) when a `'freestyle'`
thread or a `'split'` mark exists, since the older constraints cannot hold them.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0021"
down_revision: str | None = "0020"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_ET = "America/New_York"

# 1. Pause every running clock where it last settled.
_PAUSE_CLOCKS = """
UPDATE replay_day_lists SET clock_running = false, clock_anchor_at = NULL WHERE clock_running
"""

# 2. The thread's clock and start. `window.from` is a validated HH:MM in every stored v1 spec; the guard keeps one stray
# value from failing the migration (the plan's own default start is 09:30).
_COPY_CLOCKS = f"""
WITH open_day AS (
    SELECT DISTINCT ON (p.thread_id) p.thread_id, d.revealed_through, d.clock_speed
    FROM replay_day_lists d JOIN practice_plans p ON p.id = d.plan_id
    WHERE p.thread_id IS NOT NULL AND d.status <> 'ended'
    ORDER BY p.thread_id, d.day DESC, d.id DESC
), last_ended AS (
    SELECT DISTINCT ON (p.thread_id) p.thread_id, d.revealed_through, d.clock_speed
    FROM replay_day_lists d JOIN practice_plans p ON p.id = d.plan_id
    WHERE p.thread_id IS NOT NULL AND d.status = 'ended' AND d.revealed_through IS NOT NULL
    ORDER BY p.thread_id, d.day DESC, d.id DESC
), first_plan AS (
    SELECT DISTINCT ON (thread_id) thread_id,
        (first_day + CASE WHEN spec #>> '{{setup,window,from}}' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
                          THEN (spec #>> '{{setup,window,from}}')::time ELSE TIME '09:30' END)
            AT TIME ZONE '{_ET}' AS day_start
    FROM practice_plans
    WHERE thread_id IS NOT NULL
    ORDER BY thread_id, id
), picked AS (
    SELECT f.thread_id, f.day_start,
        COALESCE(o.revealed_through, e.revealed_through, f.day_start) AS clock_at,
        CASE WHEN o.revealed_through IS NOT NULL THEN o.clock_speed
             WHEN e.revealed_through IS NOT NULL THEN e.clock_speed ELSE 1 END AS clock_speed
    FROM first_plan f
    LEFT JOIN open_day o ON o.thread_id = f.thread_id
    LEFT JOIN last_ended e ON e.thread_id = f.thread_id
)
UPDATE practice_threads t
SET clock_at = picked.clock_at, clock_speed = picked.clock_speed, start_at = LEAST(picked.day_start, picked.clock_at)
FROM picked
WHERE t.id = picked.thread_id AND t.mode = 'day'
"""

# 4. The open day's list row is the Screen.
_NAME_THE_SCREEN = """
UPDATE replay_day_lists AS d
SET thread_id = open_day.thread_id
FROM (
    SELECT DISTINCT ON (p.thread_id) p.thread_id, l.id
    FROM replay_day_lists l
    JOIN practice_plans p ON p.id = l.plan_id
    JOIN practice_threads t ON t.id = p.thread_id AND t.mode = 'day'
    WHERE l.status <> 'ended'
    ORDER BY p.thread_id, l.day DESC, l.id DESC
) AS open_day
WHERE d.id = open_day.id
"""

# 6. The three order keys, existing values winning (`defaults || order`). `expires_at` is written the way the session
# writes its instants (`Timestamp.isoformat()` of a UTC time).
_ORDER_KEYS = f"""
UPDATE replay_sessions AS s
SET orders = (
    SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
            'tif', 'day',
            'expires_at', to_char((s.day + TIME '20:00') AT TIME ZONE '{_ET}' AT TIME ZONE 'UTC',
                                  'YYYY-MM-DD"T"HH24:MI:SS') || '+00:00',
            'reduce_only', false
        ) || o ORDER BY ord
    ), '[]'::jsonb)
    FROM jsonb_array_elements(s.orders) WITH ORDINALITY AS e(o, ord)
)
WHERE jsonb_typeof(s.orders) = 'array' AND jsonb_array_length(s.orders) > 0
"""

_STRIP_ORDER_KEYS = """
UPDATE replay_sessions AS s
SET orders = (
    SELECT COALESCE(jsonb_agg(o - 'tif' - 'expires_at' - 'reduce_only' ORDER BY ord), '[]'::jsonb)
    FROM jsonb_array_elements(s.orders) WITH ORDINALITY AS e(o, ord)
)
WHERE jsonb_typeof(s.orders) = 'array' AND jsonb_array_length(s.orders) > 0
"""

_MARK_KINDS = "'long_entry', 'short_entry', 'long_exit', 'short_exit', 'stop', 'note'"


def upgrade() -> None:
    # -- practice_threads: the clock, and the mode that allows 'freestyle' ----------------------------------
    op.add_column("practice_threads", sa.Column("start_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("practice_threads", sa.Column("clock_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "practice_threads", sa.Column("clock_running", sa.Boolean(), nullable=False, server_default=sa.text("false"))
    )
    op.add_column(
        "practice_threads", sa.Column("clock_speed", sa.SmallInteger(), nullable=False, server_default=sa.text("1"))
    )
    op.add_column("practice_threads", sa.Column("clock_anchor_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("practice_threads", sa.Column("clock_pause", postgresql.JSONB(), nullable=True))
    op.create_check_constraint("ck_practice_threads_clock_speed", "practice_threads", "clock_speed IN (1, 2, 5, 10)")
    op.drop_constraint("ck_practice_threads_mode", "practice_threads", type_="check")
    op.create_check_constraint("ck_practice_threads_mode", "practice_threads", "mode IN ('day', 'swing', 'freestyle')")

    # -- replay_sessions: a lane is one row per thread and name -----------------------------------------------
    op.create_index(
        "uq_replay_sessions_thread_id_symbol_active",
        "replay_sessions",
        ["thread_id", "symbol"],
        unique=True,
        postgresql_where=sa.text("status = 'active' AND thread_id IS NOT NULL"),
    )

    # -- practice_marks: the corporate-action mark ---------------------------------------------------------------
    op.drop_constraint("ck_practice_marks_kind", "practice_marks", type_="check")
    op.create_check_constraint("ck_practice_marks_kind", "practice_marks", f"kind IN ({_MARK_KINDS}, 'split')")

    # -- replay_day_lists: the Screen ------------------------------------------------------------------------------
    op.add_column("replay_day_lists", sa.Column("thread_id", sa.Integer(), nullable=True))
    op.create_foreign_key(
        "fk_replay_day_lists_thread_id_practice_threads",
        "replay_day_lists",
        "practice_threads",
        ["thread_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_unique_constraint("uq_replay_day_lists_thread_id", "replay_day_lists", ["thread_id"])

    # -- the data step (module docstring, 1-6) ---------------------------------------------------------------------
    op.execute(sa.text(_PAUSE_CLOCKS))
    op.execute(sa.text(_COPY_CLOCKS))
    op.execute(sa.text(_NAME_THE_SCREEN))
    op.execute(sa.text(_ORDER_KEYS))


def downgrade() -> None:
    op.execute(sa.text(_STRIP_ORDER_KEYS))

    op.drop_constraint("uq_replay_day_lists_thread_id", "replay_day_lists", type_="unique")
    op.drop_constraint("fk_replay_day_lists_thread_id_practice_threads", "replay_day_lists", type_="foreignkey")
    op.drop_column("replay_day_lists", "thread_id")

    op.drop_constraint("ck_practice_marks_kind", "practice_marks", type_="check")
    op.create_check_constraint("ck_practice_marks_kind", "practice_marks", f"kind IN ({_MARK_KINDS})")

    op.drop_index("uq_replay_sessions_thread_id_symbol_active", table_name="replay_sessions")

    op.drop_constraint("ck_practice_threads_mode", "practice_threads", type_="check")
    op.create_check_constraint("ck_practice_threads_mode", "practice_threads", "mode IN ('day', 'swing')")
    op.drop_constraint("ck_practice_threads_clock_speed", "practice_threads", type_="check")
    for column in ("clock_pause", "clock_anchor_at", "clock_speed", "clock_running", "clock_at", "start_at"):
        op.drop_column("practice_threads", column)
