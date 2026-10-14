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
# Same treatment for the SentinelOne service-user token, bound to the console.
S1_TOKEN = "s1_api_token"
S1_TOKEN_ORIGIN = "s1_api_token_origin"
S1_SCANNERS = ("secret", "iac", "vuln")
# The registered repo that is Custos's own source. Signing off its commits
# approves them for `./custos update` to deploy.
SELF_UPDATE_REPO = "self_update_repo"
# An admin's explicit, per-host exception to the "no API key over plain HTTP
# to non-local hosts" rule (e.g. a campus LLM gateway without TLS). Holds the
# exact http:// origin it was granted for; any other host is still refused.
RESPONSES_HTTP_ALLOWED_ORIGIN = "responses_http_allowed_origin"
# Amazon Bedrock API key. Stored encrypted and write-only like the others, but
# not origin-bound: every Bedrock URL is built from a validated region name,
# so it can only ever be sent to AWS.
BEDROCK_API_KEY = "bedrock_api_key"

CONFIG_KEYS = {
    "llm_provider", "responses_base_url", "responses_model", RESPONSES_API_KEY, RESPONSES_API_KEY_ORIGIN,
    "s1_enabled", "s1_console_url", "s1_scope_type", "s1_scope_id", "s1_policy_id", "s1_scanners",
    "s1_verify_secrets", "s1_publish", S1_TOKEN, S1_TOKEN_ORIGIN,
    SELF_UPDATE_REPO, RESPONSES_HTTP_ALLOWED_ORIGIN,
    "responses_reasoning_effort", "responses_max_output_tokens",
    "bedrock_region", "bedrock_endpoint", "bedrock_model", "bedrock_project_id", BEDROCK_API_KEY,
    "bedrock_reasoning_effort", "bedrock_max_output_tokens",
    "ollama_base_url", "ollama_model", "ollama_think", "ollama_num_ctx",
    "llm_max_content_chars", "chains_enabled", "chain_gate", "verify_llm_findings",
    "max_file_size_kb", "max_files_per_repo",
    "access_token_expire_minutes",
    "worker_max_jobs", "worker_job_timeout",
    "repo_check_interval_hours",
}

DEFAULT_WORKER_MAX_JOBS = 4
DEFAULT_WORKER_JOB_TIMEOUT = 900
# Scheduled "Check for updates" on every enabled repo; 0 = manual only.
DEFAULT_REPO_CHECK_INTERVAL_HOURS = 48


async def load_app_config(db: AsyncSession) -> AppConfigResponse:
    result = await db.execute(select(AppConfig).where(AppConfig.key.in_(CONFIG_KEYS)))
    ov = {row.key: row.value for row in result.scalars()}
    responses_base_url = ov.get("responses_base_url", settings.RESPONSES_BASE_URL).rstrip("/")
    api_key = _key_for_url(ov, responses_base_url)
    s1_console_url = ov.get("s1_console_url", settings.S1_CONSOLE_URL).rstrip("/")
    s1_token = _s1_token_for_url(ov, s1_console_url) if s1_console_url else ""
    bedrock_key = _decrypt_or_empty(ov.get(BEDROCK_API_KEY), "Bedrock API key")
    s1_scanners = [s for s in ov.get("s1_scanners", ",".join(S1_SCANNERS)).split(",") if s in S1_SCANNERS]
    return AppConfigResponse(
        self_update_repo=ov.get(SELF_UPDATE_REPO, ""),
        responses_http_allowed_origin=ov.get(RESPONSES_HTTP_ALLOWED_ORIGIN) or None,
        s1_enabled=_bool(ov.get("s1_enabled"), settings.S1_ENABLED),
        s1_console_url=s1_console_url,
        s1_scope_type=ov.get("s1_scope_type", settings.S1_SCOPE_TYPE),
        s1_scope_id=ov.get("s1_scope_id", settings.S1_SCOPE_ID),
        s1_policy_id=ov.get("s1_policy_id", ""),
        s1_scanners=s1_scanners,
        s1_verify_secrets=_bool(ov.get("s1_verify_secrets"), False),
        s1_publish=_bool(ov.get("s1_publish"), False),
        s1_token_set=bool(s1_token),
        s1_token_last4=s1_token[-4:] if len(s1_token) >= 8 else None,
        s1_token_origin=ov.get(S1_TOKEN_ORIGIN),
        llm_provider=ov.get("llm_provider", settings.LLM_PROVIDER),
        responses_base_url=responses_base_url,
        responses_api_key_origin=ov.get(RESPONSES_API_KEY_ORIGIN),
        responses_model=ov.get("responses_model", settings.RESPONSES_MODEL),
        responses_reasoning_effort=ov.get("responses_reasoning_effort", ""),
        responses_max_output_tokens=int(ov.get("responses_max_output_tokens", 0)),
        responses_api_key_set=bool(api_key),
        responses_api_key_last4=api_key[-4:] if len(api_key) >= 8 else None,
        bedrock_region=ov.get("bedrock_region", ""),
        bedrock_endpoint=ov.get("bedrock_endpoint", "mantle"),
        bedrock_model=ov.get("bedrock_model", ""),
        bedrock_project_id=ov.get("bedrock_project_id", ""),
        bedrock_reasoning_effort=ov.get("bedrock_reasoning_effort", ""),
        bedrock_max_output_tokens=int(ov.get("bedrock_max_output_tokens", 0)),
        bedrock_api_key_set=bool(bedrock_key),
        bedrock_api_key_last4=bedrock_key[-4:] if len(bedrock_key) >= 8 else None,
        ollama_base_url=ov.get("ollama_base_url", settings.OLLAMA_BASE_URL).rstrip("/"),
        ollama_model=ov.get("ollama_model", settings.OLLAMA_MODEL),
        ollama_think=ov.get("ollama_think", "false").lower() == "true",
        ollama_num_ctx=int(ov.get("ollama_num_ctx", 0)),
        llm_max_content_chars=int(ov.get("llm_max_content_chars", 96_000)),
        chains_enabled=_bool(ov.get("chains_enabled"), True),
        chain_gate=_bool(ov.get("chain_gate"), True),
        verify_llm_findings=_bool(ov.get("verify_llm_findings"), True),
        max_file_size_kb=int(ov.get("max_file_size_kb", settings.MAX_FILE_SIZE_KB)),
        max_files_per_repo=int(ov.get("max_files_per_repo", settings.MAX_FILES_PER_REPO)),
        access_token_expire_minutes=int(
            ov.get("access_token_expire_minutes", settings.ACCESS_TOKEN_EXPIRE_MINUTES)
        ),
        worker_max_jobs=int(ov.get("worker_max_jobs", DEFAULT_WORKER_MAX_JOBS)),
        worker_job_timeout=int(ov.get("worker_job_timeout", DEFAULT_WORKER_JOB_TIMEOUT)),
        repo_check_interval_hours=int(
            ov.get("repo_check_interval_hours", DEFAULT_REPO_CHECK_INTERVAL_HOURS)
        ),
    )


def _bool(value: str | None, default: bool) -> bool:
    return default if value is None else value.lower() == "true"


def _decrypt_or_empty(enc: str | None, what: str) -> str:
    if not enc:
        return ""
    try:
        return decrypt(enc)
    except InvalidToken:
        # ENCRYPTION_KEY changed without `manage.py rotate-keys`: treat as unset
        # rather than breaking the Settings page and every job.
        logger.warning("Stored %s cannot be decrypted; re-enter it in Settings", what)
        return ""


def _stored_api_key(ov: dict[str, str]) -> str:
    return _decrypt_or_empty(ov.get(RESPONSES_API_KEY), "Responses API key")


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


def _s1_token_for_url(ov: dict[str, str], console_url: str) -> str:
    """The S1 token that may be sent to *console_url*, or "" (see _key_for_url)."""
    target = url_origin(console_url)
    if ov.get(S1_TOKEN) and ov.get(S1_TOKEN_ORIGIN) == target:
        return _decrypt_or_empty(ov.get(S1_TOKEN), "SentinelOne token")
    if settings.S1_SERVICE_USER_API_TOKEN and settings.S1_CONSOLE_URL \
            and url_origin(settings.S1_CONSOLE_URL) == target:
        return settings.S1_SERVICE_USER_API_TOKEN
    return ""


async def load_s1_token(db: AsyncSession, console_url: str) -> str:
    rows = await db.execute(select(AppConfig).where(AppConfig.key.in_((S1_TOKEN, S1_TOKEN_ORIGIN))))
    return _s1_token_for_url({r.key: r.value for r in rows.scalars()}, console_url)


async def load_responses_api_key(db: AsyncSession, base_url: str) -> str:
    """The Responses API key to send to *base_url* (see _key_for_url)."""
    rows = await db.execute(
        select(AppConfig).where(AppConfig.key.in_((RESPONSES_API_KEY, RESPONSES_API_KEY_ORIGIN)))
    )
    return _key_for_url({r.key: r.value for r in rows.scalars()}, base_url)


async def load_bedrock_api_key(db: AsyncSession) -> str:
    row = await db.get(AppConfig, BEDROCK_API_KEY)
    return _decrypt_or_empty(row.value if row else None, "Bedrock API key")


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
