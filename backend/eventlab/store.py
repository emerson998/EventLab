"""SQLite owns all durable state; the journal is also the SSE replay log."""

import sqlite3
from contextlib import contextmanager
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS schema_version(version INTEGER PRIMARY KEY);
INSERT OR IGNORE INTO schema_version VALUES (1);
CREATE TABLE IF NOT EXISTS runs(
 id TEXT PRIMARY KEY, name TEXT NOT NULL, scenario TEXT NOT NULL,
 mode TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0,
 max_attempts INTEGER NOT NULL, retry_base_ms INTEGER NOT NULL, created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS faults(
 run_id TEXT NOT NULL REFERENCES runs(id), service TEXT NOT NULL,
 paused INTEGER NOT NULL DEFAULT 0, fail_next INTEGER NOT NULL DEFAULT 0,
 latency_ms INTEGER NOT NULL DEFAULT 400, ack_loss_next INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(run_id,service)
);
CREATE TABLE IF NOT EXISTS orders(
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
 idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
 customer TEXT NOT NULL, product TEXT NOT NULL, quantity INTEGER NOT NULL,
 unit_price_cents INTEGER NOT NULL, status TEXT NOT NULL,
 created_at REAL NOT NULL, updated_at REAL NOT NULL,
 UNIQUE(run_id,idempotency_key)
);
CREATE TABLE IF NOT EXISTS events(
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
 order_id TEXT NOT NULL REFERENCES orders(id), type TEXT NOT NULL,
 source TEXT NOT NULL, target TEXT, causation_id TEXT,
 payload TEXT NOT NULL, created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox(
 event_id TEXT PRIMARY KEY REFERENCES events(id), run_id TEXT NOT NULL REFERENCES runs(id),
 status TEXT NOT NULL DEFAULT 'pending', available_at REAL NOT NULL,
 published_at REAL
);
CREATE TABLE IF NOT EXISTS deliveries(
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
 event_id TEXT NOT NULL REFERENCES events(id), service TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
 generation INTEGER NOT NULL DEFAULT 0, available_at REAL NOT NULL,
 created_at REAL NOT NULL, updated_at REAL NOT NULL, last_error TEXT
);
CREATE TABLE IF NOT EXISTS inbox(
 run_id TEXT NOT NULL REFERENCES runs(id), event_id TEXT NOT NULL REFERENCES events(id),
 service TEXT NOT NULL, processed_at REAL NOT NULL,
 PRIMARY KEY(run_id,event_id,service)
);
CREATE TABLE IF NOT EXISTS effects(
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
 event_id TEXT NOT NULL REFERENCES events(id), order_id TEXT NOT NULL REFERENCES orders(id),
 service TEXT NOT NULL, created_at REAL NOT NULL,
 UNIQUE(run_id,event_id,service)
);
CREATE TABLE IF NOT EXISTS journal(
 seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id),
 kind TEXT NOT NULL, message TEXT NOT NULL, service TEXT, event_id TEXT,
 order_id TEXT, delivery_id TEXT, details TEXT NOT NULL, created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_outbox_due ON outbox(status,available_at);
CREATE INDEX IF NOT EXISTS ix_delivery_due ON deliveries(status,available_at);
CREATE INDEX IF NOT EXISTS ix_events_run ON events(run_id,created_at);
CREATE INDEX IF NOT EXISTS ix_orders_run ON orders(run_id,created_at);
CREATE INDEX IF NOT EXISTS ix_delivery_run ON deliveries(run_id,status);
CREATE INDEX IF NOT EXISTS ix_journal_run ON journal(run_id,seq);
"""


class Store:
    def __init__(self, path: str):
        self.path = path
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(self.path, timeout=10, isolation_level=None) as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript(SCHEMA)
            version = db.execute("SELECT MAX(version) FROM schema_version").fetchone()[0]
            if version != 1:
                raise RuntimeError(f"Unsupported database schema: {version}")

    @contextmanager
    def connect(self, write: bool = False):
        db = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA synchronous=FULL")
        try:
            db.execute("BEGIN IMMEDIATE" if write else "BEGIN")
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()
