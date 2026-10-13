"""Amazon Bedrock: endpoint URLs and data-retention settings.

Bedrock serves the OpenAI Responses API, so reviews go through the same
request code as any Responses server. Custos builds every Bedrock URL itself
from a validated region name, so the API key only ever goes to AWS.

Data retention is not a per-request setting. It is a mode set on a Bedrock
project or on the whole account in one Region; the effective mode for a
request is the first of project → account → model default that isn't
``inherit``. See the AWS "Data retention" user guide.
"""

import re
from urllib.parse import quote

import httpx

REGION_RE = re.compile(r"^[a-z]{2}(?:-gov)?-[a-z]+-\d{1,2}$")
PROJECT_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")

ENDPOINT_MANTLE = "mantle"    # bedrock-mantle: models list, projects, background jobs
ENDPOINT_RUNTIME = "runtime"  # bedrock-runtime: AWS's recommended endpoint, default project only
ENDPOINTS = (ENDPOINT_MANTLE, ENDPOINT_RUNTIME)

# Least to most permissive; "inherit" defers to the broader scope.
# provider_data_share is legacy (AWS says to use aws_review): shown, never set.
MODES = ("none", "default", "aws_review", "provider_data_share")
SETTABLE_MODES = ("inherit", "none", "default", "aws_review")

_TIMEOUT = 10
# On bedrock-mantle some models live under /openai/v1 instead of /v1.
_WRONG_ROUTE = "isn't supported on this route"


def check_region(region: str) -> str:
    region = (region or "").strip().lower()
    if not REGION_RE.match(region):
        raise ValueError("Enter an AWS region such as us-east-1")
    return region


def base_url(region: str, endpoint: str, openai_prefix: bool = False) -> str:
    """The Responses API base URL (requests go to {base}/responses)."""
    region = check_region(region)
    if endpoint == ENDPOINT_RUNTIME:
        return f"https://bedrock-runtime.{region}.amazonaws.com/openai/v1"
    return f"https://bedrock-mantle.{region}.api.aws{'/openai/v1' if openai_prefix else '/v1'}"


def alternate_base_url(region: str, endpoint: str) -> str:
    """The other mantle path prefix, tried when a model rejects the first one."""
    return base_url(region, endpoint, openai_prefix=True) if endpoint == ENDPOINT_MANTLE else ""


def messages_url(region: str, endpoint: str) -> str:
    """Anthropic Messages API URL, used for Claude models (they don't serve Responses)."""
    region = check_region(region)
    if endpoint == ENDPOINT_RUNTIME:
        return f"https://bedrock-runtime.{region}.amazonaws.com/anthropic/v1/messages"
    return f"https://bedrock-mantle.{region}.api.aws/anthropic/v1/messages"


def is_wrong_route(text: str) -> bool:
    return _WRONG_ROUTE in (text or "")


def project_headers(project_id: str, endpoint: str) -> dict[str, str]:
    """Route mantle requests to Custos's own project (its retention mode applies)."""
    return {"OpenAI-Project": project_id} if project_id and endpoint == ENDPOINT_MANTLE else {}


class BedrockError(RuntimeError):
    pass


def _mantle(region: str) -> str:
    return f"https://bedrock-mantle.{check_region(region)}.api.aws/v1"


def _control_plane(region: str) -> str:
    return f"https://bedrock.{check_region(region)}.amazonaws.com"


def _error(resp: httpx.Response, what: str) -> str:
    try:
        body = resp.json()
        msg = body.get("message") or body.get("Message") or (body.get("error") or {}).get("message")
    except (ValueError, AttributeError):
        msg = None
    if resp.status_code in (401, 403):
        hint = "the key was rejected, or it lacks permission for this"
        return f"Bedrock refused to {what} (HTTP {resp.status_code}): {msg or hint}"
    return f"Couldn't {what}: HTTP {resp.status_code}{f' — {msg}' if msg else ''}"


async def _request(method: str, url: str, key: str, what: str, json: dict | None = None,
                   bearer: bool = False) -> dict:
    # Management routes on bedrock-mantle take x-api-key; the control plane takes a bearer token.
    headers = {"Authorization": f"Bearer {key}"} if bearer else {"x-api-key": key}
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.request(method, url, headers=headers, json=json)
    except httpx.TimeoutException as exc:
        raise BedrockError(f"Couldn't {what}: no answer within {_TIMEOUT}s") from exc
    except httpx.HTTPError as exc:
        raise BedrockError(f"Couldn't {what}: {type(exc).__name__}") from exc
    if resp.status_code >= 400:
        raise BedrockError(_error(resp, what))
    try:
        return resp.json() or {}
    except ValueError:
        return {}


async def _part(coro) -> dict:
    """Run one lookup; a failure becomes {"error": ...} so the others still show."""
    try:
        return await coro
    except BedrockError as exc:
        return {"error": str(exc)}


async def get_retention(region: str, endpoint: str, key: str, project_id: str, model: str) -> dict:
    """Account, project and model retention, as far as this endpoint exposes them."""
    out: dict = {"endpoint": endpoint, "account": None, "project": None, "model": None}
    if endpoint == ENDPOINT_RUNTIME:
        # bedrock-runtime has no projects and no per-model retention signal.
        out["account"] = await _part(_account_runtime(region, key))
        return out
    out["account"] = await _part(_request("GET", f"{_mantle(region)}/data_retention", key,
                                          "read the account's retention mode"))
    if project_id:
        out["project"] = await _part(_project(region, key, project_id))
    if model:
        out["model"] = await _part(_model(region, key, model))
    return out


async def _account_runtime(region: str, key: str) -> dict:
    return await _request("GET", f"{_control_plane(region)}/data-retention", key,
                          "read the account's retention mode", bearer=True)


async def _project(region: str, key: str, project_id: str) -> dict:
    body = await _request("GET", f"{_mantle(region)}/organization/projects/{project_id}", key,
                          "read the project")
    retention = body.get("data_retention") or {}
    return {"id": body.get("id", project_id), "name": body.get("name"), "mode": retention.get("mode")}


async def _model(region: str, key: str, model: str) -> dict:
    body = await _request("GET", f"{_mantle(region)}/models/{quote(model, safe='')}", key, "read the model")
    retention = body.get("data_retention") or {}
    return {
        "id": body.get("id", model),
        "status": body.get("status"),
        "status_reason": body.get("status_reason"),
        "mode": retention.get("mode"),
        "source": retention.get("source"),
        "allowed_modes": retention.get("allowed_modes") or [],
    }


async def set_retention(region: str, endpoint: str, key: str, scope: str, mode: str, project_id: str) -> None:
    if mode not in SETTABLE_MODES:
        raise BedrockError(f"Unsupported mode {mode!r}")
    if scope == "project":
        if endpoint != ENDPOINT_MANTLE:
            raise BedrockError("Projects exist only on the bedrock-mantle endpoint")
        if not project_id:
            raise BedrockError("Save a project ID first")
        await _request("POST", f"{_mantle(region)}/organization/projects/{project_id}", key,
                       "update the project's retention mode", json={"data_retention": {"mode": mode}})
    elif endpoint == ENDPOINT_RUNTIME:
        await _request("PUT", f"{_control_plane(region)}/data-retention", key,
                       "update the account's retention mode", json={"mode": mode}, bearer=True)
    else:
        await _request("PUT", f"{_mantle(region)}/data_retention", key,
                       "update the account's retention mode", json={"mode": mode})


async def list_models(region: str, endpoint: str, key: str, project_id: str) -> dict:
    """Models the key can use (mantle only), with their retention-based availability."""
    if endpoint == ENDPOINT_RUNTIME:
        return {"ok": True, "models": [], "details": [],
                "note": "bedrock-runtime can't list models — type an inference profile ID, e.g. us.openai.gpt-oss-120b"}
    headers = {"Authorization": f"Bearer {key}", **project_headers(project_id, endpoint)}
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.get(f"{_mantle(region)}/models", headers=headers)
    except httpx.TimeoutException:
        return {"ok": False, "models": [], "error": f"No answer within {_TIMEOUT}s — check the region"}
    except httpx.HTTPError as exc:
        return {"ok": False, "models": [], "error": f"Connection failed ({type(exc).__name__})"}
    if resp.status_code in (401, 403):
        return {"ok": False, "models": [], "error": "Bedrock rejected the API key"}
    if resp.status_code >= 400:
        return {"ok": False, "models": [], "error": _error(resp, "list models")}
    try:
        data = [m for m in resp.json().get("data", []) if isinstance(m, dict) and m.get("id")]
    except (ValueError, AttributeError):
        data = []
    data.sort(key=lambda m: m["id"])
    data = data[:300]
    return {
        "ok": True,
        "models": [m["id"] for m in data],
        "details": [{"name": m["id"], "thinking": None,
                     "unavailable": m.get("status") == "unavailable",
                     "status_reason": m.get("status_reason")} for m in data],
    }
