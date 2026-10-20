# Validation record

This record describes verification performed during the initial implementation on 20 October 2026. Remote CI results are available in the repository's Actions tab and are authoritative for each subsequent commit.

## Passed locally

| Check | Result |
| --- | --- |
| Backend suite with locked dependencies, Python 3.12 | 23 tests passed |
| Frontend Vitest suite | 8 tests passed |
| TypeScript and Vite production build | Passed |
| Ruff static checks and formatting | Passed |
| Prettier formatting checks | Passed |
| npm dependency audit, including development dependencies | 0 reported vulnerabilities at validation time |
| Real HTTP SSE replay and authentication | Passed in backend integration suite |
| API + Vite reverse-proxy HTTP smoke | Passed: readiness, idempotency, pipeline and export |
| Batch experiment | 100 completed orders, 400 events, 300 effects and 300 deliveries |

Backend tests include happy path, causal linkage, due-time scheduling, exponential backoff, dead letters, replay generations, lost ACK, manual duplicates, pause/resume, persisted recovery, direct-publish loss, concurrent idempotency, transaction rollback, cross-run resource isolation, cursor reads, consistent export and singleton scheduler lifecycle.

Frontend tests cover authenticated request headers, actionable API errors, SSE heartbeats/chunk boundaries/deduplication, empty workspace, scenario selection, accessible error reporting and the experiment guide.

## Not verified locally

- **Chromium browser scenarios:** test servers started, but browser launch was blocked because Chromium was unavailable. A browser-download attempt failed with an invalid/truncated download. Both Playwright scenarios remain unverified locally; this is not recorded as an application assertion failure or a pass.
- **Visual screenshot QA:** not performed because a browser could not launch.
- **Docker image builds and Compose startup:** Docker is not installed in the implementation environment. Dockerfiles, health checks and smoke automation are supplied; the CI container job is responsible for executing them on a Docker host.
- **Python 3.11 and Node 22:** declared supported and covered by CI configuration; local execution used Python 3.12 and Node 24.

The CI workflow contains separate backend, frontend, browser and container jobs. Until those jobs finish successfully for a commit, do not infer that browser or container checks passed from the existence of configuration files.

## Reproduce

Follow the README's locked dependency installation steps, then run:

```bash
cd backend
../.venv/bin/python -m pytest -q
../.venv/bin/ruff check . ../scripts
../.venv/bin/ruff format --check . ../scripts
cd ../frontend
npm test
npm run build
npm run format:check
npm audit --audit-level=high
npx playwright install --with-deps chromium
npm run test:e2e
cd ..
docker compose up --build -d --wait
python scripts/smoke.py http://127.0.0.1:8080
```
