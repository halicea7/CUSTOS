import asyncio
import json
import re
import time
from datetime import UTC, datetime
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import case, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app_config import load_app_config, load_responses_api_key
from auth import get_current_user, require_admin
from database import get_db
from enums import SEVERITY_ORDER
from models import SelfScan, SelfScanFinding, User
from redis_util import ARQ_QUEUE, scan_stages_key
from worker.analysis.llm import PROVIDER_RESPONSES, responses_endpoint

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


_LLM_PROBE_KEY = "custos:health:llm-probe"
_LLM_PROBE_TTL = 60          # seconds: the page polls; don't hammer the LLM server
_PROBE_TIMEOUT = 5


def _svc(name: str, state: str, detail: str) -> dict:
    return {"name": name, "state": state, "detail": detail}   # state: ok | warn | down | off


async def _probe_llm(db: AsyncSession) -> dict:
    cfg = await load_app_config(db)
    if cfg.llm_provider == PROVIDER_RESPONSES:
        name, url = "LLM (Responses API)", responses_endpoint(cfg.responses_base_url).removesuffix("/responses") + "/models"
        key = await load_responses_api_key(db, cfg.responses_base_url)
        headers = {"Authorization": f"Bearer {key}"} if key else {}
    else:
        name, url, headers = "LLM (Ollama)", f"{cfg.ollama_base_url}/api/tags", {}
    try:
        async with httpx.AsyncClient(timeout=_PROBE_TIMEOUT) as client:
            resp = await client.get(url, headers=headers)
    except httpx.TimeoutException:
        return _svc(name, "down", f"no answer within {_PROBE_TIMEOUT}s (a firewall may be dropping traffic)")
    except httpx.HTTPError as exc:
        return _svc(name, "down", f"unreachable ({type(exc).__name__})")
    if resp.status_code in (401, 403):
        return _svc(name, "warn", "reachable, but the API key was rejected")
    if resp.status_code >= 400 and resp.status_code != 404:
        return _svc(name, "warn", f"reachable, HTTP {resp.status_code}")
    return _svc(name, "ok", "reachable")


@router.get("/services")
async def services_status(
    request: Request,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    """Is each part of Custos up? Database, Redis, the worker's heartbeat,
    the LLM (probed at most once a minute) and whether SentinelOne is set up."""
    redis = request.app.state.redis
    out = [_svc("API", "ok", "serving requests")]

    t0 = time.monotonic()
    try:
        await db.execute(text("SELECT 1"))
        out.append(_svc("Postgres", "ok", f"{(time.monotonic() - t0) * 1000:.0f} ms"))
    except Exception as exc:  # noqa: BLE001 (report any failure as down)
        out.append(_svc("Postgres", "down", type(exc).__name__))

    try:
        await asyncio.wait_for(redis.ping(), _PROBE_TIMEOUT)
        out.append(_svc("Redis", "ok", "responding"))
        beat = await redis.get(f"{ARQ_QUEUE}:health-check")
    except Exception as exc:  # noqa: BLE001
        out.append(_svc("Redis", "down", type(exc).__name__))
        beat = None
    if isinstance(beat, bytes):
        beat = beat.decode()
    if beat:
        stats = dict(re.findall(r"(\w+)=(\d+)", beat))
        out.append(_svc("Worker", "ok",
                        f"{stats.get('j_ongoing', '0')} running · {stats.get('queued', '0')} queued"))
    else:
        out.append(_svc("Worker", "down", "no heartbeat in the last minute"))

    cached = None
    try:
        cached = await redis.get(_LLM_PROBE_KEY)
    except Exception:  # noqa: BLE001
        pass
    if cached:
        llm = json.loads(cached)
    else:
        llm = await _probe_llm(db)
        try:
            await redis.set(_LLM_PROBE_KEY, json.dumps(llm), ex=_LLM_PROBE_TTL)
        except Exception:  # noqa: BLE001
            pass
    out.append(llm)

    cfg = await load_app_config(db)
    if not cfg.s1_enabled:
        out.append(_svc("SentinelOne", "off", "disabled in Settings"))
    elif not cfg.s1_token_set:
        out.append(_svc("SentinelOne", "warn", "enabled, but no API token is saved"))
    else:
        out.append(_svc("SentinelOne", "ok", "configured" + (" · policy set" if cfg.s1_policy_id else "")))
    return {"services": out, "checked_at": datetime.now(UTC)}


@router.get("/status")
async def health_dashboard_status(
    request: Request,
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

    # Real per-stage states published by the worker (None until it starts).
    stages = None
    if running is not None:
        raw = await request.app.state.redis.get(scan_stages_key(running.id))
        try:
            stages = json.loads(raw) if raw else None
        except ValueError:
            stages = None

    return {
        "latest_scan": _scan_to_dict(latest) if latest else None,
        "running": running is not None,
        "running_scan_id": str(running.id) if running else None,
        "running_started_at": running.started_at.isoformat() if running and running.started_at else None,
        "running_stages": stages,
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

    result = await db.execute(
        select(SelfScanFinding)
        .where(SelfScanFinding.scan_id == scan_id)
        .order_by(case(SEVERITY_ORDER, value=SelfScanFinding.severity, else_=99))
    )
    return [_finding_to_dict(f) for f in result.scalars().all()]


@router.post("/scan", status_code=status.HTTP_202_ACCEPTED)
async def trigger_scan(
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    running_result = await db.execute(
        select(SelfScan.id).where(SelfScan.status == "running").limit(1)
    )
    if running_result.first():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Scan already in progress")

    # Create the record immediately so GET /health/status sees running=true
    # on the very next poll — before the ARQ worker starts executing.
    scan = SelfScan(
        status="running",
        triggered_by="manual",
        triggered_by_user=user.username,
        started_at=datetime.now(UTC),
    )
    db.add(scan)
    await db.commit()
    await db.refresh(scan)

    job = await request.app.state.arq_pool.enqueue_job(
        "scan_self", str(scan.id), "manual", user.username
    )
    return {"job_id": job.job_id, "scan_id": str(scan.id)}
