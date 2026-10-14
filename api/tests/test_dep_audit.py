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


def _adv(title, sev="high", ghsa="GHSA-aaaa-bbbb-cccc"):
    return {"title": title, "severity": sev, "url": f"https://github.com/advisories/{ghsa}", "cwe": ["CWE-22"]}


async def test_npm_audit_folds_transitive_entries_and_lowers_dev_only(tmp_path, monkeypatch):
    lock = {"packages": {
        "": {"name": "app"},
        "node_modules/tar": {"version": "6.2.1", "dev": True},
        "node_modules/electron-builder": {"version": "24.0.0", "dev": True},
        "node_modules/electron": {"version": "31.7.7", "dev": True},
        "node_modules/fast-uri": {"version": "3.1.2"},
    }}
    _touch(tmp_path, "package.json")
    _touch(tmp_path, "package-lock.json", json.dumps(lock))
    audit = {"vulnerabilities": {
        "tar": {"severity": "critical", "nodes": ["node_modules/tar"], "effects": ["electron-builder"],
                "via": [_adv("Hardlink path traversal", "critical"), _adv("DoS", "moderate", "GHSA-2")],
                "fixAvailable": {"name": "electron-builder", "version": "26.0.0", "isSemVerMajor": True}},
        "electron-builder": {"severity": "critical", "nodes": ["node_modules/electron-builder"], "via": ["tar"],
                             "fixAvailable": True},
        "electron": {"severity": "high", "nodes": ["node_modules/electron"], "via": [_adv("ASAR bypass")]},
        "fast-uri": {"severity": "high", "nodes": ["node_modules/fast-uri"], "via": [_adv("Host confusion")],
                     "fixAvailable": True},
    }}

    async def fake_run(cmd, cwd=None, timeout=0):
        return 1, json.dumps(audit), ""

    monkeypatch.setattr(sast, "_run", fake_run)
    found = {f.title: f for f in await sast._npm_audit(str(tmp_path))}

    assert set(found) == {"tar: Hardlink path traversal", "electron: ASAR bypass", "fast-uri: Host confusion"}
    tar = found["tar: Hardlink path traversal"]
    assert tar.severity == "low" and "lowered this from **critical** to **low**" in tar.description
    assert "- **GHSA-2** (medium): DoS" in tar.description and "Installed: `tar@6.2.1`" in tar.description
    assert "Pulled in by: `electron-builder`" in tar.description and tar.cwe == "CWE-22"
    assert tar.remediation.startswith("Upgrade `electron-builder` to 26.0.0 (a major version")
    assert found["electron: ASAR bypass"].severity == "high"       # dev dependency, but shipped to users
    assert found["fast-uri: Host confusion"].severity == "high"
    assert found["fast-uri: Host confusion"].remediation == "Run `npm audit fix`."
