"""End-to-end HTTP smoke test. Usage: python scripts/smoke.py http://localhost:8080"""

import json
import os
import sys
import time
import urllib.request
import uuid

base = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8080"
# Loopback smoke checks must not inherit corporate/SOCKS proxies.
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def request(path, payload=None, key=None):
    headers = {"Content-Type": "application/json"}
    if os.getenv("EVENTLAB_API_TOKEN"):
        headers["Authorization"] = "Bearer " + os.environ["EVENTLAB_API_TOKEN"]
    if key:
        headers["Idempotency-Key"] = key
    req = urllib.request.Request(
        base + path,
        headers=headers,
        data=json.dumps(payload).encode() if payload is not None else None,
    )
    with opener.open(req, timeout=5) as response:
        return response.status, json.load(response)


assert request("/readyz")[1]["ready"]
_, state = request("/api/runs", {"name": "HTTP smoke", "scenario": "healthy"})
run = state["run"]["id"]
key = str(uuid.uuid4())
first_status, first = request(f"/api/runs/{run}/orders", {}, key)
second_status, second = request(f"/api/runs/{run}/orders", {}, key)
assert first_status == 201 and second_status == 200 and first["id"] == second["id"]
for _ in range(100):
    _, state = request(f"/api/runs/{run}")
    if state["metrics"]["completed"] == 1:
        break
    time.sleep(0.1)
else:
    raise RuntimeError("Order did not complete within ten seconds")
assert state["metrics"]["effects"] == 3 and state["metrics"]["events"] == 4
assert request(f"/api/runs/{run}/export")[1]["format"] == "eventlab.export.v1"
print("PASS: readiness, idempotency, complete pipeline and JSON export")
