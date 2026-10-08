import os

from worker.analysis.llm import _select_files
from worker.analysis.sast import RawFinding


def _write(root, rel, content):
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


def test_symlinks_are_never_followed(tmp_path):
    secret = tmp_path / "outside.env"
    secret.write_text("SECRET_KEY=hunter2")
    repo = tmp_path / "repo"
    repo.mkdir()
    _write(repo, "app.py", "print('hi')")
    os.symlink(secret, repo / "config.py")

    files = dict(_select_files(str(repo), [RawFinding("semgrep", "high", "x", file_path="config.py")],
                               max_file_bytes=10_000, max_files=50, max_total_chars=10_000))
    assert "config.py" not in files
    assert "app.py" in files


def test_sast_files_first_then_priority_and_limits(tmp_path):
    _write(tmp_path, "zzz/util.py", "u")
    _write(tmp_path, "auth.py", "a")
    _write(tmp_path, "lib/flagged.py", "f")
    _write(tmp_path, "node_modules/x.js", "n")
    _write(tmp_path, "package-lock.json", "{}")
    _write(tmp_path, ".github/workflows/ci.yml", "on: push")
    _write(tmp_path, "logo.png", "\x00\x01")

    ctx = [RawFinding("semgrep", "high", "x", file_path="lib/flagged.py")]
    files = [p for p, _ in _select_files(str(tmp_path), ctx, 10_000, 50, 10_000)]
    assert files[0] == "lib/flagged.py"
    assert files.index("auth.py") < files.index("zzz/util.py")
    assert ".github/workflows/ci.yml" in files
    assert not any(p.startswith("node_modules") for p in files)
    assert "package-lock.json" not in files and "logo.png" not in files

    assert len(_select_files(str(tmp_path), ctx, 10_000, 2, 10_000)) == 2


def test_budget_skips_files_that_do_not_fit(tmp_path):
    _write(tmp_path, "app.py", "x" * 80)
    _write(tmp_path, "other.py", "y" * 10)
    files = dict(_select_files(str(tmp_path), [], 10_000, 50, max_total_chars=50))
    assert list(files) == ["other.py"]


def test_secret_files_never_reach_the_prompt(tmp_path):
    _write(tmp_path, ".env", "SECRET_KEY=live")
    _write(tmp_path, "config/.env.production", "DB_PASSWORD=live")
    _write(tmp_path, "deploy/server.pem", "-----BEGIN PRIVATE KEY-----")
    _write(tmp_path, ".ssh/id_rsa", "-----BEGIN OPENSSH PRIVATE KEY-----")
    _write(tmp_path, ".env.example", "SECRET_KEY=")
    _write(tmp_path, "app.py", "print('hi')")
    # Even when a scanner points straight at them.
    sast = [RawFinding("gitleaks", "high", "secret", file_path=".env")]
    files = dict(_select_files(str(tmp_path), sast, max_file_bytes=10_000, max_files=50, max_total_chars=10_000))
    assert set(files) == {".env.example", "app.py"}
