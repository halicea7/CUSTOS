"""Users page: last login / last seen, per-user stats, and the activity history."""
from datetime import UTC, datetime, timedelta

from models import AuditLog, UserActivity
from tests.conftest import auth_headers, make_repo, make_submission, make_user


async def _login(client, username, password="password123"):
    return await client.post("/auth/login", json={"username": username, "password": password})


async def test_login_and_failed_login_are_recorded(client, db):
    await make_user(db, "ana")
    assert (await _login(client, "ana", "wrong-password")).status_code == 401
    assert (await _login(client, "ana")).status_code == 200
    await _login(client, "nobody", "whatever")   # unknown names leave no trace

    await make_user(db, "root", role="admin")
    rows = (await client.get("/settings/users", headers=auth_headers("root"))).json()
    ana = next(u for u in rows if u["username"] == "ana")
    assert ana["last_login_at"] and ana["last_seen_at"]
    hist = (await client.get(f"/settings/users/{ana['id']}/activity", headers=auth_headers("root"))).json()
    assert [i["action"] for i in hist["items"]] == ["login", "login_failed"]
    assert not (await db.execute(UserActivity.__table__.select().where(UserActivity.username == "nobody"))).first()


async def test_last_seen_is_refreshed_at_most_once_a_minute(client, db):
    u = await make_user(db, "ana")
    h = auth_headers("ana")
    await client.get("/auth/me", headers=h)
    await db.refresh(u)
    first = u.last_seen_at
    await client.get("/auth/me", headers=h)
    await db.refresh(u)
    assert u.last_seen_at == first   # not rewritten on every request
    u.last_seen_at = datetime.now(UTC) - timedelta(minutes=5)
    await db.commit()
    await client.get("/auth/me", headers=h)
    await db.refresh(u)
    assert u.last_seen_at > first - timedelta(minutes=1)


async def test_history_merges_triage_folds_bulk_and_counts(client, db):
    root = await make_user(db, "root", role="admin")
    ana = await make_user(db, "ana")
    await make_repo(db, "acme/web", "ana")
    sub = await make_submission(db, "acme/web", findings=[{"severity": "high"}, {"severity": "low"}, {"severity": "low"}])
    ids = [f["id"] for f in (await client.get(f"/submissions/{sub.id}/findings", headers=auth_headers("ana"))).json()]
    await client.post("/findings/bulk-disposition", headers=auth_headers("ana"),
                      json={"finding_ids": ids, "disposition": "false_positive", "note": "test fixtures"})
    db.add(AuditLog(submission_id=sub.id, analyst="ana", action="sign_off", note="ok"))
    await db.commit()
    await client.patch(f"/repos/{(await client.get('/repos', headers=auth_headers('ana'))).json()[0]['id']}",
                       headers=auth_headers("ana"), json={"enabled": False})

    h = auth_headers("root")
    row = next(u for u in (await client.get("/settings/users", headers=h)).json() if u["username"] == "ana")
    assert (row["findings_triaged"], row["signoffs"], row["repos_added"]) == (3, 1, 1)
    items = (await client.get(f"/settings/users/{ana.id}/activity", headers=h)).json()["items"]
    actions = [i["action"] for i in items]
    assert actions[0] == "repo_disabled"
    fp = next(i for i in items if i["action"] == "false_positive")
    assert fp["count"] == 3 and fp["repo"] == "acme/web" and fp["detail"] == "test fixtures"
    assert "sign_off" in actions and root.username == "root"


async def test_admin_actions_and_settings_changes_are_logged(client, db):
    await make_user(db, "root", role="admin")
    h = auth_headers("root")
    await client.post("/settings/users", headers=h, json={"username": "bo", "password": "password123", "role": "analyst"})
    await client.patch("/settings/config", headers=h, json={"max_files_per_repo": 123})
    await client.patch("/settings/config", headers=h, json={"max_files_per_repo": 123})   # no change: not logged
    root = next(u for u in (await client.get("/settings/users", headers=h)).json() if u["username"] == "root")
    items = (await client.get(f"/settings/users/{root['id']}/activity", headers=h)).json()["items"]
    assert [(i["action"], i["detail"]) for i in items] == [
        ("settings_changed", "max_files_per_repo"), ("user_created", "bo (analyst)")]


async def test_activity_is_admin_only(client, db):
    ana = await make_user(db, "ana")
    assert (await client.get(f"/settings/users/{ana.id}/activity", headers=auth_headers("ana"))).status_code == 403
