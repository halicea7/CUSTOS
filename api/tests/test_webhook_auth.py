import hashlib
import hmac
import json

from sqlalchemy import select

from models import Submission
from tests.conftest import make_repo, make_user


def _signed(payload: dict, secret: str) -> tuple[bytes, dict]:
    body = json.dumps(payload).encode()
    sig = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return body, {"X-Hub-Signature-256": sig, "X-GitHub-Event": "push", "Content-Type": "application/json"}


def _push(name="org/r", after="b" * 40):
    return {
        "repository": {"full_name": name, "clone_url": f"https://github.com/{name}.git"},
        "after": after,
        "ref": "refs/heads/main",
        "pusher": {"name": "dev"},
    }


async def test_unknown_repo_and_bad_signature_look_identical(client, db):
    await make_repo(db, "org/r", owner="x", secret="right")
    body, headers = _signed(_push(), "wrong")
    bad_sig = await client.post("/webhook/github", content=body, headers=headers)
    body, headers = _signed(_push("org/unknown"), "right")
    unknown = await client.post("/webhook/github", content=body, headers=headers)
    assert bad_sig.status_code == unknown.status_code == 403
    assert bad_sig.json() == unknown.json()


async def test_valid_push_enqueues_once(client, db):
    await make_repo(db, "org/r", owner="x", secret="right")
    body, headers = _signed(_push(), "right")
    first = await client.post("/webhook/github", content=body, headers=headers)
    assert first.status_code == 202 and first.json()["status"] == "accepted"
    second = await client.post("/webhook/github", content=body, headers=headers)
    assert second.json()["status"] == "deduplicated"

    subs = (await db.execute(select(Submission))).scalars().all()
    assert len(subs) == 1 and subs[0].status == "pending" and subs[0].branch == "main"
    from main import app
    assert app.state.arq_pool.jobs == [("analyze_submission", (str(subs[0].id),))]


async def test_branch_delete_is_ignored(client, db):
    await make_repo(db, "org/r", owner="x", secret="right")
    body, headers = _signed({**_push(after="0" * 40), "deleted": True}, "right")
    resp = await client.post("/webhook/github", content=body, headers=headers)
    assert resp.json()["status"] == "ignored"


async def test_login_and_rate_limit(client, db):
    await make_user(db, "alice")
    ok = await client.post("/auth/login", json={"username": "alice", "password": "password123"})
    assert ok.status_code == 200
    me = await client.get("/auth/me", headers={"Authorization": f"Bearer {ok.json()['access_token']}"})
    assert me.json()["username"] == "alice"

    for _ in range(10):
        assert (await client.post("/auth/login", json={"username": "alice", "password": "nope"})).status_code == 401
    locked = await client.post("/auth/login", json={"username": "alice", "password": "password123"})
    assert locked.status_code == 429


async def test_bad_token_rejected(client, db):
    assert (await client.get("/auth/me", headers={"Authorization": "Bearer junk"})).status_code == 401
