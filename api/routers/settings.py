from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from auth import get_current_user, require_admin, hash_password, verify_password
from config import settings
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

_VALID_ROLES = {"admin", "analyst"}

# Keys stored in app_config; all others fall back to env.
_CONFIG_KEYS = {
    "ollama_base_url", "ollama_model", "ollama_think", "ollama_num_ctx",
    "llm_max_content_chars",
    "max_file_size_kb", "max_files_per_repo",
    "access_token_expire_minutes",
    "worker_max_jobs", "worker_job_timeout",
}


async def load_app_config(db: AsyncSession) -> AppConfigResponse:
    result = await db.execute(select(AppConfig).where(AppConfig.key.in_(_CONFIG_KEYS)))
    ov = {row.key: row.value for row in result.scalars()}
    return AppConfigResponse(
        ollama_base_url=ov.get("ollama_base_url", settings.OLLAMA_BASE_URL),
        ollama_model=ov.get("ollama_model", settings.OLLAMA_MODEL),
        ollama_think=ov.get("ollama_think", "false").lower() == "true",
        ollama_num_ctx=int(ov.get("ollama_num_ctx", 0)),
        llm_max_content_chars=int(ov.get("llm_max_content_chars", 96_000)),
        max_file_size_kb=int(ov.get("max_file_size_kb", settings.MAX_FILE_SIZE_KB)),
        max_files_per_repo=int(ov.get("max_files_per_repo", settings.MAX_FILES_PER_REPO)),
        access_token_expire_minutes=int(ov.get("access_token_expire_minutes", settings.ACCESS_TOKEN_EXPIRE_MINUTES)),
        worker_max_jobs=int(ov.get("worker_max_jobs", 4)),
        worker_job_timeout=int(ov.get("worker_job_timeout", 600)),
    )


# ── Account (all roles) ────────────────────────────────────────────────────────

@router.patch("/me/password", status_code=status.HTTP_204_NO_CONTENT)
async def change_password(
    body: ChangePasswordRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if not verify_password(body.current_password, current_user.hashed_password):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Current password is incorrect")
    if len(body.new_password) < 8:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Password must be at least 8 characters")
    current_user.hashed_password = hash_password(body.new_password)
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
    if body.role not in _VALID_ROLES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"role must be one of {sorted(_VALID_ROLES)}",
        )
    if len(body.password) < 8:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Password must be at least 8 characters")
    existing = await db.execute(select(User).where(User.username == body.username))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Username already exists")
    user = User(username=body.username, hashed_password=hash_password(body.password), role=body.role)
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
    if body.role not in _VALID_ROLES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"role must be one of {sorted(_VALID_ROLES)}",
        )
    if user_id == current_user.id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot change your own role")
    target = await db.get(User, user_id)
    if not target:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    target.role = body.role
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
    url: str = Query(..., description="Ollama base URL to test"),
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
        return {"ok": False, "error": str(exc), "models": []}
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

