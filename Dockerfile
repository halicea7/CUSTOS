# syntax=docker/dockerfile:1.7
# Multi-target image for the Custos backend. Build context is the repo root.
#   docker build --target api    -t custos-api .
#   docker build --target worker -t custos-worker .

ARG PYTHON_VERSION=3.12

# ── base: Python deps + application code + migrations ────────────────────────
FROM python:${PYTHON_VERSION}-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /srv/custos

COPY api/requirements.txt api/requirements.txt
RUN pip install -r api/requirements.txt

RUN adduser --disabled-password --gecos "" --uid 10001 appuser

COPY alembic.ini ./
COPY alembic ./alembic
COPY api ./api
RUN rm -rf api/tests api/.env

WORKDIR /srv/custos/api

# ── api: no git or scanners — smaller attack surface ─────────────────────────
FROM base AS api
USER appuser
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s --retries=5 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=2)"
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips=*"]

# ── worker: git + Semgrep + Gitleaks + pip-audit + npm ───────────────────────
FROM base AS worker
ARG GITLEAKS_VERSION=8.21.2
ARG TARGETARCH
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl nodejs npm \
 && rm -rf /var/lib/apt/lists/* \
 && ARCH="$( [ "${TARGETARCH:-amd64}" = "arm64" ] && echo arm64 || echo x64 )" \
 && curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_${ARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin gitleaks \
 && pip install semgrep pip-audit \
 && mkdir -p /tmp/Custos_clones && chown appuser /tmp/Custos_clones
USER appuser
CMD ["python", "-m", "arq", "worker.queue.WorkerSettings"]
