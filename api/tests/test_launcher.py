"""Tests for ./custos env-file handling and api/manage.py commands."""
import base64
import hashlib
import importlib.machinery
import importlib.util
import os
import subprocess
import sys
from pathlib import Path

import pytest
from cryptography.fernet import Fernet
from sqlalchemy import select

from models import Repo

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


# ── ./custos env handling ─────────────────────────────────────────────────────

def test_fresh_env_gets_strong_keys_and_defaults(launcher, tmp_path):
    env_path = tmp_path / ".env"
    old_secret = launcher.ensure_env(env_path, {"OLLAMA_MODEL": "m"})
    env = launcher.read_env(env_path)
    assert len(env["SECRET_KEY"]) == 64
    Fernet(env["ENCRYPTION_KEY"].encode())  # valid Fernet key, as crypto.py requires
    assert env["OLLAMA_MODEL"] == "m"
    assert oct(env_path.stat().st_mode & 0o777) == "0o600"
    assert old_secret == "changeme"  # nothing stored yet; migrating is a no-op


def test_legacy_env_is_upgraded_in_place(launcher, tmp_path):
    env_path = tmp_path / ".env"
    env_path.write_text("# my config\nGITHUB_WEBHOOK_SECRET=keepme\nOLLAMA_MODEL=llama3\n")
    old_secret = launcher.ensure_env(env_path, {"OLLAMA_MODEL": "default-model"})
    env = launcher.read_env(env_path)
    assert old_secret == "changeme"  # repo secrets were encrypted under the default
    assert "# my config" in env_path.read_text() and env["GITHUB_WEBHOOK_SECRET"] == "keepme"
    assert env["OLLAMA_MODEL"] == "llama3"  # existing values are never overwritten
    assert (tmp_path / ".env.bak").read_text().startswith("# my config")


def test_weak_secret_replaced_and_reported_for_migration(launcher, tmp_path):
    env_path = tmp_path / ".env"
    env_path.write_text("SECRET_KEY=short-but-real\n")
    assert launcher.ensure_env(env_path, {}) == "short-but-real"
    assert launcher.read_env(env_path)["SECRET_KEY"] != "short-but-real"


def test_existing_encryption_key_means_no_migration(launcher, tmp_path):
    env_path = tmp_path / ".env"
    launcher.ensure_env(env_path, {})
    before = env_path.read_text()
    assert launcher.ensure_env(env_path, {}) is None
    assert env_path.read_text() == before


# ── manage.py ─────────────────────────────────────────────────────────────────

def _manage(*args, stdin="", extra_env=None):
    return subprocess.run(
        [sys.executable, str(ROOT / "api" / "manage.py"), *args],
        input=stdin, capture_output=True, text=True,
        env={**os.environ, **(extra_env or {})},
    )


async def test_manage_user_commands(db):
    assert _manage("count-users").stdout.strip() == "0"
    res = _manage("create-user", "alice", "--role", "admin", stdin="password123\n")
    assert res.returncode == 0, res.stderr
    assert _manage("count-users").stdout.strip() == "1"
    assert _manage("create-user", "alice", stdin="password123\n").returncode != 0  # duplicate
    assert _manage("create-user", "bob", stdin="short\n").returncode != 0  # too short
    assert _manage("reset-password", "alice", stdin="newpassword1\n").returncode == 0
    assert _manage("reset-password", "nobody", stdin="newpassword1\n").returncode != 0


async def test_rotate_keys_migrates_rows_from_the_old_default_key(db):
    """What ./custos does for an install that ran on SECRET_KEY=changeme."""
    import crypto

    legacy = Fernet(base64.urlsafe_b64encode(hashlib.sha256(b"changeme").digest()))
    db.add(Repo(
        repo_full_name="org/legacy", added_by="admin", token_last4="_old",
        github_token_enc=legacy.encrypt(b"ghp_old").decode(),
        webhook_secret_enc=legacy.encrypt(b"hook").decode(),
    ))
    db.add(Repo(
        repo_full_name="org/garbage", added_by="admin", token_last4="xxxx",
        github_token_enc="not-a-token", webhook_secret_enc="nope",
    ))
    await db.commit()

    # The launcher runs rotate-keys with the *old* SECRET_KEY so the legacy
    # fallback key in crypto.py matches the stored rows.
    res = _manage("rotate-keys", extra_env={"SECRET_KEY": "changeme"})
    assert res.returncode == 0, res.stderr
    assert "1 repo(s)" in res.stdout and "org/garbage" in res.stdout

    db.expire_all()
    repo = (await db.execute(select(Repo).where(Repo.repo_full_name == "org/legacy"))).scalar_one()
    # Now readable under the configured keys alone (test SECRET_KEY differs).
    assert crypto.decrypt(repo.github_token_enc) == "ghp_old"
    assert crypto.decrypt(repo.webhook_secret_enc) == "hook"
