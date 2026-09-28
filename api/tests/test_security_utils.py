import base64
import hashlib

import pytest
from cryptography.fernet import Fernet

import config
from crypto import decrypt, encrypt, rotate
from github_client import verify_github_signature
from worker.analysis.clone import _git_env, redact


def test_redact_known_and_shaped_secrets():
    token = "ghp_" + "Z" * 36
    text = f"fatal: https://x-access-token:{token}@github.com/o/r.git Authorization: Basic abc123 {token}"
    out = redact(text, "mysecret")
    assert token not in out and "abc123" not in out
    assert "https://***@github.com/o/r.git" in out
    assert "mysecret" not in redact("x mysecret y", "mysecret")


def test_git_env_never_puts_token_in_url_or_plaintext():
    token = "ghp_" + "Q" * 36
    env = _git_env(token)
    values = " ".join(v for k, v in env.items() if k.startswith("GIT_CONFIG_"))
    assert token not in values
    assert base64.b64encode(f"x-access-token:{token}".encode()).decode() in values
    assert env["GIT_TERMINAL_PROMPT"] == "0"


def test_encrypt_round_trip_and_legacy_rows_still_decrypt():
    assert decrypt(encrypt("hello")) == "hello"
    legacy_key = base64.urlsafe_b64encode(hashlib.sha256(config.settings.SECRET_KEY.encode()).digest())
    legacy_ct = Fernet(legacy_key).encrypt(b"old-token").decode()
    assert decrypt(legacy_ct) == "old-token"
    rotated = rotate(legacy_ct)
    primary = Fernet(config.settings.ENCRYPTION_KEY.encode())
    assert primary.decrypt(rotated.encode()) == b"old-token"


def test_signature_verification():
    import hmac
    body = b'{"a":1}'
    sig = "sha256=" + hmac.new(b"s3cret", body, hashlib.sha256).hexdigest()
    assert verify_github_signature(body, sig, "s3cret")
    assert not verify_github_signature(body, sig, "other")
    assert not verify_github_signature(body, sig, "")
    assert not verify_github_signature(body, "sha1=abc", "s3cret")


@pytest.mark.parametrize("key", ["changeme", "short", ""])
def test_insecure_secret_key_refuses_to_start(monkeypatch, key):
    monkeypatch.setattr(config.settings, "SECRET_KEY", key)
    monkeypatch.setattr(config.settings, "ALLOW_INSECURE_DEFAULTS", False)
    with pytest.raises(RuntimeError):
        config.assert_secure_settings()
    monkeypatch.setattr(config.settings, "ALLOW_INSECURE_DEFAULTS", True)
    config.assert_secure_settings()  # warns only
