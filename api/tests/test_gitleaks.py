"""Gitleaks wrapper: report via a private temp file, never stdout or the repo."""
import json
from pathlib import Path

from worker.analysis import sast


async def test_reads_report_file_and_leaves_nothing_behind(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    repo.mkdir()
    seen = {}

    async def fake_run(cmd, cwd=None, timeout=None):
        seen["cmd"], seen["cwd"] = cmd, cwd
        report = Path(next(a for a in cmd if a.startswith("--report-path=")).split("=", 1)[1])
        report.write_text(json.dumps([{
            "RuleID": "github-pat", "File": str(repo / "config.py"),
            "StartLine": 2, "EndLine": 2, "Secret": "REDACTED", "Match": "REDACTED",
        }]))
        return 1, "", ""  # gitleaks exits 1 when it finds leaks

    monkeypatch.setattr(sast, "_run", fake_run)
    findings = await sast.run_gitleaks(str(repo))

    assert [(f.title, f.file_path, f.line_start) for f in findings] == [
        ("Secret detected: github-pat", "config.py", 2)
    ]
    assert "--redact" in seen["cmd"]
    assert not Path(seen["cwd"]).exists()  # temp dir (and report) removed
    assert list(repo.iterdir()) == []      # nothing written into the scanned repo


async def test_no_report_means_no_findings(tmp_path, monkeypatch):
    async def fake_run(cmd, cwd=None, timeout=None):
        return 0, "", ""

    monkeypatch.setattr(sast, "_run", fake_run)
    assert await sast.run_gitleaks(str(tmp_path)) == []


async def test_placeholder_values_in_docs_are_skipped(tmp_path, monkeypatch):
    (tmp_path / "SETUP.md").write_text("EXAMPLE_API_KEY=sk-abc123...\nREAL=9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c\n")
    leaks = [{"RuleID": "generic-api-key", "File": str(tmp_path / "SETUP.md"), "StartLine": n, "EndLine": n,
              "StartColumn": 1, "EndColumn": 40} for n in (1, 2)]

    async def fake_run(cmd, cwd=None, timeout=0):
        report = next(a.split("=", 1)[1] for a in cmd if a.startswith("--report-path="))
        Path(report).write_text(json.dumps(leaks))
        return 1, "", ""

    monkeypatch.setattr(sast, "_run", fake_run)
    found = await sast.run_gitleaks(str(tmp_path))
    assert [(f.file_path, f.line_start) for f in found] == [("SETUP.md", 2)]
    assert str(tmp_path) not in found[0].description     # no worker paths in what's stored
