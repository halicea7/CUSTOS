"""The OpenAI Responses API provider: wire format, fallbacks, errors, and the
write-only API key on the Settings page."""
import functools
import json

import httpx
import pytest
from sqlalchemy import select

from app_config import RESPONSES_API_KEY, is_local_url
from models import AppConfig
from tests.conftest import auth_headers, make_user
from worker import tasks
from worker.analysis.llm import (
    _SYSTEM_PROMPT,
    PROVIDER_RESPONSES,
    LlmError,
    LlmProvider,
    _call_batch,
    responses_endpoint,
)

KEY = "sk-test-" + "k" * 40
PROVIDER = LlmProvider(kind=PROVIDER_RESPONSES, base_url="https://llm.example/v1", model="gpt-x", api_key=KEY)
FILES = [("app.py", "query = f'SELECT * FROM users WHERE id={uid}'")]
FINDINGS = {"findings": [{
    "title": "SQL injection", "severity": "high", "cwe": "CWE-89", "file_path": "app.py",
    "line_start": 1, "line_end": 1, "description": "d", "remediation": "r", "reasoning": "why",
}]}


def _ok_body(text: str, **extra) -> dict:
    return {
        "status": "completed",
        "output": [
            {"type": "reasoning", "summary": []},  # must be skipped
            {"type": "message", "role": "assistant",
             "content": [{"type": "output_text", "text": text, "annotations": []}]},
        ],
        "usage": {"input_tokens": 1200, "output_tokens": 80},
        **extra,
    }


async def _run(handler, provider=PROVIDER):
    requests = []

    def record(request: httpx.Request):
        requests.append(request)
        return handler(request, len(requests))

    async with httpx.AsyncClient(transport=httpx.MockTransport(record)) as client:
        result = await _call_batch(client, provider, FILES, [])
    return result, requests


async def test_request_shape_and_parsing():
    result, [req] = await _run(lambda r, n: httpx.Response(200, json=_ok_body(json.dumps(FINDINGS))))

    assert str(req.url) == "https://llm.example/v1/responses"
    assert req.headers["Authorization"] == f"Bearer {KEY}"
    body = json.loads(req.content)
    assert body["model"] == "gpt-x"
    assert body["instructions"] == _SYSTEM_PROMPT  # hardened prompt, not user input
    assert "app.py" in body["input"]
    assert body["store"] is False  # provider must not retain the code
    fmt = body["text"]["format"]
    assert fmt["type"] == "json_schema" and fmt["strict"] is True
    item = fmt["schema"]["properties"]["findings"]["items"]
    assert item["additionalProperties"] is False
    assert set(item["required"]) == set(item["properties"])  # strict mode requirement

    assert [f.title for f in result.findings] == ["SQL injection"]
    assert result.findings[0].source == "llm" and result.findings[0].cwe == "CWE-89"
    assert (result.prompt_tokens, result.completion_tokens) == (1200, 80)


async def test_falls_back_when_server_rejects_structured_output():
    def handler(request, n):
        fmt = json.loads(request.content).get("text", {}).get("format", {}).get("type")
        if fmt == "json_schema":
            return httpx.Response(400, json={"error": {"message": "text.format json_schema is not supported"}})
        if fmt == "json_object":
            return httpx.Response(400, json={"error": {"message": "unsupported response format"}})
        return httpx.Response(200, json=_ok_body("```json\n" + json.dumps(FINDINGS) + "\n```"))

    result, requests = await _run(handler)
    assert len(requests) == 3
    assert "text" not in json.loads(requests[-1].content)
    assert len(result.findings) == 1


async def test_other_400s_are_not_retried():
    calls = []

    def handler(request, n):
        calls.append(n)
        return httpx.Response(400, json={"error": {"message": "The model 'gpt-x' does not exist"}})

    with pytest.raises(LlmError, match="model 'gpt-x' does not exist") as exc:
        await _run(handler)
    assert calls == [1]  # a non-format error must not trigger the fallback chain
    assert KEY not in str(exc.value)


@pytest.mark.parametrize("status", [401, 403])
async def test_bad_key_reported_without_leaking_it(status):
    with pytest.raises(LlmError, match="rejected the API key") as exc:
        await _run(lambda r, n: httpx.Response(status, json={"error": {"message": f"Incorrect API key {KEY}"}}))
    assert KEY not in str(exc.value)


async def test_incomplete_and_refusal_are_errors():
    with pytest.raises(LlmError, match="incomplete.*max_output_tokens"):
        await _run(lambda r, n: httpx.Response(200, json={
            **_ok_body('{"findings": ['), "status": "incomplete",
            "incomplete_details": {"reason": "max_output_tokens"}}))
    refusal = {"status": "completed", "output": [{"type": "message", "content": [
        {"type": "refusal", "refusal": "I can't help with that."}]}]}
    with pytest.raises(LlmError, match="Model refused"):
        await _run(lambda r, n: httpx.Response(200, json=refusal))


@pytest.mark.parametrize("url,expected", [
    ("https://api.openai.com/v1", "https://api.openai.com/v1/responses"),
    ("https://api.openai.com/v1/", "https://api.openai.com/v1/responses"),
    ("https://api.openai.com", "https://api.openai.com/v1/responses"),
    ("https://api.openai.com/v1/responses", "https://api.openai.com/v1/responses"),
    ("https://openrouter.ai/api/v1", "https://openrouter.ai/api/v1/responses"),
])
def test_endpoint_normalisation(url, expected):
    assert responses_endpoint(url) == expected


@pytest.mark.parametrize("url,local", [
    ("http://localhost:8000/v1", True), ("http://127.0.0.1/v1", True), ("http://10.1.2.3/v1", True),
    ("http://vllm:8000/v1", True), ("http://gpu.internal/v1", True), ("http://host.docker.internal/v1", True),
    ("http://api.openai.com/v1", False), ("http://8.8.8.8/v1", False),
])
def test_is_local_url(url, local):
    assert is_local_url(url) is local


# ── Settings page / API ───────────────────────────────────────────────────────

async def test_api_key_is_write_only_and_encrypted(client, db):
    await make_user(db, "root", role="admin")
    h = auth_headers("root")
    resp = await client.patch("/settings/config", headers=h, json={
        "llm_provider": "responses", "responses_model": "gpt-x",
        "responses_base_url": "https://llm.example/v1", "responses_api_key": KEY,
    })
    assert resp.status_code == 200, resp.text
    cfg = resp.json()
    assert cfg["llm_provider"] == "responses" and cfg["responses_api_key_set"] is True
    assert cfg["responses_api_key_last4"] == KEY[-4:]
    assert KEY not in resp.text and KEY not in (await client.get("/settings/config", headers=h)).text

    row = (await db.execute(select(AppConfig).where(AppConfig.key == RESPONSES_API_KEY))).scalar_one()
    assert KEY not in row.value  # stored encrypted

    # Saving other settings leaves the key alone; an empty string removes it.
    await client.patch("/settings/config", headers=h, json={"worker_max_jobs": 3})
    assert (await client.get("/settings/config", headers=h)).json()["responses_api_key_set"] is True
    cleared = await client.patch("/settings/config", headers=h, json={"responses_api_key": ""})
    assert cleared.json()["responses_api_key_set"] is False


async def test_key_never_sent_over_plain_http_to_remote_hosts(client, db):
    await make_user(db, "root", role="admin")
    h = auth_headers("root")
    remote = await client.patch("/settings/config", headers=h, json={
        "responses_base_url": "http://llm.example.com/v1", "responses_api_key": KEY})
    assert remote.status_code == 422 and "https" in remote.text
    local = await client.patch("/settings/config", headers=h, json={
        "responses_base_url": "http://vllm:8000/v1", "responses_api_key": KEY})
    assert local.status_code == 200


async def test_responses_provider_requires_a_model(client, db):
    await make_user(db, "root", role="admin")
    resp = await client.patch("/settings/config", headers=auth_headers("root"),
                              json={"llm_provider": "responses", "responses_model": ""})
    assert resp.status_code == 422


async def test_only_admins_can_configure(client, db):
    await make_user(db, "ann")
    resp = await client.patch("/settings/config", headers=auth_headers("ann"),
                              json={"responses_api_key": KEY})
    assert resp.status_code == 403


async def test_connection_test_uses_stored_key_and_lists_models(client, db, monkeypatch):
    from routers import settings as settings_router

    await make_user(db, "root", role="admin")
    h = auth_headers("root")
    await client.patch("/settings/config", headers=h, json={
        "responses_base_url": "https://llm.example/v1", "responses_api_key": KEY})

    seen = {}

    def handler(request):
        seen["url"], seen["auth"] = str(request.url), request.headers.get("Authorization")
        return httpx.Response(200, json={"data": [{"id": "gpt-b"}, {"id": "gpt-a"}]})

    monkeypatch.setattr(settings_router.httpx, "AsyncClient",
                        functools.partial(httpx.AsyncClient, transport=httpx.MockTransport(handler)))
    resp = await client.post("/settings/config/test-responses", headers=h,
                             json={"base_url": "https://llm.example/v1"})
    assert resp.json() == {"ok": True, "models": ["gpt-a", "gpt-b"]}
    assert seen == {"url": "https://llm.example/v1/models", "auth": f"Bearer {KEY}"}
    assert KEY not in resp.text


async def test_worker_builds_provider_from_settings(client, db):
    from app_config import load_app_config

    await make_user(db, "root", role="admin")
    await client.patch("/settings/config", headers=auth_headers("root"), json={
        "llm_provider": "responses", "responses_model": "gpt-x",
        "responses_base_url": "https://llm.example/v1", "responses_api_key": KEY,
    })
    provider = await tasks._llm_provider(db, await load_app_config(db))
    assert (provider.kind, provider.model, provider.api_key) == ("responses", "gpt-x", KEY)
    assert provider.label == "gpt-x (Responses API)"
    assert KEY not in repr(provider)


# ── The saved key is bound to its origin ──────────────────────────────────────

async def _save_key(client, h, base_url="https://llm.example/v1"):
    resp = await client.patch("/settings/config", headers=h, json={
        "llm_provider": "responses", "responses_model": "gpt-x",
        "responses_base_url": base_url, "responses_api_key": KEY,
    })
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_test_endpoint_never_sends_saved_key_to_another_host(client, db, monkeypatch):
    from routers import settings as settings_router

    await make_user(db, "root", role="admin")
    h = auth_headers("root")
    cfg = await _save_key(client, h)
    assert cfg["responses_api_key_origin"] == "https://llm.example:443"

    sent = []
    monkeypatch.setattr(settings_router.httpx, "AsyncClient", functools.partial(
        httpx.AsyncClient, transport=httpx.MockTransport(
            lambda r: sent.append(r.headers.get("Authorization")) or httpx.Response(200, json={"data": []}))))

    # Attacker-chosen host: no key leaves the server.
    evil = await client.post("/settings/config/test-responses", headers=h,
                             json={"base_url": "https://attacker.example/v1"})
    assert evil.json()["ok"] is False and "only sent to https://llm.example:443" in evil.json()["error"]
    assert sent == []
    # Same origin, different path/trailing slash: allowed.
    same = await client.post("/settings/config/test-responses", headers=h,
                             json={"base_url": "https://llm.example:443/v1/"})
    assert same.json()["ok"] is True and sent == [f"Bearer {KEY}"]


async def test_changing_host_requires_re_entering_the_key(client, db):
    await make_user(db, "root", role="admin")
    h = auth_headers("root")
    await _save_key(client, h)

    moved = await client.patch("/settings/config", headers=h,
                               json={"responses_base_url": "https://attacker.example/v1"})
    assert moved.status_code == 422 and "bound to https://llm.example:443" in moved.text
    # Path changes on the same origin are fine.
    assert (await client.patch("/settings/config", headers=h,
                               json={"responses_base_url": "https://llm.example/v2"})).status_code == 200
    # Re-entering the key with the new host rebinds it.
    rebound = await client.patch("/settings/config", headers=h, json={
        "responses_base_url": "https://other.example/v1", "responses_api_key": KEY + "2"})
    assert rebound.status_code == 200
    assert rebound.json()["responses_api_key_origin"] == "https://other.example:443"


async def test_worker_only_gets_the_key_for_its_origin(db, client, monkeypatch):
    from app_config import load_responses_api_key
    from config import settings

    await make_user(db, "root", role="admin")
    await _save_key(client, auth_headers("root"))
    assert await load_responses_api_key(db, "https://llm.example/v1") == KEY
    assert await load_responses_api_key(db, "https://attacker.example/v1") == ""
    assert await load_responses_api_key(db, "http://llm.example/v1") == ""  # scheme is part of the origin

    # An env key is bound to the env base URL the same way.
    monkeypatch.setattr(settings, "RESPONSES_API_KEY", "sk-env")
    monkeypatch.setattr(settings, "RESPONSES_BASE_URL", "https://env-llm.example/v1")
    assert await load_responses_api_key(db, "https://env-llm.example/v1") == "sk-env"
    assert await load_responses_api_key(db, "https://attacker.example/v1") == ""
