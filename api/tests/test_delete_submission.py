"""Admins can remove runs from the queue."""

from main import app
from sqlalchemy import select

from models import AuditLog, Finding, Submission
from redis_util import llm_lock_key
from tests.conftest import auth_headers, make_repo, make_submission, make_user


async def _setup(db, status="needs_review"):
    await make_user(db, "alice")
    await make_user(db, "root", role="admin")
    await make_repo(db, "org/r", owner="alice")
    return await make_submission(db, "org/r", status=status, findings=[{"severity": "high"}])


async def test_admin_deletes_run_and_its_findings(client, db):
    sub = await _setup(db)
    resp = await client.delete(f"/submissions/{sub.id}", headers=auth_headers("root"))
    assert resp.status_code == 204

    await db.rollback()  # end the test session's snapshot
    assert (await db.execute(select(Submission).where(Submission.id == sub.id))).first() is None
    assert (await db.execute(select(Finding).where(Finding.submission_id == sub.id))).first() is None
    audit = (await db.execute(select(AuditLog).where(AuditLog.submission_id == sub.id))).scalar_one()
    assert audit.action == "delete_submission" and audit.analyst == "root"
    listing = (await client.get("/submissions", headers=auth_headers("root"))).json()
    assert listing["total"] == 0


async def test_analysts_cannot_delete_even_their_own(client, db):
    sub = await _setup(db)
    resp = await client.delete(f"/submissions/{sub.id}", headers=auth_headers("alice"))
    assert resp.status_code == 403
    assert await db.get(Submission, sub.id) is not None


async def test_runs_in_progress_are_refused(client, db):
    for status in ("pending", "analyzing"):
        sub = await make_submission(db, "org/r", status=status)
        await make_user(db, f"admin-{status}", role="admin")
        resp = await client.delete(f"/submissions/{sub.id}", headers=auth_headers(f"admin-{status}"))
        assert resp.status_code == 409

    sub = await _setup(db)
    await app.state.redis.set(llm_lock_key(sub.id), "1")
    assert (await client.delete(f"/submissions/{sub.id}", headers=auth_headers("root"))).status_code == 409
