import time
from uuid import UUID

from arq.jobs import Job
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from access import get_accessible_submission, is_group_member, visible_repo_names
from auth import get_current_user
from database import get_db
from models import AppConfig, Finding, LlmRun, Repo, RepoGroup, Submission, User
from schemas import FindingResponse, SubmissionListResponse, SubmissionResponse


async def _finding_counts(db: AsyncSession, submission_ids: list) -> dict:
    """Return {str(submission_id): {"critical": N, ...}} for the given IDs."""
    if not submission_ids:
        return {}
    rows = await db.execute(
        select(Finding.submission_id, Finding.severity, func.count().label("c"))
        .where(Finding.submission_id.in_(submission_ids))
        .group_by(Finding.submission_id, Finding.severity)
    )
    result: dict = {}
    for row in rows:
        sid = str(row.submission_id)
        result.setdefault(sid, {})
        result[sid][row.severity] = row.c
    return result


def _with_counts(sub: Submission, counts: dict | None) -> SubmissionResponse:
    base = SubmissionResponse.model_validate(sub)
    data = base.model_dump()
    data["finding_counts"] = counts or None
    return SubmissionResponse(**data)

router = APIRouter(prefix="/submissions", tags=["submissions"])

_SEVERITY_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}


@router.get("", response_model=SubmissionListResponse)
async def list_submissions(
    status_filter: str | None = Query(None, alias="status"),
    group_id: UUID | None = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    q = select(Submission)
    if status_filter:
        q = q.where(Submission.status == status_filter)

    visible = await visible_repo_names(db, current_user)
    if group_id is not None:
        # Non-admins may only filter by groups they belong to.
        if not await is_group_member(db, current_user, group_id):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Group not found")
        rg = await db.execute(
            select(Repo.repo_full_name)
            .join(RepoGroup, RepoGroup.repo_id == Repo.id)
            .where(RepoGroup.group_id == group_id)
        )
        q = q.where(Submission.repo_full_name.in_(set(rg.scalars().all())))
    if visible is not None:
        q = q.where(Submission.repo_full_name.in_(visible))
    result = await db.execute(q)
    submissions = result.scalars().all()

    # Sort: unreviewed critical/high count DESC, then created_at DESC.
    unreviewed = await _unreviewed_critical_high_counts(db, [s.id for s in submissions])
    sorted_subs = sorted(
        submissions,
        key=lambda s: (-unreviewed.get(s.id, 0), -s.created_at.timestamp()),
    )

    counts_map = await _finding_counts(db, [s.id for s in sorted_subs])
    return SubmissionListResponse(
        submissions=[_with_counts(s, counts_map.get(str(s.id))) for s in sorted_subs],
        total=len(sorted_subs),
    )


@router.get("/{submission_id}/llm-runs")
async def list_llm_runs(
    submission_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: Submission = Depends(get_accessible_submission),
):
    result = await db.execute(
        select(LlmRun)
        .where(LlmRun.submission_id == submission_id)
        .order_by(LlmRun.started_at.desc())
    )
    runs = result.scalars().all()
    return [
        {
            "id": str(r.id),
            "triggered_by": r.triggered_by,
            "model": r.model,
            "status": r.status,
            "duration_seconds": r.duration_seconds,
            "findings_count": r.findings_count,
            "prompt_tokens": r.prompt_tokens,
            "completion_tokens": r.completion_tokens,
            "error": r.error,
            "started_at": r.started_at.isoformat() if r.started_at else None,
            "finished_at": r.finished_at.isoformat() if r.finished_at else None,
        }
        for r in runs
    ]


@router.get("/llm-active")
async def llm_active_jobs(
    request: Request,
    _: User = Depends(get_current_user),
):
    """Return submission IDs that currently have an active LLM re-run."""
    redis = request.app.state.redis
    ids = [
        k.replace("custos:llm_running:", "")
        async for k in redis.scan_iter(match="custos:llm_running:*")
    ]
    return {"active": ids}


@router.get("/{submission_id}", response_model=SubmissionResponse)
async def get_submission(
    submission_id: UUID,
    db: AsyncSession = Depends(get_db),
    sub: Submission = Depends(get_accessible_submission),
):
    counts_map = await _finding_counts(db, [submission_id])
    return _with_counts(sub, counts_map.get(str(submission_id)))


@router.get("/{submission_id}/findings", response_model=list[FindingResponse])
async def list_findings_for_submission(
    submission_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: Submission = Depends(get_accessible_submission),
):
    result = await db.execute(
        select(Finding).where(Finding.submission_id == submission_id)
    )
    findings = result.scalars().all()
    return sorted(findings, key=lambda f: _SEVERITY_ORDER.get(f.severity, 99))


@router.post("/{submission_id}/rerun-llm", status_code=status.HTTP_202_ACCEPTED)
async def rerun_llm_endpoint(
    submission_id: UUID,
    request: Request,
    _: Submission = Depends(get_accessible_submission),
):
    # Prevent concurrent re-runs.
    redis = request.app.state.redis
    lock_key = f"custos:llm_running:{submission_id}"
    locked = await redis.set(lock_key, "1", nx=True, ex=7200)
    if not locked:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="LLM re-run already in progress")

    job = await request.app.state.arq_pool.enqueue_job("rerun_llm", str(submission_id))
    await redis.set(f"custos:llm_job:{submission_id}", job.job_id, ex=86400)
    return {"job_id": job.job_id}


@router.get("/{submission_id}/llm-status")
async def llm_status(
    submission_id: UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
    _: Submission = Depends(get_accessible_submission),
):
    redis = request.app.state.redis
    job_id = await redis.get(f"custos:llm_job:{submission_id}")
    start_ts = await redis.get(f"custos:llm_start:{submission_id}")

    avg_row = await db.get(AppConfig, "llm_avg_duration_seconds")
    estimated = float(avg_row.value) if avg_row else 90.0

    if not job_id:
        return {"status": "idle", "elapsed": 0, "estimated": estimated, "progress": 0}

    job = Job(job_id=job_id, redis=request.app.state.arq_pool)
    job_status = await job.status()
    status_str = job_status.value  # "queued", "in_progress", "complete", "not_found", etc.

    elapsed = (time.time() - float(start_ts)) if start_ts else 0

    if status_str == "complete":
        # Clean up lock so another re-run can be triggered.
        await redis.delete(f"custos:llm_running:{submission_id}")
        return {"status": "complete", "elapsed": round(elapsed, 1), "estimated": estimated, "progress": 1.0}

    if status_str in ("queued", "deferred"):
        return {"status": "queued", "elapsed": 0, "estimated": estimated, "progress": 0}

    if status_str == "in_progress":
        progress = min(elapsed / max(estimated, 1), 0.95)
        return {"status": "running", "elapsed": round(elapsed, 1), "estimated": estimated, "progress": round(progress, 3)}

    # not_found or failed
    await redis.delete(f"custos:llm_running:{submission_id}")
    return {"status": "failed", "elapsed": round(elapsed, 1), "estimated": estimated, "progress": 0}


async def _unreviewed_critical_high_counts(db: AsyncSession, submission_ids: list) -> dict:
    """Return {submission_id: count of critical/high findings with no disposition}."""
    if not submission_ids:
        return {}
    rows = await db.execute(
        select(Finding.submission_id, func.count())
        .where(
            Finding.submission_id.in_(submission_ids),
            Finding.severity.in_(("critical", "high")),
            Finding.disposition.is_(None),
        )
        .group_by(Finding.submission_id)
    )
    return {sid: c for sid, c in rows.all()}
