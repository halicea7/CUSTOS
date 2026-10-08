# Build context is the project root (see docker-compose.yml) so alembic/ can
# be copied in and migrations run from inside the image.
FROM python:3.12-slim

ARG GITLEAKS_VERSION=8.21.2
ARG TARGETARCH

# git: cloning submissions. nodejs/npm: npm audit. curl: fetching gitleaks.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git nodejs npm curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN case "${TARGETARCH:-amd64}" in \
      amd64) GL_ARCH=x64 ;; \
      arm64) GL_ARCH=arm64 ;; \
      *) echo "unsupported arch ${TARGETARCH}" && exit 1 ;; \
    esac \
 && curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_${GL_ARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin gitleaks

WORKDIR /app

COPY api/requirements.txt api/requirements.txt
RUN pip install --no-cache-dir -r api/requirements.txt semgrep

RUN adduser --disabled-password --gecos "" appuser

COPY alembic.ini ./
COPY alembic/ alembic/
COPY api/ api/

WORKDIR /app/api
USER appuser
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
