from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict

# Always load from api/.env regardless of the process working directory.
_ENV_FILE = Path(__file__).parent / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=_ENV_FILE, env_file_encoding="utf-8")

    SECRET_KEY: str = "changeme"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 480

    GITHUB_WEBHOOK_SECRET: str = ""
    GITHUB_TOKEN: str = ""

    DATABASE_URL: str = "postgresql+asyncpg://Custos:Custos@localhost:5432/Custos"
    REDIS_URL: str = "redis://localhost:6379"

    OLLAMA_BASE_URL: str = "http://localhost:11434"
    OLLAMA_MODEL: str = "qwen2.5-coder:32b"

    CLONE_BASE_DIR: str = "/tmp/Custos_clones"
    MAX_FILE_SIZE_KB: int = 500
    MAX_FILES_PER_REPO: int = 200


settings = Settings()
