from worker.analysis.sast import RawFinding
from worker.analysis.synthesizer import dedup_raw_findings, synthesize


def _f(source, title, path="app.py", line=10, sev="high"):
    return RawFinding(source=source, severity=sev, title=title, file_path=path, line_start=line)


def test_exact_duplicate_prefers_tool_over_llm():
    out = dedup_raw_findings([_f("llm", "SQL injection"), _f("semgrep", "SQL injection")])
    assert [f.source for f in out] == ["semgrep"]


def test_semantic_llm_duplicate_dropped():
    out = dedup_raw_findings([
        _f("semgrep", "python.sqlalchemy.security.sqlalchemy-execute-raw-query", line=5),
        _f("llm", "Raw query execution allows injection", path=None, line=None),
    ])
    assert [f.source for f in out] == ["semgrep"]


def test_unrelated_llm_finding_kept():
    out = dedup_raw_findings([
        _f("semgrep", "hardcoded-password"),
        _f("llm", "Missing CSRF protection on forms", line=99),
    ])
    assert {f.source for f in out} == {"semgrep", "llm"}


def test_synthesize_returns_db_dicts():
    [d] = synthesize([_f("gitleaks", "Secret detected: aws")], [])
    assert d["source"] == "gitleaks" and d["file_path"] == "app.py"
    assert set(d) >= {"severity", "title", "llm_reasoning", "code_snippet"}
