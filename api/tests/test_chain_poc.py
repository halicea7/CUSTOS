"""Generating, reading and clearing an attack chain's exploitation PoC.

Admin-only, on demand, never part of the scan pipeline, never in the general
chain listing's content (see test_listing_never_includes_the_pocs_content).
"""

from models import AttackChain, Finding, UserActivity
from routers import signoff
from tests.conftest import auth_headers, make_repo, make_submission, make_user
from worker.analysis.llm import InvalidJson, LlmError, LlmResult

ANSWER = {
    "summary": "Forging the token then reading the export confirms full account takeover.",
    "preconditions": "Run against a local clone of this exact commit; never against production.",
    "steps": [
        {"label": "Step 1", "action": "Forge an unsigned token", "commands": "curl <target-host>/api/x -H 'Authorization: Bearer x'",
         "expected_result": "200 with another user's data"},
        {"label": "Step 2", "action": "Use it on the export endpoint", "commands": "curl <target-host>/api/export",
         "expected_result": "a CSV of every user"},
    ],
    "impact": "Full data export without valid credentials.",
    "caveats": "Exports may be large; use a test account with little data.",
}


async def _chain(db, *, repo="org/app", step2_disposition=None, create_user=True):
    if create_user:
        await make_user(db, "ana")
    await make_repo(db, repo, owner="ana")
    sub = await make_submission(db, repo)
    f1 = Finding(submission_id=sub.id, source="llm", severity="high", title="Forgeable token",
                file_path="auth.py", line_start=10, description="Tokens aren't verified.", code_snippet="if True: ok()")
    f2 = Finding(submission_id=sub.id, source="llm", severity="critical", title="Unauthenticated export",
                file_path="export.py", line_start=20, description="Anyone can export all data.",
                code_snippet="def export(): return db.all()", disposition=step2_disposition)
    db.add_all([f1, f2])
    await db.flush()
    chain = AttackChain(submission_id=sub.id, title="Forge a token, then export everything", severity="critical",
                        confidence="high", narrative="n", break_index=0,
                        steps=[{"finding_id": str(f1.id), "role": "entry", "why": "gets a session"},
                              {"finding_id": str(f2.id), "role": "impact", "why": "dumps everything"}])
    db.add(chain)
    await db.commit()
    return sub, chain


def _fake_complete(answer=None, calls: list | None = None):
    async def fake(client, provider, user_prompt, spec):
        if calls is not None:
            calls.append(user_prompt)
        assert spec is signoff.poc.SPEC
        return LlmResult(value=answer if answer is not None else ANSWER, prompt_tokens=5, completion_tokens=7)
    return fake


async def test_generate_is_admin_only(client, db):
    sub, chain = await _chain(db)
    resp = await client.post(f"/submissions/{sub.id}/chains/{chain.id}/poc", headers=auth_headers("ana"))
    assert resp.status_code == 403


async def test_generate_builds_the_prompt_from_both_steps_and_stores_the_answer(client, db, monkeypatch):
    sub, chain = await _chain(db)
    await make_user(db, "root", role="admin")
    calls: list = []
    monkeypatch.setattr(signoff, "complete", _fake_complete(calls=calls))

    resp = await client.post(f"/submissions/{sub.id}/chains/{chain.id}/poc", headers=auth_headers("root"))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["summary"] == ANSWER["summary"] and len(body["steps"]) == 2
    assert body["generated_by"] == "root" and body["model"]

    prompt = calls[0]
    assert "Forgeable token" in prompt and "Unauthenticated export" in prompt
    assert "if True: ok()" in prompt and "def export(): return db.all()" in prompt
    assert prompt.index("Step 1") < prompt.index("if True") < prompt.index("Step 2") < prompt.index("def export")

    await db.refresh(chain)
    assert chain.poc["summary"] == ANSWER["summary"] and chain.poc_generated_by == "root"
    act = (await db.execute(UserActivity.__table__.select().where(UserActivity.action == "chain_poc_generated"))).one()
    assert "org/app" in act.detail and chain.title[:20] in act.detail


async def test_broken_chain_is_refused_and_the_llm_is_never_called(client, db, monkeypatch):
    sub, chain = await _chain(db, step2_disposition="false_positive")
    await make_user(db, "root", role="admin")

    async def boom(*a, **kw):
        raise AssertionError("the LLM must not be called for a broken chain")

    monkeypatch.setattr(signoff, "complete", boom)
    resp = await client.post(f"/submissions/{sub.id}/chains/{chain.id}/poc", headers=auth_headers("root"))
    assert resp.status_code == 409 and "broken" in resp.json()["detail"]


async def test_llm_failure_is_a_clean_502_and_nothing_is_stored(client, db, monkeypatch):
    sub, chain = await _chain(db)
    await make_user(db, "root", role="admin")

    async def fail(client_, provider, user_prompt, spec):
        raise LlmError("connection refused")

    monkeypatch.setattr(signoff, "complete", fail)
    resp = await client.post(f"/submissions/{sub.id}/chains/{chain.id}/poc", headers=auth_headers("root"))
    assert resp.status_code == 502
    await db.refresh(chain)
    assert chain.poc is None


async def test_invalid_json_is_retried_once(client, db, monkeypatch):
    sub, chain = await _chain(db)
    await make_user(db, "root", role="admin")
    attempts = []

    async def flaky(client_, provider, user_prompt, spec):
        attempts.append(1)
        if len(attempts) == 1:
            raise InvalidJson("bad json")
        return LlmResult(value=ANSWER)

    monkeypatch.setattr(signoff, "complete", flaky)
    resp = await client.post(f"/submissions/{sub.id}/chains/{chain.id}/poc", headers=auth_headers("root"))
    assert resp.status_code == 200 and len(attempts) == 2


async def test_get_is_404_until_generated_then_returns_the_stored_poc(client, db, monkeypatch):
    sub, chain = await _chain(db)
    await make_user(db, "root", role="admin")
    headers = auth_headers("root")
    assert (await client.get(f"/submissions/{sub.id}/chains/{chain.id}/poc", headers=headers)).status_code == 404

    monkeypatch.setattr(signoff, "complete", _fake_complete())
    await client.post(f"/submissions/{sub.id}/chains/{chain.id}/poc", headers=headers)

    async def boom(*a, **kw):
        raise AssertionError("GET must not call the LLM again")

    monkeypatch.setattr(signoff, "complete", boom)
    resp = await client.get(f"/submissions/{sub.id}/chains/{chain.id}/poc", headers=headers)
    assert resp.status_code == 200 and resp.json()["summary"] == ANSWER["summary"]


async def test_delete_is_admin_only_and_clears_it(client, db, monkeypatch):
    sub, chain = await _chain(db)
    await make_user(db, "root", role="admin")
    headers = auth_headers("root")
    monkeypatch.setattr(signoff, "complete", _fake_complete())
    await client.post(f"/submissions/{sub.id}/chains/{chain.id}/poc", headers=headers)

    assert (await client.delete(f"/submissions/{sub.id}/chains/{chain.id}/poc", headers=auth_headers("ana"))).status_code == 403
    resp = await client.delete(f"/submissions/{sub.id}/chains/{chain.id}/poc", headers=headers)
    assert resp.status_code == 204
    assert (await client.get(f"/submissions/{sub.id}/chains/{chain.id}/poc", headers=headers)).status_code == 404
    await db.refresh(chain)
    assert chain.poc is None and chain.poc_generated_by is None


async def test_a_chain_id_from_another_submission_is_404(client, db):
    sub, chain = await _chain(db)
    other_sub, _ = await _chain(db, repo="org/app2", create_user=False)
    await make_user(db, "root", role="admin")
    resp = await client.post(f"/submissions/{other_sub.id}/chains/{chain.id}/poc", headers=auth_headers("root"))
    assert resp.status_code == 404


async def test_listing_never_includes_the_pocs_content(client, db, monkeypatch):
    sub, chain = await _chain(db)
    await make_user(db, "root", role="admin")
    monkeypatch.setattr(signoff, "complete", _fake_complete())
    await client.post(f"/submissions/{sub.id}/chains/{chain.id}/poc", headers=auth_headers("root"))

    resp = await client.get(f"/submissions/{sub.id}/chains", headers=auth_headers("ana"))
    assert resp.status_code == 200
    [row] = resp.json()["chains"]
    assert row["has_poc"] is True and row["poc_generated_by"] == "root"
    assert "poc" not in row and "steps" not in str(row.get("poc", ""))
    assert ANSWER["summary"] not in str(resp.json())
