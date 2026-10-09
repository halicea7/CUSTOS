"""Dependency audits find manifests in subfolders, not just the repo root."""

import json
from pathlib import Path

from worker.analysis import sast


def _touch(root: Path, rel: str, text: str = "{}") -> None:
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)


def test_requirement_files_in_subfolders(tmp_path):
    _touch(tmp_path, "requirements.txt", "")
    _touch(tmp_path, "api/requirements.txt", "")
    _touch(tmp_path, "svc/requirements/base.txt", "")
    _touch(tmp_path, "node_modules/x/requirements.txt", "")    # skipped dir
    _touch(tmp_path, ".venv/requirements.txt", "")             # hidden dir
    _touch(tmp_path, "a/b/c/d/e/requirements.txt", "")         # too deep

    found = {str(p.relative_to(tmp_path)) for p in sast._requirement_files(tmp_path)}
    assert found == {"requirements.txt", "api/requirements.txt", "svc/requirements/base.txt"}


def test_symlinked_manifest_is_ignored(tmp_path):
    outside = tmp_path / "outside.txt"
    outside.write_text("")
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "requirements.txt").symlink_to(outside)
    assert sast._requirement_files(repo) == []


async def test_npm_audit_runs_in_each_locked_package(tmp_path, monkeypatch):
    _touch(tmp_path, "dashboard/package.json")
    _touch(tmp_path, "dashboard/package-lock.json")
    _touch(tmp_path, "tools/package.json")                      # no lockfile: npm audit can't run
    _touch(tmp_path, "dashboard/node_modules/dep/package.json")
    _touch(tmp_path, "dashboard/node_modules/dep/package-lock.json")

    calls = []

    async def fake_run(cmd, cwd=None, timeout=0):
        calls.append(Path(cwd).relative_to(tmp_path).as_posix())
        out = {"vulnerabilities": {"axios": {"severity": "high", "fixAvailable": True,
                                             "via": [{"title": "SSRF in axios"}]}}}
        return 1, json.dumps(out), ""

    monkeypatch.setattr(sast, "_run", fake_run)
    findings = await sast._npm_audit(str(tmp_path))

    assert calls == ["dashboard"]
    assert [(f.title, f.file_path, f.severity) for f in findings] == [
        ("axios: SSRF in axios", "dashboard/package.json", "high")]
