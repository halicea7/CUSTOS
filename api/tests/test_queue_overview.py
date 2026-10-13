"""The queue page's status counts and activity feed."""

from models import AuditLog
from tests.conftest import auth_headers, make_repo, make_submission, make_user


async def test_overview_counts_and_activity(client, db):
    await make_user(db, "alice")
    await make_user(db, "bob")
    await make_repo(db, "org/a", owner="alice")
    await make_repo(db, "org/b", owner="bob")
    ready = await make_submission(db, "org/a", status="needs_review")
    await make_submission(db, "org/a", status="error")
    await make_submission(db, "org/a", status="signed_off")
    hidden = await make_submission(db, "org/b", status="needs_review")
    db.add_all([AuditLog(submission_id=ready.id, analyst="alice", action="false_positive") for _ in range(3)]
               + [AuditLog(submission_id=hidden.id, analyst="bob", action="sign_off")])
    await db.commit()

    body = (await client.get("/submissions/overview", headers=auth_headers("alice"))).json()
    assert body["status_counts"] == {"needs_review": 1, "error": 1, "signed_off": 1}

    kinds = sorted(e["kind"] for e in body["activity"])
    assert kinds == ["failed", "false_positive", "ready"]  # signed_off runs aren't status events
    fp = next(e for e in body["activity"] if e["kind"] == "false_positive")
    assert fp["count"] == 3 and fp["actor"] == "alice" and fp["repo"] == "org/a"
    assert all(e["repo"] == "org/a" for e in body["activity"])  # bob's repo stays hidden
