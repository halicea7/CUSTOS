from arq.connections import RedisSettings

from config import settings

# Redis keys shared by the API and the worker.
LLM_ACTIVE_SET = "custos:llm_active"


def llm_lock_key(submission_id) -> str:
    return f"custos:llm_running:{submission_id}"


def llm_job_key(submission_id) -> str:
    return f"custos:llm_job:{submission_id}"


def llm_start_key(submission_id) -> str:
    return f"custos:llm_start:{submission_id}"


def scan_stages_key(scan_id) -> str:
    """JSON list of a running self-scan's stages and their real states."""
    return f"custos:scan_stages:{scan_id}"


def arq_redis_settings() -> RedisSettings:
    """ARQ settings built from the full REDIS_URL (keeps password, db, TLS)."""
    return RedisSettings.from_dsn(settings.REDIS_URL)
