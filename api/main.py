import logging
from contextlib import asynccontextmanager

from arq import create_pool
from fastapi import FastAPI
from redis.asyncio import Redis

from config import assert_secure_settings, settings
from database import engine
from redis_util import arq_redis_settings
from routers import auth as auth_router
from routers import findings as findings_router
from routers import groups as groups_router
from routers import health as health_router
from routers import repos as repos_router
from routers import settings as settings_router
from routers import signoff as signoff_router
from routers import submissions as submissions_router
from routers import webhook as webhook_router

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    assert_secure_settings()
    app.state.redis = Redis.from_url(settings.REDIS_URL, decode_responses=True)
    app.state.arq_pool = await create_pool(arq_redis_settings())
    yield
    await app.state.redis.aclose()
    await app.state.arq_pool.aclose()
    await engine.dispose()


app = FastAPI(title="Custos API", version="1.1.0", lifespan=lifespan)

for _r in (
    auth_router,
    webhook_router,
    submissions_router,
    findings_router,
    signoff_router,
    settings_router,
    health_router,
    repos_router,
    groups_router,
):
    app.include_router(_r.router)


@app.get("/healthz", tags=["system"])
async def healthz():
    return {"status": "ok"}
