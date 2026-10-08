import asyncio
import logging
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

from arq.connections import RedisSettings
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import create_async_engine

from config import settings, validate_secrets
from database import async_session_factory, engine
from arq import cron as arq_cron

from models import AppConfig, LlmRun, SelfScan, Submission
from worker.tasks import analyze_submission, rerun_llm, scan_self

logger = logging.getLogger(__name__)

_DEFAULT_MAX_JOBS = 4
_DEFAULT_JOB_TIMEOUT = 600


def get_redis_settings() -> RedisSettings:
    url = urlparse(settings.REDIS_URL)
    return RedisSettings(
        host=url.hostname or "localhost",
        port=url.port or 6379,
        password=url.password,
    )


def _load_worker_limits() -> tuple[int, int]:
    """Read worker_max_jobs / worker_job_timeout from app_config at import time.

    ARQ needs these as class attributes before its event loop starts, so this
    uses a throwaway engine on a throwaway loop. Falls back to defaults if the
    DB is unreachable. Changes take effect on worker restart.
    """
    async def _read() -> dict[str, str]:
        tmp_engine = create_async_engine(settings.DATABASE_URL)
        try:
            async with tmp_engine.connect() as conn:
                rows = await conn.execute(
                    select(AppConfig.key, AppConfig.value).where(
                        AppConfig.key.in_(("worker_max_jobs", "worker_job_timeout"))
                    )
                )
                return {k: v for k, v in rows.all()}
        finally:
            await tmp_engine.dispose()

    try:
        ov = asyncio.run(_read())
        return (
            int(ov.get("worker_max_jobs", _DEFAULT_MAX_JOBS)),
            int(ov.get("worker_job_timeout", _DEFAULT_JOB_TIMEOUT)),
        )
    except Exception as exc:
        logger.warning("Could not load worker limits from DB (%s); using defaults", exc)
        return _DEFAULT_MAX_JOBS, _DEFAULT_JOB_TIMEOUT


_MAX_JOBS, _JOB_TIMEOUT = _load_worker_limits()


async def _reap_stale_jobs() -> None:
    """Fail rows left mid-flight by a crashed or killed worker.

    Anything still analyzing/running well past the job timeout can't still be
    executing, so it's safe to mark failed even with several workers.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=_JOB_TIMEOUT * 2)
    msg = "Worker stopped before the job finished"
    now = datetime.now(timezone.utc)
    async with async_session_factory() as db:
        subs = await db.execute(
            update(Submission)
            .where(Submission.status == "analyzing", Submission.updated_at < cutoff)
            .values(status="error", error_message=msg)
        )
        runs = await db.execute(
            update(LlmRun)
            .where(LlmRun.status == "running", LlmRun.started_at < cutoff)
            .values(status="failed", error=msg, finished_at=now)
        )
        scans = await db.execute(
            update(SelfScan)
            .where(SelfScan.status == "running", SelfScan.started_at < cutoff)
            .values(status="failed", error=msg, finished_at=now)
        )
        await db.commit()
    reaped = subs.rowcount + runs.rowcount + scans.rowcount
    if reaped:
        logger.warning("Reaped %d stale job row(s)", reaped)


async def startup(ctx: dict) -> None:
    import logging as _logging
    _logging.basicConfig(level=_logging.INFO, format="%(levelname)s %(name)s %(message)s")
    validate_secrets(settings)
    logger.info("Worker starting up (max_jobs=%d, job_timeout=%ds)", _MAX_JOBS, _JOB_TIMEOUT)
    await _reap_stale_jobs()


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
    max_jobs = _MAX_JOBS
    job_timeout = _JOB_TIMEOUT
