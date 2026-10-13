"""Two-stage sign-off.

1. An analyst signs off a run that needs review → it awaits approval.
2. An admin approves it (final: GitHub check passes, self-update may deploy)
   or sends it back with a reason → it needs review again.

An admin may also sign off a run needing review in one step. Both stages
enforce the same gates: every critical/high finding has a decision, and (when
enabled) so does every step of a live critical/high attack chain.
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from access import get_visible_submission
from app_config import SELF_UPDATE_REPO, load_app_config
from auth import get_current_user, require_admin
from crypto import decrypt
from database import get_db
from enums import BLOCKING_SEVERITIES, Disposition, Role, SubmissionStatus
from github_client import post_github_check
from models import AppConfig, AttackChain, AuditLog, Finding, Repo, Submission, User
from schemas import ReturnSignoffRequest, SignoffRequest, SubmissionResponse

router = APIRouter(prefix="/submissions", tags=["signoff"])

STAGE_ACTIONS = ("analyst_sign_off", "sign_off", "sign_off_returned")


async def _gate(db: AsyncSession, sub: Submission) -> None:
    findings = (await db.execute(
        select(Finding.id, Finding.severity, Finding.disposition).where(Finding.submission_id == sub.id)
    )).all()
    unactioned = sum(1 for f in findings if f.severity in BLOCKING_SEVERITIES and f.disposition is None)
    if unactioned:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"{unactioned} critical/high finding(s) still require a disposition before sign-off is allowed.",
        )
    if not (await load_app_config(db)).chain_gate:
        return
    by_id = {str(f.id): f for f in findings}
    pending: set[str] = set()
    for chain in (await db.execute(select(AttackChain).where(AttackChain.submission_id == sub.id))).scalars():
        if chain.severity not in BLOCKING_SEVERITIES:
            continue
        steps = [by_id.get(s.get("finding_id")) for s in chain.steps]
        if any(f is None or f.disposition == Disposition.FALSE_POSITIVE for f in steps):
            continue  # broken: a step was dismissed (or no longer exists)
        pending |= {str(f.id) for f in steps if f.disposition is None}
    if pending:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"{len(pending)} finding(s) in a critical/high attack chain still require a disposition "
                   "before sign-off is allowed.",
        )


async def _github_passed(db: AsyncSession, sub: Submission, approver: str) -> None:
    total = (
        await db.execute(select(func.count()).select_from(Finding).where(Finding.submission_id == sub.id))
    ).scalar_one()
    repo_rec = (
        await db.execute(select(Repo).where(Repo.repo_full_name == sub.repo_full_name))
    ).scalar_one_or_none()
    await post_github_check(
        repo=sub.repo_full_name,
        sha=sub.commit_sha,
        status="completed",
        conclusion="success",
        summary=f"Signed off by {approver} after reviewing {total} finding(s).",
        token=decrypt(repo_rec.github_token_enc) if repo_rec else "",
        check_run_id=sub.check_run_id,
    )


@router.post("/{submission_id}/signoff", response_model=SubmissionResponse)
async def sign_off(
    body: SignoffRequest,
    sub: Submission = Depends(get_visible_submission),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    admin = current_user.role == Role.ADMIN
    self_repo = await db.get(AppConfig, SELF_UPDATE_REPO)
    if self_repo and self_repo.value == sub.repo_full_name and not admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only admins can sign off commits to Custos itself: sign-off approves deploying them.",
        )
    if sub.status == SubmissionStatus.SIGNED_OFF:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Submission already signed off")
    if sub.status == SubmissionStatus.AWAITING_APPROVAL and not admin:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail="Already signed off by an analyst; waiting for an admin to approve it")
    if sub.status not in (SubmissionStatus.NEEDS_REVIEW, SubmissionStatus.AWAITING_APPROVAL):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Submission is '{sub.status}' and cannot be signed off yet",
        )
    await _gate(db, sub)

    final = admin
    sub.status = (SubmissionStatus.SIGNED_OFF if final else SubmissionStatus.AWAITING_APPROVAL).value
    db.add(AuditLog(submission_id=sub.id, finding_id=None, analyst=current_user.username,
                    action="sign_off" if final else "analyst_sign_off", note=body.note))
    await db.commit()
    await db.refresh(sub)
    if final:
        # The GitHub check passes only once an admin has approved.
        await _github_passed(db, sub, current_user.username)
    return sub


@router.post("/{submission_id}/signoff/return", response_model=SubmissionResponse)
async def return_sign_off(
    body: ReturnSignoffRequest,
    sub: Submission = Depends(get_visible_submission),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """Send an analyst's sign-off back for more review, with the reason."""
    if sub.status != SubmissionStatus.AWAITING_APPROVAL:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="This run isn't awaiting approval")
    sub.status = SubmissionStatus.NEEDS_REVIEW.value
    db.add(AuditLog(submission_id=sub.id, finding_id=None, analyst=current_user.username,
                    action="sign_off_returned", note=body.note))
    await db.commit()
    await db.refresh(sub)
    return sub


@router.get("/{submission_id}/signoffs")
async def sign_off_history(
    sub: Submission = Depends(get_visible_submission),
    db: AsyncSession = Depends(get_db),
):
    """Every sign-off stage of a run, oldest first, with its comment."""
    rows = (await db.execute(
        select(AuditLog).where(AuditLog.submission_id == sub.id, AuditLog.action.in_(STAGE_ACTIONS))
        .order_by(AuditLog.created_at)
    )).scalars().all()
    return [{"action": r.action, "by": r.analyst, "note": r.note, "at": r.created_at} for r in rows]


@router.get("/{submission_id}/chains")
async def attack_chains(
    sub: Submission = Depends(get_visible_submission),
    db: AsyncSession = Depends(get_db),
):
    """The run's attack chains (LLM estimates), and whether critical/high ones gate sign-off.

    Broken/live state isn't stored: the page derives it from the current decisions.
    """
    rows = (await db.execute(
        select(AttackChain).where(AttackChain.submission_id == sub.id).order_by(AttackChain.created_at)
    )).scalars().all()
    cfg = await load_app_config(db)
    return {"gate": cfg.chain_gate, "enabled": cfg.chains_enabled, "chains": [
        {"id": str(c.id), "title": c.title, "severity": c.severity, "confidence": c.confidence,
         "narrative": c.narrative, "steps": c.steps, "break_index": c.break_index} for c in rows]}
