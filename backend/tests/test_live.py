"""Exercises real HTTP streaming and lifecycle locking, beyond ASGI TestClient."""

import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from eventlab.config import Settings
from eventlab.main import create_app


def test_single_scheduler_lock_and_restart(tmp_path):
    settings = Settings(db_path=str(tmp_path / "lock.db"))
    first, second = create_app(settings), create_app(settings)
    with TestClient(first):
        with pytest.raises(RuntimeError, match="one Uvicorn worker"):
            with TestClient(second):
                pass
    with TestClient(second) as client:
        assert client.get("/healthz").status_code == 200


def test_sse_replay_over_real_http(tmp_path):
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    env = {
        **os.environ,
        "EVENTLAB_DB": str(tmp_path / "live.db"),
        "EVENTLAB_API_TOKEN": "live-test",
    }
    process = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "eventlab.main:create_app",
            "--factory",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
        ],
        cwd=Path(__file__).parents[1],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        with httpx.Client(
            base_url=f"http://127.0.0.1:{port}",
            timeout=5,
            trust_env=False,
            headers={"Authorization": "Bearer live-test"},
        ) as client:
            for _ in range(100):
                try:
                    if client.get("/readyz").status_code == 200:
                        break
                except httpx.ConnectError:
                    pass
                time.sleep(0.05)
            else:
                pytest.fail("Live API did not become ready")
            state = client.post("/api/runs", json={}).json()
            run, cursor = state["run"]["id"], state["cursor"]
            response = client.post(
                f"/api/runs/{run}/orders", json={}, headers={"Idempotency-Key": "sse"}
            )
            assert response.status_code == 201
            with client.stream(
                "GET", f"/api/runs/{run}/stream", headers={"Last-Event-ID": str(cursor)}
            ) as stream:
                assert stream.status_code == 200
                for line in stream.iter_lines():
                    if line.startswith("id: "):
                        assert int(line[4:]) > cursor
                        break
                else:
                    pytest.fail("SSE did not replay the journal")
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
