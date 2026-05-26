import asyncio
import dataclasses
import json
import logging
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import delete as sql_delete, select

from config import settings
from database import async_session_factory
from github_client import post_github_check
from models import AppConfig, Finding, LlmRun, SelfScan, SelfScanFinding, Submission
from routers.settings import get_github_config_internal, load_app_config
from worker.analysis.clone import clone_repo
from worker.analysis.config_checks import run_config_checks
from worker.analysis.llm import call_ollama
from worker.analysis.sast import RawFinding, run_dep_audit, run_gitleaks, run_semgrep
from worker.analysis.synthesizer import dedup_raw_findings, synthesize

logger = logging.getLogger(__name__)


async def analyze_submission(ctx, submission_id: str) -> None:
    repo_path: str | None = None

    async with async_session_factory() as db:
        result = await db.execute(
            select(Submission).where(Submission.id == submission_id)
        )
        submission = result.scalar_one_or_none()
        if not submission:
            logger.error("Submission %s not found", submission_id)
            return

        submission.status = "analyzing"
        await db.commit()
        await db.refresh(submission)

        repo = submission.repo_full_name
        sha = submission.commit_sha

        cfg = await load_app_config(db)
        _, github_token = await get_github_config_internal(db)

        llm_run = LlmRun(
            submission_id=submission.id,
            triggered_by="initial",
            model=cfg.ollama_model,
            status="running",
            started_at=datetime.now(timezone.utc),
        )
        db.add(llm_run)
        await db.commit()

        try:
            repo_path = await clone_repo(
                url=submission.repo_url,
                sha=sha,
                base_dir=settings.CLONE_BASE_DIR,
            )

            semgrep_findings, gitleaks_findings, dep_findings = await asyncio.gather(
                run_semgrep(repo_path),
                run_gitleaks(repo_path),
                run_dep_audit(repo_path),
            )

            llm_start = time.time()
            ollama_result = await call_ollama(
                repo_path=repo_path,
                sast_context=semgrep_findings + gitleaks_findings + dep_findings,
                model=cfg.ollama_model,
                ollama_base_url=cfg.ollama_base_url,
                ollama_think=cfg.ollama_think,
                ollama_num_ctx=cfg.ollama_num_ctx,
                max_content_chars=cfg.llm_max_content_chars,
            )
            llm_duration = time.time() - llm_start

            all_findings = synthesize(
                semgrep_findings,
                gitleaks_findings,
                dep_findings,
                ollama_result.findings,
            )

            for f in all_findings:
                db.add(Finding(submission_id=submission.id, **f))

            llm_run.status = "complete"
            llm_run.duration_seconds = round(llm_duration, 1)
            llm_run.findings_count = len(ollama_result.findings)
            llm_run.prompt_tokens = ollama_result.prompt_tokens
            llm_run.completion_tokens = ollama_result.completion_tokens
            llm_run.finished_at = datetime.now(timezone.utc)

            submission.status = "needs_review"
            await db.commit()

            has_critical_high = any(
                f["severity"] in ("critical", "high") for f in all_findings
            )
            await post_github_check(
                repo=repo,
                sha=sha,
                status="completed",
                conclusion="action_required" if has_critical_high else "neutral",
                finding_count=len(all_findings),
                token=github_token,
            )

            logger.info(
                "Submission %s complete: %d findings (repo=%s sha=%s)",
                submission_id,
                len(all_findings),
                repo,
                sha[:8],
            )

        except Exception as exc:
            logger.exception(
                "Analysis failed for submission %s (repo=%s sha=%s)",
                submission_id,
                repo,
                sha[:8],
            )
            llm_run.status = "failed"
            llm_run.error = str(exc)
            llm_run.finished_at = datetime.now(timezone.utc)
            submission.status = "error"
            submission.error_message = str(exc)
            await db.commit()
            raise

        finally:
            if repo_path:
                shutil.rmtree(repo_path, ignore_errors=True)


async def rerun_llm(ctx, submission_id: str) -> None:
    """Re-run only the LLM phase using stored SAST findings as context."""
    repo_path: str | None = None
    start_time = time.time()
    arq_redis = ctx.get("redis")

    async with async_session_factory() as db:
        sub = await db.get(Submission, submission_id)
        if not sub:
            logger.error("Submission %s not found for LLM re-run", submission_id)
            return

        if arq_redis:
            await arq_redis.set(f"custos:llm_start:{submission_id}", str(start_time), ex=7200)

        cfg = await load_app_config(db)

        result = await db.execute(
            select(Finding).where(
                Finding.submission_id == sub.id,
                Finding.source != "llm",
            )
        )
        sast_context = [
            RawFinding(
                source=f.source,
                severity=f.severity,
                title=f.title,
                description=f.description,
                file_path=f.file_path,
                line_start=f.line_start,
                line_end=f.line_end,
                cwe=f.cwe,
                code_snippet=f.code_snippet,
                remediation=f.remediation,
            )
            for f in result.scalars().all()
        ]

        llm_run = LlmRun(
            submission_id=sub.id,
            triggered_by="rerun",
            model=cfg.ollama_model,
            status="running",
            started_at=datetime.now(timezone.utc),
        )
        db.add(llm_run)
        await db.commit()

        try:
            repo_path = await clone_repo(
                url=sub.repo_url,
                sha=sub.commit_sha,
                base_dir=settings.CLONE_BASE_DIR,
            )

            ollama_result = await call_ollama(
                repo_path=repo_path,
                sast_context=sast_context,
                model=cfg.ollama_model,
                ollama_base_url=cfg.ollama_base_url,
                ollama_think=cfg.ollama_think,
                ollama_num_ctx=cfg.ollama_num_ctx,
                max_content_chars=cfg.llm_max_content_chars,
            )

            await db.execute(
                sql_delete(Finding).where(
                    Finding.submission_id == sub.id,
                    Finding.source == "llm",
                )
            )
            for f in ollama_result.findings:
                db.add(Finding(submission_id=sub.id, **dataclasses.asdict(f)))

            duration = time.time() - start_time

            llm_run.status = "complete"
            llm_run.duration_seconds = round(duration, 1)
            llm_run.findings_count = len(ollama_result.findings)
            llm_run.prompt_tokens = ollama_result.prompt_tokens
            llm_run.completion_tokens = ollama_result.completion_tokens
            llm_run.finished_at = datetime.now(timezone.utc)
            await db.commit()

            logger.info(
                "LLM re-run complete for %s: %d findings in %.1fs",
                submission_id, len(ollama_result.findings), duration,
            )

            avg_row = await db.get(AppConfig, "llm_avg_duration_seconds")
            if avg_row:
                avg_row.value = str(round(0.7 * float(avg_row.value) + 0.3 * duration, 1))
                avg_row.updated_by = "system"
            else:
                db.add(AppConfig(key="llm_avg_duration_seconds", value=str(round(duration, 1)), updated_by="system"))
            await db.commit()

        except Exception as exc:
            logger.exception("LLM re-run failed for submission %s", submission_id)
            llm_run.status = "failed"
            llm_run.error = str(exc)
            llm_run.finished_at = datetime.now(timezone.utc)
            await db.commit()
            raise

        finally:
            if repo_path:
                shutil.rmtree(repo_path, ignore_errors=True)
            if arq_redis:
                await arq_redis.delete(f"custos:llm_start:{submission_id}")


_SOURCE_CATEGORY = {
    "semgrep": "sast",
    "gitleaks": "secrets",
    "pip_audit": "dependencies",
    "npm_audit": "dependencies",
    "config": "config",
    "llm": "llm",
}


async def scan_self(
    ctx,
    existing_scan_id: str | None = None,
    triggered_by: str = "scheduled",
    triggered_by_user: str | None = None,
) -> None:
    """Full security self-assessment of the Custos codebase."""
    from uuid import UUID as _UUID
    custos_path = str(Path(__file__).parent.parent)

    async with async_session_factory() as db:
        if existing_scan_id:
            # Record was pre-created by the API endpoint — reuse it.
            scan = await db.get(SelfScan, _UUID(existing_scan_id))
            if not scan:
                logger.error("SelfScan %s not found — creating new record", existing_scan_id)
                scan = None

        if not existing_scan_id or scan is None:
            # Cron path: create the record here.
            scan = SelfScan(
                status="running",
                triggered_by=triggered_by,
                triggered_by_user=triggered_by_user,
                started_at=datetime.now(timezone.utc),
            )
            db.add(scan)
            await db.commit()
            await db.refresh(scan)

        scan_id = scan.id

        try:
            cfg = await load_app_config(db)

            semgrep_findings, gitleaks_findings, dep_findings, config_findings = await asyncio.gather(
                run_semgrep(custos_path),
                run_gitleaks(custos_path),
                run_dep_audit(custos_path),
                run_config_checks(db),
            )

            sast_context = semgrep_findings + gitleaks_findings + dep_findings + config_findings

            ollama_result = await call_ollama(
                repo_path=custos_path,
                sast_context=sast_context,
                model=cfg.ollama_model,
                ollama_base_url=cfg.ollama_base_url,
                ollama_think=cfg.ollama_think,
                ollama_num_ctx=cfg.ollama_num_ctx,
                max_content_chars=cfg.llm_max_content_chars,
            )

            all_findings = dedup_raw_findings(sast_context + ollama_result.findings)
            sev_counts: dict[str, int] = {"critical": 0, "high": 0, "medium": 0, "low": 0, "info": 0}
            config_issue_count = 0

            for f in all_findings:
                sev_counts[f.severity] = sev_counts.get(f.severity, 0) + 1
                if f.source == "config":
                    config_issue_count += 1
                db.add(SelfScanFinding(
                    scan_id=scan_id,
                    source=f.source,
                    category=_SOURCE_CATEGORY.get(f.source, "sast"),
                    severity=f.severity,
                    title=f.title,
                    description=f.description,
                    file_path=f.file_path,
                    line_start=f.line_start,
                    line_end=f.line_end,
                    cwe=f.cwe,
                    remediation=f.remediation,
                    llm_reasoning=getattr(f, "llm_reasoning", None),
                ))

            if sev_counts["critical"] > 0:
                overall_health = "urgent"
            elif sev_counts["high"] > 0:
                overall_health = "warning"
            else:
                overall_health = "healthy"

            scan.status = "complete"
            scan.overall_health = overall_health
            scan.finding_counts = json.dumps(sev_counts)
            scan.config_issue_count = config_issue_count
            scan.finished_at = datetime.now(timezone.utc)
            await db.commit()

            logger.info(
                "Self-scan complete: %s health, %d findings",
                overall_health,
                len(all_findings),
            )

        except Exception as exc:
            logger.exception("Self-scan failed")
            scan.status = "failed"
            scan.error = str(exc)
            scan.finished_at = datetime.now(timezone.utc)
            await db.commit()
            raise
