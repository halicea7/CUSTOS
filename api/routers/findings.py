from datetime import UTC, datetime

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from access import get_visible_finding
from auth import get_current_user
from database import get_db
from models import AuditLog, Finding, User
from schemas import AuditLogResponse, DispositionRequest, FindingResponse

router = APIRouter(prefix="/findings", tags=["findings"])


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
    finding.disposition = body.disposition.value
    finding.disposed_by = current_user.username
    finding.disposed_at = datetime.now(UTC)

    db.add(
        AuditLog(
            submission_id=finding.submission_id,
            finding_id=finding.id,
            analyst=current_user.username,
            action=body.disposition.value,
            note=body.note,
        )
    )

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
