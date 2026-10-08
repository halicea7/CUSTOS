"""Runtime-tunable settings stored in the app_config table (env as fallback)."""

import ipaddress
import logging
from urllib.parse import urlsplit

from cryptography.fernet import InvalidToken
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from crypto import decrypt
from models import AppConfig
from schemas import AppConfigResponse

logger = logging.getLogger(__name__)

# Stored encrypted; never returned by the API (only whether it's set + last 4).
RESPONSES_API_KEY = "responses_api_key"

CONFIG_KEYS = {
    "llm_provider", "responses_base_url", "responses_model", RESPONSES_API_KEY,
    "ollama_base_url", "ollama_model", "ollama_think", "ollama_num_ctx",
    "llm_max_content_chars",
    "max_file_size_kb", "max_files_per_repo",
    "access_token_expire_minutes",
    "worker_max_jobs", "worker_job_timeout",
}

DEFAULT_WORKER_MAX_JOBS = 4
DEFAULT_WORKER_JOB_TIMEOUT = 900


async def load_app_config(db: AsyncSession) -> AppConfigResponse:
    result = await db.execute(select(AppConfig).where(AppConfig.key.in_(CONFIG_KEYS)))
    ov = {row.key: row.value for row in result.scalars()}
    api_key = _stored_api_key(ov) or settings.RESPONSES_API_KEY
    return AppConfigResponse(
        llm_provider=ov.get("llm_provider", settings.LLM_PROVIDER),
        responses_base_url=ov.get("responses_base_url", settings.RESPONSES_BASE_URL).rstrip("/"),
        responses_model=ov.get("responses_model", settings.RESPONSES_MODEL),
        responses_api_key_set=bool(api_key),
        responses_api_key_last4=api_key[-4:] if len(api_key) >= 8 else None,
        ollama_base_url=ov.get("ollama_base_url", settings.OLLAMA_BASE_URL).rstrip("/"),
        ollama_model=ov.get("ollama_model", settings.OLLAMA_MODEL),
        ollama_think=ov.get("ollama_think", "false").lower() == "true",
        ollama_num_ctx=int(ov.get("ollama_num_ctx", 0)),
        llm_max_content_chars=int(ov.get("llm_max_content_chars", 96_000)),
        max_file_size_kb=int(ov.get("max_file_size_kb", settings.MAX_FILE_SIZE_KB)),
        max_files_per_repo=int(ov.get("max_files_per_repo", settings.MAX_FILES_PER_REPO)),
        access_token_expire_minutes=int(
            ov.get("access_token_expire_minutes", settings.ACCESS_TOKEN_EXPIRE_MINUTES)
        ),
        worker_max_jobs=int(ov.get("worker_max_jobs", DEFAULT_WORKER_MAX_JOBS)),
        worker_job_timeout=int(ov.get("worker_job_timeout", DEFAULT_WORKER_JOB_TIMEOUT)),
    )


def _stored_api_key(ov: dict[str, str]) -> str:
    enc = ov.get(RESPONSES_API_KEY)
    if not enc:
        return ""
    try:
        return decrypt(enc)
    except InvalidToken:
        # ENCRYPTION_KEY changed without `manage.py rotate-keys`: treat as unset
        # rather than breaking the Settings page and every job.
        logger.warning("Stored Responses API key cannot be decrypted; re-enter it in Settings")
        return ""


async def load_responses_api_key(db: AsyncSession) -> str:
    """The Responses API key for the worker: Settings page value, else env."""
    row = await db.get(AppConfig, RESPONSES_API_KEY)
    return _stored_api_key({RESPONSES_API_KEY: row.value} if row else {}) or settings.RESPONSES_API_KEY


def is_local_url(url: str) -> bool:
    """True for loopback/private/link-local hosts and single-label names
    (e.g. a compose service), where plain HTTP doesn't cross the internet."""
    host = (urlsplit(url).hostname or "").lower()
    if host in ("localhost", "host.docker.internal") or "." not in host:
        return True
    if host.endswith((".local", ".internal", ".lan", ".home.arpa")):
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return ip.is_private or ip.is_loopback or ip.is_link_local
