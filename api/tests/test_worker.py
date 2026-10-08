from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, update

from models import Finding, LlmRun, Submission
from tests.conftest import make_repo, make_submission
from worker import tasks
from worker.analysis.llm import LlmError, OllamaResult
from worker.analysis.sast import RawFinding

SAST = [RawFinding("semgrep", "high", "sql-injection", file_path="app.py", line_start=3)]


@pytest.fixture
def pipeline(monkeypatch, tmp_path):
    calls = {}

    async def fake_clone(url, sha, base_dir, github_token=""):
        calls["token"] = github_token
        d = tmp_path / "clone"
        d.mkdir(exist_ok=True)
        return str(d)

    async def fake_sast(path):
        return list(SAST)

    async def fake_check(**kw):
        calls.setdefault("checks", []).append(kw)
        return 42

    monkeypatch.setattr(tasks, "clone_repo", fake_clone)
    monkeypatch.setattr(tasks, "_run_sast", fake_sast)
    monkeypatch.setattr(tasks, "post_github_check", fake_check)
    return calls


async def _load(db, sub_id):
    fresh = {"populate_existing": True}
    sub = await db.get(Submission, sub_id, populate_existing=True)
    findings = (await db.execute(
        select(Finding).where(Finding.submission_id == sub_id).execution_options(**fresh)
    )).scalars().all()
    runs = (await db.execute(
        select(LlmRun).where(LlmRun.submission_id == sub_id).execution_options(**fresh)
    )).scalars().all()
    return sub, findings, runs


async def test_success_merges_and_dedups(db, pipeline, monkeypatch):
    token = "ghp_" + "t" * 36
    await make_repo(db, "org/r", owner="x", token=token)
    sub = await make_submission(db, "org/r", status="pending")

    async def fake_llm(*a, **kw):
        return OllamaResult(findings=[
            RawFinding("llm", "high", "SQL injection via formatted query", file_path="app.py", line_start=4),
            RawFinding("llm", "medium", "Missing CSRF protection", file_path="views.py"),
        ], prompt_tokens=10, completion_tokens=5, batches=1)

    monkeypatch.setattr(tasks, "call_ollama", fake_llm)
    await tasks.analyze_submission({}, str(sub.id))

    sub, findings, runs = await _load(db, sub.id)
    assert sub.status == "needs_review" and sub.error_message is None
    assert sorted(f.title for f in findings) == ["Missing CSRF protection", "sql-injection"]
    assert runs[0].status == "complete" and runs[0].prompt_tokens == 10
    assert pipeline["token"] == token
    assert sub.check_run_id == 42
    assert pipeline["checks"][-1]["conclusion"] == "action_required"
    assert pipeline["checks"][-1]["check_run_id"] == 42


async def test_llm_failure_keeps_sast_findings(db, pipeline, monkeypatch):
    await make_repo(db, "org/r", owner="x")
    sub = await make_submission(db, "org/r", status="pending")

    async def broken_llm(*a, **kw):
        raise LlmError("Ollama request failed: ConnectError")

    monkeypatch.setattr(tasks, "call_ollama", broken_llm)
    await tasks.analyze_submission({}, str(sub.id))

    sub, findings, runs = await _load(db, sub.id)
    assert sub.status == "needs_review"
    assert "LLM review failed" in sub.error_message
    assert [f.source for f in findings] == ["semgrep"]
    assert runs[0].status == "failed" and "ConnectError" in runs[0].error


async def test_clone_failure_marks_error_without_leaking_token(db, pipeline, monkeypatch):
    token = "ghp_" + "s" * 36
    await make_repo(db, "org/r", owner="x", token=token)
    sub = await make_submission(db, "org/r", status="pending")

    async def bad_clone(*a, **kw):
        raise RuntimeError(f"fatal: could not read from https://x:{token}@github.com/org/r")

    monkeypatch.setattr(tasks, "clone_repo", bad_clone)
    with pytest.raises(RuntimeError):
        await tasks.analyze_submission({}, str(sub.id))

    sub, findings, runs = await _load(db, sub.id)
    assert sub.status == "error" and token not in sub.error_message
    assert runs[0].status == "failed" and token not in runs[0].error
    assert pipeline["checks"][-1]["conclusion"] == "failure"


async def test_already_reviewed_submission_is_not_reanalysed(db, pipeline):
    sub = await make_submission(db, "org/r", status="signed_off")
    await tasks.analyze_submission({}, str(sub.id))
    sub, _, runs = await _load(db, sub.id)
    assert sub.status == "signed_off" and runs == []


async def test_reaper_fails_stale_records(db):
    sub = await make_submission(db, "org/r", status="analyzing")
    fresh = await make_submission(db, "org/r", status="analyzing")
    old = datetime.now(UTC) - timedelta(hours=5)
    db.add(LlmRun(submission_id=sub.id, triggered_by="initial", model="m", status="running", started_at=old))
    await db.commit()
    # onupdate would bump updated_at, so set it with a direct UPDATE.
    await db.execute(update(Submission).where(Submission.id == sub.id).values(updated_at=old))
    await db.commit()

    await tasks.reap_stale_jobs({})
    s, _, runs = await _load(db, sub.id)
    f, _, _ = await _load(db, fresh.id)
    assert s.status == "error" and runs[0].status == "failed"
    assert f.status == "analyzing"


async def test_timeout_fails_job_immediately(db, pipeline, monkeypatch):
    """A job that overruns is recorded as failed by its own deadline, not left
    'analyzing' until the stale-job reaper notices."""
    import asyncio

    from models import AppConfig

    await make_repo(db, "org/r", owner="x")
    sub = await make_submission(db, "org/r", status="pending")
    db.add(AppConfig(key="worker_job_timeout", value="31", updated_by="test"))  # 1s budget
    await db.commit()

    async def slow_sast(path):
        await asyncio.sleep(5)
        return []

    monkeypatch.setattr(tasks, "_run_sast", slow_sast)
    with pytest.raises(tasks.JobTimeout):
        await tasks.analyze_submission({}, str(sub.id))

    sub, findings, runs = await _load(db, sub.id)
    assert sub.status == "error" and "time limit" in sub.error_message
    assert runs[0].status == "failed"
    assert pipeline["checks"][-1]["conclusion"] == "failure"


async def test_job_deadline_leaves_other_timeouts_alone():
    import asyncio

    async def inner():
        raise TimeoutError("ollama read timeout")

    with pytest.raises(TimeoutError, match="ollama"):
        async with tasks._job_deadline(600):
            await inner()
    with pytest.raises(tasks.JobTimeout):
        async with tasks._job_deadline(31):
            await asyncio.sleep(3)


async def test_clone_rejects_non_sha(tmp_path):
    from worker.analysis.clone import CloneError, clone_repo

    with pytest.raises(CloneError):
        await clone_repo("https://github.com/a/b.git", "--upload-pack=touch /tmp/x", str(tmp_path))
    assert list(tmp_path.iterdir()) == []  # nothing created
