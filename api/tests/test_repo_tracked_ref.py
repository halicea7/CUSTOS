"""Adding a repo pinned to a branch or tag ('owner/repo/tree/<ref>', or a full
github.com URL of either shape), and changing or clearing that later."""

import httpx
import pytest

from models import UserActivity
from routers.repos import _parse_repo_input
from tests.conftest import auth_headers, make_repo, make_user

_REAL_ASYNC_CLIENT = httpx.AsyncClient  # captured before any test monkeypatches it


@pytest.mark.parametrize("raw, expected", [
    ("org/app", ("org/app", None)),
    ("org/app/", ("org/app", None)),
    (" org/app ", ("org/app", None)),
    ("org/app.git", ("org/app", None)),
    ("https://github.com/org/app", ("org/app", None)),
    ("http://www.github.com/org/app/", ("org/app", None)),
    ("github.com/org/app.git", ("org/app", None)),
    ("org/app/tree/2.11", ("org/app", "2.11")),
    ("https://github.com/org/app/tree/2.11", ("org/app", "2.11")),
    ("org/app/tree/release/2.11", ("org/app", "release/2.11")),   # a ref with its own "/"
    ("org/app/tree/2.11/", ("org/app", "2.11")),
])
def test_parses_plain_names_urls_and_tree_refs(raw, expected):
    assert _parse_repo_input(raw) == expected


def test_rejects_control_characters_in_a_ref():
    with pytest.raises(Exception) as exc:
        _parse_repo_input("org/app/tree/bad\nref")
    assert exc.value.status_code == 422


async def _github_json(monkeypatch, repo_json, ref_status=200):
    def handler(request: httpx.Request) -> httpx.Response:
        if "/commits/" in request.url.path:
            return httpx.Response(ref_status, json={"sha": "a" * 40})
        return httpx.Response(200, json=repo_json)

    monkeypatch.setattr(
        "routers.repos.httpx.AsyncClient",
        lambda *a, **kw: _REAL_ASYNC_CLIENT(*a, transport=httpx.MockTransport(handler), **kw),
    )


async def test_validate_token_accepts_a_tree_url_and_checks_the_ref_exists(client, db, monkeypatch):
    await make_user(db, "ana")
    await _github_json(monkeypatch, {"full_name": "org/app", "default_branch": "main", "private": False})

    body = {"repo_full_name": "https://github.com/org/app/tree/release/2.11", "github_token": "t"}
    resp = await client.post("/repos/validate-token", json=body, headers=auth_headers("ana"))
    data = resp.json()
    assert data == {"ok": True, "repo_name": "org/app", "default_branch": "main", "tracked_ref": "release/2.11",
                    "private": False, "token_expires_at": None}


async def test_validate_token_rejects_a_ref_that_doesnt_exist(client, db, monkeypatch):
    await make_user(db, "ana")
    await _github_json(monkeypatch, {"full_name": "org/app", "default_branch": "main"}, ref_status=404)

    body = {"repo_full_name": "org/app/tree/nope", "github_token": "t"}
    resp = await client.post("/repos/validate-token", json=body, headers=auth_headers("ana"))
    assert resp.json() == {"ok": False, "error": "Branch or tag 'nope' not found in org/app"}


async def test_add_repo_stores_the_parsed_ref(client, db):
    await make_user(db, "ana")
    body = {"repo_full_name": "org/app/tree/2.11", "github_token": "ghp_" + "a" * 36, "webhook_secret": "s"}
    resp = await client.post("/repos", json=body, headers=auth_headers("ana"))
    assert resp.status_code == 201, resp.text
    data = resp.json()
    assert data["repo_full_name"] == "org/app" and data["tracked_ref"] == "2.11"


async def test_update_repo_sets_validates_and_clears_the_tracked_ref(client, db, monkeypatch):
    await make_user(db, "ana")
    repo = await make_repo(db, "org/app", owner="ana")

    # Invalid shape is rejected before any GitHub call.
    resp = await client.patch(f"/repos/{repo.id}", json={"tracked_ref": "bad\nref"}, headers=auth_headers("ana"))
    assert resp.status_code == 422

    # A ref that doesn't exist is rejected too.
    await _github_json(monkeypatch, {}, ref_status=404)
    resp = await client.patch(f"/repos/{repo.id}", json={"tracked_ref": "missing"}, headers=auth_headers("ana"))
    assert resp.status_code == 422 and "not found" in resp.json()["detail"]

    # A real one is accepted and recorded.
    await _github_json(monkeypatch, {}, ref_status=200)
    resp = await client.patch(f"/repos/{repo.id}", json={"tracked_ref": "release/2.11"}, headers=auth_headers("ana"))
    assert resp.status_code == 200 and resp.json()["tracked_ref"] == "release/2.11"
    await db.refresh(repo)
    assert repo.tracked_ref == "release/2.11"

    # "" clears it back to the default branch, without a GitHub call (and not a no-op in the log).
    resp = await client.patch(f"/repos/{repo.id}", json={"tracked_ref": ""}, headers=auth_headers("ana"))
    assert resp.status_code == 200 and resp.json()["tracked_ref"] is None

    acts = (await db.execute(UserActivity.__table__.select().where(
        UserActivity.action == "repo_tracked_ref_changed").order_by(UserActivity.created_at))).all()
    assert [a.detail for a in acts] == ["org/app → release/2.11", "org/app → default branch"]


async def test_update_repo_tracked_ref_is_owner_only(client, db):
    await make_user(db, "ana")
    await make_user(db, "bob")
    repo = await make_repo(db, "org/app", owner="ana")
    resp = await client.patch(f"/repos/{repo.id}", json={"tracked_ref": "2.11"}, headers=auth_headers("bob"))
    assert resp.status_code == 403
    await db.refresh(repo)
    assert repo.tracked_ref is None
