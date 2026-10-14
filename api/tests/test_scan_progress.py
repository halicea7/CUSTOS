"""Self-scan: real per-stage progress (incl. SentinelOne) and its API."""
import asyncio
import json
from types import SimpleNamespace

import fakeredis.aioredis
import pytest
from sqlalchemy import select

from models import AppConfig, SelfScan, SelfScanFinding
from redis_util import scan_stages_key
from tests.conftest import auth_headers, make_user
from worker import tasks
from worker.analysis.llm import LlmError, LlmResult
from worker.analysis.sast import RawFinding
from worker.progress import StageTracker


async def test_tracker_marks_done_and_failed():
    r = fakeredis.aioredis.FakeRedis(decode_responses=True)
    t = StageTracker(r, "s1", [("a", "A", "x"), ("b", "B", "y")])

    async def ok():
        return 5

    async def boom():
        raise RuntimeError("nope")

    assert await t.run("a", ok()) == 5
    with pytest.raises(RuntimeError):
        await t.run("b", boom())
    stored = json.loads(await r.get(scan_stages_key("s1")))
    assert [(s["id"], s["state"]) for s in stored] == [("a", "done"), ("b", "failed")]


async def test_tracker_without_redis_is_a_no_op():
    t = StageTracker(None, "x", [("a", "A", "x")])
    await t.set("a", "running")  # must not raise
    assert t.stages["a"]["state"] == "running"


@pytest.fixture
def stub_tools(monkeypatch):
    async def finding(source, title, sev="low"):
        return [RawFinding(source, sev, title)]

    monkeypatch.setattr(tasks, "run_config_checks", lambda db: finding("config", "cfg"))
    monkeypatch.setattr(tasks, "run_semgrep", lambda p: finding("semgrep", "sg"))
    monkeypatch.setattr(tasks, "run_gitleaks", lambda p: finding("gitleaks", "gl"))
    monkeypatch.setattr(tasks, "run_dep_audit", lambda p: finding("pip_audit", "pa"))
    for name in tasks.EXTRA_RUNNERS:
        monkeypatch.setitem(tasks.EXTRA_RUNNERS, name, lambda p, name=name: finding(name, name))

    async def llm(*a, **kw):
        return LlmResult(findings=[RawFinding("llm", "low", "model says hi")])

    monkeypatch.setattr(tasks, "_run_llm", llm)


async def _run_scan(db, s1_enabled, monkeypatch, s1_result=None):
    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    if s1_enabled:
        db.add(AppConfig(key="s1_enabled", value="True", updated_by="t"))
        await db.commit()

    seen = {}

    async def fake_s1(db_, cfg, path, repo_meta):
        seen["repo_meta"] = repo_meta
        return s1_result

    monkeypatch.setattr(tasks, "_run_s1", fake_s1)
    await tasks.scan_self({"redis": redis}, triggered_by="manual")
    scan = (await db.execute(select(SelfScan))).scalar_one()
    stages = json.loads(await redis.get(scan_stages_key(scan.id)))
    return scan, stages, seen


async def test_self_scan_reports_real_stages_without_s1(db, stub_tools, monkeypatch):
    scan, stages, seen = await _run_scan(db, False, monkeypatch)
    assert [s["id"] for s in stages] == ["config", "sast", "secrets", "deps", "bandit", "osv", "checkov", "llm"]
    assert all(s["state"] == "done" for s in stages)
    assert seen == {}  # S1 not run when disabled
    assert scan.status == "complete"


async def test_self_scan_includes_s1_stage_and_findings(db, stub_tools, monkeypatch):
    s1_findings = [RawFinding("s1_vuln", "high", "lib 1.0: CVE-1"), RawFinding("s1_iac", "medium", "open bucket")]
    scan, stages, seen = await _run_scan(db, True, monkeypatch, (s1_findings, None))
    assert [s["id"] for s in stages] == ["config", "sast", "secrets", "deps", "bandit", "osv", "checkov", "s1", "llm"]
    s1 = next(s for s in stages if s["id"] == "s1")
    assert s1["state"] == "done" and s1["tool"] == "s1-cns-cli"
    assert seen["repo_meta"] is None  # the self-scan never publishes to SentinelOne
    rows = (await db.execute(select(SelfScanFinding.source, SelfScanFinding.category))).all()
    assert ("s1_vuln", "dependencies") in rows and ("s1_iac", "config") in rows


async def test_s1_failure_is_shown_not_fatal(db, stub_tools, monkeypatch):
    scan, stages, _ = await _run_scan(db, True, monkeypatch, ([], "SentinelOne scan failed: token rejected"))
    s1 = next(s for s in stages if s["id"] == "s1")
    assert s1["state"] == "failed" and "token rejected" in s1["detail"]
    assert scan.status == "complete" and "SentinelOne scan failed" in scan.error


async def test_llm_failure_marks_stage_failed(db, stub_tools, monkeypatch):
    async def broken(*a, **kw):
        raise LlmError("ollama down")

    monkeypatch.setattr(tasks, "_run_llm", broken)
    scan, stages, _ = await _run_scan(db, False, monkeypatch)
    assert stages[-1] == {**stages[-1], "id": "llm", "state": "failed"}
    assert scan.status == "complete" and scan.error.startswith("LLM review failed")


async def test_health_status_serves_running_stages(client, db):
    from main import app

    await make_user(db, "root", role="admin")
    scan = SelfScan(status="running", triggered_by="manual")
    db.add(scan)
    await db.commit()
    stages = [{"id": "s1", "label": "SentinelOne CNS", "tool": "s1-cns-cli", "state": "running", "detail": None}]
    await app.state.redis.set(scan_stages_key(scan.id), json.dumps(stages))

    body = (await client.get("/health/status", headers=auth_headers("root"))).json()
    assert body["running"] is True and body["running_stages"] == stages


async def test_health_status_serves_last_finished_scans_stages(client, db):
    from main import app

    await make_user(db, "root", role="admin")
    scan = SelfScan(status="complete", triggered_by="manual")
    db.add(scan)
    await db.commit()
    stages = [{"id": "llm", "label": "LLM review", "tool": "llm", "state": "failed", "detail": "unreachable"}]
    await app.state.redis.set(scan_stages_key(scan.id), json.dumps(stages))

    body = (await client.get("/health/status", headers=auth_headers("root"))).json()
    assert body["running"] is False and body["running_stages"] is None
    assert body["latest_stages"] == stages


def test_worker_and_api_use_custos_queue():
    """ARQ's default queue is shared by every ARQ app on the Redis: use our own."""
    from redis_util import ARQ_QUEUE
    from worker.queue import WorkerSettings

    assert WorkerSettings.queue_name == ARQ_QUEUE != "arq:queue"
    assert "default_queue_name=ARQ_QUEUE" in open("main.py").read()


def test_self_scan_snapshot_leaves_out_gitignored_files(tmp_path):
    import subprocess

    from worker.tasks import _snapshot_without_ignored

    repo = tmp_path / "repo"
    (repo / "api").mkdir(parents=True)
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    (repo / ".gitignore").write_text("api/.env\n")
    (repo / "api" / ".env").write_text("SECRET_KEY=live\n")
    (repo / "api" / "main.py").write_text("print('hi')\n")      # untracked, not ignored
    (repo / "api" / ".env.example").write_text("SECRET_KEY=\n")

    dest = tmp_path / "snap"
    dest.mkdir()
    assert _snapshot_without_ignored(repo / "api", dest)
    assert sorted(p.name for p in dest.rglob("*") if p.is_file()) == [".env.example", "main.py"]

    assert not _snapshot_without_ignored(tmp_path / "not-a-repo", dest)


async def test_slow_llm_fails_its_phase_not_the_job(monkeypatch):
    """An LLM that never answers must leave time to save the tool findings."""
    async def hang(**kw):
        await asyncio.sleep(30)

    monkeypatch.setattr(tasks, "call_llm", hang)
    monkeypatch.setattr(tasks, "_LLM_RESERVE_SECONDS", 1)
    cfg = SimpleNamespace(llm_max_content_chars=1, max_file_size_kb=1, max_files_per_repo=1, verify_llm_findings=False,
                          worker_job_timeout=900)
    async with asyncio.timeout(1.5) as deadline:
        with pytest.raises(LlmError, match="ran out of time"):
            await tasks._run_llm("/repo", [], cfg, None, deadline)
    assert not deadline.expired()


async def test_self_scan_skips_scanners_turned_off(db, stub_tools, monkeypatch):
    db.add(AppConfig(key="extra_scanners", value="osv", updated_by="t"))
    await db.commit()
    scan, stages, _ = await _run_scan(db, False, monkeypatch)
    assert [s["id"] for s in stages] == ["config", "sast", "secrets", "deps", "osv", "llm"]
    rows = (await db.execute(select(SelfScanFinding.source, SelfScanFinding.category))).all()
    assert ("osv", "dependencies") in rows and not any(src in ("bandit", "checkov") for src, _ in rows)
