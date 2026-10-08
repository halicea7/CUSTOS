"""End-to-end through the real prompt builder and HTTP layer (only the
server is mocked). Worker tests mock the LLM call entirely, which once hid a
prompt template that crashed on every request."""
import json

import httpx

from worker.analysis.llm import _USER_PROMPT_TEMPLATE, PROVIDER_OLLAMA, LlmProvider, _call_batch


def test_user_prompt_template_formats():
    out = _USER_PROMPT_TEMPLATE.format(sast_json="[]", file_contents="=== a.py ===\nx = '{not a field}'")
    assert '{"findings": [...]}' in out
    assert "{not a field}" in out  # braces in code are data, not placeholders


async def test_ollama_round_trip_with_braces_in_code():
    seen = {}

    def handler(request):
        seen["body"] = json.loads(request.content)
        content = json.dumps({"findings": [{"title": "t", "severity": "low", "description": "d",
                                            "remediation": "r", "reasoning": "w"}]})
        return httpx.Response(200, json={"message": {"content": content},
                                         "prompt_eval_count": 10, "eval_count": 2})

    provider = LlmProvider(kind=PROVIDER_OLLAMA, base_url="http://ollama:11434", model="m")
    files = [("app.py", "d = {'k': 1}\nprint(f'{d}')")]
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await _call_batch(client, provider, files, [])

    user_msg = seen["body"]["messages"][1]["content"]
    assert "=== app.py ===" in user_msg and "print(f'{d}')" in user_msg
    assert seen["body"]["format"]["required"] == ["findings"]
    assert [f.title for f in result.findings] == ["t"] and result.prompt_tokens == 10
