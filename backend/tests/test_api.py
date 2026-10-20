from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from eventlab.config import Settings
from eventlab.main import create_app


@pytest.fixture
def client(tmp_path):
    app = create_app(Settings(db_path=str(tmp_path / "api.db"), worker_enabled=False))
    with TestClient(app) as client:
        yield client


def test_create_and_idempotent_order(client):
    run = client.post("/api/runs", json={}).json()["run"]["id"]
    url = f"/api/runs/{run}/orders"
    headers = {"Idempotency-Key": "request-1"}
    assert client.post(url, json={}, headers=headers).status_code == 201
    assert client.post(url, json={}, headers=headers).status_code == 200
    assert client.post(url, json={"quantity": 2}, headers=headers).status_code == 409
    assert client.post(url, json={}).status_code == 422


def test_validation_and_missing_resources(client):
    assert client.post("/api/runs", json={"max_attempts": 0}).status_code == 422
    assert client.post("/api/runs", json={"surprise": True}).status_code == 422
    assert client.get(f"/api/runs/{uuid4()}").status_code == 404
    assert client.get("/api/runs/not-a-uuid").status_code == 422
    run = client.post("/api/runs", json={}).json()["run"]["id"]
    assert client.patch(f"/api/runs/{run}/faults/nope", json={}).status_code == 422
    assert (
        client.patch(f"/api/runs/{run}/faults/payment", json={"latency_ms": -1}).status_code == 422
    )
    assert (
        client.get(f"/api/runs/{run}/stream", headers={"Last-Event-ID": "bad"}).status_code == 400
    )
    assert client.get(f"/api/runs/{run}/stream", headers={"Last-Event-ID": "-1"}).status_code == 400


def test_auth_guards_reads_writes_and_stream(tmp_path):
    with TestClient(
        create_app(
            Settings(
                db_path=str(tmp_path / "auth.db"), api_token="test-secret", worker_enabled=False
            )
        )
    ) as client:
        assert client.get("/healthz").status_code == 200
        assert client.get("/readyz").json()["ready"]
        assert client.get("/api/runs").status_code == 401
        assert client.post("/api/runs", json={}).status_code == 401
        assert client.get(f"/api/runs/{uuid4()}/stream").status_code == 401
        assert (
            client.get("/api/runs", headers={"Authorization": "Bearer test-secret"}).status_code
            == 200
        )


def test_export_is_downloadable_and_health_has_security_headers(client):
    run = client.post("/api/runs", json={}).json()["run"]["id"]
    response = client.get(f"/api/runs/{run}/export")
    assert response.status_code == 200
    assert "attachment" in response.headers["content-disposition"]
    assert response.json()["run"]["id"] == run
    assert client.get("/healthz").headers["x-content-type-options"] == "nosniff"
