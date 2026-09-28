from worker.analysis.sast import RawFinding
from worker.analysis.synthesizer import dedup_raw_findings, synthesize


def f(source, title, path="app.py", line=10, **kw):
    return RawFinding(source=source, severity="high", title=title, file_path=path, line_start=line, **kw)


def test_exact_duplicates_collapse_with_tool_winning():
    out = dedup_raw_findings([f("llm", "SQL injection"), f("semgrep", "SQL injection")])
    assert [x.source for x in out] == ["semgrep"]


def test_llm_rewording_at_same_location_is_dropped():
    out = dedup_raw_findings([
        f("semgrep", "python.lang.security.sql-injection.formatted-query", line=10),
        f("llm", "Formatted SQL query allows injection", line=12),
    ])
    assert [x.source for x in out] == ["semgrep"]


def test_same_words_in_different_file_are_kept():
    out = dedup_raw_findings([
        f("semgrep", "sql-injection", path="reports.py"),
        f("llm", "SQL injection in login handler", path="login.py"),
    ])
    assert len(out) == 2


def test_same_file_far_apart_is_kept():
    out = dedup_raw_findings([f("semgrep", "sql-injection", line=10), f("llm", "SQL injection", line=200)])
    assert len(out) == 2


def test_synthesize_returns_column_dicts():
    (row,) = synthesize([f("semgrep", "x", cwe="CWE-89")])
    assert row["cwe"] == "CWE-89" and row["source"] == "semgrep" and "llm_reasoning" in row
