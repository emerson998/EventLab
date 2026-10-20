from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest

from eventlab.engine import Conflict, Engine, Missing
from eventlab.models import FaultPatch, OrderCreate, RunCreate
from eventlab.store import Store
from tests.conftest import drain


def start(engine, scenario="healthy", **kwargs):
    run_id = engine.create_run(RunCreate(scenario=scenario, **kwargs))["run"]["id"]
    order, _ = engine.create_order(run_id, OrderCreate(), str(uuid4()))
    return run_id, order


def test_happy_path_has_causal_chain_and_three_effects(lab):
    engine, clock = lab
    run, order = start(engine)
    drain(engine, clock)
    state = engine.snapshot(run)
    assert state["orders"][0]["status"] == "completed"
    assert state["metrics"]["effects"] == 3
    assert state["metrics"]["completed"] == 1
    assert len(state["events"]) == 4
    assert all(e["order_id"] == order["id"] for e in state["events"])
    assert len({e["causation_id"] for e in state["events"] if e["causation_id"]}) == 3
    assert all(o["status"] == "published" for o in state["outbox"])


def test_retry_backoff_is_persisted_and_obeys_due_time(lab):
    engine, clock = lab
    run, _ = start(engine, "retry")
    engine.tick()  # relay
    clock.advance()
    engine.tick()  # first failure
    first = engine.snapshot(run)["deliveries"][0]
    assert first["status"] == "retry" and first["attempts"] == 1
    engine.tick()  # same time cannot retry
    assert engine.snapshot(run)["deliveries"][0]["attempts"] == 1
    clock.advance()
    engine.tick()
    second = engine.snapshot(run)["deliveries"][0]
    assert second["available_at"] - clock() == 2
    drain(engine, clock)
    assert engine.snapshot(run)["metrics"]["completed"] == 1


def test_dlq_recovery_requires_fix_and_resets_generation(lab):
    engine, clock = lab
    run, _ = start(engine, "dead_letter")
    drain(engine, clock)
    dead = engine.snapshot(run)["deliveries"][0]
    assert dead["status"] == "dead" and dead["attempts"] == 3
    assert engine.snapshot(run)["effects"] == []
    engine.patch_fault(run, "payment", FaultPatch(fail_next=0))
    engine.replay(run, dead["id"])
    drain(engine, clock)
    state = engine.snapshot(run)
    assert state["deliveries"][0]["generation"] == 1
    assert state["metrics"]["completed"] == 1
    assert state["metrics"]["dead"] == 0


def test_lost_ack_does_not_repeat_business_effect(lab):
    engine, clock = lab
    run, _ = start(engine, "duplicate")
    drain(engine, clock)
    state = engine.snapshot(run)
    assert state["metrics"]["deduplicated"] == 1
    assert state["metrics"]["effects"] == 3
    assert len(state["events"]) == 4
    assert any(j["kind"] == "delivery.ack_lost" for j in state["journal"])


def test_manual_duplicate_after_completion_does_not_regress_order(lab):
    engine, clock = lab
    run, _ = start(engine)
    drain(engine, clock)
    original = engine.snapshot(run)["deliveries"][0]
    engine.duplicate(run, original["id"])
    drain(engine, clock)
    state = engine.snapshot(run)
    assert state["orders"][0]["status"] == "completed"
    assert len(state["effects"]) == 3
    assert state["metrics"]["deduplicated"] == 1


def test_consumer_pause_keeps_delivery_pending(lab):
    engine, clock = lab
    run, _ = start(engine)
    engine.patch_fault(run, "inventory", FaultPatch(paused=True))
    drain(engine, clock)
    assert engine.snapshot(run)["orders"][0]["status"] == "paid"
    engine.patch_fault(run, "inventory", FaultPatch(paused=False))
    drain(engine, clock)
    assert engine.snapshot(run)["metrics"]["completed"] == 1


def test_run_pause_stops_relay_and_consumers(lab):
    engine, clock = lab
    run, _ = start(engine)
    engine.patch_run(run, True)
    drain(engine, clock)
    assert engine.snapshot(run)["metrics"]["outbox_pending"] == 1
    assert engine.snapshot(run)["deliveries"] == []
    engine.patch_run(run, False)
    drain(engine, clock)
    assert engine.snapshot(run)["metrics"]["completed"] == 1


def test_restart_resumes_durable_publication(lab):
    engine, clock = lab
    run, _ = start(engine, "outbox_recovery")
    engine = Engine(Store(engine.store.path), clock=clock)
    drain(engine, clock)
    assert engine.snapshot(run)["metrics"]["completed"] == 1


def test_restart_resumes_retry_without_resetting_attempts(lab):
    engine, clock = lab
    run, _ = start(engine, "retry")
    engine.tick()
    clock.advance()
    engine.tick()
    engine = Engine(Store(engine.store.path), clock=clock)
    assert engine.snapshot(run)["deliveries"][0]["attempts"] == 1
    drain(engine, clock)
    assert engine.snapshot(run)["metrics"]["completed"] == 1


def test_direct_write_gap_loses_delivery_but_not_order(lab):
    engine, clock = lab
    run, _ = start(engine, "direct_loss")
    drain(engine, clock)
    state = engine.snapshot(run)
    assert state["orders"][0]["status"] == "created"
    assert state["deliveries"] == []
    assert any(j["kind"] == "event.lost" for j in state["journal"])


def test_order_idempotency_conflicts_and_isolation(lab):
    engine, _ = lab
    run = engine.create_run(RunCreate())["run"]["id"]
    first, created = engine.create_order(run, OrderCreate(), "same-key")
    second, repeated = engine.create_order(run, OrderCreate(), "same-key")
    assert created and not repeated and first["id"] == second["id"]
    with pytest.raises(Conflict):
        engine.create_order(run, OrderCreate(quantity=2), "same-key")
    another = engine.create_run(RunCreate())["run"]["id"]
    different, _ = engine.create_order(another, OrderCreate(), "same-key")
    assert different["id"] != first["id"]


def test_concurrent_same_key_creates_one_order(lab):
    engine, _ = lab
    run = engine.create_run(RunCreate())["run"]["id"]
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(
            pool.map(lambda _: engine.create_order(run, OrderCreate(), "concurrent"), range(12))
        )
    assert len({r[0]["id"] for r in results}) == 1
    assert sum(r[1] for r in results) == 1


def test_business_transaction_rolls_back_on_publication_failure(lab, monkeypatch):
    engine, clock = lab
    run, _ = start(engine)
    engine.tick()
    clock.advance()

    def fail(*args, **kwargs):
        raise RuntimeError("publication unavailable")

    original = engine.emit
    monkeypatch.setattr(engine, "emit", fail)
    with pytest.raises(RuntimeError):
        engine.tick()
    state = engine.snapshot(run)
    assert state["effects"] == []
    assert state["orders"][0]["status"] == "created"
    assert state["deliveries"][0]["attempts"] == 0
    monkeypatch.setattr(engine, "emit", original)
    drain(engine, clock)
    assert engine.snapshot(run)["metrics"]["completed"] == 1


def test_delivery_cannot_be_replayed_or_duplicated_across_runs(lab):
    engine, clock = lab
    run, _ = start(engine)
    other, _ = start(engine)
    drain(engine, clock)
    delivery = engine.snapshot(run)["deliveries"][0]
    with pytest.raises(Missing):
        engine.duplicate(other, delivery["id"])
    with pytest.raises(Missing):
        engine.replay(other, delivery["id"])
    with pytest.raises(Conflict):
        engine.replay(run, delivery["id"])


def test_journal_cursor_and_export(lab):
    engine, clock = lab
    run, _ = start(engine)
    cursor = engine.snapshot(run)["cursor"]
    drain(engine, clock)
    rows = engine.journal_after(run, cursor)
    assert all(r["seq"] > cursor for r in rows)
    assert [r["seq"] for r in rows] == sorted(r["seq"] for r in rows)
    assert engine.export(run)["format"] == "eventlab.export.v1"


def test_consumer_latency_schedules_without_blocking(lab):
    engine, clock = lab
    run, _ = start(engine)
    engine.patch_fault(run, "payment", FaultPatch(latency_ms=15000))
    engine.tick()
    clock.advance(14)
    engine.tick()
    assert engine.snapshot(run)["effects"] == []
    clock.advance(1)
    engine.tick()
    assert engine.snapshot(run)["orders"][0]["status"] == "paid"


def test_batch_preserves_all_order_and_consumer_invariants(lab):
    engine, clock = lab
    run = engine.create_run(RunCreate())["run"]["id"]
    for n in range(100):
        engine.create_order(run, OrderCreate(), f"batch-{n}")
    drain(engine, clock)
    state = engine.snapshot(run)
    assert state["metrics"]["completed"] == 100
    assert state["metrics"]["effects"] == 300
    assert len(state["events"]) == 400
    assert len(state["deliveries"]) == 300
    assert len(state["journal"]) == 250
    export = engine.export(run)
    assert len(export["journal"]) > 250
    assert export["cursor"] == export["journal"][-1]["seq"]
