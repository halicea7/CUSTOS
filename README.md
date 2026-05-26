# Custos

Automated code security review for university IT teams. Custos receives GitHub webhooks on push/PR events, clones the repository, runs static analysis (Semgrep, Gitleaks, pip-audit/npm-audit), feeds the results to a local LLM via Ollama, and surfaces prioritised findings in a dashboard where analysts can triage, annotate, and sign off.

```
GitHub → webhook → API → ARQ worker → SAST tools + Ollama → Dashboard
```

**Stack:** FastAPI · PostgreSQL · Redis · ARQ · React 18 · Vite · Ollama (local LLM)

---

## Table of contents

1. [Prerequisites](#prerequisites)
2. [Quick start — Docker](#quick-start--docker)
3. [Local development setup](#local-development-setup)
4. [Configuration reference](#configuration-reference)
5. [Ollama setup](#ollama-setup)
6. [SAST tool installation](#sast-tool-installation)
7. [GitHub webhook setup](#github-webhook-setup)
8. [Creating users](#creating-users)
9. [Useful commands](#useful-commands)

---

## Prerequisites

| Requirement | Docker path | Local path |
|---|---|---|
| Docker + Docker Compose | required | — |
| Python 3.12+ | — | required |
| Node.js 20+ | — | required |
| PostgreSQL 16 | provided by compose | required |
| Redis 7 | provided by compose | required |
| Ollama | running separately | running separately |
| Semgrep | add to Dockerfile | install on host |
| Gitleaks | add to Dockerfile | install on host |
| pip-audit | add to Dockerfile | install on host |

> **Ollama note:** Custos deliberately keeps the LLM local — no code leaves your infrastructure. Ollama must be running and reachable on a host or VM accessible to the API/worker process. See [Ollama setup](#ollama-setup).

---

## Quick start — Docker

### 1. Clone and configure

```bash
git clone https://github.com/halicea7/CUSTOS.git
cd CUSTOS

# Create the .env file at the project root (used by docker-compose)
cp api/.env.example .env
```

Edit `.env` and fill in the required values. For Docker, the service hostnames are `postgres` and `redis` (not `localhost`):

```bash
# .env (project root, for Docker)
SECRET_KEY=<run: python3 -c "import secrets; print(secrets.token_hex(32))">
DATABASE_URL=postgresql+asyncpg://Custos:Custos@postgres:5432/Custos
REDIS_URL=redis://redis:6379
OLLAMA_BASE_URL=http://host.docker.internal:11434   # or your Ollama host
OLLAMA_MODEL=qwen2.5-coder:32b
GITHUB_WEBHOOK_SECRET=<your-webhook-secret>
GITHUB_TOKEN=<ghp_your_token>
```

### 2. Start services

```bash
docker compose up --build -d
```

This starts: PostgreSQL, Redis, API (port 8000), ARQ worker, and Dashboard (port 3000).

### 3. Run database migrations

Migrations run from the project root using the Python venv (the alembic directory lives outside the Docker image). If you haven't set up the venv yet, do it once:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r api/requirements.txt
```

Then run migrations against the Docker Postgres (exposed on localhost:5432):

```bash
# Temporarily point at localhost for the migration run
DATABASE_URL=postgresql+asyncpg://Custos:Custos@localhost:5432/Custos \
  alembic upgrade head
```

### 4. Create the first admin user

```bash
source .venv/bin/activate
cd api
python create_user.py admin yourpassword admin
cd ..
```

### 5. Open the dashboard

```
http://localhost:3000
```

Log in with the credentials you just created.

---

## Local development setup

This path runs everything on your host machine with hot reload for the API and dashboard.

### 1. Clone and set up Python environment

```bash
git clone https://github.com/halicea7/CUSTOS.git
cd CUSTOS

python3 -m venv .venv
source .venv/bin/activate
pip install -r api/requirements.txt
```

### 2. Start PostgreSQL and Redis

If you use Homebrew on macOS:

```bash
brew install postgresql@16 redis
brew services start postgresql@16
brew services start redis
```

Or start them manually however you prefer.

### 3. Create the database

```bash
make db
# equivalent to:
# psql postgres -c "CREATE USER \"Custos\" WITH PASSWORD 'Custos';"
# psql postgres -c "CREATE DATABASE \"Custos\" OWNER \"Custos\";"
```

### 4. Configure

```bash
cp api/.env.example api/.env
```

Edit `api/.env`. For local dev, leave `DATABASE_URL` and `REDIS_URL` pointing at `localhost`:

```bash
# api/.env
SECRET_KEY=<run: python3 -c "import secrets; print(secrets.token_hex(32))">
DATABASE_URL=postgresql+asyncpg://Custos:Custos@localhost:5432/Custos
REDIS_URL=redis://localhost:6379
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5-coder:32b
GITHUB_WEBHOOK_SECRET=<your-webhook-secret>
GITHUB_TOKEN=<ghp_your_token>
```

### 5. Run migrations

```bash
alembic upgrade head
```

### 6. Create the first admin user

```bash
cd api
python create_user.py admin yourpassword admin
cd ..
```

### 7. Install SAST tools

See [SAST tool installation](#sast-tool-installation).

### 8. Start everything

The `dev.sh` script launches the API, ARQ worker, and Vite dev server together, tails all logs to your terminal, and shuts down cleanly on Ctrl+C:

```bash
./dev.sh
```

Services will be available at:

| Service | URL |
|---|---|
| Dashboard | http://localhost:5173 |
| API | http://localhost:8000 |
| API docs (Swagger) | http://localhost:8000/docs |

Alternatively, start each piece manually in separate terminals:

```bash
# Terminal 1 — API
cd api && uvicorn main:app --reload --host 127.0.0.1 --port 8000

# Terminal 2 — ARQ worker
cd api && python -m arq worker.queue.WorkerSettings

# Terminal 3 — Dashboard
cd dashboard && npm run dev
```

---

## Configuration reference

All settings are read from environment variables (or `api/.env` for local dev / `.env` at project root for Docker).

| Variable | Required | Default | Description |
|---|---|---|---|
| `SECRET_KEY` | yes | `changeme` | JWT signing key — **must be changed in production** |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | no | `480` | Login session length |
| `DATABASE_URL` | yes | `postgresql+asyncpg://Custos:Custos@localhost:5432/Custos` | Async PostgreSQL connection string |
| `REDIS_URL` | yes | `redis://localhost:6379` | Redis connection string |
| `OLLAMA_BASE_URL` | yes | `http://localhost:11434` | Base URL for the Ollama API |
| `OLLAMA_MODEL` | yes | `qwen2.5-coder:32b` | Model name as it appears in `ollama list` |
| `GITHUB_WEBHOOK_SECRET` | yes | — | Shared secret for HMAC webhook validation |
| `GITHUB_TOKEN` | yes | — | PAT with `Contents: Read` and `Checks: Write` scopes |
| `CLONE_BASE_DIR` | no | `/tmp/Custos_clones` | Temp directory for repository clones |
| `MAX_FILE_SIZE_KB` | no | `500` | Files larger than this are skipped by the LLM context builder |
| `MAX_FILES_PER_REPO` | no | `200` | Maximum number of files fed to the LLM per scan |

Additional runtime settings (editable through the dashboard Settings page):

| Key | Description |
|---|---|
| `ollama_model` | Override the default model at runtime |
| `ollama_num_ctx` | Context window size in tokens (0 = use Modelfile default) |
| `ollama_think` | Enable extended thinking for supported models |
| `llm_max_content_chars` | Maximum characters of source code sent per LLM call |

---

## Ollama setup

Custos requires a running [Ollama](https://ollama.com) instance accessible from the API and worker processes. No code is sent to any external service.

### Install Ollama

```bash
# macOS
brew install ollama

# Linux
curl -fsSL https://ollama.com/install.sh | sh
```

### Pull a model

```bash
ollama pull qwen2.5-coder:32b
```

Any code-focused model works. Larger models produce better findings. Recommended minimum: 7B parameters. The model name in `OLLAMA_MODEL` must exactly match the output of `ollama list`.

### Custom context size

If you want a larger context window than the model default, either create a custom Modelfile:

```
# Modelfile
FROM qwen2.5-coder:32b
PARAMETER num_ctx 32768
```

```bash
ollama create qwen2.5-coder-32k -f Modelfile
```

Or set `ollama_num_ctx` in the dashboard Settings page (overrides the Modelfile default for each call).

---

## SAST tool installation

The worker expects `semgrep`, `gitleaks`, and `pip-audit` to be available on `PATH`. Missing tools are logged as warnings and skipped — they do not cause scans to fail.

### Semgrep

```bash
pip install semgrep
```

### Gitleaks

```bash
# macOS
brew install gitleaks

# Linux — download from GitHub releases
GITLEAKS_VERSION=8.18.4
curl -sSfL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" \
  | tar -xz -C /usr/local/bin gitleaks
```

### pip-audit

```bash
pip install pip-audit
```

### Docker note

The provided `api/Dockerfile` does not install SAST tools. To enable scanning inside Docker, add the following to `api/Dockerfile` before the `CMD` line:

```dockerfile
RUN pip install semgrep pip-audit && \
    curl -sSfL https://github.com/gitleaks/gitleaks/releases/download/v8.18.4/gitleaks_8.18.4_linux_x64.tar.gz \
    | tar -xz -C /usr/local/bin gitleaks
```

---

## GitHub webhook setup

Custos listens for `push` and `pull_request` events at `POST /webhook/github`.

### 1. Create a GitHub Personal Access Token

Go to **GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens**.

Required permissions:
- **Contents:** Read-only
- **Checks:** Read and write

Set `GITHUB_TOKEN` in your `.env` to the generated token.

### 2. Register the webhook

In each repository (or once at the organisation level for all repos):

1. Go to **Settings → Webhooks → Add webhook**
2. **Payload URL:** `https://<your-host>/webhook/github`
3. **Content type:** `application/json`
4. **Secret:** same value as `GITHUB_WEBHOOK_SECRET` in your `.env`
5. **Events:** select *Pushes* and *Pull requests*

### Local development (exposing the webhook)

Your local API needs to be reachable from GitHub. Use a tunnel:

```bash
# Option A — ngrok
ngrok http 8000
# Use the https://xxxx.ngrok.io URL as your webhook Payload URL

# Option B — smee.io (no account required)
npm install -g smee-client
smee --url https://smee.io/<your-channel> --target http://localhost:8000/webhook/github
```

With smee, create a channel at https://smee.io/new, then use that URL as the Payload URL on GitHub.

### Applying the webhook to all repositories in an organisation

If you manage many repos, use the GitHub CLI to register the webhook in bulk:

```bash
gh repo list YOUR_ORG --limit 200 --json nameWithOwner -q '.[].nameWithOwner' | \
  xargs -I{} gh api repos/{}/hooks \
    --method POST \
    --field "name=web" \
    --field "config[url]=https://<your-host>/webhook/github" \
    --field "config[content_type]=json" \
    --field "config[secret]=$GITHUB_WEBHOOK_SECRET" \
    --field "events[]=push" \
    --field "events[]=pull_request" \
    --field "active=true"
```

Or configure a single **organisation-level webhook** under **Organisation → Settings → Webhooks** — this covers all current and future repositories automatically.

---

## Creating users

Custos has two roles: `analyst` (triage findings, sign off) and `admin` (all analyst actions + Settings page + trigger self-scans).

```bash
# From the api/ directory with the venv active:
python create_user.py <username> <password> [role]

# Examples
python create_user.py alice password123 admin
python create_user.py bob  password456 analyst
```

There is no self-registration endpoint — all accounts are created by a shell-level admin.

---

## Useful commands

```bash
# Start full dev stack (API + worker + dashboard + Redis)
./dev.sh

# Run database migrations
alembic upgrade head

# Check API health
curl http://localhost:8000/healthz

# Interactive API docs
open http://localhost:8000/docs

# Create a user
cd api && python create_user.py <user> <pass> <role>

# Tail dev logs
tail -f .dev-logs/api.log .dev-logs/worker.log .dev-logs/dashboard.log

# Build the dashboard for production
cd dashboard && npm run build

# Docker: rebuild and restart
docker compose up --build -d

# Docker: view logs
docker compose logs -f api worker

# Docker: stop everything
docker compose down

# Docker: stop and remove the database volume
docker compose down -v
```
