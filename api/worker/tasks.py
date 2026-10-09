import asyncio
import json
import logging
import shutil
import subprocess
import tempfile
import time
from collections import Counter
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID

from sqlalchemy import delete as sql_delete
from sqlalchemy import select, update

from app_config import load_app_config, load_responses_api_key, load_s1_token
from config import settings
from crypto import decrypt
from database import async_session_factory
from enums import BLOCKING_SEVERITIES, RunStatus, SubmissionStatus
from github_client import post_github_check
from intake import check_repo_for_updates
from models import AppConfig, Finding, LlmRun, Repo, SelfScan, SelfScanFinding, Submission
from redis_util import LLM_ACTIVE_SET, llm_lock_key, llm_start_key
from schemas import AppConfigResponse
from worker.analysis.carryover import apply_previous_false_positives, audit_carried
from worker.analysis.clone import clone_repo, redact
from worker.analysis.config_checks import run_config_checks
from worker.analysis.llm import PROVIDER_OLLAMA, PROVIDER_RESPONSES, LlmError, LlmProvider, LlmResult, call_llm
from worker.analysis.sast import RawFinding, run_dep_audit, run_gitleaks, run_semgrep
from worker.analysis.sentinelone import RepoMeta, S1Error, S1Settings, run_sentinelone
from worker.analysis.synthesizer import dedup_raw_findings, synthesize
from worker.progress import StageTracker

logger = logging.getLogger(__name__)


def _now() -> datetime:
    return datetime.now(UTC)


class JobTimeout(RuntimeError):
    pass


@asynccontextmanager
async def _job_deadline(job_timeout: int):
    """Fail the job ourselves shortly before ARQ's own timeout fires.

    ARQ enforces job_timeout by cancelling the task, which is indistinguishable
    from a worker shutdown (where we *want* the row left as-is so the retry can
    resume). Raising an ordinary exception first lets the normal error path
    record the failure immediately instead of waiting for the stale-job reaper.
    """
    budget = max(job_timeout - 30, 1)
    try:
        async with asyncio.timeout(budget) as cm:
            yield
    except TimeoutError:
        if cm.expired():
            raise JobTimeout(f"Job exceeded its {job_timeout}s time limit") from None
        raise


async def _llm_provider(db, cfg: AppConfigResponse) -> LlmProvider:
    if cfg.llm_provider == PROVIDER_RESPONSES:
        return LlmProvider(
            kind=PROVIDER_RESPONSES,
            base_url=cfg.responses_base_url,
            model=cfg.responses_model,
            api_key=await load_responses_api_key(db, cfg.responses_base_url),
            reasoning_effort=cfg.responses_reasoning_effort,
            max_output_tokens=cfg.responses_max_output_tokens,
        )
    return LlmProvider(
        kind=PROVIDER_OLLAMA,
        base_url=cfg.ollama_base_url,
        model=cfg.ollama_model,
        ollama_think=cfg.ollama_think,
        ollama_num_ctx=cfg.ollama_num_ctx,
    )


async def _run_llm(
    repo_path: str, sast_context: list[RawFinding], cfg: AppConfigResponse, provider: LlmProvider
) -> LlmResult:
    return await call_llm(
        repo_path=repo_path,
        sast_context=sast_context,
        provider=provider,
        max_content_chars=cfg.llm_max_content_chars,
        max_file_size_kb=cfg.max_file_size_kb,
        max_files=cfg.max_files_per_repo,
    )


async def _run_sast(repo_path: str) -> list[RawFinding]:
    semgrep, gitleaks, deps = await asyncio.gather(
        run_semgrep(repo_path), run_gitleaks(repo_path), run_dep_audit(repo_path)
    )
    return semgrep + gitleaks + deps


def _finish_llm_run(run: LlmRun, result: LlmResult, duration: float) -> None:
    run.status = RunStatus.COMPLETE.value
    run.duration_seconds = round(duration, 1)
    run.findings_count = len(result.findings)
    run.prompt_tokens = result.prompt_tokens
    run.completion_tokens = result.completion_tokens
    run.finished_at = _now()
    if result.errors:
        run.error = redact(f"{len(result.errors)}/{result.batches} batch(es) failed: {result.errors[0]}")


def _fail_llm_run(run: LlmRun, exc: BaseException, *secrets: str) -> None:
    run.status = RunStatus.FAILED.value
    run.error = redact(str(exc) or type(exc).__name__, *secrets)[:2000]
    run.finished_at = _now()


async def _record_llm_duration(db, duration: float) -> None:
    """Exponential moving average used by the dashboard's progress estimate."""
    row = await db.get(AppConfig, "llm_avg_duration_seconds")
    if row:
        row.value = str(round(0.7 * float(row.value) + 0.3 * duration, 1))
        row.updated_by = "system"
    else:
        db.add(AppConfig(key="llm_avg_duration_seconds", value=str(round(duration, 1)), updated_by="system"))


def _check_summary(findings: list[dict], llm_error: str | None) -> str:
    counts = Counter(f["severity"] for f in findings)
    parts = [f"{counts[s]} {s}" for s in ("critical", "high", "medium", "low", "info") if counts[s]]
    summary = f"Found {len(findings)} finding(s)" + (f": {', '.join(parts)}." if parts else ".")
    if llm_error:
        summary += "\n\nLLM review did not complete; results are from static analysis only."
    return summary


async def _run_s1(
    db, cfg: AppConfigResponse, repo_path: str, repo_meta: RepoMeta | None
) -> tuple[list[RawFinding], str | None]:
    """Optional SentinelOne CNS layer. Never fails the submission: returns
    (findings, note) where *note* explains any problem for the analyst."""
    if not cfg.s1_enabled:
        return [], None
    token = await load_s1_token(db, cfg.s1_console_url) if cfg.s1_console_url else ""
    if not token or not cfg.s1_scope_id:
        return [], "SentinelOne scan skipped: console URL, scope ID or token not configured."
    s1 = S1Settings(
        console_url=cfg.s1_console_url, scope_type=cfg.s1_scope_type, scope_id=cfg.s1_scope_id,
        policy_id=cfg.s1_policy_id, token=token, scanners=tuple(cfg.s1_scanners), verify_secrets=cfg.s1_verify_secrets,
        publish=cfg.s1_publish,
    )
    try:
        result = await run_sentinelone(repo_path, s1, repo_meta)
    except S1Error as exc:
        logger.warning("SentinelOne layer failed: %s", exc)
        return [], f"SentinelOne scan failed: {redact(str(exc), token)}"[:1000]
    note = None
    if result.errors:
        note = f"SentinelOne: some scanners failed ({redact('; '.join(result.errors), token)})"[:1000]
    return result.findings, note


async def _repo_token(db, repo_full_name: str) -> str:
    repo_rec = (
        await db.execute(select(Repo).where(Repo.repo_full_name == repo_full_name))
    ).scalar_one_or_none()
    return decrypt(repo_rec.github_token_enc) if repo_rec else ""


async def analyze_submission(ctx, submission_id: str) -> None:
    repo_path: str | None = None

    async with async_session_factory() as db:
        submission = await db.get(Submission, UUID(submission_id))
        if not submission:
            logger.error("Submission %s not found", submission_id)
            return
        if submission.status not in (SubmissionStatus.PENDING, SubmissionStatus.ANALYZING):
            logger.info("Submission %s already %s — skipping", submission_id, submission.status)
            return

        # A retried job (worker restart) may have left partial results behind.
        await db.execute(sql_delete(Finding).where(Finding.submission_id == submission.id))
        submission.status = SubmissionStatus.ANALYZING.value
        submission.error_message = None
        await db.commit()

        repo = submission.repo_full_name
        sha = submission.commit_sha
        cfg = await load_app_config(db)
        provider = await _llm_provider(db, cfg)
        github_token = await _repo_token(db, repo)

        submission.check_run_id = await post_github_check(
            repo=repo, sha=sha, status="in_progress", token=github_token,
            check_run_id=submission.check_run_id,
        )
        llm_run = LlmRun(
            submission_id=submission.id,
            triggered_by="initial",
            model=provider.label,
            status=RunStatus.RUNNING.value,
            started_at=_now(),
        )
        db.add(llm_run)
        await db.commit()

        try:
            async with _job_deadline(cfg.worker_job_timeout):
                repo_path = await clone_repo(
                    url=submission.repo_url,
                    sha=sha,
                    base_dir=settings.CLONE_BASE_DIR,
                    github_token=github_token,
                )
                sast_findings = await _run_sast(repo_path)
                s1_findings, s1_note = await _run_s1(
                    db, cfg, repo_path, RepoMeta(full_name=submission.repo_full_name, branch=submission.branch)
                )
                sast_findings += s1_findings

                llm_findings: list[RawFinding] = []
                llm_error: str | None = None
                llm_start = time.monotonic()
                try:
                    result = await _run_llm(repo_path, sast_findings, cfg, provider)
                    llm_findings = result.findings
                    _finish_llm_run(llm_run, result, time.monotonic() - llm_start)
                    await _record_llm_duration(db, time.monotonic() - llm_start)
                except LlmError as exc:
                    # Keep the SAST results — a down LLM shouldn't hide real findings.
                    logger.warning("LLM phase failed for %s: %s", submission_id, exc)
                    _fail_llm_run(llm_run, exc, github_token)
                    llm_error = llm_run.error

                all_findings = synthesize(sast_findings, llm_findings)
                await _save_findings(db, submission, all_findings)

                submission.status = SubmissionStatus.NEEDS_REVIEW.value
                notes = []
                if llm_error:
                    notes.append(f"LLM review failed; showing static analysis only. {llm_error}")
                if s1_note:
                    notes.append(s1_note)
                submission.error_message = "\n".join(notes) or None
                await db.commit()

                blocking = any(
                    f["severity"] in BLOCKING_SEVERITIES and not f.get("disposition") for f in all_findings
                )
                await post_github_check(
                    repo=repo,
                    sha=sha,
                    status="completed",
                    conclusion="action_required" if blocking or llm_error else "neutral",
                    summary=_check_summary(all_findings, llm_error),
                    token=github_token,
                    check_run_id=submission.check_run_id,
                )
                logger.info(
                    "Submission %s complete: %d findings (repo=%s sha=%s)",
                    submission_id, len(all_findings), repo, sha[:8],
                )

        except Exception as exc:
            logger.exception("Analysis failed for submission %s (repo=%s sha=%s)", submission_id, repo, sha[:8])
            await db.rollback()  # discard half-written findings
            await db.refresh(submission)
            await db.refresh(llm_run)
            message = redact(str(exc) or type(exc).__name__, github_token)[:2000]
            if llm_run.status == RunStatus.RUNNING:
                _fail_llm_run(llm_run, exc, github_token)
            submission.status = SubmissionStatus.ERROR.value
            submission.error_message = message
            await db.commit()
            await post_github_check(
                repo=repo,
                sha=sha,
                status="completed",
                conclusion="failure",
                summary=f"Custos could not analyse this commit: {message[:500]}",
                token=github_token,
                check_run_id=submission.check_run_id,
            )
            raise

        finally:
            if repo_path:
                shutil.rmtree(repo_path, ignore_errors=True)


async def rerun_llm(ctx, submission_id: str) -> None:
    """Re-run only the LLM phase using stored SAST findings as context."""
    repo_path: str | None = None
    start_time = time.time()
    arq_redis = ctx.get("redis")

    try:
        async with async_session_factory() as db:
            sub = await db.get(Submission, UUID(submission_id))
            if not sub:
                logger.error("Submission %s not found for LLM re-run", submission_id)
                return

            if arq_redis:
                await arq_redis.set(llm_start_key(submission_id), str(start_time), ex=7200)

            cfg = await load_app_config(db)

            provider = await _llm_provider(db, cfg)
            github_token = await _repo_token(db, sub.repo_full_name)

            result = await db.execute(
                select(Finding).where(Finding.submission_id == sub.id, Finding.source != "llm")
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
                model=provider.label,
                status=RunStatus.RUNNING.value,
                started_at=_now(),
            )
            db.add(llm_run)
            await db.commit()

            try:
                async with _job_deadline(cfg.worker_job_timeout):
                    repo_path = await clone_repo(
                        url=sub.repo_url,
                        sha=sub.commit_sha,
                        base_dir=settings.CLONE_BASE_DIR,
                        github_token=github_token,
                    )
                    llm_result = await _run_llm(repo_path, sast_context, cfg, provider)

                    # Same dedup as the initial run: drop LLM findings the tools already cover.
                    new_llm = [
                        f for f in dedup_raw_findings(sast_context + llm_result.findings)
                        if f.source == "llm"
                    ]
                    # Decisions on the findings being replaced are matched before they go.
                    new_dicts = synthesize(new_llm)
                    carried = await apply_previous_false_positives(db, sub.repo_full_name, new_dicts)
                    await db.execute(
                        sql_delete(Finding).where(Finding.submission_id == sub.id, Finding.source == "llm")
                    )
                    await _save_findings(db, sub, new_dicts, carried)

                    duration = time.time() - start_time
                    llm_result.findings = new_llm
                    _finish_llm_run(llm_run, llm_result, duration)
                    if sub.error_message:
                        # Drop only the LLM note; keep others (e.g. SentinelOne).
                        kept = [ln for ln in sub.error_message.splitlines() if not ln.startswith("LLM review failed")]
                        sub.error_message = "\n".join(kept) or None
                    await _record_llm_duration(db, duration)
                    await db.commit()
                    logger.info(
                        "LLM re-run complete for %s: %d findings in %.1fs",
                        submission_id, len(new_llm), duration,
                    )

            except Exception as exc:
                logger.exception("LLM re-run failed for submission %s", submission_id)
                await db.rollback()
                await db.refresh(llm_run)
                _fail_llm_run(llm_run, exc, github_token)
                await db.commit()
                raise
    finally:
        if repo_path:
            shutil.rmtree(repo_path, ignore_errors=True)
        if arq_redis:
            await arq_redis.delete(llm_start_key(submission_id), llm_lock_key(submission_id))
            await arq_redis.srem(LLM_ACTIVE_SET, submission_id)


def _self_scan_stages(cfg: AppConfigResponse, provider: LlmProvider) -> list[tuple[str, str, str]]:
    """The self-scan's stages, in order. S1 appears only when it will run."""
    stages = [
        ("config", "Config checks", "internal"),
        ("sast", "SAST analysis", "semgrep"),
        ("secrets", "Secret detection", "gitleaks"),
        ("deps", "Dependency audit", "pip-audit / npm audit"),
    ]
    if cfg.s1_enabled:
        stages.append(("s1", "SentinelOne CNS", "s1-cns-cli"))
    stages.append(("llm", "LLM review", provider.label))
    return stages


_SOURCE_CATEGORY = {
    "semgrep": "sast",
    "gitleaks": "secrets",
    "pip_audit": "dependencies",
    "npm_audit": "dependencies",
    "config": "config",
    "llm": "llm",
    "s1_secret": "secrets",
    "s1_iac": "config",
    "s1_vuln": "dependencies",
}


def _snapshot_without_ignored(src: Path, dest: Path) -> bool:
    """Copy the files git would commit (tracked + untracked, minus .gitignore'd) to *dest*.

    Keeps local-only files such as api/.env out of the self-scan. Returns False
    when *src* isn't in a git checkout (e.g. the Docker image, whose
    .dockerignore already leaves env files out).
    """
    try:
        out = subprocess.run(
            ["git", "-C", str(src), "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
            capture_output=True, timeout=60, check=True,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    for rel in filter(None, out.decode(errors="surrogateescape").split("\0")):
        f = src / rel
        if f.is_file() and not f.is_symlink():  # skips files deleted but not yet committed
            (dest / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, dest / rel)
    return True


async def _save_findings(
    db, submission: Submission, findings: list[dict], carried: list[tuple[dict, Finding]] | None = None
) -> None:
    """Add *findings*, carrying earlier false-positive decisions forward (audited)."""
    if carried is None:
        carried = await apply_previous_false_positives(db, submission.repo_full_name, findings)
    rows = {id(f): Finding(submission_id=submission.id, **f) for f in findings}
    db.add_all(rows.values())
    if carried:
        await db.flush()  # assigns ids for the audit entries
        audit_carried(db, submission.id, [(rows[id(f)], old) for f, old in carried])
        logger.info("Submission %s: %d finding(s) marked false positive from earlier decisions",
                    submission.id, len(carried))


async def scan_self(
    ctx,
    existing_scan_id: str | None = None,
    triggered_by: str = "scheduled",
    triggered_by_user: str | None = None,
) -> None:
    """Full security self-assessment of the Custos codebase."""
    src = Path(__file__).parent.parent
    with tempfile.TemporaryDirectory(prefix="custos-selfscan-") as tmp:
        snapshot = await asyncio.to_thread(_snapshot_without_ignored, src, Path(tmp))
        await _scan_self_at(str(Path(tmp) if snapshot else src), ctx, existing_scan_id,
                            triggered_by, triggered_by_user)


async def _scan_self_at(
    custos_path: str,
    ctx,
    existing_scan_id: str | None,
    triggered_by: str,
    triggered_by_user: str | None,
) -> None:
    async with async_session_factory() as db:
        scan = await db.get(SelfScan, UUID(existing_scan_id)) if existing_scan_id else None
        if existing_scan_id and scan is None:
            logger.error("SelfScan %s not found — creating new record", existing_scan_id)
        if scan is None:
            # Cron path: create the record here.
            scan = SelfScan(
                status=RunStatus.RUNNING.value,
                triggered_by=triggered_by,
                triggered_by_user=triggered_by_user,
                started_at=_now(),
            )
            db.add(scan)
            await db.commit()

        tracker = None
        try:
            cfg = await load_app_config(db)
            provider = await _llm_provider(db, cfg)
            tracker = StageTracker(ctx.get("redis") if ctx else None, scan.id, _self_scan_stages(cfg, provider))
            await tracker.publish()
            async with _job_deadline(cfg.worker_job_timeout):
                # Tools run concurrently; each stage reports its own real state.
                config_findings, semgrep, gitleaks, deps = await asyncio.gather(
                    tracker.run("config", run_config_checks(db)),
                    tracker.run("sast", run_semgrep(custos_path)),
                    tracker.run("secrets", run_gitleaks(custos_path)),
                    tracker.run("deps", run_dep_audit(custos_path)),
                )
                sast_context = config_findings + semgrep + gitleaks + deps
                notes: list[str] = []

                if cfg.s1_enabled:
                    # After the gather: it shares the DB session (token lookup).
                    await tracker.set("s1", "running")
                    s1_findings, s1_note = await _run_s1(db, cfg, custos_path, None)  # never published
                    sast_context += s1_findings
                    await tracker.set("s1", "failed" if s1_note and not s1_findings else "done", s1_note)
                    if s1_note:
                        notes.append(s1_note)

                llm_findings: list[RawFinding] = []
                await tracker.set("llm", "running")
                try:
                    llm_findings = (await _run_llm(custos_path, sast_context, cfg, provider)).findings
                    await tracker.set("llm", "done")
                except LlmError as exc:
                    logger.warning("Self-scan LLM phase failed: %s", exc)
                    await tracker.set("llm", "failed", str(exc)[:300])
                    notes.insert(0, f"LLM review failed; showing static analysis only. {exc}")
                if notes:
                    scan.error = "\n".join(notes)[:2000]

                all_findings = dedup_raw_findings(sast_context + llm_findings)
                sev_counts: dict[str, int] = {"critical": 0, "high": 0, "medium": 0, "low": 0, "info": 0}
                config_issue_count = 0

                for f in all_findings:
                    sev_counts[f.severity] = sev_counts.get(f.severity, 0) + 1
                    if f.source == "config":
                        config_issue_count += 1
                    db.add(SelfScanFinding(
                        scan_id=scan.id,
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
                        llm_reasoning=f.llm_reasoning,
                    ))

                if sev_counts["critical"] > 0:
                    overall_health = "urgent"
                elif sev_counts["high"] > 0:
                    overall_health = "warning"
                else:
                    overall_health = "healthy"

                scan.status = RunStatus.COMPLETE.value
                scan.overall_health = overall_health
                scan.finding_counts = json.dumps(sev_counts)
                scan.config_issue_count = config_issue_count
                scan.finished_at = _now()
                await db.commit()
                logger.info("Self-scan complete: %s health, %d findings", overall_health, len(all_findings))

        except Exception as exc:
            logger.exception("Self-scan failed")
            if tracker:
                for stage in tracker.stages.values():
                    if stage["state"] in ("pending", "running"):
                        stage["state"] = "failed" if stage["state"] == "running" else "skipped"
                await tracker.publish()
            await db.rollback()
            await db.refresh(scan)
            scan.status = RunStatus.FAILED.value
            scan.error = redact(str(exc) or type(exc).__name__)[:2000]
            scan.finished_at = _now()
            await db.commit()
            raise


async def reap_stale_jobs(ctx) -> None:
    """Fail records left 'running' by a worker that died or a job that hung."""
    cutoff = _now() - timedelta(minutes=settings.STALE_JOB_MINUTES)
    msg = f"Timed out: no progress for {settings.STALE_JOB_MINUTES} minutes (worker restarted or job hung)"
    async with async_session_factory() as db:
        subs = await db.execute(
            update(Submission)
            .where(Submission.status == SubmissionStatus.ANALYZING, Submission.updated_at < cutoff)
            .values(status=SubmissionStatus.ERROR.value, error_message=msg)
        )
        runs = await db.execute(
            update(LlmRun)
            .where(LlmRun.status == RunStatus.RUNNING, LlmRun.started_at < cutoff)
            .values(status=RunStatus.FAILED.value, error=msg, finished_at=_now())
        )
        scans = await db.execute(
            update(SelfScan)
            .where(SelfScan.status == RunStatus.RUNNING, SelfScan.started_at < cutoff)
            .values(status=RunStatus.FAILED.value, error=msg, finished_at=_now())
        )
        await db.commit()
    total = subs.rowcount + runs.rowcount + scans.rowcount
    if total:
        logger.warning(
            "Reaped stale jobs: %d submission(s), %d LLM run(s), %d self-scan(s)",
            subs.rowcount, runs.rowcount, scans.rowcount,
        )


async def check_repos_for_updates(ctx) -> None:
    """Scheduled "Check for updates": queue unscanned commits of repos that are due.

    Runs hourly; a repo is due once repo_check_interval_hours have passed since
    its last check (manual or scheduled). 0 turns the schedule off.
    """
    redis = ctx["redis"]  # ArqRedis: also the job pool, on Custos's queue
    async with async_session_factory() as db:
        cfg = await load_app_config(db)
        if cfg.repo_check_interval_hours <= 0:
            return
        cutoff = _now() - timedelta(hours=cfg.repo_check_interval_hours)
        due = (await db.execute(
            select(Repo.id, Repo.repo_full_name).where(
                Repo.enabled.is_(True),
                (Repo.last_checked_at.is_(None)) | (Repo.last_checked_at <= cutoff),
            )
        )).all()
        # Loaded one at a time: a failure's rollback expires every loaded object.
        for repo_id, name in due:
            try:
                await check_repo_for_updates(db, redis, redis, await db.get(Repo, repo_id))
            except Exception as exc:
                await db.rollback()
                logger.warning("Scheduled update check failed for %s: %s", name, redact(str(exc)))
