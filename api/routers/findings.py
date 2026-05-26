from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from auth import get_current_user
from database import get_db
from models import AuditLog, Finding, User
from schemas import AuditLogResponse, DispositionRequest, FindingResponse

router = APIRouter(prefix="/findings", tags=["findings"])

_VALID_DISPOSITIONS = {"confirmed", "false_positive", "escalated"}


@router.get("/{finding_id}", response_model=FindingResponse)
async def get_finding(
    finding_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    finding = await db.get(Finding, finding_id)
    if not finding:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Finding not found")
    return finding


@router.patch("/{finding_id}/disposition", response_model=FindingResponse)
async def set_disposition(
    finding_id: UUID,
    body: DispositionRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if body.disposition not in _VALID_DISPOSITIONS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"disposition must be one of {sorted(_VALID_DISPOSITIONS)}",
        )

    finding = await db.get(Finding, finding_id)
    if not finding:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Finding not found")

    finding.disposition = body.disposition
    finding.disposed_by = current_user.username
    finding.disposed_at = datetime.utcnow()

    db.add(
        AuditLog(
            submission_id=finding.submission_id,
            finding_id=finding.id,
            analyst=current_user.username,
            action=body.disposition,
            note=body.note,
        )
    )

    await db.commit()
    await db.refresh(finding)
    return finding


@router.get("/{finding_id}/audit", response_model=list[AuditLogResponse])
async def get_finding_audit(
    finding_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    finding = await db.get(Finding, finding_id)
    if not finding:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Finding not found")

    result = await db.execute(
        select(AuditLog)
        .where(AuditLog.finding_id == finding_id)
        .order_by(AuditLog.created_at)
    )
    return result.scalars().all()
