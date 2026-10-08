import time
from uuid import UUID

from arq.jobs import Job
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from access import can_see_group, get_visible_submission, restrict_to_visible
from app_config import SELF_UPDATE_REPO
from auth import get_current_user
from database import get_db
from enums import BLOCKING_SEVERITIES, SEVERITY_ORDER
from models import AppConfig, Finding, LlmRun, Repo, RepoGroup, Submission, User
from redis_util import ARQ_QUEUE, LLM_ACTIVE_SET, llm_job_key, llm_lock_key, llm_start_key
from schemas import FindingResponse, LlmRunResponse, SubmissionListResponse, SubmissionResponse

router = APIRouter(prefix="/submissions", tags=["submissions"])


async def _finding_counts(db: AsyncSession, submission_ids: list) -> dict:
    """Return {submission_id: {"critical": N, ...}} for the given IDs."""
    if not submission_ids:
        return {}
    rows = await db.execute(
        select(Finding.submission_id, Finding.severity, func.count().label("c"))
        .where(Finding.submission_id.in_(submission_ids))
        .group_by(Finding.submission_id, Finding.severity)
    )
    result: dict = {}
    for row in rows:
        result.setdefault(row.submission_id, {})[row.severity] = row.c
    return result


def _with_counts(sub: Submission, counts: dict | None) -> SubmissionResponse:
    resp = SubmissionResponse.model_validate(sub)
    resp.finding_counts = counts or None
    return resp


@router.get("", response_model=SubmissionListResponse)
async def list_submissions(
    status_filter: str | None = Query(None, alias="status"),
    group_id: UUID | None = Query(None),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # Unreviewed critical/high findings per submission, computed in one aggregate.
    unreviewed = (
        select(Finding.submission_id, func.count().label("n"))
        .where(Finding.severity.in_(BLOCKING_SEVERITIES), Finding.disposition.is_(None))
        .group_by(Finding.submission_id)
        .subquery()
    )

    filters = []
    if status_filter:
        filters.append(Submission.status == status_filter)
    if group_id is not None:
        if not await can_see_group(db, current_user, group_id):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Group not found")
        group_repos = (
            select(Repo.repo_full_name)
            .join(RepoGroup, RepoGroup.repo_id == Repo.id)
            .where(RepoGroup.group_id == group_id)
        )
        filters.append(Submission.repo_full_name.in_(group_repos))

    base = restrict_to_visible(select(Submission).where(*filters), current_user)
    total = (await db.execute(select(func.count()).select_from(base.subquery()))).scalar_one()

    q = (
        base.outerjoin(unreviewed, unreviewed.c.submission_id == Submission.id)
        .order_by(func.coalesce(unreviewed.c.n, 0).desc(), Submission.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    submissions = (await db.execute(q)).scalars().all()

    counts_map = await _finding_counts(db, [s.id for s in submissions])
    return SubmissionListResponse(
        submissions=[_with_counts(s, counts_map.get(s.id)) for s in submissions],
        total=total,
    )


@router.get("/llm-active")
async def llm_active_jobs(
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return submission IDs (visible to the caller) that have an active LLM re-run."""
    ids = list(await request.app.state.redis.smembers(LLM_ACTIVE_SET))
    if not ids:
        return {"active": []}
    q = restrict_to_visible(select(Submission.id).where(Submission.id.in_(ids)), current_user)
    return {"active": [str(i) for i in (await db.execute(q)).scalars().all()]}


@router.get("/{submission_id}", response_model=SubmissionResponse)
async def get_submission(
    sub: Submission = Depends(get_visible_submission),
    db: AsyncSession = Depends(get_db),
):
    counts_map = await _finding_counts(db, [sub.id])
    resp = _with_counts(sub, counts_map.get(sub.id))
    self_repo = await db.get(AppConfig, SELF_UPDATE_REPO)
    resp.is_self_update = bool(self_repo and self_repo.value == sub.repo_full_name)
    return resp


@router.get("/{submission_id}/llm-runs", response_model=list[LlmRunResponse])
async def list_llm_runs(
    sub: Submission = Depends(get_visible_submission),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(LlmRun).where(LlmRun.submission_id == sub.id).order_by(LlmRun.started_at.desc())
    )
    return result.scalars().all()


@router.get("/{submission_id}/findings", response_model=list[FindingResponse])
async def list_findings_for_submission(
    sub: Submission = Depends(get_visible_submission),
    db: AsyncSession = Depends(get_db),
):
    severity_rank = case(SEVERITY_ORDER, value=Finding.severity, else_=99)
    result = await db.execute(
        select(Finding)
        .where(Finding.submission_id == sub.id)
        .order_by(severity_rank, Finding.file_path, Finding.line_start)
    )
    return result.scalars().all()


@router.post("/{submission_id}/rerun-llm", status_code=status.HTTP_202_ACCEPTED)
async def rerun_llm_endpoint(
    request: Request,
    sub: Submission = Depends(get_visible_submission),
):
    redis = request.app.state.redis
    locked = await redis.set(llm_lock_key(sub.id), "1", nx=True, ex=7200)
    if not locked:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="LLM re-run already in progress")

    job = await request.app.state.arq_pool.enqueue_job("rerun_llm", str(sub.id))
    await redis.set(llm_job_key(sub.id), job.job_id, ex=86400)
    await redis.sadd(LLM_ACTIVE_SET, str(sub.id))
    return {"job_id": job.job_id}


@router.get("/{submission_id}/llm-status")
async def llm_status(
    request: Request,
    sub: Submission = Depends(get_visible_submission),
    db: AsyncSession = Depends(get_db),
):
    redis = request.app.state.redis
    job_id = await redis.get(llm_job_key(sub.id))
    start_ts = await redis.get(llm_start_key(sub.id))

    avg_row = await db.get(AppConfig, "llm_avg_duration_seconds")
    estimated = float(avg_row.value) if avg_row else 90.0

    if not job_id:
        return {"status": "idle", "elapsed": 0, "estimated": estimated, "progress": 0}

    job = Job(job_id=job_id, redis=request.app.state.arq_pool, _queue_name=ARQ_QUEUE)
    status_str = (await job.status()).value  # queued | deferred | in_progress | complete | not_found

    elapsed = (time.time() - float(start_ts)) if start_ts else 0

    if status_str in ("queued", "deferred"):
        return {"status": "queued", "elapsed": 0, "estimated": estimated, "progress": 0}

    if status_str == "in_progress":
        progress = min(elapsed / max(estimated, 1), 0.95)
        return {"status": "running", "elapsed": round(elapsed, 1), "estimated": estimated, "progress": round(progress, 3)}

    # Finished one way or the other — release the lock (the worker also does this).
    await redis.delete(llm_lock_key(sub.id))
    await redis.srem(LLM_ACTIVE_SET, str(sub.id))
    if status_str == "complete":
        info = await job.result_info()
        if info is None or info.success:
            return {"status": "complete", "elapsed": round(elapsed, 1), "estimated": estimated, "progress": 1.0}
    return {"status": "failed", "elapsed": round(elapsed, 1), "estimated": estimated, "progress": 0}
