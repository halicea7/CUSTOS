PYTHON  ?= python3
API_DIR  = api
VENV     = .venv
PSQL    ?= $(shell command -v psql || echo /opt/homebrew/opt/postgresql@16/bin/psql)

# ── Environment ───────────────────────────────────────────────────────────────

.PHONY: venv install

venv:
	$(PYTHON) -m venv $(VENV)
	@echo "Activate with: source $(VENV)/bin/activate"

install:
	pip install -r $(API_DIR)/requirements.txt

env:
	cp $(API_DIR)/.env.example $(API_DIR)/.env
	@echo "Edit api/.env before running make dev"

# ── Database ──────────────────────────────────────────────────────────────────

.PHONY: db migrate seed

# Create the local Postgres role and database (run once).
db:
	$(PSQL) postgres -c "CREATE USER \"Custos\" WITH PASSWORD 'Custos';" 2>/dev/null || true
	$(PSQL) postgres -c "CREATE DATABASE \"Custos\" OWNER \"Custos\";" 2>/dev/null || true

migrate:
	alembic upgrade head

seed:
	@read -p "Username: " u; read -s -p "Password: " p; echo; \
	cd $(API_DIR) && $(PYTHON) create_user.py "$$u" "$$p" admin

# ── Dev server ────────────────────────────────────────────────────────────────

.PHONY: dev worker

dev:
	cd $(API_DIR) && uvicorn main:app --reload --host 127.0.0.1 --port 8000

worker:
	cd $(API_DIR) && python -m arq worker.queue.WorkerSettings

# ── Helpers ───────────────────────────────────────────────────────────────────

.PHONY: health

health:
	curl -s http://localhost:8000/health | python3 -m json.tool
