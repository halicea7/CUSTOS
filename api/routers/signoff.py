"""Two-stage sign-off.

1. An analyst signs off a run that needs review → it awaits approval.
2. An admin approves it (final: GitHub check passes, self-update may deploy)
   or sends it back with a reason → it needs review again.

An admin may also sign off a run needing review in one step. Both stages
enforce the same gates: every critical/high finding has a decision, and (when
enabled) so does every step of a live critical/high attack chain.
"""

from datetime import UTC, datetime
from uuid import UUID

import activity
import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from access import get_visible_submission
from app_config import SELF_UPDATE_REPO, build_llm_provider, load_app_config
from auth import get_current_user, require_admin
from crypto import decrypt
from database import get_db
from enums import BLOCKING_SEVERITIES, Disposition, Role, SubmissionStatus
from github_client import post_github_check
from models import AppConfig, AttackChain, AuditLog, Finding, LlmRun, Repo, Submission, User
from schemas import ChainPocResponse, ReturnSignoffRequest, SignoffRequest, SubmissionResponse
from worker.analysis import poc
from worker.analysis.llm import InvalidJson, LlmError, complete

router = APIRouter(prefix="/submissions", tags=["signoff"])

STAGE_ACTIONS = ("analyst_sign_off", "sign_off", "sign_off_returned")
_POC_TIMEOUT_SECONDS = 180


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
    last = (await db.execute(
        select(LlmRun).where(LlmRun.submission_id == sub.id, LlmRun.triggered_by == "chains")
        .order_by(LlmRun.started_at.desc()).limit(1)
    )).scalar_one_or_none()
    analysis = last and {"status": last.status, "note": last.error, "model": last.model, "at": last.finished_at,
                         "prompt_tokens": last.prompt_tokens, "completion_tokens": last.completion_tokens}
    return {"gate": cfg.chain_gate, "enabled": cfg.chains_enabled, "analysis": analysis, "chains": [
        {"id": str(c.id), "title": c.title, "severity": c.severity, "confidence": c.confidence,
         "narrative": c.narrative, "steps": c.steps, "break_index": c.break_index,
         # Whether an admin already verified this chain by hand; the PoC itself is admin-only (see below).
         "has_poc": c.poc is not None, "poc_generated_by": c.poc_generated_by,
         "poc_generated_at": c.poc_generated_at} for c in rows]}


async def _get_chain(db: AsyncSession, sub: Submission, chain_id: UUID) -> AttackChain:
    chain = await db.get(AttackChain, chain_id)
    if not chain or chain.submission_id != sub.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Attack chain not found")
    return chain


async def _live_steps(db: AsyncSession, chain: AttackChain) -> list[dict]:
    """The chain's steps with their current Finding rows, in attack order.

    Raises 409 if the chain is broken (a step's finding is gone or dismissed) or
    too short to verify: a PoC for a chain that no longer holds together would
    be describing an attack that, as triaged, doesn't exist.
    """
    ids = [s.get("finding_id") for s in chain.steps]
    rows = (await db.execute(select(Finding).where(Finding.id.in_(ids)))).scalars().all()
    by_id = {str(f.id): f for f in rows}
    steps = []
    for i, s in enumerate(chain.steps, 1):
        f = by_id.get(s.get("finding_id"))
        if f is None or f.disposition == Disposition.FALSE_POSITIVE:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                detail="This chain is broken (a step was dismissed, or no longer exists) and can't be verified. "
                       "Re-run the LLM to refresh attack chains against the current findings.",
            )
        steps.append({"label": f"Step {i}", "role": s.get("role", "pivot"), "why": s.get("why", ""), "finding": f})
    if len(steps) < 2:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="This chain no longer has enough steps to verify.")
    return steps


def _poc_response(chain: AttackChain) -> ChainPocResponse:
    data = chain.poc or {}
    return ChainPocResponse(
        summary=data.get("summary", ""), preconditions=data.get("preconditions", ""),
        steps=data.get("steps", []), impact=data.get("impact", ""), caveats=data.get("caveats", ""),
        model=chain.poc_model or "", generated_by=chain.poc_generated_by or "",
        generated_at=chain.poc_generated_at,
    )


@router.post("/{submission_id}/chains/{chain_id}/poc", response_model=ChainPocResponse)
async def generate_chain_poc(
    chain_id: UUID,
    sub: Submission = Depends(get_visible_submission),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """Admin-only: ask the LLM for concrete steps to verify one live attack chain by hand.

    Custos never runs any of this itself. It's generated only when an admin asks for
    this specific chain, stored only for this chain, and never included in exports;
    an admin reads it, decides whether and where it's safe to try, and runs it
    themselves. Regenerating overwrites the previous PoC for this chain.
    """
    chain = await _get_chain(db, sub, chain_id)
    steps = await _live_steps(db, chain)

    cfg = await load_app_config(db)
    provider = await build_llm_provider(db, cfg)
    user_prompt = poc.prompt(chain, steps)
    timeout = httpx.Timeout(_POC_TIMEOUT_SECONDS, connect=15)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            try:
                result = await complete(client, provider, user_prompt, poc.SPEC)
            except InvalidJson:
                result = await complete(client, provider, user_prompt, poc.SPEC)
    except LlmError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, detail=f"Couldn't generate a PoC: {exc}") from None

    chain.poc = poc.validate(result.value or {}, steps)
    chain.poc_model = provider.label
    chain.poc_generated_by = current_user.username
    chain.poc_generated_at = datetime.now(UTC)
    activity.record(db, current_user.username, "chain_poc_generated", f"{sub.repo_full_name}: {chain.title[:80]}")
    await db.commit()
    return _poc_response(chain)


@router.get("/{submission_id}/chains/{chain_id}/poc", response_model=ChainPocResponse)
async def get_chain_poc(
    chain_id: UUID,
    sub: Submission = Depends(get_visible_submission),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    chain = await _get_chain(db, sub, chain_id)
    if chain.poc is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="No PoC has been generated for this chain yet")
    return _poc_response(chain)


@router.delete("/{submission_id}/chains/{chain_id}/poc", status_code=status.HTTP_204_NO_CONTENT)
async def delete_chain_poc(
    chain_id: UUID,
    sub: Submission = Depends(get_visible_submission),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    chain = await _get_chain(db, sub, chain_id)
    chain.poc = chain.poc_model = chain.poc_generated_by = chain.poc_generated_at = None
    activity.record(db, current_user.username, "chain_poc_cleared", f"{sub.repo_full_name}: {chain.title[:80]}")
    await db.commit()
