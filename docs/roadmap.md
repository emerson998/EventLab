# Roadmap

The v1 implementation is intentionally complete for a local, fixed-pipeline laboratory. The items below are **not implemented** and should not be represented as current features.

| Direction | Required design work |
| --- | --- |
| RabbitMQ transport adapter | Publisher confirms, durable queues, crash-window duplicate tests, reconnect and consumer ACK policy |
| Kafka transport adapter | Partition key, offset commits, consumer groups, ordering and replay semantics |
| Separate logical services | Per-service databases, distributed transactions removed, idempotent external calls |
| Saga compensation | Explicit payment rejection, stock exhaustion, reversal events and terminal failure states |
| Visual custom topology | Versioned graph contracts, safe configuration and validation of cycles |
| Rich observability | OpenTelemetry propagation, traces, Prometheus counters and measurable latency definitions |
| Accounts/workspaces | Authentication, per-user authorization, quotas, retention and audit policy |
| Scale and analytics | Postgres migrations, worker leases, paginated read models and throughput benchmarks |
| Teaching mode | Assertions per scenario, guided exercises and importable experiment definitions |

Prioritize correctness demonstrations and tests over adding broker logos or unsupported deployment claims.
