# HTTP API

Base URL: `http://localhost:8000`. Interactive contracts: `/docs`; machine-readable schema: `/openapi.json`. Both describe models and request validation. The generated schema is also checked into `docs/openapi.json` for offline inspection.

## Authentication

When `EVENTLAB_API_TOKEN` is nonempty, every `/api/*` endpoint requires:

```http
Authorization: Bearer <your-token>
```

Health, readiness and API schema/documentation remain public. A token grants access to the entire shared lab; it is not scoped to a user or experiment. The UI's **Conexão** dialog stores a token in sessionStorage and sends it in headers, including the SSE fetch request.

## Endpoints

| Method | Path | Result |
| --- | --- | --- |
| GET | `/healthz` | Process liveness/version |
| GET | `/readyz` | Database and background-worker readiness, 503 when unhealthy |
| GET | `/api/runs` | Up to 100 most recent experiments |
| POST | `/api/runs` | Create experiment, 201 |
| GET | `/api/runs/{run_id}` | Consistent snapshot and latest 250 journal rows |
| PATCH | `/api/runs/{run_id}` | Pause/resume the complete experiment |
| POST | `/api/runs/{run_id}/orders` | Create or return an idempotent order |
| PATCH | `/api/runs/{run_id}/faults/{service}` | Patch a consumer's controls |
| POST | `/api/runs/{run_id}/deliveries/{delivery_id}/duplicate` | Create another delivery of the same event |
| POST | `/api/runs/{run_id}/deliveries/{delivery_id}/replay` | Requeue a dead letter with a new generation |
| GET | `/api/runs/{run_id}/journal?after=0&limit=100` | Cursor page; `limit` 1–500 |
| GET | `/api/runs/{run_id}/stream?after=0` | SSE journal stream |
| GET | `/api/runs/{run_id}/export` | Complete experiment JSON download |

All IDs in paths must be UUIDs. Consumer names: `payment`, `inventory`, `notification`. Unknown body properties are rejected.

## Create an experiment

```bash
curl -X POST http://localhost:8000/api/runs \
  -H 'Content-Type: application/json' \
  -d '{"name":"Lost ACK demo","scenario":"duplicate","max_attempts":3,"retry_base_ms":1000}'
```

Scenario values: `healthy`, `retry`, `dead_letter`, `duplicate`, `outbox_recovery`, `direct_loss`. Max attempts: 1–8. Initial backoff: 100–10,000ms. The response includes `run.id`; use that UUID below. Add the Authorization header to examples if a token is configured.

## Create an order safely

```bash
curl -X POST http://localhost:8000/api/runs/RUN_UUID/orders \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: order-demo-001' \
  -d '{"customer":"Ada Lovelace","product":"Mechanical keyboard","quantity":1,"unit_price_cents":24900,"publish_gap":false}'
```

The key is required and scoped to a run. Same key + same normalized payload returns the existing order (HTTP 200); a new request returns 201; same key + different payload returns 409. Concurrent identical requests create only one order. Amounts are integer cents, quantity 1–100, and price 1–100,000,000 cents. The UI generates a fresh UUID for each order submission.

## Control a consumer

```bash
curl -X PATCH http://localhost:8000/api/runs/RUN_UUID/faults/payment \
  -H 'Content-Type: application/json' \
  -d '{"paused":false,"fail_next":2,"latency_ms":400,"ack_loss_next":1}'
```

Properties are optional and patch only the supplied values. `fail_next` is 0–1,000; `ack_loss_next` is 0–100; latency is 0–15,000ms. A fault budget is decremented when that service processes an eligible, previously unseen event. Dedupe checks take precedence over injected failures.

## SSE protocol

```bash
curl -N http://localhost:8000/api/runs/RUN_UUID/stream \
  -H 'Last-Event-ID: 12'
```

Example frame:

```text
id: 13
event: journal
data: {"seq":13,"kind":"delivery.queued","message":"Mensagem na fila",...}

```

The illustrative data above is abbreviated; actual data is valid complete JSON. The stream emits only records belonging to the requested run with a sequence above the cursor. Sequence numbers are globally monotonic and may have gaps within a run. When both cursors are present, the higher `after` or `Last-Event-ID` wins. IDs must be nonnegative integers. Comments act as heartbeats; clients must ignore them and parse complete frames across arbitrary network chunks.

## Errors and limits

| Status | Meaning |
| --- | --- |
| 401 | Missing/incorrect configured bearer token |
| 404 | Run or delivery missing, including a delivery from a different run |
| 409 | Idempotency conflict, invalid replay state or experiment data limit |
| 422 | Invalid fields, missing idempotency key, invalid UUID or enum |
| 503 | Worker unhealthy or not yet ready |

There is a 500-order limit per run and a 5,000-delivery guard for manual duplication. Snapshots return all orders/events/deliveries for that run, so very large experiments increase response size. Limits bound individual experiments; there is no automatic retention policy or global run cap. Use a local lab or infrastructure-level limits, and back up/reset intentionally.
