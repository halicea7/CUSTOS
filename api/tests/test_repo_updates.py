""""Check for updates": webhook-free scanning (manual button and schedule)."""
from datetime import UTC, datetime, timedelta

import fakeredis.aioredis
import httpx
import pytest
from sqlalchemy import select

import github_client
import intake
from models import AppConfig, Repo, Submission
from tests.conftest import FakeArqPool, auth_headers, make_repo, make_user
from worker import tasks

MAIN_SHA, PR_SHA = "1" * 40, "2" * 40


def _github(repo_status=200, prs=None):
    """A fake GitHub API: one repo with a default branch head and open PRs."""
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


@pytest.fixture
def github(monkeypatch):
    """Route github_client's HTTP calls to a fake; returns a setter for its behaviour."""
    state = {"handler": _github()}
    real_client = httpx.AsyncClient

    def client(*args, **kwargs):
        return real_client(*args, transport=httpx.MockTransport(lambda r: state["handler"](r)), **kwargs)

    monkeypatch.setattr(github_client.httpx, "AsyncClient", client)

    async def no_check(**kwargs):
        return None

    monkeypatch.setattr(intake, "post_github_check", no_check)
    return state


async def test_scan_targets_cover_default_branch_and_open_prs(github):
    targets = await github_client.list_scan_targets("org/app", "token")
    assert [(t["commit_sha"], t["branch"], t["event_type"], t["pr_number"]) for t in targets] == [
        (MAIN_SHA, "main", "push", None), (PR_SHA, "feature", "pull_request", 7),
    ]
    assert targets[0]["submitter"] == "maintainer" and targets[1]["submitter"] == "dev"


async def test_button_queues_only_unscanned_commits(client, db, github):
    await make_user(db, "ana")
    repo = await make_repo(db, "org/app", owner="ana")

    first = (await client.post(f"/repos/{repo.id}/check-updates", headers=auth_headers("ana"))).json()
    assert {q["commit_sha"] for q in first["queued"]} == {MAIN_SHA, PR_SHA}
    assert first["already_scanned"] == 0

    # Same commits again (even after the dedup window): nothing new to queue.
    from main import app
    await app.state.redis.flushall()
    second = (await client.post(f"/repos/{repo.id}/check-updates", headers=auth_headers("ana"))).json()
    assert second == {"queued": [], "already_scanned": 2}

    subs = (await db.execute(select(Submission).order_by(Submission.commit_sha))).scalars().all()
    assert [(s.commit_sha, s.event_type, s.pr_number) for s in subs] == [
        (MAIN_SHA, "push", None), (PR_SHA, "pull_request", 7),
    ]
    assert [name for name, _ in app.state.arq_pool.jobs] == ["analyze_submission"] * 2
    await db.refresh(repo)
    assert repo.last_checked_at is not None


async def test_button_is_owner_only_and_needs_enabled_repo(client, db, github):
    await make_user(db, "ana")
    await make_user(db, "bob")
    repo = await make_repo(db, "org/app", owner="ana")

    assert (await client.post(f"/repos/{repo.id}/check-updates", headers=auth_headers("bob"))).status_code == 403
    repo.enabled = False
    await db.commit()
    assert (await client.post(f"/repos/{repo.id}/check-updates", headers=auth_headers("ana"))).status_code == 409


async def test_github_errors_are_explained_without_the_token(client, db, github):
    await make_user(db, "ana")
    repo = await make_repo(db, "org/app", owner="ana", token="ghp_" + "s" * 36)
    github["handler"] = _github(repo_status=401)

    resp = await client.post(f"/repos/{repo.id}/check-updates", headers=auth_headers("ana"))
    assert resp.status_code == 502
    assert "token was rejected" in resp.json()["detail"] and "ghp_" not in resp.text


async def test_schedule_checks_due_repos_only(db, github, monkeypatch):
    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    pool = FakeArqPool()
    redis.enqueue_job = pool.enqueue_job  # in the worker, ctx["redis"] is also the job pool
    now = datetime.now(UTC)
    await make_repo(db, "org/never", owner="ana")
    recent = await make_repo(db, "org/recent", owner="ana")
    recent.last_checked_at = now - timedelta(hours=1)
    stale = await make_repo(db, "org/stale", owner="ana")
    stale.last_checked_at = now - timedelta(hours=49)
    off = await make_repo(db, "org/off", owner="ana")
    off.enabled = False
    await db.commit()

    await tasks.check_repos_for_updates({"redis": redis})

    rows = (await db.execute(select(Repo.repo_full_name, Repo.last_checked_at))).all()
    checked = {name for name, at in rows if at and at > now}
    assert checked == {"org/never", "org/stale"}  # default interval: 48 hours


async def test_schedule_off_and_failures_isolated(db, github):
    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    redis.enqueue_job = FakeArqPool().enqueue_job
    await make_repo(db, "org/a", owner="ana")
    db.add(AppConfig(key="repo_check_interval_hours", value="0", updated_by="t"))
    await db.commit()

    await tasks.check_repos_for_updates({"redis": redis})
    assert (await db.execute(select(Submission))).first() is None  # 0 = manual only

    (await db.get(AppConfig, "repo_check_interval_hours")).value = "48"
    await make_repo(db, "org/b", owner="ana")
    await db.commit()

    def flaky(request):  # org/a's GitHub calls fail; org/b's succeed
        if "/org/a" in request.url.path:
            return httpx.Response(500)
        return _github()(request)

    github["handler"] = flaky
    await tasks.check_repos_for_updates({"redis": redis})
    repos = {s.repo_full_name for s in (await db.execute(select(Submission))).scalars()}
    assert repos == {"org/b"}
