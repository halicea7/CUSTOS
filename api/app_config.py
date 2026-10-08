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
# The scheme://host:port the key was saved for. The key is only ever sent
# there, so changing the base URL can't redirect it to another server.
RESPONSES_API_KEY_ORIGIN = "responses_api_key_origin"

CONFIG_KEYS = {
    "llm_provider", "responses_base_url", "responses_model", RESPONSES_API_KEY, RESPONSES_API_KEY_ORIGIN,
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
    responses_base_url = ov.get("responses_base_url", settings.RESPONSES_BASE_URL).rstrip("/")
    api_key = _key_for_url(ov, responses_base_url)
    return AppConfigResponse(
        llm_provider=ov.get("llm_provider", settings.LLM_PROVIDER),
        responses_base_url=responses_base_url,
        responses_api_key_origin=ov.get(RESPONSES_API_KEY_ORIGIN),
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


def url_origin(url: str) -> str:
    """scheme://host:port with default ports made explicit, for comparison."""
    parts = urlsplit(url)
    scheme = parts.scheme.lower()
    port = parts.port or {"https": 443, "http": 80}.get(scheme)
    return f"{scheme}://{(parts.hostname or '').lower()}:{port}"


def _key_for_url(ov: dict[str, str], base_url: str) -> str:
    """The API key that may be sent to *base_url*, or "".

    A key saved on the Settings page goes only to the origin it was saved
    for; an env RESPONSES_API_KEY only to the env RESPONSES_BASE_URL origin.
    """
    target = url_origin(base_url)
    if ov.get(RESPONSES_API_KEY) and ov.get(RESPONSES_API_KEY_ORIGIN) == target:
        return _stored_api_key(ov)
    if settings.RESPONSES_API_KEY and url_origin(settings.RESPONSES_BASE_URL) == target:
        return settings.RESPONSES_API_KEY
    return ""


async def load_responses_api_key(db: AsyncSession, base_url: str) -> str:
    """The Responses API key to send to *base_url* (see _key_for_url)."""
    rows = await db.execute(
        select(AppConfig).where(AppConfig.key.in_((RESPONSES_API_KEY, RESPONSES_API_KEY_ORIGIN)))
    )
    return _key_for_url({r.key: r.value for r in rows.scalars()}, base_url)


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
