"""Health page: service status panel."""

import httpx
from main import app

from routers import health
from tests.conftest import auth_headers, make_user


async def test_services_report_each_part(client, db, monkeypatch):
    await make_user(db, "root", role="admin")
    await make_user(db, "ana")
    calls = []

    async def probe(db):
        calls.append(1)
        return health._svc("LLM (Ollama)", "down", "unreachable (ConnectError)")

    monkeypatch.setattr(health, "_probe_llm", probe)
    await app.state.redis.set("custos:queue:health-check",
                              "Oct-13 10:00:00 j_complete=4 j_failed=0 j_retried=0 j_ongoing=1 queued=2")

    assert (await client.get("/health/services", headers=auth_headers("ana"))).status_code == 403
    body = (await client.get("/health/services", headers=auth_headers("root"))).json()
    by = {s["name"]: s for s in body["services"]}
    assert by["Postgres"]["state"] == by["Redis"]["state"] == "ok"
    assert by["Worker"] == {"name": "Worker", "state": "ok", "detail": "1 running · 2 queued"}
    assert by["LLM (Ollama)"]["state"] == "down"
    assert by["SentinelOne"]["state"] == "off"

    # The LLM is probed at most once a minute; the worker heartbeat can lapse.
    await app.state.redis.delete("custos:queue:health-check")
    body = (await client.get("/health/services", headers=auth_headers("root"))).json()
    assert len(calls) == 1
    assert {s["name"]: s["state"] for s in body["services"]}["Worker"] == "down"


async def test_llm_probe_explains_failures(db, monkeypatch):
    real = httpx.AsyncClient

    def with_handler(handler):
        monkeypatch.setattr(health.httpx, "AsyncClient",
                            lambda *a, **kw: real(*a, transport=httpx.MockTransport(handler), **kw))

    with_handler(lambda r: httpx.Response(200, json={"models": []}))
    assert (await health._probe_llm(db))["state"] == "ok"
    with_handler(lambda r: httpx.Response(401))
    assert (await health._probe_llm(db))["detail"] == "reachable, but the API key was rejected"

    def timeout(r):
        raise httpx.ConnectTimeout("slow", request=r)

    with_handler(timeout)
    assert "firewall" in (await health._probe_llm(db))["detail"]
