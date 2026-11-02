"""Exploitation-PoC prompt building and answer validation (pure functions, no DB/LLM)."""

from types import SimpleNamespace

from worker.analysis import poc


def _f(severity="high", title="t", file="a.py", line=1, cwe=None, description="d", snippet=None):
    return SimpleNamespace(severity=severity, title=title, file_path=file, line_start=line, cwe=cwe,
                           description=description, code_snippet=snippet)


def _chain(title="Chain", severity="critical", confidence="high", narrative="n"):
    return SimpleNamespace(title=title, severity=severity, confidence=confidence, narrative=narrative)


def _steps(*findings, roles=None):
    roles = roles or ["entry", "impact"]
    return [{"label": f"Step {i + 1}", "role": roles[i], "why": f"why {i}", "finding": f}
            for i, f in enumerate(findings)]


def test_prompt_includes_every_step_in_order_with_its_code():
    steps = _steps(_f(title="Leak", file="a.py", line=10, snippet="print(secret)"),
                   _f(title="Reach", file="b.py", line=20, cwe="CWE-1", snippet="exec(x)"))
    text = poc.prompt(_chain(title="Leak then exec"), steps)
    assert "Leak then exec" in text
    assert text.index("Step 1") < text.index("print(secret)") < text.index("Step 2") < text.index("exec(x)")
    assert "CWE-1" in text


def test_validate_keeps_schema_shaped_steps_and_caps_their_count():
    steps = _steps(_f(), _f())
    raw = {
        "summary": "s", "preconditions": "p", "impact": "i", "caveats": "c",
        "steps": [{"label": "Step 1", "action": "a", "commands": "curl ...", "expected_result": "200"}] * 10,
    }
    out = poc.validate(raw, steps)
    assert len(out["steps"]) == poc.MAX_STEPS
    assert out["summary"] == "s" and out["impact"] == "i"


def test_validate_drops_malformed_steps_and_labels_unmatched_ones():
    steps = _steps(_f(), _f())
    raw = {"summary": "s", "preconditions": "p", "impact": "i", "caveats": "c", "steps": [
        {"label": "Step 1", "action": "a", "commands": "x", "expected_result": "y"},
        "not a dict",
        {"label": "made up label", "action": "a2", "commands": "x2", "expected_result": "y2"},
    ]}
    out = poc.validate(raw, steps)
    assert [s["label"] for s in out["steps"]] == ["Step 1", "made up label"]
    assert out["steps"][1]["action"] == "a2"


def test_validate_is_defensive_against_a_non_dict_or_missing_steps_answer():
    steps = _steps(_f())
    assert poc.validate({}, steps) == {"summary": "", "preconditions": "", "steps": [], "impact": "", "caveats": ""}
    assert poc.validate({"steps": "oops"}, steps)["steps"] == []


def test_parse_reads_plain_and_fenced_json():
    assert poc.SPEC.parse('{"summary": "s", "steps": []}') == {"summary": "s", "steps": []}
    assert poc.SPEC.parse('```json\n{"summary": "s"}\n```') == {"summary": "s"}
