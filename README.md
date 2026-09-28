# Custos

Automated code security review for university IT teams. Custos receives GitHub webhooks on push/PR events, fetches the commit, runs static analysis (Semgrep, Gitleaks, pip-audit/npm-audit), feeds the results to a local LLM via Ollama, and surfaces prioritised findings in a dashboard where analysts can triage, annotate, and sign off.

```
GitHub → webhook → API → ARQ worker → SAST tools + Ollama → Dashboard
                                   ↘ GitHub check run (one per commit, updated in place)
```

**Stack:** FastAPI · PostgreSQL · Redis · ARQ · React 18 · TanStack Query · Vite · Ollama (local LLM)

---

## Table of contents

1. [Prerequisites](#prerequisites)
2. [Quick start — Docker](#quick-start--docker)
3. [Local development setup](#local-development-setup)
4. [Configuration reference](#configuration-reference)
5. [Ollama setup](#ollama-setup)
6. [SAST tools](#sast-tools)
7. [Connecting repositories](#connecting-repositories)
8. [Users and access](#users-and-access)
9. [Security model](#security-model)
10. [Testing and CI](#testing-and-ci)
11. [Useful commands](#useful-commands)

---

## Prerequisites

| Requirement | Docker path | Local path |
|---|---|---|
| Docker + Docker Compose | required | — |
| Python 3.11+ | — | required |
| Node.js 20+ | — | required |
| PostgreSQL 16 | provided by compose | required |
| Redis 7 | provided by compose | required |
| Ollama | running separately | running separately |
| git, Semgrep, Gitleaks, pip-audit | baked into the worker image | install on host (`make setup` offers to) |

> **Ollama note:** Custos deliberately keeps the LLM local — no code leaves your infrastructure. Ollama must be reachable from the worker. See [Ollama setup](#ollama-setup).

---

## Quick start — Docker

### 1. Configure

```bash
git clone https://github.com/halicea7/CUSTOS.git
cd CUSTOS
cp api/.env.example .env
```

Fill in the secrets in `.env`:

```bash
SECRET_KEY=<python3 -c "import secrets; print(secrets.token_hex(32))">
ENCRYPTION_KEY=<python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())">
POSTGRES_PASSWORD=<any strong password>
REDIS_PASSWORD=<any strong password>
OLLAMA_BASE_URL=http://host.docker.internal:11434   # or your Ollama host
OLLAMA_MODEL=qwen2.5-coder:32b
```

`DATABASE_URL` and `REDIS_URL` are assembled by compose from the passwords above; you don't set them for Docker.

### 2. Start

```bash
docker compose up --build -d      # or: make up
```

This starts PostgreSQL, Redis (password-protected, internal only), a one-shot `migrate` service that runs `alembic upgrade head`, the API (bound to `127.0.0.1:8000`), the worker (with git and all scanners installed), and the dashboard on port 3000. The API and worker wait for migrations to finish.

### 3. Create the first admin user

```bash
docker compose exec api python create_user.py admin '<password>' admin
```

### 4. Open the dashboard

`http://localhost:3000` — the dashboard's nginx proxies `/api/` to the API and is the only public entry point. Put TLS in front of it for anything beyond a laptop.

---

## Local development setup

```bash
git clone https://github.com/halicea7/CUSTOS.git
cd CUSTOS
make setup        # interactive wizard: venv, deps, database, api/.env, scanners, migrations
make seed         # create an admin user
make dev          # API + worker + Redis + Vite with a live log console
```

`make help` lists every target. Doing it by hand:

```bash
make install                      # .venv + api/requirements-dev.txt + dashboard npm ci
make db                           # create the local Postgres role/database
make env                          # copy api/.env.example → api/.env, then fill in SECRET_KEY / ENCRYPTION_KEY
make migrate                      # alembic upgrade head
make api | make worker            # run pieces individually
cd dashboard && npm run dev       # dashboard with HMR
```

The dev console (`./dev.py`) also toggles an ngrok tunnel (`n`) for receiving real webhooks and binding to `0.0.0.0` (`b`) for Tailscale access.

| Service | URL |
|---|---|
| Dashboard | http://localhost:5173 |
| API | http://localhost:8000 |
| API docs (Swagger) | http://localhost:8000/docs |

---

## Configuration reference

Settings are read from environment variables (`api/.env` for local dev, `.env` at the project root for Docker).

| Variable | Required | Default | Description |
|---|---|---|---|
| `SECRET_KEY` | yes | — | Signs login JWTs. The API and worker **refuse to start** if it is a known default or shorter than 32 characters. |
| `ENCRYPTION_KEY` | yes | — | Fernet key encrypting stored GitHub tokens and webhook secrets. Comma-separate keys to rotate (first encrypts, all decrypt), then run `python api/rotate_encryption.py`. |
| `ALLOW_INSECURE_DEFAULTS` | no | `false` | Local development only: start with a weak `SECRET_KEY` (logs a warning). |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | no | `480` | Login session length |
| `DATABASE_URL` | yes | local Postgres | Async PostgreSQL connection string |
| `REDIS_URL` | yes | `redis://localhost:6379` | Full Redis URL; password, db number and `rediss://` are honoured |
| `OLLAMA_BASE_URL` | yes | `http://localhost:11434` | Base URL for the Ollama API |
| `OLLAMA_MODEL` | yes | `qwen2.5-coder:32b` | Model name as it appears in `ollama list` |
| `LLM_MAX_BATCHES` | no | `4` | Extra prompts per submission when a repo exceeds one prompt's budget |
| `LLM_CONCURRENCY` | no | `1` | Batches in flight at once (match Ollama's `OLLAMA_NUM_PARALLEL`) |
| `LLM_TIMEOUT_SECONDS` | no | `600` | Per-request timeout for Ollama |
| `SEMGREP_CONFIG` | no | `p/default` | Comma-separated Semgrep rulesets (registry names or local paths). Metrics are always off. |
| `CLONE_BASE_DIR` | no | `/tmp/Custos_clones` | Temp directory for checkouts |
| `MAX_FILE_SIZE_KB` | no | `500` | Default for the Settings page value of the same name |
| `MAX_FILES_PER_REPO` | no | `200` | Default for the Settings page value of the same name |
| `STALE_JOB_MINUTES` | no | `60` | Jobs stuck "analyzing" longer than this are marked as errored |
| `LOGIN_MAX_ATTEMPTS` / `LOGIN_WINDOW_SECONDS` | no | `10` / `300` | Failed-login rate limit per username + IP |
| `POSTGRES_PASSWORD` / `REDIS_PASSWORD` | Docker | — | Credentials for the bundled services |

Runtime settings editable on the dashboard **Settings → Analysis** page (stored in the database, override the env defaults):

| Key | Takes effect |
|---|---|
| `ollama_base_url`, `ollama_model`, `ollama_num_ctx`, `ollama_think` | next job |
| `llm_max_content_chars` — characters of source per LLM prompt | next job |
| `max_file_size_kb`, `max_files_per_repo` — LLM file selection limits | next job |
| `access_token_expire_minutes` | next login |
| `worker_max_jobs`, `worker_job_timeout` | next worker restart |

---

## Ollama setup

```bash
brew install ollama                                  # macOS
curl -fsSL https://ollama.com/install.sh | sh        # Linux
ollama pull qwen2.5-coder:32b
```

Any code-focused model works; larger models produce better findings (recommended minimum: 7B). Custos uses Ollama's structured outputs (a JSON schema in the `format` field, Ollama ≥ 0.5) so responses always parse; older servers automatically fall back to plain JSON mode.

For a larger context window, either set `ollama_num_ctx` on the Settings page or bake it into a Modelfile:

```
FROM qwen2.5-coder:32b
PARAMETER num_ctx 32768
```

If the LLM is unreachable or returns garbage, the run is recorded as **failed** (visible under *LLM details* on the submission) and the submission still lands in the queue with its static-analysis findings, flagged with a note. Use **Re-run LLM** once Ollama is back.

---

## SAST tools

The worker runs `semgrep`, `gitleaks`, `pip-audit` and `npm audit`, each with a timeout. A missing tool is logged and skipped. In Docker they are all installed in the `worker` image target; on a host, `make setup` offers to install them, or:

```bash
pip install semgrep pip-audit
brew install gitleaks   # or download a release binary from github.com/gitleaks/gitleaks
```

---

## Connecting repositories

Repositories are connected from the dashboard **Repos → Add repository** wizard. Each repo has its own GitHub token and webhook secret, stored encrypted.

1. Create a fine-grained PAT with **Contents: Read** and **Checks: Read and write** on the repo.
2. In the wizard, paste the token (it is validated against the GitHub API) and copy the generated webhook secret.
3. In the repo on GitHub: **Settings → Webhooks → Add webhook**
   - Payload URL: `https://<your-host>/api/webhook/github` (Docker) or `http://localhost:8000/webhook/github` behind a tunnel (local)
   - Content type: `application/json`, Secret: the generated secret
   - Events: *Pushes* and *Pull requests*

Custos posts one **Custos Security Review** check run per commit and updates it as analysis progresses: `action_required` when critical/high findings exist (or the LLM phase failed), `neutral` otherwise, `failure` if analysis errored, and `success` once an analyst signs off.

For local development, expose the API with the dev console's ngrok toggle or with [smee.io](https://smee.io).

---

## Users and access

Two roles: `analyst` and `admin`.

- **Admins** see everything, manage users, groups and analysis settings, and trigger self-scans.
- **Analysts** see only repositories they added or that belong to a group they are a member of. This applies to every endpoint — submissions, findings, audit logs, re-runs and sign-off. Anything outside that set returns 404.

```bash
cd api && ../.venv/bin/python create_user.py <username> <password> [admin|analyst]
cd api && ../.venv/bin/python reset_password.py <username> <new-password>
```

There is no self-registration.

---

## Security model

Custos analyses untrusted code, so the worker treats every repository as hostile:

- **Credentials never touch the checkout.** Commits are fetched with a depth-1 fetch of the exact SHA. The GitHub token is passed to git as an HTTP header via `GIT_CONFIG_*` environment variables, so it is not in the remote URL, `.git/config`, the process list or error messages. Stored errors are additionally scrubbed of anything credential-shaped.
- **No repo-controlled execution.** Git hooks are disabled and the `file://` protocol is blocked; `pip-audit` runs with `--no-deps` (no package builds); `npm audit` is pinned to the public registry so a hostile `.npmrc` can't redirect it.
- **No escaping the checkout.** Files sent to the LLM must be regular files inside the checkout; symlinks are never followed (so a repo can't exfiltrate e.g. `/app/.env` through the model).
- **Prompt injection.** The system prompt is fixed in code and instructs the model to ignore instructions embedded in the source.
- **Rendering.** Code snippets are always HTML-escaped (via highlight.js or an explicit escape) before display; nginx sends a strict Content-Security-Policy.
- **Secrets at rest.** Repo tokens and webhook secrets are encrypted with `ENCRYPTION_KEY` (separate from the JWT key, rotatable).
- **Webhooks.** HMAC-SHA256 verified per repo; unknown repos and bad signatures get an identical response; redeliveries are de-duplicated.

---

## Testing and CI

```bash
# Tests need a PostgreSQL database; for example:
docker run -d -p 5432:5432 -e POSTGRES_USER=custos -e POSTGRES_PASSWORD=custos \
  -e POSTGRES_DB=custos_test postgres:16-alpine

make test               # pytest (API, access control, webhook, worker pipeline, parsers)
make lint               # ruff + eslint
make check-migrations   # fail if models and migrations have drifted
```

GitHub Actions (`.github/workflows/ci.yml`) runs lint, the test suite against Postgres, a full migration up/down round-trip with `alembic check`, the dashboard lint + build, and builds all three Docker images.

---

## Useful commands

```bash
make dev                  # full local stack with live logs
make migrate              # alembic upgrade head
make health               # curl the API health endpoint
make up | down | logs     # Docker stack
docker compose down -v    # stop and delete the database volume
```
