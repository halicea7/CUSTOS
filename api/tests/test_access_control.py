"""Regression tests for the submission/finding IDOR."""

from sqlalchemy import select

from models import Finding, Group, GroupMember, RepoGroup
from tests.conftest import auth_headers, make_repo, make_submission, make_user


async def _setup(db):
    await make_user(db, "alice")
    await make_user(db, "bob")
    await make_user(db, "root", role="admin")
    await make_repo(db, "org/alice-repo", owner="alice")
    sub = await make_submission(db, "org/alice-repo", findings=[{"severity": "high"}])
    finding = (await db.execute(select(Finding).where(Finding.submission_id == sub.id))).scalar_one()
    return sub, finding


async def test_other_analyst_gets_404_everywhere(client, db):
    sub, finding = await _setup(db)
    bob = auth_headers("bob")
    for method, url, body in [
        ("GET", f"/submissions/{sub.id}", None),
        ("GET", f"/submissions/{sub.id}/findings", None),
        ("GET", f"/submissions/{sub.id}/llm-runs", None),
        ("GET", f"/submissions/{sub.id}/llm-status", None),
        ("POST", f"/submissions/{sub.id}/rerun-llm", None),
        ("POST", f"/submissions/{sub.id}/signoff", {}),
        ("GET", f"/findings/{finding.id}", None),
        ("GET", f"/findings/{finding.id}/audit", None),
        ("PATCH", f"/findings/{finding.id}/disposition", {"disposition": "confirmed"}),
    ]:
        resp = await client.request(method, url, json=body, headers=bob)
        assert resp.status_code == 404, (method, url, resp.status_code)

    listing = (await client.get("/submissions", headers=bob)).json()
    assert listing["total"] == 0


async def test_owner_group_member_and_admin_can_see(client, db):
    sub, finding = await _setup(db)
    await make_user(db, "carol")
    group = Group(name="team", created_by="root")
    db.add(group)
    await db.flush()
    repo_id = (await client.get("/repos", headers=auth_headers("root"))).json()[0]["id"]
    db.add_all([GroupMember(group_id=group.id, username="carol", added_by="root"),
                RepoGroup(repo_id=repo_id, group_id=group.id)])
    await db.commit()

    for user in ("alice", "carol", "root"):
        assert (await client.get(f"/submissions/{sub.id}", headers=auth_headers(user))).status_code == 200
        assert (await client.get(f"/findings/{finding.id}", headers=auth_headers(user))).status_code == 200


async def test_group_filter_cannot_bypass_visibility(client, db):
    await _setup(db)
    group = Group(name="alices", created_by="root")
    db.add(group)
    await db.flush()
    repo_id = (await client.get("/repos", headers=auth_headers("root"))).json()[0]["id"]
    db.add(RepoGroup(repo_id=repo_id, group_id=group.id))
    await db.commit()

    resp = await client.get("/submissions", params={"group_id": str(group.id)}, headers=auth_headers("bob"))
    assert resp.status_code == 404


async def test_llm_active_only_lists_visible(client, db):
    sub, _ = await _setup(db)
    assert (await client.post(f"/submissions/{sub.id}/rerun-llm", headers=auth_headers("alice"))).status_code == 202
    assert (await client.get("/submissions/llm-active", headers=auth_headers("alice"))).json()["active"] == [str(sub.id)]
    assert (await client.get("/submissions/llm-active", headers=auth_headers("bob"))).json()["active"] == []
    # Second concurrent re-run is refused.
    assert (await client.post(f"/submissions/{sub.id}/rerun-llm", headers=auth_headers("alice"))).status_code == 409


async def test_sharing_an_existing_repo_with_a_group(client, db):
    """Being in the same group isn't enough: the repo itself must be assigned to it."""
    sub, _ = await _setup(db)
    await make_user(db, "carol")
    team, other = Group(name="team", created_by="root"), Group(name="other", created_by="root")
    db.add_all([team, other])
    await db.flush()
    db.add_all([GroupMember(group_id=team.id, username=u, added_by="root") for u in ("alice", "bob")])
    await db.commit()
    alice, bob = auth_headers("alice"), auth_headers("bob")
    repo_id = (await client.get("/repos", headers=alice)).json()[0]["id"]

    assert (await client.get(f"/submissions/{sub.id}", headers=bob)).status_code == 404

    # Only the owner (or an admin) can share, and only into a group they belong to.
    assert (await client.post(f"/repos/{repo_id}/groups/{team.id}", headers=bob)).status_code == 403
    assert (await client.post(f"/repos/{repo_id}/groups/{other.id}", headers=alice)).status_code == 404
    assert (await client.post(f"/repos/{repo_id}/groups/{team.id}", headers=alice)).status_code == 204

    assert (await client.get(f"/submissions/{sub.id}", headers=bob)).status_code == 200
    assert (await client.get(f"/submissions/{sub.id}", headers=auth_headers("carol"))).status_code == 404

    assert (await client.delete(f"/repos/{repo_id}/groups/{team.id}", headers=alice)).status_code == 204
    assert (await client.get(f"/submissions/{sub.id}", headers=bob)).status_code == 404


async def test_welcome_tour_is_shown_once_and_can_be_replayed(client, db):
    from tests.conftest import auth_headers, make_user

    await make_user(db, "newbie")
    h = auth_headers("newbie")
    assert (await client.get("/auth/me", headers=h)).json()["tour_completed_at"] is None
    done = await client.put("/auth/me/tour", headers=h, json={"done": True})
    assert done.status_code == 200 and done.json()["tour_completed_at"]
    assert (await client.get("/auth/me", headers=h)).json()["tour_completed_at"]
    again = await client.put("/auth/me/tour", headers=h, json={"done": False})
    assert again.json()["tour_completed_at"] is None
    assert (await client.put("/auth/me/tour", json={"done": True})).status_code == 401
