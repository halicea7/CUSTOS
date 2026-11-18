"""CodeQL: SARIF parsing, language detection, the separate follow-up job, and
that it's only ever queued when Settings → Analysis → CodeQL is on."""

import json

from models import AppConfig, Finding
from tests.conftest import FakeArqPool, make_repo, make_submission
from worker import tasks
from worker.analysis import codeql

RULE = {
    "id": "py/full-ssrf",
    "properties": {"name": "Full server-side request forgery", "tags": ["security", "external/cwe/cwe-918"],
                   "security-severity": "9.1", "precision": "high"},
}
LOW_PRECISION_RULE = {
    "id": "py/weak-guess",
    "properties": {"name": "Something uncertain", "tags": ["security"], "security-severity": "8.0", "precision": "low"},
}


def _sarif(*results, rules=(RULE,)):
    return {"runs": [{"tool": {"driver": {"rules": list(rules)}}, "results": list(results)}]}


def _result(rule_id="py/full-ssrf", path="app.py", line=10, end=None, text="A [tainted value](1) reaches here.",
           flow_path=None, flow_line=None):
    r = {"ruleId": rule_id, "message": {"text": text},
         "locations": [{"physicalLocation": {"artifactLocation": {"uri": path},
                                              "region": {"startLine": line, **({"endLine": end} if end else {})}}}]}
    if flow_path:
        r["codeFlows"] = [{"threadFlows": [{"locations": [{"location": {"physicalLocation": {
            "artifactLocation": {"uri": flow_path}, "region": {"startLine": flow_line}}}}]}]}]
    return r


def test_parse_sarif_reads_severity_cwe_and_code():
    sarif = _sarif(_result(flow_path="routes.py", flow_line=5))
    [f] = codeql._parse_sarif(sarif, ".", "python")
    assert f.source == "codeql" and f.severity == "critical" and f.cwe == "CWE-918"
    assert f.title == "py/full-ssrf Full server-side request forgery"
    assert f.description == "A tainted value reaches here. Source: `routes.py:5`."
    assert f.file_path == "app.py" and f.line_start == 10 and f.line_end == 10


def test_low_precision_is_capped_and_test_files_are_capped_too():
    sarif = _sarif(_result(rule_id="py/weak-guess", path="app.py"),
                   _result(rule_id="py/weak-guess", path="tests/test_app.py"),
                   rules=(LOW_PRECISION_RULE,))
    low, test_file = codeql._parse_sarif(sarif, ".", "python")
    assert low.severity == "medium" and "precision as low" in low.description
    assert test_file.severity == "low"   # test-path cap wins even lower


def test_a_result_with_no_location_is_skipped_not_crashed_on():
    sarif = {"runs": [{"tool": {"driver": {"rules": [RULE]}},
                       "results": [{"ruleId": "py/full-ssrf", "message": {"text": "x"}, "locations": []}]}]}
    assert codeql._parse_sarif(sarif, ".", "python") == []


def test_languages_present_skips_vendored_and_hidden_dirs(tmp_path):
    (tmp_path / "app.py").write_text("x")
    (tmp_path / "web.js").write_text("x")
    (tmp_path / "node_modules" / "x").mkdir(parents=True)
    (tmp_path / "node_modules" / "x" / "lib.rb").write_text("x")   # only inside an excluded dir
    assert sorted(codeql.languages_present(str(tmp_path))) == ["javascript", "python"]


async def _fake_run_sequence(monkeypatch, create_rc, sarif_data):
    calls = []

    async def fake(cmd, cwd=None, timeout=0):
        calls.append(cmd)
        if cmd[1:3] == ["database", "create"]:
            return create_rc, "", ""
        # "database analyze": write the SARIF to the path codeql.py asked for.
        out = next(a for a in cmd if a.startswith("--output=")).removeprefix("--output=")
        if sarif_data is not None:
            open(out, "w").write(json.dumps(sarif_data))
            return 0, "", ""
        return 1, "", "boom"

    monkeypatch.setattr(codeql, "_run", fake)
    return calls


async def test_run_codeql_scans_only_languages_present(tmp_path, monkeypatch):
    (tmp_path / "app.py").write_text("x")
    calls = await _fake_run_sequence(monkeypatch, 0, _sarif(_result()))
    found = await codeql.run_codeql(str(tmp_path))
    assert [f.title for f in found] == ["py/full-ssrf Full server-side request forgery"]
    langs_run = {a.removeprefix("--language=") for c in calls if c[1:3] == ["database", "create"]
                for a in c if a.startswith("--language=")}
    assert langs_run == {"python"}   # not javascript or ruby: no such files here


async def test_run_codeql_is_best_effort_per_language(tmp_path, monkeypatch):
    (tmp_path / "app.py").write_text("x")
    await _fake_run_sequence(monkeypatch, 1, None)   # "database create" itself fails
    assert await codeql.run_codeql(str(tmp_path)) == []


async def test_analyze_submission_queues_codeql_only_when_enabled(db, monkeypatch, tmp_path):
    await make_repo(db, "org/r", owner="x")
    sub = await make_submission(db, "org/r", status="pending")

    async def fake_clone(url, sha, base_dir, github_token=""):
        return str(tmp_path)

    async def fake_sast(path, extra=()):
        return []

    async def fake_check(**kw):
        return None

    monkeypatch.setattr(tasks, "clone_repo", fake_clone)
    monkeypatch.setattr(tasks, "_run_sast", fake_sast)
    monkeypatch.setattr(tasks, "post_github_check", fake_check)

    pool = FakeArqPool()
    await tasks.analyze_submission({"redis": pool}, str(sub.id))
    assert pool.jobs == []   # off by default

    db.add(AppConfig(key="codeql_enabled", value="True", updated_by="t"))
    await db.commit()
    sub2 = await make_submission(db, "org/r", status="pending")
    pool2 = FakeArqPool()
    await tasks.analyze_submission({"redis": pool2}, str(sub2.id))
    assert pool2.jobs == [("run_codeql", (str(sub2.id),))]


async def test_run_codeql_task_saves_findings_and_cleans_up(db, monkeypatch, tmp_path):
    await make_repo(db, "org/r", owner="x")
    sub = await make_submission(db, "org/r", status="needs_review")

    async def fake_clone(url, sha, base_dir, github_token=""):
        return str(tmp_path)

    from worker.analysis.sast import RawFinding
    async def fake_scan(repo_path):
        assert repo_path == str(tmp_path)
        return [RawFinding("codeql", "high", "py/full-ssrf Full SSRF", file_path="app.py", line_start=1)]

    monkeypatch.setattr(tasks, "clone_repo", fake_clone)
    monkeypatch.setattr(tasks, "run_codeql_scan", fake_scan)

    await tasks.run_codeql({}, str(sub.id))

    findings = (await db.execute(Finding.__table__.select().where(Finding.submission_id == sub.id))).all()
    assert [f.source for f in findings] == ["codeql"]
    await db.refresh(sub)
    assert sub.error_message is None


async def test_run_codeql_task_failure_is_noted_not_fatal(db, monkeypatch, tmp_path):
    await make_repo(db, "org/r", owner="x")
    sub = await make_submission(db, "org/r", status="needs_review")

    async def fake_clone(url, sha, base_dir, github_token=""):
        return str(tmp_path)

    async def broken_scan(repo_path):
        raise RuntimeError("codeql binary not found")

    monkeypatch.setattr(tasks, "clone_repo", fake_clone)
    monkeypatch.setattr(tasks, "run_codeql_scan", broken_scan)

    await tasks.run_codeql({}, str(sub.id))   # must not raise

    await db.refresh(sub)
    assert sub.status == "needs_review"   # unaffected
    assert "CodeQL scan failed" in sub.error_message and "codeql binary not found" in sub.error_message


async def test_run_codeql_task_missing_submission_is_a_noop():
    await tasks.run_codeql({}, "00000000-0000-0000-0000-000000000000")
