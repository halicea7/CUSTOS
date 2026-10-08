import asyncio
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app_config import load_app_config
from auth import create_access_token, get_current_user, hash_password, verify_password
from config import settings
from database import get_db
from models import User
from schemas import LoginRequest, TokenResponse, UserResponse

router = APIRouter(prefix="/auth", tags=["auth"])

# Unknown usernames are checked against this so they cost the same as bad passwords.
_DUMMY_HASH = hash_password("custos-timing-equaliser")


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


@router.post("/login", response_model=TokenResponse)
async def login(body: LoginRequest, request: Request, db: AsyncSession = Depends(get_db)):
    redis = request.app.state.redis
    username = body.username.lower()
    # Two counters: per username+IP (tight, so one source can't lock a real
    # user out) and per username across all IPs (looser, so an attacker with
    # many addresses still can't brute-force a single account).
    rl_key = f"custos:login_fail:{username}:{_client_ip(request)}"
    account_key = f"custos:login_fail_account:{username}"
    failures, account_failures = await redis.mget(rl_key, account_key)
    if (
        int(failures or 0) >= settings.LOGIN_MAX_ATTEMPTS
        or int(account_failures or 0) >= settings.LOGIN_MAX_ATTEMPTS_PER_ACCOUNT
    ):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many failed login attempts. Try again later.",
            headers={"Retry-After": str(settings.LOGIN_WINDOW_SECONDS)},
        )

    result = await db.execute(select(User).where(User.username == body.username))
    user = result.scalar_one_or_none()
    # bcrypt is CPU-bound; keep it off the event loop.
    password_ok = await asyncio.to_thread(
        verify_password, body.password, user.hashed_password if user else _DUMMY_HASH
    )
    if not user or not password_ok:
        pipe = redis.pipeline()
        for key in (rl_key, account_key):
            pipe.incr(key)
            pipe.expire(key, settings.LOGIN_WINDOW_SECONDS)
        await pipe.execute()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
        )

    await redis.delete(rl_key)
    cfg = await load_app_config(db)
    token = create_access_token(
        {"sub": user.username},
        expires_delta=timedelta(minutes=cfg.access_token_expire_minutes),
    )
    return TokenResponse(access_token=token)


@router.get("/me", response_model=UserResponse)
async def me(current_user: User = Depends(get_current_user)):
    return current_user
