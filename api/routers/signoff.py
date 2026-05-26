from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from auth import get_current_user
from database import get_db
from github_client import post_github_check
from models import AuditLog, Finding, Submission, User
from routers.settings import get_github_config_internal
from schemas import SignoffRequest, SubmissionResponse

router = APIRouter(prefix="/submissions", tags=["signoff"])


@router.post("/{submission_id}/signoff", response_model=SubmissionResponse)
async def sign_off(
    submission_id: UUID,
    body: SignoffRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    sub = await db.get(Submission, submission_id)
    if not sub:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Submission not found")

    if sub.status == "signed_off":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Submission already signed off"
        )

    # Gate: all critical and high findings must have a disposition.
    result = await db.execute(
        select(Finding).where(
            Finding.submission_id == submission_id,
            Finding.severity.in_(("critical", "high")),
            Finding.disposition.is_(None),
        )
    )
    unactioned = result.scalars().all()
    if unactioned:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"{len(unactioned)} critical/high finding(s) still require a disposition "
                "before sign-off is allowed."
            ),
        )

    sub.status = "signed_off"

    db.add(
        AuditLog(
            submission_id=sub.id,
            finding_id=None,
            analyst=current_user.username,
            action="sign_off",
            note=body.note,
        )
    )

    await db.commit()
    await db.refresh(sub)

    # Update GitHub Check to success now that a human has reviewed and signed off.
    _, github_token = await get_github_config_internal(db)
    await post_github_check(
        repo=sub.repo_full_name,
        sha=sub.commit_sha,
        status="completed",
        conclusion="success",
        finding_count=0,
        token=github_token,
    )

    return sub
