# Custos developer entry point. Run `make help` for the list of targets.
PYTHON  ?= python3
VENV     = .venv
BIN      = $(VENV)/bin
API_DIR  = api
PSQL    ?= $(shell command -v psql || echo /opt/homebrew/opt/postgresql@16/bin/psql)
TEST_DATABASE_URL ?= postgresql+asyncpg://custos:custos@localhost:5432/custos_test

.DEFAULT_GOAL := help

.PHONY: help
help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

# ── Setup ─────────────────────────────────────────────────────────────────────

.PHONY: setup venv install env
setup: ## First-time interactive setup (venv, database, .env, tools)
	bash wizard.sh

venv: ## Create the Python virtualenv
	$(PYTHON) -m venv $(VENV)

install: venv ## Install Python (dev) and dashboard dependencies
	$(BIN)/pip install -r $(API_DIR)/requirements-dev.txt
	cd dashboard && npm ci

env: ## Copy api/.env.example to api/.env
	cp -n $(API_DIR)/.env.example $(API_DIR)/.env
	@echo "Edit api/.env (SECRET_KEY, ENCRYPTION_KEY) before running make dev"

# ── Database ──────────────────────────────────────────────────────────────────

.PHONY: db migrate seed
db: ## Create the local Postgres role and database (run once)
	$(PSQL) postgres -c "CREATE USER \"Custos\" WITH PASSWORD 'Custos';" 2>/dev/null || true
	$(PSQL) postgres -c "CREATE DATABASE \"Custos\" OWNER \"Custos\";" 2>/dev/null || true

migrate: ## Apply database migrations
	$(BIN)/alembic upgrade head

seed: ## Create an admin user interactively
	@read -p "Username: " u; read -s -p "Password: " p; echo; \
	cd $(API_DIR) && ../$(BIN)/python create_user.py "$$u" "$$p" admin

# ── Run ───────────────────────────────────────────────────────────────────────

.PHONY: dev api worker up down logs
dev: ## Run the whole stack locally with the interactive console
	$(BIN)/python dev.py

api: ## Run only the API (auto-reload)
	cd $(API_DIR) && ../$(BIN)/uvicorn main:app --reload --host 127.0.0.1 --port 8000

worker: ## Run only the ARQ worker
	cd $(API_DIR) && ../$(BIN)/python -m arq worker.queue.WorkerSettings

up: ## Build and start the Docker stack (runs migrations first)
	docker compose up --build -d

down: ## Stop the Docker stack
	docker compose down

logs: ## Tail Docker logs
	docker compose logs -f --tail=100

# ── Quality ───────────────────────────────────────────────────────────────────

.PHONY: test lint fmt check-migrations build-dashboard
test: ## Run the API test suite (needs TEST_DATABASE_URL)
	cd $(API_DIR) && TEST_DATABASE_URL=$(TEST_DATABASE_URL) ../$(BIN)/pytest -q

lint: ## Lint Python (ruff) and the dashboard (eslint)
	$(BIN)/ruff check .
	cd dashboard && npm run lint

fmt: ## Auto-fix lint issues
	$(BIN)/ruff check . --fix

check-migrations: ## Fail if models and migrations have drifted
	$(BIN)/alembic check

build-dashboard: ## Production build of the dashboard
	cd dashboard && npm run build

.PHONY: health
health: ## Ping the local API
	curl -s http://localhost:8000/healthz
