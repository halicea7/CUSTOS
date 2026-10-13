import pytest

from worker.analysis.llm import LlmError, _batch_files, _parse_llm_response

FINDING = '{"title": "SQLi", "severity": "HIGH", "file_path": "app.py", "line_start": "12", "reasoning": "r"}'


def test_parses_wrapped_findings():
    out = _parse_llm_response('{"findings": [' + FINDING + "]}")
    assert len(out) == 1
    f = out[0]
    assert (f.title, f.severity, f.line_start, f.llm_reasoning) == ("SQLi", "high", 12, "r")
    assert f.source == "llm"


def test_parses_bare_array_and_single_object():
    assert len(_parse_llm_response("[" + FINDING + "]")) == 1
    assert len(_parse_llm_response(FINDING)) == 1


def test_strips_think_blocks_and_fences():
    content = "<think>hmm [x]</think>\n```json\n{\"findings\": [" + FINDING + "]}\n```"
    assert len(_parse_llm_response(content)) == 1


def test_empty_results():
    assert _parse_llm_response('{"findings": []}') == []
    assert _parse_llm_response("{}") == []
    assert _parse_llm_response("[]") == []


def test_invalid_json_raises():
    with pytest.raises(LlmError):
        _parse_llm_response("I could not find anything, sorry")


def test_unknown_object_raises():
    with pytest.raises(LlmError):
        _parse_llm_response('{"summary": "all good"}')


def test_bad_severity_and_non_string_fields_are_coerced():
    out = _parse_llm_response('[{"title": 5, "severity": null, "remediation": {"a": 1}}]')
    assert out[0].severity == "info"
    assert out[0].title == "5"
    assert out[0].remediation == '{"a": 1}'


def test_batch_files_packs_greedily():
    files = [("a", "x" * 40), ("b", "x" * 40), ("c", "x" * 40)]
    assert [[p for p, _ in b] for b in _batch_files(files, 100)] == [["a", "b"], ["c"]]
    # An oversized file still gets its own batch rather than being dropped.
    assert len(_batch_files([("big", "x" * 500)], 100)) == 1


def test_raw_newlines_inside_strings_are_accepted():
    from worker.analysis.llm import _parse_llm_response

    text = '{"findings": [{"title": "Hardcoded creds", "severity": "high", "description": "line one\nline two"}]}'
    [f] = _parse_llm_response(text)
    assert f.description == "line one\nline two"


def test_one_malformed_finding_does_not_lose_the_others():
    from worker.analysis.llm import _parse_llm_response

    text = ('{"findings": [\n'
            '  {"title": "Good one", "severity": "high"},\n'
            '  {"title": "Broken "quote" here", "severity": "low"},\n'
            '  {"title": "Also good", "severity": "medium", "description": "has {braces} and [brackets]"}\n'
            ']}')
    titles = [f.title for f in _parse_llm_response(text)]
    assert titles == ["Good one", "Also good"]


def test_hopeless_json_still_raises_invalid_json():
    import pytest

    from worker.analysis.llm import InvalidJson, LlmError, _parse_llm_response

    with pytest.raises(InvalidJson):
        _parse_llm_response('{"findings": [ {"title": "cut off')
    assert issubclass(InvalidJson, LlmError)
