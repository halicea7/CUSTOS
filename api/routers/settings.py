import asyncio
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app_config import (  # noqa: F401 — CONFIG_KEYS re-exported
    CONFIG_KEYS,
    RESPONSES_API_KEY,
    RESPONSES_API_KEY_ORIGIN,
    is_local_url,
    load_app_config,
    load_responses_api_key,
    url_origin,
)
from auth import get_current_user, hash_password, require_admin, verify_password
from crypto import encrypt
from database import get_db
from models import AppConfig, User
from schemas import (
    AppConfigResponse,
    AppConfigUpdateRequest,
    ChangePasswordRequest,
    CreateUserRequest,
    TestResponsesRequest,
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
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            resp = await client.get(f"{url.rstrip('/')}/api/tags")
            resp.raise_for_status()
            data = resp.json()
            models = [m["name"] for m in data.get("models", [])]
    except httpx.ConnectError:
        return {"ok": False, "error": "Connection refused — is Ollama running?", "models": []}
    except httpx.TimeoutException:
        return {"ok": False, "error": "Request timed out after 8s", "models": []}
    except Exception as exc:
        return {"ok": False, "error": type(exc).__name__, "models": []}
    return {"ok": True, "models": models}


def _check_responses_target(base_url: str, has_key: bool) -> None:
    if has_key and base_url.lower().startswith("http://") and not is_local_url(base_url):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Refusing to send an API key over plain HTTP to a non-local host — use https://",
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
    _check_responses_target(body.base_url, bool(api_key))
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
        data = resp.json().get("data", [])
        models = sorted({m["id"] for m in data if isinstance(m, dict) and m.get("id")})
    except (ValueError, AttributeError):
        models = []
    return {"ok": True, "models": models[:300]}


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
    _check_responses_target(base_url, key_set)
    if provider == "responses" and not updates.get("responses_model", current.responses_model):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Set a model for the Responses API provider")

    if api_key is not None:
        stored = {RESPONSES_API_KEY: encrypt(api_key), RESPONSES_API_KEY_ORIGIN: url_origin(base_url)}
        for key, value in stored.items():
            row = await db.get(AppConfig, key)
            if not api_key:
                if row:
                    await db.delete(row)
            elif row:
                row.value, row.updated_by = value, current_user.username
            else:
                db.add(AppConfig(key=key, value=value, updated_by=current_user.username))

    for key, value in updates.items():
        existing = await db.get(AppConfig, key)
        if existing:
            existing.value = str(value)
            existing.updated_by = current_user.username
        else:
            db.add(AppConfig(key=key, value=str(value), updated_by=current_user.username))
    await db.commit()
    return await load_app_config(db)

