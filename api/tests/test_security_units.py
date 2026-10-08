import hashlib
import hmac
import os
import subprocess

import pytest

from config import Settings, validate_secrets
from github_client import verify_github_signature
from worker.analysis.clone import CloneError, _auth_config, _clone_sync, clone_repo
from worker.analysis.llm import _select_files
from worker.analysis.sast import safe_repo_file


# ── webhook signature ─────────────────────────────────────────────────────────

def _sign(body: bytes, secret: str) -> str:
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def test_signature_valid():
    assert verify_github_signature(b"{}", _sign(b"{}", "s3cret"), "s3cret")


@pytest.mark.parametrize("header,secret", [
    ("", "s3cret"),
    ("sha1=abc", "s3cret"),
    (_sign(b"{}", "wrong"), "s3cret"),
    (_sign(b"{}", ""), ""),  # empty secret must never validate
])
def test_signature_invalid(header, secret):
    assert not verify_github_signature(b"{}", header, secret)


# ── secrets config ────────────────────────────────────────────────────────────

@pytest.mark.parametrize("key", ["", "changeme", "short"])
def test_weak_secret_key_rejected(key):
    with pytest.raises(RuntimeError):
        validate_secrets(Settings(SECRET_KEY=key))


def test_strong_secret_key_accepted():
    validate_secrets(Settings(SECRET_KEY="a" * 64))


# ── encryption key rotation ───────────────────────────────────────────────────

def test_rotation_with_previous_key(monkeypatch):
    import crypto
    from config import settings

    monkeypatch.setattr(settings, "ENCRYPTION_KEY", "old-key")
    monkeypatch.setattr(settings, "PREVIOUS_ENCRYPTION_KEYS", "")
    old_ct = crypto.encrypt("ghp_token")

    monkeypatch.setattr(settings, "ENCRYPTION_KEY", "new-key")
    with pytest.raises(Exception):
        crypto.decrypt(old_ct)  # new key alone can't read old data

    monkeypatch.setattr(settings, "PREVIOUS_ENCRYPTION_KEYS", "old-key")
    assert crypto.decrypt(old_ct) == "ghp_token"
    new_ct = crypto.rotate(old_ct)

    monkeypatch.setattr(settings, "PREVIOUS_ENCRYPTION_KEYS", "")
    assert crypto.decrypt(new_ct) == "ghp_token"


# ── untrusted repo files ──────────────────────────────────────────────────────

@pytest.fixture
def hostile_repo(tmp_path):
    outside = tmp_path / "host_secret.txt"
    outside.write_text("SECRET_KEY=host-secret")
    repo = tmp_path / "repo"
    (repo / "src").mkdir(parents=True)
    (repo / "src" / "main.py").write_text("print('hi')\n")
    (repo / "app.py").symlink_to(outside)                 # file symlink escaping repo
    (repo / "linked_dir").symlink_to(tmp_path)            # dir symlink escaping repo
    (repo / ".env").write_text("DB_PASSWORD=hunter2")
    (repo / ".env.example").write_text("DB_PASSWORD=")
    return repo


def test_safe_repo_file_rejects_symlinks_and_traversal(hostile_repo):
    assert safe_repo_file(str(hostile_repo), "src/main.py")
    assert safe_repo_file(str(hostile_repo), "app.py") is None
    assert safe_repo_file(str(hostile_repo), "linked_dir/host_secret.txt") is None
    assert safe_repo_file(str(hostile_repo), "../host_secret.txt") is None


def test_select_files_never_leaks_host_or_env_files(hostile_repo):
    from worker.analysis.sast import RawFinding
    # Even when a tool "references" the symlink, it must not be read.
    sast = [RawFinding(source="semgrep", severity="high", title="x", file_path="app.py")]
    files = dict(_select_files(str(hostile_repo), sast))
    assert "src/main.py" in files
    assert ".env.example" in files
    assert "app.py" not in files and ".env" not in files
    assert not any("host-secret" in c or "hunter2" in c for c in files.values())


def test_select_files_respects_file_cap(tmp_path):
    for i in range(5):
        (tmp_path / f"f{i}.py").write_text("x = 1\n")
    assert len(_select_files(str(tmp_path), [], max_files=2)) == 2


# ── cloning ───────────────────────────────────────────────────────────────────

def test_auth_header_only_for_github():
    assert _auth_config("https://github.com/a/b.git", "tok")
    assert _auth_config("https://evil.example/a/b.git", "tok") == []
    assert _auth_config("https://github.com.evil.example/a/b.git", "tok") == []
    assert _auth_config("https://github.com/a/b.git", "") == []


async def test_clone_rejects_non_sha(tmp_path):
    with pytest.raises(CloneError):
        await clone_repo("https://github.com/a/b.git", "--upload-pack=touch /tmp/x", str(tmp_path))


def test_clone_checks_out_exact_commit(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    git = lambda *a: subprocess.run(["git", *a], cwd=src, check=True, capture_output=True, text=True)
    git("init", "-q")
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "one")
    (src / "file.txt").write_text("v1")
    git("add", ".")
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "two")
    sha = git("rev-parse", "HEAD").stdout.strip()
    (src / "file.txt").write_text("v2")
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "three")

    out = _clone_sync(str(src), sha, str(tmp_path / "clones"), token="")
    assert open(os.path.join(out, "file.txt")).read() == "v1"
    # Token must never be persisted into the checkout's git config.
    assert "extraHeader" not in open(os.path.join(out, ".git", "config")).read()


def test_clone_error_does_not_leak_token(tmp_path, monkeypatch):
    import worker.analysis.clone as clone_mod
    # Force the auth header onto a local (failing) URL so it is in the command line.
    monkeypatch.setattr(
        clone_mod, "_auth_config",
        lambda url, tok: ["-c", f"http.extraHeader=Authorization: Basic {tok}"],
    )
    with pytest.raises(CloneError) as exc:
        _clone_sync(str(tmp_path / "missing"), "a" * 40, str(tmp_path / "clones"), token="ghp_SECRET")
    assert "ghp_SECRET" not in str(exc.value)
    assert not os.listdir(tmp_path / "clones")  # temp dir cleaned up
