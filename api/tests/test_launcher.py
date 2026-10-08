"""Tests for ./custos env-file handling and api/manage.py commands."""
import importlib.machinery
import importlib.util
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


def _load_launcher():
    loader = importlib.machinery.SourceFileLoader("custos_launcher", str(ROOT / "custos"))
    spec = importlib.util.spec_from_loader("custos_launcher", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


@pytest.fixture
def launcher(tmp_path, monkeypatch):
    mod = _load_launcher()
    monkeypatch.setattr(mod, "ROOT", tmp_path)
    return mod


def test_fresh_env_gets_strong_keys_and_defaults(launcher, tmp_path):
    env_path = tmp_path / ".env"
    old_key = launcher.ensure_env(env_path, {"REDIS_URL": "redis://x"})
    env = launcher.read_env(env_path)
    assert len(env["SECRET_KEY"]) == 64 and len(env["ENCRYPTION_KEY"]) == 64
    assert env["SECRET_KEY"] != env["ENCRYPTION_KEY"]
    assert env["REDIS_URL"] == "redis://x"
    assert oct(env_path.stat().st_mode & 0o777) == "0o600"
    assert old_key == "changeme"  # nothing stored yet; rotating is a no-op


def test_legacy_env_is_upgraded_in_place(launcher, tmp_path):
    env_path = tmp_path / ".env"
    env_path.write_text("# my config\nGITHUB_WEBHOOK_SECRET=keepme\nOLLAMA_MODEL=llama3\n")
    old_key = launcher.ensure_env(env_path, {"OLLAMA_MODEL": "default-model"})
    text = env_path.read_text()
    env = launcher.read_env(env_path)
    assert old_key == "changeme"  # data was encrypted with the old default
    assert "# my config" in text and env["GITHUB_WEBHOOK_SECRET"] == "keepme"
    assert env["OLLAMA_MODEL"] == "llama3"  # existing values never overwritten
    assert (tmp_path / ".env.bak").read_text().startswith("# my config")


def test_weak_secret_replaced_and_used_as_old_encryption_key(launcher, tmp_path):
    env_path = tmp_path / ".env"
    env_path.write_text("SECRET_KEY=short-but-real\n")
    assert launcher.ensure_env(env_path, {}) == "short-but-real"
    assert launcher.read_env(env_path)["SECRET_KEY"] != "short-but-real"


def test_configured_env_is_left_alone(launcher, tmp_path):
    env_path = tmp_path / ".env"
    launcher.ensure_env(env_path, {})
    before = env_path.read_text()
    assert launcher.ensure_env(env_path, {}) is None
    assert env_path.read_text() == before


# ── manage.py (needs the test database) ───────────────────────────────────────

def _manage(*args, stdin="", extra_env=None):
    return subprocess.run(
        [sys.executable, str(ROOT / "api" / "manage.py"), *args],
        input=stdin, capture_output=True, text=True,
        env={**os.environ, **(extra_env or {})},
    )


async def test_manage_user_commands(db_engine):
    assert _manage("count-users").stdout.strip() == "0"
    res = _manage("create-user", "alice", "--role", "admin", stdin="password123\n")
    assert res.returncode == 0, res.stderr
    assert _manage("count-users").stdout.strip() == "1"
    assert _manage("create-user", "alice", stdin="password123\n").returncode != 0
    assert _manage("create-user", "bob", stdin="short\n").returncode != 0
    assert _manage("reset-password", "alice", stdin="newpassword1\n").returncode == 0
    assert _manage("reset-password", "nobody", stdin="newpassword1\n").returncode != 0


async def test_manage_rotate_keys_migrates_legacy_credentials(db_engine, db):
    import crypto
    from config import settings
    from models import Repo

    # Simulate a repo saved by an old install running on the default key.
    legacy = crypto._derive("changeme")
    db.add(Repo(
        repo_full_name="org/legacy",
        github_token_enc=legacy.encrypt(b"ghp_old").decode(),
        webhook_secret_enc=legacy.encrypt(b"hook").decode(),
        added_by="admin",
    ))
    db.add(Repo(
        repo_full_name="org/garbage",
        github_token_enc="not-a-token", webhook_secret_enc="nope", added_by="admin",
    ))
    await db.commit()

    res = _manage("rotate-keys", extra_env={"PREVIOUS_ENCRYPTION_KEYS": "changeme"})
    assert res.returncode == 0, res.stderr
    assert "1 repo(s)" in res.stdout and "org/garbage" in res.stdout

    db.expire_all()
    from sqlalchemy import select
    repo = (await db.execute(select(Repo).where(Repo.repo_full_name == "org/legacy"))).scalar_one()
    # Readable with the current key alone — no previous keys needed any more.
    assert settings.PREVIOUS_ENCRYPTION_KEYS == ""
    assert crypto.decrypt(repo.github_token_enc) == "ghp_old"
