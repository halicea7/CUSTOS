"""False-positive decisions carry forward to later scans of the same repo."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from models import AuditLog, Finding, Submission
from tests.conftest import make_repo
from worker import tasks
from worker.analysis.carryover import is_same_issue
from worker.analysis.llm import LlmResult
from worker.analysis.sast import RawFinding


def _old(**kw) -> Finding:
    base = dict(source="llm", severity="medium", title="SQL Injection in Database Migrations",
                file_path="alembic/versions/0006.py", line_start=61, cwe=None, code_snippet=None)
    return Finding(**{**base, **kw})


def _new(**kw) -> dict:
    base = dict(source="llm", severity="medium", title="Potential SQL Injection in Alembic Migrations",
                file_path="alembic/versions/0006.py", line_start=71, cwe=None, code_snippet=None)
    return {**base, **kw}


def test_llm_rewording_and_line_drift_still_match():
    assert is_same_issue(_new(), _old())


def test_llm_needs_same_file_nearby_line_and_topic():
    assert not is_same_issue(_new(file_path="api/other.py"), _old())
    assert not is_same_issue(_new(line_start=200), _old())
    assert not is_same_issue(_new(title="Hardcoded credentials"), _old())
    # A shared CWE is enough when the wording differs completely.
    assert is_same_issue(_new(title="Unsafe query building", cwe="CWE-89"), _old(cwe="CWE-89"))


def test_tool_findings_need_same_rule():
    old = _old(source="semgrep", title="formatted-sql-query", line_start=61)
    assert is_same_issue(_new(source="semgrep", title="formatted-sql-query", line_start=65), old)
    assert not is_same_issue(_new(source="semgrep", title="sqlalchemy-execute-raw-query", line_start=61), old)
    assert not is_same_issue(_new(source="gitleaks", title="formatted-sql-query", line_start=61), old)
    assert not is_same_issue(_new(), old)  # LLM vs tool: never matched


@pytest.fixture
def scan(monkeypatch, tmp_path):
    """Run analyze_submission for org/r with the given LLM findings and no SAST."""
    checks = []

    async def fake_clone(url, sha, base_dir, github_token=""):
        return str(tmp_path)

    async def no_sast(path, extra=()):
        return []

    async def fake_check(**kw):
        checks.append(kw)
        return 1

    monkeypatch.setattr(tasks, "clone_repo", fake_clone)
    monkeypatch.setattr(tasks, "_run_sast", no_sast)
    monkeypatch.setattr(tasks, "post_github_check", fake_check)

    async def run(db, llm_findings, rerun_of=None):
        async def fake_llm(*a, **kw):
            return LlmResult(findings=list(llm_findings), prompt_tokens=1, completion_tokens=1, batches=1)
        monkeypatch.setattr(tasks, "call_llm", fake_llm)
        if rerun_of:
            await tasks.rerun_llm({}, str(rerun_of))
            sub_id = rerun_of
        else:
            sub = Submission(repo_full_name="org/r", repo_url="https://github.com/org/r.git",
                             commit_sha="b" * 40, status="pending")
            db.add(sub)
            await db.commit()
            await tasks.analyze_submission({}, str(sub.id))
            sub_id = sub.id
        rows = (await db.execute(select(Finding).where(Finding.submission_id == sub_id)
                                 .execution_options(populate_existing=True))).scalars().all()
        return sub_id, {f.title: f for f in rows}

    run.checks = checks
    return run


async def _dispose(db, finding: Finding, disposition: str, by: str = "alice", ago: int = 0):
    finding.disposition, finding.disposed_by = disposition, by
    finding.disposed_at = datetime.now(UTC) - timedelta(minutes=ago)
    await db.commit()


SQL = RawFinding("llm", "high", "SQL Injection in Database Migrations", file_path="m.py", line_start=61)
SQL_AGAIN = RawFinding("llm", "high", "Potential SQL Injection in Alembic Migrations", file_path="m.py", line_start=66)
XSS = RawFinding("llm", "medium", "Stored XSS in comments", file_path="views.py", line_start=10)


async def test_dismissed_finding_is_dismissed_again_next_scan(db, scan):
    await make_repo(db, "org/r", owner="alice")
    _, first = await scan(db, [SQL, XSS])
    await _dispose(db, first[SQL.title], "false_positive")

    sub_id, second = await scan(db, [SQL_AGAIN, XSS])

    carried = second[SQL_AGAIN.title]
    assert carried.disposition == "false_positive" and carried.disposed_by == "auto: alice"
    assert second[XSS.title].disposition is None  # never dismissed: still needs review
    audit = (await db.execute(select(AuditLog).where(AuditLog.finding_id == carried.id))).scalar_one()
    assert audit.analyst == "custos" and str(first[SQL.title].id) in audit.note
    # The only blocking finding was dismissed, so the GitHub check isn't blocking.
    assert scan.checks[-1]["conclusion"] == "neutral"


async def test_later_confirmation_wins(db, scan):
    await make_repo(db, "org/r", owner="alice")
    _, first = await scan(db, [SQL])
    await _dispose(db, first[SQL.title], "false_positive", ago=10)
    _, second = await scan(db, [SQL_AGAIN])
    await _dispose(db, second[SQL_AGAIN.title], "confirmed", by="bob")

    _, third = await scan(db, [SQL])
    assert third[SQL.title].disposition is None


async def test_more_severe_finding_is_not_carried(db, scan):
    await make_repo(db, "org/r", owner="alice")
    _, first = await scan(db, [SQL])
    await _dispose(db, first[SQL.title], "false_positive")

    worse = RawFinding("llm", "critical", SQL_AGAIN.title, file_path="m.py", line_start=66)
    _, second = await scan(db, [worse])
    assert second[worse.title].disposition is None


async def test_other_repos_decisions_do_not_apply(db, scan):
    await make_repo(db, "org/r", owner="alice")
    _, first = await scan(db, [SQL])
    await _dispose(db, first[SQL.title], "false_positive")
    sub = await db.get(Submission, first[SQL.title].submission_id)
    sub.repo_full_name = "org/other"
    await db.commit()

    _, second = await scan(db, [SQL_AGAIN])
    assert second[SQL_AGAIN.title].disposition is None


async def test_llm_rerun_keeps_dismissals_of_the_findings_it_replaces(db, scan):
    await make_repo(db, "org/r", owner="alice")
    sub_id, first = await scan(db, [SQL, XSS])
    await _dispose(db, first[SQL.title], "false_positive")

    _, rerun = await scan(db, [SQL_AGAIN, XSS], rerun_of=sub_id)
    assert rerun[SQL_AGAIN.title].disposition == "false_positive"
    assert rerun[XSS.title].disposition is None
