from tests.conftest import auth_headers, make_repo, make_submission, make_user


async def test_queue_orders_by_unreviewed_blocking_then_newest_and_paginates(client, db):
    await make_user(db, "root", role="admin")
    await make_repo(db, "org/r", owner="root")
    quiet = await make_submission(db, "org/r", findings=[{"severity": "low"}])
    reviewed = await make_submission(db, "org/r", findings=[{"severity": "high", "disposition": "confirmed"}])
    busy = await make_submission(db, "org/r", findings=[{"severity": "high"}, {"severity": "critical"}])
    one = await make_submission(db, "org/r", findings=[{"severity": "high"}])

    body = (await client.get("/submissions", headers=auth_headers("root"))).json()
    ids = [s["id"] for s in body["submissions"]]
    assert ids[:2] == [str(busy.id), str(one.id)]
    assert set(ids[2:]) == {str(quiet.id), str(reviewed.id)}
    assert ids[2] == str(reviewed.id)  # newer first among ties
    assert body["total"] == 4
    assert body["submissions"][0]["finding_counts"] == {"high": 1, "critical": 1}

    page = (await client.get("/submissions", params={"limit": 1, "offset": 1}, headers=auth_headers("root"))).json()
    assert [s["id"] for s in page["submissions"]] == [str(one.id)] and page["total"] == 4


async def test_findings_sorted_by_severity(client, db):
    await make_user(db, "root", role="admin")
    sub = await make_submission(db, "org/r", findings=[{"severity": s} for s in ("low", "critical", "info", "high")])
    body = (await client.get(f"/submissions/{sub.id}/findings", headers=auth_headers("root"))).json()
    assert [f["severity"] for f in body] == ["critical", "high", "low", "info"]


async def test_signoff_gate(client, db):
    await make_user(db, "root", role="admin")
    sub = await make_submission(db, "org/r", findings=[{"severity": "high"}])
    h = auth_headers("root")
    resp = await client.post(f"/submissions/{sub.id}/signoff", json={}, headers=h)
    assert resp.status_code == 409 and "1 critical/high" in resp.json()["detail"]

    fid = (await client.get(f"/submissions/{sub.id}/findings", headers=h)).json()[0]["id"]
    resp = await client.patch(f"/findings/{fid}/disposition", json={"disposition": "bogus"}, headers=h)
    assert resp.status_code == 422
    resp = await client.patch(f"/findings/{fid}/disposition", json={"disposition": "false_positive", "note": "n"}, headers=h)
    assert resp.status_code == 200
    audit = (await client.get(f"/findings/{fid}/audit", headers=h)).json()
    assert audit[0]["action"] == "false_positive" and audit[0]["analyst"] == "root"

    resp = await client.post(f"/submissions/{sub.id}/signoff", json={"note": "ok"}, headers=h)
    assert resp.status_code == 200 and resp.json()["status"] == "signed_off"
    assert (await client.post(f"/submissions/{sub.id}/signoff", json={}, headers=h)).status_code == 409


async def test_cannot_sign_off_while_analyzing(client, db):
    await make_user(db, "root", role="admin")
    sub = await make_submission(db, "org/r", status="analyzing")
    assert (await client.post(f"/submissions/{sub.id}/signoff", json={}, headers=auth_headers("root"))).status_code == 409


async def test_repos_list_masks_token_and_validates_name(client, db):
    await make_user(db, "alice")
    await make_repo(db, "org/a", owner="alice", token="ghp_" + "b" * 32 + "WXYZ")
    body = (await client.get("/repos", headers=auth_headers("alice"))).json()
    assert body[0]["token_preview"].endswith("WXYZ")
    resp = await client.post("/repos", json={"repo_full_name": "../evil", "github_token": "t", "webhook_secret": "s"},
                             headers=auth_headers("alice"))
    assert resp.status_code == 422
