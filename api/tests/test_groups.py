from models import Group, GroupMember
from tests.conftest import auth_headers, make_user


async def test_group_listing_and_member_counts(client, db):
    await make_user(db, "root", role="admin")
    await make_user(db, "alice")
    team = Group(name="team", created_by="root")
    other = Group(name="other", created_by="root")
    db.add_all([team, other])
    await db.flush()
    db.add_all([
        GroupMember(group_id=team.id, username="alice", added_by="root"),
        GroupMember(group_id=team.id, username="root", added_by="root"),
    ])
    await db.commit()

    admin_view = (await client.get("/groups", headers=auth_headers("root"))).json()
    assert [(g["name"], g["member_count"]) for g in admin_view] == [("other", 0), ("team", 2)]

    alice_view = (await client.get("/groups", headers=auth_headers("alice"))).json()
    assert [g["name"] for g in alice_view] == ["team"]

    assert (await client.get(f"/groups/{other.id}/members", headers=auth_headers("alice"))).status_code == 403
    members = (await client.get(f"/groups/{team.id}/members", headers=auth_headers("alice"))).json()
    assert sorted(m["username"] for m in members) == ["alice", "root"]


async def test_admin_only_endpoints(client, db):
    await make_user(db, "alice")
    h = auth_headers("alice")
    assert (await client.post("/groups", json={"name": "x"}, headers=h)).status_code == 403
    assert (await client.get("/settings/users", headers=h)).status_code == 403
    assert (await client.post("/health/scan", headers=h)).status_code == 403


async def test_config_validation(client, db):
    await make_user(db, "root", role="admin")
    h = auth_headers("root")
    bad = await client.patch("/settings/config", json={"ollama_base_url": "file:///etc/passwd"}, headers=h)
    assert bad.status_code == 422
    ok = await client.patch("/settings/config", json={"worker_max_jobs": 2, "ollama_base_url": "http://gpu:11434/"}, headers=h)
    assert ok.status_code == 200
    assert ok.json()["worker_max_jobs"] == 2 and ok.json()["ollama_base_url"] == "http://gpu:11434"
