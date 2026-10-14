"""Precision checks on AI findings: evidence, locations, test code, verification, tool merging."""
from worker.analysis import vetting
from worker.analysis.sast import RawFinding, _is_audit_rule, _language_mismatch
from worker.analysis.synthesizer import dedup_raw_findings

FILE = "\n".join([
    "import os",
    "def search(q):",
    "    rows = db.execute(text('select * from t where name = :n'), {'n': q})",
    "    return rows",
    "def run(cmd):",
    "    os.system('ls ' + cmd)",
])
FILES = {"app/views.py": FILE, "tests/test_views.py": FILE, ".github/workflows/ci.yml": "steps:\n  - run: docker compose up -d"}


def _f(**kw):
    base = dict(source="llm", severity="high", title="Command injection", file_path="app/views.py", line_start=6)
    return RawFinding(**{**base, **kw})


def test_quoted_code_must_exist_and_fixes_the_line():
    report = vetting.Report()
    real = _f(code_snippet="os.system('ls ' + cmd)", line_start=2)                  # right code, wrong line
    fake = _f(title="curl | bash", file_path=".github/workflows/ci.yml", line_start=2,
              code_snippet="curl https://get.example.sh | bash")                    # code that isn't there
    kept = vetting.vet([real, fake], FILES, report)
    assert kept == [real] and real.line_start == 6 and real.code_snippet == "    os.system('ls ' + cmd)"
    assert report.dropped == {"quoted code isn't in the file": 1} and report.relocated == 1


def test_numbered_quotes_and_dot_directories_are_understood():
    report = vetting.Report()
    f = _f(file_path="./.github/workflows/ci.yml", line_start=2, code_snippet="  2|   - run: docker compose up -d")
    assert vetting.vet([f], FILES, report) == [f] and f.file_path == ".github/workflows/ci.yml"


def test_missing_location_unknown_file_no_evidence_and_test_code():
    report = vetting.Report()
    nowhere = _f(file_path=None)
    unseen = _f(file_path="DEVLOG.md")
    no_quote = _f(code_snippet=None)
    in_tests = _f(file_path="tests/test_views.py", code_snippet="os.system('ls ' + cmd)")
    kept = vetting.vet([nowhere, unseen, no_quote, in_tests], FILES, report)
    assert kept == [no_quote, in_tests]
    assert no_quote.severity == "medium" and "no code was quoted" in no_quote.description
    assert in_tests.severity == "low" and "test, benchmark or script" in in_tests.description
    assert report.dropped == {"no file location": 1, "file it wasn't shown": 1}
    assert "Dropped" in report.summary() and "lowered" in report.summary()


def test_test_path_patterns():
    for p in ("tests/a.py", "src/x/test_api.py", "bench/run.py", "scripts/verify.py", "web/a.spec.ts", "conftest.py"):
        assert vetting.TEST_PATH.search(p), p
    for p in ("src/library_agent/api/app.py", "docker-compose.yml", "contest/app.py"):
        assert not vetting.TEST_PATH.search(p), p


def test_verdicts_confirm_lower_and_reject():
    report = vetting.Report()
    a, b, c = _f(title="A"), _f(title="B"), _f(title="C")
    rejected = vetting.apply_verdicts([a, b, c], [
        {"id": "V1", "verdict": "confirm", "severity": "high", "reason": "real"},
        {"id": "v2", "verdict": "lower", "severity": "low", "reason": "needs local access"},
        {"id": "V3", "verdict": "reject", "severity": "info", "reason": "bound parameter"},
    ], report)
    assert rejected == {id(c)} and a.severity == "high" and b.severity == "low"
    assert "needs local access" in b.description and "bound parameter" in report.summary()


def test_verify_prompt_shows_numbered_context():
    text = vetting.verify_prompt([_f(code_snippet="x")], FILES)
    assert "V1" in text and "    6| " in text and "app/views.py" in text


def test_semgrep_audit_rules_and_language_mismatch():
    assert _is_audit_rule("python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text")
    assert not _is_audit_rule("yaml.github-actions.security.gha-curl-pipe-shell.gha-curl-pipe-shell")
    assert _language_mismatch("java.lang.security.audit.xss.jsf.autoescape-disabled.autoescape-disabled", "web/index.html")
    assert not _language_mismatch("python.lang.security.x", "src/a.py")
    assert not _language_mismatch("yaml.github-actions.x", ".github/workflows/ci.yml")   # unlisted: kept


def test_llm_restatement_of_a_tool_finding_is_folded_in():
    tool = RawFinding(source="semgrep", severity="low", title="python.sqlalchemy.security.audit.avoid-sqlalchemy-text",
                      file_path="src/literal.py", line_start=129, cwe="CWE-89")
    llm = RawFinding(source="llm", severity="high", title="SQL Injection via Dynamic SQL Construction",
                     file_path="src/literal.py", line_start=129, cwe="CWE-89", llm_reasoning="why")
    [kept] = dedup_raw_findings([tool, llm])
    assert kept is tool and kept.severity == "low" and kept.llm_reasoning == "why"


async def test_call_llm_vets_then_verifies(tmp_path, monkeypatch):
    import json

    from worker.analysis import llm

    (tmp_path / "app").mkdir()
    (tmp_path / "app" / "views.py").write_text(FILE)
    found = {"findings": [
        {"title": "Command injection in run()", "severity": "critical", "file_path": "app/views.py", "line_start": 6,
         "evidence": "os.system('ls ' + cmd)", "description": "d", "remediation": "r", "reasoning": "x"},
        {"title": "curl | bash", "severity": "high", "file_path": "app/views.py", "line_start": 3,
         "evidence": "curl x | bash", "description": "d", "remediation": "r", "reasoning": "x"},
        {"title": "SQL injection in search()", "severity": "high", "file_path": "app/views.py", "line_start": 3,
         "evidence": "rows = db.execute(text('select * from t where name = :n'), {'n': q})",
         "description": "d", "remediation": "r", "reasoning": "x"},
    ]}
    seen = []

    async def fake(client, provider, user_prompt, spec):
        seen.append(spec.name)
        if spec is llm.VERIFY_SPEC:
            assert "V1" in user_prompt and "V2" in user_prompt and "curl" not in user_prompt
            return llm.LlmResult(value=[{"id": "V1", "verdict": "confirm", "severity": "critical", "reason": "real"},
                                        {"id": "V2", "verdict": "reject", "severity": "info", "reason": "bound parameter"}],
                                 prompt_tokens=7, completion_tokens=2)
        assert "6|     os.system('ls ' + cmd)" in user_prompt     # files are shown with line numbers
        return spec.result(json.dumps(found), 100, 10)

    monkeypatch.setattr(llm, "complete", fake)
    provider = llm.LlmProvider(kind="ollama", base_url="http://x", model="m")
    result = await llm.call_llm(str(tmp_path), [], provider)
    assert [f.title for f in result.findings] == ["Command injection in run()"]
    assert seen == ["security_findings", "finding_verdicts"] and result.prompt_tokens == 107
    assert "quoted code isn't in the file" in result.notes and "bound parameter" in result.notes

    seen.clear()
    off = await llm.call_llm(str(tmp_path), [], provider, verify=False)
    assert seen == ["security_findings"] and len(off.findings) == 2
