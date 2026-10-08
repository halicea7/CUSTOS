from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from access import get_visible_submission
from app_config import SELF_UPDATE_REPO
from auth import get_current_user
from crypto import decrypt
from database import get_db
from enums import BLOCKING_SEVERITIES, Role, SubmissionStatus
from github_client import post_github_check
from models import AppConfig, AuditLog, Finding, Repo, Submission, User
from schemas import SignoffRequest, SubmissionResponse

router = APIRouter(prefix="/submissions", tags=["signoff"])


@router.post("/{submission_id}/signoff", response_model=SubmissionResponse)
async def sign_off(
    body: SignoffRequest,
    sub: Submission = Depends(get_visible_submission),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    self_repo = await db.get(AppConfig, SELF_UPDATE_REPO)
    if self_repo and self_repo.value == sub.repo_full_name and current_user.role != Role.ADMIN:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only admins can sign off commits to Custos itself: sign-off approves deploying them.",
        )
    if sub.status == SubmissionStatus.SIGNED_OFF:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Submission already signed off")
    if sub.status != SubmissionStatus.NEEDS_REVIEW:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Submission is '{sub.status}' and cannot be signed off yet",
        )

    # Gate: all critical and high findings must have a disposition.
    unactioned = (
        await db.execute(
            select(func.count())
            .select_from(Finding)
            .where(
                Finding.submission_id == sub.id,
                Finding.severity.in_(BLOCKING_SEVERITIES),
                Finding.disposition.is_(None),
            )
        )
    ).scalar_one()
    if unactioned:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"{unactioned} critical/high finding(s) still require a disposition "
                "before sign-off is allowed."
            ),
        )

    total = (
        await db.execute(select(func.count()).select_from(Finding).where(Finding.submission_id == sub.id))
    ).scalar_one()

    sub.status = SubmissionStatus.SIGNED_OFF.value
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

    # Mark the GitHub check as passed now that a human has reviewed it.
    repo_rec = (
        await db.execute(select(Repo).where(Repo.repo_full_name == sub.repo_full_name))
    ).scalar_one_or_none()
    github_token = decrypt(repo_rec.github_token_enc) if repo_rec else ""
    await post_github_check(
        repo=sub.repo_full_name,
        sha=sub.commit_sha,
        status="completed",
        conclusion="success",
        summary=f"Signed off by {current_user.username} after reviewing {total} finding(s).",
        token=github_token,
        check_run_id=sub.check_run_id,
    )
    return sub
