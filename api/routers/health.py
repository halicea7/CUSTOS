import json
from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from auth import get_current_user
from database import get_db
from models import SelfScan, SelfScanFinding, User

router = APIRouter(prefix="/health", tags=["health-dashboard"])


def _scan_to_dict(s: SelfScan) -> dict:
    counts = {}
    if s.finding_counts:
        try:
            counts = json.loads(s.finding_counts)
        except Exception:
            pass
    return {
        "id": str(s.id),
        "status": s.status,
        "overall_health": s.overall_health,
        "triggered_by": s.triggered_by,
        "triggered_by_user": s.triggered_by_user,
        "finding_counts": counts,
        "config_issue_count": s.config_issue_count,
        "started_at": s.started_at.isoformat() if s.started_at else None,
        "finished_at": s.finished_at.isoformat() if s.finished_at else None,
        "error": s.error,
    }


def _finding_to_dict(f: SelfScanFinding) -> dict:
    return {
        "id": str(f.id),
        "scan_id": str(f.scan_id),
        "source": f.source,
        "category": f.category,
        "severity": f.severity,
        "title": f.title,
        "description": f.description,
        "file_path": f.file_path,
        "line_start": f.line_start,
        "line_end": f.line_end,
        "cwe": f.cwe,
        "remediation": f.remediation,
        "llm_reasoning": f.llm_reasoning,
    }


@router.get("/status")
async def health_dashboard_status(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    latest_result = await db.execute(
        select(SelfScan)
        .where(SelfScan.status == "complete")
        .order_by(SelfScan.started_at.desc())
        .limit(1)
    )
    latest = latest_result.scalar_one_or_none()

    running_result = await db.execute(
        select(SelfScan)
        .where(SelfScan.status == "running")
        .order_by(SelfScan.started_at.desc())
        .limit(1)
    )
    running = running_result.scalar_one_or_none()

    return {
        "latest_scan": _scan_to_dict(latest) if latest else None,
        "running": running is not None,
        "running_scan_id": str(running.id) if running else None,
    }


@router.get("/scans")
async def list_scans(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    result = await db.execute(
        select(SelfScan).order_by(SelfScan.started_at.desc()).limit(20)
    )
    return [_scan_to_dict(s) for s in result.scalars().all()]


@router.get("/scans/{scan_id}/findings")
async def scan_findings(
    scan_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    scan = await db.get(SelfScan, scan_id)
    if not scan:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Scan not found")

    _SEV_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}
    result = await db.execute(
        select(SelfScanFinding).where(SelfScanFinding.scan_id == scan_id)
    )
    findings = result.scalars().all()
    return sorted(
        [_finding_to_dict(f) for f in findings],
        key=lambda f: _SEV_ORDER.get(f["severity"], 99),
    )


@router.post("/scan", status_code=status.HTTP_202_ACCEPTED)
async def trigger_scan(
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if user.role != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin role required")

    running_result = await db.execute(
        select(SelfScan).where(SelfScan.status == "running")
    )
    if running_result.scalar_one_or_none():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Scan already in progress")

    # Create the record immediately so GET /health/status sees running=true
    # on the very next poll — before the ARQ worker starts executing.
    scan = SelfScan(
        status="running",
        triggered_by="manual",
        triggered_by_user=user.username,
        started_at=datetime.now(timezone.utc),
    )
    db.add(scan)
    await db.commit()
    await db.refresh(scan)

    job = await request.app.state.arq_pool.enqueue_job(
        "scan_self", str(scan.id), "manual", user.username
    )
    return {"job_id": job.job_id, "scan_id": str(scan.id)}
