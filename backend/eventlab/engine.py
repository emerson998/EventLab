"""Deterministic local transport, transactional consumers and durable retry scheduling.

Each tick is a short transaction, never a sleeping worker. Latency is represented
by available_at. There is no in-memory queue to lose on process restart.
"""

import hashlib
import json
import time
import uuid

from .models import FaultPatch, OrderCreate, RunCreate, Scenario
from .store import Store

SERVICES = ("payment", "inventory", "notification")
NEXT = {
    "payment": ("payment.approved", "inventory", "paid"),
    "inventory": ("inventory.reserved", "notification", "reserved"),
    "notification": ("notification.sent", None, "completed"),
}


class Missing(Exception):
    pass


class Conflict(Exception):
    pass


def uid():
    return str(uuid.uuid4())


def record(db, run_id, kind, message, now, **fields):
    known = {k: fields.pop(k, None) for k in ("service", "event_id", "order_id", "delivery_id")}
    db.execute(
        "INSERT INTO journal(run_id,kind,message,service,event_id,order_id,delivery_id,"
        "details,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
        (
            run_id,
            kind,
            message,
            known["service"],
            known["event_id"],
            known["order_id"],
            known["delivery_id"],
            json.dumps(fields),
            now,
        ),
    )


def require_run(db, run_id):
    run = db.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
    if run is None:
        raise Missing("Experimento não encontrado")
    return run


class Engine:
    def __init__(self, store: Store, clock=time.time):
        self.store = store
        self.clock = clock

    def create_run(self, data: RunCreate):
        run_id, now = uid(), self.clock()
        mode = "direct" if data.scenario == Scenario.direct_loss else "outbox"
        with self.store.connect(True) as db:
            db.execute(
                "INSERT INTO runs VALUES(?,?,?,?,?,?,?,?)",
                (
                    run_id,
                    data.name,
                    data.scenario,
                    mode,
                    0,
                    data.max_attempts,
                    data.retry_base_ms,
                    now,
                ),
            )
            for service in SERVICES:
                fail = (
                    (2 if data.scenario == Scenario.retry else 1000)
                    if (
                        service == "payment"
                        and data.scenario in (Scenario.retry, Scenario.dead_letter)
                    )
                    else 0
                )
                ack_loss = int(service == "payment" and data.scenario == Scenario.duplicate)
                db.execute(
                    "INSERT INTO faults(run_id,service,fail_next,ack_loss_next) VALUES(?,?,?,?)",
                    (run_id, service, fail, ack_loss),
                )
            record(db, run_id, "run.created", "Experimento criado", now, mode=mode)
        return self.snapshot(run_id)

    def list_runs(self):
        with self.store.connect() as db:
            return [
                dict(r)
                for r in db.execute(
                    "SELECT r.*, (SELECT COUNT(*) FROM orders o WHERE o.run_id=r.id) order_count "
                    "FROM runs r ORDER BY created_at DESC LIMIT 100"
                )
            ]

    def emit(self, db, run, order_id, kind, source, target, now, causation_id=None, gap=False):
        event_id = uid()
        payload = json.dumps({"order_id": order_id, "schema_version": 1})
        db.execute(
            "INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?)",
            (
                event_id,
                run["id"],
                order_id,
                kind,
                source,
                target,
                causation_id,
                payload,
                now,
            ),
        )
        record(
            db,
            run["id"],
            "event.created",
            kind,
            now,
            event_id=event_id,
            order_id=order_id,
            service=source,
            causation_id=causation_id,
        )
        if target is None:
            return event_id
        if run["mode"] == "outbox":
            db.execute(
                "INSERT INTO outbox(event_id,run_id,available_at) VALUES(?,?,?)",
                (
                    event_id,
                    run["id"],
                    now + (4 if gap else 0),
                ),
            )
            if gap:
                record(
                    db,
                    run["id"],
                    "outbox.recovery",
                    "Publicação suspensa por 4s; intenção preservada",
                    now,
                    event_id=event_id,
                    order_id=order_id,
                )
        elif gap:
            record(
                db,
                run["id"],
                "event.lost",
                "Falha após commit: evento não entregue sem outbox",
                now,
                event_id=event_id,
                order_id=order_id,
            )
        else:
            self.deliver(db, run["id"], event_id, target, now)
        return event_id

    def deliver(self, db, run_id, event_id, service, now):
        delivery_id = uid()
        fault = db.execute(
            "SELECT * FROM faults WHERE run_id=? AND service=?", (run_id, service)
        ).fetchone()
        db.execute(
            "INSERT INTO deliveries(id,run_id,event_id,service,available_at,created_at,updated_at) "
            "VALUES(?,?,?,?,?,?,?)",
            (delivery_id, run_id, event_id, service, now + fault["latency_ms"] / 1000, now, now),
        )
        record(
            db,
            run_id,
            "delivery.queued",
            "Mensagem na fila",
            now,
            service=service,
            event_id=event_id,
            delivery_id=delivery_id,
        )
        return delivery_id

    def create_order(self, run_id, data: OrderCreate, key: str):
        now, order_id = self.clock(), uid()
        fingerprint = hashlib.sha256(data.model_dump_json().encode()).hexdigest()
        with self.store.connect(True) as db:
            run = require_run(db, run_id)
            old = db.execute(
                "SELECT * FROM orders WHERE run_id=? AND idempotency_key=?", (run_id, key)
            ).fetchone()
            if old:
                if old["request_hash"] != fingerprint:
                    raise Conflict("Idempotency-Key já utilizada com outro conteúdo")
                return dict(old), False
            count = db.execute("SELECT COUNT(*) FROM orders WHERE run_id=?", (run_id,)).fetchone()[
                0
            ]
            if count >= 500:
                raise Conflict("Limite de 500 pedidos por experimento; crie outro experimento")
            db.execute(
                "INSERT INTO orders VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (
                    order_id,
                    run_id,
                    key,
                    fingerprint,
                    data.customer.strip(),
                    data.product.strip(),
                    data.quantity,
                    data.unit_price_cents,
                    "created",
                    now,
                    now,
                ),
            )
            gap = data.publish_gap or run["scenario"] in ("outbox_recovery", "direct_loss")
            self.emit(db, run, order_id, "order.created", "orders", "payment", now, gap=gap)
            record(db, run_id, "order.created", "Pedido criado", now, order_id=order_id)
            result = dict(db.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone())
        return result, True

    def patch_run(self, run_id, paused):
        with self.store.connect(True) as db:
            require_run(db, run_id)
            db.execute("UPDATE runs SET paused=? WHERE id=?", (paused, run_id))
            record(
                db,
                run_id,
                "run.paused" if paused else "run.resumed",
                "Experimento pausado" if paused else "Experimento retomado",
                self.clock(),
            )
        return self.snapshot(run_id)

    def patch_fault(self, run_id, service, patch: FaultPatch):
        updates = patch.model_dump(exclude_none=True)
        with self.store.connect(True) as db:
            require_run(db, run_id)
            if updates:
                clause = ",".join(f"{key}=?" for key in updates)
                db.execute(
                    f"UPDATE faults SET {clause} WHERE run_id=? AND service=?",
                    (*updates.values(), run_id, service),
                )
                record(
                    db,
                    run_id,
                    "fault.updated",
                    "Controles do consumidor atualizados",
                    self.clock(),
                    service=service,
                    controls=updates,
                )
        return self.snapshot(run_id)

    def tick(self, limit=100):
        now = self.clock()
        with self.store.connect(True) as db:
            outgoing = db.execute(
                "SELECT o.*,e.target FROM outbox o JOIN events e ON e.id=o.event_id "
                "JOIN runs r ON r.id=o.run_id WHERE o.status='pending' "
                "AND o.available_at<=? AND r.paused=0 ORDER BY o.available_at LIMIT ?",
                (now, limit),
            ).fetchall()
            for out in outgoing:
                self.deliver(db, out["run_id"], out["event_id"], out["target"], now)
                db.execute(
                    "UPDATE outbox SET status='published',published_at=? WHERE event_id=?",
                    (now, out["event_id"]),
                )
                record(
                    db,
                    out["run_id"],
                    "outbox.published",
                    "Outbox publicada",
                    now,
                    event_id=out["event_id"],
                )
            due = db.execute(
                "SELECT d.* FROM deliveries d JOIN runs r ON r.id=d.run_id "
                "JOIN faults f ON f.run_id=d.run_id AND f.service=d.service "
                "WHERE d.status IN ('pending','retry') AND d.available_at<=? "
                "AND r.paused=0 AND f.paused=0 ORDER BY d.available_at LIMIT ?",
                (now, limit),
            ).fetchall()
            for delivery in due:
                self.consume(db, delivery, now)
        return len(outgoing) + len(due)

    def consume(self, db, delivery, now):
        run_id, event_id, service = (delivery[k] for k in ("run_id", "event_id", "service"))
        run = require_run(db, run_id)
        fault = db.execute(
            "SELECT * FROM faults WHERE run_id=? AND service=?", (run_id, service)
        ).fetchone()
        attempt = delivery["attempts"] + 1
        db.execute(
            "UPDATE deliveries SET attempts=?,updated_at=? WHERE id=?",
            (attempt, now, delivery["id"]),
        )
        fields = dict(service=service, event_id=event_id, delivery_id=delivery["id"])
        if db.execute(
            "SELECT 1 FROM inbox WHERE run_id=? AND event_id=? AND service=?",
            (run_id, event_id, service),
        ).fetchone():
            db.execute(
                "UPDATE deliveries SET status='deduplicated',last_error=NULL WHERE id=?",
                (delivery["id"],),
            )
            record(
                db,
                run_id,
                "delivery.deduplicated",
                "Duplicata ignorada; efeito preservado",
                now,
                **fields,
                attempt=attempt,
            )
            return
        if fault["fail_next"] > 0:
            db.execute(
                "UPDATE faults SET fail_next=fail_next-1 WHERE run_id=? AND service=?",
                (run_id, service),
            )
            dead = attempt >= run["max_attempts"]
            delay = min(run["retry_base_ms"] / 1000 * (2 ** (attempt - 1)), 60)
            db.execute(
                "UPDATE deliveries SET status=?,available_at=?,last_error=? WHERE id=?",
                (
                    "dead" if dead else "retry",
                    now + delay,
                    "InjectedConsumerFailure",
                    delivery["id"],
                ),
            )
            record(
                db,
                run_id,
                "delivery.dead" if dead else "delivery.retry",
                "Tentativas esgotadas; mensagem na DLQ" if dead else "Falha; retry agendado",
                now,
                **fields,
                attempt=attempt,
                retry_in_ms=None if dead else delay * 1000,
            )
            return
        event = db.execute("SELECT * FROM events WHERE id=?", (event_id,)).fetchone()
        kind, target, status = NEXT[service]
        # Dedupe marker, business effect and next publication are one transaction.
        db.execute("INSERT INTO inbox VALUES(?,?,?,?)", (run_id, event_id, service, now))
        db.execute(
            "INSERT INTO effects VALUES(?,?,?,?,?,?)",
            (uid(), run_id, event_id, event["order_id"], service, now),
        )
        db.execute(
            "UPDATE orders SET status=?,updated_at=? WHERE id=?", (status, now, event["order_id"])
        )
        self.emit(db, run, event["order_id"], kind, service, target, now, causation_id=event_id)
        record(
            db,
            run_id,
            "consumer.processed",
            "Efeito de negócio confirmado",
            now,
            **fields,
            order_id=event["order_id"],
            attempt=attempt,
        )
        if fault["ack_loss_next"] > 0:
            db.execute(
                "UPDATE faults SET ack_loss_next=ack_loss_next-1 WHERE run_id=? AND service=?",
                (run_id, service),
            )
            # Commit succeeded, acknowledgement lost. Redelivery must not repeat the effect.
            db.execute(
                "UPDATE deliveries SET status='retry',available_at=?,last_error=? WHERE id=?",
                (now + run["retry_base_ms"] / 1000, "InjectedAcknowledgementLoss", delivery["id"]),
            )
            record(db, run_id, "delivery.ack_lost", "Commit concluído; ACK perdido", now, **fields)
        else:
            db.execute(
                "UPDATE deliveries SET status='succeeded',last_error=NULL WHERE id=?",
                (delivery["id"],),
            )

    def replay(self, run_id, delivery_id):
        with self.store.connect(True) as db:
            require_run(db, run_id)
            item = db.execute(
                "SELECT * FROM deliveries WHERE id=? AND run_id=?", (delivery_id, run_id)
            ).fetchone()
            if not item:
                raise Missing("Entrega não encontrada")
            if item["status"] != "dead":
                raise Conflict("Somente mensagens na DLQ podem ser reprocessadas")
            db.execute(
                "UPDATE deliveries SET status='pending',attempts=0,generation=generation+1,"
                "available_at=?,updated_at=?,last_error=NULL WHERE id=?",
                (self.clock(), self.clock(), delivery_id),
            )
            record(
                db,
                run_id,
                "delivery.replayed",
                "Reprocessamento solicitado",
                self.clock(),
                delivery_id=delivery_id,
                event_id=item["event_id"],
                service=item["service"],
            )
        return self.snapshot(run_id)

    def duplicate(self, run_id, delivery_id):
        with self.store.connect(True) as db:
            require_run(db, run_id)
            item = db.execute(
                "SELECT * FROM deliveries WHERE id=? AND run_id=?", (delivery_id, run_id)
            ).fetchone()
            if not item:
                raise Missing("Entrega não encontrada")
            count = db.execute(
                "SELECT COUNT(*) FROM deliveries WHERE run_id=?", (run_id,)
            ).fetchone()[0]
            if count >= 5000:
                raise Conflict("Limite de entregas atingido")
            self.deliver(db, run_id, item["event_id"], item["service"], self.clock())
            record(
                db,
                run_id,
                "delivery.duplicated",
                "Redelivery manual criada",
                self.clock(),
                event_id=item["event_id"],
                service=item["service"],
            )
        return self.snapshot(run_id)

    def snapshot(self, run_id):
        with self.store.connect() as db:
            return self._snapshot(db, run_id)

    def _snapshot(self, db, run_id):
        run = dict(require_run(db, run_id))
        tables = ("orders", "events", "deliveries", "effects", "outbox", "faults")
        result = {
            t: [
                dict(row)
                for row in db.execute(f"SELECT * FROM {t} WHERE run_id=? ORDER BY rowid", (run_id,))
            ]
            for t in tables
        }
        for event in result["events"]:
            event["payload"] = json.loads(event["payload"])
        journal = [
            dict(row)
            for row in db.execute(
                "SELECT * FROM journal WHERE run_id=? ORDER BY seq DESC LIMIT 250", (run_id,)
            )
        ]
        for row in journal:
            row["details"] = json.loads(row["details"])
        deliveries, orders = result["deliveries"], result["orders"]
        result.update(
            run=run,
            journal=journal,
            cursor=journal[0]["seq"] if journal else 0,
            metrics={
                "orders": len(orders),
                "completed": sum(o["status"] == "completed" for o in orders),
                "events": len(result["events"]),
                "pending": sum(d["status"] in ("pending", "retry") for d in deliveries),
                "dead": sum(d["status"] == "dead" for d in deliveries),
                "deduplicated": sum(d["status"] == "deduplicated" for d in deliveries),
                "effects": len(result["effects"]),
                "outbox_pending": sum(o["status"] == "pending" for o in result["outbox"]),
            },
        )
        return result

    def journal_after(self, run_id, after=0, limit=100):
        with self.store.connect() as db:
            require_run(db, run_id)
            rows = [
                dict(r)
                for r in db.execute(
                    "SELECT * FROM journal WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?",
                    (run_id, after, limit),
                )
            ]
            for row in rows:
                row["details"] = json.loads(row["details"])
            return rows

    def export(self, run_id):
        # Full export reads one consistent database snapshot, including the entire journal.
        with self.store.connect() as db:
            data = self._snapshot(db, run_id)
            data["journal"] = [
                dict(r)
                for r in db.execute("SELECT * FROM journal WHERE run_id=? ORDER BY seq", (run_id,))
            ]
            for row in data["journal"]:
                row["details"] = json.loads(row["details"])
        return {"format": "eventlab.export.v1", "exported_at": self.clock(), **data}
