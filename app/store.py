import json
import os
import sqlite3
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

SUMMARY_COLUMNS = (
    "id, reason, status, amount_value, currency, create_time, update_time, "
    "seller_response_due_date, outcome, received_at"
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
    received_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    dispute_id TEXT,
    received_at TEXT NOT NULL
);
"""

UPSERT = """
INSERT INTO disputes (id, reason, status, amount_value, currency, create_time,
    update_time, seller_response_due_date, outcome, resource, received_at)
VALUES (:id, :reason, :status, :amount_value, :currency, :create_time,
    :update_time, :seller_response_due_date, :outcome, :resource, :received_at)
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
    received_at = excluded.received_at
"""


def _connect() -> sqlite3.Connection:
    path = Path(os.environ.get("DISPUTESHIELD_DB", "data/disputeshield.db"))
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=10, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
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
            row = conn.execute(
                "SELECT update_time FROM disputes WHERE id = ?", (dispute["id"],)
            ).fetchone()
            stale = row is not None and _is_older(dispute["update_time"], row["update_time"])
            if not stale:
                conn.execute(UPSERT, {**dispute, "received_at": now})
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
    return "stale" if stale else "stored"


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
