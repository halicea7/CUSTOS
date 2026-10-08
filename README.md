# Custos

Automated code security review for university IT teams. Custos receives GitHub webhooks on push/PR events, fetches the commit, runs static analysis (Semgrep, Gitleaks, pip-audit/npm-audit), feeds the results to an LLM (a local Ollama model by default, or any OpenAI Responses API-compatible service), and surfaces prioritised findings in a dashboard where analysts can triage, annotate, and sign off.

```
GitHub → webhook → API → ARQ worker → SAST tools + Ollama → Dashboard
                                   ↘ GitHub check run (one per commit, updated in place)
```

**Stack:** FastAPI · PostgreSQL · Redis · ARQ · React 18 · TanStack Query · Vite · Ollama (local LLM) or any Responses API (`/v1/responses`) provider

---

## Table of contents

1. [Prerequisites](#prerequisites)
2. [Quick start — Docker](#quick-start--docker)
3. [Local development setup](#local-development-setup)
4. [Configuration reference](#configuration-reference)
5. [Ollama setup](#ollama-setup)
6. [Responses API provider](#responses-api-provider)
7. [SAST tools](#sast-tools)
8. [Connecting repositories](#connecting-repositories)
9. [Users and access](#users-and-access)
10. [Security model](#security-model)
11. [Testing and CI](#testing-and-ci)
12. [Useful commands](#useful-commands)

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
| git, Semgrep, Gitleaks, pip-audit | baked into the worker image | `./custos dev` installs Semgrep/pip-audit (and Gitleaks via Homebrew) |

Everything goes through one launcher, **`./custos`** (`./custos --help`). It needs only `python3` to run and checks for everything else itself.

> **LLM note:** by default Custos keeps the LLM local with Ollama, so no code leaves your infrastructure; Ollama must be reachable from the worker ([Ollama setup](#ollama-setup)). You can instead point it at a hosted or self-hosted model over the OpenAI Responses API ([Responses API provider](#responses-api-provider)) — in that case **the code under review is sent to that provider**.

---

## Quick start — Docker

```bash
git clone https://github.com/halicea7/CUSTOS.git
cd CUSTOS
./custos deploy
```

On first run this asks for your Ollama URL and model (Enter accepts the defaults), then:

1. writes `.env` (mode 600) with a generated `SECRET_KEY`, `ENCRYPTION_KEY`, `POSTGRES_PASSWORD` and `REDIS_PASSWORD`. `DATABASE_URL`/`REDIS_URL` are assembled by compose;
2. builds and starts PostgreSQL and Redis (password-protected, internal only), a one-shot `migrate` service, the API (bound to `127.0.0.1:8000`), the worker (git and all scanners installed) and the dashboard on port 3000;
3. creates the first admin — choose a password, or leave it blank to have one generated.

It prints the dashboard and webhook URLs when done. The dashboard's nginx proxies `/api/` to the API and is the only public entry point. Put TLS in front of it for anything beyond a laptop.

- **Upgrade:** `git pull && ./custos deploy` (rebuilds, migrates, keeps `.env`).
- **Back up `.env`:** losing `ENCRYPTION_KEY` means re-entering every repo token.
- **Unattended:** `./custos --yes deploy` (a generated admin password is printed once).
- `./custos logs`, `./custos stop`.

---

## Local development setup

Requires Python 3.11+, Node.js 20+, PostgreSQL 16, Redis and git (macOS: `brew install python node postgresql@16 redis`).

```bash
./custos dev                  # add --ngrok and/or --bind-all to start with those on
```

The first run sets everything up, and later runs only redo what changed:

- `.venv` and Python and dashboard dependencies;
- Semgrep and pip-audit (plus Gitleaks via Homebrew);
- starts PostgreSQL if needed and creates the `Custos` role and database;
- `api/.env` with generated keys;
- migrations and your first admin.

Then it opens the live dev console, which runs Redis, the API, the worker and Vite. Console keys: `n` ngrok tunnel for real webhooks, `b` bind to `0.0.0.0` (e.g. Tailscale), `r` restart, `q` quit. Logs also go to `.dev-logs/`. `./custos setup` does the setup without starting the console.

**Upgrading an older checkout** whose `api/.env` has no keys: just run `./custos dev`. It generates them and moves stored repo tokens (encrypted under the old default key) to the new `ENCRYPTION_KEY`. The previous file is kept as `api/.env.bak`.

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
| `ENCRYPTION_KEY` | yes | — | Fernet key encrypting stored GitHub tokens and webhook secrets. Generated by `./custos`. To rotate, prepend a new key (comma-separated; first encrypts, all decrypt), run `python manage.py rotate-keys` in `api/` (Docker: `docker compose exec api python manage.py rotate-keys`), then drop the old key. |
| `ALLOW_INSECURE_DEFAULTS` | no | `false` | Local development only: start with a weak `SECRET_KEY` (logs a warning). |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | no | `480` | Login session length |
| `DATABASE_URL` | yes | local Postgres | Async PostgreSQL connection string |
| `REDIS_URL` | yes | `redis://localhost:6379` | Full Redis URL; password, db number and `rediss://` are honoured |
| `OLLAMA_BASE_URL` | yes | `http://localhost:11434` | Base URL for the Ollama API |
| `OLLAMA_MODEL` | yes | `qwen2.5-coder:32b` | Model name as it appears in `ollama list` |
| `LLM_PROVIDER` | no | `ollama` | `ollama`, or `responses` for an OpenAI Responses API server |
| `RESPONSES_BASE_URL` | no | `https://api.openai.com/v1` | Responses API base; requests go to `{base}/responses` |
| `RESPONSES_MODEL` | with `responses` | — | Model name at that provider |
| `RESPONSES_API_KEY` | with `responses` | — | Bearer API key. A key saved on the Settings page (stored encrypted) takes precedence |
| `LLM_MAX_BATCHES` | no | `4` | Extra prompts per submission when a repo exceeds one prompt's budget |
| `LLM_CONCURRENCY` | no | `1` | Batches in flight at once (match Ollama's `OLLAMA_NUM_PARALLEL`) |
| `LLM_TIMEOUT_SECONDS` | no | `600` | Per-request timeout for Ollama |
| `SEMGREP_CONFIG` | no | `p/default` | Comma-separated Semgrep rulesets (registry names or local paths). Metrics are always off. |
| `CLONE_BASE_DIR` | no | `/tmp/Custos_clones` | Temp directory for checkouts |
| `MAX_FILE_SIZE_KB` | no | `500` | Default for the Settings page value of the same name |
| `MAX_FILES_PER_REPO` | no | `200` | Default for the Settings page value of the same name |
| `STALE_JOB_MINUTES` | no | `60` | Jobs stuck "analyzing" longer than this are marked as errored |
| `LOGIN_MAX_ATTEMPTS` / `LOGIN_WINDOW_SECONDS` | no | `10` / `300` | Failed-login rate limit per username + IP |
| `LOGIN_MAX_ATTEMPTS_PER_ACCOUNT` | no | `50` | Failed logins per username across all IPs within the window (stops distributed brute force) |
| `POSTGRES_PASSWORD` / `REDIS_PASSWORD` | Docker | — | Credentials for the bundled services |

Runtime settings editable on the dashboard **Settings → Analysis** page (stored in the database, override the env defaults):

| Key | Takes effect |
|---|---|
| `llm_provider`, `responses_base_url`, `responses_model`, Responses API key | next job |
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

## Responses API provider

Instead of Ollama, Custos can use any server that implements the OpenAI **Responses API** (`POST /v1/responses`): OpenAI itself, or compatible gateways and self-hosted servers. On the dashboard, open **Settings → Analysis**, set **Provider** to *Responses API*, then enter:

- **Base URL**: for example `https://api.openai.com/v1`. Requests go to `{base}/responses`, and **Test** lists models from `{base}/models`.
- **Model**: the provider's model name (click one from the Test results).
- **API key**: sent as a bearer token. It is stored encrypted with `ENCRYPTION_KEY` and is write-only: the API only ever reports whether a key is set and its last 4 characters. **Remove saved key** deletes it. It can also come from `RESPONSES_API_KEY` in the env.

How requests are made:

- The fixed system prompt goes in `instructions` and the code in `input`. Batching, file selection and the findings parser are the same as for Ollama.
- Output is constrained with a strict JSON schema (`text.format`). Servers that don't support that are retried with `json_object`, then with no format (the parser is lenient).
- `store: false` asks the provider not to retain the request. Its own retention and training policies still apply, so check them before sending university code.
- A key is never sent over plain `http://` to a non-local host. HTTP is allowed only for localhost, private IPs and internal hostnames.
- LLM runs are recorded as `<model> (Responses API)`. An invalid key, rate limit, refusal or truncated response fails the run with a clear message, and SAST findings are still kept.

---

## SAST tools

The worker runs `semgrep`, `gitleaks`, `pip-audit` and `npm audit`, each with a timeout. A missing tool is logged and skipped. In Docker they are all installed in the `worker` image target; on a host, `./custos dev` installs them, or by hand:

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
./custos user add alice --role admin
./custos user add bob                  # analyst
./custos user reset alice
```

This works against the Docker deployment or the local setup, whichever is running. Passwords are prompted for (or read from stdin when piped), never passed as arguments. There is no self-registration.

---

## Security model

Custos analyses untrusted code, so the worker treats every repository as hostile:

- **Credentials never touch the checkout.** Commits are fetched with a depth-1 fetch of the exact SHA. The GitHub token is passed to git as an HTTP header via `GIT_CONFIG_*` environment variables, so it is not in the remote URL, `.git/config`, the process list or error messages. Stored errors are additionally scrubbed of anything credential-shaped.
- **No repo-controlled execution.** Git hooks are disabled and the `file://` protocol is blocked; `pip-audit` runs with `--no-deps` (no package builds); `npm audit` is pinned to the public registry so a hostile `.npmrc` can't redirect it.
- **No escaping the checkout.** Files sent to the LLM must be regular files inside the checkout; symlinks are never followed (so a repo can't exfiltrate e.g. `/app/.env` through the model). Env files, private keys and credential stores are never sent to the model at all (Gitleaks still reports them). Only real 40-hex commit SHAs are ever passed to git.
- **Jobs can't hang.** Each job enforces its own deadline just inside `worker_job_timeout`, so an overrun is recorded as failed immediately; a worker restart mid-job leaves the row for ARQ's retry to resume, and a reaper catches anything else.
- **Where code goes.** With the default Ollama provider, code never leaves your infrastructure. With the Responses API provider it is sent to the configured server (`store: false`). Its API key is encrypted at rest, write-only through the API, and never sent over plain HTTP to a non-local host.
- **Prompt injection.** The system prompt is fixed in code and instructs the model to ignore instructions embedded in the source.
- **Rendering.** Code snippets are always HTML-escaped (via highlight.js or an explicit escape) before display; nginx sends a strict Content-Security-Policy.
- **Secrets at rest.** Repo tokens and webhook secrets are encrypted with `ENCRYPTION_KEY` (separate from the JWT key, rotatable).
- **Webhooks.** HMAC-SHA256 verified per repo; unknown repos and bad signatures get an identical response; redeliveries are de-duplicated; branch deletions and tag pushes are ignored.
- **Logins.** Failed attempts are rate-limited per username + client IP, and separately per username across all IPs, so neither faked nor real rotating addresses buy unlimited guesses. nginx overwrites `X-Forwarded-For` with the real peer address.

---

## Testing and CI

```bash
./custos test           # pytest; creates a local custos_test database if needed (args pass through)
./custos lint           # ruff + eslint
```

GitHub Actions (`.github/workflows/ci.yml`) runs lint, the test suite against Postgres, a full migration up/down round-trip with `alembic check`, the dashboard lint + build, builds all three Docker images, and finally runs **`./custos --yes deploy` end to end**. That last job checks the generated secrets, that the scanners exist only in the worker image, that nothing secret is baked into the images, login through the nginx proxy, that spoofed `X-Forwarded-For` can't dodge the rate limit, that only the dashboard port is exposed, and that re-deploying leaves `.env` untouched.

---

## Useful commands

```bash
./custos --help           # all launcher commands
./custos dev              # full local stack with live logs
./custos deploy           # Docker deploy / upgrade
./custos logs | stop      # Docker stack
./custos user add NAME    # create a login
docker compose down -v    # stop and DELETE the database volume
```
