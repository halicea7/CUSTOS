from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict

# Always load from api/.env regardless of the process working directory.
_ENV_FILE = Path(__file__).parent / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=_ENV_FILE, env_file_encoding="utf-8", extra="ignore")

    SECRET_KEY: str = "changeme"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 480

    # Key for encrypting stored GitHub tokens / webhook secrets. Defaults to
    # SECRET_KEY for backwards compatibility; set it separately so JWT signing
    # keys can be rotated without losing stored credentials.
    ENCRYPTION_KEY: str = ""
    # Comma-separated old encryption keys still accepted for decryption.
    # Use with rotate_keys.py when changing ENCRYPTION_KEY (or SECRET_KEY).
    PREVIOUS_ENCRYPTION_KEYS: str = ""

    DATABASE_URL: str = "postgresql+asyncpg://Custos:Custos@localhost:5432/Custos"
    REDIS_URL: str = "redis://localhost:6379"

    OLLAMA_BASE_URL: str = "http://localhost:11434"
    OLLAMA_MODEL: str = "qwen2.5-coder:32b"

    # "auto" pulls rules from the Semgrep registry and requires sending usage
    # metrics (not code). For a fully offline setup, point this at a local
    # rules file/dir; metrics are then disabled.
    SEMGREP_CONFIG: str = "auto"

    CLONE_BASE_DIR: str = "/tmp/Custos_clones"
    MAX_FILE_SIZE_KB: int = 500
    MAX_FILES_PER_REPO: int = 200


_WEAK_SECRETS = {"", "changeme", "secret", "change-me", "your_secret_key"}


def validate_secrets(s: Settings) -> None:
    """Refuse to run with a default or short SECRET_KEY — it signs every JWT,
    so a guessable value lets anyone forge an admin token."""
    if s.SECRET_KEY in _WEAK_SECRETS or len(s.SECRET_KEY) < 32:
        raise RuntimeError(
            "SECRET_KEY is unset, a known default, or shorter than 32 chars. "
            "Generate one with: python3 -c \"import secrets; print(secrets.token_hex(32))\" "
            "and set it in api/.env. If existing repo credentials were encrypted "
            "with the old key, also set PREVIOUS_ENCRYPTION_KEYS=<old key> and run "
            "rotate_keys.py."
        )


settings = Settings()
