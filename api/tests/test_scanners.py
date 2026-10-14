"""Optional scanners: Bandit, OSV-Scanner, Checkov (output parsing and merging)."""

import json

from worker.analysis import scanners
from worker.analysis.sast import RawFinding
from worker.analysis.synthesizer import synthesize


def _fake_run(monkeypatch, rc, payload, seen=None):
    async def run(cmd, cwd=None, timeout=0):
        if seen is not None:
            seen.append(cmd)
        return rc, json.dumps(payload) if not isinstance(payload, str) else payload, ""
    monkeypatch.setattr(scanners, "_run", run)


async def test_bandit_ignores_the_repos_suppressions_and_rates_by_confidence(tmp_path, monkeypatch):
    (tmp_path / "app").mkdir()
    (tmp_path / "app" / "v.py").write_text("import subprocess\nsubprocess.call(c, shell=True)  # nosec\n")
    (tmp_path / "tests").mkdir()
    seen = []
    _fake_run(monkeypatch, 1, {"results": [
        {"filename": str(tmp_path / "app/v.py"), "line_number": 2, "line_range": [2], "issue_severity": "HIGH",
         "issue_confidence": "HIGH", "issue_text": "shell=True", "test_id": "B602",
         "test_name": "subprocess_popen_with_shell_equals_true", "issue_cwe": {"id": 78}, "more_info": "https://x"},
        {"filename": str(tmp_path / "app/v.py"), "line_number": 1, "issue_severity": "HIGH",
         "issue_confidence": "LOW", "issue_text": "guess", "test_id": "B404", "test_name": "import_subprocess"},
        {"filename": str(tmp_path / "tests/test_v.py"), "line_number": 3, "issue_severity": "HIGH",
         "issue_confidence": "HIGH", "issue_text": "in a test", "test_id": "B602", "test_name": "shell"},
    ]}, seen)
    found = await scanners.run_bandit(str(tmp_path))
    assert "--ignore-nosec" in seen[0] and "--ini" in seen[0]
    shell, guess, test = found
    assert (shell.severity, shell.cwe, shell.file_path, shell.title) == (
        "high", "CWE-78", "app/v.py", "B602 subprocess_popen_with_shell_equals_true")
    assert "shell=True" in shell.code_snippet
    assert guess.severity == "low"
    assert test.severity == "low" and "test, benchmark or script" in test.description


async def test_bandit_skips_repos_without_python(tmp_path, monkeypatch):
    seen = []
    _fake_run(monkeypatch, 0, {"results": []}, seen)
    assert await scanners.run_bandit(str(tmp_path)) == [] and seen == []


async def test_osv_leaves_pip_and_npm_manifests_to_their_own_audits(tmp_path, monkeypatch):
    vuln = {"id": "GO-2023-1", "aliases": ["CVE-2023-9", "GO-2023-1"], "summary": "Request smuggling",
            "affected": [{"package": {"name": "golang.org/x/net"},
                          "ranges": [{"events": [{"introduced": "0"}, {"fixed": "0.7.0"}]}]}]}
    seen = []
    _fake_run(monkeypatch, 1, {"results": [
        {"source": {"path": str(tmp_path / "svc/go.mod")}, "packages": [
            {"package": {"name": "golang.org/x/net", "version": "0.1.0"}, "vulnerabilities": [vuln],
             "groups": [{"ids": ["GO-2023-1", "CVE-2023-9"], "max_severity": "7.5"}]}]},
        {"source": {"path": str(tmp_path / "requirements.txt")}, "packages": [
            {"package": {"name": "requests", "version": "2.0"}, "vulnerabilities": [{"id": "PYSEC-1"}]}]},
    ]}, seen)
    (f,) = await scanners.run_osv(str(tmp_path))
    assert seen[0][seen[0].index("--config") + 1].endswith("osv-scanner.toml")
    assert (f.title, f.severity, f.file_path, f.remediation) == (
        "golang.org/x/net 0.1.0: GO-2023-1", "high", "svc/go.mod", "Upgrade to 0.7.0")
    assert f.description.startswith("Aliases: CVE-2023-9\n\nRequest smuggling")


async def test_osv_without_lockfiles_is_not_an_error(tmp_path, monkeypatch):
    _fake_run(monkeypatch, 128, "")
    assert await scanners.run_osv(str(tmp_path)) == []


async def test_checkov_reports_hardening_as_low_and_exposure_as_medium(tmp_path, monkeypatch):
    (tmp_path / "Dockerfile").write_text("FROM python:3.12\nRUN pip install flask\n")
    checks = [
        {"check_id": "CKV_DOCKER_2", "check_name": "Ensure that HEALTHCHECK instructions have been added",
         "file_path": "/Dockerfile", "file_line_range": [1, 2], "resource": "Dockerfile."},
        {"check_id": "CKV2_GHA_1", "check_name": "Ensure top-level permissions are not set to write-all",
         "file_path": "/.github/workflows/ci.yml", "file_line_range": [2, 3], "guideline": "https://g"},
    ]
    _fake_run(monkeypatch, 1, [{"check_type": "dockerfile", "results": {"failed_checks": checks}}])
    health, perms = await scanners.run_checkov(str(tmp_path))
    assert (health.severity, health.file_path, health.line_start) == ("low", "Dockerfile", 1)
    assert health.code_snippet.startswith("FROM python")
    assert (perms.severity, perms.file_path, perms.remediation) == ("medium", ".github/workflows/ci.yml", "See https://g")


def _f(source, title, line, cwe=None, **kw):
    return RawFinding(source=source, severity="high", title=title, file_path="app/v.py", line_start=line, cwe=cwe, **kw)


def test_bandit_repeating_semgrep_becomes_one_finding():
    out = synthesize([
        _f("semgrep", "python.lang.security.audit.subprocess-shell-true", 10, "CWE-78", description="Shell."),
        _f("bandit", "B602 subprocess_popen_with_shell_equals_true", 11, "CWE-78"),
        _f("bandit", "B301 blacklist", 30, "CWE-502"),          # nothing in Semgrep: kept
        _f("bandit", "B602 subprocess_popen_with_shell_equals_true", 80, "CWE-78"),  # elsewhere: kept
    ])
    assert [(f["source"], f["line_start"]) for f in out] == [("semgrep", 10), ("bandit", 30), ("bandit", 80)]
    assert out[0]["description"] == "Shell.\n\n_Also flagged by Bandit (B602)._"


def test_osv_advisories_group_per_package_but_secrets_never_do():
    out = synthesize(
        [RawFinding("osv", sev, f"org.apache.logging:log4j-core 2.14.1: {i}", file_path="pom.xml")
         for sev, i in (("critical", "GHSA-jfh8-c2jp-5v3q"), ("medium", "CVE-2021-45105"))],
        [RawFinding("gitleaks", "high", "Secret detected: AWS-key", file_path=p) for p in ("a", "b")],
    )
    assert [f["title"] for f in out] == ["org.apache.logging:log4j-core 2.14.1: 2 known vulnerabilities",
                                         "Secret detected: AWS-key", "Secret detected: AWS-key"]
    assert out[0]["severity"] == "critical"


def test_checkov_repeating_semgrep_becomes_one_finding():
    def ck(title, start, end, path="Dockerfile"):
        return RawFinding("checkov", "medium", title, file_path=path, line_start=start, line_end=end)
    out = synthesize([
        RawFinding("semgrep", "high", "dockerfile.security.missing-user.missing-user", file_path="Dockerfile", line_start=3),
        ck("CKV_DOCKER_3 Ensure that a user for the container has been created", 1, 3),
        ck("CKV_DOCKER_2 Ensure that HEALTHCHECK instructions have been added to container images", 1, 3),
        RawFinding("semgrep", "high", "yaml.github-actions.security.run-shell-injection.run-shell-injection",
                   file_path="ci.yml", line_start=7),
        ck("CKV_GHA_2 Ensure run commands are not vulnerable to shell injection", 7, 9, "ci.yml"),
        ck("CKV2_GHA_1 Ensure top-level permissions are not set to write-all", 2, 3, "ci.yml"),
    ])
    assert [f["title"].split(" ")[0] for f in out] == [
        "dockerfile.security.missing-user.missing-user", "CKV_DOCKER_2",
        "yaml.github-actions.security.run-shell-injection.run-shell-injection", "CKV2_GHA_1"]
    assert "_Also flagged by Checkov (CKV_DOCKER_3)._" in out[0]["description"]
    assert "_Also flagged by Checkov (CKV_GHA_2)._" in out[2]["description"]


async def test_bandit_unsure_results_are_low(tmp_path, monkeypatch):
    (tmp_path / "config.py").write_text("TMP = '/tmp/x'\n")
    row = {"filename": str(tmp_path / "config.py"), "line_number": 1, "test_id": "B108", "test_name": "tmp"}
    _fake_run(monkeypatch, 1, {"results": [{**row, "issue_severity": "MEDIUM", "issue_confidence": "MEDIUM"},
                                           {**row, "issue_severity": "MEDIUM", "issue_confidence": "HIGH"}]})
    assert [f.severity for f in await scanners.run_bandit(str(tmp_path))] == ["low", "medium"]
