import asyncio
import json
import logging
import secrets
import time
from contextlib import asynccontextmanager, suppress
from uuid import UUID

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from filelock import FileLock, Timeout

from .config import Settings
from .engine import Conflict, Engine, Missing
from .models import FaultPatch, OrderCreate, RunCreate, RunPatch, Service
from .store import Store

log = logging.getLogger("eventlab")


def create_app(settings: Settings | None = None):
    settings = settings or Settings()
    engine = Engine(Store(settings.db_path))
    worker_state = {"last_tick": None, "error": None}

    async def worker():
        while True:
            try:
                await asyncio.to_thread(engine.tick)
                worker_state.update(last_tick=time.time(), error=None)
            except Exception:
                worker_state["error"] = "Worker tick failed"
                log.exception("worker_tick_failed")
            await asyncio.sleep(settings.tick_seconds)

    @asynccontextmanager
    async def lifespan(app):
        # One scheduler per database. File locks release automatically after process death.
        lock = None
        task = None
        if settings.worker_enabled:
            lock = FileLock(settings.db_path + ".worker.lock")
            try:
                lock.acquire(timeout=0)
            except Timeout as exc:
                raise RuntimeError("Use one Uvicorn worker per EventLab database") from exc
            task = asyncio.create_task(worker())
        try:
            yield
        finally:
            if task:
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task
            if lock:
                lock.release()

    app = FastAPI(
        title="EventLab API",
        version="1.0.0",
        lifespan=lifespan,
        description=(
            "Persistent event-driven systems laboratory. "
            "Local simulated transport; no real payments."
        ),
        openapi_tags=[
            {"name": n}
            for n in ("operations", "experiments", "orders", "delivery", "observability")
        ],
    )
    app.state.engine = engine
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.origins),
        allow_methods=["GET", "POST", "PATCH"],
        allow_headers=["Authorization", "Content-Type", "Idempotency-Key", "Last-Event-ID"],
    )

    def authorize(authorization: str | None = Header(default=None)):
        if settings.api_token and not secrets.compare_digest(
            authorization or "", "Bearer " + settings.api_token
        ):
            raise HTTPException(
                401, "Token de acesso necessário", headers={"WWW-Authenticate": "Bearer"}
            )

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(Missing)
    async def not_found(request, exc):
        return JSONResponse({"detail": str(exc)}, status_code=404)

    @app.exception_handler(Conflict)
    async def conflict(request, exc):
        return JSONResponse({"detail": str(exc)}, status_code=409)

    @app.get("/healthz", tags=["operations"])
    def health():
        return {"status": "ok", "version": "1.0.0"}

    @app.get("/readyz", tags=["operations"])
    def ready(response: Response):
        with engine.store.connect() as db:
            db.execute("SELECT 1")
        recent = worker_state["last_tick"]
        healthy = not settings.worker_enabled or (
            recent is not None and time.time() - recent < 10 and worker_state["error"] is None
        )
        if not healthy:
            response.status_code = 503
        return {
            "ready": healthy,
            "worker_enabled": settings.worker_enabled,
            "last_tick": recent,
            "error": worker_state["error"],
        }

    auth = [Depends(authorize)]

    @app.get("/api/runs", tags=["experiments"], dependencies=auth)
    def runs():
        return engine.list_runs()

    @app.post("/api/runs", status_code=201, tags=["experiments"], dependencies=auth)
    def new_run(data: RunCreate):
        return engine.create_run(data)

    @app.get("/api/runs/{run_id}", tags=["experiments"], dependencies=auth)
    def snapshot(run_id: UUID):
        return engine.snapshot(str(run_id))

    @app.patch("/api/runs/{run_id}", tags=["experiments"], dependencies=auth)
    def patch_run(run_id: UUID, data: RunPatch):
        return engine.patch_run(str(run_id), data.paused)

    @app.post("/api/runs/{run_id}/orders", tags=["orders"], dependencies=auth)
    def create_order(
        run_id: UUID,
        data: OrderCreate,
        response: Response,
        idempotency_key: str = Header(min_length=1, max_length=128),
    ):
        order, created = engine.create_order(str(run_id), data, idempotency_key)
        response.status_code = 201 if created else 200
        return order

    @app.patch("/api/runs/{run_id}/faults/{service}", tags=["experiments"], dependencies=auth)
    def fault(run_id: UUID, service: Service, data: FaultPatch):
        return engine.patch_fault(str(run_id), service.value, data)

    @app.post(
        "/api/runs/{run_id}/deliveries/{delivery_id}/replay", tags=["delivery"], dependencies=auth
    )
    def replay(run_id: UUID, delivery_id: UUID):
        return engine.replay(str(run_id), str(delivery_id))

    @app.post(
        "/api/runs/{run_id}/deliveries/{delivery_id}/duplicate",
        tags=["delivery"],
        dependencies=auth,
    )
    def duplicate(run_id: UUID, delivery_id: UUID):
        return engine.duplicate(str(run_id), str(delivery_id))

    @app.get("/api/runs/{run_id}/journal", tags=["observability"], dependencies=auth)
    def journal(run_id: UUID, after: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=500)):
        return engine.journal_after(str(run_id), after, limit)

    @app.get("/api/runs/{run_id}/export", tags=["observability"], dependencies=auth)
    def export(run_id: UUID):
        return JSONResponse(
            engine.export(str(run_id)),
            headers={
                "Content-Disposition": f'attachment; filename="eventlab-{run_id}.json"',
            },
        )

    @app.get("/api/runs/{run_id}/stream", tags=["observability"], dependencies=auth)
    async def stream(
        request: Request,
        run_id: UUID,
        after: int = Query(0, ge=0),
        last_event_id: str | None = Header(default=None),
    ):
        run = str(run_id)
        await asyncio.to_thread(engine.journal_after, run, 0, 1)
        cursor = after
        if last_event_id is not None:
            try:
                received_cursor = int(last_event_id)
                if received_cursor < 0:
                    raise ValueError
                cursor = max(cursor, received_cursor)
            except ValueError:
                raise HTTPException(400, "Last-Event-ID deve ser um inteiro não negativo") from None

        async def generate():
            nonlocal cursor
            heartbeat = time.monotonic()
            yield "retry: 1500\n\n"
            while not await request.is_disconnected():
                rows = await asyncio.to_thread(engine.journal_after, run, cursor, 100)
                for row in rows:
                    cursor = row["seq"]
                    yield f"id: {cursor}\nevent: journal\ndata: {json.dumps(row)}\n\n"
                if time.monotonic() - heartbeat > 10:
                    yield ": heartbeat\n\n"
                    heartbeat = time.monotonic()
                await asyncio.sleep(0.3)

        return StreamingResponse(
            generate(),
            media_type="text/event-stream",
            headers={
                "X-Accel-Buffering": "no",
                "Cache-Control": "no-cache",
            },
        )

    return app


# Factory invocation avoids creating database files on module import.
# Start with: uvicorn eventlab.main:create_app --factory --host 0.0.0.0 --port 8000
