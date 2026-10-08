import asyncio
import logging

from arq import cron as arq_cron
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app_config import DEFAULT_WORKER_JOB_TIMEOUT, DEFAULT_WORKER_MAX_JOBS, load_app_config
from config import assert_secure_settings, settings
from database import engine
from redis_util import ARQ_QUEUE, arq_redis_settings
from worker.tasks import analyze_submission, check_repos_for_updates, reap_stale_jobs, rerun_llm, scan_self

logger = logging.getLogger(__name__)


def _load_worker_limits() -> tuple[int, int]:
    """Read worker_max_jobs / worker_job_timeout from app_config at startup.

    ARQ reads these from the settings class before its event loop starts, so
    this uses a throwaway engine on a private loop. Falls back to defaults if
    the database is unreachable. Changes apply on the next worker restart.
    """

    async def fetch() -> tuple[int, int]:
        tmp_engine = create_async_engine(settings.DATABASE_URL, poolclass=NullPool)
        try:
            async with async_sessionmaker(tmp_engine)() as db:
                cfg = await load_app_config(db)
                return cfg.worker_max_jobs, cfg.worker_job_timeout
        finally:
            await tmp_engine.dispose()

    try:
        return asyncio.run(fetch())
    except Exception as exc:  # pragma: no cover — depends on DB availability
        logger.warning("Could not load worker limits from DB (%s); using defaults", exc)
        return DEFAULT_WORKER_MAX_JOBS, DEFAULT_WORKER_JOB_TIMEOUT


async def startup(ctx: dict) -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
    assert_secure_settings()
    logger.info(
        "Worker starting up (max_jobs=%d, job_timeout=%ds)",
        WorkerSettings.max_jobs, WorkerSettings.job_timeout,
    )


async def shutdown(ctx: dict) -> None:
    await engine.dispose()
    logger.info("Worker shut down")


_max_jobs, _job_timeout = _load_worker_limits()


class WorkerSettings:
    functions = [analyze_submission, rerun_llm, scan_self]
    cron_jobs = [
        arq_cron(scan_self, weekday={0}, hour=2, minute=0),  # Monday 02:00 UTC
        arq_cron(reap_stale_jobs, minute=set(range(0, 60, 10)), run_at_startup=True),
        # Hourly; each repo is only checked once its interval (Settings) has passed.
        arq_cron(check_repos_for_updates, minute=17),
    ]
    redis_settings = arq_redis_settings()
    queue_name = ARQ_QUEUE
    on_startup = startup
    on_shutdown = shutdown
    max_jobs = _max_jobs
    job_timeout = _job_timeout
    # A job whose worker died is retried once; tasks are idempotent on re-entry.
    max_tries = 2
