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

# ── worker: git + Semgrep + Gitleaks + pip-audit + npm + Bandit + OSV + Checkov
FROM base AS worker
ARG GITLEAKS_VERSION=8.21.2
ARG BANDIT_VERSION=1.9.4
ARG OSV_SCANNER_VERSION=2.7.0
# Checkov gets its own venv too: it pins dozens of libraries.
ARG CHECKOV_VERSION=3.3.29
# SentinelOne CNS Shift Left CLI (optional layer, enabled in Settings). Own
# venv: its dependencies pin many libraries that could clash with ours.
ARG S1_CLI_VERSION=1.0.4
ARG TARGETARCH
# gcc/libc6-dev/libffi-dev: s1-shift-left-cli pins a `regex` release with no
# Python 3.12 wheel, so pip compiles it (SentinelOne's own image does the
# same). The compiler is removed again below; the worker doesn't need one.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl nodejs npm \
    gcc libc6-dev libffi-dev \
 && ARCH="$( [ "${TARGETARCH:-amd64}" = "arm64" ] && echo arm64 || echo x64 )" \
 && curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_${ARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin gitleaks \
 && curl -fsSL -o /usr/local/bin/osv-scanner \
    "https://github.com/google/osv-scanner/releases/download/v${OSV_SCANNER_VERSION}/osv-scanner_linux_${TARGETARCH:-amd64}" \
 && chmod 755 /usr/local/bin/osv-scanner \
 && pip install semgrep pip-audit "bandit==${BANDIT_VERSION}" \
 && python -m venv /opt/checkov \
 && /opt/checkov/bin/pip install "checkov==${CHECKOV_VERSION}" \
 && ln -s /opt/checkov/bin/checkov /usr/local/bin/checkov \
 && python -m venv /opt/s1cns \
 && /opt/s1cns/bin/pip install "s1-shift-left-cli==${S1_CLI_VERSION}" \
 && ln -s /opt/s1cns/bin/s1-cns-cli /usr/local/bin/s1-cns-cli \
 && apt-get purge -y --auto-remove gcc libc6-dev \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /tmp/Custos_clones /var/lib/custos-s1 \
 && chown appuser /tmp/Custos_clones /var/lib/custos-s1 \
 && chmod 700 /var/lib/custos-s1
# The S1 CLI keeps its config (incl. the token, in plaintext) and downloaded
# scanner binaries here; a volume keeps them across restarts.
ENV S1_HOME=/var/lib/custos-s1
USER appuser
CMD ["python", "-m", "arq", "worker.queue.WorkerSettings"]
