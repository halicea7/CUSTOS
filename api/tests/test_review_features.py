"""Run page: comparison with the previous scan, and bulk triage."""

from datetime import UTC, datetime, timedelta

from models import AuditLog, Finding, Submission
from tests.conftest import auth_headers, make_repo, make_user


async def _run(db, *, ago, findings, status="needs_review", branch="main", pr=None, repo="org/r"):
    sub = Submission(repo_full_name=repo, repo_url=f"https://github.com/{repo}.git", commit_sha=f"{ago:040d}",
                     status=status, branch=branch, pr_number=pr,
                     created_at=datetime.now(UTC) - timedelta(hours=ago))
    db.add(sub)
    await db.flush()
    rows = [Finding(submission_id=sub.id, source=src, severity="high", title=title, file_path=path, line_start=line)
            for src, title, path, line in findings]
    db.add_all(rows)
    await db.commit()
    return sub, rows


SQLI = ("semgrep", "formatted-sql-query", "app/db.py", 40)
XSS = ("semgrep", "reflected-xss", "app/views.py", 12)
LLM_OLD = ("llm", "SQL Injection in search endpoint", "app/search.py", 30)
LLM_NEW = ("llm", "Potential SQL injection in the search endpoint", "app/search.py", 34)


async def test_compare_reports_new_and_fixed(client, db):
    await make_user(db, "alice")
    await make_repo(db, "org/r", owner="alice")
    await _run(db, ago=10, findings=[SQLI, XSS, LLM_OLD], status="signed_off")
    sub, rows = await _run(db, ago=1, findings=[("semgrep", *SQLI[1:3], 45), LLM_NEW,
                                                 ("gitleaks", "aws-key", "conf.yml", 3)])

    body = (await client.get(f"/submissions/{sub.id}/compare", headers=auth_headers("alice"))).json()
    assert body["previous"]["status"] == "signed_off"
    # The SQLi moved 5 lines and the LLM reworded its finding: neither is new.
    assert body["new_finding_ids"] == [str(rows[2].id)]
    assert [f["title"] for f in body["fixed"]] == ["reflected-xss"]


async def test_compare_prefers_same_pr_and_handles_first_scan(client, db):
    await make_user(db, "alice")
    await make_repo(db, "org/r", owner="alice")
    first, _ = await _run(db, ago=30, findings=[SQLI])
    body = (await client.get(f"/submissions/{first.id}/compare", headers=auth_headers("alice"))).json()
    assert body == {"previous": None, "new_finding_ids": [], "fixed": []}

    pr_old, _ = await _run(db, ago=20, findings=[XSS], branch="feat", pr=7)
    await _run(db, ago=10, findings=[SQLI], branch="main")       # newer, but not the same PR
    await _run(db, ago=5, findings=[SQLI], status="error")       # unfinished runs are skipped
    pr_new, _ = await _run(db, ago=1, findings=[XSS], branch="feat", pr=7)
    body = (await client.get(f"/submissions/{pr_new.id}/compare", headers=auth_headers("alice"))).json()
    assert body["previous"]["id"] == str(pr_old.id) and body["new_finding_ids"] == [] and body["fixed"] == []


async def test_compare_respects_visibility(client, db):
    await make_user(db, "alice")
    await make_user(db, "mallory")
    await make_repo(db, "org/r", owner="alice")
    sub, _ = await _run(db, ago=1, findings=[SQLI])
    assert (await client.get(f"/submissions/{sub.id}/compare", headers=auth_headers("mallory"))).status_code == 404


async def test_bulk_disposition_applies_to_all_with_audit(client, db):
    await make_user(db, "alice")
    await make_repo(db, "org/r", owner="alice")
    _, rows = await _run(db, ago=1, findings=[SQLI, XSS, LLM_NEW])
    ids = [str(rows[0].id), str(rows[2].id)]

    resp = await client.post("/findings/bulk-disposition", headers=auth_headers("alice"),
                             json={"finding_ids": ids, "disposition": "false_positive", "note": "test fixtures"})
    assert resp.status_code == 200
    assert [f["id"] for f in resp.json()] == ids
    assert all(f["disposition"] == "false_positive" and f["disposed_by"] == "alice" for f in resp.json())

    await db.rollback()
    untouched = await db.get(Finding, rows[1].id)
    assert untouched.disposition is None
    audit = (await db.execute(AuditLog.__table__.select())).all()
    assert len(audit) == 2 and {a.note for a in audit} == {"test fixtures"}


async def test_bulk_disposition_is_all_or_nothing(client, db):
    await make_user(db, "alice")
    await make_user(db, "bob")
    await make_repo(db, "org/r", owner="alice")
    await make_repo(db, "org/b", owner="bob")
    _, mine = await _run(db, ago=1, findings=[SQLI])
    _, theirs = await _run(db, ago=1, findings=[XSS], repo="org/b")

    resp = await client.post("/findings/bulk-disposition", headers=auth_headers("alice"),
                             json={"finding_ids": [str(mine[0].id), str(theirs[0].id)], "disposition": "confirmed"})
    assert resp.status_code == 404
    await db.rollback()
    assert (await db.get(Finding, mine[0].id)).disposition is None

    bad = await client.post("/findings/bulk-disposition", headers=auth_headers("alice"),
                            json={"finding_ids": [], "disposition": "confirmed"})
    assert bad.status_code == 422
