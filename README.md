# Custos

Automated code security review for university IT teams. Custos receives GitHub webhooks on push/PR events, clones the repository, runs static analysis (Semgrep, Gitleaks, pip-audit/npm-audit), feeds the results to a local LLM via Ollama, and surfaces prioritised findings in a dashboard where analysts can triage, annotate, and sign off.

```
GitHub → webhook → API → ARQ worker → SAST tools + Ollama → Dashboard
```

**Stack:** FastAPI · PostgreSQL · Redis · ARQ · React 18 · Vite · Ollama (local LLM)

---

## Table of contents

1. [Deploy (Docker)](#deploy-docker)
2. [Local development](#local-development)
3. [Managing users](#managing-users)
4. [Configuration reference](#configuration-reference)
5. [Ollama setup](#ollama-setup)
6. [SAST tool installation](#sast-tool-installation)
7. [GitHub webhook setup](#github-webhook-setup)

Everything goes through one launcher, `./custos`. It only needs `python3` to run and checks for everything else itself. Run `./custos --help` for all commands.

> **Ollama note:** Custos deliberately keeps the LLM local — no code leaves your infrastructure. Ollama must be running and reachable from the API/worker. See [Ollama setup](#ollama-setup).

---

## Deploy (Docker)

Requires Docker with Compose, and an Ollama instance.

```bash
git clone https://github.com/halicea7/CUSTOS.git
cd CUSTOS
./custos deploy
```

On first run this:

1. asks for your Ollama URL and model (Enter accepts the defaults),
2. writes `.env` with a generated `SECRET_KEY`, `ENCRYPTION_KEY` and database password (file mode 600),
3. builds the images (Semgrep, Gitleaks, pip-audit included) and starts everything; migrations run automatically,
4. creates the first admin account — choose a password, or leave it blank to generate one.

It finishes by printing the dashboard URL (port 3000) and the webhook URL to register on GitHub. Postgres and Redis are only reachable on the internal Docker network. Put a TLS reverse proxy in front before exposing Custos to the internet.

**Upgrading:** `git pull && ./custos deploy` — rebuilds, migrates, and keeps your existing `.env`.

**Back up `.env`.** Losing `ENCRYPTION_KEY` means re-entering every repo token.

Other commands: `./custos logs`, `./custos stop`. Add `--yes` (`./custos --yes deploy`) for an unattended install; a generated admin password is printed once.

---

## Local development

Requires Python 3.12+, Node.js 20+, PostgreSQL 16, Redis and git (on macOS: `brew install python@3.12 node postgresql@16 redis`).

```bash
./custos dev
```

The first run sets everything up, and later runs only redo what changed:

- creates `.venv` and installs Python and dashboard dependencies,
- installs Semgrep into the venv and Gitleaks via Homebrew (on Linux, install Gitleaks yourself — scans skip it otherwise),
- starts PostgreSQL if needed and creates the `Custos` role and database,
- writes `api/.env` with generated keys,
- runs migrations and creates your first admin account,

then opens the dev console, which runs Redis, the API, the worker and the dashboard with live reload:

| Service | URL |
|---|---|
| Dashboard | http://localhost:5173 |
| API | http://localhost:8000 |
| API docs (Swagger) | http://localhost:8000/docs |

Console keys: `n` toggle an ngrok tunnel for webhooks, `b` toggle binding to `0.0.0.0` (e.g. Tailscale), `r` restart all, `q` quit. Start with them on using `./custos dev --ngrok --bind-all`. Logs are also written to `.dev-logs/`.

`./custos setup` does the setup without starting the console. `./custos test` runs the test suite (integration tests use a separate `custos_test` database, skipped if it doesn't exist — create it with `createdb -O Custos custos_test`).

**Upgrading from an older checkout** whose `api/.env` has no `SECRET_KEY`: just run `./custos dev`. It generates the keys and re-encrypts your stored repo tokens, which were encrypted with the old default key. The previous file is kept as `api/.env.bak`.

---

## Managing users

Custos has two roles: `analyst` (triage findings, sign off) and `admin` (all analyst actions + Settings page + trigger self-scans). There is no self-registration — accounts are created from the shell:

```bash
./custos user add alice --role admin
./custos user add bob                  # analyst
./custos user reset alice              # new password
```

This works for both the Docker deployment and local setup (it detects which is running). Passwords are prompted for, or read from stdin when piped, so they never appear in shell history.

---

## Configuration reference

All settings are read from environment variables (or `api/.env` for local dev / `.env` at project root for Docker). `./custos` generates both files; edit them and restart to change settings.

| Variable | Required | Default | Description |
|---|---|---|---|
| `SECRET_KEY` | yes | — | JWT signing key, at least 32 chars. The API and worker **refuse to start** if it is unset or a known default |
| `ENCRYPTION_KEY` | recommended | `SECRET_KEY` | Encrypts stored GitHub tokens / webhook secrets. Keep it separate so `SECRET_KEY` can be rotated independently |
| `PREVIOUS_ENCRYPTION_KEYS` | no | — | Comma-separated old encryption keys, accepted for decryption during a rotation (see below) |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | no | `480` | Login session length |
| `DATABASE_URL` | yes | `postgresql+asyncpg://Custos:Custos@localhost:5432/Custos` | Async PostgreSQL connection string |
| `REDIS_URL` | yes | `redis://localhost:6379` | Redis connection string |
| `OLLAMA_BASE_URL` | yes | `http://localhost:11434` | Base URL for the Ollama API |
| `OLLAMA_MODEL` | yes | `qwen2.5-coder:32b` | Model name as it appears in `ollama list` |
| `SEMGREP_CONFIG` | no | `auto` | Semgrep ruleset. `auto` downloads rules from the Semgrep registry and requires sending usage metrics (never code); set a local rules path for fully offline scanning |
| `CLONE_BASE_DIR` | no | `/tmp/Custos_clones` | Temp directory for repository clones |
| `MAX_FILE_SIZE_KB` | no | `500` | Files larger than this are skipped by the LLM context builder |
| `MAX_FILES_PER_REPO` | no | `200` | Maximum number of files fed to the LLM per scan |

### Rotating the encryption key

Repo credentials are encrypted at rest. `./custos` handles the upgrade from older versions automatically. To change `ENCRYPTION_KEY` yourself without losing credentials:

1. Set the new key, and put the old one in `PREVIOUS_ENCRYPTION_KEYS`.
2. Run `python manage.py rotate-keys` from `api/` (Docker: `docker compose exec api python manage.py rotate-keys`).
3. Remove `PREVIOUS_ENCRYPTION_KEYS`.

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

Docker images and `./custos dev` install these for you (except Gitleaks on Linux); this section is for manual setups. The worker expects `semgrep`, `gitleaks`, and `pip-audit` to be available on `PATH`. Missing tools are logged as warnings and skipped — they do not cause scans to fail.

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

The `api/Dockerfile` installs Semgrep, Gitleaks, pip-audit, git and npm, so scans work out of the box in Docker.

---

## GitHub webhook setup

Custos listens for `push` and `pull_request` events at `POST /webhook/github`.

### 1. Create a GitHub Personal Access Token

Go to **GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens**.

Required permissions:
- **Contents:** Read-only
- **Checks:** Read and write

Enter the token when adding the repository on the dashboard's **Repos** page. Tokens are stored per repository, encrypted.

### 2. Register the webhook

In each repository (or once at the organisation level for all repos):

1. Go to **Settings → Webhooks → Add webhook**
2. **Payload URL:** `https://<your-host>/api/webhook/github` (Docker, via the dashboard proxy) or `http://<host>:8000/webhook/github` (API directly)
3. **Content type:** `application/json`
4. **Secret:** the webhook secret you entered for this repo on the **Repos** page
5. **Events:** select *Pushes* and *Pull requests*

### Local development (exposing the webhook)

Your local API needs to be reachable from GitHub. Use a tunnel:

```bash
# Option A — ngrok, built into the dev console (press n, or start with it on)
./custos dev --ngrok
# The console prints the webhook URL to use as the Payload URL

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
    --field "config[secret]=$WEBHOOK_SECRET" \
    --field "events[]=push" \
    --field "events[]=pull_request" \
    --field "active=true"
```

Or configure a single **organisation-level webhook** under **Organisation → Settings → Webhooks** — this covers all current and future repositories automatically.

---

## Useful commands

```bash
./custos --help                 # all launcher commands
./custos dev                    # local stack with live reload
./custos deploy                 # Docker deploy / upgrade
./custos logs | stop            # Docker logs / shutdown
./custos user add NAME          # create a login
./custos test                   # run tests (args pass through to pytest)

curl http://localhost:8000/healthz      # API health
docker compose down -v                  # Docker: stop and DELETE the database volume
```
