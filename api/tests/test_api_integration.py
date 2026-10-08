"""API-level tests: authorization, sign-off gate, login throttling, webhook.

Require Postgres + Redis (see conftest.py); skipped otherwise.
"""
import hashlib
import hmac
import json

import pytest

from auth import create_access_token, hash_password
from crypto import encrypt
from models import Finding, Group, GroupMember, Repo, RepoGroup, Submission, User

SHA = "a" * 40


def _auth(username: str) -> dict:
    return {"Authorization": f"Bearer {create_access_token({'sub': username})}"}


@pytest.fixture
async def seeded(db):
    """admin; alice owns alice/r1; bob owns bob/r2. One high finding each."""
    for name, role in [("admin", "admin"), ("alice", "analyst"), ("bob", "analyst")]:
        db.add(User(username=name, hashed_password=hash_password("password123"), role=role))
    ids = {}
    for owner in ("alice", "bob"):
        repo = Repo(
            repo_full_name=f"{owner}/r",
            github_token_enc=encrypt(""),
            webhook_secret_enc=encrypt(f"{owner}-hook-secret"),
            added_by=owner,
        )
        sub = Submission(
            repo_full_name=f"{owner}/r", repo_url=f"https://github.com/{owner}/r.git",
            commit_sha=SHA, status="needs_review",
        )
        db.add_all([repo, sub])
        await db.flush()
        finding = Finding(submission_id=sub.id, source="semgrep", severity="high", title="sqli")
        db.add(finding)
        await db.flush()
        ids[owner] = {"repo": repo.id, "sub": sub.id, "finding": finding.id}
    await db.commit()
    return ids


# ── IDOR: other users' submissions/findings are invisible ────────────────────

@pytest.mark.parametrize("method,path", [
    ("GET", "/submissions/{sub}"),
    ("GET", "/submissions/{sub}/findings"),
    ("GET", "/submissions/{sub}/llm-runs"),
    ("GET", "/submissions/{sub}/llm-status"),
    ("POST", "/submissions/{sub}/rerun-llm"),
    ("POST", "/submissions/{sub}/signoff"),
    ("GET", "/findings/{finding}"),
    ("GET", "/findings/{finding}/audit"),
    ("PATCH", "/findings/{finding}/disposition"),
])
async def test_cross_user_access_is_404(client, seeded, method, path):
    url = path.format(**seeded["alice"])
    body = {"disposition": "confirmed"} if "disposition" in path else {}
    resp = await client.request(method, url, headers=_auth("bob"), json=body)
    assert resp.status_code == 404, resp.text


async def test_owner_and_admin_can_read(client, seeded):
    url = f"/submissions/{seeded['alice']['sub']}"
    assert (await client.get(url, headers=_auth("alice"))).status_code == 200
    assert (await client.get(url, headers=_auth("admin"))).status_code == 200


async def test_list_only_shows_visible(client, seeded):
    resp = await client.get("/submissions", headers=_auth("bob"))
    assert {s["repo_full_name"] for s in resp.json()["submissions"]} == {"bob/r"}
    resp = await client.get("/submissions", headers=_auth("admin"))
    assert resp.json()["total"] == 2


async def test_group_filter_requires_membership(client, seeded, db):
    group = Group(name="g", created_by="admin")
    db.add(group)
    await db.flush()
    db.add(RepoGroup(repo_id=seeded["alice"]["repo"], group_id=group.id))
    await db.commit()

    url = f"/submissions?group_id={group.id}"
    assert (await client.get(url, headers=_auth("bob"))).status_code == 404

    db.add(GroupMember(group_id=group.id, username="bob", added_by="admin"))
    await db.commit()
    resp = await client.get(url, headers=_auth("bob"))
    assert [s["repo_full_name"] for s in resp.json()["submissions"]] == ["alice/r"]
    # Membership also grants access to the submission itself.
    sub_url = f"/submissions/{seeded['alice']['sub']}"
    assert (await client.get(sub_url, headers=_auth("bob"))).status_code == 200


async def test_cannot_attach_repo_to_group_you_are_not_in(client, seeded, db):
    group = Group(name="private", created_by="admin")
    db.add(group)
    await db.commit()
    resp = await client.post(
        f"/repos/{seeded['bob']['repo']}/groups/{group.id}", headers=_auth("bob")
    )
    assert resp.status_code == 404


# ── sign-off gate ─────────────────────────────────────────────────────────────

async def test_signoff_requires_dispositions(client, seeded):
    ids = seeded["alice"]
    signoff = f"/submissions/{ids['sub']}/signoff"
    assert (await client.post(signoff, headers=_auth("alice"), json={})).status_code == 409

    resp = await client.patch(
        f"/findings/{ids['finding']}/disposition",
        headers=_auth("alice"), json={"disposition": "false_positive", "note": "test"},
    )
    assert resp.status_code == 200
    resp = await client.post(signoff, headers=_auth("alice"), json={})
    assert resp.status_code == 200 and resp.json()["status"] == "signed_off"


# ── login throttling ──────────────────────────────────────────────────────────

async def test_login_lockout(client, seeded):
    bad = {"username": "alice", "password": "wrong"}
    for _ in range(10):
        assert (await client.post("/auth/login", json=bad)).status_code == 401
    good = {"username": "alice", "password": "password123"}
    assert (await client.post("/auth/login", json=good)).status_code == 429
    # Other accounts are unaffected.
    other = {"username": "bob", "password": "password123"}
    assert (await client.post("/auth/login", json=other)).status_code == 200


# ── webhook ───────────────────────────────────────────────────────────────────

async def _deliver(client, event: str, payload: dict, secret="alice-hook-secret"):
    body = json.dumps(payload).encode()
    sig = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return await client.post(
        "/webhook/github", content=body,
        headers={"X-GitHub-Event": event, "X-Hub-Signature-256": sig,
                 "Content-Type": "application/json"},
    )


def _push(**overrides):
    payload = {
        "ref": "refs/heads/main", "after": "b" * 40, "deleted": False,
        "pusher": {"name": "alice"},
        "repository": {"full_name": "alice/r", "clone_url": "https://github.com/alice/r.git"},
    }
    payload.update(overrides)
    return payload


async def test_webhook_push_enqueues_once(client, seeded):
    resp = await _deliver(client, "push", _push())
    assert resp.json()["status"] == "accepted"
    assert client._transport.app.state.arq_pool.enqueued[0][0] == "analyze_submission"
    assert (await _deliver(client, "push", _push())).json()["status"] == "deduplicated"


@pytest.mark.parametrize("payload", [
    _push(deleted=True, after="0" * 40),
    _push(ref="refs/tags/v1.0"),
])
async def test_webhook_ignores_deletes_and_tags(client, seeded, payload):
    assert (await _deliver(client, "push", payload)).json()["status"] == "ignored"


async def test_webhook_bad_signature(client, seeded):
    resp = await _deliver(client, "push", _push(), secret="wrong")
    assert resp.status_code == 403
