"""Amazon Bedrock: URLs, the Responses request, the write-only key, and data retention."""
import functools
import json

import bedrock
import httpx
import pytest

from tests.conftest import auth_headers, make_user
from worker import tasks
from worker.analysis.llm import PROVIDER_BEDROCK, LlmProvider, _call_batch

KEY = "bedrock-api-key-" + "b" * 40
FINDINGS = {"findings": []}
OK = {"status": "completed", "usage": {"input_tokens": 10, "output_tokens": 2},
      "output": [{"type": "message", "content": [{"type": "output_text", "text": json.dumps(FINDINGS)}]}]}


def _mock(monkeypatch, module, handler):
    monkeypatch.setattr(module.httpx, "AsyncClient",
                        functools.partial(httpx.AsyncClient, transport=httpx.MockTransport(handler)))


def test_urls_are_built_from_the_region_only():
    assert bedrock.base_url("us-east-1", "mantle") == "https://bedrock-mantle.us-east-1.api.aws/v1"
    assert bedrock.alternate_base_url("us-east-1", "mantle") == "https://bedrock-mantle.us-east-1.api.aws/openai/v1"
    assert bedrock.base_url("us-gov-west-1", "runtime") == "https://bedrock-runtime.us-gov-west-1.amazonaws.com/openai/v1"
    assert bedrock.alternate_base_url("us-east-1", "runtime") == ""
    for bad in ("evil.example", "us-east-1.evil.example/", "", "US EAST"):
        with pytest.raises(ValueError):
            bedrock.base_url(bad, "mantle")


async def test_request_goes_to_bedrock_with_project_and_falls_back_to_openai_prefix():
    provider = LlmProvider(kind=PROVIDER_BEDROCK, model="openai.gpt-oss-120b", api_key=KEY,
                           base_url=bedrock.base_url("us-east-1", "mantle"),
                           alt_base_url=bedrock.alternate_base_url("us-east-1", "mantle"),
                           extra_headers=bedrock.project_headers("proj_custos", "mantle"))
    seen = []

    def handler(request):
        seen.append(request)
        if request.url.path == "/v1/responses":
            return httpx.Response(400, json={"error": {"message": "model `x` isn't supported on this route"}})
        return httpx.Response(200, json=OK)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await _call_batch(client, provider, [("a.py", "x = 1")], [])
    assert result.prompt_tokens == 10
    assert [r.url.path for r in seen] == ["/v1/responses", "/openai/v1/responses"]
    last = seen[-1]
    assert last.url.host == "bedrock-mantle.us-east-1.api.aws"
    assert last.headers["Authorization"] == f"Bearer {KEY}" and last.headers["OpenAI-Project"] == "proj_custos"
    assert json.loads(last.content)["store"] is False
    assert provider.label == "openai.gpt-oss-120b (Bedrock)"


def test_project_header_only_on_mantle():
    assert bedrock.project_headers("proj_x", "runtime") == {}
    assert bedrock.project_headers("", "mantle") == {}


async def _admin(db):
    await make_user(db, "root", role="admin")
    return auth_headers("root")


async def _save(client, h, **extra):
    body = {"llm_provider": "bedrock", "bedrock_region": "us-east-1", "bedrock_endpoint": "mantle",
            "bedrock_model": "openai.gpt-oss-120b", "bedrock_api_key": KEY, **extra}
    return await client.patch("/settings/config", headers=h, json=body)


async def test_key_is_write_only_and_provider_needs_region_model_key(client, db):
    h = await _admin(db)
    missing = await client.patch("/settings/config", headers=h, json={"llm_provider": "bedrock"})
    assert missing.status_code == 422 and "region, model, API key" in missing.json()["detail"]

    resp = await _save(client, h, bedrock_project_id="proj_custos")
    assert resp.status_code == 200, resp.text
    cfg = resp.json()
    assert cfg["bedrock_api_key_set"] is True and cfg["bedrock_api_key_last4"] == KEY[-4:]
    assert KEY not in resp.text and KEY not in (await client.get("/settings/config", headers=h)).text

    provider = await tasks._llm_provider(db, (await tasks.load_app_config(db)))
    assert provider.kind == PROVIDER_BEDROCK and provider.api_key == KEY
    assert provider.base_url == "https://bedrock-mantle.us-east-1.api.aws/v1"
    assert provider.extra_headers == {"OpenAI-Project": "proj_custos"}

    bad = await client.patch("/settings/config", headers=h, json={"bedrock_region": "evil.example"})
    assert bad.status_code == 422


async def test_test_bedrock_lists_models_with_availability(client, db, monkeypatch):
    h = await _admin(db)
    await _save(client, h)
    seen = {}

    def handler(request):
        seen["url"], seen["auth"] = str(request.url), request.headers.get("Authorization")
        return httpx.Response(200, json={"data": [
            {"id": "openai.gpt-oss-120b", "status": "available"},
            {"id": "anthropic.claude-fable-5", "status": "unavailable",
             "status_reason": "This model is not available under data retention mode 'default'."}]})

    _mock(monkeypatch, bedrock, handler)
    body = (await client.post("/settings/config/test-bedrock", headers=h, json={"region": "us-east-1"})).json()
    assert seen == {"url": "https://bedrock-mantle.us-east-1.api.aws/v1/models", "auth": f"Bearer {KEY}"}
    assert body["ok"] and body["models"] == ["anthropic.claude-fable-5", "openai.gpt-oss-120b"]
    assert body["details"][0]["unavailable"] is True and "retention" in body["details"][0]["status_reason"]

    runtime = (await client.post("/settings/config/test-bedrock", headers=h,
                                 json={"region": "us-east-1", "endpoint": "runtime"})).json()
    assert runtime["ok"] and runtime["models"] == [] and "can't list models" in runtime["note"]


async def test_retention_reads_account_project_and_model(client, db, monkeypatch):
    h = await _admin(db)
    await _save(client, h, bedrock_project_id="proj_custos")
    calls = []

    def handler(request):
        calls.append((request.method, request.url.path, request.headers.get("x-api-key")))
        if request.url.path == "/v1/data_retention":
            return httpx.Response(200, json={"mode": "inherit", "updated_at": 1})
        if request.url.path.startswith("/v1/organization/projects/"):
            return httpx.Response(200, json={"id": "proj_custos", "name": "custos", "data_retention": {"mode": "none"}})
        return httpx.Response(200, json={"id": "openai.gpt-oss-120b", "status": "available", "data_retention": {
            "mode": "none", "source": "project", "allowed_modes": ["none", "default", "aws_review"]}})

    _mock(monkeypatch, bedrock, handler)
    body = (await client.get("/settings/bedrock/retention", headers=h)).json()
    assert body["account"]["mode"] == "inherit"
    assert body["project"] == {"id": "proj_custos", "name": "custos", "mode": "none"}
    assert body["model"]["source"] == "project" and body["model"]["allowed_modes"][0] == "none"
    assert {c[2] for c in calls} == {KEY}  # management routes use x-api-key
    assert "provider_data_share" not in body["settable_modes"]


async def test_retention_failures_are_reported_per_part(client, db, monkeypatch):
    h = await _admin(db)
    await _save(client, h)
    _mock(monkeypatch, bedrock, lambda r: httpx.Response(403, json={"message": "not authorized"}))
    body = (await client.get("/settings/bedrock/retention", headers=h)).json()
    assert "HTTP 403" in body["account"]["error"] and "not authorized" in body["account"]["error"]
    assert body["project"] is None  # no project saved


async def test_set_retention_project_and_guarded_account(client, db, monkeypatch):
    h = await _admin(db)
    await _save(client, h, bedrock_project_id="proj_custos")
    writes = []

    def handler(request):
        if request.method in ("POST", "PUT"):
            writes.append((request.method, request.url.path, json.loads(request.content)))
        return httpx.Response(200, json={"mode": "none", "data_retention": {"mode": "none"}})

    _mock(monkeypatch, bedrock, handler)
    ok = await client.put("/settings/bedrock/retention", headers=h, json={"scope": "project", "mode": "none"})
    assert ok.status_code == 200
    assert writes[-1] == ("POST", "/v1/organization/projects/proj_custos", {"data_retention": {"mode": "none"}})

    unconfirmed = await client.put("/settings/bedrock/retention", headers=h, json={"scope": "account", "mode": "none"})
    assert unconfirmed.status_code == 422 and len(writes) == 1

    confirmed = await client.put("/settings/bedrock/retention", headers=h,
                                 json={"scope": "account", "mode": "aws_review", "confirm_account": True})
    assert confirmed.status_code == 200
    assert writes[-1] == ("PUT", "/v1/data_retention", {"mode": "aws_review"})

    legacy = await client.put("/settings/bedrock/retention", headers=h,
                              json={"scope": "project", "mode": "provider_data_share"})
    assert legacy.status_code == 422


async def test_set_retention_on_runtime_uses_control_plane(client, db, monkeypatch):
    h = await _admin(db)
    await _save(client, h, bedrock_endpoint="runtime")
    seen = []

    def handler(request):
        seen.append((request.method, str(request.url), request.headers.get("Authorization")))
        return httpx.Response(200, json={"mode": "none"})

    _mock(monkeypatch, bedrock, handler)
    resp = await client.put("/settings/bedrock/retention", headers=h,
                            json={"scope": "account", "mode": "none", "confirm_account": True})
    assert resp.status_code == 200
    assert seen[0] == ("PUT", "https://bedrock.us-east-1.amazonaws.com/data-retention", f"Bearer {KEY}")
    project = await client.put("/settings/bedrock/retention", headers=h, json={"scope": "project", "mode": "none"})
    assert project.status_code == 502 and "bedrock-mantle" in project.json()["detail"]


async def test_retention_needs_admin_and_saved_settings(client, db):
    await make_user(db, "ana")
    assert (await client.get("/settings/bedrock/retention", headers=auth_headers("ana"))).status_code == 403
    h = await _admin(db)
    assert (await client.get("/settings/bedrock/retention", headers=h)).status_code == 409


def _messages_ok(text=json.dumps(FINDINGS), stop="end_turn"):
    return {"type": "message", "content": [{"type": "text", "text": text}], "stop_reason": stop,
            "usage": {"input_tokens": 30, "output_tokens": 4}}


def _bedrock(model, **kw):
    return LlmProvider(kind=PROVIDER_BEDROCK, model=model, api_key=KEY,
                       base_url=bedrock.base_url("us-east-1", "mantle"),
                       messages_url=bedrock.messages_url("us-east-1", "mantle"), **kw)


async def _batch(provider, handler):
    seen = []

    def record(request):
        seen.append(request)
        return handler(request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(record)) as client:
        return await _call_batch(client, provider, [("a.py", "x = 1")], []), seen


async def test_claude_models_use_the_messages_api():
    from worker.analysis.llm import _SYSTEM_PROMPT, is_anthropic_model

    assert is_anthropic_model("anthropic.claude-haiku-4-5") and is_anthropic_model("us.anthropic.claude-sonnet-5")
    assert not is_anthropic_model("openai.gpt-oss-120b")
    result, [req] = await _batch(_bedrock("anthropic.claude-haiku-4-5"), lambda r: httpx.Response(200, json=_messages_ok()))
    assert str(req.url) == "https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages"
    assert req.headers["x-api-key"] == KEY and req.headers["anthropic-version"] == "2023-06-01"
    body = json.loads(req.content)
    assert body["model"] == "anthropic.claude-haiku-4-5" and body["system"] == _SYSTEM_PROMPT
    assert body["max_tokens"] == 16_384 and body["messages"][0]["role"] == "user"
    assert (result.prompt_tokens, result.completion_tokens) == (30, 4)


async def test_other_models_fall_back_to_messages_when_responses_is_unsupported():
    def handler(request):
        if request.url.path.endswith("/responses"):
            return httpx.Response(400, json={"error": {"message": "The model 'x.y' does not support the '/v1/responses' API"}})
        return httpx.Response(200, json=_messages_ok())

    result, seen = await _batch(_bedrock("x.y"), handler)
    assert [r.url.path for r in seen] == ["/v1/responses", "/anthropic/v1/messages"]
    assert result.prompt_tokens == 30


async def test_messages_cut_off_and_errors_are_explained():
    from worker.analysis.llm import LlmError

    with pytest.raises(LlmError, match="max_tokens"):
        await _batch(_bedrock("anthropic.claude-haiku-4-5", max_output_tokens=100),
                     lambda r: httpx.Response(200, json=_messages_ok('{"findings": [', "max_tokens")))
    with pytest.raises(LlmError, match="HTTP 400: bad model"):
        await _batch(_bedrock("anthropic.claude-haiku-4-5"),
                     lambda r: httpx.Response(400, json={"type": "error", "error": {"type": "invalid_request_error", "message": "bad model"}}))


def test_messages_url_per_endpoint():
    assert bedrock.messages_url("us-east-1", "runtime") == "https://bedrock-runtime.us-east-1.amazonaws.com/anthropic/v1/messages"


async def test_invalid_json_batch_is_retried_once(monkeypatch):
    from worker.analysis import llm

    calls = []

    async def flaky(client, provider, files, ctx):
        calls.append(1)
        if len(calls) == 1:
            raise llm.InvalidJson("Model returned invalid JSON")
        return llm.LlmResult(findings=[], prompt_tokens=5)

    monkeypatch.setattr(llm, "_call_batch", flaky)
    monkeypatch.setattr(llm, "_select_files", lambda *a, **k: [("a.py", "x = 1")])
    result = await llm.call_llm("/tmp", [], _bedrock("anthropic.claude-haiku-4-5"))
    assert len(calls) == 2 and not result.errors
