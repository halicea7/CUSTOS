import asyncio
import platform
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app_config import (  # noqa: F401 — CONFIG_KEYS re-exported
    CONFIG_KEYS,
    RESPONSES_API_KEY,
    RESPONSES_API_KEY_ORIGIN,
    RESPONSES_HTTP_ALLOWED_ORIGIN,
    S1_TOKEN,
    S1_TOKEN_ORIGIN,
    is_local_url,
    load_app_config,
    load_responses_api_key,
    load_s1_token,
    url_origin,
)
from auth import get_current_user, hash_password, require_admin, verify_password
from config import settings
from crypto import encrypt
from database import get_db
from models import AppConfig, Repo, User
from schemas import (
    AppConfigResponse,
    AppConfigUpdateRequest,
    ChangePasswordRequest,
    CreateUserRequest,
    TestResponsesRequest,
    TestS1Request,
    UpdateUserRoleRequest,
    UserListResponse,
)
from worker.analysis.llm import responses_endpoint

router = APIRouter(prefix="/settings", tags=["settings"])

# ── Account (all roles) ────────────────────────────────────────────────────────

@router.patch("/me/password", status_code=status.HTTP_204_NO_CONTENT)
async def change_password(
    body: ChangePasswordRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if not await asyncio.to_thread(verify_password, body.current_password, current_user.hashed_password):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Current password is incorrect")
    current_user.hashed_password = await asyncio.to_thread(hash_password, body.new_password)
    await db.commit()


# ── User management (admin only) ──────────────────────────────────────────────

@router.get("/users", response_model=list[UserListResponse])
async def list_users(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    result = await db.execute(select(User).order_by(User.created_at))
    return result.scalars().all()


@router.post("/users", response_model=UserListResponse, status_code=status.HTTP_201_CREATED)
async def create_user(
    body: CreateUserRequest,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    existing = await db.execute(select(User).where(User.username == body.username))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Username already exists")
    user = User(
        username=body.username,
        hashed_password=await asyncio.to_thread(hash_password, body.password),
        role=body.role.value,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


@router.patch("/users/{user_id}/role", response_model=UserListResponse)
async def update_user_role(
    user_id: UUID,
    body: UpdateUserRoleRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    if user_id == current_user.id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot change your own role")
    target = await db.get(User, user_id)
    if not target:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    target.role = body.role.value
    await db.commit()
    await db.refresh(target)
    return target


@router.delete("/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_user(
    user_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    if user_id == current_user.id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot delete your own account")
    target = await db.get(User, user_id)
    if not target:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    await db.delete(target)
    await db.commit()


# ── Analysis config (admin only) ──────────────────────────────────────────────

@router.get("/config/test-ollama")
async def test_ollama(
    url: str = Query(..., description="Ollama base URL to test", pattern=r"^https?://[^\s]+$"),
    _: User = Depends(require_admin),
):
    base = url.rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            resp = await client.get(f"{base}/api/tags")
            resp.raise_for_status()
            tags = resp.json().get("models", [])
            names = [m["name"] for m in tags]
            # /api/show reports each model's capabilities (incl. "thinking").
            sem = asyncio.Semaphore(4)

            async def show(name: str) -> list[str] | None:
                async with sem:
                    try:
                        r = await client.post(f"{base}/api/show", json={"model": name})
                        caps = r.json().get("capabilities") if r.status_code == 200 else None
                    except (httpx.HTTPError, ValueError):
                        return None
                return [str(c) for c in caps] if isinstance(caps, list) else None

            caps = await asyncio.gather(*(show(n) for n in names[:_MAX_MODEL_DETAILS]))
    except httpx.ConnectError:
        return {"ok": False, "error": "Connection refused — is Ollama running?", "models": []}
    except httpx.TimeoutException:
        return {"ok": False, "error": "Request timed out after 8s", "models": []}
    except Exception as exc:
        return {"ok": False, "error": type(exc).__name__, "models": []}
    details = []
    for i, m in enumerate(tags):
        c = caps[i] if i < len(caps) else None
        details.append({
            "name": m["name"],
            "parameter_size": (m.get("details") or {}).get("parameter_size"),
            # True/False when Ollama reports capabilities; None when it doesn't (older Ollama).
            "thinking": None if c is None else "thinking" in c,
        })
    return {"ok": True, "models": names, "details": details}


async def _store_bound_secret(db, key: str, origin_key: str, secret: str, url: str, username: str) -> None:
    """Save an encrypted write-only secret bound to *url*'s origin; "" removes it."""
    values = {key: encrypt(secret), origin_key: url_origin(url)} if secret else {key: None, origin_key: None}
    for k, value in values.items():
        row = await db.get(AppConfig, k)
        if value is None:
            if row:
                await db.delete(row)
        elif row:
            row.value, row.updated_by = value, username
        else:
            db.add(AppConfig(key=k, value=value, updated_by=username))


def _check_responses_target(base_url: str, has_key: bool, allowed_http_origin: str | None = None) -> None:
    if not (has_key and base_url.lower().startswith("http://") and not is_local_url(base_url)):
        return
    if allowed_http_origin and url_origin(base_url) == allowed_http_origin:
        return  # an admin explicitly accepted plain HTTP for exactly this host
    raise HTTPException(
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "Refusing to send an API key over plain HTTP to a non-local host — use https://, "
        "or explicitly allow plain HTTP for this host",
    )


@router.post("/config/test-responses")
async def test_responses(
    body: TestResponsesRequest,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    """Check a Responses API server and list its models (GET {base}/models).

    Uses the API key from the request if given. Otherwise the saved key is
    used only if *base_url* is the origin it was saved for, so this endpoint
    can't be pointed at another server to capture it.
    """
    api_key = (body.api_key or "").strip() or await load_responses_api_key(db, body.base_url)
    if not api_key:
        saved_origin = (await load_app_config(db)).responses_api_key_origin
        if saved_origin and saved_origin != url_origin(body.base_url):
            return {"ok": False, "models": [],
                    "error": f"The saved key is only sent to {saved_origin} — enter the key to test this host"}
    allowed = url_origin(body.base_url) if body.allow_http else \
        (await load_app_config(db)).responses_http_allowed_origin
    _check_responses_target(body.base_url, bool(api_key), allowed)
    models_url = responses_endpoint(body.base_url).removesuffix("/responses") + "/models"
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(models_url, headers=headers)
    except httpx.ConnectError:
        return {"ok": False, "error": "Connection failed — check the base URL", "models": []}
    except httpx.TimeoutException:
        return {"ok": False, "error": "Request timed out after 10s", "models": []}
    except Exception as exc:
        return {"ok": False, "error": type(exc).__name__, "models": []}

    if resp.status_code in (401, 403):
        if not api_key:
            return {"ok": False, "needs_key": True, "models": [],
                    "error": "This server needs an API key — enter one above"}
        return {"ok": False, "error": "API key rejected", "models": []}
    if resp.status_code == 404:
        return {"ok": True, "models": [], "note": "Server has no /models endpoint — enter the model name manually"}
    if resp.status_code >= 400:
        return {"ok": False, "error": f"HTTP {resp.status_code}", "models": []}
    try:
        data = [m for m in resp.json().get("data", []) if isinstance(m, dict) and m.get("id")]
    except (ValueError, AttributeError):
        data = []
    by_id = {m["id"]: m for m in data}
    models = sorted(by_id)[:300]
    return {"ok": True, "models": models,
            "details": [{"name": i, "thinking": model_reasoning_support(by_id[i]),
                         "context_length": _int_or_none(by_id[i].get("context_length"))} for i in models]}


_MAX_MODEL_DETAILS = 60


def _int_or_none(v) -> int | None:
    return v if isinstance(v, int) and not isinstance(v, bool) and v > 0 else None


def model_reasoning_support(model: dict) -> bool | None:
    """Whether a /v1/models entry says the model reasons ("thinks").

    The OpenAI format has no capability field; some gateways add one. Only
    explicit metadata counts — None means unknown, never a guess from the name.
    """
    params = model.get("supported_parameters")
    if isinstance(params, list):
        return any(p in ("reasoning", "include_reasoning", "reasoning_effort") for p in params)
    caps = model.get("capabilities")
    if isinstance(caps, list):
        return any(str(c).lower() in ("thinking", "reasoning") for c in caps)
    if isinstance(caps, dict):
        for key in ("thinking", "reasoning"):
            if key in caps:
                return bool(caps[key])
    return None


S1_LATEST_VERSION_API = "/web/api/v2.1/cnapp/cli/latest-version"


def s1_cli_headers() -> dict[str, str]:
    """Headers s1-cns-cli sends on every console call (s1_cns_cli.cli.utils.
    generate_headers). The console answers 400 "Missing required headers"
    without them."""
    return {
        "Content-Type": "application/json",
        "user-agent": f"s1-cns-cli-{settings.S1_CLI_VERSION}",
        "x-runtime-arch": f"{platform.system().lower()}_{platform.machine().lower()}",
    }


def _s1_error_detail(resp: httpx.Response) -> str:
    try:
        errors = resp.json().get("errors") or []
        detail = "; ".join(str(e.get("detail") or e.get("title")) for e in errors if isinstance(e, dict))
    except (ValueError, AttributeError):
        detail = ""
    return (detail or resp.text)[:200]


@router.post("/config/test-s1")
async def test_s1(
    body: TestS1Request,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    """Validate a SentinelOne service-user token and scope.

    Calls the same lightweight endpoint the CLI checks on every run. Uses the
    token from the request if given; otherwise the saved one, and only if
    *console_url* is the console it was saved for.
    """
    console = body.console_url.rstrip("/")
    token = (body.api_token or "").strip() or await load_s1_token(db, console)
    if not token:
        saved = (await load_app_config(db)).s1_token_origin
        error = (f"The saved token is only sent to {saved} — enter the token to test this console"
                 if saved else "Enter the service user API token")
        return {"ok": False, "needs_key": True, "error": error}
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                console + S1_LATEST_VERSION_API,
                params={"scopeType": body.scope_type, "scopeIds": body.scope_id},
                headers={"Authorization": f"Bearer {token}", **s1_cli_headers()},
            )
    except httpx.ConnectError:
        return {"ok": False, "error": "Connection failed — check the console URL"}
    except httpx.TimeoutException:
        return {"ok": False, "error": "Request timed out after 10s"}
    except Exception as exc:
        return {"ok": False, "error": type(exc).__name__}
    if resp.status_code == 401:
        return {"ok": False, "error": "Token rejected (expired or invalid)"}
    if resp.status_code == 403:
        return {"ok": False, "error": "Token has no access to this scope — check scope type and ID"}
    if resp.status_code == 404:
        return {"ok": False, "error": "Console URL or scope not found"}
    if resp.status_code >= 400:
        return {"ok": False, "error": f"HTTP {resp.status_code}: {_s1_error_detail(resp)}"}
    try:
        version = (resp.json().get("data") or {}).get("version")
    except (ValueError, AttributeError):
        version = None
    return {"ok": True, "cli_version": version}


@router.get("/config", response_model=AppConfigResponse)
async def get_config(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    return await load_app_config(db)


@router.patch("/config", response_model=AppConfigResponse)
async def update_config(
    body: AppConfigUpdateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    updates = body.model_dump(exclude_none=True)
    api_key = updates.pop("responses_api_key", None)
    if api_key is not None:
        api_key = api_key.strip()

    current = await load_app_config(db)
    provider = updates.get("llm_provider", current.llm_provider)
    base_url = updates.get("responses_base_url", current.responses_base_url).rstrip("/")
    saved_origin = current.responses_api_key_origin
    if api_key is None and saved_origin and url_origin(base_url) != saved_origin:
        # Otherwise changing the URL would silently redirect the saved key.
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"The saved API key is bound to {saved_origin}. Re-enter the key (or remove it) "
            "to use a different host.",
        )
    key_set = bool(api_key) if api_key is not None else bool(
        await load_responses_api_key(db, base_url)
    )
    http_origin = updates.pop("responses_http_allowed_origin", None)
    if http_origin:
        if not base_url.lower().startswith("http://") or url_origin(base_url) != http_origin:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                                "The plain-HTTP exception must be for the base URL's own http:// host")
    if http_origin is not None:
        updates[RESPONSES_HTTP_ALLOWED_ORIGIN] = http_origin  # "" revokes
    _check_responses_target(
        base_url, key_set,
        http_origin if http_origin is not None else current.responses_http_allowed_origin,
    )
    if provider == "responses" and not updates.get("responses_model", current.responses_model):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Set a model for the Responses API provider")

    if updates.get("self_update_repo"):
        exists = (await db.execute(
            select(Repo.id).where(Repo.repo_full_name == updates["self_update_repo"])
        )).scalar_one_or_none()
        if not exists:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                                "Self-update repo must be a registered repository")

    # ── SentinelOne ──
    s1_token = updates.pop("s1_api_token", None)
    if s1_token is not None:
        s1_token = s1_token.strip()
    if "s1_console_url" in updates:
        updates["s1_console_url"] = updates["s1_console_url"].rstrip("/")
    s1_console = updates.get("s1_console_url", current.s1_console_url)
    s1_origin = current.s1_token_origin
    if s1_token is None and s1_origin and s1_console and url_origin(s1_console) != s1_origin:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"The saved SentinelOne token is bound to {s1_origin}. Re-enter the token (or remove it) "
            "to use a different console.",
        )
    if updates.get("s1_enabled", current.s1_enabled):
        missing = [label for label, ok in (
            ("management console URL", s1_console),
            ("scope ID", updates.get("s1_scope_id", current.s1_scope_id)),
            ("service user API token", s1_token if s1_token is not None
                else (s1_console and await load_s1_token(db, s1_console))),
        ) if not ok]
        if missing:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "To enable SentinelOne, set the " + ", ".join(missing),
            )
    if "s1_scanners" in updates:
        updates["s1_scanners"] = ",".join(dict.fromkeys(updates["s1_scanners"]))

    if api_key is not None:
        await _store_bound_secret(db, RESPONSES_API_KEY, RESPONSES_API_KEY_ORIGIN, api_key,
                                  base_url, current_user.username)
    if s1_token is not None:
        await _store_bound_secret(db, S1_TOKEN, S1_TOKEN_ORIGIN, s1_token,
                                  s1_console, current_user.username)

    for key, value in updates.items():
        existing = await db.get(AppConfig, key)
        if existing:
            existing.value = str(value)
            existing.updated_by = current_user.username
        else:
            db.add(AppConfig(key=key, value=str(value), updated_by=current_user.username))
    await db.commit()
    return await load_app_config(db)

