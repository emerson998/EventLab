# Running and operating EventLab

## Supported deployment

Run one API process/worker with one local SQLite database and persistent storage. React can be served independently, but the supplied Compose setup uses an unprivileged Nginx container as a same-origin reverse proxy. API and web ports bind to loopback by default. Docker is the recommended path on Windows; native execution also uses a cross-platform scheduler lock.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `EVENTLAB_DB` | `data/eventlab.db` relative to API working directory | SQLite file path |
| `EVENTLAB_API_TOKEN` | empty | Shared bearer token for all `/api/*` routes |
| `EVENTLAB_ORIGINS` | `http://localhost:5173` | Comma-separated browser CORS origins |
| `VITE_API_BASE` | empty | Frontend build-time API origin; empty uses same-origin proxy |

Compose sets the database to `/app/data/eventlab.db` and defaults origins to localhost ports 8080 and 5173. Copy `.env.example` to `.env` to configure Compose. Native Uvicorn does **not** load `.env`; set environment variables in your shell. Vite variables are compiled into browser code: never place secrets in `VITE_*` values.

To generate a token:

```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

Set that value as `EVENTLAB_API_TOKEN`, restart the API, and enter it in **Conexão** in the dashboard. Changing the token invalidates old tokens immediately. The token is a shared lab gate, not account isolation.

## Storage and backups

The default named volume is `eventlab_eventlab-data`. Verify the actual name with `docker volume ls`; Compose project overrides can change it. Do not remove the volume to perform an ordinary restart.

SQLite uses WAL. Copying only the `.db` file while a writer runs is not a safe backup. Use SQLite's backup API, for example:

```bash
docker compose exec api python -c "import sqlite3; src=sqlite3.connect('/app/data/eventlab.db'); dst=sqlite3.connect('/app/data/backup.db'); src.backup(dst); dst.close(); src.close()"
docker compose cp api:/app/data/backup.db ./eventlab-backup.db
```

For a restore, stop the API, retain the existing data as a fallback, replace the database with a known-good backup, ensure file ownership permits UID 10001 to write, and restart. Test restored data in a separate lab first. JSON exports are an inspection format, not database backups or an import contract.

## Health and logs

- `/healthz`: the HTTP process responds.
- `/readyz`: database query works and the worker tick succeeded within ten seconds.
- A worker exception rolls back the tick, logs a traceback and makes readiness fail until a later successful tick.
- Use `docker compose logs -f api` to investigate backend failures.
- The journal captures experiment activity; process errors are in application logs.

```bash
docker compose ps
docker compose logs --tail=100 api
docker compose restart api
```

If startup reports **Use one Uvicorn worker per EventLab database**, another process owns the scheduler lock. Stop the duplicate process. Do not manually delete a lock file to defeat a live scheduler. The OS releases the lock when its owner exits.

## Reverse proxy and SSE

The supplied Nginx configuration disables response buffering and cache for the API, uses HTTP/1.1, and gives streams a one-hour read timeout. Heartbeats keep the connection active. When adding another proxy, preserve those properties and `Last-Event-ID`/Authorization headers. Configure TLS at the edge and explicitly allow your frontend origin when using a separate API origin.

The frontend uses a fetch stream for bearer authentication. It retries with bounded backoff, resumes from the last sequence and polls every five seconds as a fallback. A reconnect badge is expected during an API restart.

## Local reset

**Destructive: this removes every experiment in the default Compose volume. Back up first.**

```bash
docker compose down -v
docker compose up --build -d
```

In native mode, stop the API before removing its `data/` directory. Do not delete arbitrary paths supplied by someone else. There is no automatic retention or delete-run API in v1.

## Resource boundaries

Use fictional data and modest experiment sizes. There is a 500-order per-run cap, bounded tick batches, and a 5,000-delivery manual-duplication guard. The snapshot endpoint is intentionally a complete read model, not a paginated analytics API. The journal read endpoint supports cursor pagination and the UI shows the last 250 observations, while exports include all observations. No global rate limit, stream-connection quota or automatic database pruning exists.

Before exposing a shared instance, add infrastructure request/connection limits, TLS, authentication and an explicit data-retention plan. Do not scale replicas against the same SQLite file. This deployment is not designed for untrusted public tenants or real commerce.

## Dependency maintenance

`requirements.lock` and `requirements-dev.lock` pin Python resolution; `package-lock.json` pins the frontend. CI uses the lockfiles. Review dependency changes, regenerate both Python locks using `uv pip compile` and rerun validation after updates. The browser UI uses a Google Fonts stylesheet with system fallbacks; a font download is optional and does not gate application operation.

## Common issues

| Symptom | Action |
| --- | --- |
| Dashboard asks for a token | Match the API's token in **Conexão** |
| Order remains at Criado | Check direct-loss scenario, pending outbox, run pause and payment pause |
| Replay enters DLQ again | Clear payment failures with **Recuperar**, then replay |
| Latency change appears ineffective | Existing deliveries preserve their original due time; create another order |
| No live updates through a proxy | Disable buffering and inspect `/stream`; polling should still refresh |
| API startup fails on a mounted volume | Confirm writable directory ownership and local-filesystem locking |
| Port already in use | Stop the conflicting local process or change Compose's host port |
| Browser tests cannot download Chromium | Run them on a host with Playwright browser download access or inspect CI |
