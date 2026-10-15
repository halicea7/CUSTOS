import re
from datetime import UTC, datetime

import activity
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from access import can_see_repo, get_visible_finding
from auth import get_current_user
from database import get_db
from enums import Disposition
from models import AuditLog, Finding, Submission, User
from schemas import (
    AgentTriageRequest,
    AuditLogResponse,
    BulkDispositionRequest,
    DispositionRequest,
    FindingResponse,
)

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


def _plain(text: str | None, limit: int) -> str:
    """One line of plain text: the agent's words are untrusted."""
    return " ".join(re.sub(r"[\x00-\x1f\x7f]", " ", text or "").split())[:limit]


@router.post("/agent-triage", response_model=list[FindingResponse])
async def apply_agent_triage(
    body: AgentTriageRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Apply an AI agent's verdicts from REMEDIATIONS.md, as reviewed by the analyst: all or nothing.

    Each decision is the analyst's, recorded with a note saying it came from the agent.
    """
    sub = await db.get(Submission, body.submission_id)
    if not sub or not await can_see_repo(db, current_user, sub.repo_full_name):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Submission not found")
    items = {i.finding_id: i for i in body.items}
    findings = (await db.execute(
        select(Finding).where(Finding.id.in_(items), Finding.submission_id == sub.id)
    )).scalars().all()
    if len(findings) != len(items):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="Some findings aren't in this run (the results may be from another scan)")
    for f in findings:
        item = items[f.id]
        reason = _plain(item.reason, 600)
        if (item.disposition == Disposition.FALSE_POSITIVE and f.severity in ("critical", "high")
                and len(reason.split()) < 4):
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                                detail=f"Dismissing a {f.severity} finding needs a real reason: {f.title[:80]}")
        action = _plain(item.action, 40)
        note = f"Via AI agent (REMEDIATIONS.md): {item.verdict}{f', {action}' if action else ''}. {reason}"
        _dispose(db, f, DispositionRequest(disposition=item.disposition, note=note), current_user)
    counts = {d: sum(i.disposition == d for i in body.items) for d in Disposition}
    activity.record(db, current_user.username, "agent_triage",
                    f"{sub.repo_full_name}: " + ", ".join(f"{n} {d.value.replace('_', ' ')}" for d, n in counts.items() if n))
    await db.commit()
    for f in findings:
        await db.refresh(f)
    order = {i.finding_id: n for n, i in enumerate(body.items)}
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
