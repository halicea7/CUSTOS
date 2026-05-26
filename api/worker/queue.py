import logging
from urllib.parse import urlparse

from arq.connections import RedisSettings

from config import settings
from database import engine
from arq import cron as arq_cron

from worker.tasks import analyze_submission, rerun_llm, scan_self

logger = logging.getLogger(__name__)


def get_redis_settings() -> RedisSettings:
    url = urlparse(settings.REDIS_URL)
    return RedisSettings(
        host=url.hostname or "localhost",
        port=url.port or 6379,
    )


async def startup(ctx: dict) -> None:
    import logging as _logging
    _logging.basicConfig(level=_logging.INFO, format="%(levelname)s %(name)s %(message)s")
    logger.info("Worker starting up")


async def shutdown(ctx: dict) -> None:
    await engine.dispose()
    logger.info("Worker shut down")


class WorkerSettings:
    functions = [analyze_submission, rerun_llm, scan_self]
    cron_jobs = [
        arq_cron(scan_self, weekday={0}, hour=2, minute=0),  # Monday 02:00 UTC
    ]
    redis_settings = get_redis_settings()
    on_startup = startup
    on_shutdown = shutdown
    max_jobs = 4
    job_timeout = 600
