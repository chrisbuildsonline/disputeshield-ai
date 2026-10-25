import json
import os
import sqlite3
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

SUMMARY_COLUMNS = (
    "id, reason, status, amount_value, currency, create_time, update_time, "
    "seller_response_due_date, outcome, source, received_at"
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS disputes (
    id TEXT PRIMARY KEY,
    reason TEXT,
    status TEXT,
    amount_value TEXT,
    currency TEXT,
    create_time TEXT,
    update_time TEXT,
    seller_response_due_date TEXT,
    outcome TEXT,
    resource TEXT NOT NULL,
    received_at TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'simulated'
);
CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    dispute_id TEXT,
    received_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY,
    dispute_id TEXT NOT NULL,
    name TEXT NOT NULL,
    data BLOB NOT NULL,
    evidence TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (dispute_id, name)
);
CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY,
    dispute_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    state TEXT NOT NULL,
    input TEXT,
    response TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS submissions_live
    ON submissions (dispute_id) WHERE state IN ('pending', 'submitted');
CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY,
    dispute_id TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL,
    at TEXT NOT NULL
);
"""

UPSERT = """
INSERT INTO disputes (id, reason, status, amount_value, currency, create_time,
    update_time, seller_response_due_date, outcome, resource, source, received_at)
VALUES (:id, :reason, :status, :amount_value, :currency, :create_time,
    :update_time, :seller_response_due_date, :outcome, :resource, :source, :received_at)
ON CONFLICT(id) DO UPDATE SET
    reason = excluded.reason,
    status = excluded.status,
    amount_value = excluded.amount_value,
    currency = excluded.currency,
    create_time = excluded.create_time,
    update_time = excluded.update_time,
    seller_response_due_date = excluded.seller_response_due_date,
    outcome = excluded.outcome,
    resource = excluded.resource,
    source = CASE WHEN excluded.source = 'paypal' THEN 'paypal' ELSE disputes.source END,
    received_at = excluded.received_at
"""


def _connect() -> sqlite3.Connection:
    path = Path(os.environ.get("DISPUTESHIELD_DB", "data/disputeshield.db"))
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=10, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    if not any(c["name"] == "source" for c in conn.execute("PRAGMA table_info(disputes)")):
        try:
            conn.execute("ALTER TABLE disputes ADD COLUMN source TEXT NOT NULL DEFAULT 'simulated'")
        except sqlite3.OperationalError:  # another connection added it first
            pass
    return conn


def _ts(value: str | None) -> tuple[int, float, str]:
    if value is None:
        return (0, 0.0, "")
    try:
        parsed = datetime.fromisoformat(value)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=UTC)
        return (2, parsed.timestamp(), "")
    except (ValueError, OverflowError):
        return (1, 0.0, value)


def _is_older(new: str | None, stored: str | None) -> bool:
    return stored is not None and _ts(new) < _ts(stored)


def record_event(
    event_id: str, event_type: str, dispute: dict[str, Any]
) -> str:
    """Returns "stored", "stale" (event recorded, dispute kept) or "duplicate"."""
    now = datetime.now(UTC).isoformat()
    with closing(_connect()) as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            cur = conn.execute(
                "INSERT OR IGNORE INTO events (id, event_type, dispute_id, received_at) "
                "VALUES (?, ?, ?, ?)",
                (event_id, event_type, dispute["id"], now),
            )
            if cur.rowcount == 0:
                conn.execute("ROLLBACK")
                return "duplicate"
            stale = _upsert_unless_stale(conn, dispute, now)
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
    return "stale" if stale else "stored"


def _upsert_unless_stale(conn: sqlite3.Connection, dispute: dict[str, Any], now: str) -> bool:
    row = conn.execute("SELECT update_time FROM disputes WHERE id = ?", (dispute["id"],)).fetchone()
    stale = row is not None and _is_older(dispute["update_time"], row["update_time"])
    if not stale:
        conn.execute(UPSERT, {**dispute, "received_at": now})
    return stale


def upsert_dispute(dispute: dict[str, Any]) -> str:
    """Returns "stored" or "stale" (a newer copy is kept)."""
    with closing(_connect()) as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            stale = _upsert_unless_stale(conn, dispute, datetime.now(UTC).isoformat())
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
    return "stale" if stale else "stored"


def set_status(dispute_id: str, status: str) -> None:
    with closing(_connect()) as conn:
        conn.execute("UPDATE disputes SET status = ? WHERE id = ?", (status, dispute_id))


# ponytail: one short-lived connection per call; fine at demo scale.
def add_document(dispute_id: str, name: str, data: bytes, evidence: dict[str, Any]) -> None:
    """Re-uploading a name replaces the earlier copy."""
    with closing(_connect()) as conn:
        conn.execute(
            "INSERT INTO documents (dispute_id, name, data, evidence, created_at) VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(dispute_id, name) DO UPDATE SET data = excluded.data, "
            "evidence = excluded.evidence, created_at = excluded.created_at",
            (dispute_id, name, data, json.dumps(evidence), datetime.now(UTC).isoformat()),
        )


def list_documents(dispute_id: str, *, with_data: bool = False) -> list[dict[str, Any]]:
    with closing(_connect()) as conn:
        rows = conn.execute(
            "SELECT name, data, evidence, created_at FROM documents WHERE dispute_id = ? ORDER BY id",
            (dispute_id,),
        ).fetchall()
    out: list[dict[str, Any]] = []
    for r in rows:
        doc = {"name": r["name"], "size": len(r["data"]), "evidence": json.loads(r["evidence"]), "created_at": r["created_at"]}
        out.append({**doc, "data": bytes(r["data"])} if with_data else doc)
    return out


def claim_submission(dispute_id: str, mode: str) -> int | None:
    """None if a pending or submitted claim already exists (the partial unique index decides, race-safe)."""
    now = datetime.now(UTC).isoformat()
    with closing(_connect()) as conn:
        try:
            cur = conn.execute(
                "INSERT INTO submissions (dispute_id, mode, state, created_at, updated_at) "
                "VALUES (?, ?, 'pending', ?, ?)",
                (dispute_id, mode, now, now),
            )
        except sqlite3.IntegrityError:
            return None
    return cur.lastrowid


def finish_submission(
    submission_id: int, state: str, *, input: dict[str, Any] | None = None, response: Any = None, error: str | None = None
) -> None:
    """state "failed" releases the claim."""
    with closing(_connect()) as conn:
        conn.execute(
            "UPDATE submissions SET state = ?, input = ?, response = ?, error = ?, updated_at = ? WHERE id = ?",
            (state, json.dumps(input), json.dumps(response), error, datetime.now(UTC).isoformat(), submission_id),
        )


def add_audit(dispute_id: str, action: str, detail: dict[str, Any] | None = None) -> None:
    with closing(_connect()) as conn:
        conn.execute(
            "INSERT INTO audit (dispute_id, action, detail, at) VALUES (?, ?, ?, ?)",
            (dispute_id, action, json.dumps(detail or {}), datetime.now(UTC).isoformat()),
        )


def list_audit(dispute_id: str) -> list[dict[str, Any]]:
    with closing(_connect()) as conn:
        rows = conn.execute(
            "SELECT id, dispute_id, action, detail, at FROM audit WHERE dispute_id = ? ORDER BY id", (dispute_id,)
        ).fetchall()
    return [{**dict(r), "detail": json.loads(r["detail"])} for r in rows]


def list_disputes() -> list[dict[str, Any]]:
    with closing(_connect()) as conn:
        rows = conn.execute(
            f"SELECT {SUMMARY_COLUMNS} FROM disputes ORDER BY update_time DESC, id"
        ).fetchall()
    return [dict(r) for r in rows]


def get_dispute(dispute_id: str) -> dict[str, Any] | None:
    with closing(_connect()) as conn:
        row = conn.execute("SELECT * FROM disputes WHERE id = ?", (dispute_id,)).fetchone()
    if row is None:
        return None
    d = dict(row)
    d["resource"] = json.loads(d["resource"])
    return d
