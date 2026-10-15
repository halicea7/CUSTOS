"""Applying an AI agent's verdicts (pasted back from REMEDIATIONS.md)."""

from sqlalchemy import select

from models import AuditLog, Finding, UserActivity
from tests.conftest import auth_headers, make_repo, make_submission, make_user


async def _setup(db):
    await make_user(db, "ana")
    await make_repo(db, "org/app", owner="ana")
    sub = await make_submission(db, "org/app", findings=[
        {"severity": "high", "file_path": "shell injection"},
        {"severity": "high", "file_path": "weak check"},
        {"severity": "low", "file_path": "noise"},
    ])
    rows = (await db.execute(select(Finding).where(Finding.submission_id == sub.id))).scalars().all()
    return sub, {f.file_path: f for f in rows}


def _item(f, disposition, verdict, reason, action="no change"):
    return {"finding_id": str(f.id), "disposition": disposition, "verdict": verdict, "action": action, "reason": reason}


async def test_verdicts_become_decisions_with_a_note_saying_where_they_came_from(client, db):
    sub, f = await _setup(db)
    body = {"submission_id": str(sub.id), "items": [
        _item(f["shell injection"], "confirmed", "valid", "User input reaches the shell unescaped.", "changed"),
        _item(f["weak check"], "false_positive", "not valid", "The value comes from a constant in settings.py only."),
        _item(f["noise"], "escalated", "unsure", "Needs\x00 someone who knows\nthe deploy."),
    ]}
    resp = await client.post("/findings/agent-triage", json=body, headers=auth_headers("ana"))
    assert resp.status_code == 200, resp.text
    assert [(r["file_path"], r["disposition"], r["disposed_by"]) for r in resp.json()] == [
        ("shell injection", "confirmed", "ana"), ("weak check", "false_positive", "ana"), ("noise", "escalated", "ana")]
    notes = dict((await db.execute(select(AuditLog.finding_id, AuditLog.note))).all())
    assert notes[f["shell injection"].id] == "Via AI agent (REMEDIATIONS.md): valid, changed. User input reaches the shell unescaped."
    assert notes[f["noise"].id] == "Via AI agent (REMEDIATIONS.md): unsure, no change. Needs someone who knows the deploy."
    act = (await db.execute(select(UserActivity).where(UserActivity.action == "agent_triage"))).scalar_one()
    assert act.detail == "org/app: 1 confirmed, 1 false positive, 1 escalated"


async def test_dismissing_a_high_needs_a_real_reason_and_nothing_is_applied(client, db):
    sub, f = await _setup(db)
    body = {"submission_id": str(sub.id), "items": [
        _item(f["noise"], "confirmed", "valid", "Real but minor."),
        _item(f["weak check"], "false_positive", "not valid", "fine"),
    ]}
    resp = await client.post("/findings/agent-triage", json=body, headers=auth_headers("ana"))
    assert resp.status_code == 422 and "needs a real reason" in resp.json()["detail"]
    await db.refresh(f["noise"])
    assert f["noise"].disposition is None       # all or nothing


async def test_findings_from_another_run_or_repo_are_refused(client, db):
    sub, f = await _setup(db)
    other = await make_submission(db, "org/app", findings=[{"severity": "low", "file_path": "elsewhere"}])
    elsewhere = (await db.execute(select(Finding).where(Finding.submission_id == other.id))).scalar_one()
    body = {"submission_id": str(sub.id), "items": [_item(elsewhere, "confirmed", "valid", "Real issue here.")]}
    resp = await client.post("/findings/agent-triage", json=body, headers=auth_headers("ana"))
    assert resp.status_code == 422 and "another scan" in resp.json()["detail"]

    await make_user(db, "bob")                   # can't see org/app at all
    body = {"submission_id": str(sub.id), "items": [_item(f["noise"], "confirmed", "valid", "Real issue here.")]}
    assert (await client.post("/findings/agent-triage", json=body, headers=auth_headers("bob"))).status_code == 404
