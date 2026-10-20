# Contributing

Thank you for helping make event delivery guarantees easier to understand.

## Local workflow

1. Fork/clone and create a focused branch.
2. Install Python and frontend dependencies using the lockfiles in the README.
3. Add a failing test for a behavior change, then implement it.
4. Run backend tests, Ruff checks/format, frontend tests and production build.
5. Run Playwright if you change the experiment workflow or interface.
6. Update the relevant architecture/API/experiment documentation.

```bash
cd backend
../.venv/bin/python -m pytest -q
../.venv/bin/ruff check .
../.venv/bin/ruff format --check .
cd ../frontend
npm test
npm run build
npm run format:check
npm run test:e2e
```

Browser tests start their own servers. Their default launcher assumes a root `.venv` on POSIX; Windows contributors can use WSL or run the API and Vite manually, allowing Playwright to reuse them outside CI.

## Invariants to preserve

- Never perform a consumer effect outside the inbox/business/outbox transaction.
- Keep event IDs stable across retry and replay; duplicates are new deliveries, not new events.
- Scope all resource reads/writes to the requested run.
- Preserve the append-only journal and cursor replay semantics.
- Store money in integer cents and keep request bounds explicit.
- Do not claim external broker guarantees for the local simulator.
- Avoid real secrets or personal data in fixtures and exports.

## Pull requests

Describe the concrete before/after behavior, applicable guarantees and validation. Keep changes reviewable. Database schema changes require an explicit migration/compatibility plan and a backup/restore test. Major transport additions should begin with a design issue explaining failure windows, confirmation semantics and recovery.

Use [SECURITY.md](SECURITY.md) for vulnerability reporting rather than posting credentials or exploit details in a public issue.
