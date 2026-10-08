from worker.analysis.llm import _extract_json, _parse_llm_response


def test_bare_array():
    out = _parse_llm_response('[{"title": "SQLi", "severity": "high", "line_start": "12"}]')
    assert len(out) == 1
    assert out[0].title == "SQLi"
    assert out[0].severity == "high"
    assert out[0].line_start == 12
    assert out[0].source == "llm"


def test_code_fences_and_think_blocks_are_stripped():
    raw = '<think>hmm [not json]</think>\n```json\n[{"title": "x", "severity": "low"}]\n```'
    assert [f.title for f in _parse_llm_response(raw)] == ["x"]


def test_wrapper_object():
    raw = '{"findings": [{"title": "a", "severity": "medium"}]}'
    assert [f.title for f in _parse_llm_response(raw)] == ["a"]


def test_single_object_becomes_one_finding():
    assert len(_parse_llm_response('{"title": "a", "severity": "low"}')) == 1


def test_invalid_severity_downgraded_to_info():
    assert _parse_llm_response('[{"title": "a", "severity": "EXTREME"}]')[0].severity == "info"


def test_garbage_returns_empty():
    assert _parse_llm_response("not json at all") == []
    assert _parse_llm_response('{"unrelated": 1}') == []


def test_extract_json_ignores_brackets_inside_strings():
    raw = 'Here you go:\n[{"title": "see [CWE-89]", "d": "a ] b"}] trailing'
    assert _extract_json(raw) == '[{"title": "see [CWE-89]", "d": "a ] b"}]'
