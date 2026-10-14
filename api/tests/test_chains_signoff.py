"""Attack chains (validation, storage, gate) and the two-stage sign-off."""
from types import SimpleNamespace

from models import AttackChain, Finding, LlmRun
from tests.conftest import auth_headers, make_repo, make_submission, make_user
from worker import tasks
from worker.analysis import chains
from worker.analysis.llm import LlmProvider, LlmResult


def _f(id, severity, title="t", file="a.py", line=1, source="semgrep"):
    return SimpleNamespace(id=id, severity=severity, title=title, file_path=file, line_start=line,
                           source=source, cwe=None, description="d")


def test_prompt_numbers_findings_like_the_findings_list():
    text, refs = chains.prompt([_f("x", "low"), _f("y", "critical"), _f("z", "high")], ["app.py", "b.py"])
    assert [r.id for r in refs.values()] == ["y", "z", "x"]
    assert "F1 [critical]" in text and "app.py" in text


def test_validate_drops_made_up_refs_and_never_lowers_severity():
    _, refs = chains.prompt([_f("a", "critical"), _f("b", "medium"), _f("c", "low")], [])
    raw = [
        {"title": "Real", "severity": "low", "confidence": "high", "narrative": "n", "break_at": "F2",
         "steps": [{"ref": "F2", "role": "entry", "why": "w"}, {"ref": "F1", "role": "impact", "why": "w"}]},
        {"title": "Made up", "severity": "critical", "confidence": "high", "narrative": "n", "break_at": "F9",
         "steps": [{"ref": "F9", "role": "entry", "why": "w"}, {"ref": "F1", "role": "impact", "why": "w"}]},
        {"title": "Duplicate step", "severity": "high", "confidence": "bogus", "narrative": "n", "break_at": "F3",
         "steps": [{"ref": "F3", "role": "entry", "why": "w"}, {"ref": "f3", "role": "x", "why": "w"}]},
    ]
    [chain] = chains.validate(raw, refs)
    assert chain["title"] == "Real" and chain["severity"] == "critical"   # raised to its worst step
    assert [s["finding_id"] for s in chain["steps"]] == ["b", "a"] and chain["break_index"] == 0


async def _run(db, findings):
    await make_repo(db, "org/r", "ana")
    return await make_submission(db, "org/r", findings=findings)


async def test_analyze_chains_stores_validated_chains(db, monkeypatch):
    sub = await _run(db, [{"severity": "critical"}, {"severity": "medium"}])
    rows = sorted((await db.execute(Finding.__table__.select())).all(), key=lambda r: r.severity != "critical")

    async def fake(client, provider, user_prompt, spec):
        assert spec is chains.SPEC and "F1 [critical]" in user_prompt
        return LlmResult(value=[{"title": "C", "severity": "high", "confidence": "medium", "narrative": "n",
                                 "break_at": "F2", "steps": [{"ref": "F2", "role": "entry", "why": "w"},
                                                             {"ref": "F1", "role": "impact", "why": "w"}]}],
                         prompt_tokens=10, completion_tokens=3)

    monkeypatch.setattr(tasks, "complete", fake)
    assert await tasks._analyze_chains(db, sub, LlmProvider(kind="ollama", base_url="", model="m"), "/nonexistent") is None
    await db.commit()
    [c] = (await db.execute(AttackChain.__table__.select())).all()
    assert c.severity == "critical" and c.break_index == 0 and c.steps[1]["finding_id"] == str(rows[0].id)
    # The pass is recorded as its own LLM run, visible on the run page.
    [run] = (await db.execute(LlmRun.__table__.select().where(LlmRun.triggered_by == "chains"))).all()
    assert (run.status, run.findings_count, run.prompt_tokens, run.completion_tokens) == ("complete", 1, 10, 3)


async def test_zero_kept_chains_explain_why(client, db, monkeypatch):
    await make_user(db, "ana")
    sub = await _run(db, [{"severity": "high"}, {"severity": "low"}])

    async def bogus(client, provider, user_prompt, spec):   # cites findings that don't exist
        return LlmResult(value=[{"title": "x", "severity": "high", "steps": [{"ref": "F7"}, {"ref": "F9"}]}])

    monkeypatch.setattr(tasks, "complete", bogus)
    await tasks._analyze_chains(db, sub, LlmProvider(kind="ollama", base_url="", model="m"), "/nonexistent")
    await db.commit()
    body = (await client.get(f"/submissions/{sub.id}/chains", headers=auth_headers("ana"))).json()
    assert body["chains"] == [] and body["analysis"]["status"] == "complete"
    assert "proposed 1" in body["analysis"]["note"] and "don't exist" in body["analysis"]["note"]


async def test_failed_chain_pass_is_recorded(db, monkeypatch):
    from worker.analysis.llm import LlmError

    sub = await _run(db, [{"severity": "high"}, {"severity": "low"}])

    async def refuse(client, provider, user_prompt, spec):
        raise LlmError("Model refused to review this batch")

    monkeypatch.setattr(tasks, "complete", refuse)
    note = await tasks._analyze_chains(db, sub, LlmProvider(kind="ollama", base_url="", model="m"), "/nonexistent")
    await db.commit()
    assert note.startswith("Attack chain analysis failed") and "refused" in note
    [run] = (await db.execute(LlmRun.__table__.select().where(LlmRun.triggered_by == "chains"))).all()
    assert run.status == "failed" and "refused" in run.error


def test_lenient_references_and_keys():
    _, refs = chains.prompt([_f("a", "high"), _f("b", "low")], [])
    raw = chains._parse('{"attack_chains": [{"title": "t", "severity": "high", "confidence": "low", '
                        '"steps": ["F1 (the high one)", {"ref": "f-2", "role": "impact"}], "break_at": 1}]}')
    stats = chains.Stats()
    [c] = chains.validate(raw, refs, stats)
    assert [s["finding_id"] for s in c["steps"]] == ["a", "b"] and stats.summary().endswith("kept 1.")


async def _chain(db, sub, severity="high"):
    ids = [str(f.id) for f in (await db.execute(Finding.__table__.select().where(Finding.submission_id == sub.id))).all()]
    db.add(AttackChain(submission_id=sub.id, title="c", severity=severity, confidence="low", narrative="",
                       steps=[{"finding_id": i, "role": "pivot", "why": ""} for i in ids], break_index=0))
    await db.commit()
    return ids


async def test_chain_gate_blocks_untriaged_low_severity_steps(client, db):
    await make_user(db, "ana")
    sub = await _run(db, [{"severity": "medium"}, {"severity": "low"}])
    ids = await _chain(db, sub, "high")
    h = auth_headers("ana")
    blocked = await client.post(f"/submissions/{sub.id}/signoff", headers=h, json={})
    assert blocked.status_code == 409 and "attack chain" in blocked.json()["detail"]
    body = (await client.get(f"/submissions/{sub.id}/chains", headers=h)).json()
    assert body["gate"] is True and len(body["chains"]) == 1
    # Dismissing one step breaks the chain, so it no longer gates.
    await client.patch(f"/findings/{ids[0]}/disposition", headers=h, json={"disposition": "false_positive"})
    assert (await client.post(f"/submissions/{sub.id}/signoff", headers=h, json={})).status_code == 200


async def test_chain_gate_can_be_turned_off(client, db):
    await make_user(db, "root", role="admin")
    sub = await _run(db, [{"severity": "medium"}, {"severity": "low"}])
    await _chain(db, sub, "critical")
    h = auth_headers("root")
    await client.patch("/settings/config", headers=h, json={"chain_gate": False})
    assert (await client.post(f"/submissions/{sub.id}/signoff", headers=h, json={})).status_code == 200


async def test_two_stage_sign_off(client, db):
    await make_user(db, "ana")
    await make_user(db, "root", role="admin")
    sub = await _run(db, [{"severity": "low"}])
    ana, root = auth_headers("ana"), auth_headers("root")

    first = await client.post(f"/submissions/{sub.id}/signoff", headers=ana, json={"note": "looks fine"})
    assert first.json()["status"] == "awaiting_approval"
    again = await client.post(f"/submissions/{sub.id}/signoff", headers=ana, json={})
    assert again.status_code == 409 and "waiting for an admin" in again.json()["detail"]
    assert (await client.post(f"/submissions/{sub.id}/signoff/return", headers=ana, json={"note": "x"})).status_code == 403
    assert (await client.post(f"/submissions/{sub.id}/signoff/return", headers=root, json={"note": ""})).status_code == 422

    back = await client.post(f"/submissions/{sub.id}/signoff/return", headers=root, json={"note": "check F2"})
    assert back.json()["status"] == "needs_review"
    await client.post(f"/submissions/{sub.id}/signoff", headers=ana, json={"note": "fixed"})
    done = await client.post(f"/submissions/{sub.id}/signoff", headers=root, json={"note": "approved"})
    assert done.json()["status"] == "signed_off"

    history = (await client.get(f"/submissions/{sub.id}/signoffs", headers=ana)).json()
    assert [(h["action"], h["by"], h["note"]) for h in history] == [
        ("analyst_sign_off", "ana", "looks fine"), ("sign_off_returned", "root", "check F2"),
        ("analyst_sign_off", "ana", "fixed"), ("sign_off", "root", "approved")]


def test_steps_are_found_under_other_keys_and_shapes():
    _, refs = chains.prompt([_f("a", "critical"), _f("b", "high"), _f("c", "low")], [])
    raw = [
        {"title": "path of objects", "severity": "high", "path": [
            {"finding": "F2", "explanation": "first"}, {"finding_id": "F1", "reason": "then"}]},
        {"title": "bare list", "severity": "high", "findings": ["F3", "F2"]},
        {"title": "ref only in text", "severity": "high", "chain": [
            {"description": "Uses F1 to start"}, {"description": "then F3"}]},
        {"title": "no refs at all", "severity": "high", "summary": "x"},
        {"title": "words only", "severity": "high", "steps": [{"description": "one of 2 issues"}, {"description": "half 3"}]},
    ]
    stats = chains.Stats()
    kept = chains.validate(raw, refs, stats)
    assert sorted(c["title"] for c in kept) == ["bare list", "path of objects", "ref only in text"]
    first = next(c for c in kept if c["title"] == "path of objects")
    assert [s["finding_id"] for s in first["steps"]] == ["b", "a"] and first["steps"][0]["why"] == "first"
    assert stats.too_short == 2 and "keys: severity, summary, title" in stats.summary()


def test_prompt_shows_the_exact_json_shape():
    assert '"steps": [' in chains.SPEC.system and '{"ref": "F4", "role": "entry"' in chains.SPEC.system
