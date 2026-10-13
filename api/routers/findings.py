from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from access import can_see_repo, get_visible_finding
from auth import get_current_user
from database import get_db
from models import AuditLog, Finding, Submission, User
from schemas import AuditLogResponse, BulkDispositionRequest, DispositionRequest, FindingResponse

router = APIRouter(prefix="/findings", tags=["findings"])


def _dispose(db: AsyncSession, finding: Finding, body: DispositionRequest, user: User) -> None:
    finding.disposition = body.disposition.value
    finding.disposed_by = user.username
    finding.disposed_at = datetime.now(UTC)
    db.add(AuditLog(submission_id=finding.submission_id, finding_id=finding.id,
                    analyst=user.username, action=body.disposition.value, note=body.note))


@router.post("/bulk-disposition", response_model=list[FindingResponse])
async def set_dispositions(
    body: BulkDispositionRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Give several findings the same disposition and note, all or nothing."""
    ids = list(dict.fromkeys(body.finding_ids))
    findings = (await db.execute(select(Finding).where(Finding.id.in_(ids)))).scalars().all()
    repos = dict((await db.execute(
        select(Submission.id, Submission.repo_full_name)
        .where(Submission.id.in_({f.submission_id for f in findings}))
    )).all())
    visible = {name for name in set(repos.values()) if await can_see_repo(db, current_user, name)}
    if len(findings) != len(ids) or any(repos.get(f.submission_id) not in visible for f in findings):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Finding not found")
    for f in findings:
        _dispose(db, f, body, current_user)
    await db.commit()
    for f in findings:
        await db.refresh(f)
    order = {fid: i for i, fid in enumerate(ids)}
    return sorted(findings, key=lambda f: order[f.id])


@router.get("/{finding_id}", response_model=FindingResponse)
async def get_finding(finding: Finding = Depends(get_visible_finding)):
    return finding


@router.patch("/{finding_id}/disposition", response_model=FindingResponse)
async def set_disposition(
    body: DispositionRequest,
    finding: Finding = Depends(get_visible_finding),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _dispose(db, finding, body, current_user)
    await db.commit()
    await db.refresh(finding)
    return finding


@router.get("/{finding_id}/audit", response_model=list[AuditLogResponse])
async def get_finding_audit(
    finding: Finding = Depends(get_visible_finding),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(AuditLog).where(AuditLog.finding_id == finding.id).order_by(AuditLog.created_at)
    )
    return result.scalars().all()
