import time
from uuid import UUID

import activity
from arq.jobs import Job
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from access import can_see_group, get_visible_submission, restrict_to_visible
from app_config import SELF_UPDATE_REPO
from auth import get_current_user, require_admin
from database import get_db
from enums import BLOCKING_SEVERITIES, SEVERITY_ORDER, SubmissionStatus
from models import AppConfig, AuditLog, Finding, LlmRun, Repo, RepoGroup, Submission, User
from redis_util import ARQ_QUEUE, LLM_ACTIVE_SET, llm_job_key, llm_lock_key, llm_start_key
from schemas import FindingResponse, LlmRunResponse, SubmissionListResponse, SubmissionResponse
from worker.analysis.carryover import is_same_issue

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


async def _group_filter(db: AsyncSession, user: User, group_id: UUID | None) -> list:
    """WHERE clauses limiting submissions to *group_id*'s repos (none for no group)."""
    if group_id is None:
        return []
    if not await can_see_group(db, user, group_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Group not found")
    group_repos = (
        select(Repo.repo_full_name)
        .join(RepoGroup, RepoGroup.repo_id == Repo.id)
        .where(RepoGroup.group_id == group_id)
    )
    return [Submission.repo_full_name.in_(group_repos)]


def _ref(sub_branch: str | None, pr_number: int | None) -> str | None:
    return f"PR #{pr_number}" if pr_number else sub_branch


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

    filters = await _group_filter(db, current_user, group_id)
    if status_filter:
        filters.append(Submission.status == status_filter)

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


_ACTIVITY_LIMIT = 12
# What a submission's current status says happened last.
_STATUS_EVENTS = {
    SubmissionStatus.PENDING: "queued",
    SubmissionStatus.ANALYZING: "scanning",
    SubmissionStatus.NEEDS_REVIEW: "ready",
    SubmissionStatus.ERROR: "failed",
}


@router.get("/overview")
async def queue_overview(
    group_id: UUID | None = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Run counts per status and a recent-activity feed for the queue page.

    Activity merges scan progress (from each run's status) with analyst actions
    from the audit log; repeated actions on one run within an hour (e.g. many
    findings marked false positive) are collapsed into one entry.
    """
    filters = await _group_filter(db, current_user, group_id)
    visible = restrict_to_visible(select(Submission.id).where(*filters), current_user)

    counts = dict((await db.execute(
        select(Submission.status, func.count()).where(Submission.id.in_(visible)).group_by(Submission.status)
    )).all())

    recent = (await db.execute(
        select(Submission)
        .where(Submission.id.in_(visible), Submission.status.in_(list(_STATUS_EVENTS)))
        .order_by(Submission.updated_at.desc())
        .limit(_ACTIVITY_LIMIT)
    )).scalars().all()
    events = [{
        "kind": _STATUS_EVENTS[SubmissionStatus(s.status)], "at": s.updated_at,
        "submission_id": s.id, "repo": s.repo_full_name, "ref": _ref(s.branch, s.pr_number),
        "actor": None, "count": 1, "detail": s.error_message if s.status == SubmissionStatus.ERROR else None,
    } for s in recent]

    hour = func.date_trunc("hour", AuditLog.created_at)
    actions = (await db.execute(
        select(AuditLog.submission_id, AuditLog.analyst, AuditLog.action,
               func.max(AuditLog.created_at).label("at"), func.count().label("n"),
               Submission.repo_full_name, Submission.branch, Submission.pr_number)
        .join(Submission, Submission.id == AuditLog.submission_id)
        .where(AuditLog.submission_id.in_(visible))
        .group_by(AuditLog.submission_id, AuditLog.analyst, AuditLog.action, hour,
                  Submission.repo_full_name, Submission.branch, Submission.pr_number)
        .order_by(func.max(AuditLog.created_at).desc())
        .limit(_ACTIVITY_LIMIT)
    )).all()
    events += [{
        "kind": a.action, "at": a.at, "submission_id": a.submission_id, "repo": a.repo_full_name,
        "ref": _ref(a.branch, a.pr_number), "actor": a.analyst, "count": a.n, "detail": None,
    } for a in actions]

    events.sort(key=lambda e: e["at"], reverse=True)
    return {"status_counts": counts, "activity": events[:_ACTIVITY_LIMIT]}


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


@router.delete("/{submission_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_submission(
    submission_id: UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """Remove a run and its findings from the queue (admins only).

    Refused while the worker is still on it. The audit log keeps its entries
    and records the deletion. If the commit is still a branch or PR head, the
    next update check scans it again.
    """
    sub = await db.get(Submission, submission_id)
    if not sub:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Submission not found")
    if sub.status in (SubmissionStatus.PENDING, SubmissionStatus.ANALYZING) \
            or await request.app.state.redis.exists(llm_lock_key(sub.id)):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail="This run is still in progress; wait for it to finish")
    db.add(AuditLog(submission_id=sub.id, analyst=current_user.username, action="delete_submission",
                    note=f"Deleted {sub.repo_full_name}@{sub.commit_sha[:12]} ({sub.status})"))
    await db.delete(sub)
    await db.commit()


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


_FINISHED = (SubmissionStatus.NEEDS_REVIEW, SubmissionStatus.SIGNED_OFF)
_MAX_COMPARED = 2000


def _as_new(f: Finding) -> dict:
    return {"source": f.source, "title": f.title, "file_path": f.file_path, "line_start": f.line_start,
            "code_snippet": f.code_snippet, "cwe": f.cwe}


@router.get("/{submission_id}/compare")
async def compare_with_previous(
    sub: Submission = Depends(get_visible_submission),
    db: AsyncSession = Depends(get_db),
):
    """What changed since the previous finished scan of the same repo.

    The previous scan is the latest earlier one of the same PR, else of the
    same branch, else of the repo. Findings are matched the way false-positive
    decisions carry forward (same tool rule nearby, or a reworded LLM finding).
    Returns the new findings' IDs and the earlier findings that are gone.
    """
    earlier = (await db.execute(
        select(Submission)
        .where(Submission.repo_full_name == sub.repo_full_name, Submission.created_at < sub.created_at,
               Submission.status.in_(_FINISHED))
        .order_by(Submission.created_at.desc())
        .limit(50)
    )).scalars().all()
    same_pr = [s for s in earlier if sub.pr_number and s.pr_number == sub.pr_number]
    same_branch = [s for s in earlier if s.branch == sub.branch and not s.pr_number]
    prev = (same_pr or same_branch or earlier or [None])[0]
    if prev is None:
        return {"previous": None, "new_finding_ids": [], "fixed": []}

    async def findings_of(sid):
        return (await db.execute(
            select(Finding).where(Finding.submission_id == sid).limit(_MAX_COMPARED)
        )).scalars().all()

    now, before = await findings_of(sub.id), await findings_of(prev.id)
    matched_before: set = set()
    new_ids = []
    for f in now:
        hit = next((o for o in before if o.id not in matched_before and is_same_issue(_as_new(f), o)), None)
        if hit is None:
            new_ids.append(str(f.id))
        else:
            matched_before.add(hit.id)
    fixed = [o for o in before if o.id not in matched_before]
    return {
        "previous": {"id": str(prev.id), "commit_sha": prev.commit_sha, "branch": prev.branch,
                     "pr_number": prev.pr_number, "status": prev.status, "created_at": prev.created_at},
        "new_finding_ids": new_ids,
        "fixed": [FindingResponse.model_validate(o) for o in fixed],
    }


@router.post("/{submission_id}/rerun-llm", status_code=status.HTTP_202_ACCEPTED)
async def rerun_llm_endpoint(
    request: Request,
    sub: Submission = Depends(get_visible_submission),
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """Re-run the LLM review of a finished run (admins only: it replaces the LLM findings)."""
    redis = request.app.state.redis
    locked = await redis.set(llm_lock_key(sub.id), "1", nx=True, ex=7200)
    if not locked:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="LLM re-run already in progress")

    job = await request.app.state.arq_pool.enqueue_job("rerun_llm", str(sub.id))
    await redis.set(llm_job_key(sub.id), job.job_id, ex=86400)
    await redis.sadd(LLM_ACTIVE_SET, str(sub.id))
    activity.record(db, admin.username, "llm_rerun", f"{sub.repo_full_name}@{sub.commit_sha[:7]}")
    await db.commit()
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
