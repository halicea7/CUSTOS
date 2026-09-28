import asyncio
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app_config import CONFIG_KEYS, load_app_config  # noqa: F401 — re-exported
from auth import get_current_user, hash_password, require_admin, verify_password
from database import get_db
from models import AppConfig, User
from schemas import (
    AppConfigResponse,
    AppConfigUpdateRequest,
    ChangePasswordRequest,
    CreateUserRequest,
    UpdateUserRoleRequest,
    UserListResponse,
)

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
    for key, value in updates.items():
        existing = await db.get(AppConfig, key)
        if existing:
            existing.value = str(value)
            existing.updated_by = current_user.username
        else:
            db.add(AppConfig(key=key, value=str(value), updated_by=current_user.username))
    await db.commit()
    return await load_app_config(db)

