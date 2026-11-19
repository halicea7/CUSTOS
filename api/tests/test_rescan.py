"""Forcing a fresh scan: repo-level "Scan now", auto-scan when a repo is
added, and submission-level "Full rescan" of one exact commit."""

import httpx
from sqlalchemy import select

import intake
from models import Submission
from tests.conftest import auth_headers, make_repo, make_submission, make_user

MAIN_SHA, PR_SHA = "1" * 40, "2" * 40


def _github(repo_status=200, prs=None):
    prs = [{"number": 7, "head": {"sha": PR_SHA, "ref": "feature"}, "user": {"login": "dev"}}] if prs is None else prs

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/pulls"):
            return httpx.Response(200, json=prs)
        if "/commits/" in path:
            return httpx.Response(200, json={"sha": MAIN_SHA, "author": {"login": "maintainer"}})
        return httpx.Response(repo_status, json={
            "default_branch": "main", "clone_url": "https://github.com/org/app.git",
        })

    return handler


async def _github_fixture(monkeypatch):
    import github_client
    state = {"handler": _github()}
    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        github_client.httpx, "AsyncClient",
        lambda *a, **kw: real_client(*a, transport=httpx.MockTransport(lambda r: state["handler"](r)), **kw),
    )

    async def no_check(**kwargs):
        return None

    monkeypatch.setattr(intake, "post_github_check", no_check)
    return state


async def test_scan_now_forces_a_rescan_of_an_already_scanned_head(client, db, monkeypatch):
    await _github_fixture(monkeypatch)
    await make_user(db, "ana")
    repo = await make_repo(db, "org/app", owner="ana")
    await client.post(f"/repos/{repo.id}/check-updates", headers=auth_headers("ana"))  # scans MAIN_SHA + PR_SHA

    resp = await client.post(f"/repos/{repo.id}/scan-now", headers=auth_headers("ana"))
    assert resp.status_code == 200
    body = resp.json()
    assert body == {"queued": True, "submission_id": body["submission_id"], "commit_sha": MAIN_SHA, "branch": "main"}

    subs = (await db.execute(select(Submission).where(Submission.commit_sha == MAIN_SHA))).scalars().all()
    assert len(subs) == 2  # the original "check-updates" scan, plus this forced rescan


async def test_scan_now_leaves_open_prs_alone(client, db, monkeypatch):
    """Only the tracked ref/default branch head is forced; PRs stay on "Check for updates"."""
    await _github_fixture(monkeypatch)
    await make_user(db, "ana")
    repo = await make_repo(db, "org/app", owner="ana")
    await client.post(f"/repos/{repo.id}/check-updates", headers=auth_headers("ana"))

    await client.post(f"/repos/{repo.id}/scan-now", headers=auth_headers("ana"))

    pr_subs = (await db.execute(select(Submission).where(Submission.commit_sha == PR_SHA))).scalars().all()
    assert len(pr_subs) == 1  # unchanged by "Scan now"


async def test_scan_now_declines_a_double_click_within_the_dedup_window(client, db, monkeypatch):
    await _github_fixture(monkeypatch)
    await make_user(db, "ana")
    repo = await make_repo(db, "org/app", owner="ana")

    first = (await client.post(f"/repos/{repo.id}/scan-now", headers=auth_headers("ana"))).json()
    second = (await client.post(f"/repos/{repo.id}/scan-now", headers=auth_headers("ana"))).json()
    assert first["queued"] is True
    assert second == {"queued": False, "commit_sha": MAIN_SHA, "reason": "already queued moments ago"}


async def test_scan_now_is_owner_only_and_needs_enabled_repo(client, db, monkeypatch):
    await _github_fixture(monkeypatch)
    await make_user(db, "ana")
    await make_user(db, "bob")
    repo = await make_repo(db, "org/app", owner="ana")

    assert (await client.post(f"/repos/{repo.id}/scan-now", headers=auth_headers("bob"))).status_code == 403
    repo.enabled = False
    await db.commit()
    assert (await client.post(f"/repos/{repo.id}/scan-now", headers=auth_headers("ana"))).status_code == 409


async def test_adding_a_repo_auto_queues_its_current_targets(client, db, monkeypatch):
    await _github_fixture(monkeypatch)
    await make_user(db, "ana")

    resp = await client.post("/repos", headers=auth_headers("ana"), json={
        "repo_full_name": "org/app", "github_token": "ghp_" + "a" * 36, "webhook_secret": "s3cret",
    })
    assert resp.status_code == 201

    subs = (await db.execute(select(Submission))).scalars().all()
    assert {s.commit_sha for s in subs} == {MAIN_SHA, PR_SHA}  # scanning starts without a "Check for updates" click
    from main import app
    assert [name for name, _ in app.state.arq_pool.jobs] == ["analyze_submission"] * 2


async def test_adding_a_repo_still_succeeds_if_the_initial_scan_cant_reach_github(client, db, monkeypatch):
    await make_user(db, "ana")

    async def boom(*a, **kw):
        raise httpx.ConnectError("no route to host")

    monkeypatch.setattr(intake, "list_scan_targets", boom)

    resp = await client.post("/repos", headers=auth_headers("ana"), json={
        "repo_full_name": "org/app", "github_token": "ghp_" + "a" * 36, "webhook_secret": "s3cret",
    })
    assert resp.status_code == 201  # the repo is still added; "Check for updates" can retry
    assert (await db.execute(select(Submission))).first() is None


async def test_full_rescan_requeues_the_same_commit_as_a_new_run(client, db):
    await make_user(db, "root", role="admin")
    await make_repo(db, "org/app", owner="root")
    sub = await make_submission(db, "org/app")

    resp = await client.post(f"/submissions/{sub.id}/rescan", headers=auth_headers("root"))
    assert resp.status_code == 202
    new_id = resp.json()["submission_id"]
    assert new_id != str(sub.id)

    new_sub = await db.get(Submission, new_id)
    assert new_sub.commit_sha == sub.commit_sha
    assert new_sub.repo_full_name == sub.repo_full_name
    assert new_sub.event_type == "rescan"
    assert new_sub.status == "pending"
    # the original run is untouched
    await db.refresh(sub)
    assert sub.status == "needs_review"

    from main import app
    assert ("analyze_submission", (new_id,)) in app.state.arq_pool.jobs


async def test_full_rescan_is_admin_only(client, db):
    await make_user(db, "ana")
    await make_repo(db, "org/app", owner="ana")
    sub = await make_submission(db, "org/app")
    assert (await client.post(f"/submissions/{sub.id}/rescan", headers=auth_headers("ana"))).status_code == 403


async def test_full_rescan_404s_if_the_repo_is_no_longer_tracked(client, db):
    await make_user(db, "root", role="admin")
    repo = await make_repo(db, "org/app", owner="root")
    sub = await make_submission(db, "org/app")
    await db.delete(repo)
    await db.commit()

    resp = await client.post(f"/submissions/{sub.id}/rescan", headers=auth_headers("root"))
    assert resp.status_code == 404


async def test_full_rescan_409s_if_the_repo_is_disabled(client, db):
    await make_user(db, "root", role="admin")
    repo = await make_repo(db, "org/app", owner="root")
    repo.enabled = False
    sub = await make_submission(db, "org/app")
    await db.commit()

    resp = await client.post(f"/submissions/{sub.id}/rescan", headers=auth_headers("root"))
    assert resp.status_code == 409
