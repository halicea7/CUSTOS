"""Runtime-tunable settings stored in the app_config table (env as fallback)."""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from models import AppConfig
from schemas import AppConfigResponse

CONFIG_KEYS = {
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
    return AppConfigResponse(
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
