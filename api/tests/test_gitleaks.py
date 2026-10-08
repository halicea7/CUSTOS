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
