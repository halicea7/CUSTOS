import logging
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

logger = logging.getLogger(__name__)

# Always load from api/.env regardless of the process working directory.
_ENV_FILE = Path(__file__).parent / ".env"

_INSECURE_SECRETS = {"", "changeme", "secret", "change-me"}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=_ENV_FILE, env_file_encoding="utf-8", extra="ignore")

    # Signs JWTs. Must be a long random value in production.
    SECRET_KEY: str = "changeme"
    # Fernet key (urlsafe base64, 32 bytes) used to encrypt stored GitHub tokens
    # and webhook secrets. Kept separate from SECRET_KEY so either can be rotated
    # independently. Accepts a comma-separated list: the first key encrypts, all
    # keys decrypt (MultiFernet), which allows zero-downtime rotation.
    # If unset, a key derived from SECRET_KEY is used (legacy behaviour).
    ENCRYPTION_KEY: str = ""
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 480

    # Set to true for local development only: allows the default SECRET_KEY.
    ALLOW_INSECURE_DEFAULTS: bool = False

    DATABASE_URL: str = "postgresql+asyncpg://Custos:Custos@localhost:5432/Custos"
    REDIS_URL: str = "redis://localhost:6379"

    OLLAMA_BASE_URL: str = "http://localhost:11434"
    OLLAMA_MODEL: str = "qwen2.5-coder:32b"

    # Comma-separated Semgrep rulesets (registry names like p/default, or local paths).
    SEMGREP_CONFIG: str = "p/default"

    # LLM batching: files beyond one prompt's budget are reviewed in extra
    # batches, up to this many per submission, with this many in flight at once.
    LLM_MAX_BATCHES: int = 4
    LLM_CONCURRENCY: int = 1
    LLM_TIMEOUT_SECONDS: int = 600

    CLONE_BASE_DIR: str = "/tmp/Custos_clones"
    MAX_FILE_SIZE_KB: int = 500
    MAX_FILES_PER_REPO: int = 200

    # Login rate limiting (per username+IP).
    LOGIN_MAX_ATTEMPTS: int = 10
    LOGIN_WINDOW_SECONDS: int = 300

    # Submissions stuck in "analyzing" longer than this are marked as errored.
    STALE_JOB_MINUTES: int = 60

    @property
    def secret_key_is_insecure(self) -> bool:
        return self.SECRET_KEY.strip().lower() in _INSECURE_SECRETS or len(self.SECRET_KEY) < 32


settings = Settings()


def assert_secure_settings() -> None:
    """Refuse to start with a default/weak SECRET_KEY unless explicitly allowed."""
    if not settings.secret_key_is_insecure:
        return
    msg = (
        "SECRET_KEY is missing, a known default, or shorter than 32 characters. "
        "Generate one with: python -c \"import secrets; print(secrets.token_hex(32))\""
    )
    if settings.ALLOW_INSECURE_DEFAULTS:
        logger.warning("%s (continuing because ALLOW_INSECURE_DEFAULTS=true)", msg)
        return
    raise RuntimeError(msg)
