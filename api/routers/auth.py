from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from auth import create_access_token, get_current_user, hash_password, verify_password
from database import get_db
from models import User
from routers.settings import load_app_config
from schemas import LoginRequest, TokenResponse, UserResponse

router = APIRouter(prefix="/auth", tags=["auth"])

_MAX_FAILED_ATTEMPTS = 10
_LOCKOUT_WINDOW_SECONDS = 15 * 60
# Verified against when the username doesn't exist, so response timing
# doesn't reveal which usernames are valid.
_DUMMY_HASH = hash_password("custos-timing-equaliser")


@router.post("/login", response_model=TokenResponse)
async def login(
    request: LoginRequest,
    http_request: Request,
    db: AsyncSession = Depends(get_db),
):
    # Per-username, not per-IP: behind the nginx proxy every client shares one IP.
    redis = http_request.app.state.redis
    fail_key = f"custos:login_fail:{request.username.lower()}"
    if int(await redis.get(fail_key) or 0) >= _MAX_FAILED_ATTEMPTS:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many failed login attempts. Try again in 15 minutes.",
        )

    result = await db.execute(select(User).where(User.username == request.username))
    user = result.scalar_one_or_none()
    password_ok = verify_password(
        request.password, user.hashed_password if user else _DUMMY_HASH
    )
    if not user or not password_ok:
        await redis.incr(fail_key)
        await redis.expire(fail_key, _LOCKOUT_WINDOW_SECONDS)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
        )
    await redis.delete(fail_key)
    cfg = await load_app_config(db)
    token = create_access_token(
        {"sub": user.username},
        expires_delta=timedelta(minutes=cfg.access_token_expire_minutes),
    )
    return TokenResponse(access_token=token)


@router.get("/me", response_model=UserResponse)
async def me(current_user: User = Depends(get_current_user)):
    return current_user
