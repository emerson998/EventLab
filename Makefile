.PHONY: up down logs test backend-test frontend-test build
up:
	docker compose up --build -d

down:
	docker compose down

logs:
	docker compose logs -f

backend-test:
	cd backend && ../.venv/bin/python -m pytest -q

frontend-test:
	cd frontend && npm test

test: backend-test frontend-test

build:
	cd frontend && npm run build
