"""SQLite-backed, owner-scoped persistence for research runs.

Every write is a short, connection-per-operation transaction (WAL + busy
timeout) so admission races resolve via the database rather than in-process
locking. Paths are built only from the given root and the DB's own UUIDs;
ticker/client-supplied strings never reach the filesystem here.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import UTC, datetime
from pathlib import Path

from tradingagents.dataflows.symbols import normalize_symbol, safe_ticker_component

from .domain import BusyError, NotFoundError, Run

_ALLOWED_STATUSES = ("running", "completed", "failed", "interrupted")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    inputs TEXT NOT NULL,
    origin TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running','completed','failed','interrupted')),
    stage TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    shared INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL,
    settings TEXT NOT NULL,
    artifacts_ready INTEGER NOT NULL DEFAULT 0,
    partial INTEGER NOT NULL DEFAULT 0,
    fingerprint TEXT,
    error_code TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_running ON runs((1)) WHERE status='running';
CREATE UNIQUE INDEX IF NOT EXISTS imported_content ON runs(owner_id, fingerprint)
    WHERE fingerprint IS NOT NULL;
CREATE INDEX IF NOT EXISTS owner_lookup ON runs(owner_id);
"""

READ_QUERY = "SELECT * FROM runs WHERE id=? AND (owner_id=? OR shared=1)"
OWNER_QUERY = "SELECT * FROM runs WHERE id=? AND owner_id=?"


def _utc_now_iso() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _validate_run_id(value: str) -> str:
    """Canonical UUID4 text only, or NotFoundError — never leaks format vs. existence.

    ``uuid.UUID`` itself accepts uppercase, braced, hyphenless, and URN
    spellings and normalizes them, which would let those non-canonical
    external spellings fetch the canonical row (protocol URLs only ever use
    canonical lowercase-hyphenated ids). Require the input to already equal
    its own canonical rendering.
    """
    if not isinstance(value, str):
        raise NotFoundError()
    try:
        parsed = uuid.UUID(value)
    except (ValueError, AttributeError, TypeError):
        raise NotFoundError() from None
    if parsed.version != 4 or str(parsed) != value:
        raise NotFoundError()
    return value


def _row_to_run(row: sqlite3.Row) -> Run:
    return Run(
        id=row["id"],
        owner_id=row["owner_id"],
        inputs=json.loads(row["inputs"]),
        origin=row["origin"],
        status=row["status"],
        stage=row["stage"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        shared=bool(row["shared"]),
        state=json.loads(row["state"]),
        settings=json.loads(row["settings"]),
        artifacts_ready=bool(row["artifacts_ready"]),
        partial=bool(row["partial"]),
        fingerprint=row["fingerprint"],
        error_code=row["error_code"],
    )


class Store:
    def __init__(self, root: Path):
        self._dir = Path(root) / "research"
        self._dir.mkdir(parents=True, exist_ok=True)
        self._db_path = self._dir / "index.db"
        conn = self._connect()
        try:
            conn.executescript(_SCHEMA)
        finally:
            conn.close()

    @property
    def research_dir(self) -> Path:
        """``root/research``: the one directory reports/import may write under."""
        return self._dir

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path, timeout=5, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=5000")
        return conn

    # --- admission / lifecycle ----------------------------------------------

    def create(self, owner: str, inputs) -> Run:
        run_id = str(uuid.uuid4())
        now = _utc_now_iso()
        payload = json.dumps(inputs.model_dump())
        empty = json.dumps({})
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            try:
                conn.execute(
                    """INSERT INTO runs
                       (id, owner_id, inputs, origin, status, stage, created_at, updated_at,
                        shared, state, settings, artifacts_ready, partial, fingerprint, error_code)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (run_id, owner, payload, "web", "running", None, now, now,
                     0, empty, empty, 0, 0, None, None),
                )
            except sqlite3.IntegrityError as exc:
                conn.execute("ROLLBACK")
                raise BusyError() from exc
            conn.execute("COMMIT")
        finally:
            conn.close()
        return self.get_owned(run_id, owner)

    def update(
        self,
        id: str,
        *,
        status: str | None = None,
        stage: str | None = None,
        state: dict | None = None,
        settings: dict | None = None,
        artifacts_ready: bool | None = None,
        partial: bool | None = None,
        error_code: str | None = None,
    ) -> None:
        run_id = _validate_run_id(id)
        sets: list[str] = []
        params: list = []
        if status is not None:
            if status not in _ALLOWED_STATUSES:
                raise ValueError(f"unknown status: {status!r}")
            sets.append("status = ?")
            params.append(status)
        if stage is not None:
            sets.append("stage = ?")
            params.append(stage)
        if state is not None:
            sets.append("state = ?")
            params.append(json.dumps(state))
        if settings is not None:
            sets.append("settings = ?")
            params.append(json.dumps(settings))
        if artifacts_ready is not None:
            sets.append("artifacts_ready = ?")
            params.append(1 if artifacts_ready else 0)
        if partial is not None:
            sets.append("partial = ?")
            params.append(1 if partial else 0)
        if error_code is not None:
            sets.append("error_code = ?")
            params.append(error_code)
        if not sets:
            return
        sets.append("updated_at = ?")
        params.append(_utc_now_iso())
        params.append(run_id)

        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            cur = conn.execute(f"UPDATE runs SET {', '.join(sets)} WHERE id = ?", params)
            if cur.rowcount == 0:
                conn.execute("ROLLBACK")
                raise NotFoundError()
            conn.execute("COMMIT")
        finally:
            conn.close()

    def mark_interrupted(self) -> list[str]:
        now = _utc_now_iso()
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            rows = conn.execute("SELECT id FROM runs WHERE status='running'").fetchall()
            ids = [row["id"] for row in rows]
            if ids:
                conn.execute(
                    "UPDATE runs SET status='interrupted', updated_at=? WHERE status='running'",
                    (now,),
                )
            conn.execute("COMMIT")
        finally:
            conn.close()
        return ids

    # --- reads ---------------------------------------------------------------

    def get_visible(self, id: str, viewer: str) -> Run:
        run_id = _validate_run_id(id)
        conn = self._connect()
        try:
            row = conn.execute(READ_QUERY, (run_id, viewer)).fetchone()
        finally:
            conn.close()
        if row is None:
            raise NotFoundError()
        return _row_to_run(row)

    def get_owned(self, id: str, owner: str) -> Run:
        run_id = _validate_run_id(id)
        conn = self._connect()
        try:
            row = conn.execute(OWNER_QUERY, (run_id, owner)).fetchone()
        finally:
            conn.close()
        if row is None:
            raise NotFoundError()
        return _row_to_run(row)

    def worker_run(self, id: str) -> Run:
        """Internal/operator read, bypassing owner/sharing visibility."""
        run_id = _validate_run_id(id)
        conn = self._connect()
        try:
            row = conn.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
        finally:
            conn.close()
        if row is None:
            raise NotFoundError()
        return _row_to_run(row)

    def list_owned(
        self,
        owner: str,
        *,
        limit: int = 25,
        offset: int = 0,
        ticker: str | None = None,
        analysis_date: str | None = None,
        status: str | None = None,
    ) -> list[Run]:
        limit = 25 if limit is None else max(1, min(int(limit), 100))
        offset = max(0, int(offset)) if offset is not None else 0

        clauses = ["owner_id = ?"]
        params: list = [owner]
        if ticker is not None:
            canonical = safe_ticker_component(normalize_symbol(ticker.strip()))
            clauses.append("json_extract(inputs, '$.ticker') = ?")
            params.append(canonical)
        if analysis_date is not None:
            value = analysis_date.strip()
            try:
                datetime.strptime(value, "%Y-%m-%d")
            except ValueError:
                raise ValueError("analysis_date must be YYYY-MM-DD") from None
            clauses.append("json_extract(inputs, '$.analysis_date') = ?")
            params.append(value)
        if status is not None:
            if status not in _ALLOWED_STATUSES:
                raise ValueError(f"unknown status: {status!r}")
            clauses.append("status = ?")
            params.append(status)

        sql = (
            f"SELECT * FROM runs WHERE {' AND '.join(clauses)} "
            "ORDER BY created_at DESC LIMIT ? OFFSET ?"
        )
        params.extend([limit, offset])
        conn = self._connect()
        try:
            rows = conn.execute(sql, params).fetchall()
        finally:
            conn.close()
        return [_row_to_run(row) for row in rows]

    # --- sharing ---------------------------------------------------------------

    def set_shared(self, id: str, owner: str, enabled: bool) -> Run:
        run_id = _validate_run_id(id)
        now = _utc_now_iso()
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(OWNER_QUERY, (run_id, owner)).fetchone()
            if row is None:
                conn.execute("ROLLBACK")
                raise NotFoundError()
            conn.execute(
                "UPDATE runs SET shared=?, updated_at=? WHERE id=? AND owner_id=?",
                (1 if enabled else 0, now, run_id, owner),
            )
            conn.execute("COMMIT")
        finally:
            conn.close()
        return self.get_owned(run_id, owner)

    # --- operator import (Task 2 only; never HTTP) ------------------------------

    def add_import(
        self,
        owner: str,
        fingerprint: str,
        inputs: dict,
        state: dict,
        settings: dict,
        partial: bool,
    ) -> tuple[Run, bool]:
        if not isinstance(fingerprint, str) or not fingerprint.strip():
            raise ValueError("fingerprint is required")
        run_id = str(uuid.uuid4())
        now = _utc_now_iso()
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            try:
                conn.execute(
                    """INSERT INTO runs
                       (id, owner_id, inputs, origin, status, stage, created_at, updated_at,
                        shared, state, settings, artifacts_ready, partial, fingerprint, error_code)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (run_id, owner, json.dumps(inputs), "import", "completed", None, now, now,
                     0, json.dumps(state), json.dumps(settings), 0, 1 if partial else 0,
                     fingerprint, None),
                )
            except sqlite3.IntegrityError:
                conn.execute("ROLLBACK")
                row = conn.execute(
                    "SELECT * FROM runs WHERE owner_id=? AND fingerprint=?", (owner, fingerprint)
                ).fetchone()
                if row is None:
                    raise
                return _row_to_run(row), False
            conn.execute("COMMIT")
        finally:
            conn.close()
        return self.worker_run(run_id), True

    def discard_import(self, id: str, owner: str) -> None:
        """Delete only this owner's own, not-yet-published import; never ready/ordinary runs."""
        run_id = _validate_run_id(id)
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            cur = conn.execute(
                "DELETE FROM runs WHERE id=? AND owner_id=? AND origin='import' AND artifacts_ready=0",
                (run_id, owner),
            )
            if cur.rowcount == 0:
                conn.execute("ROLLBACK")
                raise NotFoundError()
            conn.execute("COMMIT")
        finally:
            conn.close()
